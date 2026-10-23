import test from 'node:test';
import assert from 'node:assert/strict';

import { stylesMissing } from '../../src/scripts/features/diagnostics/style-guard.js';

/** Minimal window double: only what stylesMissing reads. */
function fakeWindow({ token = '0.25rem', display = 'grid', hidden = false } = {}) {
  return {
    document: {
      documentElement: { id: 'root' },
      getElementById(id) {
        return id === 'app-shell'
          ? { id: 'app-shell', hasAttribute: (name) => (name === 'hidden' ? hidden : false) }
          : null;
      },
    },
    getComputedStyle(el) {
      if (el.id === 'root') {
        return { getPropertyValue: (name) => (name === '--sp-1' ? token : '') };
      }
      return { display };
    },
  };
}

test('style-guard: a fully styled shell is not flagged', () => {
  assert.equal(stylesMissing(fakeWindow()), false);
});

test('style-guard: missing design tokens (no stylesheet) is flagged', () => {
  assert.equal(stylesMissing(fakeWindow({ token: '' })), true);
});

test('style-guard: tokens present but layout not applied is flagged', () => {
  assert.equal(stylesMissing(fakeWindow({ display: 'block' })), true);
});

test('style-guard: a still-hidden shell only reports on tokens', () => {
  // During boot the shell is hidden and display computes to 'none'; that must
  // not count as "layout broken" — only an empty token does.
  assert.equal(stylesMissing(fakeWindow({ hidden: true, display: 'none' })), false);
  assert.equal(stylesMissing(fakeWindow({ hidden: true, display: 'none', token: '' })), true);
});

test('style-guard: a throwing getComputedStyle counts as broken styling', () => {
  const win = {
    document: { documentElement: {}, getElementById: () => null },
    getComputedStyle() { throw new Error('no styles'); },
  };
  assert.equal(stylesMissing(win), true);
});
