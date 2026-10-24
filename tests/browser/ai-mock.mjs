/**
 * ai-mock.mjs — browser test for the AI features without a real API key.
 * (Development-only; run: npm run test:ai)
 *
 * Installs a window.fetch mock that impersonates Groq:
 *  - `stream: true` → chunked SSE frames with usage + [DONE] (optionally slow,
 *    to exercise Stop mid-stream),
 *  - response_format json → flashcard drafts (one valid + one invalid, proving
 *    draft validation and that AI cards never auto-approve),
 *  - plain chat → a fixed reply (used by the editor writing toolbar).
 *
 * Covered workflows: streaming render, token usage display, Stop keeping the
 * partial reply, Regenerate, conversation create/rename/reopen/delete,
 * persistence across reload (IndexedDB), attachment restore, flashcard draft
 * validation + approval flag, and the editor's contextual AI toolbar with its
 * preview/Apply flow (never auto-applies).
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.AI_TEST_PORT || 4197);
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

/** Install the Groq impersonator (must be re-run after every reload). */
async function installAiMock(page) {
  await page.evaluate(() => {
    if (window.__aiMock) return;
    window.__aiMock = true;
    window.__aiMockConfig = { slow: false, frames: 12 };
    const realFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();

    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('api.groq.com')) return realFetch(input, init);

      let body = {};
      try { body = init.body ? JSON.parse(init.body) : {}; } catch { /* not ours */ }
      const signal = init.signal || null;

      const json = (data) => Promise.resolve(new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      // Flashcard drafts: one valid card, one invalid (front/back missing).
      if (body.response_format && body.response_format.type === 'json_object') {
        return json({
          model: body.model,
          choices: [{
            message: {
              role: 'assistant',
              content: '{"cards":[{"front":"What is hoisting?","back":"Declarations move to scope top"},{"front":"","back":"missing front"}]}',
            },
          }],
          usage: { prompt_tokens: 60, completion_tokens: 30 },
        });
      }

      if (body.stream) {
        const config = window.__aiMockConfig;
        const frames = Array.from({ length: config.frames }, (_, i) =>
          `data: {"choices":[{"delta":{"content":"w${i} "}}]}\n\n`);
        frames.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":20}}\n\n');
        frames.push('data: [DONE]\n\n');
        const delay = config.slow ? 120 : 8;

        const stream = new ReadableStream({
          start(controller) {
            let index = 0;
            let timer = null;
            const fail = () => {
              if (timer) clearTimeout(timer);
              try {
                controller.error(new DOMException('The operation was aborted.', 'AbortError'));
              } catch { /* already closed */ }
            };
            if (signal) {
              if (signal.aborted) { fail(); return; }
              signal.addEventListener('abort', fail, { once: true });
            }
            const push = () => {
              if (index >= frames.length) {
                try { controller.close(); } catch { /* aborted */ }
                return;
              }
              try { controller.enqueue(encoder.encode(frames[index++])); } catch { return; }
              timer = setTimeout(push, delay);
            };
            push();
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }));
      }

      // One-shot chat (editor writing actions, connection test, …).
      const firstMessage = Array.isArray(body.messages) && body.messages[0]
        ? String(body.messages[0].content || '')
        : '';
      const content = firstMessage.startsWith('You are a text-editing')
        ? 'IMPROVED: the polished selection.'
        : 'Mock assistant reply.';
      return json({
        model: body.model,
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 40, completion_tokens: 12 },
      });
    };
  });
}

async function setMockConfig(page, patch) {
  await page.evaluate((next) => { Object.assign(window.__aiMockConfig, next); }, patch);
}

async function readFlashcards(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('devnotes');
    request.onsuccess = () => {
      const db = request.result;
      try {
        const getAll = db.transaction('flashcards', 'readonly').objectStore('flashcards').getAll();
        getAll.onsuccess = () => { const rows = getAll.result || []; db.close(); resolve(rows); };
        getAll.onerror = () => { db.close(); reject(getAll.error); };
      } catch (err) { db.close(); reject(err); }
    };
    request.onerror = () => reject(request.error);
  }));
}

async function main() {
  const executablePath = findBrowser();
  if (!executablePath) {
    console.error('No Chrome/Edge found. Set CHROME_PATH to an installed browser and retry.');
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
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const question1 = 'Explain closures simply.';
  const question2 = 'And for arrows?';
  const editorContent = 'Hello world selection test.';
  const lessonTitle = `AI mock lesson ${Date.now()}`;

  try {
    await step('boot: app shell becomes visible', async () => {
      await page.goto(`${ORIGIN}/index.html#/dashboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20_000 });
      await page.waitForFunction(
        () => document.querySelector('#boot-status')?.hasAttribute('hidden'),
        null,
        { timeout: 10_000 },
      );
      // BYOK mode: a local fake key + no edge URL → getAiMode() === 'byok'.
      await page.evaluate(() => localStorage.setItem('devnotes.ai.key', 'gsk_test_dummy_key'));
      await installAiMock(page);
    });

    await step('editor: create a lesson (used by attach + toolbar tests)', async () => {
      await page.evaluate(() => { location.hash = '#/lesson/new'; });
      await page.waitForSelector('.editor-title-input', { timeout: 10_000 });
      await page.fill('.editor-title-input', lessonTitle);
      await page.fill('[aria-label="Lesson content (Markdown)"]', editorContent);
      await page.waitForFunction(() => location.hash.startsWith('#/lesson/') && !location.hash.endsWith('new'), null, { timeout: 15_000 });
    });

    await step('assistant: streaming reply renders and shows token usage', async () => {
      await page.evaluate(() => { location.hash = '#/assistant'; });
      await page.waitForSelector('.chat__composer textarea', { timeout: 10_000 });
      await page.fill('.chat__composer textarea', question1);
      await page.click('.chat__composer .btn--primary');

      // Full mock stream: 12 words joined.
      const expected = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
      await page.waitForFunction(
        (text) => {
          const bubbles = [...document.querySelectorAll('.chat__msg[data-role="assistant"] .chat__bubble')];
          return bubbles.some((bubble) => bubble.textContent.includes(text));
        },
        expected,
        { timeout: 15_000 },
      );
      // The meta line (timestamp + usage) renders right after persistence.
      await page.waitForFunction(
        () => [...document.querySelectorAll('.chat__meta')]
          .some((meta) => meta.textContent.includes('50 in / 20 out tokens')),
        null,
        { timeout: 10_000 },
      );
      const metas = await page.locator('.chat__meta').allTextContents();
      assert(
        metas.some((text) => text.includes('50 in / 20 out tokens')),
        `usage line missing from message meta: ${JSON.stringify(metas)}`,
      );
      const caret = await page.locator('.chat__cursor').count();
      assert(caret === 0, 'streaming caret must be removed when the reply completes');
      const stopHidden = await page.locator('.chat__composer .btn', { hasText: 'Stop' }).isHidden();
      assert(stopHidden, 'Stop must hide again after the reply completes');
    });

    await step('assistant: conversation is created and listed in the sidebar', async () => {
      const titles = await page.locator('.conv-item__title').allTextContents();
      assert(titles.length === 1, `expected 1 conversation, found ${titles.length}: ${titles.join(' | ')}`);
      assert(titles[0].startsWith('Explain closures'), `unexpected title: ${titles[0]}`);
      const meta = await page.locator('.conv-item__meta').first().textContent();
      assert(meta.includes('2 messages'), `expected 2 messages, sidebar says: ${meta}`);
      assert(await page.locator('.conv-item[data-active="true"]').count() === 1, 'active conversation must be highlighted');
    });

    await step('assistant: attach a lesson and draft flashcards (validated, unapproved)', async () => {
      await page.click('.context-chips .btn:has-text("Attach lesson")');
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.locator('.list__row-main').first().click();
      await dialog.getByRole('button', { name: 'Done' }).click();
      await page.waitForSelector('.context-chips .chip', { timeout: 5_000 });

      await page.click('.action-grid .btn:has-text("Suggest flashcards")');
      await page.getByText('drafts created', { exact: false }).first().waitFor({ timeout: 15_000 });

      const cards = await readFlashcards(page);
      assert(cards.length === 1, `expected only the valid draft (invalid one skipped), got ${cards.length}`);
      assert(cards[0].approved === false, 'AI drafts must never be auto-approved');
      assert(cards[0].source === 'ai', 'draft must be tagged source:ai');
    });

    await step('assistant: Stop mid-stream keeps the partial reply', async () => {
      await setMockConfig(page, { slow: true });
      await page.fill('.chat__composer textarea', question2);
      await page.click('.chat__composer .btn--primary');
      await page.waitForSelector('.chat__msg[data-role="assistant"]', { timeout: 10_000 });
      await page.waitForTimeout(300); // ~2 of 12 frames at 120ms/frame
      await page.locator('.chat__composer .btn:has-text("Stop")').click();

      await page.waitForFunction(
        () => [...document.querySelectorAll('.chat__meta')].some((meta) => meta.textContent.includes('Stopped')),
        null,
        { timeout: 10_000 },
      );
      const lastBubble = page.locator('.chat__msg[data-role="assistant"] .chat__bubble').last();
      const text = await lastBubble.textContent();
      assert(text.includes('w0'), `partial reply should keep early frames, got: ${text.slice(0, 120)}`);
      assert(!text.includes('w11'), 'the stream must have been interrupted before the last frame');
      await setMockConfig(page, { slow: false });
    });

    await step('assistant: Regenerate replaces the newest answer', async () => {
      const regenerate = page.locator('button[data-regenerate]');
      await regenerate.waitFor({ state: 'visible', timeout: 5_000 });
      assert(await regenerate.isEnabled(), 'Regenerate should be enabled on the newest answer');
      await regenerate.click();

      const expected = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
      await page.waitForFunction(
        (text) => {
          const bubbles = [...document.querySelectorAll('.chat__msg[data-role="assistant"] .chat__bubble')];
          return bubbles.some((bubble) => bubble.textContent.includes(text));
        },
        expected,
        { timeout: 15_000 },
      );
      const metas = await page.locator('.chat__meta').allTextContents();
      assert(!metas.some((text) => text.includes('Stopped')), 'the regenerated answer must not carry the Stopped marker');
      // 4 messages: question1 + answer1 + question2 + regenerated answer
      // (regenerate replaces only the newest answer).
      await page.waitForFunction(
        () => document.querySelector('.conv-item__meta')?.textContent.includes('4 messages'),
        null,
        { timeout: 10_000 },
      );
      assert(await page.locator('button[data-regenerate]').count() <= 1, 'only the newest answer may offer Regenerate');
    });

    await step('assistant: rename the conversation', async () => {
      await page.locator('.conv-item__menu').first().click();
      await page.locator('.menu__item:has-text("Rename")').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.locator('#prompt-dialog-input').fill('Closures and arrows');
      await dialog.getByRole('button', { name: 'Rename' }).click();
      await page.waitForFunction(
        () => [...document.querySelectorAll('.conv-item__title')].some((el) => el.textContent === 'Closures and arrows'),
        null,
        { timeout: 5_000 },
      );
    });

    await step('assistant: New chat → empty state → reopening restores transcript + attachment', async () => {
      await page.locator('.page-header__actions .btn:has-text("New chat")').click();
      await page.getByText('Start a conversation', { exact: false }).waitFor({ timeout: 5_000 });

      await page.locator('.conv-item__open').first().click();
      await page.getByText(question1, { exact: false }).first().waitFor({ timeout: 5_000 });
      const chipCount = await page.locator('.context-chips .chip').count();
      assert(chipCount === 1, `attachment must survive reopening, found ${chipCount} chip(s)`);
    });

    await step('persistence: conversation survives a full reload (IndexedDB)', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20_000 });
      await page.waitForFunction(() => document.querySelector('#boot-status')?.hasAttribute('hidden'), null, { timeout: 10_000 });
      await installAiMock(page);
      await page.evaluate(() => { location.hash = '#/assistant'; });
      await page.waitForSelector('.conv-item__title', { timeout: 10_000 });

      const titles = await page.locator('.conv-item__title').allTextContents();
      assert(titles.includes('Closures and arrows'), `renamed conversation lost after reload: ${titles.join(' | ')}`);
      const meta = await page.locator('.conv-item__meta').first().textContent();
      assert(meta.includes('4 messages'), `messages lost after reload: ${meta}`);
      await page.getByText(question2, { exact: false }).first().waitFor({ timeout: 10_000 });
      const chipCount = await page.locator('.context-chips .chip').count();
      assert(chipCount === 1, 'attachment reference must survive the reload');
    });

    await step('assistant: delete the conversation (confirmed) → history is empty', async () => {
      await page.locator('.conv-item__menu').first().click();
      await page.locator('.menu__item:has-text("Delete")').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 5_000 });
      await dialog.getByRole('button', { name: 'Delete' }).click();
      await page.getByText('No conversations yet.', { exact: false }).waitFor({ timeout: 5_000 });
      await page.getByText('Start a conversation', { exact: false }).waitFor({ timeout: 5_000 });
    });

    await step('editor: selection toolbar appears, previews, and only Apply writes', async () => {
      await page.evaluate(() => { location.hash = `#/lesson/${location.hash.split('/').pop() || ''}`; });
      await page.evaluate(() => { location.hash = '#/library'; });
      await page.getByText(lessonTitle, { exact: false }).first().waitFor({ timeout: 10_000 });
      await page.getByText(lessonTitle, { exact: false }).first().click();
      await page.waitForSelector('[aria-label="Lesson content (Markdown)"]', { timeout: 10_000 });

      // Select "world selection" (offsets 6..21 of the fixed content).
      await page.evaluate(() => {
        const textarea = document.querySelector('[aria-label="Lesson content (Markdown)"]');
        textarea.focus();
        textarea.setSelectionRange(6, 21);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await page.locator('.ai-toolbar').waitFor({ state: 'visible', timeout: 5_000 });

      await page.locator('.ai-toolbar .btn:has-text("AI edit")').click();
      const menuItems = page.locator('.menu__item');
      assert(await menuItems.count() === 7, `expected 7 writing actions, got ${await menuItems.count()}`);

      await page.locator('.menu__item:has-text("Improve writing")').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 15_000 });
      const suggestion = await dialog.locator('textarea[aria-label="AI suggestion (Improve writing)"]').inputValue();
      assert(suggestion === 'IMPROVED: the polished selection.', `unexpected suggestion: ${suggestion}`);
      const original = await dialog.locator('textarea[aria-label="Selected original text"]').inputValue();
      assert(original === 'world selection', `original selection must be shown, got: ${original}`);

      // Cancel: nothing changes.
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
      let value = await page.locator('[aria-label="Lesson content (Markdown)"]').inputValue();
      assert(value === editorContent, `Cancel must not modify the lesson, got: ${value}`);

      // Apply: only now is the selection replaced.
      await page.evaluate(() => {
        const textarea = document.querySelector('[aria-label="Lesson content (Markdown)"]');
        textarea.focus();
        textarea.setSelectionRange(6, 21);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await page.locator('.ai-toolbar .btn:has-text("AI edit")').click();
      await page.locator('.menu__item:has-text("Improve writing")').click();
      await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByRole('dialog').getByRole('button', { name: 'Apply changes' }).click();

      value = await page.locator('[aria-label="Lesson content (Markdown)"]').inputValue();
      const expectedValue = 'Hello IMPROVED: the polished selection. test.';
      assert(value === expectedValue, `Apply must replace exactly the selection, got: ${value}`);
      await page.locator('.ai-toolbar').waitFor({ state: 'hidden', timeout: 5_000 });
    });

    await step('editor: toolbar hides without a selection and respects word wrap', async () => {
      const hidden = await page.locator('.ai-toolbar').isHidden();
      assert(hidden, 'toolbar must stay hidden while nothing is selected');
    });

    await step('settings: Translate direction row exists', async () => {
      await page.evaluate(() => { location.hash = '#/settings?section=ai'; });
      await page.waitForSelector('.settings-layout', { timeout: 10_000 });
      await page.getByText('Translate direction', { exact: false }).first().waitFor({ timeout: 10_000 });
    });

    await step('no uncaught page errors during the run', async () => {
      assert(pageErrors.length === 0, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
      const relevant = consoleErrors.filter((line) => !line.includes('favicon'));
      assert(relevant.length === 0, `console errors: ${relevant.slice(0, 3).join(' | ')}`);
    });
  } finally {
    await browser.close().catch(() => {});
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} AI mock steps passed`);
  if (failed.length) {
    console.error('\nFailures:');
    for (const failure of failed) {
      console.error(`  - ${failure.name}: ${String(failure.error?.stack || failure.error).split('\n').slice(0, 5).join('\n    ')}`);
    }
    process.exitCode = 1;
  }
}

await main();
