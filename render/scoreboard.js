/**
 * The scoreboard. Serves the founder's second goal: accountability against
 * targets, answered BEFORE anyone starts narrating.
 *
 * One row per line of business, five rows, ten seconds. Everything here is
 * deliberately coarse - the question this answers is "are we hitting target or
 * not", and any extra detail makes that question take longer to answer. Detail
 * lives in the ring cards below, which are read before the meeting rather than
 * presented in it.
 *
 * Row shape, from the engine's deptScoreboard():
 *   { deptId, onTarget, totalJudged,
 *     byHealth: {good,warn,crit,stale,missing,untracked},
 *     worstMetric: {id,label,health}, netDelta, freshness }
 */

import { deptLabel, esc, ownerTeamLabel, FRESHNESS_LABEL, FRESHNESS_LOUD } from './util.js';

/** Bar segments, worst last so the eye lands on trouble at the right-hand end. */
const BAR_ORDER = ['good', 'warn', 'crit', 'stale', 'missing', 'untracked'];

const HEALTH_WORD = {
  good: 'on target',
  warn: 'below pace',
  crit: 'off target',
  stale: 'stale',
  missing: 'no data',
  untracked: 'no target set'
};

/** The compact health bar: proportional segments, no numbers, no legend. */
function healthBar(byHealth = {}) {
  const total = BAR_ORDER.reduce((n, k) => n + (byHealth[k] || 0), 0);
  if (!total) {
    return '<div class="sbar sbar-empty" role="img" aria-label="nothing judged yet"></div>';
  }
  const segs = BAR_ORDER
    .filter(k => byHealth[k])
    .map(k => `<i class="sg sg-${k}" style="flex:${byHealth[k]}" title="${byHealth[k]} ${HEALTH_WORD[k]}"></i>`)
    .join('');
  const label = BAR_ORDER.filter(k => byHealth[k])
    .map(k => `${byHealth[k]} ${HEALTH_WORD[k]}`).join(', ');
  return `<div class="sbar" role="img" aria-label="${esc(label)}">${segs}</div>`;
}

/**
 * Week over week, as a direction rather than a figure. netDelta is the sum of
 * normalized movement across the department's metrics; its sign is the part
 * anyone acts on.
 */
function direction(netDelta) {
  if (netDelta === null || netDelta === undefined || Number.isNaN(netDelta)) {
    return '<span class="sdelta sdelta-none" title="no prior period to compare">&middot;&middot;&middot;</span>';
  }
  const n = Math.round(netDelta);
  if (n === 0) return '<span class="sdelta sdelta-flat" title="level on last week">&rarr; level</span>';
  const up = n > 0;
  return `<span class="sdelta ${up ? 'sdelta-up' : 'sdelta-down'}">`
    + `${up ? '&uarr;' : '&darr;'} ${Math.abs(n)}</span>`;
}

function freshnessCell(freshness) {
  if (!freshness) return '';
  const loud = FRESHNESS_LOUD.has(freshness);
  return `<span class="fresh${loud ? ' fresh-loud' : ''}">${esc(FRESHNESS_LABEL[freshness] || freshness)}</span>`;
}

/** A department is in trouble if anything it owns is crit, stale or missing. */
function rowIsFlagged(row) {
  const h = row.byHealth || {};
  return Boolean(h.crit || h.stale || h.missing);
}

function scoreRow(row, org) {
  const judged = row.totalJudged || 0;
  const on = row.onTarget || 0;
  const worst = row.worstMetric;

  const fraction = judged
    ? `<b>${on}</b><em>of ${judged} on target</em>`
    : '<b>&mdash;</b><em>nothing judged yet</em>';

  const worstCell = worst && worst.label
    ? `<span class="sworst-h sw-${esc(worst.health || 'untracked')}">${esc(HEALTH_WORD[worst.health] || worst.health || '')}</span>`
      + `<span class="sworst-m">${esc(worst.label)}</span>`
    : '<span class="sworst-m sworst-none">no metric judged</span>';

  return (
    `<article class="srow${rowIsFlagged(row) ? ' srow-flag' : ''}">`
    + '<div class="sdept">'
    + `<h3>${esc(deptLabel(row.deptId, org))}</h3>`
    // The TRIO, not one name. This row is about a line of business and three
    // people own it; the single accountable name appears on the flags below,
    // where there is something to do. Engine rows already carry the sentence;
    // a hand-built row falls back to org.json.
    + `<p class="sowner">${esc(row.owner || ownerTeamLabel(row.deptId, org))}</p>`
    + '</div>'
    + `<div class="sfrac">${fraction}</div>`
    + `<div class="scell">${healthBar(row.byHealth)}</div>`
    + `<div class="sworst">${worstCell}</div>`
    + `<div class="sdir">${direction(row.netDelta)}${freshnessCell(row.freshness)}</div>`
    + '</article>'
  );
}

/**
 * scoreboardSection(scoreboardRows, org) -> the section that opens the page.
 *
 * Rows are rendered in org.json department order, so the scoreboard reads the
 * same way every week and the eye learns where to look.
 */
export function scoreboardSection(scoreboardRows, org) {
  const rows = scoreboardRows || [];
  if (!rows.length) return '';

  const order = ((org && org.departments) || []).map(d => d.id);
  const sorted = rows.slice().sort((a, b) => {
    const ai = order.indexOf(a.deptId);
    const bi = order.indexOf(b.deptId);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const section = (((org && org.sections) || []).find(s => s.kind === 'scoreboard')) || {};
  const totalOn = sorted.reduce((n, r) => n + (r.onTarget || 0), 0);
  const totalJudged = sorted.reduce((n, r) => n + (r.totalJudged || 0), 0);

  return (
    `<section id="${esc(section.id || 'scoreboard')}">`
    + '<div class="sechead"><h2><span class="lvln">01</span>'
    + `${esc(section.label || 'Scoreboard')}</h2>`
    + `<p>${esc(section.blurb || 'Against target, by line of business. Two minutes.')}</p></div>`
    + '<section class="score">'
    + '<div class="shead">'
    + '<span>Line of business</span><span>Against target</span><span>Spread</span>'
    + '<span>Worst metric</span><span>Week on week</span>'
    + '</div>'
    + sorted.map(r => scoreRow(r, org)).join('')
    + '<div class="stot">'
    + `<span>${totalJudged ? `${totalOn} of ${totalJudged}` : '&mdash;'}</span>`
    // "all five lines of business" is wrong in a room that reads two of them,
    // and a line that is wrong in four rooms out of four is worse than a vague
    // one. Count what is on screen.
    + ` metrics on target across ${sorted.length === 1 ? 'this line of business'
      : `${sorted.length === 5 ? 'all five' : `these ${sorted.length}`} lines of business`}.`
    + (totalJudged === 0
      ? ' Nothing is judged yet, because no targets have been set.'
      : '')
    + '</div>'
    + '</section>'
    + '</section>'
  );
}
