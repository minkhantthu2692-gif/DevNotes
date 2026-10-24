/**
 * account-actions.js — destructive account lifecycle operations:
 *
 *   resetUserData() — delete everything the owner uploaded to Supabase (the
 *                     seven sync tables, the profile row, the avatar objects)
 *                     plus this browser's copy, while KEEPING the account, so
 *                     the user restarts from a fresh, empty state.
 *   deleteAccount() — remove the account and all of its data entirely; the
 *                     email address and the Google/GitHub identity become free
 *                     again, so a brand-new account can be created later.
 *
 * Kept apart from account-service.js: that module owns the profile row and
 * avatar as an ordinary read/write of one RLS-owned row, while these perform
 * irreversible operations. The UI layer (pages/account.js) owns the typed
 * confirmation dialogs; this module never decides *whether* to act, only how
 * to do it truthfully — success is reported only after the remote confirms it
 * (AGENTS.md §15).
 *
 * HOW EACH PART REACHES SUPABASE:
 *  - Row deletes go through PostgREST with the normal session. Every table has
 *    `auth.uid() = user_id` DELETE policies (migrations 0001/0002), so the
 *    DATABASE bounds each statement to the owner's rows — the same RLS-scoped
 *    path the sync engine already uses for deletes. That is why Reset needs no
 *    extra SQL and still works when 0003_account.sql has not been applied.
 *    Deletes are idempotent: a mid-way failure names the table and a re-run
 *    finishes the job instead of leaving the user guessing.
 *  - Avatar objects are removed FIRST and strictly: they live in a PUBLIC-read
 *    bucket, so a leftover photo would stay readable after the data is gone.
 *    A failure here aborts before anything else changes.
 *  - Permanent deletion of the auth user is the one step the browser may not
 *    do alone (the publishable key must never delete auth users, AGENTS.md
 *    §11), so deleteAccount() runs SECURITY DEFINER SQL from
 *    supabase/migrations/0003_account.sql via client.rpc('delete_account').
 *    A missing migration surfaces the exact recovery step — never a fake
 *    success.
 */

import { getSupabaseClient, isSupabaseConfigured } from '../../services/supabase-client.js';
import { authStore } from '../../state.js';
import { AppError } from '../../utils/errors.js';
import { wipeLocalDatabase } from '../../db/database.js';
import { AVATARS_BUCKET } from './account-service.js';

/** Everything the account owns in Postgres, with human wording for errors. */
const CLOUD_TABLES = [
  { table: 'lessons', label: 'notes' },
  { table: 'code_snippets', label: 'code snippets' },
  { table: 'flashcards', label: 'flashcards' },
  { table: 'programming_languages', label: 'languages' },
  { table: 'categories', label: 'categories' },
  { table: 'courses', label: 'courses' },
  { table: 'user_preferences', label: 'preferences' },
  { table: 'profiles', label: 'profile' },
];

/**
 * Translate a PostgREST/GoTrue failure into wording the user can act on.
 * Codes seen in practice: PGRST202 (schema cache miss → function not found),
 * 42501 (insufficient privilege), plus plain network TypeErrors.
 */
function toAccountError(error) {
  const message = String(error?.message || error || 'Account deletion failed');
  const code = String(error?.code || '');

  if (code === 'PGRST202' || /could not find function|function .* does not exist/i.test(message)) {
    return new AppError(
      'Account deletion is not available on this Supabase project yet — '
      + 'run supabase/migrations/0003_account.sql in the SQL editor, then try again. '
      + 'Nothing was deleted.',
      { code: 'delete-missing-rpc', retryable: false },
    );
  }
  if (code === '42501' || /permission denied/i.test(message)) {
    return new AppError(
      'The database refused the deletion (missing privilege) — nothing was deleted. '
      + 'Confirm 0003_account.sql ran to completion as the project owner.',
      { code: 'delete-denied', retryable: false },
    );
  }
  if (error instanceof TypeError || /fetch|network/i.test(message)) {
    return new AppError(
      'Could not reach the account service — check your connection and try again. '
      + 'Nothing was deleted.',
      { code: 'network', retryable: true },
    );
  }
  return new AppError(`Account deletion failed — nothing was deleted. ${message}`, {
    code: 'delete-account',
    retryable: false,
  });
}

/** Per-table failure wording for the reset: says what to do next, honestly. */
function toResetError(error, label) {
  const message = String(error?.message || error || 'unknown error');
  if (error instanceof TypeError || /fetch|network/i.test(message)) {
    return new AppError(
      `Could not reach Supabase while deleting your ${label} — the reset is incomplete. `
      + 'Check your connection and run the reset again; repeating it is safe.',
      { code: 'network', retryable: true },
    );
  }
  if (/row-level security|permission denied|42501/i.test(message)) {
    return new AppError(
      `The database refused to delete your ${label} — run supabase/migrations/0001_init.sql `
      + 'and 0002_profiles.sql in the SQL editor, then run the reset again.',
      { code: 'reset-denied', retryable: false },
    );
  }
  return new AppError(
    `Could not delete your ${label} from the cloud (${message}). `
    + 'Items listed before this point are already gone — run the reset again to finish.',
    { code: 'reset', retryable: false },
  );
}

/**
 * Remove the user's avatar objects from the PUBLIC-read bucket. Strict by
 * design: both operations depend on the photo being gone, and a silent
 * failure would leave a publicly readable image behind.
 * @throws {AppError} before any other change happens
 */
async function removeAvatarObjects(client, userId) {
  let error = null;
  try {
    ({ error } = await client.storage.from(AVATARS_BUCKET).remove([
      `${userId}/avatar.png`,
      `${userId}/avatar.jpg`,
    ]));
  } catch (err) {
    throw new AppError(
      `Could not reach storage to remove your profile photo — nothing was changed. Try again. (${err?.message || err})`,
      { code: 'avatar-cleanup', retryable: true },
    );
  }
  if (error) {
    throw new AppError(
      `Could not remove your profile photo (${error.message}) — nothing was changed. Try again.`,
      { code: 'avatar-cleanup', retryable: true },
    );
  }
}

/**
 * Shared tail of both operations: clear this device's IndexedDB. The remote
 * part has already succeeded at this point, so a local failure is reported
 * separately instead of pretending the whole operation failed.
 * @returns {Promise<{localCleared: boolean}>}
 */
async function wipeLocalAfterCloud() {
  try {
    await wipeLocalDatabase();
    return { localCleared: true };
  } catch (err) {
    console.warn('[account] local wipe failed:', err?.message);
    return { localCleared: false };
  }
}

async function requireSignedInClient(action) {
  const { user } = authStore.get();
  if (!user) {
    throw new AppError(`Sign in to ${action}`, { code: 'signed-out', retryable: false });
  }
  if (!isSupabaseConfigured()) {
    throw new AppError(
      'Cloud sync is not configured, so this account has no uploaded data. '
      + 'Use Settings → Data → “Erase everything” to clear this browser instead.',
      { code: 'not-configured', retryable: false },
    );
  }
  const client = await getSupabaseClient();
  if (!client) {
    throw new AppError('Sign-in service unavailable', { code: 'unavailable', retryable: false });
  }
  return { user, client };
}

/**
 * Delete everything the account owner uploaded, then this browser's copy —
 * while keeping the account and its sign-in (email / Google / GitHub).
 *
 * Order: avatar objects first (public bucket, strict), then every cloud table
 * (RLS bounds each DELETE to auth.uid()), then the local database. Each step
 * fails loudly with the table that failed, and repeating the call is safe.
 *
 * @returns {Promise<{localCleared: boolean}>}
 * @throws {AppError} when the cloud part did not complete
 */
export async function resetUserData() {
  const { user, client } = await requireSignedInClient('reset your data');

  await removeAvatarObjects(client, user.id);

  for (const { table, label } of CLOUD_TABLES) {
    // `.eq('user_id', …)` mirrors the RLS predicate; the policies still decide
    // what may actually go — the client can never widen the scope.
    const { error } = await client.from(table).delete().eq('user_id', user.id);
    if (error) throw toResetError(error, label);
  }

  return wipeLocalAfterCloud();
}

/**
 * Permanently delete the signed-in account: cloud rows + auth user first
 * (server-side, confirmed by the RPC), then this device's local database.
 *
 * Deleting the auth.users row (0003_account.sql cascades the profile) is what
 * frees the email address and the Google/GitHub identity for a NEW account
 * later — nothing is soft-deleted or blocked.
 *
 * Ordering matters: the remote delete is irreversible, so it must succeed
 * before local data is touched.
 *
 * @returns {Promise<{localCleared: boolean}>}
 * @throws {AppError} when the remote deletion did not happen
 */
export async function deleteAccount() {
  const { user, client } = await requireSignedInClient('delete your account');

  await removeAvatarObjects(client, user.id);

  const { error } = await client.rpc('delete_account');
  if (error) throw toAccountError(error);

  return wipeLocalAfterCloud();
}
