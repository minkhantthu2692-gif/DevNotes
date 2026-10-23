/**
 * snippets.js — standalone code snippets.
 *
 * Relationship to lessons: a snippet may reference a lesson (`lessonId`) but
 * editing the snippet NEVER modifies the lesson, and vice versa — the link is
 * informational (requirement §10, explicit update behaviour).
 */

import { createRepository } from './base.js';
import { normalizeSnippet } from '../../utils/validate.js';
import { readAll } from '../database.js';

export const snippetsRepo = createRepository({
  store: 'snippets',
  entity: 'snippet',
  labelField: 'name',
  normalize: normalizeSnippet,
});

/** Extract an excerpt of a lesson into a standalone snippet. */
snippetsRepo.createFromLesson = async function createFromLesson(lesson, { name, code, language = '' } = {}) {
  return snippetsRepo.create({
    name: name || `${lesson.title} — excerpt`,
    code: code ?? '',
    language: language || '',
    description: lesson.summary || '',
    tags: [...(lesson.tags ?? [])],
    lessonId: lesson.id,
  });
};

/** Snippets linked to a lesson (read-only linkage). */
snippetsRepo.forLesson = async function forLesson(lessonId) {
  const all = await readAll('snippets');
  return all.filter((snippet) => snippet.lessonId === lessonId && !snippet.trashed);
};
