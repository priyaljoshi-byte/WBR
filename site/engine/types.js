/**
 * THE CONTRACT
 * ============
 * Every module in Pulse speaks these shapes and nothing else. Connectors produce
 * Rows. The engine turns Rows + MetricDef into a Snapshot. The renderer turns
 * Snapshots into HTML. The transcript layer turns words into Decisions and Notes.
 *
 * Nothing imports across those boundaries except through the types below. That is
 * the whole reason a new data source, a new metric or a new department is config
 * rather than code.
 */

/**
 * @typedef {Object} Rows
 *   What every connector returns, whatever it read from.
 * @property {string} sourceRef        id from sources.json
 * @property {string[]} columns        header names, lowercased and trimmed
 * @property {Array<Record<string, any>>} rows
 * @property {string} fetchedAt        ISO timestamp
 * @property {'ok'|'empty'|'error'} status
 * @property {string} [error]          human-readable, shown on the flag card
 * @property {string} [asOf]           if the source states its own freshness date
 * @property {string[]} [warnings]     non-fatal complaints from the connector itself:
 *                                     a cell that is not a date, a slash column whose
 *                                     order could not be settled. computeSnapshot
 *                                     copies these onto the Snapshot so they reach the
 *                                     dashboard footer instead of a log nobody opens.
 */

/**
 * @typedef {Object} Denominator
 *   What a ring is a fraction OF. This is the single most important field in the
 *   system: normalized = raw / denominator * 100, and that is the ring's arc.
 * @property {'static'|'metric'|'column_total'|'self'} kind
 *   static       fixed number, e.g. "of 5 channels"
 *   metric       another metric's raw value, e.g. "of total pipeline"
 *   column_total sum of a column across all rows before filtering
 *   self         no fraction - the metric IS the number (tiles, totals)
 * @property {number} [value]          for kind=static
 * @property {string} [metric]         for kind=metric
 * @property {string} [column]         for kind=column_total
 * @property {string} [label]          trailing word in the caption, e.g. "running"
 */

/**
 * @typedef {Object} SourceQuery
 * @property {string} ref              sources.json key
 * @property {string} [tab]            sheet tab / notion view / table name
 * @property {'sum'|'avg'|'count'|'count_distinct'|'latest'|'min'|'max'|'ratio'|'median'} agg
 *   ratio   sum(numerator_column) / sum(denominator_column) - CPL, CAC, win rate.
 *           A zero denominator yields null, never Infinity.
 *   median  the middle value, which is the honest average for cycle time and
 *           time-to-close where one 90-day outlier drags a mean somewhere useless.
 * @property {string} [column]         required for everything except count and ratio
 * @property {string} [numerator_column]   for agg=ratio
 * @property {string} [denominator_column] for agg=ratio
 * @property {Object} [where]          {column, equals|in|gt|gte|lt|lte|contains}
 */

/**
 * @typedef {Object} MetricDef
 * @property {string} id
 * @property {string} label
 * @property {string} dept
 * @property {'count'|'currency_inr'|'currency_usd'|'percent'|'duration'|'duration_days'} unit
 *   currency_inr  Indian conventions: Cr / L. NEVER applied to USD.
 *   currency_usd  Western conventions: K / M.
 *   duration      seconds, rendered 1m43s
 *   duration_days days, rendered 12d / 1.5d
 * @property {SourceQuery} source
 * @property {Denominator} denominator
 * @property {string} [segment]        e.g. "india" | "us". A DIMENSION on the metric,
 *                                     not a separate department, so the rollup to a
 *                                     total stays automatic rather than manual.
 * @property {string} [family]         metrics that sum to one total, e.g. "pm_spend".
 *                                     See rollupFamily() in rollup.js.
 * @property {'up'|'down'} direction   up = higher is better
 * @property {number|null} target      raw units. null = tracked, not judged -
 *                                     and, when catalog _targets.require_targets is
 *                                     on, a no_target flag with the owner's name on it.
 * @property {number|null} warn_at     fraction of target, e.g. 0.7
 * @property {number|null} crit_at     fraction of target, e.g. 0.4
 * @property {string} caption          template: {{raw}} {{denominator}} {{denominator_label}}
 */

/**
 * @typedef {'good'|'warn'|'crit'|'stale'|'missing'|'untracked'} Health
 *   good       at or above target pace
 *   warn       below warn_at
 *   crit       below crit_at
 *   stale      source last synced before this period started - the number is old
 *   missing    source returned nothing, or errored
 *   untracked  no target set. Shown, never flagged. Most ratio rings are this.
 *
 * Health NEVER changes a ring's colour. Ring colour is positional (outer=red,
 * middle=lime, inner=cyan) so the eye can compare the same slot across cards.
 * Health surfaces as a flag card and a card border, which is what you scan for.
 */

/**
 * @typedef {'daily'|'weekly'|'last_minute'|'stale'|'unknown'} Freshness
 *   HOW the data was maintained, which is a different question from whether the
 *   number is right.
 *
 *   daily        rows carry recent edits spread over time - someone runs on this
 *   weekly       maintained, but on a weekly rhythm
 *   last_minute  at least freshness.last_minute_row_share of the rows were written
 *                inside the last_minute_window_hours before the meeting. The number
 *                may well be correct; the signal is that the team is not using it to
 *                run the function, they are assembling it for the review.
 *   stale        newest row predates even the weekly window
 *   unknown      the source exposes no row-level timestamp. We do not guess.
 */

/**
 * @typedef {Object} Snapshot
 *   One metric, one period, frozen. This is the unit of history. Everything the
 *   founder sees is read from snapshots, never recomputed live - which is why the
 *   dashboard is instant and why last week's number cannot silently change.
 * @property {string} runId
 * @property {string} metricId
 * @property {string} periodStart      ISO date
 * @property {string} periodEnd        ISO date
 * @property {number|null} raw
 * @property {number|null} denominator
 * @property {number|null} normalized  0..100, clamped. The ring arc.
 * @property {number|null} priorRaw
 * @property {number|null} priorNormalized
 * @property {number|null} delta        normalized - priorNormalized
 * @property {Health} health
 * @property {Freshness} freshness      how the data was maintained, not whether it is right
 * @property {string} unit              frozen WITH the value: if someone re-denominates
 *                                      a metric next quarter, last quarter's snapshot
 *                                      must still render in the unit it was measured in.
 * @property {string} [segment]         copied from the def, so a rollup needs no join
 * @property {string} [family]
 * @property {string} caption           rendered, e.g. "4 of 5 running"
 * @property {number} rowCount          how many source rows fed this
 * @property {string} computedAt
 * @property {string[]} warnings        non-fatal issues worth printing in the footer
 * @property {number|null} [statedValue] what someone SAID in the meeting
 * @property {string} [statedBy]
 */

/**
 * @typedef {Object} RagStatus
 *   A JUDGEMENT, not a measurement. Everything else in this file is arithmetic
 *   performed on rows; this is one person's read of something, made out loud in
 *   a daily stand-up and recorded with their name on it.
 *
 *   Why it is not computed: Performance Marketing runs campaigns for brands of
 *   wildly different scale, on different objectives, with different cost bases.
 *   There is no number that is comparable across them - a CPL that is excellent
 *   for one brand is a disaster for another - so "is this in trouble" is a
 *   question a human answers by reading several numbers together. Computing a
 *   colour would mean inventing the comparability that does not exist, and the
 *   result would be a number dressed as a judgement, which is worse than either.
 *
 *   Why `subject` and not `brand`: the WBR already runs status-by-track sections
 *   across the whole org - US Lead Gen, Marketing, SEO - each a coloured bullet
 *   with a one-line narrative. The thing a colour is about is therefore generic.
 *   Perf Marketing's subjects are brands; Marketing's are tracks. `brand` is
 *   accepted as an alias and echoed back, so per-brand callers need no change
 *   and a department calling colours per track needs no code change either.
 *
 *   Why the distinction from a metric is kept visible all the way to the screen:
 *   a judgement carries different weight than an arithmetic result. It can be
 *   argued with, it has an author, and it goes stale if nobody repeats it. A
 *   measured ring has none of those properties. The renderer gives RAG its own
 *   section, its own shape and the words "daily stand-up judgement" precisely so
 *   that nobody reads a human's call as a computed figure, or the reverse.
 *
 * @property {string} subject        what the call is about: a brand, a track, a
 *                                   workstream. Whatever the department runs on.
 * @property {string} [brand]        alias for subject, kept for per-brand callers
 * @property {string} dept           department id - any of them, not just perf_marketing
 * @property {'red'|'amber'|'green'|'grey'} status
 *   grey   not started, or no signal yet. The company's white bullet. NOT a
 *          quieter amber: amber means somebody looked and is worried, grey means
 *          there is nothing to look at yet. Folding grey into amber would turn
 *          every unstarted track into a concern and bury the real ones.
 * @property {string} reason         REQUIRED. A colour with no reason is not a
 *                                   judgement, it is a mood - there is nothing
 *                                   to agree with, disagree with or act on.
 *                                   rollupRag() drops a reasonless status and
 *                                   warns rather than displaying it.
 * @property {string} setBy          the person who made the call, by name
 * @property {string} setAt          ISO timestamp - when it was made. Staleness
 *                                   is measured from here, because this is a
 *                                   DAILY call: yesterday's colour unrepeated is
 *                                   an absence of a judgement, not a judgement.
 * @property {string} periodStart    ISO date - the day the call is ABOUT, which
 *                                   is not always the day it was typed. Streaks
 *                                   are counted on this, so a late entry still
 *                                   lands on the right day.
 */

/**
 * @typedef {Object} Flag
 *   The "Still need from Sai" cards. Most are raised by the engine, not typed by
 *   a human. That is the point: chasing missing data stops being your job.
 * @property {string} id
 * @property {string} dept
 * @property {string} owner             ONE person's name - the metric's accountable
 *                                      owner from its department's trio. A flag
 *                                      addressed to three people is addressed to
 *                                      nobody. The sole exception is no_owner.
 * @property {string[]} [ownerTeam]     the trio behind that one name, for context
 *                                      and notification. Never the address.
 * @property {string} title
 * @property {string} body
 * @property {'missing_data'|'stale_source'|'off_target'|'no_target'|'no_owner'|'last_minute'|'rag_stale'|'no_proof'|'overdue'|'contradiction'|'manual'} kind
 *   no_target    a metric nobody has committed to a number on. Raised only when
 *                catalog _targets.require_targets is true. This list shrinking to
 *                zero IS the setup process.
 *   no_owner     a metric nobody is accountable for, OR one whose named owner is
 *                not in its department's trio - a typo'd name reads as owned and
 *                addresses nobody, which is worse than no name at all. Raised only
 *                when org _accountability.require_metric_owner is true, and it is
 *                the one flag addressed to the whole trio, because picking which
 *                of them owns the metric is the only thing all three can do.
 *   last_minute  the source was assembled in the hours before the meeting rather
 *                than maintained. See the Freshness typedef.
 *   rag_stale    nobody has made a brand's daily RAG call recently. DELIBERATELY
 *                a separate kind from stale_source, because the ask is different:
 *                stale_source means a system did not sync and the fix is a
 *                connection, rag_stale means a person did not make a judgement
 *                and the fix is thirty seconds in tomorrow's stand-up. Filing
 *                both under one kind would send the wrong instruction to the
 *                wrong person.
 * @property {'engine'|'transcript'|'manual'} raisedBy
 * @property {string} raisedAt
 * @property {string|null} resolvedAt
 * @property {string[]} [metricIds]
 * @property {string} [decisionId]
 */

/**
 * @typedef {'NEW'|'CONFIRMED'|'CHANGED'|'REVERSED'|'COMPLETED'|'PARTIAL'|'BLOCKED'|'DEFERRED'|'DROPPED'|'OPEN'} DecisionStatus
 */

/**
 * @typedef {Object} Decision
 *   Carried across meetings. The continuity spine. A decision is never deleted -
 *   it changes status and keeps its history, so "what did we decide in September"
 *   always has an answer.
 * @property {string} id
 * @property {number} number            display order, most consequential first
 * @property {string} domain            Customer|Product|Engineering|Design|Go-to-market|Sales|Delivery|Pricing|Business model|Hiring|Organization|Capital|Partnerships|Geography|Risk|Governance
 * @property {string} headline          the decision as a conclusion, under 14 words
 * @property {DecisionStatus} status
 * @property {string} carriedIn         previous position + expected proof, under 70 words
 * @property {string} evidence          what was learned this meeting
 * @property {string} decided           the decision + the tradeoff accepted
 * @property {string} beforeNextReview  next action, owner, deadline, proof
 * @property {string} strip             one sentence, under 24 words
 * @property {string|null} owner        null renders as [OWNER NEEDED]
 * @property {string|null} dueDate      null renders as [DATE NEEDED]
 * @property {string} reopenCondition
 * @property {string[]} metricIds       THE ENRICHMENT LINK. Which rings prove this
 *                                      decision worked. Next week the dashboard can
 *                                      say how they moved.
 * @property {string} firstSeenMeeting
 * @property {string} lastTouchedMeeting
 * @property {boolean} previousStateUnverified
 */

/**
 * @typedef {Object} DecisionEvent
 *   One row per time a decision was touched. Replaying these reconstructs the
 *   decision's whole life, which is what makes "what changed and why" answerable
 *   without reading a single transcript.
 * @property {string} decisionId
 * @property {string} meetingId
 * @property {DecisionStatus|null} fromStatus
 * @property {DecisionStatus} toStatus
 * @property {string} reason            required whenever status is CHANGED, REVERSED, DEFERRED or DROPPED
 * @property {string} [quote]           exact words, only when the exact words matter
 * @property {string} at
 */

/**
 * @typedef {'open'|'resolved_in_room'|'owner_assigned'|'escalated'|'dropped'|'carried'} BlockerStatus
 */

/**
 * @typedef {Object} Blocker
 *   A cross-functional dependency with a person on BOTH ends and an age.
 *
 *   This is a first-class object and not a bullet inside someone's written update,
 *   because a bullet inside an update is exactly the thing that leaves one person
 *   chasing another alone for three weeks. Two named ends make it resolvable in the
 *   room. The age makes the third week visibly different from the first without
 *   anyone having to remember that it is.
 *
 *   NOT a blocker: a general difficulty, a market condition, a complaint, a risk.
 *   A blocker names another team or person and a specific thing they owe.
 *
 * @property {string} id
 * @property {string} title            the dependency as one line, under 14 words
 * @property {string} raisedBy         department id - who is blocked
 * @property {string|null} needsFrom   department id or person - who can unblock.
 *                                     REQUIRED by org.json blockers.require_needs_from:
 *                                     "I am blocked" without a named other end is
 *                                     not actionable, it is a mood.
 * @property {string} what             the specific ask, not the topic
 * @property {string} impact           what does not happen until this clears
 * @property {string[]} metricIds      which numbers this holds back. The link to
 *                                     "accountability against targets".
 * @property {string} raisedAt         ISO date it was first raised
 * @property {number} ageWeeks         1 in the week it was raised. Computed, never typed.
 * @property {BlockerStatus} status
 * @property {string|null} owner       null renders as [OWNER NEEDED]
 * @property {string|null} dueDate     null renders as [DATE NEEDED]
 * @property {string} resolution       how it was settled. Required for resolved_in_room.
 * @property {string|null} resolvedAt
 * @property {string} firstSeenMeeting
 * @property {string} lastTouchedMeeting
 *
 * @property {boolean} [crossMeeting]  true when raisedBy and needsFrom sit in
 *                                     DIFFERENT weekly reviews. There is no fifth
 *                                     leadership meeting, so these two parties are
 *                                     never in a room together and the blocker has
 *                                     nowhere to be resolved. It is surfaced in BOTH
 *                                     rooms and escalated on its first appearance -
 *                                     age is the wrong test when the parties were
 *                                     never in the same room. See engine/meetings.js
 *                                     isCrossMeeting() and config/meetings.json
 *                                     _no_overview_meeting.
 * @property {string[]} [raisedInMeetings] meeting ids the raiser attends
 * @property {string[]} [needsInMeetings]  meeting ids the other end attends
 */

/**
 * @typedef {Object} ForeignBlocker
 *   A cross-meeting Blocker as it appears in the OTHER room: the room of the team
 *   that can unblock it, who were not present when it was raised. Same object,
 *   plus where it came from, so the team that can clear it sees it in their own
 *   room without anyone forwarding an email.
 *
 *   It is rendered unlike a locally-raised blocker on purpose. The ask is
 *   different: a local blocker asks this room to chase someone, a foreign one
 *   asks this room to answer.
 *
 * @property {true} foreign
 * @property {string} fromMeetingId
 * @property {string} fromMeetingName   named on the card: "raised in <meeting>"
 * @property {string} fromMeetingDay
 * @property {string} raisedByName      the PERSON who raised it, not just the team
 */

/**
 * @typedef {Object} BlockerEvent
 *   One row per time a blocker was touched. Same reason as DecisionEvent: replaying
 *   these answers "how long did this sit, and who moved it" without a transcript.
 * @property {string} blockerId
 * @property {string} meetingId
 * @property {BlockerStatus|null} fromStatus
 * @property {BlockerStatus} toStatus
 * @property {string} reason
 * @property {string} [quote]
 * @property {number} ageWeeks
 * @property {string} at
 */

/**
 * @typedef {Object} MeetingMember
 *   A DEPARTMENT AND A SEGMENT, not a department.
 *
 *   Performance Marketing has no meeting of its own: Perf India is read in the
 *   Tuesday India charter, Perf US in the Wednesday US charter. A member with a
 *   segment selects ONLY the metrics carrying that segment. A department-only
 *   model would put the whole of Perf Marketing in both rooms, and each room
 *   would be reading half a number it cannot act on.
 *
 * @property {string} dept
 * @property {string|null} segment   null = the whole department
 */

/**
 * @typedef {Object} MeetingCharter
 *   One of the four weekly reviews, from config/meetings.json. Not to be
 *   confused with Meeting below, which is one OCCURRENCE of a review with a
 *   transcript attached.
 * @property {string} id
 * @property {string} name
 * @property {string|null} day
 * @property {MeetingMember[]} members
 * @property {string[]} sections      which sections this room reads
 * @property {string|null} chair
 */

/**
 * @typedef {Object} Meeting
 * @property {string} id
 * @property {string} date
 * @property {string} kind              wbr | product review | board | ...
 * @property {string[]} attendees
 * @property {string|null} transcriptPath
 * @property {string|null} processedAt
 */

/**
 * @typedef {Object} Note
 *   The one line under a ring card. Comes from the meeting, not the data - the
 *   engine knows the number moved, only the room knows why.
 * @property {string} cardId
 * @property {string} text
 * @property {string} meetingId
 * @property {string} [quote]
 */

/**
 * @typedef {Object} Run
 * @property {string} id
 * @property {string} periodStart
 * @property {string} periodEnd
 * @property {string} startedAt
 * @property {string|null} finishedAt
 * @property {'running'|'ok'|'partial'|'failed'} status
 * @property {string} triggeredBy       cron | manual | meeting
 */

export const DECISION_STATUSES = [
  'NEW', 'CONFIRMED', 'CHANGED', 'REVERSED', 'COMPLETED',
  'PARTIAL', 'BLOCKED', 'DEFERRED', 'DROPPED', 'OPEN'
];

/** Status values that close a decision out - it stops appearing as carried-forward. */
export const TERMINAL_STATUSES = ['COMPLETED', 'DROPPED', 'REVERSED'];

/** Status changes that MUST carry a reason, or the run refuses to publish. */
export const REASON_REQUIRED = ['CHANGED', 'REVERSED', 'DEFERRED', 'DROPPED'];

/** Mirrors org.json blockers.resolutions, plus the 'open' it starts in. */
export const BLOCKER_STATUSES = [
  'open', 'resolved_in_room', 'owner_assigned', 'escalated', 'dropped', 'carried'
];

/** Blocker states that close it out. Everything else keeps ageing. */
export const TERMINAL_BLOCKER_STATUSES = ['resolved_in_room', 'dropped'];

export const DOMAINS = [
  'Customer', 'Product', 'Engineering', 'Design', 'Go-to-market', 'Sales',
  'Delivery', 'Pricing', 'Business model', 'Hiring', 'Organization', 'Capital',
  'Partnerships', 'Geography', 'Risk', 'Governance'
];

/** Positional ring colours. Index 0 is the outermost ring. Never health-coded. */
export const RING_COLORS = ['#ff375f', '#c6f432', '#3ddbff'];

/** Ring geometry, matching the reference cards: r=64, 47, 30 on a 164x164 canvas. */
export const RING_RADII = [64, 47, 30];
