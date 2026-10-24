/**
 * ai-service.js — optional Groq integration (AGENTS.md §13).
 *
 * Two modes, decided at call time:
 *   BYOK   — the user's own Groq key, stored locally (settings → AI).
 *            Clearly documented: a browser-stored key is NOT fully protected
 *            from anyone who controls this browser profile.
 *   PROXY  — a Supabase Edge Function (supabase/functions/ai-proxy) that holds
 *            the real key server-side and authenticates the Supabase user.
 *
 * AI is never required: every caller must handle an AppError with a friendly
 * message, and no AI output may be persisted without explicit user approval.
 */

import { AI, STORAGE_KEYS, SUPABASE } from '../../config.js';
import { getPrefs } from '../settings/prefs.js';
import { getSupabaseClient, isSupabaseConfigured } from '../../services/supabase-client.js';
import { AppError } from '../../utils/errors.js';
import { createSseParser, parseStreamData } from './stream.js';

export { usageTotals } from './stream.js';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_ITEMS = 40;

/* ------------------------------------------------------------------ key -- */

/** The BYOK key lives in localStorage: it is the user's own key on their own device. */
export function getAiKey() {
  try {
    return localStorage.getItem(STORAGE_KEYS.aiKey) || '';
  } catch {
    return '';
  }
}

export function setAiKey(key) {
  const clean = String(key ?? '').trim();
  try {
    if (clean) localStorage.setItem(STORAGE_KEYS.aiKey, clean);
    else localStorage.removeItem(STORAGE_KEYS.aiKey);
  } catch (err) {
    throw new AppError('The browser blocked local storage, so the key cannot be kept.', { code: 'storage' });
  }
}

export function clearAiKey() {
  setAiKey('');
}

/**
 * @returns {'off'|'byok'|'proxy'}
 */
export function getAiMode() {
  const prefs = getPrefs();
  if (!prefs.aiEnabled) return 'off';
  if (AI.edgeFunctionUrl && isSupabaseConfigured()) return 'proxy';
  if (getAiKey()) return 'byok';
  return 'off';
}

export function isAiConfigured() {
  return getAiMode() !== 'off';
}

/** Human-readable setup requirements for empty states. */
export function describeAiSetup() {
  const mode = getAiMode();
  if (mode === 'proxy') return 'AI requests go through your Supabase project’s ai-proxy function.';
  if (mode === 'byok') return 'AI requests use your own Groq API key from this device.';
  if (!getPrefs().aiEnabled) return 'AI is turned off in Settings → AI.';
  if (!getAiKey() && !AI.edgeFunctionUrl) {
    return 'Add a Groq API key in Settings → AI, or configure the ai-proxy edge function.';
  }
  return 'AI is not configured.';
}

/* --------------------------------------------------------------- errors -- */

function friendlyHttpError(status, payloadMessage) {
  if (status === 401 || status === 403) {
    return new AppError(
      'The Groq API key was rejected. Check it in Settings → AI.',
      { code: 'auth', retryable: false },
    );
  }
  if (status === 404) {
    return new AppError(
      `That model is not available${payloadMessage ? ` (${payloadMessage})` : ''}. Pick another model in Settings → AI.`,
      { code: 'model', retryable: false },
    );
  }
  if (status === 429) {
    return new AppError(
      'Groq rate-limited the request. Wait a moment and try again.',
      { code: 'rate-limit', retryable: true },
    );
  }
  if (status >= 500) {
    return new AppError('The AI service had a server problem. Try again shortly.', { code: 'server', retryable: true });
  }
  return new AppError(payloadMessage || `The AI request failed (HTTP ${status}).`, { code: 'request', retryable: false });
}

/* ------------------------------------------------------------- requests -- */

function buildBody({ model, messages, temperature, maxTokens, expectJson }) {
  const prefs = getPrefs();
  const body = {
    model: model || prefs.aiModel || AI.defaultModel,
    messages,
    temperature: Number.isFinite(temperature) ? temperature : Number(prefs.aiTemperature ?? 0.4),
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : Number(prefs.aiMaxTokens ?? 2048),
  };
  if (expectJson) body.response_format = { type: 'json_object' };
  return body;
}

/** Combine an optional caller signal with a hard timeout. */
function withTimeout(timeoutMs, externalSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let externalAborted = Boolean(externalSignal?.aborted);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('timeout', 'TimeoutError'));
  }, timeoutMs);
  const relay = () => {
    externalAborted = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) relay();
    else externalSignal.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    get externalAborted() { return externalAborted; },
    done() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', relay);
    },
  };
}

/**
 * Streaming guard: an *idle* timeout (reset on every chunk) plus a hard total
 * cap, and transparent relay of the caller's abort (the Stop button).
 */
function withStreamGuard(externalSignal, { idleMs, totalMs }) {
  const controller = new AbortController();
  let timedOut = false;
  let externalAborted = Boolean(externalSignal?.aborted);

  const abortForTimeout = () => {
    timedOut = true;
    controller.abort(new DOMException('timeout', 'TimeoutError'));
  };
  let idleTimer = setTimeout(abortForTimeout, idleMs);
  const totalTimer = setTimeout(abortForTimeout, totalMs);
  const relay = () => {
    externalAborted = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) relay();
    else externalSignal.addEventListener('abort', relay, { once: true });
  }

  return {
    signal: controller.signal,
    resetIdle() {
      if (timedOut || externalAborted) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(abortForTimeout, idleMs);
    },
    get timedOut() { return timedOut; },
    get externalAborted() { return externalAborted; },
    done() {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      externalSignal?.removeEventListener('abort', relay);
    },
  };
}

async function parseErrorPayload(response) {
  try {
    const data = await response.json();
    return data?.error?.message || data?.message || data?.error || '';
  } catch {
    return '';
  }
}

async function callGroqDirect(body, { signal, timeoutMs }) {
  const key = getAiKey();
  if (!key) {
    throw new AppError('No Groq API key set — add one in Settings → AI.', { code: 'auth', retryable: false });
  }

  const guard = withTimeout(timeoutMs, signal);
  try {
    const { response } = await postChat(body, {
      guard,
      url: `${AI.endpoint}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      timeoutMessage: 'The AI request timed out. Try a shorter prompt or another model.',
      networkMessage: 'Could not reach Groq — check your connection.',
    });
    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AppError('The model returned an empty response. Try again.', { code: 'empty', retryable: true });
    }
    return { content, model: data?.model || body.model, usage: data?.usage ?? null };
  } finally {
    guard.done();
  }
}

async function callProxy(body, { signal, timeoutMs }) {
  const client = await getSupabaseClient();
  if (!client) {
    throw new AppError('The AI proxy needs a Supabase configuration.', { code: 'not-configured', retryable: false });
  }
  const { data: { session } = {} } = await client.auth.getSession();
  if (!session) {
    throw new AppError('Sign in to use the shared AI proxy.', { code: 'auth', retryable: false });
  }

  const guard = withTimeout(timeoutMs, signal);
  try {
    const { response } = await postChat(body, {
      guard,
      url: AI.edgeFunctionUrl,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        // Supabase expects the publishable key alongside the user JWT.
        apikey: SUPABASE.anonKey,
      },
      timeoutMessage: 'The AI request timed out.',
      networkMessage: 'Could not reach the AI proxy — check your connection.',
      mapStatus(status) {
        if (status === 401) {
          return new AppError('The proxy rejected the request — sign in again.', { code: 'auth', retryable: false });
        }
        if (status === 429) {
          return new AppError('The AI proxy rate-limited the request. Try again in a minute.', { code: 'rate-limit', retryable: true });
        }
        return null;
      },
    });
    const data = await response.json().catch(() => null);
    const content = data?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AppError('The AI proxy returned an empty response.', { code: 'empty', retryable: true });
    }
    return { content, model: data?.model || body.model, usage: data?.usage ?? null };
  } finally {
    guard.done();
  }
}

/**
 * Shared fetch for chat requests: builds the mode-specific request, maps
 * transport/timeout/status failures to AppError, and returns the raw
 * Response so one-shot and streaming callers use the exact same path.
 * The caller owns the guard lifecycle (guard.done()).
 */
async function postChat(body, { guard, url, headers, timeoutMessage, networkMessage, mapStatus = null }) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: guard.signal,
    });
  } catch (err) {
    if (guard.signal.aborted) {
      if (guard.timedOut) {
        throw new AppError(timeoutMessage, { code: 'timeout', retryable: true, cause: err });
      }
      // Caller-initiated abort (Stop) — the UI checks its own flag first.
      throw new AppError('The AI request was cancelled.', { code: 'cancelled', retryable: false, cause: err });
    }
    throw new AppError(networkMessage, { code: 'network', retryable: true, cause: err });
  }

  if (!response.ok) {
    const payloadMessage = await parseErrorPayload(response);
    const mapped = mapStatus?.(response.status, payloadMessage);
    if (mapped) throw mapped;
    throw friendlyHttpError(response.status, payloadMessage);
  }
  return { response };
}

/** Validate the request shape once for every chat entry point. */
function assertChatInput(messages) {
  const mode = getAiMode();
  if (mode === 'off') {
    throw new AppError(describeAiSetup(), { code: 'not-configured', retryable: false });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AppError('No messages to send.', { code: 'invalid', retryable: false });
  }
  if (messages.length > MAX_MESSAGE_ITEMS) {
    throw new AppError('Too many message items for one request.', { code: 'invalid', retryable: false });
  }
  for (const message of messages) {
    if (!['system', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string') {
      throw new AppError('Malformed message in request.', { code: 'invalid', retryable: false });
    }
  }
  return mode;
}

/* ----------------------------------------------------------- streaming -- */

/** Map an in-stream {error:{code,message}} frame (both BYOK and proxy). */
function appErrorFromStreamEvent(error) {
  const raw = String(error.code || '');
  const message = String(error.message || 'The AI request failed.');
  const retryable = error.retryable
    ?? ['timeout', 'upstream_error', 'rate_limited', 'upstream_rate_limited', 'empty_response'].includes(raw);
  const code = raw === 'rate_limited' || raw === 'upstream_rate_limited' ? 'rate-limit'
    : raw === 'timeout' ? 'timeout'
      : raw === 'invalid_model' ? 'model'
        : raw === 'unauthorized' ? 'auth'
          : 'server';
  return new AppError(message, { code, retryable });
}

function streamReadError(err, guard) {
  if (guard.timedOut || err?.name === 'TimeoutError') {
    return new AppError('The AI stopped sending data. Please retry.', { code: 'timeout', retryable: true, cause: err });
  }
  if (err?.name === 'AbortError') {
    return new AppError('The request was cancelled.', { code: 'cancelled', retryable: false, cause: err });
  }
  return new AppError('The connection to the AI was interrupted. Please retry.', { code: 'network', retryable: true, cause: err });
}

/** Keep text that already reached the screen available for the error UI. */
function withPartial(error, content) {
  if (content) error.partial = content;
  return error;
}

/**
 * Read an SSE response body, forwarding cumulative text to onDelta.
 * @returns {Promise<{content: string, model: string, usage: object|null, stopped: boolean}>}
 */
async function readChatStream(response, { guard, mode, onDelta, fallbackModel }) {
  const contentType = String(response.headers.get('content-type') || '');
  if (contentType.includes('application/json')) {
    // A producer that answered with plain JSON (older proxy build or a
    // gateway that ignored `stream`) — degrade to a one-shot reply.
    const data = await response.json().catch(() => null);
    const content = mode === 'proxy' ? data?.content : data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      onDelta?.(content);
      return { content, model: data?.model || fallbackModel, usage: data?.usage ?? null, stopped: false };
    }
    throw new AppError('The model returned an empty response. Try again.', { code: 'empty', retryable: true });
  }
  if (!response.body) {
    throw new AppError('Streaming is not supported in this browser — reload the page or update the browser.', {
      code: 'unsupported', retryable: false,
    });
  }

  let content = '';
  let usage = null;
  let streamModel = fallbackModel;

  const parser = createSseParser((payload) => {
    const event = parseStreamData(payload);
    if (!event) return;
    if (event.error) throw appErrorFromStreamEvent(event.error);
    if (event.done) return;
    if (event.delta) {
      content += event.delta;
      onDelta?.(content);
    }
    if (event.usage) usage = event.usage;
    if (event.model) streamModel = event.model;
  });

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      guard.resetIdle();
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.flush();
  } catch (err) {
    if (guard.externalAborted) {
      return { content, model: streamModel, usage, stopped: true };
    }
    if (err instanceof AppError) throw withPartial(err, content);
    throw withPartial(streamReadError(err, guard), content);
  }

  if (guard.externalAborted) {
    return { content, model: streamModel, usage, stopped: true };
  }
  if (guard.timedOut) {
    throw withPartial(
      new AppError('The AI stopped sending data. Please retry.', { code: 'timeout', retryable: true }),
      content,
    );
  }
  if (!content.trim()) {
    throw new AppError(
      mode === 'proxy' ? 'The AI proxy returned an empty response.' : 'The model returned an empty response. Try again.',
      { code: 'empty', retryable: true },
    );
  }
  return { content, model: streamModel, usage, stopped: false };
}

/* --------------------------------------------------------------- public -- */

/**
 * One chat completion against the configured provider.
 * @param {object} options
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} options.messages
 * @param {string} [options.model]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {boolean} [options.expectJson]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{content: string, model: string, usage: object|null}>}
 */
export async function chat({ messages, model, temperature, maxTokens, expectJson = false, signal } = {}) {
  const prefs = getPrefs();
  const mode = assertChatInput(messages);

  const body = buildBody({ model, messages, temperature, maxTokens, expectJson });
  const timeoutMs = Math.min(prefs.aiTimeoutMs || AI.defaultTimeoutMs, REQUEST_TIMEOUT_MS);

  return mode === 'proxy'
    ? callProxy(body, { signal, timeoutMs })
    : callGroqDirect(body, { signal, timeoutMs });
}

/**
 * Streamed chat completion (Chat interface): tokens reach onDelta as they
 * arrive instead of one blob at the end.
 *
 * @param {object} options same shape as chat() minus expectJson
 * @param {Function} [options.onDelta] (cumulativeText) => void
 * @returns {Promise<{content: string, model: string, usage: object|null, stopped: boolean}>}
 *   `stopped: true` means the caller aborted (Stop) — `content` then holds
 *   whatever had arrived. On interruption an AppError is thrown whose
 *   `.partial` carries the text received so far, so the UI can render it
 *   next to a Retry instead of losing it.
 */
export async function streamChat({ messages, model, temperature, maxTokens, signal, onDelta } = {}) {
  const prefs = getPrefs();
  const mode = assertChatInput(messages);

  const body = buildBody({ model, messages, temperature, maxTokens });
  body.stream = true;
  // Streaming gets a longer total budget than a one-shot request; the
  // configured timeout applies as the idle gap between chunks instead.
  const idleMs = Math.min(Math.max(prefs.aiTimeoutMs || AI.defaultTimeoutMs, 15_000), 60_000);
  const guard = withStreamGuard(signal, { idleMs, totalMs: REQUEST_TIMEOUT_MS });

  try {
    if (mode === 'proxy') {
      const client = await getSupabaseClient();
      if (!client) {
        throw new AppError('The AI proxy needs a Supabase configuration.', { code: 'not-configured', retryable: false });
      }
      const { data: { session } = {} } = await client.auth.getSession();
      if (!session) {
        throw new AppError('Sign in to use the shared AI proxy.', { code: 'auth', retryable: false });
      }
      const { response } = await postChat(body, {
        guard,
        url: AI.edgeFunctionUrl,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE.anonKey,
        },
        timeoutMessage: 'The AI request timed out.',
        networkMessage: 'Could not reach the AI proxy — check your connection.',
        mapStatus(status) {
          if (status === 401) {
            return new AppError('The proxy rejected the request — sign in again.', { code: 'auth', retryable: false });
          }
          if (status === 429) {
            return new AppError('The AI proxy rate-limited the request. Try again in a minute.', { code: 'rate-limit', retryable: true });
          }
          return null;
        },
      });
      return await readChatStream(response, { guard, mode, onDelta, fallbackModel: body.model });
    }

    const key = getAiKey();
    if (!key) {
      throw new AppError('No Groq API key set — add one in Settings → AI.', { code: 'auth', retryable: false });
    }
    const { response } = await postChat(body, {
      guard,
      url: `${AI.endpoint}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      timeoutMessage: 'The AI request timed out. Try a shorter prompt or another model.',
      networkMessage: 'Could not reach Groq — check your connection.',
    });
    return await readChatStream(response, { guard, mode, onDelta, fallbackModel: body.model });
  } finally {
    guard.done();
  }
}

/** BYOK only: list the model ids the key can use (Settings → AI). */
export async function fetchAvailableModels({ signal } = {}) {
  const key = getAiKey();
  if (!key) throw new AppError('Add a Groq API key first.', { code: 'auth', retryable: false });

  const guard = withTimeout(20_000, signal);
  try {
    const response = await fetch(AI.modelsEndpoint, {
      headers: { Authorization: `Bearer ${key}` },
      signal: guard.signal,
    });
    if (!response.ok) throw friendlyHttpError(response.status, await parseErrorPayload(response));
    const data = await response.json();
    return (data?.data || [])
      .map((entry) => entry.id)
      .filter((id) => typeof id === 'string')
      .sort();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (guard.signal.aborted) {
      throw new AppError('Listing models timed out.', { code: 'timeout', retryable: true });
    }
    throw new AppError('Could not reach Groq to list models.', { code: 'network', retryable: true, cause: err });
  } finally {
    guard.done();
  }
}

/* ----------------------------------------------------------- tasks ------ */

/** Bounded lesson excerpt for AI context — never the whole library. */
export function contextFromLesson(lesson, maxChars = AI.maxContextChars) {
  if (!lesson) return '';
  const parts = [
    `# ${lesson.title || 'Untitled lesson'}`,
    lesson.summary ? `\nSummary: ${lesson.summary}` : '',
    lesson.content ? `\n${lesson.content}` : '',
  ];
  const text = parts.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

function parseJsonLoose(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to the outermost JSON array/object the model may have buried.
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      try { return JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1)); } catch { /* fall through */ }
    }
    const objectStart = cleaned.indexOf('{');
    const objectEnd = cleaned.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try { return JSON.parse(cleaned.slice(objectStart, objectEnd + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * Draft flashcards from a lesson (AI, unapproved).
 * Creates records with source:'ai' + approved:false so they never enter the
 * review queue until the user approves them (§11). Returns the created drafts.
 * @returns {Promise<Array<object>>} created draft cards
 */
export async function generateCardDrafts(lesson, { count = 6, signal } = {}) {
  const prefs = getPrefs();
  if (!prefs.aiEnabled) throw new AppError('AI is turned off in Settings → AI.', { code: 'not-configured', retryable: false });
  if (!lesson) throw new AppError('No lesson to draft cards from.', { code: 'invalid', retryable: false });

  const outputLanguage = prefs.aiOutputLanguage === 'my' ? 'Burmese (Myanmar language)' : 'English';

  const { content } = await chat({
    expectJson: true,
    signal,
    temperature: 0.3,
    maxTokens: 2048,
    messages: [
      {
        role: 'system',
        content: 'You create concise study flashcards as strict JSON. Output only JSON: '
          + '{"cards":[{"front":"…","back":"…"}]}. No commentary, no code fences.',
      },
      {
        role: 'user',
        content: `Create ${count} flashcards from the lesson below. Use ${outputLanguage}. `
          + 'Front = a focused question or term; back = a short, factual answer. '
          + 'Cover the most testable ideas only.\n\n' + contextFromLesson(lesson),
      },
    ],
  });

  const parsed = parseJsonLoose(content);
  const cards = Array.isArray(parsed) ? parsed : parsed?.cards;
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new AppError('The model did not return usable cards. Try again.', { code: 'empty', retryable: true });
  }

  const { flashcardsRepo } = await import('../../db/repositories/index.js');
  const created = [];
  for (const card of cards.slice(0, 12)) {
    const front = typeof card?.front === 'string' ? card.front.trim() : '';
    const back = typeof card?.back === 'string' ? card.back.trim() : '';
    if (!front || !back) continue;
    try {
      const record = await flashcardsRepo.create({
        front,
        back,
        lessonId: lesson.id,
        tags: (lesson.tags || []).slice(0, 3),
        source: 'ai',
        approved: false,
      });
      created.push(record);
    } catch (err) {
      // Invalid cards are skipped; valid ones still land as drafts.
      console.warn('[ai] draft card rejected:', err?.message);
    }
  }

  if (!created.length) {
    throw new AppError('No valid cards could be saved from the response.', { code: 'empty', retryable: true });
  }
  return created;
}
