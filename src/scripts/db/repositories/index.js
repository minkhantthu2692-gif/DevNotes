/**
 * repositories/index.js — single import surface for the data layer.
 * UI modules import from here, never from database.js directly.
 */

export { lessonsRepo } from './lessons.js';
export { languagesRepo, categoriesRepo, coursesRepo, ensureTaxonomy } from './taxonomy.js';
export { snippetsRepo } from './snippets.js';
export { flashcardsRepo } from './flashcards.js';
export { getPref, setPrefs, getAllPrefs, resetPrefs, PREFS_STORE_KEY } from './preferences.js';
export { activityLog, revisions } from './history.js';
export { fontsRepo, MAX_FONT_BYTES } from './fonts.js';
export { getSnapshot, invalidateSnapshot } from '../snapshot.js';

import { readAll, estimateStorage } from '../database.js';
import { lessonsRepo } from './lessons.js';
import { snippetsRepo } from './snippets.js';
import { languagesRepo, categoriesRepo, coursesRepo } from './taxonomy.js';
import { flashcardsRepo } from './flashcards.js';

/**
 * Aggregated counts for the dashboard / sidebar badges.
 * Result is cached under the 'stats' snapshot key.
 */
export async function getStats() {
  const [lessons, snippets, languages, categories, courses, cards] = await Promise.all([
    lessonsRepo.getAll(),
    snippetsRepo.getAll(),
    languagesRepo.getAll(),
    categoriesRepo.getAll(),
    coursesRepo.getAll(),
    readAll('flashcards'),
  ]);

  const activeCards = cards.filter((c) => !c.trashed && c.approved);
  const now = Date.now();

  const byStatus = { 'not-started': 0, learning: 0, learned: 0 };
  for (const lesson of lessons) byStatus[lesson.status] = (byStatus[lesson.status] || 0) + 1;

  const languagesUsed = new Set(lessons.map((l) => l.languageId).filter(Boolean));

  return {
    lessons: lessons.length,
    lessonsTrashed: lessons.filter((l) => l.trashed).length,
    byStatus,
    languages: languages.length,
    languagesUsed: languagesUsed.size,
    categories: categories.length,
    courses: courses.length,
    snippets: snippets.length,
    snippetsTrashed: snippets.filter((s) => s.trashed).length,
    cardsTrashed: cards.filter((c) => c.trashed).length,
    favorites: lessons.filter((l) => l.favorite).length + snippets.filter((s) => s.favorite).length,
    archived: lessons.filter((l) => l.archived).length,
    reviewDue:
      lessons.filter((l) => l.reviewAt && l.reviewAt <= now && !l.archived).length +
      activeCards.filter((c) => c.dueAt <= now).length,
    cards: activeCards.length,
    cardsPendingApproval: cards.filter((c) => c.source === 'ai' && !c.approved).length,
    progress: byStatus,
    storage: await estimateStorage(),
  };
}
