/**
 * flashcards.js — manual and AI-draft study cards.
 *
 * AI-generated cards are stored with `source: 'ai'` and `approved: false`
 * until the user explicitly approves them (§11); unapproved cards never enter
 * the review queue.
 */

import { createRepository } from './base.js';
import { normalizeFlashcard } from '../../utils/validate.js';
import { withStores, req, readAll } from '../database.js';
import { enqueueWith, isSyncEnabled } from '../../sync/sync-queue.js';
import { bus } from '../../utils/bus.js';

export const flashcardsRepo = createRepository({
  store: 'flashcards',
  entity: 'flashcard',
  labelField: 'front',
  normalize: normalizeFlashcard,
});

/** Approve an AI draft (moves it into the review queue). */
flashcardsRepo.approve = async function approve(id) {
  return flashcardsRepo.update(id, { approved: true, source: 'manual', dueAt: Date.now() });
};

/** Cards due for review now (approved only). */
flashcardsRepo.getDue = async function getDue(now = Date.now()) {
  const all = await readAll('flashcards');
  return all
    .filter((card) => !card.trashed && card.approved && card.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt);
};

/** Replace scheduling fields after a review answer. */
flashcardsRepo.setSchedule = async function setSchedule(id, { box, dueAt }) {
  const existing = await flashcardsRepo.get(id);
  if (!existing) return null;
  await withStores(['flashcards', 'queue'], 'readwrite', async (stores) => {
    const value = { ...existing, box, dueAt, updatedAt: Date.now(), revision: (existing.revision ?? 0) + 1 };
    await req(stores.flashcards.put(value));
    if (isSyncEnabled()) {
      await enqueueWith(stores.queue, {
        entity: 'flashcard', id: value.id, action: 'upsert', payload: value, baseRevision: value.baseRevision ?? 0,
      });
    }
  });
  bus.emit('data:changed', { entity: 'flashcard', store: 'flashcards', action: 'scheduled', id });
  return flashcardsRepo.get(id);
};

/** Learning statistics used by the dashboard (honest, count-based only). */
flashcardsRepo.stats = async function stats() {
  const all = await readAll('flashcards');
  const active = all.filter((card) => !card.trashed && card.approved);
  const now = Date.now();
  return {
    total: active.length,
    due: active.filter((card) => card.dueAt <= now).length,
    pendingApproval: all.filter((card) => card.source === 'ai' && !card.approved).length,
    learned: active.filter((card) => card.box >= 4).length,
  };
};
