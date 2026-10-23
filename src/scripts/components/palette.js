/**
 * palette.js — command palette (Ctrl/Cmd + K): navigation, actions and
 * global search across lessons and snippets in one entry point.
 */

import { h, clear, trapFocus } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';
import { NAV_ITEMS } from '../navigation.js';
import { getPrefs, savePrefs } from '../features/settings/prefs.js';
import { getSnapshot } from '../db/snapshot.js';
import { lessonsRepo, snippetsRepo } from '../db/repositories/index.js';
import { parseQuery, scoreRecord, applySort } from '../utils/search.js';
import { debounce } from '../utils/debounce.js';
import { STORAGE_KEYS } from '../config.js';

let root = null;
let release = null;

/* ---------------------------------------------------------------- actions */

function loadRecentSearches() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.recentSearches) || '[]');
    return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function rememberSearch(term) {
  const clean = String(term || '').trim();
  if (!clean) return;
  const next = [clean, ...loadRecentSearches().filter((s) => s.toLowerCase() !== clean.toLowerCase())].slice(0, 6);
  try {
    localStorage.setItem(STORAGE_KEYS.recentSearches, JSON.stringify(next));
  } catch { /* ignore */ }
}

async function toggleTheme() {
  const order = ['light', 'dark', 'system'];
  const prefs = getPrefs();
  const next = order[(order.indexOf(prefs.theme) + 1) % order.length];
  await savePrefs({ theme: next });
}

function commandItems() {
  const prefs = getPrefs();
  const items = [];

  for (const nav of NAV_ITEMS) {
    items.push({
      group: 'Navigate',
      label: nav.label,
      icon: nav.icon,
      keywords: nav.path,
      run: () => navigate(nav.path),
    });
  }

  items.push(
    { group: 'Create', label: 'New lesson', icon: 'edit', keywords: 'create add', run: () => navigate('/lesson/new') },
    { group: 'Create', label: 'New snippet', icon: 'snippet', keywords: 'create code', run: () => navigate('/snippets?new=1') },
    { group: 'Create', label: 'New flashcard', icon: 'review', keywords: 'create card', run: () => navigate('/review?new=1') },
    { group: 'Create', label: 'New language', icon: 'languages', keywords: 'create', run: () => navigate('/languages?new=1') },
    { group: 'Create', label: 'Import a backup', icon: 'upload', keywords: 'restore json', run: () => navigate('/settings?section=data') },
    { group: 'Create', label: 'Export all data', icon: 'download', keywords: 'backup json', run: () => navigate('/settings?section=data') },
    {
      group: 'Actions',
      label: `Switch theme (now: ${prefs.theme})`,
      icon: 'sun',
      keywords: 'dark light appearance',
      run: toggleTheme,
    },
    {
      group: 'Actions',
      label: 'Toggle compact density',
      icon: 'menu',
      keywords: 'spacing size',
      run: () => savePrefs({ density: prefs.density === 'compact' ? 'comfortable' : 'compact' }),
    },
    { group: 'Actions', label: 'Review due cards', icon: 'play', keywords: 'study flashcard', run: () => navigate('/review?view=queue') },
    { group: 'Actions', label: 'Ask the AI assistant', icon: 'sparkles', keywords: 'groq help', run: () => navigate('/assistant') },
  );

  return items;
}

/* ------------------------------------------------------------------ search */

async function searchContent(term) {
  const parsed = parseQuery(term);
  const [lessons, snippets] = await Promise.all([
    getSnapshot('lesson', () => lessonsRepo.getAll({ includeTrashed: false })),
    getSnapshot('snippet', () => snippetsRepo.getAll({ includeTrashed: false })),
  ]);

  const lessonResults = [];
  for (const lesson of lessons) {
    const languageId = lesson.languageId;
    const score = scoreRecord(
      {
        title: lesson.title,
        summary: lesson.summary,
        tags: lesson.tags,
        content: lesson.content,
        extra: lesson.notes,
      },
      parsed.text,
    );
    if (score > 0) lessonResults.push({ lesson, score, languageId });
  }

  const snippetResults = [];
  for (const snippet of snippets) {
    const score = scoreRecord(
      { title: snippet.name, summary: snippet.description, tags: snippet.tags, code: snippet.code, language: snippet.language },
      parsed.text,
    );
    if (score > 0) snippetResults.push({ snippet, score });
  }

  lessonResults.sort((a, b) => b.score - a.score);
  snippetResults.sort((a, b) => b.score - a.score);

  return {
    lessons: applySort(lessonResults.slice(0, 8).map((r) => r.lesson), 'updated', 'desc'),
    snippets: snippetResults.slice(0, 5).map((r) => r.snippet),
  };
}

/* ------------------------------------------------------------------ render */

function closePalette() {
  if (!root) return;
  const backdrop = root;
  root = null;
  release?.();
  release = null;
  backdrop.remove();
  document.body.style.overflow = '';
}

/**
 * Open the command palette.
 * @param {{initial?: string}} [options]
 */
export function openPalette({ initial = '' } = {}) {
  if (root) {
    // Already open: just focus the input with the new text.
    const input = root.querySelector('.palette__input');
    if (input) {
      input.value = initial;
      input.focus();
      input.dispatchEvent(new Event('input'));
    }
    return;
  }

  const input = h('input', {
    class: 'input palette__input',
    type: 'text',
    attrs: {
      id: 'palette-input',
      placeholder: 'Search lessons, snippets, or type a command…',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'palette-results',
      'aria-autocomplete': 'list',
      autocomplete: 'off',
      spellcheck: 'false',
    },
    value: initial,
  });

  const results = h('div', {
    class: 'palette__results',
    id: 'palette-results',
    attrs: { role: 'listbox', 'aria-label': 'Results' },
  });

  const palette = h('div', { class: 'palette', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' } }, [
    input,
    results,
    h('div', { class: 'palette__footer' }, [
      h('span', {}, [h('kbd', { text: '↑↓' }), ' navigate']),
      h('span', {}, [h('kbd', { text: 'Enter' }), ' open']),
      h('span', {}, [h('kbd', { text: 'Esc' }), ' close']),
    ]),
  ]);

  const backdrop = h('div', { class: 'palette-backdrop' }, [palette]);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) closePalette();
  });

  document.getElementById('palette-root').appendChild(backdrop);
  document.body.style.overflow = 'hidden';
  root = backdrop;
  release = trapFocus(palette, { onEscape: closePalette });

  /* ------------------------------------------------------- result state */
  let flatItems = [];   // visible items for keyboard navigation
  let activeIndex = 0;

  const renderItem = (item, index) => {
    const node = h('button', {
      class: 'palette__item',
      type: 'button',
      id: `palette-opt-${index}`,
      attrs: { role: 'option', 'aria-selected': String(index === activeIndex) },
      dataset: { index: String(index) },
      on: {
        click: () => {
          closePalette();
          item.run();
        },
      },
    }, [
      item.icon ? icon(item.icon) : null,
      h('span', { text: item.label }),
      item.description ? h('span', { class: 'palette__item-desc', text: item.description }) : null,
    ]);
    return node;
  };

  const paint = (groups, extras = []) => {
    clear(results);
    flatItems = [];
    let index = 0;
    for (const [groupLabel, items] of groups) {
      if (!items.length) continue;
      results.appendChild(h('div', { class: 'palette__group', text: groupLabel }));
      for (const item of items) {
        flatItems.push(item);
        results.appendChild(renderItem(item, index));
        index += 1;
      }
    }
    for (const node of extras) results.appendChild(node);

    if (flatItems.length === 0 && extras.length === 0) {
      results.appendChild(h('div', { class: 'palette__empty', text: 'No matches' }));
    }
    activeIndex = 0;
    syncActive();
  };

  const syncActive = () => {
    results.querySelectorAll('.palette__item').forEach((node, index) => {
      const active = index === activeIndex;
      node.setAttribute('aria-selected', String(active));
      if (active) {
        input.setAttribute('aria-activedescendant', node.id);
        node.scrollIntoView({ block: 'nearest' });
      }
    });
    if (flatItems.length) input.setAttribute('aria-activedescendant', `palette-opt-${activeIndex}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const paintStatic = () => {
    const term = input.value.trim().toLowerCase();
    const all = commandItems().filter((item) => {
      if (!term) return item.group === 'Navigate' || item.group === 'Create';
      return `${item.label} ${item.keywords || ''}`.toLowerCase().includes(term);
    });
    const grouped = ['Navigate', 'Create', 'Actions'].map((group) => [group, all.filter((i) => i.group === group)]);

    const extras = [];
    if (!term) {
      const recent = loadRecentSearches();
      if (recent.length) {
        grouped.push(['Recent searches', recent.map((s) => ({
          group: 'Recent searches',
          label: s,
          icon: 'clock',
          run: () => { rememberSearch(s); navigate(`/library?q=${encodeURIComponent(s)}`); },
        }))]);
      }
    } else {
      grouped.push([
        'Search',
        [{
          group: 'Search',
          label: `Search the library for “${input.value.trim()}”`,
          icon: 'search',
          run: () => {
            rememberSearch(input.value.trim());
            navigate(`/library?q=${encodeURIComponent(input.value.trim())}`);
          },
        }],
      ]);
    }
    paint(grouped, extras);
  };

  const runContentSearch = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) { paintStatic(); return; }
    try {
      const { lessons, snippets } = await searchContent(term);
      if (input.value.trim() !== term) return; // stale response

      const lessonItems = lessons.map((lesson) => ({
        group: 'Lessons',
        label: lesson.title,
        icon: 'book',
        description: lesson.archived ? 'archived' : '',
        run: () => navigate(`/lesson/${lesson.id}`),
      }));
      const snippetItems = snippets.map((snippet) => ({
        group: 'Snippets',
        label: snippet.name,
        icon: 'snippet',
        description: snippet.language,
        run: () => navigate(`/snippets?q=${encodeURIComponent(snippet.name)}`),
      }));

      const groups = [
        ['Lessons', lessonItems],
        ['Snippets', snippetItems],
      ];
      // Keep commands available below content results while typing.
      const commands = commandItems().filter((item) =>
        `${item.label} ${item.keywords || ''}`.toLowerCase().includes(term.toLowerCase()),
      );
      groups.push(['Commands', commands.filter((i) => i.group === 'Navigate').slice(0, 5)]);
      groups.push(['Actions', commands.filter((i) => i.group !== 'Navigate')]);
      paint(groups);
    } catch (err) {
      console.warn('[palette] search failed:', err?.message);
      paintStatic();
    }
  }, 160);

  input.addEventListener('input', () => {
    paintStatic();
    runContentSearch();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (flatItems.length) { activeIndex = (activeIndex + 1) % flatItems.length; syncActive(); }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (flatItems.length) { activeIndex = (activeIndex - 1 + flatItems.length) % flatItems.length; syncActive(); }
    } else if (event.key === 'Home' && flatItems.length) {
      event.preventDefault(); activeIndex = 0; syncActive();
    } else if (event.key === 'End' && flatItems.length) {
      event.preventDefault(); activeIndex = flatItems.length - 1; syncActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = flatItems[activeIndex];
      if (item) { closePalette(); item.run(); }
    }
  });

  paintStatic();
  input.focus();
  input.select();
}

export function togglePalette() {
  root ? closePalette() : openPalette();
}

export function isPaletteOpen() {
  return Boolean(root);
}
