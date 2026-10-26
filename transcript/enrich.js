/**
 * enrich.js - the compounding view.
 *
 * The test of this system is not whether week 12 is longer than week 1. It is
 * whether week 12 KNOWS something week 1 could not. That only happens if every
 * decision is tied to numbers and those numbers are read again later, against the
 * state of the world on the day the decision was taken.
 *
 * So this file answers one question per decision: since you decided this, did the
 * things you said would move, move? And then the two questions nobody asks because
 * neither has an obvious owner:
 *   - which decisions is nobody measuring?   (decisionsWithoutProof)
 *   - which numbers is nobody acting on?     (metricsWithoutDecisions)
 */

import { defaultCatalog } from './schema.js';
import { TERMINAL_STATUSES } from '../engine/types.js';

function indexMetrics(catalog) {
  const map = new Map();
  for (const m of catalog.metrics || []) map.set(m.id, m);
  return map;
}

function latestSnapshots(snapshots) {
  const map = new Map();
  for (const s of snapshots || []) {
    if (!s || !s.metricId) continue;
    const prev = map.get(s.metricId);
    if (!prev || String(s.periodEnd || '') >= String(prev.periodEnd || '')) map.set(s.metricId, s);
  }
  return map;
}

/**
 * The measured value for a metric as at (or before) a date. This is what makes the
 * verdict honest: a decision taken six weeks ago is judged against the number it
 * was taken in front of, not against last week's.
 */
function baselineFor(metricId, onOrBefore, history) {
  let best = null;
  for (const s of history || []) {
    if (s.metricId !== metricId) continue;
    if (onOrBefore && String(s.periodEnd || '') > String(onOrBefore)) continue;
    if (!best || String(s.periodEnd || '') > String(best.periodEnd || '')) best = s;
  }
  return best;
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from === 0) return to === 0 ? 0 : null;
  return (to - from) / Math.abs(from);
}

/**
 * Did this metric move the way the decision needed it to?
 * `direction: 'up'` means higher is better, so a rise is 'better'.
 */
function readMovement(def, from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'unknown';
  if (from === to) return 'flat';
  const rose = to > from;
  const wantsUp = !def || def.direction !== 'down';
  return rose === wantsUp ? 'better' : 'worse';
}

function verdictFor(movements) {
  const real = movements.filter((m) => m.movement !== 'unknown');
  if (real.length === 0) return 'no measurement yet';
  const better = real.filter((m) => m.movement === 'better').length;
  const worse = real.filter((m) => m.movement === 'worse').length;
  if (better > 0 && worse === 0) return 'working';
  if (worse > 0 && better === 0) return 'not working';
  if (better > 0 && worse > 0) return 'mixed';
  return 'flat';
}

/**
 * Week-on-week compounding view.
 *
 * @param {Object} thisWeek  {meeting, decisions, snapshots, history?, catalog?}
 * @param {Object} lastWeek  {meeting, decisions, snapshots} - may be null in week 1
 * @returns {Object}
 */
export function enrichmentDelta(thisWeek = {}, lastWeek = null) {
  const catalog = thisWeek.catalog || defaultCatalog();
  const metrics = indexMetrics(catalog);

  const decisions = thisWeek.decisions || [];
  const now = latestSnapshots(thisWeek.snapshots);
  const prior = latestSnapshots(lastWeek ? lastWeek.snapshots : []);

  // History lets us price a decision against the week it was taken. Without it we
  // fall back to the previous period, and we SAY that we fell back rather than
  // letting a one-week delta masquerade as a six-week result.
  const history = thisWeek.history || [
    ...(lastWeek ? lastWeek.snapshots || [] : []),
    ...(thisWeek.snapshots || [])
  ];

  const meetingDates = thisWeek.meetingDates || {};

  const rows = decisions.map((d) => {
    const decidedOn = meetingDates[d.firstSeenMeeting] || d.decidedOn || null;

    const movements = (d.metricIds || []).map((metricId) => {
      const def = metrics.get(metricId) || null;
      const current = now.get(metricId) || null;
      const to = current && Number.isFinite(current.raw) ? current.raw : null;

      let from = null;
      let baselineSource = 'none';
      const atDecision = decidedOn ? baselineFor(metricId, decidedOn, history) : null;
      if (atDecision && Number.isFinite(atDecision.raw)) {
        from = atDecision.raw;
        baselineSource = 'at-decision';
      } else if (prior.has(metricId) && Number.isFinite(prior.get(metricId).raw)) {
        from = prior.get(metricId).raw;
        baselineSource = 'prior-week';
      } else if (current && Number.isFinite(current.priorRaw)) {
        from = current.priorRaw;
        baselineSource = 'snapshot-prior';
      }

      return {
        metricId,
        label: def ? def.label : metricId,
        unit: def ? def.unit : null,
        direction: def ? def.direction : null,
        atDecision: from,
        now: to,
        baselineSource,
        change: Number.isFinite(from) && Number.isFinite(to) ? to - from : null,
        pctChange: pctChange(from, to),
        movement: readMovement(def, from, to)
      };
    });

    return {
      decisionId: d.id,
      number: d.number,
      headline: d.headline,
      domain: d.domain,
      status: d.status,
      owner: d.owner,
      dueDate: d.dueDate,
      firstSeenMeeting: d.firstSeenMeeting,
      decidedOn,
      metrics: movements,
      verdict: movements.length === 0 ? 'no proof linked' : verdictFor(movements)
    };
  });

  const lastIds = new Set((lastWeek ? lastWeek.decisions || [] : []).map((d) => d.id));
  const thisIds = new Set(decisions.map((d) => d.id));

  const newDecisions = decisions.filter((d) => !lastIds.has(d.id)).map((d) => d.id);
  const closedDecisions = decisions
    .filter((d) => TERMINAL_STATUSES.includes(d.status) && lastIds.has(d.id))
    .map((d) => d.id);
  const carriedDecisions = decisions
    .filter((d) => lastIds.has(d.id) && !TERMINAL_STATUSES.includes(d.status))
    .map((d) => d.id);
  const droppedFromLog = [...lastIds].filter((id) => !thisIds.has(id));

  const working = rows.filter((r) => r.verdict === 'working').length;
  const notWorking = rows.filter((r) => r.verdict === 'not working').length;

  return {
    meetingId: (thisWeek.meeting && thisWeek.meeting.id) || null,
    comparedTo: (lastWeek && lastWeek.meeting && lastWeek.meeting.id) || null,
    decisions: rows,
    newDecisions,
    carriedDecisions,
    closedDecisions,
    droppedFromLog,
    decisionsWithoutProof: decisionsWithoutProof(decisions),
    metricsWithoutDecisions: metricsWithoutDecisions(thisWeek.snapshots, decisions, catalog),
    compounding: {
      decisionsOnTheBooks: decisions.length,
      wasOnTheBooks: lastIds.size,
      working,
      notWorking,
      unprovable: rows.filter((r) => r.verdict === 'no proof linked').length,
      // The number that says whether the system is getting richer rather than
      // just longer: how many decisions can now be judged against evidence.
      judgeable: rows.filter((r) => r.verdict !== 'no proof linked' && r.verdict !== 'no measurement yet').length
    }
  };
}

/**
 * Blind spot one: choices nobody is measuring.
 * An open decision with no linked metric cannot be shown to have worked. It will
 * be restated every week until someone gets bored of it, which is not the same as
 * it being finished.
 */
export function decisionsWithoutProof(decisions = []) {
  return decisions
    .filter((d) => !TERMINAL_STATUSES.includes(d.status))
    .filter((d) => !Array.isArray(d.metricIds) || d.metricIds.length === 0)
    .map((d) => ({
      decisionId: d.id,
      headline: d.headline,
      domain: d.domain,
      status: d.status,
      owner: d.owner,
      why: 'no metricIds linked, so nothing on the dashboard moves when this works'
    }));
}

/**
 * Blind spot two: numbers nobody is acting on.
 * A metric with no decision attached is a number being watched out of habit.
 * Either a decision should reference it, or it should come off the dashboard.
 */
export function metricsWithoutDecisions(snapshots = [], decisions = [], catalog = defaultCatalog()) {
  const claimed = new Set();
  for (const d of decisions) {
    if (TERMINAL_STATUSES.includes(d.status)) continue;
    for (const id of d.metricIds || []) claimed.add(id);
  }
  const metrics = indexMetrics(catalog);
  const seen = new Set();
  const out = [];
  for (const s of snapshots || []) {
    if (!s || !s.metricId || seen.has(s.metricId)) continue;
    seen.add(s.metricId);
    if (claimed.has(s.metricId)) continue;
    const def = metrics.get(s.metricId);
    out.push({
      metricId: s.metricId,
      label: def ? def.label : s.metricId,
      dept: def ? def.dept : null,
      raw: s.raw ?? null,
      delta: s.delta ?? null,
      health: s.health ?? null,
      why: 'no open decision references this metric, so nobody is acting on it'
    });
  }
  return out;
}
