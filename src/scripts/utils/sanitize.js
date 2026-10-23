/**
 * sanitize.js — the only place HTML is ever inserted into the document.
 *
 * Rules (see AGENTS.md §7/§20):
 *  - All rendered HTML (Markdown, AI output) passes through DOMPurify.
 *  - Raw HTML in user Markdown is disabled by marked; scripts/event handlers
 *    are stripped even if something slips through.
 *  - `escapeHtml` is the DOM-free fallback used before sanitizing.
 */

import DOMPurifyLib from '../../vendor/dompurify/purify.es.mjs';

// In a browser the library exports a ready instance; in Node (unit tests)
// without a window it exports a factory, so we only build it when possible.
const purify =
  typeof DOMPurifyLib.sanitize === 'function'
    ? DOMPurifyLib
    : typeof window !== 'undefined'
      ? DOMPurifyLib(window)
      : null;

const SANITIZE_CONFIG = {
  // Code-block action buttons are added by our own JS after sanitizing, so
  // no interactive elements from Markdown/AI content are ever allowed.
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover', 'formaction', 'srcdoc'],
  ADD_ATTR: ['target', 'rel', 'data-lang', 'data-action', 'class', 'id'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
};

/** Escape text for safe inclusion in an HTML string (never inserts HTML). */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(text) {
  return escapeHtml(text);
}

/**
 * Sanitize a HTML fragment. Returns safe markup as a string.
 * Only ever called in the browser; in a non-browser environment this throws
 * rather than silently skipping sanitization.
 */
export function sanitizeHtml(html) {
  if (!purify) {
    throw new Error('DOMPurify requires a browser environment');
  }
  return purify.sanitize(String(html ?? ''), SANITIZE_CONFIG);
}

/**
 * Softer sanitizer used only for KaTeX-generated output, which legitimately
 * uses inline `style` attributes. Scripts, event handlers and external
 * resources are still removed.
 */
export function sanitizeMath(html) {
  if (!purify) {
    throw new Error('DOMPurify requires a browser environment');
  }
  return purify.sanitize(String(html ?? ''), {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'a'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'srcdoc'],
    USE_PROFILES: { html: true, mathMl: true },
  });
}

export const sanitizerAvailable = Boolean(purify);
