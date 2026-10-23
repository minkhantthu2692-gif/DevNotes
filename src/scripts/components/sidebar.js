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
  routeStore.subscribe((state) => setActive(state.path));
  uiStore.subscribe((state) => {
    document.getElementById('app-shell')?.setAttribute('data-nav-open', String(state.navOpen));
    const scrim = document.getElementById('sidebar-scrim');
    if (scrim) scrim.hidden = !state.navOpen;
  });

  bus.on('data:changed', () => refreshBadges());
  refreshBadges();
  setActive(routeStore.get().path);
}

/** Close the mobile drawer (called by scrim clicks / navigation). */
export function closeNavDrawer() {
  uiStore.set({ navOpen: false });
}
