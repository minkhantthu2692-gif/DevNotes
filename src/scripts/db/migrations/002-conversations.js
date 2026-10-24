/**
 * 002-conversations.js — persistent AI chat history (AGENTS.md §13, §12).
 *
 * Conversations are LOCAL ONLY: the store is intentionally absent from the
 * sync engine's entity list and the repositories never enqueue queue rows,
 * so chat history never leaves the device (see repositories/conversations.js).
 * Messages live embedded in one record — a conversation and its messages
 * always change together, so one transaction keeps them consistent.
 */

export const migration002 = {
  version: 2,
  name: 'conversations',
  upgrade(db) {
    const conversations = db.createObjectStore('conversations', { keyPath: 'id' });
    conversations.createIndex('by-createdAt', 'createdAt');
    conversations.createIndex('by-updatedAt', 'updatedAt');
  },
};
