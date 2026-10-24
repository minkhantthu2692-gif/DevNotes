-- =============================================================================
-- DevNotes — profiles + avatar storage (0002_profiles.sql)
--
-- Target: a Supabase project that already ran 0001_init.sql (the `auth` and
-- `storage` schemas exist). Runs two ways: paste into the SQL editor, or
-- `supabase db push`.okay 
--
-- Adds the account layer on top of the sync schema:
--   * public.profiles — one row per authenticated user (username, name, bio,
--     avatar). RLS-scoped to auth.uid(), mirroring 0001_init.sql's policy
--     style, so a user can only ever read or write their OWN row.
--   * storage bucket `devnotes-avatars` — PUBLIC READ (so <img src> works in
--     the header on every route) with owner-only WRITE enforced by RLS on the
--     per-user folder, same folder-scoped policy shape as `devnotes-exports`.
--   * a trigger that auto-creates + auto-seeds a profile row the first time a
--     user signs in (OAuth metadata / email local part), so every account has
--     a username + avatar without a client round-trip race.
--
-- SECURITY NOTES (AGENTS.md §11/§19):
--   * No secrets here. The anon/publishable key is the only thing the browser
--     sees, and RLS below is what actually protects the data.
--   * The avatar bucket is PUBLIC READ but owner-only WRITE. This is a
--     deliberate, documented exception to "private by default": the photo is
--     rendered by <img src> on every route, and a private bucket would need a
--     signed URL per render that expires and breaks offline. What stays locked
--     down is the write path — the INSERT/UPDATE/DELETE policies below scope
--     every object to the uploader's own uid folder, so no user can replace or
--     delete another user's photo, and reads of the profiles row itself remain
--     private via RLS. Full reasoning is in the Storage section further down.
--   * `auth.uid()` is NULL outside a session, so no policy can ever match an
--     unauthenticated caller — the same default-deny posture as 0001_init.sql.
--
-- IDEMPOTENT where practical: CREATE TABLE / INDEX IF NOT EXISTS,
-- DROP POLICY IF EXISTS + CREATE POLICY, CREATE OR REPLACE FUNCTION/TRIGGER.
-- Like 0001_init.sql, CREATE TABLE IF NOT EXISTS will NOT retrofit columns
-- onto an existing table; run on a database that has not yet got `profiles`.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- profiles — public account identity for one authenticated user.
--
-- `user_id` is the ownership key and mirrors auth.users. `username` is the
-- handle shown in the header and account page; it is unique per user and is
-- seeded automatically (see the trigger below) so it is nullable at the column
-- level only to survive the brief window before the trigger writes it.
--
-- `avatar_url` holds a signed/object URL for a self-hosted image, or NULL when
-- the account uses the generated initial-avatar. It is nullable because the
-- generated avatar needs no storage at all.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id      uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username     text,
  full_name    text,
  bio          text,
  avatar_url   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_username_unique UNIQUE (username),
  -- Keep usernames short and sane even though the client also validates.
  CONSTRAINT profiles_username_len CHECK (username IS NULL OR char_length(username) BETWEEN 2 AND 30),
  CONSTRAINT profiles_bio_len CHECK (bio IS NULL OR char_length(bio) <= 160)
);

-- Pull-by-user / ordering support (matches 0001_init.sql's index style).
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON public.profiles (updated_at);


-- -----------------------------------------------------------------------------
-- Row Level Security — owned-row access only (AGENTS.md §11).
--
-- Scoping every policy to `auth.uid() = user_id` means a user can never read or
-- write anyone else's profile: the `anon` role has no policy at all (default
-- deny), and even an authenticated user fails the predicate for foreign rows.
-- No permissive/bypass policy is added on purpose.
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles;
CREATE POLICY "profiles_delete_own" ON public.profiles
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Defense in depth: grant the API roles explicitly, never `anon`.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- Auto-provision a profile row on first sign-in.
--
-- Why a trigger instead of the client: the client cannot insert the row in the
-- same transaction as the auth event, so a fresh OAuth user could briefly have
-- no profile (no username/avatar in the header). Firing from auth.users keeps
-- the guarantee "every account has a profile" inside the database, and the seed
-- values mirror exactly what the client derives (see features/account/profile.js):
--   username  = OAuth user_name / preferred_username / login, else the email's
--               local part, cleaned to [a-z0-9._-] and truncated to 30 chars.
--   full_name = OAuth full_name / name.
--   avatar_url= OAuth avatar_url / picture (an https URL only).
--
-- SECURITY: the username derived from user_metadata is attacker-influenced (the
-- user controls their own metadata). It is therefore sanitized here — control
-- and non-username characters are stripped — and `ON CONFLICT DO NOTHING`
-- absorbs the unique-constraint race by appending a short random suffix rather
-- than failing the sign-in. Nothing here trusts metadata for authorization.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.devnotes_bootstrap_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta       jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  v_username   text;
  v_full_name  text;
  v_avatar     text;
  v_attempt    int := 0;
BEGIN
  -- Seed values from provider metadata, with the email local part as fallback.
  v_full_name := NULLIF(
    COALESCE(v_meta->>'full_name', v_meta->>'name', ''),
    ''
  );

  v_username := regexp_replace(
    lower(
      COALESCE(
        v_meta->>'user_name',
        v_meta->>'preferred_username',
        v_meta->>'login',
        COALESCE(v_meta->>'full_name', v_meta->>'name', ''),
        split_part(NEW.email, '@', 1)
      )
    ),
    '[^a-z0-9._-]', '', 'g'
  );
  v_username := left(v_username, 30);

  v_avatar := COALESCE(v_meta->>'avatar_url', v_meta->>'picture');
  IF v_avatar IS NULL OR v_avatar !~* '^https?://' THEN
    v_avatar := NULL; -- refuse non-http(s): a data:/javascript: URL must never be stored
  END IF;

  -- Must still look like a username after sanitizing; otherwise fall back to a
  -- stable opaque handle derived from the user id so the row is never blank.
  IF v_username IS NULL OR v_username !~ '^[a-z0-9][a-z0-9._-]*$' THEN
    v_username := 'user-' || left(replace(NEW.id::text, '-', ''), 10);
  END IF;

  -- Resolve unique-concurrency races with a bounded numeric suffix.
  LOOP
    BEGIN
      INSERT INTO public.profiles (user_id, username, full_name, avatar_url)
      VALUES (NEW.id, v_username, v_full_name, v_avatar)
      ON CONFLICT (user_id) DO NOTHING;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN
        RAISE; -- give up loudly rather than loop forever
      END IF;
      v_username := left(v_username, 24) || '-' || v_attempt::text;
    END;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_devnotes_bootstrap_profile ON auth.users;
CREATE TRIGGER trg_devnotes_bootstrap_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.devnotes_bootstrap_profile();


-- Backfill profiles for accounts that signed in BEFORE this migration ran, so
-- existing users get a username/avatar too. Mirrors the trigger's sanitizing.
--
-- Collision safety: `username` is UNIQUE, and two different users can easily
-- sanitize to the same handle (john.smith@ and john_smith@ both → john.smith).
-- A plain INSERT would raise unique_violation and abort the whole migration, so
-- we resolve every clash up front, set-based:
--   * a base handle already taken by an EXISTING profile row falls back to the
--     same uid-derived handle the trigger uses;
--   * duplicates WITHIN this batch are de-duplicated with row_number() and a
--     -1/-2/… suffix, matching the trigger's numeric-suffix format.
-- `username` stays nullable, so any user we cannot name simply gets NULL and is
-- named later by loadProfile() rather than blocking everyone else.
-- NOT EXISTS on user_id makes this idempotent: a re-run skips users who already
-- have a profile.
WITH candidates AS (
  SELECT
    u.id AS user_id,
    left(
      regexp_replace(
        lower(
          COALESCE(
            u.raw_user_meta_data->>'user_name',
            u.raw_user_meta_data->>'preferred_username',
            u.raw_user_meta_data->>'login',
            COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''),
            split_part(u.email, '@', 1)
          )
        ),
        '[^a-z0-9._-]', '', 'g'
      ),
      30
    ) AS base_username,
    NULLIF(COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''), '') AS full_name,
    CASE
      WHEN COALESCE(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture') ~* '^https?://'
        THEN COALESCE(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
      ELSE NULL
    END AS avatar_url
  FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id)
),
deduped AS (
  SELECT
    c.user_id,
    c.full_name,
    c.avatar_url,
    -- De-duplicate WITHIN this batch first.
    row_number() OVER (PARTITION BY c.base_username ORDER BY c.user_id) AS dup_rank,
    c.base_username
  FROM candidates c
)
INSERT INTO public.profiles (user_id, username, full_name, avatar_url)
SELECT
  d.user_id,
  CASE
    -- Handle collides with a row that already exists → opaque uid-based name.
    WHEN EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.username = d.base_username
    ) THEN 'user-' || left(replace(d.user_id::text, '-', ''), 10)
    -- Second+ occurrence inside this batch → numeric suffix.
    WHEN d.dup_rank > 1 THEN left(d.base_username, 24) || '-' || (d.dup_rank - 1)::text
    ELSE d.base_username
  END,
  d.full_name,
  d.avatar_url
FROM deduped d
ON CONFLICT (user_id) DO NOTHING;


-- =============================================================================
-- Storage — per-user avatar bucket (PUBLIC READ, owner-only write).
--
-- This is the one deliberate exception to "Storage is private by default"
-- (AGENTS.md §11). `devnotes-exports` stays private; the avatar bucket does
-- not, for a concrete reason: the photo is rendered by <img src> in the header
-- on EVERY route. A private bucket would force a createSignedUrl() round-trip
-- per render, those URLs expire (default 1h), and the header would break after
-- expiry or when offline — unacceptable for a picture that is by definition
-- non-sensitive.
--
-- What is protected is the WRITE path. Each user may only insert, update or
-- delete objects under a folder named with their own uid
-- ((storage.foldername(name))[1]); objects at the bucket root produce NULL and
-- are denied. So while the image is readable, no one can replace or delete
-- another user's photo, and nothing can be uploaded to someone else's folder.
--
-- Nothing is auto-uploaded; the app writes here only when the user explicitly
-- picks a photo in Account.
-- =============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('devnotes-avatars', 'devnotes-avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true; -- public read; writes stay policy-gated

DROP POLICY IF EXISTS "devnotes_avatars_insert" ON storage.objects;
CREATE POLICY "devnotes_avatars_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'devnotes-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "devnotes_avatars_update" ON storage.objects;
CREATE POLICY "devnotes_avatars_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'devnotes-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'devnotes-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "devnotes_avatars_delete" ON storage.objects;
CREATE POLICY "devnotes_avatars_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'devnotes-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- =============================================================================
-- Summary
--   public.profiles               — one owned row per user (username/name/bio/
--                                   avatar), RLS-scoped to auth.uid(), seeded
--                                   automatically at first sign-in.
--   storage devnotes-avatars      — PUBLIC READ (needed for <img src> on every
--                                   route), per-user folder, owner-only write
--                                   via RLS. See the block above for why.
--   trigger on auth.users         — creates + seeds the profile row.
--   backfill                      — seeds profiles for pre-existing accounts.
-- No secrets are stored here (AGENTS.md §19).
-- =============================================================================
