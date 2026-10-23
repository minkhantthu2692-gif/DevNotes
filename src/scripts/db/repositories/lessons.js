/**
 * lessons.js — lesson repository (the core entity).
 * Adds lesson-specific behaviour on top of base.js:
 *  - local-only "last opened" tracking (no sync churn for reads)
 *  - manual ordering that stays in sync
 *  - content snapshots for the revision history (same transaction as update)
 */

import { createRepository } from './base.js';
import { normalizeLesson, LIMITS } from '../../utils/validate.js';
import { withStores, req, readAll } from '../database.js';
import { enqueueWith, isSyncEnabled } from '../../sync/sync-queue.js';
import { bus } from '../../utils/bus.js';

const REVISION_CAP = 50;

const CONTENT_FIELDS = ['content', 'title', 'summary', 'status', 'tags', 'notes'];

function contentDiffers(a, b) {
  return CONTENT_FIELDS.some((field) => JSON.stringify(a[field] ?? null) !== JSON.stringify(b[field] ?? null));
}

export const lessonsRepo = createRepository({
  store: 'lessons',
  entity: 'lesson',
  normalize: normalizeLesson,
  labelField: 'title',
  extraStores: ['revisions'],

  /** Save a snapshot of the previous version before an edit overwrites it. */
  async onBeforeUpdate(existing, next, stores) {
    if (!contentDiffers(existing, next)) return;

    // Coalesce: one snapshot per editing session burst (5 minutes), otherwise
    // autosave would fill the 50-snapshot cap with near-identical states and
    // push out genuinely different older versions.
    const SNAPSHOT_COALESCE_MS = 5 * 60_000;
    const recent = await req(stores.revisions.index('by-lesson').getAll(existing.id));
    if (recent.length) {
      const latest = recent.reduce((a, b) => (b.at > a.at ? b : a));
      if (Date.now() - latest.at < SNAPSHOT_COALESCE_MS) return;
    }

    await req(stores.revisions.put({
      id: `rev_${existing.id}_${Date.now().toString(36)}`,
      lessonId: existing.id,
      at: Date.now(),
      // Only the fields a reader needs to compare versions.
      snapshot: {
        title: existing.title,
        summary: existing.summary,
        content: existing.content,
        status: existing.status,
        tags: existing.tags,
        notes: existing.notes,
        revision: existing.revision ?? 0,
      },
    }));

    // Keep history bounded (most recent REVISION_CAP snapshots).
    const all = await req(stores.revisions.index('by-lesson').getAll(existing.id));
    if (all.length > REVISION_CAP) {
      all.sort((a, b) => a.at - b.at);
      for (const stale of all.slice(0, all.length - REVISION_CAP)) {
        await req(stores.revisions.delete(stale.id));
      }
    }
  },
});

/** Recorded when a lesson is opened. Local-only by design (no sync churn). */
lessonsRepo.touchOpened = async function touchOpened(id) {
  await withStores('lessons', 'readwrite', async (stores) => {
    const lesson = await req(stores.lessons.get(id));
    if (!lesson) return;
    lesson.lastOpenedAt = Date.now();
    await req(stores.lessons.put(lesson));
  });
  bus.emit('data:changed', { entity: 'lesson', store: 'lessons', action: 'touched', id });
};

/**
 * Manual ordering: `ids` is the desired order (top → bottom).
 * Reassigns contiguous `order` values and syncs the changed records.
 */
lessonsRepo.setOrder = async function setOrder(ids) {
  await withStores(['lessons', 'queue'], 'readwrite', async (stores) => {
    const lessons = await req(stores.lessons.getAll());
    const byId = new Map(lessons.map((l) => [l.id, l]));
    let position = 1;
    for (const id of ids) {
      const lesson = byId.get(id);
      if (!lesson) continue;
      const order = position * 1000;
      position += 1;
      if (lesson.order === order) continue;
      lesson.order = order;
      lesson.revision = (lesson.revision ?? 0) + 1;
      await req(stores.lessons.put(lesson));
      if (isSyncEnabled()) {
        await enqueueWith(stores.queue, {
          entity: 'lesson', id: lesson.id, action: 'upsert', payload: lesson, baseRevision: lesson.baseRevision ?? 0,
        });
      }
    }
  });
  bus.emit('data:changed', { entity: 'lesson', store: 'lessons', action: 'reordered' });
};

/** Move a lesson up/down inside the given list. */
lessonsRepo.move = async function move(id, delta, orderedIds) {
  const index = orderedIds.indexOf(id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= orderedIds.length) return false;
  const next = [...orderedIds];
  [next[index], next[target]] = [next[target], next[index]];
  await lessonsRepo.setOrder(next);
  return true;
};

/** Lessons due for review (scheduled and past due). */
lessonsRepo.getReviewDue = async function getReviewDue(now = Date.now()) {
  const all = await readAll('lessons');
  return all
    .filter((lesson) => !lesson.trashed && !lesson.archived && lesson.reviewAt && lesson.reviewAt <= now)
    .sort((a, b) => a.reviewAt - b.reviewAt);
};

export { LIMITS };
