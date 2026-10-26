import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichmentDelta, decisionsWithoutProof, metricsWithoutDecisions } from '../enrich.js';
import {
  MEETING,
  LAST_MEETING,
  MEETING_DATES,
  decision,
  snap,
  sampleSnapshots
} from './helpers.js';

function week(meeting, decisions, snapshots, extra = {}) {
  return { meeting, decisions, snapshots, ...extra };
}

test('a decision is judged against the numbers as they stood when it was taken', () => {
  const d = decision({
    id: 'd-sloosh',
    headline: 'Fix Sloosh activation before increasing US ad spend',
    status: 'CONFIRMED',
    metricIds: ['sloosh_activated'],
    firstSeenMeeting: 'wbr-2025-09-01'
  });

  const history = [
    snap('sloosh_activated', 30, { periodEnd: '2025-08-31' }),
    snap('sloosh_activated', 45, { periodEnd: '2025-09-07' })
  ];

  const out = enrichmentDelta(
    week(MEETING, [d], [history[1]], { history, meetingDates: MEETING_DATES }),
    week(LAST_MEETING, [d], [history[0]])
  );

  const row = out.decisions[0];
  assert.equal(row.metrics[0].baselineSource, 'at-decision');
  assert.equal(row.metrics[0].atDecision, 30);
  assert.equal(row.metrics[0].now, 45);
  assert.equal(row.metrics[0].change, 15);
  assert.equal(row.metrics[0].movement, 'better');
  assert.equal(row.verdict, 'working');
});

test('a down-is-better metric moving down counts as working', () => {
  const d = decision({
    id: 'd-cpl',
    domain: 'Go-to-market',
    headline: 'Shift half the US ad budget to India until CPL falls',
    metricIds: ['pm_us_cpl'],
    firstSeenMeeting: 'wbr-2025-09-01'
  });
  const history = [
    snap('pm_us_cpl', 200, { periodEnd: '2025-08-31' }),
    snap('pm_us_cpl', 150, { periodEnd: '2025-09-07' })
  ];
  const out = enrichmentDelta(
    week(MEETING, [d], [history[1]], { history, meetingDates: MEETING_DATES }),
    week(LAST_MEETING, [d], [history[0]])
  );
  assert.equal(out.decisions[0].metrics[0].direction, 'down');
  assert.equal(out.decisions[0].verdict, 'working');
});

test('a decision moving the wrong way is reported as not working', () => {
  const d = decision({
    id: 'd-sloosh',
    metricIds: ['sloosh_activated'],
    firstSeenMeeting: 'wbr-2025-09-01'
  });
  const history = [
    snap('sloosh_activated', 60, { periodEnd: '2025-08-31' }),
    snap('sloosh_activated', 45, { periodEnd: '2025-09-07' })
  ];
  const out = enrichmentDelta(
    week(MEETING, [d], [history[1]], { history, meetingDates: MEETING_DATES }),
    week(LAST_MEETING, [d], [history[0]])
  );
  assert.equal(out.decisions[0].verdict, 'not working');
  assert.equal(out.compounding.notWorking, 1);
});

test('without history the baseline falls back to last week and says so', () => {
  const d = decision({ id: 'd-sloosh', metricIds: ['sloosh_activated'] });
  const out = enrichmentDelta(
    week(MEETING, [d], [snap('sloosh_activated', 45)]),
    week(LAST_MEETING, [d], [snap('sloosh_activated', 30, { periodEnd: '2025-08-31' })])
  );
  // A one-week delta must never masquerade as a six-week result.
  assert.equal(out.decisions[0].metrics[0].baselineSource, 'prior-week');
});

test('week one works with no previous week at all', () => {
  const d = decision({ id: 'd-new', metricIds: ['sloosh_activated'] });
  const out = enrichmentDelta(week(MEETING, [d], [snap('sloosh_activated', 45)]), null);
  assert.equal(out.comparedTo, null);
  assert.deepEqual(out.newDecisions, ['d-new']);
  assert.equal(out.decisions[0].verdict, 'no measurement yet');
});

test('the compounding counters separate judgeable decisions from the rest', () => {
  const proved = decision({
    id: 'd-proved',
    metricIds: ['sloosh_activated'],
    firstSeenMeeting: 'wbr-2025-09-01'
  });
  const unproved = decision({ id: 'd-unproved', metricIds: [] });
  const history = [
    snap('sloosh_activated', 30, { periodEnd: '2025-08-31' }),
    snap('sloosh_activated', 45, { periodEnd: '2025-09-07' })
  ];

  const out = enrichmentDelta(
    week(MEETING, [proved, unproved], [history[1]], { history, meetingDates: MEETING_DATES }),
    week(LAST_MEETING, [proved], [history[0]])
  );

  assert.equal(out.compounding.decisionsOnTheBooks, 2);
  assert.equal(out.compounding.wasOnTheBooks, 1);
  assert.equal(out.compounding.working, 1);
  assert.equal(out.compounding.unprovable, 1);
  assert.equal(out.compounding.judgeable, 1);
  assert.deepEqual(out.newDecisions, ['d-unproved']);
  assert.deepEqual(out.carriedDecisions, ['d-proved']);
});

// --- the two blind spots --------------------------------------------------------

test('decisionsWithoutProof finds the choices nobody is measuring', () => {
  const list = [
    decision({ id: 'd-a', metricIds: ['sloosh_activated'] }),
    decision({ id: 'd-b', metricIds: [] }),
    decision({ id: 'd-c', metricIds: [], status: 'COMPLETED' })
  ];
  const out = decisionsWithoutProof(list);
  assert.deepEqual(out.map((d) => d.decisionId), ['d-b']);
  assert.match(out[0].why, /nothing on the dashboard moves/);
});

test('metricsWithoutDecisions finds the numbers nobody is acting on', () => {
  const decisions = [decision({ id: 'd-a', metricIds: ['sloosh_activated'] })];
  const out = metricsWithoutDecisions(sampleSnapshots(), decisions);
  const ids = out.map((m) => m.metricId);

  assert.ok(!ids.includes('sloosh_activated'), 'a claimed metric is not a blind spot');
  assert.ok(ids.includes('in_pipeline_india'));
  assert.ok(out.every((m) => typeof m.label === 'string' && m.label.length > 0));
  assert.match(out[0].why, /no open decision references this metric/);
});

test('a terminal decision stops claiming its metrics', () => {
  const closed = [decision({ id: 'd-a', metricIds: ['sloosh_activated'], status: 'COMPLETED' })];
  const out = metricsWithoutDecisions([snap('sloosh_activated', 45)], closed);
  assert.equal(out.length, 1, 'a finished decision no longer counts as somebody watching');
});

test('enrichmentDelta surfaces both blind spots inline', () => {
  const decisions = [
    decision({ id: 'd-a', metricIds: ['sloosh_activated'] }),
    decision({ id: 'd-b', metricIds: [] })
  ];
  const out = enrichmentDelta(week(MEETING, decisions, sampleSnapshots()), null);
  assert.equal(out.decisionsWithoutProof.length, 1);
  assert.ok(out.metricsWithoutDecisions.length > 0);
});
