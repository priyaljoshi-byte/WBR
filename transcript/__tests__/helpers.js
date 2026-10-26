/**
 * Shared fixtures for the transcript tests. Not a test file - the name does not
 * match node:test's discovery patterns, so `node --test` ignores it.
 */

import { readFileSync } from 'node:fs';

export const sampleExtraction = JSON.parse(
  readFileSync(new URL('../fixtures/sample-extraction.json', import.meta.url), 'utf8')
);

export const sampleTranscript = readFileSync(
  new URL('../fixtures/sample-transcript.md', import.meta.url),
  'utf8'
);

export const MEETING = {
  id: 'wbr-2025-09-08',
  date: '2025-09-08',
  kind: 'wbr',
  attendees: ['Binny', 'Priyal', 'Arjun', 'Dana', 'Nikhil', 'Rhea', 'Meeth'],
  transcriptPath: 'transcript/fixtures/sample-transcript.md',
  processedAt: null
};

export const LAST_MEETING = {
  id: 'wbr-2025-09-01',
  date: '2025-09-01',
  kind: 'wbr',
  attendees: [],
  transcriptPath: null,
  processedAt: null
};

export const MEETING_DATES = {
  'wbr-2025-08-25': '2025-08-25',
  'wbr-2025-09-01': '2025-09-01',
  'wbr-2025-09-08': '2025-09-08'
};

/** The headline the similarity constants are calibrated against. */
export const SLOOSH_HEADLINE = 'Fix Sloosh activation before increasing US ad spend';

/** Scores 0.501 against SLOOSH_HEADLINE: inside the grey band, not auto-matched. */
export const NEAR_MISS_HEADLINE = 'Fix Sloosh activation before increasing paid acquisition budget';

export function clone(obj) {
  return structuredClone(obj);
}

/** A Decision with sane defaults, so a test only states what it is testing. */
export function decision(over = {}) {
  return {
    id: 'd-test',
    number: 1,
    domain: 'Product',
    headline: 'A decision headline',
    status: 'NEW',
    carriedIn: 'carried in',
    evidence: 'evidence',
    decided: 'decided',
    beforeNextReview: 'before next review',
    strip: 'strip',
    owner: 'Nikhil',
    dueDate: null,
    reopenCondition: 'reopen condition',
    metricIds: ['sloosh_activated'],
    firstSeenMeeting: 'wbr-2025-09-01',
    lastTouchedMeeting: 'wbr-2025-09-01',
    previousStateUnverified: false,
    ...over
  };
}

/** The Sloosh activation decision as it stood on the books before this meeting. */
export function priorSlooshDecision(over = {}) {
  return decision({
    id: 'd-fix-sloosh-activation-before-increasing-us-ad-sp',
    domain: 'Product',
    headline: SLOOSH_HEADLINE,
    status: 'NEW',
    owner: 'Nikhil',
    dueDate: '2025-09-22',
    metricIds: ['sloosh_activated'],
    ...over
  });
}

/**
 * The Performance Marketing budget decision as taken on 2025-09-01. Its headline
 * is the OLD position - this week's extraction changes it, which is exactly why
 * the extraction carries its id: a genuine CHANGED decision rewrites its own
 * headline, so headline similarity alone would not find it.
 */
export function priorBudgetDecision(over = {}) {
  return decision({
    id: 'd-hold-us-ad-spend-flat-until-lead-quality-recover',
    domain: 'Go-to-market',
    headline: 'Hold US ad spend flat until lead quality recovers',
    status: 'NEW',
    owner: 'Rhea',
    dueDate: '2025-09-15',
    metricIds: ['pm_us_spend'],
    ...over
  });
}

/** The two decisions carried in from the 2025-09-01 review. */
export function openDecisions() {
  return [priorSlooshDecision(), priorBudgetDecision()];
}

/** A Blocker with sane defaults. */
export function blocker(over = {}) {
  return {
    id: 'b-test',
    title: 'A blocker title',
    raisedBy: 'us_sales',
    needsFrom: 'sloosh',
    what: 'the specific ask',
    impact: 'what does not happen',
    metricIds: ['us_created_wk'],
    raisedAt: '2025-09-01',
    ageWeeks: 2,
    status: 'open',
    owner: null,
    dueDate: null,
    resolution: '',
    resolvedAt: null,
    firstSeenMeeting: 'wbr-2025-09-01',
    lastTouchedMeeting: 'wbr-2025-09-01',
    ...over
  };
}

/** A Snapshot with sane defaults. */
export function snap(metricId, raw, over = {}) {
  return {
    runId: 'run-2025-09-08',
    metricId,
    periodStart: '2025-09-01',
    periodEnd: '2025-09-07',
    raw,
    denominator: null,
    normalized: null,
    priorRaw: null,
    priorNormalized: null,
    delta: null,
    health: 'untracked',
    caption: '',
    rowCount: 1,
    computedAt: '2025-09-07T20:00:00.000Z',
    warnings: [],
    ...over
  };
}

/**
 * Snapshots that agree with the sample extraction everywhere except Sloosh
 * signups, where Nikhil said 220 and the data measured 180.
 */
export function sampleSnapshots() {
  return [
    snap('sloosh_signups', 180),
    snap('sloosh_activated', 45),
    snap('sloosh_returned', 20),
    snap('in_pipeline_india', 45000000),
    snap('india_meetings_held', 10),
    snap('pm_us_spend', 9000),
    snap('pm_india_spend', 400000),
    snap('pm_us_cpl', 180),
    snap('hiring_offers_out', 0),
    snap('hiring_accepted', 1),
    snap('us_created_wk', 0),
    snap('us_opps_created', 0),
    snap('pm_us_qualified', 12)
  ];
}

/** A minimal extraction carrying only what a test cares about. */
export function extractionWith(decisions, over = {}) {
  return {
    meetingId: MEETING.id,
    meetingDate: MEETING.date,
    decisions,
    blockers: [],
    notes: [],
    statedNumbers: [],
    asks: [],
    ...over
  };
}

/** An extracted decision with sane defaults. */
export function extractedDecision(over = {}) {
  return {
    id: null,
    number: 1,
    domain: 'Product',
    headline: 'A decision headline',
    status: 'CONFIRMED',
    carriedIn: 'carried in',
    evidence: 'evidence',
    decided: 'decided',
    beforeNextReview: 'before next review',
    strip: 'strip',
    owner: 'Nikhil',
    dueDate: null,
    reopenCondition: 'reopen condition',
    metricIds: ['sloosh_activated'],
    previousStateUnverified: false,
    ...over
  };
}

/** An extracted blocker with sane defaults. */
export function extractedBlocker(over = {}) {
  return {
    id: null,
    title: 'A blocker title',
    raisedBy: 'us_sales',
    needsFrom: 'sloosh',
    what: 'the specific ask',
    impact: 'what does not happen',
    metricIds: ['us_created_wk'],
    raisedAt: '2025-09-08',
    status: 'open',
    owner: null,
    dueDate: null,
    ...over
  };
}
