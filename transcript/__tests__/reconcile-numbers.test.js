import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileStated,
  annotateSnapshots,
  DEFAULT_TOLERANCE,
  DEFAULT_ABSOLUTE_FLOOR
} from '../reconcile-numbers.js';
import { sampleExtraction, sampleSnapshots, snap, MEETING } from './helpers.js';

test('a stated number 20 percent off the measured value raises a contradiction', () => {
  const { contradictions } = reconcileStated(
    [{ metricId: 'sloosh_signups', statedValue: 240, statedBy: 'Nikhil', quote: 'about two forty' }],
    [snap('sloosh_signups', 200)],
    { meeting: MEETING }
  );

  assert.equal(contradictions.length, 1);
  const flag = contradictions[0];
  assert.equal(flag.kind, 'contradiction');
  assert.equal(flag.raisedBy, 'transcript');
  assert.deepEqual(flag.metricIds, ['sloosh_signups']);
  assert.equal(flag.statedValue, 240);
  assert.equal(flag.measuredValue, 200);
  assert.equal(flag.statedBy, 'Nikhil');
  assert.equal(flag.dept, 'sloosh');
  // The flag has to be arguable in the room, so it names all four things.
  assert.match(flag.body, /Nikhil/);
  assert.match(flag.body, /240/);
  assert.match(flag.body, /200/);
  assert.match(flag.body, /about two forty/);
});

test('a stated number 2 percent off the measured value does not', () => {
  const { matches, contradictions } = reconcileStated(
    [{ metricId: 'in_pipeline_india', statedValue: 46000000, statedBy: 'Arjun', quote: 'four point six crore' }],
    [snap('in_pipeline_india', 45000000)],
    { meeting: MEETING }
  );

  assert.deepEqual(contradictions, []);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].within, true);
  assert.ok(matches[0].relDiff < DEFAULT_TOLERANCE);
});

test('the absolute floor stops tiny counts from false-positiving', () => {
  // 11 against 10 is a 10 percent divergence and a completely uninteresting
  // sentence. The floor is what keeps it off the founder's page.
  const { matches, contradictions } = reconcileStated(
    [{ metricId: 'india_meetings_held', statedValue: 11, statedBy: 'Arjun', quote: 'eleven meetings' }],
    [snap('india_meetings_held', 10)],
    { meeting: MEETING }
  );
  assert.deepEqual(contradictions, []);
  assert.equal(matches[0].within, true);
  assert.equal(matches[0].allowed, DEFAULT_ABSOLUTE_FLOOR);

  // Two off the same base clears the floor and is flagged.
  const bigger = reconcileStated(
    [{ metricId: 'india_meetings_held', statedValue: 13, statedBy: 'Arjun', quote: 'thirteen meetings' }],
    [snap('india_meetings_held', 10)],
    { meeting: MEETING }
  );
  assert.equal(bigger.contradictions.length, 1);
});

test('tolerance and floor are both tunable', () => {
  const stated = [{ metricId: 'sloosh_signups', statedValue: 206, statedBy: 'Nikhil', quote: 'two oh six' }];
  const snaps = [snap('sloosh_signups', 200)];

  assert.equal(reconcileStated(stated, snaps, { meeting: MEETING }).contradictions.length, 0);
  assert.equal(
    reconcileStated(stated, snaps, { meeting: MEETING, tolerance: 0.01 }).contradictions.length,
    1
  );
  assert.equal(
    reconcileStated(stated, snaps, { meeting: MEETING, tolerance: 0.01, absoluteFloor: 50 })
      .contradictions.length,
    0
  );
});

test('a number with no measurement is surfaced, not silently dropped', () => {
  const { matches, contradictions, unmeasured } = reconcileStated(
    [
      { metricId: 'sloosh_wau', statedValue: 900, statedBy: 'Nikhil', quote: 'about nine hundred' },
      { metricId: 'sloosh_paid', statedValue: 4, statedBy: 'Nikhil', quote: 'four paid' }
    ],
    [snap('sloosh_paid', null)],
    { meeting: MEETING }
  );
  assert.deepEqual(matches, []);
  assert.deepEqual(contradictions, []);
  assert.equal(unmeasured.length, 2);
  assert.match(unmeasured[0].why, /no measured value|not in catalog/);
});

test('the sample meeting produces exactly one contradiction', () => {
  // Nikhil says two hundred and twenty signups. The data measured 180.
  const { matches, contradictions } = reconcileStated(
    sampleExtraction.statedNumbers,
    sampleSnapshots(),
    { meeting: MEETING }
  );
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].metricIds[0], 'sloosh_signups');
  assert.equal(matches.length, 2, 'the pipeline and meetings numbers both hold up');
});

test('a measured zero with a non-zero claim is always a contradiction', () => {
  const { contradictions } = reconcileStated(
    [{ metricId: 'us_created_wk', statedValue: 50000, statedBy: 'Dana', quote: 'fifty grand created' }],
    [snap('us_created_wk', 0)],
    { meeting: MEETING }
  );
  assert.equal(contradictions.length, 1);
  assert.match(contradictions[0].body, /unbounded/);
});

test('annotateSnapshots copies the stated value onto the snapshot without mutating', () => {
  const snaps = [snap('sloosh_signups', 180)];
  const out = annotateSnapshots(snaps, sampleExtraction.statedNumbers);
  assert.equal(out[0].statedValue, 220);
  assert.equal(out[0].statedBy, 'Nikhil');
  assert.equal(snaps[0].statedValue, undefined, 'input is not mutated');
});
