import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileBlockers, ageInWeeks } from '../blockers.js';
import { MATCH_THRESHOLD, REVIEW_FLOOR } from '../continuity.js';
import {
  sampleExtraction,
  clone,
  MEETING,
  MEETING_DATES,
  blocker,
  extractionWith,
  extractedBlocker
} from './helpers.js';

const CFG = { meetingDates: MEETING_DATES };

function blockerExtraction(blockers) {
  return extractionWith([], { blockers });
}

// --- ageing -----------------------------------------------------------------

test('a blocker raised this week is in week 1', () => {
  assert.equal(ageInWeeks('2025-09-08', '2025-09-08'), 1);
  assert.equal(ageInWeeks('2025-09-01', '2025-09-08'), 2);
  assert.equal(ageInWeeks('2025-08-25', '2025-09-08'), 3);
});

test('age is computed from raisedAt, so a rewritten title cannot reset it', () => {
  const prior = blocker({
    id: 'b-pricing-page',
    title: 'US outbound is blocked on the Sloosh pricing page',
    raisedAt: '2025-08-25',
    ageWeeks: 2
  });
  const ex = blockerExtraction([
    extractedBlocker({
      title: 'US outbound is blocked on the Sloosh pricing page',
      raisedAt: '2025-09-08' // the extractor guessed today
    })
  ]);
  const { blockers } = reconcileBlockers(ex, [prior], MEETING, CFG);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].raisedAt, '2025-08-25');
  assert.equal(blockers[0].ageWeeks, 3);
});

// --- escalation --------------------------------------------------------------

test('a blocker past escalate_after_weeks is escalated and raises a flag', () => {
  const ex = blockerExtraction([
    extractedBlocker({
      title: 'US outbound is blocked on the Sloosh pricing page',
      raisedAt: '2025-08-25',
      status: 'open'
    })
  ]);
  const { blockers, flags, events } = reconcileBlockers(ex, [], MEETING, CFG);

  assert.equal(blockers[0].ageWeeks, 3);
  assert.equal(blockers[0].status, 'escalated', 'escalation does not wait to be remembered');

  const flag = flags.find((f) => f.kind === 'overdue');
  assert.ok(flag, 'an escalated blocker raises a flag');
  assert.match(flag.title, /Week 3/);
  assert.match(flag.body, /US Sales has been waiting on Sloosh Product & Marketing for 3 weeks/);
  assert.equal(flag.dept, 'sloosh', 'the flag goes to the team that can clear it');

  assert.ok(events.some((e) => e.toStatus === 'escalated' && e.matchedBy === 'ageing'));
});

test('a blocker inside the window is not escalated', () => {
  const ex = blockerExtraction([
    extractedBlocker({ title: 'US outbound needs the Sloosh pricing page', raisedAt: '2025-09-01' })
  ]);
  const { blockers, flags } = reconcileBlockers(ex, [], MEETING, CFG);
  assert.equal(blockers[0].ageWeeks, 2);
  assert.equal(blockers[0].status, 'open');
  assert.equal(flags.filter((f) => f.kind === 'overdue').length, 0);
});

// --- a blocker never silently disappears -------------------------------------

test('an unmentioned blocker carries, keeps its age, and does not vanish', () => {
  const prior = blocker({
    id: 'b-tracking',
    title: 'Perf marketing needs signup event tracking from Sloosh',
    raisedBy: 'perf_marketing',
    raisedAt: '2025-09-01',
    status: 'open'
  });

  const { blockers, events } = reconcileBlockers(blockerExtraction([]), [prior], MEETING, CFG);

  assert.equal(blockers.length, 1, 'silence is not resolution');
  assert.equal(blockers[0].status, 'carried');
  assert.equal(blockers[0].ageWeeks, 2);

  const ev = events.find((e) => e.blockerId === prior.id);
  assert.equal(ev.toStatus, 'carried');
  assert.equal(ev.matchedBy, 'unmentioned');
  assert.match(ev.reason, /not raised at 2025-09-08/);
});

test('an unmentioned blocker that crosses the line escalates on its own', () => {
  const prior = blocker({
    id: 'b-old',
    title: 'US outbound is blocked on the Sloosh pricing page',
    raisedAt: '2025-08-25',
    status: 'open'
  });
  const { blockers, flags } = reconcileBlockers(blockerExtraction([]), [prior], MEETING, CFG);
  assert.equal(blockers[0].status, 'escalated');
  assert.equal(blockers[0].ageWeeks, 3);
  assert.equal(flags.filter((f) => f.kind === 'overdue').length, 1);
});

test('a resolved blocker stays resolved and stops ageing', () => {
  const prior = blocker({
    id: 'b-done',
    status: 'resolved_in_room',
    resolution: 'Offers went out on 2025-09-02.',
    raisedAt: '2025-08-01'
  });
  const { blockers, events, flags } = reconcileBlockers(
    blockerExtraction([]),
    [prior],
    MEETING,
    CFG
  );
  assert.equal(blockers[0].status, 'resolved_in_room');
  assert.deepEqual(events, []);
  assert.equal(flags.length, 0);
});

test('a resolved blocker cannot be quietly reopened', () => {
  const prior = blocker({ id: 'b-done', status: 'resolved_in_room', resolution: 'done' });
  const ex = blockerExtraction([
    extractedBlocker({ id: 'b-done', title: prior.title, status: 'open' })
  ]);
  const { blockers, errors, events } = reconcileBlockers(ex, [prior], MEETING, CFG);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /cannot reopen a blocker that is resolved_in_room/);
  assert.equal(blockers[0].status, 'resolved_in_room');
  assert.deepEqual(events, []);
});

// --- the three flag conditions -----------------------------------------------

test('a blocker with no other end is flagged, not rejected', () => {
  const ex = blockerExtraction([
    extractedBlocker({
      title: 'India sales cannot close without legal review',
      raisedBy: 'india_sales',
      needsFrom: null
    })
  ]);
  const { blockers, flags } = reconcileBlockers(ex, [], MEETING, CFG);
  assert.equal(blockers.length, 1, 'it is still recorded');
  const flag = flags.find((f) => f.kind === 'missing_data');
  assert.ok(flag);
  assert.match(flag.title, /No team named/);
  assert.match(flag.body, /cannot be resolved in the room/);
});

test('needsFrom is filled in later without resetting the age', () => {
  const prior = blocker({
    id: 'b-pricing',
    title: 'US outbound is blocked on the pricing page',
    needsFrom: null,
    raisedAt: '2025-09-01'
  });
  const ex = blockerExtraction([
    extractedBlocker({
      title: 'US outbound is blocked on the pricing page',
      needsFrom: 'sloosh'
    })
  ]);
  const { blockers, flags } = reconcileBlockers(ex, [prior], MEETING, CFG);
  assert.equal(blockers.length, 1, 'naming the other end is not a new blocker');
  assert.equal(blockers[0].needsFrom, 'sloosh');
  assert.equal(blockers[0].ageWeeks, 2);
  assert.equal(flags.filter((f) => f.kind === 'missing_data').length, 0);
});

test('a blocker closed with no resolution written is flagged', () => {
  const ex = blockerExtraction([
    extractedBlocker({ title: 'US sales needed the pricing page', status: 'resolved_in_room' })
  ]);
  const { flags } = reconcileBlockers(ex, [], MEETING, CFG);
  const flag = flags.find((f) => f.kind === 'no_proof');
  assert.ok(flag);
  assert.match(flag.body, /comes back next week as the same blocker/);
});

test('a blocker closed with a resolution is not flagged', () => {
  const ex = blockerExtraction([
    extractedBlocker({
      title: 'US sales needed the pricing page',
      status: 'resolved_in_room',
      resolution: 'Nikhil ships it on 2025-09-11.'
    })
  ]);
  const { flags, blockers } = reconcileBlockers(ex, [], MEETING, CFG);
  assert.equal(flags.length, 0);
  assert.equal(blockers[0].resolvedAt, '2025-09-08');
});

// --- matching discipline -------------------------------------------------------

test('a restated blocker matches rather than duplicating', () => {
  const prior = blocker({
    id: 'b-pricing',
    title: 'US outbound is blocked on the Sloosh pricing page',
    raisedAt: '2025-09-01'
  });
  const ex = blockerExtraction([
    extractedBlocker({ title: 'US outbound is blocked on the Sloosh pricing page' })
  ]);
  const { blockers, events } = reconcileBlockers(ex, [prior], MEETING, CFG);
  assert.equal(blockers.length, 1);
  assert.equal(events[0].matchedBy, 'title');
  assert.ok(events[0].matchScore >= MATCH_THRESHOLD);
});

test('a different team raising a similar thing is its own blocker', () => {
  const prior = blocker({
    id: 'b-pricing',
    raisedBy: 'us_sales',
    title: 'Outbound is blocked on the Sloosh pricing page'
  });
  const ex = blockerExtraction([
    extractedBlocker({
      raisedBy: 'perf_marketing',
      title: 'Outbound is blocked on the Sloosh pricing page'
    })
  ]);
  const { blockers } = reconcileBlockers(ex, [prior], MEETING, CFG);
  assert.equal(blockers.length, 2, 'two teams waiting is two dependencies');
});

test('a near-miss blocker title goes to a human instead of merging', () => {
  const prior = blocker({
    id: 'b-a',
    raisedBy: 'us_sales',
    title: 'Fix Sloosh activation before increasing US ad spend'
  });
  const ex = blockerExtraction([
    extractedBlocker({
      raisedBy: 'us_sales',
      title: 'Fix Sloosh activation before increasing paid acquisition budget'
    })
  ]);
  const { blockers, unmatched } = reconcileBlockers(ex, [prior], MEETING, CFG);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].tag, 'needs_human_merge');
  assert.ok(unmatched[0].score >= REVIEW_FLOOR && unmatched[0].score < MATCH_THRESHOLD);
  assert.equal(blockers.length, 1, 'the predecessor is untouched');
});

// --- the sample meeting ----------------------------------------------------------

test('the sample meeting produces four blockers, one of them escalated', () => {
  const { blockers, flags } = reconcileBlockers(sampleExtraction, [], MEETING, CFG);

  assert.equal(blockers.length, 4);

  const pricing = blockers.find((b) => /pricing page/.test(b.title));
  assert.equal(pricing.raisedBy, 'us_sales');
  assert.equal(pricing.needsFrom, 'sloosh');
  assert.equal(pricing.ageWeeks, 3);
  assert.equal(pricing.status, 'escalated');

  const sdr = blockers.find((b) => /SDR offers/.test(b.title));
  assert.equal(sdr.status, 'resolved_in_room');
  assert.ok(sdr.resolution.length > 0);
  assert.equal(sdr.resolvedAt, '2025-09-08');

  assert.equal(flags.filter((f) => f.kind === 'overdue').length, 1);
  assert.equal(flags.filter((f) => f.kind === 'no_proof').length, 0);
  assert.equal(flags.filter((f) => f.kind === 'missing_data').length, 0);
});

test('reconcileBlockers does not mutate the blockers handed to it', () => {
  const priors = [blocker({ id: 'b-1', raisedAt: '2025-08-25' })];
  const frozen = clone(priors);
  reconcileBlockers(sampleExtraction, priors, MEETING, CFG);
  assert.deepEqual(priors, frozen);
});
