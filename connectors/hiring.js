/**
 * hiring.js - the hiring tracker, read the way it is actually kept.
 *
 * The tracker has no "Roles" or "Candidates" tab. It has an open-roles tab, one
 * candidate tab per recruiter with a free-text "Current Stage", and an Offers &
 * Joiners log. engine/hiring.js turns those into the role-by-role funnel (the
 * same code the Hiring funnel page runs), and funnelTables() gives the
 * catalogue the two plain tables its hiring metrics count.
 *
 * The query's tab picks which: "Roles" or "Candidates". The four sheet tabs are
 * read once per run and shared by both.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSheetCsv } from '../app/sheets.js';
import { parseCSV } from '../app/csv.js';
import { buildFunnels, funnelTables } from '../engine/hiring.js';
import { normalizeRows } from './index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();

async function readTab(id, gid, fetchImpl) {
  const res = await fetchSheetCsv(id, { gid, fetchImpl });
  return parseCSV(res.text, { headerRow: 'auto' }).rows;
}

export async function loadHiringTables(source, { fetchImpl, config } = {}) {
  const key = source.ref;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const cfg = config || JSON.parse(await readFile(join(ROOT, 'config/hiring.json'), 'utf8'));
      const t = cfg.tabs;
      const [roleRows, offerRows, ...cand] = await Promise.all([
        readTab(source.ref, t.roles.gid, fetchImpl),
        readTab(source.ref, t.offers.gid, fetchImpl).catch(() => []),
        ...t.candidates.map((c) => readTab(source.ref, c.gid, fetchImpl))
      ]);
      const result = buildFunnels({
        roleRows, offerRows,
        candidateTabs: t.candidates.map((c, i) => ({ recruiter: c.recruiter, rows: cand[i] }))
      }, cfg);
      return funnelTables(result, cfg);
    })());
  }
  try {
    return await cache.get(key);
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

export async function fetchHiring(source, _period, env, opts = {}) {
  const tables = await loadHiringTables(source, opts);
  const which = String(source._tab || source.tab || '').toLowerCase().startsWith('role') ? 'roles' : 'candidates';
  const rows = tables[which];
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { ...normalizeRows(headers, rows), asOf: new Date().toISOString() };
}

/** Tests only. */
export function _clearHiringCache() { cache.clear(); }
