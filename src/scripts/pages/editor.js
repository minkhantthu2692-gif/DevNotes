/**
 * editor.js — lesson editor with autosave, live Markdown preview, taxonomy
 * pickers, revision history and linked snippets/cards.
 *
 * Persistence rules:
 *  - Existing lessons save through lessonsRepo.update() on a debounce
 *    (prefs.autosaveDelay); Ctrl/Cmd+S saves immediately.
 *  - "new" is a draft until it has real content: the record is created on the
 *    first save-worthy input and the URL is rewritten in place (no remount,
 *    caret stays where it is). An untitled, empty draft is never persisted.
 *  - beforeLeave flushes pending changes so navigation never drops work.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';
import { routeStore } from '../state.js';
import { debounce } from '../utils/debounce.js';
import { shortcut } from '../utils/keyboard.js';
import { toast } from '../components/toast.js';
import { openMenu } from '../components/menu.js';
import { openDialog, confirmDialog, promptDialog } from '../components/dialog.js';
import { emptyState, inlineNote, errorState } from '../components/feedback.js';
import {
  lessonsRepo, snippetsRepo, flashcardsRepo,
  languagesRepo, categoriesRepo, coursesRepo,
  ensureTaxonomy, revisions,
} from '../db/repositories/index.js';
import { renderMarkdown } from '../utils/markdown.js';
import { hydrateCodeBlocks } from '../components/code-block.js';
import { getPrefs, savePrefs } from '../features/settings/prefs.js';
import { LESSON_STATUSES, DIFFICULTIES, sanitizeUrl } from '../utils/validate.js';
import { formatDateTime, formatRelative, countWords } from '../utils/format.js';

const STATUS_LABEL = {
  'not-started': 'Not started',
  learning: 'Learning',
  learned: 'Learned',
};

function toLocalInput(ts) {
  if (!ts) return '';
  const date = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function fromLocalInput(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function field(label, control, hint = '') {
  return h('label', { class: 'field' }, [
    h('span', { class: 'field__label', text: label }),
    control,
    hint ? h('span', { class: 'field__hint', text: hint }) : null,
  ]);
}

export default {
  id: 'editor',
  title: (params) => (params.id === 'new' ? 'New lesson' : 'Lesson'),

  mount(container, ctx) {
    const prefs = getPrefs();
    const requestedId = ctx.params.id;
    const isNewDraft = requestedId === 'new';
    ctx.setBreadcrumbs?.([
      { label: 'Library', path: '/library' },
      { label: isNewDraft ? 'New lesson' : 'Lesson', path: `/lesson/${encodeURIComponent(requestedId)}` },
    ]);

    const root = h('div', { class: 'stack' });
    container.appendChild(root);
    root.appendChild(inlineNote('Loading lesson…', 'info'));

    let disposed = false;
    let lessonId = isNewDraft ? null : requestedId;
    let lesson = null;
    let dirty = false;
    let saving = false;
    let queuedSave = false;
    let createdAtDraft = false;

    /* ------------------------------------------------------------ form refs */

    const titleInput = h('input', {
      class: 'editor-title-input',
      type: 'text',
      attrs: { placeholder: 'Lesson title', 'aria-label': 'Lesson title', maxlength: '200', spellcheck: 'true' },
    });
    const titleError = h('div', { class: 'field__error', attrs: { role: 'alert' }, hidden: true });

    const summaryInput = h('textarea', {
      class: 'textarea',
      attrs: { rows: '2', placeholder: 'One-paragraph summary (optional)', 'aria-label': 'Summary', maxlength: '2000' },
    });
    const contentArea = h('textarea', {
      class: 'editor-textarea',
      attrs: { placeholder: 'Write Markdown…\n\n```js\n// code blocks are highlighted and copyable\n```', 'aria-label': 'Lesson content (Markdown)', spellcheck: 'true' },
      dataset: { wrap: prefs.wordWrap ? 'on' : 'off' },
    });
    const notesArea = h('textarea', {
      class: 'textarea',
      attrs: { rows: '3', placeholder: 'Private notes (optional)', 'aria-label': 'Notes', maxlength: '50000' },
    });

    const statusSelect = h('select', { class: 'select', attrs: { 'aria-label': 'Learning status' } },
      LESSON_STATUSES.map((s) => h('option', { value: s, text: STATUS_LABEL[s] })));
    const difficultySelect = h('select', { class: 'select', attrs: { 'aria-label': 'Difficulty' } }, [
      h('option', { value: '', text: 'Not set' }),
      ...DIFFICULTIES.map((d) => h('option', { value: d, text: d[0].toUpperCase() + d.slice(1) })),
    ]);
    const languageSelect = h('select', { class: 'select', attrs: { 'aria-label': 'Language' } });
    const categorySelect = h('select', { class: 'select', attrs: { 'aria-label': 'Category' } });
    const courseSelect = h('select', { class: 'select', attrs: { 'aria-label': 'Course' } });

    const reviewInput = h('input', { class: 'input', type: 'datetime-local', attrs: { 'aria-label': 'Review date' } });

    const tagHost = h('div', { class: 'tag-picker' });
    const tagInput = h('input', {
      class: 'input',
      type: 'text',
      attrs: { placeholder: 'Add tag + Enter', 'aria-label': 'Add tag', maxlength: '48' },
    });

    const sourceHost = h('div', { class: 'stack stack--sm' });
    const relatedHost = h('div', { class: 'stack stack--sm' });

    const autosaveEl = h('span', { class: 'autosave-state', dataset: { state: 'idle' } }, [
      h('span', { text: isNewDraft ? 'Draft — not saved yet' : 'Saved' }),
    ]);

    const previewEl = h('div', { class: 'editor-preview markdown-body', attrs: { 'aria-label': 'Preview' } });
    const sourceEl = h('div', { class: 'editor-source' }, [
      field('Summary', summaryInput),
      field('Content (Markdown)', contentArea),
      field('Notes', notesArea),
    ]);

    const splitEl = h('div', { class: 'editor-split' }, [sourceEl, previewEl]);

    /* ----------------------------------------------------------- mode state */

    let mode = ['split', 'edit', 'preview'].includes(prefs.editorMode) ? prefs.editorMode : 'split';

    const modeGroup = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': 'Editor mode' } },
      [['edit', 'Edit'], ['split', 'Split'], ['preview', 'Preview']].map(([value, label]) =>
        h('label', { class: 'segmented__option' }, [
          h('input', {
            type: 'radio',
            name: 'editor-mode',
            value,
            attrs: mode === value ? { checked: '' } : {},
            on: {
              change: () => {
                mode = value;
                applyMode();
                void savePrefs({ editorMode: value }).catch(() => { /* pref only */ });
              },
            },
          }),
          h('span', { text: label }),
        ]),
      ),
    );

    function applyMode() {
      splitEl.dataset.mode = mode;
    }

    const wrapBtn = h('button', {
      class: 'icon-btn',
      type: 'button',
      attrs: { 'aria-pressed': String(Boolean(prefs.wordWrap)), 'aria-label': 'Toggle word wrap in the editor', 'data-tooltip': 'Word wrap' },
      on: {
        click: () => {
          const next = contentArea.dataset.wrap !== 'on';
          contentArea.dataset.wrap = next ? 'on' : 'off';
          wrapBtn.setAttribute('aria-pressed', String(next));
          void savePrefs({ wordWrap: next }).catch(() => { /* pref only */ });
        },
      },
    }, [icon('wrapText')]);

    const linesBtn = h('button', {
      class: 'icon-btn',
      type: 'button',
      attrs: { 'aria-pressed': String(Boolean(prefs.lineNumbers)), 'aria-label': 'Toggle code line numbers in previews', 'data-tooltip': 'Line numbers in code' },
      on: {
        click: () => {
          const next = !linesBtn.getAttribute('aria-pressed').includes('true');
          linesBtn.setAttribute('aria-pressed', String(next));
          applyCodeDefaults();
          void savePrefs({ lineNumbers: next }).catch(() => { /* pref only */ });
        },
      },
    }, [icon('lineNumbers')]);

    const saveBtn = h('button', {
      class: 'btn btn--sm btn--primary',
      type: 'button',
      on: { click: () => void save({ force: true }) },
    }, [icon('save'), 'Save']);

    const menuBtn = h('button', {
      class: 'icon-btn',
      type: 'button',
      attrs: { 'aria-label': 'Lesson actions', 'aria-haspopup': 'menu' },
      on: { click: (event) => openLessonMenu(event.currentTarget) },
    }, [icon('more')]);

    const toolbar = h('div', { class: 'editor__toolbar' }, [
      h('button', {
        class: 'btn btn--sm btn--ghost',
        type: 'button',
        on: { click: () => navigate('/library') },
      }, [icon('chevronLeft'), 'Library']),
      h('span', { class: 'divider', attrs: { 'aria-hidden': 'true' } }),
      modeGroup,
      h('span', { class: 'divider', attrs: { 'aria-hidden': 'true' } }),
      wrapBtn,
      linesBtn,
      h('span', { class: 'divider', attrs: { 'aria-hidden': 'true' } }),
      autosaveEl,
      h('span', { style: { marginLeft: 'auto' }, class: 'row gap-1' }, [saveBtn, menuBtn]),
    ]);

    /* ------------------------------------------------------------- side meta */

    const metaPanel = h('div', { class: 'meta-section' }, [
      h('div', { class: 'meta-section__title', text: 'Classification' }),
      field('Language', h('div', { class: 'row gap-2' }, [languageSelect, quickAddButton('language', languageSelect)])),
      field('Category', h('div', { class: 'row gap-2' }, [categorySelect, quickAddButton('category', categorySelect)])),
      field('Course', h('div', { class: 'row gap-2' }, [courseSelect, quickAddButton('course', courseSelect)])),
      field('Status', statusSelect),
      field('Difficulty', difficultySelect),
      field('Review date', reviewInput, 'When this lesson should come back up for review.'),
    ]);

    const tagsPanel = h('div', { class: 'meta-section' }, [
      h('div', { class: 'meta-section__title', text: 'Tags' }),
      tagHost,
      tagInput,
    ]);

    const sourcesPanel = h('div', { class: 'meta-section' }, [
      h('div', { class: 'meta-section__title', text: 'Sources' }),
      sourceHost,
      h('button', {
        class: 'btn btn--sm',
        type: 'button',
        on: {
          click: async () => {
            const url = await promptDialog({
              title: 'Add a source link',
              label: 'URL',
              placeholder: 'https://…',
              confirmLabel: 'Add',
              validate: (value) => (sanitizeUrl(value) ? '' : 'Enter a valid http:// or https:// URL'),
            });
            if (!url) return;
            const sources = readForm().sourceUrls;
            if (sources.includes(url)) return;
            await applyPatch({ sourceUrls: [...sources, url] });
          },
        },
      }, [icon('plus'), 'Add source']),
    ]);

    const relatedPanel = h('div', { class: 'meta-section' }, [
      h('div', { class: 'meta-section__title', text: 'Linked items' }),
      relatedHost,
    ]);

    const sideEl = h('div', { class: 'editor-side' }, [metaPanel, tagsPanel, sourcesPanel, relatedPanel]);

    const shell = h('div', { class: 'editor-shell' }, [
      h('div', { class: 'editor-main' }, [toolbar, h('div', { class: 'stack' }, [titleInput, titleError]), splitEl]),
      sideEl,
    ]);

    /* ----------------------------------------------------------- form logic */

    function quickAddButton(kind, select) {
      return h('button', {
        class: 'icon-btn',
        type: 'button',
        attrs: { 'aria-label': `New ${kind}`, 'data-tooltip': `New ${kind}` },
        on: {
          click: async () => {
            const name = await promptDialog({
              title: `New ${kind}`,
              label: 'Name',
              confirmLabel: 'Create',
              validate: (value) => (value.trim() ? '' : 'A name is required'),
            });
            if (!name) return;
            try {
              const record = await ensureTaxonomy(kind, name.trim());
              await refreshTaxonomy();
              const select = kind === 'language' ? languageSelect
                : kind === 'category' ? categorySelect : courseSelect;
              select.value = record.id;
              markDirty();
            } catch (err) {
              toast(err?.message || `Could not create the ${kind}`, { tone: 'danger' });
            }
          },
        },
      }, [icon('plus')]);
    }

    /** Rebuild the taxonomy selects, preserving the current selections. */
    async function refreshTaxonomy() {
      const [languages, categories, courses] = await Promise.all([
        languagesRepo.getAll(), categoriesRepo.getAll(), coursesRepo.getAll(),
      ]);
      const fill = (select, placeholder, records) => {
        const keep = select.value;
        clear(select);
        select.appendChild(h('option', { value: '', text: placeholder }));
        for (const record of records) {
          select.appendChild(h('option', { value: record.id, text: record.name }));
        }
        select.value = keep; // '' when no option matches
      };
      fill(languageSelect, 'No language', languages);
      fill(categorySelect, 'No category', categories);
      fill(courseSelect, 'No course', courses);
      return { languages, categories, courses };
    }

    function readForm() {
      return {
        title: titleInput.value.trimEnd(),
        summary: summaryInput.value.trimEnd(),
        content: contentArea.value,
        notes: notesArea.value,
        status: statusSelect.value,
        difficulty: difficultySelect.value,
        languageId: languageSelect.value || null,
        categoryId: categorySelect.value || null,
        courseId: courseSelect.value || null,
        reviewAt: fromLocalInput(reviewInput.value),
        sourceUrls: lesson?.sourceUrls || [],
        tags: lesson?.tags || [],
        favorite: Boolean(lesson?.favorite),
        pinned: Boolean(lesson?.pinned),
        archived: Boolean(lesson?.archived),
      };
    }

    function setAutosave(state, text) {
      autosaveEl.dataset.state = state;
      clear(autosaveEl);
      if (state === 'saving') autosaveEl.appendChild(icon('refresh'));
      else if (state === 'saved') autosaveEl.appendChild(icon('check'));
      else if (state === 'error') autosaveEl.appendChild(icon('alert'));
      autosaveEl.appendChild(h('span', { text }));
    }

    function markDirty() {
      dirty = true;
      setAutosave('dirty', 'Unsaved changes…');
      scheduleSave();
    }

    async function applyPatch(patch) {
      if (!lessonId) {
        // Draft: merge into the in-memory lesson and try to create.
        lesson = { ...(lesson || {}), ...patch };
        markDirty();
        await save({ force: true });
        return;
      }
      try {
        lesson = await lessonsRepo.update(lessonId, patch);
        dirty = false;
        const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setAutosave('saved', `Saved ${time}`);
        renderRelated();
      } catch (err) {
        console.error('[editor] update failed:', err);
        setAutosave('error', 'Save failed');
        toast(err?.message || 'Could not save the lesson', { tone: 'danger' });
      }
    }

    async function save({ force = false } = {}) {
      if (!force && disposed) return;
      if (saving) { queuedSave = true; return; }
      saving = true;
      setAutosave('saving', 'Saving…');
      try {
        const patch = readForm();
        const meaningful = patch.content.trim() || patch.summary.trim() || patch.tags.length || patch.sourceUrls.length;

        if (!patch.title) {
          if (!lessonId && !meaningful) {
            // Nothing worth persisting yet.
            dirty = false;
            setAutosave('idle', 'Draft — add a title to save');
            return;
          }
          if (lessonId) {
            // Existing lesson: title is required — surface it inline, don't fail silently.
            titleError.hidden = false;
            titleError.textContent = 'A title is required — your other changes are kept.';
            titleInput.setAttribute('aria-invalid', 'true');
            setAutosave('error', 'Title required');
            return;
          }
          // New draft with content but no title: keep the work with a clear default.
          patch.title = 'Untitled lesson';
          titleInput.value = patch.title;
          titleError.hidden = false;
          titleError.textContent = 'Saved with the placeholder title “Untitled lesson” — rename it any time.';
          titleInput.setAttribute('aria-invalid', 'true');
        } else {
          titleError.hidden = true;
          titleInput.removeAttribute('aria-invalid');
        }

        if (!lessonId) {
          lesson = await lessonsRepo.create(patch);
          lessonId = lesson.id;
          createdAtDraft = true;
          // Rewrite the URL in place: history.replaceState fires no hashchange,
          // so the editor keeps focus and the caret position.
          history.replaceState(null, '', `#/lesson/${encodeURIComponent(lessonId)}`);
          routeStore.set({ params: { id: lessonId } });
          ctx.setBreadcrumbs?.([
            { label: 'Library', path: '/library' },
            { label: lesson.title, path: `/lesson/${encodeURIComponent(lessonId)}` },
          ]);
        } else {
          lesson = await lessonsRepo.update(lessonId, patch);
        }

        dirty = false;
        const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setAutosave('saved', `Saved ${time}`);
        renderSources();
        renderRelated();
        if (createdAtDraft) {
          createdAtDraft = false;
          // The router sets document.title synchronously right after mount, so
          // the real title is applied one tick later (guarded to this page).
          setTimeout(() => {
            if (document.contains(container)) document.title = `${lesson.title} · DevNotes`;
          }, 0);
        }
      } catch (err) {
        console.error('[editor] save failed:', err);
        setAutosave('error', 'Save failed');
        toast(err?.message || 'Could not save the lesson', { tone: 'danger' });
      } finally {
        saving = false;
        if (queuedSave) { queuedSave = false; if (!disposed) void save(); }
      }
    }

    const scheduleSave = debounce(() => { void save(); }, Math.max(300, prefs.autosaveDelay || 900));

    /* -------------------------------------------------------------- preview */

    async function renderPreview() {
      if (disposed) return;
      try {
        const html = await renderMarkdown(contentArea.value, {});
        if (disposed) return;
        previewEl.innerHTML = html || '<p class="text-muted">Nothing to preview yet.</p>';
        applyCodeDefaults();
        hydrateCodeBlocks(previewEl);
      } catch (err) {
        console.error('[editor] preview failed:', err);
        previewEl.textContent = 'Preview could not be rendered.';
      }
    }

    function applyCodeDefaults() {
      const showLines = Boolean(getPrefs().lineNumbers);
      previewEl.querySelectorAll('pre[data-lines]').forEach((pre) => {
        pre.dataset.lines = String(showLines);
      });
    }

    const schedulePreview = debounce(() => { void renderPreview(); }, 260);

    /* ----------------------------------------------------- tags / sources */

    function renderTags() {
      clear(tagHost);
      const tags = lesson?.tags || [];
      if (!tags.length) {
        tagHost.appendChild(h('span', { class: 'text-muted', style: { fontSize: 'var(--fs-xs)' }, text: 'No tags yet.' }));
        return;
      }
      for (const tag of tags) {
        tagHost.appendChild(
          h('span', { class: 'chip' }, [
            h('span', { text: tag }),
            h('button', {
              type: 'button',
              attrs: { 'aria-label': `Remove tag ${tag}` },
              on: {
                click: async () => {
                  await applyPatch({ tags: (lesson.tags || []).filter((t) => t !== tag) });
                  renderTags();
                },
              },
            }, [icon('x')]),
          ]),
        );
      }
    }

    function renderSources() {
      clear(sourceHost);
      const sources = readForm().sourceUrls || [];
      if (!sources.length) {
        sourceHost.appendChild(h('span', { class: 'text-muted', style: { fontSize: 'var(--fs-xs)' }, text: 'No sources linked.' }));
        return;
      }
      for (const url of sources) {
        sourceHost.appendChild(
          h('div', { class: 'row row--between', style: { gap: 'var(--sp-2)' } }, [
            h('a', {
              class: 'mini-row__title',
              attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', title: url },
              text: url,
            }),
            h('button', {
              class: 'icon-btn',
              type: 'button',
              attrs: { 'aria-label': `Remove source ${url}` },
              on: {
                click: async () => {
                  await applyPatch({ sourceUrls: sources.filter((u) => u !== url) });
                  renderSources();
                },
              },
            }, [icon('x')]),
          ]),
        );
      }
    }

    async function renderRelated() {
      if (!lessonId) {
        relatedHost.replaceChildren(h('span', { class: 'text-muted', style: { fontSize: 'var(--fs-xs)' }, text: 'Available after the first save.' }));
        return;
      }
      const [snippets, cards] = await Promise.all([
        snippetsRepo.getAll().then((all) => all.filter((s) => s.lessonId === lessonId)),
        flashcardsRepo.getAll().then((all) => all.filter((c) => c.lessonId === lessonId)),
      ]);
      if (disposed) return;
      clear(relatedHost);
      relatedHost.append(
        h('div', { class: 'meta-line' }, [
          icon('snippet'),
          h('span', { text: `${snippets.length} snippet${snippets.length === 1 ? '' : 's'}` }),
          h('button', {
            class: 'btn btn--sm btn--ghost',
            type: 'button',
            text: 'New',
            on: { click: () => navigate(`/snippets?new=1&lesson=${encodeURIComponent(lessonId)}`) },
          }),
        ]),
        h('div', { class: 'meta-line' }, [
          icon('review'),
          h('span', { text: `${cards.length} flashcard${cards.length === 1 ? '' : 's'}` }),
          h('button', {
            class: 'btn btn--sm btn--ghost',
            type: 'button',
            text: 'New',
            on: { click: () => navigate(`/review?new=1&lesson=${encodeURIComponent(lessonId)}`) },
          }),
        ]),
        cards.length === 0 && (lesson?.tags || []).length
          ? h('button', {
              class: 'btn btn--sm',
              type: 'button',
              text: 'Draft cards from this lesson',
              on: { click: () => void draftCards() },
            })
          : null,
      );
    }

    /** AI draft generation lives in the assistant/review flow (explicit action). */
    async function draftCards() {
      try {
        const { generateCardDrafts } = await import('../features/ai/ai-service.js');
        const drafts = await generateCardDrafts(lesson);
        if (!drafts.length) {
          toast('No cards could be drafted — try adding more content.', { tone: 'info' });
          return;
        }
        navigate(`/review?new=1&lesson=${encodeURIComponent(lessonId)}`);
        toast(`${drafts.length} card drafts awaiting approval`, { tone: 'success' });
      } catch (err) {
        toast(err?.message || 'Card drafting failed', { tone: 'danger' });
      }
    }

    /* ------------------------------------------------------- lesson menu */

    function openLessonMenu(anchor) {
      const items = [
        {
          label: lesson?.favorite ? 'Remove favorite' : 'Add to favorites',
          icon: 'star',
          disabled: !lesson,
          onSelect: async () => {
            await applyPatch({ favorite: !lesson.favorite });
            toast(lesson.favorite ? 'Added to favorites' : 'Removed from favorites', { tone: 'success' });
          },
        },
        {
          label: lesson?.pinned ? 'Unpin' : 'Pin to top',
          icon: 'pin',
          disabled: !lesson,
          onSelect: async () => { await applyPatch({ pinned: !lesson.pinned }); },
        },
        {
          label: lesson?.archived ? 'Unarchive' : 'Archive',
          icon: 'archive',
          disabled: !lesson,
          onSelect: async () => { await applyPatch({ archived: !lesson.archived }); },
        },
        { separator: true },
        { label: 'Version history', icon: 'clock', disabled: !lessonId, onSelect: () => void openHistory() },
        {
          label: 'Duplicate lesson',
          icon: 'duplicate',
          disabled: !lessonId,
          onSelect: async () => {
            try {
              const copy = await lessonsRepo.duplicate(lessonId);
              toast('Lesson duplicated', { tone: 'success' });
              navigate(`/lesson/${encodeURIComponent(copy.id)}`);
            } catch (err) { toast(err?.message || 'Duplicate failed', { tone: 'danger' }); }
          },
        },
        { separator: true },
        {
          label: 'Move to trash',
          icon: 'trash',
          danger: true,
          disabled: !lessonId,
          onSelect: async () => {
            const ok = await confirmDialog({
              title: 'Move to trash?',
              message: `“${readForm().title || 'This lesson'}” will be recoverable from Trash.`,
              confirmLabel: 'Move to trash',
              danger: true,
            });
            if (!ok || !lessonId) return;
            try {
              await lessonsRepo.softDelete(lessonId);
              toast('Lesson moved to trash', { tone: 'success' });
              navigate('/library');
            } catch (err) { toast(err?.message || 'Could not move to trash', { tone: 'danger' }); }
          },
        },
      ];
      openMenu(anchor, items);
    }

    /* --------------------------------------------------------- revisions */

    async function openHistory() {
      const list = await revisions.listFor(lessonId);
      const body = list.length
        ? h('div', { class: 'list' }, list.map((row) =>
            h('div', { class: 'list__row' }, [
              h('div', { class: 'list__row-main' }, [
                h('span', { class: 'list__row-title', text: formatDateTime(row.at) }),
                h('span', { class: 'list__row-sub', text: `${countWords(row.snapshot.content || '').words} words · version ${row.snapshot.revision ?? '?'}` }),
              ]),
              h('div', { class: 'list__row-actions' }, [
                h('button', {
                  class: 'btn btn--sm',
                  type: 'button',
                  text: 'View',
                  on: { click: () => void openRevisionView(row) },
                }),
                h('button', {
                  class: 'btn btn--sm',
                  type: 'button',
                  text: 'Restore',
                  on: {
                    click: async () => {
                      const ok = await confirmDialog({
                        title: 'Restore this version?',
                        message: 'The current lesson is kept — the restored content becomes a new version.',
                        confirmLabel: 'Restore',
                      });
                      if (!ok) return;
                      try {
                        await revisions.restore(row.id);
                        toast('Version restored', { tone: 'success' });
                        await loadIntoForm(await lessonsRepo.get(lessonId));
                        await renderPreview();
                      } catch (err) { toast(err?.message || 'Restore failed', { tone: 'danger' }); }
                    },
                  },
                }),
              ]),
            ]),
          ))
        : h('p', { class: 'text-muted', text: 'No previous versions yet. Versions are captured as you edit.' });

      await openDialog({
        title: 'Version history',
        body,
        size: 'wide',
        actions: [{ label: 'Close', value: null }],
      });
    }

    async function openRevisionView(row) {
      const html = await renderMarkdown(row.snapshot.content || '', {});
      const bodyNode = h('div', { class: 'stack stack--sm' }, [
        h('div', { class: 'meta-line' }, [
          h('strong', { text: row.snapshot.title || '(untitled)' }),
          h('span', { text: formatRelative(row.at) }),
        ]),
        h('div', { class: 'markdown-body', html }),
      ]);
      // Same highlighting as the live preview (hljs works on detached nodes).
      hydrateCodeBlocks(bodyNode);
      await openDialog({
        title: `Version from ${formatDateTime(row.at)}`,
        body: bodyNode,
        size: 'wide',
        actions: [{ label: 'Close', value: null }],
      });
    }

    /* ------------------------------------------------------------- loading */

    async function loadIntoForm(data) {
      lesson = data;
      titleInput.value = lesson?.title ?? '';
      summaryInput.value = lesson?.summary ?? '';
      contentArea.value = lesson?.content ?? '';
      notesArea.value = lesson?.notes ?? '';
      statusSelect.value = lesson?.status ?? prefs.defaultStatus ?? 'not-started';
      difficultySelect.value = lesson?.difficulty ?? '';
      reviewInput.value = toLocalInput(lesson?.reviewAt);
      await refreshTaxonomy();
      languageSelect.value = lesson?.languageId ?? '';
      categorySelect.value = lesson?.categoryId ?? '';
      courseSelect.value = lesson?.courseId ?? '';
      renderTags();
      renderSources();
      await renderRelated();
      await renderPreview();
    }

    async function init() {
      if (isNewDraft) {
        await loadIntoForm({
          status: prefs.defaultStatus || 'not-started',
          difficulty: '',
          tags: [],
          sourceUrls: [],
          favorite: false,
          pinned: false,
          archived: false,
        });
        setAutosave('idle', 'Draft — add a title to save');
        titleInput.focus();
        return;
      }

      const existing = await lessonsRepo.get(lessonId);
      if (disposed) return;
      if (!existing || existing.trashed) {
        clear(root);
        root.appendChild(emptyState({
          iconName: 'alert',
          title: existing?.trashed ? 'This lesson is in the trash' : 'Lesson not found',
          text: existing?.trashed
            ? 'Restore it from Trash to continue editing.'
            : 'It may have been deleted on another device or purged.',
          actions: [
            ...(existing?.trashed ? [{ label: 'Open trash', onClick: () => navigate('/trash') }] : []),
            { label: 'Back to library', variant: 'primary', onClick: () => navigate('/library') },
          ],
        }));
        return;
      }

      await loadIntoForm(existing);
      await lessonsRepo.touchOpened(lessonId).catch(() => { /* read tracking is best-effort */ });
      setAutosave('saved', `Saved · ${formatRelative(existing.updatedAt)}`);
      setTimeout(() => {
        if (document.contains(container)) document.title = `${existing.title} · DevNotes`;
      }, 0);
    }

    /* -------------------------------------------------------------- wiring */

    const onFormInput = (event) => {
      if (event.target === tagInput) return;
      if (event.target === titleInput && !titleInput.value.trim() && lessonId) {
        titleError.hidden = false;
        titleError.textContent = 'A title is required.';
        titleInput.setAttribute('aria-invalid', 'true');
      } else if (event.target === titleInput) {
        titleError.hidden = true;
        titleInput.removeAttribute('aria-invalid');
      }
      if (event.target === contentArea || event.target === summaryInput) schedulePreview();
      markDirty();
    };

    root.addEventListener('input', onFormInput);
    root.addEventListener('change', onFormInput);

    tagInput.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = tagInput.value.trim().toLowerCase();
      if (!value) return;
      tagInput.value = '';
      const current = new Set(lesson?.tags || []);
      if (current.has(value)) return;
      current.add(value);
      await applyPatch({ tags: [...current].slice(0, 30) });
      renderTags();
    });

    contentArea.addEventListener('keydown', (event) => {
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        // Real tab key insertion (accessible: Ctrl+M toggles tab traversal).
        event.preventDefault();
        const { selectionStart: start, selectionEnd: end } = contentArea;
        const size = prefs.tabSize || 2;
        const insert = ' '.repeat(size);
        contentArea.setRangeText(insert, start, end, 'end');
        markDirty();
        schedulePreview();
      }
    });

    const offShortcut = shortcut('mod+s', () => {
      void save({ force: true });
    }, { allowInInput: true, description: 'Save lesson' });

    root.appendChild(shell);
    applyMode();
    void init().catch((err) => {
      if (disposed) return;
      console.error('[editor] init failed:', err);
      clear(root);
      root.appendChild(errorState({
        title: 'The lesson could not be opened',
        message: String(err?.message || err),
        retry: { label: 'Back to library', onClick: () => navigate('/library') },
      }));
    });

    return {
      async beforeLeave() {
        if (!dirty) return;
        scheduleSave.cancel();
        await save({ force: true });
      },
      destroy() {
        disposed = true;
        scheduleSave.cancel();
        schedulePreview.cancel();
        root.removeEventListener('input', onFormInput);
        root.removeEventListener('change', onFormInput);
        offShortcut?.();
      },
      onShow() { void renderPreview(); },
    };
  },
};

