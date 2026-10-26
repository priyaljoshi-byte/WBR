/**
 * Blockers and dependencies. Serves the founder's first goal: one team, full
 * visibility, with cross-functional dependencies resolved in the room instead
 * of chased alone afterwards.
 *
 * A blocker is a first-class object, not a bullet in someone's update, and the
 * thing it carries that a bullet cannot is a PAIR: who is blocked and who they
 * need it from, both named, side by side. That pairing is the content - the
 * layout puts the two names on one line with the ask between them, because the
 * conversation the room needs to have is between those two people.
 *
 * Age is the second thing. A blocker in its third week is a different
 * conversation from a new one, so age is rendered as weight and colour, not
 * only as a number: you should be able to see the old ones without reading.
 *
 * Blocker shape, from the transcript layer:
 *   { id, title, raisedBy, needsFrom, what, impact, metricIds,
 *     ageWeeks, status, owner, dueDate, resolution }
 */

import { TERMINAL_BLOCKER_STATUSES } from '../engine/types.js';
import {
  DATE_NEEDED, OWNER_NEEDED, deptLabel, deptShort, esc, longDate, ownerName
} from './util.js';

const RESOLVED = new Set(TERMINAL_BLOCKER_STATUSES);

const RESOLUTION_WORD = {
  resolved_in_room: 'resolved in the room',
  owner_assigned: 'owner assigned',
  escalated: 'escalated',
  dropped: 'dropped',
  carried: 'carried'
};

/**
 * Age band drives the visual weight. ageWeeks is 1 in the week a blocker was
 * raised, so 1 is new. The escalation threshold comes from org.json, so the
 * page and the policy cannot drift apart.
 */
function ageBand(ageWeeks, escalateAfter) {
  const w = Number(ageWeeks) || 0;
  if (w >= escalateAfter) return 'old';
  if (w > 1) return 'ageing';
  return 'new';
}

function ageChip(ageWeeks, band) {
  const w = Number(ageWeeks) || 0;
  const text = w <= 1 ? 'new this week' : `${w} weeks old`;
  // The dots are the pre-attentive part: one per week, capped so a very old
  // blocker does not draw a ruler across the card.
  const pips = Array.from({ length: Math.min(Math.max(Math.round(w), 1), 6) },
    () => '<i></i>').join('');
  return `<span class="age age-${band}"><span class="pips">${pips}</span>${esc(text)}</span>`;
}

/** A name for either end of the pair: an explicit person, else the dept owner. */
function partyName(party, org) {
  if (!party) return OWNER_NEEDED;
  if (typeof party === 'string') {
    // Either a department id or a person's name.
    const asDept = ((org && org.departments) || []).find(d => d.id === party);
    return asDept ? ownerName(party, org) : party;
  }
  if (party.name) return party.name;
  if (party.dept) return ownerName(party.dept, org);
  return OWNER_NEEDED;
}

function partyTeam(party, org) {
  if (!party) return '';
  if (typeof party === 'string') {
    const asDept = ((org && org.departments) || []).find(d => d.id === party);
    return asDept ? deptShort(party, org) : '';
  }
  return party.dept ? deptShort(party.dept, org) : '';
}

function party(party_, org, role) {
  const name = partyName(party_, org);
  const team = partyTeam(party_, org);
  return (
    `<span class="party party-${role}">`
    + `<span class="pname">${esc(name)}</span>`
    + (team ? `<span class="pteam">${esc(team)}</span>` : '')
    + '</span>'
  );
}

function metricList(metricIds, catalog) {
  const ids = metricIds || [];
  if (!ids.length) return '';
  const labels = new Map(((catalog && catalog.metrics) || []).map(m => [m.id, m.label]));
  return '<p class="bmetrics"><span class="k">Holding back</span> '
    + ids.map(id => `<em>${esc(labels.get(id) || id)}</em>`).join(', ')
    + '</p>';
}

/**
 * THE FOREIGN BANNER.
 *
 * A blocker carried into the room of the team that can CLEAR it, by a team that
 * was not present when it was raised. There is no fifth leadership meeting, so
 * without this the two parties never see the same card and the dependency is
 * chased by email until somebody gives up.
 *
 * It says three things, in this order, because that is the order a reader needs
 * them: this is not yours to chase, here is who is waiting, here is the room and
 * the day it was raised in so you know where to answer it.
 */
function foreignBanner(b, org) {
  const who = b.raisedByName || partyName(b.raisedBy, org);
  const room = b.fromMeetingName || 'another review';
  const day = b.fromMeetingDay
    ? ` (${String(b.fromMeetingDay).charAt(0).toUpperCase()}${String(b.fromMeetingDay).slice(1)})`
    : '';
  return (
    '<div class="bforeign">'
    + `<span class="bforeign-tag">Raised in ${esc(room)}${esc(day)}</span>`
    + `<p class="bforeign-who"><b>${esc(who)}</b> raised this for `
    + `${esc(deptLabel(b.raisedBy, org))}. Nobody from this room was there, and nobody `
    + 'from that room is here &mdash; so it is shown in both. This one is yours to '
    + 'answer, not to chase.</p>'
    + '</div>'
  );
}

function blockerCard(b, org, escalateAfter, catalog) {
  const band = ageBand(b.ageWeeks, escalateAfter);
  const cross = !!b.crossMeeting;
  // Cross-meeting blockers are escalated on sight. Age is the wrong test when
  // the two parties were never in the same room, so the card must not wait for
  // the two-week band to look serious either.
  const escalated = band === 'old' || b.status === 'escalated' || cross;
  const resolved = RESOLVED.has(b.status);
  const foreign = !!b.foreign;

  const classes = ['card', 'blocker', `blocker-${band}`];
  // Escalated blockers borrow the amber flag treatment. New ones deliberately
  // do not, so that escalation still means something when you see it.
  if (escalated && !resolved) classes.push('flag');
  if (resolved) classes.push('blocker-done');
  if (cross) classes.push('blocker-cross');
  // A foreign card must not be mistakable for one this room raised: the ask is
  // the opposite direction. Different class, different banner, different verb.
  if (foreign) classes.push('blocker-foreign');

  const tag = resolved ? ''
    : foreign ? ''
      : cross && band !== 'old'
        ? '<span class="flagtag">Escalated &middot; no room holds both teams</span>'
        : escalated
          ? `<span class="flagtag">Escalated &middot; past the ${escalateAfter}-week line</span>`
          : '';

  return (
    `<article class="${classes.join(' ')}">`
    + (foreign ? foreignBanner(b, org) : '')
    + '<div class="btop">'
    + tag
    + ageChip(b.ageWeeks, band)
    + '</div>'
    + `<h3>${esc(b.title)}</h3>`

    // The pair. This is the line the room is for.
    + '<div class="pair">'
    + party(b.raisedBy, org, 'from')
    + '<span class="parrow" aria-label="needs it from">needs from</span>'
    + party(b.needsFrom, org, 'to')
    + '</div>'

    + (b.what ? `<p class="bask">${esc(b.what)}</p>` : '')
    + (b.impact ? `<p class="bimpact">${esc(b.impact)}</p>` : '')
    + metricList(b.metricIds, catalog)
    + '<p class="bmeta">'
    + `<span>${esc(b.owner || OWNER_NEEDED)}</span>`
    + `<span>by ${b.dueDate ? esc(longDate(b.dueDate)) : DATE_NEEDED}</span>`
    + `<span class="bstatus">${esc(RESOLUTION_WORD[b.resolution] || b.status || 'open')}</span>`
    + '</p>'
    + '</article>'
  );
}

/**
 * Who is waiting on whom, across the five teams. Built from the blockers
 * themselves when no explicit matrix is supplied, so the summary can never
 * disagree with the cards above it.
 */
function dependencySummary(blockers, matrix, org) {
  /** @type {Array<{from:string,fromLabel:string,to:string,toLabel:string,count:number,escalated?:boolean}>} */
  let edges = [];
  /** @type {Record<string, number>} */
  let blocking = {};

  if (matrix && Array.isArray(matrix.edges)) {
    // transcript/dependencies.js dependencyMatrix(): labels travel with the ids,
    // so we print its words rather than joining back to org.json ourselves.
    edges = matrix.edges;
    blocking = (matrix.counts && matrix.counts.blocking) || {};
  } else {
    // No matrix supplied: derive the same picture from the blockers on screen,
    // so the summary can never disagree with the cards above it.
    const tally = new Map();
    const crossKeys = new Set();
    for (const b of blockers) {
      const from = b.raisedBy;
      const to = b.needsFrom;
      if (!from || !to || from === to) continue;
      const key = `${from}>${to}`;
      tally.set(key, (tally.get(key) || 0) + 1);
      if (b.crossMeeting) crossKeys.add(key);
      blocking[to] = (blocking[to] || 0) + 1;
    }
    edges = [...tally.entries()].map(([key, count]) => {
      const [from, to] = key.split('>');
      return {
        from, to, count,
        crossMeeting: crossKeys.has(key),
        fromLabel: deptLabel(from, org),
        toLabel: deptLabel(to, org)
      };
    });
  }

  if (!edges.length) return '';

  const lines = edges.slice().sort((a, b) => b.count - a.count).map(e => (
    `<li${e.escalated ? ' class="dep-esc"' : ''}>`
    + `<span class="dep-from">${esc(e.fromLabel || deptLabel(e.from, org))}</span>`
    // An edge with no room holding both teams is not a chasing problem, it is a
    // structural one, and saying "waiting on" without that is misleading.
    + `<span class="dep-arrow${e.crossMeeting ? ' dep-cross' : ''}">`
    + (e.crossMeeting ? 'never meets' : 'waiting on') + '</span>'
    + `<span class="dep-to">${esc(e.toLabel || deptLabel(e.to, org))}</span>`
    + `<span class="dep-n">${e.count}</span>`
    + '</li>'
  )).join('');

  const worst = Object.entries(blocking).sort((a, b) => b[1] - a[1])[0];
  const external = (matrix && matrix.external) || [];

  return (
    '<article class="card depsum">'
    + '<h3>Who is waiting on whom</h3>'
    + `<ul class="deplist">${lines}</ul>`
    + (worst
      ? `<p class="depworst"><b>${esc(deptLabel(worst[0], org))}</b> is blocking the most `
        + `&mdash; ${worst[1]} open ${worst[1] === 1 ? 'dependency' : 'dependencies'} across the other teams. `
        + 'That is a capacity or priority question, not a chasing question.</p>'
      : '')
    + (external.length
      ? `<p class="depworst">${external.length} ask${external.length === 1 ? '' : 's'} `
        + 'point outside the five lines of business.</p>'
      : '')
    + '</article>'
  );
}

/**
 * blockersSection(blockers, dependencyMatrix, org, catalog) -> the section.
 * Oldest first: the thing that has been stuck longest is the thing the room
 * should open with.
 */
export function blockersSection(blockers, dependencyMatrix, org, catalog) {
  const list = (blockers || []).filter(b => b && !RESOLVED.has(b.status));
  const cfg = (org && org.blockers) || {};
  const escalateAfter = Number(cfg.escalate_after_weeks) || 2;

  const section = (((org && org.sections) || []).find(s => s.kind === 'blockers')) || {};

  // The summary is built from what THIS room raised. A blocker carried in from
  // another room is not this team waiting on somebody - it is somebody waiting
  // on them - and folding it into "who is waiting on whom" would reverse the
  // arrow and make the busiest team look like the most blocked one.
  const mine = list.filter(b => !b.foreign);
  const carried = list.filter(b => b.foreign);
  const summary = dependencySummary(mine, dependencyMatrix, org);

  if (!list.length && !summary) return '';

  const byAge = (a, b) => (Number(b.ageWeeks) || 0) - (Number(a.ageWeeks) || 0);
  const sorted = mine.slice().sort(byAge);
  const sortedForeign = carried.slice().sort(byAge);

  const escalated = sorted.filter(b =>
    ageBand(b.ageWeeks, escalateAfter) === 'old' || b.status === 'escalated' || b.crossMeeting
  ).length;

  // Foreign blockers get their own heading rather than being mixed into the
  // grid. Mixed in, they read as more of this room's backlog; separated, they
  // read as what they are - a short list of answers only this room can give.
  const foreignBlock = sortedForeign.length
    ? '<div class="sechead sechead-sub"><h2>Raised in another review, waiting on this one</h2>'
      + `<p>${sortedForeign.length} ${sortedForeign.length === 1 ? 'team is' : 'teams are'} `
      + 'blocked on something only this room can clear, and were not in the room where '
      + 'they raised it. There is no meeting where both sides sit, so these are shown in '
      + 'both and escalated on sight rather than after two weeks.</p></div>'
      + '<section class="grid">'
      + sortedForeign.map(b => blockerCard(b, org, escalateAfter, catalog)).join('')
      + '</section>'
    : '';

  return (
    `<section id="${esc(section.id || 'blockers')}">`
    + '<div class="sechead"><h2>'
    + `${esc(section.label || 'Blockers and dependencies')}</h2>`
    + `<p>${esc(section.blurb || 'Who is waiting on whom. This is the part the room is for.')}`
    + (escalated ? ` &mdash; ${escalated} escalated.` : '')
    + '</p></div>'
    + '<section class="grid">'
    + sorted.map(b => blockerCard(b, org, escalateAfter, catalog)).join('')
    + summary
    + '</section>'
    + foreignBlock
    + '</section>'
  );
}
