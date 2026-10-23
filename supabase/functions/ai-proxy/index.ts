// supabase/functions/ai-proxy/index.ts
//
// ai-proxy — authenticated server-side proxy between DevNotes and the Groq API.
//
// SECURITY MODEL (AGENTS.md §11, §13, §19):
//  * GROQ_API_KEY lives ONLY as a server-side secret (`supabase secrets set`).
//    It is never logged, never echoed to the client, never hard-coded.
//  * Every request must carry a valid Supabase user JWT (`Authorization:
//    Bearer <access token>`); anonymous callers always get 401. Ownership of
//    the request is established server-side via auth.getUser(), never trusted
//    from the body.
//  * The response body is a fixed, OpenAI-compatible subset: clients cannot
//    smuggle extra upstream parameters (stream, tools, user, …) through.
//  * Responses include only content/model/usage — no key material, no raw
//    upstream error dumps.
//
// ERROR SHAPE: { "error": { "code": string, "message": string, ... } }
//   unauthorized | invalid_request | not_configured | configuration_error |
//   rate_limited | upstream_rate_limited | invalid_model | upstream_error |
//   empty_response | timeout | method_not_allowed
//
// Only dependency: npm:@supabase/supabase-js@2 (Deno/edge runtime).

import { createClient } from 'npm:@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// CORS — the proxy is called from a browser SPA (static hosting, any origin).
// The Authorization header makes credentials explicit per request; no cookies
// are used, so `*` does not weaken auth (RLS-equivalent auth happens below).
// ---------------------------------------------------------------------------
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Expose-Headers': 'Content-Type',
};

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 120_000;
const MAX_TEMPERATURE = 2;
const MAX_TOKENS_LIMIT = 4096;
const DEFAULT_ALLOWED_MODELS = 'llama-3.3-70b-versatile';
const DEFAULT_RATE_LIMIT = 30; // requests per user per fixed minute
const RATE_WINDOW_MS = 60_000;

const VALID_ROLES = new Set(['system', 'user', 'assistant']);
const VALID_RESPONSE_FORMATS = new Set(['json_object', 'text']);

type ChatRole = 'system' | 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ProxyRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
}

interface JsonError {
  error: { code: string; message: string; retryable?: boolean; retry_after_seconds?: number };
}

// ---------------------------------------------------------------------------
// Response helpers (CORS on every response, including errors).
// ---------------------------------------------------------------------------
function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders };
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: { retryable?: boolean; retryAfterSeconds?: number; headers?: Record<string, string> } = {},
): Response {
  const error: JsonError['error'] = { code, message };
  if (extra.retryable !== undefined) error.retryable = extra.retryable;
  if (extra.retryAfterSeconds !== undefined) error.retry_after_seconds = extra.retryAfterSeconds;
  return jsonResponse({ error }, status, extra.headers);
}

// Log status/error codes only — never headers, bodies, tokens, or the API key.
function logError(code: string, status?: number): void {
  const suffix = typeof status === 'number' ? ` status=${status}` : '';
  console.error(`[ai-proxy] code=${code}${suffix}`);
}

// ---------------------------------------------------------------------------
// Environment readers.
// ---------------------------------------------------------------------------
function envPositiveInt(name: string, fallback: number, max: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}

function allowedModels(): string[] {
  const raw = Deno.env.get('GROQ_ALLOWED_MODELS') ?? '';
  const models = raw.split(',').map((m) => m.trim()).filter(Boolean);
  // An empty/absent override falls back to the documented default rather than
  // to "everything" — model IDs churn, so the allowlist stays deliberate.
  return models.length > 0 ? models : [DEFAULT_ALLOWED_MODELS];
}

// ---------------------------------------------------------------------------
// Best-effort per-user rate limit: fixed-window counter in module memory.
//
// HONEST LIMITATION: edge functions are ephemeral and horizontally scaled, so
// this Map is per-instance best effort only (a burst can fan out across
// instances, and a cold start resets it). It protects the shared Groq quota
// from accidental runaway loops, not a hostile attacker. A serious deployment
// should back this with a shared store (Redis/KV/Postgres) or provider-side
// spend limits. Requests that fail validation or authentication never consume
// a slot — only requests actually forwarded upstream count.
// ---------------------------------------------------------------------------
interface RateWindow {
  windowStart: number;
  count: number;
}
const rateWindows = new Map<string, RateWindow>();

function pruneExpiredWindows(now: number): void {
  for (const [userId, win] of rateWindows) {
    if (now - win.windowStart >= RATE_WINDOW_MS) rateWindows.delete(userId);
  }
}

function takeRateSlot(userId: string, limit: number, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  if (rateWindows.size > 5_000) pruneExpiredWindows(now); // opportunistic cleanup
  const win = rateWindows.get(userId);
  if (!win || now - win.windowStart >= RATE_WINDOW_MS) {
    rateWindows.set(userId, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (win.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((win.windowStart + RATE_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  win.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

// ---------------------------------------------------------------------------
// Request validation (all failures → 400 invalid_request).
// ---------------------------------------------------------------------------
type ValidationResult =
  | { ok: true; value: ProxyRequest }
  | { ok: false; message: string };

function validateRequestBody(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  const body = raw as Record<string, unknown>;
  const { model, messages, temperature, max_tokens, response_format } = body;

  if (typeof model !== 'string' || model.trim() === '') {
    return { ok: false, message: 'model must be a non-empty string.' };
  }
  if (!Array.isArray(messages)) {
    return { ok: false, message: 'messages must be an array.' };
  }
  if (messages.length === 0) {
    return { ok: false, message: 'messages must not be empty.' };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, message: `messages must contain at most ${MAX_MESSAGES} items (received ${messages.length}).` };
  }

  const parsedMessages: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const item = messages[i] as unknown;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, message: `messages[${i}] must be an object.` };
    }
    const { role, content } = item as Record<string, unknown>;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return { ok: false, message: `messages[${i}].role must be one of: system, user, assistant.` };
    }
    if (typeof content !== 'string') {
      return { ok: false, message: `messages[${i}].content must be a string.` };
    }
    parsedMessages.push({ role: role as ChatRole, content });
  }

  // Bound the whole conversation payload before it reaches the provider.
  const serializedChars = JSON.stringify(parsedMessages).length;
  if (serializedChars > MAX_TOTAL_CHARS) {
    return { ok: false, message: `Conversation is too long (${serializedChars} characters; limit is ${MAX_TOTAL_CHARS}).` };
  }

  const value: ProxyRequest = { model: model.trim(), messages: parsedMessages };

  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > MAX_TEMPERATURE) {
      return { ok: false, message: `temperature must be a number between 0 and ${MAX_TEMPERATURE}.` };
    }
    value.temperature = temperature;
  }
  if (max_tokens !== undefined) {
    if (typeof max_tokens !== 'number' || !Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > MAX_TOKENS_LIMIT) {
      return { ok: false, message: `max_tokens must be an integer between 1 and ${MAX_TOKENS_LIMIT}.` };
    }
    value.max_tokens = max_tokens;
  }
  if (response_format !== undefined) {
    if (typeof response_format !== 'object' || response_format === null || Array.isArray(response_format)) {
      return { ok: false, message: 'response_format must be an object.' };
    }
    const rfType = (response_format as Record<string, unknown>).type;
    if (typeof rfType !== 'string' || !VALID_RESPONSE_FORMATS.has(rfType)) {
      return { ok: false, message: 'response_format.type must be "json_object" or "text".' };
    }
    value.response_format = { type: rfType as 'json_object' | 'text' };
  }

  // Unknown extra keys are intentionally dropped (never forwarded upstream).
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Forward to Groq with a hard 30s timeout and mapped error statuses.
// ---------------------------------------------------------------------------
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

async function forwardToGroq(
  request: ProxyRequest,
  groqApiKey: string,
): Promise<Response> {
  // Fixed OpenAI-compatible shape — only whitelisted fields leave this server.
  const payload: Record<string, unknown> = { model: request.model, messages: request.messages };
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.max_tokens !== undefined) payload.max_tokens = request.max_tokens;
  if (request.response_format !== undefined) payload.response_format = request.response_format;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    let upstream: Response;
    try {
      upstream = await fetch(GROQ_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqApiKey}`, // server-side secret; never logged
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        logError('timeout', 504);
        return errorResponse(504, 'timeout', `The AI request timed out after ${UPSTREAM_TIMEOUT_MS / 1000} seconds. Please retry.`);
      }
      logError('upstream_network_error', 502);
      return errorResponse(502, 'upstream_error', 'Could not reach the AI provider. Please retry.');
    }

    if (!upstream.ok) {
      // Status codes only — the upstream body is discarded (it may echo
      // request fragments; the key must never travel anywhere either).
      try {
        await upstream.body?.cancel(); // release the connection; we never read it
      } catch { /* body may already be gone */ }
      const status = upstream.status;
      if (status === 429) {
        logError('upstream_rate_limited', status);
        return errorResponse(429, 'upstream_rate_limited',
          'The AI provider is rate limiting requests right now. Please wait a moment and retry.', { retryable: true });
      }
      if (status === 400 || status === 404) {
        // Groq rejects retired/renamed models with 400/404 — translate to
        // app-friendly wording instead of leaking the raw upstream payload.
        logError('invalid_model', status);
        return errorResponse(400, 'invalid_model',
          `The AI provider rejected model "${request.model}". It may have been retired — choose another model in Settings → AI.`);
      }
      if (status === 401 || status === 403) {
        // Server-side misconfiguration (bad/expired GROQ_API_KEY): report it
        // honestly to the operator without echoing any credential material.
        logError('not_configured', status);
        return errorResponse(502, 'not_configured',
          'The AI provider rejected the server credentials. Check GROQ_API_KEY for this function.');
      }
      if (status >= 500) {
        logError('upstream_error', status);
        return errorResponse(502, 'upstream_error', 'The AI provider is unavailable right now. Please retry.');
      }
      logError('upstream_error', status);
      return errorResponse(502, 'upstream_error', 'The AI provider rejected the request.');
    }

    let data: unknown;
    try {
      data = await upstream.json();
    } catch {
      logError('upstream_unreadable', upstream.status);
      return errorResponse(502, 'upstream_error', 'The AI provider returned an unreadable response. Please retry.');
    }

    const chat = data as {
      choices?: Array<{ message?: { content?: unknown } }>;
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const choice = Array.isArray(chat?.choices) ? chat.choices[0] : undefined;
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';

    if (content === '') {
      logError('empty_response', upstream.status);
      return errorResponse(502, 'empty_response', 'The AI returned an empty response. Please retry.');
    }

    const promptTokens = chat?.usage?.prompt_tokens;
    const completionTokens = chat?.usage?.completion_tokens;
    const usage =
      typeof promptTokens === 'number' && typeof completionTokens === 'number'
        ? { prompt_tokens: promptTokens, completion_tokens: completionTokens }
        : null;

    return jsonResponse(
      {
        content,
        model: typeof chat?.model === 'string' && chat.model ? chat.model : request.model,
        usage,
      },
      200,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', `Method ${req.method} is not allowed. Use GET or POST.`, {
      headers: { Allow: 'GET, OPTIONS, POST' },
    });
  }

  // --- server configuration: fail loudly, never fake success ---------------
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    logError('configuration_error', 500);
    return errorResponse(500, 'configuration_error',
      'Server configuration is incomplete: SUPABASE_URL and SUPABASE_ANON_KEY must be set for this function.');
  }

  // --- authentication (server-side; the JWT decides identity) --------------
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  if (!token) {
    return errorResponse(401, 'unauthorized', 'Sign in required');
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  const userId = authError ? null : authData.user?.id;
  if (!userId) {
    logError('unauthorized', 401);
    return errorResponse(401, 'unauthorized', 'Sign in required');
  }

  // GET = authenticated liveness probe (does not consume rate-limit budget).
  if (req.method === 'GET') {
    return jsonResponse({ ok: true }, 200);
  }

  // --- validate the POST body ------------------------------------------------
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Request body must be valid JSON.');
  }
  const validation = validateRequestBody(rawBody);
  if (!validation.ok) {
    return errorResponse(400, 'invalid_request', validation.message);
  }
  const request = validation.value;

  // --- model allowlist -------------------------------------------------------
  const models = allowedModels();
  if (!models.includes(request.model)) {
    const shown = request.model.length > 120 ? `${request.model.slice(0, 120)}…` : request.model;
    return errorResponse(400, 'invalid_request',
      `Model "${shown}" is not allowed. Allowed models: ${models.join(', ')}.`);
  }

  // --- provider secret (server-side only) ------------------------------------
  const groqApiKey = Deno.env.get('GROQ_API_KEY');
  if (!groqApiKey) {
    logError('not_configured', 500);
    return errorResponse(500, 'not_configured', 'AI is not configured on this server');
  }

  // --- per-user rate limit (consumed only by requests that reach Groq) -------
  const limit = envPositiveInt('AI_RATE_LIMIT', DEFAULT_RATE_LIMIT, 1000);
  const slot = takeRateSlot(userId, limit);
  if (!slot.allowed) {
    logError('rate_limited', 429);
    return errorResponse(429, 'rate_limited',
      `Rate limit of ${limit} requests per minute exceeded. Please retry in ${slot.retryAfterSeconds}s.`,
      { retryable: true, retryAfterSeconds: slot.retryAfterSeconds });
  }

  return forwardToGroq(request, groqApiKey);
});
