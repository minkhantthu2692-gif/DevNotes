/**
 * validate.js — input validation and normalization for records and backups.
 * Pure module (no DOM, no IndexedDB) so unit tests can exercise it directly.
 * Nothing imported from a file is written to the database before it passes
 * through here.
 */

import { slugify, uuid } from './id.js';

export const LIMITS = {
  title: 200,
  summary: 2000,
  content: 2_000_000,      // 2 MB of Markdown per lesson
  code: 500_000,
  tags: 30,
  tagLength: 48,
  notes: 50_000,
  sourceUrls: 20,
  backupBytes: 200_000_000,
  importRecords: 50_000,
};

const clamp = (value, max) => String(value ?? '').slice(0, max);

function asStringArray(value, { maxItems = 100, maxLength = 200 } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const clean = item.trim().slice(0, maxLength);
    if (clean) out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Accept only http(s) links; anything else is dropped silently for safety. */
export function sanitizeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch { /* fall through */ }
  return null;
}

export const LESSON_STATUSES = ['not-started', 'learning', 'learned'];
export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];

/**
 * Normalize an untrusted lesson-shaped object into a safe record.
 * @returns {{ok: boolean, value: object|null, errors: string[]}}
 */
export function normalizeLesson(input, { existing = null, now = Date.now() } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, value: null, errors: ['Lesson must be an object'] };
  }

  const title = clamp(input.title ?? existing?.title ?? '', LIMITS.title).trim();
  if (!title) errors.push('Lesson title is required');

  const content = clamp(input.content ?? existing?.content ?? '', LIMITS.content);
  if (content.length >= LIMITS.content) errors.push('Lesson content exceeds the 2 MB limit');

  const status = LESSON_STATUSES.includes(input.status) ? input.status : (existing?.status || 'not-started');
  const difficulty = DIFFICULTIES.includes(input.difficulty) ? input.difficulty : (existing?.difficulty || '');

  const sourceUrls = (Array.isArray(input.sourceUrls) ? input.sourceUrls : [])
    .map(sanitizeUrl)
    .filter(Boolean)
    .slice(0, LIMITS.sourceUrls);

  const nowStamp = now;
  const value = {
    id: existing?.id || input.id || uuid(),
    slug: clamp(input.slug ?? existing?.slug ?? slugify(title), 120).trim() || slugify(title),
    title,
    languageId: typeof input.languageId === 'string' ? input.languageId : (existing?.languageId || null),
    categoryId: typeof input.categoryId === 'string' ? input.categoryId : (existing?.categoryId || null),
    courseId: typeof input.courseId === 'string' ? input.courseId : (existing?.courseId || null),
    tags: asStringArray(input.tags ?? existing?.tags, { maxItems: LIMITS.tags, maxLength: LIMITS.tagLength }),
    summary: clamp(input.summary ?? existing?.summary ?? '', LIMITS.summary).trim(),
    content,
    notes: clamp(input.notes ?? existing?.notes ?? '', LIMITS.notes),
    difficulty,
    status,
    favorite: Boolean(input.favorite ?? existing?.favorite ?? false),
    pinned: Boolean(input.pinned ?? existing?.pinned ?? false),
    archived: Boolean(input.archived ?? existing?.archived ?? false),
    trashed: Boolean(input.trashed ?? existing?.trashed ?? false),
    trashAt: input.trashAt ?? existing?.trashAt ?? null,
    reviewAt: Number.isFinite(input.reviewAt) ? input.reviewAt : (existing?.reviewAt ?? null),
    sourceUrls,
    order: Number.isFinite(input.order) ? input.order : (existing?.order ?? nowStamp),
    revision: Number.isFinite(existing?.revision) ? existing.revision : 0,
    baseRevision: Number.isFinite(existing?.baseRevision) ? existing.baseRevision : 0,
    createdAt: existing?.createdAt ?? input.createdAt ?? nowStamp,
    updatedAt: nowStamp,
    lastOpenedAt: existing?.lastOpenedAt ?? input.lastOpenedAt ?? null,
  };

  return { ok: errors.length === 0, value: errors.length ? null : value, errors };
}

export function normalizeSnippet(input, { existing = null, now = Date.now() } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, value: null, errors: ['Snippet must be an object'] };
  }
  const name = clamp(input.name ?? existing?.name ?? '', 200).trim();
  if (!name) errors.push('Snippet name is required');
  const code = clamp(input.code ?? existing?.code ?? '', LIMITS.code);

  const value = {
    id: existing?.id || input.id || uuid(),
    name,
    description: clamp(input.description ?? existing?.description ?? '', LIMITS.summary).trim(),
    language: clamp(input.language ?? existing?.language ?? '', 60).trim(),
    code,
    tags: asStringArray(input.tags ?? existing?.tags, { maxItems: LIMITS.tags, maxLength: LIMITS.tagLength }),
    lessonId: typeof input.lessonId === 'string' ? input.lessonId : (existing?.lessonId ?? null),
    favorite: Boolean(input.favorite ?? existing?.favorite ?? false),
    trashed: Boolean(input.trashed ?? existing?.trashed ?? false),
    trashAt: input.trashAt ?? existing?.trashAt ?? null,
    revision: Number.isFinite(existing?.revision) ? existing.revision : 0,
    baseRevision: Number.isFinite(existing?.baseRevision) ? existing.baseRevision : 0,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
  return { ok: errors.length === 0, value: errors.length ? null : value, errors };
}

export function normalizeFlashcard(input, { existing = null, now = Date.now() } = {}) {
  const errors = [];
  const front = clamp(input.front ?? existing?.front ?? '', 4000).trim();
  const back = clamp(input.back ?? existing?.back ?? '', 8000).trim();
  if (!front) errors.push('Card front is required');
  if (!back) errors.push('Card back is required');

  const value = {
    id: existing?.id || input.id || uuid(),
    front,
    back,
    lessonId: typeof input.lessonId === 'string' ? input.lessonId : (existing?.lessonId ?? null),
    tags: asStringArray(input.tags ?? existing?.tags, { maxItems: LIMITS.tags, maxLength: LIMITS.tagLength }),
    source: input.source === 'ai' || input.source === 'manual' ? input.source : (existing?.source || 'manual'),
    // AI drafts default to unapproved and stay that way through edits that
    // don't mention `approved`; an explicit patch (repo.approve()) or a brand
    // new manual card decides for itself.
    approved: input.source === 'ai'
      ? Boolean(input.approved)
      : (input.approved ?? existing?.approved ?? true),
    box: Number.isFinite(existing?.box) ? existing.box : 1,
    dueAt: Number.isFinite(existing?.dueAt) ? existing.dueAt : now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    trashed: Boolean(input.trashed ?? existing?.trashed ?? false),
  };
  return { ok: errors.length === 0, value: errors.length ? null : value, errors };
}

/**
 * Validate a parsed backup file before any record is touched.
 * @param {any} data parsed JSON
 * @returns {{ok: boolean, errors: string[], counts: object, version: number|null,
 *            records: {lessons: object[], snippets: object[], languages: object[],
 *                      categories: object[], courses: object[], flashcards: object[]}}}
 */
export function validateBackup(data) {
  const errors = [];
  const empty = { lessons: [], snippets: [], languages: [], categories: [], courses: [], flashcards: [], preferences: null };

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['Backup must be a JSON object'], counts: {}, version: null, records: empty };
  }

  const version = Number.isFinite(data.schemaVersion) ? data.schemaVersion : null;
  if (version === null) return { ok: false, errors: ['Missing schemaVersion'], counts: {}, version: null, records: empty };
  if (version > 1) return { ok: false, errors: [`Unsupported backup version ${version} (this app reads version 1)`], counts: {}, version, records: empty };

  const dataBlock = data.data && typeof data.data === 'object' ? data.data : null;
  if (!dataBlock) return { ok: false, errors: ['Missing data section'], counts: {}, version, records: empty };

  const pick = (key, normalizer) => {
    const raw = dataBlock[key];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      errors.push(`"${key}" must be an array`);
      return [];
    }
    if (raw.length > LIMITS.importRecords) {
      errors.push(`"${key}" contains more than ${LIMITS.importRecords} records`);
      return [];
    }
    const out = [];
    raw.forEach((item, index) => {
      const result = normalizer(item);
      if (result.ok) out.push(result.value);
      else errors.push(`${key}[${index}]: ${result.errors.join('; ')}`);
    });
    return out;
  };

  const records = {
    languages: pick('languages', (item) => normalizeTaxonomy(item, 'language')),
    categories: pick('categories', (item) => normalizeTaxonomy(item, 'category')),
    courses: pick('courses', (item) => normalizeTaxonomy(item, 'course')),
    lessons: pick('lessons', (item) => normalizeLesson(item)),
    snippets: pick('snippets', (item) => normalizeSnippet(item)),
    flashcards: pick('flashcards', (item) => normalizeFlashcard(item)),
    preferences: dataBlock.preferences && typeof dataBlock.preferences === 'object' ? dataBlock.preferences : null,
  };

  const counts = Object.fromEntries(
    Object.entries(records).map(([k, v]) => [k, Array.isArray(v) ? v.length : (v ? 1 : 0)]),
  );

  // Structural problems (bad shape, wrong version, missing data) returned
  // early with ok:false. Individual invalid records were already dropped and
  // reported above — they must NOT block restoring the rest of the backup
  // (AGENTS.md §14: a single corrupt record cannot make a 999-record restore
  // impossible). The caller surfaces `errors` in the import preview.
  return { ok: true, errors, counts, version, records };
}

/** Languages / categories / courses share the same simple shape. */
export function normalizeTaxonomy(input, kind, { existing = null, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') {
    return { ok: false, value: null, errors: [`${kind} must be an object`] };
  }
  const name = clamp(input.name ?? existing?.name ?? '', 120).trim();
  if (!name) return { ok: false, value: null, errors: [`${kind} name is required`] };

  return {
    ok: true,
    value: {
      id: existing?.id || input.id || uuid(),
      kind, // 'language' | 'category' | 'course'
      name,
      slug: slugify(name),
      description: clamp(input.description ?? existing?.description ?? '', 1000),
      // Languages carry a type so users can add frameworks/libraries/topics
      // without code changes (library requirement §6). An explicitly empty
      // value is the UI's "Unset" choice and must persist as-is; only a
      // missing/unknown value defaults to 'language' for new records.
      type: kind === 'language'
        ? (input.type === '' || input.type === null
            ? ''
            : (['language', 'framework', 'library', 'topic'].includes(input.type) ? input.type : 'language'))
        : (existing?.type ?? ''),
      // Courses may be grouped under a language/category. These links are part
      // of the course's shape (coursesRepo.listFor filters on them), so they
      // must survive updates and imports instead of being dropped.
      ...(kind === 'course'
        ? {
            languageId: typeof input.languageId === 'string' ? input.languageId : (existing?.languageId ?? null),
            categoryId: typeof input.categoryId === 'string' ? input.categoryId : (existing?.categoryId ?? null),
          }
        : {}),
      parentId: typeof input.parentId === 'string' ? input.parentId : (existing?.parentId ?? null),
      order: Number.isFinite(input.order) ? input.order : (existing?.order ?? now),
      revision: Number.isFinite(existing?.revision) ? existing.revision : 0,
      baseRevision: Number.isFinite(existing?.baseRevision) ? existing.baseRevision : 0,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
      trashed: Boolean(input.trashed ?? existing?.trashed ?? false),
    },
    errors: [],
  };
}
