/**
 * export.js — versioned library backup export (AGENTS.md §14).
 *
 * Two formats:
 *  - JSON: the canonical, versioned backup (schemaVersion 1). Everything the
 *    app knows — including trashed records — plus optional preferences.
 *  - ZIP: the same JSON (without preferences) plus readable Markdown files
 *    organized by language/category, so the archive is useful outside DevNotes.
 *
 * The ZIP library is lazy-loaded; the JSON path has zero dependencies.
 */

import { APP } from '../../config.js';
import { downloadJSON, downloadBlob } from '../../utils/download.js';
import { backupRepo } from '../../db/repositories/backup.js';
import { slugify } from '../../utils/id.js';
import { formatBytes } from '../../utils/format.js';

const JSZIP_SRC = './src/vendor/jszip/jszip.min.js';

export const ZIP_ENTITY_COUNTS = 6;

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function backupFilename() {
  return `devnotes-backup-${stamp()}.json`;
}

export function zipFilename() {
  return `devnotes-backup-${stamp()}.zip`;
}

function countOf(data) {
  return {
    lessons: data.lessons.length,
    snippets: data.snippets.length,
    flashcards: data.flashcards.length,
    languages: data.languages.length,
    categories: data.categories.length,
    courses: data.courses.length,
  };
}

/** Build the in-memory backup document (also used by the ZIP exporter). */
export async function buildBackupDocument({ includePreferences = true } = {}) {
  const data = await backupRepo.collect();
  if (!includePreferences) data.preferences = null;
  return {
    app: APP.name,
    schemaVersion: APP.backupFormat,
    appVersion: APP.version,
    exportedAt: new Date().toISOString(),
    counts: countOf(data),
    data,
  };
}

/** Download the canonical JSON backup. Returns the counts for the toast. */
export async function exportBackupJson({ includePreferences = true } = {}) {
  const document = await buildBackupDocument({ includePreferences });
  downloadJSON(document, backupFilename());
  return document.counts;
}

function loadJsZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) { resolve(window.JSZip); return; }
    const existing = document.querySelector('script[data-vendor="jszip"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.JSZip));
      existing.addEventListener('error', () => reject(new Error('Failed to load the ZIP library')));
      return;
    }
    const script = document.createElement('script');
    script.src = JSZIP_SRC;
    script.async = true;
    script.dataset.vendor = 'jszip';
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => reject(new Error('Failed to load the ZIP library'));
    document.head.appendChild(script);
  });
}

const STATUS_LABEL = { 'not-started': 'Not started', learning: 'Learning', learned: 'Learned' };

function lessonMarkdown(lesson, names) {
  const front = [
    '---',
    `title: ${JSON.stringify(lesson.title)}`,
    `language: ${JSON.stringify(names.language(lesson.languageId))}`,
    `category: ${JSON.stringify(names.category(lesson.categoryId))}`,
    `course: ${JSON.stringify(names.course(lesson.courseId))}`,
    `status: ${STATUS_LABEL[lesson.status] || lesson.status}`,
    `difficulty: ${lesson.difficulty || 'unspecified'}`,
    `tags: [${(lesson.tags || []).map((t) => JSON.stringify(t)).join(', ')}]`,
    `updated: ${new Date(lesson.updatedAt).toISOString()}`,
    '---',
    '',
  ].join('\n');

  const body = [front, lesson.summary ? `${lesson.summary}\n\n` : '', lesson.content || ''].join('');
  const notes = lesson.notes ? `\n\n---\n\n## Notes\n\n${lesson.notes}` : '';
  const sources = (lesson.sourceUrls || []).length
    ? `\n\n## Sources\n\n${lesson.sourceUrls.map((url) => `- <${url}>`).join('\n')}`
    : '';
  return `${body}${notes}${sources}\n`;
}

function snippetMarkdown(snippet) {
  return [
    '---',
    `name: ${JSON.stringify(snippet.name)}`,
    `language: ${JSON.stringify(snippet.language)}`,
    `tags: [${(snippet.tags || []).map((t) => JSON.stringify(t)).join(', ')}]`,
    '---',
    '',
    snippet.description ? `${snippet.description}\n\n` : '',
    '```' + (snippet.language || '').toLowerCase().replace(/[^a-z0-9+#-]/g, ''),
    snippet.code || '',
    '```',
    '',
  ].join('\n');
}

function readmeText(counts) {
  return [
    'DevNotes backup archive',
    '=======================',
    '',
    `Exported: ${new Date().toISOString()}`,
    `backup.json — the canonical DevNotes backup (schemaVersion ${APP.backupFormat}).`,
    '           Import this file in DevNotes → Settings → Data to restore.',
    '',
    'lessons/   — every lesson as Markdown with YAML front matter,',
    '             filed under <language>/<category>/<slug>.md',
    'snippets/  — code snippets as Markdown with fenced code blocks',
    '',
    'This archive holds:',
    `  lessons: ${counts.lessons} · snippets: ${counts.snippets} · flashcards: ${counts.flashcards}`,
    `  languages: ${counts.languages} · categories: ${counts.categories} · courses: ${counts.courses}`,
    '',
    'The Markdown files are a readable mirror for other tools; small details',
    '(boxes, review dates) only live in backup.json.',
    '',
  ].join('\n');
}

/**
 * Download a ZIP containing backup.json + per-record Markdown mirrors.
 * Preferences are intentionally excluded (device-specific).
 */
export async function exportBackupZip() {
  const JSZip = await loadJsZip();
  const document = await buildBackupDocument({ includePreferences: false });
  const { lessons, snippets, languages, categories, courses } = document.data;

  const zip = new JSZip();
  zip.file('backup.json', JSON.stringify(document, null, 2));
  zip.file('README.txt', readmeText(document.counts));

  const langById = new Map(languages.map((l) => [l.id, l]));
  const catById = new Map(categories.map((c) => [c.id, c]));
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const names = {
    language: (id) => langById.get(id)?.name ?? '',
    category: (id) => catById.get(id)?.name ?? '',
    course: (id) => courseById.get(id)?.name ?? '',
  };

  // Slugify with collision suffixes inside each folder.
  const usedPaths = new Set();
  const uniquePath = (folder, base) => {
    const slug = slugify(base || 'untitled') || 'untitled';
    let candidate = `${folder}/${slug}.md`;
    let n = 2;
    while (usedPaths.has(candidate)) candidate = `${folder}/${slug}-${n++}.md`;
    usedPaths.add(candidate);
    return candidate;
  };

  for (const lesson of lessons) {
    const lang = slugify(names.language(lesson.languageId)) || 'no-language';
    const cat = slugify(names.category(lesson.categoryId)) || 'uncategorized';
    zip.file(uniquePath(`lessons/${lang}/${cat}`, lesson.title), lessonMarkdown(lesson, names));
  }

  for (const snippet of snippets) {
    const lang = slugify(snippet.language) || 'misc';
    zip.file(uniquePath(`snippets/${lang}`, snippet.name), snippetMarkdown(snippet));
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  downloadBlob(blob, zipFilename());
  return { counts: document.counts, bytes: blob.size, sizeText: formatBytes(blob.size) };
}
