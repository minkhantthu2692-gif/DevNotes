/**
 * connectivity.js — real connectivity state.
 *
 * `navigator.onLine` only reports link state, not backend reachability, so we
 * verify with an actual request when Supabase is configured (§17). The store
 * exposed here drives the topbar pill and Settings → Offline & sync.
 */

import { syncStore } from '../state.js';
import { queueStats, isSyncEnabled, isSyncSuspended } from './sync-queue.js';
import { SUPABASE } from '../config.js';
import { bus } from '../utils/bus.js';

const LAST_SYNC_KEY = 'lastSyncAt';

let networkUp = typeof navigator === 'undefined' ? true : navigator.onLine;
let backendReachable = true; // optimistic until proven otherwise
let probing = false;
let listenersInstalled = false;
let probeTimer = null;
let reconnectHandler = null;

/** Snapshot used by UI code. */
export function connectivityInfo() {
  return { networkUp, backendReachable, probing, signedIn: isSyncEnabled() };
}

async function readLastSync() {
  try {
    const { getPref } = await import('../db/repositories/index.js');
    const value = await getPref(LAST_SYNC_KEY, null);
    return value;
  } catch {
    return null;
  }
}

/** Probe the configured backend with a short-timeout request. */
export async function probeBackend({ timeoutMs = 5000 } = {}) {
  if (!SUPABASE.enabled()) return null;
  if (probing) return backendReachable;
  probing = true;
  updateStore();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Supabase exposes an unauthenticated health endpoint; even a 4xx proves
    // the host is reachable.
    const response = await fetch(`${SUPABASE.url}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: SUPABASE.anonKey },
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    backendReachable = response.status < 500;
  } catch {
    backendReachable = false;
  } finally {
    probing = false;
    updateStore();
  }
  return backendReachable;
}

async function updateStore() {
  const enabled = isSyncEnabled();
  const stats = await queueStats().catch(() => ({ pending: 0, syncing: 0, failed: 0 }));
  const lastSyncAt = await readLastSync();

  let state = 'disabled';
  if (enabled) {
    if (isSyncSuspended()) state = 'paused';
    else if (!networkUp || !backendReachable) state = 'offline';
    else if (stats.failed > 0) state = 'error';
    else if (stats.syncing > 0) state = 'syncing';
    else if (stats.pending > 0) state = 'pending';
    else state = 'idle';
  }

  syncStore.set({
    state,
    suspended: enabled && isSyncSuspended(),
    pending: stats.pending,
    syncing: stats.syncing,
    failed: stats.failed,
    lastSyncAt,
    message: state === 'offline' ? 'Waiting for a connection' : state === 'paused' ? 'Sync paused' : '',
  });
}

/** Recompute the sync store (call after queue or auth changes). */
export async function refreshSyncStatus() {
  await updateStore();
}

/** Record a successful full sync run (persisted in the meta store). */
export async function markSyncedNow() {
  try {
    const { withStores, req } = await import('../db/database.js');
    await withStores('meta', 'readwrite', (stores) =>
      req(stores.meta.put({ key: LAST_SYNC_KEY, value: Date.now() })),
    );
  } catch (err) {
    console.warn('[sync] could not persist lastSyncAt:', err?.message);
  }
  await updateStore();
}

/**
 * Install online/offline + reachability handling.
 * @param {{onReconnect: () => void}} options called when connectivity returns
 */
export function initConnectivity({ onReconnect = null } = {}) {
  if (listenersInstalled) return;
  listenersInstalled = true;
  reconnectHandler = onReconnect;

  const wentOffline = () => {
    networkUp = false;
    updateStore();
  };

  const wentOnline = async () => {
    networkUp = true;
    updateStore();
    await probeBackend();
    if (backendReachable && reconnectHandler) reconnectHandler();
    updateStore();
  };

  window.addEventListener('offline', wentOffline);
  window.addEventListener('online', wentOnline);

  // Periodic reachability check while signed in (cheap, unauthenticated).
  if (SUPABASE.enabled()) {
    probeTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void probeBackend();
    }, 90000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && networkUp && !backendReachable) {
      void probeBackend().then((ok) => { if (ok && reconnectHandler) reconnectHandler(); });
    }
  });

  bus.on('sync:changed', () => updateStore());
  bus.on('auth:changed', () => { void probeBackend(); updateStore(); });

  updateStore();
}

export function stopConnectivity() {
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = null;
}
