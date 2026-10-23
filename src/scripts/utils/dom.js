/**
 * dom.js — small DOM helpers used by every component.
 * Text always goes through textContent; HTML is never injected from data.
 */

/**
 * Create an element.
 * @param {string} tag tag name, or 'svg:circle' style namespaced tags
 * @param {object} [props] className/text/dataset/attrs/on + direct properties
 * @param {Array|Node|string|number|null} [children] appended after props
 * @returns {Element}
 */
export function h(tag, props = {}, children = []) {
  const isSvg = tag.startsWith('svg:');
  const name = isSvg ? tag.slice(4) : tag;
  const el = isSvg
    ? document.createElementNS('http://www.w3.org/2000/svg', name)
    : document.createElement(name);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'class' || key === 'className') {
      el.setAttribute('class', value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'html') {
      // Only ever used with trusted, already-escaped/structured markup
      // (highlight.js output, static templates) — never with raw data.
      el.innerHTML = String(value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style') {
      Object.assign(el.style, value);
    } else if (key === 'attrs') {
      for (const [a, v] of Object.entries(value)) {
        if (v !== undefined && v !== null && v !== false) el.setAttribute(a, v === true ? '' : v);
      }
    } else if (key === 'on') {
      for (const [type, fn] of Object.entries(value)) {
        if (typeof fn === 'function') el.addEventListener(type, fn);
      }
    } else if (key in el && typeof value !== 'object') {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  }

  append(el, children);
  return el;
}

/** Append children (arrays flattened, null/undefined skipped, strings as text). */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
  return parent;
}

/** Remove every child of a node (keeps the node itself usable). */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Add a listener and return an unsubscribe function (used with cleanups). */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/**
 * Trap Tab focus inside a container until the returned function is called.
 * Used by dialogs and the command palette; also forwards Escape handling.
 */
export function trapFocus(container, { onEscape } = {}) {
  const previous = document.activeElement;
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const firstFocusable = () => qsa(selector, container).find((el) => el.offsetParent !== null) || container;

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscape?.(event);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = qsa(selector, container).filter((el) => el.offsetParent !== null);
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeydown);
  // Focus after layout so transitions don't steal the starting focus.
  queueMicrotask(() => firstFocusable()?.focus());

  return function release() {
    container.removeEventListener('keydown', onKeydown);
    if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
      previous.focus();
    }
  };
}

/** Delegated click handler: fires when `target` matches or contains `sel`. */
export function delegated(root, sel, handler) {
  return on(root, 'click', (event) => {
    const match = event.target.closest?.(sel);
    if (match && root.contains(match)) handler(event, match);
  });
}
