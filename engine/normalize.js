/**
 * normalize.js - the ring arc.
 *
 *   normalized = clamp(raw / denominator * 100, 0, 100), rounded to nearest int
 *
 * The denominator is the single most important field in the system, so the
 * failure modes are explicit: a denominator of 0 or null produces `null` and a
 * warning, never Infinity, never NaN, never a full ring.
 */

import { aggregate, parseValue } from './aggregate.js';

/**
 * @typedef {Object} ResolvedDenominator
 * @property {'static'|'metric'|'column_total'|'self'} kind
 * @property {number|null} value
 * @property {string} label
 * @property {string[]} warnings
 */

/**
 * Work out what this ring is a fraction OF.
 *
 * @param {import('./types.js').MetricDef} def
 * @param {Object} ctx
 * @param {Record<string, number|null>} [ctx.raws]  already-computed raw values, by metric id
 * @param {import('./types.js').Rows|Array} [ctx.rows]  this metric's own rows, UNFILTERED (for column_total)
 * @returns {ResolvedDenominator}
 */
export function resolveDenominator(def, ctx = {}) {
  const warnings = [];
  const den = (def && def.denominator) || { kind: 'self' };
  const label = den.label === undefined || den.label === null ? '' : String(den.label);
  const out = (value) => ({ kind: den.kind || 'self', value, label, warnings });

  switch (den.kind) {
    case 'self':
      // Not a fraction. The metric IS the number.
      return out(null);

    case 'static': {
      const v = parseValue(den.value);
      if (v === null) warnings.push(`denominator for "${def.id}" is static but has no usable value`);
      return out(v);
    }

    case 'metric': {
      const raws = ctx.raws || {};
      if (!den.metric) {
        warnings.push(`denominator for "${def.id}" is kind=metric but names no metric`);
        return out(null);
      }
      if (!(den.metric in raws)) {
        warnings.push(`denominator metric "${den.metric}" for "${def.id}" has not been computed yet`);
        return out(null);
      }
      const v = raws[den.metric];
      if (v === null || v === undefined) {
        warnings.push(`denominator metric "${den.metric}" for "${def.id}" has no value`);
        return out(null);
      }
      return out(v);
    }

    case 'column_total': {
      if (!den.column) {
        warnings.push(`denominator for "${def.id}" is kind=column_total but names no column`);
        return out(null);
      }
      // sum of the column across ALL rows, before this metric's own filter
      const res = aggregate(ctx.rows || [], { agg: 'sum', column: den.column });
      for (const w of res.warnings) warnings.push(`column_total(${den.column}): ${w}`);
      return out(res.value);
    }

    default:
      warnings.push(`unknown denominator kind "${den.kind}" for "${def && def.id}"`);
      return out(null);
  }
}

/**
 * raw / denominator * 100, clamped to 0..100 and rounded to the nearest integer.
 *
 * Rounding is plain nearest-integer in both directions, with no special case
 * for small-but-nonzero fractions: 546/123990 = 0.44% rounds to 0, because the
 * engine's job is to report the fraction, not to guarantee a visible arc. If a
 * renderer wants a hairline for "small but not none", that is a rendering
 * decision and it has `raw` to make it with.
 *
 * @param {number|null} raw
 * @param {number|null|ResolvedDenominator} denominator
 * @returns {{normalized: number|null, warnings: string[]}}
 */
export function normalize(raw, denominator) {
  const warnings = [];

  let value = denominator;
  let kind = null;
  if (denominator !== null && denominator !== undefined && typeof denominator === 'object') {
    value = denominator.value;
    kind = denominator.kind || null;
  }

  if (kind === 'self') return { normalized: null, warnings };

  if (raw === null || raw === undefined) {
    return { normalized: null, warnings };
  }

  if (value === null || value === undefined) {
    warnings.push('denominator is missing - no ring arc can be drawn');
    return { normalized: null, warnings };
  }
  if (!Number.isFinite(value)) {
    warnings.push(`denominator is not a finite number (${value}) - no ring arc can be drawn`);
    return { normalized: null, warnings };
  }
  if (value === 0) {
    warnings.push('denominator is 0 - no ring arc can be drawn');
    return { normalized: null, warnings };
  }

  const pct = (raw / value) * 100;
  if (!Number.isFinite(pct)) {
    warnings.push('normalized value is not finite');
    return { normalized: null, warnings };
  }
  return { normalized: Math.round(Math.min(100, Math.max(0, pct))), warnings };
}

/**
 * Topologically sort metric defs so that any metric used as a kind=metric
 * denominator is computed before the metrics that divide by it.
 *
 * Stable: metrics that do not depend on each other keep their catalog order,
 * so the dashboard's config order is still the order you read in a debug dump.
 *
 * @param {import('./types.js').MetricDef[]} defs
 * @returns {import('./types.js').MetricDef[]}
 * @throws {Error} naming the exact cycle, e.g. "a -> b -> a"
 */
export function orderMetrics(defs) {
  const list = Array.isArray(defs) ? defs : [];
  const byId = new Map();
  for (const def of list) {
    if (!def || !def.id) continue;
    byId.set(def.id, def);
  }

  const dependencyOf = (def) => {
    const den = def.denominator;
    if (den && den.kind === 'metric' && den.metric && byId.has(den.metric)) return den.metric;
    return null;
  };

  /** @type {Map<string,'visiting'|'done'>} */
  const state = new Map();
  const ordered = [];
  const stack = [];

  const visit = (id) => {
    const existing = state.get(id);
    if (existing === 'done') return;
    if (existing === 'visiting') {
      const from = stack.indexOf(id);
      const cycle = stack.slice(from).concat(id).join(' -> ');
      throw new Error(
        `metric denominator cycle: ${cycle}. A metric cannot be a fraction of itself, directly or through other metrics.`
      );
    }
    state.set(id, 'visiting');
    stack.push(id);
    const dep = dependencyOf(byId.get(id));
    if (dep) visit(dep);
    stack.pop();
    state.set(id, 'done');
    ordered.push(byId.get(id));
  };

  for (const def of list) {
    if (!def || !def.id) continue;
    visit(def.id);
  }
  return ordered;
}

export default normalize;
