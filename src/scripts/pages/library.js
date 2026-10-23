/**
 * library.js — the Programming Library: search, filters, sorting, list/grid
 * views and bulk editing of lessons.
 *
 * Filtering has two layers:
 *   1. dropdown filters persisted in the URL (language/category/status/…)
 *   2. the search box, which also understands the query syntax from
 *      utils/search.js (lang: tag: status: is:favorite has:code …)
 * Selection state is session-only; bulk actions confirm before mutating.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate, setQuery } from '../router.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { toast } from '../components/toast.js';
import { openMenu } from '../components/menu.js';
import { confirmDialog, promptDialog } from '../components/dialog.js';
import { emptyState, skeleton, inlineNote } from '../components/feedback.js';
import {
  lessonsRepo, languagesRepo, categoriesRepo, coursesRepo,
} from '../db/repositories/index.js';
import { parseQuery, scoreRecord, matchesFlags, segmentHighlight, applySort } from '../utils/search.js';
import { LESSON_STATUSES, DIFFICULTIES } from '../utils/validate.js';
import { formatRelative, pluralize } from '../utils/format.js';
import { getPrefs } from '../features/settings/prefs.js';

const PAGE_SIZE = 40;

const STATUS_LABEL = {
  'not-started': 'Not started',
  learning: 'Learning',
  learned: 'Learned',
};

function option(value, label, current) {
  return h('option', { value, text: label, attrs: value === current ? { selected: '' } : {} });
}

function highlightTitle(text, terms) {
  const spans = segmentHighlight(String(text ?? ''), terms);
  const frag = document.createDocumentFragment();
  for (const seg of spans) {
    if (seg.hit) frag.appendChild(h('mark', { text: seg.text }));
    else frag.appendChild(document.createTextNode(seg.text));
  }
  return frag;
}

export default {
  id: 'library',
  title: () => 'Programming Library',

  mount(container, ctx) {
    const prefs = getPrefs();
    const query = ctx.query;
    ctx.setBreadcrumbs?.([{ label: 'Programming Library', path: '/library' }]);

    const state = {
      q: query.q || '',
      lang: query.lang || '',
      category: query.cat || '',
      course: query.course || '',
      status: query.status || '',
      difficulty: query.difficulty || '',
      sort: query.sort || prefs.defaultSort || 'updated',
      dir: query.dir || prefs.defaultDir || 'desc',
      view: query.view === 'grid' ? 'grid' : 'list',
      showArchived: query.archived === '1' || prefs.showArchivedInList,
      limit: PAGE_SIZE,
      selected: new Set(),
    };

    let lessons = [];
    let languages = [];
    let categories = [];
    let courses = [];
    let filtered = [];
    let disposed = false;

    /* ---------------------------------------------------------------- shell */

    const header = h('header', { class: 'page-header' }, [
      h('div', { class: 'page-header__title' }, [
        h('h1', { text: 'Programming Library' }),
        h('p', { class: 'page-header__subtitle', id: 'library-count', text: 'Loading…' }),
      ]),
      h('div', { class: 'page-header__actions' }, [
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          on: { click: () => navigate('/lesson/new') },
        }, [icon('plus'), 'New lesson']),
      ]),
    ]);

    const searchInput = h('input', {
      class: 'input',
      type: 'search',
      id: 'library-search',
      value: state.q,
      attrs: { placeholder: 'Search…  (lang: tag: status: is:favorite)', autocomplete: 'off' },
    });

    const langSelect = h('select', { class: 'select', id: 'library-lang', attrs: { 'aria-label': 'Filter by language' } });
    const catSelect = h('select', { class: 'select', id: 'library-cat', attrs: { 'aria-label': 'Filter by category' } });
    const courseSelect = h('select', { class: 'select', id: 'library-course', attrs: { 'aria-label': 'Filter by course' } });
    const statusSelect = h('select', { class: 'select', id: 'library-status', attrs: { 'aria-label': 'Filter by status' } }, [
      option('', 'Any status', state.status),
      ...LESSON_STATUSES.map((s) => option(s, STATUS_LABEL[s], state.status)),
    ]);
    const diffSelect = h('select', { class: 'select', id: 'library-difficulty', attrs: { 'aria-label': 'Filter by difficulty' } }, [
      option('', 'Any level', state.difficulty),
      ...DIFFICULTIES.map((d) => option(d, d[0].toUpperCase() + d.slice(1), state.difficulty)),
    ]);
    const sortSelect = h('select', { class: 'select', id: 'library-sort', attrs: { 'aria-label': 'Sort lessons' } }, [
      option('updated', 'Last updated', state.sort),
      option('created', 'Date created', state.sort),
      option('title', 'Title (A–Z)', state.sort),
      option('opened', 'Recently opened', state.sort),
      option('order', 'Manual order', state.sort),
      option('review', 'Review date', state.sort),
    ]);

    const dirBtn = h('button', {
      class: 'btn btn--icon',
      type: 'button',
      attrs: { 'aria-label': state.dir === 'asc' ? 'Sort ascending' : 'Sort descending', 'data-tooltip': 'Toggle sort direction' },
      on: { click: () => { state.dir = state.dir === 'asc' ? 'desc' : 'asc'; persist(); } },
    }, [icon(state.dir === 'asc' ? 'chevronDown' : 'sort')]);

    const viewBtn = h('button', {
      class: 'btn btn--icon',
      type: 'button',
      attrs: { 'aria-label': state.view === 'grid' ? 'Switch to list view' : 'Switch to grid view', 'data-tooltip': 'Toggle view' },
      on: { click: () => { state.view = state.view === 'grid' ? 'list' : 'grid'; persist(); } },
    }, [icon(state.view === 'grid' ? 'list' : 'preview')]);

    const archivedToggle = h('label', { class: 'switch', attrs: { title: 'Show archived lessons' } }, [
      h('input', {
        type: 'checkbox',
        attrs: state.showArchived ? { checked: '' } : {},
        on: { change: (event) => { state.showArchived = event.target.checked; persist(); } },
      }),
      h('span', { class: 'switch__track' }),
      h('span', { text: 'Archived' }),
    ]);

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
      h('label', { class: 'search-field', attrs: { for: 'library-search' } }, [
        h('span', { class: 'sr-only', text: 'Search lessons' }),
        h('span', { class: 'search-field__icon' }, [icon('search')]),
        searchInput,
        searchClear,
      ]),
      langSelect,
      catSelect,
      courseSelect,
      statusSelect,
      diffSelect,
      h('span', { class: 'spacer' }),
      sortSelect,
      dirBtn,
      viewBtn,
      archivedToggle,
      h('button', {
        class: 'btn btn--sm btn--ghost',
        type: 'button',
        text: 'Reset',
        on: {
          click: () => {
            Object.assign(state, {
              q: '', lang: '', category: '', course: '', status: '', difficulty: '',
              sort: prefs.defaultSort, dir: prefs.defaultDir, limit: PAGE_SIZE, selected: new Set(),
            });
            searchInput.value = '';
            persist();
          },
        },
      }),
    ]);

    const listHost = h('div', { class: 'stack' }, [skeleton({ count: 3, variant: 'card' })]);
    const bulkHost = h('div');
    const root = h('div', { class: 'stack stack--lg' }, [header, filterBar, inlineNote('Tip: combine words with filters, e.g.  closure tag:js status:learning is:favorite', 'info'), listHost, bulkHost]);

    container.appendChild(root);

    /* --------------------------------------------------------------- helper */

    function nameMap(records) {
      return new Map(records.map((record) => [record.id, record]));
    }

    function viewRecord(lesson, langById, catById, courseById) {
      const lang = langById.get(lesson.languageId);
      const cat = catById.get(lesson.categoryId);
      const course = courseById.get(lesson.courseId);
      return {
        ...lesson,
        languageKey: lang ? lang.name.toLowerCase() : '',
        categoryKey: cat ? cat.name.toLowerCase() : '',
        courseKey: course ? course.name.toLowerCase() : '',
        hasCode: /```/.test(lesson.content || ''),
        type: 'lesson',
      };
    }

    function persist() {
      state.limit = Math.max(state.limit, PAGE_SIZE);
      // URL is the source of truth for filter state; the router hands the new
      // query back through onQuery, which re-renders in place (no remount).
      setQuery({
        q: state.q || null,
        lang: state.lang || null,
        cat: state.category || null,
        course: state.course || null,
        status: state.status || null,
        difficulty: state.difficulty || null,
        sort: state.sort,
        dir: state.dir,
        view: state.view === 'grid' ? 'grid' : null,
        archived: state.showArchived ? '1' : null,
      });
    }

    /** Query-only route update (called by the router instead of remounting). */
    function onQuery(next) {
      state.q = next.q || '';
      state.lang = next.lang || '';
      state.category = next.cat || '';
      state.course = next.course || '';
      state.status = next.status || '';
      state.difficulty = next.difficulty || '';
      state.sort = next.sort || prefs.defaultSort || 'updated';
      state.dir = next.dir || prefs.defaultDir || 'desc';
      state.view = next.view === 'grid' ? 'grid' : 'list';
      state.showArchived = next.archived === '1' || prefs.showArchivedInList;
      if (searchInput.value !== state.q) searchInput.value = state.q;
      void render();
    }

    function computeFiltered() {
      const langById = nameMap(languages);
      const catById = nameMap(categories);
      const courseById = nameMap(courses);

      let list = lessons
        .filter((lesson) => (state.showArchived ? true : !lesson.archived))
        .map((lesson) => viewRecord(lesson, langById, catById, courseById));

      // Dropdown filters (URL-backed, id based)
      if (state.lang) list = list.filter((lesson) => lesson.languageId === state.lang);
      if (state.category) list = list.filter((lesson) => lesson.categoryId === state.category);
      if (state.course) list = list.filter((lesson) => lesson.courseId === state.course);
      if (state.status) list = list.filter((lesson) => lesson.status === state.status);
      if (state.difficulty) list = list.filter((lesson) => lesson.difficulty === state.difficulty);

      // Search box (free text + query syntax)
      const parsed = parseQuery(state.q);
      if (parsed.text || Object.keys(parsed.filters).length || parsed.tags.length) {
        list = list.filter((lesson) => {
          if (!matchesFlags(lesson, parsed)) return false;
          if (!parsed.text) return true;
          return scoreRecord(
            {
              title: lesson.title,
              summary: lesson.summary,
              tags: lesson.tags,
              content: lesson.content,
              language: lesson.languageKey,
              category: lesson.categoryKey,
            },
            parsed.text,
          ) >= 0;
        });
      }

      // Pinned first, then the chosen sort.
      const pinned = list.filter((lesson) => lesson.pinned);
      const rest = list.filter((lesson) => !lesson.pinned);
      return [...pinned, ...applySort(rest, state.sort, state.dir)];
    }

    /* --------------------------------------------------------------- render */

    function rowMenu(anchor, lesson) {
      openMenu(anchor, [
        { label: 'Open', icon: 'edit', onSelect: () => navigate(`/lesson/${encodeURIComponent(lesson.id)}`) },
        {
          label: lesson.pinned ? 'Unpin' : 'Pin to top',
          icon: 'pin',
          onSelect: () => void lessonsRepo.update(lesson.id, { pinned: !lesson.pinned }).catch(showError),
        },
        {
          label: lesson.favorite ? 'Remove favorite' : 'Add to favorites',
          icon: 'star',
          onSelect: () => void lessonsRepo.update(lesson.id, { favorite: !lesson.favorite }).catch(showError),
        },
        {
          label: lesson.archived ? 'Unarchive' : 'Archive',
          icon: 'archive',
          onSelect: () => void lessonsRepo.update(lesson.id, { archived: !lesson.archived }).catch(showError),
        },
        { separator: true },
        {
          label: 'Duplicate',
          icon: 'duplicate',
          onSelect: async () => {
            try {
              const copy = await lessonsRepo.duplicate(lesson.id);
              toast(`Duplicated as “${copy.title}”`, { tone: 'success' });
              navigate(`/lesson/${encodeURIComponent(copy.id)}`);
            } catch (err) { showError(err); }
          },
        },
        {
          label: 'Move to trash',
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            const ok = await confirmDialog({
              title: 'Move to trash?',
              message: `“${lesson.title}” will be recoverable from Trash.`,
              confirmLabel: 'Move to trash',
              danger: true,
            });
            if (!ok) return;
            try {
              await lessonsRepo.softDelete(lesson.id);
              state.selected.delete(lesson.id);
              toast('Lesson moved to trash', { tone: 'success' });
            } catch (err) { showError(err); }
          },
        },
      ], { anchor });
    }

    function renderListRow(lesson) {
      const terms = parseQuery(state.q).text.split(/\s+/).filter(Boolean);
      const lang = languages.find((l) => l.id === lesson.languageId);
      const cat = categories.find((c) => c.id === lesson.categoryId);

      const checkbox = h('input', {
        class: 'checkbox',
        type: 'checkbox',
        attrs: { 'aria-label': `Select ${lesson.title}` , ...(state.selected.has(lesson.id) ? { checked: '' } : {}) },
        on: {
          change: (event) => {
            if (event.target.checked) state.selected.add(lesson.id);
            else state.selected.delete(lesson.id);
            renderBulk();
          },
        },
      });

      const menuBtn = h('button', {
        class: 'icon-btn',
        type: 'button',
        attrs: { 'aria-label': `Actions for ${lesson.title}`, 'aria-haspopup': 'menu' },
        on: { click: (event) => rowMenu(event.currentTarget, lesson) },
      }, [icon('more')]);

      return h('div', { class: 'list__row', dataset: { id: lesson.id } }, [
        checkbox,
        h('button', {
          class: 'list__row-main',
          type: 'button',
          on: { click: () => navigate(`/lesson/${encodeURIComponent(lesson.id)}`) },
        }, [
          h('span', { class: 'list__row-title' }, [
            lesson.pinned ? icon('pin') : null,
            highlightTitle(lesson.title, terms),
            h('span', { class: `badge badge--${lesson.status}`, text: STATUS_LABEL[lesson.status] || lesson.status }),
            lesson.favorite ? h('span', { class: 'badge badge--favorite', text: '★' }) : null,
            lesson.archived ? h('span', { class: 'badge badge--info', text: 'Archived' }) : null,
          ]),
          h('span', { class: 'list__row-sub', text: [
            lang?.name, cat?.name,
            `${formatRelative(lesson.updatedAt)}`,
            lesson.summary ? lesson.summary.slice(0, 120) : '',
          ].filter(Boolean).join(' · ') }),
        ]),
        h('div', { class: 'list__row-actions' }, [menuBtn]),
      ]);
    }

    function renderCard(lesson) {
      const lang = languages.find((l) => l.id === lesson.languageId);
      const cat = categories.find((c) => c.id === lesson.categoryId);

      return h('div', { class: 'card', dataset: { id: lesson.id } }, [
        h('div', { class: 'row row--between' }, [
          h('input', {
            class: 'checkbox',
            type: 'checkbox',
            attrs: { 'aria-label': `Select ${lesson.title}`, ...(state.selected.has(lesson.id) ? { checked: '' } : {}) },
            on: {
              change: (event) => {
                if (event.target.checked) state.selected.add(lesson.id);
                else state.selected.delete(lesson.id);
                renderBulk();
              },
            },
          }),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            attrs: { 'aria-label': `Actions for ${lesson.title}`, 'aria-haspopup': 'menu' },
            on: { click: (event) => rowMenu(event.currentTarget, lesson) },
          }, [icon('more')]),
        ]),
        h('button', {
          class: 'card--interactive',
          type: 'button',
          style: { background: 'none', border: '0', padding: '0', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
          on: { click: () => navigate(`/lesson/${encodeURIComponent(lesson.id)}`) },
        }, [
          h('div', { class: 'card__title', text: lesson.title }),
          h('div', { class: 'card__meta' }, [
            h('span', { class: `badge badge--${lesson.status}`, text: STATUS_LABEL[lesson.status] || lesson.status }),
            lang ? h('span', { class: 'chip chip--lang', text: lang.name }) : null,
            cat ? h('span', { text: cat.name }) : null,
            h('span', { text: formatRelative(lesson.updatedAt) }),
          ]),
          lesson.summary ? h('p', { class: 'card__body', text: lesson.summary.slice(0, 160) }) : null,
        ]),
      ]);
    }

    function renderBulk() {
      clear(bulkHost);
      const count = state.selected.size;
      if (!count) return;

      const applyToSelected = async (label, fn) => {
        const ids = [...state.selected];
        try {
          for (const id of ids) await fn(id);
          state.selected.clear();
          toast(`${label} applied to ${ids.length} ${pluralize(ids.length, 'lesson')}`, { tone: 'success' });
        } catch (err) { showError(err); }
        renderBulk();
        void render();
      };

      const menuFor = (anchor, label, items) =>
        openMenu(anchor, items.map((item) => ({
          ...item,
          onSelect: () => applyToSelected(label, (id) => lessonsRepo.update(id, item.patch)),
        })), { anchor });

      bulkHost.appendChild(
        h('div', { class: 'bulk-bar', attrs: { role: 'region', 'aria-label': 'Bulk actions' } }, [
          h('span', { class: 'bulk-bar__count', text: `${count} selected` }),

          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            attrs: { 'aria-haspopup': 'menu' },
            on: {
              click: (event) => menuFor(event.currentTarget, 'Status', LESSON_STATUSES.map((s) => ({
                label: `Set status: ${STATUS_LABEL[s]}`, patch: { status: s },
              }))),
            },
          }, [icon('flag'), 'Status']),

          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            attrs: { 'aria-haspopup': 'menu' },
            on: {
              click: (event) => menuFor(event.currentTarget, 'Language', [
                { label: 'Clear language', patch: { languageId: null } },
                ...languages.map((lang) => ({ label: lang.name, patch: { languageId: lang.id } })),
              ]),
            },
          }, [icon('languages'), 'Language']),

          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            attrs: { 'aria-haspopup': 'menu' },
            on: {
              click: (event) => menuFor(event.currentTarget, 'Category', [
                { label: 'Clear category', patch: { categoryId: null } },
                ...categories.map((cat) => ({ label: cat.name, patch: { categoryId: cat.id } })),
              ]),
            },
          }, [icon('folder'), 'Category']),

          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            on: {
              click: async () => {
                const tag = await promptDialog({
                  title: 'Add a tag',
                  label: 'Tag',
                  hint: 'Added to every selected lesson (duplicates are skipped).',
                  confirmLabel: 'Add tag',
                });
                if (!tag) return;
                await applyToSelected('Tag', async (id) => {
                  const lesson = await lessonsRepo.get(id);
                  const tags = [...new Set([...(lesson.tags || []), tag])];
                  await lessonsRepo.update(id, { tags });
                });
              },
            },
          }, [icon('tag'), 'Add tag']),

          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            on: {
              click: () => applyToSelected('Archive', (id) => lessonsRepo.update(id, { archived: true })),
            },
          }, [icon('archive'), 'Archive']),

          h('button', {
            class: 'btn btn--sm btn--danger',
            type: 'button',
            on: {
              click: async () => {
                const ok = await confirmDialog({
                  title: `Trash ${count} ${pluralize(count, 'lesson')}?`,
                  message: 'They stay recoverable in Trash until you purge them.',
                  confirmLabel: 'Move to trash',
                  danger: true,
                });
                if (!ok) return;
                await applyToSelected('Trash', (id) => lessonsRepo.softDelete(id));
              },
            },
          }, [icon('trash'), 'Trash']),

          h('button', {
            class: 'btn btn--sm btn--ghost',
            type: 'button',
            text: 'Clear selection',
            on: { click: () => { state.selected.clear(); renderBulk(); void render(); } },
          }),
        ]),
      );
    }

    async function render() {
      if (disposed) return;
      try {
        const [langs, cats, crs] = await Promise.all([
          languagesRepo.getAll(), categoriesRepo.getAll(), coursesRepo.getAll(),
        ]);
        lessons = await lessonsRepo.getAll();
        languages = langs;
        categories = cats;
        courses = crs;
        if (disposed) return;

        // Keep dropdowns in sync with data (they can change elsewhere).
        const fill = (select, placeholder, records, current, labelFn) => {
          const keep = current;
          clear(select);
          select.appendChild(option('', placeholder, keep));
          for (const record of records) select.appendChild(option(record.id, labelFn(record), keep));
          select.value = keep;
        };
        fill(langSelect, 'All languages', languages, state.lang, (l) => l.name);
        fill(catSelect, 'All categories', categories, state.category, (c) => c.name);
        fill(courseSelect, 'All courses', courses, state.course, (c) => c.name);
        statusSelect.value = state.status;
        diffSelect.value = state.difficulty;
        sortSelect.value = state.sort;
        const archivedInput = archivedToggle.querySelector('input');
        if (archivedInput) archivedInput.checked = state.showArchived;
        searchClear.hidden = !state.q;
        dirBtn.setAttribute('aria-label', state.dir === 'asc' ? 'Sort ascending' : 'Sort descending');
        clear(dirBtn);
        dirBtn.appendChild(icon(state.dir === 'asc' ? 'chevronDown' : 'sort'));
        clear(viewBtn);
        viewBtn.appendChild(icon(state.view === 'grid' ? 'preview' : 'library'));

        filtered = computeFiltered();

        // Drop selections that are no longer visible.
        const visibleIds = new Set(filtered.map((lesson) => lesson.id));
        for (const id of [...state.selected]) if (!visibleIds.has(id)) state.selected.delete(id);

        const countLabel = document.getElementById('library-count');
        if (countLabel) {
          const total = lessons.length;
          countLabel.textContent = filtered.length === total
            ? `${total} ${pluralize(total, 'lesson')}`
            : `${filtered.length} of ${total} ${pluralize(total, 'lesson')}`;
        }

        clear(listHost);
        const visible = filtered.slice(0, state.limit);

        if (!filtered.length) {
          listHost.appendChild(lessons.length
            ? emptyState({
                iconName: 'search',
                title: 'No lessons match',
                text: 'Try fewer words or clear the filters. The query syntax supports lang:, category:, tag:, status:, is:favorite and has:code.',
                actions: [{
                  label: 'Clear filters',
                  onClick: () => {
                    Object.assign(state, {
                      q: '', lang: '', category: '', course: '', status: '', difficulty: '',
                      limit: PAGE_SIZE,
                    });
                    searchInput.value = '';
                    persist();
                  },
                }],
              })
            : emptyState({
                iconName: 'library',
                title: 'No lessons yet',
                text: 'Create your first lesson or import a backup to fill the library.',
                actions: [
                  { label: 'New lesson', variant: 'primary', onClick: () => navigate('/lesson/new') },
                  { label: 'Import backup', onClick: () => navigate('/settings?section=data') },
                ],
              }));
          renderBulk();
          return;
        }

        const viewHost = state.view === 'grid'
          ? h('div', { class: 'grid-list' }, visible.map(renderCard))
          : h('div', { class: 'list' }, visible.map(renderListRow));
        listHost.appendChild(viewHost);

        if (filtered.length > visible.length) {
          listHost.appendChild(
            h('div', { class: 'row', style: { justifyContent: 'center' } }, [
              h('button', {
                class: 'btn',
                type: 'button',
                text: `Show ${Math.min(PAGE_SIZE, filtered.length - visible.length)} more`,
                on: { click: () => { state.limit += PAGE_SIZE; void render(); } },
              }),
            ]),
          );
        }

        renderBulk();
      } catch (err) {
        if (disposed) return;
        console.error('[library] render failed:', err);
        clear(listHost);
        listHost.appendChild(emptyState({
          iconName: 'alert',
          title: 'Library could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
        }));
      }
    }

    function showError(err) {
      console.error('[library] action failed:', err);
      toast(err?.message || 'That action failed', { tone: 'danger' });
    }

    /* ------------------------------------------------------------- listeners */

    const onSearch = debounce(() => {
      state.q = searchInput.value.trim();
      state.limit = PAGE_SIZE;
      persist();
    }, 220);
    searchInput.addEventListener('input', onSearch);

    langSelect.addEventListener('change', () => { state.lang = langSelect.value; persist(); });
    catSelect.addEventListener('change', () => { state.category = catSelect.value; persist(); });
    courseSelect.addEventListener('change', () => { state.course = courseSelect.value; persist(); });
    statusSelect.addEventListener('change', () => { state.status = statusSelect.value; persist(); });
    diffSelect.addEventListener('change', () => { state.difficulty = diffSelect.value; persist(); });
    sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; persist(); });

    const offData = bus.on('data:changed', debounce(() => void render(), 250));

    void render();

    return {
      beforeLeave: async () => { onSearch.cancel?.(); },
      onQuery,
      destroy() {
        disposed = true;
        offData();
        onSearch.cancel?.();
      },
      onShow() { void render(); },
    };
  },
};
