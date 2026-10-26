/**
 * meetings.js - which numbers belong in which room.
 *
 * THE STRUCTURAL POINT (config/meetings.json says it first, this file enforces it)
 * ================================================================================
 * There are four weekly reviews: Monday Hiring, Tuesday India Sales + Perf
 * Marketing[india], Wednesday US Sales + Perf Marketing[us], Thursday Sloosh.
 *
 * Performance Marketing has no meeting of its own. Perf India is read in the
 * India charter; Perf US in the US charter. So a meeting's membership is a
 * DEPARTMENT AND A SEGMENT, not a department. A department-only model would put
 * the whole of Perf Marketing in both rooms, and each room would read half a
 * number it cannot act on - the CPL of a geography nobody in the room runs.
 *
 * Hence: `members` is a list of `{dept, segment?}`, and a member carrying a
 * segment selects ONLY the metrics carrying that segment.
 *
 * A metric in a department whose member carries a segment, but which has no
 * segment of its own, matches NOTHING - it is not silently duplicated into both
 * charters. That is deliberate, and `metricsWithNoMeeting()` exists so the gap
 * is reported loudly by `pulse check` rather than discovered by a number
 * vanishing from every dashboard.
 *
 * THE SECOND POINT: there is no fifth leadership meeting
 * =====================================================
 * Nobody is in all four rooms. India and US never meet. Hiring never meets the
 * charters asking it for headcount. So a dependency between two lines has NO
 * room where both parties are present - which is exactly the "left chasing
 * things on their own" problem. isCrossMeeting() is how that gets detected;
 * transcript/dependencies.js routes it into both rooms.
 */

/* ------------------------------------------------------------------------ *
 * loading
 * ------------------------------------------------------------------------ */

/**
 * Normalise whatever meetings.json (or a bare array, or nothing) gives us.
 *
 * Returns [] when there is no meetings config at all, which is the signal every
 * caller uses to fall back to the single whole-company dashboard. A repo with
 * no meetings.json keeps working exactly as it did.
 *
 * @param {Object|Array|null} config  config/meetings.json, or its `meetings`
 * @returns {Array<{id:string,name:string,day:string|null,members:Array<{dept:string,segment:string|null}>,sections:string[],chair:string|null}>}
 */
export function loadMeetings(config) {
  const list = Array.isArray(config)
    ? config
    : (config && Array.isArray(config.meetings) ? config.meetings : []);

  return list
    .filter((m) => m && m.id)
    .map((m) => ({
      id: String(m.id),
      name: m.name || String(m.id),
      day: m.day || null,
      members: normaliseMembers(m.members),
      sections: Array.isArray(m.sections) ? m.sections.slice() : [],
      chair: m.chair ?? null
    }));
}

/** `["india_sales"]` and `[{dept, segment}]` both mean the same thing. */
function normaliseMembers(members) {
  return (Array.isArray(members) ? members : [])
    .map((member) => {
      if (typeof member === 'string') return { dept: member, segment: null };
      if (member && member.dept) {
        return { dept: String(member.dept), segment: member.segment ? String(member.segment) : null };
      }
      return null;
    })
    .filter(Boolean);
}

/** The cross-meeting policy block, with the documented defaults applied. */
export function crossMeetingConfig(config) {
  const cm = (config && !Array.isArray(config) && config.cross_meeting) || {};
  return {
    surfaceInBothRooms: cm.surface_in_both_rooms !== false,
    // Age is the wrong test when the two parties were never in the same room,
    // so this defaults ON wherever a meetings file exists.
    escalateImmediately: cm.escalate_immediately !== false,
    notifyOwnerOf: cm.notify_owner_of || 'needsFrom',
    carryToNextMeetingOf: cm.carry_to_next_meeting_of || 'needsFrom'
  };
}

export function meetingById(id, meetings) {
  return (meetings || []).find((m) => m && m.id === id) || null;
}

/* ------------------------------------------------------------------------ *
 * membership
 * ------------------------------------------------------------------------ */

/**
 * Does this member's `{dept, segment}` cover this metric (or card)?
 *
 * The asymmetry is the whole design:
 *   member {dept:'perf_marketing', segment:'india'}  covers pm_india_* ONLY
 *   member {dept:'india_sales'}                      covers every india_sales metric
 *
 * A member with no segment covers everything in its department, segmented or
 * not. A member WITH a segment covers only items carrying that same segment.
 */
export function memberCovers(member, item) {
  if (!member || !item) return false;
  if (member.dept !== item.dept) return false;
  if (!member.segment) return true;
  return (item.segment || null) === member.segment;
}

/** True when any of the meeting's members covers this metric/card def. */
export function meetingCovers(meeting, item) {
  if (!meeting || !item) return false;
  return (meeting.members || []).some((member) => memberCovers(member, item));
}

/**
 * The metric defs one meeting covers, in catalog order.
 *
 * @param {Object} meeting   from loadMeetings()
 * @param {Object} catalog   catalog.json
 * @returns {import('./types.js').MetricDef[]}
 */
export function metricsForMeeting(meeting, catalog) {
  const metrics = (catalog && catalog.metrics) || [];
  if (!meeting) return [];
  return metrics.filter((def) => def && meetingCovers(meeting, def));
}

/**
 * The cards one meeting covers. Cards carry an optional `segment` too, so the
 * Tuesday room gets the perf-india card and not the perf-us one, and the ring
 * card a room sees is one it can act on.
 */
export function cardsForMeeting(meeting, catalog) {
  const cards = (catalog && catalog.cards) || [];
  if (!meeting) return [];
  return cards.filter((card) => card && meetingCovers(meeting, card));
}

/** Just the ids, which is what a snapshot filter wants. */
export function metricIdsForMeeting(meeting, catalog) {
  return metricsForMeeting(meeting, catalog).map((d) => d.id);
}

/**
 * The inverse: which rooms read this metric. Needed for cross-meeting blocker
 * routing, and for answering "where does this number get discussed".
 *
 * @returns {Array<Object>} meetings, in file order. Empty means NO room reads
 *          this metric - which `pulse check` reports as a gap.
 */
export function meetingsForMetric(metricId, meetings, catalog) {
  const def = ((catalog && catalog.metrics) || []).find((m) => m && m.id === metricId);
  if (!def) return [];
  return (meetings || []).filter((meeting) => meetingCovers(meeting, def));
}

/** Same question for a card. */
export function meetingsForCard(cardId, meetings, catalog) {
  const card = ((catalog && catalog.cards) || []).find((c) => c && c.id === cardId);
  if (!card) return [];
  return (meetings || []).filter((meeting) => meetingCovers(meeting, card));
}

/**
 * Metrics no meeting reads. A metric nobody reads is worse than a metric with
 * no target: it is computed, stored, and seen by nobody. Reported by
 * `pulse check` so the segment rule above can never quietly hide a number.
 */
export function metricsWithNoMeeting(meetings, catalog) {
  const list = (meetings || []);
  if (!list.length) return [];
  return ((catalog && catalog.metrics) || [])
    .filter((def) => def && !list.some((meeting) => meetingCovers(meeting, def)));
}

/* ------------------------------------------------------------------------ *
 * which room is a party in?
 * ------------------------------------------------------------------------ */

/**
 * Resolve one end of a blocker to the rooms that end sits in.
 *
 * A party may be:
 *   'us_sales'                        a department id
 *   {dept:'perf_marketing', segment:'india'}   a department AND a segment
 *   'Raghav'                          a person - resolves to no room
 *
 * `metricIds` narrows a bare department when the blocker's own metrics pin a
 * segment: "india_sales needs something from perf_marketing" holding back
 * pm_india_cpl is a Tuesday conversation, not a Tuesday-and-Wednesday one.
 *
 * @returns {Array<Object>} the meetings this party attends
 */
export function meetingsForParty(party, meetings, catalog, metricIds) {
  const list = meetings || [];
  if (!party || !list.length) return [];

  const dept = typeof party === 'string' ? party : party.dept;
  if (!dept) return [];

  let segment = typeof party === 'object' && party.segment ? party.segment : null;
  if (!segment) segment = segmentFromMetrics(dept, metricIds, catalog);

  return list.filter((meeting) => (meeting.members || []).some((member) => {
    if (member.dept !== dept) return false;
    // No segment known for the party: it sits in every room its department
    // appears in. Knowing the segment narrows it to the matching room.
    if (!member.segment) return true;
    if (!segment) return true;
    return member.segment === segment;
  }));
}

/**
 * The single segment this department's metrics all point at, or null when the
 * blocker names none, names metrics in other departments, or straddles two.
 * Straddling is deliberately treated as "no segment": a blocker holding back
 * both geographies belongs in both rooms.
 */
function segmentFromMetrics(dept, metricIds, catalog) {
  if (!Array.isArray(metricIds) || !metricIds.length) return null;
  const defs = (catalog && catalog.metrics) || [];
  const segments = new Set();
  for (const id of metricIds) {
    const def = defs.find((m) => m && m.id === id);
    if (!def || def.dept !== dept) continue;
    segments.add(def.segment || null);
  }
  if (segments.size !== 1) return null;
  const only = [...segments][0];
  return only || null;
}

/**
 * Is this blocker's conversation impossible in any single room?
 *
 * True when `raisedBy` and `needsFrom` resolve to meetings with NO overlap -
 * US Sales (Wednesday) needing something from Sloosh (Thursday). The two
 * parties are never in a room together, so nobody can resolve it in one, and
 * waiting two weeks to escalate just means two weeks of it being raised to
 * people who cannot act on it.
 *
 * False when:
 *   - the two share a room: India Sales needing Perf Marketing[india] is one
 *     Tuesday conversation, which is exactly why they were put in one room
 *   - either end resolves to no meeting at all (a person's name, an unknown
 *     department). There is no second room to carry it to, so there is nothing
 *     for cross-meeting routing to do. blockerFlags still reports the gap.
 *
 * @param {Object} blocker  Blocker {raisedBy, needsFrom, metricIds}
 * @param {Array}  meetings from loadMeetings()
 * @param {Object} catalog  catalog.json
 */
export function isCrossMeeting(blocker, meetings, catalog) {
  const resolved = resolveCrossMeeting(blocker, meetings, catalog);
  return resolved.cross;
}

/**
 * isCrossMeeting with its working shown - which rooms each end sits in, so the
 * renderer can say "raised in the US charter" without recomputing it.
 *
 * @returns {{cross:boolean, raisedIn:Array, needsIn:Array, shared:Array}}
 */
export function resolveCrossMeeting(blocker, meetings, catalog) {
  const list = meetings || [];
  const empty = { cross: false, raisedIn: [], needsIn: [], shared: [] };
  if (!blocker || !list.length) return empty;

  const metricIds = blocker.metricIds || [];
  const raisedIn = meetingsForParty(blocker.raisedBy, list, catalog, metricIds);
  const needsIn = meetingsForParty(blocker.needsFrom, list, catalog, metricIds);

  if (!raisedIn.length || !needsIn.length) {
    return { cross: false, raisedIn, needsIn, shared: [] };
  }

  const needsIds = new Set(needsIn.map((m) => m.id));
  const shared = raisedIn.filter((m) => needsIds.has(m.id));

  return { cross: shared.length === 0, raisedIn, needsIn, shared };
}

/* ------------------------------------------------------------------------ *
 * routing a blocker into the rooms that can see it
 * ------------------------------------------------------------------------ */

/**
 * The blockers ONE room should see - which is not the same as the blockers that
 * room raised.
 *
 *   local    raisedBy sits in this meeting. Rendered as normal.
 *   foreign  needsFrom sits in this meeting but the raiser does not. Without
 *            this the team that can clear it never sees the card, because they
 *            were not in the room where it was raised and there is no fifth
 *            meeting where both would be. Carried here, marked, and named with
 *            the room and the person it came from: "somebody is waiting on you"
 *            is only actionable if you can see who, and where to answer.
 *
 * Never both. If the two ends share this room it is local, full stop - showing
 * it twice would turn one conversation into two.
 *
 * Lives in the engine rather than in transcript/ because both the transcript
 * layer and the renderer need the same answer, and two implementations of "who
 * sees this blocker" is how the dashboard and the record drift apart.
 *
 * @param {Array<Object>} blockers
 * @param {string} meetingId
 * @param {Object} [opts] {meetings, catalog, org, meetingsConfig}
 * @returns {Array<Object>} local first, then foreign
 */
export function routeBlockersToMeeting(blockers = [], meetingId, opts = {}) {
  const meetings = loadMeetings(opts.meetings);
  if (!meetings.length || !meetingId) return (blockers || []).map((b) => ({ ...b }));

  const cfg = crossMeetingConfig(opts.meetingsConfig ?? opts.meetings);
  const catalog = opts.catalog;
  const nameFor = opts.nameFor || ((dept) => dept);

  const local = [];
  const foreign = [];

  for (const b of (blockers || [])) {
    if (!b) continue;
    const r = resolveCrossMeeting(b, meetings, catalog);
    const raisedHere = r.raisedIn.some((m) => m.id === meetingId);
    const neededHere = r.needsIn.some((m) => m.id === meetingId);

    const annotated = {
      ...b,
      crossMeeting: r.cross,
      raisedInMeetings: r.raisedIn.map((m) => m.id),
      needsInMeetings: r.needsIn.map((m) => m.id)
    };

    if (raisedHere) { local.push(annotated); continue; }
    if (!neededHere || !r.cross || !cfg.surfaceInBothRooms) continue;

    const from = r.raisedIn[0];
    foreign.push({
      ...annotated,
      foreign: true,
      fromMeetingId: from ? from.id : null,
      fromMeetingName: from ? from.name : null,
      fromMeetingDay: from ? from.day : null,
      // The PERSON, not just the team. "US Sales needs something" is a fact;
      // "Anupreet is waiting on you since Wednesday" is a conversation.
      raisedByName: b.raisedByName || nameFor(b.raisedBy) || b.raisedBy || null
    });
  }

  return [...local, ...foreign];
}

export default loadMeetings;
