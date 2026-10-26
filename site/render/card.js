/**
 * One ring card: header, rings + legend, optional tile strip, the human note.
 *
 * Health never touches ring colour. A card whose worst ring is crit or stale
 * gets an amber border and a small badge - that is the thing you scan a page
 * for - while the rings stay red/lime/cyan by position so the same slot is
 * comparable across every card.
 */

import { RING_COLORS } from '../engine/types.js';
import { ringSvg } from './rings.js';
import {
  esc, fmtUnit, byMetric, metricDefs, periodOf, resolveTemplate, worstHealth,
  FRESHNESS_LABEL, FRESHNESS_LOUD
} from './util.js';

/** Healths that earn the amber treatment. */
const FLAG_HEALTH = new Set(['crit', 'stale']);

const BADGE = {
  crit: 'OFF TARGET',
  stale: 'STALE DATA',
  missing: 'NO DATA',
  warn: 'BELOW PACE'
};

/** Severity order for picking one freshness label out of several rings. */
const FRESHNESS_RANK = { daily: 0, weekly: 1, unknown: 2, last_minute: 3, stale: 4 };

/**
 * The card's freshness is its WORST ring's freshness. A card is only as
 * current as the least current number on it.
 */
function worstFreshness(snaps) {
  let worst = null;
  for (const s of snaps) {
    const f = s && s.freshness;
    if (!f || !(f in FRESHNESS_RANK)) continue;
    if (worst === null || FRESHNESS_RANK[f] > FRESHNESS_RANK[worst]) worst = f;
  }
  return worst;
}

/**
 * A factual label, not a scold. The number may well be right; the signal is
 * only that the team is not using it to run the function day to day. `daily`
 * is the expected state, so it is rendered nearly invisible - it must not
 * compete for attention with anything that is actually wrong.
 */
function freshnessBadge(snaps, org) {
  const cfg = (org && org.freshness) || {};
  if (cfg.show_on_card === false) return '';
  const f = worstFreshness(snaps);
  if (!f) return '';
  const loud = FRESHNESS_LOUD.has(f);
  return `<span class="fresh${loud ? ' fresh-loud' : ''}" title="How this data was maintained">`
    + `${esc(FRESHNESS_LABEL[f] || f)}</span>`;
}

/** Legend row: colour dot, label, normalized count-up, the caption in ring colour. */
function legendRow(snap, def, color) {
  const label = def ? def.label : (snap ? snap.metricId : '');
  const to = snap && snap.normalized !== null && snap.normalized !== undefined
    ? Math.round(snap.normalized)
    : 0;
  const caption = snap && snap.caption ? snap.caption : 'no data';
  return (
    '<div class="lg">'
    + `<i style="background:${color};box-shadow:0 0 10px ${color}"></i>`
    + `<span class="lb">${esc(label)}</span>`
    + `<span class="vl"><b class="cnt" data-to="${to}">0</b><em>/100</em></span>`
    + `<span class="st" style="color:${color}">${caption}</span>`
    + '</div>'
  );
}

/** Tile value. `raw_of_target` is the "0/5" form the reference uses. */
function tileValue(tile, snap, def) {
  if (!snap || snap.raw === null || snap.raw === undefined) return '&mdash;';
  const unit = def ? def.unit : 'count';
  if (tile.format === 'raw_of_target') {
    const target = def && def.target !== null && def.target !== undefined ? def.target : null;
    return target === null
      ? fmtUnit(snap.raw, unit)
      : `${fmtUnit(snap.raw, unit)}/${fmtUnit(target, unit)}`;
  }
  return fmtUnit(snap.raw, unit);
}

function tiles(card, snaps, defs) {
  const list = card.tiles || [];
  if (!list.length) return '';
  const cells = list.slice(0, 3).map((tile, i) => {
    const snap = snaps.get(tile.metric);
    const def = defs.get(tile.metric);
    const color = RING_COLORS[i % RING_COLORS.length];
    return '<div class="tile">'
      + `<p class="tl">${esc(tile.label || '')}</p>`
      + `<p class="tv" style="color:${color}">${tileValue(tile, snap, def)}</p>`
      + `<p class="tu">${esc(tile.sublabel || '')}</p>`
      + '</div>';
  }).join('');
  return `<div class="tiles">${cells}</div>`;
}

/**
 * ringCard(card, snapshots, note, catalog) -> <article class="ring-card">
 *
 * `snapshots` is every Snapshot for the run (array, Map or object) - the card
 * needs more than its rings, because tiles point at other metrics. The period
 * for the subtitle template is read off the snapshots themselves, so a card is
 * always labelled with the period its numbers actually came from.
 */
export function ringCard(card, snapshots, note, catalog, org) {
  const snaps = byMetric(snapshots);
  const defs = metricDefs(catalog);

  const ringIds = (card.rings || []).slice(0, RING_COLORS.length);
  const ringSnaps = ringIds.map(id => snaps.get(id) || null);

  const anySnap = ringSnaps.find(Boolean) || [...snaps.values()][0];
  const period = anySnap
    ? periodOf(anySnap.periodStart, anySnap.periodEnd)
    : periodOf(null, null);

  const subtitle = resolveTemplate(card.subtitle, { period, snaps, defs });

  const health = worstHealth(ringSnaps);
  const flagged = FLAG_HEALTH.has(health);
  const badge = flagged
    ? `<span class="hbadge">${esc(BADGE[health] || health.toUpperCase())}</span>`
    : '';

  const legend = ringIds.map((id, i) =>
    legendRow(snaps.get(id) || null, defs.get(id) || null, RING_COLORS[i])
  ).join('');

  const noteText = note && note.text ? note.text : '';
  const noteHtml = noteText ? `<p class="note">${esc(noteText)}</p>` : '';

  return (
    `<article class="ring-card${flagged ? ' flag' : ''}" id="card-${esc(card.id)}">`
    + `<header><h3>${esc(card.title)}</h3>`
    + `<span>${badge}${freshnessBadge(ringSnaps, org)}${subtitle}</span></header>`
    + `<div class="body">${ringSvg(ringSnaps)}<div class="legend">${legend}</div></div>`
    + tiles(card, snaps, defs)
    + noteHtml
    + '</article>'
  );
}
