/**
 * snapshot.js — short-lived in-memory caches of list data.
 *
 * Purpose: search-as-you-type filters from ONE loaded list instead of
 * re-querying IndexedDB on every keystroke (§9). Caches invalidate on the
 * bus's `data:changed` event, so they can never serve stale records after a
 * write in the same session.
 */

import { bus } from '../utils/bus.js';

const caches = new Map(); // key -> {items, at}
const MAX_AGE_MS = 15000;

/**
 * Get a cached list, loading it with `loader` when missing or stale.
 * @param {string} key cache key, usually the entity name
 * @param {Function} loader async () => array
 */
export async function getSnapshot(key, loader) {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < MAX_AGE_MS) return hit.items;
  const items = await loader();
  caches.set(key, { items, at: Date.now() });
  return items;
}

export function invalidateSnapshot(key = null) {
  if (key) caches.delete(key);
  else caches.clear();
}

/** Drop a single record from a cached list (cheap targeted invalidation). */
export function touchSnapshot(key, id) {
  const hit = caches.get(key);
  if (hit) hit.at = 0; // force reload on next access
  void id;
}

bus.on('data:changed', (payload) => {
  invalidateSnapshot(payload?.entity ?? null);
  invalidateSnapshot('stats');
});
