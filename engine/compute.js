/**
 * compute.js - MetricDef + Rows -> Snapshot.
 *
 * A Snapshot is the unit of history: once written it is never recomputed, which
 * is why last week's number cannot silently change underneath a decision. That
 * is also why the unit is frozen onto the snapshot alongside the value - if
 * somebody re-denominates a metric next quarter, last quarter's number must
 * still render in the unit it was actually measured in.
 */

import { aggregate } from './aggregate.js';
import { resolveDenominator, normalize } from './normalize.js';
import { health } from './health.js';
import { renderCaption } from './caption.js';
import { freshnessDetail } from './freshness.js';

/**
 * @param {import('./types.js').MetricDef} def
 * @param {import('./types.js').Rows|Array<Record<string,any>>} rows  this metric's source rows, unfiltered
 * @param {Object} [ctx]
 * @param {string} [ctx.runId]
 * @param {string} [ctx.periodStart]
 * @param {string} [ctx.periodEnd]
 * @param {string} [ctx.now] ISO - computedAt
 * @param {string} [ctx.meetingAt] ISO - when the review starts, for freshness. Defaults to now.
 * @param {Object} [ctx.source] the sources.json entry, for the row-timestamp column
 * @param {Object} [ctx.freshnessConfig] org.json `freshness`
 * @param {Record<string, number|null>} [ctx.raws] already-computed raws, keyed by metric id (mutated with this one)
 * @param {Record<string, import('./types.js').Snapshot>} [ctx.prior] previous period's snapshots, by metric id
 * @param {Record<string, {value:number|null, by?:string}>} [ctx.stated] what someone SAID in the meeting
 * @returns {import('./types.js').Snapshot}
 */
export function computeSnapshot(def, rows, ctx = {}) {
  const warnings = [];
  const envelope = Array.isArray(rows) ? null : (rows || null);
  const status = envelope ? envelope.status : 'ok';
  const sourceError = envelope ? envelope.error : undefined;
  const now = ctx.now || new Date().toISOString();

  // The connector's own complaints come first: "row 14: 05/10/2026 reads both
  // ways" is about the data that produced this number, so it belongs on the
  // snapshot alongside the number, not in a log nobody opens.
  if (envelope && Array.isArray(envelope.warnings)) {
    for (const w of envelope.warnings) warnings.push(w);
  }

  // --- raw -----------------------------------------------------------------
  let raw = null;
  let rowCount = 0;

  if (status === 'error') {
    warnings.push(`source "${def.source && def.source.ref}" errored: ${sourceError || 'unknown error'}`);
  } else if (status === 'empty' || (envelope && (!envelope.rows || envelope.rows.length === 0))) {
    // Read fine, found nothing. That is not a zero - it is an absence of data,
    // and pretending otherwise is exactly the lie this engine refuses to tell.
    warnings.push(`source "${def.source && def.source.ref}" returned no rows - value unknown, not 0`);
  } else {
    const res = aggregate(rows, def.source || {});
    raw = res.value;
    rowCount = res.rowCount;
    for (const w of res.warnings) warnings.push(w);
  }

  // --- denominator ---------------------------------------------------------
  const den = resolveDenominator(def, { raws: ctx.raws || {}, rows });
  for (const w of den.warnings) warnings.push(w);

  // --- normalized ----------------------------------------------------------
  const norm = normalize(raw, den);
  for (const w of norm.warnings) warnings.push(w);

  // --- health --------------------------------------------------------------
  const lastSyncedAt = envelope ? (envelope.asOf || envelope.fetchedAt || null) : null;
  const metricHealth = health(def, raw, {
    periodStart: ctx.periodStart,
    lastSyncedAt,
    sourceStatus: status,
    sourceError
  });

  // --- freshness: HOW the data was maintained, not whether it is right ------
  const fresh = freshnessDetail(
    rows,
    ctx.source || null,
    ctx.meetingAt || now,
    ctx.freshnessConfig
  );
  const freshness = fresh.level;
  // Unreadable edit stamps are carried, because freshness is a public label on
  // a team and it must not rest on cells nobody could read.
  for (const w of (fresh.warnings || [])) warnings.push(w);

  // --- delta vs prior ------------------------------------------------------
  const prior = (ctx.prior && ctx.prior[def.id]) || null;
  const priorRaw = prior && prior.raw !== undefined ? prior.raw : null;
  const priorNormalized = prior && prior.normalized !== undefined ? prior.normalized : null;
  const delta = (norm.normalized === null || priorNormalized === null || priorNormalized === undefined)
    ? null
    : norm.normalized - priorNormalized;

  // --- caption -------------------------------------------------------------
  const caption = renderCaption(def.caption, {
    raw,
    denominator: den.value,
    denominator_label: den.label,
    normalized: norm.normalized,
    target: def.target,
    unit: def.unit
  });

  // publish the raw so dependent metrics can divide by it
  if (ctx.raws) ctx.raws[def.id] = raw;

  /** @type {import('./types.js').Snapshot} */
  const snapshot = {
    runId: ctx.runId || null,
    metricId: def.id,
    periodStart: ctx.periodStart || null,
    periodEnd: ctx.periodEnd || null,
    raw,
    denominator: den.value,
    normalized: norm.normalized,
    priorRaw: priorRaw === undefined ? null : priorRaw,
    priorNormalized: priorNormalized === undefined ? null : priorNormalized,
    delta,
    health: metricHealth,
    freshness,
    unit: def.unit || 'count',
    caption,
    rowCount,
    computedAt: now,
    warnings
  };

  // dimensions, copied so a rollup needs no join back to the catalog
  if (def.segment) snapshot.segment = def.segment;
  if (def.family) snapshot.family = def.family;

  const stated = ctx.stated && ctx.stated[def.id];
  if (stated) {
    snapshot.statedValue = stated.value === undefined ? null : stated.value;
    if (stated.by) snapshot.statedBy = stated.by;
  }

  return snapshot;
}

export default computeSnapshot;
