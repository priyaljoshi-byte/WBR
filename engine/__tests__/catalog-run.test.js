/**
 * catalog-run.test.js - a whole period against the REAL config on disk.
 *
 * Where engine.test.js proves each module and reference-rings.test.js proves the
 * arithmetic, this file proves the thing they cannot: that the actual
 * catalog.json, sources.json and org.json in this repo run end to end, fetch
 * each source once, and produce the flags the founder asked for.
 *
 * It deliberately reads config from disk. When a department head edits the
 * catalogue, this is the test that tells them whether they broke it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runPeriod } from '../run.js';
import { orderMetrics } from '../normalize.js';
import { rollupFamily } from '../rollup.js';
import { deptScoreboard } from '../scoreboard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, '..', '..', 'config');
const readJson = async (name) => JSON.parse(await readFile(path.join(CONFIG, name), 'utf8'));

const catalog = await readJson('catalog.json');
const sources = await readJson('sources.json');
const org = await readJson('org.json');

const PERIOD_START = '2026-10-19T00:00:00.000Z';
const PERIOD_END = '2026-10-26T00:00:00.000Z';
const NOW = '2026-10-25T04:30:00.000Z';
const MEETING = '2026-10-26T04:30:00.000Z';
const HOUR = 3600 * 1000;
const hoursBeforeMeeting = (h) => new Date(Date.parse(MEETING) - h * HOUR).toISOString();

const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i));

/**
 * Keyed `ref::tab`. Values are written as a sheet or a CRM export really holds
 * them - "₹1.32 Cr", "$120,000", "100" - so the coercion path is exercised too.
 *
 * Note on `won_flag`: the engine's `percent` unit means the percent number
 * itself (23 renders "23%"), so a win-rate flag column has to be stored 0/100,
 * not 0/1. A 0/1 column averaged would render "0%" for a 40% win rate.
 */
function buildFixtures() {
  return {
    'india_crm::Deals': [
      { deal: 'A', stage: 'POC', value: '₹1.32 Cr', won_flag: '0', source: 'paid', created_week: '2026-10-19' },
      { deal: 'B', stage: 'Proposal', value: '₹44L', won_flag: '0', source: 'outbound', created_week: '2026-10-19' },
      { deal: 'C', stage: 'Negotiation', value: '₹20L', won_flag: '0', source: 'outbound', created_week: '2026-10-12' },
      { deal: 'D', stage: 'Closed Won', value: '1,26,00,000', won_flag: '100', source: 'paid', created_week: '2026-10-12' },
      { deal: 'E', stage: 'Opportunity', value: '₹10L', won_flag: '0', source: 'outbound', created_week: '2026-10-19' }
    ],
    'india_crm::Activity': [
      ...repeat(12, (i) => ({ type: 'meeting_held', account_id: `IN-${i % 9}` })),
      ...repeat(4, (i) => ({ type: 'call', account_id: `IN-${i}` }))
    ],
    'us_crm::Deals': [
      { deal: 'U1', stage: 'POC', value: '$120,000', won_flag: '0', source: 'paid', created_week: '2026-10-19' },
      { deal: 'U2', stage: 'Proposal', value: '$60,000', won_flag: '0', source: 'outbound', created_week: '2026-10-19' },
      { deal: 'U3', stage: 'Closed Won', value: '$90,000', won_flag: '100', source: 'paid', created_week: '2026-10-12' }
    ],
    'us_crm::Activity': [
      ...repeat(7, (i) => ({ type: 'meeting_held', account_id: `US-${i % 5}` })),
      ...repeat(3, (i) => ({ type: 'email', account_id: `US-${i}` }))
    ],
    // The same sheet and tab as *_crm, read through a source whose date_column
    // is created_on - so the connector's period filter already means "created
    // this week". These rows are the subset the filter would have returned.
    'india_crm_created::Deals': [
      { deal: 'A', stage: 'POC', value: '₹1.32 Cr', won_flag: '0', source: 'paid' },
      { deal: 'B', stage: 'Proposal', value: '₹44L', won_flag: '0', source: 'outbound' },
      { deal: 'E', stage: 'Opportunity', value: '₹10L', won_flag: '0', source: 'outbound' }
    ],
    'us_crm_created::Deals': [
      { deal: 'U1', stage: 'POC', value: '$120,000', won_flag: '0', source: 'paid' },
      { deal: 'U2', stage: 'Proposal', value: '$60,000', won_flag: '0', source: 'outbound' }
    ],
    'ads_india::': [
      { campaign: 'search', spend: '₹40,000', leads: '20', qualified: '8', customers: '2' },
      { campaign: 'social', spend: '₹60,000', leads: '30', qualified: '12', customers: '3' }
    ],
    'ads_us::': [
      { campaign: 'search', spend: '$8,000', leads: '10', qualified: '4', customers: '1' },
      { campaign: 'social', spend: '$4,400', leads: '15', qualified: '6', customers: '1' }
    ],
    'sloosh_db::signups': repeat(40, (i) => ({
      id: i + 1,
      activated: i < 24 ? (i % 2 ? true : 'yes') : false,
      returned_7d: i < 12,
      paid: i < 5
    })),
    'sloosh_db::active': repeat(22, (i) => ({ user_id: `U-${i % 18}` })),
    'sloosh_db::revenue': [
      { client: 'Zephyr', amount: '₹2,50,000' },
      { client: 'Nimbus', amount: '₹1,50,000' },
      { client: 'Orchid', amount: '50,000' }
    ],
    // One row per day. The three columns chain into a funnel, so the fixture
    // keeps them in a realistic shape: a lot land, a few sign up, fewer pay.
    'sloosh_web::': [
      { date: '2026-10-19', landed: '7,200', signups: '560', paid: '54' },
      { date: '2026-10-22', landed: '5,200', signups: '420', paid: '42' }
    ],
    // One row per platform per week - see the sloosh_social notes in
    // sources.json. Two rows for one platform would double-count the total
    // every ring on that card is a share of.
    'sloosh_social::': [
      { date: '2026-10-19', platform: 'instagram', followers: '18,400' },
      { date: '2026-10-19', platform: 'linkedin', followers: '6,200' },
      { date: '2026-10-19', platform: 'x', followers: '3,100' },
      { date: '2026-10-19', platform: 'youtube', followers: '2,300' }
    ],
    'sloosh_board::': [
      { ticket: 'S1', status: 'Done', type: 'release', cycle_days: 2 },
      { ticket: 'S2', status: 'Done', type: 'feature', cycle_days: 3 },
      { ticket: 'S3', status: 'Done', type: 'feature', cycle_days: 4 },
      { ticket: 'S4', status: 'In Progress', type: 'feature', cycle_days: 5 },
      { ticket: 'S5', status: 'In Progress', type: 'release', cycle_days: 90 }
    ],
    'hiring_tracker::Roles': [
      ...repeat(6, (i) => ({ role: `R${i}`, status: 'open' })),
      ...repeat(2, (i) => ({ role: `C${i}`, status: 'closed' }))
    ],
    'hiring_tracker::Candidates': [
      { candidate: 'c1', status: 'screening', days_to_close: 10 },
      { candidate: 'c2', status: 'screening', days_to_close: 20 },
      { candidate: 'c3', status: 'interviewing', days_to_close: 30 },
      { candidate: 'c4', status: 'interviewing', days_to_close: 40 },
      { candidate: 'c5', status: 'offer_out', days_to_close: 50 },
      { candidate: 'c6', status: 'offer_out', days_to_close: 60 },
      { candidate: 'c7', status: 'accepted', days_to_close: 70 },
      { candidate: 'c8', status: 'accepted', days_to_close: 80 },
      { candidate: 'c9', status: 'joined', days_to_close: 90 }
    ]
  };
}

function makeFetch(fixtures, { fail = [], asOf = {}, stamp = {} } = {}) {
  const calls = [];
  const fetch = async (source, query) => {
    calls.push({ ref: query.ref, tab: query.tab });
    if (fail.includes(query.ref)) {
      throw new Error(`HTTP 403: ${source.label || query.ref} is not shared with the Pulse service account`);
    }
    const key = `${query.ref}::${query.tab || ''}`;
    let rows = fixtures[key] || [];
    // Stamp the column the SOURCE declares, not a fixed one. Notion exposes
    // _last_edited, a sheet exposes updated_on - and a fixture that always
    // wrote updated_at would pass while the real source read unknown.
    if (stamp[query.ref]) {
      const col = source?.row_timestamp_column || source?.timestamp_column || 'updated_at';
      rows = rows.map((r, i) => ({ ...r, [col]: stamp[query.ref](i) }));
    }
    return {
      sourceRef: query.ref,
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows,
      fetchedAt: NOW,
      status: rows.length ? 'ok' : 'empty',
      ...(asOf[query.ref] ? { asOf: asOf[query.ref] } : {})
    };
  };
  return { fetch, calls };
}

const runOpts = (fetch, over = {}) => ({
  catalog, sources, org, fetch,
  periodStart: PERIOD_START, periodEnd: PERIOD_END,
  now: NOW, meetingAt: MEETING, prior: {},
  runId: 'run-2026-10-19', triggeredBy: 'cron', ...over
});

const index = (snapshots) => Object.fromEntries(snapshots.map((s) => [s.metricId, s]));

/* ------------------------------------------------------------------------ */

test('the catalogue on disk is internally consistent and topologically sortable', () => {
  const ordered = orderMetrics(catalog.metrics);
  assert.equal(ordered.length, catalog.metrics.length);

  const seen = new Set();
  for (const def of ordered) {
    if (def.denominator && def.denominator.kind === 'metric') {
      assert.ok(seen.has(def.denominator.metric),
        `${def.id} divides by ${def.denominator.metric}, which must already be computed`);
    }
    seen.add(def.id);
  }

  // every metric belongs to a department org.json knows about
  const deptIds = new Set(org.departments.map((d) => d.id));
  for (const def of catalog.metrics) {
    assert.ok(deptIds.has(def.dept), `metric ${def.id} is owned by unknown department "${def.dept}"`);
  }
});

test('runPeriod fetches each distinct source-and-tab exactly once and reuses the rows', async () => {
  const { fetch, calls } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));

  assert.equal(snapshots.length, catalog.metrics.length);

  const keys = calls.map((c) => `${c.ref}::${c.tab || ''}`);
  assert.equal(keys.length, new Set(keys).size, 'no source-and-tab may be fetched twice');

  // Derived from the catalogue rather than hardcoded, so adding a metric that
  // reads an existing tab does not fail this test, while adding a NEW source
  // still has to be a deliberate act.
  const expected = [...new Set(
    catalog.metrics.map((m) => `${m.source.ref}::${m.source.tab || ''}`)
  )].sort();
  assert.deepEqual([...keys].sort(), expected);

  // six metrics read india_crm::Deals; it is opened once
  const dealsReaders = catalog.metrics.filter(
    (m) => m.source.ref === 'india_crm' && m.source.tab === 'Deals'
  );
  assert.ok(dealsReaders.length >= 6, 'sanity: several metrics share that tab');
  assert.equal(keys.filter((k) => k === 'india_crm::Deals').length, 1);
});

test('runPeriod computes every aggregation the catalogue uses', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));
  const by = index(snapshots);

  // sum, with a where..in
  assert.equal(by.in_pipeline_india.raw, 13200000 + 4400000 + 2000000);
  assert.equal(by.in_pipeline_india.caption, '₹1.96 Cr open');

  // metric denominators resolved in order
  assert.equal(by.india_in_poc.raw, 13200000);
  assert.equal(by.india_in_poc.denominator, 19600000);
  assert.equal(by.india_in_poc.normalized, 67);

  // count / count_distinct
  assert.equal(by.india_meetings_held.raw, 12);
  assert.equal(by.india_accounts_worked.raw, 9, 'distinct accounts, not activity rows');

  // avg, in the percent unit
  assert.equal(by.india_win_rate.raw, 20);
  assert.equal(by.india_win_rate.caption, '20%');

  // ratio: CPL = ₹1,00,000 / 50 leads
  assert.equal(by.pm_india_cpl.raw, 2000);
  assert.equal(by.pm_india_cpl.caption, '₹2,000');
  // ratio: CAC = ₹1,00,000 / 5 customers
  assert.equal(by.pm_india_cac.raw, 20000);

  // median, with an outlier that a mean would have ruined
  assert.equal(by.sloosh_cycle_time.raw, 4);
  assert.equal(by.sloosh_cycle_time.caption, '4d');
  assert.equal(by.hiring_time_to_close.raw, 50);
  assert.equal(by.hiring_time_to_close.caption, '50d');

  // boolean-ish filters
  assert.equal(by.sloosh_signups.raw, 40);
  assert.equal(by.sloosh_activated.raw, 24);
  assert.equal(by.sloosh_activated.normalized, 60);
  assert.equal(by.sloosh_wau.raw, 18);
});

test('US metrics render in dollars and India metrics in rupees', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));
  const by = index(snapshots);

  assert.equal(by.in_pipeline_us.raw, 180000);
  assert.equal(by.in_pipeline_us.caption, '$180K open');
  assert.equal(by.pm_us_spend.raw, 12400);
  assert.match(by.pm_us_spend.caption, /\$12\.4K/);
  assert.equal(by.pm_us_cpl.raw, 496);
  assert.equal(by.pm_us_cpl.caption, '$496');

  assert.match(by.pm_india_spend.caption, /₹1L/);
  assert.equal(by.sloosh_revenue.raw, 450000);
  assert.match(by.sloosh_revenue.caption, /₹4\.5L/);

  for (const s of snapshots) {
    if (s.unit === 'currency_usd') {
      assert.ok(!/Cr|L\b/.test(s.caption), `${s.metricId} rendered a dollar figure in Indian units: ${s.caption}`);
    }
  }
});

test('a static denominator with no value set warns instead of drawing a ring', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));
  const by = index(snapshots);

  // the starter catalogue ships every static denominator as null, on purpose
  assert.equal(by.india_closed_won.raw, 12600000, 'the number is still computed');
  assert.equal(by.india_closed_won.denominator, null);
  assert.equal(by.india_closed_won.normalized, null, 'but no arc is invented for it');
  assert.match(by.india_closed_won.warnings.join(' '), /no usable value/);
});

// This test used to assert that india_created_wk produced a warned-about zero,
// because its where clause filtered on "{{period.start}}" and nothing
// substitutes that. The fix was to point the metric at a source whose
// date_column is created_on, so the connector's period filter does the work.
//
// Inverted into a guard: no metric anywhere may carry an unresolved template.
// A templated filter matches nothing and reads 0, which looks exactly like a
// real zero on a ring - the most dangerous possible failure, because it is
// silent and plausible.
test('no metric in the catalogue carries an unresolved {{template}} in its query', () => {
  const offenders = catalog.metrics
    .filter((m) => /\{\{.*?\}\}/.test(JSON.stringify(m.source)))
    .map((m) => `${m.id} (${m.dept})`);

  assert.deepEqual(offenders, [],
    'these would silently read 0 - filter by the source period instead');
});

test('the created-this-week metrics read from their own period-filtered source', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));
  const by = index(snapshots);

  // A real number, not a zero standing in for "the filter matched nothing".
  assert.ok(by.india_created_wk.raw > 0, 'india pipeline created should be non-zero');
  assert.ok(by.us_created_wk.raw > 0, 'us pipeline created should be non-zero');
  assert.equal(by.india_created_wk.rowCount, 3);
  assert.equal(by.us_created_wk.rowCount, 2);
});

test('require_targets turns every uncommitted metric into a named ask', async () => {
  assert.equal(catalog._targets.require_targets, true, 'the catalogue on disk asks for this');

  const { fetch } = makeFetch(buildFixtures());
  const { flags } = await runPeriod(runOpts(fetch));

  const noTarget = flags.filter((f) => f.kind === 'no_target');
  const untargeted = catalog.metrics.filter((m) => m.target === null || m.target === undefined);
  assert.equal(noTarget.length, untargeted.length);
  assert.equal(noTarget.length, catalog.metrics.length, 'the starter catalogue has no targets at all yet');

  // ids are stable and deterministic
  assert.deepEqual(
    noTarget.map((f) => f.id).sort(),
    untargeted.map((m) => `no_target:${m.id}`).sort()
  );

  // every one of them carries a department and an owner slot
  for (const flag of noTarget) {
    assert.ok(flag.dept, `${flag.id} must name a department`);
    assert.ok(flag.owner, `${flag.id} must name an owner`);
  }

  // Each ask lands on ONE person - the metric's accountable owner, falling back
  // to the first of its department's trio. A flag addressed to three people is
  // addressed to nobody, which is what org.json _accountability is about.
  const indiaAsk = noTarget.find((f) => f.dept === 'india_sales');
  assert.equal(indiaAsk.owner, 'Subham', 'one name, not the trio');
  assert.deepEqual(indiaAsk.ownerTeam, ['Subham', 'Arfin', 'Raghav'],
    'the trio rides along for context, but is never the address');
  assert.equal(noTarget.find((f) => f.dept === 'sloosh').owner, 'Bharat');
  assert.equal(noTarget.find((f) => f.dept === 'hiring').owner, 'Satwik');

  // perf_marketing is the one department the founder named nobody for, because
  // it has no meeting of its own. That gap has to be visible, not papered over
  // with the department's label.
  // Every line of business is owned now, so every no_target ask reaches a
  // person. Asserting a specific name here would re-couple the suite to the
  // roster, which is what broke it last time.
  for (const f of noTarget) {
    assert.ok(f.owner && f.owner.trim(), `${f.dept} raised a flag addressed to nobody`);
  }
});

test('a healthy run with every source reporting is ok, and raises no off_target noise', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { run, flags, snapshots } = await runPeriod(runOpts(fetch));

  assert.equal(run.status, 'ok');
  assert.equal(run.id, 'run-2026-10-19');
  assert.equal(run.finishedAt, NOW);
  assert.equal(run.triggeredBy, 'cron');

  assert.equal(flags.filter((f) => f.kind === 'off_target').length, 0,
    'nothing has a target yet, so nothing can be off one');
  assert.equal(flags.filter((f) => f.kind === 'missing_data').length, 0);
  assert.ok(snapshots.every((s) => s.health === 'untracked'),
    'every metric is tracked but unjudged until a target is set');
});

test('a dead source degrades the run to partial and names the source', async () => {
  const { fetch } = makeFetch(buildFixtures(), { fail: ['ads_india'] });
  const { run, snapshots, flags } = await runPeriod(runOpts(fetch));

  assert.equal(run.status, 'partial');

  const adsMetrics = catalog.metrics.filter((m) => m.source.ref === 'ads_india');
  const by = index(snapshots);
  for (const def of adsMetrics) {
    assert.equal(by[def.id].health, 'missing', `${def.id} should be missing`);
    assert.equal(by[def.id].raw, null);
  }

  const missing = flags.filter((f) => f.kind === 'missing_data');
  assert.equal(missing.length, adsMetrics.length);
  assert.match(missing[0].body, /HTTP 403/);
  assert.equal(missing[0].dept, 'perf_marketing');

  // the rest of the business still computed
  assert.equal(by.in_pipeline_india.raw, 19600000);
  // and the US half of the spend family is unaffected
  assert.equal(by.pm_us_spend.raw, 12400);
});

test('a source older than the period goes stale, with the age in the flag', async () => {
  const { fetch } = makeFetch(buildFixtures(), { asOf: { hiring_tracker: '2026-10-11T04:30:00.000Z' } });
  const { run, snapshots, flags } = await runPeriod(runOpts(fetch));

  assert.equal(run.status, 'partial');
  const by = index(snapshots);
  assert.equal(by.hiring_open_roles.health, 'stale');
  assert.equal(by.hiring_open_roles.raw, 6, 'a stale number is still reported - it is just labelled old');

  const stale = flags.filter((f) => f.kind === 'stale_source');
  assert.equal(stale.length, catalog.metrics.filter((m) => m.source.ref === 'hiring_tracker').length);
  assert.match(stale[0].body, /14 days old/);
});

test('every source erroring is a failed run, not a dashboard of zeroes', async () => {
  const allRefs = [...new Set(catalog.metrics.map((m) => m.source.ref))];
  const { fetch } = makeFetch(buildFixtures(), { fail: allRefs });
  const { run, snapshots, flags } = await runPeriod(runOpts(fetch));

  assert.equal(run.status, 'failed');
  assert.ok(snapshots.every((s) => s.health === 'missing' && s.raw === null));
  assert.equal(flags.filter((f) => f.kind === 'missing_data').length, catalog.metrics.length);
});

test('a source assembled in the hours before the meeting is flagged, once per metric', async () => {
  // every board row edited in the 6 hours before the review
  const { fetch } = makeFetch(buildFixtures(), {
    stamp: { sloosh_board: (i) => hoursBeforeMeeting(1 + i) }
  });
  const { snapshots, flags } = await runPeriod(runOpts(fetch));
  const by = index(snapshots);

  assert.equal(by.sloosh_shipped.freshness, 'last_minute');
  assert.equal(by.sloosh_cycle_time.freshness, 'last_minute');

  const lastMinute = flags.filter((f) => f.kind === 'last_minute');
  assert.equal(lastMinute.length, catalog.metrics.filter((m) => m.source.ref === 'sloosh_board').length);
  assert.match(lastMinute[0].body, /100% of its rows/);
  assert.match(lastMinute[0].body, /may be perfectly accurate/);
  assert.equal(lastMinute[0].dept, 'sloosh');

  // sources without a row timestamp are not accused of anything
  assert.equal(by.in_pipeline_india.freshness, 'unknown');
  assert.equal(flags.filter((f) => f.kind === 'last_minute' && f.dept === 'india_sales').length, 0);
});

test('a source maintained across the week reads as daily, not last_minute', async () => {
  const { fetch } = makeFetch(buildFixtures(), {
    stamp: { sloosh_db: (i) => hoursBeforeMeeting(i === 0 ? 4 : 30 + i * 20) }
  });
  const { snapshots, flags } = await runPeriod(runOpts(fetch));
  const by = index(snapshots);

  assert.equal(by.sloosh_signups.freshness, 'daily');
  assert.equal(flags.filter((f) => f.kind === 'last_minute').length, 0);
});

test('the Performance Marketing family rolls up across segments', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));

  const leads = rollupFamily(snapshots, 'pm_leads');
  assert.equal(leads.total, 75, '50 India + 25 US');
  assert.equal(leads.unit, 'count');
  assert.deepEqual(leads.segments.sort(), ['india', 'us']);
  assert.equal(leads.complete, true);

  const qualified = rollupFamily(snapshots, 'pm_qualified');
  assert.equal(qualified.total, 30);

  // spend is INR on one side and USD on the other, so it must refuse
  const spend = rollupFamily(snapshots, 'pm_spend');
  assert.equal(spend.total, null);
  assert.match(spend.warnings[0], /mixes units/);
});

test('the Sloosh marketing funnel chains each step off the one above it', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));
  const by = index(snapshots);

  assert.equal(by.sloosh_web_landed.raw, 12400);
  assert.equal(by.sloosh_web_signup.raw, 980);
  assert.equal(by.sloosh_web_paid.raw, 96);

  // The mouth of the funnel reads full, so the inner arcs are visibly a
  // fraction OF it rather than three unrelated rings sharing a card.
  assert.equal(by.sloosh_web_landed.denominator, 12400);
  assert.equal(by.sloosh_web_landed.normalized, 100);

  // Each step divides by the PREVIOUS step, which is the whole point: the gap
  // between two arcs is the drop-off between those two steps and nothing else.
  assert.equal(by.sloosh_web_signup.denominator, 12400, 'signups are a fraction of landed');
  assert.equal(by.sloosh_web_signup.normalized, 8);
  assert.equal(by.sloosh_web_paid.denominator, 980, 'paid is a fraction of SIGNUPS, not of landed');
  assert.equal(by.sloosh_web_paid.normalized, 10);

  // Against landed, paid would have read 1% and the signup-to-paid conversion
  // would have been invisible. That is the mistake this chaining prevents.
  assert.notEqual(by.sloosh_web_paid.denominator, by.sloosh_web_landed.raw);

  assert.equal(by.sloosh_web_signup.caption, '980 of 12,400 landed');
  assert.equal(by.sloosh_web_paid.caption, '96 of 980 signups');
});

test('social followers roll up to one audience total across all four platforms', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));
  const by = index(snapshots);

  const followers = rollupFamily(snapshots, 'sloosh_followers');
  assert.equal(followers.total, 30000, '18,400 + 6,200 + 3,100 + 2,300');
  assert.equal(followers.unit, 'count');
  assert.equal(followers.complete, true);
  assert.equal(followers.members.length, 4, 'all four platforms, YouTube included');

  // every ring on the card is that platform's share of the same total
  assert.equal(by.sloosh_followers_instagram.denominator, 30000);
  assert.equal(by.sloosh_followers_instagram.normalized, 61);
  assert.equal(by.sloosh_followers_linkedin.normalized, 21);
  assert.equal(by.sloosh_followers_x.normalized, 10);
  assert.equal(by.sloosh_followers_youtube.normalized, 8);

  // the shares are shares, so they account for the whole audience
  const shares = ['instagram', 'linkedin', 'x', 'youtube']
    .reduce((sum, p) => sum + by[`sloosh_followers_${p}`].raw, 0);
  assert.equal(shares, followers.total);
});

test('every new Sloosh metric is listed as outstanding until the founder sets a target', async () => {
  const added = [
    'sloosh_web_landed', 'sloosh_web_signup', 'sloosh_web_paid',
    'sloosh_followers_instagram', 'sloosh_followers_linkedin',
    'sloosh_followers_x', 'sloosh_followers_youtube'
  ];
  for (const id of added) {
    const def = catalog.metrics.find((m) => m.id === id);
    assert.ok(def, `${id} must exist in the catalogue`);
    assert.equal(def.target, null, `${id} must ship with no target`);
  }

  const { fetch } = makeFetch(buildFixtures());
  const { flags } = await runPeriod(runOpts(fetch));
  const ids = new Set(flags.filter((f) => f.kind === 'no_target').map((f) => f.id));
  for (const id of added) {
    assert.ok(ids.has(`no_target:${id}`), `${id} should raise a no_target flag`);
  }
});

test('the two new cards reference only metrics the catalogue defines', () => {
  const known = new Set(catalog.metrics.map((m) => m.id));
  for (const id of ['sloosh-funnel-web', 'sloosh-social']) {
    const card = catalog.cards.find((c) => c.id === id);
    assert.ok(card, `card ${id} must exist`);
    for (const ref of [...(card.rings || []), ...(card.tiles || []).map((t) => t.metric)]) {
      assert.ok(known.has(ref), `card ${id} points at unknown metric "${ref}"`);
    }
  }

  // card order is a reading order; two cards claiming the same slot is a bug
  const orders = catalog.cards.map((c) => `${c.section}:${c.order}`);
  assert.equal(orders.length, new Set(orders).size, 'no two cards may share a section slot');
});

test('a family rollup over a dead segment reports a floor, not a total', async () => {
  const { fetch } = makeFetch(buildFixtures(), { fail: ['ads_us'] });
  const { snapshots } = await runPeriod(runOpts(fetch));

  const leads = rollupFamily(snapshots, 'pm_leads');
  assert.equal(leads.total, 50, 'only India reported');
  assert.equal(leads.missing, 1);
  assert.equal(leads.complete, false);
  assert.match(leads.warnings[0], /floor rather than the actual figure/);
});

test('the scoreboard reports one row per line of business, in agenda order', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const { snapshots } = await runPeriod(runOpts(fetch));
  const board = deptScoreboard(snapshots, catalog.metrics, org);

  assert.deepEqual(board.map((r) => r.deptId), org.departments.map((d) => d.id));
  assert.deepEqual(board.map((r) => r.deptLabel), [
    'India Sales', 'US Sales', 'Performance Marketing', 'Sloosh Product & Marketing', 'Hiring'
  ]);

  // nothing has a target yet, so nothing can be reported as on target
  for (const row of board) {
    assert.equal(row.totalJudged, 0, `${row.deptId} has no judged metrics yet`);
    assert.equal(row.onTarget, 0);
    assert.equal(row.worstMetric, null, 'untracked is unjudged, not "worst"');
    assert.ok(row.byHealth.untracked > 0);
  }

  // The scoreboard is about the line of business, so it names everyone who owns
  // it. The single accountable name belongs on a flag, where there is a verb.
  const india = board.find((r) => r.deptId === 'india_sales');
  assert.deepEqual(india.team, ['Subham', 'Arfin', 'Raghav']);
  assert.equal(india.owner, 'Subham, Arfin and Raghav');

  // The rule, not the roster: every row names somebody, and the label is a
  // sentence built from the team rather than a lone name. Asserting a specific
  // trio here would break the day a real person joins or leaves, which is a
  // change the suite should welcome rather than resist.
  for (const row of board) {
    assert.ok(Array.isArray(row.team), `${row.deptId} has no team array`);
    assert.ok(row.owner && row.owner.trim(), `${row.deptId} has a blank owner label`);
    if (row.team.length) {
      assert.notEqual(row.owner, '[OWNER NEEDED]', `${row.deptId} has names but reads unowned`);
      assert.ok(row.owner.includes(row.team[0]), `${row.deptId} label omits its own first owner`);
    } else {
      assert.equal(row.owner, '[OWNER NEEDED]', 'a blank reads as fine; this is the opposite');
    }
  }

  const totalCounted = board.reduce((sum, r) => sum + r.byHealth.untracked, 0);
  assert.equal(totalCounted, catalog.metrics.length, 'every metric lands in exactly one department');
});

test('the scoreboard shows a department losing a source', async () => {
  const { fetch } = makeFetch(buildFixtures(), { fail: ['ads_india', 'ads_us'] });
  const { snapshots } = await runPeriod(runOpts(fetch));
  const board = deptScoreboard(snapshots, catalog.metrics, org);
  const perf = board.find((r) => r.deptId === 'perf_marketing');

  assert.ok(perf.byHealth.missing > 0);
  assert.equal(perf.worstMetric.health, 'missing');
  assert.equal(perf.freshness, 'unknown');

  // the other lines of business are untouched
  assert.equal(board.find((r) => r.deptId === 'india_sales').byHealth.missing, 0);
});

test('deltas carry from the prior period', async () => {
  const { fetch } = makeFetch(buildFixtures());
  const prior = {
    india_in_poc: { normalized: 50, raw: 10000000 },
    sloosh_activated: { normalized: 70, raw: 30 }
  };
  const { snapshots } = await runPeriod(runOpts(fetch, { prior }));
  const by = index(snapshots);

  assert.equal(by.india_in_poc.priorNormalized, 50);
  assert.equal(by.india_in_poc.priorRaw, 10000000);
  assert.equal(by.india_in_poc.delta, 17);
  assert.equal(by.sloosh_activated.delta, -10);
  assert.equal(by.sloosh_paid.delta, null, 'no prior means no delta, not a delta of zero');
});
