-- =============================================================================
-- DevNotes — initial Supabase schema (0001_init.sql)
--
-- Target: a Supabase project (the `auth` and `storage` schemas must exist).
-- Runs two ways: paste into the SQL editor, or `supabase db push`.
--
-- Idempotent where practical: CREATE TABLE / CREATE INDEX IF NOT EXISTS,
-- DROP POLICY IF EXISTS + CREATE POLICY, CREATE OR REPLACE VIEW, and
-- ON CONFLICT for the storage bucket. Limitation: CREATE TABLE IF NOT EXISTS
-- will NOT retrofit columns or constraints onto a table that already exists,
-- so run this on a fresh database (or review by hand first).
--
-- No secrets live in this file (AGENTS.md §19).
--
-- -----------------------------------------------------------------------------
-- REVISION / CONFLICT PROTOCOL (AGENTS.md §12) — mirrored by
-- src/scripts/sync/remote-api.js; documented again in the
-- public.devnotes_schema_info view below.
--
--   1. READ   the row's `revision` (SELECT revision, updated_at …).
--   2. COMPARE remote revision against the client's `baseRevision`.
--      If remote is newer, the client aborts and stores a local conflict —
--      it never overwrites newer remote content with stale local data.
--   3. WRITE  an upsert (ON CONFLICT (id)) sending every content column plus
--      revision = remoteRevision + 1, user_id = authenticated user,
--      updated_at = client-generated ISO timestamp.
--
-- `baseRevision` is client-only bookkeeping and is NEVER sent to the server —
-- these tables deliberately have no such column.
--
-- KNOWN RACE WINDOW: steps 1 and 3 are not a single atomic statement, so two
-- devices writing the same row "simultaneously" could both pass the check.
-- This is accepted and documented because DevNotes is a single-user-per-device
-- app (AGENTS.md §12); the window is negligible outside concurrent writers on
-- the same account. Making it atomic would require a server-side RPC instead
-- of the client-driven upsert the sync layer uses.
--
-- `user_preferences` is the exception: one blob row (id = 'app') where merging
-- is meaningless, so it uses last-writer-wins on `updated_at` (the sync layer
-- still bumps `revision` for observability).
--
-- NOTE ON FOREIGN KEYS: none are declared on purpose. Records sync
-- entity-by-entity with independent queues and soft deletes (`trashed`), so an
-- FK would reject legitimate pushes whenever a referenced row has not synced
-- yet or was soft-deleted (AGENTS.md §18 — unusual trade-off, documented here).
-- Referential integrity is maintained by the application layer instead.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- lessons — primary knowledge record (local entity `lesson`).
-- Markdown `content` + `notes`, taxonomy links (languageId / categoryId /
-- courseId are soft references), study status/difficulty, review scheduling
-- (`reviewAt`), and trash lifecycle (`trashed` + `trashAt`).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lessons (
  id                text PRIMARY KEY,
  slug              text,
  title             text,
  "languageId"      text,
  "categoryId"      text,
  "courseId"        text,
  tags              jsonb DEFAULT '[]'::jsonb,
  summary           text,
  content           text,
  notes             text,
  difficulty        text,
  status            text,
  favorite          boolean DEFAULT false,
  pinned            boolean DEFAULT false,
  archived          boolean DEFAULT false,
  trashed           boolean DEFAULT false,
  "trashAt"         bigint,
  "reviewAt"        bigint,
  "sourceUrls"      jsonb DEFAULT '[]'::jsonb,
  "order"           bigint,
  revision          bigint NOT NULL DEFAULT 1,
  "createdAt"       bigint,
  "lastOpenedAt"    bigint,
  -- Ownership + sync bookkeeping (added for every table, see header above).
  user_id           uuid NOT NULL DEFAULT auth.uid(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lessons_user_id_never_null CHECK (user_id IS NOT NULL),
  CONSTRAINT lessons_revision_min CHECK (revision >= 1),
  -- Enums stored as text; NULL allowed so older/odd rows never hard-fail.
  CONSTRAINT lessons_status_valid CHECK (
    status IS NULL OR status IN ('not-started', 'learning', 'learned')
  ),
  CONSTRAINT lessons_difficulty_valid CHECK (
    difficulty IS NULL OR difficulty IN ('', 'beginner', 'intermediate', 'advanced')
  )
);

-- -----------------------------------------------------------------------------
-- code_snippets — saved code samples (local entity `snippet`).
-- `language` here is the highlighter/language name (text), unrelated to the
-- programming_languages table. Soft-delete mirrors lessons.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.code_snippets (
  id           text PRIMARY KEY,
  name         text,
  description  text,
  language     text,
  code         text,
  tags         jsonb DEFAULT '[]'::jsonb,
  "lessonId"   text,
  favorite     boolean DEFAULT false,
  trashed      boolean DEFAULT false,
  "trashAt"    bigint,
  revision     bigint NOT NULL DEFAULT 1,
  "createdAt"  bigint,
  user_id      uuid NOT NULL DEFAULT auth.uid(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_snippets_user_id_never_null CHECK (user_id IS NOT NULL),
  CONSTRAINT code_snippets_revision_min CHECK (revision >= 1)
);

-- -----------------------------------------------------------------------------
-- flashcards — spaced-repetition cards (local entity `flashcard`).
-- `source` distinguishes manually created cards from AI-generated ones;
-- AI cards arrive with approved = false and only count once approved (§11/§13).
-- `box` is the Leitner box (>= 1); `dueAt` is an epoch-ms review timestamp.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.flashcards (
  id           text PRIMARY KEY,
  front        text,
  back         text,
  "lessonId"   text,
  tags         jsonb DEFAULT '[]'::jsonb,
  source       text,
  approved     boolean DEFAULT true,
  box          integer DEFAULT 1,
  "dueAt"      bigint,
  "createdAt"  bigint,
  trashed      boolean DEFAULT false,
  revision     bigint NOT NULL DEFAULT 1,
  user_id      uuid NOT NULL DEFAULT auth.uid(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flashcards_user_id_never_null CHECK (user_id IS NOT NULL),
  CONSTRAINT flashcards_revision_min CHECK (revision >= 1),
  CONSTRAINT flashcards_source_valid CHECK (source IS NULL OR source IN ('manual', 'ai')),
  CONSTRAINT flashcards_box_min CHECK (box >= 1)
);

-- -----------------------------------------------------------------------------
-- programming_languages / categories / courses — the taxonomy trio (local
-- entities `language`, `category`, `course`); identical column shape by design
-- so the shared client mapping stays simple.
--   kind  = which entity created the row: 'language' | 'category' | 'course'
--           (enforced here as a shared set; in practice each table holds its
--           own kind — see src/scripts/utils/validate.js normalizeTaxonomy).
--   type  = languages carry a sub-type ('language' | 'framework' | 'library' |
--           'topic'); categories/courses store '' (empty string).
--   parentId = soft reference for tree nesting (no FK — see header note).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.programming_languages (
  id           text PRIMARY KEY,
  kind         text,
  name         text,
  slug         text,
  description  text,
  type         text,
  "parentId"   text,
  "order"      bigint,
  revision     bigint NOT NULL DEFAULT 1,
  "createdAt"  bigint,
  trashed      boolean DEFAULT false,
  user_id      uuid NOT NULL DEFAULT auth.uid(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programming_languages_user_id_never_null CHECK (user_id IS NOT NULL),
  CONSTRAINT programming_languages_revision_min CHECK (revision >= 1),
  CONSTRAINT programming_languages_kind_valid CHECK (
    kind IS NULL OR kind IN ('language', 'category', 'course')
  ),
  CONSTRAINT programming_languages_type_valid CHECK (
    type IS NULL OR type IN ('', 'language', 'framework', 'library', 'topic')
  )
);

CREATE TABLE IF NOT EXISTS public.categories (
  id           text PRIMARY KEY,
  kind         text,
  name         text,
  slug         text,
  description  text,
  type         text,
  "parentId"   text,
  "order"      bigint,
  revision     bigint NOT NULL DEFAULT 1,
  "createdAt"  bigint,
  trashed      boolean DEFAULT false,
  user_id      uuid NOT NULL DEFAULT auth.uid(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_user_id_never_null CHECK (user_id IS NOT NULL),
  CONSTRAINT categories_revision_min CHECK (revision >= 1),
  CONSTRAINT categories_kind_valid CHECK (
    kind IS NULL OR kind IN ('language', 'category', 'course')
  ),
  CONSTRAINT categories_type_valid CHECK (
    type IS NULL OR type IN ('', 'language', 'framework', 'library', 'topic')
  )
);

CREATE TABLE IF NOT EXISTS public.courses (
  id           text PRIMARY KEY,
  kind         text,
  name         text,
  slug         text,
  description  text,
  type         text,
  "parentId"   text,
  "order"      bigint,
  revision     bigint NOT NULL DEFAULT 1,
  "createdAt"  bigint,
  trashed      boolean DEFAULT false,
  user_id      uuid NOT NULL DEFAULT auth.uid(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT courses_user_id_never_null CHECK (user_id IS NOT NULL),
  CONSTRAINT courses_revision_min CHECK (revision >= 1),
  CONSTRAINT courses_kind_valid CHECK (
    kind IS NULL OR kind IN ('language', 'category', 'course')
  ),
  CONSTRAINT courses_type_valid CHECK (
    type IS NULL OR type IN ('', 'language', 'framework', 'library', 'topic')
  )
);

-- -----------------------------------------------------------------------------
-- user_preferences — single settings blob per user (local entity
-- `preferences`, always id = 'app'). Synced with last-writer-wins on
-- updated_at instead of conflict detection; `revision` is still bumped by the
-- client on every accepted write so the row remains observable in the queue.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_preferences (
  id          text PRIMARY KEY,
  key         text,
  value       jsonb,
  revision    bigint NOT NULL DEFAULT 1,
  user_id     uuid NOT NULL DEFAULT auth.uid(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_preferences_user_id_never_null CHECK (user_id IS NOT NULL),
  CONSTRAINT user_preferences_revision_min CHECK (revision >= 1)
);


-- =============================================================================
-- Row Level Security — every table, no exceptions (AGENTS.md §11).
--
-- All policies are scoped `TO authenticated`, so the `anon` role has no
-- policy at all and therefore no access (RLS default-deny when a role has no
-- matching policy). There is intentionally NO permissive/bypass policy and no
-- policy usable without a session; `auth.uid()` is NULL outside a session,
-- which can never satisfy `auth.uid() = user_id`.
--
-- The column default `user_id uuid NOT NULL DEFAULT auth.uid()` combined with
-- the INSERT policy means an attempt to write a row owned by ANOTHER user
-- fails twice over: the WITH CHECK rejects a user_id different from the
-- caller, and inserting without user_id resolves the default to the caller's
-- own uid (or to NULL → NOT NULL violation when there is no session).
--
-- The Supabase table owner / SQL editor (postgres) and the `service_role`
-- bypass or satisfy RLS as platform internals; the API-facing roles
-- (anon/authenticated) never do. No `FORCE ROW LEVEL SECURITY` is used on
-- purpose so migrations remain runnable from the SQL editor.
-- =============================================================================

ALTER TABLE public.lessons             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_snippets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flashcards          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programming_languages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences    ENABLE ROW LEVEL SECURITY;

-- lessons
DROP POLICY IF EXISTS "lessons_select_own" ON public.lessons;
CREATE POLICY "lessons_select_own" ON public.lessons
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "lessons_insert_own" ON public.lessons;
CREATE POLICY "lessons_insert_own" ON public.lessons
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "lessons_update_own" ON public.lessons;
CREATE POLICY "lessons_update_own" ON public.lessons
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "lessons_delete_own" ON public.lessons;
CREATE POLICY "lessons_delete_own" ON public.lessons
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- code_snippets
DROP POLICY IF EXISTS "code_snippets_select_own" ON public.code_snippets;
CREATE POLICY "code_snippets_select_own" ON public.code_snippets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "code_snippets_insert_own" ON public.code_snippets;
CREATE POLICY "code_snippets_insert_own" ON public.code_snippets
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "code_snippets_update_own" ON public.code_snippets;
CREATE POLICY "code_snippets_update_own" ON public.code_snippets
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "code_snippets_delete_own" ON public.code_snippets;
CREATE POLICY "code_snippets_delete_own" ON public.code_snippets
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- flashcards
DROP POLICY IF EXISTS "flashcards_select_own" ON public.flashcards;
CREATE POLICY "flashcards_select_own" ON public.flashcards
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "flashcards_insert_own" ON public.flashcards;
CREATE POLICY "flashcards_insert_own" ON public.flashcards
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "flashcards_update_own" ON public.flashcards;
CREATE POLICY "flashcards_update_own" ON public.flashcards
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "flashcards_delete_own" ON public.flashcards;
CREATE POLICY "flashcards_delete_own" ON public.flashcards
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- programming_languages
DROP POLICY IF EXISTS "programming_languages_select_own" ON public.programming_languages;
CREATE POLICY "programming_languages_select_own" ON public.programming_languages
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "programming_languages_insert_own" ON public.programming_languages;
CREATE POLICY "programming_languages_insert_own" ON public.programming_languages
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "programming_languages_update_own" ON public.programming_languages;
CREATE POLICY "programming_languages_update_own" ON public.programming_languages
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "programming_languages_delete_own" ON public.programming_languages;
CREATE POLICY "programming_languages_delete_own" ON public.programming_languages
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- categories
DROP POLICY IF EXISTS "categories_select_own" ON public.categories;
CREATE POLICY "categories_select_own" ON public.categories
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "categories_insert_own" ON public.categories;
CREATE POLICY "categories_insert_own" ON public.categories
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "categories_update_own" ON public.categories;
CREATE POLICY "categories_update_own" ON public.categories
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "categories_delete_own" ON public.categories;
CREATE POLICY "categories_delete_own" ON public.categories
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- courses
DROP POLICY IF EXISTS "courses_select_own" ON public.courses;
CREATE POLICY "courses_select_own" ON public.courses
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "courses_insert_own" ON public.courses;
CREATE POLICY "courses_insert_own" ON public.courses
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "courses_update_own" ON public.courses;
CREATE POLICY "courses_update_own" ON public.courses
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "courses_delete_own" ON public.courses;
CREATE POLICY "courses_delete_own" ON public.courses
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- user_preferences
DROP POLICY IF EXISTS "user_preferences_select_own" ON public.user_preferences;
CREATE POLICY "user_preferences_select_own" ON public.user_preferences
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "user_preferences_insert_own" ON public.user_preferences;
CREATE POLICY "user_preferences_insert_own" ON public.user_preferences
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "user_preferences_update_own" ON public.user_preferences;
CREATE POLICY "user_preferences_update_own" ON public.user_preferences
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "user_preferences_delete_own" ON public.user_preferences;
CREATE POLICY "user_preferences_delete_own" ON public.user_preferences
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Defense in depth: table privileges for the API roles only. The `anon` role
-- gets no grant at all, so even without RLS evaluation it cannot touch data.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lessons              TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.code_snippets        TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcards           TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.programming_languages TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.categories           TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.courses              TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preferences     TO authenticated, service_role;


-- =============================================================================
-- Indexes — tuned for the two client access patterns (see remote-api.js):
--   * pull:     WHERE user_id = <me> AND updated_at > <cursor>
--               ORDER BY updated_at ASC LIMIT 500      → (user_id, updated_at)
--               plus a plain updated_at index so the unfiltered/global cursor
--               sort stays cheap and Postgres has a matching alternative.
--   * id scan:  ORDER BY id … RANGE (paging)           → primary key (id).
-- lessons additionally filters on `trashed` everywhere → (user_id, trashed).
--
-- NO trigger sets `updated_at`. The sync client sends its own timestamp on
-- every write (see remote-api.js toRow()), because local edits carry their
-- real local time and the pull cursor compares client-generated timestamps.
-- A trigger overwriting updated_at with now() would corrupt that cursor and
-- break change detection for edits that share a server second.
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_lessons_user_updated_at       ON public.lessons (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_lessons_updated_at            ON public.lessons (updated_at);
CREATE INDEX IF NOT EXISTS idx_lessons_user_trashed          ON public.lessons (user_id, trashed);
CREATE INDEX IF NOT EXISTS idx_code_snippets_user_updated_at ON public.code_snippets (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_code_snippets_updated_at      ON public.code_snippets (updated_at);
CREATE INDEX IF NOT EXISTS idx_flashcards_user_updated_at    ON public.flashcards (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_flashcards_updated_at         ON public.flashcards (updated_at);
CREATE INDEX IF NOT EXISTS idx_programming_languages_user_updated_at ON public.programming_languages (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_programming_languages_updated_at      ON public.programming_languages (updated_at);
CREATE INDEX IF NOT EXISTS idx_categories_user_updated_at    ON public.categories (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_categories_updated_at         ON public.categories (updated_at);
CREATE INDEX IF NOT EXISTS idx_courses_user_updated_at       ON public.courses (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_courses_updated_at            ON public.courses (updated_at);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_updated_at ON public.user_preferences (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_user_preferences_updated_at   ON public.user_preferences (updated_at);


-- =============================================================================
-- Schema / protocol documentation view (requirement: discoverable revision
-- protocol). It contains ONLY static metadata — no user rows — so exposing it
-- leaks nothing; SELECT is still granted to authenticated users only.
-- =============================================================================
CREATE OR REPLACE VIEW public.devnotes_schema_info AS
SELECT v.table_name, v.local_entity, v.conflict_mode, v.protocol
FROM (VALUES
  ('lessons', 'lesson', 'revision',
   'read remote revision -> compare with baseRevision -> upsert with revision = remote + 1; non-atomic read-then-write race window is acceptable for single-user-per-device use'),
  ('code_snippets', 'snippet', 'revision',
   'read remote revision -> compare with baseRevision -> upsert with revision = remote + 1; non-atomic read-then-write race window is acceptable for single-user-per-device use'),
  ('flashcards', 'flashcard', 'revision',
   'read remote revision -> compare with baseRevision -> upsert with revision = remote + 1; non-atomic read-then-write race window is acceptable for single-user-per-device use'),
  ('programming_languages', 'language', 'revision',
   'read remote revision -> compare with baseRevision -> upsert with revision = remote + 1; non-atomic read-then-write race window is acceptable for single-user-per-device use'),
  ('categories', 'category', 'revision',
   'read remote revision -> compare with baseRevision -> upsert with revision = remote + 1; non-atomic read-then-write race window is acceptable for single-user-per-device use'),
  ('courses', 'course', 'revision',
   'read remote revision -> compare with baseRevision -> upsert with revision = remote + 1; non-atomic read-then-write race window is acceptable for single-user-per-device use'),
  ('user_preferences', 'preferences', 'last-writer-wins',
   'single blob row (id = app); newest updated_at wins, no conflict dialog; revision is still bumped on every accepted write')
) AS v(table_name, local_entity, conflict_mode, protocol);

REVOKE ALL ON public.devnotes_schema_info FROM PUBLIC;
GRANT SELECT ON public.devnotes_schema_info TO authenticated;


-- =============================================================================
-- Storage — private export bucket.
--
-- The app does NOT auto-upload local files (AGENTS.md §14): IndexedDB stays the
-- authoritative local store, and exports download to the user's machine by
-- default. This bucket exists ONLY for explicitly configured export/backup
-- operations that a user opts into; it is private (`public = false`) and each
-- user may only touch objects under a folder named with their own uid.
--
-- (storage.foldername(name))[1] is the top-level folder of the object path;
-- objects stored at the bucket root produce NULL and are denied.
-- =============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('devnotes-exports', 'devnotes-exports', false)
ON CONFLICT (id) DO UPDATE SET public = false; -- keep it private even if it pre-existed

DROP POLICY IF EXISTS "devnotes_exports_select" ON storage.objects;
CREATE POLICY "devnotes_exports_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'devnotes-exports'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "devnotes_exports_insert" ON storage.objects;
CREATE POLICY "devnotes_exports_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'devnotes-exports'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "devnotes_exports_update" ON storage.objects;
CREATE POLICY "devnotes_exports_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'devnotes-exports'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'devnotes-exports'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "devnotes_exports_delete" ON storage.objects;
CREATE POLICY "devnotes_exports_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'devnotes-exports'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Our storage policies are bucket-scoped and additive. If an older project
-- carries legacy permissive policies on storage.objects, review them with:
--   SELECT policyname, cmd, qual FROM pg_policies WHERE schemaname = 'storage';


-- =============================================================================
-- Per-table summary (also visible via public.devnotes_schema_info):
--   lessons             — Markdown lessons; taxonomy links, status/difficulty,
--                         review scheduling, trash lifecycle.
--   code_snippets       — saved snippets with highlighter language names.
--   flashcards          — Leitner cards; source = manual | ai, approval gate.
--   programming_languages / categories / courses — identical taxonomy trio.
--   user_preferences    — single settings blob (id = 'app'), LWW on updated_at.
-- Every table: user_id (never NULL) + updated_at (client-supplied, no trigger),
-- RLS on, owned-row policies only, revision >= 1 with the protocol documented
-- in the view above. No secrets are stored here (AGENTS.md §19).
-- =============================================================================
