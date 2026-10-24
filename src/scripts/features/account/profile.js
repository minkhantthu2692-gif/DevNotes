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
  // Cap on the STORED object, enforced on the ENCODED output by normalizeImage.
  // The picked file is allowed to be far bigger (see avatarSourceBytes): it is
  // downscaled and re-encoded, so what matters for sync cost is the stored size.
  avatarBytes: 512 * 1024, // 512 KB — small enough to keep sync pulls cheap
  // Cap on the picked file itself. Only bounds decode memory/time, since the
  // image is shrunk to avatarSide before encoding.
  avatarSourceBytes: 10 * 1024 * 1024, // 10 MB
  // Longest edge of the stored avatar. The header renders it at <= 72 CSS px,
  // so 512 px is generous even on high-density screens.
  avatarSide: 512,
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

/**
 * The seed row for a brand-new account, derived from the auth user's metadata.
 *
 * Pure so it is unit tested against the real column names (see toRow): the
 * values are snake_case because they go straight to PostgREST. Every field
 * except user_id is nullable, and deriveUsername/deriveAvatarUrl return ''
 * / null rather than throwing, so a provider that supplies nothing still
 * produces a creatable row.
 *
 * @param {{id?:string, email?:string, user_metadata?:object}} user
 * @returns {{user_id:string|null, username:string|null, full_name:string|null, avatar_url:string|null}}
 */
export function seedRowFromUser(user) {
  const fullName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || '').trim();
  return {
    user_id: user?.id || null,
    username: deriveUsername(user) || null,
    full_name: fullName || null,
    avatar_url: deriveAvatarUrl(user),
  };
}

/** First grapheme-ish character of a name for the generated avatar. */
export function initialFrom(username, fullName) {
  const source = cleanText(fullName) || cleanText(username);
  if (!source) return '?';
  const chars = Array.from(source);
  return (chars[0] || '?').toUpperCase();
}

/**
 * In-memory profile → a `profiles` row (PostgREST column names).
 *
 * The mapping is explicit rather than a generic case converter so that a typo
 * or an unsupported field can never reach the database: PostgREST rejects any
 * key that is not a real column with "Could not find the '<key>' column … in
 * the schema cache". Only the fields the app actually writes are listed.
 *
 * `avatar_path` is deliberately absent: the object path is always
 * `<uid>/avatar.png`, so it is redundant (see uploadAvatar).
 *
 * Pure and unit tested (tests/unit/profile.test.js) against the column names
 * in supabase/migrations/0002_profiles.sql.
 */
export function toRow(profile = {}) {
  const row = {};
  if (profile.username !== undefined) row.username = profile.username;
  if (profile.fullName !== undefined) row.full_name = profile.fullName;
  if (profile.bio !== undefined) row.bio = profile.bio;
  if (profile.avatarUrl !== undefined) row.avatar_url = profile.avatarUrl;
  return row;
}

/**
 * `profiles` row → in-memory profile. The inverse of toRow.
 * Tolerates missing columns (a schema that has not yet run every migration
 * simply yields undefined, normalised to ''/null here).
 */
export function fromRow(row = {}) {
  return {
    userId: row.user_id ?? null,
    username: row.username || '',
    fullName: row.full_name || '',
    bio: row.bio || '',
    avatarUrl: row.avatar_url || null,
    updatedAt: row.updated_at || null,
  };
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
