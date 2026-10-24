/**
 * conversations.js — AI chat history repository (local-first, LOCAL ONLY).
 *
 * Design notes:
 *  - Unlike createRepository() this module never touches the sync queue or
 *    the activity log: conversations must not sync to Supabase (AGENTS.md §13
 *    — keep chat history on-device) and would flood Activity & History with
 *    per-message noise.
 *  - One record holds one conversation with its messages embedded, so a
 *    conversation and its transcript always change inside one transaction.
 *  - Deletion is a hard delete (not trash): chat history is disposable by
 *    nature, the delete action is explicitly confirmed in the UI, and the
 *    Trash page only manages content entities.
 */

import { withStores, req, readAll, getRecord } from '../database.js';
import { AppError } from '../../utils/errors.js';
import { uuid } from '../../utils/id.js';

const STORE = 'conversations';
const MAX_TITLE = 120;
const MAX_MESSAGE_CHARS = 32_000;   // one message; matches a sane chat turn
const MAX_MESSAGES = 400;           // per conversation (session histories stay bounded)
const MAX_ATTACHMENTS = 2;          // mirrors the assistant page's attachment cap
const MAX_CONVERSATIONS = 200;      // oldest conversations are dropped past this

const asString = (value, max) => String(value ?? '').trim().slice(0, max);

function normalizeMessage(input, index) {
  if (!input || typeof input !== 'object') return null;
  const role = input.role === 'user' || input.role === 'assistant' ? input.role : null;
  const content = asString(input.content, MAX_MESSAGE_CHARS);
  if (!role || !content) return null;

  const message = {
    id: typeof input.id === 'string' && input.id ? input.id : `${uuid().slice(0, 8)}_${index}`,
    role,
    content,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
  };
  if (Array.isArray(input.attachments) && input.attachments.length) {
    message.attachments = input.attachments
      .filter((a) => a && typeof a === 'object' && typeof a.lessonId === 'string')
      .map((a) => ({ lessonId: a.lessonId, title: asString(a.title, MAX_TITLE) }))
      .slice(0, MAX_ATTACHMENTS);
  }
  if (input.usage && typeof input.usage === 'object') {
    const prompt = Number(input.usage.prompt);
    const completion = Number(input.usage.completion);
    if (Number.isFinite(prompt) || Number.isFinite(completion)) {
      message.usage = {
        prompt: Number.isFinite(prompt) ? prompt : null,
        completion: Number.isFinite(completion) ? completion : null,
      };
    }
  }
  if (input.model) message.model = asString(input.model, 80);
  if (input.note) message.note = asString(input.note, 200); // e.g. "stopped", "interrupted"
  return message;
}

function normalizeConversation(input, { existing = null, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') {
    throw new AppError('Conversation must be an object', { code: 'validation' });
  }
  const title = asString(input.title ?? existing?.title ?? '', MAX_TITLE) || 'New chat';
  const rawMessages = Array.isArray(input.messages) ? input.messages : existing?.messages || [];

  const messages = [];
  for (const raw of rawMessages.slice(-MAX_MESSAGES)) {
    const message = normalizeMessage(raw, messages.length);
    if (message) messages.push(message);
  }

  const attachments = (Array.isArray(input.attachments) ? input.attachments : existing?.attachments || [])
    .filter((a) => a && typeof a === 'object' && typeof a.lessonId === 'string')
    .map((a) => ({ lessonId: a.lessonId, title: asString(a.title, MAX_TITLE) }))
    .slice(0, MAX_ATTACHMENTS);

  return {
    id: existing?.id || input.id || uuid(),
    title,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
    lastOpenedAt: Number.isFinite(input.lastOpenedAt) ? input.lastOpenedAt : (existing?.lastOpenedAt ?? now),
    messages,
    attachments,
    model: input.model ?? existing?.model ?? null,
  };
}

/** Strip messages for list views (the sidebar never needs transcripts). */
function toSummary(conversation) {
  const { messages, attachments, ...rest } = conversation;
  return { ...rest, messageCount: messages.length, attachmentCount: attachments.length };
}

export const conversationsRepo = {
  /** Newest activity first — sidebar order. */
  async list() {
    const all = await readAll(STORE);
    return all.sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt));
  },

  /** Summaries only (cheap for long histories). */
  async listSummaries() {
    return (await conversationsRepo.list()).map(toSummary);
  },

  async get(id) {
    if (!id) return null;
    return getRecord(STORE, id);
  },

  async create(input = {}) {
    const value = normalizeConversation(input, {});
    await withStores(STORE, 'readwrite', async (stores) => {
      const store = stores[STORE];
      await req(store.put(value));
      // Bound storage: keep the newest MAX_CONVERSATIONS records.
      const all = await req(store.getAll());
      if (all.length > MAX_CONVERSATIONS) {
        all.sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt));
        for (const stale of all.slice(MAX_CONVERSATIONS)) await req(store.delete(stale.id));
      }
    });
    return value;
  },

  /** Full-record save (the assistant keeps one in-memory conversation). */
  async save(id, patch) {
    const existing = await conversationsRepo.get(id);
    if (!existing) throw new AppError('Conversation not found', { code: 'not-found' });
    const value = normalizeConversation({ ...existing, ...patch, id: existing.id }, { existing });
    await withStores(STORE, 'readwrite', (stores) => req(stores[STORE].put(value)));
    return value;
  },

  /** Append one message and bump activity stamps in one transaction. */
  async appendMessage(id, message) {
    const normalized = normalizeMessage(message, 0);
    if (!normalized) throw new AppError('Invalid message', { code: 'validation' });
    const existing = await conversationsRepo.get(id);
    if (!existing) throw new AppError('Conversation not found', { code: 'not-found' });

    const value = {
      ...existing,
      messages: [...existing.messages, normalized].slice(-MAX_MESSAGES),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    await withStores(STORE, 'readwrite', (stores) => req(stores[STORE].put(value)));
    return { conversation: value, message: normalized };
  },

  async rename(id, title) {
    return conversationsRepo.save(id, { title: asString(title, MAX_TITLE) || 'New chat' });
  },

  async touch(id) {
    const existing = await conversationsRepo.get(id);
    if (!existing) return null;
    const value = { ...existing, lastOpenedAt: Date.now() };
    await withStores(STORE, 'readwrite', (stores) => req(stores[STORE].put(value)));
    return value;
  },

  async remove(id) {
    if (!id) return false;
    await withStores(STORE, 'readwrite', async (stores) => {
      const existing = await req(stores[STORE].get(id));
      if (existing) await req(stores[STORE].delete(id));
    });
    return true;
  },
};
