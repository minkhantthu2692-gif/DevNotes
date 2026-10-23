/**
 * sync-choice.js — first-sign-in decision gate (AGENTS.md §12, prompt §Sync).
 *
 * The app must NEVER silently merge two existing libraries. On the first
 * sign-in for an account we suspend syncing, count both sides and ask:
 *
 *   1. Upload my library   — local wins; unsynced local records are queued.
 *   2. Use cloud library   — pull remote; local edits are never overwritten
 *                            (they surface as conflicts for review).
 *   3. Stay local for now  — syncing stays suspended until the user resumes.
 *
 * The suspension flag is written synchronously before any awaited work so the
 * background engine cannot drain the queue while the question is open.
 */

import { openDialog } from '../../components/dialog.js';
import { toast } from '../../components/toast.js';
import { h } from '../../utils/dom.js';
import { getSupabaseClient } from '../../services/supabase-client.js';
import { cloudCounts } from '../../sync/remote-api.js';
import { localLibraryCounts, enqueueUnsyncedLocal, triggerSync } from '../../sync/sync-engine.js';
import { setSyncSuspended, isSyncSuspended } from '../../sync/sync-queue.js';

const choiceKey = (uid) => `devnotes.sync-choice:${uid}`;

let promptOpen = false;

function readChoice(uid) {
  try {
    return localStorage.getItem(choiceKey(uid));
  } catch {
    return null;
  }
}

function writeChoice(uid, choice) {
  try {
    localStorage.setItem(choiceKey(uid), choice);
  } catch { /* storage disabled: ask again next session */ }
}

/** True when this account already completed (or declined) the setup. */
export function hasDecidedChoice(user) {
  if (!user?.id) return false;
  return Boolean(readChoice(user.id));
}

async function askChoice(localCount, cloudCount) {
  const detail = h('div', { class: 'stack stack--sm' }, [
    h('p', {
      text: `This device holds ${localCount} item${localCount === 1 ? '' : 's'} you have not synced yet. `
        + `Your DevNotes cloud account holds ${cloudCount} item${cloudCount === 1 ? '' : 's'}.`,
    }),
    h('p', {
      class: 'text-muted',
      text: 'Nothing is combined or overwritten automatically — pick how the two libraries should relate.',
    }),
  ]);

  return openDialog({
    title: 'Two libraries found',
    body: detail,
    dismissible: true, // Escape = decide later; syncing stays paused
    actions: [
      { label: 'Stay local for now', value: 'local' },
      { label: 'Use cloud library', value: 'download' },
      { label: 'Upload my library', value: 'upload', variant: 'primary' },
    ],
  });
}

async function applyChoice(user, choice) {
  writeChoice(user.id, choice);

  if (choice === 'local') {
    setSyncSuspended(true);
    return 'local';
  }

  setSyncSuspended(false);

  if (choice === 'upload') {
    // Every unsynced local record becomes a queued upsert (idempotent).
    await enqueueUnsyncedLocal();
    triggerSync('choice', { delay: 250 });
  } else if (choice === 'download') {
    // Queue is expected to be empty; the run pulls remote changes and checks
    // for remotely deleted records.
    triggerSync('choice', { delay: 250 });
  }
  return choice;
}

/**
 * Run the first-sign-in gate for a signed-in user.
 * Safe to call repeatedly (once per account, then fast).
 * @returns {Promise<'upload'|'download'|'local'|'deferred'|'already-decided'|null>}
 */
export function ensureSyncChoice(user) {
  if (!user?.id) return Promise.resolve(null);
  if (promptOpen) return Promise.resolve('deferred');

  const stored = readChoice(user.id);
  if (stored) {
    // Reconcile persisted intent with the runtime suspension flag.
    if (stored === 'local') setSyncSuspended(true);
    else if (isSyncSuspended()) setSyncSuspended(false);
    return Promise.resolve('already-decided');
  }

  // Block the engine BEFORE any await so no op can leave the device.
  setSyncSuspended(true);
  promptOpen = true;

  return (async () => {
    try {
      const [local, client] = await Promise.all([localLibraryCounts(), getSupabaseClient()]);
      if (!client) return 'deferred';
      const cloud = await cloudCounts(client);

      if (cloud.total === 0 && local.unsynced === 0) {
        // Empty on both sides: nothing to decide, syncing can just run.
        writeChoice(user.id, 'upload');
        setSyncSuspended(false);
        triggerSync('choice', { delay: 250 });
        return 'upload';
      }

      if (cloud.total === 0) {
        // Nothing in the cloud to lose — upload is the only sensible action,
        // but say so instead of asking a pointless question.
        writeChoice(user.id, 'upload');
        setSyncSuspended(false);
        await enqueueUnsyncedLocal();
        triggerSync('choice', { delay: 250 });
        toast('Uploaded your library to your new cloud account.', { tone: 'success' });
        return 'upload';
      }

      if (local.records === 0) {
        // Fresh device: adopt whatever the cloud holds.
        writeChoice(user.id, 'download');
        setSyncSuspended(false);
        triggerSync('choice', { delay: 250 });
        return 'download';
      }

      const choice = await askChoice(local.records, cloud.total);
      if (!choice) return 'deferred'; // dismissed: keep everything local
      return await applyChoice(user, choice);
    } catch (err) {
      console.warn('[sync] first-sign-in check failed:', err?.message);
      return 'deferred'; // stays suspended — retried on focus / Account
    } finally {
      promptOpen = false;
    }
  })();
}

/** Forget the decision so the question is asked again (Account → Resume). */
export function resetSyncChoice(user) {
  if (!user?.id) return;
  try {
    localStorage.removeItem(choiceKey(user.id));
  } catch { /* ignore */ }
  setSyncSuspended(false);
}
