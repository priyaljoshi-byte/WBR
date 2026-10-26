/**
 * Connectors
 * ==========
 * Every connector answers one question - "give me the rows" - and returns the
 * same Rows shape no matter what it read from. That uniformity is why adding
 * Linear, Stripe or a warehouse later is a new file here and nothing else.
 *
 * A connector NEVER computes a metric. It fetches and normalises rows. All
 * arithmetic lives in engine/. Keeping that line clean is what lets the same
 * metric definition point at a sheet this quarter and a database next quarter
 * without the number changing meaning.
 */

import { fetchGsheet } from './gsheet.js';
import { fetchNotion } from './notion.js';
import { fetchPostgres } from './postgres.js';
import { fetchManual } from './manual.js';
import { fetchHiring } from './hiring.js';
import { filterToPeriod } from './gsheet.js';

const REGISTRY = {
  gsheet: fetchGsheet,
  notion: fetchNotion,
  postgres: fetchPostgres,
  manual: fetchManual,
  // The hiring tracker as it is really kept - see connectors/hiring.js.
  hiring_funnel: fetchHiring
};

/**
 * Normalise a header into a stable column key: lowercase, trimmed, spaces and
 * punctuation to underscores. "Week Of" and "week_of" and "week of " all become
 * week_of, so a dept head renaming a column header cosmetically does not break
 * their dashboard at 7am on a Monday.
 */
export function normalizeKey(header) {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizeRows(headers, rawRows) {
  const columns = headers.map(normalizeKey);
  const rows = rawRows.map((r) => {
    const o = {};
    columns.forEach((c, i) => {
      if (c) o[c] = Array.isArray(r) ? r[i] : r[headers[i]];
    });
    return o;
  });
  return { columns: columns.filter(Boolean), rows };
}

/**
 * Fetch one source. Never throws - a dead source must degrade into a visible
 * flag on the dashboard, not a crashed run that leaves the founder with nothing
 * fourteen hours before the meeting.
 *
 * @param {object} source  entry from config/sources.json
 * @param {object} period  {start, end} ISO dates
 * @param {object} env     credentials, injected so this stays testable
 * @returns {Promise<import('../engine/types.js').Rows>}
 */
/**
 * The column map from the Sources screen: { "<column the metric needs>":
 * "<column the sheet has>" }. Copies the sheet's column under the needed name,
 * leaving the original in place. A column already present under the needed
 * name is left alone - the sheet saying it outright beats a map saying it.
 */
export function applyMapping(result, mapping) {
  if (!mapping || !result.rows) return result;
  const pairs = Object.entries(mapping)
    .filter(([need, have]) => need && have)
    .map(([need, have]) => [normalizeKey(need), normalizeKey(have)])
    .filter(([need, have]) => need !== have);
  if (!pairs.length) return result;
  const rows = result.rows.map((r) => {
    const o = { ...r };
    for (const [need, have] of pairs) if (!(need in o) && have in r) o[need] = r[have];
    return o;
  });
  const columns = [...new Set([...(result.columns || []), ...pairs.map(([need]) => need)])];
  return { ...result, rows, columns };
}

/** The newest file uploaded on the Sources screen, as a Rows result. */
function fromUpload(source, period) {
  const up = source._upload;
  const { columns, rows } = normalizeRows(up.columns || [], up.rows || []);
  const filtered = filterToPeriod(rows, source.date_column, period, {
    dateOrder: source.date_order,
    defaultDateOrder: source.default_date_order,
    sourceLabel: source.label || source.id
  });
  return {
    columns,
    rows: filtered.rows,
    asOf: filtered.latestDate,
    warnings: [`read from the uploaded file "${up.filename}"${up.uploaded_by ? ` (${up.uploaded_by})` : ''}`, ...filtered.warnings]
  };
}

export async function fetchSource(source, period, env = process.env) {
  const impl = REGISTRY[source.shape] || REGISTRY[source.kind];
  const base = {
    sourceRef: source.id,
    columns: [],
    rows: [],
    fetchedAt: new Date().toISOString(),
    status: 'error'
  };

  if (!impl) {
    return { ...base, error: `Unknown source kind "${source.kind}" for ${source.id}` };
  }
  const finish = (result) => {
    // A shaped source (the hiring funnel) builds its own columns; a column map
    // drawn against the raw sheet would only get in the way.
    const mapped = source.shape ? result : applyMapping(result, source._mapping);
    return { ...base, ...mapped, status: mapped.rows?.length ? 'ok' : 'empty', fetchedAt: base.fetchedAt };
  };

  if (typeof source.ref === 'string' && source.ref.startsWith('REPLACE_WITH')) {
    // Not linked, but someone uploaded a file for it: that file is the data.
    if (source._upload && !source.shape) return finish(fromUpload(source, period));
    return { ...base, error: `${source.label}: not connected yet - paste the link or upload a CSV on the Sources page` };
  }

  try {
    return finish(await impl(source, period, env));
  } catch (err) {
    // The link could not be read this week. A file uploaded for the same source
    // is the next best answer, and the warning says that is what was used.
    if (source._upload && !source.shape) {
      const r = fromUpload(source, period);
      return finish({ ...r, warnings: [`the sheet could not be read (${err.message}), so the last upload was used`, ...(r.warnings || [])] });
    }
    return { ...base, error: `${source.label}: ${err.message}` };
  }
}

/**
 * Fetch every source a run needs, once each, concurrently.
 * Deduplicating here is the difference between 7 API calls and 30 - metrics
 * share sources heavily, and sheet quotas are real.
 */
export async function fetchAll(sources, period, env = process.env) {
  const entries = await Promise.all(
    sources.map(async (s) => [s.id, await fetchSource(s, period, env)])
  );
  return Object.fromEntries(entries);
}

export { REGISTRY };
