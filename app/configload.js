/**
 * configload.js - read config/*.json, then let the database override it.
 *
 * The README's rule: "Those JSON files are the seed. Once the app is deployed the
 * same rows live in Supabase and department heads edit them through the UI." So
 * this module loads the seed first (it always works, even signed out, which is
 * what keeps a page from going blank) and then layers the live rows on top.
 */

import { PULSE_CONFIG } from './config.js';
import { db, hasToken } from './supabase.js';

const cache = new Map();

async function loadJSON(name) {
  if (cache.has(name)) return cache.get(name);
  const bases = [PULSE_CONFIG.CONFIG_BASE, './config', '/config', '..'];
  let lastErr = null;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/${name}`, { cache: 'no-cache' });
      if (!res.ok) { lastErr = new Error(`${base}/${name} -> HTTP ${res.status}`); continue; }
      const json = await res.json();
      cache.set(name, json);
      return json;
    } catch (err) { lastErr = err; }
  }
  throw new Error(`Could not read config/${name}. Serve the repo root over http (the app reads ../config). ${lastErr ? lastErr.message : ''}`);
}

/**
 * The meetings config.
 *
 * config/meetings.json now exists and lists the four weekly reviews. Its
 * membership is a list of `{dept, segment}` - Perf Marketing has no meeting of
 * its own, so Perf India rides with the Tuesday India charter and Perf US with
 * the Wednesday US charter. The app only needs a label and a blurb per meeting,
 * so the shape is flattened here rather than every screen learning it.
 *
 * FALLBACK_MEETINGS still exists for a repo without the file: one weekly WBR,
 * and the Add a meeting screen says so out loud rather than pretending the list
 * is complete.
 */
export const FALLBACK_MEETINGS = {
  _fallback: true,
  meetings: [
    {
      id: 'wbr',
      label: 'Weekly business review',
      short: 'WBR',
      kind: 'wbr',
      cadence: 'weekly',
      day: 'monday',
      time: '10:00',
      depts: null,
      blurb: 'The whole leadership group. Scoreboard, blockers, decisions.'
    }
  ]
};

export async function loadMeetings() {
  try {
    const json = await loadJSON('meetings.json');
    if (json && Array.isArray(json.meetings) && json.meetings.length) {
      return {
        ...json,
        meetings: json.meetings.map((m) => ({
          ...m,
          // The file calls it `name`; every screen here asks for `label`.
          label: m.label || m.name || m.id,
          short: m.short || m.name || m.id,
          kind: m.kind || m.id,
          cadence: m.cadence || 'weekly',
          // Departments only, for a picker. The segment is what decides which
          // METRIC lands in which room, and no screen here reads metrics.
          depts: Array.isArray(m.members) && m.members.length
            ? [...new Set(m.members.map((x) => (typeof x === 'string' ? x : x && x.dept)).filter(Boolean))]
            : (m.depts || null),
          blurb: m.blurb || m._note || ''
        }))
      };
    }
  } catch { /* no meetings.json - one room, as before */ }

  // A meeting kind is config, so the database may already carry more than the
  // seed does. Rows win when they exist.
  if (hasToken()) {
    try {
      const rows = await db.select('pulse_meeting_kinds', { order: 'ord.asc' });
      if (rows.length) {
        return {
          _fromDatabase: true,
          meetings: rows.map((r) => ({
            id: r.id, label: r.label, short: r.short_label || r.label,
            kind: r.kind || r.id, cadence: r.cadence, day: r.day,
            time: r.time_of_day, depts: r.dept_ids && r.dept_ids.length ? r.dept_ids : null,
            blurb: r.blurb
          }))
        };
      }
    } catch { /* table not created yet */ }
  }
  return FALLBACK_MEETINGS;
}

export const loadOrg = () => loadJSON('org.json');
export const loadCatalog = () => loadJSON('catalog.json');
export const loadSources = () => loadJSON('sources.json');

/**
 * Everything a setup screen needs, seed merged with live rows.
 * @returns {Promise<{org, catalog, sources, meetings, live: boolean, liveError: string|null}>}
 */
export async function loadAll() {
  const [org, catalog, sources, meetings] = await Promise.all([
    loadOrg(), loadCatalog(), loadSources(), loadMeetings()
  ]);

  const merged = {
    org,
    catalog: { ...catalog, metrics: catalog.metrics.map((m) => ({ ...m })) },
    sources: { ...sources, sources: sources.sources.map((s) => ({ ...s })) },
    meetings,
    live: false,
    liveError: null
  };

  if (!hasToken()) return merged;

  try {
    const [dbSources, dbMetrics] = await Promise.all([
      db.select('pulse_sources'),
      db.select('pulse_metrics')
    ]);
    const bySource = new Map(dbSources.map((r) => [r.id, r]));
    merged.sources.sources = merged.sources.sources.map((s) => {
      const row = bySource.get(s.id);
      if (!row) return s;
      return {
        ...s,
        ref: row.ref != null ? row.ref : s.ref,
        tab: row.tab != null ? row.tab : s.tab,
        date_column: row.date_column || s.date_column,
        // How this source writes a bare slash date. Overridable from the DB for
        // the same reason date_column is: the person who knows the answer is
        // looking at the sheet, not at the repo.
        date_order: row.date_order || s.date_order,
        last_synced_at: row.last_synced_at,
        last_sync_status: row.last_sync_status,
        last_sync_error: row.last_sync_error,
        last_row_count: row.last_row_count,
        _db: true
      };
    });

    const byMetric = new Map(dbMetrics.map((r) => [r.id, r]));
    merged.catalog.metrics = merged.catalog.metrics.map((m) => {
      const row = byMetric.get(m.id);
      if (!row) return m;
      return {
        ...m,
        target: row.target === null || row.target === undefined ? m.target : Number(row.target),
        warn_at: row.warn_at === null || row.warn_at === undefined ? m.warn_at : Number(row.warn_at),
        crit_at: row.crit_at === null || row.crit_at === undefined ? m.crit_at : Number(row.crit_at),
        direction: row.direction || m.direction,
        _db: true
      };
    });

    // Owner names live in org.json as a seed and in pulse_departments once set.
    try {
      const depts = await db.select('pulse_departments');
      const byDept = new Map(depts.map((d) => [d.id, d]));
      merged.org = { ...org, owners: { ...(org.owners || {}) } };
      for (const [id, owner] of Object.entries(merged.org.owners)) {
        const row = byDept.get(id);
        if (!row) continue;
        // The table may hold the trio (owner_team, as JSON or a comma list) or
        // the single legacy owner_name. Either overrides org.json; neither is
        // allowed to silently drop the other half of the shape.
        const team = parseTeam(row.owner_team);
        if (team.length) {
          merged.org.owners[id] = { ...owner, team, lead: row.owner_lead || owner.lead || null };
        } else if (row.owner_name) {
          merged.org.owners[id] = {
            ...owner,
            team: [row.owner_name],
            lead: row.owner_name,
            email: row.owner_email || owner.email
          };
        }
      }
    } catch { /* table not created yet */ }

    merged.live = true;
  } catch (err) {
    merged.liveError = err.message;
  }

  return merged;
}

/** Metrics a department owns, including every segment. */
export function metricsForDept(catalog, deptId) {
  return catalog.metrics.filter((m) => m.dept === deptId);
}

/** Sources a department owns. */
export function sourcesForDept(sources, deptId) {
  return sources.sources.filter((s) => s.dept === deptId);
}

/** owner_team may arrive as a JSON array, a comma list, or nothing. */
function parseTeam(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('[')) {
      try { return parseTeam(JSON.parse(t)); } catch { return []; }
    }
    return t.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}
