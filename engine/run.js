/**
 * run.js - one period, start to finish.
 *
 *   order the metrics -> fetch each source ONCE -> compute every snapshot
 *   -> derive the flags -> stamp the run
 *
 * `fetch` is injected, so a whole run is testable with no network, no sheets
 * and no clock: runPeriod({..., fetch: async () => rowsFixture, now: '...'}).
 */

import { orderMetrics } from './normalize.js';
import { computeSnapshot } from './compute.js';
import { deriveFlags } from './flags.js';

/**
 * A source is fetched once per (source, tab) pair: gtm_sheet's "Channels" tab
 * and its "Leads" tab are different data, but all five Leads metrics share one
 * read. Nothing is ever fetched twice for the same key.
 */
const fetchKey = (query) => `${query.ref}::${query.tab || ''}`;

/**
 * The configured sources, with the file-level slash-date fallback stamped onto
 * each one that has not set its own.
 *
 * Resolved here rather than in the connector because this is the only layer that
 * can see both sources.json's `_date_order.default` and the individual entry. A
 * connector that had to go looking for the whole config file to read one setting
 * would be a connector that knows too much.
 */
function sourceList(sources) {
  if (!sources) return [];
  const list = Array.isArray(sources) ? sources : (sources.sources || []);
  const fallback = !Array.isArray(sources) && sources._date_order
    ? sources._date_order.default
    : null;
  if (!fallback) return list;
  return list.map((s) => (
    s && s.default_date_order === undefined ? { ...s, default_date_order: fallback } : s
  ));
}

function errorRows(ref, message, now) {
  return {
    sourceRef: ref,
    columns: [],
    rows: [],
    fetchedAt: now,
    status: 'error',
    error: message
  };
}

/**
 * @param {Object} options
 * @param {Object} options.catalog   catalog.json (needs .metrics)
 * @param {Object} options.sources   sources.json
 * @param {Object} options.org       org.json
 * @param {(source: Object, query: Object, period: {start:string,end:string}) => Promise<import('./types.js').Rows>} options.fetch
 * @param {string} options.periodStart ISO date
 * @param {string} options.periodEnd   ISO date
 * @param {Record<string, import('./types.js').Snapshot>} [options.prior] previous snapshots by metric id
 * @param {string} [options.now] ISO timestamp, injected so runs are reproducible
 * @param {string} [options.meetingAt] ISO - when the review starts. Freshness is measured
 *                 against this, not against `now`: a source written four hours before the
 *                 meeting is last-minute whether the run fires at dawn or the night before.
 * @param {string} [options.runId]
 * @param {'cron'|'manual'|'meeting'} [options.triggeredBy]
 * @param {Record<string,{value:number|null, by?:string}>} [options.stated]
 * @returns {Promise<{run: import('./types.js').Run, snapshots: import('./types.js').Snapshot[], flags: import('./types.js').Flag[]}>}
 */
export async function runPeriod(options) {
  const {
    catalog, sources, org, fetch,
    periodStart, periodEnd, prior = {}, stated = {},
    triggeredBy = 'cron'
  } = options || {};

  const now = options.now || new Date().toISOString();
  const meetingAt = options.meetingAt || now;
  const runId = options.runId || `run-${periodStart}`;
  const startedAt = now;

  /** @type {import('./types.js').Run} */
  const run = {
    id: runId,
    periodStart,
    periodEnd,
    startedAt,
    finishedAt: null,
    status: 'running',
    triggeredBy
  };

  const metrics = orderMetrics((catalog && catalog.metrics) || []);
  const configured = sourceList(sources);
  const period = { start: periodStart, end: periodEnd };

  // ---- fetch each distinct (source, tab) exactly once ----------------------
  const plan = new Map(); // key -> {ref, tab}
  for (const def of metrics) {
    const q = def.source;
    if (!q || !q.ref) continue;
    const key = fetchKey(q);
    if (!plan.has(key)) plan.set(key, { ref: q.ref, tab: q.tab });
  }

  /** @type {Map<string, import('./types.js').Rows>} */
  const rowsByKey = new Map();
  await Promise.all([...plan.entries()].map(async ([key, query]) => {
    const source = configured.find((s) => s && s.id === query.ref) || { id: query.ref };
    try {
      const result = await fetch(source, query, period);
      if (!result || typeof result !== 'object') {
        rowsByKey.set(key, errorRows(query.ref, 'connector returned no Rows envelope', now));
        return;
      }
      rowsByKey.set(key, {
        sourceRef: result.sourceRef || query.ref,
        columns: result.columns || [],
        rows: result.rows || [],
        fetchedAt: result.fetchedAt || now,
        status: result.status || (result.rows && result.rows.length ? 'ok' : 'empty'),
        ...(result.error ? { error: result.error } : {}),
        ...(result.asOf ? { asOf: result.asOf } : {}),
        // Connector-level complaints - an unreadable date, an ambiguous column -
        // ride the envelope so computeSnapshot can put them on the snapshot and
        // the dashboard footer can print them.
        ...(result.warnings && result.warnings.length ? { warnings: result.warnings } : {})
      });
    } catch (err) {
      rowsByKey.set(key, errorRows(query.ref, (err && err.message) || String(err), now));
    }
  }));

  // ---- compute, in dependency order ---------------------------------------
  const raws = {};
  /** @type {import('./types.js').Snapshot[]} */
  const snapshots = [];
  /** @type {Record<string, import('./types.js').Rows>} */
  const rowsByMetric = {};

  for (const def of metrics) {
    const key = def.source && def.source.ref ? fetchKey(def.source) : null;
    const rows = key && rowsByKey.has(key)
      ? rowsByKey.get(key)
      : errorRows(def.source && def.source.ref, 'metric has no source configured', now);
    rowsByMetric[def.id] = rows;
    snapshots.push(computeSnapshot(def, rows, {
      runId, periodStart, periodEnd, now, raws, prior, stated,
      meetingAt,
      source: configured.find((s) => s && s.id === (def.source && def.source.ref)) || null,
      freshnessConfig: (org && org.freshness) || {}
    }));
  }

  // ---- flags ---------------------------------------------------------------
  const flags = deriveFlags(snapshots, metrics, {
    org, sources, catalog, rowsByMetric, now, meetingAt
  });

  // ---- status --------------------------------------------------------------
  const fetched = [...rowsByKey.values()];
  const everySourceErrored = fetched.length > 0 && fetched.every((r) => r.status === 'error');
  const anyDegraded = snapshots.some((s) => s.health === 'missing' || s.health === 'stale');

  run.status = everySourceErrored ? 'failed' : anyDegraded ? 'partial' : 'ok';
  run.finishedAt = options.now || new Date().toISOString();

  return { run, snapshots, flags };
}

export default runPeriod;
