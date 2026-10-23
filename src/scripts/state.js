/**
 * state.js — small observable stores for cross-cutting UI state.
 * Deliberately minimal: page data lives in IndexedDB (via repositories) and
 * is re-queried on demand; these stores hold only session state.
 */

export function createStore(initial) {
  let state = { ...initial };
  const subscribers = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of [...subscribers]) fn(state);
    },
    /** @returns {() => void} unsubscribe */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

/** Current route: {path, params, query, pageId}. */
export const routeStore = createStore({ path: '/', params: {}, query: {}, pageId: null });

/**
 * Synchronization state surfaced in the topbar/settings:
 *  state: 'disabled' | 'offline' | 'idle' | 'pending' | 'syncing' | 'error'
 *  (disabled = Supabase not configured or not signed in)
 */
export const syncStore = createStore({
  state: 'disabled',
  lastSyncAt: null,
  pending: 0,
  failed: 0,
  message: '',
  conflicts: 0,
});

/** Auth session state. */
export const authStore = createStore({
  status: 'loading', // loading | signed-out | signed-in
  user: null,
  error: null,
});

/** Ephemeral shell state (mobile drawer, palette open…). */
export const uiStore = createStore({
  navOpen: false,
  paletteOpen: false,
  editorFullscreen: false,
});

/** Global busy/error overlay used during boot and database failures. */
export const bootStore = createStore({ status: 'loading', message: '', error: null });
