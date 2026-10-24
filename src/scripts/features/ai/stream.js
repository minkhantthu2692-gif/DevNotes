/**
 * stream.js — Server-Sent Events helpers for streaming AI responses.
 *
 * Pure, DOM-free and transport-free so the parsing contract is unit-testable
 * without a browser or network. Two producers feed the same parser:
 *   - Groq directly (BYOK): OpenAI-style chunks {choices:[{delta:{content}}]}
 *   - the ai-proxy function: normalized chunks {delta} / {usage, model} / {error}
 * Both end with the standard "data: [DONE]" sentinel.
 */

/**
 * Incremental SSE reader. Feed decoded text chunks; the callback receives
 * every `data:` payload (events may be split across chunks).
 */
export function createSseParser(onData) {
  let buffer = '';

  const drain = (frame) => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5);
      const value = payload.startsWith(' ') ? payload.slice(1) : payload;
      if (value) onData(value);
    }
  };

  return {
    push(chunk) {
      // Concatenate before normalizing so a \r|\n split across chunks still
      // becomes one \r\n and is collapsed here.
      buffer = (buffer + String(chunk ?? '')).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        drain(frame);
      }
    },
    /** Emit a trailing frame from a stream that closed without a blank line. */
    flush() {
      if (!buffer.trim()) return;
      const rest = buffer;
      buffer = '';
      drain(rest.replace(/\n+$/, ''));
    },
  };
}

/**
 * Translate one SSE data payload into a typed event.
 * @returns {null | {done: true}
 *   | {delta: string, usage?: object, model?: string}
 *   | {usage: object, model?: string}
 *   | {error: {code: string, message: string, retryable: boolean}}}
 */
export function parseStreamData(payload) {
  const data = String(payload ?? '').trim();
  if (!data) return null;
  if (data === '[DONE]') return { done: true };

  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return null; // tolerate a malformed frame instead of killing the reply
  }
  if (!json || typeof json !== 'object') return null;

  if (json.error) {
    const error = typeof json.error === 'string' ? { message: json.error } : json.error;
    return {
      error: {
        code: typeof error.code === 'string' ? error.code : 'upstream_error',
        message: typeof error.message === 'string' && error.message ? error.message : 'The AI request failed.',
        retryable: Boolean(error.retryable),
      },
    };
  }

  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const deltaObject = choice && typeof choice === 'object' ? choice.delta : null;
  const delta = typeof json.delta === 'string'
    ? json.delta
    : (deltaObject && typeof deltaObject.content === 'string' ? deltaObject.content : null);

  const usage = (json.usage && typeof json.usage === 'object')
    ? json.usage
    : (json.x_groq && typeof json.x_groq.usage === 'object' ? json.x_groq.usage : null);
  const model = typeof json.model === 'string' && json.model ? json.model : null;

  if (delta === null && !usage && !model) return null;
  const event = {};
  if (delta !== null) event.delta = delta;
  if (usage) event.usage = usage;
  if (model) event.model = model;
  return event;
}

/**
 * Normalize provider usage (raw or already-normalized) to stable totals for
 * storage and display. Returns null when the API sent no usable numbers.
 * @returns {null | {prompt: number|null, completion: number|null}}
 */
export function usageTotals(usage) {
  if (!usage || typeof usage !== 'object') return null;
  // Number(null) is 0 — treat explicit null/undefined/'' as "not sent" so we
  // never fabricate a zero-token figure.
  const toNumber = (value) => (
    value === null || value === undefined || value === '' ? Number.NaN : Number(value)
  );
  const prompt = toNumber(usage.prompt_tokens ?? usage.prompt);
  const completion = toNumber(usage.completion_tokens ?? usage.completion);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    prompt: Number.isFinite(prompt) ? prompt : null,
    completion: Number.isFinite(completion) ? completion : null,
  };
}
