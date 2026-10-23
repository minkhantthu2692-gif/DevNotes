/**
 * fonts.js — user-imported fonts stored in IndexedDB (browsers cannot write
 * into src/fonts/, and object URLs must not outlive their use).
 *
 * Validation: size limit + format whitelist. Loading failures fall back to
 * the configured fallback stacks without breaking the UI.
 */

import { withStores, req } from '../database.js';
import { bus } from '../../utils/bus.js';

export const MAX_FONT_BYTES = 8 * 1024 * 1024; // 8 MB per file

const EXT_FORMATS = {
  woff2: 'woff2', woff: 'woff', ttf: 'ttf', otf: 'otf',
};

function detectFormat(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT_FORMATS[ext] || null;
}

const loadedFaces = new Map(); // family -> FontFace

export const fontsRepo = {
  /** Metadata only (no blobs) — cheap for Settings lists. */
  async list() {
    const rows = await withStores('fonts', 'readonly', (stores) => req(stores.fonts.getAll()));
    return rows
      .map(({ blob, ...meta }) => meta)
      .sort((a, b) => a.family.localeCompare(b.family));
  },

  async get(id) {
    return withStores('fonts', 'readonly', async (stores) => {
      const row = await req(stores.fonts.get(id));
      return row ?? null;
    });
  },

  /** Validate + persist a font file. Throws a readable error on rejection. */
  async add(file, familyName = null) {
    const format = detectFormat(file);
    if (!format) throw new Error('Unsupported font type — use WOFF2, WOFF, TTF or OTF');
    if (file.size > MAX_FONT_BYTES) throw new Error('Font file is larger than 8 MB');

    const family = (familyName || file.name.replace(/\.[^.]+$/, '')).trim().slice(0, 64);
    if (!family) throw new Error('Font family name is required');

    const record = {
      id: `font_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      family,
      fileName: file.name.slice(0, 120),
      format,
      size: file.size,
      blob: file,
      createdAt: Date.now(),
    };

    await withStores('fonts', 'readwrite', (stores) => req(stores.fonts.put(record)));
    bus.emit('fonts:changed', { action: 'added', id: record.id });
    await fontsRepo.loadOne(record).catch(() => { /* load failures fall back */ });
    return { ...record, blob: undefined };
  },

  async remove(id) {
    const record = await fontsRepo.get(id);
    await withStores('fonts', 'readwrite', (stores) => req(stores.fonts.delete(id)));
    const face = loadedFaces.get(record?.family);
    if (face) {
      document.fonts.delete(face);
      loadedFaces.delete(record.family);
    }
    bus.emit('fonts:changed', { action: 'removed', id, family: record?.family });
  },

  /** Register one stored font with the Font Loading API. */
  async loadOne(record) {
    if (!record?.blob) return false;
    if (loadedFaces.has(record.family)) return true;
    const buffer = await record.blob.arrayBuffer();
    const face = new FontFace(record.family, buffer, { style: 'normal', weight: '100 900' });
    await face.load(); // rejects on corrupt files → caller falls back
    document.fonts.add(face);
    loadedFaces.set(record.family, face);
    return true;
  },

  /** Load every imported font at boot (failures are reported, not fatal). */
  async loadAll() {
    const rows = await withStores('fonts', 'readonly', (stores) => req(stores.fonts.getAll()));
    const loaded = [];
    const failed = [];
    for (const record of rows) {
      try {
        await fontsRepo.loadOne(record);
        loaded.push(record.family);
      } catch (err) {
        console.warn(`[fonts] failed to load "${record.family}":`, err.message);
        failed.push(record.family);
      }
    }
    return { loaded, failed };
  },
};
