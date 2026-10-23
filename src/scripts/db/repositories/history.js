/**
 * history.js — local activity trail and lesson revision snapshots.
 * Both stores are local-only history (they are excluded from sync to keep
 * the remote schema small; they still survive reloads and are exported).
 */

import { withStores, req, readAll } from '../database.js';
import { lessonsRepo } from './lessons.js';
import { bus } from '../../utils/bus.js';

/** Activity log (written automatically by the repositories). */
export const activityLog = {
  async list({ entity = null, limit = 200 } = {}) {
    const all = await readAll('activity', { index: 'by-at', direction: 'prev' });
    const filtered = entity ? all.filter((row) => row.entity === entity) : all;
    return filtered.slice(0, limit);
  },

  async clear() {
    await withStores('activity', 'readwrite', (stores) => req(stores.activity.clear()));
    bus.emit('data:changed', { entity: 'activity', store: 'activity', action: 'cleared' });
  },
};

/** Revision snapshots for one lesson. */
export const revisions = {
  async listFor(lessonId) {
    const all = await readAll('revisions');
    return all
      .filter((row) => row.lessonId === lessonId)
      .sort((a, b) => b.at - a.at);
  },

  async get(id) {
    return withStores('revisions', 'readonly', async (stores) => {
      const row = await req(stores.revisions.get(id));
      return row ?? null;
    });
  },

  /**
   * Restore an older snapshot as a NEW version (history is never destroyed;
   * the restore itself becomes a revision).
   */
  async restore(revisionId) {
    const row = await revisions.get(revisionId);
    if (!row) return null;
    return lessonsRepo.update(row.lessonId, {
      title: row.snapshot.title,
      summary: row.snapshot.summary,
      content: row.snapshot.content,
      status: row.snapshot.status,
      tags: row.snapshot.tags,
      notes: row.snapshot.notes,
    });
  },

  async remove(id) {
    await withStores('revisions', 'readwrite', (stores) => req(stores.revisions.delete(id)));
  },
};
