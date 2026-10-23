/**
 * 001-initial.js — first schema.
 *
 * Store layout (see AGENTS.md §17):
 *  - Content: lessons, snippets, flashcards, languages, categories, courses
 *  - History: revisions (lesson snapshots), activity (local audit trail)
 *  - Sync:    queue (pending operations), conflicts, meta (sync cursors)
 *  - Prefs:   preferences (typed settings), fonts (user-imported font blobs)
 *
 * Booleans are stored as 1/0 because IndexedDB indexes can't key on null.
 */

export const migration001 = {
  version: 1,
  name: 'initial-schema',
  upgrade(db) {
    // --- taxonomy ----------------------------------------------------------
    const languages = db.createObjectStore('languages', { keyPath: 'id' });
    languages.createIndex('by-slug', 'slug', { unique: true });
    languages.createIndex('by-order', 'order');
    languages.createIndex('by-trashed', 'trashed');

    const categories = db.createObjectStore('categories', { keyPath: 'id' });
    categories.createIndex('by-slug', 'slug', { unique: true });
    categories.createIndex('by-order', 'order');
    categories.createIndex('by-trashed', 'trashed');

    const courses = db.createObjectStore('courses', { keyPath: 'id' });
    courses.createIndex('by-slug', 'slug');
    courses.createIndex('by-order', 'order');
    courses.createIndex('by-category', 'categoryId');
    courses.createIndex('by-language', 'languageId');
    courses.createIndex('by-trashed', 'trashed');

    // --- lessons -----------------------------------------------------------
    const lessons = db.createObjectStore('lessons', { keyPath: 'id' });
    lessons.createIndex('by-slug', 'slug', { unique: true });
    lessons.createIndex('by-title', 'title');
    lessons.createIndex('by-createdAt', 'createdAt');
    lessons.createIndex('by-updatedAt', 'updatedAt');
    lessons.createIndex('by-lastOpened', 'lastOpenedAt');
    lessons.createIndex('by-order', 'order');
    lessons.createIndex('by-languageId', 'languageId');
    lessons.createIndex('by-categoryId', 'categoryId');
    lessons.createIndex('by-courseId', 'courseId');
    lessons.createIndex('by-status', 'status');
    lessons.createIndex('by-favorite', 'favorite');
    lessons.createIndex('by-archived', 'archived');
    lessons.createIndex('by-trashed', 'trashed');
    lessons.createIndex('by-reviewAt', 'reviewAt');

    // --- snippets ----------------------------------------------------------
    const snippets = db.createObjectStore('snippets', { keyPath: 'id' });
    snippets.createIndex('by-name', 'name');
    snippets.createIndex('by-createdAt', 'createdAt');
    snippets.createIndex('by-updatedAt', 'updatedAt');
    snippets.createIndex('by-language', 'language');
    snippets.createIndex('by-favorite', 'favorite');
    snippets.createIndex('by-lesson', 'lessonId');
    snippets.createIndex('by-trashed', 'trashed');

    // --- flashcards --------------------------------------------------------
    const cards = db.createObjectStore('flashcards', { keyPath: 'id' });
    cards.createIndex('by-lesson', 'lessonId');
    cards.createIndex('by-due', 'dueAt');
    cards.createIndex('by-updatedAt', 'updatedAt');
    cards.createIndex('by-source', 'source');
    cards.createIndex('by-trashed', 'trashed');

    // --- history -----------------------------------------------------------
    const revisions = db.createObjectStore('revisions', { keyPath: 'id' });
    revisions.createIndex('by-lesson', 'lessonId');
    revisions.createIndex('by-at', 'at');

    const activity = db.createObjectStore('activity', { keyPath: 'id' });
    activity.createIndex('by-at', 'at');
    activity.createIndex('by-entity', 'entity');

    // --- synchronization ---------------------------------------------------
    const queue = db.createObjectStore('queue', { keyPath: 'opId' });
    queue.createIndex('by-status', 'status');
    queue.createIndex('by-nextAttempt', 'nextAttemptAt');
    queue.createIndex('by-entity', 'entity');
    queue.createIndex('by-created', 'createdAt');

    const conflicts = db.createObjectStore('conflicts', { keyPath: 'id' });
    conflicts.createIndex('by-entity', 'entity');
    conflicts.createIndex('by-detected', 'detectedAt');

    const meta = db.createObjectStore('meta', { keyPath: 'key' });

    // --- preferences & fonts ----------------------------------------------
    const preferences = db.createObjectStore('preferences', { keyPath: 'key' });

    const fonts = db.createObjectStore('fonts', { keyPath: 'id' });
    fonts.createIndex('by-name', 'family');
  },
};
