/**
 * run.mjs — browser smoke test (development-only).
 *
 * Uses playwright-core with a locally installed Chrome or Edge — no browser
 * download is required. Serves the repository over HTTP because ES modules do
 * not load from file://, then walks the core product loop:
 *
 *   boot → dashboard → empty library → create a lesson (autosave + URL swap)
 *   → the lesson appears in the library → survives a reload (IndexedDB)
 *   → settings page renders.
 *
 * Run: npm run test:browser   (exit code 1 on any failure)
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.SMOKE_PORT || 4187);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------ server ---- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ORIGIN);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = path.join(ROOT, path.normalize(pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

/* ---------------------------------------------------------- browser ----- */

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)) || null;
}

/* ------------------------------------------------------------- harness -- */

const results = [];

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.error(`  ✖ ${name}\n      ${String(err?.message || err).split('\n')[0]}`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/* --------------------------------------------------------------- main --- */

async function main() {
  const executablePath = findBrowser();
  if (!executablePath) {
    console.error('No Chrome/Edge found. Set CHROME_PATH to a installed browser and retry.');
    process.exitCode = 1;
    return;
  }
  console.log(`Browser: ${executablePath}`);
  console.log(`Serving: ${ROOT} at ${ORIGIN}\n`);

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
  // The router catches mount errors and renders a fallback, so console.error
  // is where those exceptions surface — capture them for diagnostics.
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const lessonTitle = `Smoke test lesson ${Date.now()}`;

  try {
    await step('boot: app shell becomes visible and boot status hides', async () => {
      await page.goto(`${ORIGIN}/index.html#/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20_000 });
      const bootHidden = await page.waitForFunction(
        () => document.querySelector('#boot-status')?.hasAttribute('hidden')
          || getComputedStyle(document.querySelector('#boot-status') || document.body).display === 'none',
        null,
        { timeout: 10_000 },
      ).then(() => true).catch(() => false);
      assert(bootHidden, '#boot-status never hid — the app failed to finish booting');
    });

    await step('dashboard renders its header', async () => {
      // The dashboard greets by time of day; the route title is the stable signal.
      const heading = page.locator('#app-shell .page-header h1').first();
      await heading.waitFor({ state: 'visible', timeout: 10_000 });
      const title = await page.title();
      assert(title.includes('Dashboard'), `expected the Dashboard document title, got "${title}"`);
      assert((await heading.textContent()).trim().length > 0, 'expected a greeting heading');
    });

    await step('library shows an empty state on a fresh profile', async () => {
      await page.evaluate(() => { location.hash = '#/library'; });
      await page.waitForSelector('#app-shell .page-header h1', { timeout: 10_000 });
      await page.waitForSelector('.empty-state', { timeout: 10_000 });
    });

    await step('editor: new lesson autosaves and swaps the URL to a real id', async () => {
      await page.evaluate(() => { location.hash = '#/lesson/new'; });
      await page.waitForSelector('.editor-title-input', { timeout: 10_000 });

      await page.fill('.editor-title-input', lessonTitle);
      await page.fill('[aria-label="Lesson content (Markdown)"]', '# Heading\n\nSmoke test content with `code`.');

      await page.waitForFunction(() => location.hash.startsWith('#/lesson/') && !location.hash.endsWith('new'), null, { timeout: 15_000 });
      await page.waitForSelector('[data-state="saved"]', { timeout: 15_000 });
    });

    await step('library lists the new lesson', async () => {
      await page.evaluate(() => { location.hash = '#/library'; });
      await page.getByText(lessonTitle, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 });
    });

    await step('persistence: the lesson survives a full reload (IndexedDB)', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20_000 });
      await page.evaluate(() => { location.hash = '#/library'; });
      await page.getByText(lessonTitle, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 });
    });

    await step('settings: page renders with its section layout', async () => {
      await page.evaluate(() => { location.hash = '#/settings'; });
      await page.waitForSelector('.settings-layout', { timeout: 10_000 });
      await page.waitForSelector('.settings-nav__btn[aria-current="true"]', { timeout: 10_000 });
    });

    await step('dialog a11y: keyboard open, Escape closes, focus is restored', async () => {
      await page.evaluate(() => { location.hash = '#/snippets'; });
      const trigger = page.getByRole('button', { name: 'New snippet' }).first();
      await trigger.waitFor({ state: 'visible', timeout: 10_000 });

      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      const modal = await dialog.getAttribute('aria-modal');
      assert(modal === 'true', 'dialog must be marked aria-modal');

      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
      const focusedId = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
      assert(focusedId === 'New snippet', `focus should return to the trigger, got "${focusedId}"`);
    });

    await step('every route mounts a page without runtime errors', async () => {
      const routes = [
        'dashboard', 'library', 'languages', 'categories', 'lesson/new',
        'snippets', 'favorites', 'review', 'assistant', 'activity',
        'trash', 'settings', 'account',
      ];
      for (const route of routes) {
        const before = pageErrors.length;
        const titleBefore = await page.title();
        try {
          // document.title only changes once the new page has mounted (or a
          // fallback rendered), so this can't pass on the previous route's DOM.
          await page.evaluate((hash) => { location.hash = `#/${hash}`; }, route);
          await page.waitForFunction((prevTitle) => {
            const outlet = document.getElementById('page-outlet');
            return Boolean(
              outlet
              && outlet.textContent.trim().length > 0
              && document.title !== prevTitle
            );
          }, titleBefore, { timeout: 10_000 });
        } catch (err) {
          const recent = consoleErrors.slice(-3);
          throw new Error(
            `/${route}: ${String(err?.message || err).split('\n')[0]}`
            + (recent.length ? ` | console: ${recent.join(' || ')}` : ''),
          );
        }
        const newErrors = pageErrors.slice(before);
        assert(newErrors.length === 0, `/${route} raised: ${newErrors.slice(0, 2).join(' | ')}`);
      }
    });

    await step('no uncaught page errors during the run', async () => {
      assert(pageErrors.length === 0, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    });
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} smoke steps passed`);
  if (failed.length) {
    console.error('\nFailures:');
    for (const failure of failed) {
      console.error(`  - ${failure.name}: ${String(failure.error?.stack || failure.error).split('\n').slice(0, 4).join('\n    ')}`);
    }
    process.exitCode = 1;
  }
}

await main();
