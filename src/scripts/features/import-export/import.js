/**
 * import.js — restore a versioned backup with preview and explicit modes.
 *
 * Flow (AGENTS.md §14):
 *   1. readBackupJson(file)   — size + JSON parsing guards.
 *   2. analyzeBackup(parsed)  — schema validation (validateBackup) plus a diff
 *                               against the current library (new vs existing).
 *   3. applyImport(analysis, {mode}) — one transaction; merge never overwrites,
 *                               replace requires a separate typed confirmation
 *                               (handled by the Settings UI, not here).
 * No record is ever written before step 3, and a failed step 3 leaves the
 * library untouched because the whole write is one IndexedDB transaction.
 */

import { validateBackup, LIMITS } from '../../utils/validate.js';
import { backupRepo } from '../../db/repositories/backup.js';
import { AppError } from '../../utils/errors.js';

export const ENTITY_LABELS = {
  lessons: 'Lessons',
  snippets: 'Snippets',
  flashcards: 'Flashcards',
  languages: 'Languages',
  categories: 'Categories',
  courses: 'Courses',
};

/** @returns {Promise<object>} the parsed backup JSON */
export async function readBackupJson(file) {
  if (!file) throw new AppError('No file selected.', { code: 'invalid', retryable: false });
  if (file.size > LIMITS.backupBytes) {
    throw new AppError(
      `That file is ${formatSizeHint(file.size)} — backups are capped at ${formatSizeHint(LIMITS.backupBytes)}.`,
      { code: 'too-large', retryable: false },
    );
  }
  let text;
  try {
    text = await file.text();
  } catch (err) {
    throw new AppError('The file could not be read.', { code: 'read', retryable: false, cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AppError('That file is not valid JSON. Choose a DevNotes .json backup.', { code: 'parse', retryable: false, cause: err });
  }
}

function formatSizeHint(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Validate + diff a parsed backup against the current library.
 * @returns {Promise<{ok, errors, version, totalRecords, entities, preferences}>}
 */
export async function analyzeBackup(parsed) {
  const validation = validateBackup(parsed);
  const index = await backupRepo.localIndex();

  const entities = Object.entries(ENTITY_LABELS).map(([store, label]) => {
    const total = validation.counts[store] ?? 0;
    const existing = Array.isArray(validation.records[store])
      ? validation.records[store].filter((record) => index[store].ids.has(record.id)).length
      : 0;
    return {
      store,
      label,
      total,
      existing,
      added: total - existing,
    };
  });

  const totalRecords = entities.reduce((sum, entity) => sum + entity.total, 0);
  const totalAdded = entities.reduce((sum, entity) => sum + entity.added, 0);

  return {
    ok: validation.ok && totalRecords > 0,
    errors: validation.errors,
    version: validation.version,
    records: validation.records,
    entities,
    totalRecords,
    totalAdded,
    preferences: Boolean(validation.records.preferences),
    empty: totalRecords === 0,
  };
}

/**
 * Apply a previously analyzed backup.
 * @param {Awaited<ReturnType<typeof analyzeBackup>>} analysis
 * @param {{mode: 'merge'|'replace'}} options
 */
export async function applyImport(analysis, { mode }) {
  if (!analysis?.ok) {
    throw new AppError('This backup cannot be imported.', { code: 'invalid', retryable: false });
  }
  if (mode !== 'merge' && mode !== 'replace') {
    throw new AppError('Choose how to import: merge or replace.', { code: 'invalid', retryable: false });
  }
  const result = await backupRepo.applyRecords(analysis.records, { mode });
  return {
    ...result,
    preferencesApplied: result.preferencesApplied,
  };
}
