import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSVRows, parseCSV, toRowsEnvelope } from '../csv.js';

test('plain file: header plus two rows', () => {
  const { columns, rows, rowCount } = parseCSV('deal,owner,value\nAcme,Dana,120\nBeta,Ravi,80\n');
  assert.deepEqual(columns, ['deal', 'owner', 'value']);
  assert.equal(rowCount, 2);
  assert.deepEqual(rows[0], { deal: 'Acme', owner: 'Dana', value: '120' });
  assert.deepEqual(rows[1], { deal: 'Beta', owner: 'Ravi', value: '80' });
});

test('quoted field containing the delimiter is one field', () => {
  const grid = parseCSVRows('deal,note\n"Acme, Inc","signed"\n');
  assert.deepEqual(grid, [['deal', 'note'], ['Acme, Inc', 'signed']]);
});

test('naive split would be wrong here - the comma does not shift the columns', () => {
  const { rows } = parseCSV('deal,owner,value\n"Acme, Inc",Dana,120\n');
  assert.equal(rows[0].owner, 'Dana');
  assert.equal(rows[0].value, '120');
});

test('embedded newline inside a quoted field stays in the field', () => {
  const grid = parseCSVRows('deal,note\n"Acme","line one\nline two"\nBeta,ok\n');
  assert.equal(grid.length, 3);
  assert.equal(grid[1][1], 'line one\nline two');
  assert.deepEqual(grid[2], ['Beta', 'ok']);
});

test('embedded CRLF inside a quoted field is preserved as written', () => {
  const grid = parseCSVRows('a,b\r\n"x","one\r\ntwo"\r\n');
  assert.equal(grid.length, 2);
  assert.equal(grid[1][1], 'one\r\ntwo');
});

test('CRLF line endings do not leave a trailing carriage return on the last cell', () => {
  const { columns, rows } = parseCSV('deal,owner\r\nAcme,Dana\r\nBeta,Ravi\r\n');
  assert.deepEqual(columns, ['deal', 'owner']);
  assert.equal(rows[0].owner, 'Dana');
  assert.equal(rows[1].owner, 'Ravi');
});

test('lone CR line endings (old Mac exports) still split rows', () => {
  const grid = parseCSVRows('a,b\rc,d\r');
  assert.deepEqual(grid, [['a', 'b'], ['c', 'd']]);
});

test('a trailing newline does not invent a phantom empty row', () => {
  assert.equal(parseCSVRows('a,b\n1,2\n').length, 2);
  assert.equal(parseCSVRows('a,b\r\n1,2\r\n').length, 2);
  assert.equal(parseCSV('a,b\n1,2\n').rowCount, 1);
});

test('no trailing newline: the last row is still emitted', () => {
  assert.deepEqual(parseCSVRows('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('single-column file with no delimiter anywhere', () => {
  const { columns, rows, rowCount } = parseCSV('candidate\nPriya\nRavi\nDana\n');
  assert.deepEqual(columns, ['candidate']);
  assert.equal(rowCount, 3);
  assert.deepEqual(rows.map((r) => r.candidate), ['Priya', 'Ravi', 'Dana']);
});

test('escaped double quotes inside a quoted field', () => {
  const grid = parseCSVRows('note\n"she said ""no"" twice"\n');
  assert.equal(grid[1][0], 'she said "no" twice');
});

test('a quote in the middle of an unquoted field is data, not syntax', () => {
  const grid = parseCSVRows("size\n6\" pipe\n");
  assert.equal(grid[1][0], '6" pipe');
});

test('empty trailing field is kept', () => {
  assert.deepEqual(parseCSVRows('a,b,c\n1,,3\n'), [['a', 'b', 'c'], ['1', '', '3']]);
  assert.deepEqual(parseCSVRows('a,b\n1,\n'), [['a', 'b'], ['1', '']]);
});

test('a quoted empty final field still counts as a field', () => {
  assert.deepEqual(parseCSVRows('a,b\n1,""\n'), [['a', 'b'], ['1', '']]);
});

test('UTF-8 BOM does not poison the first header', () => {
  const { columns } = parseCSV('﻿date,spend\n2026-01-01,100\n');
  assert.deepEqual(columns, ['date', 'spend']);
});

test('headers keep the mess they actually have, trimmed only', () => {
  const { columns } = parseCSV('  Date of Joining` , Days to Close \nx,1\n');
  assert.deepEqual(columns, ['Date of Joining`', 'Days to Close']);
});

test('duplicate headers are de-duplicated instead of overwriting each other', () => {
  const { columns, rows } = parseCSV('value,value\n10,20\n');
  assert.deepEqual(columns, ['value', 'value_2']);
  assert.deepEqual(rows[0], { value: '10', value_2: '20' });
});

test('blank spacer rows are dropped, short rows are flagged but kept', () => {
  const parsed = parseCSV('a,b,c\n1,2,3\n,,\n4,5\n');
  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.rows[1].c, '');
  assert.ok(parsed.warnings.some((w) => /has 2 cells/.test(w)));
});

test('an empty file reports itself rather than throwing', () => {
  const parsed = parseCSV('');
  assert.equal(parsed.rowCount, 0);
  assert.deepEqual(parsed.columns, []);
  assert.deepEqual(parsed.warnings, ['the file is empty']);
});

test('a semicolon-delimited export can be read by passing the delimiter', () => {
  assert.deepEqual(parseCSVRows('a;b\n1;2\n', { delimiter: ';' }), [['a', 'b'], ['1', '2']]);
});

test('headerRow lets a title line above the header be skipped', () => {
  const { columns, rows } = parseCSV('Q4 export - do not edit\ndeal,value\nAcme,10\n', { headerRow: 2 });
  assert.deepEqual(columns, ['deal', 'value']);
  assert.equal(rows.length, 1);
});

test('toRowsEnvelope matches the Rows contract in engine/types.js', () => {
  const parsed = parseCSV('Deal,Updated On\nAcme,2026-01-01\n');
  const env = toRowsEnvelope(parsed, 'india_crm', '2026-01-02T00:00:00.000Z');
  assert.equal(env.sourceRef, 'india_crm');
  assert.deepEqual(env.columns, ['deal', 'updated on']);
  assert.equal(env.rows[0]['updated on'], '2026-01-01');
  assert.equal(env.status, 'ok');
  assert.equal(env.fetchedAt, '2026-01-02T00:00:00.000Z');
});

test('an upload with a header but no data rows is empty, not ok', () => {
  assert.equal(toRowsEnvelope(parseCSV('a,b\n'), 'x').status, 'empty');
});
