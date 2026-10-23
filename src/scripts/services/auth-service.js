/**
 * auth-service.js — Supabase authentication with explicit states.
 *
 * Rules:
 *  - Local-only functionality NEVER requires authentication.
 *  - OAuth buttons are only active when Supabase is configured; provider
 *    credentials/redirect URLs are documented setup steps (README), and real
 *    provider errors are surfaced instead of simulated success.
 *  - Session state flows into authStore + the `auth:changed` bus event.
 */

import { getSupabaseClient, isSupabaseConfigured } from './supabase-client.js';
import { authStore } from '../state.js';
import { setSyncActive } from '../sync/sync-queue.js';
import { bus } from '../utils/bus.js';
import { AppError } from '../utils/errors.js';

let initialized = false;
let unsubscribeAuth = null;

function publish(status, user = null, error = null) {
  authStore.set({ status, user, error });
  setSyncActive(status === 'signed-in');
  bus.emit('auth:changed', { status, user, error });
}

/** Friendly wording for Supabase auth errors (never leaks internals). */
function toAppError(error) {
  const message = String(error?.message || 'Authentication failed');
  if (/invalid login credentials/i.test(message)) {
    return new AppError('Email or password is incorrect', { code: 'bad-credentials', retryable: false });
  }
  if (/email not confirmed/i.test(message)) {
    return new AppError('Please confirm your email address first', { code: 'unconfirmed', retryable: false });
  }
  if (/already registered|already been registered/i.test(message)) {
    return new AppError('An account with this email already exists', { code: 'exists', retryable: false });
  }
  if (/rate limit|too many requests/i.test(message)) {
    return new AppError('Too many attempts — please wait a moment', { code: 'rate-limit', retryable: true });
  }
  if (/password.*(6|short)/i.test(message)) {
    return new AppError('Password must be at least 6 characters', { code: 'weak-password', retryable: false });
  }
  if (/fetch|network|failed to fetch/i.test(message)) {
    return new AppError('Could not reach the sign-in service', { code: 'network', retryable: true });
  }
  return new AppError(message, { code: 'auth', retryable: false });
}

/**
 * Initialize auth: restores an existing session and subscribes to changes.
 * Safe to call once at boot; resolves immediately when not configured.
 */
export async function initAuth() {
  if (initialized) return authStore.get();
  initialized = true;

  if (!isSupabaseConfigured()) {
    publish('signed-out', null, null);
    return authStore.get();
  }

  try {
    const client = await getSupabaseClient();
    const { data, error } = await client.auth.getSession();
    if (error) throw error;

    if (data.session) publish('signed-in', data.session.user, null);
    else publish('signed-out', null, null);

    const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        publish('signed-out', null, null);
      } else if (session) {
        publish('signed-in', session.user, null);
      }
    });
    unsubscribeAuth = subscription?.subscription?.unsubscribe ?? null;
  } catch (err) {
    console.warn('[auth] init failed:', err?.message);
    publish('signed-out', null, toAppError(err));
    initialized = false; // allow retry (e.g. transient network at boot)
  }
  return authStore.get();
}

async function requireClient() {
  if (!isSupabaseConfigured()) {
    throw new AppError(
      'Cloud sign-in is not configured. Add your Supabase URL and publishable key in src/scripts/config.js.',
      { code: 'not-configured', retryable: false },
    );
  }
  const client = await getSupabaseClient();
  if (!client) throw new AppError('Sign-in service unavailable', { code: 'unavailable', retryable: false });
  return client;
}

export async function signUp({ email, password }) {
  try {
    const client = await requireClient();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    // data.session is null when email confirmation is required — report truthfully.
    if (data.session) publish('signed-in', data.user, null);
    return { needsConfirmation: !data.session, user: data.user };
  } catch (err) {
    throw toAppError(err);
  }
}

export async function signIn({ email, password }) {
  try {
    const client = await requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    publish('signed-in', data.user, null);
    return data.user;
  } catch (err) {
    throw err instanceof AppError ? err : toAppError(err);
  }
}

export async function signInWithOAuth(provider) {
  try {
    const client = await requireClient();
    // Requires the provider + redirect URL to be configured in Supabase;
    // a missing configuration surfaces as a real error below.
    const redirectTo = `${location.origin}${location.pathname}`;
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (error) throw error;
    return { redirecting: true };
  } catch (err) {
    throw err instanceof AppError ? err : toAppError(err);
  }
}

export async function signOut() {
  try {
    const client = await getSupabaseClient();
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) throw error;
  } catch (err) {
    console.warn('[auth] sign-out error:', err?.message);
  } finally {
    publish('signed-out', null, null);
  }
}

export async function sendPasswordReset(email) {
  try {
    const client = await requireClient();
    const redirectTo = `${location.origin}${location.pathname}#/account?reset=1`;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
    return true;
  } catch (err) {
    throw err instanceof AppError ? err : toAppError(err);
  }
}

export async function updatePassword(password) {
  try {
    const client = await requireClient();
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
    return true;
  } catch (err) {
    throw err instanceof AppError ? err : toAppError(err);
  }
}

export async function getCurrentUser() {
  if (!isSupabaseConfigured()) return null;
  try {
    const client = await getSupabaseClient();
    const { data, error } = await client.auth.getUser();
    if (error) return null;
    return data.user ?? null;
  } catch {
    return null;
  }
}

export function isAuthConfigured() {
  return isSupabaseConfigured();
}

export function onAuthChanged(handler) {
  return bus.on('auth:changed', handler);
}

export function disposeAuth() {
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  initialized = false;
}
