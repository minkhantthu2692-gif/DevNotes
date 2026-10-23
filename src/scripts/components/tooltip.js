/**
 * tooltip.js — hover/focus tooltips driven by `data-tooltip` attributes.
 * One global listener pair; tooltips are purely informational (never the only
 * source of meaning — accessible labels still exist on the control itself).
 */

import { h } from '../utils/dom.js';

let node = null;
let currentOwner = null;
let showTimer = null;

function hide() {
  clearTimeout(showTimer);
  currentOwner = null;
  node?.remove();
  node = null;
}

function show(target) {
  const text = target.getAttribute('data-tooltip');
  if (!text) return;
  hide();

  node = h('div', { class: 'tooltip', role: 'tooltip', text });
  document.body.appendChild(node);

  const rect = target.getBoundingClientRect();
  const tip = node.getBoundingClientRect();
  let top = rect.top - tip.height - 6;
  if (top < 6) top = rect.bottom + 6;
  let left = rect.left + rect.width / 2 - tip.width / 2;
  left = Math.min(Math.max(6, left), window.innerWidth - tip.width - 6);

  node.style.top = `${Math.round(top)}px`;
  node.style.left = `${Math.round(left)}px`;
  currentOwner = target;
}

/** Start tooltip behavior (called once from app.js). */
export function initTooltips(root = document) {
  root.addEventListener('pointerover', (event) => {
    const owner = event.target.closest?.('[data-tooltip]');
    if (!owner || owner === currentOwner) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(owner), 450);
  });

  root.addEventListener('pointerout', (event) => {
    const owner = event.target.closest?.('[data-tooltip]');
    if (owner && owner === currentOwner) hide();
    else if (owner) clearTimeout(showTimer);
  });

  root.addEventListener('focusin', (event) => {
    const owner = event.target.closest?.('[data-tooltip]');
    if (owner) show(owner);
  });

  root.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
