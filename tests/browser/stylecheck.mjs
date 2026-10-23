/**
 * stylecheck.mjs — development-only diagnostic: does the design system
 * actually APPLY in a real browser? The smoke test proves the DOM works but
 * never asserts styling; this closes that gap for debugging sessions.
 *
 * Usage:
 *   node tests/browser/stylecheck.mjs                          # local server
 *   SMOKE_ORIGIN=https://user.github.io/DevNotes node tests/browser/stylecheck.mjs
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.SMOKE_PORT || 4188);
const REMOTE = (process.env.SMOKE_ORIGIN || '').replace(/\/+$/, '');
const ORIGIN = REMOTE || `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return BROWSER_CANDIDATES.find((c) => existsSync(c)) || null;
}

async function main() {
  const executablePath = findBrowser();
  if (!executablePath) {
    console.error('No Chrome/Edge found.');
    process.exitCode = 1;
    return;
  }
  console.log(`Browser: ${executablePath}`);
  console.log(`Target: ${ORIGIN}\n`);

  if (!REMOTE) await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const cssResponses = [];
  const failedRequests = [];
  page.on('response', (res) => {
    const url = res.url();
    if (url.endsWith('.css')) cssResponses.push({ url, status: res.status(), type: res.headers()['content-type'] });
  });
  page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), error: req.failure()?.errorText }));

  try {
    await page.goto(`${ORIGIN}/index.html#/settings`, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20_000 });

    console.log('--- CSS responses seen by the browser ---');
    for (const r of cssResponses) console.log(`  ${r.status} ${r.type || '(no type)'} ${r.url}`);

    console.log('\n--- failed requests ---');
    if (!failedRequests.length) console.log('  (none)');
    for (const f of failedRequests) console.log(`  ${f.error} ${f.url}`);

    const probe = await page.evaluate(() => {
      const sheets = [...document.styleSheets].map((s) => {
        let ruleCount = 'inaccessible';
        try { ruleCount = s.cssRules.length; } catch (e) { ruleCount = `ERROR ${e.name}`; }
        return { href: s.href, disabled: s.disabled, ruleCount };
      });
      const root = getComputedStyle(document.documentElement);
      const shell = document.getElementById('app-shell');
      return {
        sheets,
        tokens: root.getPropertyValue('--sp-1').trim() || '(empty)',
        sidebarW: root.getPropertyValue('--sidebar-w').trim() || '(empty)',
        shellDisplay: shell ? getComputedStyle(shell).display : '(no shell)',
        bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 60),
        linkColor: getComputedStyle(document.querySelector('#sidebar a') || document.body).color,
      };
    });

    console.log('\n--- stylesheets in the page ---');
    for (const s of probe.sheets) console.log(`  rules=${s.ruleCount} disabled=${s.disabled} ${s.href}`);

    console.log('\n--- computed-style probes ---');
    console.log(`  --sp-1            = ${probe.tokens}    (expect "0.25rem")`);
    console.log(`  --sidebar-w       = ${probe.sidebarW}    (expect "15.5rem")`);
    console.log(`  #app-shell display= ${probe.shellDisplay}    (expect "grid")`);
    console.log(`  body font-family  = ${probe.bodyFont}`);
    console.log(`  first link color  = ${probe.linkColor}  (non-default if themes.css applied)`);
  } finally {
    await browser.close().catch(() => {});
    if (server.listening) await new Promise((r) => server.close(r));
  }
}

await main();
