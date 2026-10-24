/**
 * writing.js — contextual AI writing actions for the lesson editor.
 *
 * Flow: select text → floating "AI edit" toolbar appears → pick an action →
 * the suggestion opens in a preview dialog → nothing is written until the
 * user explicitly clicks "Apply" (AGENTS.md §13: AI never overwrites content
 * on its own; the original is always visible next to the suggestion).
 *
 * The toolbar shows only when AI is enabled *and* configured, so there are
 * no dead controls when AI is off.
 */

import { h } from '../../utils/dom.js';
import { icon } from '../../utils/icons.js';
import { toast } from '../../components/toast.js';
import { openMenu } from '../../components/menu.js';
import { openDialog } from '../../components/dialog.js';
import { inlineNote } from '../../components/feedback.js';
import { copyText } from '../../utils/clipboard.js';
import { chat, isAiConfigured } from './ai-service.js';
import { getPrefs } from '../settings/prefs.js';
import { AI } from '../../config.js';

// Reuse the existing context cap so a selection can never blow past the
// request budget the rest of the app already enforces.
const MAX_SELECTION_CHARS = AI.maxContextChars;

const SYSTEM_PROMPT = 'You are a text-editing assistant inside a Markdown lesson editor. '
  + 'Return ONLY the edited text — no preamble, no explanations, no code fences around it. '
  + 'Preserve Markdown syntax; keep code blocks and inline code exactly as they are '
  + '(except when translating prose). '
  + 'Respond in the same language as the selected text unless a translation is requested.';

function translateInstruction() {
  return getPrefs().translateDirection === 'my-en'
    ? 'Translate into English.'
    : 'Translate into Burmese (Myanmar language).';
}

export const WRITING_ACTIONS = [
  {
    id: 'improve',
    label: 'Improve writing',
    iconName: 'sparkles',
    instruction: 'Improve the writing: clearer wording, better flow, natural tone. Keep the meaning and the approximate length.',
  },
  {
    id: 'rewrite',
    label: 'Rewrite',
    iconName: 'edit',
    instruction: 'Rewrite with different wording and structure. Keep the meaning.',
  },
  {
    id: 'explain',
    label: 'Explain',
    iconName: 'book',
    instruction: 'Explain this passage in simple, tutor-style prose with one short example.',
  },
  {
    id: 'expand',
    label: 'Expand',
    iconName: 'maximize',
    instruction: 'Add useful detail, edge cases or a short example while keeping every original point.',
  },
  {
    id: 'shorten',
    label: 'Shorten',
    iconName: 'minimize',
    instruction: 'Make it more concise without losing key information.',
  },
  {
    id: 'grammar',
    label: 'Fix grammar',
    iconName: 'check',
    instruction: 'Fix grammar, spelling and punctuation only. Do not reword or change the meaning.',
  },
  {
    id: 'translate',
    label: 'Translate',
    iconName: 'languages',
    instruction: () => `${translateInstruction()} Keep code blocks, inline code and Markdown syntax unchanged.`,
  },
];

const SELECTION_EVENTS = ['input', 'keyup', 'mouseup', 'focus'];

/**
 * Attach the contextual toolbar to a textarea.
 * @param {HTMLTextAreaElement} textarea
 * @param {{getLessonTitle?: () => string}} [options]
 * @returns {{destroy: () => void, refresh: () => void}}
 */
export function attachWritingToolbar(textarea, { getLessonTitle = () => '' } = {}) {
  if (!textarea) return { destroy() {}, refresh() {} };

  let busy = false;
  let destroyed = false;
  let abortCtl = null;

  const aiAvailable = () => {
    try {
      return getPrefs().aiEnabled && isAiConfigured();
    } catch {
      return false;
    }
  };

  const trigger = h('button', {
    class: 'btn btn--sm',
    type: 'button',
    attrs: { 'aria-haspopup': 'menu' },
    on: { click: (event) => openActions(event.currentTarget) },
  }, [icon('sparkles'), h('span', { text: 'AI edit' })]);

  const toolbar = h('div', {
    class: 'ai-toolbar',
    attrs: { role: 'toolbar', 'aria-label': 'AI writing actions' },
    hidden: true,
  }, [trigger]);
  (textarea.closest('.field') || textarea.parentElement || textarea).appendChild(toolbar);

  function selectionInfo() {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (start === end) return null;
    const text = textarea.value.slice(start, end);
    if (!text.trim()) return null;
    return { start, end, text };
  }

  function refresh() {
    if (destroyed) return;
    const available = aiAvailable();
    const show = available && (busy || Boolean(selectionInfo()));
    toolbar.hidden = !show;
  }

  function setBusyUi(next) {
    busy = next;
    trigger.replaceChildren(icon('sparkles'), h('span', { text: next ? 'Working…' : 'AI edit' }));
    trigger.disabled = next;
    if (next) toolbar.hidden = false;
  }

  function openActions(anchor) {
    const selection = selectionInfo();
    if (!selection || busy) return;
    openMenu(anchor, WRITING_ACTIONS.map((action) => ({
      label: action.label,
      icon: action.iconName,
      hint: action.id === 'translate'
        ? (getPrefs().translateDirection === 'my-en' ? 'MY → EN' : 'EN → MY')
        : undefined,
      onSelect: () => void runAction(action),
    })));
  }

  async function runAction(action) {
    // Read the selection after the menu interaction: the textarea keeps its
    // selection while focus moves around.
    const selection = selectionInfo();
    if (!selection || busy || destroyed) return;

    if (selection.text.length > MAX_SELECTION_CHARS) {
      toast(
        `Select a shorter passage — up to about ${MAX_SELECTION_CHARS.toLocaleString()} characters.`,
        { tone: 'warning' },
      );
      return;
    }

    const lessonTitle = getLessonTitle();
    setBusyUi(true);
    abortCtl = new AbortController();
    try {
      const instruction = typeof action.instruction === 'function'
        ? action.instruction()
        : action.instruction;
      const { content } = await chat({
        signal: abortCtl.signal,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `${instruction}${lessonTitle ? `\n\nLesson: ${lessonTitle}` : ''}\n\nSelected text:\n"""\n${selection.text}\n"""`,
          },
        ],
      });
      if (destroyed) return;
      await previewSuggestion(action, selection, stripOuterFences(content.trim()));
    } catch (err) {
      if (destroyed) return;
      toast(String(err?.message || err), { tone: 'danger' });
    } finally {
      if (!destroyed) {
        setBusyUi(false);
        refresh();
      }
      abortCtl = null;
    }
  }

  async function previewSuggestion(action, selection, suggestion) {
    if (!suggestion) {
      toast('The AI returned an empty suggestion.', { tone: 'warning' });
      return;
    }

    const suggestionField = h('textarea', {
      class: 'textarea',
      attrs: { readonly: '', rows: '9', 'aria-label': `AI suggestion (${action.label})` },
    });
    suggestionField.value = suggestion;
    const originalField = h('textarea', {
      class: 'textarea',
      attrs: { readonly: '', rows: '4', 'aria-label': 'Selected original text' },
    });
    originalField.value = selection.text;

    const value = await openDialog({
      title: `AI suggestion — ${action.label}`,
      size: 'wide',
      body: h('div', { class: 'stack stack--sm' }, [
        inlineNote('Review the suggestion — nothing changes until you apply it.', 'info'),
        h('div', { class: 'field' }, [
          h('span', { class: 'field__label', text: 'Suggested' }),
          suggestionField,
        ]),
        h('div', { class: 'field' }, [
          h('span', { class: 'field__label', text: 'Original (your selection)' }),
          originalField,
        ]),
      ]),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Copy',
          value: null,
          closeOnClick: false,
          onClick: async () => {
            const ok = await copyText(suggestion);
            toast(ok ? 'Suggestion copied' : 'Copy failed — select the text and copy it manually', {
              tone: ok ? 'success' : 'danger',
            });
          },
        },
        { label: 'Apply changes', value: 'apply', variant: 'primary' },
      ],
    });

    if (value === 'apply' && !destroyed) applySuggestion(selection, suggestion);
  }

  function applySuggestion(selection, suggestion) {
    // The dialog is modal, but never write into text that is no longer the
    // one the suggestion was written for.
    if (textarea.value.slice(selection.start, selection.end) !== selection.text) {
      toast('The selection changed — nothing was applied.', { tone: 'warning' });
      return;
    }
    textarea.setRangeText(suggestion, selection.start, selection.end, 'end');
    // setRangeText fires no input event — dispatch it so autosave and the
    // live preview pick the change up through the editor's normal path.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const end = selection.start + suggestion.length;
    textarea.setSelectionRange(end, end);
    textarea.focus();
    toast('AI suggestion applied', { tone: 'success' });
    refresh();
  }

  /** Models sometimes wrap output in fences anyway — unwrap defensively. */
  function stripOuterFences(text) {
    const match = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```\s*$/);
    return match ? match[1].trim() : text;
  }

  const onSelectionChange = () => refresh();
  document.addEventListener('selectionchange', onSelectionChange);
  for (const type of SELECTION_EVENTS) textarea.addEventListener(type, onSelectionChange);
  // Keep focus (and the selection) in the textarea when the toolbar is used.
  const keepSelection = (event) => {
    if (toolbar.contains(event.target)) event.preventDefault();
  };
  toolbar.addEventListener('pointerdown', keepSelection);

  refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      document.removeEventListener('selectionchange', onSelectionChange);
      for (const type of SELECTION_EVENTS) textarea.removeEventListener(type, onSelectionChange);
      toolbar.removeEventListener('pointerdown', keepSelection);
      abortCtl?.abort();
      toolbar.remove();
    },
  };
}
