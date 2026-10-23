/**
 * migrations/index.js — ordered schema migrations.
 * Add a new file per schema change and register it here with version+1.
 * Migrations must be idempotent for fresh databases (upgrade runs from 0).
 */

import { migration001 } from './001-initial.js';

export const MIGRATIONS = [
  migration001,
  // migration002: …,
].sort((a, b) => a.version - b.version);
