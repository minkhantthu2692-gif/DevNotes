/**
 * code-block.js — hydrates `<figure class="code-block">` markup produced by
 * utils/markdown.js: applies lazy syntax highlighting and adds working
 * actions (copy / copy with line numbers / wrap toggle / line numbers).
 *
 * The figure is plain text until hydrated, so a failure here can never lose
 * or execute content — code stays selectable and copyable either way.
 */

import { h } from '../utils/dom.js';
import { highlightCode, highlightSync } from '../utils/hljs.js';
import { copyText, copyWithFeedback } from '../utils/clipboard.js';
import { announce } from './toast.js';
import { openMenu } from './menu.js';

/** Raw source per <code> element (survives line-number restructuring). */
const sources = new WeakMap();

/**
 * Split Highlight.js HTML into lines, reopening any span that crosses a
 * newline so the markup stays valid.
 */
function splitLines(html) {
  const lines = [];
  let current = '';
  const open = [];
  const tokenRe = /(<[^>]+>)|([^<]+)/g;
  let match;
  while ((match = tokenRe.exec(html)) !== null) {
    if (match[1]) {
      const tag = match[1];
      if (tag.startsWith('</')) {
        open.pop();
        current += tag;
      } else if (!tag.endsWith('/>')) {
        open.push(tag);
        current += tag;
      } else {
        current += tag;
      }
      continue;
    }
    const parts = match[2].split('\n');
    parts.forEach((part, index) => {
      if (index > 0) {
        // close all open tags, end the line, then reopen them
        for (let i = open.length - 1; i >= 0; i -= 1) current += '</span>';
        lines.push(current);
        current = '';
        for (const tag of open) current += tag;
      }
      current += part;
    });
  }
  if (current) lines.push(current);
  return lines;
}

function applyLineNumbers(pre, code, enabled) {
  const raw = sources.get(code);
  if (raw === undefined) return;

  if (enabled) {
    const base = code.dataset.highlighted === 'true' ? code.innerHTML : code.textContent;
    const lines = splitLines(base);
    clearChildren(code);
    const wrap = h('span', { class: 'line-numbers' });
    lines.forEach((lineHtml, index) => {
      wrap.appendChild(h('span', { class: 'line-numbers__row' }, [
        h('span', { class: 'line-numbers__num', text: String(index + 1) }),
        h('span', { class: 'line-numbers__code', html: lineHtml }),
      ]));
    });
    code.appendChild(wrap);
  } else {
    const html = code.dataset.highlighted === 'true' ? code.dataset.hlHtml : null;
    clearChildren(code);
    if (html) code.innerHTML = html;
    else code.textContent = raw;
  }
  pre.dataset.lines = enabled ? 'true' : 'false';
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function numberedCopy(raw) {
  return raw
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(4, ' ')}  ${line}`)
    .join('\n');
}

/**
 * Hydrate every un-hydrated code block inside `root`.
 * Safe to call repeatedly (idempotent per block).
 */
export function hydrateCodeBlocks(root) {
  if (!root) return 0;
  const figures = root.querySelectorAll('figure.code-block:not([data-hydrated])');
  let count = 0;

  figures.forEach((figure) => {
    figure.dataset.hydrated = 'true';
    count += 1;
    const code = figure.querySelector('code');
    const pre = figure.querySelector('pre');
    const actions = figure.querySelector('.code-block__actions');
    const langLabel = figure.querySelector('.code-block__lang');
    if (!code || !pre || !actions) return;

    const raw = code.textContent ?? '';
    sources.set(code, raw);
    const lang = figure.dataset.lang || '';

    // --- actions -----------------------------------------------------------
    const copyBtn = h('button', {
      class: 'code-block__btn',
      type: 'button',
      text: 'Copy',
      attrs: { 'aria-label': `Copy ${lang || 'code'} snippet` },
      on: {
        click: () => copyWithFeedback(raw, (msg) => announce(msg), 'Code copied'),
      },
    });

    const wrapBtn = h('button', {
      class: 'code-block__btn',
      type: 'button',
      text: 'Wrap',
      attrs: { 'aria-pressed': pre.dataset.wrap === 'true' ? 'true' : 'false', 'aria-label': 'Toggle line wrapping' },
      on: {
        click: () => {
          const next = pre.dataset.wrap !== 'true';
          pre.dataset.wrap = next ? 'true' : 'false';
          wrapBtn.setAttribute('aria-pressed', String(next));
          announce(next ? 'Line wrapping on' : 'Line wrapping off');
        },
      },
    });

    const linesBtn = h('button', {
      class: 'code-block__btn',
      type: 'button',
      text: 'Lines',
      attrs: { 'aria-pressed': 'false', 'aria-label': 'Toggle line numbers' },
      on: {
        click: () => {
          const next = pre.dataset.lines !== 'true';
          applyLineNumbers(pre, code, next);
          linesBtn.setAttribute('aria-pressed', String(next));
          announce(next ? 'Line numbers on' : 'Line numbers off');
        },
      },
    });

    const moreBtn = h('button', {
      class: 'code-block__btn',
      type: 'button',
      text: '⋯',
      attrs: { 'aria-label': 'More code actions', 'aria-haspopup': 'menu' },
      on: {
        click: () => openMenu(moreBtn, [
          {
            label: 'Copy with line numbers',
            icon: 'lineNumbers',
            onSelect: async () => {
              const ok = await copyText(numberedCopy(raw));
              announce(ok ? 'Code with line numbers copied' : 'Copy failed');
            },
          },
          {
            label: 'Copy as Markdown',
            icon: 'copy',
            onSelect: async () => {
              const ok = await copyText(`\`\`\`${lang}\n${raw}\n\`\`\``);
              announce(ok ? 'Markdown code block copied' : 'Copy failed');
            },
          },
        ]),
      },
    });

    actions.append(copyBtn, wrapBtn, linesBtn, moreBtn);

    // --- lazy highlighting --------------------------------------------------
    highlightCode(raw, lang).then(({ html, known }) => {
      if (!figure.isConnected) return;
      code.innerHTML = html; // library-escaped output, never raw source
      code.dataset.highlighted = 'true';
      code.dataset.hlHtml = html;
      if (!known && lang) {
        langLabel?.setAttribute('data-unknown', 'true');
        if (langLabel) langLabel.textContent = `${lang} · plain`;
      } else if (langLabel) {
        code.dataset.hlLang = lang || 'text';
        langLabel.textContent = lang || 'text';
      }
      // Re-apply line numbers if the user already toggled them on.
      if (pre.dataset.lines === 'true') applyLineNumbers(pre, code, true);
    }).catch((err) => {
      console.warn('[code-block] highlight unavailable:', err?.message);
    });
  });

  return count;
}

/** Strip action UI from a cloned figure (for HTML export / copy). */
export function cleanCodeFigure(figure) {
  figure.querySelectorAll('.code-block__actions').forEach((node) => node.remove());
  figure.querySelectorAll('button').forEach((node) => node.remove());
  return figure;
}

/**
 * Serialize the rendered content of an element to standalone HTML,
 * highlighting any not-yet-highlighted code synchronously when possible.
 */
export function serializeRenderedHtml(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('figure.code-block').forEach((figure) => {
    cleanCodeFigure(figure);
    const code = figure.querySelector('code');
    const lang = figure.dataset.lang || '';
    if (code && code.dataset.highlighted !== 'true') {
      code.innerHTML = highlightSync(code.textContent ?? '', lang);
    }
    // Line-number tables would be meaningless outside this page.
    figure.querySelectorAll('.line-numbers').forEach((wrap) => {
      const codeEl = wrap.closest('code');
      if (codeEl && sources.get(codeEl) !== undefined) {
        clearChildren(codeEl);
        codeEl.textContent = sources.get(codeEl);
      }
    });
  });
  clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  return clone.innerHTML;
}
