/**
 * assistant.js — optional AI chat page with persistent, local-only history.
 *
 * AI is never required (AGENTS.md §13): when it is not configured the page
 * explains how to set it up and stops — no composer, no dead controls.
 *
 * Conversation history lives in IndexedDB (`conversations` store) and never
 * syncs to Supabase: the repository enqueues nothing (AGENTS.md §12/§13).
 * Nothing the model says is ever written into an existing note. The only
 * write path is "Save as new lesson", which always creates a brand-new record
 * after an explicit confirmation.
 *
 * Replies stream in (streamChat) with throttled Markdown rendering; Stop keeps
 * whatever arrived, and an interrupted stream shows its partial text next to a
 * Retry instead of losing it.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { toast } from '../components/toast.js';
import { openDialog, confirmDialog, promptDialog } from '../components/dialog.js';
import { openMenu } from '../components/menu.js';
import { emptyState, skeleton } from '../components/feedback.js';
import { lessonsRepo, languagesRepo, conversationsRepo } from '../db/repositories/index.js';
import {
  streamChat, usageTotals, contextFromLesson, isAiConfigured, describeAiSetup,
  getAiMode, generateCardDrafts,
} from '../features/ai/ai-service.js';
import { getPrefs } from '../features/settings/prefs.js';
import { renderMarkdown } from '../utils/markdown.js';
import { hydrateCodeBlocks } from '../components/code-block.js';
import { copyText } from '../utils/clipboard.js';
import { formatRelative, formatNumber } from '../utils/format.js';

const MAX_ATTACHMENTS = 2;
// streamChat() rejects more than 40 message items: 1 system + 2 attachments + history.
const MAX_HISTORY = 30;
const NEW_CHAT_TITLE = 'New chat';
// Re-render streamed Markdown at most this often (tokens arrive far faster).
const STREAM_RENDER_MS = 100;

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
    let current = null;      // conversation record (id === null → unsaved draft)
    let attachments = [];    // [{id, title, lesson|null}] hydrated lesson refs
    let summaries = [];      // sidebar rows (transcripts stripped)
    let lessons = [];
    let languages = [];
    let busy = false;
    let abortCtl = null;
    let stoppedByUser = false;
    let streamTimer = null;  // throttled Markdown re-render during streaming
    let streamSeq = 0;       // drop stale async renders (last writer wins)
    let stickBottom = true;  // only auto-scroll while the user is at the bottom

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
      attrs: { title: 'Remove all messages from this conversation' },
      on: { click: () => void clearChat() },
    }, [icon('trash'), 'Clear chat']);
    const newBtn = h('button', {
      class: 'btn btn--primary',
      type: 'button',
      on: { click: () => void newChat() },
    }, [icon('plus'), 'New chat']);
    header.appendChild(h('div', { class: 'page-header__actions' }, [newBtn, clearBtn]));

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
      h('span', { text: 'Stored locally on this device — chat history is never synced to the cloud.' }),
    ]);

    const chatRoot = h('div', { class: 'chat' }, [listEl, chipsHost, quickHost, composer, hintLine, draftHost]);
    const bodyHost = h('div', { class: 'stack stack--sm' }, [skeleton({ count: 2, variant: 'title' })]);

    const convList = h('ul', { class: 'conv-list' }, [
      h('li', {}, [skeleton({ count: 2, variant: 'title' })]),
    ]);
    const convPanel = h('aside', { class: 'conv-panel', attrs: { 'aria-label': 'Conversations' } }, [
      h('div', { class: 'conv-panel__head' }, [
        h('h2', { class: 'conv-panel__title', text: 'Conversations' }),
      ]),
      convList,
    ]);
    const mainHost = h('div', { class: 'assistant-main' }, [bodyHost]);
    root.appendChild(h('div', { class: 'assistant-layout' }, [convPanel, mainHost]));

    /* ------------------------------------------------------- conversation UI */

    function newDraft() {
      const now = Date.now();
      return {
        id: null, title: NEW_CHAT_TITLE, createdAt: now, updatedAt: now, lastOpenedAt: now,
        messages: [], attachments: [], model: null,
      };
    }

    function titleFrom(text) {
      const single = String(text).replace(/\s+/g, ' ').trim();
      return single.slice(0, 60) || NEW_CHAT_TITLE;
    }

    const persistAttachments = () => attachments
      .filter((entry) => entry.id)
      .map((entry) => ({ lessonId: entry.id, title: entry.title }));

    /** Rehydrate stored references; a missing/trashed lesson keeps its title. */
    function hydrateAttachments(refs) {
      return (Array.isArray(refs) ? refs : [])
        .filter((ref) => ref && typeof ref.lessonId === 'string')
        .map((ref) => {
          const lesson = lessons.find((entry) => entry.id === ref.lessonId && !entry.trashed) || null;
          return { id: ref.lessonId, title: lesson?.title || ref.title || 'Attached lesson', lesson };
        })
        .slice(0, MAX_ATTACHMENTS);
    }

    function renderConversations() {
      clear(convList);
      if (!summaries.length) {
        convList.appendChild(h('li', { class: 'conv-empty', text: 'No conversations yet.' }));
        return;
      }
      for (const item of summaries) {
        const active = current?.id === item.id;
        convList.appendChild(h('li', { class: 'conv-item', dataset: active ? { active: 'true' } : {} }, [
          h('button', {
            class: 'conv-item__open',
            type: 'button',
            attrs: active ? { 'aria-current': 'true' } : {},
            on: { click: () => void openConversation(item.id) },
          }, [
            h('span', { class: 'conv-item__title', text: item.title }),
            h('span', {
              class: 'conv-item__meta',
              text: `${item.messageCount} message${item.messageCount === 1 ? '' : 's'} · ${formatRelative(item.lastOpenedAt ?? item.updatedAt)}`,
            }),
          ]),
          h('button', {
            class: 'icon-btn conv-item__menu',
            type: 'button',
            attrs: { 'aria-label': `Actions for ${item.title}`, 'aria-haspopup': 'menu' },
            on: { click: (event) => openConversationMenu(event.currentTarget, item) },
          }, [icon('more')]),
        ]));
      }
    }

    async function updateConversationList() {
      if (disposed) return;
      try {
        summaries = await conversationsRepo.listSummaries();
        if (!disposed) renderConversations();
      } catch (err) {
        console.warn('[assistant] conversation list refresh failed:', err);
      }
    }

    function openConversationMenu(anchor, item) {
      openMenu(anchor, [
        { label: 'Rename', icon: 'edit', onSelect: () => void renameConversation(item) },
        { label: 'Delete', icon: 'trash', danger: true, onSelect: () => void deleteConversation(item) },
      ], { align: 'end' });
    }

    async function renameConversation(item) {
      if (guardBusy()) return;
      const title = await promptDialog({
        title: 'Rename conversation',
        label: 'Title',
        value: item.title,
        confirmLabel: 'Rename',
        validate: (value) => (value.trim() ? '' : 'A title is required'),
      });
      if (!title || disposed) return;
      try {
        await conversationsRepo.rename(item.id, title);
        if (current?.id === item.id) current.title = title;
        await updateConversationList();
        toast('Conversation renamed', { tone: 'success' });
      } catch (err) {
        showError(err);
      }
    }

    async function deleteConversation(item) {
      if (guardBusy()) return;
      const ok = await confirmDialog({
        title: 'Delete this conversation?',
        message: `“${item.title}” and its messages are permanently removed from this device.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok || disposed) return;
      try {
        await conversationsRepo.remove(item.id);
        if (current?.id === item.id) await startFresh();
        await updateConversationList();
        toast('Conversation deleted', { tone: 'success' });
      } catch (err) {
        showError(err);
      }
    }

    async function startFresh() {
      current = newDraft();
      attachments = [];
      clear(listEl);
      showEmptyChat();
      clear(draftHost);
      renderChips();
      renderQuickActions();
      syncSend();
    }

    async function newChat() {
      if (guardBusy()) return;
      await startFresh();
      await updateConversationList();
      input.focus();
    }

    async function clearChat() {
      if (guardBusy()) return;
      if (!current.messages.length && !attachments.length) {
        toast('Nothing to clear yet.', { tone: 'info' });
        return;
      }
      const ok = await confirmDialog({
        title: 'Clear this conversation?',
        message: 'All messages in this conversation are removed from this device. Other conversations are untouched.',
        confirmLabel: 'Clear messages',
        danger: true,
      });
      if (!ok || disposed) return;
      current.messages = [];
      if (current.id) {
        try {
          await conversationsRepo.save(current.id, { messages: [], attachments: persistAttachments() });
        } catch (err) {
          showError(err);
          return;
        }
      }
      clear(listEl);
      showEmptyChat();
      clear(draftHost);
      await updateConversationList();
      toast('Conversation cleared', { tone: 'info' });
      input.focus();
    }

    async function openConversation(id) {
      if (guardBusy()) return;
      if (current?.id === id) return;
      try {
        const conversation = await conversationsRepo.get(id);
        if (!conversation || disposed) return;
        current = conversation;
        attachments = hydrateAttachments(conversation.attachments);
        await conversationsRepo.touch(id).catch(() => { /* ordering is best-effort */ });
        stickBottom = true;
        await renderConversation(current);
        if (disposed) return;
        clear(draftHost);
        renderChips();
        renderQuickActions();
        syncSend();
        await updateConversationList();
      } catch (err) {
        showError(err);
      }
    }

    /** Wait for the current streamed reply instead of switching state mid-flight. */
    function guardBusy() {
      if (!busy) return false;
      toast('Wait for the current response to finish.', { tone: 'info' });
      return true;
    }

    /* ------------------------------------------------------------ messages */

    function isNearBottom() {
      return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 56;
    }

    function scrollToBottom(force = false) {
      if (force || stickBottom) listEl.scrollTop = listEl.scrollHeight;
    }

    listEl.addEventListener('scroll', () => {
      stickBottom = isNearBottom();
    });

    function showEmptyChat() {
      clear(listEl);
      listEl.appendChild(emptyState({
        iconName: 'sparkles',
        title: 'Start a conversation',
        text: 'Ask a programming question — or attach a lesson for context. Chats stay on this device only.',
      }));
    }

    function addUserMessage(message) {
      const emptyEl = listEl.querySelector('.empty-state');
      if (emptyEl) emptyEl.remove();
      listEl.appendChild(h('div', { class: 'chat__msg', dataset: { role: 'user' } }, [
        h('span', { class: 'chat__avatar' }, [icon('user')]),
        h('div', { class: 'chat__bubble', text: message.content }),
      ]));
      stickBottom = true;
      scrollToBottom(true);
    }

    function newAssistantShell({ thinking = '' } = {}) {
      const preview = h('div', { class: 'md markdown-body' });
      const meta = h('div', { class: 'chat__meta' });
      const actions = h('div', { class: 'row', style: { marginTop: 'var(--sp-2)' } });
      const node = h('div', { class: 'chat__msg', dataset: { role: 'assistant' } }, [
        h('span', { class: 'chat__avatar' }, [icon('sparkles')]),
        h('div', { class: 'chat__bubble' }, [preview, meta, actions]),
      ]);
      listEl.appendChild(node);
      if (thinking) preview.appendChild(h('p', { class: 'text-muted', text: thinking }));
      scrollToBottom();
      return { node, preview, meta, actions };
    }

    /** Placeholder shown while a request is in flight. */
    function thinkingShell(label = 'Thinking…') {
      return newAssistantShell({ thinking: label });
    }

    function stoppedShell(shell) {
      clear(shell.preview);
      clear(shell.actions);
      clear(shell.meta);
      shell.preview.appendChild(h('p', { class: 'text-muted', text: 'Stopped.' }));
      scrollToBottom();
    }

    function retryButton(shell, retryFn) {
      // Drop the failed bubble: the retry replaces it with a fresh
      // "Thinking…" placeholder (and a new error if it fails again).
      // Guard `busy` first, otherwise a click during an in-flight request
      // would delete the bubble without sending anything.
      return h('button', {
        class: 'btn btn--sm',
        type: 'button',
        dataset: { retry: '' },
        on: {
          click: () => {
            if (busy || disposed) return;
            shell.node.remove();
            void retryFn();
          },
        },
      }, [icon('refresh'), 'Retry']);
    }

    function errorShell(shell, err, retryFn) {
      clear(shell.preview);
      clear(shell.actions);
      clear(shell.meta);
      shell.preview.appendChild(h('div', { class: 'chat__error', text: String(err?.message || err) }));
      if (retryFn) shell.actions.appendChild(retryButton(shell, retryFn));
      scrollToBottom();
    }

    async function markdownHtml(text) {
      try {
        return await renderMarkdown(text, {});
      } catch (err) {
        console.error('[assistant] markdown render failed:', err);
        return null;
      }
    }

    /** Throttled frame during streaming: render + a blinking caret. */
    async function renderStreamFrame(shell, text) {
      const seq = ++streamSeq;
      const html = await markdownHtml(text);
      if (disposed || seq !== streamSeq) return;
      if (html === null) shell.preview.textContent = String(text ?? '');
      else {
        shell.preview.innerHTML = html; // sanitized by utils/sanitize.js
        hydrateCodeBlocks(shell.preview);
      }
      shell.preview.appendChild(h('span', { class: 'chat__cursor', attrs: { 'aria-hidden': 'true' } }));
      scrollToBottom();
    }

    function scheduleStreamRender(shell, getState) {
      if (streamTimer) return;
      streamTimer = setTimeout(() => {
        streamTimer = null;
        if (disposed) return;
        void renderStreamFrame(shell, getState());
      }, STREAM_RENDER_MS);
    }

    /** Final frame: invalidate in-flight renders, no caret. */
    async function renderFinal(shell, text) {
      const seq = ++streamSeq;
      const html = await markdownHtml(text);
      if (disposed || seq !== streamSeq) return;
      if (html === null) shell.preview.textContent = String(text ?? '');
      else {
        shell.preview.innerHTML = html;
        hydrateCodeBlocks(shell.preview);
      }
      scrollToBottom();
    }

    function renderMessageMeta(host, message) {
      clear(host);
      const bits = [];
      if (message.createdAt) bits.push(formatRelative(message.createdAt));
      const totals = usageTotals(message.usage);
      if (totals) {
        const parts = [];
        if (totals.prompt !== null) parts.push(`${formatNumber(totals.prompt)} in`);
        if (totals.completion !== null) parts.push(`${formatNumber(totals.completion)} out`);
        bits.push(`${parts.join(' / ')} tokens`);
      }
      if (message.note === 'stopped') bits.push('Stopped');
      if (!bits.length) return;
      for (const text of bits) host.appendChild(h('span', { text }));
    }

    function renderAssistantActions(host, content, { isLast = false } = {}) {
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
        isLast
          ? h('button', {
              class: 'btn btn--sm',
              type: 'button',
              dataset: { regenerate: '' },
              attrs: { title: 'Ask again for a fresh answer to the same question' },
              on: { click: () => void regenerate() },
            }, [icon('refresh'), 'Regenerate'])
          : null,
      );
    }

    /** Keep exactly one Regenerate — on the newest answer — and sync its state. */
    function refreshRegenerateButtons() {
      const buttons = [...listEl.querySelectorAll('button[data-regenerate]')];
      const keep = buttons[buttons.length - 1];
      for (const button of buttons.slice(0, -1)) button.remove();
      const lastIsAssistant = current?.messages?.[current.messages.length - 1]?.role === 'assistant';
      if (keep) keep.disabled = busy || disposed || !lastIsAssistant;
    }

    async function fillShell(shell, message) {
      const html = await markdownHtml(message.content);
      if (disposed) return;
      if (html === null) shell.preview.textContent = String(message.content ?? '');
      else {
        shell.preview.innerHTML = html;
        hydrateCodeBlocks(shell.preview);
      }
      renderMessageMeta(shell.meta, message);
      const isLast = current?.messages?.[current.messages.length - 1] === message;
      renderAssistantActions(shell.actions, message.content, { isLast });
      refreshRegenerateButtons();
      scrollToBottom();
    }

    /** Render a whole stored transcript (or the empty state). */
    async function renderConversation(conversation) {
      clear(listEl);
      if (!conversation.messages.length) {
        showEmptyChat();
        return;
      }
      for (const message of conversation.messages) {
        if (disposed) return;
        if (message.role === 'user') {
          const emptyEl = listEl.querySelector('.empty-state');
          if (emptyEl) emptyEl.remove();
          listEl.appendChild(h('div', { class: 'chat__msg', dataset: { role: 'user' } }, [
            h('span', { class: 'chat__avatar' }, [icon('user')]),
            h('div', { class: 'chat__bubble', text: message.content }),
          ]));
        } else {
          const shell = newAssistantShell();
          await fillShell(shell, message);
        }
      }
      refreshRegenerateButtons();
      stickBottom = true;
      scrollToBottom(true);
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

    /* --------------------------------------------------------- persistence */

    /**
     * Memory is the source of truth for the open conversation; IndexedDB is
     * written best-effort with a visible warning (local-first: a storage
     * failure must never eat what the user can already see).
     */
    async function persistUserMessage(message) {
      current.messages.push(message);
      if (!current.id) {
        try {
          current = await conversationsRepo.create({
            title: current.title === NEW_CHAT_TITLE ? titleFrom(message.content) : current.title,
            messages: current.messages,
            attachments: persistAttachments(),
            model: prefs.aiModel,
          });
        } catch (err) {
          console.warn('[assistant] conversation not saved:', err);
          toast('This chat could not be saved to local history — check browser storage.', { tone: 'danger' });
        }
      } else {
        try {
          await conversationsRepo.appendMessage(current.id, message);
          current.updatedAt = Date.now();
        } catch (err) {
          console.warn('[assistant] message not saved:', err);
          toast('This message could not be saved to local history.', { tone: 'danger' });
        }
      }
    }

    async function persistAssistantMessage(fields) {
      const message = {
        role: 'assistant',
        content: fields.content,
        createdAt: Date.now(),
        ...(usageTotals(fields.usage) ? { usage: usageTotals(fields.usage) } : {}),
        ...(fields.model ? { model: fields.model } : {}),
        ...(fields.note ? { note: fields.note } : {}),
      };
      current.messages.push(message);
      if (!current.id) {
        try {
          current = await conversationsRepo.create({
            title: current.title,
            messages: current.messages,
            attachments: persistAttachments(),
          });
        } catch (err) {
          console.warn('[assistant] conversation not saved:', err);
        }
      } else {
        try {
          await conversationsRepo.appendMessage(current.id, message);
          current.updatedAt = Date.now();
        } catch (err) {
          console.warn('[assistant] reply not saved:', err);
          toast('The reply could not be saved to local history.', { tone: 'danger' });
        }
      }
      await updateConversationList();
      return message;
    }

    /* ------------------------------------------------------------- requests */

    function buildMessages() {
      const system = `You are DevNotes, a concise programming tutor inside a personal knowledge app. Answer in ${prefs.aiOutputLanguage === 'my' ? 'Burmese' : 'English'}. Use Markdown; code blocks with language tags.`;
      return [
        { role: 'system', content: system },
        ...attachments
          .filter((attached) => attached.lesson)
          .map((attached) => ({
            role: 'user',
            content: `Attached lesson context (${attached.title}):\n` + contextFromLesson(attached.lesson),
          })),
        ...current.messages.slice(-MAX_HISTORY).map((message) => ({ role: message.role, content: message.content })),
      ];
    }

    /** Shared request path for send(), Retry and Regenerate. */
    async function runReply() {
      const shell = thinkingShell();
      setBusy(true);
      abortCtl = new AbortController();
      stoppedByUser = false;

      let latest = '';
      let firstDelta = true;

      try {
        const result = await streamChat({
          messages: buildMessages(),
          signal: abortCtl.signal,
          onDelta: (text) => {
            latest = text;
            if (firstDelta) {
              firstDelta = false;
              clear(shell.preview);
              clear(shell.actions);
            }
            scheduleStreamRender(shell, () => latest);
          },
        });
        if (disposed) return;
        clearTimeout(streamTimer);
        streamTimer = null;

        const content = result.content;
        if (result.stopped || stoppedByUser) {
          if (content.trim()) {
            await renderFinal(shell, content);
            if (disposed) return;
            renderMessageMeta(shell.meta, { createdAt: Date.now(), note: 'stopped', usage: result.usage });
            renderAssistantActions(shell.actions, content, { isLast: true });
            await persistAssistantMessage({ content, note: 'stopped', usage: result.usage, model: result.model });
          } else {
            stoppedShell(shell);
          }
          refreshRegenerateButtons();
          return;
        }

        await renderFinal(shell, content);
        if (disposed) return;
        const message = await persistAssistantMessage({ content, usage: result.usage, model: result.model });
        if (disposed) return;
        renderMessageMeta(shell.meta, message);
        renderAssistantActions(shell.actions, content, { isLast: true });
        refreshRegenerateButtons();
      } catch (err) {
        if (disposed) return;
        clearTimeout(streamTimer);
        streamTimer = null;

        if (stoppedByUser || abortCtl?.signal?.aborted) {
          // Stop: keep whatever arrived on screen and in history.
          const partial = latest.trim() ? latest : '';
          if (partial) {
            await renderFinal(shell, partial);
            if (disposed) return;
            renderMessageMeta(shell.meta, { createdAt: Date.now(), note: 'stopped' });
            renderAssistantActions(shell.actions, partial, { isLast: true });
            await persistAssistantMessage({ content: partial, note: 'stopped' });
            refreshRegenerateButtons();
          } else {
            stoppedShell(shell);
          }
          return;
        }

        const partial = typeof err?.partial === 'string' && err.partial.trim() ? err.partial : '';
        if (partial) {
          // Interrupted mid-stream: show what arrived next to the error so a
          // network blip never wipes text the user already read.
          await renderFinal(shell, partial);
          if (disposed) return;
          clear(shell.actions);
          shell.actions.append(
            h('div', { class: 'chat__error', text: String(err?.message || err) }),
            retryButton(shell, () => runReply()),
          );
          scrollToBottom();
          return;
        }
        errorShell(shell, err, () => runReply());
      } finally {
        abortCtl = null;
        if (!disposed) setBusy(false);
      }
    }

    async function send(raw) {
      const text = String(raw ?? '').trim();
      if (!text || busy || disposed) return;
      disarmRetries();

      const message = { role: 'user', content: text, createdAt: Date.now() };
      addUserMessage(message);
      input.value = '';
      syncSend();

      await persistUserMessage(message);
      if (disposed) return;
      await updateConversationList();
      await runReply();
    }

    /** Re-ask the last question, replacing the newest answer. */
    async function regenerate() {
      if (disposed || guardBusy()) return;
      const messages = current?.messages || [];
      if (!messages.length || messages[messages.length - 1].role !== 'assistant') return;

      disarmRetries();
      const trimmed = messages.slice(0, -1);
      current.messages = trimmed;
      if (current.id) {
        try {
          await conversationsRepo.save(current.id, { messages: trimmed, attachments: persistAttachments() });
        } catch (err) {
          showError(err);
          return;
        }
      }
      const nodes = [...listEl.querySelectorAll('.chat__msg[data-role="assistant"]')];
      nodes[nodes.length - 1]?.remove();
      await updateConversationList();
      if (!disposed) await runReply();
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
      newBtn.disabled = next;
      clearBtn.disabled = next;
      // Streamed updates must not spam screen readers token by token.
      listEl.setAttribute('aria-live', next ? 'off' : 'polite');
      renderChips();
      renderQuickActions();
      refreshRegenerateButtons();
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
      afterAttachmentsChanged();
    }

    function detach(id) {
      attachments = attachments.filter((entry) => entry.id !== id);
      afterAttachmentsChanged();
    }

    function afterAttachmentsChanged() {
      renderChips();
      renderQuickActions();
      if (current?.id) {
        // Reference list only — a failed chip write must not break the chat.
        conversationsRepo.save(current.id, { attachments: persistAttachments() })
          .catch((err) => console.warn('[assistant] attachment save failed:', err));
      }
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
        const [fresh, langs, conversations] = await Promise.all([
          lessonsRepo.getAll(),
          languagesRepo.getAll(),
          conversationsRepo.list(),
        ]);
        if (disposed) return;
        lessons = fresh;
        languages = langs;

        const mostRecent = conversations[0] || null;
        if (mostRecent) {
          await conversationsRepo.touch(mostRecent.id).catch(() => { /* ordering is best-effort */ });
          current = { ...mostRecent };
        } else {
          current = newDraft();
        }
        attachments = hydrateAttachments(current.attachments);

        clear(bodyHost);
        bodyHost.appendChild(chatRoot);
        renderChips();
        renderQuickActions();
        await renderConversation(current);
        if (disposed) return;
        await updateConversationList();
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
        clear(convList);
        convList.appendChild(h('li', { class: 'conv-empty', text: 'Could not load conversations.' }));
      }
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

    // Keep attached lesson titles current (and drop context for lessons that
    // were trashed elsewhere) without ever touching the conversation itself.
    const refreshAttachments = debounce(async () => {
      if (disposed || !attachments.length) return;
      try {
        let changed = false;
        const next = [];
        for (const attached of attachments) {
          const fresh = await lessonsRepo.get(attached.id);
          if (!fresh || fresh.trashed) {
            // Keep the stored reference (it belongs to the conversation) but
            // stop sending context for a lesson that no longer exists.
            if (attached.lesson) changed = true;
            next.push({ ...attached, lesson: null });
            continue;
          }
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
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
      },
      onShow() { syncSend(); },
    };
  },
};
