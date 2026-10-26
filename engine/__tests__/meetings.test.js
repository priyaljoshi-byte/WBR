/**
 * meetings.test.js - which numbers belong in which room, and which blockers
 * belong in two.
 *
 * Read against the REAL config/meetings.json, config/catalog.json and
 * config/org.json, because the two things under test are both properties of the
 * actual company and not of a fixture:
 *
 *   1. Performance Marketing has no meeting of its own. Perf India rides with
 *      Tuesday, Perf US with Wednesday. If a department-only filter ever creeps
 *      back in, both charters start reading half a number they cannot act on
 *      and these tests are what catches it.
 *
 *   2. There is no fifth leadership meeting, so some pairs of teams have NO
 *      room where both are present. Those blockers must appear in both rooms
 *      and escalate on sight.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  cardsForMeeting,
  crossMeetingConfig,
  isCrossMeeting,
  loadMeetings,
  meetingById,
  meetingsForMetric,
  metricsForMeeting,
  metricsWithNoMeeting,
  resolveCrossMeeting,
  routeBlockersToMeeting
} from '../meetings.js';
import { reconcileBlockers } from '../../transcript/blockers.js';
import { blockersForMeeting, dependencyMatrix } from '../../transcript/dependencies.js';
import { blockersSection } from '../../render/blockers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, '..', '..', 'config');
const readJson = async (name) => JSON.parse(await readFile(path.join(CONFIG, name), 'utf8'));

const meetingsConfig = await readJson('meetings.json');
const catalog = await readJson('catalog.json');
const org = await readJson('org.json');

const meetings = loadMeetings(meetingsConfig);
const ids = (defs) => defs.map((d) => d.id);

/* ------------------------------------------------------------------------ *
 * membership: a department AND a segment
 * ------------------------------------------------------------------------ */

test('the four weekly reviews load, with membership as {dept, segment}', () => {
  assert.deepEqual(meetings.map((m) => m.id),
    ['hiring', 'india_charter', 'us_charter', 'sloosh']);
  assert.deepEqual(meetings.map((m) => m.day),
    ['monday', 'tuesday', 'wednesday', 'thursday']);

  // The structural point, as data: Perf Marketing appears in two rooms, each
  // time pinned to one geography. It appears in no room of its own.
  const india = meetingById('india_charter', meetings);
  assert.deepEqual(india.members, [
    { dept: 'india_sales', segment: null },
    { dept: 'perf_marketing', segment: 'india' }
  ]);
  assert.equal(meetings.filter((m) =>
    m.members.length === 1 && m.members[0].dept === 'perf_marketing').length, 0,
  'Performance Marketing has no meeting of its own');
});

test('the Tuesday charter reads pm_india_* and NOT pm_us_*', () => {
  const tuesday = metricsForMeeting(meetingById('india_charter', meetings), catalog);
  const got = ids(tuesday);

  assert.ok(got.includes('pm_india_cpl'));
  assert.ok(got.includes('pm_india_spend'));
  assert.equal(got.filter((id) => id.startsWith('pm_india_')).length, 6);

  assert.equal(got.filter((id) => id.startsWith('pm_us_')).length, 0,
    'a department-only filter would put all of Perf Marketing in both rooms, and each '
    + 'room would be reading half a number it cannot act on');

  // The sales half of the room is whole: a department member with no segment
  // takes everything in its department.
  assert.equal(got.filter((id) => id.startsWith('india_') || id === 'in_pipeline_india').length, 9);
  assert.equal(got.filter((id) => id.startsWith('us_') || id === 'in_pipeline_us').length, 0);
});

test('the Wednesday charter is the same shape in dollars', () => {
  const got = ids(metricsForMeeting(meetingById('us_charter', meetings), catalog));
  assert.equal(got.filter((id) => id.startsWith('pm_us_')).length, 6);
  assert.equal(got.filter((id) => id.startsWith('pm_india_')).length, 0);
  assert.ok(got.includes('in_pipeline_us'));
  assert.ok(!got.includes('in_pipeline_india'));
});

test('a metric with no segment belongs to its department\'s meeting regardless', () => {
  // Every India Sales metric carries no segment at all, and every one of them
  // lands in the Tuesday room. The segment machinery is for the departments
  // that have segments; it must not become a hurdle for the ones that do not.
  const tuesday = metricsForMeeting(meetingById('india_charter', meetings), catalog);
  const indiaSales = catalog.metrics.filter((m) => m.dept === 'india_sales');

  assert.ok(indiaSales.length > 0);
  assert.ok(indiaSales.every((m) => !m.segment), 'India Sales metrics carry no segment');
  for (const m of indiaSales) {
    assert.ok(ids(tuesday).includes(m.id), `${m.id} must be read on Tuesday`);
  }

  // Same for Hiring and Sloosh, whose rooms name one department and no segment.
  const monday = metricsForMeeting(meetingById('hiring', meetings), catalog);
  assert.equal(monday.length, catalog.metrics.filter((m) => m.dept === 'hiring').length);
});

test('every metric in the catalogue is read in at least one room', () => {
  // The inverse of the rule above, and the one that would fail silently: a
  // metric whose department is covered only by segmented members, carrying no
  // segment of its own, would be computed and seen by nobody.
  assert.deepEqual(metricsWithNoMeeting(meetings, catalog), []);

  // And when such a metric exists, it is REPORTED rather than quietly dropped
  // into both rooms or neither.
  const withOrphan = {
    ...catalog,
    metrics: [...catalog.metrics,
      { id: 'pm_total_spend', label: 'Spend, both geographies', dept: 'perf_marketing' }]
  };
  assert.deepEqual(
    metricsWithNoMeeting(meetings, withOrphan).map((m) => m.id),
    ['pm_total_spend']
  );
});

test('cards carry the segment too, so each room sees the card it can act on', () => {
  const tuesday = cardsForMeeting(meetingById('india_charter', meetings), catalog).map((c) => c.id);
  const wednesday = cardsForMeeting(meetingById('us_charter', meetings), catalog).map((c) => c.id);

  assert.ok(tuesday.includes('perf-india'));
  assert.ok(!tuesday.includes('perf-us'));
  assert.ok(wednesday.includes('perf-us'));
  assert.ok(!wednesday.includes('perf-india'));
});

test('meetingsForMetric is the inverse, and is what routes a blocker', () => {
  assert.deepEqual(
    meetingsForMetric('pm_india_cpl', meetings, catalog).map((m) => m.id),
    ['india_charter']
  );
  assert.deepEqual(
    meetingsForMetric('pm_us_cpl', meetings, catalog).map((m) => m.id),
    ['us_charter']
  );
  assert.deepEqual(
    meetingsForMetric('sloosh_wau', meetings, catalog).map((m) => m.id),
    ['sloosh']
  );
  assert.deepEqual(meetingsForMetric('not_a_metric', meetings, catalog), []);
});

/* ------------------------------------------------------------------------ *
 * cross-meeting: the gap left by having no fifth meeting
 * ------------------------------------------------------------------------ */

const blocker = (over) => ({
  id: 'b-1', title: 'A thing is blocked', what: 'the ask', impact: 'the cost',
  metricIds: [], raisedAt: '2026-10-19', ageWeeks: 1, status: 'open',
  owner: null, dueDate: null, resolution: '', resolvedAt: null,
  firstSeenMeeting: 'm1', lastTouchedMeeting: 'm1', ...over
});

test('us_sales needing sloosh is cross-meeting: no room holds both', () => {
  const b = blocker({ raisedBy: 'us_sales', needsFrom: 'sloosh', metricIds: ['us_in_poc'] });
  assert.equal(isCrossMeeting(b, meetings, catalog), true);

  const r = resolveCrossMeeting(b, meetings, catalog);
  assert.deepEqual(r.raisedIn.map((m) => m.id), ['us_charter']);
  assert.deepEqual(r.needsIn.map((m) => m.id), ['sloosh']);
  assert.deepEqual(r.shared, [], 'Wednesday and Thursday never overlap');
});

test('india_sales needing perf_marketing[india] is NOT cross-meeting - same room', () => {
  // This pairing is precisely why the two were put in one room: spend and the
  // pipeline it feeds are one argument seen from two ends.
  const explicit = blocker({
    raisedBy: 'india_sales',
    needsFrom: { dept: 'perf_marketing', segment: 'india' }
  });
  assert.equal(isCrossMeeting(explicit, meetings, catalog), false);

  // Written as a bare department it is still not cross-meeting: india_sales and
  // perf_marketing do share Tuesday.
  const bare = blocker({ raisedBy: 'india_sales', needsFrom: 'perf_marketing' });
  assert.equal(isCrossMeeting(bare, meetings, catalog), false);

  // And the blocker's own metrics narrow a bare department to one geography.
  const narrowed = blocker({
    raisedBy: 'india_sales', needsFrom: 'perf_marketing', metricIds: ['pm_india_cpl']
  });
  assert.deepEqual(
    resolveCrossMeeting(narrowed, meetings, catalog).needsIn.map((m) => m.id),
    ['india_charter']
  );
});

test('hiring is cross-meeting with every charter that asks it for headcount', () => {
  for (const dept of ['india_sales', 'us_sales', 'sloosh']) {
    assert.equal(
      isCrossMeeting(blocker({ raisedBy: dept, needsFrom: 'hiring' }), meetings, catalog),
      true,
      `${dept} and hiring are never in a room together`
    );
  }
  // India and US never meet either.
  assert.equal(
    isCrossMeeting(blocker({ raisedBy: 'india_sales', needsFrom: 'us_sales' }), meetings, catalog),
    true
  );
});

test('a blocker with no resolvable other end is not called cross-meeting', () => {
  // A person's name, not a department. There is no second room to carry it to,
  // so there is nothing for cross-meeting routing to do - and claiming it is
  // cross-meeting would escalate it on a fact we do not have.
  assert.equal(
    isCrossMeeting(blocker({ raisedBy: 'us_sales', needsFrom: 'Raghav' }), meetings, catalog),
    false
  );
  assert.equal(
    isCrossMeeting(blocker({ raisedBy: 'us_sales', needsFrom: null }), meetings, catalog),
    false
  );
  // No meetings configured at all: the old single-room world, where every
  // blocker is by definition in the only room there is.
  assert.equal(isCrossMeeting(blocker({ raisedBy: 'us_sales', needsFrom: 'sloosh' }), [], catalog),
    false);
});

/* ------------------------------------------------------------------------ *
 * both rooms
 * ------------------------------------------------------------------------ */

const CROSS = blocker({
  id: 'b-sloosh-api',
  title: 'Sloosh API limits block the US rollout',
  raisedBy: 'us_sales', needsFrom: 'sloosh', metricIds: ['us_in_poc']
});
const LOCAL = blocker({
  id: 'b-perf-india',
  title: 'India creative refresh is late',
  raisedBy: 'india_sales', needsFrom: 'perf_marketing', metricIds: ['pm_india_cpl']
});

test('a cross-meeting blocker appears in BOTH rooms, foreign in the second', () => {
  const opts = { meetings: meetingsConfig, catalog, org };

  const wednesday = blockersForMeeting([CROSS, LOCAL], 'us_charter', opts);
  assert.deepEqual(wednesday.map((b) => b.id), ['b-sloosh-api']);
  assert.equal(wednesday[0].foreign, undefined, 'the raiser sees it as their own');
  assert.equal(wednesday[0].crossMeeting, true);

  const thursday = blockersForMeeting([CROSS, LOCAL], 'sloosh', opts);
  assert.deepEqual(thursday.map((b) => b.id), ['b-sloosh-api']);
  assert.equal(thursday[0].foreign, true, 'Sloosh sees it marked as raised elsewhere');
  assert.equal(thursday[0].fromMeetingId, 'us_charter');
  assert.equal(thursday[0].fromMeetingName, 'US & Perf US Charter');
  assert.equal(thursday[0].fromMeetingDay, 'wednesday');
  assert.equal(thursday[0].raisedByName, 'Anupreet', 'the person, not just the team');

  // The same-room blocker is in exactly one room and is never foreign anywhere.
  const tuesday = blockersForMeeting([CROSS, LOCAL], 'india_charter', opts);
  assert.deepEqual(tuesday.map((b) => b.id), ['b-perf-india']);
  assert.equal(tuesday[0].crossMeeting, false);
  assert.equal(tuesday[0].foreign, undefined);

  // Monday reads neither.
  assert.deepEqual(blockersForMeeting([CROSS, LOCAL], 'hiring', opts), []);
});

test('the same blocker is never both local and foreign in one room', () => {
  // A blocker a team raised against itself, or against somebody in the same
  // room, must render once. Showing it twice turns one conversation into two.
  const both = blockersForMeeting([LOCAL], 'india_charter', {
    meetings: meetingsConfig, catalog, org
  });
  assert.equal(both.length, 1);
});

test('with no meetings configured, one room still reads everything', () => {
  const all = blockersForMeeting([CROSS, LOCAL], 'anything', { meetings: null, catalog, org });
  assert.deepEqual(all.map((b) => b.id), ['b-sloosh-api', 'b-perf-india']);
  assert.ok(all.every((b) => !b.foreign));

  assert.deepEqual(
    routeBlockersToMeeting([CROSS], null, { meetings: meetingsConfig }).map((b) => b.id),
    ['b-sloosh-api']
  );
});

/* ------------------------------------------------------------------------ *
 * escalate immediately
 * ------------------------------------------------------------------------ */

test('cross_meeting.escalate_immediately is on, and age is the wrong test', () => {
  assert.equal(crossMeetingConfig(meetingsConfig).escalateImmediately, true);
  assert.equal(crossMeetingConfig(meetingsConfig).surfaceInBothRooms, true);
});

test('a cross-meeting blocker escalates in week 1, not after two weeks', () => {
  const extraction = {
    meetingId: 'us_charter-2026-10-19',
    meetingDate: '2026-10-19',
    blockers: [
      {
        title: 'Sloosh API limits block the US rollout',
        raisedBy: 'us_sales', needsFrom: 'sloosh',
        what: 'a rate-limit lift', impact: 'four POCs cannot start',
        metricIds: ['us_in_poc'], status: 'open'
      },
      {
        title: 'India creative refresh is late',
        raisedBy: 'india_sales', needsFrom: 'perf_marketing',
        what: 'new creative', impact: 'CPL stays high',
        metricIds: ['pm_india_cpl'], status: 'open'
      }
    ]
  };
  const meeting = { id: 'us_charter-2026-10-19', date: '2026-10-19' };
  const run = reconcileBlockers(extraction, [], meeting, {
    org, catalog, meetings: meetingsConfig
  });

  const cross = run.blockers.find((b) => b.raisedBy === 'us_sales');
  const same = run.blockers.find((b) => b.raisedBy === 'india_sales');

  assert.equal(cross.ageWeeks, 1, 'raised this week');
  assert.equal(cross.status, 'escalated',
    'escalated on first appearance - two weeks of raising it to people who are not '
    + 'in the room is two weeks of nothing happening and everybody feeling diligent');
  assert.equal(cross.crossMeeting, true);

  assert.equal(same.ageWeeks, 1);
  assert.equal(same.status, 'open',
    'a blocker whose two parties share Tuesday still gets the normal two weeks');

  const event = run.events.find((e) => e.blockerId === cross.id && e.toStatus === 'escalated');
  assert.equal(event.matchedBy, 'cross_meeting');
  assert.match(event.reason, /never\s+in a room together/);

  const flag = run.flags.find((f) => f.blockerId === cross.id && f.kind === 'overdue');
  assert.ok(flag, 'the escalation is also an ask with a name on it');
  assert.match(flag.title, /No shared room/);
  assert.equal(flag.owner, 'Bharat', 'one name on the Sloosh end, not the trio');
  assert.equal(
    run.flags.filter((f) => f.blockerId === same.id && f.kind === 'overdue').length, 0
  );
});

test('without a meetings config, nothing escalates early', () => {
  const extraction = {
    meetingId: 'wbr-2026-10-19',
    meetingDate: '2026-10-19',
    blockers: [{
      title: 'Sloosh API limits block the US rollout',
      raisedBy: 'us_sales', needsFrom: 'sloosh',
      what: 'a rate-limit lift', impact: 'four POCs cannot start',
      metricIds: [], status: 'open'
    }]
  };
  const run = reconcileBlockers(extraction, [], { id: 'wbr', date: '2026-10-19' }, { org, catalog });
  assert.equal(run.blockers[0].status, 'open', 'one room, so ageing is the only rule');
});

test('the dependency matrix marks the edges with no shared room', () => {
  const m = dependencyMatrix([CROSS, LOCAL], org, { meetings: meetingsConfig, catalog });
  assert.equal(m.totals.crossMeeting, 1);
  assert.equal(m.edges.find((e) => e.to === 'sloosh').crossMeeting, true);
  assert.equal(m.edges.find((e) => e.to === 'perf_marketing').crossMeeting, false);

  // No schedule supplied: we cannot tell, and say so by reporting zero rather
  // than guessing.
  assert.equal(dependencyMatrix([CROSS, LOCAL], org).totals.crossMeeting, 0);
});

/* ------------------------------------------------------------------------ *
 * and on the page
 * ------------------------------------------------------------------------ */

test('the second room renders it as foreign, naming the meeting and the person', () => {
  const opts = { meetings: meetingsConfig, catalog, org };
  const thursday = blockersSection(
    blockersForMeeting([CROSS, LOCAL], 'sloosh', opts), null, org, catalog
  );

  assert.match(thursday, /blocker-foreign/, 'visually distinct from a local blocker');
  assert.match(thursday, /Raised in US &amp; Perf US Charter \(Wednesday\)/,
    'names the meeting it came from');
  assert.match(thursday, /<b>Anupreet<\/b> raised this for US Sales/,
    'names the person who raised it');
  assert.match(thursday, /Raised in another review, waiting on this one/,
    'under its own heading, not mixed into this room&apos;s backlog'.replace(/&apos;/, "'"));
  assert.match(thursday, /yours to answer, not to chase/);

  const wednesday = blockersSection(
    blockersForMeeting([CROSS, LOCAL], 'us_charter', opts), null, org, catalog
  );
  assert.ok(!wednesday.includes('blocker-foreign'.concat('"')),
    'the room that raised it sees a normal card');
  assert.match(wednesday, /Escalated &middot; no room holds both teams/,
    'escalated on sight, and the reason says why');
  assert.ok(!/Raised in another review/.test(wednesday));
});

test('a foreign blocker does not reverse the arrow in "who is waiting on whom"', () => {
  // Sloosh is not waiting on anybody here - somebody is waiting on Sloosh. If
  // the carried-in blocker fed the summary, Thursday would report Sloosh as the
  // most blocked team in the company off a blocker it is the answer to.
  const thursday = blockersSection(
    blockersForMeeting([CROSS], 'sloosh', { meetings: meetingsConfig, catalog, org }),
    null, org, catalog
  );
  assert.ok(!thursday.includes('class="deplist"'),
    'nothing this room raised, so there is no waiting-on summary to draw');
});
