/**
 * dates.test.js - the four formats one real column was holding, and the one of
 * them that JavaScript reads wrongly.
 *
 * The fixtures here are not invented. They are the shapes actually present in
 * the "Date of Joining" column of the company's hiring tracker:
 *
 *     17 Jun 2025    4-Aug-2025    01-Jun-2026
 *     05/10/2026     21/09/2026    12/10/2026    ""
 *
 * The test that matters most is the one asserting 05/10/2026 reads as 5 October
 * in that column, because `new Date("05/10/2026")` returns 10 May and nothing in
 * a dashboard built on it would say so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDate, inferColumnDateOrder, resolveColumnDateOrder, parseDateColumn,
  fromSerial, toSerial, dateTime, DEFAULT_SERIAL_RANGE
} from '../dates.js';
import { filterToPeriod } from '../../connectors/gsheet.js';
import { freshnessDetail } from '../freshness.js';

/** The column, verbatim. Order preserved - the evidence rows are not first. */
const HIRING_COLUMN = [
  '17 Jun 2025',
  '4-Aug-2025',
  '01-Jun-2026',
  '05/10/2026',
  '21/09/2026',
  '12/10/2026',
  ''
];

/* ------------------------------------------------------------------------ *
 * every format in that column round-trips
 * ------------------------------------------------------------------------ */

test('the three unambiguous formats in the real column each round-trip', () => {
  const cases = [
    ['17 Jun 2025', '2025-06-17', 'DD Mon YYYY'],
    ['4-Aug-2025', '2025-08-04', 'D-Mon-YYYY'],
    ['01-Jun-2026', '2026-06-01', 'DD-Mon-YYYY']
  ];
  for (const [input, iso, format] of cases) {
    const got = parseDate(input);
    assert.ok(got, `${input} should parse`);
    assert.equal(got.iso, iso, input);
    assert.equal(got.format, format, input);
    assert.equal(got.ambiguous, false);
    assert.equal(got.confidence, 'certain');
  }
});

test('ISO dates and ISO timestamps both parse, and keep their precision', () => {
  const dateOnly = parseDate('2026-10-05');
  assert.equal(dateOnly.iso, '2026-10-05');
  assert.equal(dateOnly.format, 'YYYY-MM-DD');

  const stamp = parseDate('2026-10-05T04:30:00.000Z');
  assert.equal(stamp.iso, '2026-10-05T04:30:00.000Z');
  assert.equal(stamp.format, 'ISO timestamp');

  // an offset is honoured rather than dropped: 10:00 in Kolkata is 04:30 UTC
  const offset = parseDate('2026-10-05T10:00:00+05:30');
  assert.equal(offset.iso, '2026-10-05T04:30:00.000Z');

  // a naive timestamp is read as UTC, the same convention the rest of Pulse uses
  assert.equal(parseDate('2026-10-05 04:30:00').iso, '2026-10-05T04:30:00.000Z');
});

test('a longer month name and a year-first slash date both parse', () => {
  assert.equal(parseDate('17 June 2025').iso, '2025-06-17');
  assert.equal(parseDate('June 17, 2025').iso, '2025-06-17');
  assert.equal(parseDate('2026/10/05').iso, '2026-10-05', 'a four-digit year first is never ambiguous');
});

/* ------------------------------------------------------------------------ *
 * the dangerous one
 * ------------------------------------------------------------------------ */

test('05/10/2026 is NOT resolved on its own - both readings are real dates', () => {
  const got = parseDate('05/10/2026');
  assert.ok(got, 'it is recognisably a date, just not a decided one');
  assert.equal(got.ambiguous, true);
  assert.equal(got.confidence, 'unresolved');
  assert.equal(got.iso, null, 'refusing to choose is the whole point');
  assert.deepEqual(got.readings, { DMY: '2026-10-05', MDY: '2026-05-10' });

  // for contrast: what the language would have done, silently
  assert.equal(new Date('05/10/2026').getUTCMonth(), 4, 'JS reads this as May');
});

test('05/10/2026 reads as 5 October in a DMY column and 10 May in an MDY one', () => {
  assert.equal(parseDate('05/10/2026', { dateOrder: 'DMY' }).iso, '2026-10-05');
  assert.equal(parseDate('05/10/2026', { dateOrder: 'MDY' }).iso, '2026-05-10');

  const dmy = parseDate('05/10/2026', { dateOrder: 'DMY' });
  assert.equal(dmy.confidence, 'resolved', 'resolved, not certain - it WAS ambiguous');
  assert.equal(dmy.ambiguous, true, 'the value stays marked ambiguous after resolution');
  assert.equal(dmy.format, 'DD/MM/YYYY');
});

test('a slash date that can only read one way resolves itself, with no order set', () => {
  const got = parseDate('21/09/2026');
  assert.equal(got.iso, '2026-09-21');
  assert.equal(got.ambiguous, false, '21 cannot be a month');
  assert.equal(got.confidence, 'certain');
  assert.equal(got.dateOrder, 'DMY');

  const other = parseDate('09/21/2026');
  assert.equal(other.iso, '2026-09-21');
  assert.equal(other.dateOrder, 'MDY');
});

test('a slash date that reads the same both ways needs no resolving', () => {
  const got = parseDate('05/05/2026');
  assert.equal(got.iso, '2026-05-05');
  assert.equal(got.ambiguous, true, 'the shape is still ambiguous');
  assert.equal(got.confidence, 'certain', 'but both readings agree, so there is no risk');
});

/* ------------------------------------------------------------------------ *
 * inferring the column's order from the column
 * ------------------------------------------------------------------------ */

test('one row that can only be DD/MM settles the whole column', () => {
  const got = inferColumnDateOrder(HIRING_COLUMN);
  assert.equal(got.order, 'DMY');
  assert.equal(got.basis, 'evidence');
  assert.equal(got.example, '21/09/2026', 'the row that proved it');
  assert.equal(got.dmyOnly, 1);
  assert.equal(got.mdyOnly, 0);
  assert.equal(got.ambiguous, 2, '05/10/2026 and 12/10/2026 both read two ways');
});

test('the real hiring column reads 05/10/2026 as 5 October, not 10 May', () => {
  const read = parseDateColumn(HIRING_COLUMN, { column: 'date of joining' });

  assert.equal(read.order, 'DMY');
  assert.equal(read.basis, 'evidence', 'inferred from the column, not configured or guessed');
  assert.deepEqual(read.results.map((r) => (r ? r.iso : null)), [
    '2025-06-17',
    '2025-08-04',
    '2026-06-01',
    '2026-10-05',   // the one JavaScript would have put in May
    '2026-09-21',
    '2026-10-12',
    null            // the empty cell
  ]);
  assert.equal(read.blanks, 1);
  assert.equal(read.unreadable, 0);
  assert.equal(read.unresolved, 0);
  assert.deepEqual(read.warnings, [], 'nothing to warn about: the column settled itself');
});

test('the same rows in an MDY column read as 10 May, and the engine says which it used', () => {
  const mdy = HIRING_COLUMN.map((v) => (v === '21/09/2026' ? '09/21/2026' : v));
  const read = parseDateColumn(mdy, { column: 'date of joining' });

  assert.equal(read.order, 'MDY');
  assert.equal(read.results[3].iso, '2026-05-10');
  assert.equal(read.results[3].confidence, 'resolved');
  assert.equal(read.results[5].iso, '2026-12-10', '12/10/2026 is 10 December under MDY');
});

test('an explicit date_order beats the column, because somebody owns that sheet', () => {
  const resolved = resolveColumnDateOrder(HIRING_COLUMN, { dateOrder: 'MDY', column: 'doj' });
  assert.equal(resolved.order, 'MDY');
  assert.equal(resolved.basis, 'config');
  assert.equal(resolved.inferred.order, 'DMY', 'the evidence is still reported, for the argument');
});

test('a wholly ambiguous column falls back to the default AND says so', () => {
  const column = ['05/10/2026', '01/02/2026', '03/04/2026'];
  assert.equal(inferColumnDateOrder(column).order, null, 'no row settles it');
  assert.equal(inferColumnDateOrder(column).basis, 'none');

  const read = parseDateColumn(column, { column: 'joined_on', defaultDateOrder: 'DMY' });
  assert.equal(read.order, 'DMY');
  assert.equal(read.basis, 'default');
  assert.equal(read.results[0].iso, '2026-10-05');
  assert.equal(read.warnings.length, 1, 'exactly one warning, naming the column');
  assert.match(read.warnings[0], /"joined_on"/);
  assert.match(read.warnings[0], /ambiguous from top to bottom/);
  assert.match(read.warnings[0], /configured default/);
  assert.match(read.warnings[0], /Set date_order/);
});

test('a wholly ambiguous column with no default is left unread, one warning per row', () => {
  const read = parseDateColumn(['05/10/2026', '01/02/2026'], { column: 'joined_on' });
  assert.equal(read.order, null);
  assert.equal(read.basis, 'none');
  assert.deepEqual(read.results, [null, null], 'nothing is guessed');
  assert.equal(read.unresolved, 2);
  // the column warning, plus one naming each offending cell
  assert.equal(read.warnings.length, 3);
  assert.match(read.warnings[1], /"05\/10\/2026"/);
  assert.match(read.warnings[1], /2026-10-05 and 2026-05-10/);
  assert.match(read.warnings[1], /kept and left undated/);
});

test('a column holding BOTH orders is a fault, reported rather than averaged', () => {
  const column = ['21/09/2026', '09/21/2026', '05/10/2026'];
  const got = inferColumnDateOrder(column);
  assert.equal(got.order, null);
  assert.equal(got.basis, 'conflict');
  assert.equal(got.dmyOnly, 1);
  assert.equal(got.mdyOnly, 1);

  const read = parseDateColumn(column, { column: 'doj', defaultDateOrder: 'DMY' });
  assert.equal(read.order, null, 'a default must not paper over a contradiction');
  assert.match(read.warnings[0], /holds both orders/);
  assert.equal(read.results[2], null, 'the ambiguous row stays unread');
  assert.equal(read.results[0].iso, '2026-09-21', 'the unambiguous rows still parse');
});

/* ------------------------------------------------------------------------ *
 * sheet serials
 * ------------------------------------------------------------------------ */

test('a Sheets serial converts correctly, counting from 1899-12-30', () => {
  assert.equal(parseDate(46300).iso, '2026-10-05');
  assert.equal(parseDate(45825).iso, '2025-06-17');
  assert.equal(parseDate(45873).iso, '2025-08-04');
  assert.equal(parseDate(46300).format, 'sheet serial');

  // round-trips both ways
  assert.equal(toSerial('2026-10-05'), 46300);
  assert.equal(fromSerial(toSerial('2026-10-05')).iso, '2026-10-05');

  // a fractional serial carries the time of day: .25 is 06:00
  assert.equal(parseDate(46300.25).iso, '2026-10-05T06:00:00.000Z');

  // a serial that arrived as a string still reads
  assert.equal(parseDate('46300').iso, '2026-10-05');
});

test('a small number is a count, not 1900 - serials are bounded on purpose', () => {
  assert.equal(parseDate(42), null, '42 is not 10 February 1900');
  assert.equal(parseDate(0), null);
  assert.equal(parseDate(2026), null, 'a bare year is not a date');
  assert.equal(parseDate(999999), null, 'past the far end of the window');

  // the window is configurable for anyone who really does track 1900
  assert.equal(parseDate(2, { serialRange: { min: 1, max: 100000 } }).iso, '1900-01-01');
  assert.equal(DEFAULT_SERIAL_RANGE.min, 18264, '1 Jan 1950');
});

/* ------------------------------------------------------------------------ *
 * garbage
 * ------------------------------------------------------------------------ */

test('garbage returns null, never an Invalid Date', () => {
  const rubbish = ['', '   ', 'TBD', 'n/a', '-', 'ASAP', 'next quarter',
    '32/13/2026', '2026-02-30', '31/02/2026', 'Jun 2025', '2025',
    'Smarch 4 2025', null, undefined, true, false, NaN, {}, []];
  for (const value of rubbish) {
    const got = parseDate(value);
    assert.equal(got, null, `${JSON.stringify(value)} should be null, got ${JSON.stringify(got)}`);
  }
  // and nothing ever escapes as the string "Invalid Date"
  assert.equal(dateTime('ASAP'), null);
});

test('a two-digit year is refused rather than assumed', () => {
  // 05/10/26 stacks a second ambiguity on the first and nothing in a column
  // settles it, so it is not read at all.
  assert.equal(parseDate('05/10/26'), null);
  assert.equal(parseDate('05/10/26', { dateOrder: 'DMY' }), null);
});

test('an unreadable cell is named in the warning, with its column and its value', () => {
  const read = parseDateColumn(['2026-10-05', 'ASAP', '2026-10-07'], { column: 'date of joining' });
  assert.equal(read.unreadable, 1);
  assert.equal(read.results[1], null);
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0], /row 2/);
  assert.match(read.warnings[0], /"ASAP"/);
  assert.match(read.warnings[0], /"date of joining"/);
  assert.match(read.warnings[0], /kept and left undated rather than dropped/);
});

/* ------------------------------------------------------------------------ *
 * wired into the connector and into freshness
 * ------------------------------------------------------------------------ */

const PERIOD = { start: '2026-10-05', end: '2026-10-11' };

test('the period filter puts an ambiguous row in the week the column says, not the week JS says', () => {
  const rows = [
    { name: 'a', date_of_joining: '21/09/2026' },
    { name: 'b', date_of_joining: '05/10/2026' },
    { name: 'c', date_of_joining: '12/10/2026' }
  ];
  const got = filterToPeriod(rows, 'date of joining', PERIOD);

  // 5 Oct is inside 5-11 Oct. Read as 10 May it would have fallen outside and
  // the row would have silently vanished from the week.
  assert.deepEqual(got.rows.map((r) => r.name), ['b']);
  assert.deepEqual(got.warnings, []);
});

test('an explicit MDY date_order on the source changes which rows are in the week', () => {
  const rows = [
    { name: 'b', date_of_joining: '05/10/2026' },
    { name: 'c', date_of_joining: '10/05/2026' }
  ];
  const dmy = filterToPeriod(rows, 'date of joining', PERIOD, { dateOrder: 'DMY' });
  assert.deepEqual(dmy.rows.map((r) => r.name), ['b'], '5 Oct is in the week');

  const mdy = filterToPeriod(rows, 'date of joining', PERIOD, { dateOrder: 'MDY' });
  assert.deepEqual(mdy.rows.map((r) => r.name), ['c'], 'under MDY it is the other row');
});

test('an unparseable date is kept AND warned about - never silently either way', () => {
  const rows = [
    { name: 'a', date: '2026-10-06' },
    { name: 'b', date: 'ASAP' },
    { name: 'c', date: '' },
    { name: 'd', date: '2026-01-01' }
  ];
  const got = filterToPeriod(rows, 'date', PERIOD);

  assert.deepEqual(got.rows.map((r) => r.name), ['a', 'b', 'c'],
    'the unreadable and the empty row are kept; only the dated-out row leaves');

  const joined = got.warnings.join(' | ');
  assert.match(joined, /"ASAP"/, 'the offending value is named');
  assert.match(joined, /"date"/, 'and so is the column');
  assert.match(joined, /1 row in column "date" is empty/);
  assert.equal(got.warnings.length, 2, 'one per unreadable cell, one summary line for blanks');
});

test('a sheet serial column filters to the period like any other', () => {
  const rows = [
    { name: 'in', date: 46300 },      // 5 Oct 2026
    { name: 'out', date: 46174 }      // 1 Jun 2026
  ];
  const got = filterToPeriod(rows, 'date', PERIOD);
  assert.deepEqual(got.rows.map((r) => r.name), ['in']);
  assert.equal(got.latestDate, '2026-10-05T00:00:00.000Z');
});

test('freshness reads edit stamps through the same parser, and names what it could not read', () => {
  const meeting = '2026-10-26T04:30:00.000Z';
  const rows = {
    sourceRef: 's', status: 'ok', fetchedAt: meeting,
    rows: [
      { id: 1, updated_at: '2026-10-25T04:30:00.000Z' },
      { id: 2, updated_at: 'sometime last week' },
      { id: 3, updated_at: '2026-10-20T04:30:00.000Z' }
    ]
  };
  const detail = freshnessDetail(rows, { id: 's' }, meeting, {});

  assert.equal(detail.rowsWithTimestamps, 2, 'the unreadable stamp is excluded, not counted as old');
  assert.equal(detail.level, 'daily', 'newest readable row is a day old, and 1 in 2 is not a share');
  assert.equal(detail.warnings.length, 1);
  assert.match(detail.warnings[0], /"sometime last week"/);
  assert.match(detail.warnings[0], /"updated_at"/);
});

test('freshness still reads a sheet serial edit stamp', () => {
  // 46300.1875 is 5 Oct 2026 at 04:30 UTC
  const meeting = '2026-10-05T06:30:00.000Z';
  const rows = { status: 'ok', rows: [{ updated_at: 46300.1875 }, { updated_at: 46300.1875 }] };
  const detail = freshnessDetail(rows, { id: 's' }, meeting, {});
  assert.equal(detail.newestAt, '2026-10-05T04:30:00.000Z');
  assert.equal(detail.level, 'last_minute', 'both rows written two hours before the meeting');
});
