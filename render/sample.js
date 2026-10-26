/**
 * Sample render - a FORMAT FIXTURE, not a report.
 *
 * Every number below is invented. The point is to exercise the renderer across
 * all five lines of business and every state it has to survive: on target, off
 * target, stale, no target set, a card with two rings instead of three, a
 * blocker in its fourth week, a decision with no owner. When the real
 * connectors land, this file gets deleted and the engine supplies the same
 * shapes.
 *
 * Run with:  node render/sample.js
 */

import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveRagFlags } from '../engine/flags.js';
import { ownerTeam, teamLabel } from '../engine/owners.js';
import { rollupRag } from '../engine/rag.js';
import { renderDashboard } from './dashboard.js';
import { decisionPages } from './decisions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const catalog = JSON.parse(readFileSync(resolve(ROOT, 'config/catalog.json'), 'utf8'));
const org = JSON.parse(readFileSync(resolve(ROOT, 'config/org.json'), 'utf8'));

const RUN_ID = 'run-2026-w36';
const PERIOD_START = '2026-09-01';
const PERIOD_END = '2026-09-07';
const COMPUTED_AT = '2026-09-07T20:00:00+05:30';

const defsById = new Map(catalog.metrics.map(m => [m.id, m]));

/**
 * Snapshot factory. normalized is computed the way the engine computes it -
 * raw / denominator * 100, clamped - so the rings in the fixture are drawn
 * from the same arithmetic as the real thing.
 */
function snap(metricId, raw, denominator, caption, opts = {}) {
  const def = defsById.get(metricId);
  if (!def) throw new Error(`sample.js references a metric not in catalog.json: ${metricId}`);
  const normalized = opts.normalized !== undefined
    ? opts.normalized
    : (raw === null || denominator === null || !denominator
      ? null
      : Math.max(0, Math.min(100, Math.round((raw / denominator) * 100))));
  return {
    runId: RUN_ID,
    metricId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    raw,
    denominator,
    normalized,
    priorRaw: opts.priorRaw ?? null,
    priorNormalized: opts.priorNormalized ?? null,
    delta: (opts.priorNormalized === null || opts.priorNormalized === undefined || normalized === null)
      ? null
      : normalized - opts.priorNormalized,
    health: opts.health || 'untracked',
    caption,
    rowCount: opts.rowCount ?? 0,
    computedAt: COMPUTED_AT,
    warnings: opts.warnings || [],
    freshness: opts.freshness || 'weekly'
  };
}

/* ------------------------------------------------------------------ *
 * Snapshots, by line of business
 * ------------------------------------------------------------------ */

const snapshots = [
  /* ---- India Sales: healthy, updated daily ---- */
  snap('in_pipeline_india', 44700000, null, '₹4.47 Cr open',
    { health: 'untracked', rowCount: 31, freshness: 'daily', normalized: null }),
  snap('india_closed_won', 12600000, 15000000, '₹1.26 Cr of ₹1.5 Cr target',
    { health: 'good', rowCount: 4, freshness: 'daily', priorNormalized: 71 }),
  snap('india_in_poc', 13200000, 44700000, '₹1.32 Cr of ₹4.47 Cr open',
    { health: 'untracked', rowCount: 6, freshness: 'daily' }),
  snap('india_proposal', 4400000, 44700000, '₹44L',
    { health: 'untracked', rowCount: 3, freshness: 'daily' }),
  snap('india_created_wk', 8900000, null, '₹89L created',
    { health: 'untracked', rowCount: 5, freshness: 'daily', normalized: null }),
  snap('india_win_rate', 31, null, '31%',
    { health: 'untracked', rowCount: 31, freshness: 'daily', normalized: null }),

  snap('india_meetings_held', 18, 20, '18 of 20 target',
    { health: 'good', rowCount: 18, freshness: 'daily', priorNormalized: 75 }),
  snap('india_opps_created', 6, 8, '6 of 8 target',
    { health: 'warn', rowCount: 6, freshness: 'daily', priorNormalized: 88 }),
  snap('india_accounts_worked', 112, 150, '112 of 150 target',
    { health: 'warn', rowCount: 112, freshness: 'daily', priorNormalized: 70 }),

  /* ---- US Sales: off target, and the data was written last night ---- */
  snap('in_pipeline_us', 1240000, null, '$1.24M open',
    { health: 'untracked', rowCount: 12, freshness: 'last_minute', normalized: null }),
  snap('us_closed_won', 210000, 300000, '$210K of $300K target',
    { health: 'warn', rowCount: 2, freshness: 'last_minute', priorNormalized: 92 }),
  snap('us_in_poc', 420000, 1240000, '$420K of $1.24M open',
    { health: 'untracked', rowCount: 3, freshness: 'last_minute' }),
  snap('us_proposal', 310000, 1240000, '$310K',
    { health: 'untracked', rowCount: 4, freshness: 'last_minute' }),
  snap('us_created_wk', 185000, null, '$185K created',
    { health: 'untracked', rowCount: 3, freshness: 'last_minute', normalized: null }),
  snap('us_win_rate', 22, null, '22%',
    { health: 'untracked', rowCount: 12, freshness: 'last_minute', normalized: null }),

  snap('us_meetings_held', 9, 20, '9 of 20 target',
    { health: 'warn', rowCount: 9, freshness: 'last_minute', priorNormalized: 55 }),
  snap('us_opps_created', 2, 8, '2 of 8 target',
    {
      health: 'crit', rowCount: 2, freshness: 'last_minute', priorNormalized: 38,
      warnings: ['Every row in the US CRM tab was written in the 12 hours before this run']
    }),
  snap('us_accounts_worked', 64, 150, '64 of 150 target',
    { health: 'crit', rowCount: 64, freshness: 'last_minute', priorNormalized: 51 }),

  /* ---- Performance Marketing, India segment ---- */
  snap('pm_india_spend', 820000, 1000000, '₹8.2L of ₹10L budget',
    { health: 'good', rowCount: 7, freshness: 'daily', priorNormalized: 76 }),
  snap('pm_india_qualified', 48, 190, '48 of 190 leads',
    { health: 'untracked', rowCount: 48, freshness: 'daily' }),
  snap('pm_india_leads', 190, 220, '190 of 220 target',
    { health: 'good', rowCount: 190, freshness: 'daily', priorNormalized: 81 }),
  snap('pm_india_cpl', 4316, null, '₹4,316',
    { health: 'untracked', rowCount: 190, freshness: 'daily', normalized: null }),
  snap('pm_india_pipeline_sourced', 6200000, null, '₹62L sourced',
    { health: 'untracked', rowCount: 9, freshness: 'daily', normalized: null }),
  snap('pm_india_cac', 68500, null, '₹68,500',
    { health: 'untracked', rowCount: 9, freshness: 'daily', normalized: null }),

  /* ---- Performance Marketing, US segment: no targets set at all ---- */
  snap('pm_us_spend', 14800, null, '$14.8K of [NO TARGET SET]',
    { health: 'untracked', rowCount: 6, freshness: 'weekly', normalized: null }),
  snap('pm_us_qualified', 21, 96, '21 of 96 leads',
    { health: 'untracked', rowCount: 21, freshness: 'weekly' }),
  snap('pm_us_leads', 96, null, '96 of [NO TARGET SET]',
    { health: 'untracked', rowCount: 96, freshness: 'weekly', normalized: null }),
  snap('pm_us_cpl', 154, null, '$154',
    { health: 'untracked', rowCount: 96, freshness: 'weekly', normalized: null }),
  snap('pm_us_pipeline_sourced', 310000, null, '$310K sourced',
    { health: 'untracked', rowCount: 4, freshness: 'weekly', normalized: null }),
  snap('pm_us_cac', 2340, null, '$2,340',
    { health: 'untracked', rowCount: 4, freshness: 'weekly', normalized: null }),

  /* ---- Sloosh ---- */
  snap('sloosh_signups', 77, null, '77 signups',
    { health: 'untracked', rowCount: 77, freshness: 'daily', normalized: null }),
  snap('sloosh_activated', 59, 77, '59 of 77 signups',
    { health: 'untracked', rowCount: 59, freshness: 'daily', priorNormalized: 64 }),
  snap('sloosh_returned', 49, 77, '49 of 77',
    { health: 'untracked', rowCount: 49, freshness: 'daily' }),
  snap('sloosh_paid', 17, 77, '17 of 77',
    { health: 'untracked', rowCount: 17, freshness: 'daily', priorNormalized: 18 }),
  snap('sloosh_wau', 312, null, '312 active',
    { health: 'untracked', rowCount: 312, freshness: 'daily', normalized: null }),
  snap('sloosh_revenue', 168000, 670000, '₹1.68L of ₹6.7L target',
    {
      health: 'crit', rowCount: 9, freshness: 'daily', priorNormalized: 11,
      warnings: ['Two invoices are mid-cycle and not yet collected']
    }),

  /* ---- Sloosh shipping: the two-ring card ---- */
  snap('sloosh_shipped', 11, 14, '11 of 14 committed',
    { health: 'good', rowCount: 11, freshness: 'daily', priorNormalized: 64 }),
  snap('sloosh_in_progress', 9, 6, '9 of 6 wip limit',
    {
      health: 'crit', rowCount: 9, freshness: 'daily', priorNormalized: 83,
      warnings: ['Work in progress is above the stated WIP limit']
    }),
  snap('sloosh_releases', 3, null, '3 releases',
    { health: 'untracked', rowCount: 3, freshness: 'daily', normalized: null }),
  snap('sloosh_cycle_time', 4.5, null, '4.5d',
    { health: 'untracked', rowCount: 11, freshness: 'daily', normalized: null }),

  /* ---- Hiring: the sheet has not been touched since August ---- */
  snap('hiring_joined', 6, 19, '6 of 19 in plan',
    {
      health: 'stale', rowCount: 6, freshness: 'stale',
      warnings: ['Hiring sheet last updated 28 Aug 2026, before this period started']
    }),
  snap('hiring_accepted', 6, 19, '6 of 19 in plan',
    { health: 'stale', rowCount: 6, freshness: 'stale' }),
  snap('hiring_in_process', 14, 19, '14 candidates',
    { health: 'stale', rowCount: 14, freshness: 'stale' }),
  snap('hiring_open_roles', 19, 24, '19 of 24 in plan',
    { health: 'stale', rowCount: 19, freshness: 'stale' }),
  snap('hiring_offers_out', 4, null, '4 out',
    { health: 'stale', rowCount: 4, freshness: 'stale', normalized: null }),
  snap('hiring_time_to_close', 38, null, '38d',
    { health: 'stale', rowCount: 6, freshness: 'stale', normalized: null })
];

/* ------------------------------------------------------------------ *
 * Scoreboard rows
 *
 * engine/scoreboard.js deptScoreboard() is not landed yet, so the fixture
 * derives the same shape from the snapshots above. When the engine exports it,
 * delete this function and call it instead - the shape is identical.
 * ------------------------------------------------------------------ */

function deriveScoreboard(snaps, cat, orgCfg) {
  const defs = new Map(cat.metrics.map(m => [m.id, m]));
  const rows = new Map();

  for (const s of snaps) {
    const def = defs.get(s.metricId);
    if (!def) continue;
    if (!rows.has(def.dept)) {
      rows.set(def.dept, {
        deptId: def.dept,
        deptLabel: (orgCfg.departments.find(d => d.id === def.dept) || {}).label || def.dept,
        // The trio, as the scoreboard shows it. The single accountable name
        // belongs on a flag, not on a line-of-business row.
        owner: teamLabel(def.dept, orgCfg),
        team: ownerTeam(def.dept, orgCfg),
        onTarget: 0,
        totalJudged: 0,
        byHealth: { good: 0, warn: 0, crit: 0, stale: 0, missing: 0, untracked: 0 },
        worstMetric: null,
        netDelta: null,
        freshness: null
      });
    }
    const row = rows.get(def.dept);
    row.byHealth[s.health] = (row.byHealth[s.health] || 0) + 1;
    if (s.health !== 'untracked') {
      row.totalJudged += 1;
      if (s.health === 'good') row.onTarget += 1;
    }
    if (s.delta !== null && s.delta !== undefined) {
      row.netDelta = (row.netDelta || 0) + s.delta;
    }

    const RANK = { crit: 5, missing: 4, stale: 3, warn: 2, good: 1, untracked: 0 };
    if (!row.worstMetric || RANK[s.health] > RANK[row.worstMetric.health]) {
      row.worstMetric = { id: s.metricId, label: def.label, health: s.health };
    }
    const FRANK = { daily: 0, weekly: 1, unknown: 2, last_minute: 3, stale: 4 };
    if (row.freshness === null || FRANK[s.freshness] > FRANK[row.freshness]) {
      row.freshness = s.freshness;
    }
  }
  return [...rows.values()];
}

const scoreboard = deriveScoreboard(snapshots, catalog, org);

/* ------------------------------------------------------------------ *
 * Blockers
 * ------------------------------------------------------------------ */

const blockers = [
  {
    id: 'blk-us-crm',
    title: 'US CRM has no owner, so the pipeline number is assembled by hand',
    raisedBy: 'us_sales',
    needsFrom: 'sloosh',
    what: 'A read-only connection to the US CRM, or an owner who maintains the sheet daily.',
    impact: 'Until it exists, every US number on this page is typed the night before the meeting.',
    metricIds: ['in_pipeline_us', 'us_closed_won', 'us_opps_created'],
    raisedAt: '2026-08-11', ageWeeks: 4, status: 'escalated',
    owner: null, dueDate: null, resolution: '',
    firstSeenMeeting: 'wbr-2026-08-11', lastTouchedMeeting: 'wbr-2026-09-08'
  },
  {
    id: 'blk-attribution',
    title: 'Paid pipeline cannot be attributed without a shared campaign id',
    raisedBy: 'perf_marketing',
    needsFrom: 'india_sales',
    what: 'The campaign id written onto the deal record at creation, not after close.',
    impact: 'Pipeline sourced and CAC are both estimates until this lands.',
    metricIds: ['pm_india_pipeline_sourced', 'pm_india_cac', 'pm_us_pipeline_sourced'],
    raisedAt: '2026-08-25', ageWeeks: 2, status: 'open',
    owner: null, dueDate: '2026-09-19', resolution: '',
    firstSeenMeeting: 'wbr-2026-08-25', lastTouchedMeeting: 'wbr-2026-09-08'
  },
  {
    id: 'blk-hiring-sheet',
    title: 'Hiring sheet has not been updated since 28 August',
    raisedBy: 'hiring',
    needsFrom: 'hiring',
    what: 'Someone to own the sheet weekly, or a connector to the applicant tracker.',
    impact: 'Every hiring ring on this page is showing last month.',
    metricIds: ['hiring_joined', 'hiring_accepted', 'hiring_in_process'],
    raisedAt: '2026-09-01', ageWeeks: 1, status: 'open',
    owner: null, dueDate: null, resolution: '',
    firstSeenMeeting: 'wbr-2026-09-08', lastTouchedMeeting: 'wbr-2026-09-08'
  },
  {
    id: 'blk-wip',
    title: 'Sloosh is above its WIP limit and cannot take the attribution work',
    raisedBy: 'sloosh',
    needsFrom: 'us_sales',
    what: 'Agreement to drop one of the two US-requested features this cycle.',
    impact: 'Nine items in progress against a limit of six; cycle time is already drifting.',
    metricIds: ['sloosh_in_progress', 'sloosh_cycle_time'],
    raisedAt: '2026-09-01', ageWeeks: 1, status: 'open',
    owner: null, dueDate: '2026-09-12', resolution: '',
    firstSeenMeeting: 'wbr-2026-09-08', lastTouchedMeeting: 'wbr-2026-09-08'
  }
];

/* transcript/dependencies.js dependencyMatrix() exists but is still settling;
   passing null lets blockersSection derive the same picture from the blockers
   above, which guarantees the summary and the cards agree. */
const dependencyMatrix = null;

/* ------------------------------------------------------------------ *
 * Decisions
 * ------------------------------------------------------------------ */

const decisions = [
  {
    id: 'dec-us-data', number: 1, domain: 'Governance',
    headline: 'US numbers do not go on this page until they have a daily owner.',
    status: 'NEW',
    carriedIn: 'US Sales has reported from a hand-assembled sheet since the line opened. The proof asked for last month was a connected source by this meeting.',
    evidence: 'Every row in the US CRM tab was written in the twelve hours before the run. The numbers may be right; nobody is using them to run the week.',
    decided: 'US metrics stay on the page but carry the assembled-for-this-meeting label until a daily owner is named. We accept that this is visible to the whole leadership group.',
    beforeNextReview: 'Name an owner for the US CRM, or connect it read-only. Proof is a freshness label of daily on the US pipeline card.',
    strip: 'A number assembled the night before is not a number the team is running on.',
    owner: null, dueDate: null,
    reopenCondition: 'The label is still last-minute two reviews from now.',
    metricIds: ['in_pipeline_us', 'us_closed_won', 'us_opps_created'],
    firstSeenMeeting: 'wbr-2026-09-08', lastTouchedMeeting: 'wbr-2026-09-08',
    previousStateUnverified: true
  },
  {
    id: 'dec-targets', number: 2, domain: 'Organization',
    headline: 'Every metric gets a target from its own department head, by the 22nd.',
    status: 'CONFIRMED',
    carriedIn: 'The catalogue shipped with every target null on purpose, so that setting one is a visible act by a named person rather than a default nobody agreed to.',
    evidence: 'Of the metrics on this page, only a third are judged against anything. The rest report a number with no commitment attached, which is the gap the founder asked to close.',
    decided: 'Each department head sets their own targets once, in config/catalog.json, and the no-target flag list is the acceptance test. We accept a week of visibly empty scoreboard cells while that happens.',
    beforeNextReview: 'Targets set for all five lines of business. Proof is the no-target flag count reaching zero.',
    strip: 'A metric with no target is not neutral. It is a metric nobody has committed to.',
    owner: null, dueDate: '2026-09-22',
    reopenCondition: 'Any department still has unset targets at the October review.',
    metricIds: ['us_opps_created', 'pm_us_leads', 'hiring_joined'],
    firstSeenMeeting: 'wbr-2026-09-01', lastTouchedMeeting: 'wbr-2026-09-08',
    previousStateUnverified: false
  },
  {
    id: 'dec-wip', number: 3, domain: 'Product',
    headline: 'Sloosh holds its WIP limit and drops one US request this cycle.',
    status: 'OPEN',
    carriedIn: 'The WIP limit of six was agreed when the Sloosh team was three people and has not been revisited since.',
    evidence: 'Nine items in progress against a limit of six, and cycle time has drifted to four and a half days.',
    decided: 'Hold the limit rather than raise it, and drop one of the two US-requested features. We accept that US attribution slips a cycle.',
    beforeNextReview: 'Agree with US Sales which of the two features drops.',
    strip: 'Raising the limit is how the limit stops meaning anything.',
    owner: null, dueDate: '2026-09-12',
    reopenCondition: 'Cycle time keeps rising with in-progress back under the limit.',
    metricIds: ['sloosh_in_progress', 'sloosh_cycle_time', 'sloosh_shipped'],
    firstSeenMeeting: 'wbr-2026-09-08', lastTouchedMeeting: 'wbr-2026-09-08',
    previousStateUnverified: false
  }
];

const events = [
  {
    decisionId: 'dec-us-data', meetingId: 'wbr-2026-09-08',
    fromStatus: null, toStatus: 'NEW',
    reason: 'Raised after the freshness label showed every US row written the night before.',
    quote: 'The numbers may be right. Nobody is running the week on them.',
    at: '2026-09-08T10:12:00+05:30'
  },
  {
    decisionId: 'dec-targets', meetingId: 'wbr-2026-09-08',
    fromStatus: 'NEW', toStatus: 'CONFIRMED',
    reason: 'Confirmed once the scoreboard made the unjudged share visible in one line.',
    at: '2026-09-08T10:26:00+05:30'
  },
  {
    decisionId: 'dec-wip', meetingId: 'wbr-2026-09-08',
    fromStatus: null, toStatus: 'OPEN',
    reason: 'Left open pending which of the two US features drops.',
    at: '2026-09-08T10:44:00+05:30'
  }
];

const notes = [
  { cardId: 'india-pipeline', meetingId: 'wbr-2026-09-08', text: 'Closed won is ahead of pace; the POC band is where next month comes from.' },
  { cardId: 'india-activity', meetingId: 'wbr-2026-09-08', text: 'Meetings are healthy, opportunities are not converting out of them.' },
  { cardId: 'us-pipeline', meetingId: 'wbr-2026-09-08', text: 'Read this one with the freshness label in mind. It was assembled last night.' },
  { cardId: 'us-activity', meetingId: 'wbr-2026-09-08', text: 'Two opportunities against a target of eight, second week running.' },
  { cardId: 'perf-india', meetingId: 'wbr-2026-09-08', text: 'Spend is tracking budget and lead volume is holding; qualification rate is the open question.' },
  { cardId: 'perf-us', meetingId: 'wbr-2026-09-08', text: 'No targets set here yet, so none of these rings are judged.' },
  { cardId: 'sloosh-funnel', meetingId: 'wbr-2026-09-08', text: 'Activation is strong, the drop is at paid conversion.' },
  { cardId: 'sloosh-shipping', meetingId: 'wbr-2026-09-08', text: 'Nine in progress against a limit of six. That is the WIP decision.' },
  { cardId: 'hiring-funnel', meetingId: 'wbr-2026-09-08', text: 'Showing August. The sheet has not been touched since the 28th.' }
];

/* ------------------------------------------------------------------ *
 * Status calls - the RAG judgements
 *
 * Not metrics. These are what a human said in the daily stand-up, and the
 * fixture exercises every state the section has to survive: a brand red for
 * several days running, an amber with a real reason, a track nobody has called
 * since Tuesday (stale), a grey that has not started, and a gap in the middle
 * of a 7-day strip where nobody made the call at all.
 *
 * Two departments on purpose. Perf Marketing calls colours per BRAND; Marketing
 * calls them per TRACK, the way the WBR's "Status by track" section already
 * does. The engine groups by a subject string and does not care which.
 * ------------------------------------------------------------------ */

const RAG_NOW = '2026-09-07T18:00:00+05:30';

/** One call. `day` is how many days before RAG_NOW it was made. */
function call(subject, dept, status, reason, setBy, daysAgo) {
  const at = new Date(Date.parse(RAG_NOW) - daysAgo * 86400000);
  return {
    subject, dept, status, reason, setBy,
    setAt: at.toISOString(),
    periodStart: at.toISOString().slice(0, 10)
  };
}

const ragStatuses = [
  // red five days running - this is the one that raises a flag
  ...[0, 1, 2, 3, 4].map(d => call('Kiara', 'perf_marketing', 'red',
    'ROAS has sat under 1.4 since the creative refresh and we have not found the losing placement yet.',
    'Ankit', d)),
  // amber, called today, improving
  ...[0, 1].map(d => call('Lumen', 'perf_marketing', 'amber',
    'Spend is pacing fine but the lead quality complaint from sales is unresolved.', 'Ankit', d)),
  // green, with a gap on day 2 where nobody made the call
  ...[0, 1, 3, 4].map(d => call('Norda', 'perf_marketing', 'green',
    'Steady. CPL flat, no creative fatigue signals this week.', 'Ankit', d)),
  // nobody has called this one since Tuesday - stale
  call('Vessel', 'perf_marketing', 'amber',
    'Paused mid-flight while the client reworks the landing page. Nothing to read until it restarts.',
    'Ankit', 4),

  // Marketing runs the same system per TRACK, not per brand. No code change.
  ...[0, 1, 2].map(d => call('US Lead Gen', 'us_sales', 'amber',
    'Volume is there, conversion to meeting is not. Sequence rewrite lands Thursday.', 'Dana', d)),
  call('SEO', 'us_sales', 'grey',
    'Not started. Agency contract is still in legal, so there is no signal to read yet.', 'Dana', 0),
  ...[0, 1].map(d => call('Lifecycle email', 'us_sales', 'green',
    'Win-back flow shipped and is already the second-best converting flow.', 'Dana', d)),

  // dropped by the engine: a colour with nothing to argue with
  { subject: 'Halo', dept: 'perf_marketing', status: 'red', reason: '', setBy: 'Ankit', setAt: RAG_NOW }
];

const rag = rollupRag(ragStatuses, { ...(org.rag || {}), now: RAG_NOW });
const ragFlags = deriveRagFlags(rag, { org, now: COMPUTED_AT });

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

const flags = [
  {
    id: 'flag-no-target-us', dept: 'us_sales', owner: null, kind: 'no_proof', raisedBy: 'engine',
    raisedAt: COMPUTED_AT, resolvedAt: null,
    metricIds: ['us_opps_created', 'us_meetings_held'],
    title: 'US Sales has no targets set',
    body: 'Six metrics report a number with nothing to judge it against. Set them once in config/catalog.json and this flag disappears.'
  },
  {
    id: 'flag-no-target-pm', dept: 'perf_marketing', owner: null, kind: 'no_proof', raisedBy: 'engine',
    raisedAt: COMPUTED_AT, resolvedAt: null,
    metricIds: ['pm_us_leads', 'pm_us_spend'],
    title: 'Performance Marketing US has no budget or lead target',
    body: 'The India segment has both. Until the US segment does, the rollup across the family is incomplete.'
  },
  {
    id: 'flag-hiring-stale', dept: 'hiring', owner: null, kind: 'stale_source', raisedBy: 'engine',
    raisedAt: COMPUTED_AT, resolvedAt: null,
    metricIds: ['hiring_joined', 'hiring_accepted', 'hiring_in_process'],
    title: 'Hiring sheet last synced 28 August',
    body: 'Before this period started, so every hiring ring is showing last month rather than this week.'
  },
  {
    id: 'flag-us-lastminute', dept: 'us_sales', owner: null, kind: 'contradiction', raisedBy: 'engine',
    raisedAt: COMPUTED_AT, resolvedAt: null,
    metricIds: ['in_pipeline_us'],
    title: 'US CRM rows were all written in the last 12 hours',
    body: 'Classified as assembled-for-this-meeting. Not a judgement on the numbers; a signal the team is not running on them.'
  },
  {
    id: 'flag-sloosh-wip', dept: 'sloosh', owner: null, kind: 'off_target', raisedBy: 'engine',
    raisedAt: COMPUTED_AT, resolvedAt: null,
    metricIds: ['sloosh_in_progress'],
    title: 'Work in progress is above the stated WIP limit',
    body: 'Nine items against a limit of six. Cycle time has drifted to 4.5 days.'
  },
  {
    id: 'flag-owners', dept: 'india_sales', owner: null, kind: 'manual', raisedBy: 'engine',
    raisedAt: COMPUTED_AT, resolvedAt: null,
    title: 'No department has a named owner yet',
    body: 'org.json ships with every owner unset. Until they are filled in, every flag on this page is addressed to nobody.'
  }
];

const run = {
  id: RUN_ID,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  startedAt: '2026-09-07T19:30:00+05:30',
  finishedAt: COMPUTED_AT,
  status: 'partial',
  triggeredBy: 'cron'
};

/* ------------------------------------------------------------------ */

const dashboard = renderDashboard({
  run, snapshots, flags: [...flags, ...ragFlags],
  decisions, events, notes, blockers, scoreboard,
  dependencyMatrix, rag, catalog, org,
  meta: {
    title: 'Weekly business review',
    kicker: '&middot; five lines of business',
    fixtureBanner: 'Every number on this page is synthetic. This file exists to show the format, not to report a week.',
    standfirst: 'Scoreboard answers the target question first. The ring cards are read before the meeting, '
      + 'not presented in it. <b>Blockers are the part the room is for</b> &mdash; two named people and an ask between them.',
    runLabel: 'fixture, generated by render/sample.js',
    provenance: 'No connector has run. Numbers are invented to exercise every rendering state.'
  }
});

const printLog = decisionPages(decisions.slice(0, 2), events, {
  // Plain text, not HTML: decisionPages escapes these, so an entity here
  // would print as "&middot;" on the page.
  identity: 'ShopOS \u00b7 weekly business review',
  docLabel: 'Decision log \u00b7 fixture',
  topic: 'Data ownership and targets',
  prevDate: '1 Sept 2026',
  nextDate: '15 Sept 2026',
  title: 'ShopOS decision log - 8 Sept 2026 (fixture)'
});

const outDir = resolve(ROOT, 'out');
mkdirSync(outDir, { recursive: true });

const dashPath = resolve(outDir, 'sample-dashboard.html');
const decPath = resolve(outDir, 'sample-decisions.html');
writeFileSync(dashPath, dashboard, 'utf8');
writeFileSync(decPath, printLog, 'utf8');

console.log(`${dashPath}  ${statSync(dashPath).size} bytes`);
console.log(`${decPath}  ${statSync(decPath).size} bytes`);
