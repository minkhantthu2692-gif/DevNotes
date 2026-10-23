/**
 * feedback.js — loading, empty, error and progress patterns.
 * Rules: no infinite spinners (timeouts are handled by callers), no fake
 * percentages — indeterminate progress is used when progress can't be measured.
 */

import { h } from '../utils/dom.js';
import { icon } from '../utils/icons.js';

/** Skeleton placeholder blocks for initial data loading. */
export function skeleton({ count = 3, variant = 'card' } = {}) {
  return h('div', { class: 'stack stack--sm', attrs: { 'aria-hidden': 'true' } },
    Array.from({ length: count }, () => h('div', { class: `skeleton skeleton--${variant}` })),
  );
}

/**
 * Empty state with a title, explanation and real actions.
 * @param {{iconName?: string, title: string, text?: string,
 *          actions?: Array<{label: string, onClick: Function, variant?: string}>}} config
 */
export function emptyState({ iconName = 'info', title, text = '', actions = [] }) {
  return h('div', { class: 'empty-state' }, [
    h('div', { class: 'empty-state__icon' }, [icon(iconName)]),
    h('div', { class: 'empty-state__title', text: title }),
    text ? h('p', { class: 'empty-state__text', text }) : null,
    actions.length
      ? h('div', { class: 'empty-state__actions' }, actions.map((action) =>
          h('button', {
            class: `btn ${action.variant === 'primary' ? 'btn--primary' : ''}`.trim(),
            type: 'button',
            text: action.label,
            on: { click: action.onClick },
          }),
        ))
      : null,
  ]);
}

/**
 * Inline error with optional details and a retry action.
 * @param {{title?: string, message?: string, details?: string,
 *          retry?: {label?: string, onClick: Function}}} config
 */
export function errorState({ title = 'Something went wrong', message = '', details = '', retry = null } = {}) {
  return h('div', { class: 'error-state', attrs: { role: 'alert' } }, [
    h('div', { class: 'error-state__title', text: title }),
    message ? h('div', { text: message }) : null,
    details ? h('pre', { class: 'error-state__details', text: details }) : null,
    retry
      ? h('div', {}, [
          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            text: retry.label || 'Try again',
            on: { click: retry.onClick },
          }),
        ])
      : null,
  ]);
}

/**
 * Progress bar. Pass `value`/`max` for determinate progress; omit for
 * genuinely unmeasurable work (indeterminate animation).
 */
export function progressBar({ value = null, max = 100, label = '' } = {}) {
  const indeterminate = value === null || value === undefined;
  const pct = indeterminate ? 35 : Math.max(0, Math.min(100, (value / max) * 100));
  return h('div', {
    class: `progress${indeterminate ? ' progress--indeterminate' : ''}`,
    attrs: {
      role: 'progressbar',
      ...(label ? { 'aria-label': label } : {}),
      ...(indeterminate
        ? { 'aria-valuetext': 'Working…' }
        : { 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value) }),
    },
  }, [h('div', { class: 'progress__bar', style: { width: `${pct}%` } })]);
}

/** Small status line with a coloured dot: Synced / Offline / Error… */
export function statusIndicator({ label, tone = '', busy = false, iconName = '' } = {}) {
  return h('span', {
    class: 'status',
    dataset: { tone, busy: busy ? 'true' : 'false' },
    attrs: { role: 'status' },
  }, [
    h('span', { class: 'status__dot', attrs: { 'aria-hidden': 'true' } }),
    iconName ? icon(iconName) : null,
    h('span', { text: label }),
  ]);
}

/** Consistent inline note (informational / warning / danger / success). */
export function inlineNote(text, tone = 'info') {
  return h('div', { class: 'inline-note', dataset: { tone } }, [
    icon(tone === 'danger' || tone === 'warning' ? 'alert' : 'info'),
    h('span', { text }),
  ]);
}
