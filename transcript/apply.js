/**
 * apply.js - one meeting in, one week of dashboard state out.
 *
 * validate -> reconcile decisions -> reconcile stated numbers -> raise flags ->
 * write the one sentence the founder reads first.
 *
 * The ordering is not arbitrary. Nothing is written from an extraction that failed
 * validation, because a half-written week is harder to recover from than a week
 * that refused to publish and said why.
 */

import { validateExtraction, defaultCatalog, defaultOrg } from './schema.js';
import { reconcile } from './continuity.js';
import { reconcileBlockers } from './blockers.js';
import { dependencyMatrix, mostBlocking, mostBlocked, dependencySummary } from './dependencies.js';
import { reconcileStated, annotateSnapshots } from './reconcile-numbers.js';
import { TERMINAL_STATUSES, TERMINAL_BLOCKER_STATUSES } from '../engine/types.js';
import { ownerLead, ownerTeam } from '../engine/owners.js';

const MARKER_OWNER = '[OWNER NEEDED]';
const MARKER_DATE = '[DATE NEEDED]';

/**
 * Where a flag goes when it belongs to the room rather than to one line of
 * business. org.json calls the room "Leadership".
 */
const ROOM = 'leadership';

/**
 * ONE name. A decision or an ask owned by three people is owned by nobody, so
 * this resolves the department's lead (or the first of its trio) and never the
 * trio itself. The trio belongs on the scoreboard, not on an action.
 */
function ownerFor(org, dept) {
  const lead = ownerLead(dept, org);
  if (lead) return lead;
  const team = ownerTeam(dept, org);
  return team.length ? team[0] : MARKER_OWNER;
}

/** Which department should chase a decision? Use its first linked metric. */
function deptForDecision(decision, catalog) {
  const metrics = catalog.metrics || [];
  for (const id of decision.metricIds || []) {
    const m = metrics.find((x) => x.id === id);
    if (m) return m.dept;
  }
  return ROOM;
}

function hasMarker(text, marker) {
  return typeof text === 'string' && text.includes(marker);
}

function missingOwner(item) {
  return !item.owner ||
    hasMarker(item.owner, MARKER_OWNER) ||
    hasMarker(item.text, MARKER_OWNER) ||
    hasMarker(item.ask, MARKER_OWNER);
}

function missingDate(item) {
  return !item.dueDate ||
    hasMarker(item.text, MARKER_DATE) ||
    hasMarker(item.ask, MARKER_DATE);
}

/**
 * @param {Object} input
 * @param {Object} input.extraction     raw extractor output
 * @param {Array}  input.snapshots      Snapshot[] for this period
 * @param {Array}  input.openDecisions  Decision[] carried in
 * @param {Array}  input.openBlockers   Blocker[] carried in
 * @param {Object} input.meeting        Meeting
 * @param {Object} [input.catalog]
 * @param {Object} [input.org]
 * @param {Object} [input.meetingDates] meetingId -> ISO date, for blocker ageing
 * @returns {{ok, decisions, events, blockers, dependencies, notes, flags, unmatched, report, ...}}
 */
export function applyMeeting({
  extraction,
  snapshots = [],
  openDecisions = [],
  openBlockers = [],
  meeting = {},
  catalog = defaultCatalog(),
  org = defaultOrg(),
  meetingDates = {},
  // config/meetings.json, when there is one. Supplying it turns on
  // cross-meeting detection: a blocker whose two ends sit in different weekly
  // reviews escalates on its FIRST appearance, because there is no room where
  // both parties are present and waiting cannot create one.
  meetings = null
} = {}) {
  const validation = validateExtraction(extraction, { catalog, org });

  const meetingId = meeting.id || (extraction && extraction.meetingId) || 'unknown-meeting';
  const meetingDate = meeting.date || (extraction && extraction.meetingDate) || null;
  const raisedAt = meeting.processedAt || meetingDate || new Date().toISOString();

  if (!validation.ok) {
    // Refuse to publish. The previous week's decisions stand untouched.
    return {
      ok: false,
      validation,
      decisions: openDecisions,
      events: [],
      blockers: openBlockers,
      blockerEvents: [],
      dependencies: dependencyMatrix(openBlockers, org, { meetings, catalog }),
      notes: [],
      flags: [],
      unmatched: [],
      numbers: { matches: [], contradictions: [], unmeasured: [] },
      snapshots,
      injectionAttempts: (extraction && extraction.injectionAttempts) || [],
      errors: validation.errors.map((e) => ({ error: e })),
      report:
        `${meetingId}: extraction rejected with ${validation.errors.length} schema ` +
        `error${validation.errors.length === 1 ? '' : 's'}, nothing was written.`
    };
  }

  const { decisions, events, unmatched, errors } = reconcile(extraction, openDecisions, meeting);

  const blockerRun = reconcileBlockers(extraction, openBlockers, meeting, {
    org,
    catalog,
    meetingDates,
    meetings
  });
  const blockers = blockerRun.blockers;

  const numbers = reconcileStated(extraction.statedNumbers, snapshots, {
    catalog,
    org,
    meeting
  });

  const notes = (extraction.notes || []).map((n) => ({
    cardId: n.cardId,
    text: n.text,
    meetingId,
    ...(n.quote ? { quote: n.quote } : {})
  }));

  const flags = [...numbers.contradictions, ...blockerRun.flags];

  // --- commitments with no owner or no date --------------------------------
  // A commitment nobody owns is a wish. A commitment with no date is a wish with
  // better grammar. Both get chased by name.
  (extraction.commitments || []).forEach((c, i) => {
    const noOwner = missingOwner(c);
    const noDate = missingDate(c);
    if (!noOwner && !noDate) return;
    const gaps = [noOwner ? 'no owner' : null, noDate ? 'no date' : null].filter(Boolean);
    flags.push({
      id: `flag-commitment-${meetingId}-${i}`,
      dept: ROOM,
      owner: noOwner ? ownerFor(org, ROOM) : c.owner,
      title: `Commitment with ${gaps.join(' and ')}`,
      body:
        `"${c.text}" was committed to in ${meetingId} with ${gaps.join(' and ')}. ` +
        (c.quote ? `Quote: "${c.quote}". ` : '') +
        `Name ${noOwner ? 'the owner' : ''}${noOwner && noDate ? ' and ' : ''}` +
        `${noDate ? 'the date' : ''} before the next review, or drop it.`,
      kind: 'missing_data',
      raisedBy: 'transcript',
      raisedAt,
      resolvedAt: null
    });
  });

  // --- decisions with nothing that proves them -----------------------------
  // A decision nobody can measure cannot be shown to have worked or failed. It
  // will be restated every week forever, which is how a decision log turns into
  // a meeting agenda.
  decisions.forEach((d) => {
    if (TERMINAL_STATUSES.includes(d.status)) return;
    if (Array.isArray(d.metricIds) && d.metricIds.length > 0) return;
    const dept = deptForDecision(d, catalog);
    flags.push({
      id: `flag-no-proof-${d.id}-${meetingId}`,
      dept,
      owner: d.owner || ownerFor(org, dept),
      title: `No metric proves "${d.headline}"`,
      body:
        `Decision ${d.number} has an empty metricIds. Nothing on the dashboard moves ` +
        `when this decision works, so next week cannot say whether it did. ` +
        `Link at least one ring to it, or accept that it is an opinion.`,
      kind: 'no_proof',
      raisedBy: 'transcript',
      raisedAt,
      resolvedAt: null,
      decisionId: d.id,
      metricIds: []
    });
  });

  // --- asks owed before the next review ------------------------------------
  (extraction.asks || []).forEach((a, i) => {
    const noOwner = missingOwner(a);
    const noDate = missingDate(a);
    const overdue = a.dueDate && meetingDate && String(a.dueDate) < String(meetingDate);
    flags.push({
      id: `flag-ask-${meetingId}-${i}`,
      dept: ROOM,
      owner: noOwner ? ownerFor(org, ROOM) : a.owner,
      title: overdue
        ? `Overdue from ${a.owner || MARKER_OWNER}`
        : `Owed by ${a.owner || MARKER_OWNER} before the next review`,
      body:
        `${a.ask}` +
        (a.dueDate ? ` Due ${a.dueDate}.` : ` ${MARKER_DATE}`) +
        (noOwner ? ` ${MARKER_OWNER}` : '') +
        (a.quote ? ` Quote: "${a.quote}"` : ''),
      kind: overdue ? 'overdue' : 'manual',
      raisedBy: 'transcript',
      raisedAt,
      resolvedAt: null
    });
  });

  // --- text in the transcript that was addressed to the model --------------
  // Surfaced as data. It changed nothing. That is the whole point of printing it:
  // a human can see what was attempted and confirm no status moved because of it.
  const injectionAttempts = extraction.injectionAttempts || [];
  injectionAttempts.forEach((x, i) => {
    flags.push({
      id: `flag-injection-${meetingId}-${i}`,
      dept: ROOM,
      owner: ownerFor(org, ROOM),
      title: 'Transcript contained text addressed to the extractor',
      body:
        `The transcript contained text aimed at the model rather than at the room: ` +
        `"${x.quote}"${x.speaker ? ` (spoken by ${x.speaker})` : ''}. ` +
        `It was quoted, not obeyed. No decision or blocker status was changed by it, ` +
        `and no section was skipped.`,
      kind: 'manual',
      raisedBy: 'transcript',
      raisedAt,
      resolvedAt: null
    });
  });

  const dependencies = dependencyMatrix(blockers, org, { meetings, catalog });

  const report = buildReport({
    meetingId,
    meetingDate,
    decisions,
    events,
    unmatched,
    blockers,
    blockerEvents: blockerRun.events
  });

  return {
    ok: true,
    validation,
    decisions,
    events,
    blockers,
    blockerEvents: blockerRun.events,
    blockerUnmatched: blockerRun.unmatched,
    blockerErrors: blockerRun.errors,
    dependencies,
    mostBlocking: mostBlocking(blockers, org),
    mostBlocked: mostBlocked(blockers, org),
    dependencySummary: dependencySummary(blockers, org),
    notes,
    flags,
    unmatched,
    errors,
    numbers,
    snapshots: annotateSnapshots(snapshots, extraction.statedNumbers || []),
    injectionAttempts,
    report
  };
}

/**
 * The one sentence a founder reads before anything else. Decisions: new, changed,
 * confirmed, blocked, left open. Blockers: new, resolved in the room, carried,
 * escalated - the four states that tell you whether the room is actually clearing
 * dependencies or just listing them again.
 */
export function buildReport({
  meetingId,
  meetingDate,
  decisions,
  events,
  unmatched = [],
  blockers = [],
  blockerEvents = []
}) {
  const touched = new Set(events.map((e) => e.decisionId));
  const count = (status) => events.filter((e) => e.toStatus === status).length;

  const created = events.filter((e) => e.fromStatus === null).length;
  const changed = count('CHANGED') + count('REVERSED');
  const confirmed = count('CONFIRMED') + count('COMPLETED') + count('PARTIAL');
  const blocked = count('BLOCKED');
  const left = decisions.filter(
    (d) => !touched.has(d.id) && !TERMINAL_STATUSES.includes(d.status)
  ).length;

  const merge = unmatched.filter((u) => u.tag === 'needs_human_merge').length;

  // Blocker counts come off the final objects, not off the events, because a
  // blocker can be raised and escalated in the same run and must be counted once.
  const bNew = blockerEvents.filter((e) => e.fromStatus === null).length;
  const bResolved = blockers.filter((b) => b.status === 'resolved_in_room').length;
  const bEscalated = blockers.filter((b) => b.status === 'escalated').length;
  const bCarried = blockers.filter(
    (b) => !TERMINAL_BLOCKER_STATUSES.includes(b.status) && b.status !== 'escalated'
  ).length;

  const decisionPart =
    `${created} decision${created === 1 ? '' : 's'} new, ${changed} changed, ` +
    `${confirmed} confirmed, ${blocked} blocked, ${left} left open` +
    (merge > 0 ? `, ${merge} needing a human merge` : '');

  const blockerPart =
    `${bNew} blocker${bNew === 1 ? '' : 's'} new, ${bResolved} resolved in the room, ` +
    `${bCarried} carried, ${bEscalated} escalated`;

  return `${meetingId}${meetingDate ? ` (${meetingDate})` : ''}: ${decisionPart}; ${blockerPart}.`;
}
