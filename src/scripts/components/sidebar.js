/**
 * sidebar.js — persistent desktop navigation (drawer below 60rem).
 * Badges (review due, trash) refresh on data changes; the nav structure
 * itself comes from navigation.js so the palette can't drift from the sidebar.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { NAV_SECTIONS } from '../navigation.js';
import { routeStore, uiStore } from '../state.js';
import { navigate, isActivePath } from '../router.js';
import { bus } from '../utils/bus.js';
import { getStats } from '../db/repositories/index.js';
import { debounce } from '../utils/debounce.js';

const badges = {}; // id → number
let inner = null;

const refreshBadges = debounce(async () => {
  if (!inner) return;
  try {
    const stats = await getStats();
    badges.reviewDue = stats.reviewDue;
    badges.trash = stats.lessonsTrashed + stats.snippetsTrashed + stats.cardsTrashed;
    paintBadges();
  } catch (err) {
    console.warn('[sidebar] badge refresh failed:', err?.message);
  }
}, 600);

function paintBadges() {
  if (!inner) return;
  for (const [id, value] of Object.entries(badges)) {
    const badge = inner.querySelector(`[data-badge-for="${id}"]`);
    if (!badge) continue;
    badge.textContent = value > 0 ? String(value) : '';
    badge.hidden = !value;
  }
}

function setActive(path) {
  if (!inner) return;
  inner.querySelectorAll('.nav-item').forEach((el) => {
    const target = el.getAttribute('href')?.replace(/^#/, '');
    if (!target) return;
    if (isActivePath(target)) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

/** @param {HTMLElement} container element that receives the nav content */
export function mountSidebar(container) {
  inner = container;
  clear(inner);

  inner.appendChild(
    h('a', {
      class: 'sidebar__brand',
      href: '#/dashboard',
      on: {
        click: (event) => {
          event.preventDefault();
          navigate('/dashboard');
        },
      },
    }, [
      h('img', { attrs: { src: './src/assets/icons/icon.svg', alt: '' } }),
      h('span', { text: 'DevNotes' }),
    ]),
  );

  for (const section of NAV_SECTIONS) {
    inner.appendChild(h('div', { class: 'sidebar__section-label', text: section.label }));
    const nav = h('nav', { class: 'sidebar__nav', attrs: { 'aria-label': section.label } });
    for (const item of section.items) {
      nav.appendChild(
        h('a', {
          class: 'nav-item',
          href: `#${item.path}`,
          dataset: { navId: item.id },
          on: {
            click: (event) => {
              event.preventDefault();
              navigate(item.path);
            },
          },
        }, [
          icon(item.icon, 'nav-item__icon'),
          h('span', { class: 'nav-item__label', text: item.label }),
          item.badge
            ? h('span', {
                class: 'nav-item__badge',
                dataset: { badgeFor: item.badge },
                attrs: { 'aria-label': `${item.label} items` },
                hidden: true,
              })
            : null,
        ]),
      );
    }
    inner.appendChild(nav);
  }

  // The sidebar intentionally has NO search entry: the header's search button
  // opens the same command palette (palette.js), and duplicated controls for
  // one target are removed by design.
  const scrimEl = document.getElementById('sidebar-scrim');
  scrimEl?.addEventListener('click', closeNavDrawer);

  routeStore.subscribe((state) => setActive(state.path));
  uiStore.subscribe((state) => {
    document.getElementById('app-shell')?.setAttribute('data-nav-open', String(state.navOpen));
    if (scrimEl) scrimEl.hidden = !state.navOpen;
    syncDrawerFocus(state.navOpen);
  });

  // Bubble phase on purpose: dialogs/menus/palette call stopPropagation() on
  // their Escape handling, so this fires only when no other overlay owns the key.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !uiStore.get().navOpen) return;
    closeNavDrawer();
  });

  bus.on('data:changed', () => refreshBadges());
  refreshBadges();
  setActive(routeStore.get().path);
}

/**
 * Drawer focus management: hand focus into the drawer when it opens and back
 * to the toggle when it closes, so keyboard/screen-reader users are never
 * stranded behind the scrim. Programmatic focus must not scroll the page.
 */
function syncDrawerFocus(open) {
  const drawer = document.getElementById('sidebar');
  const toggle = document.querySelector('.menu-toggle');
  if (open) {
    drawer?.focus({ preventScroll: true });
    return;
  }
  // Only reclaim focus when it would otherwise be lost with the hidden drawer.
  if (drawer?.contains(document.activeElement)) {
    toggle?.focus({ preventScroll: true });
  }
}

/** Close the mobile drawer (called by scrim clicks / navigation). */
export function closeNavDrawer() {
  uiStore.set({ navOpen: false });
}
