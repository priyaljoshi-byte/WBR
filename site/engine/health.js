/**
 * health.js - is this number OK?
 *
 * Health never changes a ring's colour (ring colour is positional). It decides
 * the card border and, more importantly, whether a flag gets raised with
 * somebody's name on it. So the order of the rules matters: you cannot judge a
 * number against a target when the number is missing or a week old.
 */

/** Used when a target is set but no explicit warn_at / crit_at is configured. */
export const DEFAULT_WARN_AT = 0.7;
/** Used when a target is set but no explicit warn_at / crit_at is configured. */
export const DEFAULT_CRIT_AT = 0.4;

/**
 * @typedef {Object} SnapshotContext
 * @property {string} [periodStart]        ISO date - anything synced before this is stale
 * @property {string} [lastSyncedAt]       ISO timestamp of the source's freshness (asOf, else fetchedAt)
 * @property {'ok'|'empty'|'error'} [sourceStatus]
 * @property {string} [sourceError]
 */

const toTime = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/**
 * @param {import('./types.js').MetricDef} def
 * @param {number|null} raw
 * @param {SnapshotContext} [snapshotContext]
 * @returns {import('./types.js').Health}
 */
export function health(def, raw, snapshotContext = {}) {
  const ctx = snapshotContext || {};

  // 1. nothing to judge
  if (ctx.sourceStatus === 'error' || ctx.sourceError) return 'missing';
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return 'missing';

  // 2. the number exists but predates the period - it is last week's number
  const synced = toTime(ctx.lastSyncedAt);
  const start = toTime(ctx.periodStart);
  if (synced !== null && start !== null && synced < start) return 'stale';

  // 3. tracked, not judged
  const target = def ? def.target : null;
  if (target === null || target === undefined) return 'untracked';

  // 4. judged
  const direction = (def && def.direction) === 'down' ? 'down' : 'up';
  let ratio;
  if (direction === 'down') {
    // lower is better: being at or under target is a ratio of 1 or more
    ratio = target === 0 ? (raw === 0 ? 1 : 0) : target / raw;
    if (!Number.isFinite(ratio)) ratio = raw === 0 ? 1 : 0;
  } else {
    ratio = target === 0 ? 1 : raw / target;
  }

  const warnAt = def.warn_at === null || def.warn_at === undefined ? DEFAULT_WARN_AT : def.warn_at;
  const critAt = def.crit_at === null || def.crit_at === undefined ? DEFAULT_CRIT_AT : def.crit_at;

  if (ratio < critAt) return 'crit';
  if (ratio < warnAt) return 'warn';
  return 'good';
}

export default health;
