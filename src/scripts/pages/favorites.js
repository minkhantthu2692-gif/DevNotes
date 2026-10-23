/**
 * favorites.js — read-only aggregation of everything you starred.
 *
 * Only lessons and snippets carry a `favorite` flag (flashcards do not), so
 * this page merges those two collections, filters them by type/search and
 * offers a per-row "remove from favorites" action. Navigation prefers simple
 * deep links: a favorited snippet opens /snippets?q=<name> instead of
 * duplicating the snippet editor dialog inside this page.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate, setQuery } from '../router.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { toast } from '../components/toast.js';
import { emptyState, skeleton } from '../components/feedback.js';
import { lessonsRepo, snippetsRepo, languagesRepo, categoriesRepo } from '../db/repositories/index.js';
import { formatRelative, pluralize } from '../utils/format.js';

export default {
  id: 'favorites',
  title: () => 'Favorites',
  breadcrumbs: () => [{ label: 'Favorites', path: '/favorites' }],

  mount(container, ctx) {
    ctx.setBreadcrumbs?.([{ label: 'Favorites', path: '/favorites' }]);
    const query = ctx.query;

    const state = {
      q: query.q || '',
      type: ['lessons', 'snippets'].includes(query.type) ? query.type : 'all',
    };

    let lessons = [];
    let snippets = [];
    let languages = [];
    let categories = [];
    let filteredLessons = [];
    let filteredSnippets = [];
    let disposed = false;

    /* ---------------------------------------------------------------- shell */

    const header = h('header', { class: 'page-header' }, [
      h('div', { class: 'page-header__title' }, [
        h('h1', { text: 'Favorites' }),
        h('p', { class: 'page-header__subtitle', id: 'favorites-count', text: 'Loading…' }),
      ]),
      h('div', { class: 'page-header__actions' }, [
        h('button', {
          class: 'btn',
          type: 'button',
          on: { click: () => navigate('/library') },
        }, [icon('library'), 'Browse library']),
      ]),
    ]);

    const typeControl = h('div', {
      class: 'segmented',
      attrs: { role: 'radiogroup', 'aria-label': 'Filter favorites by type' },
    }, [['all', 'All'], ['lessons', 'Lessons'], ['snippets', 'Snippets']].map(([value, label]) =>
      h('label', { class: 'segmented__option' }, [
        h('input', {
          type: 'radio',
          name: 'favorites-type',
          value,
          attrs: state.type === value ? { checked: '' } : {},
          on: { change: () => { state.type = value; persist(); } },
        }),
        h('span', { text: label }),
      ])));

    const searchInput = h('input', {
      class: 'input',
      type: 'search',
      id: 'favorites-search',
      value: state.q,
      attrs: { placeholder: 'Search titles and tags…', autocomplete: 'off' },
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
      h('label', { class: 'search-field', attrs: { for: 'favorites-search' } }, [
        h('span', { class: 'sr-only', text: 'Search favorites' }),
        h('span', { class: 'search-field__icon' }, [icon('search')]),
        searchInput,
        searchClear,
      ]),
      typeControl,
    ]);

    const contentHost = h('div', { class: 'stack stack--lg' }, [skeleton({ count: 3, variant: 'title' })]);
    const root = h('div', { class: 'stack stack--lg' }, [header, filterBar, contentHost]);

    container.appendChild(root);

    /* --------------------------------------------------------------- rows */

    function favoriteRow({ id, title, meta, onOpen, onRemove, removeLabel }) {
      return h('div', { class: 'mini-row', dataset: { id } }, [
        h('button', {
          class: 'mini-row__title',
          type: 'button',
          style: { background: 'none', border: '0', padding: '0', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
          attrs: { title },
          on: { click: onOpen },
          text: title,
        }),
        h('span', { class: 'mini-row__meta', text: meta }),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          attrs: { 'aria-label': removeLabel, 'data-tooltip': 'Remove from favorites' },
          on: { click: onRemove },
        }, [icon('star')]),
      ]);
    }

    function section(title, hint, rows) {
      return h('section', { class: 'section' }, [
        h('div', { class: 'section__header' }, [
          h('h2', { class: 'section__title', text: title }),
          hint ? h('span', { class: 'section__hint', text: hint }) : null,
        ]),
        h('div', { class: 'mini-list' }, rows),
      ]);
    }

    async function removeFavorite(kind, id, title) {
      try {
        if (kind === 'lesson') await lessonsRepo.update(id, { favorite: false });
        else await snippetsRepo.update(id, { favorite: false });
        toast(`“${title}” removed from favorites`, { tone: 'info' });
        void render();
      } catch (err) {
        showError(err);
      }
    }

    function lessonRow(lesson, langById, catById) {
      const lang = langById.get(lesson.languageId);
      const cat = catById.get(lesson.categoryId);
      const meta = [lang?.name, cat?.name, formatRelative(lesson.updatedAt)].filter(Boolean).join(' · ') || 'Lesson';
      return favoriteRow({
        id: lesson.id,
        title: lesson.title,
        meta,
        onOpen: () => navigate(`/lesson/${encodeURIComponent(lesson.id)}`),
        removeLabel: `Remove ${lesson.title} from favorites`,
        onRemove: () => void removeFavorite('lesson', lesson.id, lesson.title),
      });
    }

    function snippetRow(snippet) {
      const meta = [snippet.language || 'Snippet', formatRelative(snippet.updatedAt)].filter(Boolean).join(' · ');
      return favoriteRow({
        id: snippet.id,
        title: snippet.name,
        meta,
        // Simpler than re-hosting the snippet editor dialog here: hand off to
        // the snippets page with the search box pre-filled (see file header).
        onOpen: () => navigate(`/snippets?q=${encodeURIComponent(snippet.name)}`),
        removeLabel: `Remove ${snippet.name} from favorites`,
        onRemove: () => void removeFavorite('snippet', snippet.id, snippet.name),
      });
    }

    /* --------------------------------------------------------------- render */

    function matchesSearch(text, tags) {
      const q = state.q.trim().toLowerCase();
      if (!q) return true;
      return `${text} ${(tags || []).join(' ')}`.toLowerCase().includes(q);
    }

    async function render() {
      if (disposed) return;
      try {
        const [allLessons, allSnippets, langs, cats] = await Promise.all([
          lessonsRepo.getAll(), snippetsRepo.getAll(), languagesRepo.getAll(), categoriesRepo.getAll(),
        ]);
        if (disposed) return;
        lessons = allLessons;
        snippets = allSnippets;
        languages = langs;
        categories = cats;

        const favLessons = lessons.filter((lesson) => lesson.favorite);
        const favSnippets = snippets.filter((snippet) => snippet.favorite);
        const langById = new Map(languages.map((l) => [l.id, l]));
        const catById = new Map(categories.map((c) => [c.id, c]));

        filteredLessons = (state.type === 'snippets' ? [] : favLessons)
          .filter((lesson) => matchesSearch(lesson.title, lesson.tags));
        filteredSnippets = (state.type === 'lessons' ? [] : favSnippets)
          .filter((snippet) => matchesSearch(snippet.name, snippet.tags));

        const total = favLessons.length + favSnippets.length;
        const shown = filteredLessons.length + filteredSnippets.length;
        const countLabel = document.getElementById('favorites-count');
        if (countLabel) {
          countLabel.textContent = shown === total
            ? `${total} ${pluralize(total, 'favorite')}`
            : `${shown} of ${total} ${pluralize(total, 'favorite')}`;
        }

        searchClear.hidden = !state.q;

        clear(contentHost);

        if (!lessons.length && !snippets.length) {
          contentHost.appendChild(emptyState({
            iconName: 'star',
            title: 'Nothing saved yet',
            text: 'Create your first lesson to start building your library, then star anything you want to keep close.',
            actions: [{ label: 'New lesson', variant: 'primary', onClick: () => navigate('/lesson/new') }],
          }));
          return;
        }

        if (!total) {
          contentHost.appendChild(emptyState({
            iconName: 'star',
            title: 'Nothing is favorited yet',
            text: 'Star a lesson in the Programming Library or a snippet in Code Snippets and it will appear here for quick access.',
            actions: [{ label: 'Browse library', onClick: () => navigate('/library') }],
          }));
          return;
        }

        if (!shown) {
          contentHost.appendChild(emptyState({
            iconName: 'search',
            title: 'No favorites match',
            text: 'Clear the search or switch the filter back to All to see everything you starred.',
            actions: [{
              label: 'Clear search',
              onClick: () => {
                state.q = '';
                searchInput.value = '';
                persist();
              },
            }],
          }));
          return;
        }

        if (filteredLessons.length) {
          contentHost.appendChild(section(
            'Lessons',
            `${filteredLessons.length} ${pluralize(filteredLessons.length, 'lesson')}`,
            filteredLessons.map((lesson) => lessonRow(lesson, langById, catById)),
          ));
        }
        if (filteredSnippets.length) {
          contentHost.appendChild(section(
            'Snippets',
            `${filteredSnippets.length} ${pluralize(filteredSnippets.length, 'snippet')}`,
            filteredSnippets.map(snippetRow),
          ));
        }
      } catch (err) {
        if (disposed) return;
        console.error('[favorites] render failed:', err);
        clear(contentHost);
        contentHost.appendChild(emptyState({
          iconName: 'alert',
          title: 'Favorites could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
        }));
      }
    }

    function showError(err) {
      console.error('[favorites] action failed:', err);
      toast(err?.message || 'That action failed', { tone: 'danger' });
    }

    /* --------------------------------------------------------------- state */

    function persist() {
      setQuery({
        q: state.q || null,
        type: state.type === 'all' ? null : state.type,
      });
    }

    /** Query-only route update (called by the router instead of remounting). */
    function onQuery(next) {
      state.q = next.q || '';
      state.type = ['lessons', 'snippets'].includes(next.type) ? next.type : 'all';
      if (searchInput.value !== state.q) searchInput.value = state.q;
      const radios = typeControl.querySelectorAll('input[type="radio"]');
      radios.forEach((radio) => { radio.checked = radio.value === state.type; });
      void render();
    }

    /* ------------------------------------------------------------ listeners */

    const onSearch = debounce(() => {
      state.q = searchInput.value.trim();
      persist();
    }, 220);
    searchInput.addEventListener('input', onSearch);

    const onData = debounce(() => void render(), 250);
    const offData = bus.on('data:changed', onData);

    void render();

    return {
      beforeLeave: async () => { onSearch.cancel?.(); },
      onQuery,
      destroy() {
        disposed = true;
        offData();
        onData.cancel?.();
        onSearch.cancel?.();
      },
      onShow() { void render(); },
    };
  },
};
