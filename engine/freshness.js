/**
 * freshness.js - how the data was MAINTAINED, which is a different question from
 * whether the number is right.
 *
 * The founder's objection, verbatim: "I sometimes see last-minute Notion updates
 * put together for the sake of it. If you're running your business, you already
 * need this data daily."
 *
 * That is a testable claim, so this module tests it. If nearly every row in a
 * source was written in the hours before the meeting, the source was assembled
 * for the meeting rather than used to run the function. A source that is
 * genuinely used daily looks different: its edits are spread across the week, so
 * only a minority of rows fall inside the final window.
 *
 * Two rules this module will not break:
 *   - it never guesses. No row-level timestamp means `unknown`, not `stale`.
 *   - it never moralises. The output is a classification, not a verdict on a
 *     person, and the flag body says so.
 */

import { parseDateColumn } from './dates.js';

const HOUR = 3600 * 1000;

/** Column names that are conventionally a row's last-edited time. */
const TIMESTAMP_COLUMNS = [
  'updated_at', 'updated_on', 'updatedat', 'last_edited_time', 'last_edited',
  'last_edited_at', 'last_updated', 'lastmodified', 'last_modified',
  'modified_at', 'modified_on', 'edited_at', 'updated', 'row_updated_at'
];

export const DEFAULT_FRESHNESS = {
  daily_if_updated_within_hours: 36,
  weekly_if_updated_within_hours: 192,
  last_minute_window_hours: 24,
  last_minute_row_share: 0.8
};

/**
 * The CLOCK, not a cell.
 *
 * meetingAt is supplied by whoever started the run, so a bare number is an epoch
 * millisecond count and an ISO string is an instant. Row cells are a different
 * problem entirely - there a bare number is a sheet serial - and they go through
 * engine/dates.js instead. Keeping the two readings apart is the point: the same
 * number means 1792000000000 milliseconds in one place and 46,300 days in the
 * other, and conflating them is how a timestamp lands in the year 58,000.
 */
const clockTime = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

function readCell(row, column) {
  if (!row || !column) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, column)) return row[column];
  const want = String(column).trim().toLowerCase();
  for (const key of Object.keys(row)) {
    if (String(key).trim().toLowerCase() === want) return row[key];
  }
  return undefined;
}

/**
 * Which column holds the row's own last-edited time?
 *
 * Explicit config wins. `date_column` is accepted as a fallback but it is a
 * weaker signal - "week_of" is a business date, not an edit time - so it is only
 * used when it actually parses as a timestamp on real rows.
 *
 * @returns {string|null}
 */
export function resolveTimestampColumn(rows, source) {
  const rowArray = (rows && rows.rows) || (Array.isArray(rows) ? rows : []);
  const configured = source && (source.row_timestamp_column || source.timestamp_column);
  if (configured) return configured;
  if (!rowArray.length) return null;

  const present = new Set();
  for (const row of rowArray) for (const k of Object.keys(row || {})) present.add(String(k).trim().toLowerCase());

  for (const candidate of TIMESTAMP_COLUMNS) {
    if (present.has(candidate)) return candidate;
  }
  const dateColumn = source && source.date_column;
  if (dateColumn && present.has(String(dateColumn).trim().toLowerCase())) return dateColumn;
  return null;
}

/**
 * @typedef {Object} FreshnessDetail
 * @property {import('./types.js').Freshness} level
 * @property {string|null} column           which column we read
 * @property {number} rowsWithTimestamps
 * @property {number} rowsInWindow          rows written inside the last-minute window
 * @property {number|null} lastMinuteShare  rowsInWindow / rowsWithTimestamps
 * @property {string|null} newestAt         ISO of the most recently touched row
 * @property {number|null} ageHours         how old the newest row is at meeting time
 * @property {string} [reason]              why we returned unknown
 * @property {string[]} warnings            timestamp cells that could not be read,
 *                                          named one by one. A row whose edit time
 *                                          is unreadable is not evidence that the
 *                                          source is fresh OR stale, so it is
 *                                          excluded from the share and said out loud.
 */

/**
 * @param {import('./types.js').Rows|Array} rows
 * @param {Object} source               the sources.json entry
 * @param {string|Date} meetingAt       when the review starts
 * @param {Object} [config]             org.json `freshness`
 * @returns {FreshnessDetail}
 */
export function freshnessDetail(rows, source, meetingAt, config = {}) {
  const cfg = { ...DEFAULT_FRESHNESS, ...(config || {}) };
  const unknown = (reason) => ({
    level: 'unknown', column: null, rowsWithTimestamps: 0, rowsInWindow: 0,
    lastMinuteShare: null, newestAt: null, ageHours: null, reason, warnings: []
  });

  const envelope = Array.isArray(rows) ? null : rows;
  if (envelope && envelope.status === 'error') return unknown('the source errored, so there is nothing to classify');

  const rowArray = envelope ? (envelope.rows || []) : (Array.isArray(rows) ? rows : []);
  if (!rowArray.length) return unknown('the source returned no rows');

  const meetingTime = clockTime(meetingAt);
  if (meetingTime === null) return unknown('no meeting time was supplied to classify against');

  const column = resolveTimestampColumn(rows, source);
  if (!column) {
    return unknown(`the source exposes no row-level timestamp column, so how it is maintained cannot be measured`);
  }

  // Read the edit-time column the same way the period filter reads a business
  // date: one resolved order for the whole column, and a named warning for any
  // cell that could not be read. An edit stamp nobody can parse is the one case
  // where guessing would be most tempting and least excusable - it decides
  // whether a team gets told, in public, that they assembled a source.
  const read = parseDateColumn(rowArray.map((row) => readCell(row, column)), {
    dateOrder: source && source.date_order,
    defaultDateOrder: source && source.default_date_order,
    column,
    sourceLabel: (source && (source.label || source.id)) || undefined
  });
  const warnings = read.warnings;
  const stamps = read.results.filter(Boolean).map((p) => p.time).filter((t) => t !== null);

  if (!stamps.length) {
    return {
      ...unknown(`column "${column}" held no parseable timestamps`),
      column,
      warnings
    };
  }

  const windowStart = meetingTime - cfg.last_minute_window_hours * HOUR;
  const rowsInWindow = stamps.filter((t) => t >= windowStart && t <= meetingTime).length;
  const lastMinuteShare = rowsInWindow / stamps.length;

  const newest = Math.max(...stamps);
  const ageHours = (meetingTime - newest) / HOUR;

  const base = {
    column,
    rowsWithTimestamps: stamps.length,
    rowsInWindow,
    lastMinuteShare,
    newestAt: new Date(newest).toISOString(),
    ageHours,
    warnings
  };

  // Checked BEFORE recency, and that order is the whole point: a source
  // assembled in the last 24 hours is also, trivially, "updated today".
  //
  // Caveat worth knowing: on a source with one or two rows the share is 1.0 as
  // soon as anything is touched, so a tiny source will read last_minute easily.
  // That is left as-is rather than fudged with a hidden minimum, because a
  // two-row source nobody touched until the night before really is assembled.
  if (lastMinuteShare >= cfg.last_minute_row_share) {
    return { ...base, level: 'last_minute' };
  }

  if (ageHours <= cfg.daily_if_updated_within_hours) return { ...base, level: 'daily' };
  if (ageHours <= cfg.weekly_if_updated_within_hours) return { ...base, level: 'weekly' };
  return { ...base, level: 'stale' };
}

/**
 * @param {import('./types.js').Rows|Array} rows
 * @param {Object} source
 * @param {string|Date} meetingAt
 * @param {Object} [config] org.json `freshness`
 * @returns {import('./types.js').Freshness}
 */
export function classifyFreshness(rows, source, meetingAt, config) {
  return freshnessDetail(rows, source, meetingAt, config).level;
}

export default classifyFreshness;
