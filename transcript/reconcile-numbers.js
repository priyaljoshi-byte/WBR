/**
 * reconcile-numbers.js - what people SAID against what the data MEASURED.
 *
 * WHY THIS MATTERS, PLAINLY:
 *
 * A founder dashboard has one job that no spreadsheet does: catch the week the
 * team's story quietly stops matching the data. Nobody lies. What happens is
 * smaller and far more dangerous. Someone quotes last month's number because it is
 * the one they remember. Someone counts assets the way their own sheet counts them,
 * which is not the way the delivery log counts them. Someone rounds twelve hundred
 * up from a thousand because the week felt busy. The room nods, the number enters
 * the narrative, and three weeks later a hiring plan is sized off it.
 *
 * By the time that drift shows up in a bank balance it has cost a quarter. By the
 * time it shows up in a board deck it has cost credibility. The only cheap moment
 * to catch it is the moment it is said out loud, in a meeting where the person who
 * said it is still in the room and can explain it in one sentence - "oh, I was
 * counting reruns" - which is usually a definition problem worth fixing, not a
 * performance problem.
 *
 * So: every number asserted in the meeting is compared to the snapshot. Divergence
 * raises a flag that names the metric, the stated value, the speaker, the measured
 * value and the verbatim quote. The quote is not decoration. Without it the flag is
 * the engine's word against a person's memory, and memory wins every argument it is
 * allowed to have unsupervised.
 */

import { defaultCatalog, defaultOrg } from './schema.js';
import { metricOwner } from '../engine/owners.js';

/**
 * Relative tolerance. Five percent is roughly the width of honest rounding in a
 * spoken meeting ("about four and a half crore"). Beyond that, somebody is working
 * off a different number, not a rounded one.
 */
export const DEFAULT_TOLERANCE = 0.05;

/**
 * Absolute floor, in the metric's own raw units.
 *
 * Without this, small counts generate constant noise: 5 channels live versus a
 * stated 4 is a 20 percent divergence and a completely uninteresting sentence. The
 * floor says a difference must be BOTH more than 5 percent AND more than this many
 * units before it is worth a founder's attention.
 */
export const DEFAULT_ABSOLUTE_FLOOR = 1;

function indexMetrics(catalog) {
  const map = new Map();
  for (const m of catalog.metrics || []) map.set(m.id, m);
  return map;
}

/** Latest snapshot per metric, in case a history array is handed in. */
function indexSnapshots(snapshots) {
  const map = new Map();
  for (const s of snapshots || []) {
    if (!s || !s.metricId) continue;
    const prev = map.get(s.metricId);
    if (!prev || String(s.periodEnd || '') >= String(prev.periodEnd || '')) {
      map.set(s.metricId, s);
    }
  }
  return map;
}

function formatValue(value, unit) {
  if (value === null || value === undefined) return 'no measurement';
  if (unit === 'currency_inr') return `INR ${Number(value).toLocaleString('en-IN')}`;
  if (unit === 'percent') return `${value}%`;
  return String(value);
}

/**
 * @param {Array<Object>} statedNumbers  [{metricId, statedValue, statedBy, quote}]
 * @param {Array<Object>} snapshots      Snapshot[]
 * @param {Object} [opts]
 * @param {number} [opts.tolerance]       relative, default 0.05
 * @param {number} [opts.absoluteFloor]   raw units, default 1
 * @param {Object} [opts.catalog]
 * @param {Object} [opts.org]
 * @param {Object} [opts.meeting]         {id, date} - stamps raisedAt and the flag id
 * @returns {{matches: Array, contradictions: Array, unmeasured: Array}}
 */
export function reconcileStated(statedNumbers = [], snapshots = [], opts = {}) {
  const catalog = opts.catalog || defaultCatalog();
  const org = opts.org || defaultOrg();
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : DEFAULT_TOLERANCE;
  const absoluteFloor = Number.isFinite(opts.absoluteFloor)
    ? opts.absoluteFloor
    : DEFAULT_ABSOLUTE_FLOOR;
  const meeting = opts.meeting || {};
  const raisedAt = meeting.processedAt || meeting.date || new Date().toISOString();
  const meetingId = meeting.id || 'unknown-meeting';

  const metrics = indexMetrics(catalog);
  const snaps = indexSnapshots(snapshots);

  const matches = [];
  const contradictions = [];
  const unmeasured = [];

  statedNumbers.forEach((stated, i) => {
    const def = metrics.get(stated.metricId);
    const snap = snaps.get(stated.metricId);
    const measured = snap && snap.raw !== undefined ? snap.raw : null;

    if (!def || measured === null || measured === undefined || !Number.isFinite(measured)) {
      // Nothing to argue with. Still worth surfacing: a number was asserted that
      // the dashboard cannot corroborate either way.
      unmeasured.push({
        metricId: stated.metricId,
        statedValue: stated.statedValue,
        statedBy: stated.statedBy,
        quote: stated.quote,
        why: !def ? 'metric not in catalog' : 'no measured value in the snapshot'
      });
      return;
    }

    const diff = stated.statedValue - measured;
    const absDiff = Math.abs(diff);
    const relDiff = measured === 0 ? (absDiff > 0 ? Infinity : 0) : absDiff / Math.abs(measured);
    const allowed = Math.max(Math.abs(measured) * tolerance, absoluteFloor);
    const within = absDiff <= allowed;

    const row = {
      metricId: stated.metricId,
      label: def.label,
      unit: def.unit,
      statedValue: stated.statedValue,
      statedBy: stated.statedBy,
      measured,
      diff,
      relDiff,
      tolerance,
      absoluteFloor,
      allowed,
      within,
      quote: stated.quote,
      periodEnd: snap.periodEnd || null
    };

    if (within) {
      matches.push(row);
      return;
    }

    const dept = def.dept;
    // The metric's ONE accountable owner. A contradiction between what was said
    // in the room and what the data holds is somebody's to answer, and "all
    // three of you" is how it goes unanswered.
    const owner = metricOwner(def, org).name;
    const direction = diff > 0 ? 'higher than' : 'lower than';
    const pct = Number.isFinite(relDiff) ? `${(relDiff * 100).toFixed(1)}%` : 'unbounded';

    contradictions.push({
      id: `flag-contradiction-${stated.metricId}-${meetingId}-${i}`,
      dept,
      owner,
      title: `Stated ${def.label} does not match the data`,
      body:
        `${stated.statedBy} stated ${formatValue(stated.statedValue, def.unit)} for ` +
        `${def.label}. The snapshot measured ${formatValue(measured, def.unit)}. ` +
        `That is ${pct} ${direction} measured, past the ${(tolerance * 100).toFixed(0)}% ` +
        `tolerance. Quote: "${stated.quote}". ` +
        `Either the number is wrong or the definition is. Settle which before it is ` +
        `used to size anything.`,
      kind: 'contradiction',
      raisedBy: 'transcript',
      raisedAt,
      resolvedAt: null,
      metricIds: [stated.metricId],
      statedValue: stated.statedValue,
      statedBy: stated.statedBy,
      measuredValue: measured,
      quote: stated.quote
    });
  });

  return { matches, contradictions, unmeasured };
}

/**
 * Attach statedValue / statedBy to copies of the snapshots, so the renderer can
 * print "said 1200, measured 1000" under the ring without recomputing anything.
 * Snapshot has both fields on it in the contract for exactly this reason.
 */
export function annotateSnapshots(snapshots = [], statedNumbers = []) {
  const byMetric = new Map();
  for (const s of statedNumbers) byMetric.set(s.metricId, s);
  return snapshots.map((snap) => {
    const stated = byMetric.get(snap.metricId);
    if (!stated) return { ...snap };
    return { ...snap, statedValue: stated.statedValue, statedBy: stated.statedBy };
  });
}
