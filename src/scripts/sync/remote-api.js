/**
 * remote-api.js — row mapping + push/pull operations against Supabase.
 *
 * Conflict model (AGENTS.md §12):
 *  - Every record carries a `revision` (server-side increment per accepted write)
 *    and locally a `baseRevision` (last remotely observed revision).
 *  - Push first reads the remote revision: if the remote is newer than the
 *    client's baseRevision, we DO NOT write — a conflict is created instead.
 *  - The read-then-write is not a single atomic statement; this is documented
 *    in README (single-user-per-device usage keeps the window negligible).
 *  - Preferences use last-writer-wins on `updatedAt` instead of revisions
 *    (a single blob record where merging is meaningless).
 *
 * Column names are camelCase identifiers quoted in SQL (see supabase/migrations).
 */

/** entity → table + local store + conflict policy. */
export const ENTITIES = {
  lesson: { table: 'lessons', store: 'lessons' },
  snippet: { table: 'code_snippets', store: 'snippets' },
  flashcard: { table: 'flashcards', store: 'flashcards' },
  language: { table: 'programming_languages', store: 'languages' },
  category: { table: 'categories', store: 'categories' },
  course: { table: 'courses', store: 'courses' },
  preferences: { table: 'user_preferences', store: 'preferences', lww: true },
};

export const CONTENT_ENTITIES = [
  'lesson', 'snippet', 'flashcard', 'language', 'category', 'course',
];

const PULL_PAGE_SIZE = 500;

/** Local record → remote row (drops client-only bookkeeping). */
export function toRow(entity, payload) {
  if (entity === 'preferences') {
    return {
      id: payload.id || 'app',
      key: payload.key || 'app',
      value: payload.value ?? {},
      revision: payload.revision ?? 1,
      updated_at: new Date().toISOString(),
    };
  }
  const { baseRevision, updatedAt, ...rest } = payload;
  void baseRevision;
  return { ...rest, updated_at: new Date().toISOString() };
}

/** Remote row → local record shape. */
export function fromRow(entity, row) {
  if (!row) return null;
  if (entity === 'preferences') {
    return {
      key: row.key,
      value: row.value,
      revision: row.revision ?? 0,
      updatedAt: Date.parse(row.updated_at) || Date.now(),
    };
  }
  const { updated_at, user_id, ...rest } = row;
  void user_id;
  return { ...rest, updatedAt: Date.parse(updated_at) || Date.now() };
}

async function uidOf(client) {
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) throw Object.assign(new Error('Not authenticated'), { status: 401 });
  return data.user.id;
}

/**
 * Push one upsert operation.
 * @returns {Promise<{revision: number}>} the remote revision after write
 * @throws {AppError & {conflict?: true, remote?: object}} on detected conflict
 */
export async function pushUpsert(client, entity, op) {
  const config = ENTITIES[entity];
  if (!config) throw new Error(`Unknown sync entity: ${entity}`);
  const table = client.from(config.table);

  let existing = null;
  if (config.lww) {
    const { data, error } = await table.select('revision, updated_at').eq('id', op.payload.id || 'app').maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
    existing = data;
  } else {
    const { data, error } = await table.select('revision, updated_at').eq('id', op.payload.id).maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
    existing = data;
  }

  if (!config.lww && existing && existing.revision > (op.baseRevision ?? 0)) {
    const { data: remoteRow, error } = await table.select('*').eq('id', op.payload.id).single();
    if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
    const conflict = Object.assign(new Error('Remote version is newer than the local base revision'), {
      code: 'conflict',
      conflict: true,
      remote: fromRow(entity, remoteRow),
      status: 409,
    });
    throw conflict;
  }

  const row = toRow(entity, op.payload);
  row.revision = (existing?.revision ?? 0) + 1;
  row.user_id = await uidOf(client);

  const { data, error } = await table
    .upsert(row, { onConflict: 'id' })
    .select('revision, updated_at')
    .single();
  if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
  return { revision: data.revision, updatedAt: Date.parse(data.updated_at) || Date.now() };
}

/** Push one delete. Deleting a missing row counts as success (idempotent). */
export async function pushDelete(client, entity, id) {
  const config = ENTITIES[entity];
  if (!config) throw new Error(`Unknown sync entity: ${entity}`);
  const key = entity === 'preferences' ? 'app' : id;
  const { error } = await client.from(config.table).delete().eq('id', key);
  if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
  return true;
}

/**
 * Pull remote changes for one entity since a cursor (ISO timestamp).
 * @returns {Promise<{rows: object[], cursor: string|null}>} cursor = newest updated_at
 */
export async function pullSince(client, entity, cursor = null) {
  const config = ENTITIES[entity];
  if (!config) throw new Error(`Unknown sync entity: ${entity}`);

  let query = client
    .from(config.table)
    .select('*')
    .order('updated_at', { ascending: true })
    .limit(PULL_PAGE_SIZE);
  if (cursor) query = query.gt('updated_at', cursor);

  const { data, error } = await query;
  if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });

  const rows = data || [];
  const nextCursor = rows.length ? rows[rows.length - 1].updated_at : cursor;
  return { rows, cursor: nextCursor, fullPage: rows.length === PULL_PAGE_SIZE };
}

/** Pull every remote id (used to detect deletions made on other devices). */
export async function pullAllIds(client, entity) {
  const config = ENTITIES[entity];
  if (!config) throw new Error(`Unknown sync entity: ${entity}`);

  const ids = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(config.table)
      .select('id')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
    for (const row of data || []) ids.push(row.id);
    if (!data || data.length < 1000) break;
    from += 1000;
    if (from > 50000) break; // sanity guard for pathological libraries
  }
  return ids;
}

/** Row counts per entity (head requests — used for the first-sign-in choice). */
export async function cloudCounts(client) {
  const out = {};
  for (const entity of CONTENT_ENTITIES) {
    const { count, error } = await client
      .from(ENTITIES[entity].table)
      .select('id', { count: 'exact', head: true });
    if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status });
    out[entity] = count ?? 0;
  }
  out.total = CONTENT_ENTITIES.reduce((sum, entity) => sum + out[entity], 0);
  return out;
}

/** Cheap health probe used before sync runs. */
export async function pingRemote(client) {
  const { error } = await client.from('user_preferences').select('id').limit(1);
  // Any response other than a network failure proves reachability + RLS work.
  if (error && error.code === 'PGRST301') throw Object.assign(new Error('Session rejected'), { status: 401 });
  return true;
}
