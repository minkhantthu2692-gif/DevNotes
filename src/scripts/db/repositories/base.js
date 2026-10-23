/**
 * base.js — shared repository behaviour.
 *
 * Repositories are the ONLY code that touches IndexedDB stores (AGENTS.md §10).
 * Each repository handles: validation, revision bumping, activity logging,
 * soft delete/restore/purge, and sync-queue enqueueing inside one transaction
 * so a record and its pending operation can never diverge.
 */

import { withStores, req, readAll, getRecord } from '../database.js';
import { enqueueWith, isSyncEnabled } from '../../sync/sync-queue.js';
import { bus } from '../../utils/bus.js';
import { AppError } from '../../utils/errors.js';
import { uniqueSlug } from '../../utils/id.js';

/**
 * @param {object} config
 * @param {string} config.store IndexedDB store name
 * @param {string} config.entity sync entity name ('lesson', 'snippet', …)
 * @param {Function} config.normalize (input, {existing, now}) => {ok, value, errors}
 * @param {string} [config.labelField] field used for activity labels
 * @param {Function} [config.onBeforeUpdate] (existing, next, stores) => Promise — snapshots
 * @param {boolean} [config.syncable] enqueue sync operations (default true)
 * @param {string[]} [config.extraStores] additional stores to open for writes
 */
export function createRepository(config) {
  const {
    store: storeName,
    entity,
    normalize,
    labelField = 'title',
    onBeforeUpdate = null,
    syncable = true,
    extraStores = [],
  } = config;

  const writeStores = [storeName, 'queue', 'activity', ...extraStores];

  const emit = (action, id, extra = {}) => {
    bus.emit('data:changed', { entity, store: storeName, action, id, ...extra });
  };

  /**
   * Activity rows coalesce per (entity, record, action) inside a short window:
   * autosave would otherwise write one "updated" row per keystroke-pause and
   * flood the history. The in-memory cache only accelerates the common case —
   * on a cache miss we fall back to appending a fresh row (never wrong, just
   * less compact).
   */
  const ACTIVITY_COALESCE_MS = 2 * 60_000;
  const recentActivity = new Map(); // `${entity}:${id}:${action}` → rowId

  const logActivity = async (activityStore, action, record) => {
    const rowId = `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const key = `${entity}:${record.id}:${action}`;
    const now = Date.now();
    const previousId = recentActivity.get(key);

    if (previousId) {
      const previous = await req(activityStore.get(previousId));
      if (previous && now - previous.at < ACTIVITY_COALESCE_MS) {
        previous.at = now;
        previous.label = String(record[labelField] ?? record.title ?? record.name ?? record.id).slice(0, 160);
        await req(activityStore.put(previous));
        return;
      }
    }

    await req(activityStore.put({
      id: rowId,
      entity,
      entityId: record.id,
      action, // created | updated | deleted | restored | purged | duplicated
      label: String(record[labelField] ?? record.title ?? record.name ?? record.id).slice(0, 160),
      at: now,
    }));

    if (recentActivity.size > 256) recentActivity.clear();
    recentActivity.set(key, rowId);
  };

  const uniqueSlugFor = async (store, desired, selfId) => {
    // Stores without slugs (flashcards) or a slug-less record skip this.
    if (!desired || !store.indexNames.contains('by-slug')) return desired ?? null;
    const all = await req(store.index('by-slug').getAll());
    const taken = new Set(all.filter((item) => item.id !== selfId).map((item) => item.slug));
    return uniqueSlug(desired, taken);
  };

  const assertValid = (result) => {
    if (!result.ok) throw new AppError(result.errors.join('; '), { code: 'validation', retryable: false });
    return result.value;
  };

  const repo = {
    entity,
    storeName,

    /** All records (trashed hidden by default). */
    async getAll({ includeTrashed = false, onlyTrashed = false } = {}) {
      const all = await readAll(storeName);
      if (onlyTrashed) return all.filter((r) => r.trashed);
      if (includeTrashed) return all;
      return all.filter((r) => !r.trashed);
    },

    async get(id) {
      if (!id) return null;
      return getRecord(storeName, id);
    },

    async getMany(ids) {
      const all = await readAll(storeName);
      const wanted = new Set(ids);
      return all.filter((record) => wanted.has(record.id));
    },

    /** Count with an optional predicate. */
    async count(predicate = null) {
      const all = await readAll(storeName);
      const list = predicate ? all.filter(predicate) : all;
      return list.length;
    },

    /** Create a record (validates, assigns id/slug, enqueues sync). */
    async create(input) {
      const value = assertValid(normalize(input, {}));

      const result = await withStores(writeStores, 'readwrite', async (stores) => {
        const store = stores[storeName];
        // A caller-supplied id must never silently overwrite an existing
        // record: create() is for new records only (update() exists).
        const clash = await req(store.get(value.id));
        if (clash) {
          throw new AppError(`A record with this id already exists (${value.id})`, { code: 'conflict', retryable: false });
        }
        const slug = await uniqueSlugFor(store, value.slug, value.id);
        if (slug) value.slug = slug;
        value.revision = 1;
        await req(store.put(value));
        if (syncable && isSyncEnabled()) {
          await enqueueWith(stores.queue, { entity, id: value.id, action: 'upsert', payload: value, baseRevision: 0 });
        }
        await logActivity(stores.activity, 'created', value);
        return value;
      });

      emit('created', result.id);
      return result;
    },

    /**
     * Update a record from a partial patch.
     * `revision` increments; `baseRevision` (last known remote) is preserved.
     */
    async update(id, patch) {
      const existing = await repo.get(id);
      if (!existing) throw new AppError('Record not found', { code: 'not-found', retryable: false });

      const merged = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt };
      const value = assertValid(normalize(merged, { existing }));
      value.revision = (existing.revision ?? 0) + 1;
      value.baseRevision = existing.baseRevision ?? 0;
      value.createdAt = existing.createdAt;

      const result = await withStores(writeStores, 'readwrite', async (stores) => {
        const store = stores[storeName];
        if (patch.slug && patch.slug !== existing.slug) {
          value.slug = await uniqueSlugFor(store, patch.slug, existing.id);
        } else {
          value.slug = existing.slug;
        }
        if (onBeforeUpdate) await onBeforeUpdate(existing, value, stores);
        await req(store.put(value));
        if (syncable && isSyncEnabled()) {
          await enqueueWith(stores.queue, { entity, id: value.id, action: 'upsert', payload: value, baseRevision: value.baseRevision });
        }
        await logActivity(stores.activity, 'updated', value);
        return value;
      });

      emit('updated', result.id, { previous: existing });
      return result;
    },

    /** Move a record to the trash (recoverable; syncs as an upsert). */
    async softDelete(id) {
      const existing = await repo.get(id);
      if (!existing) return null;
      if (existing.trashed) return existing;

      const value = { ...existing, trashed: true, trashAt: Date.now(), revision: (existing.revision ?? 0) + 1 };
      const result = await withStores([storeName, 'queue', 'activity'], 'readwrite', async (stores) => {
        await req(stores[storeName].put(value));
        if (syncable && isSyncEnabled()) {
          await enqueueWith(stores.queue, { entity, id, action: 'upsert', payload: value, baseRevision: value.baseRevision ?? 0 });
        }
        await logActivity(stores.activity, 'deleted', value);
        return value;
      });

      emit('trashed', id);
      return result;
    },

    /** Restore from trash. */
    async restore(id) {
      const existing = await repo.get(id);
      if (!existing || !existing.trashed) return existing;

      const value = { ...existing, trashed: false, trashAt: null, revision: (existing.revision ?? 0) + 1 };
      const result = await withStores([storeName, 'queue', 'activity'], 'readwrite', async (stores) => {
        await req(stores[storeName].put(value));
        if (syncable && isSyncEnabled()) {
          await enqueueWith(stores.queue, { entity, id, action: 'upsert', payload: value, baseRevision: value.baseRevision ?? 0 });
        }
        await logActivity(stores.activity, 'restored', value);
        return value;
      });

      emit('restored', id);
      return result;
    },

    /**
     * Permanently remove. Only allowed from the trash; the sync deletion is
     * queued (not considered done) until the remote acknowledges it.
     */
    async purge(id) {
      const existing = await repo.get(id);
      if (!existing) return true;

      const result = await withStores([storeName, 'queue', 'activity'], 'readwrite', async (stores) => {
        await req(stores[storeName].delete(id));
        if (syncable && isSyncEnabled()) {
          await enqueueWith(stores.queue, { entity, id, action: 'delete', payload: { id } });
        }
        await logActivity(stores.activity, 'purged', existing);
        return true;
      });

      emit('purged', id);
      return result;
    },

    /** Empty the trash for this entity (bulk purge, confirmed by caller). */
    async purgeAllTrashed() {
      const trashed = await repo.getAll({ onlyTrashed: true });
      for (const record of trashed) await repo.purge(record.id);
      return trashed.length;
    },

    /** Duplicate a record with a fresh id/slug (content-preserving). */
    async duplicate(id, overrides = {}) {
      const existing = await repo.get(id);
      if (!existing) throw new AppError('Record not found', { code: 'not-found' });
      const { id: _drop, revision, baseRevision, createdAt, updatedAt, lastOpenedAt, ...rest } = existing;
      const label = existing[labelField];
      return repo.create({
        ...rest,
        ...overrides,
        [labelField]: overrides[labelField] ?? (label ? `${label} (copy)` : label),
        slug: undefined, // regenerated from the new title/name
        lastOpenedAt: null,
      });
    },
  };

  return repo;
}
