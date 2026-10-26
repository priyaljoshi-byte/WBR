/**
 * selections.js - "which numbers matter to you", applied to the catalogue.
 *
 * ===========================================================================
 * THE PROBLEM THIS SOLVES
 * ===========================================================================
 * config/catalog.json holds 53 metrics. No team needs 53. The founder's own
 * brief says it plainly: "Your three to five real numbers. Not everything
 * measurable. The ones you would check on a Wednesday to know whether the week
 * is working."
 *
 * The Metrics screen is where a department says which of theirs those are.
 * This module is what makes that choice actually reach the dashboard, rather
 * than being a preference nobody downstream reads.
 *
 * ===========================================================================
 * THE RULE THAT MATTERS MOST
 * ===========================================================================
 * A department that has made NO selection is left completely alone.
 *
 * The alternative - treating "no rows" as "nothing enabled" - would mean the
 * first department to open the Metrics screen silently deletes every other
 * department from the dashboard. Absence of a choice is not a choice, and this
 * file is careful about the difference in both directions:
 *
 *   no rows for a dept        -> every metric it owns renders, as before
 *   rows, some enabled        -> only the enabled ones render
 *   rows, ALL disabled        -> none of its metrics render, which IS a choice
 *                                somebody made and is reported in `stats`
 *
 * Pure. No fs, no process. Imported by bin/pulse.js and by node:test.
 */

/**
 * @typedef {Object} Selection
 * @property {boolean} enabled
 * @property {number|null} target
 * @property {string|null} owner
 * @property {'up'|'down'} direction
 */

/**
 * Accept either the nested file shape or the app's flat export, and return the
 * nested shape. Being liberal here means `data/selections.json` can be written
 * by hand, by bin/import-selections.js, or pasted straight out of the app's
 * export without anyone having to know which.
 *
 * @param {Object} raw
 * @returns {Record<string, Record<string, Selection>>}
 */
export function normalizeSelections(raw) {
  if (!raw || typeof raw !== 'object') return {};

  // The app's export envelope: {kind, tables: {pulse_selections: [...]}}
  const flat = raw.tables && Array.isArray(raw.tables.pulse_selections)
    ? raw.tables.pulse_selections
    : (Array.isArray(raw.selections) ? raw.selections : (Array.isArray(raw) ? raw : null));

  if (flat) {
    const out = {};
    for (const row of flat) {
      if (!row || typeof row !== 'object') continue;
      const dept = row.dept_id || row.dept;
      const metric = row.metric_id || row.metric;
      if (!dept || !metric) continue;
      if (!out[dept]) out[dept] = {};
      out[dept][metric] = cleanSelection(row);
    }
    return out;
  }

  // Already nested. `_comment` style keys are skipped so the file can carry notes.
  const out = {};
  for (const [dept, metrics] of Object.entries(raw)) {
    if (!dept || dept.startsWith('_')) continue;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) continue;
    out[dept] = {};
    for (const [metric, sel] of Object.entries(metrics)) {
      if (!metric || metric.startsWith('_')) continue;
      out[dept][metric] = cleanSelection(sel);
    }
  }
  return out;
}

function cleanSelection(sel) {
  const s = sel && typeof sel === 'object' ? sel : {};
  const target = s.target === undefined || s.target === null || s.target === ''
    ? null
    : Number(s.target);
  return {
    // Default true: a row that exists at all was written by somebody looking
    // at the screen, and `enabled` missing is far more likely to be an older
    // file than a deliberate "off".
    enabled: s.enabled !== false,
    target: Number.isFinite(target) ? target : null,
    owner: s.owner ? String(s.owner) : null,
    direction: s.direction === 'down' ? 'down' : 'up'
  };
}

/**
 * Apply a selection map to a catalogue.
 *
 * @param {Object} catalog               config/catalog.json
 * @param {Object} rawSelections         data/selections.json, any accepted shape
 * @returns {{catalog: Object, applied: boolean, stats: Object}}
 */
export function applySelections(catalog, rawSelections) {
  const selections = normalizeSelections(rawSelections);
  const depts = Object.keys(selections);

  const stats = {
    deptsWithChoices: depts.length,
    kept: 0,
    dropped: 0,
    targetsOverridden: 0,
    ownersSet: 0,
    cardsDropped: [],
    ringsDropped: 0,
    emptiedDepartments: []
  };

  if (!depts.length) {
    return { catalog, applied: false, stats };
  }

  const metrics = [];
  for (const def of (catalog.metrics || [])) {
    if (!def || !def.id) continue;
    const forDept = selections[def.dept];

    // Untouched department - every metric stands.
    if (!forDept) { metrics.push(def); stats.kept += 1; continue; }

    const sel = forDept[def.id];

    // A department that HAS chosen, for a metric it did not list. The screen
    // writes a row per metric it shows, so an absent row means the metric was
    // added to the catalogue after they chose. Keeping it would quietly put a
    // number back on a dashboard somebody curated; dropping it would hide a
    // metric nobody has been asked about. Keeping it is the lesser harm, and
    // the count is reported so it is not silent.
    if (!sel) { metrics.push(def); stats.kept += 1; continue; }

    if (!sel.enabled) { stats.dropped += 1; continue; }

    const next = { ...def };
    if (sel.target !== null) {
      next.target = sel.target;
      stats.targetsOverridden += 1;
    }
    if (sel.owner) {
      next.owner = sel.owner;
      stats.ownersSet += 1;
    }
    if (sel.direction) next.direction = sel.direction;

    metrics.push(next);
    stats.kept += 1;
  }

  const liveIds = new Set(metrics.map((m) => m.id));

  for (const dept of depts) {
    if (!metrics.some((m) => m.dept === dept)) stats.emptiedDepartments.push(dept);
  }

  // Cards follow their rings. A card whose rings were all deselected has
  // nothing to draw, so it is dropped rather than rendered as three empty
  // circles - which reads as broken data rather than as a deliberate choice.
  const cards = [];
  for (const card of (catalog.cards || [])) {
    if (!card) continue;
    const rings = (card.rings || []).filter((id) => liveIds.has(id));
    stats.ringsDropped += (card.rings || []).length - rings.length;
    if (!rings.length) { stats.cardsDropped.push(card.id); continue; }
    const tiles = (card.tiles || []).filter((t) => t && liveIds.has(t.metric));
    cards.push({ ...card, rings, tiles });
  }

  return {
    catalog: { ...catalog, metrics, cards },
    applied: true,
    stats
  };
}

/** One line for the CLI, so a run says out loud that it was filtered. */
export function describeSelections(stats) {
  if (!stats || !stats.deptsWithChoices) return 'No data/selections.json - every catalogue metric is in play.';
  const bits = [
    `${stats.kept} metrics kept, ${stats.dropped} not chosen`,
    `${stats.deptsWithChoices} department${stats.deptsWithChoices === 1 ? '' : 's'} have chosen`
  ];
  if (stats.targetsOverridden) bits.push(`${stats.targetsOverridden} targets from the app`);
  if (stats.ownersSet) bits.push(`${stats.ownersSet} owners named`);
  if (stats.cardsDropped.length) bits.push(`${stats.cardsDropped.length} cards dropped`);
  return bits.join(', ') + '.';
}

export default applySelections;
