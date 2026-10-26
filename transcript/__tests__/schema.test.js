import test from 'node:test';
import assert from 'node:assert/strict';

import { validateExtraction, wordCount, MAX_HEADLINE_WORDS } from '../schema.js';
import { sampleExtraction, clone } from './helpers.js';

test('the sample extraction validates clean', () => {
  const { ok, errors } = validateExtraction(sampleExtraction);
  assert.deepEqual(errors, [], 'fixture should be a known-good extraction');
  assert.equal(ok, true);
});

test('a CHANGED decision with an empty reason is rejected', () => {
  const ex = clone(sampleExtraction);
  ex.decisions[0].status = 'CHANGED';
  ex.decisions[0].reason = '';

  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  const hit = errors.find((e) => e.startsWith('decisions[0].reason'));
  assert.ok(hit, `expected a reason error, got: ${errors.join(' | ')}`);
  assert.match(hit, /CHANGED/);
});

test('REASON_REQUIRED is enforced for every status that needs it', () => {
  for (const status of ['CHANGED', 'REVERSED', 'DEFERRED', 'DROPPED']) {
    const ex = clone(sampleExtraction);
    ex.decisions[0].status = status;
    delete ex.decisions[0].reason;
    const { ok, errors } = validateExtraction(ex);
    assert.equal(ok, false, `${status} with no reason must fail`);
    assert.ok(errors.some((e) => e.includes('decisions[0].reason')), `${status}: ${errors}`);
  }
});

test('a whitespace-only reason does not count as a reason', () => {
  const ex = clone(sampleExtraction);
  ex.decisions[0].status = 'DEFERRED';
  ex.decisions[0].reason = '   ';
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('decisions[0].reason')));
});

test('a headline of 14 words or more is rejected', () => {
  const ex = clone(sampleExtraction);
  const long = 'Fix the catalogue feed quality problem before we onboard any further new client accounts';
  assert.ok(wordCount(long) > MAX_HEADLINE_WORDS);
  ex.decisions[0].headline = long;

  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /headline.*must be under 14/.test(e)), errors.join(' | '));
});

test('a 13 word headline is accepted', () => {
  const ex = clone(sampleExtraction);
  ex.decisions[0].headline = 'One two three four five six seven eight nine ten eleven twelve thirteen';
  const { errors } = validateExtraction(ex);
  assert.deepEqual(errors.filter((e) => e.includes('headline')), []);
});

test('a domain outside DOMAINS is rejected', () => {
  const ex = clone(sampleExtraction);
  ex.decisions[0].domain = 'Delivery Ops';
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /domain: "Delivery Ops" is not in DOMAINS/.test(e)));
});

test('a status outside DECISION_STATUSES is rejected', () => {
  const ex = clone(sampleExtraction);
  ex.decisions[0].status = 'APPROVED';
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /is not a DecisionStatus/.test(e)));
});

test('statedNumbers must reference a real catalog metric id', () => {
  const ex = clone(sampleExtraction);
  ex.statedNumbers[0].metricId = 'assets_shipped_total';
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(
    errors.some((e) => /statedNumbers\[0\].metricId: "assets_shipped_total" is not a metric id/.test(e)),
    errors.join(' | ')
  );
});

test('decision metricIds must reference real catalog metric ids', () => {
  const ex = clone(sampleExtraction);
  ex.decisions[0].metricIds = ['assets_total', 'rework_hours'];
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /metricIds\[1\]: "rework_hours"/.test(e)), errors.join(' | '));
});

test('a note must target a real card id', () => {
  const ex = clone(sampleExtraction);
  ex.notes[0].cardId = 'delivery';
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /notes\[0\].cardId: "delivery" is not a card id/.test(e)));
});

test('a stated number without a verbatim quote is rejected', () => {
  const ex = clone(sampleExtraction);
  delete ex.statedNumbers[1].quote;
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /statedNumbers\[1\].quote/.test(e)));
});

test('every error is returned, not just the first', () => {
  const ex = clone(sampleExtraction);
  ex.decisions[0].domain = 'Nonsense';
  ex.decisions[0].status = 'APPROVED';
  ex.decisions[1].metricIds = ['nope'];
  ex.notes[0].cardId = 'nope';
  ex.statedNumbers[0].metricId = 'nope';

  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.length >= 5, `expected at least 5 errors, got ${errors.length}: ${errors}`);
});

test('a non-object extraction fails without throwing', () => {
  assert.deepEqual(validateExtraction(null), {
    ok: false,
    errors: ['extraction: expected an object']
  });
  assert.equal(validateExtraction([]).ok, false);
  assert.equal(validateExtraction('{}').ok, false);
});

test('missing required arrays are each reported', () => {
  const { ok, errors } = validateExtraction({ meetingId: 'm', meetingDate: '2025-09-08' });
  assert.equal(ok, false);
  for (const key of ['decisions', 'notes', 'statedNumbers', 'asks']) {
    assert.ok(errors.some((e) => e.startsWith(`${key}: required array`)), `${key} missing from ${errors}`);
  }
});

test('a blocker raisedBy must be one of the five lines of business', () => {
  const ex = clone(sampleExtraction);
  ex.blockers[0].raisedBy = 'sales';
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /blockers\[0\].raisedBy: "sales" is not a department id/.test(e)));
});

test('a blocker with no needsFrom is accepted by the schema and flagged elsewhere', () => {
  // Refusing to publish the week because one blocker is half-stated would hide
  // the other three.
  const ex = clone(sampleExtraction);
  ex.blockers[1].needsFrom = null;
  const { ok } = validateExtraction(ex);
  assert.equal(ok, true);
});

test('a blocker needs a specific ask and a valid status', () => {
  const ex = clone(sampleExtraction);
  ex.blockers[0].what = '';
  ex.blockers[1].status = 'stuck';
  ex.blockers[2].metricIds = ['not_a_metric'];
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /blockers\[0\].what/.test(e)));
  assert.ok(errors.some((e) => /blockers\[1\].status: "stuck" is not a BlockerStatus/.test(e)));
  assert.ok(errors.some((e) => /blockers\[2\].metricIds\[0\]/.test(e)));
});

test('blockers is a required array', () => {
  const ex = clone(sampleExtraction);
  delete ex.blockers;
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.startsWith('blockers: required array')));
});

test('an unknown statement kind is rejected', () => {
  const ex = clone(sampleExtraction);
  ex.statements[0].kind = 'Fact';
  const { ok, errors } = validateExtraction(ex);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /statements\[0\].kind/.test(e)));
});
