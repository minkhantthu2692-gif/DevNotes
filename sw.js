/**
 * sw.js — application-shell service worker (AGENTS.md §16).
 *
 * Strategy:
 *  - Precaches the static shell (HTML, CSS, fonts stylesheet, icons) on install.
 *  - Navigation requests: network-first with a cached index.html fallback, so
 *    deep links keep working offline (hash routing, but the server may still
 *    receive path-style requests from older links).
 *  - Other same-origin GETs: cache-first with background refresh. JavaScript
 *    modules and bundled fonts are picked up on first use and then served
 *    instantly offline.
 *  - Cross-origin requests (Supabase, Groq) are NEVER cached: they carry
 *    authenticated/user data and must not survive in a shared cache.
 *
 * Bumping CACHE invalidates old caches on activate. Keep the SHELL list in
 * sync with index.html when adding root-level assets.
 */

const CACHE = 'devnotes-shell-v2';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles/tokens.css',
  './src/styles/themes.css',
  './src/styles/typography.css',
  './src/styles/hljs.css',
  './src/styles/markdown.css',
  './src/styles/layout.css',
  './src/styles/components.css',
  './src/styles/pages.css',
  './src/styles/utilities.css',
  './src/fonts/fonts.css',
  './src/assets/icons/icon-192.png',
  './src/assets/icons/icon-512.png',
  './src/assets/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('devnotes-') && key !== CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

function isCacheable(response) {
  // Only basic, successful same-origin responses; never partial or opaque.
  return response && response.ok && response.type === 'basic';
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstShell(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) cache.put('./index.html', response.clone());
    return response;
  } catch {
    const shell = (await cache.match(request)) || (await cache.match('./index.html'));
    if (shell) return shell;
    return new Response('Offline — this page has not been cached yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only: cross-origin (Supabase/Groq) responses are never cached.
  if (url.origin !== self.location.origin) return;
  // Auth endpoints are dynamic and session-specific.
  if (url.pathname.startsWith('/auth/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});
