/**
 * engine.test.js - unit coverage for every engine module.
 *
 * Fixtures here are inline on purpose. The reference-ring proof lives in
 * reference-rings.test.js and the whole-catalogue run lives in
 * catalog-run.test.js; this file is the one that must keep passing while the
 * catalogue is being rewritten underneath it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, parseValue, looseEquals, median } from '../aggregate.js';
import { normalize, resolveDenominator, orderMetrics } from '../normalize.js';
import { health, DEFAULT_WARN_AT, DEFAULT_CRIT_AT } from '../health.js';
import { renderCaption, formatValue } from '../caption.js';
import { classifyFreshness, freshnessDetail } from '../freshness.js';
import { computeSnapshot } from '../compute.js';
import { deriveFlags } from '../flags.js';
import { rollupFamily, rollupAllFamilies } from '../rollup.js';
import { deptScoreboard } from '../scoreboard.js';

const PERIOD_START = '2026-10-19T00:00:00.000Z';
const PERIOD_END = '2026-10-26T00:00:00.000Z';
const NOW = '2026-10-25T04:30:00.000Z';
const HOUR = 3600 * 1000;

/* ------------------------------------------------------------------------ *
 * parseValue
 * ------------------------------------------------------------------------ */

test('parseValue coerces the formats real spreadsheets actually contain', () => {
  const cases = [
    ['1,32,00,000', 13200000],      // Indian comma grouping
    ['1,26,00,000', 12600000],
    ['1,234.50', 1234.5],           // Western grouping
    ['₹44L', 4400000],
    ['₹1.68L', 168000],
    ['44L', 4400000],
    ['1.32 Cr', 13200000],
    ['₹1.32 Cr', 13200000],
    ['4.47cr', 44700000],
    ['6.7 lakh', 670000],
    ['12K', 12000],
    ['23%', 23],                    // the percent VALUE, not 0.23
    ['1m43s', 103],                 // durations come back as seconds
    ['1:43', 103],
    ['0:30', 30],
    ['1:02:03', 3723],
    ['45s', 45],
    ['2h', 7200],
    ['Rs. 50,000', 50000],
    ['(1,200)', -1200],             // accounting negative
    ['-₹1,200', -1200],
    ['$12,400', 12400],
    [1234, 1234],
    ['  88  ', 88]
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseValue(input), expected, `parseValue(${JSON.stringify(input)})`);
  }
});

test('parseValue returns null - never 0 - for things that are not numbers', () => {
  for (const input of ['', '   ', 'N/A', 'n/a', '-', 'TBD', 'pending', null, undefined, true, false, {}, 'Rs. ???']) {
    assert.equal(parseValue(input), null, `parseValue(${JSON.stringify(input)}) must be null`);
  }
});

test('looseEquals treats yes / true / TRUE as the same thing, case-insensitively', () => {
  assert.ok(looseEquals('yes', true));
  assert.ok(looseEquals('TRUE', true));
  assert.ok(looseEquals(true, 'Yes'));
  assert.ok(looseEquals('no', false));
  assert.ok(looseEquals('Live', 'live'));
  assert.ok(looseEquals('  POC ', 'poc'));
  assert.ok(!looseEquals('yes', false));
  assert.ok(!looseEquals('Closed Won', 'POC'));
});

/* ------------------------------------------------------------------------ *
 * aggregate
 * ------------------------------------------------------------------------ */

test('a non-numeric row produces a warning and is skipped, NOT counted as 0', () => {
  const rows = {
    sourceRef: 'crm', columns: ['deal', 'value_inr'], fetchedAt: NOW, status: 'ok',
    rows: [
      { deal: 'A', value_inr: '₹1.32 Cr' },
      { deal: 'B', value_inr: 'TBD' },       // <- the liar
      { deal: 'C', value_inr: '1,26,00,000' }
    ]
  };
  const { value, rowCount, warnings } = aggregate(rows, { agg: 'sum', column: 'value_inr' });

  assert.equal(value, 13200000 + 12600000, 'the bad row must not drag the sum down by being read as 0');
  assert.equal(rowCount, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /row 2/);
  assert.match(warnings[0], /"TBD"/);
  assert.match(warnings[0], /not counted as 0/);

  // and the average is over 2 values, not 3
  assert.equal(aggregate(rows, { agg: 'avg', column: 'value_inr' }).value, (13200000 + 12600000) / 2);
});

test('when every matching row is unreadable the value is null, not 0', () => {
  const rows = [{ v: 'TBD' }, { v: '' }, { v: 'n/a' }];
  const { value, warnings } = aggregate(rows, { agg: 'sum', column: 'v' });
  assert.equal(value, null, 'three unreadable rows is not a sum of zero, it is "we do not know"');
  assert.ok(warnings.some((w) => /none held a usable number/.test(w)));
});

test('aggregate applies every where operator, case-insensitively', () => {
  const rows = [
    { stage: 'POC', owner: 'Subham', region: 'India', value_inr: '₹44L', touched: 'yes' },
    { stage: 'Closed Won', owner: 'Jatin', region: 'GCC', value_inr: '₹10L', touched: 'TRUE' },
    { stage: 'poc', owner: 'Subham', region: 'US', value_inr: '₹6L', touched: 'no' }
  ];
  assert.equal(aggregate(rows, { agg: 'count', where: { column: 'stage', equals: 'poc' } }).value, 2);
  assert.equal(aggregate(rows, { agg: 'count', where: { column: 'region', in: ['India', 'GCC'] } }).value, 2);
  assert.equal(aggregate(rows, { agg: 'count', where: { column: 'touched', equals: true } }).value, 2);
  assert.equal(aggregate(rows, { agg: 'count', where: { column: 'owner', contains: 'ubh' } }).value, 2);
  assert.equal(aggregate(rows, { agg: 'sum', column: 'value_inr', where: { column: 'value_inr', gt: 1000000 } }).value, 4400000);
  assert.equal(aggregate(rows, { agg: 'sum', column: 'value_inr', where: { column: 'value_inr', lte: 1000000 } }).value, 1600000);
  assert.equal(aggregate(rows, { agg: 'sum', column: 'value_inr', where: { column: 'value_inr', gte: 1000000 } }).value, 5400000);
  assert.equal(aggregate(rows, { agg: 'sum', column: 'value_inr', where: { column: 'value_inr', lt: 1000000 } }).value, 600000);
  assert.equal(aggregate(rows, { agg: 'count_distinct', column: 'owner' }).value, 2);
  assert.equal(aggregate(rows, { agg: 'min', column: 'value_inr' }).value, 600000);
  assert.equal(aggregate(rows, { agg: 'max', column: 'value_inr' }).value, 4400000);
  assert.equal(aggregate(rows, { agg: 'latest', column: 'value_inr' }).value, 600000);
});

test('agg=ratio divides one column total by another, and refuses to divide by zero', () => {
  const rows = [
    { spend: '₹40,000', leads: '20', customers: '2' },
    { spend: '₹60,000', leads: '30', customers: '3' }
  ];
  // CPL = 100000 / 50 = 2000
  assert.equal(aggregate(rows, { agg: 'ratio', numerator_column: 'spend', denominator_column: 'leads' }).value, 2000);
  // CAC = 100000 / 5 = 20000
  assert.equal(aggregate(rows, { agg: 'ratio', numerator_column: 'spend', denominator_column: 'customers' }).value, 20000);

  const noLeads = aggregate([{ spend: '₹40,000', leads: 0 }], { agg: 'ratio', numerator_column: 'spend', denominator_column: 'leads' });
  assert.equal(noLeads.value, null, 'zero leads is not a cost-per-lead of zero, nor of infinity');
  assert.match(noLeads.warnings.join(' '), /denominator totals 0/);

  const misconfigured = aggregate(rows, { agg: 'ratio', numerator_column: 'spend' });
  assert.equal(misconfigured.value, null);
  assert.match(misconfigured.warnings[0], /needs numerator_column and denominator_column/);
});

test('agg=median takes the middle value, which an outlier cannot drag', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);

  const rows = [{ d: 2 }, { d: 3 }, { d: 4 }, { d: 5 }, { d: 90 }];
  assert.equal(aggregate(rows, { agg: 'median', column: 'd' }).value, 4);
  assert.equal(aggregate(rows, { agg: 'avg', column: 'd' }).value, 20.8, 'the mean is the one the outlier ruins');
});

test('an unresolved {{template}} in a where clause is reported, not silently matched as zero', () => {
  const rows = [{ created_week: '2026-10-19', value: 100 }];
  const res = aggregate(rows, {
    agg: 'sum', column: 'value',
    where: { column: 'created_week', equals: '{{period.start}}' }
  });
  assert.equal(res.rowCount, 0);
  assert.match(res.warnings.join(' '), /unresolved template/);
  assert.match(res.warnings.join(' '), /not a real zero/);
});

/* ------------------------------------------------------------------------ *
 * denominators and dependency ordering
 * ------------------------------------------------------------------------ */

test('resolveDenominator handles all four kinds', () => {
  const rows = [{ ch: 'Direct', users: 410 }, { ch: 'Organic', users: '522' }];
  assert.equal(resolveDenominator({ id: 'a', denominator: { kind: 'static', value: 5, label: 'running' } }).value, 5);
  assert.equal(resolveDenominator({ id: 'a', denominator: { kind: 'static', value: 5, label: 'running' } }).label, 'running');
  assert.equal(resolveDenominator({ id: 'a', denominator: { kind: 'self' } }).value, null);
  assert.equal(resolveDenominator({ id: 'a', denominator: { kind: 'metric', metric: 'tot' } }, { raws: { tot: 932 } }).value, 932);
  assert.equal(resolveDenominator({ id: 'a', denominator: { kind: 'column_total', column: 'users' } }, { rows }).value, 932);
});

test('a kind=metric denominator that has not been computed yet warns instead of guessing', () => {
  const res = resolveDenominator({ id: 'child', denominator: { kind: 'metric', metric: 'parent' } }, { raws: {} });
  assert.equal(res.value, null);
  assert.match(res.warnings[0], /has not been computed yet/);
});

test('a static denominator with no value set warns rather than drawing a ring', () => {
  const res = resolveDenominator({ id: 'a', denominator: { kind: 'static', value: null, label: 'target' } });
  assert.equal(res.value, null);
  assert.match(res.warnings[0], /no usable value/);
  assert.equal(normalize(10, res).normalized, null);
});

test('orderMetrics puts a denominator metric before everything that divides by it', () => {
  const shuffled = [
    { id: 'in_poc', denominator: { kind: 'metric', metric: 'total' } },
    { id: 'closed_won', denominator: { kind: 'metric', metric: 'total' } },
    { id: 'total', denominator: { kind: 'self' } }
  ];
  const ordered = orderMetrics(shuffled).map((d) => d.id);
  assert.equal(ordered[0], 'total');
  assert.ok(ordered.indexOf('total') < ordered.indexOf('in_poc'));
  assert.ok(ordered.indexOf('total') < ordered.indexOf('closed_won'));
  assert.equal(ordered.length, 3);
});

test('a cycle in metric denominators throws, naming the cycle', () => {
  const defs = [
    { id: 'a', denominator: { kind: 'metric', metric: 'b' } },
    { id: 'b', denominator: { kind: 'metric', metric: 'c' } },
    { id: 'c', denominator: { kind: 'metric', metric: 'a' } }
  ];
  assert.throws(() => orderMetrics(defs), (err) => {
    assert.match(err.message, /cycle/i);
    assert.match(err.message, /a -> b -> c -> a/);
    return true;
  });
  assert.throws(
    () => orderMetrics([{ id: 'loop', denominator: { kind: 'metric', metric: 'loop' } }]),
    /loop -> loop/
  );
});

/* ------------------------------------------------------------------------ *
 * health
 * ------------------------------------------------------------------------ */

const fresh = { periodStart: PERIOD_START, lastSyncedAt: NOW, sourceStatus: 'ok' };

test('health applies its rules in order', () => {
  const tracked = { id: 'm', target: 100, warn_at: 0.7, crit_at: 0.4, direction: 'up' };
  assert.equal(health(tracked, null, fresh), 'missing', 'no value wins over everything');
  assert.equal(health(tracked, 90, { ...fresh, sourceStatus: 'error', sourceError: 'HTTP 403' }), 'missing');
  assert.equal(health(tracked, 90, { periodStart: PERIOD_START, lastSyncedAt: '2026-10-11T00:00:00.000Z' }), 'stale');
  assert.equal(health({ ...tracked, target: null }, 90, fresh), 'untracked');
  assert.equal(health(tracked, 90, fresh), 'good');
  assert.equal(health(tracked, 70, fresh), 'good', 'exactly at warn_at is still good');
  assert.equal(health(tracked, 69, fresh), 'warn');
  assert.equal(health(tracked, 40, fresh), 'warn', 'exactly at crit_at is warn');
  assert.equal(health(tracked, 39, fresh), 'crit');
});

test('health defaults warn_at/crit_at when a target is set but thresholds are not', () => {
  assert.equal(DEFAULT_WARN_AT, 0.7);
  assert.equal(DEFAULT_CRIT_AT, 0.4);
  const def = { id: 'm', target: 100, warn_at: null, crit_at: null, direction: 'up' };
  assert.equal(health(def, 80, fresh), 'good');
  assert.equal(health(def, 60, fresh), 'warn');
  assert.equal(health(def, 30, fresh), 'crit');
});

test('health inverts the ratio when lower is better', () => {
  const down = { id: 'm', target: 10, warn_at: 0.7, crit_at: 0.4, direction: 'down' };
  assert.equal(health(down, 5, fresh), 'good', 'half the allowed number is good news');
  assert.equal(health(down, 10, fresh), 'good');
  assert.equal(health(down, 20, fresh), 'warn', '10/20 = 0.5');
  assert.equal(health(down, 40, fresh), 'crit', '10/40 = 0.25');

  const zero = { id: 'm', target: 0, warn_at: null, crit_at: null, direction: 'down' };
  assert.equal(health(zero, 0, fresh), 'good', 'target 0 and raw 0 is a perfect score');
  assert.equal(health(zero, 7, fresh), 'crit');
});

/* ------------------------------------------------------------------------ *
 * caption formatting
 * ------------------------------------------------------------------------ */

test('formatValue uses Indian conventions for rupees', () => {
  assert.equal(formatValue(13200000, 'currency_inr'), '₹1.32 Cr');
  assert.equal(formatValue(44700000, 'currency_inr'), '₹4.47 Cr');
  assert.equal(formatValue(4400000, 'currency_inr'), '₹44L');
  assert.equal(formatValue(168000, 'currency_inr'), '₹1.68L');
  assert.equal(formatValue(670000, 'currency_inr'), '₹6.7L');
  assert.equal(formatValue(50000, 'currency_inr'), '₹50,000');
  assert.equal(formatValue(119428, 'count'), '1,19,428');
  assert.equal(formatValue(123990, 'count'), '1,23,990');
  assert.equal(formatValue(932, 'count'), '932');
});

test('formatValue uses Western conventions for dollars - never lakhs', () => {
  assert.equal(formatValue(1200000, 'currency_usd'), '$1.2M');
  assert.equal(formatValue(12400, 'currency_usd'), '$12.4K');
  assert.equal(formatValue(12000, 'currency_usd'), '$12K');
  assert.equal(formatValue(950, 'currency_usd'), '$950');
  assert.equal(formatValue(-12400, 'currency_usd'), '-$12.4K');
  assert.ok(!formatValue(1200000, 'currency_usd').includes('L'), 'a US number must never render as lakhs');
});

test('formatValue renders both duration units', () => {
  assert.equal(formatValue(103, 'duration'), '1m43s');
  assert.equal(formatValue(43, 'duration'), '43s');
  assert.equal(formatValue(3723, 'duration'), '1h2m3s');
  assert.equal(formatValue(12, 'duration_days'), '12d');
  assert.equal(formatValue(1.5, 'duration_days'), '1.5d');
  assert.equal(formatValue(1.46, 'duration_days'), '1.5d');
  assert.equal(formatValue(23, 'percent'), '23%');
  assert.equal(formatValue(null, 'count'), '—', 'a missing number is never printed as 0');
});

test('renderCaption resolves every token and collapses the empty-label gap', () => {
  assert.equal(
    renderCaption('{{raw}} of {{denominator}} {{denominator_label}}',
      { raw: 4, denominator: 5, denominator_label: 'running', unit: 'count' }),
    '4 of 5 running'
  );
  assert.equal(
    renderCaption('{{raw}} of {{denominator}} {{denominator_label}}',
      { raw: 168000, denominator: 670000, denominator_label: '', unit: 'currency_inr' }),
    '₹1.68L of ₹6.7L',
    'an empty denominator_label must not leave a double space'
  );
  assert.equal(
    renderCaption('{{raw}} of {{denominator}} ({{normalized}}% of target {{target}})',
      { raw: 46, denominator: 200, normalized: 23, target: 200, unit: 'count' }),
    '46 of 200 (23% of target 200)'
  );
  assert.equal(renderCaption('{{raw}}', { raw: 103, unit: 'duration' }), '1m43s');
  assert.equal(renderCaption('{{raw}} open', { raw: 12400, unit: 'currency_usd' }), '$12.4K open');
});

/* ------------------------------------------------------------------------ *
 * freshness - the founder's objection, turned into a measurement
 * ------------------------------------------------------------------------ */

const MEETING = '2026-10-26T04:30:00.000Z';
const hoursBefore = (h) => new Date(Date.parse(MEETING) - h * HOUR).toISOString();
const stamped = (hours) => ({
  sourceRef: 's', columns: ['updated_at'], status: 'ok', fetchedAt: MEETING,
  rows: hours.map((h, i) => ({ id: i, updated_at: hoursBefore(h) }))
});

test('a source written in the hours before the meeting reads as last_minute', () => {
  // 9 of 10 rows touched in the final 24h, on a source nobody had opened in a week
  const rows = stamped([2, 2, 3, 4, 5, 6, 7, 8, 9, 200]);
  const detail = freshnessDetail(rows, { id: 's' }, MEETING, {});
  assert.equal(detail.level, 'last_minute');
  assert.equal(detail.column, 'updated_at');
  assert.equal(detail.rowsInWindow, 9);
  assert.equal(detail.lastMinuteShare, 0.9);
});

test('last_minute is decided BEFORE recency, or everything assembled today reads as daily', () => {
  const rows = stamped([1, 1, 1, 1, 1]);   // all five written an hour before
  assert.equal(classifyFreshness(rows, { id: 's' }, MEETING, {}), 'last_minute');
  assert.notEqual(classifyFreshness(rows, { id: 's' }, MEETING, {}), 'daily');
});

test('the last-minute share is a threshold, and it is inclusive at the boundary', () => {
  // exactly 0.8 of rows inside the window -> last_minute
  assert.equal(classifyFreshness(stamped([1, 2, 3, 4, 5, 6, 7, 8, 100, 200]), { id: 's' }, MEETING, {}), 'last_minute');
  // 0.7 -> not last-minute, just a source in active use
  assert.equal(classifyFreshness(stamped([1, 2, 3, 4, 5, 6, 7, 100, 150, 200]), { id: 's' }, MEETING, {}), 'daily');
});

test('a source genuinely used day to day reads as daily, not last_minute', () => {
  // edits spread across the week, one of them recent
  const rows = stamped([5, 30, 50, 70, 90, 110, 130, 150, 170, 190]);
  const detail = freshnessDetail(rows, { id: 's' }, MEETING, {});
  assert.equal(detail.level, 'daily', 'newest row is 5h old and only 1 in 10 is inside the window');
  assert.equal(detail.rowsInWindow, 1);
});

test('freshness grades weekly and stale off the newest row', () => {
  assert.equal(classifyFreshness(stamped([100, 120, 140, 160, 180]), { id: 's' }, MEETING, {}), 'weekly');
  assert.equal(classifyFreshness(stamped([400, 500, 600, 700, 800]), { id: 's' }, MEETING, {}), 'stale');
});

test('freshness never guesses: no row timestamp means unknown, not stale', () => {
  const rows = { sourceRef: 's', columns: ['client'], status: 'ok', fetchedAt: MEETING, rows: [{ client: 'Zephyr' }] };
  const detail = freshnessDetail(rows, { id: 's' }, MEETING, {});
  assert.equal(detail.level, 'unknown');
  assert.match(detail.reason, /no row-level timestamp/);

  assert.equal(classifyFreshness({ status: 'error', rows: [], error: 'boom' }, { id: 's' }, MEETING, {}), 'unknown');
  assert.equal(classifyFreshness({ status: 'ok', rows: [] }, { id: 's' }, MEETING, {}), 'unknown');
});

test('an explicitly configured row_timestamp_column wins over auto-detection', () => {
  const rows = {
    status: 'ok', fetchedAt: MEETING,
    rows: [{ updated_at: hoursBefore(300), edited_on: hoursBefore(2) }]
  };
  assert.equal(freshnessDetail(rows, { id: 's' }, MEETING, {}).column, 'updated_at');
  assert.equal(freshnessDetail(rows, { id: 's', row_timestamp_column: 'edited_on' }, MEETING, {}).column, 'edited_on');
});

/* ------------------------------------------------------------------------ *
 * computeSnapshot
 * ------------------------------------------------------------------------ */

const channelsDef = {
  id: 'channels_live', label: 'Channels live', dept: 'marketing', unit: 'count',
  source: { ref: 'gtm', agg: 'count', where: { column: 'status', equals: 'live' } },
  denominator: { kind: 'static', value: 5, label: 'running' },
  direction: 'up', target: 5, warn_at: 0.7, crit_at: 0.4,
  caption: '{{raw}} of {{denominator}} {{denominator_label}}'
};
const channelRows = {
  sourceRef: 'gtm', columns: ['channel', 'status'], fetchedAt: NOW, status: 'ok',
  rows: [
    { channel: 'cold email', status: 'live' },
    { channel: 'linkedin', status: 'LIVE' },
    { channel: 'events', status: 'live' },
    { channel: 'partners', status: 'Live' },
    { channel: 'paid', status: 'paused' }
  ]
};

test('computeSnapshot produces a Snapshot with every contracted field', () => {
  const s = computeSnapshot(channelsDef, channelRows, {
    runId: 'run-1', periodStart: PERIOD_START, periodEnd: PERIOD_END, now: NOW,
    raws: {}, prior: { channels_live: { normalized: 60, raw: 3 } }
  });

  assert.deepEqual(Object.keys(s).sort(), [
    'caption', 'computedAt', 'delta', 'denominator', 'freshness', 'health', 'metricId',
    'normalized', 'periodEnd', 'periodStart', 'priorNormalized', 'priorRaw', 'raw',
    'rowCount', 'runId', 'unit', 'warnings'
  ].sort());

  assert.equal(s.raw, 4);
  assert.equal(s.denominator, 5);
  assert.equal(s.normalized, 80);
  assert.equal(s.priorRaw, 3);
  assert.equal(s.priorNormalized, 60);
  assert.equal(s.delta, 20);
  assert.equal(s.health, 'good');
  assert.equal(s.freshness, 'unknown', 'these rows carry no timestamp, so we do not claim to know');
  assert.equal(s.unit, 'count');
  assert.equal(s.caption, '4 of 5 running');
  assert.equal(s.rowCount, 4, 'rowCount is the rows that actually fed the number');
  assert.equal(s.computedAt, NOW);
  assert.deepEqual(s.warnings, []);
});

test('computeSnapshot copies segment and family through for the rollup', () => {
  const def = { ...channelsDef, id: 'pm_india_spend', segment: 'india', family: 'pm_spend', unit: 'currency_inr' };
  const s = computeSnapshot(def, channelRows, { periodStart: PERIOD_START, now: NOW, raws: {}, prior: {} });
  assert.equal(s.segment, 'india');
  assert.equal(s.family, 'pm_spend');
  assert.equal(s.unit, 'currency_inr');
});

test('delta is null when either side has no normalized value', () => {
  const noPrior = computeSnapshot(channelsDef, channelRows, { periodStart: PERIOD_START, now: NOW, raws: {}, prior: {} });
  assert.equal(noPrior.delta, null);

  const selfDef = { ...channelsDef, denominator: { kind: 'self' }, caption: '{{raw}} total' };
  const selfSnap = computeSnapshot(selfDef, channelRows, {
    periodStart: PERIOD_START, now: NOW, raws: {},
    prior: { channels_live: { normalized: 50, raw: 3 } }
  });
  assert.equal(selfSnap.normalized, null, 'kind=self has no ring fraction');
  assert.equal(selfSnap.delta, null);
});

test('an empty source is missing, not zero', () => {
  const s = computeSnapshot(channelsDef, { sourceRef: 'gtm', columns: [], rows: [], fetchedAt: NOW, status: 'empty' },
    { periodStart: PERIOD_START, now: NOW, raws: {}, prior: {} });
  assert.equal(s.raw, null);
  assert.equal(s.health, 'missing');
  assert.match(s.warnings.join(' '), /not 0/);
});

/* ------------------------------------------------------------------------ *
 * flags
 * ------------------------------------------------------------------------ */

const ORG = {
  departments: [
    { id: 'marketing', label: 'Marketing' },
    { id: 'legal', label: 'Legal' }
  ],
  owners: { marketing: { name: 'Sai', email: 'sai@shopos.ai' } },
  freshness: { last_minute_window_hours: 24, last_minute_row_share: 0.8 }
};
const SOURCES = { sources: [{ id: 'gtm', label: 'US lead gen tracker' }] };

const flagDefs = [
  {
    id: 'qualified_leads', label: 'Qualified leads', dept: 'marketing', unit: 'count',
    source: { ref: 'gtm', tab: 'Leads', agg: 'count' },
    direction: 'up', target: 5, warn_at: 0.6, crit_at: 0.2
  },
  {
    id: 'orphan_metric', label: 'Orphan metric', dept: 'legal', unit: 'count',
    source: { ref: 'nowhere', agg: 'count' },
    direction: 'up', target: 5, warn_at: 0.6, crit_at: 0.2
  },
  {
    id: 'untargeted', label: 'Untargeted metric', dept: 'marketing', unit: 'currency_inr',
    source: { ref: 'gtm', tab: 'Leads', agg: 'sum', column: 'v' },
    direction: 'up', target: null, warn_at: null, crit_at: null
  }
];

const snap = (over) => ({
  runId: 'run-1', metricId: 'qualified_leads', periodStart: PERIOD_START, periodEnd: PERIOD_END,
  raw: 2, denominator: 5, normalized: 40, priorRaw: null, priorNormalized: null, delta: null,
  health: 'warn', freshness: 'unknown', unit: 'count', caption: '2 of 5 target',
  rowCount: 10, computedAt: NOW, warnings: [], ...over
});

const cfg = (over) => ({ org: ORG, sources: SOURCES, now: NOW, ...over });

test('a warn that is getting WORSE is flagged', () => {
  const flags = deriveFlags([snap({ health: 'warn', delta: -15 })], flagDefs, cfg());
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'off_target');
  assert.equal(flags[0].id, 'off_target:qualified_leads');
  assert.equal(flags[0].owner, 'Sai');
  assert.match(flags[0].body, /Down 15 points/);
});

test('a warn that is IMPROVING is not flagged - that is progress, not noise', () => {
  assert.deepEqual(deriveFlags([snap({ health: 'warn', delta: 12 })], flagDefs, cfg()), []);
  assert.deepEqual(deriveFlags([snap({ health: 'warn', delta: 0 })], flagDefs, cfg()), []);
  assert.deepEqual(deriveFlags([snap({ health: 'warn', delta: null })], flagDefs, cfg()), []);
  // ... but crit is flagged whichever way it is moving
  assert.equal(deriveFlags([snap({ health: 'crit', delta: 30 })], flagDefs, cfg()).length, 1);
  // ... and good / untracked are never flagged for being off target
  assert.deepEqual(deriveFlags([snap({ health: 'good', delta: -40 })], flagDefs, cfg()), []);
  assert.deepEqual(deriveFlags([snap({ health: 'untracked', delta: -40 })], flagDefs, cfg()), []);
});

test('missing_data names the source label and the exact error', () => {
  const rows = {
    sourceRef: 'gtm', columns: [], rows: [], fetchedAt: NOW,
    status: 'error', error: 'HTTP 403: sheet is not shared with pulse@shopos.iam.gserviceaccount.com'
  };
  const flags = deriveFlags(
    [snap({ health: 'missing', raw: null, normalized: null })],
    flagDefs,
    cfg({ rowsByMetric: { qualified_leads: rows } })
  );
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'missing_data:qualified_leads');
  assert.equal(flags[0].kind, 'missing_data');
  assert.equal(flags[0].owner, 'Sai');
  assert.equal(flags[0].dept, 'marketing');
  assert.equal(flags[0].raisedBy, 'engine');
  assert.equal(flags[0].raisedAt, NOW);
  assert.equal(flags[0].resolvedAt, null);
  assert.deepEqual(flags[0].metricIds, ['qualified_leads']);
  assert.match(flags[0].body, /US lead gen tracker/, 'names the source as a human knows it');
  assert.match(flags[0].body, /HTTP 403: sheet is not shared with pulse@shopos\.iam\.gserviceaccount\.com/);
});

test('stale_source says how many days old the number is', () => {
  const rows = {
    sourceRef: 'gtm', columns: [], rows: [{}], status: 'ok',
    fetchedAt: NOW, asOf: '2026-10-11T04:30:00.000Z'  // 14 days before NOW
  };
  const flags = deriveFlags([snap({ health: 'stale' })], flagDefs, cfg({ rowsByMetric: { qualified_leads: rows } }));
  assert.equal(flags[0].id, 'stale_source:qualified_leads');
  assert.match(flags[0].body, /14 days old/);
  assert.match(flags[0].body, /US lead gen tracker/);
});

test('flag ids are stable across runs, so a two-week-old flag is recognisably the same flag', () => {
  const a = deriveFlags([snap({ health: 'crit' })], flagDefs, cfg({ now: '2026-10-11T00:00:00Z' }));
  const b = deriveFlags([snap({ health: 'crit' })], flagDefs, cfg({ now: '2026-10-25T00:00:00Z' }));
  assert.equal(a[0].id, b[0].id);
  assert.equal(a[0].id, 'off_target:qualified_leads');
  assert.notEqual(a[0].raisedAt, b[0].raisedAt);
});

test('an unmapped department falls back to the department label, never to nobody', () => {
  const flags = deriveFlags([snap({ metricId: 'orphan_metric', health: 'crit' })], flagDefs, cfg());
  assert.equal(flags[0].owner, 'Legal', 'no owner mapped for legal, so the department carries it');
});

test('no_target flags a metric nobody has committed to - but only when require_targets is on', () => {
  const untargeted = snap({ metricId: 'untargeted', health: 'untracked', unit: 'currency_inr' });

  // off by default, and off when the catalogue explicitly says so
  assert.deepEqual(deriveFlags([untargeted], flagDefs, cfg()), []);
  assert.deepEqual(deriveFlags([untargeted], flagDefs, cfg({ catalog: { _targets: { require_targets: false } } })), []);

  const flags = deriveFlags([untargeted], flagDefs, cfg({ catalog: { _targets: { require_targets: true } } }));
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'no_target:untargeted');
  assert.equal(flags[0].kind, 'no_target');
  assert.equal(flags[0].owner, 'Sai');
  assert.match(flags[0].body, /no target/);
  assert.match(flags[0].body, /rupees/, 'asks for the target in the unit the metric is measured in');

  // a metric that HAS a target never raises it
  assert.equal(
    deriveFlags([snap({ health: 'good' })], flagDefs, cfg({ catalog: { _targets: { require_targets: true } } })).length,
    0
  );
});

test('no_target is orthogonal to health - a missing number with no target raises both', () => {
  const flags = deriveFlags(
    [snap({ metricId: 'untargeted', health: 'missing', raw: null })],
    flagDefs,
    cfg({ catalog: { _targets: { require_targets: true } } })
  );
  assert.deepEqual(flags.map((f) => f.kind), ['missing_data', 'no_target']);
});

test('last_minute flags an assembled source, and says so without moralising', () => {
  const rows = stamped([1, 2, 3, 4, 5, 6, 7, 8, 9, 200]);
  const flags = deriveFlags(
    [snap({ freshness: 'last_minute', health: 'good' })],
    flagDefs,
    cfg({ meetingAt: MEETING, rowsByMetric: { qualified_leads: rows } })
  );
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 'last_minute:qualified_leads');
  assert.equal(flags[0].kind, 'last_minute');
  assert.match(flags[0].body, /90% of its rows/);
  assert.match(flags[0].body, /24 hours before this review/);
  assert.match(flags[0].body, /may be perfectly accurate/, 'the wording has to survive being read out loud');

  // every other freshness level stays silent
  for (const level of ['daily', 'weekly', 'stale', 'unknown']) {
    assert.deepEqual(
      deriveFlags([snap({ freshness: level, health: 'good' })], flagDefs, cfg()).filter((f) => f.kind === 'last_minute'),
      []
    );
  }
});

test('flags come back in a deterministic order', () => {
  const flags = deriveFlags(
    [
      snap({ metricId: 'untargeted', health: 'untracked', freshness: 'last_minute' }),
      snap({ metricId: 'qualified_leads', health: 'crit' })
    ],
    flagDefs,
    cfg({ catalog: { _targets: { require_targets: true } }, meetingAt: MEETING })
  );
  assert.deepEqual(flags.map((f) => f.id), [
    'off_target:qualified_leads',
    'last_minute:untargeted',
    'no_target:untargeted'
  ]);
});

/* ------------------------------------------------------------------------ *
 * rollupFamily
 * ------------------------------------------------------------------------ */

const pmDefs = [
  { id: 'pm_india_spend', label: 'Spend', dept: 'perf_marketing', segment: 'india', family: 'pm_spend', unit: 'currency_inr' },
  { id: 'pm_us_spend', label: 'Spend', dept: 'perf_marketing', segment: 'us', family: 'pm_spend', unit: 'currency_usd' },
  { id: 'pm_india_leads', label: 'Leads', dept: 'perf_marketing', segment: 'india', family: 'pm_leads', unit: 'count' },
  { id: 'pm_us_leads', label: 'Leads', dept: 'perf_marketing', segment: 'us', family: 'pm_leads', unit: 'count' }
];
const pmSnap = (id, raw, unit, segment, family) => snap({ metricId: id, raw, unit, segment, family, health: 'untracked' });

test('rollupFamily sums the segments of one family', () => {
  const snapshots = [
    pmSnap('pm_india_leads', 120, 'count', 'india', 'pm_leads'),
    pmSnap('pm_us_leads', 80, 'count', 'us', 'pm_leads')
  ];
  const roll = rollupFamily(snapshots, 'pm_leads');
  assert.equal(roll.total, 200);
  assert.equal(roll.unit, 'count');
  assert.deepEqual(roll.segments, ['india', 'us']);
  assert.equal(roll.complete, true);
  assert.equal(roll.missing, 0);
  assert.deepEqual(roll.warnings, []);
});

test('rollupFamily refuses to add rupees to dollars', () => {
  const snapshots = [
    pmSnap('pm_india_spend', 400000, 'currency_inr', 'india', 'pm_spend'),
    pmSnap('pm_us_spend', 12400, 'currency_usd', 'us', 'pm_spend')
  ];
  const roll = rollupFamily(snapshots, 'pm_spend');
  assert.equal(roll.total, null, '412400 of nothing is not a number anybody can act on');
  assert.equal(roll.unit, null);
  assert.match(roll.warnings[0], /mixes units/);
  assert.match(roll.warnings[0], /currency_inr, currency_usd/);
});

test('a partial rollup says it is a floor, not a total', () => {
  const snapshots = [
    pmSnap('pm_india_leads', 120, 'count', 'india', 'pm_leads'),
    pmSnap('pm_us_leads', null, 'count', 'us', 'pm_leads')
  ];
  const roll = rollupFamily(snapshots, 'pm_leads');
  assert.equal(roll.total, 120);
  assert.equal(roll.missing, 1);
  assert.equal(roll.complete, false);
  assert.match(roll.warnings[0], /incomplete/);
  assert.match(roll.warnings[0], /floor/);
});

test('rollupFamily reads family and unit off the defs when snapshots predate them', () => {
  const bare = [
    { metricId: 'pm_india_leads', raw: 120 },
    { metricId: 'pm_us_leads', raw: 80 }
  ];
  assert.equal(rollupFamily(bare, 'pm_leads', pmDefs).total, 200);
  assert.equal(rollupFamily(bare, 'pm_leads', pmDefs).unit, 'count');
});

test('rollupFamily on an unknown family says so rather than returning 0', () => {
  const roll = rollupFamily([], 'nothing_here');
  assert.equal(roll.total, null);
  assert.match(roll.warnings[0], /no metrics belong to family/);
});

test('rollupAllFamilies covers every family present', () => {
  const snapshots = [
    pmSnap('pm_india_leads', 120, 'count', 'india', 'pm_leads'),
    pmSnap('pm_us_leads', 80, 'count', 'us', 'pm_leads'),
    pmSnap('pm_india_spend', 400000, 'currency_inr', 'india', 'pm_spend')
  ];
  const all = rollupAllFamilies(snapshots);
  assert.deepEqual(Object.keys(all), ['pm_leads', 'pm_spend']);
  assert.equal(all.pm_leads.total, 200);
  assert.equal(all.pm_spend.total, 400000);
});

/* ------------------------------------------------------------------------ *
 * deptScoreboard
 * ------------------------------------------------------------------------ */

const sbOrg = {
  departments: [
    { id: 'india_sales', label: 'India Sales' },
    { id: 'us_sales', label: 'US Sales' },
    { id: 'hiring', label: 'Hiring' }
  ],
  owners: { india_sales: { name: 'Subham' }, us_sales: { name: '[OWNER NEEDED]' } }
};
const sbDefs = [
  { id: 'a', label: 'Closed won', dept: 'india_sales', unit: 'currency_inr' },
  { id: 'b', label: 'Meetings held', dept: 'india_sales', unit: 'count' },
  { id: 'c', label: 'Accounts worked', dept: 'india_sales', unit: 'count' },
  { id: 'd', label: 'Pipeline open', dept: 'us_sales', unit: 'currency_usd' },
  { id: 'e', label: 'Offers out', dept: 'hiring', unit: 'count' }
];

test('deptScoreboard reports one row per department, in org order', () => {
  const snapshots = [
    snap({ metricId: 'a', health: 'good', delta: 5, freshness: 'daily' }),
    snap({ metricId: 'b', health: 'warn', delta: -3, freshness: 'daily' }),
    snap({ metricId: 'c', health: 'untracked', delta: null, freshness: 'weekly' }),
    snap({ metricId: 'd', health: 'missing', delta: null, freshness: 'unknown' }),
    snap({ metricId: 'e', health: 'good', delta: 2, freshness: 'last_minute' })
  ];
  const board = deptScoreboard(snapshots, sbDefs, sbOrg);

  assert.deepEqual(board.map((r) => r.deptId), ['india_sales', 'us_sales', 'hiring']);
  assert.deepEqual(Object.keys(board[0]).sort(), [
    'byHealth', 'deptId', 'deptLabel', 'freshness', 'freshnessCounts',
    'netDelta', 'onTarget', 'owner', 'team', 'totalJudged', 'worstMetric'
  ].sort());

  const india = board[0];
  assert.equal(india.deptLabel, 'India Sales');
  // The scoreboard is about the line of business, so it carries everyone who
  // owns it. The legacy single-name shape reads as a team of one.
  assert.equal(india.owner, 'Subham');
  assert.deepEqual(india.team, ['Subham']);
  assert.equal(india.onTarget, 1);
  assert.equal(india.totalJudged, 2, 'the untracked metric is not counted as judged');
  assert.deepEqual(india.byHealth, { good: 1, warn: 1, crit: 0, stale: 0, missing: 0, untracked: 1 });
  assert.deepEqual(india.worstMetric, { id: 'b', label: 'Meetings held', health: 'warn' });
  assert.equal(india.netDelta, 2);
  assert.equal(india.freshness, 'daily');
});

test('deptScoreboard does not let an untracked metric flatter a department', () => {
  const board = deptScoreboard(
    [snap({ metricId: 'd', health: 'untracked', delta: null })],
    sbDefs, sbOrg
  );
  const us = board.find((r) => r.deptId === 'us_sales');
  assert.equal(us.totalJudged, 0, 'nothing has a target, so nothing can be "on target"');
  assert.equal(us.onTarget, 0);
  assert.equal(us.byHealth.untracked, 1);
  assert.equal(us.worstMetric, null);
});

test('deptScoreboard ranks missing data above a bad number as the worst metric', () => {
  const board = deptScoreboard(
    [
      snap({ metricId: 'a', health: 'crit', delta: -2 }),
      snap({ metricId: 'b', health: 'missing', delta: null })
    ],
    sbDefs, sbOrg
  );
  assert.equal(board[0].worstMetric.id, 'b', 'you cannot fix what you cannot see');
  assert.equal(board[0].worstMetric.health, 'missing');
});

test('deptScoreboard surfaces an unmapped owner and an empty department', () => {
  const board = deptScoreboard([], sbDefs, sbOrg);
  assert.equal(board.length, 3, 'a department with no metrics still appears - as a visible blank');
  assert.equal(board[1].owner, '[OWNER NEEDED]');
  assert.equal(board[2].owner, 'Hiring', 'no owner entry at all falls back to the department label');
  assert.equal(board[0].netDelta, null);
  assert.equal(board[0].freshness, 'unknown');
});

test('deptScoreboard picks the department freshness that describes most of its sources', () => {
  const board = deptScoreboard(
    [
      snap({ metricId: 'a', health: 'good', freshness: 'last_minute' }),
      snap({ metricId: 'b', health: 'good', freshness: 'last_minute' }),
      snap({ metricId: 'c', health: 'good', freshness: 'daily' })
    ],
    sbDefs, sbOrg
  );
  assert.equal(board[0].freshness, 'last_minute');
  assert.deepEqual(board[0].freshnessCounts, { daily: 1, weekly: 0, last_minute: 2, stale: 0, unknown: 0 });
});
