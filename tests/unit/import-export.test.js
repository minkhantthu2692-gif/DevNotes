import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { wipeLocalDatabase } = await import('../../src/scripts/db/database.js');
const { lessonsRepo } = await import('../../src/scripts/db/repositories/index.js');
const { readBackupJson, analyzeBackup, applyImport, ENTITY_LABELS } =
  await import('../../src/scripts/features/import-export/import.js');
const { normalizeLesson, LIMITS } = await import('../../src/scripts/utils/validate.js');
const { AppError } = await import('../../src/scripts/utils/errors.js');

/** File-like object: the importer only uses .size and .text(). */
const fakeFile = (text, size = null) => ({
  name: 'backup.json',
  size: size ?? text.length,
  text: async () => text,
});

function backupDoc(lessons = [], extra = {}) {
  return {
    schemaVersion: 1,
    data: {
      lessons,
      snippets: [],
      languages: [],
      categories: [],
      courses: [],
      flashcards: [],
      ...extra,
    },
  };
}

function lessonRecord(title) {
  const { value, ok } = normalizeLesson({ title });
  assert.ok(ok);
  return value;
}

test.beforeEach(async () => {
  await wipeLocalDatabase();
});

/* ------------------------------------------------------- readBackupJson -- */

test('readBackupJson: parses a valid file', async () => {
  const parsed = await readBackupJson(fakeFile(JSON.stringify(backupDoc([lessonRecord('A')]))));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.data.lessons.length, 1);
});

test('readBackupJson: oversized files are refused before reading', async () => {
  await assert.rejects(
    () => readBackupJson(fakeFile('{}', LIMITS.backupBytes + 1)),
    (err) => err instanceof AppError && err.code === 'too-large',
  );
});

test('readBackupJson: invalid JSON is a clear parse error', async () => {
  await assert.rejects(
    () => readBackupJson(fakeFile('{not json')),
    (err) => err instanceof AppError && err.code === 'parse',
  );
});

test('readBackupJson: missing file is rejected', async () => {
  await assert.rejects(() => readBackupJson(null), (err) => err instanceof AppError);
});

/* ---------------------------------------------------------- analyzeBackup */

test('analyzeBackup: diffs the file against the current library', async () => {
  const local = await lessonsRepo.create({ title: 'Already here' });

  const fileLesson = lessonRecord('Brand new');
  const clashLesson = { ...lessonRecord('Clash'), id: local.id };
  const analysis = await analyzeBackup(backupDoc([fileLesson, clashLesson]));

  assert.equal(analysis.ok, true);
  assert.equal(analysis.version, 1);

  const lessons = analysis.entities.find((entity) => entity.store === 'lessons');
  assert.equal(lessons.total, 2);
  assert.equal(lessons.existing, 1);
  assert.equal(lessons.added, 1);
  assert.equal(analysis.totalRecords, 2);
  assert.equal(ENTITY_LABELS.lessons, 'Lessons');
});

test('analyzeBackup: invalid backups are marked not-ok with errors', async () => {
  const analysis = await analyzeBackup({ schemaVersion: 99, data: backupDoc().data });
  assert.equal(analysis.ok, false);
  assert.ok(analysis.errors.length > 0);
});

test('analyzeBackup: a backup whose records are all invalid is flagged empty', async () => {
  const analysis = await analyzeBackup(backupDoc([{ content: 'no title' }]));
  assert.equal(analysis.ok, false);
  assert.equal(analysis.empty, true);
});

/* ------------------------------------------------------------ applyImport */

test('applyImport: merge adds only missing records', async () => {
  const local = await lessonsRepo.create({ title: 'Local' });
  const analysis = await analyzeBackup(
    backupDoc([lessonRecord('Imported'), { ...lessonRecord('Clash'), id: local.id }]),
  );

  const result = await applyImport(analysis, { mode: 'merge' });
  assert.equal(result.mode, 'merge');
  assert.equal(result.created.lessons, 1);
  assert.equal(result.skipped.lessons, 1);

  const titles = (await lessonsRepo.getAll()).map((r) => r.title).sort();
  assert.deepEqual(titles, ['Imported', 'Local']);
});

test('applyImport: replace swaps the library entirely', async () => {
  await lessonsRepo.create({ title: 'Old A' });
  await lessonsRepo.create({ title: 'Old B' });

  const analysis = await analyzeBackup(backupDoc([lessonRecord('New only')]));
  await applyImport(analysis, { mode: 'replace' });

  const all = await lessonsRepo.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'New only');
});

test('applyImport: refuses unvalidated analyses and unknown modes', async () => {
  const bad = await analyzeBackup({ schemaVersion: 99, data: {} });
  await assert.rejects(() => applyImport(bad, { mode: 'merge' }));

  const good = await analyzeBackup(backupDoc([lessonRecord('X')]));
  await assert.rejects(() => applyImport(good, { mode: 'overwrite' }));
  assert.equal((await lessonsRepo.getAll()).length, 0, 'nothing written on refusal');
});

test('applyImport: the local library survives a failed validation step', async () => {
  await lessonsRepo.create({ title: 'Survivor' });
  const parsed = { nonsense: true };
  const analysis = await analyzeBackup(parsed);
  assert.equal(analysis.ok, false);
  assert.equal((await lessonsRepo.getAll()).length, 1);
});
