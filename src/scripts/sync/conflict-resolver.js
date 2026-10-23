/**
 * conflict-resolver.js — conflict records and explicit resolution.
 *
 * When the remote holds a different newer version we keep BOTH sides (§12) and
 * require the user to choose: keep local, keep remote, or merge manually.
 * Nothing is overwritten automatically.
 */

import { withStores, req, readAll } from '../db/database.js';
import { ENTITIES } from './remote-api.js';
import { enqueueWith, discardFor, isSyncEnabled } from './sync-queue.js';
import { bus } from '../utils/bus.js';
import { shortId } from '../utils/id.js';

/**
 * Store a conflict discovered by the sync engine.
 * @param {{entity, targetId, local, remote, opId?, reason?}} input
 *        `remote` is null when the record was deleted remotely.
 */
export async function createConflict({ entity, targetId, local, remote, opId = null, reason = 'revision' }) {
  // Dedupe: repeated pulls must not stack conflict records for one target.
  const existing = await readAll('conflicts');
  const duplicate = existing.find((row) => row.entity === entity && row.targetId === targetId);
  if (duplicate) return duplicate;

  const record = {
    id: shortId('cflt'),
    entity,
    targetId,
    local: local ?? null,
    remote: remote ?? null,
    opId,
    reason, // 'revision' | 'deleted-remote'
    detectedAt: Date.now(),
    resolved: false,
  };
  await withStores('conflicts', 'readwrite', (stores) => req(stores.conflicts.put(record)));
  bus.emit('conflicts:changed', { action: 'created', id: record.id, entity, targetId });
  return record;
}

export function listConflicts() {
  return readAll('conflicts').then((rows) => rows.sort((a, b) => b.detectedAt - a.detectedAt));
}

export async function countConflicts() {
  const rows = await listConflicts();
  return rows.length;
}

export async function getConflict(id) {
  const rows = await readAll('conflicts');
  return rows.find((row) => row.id === id) ?? null;
}

async function removeConflict(id) {
  await withStores('conflicts', 'readwrite', (stores) => req(stores.conflicts.delete(id)));
}

/**
 * Write a record locally.
 * @param {boolean} queue when true, an upsert op is (co)queued for push;
 *        adoption of a remote version sets this to false (nothing to push).
 */
async function writeLocal(entity, record, { queue }) {
  const storeName = ENTITIES[entity]?.store;
  if (!storeName) throw new Error(`Unknown sync entity: ${entity}`);

  if (entity === 'preferences') {
    // Preferences are a key/value blob: mirror into each preference row.
    const partial = record.value || {};
    const { setPrefs } = await import('../db/repositories/preferences.js');
    if (queue) {
      await setPrefs(partial);
    } else {
      await withStores('preferences', 'readwrite', async (stores) => {
        await req(stores.preferences.clear());
        for (const [key, value] of Object.entries(partial)) {
          await req(stores.preferences.put({ key, value, updatedAt: Date.now() }));
        }
      });
      bus.emit('prefs:changed', { keys: Object.keys(partial), fromRemote: true });
    }
    return;
  }

  await withStores([storeName, 'queue'], 'readwrite', async (stores) => {
    await req(stores[storeName].put(record));
    if (queue && isSyncEnabled()) {
      await enqueueWith(stores.queue, {
        entity,
        id: record.id,
        action: 'upsert',
        payload: record,
        baseRevision: record.baseRevision,
      });
    }
  });
}

/**
 * Resolve a conflict.
 * @param {string} conflictId
 * @param {'local'|'remote'|'merge'} choice
 * @param {object} [merged] for 'merge': user-edited fields. The merged local
 *        record wins, but it acknowledges the remote revision as its base so
 *        the next push cannot raise the same conflict again.
 */
export async function resolveConflict(conflictId, choice, merged = null) {
  const conflict = await getConflict(conflictId);
  if (!conflict) throw new Error('Conflict not found');

  const { entity, targetId, local, remote } = conflict;

  if (choice === 'remote') {
    if (remote) {
      const record = { ...remote, id: targetId, baseRevision: remote.revision ?? 0, revision: remote.revision ?? 0 };
      await writeLocal(entity, record, { queue: false });
    } else {
      const storeName = ENTITIES[entity].store;
      await withStores(storeName, 'readwrite', (stores) => req(stores[storeName].delete(targetId)));
    }
    // The paused op represents the rejected local side — drop it entirely.
    await discardFor(entity, targetId);
  } else if (choice === 'local') {
    if (!local) throw new Error('No local side to keep');
    const record = { ...local, id: targetId };
    if (remote) record.baseRevision = remote.revision ?? 0;
    record.revision = (record.revision ?? 0) + 1;
    record.updatedAt = Date.now();
    // Drop the paused (possibly permanently failed) op first so the fresh
    // upsert is the only queue item for this target.
    await discardFor(entity, targetId);
    await writeLocal(entity, record, { queue: true });
  } else if (choice === 'merge') {
    if (!merged || typeof merged !== 'object') throw new Error('Merged record required');
    const record = { ...(local || {}), ...merged, id: targetId };
    record.baseRevision = remote ? (remote.revision ?? 0) : (record.baseRevision ?? 0);
    record.revision = (record.revision ?? 0) + 1;
    record.updatedAt = Date.now();
    await discardFor(entity, targetId);
    await writeLocal(entity, record, { queue: true });
  } else {
    throw new Error(`Unknown choice: ${choice}`);
  }

  await removeConflict(conflictId);

  bus.emit('conflicts:changed', { action: 'resolved', id: conflictId, choice, entity, targetId });
  bus.emit('data:changed', { entity, action: 'conflict-resolved', id: targetId });
  return true;
}

/** Acknowledge a conflict without applying either side (queue keeps its state). */
export async function dismissConflict(conflictId) {
  const conflict = await getConflict(conflictId);
  if (!conflict) return false;
  await removeConflict(conflictId);
  bus.emit('conflicts:changed', { action: 'dismissed', id: conflictId });
  return true;
}
