# DevNotes

A personal, **offline-first programming knowledge workspace**: lessons with a Markdown editor, code snippets, flashcard review, an AI assistant, and optional cloud sync — built with plain HTML, CSS and native ES modules. No framework, no build step, no application server.

Your library lives in **IndexedDB in your browser**. Everything works locally and offline with zero configuration; Supabase (sync/auth) and Groq (AI) are strictly optional add-ons.

---

## Contents

- [Features](#features)
- [Browser requirements](#browser-requirements)
- [Running locally](#running-locally)
- [Deploying (static hosting)](#deploying-static-hosting)
- [Folder structure](#folder-structure)
- [Configuration: what is required vs optional](#configuration-what-is-required-vs-optional)
- [Supabase setup (sync + accounts) — optional](#supabase-setup-sync--accounts--optional)
- [AI setup (Groq) — optional](#ai-setup-groq--optional)
- [How synchronization works](#how-synchronization-works)
- [Offline behavior](#offline-behavior)
- [Backup and restore](#backup-and-restore)
- [Fonts](#fonts)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Licenses](#licenses)

Burmese readers: [အပြည့်အဝ ဆက်တင်လမ်းညွှန် (မြန်မာဘာသာ)](SETUP_MY.md) — step-by-step setup for Supabase, GitHub (Pages + OAuth), Google OAuth and Groq AI.

---

## Features

**Core (no configuration needed)**

- Dashboard with due reviews, recent lessons, library stats and quick actions
- Lesson library: Markdown editor with autosave, status/difficulty, tags, favorites, search with filters (`lang:`, `tag:`, `is:favorite`, `has:code`, …), bulk actions, sortable lists
- Syntax highlighting (193 bundled languages) with copy buttons, optional line numbers and code wrapping
- Code snippet library with language tagging and lesson linking
- Flashcard review (Leitner 5-box scheduling) with keyboard-driven study sessions
- Languages / Categories / Courses management, including a Trash with restore and purge
- Activity timeline and per-lesson revision history with restore
- Import/export: versioned JSON backups plus a ZIP with Markdown mirrors, preview before import, explicit **merge** vs **replace** modes
- Light / dark / system theme, accent colors, typography controls, user-imported fonts
- Fully usable offline after the first load (service worker shell cache)

**Optional (configuration below)**

- Cloud sync with a persistent operation queue, conflict detection and manual resolution
- Email/password accounts, plus Google/GitHub OAuth once providers are configured
- AI assistant, AI-drafted flashcards (which always require your approval) and AI writing help in the editor — via your own Groq key (BYOK) or a server-side proxy

## Browser requirements

- A current Chromium, Firefox or Safari (last ~2 years): native ES modules, IndexedDB, `localStorage`, Service Worker, `crypto.randomUUID`
- **A secure context is required for sync/AI/service worker**: `https://` or `http://localhost` / `http://127.0.0.1`
- Opening `index.html` directly with `file://` does **not** work: browsers block ES module imports (and service workers) from `file://`. Use any static web server (below) — this is a browser limitation, not a missing DevNotes feature

## Running locally

No build, no dependencies are required to *run* the app — any static file server works:

```sh
# Option A: the bundled script (downloads `serve` via npx on first run)
npm run serve            # → http://localhost:4173

# Option B: Python
python -m http.server 4173

# Option C: whatever you already use for static sites
npx http-server -p 4173
```

Then open <http://localhost:4173>. Node is used **only** for development tooling and tests — never at runtime.

## Deploying (static hosting)

DevNotes is a static site. Upload the repository root (everything except `node_modules/`, `tests/`, `tools/`, `supabase/` is optional) to any static host (Netlify, Cloudflare Pages, GitHub Pages, S3 + CloudFront, nginx, …):

- `index.html` must be the directory index; keep the `src/` and `sw.js` paths intact
- Serve over **HTTPS** (required for the service worker and, if enabled, OAuth)
- Serve `.webmanifest` as `application/manifest+json`, `.js` as `text/javascript`, `.woff2` as `font/woff2`
- After a release that changes cached shell assets, bump `CACHE` in `sw.js` so clients drop the old cache

**GitHub Pages:** the repository is published from the `main` branch (Settings → Pages → *Deploy from a branch* → `main` / root) at <https://minkhantthu2692-gif.github.io/DevNotes/>. Every asset path is relative (`./…`), so the app works from a sub-path such as `/DevNotes/` without configuration, and the committed `.nojekyll` file stops Jekyll from rewriting any files.

## Folder structure

```
index.html                app shell (boot status + hidden #app-shell)
manifest.webmanifest      PWA manifest
sw.js                     service worker (app-shell cache, versioned)
src/
  assets/icons/           PWA icons (192/512/maskable)
  fonts/
    bundled/*.woff2       18 self-hosted fonts + OFL license texts
    fonts.css             @font-face definitions
    fonts-manifest.json   font metadata for Settings → Fonts
  scripts/
    app.js                boot sequence
    config.js             publishable service configuration (see Security)
    router.js             hash router
    navigation.js         sidebar items + lazy page loaders
    state.js              tiny observable stores
    pages/                one module per route (lazy-loaded)
    components/           dialogs, toasts, tabs, code blocks, feedback, …
    features/             domain features (settings, import-export, auth, ai, taxonomy, …)
    db/                   IndexedDB schema + repositories (only data layer)
    sync/                 operation queue, sync engine, conflict resolver
    services/             Supabase client + auth service
    utils/                DOM, validation, search, markdown, sanitize, format, …
  styles/                 tokens, themes, typography, layout, components, pages
  vendor/                 pinned third-party libraries (see Licenses)
supabase/
  migrations/0001_init.sql     tables, RLS, indexes, private storage bucket
  functions/ai-proxy/index.ts  authenticated Groq proxy (server-side secret)
  README.md                    detailed Supabase instructions
tests/
  unit/                  Node test-runner suite (fake-indexeddb)
  browser/run.mjs         Playwright smoke test against a local static server
  browser/stylecheck.mjs  diagnostic: verify stylesheets load and apply
```

## Configuration: what is required vs optional

| Capability | Configuration | Mandatory? |
|---|---|---|
| Notes, snippets, review, search, import/export, themes, offline use | none | — works out of the box |
| Cloud sync + accounts | `SUPABASE.url`, `SUPABASE.anonKey` in `src/scripts/config.js` | optional |
| Google / GitHub sign-in | Supabase provider + redirect URLs | optional (see below) |
| AI features (BYOK) | user pastes their own Groq key in **Settings → AI** | optional |
| AI features (shared deployment) | `AI.edgeFunctionUrl` + deployed Edge Function with `GROQ_API_KEY` | optional |

`.env.example` documents the same values for tooling that injects environment variables. Remember: **anything inlined into frontend JavaScript is public after deployment** — only publishable values belong there.

## Supabase setup (sync + accounts) — optional

> Full step-by-step detail, including CLI commands and the `ai-proxy` error codes, lives in [`supabase/README.md`](supabase/README.md).

1. **Create a project** at <https://supabase.com/dashboard> → *New project*.
2. **Run the migration** `supabase/migrations/0001_init.sql`:
   - CLI: `supabase link --project-ref <ref>` then `supabase db push`
   - or paste the file into **Dashboard → SQL Editor** and run it

   This creates the 7 sync tables (`lessons`, `code_snippets`, `flashcards`, `programming_languages`, `categories`, `courses`, `user_preferences`), every index, and **Row Level Security** policies scoped to `auth.uid() = user_id` for `SELECT`/`INSERT`/`UPDATE`/`DELETE`, plus the private `devnotes-exports` storage bucket. The SQL uses `auth.uid()`, so it must run on Supabase (not plain PostgreSQL).
3. **Fill in the frontend values** in `src/scripts/config.js`:
   ```js
   export const SUPABASE = {
     url: 'https://<project-ref>.supabase.co',
     anonKey: '…', // Dashboard → Settings → API → anon/publishable
     enabled() { return Boolean(SUPABASE.url && SUPABASE.anonKey); },
   };
   ```
4. Leave both empty → DevNotes runs fully local; the Account page and Settings explain that sync is not configured (it is never faked).

### Email/password authentication

Works as soon as steps 1–3 are done (Supabase enables the *Email* provider by default). For a smooth first sign-in, disable “Confirm email” or configure SMTP under **Authentication → Providers → Email** — DevNotes surfaces whatever the project returns (including “check your inbox”).

### Google OAuth and GitHub OAuth

OAuth needs extra Supabase configuration and **will not work until you do it** — the buttons only appear when Supabase is configured, and the app reports the real error instead of simulating success:

1. **Google**: create OAuth credentials in the [Google Cloud console](https://console.cloud.google.com/apis/credentials) (type *Web application*), authorize the Supabase callback URL shown under **Authentication → Providers → Google** (`https://<ref>.supabase.co/auth/v1/callback`), then paste the client ID/secret into Supabase.
2. **GitHub**: create an OAuth app under GitHub → *Settings → Developer settings → OAuth applications* with callback URL `https://<ref>.supabase.co/auth/v1/callback`, then paste ID/secret under **Authentication → Providers → GitHub**.
3. **Redirect URLs**: in **Authentication → URL Configuration**, set *Site URL* to your deployed origin (e.g. `https://your-app.example/`) and add redirect URLs — your deployed origin and, for local work, `http://localhost:4173/`. DevNotes uses the PKCE flow, so the callback path must be listed or the provider rejects the redirect.

### Storage bucket

`supabase/0001_init.sql` creates `devnotes-exports` as a **private** bucket, per-user via `(storage.foldername(name))[1] = auth.uid()::text`. The app **never auto-uploads local files**: exports download to the user's machine; the bucket is only for explicitly configured export flows.

## AI setup (Groq) — optional

Core note management never needs AI. Two modes:

**BYOK (default)** — each user pastes their own Groq API key in **Settings → AI** (stored in that browser's `localStorage`). The key is sent directly from the browser to `https://api.groq.com`. Be aware: a browser-side key is visible to anyone with access to that browser profile — it protects *your* key from *other* users, not from yourself.

**Shared deployment (proxy)** — for a multi-user deployment, use the bundled Edge Function so the key never reaches the browser:

```sh
supabase secrets set GROQ_API_KEY=gsk_...        # never commit this
supabase functions deploy ai-proxy
```

Then set `AI.edgeFunctionUrl` in `config.js` to `https://<ref>.supabase.co/functions/v1/ai-proxy`. The function authenticates each request with `auth.getUser()` (a signed-in session is required) and rate-limits per user. Details and error codes: [`supabase/README.md`](supabase/README.md).

Model IDs drift over time — the default is `llama-3.3-70b-versatile`; **Settings → AI** offers presets, a custom model field and a “Load available models” action. Rate limits, invalid models, timeouts and network failures produce specific, recoverable error messages. AI drafts are never applied silently: flashcard drafts wait for your approval, and assistant output is always shown for confirmation.

## How synchronization works

- **Local first**: every change is written to IndexedDB immediately; the UI never waits on the network.
- **Queue**: mutations append an idempotent operation to a persistent IndexedDB queue in the *same transaction* as the record write. Operations coalesce per record (autosave doesn't flood it; delete supersedes pending upsert and vice versa). An item leaves the queue only after the remote acknowledges it — or you explicitly discard it.
- **Retries**: retryable failures (network, 5xx, rate limits) back off exponentially with jitter (max 8 attempts), then park as *failed* with manual **Retry all** / **Discard** controls in Account. Permanent failures (auth, validation) park immediately.
- **Conflicts**: pushes carry the record's `baseRevision`. If the remote moved on, nothing is overwritten — both versions are stored and the Account page offers **Keep this device's version**, **Use cloud version**, or **Edit and merge** (field-by-field). There is no silent merge and no timestamp-only conflict logic.
- **First sign-in**: you choose the direction (upload local / download cloud / stay local). “Stay local” suspends sync (persisted flag) until you resume it from Account or Settings. Signing out pauses sync but never touches local data.
- **Recovery**: the queue lives in IndexedDB, so refreshes, browser restarts and offline periods resume exactly where they stopped; `navigator.onLine` is treated as a hint, not proof — real requests decide.

## Offline behavior

- The service worker precaches the app shell (HTML, CSS, fonts stylesheet, icons) after validating every entry's content type — install aborts rather than persist a proxy error page — and then serves same-origin GETs stale-while-revalidate, so modules and fonts load instantly offline after first use and a bad cache entry heals on the next successful reload. If no stylesheet applies at all (poisoned cache, proxy, extension), the app detects it after boot and offers a one-click "clear cache and reload" recovery.
- Navigation falls back to the cached `index.html`; cross-origin responses (Supabase, Groq) are **never** cached.
- Your data is independent of the cache: it lives in IndexedDB, which the service worker does not touch. If the browser evicts the service-worker cache, the app simply refetches the shell next time.
- Offline you can read and edit everything; queued sync operations wait for reconnection.

## Backup and restore

Settings → *Account & data*:

- **Export** — a single versioned JSON file (`schemaVersion: 1`) with all entities and a manifest, or a ZIP containing that JSON plus per-lesson/per-snippet Markdown mirrors and a `readme.txt`. Preferences are included in JSON, excluded from ZIP.
- **Import** — the file is size-checked, parsed and validated before anything is written; a preview shows counts per entity, which records are new vs already present, skipped/invalid records and validation errors. Then you choose:
  - **Merge**: adds new records only; existing IDs are never overwritten, duplicate titles get unique slugs.
  - **Replace**: clears the content stores (after a typed `REPLACE` confirmation) and applies the backup's preferences.

Everything runs in one IndexedDB transaction — a failed import leaves your library untouched. Malformed records are reported and skipped rather than blocking the rest of the backup. Trash can be purged by age, and “Erase everything” (typed `ERASE` confirmation) resets the database after an export prompt.

## Fonts

- Interface and code fonts are independently configurable (Settings → Typography).
- 18 bundled fonts live in `src/fonts/bundled/` (SIL OFL texts included); metadata is in `fonts-manifest.json`.
- You can import your own font files (woff2/woff/ttf, 8 MB limit) — they are stored in **IndexedDB**, never written into the app source, and object URLs are revoked after use.
- Loading failures fall back to system stacks; nothing blocks on a missing font.

## Testing

Both suites were executed against this codebase:

```sh
npm test               # unit suite: 87 tests, 6 files  → 87 pass / 0 fail
npm run test:browser   # browser smoke: 12 steps       → 12 pass / 0 fail
node tests/browser/stylecheck.mjs   # diagnose CSS loading on any deployment

# Run the same smoke steps against a deployed copy instead of a local server:
SMOKE_ORIGIN=https://<user>.github.io/DevNotes npm run test:browser
```

- **Unit** (`node --test` + `fake-indexeddb`): validation/normalization (including backup validation rules), search parsing/scoring/flags/highlighting, error classification and backoff, the sync queue (coalescing, claim, failure classes, exhaustion, retry, discard, suspension), repositories (CRUD, revisions, activity coalescing, trash lifecycle, flashcard approval/scheduling, taxonomy dedupe), and import/export (size/parse guards, diffing, merge/replace semantics). `localStorage` is polyfilled in `tests/unit/helpers/env.js`.
- **Browser** (`playwright-core` + your installed Chrome or Edge — no browser download): serves the repo over HTTP, then verifies boot, **design-system styles actually loading and applying** (tokens resolve, grid layout active — catches the "app renders unstyled" failure class), dashboard, empty library, lesson creation with autosave and URL swap, **persistence across reload**, settings rendering, **dialog accessibility** (keyboard open, `aria-modal`, Escape closes, focus restored to the trigger), **every route mounting without runtime errors**, **service-worker precache + a full boot while offline**, and zero uncaught page errors. Set `CHROME_PATH` if your browser lives somewhere non-standard. With `SMOKE_ORIGIN` set the local server is skipped and the steps run against that URL — use it to verify a deployment (this project's GitHub Pages copy was validated this way). `tests/browser/stylecheck.mjs` is a standalone diagnostic that reports every CSS response a browser sees plus computed-style probes, for debugging unstyled renders.

Tests requiring real Supabase/Groq credentials (live RLS policies, live OAuth, real proxy rate limits) cannot run offline and are **not** included; the migration's RLS policies should be verified against your project (Supabase provides SQL tests in the dashboard). The local suites require no network access; only `SMOKE_ORIGIN` runs do.

## Security notes

- `src/scripts/config.js` ships to every browser: **publishable values only** (Supabase URL + anon key are safe by design; they are guarded by RLS). Never put the service-role key, a shared Groq key, or any other secret in frontend code or `.env` values that get inlined — they are public after deployment.
- Row Level Security is the ownership boundary: every table has `auth.uid() = user_id` policies for all four verbs; the anon role has no policies. The client never trusts a user ID it sends — the database enforces it.
- The service-role key exists only in Supabase infrastructure; the only shared AI secret is `GROQ_API_KEY` as an Edge Function secret.
- HTML from Markdown is sanitized (DOMPurify; raw HTML disabled by default), saved snippets are never executed, and `alert()/confirm()/prompt()` are not used — dialogs handle focus, Escape and restoration.
- Exports stay on the user's device; nothing is uploaded without an explicit action.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Blank page / “Cannot use import statement outside a module” | The app was opened via `file://`. Use a static server (see *Running locally*). |
| Settings says *Sync is not configured* | `SUPABASE.url`/`anonKey` are empty — expected, the app is fully local. |
| Sign-in fails immediately | RLS/migration not run, or email confirmation is required. Check the message shown on the form. |
| OAuth buttons report a redirect error | Provider credentials or **Authentication → URL Configuration** redirect URLs missing — see *OAuth* above. |
| Sync shows *failed* items | Open Account → *Pending operations*: **Retry all** after fixing the cause, or **Discard** items you don't want. Conflicts get their own card with side-by-side versions. |
| AI: 401/403 | BYOK key invalid/revoked (re-enter in Settings → AI) or proxy caller not signed in. |
| AI: 429 / model not found | Rate limit (back off) or a retired model id — use *Load available models* or the Groq docs. |
| Service worker serving an old shell | Bump `CACHE` in `sw.js` (or hard-reload); caches are version-scoped and cleaned on activate. |
| “IndexedDB is not available” | Private/incognito storage restrictions or a browser profile with storage disabled. |
| Import rejected | Wrong file type or >200 MB; the preview lists invalid records — see *Backup and restore*. |

## Licenses

Application code: MIT (see `package.json`).

Vendored third-party libraries are pinned copies under `src/vendor/`, each with its `LICENSE` file:

| Library | Version | License |
|---|---|---|
| marked | v18.1.1 | MIT |
| DOMPurify | 3.4.17 | Apache-2.0 / MPL-2.0 |
| Highlight.js | v11.12.0 | BSD-3-Clause |
| KaTeX (with CSS + fonts) | vendored | MIT |
| JSZip | v3.10.2 | MIT (GPLv3 dual, MIT chosen) |
| idb | vendored | ISC |
| supabase-js | vendored | MIT |

Bundled fonts are under the **SIL Open Font License 1.0** — texts in `src/fonts/bundled/`. No libraries are loaded from CDNs at runtime.
