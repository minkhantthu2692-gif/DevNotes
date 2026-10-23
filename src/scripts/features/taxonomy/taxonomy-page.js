/**
 * taxonomy-page.js — shared page factory for the taxonomy kinds
 * (languages, categories, courses).
 *
 * One implementation serves all three so behaviour (search, manual ordering,
 * usage-aware deletion, trashed view) cannot drift between pages. Standalone
 * pages pass queryPrefix:''; the categories page embeds two instances and
 * separates their URL params with the 'c' and 'k' prefixes.
 */

import { h, clear } from '../../utils/dom.js';
import { icon } from '../../utils/icons.js';
import { bus } from '../../utils/bus.js';
import { debounce } from '../../utils/debounce.js';
import { toast } from '../../components/toast.js';
import { openMenu } from '../../components/menu.js';
import { openDialog, confirmDialog, promptDialog } from '../../components/dialog.js';
import { emptyState, skeleton, errorState } from '../../components/feedback.js';
import {
  lessonsRepo, snippetsRepo, coursesRepo, ensureTaxonomy,
} from '../../db/repositories/index.js';
import { pluralize } from '../../utils/format.js';

const PAGE_SIZE = 50;

/** Language kinds carry a type; values must match normalizeTaxonomy exactly. */
const LANGUAGE_TYPES = [
  ['', 'Unset'],
  ['language', 'Language'],
  ['framework', 'Framework'],
  ['library', 'Library'],
  ['topic', 'Topic'],
];

/** kind → lesson/course field that references a record of that kind by id. */
const REF_FIELD = { language: 'languageId', category: 'categoryId', course: 'courseId' };

const byOrder = (a, b) =>
  ((a.order ?? 0) - (b.order ?? 0)) || ((a.createdAt ?? 0) - (b.createdAt ?? 0));

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * @param {object} config
 * @param {'language'|'category'|'course'} config.kind
 * @param {object} config.repo repository (languagesRepo/categoriesRepo/coursesRepo)
 * @param {string} config.title page/section title
 * @param {string} [config.subtitle]
 * @param {string} [config.plural] plural used in counts ('languages', …)
 * @param {string} [config.icon] icon name for the empty state
 * @param {string} [config.emptyTitle]
 * @param {string} [config.emptyText]
 * @param {string} [config.descriptionPlaceholder]
 * @param {string} [config.queryPrefix] URL-param prefix ('' standalone, 'c'/'k' embedded)
 * @param {boolean} [config.embedded] skip page header + breadcrumbs (host page owns them)
 * @returns {{id: string, title: Function, mount: Function}}
 */
export function createTaxonomyPage(config) {
  const {
    kind, repo, title, subtitle = '', plural = `${kind}s`, icon: emptyIcon = 'tag',
    emptyTitle = `No ${plural} yet`, emptyText = '', descriptionPlaceholder = '',
    queryPrefix = '', embedded = false,
  } = config;

  const qKey = `${queryPrefix}q`;
  const trashKey = `${queryPrefix}trashed`;
  const uid = `tax-${queryPrefix || kind}`;

  return {
    id: kind === 'language' ? 'languages' : `${kind}s`,
    title: () => title,

    mount(container, ctx) {
      const state = {
        q: ctx.query[qKey] || '',
        trashed: ctx.query[trashKey] === '1',
        limit: PAGE_SIZE,
      };

      let records = [];      // full (sorted, filtered-by-toggle) list
      let usageById = new Map();
      let disposed = false;

      if (!embedded) {
        ctx.setBreadcrumbs?.([{ label: title, path: `/${kind === 'language' ? 'languages' : kind === 'category' ? 'categories' : 'courses'}` }]);
      }

      /* ------------------------------------------------------------- shell */

      const countLine = h('p', { class: 'meta-line', id: `${uid}-count`, text: 'Loading…' });

      const newButton = h('button', {
        class: 'btn btn--primary btn--sm',
        type: 'button',
        on: { click: () => void onNew() },
      }, [icon('plus'), `New ${kind}`]);

      const header = embedded
        ? null
        : h('header', { class: 'page-header' }, [
            h('div', { class: 'page-header__title' }, [
              h('h1', { text: title }),
              subtitle ? h('p', { class: 'page-header__subtitle', text: subtitle }) : null,
              countLine,
            ]),
            h('div', { class: 'page-header__actions' }, [newButton]),
          ]);

      const searchInput = h('input', {
        class: 'input',
        type: 'search',
        id: `${uid}-search`,
        value: state.q,
        attrs: { placeholder: `Search ${plural}…`, autocomplete: 'off' },
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

      const trashedToggle = h('label', { class: 'switch', attrs: { title: `Show trashed ${plural}` } }, [
        h('input', {
          type: 'checkbox',
          attrs: state.trashed ? { checked: '' } : {},
          on: {
            change: (event) => {
              state.trashed = event.target.checked;
              state.limit = PAGE_SIZE;
              persist();
            },
          },
        }),
        h('span', { class: 'switch__track' }),
        h('span', { text: 'Trashed' }),
      ]);

      const filterBar = h('div', { class: 'filter-bar' }, [
        h('label', { class: 'search-field', attrs: { for: `${uid}-search` } }, [
          h('span', { class: 'sr-only', text: `Search ${plural}` }),
          h('span', { class: 'search-field__icon' }, [icon('search')]),
          searchInput,
          searchClear,
        ]),
        trashedToggle,
        h('span', { class: 'spacer' }),
        embedded ? newButton : null,
      ]);

      const listHost = h('div', { class: 'stack stack--sm' }, [skeleton({ count: 3, variant: 'card' })]);
      const root = h('div', { class: 'stack' }, [header, filterBar, listHost]);
      container.appendChild(root);

      /* ----------------------------------------------------------- helpers */

      function showError(err) {
        console.error(`[taxonomy:${kind}] action failed:`, err);
        toast(err?.message || 'That action failed', { tone: 'danger' });
      }

      function persist() {
        state.limit = Math.max(state.limit, PAGE_SIZE);
        // URL is the source of truth; the router feeds the change back via onQuery.
        ctx.setQuery({
          [qKey]: state.q || null,
          [trashKey]: state.trashed ? '1' : null,
        });
      }

      /**
       * Usage counts per record: lessons referencing the id via the kind's
       * field, snippets referencing a language by free-text name, and courses
       * referencing a language/category by id (best effort — see report note
       * on normalizeTaxonomy dropping those course fields).
       */
      async function loadUsage(list) {
        const field = REF_FIELD[kind];
        const usage = new Map(list.map((record) => [record.id, { lessons: 0, snippets: 0, courses: 0 }]));

        const lessons = await lessonsRepo.getAll();
        for (const lesson of lessons) {
          const bucket = usage.get(lesson[field]);
          if (bucket) bucket.lessons += 1;
        }

        if (kind === 'language') {
          const snippets = await snippetsRepo.getAll();
          const byName = new Map(list.map((record) => [record.name.trim().toLowerCase(), usage.get(record.id)]));
          for (const snippet of snippets) {
            const bucket = byName.get(String(snippet.language ?? '').trim().toLowerCase());
            if (bucket) bucket.snippets += 1;
          }
        } else if (kind !== 'course') {
          const linked = await coursesRepo.getAll();
          for (const course of linked) {
            const bucket = usage.get(course[field]);
            if (bucket) bucket.courses += 1;
          }
        }

        return usage;
      }

      const usageTotal = (counts) => counts.lessons + counts.snippets + counts.courses;

      function describeUsage(counts) {
        const parts = [];
        if (counts.lessons) parts.push(pluralize(counts.lessons, 'lesson'));
        if (counts.snippets) parts.push(pluralize(counts.snippets, 'snippet'));
        if (counts.courses) parts.push(pluralize(counts.courses, 'course'));
        return parts.join(', ');
      }

      /* ------------------------------------------------------------ actions */

      async function onNew() {
        const name = await promptDialog({
          title: `New ${kind}`,
          label: 'Name',
          placeholder: `e.g. ${kind === 'language' ? 'Rust' : kind === 'category' ? 'Algorithms' : 'Course name'}`,
          hint: `Existing ${plural} with the same name are reused instead of duplicated.`,
          confirmLabel: 'Add',
        });
        if (!name) return;
        try {
          const record = await ensureTaxonomy(kind, name);
          toast(`“${record.name}” added`, { tone: 'success' });
          void render();
        } catch (err) { showError(err); }
      }

      async function onEdit(record) {
        const nameInput = h('input', {
          class: 'input',
          type: 'text',
          value: record.name,
          attrs: { id: `${uid}-edit-name`, maxlength: '120' },
        });
        const descriptionInput = h('textarea', {
          class: 'input',
          id: `${uid}-edit-description`,
          text: record.description || '',
          attrs: { rows: '3', maxlength: '1000', placeholder: descriptionPlaceholder },
        });
        // The type select (language kind only) includes the '' "Unset" option;
        // normalizeTaxonomy persists '' for languages, so it round-trips.
        const typeSelect = kind === 'language'
          ? h('select', { class: 'select', id: `${uid}-edit-type` },
              LANGUAGE_TYPES.map(([value, label]) =>
                h('option', {
                  value,
                  text: label,
                  attrs: (record.type || '') === value ? { selected: '' } : {},
                })))
          : null;
        const errorLine = h('div', { class: 'field__error', attrs: { role: 'alert' }, hidden: true });

        const field = (labelText, control) =>
          h('div', { class: 'field' }, [
            h('label', { class: 'field__label', attrs: { for: control.id }, text: labelText }),
            control,
          ]);

        const body = h('div', { class: 'stack' }, [
          field('Name', nameInput),
          typeSelect ? field('Type', typeSelect) : null,
          field('Description', descriptionInput),
          errorLine,
        ]);

        await openDialog({
          title: `Edit ${kind}`,
          body,
          size: 'wide',
          initialFocus: nameInput,
          actions: [
            { label: 'Cancel', value: null },
            {
              label: 'Save',
              value: 'submit',
              variant: 'primary',
              closeOnClick: false,
              onClick: async (_event, close) => {
                const name = nameInput.value.trim();
                if (!name) {
                  errorLine.textContent = `${capitalize(kind)} name is required`;
                  errorLine.hidden = false;
                  nameInput.setAttribute('aria-invalid', 'true');
                  nameInput.focus();
                  return;
                }
                nameInput.setAttribute('aria-invalid', 'false');
                const patch = { name, description: descriptionInput.value.trim() };
                if (typeSelect) patch.type = typeSelect.value;
                try {
                  await repo.update(record.id, patch);
                  close('submit');
                  toast('Saved', { tone: 'success' });
                  void render();
                } catch (err) {
                  errorLine.textContent = err?.message || 'Saving failed';
                  errorLine.hidden = false;
                }
              },
            },
          ],
        });
      }

      async function onMove(record, delta) {
        const index = records.findIndex((item) => item.id === record.id);
        const target = records[index + delta];
        if (index === -1 || !target) return;
        try {
          // Re-stamp contiguous positions for the swapped pair so ordering
          // drift from earlier edits heals as the user reorders.
          await repo.update(record.id, { order: (index + delta + 1) * 1000 });
          await repo.update(target.id, { order: (index + 1) * 1000 });
        } catch (err) { showError(err); }
      }

      async function onDelete(record, counts) {
        if (usageTotal(counts) > 0) {
          // Honest block: clearing foreign keys on many records from a list
          // page is too easy to regret, so deletion stays off until usage is 0.
          await openDialog({
            title: `“${record.name}” is still in use`,
            body: h('div', { class: 'stack stack--sm' }, [
              h('p', { text: `${capitalize(kind)} deletion is blocked while items still reference it.` }),
              h('p', { text: `Still using it: ${describeUsage(counts)}. Those items keep working; remove or change their ${kind} first to delete this entry.` }),
            ]),
            actions: [{ label: 'OK', value: true, variant: 'primary' }],
          });
          return;
        }
        const ok = await confirmDialog({
          title: `Delete “${record.name}”?`,
          message: `The ${kind} moves to Trash and can be restored from there.`,
          confirmLabel: 'Move to trash',
          danger: true,
        });
        if (!ok) return;
        try {
          await repo.softDelete(record.id);
          toast(`${capitalize(kind)} moved to trash`, { tone: 'success' });
        } catch (err) { showError(err); }
      }

      async function onRestore(record) {
        try {
          await repo.restore(record.id);
          toast('Restored', { tone: 'success' });
        } catch (err) { showError(err); }
      }

      async function onPurge(record) {
        const ok = await confirmDialog({
          title: `Permanently delete “${record.name}”?`,
          message: 'This cannot be recovered.',
          confirmLabel: 'Delete forever',
          danger: true,
        });
        if (!ok) return;
        try {
          await repo.purge(record.id);
          toast(`${capitalize(kind)} deleted permanently`, { tone: 'success' });
        } catch (err) { showError(err); }
      }

      /* ------------------------------------------------------------ rendering */

      function rowMenu(anchor, record, counts, isLast) {
        const items = state.trashed
          ? [
              { label: 'Restore', icon: 'restore', onSelect: () => void onRestore(record) },
              { separator: true },
              { label: 'Delete permanently', icon: 'trash', danger: true, onSelect: () => void onPurge(record) },
            ]
          : [
              { label: 'Edit', icon: 'edit', onSelect: () => void onEdit(record) },
              { separator: true },
              {
                label: 'Move up',
                disabled: records[0]?.id === record.id,
                onSelect: () => void onMove(record, -1),
              },
              {
                label: 'Move down',
                disabled: isLast,
                onSelect: () => void onMove(record, 1),
              },
              { separator: true },
              { label: 'Move to trash', icon: 'trash', danger: true, onSelect: () => void onDelete(record, counts) },
            ];
        openMenu(anchor, items, { anchor });
      }

      function renderRow(record, isLast) {
        const counts = usageById.get(record.id) || { lessons: 0, snippets: 0, courses: 0 };
        const subParts = [record.slug];
        if (record.description) subParts.push(String(record.description).slice(0, 100));
        subParts.push(usageTotal(counts) ? describeUsage(counts) : 'Not used yet');

        const menuBtn = h('button', {
          class: 'icon-btn',
          type: 'button',
          attrs: { 'aria-label': `Actions for ${record.name}`, 'aria-haspopup': 'menu' },
          on: { click: (event) => rowMenu(event.currentTarget, record, counts, isLast) },
        }, [icon('more')]);

        return h('div', { class: 'list__row', dataset: { id: record.id } }, [
          h('div', { class: 'list__row-main' }, [
            h('span', { class: 'list__row-title' }, [
              record.name,
              record.trashed ? h('span', { class: 'badge badge--danger', text: 'Trashed' }) : null,
              kind === 'language' && record.type && record.type !== 'language'
                ? h('span', { class: 'badge badge--info', text: record.type })
                : null,
            ]),
            h('span', { class: 'list__row-sub', text: subParts.join(' · ') }),
          ]),
          h('div', { class: 'list__row-actions' }, [menuBtn]),
        ]);
      }

      async function render() {
        if (disposed) return;
        try {
          const fetched = state.trashed
            ? await repo.getAll({ onlyTrashed: true })
            : await repo.getAll();
          if (disposed) return;

          records = fetched.sort(byOrder);
          usageById = state.trashed ? new Map() : await loadUsage(records);
          if (disposed) return;

          const filtered = state.q
            ? records.filter((record) => {
                const needle = state.q.toLowerCase();
                return record.name.toLowerCase().includes(needle)
                  || String(record.description ?? '').toLowerCase().includes(needle);
              })
            : records;

          if (countLine) {
            const base = pluralize(filtered.length, kind, plural);
            const totalLabel = filtered.length === records.length ? '' : ` of ${pluralize(records.length, kind, plural)}`;
            countLine.textContent = state.trashed
              ? `Trashed · ${base}${totalLabel}`
              : `${base}${totalLabel}`;
          }
          searchClear.hidden = !state.q;

          clear(listHost);

          if (!filtered.length) {
            listHost.appendChild(records.length
              ? emptyState({
                  iconName: 'search',
                  title: `No ${plural} match`,
                  text: 'Try fewer words or clear the search.',
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
                  iconName: emptyIcon,
                  title: emptyTitle,
                  text: emptyText,
                  actions: [{ label: `Create the first ${kind}`, variant: 'primary', onClick: () => void onNew() }],
                }));
            return;
          }

          const visible = filtered.slice(0, state.limit);
          listHost.appendChild(h('div', { class: 'list' },
            visible.map((record, index) => renderRow(record, index === visible.length - 1))));

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
        } catch (err) {
          if (disposed) return;
          console.error(`[taxonomy:${kind}] render failed:`, err);
          clear(listHost);
          listHost.appendChild(errorState({
            title: `${title} could not load`,
            message: String(err?.message || err),
            retry: { label: 'Try again', onClick: () => void render() },
          }));
        }
      }

      /* ----------------------------------------------------------- listeners */

      const onSearch = debounce(() => {
        const next = searchInput.value.trim();
        if (next === state.q) return;
        state.q = next;
        state.limit = PAGE_SIZE;
        persist();
      }, 220);
      searchInput.addEventListener('input', onSearch);

      const reload = debounce(() => void render(), 250);
      const offData = bus.on('data:changed', reload);

      void render();

      return {
        onQuery(next) {
          state.q = next[qKey] || '';
          state.trashed = next[trashKey] === '1';
          if (searchInput.value !== state.q) searchInput.value = state.q;
          const toggleInput = trashedToggle.querySelector('input');
          if (toggleInput) toggleInput.checked = state.trashed;
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
}
