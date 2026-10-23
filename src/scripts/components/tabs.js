/**
 * tabs.js — WAI-ARIA tab pattern with roving tabindex and arrow keys.
 */

import { h, on } from '../utils/dom.js';

/**
 * @param {{tabs: Array<{id: string, label: string, badge?: string|number}>,
 *          active: string, onChange: (id: string) => void,
 *          ariaLabel?: string}} config
 * @returns {{root: HTMLElement, setActive: (id: string) => void, destroy: () => void}}
 */
export function createTabs({ tabs, active, onChange, ariaLabel = 'Sections' }) {
  let current = active;
  const buttons = new Map();

  const list = h('div', {
    class: 'tabs',
    attrs: { role: 'tablist', 'aria-label': ariaLabel },
  });

  const select = (id, { focus = false } = {}) => {
    if (!tabs.some((tab) => tab.id === id)) return;
    current = id;
    for (const [tabId, button] of buttons) {
      const selected = tabId === id;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    onChange(id);
  };

  for (const tab of tabs) {
    const button = h('button', {
      class: 'tab',
      type: 'button',
      id: `tab-${tab.id}`,
      text: tab.label,
      attrs: {
        role: 'tab',
        'aria-selected': String(tab.id === current),
        'aria-controls': `tabpanel-${tab.id}`,
        tabindex: tab.id === current ? '0' : '-1',
      },
      on: { click: () => select(tab.id) },
    });
    buttons.set(tab.id, button);
    list.appendChild(button);
  }

  const offKeys = on(list, 'keydown', (event) => {
    const order = tabs.map((tab) => tab.id);
    const index = order.indexOf(current);
    if (index === -1) return;
    let next = null;
    if (event.key === 'ArrowRight') next = order[(index + 1) % order.length];
    else if (event.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length];
    else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order[order.length - 1];
    if (next) {
      event.preventDefault();
      select(next, { focus: true });
    }
  });

  return {
    root: list,
    setActive: (id) => select(id),
    getActive: () => current,
    destroy: () => offKeys(),
  };
}

/** Panel element matching createTabs' aria-controls ids. */
export function tabPanel(id, active = false) {
  return h('div', {
    class: 'tab-panel',
    id: `tabpanel-${id}`,
    attrs: { role: 'tabpanel', 'aria-labelledby': `tab-${id}`, tabindex: '0' },
    hidden: !active,
  });
}
