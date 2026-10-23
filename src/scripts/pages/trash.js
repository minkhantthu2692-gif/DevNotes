/**
 * trash.js — soft-deleted lessons, snippets and flashcards.
 *
 * Restore returns a record to the library; permanent deletion only happens
 * after an explicit danger confirmation. All data access goes through the
 * repository API (getAll({onlyTrashed:true}) / restore / purge).
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/dialog.js';
import { emptyState, skeleton, errorState, inlineNote } from '../components/feedback.js';
import {
  lessonsRepo, snippetsRepo, flashcardsRepo, languagesRepo,
} from '../db/repositories/index.js';
import { formatRelative, pluralize } from '../utils/format.js';

const STATUS_LABEL = {
  'not-started': 'Not started',
  learning: 'Learning',
  learned: 'Learned',
};

const SECTIONS = [
  {
    key: 'lessons',
    title: 'Lessons',
    noun: 'lesson',
    repo: lessonsRepo,
    labelOf: (lesson) => lesson.title,
    // Original status + language where cheap (missing language is fine).
    metaOf: (lesson, langById) => {
      const parts = [STATUS_LABEL[lesson.status] || lesson.status];
      const lang = langById.get(lesson.languageId);
      if (lang) parts.push(lang.name);
      return parts.join(' · ');
    },
  },
  {
    key: 'snippets',
    title: 'Snippets',
    noun: 'snippet',
    repo: snippetsRepo,
    labelOf: (snippet) => snippet.name,
    metaOf: (snippet) => (snippet.language ? snippet.language : ''),
  },
  {
    key: 'flashcards',
    title: 'Flashcards',
    noun: 'card',
    repo: flashcardsRepo,
    labelOf: (card) => card.front,
    metaOf: (card) => (card.source === 'ai' && !card.approved ? 'AI draft' : `Leitner box ${card.box ?? 1}`),
  },
];

export default {
  id: 'trash',
  title: () => 'Trash',

  mount(container, ctx) {
    ctx.setBreadcrumbs?.([{ label: 'Trash', path: '/trash' }]);

    const state = { q: ctx.query.q || '' };
    const sectionState = new Map(); // key → {all: [], error: boolean}
    let disposed = false;

    /* ------------------------------------------------------------- shell */

    const actionsHost = h('div', { class: 'page-header__actions' });
    const header = h('header', { class: 'page-header' }, [
      h('div', { class: 'page-header__title' }, [
        h('h1', { text: 'Trash' }),
        h('p', {
          class: 'page-header__subtitle',
          text: 'Deleted items stay recoverable here until you purge them.',
        }),
      ]),
      actionsHost,
    ]);

    const searchInput = h('input', {
      class: 'input',
      type: 'search',
      id: 'trash-search',
      value: state.q,
      attrs: { placeholder: 'Search trash…', autocomplete: 'off' },
    });

    const searchClear = h('button', {
      class: 'search-field__clear',
      type: 'button',
      attrs: { 'aria-label': 'Clear search' },
      hidden: !state.q,
      on: {
        click: () => {
          searchInput.value = '';
          state.q = '';
          searchClear.hidden = true;
          persist();
        },
      },
    }, [icon('x')]);

    const filterBar = h('div', { class: 'filter-bar' }, [
      h('label', { class: 'search-field', attrs: { for: 'trash-search' } }, [
        h('span', { class: 'sr-only', text: 'Search trash' }),
        h('span', { class: 'search-field__icon' }, [icon('search')]),
        searchInput,
        searchClear,
      ]),
    ]);

    const contentHost = h('div', { class: 'stack stack--lg' }, [skeleton({ count: 3, variant: 'card' })]);
    const root = h('div', { class: 'stack stack--lg' }, [header, filterBar, contentHost]);
    container.appendChild(root);

    /* ----------------------------------------------------------- helpers */

    function showError(err) {
      console.error('[trash] action failed:', err);
      toast(err?.message || 'That action failed', { tone: 'danger' });
    }

    function persist() {
      ctx.setQuery({ q: state.q || null });
    }

    const matchesQuery = (label) =>
      !state.q || String(label ?? '').toLowerCase().includes(state.q.toLowerCase());

    /* ----------------------------------------------------------- actions */

    async function onRestore(sectionDef, record) {
      try {
        await sectionDef.repo.restore(record.id);
        toast('Restored', { tone: 'success' });
        void render();
      } catch (err) { showError(err); }
    }

    async function onPurge(sectionDef, record) {
      const label = sectionDef.labelOf(record) || '(untitled)';
      const ok = await confirmDialog({
        title: `Permanently delete “${label}”?`,
        message: 'This cannot be recovered.',
        confirmLabel: 'Delete forever',
        danger: true,
      });
      if (!ok) return;
      try {
        await sectionDef.repo.purge(record.id);
        toast('Deleted permanently', { tone: 'success' });
      } catch (err) { showError(err); }
    }

    async function onEmptySection(sectionDef) {
      const all = sectionState.get(sectionDef.key)?.all ?? [];
      if (!all.length) return;
      const ok = await confirmDialog({
        title: `Empty ${sectionDef.title.toLowerCase()} trash?`,
        message: `${pluralize(all.length, sectionDef.noun)} will be deleted permanently. This cannot be recovered.`,
        confirmLabel: 'Empty trash',
        danger: true,
      });
      if (!ok) return;
      try {
        for (const record of all) await sectionDef.repo.purge(record.id);
        toast(`${sectionDef.title} trash emptied`, { tone: 'success' });
      } catch (err) { showError(err); }
      void render();
    }

    async function onEmptyAll() {
      const total = SECTIONS.reduce((sum, sectionDef) =>
        sum + (sectionState.get(sectionDef.key)?.all?.length ?? 0), 0);
      if (!total) return;
      const breakdown = SECTIONS
        .filter((sectionDef) => (sectionState.get(sectionDef.key)?.all?.length ?? 0) > 0)
        .map((sectionDef) => pluralize(sectionState.get(sectionDef.key).all.length, sectionDef.noun))
        .join(' · ');
      const ok = await confirmDialog({
        title: 'Empty all trash?',
        message: `${breakdown} will be deleted permanently. This cannot be recovered.`,
        confirmLabel: 'Empty all trash',
        danger: true,
      });
      if (!ok) return;
      try {
        for (const sectionDef of SECTIONS) {
          for (const record of sectionState.get(sectionDef.key)?.all ?? []) {
            await sectionDef.repo.purge(record.id);
          }
        }
        toast('Trash emptied', { tone: 'success' });
      } catch (err) { showError(err); }
      void render();
    }

    /* ------------------------------------------------------------ render */

    function renderRow(sectionDef, record, langById) {
      const label = sectionDef.labelOf(record) || '(untitled)';
      const extra = sectionDef.metaOf(record, langById);
      const when = formatRelative(record.trashAt || record.updatedAt);

      return h('div', { class: 'list__row', dataset: { id: record.id } }, [
        h('div', { class: 'list__row-main' }, [
          h('span', { class: 'list__row-title', text: label }),
          h('span', { class: 'list__row-sub', text: extra ? `${when} · ${extra}` : when }),
        ]),
        h('div', { class: 'list__row-actions' }, [
          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            on: { click: () => void onRestore(sectionDef, record) },
          }, [icon('restore'), 'Restore']),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            attrs: { 'aria-label': `Delete “${label}” permanently`, title: 'Delete permanently' },
            on: { click: () => void onPurge(sectionDef, record) },
          }, [icon('trash')]),
        ]),
      ]);
    }

    async function render() {
      if (disposed) return;
      clear(actionsHost);
      clear(contentHost);
      contentHost.appendChild(skeleton({ count: 3, variant: 'card' }));

      // Language names are cosmetic here — a failure degrades the meta line
      // instead of breaking the whole page.
      const [results, langs] = await Promise.all([
        Promise.allSettled(SECTIONS.map((sectionDef) => sectionDef.repo.getAll({ onlyTrashed: true }))),
        languagesRepo.getAll().catch((err) => {
          console.error('[trash] language names unavailable:', err);
          return [];
        }),
      ]);
      if (disposed) return;

      const langById = new Map(langs.map((lang) => [lang.id, lang]));
      clear(contentHost);
      searchClear.hidden = !state.q;

      let totalAll = 0;
      let anyError = false;
      const built = [];

      SECTIONS.forEach((sectionDef, index) => {
        const result = results[index];

        if (result.status === 'rejected') {
          anyError = true;
          sectionState.set(sectionDef.key, { all: [], error: true });
          built.push(
            h('section', { class: 'section' }, [
              h('div', { class: 'section__header' }, [
                h('h2', { class: 'section__title', text: sectionDef.title }),
                h('span', { class: 'section__hint', text: 'could not load' }),
              ]),
              errorState({
                title: `${sectionDef.title} could not load`,
                message: String(result.reason?.message || result.reason),
                retry: { label: 'Try again', onClick: () => void render() },
              }),
            ]),
          );
          return;
        }

        const all = result.value;
        sectionState.set(sectionDef.key, { all, error: false });
        totalAll += all.length;

        const filtered = all.filter((record) => matchesQuery(sectionDef.labelOf(record)));
        const hint = filtered.length === all.length
          ? pluralize(all.length, sectionDef.noun)
          : `${pluralize(filtered.length, sectionDef.noun)} of ${pluralize(all.length, sectionDef.noun)}`;

        const body = h('div', { class: 'stack stack--sm' });
        if (!filtered.length) {
          body.appendChild(all.length
            ? inlineNote(`No trashed ${sectionDef.noun} matches “${state.q}”.`, 'info')
            : h('p', { class: 'text-muted', text: `No trashed ${sectionDef.noun}.` }));
        } else {
          body.appendChild(h('div', { class: 'list' },
            filtered.map((record) => renderRow(sectionDef, record, langById))));
        }

        built.push(
          h('section', { class: 'section' }, [
            h('div', { class: 'section__header' }, [
              h('div', { class: 'row' }, [
                h('h2', { class: 'section__title', text: sectionDef.title }),
                h('span', { class: 'section__hint', text: hint }),
              ]),
              all.length
                ? h('button', {
                    class: 'btn btn--sm btn--danger',
                    type: 'button',
                    text: `Empty ${sectionDef.title.toLowerCase()}`,
                    on: { click: () => void onEmptySection(sectionDef) },
                  })
                : null,
            ]),
            body,
          ]),
        );
      });

      if (!totalAll && !anyError) {
        contentHost.appendChild(state.q
          ? emptyState({
              iconName: 'search',
              title: 'No matches in trash',
              text: 'Nothing in the trash matches the search.',
              actions: [{
                label: 'Clear search',
                onClick: () => {
                  state.q = '';
                  searchInput.value = '';
                  persist();
                },
              }],
            })
          : emptyState({
              iconName: 'trash',
              title: 'Trash is empty',
              text: 'Deleted lessons, snippets and flashcards land here first — recoverable until you purge them.',
            }));
        return;
      }

      for (const node of built) contentHost.appendChild(node);

      if (totalAll > 0) {
        actionsHost.appendChild(h('button', {
          class: 'btn btn--danger',
          type: 'button',
          on: { click: () => void onEmptyAll() },
        }, [icon('trash'), 'Empty all trash']));
      }
    }

    /* --------------------------------------------------------- listeners */

    const onSearch = debounce(() => {
      const next = searchInput.value.trim();
      if (next === state.q) return;
      state.q = next;
      persist();
    }, 220);
    searchInput.addEventListener('input', onSearch);

    const reload = debounce(() => void render(), 250);
    const offData = bus.on('data:changed', reload);

    void render();

    return {
      onQuery(next) {
        state.q = next.q || '';
        if (searchInput.value !== state.q) searchInput.value = state.q;
        void render();
      },
      onShow() { void render(); },
      destroy() {
        disposed = true;
        offData();
        reload.cancel?.();
        onSearch.cancel?.();
      },
    };
  },
};
