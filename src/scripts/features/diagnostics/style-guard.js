/**
 * style-guard.js — detects a page that booted without the design system and
 * offers a one-click recovery.
 *
 * Failure mode this exists for: HTML and JavaScript arrive fine, but no
 * stylesheet applied (a poisoned service-worker cache entry, a proxy serving
 * error pages with status 200, an extension stripping <link> tags). The app
 * then renders as raw, unstyled content — functional but unusable, and
 * invisible to DOM-only smoke tests. The service worker now refuses to cache
 * mismatched responses and revalidates in the background, but that cannot
 * protect against every client-side cause, so the app checks itself once it
 * has booted and tells the user exactly what to do.
 */

import { h } from '../../utils/dom.js';

const CHECK_DELAY_MS = 400;

/**
 * True when the design system clearly did not apply.
 *
 * tokens.css defines --sp-1 on :root and layout.css makes .app-shell a grid;
 * both are unambiguous signals. User preferences can override fonts, sizes,
 * spacing *multiples* and colors, but never the existence of these tokens.
 */
export function stylesMissing(win = window) {
  try {
    const doc = win.document;
    const compute = (el) => win.getComputedStyle(el);
    const root = compute(doc.documentElement);
    const token = root.getPropertyValue('--sp-1').trim();
    const shell = doc.getElementById('app-shell');
    const display = shell ? compute(shell).display : '';
    return token === '' || (shell && !shell.hasAttribute('hidden') && display !== 'grid');
  } catch {
    // getComputedStyle failing entirely also means styling is broken.
    return true;
  }
}

/** Wipe every DevNotes cache + service worker, then reload fresh. */
async function resetShellAndReload(win = window) {
  try {
    if (win.caches?.keys) {
      const keys = await win.caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith('devnotes-'))
        .map((key) => win.caches.delete(key)));
    }
    if (win.navigator?.serviceWorker?.getRegistrations) {
      const registrations = await win.navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((reg) => reg.unregister()));
    }
  } catch {
    // Best effort — the reload below still fetches everything from the network.
  }
  win.location.reload();
}

/**
 * Show a recovery notice. It is styled entirely inline on purpose: when no
 * stylesheet loaded, component classes cannot be trusted to exist.
 */
export function showStyleRecoveryNotice(win = window, doc = win.document) {
  if (doc.getElementById('style-recovery')) return null;

  const resetButton = h('button', {
    type: 'button',
    text: 'Clear cache and reload',
    on: { click: () => { resetButton.disabled = true; resetButton.textContent = 'Reloading…'; void resetShellAndReload(win); } },
    style: {
      padding: '0.4rem 0.9rem',
      background: '#b42318',
      color: '#ffffff',
      border: 'none',
      borderRadius: '0.375rem',
      font: 'inherit',
      fontWeight: '600',
      cursor: 'pointer',
    },
  });

  const notice = h('div', {
    id: 'style-recovery',
    attrs: { role: 'alert' },
    style: {
      position: 'fixed',
      inset: 'auto 1rem 1rem auto',
      maxWidth: '26rem',
      padding: '1rem 1.25rem',
      background: '#ffffff',
      color: '#1a1d26',
      border: '2px solid #b42318',
      borderRadius: '0.5rem',
      boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
      font: '14px/1.5 system-ui, sans-serif',
      zIndex: '2147483000',
    },
  }, [
    h('strong', { text: 'DevNotes is running without its styles', style: { display: 'block', marginBottom: '0.35rem' } }),
    h('p', {
      text: 'The interface looks unstyled because a stylesheet did not load — usually a stale cache, '
        + 'a browser extension, or a proxy that returned an error page in place of the CSS. '
        + 'Your notes are safe in this browser.',
      style: { margin: '0 0 0.75rem' },
    }),
    h('div', { style: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } }, [
      resetButton,
      h('button', {
        type: 'button',
        text: 'Dismiss',
        on: { click: () => notice.remove() },
        style: {
          padding: '0.4rem 0.9rem',
          background: '#ffffff',
          color: '#1a1d26',
          border: '1px solid #c8cdda',
          borderRadius: '0.375rem',
          font: 'inherit',
          cursor: 'pointer',
        },
      }),
    ]),
  ]);

  doc.body.appendChild(notice);
  return notice;
}

/**
 * Schedule the boot check. Call once at the end of boot(); the small delay
 * lets late-loading stylesheets settle before we judge, so a slow connection
 * is not mistaken for a missing one.
 */
export function initStyleGuard(win = window) {
  win.setTimeout(() => {
    if (stylesMissing(win)) showStyleRecoveryNotice(win);
  }, CHECK_DELAY_MS);
}
