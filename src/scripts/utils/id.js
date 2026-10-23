/** id.js — identifiers and slugs (pure, testable without a browser). */

/** RFC4122 v4 UUID; falls back for exotic environments without crypto. */
export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback: not cryptographically strong, only used when crypto is absent.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * URL/file friendly slug. Keeps unicode letters (so Burmese titles work),
 * collapses everything else to single dashes.
 */
export function slugify(input, fallback = 'item') {
  const slug = String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['"’]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** Append -2, -3… until `candidate` is not taken by `taken` (a Set/array). */
export function uniqueSlug(base, taken) {
  const set = taken instanceof Set ? taken : new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!set.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Stable, human-friendly short id for activity entries / operation ids. */
export function shortId(prefix = 'op') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
