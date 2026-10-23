/**
 * iconaudit.mjs — development-only diagnostic: measures the rendered size of
 * every .icon span / svg on a page. Icons that lose their size constraint
 * render at the browser default for SVGs (300x150) and overlap the layout.
 *
 * Usage:
 *   node tests/browser/iconaudit.mjs                          # local
 *   SMOKE_ORIGIN=https://user.github.io/DevNotes node tests/browser/iconaudit.mjs
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.SMOKE_PORT || 4189);
const REMOTE = (process.env.SMOKE_ORIGIN || '').replace(/\/+$/, '');
const ORIGIN = REMOTE || `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ORIGIN);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = path.join(ROOT, path.normalize(pathname));
    if (!filePath.startsWith(ROOT)) return res.writeHead(403).end('forbidden');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

async function main() {
  const executablePath = (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH))
    ? process.env.CHROME_PATH
    : CANDIDATES.find((c) => existsSync(c));
  if (!executablePath) { console.error('No Chrome/Edge found.'); process.exitCode = 1; return; }
  console.log(`Target: ${ORIGIN}\n`);

  if (!REMOTE) await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const [vw, vh] = (process.env.AUDIT_VIEWPORT || '1280x720').split('x').map(Number);
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await context.newPage();
  // AUDIT_THEME only works with the default 'system' theme (a fresh profile
  // has no IndexedDB prefs, so the app resolves theme via prefers-color-scheme).
  if (process.env.AUDIT_THEME) await page.emulateMedia({ colorScheme: process.env.AUDIT_THEME });

  try {
    for (const route of ['dashboard', 'settings', 'library', 'assistant', 'account']) {
      await page.goto(`${ORIGIN}/index.html#/${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(600);

      const shot = path.join(ROOT, 'tests', 'artifacts', `iconaudit-${route}.png`);
      await page.screenshot({ path: shot }).catch(() => {});

      if (route === 'settings') {
        const sb = await page.evaluate(() => {
          const read = (el) => (el ? {
            scrollbarColor: getComputedStyle(el).scrollbarColor,
            webkitWidth: getComputedStyle(el, '::-webkit-scrollbar').width,
            thumbBg: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
            thumbRadius: getComputedStyle(el, '::-webkit-scrollbar-thumb').borderRadius,
            overflowing: el.scrollHeight > el.clientHeight,
          } : null);
          return { html: read(document.documentElement), sidebar: read(document.querySelector('.sidebar__inner')) };
        });
        console.log(`--- scrollbar probe: ${JSON.stringify(sb)}`);
      }

      const rows = await page.evaluate(() => {
        const out = [];
        for (const span of document.querySelectorAll('.icon')) {
          const svg = span.querySelector('svg');
          if (!svg) continue;
          const sb = span.getBoundingClientRect();
          const vb = svg.getBoundingClientRect();
          // Flag anything whose box exceeds a sane icon size.
          if (sb.width > 48 || sb.height > 48 || vb.width > 48 || vb.height > 48) {
            const parent = span.parentElement;
            out.push({
              span: `${Math.round(sb.width)}x${Math.round(sb.height)}`,
              svg: `${Math.round(vb.width)}x${Math.round(vb.height)}`,
              cls: span.className,
              parent: parent ? `${parent.tagName.toLowerCase()}.${parent.className}` : '',
            });
          }
        }
        return out;
      });
      if (rows.length) {
        console.log(`--- ${route}: ${rows.length} oversized icon(s) ---`);
        for (const r of rows.slice(0, 12)) console.log(`  span=${r.span} svg=${r.svg}  .${r.cls}  in <${r.parent}>`);
      } else {
        console.log(`--- ${route}: all icons sized sanely ---`);
      }    }
  } finally {
    await browser.close().catch(() => {});
    if (server.listening) await new Promise((r) => server.close(r));
  }
}

await main();
