/**
 * The status-by-subject section: the red / amber / green / grey calls a human
 * makes in a daily stand-up.
 *
 * This section has one job the ring cards do not: it must never be mistaken for
 * them. Everything above it on the page is arithmetic - a number divided by a
 * denominator, drawn as an arc. This is one person's read of a brand or a track,
 * spoken aloud. The two are not interchangeable, and a reader who takes a
 * judgement for a measurement will over-trust it, while a reader who takes a
 * measurement for a judgement will under-trust that.
 *
 * So the visual separation is deliberate and structural, not decorative:
 *
 *   - rows, not cards. No ring, no arc, no 0-100 count-up. Nothing here is
 *     normalised, because nothing here is a fraction of anything.
 *   - a solid colour swatch instead of a positional ring colour. Ring colours
 *     are positional and never health-coded; this colour IS the content, and
 *     making that obvious means it cannot share a vocabulary with the rings.
 *   - every row carries a name and a verbatim reason. A measurement needs
 *     neither. A judgement is worthless without both - it is the reason that
 *     makes it arguable, and arguable is the point.
 *   - the words "daily stand-up judgement" sit in the section header, and
 *     nowhere does the section use the word "metric".
 *
 * It is not a Performance Marketing section. The WBR already runs status by
 * track across the org, so this renders whatever subjects a department calls
 * colours on - brands, tracks, workstreams - with no change here.
 *
 * Red sorts first, longest-held first within red, because that is the order the
 * room should work through them in.
 */

import { deptLabel, esc, ownerName } from './util.js';

/** Four calls, and the one non-call. Grey is "not started", not a quiet amber. */
const COLOUR_WORD = { red: 'Red', amber: 'Amber', green: 'Green', grey: 'Not started' };

/** "5 days" / "1 day". */
const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;

function heldWord(subject) {
  const n = Number(subject.daysHeld) || 0;
  if (n <= 1) return 'called today';
  return `${dayWord(n)} running`;
}

function ageWord(subject) {
  if (subject.ageHours === null || subject.ageHours === undefined) return 'never called';
  if (subject.ageHours < 24) return 'called today';
  return `last called ${dayWord(Math.floor(subject.ageHours / 24))} ago`;
}

/**
 * The seven-day strip. A day nobody called is drawn as an empty slot, NOT as
 * the previous day's colour and NOT as grey - grey is a call somebody made, and
 * an absence of a call is not a call. A brand nobody has looked at since Tuesday
 * must not read as a steady week of green.
 */
function strip(trend) {
  const cells = (trend || []).map((d) => {
    const status = d && d.status;
    const title = status
      ? `${d.day}: ${COLOUR_WORD[status] || status}${d.setBy ? ` (${d.setBy})` : ''}`
      : `${d && d.day}: no call made`;
    return `<i class="rg-d rg-${esc(status || 'none')}" title="${esc(title)}"></i>`;
  }).join('');
  const called = (trend || []).filter((d) => d && d.status).length;
  const label = `${called} of ${(trend || []).length} days called`;
  return `<span class="rg-strip" role="img" aria-label="${esc(label)}">${cells}</span>`;
}

function subjectRow(subject) {
  const name = subject.subject || subject.brand || '';
  const classes = ['rgrow', `rgrow-${subject.status}`];
  if (subject.stale) classes.push('rgrow-stale');

  return (
    `<article class="${classes.join(' ')}">`
    + '<div class="rg-call">'
    + `<i class="rg-sw rg-${esc(subject.status)}" aria-hidden="true"></i>`
    + `<span class="rg-subject">${esc(name)}</span>`
    + `<span class="rg-colour">${esc(COLOUR_WORD[subject.status] || subject.status)}</span>`
    + '</div>'
    + `<div class="rg-held">${esc(heldWord(subject))}`
    + (subject.stale
      ? `<em class="rg-staletag">stale &middot; ${esc(ageWord(subject))}</em>`
      : '')
    + '</div>'
    + `<div class="rg-reason">${esc(subject.reason)}`
    + `<em class="rg-by">${esc(subject.setBy || 'unattributed')}</em></div>`
    + `<div class="rg-trend">${strip(subject.trend)}</div>`
    + '</article>'
  );
}

function deptBlock(dept, org) {
  const counts = dept.counts || {};
  const tally = ['red', 'amber', 'grey', 'green']
    .filter((c) => counts[c])
    .map((c) => `<span class="rg-tally"><i class="rg-sw rg-${c}"></i>${counts[c]} ${esc((COLOUR_WORD[c] || c).toLowerCase())}</span>`)
    .join('');

  const list = dept.subjects || dept.brands || [];

  return (
    '<section class="rag">'
    + '<div class="rg-head">'
    + `<span class="rg-dept">${esc(deptLabel(dept.dept, org))}</span>`
    + `<span class="rg-tallies">${tally}</span>`
    + `<span class="rg-owner">${esc(ownerName(dept.dept, org))} makes these calls</span>`
    + '</div>'
    + '<div class="rg-cols">'
    + '<span>Subject</span><span>Held</span><span>Why &middot; who called it</span><span>Last 7 days</span>'
    + '</div>'
    + list.map(subjectRow).join('')
    + '</section>'
  );
}

/**
 * ragSection(ragRollup, org) -> the whole section, or '' when nobody has made a
 * call. An empty heading would read as a mistake; the absence of any call at all
 * is reported by the rag_stale flags instead, where it has an owner's name on it.
 *
 * @param {ReturnType<import('../engine/rag.js').rollupRag>} ragRollup
 * @param {Object} org  org.json
 */
export function ragSection(ragRollup, org) {
  const rollup = ragRollup || {};
  const departments = (rollup.departments || [])
    .filter((d) => d && (d.subjects || d.brands || []).length);
  if (!departments.length) return '';

  const section = (((org && org.sections) || []).find((s) => s.kind === 'rag')) || {};
  const totalRed = departments.reduce((n, d) => n + (d.red || []).length, 0);
  const totalStale = departments.reduce((n, d) => n + (d.stale || []).length, 0);

  return (
    `<section id="${esc(section.id || 'rag')}">`
    + '<div class="sechead"><h2>'
    + `${esc(section.label || 'Status by subject')}`
    + '<span class="rg-kind">daily stand-up judgement</span></h2>'
    + `<p>${esc(section.blurb
      || 'A human call per brand or track, made in the daily stand-up. Not a computed '
      + 'metric - scale and objectives differ too much for one number to compare across them.')}`
    + (totalRed ? ` &mdash; ${totalRed} red` : '')
    + (totalStale ? `, ${totalStale} not called recently` : '')
    + '.</p></div>'
    + '<p class="rg-note">'
    + 'Everything else on this page is arithmetic. <b>This is somebody&rsquo;s opinion, '
    + 'with their name on it</b> &mdash; which is exactly why it carries a reason you can argue with, '
    + 'and why it goes stale if nobody repeats it. A day nobody called is shown blank, not carried forward.'
    + '</p>'
    + departments.map((d) => deptBlock(d, org)).join('')
    + '</section>'
  );
}

export default ragSection;
