/**
 * profile.js — pure profile derivation, normalization and avatar generation.
 *
 * No DOM, no network, no storage: everything here is deterministic and unit
 * testable (tests/unit/profile.test.js). The DOM/avatar-element and Supabase
 * round-trip live in account-service.js.
 *
 * Source of truth for the display profile is the `profiles` table (see
 * supabase/migrations/0002_profiles.sql), one row per authenticated user,
 * guarded by Row Level Security. The signed-in Supabase `user_metadata` is a
 * seed/fallback only — it is provider-controlled and not editable by the user.
 */

export const PROFILE_LIMITS = {
  username: 30,
  usernameMin: 2,
  fullName: 80,
  bio: 160,
  avatarBytes: 512 * 1024, // 512 KB — small enough to keep sync pulls cheap
};

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** Deterministic pastel pairs (bg, fg) so the same initial always looks the same. */
const INITIAL_PALETTES = [
  ['#6366f1', '#eef2ff'],
  ['#0ea5e9', '#e0f2fe'],
  ['#10b981', '#d1fae5'],
  ['#f59e0b', '#fef3c7'],
  ['#ef4444', '#fee2e2'],
  ['#8b5cf6', '#ede9fe'],
  ['#ec4899', '#fce7f3'],
  ['#14b8a6', '#ccfbf1'],
];

/** Strip invisible/bidi control characters and collapse whitespace. */
function cleanText(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a display name into a usable username.
 * Lowercases, keeps letters/digits then . _ -, trims separators, caps length.
 * Returns '' when nothing usable is left (caller derives from email instead).
 */
export function usernameFromName(name) {
  const cleaned = cleanText(name).toLowerCase();
  const mapped = cleaned
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop diacritics: Zoë -> zoe
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return mapped.slice(0, PROFILE_LIMITS.username);
}

/**
 * Fallback username: the part of an email before the '@'.
 * Mirrors usernameFromName's cleaning so both paths agree.
 */
export function usernameFromEmail(email) {
  const raw = cleanText(email).toLowerCase();
  const at = raw.indexOf('@');
  const local = at === -1 ? raw : raw.slice(0, at);
  return usernameFromName(local);
}

/** Public/HTTPS URL only; anything else (data:, javascript:) is refused. */
export function sanitizeAvatarUrl(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)/.test(url.hostname))) {
      return url.href;
    }
  } catch { /* fall through */ }
  return null;
}

/** Best username from an OAuth/password Supabase user, else ''. */
export function deriveUsername(user) {
  const meta = user?.user_metadata || {};
  const candidates = [meta.user_name, meta.preferred_username, meta.login, meta.full_name, meta.name];
  for (const candidate of candidates) {
    const username = usernameFromName(candidate);
    if (username) return username;
  }
  return usernameFromEmail(user?.email || '');
}

/** Best provider avatar URL from a Supabase user, else null. */
export function deriveAvatarUrl(user) {
  const meta = user?.user_metadata || {};
  const candidates = [meta.avatar_url, meta.picture, meta.avatarUrl];
  for (const candidate of candidates) {
    const url = sanitizeAvatarUrl(candidate);
    if (url) return url;
  }
  return null;
}

/** First grapheme-ish character of a name for the generated avatar. */
export function initialFrom(username, fullName) {
  const source = cleanText(fullName) || cleanText(username);
  if (!source) return '?';
  const chars = Array.from(source);
  return (chars[0] || '?').toUpperCase();
}

/** Stable small integer so the same initial always picks the same colors. */
function paletteIndexFor(seed) {
  let hash = 0;
  const text = cleanText(seed).toLowerCase();
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % INITIAL_PALETTES.length;
}

/**
 * The palette (background, foreground) an initial renders with.
 * Pure so the color choice is unit testable; the SVG element itself is built
 * as real DOM by account-service.js (never via innerHTML), so no escaping of
 * the glyph is needed — it goes through textContent.
 */
export function avatarPalette(seed) {
  return INITIAL_PALETTES[paletteIndexFor(seed || '')];
}
