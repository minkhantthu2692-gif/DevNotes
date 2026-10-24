/**
 * account-service.js — read/update the signed-in user's `profiles` row and
 * avatar, plus DOM avatar rendering.
 *
 * Why this does NOT go through sync-queue.js: that queue drains entity tables
 * (lessons/snippets/…) through remote-api.js using the revision-conflict
 * protocol. The profile is a single RLS-owned row keyed by auth.uid(), edited
 * directly and only from the account page, and is non-critical — so it opts for
 * a straightforward direct read/write with explicit states (AGENTS.md §15)
 * instead of the entity conflict machinery. Local-first still holds: nothing
 * blocks on the cloud, failures surface as retryable/permanent toasts, and a
 * failed read falls back to derived values.
 *
 * The pure derivation/normalization lives in profile.js (unit tested).
 */

import { getSupabaseClient, isSupabaseConfigured } from '../../services/supabase-client.js';
import { authStore } from '../../state.js';
import { bus } from '../../utils/bus.js';
import { AppError } from '../../utils/errors.js';
import { h } from '../../utils/dom.js';
import {
  PROFILE_LIMITS,
  avatarPalette,
  deriveAvatarUrl,
  deriveUsername,
  fromRow,
  initialFrom,
  sanitizeAvatarUrl,
  seedRowFromUser,
  toRow,
  usernameFromName,
} from './profile.js';

export const AVATARS_BUCKET = 'devnotes-avatars';

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

/** Last fetched profile for the current user (null when signed out). */
let cached = null;

export function getCachedProfile() {
  return cached;
}

export function clearCachedProfile() {
  cached = null;
}

/** Validate + clamp a profile patch. Throws AppError with a user message. */
function validatePatch(patch = {}) {
  const clean = {};

  if (patch.username !== undefined) {
    const username = String(patch.username ?? '').trim().toLowerCase().slice(0, PROFILE_LIMITS.username);
    if (username.length < PROFILE_LIMITS.usernameMin) {
      throw new AppError(`Username must be at least ${PROFILE_LIMITS.usernameMin} characters`, { code: 'invalid-username', retryable: false });
    }
    if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(username) && username.length > PROFILE_LIMITS.usernameMin) {
      throw new AppError('Username may only contain letters, numbers, dots, dashes and underscores', { code: 'invalid-username', retryable: false });
    }
    clean.username = username;
  }

  if (patch.fullName !== undefined) {
    clean.fullName = String(patch.fullName ?? '').trim().slice(0, PROFILE_LIMITS.fullName);
  }

  if (patch.bio !== undefined) {
    clean.bio = String(patch.bio ?? '').trim().slice(0, PROFILE_LIMITS.bio);
  }

  if (patch.avatarUrl !== undefined) {
    clean.avatarUrl = patch.avatarUrl ? sanitizeAvatarUrl(patch.avatarUrl) : null;
    if (patch.avatarUrl && !clean.avatarUrl) {
      throw new AppError('Avatar link must be a valid https URL', { code: 'invalid-avatar', retryable: false });
    }
  }

  return clean;
}

/**
 * Ensure a profile row exists for the signed-in user, seeding it from OAuth
 * metadata / email. Returns the stored (or best-effort local) profile.
 * Never throws for "no client" — returns a derived local profile so the UI has
 * something to render.
 */
export async function loadProfile() {
  const { user } = authStore.get();
  if (!user) { cached = null; return null; }

  if (!isSupabaseConfigured()) {
    cached = localProfileFromUser(user);
    return cached;
  }

  let client;
  try {
    client = await getSupabaseClient();
  } catch {
    cached = localProfileFromUser(user);
    return cached;
  }

  try {
    let row = await selectRow(client, user.id);

    if (!row) {
      // First run for this account: seed a row so the header has a name/photo.
      // ON CONFLICT DO NOTHING keeps seeding from overwriting a row another tab
      // may have created in the meantime.
      const seed = seedRowFromUser(user);
      const { error } = await client
        .from('profiles')
        .upsert(seed, { onConflict: 'user_id', ignoreDuplicates: true });

      if (error && error.code === '23505' && /profiles_username_unique/.test(error.message || '')) {
        // The derived handle is already taken by someone else. The row matters
        // more than the handle: retry with no username and let the user pick
        // their own on the Account page.
        const { error: retryErr } = await client
          .from('profiles')
          .upsert({ ...seed, username: null }, { onConflict: 'user_id', ignoreDuplicates: true });
        if (retryErr) throw retryErr;
      } else if (error) {
        throw error;
      }

      // Re-read rather than trusting the insert: DO NOTHING returns no rows
      // when another writer won the race, and the stored row is the source of
      // truth for everything the user has edited.
      row = await selectRow(client, user.id);
    }

    cached = row ? fromRow(row) : localProfileFromUser(user);
    return cached;
  } catch (err) {
    console.warn('[account] profile load failed:', err?.message);
    cached = localProfileFromUser(user);
    return cached;
  }
}

/**
 * Read the signed-in user's profile row, or null when there is not one yet.
 * @throws {Error} on any PostgREST failure, so callers can fall back loudly.
 */
async function selectRow(client, userId) {
  const { data, error } = await client
    .from('profiles')
    .select()
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Persist a profile patch. The row is written immediately (optimistic), and
 * `authStore` is refreshed so the header updates everywhere at once.
 * @returns {Promise<object>} the saved profile
 */
export async function updateProfile(patch = {}) {
  const { user } = authStore.get();
  if (!user) throw new AppError('Sign in to edit your profile', { code: 'signed-out', retryable: false });
  if (!isSupabaseConfigured()) throw new AppError('Cloud sync is not configured', { code: 'not-configured', retryable: false });

  const clean = validatePatch(patch);
  const client = await getSupabaseClient();

  // `clean` is camelCase (matches the in-memory profile shape); `toRow`
  // converts it to the snake_case columns PostgREST expects.
  const { data, error } = await client
    .from('profiles')
    .upsert({ user_id: user.id, ...toRow(clean), updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    .select()
    .maybeSingle();

  if (error) {
    // Unique-violation on username: surface a friendly message, not a raw code.
    if (error.code === '23505') throw new AppError('That username is already taken', { code: 'username-taken', retryable: false });
    throw new AppError(error.message || 'Could not save your profile', { code: 'profile-save', retryable: true });
  }

  cached = data ? fromRow(data) : { ...(cached || localProfileFromUser(user)), ...clean };
  bus.emit('profile:changed', cached);
  return cached;
}

/**
 * Upload an avatar image and store its URL on the profile.
 * `file` is validated (type + size) then re-encoded client-side to a square no
 * larger than `avatarSide`, so metadata/EXIF never leaves the browser and the
 * stored bytes are bounded by `avatarBytes` (AGENTS.md §13 — never send more
 * than necessary). The cap is enforced on the ENCODED output, which the source
 * size alone does not guarantee: a small JPEG can re-encode to a much larger
 * lossless PNG.
 *
 * The image lands at `<uid>/avatar.png` (or `.jpg` when PNG cannot fit the cap)
 * in the `devnotes-avatars` bucket, which is PUBLIC READ but owner-only WRITE
 * (see supabase/migrations/0002_profiles.sql). It must be public-readable
 * because the header renders it via <img src> on every route — a private bucket
 * would need a signed URL per render that expires and breaks offline. Only you
 * can write to your own folder, so no one can replace your photo.
 *
 * @returns {Promise<string>} the new avatar URL
 */
export async function uploadAvatar(file) {
  const { user } = authStore.get();
  if (!user) throw new AppError('Sign in to change your photo', { code: 'signed-out', retryable: false });
  if (!file) throw new AppError('No image selected', { code: 'no-file', retryable: false });
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new AppError('Choose a PNG, JPEG, WebP, GIF or AVIF image', { code: 'bad-type', retryable: false });
  }
  // Only guards decode cost — the stored size is capped on the OUTPUT by
  // normalizeImage, because re-encoding a small file can balloon (a small JPEG
  // drawn at full size and saved as lossless PNG became a 2.8 MB object).
  if (file.size > PROFILE_LIMITS.avatarSourceBytes) {
    throw new AppError(`Image is too large — pick one under ${Math.round(PROFILE_LIMITS.avatarSourceBytes / (1024 * 1024))} MB`, { code: 'too-large', retryable: false });
  }
  if (!isSupabaseConfigured()) throw new AppError('Cloud sync is not configured', { code: 'not-configured', retryable: false });

  const { blob, ext } = await normalizeImage(file);
  const client = await getSupabaseClient();
  const path = `${user.id}/avatar.${ext}`;

  const { error: upErr } = await client.storage.from(AVATARS_BUCKET).upload(path, blob, {
    cacheControl: '3600',
    upsert: true,
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
  });
  if (upErr) throw new AppError(upErr.message || 'Could not upload the image', { code: 'upload', retryable: true });

  // Drop a stale sibling from an earlier upload in the other format
  // (avatar.png ↔ avatar.jpg) so the bucket never keeps an unreferenced copy.
  // Best-effort: the profile already points at the new URL, so a failure here
  // only costs a stray object.
  const stalePath = path.replace(/\.[a-z0-9]+$/, ext === 'png' ? '.jpg' : '.png');
  const { error: rmErr } = await client.storage.from(AVATARS_BUCKET).remove([stalePath]);
  if (rmErr) console.warn('[account] stale avatar cleanup skipped:', rmErr.message);

  const { data } = client.storage.from(AVATARS_BUCKET).getPublicUrl(path, { download: false });
  const url = sanitizeAvatarUrl(data?.publicUrl);
  if (!url) throw new AppError('Uploaded image could not be resolved', { code: 'upload-url', retryable: true });

  // The object path is deterministic (`<uid>/avatar.<ext>`) and the bucket's
  // write policies scope to that folder, so nothing needs to be stored.
  await updateProfile({ avatarUrl: url });
  return url;
}

/**
 * Center-crop to a square, shrink to at most `avatarSide`, and re-encode.
 *
 * PNG is tried first (crisp edges for graphics/illustrations); if the encoded
 * PNG exceeds the cap, JPEG is retried at falling qualities. The cap is
 * checked on the RESULT, not the source file — that is the whole point of this
 * function, since canvas re-encoding can multiply the byte count several times
 * over. The output is deterministic and EXIF-free, so nothing about the
 * original file leaves the browser (AGENTS.md §13).
 *
 * @returns {Promise<{blob: Blob, ext: 'png'|'jpg'}>} encoded image + its extension
 */
async function normalizeImage(file) {
  const bitmap = await createImageBitmap(file);
  // Square side to take from the source, and the side we actually store.
  const crop = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(crop, PROFILE_LIMITS.avatarSide);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  // Center-crop to a square, downscaling to `out` in the same draw.
  ctx.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, out, out);
  bitmap.close?.();

  const png = await toBlob(canvas, 'image/png');
  if (png.size <= PROFILE_LIMITS.avatarBytes) return { blob: png, ext: 'png' };

  for (const quality of [0.82, 0.7, 0.6]) {
    const jpeg = await toBlob(canvas, 'image/jpeg', quality);
    if (jpeg.size <= PROFILE_LIMITS.avatarBytes) return { blob: jpeg, ext: 'jpg' };
  }

  throw new AppError(
    `Image could not be reduced below ${Math.round(PROFILE_LIMITS.avatarBytes / 1024)} KB — try a simpler image`,
    { code: 'too-large', retryable: false },
  );
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new AppError('Could not process the image', { code: 'image', retryable: false }))),
      type,
      quality,
    );
  });
}

/* ---------------------------------------------------------- rendering ---- */

/**
 * Build an avatar element.
 * @param {{username?:string, fullName?:string, avatarUrl?:string}} profile
 * @param {{size?:number, className?:string}} [opts]
 * @returns {HTMLElement}
 */
export function avatarElement(profile, { size = 32, className = '' } = {}) {
  const span = document.createElement('span');
  const username = profile?.username || '';
  const fullName = profile?.fullName || '';
  const initial = initialFrom(username, fullName);
  const url = sanitizeAvatarUrl(profile?.avatarUrl);

  span.className = `avatar${className ? ` ${className}` : ''}`;
  span.setAttribute('role', 'img');
  span.setAttribute('aria-label', fullName || username || 'Avatar');
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;

  if (url) {
    const img = document.createElement('img');
    img.className = 'avatar__img';
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    // Fall back to the generated initial if the remote image 404s.
    img.addEventListener('error', () => {
      if (img.parentNode) img.remove();
      span.appendChild(generatedAvatar(username, fullName, initial));
    }, { once: true });
    span.appendChild(img);
  } else {
    span.appendChild(generatedAvatar(username, fullName, initial));
  }
  return span;
}

/**
 * Build the initial-avatar as real DOM nodes — never innerHTML.
 *
 * AGENTS.md §7 forbids injecting markup built from data. Earlier this built an
 * SVG string and assigned it to innerHTML, which (a) depended on the string
 * builder escaping the glyph correctly, and (b) escaped-then-sliced, turning a
 * lone "<" into the truncated entity "&l". Constructing the SVG with the
 * `svg:` namespaced helper removes both problems: the glyph goes through
 * textContent, so it cannot be parsed as markup at all.
 */
function generatedAvatar(username, fullName, initial) {
  const [bg, fg] = avatarPalette(username || fullName || 'devnotes');
  return h('svg:svg', {
    attrs: { viewBox: '0 0 64 64', role: 'presentation', 'aria-hidden': 'true' },
  }, [
    h('svg:rect', { attrs: { width: '64', height: '64', rx: '32', fill: bg } }),
    h('svg:text', {
      text: initial || '?',
      attrs: {
        x: '32', y: '33', fill: fg, 'font-size': '30', 'font-weight': '600',
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-family': 'system-ui, -apple-system, Segoe UI, sans-serif',
      },
    }),
  ]);
}

/* ------------------------------------------------------------- helpers --- */

/* fromRow/toRow live in ./profile.js (pure, unit tested against the column
 * names in supabase/migrations/0002_profiles.sql) and are imported above. */

/** Offline/unsigned fallback assembled purely from the auth user. */
function localProfileFromUser(user) {
  const username = deriveUsername(user);
  const fullName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || '').trim();
  return {
    userId: user?.id || null,
    username,
    fullName,
    bio: '',
    avatarUrl: deriveAvatarUrl(user),
    updatedAt: null,
  };
}

/** Exported for the auth page: the username it will seed at sign-up. */
export { usernameFromName };
