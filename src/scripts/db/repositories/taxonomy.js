/**
 * taxonomy.js — languages, categories and courses.
 * Users can add new languages/frameworks/libraries/topics at runtime, so no
 * code change is ever required to introduce a new technology (§6).
 */

import { createRepository } from './base.js';
import { normalizeTaxonomy } from '../../utils/validate.js';
import { readAll } from '../database.js';

const makeRepo = (kind) =>
  createRepository({
    store: kind === 'language' ? 'languages' : kind === 'category' ? 'categories' : 'courses',
    entity: kind,
    labelField: 'name',
    normalize: (input, opts) => normalizeTaxonomy(input, kind, opts),
  });

export const languagesRepo = makeRepo('language');
export const categoriesRepo = makeRepo('category');
export const coursesRepo = makeRepo('course');

/** Case-insensitive lookup by display name. */
async function findByName(storeKind, name) {
  const all = await readAll(storeKind === 'language' ? 'languages' : storeKind === 'category' ? 'categories' : 'courses');
  const wanted = String(name ?? '').trim().toLowerCase();
  return all.find((item) => item.name.toLowerCase() === wanted) ?? null;
}

/**
 * Find or create a taxonomy entry by name (used by the editor's quick-add
 * and by imports). Returns the record.
 */
export async function ensureTaxonomy(kind, name) {
  const repo = kind === 'language' ? languagesRepo : kind === 'category' ? categoriesRepo : coursesRepo;
  const existing = await findByName(kind, name);
  if (existing) return existing;
  return repo.create({ name });
}

/** Courses optionally belong to a language/category. */
coursesRepo.listFor = async function listFor({ languageId = null, categoryId = null } = {}) {
  const all = await coursesRepo.getAll({ includeTrashed: true });
  return all.filter((course) => {
    if (languageId && course.languageId && course.languageId !== languageId) return false;
    if (categoryId && course.categoryId && course.categoryId !== categoryId) return false;
    return true;
  });
};
