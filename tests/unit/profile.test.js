import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PROFILE_LIMITS,
  usernameFromName,
  usernameFromEmail,
  sanitizeAvatarUrl,
  deriveUsername,
  deriveAvatarUrl,
  avatarPalette,
  initialFrom,
  toRow,
  fromRow,
} from '../../src/scripts/features/account/profile.js';

/* ------------------------------------------------------------ usernames -- */

test('usernameFromName: lowercases, cleans separators, strips diacritics', () => {
  assert.equal(usernameFromName('Zoë Mapper'), 'zoe-mapper');
  assert.equal(usernameFromName('  Jane  Doe  '), 'jane-doe');
  assert.equal(usernameFromName('mink.hant'), 'mink.hant');
  assert.equal(usernameFromName('weird___name!!'), 'weird-name');
});

test('usernameFromName: refuses to leave leading/trailing separators', () => {
  assert.equal(usernameFromName('..hello..'), 'hello');
  assert.equal(usernameFromName('--a--'), 'a');
  assert.equal(usernameFromName('!!!'), '');
});

test('usernameFromName: caps to the length limit', () => {
  const long = 'a'.repeat(PROFILE_LIMITS.username + 20);
  assert.equal(usernameFromName(long).length, PROFILE_LIMITS.username);
});

test('usernameFromEmail: uses the local part and reuses the name cleaner', () => {
  assert.equal(usernameFromEmail('mink.hant@example.com'), 'mink.hant');
  assert.equal(usernameFromEmail('Jane.Doe@Example.com'), 'jane.doe');
  assert.equal(usernameFromEmail('zoe mapper@example.com'), 'zoe-mapper');
});

/* ---------------------------------------------------------- avatar urls -- */

test('sanitizeAvatarUrl: accepts https and refuses unsafe schemes', () => {
  assert.ok(sanitizeAvatarUrl('https://example.com/a.png')?.startsWith('https://'));
  assert.equal(sanitizeAvatarUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeAvatarUrl('data:image/svg+xml;base64,xxx'), null);
  assert.equal(sanitizeAvatarUrl('file:///etc/passwd'), null);
  assert.equal(sanitizeAvatarUrl(''), null);
  assert.equal(sanitizeAvatarUrl(null), null);
});

test('sanitizeAvatarUrl: allows localhost http for local development', () => {
  assert.ok(sanitizeAvatarUrl('http://localhost:54321/avatar.png'));
  assert.equal(sanitizeAvatarUrl('http://evil.example.com/a.png'), null);
});

/* -------------------------------------------------------- derivation ----- */

test('deriveUsername: prefers OAuth metadata, falls back to email local part', () => {
  assert.equal(deriveUsername({ user_metadata: { user_name: 'octocat' }, email: 'x@y.z' }), 'octocat');
  assert.equal(deriveUsername({ user_metadata: { full_name: 'Octo Cat' }, email: 'x@y.z' }), 'octo-cat');
  assert.equal(deriveUsername({ email: 'mink.hant@example.com' }), 'mink.hant');
  assert.equal(deriveUsername({}), '');
});

test('deriveAvatarUrl: prefers metadata picture, ignores unsafe values', () => {
  const user = { user_metadata: { avatar_url: 'https://avatars.example.com/1.png' } };
  assert.equal(deriveAvatarUrl(user), 'https://avatars.example.com/1.png');
  assert.equal(deriveAvatarUrl({ user_metadata: { picture: 'javascript:alert(1)' } }), null);
  assert.equal(deriveAvatarUrl({}), null);
});

/* ----------------------------------------------------------- initial ----- */

test('initialFrom: first character of fullName, else username, uppercased', () => {
  assert.equal(initialFrom('jane-doe', 'Jane Doe'), 'J');
  assert.equal(initialFrom('jane-doe', ''), 'J');
  assert.equal(initialFrom('', ''), '?');
});

/* -------------------------------------------------------- avatar palette -- */

test('avatarPalette: deterministic for the same seed, and returns a valid pair', () => {
  assert.deepEqual(avatarPalette('seed'), avatarPalette('seed'));
  assert.notDeepEqual(avatarPalette('seed'), avatarPalette('another-user'));
  const [bg, fg] = avatarPalette('');
  assert.ok(/^#[0-9a-f]{3,8}$/i.test(bg), `background is a hex color, got ${bg}`);
  assert.ok(/^#[0-9a-f]{3,8}$/i.test(fg), `foreground is a hex color, got ${fg}`);
});

test('avatarPalette: tolerates an empty seed without throwing', () => {
  const [bg] = avatarPalette(undefined);
  assert.ok(bg, 'an undefined seed still yields a color');
});

/* --------------------------------------------------- db mapping (toRow) --- */

/**
 * Column names of public.profiles, parsed from the migration itself so this
 * test fails if the code and the schema ever drift apart again.
 *
 * Regression guard: the first version of this feature spread camelCase patch
 * keys straight into the PostgREST upsert, which rejected the write with
 * "Could not find the 'avatarPath' column of profiles in the schema cache" —
 * silently breaking avatar saves and profile edits.
 */
function profilesColumns() {
  const sql = readFileSync(new URL('../../supabase/migrations/0002_profiles.sql', import.meta.url), 'utf8');
  const body = sql.match(/CREATE TABLE IF NOT EXISTS public\.profiles \(([\s\S]*?)\n\);/);
  assert.ok(body, '0002_profiles.sql still creates public.profiles');
  const cols = new Set();
  for (const line of body[1].split('\n')) {
    const m = /^\s{2}([a-z][a-z0-9_]*)\s+[a-z]/.exec(line);
    if (m && m[1] !== 'constraint') cols.add(m[1]);
  }
  assert.ok(cols.size > 0, 'parsed at least one column');
  return cols;
}

test('toRow: emits snake_case keys that exist in the migration', () => {
  const columns = profilesColumns();
  const row = toRow({ username: 'jane', fullName: 'Jane', bio: 'hi', avatarUrl: 'https://x/y.png' });

  assert.deepEqual(row, { username: 'jane', full_name: 'Jane', bio: 'hi', avatar_url: 'https://x/y.png' });
  for (const key of Object.keys(row)) {
    assert.ok(columns.has(key), `toRow emitted "${key}" but the migration has no such column`);
  }
});

test('toRow: never emits camelCase or a column the migration lacks', () => {
  const row = toRow({ username: 'jane', fullName: 'Jane', bio: 'hi', avatarUrl: 'https://x/y.png' });
  for (const key of Object.keys(row)) {
    assert.ok(!/[A-Z]/.test(key), `PostgREST cannot resolve camelCase key "${key}"`);
  }
  // avatar_path is redundant (the object path is always <uid>/avatar.<ext>) and
  // is absent from the schema; it must never come back.
  assert.ok(!('avatar_path' in row), 'avatar_path is not written');
});

test('toRow: ignores unknown fields so an unsupported key cannot reach the DB', () => {
  assert.deepEqual(toRow({ isAdmin: true, avatarPath: 'x/y.png', userId: 'abc' }), {});
  assert.deepEqual(toRow({}), {});
});

test('fromRow: reads real columns and tolerates a schema missing optional ones', () => {
  const columns = profilesColumns();
  const read = fromRow({
    user_id: 'u1', username: 'jane', full_name: 'Jane', bio: 'hi', avatar_url: 'https://x/y.png', updated_at: 'now',
  });

  assert.equal(read.username, 'jane');
  assert.equal(read.fullName, 'Jane');
  assert.equal(read.avatarUrl, 'https://x/y.png');
  for (const value of ['user_id', 'username', 'full_name', 'bio', 'avatar_url', 'updated_at']) {
    assert.ok(columns.has(value), `fromRow reads "${value}" but the migration has no such column`);
  }

  // A row from a schema that predates optional columns must not throw.
  const sparse = fromRow({ user_id: 'u1', username: 'jane' });
  assert.equal(sparse.bio, '');
  assert.equal(sparse.avatarUrl, null);
  assert.equal(sparse.updatedAt, null);
});
