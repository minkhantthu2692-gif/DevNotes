/**
 * prefs.js — preference schema, defaults and application to the DOM.
 *
 * Defaults → IndexedDB (`preferences` store, authoritative) → mirrored into
 * localStorage so the pre-paint bootstrap in index.html can restore theme and
 * typography before the module graph boots (no flash of wrong theme).
 */

import { getAllPrefs, setPrefs, resetPrefs } from '../../db/repositories/preferences.js';
import { STORAGE_KEYS, AI } from '../../config.js';
import { bus } from '../../utils/bus.js';

export const DEFAULT_PREFS = {
  // Appearance
  theme: 'system',                 // 'light' | 'dark' | 'system'
  accent: '#5b6cff',               // any CSS hex color
  density: 'comfortable',          // 'comfortable' | 'compact'
  motion: 'auto',                  // 'auto' | 'reduced'
  glass: false,                    // experimental blur surfaces

  // Typography
  uiFont: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  codeFont: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '1rem',                // root font size
  codeFontSize: '0.875rem',
  lineHeight: 1.6,
  letterSpacing: 0,                // em

  // Editor
  editorMode: 'split',             // 'split' | 'edit' | 'preview'
  editorWidth: 74,                 // characters (max-width ch)
  wordWrap: false,                 // source textarea wrap
  lineNumbers: false,              // default for code blocks in preview
  tabSize: 2,
  autosaveDelay: 900,              // ms
  defaultCodeLanguage: '',         // '' = no language tag

  // Library
  defaultSort: 'updated',
  defaultDir: 'desc',
  defaultStatus: 'not-started',
  showArchivedInList: false,

  // AI (all optional; AI never blocks core note features)
  aiEnabled: true,
  aiModel: AI.defaultModel,
  aiTemperature: 0.4,
  aiMaxTokens: 2048,
  aiTimeoutMs: AI.defaultTimeoutMs,
  aiOutputLanguage: 'en',          // 'en' | 'my'
  translateDirection: 'en-my',     // 'en-my' | 'my-en'
  aiContextEnabled: true,          // allow attaching the open lesson as context
};

const MIRROR_KEYS = [
  'theme', 'density', 'motion', 'glass', 'accent', 'fontSize', 'lineHeight',
  'letterSpacing', 'uiFont', 'codeFont', 'codeFontSize', 'editorWidth',
];

let cached = { ...DEFAULT_PREFS };
let systemThemeListener = null;

/** In-memory current preferences (valid after loadPrefs()). */
export function getPrefs() {
  return { ...cached };
}

/** Read from IndexedDB and merge with defaults. */
export async function loadPrefs() {
  try {
    const stored = await getAllPrefs();
    cached = { ...DEFAULT_PREFS, ...stored };
  } catch (err) {
    console.warn('[prefs] falling back to defaults:', err?.message);
    cached = { ...DEFAULT_PREFS };
  }
  applyPrefs(cached);
  return getPrefs();
}

/** Persist + apply + notify. Partial patches are merged. */
export async function savePrefs(patch) {
  const next = { ...cached, ...patch };
  cached = next;
  applyPrefs(next);
  try {
    await setPrefs(patch);
  } catch (err) {
    console.error('[prefs] persist failed:', err);
    throw err;
  }
  bus.emit('prefs:saved', { patch });
  return getPrefs();
}

export async function resetAllPrefs() {
  cached = { ...DEFAULT_PREFS };
  applyPrefs(cached);
  await resetPrefs();
}

function resolveTheme(theme) {
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme === 'dark' ? 'dark' : 'light';
}

/** Apply preferences to <html> and mirror the first-paint subset. */
export function applyPrefs(prefs) {
  const root = document.documentElement;

  // Theme (with live system tracking when theme === 'system')
  const setResolved = () => root.setAttribute('data-theme', resolveTheme(prefs.theme));
  setResolved();
  if (systemThemeListener) {
    systemThemeListener();
    systemThemeListener = null;
  }
  if (prefs.theme === 'system' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved();
    mq.addEventListener('change', onChange);
    systemThemeListener = () => mq.removeEventListener('change', onChange);
  }

  root.setAttribute('data-density', prefs.density === 'compact' ? 'compact' : 'comfortable');
  root.setAttribute('data-motion', prefs.motion === 'reduced' ? 'reduced' : 'auto');
  root.setAttribute('data-glass', prefs.glass ? 'on' : 'off');

  root.style.setProperty('--accent-user', prefs.accent);
  root.style.fontSize = prefs.fontSize;
  root.style.setProperty('--leading-user', String(prefs.lineHeight));
  root.style.setProperty('--tracking-user', `${prefs.letterSpacing}em`);
  root.style.setProperty('--font-ui', prefs.uiFont);
  root.style.setProperty('--font-code', prefs.codeFont);
  root.style.setProperty('--font-size-code', prefs.codeFontSize);
  root.style.setProperty('--editor-max', `${prefs.editorWidth}ch`);
  root.style.setProperty('--tab-size', String(prefs.tabSize));

  try {
    const mirror = {};
    for (const key of MIRROR_KEYS) mirror[key] = prefs[key];
    localStorage.setItem(STORAGE_KEYS.ui, JSON.stringify(mirror));
  } catch { /* storage disabled: theme still applies for this session */ }
}
