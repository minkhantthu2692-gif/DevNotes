/**
 * dialog.js — accessible modal dialogs.
 * Replaces browser alert()/confirm()/prompt() for every app workflow.
 * - Focus is trapped inside and restored to the opener on close.
 * - Escape and backdrop click close (unless dismissible:false).
 * - A small stack supports confirm-on-top-of-dialog safely.
 */

import { h, trapFocus } from '../utils/dom.js';
import { icon } from '../utils/icons.js';

const stack = [];

/**
 * Open a dialog.
 * @param {object} options
 * @param {string} options.title
 * @param {Node|string} [options.body] content node or text
 * @param {Array<object>} [options.actions] {label, variant, value, onClick, autofocus, closeOnClick}
 * @param {'default'|'wide'|'full'} [options.size]
 * @param {boolean} [options.dismissible] allow Escape/backdrop close (default true)
 * @param {(value: any) => void} [options.onClose]
 * @returns {Promise<any>} resolves with the closing value when the dialog closes
 */
export function openDialog(options) {
  const {
    title,
    body = '',
    actions = [],
    size = 'default',
    dismissible = true,
    onClose,
    initialFocus = null,
  } = options;

  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'dialog-backdrop' });
    const dialog = h('div', {
      class: `dialog${size === 'wide' ? ' dialog--wide' : size === 'full' ? ' dialog--full' : ''}`,
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': String(title || 'Dialog') },
    });

    const close = (value) => {
      // Only the topmost dialog may close; ignore stale/out-of-order calls.
      const index = stack.findIndex((entry) => entry.backdrop === backdrop);
      if (index === -1) return;
      if (index !== stack.length - 1) return;
      const entry = stack.splice(index, 1)[0];
      entry.release();
      backdrop.remove();
      document.body.style.overflow = stack.length ? 'hidden' : '';
      onClose?.(value);
      resolve(value);
    };

    const header = h('div', { class: 'dialog__header' }, [
      h('h2', { class: 'dialog__title', text: title }),
      dismissible
        ? h('button', {
            class: 'icon-btn',
            type: 'button',
            attrs: { 'aria-label': 'Close dialog' },
            on: { click: () => close(undefined) },
          }, [icon('x')])
        : null,
    ]);

    const bodyNode = typeof body === 'string'
      ? h('p', { class: 'text-muted', text: body })
      : body;

    const footer = actions.length
      ? h('div', { class: 'dialog__footer' }, actions.map((action) =>
          h('button', {
            class: `btn ${action.variant === 'primary' ? 'btn--primary' : action.variant === 'danger' ? 'btn--danger' : ''}`.trim(),
            type: action.type || 'button',
            text: action.label,
            attrs: action.disabled ? { disabled: '' } : {},
            on: {
              click: (event) => {
                action.onClick?.(event, () => close(action.value));
                if (action.closeOnClick !== false) close(action.value);
              },
            },
          }),
        ))
      : null;

    dialog.append(header, h('div', { class: 'dialog__body' }, [bodyNode]));
    if (footer) dialog.appendChild(footer);
    backdrop.appendChild(dialog);

    backdrop.addEventListener('pointerdown', (event) => {
      if (dismissible && event.target === backdrop) close(undefined);
    });

    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';

    const release = trapFocus(dialog, { onEscape: () => { if (dismissible) close(undefined); } });
    const entry = { backdrop, release };
    stack.push(entry);

    // Let callers place initial focus (default falls through to first control).
    if (initialFocus && typeof initialFocus.focus === 'function') {
      queueMicrotask(() => initialFocus.focus());
    } else if (typeof body === 'string' && !actions.some((a) => a.autofocus)) {
      queueMicrotask(() => {
        const target = dialog.querySelector('.dialog__footer .btn') || dialog.querySelector('button');
        target?.focus();
      });
    }
  });
}

/**
 * Confirmation dialog (destructive actions).
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  details = '',
} = {}) {
  const body = h('div', { class: 'stack stack--sm' }, [
    h('p', { text: message }),
    details ? h('div', { class: 'inline-note', dataset: { tone: danger ? 'danger' : 'warning' }, text: details }) : null,
  ]);

  return openDialog({
    title,
    body,
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  }).then((value) => value === true);
}

/**
 * Text prompt dialog (replacement for browser prompt()).
 * @returns {Promise<string|null>} null when cancelled
 */
export function promptDialog({
  title = 'Enter a value',
  label = 'Value',
  value = '',
  placeholder = '',
  hint = '',
  confirmLabel = 'Save',
  validate = null,
} = {}) {
  const errorLine = h('div', { class: 'field__error', attrs: { role: 'alert' }, hidden: true });
  const input = h('input', {
    class: 'input',
    type: 'text',
    value,
    attrs: {
      id: 'prompt-dialog-input',
      placeholder,
      ...(hint ? { 'aria-describedby': 'prompt-dialog-hint' } : {}),
    },
  });

  const body = h('div', { class: 'field' }, [
    h('label', { class: 'field__label', attrs: { for: 'prompt-dialog-input' }, text: label }),
    input,
    hint ? h('div', { class: 'field__hint', attrs: { id: 'prompt-dialog-hint' }, text: hint }) : null,
    errorLine,
  ]);

  const show = (message) => {
    errorLine.textContent = message;
    errorLine.hidden = !message;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  };

  return openDialog({
    title,
    body,
    initialFocus: input,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: confirmLabel,
        value: 'submit',
        variant: 'primary',
        closeOnClick: false,
        onClick: (_event, submit) => {
          const current = input.value.trim();
          const error = validate ? validate(current) : (current ? '' : 'This field is required');
          if (error) { show(error); input.focus(); return; }
          submit('submit');
        },
      },
    ],
  }).then((value) => (value === 'submit' ? input.value.trim() : null));
}
