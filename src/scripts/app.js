/**
 * app.js — application boot sequence.
 *
 * Order matters and is deliberately conservative:
 *   1. open IndexedDB (authoritative store)      — failure shows a real error
 *   2. load + apply preferences                  — theme/typography before paint
 *   3. mount shell (sidebar, topbar, router)
 *   4. start connectivity + sync engine          — no network required
 *   5. restore auth session, then run the first-sign-in choice gate
 *   6. register the service worker (static hosting only)
 *
 * Nothing here requires Supabase or Groq: when they are not configured the
 * app runs fully local and the sync state stays 'disabled'.
 */

import { getDB } from './db/database.js';
import { fontsRepo } from './db/repositories/index.js';
import { loadPrefs } from './features/settings/prefs.js';
import { mountSidebar } from './components/sidebar.js';
import { mountTopbar } from './components/topbar.js';
import { initTooltips } from './components/tooltip.js';
import { startRouter, navigate } from './router.js';
import { initConnectivity, refreshSyncStatus } from './sync/connectivity.js';
import { startSyncEngine, triggerSync } from './sync/sync-engine.js';
import { initAuth } from './services/auth-service.js';
import { ensureSyncChoice, hasDecidedChoice } from './features/auth/sync-choice.js';
import { authStore, bootStore } from './state.js';
import { shortcut } from './utils/keyboard.js';
import { bus } from './utils/bus.js';
import { initStyleGuard } from './features/diagnostics/style-guard.js';

const RETRY_SYNC_CHOICE_MS = 90_000;
let lastChoiceAttempt = 0;

function setBootStatus(message) {
  bootStore.set({ status: 'loading', message });
  const node = document.getElementById('boot-status');
  if (node) {
    const label = node.querySelector('span:last-child');
    if (label && message) label.textContent = message;
  }
}

function failBoot(error) {
  console.error('[boot] failed:', error);
  bootStore.set({ status: 'error', error });
  const node = document.getElementById('boot-status');
  if (!node) return;
  node.classList.add('boot-status--error');
  node.setAttribute('role', 'alert');
  node.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = 'DevNotes could not start';
  const detail = document.createElement('span');
  detail.textContent = String(error?.message || error);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn--sm btn--primary';
  retry.textContent = 'Reload';
  retry.addEventListener('click', () => location.reload());
  node.append(title, detail, retry);
}

/**
 * Bridge auth events into the synchronization lifecycle.
 * The gate must run before the engine may drain the queue (never silently
 * merge two existing libraries), so it suspends syncing synchronously.
 */
function installAuthBridge() {
  bus.on('auth:changed', async (event) => {
    if (event.status === 'signed-in' && event.user) {
      lastChoiceAttempt = Date.now();
      try {
        const outcome = await ensureSyncChoice(event.user);
        if (outcome && outcome !== 'deferred' && outcome !== 'local') {
          triggerSync('signin', { delay: 600 });
        }
      } catch (err) {
        console.warn('[boot] sync choice failed:', err?.message);
      }
    }
    await refreshSyncStatus();
  });

  // Deferred first-sign-in question (dialog dismissed or network down):
  // retry when the user returns to the tab, throttled so it never spams.
  window.addEventListener('focus', () => {
    const { status, user } = authStore.get();
    if (status !== 'signed-in' || !user) return;
    if (hasDecidedChoice(user)) return;
    if (Date.now() - lastChoiceAttempt < RETRY_SYNC_CHOICE_MS) return;
    lastChoiceAttempt = Date.now();
    void ensureSyncChoice(user).then((outcome) => {
      if (outcome && outcome !== 'deferred' && outcome !== 'local') triggerSync('signin', { delay: 400 });
    });
  });
}

function installShortcuts() {
  shortcut('mod+k', () => {
    void import('./components/palette.js').then((m) => m.togglePalette());
  }, { description: 'Search and commands' });

  // Topbar quick-create advertises "N" for a new lesson.
  shortcut('n', () => {
    navigate('/lesson/new');
    return false;
  }, { description: 'New lesson' });
}

function registerServiceWorker() {
  // Service workers need a secure/HTTP origin — file:// never registers.
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;

  navigator.serviceWorker.register('./sw.js').catch((err) => {
    // A missing/offline SW is not fatal: the app works without it.
    console.info('[sw] registration skipped:', err?.message);
  });
}

async function boot() {
  setBootStatus('Opening your library…');
  await getDB();

  setBootStatus('Loading preferences…');
  await loadPrefs();

  // User-imported fonts live in IndexedDB; failures fall back to system fonts.
  await fontsRepo.loadAll().catch((err) => console.warn('[fonts] load failed:', err?.message));

  setBootStatus('Preparing workspace…');
  mountSidebar(document.getElementById('sidebar-inner'));
  mountTopbar(document.getElementById('topbar'));
  initTooltips(document);
  installShortcuts();

  startRouter(document.getElementById('page-outlet'));

  initConnectivity({
    onReconnect: () => triggerSync('reconnect', { delay: 300 }),
  });
  startSyncEngine();
  installAuthBridge();

  // Restores an existing session (fires 'auth:changed' → sync choice gate).
  await initAuth();

  registerServiceWorker();

  document.getElementById('app-shell')?.removeAttribute('hidden');
  document.getElementById('boot-status')?.setAttribute('hidden', '');
  bootStore.set({ status: 'ready', message: '' });

  // If no stylesheet applied (poisoned cache, proxy, extension), the page is
  // functional but unreadable — surface that with a recovery path instead of
  // silently rendering raw content.
  initStyleGuard();

  bus.emit('app:ready');
}

boot().catch(failBoot);
