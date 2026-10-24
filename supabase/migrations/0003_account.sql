-- =============================================================================
-- DevNotes — account deletion (0003_account.sql)
--
-- Target: a Supabase project that already ran 0001_init.sql and
-- 0002_profiles.sql. Runs two ways: paste into the SQL editor, or
-- `supabase db push`.
--
-- WHY THIS EXISTS (AGENTS.md §11 / §15):
--   The browser only ever holds the publishable anon key, and that key must
--   never delete auth users (auth.admin.deleteUser needs the service-role key,
--   which may not ship in frontend code). Permanent deletion therefore happens
--   server-side, scoped to the caller's own uid by auth.uid(). The Account &
--   Sync page calls it as client.rpc('delete_account') ONLY after the user
--   types DELETE in a confirmation dialog, and reports the real database error
--   when this migration has not been applied — success is never claimed
--   before the call resolves.
--
-- WHAT IT DELETES for auth.uid():
--   * the caller's rows in the 7 sync tables. Those tables have NO foreign
--     keys by design (see the header of 0001_init.sql), so they must be
--     removed explicitly instead of cascading.
--   * the auth.users row. public.profiles references it ON DELETE CASCADE
--     (0002_profiles.sql), so the profile row and the auto-provision trigger's
--     output go with it.
--   * nothing else: avatar objects under devnotes-avatars are removed by the
--     CLIENT before this call (the owner-only DELETE policy allows it), and
--     other users' data is unreachable because every statement is keyed by
--     auth.uid().
--
-- SECURITY:
--   * SECURITY DEFINER so the authenticated caller — whose role has no DELETE
--     privilege on auth.users — can remove only their OWN row. No statement
--     takes client input; auth.uid() is NULL for anon callers, and the guard
--     below raises before anything is deleted.
--   * EXECUTE is revoked from PUBLIC/anon and granted to `authenticated` only.
--   * No secrets in this file (AGENTS.md §19).
--
-- VERIFY AFTER RUNNING — this file could not be exercised without a live
-- project and real credentials (AGENTS.md §17: never report unrun tests as
-- passing). Sign in to the app, use Account & Sync → Delete account, and
-- confirm the user disappears from Authentication → Users; a missing function
-- or a missing privilege surfaces in the UI with the exact message below.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- delete_account — remove the caller's cloud data and their auth user.
-- Idempotent enough to re-run: CREATE OR REPLACE keeps this migration safe to
-- apply repeatedly.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_uid uuid := auth.uid();
BEGIN
  IF target_uid IS NULL THEN
    RAISE EXCEPTION 'delete_account: no authenticated user';
  END IF;

  -- 7 sync tables from 0001_init.sql (no FKs between them or to auth.users).
  DELETE FROM public.lessons               WHERE user_id = target_uid;
  DELETE FROM public.code_snippets         WHERE user_id = target_uid;
  DELETE FROM public.flashcards            WHERE user_id = target_uid;
  DELETE FROM public.programming_languages WHERE user_id = target_uid;
  DELETE FROM public.categories            WHERE user_id = target_uid;
  DELETE FROM public.courses               WHERE user_id = target_uid;
  DELETE FROM public.user_preferences      WHERE user_id = target_uid;

  -- public.profiles cascades from auth.users (0002_profiles.sql).
  DELETE FROM auth.users                 WHERE id = target_uid;
END;
$$;

-- Default PostgreSQL privileges grant EXECUTE to PUBLIC; take that back before
-- granting it to the one role that may call it.
REVOKE EXECUTE ON FUNCTION public.delete_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_account() TO authenticated;
