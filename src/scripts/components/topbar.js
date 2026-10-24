/**
 * topbar.js — global header: drawer toggle, breadcrumbs, search entry,
 * quick-create, synchronization status and theme switch.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';
import { bus } from '../utils/bus.js';
import { routeStore, syncStore, authStore, uiStore } from '../state.js';
import { getPrefs, savePrefs } from '../features/settings/prefs.js';
import { avatarElement, getCachedProfile, loadProfile } from '../features/account/account-service.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { refreshSyncStatus } from '../sync/connectivity.js';

let slots = null; // {breadcrumbs, right}
let themeBtn = null;

function themeIcon(theme) {
  if (theme === 'dark') return 'moon';
  if (theme === 'light') return 'sun';
  return 'monitor';
}

async function cycleTheme() {
  const prefs = getPrefs();
  const order = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(prefs.theme) + 1) % order.length];
  try {
    await savePrefs({ theme: next });
    toast(`Theme: ${next}`, { tone: 'info', duration: 1600 });
  } catch (err) {
    toast('Could not save the theme preference', { tone: 'danger' });
  }
}

function renderThemeButton() {
  const theme = getPrefs().theme;
  if (!themeBtn) {
    themeBtn = h('button', {
      class: 'icon-btn theme-btn',
      type: 'button',
      on: { click: cycleTheme },
      attrs: { 'data-tooltip': 'Switch theme (light / dark / system)' },
    });
  }
  clear(themeBtn);
  themeBtn.appendChild(icon(themeIcon(theme)));
  themeBtn.setAttribute('aria-label', `Theme: ${theme}. Activate to change.`);
  return themeBtn;
}

function syncPill() {
  const state = syncStore.get();
  const map = {
    disabled: { label: 'Local only', state: 'disabled', icon: 'cloudOff' },
    offline: { label: 'Offline', state: 'disabled', icon: 'cloudOff' },
    idle: { label: 'Synced', state: 'synced', icon: 'cloud' },
    pending: { label: `${state.pending} to sync`, state: 'pending', icon: 'cloud' },
    syncing: { label: 'Syncing…', state: 'syncing', icon: 'refresh' },
    error: { label: `${state.failed} failed`, state: 'error', icon: 'alert' },
    paused: { label: 'Sync paused', state: 'pending', icon: 'cloudOff' },
  };
  const info = map[state.state] || map.disabled;

  return h('button', {
    class: 'sync-pill',
    type: 'button',
    dataset: { state: info.state },
    attrs: { 'aria-label': `Synchronization: ${info.label}. Open Account & Synchronization.` },
    on: {
      click: () => {
        void refreshSyncStatus();
        navigate('/account');
      },
    },
  }, [icon(info.icon), h('span', { text: info.label })]);
}

function updateSyncPill() {
  const host = document.getElementById('topbar-sync');
  if (!host) return;
  clear(host);
  host.appendChild(syncPill());
}

function updateBreadcrumbs(items = []) {
  if (!slots?.breadcrumbs) return;
  clear(slots.breadcrumbs);

  if (!items.length) return;
  items.forEach((item, index) => {
    const isLast = index === items.length - 1;
    if (index > 0) slots.breadcrumbs.appendChild(h('span', { class: 'breadcrumbs__sep', text: '/', attrs: { 'aria-hidden': 'true' } }));

    if (isLast) {
      slots.breadcrumbs.appendChild(h('span', { class: 'breadcrumbs__current', text: item.label, attrs: { 'aria-current': 'page' } }));
    } else {
      slots.breadcrumbs.appendChild(h('a', {
        href: `#${item.path}`,
        text: item.label,
        on: {
          click: (event) => {
            event.preventDefault();
            navigate(item.path);
          },
        },
      }));
    }
  });
}

/** Quick-create menu — every entry lands on a real create flow. */
function openQuickCreate(anchor) {
  openMenu(anchor, [
    { label: 'New lesson', icon: 'edit', hint: 'N', onSelect: () => navigate('/lesson/new') },
    { label: 'New snippet', icon: 'snippet', onSelect: () => navigate('/snippets?new=1') },
    { label: 'New flashcard', icon: 'review', onSelect: () => navigate('/review?new=1') },
    { label: 'New language', icon: 'languages', onSelect: () => navigate('/languages?new=1') },
    { separator: true },
    { label: 'Import backup', icon: 'upload', onSelect: () => navigate('/settings?section=data') },
  ]);
}

/** @param {HTMLElement} container the #topbar element */
export function mountTopbar(container) {
  clear(container);

  const menuBtn = h('button', {
    class: 'icon-btn menu-toggle',
    type: 'button',
    attrs: { 'aria-label': 'Open navigation', 'aria-expanded': 'false' },
    on: {
      // The store is the single source of truth; the subscriber below keeps
      // aria-expanded in sync no matter which path closes the drawer.
      click: () => uiStore.set({ navOpen: !uiStore.get().navOpen }),
    },
  }, [icon('menu')]);

  const breadcrumbs = h('nav', { class: 'breadcrumbs', attrs: { 'aria-label': 'Breadcrumb' } });

  const searchBtn = h('button', {
    class: 'topbar__search',
    type: 'button',
    attrs: { 'aria-label': 'Search and commands' },
    on: {
      click: () => import('./palette.js').then((m) => m.openPalette()),
    },
  }, [
    icon('search'),
    h('span', { class: 'topbar__search-hint', text: 'Search…' }),
    h('kbd', { text: 'Ctrl K' }),
  ]);

  const createBtn = h('button', {
    class: 'icon-btn',
    type: 'button',
    attrs: { 'aria-label': 'Quick create', 'aria-haspopup': 'menu', 'data-tooltip': 'Quick create' },
    on: { click: () => openQuickCreate(createBtn) },
  }, [icon('plus')]);

  const syncHost = h('span', { id: 'topbar-sync', class: 'topbar__sync' });

  const accountBtn = h('button', {
    class: 'icon-btn account-btn',
    type: 'button',
    attrs: { 'aria-label': 'Account', 'data-tooltip': 'Account & sync' },
    on: { click: () => navigate('/account') },
  }, [icon('user')]);

  /**
   * Show the signed-in user's avatar + username in the header. Falls back to
   * the generic person icon when signed out. Re-renders on auth/profile change
   * so a saved username or new photo updates every header at once.
   */
  function renderAccount() {
    if (!accountBtn) return;
    const { status, user } = authStore.get();
    clear(accountBtn);

    if (status !== 'signed-in' || !user) {
      accountBtn.classList.remove('account-btn--signed-in');
      accountBtn.setAttribute('aria-label', 'Account');
      accountBtn.setAttribute('data-tooltip', 'Account & sync');
      accountBtn.appendChild(icon('user'));
      return;
    }

    const profile = getCachedProfile();
    const name = profile?.username || user?.email?.split('@')[0] || 'Account';

    accountBtn.classList.add('account-btn--signed-in');
    accountBtn.setAttribute('aria-label', `Account — ${name}. Open Account & Sync.`);
    accountBtn.setAttribute('data-tooltip', `${name} · Account & sync`);
    accountBtn.appendChild(avatarElement(profile || { username: name }, { size: 24, className: 'account-btn__avatar' }));
    accountBtn.appendChild(h('span', { class: 'account-btn__name', text: name }));

    // Seed the profile once per sign-in so the header has a real username.
    if (!getCachedProfile()) void loadProfile().then(renderAccount).catch(() => {});
  }

  accountBtn.renderAccount = renderAccount;

  container.append(
    h('div', { class: 'topbar__left' }, [menuBtn, breadcrumbs]),
    h('div', { class: 'topbar__right' }, [
      searchBtn,
      createBtn,
      syncHost,
      renderThemeButton(),
      accountBtn,
    ]),
  );

  slots = { breadcrumbs };

  bus.on('breadcrumbs', updateBreadcrumbs);
  // Pages may push breadcrumbs during mount; clear at navigation start only.
  bus.on('navigation:start', () => updateBreadcrumbs([]));
  bus.on('prefs:saved', () => { if (themeBtn) renderThemeButton(); });
  syncStore.subscribe(updateSyncPill);
  authStore.subscribe(() => { updateSyncPill(); renderAccount(); });
  bus.on('profile:changed', renderAccount);
  uiStore.subscribe((state) => {
    menuBtn.setAttribute('aria-expanded', String(!!state.navOpen));
    menuBtn.setAttribute('aria-label', state.navOpen ? 'Close navigation' : 'Open navigation');
  });
  updateSyncPill();
  updateBreadcrumbs([]);
  renderAccount();
}
