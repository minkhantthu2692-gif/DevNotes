import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { wipeLocalDatabase, readAll } = await import('../../src/scripts/db/database.js');
const { conversationsRepo } = await import('../../src/scripts/db/repositories/index.js');

test.beforeEach(async () => {
  await wipeLocalDatabase();
});

test('conversations: create stamps timestamps and starts empty', async () => {
  const conv = await conversationsRepo.create({ title: 'How do closures work?' });
  assert.ok(conv.id.length > 0);
  assert.equal(conv.messages.length, 0);
  assert.ok(conv.createdAt > 0);
  assert.ok(conv.updatedAt >= conv.createdAt);

  const fetched = await conversationsRepo.get(conv.id);
  assert.equal(fetched.title, 'How do closures work?');
});

test('conversations: appendMessage preserves content, timestamps and attachments', async () => {
  const conv = await conversationsRepo.create({ title: 'T' });
  const before = Date.now();
  const { message } = await conversationsRepo.appendMessage(conv.id, {
    role: 'user',
    content: 'Explain hoisting',
    attachments: [{ lessonId: 'lesson-1', title: 'JS Basics' }],
    usage: { prompt: 120, completion: 45 },
    model: 'llama-3.3-70b-versatile',
  });

  assert.equal(message.role, 'user');
  assert.ok(message.createdAt >= before);
  assert.equal(message.attachments[0].lessonId, 'lesson-1');
  assert.equal(message.usage.prompt, 120);

  const stored = await conversationsRepo.get(conv.id);
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.messages[0].content, 'Explain hoisting');
  assert.ok(stored.lastOpenedAt >= stored.createdAt, 'touch stamp moves on activity');
});

test('conversations: invalid messages are rejected before any write', async () => {
  const conv = await conversationsRepo.create({ title: 'T' });
  await assert.rejects(() => conversationsRepo.appendMessage(conv.id, { role: 'nobody', content: 'x' }));
  await assert.rejects(() => conversationsRepo.appendMessage(conv.id, { role: 'user', content: '   ' }));
  await assert.rejects(() => conversationsRepo.appendMessage('missing-id', { role: 'user', content: 'hi' }));
  assert.equal((await conversationsRepo.get(conv.id)).messages.length, 0);
});

test('conversations: rename and touch update the record', async () => {
  const conv = await conversationsRepo.create({ title: 'Old' });
  const renamed = await conversationsRepo.rename(conv.id, '  New title  ');
  assert.equal(renamed.title, 'New title');

  const later = await conversationsRepo.touch(conv.id);
  assert.ok(later.lastOpenedAt >= renamed.lastOpenedAt);
});

test('conversations: list sorts by most recent activity first', async () => {
  const a = await conversationsRepo.create({ title: 'First' });
  const b = await conversationsRepo.create({ title: 'Second' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await conversationsRepo.touch(a.id);

  const list = await conversationsRepo.list();
  assert.equal(list[0].id, a.id, 'touched conversation moves to the front');
  assert.equal(list.length, 2);

  const summaries = await conversationsRepo.listSummaries();
  assert.equal(summaries[0].messageCount, 0, 'summaries drop the transcript');
  assert.equal(summaries[0].messages, undefined);
  assert.ok(b.id === list[1].id);
});

test('conversations: remove deletes permanently and is idempotent', async () => {
  const conv = await conversationsRepo.create({ title: 'Temp' });
  await conversationsRepo.appendMessage(conv.id, { role: 'user', content: 'hi' });

  assert.equal(await conversationsRepo.remove(conv.id), true);
  assert.equal(await conversationsRepo.get(conv.id), null);
  assert.equal(await conversationsRepo.remove(conv.id), true, 'removing twice is safe');
  assert.equal((await readAll('conversations')).length, 0);
});

test('conversations: history stays local — sync queue and activity stay empty', async () => {
  const conv = await conversationsRepo.create({ title: 'Local only' });
  await conversationsRepo.appendMessage(conv.id, { role: 'user', content: 'secret chat' });
  await conversationsRepo.rename(conv.id, 'Renamed');
  await conversationsRepo.remove(conv.id);

  assert.equal((await readAll('queue')).length, 0, 'nothing may be enqueued for sync');
  assert.equal((await readAll('activity')).length, 0, 'chat noise must not hit Activity & History');
});

test('conversations: oversized transcripts are bounded per conversation', async () => {
  const conv = await conversationsRepo.create({ title: 'Long' });
  for (let i = 0; i < 5; i++) {
    await conversationsRepo.appendMessage(conv.id, { role: 'user', content: `msg ${i}` });
  }
  const stored = await conversationsRepo.get(conv.id);
  assert.equal(stored.messages.length, 5);

  // A single message is clamped, never stored unbounded.
  const big = await conversationsRepo.appendMessage(conv.id, { role: 'assistant', content: 'x'.repeat(40_000) });
  assert.ok(big.message.content.length <= 32_000);
});

test('conversations: migrations are idempotent for a fresh database', async () => {
  // wipeLocalDatabase closes and reopens through getDB → MIGRATIONS from 0,
  // so reaching this point without error already proves 001+002 replay cleanly.
  const conv = await conversationsRepo.create({ title: 'post-wipe' });
  assert.ok(await conversationsRepo.get(conv.id));
});
