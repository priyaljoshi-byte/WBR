import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dependencyMatrix,
  mostBlocking,
  mostBlocked,
  dependencySummary,
  liveBlockers
} from '../dependencies.js';
import { reconcileBlockers } from '../blockers.js';
import { sampleExtraction, MEETING, MEETING_DATES, blocker } from './helpers.js';

function sampleBlockers() {
  return reconcileBlockers(sampleExtraction, [], MEETING, { meetingDates: MEETING_DATES }).blockers;
}

test('resolved blockers are not counted as dependencies', () => {
  const all = sampleBlockers();
  assert.equal(all.length, 4);
  assert.equal(liveBlockers(all).length, 3, 'the SDR offers were cleared in the room');
});

test('the matrix shows who is waiting on whom, with labels', () => {
  const m = dependencyMatrix(sampleBlockers());

  assert.deepEqual(
    m.departments.map((d) => d.id),
    ['india_sales', 'us_sales', 'perf_marketing', 'sloosh', 'hiring']
  );

  const usRow = m.rows.find((r) => r.dept === 'us_sales');
  assert.equal(usRow.label, 'US Sales');
  assert.equal(usRow.total, 2, 'US Sales is waiting on two teams');
  assert.deepEqual(usRow.waitingOn.map((w) => w.dept).sort(), ['perf_marketing', 'sloosh']);
  // Labels travel with ids so the renderer never joins back to org.json.
  assert.ok(usRow.waitingOn.every((w) => typeof w.label === 'string' && w.label.length > 0));

  const slooshRow = m.rows.find((r) => r.dept === 'sloosh');
  assert.equal(slooshRow.total, 0, 'Sloosh is waiting on nobody');
  assert.equal(slooshRow.blockingOthers, 2);

  // Dense grid for a literal table render.
  assert.equal(m.grid.us_sales.sloosh, 1);
  assert.equal(m.grid.perf_marketing.sloosh, 1);
  assert.equal(m.grid.india_sales.hiring, 0, 'resolved in the room, so no longer a dependency');

  assert.equal(m.totals.live, 3);
  assert.equal(m.totals.escalated, 1);
  assert.equal(m.totals.unassigned, 0);
});

test('an escalated edge is marked so the renderer can show it', () => {
  const m = dependencyMatrix(sampleBlockers());
  const edge = m.edges.find((e) => e.from === 'us_sales' && e.to === 'sloosh');
  assert.equal(edge.escalated, true);
  assert.equal(edge.oldestWeeks, 3);
  assert.equal(edge.fromLabel, 'US Sales');
  assert.equal(edge.toLabel, 'Sloosh Product & Marketing');
});

test('mostBlocking names the team everyone is waiting on', () => {
  const { top, ranked } = mostBlocking(sampleBlockers());
  assert.equal(top.dept, 'sloosh');
  assert.equal(top.count, 2);
  assert.deepEqual(top.waitingTeams.sort(), ['perf_marketing', 'us_sales']);
  assert.deepEqual(top.waitingTeamLabels.sort(), ['Performance Marketing', 'US Sales']);
  assert.ok(ranked.length >= 1);
});

test('mostBlocked names the team waiting on everyone', () => {
  const { top } = mostBlocked(sampleBlockers());
  assert.equal(top.dept, 'us_sales');
  assert.equal(top.label, 'US Sales');
  assert.equal(top.count, 2);
  assert.deepEqual(top.waitingOn.sort(), ['perf_marketing', 'sloosh']);
});

test('a team waiting on itself does not top the blocking list', () => {
  // Self-blocks are a planning problem, not a dependency. Counting them would let
  // a team lead this list without anyone ever having asked them for anything.
  const blockers = [
    blocker({ id: 'b-self', raisedBy: 'sloosh', needsFrom: 'sloosh' }),
    blocker({ id: 'b-self2', raisedBy: 'sloosh', needsFrom: 'sloosh' }),
    blocker({ id: 'b-real', raisedBy: 'us_sales', needsFrom: 'hiring' })
  ];
  const { top } = mostBlocking(blockers);
  assert.equal(top.dept, 'hiring');
});

test('a blocker with no other end lands in unassigned, not in the matrix', () => {
  const m = dependencyMatrix([
    blocker({ id: 'b-x', raisedBy: 'india_sales', needsFrom: null, title: 'Nobody owns legal review' })
  ]);
  assert.equal(m.totals.unassigned, 1);
  assert.equal(m.unassigned[0].label, 'India Sales');
  assert.equal(m.edges.length, 0);
});

test('a named person on the other end is recorded as external, not dropped', () => {
  const m = dependencyMatrix([
    blocker({ id: 'b-y', raisedBy: 'us_sales', needsFrom: 'Binny' })
  ]);
  assert.equal(m.external.length, 1);
  assert.equal(m.external[0].needsFrom, 'Binny');
  assert.equal(m.edges.length, 0);
  assert.equal(m.counts.blocked.us_sales, 1);
});

test('the summary sentence names both ends of the problem', () => {
  const s = dependencySummary(sampleBlockers());
  assert.match(s, /3 open blockers/);
  assert.match(s, /1 escalated/);
  assert.match(s, /Sloosh Product & Marketing is holding 2 of them across 2 teams/);
  assert.match(s, /US Sales is waiting on the most/);
});

test('an empty week says so', () => {
  assert.equal(dependencySummary([]), 'No open cross-team blockers.');
  assert.equal(dependencyMatrix([]).totals.live, 0);
  assert.equal(mostBlocking([]).top, null);
  assert.equal(mostBlocked([]).top, null);
});
