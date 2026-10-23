/**
 * activity.js — Activity & History (route /activity).
 *
 * A local-only browser of what happened in this browser: the activity trail
 * written by the repositories, lesson revision snapshots, and a storage
 * estimate. Sync queue and conflicts deliberately live on the Account page.
 *
 * The activity store has no text index, so the label search runs client-side
 * over a bounded window of the newest rows (SEARCH_WINDOW): matches older than
 * that window are not found. Pagination grows both the fetched window and the
 * displayed slice.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate, setQuery } from '../router.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { toast } from '../components/toast.js';
import { openDialog, confirmDialog } from '../components/dialog.js';
import { emptyState, skeleton, inlineNote } from '../components/feedback.js';
import { getStats, activityLog, revisions, lessonsRepo } from '../db/repositories/index.js';
import { formatRelative, formatDateTime, formatBytes, formatNumber, countWords, pluralize } from '../utils/format.js';
import { renderMarkdown } from '../utils/markdown.js';
import { hydrateCodeBlocks } from '../components/code-block.js';

const PAGE = 100; // "Show more" step
const SEARCH_WINDOW = 1000; // newest rows the client-side label search sees

const ENTITY_OPTIONS = [
  ['', 'All activity'],
  ['lesson', 'Lessons'],
  ['snippet', 'Snippets'],
  ['flashcard', 'Flashcards'],
  ['language', 'Languages'],
  ['category', 'Categories'],
  ['course', 'Courses'],
];

/** Icons per activity action — every name verified against utils/icons.js. */
const ACTION_ICON = {
  created: 'plus',
  updated: 'edit',
  deleted: 'trash',
  restored: 'refresh',
  purged: 'alert',
  duplicated: 'duplicate',
};

function option(value, label, current) {
  return h('option', { value, text: label, attrs: value === current ? { selected: '' } : {} });
}

function byTitle(a, b) {
  return String(a?.title ?? '').localeCompare(String(b?.title ?? ''));
}

function section(title, hint, content) {
  return h('section', { class: 'section' }, [
    h('div', { class: 'section__header' }, [
      h('div', { class: 'row' }, [
        h('h2', { class: 'section__title', text: title }),
        hint ? h('span', { class: 'section__hint', text: hint }) : null,
      ]),
    ]),
    content,
  ]);
}

function statCard(label, value, hint) {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'stat__label', text: label }),
    h('div', { class: 'stat__value', text: String(value) }),
    hint ? h('div', { class: 'stat__hint', text: hint }) : null,
  ]);
}

export default {
  id: 'activity',
  title: () => 'Activity & History',

  mount(container, ctx) {
    ctx.setBreadcrumbs?.([{ label: 'Activity & History', path: '/activity' }]);

    const query = ctx.query || {};
    const state = {
      q: query.q || '',
      entity: query.entity || '',
      lesson: query.lesson || '',
      limit: PAGE,
    };

    let disposed = false;
    let lessonOptions = [];

    /* --------------------------------------------------------------- shell */

    const subtitle = h('p', { class: 'page-header__subtitle', text: 'Loading…' });
    const header = h('header', { class: 'page-header' }, [
      h('div', { class: 'page-header__title' }, [h('h1', { text: 'Activity & History' }), subtitle]),
      h('div', { class: 'page-header__actions' }, [
        h('button', {
          class: 'btn',
          type: 'button',
          on: { click: () => void clearLog() },
        }, [icon('trash'), 'Clear activity log']),
      ]),
    ]);

    const statsHost = h('div', { class: 'grid grid--stats' });

    const searchInput = h('input', {
      class: 'input',
      type: 'search',
      id: 'activity-search',
      value: state.q,
      attrs: { placeholder: 'Search labels…', autocomplete: 'off' },
    });
    const searchClear = h('button', {
      class: 'search-field__clear',
      type: 'button',
      hidden: !state.q,
      attrs: { 'aria-label': 'Clear label search' },
      on: {
        click: () => {
          searchInput.value = '';
          state.q = '';
          state.limit = PAGE;
          searchClear.hidden = true;
          setQuery({ q: null });
        },
      },
    }, [icon('x')]);
    const entitySelect = h('select', { class: 'select', id: 'activity-entity', attrs: { 'aria-label': 'Filter by record type' } },
      ENTITY_OPTIONS.map(([value, label]) => option(value, label, state.entity)));
    const timelineCount = h('span', { class: 'text-muted' });
    const filterBar = h('div', { class: 'filter-bar' }, [
      h('label', { class: 'search-field', attrs: { for: 'activity-search' } }, [
        h('span', { class: 'sr-only', text: 'Search activity labels' }),
        h('span', { class: 'search-field__icon' }, [icon('search')]),
        searchInput,
        searchClear,
      ]),
      entitySelect,
      h('span', { class: 'spacer' }),
      timelineCount,
    ]);
    const timelineHost = h('div', { class: 'stack stack--sm' });

    const lessonSelect = h('select', { class: 'select', id: 'activity-lesson', attrs: { 'aria-label': 'Choose a lesson' } },
      [option('', 'Choose a lesson…', state.lesson)]);
    const revisionsHost = h('div', { class: 'stack stack--sm' });

    const boot = skeleton({ count: 4, variant: 'title' });
    const root = h('div', { class: 'stack stack--lg' }, [
      header,
      statsHost,
      boot,
      section('Activity timeline', 'newest first', h('div', { class: 'stack' }, [filterBar, timelineHost])),
      section('Lesson versions', 'saved while you edit', h('div', { class: 'stack' }, [
        h('label', { class: 'row' }, [
          h('span', { class: 'field__label', text: 'Lesson' }),
          lessonSelect,
        ]),
        revisionsHost,
      ])),
    ]);
    container.appendChild(root);

    /* ------------------------------------------------------------- activity */

    function timelineItem(row, lessonIds) {
      const iconName = ACTION_ICON[row.action] || 'activity';
      const label = `${row.action} · ${row.label}`;
      const canOpen = row.entity === 'lesson' && lessonIds.has(row.entityId);
      // Links navigate, so an <a> is used (AGENTS.md §4); trashed or purged
      // lessons fall back to plain text instead of a dead link.
      const labelEl = canOpen
        ? h('a', {
            class: 'timeline__label',
            href: `#/lesson/${encodeURIComponent(row.entityId)}`,
            text: label,
            attrs: { 'aria-label': `Open lesson: ${row.label}` },
            on: {
              click: (event) => {
                event.preventDefault();
                navigate(`/lesson/${encodeURIComponent(row.entityId)}`);
              },
            },
          })
        : h('div', { class: 'timeline__label', text: label });

      return h('div', { class: 'timeline__item' }, [
        h('div', { class: 'timeline__icon' }, [icon(iconName)]),
        h('div', { class: 'timeline__body' }, [
          labelEl,
          h('div', { class: 'timeline__meta', text: `${row.entity} · ${formatRelative(row.at)}` }),
        ]),
      ]);
    }

    function renderTimeline(rows, lessonIds) {
      clear(timelineHost);
      const term = state.q.trim().toLowerCase();
      const matches = term
        ? rows.filter((row) => String(row.label ?? '').toLowerCase().includes(term))
        : rows;
      const visible = matches.slice(0, state.limit);
      timelineCount.textContent = term || state.entity
        ? `${visible.length} shown`
        : pluralize(rows.length, 'entry');

      if (!rows.length) {
        timelineHost.appendChild(emptyState({
          iconName: 'activity',
          title: state.entity ? 'No activity of this type yet' : 'No activity recorded yet',
          text: state.entity
            ? 'Nothing was recorded for this record type. Pick another type to see more.'
            : 'Creating, editing, trashing and restoring records is recorded here. The log stays in this browser.',
          actions: state.entity ? [{
            label: 'Show all activity',
            onClick: () => {
              state.entity = '';
              entitySelect.value = '';
              setQuery({ entity: null });
            },
          }] : [],
        }));
        return;
      }

      if (!visible.length) {
        timelineHost.appendChild(emptyState({
          iconName: 'search',
          title: 'No matching entries',
          text: 'Try other words — search looks at the record label, e.g. a lesson title.',
          actions: [{
            label: 'Clear search',
            onClick: () => {
              state.q = '';
              state.limit = PAGE;
              searchInput.value = '';
              searchClear.hidden = true;
              setQuery({ q: null });
            },
          }],
        }));
        return;
      }

      timelineHost.appendChild(h('div', { class: 'timeline' }, visible.map((row) => timelineItem(row, lessonIds))));

      // While searching, matches are known only up to the fetched window;
      // without a search the window equals the display limit.
      const hasMore = term ? matches.length > visible.length : rows.length >= state.limit;
      if (hasMore) {
        timelineHost.appendChild(h('div', { class: 'row', style: { justifyContent: 'center' } }, [
          h('button', {
            class: 'btn',
            type: 'button',
            text: `Show ${PAGE} more`,
            on: { click: () => { state.limit += PAGE; void render(); } },
          }),
        ]));
      }
    }

    /* ------------------------------------------------------------- revisions */

    function revisionRow(row) {
      const words = countWords(row.snapshot?.content ?? '').words;
      return h('div', { class: 'list__row' }, [
        h('div', { class: 'list__row-main' }, [
          h('span', { class: 'list__row-title', text: formatDateTime(row.at) }),
          h('span', { class: 'list__row-sub', text: `${words} ${words === 1 ? 'word' : 'words'}` }),
        ]),
        h('div', { class: 'list__row-actions' }, [
          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            text: 'View',
            attrs: { 'aria-label': `View version from ${formatDateTime(row.at)}` },
            on: { click: () => void openRevisionView(row) },
          }),
          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            text: 'Restore',
            attrs: { 'aria-label': `Restore version from ${formatDateTime(row.at)}` },
            on: { click: () => void restoreRevision(row) },
          }),
        ]),
      ]);
    }

    async function openRevisionView(row) {
      try {
        const html = await renderMarkdown(row.snapshot?.content ?? '', {});
        const body = h('div', { class: 'stack stack--sm' }, [
          h('div', { class: 'meta-line' }, [
            h('strong', { text: row.snapshot?.title || 'Untitled lesson' }),
            h('span', { text: formatDateTime(row.at) }),
          ]),
          h('div', { class: 'markdown-body', html }), // sanitized by renderMarkdown
        ]);
        hydrateCodeBlocks(body);
        await openDialog({
          title: `Version from ${formatDateTime(row.at)}`,
          body,
          size: 'wide',
          actions: [{ label: 'Close', value: null }],
        });
      } catch (err) {
        showError(err);
      }
    }

    async function restoreRevision(row) {
      const ok = await confirmDialog({
        title: 'Restore this version?',
        message: 'Your current lesson content is kept — the restored version is saved as a new version on top of it.',
        confirmLabel: 'Restore',
      });
      if (!ok) return;
      try {
        const updated = await revisions.restore(row.id);
        if (!updated) {
          toast('That version no longer exists.', { tone: 'danger' });
        } else {
          toast('Version restored', { tone: 'success' });
        }
        await render();
      } catch (err) {
        showError(err);
      }
    }

    async function renderRevisions() {
      clear(revisionsHost);
      if (!state.lesson) {
        revisionsHost.appendChild(inlineNote('Choose a lesson above to browse its saved versions.', 'info'));
        return;
      }
      revisionsHost.appendChild(skeleton({ count: 2, variant: 'title' }));
      let rows;
      try {
        rows = await revisions.listFor(state.lesson);
      } catch (err) {
        if (disposed) return;
        clear(revisionsHost);
        revisionsHost.appendChild(emptyState({
          iconName: 'alert',
          title: 'Versions could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Try again', variant: 'primary', onClick: () => void render() }],
        }));
        return;
      }
      if (disposed) return;
      clear(revisionsHost);
      if (!rows.length) {
        revisionsHost.appendChild(inlineNote(
          'Versions are captured automatically while you edit a lesson (at most one per 5-minute burst).',
          'info',
        ));
        return;
      }
      revisionsHost.appendChild(h('div', { class: 'list' }, rows.map(revisionRow)));
    }

    function fillLessonSelect() {
      const current = state.lesson;
      clear(lessonSelect);
      lessonSelect.appendChild(option('', 'Choose a lesson…', current));
      for (const lesson of lessonOptions) lessonSelect.appendChild(option(lesson.id, lesson.title, current));
      lessonSelect.value = lessonOptions.some((lesson) => lesson.id === current) ? current : '';
    }

    async function clearLog() {
      const ok = await confirmDialog({
        title: 'Clear the activity log?',
        message: 'This only erases the local activity trail kept in this browser.',
        details: 'Lessons, snippets, flashcards and saved lesson versions are not affected.',
        confirmLabel: 'Clear log',
        danger: true,
      });
      if (!ok) return;
      try {
        await activityLog.clear();
        toast('Activity log cleared', { tone: 'success' });
        await render();
      } catch (err) {
        showError(err);
      }
    }

    function showError(err) {
      console.error('[activity] action failed:', err);
      toast(err?.message || 'That action failed', { tone: 'danger' });
    }

    /* --------------------------------------------------------------- render */

    async function render() {
      if (disposed) return;
      try {
        // Label search has no store support, so always fetch a wide enough
        // window for it (see the file header).
        const fetchLimit = Math.max(state.limit, state.q ? SEARCH_WINDOW : 0);
        const [stats, rows, lessons] = await Promise.all([
          getStats(), // also embeds the storage estimate (no second DB pass)
          activityLog.list({ entity: state.entity || null, limit: fetchLimit }),
          lessonsRepo.getAll(),
        ]);
        if (disposed) return;

        lessonOptions = [...lessons].sort(byTitle);
        if (state.lesson && !lessonOptions.some((lesson) => lesson.id === state.lesson)) {
          // The chosen lesson was deleted since the URL was written.
          state.lesson = '';
          setQuery({ lesson: null });
        }
        fillLessonSelect();

        if (entitySelect.value !== state.entity) entitySelect.value = state.entity;
        // A data:changed re-render can land before the search debounce has
        // pushed the value to the URL — never rewrite the focused input.
        if (document.activeElement !== searchInput && searchInput.value !== state.q) {
          searchInput.value = state.q;
        }
        searchClear.hidden = !searchInput.value;

        boot.remove();

        const records = stats.lessons + stats.snippets + stats.cards;
        subtitle.textContent = `${pluralize(records, 'record')} in this browser`;
        clear(statsHost);
        statsHost.appendChild(statCard(
          'Records',
          formatNumber(records),
          `${stats.lessons} lessons · ${stats.snippets} snippets · ${stats.cards} cards`,
        ));
        const { storage } = stats;
        statsHost.appendChild(storage.usage != null
          ? statCard('Storage', formatBytes(storage.usage), storage.quota
              ? `Usage: ${formatBytes(storage.usage)} of ${formatBytes(storage.quota)}`
              : 'used by this browser')
          : statCard('Storage', 'unavailable', 'the browser did not report an estimate'));

        // Existing lesson ids are the guard for linking timeline labels: a
        // trashed or purged lesson renders as plain text.
        renderTimeline(rows, new Set(lessonOptions.map((lesson) => lesson.id)));
        await renderRevisions();
      } catch (err) {
        if (disposed) return;
        console.error('[activity] render failed:', err);
        boot.remove();
        clear(statsHost);
        clear(timelineHost);
        clear(revisionsHost);
        timelineHost.appendChild(emptyState({
          iconName: 'alert',
          title: 'Activity could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
        }));
      }
    }

    /* ------------------------------------------------------------ listeners */

    const onSearch = debounce(() => {
      state.q = searchInput.value.trim();
      state.limit = PAGE;
      setQuery({ q: state.q || null });
    }, 220);
    searchInput.addEventListener('input', onSearch);

    entitySelect.addEventListener('change', () => {
      state.entity = entitySelect.value;
      state.limit = PAGE;
      setQuery({ entity: state.entity || null });
    });

    lessonSelect.addEventListener('change', () => {
      state.lesson = lessonSelect.value;
      setQuery({ lesson: state.lesson || null });
    });

    const reload = debounce(() => void render(), 250);
    const offData = bus.on('data:changed', reload);

    void render();

    return {
      beforeLeave() { onSearch.cancel(); },
      onQuery(next) {
        state.q = next.q || '';
        state.entity = next.entity || '';
        state.lesson = next.lesson || '';
        state.limit = PAGE;
        void render();
      },
      onShow() { void render(); },
      destroy() {
        disposed = true;
        offData();
        reload.cancel();
        onSearch.cancel();
      },
    };
  },
};
