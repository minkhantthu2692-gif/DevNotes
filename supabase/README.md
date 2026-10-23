# Supabase setup — DevNotes

Contents:

- `migrations/0001_init.sql` — all 7 sync tables (camelCase columns), RLS,
  indexes, the `devnotes_schema_info` view, and the private
  `devnotes-exports` storage bucket. Plain SQL: paste into the SQL editor
  **or** push with the CLI.
- `functions/ai-proxy/index.ts` — authenticated Groq proxy (Deno edge
  function). The **only** place a shared `GROQ_API_KEY` may exist.

No secrets are stored in this directory (AGENTS.md §19).

## 1. Run the migration

With the Supabase CLI:

```sh
supabase link --project-ref <your-project-ref>
supabase db push            # applies migrations/0001_init.sql
```

Without the CLI: open **Dashboard → SQL Editor**, paste the whole file, Run.
(The file is idempotent where practical; run it on a fresh database — it does
not retrofit columns onto tables that already exist.)

> `auth.uid()` is used for column defaults and RLS, so the SQL must run on a
> Supabase project (not plain PostgreSQL).

## 2. Configure secrets (edge function)

```sh
# required — never commit or hard-code this value
supabase secrets set GROQ_API_KEY=gsk_...

# optional overrides
supabase secrets set GROQ_ALLOWED_MODELS=llama-3.3-70b-versatile,llama-3.1-8b-instant
supabase secrets set AI_RATE_LIMIT=30
```

`GROQ_API_KEY` is read only by the function via `Deno.env.get()`. **It must
never appear in frontend code** — not in `src/scripts/config.js`, not in any
`.js` shipped to the browser, not in HTML, and not in this repository. A key
in frontend code is public the moment it deploys (AGENTS.md §19). In
user-owned BYOK mode the user enters their own key in Settings → AI, which
stays in that user's `localStorage` — the server-side key exists only for
shared deployments.

## 3. Deploy the function

```sh
supabase functions deploy ai-proxy
```

Requires the Supabase CLI to be logged in (`supabase login`). The function
authenticates every request with `auth.getUser()` — callers must send
`Authorization: Bearer <user access token>`; missing/invalid tokens get
`401 { "error": { "code": "unauthorized" } }`.

## 4. Fill in the frontend placeholders

In `src/scripts/config.js`:

| Placeholder | Value |
|---|---|
| `SUPABASE.url` | `https://<your-project-ref>.supabase.co` |
| `SUPABASE.anonKey` | the anon / publishable key (Dashboard → Settings → API) |
| `AI.edgeFunctionUrl` | `https://<your-project-ref>.supabase.co/functions/v1/ai-proxy` |

Leave all three empty to run DevNotes fully local (sync/auth/AI stay off).

### The anon key is public by design

The anon/publishable key ships to every browser — that is how Supabase is
meant to work. **Row Level Security is the security boundary**: every table in
this directory has RLS enabled with `auth.uid() = user_id` policies scoped to
`authenticated`, so a session can only ever read/write its own rows, and the
`anon` role has no policies, so anonymous REST queries return zero rows
(verified live against this project: `[]` with HTTP 200). Never use the service-role
key in the frontend; it bypasses RLS entirely.

### OAuth redirect URLs

If you enable an OAuth provider (Dashboard → Authentication → Providers) you
must add your deployed origin to **Authentication → URL Configuration**
(Site URL + Redirect URLs), e.g. `https://your-app.example/` and, for local
development, `http://localhost:4173/`. The app uses the PKCE flow
(`flowType: 'pkce'`), so the callback path must be listed or the provider
will reject the redirect.

## 5. Storage note

Bucket `devnotes-exports` is **private** and scoped per user
(`(storage.foldername(name))[1] = auth.uid()::text`). The app does **not**
auto-upload local files — IndexedDB is the local store and exports download to
the user's machine by default; the bucket exists only for explicitly
configured export flows.

## 6. Error codes from `ai-proxy`

`{ "error": { "code": "...", "message": "..." } }` —
`unauthorized` (401), `invalid_request` (400: bad body or non-allowlisted
model), `rate_limited` / `upstream_rate_limited` (429, `retryable: true`),
`invalid_model` (400), `not_configured` (500/502: missing or rejected
`GROQ_API_KEY`), `configuration_error` (500: missing `SUPABASE_URL` /
`SUPABASE_ANON_KEY`), `upstream_error` (502), `empty_response` (502),
`timeout` (504), `method_not_allowed` (405).
