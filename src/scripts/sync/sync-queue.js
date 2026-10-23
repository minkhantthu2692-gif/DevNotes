/**
 * sync-queue.js — persistent, idempotent operation queue (local-first).
 *
 * Behaviour (AGENTS.md §12):
 *  - Every mutation that should reach the cloud appends an operation here
 *    inside the SAME IndexedDB transaction as the record write.
 *  - Operations coalesce per target record: autosave never floods the queue
 *    and a delete cancels an earlier pending upsert (and vice versa).
 *  - Items are only removed after the remote acknowledges them (or the user
 *    explicitly discards a permanently failed item).
 *  - Nothing here performs network I/O — sync-engine.js drains the queue.
 */

import { withStores, req } from '../db/database.js';
import { shortId } from '../utils/id.js';
import { bus } from '../utils/bus.js';
import { backoffDelay, classifyError } from '../utils/errors.js';
import { SUPABASE } from '../config.js';

const SESSION_FLAG = 'devnotes.session-active';

export const MAX_ATTEMPTS = 8;

/** True when cloud sync is possible: configured AND signed in. */
export function isSyncEnabled() {
  if (!SUPABASE.enabled()) return false;
  try {
    return localStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    return false;
  }
}

/** Set by auth-service on sign-in/sign-out. */
export function setSyncActive(active) {
  try {
    localStorage.setItem(SESSION_FLAG, active ? '1' : '0');
  } catch { /* storage disabled: sync simply stays off */ }
  bus.emit('sync:changed', { reason: active ? 'signed-in' : 'signed-out' });
}

const SUSPEND_FLAG = 'devnotes.sync-suspended';

/**
 * Suspended = syncing is intentionally held back (first-sign-in choice not
 * decided yet, or the user chose "stay local"). Local edits keep queueing;
 * the engine just does not drain the queue.
 */
export function isSyncSuspended() {
  try {
    return localStorage.getItem(SUSPEND_FLAG) === '1';
  } catch {
    return false;
  }
}

export function setSyncSuspended(suspended) {
  try {
    if (suspended) localStorage.setItem(SUSPEND_FLAG, '1');
    else localStorage.removeItem(SUSPEND_FLAG);
  } catch { /* storage disabled */ }
  bus.emit('sync:changed', { suspended });
}

function notifyQueueChanged(extra = {}) {
  bus.emit('sync:changed', extra);
}

/**
 * Insert or coalesce one operation inside an existing transaction.
 * @param {IDBObjectStore} queueStore the 'queue' store of the active tx
 * @param {{entity: string, id: string, action: 'upsert'|'delete',
 *          payload?: object, baseRevision?: number}} op
 */
export async function enqueueWith(queueStore, op) {
  if (!isSyncEnabled()) return null;

  const existing = await req(queueStore.index('by-entity').getAll(op.entity));
  const clash = existing.find((item) => item.targetId === op.id);

  // Coalesce: keep a single pending op per record with the newest intent.
  if (clash && clash.status !== 'failed') {
    const merged = { ...clash, updatedAt: Date.now() };
    // A fresh intent also releases an op that was paused for conflict
    // resolution (the user's latest edit supersedes the disputed state).
    if (clash.status === 'conflict' && op.action === 'upsert') {
      merged.status = 'pending';
      merged.attempts = 0;
      merged.nextAttemptAt = Date.now();
      merged.lastError = null;
    }
    if (op.action === 'delete') {
      merged.action = 'delete';
      merged.payload = { id: op.id };
    } else {
      // Upsert supersedes a queued delete (e.g. restore from trash).
      merged.action = 'upsert';
      merged.payload = op.payload;
      merged.baseRevision = op.baseRevision ?? clash.baseRevision;
    }
    await req(queueStore.put(merged));
    notifyQueueChanged({ entity: op.entity, id: op.id, coalesced: true });
    return merged;
  }

  const item = {
    opId: shortId('op'),
    entity: op.entity,
    targetId: op.id,
    action: op.action,
    payload: op.payload ?? null,
    baseRevision: op.baseRevision ?? 0,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  };
  await req(queueStore.add(item));
  notifyQueueChanged({ entity: op.entity, id: op.id });
  return item;
}

/** Standalone enqueue (own transaction). Returns null when sync is off. */
export function enqueue(op) {
  if (!isSyncEnabled()) return Promise.resolve(null);
  return withStores('queue', 'readwrite', (stores) => enqueueWith(stores.queue, op));
}

/** All queue items, oldest first. */
export function listQueue(status = null) {
  return withStores('queue', 'readonly', async (stores) => {
    const all = await req(stores.queue.getAll());
    const filtered = status ? all.filter((item) => item.status === status) : all;
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  });
}

/** Counts for status UI: pending (incl. syncing), failed, next attempt. */
export async function queueStats() {
  const all = await listQueue();
  const stats = { total: all.length, pending: 0, syncing: 0, failed: 0, nextAttemptAt: null };
  for (const item of all) {
    if (item.status === 'failed') stats.failed += 1;
    else if (item.status === 'syncing') stats.syncing += 1;
    else stats.pending += 1;
    if (item.status !== 'failed' && item.attempts > 0) {
      stats.nextAttemptAt = Math.min(stats.nextAttemptAt ?? Infinity, item.nextAttemptAt);
    }
  }
  if (stats.nextAttemptAt === Infinity) stats.nextAttemptAt = null;
  return stats;
}

/** Claim items for a sync run (single-flight guaranteed by the engine lock). */
export function claimDue({ limit = 25 } = {}) {
  const now = Date.now();
  return withStores('queue', 'readwrite', async (stores) => {
    const all = await req(stores.queue.getAll());
    const due = all
      .filter((item) => (item.status === 'pending' || item.status === 'error') && item.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
    for (const item of due) {
      item.status = 'syncing';
      item.updatedAt = now;
      await req(stores.queue.put(item));
    }
    return due;
  });
}

/** Remove an acknowledged operation. Safe to call twice (idempotent). */
export function acknowledge(opId) {
  return withStores('queue', 'readwrite', async (stores) => {
    const existing = await req(stores.queue.get(opId));
    if (existing) await req(stores.queue.delete(opId));
  }).then(() => notifyQueueChanged({ ack: opId }));
}

/**
 * Record a failed attempt: retryable → backoff schedule, permanent →
 * status 'failed' for manual retry/discard in Settings → Sync.
 */
export function markFailure(opId, error) {
  const info = classifyError(error);
  return withStores('queue', 'readwrite', async (stores) => {
    const item = await req(stores.queue.get(opId));
    if (!item) return null;
    item.attempts += 1;
    item.updatedAt = Date.now();
    item.lastError = { message: info.message, code: info.code, retryable: info.retryable, at: Date.now() };

    if (info.retryable && item.attempts < MAX_ATTEMPTS) {
      item.status = 'pending';
      item.nextAttemptAt = Date.now() + backoffDelay(item.attempts);
    } else if (info.retryable) {
      item.status = 'failed'; // out of automatic retries: manual action
      item.lastError.message = `${info.message} (automatic retries exhausted)`;
    } else {
      item.status = 'failed';
    }
    await req(stores.queue.put(item));
    notifyQueueChanged({ failed: opId });
    return item;
  });
}

/** Manual retry from the UI: reset backoff for one item or everything. */
export function retryFailed(opIds = null) {
  return withStores('queue', 'readwrite', async (stores) => {
    const all = await req(stores.queue.getAll());
    let count = 0;
    for (const item of all) {
      if (item.status !== 'failed') continue;
      if (opIds && !opIds.includes(item.opId)) continue;
      item.status = 'pending';
      item.attempts = 0;
      item.nextAttemptAt = Date.now();
      item.lastError = null;
      item.updatedAt = Date.now();
      await req(stores.queue.put(item));
      count += 1;
    }
    notifyQueueChanged({ retried: count });
    return count;
  });
}

/** Explicitly discard a permanently failed operation (user confirmation). */
export function discardOp(opId) {
  return withStores('queue', 'readwrite', async (stores) => {
    await req(stores.queue.delete(opId));
  }).then(() => notifyQueueChanged({ discarded: opId }));
}

/** Pause an operation because the remote holds a different newer version. */
export function markConflict(opId, info) {
  return withStores('queue', 'readwrite', async (stores) => {
    const item = await req(stores.queue.get(opId));
    if (!item) return null;
    item.status = 'conflict';
    item.updatedAt = Date.now();
    item.lastError = { message: 'Conflicting remote version', code: 'conflict', retryable: false, at: Date.now(), ...info };
    await req(stores.queue.put(item));
    notifyQueueChanged({ conflict: opId });
    return item;
  });
}

/** Drop every queued operation for one target (used when the remote wins). */
export function discardFor(entity, id) {
  return withStores('queue', 'readwrite', async (stores) => {
    const items = await req(stores.queue.index('by-entity').getAll(entity));
    for (const item of items) {
      if (item.targetId === id) await req(stores.queue.delete(item.opId));
    }
  }).then(() => notifyQueueChanged({ discardedFor: id }));
}

/** True when the queue holds work for a specific record. */
export async function hasPendingFor(entity, id) {
  const items = await withStores('queue', 'readonly', (stores) =>
    req(stores.queue.index('by-entity').getAll(entity)),
  );
  return items.some((item) => item.targetId === id && item.status !== 'failed');
}
