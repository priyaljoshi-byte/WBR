import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applySelections, normalizeSelections, describeSelections } from '../selections.js';

const catalog = () => ({
  metrics: [
    { id: 'a1', dept: 'india_sales', label: 'A1', target: null, direction: 'up' },
    { id: 'a2', dept: 'india_sales', label: 'A2', target: 5, direction: 'up' },
    { id: 'a3', dept: 'india_sales', label: 'A3', target: null, direction: 'up' },
    { id: 'b1', dept: 'us_sales', label: 'B1', target: null, direction: 'up' }
  ],
  cards: [
    { id: 'india-one', rings: ['a1', 'a2'], tiles: [{ metric: 'a3', label: 'T' }] },
    { id: 'india-two', rings: ['a3'], tiles: [] },
    { id: 'us-one', rings: ['b1'], tiles: [] }
  ]
});

/* ------------------------------ normalising ------------------------------ */

test('the nested file shape is read as-is', () => {
  const out = normalizeSelections({ india_sales: { a1: { enabled: true, target: 10 } } });
  assert.equal(out.india_sales.a1.enabled, true);
  assert.equal(out.india_sales.a1.target, 10);
});

test('the app export envelope is accepted without conversion', () => {
  const out = normalizeSelections({
    kind: 'shopos-pulse-export',
    tables: {
      pulse_selections: [
        { dept_id: 'india_sales', metric_id: 'a1', enabled: true, target: 7, owner: 'Subham', direction: 'down' }
      ]
    }
  });
  assert.equal(out.india_sales.a1.target, 7);
  assert.equal(out.india_sales.a1.owner, 'Subham');
  assert.equal(out.india_sales.a1.direction, 'down');
});

test('a missing enabled flag counts as enabled, an explicit false does not', () => {
  const out = normalizeSelections({ d: { m1: { target: 1 }, m2: { enabled: false } } });
  assert.equal(out.d.m1.enabled, true);
  assert.equal(out.d.m2.enabled, false);
});

test('an unparseable target becomes null rather than NaN', () => {
  const out = normalizeSelections({ d: { m: { target: 'not a number' } } });
  assert.equal(out.d.m.target, null);
});

test('a direction other than down normalises to up', () => {
  const out = normalizeSelections({ d: { m: { direction: 'sideways' } } });
  assert.equal(out.d.m.direction, 'up');
});

test('comment keys are skipped so the file can carry notes', () => {
  const out = normalizeSelections({ _about: 'notes', d: { _why: 'x', m: { enabled: true } } });
  assert.deepEqual(Object.keys(out), ['d']);
  assert.deepEqual(Object.keys(out.d), ['m']);
});

/* ------------------------------- applying -------------------------------- */

test('with no selections at all the catalogue is returned untouched', () => {
  const c = catalog();
  const { catalog: out, applied } = applySelections(c, {});
  assert.equal(applied, false);
  assert.equal(out, c, 'the very same object, not a copy');
});

test('THE RULE: a department that has not chosen keeps every metric', () => {
  // india_sales chooses; us_sales has never opened the screen.
  const { catalog: out } = applySelections(catalog(), {
    india_sales: { a1: { enabled: true }, a2: { enabled: false }, a3: { enabled: false } }
  });
  assert.deepEqual(out.metrics.map((m) => m.id).sort(), ['a1', 'b1']);
});

test('a disabled metric is dropped and an enabled one kept', () => {
  const { catalog: out, stats } = applySelections(catalog(), {
    india_sales: { a1: { enabled: true }, a2: { enabled: false }, a3: { enabled: true } }
  });
  assert.deepEqual(out.metrics.filter((m) => m.dept === 'india_sales').map((m) => m.id), ['a1', 'a3']);
  assert.equal(stats.dropped, 1);
});

test('a target set in the app overrides the catalogue', () => {
  const { catalog: out, stats } = applySelections(catalog(), {
    india_sales: { a1: { enabled: true, target: 42 } }
  });
  assert.equal(out.metrics.find((m) => m.id === 'a1').target, 42);
  assert.equal(stats.targetsOverridden, 1);
});

test('a null target leaves the catalogue target alone', () => {
  const { catalog: out } = applySelections(catalog(), {
    india_sales: { a2: { enabled: true, target: null } }
  });
  assert.equal(out.metrics.find((m) => m.id === 'a2').target, 5);
});

test('the named owner lands on the metric, which is what a flag reads', () => {
  const { catalog: out } = applySelections(catalog(), {
    india_sales: { a1: { enabled: true, owner: 'Arfin' } }
  });
  assert.equal(out.metrics.find((m) => m.id === 'a1').owner, 'Arfin');
});

test('a metric added to the catalogue after a department chose is kept, not hidden', () => {
  const { catalog: out } = applySelections(catalog(), {
    india_sales: { a1: { enabled: true } } // a2 and a3 are not mentioned at all
  });
  const ids = out.metrics.filter((m) => m.dept === 'india_sales').map((m) => m.id);
  assert.deepEqual(ids.sort(), ['a1', 'a2', 'a3']);
});

test('applying does not mutate the catalogue it was given', () => {
  const c = catalog();
  applySelections(c, { india_sales: { a1: { enabled: true, target: 99 } } });
  assert.equal(c.metrics.find((m) => m.id === 'a1').target, null);
  assert.equal(c.metrics.length, 4);
});

/* -------------------------------- cards ---------------------------------- */

test('a card keeps only the rings that survived', () => {
  const { catalog: out } = applySelections(catalog(), {
    india_sales: { a1: { enabled: true }, a2: { enabled: false }, a3: { enabled: true } }
  });
  assert.deepEqual(out.cards.find((c) => c.id === 'india-one').rings, ['a1']);
});

test('a card whose rings were all deselected is dropped entirely', () => {
  const { catalog: out, stats } = applySelections(catalog(), {
    india_sales: { a1: { enabled: false }, a2: { enabled: false }, a3: { enabled: false } }
  });
  assert.equal(out.cards.find((c) => c.id === 'india-one'), undefined);
  assert.equal(out.cards.find((c) => c.id === 'india-two'), undefined);
  assert.deepEqual(stats.cardsDropped.sort(), ['india-one', 'india-two']);
});

test('a tile pointing at a deselected metric is removed from its card', () => {
  const { catalog: out } = applySelections(catalog(), {
    india_sales: { a1: { enabled: true }, a3: { enabled: false } }
  });
  assert.deepEqual(out.cards.find((c) => c.id === 'india-one').tiles, []);
});

test("another department's cards are untouched", () => {
  const { catalog: out } = applySelections(catalog(), {
    india_sales: { a1: { enabled: false }, a2: { enabled: false }, a3: { enabled: false } }
  });
  assert.ok(out.cards.find((c) => c.id === 'us-one'));
});

test('a department that turned everything off is reported, not silently empty', () => {
  const { stats } = applySelections(catalog(), {
    india_sales: { a1: { enabled: false }, a2: { enabled: false }, a3: { enabled: false } }
  });
  assert.deepEqual(stats.emptiedDepartments, ['india_sales']);
});

/* ------------------------------ description ------------------------------ */

test('describeSelections says plainly when nothing is filtering', () => {
  assert.match(describeSelections({ deptsWithChoices: 0 }), /every catalogue metric/);
});

test('describeSelections counts what was applied', () => {
  const { stats } = applySelections(catalog(), {
    india_sales: { a1: { enabled: true, target: 3, owner: 'Subham' }, a2: { enabled: false } }
  });
  const line = describeSelections(stats);
  assert.match(line, /kept/);
  assert.match(line, /1 targets from the app/);
  assert.match(line, /1 owners named/);
});
