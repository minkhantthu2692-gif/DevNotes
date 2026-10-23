/**
 * errors.js — one place for error classification.
 * The sync engine relies on `isRetryable` to decide between backoff and
 * surfacing a permanent failure; the UI relies on `userMessage` for wording.
 */

export class AppError extends Error {
  constructor(message, { code = 'unknown', retryable = null, cause = null, detail = '' } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

const RETRYABLE_CODES = new Set([
  'network', 'timeout', 'offline', 'rate-limit', 'server', 'conflict-temporary',
]);

/**
 * Classify any thrown value.
 * @returns {{retryable: boolean, code: string, message: string, detail: string}}
 */
export function classifyError(error) {
  if (!error) return { retryable: false, code: 'unknown', message: 'Unknown error', detail: '' };

  const message = error.message || String(error);
  const detail = (error.stack || '').split('\n').slice(0, 3).join('\n');

  if (error instanceof AppError) {
    const retryable = error.retryable ?? RETRYABLE_CODES.has(error.code);
    return { retryable, code: error.code, message: error.message, detail: error.detail || detail };
  }

  if (error.name === 'AbortError' || error.code === 20) {
    return { retryable: false, code: 'cancelled', message: 'Request was cancelled', detail: '' };
  }
  if (error.name === 'TimeoutError') {
    return { retryable: true, code: 'timeout', message: 'The request timed out', detail };
  }
  if (error instanceof TypeError) {
    // fetch() surfaces network failures as TypeError.
    return { retryable: true, code: 'network', message: 'Network request failed', detail };
  }
  if (error.name === 'QuotaExceededError' || error.code === 22) {
    return { retryable: false, code: 'storage-quota', message: 'Browser storage quota exceeded', detail };
  }
  if (error.name === 'DataError' || error.name === 'ConstraintError' || error.name === 'AbortError') {
    return { retryable: false, code: 'database', message: `Local database error: ${message}`, detail };
  }
  if (error.status >= 500) {
    return { retryable: true, code: 'server', message: `Server error (${error.status})`, detail };
  }
  if (error.status === 429) {
    return { retryable: true, code: 'rate-limit', message: 'Rate limit reached — retrying later', detail };
  }
  if (error.status >= 400) {
    return { retryable: false, code: 'request', message, detail };
  }
  return { retryable: false, code: 'unknown', message, detail };
}

export const isRetryable = (error) => classifyError(error).retryable;

/** Short, human wording for a toast or inline message. */
export function userMessage(error, fallback = 'Something went wrong') {
  if (!error) return fallback;
  return classifyError(error).message || fallback;
}

/**
 * Bounded exponential backoff with jitter.
 * attempt starts at 1 for the first retry.
 * caps at 5 minutes so a long outage never spins hot.
 */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 300000, jitter = 0.3 } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const spread = exp * jitter;
  return Math.round(exp - spread + Math.random() * spread * 2);
}
