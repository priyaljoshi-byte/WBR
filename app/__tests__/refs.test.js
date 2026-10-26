import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetRef, parseNotionRef, parseRef, isPlaceholderRef } from '../refs.js';

const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

/* ---------------------------------- Sheets -------------------------------- */

test('sheets: the ordinary share link', () => {
  const r = parseSheetRef(`https://docs.google.com/spreadsheets/d/${SHEET}/edit?usp=sharing`);
  assert.equal(r.ok, true);
  assert.equal(r.id, SHEET);
  assert.equal(r.kind, 'gsheet');
});

test('sheets: a #gid fragment does not end up in the id', () => {
  const r = parseSheetRef(`https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=1884566213`);
  assert.equal(r.id, SHEET);
  assert.equal(r.gid, '1884566213');
});

test('sheets: query gid and fragment gid together', () => {
  const r = parseSheetRef(`https://docs.google.com/spreadsheets/d/${SHEET}/edit?gid=0#gid=0`);
  assert.equal(r.id, SHEET);
  assert.equal(r.gid, '0');
});

test('sheets: no /edit suffix at all', () => {
  assert.equal(parseSheetRef(`https://docs.google.com/spreadsheets/d/${SHEET}`).id, SHEET);
});

test('sheets: trailing slash, no /edit', () => {
  assert.equal(parseSheetRef(`https://docs.google.com/spreadsheets/d/${SHEET}/`).id, SHEET);
});

test('sheets: the /u/0/ form you get when signed into several accounts', () => {
  assert.equal(parseSheetRef(`https://docs.google.com/spreadsheets/u/2/d/${SHEET}/edit`).id, SHEET);
});

test('sheets: a bare id pasted on its own', () => {
  const r = parseSheetRef(SHEET);
  assert.equal(r.ok, true);
  assert.equal(r.id, SHEET);
  assert.equal(r.gid, null);
});

test('sheets: surrounding whitespace from a copy-paste is tolerated', () => {
  assert.equal(parseSheetRef(`  https://docs.google.com/spreadsheets/d/${SHEET}/edit  `).id, SHEET);
});

test('sheets: an empty paste explains what to do', () => {
  const r = parseSheetRef('   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /address bar/);
});

test('sheets: a publish-to-web link is rejected with the reason', () => {
  const r = parseSheetRef('https://docs.google.com/spreadsheets/d/e/2PACX-1vT8Qh/pubhtml');
  assert.equal(r.ok, false);
  assert.match(r.error, /publish to web/i);
});

test('sheets: a Google Doc link is rejected by name', () => {
  const r = parseSheetRef(`https://docs.google.com/document/d/${SHEET}/edit`);
  assert.equal(r.ok, false);
  assert.match(r.error, /Google Doc/);
});

test('sheets: a Drive folder link is rejected by name', () => {
  const r = parseSheetRef('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz01234');
  assert.equal(r.ok, false);
  assert.match(r.error, /Drive/);
});

test('sheets: an unrelated URL is rejected', () => {
  const r = parseSheetRef('https://example.com/some/sheet');
  assert.equal(r.ok, false);
  assert.match(r.error, /spreadsheets\/d/);
});

test('sheets: a short word is not an id', () => {
  assert.equal(parseSheetRef('Deals').ok, false);
});

/* ---------------------------------- Notion -------------------------------- */

const COMPACT = 'a1b2c3d4e5f67890abcdef1234567890';
const DASHED = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

test('notion: workspace link with a bare 32-hex id', () => {
  const r = parseNotionRef(`https://www.notion.so/shopos/${COMPACT}`);
  assert.equal(r.ok, true);
  assert.equal(r.id, COMPACT);
  assert.equal(r.dashed, DASHED);
});

test('notion: a title slug before the id', () => {
  const r = parseNotionRef(`https://www.notion.so/shopos/Sloosh-Delivery-Board-${COMPACT}`);
  assert.equal(r.id, COMPACT);
  assert.equal(r.titleSlug, 'Sloosh Delivery Board');
});

test('notion: the ?v= view id is ignored, the database id wins', () => {
  const viewId = '99999999999999999999999999999999';
  const r = parseNotionRef(`https://www.notion.so/shopos/Delivery-${COMPACT}?v=${viewId}&pvs=4`);
  assert.equal(r.id, COMPACT);
  assert.notEqual(r.id, viewId);
  assert.equal(r.viewIdIgnored, true);
});

test('notion: a dashed uuid in the URL is normalised to the compact id', () => {
  const r = parseNotionRef(`https://www.notion.so/shopos/${DASHED}`);
  assert.equal(r.id, COMPACT);
  assert.equal(r.dashed, DASHED);
});

test('notion: a published notion.site link', () => {
  const r = parseNotionRef(`https://shopos.notion.site/Hiring-Tracker-${COMPACT}`);
  assert.equal(r.ok, true);
  assert.equal(r.id, COMPACT);
});

test('notion: a bare compact id pasted on its own', () => {
  const r = parseNotionRef(COMPACT);
  assert.equal(r.ok, true);
  assert.equal(r.id, COMPACT);
});

test('notion: a bare dashed uuid pasted on its own', () => {
  assert.equal(parseNotionRef(DASHED).id, COMPACT);
});

test('notion: an uppercase id is lowercased', () => {
  assert.equal(parseNotionRef(COMPACT.toUpperCase()).id, COMPACT);
});

test('notion: a slug with a year in it does not confuse the id', () => {
  const r = parseNotionRef(`https://www.notion.so/shopos/Q4-2024-Roadmap-2024-${COMPACT}`);
  assert.equal(r.id, COMPACT);
});

test('notion: a link with no id explains what to do', () => {
  const r = parseNotionRef('https://www.notion.so/shopos');
  assert.equal(r.ok, false);
  assert.match(r.error, /full page/);
});

test('notion: a non-notion host is rejected by name', () => {
  const r = parseNotionRef(`https://evil.example.com/${COMPACT}`);
  assert.equal(r.ok, false);
  assert.match(r.error, /evil\.example\.com/);
});

test('notion: an empty paste explains what to do', () => {
  assert.equal(parseNotionRef('').ok, false);
});

test('notion: random text is not an id', () => {
  assert.equal(parseNotionRef('the hiring board').ok, false);
});

/* ---------------------------------- shared -------------------------------- */

test('parseRef dispatches on kind', () => {
  assert.equal(parseRef('gsheet', `https://docs.google.com/spreadsheets/d/${SHEET}/edit`).id, SHEET);
  assert.equal(parseRef('notion', COMPACT).id, COMPACT);
  const r = parseRef('postgres', 'postgres://x');
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot parse/);
});

test('isPlaceholderRef agrees with `pulse check`', () => {
  assert.equal(isPlaceholderRef('REPLACE_WITH_SPREADSHEET_ID'), true);
  assert.equal(isPlaceholderRef('REPLACE_WITH_DATABASE_ID'), true);
  assert.equal(isPlaceholderRef(''), true);
  assert.equal(isPlaceholderRef(null), true);
  assert.equal(isPlaceholderRef(SHEET), false);
  assert.equal(isPlaceholderRef('SLOOSH_DB_URL'), false); // an env var name, not a gap
});
