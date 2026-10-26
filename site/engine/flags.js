/**
 * flags.js - the "Still need from Sai" cards.
 *
 * This is the module that replaces a human chasing people. It turns the health
 * of a snapshot into a named, owned, dated ask. Three rules:
 *
 *   missing_data   the number never arrived - say which source and the exact error
 *   stale_source   the number is older than the period - say how many days
 *   off_target     crit, OR warn AND getting worse
 *   no_target      nobody has committed to a number (only when require_targets)
 *   last_minute    the source was assembled for the meeting, not maintained
 *   no_owner       nobody is accountable for this number, or the name on it is
 *                  not on the team (only when _accountability.require_metric_owner)
 *
 * Every flag but one names ONE person - the metric's accountable owner from
 * org.json's trio. no_owner is the single exception, and is addressed to the
 * whole trio on purpose: choosing which of them owns the metric is the only
 * thing the three of them can usefully do together.
 *
 * The off_target clause is the whole design. A warn that is improving is not a
 * problem, it is progress, and flagging it trains the founder to ignore flags.
 *
 * missing_data / stale_source / off_target are mutually exclusive - they are
 * three answers to one question, "is this number usable". no_target and
 * last_minute are orthogonal to that: one is about the metric's configuration,
 * the other about how the source is kept, and either can be true of a number
 * that is otherwise perfectly healthy.
 */

import { formatValue } from './caption.js';
import { freshnessDetail } from './freshness.js';
import {
  OWNER_NEEDED, joinNames, metricOwner, ownerFor as resolveOwner, requireMetricOwner
} from './owners.js';

const KIND_ORDER = {
  missing_data: 0, stale_source: 1, rag_stale: 2, off_target: 3,
  last_minute: 4, no_target: 5, no_owner: 6
};

/** Snapshots may arrive as an array or as a map keyed by metric id. */
function toSnapshotArray(snapshots) {
  if (Array.isArray(snapshots)) return snapshots;
  if (snapshots && typeof snapshots === 'object') return Object.values(snapshots);
  return [];
}

function indexDefs(defs) {
  const byId = new Map();
  for (const def of (Array.isArray(defs) ? defs : [])) {
    if (def && def.id) byId.set(def.id, def);
  }
  return byId;
}

/**
 * Who gets named on a DEPARTMENT-level ask: the trio's lead, else its first
 * name, else "[OWNER NEEDED]" when the trio is declared but empty, else the
 * department's label - a flag with nobody's name on it is a flag nobody picks
 * up. The full ladder lives in owners.js; this is the re-export every caller
 * already imports.
 *
 * For a METRIC-level ask use metricOwner() instead. The trio owns the line of
 * business; one of them owns each metric, and the flag names that one.
 */
export const ownerFor = resolveOwner;

function sourceEntry(sources, ref) {
  const list = (sources && (Array.isArray(sources) ? sources : sources.sources)) || [];
  return list.find((s) => s && s.id === ref) || null;
}

/** Plain-English name for a unit, for the "what does good look like" prompt. */
function unitWord(unit) {
  switch (unit) {
    case 'currency_inr': return 'rupees';
    case 'currency_usd': return 'dollars';
    case 'percent': return 'percent';
    case 'duration': return 'seconds';
    case 'duration_days': return 'days';
    default: return 'whole numbers';
  }
}

function sourceLabel(sources, ref) {
  const entry = sourceEntry(sources, ref);
  return (entry && entry.label) || ref || 'unknown source';
}

/** "Subham, Arfin and Raghav", or the placeholder when nobody is named. */
function teamOrNeeded(team) {
  return team && team.length ? joinNames(team) : OWNER_NEEDED;
}

function deptLabelFor(dept, org) {
  const match = ((org && org.departments) || []).find((d) => d && d.id === dept);
  return (match && match.label) || dept || 'this line of business';
}

const toTime = (v) => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

function daysBetween(fromIso, toIso) {
  const a = toTime(fromIso);
  const b = toTime(toIso);
  if (a === null || b === null) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * @param {import('./types.js').Snapshot[]|Record<string,import('./types.js').Snapshot>} snapshots
 * @param {import('./types.js').MetricDef[]} defs
 * @param {Object} [config]
 * @param {Object} [config.org]      org.json
 * @param {Object} [config.sources]  sources.json
 * @param {Object} [config.catalog]  catalog.json - read for _targets.require_targets
 * @param {boolean} [config.requireTargets] explicit override of the catalog setting
 * @param {Record<string, import('./types.js').Rows>} [config.rowsByMetric] what each metric actually read
 * @param {string} [config.meetingAt] ISO - when the review starts, for last_minute bodies
 * @param {string} [config.now] ISO - raisedAt
 * @returns {import('./types.js').Flag[]}
 */
export function deriveFlags(snapshots, defs, config = {}) {
  const org = config.org || {};
  const sources = config.sources || {};
  const catalog = config.catalog || {};
  const rowsByMetric = config.rowsByMetric || {};
  const now = config.now || new Date().toISOString();
  const meetingAt = config.meetingAt || now;
  const byId = indexDefs(defs);

  // catalog.json is where _targets lives; org.json is accepted as a fallback so
  // the setting can move without a code change. Default off: a repo that has
  // never opted in should not suddenly flood the founder with setup flags.
  const requireTargets = config.requireTargets !== undefined
    ? !!config.requireTargets
    : !!((catalog._targets && catalog._targets.require_targets)
      || (org._targets && org._targets.require_targets));

  // Same opt-in discipline for the second goal: a repo that has not declared
  // _accountability.require_metric_owner is not told off about it.
  const wantMetricOwner = config.requireMetricOwner !== undefined
    ? !!config.requireMetricOwner
    : requireMetricOwner(org, catalog);

  const freshnessConfig = org.freshness || {};

  /** @type {import('./types.js').Flag[]} */
  const flags = [];

  for (const snap of toSnapshotArray(snapshots)) {
    if (!snap || !snap.metricId) continue;
    const def = byId.get(snap.metricId);
    if (!def) continue;

    const dept = def.dept;
    // THE ACCOUNTABILITY RULE. The trio owns the line of business; ONE of them
    // owns this metric, and that is the name on this flag. A flag addressed to
    // three people is addressed to nobody.
    const accountable = metricOwner(def, org);
    const owner = accountable.name;
    const ref = def.source && def.source.ref;
    const label = sourceLabel(sources, ref);
    const rows = rowsByMetric[snap.metricId] || null;

    const base = {
      dept,
      owner,
      // The trio rides along so a renderer can show who else is on the line of
      // business without the flag itself ever being addressed to all three.
      ...(accountable.team.length ? { ownerTeam: accountable.team } : {}),
      raisedBy: 'engine',
      raisedAt: now,
      resolvedAt: null,
      metricIds: [snap.metricId]
    };

    // --- is this number usable? exactly one of these three, or none ---------
    if (snap.health === 'missing') {
      const error = (rows && rows.error)
        || (snap.warnings && snap.warnings[0])
        || 'the source returned nothing and gave no reason';
      flags.push({
        ...base,
        // stable and deterministic: the same problem two weeks running is the
        // same flag id, so "this has been open 14 days" is answerable
        id: `missing_data:${snap.metricId}`,
        kind: 'missing_data',
        title: `${def.label} is missing`,
        body: `${label} did not return a value for "${def.label}". Error: ${error}. ${owner} owns this source - it needs a successful sync before the next review.`
      });
    } else if (snap.health === 'stale') {
      const lastSynced = rows ? (rows.asOf || rows.fetchedAt || null) : null;
      const days = daysBetween(lastSynced, now);
      const age = days === null ? 'an unknown number of days'
        : days <= 0 ? 'less than a day'
          : `${days} day${days === 1 ? '' : 's'}`;
      flags.push({
        ...base,
        id: `stale_source:${snap.metricId}`,
        kind: 'stale_source',
        title: `${def.label} is stale`,
        body: `${label} was last synced ${lastSynced || 'at an unknown time'} - ${age} old, which is before this period started. "${def.label}" is showing ${formatValue(snap.raw, snap.unit || def.unit)} from the previous period. ${owner} owns this source.`
      });
    } else {
      const gettingWorse = typeof snap.delta === 'number' && snap.delta < 0;
      if (snap.health === 'crit' || (snap.health === 'warn' && gettingWorse)) {
        const value = formatValue(snap.raw, snap.unit || def.unit);
        const target = formatValue(def.target, snap.unit || def.unit);
        const trend = gettingWorse
          ? ` Down ${Math.abs(snap.delta)} points on the ring since last period.`
          : '';
        flags.push({
          ...base,
          id: `off_target:${snap.metricId}`,
          kind: 'off_target',
          title: `${def.label} is off target`,
          body: `${def.label} is at ${value} against a target of ${target}.${trend} ${owner} owns this number.`
        });
      }
    }

    // --- orthogonal: has anyone committed to a number at all? ---------------
    if (requireTargets && (def.target === null || def.target === undefined)) {
      flags.push({
        ...base,
        id: `no_target:${snap.metricId}`,
        kind: 'no_target',
        title: `${def.label} has no target`,
        body: `"${def.label}" is being reported with no target, so it can be read but not judged. ${owner} sets this one: what does a good week look like, in ${unitWord(snap.unit || def.unit)}? Until it is set this metric cannot appear on the scoreboard.`
      });
    }

    // --- orthogonal: was the source maintained, or assembled? ---------------
    if (snap.freshness === 'last_minute') {
      const detail = rows ? freshnessDetail(rows, sourceEntry(sources, ref), meetingAt, freshnessConfig) : null;
      const share = detail && detail.lastMinuteShare !== null
        ? `${Math.round(detail.lastMinuteShare * 100)}% of its rows`
        : 'most of its rows';
      const window = freshnessConfig.last_minute_window_hours || 24;
      flags.push({
        ...base,
        id: `last_minute:${snap.metricId}`,
        kind: 'last_minute',
        // Deliberately flat. This is an observation about a data source, not a
        // judgement about a person, and the wording has to survive being read
        // out in a room with that person in it.
        body: `${label} had ${share} written in the ${window} hours before this review. The number may be perfectly accurate; what it suggests is that this source is being compiled for the meeting rather than used to run the function day to day. Worth asking ${owner} whether a lighter metric they already look at would serve better.`,
        title: `${label} was assembled for this meeting`
      });
    }

    // --- orthogonal: is there ONE name on this metric? ----------------------
    // Deliberately separate from no_target. A metric can have a target nobody
    // answers for, and a metric can have an owner but no number to hit; they
    // are two different halves of "accountability against targets" and they go
    // to two different conversations.
    if (!accountable.valid) {
      // A name that is not in the trio addresses nobody, which is the exact
      // failure a single accountable owner was introduced to prevent - and it
      // is silent, because the flag still renders with a plausible name on it.
      // Flagged, never thrown: a spelling mistake must not take the run down.
      flags.push({
        ...base,
        id: `no_owner:${snap.metricId}`,
        kind: 'no_owner',
        owner: teamOrNeeded(accountable.team),
        title: `${def.label} names an owner who is not on this team`,
        body: `"${def.label}" lists ${accountable.declared} as its accountable owner, but `
          + `${accountable.declared} is not one of ${teamOrNeeded(accountable.team)}, who own `
          + `${deptLabelFor(dept, org)}. Every flag about this metric would be addressed to somebody `
          + `who is not on the line of business, which reads as owned and is not. `
          + `Correct the spelling in catalog.json, or add ${accountable.declared} to the team in org.json.`
      });
    } else if (wantMetricOwner && !accountable.assigned) {
      flags.push({
        ...base,
        id: `no_owner:${snap.metricId}`,
        kind: 'no_owner',
        // The ONE flag that is deliberately addressed to all three, because
        // picking which of them owns it is the only thing the three of them can
        // do together. Every other flag names one person.
        owner: teamOrNeeded(accountable.team),
        title: `${def.label} has no single accountable owner`,
        body: accountable.team.length
          ? `${teamOrNeeded(accountable.team)} own ${deptLabelFor(dept, org)} between them, and nobody `
            + `has been named on "${def.label}". A flag addressed to ${accountable.team.length} people is `
            + `addressed to nobody - each assumes one of the others has it. One of you takes this metric: `
            + `set "owner" on ${snap.metricId} in catalog.json. Until then it falls to ${owner}.`
          : `Nobody is named on ${deptLabelFor(dept, org)} at all, so "${def.label}" has no accountable `
            + `owner and no team to pick one from. Name the line of business in org.json owners first, `
            + `then set "owner" on ${snap.metricId}.`
      });
    }
  }

  flags.sort((a, b) => {
    const k = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (k !== 0) return k;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return flags;
}

/* ------------------------------------------------------------------------ *
 * RAG flags - asks that come out of a human judgement, not a measurement
 * ------------------------------------------------------------------------ */

/** "5 days" / "1 day". */
const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * Turn the RAG rollup into named asks.
 *
 * Two of them, and they are deliberately different kinds:
 *
 *   off_target  a subject that has been red for red_days_to_flag consecutive
 *               days. One red day is a bad day. Three in a row is a thing nobody
 *               has decided about, and the ask is for the department owner to
 *               say what changes - which is the same ask a metric below target
 *               generates, hence the same kind.
 *
 *   rag_stale   nobody has made the call. NOT stale_source, even though the word
 *               stale fits both, because the two ask different people for
 *               different things: stale_source says a system did not sync and
 *               wants a connection fixed; rag_stale says a person did not make a
 *               judgement and wants thirty seconds in tomorrow's stand-up.
 *               Collapsing them would file "go and look at this track" under
 *               "go and fix a pipeline", and it would be ignored.
 *
 * Nothing here is specific to brands or to Performance Marketing - the subject
 * is whatever the department calls colours on, and the owner comes from
 * org.json, so a department adopting RAG needs no change here.
 *
 * @param {ReturnType<import('./rag.js').rollupRag>} rollup
 * @param {Object} [config]
 * @param {Object} [config.org]  org.json, for the owner's name
 * @param {string} [config.now]  ISO - raisedAt
 * @returns {import('./types.js').Flag[]}
 */
export function deriveRagFlags(rollup, config = {}) {
  if (!rollup || !Array.isArray(rollup.departments)) return [];

  const org = config.org || {};
  const now = config.now || rollup.now || new Date().toISOString();
  const cfg = rollup.config || {};
  const redDays = Number(cfg.red_days_to_flag) || 3;
  const staleHours = Number(cfg.stale_after_hours) || 48;

  /** @type {import('./types.js').Flag[]} */
  const flags = [];

  for (const dept of rollup.departments) {
    const owner = ownerFor(dept.dept, org);

    for (const item of (dept.subjects || dept.brands || [])) {
      const subject = item.subject || item.brand;
      const base = {
        dept: dept.dept,
        owner,
        raisedBy: 'engine',
        raisedAt: now,
        resolvedAt: null,
        metricIds: []
      };

      if (item.status === 'red' && item.daysHeld >= redDays) {
        flags.push({
          ...base,
          id: `off_target:rag:${dept.dept}:${subject}`,
          kind: 'off_target',
          title: `${subject} has been red for ${dayWord(item.daysHeld)}`,
          // Says whose call it is and quotes their reason, so the room argues
          // with the judgement rather than with the dashboard.
          body: `${subject} has been called red ${dayWord(item.daysHeld)} running, most recently by `
            + `${item.setBy || 'an unnamed caller'}: "${item.reason}". This is a human call from the daily `
            + `stand-up, not a computed figure - it can be argued with. What it cannot be is left at red for `
            + `another week without a decision. ${owner} owns the answer.`
        });
      }

      if (item.stale) {
        const age = item.ageHours === null
          ? 'at an unknown time'
          : item.ageHours < 48
            ? `${Math.round(item.ageHours)} hours ago`
            : `${dayWord(Math.floor(item.ageHours / 24))} ago`;
        flags.push({
          ...base,
          id: `rag_stale:${dept.dept}:${subject}`,
          kind: 'rag_stale',
          title: `No recent status call on ${subject}`,
          body: `${subject} was last called ${item.status} ${age} by ${item.setBy || 'an unnamed caller'}, `
            + `which is past the ${staleHours}-hour line for a call that is meant to be made daily. `
            + `The colour on the dashboard is an artefact of the last stand-up, not a current read, so it is `
            + `shown as stale rather than carried forward. ${owner} makes this call - it takes thirty seconds `
            + `in tomorrow's stand-up.`
        });
      }
    }
  }

  flags.sort((a, b) => {
    const k = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (k !== 0) return k;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return flags;
}

export default deriveFlags;
