/**
 * config.js — application constants and *publishable* service configuration.
 *
 * SECURITY: This file ships to every browser. It may only contain publishable
 * values (Supabase URL + anon/publishable key are designed for that, guarded by
 * Row Level Security). Never put a Supabase service-role key, a shared Groq
 * key, or any other secret here — see README "Security".
 */

export const APP = {
  name: 'DevNotes',
  version: '1.0.0',
  backupFormat: 1, // versioned backup schema (export/import compatibility)
};

/** localStorage mirror keys (small, non-sensitive bootstrap values only). */
export const STORAGE_KEYS = {
  ui: 'devnotes.ui',          // appearance/typography preferences (fast boot)
  lastRoute: 'devnotes.route', // remembered navigation state
  recentSearches: 'devnotes.recent-searches',
  aiKey: 'devnotes.ai.key',   // BYOK Groq key (user-owned, see README security note)
};

/**
 * Supabase project configuration.
 * Fill these two values to enable authentication and cloud sync; leave them
 * empty to run DevNotes fully local (everything except sync/auth/AI-proxy).
 * How to obtain them: README → "Supabase setup".
 */
export const SUPABASE = {
  url: '',        // e.g. 'https://abcdefghijklmnop.supabase.co'
  anonKey: '',    // publishable/anon key
  enabled() {
    return Boolean(SUPABASE.url && SUPABASE.anonKey);
  },
};

/**
 * Groq AI configuration. AI is optional — the app is fully usable without it.
 * Model IDs change over time; verify yours at https://console.groq.com/docs/models
 * or use the "Load available models" action in Settings → AI.
 */
export const AI = {
  endpoint: 'https://api.groq.com/openai/v1',
  modelsEndpoint: 'https://api.groq.com/openai/v1/models',
  defaultModel: 'llama-3.3-70b-versatile',
  presets: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (versatile)' },
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (fast)' },
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (fast)' },
  ],
  /**
   * Optional authenticated server-side proxy (Supabase Edge Function) used
   * instead of a browser key for shared deployments. Empty = BYOK mode.
   * e.g. 'https://YOUR-PROJECT.supabase.co/functions/v1/ai-proxy'
   */
  edgeFunctionUrl: '',
  defaultTimeoutMs: 45000,
  maxContextChars: 8000, // hard cap on lesson text attached as AI context
};

/** Service worker cache version lives in sw.js (workers cannot import modules). */
