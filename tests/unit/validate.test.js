import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  LESSON_STATUSES,
  normalizeLesson,
  normalizeSnippet,
  normalizeFlashcard,
  normalizeTaxonomy,
  sanitizeUrl,
  validateBackup,
} from '../../src/scripts/utils/validate.js';

/* ------------------------------------------------------------- lessons -- */

test('normalizeLesson: defaults and slug from title', () => {
  const { ok, value, errors } = normalizeLesson({ title: 'JavaScript: Closures' });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(value.title, 'JavaScript: Closures');
  assert.ok(value.slug.length > 0, 'slug is generated');
  assert.notEqual(value.slug, value.title, 'slug is sanitized, not the raw title');
  assert.equal(value.status, 'not-started');
  assert.equal(value.favorite, false);
  assert.equal(value.trashed, false);
  assert.equal(value.trashAt, null);
  assert.equal(value.revision, 0, 'revision is owned by the repository, not the normalizer');
  assert.deepEqual(value.tags, []);
  assert.deepEqual(value.sourceUrls, []);
});

test('normalizeLesson: title required', () => {
  const { ok, value, errors } = normalizeLesson({ content: 'x' });
  assert.equal(ok, false);
  assert.equal(value, null);
  assert.ok(errors.some((e) => /title/i.test(e)));
});

test('normalizeLesson: invalid status/difficulty fall back safely', () => {
  const { value } = normalizeLesson({ title: 'T', status: 'hacked', difficulty: 'godlike' });
  assert.ok(LESSON_STATUSES.includes(value.status));
  assert.equal(value.difficulty, '');
});

test('normalizeLesson: source URLs are limited to http(s)', () => {
  const { value } = normalizeLesson({
    title: 'T',
    sourceUrls: [
      'https://example.com/a',
      'http://example.com/b',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
    ],
  });
  assert.equal(value.sourceUrls.length, 2);
  assert.ok(value.sourceUrls.every((url) => url.startsWith('http')));
});

test('normalizeLesson: existing record fields survive a partial update', () => {
  const created = normalizeLesson({ title: 'Original', content: 'body', tags: ['a'] }).value;
  created.id = 'fixed-id';
  created.revision = 4;
  created.createdAt = 1111;

  const { value } = normalizeLesson({ summary: 'new summary' }, { existing: created, now: 9999 });
  assert.equal(value.id, 'fixed-id');
  assert.equal(value.title, 'Original');
  assert.equal(value.content, 'body');
  assert.equal(value.summary, 'new summary');
  assert.equal(value.createdAt, 1111);
  assert.equal(value.updatedAt, 9999);
  assert.equal(value.revision, 4);
});

test('normalizeLesson: tags are trimmed, deduplicated by slug rules and capped', () => {
  const { value } = normalizeLesson({
    title: 'T',
    tags: ['  Arrays ', '', 'arrays', 42, 'Web Dev'],
  });
  assert.ok(value.tags.includes('Arrays'));
  assert.ok(value.tags.includes('Web Dev'));
  assert.ok(!value.tags.includes(''));
  assert.ok(!value.tags.some((t) => typeof t !== 'string'));
});

/* ------------------------------------------------------------ snippets -- */

test('normalizeSnippet: name and code validated, language free-form', () => {
  const bad = normalizeSnippet({ code: 'x' });
  assert.equal(bad.ok, false);

  const good = normalizeSnippet({ name: 'Debounce', code: 'fn()', language: 'JavaScript' });
  assert.equal(good.ok, true);
  assert.equal(good.value.language, 'JavaScript');
  assert.equal(good.value.favorite, false);
});

test('normalizeSnippet: lessonId only accepted as a string', () => {
  const a = normalizeSnippet({ name: 'N', code: 'c', lessonId: 'lesson-1' }).value;
  const b = normalizeSnippet({ name: 'N', code: 'c', lessonId: { evil: true } }).value;
  assert.equal(a.lessonId, 'lesson-1');
  assert.equal(b.lessonId, null);
});

/* ----------------------------------------------------------- flashcards -- */

test('normalizeFlashcard: manual cards default to approved, box 1', () => {
  const { value } = normalizeFlashcard({ front: 'What is a closure?', back: 'A function capturing its scope.' });
  assert.equal(value.source, 'manual');
  assert.equal(value.approved, true);
  assert.equal(value.box, 1);
  assert.ok(value.dueAt > 0);
});

test('normalizeFlashcard: AI drafts stay unapproved until explicitly approved', () => {
  const draft = normalizeFlashcard({
    front: 'Q', back: 'A', source: 'ai', approved: false,
  }).value;
  assert.equal(draft.source, 'ai');
  assert.equal(draft.approved, false);

  // An update that forgets `approved` must not silently approve an AI draft.
  const updated = normalizeFlashcard(
    { front: 'Q2', back: 'A2', source: 'ai' },
    { existing: draft },
  ).value;
  assert.equal(updated.approved, false);
});

test('normalizeFlashcard: front and back are required', () => {
  assert.equal(normalizeFlashcard({ front: '', back: 'A' }).ok, false);
  assert.equal(normalizeFlashcard({ front: 'Q', back: '' }).ok, false);
});

test('normalizeFlashcard: existing schedule survives an edit', () => {
  const card = normalizeFlashcard({ front: 'Q', back: 'A' }).value;
  card.box = 3;
  card.dueAt = 12345;

  const { value } = normalizeFlashcard({ front: 'Q-new' }, { existing: card });
  assert.equal(value.box, 3);
  assert.equal(value.dueAt, 12345);
});

/* ------------------------------------------------------------ taxonomy -- */

test('normalizeTaxonomy: name required; kind decides type handling', () => {
  assert.equal(normalizeTaxonomy({ name: '' }, 'language').ok, false);
  assert.equal(normalizeTaxonomy(null, 'language').ok, false);

  const lang = normalizeTaxonomy({ name: 'React', type: 'framework' }, 'language').value;
  assert.equal(lang.type, 'framework');

  const unknown = normalizeTaxonomy({ name: 'X', type: 'nonsense' }, 'language').value;
  assert.equal(unknown.type, 'language', 'unknown types fall back to "language"');

  const unset = normalizeTaxonomy({ name: 'X', type: '' }, 'language').value;
  assert.equal(unset.type, '', 'the UI "Unset" choice round-trips for languages');

  const category = normalizeTaxonomy({ name: 'Algorithms', type: 'framework' }, 'category').value;
  assert.equal(category.type, '', 'categories do not carry a language type');
});

test('normalizeTaxonomy: course language/category links survive updates', () => {
  const course = normalizeTaxonomy(
    { name: 'CS50', languageId: 'lang-1', categoryId: 'cat-1' },
    'course',
  ).value;
  assert.equal(course.languageId, 'lang-1');
  assert.equal(course.categoryId, 'cat-1');

  // A partial update that forgets the links must not drop them
  // (coursesRepo.listFor filters on these fields).
  const edited = normalizeTaxonomy(
    { name: 'CS50 updated' },
    'course',
    { existing: course },
  ).value;
  assert.equal(edited.languageId, 'lang-1');
  assert.equal(edited.categoryId, 'cat-1');

  // Non-course kinds never gain these fields.
  const lang = normalizeTaxonomy({ name: 'JS' }, 'language').value;
  assert.equal('languageId' in lang, false);
});

/* --------------------------------------------------------------- urls --- */

test('sanitizeUrl: only http(s) survives', () => {
  assert.ok(sanitizeUrl('https://example.com')?.startsWith('https://'));
  assert.equal(sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeUrl('ftp://x'), null);
  assert.equal(sanitizeUrl(''), null);
  assert.equal(sanitizeUrl(null), null);
});

/* ------------------------------------------------------------- backups -- */

function lessonRecord(title, extra = {}) {
  const { value, ok } = normalizeLesson({ title, ...extra });
  assert.equal(ok, true);
  return value;
}

test('validateBackup: rejects non-objects and missing/unsupported versions', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup([]).ok, false);
  assert.equal(validateBackup({ data: {} }).ok, false, 'schemaVersion is mandatory');
  assert.equal(validateBackup({ schemaVersion: 99, data: {} }).ok, false, 'future versions are refused');
});

test('validateBackup: valid document is normalized, invalid records land in errors', () => {
  const doc = {
    schemaVersion: 1,
    data: {
      lessons: [lessonRecord('Good lesson'), { content: 'no title here' }],
      snippets: [],
      languages: [],
      categories: [],
      courses: [],
      flashcards: [],
    },
  };
  const result = validateBackup(doc);
  assert.equal(result.ok, true);
  assert.equal(result.records.lessons.length, 1);
  assert.equal(result.records.lessons[0].title, 'Good lesson');
  assert.ok(result.errors.length >= 1, 'the titleless lesson is reported, not imported');
});

test('validateBackup: record count is capped, oversized keys are dropped and reported', () => {
  const doc = {
    schemaVersion: 1,
    data: {
      lessons: Array.from({ length: LIMITS.importRecords + 5 }, (_, i) => lessonRecord(`L${i}`)),
      snippets: [], languages: [], categories: [], courses: [], flashcards: [],
    },
  };
  const result = validateBackup(doc);
  assert.equal(result.records.lessons.length, 0, 'an oversized key imports nothing (never a partial 50k)');
  assert.ok(result.errors.some((e) => /more than/.test(e)), 'the cap is reported to the user');
  assert.equal(result.ok, true, 'structural doc is still valid — the preview explains what was skipped');
});
