/**
 * menu.js — popup menu / context menu with keyboard support.
 * One menu is open at a time; Escape or outside click closes and restores
 * focus to the anchor.
 */

import { h, on, trapFocus } from '../utils/dom.js';
import { icon } from '../utils/icons.js';

let openState = null;

export function closeActiveMenu() {
  if (!openState) return;
  const anchor = openState.anchor;
  const { node, release, cleanup } = openState;
  openState = null;
  cleanup();
  release();
  node.remove();
  if (anchor && document.contains(anchor)) anchor.focus?.();
}

export function isMenuOpen() {
  return Boolean(openState);
}

/**
 * Open a menu next to an anchor element.
 * @param {HTMLElement} anchor
 * @param {Array<{label?: string, icon?: string, hint?: string, danger?: boolean,
 *   disabled?: boolean, separator?: boolean, groupLabel?: string,
 *   onSelect?: Function}>} items
 * @param {{align?: 'start'|'end', restoreFocus?: boolean}} [options]
 */
export function openMenu(anchor, items, options = {}) {
  closeActiveMenu();
  const { align = 'start', restoreFocus = true } = options;

  const node = h('div', {
    class: 'menu',
    attrs: { role: 'menu', tabindex: '-1' },
  });

  for (const item of items) {
    if (item.separator) {
      node.appendChild(h('div', { class: 'menu__separator', attrs: { role: 'separator' } }));
      continue;
    }
    if (item.groupLabel) {
      node.appendChild(h('div', { class: 'menu__label', text: item.groupLabel }));
      continue;
    }
    node.appendChild(h('button', {
      class: 'menu__item',
      type: 'button',
      attrs: {
        role: 'menuitem',
        ...(item.disabled ? { 'aria-disabled': 'true', disabled: '' } : {}),
      },
      dataset: item.danger ? { danger: 'true' } : {},
      on: {
        click: (event) => {
          if (item.disabled) { event.preventDefault(); return; }
          closeActiveMenu();
          item.onSelect?.(event);
        },
      },
    }, [
      item.icon ? icon(item.icon) : null,
      h('span', { text: item.label }),
      item.hint ? h('span', { class: 'menu__hint', text: item.hint }) : null,
    ]));
  }

  document.body.appendChild(node);

  // Position after appending so dimensions are known.
  const rect = anchor.getBoundingClientRect();
  const menuRect = node.getBoundingClientRect();
  const gap = 4;
  let top = rect.bottom + gap;
  let left = align === 'end' ? rect.right - menuRect.width : rect.left;

  if (top + menuRect.height > window.innerHeight - gap) {
    const above = rect.top - menuRect.height - gap;
    top = above >= gap ? above : Math.max(gap, window.innerHeight - menuRect.height - gap);
  }
  left = Math.min(Math.max(gap, left), Math.max(gap, window.innerWidth - menuRect.width - gap));

  node.style.top = `${Math.round(top)}px`;
  node.style.left = `${Math.round(left)}px`;

  const release = trapFocus(node, { onEscape: () => closeActiveMenu({ restoreFocus }) });

  const cleanup = (() => {
    const offPointer = on(window, 'pointerdown', (event) => {
      if (!node.contains(event.target) && !anchor.contains(event.target)) {
        closeActiveMenu({ restoreFocus });
      }
    }, true);
    const offResize = on(window, 'resize', () => closeActiveMenu({ restoreFocus: false }));
    const offScroll = on(window, 'scroll', () => closeActiveMenu({ restoreFocus: false }), true);
    return () => { offPointer(); offResize(); offScroll(); };
  })();

  openState = { anchor, node, release, cleanup };
  // Focus first item for keyboard users.
  node.querySelector('.menu__item')?.focus();
  return { close: () => closeActiveMenu({ restoreFocus }) };
}
