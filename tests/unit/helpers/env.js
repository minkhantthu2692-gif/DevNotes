/**
 * helpers/env.js — Node test environment for browser-targeted modules.
 *
 * Import this BEFORE any module under test:
 *   import './helpers/env.js';
 *
 * - fake-indexeddb provides a real IndexedDB implementation.
 * - The localStorage polyfill mirrors the small subset the app uses
 *   (sync suspension flag, session flag, UI mirror keys).
 */

import 'fake-indexeddb/auto';

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(String(key)); },
    clear: () => { store.clear(); },
  };
}
