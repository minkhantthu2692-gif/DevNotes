/**
 * search.js — pure query parsing, scoring and highlighting helpers.
 * Keeping this module DOM-free lets unit tests cover real search behaviour.
 *
 * Query syntax (all optional, combinable with free text):
 *   lang:javascript   category:tutorial   tag:arrays   status:learning
 *   difficulty:hard   is:favorite         is:archived  is:trashed
 *   has:code          has:source          type:lesson|snippet
 *   free words...
 */

const FILTER_KEYS = new Set([
  'lang', 'language', 'category', 'course', 'tag', 'status', 'difficulty', 'is', 'has', 'type', 'sort',
]);

export function parseQuery(raw) {
  const query = { text: '', filters: {}, tags: [] };
  const free = [];

  for (const token of String(raw ?? '').matchAll(/(?:[^\s"]+|"[^"]*")+/g)) {
    const piece = token[0].replace(/^"|"$/g, '');
    const sep = piece.indexOf(':');
    if (sep > 0) {
      const key = piece.slice(0, sep).toLowerCase();
      const value = piece.slice(sep + 1).toLowerCase().replace(/^"|"$/g, '');
      if (FILTER_KEYS.has(key) && value) {
        const norm = key === 'language' ? 'lang' : key;
        if (norm === 'tag') query.tags.push(value);
        else if (norm === 'is' || norm === 'has') (query.filters[norm] ||= []).push(value);
        else query.filters[norm] = value;
        continue;
      }
    }
    if (piece) free.push(piece.toLowerCase());
  }

  query.text = free.join(' ').trim();
  return query;
}

/** Case-insensitive containment. */
const has = (haystack, needle) =>
  typeof haystack === 'string' && haystack.toLowerCase().includes(needle);

/**
 * Score a record against free text. Higher = better; -1 = no match.
 * @param {{title?:string, summary?:string, tags?:string[], content?:string,
 *          code?:string, language?:string, category?:string, extra?:string}} fields
 * @param {string} text lower-cased free text (space separated AND terms)
 */
export function scoreRecord(fields, text) {
  if (!text) return 0;
  const terms = text.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  const title = fields.title ?? '';
  const summary = fields.summary ?? '';
  const tags = (fields.tags ?? []).join(' ');
  const body = [fields.content ?? '', fields.code ?? '', fields.extra ?? ''].join('\n');
  const meta = [fields.language ?? '', fields.category ?? ''].join(' ');

  let total = 0;
  for (const term of terms) {
    let termScore = 0;
    if (has(title, term)) termScore += title.toLowerCase().startsWith(term) ? 14 : 10;
    if (has(meta, term)) termScore += 5;
    if (has(summary, term)) termScore += 4;
    if (has(tags, term)) termScore += 6;
    if (termScore === 0 && has(body, term)) termScore += 2;
    if (termScore === 0) return -1; // every term must match somewhere (AND)
    total += termScore;
  }
  return total;
}

/** Apply `is:`/`has:` flags and tag filters to a record-like object. */
export function matchesFlags(record, query) {
  const f = query.filters;
  if (f.lang && (record.languageKey || record.language) !== f.lang) return false;
  if (f.category && record.categoryKey !== f.category) return false;
  if (f.course && record.courseKey !== f.course) return false;
  if (f.status && record.status !== f.status) return false;
  if (f.difficulty && record.difficulty !== f.difficulty) return false;
  if (f.type && record.type !== f.type) return false;
  if (f.sort) return true; // sort is consumed by the list, not a filter

  const is = f.is || [];
  if (is.includes('favorite') && !record.favorite) return false;
  if (is.includes('archived') && !record.archived) return false;
  if (is.includes('trashed') && !record.trashed) return false;
  if (is.length && is.includes('active') && record.trashed) return false;

  const flags = f.has || [];
  if (flags.includes('code') && !record.hasCode) return false;
  if (flags.includes('source') && !(record.sourceUrls && record.sourceUrls.length)) return false;

  for (const tag of query.tags) {
    const tags = (record.tags || []).map((t) => t.toLowerCase());
    if (!tags.includes(tag)) return false;
  }
  return true;
}

/**
 * Split text into highlighted / plain segments for safe rendering.
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function segmentHighlight(text, terms) {
  const source = String(text ?? '');
  const clean = (terms || []).filter(Boolean).map((t) => t.toLowerCase());
  if (!source || clean.length === 0) return [{ text: source, hit: false }];

  const ranges = [];
  const lower = source.toLowerCase();
  for (const term of clean) {
    let from = 0;
    let idx;
    while ((idx = lower.indexOf(term, from)) !== -1) {
      ranges.push([idx, idx + term.length]);
      from = idx + term.length;
    }
  }
  if (ranges.length === 0) return [{ text: source, hit: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const range of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }

  const segments = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: source.slice(cursor, start), hit: false });
    segments.push({ text: source.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), hit: false });
  return segments;
}

/** Recency-aware sort comparison helpers shared by list pages. */
export const comparators = {
  title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }),
  created: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  updated: (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0),
  opened: (a, b) => (a.lastOpenedAt || 0) - (b.lastOpenedAt || 0),
  order: (a, b) => (a.order ?? 0) - (b.order ?? 0),
  review: (a, b) => (a.reviewAt || Number.MAX_SAFE_INTEGER) - (b.reviewAt || Number.MAX_SAFE_INTEGER),
};

export function applySort(list, sortKey, dir = 'desc') {
  const cmp = comparators[sortKey] || comparators.updated;
  const sign = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => cmp(a, b) * sign);
}
