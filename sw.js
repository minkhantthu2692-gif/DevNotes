/**
 * sw.js — application-shell service worker (AGENTS.md §16).
 *
 * Strategy:
 *  - Precaches the static shell (HTML, CSS, fonts stylesheet, icons) on
 *    install. Each entry is validated before it is stored, and install ABORTS
 *    (keeping the previous worker) rather than activate with a bad shell: a
 *    proxy/VPN/captive portal answering a CSS/JS URL with an error page or an
 *    empty body must never be persisted, or cache-first would serve it on
 *    every future load (that failure mode shipped unstyled pages once).
 *  - Navigation requests: network-first with a cached index.html fallback, so
 *    deep links keep working offline (hash routing, but the server may still
 *    receive path-style requests from older links).
 *  - Other same-origin GETs: stale-while-revalidate. The cached copy answers
 *    instantly and a background fetch converges the cache to the server, so a
 *    bad entry can never outlive one successful reload. JavaScript modules and
 *    bundled fonts are picked up on first use and then served instantly
 *    offline.
 *  - Cross-origin requests (Supabase, Groq) are NEVER cached: they carry
 *    authenticated/user data and must not survive in a shared cache.
 *
 * Bumping CACHE invalidates old caches on activate. Keep the SHELL list in
 * sync with index.html when adding root-level assets.
 */

const CACHE = 'devnotes-shell-v6';

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
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      // cache: 'reload' bypasses the HTTP cache so a stale 600s entry cannot
      // decide what the shell precache contains.
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!isCacheable(new Request(url), response)) {
        throw new Error(
          `install aborted: ${url} returned ${response.status} `
          + `${response.headers.get('content-type') || 'no content-type'}`,
        );
      }
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
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

/**
 * Content types we are willing to persist, keyed by extension. A response
 * whose type does not match its URL is a proxy/portal error page, not an
 * asset — caching it would break the app on every future load.
 */
const EXPECTED_TYPES = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.html': 'text/html',
};

function expectedTypeFor(url) {
  const dot = url.pathname.lastIndexOf('.');
  if (dot === -1) return null;
  return EXPECTED_TYPES[url.pathname.slice(dot).toLowerCase()] || null;
}

function isCacheable(request, response) {
  // Only plain, successful, same-origin responses; never partial or opaque.
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  // An empty body would poison the cache just as badly as a wrong one.
  if (response.headers.get('content-length') === '0') return false;
  const expected = expectedTypeFor(new URL(request.url));
  if (expected) {
    const actual = (response.headers.get('content-type') || '').toLowerCase();
    if (!actual.startsWith(expected)) return false;
  }
  return true;
}

/**
 * Stale-while-revalidate: the cached copy answers instantly and a background
 * fetch converges the cache to the server, so a bad entry heals on the next
 * successful reload instead of surviving until a CACHE bump.
 */
async function cacheFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);

  const refresh = fetch(request).then((response) => {
    if (isCacheable(request, response)) {
      cache.put(request, response.clone());
    }
    return response;
  });

  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}

async function networkFirstShell(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(request, response)) cache.put('./index.html', response.clone());
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
    event.respondWith(networkFirstShell(event));
    return;
  }
  event.respondWith(cacheFirst(event));
});
