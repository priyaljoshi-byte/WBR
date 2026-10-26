/**
 * dates.js - turning what a human typed in a spreadsheet into a day, or
 * admitting that it cannot be done.
 *
 * This module exists because of one column in the real hiring tracker. The
 * "Date of Joining" column holds all of these, at the same time:
 *
 *     17 Jun 2025    4-Aug-2025    01-Jun-2026
 *     05/10/2026     21/09/2026    12/10/2026    ""
 *
 * Four formats and an empty cell. Three of the four are unambiguous. The fourth
 * is the dangerous one: `new Date("05/10/2026")` in JavaScript returns **10 May**,
 * because the language reads a bare slash date as American MM/DD. Those rows are
 * October. A weekly dashboard that silently moves a row five months is worse than
 * no dashboard, because it is confidently wrong and nothing on the page says so.
 *
 * Three rules this module will not break:
 *
 *   1. It never guesses. Garbage returns null. An ambiguous slash date with
 *      nothing to resolve it returns a result whose `iso` is null and whose
 *      `confidence` is 'unresolved' - a date that says "I do not know" out loud,
 *      which the caller must then warn about.
 *   2. Ambiguity is resolved by EVIDENCE first and configuration second. If any
 *      other row in the same column reads 21/09/2026, the column is DD/MM and
 *      every ambiguous row in it is DD/MM too. That is not a guess, it is the
 *      column telling you what it is.
 *   3. A fallback default is always announced. When the whole column is
 *      ambiguous there is no evidence to be had, so the configured default is
 *      used AND a warning is emitted naming the column. A silent default is
 *      indistinguishable from the bug this module was written to prevent.
 *
 * @typedef {'DMY'|'MDY'} DateOrder
 */

/** Both ways a bare slash date can be read. Nothing else is a valid order. */
export const DATE_ORDERS = ['DMY', 'MDY'];

/**
 * Excel and Google Sheets count days from 30 December 1899.
 *
 * The two-day offset from "1 Jan 1900 is day 1" is Lotus 1-2-3's 1900 leap-year
 * bug, which Excel copied for compatibility and Sheets copied from Excel. It is
 * wrong and it is load-bearing: every serial in every sheet on earth is computed
 * this way, so we match it rather than correct it.
 */
const SERIAL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

/**
 * Which raw numbers we are willing to read as a date serial.
 *
 * A bare number in a spreadsheet is far more often a count, an amount or a year
 * than it is a date, and the Sheets API hands back dates as raw numbers only
 * when UNFORMATTED_VALUE is set. The window is deliberately narrow - 1 Jan 1950
 * to 31 Dec 2149 - so that `42` reads as "not a date" instead of 10 February
 * 1900. Widen it with opts.serialRange if you really do track dates before 1950.
 */
export const DEFAULT_SERIAL_RANGE = { min: 18264, max: 91312 };

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

/* ------------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------------ */

const pad = (n, width) => String(n).padStart(width, '0');

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A real calendar day, leap years included. 31 Feb is not a date. */
function isValidYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= daysInMonth(year, month);
}

const isoOf = (year, month, day) => `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
const timeOf = (year, month, day) => Date.UTC(year, month - 1, day);

/**
 * @typedef {Object} ParsedDate
 * @property {string|null} iso      'YYYY-MM-DD' for a day, a full ISO 8601 string
 *                                  for a timestamp. null ONLY when the value is a
 *                                  real date whose reading could not be resolved.
 * @property {string} format        the shape we recognised, in the notation a human
 *                                  would write it: 'DD Mon YYYY', 'D-Mon-YYYY',
 *                                  'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY',
 *                                  'DD/MM/YYYY or MM/DD/YYYY', 'sheet serial',
 *                                  'ISO timestamp', ...
 * @property {boolean} ambiguous    true when the digits alone read as two different
 *                                  real dates. Stays true even after resolution -
 *                                  the value WAS ambiguous, and a caller deciding
 *                                  how much to trust it deserves to know.
 * @property {'certain'|'resolved'|'unresolved'} confidence
 *   certain     only one reading was ever possible
 *   resolved    ambiguous, and a date order settled it
 *   unresolved  ambiguous, and nothing settled it. iso is null.
 * @property {number|null} time     epoch ms (UTC midnight for a day), for sorting
 *                                  and period comparison without re-parsing.
 * @property {'slash'|'month_name'|'iso'|'numeric_ymd'|'serial'|'date_object'} shape
 * @property {DateOrder|null} [dateOrder]  which reading was taken, for slash dates
 * @property {{DMY: string, MDY: string}} [readings]  both candidate days, present
 *                                  whenever ambiguous - so a caller that later
 *                                  learns the column's order need not re-parse.
 */

function day(iso, time, format, shape, extra = {}) {
  return {
    iso, time, format, shape,
    ambiguous: false,
    confidence: 'certain',
    ...extra
  };
}

/* ------------------------------------------------------------------------ *
 * the patterns
 * ------------------------------------------------------------------------ */

/** 2026-10-05, optionally with a time and an offset. */
const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;
/** 2026/10/05 - a four-digit year first is never ambiguous. */
const YMD_SLASH_RE = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/;
/** 17 Jun 2025 / 4-Aug-2025 / 01-Jun-2026 / 17.June.2025 */
const DAY_MONTH_RE = /^(\d{1,2})([\s.\-/])\s*([A-Za-z]{3,9})\s*[\s.\-/]\s*(\d{4})$/;
/** Jun 17 2025 / June 17, 2025 */
const MONTH_DAY_RE = /^([A-Za-z]{3,9})[\s.\-/]\s*(\d{1,2}),?\s*[\s.\-/]\s*(\d{4})$/;
/** 05/10/2026 and 05.10.2026 - the dangerous one. */
const SLASH_RE = /^(\d{1,2})([/.\-])(\d{1,2})\2(\d{4})$/;
/** 05/10/26 - refused on purpose, see parseDate. */
const SHORT_YEAR_RE = /^\d{1,2}([/.\-])\d{1,2}\1\d{2}$/;

/**
 * Turn a sheet serial into a day.
 * Fractions carry the time of day, which Sheets uses for datetime cells.
 */
export function fromSerial(serial) {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  const fraction = serial - whole;
  const ms = SERIAL_EPOCH_UTC + whole * DAY_MS + Math.round(fraction * DAY_MS);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const iso = fraction === 0
    ? d.toISOString().slice(0, 10)
    : d.toISOString();
  return { iso, time: ms };
}

/** The inverse, exported so a test can state its fixtures in either direction. */
export function toSerial(isoDate) {
  const t = Date.parse(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return (t - SERIAL_EPOCH_UTC) / DAY_MS;
}

/* ------------------------------------------------------------------------ *
 * parseDate
 * ------------------------------------------------------------------------ */

/**
 * Read one cell as a date.
 *
 * @param {any} value
 * @param {Object} [opts]
 * @param {DateOrder|null} [opts.dateOrder]  how to read an ambiguous slash date.
 *        Comes from the source's `date_order`, or from inferColumnDateOrder()
 *        reading the rest of the column. Absent means "do not resolve it".
 * @param {{min:number,max:number}} [opts.serialRange]  which bare numbers may be
 *        read as sheet serials. See DEFAULT_SERIAL_RANGE.
 * @param {boolean} [opts.allowSerial=true]
 * @returns {ParsedDate|null}  null means "this is not a date", never a guess.
 */
export function parseDate(value, opts = {}) {
  const order = DATE_ORDERS.includes(opts.dateOrder) ? opts.dateOrder : null;
  const serialRange = opts.serialRange || DEFAULT_SERIAL_RANGE;
  const allowSerial = opts.allowSerial !== false;

  if (value === null || value === undefined) return null;

  // A Date the connector already built. Nothing to interpret.
  if (value instanceof Date) {
    const t = value.getTime();
    if (!Number.isFinite(t)) return null;
    return day(value.toISOString(), t, 'Date object', 'date_object');
  }

  // A bare number out of the Sheets API with UNFORMATTED_VALUE set.
  if (typeof value === 'number') {
    if (!allowSerial || !Number.isFinite(value)) return null;
    if (value < serialRange.min || value > serialRange.max) return null;
    const got = fromSerial(value);
    return got ? day(got.iso, got.time, 'sheet serial', 'serial') : null;
  }

  if (typeof value === 'boolean') return null;

  const s = String(value).trim();
  if (s === '') return null;

  // --- ISO, with or without a time ----------------------------------------
  const iso = ISO_RE.exec(s);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const dayNum = Number(iso[3]);
    if (!isValidYmd(year, month, dayNum)) return null;

    if (iso[4] === undefined) {
      return day(isoOf(year, month, dayNum), timeOf(year, month, dayNum), 'YYYY-MM-DD', 'iso');
    }
    // A naive timestamp is read as UTC, matching how the rest of Pulse treats
    // period bounds. A sheet that means local time must write the offset.
    const offset = iso[8] ? iso[8] : 'Z';
    const normalized = `${isoOf(year, month, dayNum)}T${pad(Number(iso[4]), 2)}:${iso[5]}`
      + `:${iso[6] || '00'}${iso[7] ? `.${iso[7].slice(0, 3).padEnd(3, '0')}` : '.000'}`
      + (offset === 'Z' ? 'Z' : offset);
    const t = Date.parse(normalized);
    if (!Number.isFinite(t)) return null;
    return day(new Date(t).toISOString(), t, 'ISO timestamp', 'iso');
  }

  // --- 2026/10/05 - year first, so never ambiguous ------------------------
  const ymd = YMD_SLASH_RE.exec(s);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const dayNum = Number(ymd[3]);
    if (!isValidYmd(year, month, dayNum)) return null;
    return day(isoOf(year, month, dayNum), timeOf(year, month, dayNum), 'YYYY/MM/DD', 'numeric_ymd');
  }

  // --- 17 Jun 2025 / 4-Aug-2025 / 01-Jun-2026 -----------------------------
  const dm = DAY_MONTH_RE.exec(s);
  if (dm) {
    const dayDigits = dm[1].length;
    const sep = dm[2] === ' ' || /\s/.test(dm[2]) ? ' ' : dm[2];
    const month = MONTH_NAMES[dm[3].toLowerCase()];
    const year = Number(dm[4]);
    const dayNum = Number(dm[1]);
    if (!month || !isValidYmd(year, month, dayNum)) return null;
    // 'DD Mon YYYY', 'D-Mon-YYYY', 'DD-Mon-YYYY' - the notation reports the
    // separator and the digit count, because those are the two things that
    // differ between the four shapes one real column was holding.
    const format = `${'D'.repeat(dayDigits)}${sep}Mon${sep}YYYY`;
    return day(isoOf(year, month, dayNum), timeOf(year, month, dayNum), format, 'month_name');
  }

  // --- Jun 17 2025 / June 17, 2025 ----------------------------------------
  const md = MONTH_DAY_RE.exec(s);
  if (md) {
    const month = MONTH_NAMES[md[1].toLowerCase()];
    const dayNum = Number(md[2]);
    const year = Number(md[3]);
    if (!month || !isValidYmd(year, month, dayNum)) return null;
    return day(isoOf(year, month, dayNum), timeOf(year, month, dayNum),
      `Mon ${'D'.repeat(md[2].length)} YYYY`, 'month_name');
  }

  // --- 05/10/2026 ---------------------------------------------------------
  const slash = SLASH_RE.exec(s);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[3]);
    const year = Number(slash[4]);

    const dmyValid = isValidYmd(year, b, a);   // a is the day
    const mdyValid = isValidYmd(year, a, b);   // a is the month

    if (!dmyValid && !mdyValid) return null;

    const dmyIso = dmyValid ? isoOf(year, b, a) : null;
    const mdyIso = mdyValid ? isoOf(year, a, b) : null;

    // Only one reading is a real date - the digits resolved themselves.
    if (dmyValid !== mdyValid) {
      const taken = dmyValid ? 'DMY' : 'MDY';
      const picked = dmyValid ? { y: year, m: b, d: a } : { y: year, m: a, d: b };
      return day(
        isoOf(picked.y, picked.m, picked.d),
        timeOf(picked.y, picked.m, picked.d),
        taken === 'DMY' ? 'DD/MM/YYYY' : 'MM/DD/YYYY',
        'slash',
        { dateOrder: taken }
      );
    }

    const readings = { DMY: dmyIso, MDY: mdyIso };

    // 05/05/2026 reads the same both ways. It is still ambiguous in shape, and
    // we say so, but there is nothing to resolve and no risk in reporting it.
    if (dmyIso === mdyIso) {
      return {
        ...day(dmyIso, timeOf(year, b, a), 'DD/MM/YYYY or MM/DD/YYYY', 'slash',
          { dateOrder: order, readings }),
        ambiguous: true,
        confidence: 'certain'
      };
    }

    if (!order) {
      // THE WHOLE POINT. Two real dates, nothing to choose between them, so we
      // refuse to choose. The caller must resolve this from the column or warn.
      return {
        iso: null,
        time: null,
        format: 'DD/MM/YYYY or MM/DD/YYYY',
        shape: 'slash',
        ambiguous: true,
        confidence: 'unresolved',
        dateOrder: null,
        readings
      };
    }

    const picked = order === 'DMY' ? { m: b, d: a } : { m: a, d: b };
    return {
      iso: isoOf(year, picked.m, picked.d),
      time: timeOf(year, picked.m, picked.d),
      format: order === 'DMY' ? 'DD/MM/YYYY' : 'MM/DD/YYYY',
      shape: 'slash',
      ambiguous: true,
      confidence: 'resolved',
      dateOrder: order,
      readings
    };
  }

  // --- 05/10/26 -----------------------------------------------------------
  // Refused rather than assumed. A two-digit year stacks a second ambiguity on
  // top of the first and there is no column-level evidence that settles it.
  if (SHORT_YEAR_RE.test(s)) return null;

  // --- a serial that arrived as a string ----------------------------------
  if (allowSerial && /^\d{4,7}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= serialRange.min && n <= serialRange.max) {
      const got = fromSerial(n);
      if (got) return day(got.iso, got.time, 'sheet serial', 'serial');
    }
    return null;
  }

  return null;
}

/* ------------------------------------------------------------------------ *
 * column-level inference
 * ------------------------------------------------------------------------ */

/**
 * @typedef {Object} ColumnOrder
 * @property {DateOrder|null} order
 * @property {'evidence'|'conflict'|'none'|'not_needed'} basis
 * @property {number} dmyOnly      rows that can ONLY be DD/MM (first part > 12)
 * @property {number} mdyOnly      rows that can ONLY be MM/DD (second part > 12)
 * @property {number} ambiguous    rows that read both ways
 * @property {string|null} example the row that settled it, verbatim
 * @property {string[]} warnings
 */

/**
 * Work out a column's date order from the OTHER rows in it.
 *
 * The rule is the one a human uses without thinking: if any row in the column
 * reads 21/09/2026, then 21 cannot be a month, so that row is DD/MM, so the
 * COLUMN is DD/MM, so 05/10/2026 three rows down is the 5th of October. This is
 * evidence rather than a guess - a spreadsheet column is written by one
 * convention, and a column that genuinely mixes both is a data-quality fault
 * that should be reported, not silently averaged.
 *
 * A column holding evidence for BOTH orders is exactly that fault. It returns
 * order null with basis 'conflict' and a warning, so the ambiguous rows in it
 * stay unresolved and get named individually.
 *
 * @param {Array<any>} values  every cell in the column, in row order
 * @returns {ColumnOrder}
 */
export function inferColumnDateOrder(values) {
  const list = Array.isArray(values) ? values : [];
  let dmyOnly = 0;
  let mdyOnly = 0;
  let ambiguous = 0;
  let dmyExample = null;
  let mdyExample = null;

  for (const value of list) {
    const parsed = parseDate(value, { dateOrder: null });
    if (!parsed || parsed.shape !== 'slash') continue;
    if (parsed.confidence === 'unresolved' || (parsed.ambiguous && parsed.confidence !== 'certain')) {
      ambiguous += 1;
      continue;
    }
    if (parsed.ambiguous) continue;      // reads the same both ways - no evidence
    if (parsed.dateOrder === 'DMY') {
      dmyOnly += 1;
      if (dmyExample === null) dmyExample = String(value).trim();
    } else if (parsed.dateOrder === 'MDY') {
      mdyOnly += 1;
      if (mdyExample === null) mdyExample = String(value).trim();
    }
  }

  const base = { dmyOnly, mdyOnly, ambiguous };

  if (dmyOnly > 0 && mdyOnly > 0) {
    return {
      ...base,
      order: null,
      basis: 'conflict',
      example: dmyExample,
      warnings: [
        `this column holds both orders: "${dmyExample}" can only be DD/MM and `
        + `"${mdyExample}" can only be MM/DD. No single date order is true of it, `
        + 'so every ambiguous row in it is left unread rather than read wrongly. '
        + 'Fix the column, or split it.'
      ]
    };
  }

  if (dmyOnly > 0) return { ...base, order: 'DMY', basis: 'evidence', example: dmyExample, warnings: [] };
  if (mdyOnly > 0) return { ...base, order: 'MDY', basis: 'evidence', example: mdyExample, warnings: [] };

  return {
    ...base,
    order: null,
    basis: ambiguous > 0 ? 'none' : 'not_needed',
    example: null,
    warnings: []
  };
}

/**
 * Settle the order for one column: explicit config, then evidence, then - only
 * if the column is ambiguous from top to bottom - a configured default, said
 * out loud.
 *
 * @param {Array<any>} values
 * @param {Object} [opts]
 * @param {DateOrder|null} [opts.dateOrder]        the source's `date_order`
 * @param {DateOrder|null} [opts.defaultDateOrder] last resort, always warns
 * @param {string} [opts.column]                   column name, for the warning text
 * @param {string} [opts.sourceLabel]              source name, for the warning text
 * @returns {{order: DateOrder|null, basis: 'config'|'evidence'|'default'|'conflict'|'none'|'not_needed', warnings: string[], inferred: ColumnOrder}}
 */
export function resolveColumnDateOrder(values, opts = {}) {
  const column = opts.column ? `"${opts.column}"` : 'the date column';
  const where = opts.sourceLabel ? ` in ${opts.sourceLabel}` : '';
  const inferred = inferColumnDateOrder(values);

  if (DATE_ORDERS.includes(opts.dateOrder)) {
    return { order: opts.dateOrder, basis: 'config', warnings: [], inferred };
  }

  if (inferred.basis === 'conflict') {
    return {
      order: null,
      basis: 'conflict',
      warnings: inferred.warnings.map((w) => `column ${column}${where}: ${w}`),
      inferred
    };
  }

  if (inferred.order) {
    return { order: inferred.order, basis: 'evidence', warnings: [], inferred };
  }

  if (inferred.basis === 'not_needed') {
    return { order: null, basis: 'not_needed', warnings: [], inferred };
  }

  // Every slash date in the column reads both ways. There is no evidence to be
  // had here, so whatever we do next is an assumption, and it gets announced.
  if (DATE_ORDERS.includes(opts.defaultDateOrder)) {
    return {
      order: opts.defaultDateOrder,
      basis: 'default',
      warnings: [
        `column ${column}${where} is ambiguous from top to bottom - every slash date in it `
        + `reads both ways, so nothing in the column says whether it is DD/MM or MM/DD. `
        + `Read as ${opts.defaultDateOrder} because that is the configured default. `
        + `Set date_order on this source to remove the assumption.`
      ],
      inferred
    };
  }

  return {
    order: null,
    basis: 'none',
    warnings: [
      `column ${column}${where} is ambiguous from top to bottom and no date_order is set, `
      + 'so its slash dates are left unread rather than read wrongly. '
      + 'Set date_order to "DMY" or "MDY" on this source.'
    ],
    inferred
  };
}

/**
 * Parse a whole column at once: resolve its order, then read every cell against
 * it, collecting a warning for each cell that could not be read.
 *
 * The per-cell warning names the column AND the offending value, because
 * "a date did not parse" sends somebody hunting through 400 rows.
 *
 * @param {Array<any>} values
 * @param {Object} [opts]  same as resolveColumnDateOrder, plus:
 * @param {boolean} [opts.warnOnBlank=false]  blanks are usually legitimate
 * @returns {{order: DateOrder|null, basis: string, results: Array<ParsedDate|null>,
 *            warnings: string[], blanks: number, unreadable: number, unresolved: number}}
 *   blanks      empty cells - no date, and usually no problem
 *   unreadable  cells holding something that is not a date in any format we read
 *   unresolved  ambiguous slash dates the column could not settle
 */
export function parseDateColumn(values, opts = {}) {
  const list = Array.isArray(values) ? values : [];
  const resolved = resolveColumnDateOrder(list, opts);
  const warnings = [...resolved.warnings];
  const column = opts.column ? `"${opts.column}"` : 'the date column';
  let blanks = 0;
  let unreadable = 0;
  let unresolved = 0;

  const results = list.map((value, i) => {
    const blank = value === null || value === undefined || String(value).trim() === '';
    if (blank) {
      blanks += 1;
      if (opts.warnOnBlank) {
        warnings.push(`row ${i + 1}: column ${column} is empty - the row has no date`);
      }
      return null;
    }
    const parsed = parseDate(value, { ...opts, dateOrder: resolved.order });
    if (!parsed) {
      unreadable += 1;
      warnings.push(
        `row ${i + 1}: "${String(value).trim()}" in column ${column} is not a date in any `
        + 'format this engine reads - the row is kept and left undated rather than dropped'
      );
      return null;
    }
    if (parsed.iso === null) {
      unresolved += 1;
      warnings.push(
        `row ${i + 1}: "${String(value).trim()}" in column ${column} reads as both `
        + `${parsed.readings.DMY} and ${parsed.readings.MDY} and nothing in the column `
        + 'settles which - the row is kept and left undated rather than read wrongly'
      );
      return null;
    }
    return parsed;
  });

  return {
    order: resolved.order, basis: resolved.basis, results, warnings,
    blanks, unreadable, unresolved
  };
}

/**
 * One cell, one answer, for callers that only want epoch ms and already know the
 * column's order. Returns null for anything unparseable or unresolved - it is a
 * convenience over parseDate, not a second opinion.
 *
 * @param {any} value
 * @param {Object} [opts]
 * @returns {number|null}
 */
export function dateTime(value, opts = {}) {
  const parsed = parseDate(value, opts);
  return parsed && parsed.time !== null ? parsed.time : null;
}

export default parseDate;
