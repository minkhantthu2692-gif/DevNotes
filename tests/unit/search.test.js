import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseQuery,
  scoreRecord,
  matchesFlags,
  segmentHighlight,
  applySort,
} from '../../src/scripts/utils/search.js';

/* ---------------------------------------------------------- parseQuery -- */

test('parseQuery: free text and filters coexist', () => {
  const q = parseQuery('lang:javascript closures');
  assert.equal(q.filters.lang, 'javascript');
  assert.equal(q.text, 'closures');
});

test('parseQuery: language: is an alias of lang:', () => {
  assert.equal(parseQuery('language:rust').filters.lang, 'rust');
});

test('parseQuery: quoted tag values keep spaces', () => {
  const q = parseQuery('tag:"web dev" map');
  assert.deepEqual(q.tags, ['web dev']);
  assert.equal(q.text, 'map');
});

test('parseQuery: is:/has: collect into arrays', () => {
  const q = parseQuery('is:favorite is:archived has:code has:source');
  assert.deepEqual(q.filters.is, ['favorite', 'archived']);
  assert.deepEqual(q.filters.has, ['code', 'source']);
});

test('parseQuery: unknown filters degrade to free text', () => {
  const q = parseQuery('foo:bar baz');
  assert.equal(q.filters.foo, undefined);
  assert.ok(q.text.includes('foo:bar'));
  assert.ok(q.text.includes('baz'));
});

test('parseQuery: empty and malformed input never throw', () => {
  assert.equal(parseQuery('').text, '');
  assert.equal(parseQuery(null).text, '');
  assert.equal(parseQuery(':::').text, ':::');
});

/* --------------------------------------------------------- scoreRecord -- */

const lesson = {
  title: 'JavaScript Closures',
  summary: 'Functions remember their birthplace.',
  tags: ['js', 'functions'],
  content: 'A closure is a function bundled with its lexical environment.',
  language: 'javascript',
  category: 'tutorial',
};

test('scoreRecord: title matches beat tags beat summary beat body', () => {
  const titleHit = scoreRecord(lesson, 'closures');
  const bodyHit = scoreRecord({ content: lesson.content }, 'lexical');
  assert.ok(titleHit > bodyHit, `title hit (${titleHit}) should outrank body hit (${bodyHit})`);

  const prefix = scoreRecord({ title: 'Closures explained' }, 'closures');
  const inside = scoreRecord({ title: 'Understanding closures deeply' }, 'closures');
  assert.ok(prefix > inside, 'prefix matches outrank mid-word matches');
});

test('scoreRecord: every term must match somewhere (AND semantics)', () => {
  assert.equal(scoreRecord(lesson, 'closures nonexistent'), -1);
  assert.ok(scoreRecord(lesson, 'closures functions') > 0);
});

test('scoreRecord: empty text scores 0, non-matching records score -1', () => {
  assert.equal(scoreRecord(lesson, ''), 0, 'no query → everything is a neutral match');
  assert.equal(scoreRecord({}, 'x'), -1, 'a record that matches nothing is excluded');
});

/* --------------------------------------------------------- matchesFlags -- */

const view = {
  type: 'lesson',
  languageKey: 'javascript',
  categoryKey: 'tutorial',
  status: 'learning',
  difficulty: 'intermediate',
  favorite: true,
  archived: false,
  trashed: false,
  hasCode: true,
  sourceUrls: ['https://example.com'],
  tags: ['js'],
};

test('matchesFlags: lang/category/status/difficulty/type filters', () => {
  const check = (raw) => matchesFlags(view, parseQuery(raw));
  assert.equal(check('lang:javascript'), true);
  assert.equal(check('lang:rust'), false);
  assert.equal(check('category:tutorial'), true);
  assert.equal(check('category:other'), false);
  assert.equal(check('status:learning'), true);
  assert.equal(check('status:learned'), false);
  assert.equal(check('difficulty:intermediate'), true);
  assert.equal(check('type:lesson'), true);
  assert.equal(check('type:snippet'), false);
});

test('matchesFlags: is:/has:/tag filters', () => {
  const check = (raw) => matchesFlags(view, parseQuery(raw));
  assert.equal(check('is:favorite'), true);
  assert.equal(check('is:archived'), false);
  assert.equal(check('is:trashed'), false);
  assert.equal(check('has:code'), true);
  assert.equal(check('tag:js'), true);
  assert.equal(check('tag:rust'), false);
});

test('matchesFlags: case-insensitive tag matching', () => {
  assert.equal(matchesFlags(view, parseQuery('tag:JS')), true);
});

/* ------------------------------------------------------ segmentHighlight -- */

test('segmentHighlight: no terms returns one plain segment', () => {
  assert.deepEqual(segmentHighlight('hello', []), [{ text: 'hello', hit: false }]);
  assert.deepEqual(segmentHighlight('', ['x']), [{ text: '', hit: false }]);
});

test('segmentHighlight: overlapping matches merge into clean segments', () => {
  // 'abc' hits [0,3]+[3,6], 'bca' hits [1,4] → everything merges to [0,6].
  const segments = segmentHighlight('abcabc', ['abc', 'bca']);
  assert.deepEqual(segments.map((s) => s.text).join(''), 'abcabc', 'no characters lost or duplicated');
  assert.deepEqual(segments, [{ text: 'abcabc', hit: true }]);
});

test('segmentHighlight: case-insensitive hits', () => {
  const segments = segmentHighlight('Hello World', ['world']);
  const hit = segments.find((s) => s.hit);
  assert.equal(hit.text, 'World');
});

/* -------------------------------------------------------------- sorting -- */

test('applySort: does not mutate the input and respects direction', () => {
  const list = [
    { title: 'B', updatedAt: 1 },
    { title: 'A', updatedAt: 3 },
    { title: 'C', updatedAt: 2 },
  ];
  const snapshot = [...list];

  const byTitle = applySort(list, 'title', 'asc');
  assert.deepEqual(byTitle.map((r) => r.title), ['A', 'B', 'C']);

  const byUpdatedDesc = applySort(list, 'updated', 'desc');
  assert.deepEqual(byUpdatedDesc.map((r) => r.updatedAt), [3, 2, 1]);

  assert.deepEqual(list, snapshot, 'input array order is untouched');
});

test('applySort: unknown sort key falls back to updated', () => {
  const list = [{ updatedAt: 1 }, { updatedAt: 5 }, { updatedAt: 3 }];
  assert.deepEqual(applySort(list, 'nonsense', 'desc').map((r) => r.updatedAt), [5, 3, 1]);
});
