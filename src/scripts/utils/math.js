/**
 * math.js — optional LaTeX support ($…$ and $$…$$) rendered with KaTeX.
 * KaTeX and its stylesheet are lazy-loaded only when a document actually
 * contains math, so the app shell stays small.
 */

import { escapeHtml, sanitizeMath } from './sanitize.js';

let katexPromise = null;
let cssPromise = null;

const VENDOR_BASE = new URL('../../vendor/katex/', import.meta.url);

function loadCss() {
  if (!cssPromise) {
    cssPromise = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = new URL('katex.min.css', VENDOR_BASE).href;
      link.onload = () => resolve();
      link.onerror = () => reject(new Error('Failed to load KaTeX stylesheet'));
      document.head.appendChild(link);
    });
  }
  return cssPromise;
}

async function loadKatex() {
  if (!katexPromise) {
    katexPromise = Promise.all([
      loadCss(),
      import(new URL('katex.mjs', VENDOR_BASE)),
    ]).then(([, mod]) => mod.default);
  }
  return katexPromise;
}

/** Cheap pre-check used by the render pipeline. */
export function containsMath(text) {
  return typeof text === 'string' && text.includes('$');
}

/**
 * Protect fenced/inline code from math scanning, then replace math with
 * inert placeholders (letters+digits only, so marked passes them through).
 * @returns {{text: string, formulas: Map<string, {tex: string, display: boolean}>}}
 */
export function extractMath(markdown) {
  const formulas = new Map();
  const nonce = Math.random().toString(36).slice(2, 8);
  const segments = String(markdown).split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g);

  let blockIndex = 0;
  let inlineIndex = 0;

  const transform = (segment) => {
    // Block math: $$ … $$ (may span lines)
    let out = segment.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex) => {
      const trimmed = tex.trim();
      if (!trimmed) return match;
      const token = `DNMATHB${blockIndex}N${nonce}`;
      blockIndex += 1;
      formulas.set(token, { tex: trimmed, display: true });
      return `\n\n${token}\n\n`;
    });

    // Inline math: $…$ — never starts with a digit (protects "$5 and $6")
    // and never starts/ends with whitespace; escaped \$ is ignored.
    out = out.replace(/(?<!\\)\$([^\s$\d](?:[^$]*?[^\s$])?)\$/g, (match, tex) => {
      const trimmed = tex.trim();
      if (!trimmed) return match;
      const token = `DNMATHI${inlineIndex}N${nonce}`;
      inlineIndex += 1;
      formulas.set(token, { tex: trimmed, display: false });
      return token;
    });

    return out;
  };

  const text = segments.map((segment, i) => (i % 2 === 1 ? segment : transform(segment))).join('');
  return { text, formulas };
}

/**
 * Render one formula to HTML. Never throws: invalid TeX becomes a visible,
 * safe error span so a broken formula cannot break the whole document.
 */
export async function renderFormula(tex, display = false) {
  try {
    const katex = await loadKatex();
    return katex.toString(tex, {
      displayMode: display,
      throwOnError: true,
      output: 'htmlAndMathml',
      // trust:false blocks \href, \includegraphics and other URL-bearing commands.
      trust: false,
      strict: false,
    });
  } catch (err) {
    const message = err?.message ? String(err.message).split('\n')[0] : 'invalid formula';
    return `<span class="math-error">TeX: ${escapeHtml(message)} — ${escapeHtml(tex.slice(0, 120))}</span>`;
  }
}

/** Replace extracted placeholders inside rendered HTML (async per formula). */
export async function substituteFormulas(html, formulas) {
  if (!formulas.size) return html;
  let out = html;
  for (const [token, { tex, display }] of formulas) {
    const rendered = sanitizeMath(await renderFormula(tex, display));
    const block = display ? `<div class="math-block">${rendered}</div>` : rendered;
    out = out.split(token).join(block);
  }
  return out;
}
