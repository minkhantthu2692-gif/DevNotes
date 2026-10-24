/**
 * account.js — the Account & Sync page: identity, cloud sync and account
 * management in one place.
 *
 * Layout (page-level composition; styles live in styles/pages.css →
 * "Account & sync"):
 *   hero         — title, subtitle, live sync chip, motto
 *   left column  — Profile card + Account management card (sign out, export
 *                  shortcut, Reset user data, Delete account)
 *   right column — Sync card (status, counts, cloud row, Sync now), Conflicts,
 *                  Pending operations
 *
 * Signed out: email/password + OAuth (only when Supabase is configured; the
 * app never fakes a successful sign-in). Signed in: sync status, the pending
 * operation queue with manual retry/discard, and conflict resolution where
 * nothing is ever merged silently (AGENTS.md §11–§12).
 *
 * Destructive actions (AGENTS.md §9/§14): both Account-management actions sit
 * behind a typed confirmation dialog, never a bare click, and Delete account
 * reports the real database error when its migration is missing instead of
 * claiming success (AGENTS.md §15).
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
import { runSyncOnce, localLibraryCounts } from '../sync/sync-engine.js';
import { listQueue, queueStats, retryFailed, discardOp } from '../sync/sync-queue.js';
import { listConflicts, resolveConflict, dismissConflict } from '../sync/conflict-resolver.js';
import { isSyncSuspended } from '../sync/sync-queue.js';
import { ensureSyncChoice, resetSyncChoice } from '../features/auth/sync-choice.js';
import { refreshSyncStatus, connectivityInfo } from '../sync/connectivity.js';
import { formatRelative } from '../utils/format.js';
import {
  loadProfile, updateProfile, uploadAvatar, avatarElement, getCachedProfile,
} from '../features/account/account-service.js';
import { deleteAccount, resetUserData } from '../features/account/account-actions.js';

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

/** Card header: icon tile + title + description + optional trailing action. */
function panelHead({ iconName = 'info', title, text = '', aside = null }) {
  return h('div', { class: 'panel-head' }, [
    h('span', { class: 'panel-head__icon', attrs: { 'aria-hidden': 'true' } }, [icon(iconName)]),
    h('div', { class: 'panel-head__text' }, [
      h('h2', { class: 'panel-head__title', text: title }),
      text ? h('p', { class: 'panel-head__sub', text }) : null,
    ]),
    aside ? h('div', { class: 'panel-head__aside' }, [aside]) : null,
  ]);
}

/** Small labelled stat tile for the sync panel. */
function statTile(value, label, tone = '') {
  return h('div', { class: 'stat-tile', dataset: tone ? { tone } : {} }, [
    h('span', { class: 'stat-tile__value', text: String(value) }),
    h('span', { class: 'stat-tile__label', text: label }),
  ]);
}

/** One row of the danger zone: icon, explanation, action control. */
function dangerRow({ iconName, title, hint }, action) {
  return h('div', { class: 'danger-row' }, [
    h('span', { class: 'danger-row__icon', attrs: { 'aria-hidden': 'true' } }, [icon(iconName)]),
    h('div', { class: 'danger-row__text' }, [
      h('span', { class: 'danger-row__title', text: title }),
      h('span', { class: 'danger-row__hint', text: hint }),
    ]),
    action,
  ]);
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

    /* ---------------------------------------------------------- hero ----- */

    /** Compact sync state chip shown in the page hero (topbar wording). */
    function syncChip() {
      const { status } = authStore.get();
      const state = syncStore.get();

      const map = {
        disabled: { label: 'Local only', tone: 'neutral', iconName: 'cloudOff' },
        offline: { label: 'Offline', tone: 'warning', iconName: 'cloudOff' },
        idle: { label: 'Synced', tone: 'success', iconName: 'cloud' },
        pending: { label: `${state.pending} to sync`, tone: 'accent', iconName: 'cloud' },
        syncing: { label: 'Syncing…', tone: 'accent', iconName: 'refresh' },
        error: { label: `${state.failed} failed`, tone: 'danger', iconName: 'alert' },
        paused: { label: 'Sync paused', tone: 'warning', iconName: 'cloudOff' },
      };
      const info = (status === 'signed-in' && map[state.state]) || map.disabled;

      return h('span', { class: 'account-chip', dataset: { tone: info.tone } }, [
        icon(info.iconName),
        h('span', { text: info.label }),
      ]);
    }

    function pageHero() {
      return h('header', { class: 'account-hero' }, [
        h('span', { class: 'account-hero__icon', attrs: { 'aria-hidden': 'true' } }, [icon('user')]),
        h('div', { class: 'account-hero__text' }, [
          h('h1', { text: 'Account & Sync' }),
          h('p', {
            class: 'account-hero__subtitle',
            text: 'Manage your profile, security and keep your data in sync across all your devices.',
          }),
        ]),
        syncChip(),
        h('span', { class: 'account-hero__motto', text: 'Better notes,\nbetter you.' }),
      ]);
    }

    /* ------------------------------------------------------------ auth -- */

    function authCard() {
      // Redirect to dedicated auth page when signed out
      const { status } = authStore.get();
      if (status !== 'signed-in') {
        navigate('/auth', { replace: true });
        return h('div'); // placeholder, will be replaced by navigation
      }
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
          h('span', { class: 'segmented__label', text: tab.label }),
        ])),
      );

      if (checkEmail) {
        return h('div', { class: 'card account-card' }, [
          h('h2', { class: 'card__title', text: 'Confirm your email' }),
          inlineNote('Account created. Check your inbox for the confirmation link, then sign in here.', 'success'),
          h('button', {
            class: 'btn', type: 'button', text: 'Back to sign in',
            on: { click: () => { checkEmail = false; void render(); } },
          }),
        ]);
      }

      return h('div', { class: 'card account-card' }, [
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
      const conn = connectivityInfo();

      const view = (() => {
        switch (sync.state) {
          case 'idle':
            return { label: 'All up to date', tone: 'success', iconName: 'check', badge: ['Up to date', 'learned'] };
          case 'pending':
            return {
              label: `${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting`,
              tone: 'accent', iconName: 'cloud',
              badge: [`${sync.pending} queued`, 'learning'],
            };
          case 'syncing':
            return { label: 'Syncing…', tone: 'accent', iconName: 'refresh', badge: ['Syncing', 'learning'] };
          case 'error':
            return {
              label: `${sync.failed} operation${sync.failed === 1 ? '' : 's'} failed`,
              tone: 'danger', iconName: 'alert',
              badge: [`${sync.failed} failed`, 'danger'],
            };
          case 'offline':
            return { label: 'Offline', tone: 'warning', iconName: 'cloudOff', badge: ['Waiting for connection', 'learning'] };
          case 'paused':
            return { label: 'Sync paused', tone: 'warning', iconName: 'cloudOff', badge: ['Paused', 'learning'] };
          default:
            return { label: 'Local only', tone: 'neutral', iconName: 'cloudOff', badge: ['This device only', 'not-started'] };
        }
      })();

      const statusBlock = h('div', { class: 'sync-status', dataset: { tone: view.tone } }, [
        h('span', { class: 'sync-status__disc', attrs: { 'aria-hidden': 'true' } }, [icon(view.iconName)]),
        h('div', { class: 'sync-status__text' }, [
          h('span', { class: 'sync-status__title', text: view.label }),
          h('span', {
            class: 'sync-status__meta',
            text: sync.lastSyncAt ? `Last synced ${formatRelative(sync.lastSyncAt)}` : 'This device has never synced',
          }),
        ]),
        h('span', { class: `badge badge--${view.badge[1]}`, text: view.badge[0] }),
      ]);

      const cloudBadge = !SUPABASE.enabled()
        ? ['Not configured', 'not-started']
        : conn.backendReachable ? ['Connected', 'learned'] : ['Not reachable', 'learning'];

      const cloudRow = h('div', { class: 'cloud-row' }, [
        h('span', { class: 'cloud-row__icon', attrs: { 'aria-hidden': 'true' } }, [icon('cloud')]),
        h('div', { class: 'cloud-row__text' }, [
          h('span', { class: 'cloud-row__title', text: 'Cloud storage' }),
          h('span', {
            class: 'cloud-row__hint',
            text: SUPABASE.enabled()
              ? 'Stored in Supabase and scoped to your account by Row Level Security.'
              : 'Cloud sync is not configured — everything stays in this browser.',
          }),
        ]),
        h('span', { class: `badge badge--${cloudBadge[1]}`, text: cloudBadge[0] }),
      ]);

      const syncBtn = h('button', {
        class: 'btn btn--primary btn--block', type: 'button',
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
      }, [icon('refresh'), 'Sync now']);

      const actions = h('div', { class: 'stack stack--sm' }, [syncBtn]);

      if (suspended) {
        actions.appendChild(h('button', {
          class: 'btn', type: 'button',
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
        panelHead({
          iconName: 'cloud',
          title: 'Sync',
          text: 'Keep your notes, progress and settings in sync across your devices.',
        }),
        statusBlock,
        h('div', { class: 'stat-tiles' }, [
          statTile(counts.records, 'On this device'),
          statTile(counts.unsynced, 'Not pushed yet'),
          statTile(stats.pending + stats.syncing, 'In the queue'),
          statTile(stats.failed, 'Failed', stats.failed > 0 ? 'danger' : ''),
        ]),
        suspended ? inlineNote('Sync is paused: either the first-sign-in choice is still open, or you chose to stay local. Nothing is uploaded while paused.', 'warning') : null,
        stats.failed > 0 ? inlineNote(`${stats.failed} operation${stats.failed === 1 ? '' : 's'} failed after retries — retry or discard them under Pending operations below.`, 'danger') : null,
        cloudRow,
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
        const row = h('div', { class: 'queue-item', dataset: { op: item.opId, status: item.status } }, [
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
        panelHead({
          iconName: 'clock',
          title: 'Pending operations',
          text: 'Every local edit is queued here until the remote acknowledges it. Failed items keep their data; retry or discard them explicitly.',
          aside: failed.length ? h('button', {
            class: 'btn btn--sm', type: 'button',
            on: {
              click: async () => {
                const count = await retryFailed();
                toast(count ? `Re-queued ${count} failed operations` : 'Nothing to retry', { tone: count ? 'success' : 'info' });
                await render();
              },
            },
          }, [icon('refresh'), `Retry all failed (${failed.length})`]) : null,
        }),
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
        return h('div', { class: 'card' }, [
          panelHead({ iconName: 'check', title: 'Conflicts', text: 'Nothing needs your decision right now.' }),
          host,
        ]);
      }

      for (const conflict of rows) {
        host.appendChild(conflictCard(conflict));
      }

      return h('div', { class: 'card' }, [
        panelHead({
          iconName: 'alert',
          title: `Conflicts (${rows.length})`,
          text: 'DevNotes never merges automatically. Choose which version wins, or edit the fields yourself.',
        }),
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

      async function handleResolve(conflict, choice, merged = null) {
        try {
          // `merged` must reach the resolver: without it a merge dialog would
          // throw "Merged record required" and silently drop the user's edits.
          await resolveConflict(conflict.id, choice, merged);
          toast(choice === 'local' ? 'Local version kept and queued for push' : choice === 'merge' ? 'Merged version saved and queued for push' : 'Cloud version applied locally', { tone: 'success' });
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

    /* ------------------------------------------------------- profile --- */

    /**
     * Profile card: identity block (avatar, name, handle, email) with the
     * Profile picture picker and Save profile buttons stacked beneath it,
     * bottom-aligned with the Bio field beside them — plus username, display
     * name and bio. The photo is saved by uploadAvatar itself, so `save`
     * only ever sends text fields and can never clobber the stored photo.
     * The row is written straight to `profiles` (RLS-owned, see
     * supabase/migrations/0002_profiles.sql). Saves are optimistic and every
     * failure surfaces a real message — never a silent drop.
     */
    function profileCard(user) {
      const profile = getCachedProfile();
      const usernameInput = h('input', {
        class: 'input', type: 'text', value: profile?.username || '',
        attrs: { id: 'profile-username', autocomplete: 'username', maxlength: '30', placeholder: 'your-handle' },
      });
      const nameInput = h('input', {
        class: 'input', type: 'text', value: profile?.fullName || '',
        attrs: { id: 'profile-name', autocomplete: 'name', maxlength: '80', placeholder: 'Your name' },
      });
      const bioInput = h('textarea', {
        class: 'textarea', value: profile?.bio || '',
        attrs: { id: 'profile-bio', maxlength: '160', rows: '3', placeholder: 'A short line about you' },
      });
      // The file input stays in the DOM (labelled for assistive tech) but is
      // visually hidden with tabindex -1: the visible "Profile picture"
      // button opens it, so there is exactly one keyboard-focusable control
      // instead of an invisible focus stop next to a real button.
      const fileInput = h('input', {
        class: 'sr-only', type: 'file',
        attrs: {
          id: 'profile-avatar-file',
          accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif',
          'aria-label': 'Upload a profile photo',
          tabindex: '-1',
        },
      });
      const avatarHost = h('div', { class: 'profile__avatar-host' }, [avatarElement(profile || {}, { size: 88 })]);
      const errorHost = h('div', { attrs: { role: 'alert' } });

      const showError = (message) => {
        clear(errorHost);
        if (message) errorHost.appendChild(inlineNote(message, 'danger'));
      };

      // Stored photo URL, kept in a local so the preview updates right after
      // an upload without a full re-render. The image URL input was removed —
      // this is the only source for an existing photo now.
      let avatarUrl = profile?.avatarUrl || null;

      function refreshPreview() {
        clear(avatarHost);
        avatarHost.appendChild(avatarElement({
          username: usernameInput.value.trim(),
          fullName: nameInput.value.trim(),
          avatarUrl,
        }, { size: 88 }));
      }

      // Live preview as the user types a handle.
      usernameInput.addEventListener('input', refreshPreview);
      nameInput.addEventListener('input', refreshPreview);

      /** Applies a picked image: uploadAvatar stores it and returns its URL. */
      async function handleAvatarFile(file) {
        if (!file) return;
        showError('');
        try {
          avatarUrl = await uploadAvatar(file);
          refreshPreview();
          toast('Profile photo updated', { tone: 'success' });
        } catch (err) {
          showError(String(err?.message || err));
        }
      }

      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        try {
          await handleAvatarFile(file);
        } finally {
          // Allow re-choosing the same file next time.
          fileInput.value = '';
        }
      });

      async function save() {
        showError('');
        try {
          // avatarUrl is deliberately omitted: validatePatch skips undefined
          // keys, so a text-only save can never clear the uploaded photo.
          await updateProfile({
            username: usernameInput.value.trim(),
            fullName: nameInput.value.trim(),
            bio: bioInput.value.trim(),
          });
          toast('Profile saved', { tone: 'success' });
          await render();
        } catch (err) {
          showError(String(err?.message || err));
        }
      }

      const identityName = profile?.fullName || profile?.username || 'Your profile';

      return h('div', { class: 'card profile-card' }, [
        panelHead({
          iconName: 'user',
          title: 'Profile',
          text: 'Update your personal information and profile picture. These values are stored in your account and only you can edit them.',
        }),
        h('div', { class: 'profile__grid' }, [
          h('div', { class: 'profile__identity' }, [
            avatarHost,
            h('div', { class: 'profile__identity-text' }, [
              h('span', { class: 'profile__identity-name', text: identityName }),
              h('span', { class: 'profile__identity-handle', text: profile?.username ? `@${profile.username}` : 'No handle yet' }),
              user?.email ? h('span', { class: 'profile__identity-email', text: user.email }) : null,
            ]),
            // Stacked actions, pushed to the bottom of this column so the pair
            // lines up with the Bio field beside it (margin-top:auto in CSS).
            h('div', { class: 'profile__actions' }, [
              h('button', {
                class: 'btn', type: 'button',
                on: { click: () => fileInput.click() },
              }, [icon('upload'), 'Profile picture']),
              h('button', {
                class: 'btn btn--primary', type: 'button', text: 'Save profile',
                on: { click: () => void save() },
              }),
              // Hidden picker lives here so it is inside the document (a
              // detached input's click() does not open the chooser).
              fileInput,
              h('div', { class: 'field__hint', text: 'PNG, JPEG, WebP, GIF or AVIF · up to 10 MB' }),
            ]),
          ]),
          h('div', { class: 'stack stack--sm' }, [
            h('div', { class: 'field' }, [
              h('label', { class: 'field__label', attrs: { for: 'profile-username' }, text: 'Username' }),
              usernameInput,
              h('div', { class: 'field__hint', text: 'Letters, numbers, dots, dashes and underscores. This is your public handle.' }),
            ]),
            h('div', { class: 'field' }, [
              h('label', { class: 'field__label', attrs: { for: 'profile-name' }, text: 'Display name' }),
              nameInput,
            ]),
            h('div', { class: 'field' }, [
              h('label', { class: 'field__label', attrs: { for: 'profile-bio' }, text: 'Bio' }),
              bioInput,
              h('div', { class: 'field__hint', text: 'Optional — up to 160 characters.' }),
            ]),
          ]),
        ]),
        errorHost,
      ]);
    }

    /* -------------------------------------------- account management --- */

    /**
     * Account management card: session controls plus the two irreversible
     * actions. Both destructive actions require a TYPED confirmation
     * (promptDialog with an exact word) so an accidental click can never
     * destroy data, and every failure is shown inline with a real recovery
     * step instead of being swallowed (AGENTS.md §15).
     */
    function accountManagementCard(user) {
      const profile = getCachedProfile();
      const errorHost = h('div', { attrs: { role: 'alert' } });
      const showError = (message) => {
        clear(errorHost);
        if (message) errorHost.appendChild(inlineNote(message, 'danger'));
      };

      const signOutBtn = h('button', {
        class: 'btn btn--sm', type: 'button',
        on: {
          click: async (event) => {
            event.currentTarget.disabled = true;
            try {
              await signOut();
              toast('Signed out — your data stays on this device', { tone: 'info' });
            } finally {
              event.currentTarget.disabled = false;
            }
          },
        },
      }, [icon('logout'), 'Sign out']);

      const exportBtn = h('button', {
        class: 'btn btn--sm', type: 'button',
        on: { click: () => navigate('/settings?section=data') },
      }, [icon('download'), 'Export a backup']);

      const resetLabel = h('span', { text: 'Reset user data' });
      const resetBtn = h('button', {
        class: 'btn btn--sm btn--danger', type: 'button',
        on: { click: () => void confirmResetUserData() },
      }, [icon('restore'), resetLabel]);

      const deleteLabel = h('span', { text: 'Delete account' });
      const deleteBtn = h('button', {
        class: 'btn btn--sm btn--danger', type: 'button',
        on: { click: () => void confirmDeleteAccount() },
      }, [icon('trash'), deleteLabel]);

      /**
       * Reset: deletes everything the account uploaded to Supabase (notes,
       * snippets, cards, taxonomy, preferences, profile row, avatar objects)
       * plus this browser's copy, while the account and its sign-in stay.
       * Cloud first — local data is only cleared after the remote deletes are
       * confirmed, so a failure can never destroy data twice or lie about it.
       */
      async function confirmResetUserData() {
        showError('');
        const typed = await promptDialog({
          title: 'Reset your data everywhere?',
          label: 'Type RESET to confirm',
          hint: 'Deletes every note, snippet, flashcard, language, category, course and preference uploaded to Supabase, '
            + 'your profile row and profile photo, AND everything stored in this browser. '
            + 'Your account and sign-in (email, Google or GitHub) stay — you restart from a fresh, empty state. '
            + 'Export a backup first if you might want this data later.',
          confirmLabel: 'Reset my data',
          validate: (value) => (value === 'RESET' ? '' : 'Type RESET exactly'),
        });
        if (typed !== 'RESET') return;

        resetBtn.disabled = true;
        resetLabel.textContent = 'Resetting…';
        try {
          const { localCleared } = await resetUserData();
          if (localCleared) {
            toast('Your data was reset — the account starts fresh. Reloading…', { tone: 'success' });
            setTimeout(() => location.reload(), 1400);
            return;
          }
          resetLabel.textContent = 'Reset user data';
          resetBtn.disabled = false;
          showError('Everything in the cloud was cleared, but this browser’s data could not be removed. '
            + 'Run the reset again (repeating it is safe), or use Settings → Data → “Erase everything”.');
        } catch (err) {
          resetLabel.textContent = 'Reset user data';
          resetBtn.disabled = false;
          showError(String(err?.message || err));
        }
      }

      /**
       * Permanent account deletion: remote first (via the 0003_account.sql
       * RPC), then sign-out and a reload so nothing personal survives in this
       * browser. The button stays disabled while the request is in flight and
       * any failure is reported with the database's real reason.
       */
      async function confirmDeleteAccount() {
        showError('');
        const typed = await promptDialog({
          title: 'Delete your account permanently?',
          label: 'Type DELETE to confirm',
          hint: 'Deletes your account, your profile, every record synced to it, AND all data in this browser. '
            + 'This cannot be undone — but your email address and your Google/GitHub sign-in become free again, '
            + 'so you can create a brand-new account later. Export a backup first if you might need one.',
          confirmLabel: 'Delete account',
          validate: (value) => (value === 'DELETE' ? '' : 'Type DELETE exactly'),
        });
        if (typed !== 'DELETE') return;

        deleteBtn.disabled = true;
        deleteLabel.textContent = 'Deleting…';
        try {
          const { localCleared } = await deleteAccount();
          await signOut();
          toast(
            localCleared
              ? 'Account deleted'
              : 'Account deleted — local data could not be cleared; use Settings → Data → “Erase everything”.',
            { tone: localCleared ? 'success' : 'warning' },
          );
          setTimeout(() => location.reload(), 1600);
        } catch (err) {
          deleteLabel.textContent = 'Delete account';
          deleteBtn.disabled = false;
          showError(String(err?.message || err));
        }
      }

      return h('div', { class: 'card account-mgmt' }, [
        panelHead({
          iconName: 'key',
          title: 'Account management',
          text: 'Sign out, export your data, or take irreversible action on this account. Every destructive step asks for confirmation.',
        }),
        h('div', { class: 'account-identity' }, [
          avatarElement(profile || { username: user?.email || '' }, { size: 40 }),
          h('div', { class: 'account-identity__text' }, [
            h('span', { class: 'account-identity__email', text: user?.email || 'Signed in' }),
            h('span', { class: 'account-identity__meta', text: `User id ${String(user?.id || '').slice(0, 8)}…` }),
          ]),
          h('div', { class: 'account-identity__actions' }, [exportBtn, signOutBtn]),
        ]),
        inlineNote('Signing out never deletes local data. Sync pauses until you sign in again.', 'info'),
        errorHost,
        h('div', { class: 'danger-group' }, [
          h('span', { class: 'danger-group__title', text: 'Danger zone' }),
          dangerRow({
            iconName: 'restore',
            title: 'Reset user data',
            hint: 'Delete everything uploaded to Supabase plus this browser’s copy. The account and your sign-in stay — you start fresh.',
          }, resetBtn),
          dangerRow({
            iconName: 'trash',
            title: 'Delete account',
            hint: 'Permanently delete the account and all of its data. Your email or OAuth login can be used for a new account afterwards.',
          }, deleteBtn),
        ]),
      ]);
    }

    /* ---------------------------------------------------------- render -- */

    /**
     * Rebuild the page. The router calls onShow() immediately after mount(),
     * so two renders can overlap — and several branches await (profile load,
     * queue/conflict reads). Each render takes a sequence number and any
     * render that is no longer the latest bails out after every await;
     * otherwise the stale one would append a SECOND tree with duplicate ids
     * (AGENTS.md §4).
     */
    let renderSeq = 0;
    async function render() {
      const seq = ++renderSeq;
      const stale = () => disposed || seq !== renderSeq;
      if (stale()) return;

      const { status, user } = authStore.get();

      clear(root);
      root.appendChild(pageHero());

      if (status === 'loading') {
        root.appendChild(skeleton({ count: 3 }));
        return;
      }

      if (!SUPABASE.enabled()) {
        root.appendChild(h('div', { class: 'card' }, [
          panelHead({
            iconName: 'cloudOff',
            title: 'Sync is not configured',
            text: 'There is no account system and no cloud sync in this build — everything works locally and offline.',
          }),
          inlineNote('To enable sync and accounts: create a Supabase project, run supabase/migrations/0001_init.sql, 0002_profiles.sql and 0003_account.sql, then fill in src/scripts/config.js (see README).', 'info'),
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

      // Make sure the profile is loaded so the header and this card agree.
      // Never blocks the page: a failed load falls back to derived values.
      if (!getCachedProfile()) await loadProfile().catch(() => {});
      if (stale()) return;

      const leftCol = h('div', { class: 'account-col' }, [
        profileCard(user),
        accountManagementCard(user),
      ]);
      const rightCol = h('div', { class: 'account-col' });
      root.appendChild(h('div', { class: 'account-layout' }, [leftCol, rightCol]));

      try {
        const syncCard = await syncPanel(user);
        if (stale()) return;
        rightCol.appendChild(syncCard);

        const conflicts = await conflictsCard();
        if (stale()) return;
        rightCol.appendChild(conflicts);

        const queue = await queueCard();
        if (stale()) return;
        rightCol.appendChild(queue);
      } catch (err) {
        if (stale()) return;
        console.error('[account] panel failed:', err);
        rightCol.appendChild(emptyState({
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
