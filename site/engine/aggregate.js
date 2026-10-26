/**
 * aggregate.js - Rows + SourceQuery -> one number.
 *
 * Two jobs, and the second one is the important one:
 *   1. filter rows by `where`, then fold them with `agg`
 *   2. REFUSE to invent numbers. A cell that is not a number is skipped and
 *      named in `warnings`. It is never coerced to 0. A silently-zeroed row is
 *      how a dashboard lies: the ring shrinks, nobody knows why, and the
 *      founder makes a decision on a number that was never measured.
 *
 * @typedef {import('./types.js')} _types
 */

/** Scale suffixes we accept. Deliberately no "m": "1m43s" is a duration. */
const SCALES = {
  cr: 1e7, crore: 1e7, crores: 1e7,
  l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  k: 1e3, thousand: 1e3
};

const CURRENCY_CHARS = /[₹$€£¥]/g;
const CURRENCY_WORDS = /^(?:rs\.?|inr|usd|aed|sar)\s*/i;

/** mm:ss or hh:mm:ss */
const CLOCK = /^(\d{1,3})(?::([0-5]?\d))(?::([0-5]?\d))?$/;
/** 1h2m3s / 1m43s / 43s / 1m - at least one unit, each unit optional */
const UNIT_DURATION = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i;
/** number, optional scale suffix */
const SCALED_NUMBER = /^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i;

/**
 * Coerce a spreadsheet cell to a number, or null if it simply is not one.
 *
 * Handles, because real sheets contain all of these:
 *   "1,32,00,000"  -> 13200000   (Indian comma grouping)
 *   "1,234.50"     -> 1234.5     (Western grouping)
 *   "₹44L"         -> 4400000
 *   "1.32 Cr"      -> 13200000
 *   "23%"          -> 23         (the percent VALUE, not 0.23)
 *   "1m43s"        -> 103        (duration -> seconds)
 *   "1:43"         -> 103
 *   "(1,200)"      -> -1200      (accounting negative)
 *   "N/A", "", "-" -> null
 *
 * Note: a bare "5m" is read as 5 minutes (300s), not 5 million. "m" is a
 * duration unit here; the scale suffixes are Cr / L / K only.
 *
 * @param {any} input
 * @returns {number|null}
 */
export function parseValue(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  // A boolean is not a measurement. Summing booleans is how you get a "0".
  if (typeof input === 'boolean') return null;
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.getTime() : null;

  let s = String(input).trim();
  if (s === '') return null;

  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1).trim(); }

  s = s.replace(CURRENCY_WORDS, '').replace(CURRENCY_CHARS, '').trim();

  const leading = /^([+-])\s*/.exec(s);
  if (leading) { if (leading[1] === '-') sign = -sign; s = s.slice(leading[0].length).trim(); }

  // currency symbol may sit after the sign: "-₹1,200"
  s = s.replace(CURRENCY_WORDS, '').replace(CURRENCY_CHARS, '').trim();
  if (s === '') return null;

  // clock durations, before anything strips the colon
  const clock = CLOCK.exec(s);
  if (clock) {
    const a = Number(clock[1]), b = Number(clock[2]), c = clock[3] === undefined ? null : Number(clock[3]);
    // mm:ss when two parts, hh:mm:ss when three
    const seconds = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
    return sign * seconds;
  }

  // unit durations - must carry at least one of h/m/s
  if (/[hms]/i.test(s) && !/[^0-9.hms\s]/i.test(s)) {
    const d = UNIT_DURATION.exec(s);
    if (d && (d[1] !== undefined || d[2] !== undefined || d[3] !== undefined)) {
      const h = d[1] ? Number(d[1]) : 0;
      const m = d[2] ? Number(d[2]) : 0;
      const sec = d[3] ? Number(d[3]) : 0;
      return sign * (h * 3600 + m * 60 + sec);
    }
  }

  let isPercent = false;
  if (s.endsWith('%')) { isPercent = true; s = s.slice(0, -1).trim(); }

  // commas are separators in every grouping convention we care about
  s = s.replace(/,/g, '').replace(/\s+/g, '');
  if (s === '') return null;

  const m = SCALED_NUMBER.exec(s);
  if (!m) return null;

  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;

  if (m[2]) {
    const scale = SCALES[m[2].toLowerCase()];
    if (scale === undefined) return null;
    if (isPercent) return null; // "23%K" is nonsense
    return sign * base * scale;
  }
  return sign * base;
}

/** yes/no-ish strings and real booleans, so "yes" == true == "TRUE". */
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === 'y') return true;
  if (s === 'false' || s === 'no' || s === 'n') return false;
  return null;
}

/** Plain numeric literal (no scale suffix games) - used for `equals` on numbers. */
function plainNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/,/g, '');
  if (s === '' || !/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * Case-insensitive, yes/true-tolerant equality.
 * @param {any} a @param {any} b @returns {boolean}
 */
export function looseEquals(a, b) {
  const ba = toBool(a), bb = toBool(b);
  if (ba !== null && bb !== null) return ba === bb;

  const na = plainNumber(a), nb = plainNumber(b);
  if (na !== null && nb !== null) return na === nb;

  if (a === null || a === undefined) return b === null || b === undefined || String(b).trim() === '';
  if (b === null || b === undefined) return String(a).trim() === '';

  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/** Comparable scalar for gt/gte/lt/lte: number first, then date. */
function comparable(v) {
  const n = parseValue(v);
  if (n !== null) return n;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Read a column off a row, tolerating header case and stray whitespace.
 * @param {Record<string,any>} row @param {string} column
 */
export function readCell(row, column) {
  if (!row || column === undefined || column === null) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, column)) return row[column];
  const want = String(column).trim().toLowerCase();
  for (const key of Object.keys(row)) {
    if (String(key).trim().toLowerCase() === want) return row[key];
  }
  return undefined;
}

/**
 * Does one row satisfy one where-clause? Every operator present must pass.
 * @param {Record<string,any>} row
 * @param {Object} where {column, equals|in|gt|gte|lt|lte|contains}
 */
export function matchesWhere(row, where) {
  if (!where) return true;
  const cell = readCell(row, where.column);

  if ('equals' in where && !looseEquals(cell, where.equals)) return false;

  if ('in' in where) {
    const list = Array.isArray(where.in) ? where.in : [where.in];
    if (!list.some((candidate) => looseEquals(cell, candidate))) return false;
  }

  if ('contains' in where) {
    const hay = cell === null || cell === undefined ? '' : String(cell).toLowerCase();
    if (!hay.includes(String(where.contains).toLowerCase())) return false;
  }

  for (const [op, cmp] of [['gt', (a, b) => a > b], ['gte', (a, b) => a >= b],
    ['lt', (a, b) => a < b], ['lte', (a, b) => a <= b]]) {
    if (op in where) {
      const left = comparable(cell);
      const right = comparable(where[op]);
      // an uncomparable cell is excluded, never treated as 0
      if (left === null || right === null) return false;
      if (!cmp(left, right)) return false;
    }
  }
  return true;
}

/** Accept either a Rows envelope or a bare array of row objects. */
function toRowArray(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray(rows.rows)) return rows.rows;
  return [];
}

/** Apply a SourceQuery's where clause (or clauses) to a row list. */
export function applyWhere(rowArray, where) {
  if (!where) return rowArray;
  const clauses = Array.isArray(where) ? where : [where];
  return rowArray.filter((row) => clauses.every((clause) => matchesWhere(row, clause)));
}

/**
 * A where value that still contains "{{...}}" was never substituted, so the
 * clause matches nothing and the metric quietly reads 0. Say so out loud.
 */
function unresolvedTemplates(where) {
  const found = [];
  for (const clause of (Array.isArray(where) ? where : where ? [where] : [])) {
    for (const [op, v] of Object.entries(clause || {})) {
      if (op === 'column') continue;
      for (const candidate of (Array.isArray(v) ? v : [v])) {
        if (typeof candidate === 'string' && /\{\{.+?\}\}/.test(candidate)) {
          found.push(`where ${clause.column} ${op} "${candidate}" contains an unresolved template - the filter matched nothing, so this number is not a real zero`);
        }
      }
    }
  }
  return found;
}

/** Collect the parseable numbers in one column, reporting every cell that is not one. */
function numericColumn(matched, column, warnings, tag = '') {
  const numbers = [];
  // A column absent from every row is one fact, not one per row. A hundred
  // identical lines bury the warnings that matter under the one that does not.
  if (matched.length && matched.every((r) => readCell(r, column) === undefined)) {
    warnings.push(`column "${column}"${tag} is not in the source at all - ${matched.length} row${matched.length === 1 ? '' : 's'} skipped, not counted as 0`);
    return numbers;
  }
  for (let i = 0; i < matched.length; i++) {
    const cell = readCell(matched[i], column);
    const n = parseValue(cell);
    if (n === null) {
      const shown = cell === undefined ? '(column missing)'
        : cell === null || String(cell).trim() === '' ? '(blank)'
          : `"${cell}"`;
      warnings.push(`row ${i + 1}: ${shown} in column "${column}"${tag} is not a number - skipped, not counted as 0`);
      continue;
    }
    numbers.push(n);
  }
  return numbers;
}

/** The middle value. Even counts average the two middles. */
export function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {import('./types.js').Rows|Array<Record<string,any>>} rows
 * @param {import('./types.js').SourceQuery} sourceQuery
 * @returns {{value: number|null, rowCount: number, warnings: string[]}}
 */
export function aggregate(rows, sourceQuery) {
  const warnings = [];
  const query = sourceQuery || {};
  const agg = query.agg || 'count';
  const column = query.column;

  const all = toRowArray(rows);
  const matched = applyWhere(all, query.where);
  const rowCount = matched.length;

  for (const w of unresolvedTemplates(query.where)) warnings.push(w);

  if (agg === 'count') {
    return { value: rowCount, rowCount, warnings };
  }

  // ratio: sum(numerator) / sum(denominator). CPL, CAC, win rate.
  if (agg === 'ratio') {
    const numCol = query.numerator_column;
    const denCol = query.denominator_column;
    if (!numCol || !denCol) {
      warnings.push('agg "ratio" needs numerator_column and denominator_column');
      return { value: null, rowCount, warnings };
    }
    const nums = numericColumn(matched, numCol, warnings, ' (numerator)');
    const dens = numericColumn(matched, denCol, warnings, ' (denominator)');
    if (!nums.length || !dens.length) {
      warnings.push(`ratio ${numCol}/${denCol} has no usable rows - value is unknown, not 0`);
      return { value: null, rowCount, warnings };
    }
    const denTotal = dens.reduce((a, b) => a + b, 0);
    if (denTotal === 0) {
      // Zero leads is not a cost-per-lead of infinity, and it is not 0 either.
      warnings.push(`ratio ${numCol}/${denCol}: the denominator totals 0, so there is no ratio to report`);
      return { value: null, rowCount, warnings };
    }
    return { value: nums.reduce((a, b) => a + b, 0) / denTotal, rowCount, warnings };
  }

  if (!column) {
    warnings.push(`agg "${agg}" needs a column and none was configured`);
    return { value: null, rowCount, warnings };
  }

  if (agg === 'count_distinct') {
    const seen = new Set();
    for (const row of matched) {
      const cell = readCell(row, column);
      if (cell === null || cell === undefined || String(cell).trim() === '') continue;
      seen.add(String(cell).trim().toLowerCase());
    }
    return { value: seen.size, rowCount, warnings };
  }

  // Numeric folds. Every unparseable cell is reported, not zeroed.
  const numbers = numericColumn(matched, column, warnings);

  if (numbers.length === 0) {
    // Nothing matched at all -> an honest zero for sum, nothing for the rest.
    if (matched.length === 0) {
      return { value: agg === 'sum' ? 0 : null, rowCount, warnings };
    }
    // Rows matched but not one of them held a number -> we do NOT know the value.
    warnings.push(`${matched.length} row(s) matched but none held a usable number in "${column}" - value is unknown, not 0`);
    return { value: null, rowCount, warnings };
  }

  switch (agg) {
    case 'sum': return { value: numbers.reduce((a, b) => a + b, 0), rowCount, warnings };
    case 'avg': return { value: numbers.reduce((a, b) => a + b, 0) / numbers.length, rowCount, warnings };
    case 'median': return { value: median(numbers), rowCount, warnings };
    case 'min': return { value: Math.min(...numbers), rowCount, warnings };
    case 'max': return { value: Math.max(...numbers), rowCount, warnings };
    case 'latest': return { value: numbers[numbers.length - 1], rowCount, warnings };
    default:
      warnings.push(`unknown agg "${agg}"`);
      return { value: null, rowCount, warnings };
  }
}

export default aggregate;
