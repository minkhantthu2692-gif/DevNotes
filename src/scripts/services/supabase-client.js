/**
 * supabase-client.js — lazy loader for the vendored Supabase UMD bundle.
 *
 * The library is only fetched when Supabase is configured, so the app's
 * local-only mode never pays for it (and works offline immediately).
 * Only the publishable anon key reaches the browser — enforced by RLS.
 */

import { SUPABASE } from '../config.js';

let client = null;
let loading = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-vendor="supabase"]`);
    if (existing) {
      if (window.supabase) { resolve(); return; }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load the Supabase library')));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.vendor = 'supabase';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load the Supabase library'));
    document.head.appendChild(script);
  });
}

export function isSupabaseConfigured() {
  return SUPABASE.enabled();
}

/**
 * Get the shared client (null when Supabase isn't configured).
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient|null>}
 */
export function getSupabaseClient() {
  if (!SUPABASE.enabled()) return Promise.resolve(null);
  if (client) return Promise.resolve(client);
  if (loading) return loading;

  loading = (async () => {
    try {
      if (!window.supabase?.createClient) {
        const url = new URL('../../vendor/supabase-js/supabase.js', import.meta.url).href;
        await loadScriptOnce(url);
      }
      if (!window.supabase?.createClient) {
        throw new Error('Supabase library loaded but createClient is missing');
      }
      client = window.supabase.createClient(SUPABASE.url, SUPABASE.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: 'devnotes.auth.session',
          flowType: 'pkce',
        },
        global: { headers: { 'x-application-name': 'devnotes' } },
      });
      return client;
    } catch (err) {
      loading = null; // allow retry on the next attempt
      throw err;
    }
  })();

  return loading;
}

/** Reset module state (tests / sign-out hard reset). */
export function resetClient() {
  client = null;
  loading = null;
}
