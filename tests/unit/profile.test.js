import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_LIMITS,
  usernameFromName,
  usernameFromEmail,
  sanitizeAvatarUrl,
  deriveUsername,
  deriveAvatarUrl,
  avatarPalette,
  initialFrom,
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
