/**
 * blockers.js - the object the first goal of this meeting depends on.
 *
 * "One team, full visibility. Cross-functional dependencies and blockers should get
 * resolved in the room, so no one is left chasing things on their own."
 *
 * A blocker written as a bullet inside one team's update is invisible to the team
 * that can actually clear it. It gets read by the person who wrote it, nodded at,
 * and carried for another week. Three weeks later nobody can tell you how long it
 * has been sitting there, because the only record is five paragraphs in five
 * different documents.
 *
 * So a blocker is an object with two named ends and an age:
 *   - raisedBy  the team that cannot proceed
 *   - needsFrom the team or person who can unblock them
 *   - ageWeeks  computed, never typed, so it cannot be quietly reset by a rewrite
 *
 * The age is the part that does the work. A blocker in its third week is not a
 * longer version of a new blocker, it is a different conversation - usually about
 * priority or about someone having said yes without capacity. Escalation is
 * automatic so that nobody has to remember, and so that remembering is not a
 * favour one person does for another.
 *
 * Matching uses the same conservative discipline as decisions: a false match merges
 * two different dependencies and makes one of them disappear, which is precisely
 * the failure this object exists to prevent.
 */

import { BLOCKER_STATUSES, TERMINAL_BLOCKER_STATUSES } from '../engine/types.js';
import { hasOwnerEntry, ownerLead, ownerTeam } from '../engine/owners.js';
import { crossMeetingConfig, loadMeetings, resolveCrossMeeting } from '../engine/meetings.js';
import { similarity, slugify, MATCH_THRESHOLD, REVIEW_FLOOR } from './continuity.js';
import { defaultOrg, defaultCatalog } from './schema.js';

export { MATCH_THRESHOLD, REVIEW_FLOOR };

/** Statuses a blocker can sit in while still waiting on someone. */
export const LIVE_BLOCKER_STATUSES = BLOCKER_STATUSES.filter(
  (s) => !TERMINAL_BLOCKER_STATUSES.includes(s)
);

const MS_PER_DAY = 86400000;

/**
 * Age in weeks, 1-based: a blocker raised at this meeting is in week 1.
 * So "open longer than escalate_after_weeks (2)" means ageWeeks > 2, which is the
 * third week - the week the founder said looks different from the first.
 */
export function ageInWeeks(raisedAt, asOf) {
  if (!raisedAt || !asOf) return 1;
  const from = Date.parse(`${String(raisedAt).slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${String(asOf).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 1;
  return Math.floor((to - from) / MS_PER_DAY / 7) + 1;
}

function resolveRaisedAt(blocker, meetingDates, fallback) {
  if (blocker.raisedAt) return String(blocker.raisedAt).slice(0, 10);
  if (blocker.firstSeenMeeting && meetingDates[blocker.firstSeenMeeting]) {
    return meetingDates[blocker.firstSeenMeeting];
  }
  return fallback;
}

/**
 * Best same-raisedBy candidate for an extracted blocker.
 *
 * The gate is raisedBy, not needsFrom. A blocker's other end often arrives late -
 * week one is "we are stuck on pricing", week two names Sloosh - and gating on
 * needsFrom would make the week it gets named look like a brand new blocker,
 * resetting the age. Resetting the age is the one thing this file must never do.
 */
export function bestBlockerMatch(extracted, candidates) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.raisedBy !== extracted.raisedBy) continue;
    const score = similarity(extracted.title, c.title);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { candidate: best, score: bestScore };
}

function cloneBlocker(b) {
  return { ...b, metricIds: Array.isArray(b.metricIds) ? [...b.metricIds] : [] };
}

function unionIds(a, b) {
  const out = [];
  const seen = new Set();
  for (const id of [...(a || []), ...(b || [])]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * ONE name on the far end. A blocker addressed to a department's three owners
 * is a blocker nobody picks up - each assumes one of the other two has it,
 * which is the shared-ownership failure org.json's _accountability block names.
 */
function ownerName(org, needsFrom) {
  if (!needsFrom) return '[OWNER NEEDED]';
  const lead = ownerLead(needsFrom, org);
  if (lead) return lead;
  const team = ownerTeam(needsFrom, org);
  if (team.length) return team[0];
  if (hasOwnerEntry(needsFrom, org)) return '[OWNER NEEDED]';
  return needsFrom; // already a person's name
}

function deptLabel(org, id) {
  const d = (org.departments || []).find((x) => x.id === id);
  return d ? d.label : id;
}

/**
 * Reconcile this meeting's blockers against the ones already open.
 *
 * @param {Object} extracted      validated extraction (needs .blockers)
 * @param {Array}  openBlockers   Blocker[] carried in from previous meetings
 * @param {Object} meeting        Meeting {id, date}
 * @param {Object} [config]       {org, catalog, meetingDates}
 * @returns {{blockers, events, flags, unmatched, errors}}
 */
export function reconcileBlockers(extracted, openBlockers = [], meeting = {}, config = {}) {
  const org = config.org || defaultOrg();
  const catalog = config.catalog || defaultCatalog();
  const meetingDates = config.meetingDates || {};
  const rules = org.blockers || {};
  const escalateAfterWeeks = Number.isFinite(rules.escalate_after_weeks)
    ? rules.escalate_after_weeks
    : 2;
  const requireNeedsFrom = rules.require_needs_from !== false;

  // The meeting schedule, when there is one. Without it nothing below changes
  // and ageing is the only escalation rule, exactly as before.
  const meetings = loadMeetings(config.meetings);
  const crossCfg = crossMeetingConfig(config.meetings);

  const meetingId = meeting.id || extracted.meetingId || 'unknown-meeting';
  const meetingDate = meeting.date || extracted.meetingDate || null;
  const at = meeting.processedAt || meetingDate || new Date().toISOString();

  const events = [];
  const unmatched = [];
  const errors = [];

  const byId = new Map();
  const carried = (openBlockers || []).map((b) => {
    const copy = cloneBlocker(b);
    byId.set(copy.id, copy);
    return copy;
  });

  const touched = new Set();
  const created = [];
  const takenIds = new Set(byId.keys());

  for (const ex of extracted.blockers || []) {
    let match = null;
    let matchedBy = null;
    let matchScore = null;

    if (ex.id && byId.has(ex.id)) {
      match = byId.get(ex.id);
      matchedBy = 'id';
      matchScore = 1;
    } else if (ex.id && !byId.has(ex.id)) {
      unmatched.push({
        tag: 'unknown_id',
        reason: `extraction referenced blocker id "${ex.id}" which is not in the open set`,
        extracted: ex,
        candidateId: null,
        score: null
      });
      continue;
    } else {
      const { candidate, score } = bestBlockerMatch(ex, carried);
      if (candidate && score >= MATCH_THRESHOLD) {
        match = candidate;
        matchedBy = 'title';
        matchScore = score;
      } else if (candidate && score >= REVIEW_FLOOR) {
        unmatched.push({
          tag: 'needs_human_merge',
          reason:
            `title similarity ${score.toFixed(3)} sits between REVIEW_FLOOR ${REVIEW_FLOOR} ` +
            `and MATCH_THRESHOLD ${MATCH_THRESHOLD}; not auto-merged because merging two ` +
            `different dependencies makes one of them disappear`,
          extracted: ex,
          candidateId: candidate.id,
          candidateTitle: candidate.title,
          score
        });
        continue;
      }
    }

    if (match) {
      const from = match.status;
      if (TERMINAL_BLOCKER_STATUSES.includes(from)) {
        errors.push({
          blockerId: match.id,
          title: match.title,
          fromStatus: from,
          toStatus: ex.status || 'open',
          error:
            `cannot reopen a blocker that is ${from}; raise a new blocker so the ` +
            `original resolution keeps its date`
        });
        continue;
      }

      const to = ex.status && BLOCKER_STATUSES.includes(ex.status) ? ex.status : 'open';
      match.title = ex.title || match.title;
      // needsFrom is only ever filled in or corrected, never nulled by silence.
      if (ex.needsFrom) match.needsFrom = ex.needsFrom;
      if (ex.what) match.what = ex.what;
      if (ex.impact) match.impact = ex.impact;
      match.metricIds = unionIds(match.metricIds, ex.metricIds);
      if (ex.owner !== undefined) match.owner = ex.owner ?? match.owner ?? null;
      if (ex.dueDate !== undefined) match.dueDate = ex.dueDate ?? match.dueDate ?? null;
      if (ex.resolution) match.resolution = ex.resolution;
      match.status = to;
      match.lastTouchedMeeting = meetingId;
      if (TERMINAL_BLOCKER_STATUSES.includes(to)) match.resolvedAt = meetingDate;

      match.raisedAt = resolveRaisedAt(match, meetingDates, meetingDate);
      match.ageWeeks = ageInWeeks(match.raisedAt, meetingDate);

      events.push({
        blockerId: match.id,
        meetingId,
        fromStatus: from,
        toStatus: to,
        reason: ex.resolution || blockerReason(to),
        ...(ex.quote ? { quote: ex.quote } : {}),
        ageWeeks: match.ageWeeks,
        at,
        matchedBy,
        matchScore
      });
      touched.add(match.id);
      continue;
    }

    // New blocker.
    let id = ex.id || slugify(ex.title).replace(/^d-/, 'b-');
    let n = 2;
    while (takenIds.has(id)) {
      id = `${ex.id || slugify(ex.title).replace(/^d-/, 'b-')}-${n}`;
      n += 1;
    }
    takenIds.add(id);

    const raisedAt = resolveRaisedAt(ex, meetingDates, meetingDate);
    const status = ex.status && BLOCKER_STATUSES.includes(ex.status) ? ex.status : 'open';

    const blocker = {
      id,
      title: ex.title,
      raisedBy: ex.raisedBy,
      needsFrom: ex.needsFrom ?? null,
      what: ex.what || '',
      impact: ex.impact || '',
      metricIds: Array.isArray(ex.metricIds) ? [...ex.metricIds] : [],
      raisedAt,
      ageWeeks: ageInWeeks(raisedAt, meetingDate),
      status,
      owner: ex.owner ?? null,
      dueDate: ex.dueDate ?? null,
      resolution: ex.resolution || '',
      resolvedAt: TERMINAL_BLOCKER_STATUSES.includes(status) ? meetingDate : null,
      firstSeenMeeting: meetingId,
      lastTouchedMeeting: meetingId
    };

    events.push({
      blockerId: id,
      meetingId,
      fromStatus: null,
      toStatus: status,
      reason: ex.resolution || 'first raised',
      ...(ex.quote ? { quote: ex.quote } : {}),
      ageWeeks: blocker.ageWeeks,
      at,
      matchedBy: 'none',
      matchScore: null
    });

    byId.set(id, blocker);
    created.push(blocker);
    touched.add(id);
  }

  // --- blockers nobody mentioned -------------------------------------------
  // They do NOT disappear. Disappearing quietly is the exact failure this object
  // was built to stop: the week nobody raised it is the week it cost the most.
  // It carries, and its age goes up.
  for (const b of carried) {
    if (touched.has(b.id)) continue;
    if (TERMINAL_BLOCKER_STATUSES.includes(b.status)) continue;

    const from = b.status;
    b.raisedAt = resolveRaisedAt(b, meetingDates, meetingDate);
    b.ageWeeks = ageInWeeks(b.raisedAt, meetingDate);
    b.status = 'carried';
    b.lastTouchedMeeting = meetingId;

    events.push({
      blockerId: b.id,
      meetingId,
      fromStatus: from,
      toStatus: 'carried',
      reason: `not raised at ${meetingDate}, still open and now in week ${b.ageWeeks}`,
      ageWeeks: b.ageWeeks,
      at,
      matchedBy: 'unmentioned',
      matchScore: null
    });
  }

  const blockers = [...carried, ...created];

  // --- ageing and escalation ------------------------------------------------
  // Applied last, so it catches blockers that were mentioned, blockers that were
  // not, and blockers raised this week with an older raisedAt. Automatic, because
  // escalation that depends on someone remembering is not escalation.
  const flags = [];
  for (const b of blockers) {
    if (!Number.isFinite(b.ageWeeks)) b.ageWeeks = ageInWeeks(b.raisedAt, meetingDate);
    if (TERMINAL_BLOCKER_STATUSES.includes(b.status)) continue;

    // Which room can settle this - if any. Stamped on the blocker so the
    // renderer and the dashboards do not each recompute the schedule.
    if (meetings.length) {
      const r = resolveCrossMeeting(b, meetings, catalog);
      b.crossMeeting = r.cross;
      b.raisedInMeetings = r.raisedIn.map((m) => m.id);
      b.needsInMeetings = r.needsIn.map((m) => m.id);
    }

    const crossNow = b.crossMeeting && crossCfg.escalateImmediately;
    const aged = b.ageWeeks > escalateAfterWeeks;

    if ((aged || crossNow) && b.status !== 'escalated') {
      const from = b.status;
      b.status = 'escalated';
      events.push({
        blockerId: b.id,
        meetingId,
        fromStatus: from,
        toStatus: 'escalated',
        // The two reasons are written differently on purpose. One says this sat
        // too long; the other says it was never going to get settled by sitting.
        reason: aged
          ? `open ${b.ageWeeks} weeks, past escalate_after_weeks of ${escalateAfterWeeks}`
          : `cross-meeting on first appearance: ${b.raisedBy} and ${b.needsFrom} are never `
            + `in a room together, so there is nowhere for this to be resolved and no `
            + `amount of waiting creates one`,
        ageWeeks: b.ageWeeks,
        at,
        matchedBy: aged ? 'ageing' : 'cross_meeting',
        matchScore: null
      });
    }
  }

  flags.push(...blockerFlags(blockers, {
    org, catalog, meeting, escalateAfterWeeks, requireNeedsFrom,
    meetings: config.meetings
  }));

  return { blockers, events, flags, unmatched, errors };
}

/**
 * The three ways a blocker fails to be actionable.
 */
export function blockerFlags(blockers, opts = {}) {
  const org = opts.org || defaultOrg();
  const meeting = opts.meeting || {};
  const meetingId = meeting.id || 'unknown-meeting';
  const raisedAt = meeting.processedAt || meeting.date || new Date().toISOString();
  const escalateAfterWeeks = Number.isFinite(opts.escalateAfterWeeks)
    ? opts.escalateAfterWeeks
    : ((org.blockers || {}).escalate_after_weeks ?? 2);
  const requireNeedsFrom = opts.requireNeedsFrom !== false;
  const meetings = loadMeetings(opts.meetings);
  const crossCfg = crossMeetingConfig(opts.meetings);
  const catalog = opts.catalog;

  const flags = [];

  for (const b of blockers) {
    const terminal = TERMINAL_BLOCKER_STATUSES.includes(b.status);
    const cross = b.crossMeeting !== undefined
      ? !!b.crossMeeting
      : (meetings.length ? resolveCrossMeeting(b, meetings, catalog).cross : false);

    // 1. No other end. "I am blocked" with nobody named is a mood, not an ask.
    if (requireNeedsFrom && !b.needsFrom && !terminal) {
      flags.push({
        id: `flag-blocker-needsfrom-${b.id}-${meetingId}`,
        dept: b.raisedBy,
        owner: b.owner || '[OWNER NEEDED]',
        title: `No team named on "${b.title}"`,
        body:
          `${deptLabel(org, b.raisedBy)} is blocked and needsFrom is empty. ` +
          `A blocker with one end cannot be resolved in the room, because nobody ` +
          `in it knows the ask is theirs. Name the team or the person. ` +
          `The ask: ${b.what || '[not stated]'}`,
        kind: 'missing_data',
        raisedBy: 'transcript',
        raisedAt,
        resolvedAt: null,
        metricIds: b.metricIds || [],
        blockerId: b.id
      });
    }

    // 2. Past the escalation line - OR cross-meeting, which skips the line.
    //
    // Age measures how long two people in the same room have failed to settle
    // something. When they were never in the same room it measures nothing: two
    // weeks of a US Sales blocker raised at the US charter, where Sloosh is not
    // present, is two weeks of nothing happening and everybody feeling diligent.
    // So a cross-meeting blocker escalates on its first appearance.
    const crossEscalates = cross && crossCfg.escalateImmediately;
    if (!terminal && (b.ageWeeks > escalateAfterWeeks || crossEscalates)) {
      const agedOut = b.ageWeeks > escalateAfterWeeks;
      flags.push({
        id: `flag-blocker-escalated-${b.id}-${meetingId}`,
        dept: b.needsFrom || b.raisedBy,
        owner: ownerName(org, b.needsFrom),
        title: agedOut
          ? `Week ${b.ageWeeks}: ${b.title}`
          : `No shared room: ${b.title}`,
        body: agedOut
          ? `${deptLabel(org, b.raisedBy)} has been waiting on ` +
            `${b.needsFrom ? deptLabel(org, b.needsFrom) : '[OWNER NEEDED]'} for ` +
            `${b.ageWeeks} weeks, past the ${escalateAfterWeeks} week line. ` +
            `Ask: ${b.what || '[not stated]'} ` +
            `Impact: ${b.impact || '[not stated]'} ` +
            `This is no longer a status update. Either it gets an owner and a date in ` +
            `this meeting, or it gets dropped on the record.`
          : `${deptLabel(org, b.raisedBy)} needs something from ` +
            `${deptLabel(org, b.needsFrom)}, and the two are never in a room together - ` +
            `there is no weekly review where both are present. Waiting will not produce ` +
            `one, so this is escalated in week ${b.ageWeeks} rather than week ` +
            `${escalateAfterWeeks + 1}. It is shown in both rooms. ` +
            `Ask: ${b.what || '[not stated]'} ` +
            `Impact: ${b.impact || '[not stated]'} ` +
            `${ownerName(org, b.needsFrom)} answers it, or it gets dropped on the record.`,
        kind: 'overdue',
        ...(cross ? { crossMeeting: true } : {}),
        raisedBy: 'transcript',
        raisedAt,
        resolvedAt: null,
        metricIds: b.metricIds || [],
        blockerId: b.id
      });
    }

    // 3. Declared resolved with nothing written down.
    if (b.status === 'resolved_in_room' && !(b.resolution || '').trim()) {
      flags.push({
        id: `flag-blocker-noresolution-${b.id}-${meetingId}`,
        dept: b.raisedBy,
        owner: ownerName(org, b.needsFrom),
        title: `"${b.title}" was closed with no resolution written`,
        body:
          `This blocker was marked resolved_in_room but no resolution was recorded. ` +
          `A resolution nobody wrote down comes back next week as the same blocker ` +
          `with a reset age. State what was agreed, or reopen it.`,
        kind: 'no_proof',
        raisedBy: 'transcript',
        raisedAt,
        resolvedAt: null,
        metricIds: b.metricIds || [],
        blockerId: b.id
      });
    }
  }

  return flags;
}

function blockerReason(status) {
  switch (status) {
    case 'resolved_in_room': return 'resolved in the room';
    case 'owner_assigned': return 'owner assigned';
    case 'escalated': return 'escalated';
    case 'dropped': return 'dropped';
    case 'carried': return 'carried';
    default: return 'open';
  }
}
