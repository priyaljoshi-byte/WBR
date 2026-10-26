/**
 * rollup.js - segment metrics that add up to one total.
 *
 * Performance Marketing runs India and US. Rather than two departments, a metric
 * carries a `segment` and a `family`, and the members of a family roll up here.
 * The reason is arithmetic, not taste: two departments would have made "what did
 * we spend in total" a number somebody adds up by hand in a slide, which is a
 * number that is eventually wrong and that nobody can trace.
 *
 * The one rule: a rollup across mixed units is refused, not fudged. Adding
 * ₹4,00,000 of India spend to $12,400 of US spend produces a number that is not
 * money in any currency. If you want that total, convert first and say what rate
 * you used.
 */

/** Units that can be summed with each other. Everything else must match exactly. */
function unitOf(snapshot, def) {
  return (snapshot && snapshot.unit) || (def && def.unit) || null;
}

function indexDefs(defs) {
  const byId = new Map();
  for (const def of (Array.isArray(defs) ? defs : [])) {
    if (def && def.id) byId.set(def.id, def);
  }
  return byId;
}

/**
 * @typedef {Object} FamilyRollup
 * @property {string} family
 * @property {number|null} total          sum of the members' raws, null if nothing usable
 * @property {string|null} unit           the shared unit, null when mixed or unknown
 * @property {Array<{metricId:string, segment:string|null, raw:number|null, unit:string|null}>} members
 * @property {string[]} segments          the segments that contributed, in member order
 * @property {number} missing             members with no value - the total is short by this many
 * @property {boolean} complete           true when every member reported a number
 * @property {string[]} warnings
 */

/**
 * Sum one family of segment metrics.
 *
 * @param {import('./types.js').Snapshot[]} snapshots
 * @param {string} family                 e.g. "pm_spend"
 * @param {import('./types.js').MetricDef[]} [defs]
 *        Optional. Snapshots already carry `unit`/`family`/`segment`, so the two
 *        argument form works; pass defs when rolling up snapshots written before
 *        those fields existed.
 * @returns {FamilyRollup}
 */
export function rollupFamily(snapshots, family, defs) {
  const warnings = [];
  const byId = indexDefs(defs);
  const list = Array.isArray(snapshots) ? snapshots : Object.values(snapshots || {});

  const members = [];
  for (const snap of list) {
    if (!snap) continue;
    const def = byId.get(snap.metricId);
    const snapFamily = snap.family || (def && def.family) || null;
    if (snapFamily !== family) continue;
    members.push({
      metricId: snap.metricId,
      segment: snap.segment || (def && def.segment) || null,
      raw: snap.raw === undefined ? null : snap.raw,
      unit: unitOf(snap, def)
    });
  }

  if (!members.length) {
    warnings.push(`no metrics belong to family "${family}"`);
    return { family, total: null, unit: null, members, segments: [], missing: 0, complete: false, warnings };
  }

  const units = [...new Set(members.map((m) => m.unit).filter(Boolean))];
  if (units.length > 1) {
    warnings.push(
      `family "${family}" mixes units (${units.join(', ')}) - refusing to add them. ` +
      'Convert to a single currency and state the rate, or report the segments separately.'
    );
    return {
      family, total: null, unit: null, members,
      segments: members.map((m) => m.segment), missing: 0, complete: false, warnings
    };
  }

  const withValues = members.filter((m) => typeof m.raw === 'number' && Number.isFinite(m.raw));
  const missing = members.length - withValues.length;

  if (!withValues.length) {
    warnings.push(`every member of family "${family}" is missing a value - the total is unknown, not 0`);
    return {
      family, total: null, unit: units[0] || null, members,
      segments: members.map((m) => m.segment), missing, complete: false, warnings
    };
  }

  if (missing > 0) {
    // A partial total reads as a real total unless you say otherwise, so say it.
    const absent = members.filter((m) => !withValues.includes(m)).map((m) => m.segment || m.metricId);
    warnings.push(
      `family "${family}" is incomplete: ${absent.join(', ')} reported nothing, ` +
      'so this total is a floor rather than the actual figure.'
    );
  }

  return {
    family,
    total: withValues.reduce((sum, m) => sum + m.raw, 0),
    unit: units[0] || null,
    members,
    segments: members.map((m) => m.segment),
    missing,
    complete: missing === 0,
    warnings
  };
}

/**
 * Roll up every family present, keyed by family id.
 * @param {import('./types.js').Snapshot[]} snapshots
 * @param {import('./types.js').MetricDef[]} [defs]
 * @returns {Record<string, FamilyRollup>}
 */
export function rollupAllFamilies(snapshots, defs) {
  const byId = indexDefs(defs);
  const families = new Set();
  for (const snap of (Array.isArray(snapshots) ? snapshots : [])) {
    const def = byId.get(snap && snap.metricId);
    const family = (snap && snap.family) || (def && def.family);
    if (family) families.add(family);
  }
  const out = {};
  for (const family of [...families].sort()) out[family] = rollupFamily(snapshots, family, defs);
  return out;
}

export default rollupFamily;
