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
  initialFrom,
  sanitizeAvatarUrl,
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

  if (patch.avatarPath !== undefined) {
    clean.avatarPath = patch.avatarPath || null;
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
    const username = deriveUsername(user);
    const fullName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || '').trim();
    const avatarUrl = deriveAvatarUrl(user);

    const { data, error } = await client
      .from('profiles')
      .upsert(
        {
          user_id: user.id,
          username: username || null,
          full_name: fullName || null,
          avatar_url: avatarUrl,
        },
        { onConflict: 'user_id', ignoreDuplicates: true },
      )
      .select()
      .maybeSingle();

    if (error) throw error;
    cached = data ? fromRow(data) : localProfileFromUser(user);
    return cached;
  } catch (err) {
    console.warn('[account] profile load failed:', err?.message);
    cached = localProfileFromUser(user);
    return cached;
  }
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

  const { data, error } = await client
    .from('profiles')
    .upsert({ user_id: user.id, ...clean, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
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
 * `file` is validated (type + size) and re-encoded client-side to a squarish
 * PNG blob so metadata/EXIF never leaves the browser and the stored bytes are
 * bounded (AGENTS.md §13 — never send more than necessary).
 *
 * The image lands at `<uid>/avatar.png` in the `devnotes-avatars` bucket,
 * which is PUBLIC READ but owner-only WRITE (see supabase/migrations/
 * 0002_profiles.sql). It must be public-readable because the header renders it
 * via <img src> on every route — a private bucket would need a signed URL per
 * render that expires and breaks offline. Only you can write to your own
 * folder, so no one can replace your photo.
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
  if (file.size > PROFILE_LIMITS.avatarBytes) {
    throw new AppError('Image must be smaller than 512 KB', { code: 'too-large', retryable: false });
  }
  if (!isSupabaseConfigured()) throw new AppError('Cloud sync is not configured', { code: 'not-configured', retryable: false });

  const blob = await normalizeImage(file);
  const client = await getSupabaseClient();
  const path = `${user.id}/avatar.png`;

  const { error: upErr } = await client.storage.from(AVATARS_BUCKET).upload(path, blob, {
    cacheControl: '3600',
    upsert: true,
    contentType: 'image/png',
  });
  if (upErr) throw new AppError(upErr.message || 'Could not upload the image', { code: 'upload', retryable: true });

  const { data } = client.storage.from(AVATARS_BUCKET).getPublicUrl(path, { download: false });
  const url = sanitizeAvatarUrl(data?.publicUrl);
  if (!url) throw new AppError('Uploaded image could not be resolved', { code: 'upload-url', retryable: true });

  await updateProfile({ avatarUrl: url, avatarPath: path });
  return url;
}

/** Re-encode to a square PNG so EXIF/metadata is stripped and size is bounded. */
async function normalizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const size = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Center-crop to a square.
  ctx.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, size, size);
  bitmap.close?.();
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new AppError('Could not process the image', { code: 'image', retryable: false }))), 'image/png');
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

function fromRow(row) {
  return {
    userId: row.user_id,
    username: row.username || '',
    fullName: row.full_name || '',
    bio: row.bio || '',
    avatarUrl: row.avatar_url || null,
    avatarPath: row.avatar_path || null,
    updatedAt: row.updated_at || null,
  };
}

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
    avatarPath: null,
    updatedAt: null,
  };
}

/** Exported for the auth page: the username it will seed at sign-up. */
export { usernameFromName };
