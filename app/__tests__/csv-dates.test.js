/**
 * The CSV upload path and engine/dates.js must read a date the same way.
 *
 * A sheet read and a CSV upload of the same sheet are the same data arriving
 * through two doors. If the two doors disagree about 05/10/2026, the number on
 * the dashboard depends on which one somebody used, and nothing on the page
 * says so. The last test in this file is the one that stops that drift: it
 * asserts the browser path produces output identical to calling the engine
 * directly on the same fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, dateColumnReport, dateHealth, CSV_DATE_OPTS } from '../csv.js';
import { parseDate, parseDateColumn, inferColumnDateOrder } from '../../engine/dates.js';

/** The real hiring tracker's "Date of Joining" column - four formats and a blank. */
const HIRING_CSV = [
  'candidate,Date of Joining`,status',
  'Priya,17 Jun 2025,joined',
  'Ravi,4-Aug-2025,joined',
  'Dana,05/10/2026,offer_out',
  'Sam,21/09/2026,accepted',
  'Omer,12/10/2026,accepted',
  'Nikhil,,screening',
  ''
].join('\n');

/* ------------------------- evidence resolves it --------------------------- */

test('a column with day-first evidence resolves without asking', () => {
  const parsed = parseCSV(HIRING_CSV);
  const [col] = dateColumnReport(parsed).filter((d) => d.column === 'Date of Joining`');
  assert.ok(col, 'the date column was found');
  assert.equal(col.needsAsk, false);
  assert.equal(col.basis, 'evidence');
  assert.equal(col.order, 'DMY');
});

test('the evidence that settled it is reported, so a human can object', () => {
  const parsed = parseCSV(HIRING_CSV);
  const [col] = dateColumnReport(parsed).filter((d) => d.column === 'Date of Joining`');
  assert.equal(col.example, '21/09/2026');
});

test('05/10/2026 in that column is 5 October, not 10 May', () => {
  // The whole reason this wiring exists. new Date('05/10/2026') is 10 May.
  const parsed = parseCSV(HIRING_CSV);
  const values = parsed.rows.map((r) => r['Date of Joining`']);
  const { results } = parseDateColumn(values, { column: 'Date of Joining`' });
  const dana = results[2];
  assert.equal(dana.iso, '2026-10-05');
  assert.notEqual(dana.iso, '2026-05-10');
  assert.equal(new Date('05/10/2026').getMonth(), 4, 'plain JS still reads it as May - that is the bug');
});

test('the blank cell is counted as blank, not unreadable', () => {
  const parsed = parseCSV(HIRING_CSV);
  const [col] = dateColumnReport(parsed).filter((d) => d.column === 'Date of Joining`');
  assert.equal(col.blanks, 1);
  assert.equal(col.unreadable, 0);
  assert.equal(col.parsed, 5);
});

/* --------------------------- the question ---------------------------------- */

const AMBIGUOUS_CSV = [
  'deal,closed_on,value',
  'Acme,05/10/2026,120',
  'Beta,03/04/2026,80',
  'Gamma,01/02/2026,40',
  ''
].join('\n');

test('an ambiguous column with no evidence surfaces the question instead of defaulting', () => {
  const parsed = parseCSV(AMBIGUOUS_CSV);
  const [col] = dateColumnReport(parsed).filter((d) => d.column === 'closed_on');
  assert.equal(col.needsAsk, true);
  assert.equal(col.order, null, 'it must NOT quietly pick an order');
  assert.equal(col.basis, 'none');
});

test('the question carries the offending value and both readings', () => {
  const parsed = parseCSV(AMBIGUOUS_CSV);
  const [col] = dateColumnReport(parsed).filter((d) => d.column === 'closed_on');
  assert.deepEqual(col.question, {
    value: '05/10/2026',
    DMY: '2026-10-05',
    MDY: '2026-05-10'
  });
});

test('every row stays undated until the question is answered - none is guessed', () => {
  const parsed = parseCSV(AMBIGUOUS_CSV);
  const [col] = dateColumnReport(parsed).filter((d) => d.column === 'closed_on');
  assert.equal(col.unresolved, 3);
  assert.equal(col.parsed, 0);
});

test('answering the question resolves the whole column', () => {
  const parsed = parseCSV(AMBIGUOUS_CSV);
  const answered = dateColumnReport(parsed, { dateOrders: { closed_on: 'DMY' } })
    .find((d) => d.column === 'closed_on');
  assert.equal(answered.needsAsk, false);
  assert.equal(answered.basis, 'config');
  assert.equal(answered.order, 'DMY');
  assert.equal(answered.unresolved, 0);
  assert.equal(answered.parsed, 3);
});

test('the other answer gives the other day - both are reachable', () => {
  const parsed = parseCSV(AMBIGUOUS_CSV);
  const values = parsed.rows.map((r) => r.closed_on);
  assert.equal(parseDateColumn(values, { dateOrder: 'DMY' }).results[0].iso, '2026-10-05');
  assert.equal(parseDateColumn(values, { dateOrder: 'MDY' }).results[0].iso, '2026-05-10');
});

/* ---------------------------- counts before commit ------------------------ */

const MESSY_CSV = [
  'deal,closed_on',
  'Acme,17 Jun 2025',
  'Beta,not a date',
  'Gamma,TBD',
  'Delta,',
  'Eps,21/09/2026',
  'Zeta,05/10/2026',
  ''
].join('\n');

test('unreadable and blank date cells are counted before anything is sent', () => {
  const parsed = parseCSV(MESSY_CSV);
  const reports = dateColumnReport(parsed);
  const health = dateHealth(reports);
  assert.equal(health.unreadable, 2, '"not a date" and "TBD"');
  assert.equal(health.blanks, 1);
  assert.equal(health.asking, 0, 'evidence settled the order, so nothing to ask');
});

test('dateHealth totals across every date column, and handles no columns', () => {
  assert.deepEqual(dateHealth([]), { unreadable: 0, unresolved: 0, blanks: 0, asking: 0, conflicts: 0 });
  assert.deepEqual(dateHealth(undefined), { unreadable: 0, unresolved: 0, blanks: 0, asking: 0, conflicts: 0 });
});

test('a column holding both orders is reported as a conflict, not put to a vote', () => {
  const parsed = parseCSV('deal,on\nA,21/09/2026\nB,09/21/2026\nC,05/10/2026\n');
  const [col] = dateColumnReport(parsed).filter((d) => d.column === 'on');
  assert.equal(col.basis, 'conflict');
  assert.equal(col.needsAsk, false, 'no answer is true of this column, so do not ask');
  assert.equal(col.order, null);
  assert.ok(col.warnings.length);
});

/* --------------------------- not a date column ---------------------------- */

test('a reference column with slashes in it is not treated as dates', () => {
  const parsed = parseCSV('ref,value\nAC/2026/1,10\nAC/2026/2,20\n');
  assert.deepEqual(dateColumnReport(parsed).map((d) => d.column), []);
});

test('a plain count column is not treated as dates', () => {
  const parsed = parseCSV('leads,spend\n12,400\n18,520\n');
  assert.deepEqual(dateColumnReport(parsed).map((d) => d.column), []);
});

test('a currency column is not read as sheet date serials', () => {
  // 80000, 40000 and 22000 all sit inside the serial window engine/dates.js
  // uses for live sheet reads. In a CSV they are rupees. Found in the browser:
  // the deal value column was announcing itself as a date column in 2118.
  const parsed = parseCSV([
    'deal,value,updated_on',
    'Acme,120000,17 Jun 2025',
    'Beta,80000,21/09/2026',
    'Gamma,40000,05/10/2026',
    'Delta,22000,12/10/2026'
  ].join('\n'));
  const columns = dateColumnReport(parsed).map((d) => d.column);
  assert.deepEqual(columns, ['updated_on'], 'only the real date column');
});

test('turning serials off does not change how a text date reads', () => {
  const parsed = parseCSV('deal,value,on\nA,80000,21/09/2026\nB,40000,05/10/2026\n');
  const [col] = dateColumnReport(parsed).filter((d) => d.column === 'on');
  assert.equal(col.order, 'DMY');
  assert.equal(col.unreadable, 0);
  assert.equal(col.parsed, 2);
});

/* =========================================================================
 * THE ANTI-DRIFT TEST
 * ======================================================================= */

test('the browser upload path and engine/dates.js produce identical output', () => {
  const parsed = parseCSV(HIRING_CSV);
  const column = 'Date of Joining`';
  const values = parsed.rows.map((r) => r[column]);

  // What the engine says, called directly. CSV_DATE_OPTS is the ONE documented
  // difference between the two doors (a CSV has no sheet serials in it), and
  // passing it here is what keeps that difference explicit instead of letting
  // it become drift.
  const engineColumn = parseDateColumn(values, { ...CSV_DATE_OPTS, column });
  const engineInferred = inferColumnDateOrder(values);

  // What the browser path reports.
  const [browser] = dateColumnReport(parsed).filter((d) => d.column === column);

  assert.equal(browser.order, engineColumn.order);
  assert.equal(browser.basis, engineColumn.basis);
  assert.equal(browser.blanks, engineColumn.blanks);
  assert.equal(browser.unreadable, engineColumn.unreadable);
  assert.equal(browser.unresolved, engineColumn.unresolved);
  assert.equal(browser.example, engineInferred.example);
  assert.deepEqual(browser.warnings, engineColumn.warnings);
  assert.equal(browser.parsed, engineColumn.results.filter(Boolean).length);
});

test('every cell resolves to the same ISO day through both doors', () => {
  const parsed = parseCSV(HIRING_CSV);
  const column = 'Date of Joining`';
  const values = parsed.rows.map((r) => r[column]);

  const viaEngine = parseDateColumn(values, { column }).results.map((r) => (r ? r.iso : null));

  // The browser path's own resolution, applied cell by cell with the order the
  // report settled on.
  const [browser] = dateColumnReport(parsed).filter((d) => d.column === column);
  const viaBrowser = values.map((v) => {
    const p = parseDate(v, { dateOrder: browser.order });
    return p ? p.iso : null;
  });

  assert.deepEqual(viaBrowser, viaEngine);
  assert.deepEqual(viaEngine, [
    '2025-06-17', '2025-08-04', '2026-10-05', '2026-09-21', '2026-10-12', null
  ]);
});
