/**
 * store.js - the ONE place anything in this app is saved or read back.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * Google sign-in and Supabase are not wired yet. The founder needs to upload
 * data and pick metrics today. So every screen saves to localStorage now and to
 * Supabase tomorrow, and tomorrow must not be a rewrite of five pages.
 *
 * The interface below is deliberately the one PostgREST already speaks -
 * select / insert / upsert / update / remove over named tables - because that
 * is the shape the Supabase backend will arrive in. Swapping the two is then
 * one assignment, at the bottom of this file, marked THE ONE LINE.
 *
 * No screen imports supabase.js directly any more. If a page needs to read or
 * write anything, it comes through here.
 *
 * ===========================================================================
 * WHAT LOCAL STORAGE HONESTLY IS
 * ===========================================================================
 * It is this browser, on this machine, for this person. It is not a team
 * database. Someone who spends an hour typing targets must know that BEFORE
 * they start, which is why shell.js paints a banner on every screen rather
 * than mentioning it in a tooltip.
 *
 * The escape hatch is exportAll() / importAll(): a single JSON file holding
 * everything entered, downloadable at any moment and loadable into another
 * browser or into the repo via bin/import-selections.js. Work is never trapped.
 */

import { db as supabaseDb, hasToken } from './supabase.js';
import { PULSE_CONFIG } from './config.js';

/** Where the local backend keeps everything. Bump the suffix to invalidate. */
export const LOCAL_KEY = 'pulse-local-v1';

/** Marker on an exported file, so importAll can refuse somebody's holiday photos. */
export const EXPORT_KIND = 'shopos-pulse-export';
export const EXPORT_VERSION = 1;

/**
 * The primary key of each table, used by upsert when the caller names no
 * conflict target - which is exactly what PostgREST does. Keeping the list here
 * rather than guessing `id` everywhere is what stops two status calls for the
 * same brand on the same day becoming two rows.
 */
export const PRIMARY_KEYS = {
  pulse_sources: ['id'],
  pulse_column_mappings: ['source_id'],
  pulse_metrics: ['id'],
  pulse_selections: ['dept_id', 'metric_id'],
  pulse_manual_values: ['source_id', 'entered_for'],
  pulse_lists: ['id'],
  pulse_uploads: ['id'],
  pulse_status_subjects: ['id'],
  pulse_status_calls: ['subject_id', 'set_for'],
  pulse_meetings: ['id'],
  pulse_decisions: ['id'],
  pulse_decision_events: ['id'],
  pulse_notes: ['id'],
  pulse_blockers: ['id'],
  pulse_week_numbers: ['meeting_kind', 'week_of'],
  pulse_priorities: ['dept_id', 'week_of'],
  pulse_extraction_drafts: ['id']
};

/** Every table the app writes. An export lists all of them, empty ones included,
 *  so the file is a complete statement of what is and is not there. */
export const TABLES = Object.keys(PRIMARY_KEYS);

export class StoreError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StoreError';
    this.cause = cause;
  }
}

/* ===========================================================================
 * The local backend
 * ========================================================================= */

/**
 * One JSON document in localStorage: `{version, tables: {name: rows[]}}`.
 *
 * Reads parse the whole thing. That is fine at this size and it has one real
 * benefit: every write is atomic, so a half-saved target cannot exist.
 */
function readAll() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return { version: EXPORT_VERSION, tables: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: EXPORT_VERSION, tables: {} };
    return { version: parsed.version || EXPORT_VERSION, tables: parsed.tables && typeof parsed.tables === 'object' ? parsed.tables : {} };
  } catch {
    // Corrupt or unreadable (private mode, quota, someone editing by hand).
    // Starting empty is wrong to do silently, so writeAll surfaces the failure
    // on the next save rather than here, where nobody is looking.
    return { version: EXPORT_VERSION, tables: {} };
  }
}

function writeAll(doc) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(doc));
  } catch (err) {
    throw new StoreError(
      'This browser would not save - it is either full or in private mode. '
      + 'Export what you have before you lose it.',
      err
    );
  }
}

let seq = 0;
/** A local id. Prefixed so it is obvious in an export that no server made it. */
function localId() {
  seq += 1;
  return `local-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const isBlank = (v) => v === null || v === undefined || v === '';

/** Case-insensitive, number-tolerant equality, matching PostgREST's `eq.`. */
function same(a, b) {
  if (a === b) return true;
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return String(a) === String(b);
}

/** `{eq:{}, in:{}, gte:{}, lte:{}, neq:{}, isNull, order, limit}` - the same
 *  option bag app/supabase.js builds a query string from. */
function matches(row, opts) {
  for (const [col, val] of Object.entries(opts.eq || {})) {
    if (!same(row[col], val)) return false;
  }
  for (const [col, vals] of Object.entries(opts.in || {})) {
    const list = Array.isArray(vals) ? vals : [vals];
    if (!list.some((v) => same(row[col], v))) return false;
  }
  for (const [col, val] of Object.entries(opts.neq || {})) {
    if (same(row[col], val)) return false;
  }
  for (const [col, val] of Object.entries(opts.gte || {})) {
    if (isBlank(row[col]) || String(row[col]) < String(val)) return false;
  }
  for (const [col, val] of Object.entries(opts.lte || {})) {
    if (isBlank(row[col]) || String(row[col]) > String(val)) return false;
  }
  if (opts.isNull) {
    for (const col of [].concat(opts.isNull)) if (!isBlank(row[col])) return false;
  }
  return true;
}

function sortRows(rows, order) {
  if (!order) return rows;
  const [col, dir] = String(order).split('.');
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[col];
    const y = b[col];
    if (isBlank(x) && isBlank(y)) return 0;
    if (isBlank(x)) return 1;   // nulls last, whichever direction
    if (isBlank(y)) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

const keysFor = (table, onConflict) => (
  onConflict
    ? String(onConflict).split(',').map((s) => s.trim()).filter(Boolean)
    : (PRIMARY_KEYS[table] || ['id'])
);

/** Deep-ish clone, so a caller holding a returned row cannot mutate the store. */
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function localBackend() {
  const api = {
    name: 'this browser',
    id: 'local',
    isLocal: true,

    /** Signed in or not, a local store can always be written. That is the point. */
    canSave() { return true; },

    async select(table, opts = {}) {
      const doc = readAll();
      const rows = (doc.tables[table] || []).filter((r) => matches(r, opts));
      const ordered = sortRows(rows, opts.order);
      return copy(opts.limit ? ordered.slice(0, Number(opts.limit)) : ordered);
    },

    async insert(table, rows) {
      const list = [].concat(rows || []);
      const doc = readAll();
      if (!doc.tables[table]) doc.tables[table] = [];
      const written = list.map((row) => {
        const out = { ...row };
        for (const k of (PRIMARY_KEYS[table] || ['id'])) {
          if (k === 'id' && isBlank(out.id)) out.id = localId();
        }
        if (isBlank(out.created_at)) out.created_at = new Date().toISOString();
        doc.tables[table].push(out);
        return out;
      });
      writeAll(doc);
      return copy(written);
    },

    async upsert(table, rows, onConflict) {
      const list = [].concat(rows || []);
      const keys = keysFor(table, onConflict);
      const doc = readAll();
      if (!doc.tables[table]) doc.tables[table] = [];

      const written = list.map((row) => {
        const out = { ...row };
        if (keys.length === 1 && keys[0] === 'id' && isBlank(out.id)) out.id = localId();

        const at = doc.tables[table].findIndex((existing) => keys.every((k) => same(existing[k], out[k])));
        if (at >= 0) {
          // merge-duplicates, exactly as the Prefer header asks PostgREST for:
          // columns the caller did not mention keep their old value.
          doc.tables[table][at] = { ...doc.tables[table][at], ...out };
          return doc.tables[table][at];
        }
        if (isBlank(out.created_at)) out.created_at = new Date().toISOString();
        doc.tables[table].push(out);
        return out;
      });

      writeAll(doc);
      return copy(written);
    },

    async update(table, patch, opts = {}) {
      const doc = readAll();
      const rows = doc.tables[table] || [];
      const hit = [];
      for (let i = 0; i < rows.length; i += 1) {
        if (!matches(rows[i], opts)) continue;
        rows[i] = { ...rows[i], ...patch };
        hit.push(rows[i]);
      }
      doc.tables[table] = rows;
      writeAll(doc);
      return copy(hit);
    },

    async remove(table, opts = {}) {
      const doc = readAll();
      const rows = doc.tables[table] || [];
      doc.tables[table] = rows.filter((r) => !matches(r, opts));
      writeAll(doc);
      return null;
    },

    /**
     * Edge Functions are a server thing. Saying so plainly beats a network error
     * from a URL that was never going to answer.
     */
    async fn(name) {
      throw new StoreError(
        `"${name}" runs on the server, and this browser is saving locally. `
        + 'That part needs the Supabase connection, which is being wired next.'
      );
    },

    /** Everything, as plain tables. */
    async dump() {
      const doc = readAll();
      const out = {};
      for (const t of TABLES) out[t] = copy(doc.tables[t] || []);
      // Anything written under a table name this file has not heard of still
      // leaves in the export. Dropping it would be the one thing an escape
      // hatch must never do.
      for (const t of Object.keys(doc.tables)) if (!(t in out)) out[t] = copy(doc.tables[t]);
      return out;
    },

    /** Replace or merge the whole store. */
    async load(tables, { merge = false } = {}) {
      const doc = merge ? readAll() : { version: EXPORT_VERSION, tables: {} };
      let records = 0;
      for (const [table, rows] of Object.entries(tables || {})) {
        if (!Array.isArray(rows)) continue;
        if (!merge) {
          doc.tables[table] = copy(rows);
          records += rows.length;
          continue;
        }
        if (!doc.tables[table]) doc.tables[table] = [];
        const keys = PRIMARY_KEYS[table] || ['id'];
        for (const row of rows) {
          const at = doc.tables[table].findIndex((e) => keys.every((k) => same(e[k], row[k])));
          if (at >= 0) doc.tables[table][at] = { ...doc.tables[table][at], ...copy(row) };
          else doc.tables[table].push(copy(row));
          records += 1;
        }
      }
      writeAll(doc);
      return { tables: Object.keys(tables || {}).length, records };
    },

    async clear() {
      try { localStorage.removeItem(LOCAL_KEY); } catch { /* nothing to clear */ }
    }
  };
  return api;
}

/* ===========================================================================
 * The Supabase backend - tomorrow's one-line swap
 * =========================================================================
 * Already written, because an interface with one implementation is a promise
 * rather than a design. The only thing missing is the sign-in that gives it a
 * token, which is what tomorrow adds.
 */
export function supabaseBackend() {
  return {
    name: 'the team database',
    id: 'supabase',
    isLocal: false,
    // Open mode: anonymous writes are allowed by schema-open-today.sql.
    canSave: () => !!PULSE_CONFIG.OPEN_MODE || hasToken(),
    select: (t, o) => supabaseDb.select(t, o),
    insert: (t, r) => supabaseDb.insert(t, r),
    upsert: (t, r, c) => supabaseDb.upsert(t, r, c),
    update: (t, p, o) => supabaseDb.update(t, p, o),
    remove: (t, o) => supabaseDb.remove(t, o),
    fn: (n, p) => supabaseDb.fn(n, p),
    async dump() {
      const out = {};
      for (const t of TABLES) {
        try { out[t] = await supabaseDb.select(t); } catch { out[t] = []; }
      }
      return out;
    },
    async load(tables) {
      let records = 0;
      for (const [table, rows] of Object.entries(tables || {})) {
        if (!Array.isArray(rows) || !rows.length) continue;
        await supabaseDb.upsert(table, rows, (PRIMARY_KEYS[table] || ['id']).join(','));
        records += rows.length;
      }
      return { tables: Object.keys(tables || {}).length, records };
    },
    async clear() {
      throw new StoreError('Clearing the team database is not something a browser button does.');
    }
  };
}

/* ===========================================================================
 * THE ONE LINE
 * =========================================================================
 * Supabase, so every department sees the same data and history builds up
 * week on week. localBackend() is kept for tests and offline use.
 *
 * `?store=local` forces the local backend. It exists for two honest reasons -
 * working with no connection, and exercising these screens without writing
 * into the shared database - and it is NEVER selected automatically.
 *
 * That last part is the important one. A silent fall back to localStorage when
 * Supabase is unreachable would be the worst behaviour this file could have:
 * the page would say "saved", the person would believe their team could see
 * it, and nobody would find out until the dashboard came up empty. A failed
 * write must surface as a failed write. So the only way into local mode is to
 * ask for it, and shell.js prints which store is live on every screen.
 */
function chooseBackend() {
  let mode = null;
  try {
    const asked = new URLSearchParams(location.search).get('store');
    if (asked === 'local' || asked === 'supabase') {
      mode = asked;
      // Remembered for this tab only, so following a link to another screen
      // does not switch stores underneath you half way through setup.
      sessionStorage.setItem('pulse-store-mode', asked);
    } else {
      mode = sessionStorage.getItem('pulse-store-mode');
    }
  } catch { /* no location or no sessionStorage - take the default */ }

  return mode === 'local' ? localBackend() : supabaseBackend();
}

export const backend = chooseBackend();

/* ===========================================================================
 * What the screens actually import
 * ========================================================================= */

/** The table API. Same five verbs on either backend. */
export const db = {
  select: (table, opts) => backend.select(table, opts),
  insert: (table, rows) => backend.insert(table, rows),
  upsert: (table, rows, onConflict) => backend.upsert(table, rows, onConflict),
  update: (table, patch, opts) => backend.update(table, patch, opts),
  remove: (table, opts) => backend.remove(table, opts),
  fn: (name, payload) => backend.fn(name, payload)
};

/** True when a save will actually land. Replaces every `hasToken()` guard. */
export const canSave = () => backend.canSave();

/** "this browser" / "the team database" - printed in the banner, not inferred. */
export const backendName = () => backend.name;

/** True while work lives only in this browser. Drives the honesty banner. */
export const isLocal = () => backend.isLocal !== false;

/**
 * Everything entered, as one JSON object.
 * The escape hatch that makes localStorage acceptable at all.
 */
export async function exportAll() {
  const tables = await backend.dump();
  const counts = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length]));
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    backend: backend.id,
    counts,
    tables
  };
}

/** How many records an export (or the live store) holds. */
export function countRecords(payload) {
  const tables = (payload && payload.tables) || {};
  return Object.values(tables).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
}

/**
 * Read an exported file back in.
 *
 * `merge` leaves anything already here alone unless the same key arrives again.
 * Replacing is the other option and it is destructive, so the caller asks for it
 * explicitly and the screen confirms first.
 *
 * The file is DATA. Nothing in it is executed, and a file that is not one of
 * ours is refused by shape rather than parsed hopefully.
 */
export async function importAll(payload, { merge = true } = {}) {
  let doc = payload;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch { throw new StoreError('That file is not JSON.'); }
  }
  if (!doc || typeof doc !== 'object') throw new StoreError('That file is not a Pulse export.');
  if (doc.kind && doc.kind !== EXPORT_KIND) {
    throw new StoreError(`That file says it is "${doc.kind}", not a Pulse export.`);
  }
  const tables = doc.tables && typeof doc.tables === 'object' ? doc.tables : null;
  if (!tables) throw new StoreError('That file has no "tables" in it, so there is nothing to load.');

  const usable = {};
  for (const [name, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows)) continue;
    usable[name] = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  }
  if (!Object.keys(usable).length) throw new StoreError('That export is empty.');

  return backend.load(usable, { merge });
}

/** Throw the whole local store away. Used by the Start over button only. */
export async function clearAll() {
  return backend.clear();
}

/* ---------------------------------------------------------------------------
 * selections - the metric picker's own shape
 * -------------------------------------------------------------------------
 * Kept here rather than in metrics.js because the dashboard side
 * (bin/import-selections.js, engine/selections.js) has to agree with it, and a
 * shape that lives in a page is a shape nothing else can read.
 */

/** @typedef {{enabled:boolean, target:number|null, owner:string|null, direction:'up'|'down'}} Selection */

/** Every selection row, keyed `deptId` -> `metricId` -> Selection. */
export async function loadSelections() {
  const rows = await db.select('pulse_selections');
  const out = {};
  for (const r of rows) {
    if (!r || !r.dept_id || !r.metric_id) continue;
    if (!out[r.dept_id]) out[r.dept_id] = {};
    out[r.dept_id][r.metric_id] = {
      enabled: r.enabled !== false,
      target: r.target === undefined || r.target === '' ? null : r.target,
      owner: r.owner || null,
      direction: r.direction === 'down' ? 'down' : 'up'
    };
  }
  return out;
}

/** Save one metric's row. */
export async function saveSelection(deptId, metricId, selection) {
  return db.upsert('pulse_selections', [{
    dept_id: deptId,
    metric_id: metricId,
    enabled: !!selection.enabled,
    target: selection.target === undefined || selection.target === '' ? null : selection.target,
    owner: selection.owner || null,
    direction: selection.direction === 'down' ? 'down' : 'up',
    updated_at: new Date().toISOString()
  }], 'dept_id,metric_id');
}

export default db;
