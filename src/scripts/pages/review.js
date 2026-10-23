/**
 * review.js — Review & Flashcards (route /review).
 *
 * Three sections share the page and are switched through a tab strip kept in
 * the URL (`tab=manage`), so deep links work and query-only updates reach
 * `onQuery` instead of remounting — which is what keeps the manage search box
 * focused while typing.
 *
 * Scheduling is a 5-box Leitner grid: Again → box 1 (10 minutes), Good → box +1
 * and Easy → box +2 (capped at 5), with intervals 1 d / 3 d / 7 d / 14 d for
 * boxes 2–5. Answers are persisted with flashcardsRepo.setSchedule(id, {box,
 * dueAt}) — the repository's purpose-built helper (there is no review(id,
 * grade) method) — which bumps the revision and queues sync without writing
 * one activity row per answer.
 *
 * AI drafts are stored with source:'ai' + approved:false and never enter the
 * review queue until the user approves them (AGENTS.md §13).
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { setQuery } from '../router.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { shortcut } from '../utils/keyboard.js';
import { toast } from '../components/toast.js';
import { openMenu } from '../components/menu.js';
import { openDialog, confirmDialog } from '../components/dialog.js';
import { emptyState, skeleton, inlineNote, progressBar } from '../components/feedback.js';
import { createTabs, tabPanel } from '../components/tabs.js';
import { hydrateCodeBlocks } from '../components/code-block.js';
import { renderMarkdown } from '../utils/markdown.js';
import { flashcardsRepo, lessonsRepo } from '../db/repositories/index.js';
import { formatDue, pluralize } from '../utils/format.js';
import { isAiConfigured, describeAiSetup, generateCardDrafts } from '../features/ai/ai-service.js';

const TABS = ['study', 'manage', 'drafts'];
const BOXES = [1, 2, 3, 4, 5];
const DAY_MS = 86_400_000;
/** Delay before a card comes back, keyed by the box it lands in. */
const INTERVAL_MS = { 1: 10 * 60_000, 2: DAY_MS, 3: 3 * DAY_MS, 4: 7 * DAY_MS, 5: 14 * DAY_MS };
const GRADES = [
  { id: 'again', label: 'Again · box 1', key: '1' },
  { id: 'good', label: 'Good · box +1', key: '2' },
  { id: 'easy', label: 'Easy · box +2', key: '3' },
];

function option(value, label, current) {
  return h('option', { value, text: label, attrs: value === current ? { selected: '' } : {} });
}

function byTitle(a, b) {
  return String(a?.title ?? '').localeCompare(String(b?.title ?? ''));
}

function truncate(text, max = 110) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clampBox(box) {
  const value = Number(box);
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(1, Math.round(value)));
}

function parseTags(value) {
  return String(value ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** True for elements that already consume Space/Enter themselves. */
function isActivationTarget(target) {
  const tag = target?.tagName;
  return tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT'
    || tag === 'TEXTAREA' || Boolean(target?.isContentEditable);
}

/** 'How the boxes work' explainer shown at the bottom of the study section. */
function boxExplainer() {
  return h('div', { class: 'stack stack--sm' }, [
    h('details', {}, [
      h('summary', { text: 'How the boxes work' }),
      h('p', {
        class: 'text-muted',
        text: 'Box 1 repeats daily until you get it right; boxes 2–5 grow the interval (1, 3, 7, 14 days). “Again” always resets the card to box 1.',
      }),
    ]),
  ]);
}

function field(labelText, control, hint = '') {
  return h('label', { class: 'field' }, [
    h('span', { class: 'field__label', text: labelText }),
    control,
    hint ? h('span', { class: 'field__hint', text: hint }) : null,
  ]);
}

export default {
  id: 'review',
  title: () => 'Review & Flashcards',

  mount(container, ctx) {
    ctx.setBreadcrumbs?.([{ label: 'Review & Flashcards', path: '/review' }]);

    const query = ctx.query || {};
    const state = {
      tab: TABS.includes(query.tab) ? query.tab : 'study',
      q: query.q || '',
      box: query.box || '',
    };

    let cards = [];
    let lessons = [];
    let dueCards = [];
    let lessonById = new Map();
    let disposed = false;
    let grading = false;
    // Selector for the control that should receive focus after the next
    // study re-render (keeps keyboard users on the next logical action).
    let focusAfterRender = null;
    // Deep-link flags (?new=1&lesson=<id>, linked from the dashboard) are read
    // once at mount and consumed after the first successful load.
    let pendingNew = query.new === '1';
    let prefillLessonId = query.lesson || null;

    /**
     * Session state is id-based and survives re-renders, so a data refresh can
     * never reshuffle the queue or lose the graded cards.
     */
    const session = {
      active: false,
      queue: [],
      index: 0,
      revealed: false,
      reviewed: [],
      startedAt: null,
    };

    /* --------------------------------------------------------------- shell */

    const subtitle = h('p', { class: 'page-header__subtitle', text: 'Loading…' });
    const header = h('header', { class: 'page-header' }, [
      h('div', { class: 'page-header__title' }, [h('h1', { text: 'Review & Flashcards' }), subtitle]),
      h('div', { class: 'page-header__actions' }, [
        h('button', {
          class: 'btn btn--primary',
          type: 'button',
          on: { click: () => void openCardDialog() },
        }, [icon('plus'), 'New card']),
      ]),
    ]);

    const tabs = createTabs({
      tabs: [
        { id: 'study', label: 'Study' },
        { id: 'manage', label: 'Manage' },
        { id: 'drafts', label: 'Drafts' },
      ],
      active: state.tab,
      ariaLabel: 'Flashcard sections',
      onChange: (id) => setTab(id),
    });

    const studyPanel = tabPanel('study', state.tab === 'study');
    const managePanel = tabPanel('manage', state.tab === 'manage');
    const draftsPanel = tabPanel('drafts', state.tab === 'drafts');

    // Manage controls are built once: the router feeds URL updates back
    // through onQuery, so rebuilding these inputs would steal focus.
    const searchInput = h('input', {
      class: 'input',
      type: 'search',
      id: 'review-card-search',
      value: state.q,
      attrs: { placeholder: 'Search front, back or tags…', autocomplete: 'off' },
    });
    const searchClear = h('button', {
      class: 'search-field__clear',
      type: 'button',
      hidden: !state.q,
      attrs: { 'aria-label': 'Clear card search' },
      on: {
        click: () => {
          searchInput.value = '';
          state.q = '';
          searchClear.hidden = true;
          setQuery({ q: null });
        },
      },
    }, [icon('x')]);
    const boxSelect = h('select', { class: 'select', id: 'review-box-filter', attrs: { 'aria-label': 'Filter by box' } }, [
      option('', 'Any box', state.box),
      ...BOXES.map((box) => option(String(box), `Box ${box}`, state.box)),
    ]);
    const manageCount = h('span', { class: 'text-muted' });
    const manageListHost = h('div', { class: 'stack stack--sm' });
    managePanel.append(
      h('div', { class: 'filter-bar' }, [
        h('label', { class: 'search-field', attrs: { for: 'review-card-search' } }, [
          h('span', { class: 'sr-only', text: 'Search flashcards' }),
          h('span', { class: 'search-field__icon' }, [icon('search')]),
          searchInput,
          searchClear,
        ]),
        boxSelect,
        h('span', { class: 'spacer' }),
        manageCount,
      ]),
      manageListHost,
    );

    // Drafts header — AI availability can change in Settings, so the button
    // and its explanation are re-synced on every render.
    const draftNote = h('div', { attrs: { id: 'review-ai-note-drafts' }, hidden: true }, [
      inlineNote(describeAiSetup(), 'warning'),
    ]);
    const draftButton = aiDraftButton('Draft from a lesson', 'review-ai-note-drafts');
    const draftsListHost = h('div', { class: 'stack stack--sm' });
    draftsPanel.appendChild(h('section', { class: 'section' }, [
      h('div', { class: 'section__header' }, [
        h('div', { class: 'row' }, [
          h('h2', { class: 'section__title', text: 'AI drafts' }),
          h('span', { class: 'section__hint', text: 'generated cards waiting for approval' }),
        ]),
        draftButton,
      ]),
      draftNote,
      h('p', {
        class: 'text-muted',
        text: 'AI cards are stored unapproved and never enter the review queue until you approve them.',
      }),
      draftsListHost,
    ]));

    const boot = skeleton({ count: 4, variant: 'title' });
    const root = h('div', { class: 'stack stack--lg' }, [header, tabs.root, boot, studyPanel, managePanel, draftsPanel]);
    container.appendChild(root);

    /* -------------------------------------------------------------- helpers */

    function currentQueue() {
      const byId = new Map(cards.map((card) => [card.id, card]));
      return session.queue.map((id) => byId.get(id)).filter((card) => card && card.approved);
    }

    function sessionFinished() {
      return session.active && session.index >= currentQueue().length;
    }

    function setTab(id) {
      if (state.tab === id) return;
      state.tab = id;
      setQuery({ tab: id === 'study' ? null : id });
    }

    function aiDraftButton(label, noteId) {
      const configured = isAiConfigured();
      return h('button', {
        class: 'btn',
        type: 'button',
        text: label,
        attrs: configured ? {} : { disabled: '', 'aria-describedby': noteId },
        on: { click: () => { if (isAiConfigured()) void openDraftDialog(); } },
      });
    }

    function syncDraftControls() {
      const configured = isAiConfigured();
      draftButton.disabled = !configured;
      if (configured) draftButton.removeAttribute('aria-describedby');
      else draftButton.setAttribute('aria-describedby', 'review-ai-note-drafts');
      draftNote.hidden = configured;
    }

    function applyFocus(host) {
      if (!focusAfterRender) return;
      const selector = focusAfterRender;
      focusAfterRender = null;
      host.querySelector(selector)?.focus();
    }

    function applyTabVisibility() {
      for (const [id, panel] of [['study', studyPanel], ['manage', managePanel], ['drafts', draftsPanel]]) {
        panel.hidden = id !== state.tab;
      }
      if (tabs.getActive() !== state.tab) tabs.setActive(state.tab);
      // Never rewrite the box the user is typing into: a data:changed re-render
      // can land before the search debounce has pushed the value to the URL.
      if (document.activeElement !== searchInput && searchInput.value !== state.q) {
        searchInput.value = state.q;
      }
      searchClear.hidden = !searchInput.value;
      if (boxSelect.value !== state.box) boxSelect.value = state.box;
    }

    function showError(err) {
      console.error('[review] action failed:', err);
      toast(err?.message || 'That action failed', { tone: 'danger' });
    }

    function renderLoadError(err) {
      const host = state.tab === 'study' ? studyPanel : state.tab === 'manage' ? manageListHost : draftsListHost;
      if (state.tab === 'study') clear(studyPanel);
      else clear(host);
      host.appendChild(emptyState({
        iconName: 'alert',
        title: 'Review could not load',
        text: String(err?.message || err),
        actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
      }));
    }

    function consumeDeepLinkFlags() {
      if (!pendingNew) return;
      pendingNew = false;
      const lessonId = prefillLessonId;
      prefillLessonId = null;
      setQuery({ new: null, lesson: null });
      void openCardDialog(null, { lessonId });
    }

    /* --------------------------------------------------------------- session */

    function startSession(ids) {
      session.queue = [...ids];
      session.index = 0;
      session.revealed = false;
      session.reviewed = [];
      session.startedAt = Date.now();
      session.active = true;
      focusAfterRender = '[data-focus-reveal]';
      void render();
    }

    function endSession() {
      session.active = false;
      session.queue = [];
      session.index = 0;
      session.revealed = false;
      session.reviewed = [];
      session.startedAt = null;
      focusAfterRender = '[data-focus-cta]';
      void render();
    }

    function revealAnswer() {
      if (!session.active || session.revealed || sessionFinished()) return;
      session.revealed = true;
      focusAfterRender = '[data-focus-grade]';
      void render();
    }

    async function gradeCurrent(gradeId) {
      if (grading || disposed || !session.active || !session.revealed) return;
      const queue = currentQueue();
      const card = queue[session.index];
      if (!card) return;

      grading = true;
      try {
        const box = gradeId === 'again'
          ? 1
          : Math.min(5, clampBox(card.box) + (gradeId === 'good' ? 1 : 2));
        const dueAt = Date.now() + INTERVAL_MS[box];
        await flashcardsRepo.setSchedule(card.id, { box, dueAt });
        if (disposed) return;
        // Keep the in-memory copy fresh so the stats are right even before the
        // next data:changed render lands.
        card.box = box;
        card.dueAt = dueAt;
        session.reviewed.push(card.id);
        session.index += 1;
        session.revealed = false;
        focusAfterRender = session.index >= queue.length
          ? '.empty-state__actions .btn'
          : '[data-focus-reveal]';
        await render();
      } catch (err) {
        showError(err);
      } finally {
        grading = false;
      }
    }

    /** Keyboard entry point: returns false to let the event continue. */
    function onStudyKey(key, event) {
      if (disposed || state.tab !== 'study' || !session.active || sessionFinished()) return false;
      if (key === ' ' || key === 'Enter') {
        // A focused control keeps its native activation behaviour.
        if (isActivationTarget(event.target)) return false;
        if (session.revealed) return false;
        revealAnswer();
        return true;
      }
      if (!session.revealed) return false;
      const grade = GRADES.find((item) => item.key === key);
      if (!grade) return false;
      void gradeCurrent(grade.id);
      return true;
    }

    // Registry keys must match keyboard.js's event.key names — the Space bar
    // reports ' ' (a literal space), not 'space'.
    const unregisterShortcuts = [
      shortcut(' ', (event) => onStudyKey(' ', event), { allowInInput: false }),
      shortcut('enter', (event) => onStudyKey('Enter', event), { allowInInput: false }),
      ...GRADES.map((grade) => shortcut(grade.key, (event) => onStudyKey(grade.key, event), { allowInInput: false })),
    ];

    /* ----------------------------------------------------------------- tabs */

    async function renderStudy() {
      const host = studyPanel;
      const previewQueue = currentQueue();
      const previewCard = session.active && session.index < previewQueue.length
        ? previewQueue[session.index]
        : null;
      // The answer is Markdown: render (and sanitize) it before touching the
      // DOM so the panel is rebuilt in one synchronous step.
      const backHtml = previewCard && session.revealed ? await renderMarkdown(previewCard.back || '', {}) : '';
      if (disposed) return;

      const queue = currentQueue();
      const card = session.active && session.index < queue.length ? queue[session.index] : null;
      if (card !== previewCard) {
        // Session state moved while the answer was rendering; start over.
        void render();
        return;
      }

      clear(host);
      const approved = cards.filter((item) => item.approved);
      const drafts = cards.filter((item) => item.approved === false);

      if (!approved.length) {
        const stateEl = emptyState({
          iconName: 'review',
          title: 'No flashcards yet',
          text: 'Flashcards turn your lessons into short review sessions. Create one yourself, or let AI draft them from a lesson.'
            + (drafts.length ? ` ${pluralize(drafts.length, 'draft')} ${drafts.length === 1 ? 'is' : 'are'} waiting in the Drafts tab.` : ''),
          actions: [{ label: 'New card', variant: 'primary', onClick: () => void openCardDialog() }],
        });
        stateEl.querySelector('.empty-state__actions')?.appendChild(
          aiDraftButton('Draft cards from a lesson', 'review-ai-note-study'),
        );
        host.appendChild(stateEl);
        if (!isAiConfigured()) {
          host.appendChild(h('div', { attrs: { id: 'review-ai-note-study' } }, [
            inlineNote(describeAiSetup(), 'warning'),
          ]));
        }
        host.appendChild(boxExplainer());
        return;
      }

      if (session.active && card) {
        const sourceLesson = card.lessonId ? lessonById.get(card.lessonId) : null;
        host.appendChild(h('div', { class: 'review-stage' }, [
          h('div', { class: 'stack stack--sm', style: { width: '100%' } }, [
            h('div', { class: 'meta-line' }, [
              h('span', { text: `Card ${session.index + 1} of ${queue.length}` }),
            ]),
            progressBar({ value: session.index + 1, max: queue.length, label: 'Review session progress' }),
          ]),
          h('div', { class: 'flashcard' }, [
            h('div', { class: 'flashcard__face' }, [
              h('span', { class: 'flashcard__label', text: 'Question' }),
              h('div', { class: 'flashcard__front', text: card.front }),
            ]),
            session.revealed
              ? h('div', { class: 'flashcard__face' }, [
                  h('span', { class: 'flashcard__label', text: 'Answer' }),
                  h('div', { class: 'flashcard__back', html: backHtml }),
                ])
              : null,
            h('div', { class: 'flashcard__actions' }, [
              h('span', { class: 'meta-line' }, [
                sourceLesson ? h('span', { text: `From ${sourceLesson.title}` }) : null,
                h('span', { class: 'badge badge--accent', text: `Box ${clampBox(card.box)}` }),
              ]),
            ]),
          ]),
          h('div', { class: 'review-controls' }, [
            session.revealed
              ? GRADES.map((grade) => h('button', {
                  class: 'btn',
                  type: 'button',
                  text: grade.label,
                  dataset: grade.id === 'again' ? { focusGrade: '' } : {},
                  attrs: { 'aria-keyshortcuts': grade.key },
                  on: { click: () => void gradeCurrent(grade.id) },
                }))
              : h('button', {
                  class: 'btn btn--primary',
                  type: 'button',
                  text: 'Show answer',
                  dataset: { focusReveal: '' },
                  attrs: { 'aria-keyshortcuts': 'Space' },
                  on: { click: revealAnswer },
                }),
          ]),
          h('div', { class: 'row', style: { justifyContent: 'center' } }, [
            h('button', {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              text: 'End session',
              dataset: { focusEnd: '' },
              on: { click: endSession },
            }),
          ]),
        ]));
        // Any <figure class="code-block"> inside the sanitized answer gets its
        // copy/wrap actions.
        hydrateCodeBlocks(host);
        host.appendChild(boxExplainer());
        applyFocus(host);
        return;
      }

      if (session.active) {
        const elapsed = Date.now() - (session.startedAt ?? Date.now());
        host.appendChild(emptyState({
          iconName: 'check',
          title: 'Session complete',
          text: `${pluralize(session.reviewed.length, 'card')} reviewed in ${formatDuration(elapsed)}. Review again later — the new due times are already saved.`,
          actions: [{ label: 'End session', variant: 'primary', onClick: endSession }],
        }));
        applyFocus(host);
        return;
      }

      /* --------------------------------------------- stats view (no session) */
      const boxCounts = BOXES.map((box) => approved.filter((item) => clampBox(item.box) === box).length);
      const minDue = approved.reduce(
        (min, item) => (Number.isFinite(item.dueAt) ? Math.min(min, item.dueAt) : min),
        Infinity,
      );
      const dueCount = dueCards.length;

      host.appendChild(h('div', { class: 'stack' }, [
        h('p', {
          class: 'text-muted',
          text: dueCount
            ? `${pluralize(dueCount, 'card')} due now.`
            : 'Nothing is due right now — you can still practice ahead.',
        }),
        h('div', { class: 'leitner-grid' }, BOXES.map((box, index) =>
          h('div', { class: 'box-stat' }, [
            h('div', { class: 'box-stat__value', text: String(boxCounts[index]) }),
            h('div', { class: 'box-stat__label', text: `Box ${box}` }),
          ]))),
        !dueCount && Number.isFinite(minDue)
          ? h('div', { class: 'meta-line' }, [h('span', { text: `Next card ${formatDue(minDue)}` })])
          : null,
        h('div', { class: 'row' }, [
          dueCount
            ? h('button', {
                class: 'btn btn--primary',
                type: 'button',
                dataset: { focusCta: '' },
                on: { click: () => startSession(dueCards.map((item) => item.id)) },
              }, [icon('play'), `Start review (${dueCount})`])
            : h('button', {
                class: 'btn',
                type: 'button',
                dataset: { focusCta: '' },
                on: {
                  click: () => startSession(
                    [...approved].sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0)).map((item) => item.id),
                  ),
                },
              }, [icon('play'), 'Practice early']),
        ]),
      ]));
      host.appendChild(boxExplainer());
      applyFocus(host);
    }

    function renderManageRow(card) {
      const lesson = card.lessonId ? lessonById.get(card.lessonId) : null;
      const subParts = [
        lesson ? `From ${lesson.title}` : 'No lesson',
        `Box ${clampBox(card.box)}`,
        formatDue(card.dueAt) || 'due now',
      ];
      return h('div', { class: 'list__row', dataset: { id: card.id } }, [
        h('div', { class: 'list__row-main' }, [
          h('span', { class: 'list__row-title' }, [
            h('span', { text: truncate(card.front) }),
            card.source === 'ai' ? h('span', { class: 'badge badge--info', text: 'AI' }) : null,
            card.approved === false ? h('span', { class: 'badge badge--not-started', text: 'Not approved' }) : null,
          ]),
          h('span', { class: 'list__row-sub', text: subParts.join(' · ') }),
        ]),
        h('div', { class: 'list__row-actions' }, [
          h('button', {
            class: 'icon-btn',
            type: 'button',
            attrs: {
              'aria-label': `Actions for ${truncate(card.front, 40)}`,
              'aria-haspopup': 'menu',
            },
            on: {
              click: (event) => openMenu(event.currentTarget, [
                { label: 'Edit', icon: 'edit', onSelect: () => void openCardDialog(card) },
                { label: 'Reset to box 1', icon: 'refresh', onSelect: () => void resetCard(card) },
                { separator: true },
                {
                  label: 'Move to trash',
                  icon: 'trash',
                  danger: true,
                  onSelect: () => void deleteCard(card),
                },
              ], { align: 'end' }),
            },
          }, [icon('more')]),
        ]),
      ]);
    }

    function renderManage() {
      const term = state.q.trim().toLowerCase();
      const filtered = cards.filter((card) => {
        if (state.box && String(clampBox(card.box)) !== state.box) return false;
        if (!term) return true;
        return [card.front, card.back, ...(card.tags || [])].join(' ').toLowerCase().includes(term);
      });

      manageCount.textContent = filtered.length === cards.length
        ? pluralize(cards.length, 'card')
        : `${filtered.length} of ${pluralize(cards.length, 'card')}`;
      clear(manageListHost);

      if (!cards.length) {
        manageListHost.appendChild(emptyState({
          iconName: 'review',
          title: 'No flashcards yet',
          text: 'Create your first card to start a review session.',
          actions: [{ label: 'New card', variant: 'primary', onClick: () => void openCardDialog() }],
        }));
        return;
      }
      if (!filtered.length) {
        manageListHost.appendChild(emptyState({
          iconName: 'search',
          title: 'No cards match',
          text: 'Try different words, or clear the search and the box filter.',
          actions: [{
            label: 'Clear filters',
            onClick: () => {
              state.q = '';
              state.box = '';
              searchInput.value = '';
              boxSelect.value = '';
              searchClear.hidden = true;
              setQuery({ q: null, box: null });
            },
          }],
        }));
        return;
      }
      manageListHost.appendChild(h('div', { class: 'list' }, filtered.map(renderManageRow)));
    }

    function renderDrafts() {
      clear(draftsListHost);
      const drafts = cards.filter((card) => card.approved === false);
      if (!drafts.length) {
        draftsListHost.appendChild(emptyState({
          iconName: 'sparkles',
          title: 'No drafts waiting',
          text: 'AI-generated cards appear here for approval before they can enter the study queue.',
        }));
        return;
      }
      draftsListHost.appendChild(h('div', { class: 'list' }, drafts.map((card) => {
        const lesson = card.lessonId ? lessonById.get(card.lessonId) : null;
        const subParts = [truncate(card.back, 90), lesson ? `From ${lesson.title}` : null].filter(Boolean);
        return h('div', { class: 'list__row', dataset: { id: card.id } }, [
          h('div', { class: 'list__row-main' }, [
            h('span', { class: 'list__row-title' }, [
              h('span', { text: truncate(card.front) }),
              card.source === 'ai' ? h('span', { class: 'badge badge--accent', text: 'AI draft' }) : null,
            ]),
            h('span', { class: 'list__row-sub', text: subParts.join(' · ') }),
          ]),
          h('div', { class: 'list__row-actions' }, [
            h('button', {
              class: 'btn btn--sm btn--primary',
              type: 'button',
              text: 'Approve',
              attrs: { 'aria-label': `Approve draft: ${truncate(card.front, 60)}` },
              on: { click: () => void approveDraft(card) },
            }),
            h('button', {
              class: 'btn btn--sm btn--danger',
              type: 'button',
              text: 'Reject',
              attrs: { 'aria-label': `Reject draft: ${truncate(card.front, 60)}` },
              on: { click: () => void rejectDraft(card) },
            }),
          ]),
        ]);
      })));
    }

    /* ------------------------------------------------------------- card CRUD */

    async function openCardDialog(card = null, { lessonId = null } = {}) {
      const lessonsSorted = [...lessons].sort(byTitle);
      const linkedLesson = card?.lessonId ?? lessonId ?? '';
      const frontArea = h('textarea', {
        class: 'textarea',
        attrs: { rows: '2', placeholder: 'Question or term', spellcheck: 'true' },
      });
      const backArea = h('textarea', {
        class: 'textarea',
        attrs: { rows: '6', placeholder: 'Answer — Markdown is supported', spellcheck: 'true' },
      });
      frontArea.value = card?.front ?? '';
      backArea.value = card?.back ?? '';
      const lessonSelect = h('select', { class: 'select' }, [
        option('', 'None', linkedLesson),
        ...lessonsSorted.map((lesson) => option(lesson.id, lesson.title, linkedLesson)),
      ]);
      const tagsInput = h('input', {
        class: 'input',
        type: 'text',
        attrs: { placeholder: 'comma, separated, tags', autocomplete: 'off' },
      });
      tagsInput.value = (card?.tags || []).join(', ');
      const errorLine = h('div', { class: 'field__error', attrs: { role: 'alert' }, hidden: true });
      const show = (message) => {
        errorLine.textContent = message;
        errorLine.hidden = !message;
      };

      const result = await openDialog({
        title: card ? 'Edit flashcard' : 'New flashcard',
        body: h('div', { class: 'stack stack--sm' }, [
          field('Front', frontArea),
          field('Back', backArea, 'Rendered as Markdown while you study.'),
          field('Linked lesson', lessonSelect, 'Shows up as “From …” during review.'),
          field('Tags', tagsInput, 'Comma separated.'),
          errorLine,
        ]),
        size: 'wide',
        initialFocus: frontArea,
        actions: [
          { label: 'Cancel', value: null },
          {
            label: 'Save',
            value: 'submit',
            variant: 'primary',
            closeOnClick: false,
            onClick: (_event, submit) => {
              if (!frontArea.value.trim() || !backArea.value.trim()) {
                show('Both a front and a back are required.');
                (frontArea.value.trim() ? backArea : frontArea).focus();
                return;
              }
              show('');
              submit();
            },
          },
        ],
      });
      if (result !== 'submit') return;

      const payload = {
        front: frontArea.value.trim(),
        back: backArea.value.trim(),
        lessonId: lessonSelect.value || null,
        tags: parseTags(tagsInput.value),
      };
      try {
        if (card) {
          await flashcardsRepo.update(card.id, payload);
          toast('Flashcard updated', { tone: 'success' });
        } else {
          await flashcardsRepo.create({ ...payload, source: 'manual' });
          toast('Flashcard created', { tone: 'success' });
        }
        await render();
      } catch (err) {
        showError(err);
      }
    }

    async function resetCard(card) {
      try {
        await flashcardsRepo.update(card.id, { box: 1, dueAt: Date.now() });
        toast('Card reset to box 1', { tone: 'success' });
        await render();
      } catch (err) {
        showError(err);
      }
    }

    async function deleteCard(card) {
      const ok = await confirmDialog({
        title: 'Move this card to trash?',
        message: `“${truncate(card.front, 60)}” leaves the review queue and can be restored from Trash.`,
        confirmLabel: 'Move to trash',
        danger: true,
      });
      if (!ok) return;
      try {
        await flashcardsRepo.softDelete(card.id);
        toast('Card moved to trash', { tone: 'success' });
        await render();
      } catch (err) {
        showError(err);
      }
    }

    async function approveDraft(card) {
      try {
        await flashcardsRepo.approve(card.id);
        toast('Draft approved — it is in the review queue now.', { tone: 'success' });
        await render();
      } catch (err) {
        showError(err);
      }
    }

    async function rejectDraft(card) {
      const ok = await confirmDialog({
        title: 'Reject this draft?',
        message: `“${truncate(card.front, 60)}” is removed permanently — it cannot be restored from Trash.`,
        confirmLabel: 'Reject draft',
        danger: true,
      });
      if (!ok) return;
      try {
        // purge() is documented as "only from the trash", so trash first; if
        // the purge fails the draft is at least recoverable.
        await flashcardsRepo.softDelete(card.id);
        await flashcardsRepo.purge(card.id);
        toast('Draft rejected', { tone: 'success' });
        await render();
      } catch (err) {
        showError(err);
      }
    }

    /* ------------------------------------------------------------ AI drafts */

    async function openDraftDialog() {
      if (!isAiConfigured()) {
        toast(describeAiSetup(), { tone: 'warning' });
        return;
      }
      let available = [];
      try {
        available = await lessonsRepo.getAll();
      } catch (err) {
        showError(err);
        return;
      }
      const sorted = [...available].sort(byTitle);
      if (!sorted.length) {
        toast('Create a lesson first — drafts are generated from lesson content.', { tone: 'info' });
        return;
      }

      const search = h('input', {
        class: 'input',
        type: 'search',
        attrs: { id: 'draft-dialog-search', placeholder: 'Search lessons…', autocomplete: 'off' },
      });
      const errorLine = h('div', { class: 'field__error', attrs: { role: 'alert' }, hidden: true });
      const rows = sorted.map((lesson) => {
        const row = h('label', { class: 'list__row' }, [
          h('input', {
            class: 'radio',
            type: 'radio',
            name: 'draft-lesson',
            value: lesson.id,
            attrs: { 'aria-label': lesson.title },
          }),
          h('div', { class: 'list__row-main' }, [
            h('span', { class: 'list__row-title', text: lesson.title }),
            h('span', { class: 'list__row-sub', text: truncate(lesson.summary || lesson.content || '', 90) }),
          ]),
        ]);
        return { lesson, row };
      });
      const listBox = h('div', { class: 'list' }, rows.map((entry) => entry.row));
      search.addEventListener('input', () => {
        const term = search.value.trim().toLowerCase();
        for (const { lesson, row } of rows) {
          row.hidden = Boolean(term)
            && !`${lesson.title} ${lesson.summary ?? ''}`.toLowerCase().includes(term);
        }
      });

      let selectedId = null;
      const result = await openDialog({
        title: 'Draft cards from a lesson',
        body: h('div', { class: 'stack stack--sm' }, [
          field('Find a lesson', search),
          listBox,
          errorLine,
          h('p', {
            class: 'text-muted',
            text: 'Only the lesson you pick is sent to the AI. The cards are saved as unapproved drafts.',
          }),
        ]),
        size: 'wide',
        initialFocus: search,
        actions: [
          { label: 'Cancel', value: null },
          {
            label: 'Create drafts',
            value: 'submit',
            variant: 'primary',
            closeOnClick: false,
            onClick: (_event, submit) => {
              const checked = listBox.querySelector('input[name="draft-lesson"]:checked');
              if (!checked) {
                errorLine.textContent = 'Pick a lesson first.';
                errorLine.hidden = false;
                return;
              }
              selectedId = checked.value;
              errorLine.hidden = true;
              submit();
            },
          },
        ],
      });
      if (result !== 'submit' || !selectedId) return;

      const lesson = sorted.find((item) => item.id === selectedId);
      if (!lesson) return;
      try {
        const created = await generateCardDrafts(lesson);
        if (disposed) return;
        toast(`${created.length} drafts created`, { tone: 'success' });
        if (state.tab !== 'drafts') setTab('drafts');
        else await render();
      } catch (err) {
        // AppError messages are written for the user (bad key, rate limit…).
        showError(err);
      }
    }

    /* ---------------------------------------------------------------- render */

    async function render() {
      if (disposed) return;
      try {
        const [nextCards, nextLessons, nextDue] = await Promise.all([
          flashcardsRepo.getAll(),   // non-trashed cards
          lessonsRepo.getAll(),
          flashcardsRepo.getDue(),   // approved && dueAt <= now, soonest first
        ]);
        if (disposed) return;
        cards = nextCards;
        lessons = nextLessons;
        dueCards = nextDue;
        lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));

        boot.remove();
        applyTabVisibility();
        syncDraftControls();
        const approvedCount = cards.filter((card) => card.approved).length;
        subtitle.textContent = `${pluralize(approvedCount, 'card')} · ${dueCards.length} due now`;

        if (state.tab === 'study') await renderStudy();
        else if (state.tab === 'manage') renderManage();
        else renderDrafts();

        if (disposed) return;
        consumeDeepLinkFlags();
      } catch (err) {
        if (disposed) return;
        console.error('[review] render failed:', err);
        boot.remove();
        renderLoadError(err);
      }
    }

    /* ------------------------------------------------------------ listeners */

    const onSearch = debounce(() => {
      state.q = searchInput.value.trim();
      setQuery({ q: state.q || null });
    }, 220);
    searchInput.addEventListener('input', onSearch);
    boxSelect.addEventListener('change', () => {
      state.box = boxSelect.value;
      setQuery({ box: state.box || null });
    });

    const reload = debounce(() => void render(), 250);
    const offData = bus.on('data:changed', reload);

    void render();

    return {
      beforeLeave() { onSearch.cancel(); },
      onQuery(next) {
        state.tab = TABS.includes(next.tab) ? next.tab : 'study';
        state.q = next.q || '';
        state.box = next.box || '';
        void render();
      },
      onShow() { void render(); },
      destroy() {
        disposed = true;
        offData();
        reload.cancel();
        onSearch.cancel();
        for (const off of unregisterShortcuts) off();
        tabs.destroy();
      },
    };
  },
};
