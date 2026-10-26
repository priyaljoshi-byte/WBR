/**
 * live.js - what people saved on the Sources screen, brought into the weekly run.
 *
 * config/sources.json holds placeholders. The real spreadsheet ids, the tab a
 * link was copied from, the column map ("value" is the sheet's "Revenue") and
 * every uploaded file live in Supabase, because that is where the browser
 * writes them. A run that read only sources.json would compute every number
 * against REPLACE_WITH_SPREADSHEET_ID and publish a dashboard of blanks while
 * the data sat one table away - which is exactly what happened until this file.
 *
 * Read with the publishable key: the same public key the browser ships, and the
 * same read access. Nothing here can write.
 *
 * Never throws. If Supabase cannot be reached the run carries on with
 * sources.json and says so, because a run that dies publishes nothing at all.
 */

import { PULSE_CONFIG } from '../app/config.js';

const latestPerSource = (rows) => {
  const out = new Map();
  for (const r of rows) {
    const prev = out.get(r.source_id);
    if (!prev || Number(r.id) > Number(prev.id)) out.set(r.source_id, r);
  }
  return out;
};

async function select(base, key, table, query, fetchImpl) {
  const res = await fetchImpl(`${base}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` }
  });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
  return res.json();
}

/**
 * @returns {Promise<{sources: Map, mappings: Map, uploads: Map, error: string|null}>}
 */
export async function loadLive(env = process.env, fetchImpl = fetch) {
  const base = env.PULSE_SUPABASE_URL || PULSE_CONFIG.SUPABASE_URL;
  const key = env.PULSE_SUPABASE_KEY || PULSE_CONFIG.SUPABASE_ANON_KEY;
  const empty = { sources: new Map(), mappings: new Map(), uploads: new Map(), error: null };
  if (!base || !key || env.PULSE_OFFLINE === '1') return { ...empty, error: 'offline' };
  try {
    const [sources, mappings, uploads] = await Promise.all([
      select(base, key, 'pulse_sources', 'select=*', fetchImpl),
      select(base, key, 'pulse_column_mappings', 'select=*', fetchImpl).catch(() => []),
      // Newest first; one per source is all a run needs.
      select(base, key, 'pulse_uploads', 'select=id,source_id,filename,columns,rows,uploaded_by&order=id.desc&limit=200', fetchImpl).catch(() => [])
    ]);
    return {
      sources: new Map(sources.map((r) => [r.id, r])),
      mappings: new Map(mappings.map((r) => [r.source_id, r])),
      uploads: latestPerSource(uploads),
      error: null
    };
  } catch (err) {
    return { ...empty, error: err.message };
  }
}

/** A ref that names nothing yet. Same rule as app/refs.js isPlaceholderRef. */
const placeholder = (ref) => !String(ref ?? '').trim() || /^REPLACE_WITH/i.test(String(ref));

/**
 * sources.json, with what the Sources screen saved laid over it. The database
 * wins wherever it has a real value, since that is the newer, human answer.
 * The upload and the column map ride along on the source as _upload / _mapping
 * for connectors/index.js.
 */
export function mergeLive(sourcesConfig, live) {
  return {
    ...sourcesConfig,
    sources: sourcesConfig.sources.map((s) => {
      const row = live.sources.get(s.id);
      const next = { ...s };
      if (row) {
        if (!placeholder(row.ref)) next.ref = row.ref;
        if (row.config && row.config.gid) { next.gid = String(row.config.gid); next.tab = null; }
        else if (row.tab) next.tab = row.tab;
        if (row.header_row > 1) next.header_row = row.header_row;
        if (row.date_column) next.date_column = row.date_column;
      }
      const map = live.mappings.get(s.id);
      if (map) {
        next._mapping = map.mapping || {};
        if (map.date_order && map.date_order !== 'auto') next.date_order = map.date_order;
      }
      const up = live.uploads.get(s.id);
      if (up) next._upload = up;
      return next;
    })
  };
}
