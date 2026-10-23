/**
 * bus.js — tiny publish/subscribe used for cross-module notifications
 * (data changed, sync status updated, auth state changed).
 * Deliberately global: it is the only shared mutable coordination point and
 * every module cleans up its own subscriptions.
 */

const listeners = new Map(); // event -> Set<fn>

export const bus = {
  /** @returns {() => void} unsubscribe */
  on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => bus.off(event, handler);
  },

  once(event, handler) {
    const off = bus.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  },

  off(event, handler) {
    listeners.get(event)?.delete(handler);
  },

  emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // One faulty subscriber must not break the rest of the app.
        console.error(`[bus] handler for "${event}" failed:`, err);
      }
    }
  },
};
