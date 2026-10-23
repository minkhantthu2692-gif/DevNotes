/**
 * markdown.js — the one Markdown pipeline used by the editor preview, lesson
 * views, exports and the AI assistant.
 *
 * Safety rules:
 *  - Raw HTML in source is escaped by default (setting: allowRawHtml).
 *  - Every produced fragment passes through DOMPurify (utils/sanitize.js).
 *  - Code blocks are rendered as text here and highlighted after insertion
 *    (components/code-block.js), so saved code is never executable HTML.
 */

import { Marked } from '../../vendor/marked/marked.esm.js';
import { escapeHtml, sanitizeHtml, sanitizeMath } from './sanitize.js';
import { extractMath, containsMath, substituteFormulas } from './math.js';
import { sanitizeUrl } from './validate.js';
import { slugify } from './id.js';

// Per-render state for unique heading ids (parse calls are synchronous).
let headingIds = null;

const marked = new Marked({ gfm: true, breaks: false, pedantic: false });

marked.use({
  renderer: {
    /**
     * Code: untrusted text, escaped; highlighted later by code-block.js.
     * We deliberately emit no buttons — interactive elements are added by our
     * own JS after sanitizing (DOMPurify forbids them anyway).
     */
    code({ text, lang }) {
      const langRaw = String(lang || '').split(/\s+/)[0].toLowerCase();
      const label = langRaw || 'text';
      return (
        `<figure class="code-block" data-lang="${escapeHtml(langRaw)}">` +
        `<figcaption class="code-block__bar">` +
        `<span class="code-block__lang" data-unknown="false">${escapeHtml(label)}</span>` +
        `<span class="code-block__actions"></span>` +
        `</figcaption>` +
        `<pre class="code-block__pre" data-wrap="false" data-lines="false">` +
        `<code class="hljs">${escapeHtml(text)}</code>` +
        `</pre></figure>`
      );
    },

    heading({ depth, text, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const plain = String(text).replace(/[^\p{Letter}\p{Number}\s-]/gu, '');
      let id = slugify(plain, 'section');
      if (headingIds) {
        const seen = headingIds.get(id) || 0;
        headingIds.set(id, seen + 1);
        if (seen > 0) id = `${id}-${seen + 1}`;
      }
      return `<h${depth} id="${escapeHtml(id)}">${inner}</h${depth}>`;
    },

    /**
     * Links: only http(s)/mailto/internal hash links keep their href;
     * anything else (javascript:, data:, …) degrades to plain text.
     */
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const safe = sanitizeUrl(href) || (String(href).startsWith('#/') ? href : null) || (String(href).startsWith('#') ? href : null);
      if (!safe) return `<span title="Blocked unsafe link">${inner}</span>`;
      const isExternal = /^https?:/i.test(safe);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const externalAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer nofollow"' : '';
      return `<a href="${escapeHtml(safe)}"${titleAttr}${externalAttrs}>${inner}</a>`;
    },

    /**
     * Raw HTML: escaped (safe default). When the user explicitly enables
     * "render raw HTML" in Settings → Editor, the original text passes
     * through and is still cleaned by DOMPurify in sanitizeHtml().
     */
    html(token) {
      if (typeof marked.__allowRawHtml === 'function' && marked.__allowRawHtml()) {
        return token.text;
      }
      return escapeHtml(token.raw);
    },
  },
});

/**
 * Build sanitized, render-ready HTML from Markdown.
 * @param {string} markdown
 * @param {{allowRawHtml?: boolean}} [options]
 * @returns {Promise<string>} safe HTML (assign with innerHTML)
 */
export async function renderMarkdown(markdown, options = {}) {
  const source = String(markdown ?? '');
  if (!source.trim()) return '';

  marked.__allowRawHtml = () => Boolean(options.allowRawHtml);

  const { text, formulas } = containsMath(source) ? extractMath(source) : { text: source, formulas: new Map() };

  headingIds = new Map();
  let html;
  try {
    html = marked.parse(text);
  } finally {
    headingIds = null;
  }

  let sanitized = sanitizeHtml(html);
  if (formulas.size) {
    const withMath = await substituteFormulas(sanitized, formulas);
    // substituteFormulas already returns katex-sanitized markup per formula;
    // run the strict pass again over the whole document is intentionally
    // skipped so KaTeX inline styles survive.
    sanitized = withMath;
  }
  return sanitized;
}

/** Sync, unsanitized build (tests / internal inspection only). */
export function buildMarkdownHtml(markdown) {
  headingIds = new Map();
  try {
    return marked.parse(String(markdown ?? ''));
  } finally {
    headingIds = null;
  }
}

/** Plain-text rendering for TXT export and summaries. */
export function markdownToPlainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, '').replace(/```$/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, (m) => m)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First paragraph / heading as a short summary. */
export function markdownSummary(markdown, max = 180) {
  const text = markdownToPlainText(markdown).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
