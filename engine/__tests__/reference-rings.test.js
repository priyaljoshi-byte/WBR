/**
 * reference-rings.test.js - THE PROOF THE DASHBOARD RESTS ON.
 *
 *   normalized = clamp(raw / denominator * 100, 0, 100), rounded to nearest int
 *
 * Nineteen raw/denominator pairs lifted off the reference dashboard cards, each
 * asserted against the number that reference ring actually shows.
 *
 * This file deliberately depends on NO config. Departments get reorganised and
 * catalogues get rewritten; the arithmetic underneath a ring does not. The
 * fixtures below are inline for exactly that reason - when config/catalog.json
 * is replaced wholesale, this test must still be the thing that fails loudly if
 * the normalization rule drifts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from '../normalize.js';
import { parseValue } from '../aggregate.js';
import { runPeriod } from '../run.js';

const PERIOD_START = '2026-10-19T00:00:00.000Z';
const PERIOD_END = '2026-10-26T00:00:00.000Z';
const NOW = '2026-10-25T04:30:00.000Z';

/** [raw, denominator, expected normalized, what it is on the reference card] */
const REFERENCE_RINGS = [
  [4, 5, 80, 'channels live'],
  [46, 200, 23, 'ICP accounts worked'],
  [0, 5, 0, 'a ring at zero'],
  [410, 932, 44, 'site users - direct'],
  [299, 932, 32, 'site users - organic search'],
  [135, 932, 14, 'site users - organic social'],
  [13200000, 44700000, 30, 'pipeline in POC'],
  [12600000, 44700000, 28, 'pipeline closed won'],
  [4400000, 44700000, 10, 'pipeline proposal'],
  [59, 77, 77, 'completed onboarding'],
  [49, 77, 64, 'ran an agent'],
  [17, 77, 22, 'reached pricing'],
  [17, 29, 59, 'accounts billing'],
  [168000, 670000, 25, 'Raghav pod collections'],
  [119428, 123990, 96, 'catalogue images'],
  [4000, 123990, 3, 'catalogue videos'],
  // 546/123990 = 0.4404% -> 0.
  //
  // The reference allowed 0 or 1 here. We round to the NEAREST integer with no
  // special case for "small but not zero", so it is 0. The alternative - floor
  // anything above zero up to 1 - means the engine reports half a percent of
  // progress that was not measured, and it would have to lie about 0.4 to do it.
  // A renderer that wants a visible hairline for non-zero-but-sub-1% has `raw`
  // on the snapshot and can draw it without the engine inventing a number.
  [546, 123990, 0, 'marketing and social'],
  [7, 19, 37, 'headcount yet to join'],
  [6, 19, 32, 'headcount joined full time']
];

test('every ring value on the reference dashboard reproduces exactly', () => {
  const misses = [];
  for (const [raw, denominator, expected, what] of REFERENCE_RINGS) {
    const { normalized, warnings } = normalize(raw, denominator);
    if (normalized !== expected) {
      misses.push(`${what}: ${raw} of ${denominator} -> expected ${expected}, got ${normalized}`);
    }
    assert.deepEqual(warnings, [], `${what} should produce no warnings`);
  }
  assert.deepEqual(misses, [], `rings that did not reproduce:\n${misses.join('\n')}`);
});

test('the currency rings reproduce from the raw spreadsheet strings too', () => {
  // The pipeline rings are the ones most likely to break silently, because the
  // numbers arrive as "₹1.32 Cr" rather than as numbers.
  assert.equal(parseValue('₹1.32 Cr'), 13200000);
  assert.equal(parseValue('₹4.47 Cr'), 44700000);
  assert.equal(normalize(parseValue('₹1.32 Cr'), parseValue('₹4.47 Cr')).normalized, 30);
  assert.equal(normalize(parseValue('1,26,00,000'), parseValue('4,47,00,000')).normalized, 28);
  assert.equal(normalize(parseValue('₹44L'), parseValue('₹4.47 Cr')).normalized, 10);
  assert.equal(normalize(parseValue('1,19,428'), parseValue('1,23,990')).normalized, 96);
});

test('normalization clamps, and never returns Infinity or NaN', () => {
  assert.equal(normalize(200, 100).normalized, 100);
  assert.equal(normalize(-5, 100).normalized, 0);
  assert.equal(normalize(0, 100).normalized, 0);
  assert.equal(normalize(10, 0).normalized, null);
  assert.equal(normalize(10, null).normalized, null);
  assert.equal(normalize(null, 100).normalized, null);
});

/* ------------------------------------------------------------------------ *
 * The same 19 values, end to end through the real engine, on a catalogue
 * that lives in this file and nowhere else.
 * ------------------------------------------------------------------------ */

const ref = (id, over) => ({
  id, label: id, dept: 'reference', unit: 'count',
  direction: 'up', target: null, warn_at: null, crit_at: null,
  caption: '{{raw}} of {{denominator}} {{denominator_label}}',
  denominator: { kind: 'self' },
  ...over
});

const ofMetric = (metric) => ({ kind: 'metric', metric });
const ofStatic = (value) => ({ kind: 'static', value });

const REFERENCE_CATALOG = {
  metrics: [
    ref('channels_live', {
      source: { ref: 'ref_channels', agg: 'count', where: { column: 'status', equals: 'live' } },
      denominator: ofStatic(5)
    }),
    ref('zero_ring', {
      source: { ref: 'ref_channels', agg: 'count', where: { column: 'status', equals: 'decommissioned' } },
      denominator: ofStatic(5)
    }),
    ref('icp_accounts_worked', {
      source: { ref: 'ref_channels', tab: 'Accounts', agg: 'count_distinct', column: 'account_id', where: { column: 'touched', equals: 'yes' } },
      denominator: ofStatic(200)
    }),

    ref('site_users_total', { source: { ref: 'ref_site', agg: 'sum', column: 'users' } }),
    ref('site_users_direct', {
      source: { ref: 'ref_site', agg: 'sum', column: 'users', where: { column: 'channel', equals: 'Direct' } },
      denominator: ofMetric('site_users_total')
    }),
    ref('site_users_organic_search', {
      source: { ref: 'ref_site', agg: 'sum', column: 'users', where: { column: 'channel', equals: 'Organic Search' } },
      denominator: ofMetric('site_users_total')
    }),
    ref('site_users_organic_social', {
      source: { ref: 'ref_site', agg: 'sum', column: 'users', where: { column: 'channel', equals: 'Organic Social' } },
      denominator: ofMetric('site_users_total')
    }),

    ref('pipeline_total', { unit: 'currency_inr', source: { ref: 'ref_pipeline', agg: 'sum', column: 'value_inr' } }),
    ref('pipeline_in_poc', {
      unit: 'currency_inr',
      source: { ref: 'ref_pipeline', agg: 'sum', column: 'value_inr', where: { column: 'stage', equals: 'POC' } },
      denominator: ofMetric('pipeline_total')
    }),
    ref('pipeline_closed_won', {
      unit: 'currency_inr',
      source: { ref: 'ref_pipeline', agg: 'sum', column: 'value_inr', where: { column: 'stage', equals: 'Closed Won' } },
      denominator: ofMetric('pipeline_total')
    }),
    ref('pipeline_proposal', {
      unit: 'currency_inr',
      source: { ref: 'ref_pipeline', agg: 'sum', column: 'value_inr', where: { column: 'stage', equals: 'Proposal' } },
      denominator: ofMetric('pipeline_total')
    }),

    ref('ss_signups', { source: { ref: 'ref_signups', agg: 'count' } }),
    ref('ss_completed_onboarding', {
      source: { ref: 'ref_signups', agg: 'count', where: { column: 'onboarding_complete', equals: true } },
      denominator: ofMetric('ss_signups')
    }),
    ref('ss_ran_an_agent', {
      source: { ref: 'ref_signups', agg: 'count', where: { column: 'ran_agent', equals: true } },
      denominator: ofMetric('ss_signups')
    }),
    ref('ss_reached_pricing', {
      source: { ref: 'ref_signups', agg: 'count', where: { column: 'reached_pricing', equals: true } },
      denominator: ofMetric('ss_signups')
    }),

    ref('accounts_billing', {
      source: { ref: 'ref_finance', agg: 'count_distinct', column: 'client', where: { column: 'collected_inr', gt: 0 } },
      denominator: ofStatic(29)
    }),
    ref('collected_raghav_pod', {
      unit: 'currency_inr',
      source: { ref: 'ref_finance', agg: 'sum', column: 'collected_inr', where: { column: 'pod', equals: 'Raghav' } },
      denominator: { kind: 'static', value: 670000, label: '' },
      caption: '{{raw}} of {{denominator}} {{denominator_label}}'
    }),

    ref('assets_total', { source: { ref: 'ref_assets', agg: 'sum', column: 'count' } }),
    ref('assets_catalogue_images', {
      source: { ref: 'ref_assets', agg: 'sum', column: 'count', where: { column: 'type', equals: 'catalogue_image' } },
      denominator: ofMetric('assets_total')
    }),
    ref('assets_catalogue_videos', {
      source: { ref: 'ref_assets', agg: 'sum', column: 'count', where: { column: 'type', equals: 'catalogue_video' } },
      denominator: ofMetric('assets_total')
    }),
    ref('assets_marketing_social', {
      source: { ref: 'ref_assets', agg: 'sum', column: 'count', where: { column: 'type', equals: 'marketing_social' } },
      denominator: ofMetric('assets_total')
    }),

    ref('hc_in_flight', { source: { ref: 'ref_hiring', agg: 'count' } }),
    ref('hc_yet_to_join', {
      source: { ref: 'ref_hiring', agg: 'count', where: { column: 'status', equals: 'yet_to_join' } },
      denominator: ofMetric('hc_in_flight')
    }),
    ref('hc_joined_full_time', {
      source: { ref: 'ref_hiring', agg: 'count', where: { column: 'status', equals: 'joined' } },
      denominator: ofMetric('hc_in_flight')
    })
  ]
};

const REFERENCE_ORG = {
  departments: [{ id: 'reference', label: 'Reference' }],
  owners: { reference: { name: 'Reference Owner' } }
};

const REFERENCE_SOURCES = {
  sources: [
    { id: 'ref_channels', label: 'Channel tracker' },
    { id: 'ref_site', label: 'Site analytics' },
    { id: 'ref_pipeline', label: 'Pipeline tracker' },
    { id: 'ref_signups', label: 'Signups' },
    { id: 'ref_finance', label: 'Collections' },
    { id: 'ref_assets', label: 'Asset delivery log' },
    { id: 'ref_hiring', label: 'Hiring pipeline' }
  ]
};

const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i));

/**
 * Values are written the way a spreadsheet actually holds them - Indian comma
 * grouping, "₹44L", "yes"/"TRUE" - so this proves the coercion path as well as
 * the arithmetic.
 */
const REFERENCE_ROWS = {
  'ref_channels::': [
    { channel: 'cold email', status: 'live' },
    { channel: 'linkedin', status: 'LIVE' },
    { channel: 'events', status: 'Live' },
    { channel: 'partners', status: 'live' },
    { channel: 'paid', status: 'paused' }
  ],
  // 46 distinct accounts touched: 47 rows, one a duplicate id
  'ref_channels::Accounts': [
    ...repeat(46, (i) => ({ account_id: `ACC-${i + 1}`, touched: 'yes' })),
    { account_id: 'ACC-1', touched: 'YES' },
    ...repeat(10, (i) => ({ account_id: `ACC-X${i}`, touched: 'no' }))
  ],
  'ref_site::': [
    { channel: 'Direct', users: 410 },
    { channel: 'Organic Search', users: '150' },
    { channel: 'Organic Search', users: '149' },
    { channel: 'Organic Social', users: 135 },
    { channel: 'Referral', users: 88 }
  ],
  'ref_pipeline::': [
    { deal: 'A', stage: 'POC', value_inr: '₹1.32 Cr' },
    { deal: 'B', stage: 'Closed Won', value_inr: '1,26,00,000' },
    { deal: 'C', stage: 'Proposal', value_inr: '₹44L' },
    { deal: 'D', stage: 'Discovery', value_inr: '₹1.45 Cr' }
  ],
  'ref_signups::': repeat(77, (i) => ({
    id: i + 1,
    onboarding_complete: i < 59 ? (i % 2 ? true : 'yes') : false,
    ran_agent: i < 49 ? (i % 3 ? true : 'TRUE') : 'no',
    reached_pricing: i < 17
  })),
  'ref_finance::': [
    { client: 'Zephyr', pod: 'Raghav', collected_inr: '₹50,000' },
    { client: 'Nimbus', pod: 'Raghav', collected_inr: '1,00,000' },
    { client: 'Orchid', pod: 'Raghav', collected_inr: '18000' },
    ...repeat(14, (i) => ({ client: `Client-${i}`, pod: 'Kabir', collected_inr: '25,000' })),
    ...repeat(12, (i) => ({ client: `Dormant-${i}`, pod: 'Kabir', collected_inr: '0' }))
  ],
  'ref_assets::': [
    { client: 'Zephyr', type: 'catalogue_image', count: '1,19,428' },
    { client: 'Nimbus', type: 'catalogue_video', count: '4,000' },
    { client: 'Orchid', type: 'marketing_social', count: 546 },
    { client: 'Orchid', type: 'packaging', count: 16 }
  ],
  'ref_hiring::': [
    ...repeat(7, (i) => ({ candidate: `Y${i}`, status: 'yet_to_join' })),
    ...repeat(6, (i) => ({ candidate: `J${i}`, status: 'joined' })),
    ...repeat(6, (i) => ({ candidate: `O${i}`, status: 'offer_accepted' }))
  ]
};

const referenceFetch = async (source, query) => {
  const rows = REFERENCE_ROWS[`${query.ref}::${query.tab || ''}`] || [];
  return {
    sourceRef: query.ref,
    columns: rows.length ? Object.keys(rows[0]) : [],
    rows,
    fetchedAt: NOW,
    status: rows.length ? 'ok' : 'empty'
  };
};

test('every reference ring reproduces end to end, from raw spreadsheet strings', async () => {
  const { run, snapshots } = await runPeriod({
    catalog: REFERENCE_CATALOG,
    sources: REFERENCE_SOURCES,
    org: REFERENCE_ORG,
    fetch: referenceFetch,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    now: NOW,
    prior: {},
    runId: 'run-reference'
  });

  const by = Object.fromEntries(snapshots.map((s) => [s.metricId, s]));

  /** metricId -> [raw, denominator, normalized] */
  const expected = {
    channels_live: [4, 5, 80],
    zero_ring: [0, 5, 0],
    icp_accounts_worked: [46, 200, 23],
    site_users_direct: [410, 932, 44],
    site_users_organic_search: [299, 932, 32],
    site_users_organic_social: [135, 932, 14],
    pipeline_in_poc: [13200000, 44700000, 30],
    pipeline_closed_won: [12600000, 44700000, 28],
    pipeline_proposal: [4400000, 44700000, 10],
    ss_completed_onboarding: [59, 77, 77],
    ss_ran_an_agent: [49, 77, 64],
    ss_reached_pricing: [17, 77, 22],
    accounts_billing: [17, 29, 59],
    collected_raghav_pod: [168000, 670000, 25],
    assets_catalogue_images: [119428, 123990, 96],
    assets_catalogue_videos: [4000, 123990, 3],
    assets_marketing_social: [546, 123990, 0],
    hc_yet_to_join: [7, 19, 37],
    hc_joined_full_time: [6, 19, 32]
  };

  const misses = [];
  for (const [id, [raw, denominator, normalized]] of Object.entries(expected)) {
    const s = by[id];
    assert.ok(s, `${id} should have a snapshot`);
    if (s.raw !== raw) misses.push(`${id} raw: expected ${raw}, got ${s.raw}`);
    if (s.denominator !== denominator) misses.push(`${id} denominator: expected ${denominator}, got ${s.denominator}`);
    if (s.normalized !== normalized) misses.push(`${id} normalized: expected ${normalized}, got ${s.normalized}`);
  }
  assert.deepEqual(misses, [], `rings that did not reproduce end to end:\n${misses.join('\n')}`);

  assert.equal(Object.keys(expected).length, 19, 'all 19 reference rings are covered');
  assert.equal(run.status, 'ok');
  assert.deepEqual(
    snapshots.flatMap((s) => s.warnings), [],
    'clean fixtures must raise no warnings'
  );
});

test('the reference captions render in Indian conventions', async () => {
  const { snapshots } = await runPeriod({
    catalog: REFERENCE_CATALOG, sources: REFERENCE_SOURCES, org: REFERENCE_ORG,
    fetch: referenceFetch, periodStart: PERIOD_START, periodEnd: PERIOD_END,
    now: NOW, prior: {}, runId: 'run-reference'
  });
  const by = Object.fromEntries(snapshots.map((s) => [s.metricId, s]));

  assert.equal(by.channels_live.caption, '4 of 5');
  assert.equal(by.pipeline_in_poc.caption, '₹1.32 Cr of ₹4.47 Cr');
  assert.equal(by.pipeline_proposal.caption, '₹44L of ₹4.47 Cr');
  assert.equal(by.assets_catalogue_images.caption, '1,19,428 of 1,23,990');
  assert.equal(
    by.collected_raghav_pod.caption, '₹1.68L of ₹6.7L',
    'an empty denominator_label must not leave a double space'
  );
});
