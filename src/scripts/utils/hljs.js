/**
 * hljs.js — lazy syntax highlighting.
 *
 * One primary library (Highlight.js 11, vendored, official pre-compiled ESM).
 * Only `core.min.js` loads eagerly; each language grammar is fetched the first
 * time it is needed and then cached (the service worker caches them too).
 */

import hljs from '../../vendor/highlight.js/core.min.js';

const registered = new Map(); // canonical name -> true | Promise<true>

/** Common aliases (Markdown info strings) -> vendored grammar file names. */
const ALIASES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  html: 'xml', htm: 'xml', svg: 'xml', xml: 'xml', rss: 'xml', xsl: 'xml', vue: 'xml', wxss: 'css',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', cli: 'bash',
  py: 'python', python3: 'python', py3: 'python',
  rb: 'ruby', yml: 'yaml', md: 'markdown', 'mdx': 'markdown',
  'c#': 'csharp', cs: 'csharp', 'c#-script': 'csharp',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', 'h': 'cpp', 'hpp': 'cpp',
  kt: 'kotlin', kts: 'kotlin',
  'objective-c': 'objectivec', objc: 'objectivec', 'obj-c': 'objectivec',
  ps1: 'powershell', psm1: 'powershell',
  dockerfile: 'dockerfile', 'docker': 'dockerfile',
  git: 'diff', patch: 'diff',
  jsonc: 'json', json5: 'json',
  tex: 'latex',
  toml: 'toml', cfg: 'ini', conf: 'ini', 'properties': 'ini',
  gradle: 'groovy', text: '__plain__', txt: '__plain__', plaintext: '__plain__', plain: '__plain__',
  'node': 'javascript', 'webmanifest': 'json', 'js+dts': 'javascript',
  'cql': 'sql', psql: 'sql', mysql: 'sql', 'tsql': 'sql',
  scss: 'scss', less: 'less',
  golang: 'go', gnumake: 'makefile', make: 'makefile',
  'f#': 'fsharp', vbnet: 'vbnet', 'as3': 'actionscript',
};

/** Languages worth pre-warming when the first code block appears. */
const WARM = ['javascript', 'python', 'xml', 'css', 'json', 'bash', 'sql'];

const escapeHtml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function canonical(lang) {
  const norm = String(lang || '').toLowerCase().trim();
  if (!norm) return null;
  return ALIASES[norm] || norm;
}

function loadGrammar(name) {
  if (registered.has(name)) return registered.get(name);

  const promise = import(
    new URL(`../../vendor/highlight.js/languages/${name}.min.js`, import.meta.url)
  )
    .then((mod) => {
      hljs.registerLanguage(name, mod.default);
      registered.set(name, true);
      return true;
    })
    .catch(() => {
      // Unknown language file: remember the miss so we never retry it.
      registered.set(name, false);
      return false;
    });

  registered.set(name, promise);
  return promise;
}

let warmStarted = false;
function warmCommonLanguages() {
  if (warmStarted) return;
  warmStarted = true;
  // Fire-and-forget: highlighting waits only on the language it needs.
  WARM.forEach(loadGrammar);
}

/**
 * Highlight source code.
 * @param {string} code raw source text (untrusted)
 * @param {string} [lang] Markdown info string (e.g. "js", "python")
 * @returns {Promise<{html: string, language: string, known: boolean}>}
 *          html is always safe to assign as innerHTML: either Highlight.js
 *          output (escaped) or our own escaped plain text.
 */
export async function highlightCode(code, lang = '') {
  const source = String(code ?? '');
  const name = canonical(lang);

  if (name === '__plain__' || !name) {
    return { html: escapeHtml(source), language: name === '__plain__' ? 'text' : '', known: name === '__plain__' };
  }

  warmCommonLanguages();

  // Already registered (or previously failed) -> synchronous path.
  const state = registered.get(name);
  if (state === false) {
    return { html: escapeHtml(source), language: name, known: false };
  }
  if (state !== true) {
    const ok = await loadGrammar(name);
    if (!ok) return { html: escapeHtml(source), language: name, known: false };
  }

  try {
    const result = hljs.highlight(source, { language: name, ignoreIllegals: true });
    return { html: result.value, language: name, known: true };
  } catch (err) {
    console.warn(`[hljs] highlight failed for "${name}":`, err.message);
    return { html: escapeHtml(source), language: name, known: false };
  }
}

/**
 * Synchronous highlighting for exports/copies — only works when the grammar
 * is already loaded; otherwise returns escaped plain text.
 */
export function highlightSync(code, lang = '') {
  const source = String(code ?? '');
  const name = canonical(lang);
  if (!name || name === '__plain__') return escapeHtml(source);
  if (registered.get(name) !== true) return escapeHtml(source);
  try {
    return hljs.highlight(source, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(source);
  }
}
