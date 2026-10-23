/**
 * snippets.js — the Code Snippet library: search, language filter, sorting,
 * bulk actions and the snippet editor dialog.
 *
 * Filter state lives in the URL (q/lang/sort/dir) so the view is linkable.
 * The router hands query-only changes back through onQuery(), which re-renders
 * in place instead of remounting — that is what keeps focus in the search box
 * (same pattern as library.js).
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate, setQuery } from '../router.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { toast } from '../components/toast.js';
import { openMenu } from '../components/menu.js';
import { openDialog, confirmDialog, promptDialog } from '../components/dialog.js';
import { emptyState, skeleton, inlineNote } from '../components/feedback.js';
import { snippetsRepo } from '../db/repositories/index.js';
import { parseQuery, scoreRecord, matchesFlags, segmentHighlight, applySort } from '../utils/search.js';
import { formatRelative, pluralize } from '../utils/format.js';
import { copyText } from '../utils/clipboard.js';
import { LIMITS } from '../utils/validate.js';

const PAGE_SIZE = 40;

function option(value, label, current) {
  return h('option', { value, text: label, attrs: value === current ? { selected: '' } : {} });
}

/** Build safe highlight nodes (search terms → <mark>, everything else → text). */
function highlightTitle(text, terms) {
  const spans = segmentHighlight(String(text ?? ''), terms);
  const frag = document.createDocumentFragment();
  for (const seg of spans) {
    if (seg.hit) frag.appendChild(h('mark', { text: seg.text }));
    else frag.appendChild(document.createTextNode(seg.text));
  }
  return frag;
}

/** Show/clear one inline field error inside the editor dialog. */
function setFieldError(errorEl, input, message) {
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

/** One labelled form row (label[for] + control + optional hint/error). */
function field(labelText, control, { hint = '', error = null } = {}) {
  return h('div', { class: 'field' }, [
    h('label', { class: 'field__label', attrs: { for: control.id }, text: labelText }),
    control,
    hint ? h('div', { class: 'field__hint', text: hint }) : null,
    error,
  ]);
}

export default {
  id: 'snippets',
  title: () => 'Code Snippets',
  breadcrumbs: () => [{ label: 'Code Snippets', path: '/snippets' }],

  mount(container, ctx) {
    ctx.setBreadcrumbs?.([{ label: 'Code Snippets', path: '/snippets' }]);
    const query = ctx.query;

    const SORTS = ['updated', 'name', 'created'];

    const state = {
      q: query.q || '',
      lang: query.lang || '',
      sort: SORTS.includes(query.sort) ? query.sort : 'updated',
      dir: query.dir === 'asc' ? 'asc' : 'desc',
      limit: PAGE_SIZE,
      selected: new Set(),
    };

    // Deep link from the lesson editor: /snippets?new=1&lesson=<id>.
    // `lesson` is read once at mount; `new` is consumed after the first load
    // so a plain refresh does not reopen the dialog forever.
    const linkedLessonId = typeof query.lesson === 'string' && query.lesson ? query.lesson : null;
    let pendingNew = query.new === '1';

    let snippets = [];
    let languageNames = [];
    let filtered = [];
    let disposed = false;

    /* ---------------------------------------------------------------- shell */

    const header = h('header', { class: 'page-header' }, [
      h('div', { class: 'page-header__title' }, [
        h('h1', { text: 'Code Snippets' }),
        h('p', { class: 'page-header__subtitle', id: 'snippets-count', text: 'Loading…' }),
      ]),
      h('div', { class: 'page-header__actions' }, [
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          on: { click: () => void openEditor(null) },
        }, [icon('plus'), 'New snippet']),
      ]),
    ]);

    const searchInput = h('input', {
      class: 'input',
      type: 'search',
      id: 'snippets-search',
      value: state.q,
      attrs: { placeholder: 'Search name, description, code, tags…', autocomplete: 'off' },
    });

    const langSelect = h('select', { class: 'select', id: 'snippets-lang', attrs: { 'aria-label': 'Filter by language' } });
    const sortSelect = h('select', { class: 'select', id: 'snippets-sort', attrs: { 'aria-label': 'Sort snippets' } }, [
      option('updated', 'Last updated', state.sort),
      option('name', 'Name (A–Z)', state.sort),
      option('created', 'Date created', state.sort),
    ]);

    const dirBtn = h('button', {
      class: 'btn btn--icon',
      type: 'button',
      attrs: {
        'aria-label': state.dir === 'asc' ? 'Sort ascending' : 'Sort descending',
        'data-tooltip': 'Toggle sort direction',
      },
      on: { click: () => { state.dir = state.dir === 'asc' ? 'desc' : 'asc'; persist(); } },
    }, [icon(state.dir === 'asc' ? 'chevronDown' : 'sort')]);

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
          state.limit = PAGE_SIZE;
          persist();
        },
      },
    }, [icon('x')]);

    const filterBar = h('div', { class: 'filter-bar' }, [
      h('label', { class: 'search-field', attrs: { for: 'snippets-search' } }, [
        h('span', { class: 'sr-only', text: 'Search snippets' }),
        h('span', { class: 'search-field__icon' }, [icon('search')]),
        searchInput,
        searchClear,
      ]),
      langSelect,
      h('span', { class: 'spacer' }),
      sortSelect,
      dirBtn,
      h('button', {
        class: 'btn btn--sm btn--ghost',
        type: 'button',
        text: 'Reset',
        on: {
          click: () => {
            Object.assign(state, {
              q: '', lang: '', sort: 'updated', dir: 'desc', limit: PAGE_SIZE, selected: new Set(),
            });
            searchInput.value = '';
            persist();
          },
        },
      }),
    ]);

    const listHost = h('div', { class: 'stack' }, [skeleton({ count: 3, variant: 'card' })]);
    const bulkHost = h('div');
    const root = h('div', { class: 'stack stack--lg' }, [
      header,
      filterBar,
      inlineNote('Tip: search matches name, description, code and tags — try  debounce tag:js  or  lang:javascript', 'info'),
      listHost,
      bulkHost,
    ]);

    container.appendChild(root);

    /* --------------------------------------------------------------- editor */

    /**
     * Open the create/edit dialog.
     * @param {object|null} snippet null → create mode
     */
    async function openEditor(snippet) {
      if (disposed) return;
      const editing = Boolean(snippet);
      let linked = editing ? (snippet.lessonId || null) : linkedLessonId;

      const nameError = h('div', { class: 'field__error', attrs: { role: 'alert' }, hidden: true });
      const codeError = h('div', { class: 'field__error', attrs: { role: 'alert' }, hidden: true });

      const nameInput = h('input', {
        class: 'input',
        type: 'text',
        id: 'snippet-editor-name',
        value: snippet?.name || '',
        attrs: { placeholder: 'e.g. Debounce helper', maxlength: String(LIMITS.title) },
      });
      const languageInput = h('input', {
        class: 'input',
        type: 'text',
        id: 'snippet-editor-language',
        value: snippet?.language || '',
        attrs: { list: 'snippet-editor-languages', placeholder: 'javascript', maxlength: '60' },
      });
      const languageList = h('datalist', { id: 'snippet-editor-languages' },
        languageNames.map((name) => h('option', { value: name })));
      const descriptionInput = h('textarea', {
        class: 'textarea',
        id: 'snippet-editor-description',
        rows: 2,
        value: snippet?.description || '',
        attrs: { placeholder: 'What is this snippet for? (optional)', maxlength: String(LIMITS.summary) },
      });
      const codeInput = h('textarea', {
        class: 'editor-textarea',
        id: 'snippet-editor-code',
        dataset: { wrap: 'on' },
        value: snippet?.code || '',
        attrs: { placeholder: 'Paste your code here…' },
      });
      const tagsInput = h('input', {
        class: 'input',
        type: 'text',
        id: 'snippet-editor-tags',
        value: (snippet?.tags || []).join(', '),
        attrs: { placeholder: 'arrays, utils, debounce' },
      });

      const linkHost = h('div', { class: 'row' });
      function renderLink() {
        clear(linkHost);
        if (!linked) {
          linkHost.appendChild(h('span', { class: 'text-muted', style: { fontSize: 'var(--fs-xs)' }, text: 'No lesson linked.' }));
          return;
        }
        linkHost.appendChild(h('span', { class: 'chip' }, [
          h('span', { text: 'Linked to lesson' }),
          h('button', {
            type: 'button',
            attrs: { 'aria-label': 'Clear linked lesson' },
            on: { click: () => { linked = null; renderLink(); } },
          }, [icon('x')]),
        ]));
      }
      renderLink();

      const body = h('div', { class: 'stack stack--sm' }, [
        field('Name', nameInput, { error: nameError }),
        field('Language', languageInput, { hint: 'Free text, e.g. javascript or sql' }),
        languageList,
        field('Description', descriptionInput),
        field('Code', codeInput, { error: codeError }),
        field('Tags', tagsInput, { hint: 'Comma-separated' }),
        h('div', { class: 'field' }, [h('span', { class: 'field__label', text: 'Linked lesson' }), linkHost]),
      ]);

      const validate = () => {
        if (!nameInput.value.trim()) {
          setFieldError(nameError, nameInput, 'Name is required');
          nameInput.focus();
          return false;
        }
        setFieldError(nameError, nameInput, '');
        if (!codeInput.value.trim()) {
          setFieldError(codeError, codeInput, 'Code is required');
          codeInput.focus();
          return false;
        }
        setFieldError(codeError, codeInput, '');
        return true;
      };

      let result;
      try {
        result = await openDialog({
          title: editing ? 'Edit snippet' : 'New snippet',
          body,
          size: 'wide',
          initialFocus: nameInput,
          actions: [
            { label: 'Cancel', value: null },
            {
              label: editing ? 'Save changes' : 'Create snippet',
              value: 'save',
              variant: 'primary',
              closeOnClick: false,
              onClick: (_event, submit) => { if (validate()) submit('save'); },
            },
          ],
        });
      } catch (err) {
        showError(err);
        return;
      }
      if (result !== 'save' || disposed) return;

      const payload = {
        name: nameInput.value.trim(),
        language: languageInput.value.trim(),
        description: descriptionInput.value.trim(),
        code: codeInput.value,
        tags: [...new Set(tagsInput.value.split(',').map((tag) => tag.trim()).filter(Boolean))],
        // normalizeSnippet() falls back to the existing lessonId for any
        // non-string value, so unlinking an existing link must send ''.
        lessonId: editing
          ? (linked || (snippet.lessonId ? '' : null))
          : linked,
      };

      try {
        if (editing) {
          await snippetsRepo.update(snippet.id, payload);
          toast('Snippet updated', { tone: 'success' });
        } else {
          await snippetsRepo.create(payload);
          toast('Snippet created', { tone: 'success' });
        }
        state.limit = Math.max(state.limit, PAGE_SIZE);
        void render();
      } catch (err) {
        showError(err);
      }
    }

    /* --------------------------------------------------------------- render */

    function rowMenu(anchor, snippet) {
      openMenu(anchor, [
        { label: 'Edit', icon: 'edit', onSelect: () => void openEditor(snippet) },
        {
          label: 'Copy code',
          icon: 'copy',
          onSelect: async () => {
            try {
              const ok = await copyText(snippet.code || '');
              toast(ok ? 'Copied' : 'Copy failed — select the code and copy manually', {
                tone: ok ? 'success' : 'danger',
              });
            } catch (err) { showError(err); }
          },
        },
        {
          label: snippet.favorite ? 'Remove favorite' : 'Add to favorites',
          icon: 'star',
          onSelect: () => void snippetsRepo.update(snippet.id, { favorite: !snippet.favorite }).catch(showError),
        },
        snippet.lessonId
          ? {
              label: 'Open linked lesson',
              icon: 'external',
              onSelect: () => navigate(`/lesson/${encodeURIComponent(snippet.lessonId)}`),
            }
          : { label: 'Open linked lesson', icon: 'external', disabled: true, hint: 'Not linked' },
        { separator: true },
        {
          label: 'Move to trash',
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            try {
              const ok = await confirmDialog({
                title: 'Move to trash?',
                message: `“${snippet.name}” will be recoverable from Trash.`,
                confirmLabel: 'Move to trash',
                danger: true,
              });
              if (!ok) return;
              await snippetsRepo.softDelete(snippet.id);
              state.selected.delete(snippet.id);
              toast('Snippet moved to trash', { tone: 'success' });
            } catch (err) { showError(err); }
          },
        },
      ], { align: 'end' });
    }

    function renderListRow(snippet) {
      const terms = parseQuery(state.q).text.split(/\s+/).filter(Boolean);

      const checkbox = h('input', {
        class: 'checkbox',
        type: 'checkbox',
        attrs: { 'aria-label': `Select ${snippet.name}`, ...(state.selected.has(snippet.id) ? { checked: '' } : {}) },
        on: {
          change: (event) => {
            if (event.target.checked) state.selected.add(snippet.id);
            else state.selected.delete(snippet.id);
            renderBulk();
          },
        },
      });

      const menuBtn = h('button', {
        class: 'icon-btn',
        type: 'button',
        attrs: { 'aria-label': `Actions for ${snippet.name}`, 'aria-haspopup': 'menu' },
        on: { click: (event) => rowMenu(event.currentTarget, snippet) },
      }, [icon('more')]);

      const meta = [
        snippet.language,
        snippet.description ? snippet.description.slice(0, 120) : '',
        formatRelative(snippet.updatedAt),
      ].filter(Boolean).join(' · ');

      return h('div', { class: 'list__row', dataset: { id: snippet.id } }, [
        checkbox,
        h('button', {
          class: 'list__row-main',
          type: 'button',
          on: { click: () => void openEditor(snippet) },
        }, [
          h('span', { class: 'list__row-title' }, [
            highlightTitle(snippet.name, terms),
            snippet.favorite ? h('span', { class: 'badge badge--favorite', text: '★' }) : null,
          ]),
          h('span', { class: 'list__row-sub' }, [
            h('span', { text: meta || 'No details yet' }),
            ...(snippet.tags || []).slice(0, 6).map((tag) => h('span', { class: 'chip', text: tag })),
          ]),
        ]),
        h('div', { class: 'list__row-actions' }, [menuBtn]),
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
          toast(`${label} applied to ${ids.length} ${pluralize(ids.length, 'snippet')}`, { tone: 'success' });
        } catch (err) { showError(err); }
        renderBulk();
        void render();
      };

      bulkHost.appendChild(
        h('div', { class: 'bulk-bar', attrs: { role: 'region', 'aria-label': 'Bulk actions' } }, [
          h('span', { class: 'bulk-bar__count', text: `${count} selected` }),

          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            on: {
              click: async () => {
                try {
                  const tag = await promptDialog({
                    title: 'Add a tag',
                    label: 'Tag',
                    hint: 'Added to every selected snippet (duplicates are skipped).',
                    confirmLabel: 'Add tag',
                  });
                  if (!tag) return;
                  await applyToSelected('Tag', async (id) => {
                    const snippet = await snippetsRepo.get(id);
                    const tags = [...new Set([...(snippet.tags || []), tag])];
                    await snippetsRepo.update(id, { tags });
                  });
                } catch (err) { showError(err); }
              },
            },
          }, [icon('tag'), 'Add tag']),

          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            attrs: { 'aria-haspopup': 'menu' },
            on: {
              click: (event) => openMenu(event.currentTarget, [
                { label: 'Clear language', onSelect: () => void applyToSelected('Language', (id) => snippetsRepo.update(id, { language: '' })) },
                ...languageNames.map((name) => ({
                  label: name,
                  onSelect: () => void applyToSelected('Language', (id) => snippetsRepo.update(id, { language: name })),
                })),
              ], { anchor: event.currentTarget }),
            },
          }, [icon('languages'), 'Language']),

          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            on: {
              click: () => void applyToSelected('Favorite', async (id) => {
                const snippet = await snippetsRepo.get(id);
                await snippetsRepo.update(id, { favorite: !snippet.favorite });
              }),
            },
          }, [icon('star'), 'Favorite']),

          h('button', {
            class: 'btn btn--sm btn--danger',
            type: 'button',
            on: {
              click: async () => {
                try {
                  const ok = await confirmDialog({
                    title: `Trash ${count} ${pluralize(count, 'snippet')}?`,
                    message: 'They stay recoverable in Trash until you purge them.',
                    confirmLabel: 'Move to trash',
                    danger: true,
                  });
                  if (!ok) return;
                  await applyToSelected('Trash', (id) => snippetsRepo.softDelete(id));
                } catch (err) { showError(err); }
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
        const all = await snippetsRepo.getAll();
        if (disposed) return;
        snippets = all;

        // Distinct snippet languages drive the filter and the editor datalist.
        languageNames = [...new Set(snippets.map((s) => s.language).filter(Boolean))]
          .sort((a, b) => a.localeCompare(b));
        // A language that came in through the URL keeps its own option so the
        // select always reflects the real filter — without leaking into the
        // datalist / bulk-language menu (those stay data driven).
        const filterNames = state.lang && !languageNames.includes(state.lang)
          ? [state.lang, ...languageNames]
          : languageNames;

        clear(langSelect);
        langSelect.appendChild(option('', 'All languages', state.lang));
        for (const name of filterNames) langSelect.appendChild(option(name, name, state.lang));
        langSelect.value = state.lang;
        sortSelect.value = state.sort;
        searchClear.hidden = !state.q;
        dirBtn.setAttribute('aria-label', state.dir === 'asc' ? 'Sort ascending' : 'Sort descending');
        clear(dirBtn);
        dirBtn.appendChild(icon(state.dir === 'asc' ? 'chevronDown' : 'sort'));

        filtered = computeFiltered();

        // Drop selections that are no longer visible.
        const visibleIds = new Set(filtered.map((snippet) => snippet.id));
        for (const id of [...state.selected]) if (!visibleIds.has(id)) state.selected.delete(id);

        const countLabel = document.getElementById('snippets-count');
        if (countLabel) {
          const total = snippets.length;
          countLabel.textContent = filtered.length === total
            ? `${total} ${pluralize(total, 'snippet')}`
            : `${filtered.length} of ${total} ${pluralize(total, 'snippet')}`;
        }

        clear(listHost);
        const visible = filtered.slice(0, state.limit);

        if (!filtered.length) {
          listHost.appendChild(snippets.length
            ? emptyState({
                iconName: 'search',
                title: 'No snippets match',
                text: 'Try fewer words or clear the language filter. The query syntax supports tag: and lang: too.',
                actions: [{
                  label: 'Clear filters',
                  onClick: () => {
                    Object.assign(state, { q: '', lang: '', limit: PAGE_SIZE });
                    searchInput.value = '';
                    persist();
                  },
                }],
              })
            : emptyState({
                iconName: 'snippet',
                title: 'No snippets yet',
                text: 'Save reusable code here — snippets stay local and can be linked to a lesson.',
                actions: [{ label: 'New snippet', variant: 'primary', onClick: () => void openEditor(null) }],
              }));
          renderBulk();
        } else {
          listHost.appendChild(h('div', { class: 'list' }, visible.map(renderListRow)));

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
        }

        // Deep link /snippets?new=1: open the create dialog exactly once.
        if (pendingNew) {
          pendingNew = false;
          void openEditor(null);
          setQuery({ new: null });
        }
      } catch (err) {
        if (disposed) return;
        console.error('[snippets] render failed:', err);
        clear(listHost);
        listHost.appendChild(emptyState({
          iconName: 'alert',
          title: 'Snippets could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
        }));
      }
    }

    function computeFiltered() {
      let list = snippets.map((snippet) => ({
        ...snippet,
        title: snippet.name,                      // applySort()'s key is `title`
        languageKey: (snippet.language || '').toLowerCase(),
        type: 'snippet',
        hasCode: Boolean(snippet.code),
      }));

      // Dropdown filter (exact snippet.language value, URL backed)
      if (state.lang) list = list.filter((snippet) => snippet.language === state.lang);

      // Search box (free text + query syntax: tag:, lang:, is:favorite …)
      const parsed = parseQuery(state.q);
      if (parsed.text || Object.keys(parsed.filters).length || parsed.tags.length) {
        list = list.filter((snippet) => {
          if (!matchesFlags(snippet, parsed)) return false;
          if (!parsed.text) return true;
          return scoreRecord(
            {
              title: snippet.name,
              summary: snippet.description,
              tags: snippet.tags,
              code: snippet.code,
              language: snippet.languageKey,
            },
            parsed.text,
          ) >= 0;
        });
      }

      const sortKey = state.sort === 'name' ? 'title' : state.sort;
      return applySort(list, sortKey, state.dir);
    }

    function showError(err) {
      console.error('[snippets] action failed:', err);
      toast(err?.message || 'That action failed', { tone: 'danger' });
    }

    /* --------------------------------------------------------------- state */

    function persist() {
      state.limit = Math.max(state.limit, PAGE_SIZE);
      // URL is the source of truth; the router calls onQuery() with the result.
      setQuery({
        q: state.q || null,
        lang: state.lang || null,
        sort: state.sort,
        dir: state.dir,
      });
    }

    /** Query-only route update (called by the router instead of remounting). */
    function onQuery(next) {
      state.q = next.q || '';
      state.lang = next.lang || '';
      state.sort = SORTS.includes(next.sort) ? next.sort : 'updated';
      state.dir = next.dir === 'asc' ? 'asc' : 'desc';
      if (searchInput.value !== state.q) searchInput.value = state.q;
      void render();
    }

    /* ------------------------------------------------------------ listeners */

    const onSearch = debounce(() => {
      state.q = searchInput.value.trim();
      state.limit = PAGE_SIZE;
      persist();
    }, 220);
    searchInput.addEventListener('input', onSearch);

    langSelect.addEventListener('change', () => { state.lang = langSelect.value; persist(); });
    sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; persist(); });

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
