import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AppError,
  classifyError,
  isRetryable,
  userMessage,
  backoffDelay,
} from '../../src/scripts/utils/errors.js';

test('classifyError: AppError code decides retryability when not overridden', () => {
  assert.equal(classifyError(new AppError('net', { code: 'network' })).retryable, true);
  assert.equal(classifyError(new AppError('rate', { code: 'rate-limit' })).retryable, true);
  assert.equal(classifyError(new AppError('auth', { code: 'auth' })).retryable, false);
  assert.equal(classifyError(new AppError('model', { code: 'model' })).retryable, false);
});

test('classifyError: explicit retryable flag wins over the code default', () => {
  const forced = new AppError('special', { code: 'network', retryable: false });
  assert.equal(classifyError(forced).retryable, false);

  const forcedUp = new AppError('special', { code: 'auth', retryable: true });
  assert.equal(classifyError(forcedUp).retryable, true);
});

test('classifyError: browser failure shapes map to stable codes', () => {
  const abort = new Error('stopped');
  abort.name = 'AbortError';
  assert.deepEqual(
    { ...classifyError(abort), detail: undefined },
    { retryable: false, code: 'cancelled', message: 'Request was cancelled', detail: undefined },
  );

  const timeout = new Error('slow');
  timeout.name = 'TimeoutError';
  assert.equal(classifyError(timeout).code, 'timeout');
  assert.equal(classifyError(timeout).retryable, true);

  assert.equal(classifyError(new TypeError('fetch failed')).code, 'network');
  assert.equal(classifyError(new TypeError('fetch failed')).retryable, true);

  const quota = new Error('full');
  quota.name = 'QuotaExceededError';
  assert.equal(classifyError(quota).code, 'storage-quota');
  assert.equal(classifyError(quota).retryable, false);
});

test('classifyError: HTTP status shapes map to server/rate-limit/request', () => {
  assert.equal(classifyError({ status: 500, message: 'boom' }).retryable, true);
  assert.equal(classifyError({ status: 503, message: 'boom' }).code, 'server');
  assert.equal(classifyError({ status: 429, message: 'slow down' }).code, 'rate-limit');
  assert.equal(classifyError({ status: 404, message: 'nope' }).code, 'request');
  assert.equal(classifyError({ status: 404, message: 'nope' }).retryable, false);
});

test('classifyError: falsy input is a safe unknown', () => {
  assert.equal(classifyError(null).code, 'unknown');
  assert.equal(classifyError(undefined).retryable, false);
});

test('isRetryable + userMessage helpers', () => {
  assert.equal(isRetryable(new AppError('x', { code: 'timeout' })), true);
  assert.equal(userMessage(new AppError('Custom problem'), 'fallback'), 'Custom problem');
  assert.equal(userMessage(null, 'fallback'), 'fallback');
});

test('backoffDelay: exponential growth, capped, with bounded jitter', () => {
  // No jitter: exact exponential values.
  assert.equal(backoffDelay(1, { jitter: 0 }), 1000);
  assert.equal(backoffDelay(2, { jitter: 0 }), 2000);
  assert.equal(backoffDelay(5, { jitter: 0 }), 16000);
  assert.equal(backoffDelay(40, { jitter: 0 }), 300000, 'capped at 5 minutes');

  // With jitter: always within ±30% of the exponential value.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const base = Math.min(300000, 1000 * 2 ** (attempt - 1));
    const value = backoffDelay(attempt);
    assert.ok(value >= base * 0.7 && value <= base * 1.3, `attempt ${attempt}: ${value} outside jitter bounds`);
  }
});
