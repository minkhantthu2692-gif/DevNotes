import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// Dynamic imports AFTER the environment helper (fake-indexeddb + localStorage).
const queue = await import('../../src/scripts/sync/sync-queue.js');
const { SUPABASE } = await import('../../src/scripts/config.js');
const { AppError } = await import('../../src/scripts/utils/errors.js');
const { wipeLocalDatabase } = await import('../../src/scripts/db/database.js');

/*
 * The queue only accepts operations when sync is enabled (configured Supabase
 * + signed-in session). Tests enable both seams: the config object's enabled()
 * method is patched for the duration of the file, and the session flag is set
 * through the public setter.
 */
const originalEnabled = SUPABASE.enabled;
SUPABASE.enabled = () => true;
queue.setSyncActive(true);

test.beforeEach(async () => {
  await wipeLocalDatabase();
});

test.after(() => {
  SUPABASE.enabled = originalEnabled;
  queue.setSyncActive(false);
  queue.setSyncSuspended(false);
});

const op = (id, extra = {}) => ({
  entity: 'lesson', id, action: 'upsert', payload: { id, title: 'T' }, baseRevision: 0, ...extra,
});

test('enqueue: one pending operation per record', async () => {
  await queue.enqueue(op('a'));
  const items = await queue.listQueue();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].targetId, 'a');
});

test('enqueue: repeat edits coalesce into a single operation', async () => {
  await queue.enqueue(op('a', { payload: { id: 'a', title: 'v1' } }));
  await queue.enqueue(op('a', { payload: { id: 'a', title: 'v2' } }));
  await queue.enqueue(op('a', { payload: { id: 'a', title: 'v3' } }));

  const items = await queue.listQueue();
  assert.equal(items.length, 1, 'autosave must not flood the queue');
  assert.equal(items[0].payload.title, 'v3', 'the newest intent wins');
});

test('enqueue: a delete supersedes a pending upsert and vice versa', async () => {
  await queue.enqueue(op('a'));
  await queue.enqueue(op('a', { action: 'delete', payload: null }));
  let items = await queue.listQueue();
  assert.equal(items.length, 1);
  assert.equal(items[0].action, 'delete');

  // Restore-from-trash: an upsert supersedes the queued delete.
  await queue.enqueue(op('a', { payload: { id: 'a', title: 'restored' } }));
  items = await queue.listQueue();
  assert.equal(items.length, 1);
  assert.equal(items[0].action, 'upsert');
  assert.equal(items[0].payload.title, 'restored');
});

test('enqueue: different records stay separate operations', async () => {
  await queue.enqueue(op('a'));
  await queue.enqueue(op('b'));
  assert.equal((await queue.listQueue()).length, 2);
});

test('claimDue: marks items syncing so a second run cannot double-claim', async () => {
  await queue.enqueue(op('a'));
  const first = await queue.claimDue();
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'syncing');

  const second = await queue.claimDue();
  assert.equal(second.length, 0, 'an in-flight item is never claimed twice');
});

test('acknowledge: removes the operation and is idempotent', async () => {
  const item = await queue.enqueue(op('a'));
  await queue.acknowledge(item.opId);
  assert.equal((await queue.listQueue()).length, 0);
  await queue.acknowledge(item.opId); // second call must not throw
  assert.equal((await queue.listQueue()).length, 0);
});

test('markFailure: retryable errors schedule a backoff retry', async () => {
  const item = await queue.enqueue(op('a'));
  const failed = await queue.markFailure(item.opId, new TypeError('fetch failed'));

  assert.equal(failed.status, 'pending');
  assert.equal(failed.attempts, 1);
  assert.ok(failed.nextAttemptAt > Date.now(), 'the next attempt is in the future');
  assert.equal(failed.lastError.code, 'network');
  assert.equal(failed.lastError.retryable, true);
});

test('markFailure: permanent errors fail immediately without retries', async () => {
  const item = await queue.enqueue(op('a'));
  const failed = await queue.markFailure(item.opId, new AppError('key rejected', { code: 'auth' }));

  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastError.retryable, false);
});

test('markFailure: retryable errors eventually exhaust automatic retries', async () => {
  const item = await queue.enqueue(op('a'));
  let current = item;
  for (let i = 0; i < queue.MAX_ATTEMPTS; i += 1) {
    current = await queue.markFailure(current.opId, new TypeError('fetch failed'));
  }
  assert.equal(current.status, 'failed');
  assert.match(current.lastError.message, /exhausted/i);
  assert.equal(current.attempts, queue.MAX_ATTEMPTS);
});

test('retryFailed: manual retry resets the item for another run', async () => {
  const item = await queue.enqueue(op('a'));
  await queue.markFailure(item.opId, new AppError('bad', { code: 'auth' }));

  const count = await queue.retryFailed();
  assert.equal(count, 1);

  const [retried] = await queue.listQueue();
  assert.equal(retried.status, 'pending');
  assert.equal(retried.attempts, 0);
  assert.equal(retried.lastError, null);

  assert.equal(await queue.retryFailed(), 0, 'nothing left to retry');
});

test('discardOp: explicitly drops a permanently failed operation', async () => {
  const item = await queue.enqueue(op('a'));
  await queue.markFailure(item.opId, new AppError('bad', { code: 'auth' }));
  await queue.discardOp(item.opId);
  assert.equal((await queue.listQueue()).length, 0);
});

test('queueStats: counts pending/syncing/failed for the status UI', async () => {
  const a = await queue.enqueue(op('a'));
  await queue.enqueue(op('b'));
  const c = await queue.enqueue(op('c'));
  await queue.markFailure(c.opId, new AppError('bad', { code: 'auth' }));
  await queue.claimDue({ limit: 1 });

  const stats = await queue.queueStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.failed, 1);
  assert.equal(stats.syncing, 1);
  assert.equal(stats.pending, 1);
});

test('suspension flag: holds the engine back without losing queued work', async () => {
  queue.setSyncSuspended(true);
  assert.equal(queue.isSyncSuspended(), true);

  await queue.enqueue(op('a'));
  assert.equal((await queue.listQueue()).length, 1, 'local edits keep queueing while suspended');

  queue.setSyncSuspended(false);
  assert.equal(queue.isSyncSuspended(), false);
});

test('enqueue: returns null when sync is not enabled', async () => {
  SUPABASE.enabled = () => false;
  try {
    assert.equal(await queue.enqueue(op('z')), null);
    assert.equal((await queue.listQueue()).length, 0);
  } finally {
    SUPABASE.enabled = () => true;
  }
});
