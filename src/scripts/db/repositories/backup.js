/**
 * backup.js — data layer for import/export (AGENTS.md §14).
 *
 * Exports read every store directly (including trashed records — a backup
 * must preserve everything). Imports run inside ONE IndexedDB transaction so
 * a failed or rejected file can never leave a half-imported library.
 *
 * Import contract:
 *  - Records arrive already validated/normalized by utils/validate.js
 *    (validateBackup) — this module never trusts raw JSON.
 *  - 'merge'   → ids that already exist locally are skipped (never overwrite).
 *  - 'replace' → content stores and the sync queue are cleared first, then the
 *    backup's records are written; local activity history is kept and one
 *    summary row is appended.
 *  - Imported records get baseRevision 0: when the user is signed in they are
 *    pushed as new/updated rows on the next sync run.
 */

import { withStores, req, readAll } from '../database.js';
import { enqueueWith, isSyncEnabled } from '../../sync/sync-queue.js';
import { uniqueSlug } from '../../utils/id.js';
import { bus } from '../../utils/bus.js';

const CONTENT = [
  { store: 'lessons', entity: 'lesson', label: 'title' },
  { store: 'snippets', entity: 'snippet', label: 'name' },
  { store: 'flashcards', entity: 'flashcard', label: 'front' },
  { store: 'languages', entity: 'language', label: 'name' },
  { store: 'categories', entity: 'category', label: 'name' },
  { store: 'courses', entity: 'course', label: 'name' },
];

async function collectPreferences() {
  return withStores('preferences', 'readonly', async (stores) => {
    const rows = await req(stores.preferences.getAll());
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    return Object.keys(out).length ? out : null;
  });
}

export const backupRepo = {
  /** Every record in the app (trashed included), grouped for the backup file. */
  async collect() {
    const data = {};
    for (const { store } of CONTENT) {
      data[store] = await readAll(store);
    }
    data.preferences = await collectPreferences();
    return data;
  },

  /** Existing ids + slugs per store, used by the preview step. */
  async localIndex() {
    const index = {};
    for (const { store } of CONTENT) {
      const all = await readAll(store);
      index[store] = {
        ids: new Set(all.map((record) => record.id)),
        slugs: new Set(all.map((record) => record.slug).filter(Boolean)),
      };
    }
    return index;
  },

  /**
   * Apply validated records.
   * @param {object} records normalized records keyed by store name
   * @param {{mode: 'merge'|'replace'}} options
   * @returns {Promise<{mode: string, created: object, skipped: object}>}
   */
  async applyRecords(records, { mode = 'merge' } = {}) {
    if (mode !== 'merge' && mode !== 'replace') {
      throw new Error(`Unknown import mode: ${mode}`);
    }

    const storesToOpen = [...CONTENT.map((c) => c.store), 'preferences', 'queue', 'activity'];

    const result = await withStores(storesToOpen, 'readwrite', async (stores) => {
      if (mode === 'replace') {
        for (const { store } of CONTENT) await req(stores[store].clear());
        // Pending operations target records that no longer exist — clearing is
        // correct; imported records are re-queued below when syncing is on.
        await req(stores.queue.clear());
      }

      const created = {};
      const skipped = {};
      let totalCreated = 0;

      for (const { store, entity, label } of CONTENT) {
        const incoming = Array.isArray(records[store]) ? records[store] : [];
        created[store] = 0;
        skipped[store] = 0;

        const existingIds = new Set();
        const takenSlugs = new Set();
        for (const record of await req(stores[store].getAll())) {
          existingIds.add(record.id);
          if (record.slug) takenSlugs.add(record.slug);
        }

        for (const record of incoming) {
          if (mode === 'merge' && existingIds.has(record.id)) {
            skipped[store] += 1;
            continue;
          }

          const value = {
            ...record,
            id: record.id,
            slug: uniqueSlug(record.slug || record[label] || 'record', takenSlugs),
            revision: Number.isFinite(record.revision) && record.revision > 0 ? record.revision : 1,
            baseRevision: 0, // never acknowledged by a remote — pushes as new
          };
          takenSlugs.add(value.slug);
          existingIds.add(value.id);

          await req(stores[store].put(value));
          created[store] += 1;
          totalCreated += 1;

          if (isSyncEnabled()) {
            await enqueueWith(stores.queue, {
              entity,
              id: value.id,
              action: 'upsert',
              payload: value,
              baseRevision: 0,
            });
          }
        }
      }

      // Preferences: only a replace applies them (a merge must not fight the
      // user's current device settings).
      if (mode === 'replace' && records.preferences && typeof records.preferences === 'object') {
        await req(stores.preferences.clear());
        for (const [key, value] of Object.entries(records.preferences)) {
          await req(stores.preferences.put({ key, value, updatedAt: Date.now() }));
        }
      }

      await req(stores.activity.put({
        id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        entity: 'import',
        entityId: 'backup',
        action: 'created',
        label: `Imported ${totalCreated} records (${mode})`,
        at: Date.now(),
      }));

      return { mode, created, skipped, totalCreated, preferencesApplied: mode === 'replace' && Boolean(records.preferences) };
    });

    bus.emit('data:changed', { entity: 'import', store: 'backup', action: 'imported', mode });
    return result;
  },
};
