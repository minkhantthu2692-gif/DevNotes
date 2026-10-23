/**
 * database.js — IndexedDB bootstrap and low-level helpers.
 *
 * UI code never imports this file directly; it goes through the repositories
 * in db/repositories/. Schema changes happen only via versioned migrations
 * (db/migrations/) so user data survives upgrades.
 */

import { openDB } from '../../vendor/idb/index.js';
import { MIGRATIONS } from './migrations/index.js';

const DB_NAME = 'devnotes';

/**
 * Wrap a raw IDBRequest as a promise (used for requests issued inside
 * withStores callbacks, which receive raw object stores).
 * Handlers are attached synchronously by callers, so events can't be missed.
 */
export const req = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });

let dbPromise = null;
let lastError = null;

/** Highest schema version described by the migration list. */
export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * Open (and migrate) the database.
 * Throws a readable AppError-style error when IndexedDB is unavailable
 * (private browsing, disabled storage) so the UI can show a real state.
 */
export function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB is not available in this browser context'));
      return;
    }

    const request = indexedDB.open(DB_NAME, LATEST_VERSION);

    request.onblocked = () => {
      console.warn('[db] Another tab holds an old database version open.');
    };

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      const from = event.oldVersion;
      for (const migration of MIGRATIONS) {
        if (migration.version > from) {
          migration.upgrade(db, tx);
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        // Another tab upgraded: close so we don't block it. The next call
        // reopens with the new schema (page shows a reload hint if a query fails).
        console.warn('[db] schema changed in another tab; closing connection');
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      lastError = request.error;
      dbPromise = null;
      reject(request.error || new Error('Failed to open the local database'));
    };
  });

  return dbPromise;
}

/** True when the local database could not be opened. */
export function databaseFailed() {
  return Boolean(lastError);
}

/** Run a transaction over one or more stores with a convenient handle. */
export async function withStores(names, mode, fn) {
  const db = await getDB();
  const storeNames = Array.isArray(names) ? names : [names];
  const tx = db.transaction(storeNames, mode);

  // Attach completion handlers BEFORE running work so completion events can
  // never be missed (IndexedDB events fire in later tasks).
  const completion = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });

  const result = await fn(
    Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)])),
    tx,
  );
  await completion;
  return result;
}

/**
 * Read records of a store, optionally through an index.
 * `direction: 'prev'` is supported via a backwards cursor (getAll only
 * returns ascending key order).
 */
export async function readAll(name, { index = null, direction = 'next', query = undefined } = {}) {
  return withStores(name, 'readonly', async (stores) => {
    const store = stores[name];
    const source = index ? store.index(index) : store;
    if (direction === 'next') return req(source.getAll(query));
    const out = [];
    const cursorReq = source.openCursor(query, direction);
    await new Promise((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(); return; }
        out.push(cursor.value);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
    return out;
  });
}

/** Get one record; returns null when missing. */
export async function getRecord(name, id) {
  const result = await withStores(name, 'readonly', (stores) => req(stores[name].get(id)));
  return result ?? null;
}

/**
 * Persist storage usage (bytes) when the browser can measure it.
 * @returns {Promise<{usage: number|null, quota: number|null}>}
 */
export async function estimateStorage() {
  if (!navigator.storage?.estimate) return { usage: null, quota: null };
  try {
    const { usage = null, quota = null } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return { usage: null, quota: null };
  }
}

/**
 * Drop all local data. Requires an explicit user confirmation upstream.
 * Export first! This is only reachable from Settings → Account & data.
 */
export async function wipeLocalDatabase() {
  const db = await getDB();
  const storeNames = [...db.objectStoreNames];
  await withStores(storeNames, 'readwrite', async (stores) => {
    await Promise.all(storeNames.map((name) => stores[name].clear()));
  });
  db.close();
  dbPromise = null;
}
