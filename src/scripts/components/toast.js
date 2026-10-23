/**
 * toast.js — transient notifications + a polite live-region announcer.
 * Toasts are limited (max 4 visible) and never carry actions that could
 * destroy data without confirmation.
 */

import { h, clear } from '../utils/dom.js';

const MAX_VISIBLE = 4;
const DEFAULT_MS = 4200;

let root = null;
let announcer = null;
const active = new Set();

function ensureRoot() {
  if (!root) {
    root = document.getElementById('toast-root');
    if (!root) {
      root = h('div', { id: 'toast-root', class: 'toast-root', attrs: { role: 'region', 'aria-label': 'Notifications' } });
      document.body.appendChild(root);
    }
  }
  return root;
}

/** Persistent sr-only live region for non-visual feedback (copy results…). */
export function announce(message) {
  if (!announcer) {
    announcer = h('div', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
    document.body.appendChild(announcer);
  }
  // Re-set the text so repeated identical messages are announced again.
  announcer.textContent = '';
  requestAnimationFrame(() => { announcer.textContent = String(message ?? ''); });
}

/**
 * Show a toast.
 * @param {string} message
 * @param {{tone?: 'info'|'success'|'warning'|'danger', title?: string,
 *          duration?: number, action?: {label: string, onClick: Function}}} [options]
 * @returns {{dismiss: () => void}}
 */
export function toast(message, options = {}) {
  const { tone = 'info', title = '', duration = DEFAULT_MS, action } = options;
  const host = ensureRoot();

  while (active.size >= MAX_VISIBLE) {
    const oldest = active.values().next().value;
    oldest?.dismiss();
  }

  const node = h('div', {
    class: 'toast',
    dataset: { tone },
    attrs: { role: tone === 'danger' ? 'alert' : 'status' },
  }, [
    h('div', { class: 'toast__content' }, [
      title ? h('div', { class: 'toast__title', text: title }) : null,
      h('div', { class: 'toast__message', text: message }),
      action ? h('button', {
        class: 'toast__action',
        type: 'button',
        text: action.label,
        on: { click: () => { entry.dismiss(); action.onClick?.(); } },
      }) : null,
    ]),
    h('button', {
      class: 'toast__close',
      type: 'button',
      text: '✕',
      attrs: { 'aria-label': 'Dismiss notification' },
      on: { click: () => entry.dismiss() },
    }),
  ]);

  const entry = {
    dismiss() {
      if (!active.has(entry)) return;
      active.delete(entry);
      clearTimeout(timer);
      node.classList.add('toast--leaving');
      setTimeout(() => node.remove(), 160);
    },
  };

  active.add(entry);
  host.appendChild(node);

  const timer = duration > 0 && tone !== 'danger'
    ? setTimeout(() => entry.dismiss(), duration)
    : null;

  return entry;
}

/** Clear all toasts (used when switching accounts / hard resets). */
export function clearToasts() {
  for (const entry of [...active]) entry.dismiss();
  if (root) clear(root);
}
