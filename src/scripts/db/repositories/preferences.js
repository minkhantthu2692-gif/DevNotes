/**
 * preferences.js — typed key/value settings stored in IndexedDB.
 *
 * localStorage is used ONLY as a mirror of the appearance subset (so first
 * paint doesn't flash before IndexedDB opens) — IndexedDB stays authoritative.
 * When the user is signed in, the whole preference blob is queued for sync.
 */

import { withStores, req } from '../database.js';
import { enqueueWith, isSyncEnabled } from '../../sync/sync-queue.js';
import { bus } from '../../utils/bus.js';

export const PREFS_STORE_KEY = 'app'; // single syncable record id

async function readAllPrefs() {
  return withStores('preferences', 'readonly', async (stores) => {
    const rows = await req(stores.preferences.getAll());
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  });
}

async function writeAll(prefs) {
  await withStores(['preferences', 'queue'], 'readwrite', async (stores) => {
    await req(stores.preferences.clear());
    for (const [key, value] of Object.entries(prefs)) {
      await req(stores.preferences.put({ key, value, updatedAt: Date.now() }));
    }
    if (isSyncEnabled()) {
      await enqueueWith(stores.queue, {
        entity: 'preferences',
        id: PREFS_STORE_KEY,
        action: 'upsert',
        payload: { key: PREFS_STORE_KEY, value: prefs },
        baseRevision: 0,
      });
    }
  });
  bus.emit('prefs:changed', { keys: Object.keys(prefs) });
}

export async function getPref(key, fallback = null) {
  const value = await withStores('preferences', 'readonly', (stores) => req(stores.preferences.get(key)));
  return value === undefined || value === null ? fallback : value.value;
}

export async function getAllPrefs() {
  return readAllPrefs();
}

/** Merge-write a partial settings object. */
export async function setPrefs(partial) {
  const current = await readAllPrefs();
  const next = { ...current, ...partial };
  await writeAll(next);
  return next;
}

export async function resetPrefs() {
  await writeAll({});
  bus.emit('prefs:changed', { keys: [], reset: true });
}
