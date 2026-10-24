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
//    smuggle extra upstream parameters (tools, user, …) through. The only
//    transport switch is `stream`, validated as a boolean.
//  * Responses include only content/model/usage — no key material, no raw
//    upstream error dumps. With `stream: true` the reply is text/event-stream
//    carrying normalized frames built from upstream data:
//      data: {"delta":"…"} | {"usage":{…},"model":"…"} | {"error":{code,message}} | [DONE]
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
const UPSTREAM_TIMEOUT_MS = 30_000; // headers for a one-shot request
const STREAM_IDLE_MS = 30_000;      // no upstream bytes for this long → fail the stream
const STREAM_TOTAL_MS = 120_000;    // hard cap on one streamed reply
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
  stream?: boolean;
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

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  // Ask intermediary buffers not to swallow the stream.
  'X-Accel-Buffering': 'no',
  ...CORS_HEADERS,
};

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(body: ReadableStream<Uint8Array> | string, status = 200): Response {
  return new Response(body, { status, headers: SSE_HEADERS });
}

function sseError(error: { code: string; message: string }): Response {
  return sseResponse(sseFrame({ error }) + 'data: [DONE]\n\n');
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
  const { model, messages, temperature, max_tokens, response_format, stream } = body;

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

  if (stream !== undefined && typeof stream !== 'boolean') {
    return { ok: false, message: 'stream must be a boolean.' };
  }
  if (stream) value.stream = true;

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
  if (request.stream) payload.stream = true;

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

    // --- streaming -------------------------------------------------------
    if (request.stream) {
      const upstreamType = String(upstream.headers.get('content-type') || '').toLowerCase();
      if (upstream.body && upstreamType.includes('text/event-stream')) {
        // The fixed 30s header timer is cleared by this function's `finally`
        // as soon as we return, so it can never abort a running stream; the
        // relay enforces its own idle/total budgets instead.
        return sseResponse(relayUpstreamStream(upstream.body, request.model));
      }
      // Upstream answered with plain JSON (ignored `stream`) — flatten it
      // into the same normalized SSE contract so the client sees one shape.
      return await sseFromJson(upstream, request.model);
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
// Streaming relay: parse Groq's SSE and re-emit only the normalized subset
// {delta} | {usage, model} | {error} | [DONE]. Raw upstream fields never leave
// this server — same fixed contract as the one-shot response.
// ---------------------------------------------------------------------------
interface UsageFrame {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function pickUsage(chat: { usage?: unknown; x_groq?: { usage?: unknown } } | null): UsageFrame | null {
  const raw = (chat?.usage ?? chat?.x_groq?.usage) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const usage: UsageFrame = {};
  if (typeof raw.prompt_tokens === 'number') usage.prompt_tokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') usage.completion_tokens = raw.completion_tokens;
  return usage.prompt_tokens === undefined && usage.completion_tokens === undefined ? null : usage;
}

/**
 * Transform an upstream SSE body into the client-facing stream.
 * Idle budget: no bytes for STREAM_IDLE_MS fails the stream; STREAM_TOTAL_MS
 * caps one reply end-to-end. An upstream failure mid-stream becomes an
 * in-band {error} frame (the HTTP status was already sent as 200).
 */
function relayUpstreamStream(
  body: ReadableStream<Uint8Array>,
  requestModel: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = body.getReader();

  let buffer = '';
  let sawContent = false;
  let usageSent = false;
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const raw = (text: string) => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finished = true; // client went away
        }
      };
      const send = (payload: unknown) => raw(sseFrame(payload));

      const finish = (error: { code: string; message: string } | null) => {
        if (finished) return;
        if (error) {
          logError(error.code);
          send({ error });
        } else if (!sawContent) {
          // Mirror the one-shot empty_response contract in-band.
          logError('empty_response');
          send({
            error: { code: 'empty_response', message: 'The AI returned an empty response. Please retry.' },
          });
        }
        if (finished) return;
        finished = true;
        clearTimers();
        raw('data: [DONE]\n\n');
        try { controller.close(); } catch { /* already closed */ }
        void reader.cancel().catch(() => { /* upstream may be done already */ });
      };

      const armIdle = () => {
        if (finished) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => finish({ code: 'timeout', message: 'The AI stopped sending data. Please retry.' }),
          STREAM_IDLE_MS,
        );
      };

      totalTimer = setTimeout(
        () => finish({ code: 'timeout', message: 'The AI request timed out. Please retry.' }),
        STREAM_TOTAL_MS,
      );
      armIdle();

      const processFrame = (frame: string) => {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === '[DONE]') { finish(null); return; }

          let event: Record<string, unknown> | null = null;
          try { event = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
          if (!event) continue;

          const choices = Array.isArray(event.choices)
            ? (event.choices as Array<Record<string, unknown>>)
            : [];
          const deltaObject = choices[0]?.delta as Record<string, unknown> | undefined;
          const piece = typeof deltaObject?.content === 'string' ? deltaObject.content : '';
          if (piece) {
            sawContent = true;
            send({ delta: piece });
          }

          const usage = pickUsage(event as { usage?: unknown; x_groq?: { usage?: unknown } });
          if (usage && !usageSent) {
            usageSent = true;
            const model = typeof event.model === 'string' && event.model ? event.model : requestModel;
            send({ usage, model });
          }
        }
      };

      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            // Concatenate before normalizing so a \r|\n split across chunks
            // still collapses to one line ending.
            buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
            let index: number;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              processFrame(frame);
              if (finished) return;
            }
          }
          // A truncated final frame still gets a chance to deliver its content.
          if (!finished && buffer.trim()) processFrame(buffer);
          finish(null); // upstream ended (with or without [DONE])
        } catch {
          finish({ code: 'upstream_error', message: 'The AI stream was interrupted. Please retry.' });
        }
      })();
    },
    cancel() {
      finished = true;
      clearTimers();
      void reader.cancel().catch(() => { /* already gone */ });
    },
  });
}

/** Fallback when upstream replies with JSON instead of SSE (see above). */
async function sseFromJson(upstream: Response, requestModel: string): Promise<Response> {
  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    return sseError({ code: 'upstream_error', message: 'The AI provider returned an unreadable response. Please retry.' });
  }
  const chat = data as {
    choices?: Array<{ message?: { content?: unknown } }>;
    model?: unknown;
    usage?: unknown;
    x_groq?: { usage?: unknown };
  };
  const content = typeof chat?.choices?.[0]?.message?.content === 'string' ? chat.choices[0].message.content : '';
  if (!content) {
    return sseError({ code: 'empty_response', message: 'The AI returned an empty response. Please retry.' });
  }
  let frames = sseFrame({ delta: content });
  const usage = pickUsage(chat);
  if (usage) {
    const model = typeof chat.model === 'string' && chat.model ? chat.model : requestModel;
    frames += sseFrame({ usage, model });
  }
  frames += 'data: [DONE]\n\n';
  return sseResponse(frames);
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
