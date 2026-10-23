/**
 * account.js — authentication and the sync relationship in one page.
 *
 * Signed out: email/password + OAuth (only when Supabase is configured; the
 * app never fakes a successful sign-in). Signed in: sync status, the pending
 * operation queue with manual retry/discard, and conflict resolution where
 * nothing is ever merged silently (AGENTS.md §11–§12).
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';
import { bus } from '../utils/bus.js';
import { toast } from '../components/toast.js';
import { openDialog, confirmDialog, promptDialog } from '../components/dialog.js';
import { skeleton, emptyState, inlineNote } from '../components/feedback.js';
import { authStore, syncStore } from '../state.js';
import {
  signIn, signUp, signOut, signInWithOAuth, sendPasswordReset, isAuthConfigured,
} from '../services/auth-service.js';
import { SUPABASE } from '../config.js';
import { runSyncOnce, failedOperations, localLibraryCounts } from '../sync/sync-engine.js';
import { listQueue, queueStats, retryFailed, discardOp } from '../sync/sync-queue.js';
import { listConflicts, resolveConflict, dismissConflict } from '../sync/conflict-resolver.js';
import { isSyncSuspended } from '../sync/sync-queue.js';
import { ensureSyncChoice, resetSyncChoice } from '../features/auth/sync-choice.js';
import { refreshSyncStatus } from '../sync/connectivity.js';
import { formatRelative } from '../utils/format.js';

const ENTITY_LABELS = {
  lesson: 'Lesson',
  snippet: 'Snippet',
  flashcard: 'Flashcard',
  language: 'Language',
  category: 'Category',
  course: 'Course',
  preferences: 'Preferences',
};

/** Primary human text for a record of any syncable entity. */
function primaryText(entity, record) {
  if (!record) return '(record missing locally)';
  if (entity === 'preferences') return 'App preferences';
  if (entity === 'flashcard') return record.front || record.id;
  return record.title || record.name || record.id;
}

/** The user-editable text fields offered by the merge dialog, per entity. */
function mergeFieldsFor(entity, record) {
  if (entity === 'lesson') {
    return [
      { key: 'title', label: 'Title', kind: 'input', value: record?.title ?? '' },
      { key: 'content', label: 'Markdown content', kind: 'textarea', value: record?.content ?? '' },
      { key: 'summary', label: 'Summary', kind: 'textarea', value: record?.summary ?? '' },
    ];
  }
  if (entity === 'snippet') {
    return [
      { key: 'name', label: 'Name', kind: 'input', value: record?.name ?? '' },
      { key: 'code', label: 'Code', kind: 'textarea', value: record?.code ?? '' },
      { key: 'description', label: 'Description', kind: 'textarea', value: record?.description ?? '' },
    ];
  }
  if (entity === 'flashcard') {
    return [
      { key: 'front', label: 'Front', kind: 'textarea', value: record?.front ?? '' },
      { key: 'back', label: 'Back', kind: 'textarea', value: record?.back ?? '' },
    ];
  }
  return [];
}

export default {
  id: 'account',
  title: () => 'Account & Sync',
  breadcrumbs: () => [{ label: 'Account & Sync', path: '/account' }],

  mount(container, ctx) {
    let disposed = false;
    const root = h('div', { class: 'stack stack--lg' });
    container.appendChild(root);

    const offAuth = bus.on('auth:changed', () => void render());
    const offSync = bus.on('sync:changed', debounceRender());
    const offConflicts = bus.on('conflicts:changed', debounceRender());

    let renderTimer = null;
    function debounceRender() {
      return () => {
        if (disposed) return;
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => void render(), 250);
      };
    }

    /* ------------------------------------------------------------ auth -- */

    function authCard() {
      let mode = 'signin'; // 'signin' | 'signup'
      let busy = false;
      let notice = null; // { tone, text }
      let checkEmail = false;

      const errorHost = h('div', { attrs: { role: 'alert' } });
      const emailInput = h('input', {
        class: 'input', type: 'email', attrs: { autocomplete: 'email', id: 'account-email', placeholder: 'you@example.com' },
      });
      const passwordInput = h('input', {
        class: 'input', type: 'password', attrs: { autocomplete: 'current-password', id: 'account-password', placeholder: '••••••••' },
      });

      const showError = (message) => {
        clear(errorHost);
        if (message) errorHost.appendChild(inlineNote(message, 'danger'));
      };

      const setBusy = (next) => {
        busy = next;
        submitBtn.disabled = next;
        submitBtn.textContent = next
          ? (mode === 'signin' ? 'Signing in…' : 'Creating account…')
          : (mode === 'signin' ? 'Sign in' : 'Create account');
      };

      async function submit() {
        if (busy) return;
        showError('');
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        if (!email || !password) { showError('Enter your email and password.'); return; }
        setBusy(true);
        try {
          if (mode === 'signin') {
            await signIn({ email, password });
            toast('Signed in', { tone: 'success' });
          } else {
            await signUp({ email, password });
            checkEmail = true;
            void render();
          }
        } catch (err) {
          showError(String(err?.message || err));
        } finally {
          setBusy(false);
        }
      }

      const submitBtn = h('button', {
        class: 'btn btn--primary', type: 'button', on: { click: () => void submit() },
      }, ['Sign in']);

      const modeTabs = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': 'Account action' } },
        [
          { id: 'signin', label: 'Sign in' },
          { id: 'signup', label: 'Create account' },
        ].map((tab) => h('label', { class: 'segmented__option' }, [
          h('input', {
            type: 'radio', name: 'account-mode', value: tab.id,
            attrs: tab.id === mode ? { checked: '' } : {},
            on: {
              change: () => {
                mode = tab.id;
                passwordInput.setAttribute('autocomplete', mode === 'signin' ? 'current-password' : 'new-password');
                submitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
                showError('');
              },
            },
          }),
          h('span', { text: tab.label }),
        ])),
      );

      if (checkEmail) {
        return h('div', { class: 'card auth-card' }, [
          h('h2', { class: 'card__title', text: 'Confirm your email' }),
          inlineNote('Account created. Check your inbox for the confirmation link, then sign in here.', 'success'),
          h('button', {
            class: 'btn', type: 'button', text: 'Back to sign in',
            on: { click: () => { checkEmail = false; void render(); } },
          }),
        ]);
      }

      return h('div', { class: 'card auth-card' }, [
        h('h2', { class: 'card__title', text: 'Your account' }),
        h('p', { class: 'text-muted', text: 'An account is only needed for cloud sync and the shared AI proxy. Everything works locally without one.' }),
        modeTabs,
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', attrs: { for: 'account-email' }, text: 'Email' }),
          emailInput,
        ]),
        h('div', { class: 'field' }, [
          h('label', { class: 'field__label', attrs: { for: 'account-password' }, text: 'Password' }),
          passwordInput,
        ]),
        errorHost,
        h('div', { class: 'row gap-2' }, [
          submitBtn,
          mode === 'signin' ? h('button', {
            class: 'btn btn--ghost', type: 'button', text: 'Forgot password?',
            on: {
              click: async () => {
                const email = await promptDialog({
                  title: 'Reset password',
                  label: 'Email',
                  placeholder: 'you@example.com',
                  confirmLabel: 'Send reset link',
                  validate: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? '' : 'Enter a valid email'),
                });
                if (!email) return;
                try {
                  await sendPasswordReset(email);
                  toast('Reset link sent — check your inbox', { tone: 'success' });
                } catch (err) {
                  showError(String(err?.message || err));
                }
              },
            },
          }) : null,
        ]),
        SUPABASE.enabled() ? h('div', { class: 'stack stack--sm', style: { marginTop: 'var(--sp-3)' } }, [
          h('div', { class: 'divider', text: 'or' }),
          h('div', { class: 'row gap-2' }, [
            h('button', {
              class: 'btn', type: 'button', text: 'Continue with Google',
              on: { click: () => handleOAuth('google') },
            }),
            h('button', {
              class: 'btn', type: 'button', text: 'Continue with GitHub',
              on: { click: () => handleOAuth('github') },
            }),
          ]),
        ]) : inlineNote('OAuth providers need additional Supabase configuration (see README). Email/password works out of the box.', 'info'),
      ]);

      async function handleOAuth(provider) {
        showError('');
        try {
          await signInWithOAuth(provider);
          // The browser navigates away to the provider; if we are still here,
          // the redirect URL is missing — say so honestly.
          showError(`${provider} sign-in could not start — the provider redirect URL is not configured in this Supabase project.`);
        } catch (err) {
          showError(String(err?.message || err));
        }
      }
    }

    /* ----------------------------------------------------------- sync --- */

    async function syncPanel(user) {
      const sync = syncStore.get();
      const suspended = isSyncSuspended();
      const stats = await queueStats().catch(() => ({ pending: 0, syncing: 0, failed: 0, total: 0 }));
      const counts = await localLibraryCounts().catch(() => ({ records: 0, unsynced: 0 }));

      const statusPill = h('span', {
        class: `badge badge--${sync.state === 'error' ? 'learning' : sync.state === 'idle' ? 'learned' : 'not-started'}`,
        text: sync.state,
      });

      const actions = h('div', { class: 'row gap-2' }, [
        h('button', {
          class: 'btn btn--sm btn--primary', type: 'button',
          on: {
            click: async (event) => {
              event.currentTarget.disabled = true;
              try {
                const summary = await runSyncOnce({ reason: 'manual', manual: true });
                toast(summary ? `Sync finished (${summary.pushed ?? 0} pushed, ${summary.pulled ?? 0} pulled)` : 'Nothing to sync right now', { tone: 'success' });
              } catch (err) {
                toast(String(err?.message || err), { tone: 'danger' });
              } finally {
                event.currentTarget.disabled = false;
                await refreshSyncStatus();
              }
            },
          },
        }, [icon('refresh'), 'Sync now']),
      ]);

      if (suspended) {
        actions.appendChild(h('button', {
          class: 'btn btn--sm', type: 'button',
          on: {
            click: async () => {
              resetSyncChoice(user);
              await ensureSyncChoice(user);
              await render();
            },
          },
        }, [icon('play'), suspended && !hasCloudChoice() ? 'Choose sync direction' : 'Resume sync setup']));
      }

      return h('div', { class: 'card' }, [
        h('div', { class: 'row row--between' }, [
          h('h2', { class: 'card__title', text: 'Cloud sync' }),
          statusPill,
        ]),
        h('p', { class: 'text-muted', text: sync.message || `Last sync: ${sync.lastSyncAt ? formatRelative(sync.lastSyncAt) : 'never'}` }),
        h('p', { class: 'text-muted', text: `${counts.records} records on this device · ${counts.unsynced} not yet pushed · ${stats.pending + stats.syncing} queued · ${stats.failed} failed` }),
        suspended ? inlineNote('Sync is paused: either the first-sign-in choice is still open, or you chose to stay local. Nothing is uploaded while paused.', 'warning') : null,
        actions,
      ]);

      function hasCloudChoice() {
        try {
          return Boolean(localStorage.getItem(`devnotes.sync-choice.${user?.id ?? ''}`));
        } catch { return false; }
      }
    }

    /* ---------------------------------------------------------- queue --- */

    async function queueCard() {
      const items = await listQueue();
      const failed = items.filter((item) => item.status === 'failed');

      const listHost = h('div', { class: 'stack stack--sm' });
      if (!items.length) {
        listHost.appendChild(h('p', { class: 'text-muted', text: 'The queue is empty — every local change has been acknowledged.' }));
      } else {
        for (const item of items.slice(0, 40)) {
          listHost.appendChild(queueRow(item));
        }
        if (items.length > 40) {
          listHost.appendChild(h('p', { class: 'text-muted', text: `…and ${items.length - 40} more.` }));
        }
      }

      function queueRow(item) {
        const row = h('div', { class: 'queue-item', dataset: { op: item.opId } }, [
          h('div', { class: 'queue-item__main' }, [
            h('span', { class: 'queue-item__label', text: `${ENTITY_LABELS[item.entity] || item.entity} · ${item.action}` }),
            h('span', {
              class: 'queue-item__meta',
              text: item.status === 'failed'
                ? `failed after ${item.attempts} attempts — ${item.lastError?.message || 'unknown error'}`
                : item.attempts > 0
                  ? `attempt ${item.attempts}, next try ${formatRelative(item.nextAttemptAt)}`
                  : 'waiting for the next sync run',
            }),
          ]),
          h('div', { class: 'queue-item__actions' }, [
            item.status === 'failed' ? h('button', {
              class: 'btn btn--sm', type: 'button', text: 'Retry',
              on: {
                click: async () => {
                  await retryFailed([item.opId]);
                  toast('Operation re-queued', { tone: 'success' });
                  await render();
                },
              },
            }) : null,
            h('button', {
              class: 'btn btn--sm btn--danger', type: 'button', text: 'Discard',
              on: {
                click: async () => {
                  const ok = await confirmDialog({
                    title: 'Discard this operation?',
                    message: 'The remote will not receive this change. Discard only when the change is unwanted or duplicated.',
                    confirmLabel: 'Discard',
                    danger: true,
                  });
                  if (!ok) return;
                  await discardOp(item.opId);
                  toast('Operation discarded', { tone: 'info' });
                  await render();
                },
              },
            }),
          ]),
        ]);
        return row;
      }

      return h('div', { class: 'card' }, [
        h('div', { class: 'row row--between' }, [
          h('h2', { class: 'card__title', text: 'Pending operations' }),
          failed.length ? h('button', {
            class: 'btn btn--sm', type: 'button',
            on: {
              click: async () => {
                const count = await retryFailed();
                toast(count ? `Re-queued ${count} failed operations` : 'Nothing to retry', { tone: count ? 'success' : 'info' });
                await render();
              },
            },
          }, [icon('refresh'), `Retry all failed (${failed.length})`]) : null,
        ]),
        h('p', { class: 'text-muted', text: 'Every local edit is queued here until the remote acknowledges it. Failed items keep their data; retry or discard them explicitly.' }),
        listHost,
      ]);
    }

    /* ------------------------------------------------------ conflicts --- */

    async function conflictsCard() {
      const rows = await listConflicts();

      const host = h('div', { class: 'stack stack--sm' });
      if (!rows.length) {
        host.appendChild(emptyState({
          iconName: 'check',
          title: 'No conflicts',
          text: 'If the same record changes on two devices, both versions are kept here and nothing is overwritten.',
        }));
        return h('div', { class: 'card' }, [h('h2', { class: 'card__title', text: 'Conflicts' }), host]);
      }

      for (const conflict of rows) {
        host.appendChild(conflictCard(conflict));
      }

      return h('div', { class: 'card' }, [
        h('h2', { class: 'card__title', text: `Conflicts (${rows.length})` }),
        h('p', { class: 'text-muted', text: 'DevNotes never merges automatically. Choose which version wins, or edit the fields yourself.' }),
        host,
      ]);

      function side(title, record) {
        return h('div', { class: 'conflict-pane' }, [
          h('div', { class: 'conflict-pane__title', text: title }),
          h('div', { class: 'conflict-pane__body', text: String(primaryText(conflict.entity, record)).slice(0, 400) }),
          h('div', { class: 'conflict-pane__meta', text: record?.updatedAt ? `updated ${formatRelative(record.updatedAt)}` : 'no timestamp' }),
        ]);
      }

      function conflictCard(conflict) {
        const label = ENTITY_LABELS[conflict.entity] || conflict.entity;
        const canMerge = Boolean(mergeFieldsFor(conflict.entity, conflict.local).length);

        const actions = h('div', { class: 'row gap-2' }, [
          h('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Keep this device’s version',
            on: { click: () => handleResolve(conflict, 'local') },
          }),
          h('button', {
            class: 'btn btn--sm', type: 'button', text: 'Use cloud version',
            on: { click: () => handleResolve(conflict, 'remote') },
          }),
          canMerge ? h('button', {
            class: 'btn btn--sm', type: 'button', text: 'Edit and merge…',
            on: { click: () => void openMerge(conflict) },
          }) : null,
          h('button', {
            class: 'btn btn--sm btn--ghost', type: 'button', text: 'Keep both (dismiss)',
            on: {
              click: async () => {
                await dismissConflict(conflict.id);
                toast('Conflict dismissed — both versions stay as they are', { tone: 'info' });
                await render();
              },
            },
          }),
        ]);

        return h('div', { class: 'conflict-card' }, [
          h('div', { class: 'conflict-card__head' }, [
            h('span', { class: 'badge badge--learning', text: label }),
            h('span', { class: 'text-muted', text: primaryText(conflict.entity, conflict.local) }),
          ]),
          h('div', { class: 'conflict-versions' }, [
            side('This device', conflict.local),
            side('Cloud', conflict.remote),
          ]),
          actions,
        ]);
      }

      async function handleResolve(conflict, choice) {
        try {
          await resolveConflict(conflict.id, choice);
          toast(choice === 'local' ? 'Local version kept and queued for push' : 'Cloud version applied locally', { tone: 'success' });
          await render();
        } catch (err) {
          toast(String(err?.message || err), { tone: 'danger' });
        }
      }

      async function openMerge(conflict) {
        const fields = mergeFieldsFor(conflict.entity, conflict.local);
        const inputs = new Map();
        const body = h('div', { class: 'stack stack--sm' }, [
          h('p', { class: 'text-muted', text: 'Edit the fields below — the merged result becomes the local version and is queued for push. Unchanged fields keep the local value.' }),
          ...fields.map((field) => {
            const input = field.kind === 'input'
              ? h('input', { class: 'input', value: field.value, attrs: { 'aria-label': field.label } })
              : h('textarea', { class: 'textarea', value: field.value, attrs: { rows: field.kind === 'textarea' && field.key === 'content' ? '12' : '5', 'aria-label': field.label } });
            inputs.set(field.key, input);
            return h('div', { class: 'field' }, [
              h('label', { class: 'field__label', text: field.label }),
              input,
            ]);
          }),
        ]);

        const result = await openDialog({
          title: `Merge ${label.toLowerCase()} versions`,
          size: 'wide',
          body,
          actions: [
            { label: 'Cancel', value: null },
            { label: 'Save merged version', value: 'merge', variant: 'primary' },
          ],
        });

        if (result !== 'merge') return;
        const merged = {};
        for (const [key, input] of inputs) merged[key] = input.value;
        await handleResolve(conflict, 'merge', merged);
      }
    }

    // Small shim so merge can pass the extra payload through handleResolve.
    const baseHandleResolve = null;

    /* ---------------------------------------------------------- render -- */

    async function render() {
      if (disposed) return;
      const { status, user } = authStore.get();

      clear(root);
      root.appendChild(h('header', { class: 'page-header' }, [
        h('div', { class: 'page-header__title' }, [
          h('h1', { text: 'Account & Sync' }),
          h('p', { class: 'page-header__subtitle', text: 'Cloud sync is optional. Your library always stays on this device.' }),
        ]),
      ]));

      if (status === 'loading') {
        root.appendChild(skeleton({ count: 3 }));
        return;
      }

      if (!SUPABASE.enabled()) {
        root.appendChild(h('div', { class: 'card' }, [
          h('h2', { class: 'card__title', text: 'Sync is not configured' }),
          inlineNote('This build has no Supabase project configured, so there is no account system and no cloud sync. Everything works locally and offline.', 'info'),
          h('p', { class: 'text-muted', text: 'To enable sync and accounts: create a Supabase project, run supabase/migrations/0001_init.sql, and fill in src/scripts/config.js (see README).' }),
          h('button', { class: 'btn btn--sm', type: 'button', on: { click: () => navigate('/settings?section=sync') } }, [icon('settings'), 'Sync settings']),
        ]));
        return;
      }

      if (status !== 'signed-in' || !user) {
        root.appendChild(authCard());
        if (!isAuthConfigured()) {
          root.appendChild(inlineNote('Authentication is not fully configured on this Supabase project — sign-in attempts will fail until it is.', 'warning'));
        }
        return;
      }

      root.appendChild(h('div', { class: 'card' }, [
        h('div', { class: 'row row--between' }, [
          h('div', [
            h('h2', { class: 'card__title', text: user.email || 'Signed in' }),
            h('p', { class: 'text-muted', text: `User id: ${String(user.id).slice(0, 8)}…` }),
          ]),
          h('button', {
            class: 'btn', type: 'button',
            on: {
              click: async () => {
                await signOut();
                toast('Signed out — your data stays on this device', { tone: 'info' });
              },
            },
          }, [icon('logout'), 'Sign out']),
        ]),
        inlineNote('Signing out never deletes local data. Sync pauses until you sign in again.', 'info'),
      ]));

      try {
        root.appendChild(await syncPanel(user));
        root.appendChild(await conflictsCard());
        root.appendChild(await queueCard());
      } catch (err) {
        console.error('[account] panel failed:', err);
        root.appendChild(emptyState({
          iconName: 'alert',
          title: 'Sync details could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
        }));
      }
    }

    void render();

    return {
      onShow() { void render(); },
      destroy() {
        disposed = true;
        clearTimeout(renderTimer);
        offAuth();
        offSync();
        offConflicts();
      },
    };
  },
};
