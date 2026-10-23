/**
 * sync-engine.js — drains the persistent queue and pulls remote changes.
 *
 * Guarantees (AGENTS.md §12):
 *  - Single-flight: only one sync run at a time (a lock, not a promise race).
 *  - Idempotent: a repeated run re-processing an acknowledged op is a no-op
 *    (upserts are keyed by id, deletes of missing rows succeed).
 *  - Retryable vs permanent errors are classified in utils/errors.js; the
 *    queue applies bounded exponential backoff with jitter.
 *  - Local queue items are removed only after the remote acknowledges them.
 *  - Conflicts are never auto-resolved — they become conflict records.
 */

import { getSupabaseClient } from '../services/supabase-client.js';
import { withStores, req } from '../db/database.js';
import {
  isSyncEnabled, isSyncSuspended, claimDue, acknowledge, markFailure, markConflict, listQueue,
  enqueue, hasPendingFor,
} from './sync-queue.js';
import {
  ENTITIES, CONTENT_ENTITIES, pushUpsert, pushDelete, pullSince, pullAllIds, fromRow,
} from './remote-api.js';
import { createConflict, listConflicts } from './conflict-resolver.js';
import { probeBackend, markSyncedNow, refreshSyncStatus, connectivityInfo } from './connectivity.js';
import { bus } from '../utils/bus.js';
import { classifyError } from '../utils/errors.js';

let running = false;
let scheduled = null;
let engineTimer = null;
let started = false;
let lastPullAt = 0;
let listenersInstalled = false;

const PULL_INTERVAL_MS = 120000; // pull at most every 2 minutes while syncing
const RUN_INTERVAL_MS = 30000;

/* --------------------------------------------------------------- meta I/O */

async function getMeta(key, fallback = null) {
  try {
    const value = await withStores('meta', 'readonly', (stores) => req(stores.meta.get(key)));
    return value === undefined || value === null ? fallback : value.value;
  } catch {
    return fallback;
  }
}

async function setMeta(key, value) {
  await withStores('meta', 'readwrite', (stores) => req(stores.meta.put({ key, value })));
}

/* ----------------------------------------------------- push-side helpers */

/**
 * After a successful push, mark the local record clean — but only if it has
 * not been edited again while the request was in flight. Sibling queued ops
 * for the same record get the new base so they cannot raise a false conflict.
 */
async function applyPushedRevision(entity, payloadRevision, newRevision) {
  const storeName = ENTITIES[entity]?.store;
  if (!storeName || entity === 'preferences') return;

  await withStores([storeName, 'queue'], 'readwrite', async (stores) => {
    const record = await req(stores[storeName].get(payloadRevision.id));
    if (record && (record.revision ?? 0) === payloadRevision.revision) {
      record.baseRevision = newRevision;
      await req(stores[storeName].put(record));
    }
    const siblings = await req(stores.queue.index('by-entity').getAll(entity));
    for (const sibling of siblings) {
      if (sibling.targetId !== payloadRevision.id) continue;
      if (sibling.status === 'pending' || sibling.status === 'failed') {
        sibling.baseRevision = newRevision;
        await req(stores.queue.put(sibling));
      }
    }
  });
}

async function processOp(client, op) {
  try {
    if (op.action === 'delete') {
      await pushDelete(client, op.entity, op.targetId);
      await acknowledge(op.opId);
      return { result: 'deleted' };
    }
    const { revision } = await pushUpsert(client, op.entity, op);
    await applyPushedRevision(op.entity, op.payload, revision);
    await acknowledge(op.opId);
    return { result: 'pushed', revision };
  } catch (error) {
    const info = classifyError(error);
    if (error?.conflict) {
      await markConflict(op.opId, { remoteRevision: error.remote?.revision ?? null });
      await createConflict({
        entity: op.entity,
        targetId: op.targetId,
        local: op.payload,
        remote: error.remote ?? null,
        opId: op.opId,
        reason: 'revision',
      });
      return { result: 'conflict' };
    }
    await markFailure(op.opId, error);
    return { result: 'failed', error: info.message };
  }
}

async function pushQueue(client, summary) {
  const ops = await claimDue({ limit: 50 });
  for (const op of ops) {
    const outcome = await processOp(client, op);
    if (outcome.result === 'pushed') summary.pushed += 1;
    else if (outcome.result === 'deleted') summary.deleted += 1;
    else if (outcome.result === 'conflict') summary.conflicts += 1;
    else if (outcome.result === 'failed') summary.failed += 1;
  }
  return ops.length;
}

/* --------------------------------------------------------------- pulling */

/** Max write time across the key/value preference rows (single blob time). */
async function localPrefsTimestamp() {
  const rows = await withStores('preferences', 'readonly', (stores) => req(stores.preferences.getAll()));
  return rows.reduce((max, row) => Math.max(max, row.updatedAt ?? 0), 0);
}

function localStoreOf(entity) {
  return ENTITIES[entity]?.store ?? null;
}

/** Apply a batch of pulled rows for one entity (never overwrites local edits). */
async function applyPulledRows(entity, rows, summary) {
  const storeName = localStoreOf(entity);
  if (!storeName) return;

  for (const row of rows) {
    const remote = fromRow(entity, row);
    const remoteId = remote?.id ?? (entity === 'preferences' ? 'app' : null);
    if (!remoteId) continue;

    // A pending op means the queue owns this record until it is acknowledged
    // (also prevents resurrecting a record with a queued delete).
    if (await hasPendingFor(entity, remoteId)) continue;

    if (entity === 'preferences') {
      // Last-writer-wins on the whole blob — nothing meaningful to merge.
      const localAt = await localPrefsTimestamp();
      if ((remote.updatedAt ?? 0) > localAt) {
        await withStores('preferences', 'readwrite', async (stores) => {
          await req(stores.preferences.clear());
          for (const [key, value] of Object.entries(remote.value || {})) {
            await req(stores.preferences.put({ key, value, updatedAt: Date.now() }));
          }
        });
        bus.emit('prefs:changed', { keys: Object.keys(remote.value || {}), fromRemote: true });
        summary.pulled += 1;
      }
      continue;
    }

    const local = await withStores(storeName, 'readonly', (stores) => req(stores[storeName].get(remoteId)));

    if (!local) {
      const adopted = { ...remote, baseRevision: remote.revision ?? 0, revision: remote.revision ?? 0 };
      await withStores(storeName, 'readwrite', (stores) => req(stores[storeName].put(adopted)));
      summary.pulled += 1;
      continue;
    }

    const localClean = (local.revision ?? 0) <= (local.baseRevision ?? 0);
    const remoteNewer = (remote.revision ?? 0) > (local.baseRevision ?? 0);

    if (localClean && remoteNewer) {
      const adopted = {
        ...remote,
        id: remote.id,
        lastOpenedAt: local.lastOpenedAt ?? remote.lastOpenedAt ?? null, // reads stay device-local
        baseRevision: remote.revision ?? 0,
        revision: remote.revision ?? 0,
      };
      await withStores(storeName, 'readwrite', (stores) => req(stores[storeName].put(adopted)));
      summary.pulled += 1;
    } else if (!localClean && remoteNewer) {
      // Unsynced local edits + different remote version → user decides.
      await createConflict({
        entity,
        targetId: remote.id,
        local,
        remote,
        reason: 'revision',
      });
      summary.conflicts += 1;
    }
  }
}

/** Cursor pull for a single entity. */
async function pullEntity(client, entity, summary) {
  const cursorKey = `pullCursor:${entity}`;
  let cursor = await getMeta(cursorKey, null);
  let guard = 0;

  for (;;) {
    const { rows, cursor: nextCursor, fullPage } = await pullSince(client, entity, cursor);
    if (rows.length) await applyPulledRows(entity, rows, summary);
    cursor = nextCursor ?? cursor;
    guard += 1;
    if (!fullPage || guard >= 40) break;
  }

  if (cursor) await setMeta(cursorKey, cursor);
}

/**
 * Full comparison used after sign-in / manual sync: detects records that were
 * permanently deleted on another device (absent from the remote id list).
 */
async function detectRemoteDeletions(client, summary) {
  for (const entity of CONTENT_ENTITIES) {
    const storeName = localStoreOf(entity);
    const remoteIds = new Set(await pullAllIds(client, entity));
    const localRecords = await withStores(storeName, 'readonly', (stores) => req(stores[storeName].getAll()));

    for (const local of localRecords) {
      if (remoteIds.has(local.id)) continue;
      if ((local.baseRevision ?? 0) === 0) continue;       // never pushed
      const pending = await hasPendingFor(entity, local.id);
      if (pending) continue;                               // queue will recreate/update it

      await createConflict({
        entity,
        targetId: local.id,
        local,
        remote: null,
        reason: 'deleted-remote',
      });
      summary.conflicts += 1;
    }
  }
}

async function pullAll(client, summary, { deletions = false } = {}) {
  for (const entity of [...CONTENT_ENTITIES, 'preferences']) {
    await pullEntity(client, entity, summary);
  }
  if (deletions) await detectRemoteDeletions(client, summary);
  lastPullAt = Date.now();
  await setMeta('lastPullAt', lastPullAt);
}

/* ------------------------------------------------------------ entry point */

/**
 * Run one synchronization pass.
 * @param {{reason?: string, manual?: boolean}} [options]
 * @returns {Promise<object|null>} summary, or null when skipped
 */
export async function runSyncOnce({ reason = 'auto', manual = false } = {}) {
  if (!isSyncEnabled()) {
    await refreshSyncStatus();
    return null;
  }
  if (isSyncSuspended()) {
    // First-sign-in choice undecided (or user chose "stay local") — never
    // merge silently: the queue keeps accumulating, nothing leaves the device.
    await refreshSyncStatus();
    return { reason, skipped: 'suspended' };
  }
  if (running) return null;
  running = true;

  const summary = { reason, pushed: 0, deleted: 0, pulled: 0, conflicts: 0, failed: 0 };
  bus.emit('sync:run-start', summary);

  try {
    const reachable = await probeBackend();
    if (reachable === false) {
      summary.skipped = 'offline';
      return summary;
    }

    const client = await getSupabaseClient();
    if (!client) { summary.skipped = 'not-configured'; return summary; }

    const authState = await client.auth.getSession();
    if (!authState.data?.session) {
      summary.skipped = 'signed-out';
      return summary;
    }

    // 1) Push everything the user has changed locally.
    await pushQueue(client, summary);

    // 2) Pull remote changes: always on manual/sign-in/reconnect, otherwise
    //    periodically once the queue is quiet (keeps request volume low).
    const wantPull =
      manual ||
      reason === 'signin' ||
      reason === 'reconnect' ||
      reason === 'choice' ||
      (Date.now() - lastPullAt > PULL_INTERVAL_MS && summary.pushed === 0 && summary.failed === 0);

    if (wantPull) {
      await pullAll(client, summary, { deletions: manual || reason === 'signin' || reason === 'choice' });
    }

    if (summary.failed === 0 && summary.conflicts === 0) {
      await markSyncedNow();
    }
    return summary;
  } catch (error) {
    const info = classifyError(error);
    summary.error = info.message;
    summary.retryable = info.retryable;
    console.warn(`[sync] run failed (${reason}):`, info.message);
    return summary;
  } finally {
    running = false;
    await refreshSyncStatus();
    bus.emit('sync:run-end', summary);
  }
}

/** Debounced trigger (queue writes fire this constantly during editing). */
export function triggerSync(reason = 'queue', { delay = 800 } = {}) {
  if (!isSyncEnabled() || isSyncSuspended()) return;
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    void runSyncOnce({ reason });
  }, delay);
}

/**
 * Queue upserts for every local record that has never been pushed (or was
 * edited while signed out). Idempotent: coalesces with existing ops.
 */
export async function enqueueUnsyncedLocal({ includePreferences = true } = {}) {
  let queued = 0;
  const targets = [...CONTENT_ENTITIES];
  if (includePreferences) targets.push('preferences');

  for (const entity of targets) {
    if (entity === 'preferences') {
      // The preference blob has no per-row revision — always safe to (re)push
      // when the user chose to upload; LWW decides the winner.
      const op = await enqueue({
        entity,
        id: 'app',
        action: 'upsert',
        payload: { key: 'app', value: await collectPrefs() },
        baseRevision: 0,
      });
      if (op) queued += 1;
      continue;
    }
    const storeName = ENTITIES[entity].store;
    const records = await withStores(storeName, 'readonly', (stores) => req(stores[storeName].getAll()));
    for (const record of records) {
      if ((record.revision ?? 0) <= (record.baseRevision ?? 0)) continue;
      const op = await enqueue({ entity, id: record.id, action: 'upsert', payload: record, baseRevision: record.baseRevision });
      if (op) queued += 1;
    }
  }
  return queued;
}

async function collectPrefs() {
  const { getAllPrefs } = await import('../db/repositories/preferences.js');
  return getAllPrefs();
}

/** How many local records would be uploaded / how many exist. */
export async function localLibraryCounts() {
  const counts = { records: 0, unsynced: 0 };
  for (const entity of CONTENT_ENTITIES) {
    const storeName = ENTITIES[entity].store;
    const records = await withStores(storeName, 'readonly', (stores) => req(stores[storeName].getAll()));
    for (const record of records) {
      counts.records += 1;
      if ((record.revision ?? 0) > (record.baseRevision ?? 0)) counts.unsynced += 1;
    }
  }
  return counts;
}

/* -------------------------------------------------------- engine lifecycle */

export function startSyncEngine() {
  if (started) return;
  started = true;

  if (!listenersInstalled) {
    listenersInstalled = true;
    bus.on('sync:changed', (payload) => {
      // Coalesced/no-op change events shouldn't schedule extra runs.
      if (payload?.ack || payload?.retried !== undefined) return;
      triggerSync('queue');
    });
  }

  engineTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!isSyncEnabled()) return;
    void runSyncOnce({ reason: 'interval' });
  }, RUN_INTERVAL_MS);

  if (isSyncEnabled()) triggerSync('startup', { delay: 400 });
}

export function stopSyncEngine() {
  if (engineTimer) clearInterval(engineTimer);
  engineTimer = null;
  started = false;
}

export function syncEngineStatus() {
  return { running, lastPullAt, connectivity: connectivityInfo() };
}

/** Queue health for Settings → Sync (failed items need manual retry). */ 
export async function failedOperations() {
  const items = await listQueue();
  return items.filter((item) => item.status === 'failed');
}

export async function conflictCount() {
  const rows = await listConflicts();
  return rows.length;
}
