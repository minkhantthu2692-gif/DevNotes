/**
 * assistant.js — optional AI chat page.
 *
 * AI is never required (AGENTS.md §13): when it is not configured the page
 * explains how to set it up and stops — no composer, no dead controls.
 *
 * Conversation history and lesson attachments are SESSION ONLY: nothing the
 * model says is ever written into an existing note. The only write path is
 * "Save as new lesson", which always creates a brand-new record after an
 * explicit confirmation.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { toast } from '../components/toast.js';
import { openDialog, confirmDialog } from '../components/dialog.js';
import { emptyState, skeleton } from '../components/feedback.js';
import { lessonsRepo, languagesRepo } from '../db/repositories/index.js';
import {
  chat, contextFromLesson, isAiConfigured, describeAiSetup, getAiMode, generateCardDrafts,
} from '../features/ai/ai-service.js';
import { getPrefs } from '../features/settings/prefs.js';
import { renderMarkdown } from '../utils/markdown.js';
import { hydrateCodeBlocks } from '../components/code-block.js';
import { copyText } from '../utils/clipboard.js';
import { formatRelative } from '../utils/format.js';

const MAX_ATTACHMENTS = 2;
// chat() rejects more than 40 message items: 1 system + 2 attachments + history.
const MAX_HISTORY = 30;

export default {
  id: 'assistant',
  title: () => 'AI Assistant',
  breadcrumbs: () => [{ label: 'AI Assistant', path: '/assistant' }],

  mount(container, ctx) {
    ctx.setBreadcrumbs?.([{ label: 'AI Assistant', path: '/assistant' }]);

    const prefs = getPrefs();
    const configured = isAiConfigured();
    const mode = getAiMode();
    const modeLabel = mode === 'proxy'
      ? 'Proxy (project ai-proxy)'
      : mode === 'byok'
        ? 'BYOK (your own Groq key)'
        : 'Off';

    let disposed = false;
    let history = [];        // session-only [{role, content}]
    let attachments = [];    // [{id, title, lesson}]
    let lessons = [];
    let languages = [];
    let busy = false;
    let abortCtl = null;
    let stoppedByUser = false;
    let failedUser = null;   // last user message that failed (drives Retry)

    /* ---------------------------------------------------------------- shell */

    const header = h('header', { class: 'page-header' }, [
      h('div', { class: 'page-header__title' }, [
        h('h1', { text: 'AI Assistant' }),
        h('p', { class: 'page-header__subtitle', text: `Mode: ${modeLabel} · Model: ${prefs.aiModel}` }),
      ]),
    ]);

    const root = h('div', { class: 'stack stack--lg' }, [header]);
    container.appendChild(root);

    if (!configured) {
      root.appendChild(emptyState({
        iconName: 'sparkles',
        title: 'AI is not set up',
        text: describeAiSetup(),
        actions: [{
          label: 'Open AI settings',
          variant: 'primary',
          onClick: () => navigate('/settings?section=ai'),
        }],
      }));
      return { destroy() { disposed = true; } };
    }

    const clearBtn = h('button', {
      class: 'btn',
      type: 'button',
      on: { click: () => clearChat() },
    }, [icon('trash'), 'Clear chat']);
    header.appendChild(h('div', { class: 'page-header__actions' }, [clearBtn]));

    root.appendChild(
      h('div', { class: 'meta-line' }, [
        h('span', {
          text: `Model: ${prefs.aiModel} · requests go ${mode === 'proxy'
            ? 'through your project’s ai-proxy'
            : 'directly to Groq with your own key'}`,
        }),
      ]),
    );

    /* ------------------------------------------------------------- chat DOM */

    const listEl = h('div', {
      class: 'chat__list',
      attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' },
      // No existing class provides a bounded conversation scroller, so the
      // height/scroll rules are inline (see the report of CSS gaps).
      style: { maxHeight: '60vh', overflowY: 'auto' },
    });
    const chipsHost = h('div', { class: 'context-chips' });
    const quickHost = h('div');
    const draftHost = h('div');
    const input = h('textarea', {
      attrs: { placeholder: 'Ask DevNotes… (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Your message' },
      rows: 2,
    });
    const sendBtn = h('button', {
      class: 'btn btn--primary btn--sm',
      type: 'button',
      on: { click: () => void send(input.value) },
    }, [icon('play'), 'Send']);
    const stopBtn = h('button', {
      class: 'btn btn--sm',
      type: 'button',
      hidden: true,
      on: { click: () => stopStream() },
    }, ['Stop']);
    const composer = h('div', { class: 'chat__composer' }, [input, sendBtn, stopBtn]);
    const hintLine = h('div', { class: 'meta-line' }, [
      h('span', { text: 'Conversation history is kept for this session only.' }),
    ]);

    const chatRoot = h('div', { class: 'chat' }, [listEl, chipsHost, quickHost, composer, hintLine, draftHost]);
    const bodyHost = h('div', { class: 'stack stack--sm' }, [skeleton({ count: 2, variant: 'title' })]);
    root.appendChild(bodyHost);

    /* ------------------------------------------------------------ messages */

    function scrollToBottom() {
      listEl.scrollTop = listEl.scrollHeight;
    }

    function addUserMessage(text) {
      listEl.appendChild(h('div', { class: 'chat__msg', dataset: { role: 'user' } }, [
        h('span', { class: 'chat__avatar' }, [icon('user')]),
        h('div', { class: 'chat__bubble', text }),
      ]));
      scrollToBottom();
    }

    function newAssistantShell() {
      const preview = h('div', { class: 'md markdown-body' });
      const actions = h('div', { class: 'row', style: { marginTop: 'var(--sp-2)' } });
      const node = h('div', { class: 'chat__msg', dataset: { role: 'assistant' } }, [
        h('span', { class: 'chat__avatar' }, [icon('sparkles')]),
        h('div', { class: 'chat__bubble' }, [preview, actions]),
      ]);
      listEl.appendChild(node);
      scrollToBottom();
      return { node, preview, actions };
    }

    /** Placeholder shown while a request is in flight. */
    function thinkingShell(label = 'Thinking…') {
      const shell = newAssistantShell();
      shell.preview.appendChild(h('p', { class: 'text-muted', text: label }));
      return shell;
    }

    function stoppedShell(shell) {
      clear(shell.preview);
      clear(shell.actions);
      shell.preview.appendChild(h('p', { class: 'text-muted', text: 'Stopped.' }));
      scrollToBottom();
    }

    function errorShell(shell, err, retryFn) {
      clear(shell.preview);
      clear(shell.actions);
      shell.preview.appendChild(h('div', { class: 'chat__error', text: String(err?.message || err) }));
      if (retryFn) {
        shell.actions.appendChild(h('button', {
          class: 'btn btn--sm',
          type: 'button',
          dataset: { retry: '' },
          // Drop the failed bubble: the retry replaces it with a fresh
          // "Thinking…" placeholder (and a new error if it fails again).
          // Guard `busy` first, otherwise a click during an in-flight request
          // would delete the bubble without sending anything.
          on: {
            click: () => {
              if (busy || disposed) return;
              shell.node.remove();
              void retryFn();
            },
          },
        }, [icon('refresh'), 'Retry']));
      }
      scrollToBottom();
    }

    async function showAssistantReply(content) {
      const shell = newAssistantShell();
      try {
        const html = await renderMarkdown(content, {});
        if (disposed) return;
        shell.preview.innerHTML = html; // sanitized by utils/sanitize.js
        hydrateCodeBlocks(shell.preview);
      } catch (err) {
        if (disposed) return;
        console.error('[assistant] markdown render failed:', err);
        shell.preview.textContent = String(content ?? '');
      }
      if (disposed) return;
      renderAssistantActions(shell.actions, content);
      scrollToBottom();
    }

    function renderAssistantActions(host, content) {
      clear(host);
      host.append(
        h('button', {
          class: 'btn btn--sm btn--ghost',
          type: 'button',
          on: {
            click: async () => {
              try {
                const ok = await copyText(content);
                toast(ok ? 'Copied' : 'Copy failed — select the answer and copy it manually', {
                  tone: ok ? 'success' : 'danger',
                });
              } catch (err) { showError(err); }
            },
          },
        }, [icon('copy'), 'Copy']),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          on: { click: () => void saveAsLesson(content) },
        }, [icon('save'), 'Save as new lesson']),
      );
    }

    /** Never replaces an existing note — always creates a NEW lesson. */
    async function saveAsLesson(content) {
      try {
        const ok = await confirmDialog({
          title: 'Save as a new lesson?',
          message: 'This creates a NEW lesson that contains the assistant’s answer as its Markdown content. Your existing lessons are never changed.',
          confirmLabel: 'Create lesson',
        });
        if (!ok || disposed) return;

        const firstLine = String(content ?? '').split('\n').map((line) => line.trim()).find(Boolean) || '';
        const title = firstLine.replace(/^#+\s*/, '').trim().slice(0, 80) || 'Saved from the AI assistant';
        const lesson = await lessonsRepo.create({
          title,
          summary: 'Saved from the AI assistant',
          content,
          status: 'not-started',
          tags: ['ai-saved'],
        });
        toast('New lesson created from the assistant answer', { tone: 'success' });
        navigate(`/lesson/${encodeURIComponent(lesson.id)}`);
      } catch (err) {
        showError(err);
      }
    }

    /* ------------------------------------------------------------- requests */

    function buildMessages() {
      const system = `You are DevNotes, a concise programming tutor inside a personal knowledge app. Answer in ${prefs.aiOutputLanguage === 'my' ? 'Burmese' : 'English'}. Use Markdown; code blocks with language tags.`;
      return [
        { role: 'system', content: system },
        ...attachments.map((attached) => ({
          role: 'user',
          content: `Attached lesson context (${attached.title}):\n` + contextFromLesson(attached.lesson),
        })),
        ...history.slice(-MAX_HISTORY).map((entry) => ({ role: entry.role, content: entry.content })),
      ];
    }

    async function send(raw, { retry = false } = {}) {
      const text = String(raw ?? '').trim();
      if (!text || busy || disposed) return;

      // A stale Retry would duplicate history once the conversation moved on.
      if (!retry) disarmRetries();

      // A retry re-uses the already recorded user message instead of
      // duplicating it in history (and in the transcript).
      if (!(retry && failedUser === text)) {
        history.push({ role: 'user', content: text });
        addUserMessage(text);
      }
      failedUser = null;
      if (!retry) input.value = '';
      syncSend();

      const shell = thinkingShell();
      setBusy(true);
      abortCtl = new AbortController();
      stoppedByUser = false;

      try {
        const { content } = await chat({ messages: buildMessages(), expectJson: false, signal: abortCtl.signal });
        if (disposed) return;
        history.push({ role: 'assistant', content });
        shell.node.remove();
        try {
          // Rendering failures must not be reported as request failures.
          await showAssistantReply(content);
        } catch (err) { showError(err); }
      } catch (err) {
        if (disposed) return;
        if (stoppedByUser || abortCtl?.signal.aborted) {
          stoppedShell(shell);
        } else {
          failedUser = text;
          errorShell(shell, err, () => send(text, { retry: true }));
        }
      } finally {
        abortCtl = null;
        if (!disposed) setBusy(false);
      }
    }

    function stopStream() {
      stoppedByUser = true;
      abortCtl?.abort();
    }

    async function suggestFlashcards() {
      const attached = attachments[0];
      if (!attached || busy || disposed) return;

      const shell = thinkingShell('Drafting flashcards…');
      setBusy(true);
      abortCtl = new AbortController();
      stoppedByUser = false;
      try {
        const created = await generateCardDrafts(attached.lesson, { signal: abortCtl.signal });
        if (disposed) return;
        shell.node.remove();
        toast(`${created.length} drafts created — approve them in Review`, { tone: 'success' });
        showDraftStatus(created.length);
      } catch (err) {
        if (disposed) return;
        shell.node.remove();
        if (stoppedByUser || abortCtl?.signal.aborted) toast('Stopped.', { tone: 'info' });
        else showError(err);
      } finally {
        abortCtl = null;
        if (!disposed) setBusy(false);
      }
    }

    function showDraftStatus(count) {
      clear(draftHost);
      draftHost.appendChild(h('div', { class: 'row row--between' }, [
        h('span', {
          class: 'text-muted',
          style: { fontSize: 'var(--fs-xs)' },
          text: `${count} flashcard draft${count === 1 ? '' : 's'} saved unapproved — nothing enters the queue until you approve them.`,
        }),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          on: { click: () => navigate('/review') },
        }, [icon('review'), 'Open Review drafts']),
      ]));
    }

    function setBusy(next) {
      busy = next;
      stopBtn.hidden = !next;
      renderChips();
      renderQuickActions();
      syncSend();
    }

    function syncSend() {
      sendBtn.disabled = busy || !input.value.trim();
    }

    /** Disable Retry buttons of older failed bubbles (they would duplicate history). */
    function disarmRetries() {
      for (const btn of listEl.querySelectorAll('button[data-retry]')) {
        btn.disabled = true;
        btn.removeAttribute('data-retry');
      }
    }

    /* ---------------------------------------------------------- attachments */

    function attach(lesson) {
      if (busy || attachments.length >= MAX_ATTACHMENTS) return;
      if (attachments.some((entry) => entry.id === lesson.id)) return;
      attachments.push({ id: lesson.id, title: lesson.title, lesson });
      renderChips();
      renderQuickActions();
    }

    function detach(id) {
      attachments = attachments.filter((entry) => entry.id !== id);
      renderChips();
      renderQuickActions();
    }

    function renderChips() {
      clear(chipsHost);
      const blocked = !prefs.aiContextEnabled
        ? { disabled: '', title: 'Enable lesson context in Settings → AI' }
        : attachments.length >= MAX_ATTACHMENTS
          ? { disabled: '', title: `Maximum of ${MAX_ATTACHMENTS} lessons attached` }
          : busy
            ? { disabled: '', title: 'Wait for the current request to finish' }
            : {};

      chipsHost.appendChild(h('button', {
        class: 'btn btn--sm',
        type: 'button',
        attrs: blocked,
        on: { click: () => void openAttachDialog() },
      }, [icon('plus'), 'Attach lesson']));

      for (const attached of attachments) {
        chipsHost.appendChild(h('span', { class: 'chip' }, [
          h('span', { text: attached.title }),
          h('button', {
            type: 'button',
            attrs: { 'aria-label': `Detach ${attached.title}`, ...(busy ? { disabled: '' } : {}) },
            on: { click: () => detach(attached.id) },
          }, [icon('x')]),
        ]));
      }

      if (!prefs.aiContextEnabled) {
        chipsHost.appendChild(h('span', {
          class: 'text-muted',
          style: { fontSize: 'var(--fs-xs)' },
          text: 'Lesson context is off in Settings → AI.',
        }));
      } else if (attachments.length >= MAX_ATTACHMENTS) {
        chipsHost.appendChild(h('span', {
          class: 'text-muted',
          style: { fontSize: 'var(--fs-xs)' },
          text: `Maximum of ${MAX_ATTACHMENTS} lessons attached.`,
        }));
      }
    }

    function renderQuickActions() {
      clear(quickHost);
      if (!attachments.length) return;

      const quickActions = [
        {
          label: 'Explain this lesson',
          iconName: 'book',
          prompt: 'Explain the attached lesson in clear, simple terms, with one short example.',
        },
        {
          label: 'Summarize it',
          iconName: 'eye',
          prompt: 'Summarize the attached lesson in at most five bullet points.',
        },
        {
          label: 'Quiz me (5 questions)',
          iconName: 'flag',
          prompt: 'Quiz me with five short questions based on the attached lesson. Ask one question at a time and wait for my answer.',
        },
      ];
      const disabledAttrs = busy
        ? { disabled: '', title: 'Wait for the current request to finish' }
        : {};

      quickHost.appendChild(h('div', { class: 'action-grid' }, [
        ...quickActions.map((action) => h('button', {
          class: 'btn btn--sm',
          type: 'button',
          attrs: disabledAttrs,
          on: { click: () => void send(action.prompt) },
        }, [icon(action.iconName), action.label])),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          attrs: disabledAttrs,
          on: { click: () => void suggestFlashcards() },
        }, [icon('review'), 'Suggest flashcards']),
      ]));
    }

    async function openAttachDialog() {
      if (!prefs.aiContextEnabled || attachments.length >= MAX_ATTACHMENTS || busy || disposed) return;

      try {
        const [fresh, langs] = await Promise.all([lessonsRepo.getAll(), languagesRepo.getAll()]);
        if (disposed) return;
        lessons = fresh;
        languages = langs;
      } catch (err) {
        showError(err);
        return;
      }

      const langById = new Map(languages.map((entry) => [entry.id, entry]));
      const searchField = h('input', {
        class: 'input',
        type: 'search',
        id: 'assistant-attach-search',
        attrs: { placeholder: 'Search lessons…', autocomplete: 'off' },
      });
      const listHost = h('div', { class: 'list' });
      const hintEl = h('div', { class: 'field__hint' });

      const updateHint = () => {
        hintEl.textContent = attachments.length >= MAX_ATTACHMENTS
          ? `Maximum of ${MAX_ATTACHMENTS} lessons attached — detach one to change.`
          : `${attachments.length} of ${MAX_ATTACHMENTS} attached.`;
      };

      const renderPicks = () => {
        clear(listHost);
        const term = searchField.value.trim().toLowerCase();
        const rows = lessons
          .filter((lesson) => !term || lesson.title.toLowerCase().includes(term))
          .slice(0, 40);
        if (!rows.length) {
          listHost.appendChild(h('div', { class: 'list__row' }, [
            h('span', { class: 'text-muted', text: 'No lessons match.' }),
          ]));
          return;
        }
        for (const lesson of rows) {
          const isAttached = attachments.some((entry) => entry.id === lesson.id);
          const full = attachments.length >= MAX_ATTACHMENTS;
          listHost.appendChild(h('div', { class: 'list__row' }, [
            h('button', {
              class: 'list__row-main',
              type: 'button',
              attrs: isAttached || full ? { disabled: '' } : {},
              on: {
                click: () => {
                  attach(lesson);
                  updateHint();
                  renderPicks();
                },
              },
            }, [
              h('span', { class: 'list__row-title', text: lesson.title }),
              h('span', {
                class: 'list__row-sub',
                text: [langById.get(lesson.languageId)?.name, formatRelative(lesson.updatedAt)]
                  .filter(Boolean).join(' · '),
              }),
            ]),
            isAttached ? h('span', { class: 'badge badge--accent', text: 'Attached' }) : null,
          ]));
        }
      };

      updateHint();
      renderPicks();
      searchField.addEventListener('input', renderPicks);

      try {
        await openDialog({
          title: 'Attach a lesson',
          size: 'wide',
          initialFocus: searchField,
          body: h('div', { class: 'stack stack--sm' }, [
            h('div', { class: 'field' }, [
              h('label', { class: 'field__label', attrs: { for: 'assistant-attach-search' }, text: 'Search lessons' }),
              searchField,
            ]),
            hintEl,
            listHost,
          ]),
          actions: [{ label: 'Done', value: 'done', variant: 'primary' }],
        });
      } catch (err) {
        showError(err);
      }
    }

    /* ---------------------------------------------------------------- boot */

    async function boot() {
      try {
        const [fresh, langs] = await Promise.all([lessonsRepo.getAll(), languagesRepo.getAll()]);
        if (disposed) return;
        lessons = fresh;
        languages = langs;
        clear(bodyHost);
        bodyHost.appendChild(chatRoot);
        renderChips();
        renderQuickActions();
        syncSend();
      } catch (err) {
        if (disposed) return;
        console.error('[assistant] load failed:', err);
        clear(bodyHost);
        bodyHost.appendChild(emptyState({
          iconName: 'alert',
          title: 'The assistant could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
        }));
      }
    }

    function clearChat() {
      history = [];
      failedUser = null;
      clear(listEl);
      clear(draftHost);
      toast('Chat cleared', { tone: 'info' });
      if (!disposed) input.focus();
    }

    function showError(err) {
      console.error('[assistant] action failed:', err);
      toast(err?.message || 'That action failed', { tone: 'danger' });
    }

    /* ------------------------------------------------------------ listeners */

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void send(input.value);
      }
    });
    input.addEventListener('input', syncSend);

    // Keep attached lesson titles current (and drop attachments whose lesson
    // was trashed elsewhere) without ever touching the conversation itself.
    const refreshAttachments = debounce(async () => {
      if (disposed || !attachments.length) return;
      try {
        let changed = false;
        const next = [];
        for (const attached of attachments) {
          const fresh = await lessonsRepo.get(attached.id);
          if (!fresh || fresh.trashed) { changed = true; continue; }
          if (fresh.title !== attached.title) changed = true;
          next.push({ id: fresh.id, title: fresh.title, lesson: fresh });
        }
        if (disposed) return;
        attachments = next;
        if (changed) { renderChips(); renderQuickActions(); }
      } catch (err) {
        console.warn('[assistant] attachment refresh failed:', err?.message);
      }
    }, 250);
    const offData = bus.on('data:changed', refreshAttachments);

    syncSend();
    void boot();

    return {
      destroy() {
        disposed = true;
        offData();
        refreshAttachments.cancel?.();
        abortCtl?.abort();
      },
      onShow() { syncSend(); },
    };
  },
};
