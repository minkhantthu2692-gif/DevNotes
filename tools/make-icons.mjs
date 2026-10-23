#!/usr/bin/env node
// Generates the PWA PNG icons referenced by manifest.webmanifest from src/assets/icons/icon.svg:
//   icon-192.png, icon-512.png (plain) and maskable-512.png (Android maskable, 60% safe-zone glyph).
//
// Rendering uses playwright-core with an explicitly resolved system browser (Chrome, then Edge)
// so no browser download is required. Re-runnable: it overwrites the three PNGs in place.
// Exits non-zero and prints the reason if anything fails; always closes the browser.

import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_DIR = path.join(ROOT, 'src', 'assets', 'icons');
const SVG_PATH = path.join(ICONS_DIR, 'icon.svg');

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

// Android maskable safe zone: the foreground must stay within ~60% of the icon width,
// otherwise launchers crop it when applying the adaptive-icon mask.
const MASKABLE_PX = 307; // 60% of 512

async function resolveBrowserExecutable() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`No supported browser found. Looked for: ${BROWSER_CANDIDATES.join(', ')}`);
}

// The SVG's own background rect fill doubles as the page/canvas background so the icon
// never renders on transparent white (which shows up as white halos in the PNG corners).
function extractBackgroundFill(svgSource) {
  const match = svgSource.match(/<rect[^>]*\bfill="([^"]+)"/i);
  return match ? match[1] : '#5b6cff';
}

async function renderPlainIcon(browser, svgUrl, size, outFile, background) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  try {
    // Load the SVG itself via file://, sized exactly to the target viewport.
    await page.goto(svgUrl, { waitUntil: 'load' });
    await page.evaluate((bg) => {
      const svg = document.documentElement;
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.style.display = 'block';
      svg.style.margin = '0';
      svg.style.background = bg;
      // Guarantee edge-to-edge coverage: paint a full-bleed backing rect behind the
      // rounded artwork so the corner pixels use the brand color, not white/transparent.
      const ns = 'http://www.w3.org/2000/svg';
      const backing = document.createElementNS(ns, 'rect');
      backing.setAttribute('width', '512');
      backing.setAttribute('height', '512');
      backing.setAttribute('fill', bg);
      svg.insertBefore(backing, svg.firstChild);
    }, background);
    await page.screenshot({ path: outFile, type: 'png' });
  } finally {
    await page.close();
  }
}

async function renderMaskableIcon(browser, svgSource, background, outFile) {
  // Full-bleed brand-color background with the glyph centered at ~60% of the canvas.
  // The markup is inlined, so the data: URL needs no external resources.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>maskable</title><style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: ${background}; }
  body { display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .glyph { width: ${MASKABLE_PX}px; height: ${MASKABLE_PX}px; }
  .glyph svg { display: block; width: 100%; height: 100%; }
</style></head>
<body><div class="glyph">${svgSource}</div></body></html>`;

  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
  });
  try {
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html), { waitUntil: 'load' });
    await page.screenshot({ path: outFile, type: 'png' });
  } finally {
    await page.close();
  }
}

async function main() {
  const executablePath = await resolveBrowserExecutable();
  console.log(`Using browser: ${executablePath}`);

  const svgSource = await readFile(SVG_PATH, 'utf8');
  const background = extractBackgroundFill(svgSource);
  console.log(`Background color from icon.svg: ${background}`);

  await mkdir(ICONS_DIR, { recursive: true });

  const outputs = [];
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const svgUrl = pathToFileURL(SVG_PATH).href;

    for (const size of [192, 512]) {
      const outFile = path.join(ICONS_DIR, `icon-${size}.png`);
      await renderPlainIcon(browser, svgUrl, size, outFile, background);
      outputs.push(outFile);
    }

    const maskableOut = path.join(ICONS_DIR, 'maskable-512.png');
    await renderMaskableIcon(browser, svgSource, background, maskableOut);
    outputs.push(maskableOut);
  } finally {
    if (browser) await browser.close();
  }

  console.log('Wrote:');
  for (const file of outputs) {
    const { size } = await stat(file);
    console.log(`  ${path.relative(ROOT, file).replace(/\\/g, '/')}  ${size} bytes`);
    if (size <= 2048) {
      throw new Error(`${file} is only ${size} bytes — render likely failed`);
    }
  }
}

main().catch((err) => {
  console.error('make-icons failed:', err?.stack || err);
  process.exitCode = 1;
});
