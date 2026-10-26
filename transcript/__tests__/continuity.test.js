import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcile,
  similarity,
  transitionError,
  MATCH_THRESHOLD,
  REVIEW_FLOOR
} from '../continuity.js';
import {
  sampleExtraction,
  clone,
  MEETING,
  SLOOSH_HEADLINE,
  NEAR_MISS_HEADLINE,
  decision,
  priorSlooshDecision,
  priorBudgetDecision,
  openDecisions,
  extractionWith,
  extractedDecision
} from './helpers.js';

// --- similarity calibration -------------------------------------------------

test('similarity is 1 for an identical headline and near 0 for an unrelated one', () => {
  assert.equal(similarity(SLOOSH_HEADLINE, SLOOSH_HEADLINE), 1);
  assert.ok(similarity(SLOOSH_HEADLINE, 'Raise the Series A in Q1') < REVIEW_FLOOR);
});

test('the grey band sits where the constants say it does', () => {
  const near = similarity(SLOOSH_HEADLINE, NEAR_MISS_HEADLINE);
  assert.ok(near >= REVIEW_FLOOR, `expected >= ${REVIEW_FLOOR}, got ${near}`);
  assert.ok(near < MATCH_THRESHOLD, `expected < ${MATCH_THRESHOLD}, got ${near}`);

  const clear = similarity(SLOOSH_HEADLINE, 'Fix Sloosh activation before increasing US ad budget');
  assert.ok(clear >= MATCH_THRESHOLD, `expected >= ${MATCH_THRESHOLD}, got ${clear}`);

  const unrelated = similarity(SLOOSH_HEADLINE, 'Hire two India sales reps before raising the pipeline target');
  assert.ok(unrelated < REVIEW_FLOOR, `expected < ${REVIEW_FLOOR}, got ${unrelated}`);
});

test('US and India headlines do not collapse into each other', () => {
  // One token out of eight carries the entire meaning. Pure text overlap scores
  // these at 0.78 and would auto-merge two different budgets.
  const a = 'Hold US ad spend flat until lead quality recovers';
  const b = 'Hold India ad spend flat until lead quality recovers';
  assert.ok(similarity(a, b) < REVIEW_FLOOR, `got ${similarity(a, b)}`);

  // One-sided cases are untouched: naming no market tells us nothing either way.
  assert.ok(similarity(SLOOSH_HEADLINE, NEAR_MISS_HEADLINE) > REVIEW_FLOOR);

  // Overlapping markets are not penalised.
  const both = 'Shift half the US ad budget to India until CPL falls';
  assert.ok(similarity('Hold US ad spend flat until lead quality recovers', both) > 0);
});

test('a genuine CHANGED headline scores below the threshold against its own past', () => {
  // This is why the extractor is handed the open decision list and asked for an id.
  const before = 'Hold US ad spend flat until lead quality recovers';
  const after = 'Shift half the US ad budget to India until CPL falls';
  assert.ok(similarity(before, after) < REVIEW_FLOOR, `got ${similarity(before, after)}`);
});

// --- a proposal is not a decision -------------------------------------------

test('a proposal in the transcript is not promoted to a decision', () => {
  // "Someone should own cleaning up the onboarding copy" is agreed to in principle
  // ("Yes, let us do that") with no name and no date. That is a Proposal, and the
  // agreement is Context. Neither becomes a decision or a commitment with an owner.
  const proposals = sampleExtraction.statements.filter((s) => s.kind === 'Proposal');
  assert.ok(
    proposals.some((s) => /onboarding copy/i.test(s.text)),
    'the onboarding copy cleanup should be a Proposal'
  );
  const agreement = sampleExtraction.statements.find((s) => /Yes, let us do that/.test(s.quote || ''));
  assert.equal(agreement.kind, 'Context', 'enthusiasm with no owner is not a commitment');

  for (const d of sampleExtraction.decisions) {
    assert.doesNotMatch(d.headline, /onboarding copy/i);
    assert.doesNotMatch(d.decided, /onboarding copy/i);
  }

  const { decisions } = reconcile(sampleExtraction, openDecisions(), MEETING);
  assert.equal(decisions.length, 3, 'three decisions, and the proposal is not one of them');
  assert.deepEqual(
    decisions.map((d) => d.domain).sort(),
    ['Go-to-market', 'Hiring', 'Product']
  );
});

test('a vague difficulty is not turned into a blocker', () => {
  // "The market is tough right now in the US" names no team and no ask.
  const market = sampleExtraction.statements.find((s) => /market is tough/i.test(s.quote || ''));
  assert.ok(market, 'the line should still be captured');
  assert.equal(market.kind, 'Context');
  for (const b of sampleExtraction.blockers) {
    assert.doesNotMatch(b.title, /market is tough/i);
    assert.doesNotMatch(b.what, /market is tough/i);
    assert.ok(b.raisedBy, 'every blocker names the blocked team');
    assert.ok(b.what && b.what.trim(), 'every blocker states a specific ask');
  }
});

// --- continuity on a match ---------------------------------------------------

test('a CONFIRMED decision with an unchanged headline matches its predecessor', () => {
  const prior = priorSlooshDecision({ status: 'NEW' });
  const { decisions, events, unmatched, errors } = reconcile(
    sampleExtraction,
    [prior, priorBudgetDecision()],
    MEETING
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(unmatched, []);

  const slooshEvents = events.filter((e) => e.decisionId === prior.id);
  assert.equal(slooshEvents.length, 1);
  assert.equal(slooshEvents[0].fromStatus, 'NEW');
  assert.equal(slooshEvents[0].toStatus, 'CONFIRMED');
  assert.equal(slooshEvents[0].matchedBy, 'headline');
  assert.equal(slooshEvents[0].matchScore, 1);

  // Not a NEW event, and not a second copy of the decision.
  assert.equal(events.filter((e) => e.decisionId === prior.id && e.toStatus === 'NEW').length, 0);
  assert.equal(decisions.filter((d) => d.headline === SLOOSH_HEADLINE).length, 1);

  const sloosh = decisions.find((d) => d.id === prior.id);
  assert.equal(sloosh.status, 'CONFIRMED');
  assert.equal(sloosh.firstSeenMeeting, 'wbr-2025-09-01', 'history is preserved, not reset');
  assert.equal(sloosh.lastTouchedMeeting, MEETING.id);
  // The enrichment link accumulates rather than being replaced.
  assert.deepEqual(sloosh.metricIds, ['sloosh_activated', 'sloosh_returned', 'sloosh_signups']);
});

test('a CHANGED decision matches by id and carries its reason onto the event', () => {
  const prior = priorBudgetDecision();
  const { decisions, events, errors } = reconcile(
    sampleExtraction,
    [priorSlooshDecision(), prior],
    MEETING
  );

  assert.deepEqual(errors, []);
  const ev = events.find((e) => e.decisionId === prior.id);
  assert.equal(ev.fromStatus, 'NEW');
  assert.equal(ev.toStatus, 'CHANGED');
  assert.equal(ev.matchedBy, 'id');
  assert.match(ev.reason, /cost per lead/i);

  const after = decisions.find((d) => d.id === prior.id);
  assert.equal(after.headline, 'Shift half the US ad budget to India until CPL falls');
  assert.equal(after.firstSeenMeeting, 'wbr-2025-09-01');
});

test('the third decision is genuinely new and carries firstSeenMeeting', () => {
  const { decisions, events } = reconcile(sampleExtraction, openDecisions(), MEETING);
  const hiring = decisions.find((d) => d.domain === 'Hiring');
  assert.equal(hiring.status, 'NEW');
  assert.equal(hiring.firstSeenMeeting, MEETING.id);
  assert.equal(hiring.previousStateUnverified, true);

  const ev = events.find((e) => e.decisionId === hiring.id);
  assert.equal(ev.fromStatus, null);
  assert.equal(ev.toStatus, 'NEW');
});

test('an exact id matches even when the headline was rewritten', () => {
  const prior = priorSlooshDecision();
  const ex = extractionWith([
    extractedDecision({
      id: prior.id,
      headline: 'Hold paid spend until the funnel stops leaking',
      status: 'PARTIAL'
    })
  ]);
  const { events, unmatched } = reconcile(ex, [prior], MEETING);
  assert.deepEqual(unmatched, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].matchedBy, 'id');
  assert.equal(events[0].toStatus, 'PARTIAL');
});

// --- the grey band -----------------------------------------------------------

test('a near-miss headline lands in unmatched rather than auto-matching', () => {
  const prior = priorSlooshDecision({ headline: NEAR_MISS_HEADLINE });
  const ex = extractionWith([clone(sampleExtraction.decisions[0])]);

  const { decisions, events, unmatched } = reconcile(ex, [prior], MEETING);

  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].tag, 'needs_human_merge');
  assert.equal(unmatched[0].candidateId, prior.id);
  assert.ok(unmatched[0].score >= REVIEW_FLOOR && unmatched[0].score < MATCH_THRESHOLD);
  assert.match(unmatched[0].reason, /rewrites history/);

  // Nothing was written against the predecessor.
  assert.deepEqual(events, []);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, 'NEW', 'the predecessor is untouched');
  assert.equal(decisions[0].lastTouchedMeeting, 'wbr-2025-09-01');
});

test('a different domain blocks a headline match even when the words line up', () => {
  const prior = priorSlooshDecision({ domain: 'Engineering' });
  const ex = extractionWith([clone(sampleExtraction.decisions[0])]); // domain Product

  const { decisions, unmatched, events } = reconcile(ex, [prior], MEETING);
  assert.deepEqual(unmatched, []);
  assert.equal(decisions.length, 2, 'a cross-domain twin becomes its own decision');
  assert.equal(events.length, 1);
  assert.equal(events[0].fromStatus, null);
});

test('an unknown decision id is surfaced, never guessed at', () => {
  const prior = priorSlooshDecision();
  const ex = extractionWith([
    extractedDecision({ id: 'd-does-not-exist', headline: SLOOSH_HEADLINE })
  ]);

  const { unmatched, events } = reconcile(ex, [prior], MEETING);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].tag, 'unknown_id');
  assert.deepEqual(events, []);
});

// --- decisions the transcript did not mention --------------------------------

test('an unmentioned decision past its due date flips to BLOCKED with a reason', () => {
  const stale = decision({
    id: 'd-gcc-reseller-programme',
    domain: 'Partnerships',
    headline: 'Sign two GCC resellers before the quarter closes',
    status: 'PARTIAL',
    dueDate: '2025-09-01',
    metricIds: ['in_pipeline_india']
  });

  const { decisions, events } = reconcile(
    sampleExtraction,
    [...openDecisions(), stale],
    MEETING
  );

  const after = decisions.find((d) => d.id === stale.id);
  assert.equal(after.status, 'BLOCKED');

  const ev = events.find((e) => e.decisionId === stale.id);
  assert.ok(ev, 'an event must record the flip');
  assert.equal(ev.fromStatus, 'PARTIAL');
  assert.equal(ev.toStatus, 'BLOCKED');
  assert.equal(ev.reason, 'no evidence presented at 2025-09-08');
  assert.equal(ev.matchedBy, 'unmentioned');
});

test('an unmentioned decision that is not yet due is left alone, not deleted', () => {
  const live = decision({
    id: 'd-not-due-yet',
    domain: 'Capital',
    headline: 'Hold the raise until two reference customers renew',
    status: 'CONFIRMED',
    dueDate: '2025-12-01'
  });

  const { decisions, events } = reconcile(sampleExtraction, [...openDecisions(), live], MEETING);
  const after = decisions.find((d) => d.id === live.id);
  assert.ok(after, 'silence is not deletion');
  assert.equal(after.status, 'CONFIRMED');
  assert.equal(events.filter((e) => e.decisionId === live.id).length, 0);
});

test('an unmentioned decision with no due date is left alone', () => {
  const undated = decision({
    id: 'd-undated',
    domain: 'Risk',
    headline: 'Carry no customer data in the demo tenant',
    dueDate: null
  });
  const { decisions, events } = reconcile(sampleExtraction, [...openDecisions(), undated], MEETING);
  assert.equal(decisions.find((d) => d.id === undated.id).status, 'NEW');
  assert.equal(events.filter((e) => e.decisionId === undated.id).length, 0);
});

test('an overdue terminal decision is not reopened as BLOCKED', () => {
  const done = decision({
    id: 'd-done',
    status: 'COMPLETED',
    dueDate: '2025-08-01',
    headline: 'Ship the India CRM migration'
  });
  const { decisions, events } = reconcile(sampleExtraction, [...openDecisions(), done], MEETING);
  assert.equal(decisions.find((d) => d.id === done.id).status, 'COMPLETED');
  assert.equal(events.filter((e) => e.decisionId === done.id).length, 0);
});

// --- illegal transitions ------------------------------------------------------

test('a COMPLETED decision cannot transition to NEW', () => {
  const done = decision({
    id: 'd-done',
    status: 'COMPLETED',
    domain: 'Product',
    headline: 'Ship the India CRM migration',
    dueDate: null
  });
  const ex = extractionWith([
    extractedDecision({
      id: 'd-done',
      domain: 'Product',
      headline: 'Ship the India CRM migration',
      status: 'NEW'
    })
  ]);

  const { decisions, events, errors } = reconcile(ex, [done], MEETING);

  assert.equal(errors.length, 1);
  assert.equal(errors[0].decisionId, 'd-done');
  assert.equal(errors[0].fromStatus, 'COMPLETED');
  assert.equal(errors[0].toStatus, 'NEW');
  assert.match(errors[0].error, /terminal status COMPLETED/);

  // The rejected transition was not written.
  assert.equal(decisions.find((d) => d.id === 'd-done').status, 'COMPLETED');
  assert.deepEqual(events, []);
});

test('nothing transitions out of any terminal status', () => {
  for (const from of ['COMPLETED', 'DROPPED', 'REVERSED']) {
    const prior = decision({ id: `d-${from}`, status: from, headline: SLOOSH_HEADLINE });
    const ex = extractionWith([
      extractedDecision({ id: `d-${from}`, headline: SLOOSH_HEADLINE, status: 'CONFIRMED' })
    ]);
    const { errors, events } = reconcile(ex, [prior], MEETING);
    assert.equal(errors.length, 1, `${from} -> CONFIRMED must be rejected`);
    assert.match(errors[0].error, /cannot transition out of terminal status/);
    assert.deepEqual(events, []);
  }
});

test('an existing decision can never be re-marked NEW', () => {
  assert.match(transitionError('PARTIAL', 'NEW', ''), /NEW is reserved/);
  assert.equal(transitionError(null, 'NEW', ''), null);
});

test('a status change that needs a reason is rejected without one', () => {
  const prior = priorSlooshDecision();
  const ex = extractionWith([
    extractedDecision({ id: prior.id, headline: SLOOSH_HEADLINE, status: 'DEFERRED' })
  ]);
  const { errors, events, decisions } = reconcile(ex, [prior], MEETING);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /requires a non-empty reason/);
  assert.deepEqual(events, []);
  assert.equal(decisions.find((d) => d.id === prior.id).status, 'NEW');
});

// --- housekeeping -------------------------------------------------------------

test('reconcile does not mutate the decisions handed to it', () => {
  const priors = openDecisions();
  const frozen = clone(priors);
  reconcile(sampleExtraction, priors, MEETING);
  assert.deepEqual(priors, frozen);
});

test('a new decision claiming continuity is marked previousStateUnverified', () => {
  const ex = extractionWith([
    extractedDecision({ headline: SLOOSH_HEADLINE, status: 'CONFIRMED' })
  ]);
  const { decisions, events } = reconcile(ex, [], MEETING);
  assert.equal(decisions[0].status, 'NEW');
  assert.equal(decisions[0].previousStateUnverified, true);
  assert.match(events[0].reason, /no prior record exists/);
});
