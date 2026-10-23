/**
 * router.js — hash-based client-side router.
 *
 * Hash routing is deliberate: it works on any static host without server
 * rewrite rules and degrades gracefully when the file is opened directly.
 *
 * Page contract:
 *   export default {
 *     id, title(params), breadcrumbs?(params) → [{label, path}],
 *     mount(container, ctx) → { destroy?(), beforeLeave?() → Promise,
 *                               onShow?(), onQuery?(query) }
 *   }
 * `onQuery` is called instead of a remount when only the query string changes
 * on the same route (so filters never lose DOM focus).
 * ctx = { params, query, navigate }
 */

import { routeStore, uiStore } from './state.js';
import { PAGE_LOADERS, NAV_ITEMS } from './navigation.js';
import { STORAGE_KEYS } from './config.js';
import { bus } from './utils/bus.js';

const scrollPositions = new Map(); // path → scrollY (session memory)
let current = null;                // {controller, path}
let navigationToken = 0;
let outlet = null;

/** Resolve a hash path to a page id + params. */
function matchRoute(path) {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return { pageId: 'dashboard', params: {} };

  const [head, a] = segments;
  switch (head) {
    case 'dashboard': return { pageId: 'dashboard', params: {} };
    case 'library': return { pageId: 'library', params: {} };
    case 'languages': return { pageId: 'languages', params: {} };
    case 'categories': return { pageId: 'categories', params: {} };
    case 'snippets': return { pageId: 'snippets', params: {} };
    case 'favorites': return { pageId: 'favorites', params: {} };
    case 'review': return { pageId: 'review', params: {} };
    case 'assistant': return { pageId: 'assistant', params: {} };
    case 'activity': return { pageId: 'activity', params: {} };
    case 'trash': return { pageId: 'trash', params: {} };
    case 'settings': return { pageId: 'settings', params: {} };
    case 'account': return { pageId: 'account', params: {} };
    case 'lesson':
      if (a && a !== 'new') return { pageId: 'editor', params: { id: decodeURIComponent(a) } };
      if (a === 'new') return { pageId: 'editor', params: { id: 'new' } };
      return { pageId: 'notFound', params: { path } };
    default:
      return { pageId: 'notFound', params: { path } };
  }
}

/** Parse '/library?lang=js' into {path, query}. */
export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  return { path: pathPart.startsWith('/') ? pathPart : `/${pathPart}`, query };
}

export function currentPath() {
  return parseHash().path;
}

/** Navigate to a path; `replace` avoids a history entry. */
export function navigate(to, { replace = false } = {}) {
  const target = to.startsWith('/') ? to : `/${to}`;
  const next = `#${target}`;
  if (location.hash === next) { void handleRoute(); return; }
  if (replace) {
    history.replaceState(null, '', next);
    void handleRoute();
  } else {
    location.hash = target;
  }
}

/** Update only the query string of the current page (filters, sorting). */
export function setQuery(patch, { replace = true } = {}) {
  const { path, query } = parseHash();
  const params = new URLSearchParams();
  const merged = { ...query, ...patch };
  for (const [key, value] of Object.entries(merged)) {
    if (value === '' || value === null || value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  const target = `${path}${qs ? `?${qs}` : ''}`;
  // Nothing to change: navigate() on the current URL would re-enter
  // handleRoute(). If a page does this during its own mount (normalizing its
  // section/query), that re-entry supersedes the in-flight mount, which
  // re-enters again — an endless remount loop where no page ever finishes
  // starting (title/breadcrumbs/current never get set). A no-op is the
  // correct answer whenever the rebuilt URL equals the current one.
  if (`#${target}` === location.hash) return;
  navigate(target, { replace });
}

async function handleRoute() {
  const token = ++navigationToken;
  const { path, query } = parseHash();
  const { pageId, params } = matchRoute(path);

  // Query-only change on the same page (filter/search state): update in place
  // instead of destroying the page — otherwise typing in a search box would
  // remount the DOM and steal focus. Pages opt in via `onQuery`; without it we
  // fall through to a full remount (the safe default).
  if (
    current &&
    current.pageId === pageId &&
    current.path === path &&
    JSON.stringify(current.params) === JSON.stringify(params) &&
    typeof current.controller.onQuery === 'function'
  ) {
    routeStore.set({ path, params, query, pageId });
    try {
      localStorage.setItem(STORAGE_KEYS.lastRoute, `${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`);
    } catch { /* private mode */ }
    current.controller.onQuery(query);
    return;
  }

  // Allow the outgoing page to flush pending work (e.g. editor autosave).
  if (current?.controller?.beforeLeave) {
    try {
      await current.controller.beforeLeave();
    } catch (err) {
      console.warn('[router] beforeLeave failed:', err);
    }
  }
  if (token !== navigationToken) return;

  if (current) {
    scrollPositions.set(current.path, window.scrollY);
    try { current.controller?.destroy?.(); } catch (err) { console.error('[router] destroy failed:', err); }
    current = null;
  }

  bus.emit('navigation:start', { path, pageId });

  try {
    const loader = PAGE_LOADERS[pageId] || PAGE_LOADERS.notFound;
    const module = await loader();
    if (token !== navigationToken) return; // a newer navigation superseded us

    const page = module.default || module.page;
    if (!outlet) throw new Error('Router outlet is not mounted');

    outlet.replaceChildren();
    // Title before the async mount: assigning it synchronously here means it
    // always belongs to the newest token that passed the guard above (no
    // interleaving is possible before mount's first await), so a slow or
    // failing mount can never leave the tab showing the previous page's title.
    const title = typeof page.title === 'function' ? page.title(params) : (page.title || 'DevNotes');
    document.title = `${title} · DevNotes`;
    const ctx = {
      params,
      query,
      navigate,
      setQuery,
      /** Pages push [{label, path}] to render in the topbar. */
      setBreadcrumbs: (items) => bus.emit('breadcrumbs', Array.isArray(items) ? items : []),
    };
    const controller = await page.mount(outlet, ctx);
    if (token !== navigationToken) {
      try { controller?.destroy?.(); } catch { /* superseded page cleanup */ }
      return;
    }

    current = { controller, path, pageId };

    routeStore.set({ path, params, query, pageId });
    uiStore.set({ navOpen: false });

    try {
      localStorage.setItem(STORAGE_KEYS.lastRoute, `${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`);
    } catch { /* private mode */ }

    // Restore remembered scroll only when returning to the same path.
    const saved = scrollPositions.get(path);
    window.scrollTo({ top: typeof saved === 'number' ? saved : 0, behavior: 'instant' in window ? 'instant' : 'auto' });

    controller?.onShow?.();
    // Move focus to main content for screen-reader/keyboard continuity
    // only for user-initiated navigations (not the very first load).
    if (navigationToken > 1) {
      document.getElementById('main-content')?.focus({ preventScroll: true });
    }
  } catch (err) {
    console.error('[router] failed to load page:', err);
    if (token !== navigationToken) return;
    outlet.replaceChildren();
    const fallback = document.createElement('div');
    fallback.className = 'error-state';
    fallback.setAttribute('role', 'alert');
    const titleEl = document.createElement('div');
    titleEl.className = 'error-state__title';
    titleEl.textContent = 'This page failed to load';
    const msgEl = document.createElement('div');
    msgEl.textContent = String(err?.message || err);
    fallback.append(titleEl, msgEl);
    outlet.appendChild(fallback);
  }
}

/** Boot the router. Returns the outlet element. */
export function startRouter(outletEl) {
  outlet = outletEl;

  window.addEventListener('hashchange', () => void handleRoute());

  // First load: honor the remembered destination when no explicit hash exists.
  if (!location.hash) {
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEYS.lastRoute); } catch { /* ignore */ }
    if (saved && matchRoute(parseHash(`#${saved}`).path).pageId !== 'notFound') {
      history.replaceState(null, '', `#${saved}`);
    } else {
      history.replaceState(null, '', '#/dashboard');
    }
  }

  void handleRoute();
  return outlet;
}

/** Used by the command palette to know which nav item is active. */
export function isActivePath(path) {
  const currentPath = routeStore.get().path;
  if (path === '/library') return currentPath === '/library' || currentPath.startsWith('/lesson');
  return currentPath === path;
}

export { NAV_ITEMS };
