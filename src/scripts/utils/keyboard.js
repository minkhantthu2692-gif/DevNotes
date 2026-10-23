/**
 * keyboard.js — global shortcut registry.
 * One document-level listener dispatches to the most recently registered
 * matching handler, so page-scoped shortcuts can be cleaned up on exit.
 */

const handlers = new Set();

// Browser-only module: tolerate import in non-DOM test environments.
const doc = typeof document !== 'undefined' ? document : null;

function normalize(mods, key) {
  return `${mods.map((m) => m.toLowerCase()).sort().join('+')}+${key.toLowerCase()}`;
}

function eventCombo(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('ctrl');
  if (event.metaKey) mods.push('meta');
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  return normalize(mods, event.key);
}

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

doc?.addEventListener(
  'keydown',
  (event) => {
    if (handlers.size === 0) return;
    const combo = eventCombo(event);
    // Iterate newest-first so a page shortcut wins over a background one.
    const sorted = [...handlers].reverse();
    for (const entry of sorted) {
      if (entry.combo !== combo) continue;
      if (entry.allowInInput !== true && isEditableTarget(event.target)) continue;
      const prevented = entry.handler(event);
      if (prevented !== false) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
  },
  { capture: true },
);

/**
 * Register a shortcut.
 * @param {string} combo e.g. 'ctrl+k', 'ctrl+shift+n', 'mod+s'
 * @param {Function} handler return false to let the event continue
 * @param {{allowInInput?: boolean, description?: string}} [options]
 * @returns {() => void} unregister
 */
export function shortcut(combo, handler, options = {}) {
  const normalized = normalize(
    combo.replace('mod', /mac|iphone|ipad/i.test(navigator.platform) ? 'meta' : 'ctrl').split('+').slice(0, -1),
    combo.split('+').pop(),
  );
  const entry = { combo: normalized, handler, ...options };
  handlers.add(entry);
  return () => handlers.delete(entry);
}

/** Human-readable combo for tooltips ("Ctrl + S"). */
export function shortcutLabel(combo) {
  const isMac = /mac|iphone|ipad/i.test(navigator.platform);
  return combo
    .replace('mod', isMac ? '⌘' : 'Ctrl')
    .replace('ctrl', isMac ? '⌃' : 'Ctrl')
    .replace('meta', isMac ? '⌘' : 'Win')
    .replace('shift', isMac ? '⇧' : 'Shift')
    .replace('alt', isMac ? '⌥' : 'Alt')
    .split('+')
    .map((part) => (part.length === 1 ? part.toUpperCase() : part))
    .join(isMac ? '' : ' + ');
}

export { isEditableTarget };
