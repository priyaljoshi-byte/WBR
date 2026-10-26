/**
 * scoreboard.js - "where do we stand against target", by line of business.
 *
 * This is the first thing in the room and it is meant to take two minutes, so it
 * answers one question per department and refuses to pad.
 *
 * The honesty rule here is `totalJudged`. A department with nine metrics and one
 * target does not get to report "1 of 1 on target" and look perfect - onTarget
 * is counted against the metrics that actually have a target, and the untracked
 * ones are counted separately so the gap is visible rather than flattering.
 */

import { OWNER_NEEDED, hasOwnerEntry, joinNames, ownerTeam } from './owners.js';

const HEALTH_KEYS = ['good', 'warn', 'crit', 'stale', 'missing', 'untracked'];

/**
 * Worst first. Missing data outranks a bad number: you cannot fix what you
 * cannot see.
 *
 * `untracked` scores 0 alongside `good` and so can never BE the worst metric.
 * An untracked number is not in trouble, it is unjudged - naming it "the worst
 * thing in this department" would point the room at a configuration gap instead
 * of at a result. The gap is already reported, twice: byHealth.untracked here,
 * and a no_target flag with the owner's name on it.
 */
const HEALTH_SEVERITY = { missing: 5, crit: 4, stale: 3, warn: 2, untracked: 0, good: 0 };

/** For picking one label to describe a whole department's data hygiene. */
const FRESHNESS_SEVERITY = { last_minute: 4, stale: 3, unknown: 2, weekly: 1, daily: 0 };
const FRESHNESS_KEYS = ['daily', 'weekly', 'last_minute', 'stale', 'unknown'];

function indexDefs(defs) {
  const byId = new Map();
  for (const def of (Array.isArray(defs) ? defs : [])) {
    if (def && def.id) byId.set(def.id, def);
  }
  return byId;
}

/**
 * The scoreboard shows the TRIO, not one name. This row is about a line of
 * business, and the line of business is owned by three people - hiding two of
 * them here would cost the visibility the founder asked for. The single
 * accountable name belongs on a flag, where there is a verb attached.
 *
 * `owner` stays a string so every existing renderer keeps working; `team` is
 * the array for anyone who wants to render the three names separately.
 */
function teamFor(deptId, org) {
  const team = ownerTeam(deptId, org);
  if (team.length) return team;
  // No owners entry at all: fall back to the department's own label, which is
  // at least a thing you can go and ask about.
  if (hasOwnerEntry(deptId, org)) return [];
  const match = ((org && org.departments) || []).find((d) => d && d.id === deptId);
  if (match && match.label) return [match.label];
  return deptId ? [deptId] : [];
}

function ownerLabelFor(deptId, org) {
  const team = teamFor(deptId, org);
  return team.length ? joinNames(team) : OWNER_NEEDED;
}

function labelFor(deptId, org) {
  const match = ((org && org.departments) || []).find((d) => d && d.id === deptId);
  return (match && match.label) || deptId || 'Unassigned';
}

/**
 * One row per department.
 *
 * @param {import('./types.js').Snapshot[]} snapshots
 * @param {import('./types.js').MetricDef[]} defs
 * @param {Object} org  org.json
 * @returns {Array<{
 *   deptId: string,
 *   deptLabel: string,
 *   owner: string,
 *   team: string[],
 *   onTarget: number,
 *   totalJudged: number,
 *   byHealth: {good:number,warn:number,crit:number,stale:number,missing:number,untracked:number},
 *   worstMetric: {id:string,label:string,health:string}|null,
 *   netDelta: number|null,
 *   freshness: string
 * }>}
 */
export function deptScoreboard(snapshots, defs, org) {
  const byId = indexDefs(defs);
  const list = Array.isArray(snapshots) ? snapshots : Object.values(snapshots || {});

  /** @type {Map<string, any>} */
  const rows = new Map();

  // Seed in org.json order so the scoreboard reads in the agenda's order and a
  // department with zero metrics still shows up as a visible blank rather than
  // quietly vanishing.
  for (const dept of ((org && org.departments) || [])) {
    if (!dept || !dept.id) continue;
    rows.set(dept.id, newRow(dept.id, org));
  }

  for (const snap of list) {
    if (!snap || !snap.metricId) continue;
    const def = byId.get(snap.metricId);
    if (!def) continue;
    const deptId = def.dept || 'unassigned';
    if (!rows.has(deptId)) rows.set(deptId, newRow(deptId, org));
    const row = rows.get(deptId);

    const health = snap.health || 'untracked';
    if (HEALTH_KEYS.includes(health)) row.byHealth[health] += 1;

    // Only metrics carrying a target can be judged against one.
    if (health === 'good' || health === 'warn' || health === 'crit') {
      row.totalJudged += 1;
      if (health === 'good') row.onTarget += 1;
    }

    if (typeof snap.delta === 'number' && Number.isFinite(snap.delta)) {
      row._deltas.push(snap.delta);
    }

    const freshness = snap.freshness || 'unknown';
    if (FRESHNESS_KEYS.includes(freshness)) row.freshnessCounts[freshness] += 1;

    const severity = HEALTH_SEVERITY[health] ?? 0;
    const current = row._worstSeverity;
    const tieBreakDelta = typeof snap.delta === 'number' ? snap.delta : 0;
    if (
      severity > current ||
      (severity === current && severity > 0 && tieBreakDelta < row._worstDelta) ||
      (severity === current && severity > 0 && tieBreakDelta === row._worstDelta &&
        row.worstMetric && snap.metricId < row.worstMetric.id)
    ) {
      row._worstSeverity = severity;
      row._worstDelta = tieBreakDelta;
      row.worstMetric = { id: snap.metricId, label: def.label || snap.metricId, health };
    }
  }

  const out = [];
  for (const row of rows.values()) {
    row.netDelta = row._deltas.length ? row._deltas.reduce((a, b) => a + b, 0) : null;

    // One word for the department's data hygiene: whichever level describes the
    // most of its sources, broken toward the more severe so a tie never flatters.
    let freshness = 'unknown';
    let best = -1;
    for (const key of FRESHNESS_KEYS) {
      const count = row.freshnessCounts[key];
      if (count === 0) continue;
      if (count > best || (count === best && FRESHNESS_SEVERITY[key] > FRESHNESS_SEVERITY[freshness])) {
        best = count;
        freshness = key;
      }
    }
    row.freshness = freshness;

    // worstMetric stays null when a department has nothing worse than 'good'
    if (row._worstSeverity === 0) row.worstMetric = null;

    delete row._deltas;
    delete row._worstSeverity;
    delete row._worstDelta;
    out.push(row);
  }
  return out;
}

function newRow(deptId, org) {
  return {
    deptId,
    deptLabel: labelFor(deptId, org),
    // The trio, as a sentence and as an array. Both, because the renderer wants
    // the sentence and anything doing notification wants the array.
    owner: ownerLabelFor(deptId, org),
    team: teamFor(deptId, org),
    onTarget: 0,
    totalJudged: 0,
    byHealth: { good: 0, warn: 0, crit: 0, stale: 0, missing: 0, untracked: 0 },
    worstMetric: null,
    netDelta: null,
    freshness: 'unknown',
    // extra, additive - the renderer reads `freshness`, this is for the footer
    freshnessCounts: { daily: 0, weekly: 0, last_minute: 0, stale: 0, unknown: 0 },
    _deltas: [],
    _worstSeverity: 0,
    _worstDelta: 0
  };
}

export default deptScoreboard;
