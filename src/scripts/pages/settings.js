/**
 * settings.js — application settings, grouped into sections and deep-linked
 * via /settings?section=<id>.
 *
 * Rules applied here:
 *  - Every control writes through savePrefs() (IndexedDB authoritative +
 *    localStorage mirror for first paint) and takes effect immediately.
 *  - Import never mutates data before the preview dialog; "replace" needs a
 *    separate typed confirmation (AGENTS.md §14).
 *  - AI and sync sections explain what is configured instead of pretending.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate, setQuery } from '../router.js';
import { bus } from '../utils/bus.js';
import { toast } from '../components/toast.js';
import { openDialog, confirmDialog, promptDialog } from '../components/dialog.js';
import { inlineNote, emptyState } from '../components/feedback.js';
import { getPrefs, savePrefs, loadPrefs, resetAllPrefs } from '../features/settings/prefs.js';
import { fontsRepo } from '../db/repositories/index.js';
import { lessonsRepo, snippetsRepo, flashcardsRepo } from '../db/repositories/index.js';
import { estimateStorage, wipeLocalDatabase } from '../db/database.js';
import { formatBytes } from '../utils/format.js';
import { pickFile } from '../utils/download.js';
import { exportBackupJson, exportBackupZip } from '../features/import-export/export.js';
import { readBackupJson, analyzeBackup, applyImport } from '../features/import-export/import.js';
import {
  describeAiSetup, getAiKey, setAiKey, clearAiKey, fetchAvailableModels, chat,
} from '../features/ai/ai-service.js';
import { AI, SUPABASE, APP } from '../config.js';
import { authStore, syncStore } from '../state.js';
import { runSyncOnce } from '../sync/sync-engine.js';
import { isSyncSuspended, queueStats, retryFailed } from '../sync/sync-queue.js';
import { ensureSyncChoice, resetSyncChoice } from '../features/auth/sync-choice.js';
import { refreshSyncStatus } from '../sync/connectivity.js';
import { LESSON_STATUSES } from '../utils/validate.js';

/* ------------------------------------------------------------- fragments */

const UI_STACKS = [
  { id: 'system', label: 'System UI', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Noto Sans Myanmar", sans-serif' },
  { id: 'inter', label: 'Inter (bundled)', stack: '"Inter", "Noto Sans Myanmar", system-ui, sans-serif' },
  { id: 'myanmar', label: 'Noto Sans Myanmar (bundled)', stack: '"Noto Sans Myanmar", "Inter", system-ui, sans-serif' },
];

const CODE_STACKS = [
  { id: 'system', label: 'System monospace', stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono (bundled)', stack: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace' },
];

const ACCENT_PRESETS = ['#5b6cff', '#0d6efd', '#1f9d55', '#8b5cf6', '#d6336c', '#e0562d', '#d97706', '#0f766e'];

function settingRow(title, hint, control) {
  return h('div', { class: 'setting-row' }, [
    h('div', { class: 'setting-row__label' }, [
      h('span', { class: 'setting-row__title', text: title }),
      hint ? h('span', { class: 'setting-row__hint', text: hint }) : null,
    ]),
    h('div', { class: 'setting-row__control' }, [control]),
  ]);
}

function toggleControl(checked, onChange, { label = '', hint = '' } = {}) {
  const input = h('input', {
    type: 'checkbox',
    attrs: checked ? { checked: '' } : {},
    on: { change: (event) => onChange(event.target.checked) },
  });
  return h('label', { class: 'switch', title: hint || undefined }, [
    input,
    h('span', { class: 'switch__track' }),
    label ? h('span', { text: label }) : null,
  ]);
}

function selectControl(options, current, onChange, { ariaLabel = '' } = {}) {
  return h('select', {
    class: 'select',
    attrs: ariaLabel ? { 'aria-label': ariaLabel } : {},
    on: { change: (event) => onChange(event.target.value) },
  }, options.map((option) => h('option', {
    value: option.value,
    text: option.label,
    attrs: option.value === String(current) ? { selected: '' } : {},
  })));
}

function segmentedControl(name, options, current, onChange) {
  return h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': name } },
    options.map((option) => h('label', { class: 'segmented__option' }, [
      h('input', {
        type: 'radio',
        name,
        value: option.value,
        attrs: option.value === current ? { checked: '' } : {},
        on: { change: () => option.value !== current && onChange(option.value) },
      }),
      option.icon ? icon(option.icon) : null,
      h('span', { class: 'segmented__label', text: option.label }),
    ])),
  );
}

function stackIdFor(stacks, prefValue) {
  const exact = stacks.find((entry) => entry.stack === prefValue);
  if (exact) return exact.id;
  // A stack that starts with a bundled family also counts as that family.
  const start = stacks.find((entry) => prefValue?.startsWith(entry.stack.split(',')[0]));
  return start ? start.id : 'custom';
}

/* ----------------------------------------------------------------- page */

export default {
  id: 'settings',
  title: () => 'Settings',
  breadcrumbs: () => [{ label: 'Settings', path: '/settings' }],

  mount(container, ctx) {
    let currentSection = ctx.query.section || 'appearance';
    let disposed = false;
    const teardowns = [];

    const navHost = h('nav', { class: 'settings-nav', attrs: { 'aria-label': 'Settings sections' } });
    const panelHost = h('div', { class: 'settings-panel' });
    const root = h('div', { class: 'stack stack--lg' }, [
      h('header', { class: 'page-header' }, [
        h('div', { class: 'page-header__title' }, [
          h('h1', { text: 'Settings' }),
          h('p', { class: 'page-header__subtitle', text: 'Everything here is stored on this device and applied immediately.' }),
        ]),
      ]),
      h('div', { class: 'settings-layout' }, [navHost, panelHost]),
    ]);
    container.appendChild(root);

    const SECTIONS = [
      { id: 'appearance', label: 'Appearance', icon: 'monitor', build: buildAppearance },
      { id: 'typography', label: 'Typography', icon: 'book', build: buildTypography },
      { id: 'editor', label: 'Editor', icon: 'edit', build: buildEditor },
      { id: 'library', label: 'Library', icon: 'library', build: buildLibrary },
      { id: 'fonts', label: 'Fonts', icon: 'languages', build: buildFonts },
      { id: 'ai', label: 'AI', icon: 'sparkles', build: buildAi },
      { id: 'sync', label: 'Sync', icon: 'cloud', build: buildSync },
      { id: 'data', label: 'Data', icon: 'download', build: buildData },
      { id: 'about', label: 'About', icon: 'info', build: buildAbout },
    ];

    function runTeardowns() {
      for (const fn of teardowns.splice(0)) {
        try { fn(); } catch (err) { console.warn('[settings] teardown failed:', err?.message); }
      }
    }

    function renderNav() {
      clear(navHost);
      for (const section of SECTIONS) {
        navHost.appendChild(h('button', {
          class: 'settings-nav__btn',
          type: 'button',
          attrs: { 'aria-current': String(section.id === currentSection) },
          on: { click: () => showSection(section.id) },
        }, [icon(section.icon), h('span', { text: section.label })]));
      }
    }

    async function showSection(id) {
      const section = SECTIONS.find((entry) => entry.id === id) || SECTIONS[0];
      currentSection = section.id;
      renderNav();
      setQuery({ section: section.id === 'appearance' ? null : section.id });
      runTeardowns();
      clear(panelHost);
      panelHost.appendChild(h('p', { class: 'text-muted', text: 'Loading…' }));
      try {
        const built = await section.build({ update: savePrefs, whenDisposed: () => disposed });
        if (disposed) return;
        clear(panelHost);
        if (built && built.node) {
          panelHost.appendChild(built.node);
          if (built.destroy) teardowns.push(built.destroy);
        } else if (built) {
          panelHost.appendChild(built);
        }
      } catch (err) {
        if (disposed) return;
        console.error('[settings] section failed:', err);
        clear(panelHost);
        panelHost.appendChild(emptyState({
          iconName: 'alert',
          title: 'This section could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
        }));
      }
    }

    function onQuery(query) {
      const next = query.section || 'appearance';
      if (next !== currentSection) void showSection(next);
    }

    void showSection(currentSection);

    return {
      onQuery,
      onShow() { /* already mounted; section stays as-is */ },
      destroy() {
        disposed = true;
        runTeardowns();
      },
    };
  },
};

/* ------------------------------------------------------------- sections */

/** Accent presets + a native color picker for any other value. */
function buildAccentRow(current, onChange) {
  const custom = h('input', {
    class: 'input',
    type: 'color',
    value: /^#[0-9a-f]{6}$/i.test(current) ? current : '#5b6cff',
    attrs: { 'aria-label': 'Custom accent color' },
    style: { width: '3rem', padding: '0.125rem' },
    on: { input: (event) => onChange(event.target.value) },
  });
  const swatches = h('div', { class: 'swatches', attrs: { role: 'group', 'aria-label': 'Accent presets' } },
    ACCENT_PRESETS.map((color) => h('button', {
      class: 'swatch',
      type: 'button',
      style: { background: color },
      dataset: { color },
      attrs: { 'aria-label': `Accent ${color}`, 'aria-pressed': String(current === color) },
      on: {
        click: async () => {
          swatches.querySelectorAll('.swatch').forEach((el) => {
            el.setAttribute('aria-pressed', String(el.dataset.color === color));
          });
          custom.value = color;
          await onChange(color);
        },
      },
    })),
  );
  return h('div', { class: 'row gap-2' }, [swatches, custom]);
}

function buildAppearance({ update }) {
  const prefs = getPrefs();
  const wrap = h('div', { class: 'stack stack--lg' });

  const themeSection = h('section', { class: 'section' }, [
    h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Theme' })]),
    h('div', { class: 'stack stack--sm' }, [
      settingRow('Color theme', 'System follows your operating system setting.',
        segmentedControl('theme', [
          { value: 'light', label: 'Light', icon: 'sun' },
          { value: 'dark', label: 'Dark', icon: 'moon' },
          { value: 'system', label: 'System', icon: 'monitor' },
        ], prefs.theme, (value) => void update({ theme: value }))),
      settingRow('Density', 'Compact fits more on screen.',
        segmentedControl('density', [
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'compact', label: 'Compact' },
        ], prefs.density, (value) => void update({ density: value }))),
      settingRow('Accent color', 'Used for highlights, links and search matches.',
        buildAccentRow(prefs.accent, (color) => update({ accent: color }))),
      settingRow('Reduce motion', 'Auto respects your system preference.',
        segmentedControl('motion', [
          { value: 'auto', label: 'System' },
          { value: 'reduced', label: 'Always reduce' },
        ], prefs.motion, (value) => void update({ motion: value }))),
      settingRow('Glass surfaces', 'Experimental: subtle transparency. Off is easier on low-end devices.',
        toggleControl(Boolean(prefs.glass), (value) => void update({ glass: value }), { hint: 'Experimental' })),
    ]),
  ]);
  wrap.appendChild(themeSection);

  return wrap;
}

async function buildTypography({ update }) {
  const prefs = getPrefs();
  let imported = [];
  try {
    imported = await fontsRepo.list();
  } catch { /* fonts list is optional */ }

  const uiOptions = [
    ...UI_STACKS.map((entry) => ({ value: entry.id, label: entry.label })),
    ...imported.map((font) => ({ value: `font:${font.family}`, label: `${font.family} (imported)` })),
    { value: 'custom', label: 'Custom stack (from an import)' },
  ];
  const codeOptions = [
    ...CODE_STACKS.map((entry) => ({ value: entry.id, label: entry.label })),
    ...imported.map((font) => ({ value: `font:${font.family}`, label: `${font.family} (imported)` })),
  ];

  const uiCurrent = stackIdFor(UI_STACKS, prefs.uiFont) === 'custom' && prefs.uiFont.startsWith('"')
    ? `font:${prefs.uiFont.slice(1, prefs.uiFont.indexOf('"', 1))}`
    : stackIdFor(UI_STACKS, prefs.uiFont);
  const codeCurrent = stackIdFor(CODE_STACKS, prefs.codeFont) === 'custom' && prefs.codeFont.startsWith('"')
    ? `font:${prefs.codeFont.slice(1, prefs.codeFont.indexOf('"', 1))}`
    : stackIdFor(CODE_STACKS, prefs.codeFont);

  const resolveStack = (choice, stacks, fallback) => {
    if (choice.startsWith('font:')) {
      const family = choice.slice(5);
      return `"${family}", ${fallback}`;
    }
    return stacks.find((entry) => entry.id === choice)?.stack || fallback;
  };

  const sample = h('div', { class: 'stack stack--sm', style: { marginTop: 'var(--sp-4)' } }, [
    h('p', {
      style: { fontFamily: 'var(--font-ui)', margin: 0 },
      text: 'The quick brown fox — บรรทัดตัวอย่างภาษาไทยไม่รองรับ แต่ภาษาพม่ารองรับ: ကျေးဇူးတင်ပါတယ်။',
    }),
    h('pre', {
      class: 'code-block',
      style: { fontFamily: 'var(--font-code)', fontSize: 'var(--font-size-code)', margin: 0 },
    }, [h('code', { text: 'const answer = compute(a, b) // 42' })]),
  ]);

  const wrap = h('div', { class: 'stack stack--lg' }, [
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Fonts' })]),
      h('div', { class: 'stack stack--sm' }, [
        settingRow('Interface font', 'Bundled fonts are licensed under the SIL Open Font License.',
          selectControl(uiOptions, uiCurrent, (value) => void update({
            uiFont: resolveStack(value, UI_STACKS, 'system-ui, sans-serif'),
          }), { ariaLabel: 'Interface font' })),
        settingRow('Code font', 'Used for code blocks and the editor.',
          selectControl(codeOptions, codeCurrent, (value) => void update({
            codeFont: resolveStack(value, CODE_STACKS, 'monospace'),
          }), { ariaLabel: 'Code font' })),
        settingRow('Interface size', 'Base text size for the whole app.',
          selectControl([
            { value: '0.9375rem', label: 'Small (15px)' },
            { value: '1rem', label: 'Default (16px)' },
            { value: '1.0625rem', label: 'Large (17px)' },
            { value: '1.125rem', label: 'Extra large (18px)' },
          ], prefs.fontSize, (value) => void update({ fontSize: value }), { ariaLabel: 'Interface size' })),
        settingRow('Code size', 'Relative to the interface size.',
          selectControl([
            { value: '0.75rem', label: 'Small' },
            { value: '0.8125rem', label: 'Smaller' },
            { value: '0.875rem', label: 'Default' },
            { value: '1rem', label: 'Large' },
          ], prefs.codeFontSize, (value) => void update({ codeFontSize: value }), { ariaLabel: 'Code size' })),
        settingRow('Line height', null,
          selectControl([
            { value: '1.4', label: 'Tight (1.4)' },
            { value: '1.6', label: 'Normal (1.6)' },
            { value: '1.8', label: 'Relaxed (1.8)' },
          ], String(prefs.lineHeight), (value) => void update({ lineHeight: Number(value) }), { ariaLabel: 'Line height' })),
        settingRow('Letter spacing', null,
          selectControl([
            { value: '-0.01', label: 'Tight' },
            { value: '0', label: 'Normal' },
            { value: '0.02', label: 'Wide' },
          ], String(prefs.letterSpacing), (value) => void update({ letterSpacing: Number(value) }), { ariaLabel: 'Letter spacing' })),
        sample,
      ]),
    ]),
  ]);
  return wrap;
}

function buildEditor({ update }) {
  const prefs = getPrefs();
  return h('div', { class: 'stack stack--lg' }, [
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Editor' })]),
      h('div', { class: 'stack stack--sm' }, [
        settingRow('Default view', 'Split shows Markdown source and preview side by side.',
          segmentedControl('editor-mode', [
            { value: 'edit', label: 'Edit' },
            { value: 'split', label: 'Split' },
            { value: 'preview', label: 'Preview' },
          ], prefs.editorMode, (value) => void update({ editorMode: value }))),
        settingRow('Autosave delay', 'How long typing pauses before a lesson is saved.',
          selectControl([
            { value: '500', label: 'Fast (0.5s)' },
            { value: '900', label: 'Default (0.9s)' },
            { value: '1500', label: 'Relaxed (1.5s)' },
            { value: '3000', label: 'Slow (3s)' },
          ], String(prefs.autosaveDelay), (value) => void update({ autosaveDelay: Number(value) }), { ariaLabel: 'Autosave delay' })),
        settingRow('Word wrap', 'Wrap long lines in the Markdown source textarea.',
          toggleControl(Boolean(prefs.wordWrap), (value) => void update({ wordWrap: value }))),
        settingRow('Line numbers', 'Show line numbers in highlighted code blocks.',
          toggleControl(Boolean(prefs.lineNumbers), (value) => void update({ lineNumbers: value }))),
        settingRow('Tab size', 'Spaces inserted by the Tab key in the editor.',
          selectControl([
            { value: '2', label: '2 spaces' },
            { value: '4', label: '4 spaces' },
          ], String(prefs.tabSize), (value) => void update({ tabSize: Number(value) }), { ariaLabel: 'Tab size' })),
        settingRow('Editor width', 'Maximum line length in characters.',
          h('input', {
            class: 'input',
            type: 'range',
            attrs: { min: '40', max: '120', step: '2', 'aria-label': 'Editor width in characters' },
            value: String(prefs.editorWidth),
            on: { change: (event) => void update({ editorWidth: Number(event.target.value) }) },
          })),
      ]),
    ]),
  ]);
}

function buildLibrary({ update }) {
  const prefs = getPrefs();
  return h('div', { class: 'stack stack--lg' }, [
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Library defaults' })]),
      h('div', { class: 'stack stack--sm' }, [
        settingRow('Default sort', 'Applied whenever the library is opened without an explicit sort.',
          selectControl([
            { value: 'updated', label: 'Last updated' },
            { value: 'created', label: 'Date created' },
            { value: 'title', label: 'Title (A–Z)' },
            { value: 'opened', label: 'Recently opened' },
            { value: 'order', label: 'Manual order' },
          ], prefs.defaultSort, (value) => void update({ defaultSort: value }), { ariaLabel: 'Default sort' })),
        settingRow('Default direction', null,
          selectControl([
            { value: 'desc', label: 'Newest first' },
            { value: 'asc', label: 'Oldest first' },
          ], prefs.defaultDir, (value) => void update({ defaultDir: value }), { ariaLabel: 'Default direction' })),
        settingRow('Default status', 'Status preselected for new lessons.',
          selectControl(LESSON_STATUSES.map((s) => ({
            value: s, label: s === 'not-started' ? 'Not started' : s[0].toUpperCase() + s.slice(1),
          })), prefs.defaultStatus, (value) => void update({ defaultStatus: value }), { ariaLabel: 'Default status' })),
        settingRow('Show archived lessons', 'Archived lessons stay searchable but hidden by default.',
          toggleControl(Boolean(prefs.showArchivedInList), (value) => void update({ showArchivedInList: value }))),
      ]),
    ]),
  ]);
}

async function buildFonts() {
  let manifest = null;
  try {
    const response = await fetch('./src/fonts/fonts-manifest.json');
    if (response.ok) manifest = await response.json();
  } catch { /* file:// or offline-first run: fall back to the static list */ }

  const bundled = manifest?.fonts?.length ? manifest.fonts : [
    { family: 'Inter', sourceVersion: '5.3.0', weights: [400, 500, 600, 700], languageCoverage: ['Latin'], license: 'OFL-1.1' },
    { family: 'JetBrains Mono', sourceVersion: '5.3.0', weights: [400, 700], languageCoverage: ['Latin'], license: 'OFL-1.1' },
    { family: 'Noto Sans Myanmar', sourceVersion: '5.3.0', weights: [400, 700], languageCoverage: ['Burmese (Myanmar script)', 'Latin'], license: 'OFL-1.1' },
  ];

  const importedHost = h('div', { class: 'font-list' });
  const fontsSection = h('section', { class: 'section' }, [
    h('div', { class: 'section__header' }, [
      h('h2', { class: 'section__title', text: 'Imported fonts' }),
      h('button', {
        class: 'btn btn--sm btn--primary',
        type: 'button',
        on: { click: () => void importFont() },
      }, [icon('upload'), 'Import font file']),
    ]),
    importedHost,
    inlineNote('Imported font files (WOFF2, WOFF, TTF or OTF up to 8 MB) are stored in this browser and can be selected in Typography. Only import fonts you are allowed to use.', 'info'),
  ]);

  async function refreshImported() {
    let rows = [];
    try {
      rows = await fontsRepo.list();
    } catch (err) {
      clear(importedHost);
      importedHost.appendChild(h('p', { class: 'text-muted', text: `Could not list fonts: ${err?.message}` }));
      return;
    }
    clear(importedHost);
    if (!rows.length) {
      importedHost.appendChild(h('p', { class: 'text-muted', text: 'No imported fonts.' }));
      return;
    }
    for (const font of rows) {
      importedHost.appendChild(h('div', { class: 'font-row' }, [
        h('div', { class: 'font-row__preview', style: { fontFamily: `"${font.family}"` }, text: `${font.family} — Aa Bb 123` }),
        h('div', { class: 'font-row__meta', text: `${font.format.toUpperCase()} · ${formatBytes(font.size)} · ${font.fileName}` }),
        h('button', {
          class: 'btn btn--sm btn--danger',
          type: 'button',
          on: {
            click: async () => {
              const ok = await confirmDialog({
                title: `Remove ${font.family}?`,
                message: 'Anything using this font falls back to the system font.',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!ok) return;
              await fontsRepo.remove(font.id);
              toast(`Removed ${font.family}`, { tone: 'success' });
              await refreshImported();
            },
          },
        }, [icon('trash'), 'Remove']),
      ]));
    }
  }

  async function importFont() {
    try {
      const file = await pickFile('font/woff2,font/woff,font/ttf,font/otf,.woff2,.woff,.ttf,.otf');
      const suggested = file.name.replace(/\.[^.]+$/, '').slice(0, 64);
      const family = await promptDialog({
        title: 'Font family name',
        label: 'Family name',
        value: suggested,
        confirmLabel: 'Import',
        validate: (value) => (value.trim() ? '' : 'A family name is required'),
      });
      if (!family) return;
      const record = await fontsRepo.add(file, family.trim());
      toast(`Imported ${record.family}`, { tone: 'success' });
      await refreshImported();
    } catch (err) {
      if (err?.name === 'AbortError') return; // picker cancelled — not an error
      toast(err?.message || 'Font import failed', { tone: 'danger' });
    }
  }

  await refreshImported();

  return h('div', { class: 'stack stack--lg' }, [
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Bundled fonts' })]),
      h('div', { class: 'font-list' }, bundled.map((font) => h('div', { class: 'font-row' }, [
        h('div', { class: 'font-row__preview', style: { fontFamily: `"${font.family}"` }, text: `${font.family} — Aa Bb 123` }),
        h('div', {
          class: 'font-row__meta',
          text: `weights ${font.weights?.join(', ') || '400, 700'} · ${(font.languageCoverage || []).join(', ')} · ${font.license || 'OFL-1.1'} · v${font.sourceVersion || '?'}`,
        }),
      ]))),
      inlineNote('Bundled fonts ship under the SIL Open Font License; license texts live in src/fonts/bundled/.', 'info'),
    ]),
    fontsSection,
  ]);
}

async function buildAi({ update, whenDisposed }) {
  const prefs = getPrefs();
  let statusMessage = '';
  let statusTone = 'info';

  const statusLine = h('div', { attrs: { role: 'status', 'aria-live': 'polite' } },
    [inlineNote(describeAiSetup(), 'info')]);

  const setStatus = (message, tone = 'info') => {
    if (whenDisposed()) return;
    statusTone = tone;
    statusMessage = message;
    clear(statusLine);
    statusLine.appendChild(inlineNote(message, tone));
  };

  const keyInput = h('input', {
    class: 'input',
    type: 'password',
    attrs: { placeholder: getAiKey() ? `Saved (ending ${getAiKey().slice(-4)})` : 'gsk_…', 'aria-label': 'Groq API key', autocomplete: 'off', spellcheck: 'false' },
  });

  const modelSelect = selectControl(
    [...AI.presets.map((m) => ({ value: m.id, label: m.label })),
     ...(AI.presets.some((m) => m.id === prefs.aiModel) ? [] : [{ value: prefs.aiModel, label: `${prefs.aiModel} (current)` }])],
    prefs.aiModel,
    (value) => void update({ aiModel: value }),
    { ariaLabel: 'AI model' },
  );

  const testResult = h('div', { attrs: { role: 'status', 'aria-live': 'polite' } });

  const testButton = h('button', {
    class: 'btn btn--sm',
    type: 'button',
    on: {
      click: async () => {
        testButton.disabled = true;
        clear(testResult);
        testResult.appendChild(h('span', { class: 'text-muted', text: 'Sending a tiny test request…' }));
        try {
          const result = await chat({
            messages: [{ role: 'user', content: 'Reply with exactly the word OK' }],
            maxTokens: 8,
          });
          clear(testResult);
          testResult.appendChild(h('span', { style: { color: 'var(--color-success)' }, text: `AI responded with “${result.content.trim().slice(0, 24)}” via ${result.model}` }));
        } catch (err) {
          clear(testResult);
          testResult.appendChild(h('span', { style: { color: 'var(--color-danger)' }, text: String(err?.message || err) }));
        } finally {
          testButton.disabled = false;
        }
      },
    },
  }, [icon('sparkles'), 'Test AI connection']);

  const wrap = h('div', { class: 'stack stack--lg' }, [
    statusLine,
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'AI assistant' })]),
      h('div', { class: 'stack stack--sm' }, [
        settingRow('Enable AI features', 'Core note management never needs AI.',
          toggleControl(Boolean(prefs.aiEnabled), (value) => void update({ aiEnabled: value }).then(() => setStatus(describeAiSetup())))),
        settingRow('Model', 'Model IDs change over time — check the Groq docs if one stops working.',
          modelSelect),
        settingRow('Custom model ID', 'Type any Groq model id and press Save.',
          (() => {
            const input = h('input', { class: 'input', attrs: { placeholder: 'e.g. llama-3.3-70b-versatile', 'aria-label': 'Custom model id', value: prefs.aiModel } });
            const button = h('button', {
              class: 'btn btn--sm',
              type: 'button',
              text: 'Use this model',
              on: {
                click: async () => {
                  const value = input.value.trim();
                  if (!value) return;
                  await update({ aiModel: value });
                  toast(`Model set to ${value}`, { tone: 'success' });
                },
              },
            });
            return h('div', { class: 'row gap-2' }, [input, button]);
          })()),
        settingRow('Temperature', 'Higher = more creative, less predictable.',
          h('input', {
            class: 'input',
            type: 'range',
            attrs: { min: '0', max: '1', step: '0.1', 'aria-label': 'Temperature' },
            value: String(prefs.aiTemperature),
            on: { change: (event) => void update({ aiTemperature: Number(event.target.value) }) },
          })),
        settingRow('Max response tokens', null,
          selectControl([
            { value: '1024', label: '1024' },
            { value: '2048', label: '2048' },
            { value: '4096', label: '4096' },
          ], String(prefs.aiMaxTokens), (value) => void update({ aiMaxTokens: Number(value) }), { ariaLabel: 'Max response tokens' })),
        settingRow('Output language', 'Used for generated flashcards and assistant prompts.',
          selectControl([
            { value: 'en', label: 'English' },
            { value: 'my', label: 'Burmese (မြန်မာ)' },
          ], prefs.aiOutputLanguage, (value) => void update({ aiOutputLanguage: value }), { ariaLabel: 'Output language' })),
        settingRow('Translate direction', 'Used by Translate in the editor\u2019s AI writing toolbar.',
          selectControl([
            { value: 'en-my', label: 'English \u2192 Myanmar' },
            { value: 'my-en', label: 'Myanmar \u2192 English' },
          ], prefs.translateDirection === 'my-en' ? 'my-en' : 'en-my', (value) => void update({ translateDirection: value }), { ariaLabel: 'Translate direction' })),
        settingRow('Lesson context', 'Allow the assistant page to attach the open lesson as context.',
          toggleControl(Boolean(prefs.aiContextEnabled), (value) => void update({ aiContextEnabled: value }))),
      ]),
    ]),
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Connection' })]),
      h('div', { class: 'stack stack--sm' }, [
        settingRow('Groq API key (BYOK)', 'Your own key, used directly from this browser.',
          h('div', { class: 'row gap-2' }, [
            keyInput,
            h('button', {
              class: 'btn btn--sm btn--primary',
              type: 'button',
              text: 'Save key',
              on: {
                click: () => {
                  const value = keyInput.value.trim();
                  if (!value) { setStatus('Enter a key first.', 'warning'); return; }
                  setAiKey(value);
                  keyInput.value = '';
                  keyInput.placeholder = `Saved (ending ${value.slice(-4)})`;
                  setStatus(`Key saved on this device (ending ${value.slice(-4)}).`, 'success');
                  toast('API key saved', { tone: 'success' });
                },
              },
            }),
            h('button', {
              class: 'btn btn--sm',
              type: 'button',
              text: 'Remove',
              on: {
                click: () => {
                  clearAiKey();
                  keyInput.placeholder = 'gsk_…';
                  setStatus('Key removed from this device.', 'info');
                },
              },
            }),
          ])),
        h('div', { class: 'setting-row' }, [
          h('div', { class: 'setting-row__label' }, [
            h('span', { class: 'setting-row__title', text: 'How requests travel' }),
            h('span', {
              class: 'setting-row__hint',
              text: AI.edgeFunctionUrl && SUPABASE.enabled()
                ? `Proxy mode: requests go through your Supabase ai-proxy function (${AI.edgeFunctionUrl}). The shared key never reaches the browser.`
                : 'BYOK mode: requests go straight from this browser to Groq with your key. A browser-stored key is not fully protected from anyone who can access this browser profile — that is the honest trade-off of BYOK.',
            }),
          ]),
          h('div', { class: 'setting-row__control' }, [
            h('button', {
              class: 'btn btn--sm',
              type: 'button',
              text: 'Load available models',
              attrs: AI.edgeFunctionUrl && SUPABASE.enabled() ? { disabled: '', title: 'Model listing needs a BYOK key' } : {},
              on: {
                click: async (event) => {
                  const button = event.currentTarget;
                  button.disabled = true;
                  button.textContent = 'Loading…';
                  try {
                    const models = await fetchAvailableModels();
                    clear(modelSelect);
                    for (const id of models) modelSelect.appendChild(h('option', { value: id, text: id }));
                    modelSelect.value = prefs.aiModel;
                    setStatus(`Loaded ${models.length} models from Groq.`, 'success');
                  } catch (err) {
                    setStatus(String(err?.message || err), 'danger');
                  } finally {
                    button.disabled = false;
                    button.textContent = 'Load available models';
                  }
                },
              },
            }),
          ]),
        ]),
        h('div', { class: 'setting-row' }, [
          h('div', { class: 'setting-row__label' }, [
            h('span', { class: 'setting-row__title', text: 'Connection test' }),
            h('span', { class: 'setting-row__hint', text: 'Sends one tiny request with the current settings.' }),
          ]),
          h('div', { class: 'setting-row__control' }, [testButton, testResult]),
        ]),
      ]),
    ]),
  ]);

  return wrap;
}

function buildSync({ update, whenDisposed }) {
  const wrap = h('div', { class: 'stack stack--lg' });
  const statusHost = h('div', { class: 'stack stack--sm' });
  wrap.appendChild(h('section', { class: 'section' }, [
    h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Cloud sync' })]),
    statusHost,
  ]));

  async function renderStatus() {
    if (whenDisposed()) return;
    const configured = SUPABASE.enabled();
    const { status, user } = authStore.get();
    const sync = syncStore.get();
    const stats = await queueStats().catch(() => ({ pending: 0, failed: 0, syncing: 0 }));
    if (whenDisposed()) return;

    clear(statusHost);

    if (!configured) {
      statusHost.append(
        inlineNote('Cloud sync is not configured. DevNotes stores everything locally in this browser and keeps working offline.', 'info'),
        h('p', { class: 'text-muted', text: 'To enable sync, fill in your Supabase project URL and publishable key (see README → Supabase setup), then sign in on the Account page.' }),
        h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => navigate('/account') } }, [icon('user'), 'Open Account & Sync']),
      );
      return;
    }

    const rows = [
      settingRow('Status', sync.message || `Sync state: ${sync.state}`,
        h('span', { class: 'row gap-2' }, [
          h('span', { class: `badge badge--${sync.state === 'error' ? 'learning' : sync.state === 'idle' ? 'learned' : 'not-started'}`, text: sync.state }),
        ])),
      settingRow('Queue', `${sync.pending ?? stats.pending} pending · ${sync.failed ?? stats.failed} failed · last sync ${sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'never'}`,
        h('button', {
          class: 'btn btn--sm btn--primary',
          type: 'button',
          on: {
            click: async (event) => {
              event.currentTarget.disabled = true;
              try {
                const summary = await runSyncOnce({ reason: 'manual', manual: true });
                toast(summary ? `Sync finished: ${summary.pushed ?? 0} pushed, ${summary.pulled ?? 0} pulled` : 'Nothing to sync', { tone: 'success' });
              } catch (err) {
                toast(String(err?.message || err), { tone: 'danger' });
              } finally {
                event.currentTarget.disabled = false;
                await refreshSyncStatus();
              }
            },
          },
        }, [icon('refresh'), 'Sync now'])),
      settingRow('Failed operations', 'Retried automatically with backoff; retry now to skip the wait.',
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          on: {
            click: async () => {
              const count = await retryFailed();
              toast(count ? `Re-queued ${count} operations` : 'No failed operations', { tone: count ? 'success' : 'info' });
              await renderStatus();
            },
          },
        }, [icon('refresh'), 'Retry failed'])),
    ];

    if (status === 'signed-in' && isSyncSuspended()) {
      rows.push(settingRow('Sync is paused', 'Either the first-sign-in choice is still open, or you chose “stay local”.',
        h('button', {
          class: 'btn btn--sm btn--primary',
          type: 'button',
          on: {
            click: async () => {
              resetSyncChoice(user);
              await ensureSyncChoice(user);
              await renderStatus();
            },
          },
        }, [icon('play'), 'Resume sync setup'])));
    }

    statusHost.append(...rows);
    statusHost.appendChild(inlineNote('Local edits always come first: changes are stored in this browser and queued. Nothing leaves the device without a signed-in account.', 'info'));
  }

  const offAuth = bus.on('auth:changed', () => void renderStatus());
  const offSync = bus.on('sync:changed', () => void renderStatus());
  void renderStatus();

  return { node: wrap, destroy: () => { offAuth(); offSync(); } };
}

async function buildData({ update, whenDisposed }) {
  let storageText = 'unavailable';
  try {
    const usage = await estimateStorage();
    storageText = usage?.usage != null ? formatBytes(usage.usage) + (usage.quota ? ` of ${formatBytes(usage.quota)}` : '') : 'unavailable';
  } catch { /* estimate is best-effort */ }

  /* ------------------------------------------------------------ export -- */

  const exportStatus = h('div', { attrs: { role: 'status', 'aria-live': 'polite' } });

  const exportJsonBtn = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    on: {
      click: async (event) => {
        event.currentTarget.disabled = true;
        clear(exportStatus);
        try {
          const counts = await exportBackupJson({ includePreferences: true });
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          exportStatus.appendChild(inlineNote(`Exported ${total} records. Keep the file somewhere safe — it restores everything, including trash.`, 'success'));
          toast('Backup downloaded', { tone: 'success' });
        } catch (err) {
          exportStatus.appendChild(inlineNote(String(err?.message || err), 'danger'));
        } finally {
          event.currentTarget.disabled = false;
        }
      },
    },
  }, [icon('download'), 'Export JSON backup']);

  const exportZipBtn = h('button', {
    class: 'btn',
    type: 'button',
    on: {
      click: async (event) => {
        event.currentTarget.disabled = true;
        clear(exportStatus);
        exportStatus.appendChild(inlineNote('Building the archive…', 'info'));
        try {
          const result = await exportBackupZip();
          clear(exportStatus);
          exportStatus.appendChild(inlineNote(`ZIP downloaded (${result.sizeText}): backup.json plus readable Markdown files organized by language and category.`, 'success'));
          toast('ZIP backup downloaded', { tone: 'success' });
        } catch (err) {
          clear(exportStatus);
          exportStatus.appendChild(inlineNote(String(err?.message || err), 'danger'));
        } finally {
          event.currentTarget.disabled = false;
        }
      },
    },
  }, [icon('download'), 'Export ZIP (JSON + Markdown)']);

  /* ----------------------------------------------------------- import -- */

  const importHost = h('div', { class: 'stack stack--sm' });

  const dropZone = h('div', {
    class: 'drop-zone',
    attrs: { role: 'button', tabindex: '0', 'aria-label': 'Choose a backup file to import' },
    on: {
      click: () => void startImport(),
      keydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void startImport(); } },
      dragover: (event) => { event.preventDefault(); dropZone.dataset.active = 'true'; },
      dragleave: () => { dropZone.dataset.active = 'false'; },
      drop: async (event) => {
        event.preventDefault();
        dropZone.dataset.active = 'false';
        const file = event.dataTransfer?.files?.[0];
        if (file) await handleImportFile(file);
      },
    },
  }, [
    icon('upload'),
    h('strong', { text: 'Drop a .json backup here' }),
    h('span', { class: 'text-muted', text: 'or click to choose a file — nothing is read until you confirm the preview' }),
  ]);

  async function startImport() {
    try {
      const file = await pickFile('application/json,.json');
      await handleImportFile(file);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      toast(String(err?.message || err), { tone: 'danger' });
    }
  }

  async function handleImportFile(file) {
    if (whenDisposed()) return;
    clear(importHost);
    importHost.appendChild(inlineNote('Reading the backup…', 'info'));
    let analysis;
    try {
      const parsed = await readBackupJson(file);
      analysis = await analyzeBackup(parsed);
    } catch (err) {
      clear(importHost);
      importHost.appendChild(inlineNote(String(err?.message || err), 'danger'));
      return;
    }
    if (whenDisposed()) return;
    clear(importHost);
    importHost.appendChild(dropZone);
    await showImportPreview(analysis);
  }

  function summaryGrid(analysis) {
    return h('div', { class: 'import-summary' }, analysis.entities.map((entity) =>
      h('div', { class: 'stat' }, [
        h('div', { class: 'stat__label', text: entity.label }),
        h('div', { class: 'stat__value', text: String(entity.total) }),
        h('div', { class: 'stat__hint', text: entity.total === 0 ? 'none in file' : `${entity.added} new · ${entity.existing} already here` }),
      ]),
    ));
  }

  async function showImportPreview(analysis) {
    if (!analysis.ok && analysis.empty) {
      importHost.appendChild(inlineNote('That backup contains no records this app can import.', 'warning'));
      return;
    }

    let mode = null;
    const modeCards = h('div', { class: 'choice-list' });
    const makeCard = (value, title, hint) => {
      const card = h('button', {
        class: 'choice-card',
        type: 'button',
        attrs: { 'aria-pressed': 'false' },
        on: {
          click: () => {
            mode = value;
            modeCards.querySelectorAll('.choice-card').forEach((el) => el.setAttribute('aria-pressed', 'false'));
            card.setAttribute('aria-pressed', 'true');
          },
        },
      }, [
        h('span', { class: 'choice-card__title', text: title }),
        h('span', { class: 'choice-card__hint', text: hint }),
      ]);
      return card;
    };
    modeCards.append(
      makeCard('merge', 'Merge into this library', 'Adds records that are not here yet. Nothing that exists is overwritten.'),
      makeCard('replace', 'Replace this library', 'Deletes current lessons, snippets, cards and taxonomy first, then imports the backup (including its preferences).'),
    );

    const errorList = analysis.errors.length
      ? h('details', {}, [
          h('summary', { text: `${analysis.errors.length} record${analysis.errors.length === 1 ? '' : 's'} skipped (invalid)` }),
          h('ul', {}, analysis.errors.slice(0, 20).map((message) => h('li', { class: 'text-muted', text: message }))),
          analysis.errors.length > 20 ? h('p', { class: 'text-muted', text: `…and ${analysis.errors.length - 20} more.` }) : null,
        ])
      : null;

    const result = await openDialog({
      title: 'Import preview',
      size: 'wide',
      body: h('div', { class: 'stack stack--sm' }, [
        h('p', { text: `This backup (schema version ${analysis.version ?? '?'}) contains ${analysis.totalRecords} valid records. Review the plan before anything changes.` }),
        summaryGrid(analysis),
        analysis.preferences ? inlineNote('The backup also contains preferences — these are applied only when you choose “Replace”.', 'info') : null,
        errorList,
        modeCards,
      ]),
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Import', value: 'go', variant: 'primary' },
      ],
    });

    if (result !== 'go') return;
    if (!mode) {
      toast('Choose merge or replace first.', { tone: 'warning' });
      return;
    }

    if (mode === 'replace') {
      const typed = await promptDialog({
        title: 'Replace cannot be undone',
        label: 'Type REPLACE to confirm',
        hint: 'Your current library (including trash) will be deleted before the backup is imported.',
        confirmLabel: 'Replace library',
        validate: (value) => (value === 'REPLACE' ? '' : 'Type REPLACE exactly'),
      });
      if (typed !== 'REPLACE') return;
    } else {
      const ok = await confirmDialog({
        title: 'Merge this backup?',
        message: `${analysis.totalAdded} new records will be added; existing records are kept as they are.`,
        confirmLabel: 'Merge',
      });
      if (!ok) return;
    }

    try {
      const applied = await applyImport(analysis, { mode });
      if (applied.preferencesApplied) await loadPrefs();
      const summary = Object.entries(applied.created)
        .filter(([, count]) => count > 0)
        .map(([store, count]) => `${count} ${store}`)
        .join(', ') || 'nothing new';
      const skippedTotal = Object.values(applied.skipped).reduce((a, b) => a + b, 0);
      importHost.appendChild(inlineNote(
        `${mode === 'replace' ? 'Replaced' : 'Merged'}: ${summary}${skippedTotal > 0 ? `, ${skippedTotal} skipped (already existed)` : ''}.`,
        'success',
      ));
      toast('Import finished', { tone: 'success' });
    } catch (err) {
      importHost.appendChild(inlineNote(`Import failed — nothing was changed. ${String(err?.message || err)}`, 'danger'));
    }
  }

  importHost.appendChild(dropZone);

  /* ------------------------------------------------------- maintenance -- */

  const maintenanceHost = h('div', { class: 'stack stack--sm' });

  async function purgeOldTrash(days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const repo of [lessonsRepo, snippetsRepo, flashcardsRepo]) {
      const trashed = await repo.getAll({ onlyTrashed: true });
      for (const record of trashed) {
        if ((record.trashAt || record.updatedAt || 0) < cutoff) {
          await repo.purge(record.id);
          removed += 1;
        }
      }
    }
    return removed;
  }

  maintenanceHost.append(
    settingRow('Purge old trash', 'Permanently removes trashed items older than the chosen age.',
      (() => {
        let days = '30';
        const button = h('button', {
          class: 'btn btn--sm btn--danger',
          type: 'button',
          text: 'Purge now',
          on: {
            click: async () => {
              const ok = await confirmDialog({
                title: `Permanently delete items in trash older than ${days} days?`,
                message: 'This cannot be undone. Recent trash is untouched.',
                confirmLabel: 'Purge',
                danger: true,
              });
              if (!ok) return;
              const removed = await purgeOldTrash(Number(days));
              toast(removed ? `Purged ${removed} items` : 'Nothing old enough to purge', { tone: removed ? 'success' : 'info' });
            },
          },
        });
        return h('div', { class: 'row gap-2' }, [
          selectControl([{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }], '30', (value) => { days = value; }),
          button,
        ]);
      })()),
    settingRow('Reset settings', 'Returns appearance, typography, editor and AI settings to defaults. Notes are untouched.',
      h('button', {
        class: 'btn btn--sm',
        type: 'button',
        on: {
          click: async () => {
            const ok = await confirmDialog({
              title: 'Reset all settings?',
              message: 'Your notes, snippets and cards stay exactly as they are.',
              confirmLabel: 'Reset settings',
            });
            if (!ok) return;
            await resetAllPrefs();
            await loadPrefs();
            toast('Settings reset to defaults', { tone: 'success' });
          },
        },
      }, [icon('restore'), 'Reset settings'])),
  );

  const dangerHost = h('div', { class: 'stack stack--sm' }, [
    settingRow('Erase all local data', 'Deletes every note, snippet, card, setting and imported font from this browser.',
      h('button', {
        class: 'btn btn--sm btn--danger',
        type: 'button',
        on: {
          click: async () => {
            const typed = await promptDialog({
              title: 'Erase everything?',
              label: 'Type ERASE to confirm',
              hint: 'Export a backup first if you might want this data later.',
              confirmLabel: 'Erase all data',
              validate: (value) => (value === 'ERASE' ? '' : 'Type ERASE exactly'),
            });
            if (typed !== 'ERASE') return;
            await wipeLocalDatabase();
            location.reload();
          },
        },
      }, [icon('trash'), 'Erase everything'])),
  ]);

  return h('div', { class: 'stack stack--lg' }, [
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Export' })]),
      h('p', { class: 'text-muted', text: `Your library lives in this browser (${storageText} used). Export regularly.` }),
      h('div', { class: 'row gap-2' }, [exportJsonBtn, exportZipBtn]),
      exportStatus,
    ]),
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Import' })]),
      importHost,
    ]),
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Maintenance' })]),
      maintenanceHost,
    ]),
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Danger zone' })]),
      dangerHost,
    ]),
  ]);
}

async function buildAbout() {
  const stats = await estimateStorage().catch(() => ({ usage: null, quota: null }));

  const libraries = [
    ['idb 8.0.4', 'IndexedDB ergonomics (MIT)'],
    ['marked 18.1.1', 'Markdown parsing (MIT)'],
    ['DOMPurify 3.4.17', 'HTML sanitization (MPL-2.1 / Apache-2.0)'],
    ['highlight.js 11.12.0', 'Syntax highlighting (BSD-3-Clause)'],
    ['KaTeX 0.19.0', 'Math rendering (MIT)'],
    ['supabase-js 2.118.0', 'Cloud sync client, loaded only when configured (MIT)'],
    ['JSZip 3.10.2', 'ZIP export, loaded on demand (MIT / GPLv3 dual)'],
    ['Inter, JetBrains Mono, Noto Sans Myanmar 5.3.0', 'Bundled fonts (SIL OFL 1.1)'],
  ];

  return h('div', { class: 'stack stack--lg' }, [
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'About DevNotes' })]),
      h('div', { class: 'stack stack--sm' }, [
        h('p', { text: `Version ${APP.version} · backup format ${APP.backupFormat}` }),
        h('p', { class: 'text-muted', text: 'DevNotes is an offline-first personal knowledge library. Your data stays in this browser; sync and AI are opt-in. No analytics, no tracking, no external requests unless you configure them.' }),
        h('p', { class: 'text-muted', text: `Storage in use: ${stats?.usage != null ? formatBytes(stats.usage) : 'estimate unavailable'}${stats?.quota ? ` of ${formatBytes(stats.quota)}` : ''}` }),
      ]),
    ]),
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Third-party libraries' })]),
      h('ul', { class: 'stack stack--sm', style: { paddingLeft: 'var(--sp-5)' } },
        libraries.map(([name, note]) => h('li', {}, [
          h('strong', { text: name }),
          h('span', { class: 'text-muted', text: ` — ${note}` }),
        ]))),
      h('p', { class: 'text-muted', text: 'License texts ship next to every vendored library and in src/fonts/bundled/.' }),
    ]),
    h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [h('h2', { class: 'section__title', text: 'Links' })]),
      h('div', { class: 'stack stack--sm' }, [
        h('a', { class: 'btn btn--sm', attrs: { href: 'https://console.groq.com/docs/models', target: '_blank', rel: 'noopener noreferrer' } }, [icon('external'), 'Groq model docs']),
        h('a', { class: 'btn btn--sm', attrs: { href: 'https://supabase.com/docs', target: '_blank', rel: 'noopener noreferrer' } }, [icon('external'), 'Supabase docs']),
      ]),
    ]),
  ]);
}
