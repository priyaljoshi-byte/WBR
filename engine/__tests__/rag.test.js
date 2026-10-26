/**
 * rag.test.js - the judgement, kept apart from the measurements.
 *
 * What these guard, in order of how expensive they are to notice late:
 *   - a colour with no reason never reaches the page
 *   - silence is never a colour: no call does not inherit yesterday's green,
 *     and a gap in the history breaks a streak rather than being counted through
 *   - grey is not a quieter amber
 *   - the subject is generic, so Marketing's tracks work exactly like Perf
 *     Marketing's brands with no code change
 *   - the two flags it raises are deliberately different kinds
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { rollupRag, ragTrend, invalidReason, RAG_STATUSES } from '../rag.js';
import { deriveRagFlags } from '../flags.js';
import { ragSection } from '../../render/rag.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const org = JSON.parse(
  await readFile(path.join(HERE, '..', '..', 'config', 'org.json'), 'utf8')
);

const NOW = '2026-10-25T09:00:00.000Z';
const DAY = 86400000;

/** One call, `daysAgo` before NOW. */
function call(subject, status, daysAgo, over = {}) {
  const at = new Date(Date.parse(NOW) - daysAgo * DAY);
  return {
    subject,
    dept: 'perf_marketing',
    status,
    reason: `${status} because of a thing somebody can argue with`,
    setBy: 'Ankit',
    setAt: at.toISOString(),
    periodStart: at.toISOString().slice(0, 10),
    ...over
  };
}

const roll = (statuses, cfg = {}) => rollupRag(statuses, { now: NOW, ...cfg });
const find = (rollup, dept, subject) =>
  rollup.byDept[dept].subjects.find((s) => s.subject === subject);

/* ------------------------------------------------------------------------ *
 * a colour with no reason is not a judgement
 * ------------------------------------------------------------------------ */

test('a status with no reason is dropped and reported, never displayed', () => {
  const rollup = roll([
    call('Kiara', 'red', 0),
    call('Halo', 'red', 0, { reason: '' }),
    call('Vessel', 'amber', 0, { reason: '   ' })
  ]);

  assert.deepEqual(rollup.byDept.perf_marketing.subjects.map((s) => s.subject), ['Kiara']);
  assert.equal(rollup.invalid.length, 2);
  assert.equal(rollup.warnings.length, 2);
  assert.match(rollup.warnings[0], /Halo/);
  assert.match(rollup.warnings[0], /it is a mood/);
});

test('invalidReason names each way a status can fail', () => {
  assert.match(invalidReason(null), /not an object/);
  assert.match(invalidReason({ status: 'red', reason: 'x', setAt: NOW }), /no subject named/);
  assert.match(invalidReason(call('K', 'purple', 0)), /is not one of/);
  assert.match(invalidReason({ ...call('K', 'red', 0), reason: '' }), /mood/);
  assert.match(
    invalidReason({ subject: 'K', status: 'red', reason: 'x' }),
    /cannot be dated/
  );
  assert.equal(invalidReason(call('K', 'red', 0)), null);
});

/* ------------------------------------------------------------------------ *
 * counts, reds, streaks
 * ------------------------------------------------------------------------ */

test('a rollup counts each colour and names the subjects currently red', () => {
  const rollup = roll([
    call('Kiara', 'red', 0), call('Vessel', 'red', 0),
    call('Lumen', 'amber', 0),
    call('Norda', 'green', 0),
    call('Atlas', 'grey', 0)
  ]);
  const dept = rollup.byDept.perf_marketing;

  assert.deepEqual(dept.counts, { red: 2, amber: 1, green: 1, grey: 1 });
  assert.equal(dept.total, 5);
  assert.deepEqual(dept.red.sort(), ['Kiara', 'Vessel']);
});

test('consecutive days on one colour are counted, and a gap breaks the streak', () => {
  const unbroken = roll([0, 1, 2, 3, 4].map((d) => call('Kiara', 'red', d)));
  assert.equal(find(unbroken, 'perf_marketing', 'Kiara').daysHeld, 5);

  // called red today and yesterday, nothing on the day before, red again twice
  // before that. Three of those days nobody looked, so the streak is 2.
  const gapped = roll([0, 1, 3, 4].map((d) => call('Kiara', 'red', d)));
  assert.equal(find(gapped, 'perf_marketing', 'Kiara').daysHeld, 2,
    'you cannot claim five days red if nobody looked on one of them');

  // a colour change also ends it
  const changed = roll([call('Kiara', 'red', 0), call('Kiara', 'amber', 1), call('Kiara', 'amber', 2)]);
  assert.equal(find(changed, 'perf_marketing', 'Kiara').daysHeld, 1);
  assert.equal(find(changed, 'perf_marketing', 'Kiara').status, 'red');
});

test('two calls on the same day keep the later one - the stand-up changed its mind', () => {
  const morning = call('Kiara', 'red', 0);
  const afternoon = {
    ...call('Kiara', 'green', 0),
    setAt: new Date(Date.parse(morning.setAt) + 3600000).toISOString(),
    reason: 'the losing placement was found and paused'
  };
  const rollup = roll([morning, afternoon]);
  const kiara = find(rollup, 'perf_marketing', 'Kiara');

  assert.equal(kiara.status, 'green');
  assert.match(kiara.reason, /losing placement/);
});

test('red sorts first, and the longest-held red sorts above a newer one', () => {
  const rollup = roll([
    call('Norda', 'green', 0),
    call('Atlas', 'grey', 0),
    call('Fresh', 'red', 0),
    ...[0, 1, 2, 3].map((d) => call('Old', 'red', d)),
    call('Lumen', 'amber', 0)
  ]);

  assert.deepEqual(
    rollup.byDept.perf_marketing.subjects.map((s) => s.subject),
    ['Old', 'Fresh', 'Lumen', 'Atlas', 'Norda'],
    'red longest-held, red, amber, grey, green'
  );
});

/* ------------------------------------------------------------------------ *
 * grey is its own thing
 * ------------------------------------------------------------------------ */

test('grey is a fourth status, and it is not a quieter amber', () => {
  assert.deepEqual(RAG_STATUSES, ['red', 'amber', 'green', 'grey']);

  const rollup = roll([call('Atlas', 'grey', 0), call('Lumen', 'amber', 0)]);
  const dept = rollup.byDept.perf_marketing;
  assert.equal(dept.counts.grey, 1);
  assert.equal(dept.counts.amber, 1);

  // and it never raises the red flag, however long it is held
  const held = roll([0, 1, 2, 3, 4, 5].map((d) => call('Atlas', 'grey', d)));
  assert.equal(find(held, 'perf_marketing', 'Atlas').daysHeld, 6);
  const offTarget = deriveRagFlags(held, { org, now: NOW }).filter((f) => f.kind === 'off_target');
  assert.equal(offTarget.length, 0, 'not started is not off target');
});

/* ------------------------------------------------------------------------ *
 * staleness - a daily call that stopped being made
 * ------------------------------------------------------------------------ */

test('a call older than the staleness window is marked stale, not carried forward', () => {
  const rollup = roll([call('Kiara', 'green', 0), call('Vessel', 'green', 4)]);

  assert.equal(find(rollup, 'perf_marketing', 'Kiara').stale, false);
  const vessel = find(rollup, 'perf_marketing', 'Vessel');
  assert.equal(vessel.stale, true);
  assert.equal(vessel.status, 'green', 'the last thing said is still shown - just labelled stale');
  assert.deepEqual(rollup.byDept.perf_marketing.stale, ['Vessel']);
});

test('the staleness window is configurable, because not every call is daily', () => {
  const statuses = [call('Vessel', 'green', 4)];
  assert.equal(find(roll(statuses), 'perf_marketing', 'Vessel').stale, true);
  assert.equal(
    find(roll(statuses, { stale_after_hours: 24 * 7 }), 'perf_marketing', 'Vessel').stale,
    false
  );
});

/* ------------------------------------------------------------------------ *
 * the trend strip
 * ------------------------------------------------------------------------ */

test('ragTrend returns one slot per day, oldest first, with gaps left empty', () => {
  const statuses = [
    call('Kiara', 'red', 0), call('Kiara', 'red', 1),
    call('Kiara', 'amber', 3), call('Kiara', 'green', 6)
  ];
  const trend = ragTrend(statuses, 'Kiara', 7, { now: NOW });

  assert.equal(trend.length, 7);
  assert.deepEqual(trend.map((d) => d.status),
    ['green', null, null, 'amber', null, 'red', 'red']);
  assert.ok(trend[0].day < trend[6].day, 'oldest first');
  assert.equal(trend[6].day, '2026-10-25', 'the strip ends on today');
});

test('a day nobody called is null - never the day before, and never grey', () => {
  // the exact failure this module exists to prevent: a steady week of green for
  // something nobody has looked at since Monday
  const trend = ragTrend([call('Norda', 'green', 6)], 'Norda', 7, { now: NOW });
  assert.deepEqual(trend.map((d) => d.status), ['green', null, null, null, null, null, null]);
  assert.ok(!trend.some((d) => d.status === 'grey'), 'grey is a call, an absence is not');
});

test('the trend on the rollup and the standalone ragTrend cannot disagree', () => {
  const statuses = [call('Kiara', 'red', 0), call('Kiara', 'amber', 2)];
  const rollup = roll(statuses);
  assert.deepEqual(
    find(rollup, 'perf_marketing', 'Kiara').trend,
    ragTrend(statuses, 'Kiara', 7, { now: NOW })
  );
});

/* ------------------------------------------------------------------------ *
 * the subject is generic - this is not a Perf Marketing feature
 * ------------------------------------------------------------------------ */

test('any department can call colours, on tracks rather than brands, with no code change', () => {
  const rollup = roll([
    call('Kiara', 'red', 0),
    { ...call('US Lead Gen', 'amber', 0), dept: 'us_sales' },
    { ...call('SEO', 'grey', 0), dept: 'us_sales' },
    { ...call('Hiring pipeline', 'green', 0), dept: 'hiring' }
  ]);

  assert.deepEqual(Object.keys(rollup.byDept).sort(), ['hiring', 'perf_marketing', 'us_sales']);
  assert.deepEqual(
    rollup.byDept.us_sales.subjects.map((s) => s.subject),
    ['US Lead Gen', 'SEO'],
    'amber before grey, and nothing here knows these are tracks'
  );
  assert.equal(rollup.byDept.hiring.counts.green, 1);
});

test('brand is accepted as an alias for subject, and echoed back under both names', () => {
  const rollup = roll([{
    brand: 'Kiara', dept: 'perf_marketing', status: 'red',
    reason: 'ROAS under 1.4 since the creative refresh',
    setBy: 'Ankit', setAt: NOW, periodStart: '2026-10-25'
  }]);

  const kiara = rollup.byDept.perf_marketing.subjects[0];
  assert.equal(kiara.subject, 'Kiara');
  assert.equal(kiara.brand, 'Kiara', 'a per-brand caller reads the field it passed in');
  assert.deepEqual(rollup.byDept.perf_marketing.brands, rollup.byDept.perf_marketing.subjects);
  assert.deepEqual(rollup.brands, rollup.subjects);

  // and ragTrend finds it by either name
  assert.equal(ragTrend([{
    brand: 'Kiara', dept: 'perf_marketing', status: 'red', reason: 'x',
    setBy: 'Ankit', setAt: NOW
  }], 'Kiara', 7, { now: NOW }).at(-1).status, 'red');
});

/* ------------------------------------------------------------------------ *
 * flags
 * ------------------------------------------------------------------------ */

test('a subject red for three consecutive days raises off_target, naming the owner', () => {
  const two = deriveRagFlags(roll([0, 1].map((d) => call('Kiara', 'red', d))), { org, now: NOW });
  assert.equal(two.filter((f) => f.kind === 'off_target').length, 0,
    'two bad days is a bad week, not a flag');

  const three = deriveRagFlags(roll([0, 1, 2].map((d) => call('Kiara', 'red', d))), { org, now: NOW });
  const flag = three.find((f) => f.kind === 'off_target');
  assert.ok(flag, 'three in a row is a decision nobody has taken');
  assert.equal(flag.id, 'off_target:rag:perf_marketing:Kiara');
  assert.equal(flag.dept, 'perf_marketing');
  // Perf Marketing's trio is Raghav and Imran, so the flag lands on a real
  // person. The rule under test is "a flag names somebody", not "it names this
  // somebody" - an empty trio falling back to [OWNER NEEDED] is covered in
  // owners.test.js against a fixture.
  assert.ok(flag.owner && flag.owner !== '[OWNER NEEDED]',
    'a red streak must land on a named person');
  assert.match(flag.title, /red for 3 days/);
  assert.match(flag.body, /Ankit/, 'whose call it was');
  assert.match(flag.body, /human call from the daily stand-up, not a computed figure/);
});

test('the red threshold is configurable', () => {
  const rollup = roll([0, 1].map((d) => call('Kiara', 'red', d)), { red_days_to_flag: 2 });
  assert.equal(deriveRagFlags(rollup, { org, now: NOW }).filter((f) => f.kind === 'off_target').length, 1);
});

test('a stale call raises rag_stale, which is deliberately NOT stale_source', () => {
  const flags = deriveRagFlags(roll([call('Vessel', 'amber', 4)]), { org, now: NOW });
  const flag = flags.find((f) => f.kind === 'rag_stale');

  assert.ok(flag);
  assert.equal(flag.id, 'rag_stale:perf_marketing:Vessel');
  assert.equal(flags.filter((f) => f.kind === 'stale_source').length, 0,
    'a person skipping a judgement is not a connector failing to sync');
  assert.match(flag.title, /No recent status call on Vessel/);
  assert.match(flag.body, /thirty seconds/, 'the ask is a person, not an engineer');
  assert.match(flag.body, /48-hour line/);
});

test('flag ids are stable across runs, so "open for two weeks" is answerable', () => {
  const statuses = [0, 1, 2].map((d) => call('Kiara', 'red', d));
  const a = deriveRagFlags(roll(statuses), { org, now: NOW }).map((f) => f.id);
  const b = deriveRagFlags(roll(statuses), { org, now: NOW }).map((f) => f.id);
  assert.deepEqual(a, b);
});

test('deriveRagFlags survives an empty or absent rollup', () => {
  assert.deepEqual(deriveRagFlags(null), []);
  assert.deepEqual(deriveRagFlags(roll([])), []);
});

/* ------------------------------------------------------------------------ *
 * the section must not look like a ring card
 * ------------------------------------------------------------------------ */

test('the RAG section says it is a judgement and carries no ring machinery', () => {
  const html = ragSection(roll([
    call('Kiara', 'red', 0),
    { ...call('US Lead Gen', 'amber', 0), dept: 'us_sales' }
  ]), org);

  assert.match(html, /daily stand-up judgement/);
  assert.match(html, /somebody&rsquo;s opinion/);

  // none of the ring card's vocabulary appears
  for (const ringThing of ['ring-card', 'class="ar"', 'class="fill"', 'data-dash', 'class="cnt"', '/100']) {
    assert.ok(!html.includes(ringThing), `the RAG section must not emit ${ringThing}`);
  }
  assert.ok(!/\bmetric\b/i.test(html), 'it must not call a judgement a metric');
});

test('every row carries the reason and the person who made the call', () => {
  const html = ragSection(roll([call('Kiara', 'red', 0, {
    reason: 'ROAS under 1.4 since the creative refresh', setBy: 'Ankit'
  })]), org);

  assert.match(html, /ROAS under 1\.4 since the creative refresh/);
  assert.match(html, /Ankit/);
  assert.equal((html.match(/class="rgrow/g) || []).length, 1);
});

test('red rows render first and a stale row is marked, not hidden', () => {
  const html = ragSection(roll([
    call('Norda', 'green', 0),
    call('Vessel', 'amber', 4),
    call('Kiara', 'red', 0)
  ]), org);

  const order = [...html.matchAll(/rg-subject">([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Kiara', 'Vessel', 'Norda']);
  assert.match(html, /rgrow-stale/);
  assert.match(html, /Vessel/, 'a stale call is still shown - it is what was last said');
});

test('a day nobody called renders as its own thing, not as a colour', () => {
  const html = ragSection(roll([call('Norda', 'green', 0)]), org);
  assert.equal((html.match(/rg-d rg-none/g) || []).length, 6, 'six uncalled days in the strip');
  assert.equal((html.match(/rg-d rg-green/g) || []).length, 1);
});

test('no calls at all renders nothing rather than an empty heading', () => {
  assert.equal(ragSection(roll([]), org), '');
  assert.equal(ragSection(null, org), '');
});
