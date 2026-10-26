/**
 * dependencies.js - who is waiting on whom, across the five lines of business.
 *
 * A blocker on its own tells one team's story. The matrix tells the company's.
 * It answers the question nobody can answer from five separate updates: which team
 * is everyone else waiting on, and which team is waiting on everyone else.
 *
 * Those two answers usually point at the same two problems every week, and they are
 * different problems. The team everyone waits on has a capacity or priority problem
 * that no amount of chasing fixes. The team waiting on everyone has a sequencing
 * problem - they committed to work that depends on four other teams landing first.
 * Neither is visible from inside a single department's slide.
 *
 * Output shape is built to be rendered directly. Labels travel with ids, because
 * the renderer should not have to join back to org.json to print a row.
 */

import { TERMINAL_BLOCKER_STATUSES } from '../engine/types.js';
import { ownerLead, ownerTeam } from '../engine/owners.js';
import {
  loadMeetings, meetingsForParty, resolveCrossMeeting, routeBlockersToMeeting
} from '../engine/meetings.js';
import { defaultOrg } from './schema.js';

/** Blockers that still represent someone waiting. Resolved and dropped do not. */
export function liveBlockers(blockers = []) {
  return blockers.filter((b) => b && !TERMINAL_BLOCKER_STATUSES.includes(b.status));
}

function departmentsOf(org) {
  return (org.departments || []).map((d) => ({
    id: d.id,
    label: d.label,
    short: d.short || d.label
  }));
}

function labelFor(departments, id) {
  if (!id) return '[OWNER NEEDED]';
  const hit = departments.find((d) => d.id === id);
  return hit ? hit.label : id; // needsFrom may be a person's name
}

/** ONE name for the far end of a dependency - somebody to actually ask. */
function ownerFor(org, id) {
  const lead = ownerLead(id, org);
  if (lead) return lead;
  const team = ownerTeam(id, org);
  return team.length ? team[0] : null;
}

/**
 * The full picture of cross-team dependency for one week.
 *
 * @param {Array<Object>} blockers  Blocker[]
 * @param {Object} [org]            org.json
 * @returns {Object} renderable matrix
 *
 * Shape:
 *   departments  [{id, label, short}]           row and column order
 *   rows         [{dept, label, short, waitingOn: [{dept,label,count,blockerIds,oldestWeeks}], total}]
 *   edges        [{from, fromLabel, to, toLabel, count, blockerIds, oldestWeeks, escalated}]
 *   counts       {blocking: {deptId: n}, blocked: {deptId: n}}
 *   external     [{needsFrom, label, count, blockerIds}]   ends that are not a department
 *   unassigned   [{blockerId, title, raisedBy, label}]     blockers with no other end
 *   totals       {live, escalated, unassigned}
 */
export function dependencyMatrix(blockers = [], org = defaultOrg(), opts = {}) {
  const departments = departmentsOf(org);
  const live = liveBlockers(blockers);
  // When the meeting schedule is known, every edge also answers "is there a
  // room where these two are both present?" An edge with no such room is not a
  // chasing problem, it is a structural one, and it reads differently.
  const meetings = asMeetings(opts.meetings);

  const deptIds = new Set(departments.map((d) => d.id));

  // edgeKey -> aggregate
  const edgeMap = new Map();
  const externalMap = new Map();
  const unassigned = [];

  const blocking = Object.fromEntries(departments.map((d) => [d.id, 0]));
  const blocked = Object.fromEntries(departments.map((d) => [d.id, 0]));

  for (const b of live) {
    const from = b.raisedBy;
    const to = b.needsFrom;

    if (deptIds.has(from)) blocked[from] += 1;

    if (!to) {
      unassigned.push({
        blockerId: b.id,
        title: b.title,
        raisedBy: from,
        label: labelFor(departments, from),
        ageWeeks: b.ageWeeks ?? 1
      });
      continue;
    }

    if (!deptIds.has(to)) {
      // The other end is a named person rather than a line of business. Still a
      // real dependency, just not a cell in the matrix.
      const prev = externalMap.get(to) || { needsFrom: to, label: to, count: 0, blockerIds: [] };
      prev.count += 1;
      prev.blockerIds.push(b.id);
      externalMap.set(to, prev);
      continue;
    }

    blocking[to] += 1;

    const key = `${from}->${to}`;
    const prev = edgeMap.get(key) || {
      from,
      fromLabel: labelFor(departments, from),
      to,
      toLabel: labelFor(departments, to),
      toOwner: ownerFor(org, to),
      count: 0,
      blockerIds: [],
      titles: [],
      oldestWeeks: 0,
      escalated: false,
      crossMeeting: false
    };
    prev.count += 1;
    prev.blockerIds.push(b.id);
    prev.titles.push(b.title);
    prev.oldestWeeks = Math.max(prev.oldestWeeks, b.ageWeeks ?? 1);
    if (b.status === 'escalated') prev.escalated = true;
    if (meetings.length && resolveCrossMeeting(b, meetings, opts.catalog).cross) {
      prev.crossMeeting = true;
    }
    edgeMap.set(key, prev);
  }

  const edges = [...edgeMap.values()].sort(
    (a, b) => b.count - a.count || b.oldestWeeks - a.oldestWeeks
  );

  const rows = departments.map((d) => {
    const waitingOn = edges
      .filter((e) => e.from === d.id)
      .map((e) => ({
        dept: e.to,
        label: e.toLabel,
        owner: e.toOwner,
        count: e.count,
        blockerIds: e.blockerIds,
        oldestWeeks: e.oldestWeeks,
        escalated: e.escalated
      }));
    return {
      dept: d.id,
      label: d.label,
      short: d.short,
      waitingOn,
      total: waitingOn.reduce((n, w) => n + w.count, 0),
      blockingOthers: blocking[d.id] || 0
    };
  });

  // Dense grid for a renderer that wants a literal table: grid[from][to] = count.
  const grid = {};
  for (const d of departments) {
    grid[d.id] = Object.fromEntries(departments.map((x) => [x.id, 0]));
  }
  for (const e of edges) grid[e.from][e.to] = e.count;

  return {
    departments,
    rows,
    edges,
    grid,
    counts: { blocking, blocked },
    external: [...externalMap.values()].sort((a, b) => b.count - a.count),
    unassigned,
    totals: {
      live: live.length,
      escalated: live.filter((b) => b.status === 'escalated').length,
      unassigned: unassigned.length,
      // How many of these have no room where both parties sit. 0 when no
      // meeting schedule was supplied, which is honest: we cannot tell.
      crossMeeting: meetings.length
        ? live.filter((b) => resolveCrossMeeting(b, meetings, opts.catalog).cross).length
        : 0
    }
  };
}

/**
 * The team the most other teams are waiting on.
 * Self-blocks are excluded: a team waiting on itself is a planning problem, not a
 * dependency, and counting it would let a team top this list without ever having
 * been asked for anything.
 */
export function mostBlocking(blockers = [], org = defaultOrg()) {
  const departments = departmentsOf(org);
  const live = liveBlockers(blockers).filter((b) => b.needsFrom && b.needsFrom !== b.raisedBy);

  const tally = new Map();
  for (const b of live) {
    const prev = tally.get(b.needsFrom) || {
      dept: b.needsFrom,
      label: labelFor(departments, b.needsFrom),
      owner: ownerFor(org, b.needsFrom),
      count: 0,
      waitingTeams: new Set(),
      blockerIds: [],
      oldestWeeks: 0
    };
    prev.count += 1;
    prev.waitingTeams.add(b.raisedBy);
    prev.blockerIds.push(b.id);
    prev.oldestWeeks = Math.max(prev.oldestWeeks, b.ageWeeks ?? 1);
    tally.set(b.needsFrom, prev);
  }

  const ranked = [...tally.values()]
    .map((r) => ({
      ...r,
      waitingTeams: [...r.waitingTeams],
      waitingTeamLabels: [...r.waitingTeams].map((id) => labelFor(departments, id))
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.waitingTeams.length - a.waitingTeams.length ||
        b.oldestWeeks - a.oldestWeeks ||
        String(a.dept).localeCompare(String(b.dept))
    );

  return { top: ranked[0] || null, ranked };
}

/** The team waiting on the most other teams. */
export function mostBlocked(blockers = [], org = defaultOrg()) {
  const departments = departmentsOf(org);
  const live = liveBlockers(blockers);

  const tally = new Map();
  for (const b of live) {
    if (!b.raisedBy) continue;
    const prev = tally.get(b.raisedBy) || {
      dept: b.raisedBy,
      label: labelFor(departments, b.raisedBy),
      owner: ownerFor(org, b.raisedBy),
      count: 0,
      waitingOn: new Set(),
      blockerIds: [],
      oldestWeeks: 0
    };
    prev.count += 1;
    if (b.needsFrom) prev.waitingOn.add(b.needsFrom);
    prev.blockerIds.push(b.id);
    prev.oldestWeeks = Math.max(prev.oldestWeeks, b.ageWeeks ?? 1);
    tally.set(b.raisedBy, prev);
  }

  const ranked = [...tally.values()]
    .map((r) => ({
      ...r,
      waitingOn: [...r.waitingOn],
      waitingOnLabels: [...r.waitingOn].map((id) => labelFor(departments, id))
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.waitingOn.length - a.waitingOn.length ||
        b.oldestWeeks - a.oldestWeeks ||
        String(a.dept).localeCompare(String(b.dept))
    );

  return { top: ranked[0] || null, ranked };
}

/* ------------------------------------------------------------------------ *
 * CROSS-MEETING ROUTING
 *
 * There is no fifth leadership meeting. Nobody is in all four rooms: India and
 * US never meet, Hiring never meets the charters asking it for headcount,
 * Sloosh sits alone on Thursday. So a dependency between two of these lines has
 * NO room where both parties are present - which is precisely the "left chasing
 * things on their own" problem the whole blocker object exists to fix.
 *
 * Covering it is two rules, and neither is optional:
 *
 *   BOTH ROOMS   the blocker appears in the raiser's room as normal, AND in the
 *                needsFrom team's room marked as raised elsewhere. The team that
 *                can unblock it sees it in their own room, without anyone
 *                forwarding anything or remembering to.
 *
 *   IMMEDIATELY  it escalates on its FIRST appearance, not after two weeks. Age
 *                is the wrong test when the two parties were never in the same
 *                room: two weeks of a US Sales blocker raised at the US charter,
 *                where Sloosh is not present, is two weeks of nothing happening
 *                and everybody feeling diligent.
 * ------------------------------------------------------------------------ */

/**
 * Tag every blocker with whether its two ends sit in different rooms, and which.
 * Pure: returns copies, so the stored blockers.json is never mutated by a
 * question about the meeting schedule.
 *
 * @param {Array<Object>} blockers
 * @param {Object} [opts]
 * @param {Object|Array} [opts.meetings]  config/meetings.json, or loadMeetings() output
 * @param {Object} [opts.catalog]         catalog.json, to narrow a bare department
 *                                        to one segment via the blocker's metrics
 * @returns {Array<Object>} blockers + {crossMeeting, raisedInMeetings, needsInMeetings}
 */
export function annotateCrossMeeting(blockers = [], opts = {}) {
  const meetings = asMeetings(opts.meetings);
  if (!meetings.length) return (blockers || []).map((b) => ({ ...b, crossMeeting: false }));

  return (blockers || []).map((b) => {
    const r = resolveCrossMeeting(b, meetings, opts.catalog);
    return {
      ...b,
      crossMeeting: r.cross,
      raisedInMeetings: r.raisedIn.map((m) => m.id),
      needsInMeetings: r.needsIn.map((m) => m.id)
    };
  });
}

/** Just the ones with nowhere to be resolved. Live blockers only. */
export function crossMeetingBlockers(blockers = [], opts = {}) {
  return annotateCrossMeeting(liveBlockers(blockers), opts).filter((b) => b.crossMeeting);
}

/**
 * The blockers ONE room should see - which is not the same as the blockers that
 * room raised.
 *
 *   local    raisedBy sits in this meeting. Rendered as normal.
 *   foreign  needsFrom sits in this meeting but the raiser does not. These are
 *            the ones that would otherwise be chased by email forever: the team
 *            that can clear it was not in the room where it was raised. Carried
 *            here, marked, and named with the meeting and the person it came
 *            from, because "somebody is waiting on you" is only actionable if
 *            you can see who and where.
 *
 * A blocker is never both: if the two ends share this room it is local, full
 * stop, and showing it twice would turn one conversation into two.
 *
 * @returns {Array<Object>} local blockers, then foreign ones, each foreign one
 *          carrying {foreign:true, fromMeetingId, fromMeetingName, fromMeetingDay,
 *          raisedByName}
 */
export function blockersForMeeting(blockers = [], meetingId, opts = {}) {
  const org = opts.org || defaultOrg();
  return routeBlockersToMeeting(liveBlockers(blockers), meetingId, {
    ...opts,
    // The person behind a department id. The engine deliberately does not know
    // about org.json owners, so the name resolver is injected from here.
    nameFor: (dept) => ownerFor(org, dept)
  });
}

/** Accepts the whole meetings.json, a bare array, or already-loaded meetings. */
function asMeetings(meetings) {
  return loadMeetings(meetings);
}

/**
 * Which rooms does this department sit in? Thin re-export so callers routing a
 * blocker do not each reach into engine/meetings.js.
 */
export function roomsFor(party, meetings, catalog, metricIds) {
  return meetingsForParty(party, asMeetings(meetings), catalog, metricIds);
}

/**
 * One sentence for the top of the blockers section.
 */
export function dependencySummary(blockers = [], org = defaultOrg()) {
  const matrix = dependencyMatrix(blockers, org);
  const blockingTop = mostBlocking(blockers, org).top;
  const blockedTop = mostBlocked(blockers, org).top;

  if (matrix.totals.live === 0) return 'No open cross-team blockers.';

  const parts = [
    `${matrix.totals.live} open blocker${matrix.totals.live === 1 ? '' : 's'}`,
    `${matrix.totals.escalated} escalated`
  ];
  if (blockingTop) {
    parts.push(
      `${blockingTop.label} is holding ${blockingTop.count} of them across ` +
      `${blockingTop.waitingTeams.length} team${blockingTop.waitingTeams.length === 1 ? '' : 's'}`
    );
  }
  if (blockedTop) {
    parts.push(`${blockedTop.label} is waiting on the most`);
  }
  if (matrix.totals.unassigned > 0) {
    parts.push(`${matrix.totals.unassigned} with nobody named on the other end`);
  }
  return `${parts.join(', ')}.`;
}
