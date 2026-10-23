import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { wipeLocalDatabase } = await import('../../src/scripts/db/database.js');
const { lessonsRepo, snippetsRepo, flashcardsRepo, languagesRepo, activityLog, revisions } =
  await import('../../src/scripts/db/repositories/index.js');
const { backupRepo } = await import('../../src/scripts/db/repositories/backup.js');
const { ensureTaxonomy } = await import('../../src/scripts/db/repositories/taxonomy.js');
const { normalizeLesson } = await import('../../src/scripts/utils/validate.js');

test.beforeEach(async () => {
  await wipeLocalDatabase();
});

/* --------------------------------------------------------- lesson CRUD -- */

test('lessons: create bumps revision to 1 and stamps timestamps', async () => {
  const lesson = await lessonsRepo.create({ title: 'First lesson' });
  assert.equal(lesson.revision, 1);
  assert.ok(lesson.createdAt > 0);
  assert.ok(lesson.updatedAt >= lesson.createdAt);
  assert.ok(lesson.slug.length > 0);

  const fetched = await lessonsRepo.get(lesson.id);
  assert.equal(fetched.title, 'First lesson');
});

test('lessons: update bumps revision and preserves the id', async () => {
  const lesson = await lessonsRepo.create({ title: 'T' });
  const updated = await lessonsRepo.update(lesson.id, { title: 'T2', summary: 's' });
  assert.equal(updated.id, lesson.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.title, 'T2');
});

test('lessons: duplicate ids cannot be created', async () => {
  await lessonsRepo.create({ id: 'fixed', title: 'One' });
  await assert.rejects(() => lessonsRepo.create({ id: 'fixed', title: 'Two' }));
});

test('lessons: identical titles get distinct slugs', async () => {
  const a = await lessonsRepo.create({ title: 'Same Title' });
  const b = await lessonsRepo.create({ title: 'Same Title' });
  assert.notEqual(a.slug, b.slug);
});

test('lessons: validation failures reject before any write', async () => {
  await assert.rejects(() => lessonsRepo.create({ title: '   ' }));
  assert.equal((await lessonsRepo.getAll()).length, 0);
});

test('lessons: soft delete hides the record; restore brings it back; purge removes it', async () => {
  const lesson = await lessonsRepo.create({ title: 'Temp' });

  await lessonsRepo.softDelete(lesson.id);
  assert.equal((await lessonsRepo.getAll()).length, 0);
  const [trashed] = await lessonsRepo.getAll({ onlyTrashed: true });
  assert.equal(trashed.id, lesson.id);
  assert.ok(trashed.trashAt > 0, 'trash timestamp drives purge-by-age');

  await lessonsRepo.restore(lesson.id);
  assert.equal((await lessonsRepo.getAll()).length, 1);
  assert.equal((await lessonsRepo.get(lesson.id)).trashAt, null);

  await lessonsRepo.softDelete(lesson.id);
  await lessonsRepo.purge(lesson.id);
  assert.equal(await lessonsRepo.get(lesson.id), null);
});

/* ------------------------------------------------------ activity/revisions */

test('activity: create and trash are logged with readable labels', async () => {
  const lesson = await lessonsRepo.create({ title: 'Logged' });
  const rows = await activityLog.list({ limit: 50 });
  const created = rows.find((row) => row.entityId === lesson.id && row.action === 'created');
  assert.ok(created, 'creation is recorded');
  assert.ok(created.label.includes('Logged'), 'label carries the record title');
});

test('activity: rapid updates coalesce into a single row per record', async () => {
  const lesson = await lessonsRepo.create({ title: 'Coalesced' });
  await lessonsRepo.update(lesson.id, { summary: 'one' });
  await lessonsRepo.update(lesson.id, { summary: 'two' });
  await lessonsRepo.update(lesson.id, { summary: 'three' });

  const rows = await activityLog.list({ entity: 'lesson', limit: 100 });
  const updates = rows.filter((row) => row.entityId === lesson.id && row.action === 'updated');
  assert.equal(updates.length, 1, 'autosave bursts must not flood the timeline');
});

test('revisions: snapshots exist for edits, with burst coalescing', async () => {
  const lesson = await lessonsRepo.create({ title: 'Versioned', content: 'v1' });
  await lessonsRepo.update(lesson.id, { content: 'v2' });
  const afterFirst = await revisions.listFor(lesson.id);

  await lessonsRepo.update(lesson.id, { content: 'v3' });
  const afterSecond = await revisions.listFor(lesson.id);

  assert.ok(afterFirst.length >= 1, 'the first edit captures a snapshot');
  assert.equal(afterSecond.length, afterFirst.length, 'a second edit within the burst window is coalesced');
});

/* ------------------------------------------------------------ flashcards */

test('flashcards: approval moves an AI draft into the review queue', async () => {
  const draft = await flashcardsRepo.create({
    front: 'Q?', back: 'A.', source: 'ai', approved: false,
  });

  const dueBefore = await flashcardsRepo.getDue();
  assert.equal(dueBefore.length, 0, 'unapproved drafts are never due');

  await flashcardsRepo.approve(draft.id);
  const dueAfter = await flashcardsRepo.getDue();
  assert.equal(dueAfter.length, 1);
  assert.equal(dueAfter[0].id, draft.id);
});

test('flashcards: setSchedule stores the Leitner outcome and bumps the revision', async () => {
  const card = await flashcardsRepo.create({ front: 'Q', back: 'A' });
  const dueAt = Date.now() + 3 * 24 * 60 * 60 * 1000;

  const updated = await flashcardsRepo.setSchedule(card.id, { box: 3, dueAt });
  assert.equal(updated.box, 3);
  assert.equal(updated.dueAt, dueAt);
  assert.equal(updated.revision, card.revision + 1);
});

test('flashcards: stats reports totals, due count and pending drafts', async () => {
  const dueNow = await flashcardsRepo.create({ front: 'Q1', back: 'A1' }); // due immediately
  await flashcardsRepo.create({ front: 'Q2', back: 'A2', source: 'ai', approved: false });
  const later = await flashcardsRepo.create({ front: 'Q3', back: 'A3' });
  await flashcardsRepo.setSchedule(later.id, {
    box: 4,
    dueAt: Date.now() + 60_000,
  });

  const stats = await flashcardsRepo.stats();
  assert.equal(stats.total, 2, 'only approved cards count');
  assert.equal(stats.due, 1, 'the far-future card is not due');
  assert.equal(stats.pendingApproval, 1);
  assert.equal(stats.learned, 1, 'box >= 4 counts as learned');
  assert.ok(dueNow.id, 'card handles are kept for clarity');
});

/* -------------------------------------------------------------- taxonomy */

test('taxonomy: ensureTaxonomy deduplicates case-insensitively', async () => {
  const first = await ensureTaxonomy('language', 'JavaScript');
  const second = await ensureTaxonomy('language', 'javascript');
  assert.equal(first.id, second.id);
  assert.equal((await languagesRepo.getAll()).length, 1);
});

/* ------------------------------------------------------ backup apply ----- */

function lessonRecord(title, extra = {}) {
  const { value, ok } = normalizeLesson({ title, ...extra });
  assert.ok(ok);
  return value;
}

test('backup: collect reads every store (empty library → empty groups)', async () => {
  const data = await backupRepo.collect();
  assert.deepEqual(data.lessons, []);
  assert.deepEqual(data.snippets, []);
  assert.deepEqual(data.flashcards, []);
  assert.deepEqual(data.languages, []);
  assert.equal(data.preferences, null);
});

test('backup: merge adds new records and never overwrites existing ids', async () => {
  const local = await lessonsRepo.create({ title: 'Local lesson' });
  const incomingNew = lessonRecord('Imported lesson');
  const incomingClash = { ...lessonRecord('Should not win'), id: local.id };

  const result = await backupRepo.applyRecords(
    { lessons: [incomingNew, incomingClash] },
    { mode: 'merge' },
  );

  assert.equal(result.created.lessons, 1);
  assert.equal(result.skipped.lessons, 1);

  const all = await lessonsRepo.getAll();
  assert.equal(all.length, 2);
  assert.equal((await lessonsRepo.get(local.id)).title, 'Local lesson', 'existing record is untouched');
  assert.ok(all.some((r) => r.title === 'Imported lesson'));
});

test('backup: merged records with duplicate slugs get unique ones', async () => {
  await lessonsRepo.create({ title: 'Guide' });
  const incoming = lessonRecord('Guide'); // same title → same preferred slug

  await backupRepo.applyRecords({ lessons: [incoming] }, { mode: 'merge' });

  const all = await lessonsRepo.getAll();
  const slugs = all.map((r) => r.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slugs stay unique after import');
});

test('backup: replace wipes current content, applies preferences, keeps history', async () => {
  await lessonsRepo.create({ title: 'Old lesson' });
  await activityLog.list({ limit: 5 }); // ensure the activity store exists/has shape

  const incoming = lessonRecord('Fresh start');
  const result = await backupRepo.applyRecords(
    { lessons: [incoming], preferences: { theme: 'dark', fontSize: '1rem' } },
    { mode: 'replace' },
  );

  assert.equal(result.preferencesApplied, true);
  const all = await lessonsRepo.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'Fresh start');

  const rows = await activityLog.list({ limit: 50 });
  assert.ok(rows.some((row) => row.entity === 'import'), 'the import itself is logged');
});

test('backup: imported records get baseRevision 0 so they push as new', async () => {
  const incoming = lessonRecord('To be pushed');
  await backupRepo.applyRecords({ lessons: [incoming] }, { mode: 'merge' });
  const stored = await lessonsRepo.get(incoming.id);
  assert.equal(stored.baseRevision, 0);
  assert.ok(stored.revision >= 1);
});

test('backup: unknown mode is refused before touching any store', async () => {
  await lessonsRepo.create({ title: 'Safe' });
  await assert.rejects(
    () => backupRepo.applyRecords({ lessons: [] }, { mode: 'sideways' }),
    /Unknown import mode/,
  );
  assert.equal((await lessonsRepo.getAll()).length, 1, 'library untouched');
});

test('snippets: create/soft-delete/purge behave like lessons', async () => {
  const snippet = await snippetsRepo.create({ name: 'Debounce', code: 'fn', language: 'javascript' });
  assert.equal(snippet.name, 'Debounce');
  assert.equal(snippet.revision, 1);
  assert.ok(snippet.id.length > 0);

  await snippetsRepo.softDelete(snippet.id);
  assert.equal((await snippetsRepo.getAll()).length, 0);

  await snippetsRepo.restore(snippet.id);
  assert.equal((await snippetsRepo.getAll()).length, 1);

  await snippetsRepo.softDelete(snippet.id);
  await snippetsRepo.purge(snippet.id);
  assert.equal(await snippetsRepo.get(snippet.id), null);
});
