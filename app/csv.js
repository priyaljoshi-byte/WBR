/**
 * csv.js - a correct CSV reader, in the browser, with no dependencies.
 *
 * Why this exists at all: the naive version is `text.split('\n').map(l => l.split(','))`
 * and it is wrong on every real export anyone will ever hand us. A deal name with a
 * comma in it, a notes column with a line break in it, a file saved on Windows, a
 * header someone quoted - any one of those silently shifts every column one to the
 * left and the department head uploads numbers that are confidently wrong.
 *
 * So this is a character-by-character state machine. It handles:
 *   - quoted fields, including the delimiter inside them
 *   - "" as an escaped quote inside a quoted field
 *   - embedded newlines inside quoted fields
 *   - CRLF, LF and lone CR line endings
 *   - a trailing newline (which must NOT produce a phantom empty row)
 *   - a single-column file (no delimiter anywhere)
 *   - a UTF-8 BOM, which Excel adds and which otherwise poisons the first header
 *
 * No DOM here. This file is imported by both the page and node:test.
 */

// The REAL date module, not a browser copy of it. engine/dates.js is what the
// Google Sheets connector uses, and a CSV upload must read "05/10/2026" exactly
// the way a sheet read would - otherwise the same column means two different
// days depending on which door it came through, and nothing on screen says so.
// There is a test asserting these two paths produce identical output; if this
// import is ever replaced with a local reimplementation, that test is the thing
// that catches the drift.
import { parseDate, parseDateColumn, inferColumnDateOrder } from '../engine/dates.js';

/**
 * Split CSV text into a grid of raw string cells. Nothing is trimmed, nothing is
 * coerced - that is the caller's business.
 *
 * @param {string} text
 * @param {{delimiter?: string}} [opts]
 * @returns {string[][]}
 */
export function parseCSVRows(text, opts = {}) {
  const delimiter = opts.delimiter || ',';
  let src = String(text == null ? '' : text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // strip the BOM Excel writes

  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let inQuotes = false;
  // Tracks whether the field we are currently building was opened with a quote.
  // Needed so a line ending in `""` still emits an (empty) final field.
  let quotedField = false;

  const endField = () => {
    row.push(field);
    field = '';
    quotedField = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i += 1; continue;                         // closing quote
      }
      field += c; i += 1; continue;                                 // newlines land here
    }

    // A quote only opens a field at the start of that field. A stray quote in the
    // middle of an unquoted value is data, not syntax.
    if (c === '"' && field === '') { inQuotes = true; quotedField = true; i += 1; continue; }

    if (c === delimiter) { endField(); i += 1; continue; }

    if (c === '\r') {
      if (src[i + 1] === '\n') i += 1; // CRLF counts once
      endRow(); i += 1; continue;
    }
    if (c === '\n') { endRow(); i += 1; continue; }

    field += c; i += 1;
  }

  // Flush whatever is left. The guard is what stops a trailing newline from
  // producing a phantom row of one empty cell.
  if (field !== '' || row.length > 0 || quotedField || inQuotes) endRow();

  return rows;
}

/** Trim, drop zero-width junk. Keeps case and oddities like a stray backtick -
 *  the mapping screen exists precisely so a human can see them. */
function cleanHeader(s) {
  return String(s == null ? '' : s).replace(/[​-‍﻿]/g, '').trim();
}

/** Two columns called "value" become "value" and "value_2". Silent collisions
 *  would overwrite a column's data on the way into an object. */
function dedupeHeaders(names) {
  const seen = new Map();
  return names.map((raw, i) => {
    const base = raw || `column_${i + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

/**
 * @typedef {Object} ParsedCSV
 * @property {string[]} columns     header text as written in the file, trimmed and de-duplicated
 * @property {string[]} lowerColumns the same, lowercased - the engine's Rows contract
 * @property {Array<Record<string,string>>} rows
 * @property {number} rowCount
 * @property {string[][]} grid      every cell, header row included
 * @property {string[]} warnings
 */

/**
 * @param {string} text
 * @param {{delimiter?: string, headerRow?: number}} [opts]
 * @returns {ParsedCSV}
 */
export function parseCSV(text, opts = {}) {
  const headerRow = Number.isInteger(opts.headerRow) ? opts.headerRow : 1;
  const grid = parseCSVRows(text, opts);
  const warnings = [];

  if (!grid.length) {
    return { columns: [], lowerColumns: [], rows: [], rowCount: 0, grid, warnings: ['the file is empty'] };
  }

  const headerIndex = Math.max(0, headerRow - 1);
  const header = grid[headerIndex] || [];
  const columns = dedupeHeaders(header.map(cleanHeader));

  if (columns.some((c) => !c)) warnings.push('some columns have no header');

  const rows = [];
  for (let r = headerIndex + 1; r < grid.length; r += 1) {
    const cells = grid[r];
    // A row of nothing but empty cells is spacing, not data.
    if (!cells.some((v) => String(v).trim() !== '')) continue;
    if (cells.length !== columns.length) {
      warnings.push(`row ${r + 1} has ${cells.length} cells but the header has ${columns.length}`);
    }
    const obj = {};
    for (let c = 0; c < columns.length; c += 1) obj[columns[c]] = cells[c] === undefined ? '' : cells[c];
    rows.push(obj);
  }

  return {
    columns,
    lowerColumns: columns.map((c) => c.toLowerCase()),
    rows,
    rowCount: rows.length,
    grid,
    warnings: warnings.slice(0, 8)
  };
}

/**
 * ===========================================================================
 * Dates
 * ===========================================================================
 * The hole this closes: a CSV upload used to go straight into the database
 * without anything looking at its date column. A sheet read would have caught
 * "05/10/2026" and asked; an upload would have let the browser's own
 * `new Date()` call it 10 May and import it silently five months out of place.
 *
 * CSV upload is the path a non-technical department head is MOST likely to
 * take, which made it the worst possible place to leave that gap.
 */

/** How date-like a column has to be before we treat it as a date column. Below
 *  this it is probably a reference number that happens to contain slashes. */
const DATE_COLUMN_SHARE = 0.5;

/**
 * Serials are OFF for CSV, and that is not a detail.
 *
 * engine/dates.js will read a bare number between 18264 and 91312 as a sheet
 * date serial, which is correct when rows come from the Sheets API with
 * UNFORMATTED_VALUE set. A CSV is the opposite case: the export has already
 * rendered every date as text, so any bare number left in the file is a count
 * or an amount. Leaving serials on made a pipeline column of 80000 and 22000
 * read as a column of dates in 2118 - the deal value column announcing itself
 * as a date column, which is both wrong and alarming.
 */
export const CSV_DATE_OPTS = { allowSerial: false };

/**
 * @typedef {Object} DateColumnReport
 * @property {string} column
 * @property {'DMY'|'MDY'|null} order
 * @property {'config'|'evidence'|'default'|'conflict'|'none'|'not_needed'} basis
 * @property {string|null} example      the row that settled it, verbatim
 * @property {number} blanks
 * @property {number} unreadable        cells that are not a date in any shape we read
 * @property {number} unresolved        ambiguous slash dates nothing could settle
 * @property {number} parsed
 * @property {boolean} needsAsk         true when only a human can settle it
 * @property {{value:string, DMY:string, MDY:string}|null} question
 * @property {string[]} warnings
 */

/**
 * Which columns in this file hold dates, and what can be said about each.
 *
 * Nothing here decides anything a human would disagree with silently. A column
 * whose order is settled by evidence is reported as settled; a column that is
 * ambiguous top to bottom comes back with `needsAsk` and the exact cell to put
 * in front of the person, because the person uploading is the one person in the
 * building who actually knows which day they meant.
 *
 * @param {ParsedCSV} parsed
 * @param {{dateOrders?: Record<string,'DMY'|'MDY'>}} [opts]
 * @returns {DateColumnReport[]}
 */
export function dateColumnReport(parsed, opts = {}) {
  const configured = opts.dateOrders || {};
  const out = [];

  for (const column of parsed.columns) {
    const values = parsed.rows.map((r) => r[column]);
    const nonBlank = values.filter((v) => String(v == null ? '' : v).trim() !== '');
    if (!nonBlank.length) continue;

    // parseDate returns an object even for an unresolved ambiguous date, so a
    // non-null answer means "this is date-shaped" regardless of readability.
    const recognised = nonBlank.filter((v) => parseDate(v, { ...CSV_DATE_OPTS, dateOrder: null }) !== null).length;
    if (recognised / nonBlank.length < DATE_COLUMN_SHARE) continue;

    const chosen = configured[column] || null;
    const report = parseDateColumn(values, { ...CSV_DATE_OPTS, column, dateOrder: chosen });
    const inferred = inferColumnDateOrder(values);

    // Only a column that is ambiguous from top to bottom is worth asking about.
    // 'conflict' is not a question - the column genuinely holds both orders and
    // no answer is true of it, so it is reported rather than put to a vote.
    const needsAsk = report.basis === 'none';

    let question = null;
    if (needsAsk) {
      for (const v of nonBlank) {
        const p = parseDate(v, { ...CSV_DATE_OPTS, dateOrder: null });
        if (p && p.confidence === 'unresolved' && p.readings) {
          question = { value: String(v).trim(), DMY: p.readings.DMY, MDY: p.readings.MDY };
          break;
        }
      }
    }

    out.push({
      column,
      order: report.order,
      basis: report.basis,
      example: inferred.example,
      blanks: report.blanks,
      unreadable: report.unreadable,
      unresolved: report.unresolved,
      parsed: report.results.filter(Boolean).length,
      needsAsk,
      question,
      warnings: report.warnings
    });
  }

  return out;
}

/** The headline a reviewer needs before pressing confirm: how many date cells
 *  in this file will not import as a day. */
export function dateHealth(reports) {
  return (reports || []).reduce((acc, r) => ({
    unreadable: acc.unreadable + r.unreadable,
    unresolved: acc.unresolved + r.unresolved,
    blanks: acc.blanks + r.blanks,
    asking: acc.asking + (r.needsAsk ? 1 : 0),
    conflicts: acc.conflicts + (r.basis === 'conflict' ? 1 : 0)
  }), { unreadable: 0, unresolved: 0, blanks: 0, asking: 0, conflicts: 0 });
}

/**
 * Turn a parsed file into the Rows envelope every connector returns, so an upload
 * is indistinguishable downstream from a live sheet read.
 * See the Rows typedef in engine/types.js.
 */
export function toRowsEnvelope(parsed, sourceRef, fetchedAt) {
  return {
    sourceRef,
    columns: parsed.lowerColumns,
    rows: parsed.rows.map((row) => {
      const out = {};
      for (const key of Object.keys(row)) out[key.toLowerCase()] = row[key];
      return out;
    }),
    fetchedAt: fetchedAt || new Date().toISOString(),
    status: parsed.rows.length ? 'ok' : 'empty'
  };
}

export default parseCSV;
