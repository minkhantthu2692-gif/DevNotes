# DevNotes — အပြည့်အဝ ဆက်တင်လမ်းညွှန် (မြန်မာဘာသာ)

ဤစာရွက်စာတမ်းသည် DevNotes web app ကို **100% အလုပ်လုပ်နိုင်စေရန်** လိုအပ်သည့် ဆက်တင်အဆင့်အားလုံးကို အဆင့်ဆင့် ဖော်ပြထားသည်။ Supabase (sync + အကောင့်), GitHub (hosting + OAuth), Google (OAuth), နှင့် AI (Groq) ဝန်ဆောင်မှုအားလုံး ပါဝင်သည်။

> ဤစာရွက်တွင် ဖော်ပြထားသော URL၊ အမည်များအားလုံးသည် ဤစီမံကိန်းအတွက် အမှန်တကယ် သတ်မှတ်ထားသည့်တန်ဖိုးများ ဖြစ်ပါသည် (အင်္ဂလိပ်ဘာသာ အပြည့်အစုံမှာ [README.md](README.md) နှင့် [supabase/README.md](supabase/README.md) တွင် ကြည့်နိုင်ပါသည်)။

**ဆက်စပ် စာရွက်စာတမ်းများ**

- [README.md](README.md) — အင်္ဂလိပ်ဘာသာ အညွှန်းအပြည့်အစုံ
- [supabase/README.md](supabase/README.md) — migration နှင့် ai-proxy error code များ

---

## 1. ဘယ်အရာတွေ ဆက်တင်မလုပ်ဘဲ အလုပ်လုပ်မလဲ

DevNotes သည် **offline-first** ဖြစ်သည် — config တစ်ခုမှ မဖြည့်ဘဲနှင့်လည်း အောက်ပါအတိုင်း အပြည့်အဝ အသုံးပြုနိုင်သည် (ဤအချက်ကို စမ်းသပ်မှုများဖြင့် အတည်ပြုပြီးဖြစ်သည်):

| လုပ်ဆောင်ချက် | Config မလို | ဆက်တင် လိုအပ်သည် |
|---|---|---|
| သင်ခန်းစာ/snippets/favorites/flashcard review/trash/ရှာဖွေမှု | ✅ | — |
| Editor (autosave), Markdown, syntax highlighting, copy/wrap/line numbers | ✅ | — |
| Import/Export (JSON/ZIP), backup/restore | ✅ | — |
| Theme (light/dark/system), accent, fonts, typography | ✅ | — |
| Activity နှင့် revision history | ✅ | — |
| Offline အသုံးပြုမှု (service worker + IndexedDB) | ✅ | — |
| အကောင့်ဖွင့်ခြင်း/အဝင်၊ cloud sync | | Supabase — **အဆင့် 3–7** |
| Google / GitHub ဖြင့် အဝင် | | OAuth — **အဆင့် 8–9** |
| AI assistant, AI flashcard drafts | | Groq — **အဆင့် 10–11** |

**"100% functional" ဆိုတာ ဘာကို ဆိုလိုသလဲ:** အထက်ပါ ဇယားအားလုံး ပုံမှန်အလုပ်လုပ်ခြင်း + အဆင့် 15 (Verification checklist) ရှိ အချက်အားလုံး ပြီးစီးခြင်း ဖြစ်သည်။

---

## 2. မဖြစ်မနေ လိုအပ်သည်များ (Prerequisites)

| အရာ | မှတ်ချက် |
|---|---|
| Chrome သို့မဟုတ် Edge (နောက်ဆုံးမျိုးဆက်) | IndexedDB, service worker, ES modules လိုအပ်သည် |
| GitHub account | repo + Pages hosting အတွက် |
| Supabase account | sync/အကောင့် အတွက် (မဖြစ်မနေမဟုတ်) |
| Groq account (console.groq.com) | AI အတွက် (မဖြစ်မနေမဟုတ်) |
| Node.js + npm | **development/test အတွက်သာ** — runtime မှာ မလိုပါ (app တွင် build step မရှိ) |
| Git | code push ရန် |

**အရေးကြီးသော ကန့်သတ်ချက်များ**

- `file://` ဖြင့် ဖွင့်ပါက အလုပ်မလုပ်ပါ (ES modules မတက်နိုင်)။ အမြဲတမ်း HTTP/HTTPS server မှတဆင့်သာ ဖွင့်ပါ။
- Service workerနှင့် OAuth တို့အတွက် **HTTPS** မဖြစ်မနေ လိုအပ်သည် (GitHub Pages သည် HTTPS ဖြင့် ပေးသည် — စိတ်ချရသည်)။
- ဆက်တင်ပြောင်းလဲမှုတိုးရန် admin access ရှိရမည် — GitHub repo settings, Supabase dashboard, Google Cloud console, GitHub developer settings

---

## 3. GitHub Pages တွင် hosting ပြင်ဆင်ခြင်း

**✅ ပြီးပြီ** — ဤစီမံကိန်းအတွက် အောက်ပါအတိုင်း တည်ဆောက်ပြီးဖြစ်သည်။ (အသစ်ပြန်လုပ်ရန် လိုအပ်ပါက အဆင့်များအတိုင်း လုပ်ပါ)

**အချက်အလက်**

- Repository: <https://github.com/minkhantthu2692-gif/DevNotes>
- Live site: <https://minkhantthu2692-gif.github.io/DevNotes/>

**အဆင့်များ (GitHub မှာ ပြန်လုပ်ရန်)**

1. GitHub repo တွင် **Settings → Pages** သို့ သွားပါ။
2. Source အဖြစ် **Deploy from a branch** ကို ရွေးပါ။
3. Branch = `main`, folder = `/ (root)` ထားပြီး **Save** နှိပ်ပါ။
4. Repo root တွင် **`.nojekyll`** ဖိုင် ရှိရမည် (ရှိပြီးသား — Jekyll က asset များကို ပြင်ဆင်မသွားစေရန်)။
5. `main` သို့ push တိုင်း Pages က အလိုအလျောက် ပြန်တည်ဆောက်သည် (၁ မိနစ်ခန့်)။

**push နောက် ဘရောက်ဆာ ဟောင်း မမြင်ရစေရန်**

- CSS/HTML/font/index.html ပြောင်းလဲပါက `sw.js` ရှိ **`CACHE` ကို bump** ပါ (ဥပမာ `devnotes-shell-v1` → `devnotes-shell-v2`)။
- **`src/scripts/config.js` ပြင်ပါကလည်း CACHE bump လုပ်ပါ** — module များကို cache-first ဖြင့် သိမ်းထားသောကြောင့် ဧည့်သည်ဟောင်းများ ပြင်ဆင်မှုအသစ် တစ်ကြိမ်ကြာမှ မြင်ရနိုင်သည်။
- ပြင်ဆင်မှု မြန်မြန်စစ်ရန်: incognito window အသစ်ဖွင့် သို့မဟုတ် hard reload (Ctrl+Shift+R)။

---

## 4. Supabase စက် (project) ဖန်တီးခြင်း

**လိုအပ်ချက်:** sync + အကောင့်အတွက်သာ (AI BYOK နှင့် local အသုံးပြုမှုအတွက် မလို)

ဤစီမံကိန်းအတွက် စက် **ဖန်တီးပြီး** ဖြစ်ပါသည် — တန်ဖိုးများကို မှတ်ထားပါ:

| အချက် | တန်ဖိုး |
|---|---|
| Project ref | `otbjkarkexqfujotsdcw` |
| Project URL | `https://otbjkarkexqfujotsdcw.supabase.co` |
| Region | ဖန်တီးချိန်တွင် ရွေးထားသော region |

**အသစ်ဖန်တီးရန် (အကြံပြုချက်):**

1. <https://supabase.com/dashboard> → **New project** → organization ရွေး → စက်အမည် (ဥပမာ `DevNotes`) → region → **database password** တင်းကျပ်စွာ မှတ်ထားပါ (CLI `db push` တွင် လိုအပ်နိုင်သည် — မမှတ်မိပါက Dashboard → Project Settings → Database → **Reset database password** မှ ပြန်လည်သတ်မှတ်နိုင်သည်)။
2. စက်ဖန်တီးပြီးနောက် **Project Settings → API** တွင် Project URL နှင့် anon/publishable key ကို မှတ်ထားပါ (အဆင့် 7 တွင် သုံးမည်)။

**မှတ်ချက်:** Free tier စက်များသည် ရက်အနည်းငယ် မအသုံးပြးပါက **pause** ဖြစ်သွားနိုင်သည် — အောက်ပါ CLI အဆင့်များ error ပြလျှင် Dashboard မှ project ကို **Restore** ပါ။

---

## 5. Supabase CLI ဆက်တင်နှင့် project ချိတ်ဆက်ခြင်း

**✅ CLI ထည့်ပြီး** (`v2.122.0`) **✅ `supabase init` ပြီးပြီ** (repo အတွင်း `supabase/config.toml` ဖန်တီးပြီး — migration/ function များကို မထိပါ)။ ကျန်အဆင့်များကို အောက်တွင် ဆက်လုပ်ပါ။

**5.1 ထည့်သွင်းခြင်း (အသစ်စက်တွင်)**

```sh
npm install -g supabase
supabase --version        # v2.x.x ပြရမည်
```

**5.2 config ဖန်တီးခြင်း (repo root တွင်)**

```sh
supabase init             # supabase/config.toml ဖန်တီးသည်
```

**5.3 အကောင့်ဝင်ခြင်း**

```sh
supabase login            # ဘရောက်ဆာဖြင့် အတည်ပြုရန် URL ပေးသည် (terminal/TTY မှသာ run ရမည်)
```

- Token အသုံးပြုရန်: <https://supabase.com/dashboard/account/tokens> မှ **user-scoped** personal access token ဖန်တီးပြီး `supabase login --token ghp_...` တွင် ထည့်နိုင်သည်။
- စစ်ဆေးရန်: `supabase whoami`

**5.4 project ချိတ်ဆက်ခြင်း**

```sh
supabase link --project-ref otbjkarkexqfujotsdcw
```

- Database password တောင်းပါက ထည့်ပါ (ထည့်ထားပါက နောက်ပိုင်း `db push` က အလိုအလျောက် သုံးနိုင်သည်)။ Password မသိပါက ထည့်ဘဲနေနိုင်သည် — ပြဿနာရှိလျှင် အဆင့် 4.1 တွင် SQL Editor လမ်းကြောင်း သုံးပါ။

**5.5 ချိတ်ဆက်မှု အောင်မြင်ကြောင်း စစ်ဆေးရန်**

```sh
supabase projects list    # otbjkarkexqfujotsdcw စက် မြင်ရပြီး link ပြီး
```

---

## 6. ဒေတာဘေ့စ် migration တင်ခြင်း

`supabase/migrations/0001_init.sql` ကို တစ်ကြိမ်တည်း run ရန် လိုအပ်သည်။ SQL တွင် `auth.uid()` သုံးထားသောကြောင့် **Supabase စက်ပေါ်မှာသာ** အလုပ်လုပ်သည် (plain PostgreSQL တွင် မဟုတ်)။

### 6.1 နည်းလမ်း A — CLI (အကြံပြု)

```sh
supabase db push          # supabase/migrations/0001_init.sql ကို remote DB သို့ တင်သည်
```

### 6.2 နည်းလမ်း B — Dashboard SQL Editor

1. Supabase Dashboard → **SQL Editor** → New query
2. `supabase/migrations/0001_init.sql` အပြည့်အစုံ copy-paste → **Run**

> ဖိုင်သည် နေရာများတွင် idempotent ဖြစ်သော်လည်း **အသစ်ဖန်တီးထားသော ဒေတာဘေ့စ်** ပေါ်မှာ run ရန် အကြံပြုသည် (ရှိပြီးသား table များသို့ column မထည့်ပါ)။

### 6.3 Migration က ဘာတွေ ဖန်တီးသလဲ

- Sync table **၇ ခု**: `lessons`, `code_snippets`, `flashcards`, `programming_languages`, `categories`, `courses`, `user_preferences`
- Index များ + `devnotes_schema_info` view
- **Row Level Security**: table တိုင်းတွင် `auth.uid() = user_id` policy (SELECT/INSERT/UPDATE/DELETE လေးခုစလုံး) — session တစ်ခုက ကိုယ့် row များကိုသာ ဖတ်/ရေးနိုင်သည်
- Private storage bucket **`devnotes-exports`** (user တစ်ဦးချင်းစီ folder ခွဲထားသည်)

### 6.4 အောင်မြင်ကြောင်း စစ်ဆေးခြင်း

1. Dashboard → **Table Editor** → table ၇ ခု မြင်ရပြီး
2. အောက်ပါ curl ကို run ပါ (anon key ဖြင့်၊ အကောင့်မဝင်ဘဲ)။ **ရလဒ်အဓိပ္ပာယ်ဖွင့်ဆိုနည်း:** (ဤစီမံကိန်းတွင် အတည်ပြုပြီး)

   - **`[]` + HTTP 200** → ✅ **migration ပြီးပြီ + RLS အလုပ်လုပ်နေသည်** — table ရှိပြီး၊ session မရှိသော anon အတွက် RLS က row အားလုံးကို ဖုံးပစ်သောကြောင့် ဗလာ array သာ ပြန်သည်
   - `relation "public.lessons" does not exist` (**HTTP 42P01**) → ❌ migration မတင်ရသေးသေး
   - HTTP 401 → anon key မှား/မပါ

```sh
curl "https://otbjkarkexqfujotsdcw.supabase.co/rest/v1/lessons?select=id&limit=1" \
  -H "apikey: <anon-key-ထည့်ပါ>"
```

---

## 7. `src/scripts/config.js` ဖြည့်ခြင်း

Supabase နှင့် ချိတ်ရန် frontend တွင် **publishable values ၂ ခု**သာ ဖြည့်ရမည်။

**ဖိုင်**: `src/scripts/config.js`

```js
export const SUPABASE = {
  url: 'https://otbjkarkexqfujotsdcw.supabase.co',
  anonKey: 'eyJhbGciOi...ထည့်ပါ...',   // Dashboard → Settings → API → anon/publishable
  enabled() {
    return Boolean(SUPABASE.url && SUPABASE.anonKey);
  },
};
```

- **anon key ယူရာနေရာ**: Supabase Dashboard → **Project Settings → API** → `anon` / `publishable` key (sb_publishable_... သို့မဟုတ် `eyJ...` JWT ပုံစံ)
- **service_role key ကို အမြဲတမ်း မထည့်ရ** — ၎င်းက RLS ကို ကျော်ဖြတ်နိုင်ပြီး browser ရောက်သည်နှင့် ပြည့်ဝသော လုံခြုံရေးအဆင့် ပျက်သည်
- `url` နှင့် `anonKey` ဗလာထားပါက app က **local mode** အဖြစ် ပုံမှန်အလုပ်လုပ်ဆဲဖြစ်သည် (sync/အကောင့်ပဲ ပိတ်ထားသည်)

**ပြီးနောက် လုပ်ရမည့်အရာ:**

1. ပြင်ဆင်မှုကို `main` သို့ commit + push ပါ
2. `sw.js` ရှိ `CACHE` ကို bump ပါ (config.js မှာ cache-first module ဖြစ်သောကြောင့်)
3. Live site ကို incognito window ဖွင့်စစ်ပါ

**စစ်ဆေးရန်:** Settings → Sync တွင် "Sync is not configured" ဟု မပြတော့ဘဲ Account page တွင် အကောင့်ဖွင့်/ဝင် form ပေါ်လာမည်။

---

## 8. Email/Password အဝင် ဖွင့်ခြင်း + URL Configuration

Supabase သည် Email provider ကို မူလအားဖြင့် ဖွင့်ထားသည် — `config.js` ဖြည့်ပြီးလျှင် email/password အဝင် ချက်ချင်း အလုပ်လုပ်သည်။ သို့သော် **URL Configuration** မပြင်ပါက OAuth နှင့် password reset မအောင်မြင်ပါ။

**Dashboard → Authentication → URL Configuration** တွင်:

| Field | ထည့်ရမည့်တန်ဖိုး |
|---|---|
| Site URL | `https://minkhantthu2692-gif.github.io/DevNotes/` |
| Redirect URLs (ထည့်ရန်) | `https://minkhantthu2692-gif.github.io/DevNotes/` |
| | `https://minkhantthu2692-gif.github.io/DevNotes/index.html` |
| | `http://localhost:4173/` (local development — `npm run serve`) |
| | `http://localhost:4173/index.html` |

- App သည် redirect တွင် `origin + pathname` ကို ပြန်အသုံးပြုသဖြင့် (sub-path `/DevNotes/` အပါအဝင်) အထက်ပါ URL များ မှန်ကန်ပါသည်။
- **Password reset** မအောင်မြင်ပါက Redirect URLs တွင် `https://minkhantthu2692-gif.github.io/DevNotes/#/account?reset=1` ကို ထည့်ကြည့်ပါ။
- DevNotes သည် **PKCE flow** သုံးသဖြင့် callback/redirect path မှတ်ပုံတင်ခြင်း မပြုပါက provider က redirect ကို ငြင်းပယ်သည်။

**ပိုမိုချောမွေ့စေရန် (ကိုယ်ပိုင်အသုံးပြုမှု):** **Authentication → Providers → Email** တွင် *Confirm email* ကို **off** ပြုလုပ်ပါ — confirmation email မပို့ပါက sign-up ပြီးချင်း အဝင်ရခြင်း (ပုံမှန်အတိုင်းထားပါက app က "check your inbox" message ကို ပြသပေးသည် — မဟုတ်မမှန် မပြောပါ)။

**စစ်ဆေးရန်:** Account page တွင် အကောင့်ဖွင့် → အဝင်ရ → page reload လုပ်ပြီး session ဆက်ရှိ → Sign out အလုပ်လုပ်သည်။

---

## 9. Google OAuth ဖွင့်ခြင်း

> OAuth ခလုတ်များသည် `config.js` ဖြည့်ပြီးမှ ပေါ်လာသော်လည်း၊ **အောက်ပါ အဆင့်များ မပြီးမီ အလုပ်လုပ်မည် မဟုတ်ပါ** — app က actual error ကိုသာ ပြသည် (အောင်မြင်ကြောင်း လုပ်ကြံ မပြပါ)။

**9.1 Google Cloud console တွင် credentials ဖန်တီးခြင်း**

1. <https://console.cloud.google.com/apis/credentials> သို့ သွားပါ (project အသစ်ဖန်တီးနိုင်သည်)
2. **OAuth consent screen** ကို ဖြည့်ပါ — App name, user support email, scopes: `email`, `openid`, `profile` (Personal အဆင့်ဖြင့် လုံလောက်သည် — test users တွင် ကိုယ့် Gmail ထည့်ပါ)
3. **Credentials → Create Credentials → OAuth client ID → Web application**
4. **Authorized redirect URIs** တွင် အတိအကျ ထည့်ပါ:

```text
https://otbjkarkexqfujotsdcw.supabase.co/auth/v1/callback
```

5. **Client ID** နှင့် **Client secret** ကို copy ယူပါ

**9.2 Supabase တွင် ထည့်ခြင်း**

1. Dashboard → **Authentication → Providers → Google**
2. **Enable** → Client ID + Client secret paste → **Save**

**9.3 စစ်ဆေးရန်**

- Live site → Account page → **Continue with Google** → Google တွင် အတည်ပြု → DevNotes site ပြန်ရောက်ပြီး အဝင်ရမည်
- ပြဿနာပေါ်ပါက "redirect/origin" error — Supabase URL Configuration (အဆင့် 8) ပြန်စစ်ပါ

---

## 10. GitHub OAuth ဖွင့်ခြင်း

**10.1 GitHub တွင် OAuth app ဖန်တီးခြင်း**

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth app**
2. အောက်ပါအတိုင်း ဖြည့်ပါ:

| Field | တန်ဖိုး |
|---|---|
| Homepage URL | `https://minkhantthu2692-gif.github.io/DevNotes/` |
| Authorization callback URL | `https://otbjkarkexqfujotsdcw.supabase.co/auth/v1/callback` |

3. **Client ID** ကို copy → **Generate a new client secret** → secret ကို လုံခြုံစွာ မှတ်ထားပါ (secret ပြသခြင်း ချက်ချင်း ရပ်တန့်သည်)

**10.2 Supabase တွင် ထည့်ခြင်း**

1. Dashboard → **Authentication → Providers → GitHub**
2. **Enable** → Client ID + Client secret paste → **Save**

**10.3 စစ်ဆေးရန်** — Google နှင့် အတူတူ: **Continue with GitHub** → ပြန်ရောက် → အဝင်ရ။

> **မှတ်ချက်:** OAuth app အဆင့်တွင် *Anyone* (public) ဖြင့် လုံလောက်သည် — ပုဂ္ဂလိက repo နှင့် မသက်ဆိုင်ပါ။

---

## 11. AI (Groq) ဆက်တင် — Mode ၂ မျိုး

AI သည် **မဖြစ်မနေ မဟုတ်ပါ** — core note management အားလုံး AI မပါဘဲ အလုပ်လုပ်သည်။ Mode နှစ်မျိုးရှိသည်:

| Mode | ဘယ်အခါ သုံးသလဲ | ဘယ်မှာ key သိမ်းသလဲ | လိုအပ်ချက် |
|---|---|---|---|
| **BYOK** (default) | တစ်ဦးတည်းအသုံးပြုမှု | ကိုယ့် browser ၏ localStorage (`devnotes.ai.key`) | Groq key တစ်ခုတည်း |
| **Proxy** | အသုံးပြုသူ များသော deployment | Supabase Edge Function secret (browser မရောက်) | Supabase + `GROQ_API_KEY` secret |

App က `AI.edgeFunctionUrl` ဖြည့်ထားပြီး Supabase configured ဖြစ်ပါက **proxy mode** အလိုအလျောက် ရွေးသည် (Settings → AI တွင် "Proxy mode: ..." ဟု ပြသည်)။

### 11.1 BYOK mode (အလွယ်ဆုံး)

1. <https://console.groq.com> → **API Keys** → key ဖန်တီး → copy
2. Live app → **Settings → AI** → **API key** ထည့် → Save
   - key သည် ထို browser profile ၏ localStorage တွင်သာ သိမ်းသည် (`devnotes.ai.key`)
   - **Load available models** ခလုတ်ဖြင့် ရရှိနိုင်သော model စာရင်း ယူနိုင်သည်
3. Model ရွေးချယ်ပါ — default `llama-3.3-70b-versatile`; presets: `llama-3.1-8b-instant`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`
4. **စစ်ဆေးရန်**: Assistant page တွင် မေးခွန်းတစ်ခု မေး → ဖြေကြားမည်။ Review page တွင် AI flashcard draft များ **သင် approve မလုပ်မချင်း** queue မဝင်ပါ

**သတိပြုရန် (BYOK):** browser key သည် ထို browser profile ကို ဝင်ရောက်နိုင်သူများအတွက် ကာကွယ်ပေးသည် — ကိုယ့်ကိုယ်ကိုယ် မကာကွယ်ပါ။ ဘေးကင်းရေးအတွက် shared deployment တွင် proxy mode သုံးပါ။

### 11.2 Proxy mode (shared deployment)

**Terminal တွင် (repo root):**

```sh
# 1) လျှို့ဝှက်ချက် သတ်မှတ်ခြင်း — ဤ key ကို အမြဲတမ်း server-side မှာသာ ထားရမည်
supabase secrets set GROQ_API_KEY=gsk_...

# 2) (မဖြစ်မနေမဟုတ်) model allowlist နှင့် rate limit
supabase secrets set GROQ_ALLOWED_MODELS=llama-3.3-70b-versatile,llama-3.1-8b-instant
supabase secrets set AI_RATE_LIMIT=30

# 3) function deploy
supabase functions deploy ai-proxy
```

**Frontend** — `src/scripts/config.js` တွင်:

```js
edgeFunctionUrl: 'https://otbjkarkexqfujotsdcw.supabase.co/functions/v1/ai-proxy',
```

ပြီးနောက် commit + push + `CACHE` bump (အဆင့် 3)။

**လိုအပ်ချက်များ**

- အသုံးပြုသူ **sign-in ဝင်ထားရမည်** — function က `auth.getUser()` ဖြင့် စစ်ဆေးပြီး မဝင်ပါက `401 unauthorized` ပြန်သည်
- CORS အတွက် ထပ်ပြင်စရာ မလိုပါ (function ကကိုယ်တိုင် စီမံထားသည်)
- Shared key တစ်ခုတည်းကို user အားလုံးသုံးသောကြောင့် rate limit ကန့်သတ်ချက် ရှိသည် (per user ရေတွက်သည်)

**ai-proxy error များ (ပြသနာဖြေရှင်းရာတွင်):**

| Code | အဓိပ္ပာယ် / ဖြေရှင်းနည်း |
|---|---|
| `unauthorized` (401) | sign-in မဝင်ထား၊ သို့မဟုတ် BYOK key မှား/ပယ်ဖျက်ထား — Settings → AI မှ ပြန်ထည့် |
| `rate_limited` / `upstream_rate_limited` (429) | rate limit — ခဏစောင့်ပြီး ပြန်ကြိုးစား (Groq ဘက်မှ limit လည်း ရှိသည်) |
| `invalid_model` (400) | model ID ရပ်သွားပြီ — Settings → AI မှ model ပြောင်း သို့ "Load available models" သုံးပါ (proxy mode တွင် BYOK key လိုသည်) |
| `not_configured` (500/502) | server တွင် `GROQ_API_KEY` secret မရှိ — `supabase secrets set` လုပ်ပါ |
| `upstream_error` / `timeout` | Groq ဘက် ပြဿနာ — ခဏကြာလျှင် ပြန်ကြိုးစား |

---

## 12. Sync ဖွင့်ခြင်းနှင့် ပထမဆုံး အဝင်

အဆင့် 7 (`config.js`) ပြီး + အကောင့်ဖွင့်ပြီးပါက sync အလိုအလျောက် ရှိလာသည်။

1. **Account page** → sign up / sign in
2. **ပထမဆုံး sign-in** တွင် ဦးတည်ချက် ရွေးခိုင်းမည်:
   - **Upload local** — ဒီစက်ရှိ data အားလုံး cloud သို့တင်
   - **Download cloud** — cloud data ကို ဒီစက်သို့ဆင်းယူ
   - **Stay local** — sync ရပ်ထား (flag သိမ်းထားသည် — Account/Settings မှနောက်မှ ပြန်ဖွင့်နိုင်သည်)
3. **စစ်ဆေးရန်:**
   - မှတ်စုတစ်ခုပြင် → Account → sync status **Pending → Syncing → Synced** ဖြစ်ကြောင်း
   - အင်တာနက်ဖြတ်ပြီး ပြင် → queue တွင် စောင့် → ပြန်ချိတ် → Synced (local-first — UI က network ကို မစောင့်ပါ)
   - နောက်တစ် browser profile မှ အဝင် → တစ်ဖက်တည်းက ပြင်ထားပါက **conflict card** ပေါ်မည် — ရွေးချယ်စရာ: *Keep this device's version* / *Use cloud version* / *Edit and merge* (အလိုအလျောက် merge/overwrite မလုပ်ပါ)
   - လုပ်ဆောင်ချက် မအောင်မြင်ပါက Account → **Pending operations** → **Retry all** / **Discard**

Signing out သည် sync ကို pause ပြုသော်လည်း local data ကို မဖျက်ပါ။

---

## 13. Storage bucket (အကြောင်းအရာ)

- Migration က **`devnotes-exports`** (private) bucket ကို ဖန်တီးပြီး user တစ်ဦးချင်းစီ folder ခွဲထားသည် (`auth.uid()` ဖြင့် ကန့်သတ်)။
- App သည် file များကို **အလိုအလျောက် upload မလုပ်ပါ** — export များသည် default အားဖြင့် သင့်စက်သို့ download ဖြစ်သည်။ Bucket သည် explicit ဖြင့် သတ်မှတ်ထားသော export/backup flow များအတွက်သာ ရှိသည်။

---

## 14. Backup / Restore (အကျဉ်း)

**Settings → Account & data**

- **Export** — versioned JSON (`schemaVersion: 1`) သို့မဟုတ် ZIP (JSON + Markdown mirrors + readme.txt)
- **Import** — ဖိုင်ကို size/structure စစ် → **preview** (entity တစ်ခုချင်းစီ count, အသစ်/ရှိပြီး, skipped/invalid) →
  - **Merge**: record အသစ်များသာ ထည့် (ရှိပြီးသား ID ကို ဘယ်တော့မှ overwrite မလုပ်)
  - **Replace**: `REPLACE` ကို ရိုက်ထည့်အတည်ပြုမှ content store များ အစားထိုး
- အဆုံးတွင် **Erase everything** (`ERASE` ရိုက်ထည့်) — export prompt နှင့်အတူ DB reset

Import မအောင်မြင်ပါက ရှိပြီးသား library ကို ထိခိုက်မှုမရှိပါ (transaction တစ်ခုတည်း)။

---

## 15. Verification checklist — "100% functional" ဖြစ်ကြောင်း စစ်ဆေးရန်

### A. Config မလိုဘဲ run နိုင်သည် (automated tests — တကယ် run ထားပြီး)

```sh
npm test               # unit suite  → 87 pass / 0 fail
npm run test:browser   # browser     → 11 pass / 0 fail  (offline boot အပါအဝင်)

# Deploy ထားသော site ပေါ်တွင် အတိအကျ run:
SMOKE_ORIGIN=https://minkhantthu2692-gif.github.io/DevNotes npm run test:browser
```

- Chrome/Edge မတွေ့ပါက `CHROME_PATH` env ဖြင့် လမ်းညွှန်ပါ။

### B. Supabase

- [ ] Table Editor တွင် table ၇ ခု မြင်ရသည် (အဆင့် 6)
- [ ] anon key ဖြင့် (sign-in မဘဲ) REST query → **`[]` (HTTP 200)** ပြန်ပါက table ရှိပြီး RLS က anon အားလုံးကို ဖုံးပစ်ထားခြင်း (မှန်ကန်)။ `relation … does not exist` ဆိုပါက migration မတင်ရသေး
- [ ] `config.js` ဖြည့် → push → CACHE bump → incognito တွင် sign up/in ရသည်
- [ ] မှတ်စုပြင် → sync status **Synced** ဖြစ်သည်
- [ ] offline တွင် ပြင် → ပြန် online → အလိုအလျောက် sync ပြီး
- [ ] နှစ်ဖက် ပြင်ခြင်း → conflict card ပေါ်ပြီး ရွေးချယ်နိုင်သည် (silent merge မရှိ)
- [ ] Session reload ပြီး sign-in ဆက်ရှိသည်

### C. OAuth (Google + GitHub)

- [ ] Account page တွင် ခလုတ်နှစ်ခု ပေါ်သည်
- [ ] Google ဖြင့် အဝင်ရ → DevNotes URL ပြန်ရောက်
- [ ] GitHub ဖြင့် အဝင်ရ → DevNotes URL ပြန်ရောက်
- [ ] Password reset email → link နှိပ် → DevNotes ပြန်ရောက် → password ပြောင်းရသည်
- [ ] Redirect မမှန်ပါက error ပြသည် (အောင်မြင်ကြောင်း မလုပ်ကြံပါ)

### D. AI

- [ ] BYOK: Settings → AI တွင် key ထည့် → Assistant ဖြေကြားသည်
- [ ] Model presets + custom model + "Load available models" အလုပ်လုပ်သည်
- [ ] AI flashcard draft များ **pending approval** အဖြစ် ရှိပြီး approve မှ review queue ဝင်သည်
- [ ] Proxy: `secrets set` + `deploy` + `edgeFunctionUrl` ပြီးနောက် sign-in ဖြင့် အလုပ်လုပ်သည်; sign-out ဖြင့် 401 ပြသည်
- [ ] Key မရှိ/model မှား/rate limit တွင် ရှင်းလင်းသော error message + recovery action ပေါ်သည်

### E. Offline နှင့် hosting

- [ ] DevTools → Network → **Offline** → reload → app ပြန်ဖွင့်နိုင်သည် (SW cache)
- [ ] Local အခြေအနေဖြင့် offline read/edit နိုင်သည်; sync queue စောင့်ထားသည်
- [ ] Live site HTTPS + manifest 200 (`application/manifest+json`) ဖြင့် ရသည်
- [ ] Push ပြီး CACHE bump → ဧည့်သည်အသစ်အတွက် ပြင်ဆင်မှု မြင်ရသည်

### F. Backup

- [ ] JSON export → import preview မှန်ကန် → Merge: အသစ်ထည့်ရုံ
- [ ] Replace mode → `REPLACE` ရိုက်မှ အစားထိုးခြင်း
- [ ] Import fail case (invalid file) → library မပျက်

---

## 16. ပြဿနာဖြေရှင်းနည်း (Troubleshooting)

| အခြေအနေ | အကြောင်းအရင်း / ဖြေရှင်းနည်း |
|---|---|
| စာမျက်နှာ ဗလာ / "Cannot use import statement outside a module" | `file://` ဖြင့် ဖွင့်ထားသည် — `npm run serve` (localhost:4173) သို့မဟုတ် HTTPS hosting သုံးပါ |
| Settings တွင် *Sync is not configured* | `SUPABASE.url`/`anonKey` ဗလာ — local mode အတွက် ပုံမှန် (အဆင့် 7) |
| Sign-in ချက်ချင်း fail | Migration မတင်ရသေး၊ email confirmation လိုအပ်၊ သို့မဟုတ် key/URL မှား — form ပြသော message ကို ဖတ်ပါ |
| OAuth redirect error | Provider credentials သို့မဟုတ် URL Configuration redirect URLs ပျောက် — အဆင့် 8 ပြန်စစ်ပါ |
| Password reset link အလုပ်မလုပ် | Redirect URLs တွင် `.../DevNotes/#/account?reset=1` ထည့်ပါ |
| Sync *failed* items | Account → Pending operations → **Retry all** (အကြောင်းရင်းပြင်ပြီး) / **Discard** |
| AI 401/403 | BYOK key မှား/ပယ်ဖျက် (Settings → AI) သို့ proxy mode တွင် sign-in မဝင် |
| AI 429 / model not found | rate limit (စောင့်) သို့ model ID ရပ်သွား — "Load available models" သို့မဟုတ် console.groq.com/docs/models |
| `not_configured` (proxy) | `supabase secrets set GROQ_API_KEY=...` မလုပ်ရသေး — အဆင့် 11.2 |
| ဟောင်းသော UI/module မြင်နေရ | `sw.js` ရှိ `CACHE` bump + push; incognito/hard reload |
| "IndexedDB is not available" | incognito storage ကန့်သတ်ချက် သို့ browser profile တွင် storage ပိတ်ထား |
| Import ငြင်းခံရ | ဖိုင်အမျိုးအစားမှား သို့ >200 MB — preview တွင် invalid record စာရင်း ကြည့်ပါ |
| CLI: project paused / connection error | Free tier စက် pause — Dashboard မှ Restore; သို့ network ပြဿနာ — ပြန်ကြိုးစား |
| CLI: "Access token not provided" | `supabase login` (terminal/TTY) မ run ရသေး သို့ `SUPABASE_ACCESS_TOKEN` မသတ်မှတ် |
| `db push` password တောင်း | link စဉ် password မထည့်ရသေး — ထည့်ပါ သို့ Dashboard → Database → Reset password |

---

## 17. လုံခြုံရေး အမှတ်အသားများ (မဖြစ်မနေ ဖတ်ပါ)

- **`src/scripts/config.js` ကို browser အားလုံးသို့ ရောက်သည်** — publishable value များသာ ထည့်ရမည် (Supabase URL + anon key သည် RLS နှင့် ကာကွယ်ထားသောကြောင့် ပုံမှန်)။ **service_role key, `gsk_...` Groq key, လျှို့ဝှက်ချက် အခြားသော တစ်ခုမှ မထည့်ရ** — deploy လုပ်သည်နှင့် လူတိုင်းမြင်ရသည်။
- **RLS သည် ownership boundary** ဖြစ်သည် — client ပို့သော user ID ကို မယုံကြည်ဘဲ database က `auth.uid()` ဖြင့် စစ်ဆေးသည်။
- **`GROQ_API_KEY`** သည် Supabase Edge Function secret အဖြစ် server-side မှာသာ နေရမည် — frontend/repo တွင် ဘယ်တော့မှ မထားရ။
- **BYOK key** သည် browser ၏ localStorage တွင် သိမ်းသည် — ထို browser profile ကို ဝင်နိုင်သူများအတွက် မကာကွယ်ပါ (settings UI တွင် ရှင်းလင်းစွာ ဖော်ပြထားသည်)။
- `.env` / secret များကို git တွင် commit မလုပ်ရ — `.gitignore` တွင် `.env*` ပါပြီးသား။
- AI output သည် untrusted — HTML ကို sanitize လုပ်ထားပြီး raw HTML default ပိတ်ထားသည်; AI draft များကို သင် approve မလုပ်မချင်း မတင်ပါ။
- Export ဖိုင်များ သင့်စက်မှ မထွက်ဘဲ explicit action ဖြင်သာ upload ဖြစ်သည်။

---

## 18. လုပ်ဆောင်ပြီးစီးမှု အကျဉ်းချုပ်

| အဆင့် | လုပ်ဆောင်ချက် | အခြေအနေ (ဤစက်တွင်) |
|---|---|---|
| 3 | GitHub Pages hosting | ✅ live |
| 4 | Supabase project | ✅ ရှိပြီး (`otbjkarkexqfujotsdcw`) |
| 5 | Supabase CLI install + init | ✅ ပြီး (`v2.122.0`) |
| 5.3–5.4 | CLI login + link | ✅ ပြီး |
| 6 | Migration `db push` | ✅ `0001_init.sql` တင်ပြီး (REST `[]` 200 ဖြင့် အတည်ပြု) |
| 7 | `config.js` (url + anonKey) | ✅ ဖြည့်ပြီး (test 87+11 ပြီး) |
| 8 | Site URL / Redirect URLs / Email | ⬜ |
| 9–10 | Google + GitHub OAuth | ⬜ |
| 11 | AI (BYOK သို့ proxy) | ⬜ |
| 12 | Sync စမ်းသပ် | ⬜ |
| 15 | Verification checklist | ⬜ |

⬜ အဆင့်များကို အထက်အတိုင်း တစ်ဆင့်ချင်း လုပ်ဆောင်ပြီး checklist ပြည့်စုံပါက DevNotes သည် **100% functional** ဖြစ်ပါမည်။

---

*ဤစာရွက်ကို implementation နှင့် ကိုက်ညီစေရန် `src/scripts/config.js`, `auth-service.js`, `ai-service.js`, `supabase/migrations/0001_init.sql`, `supabase/functions/ai-proxy/index.ts`, `sw.js` တို့မှ တိုက်ရိုက်ရေးထားခြင်း ဖြစ်သည်။*
