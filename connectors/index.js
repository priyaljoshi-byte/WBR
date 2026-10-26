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

const REGISTRY = {
  gsheet: fetchGsheet,
  notion: fetchNotion,
  postgres: fetchPostgres,
  manual: fetchManual
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
export async function fetchSource(source, period, env = process.env) {
  const impl = REGISTRY[source.kind];
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
  if (typeof source.ref === 'string' && source.ref.startsWith('REPLACE_WITH')) {
    return { ...base, error: `${source.label}: not connected yet - the id is still a placeholder in sources.json` };
  }

  try {
    const result = await impl(source, period, env);
    return {
      ...base,
      ...result,
      status: result.rows?.length ? 'ok' : 'empty',
      fetchedAt: base.fetchedAt
    };
  } catch (err) {
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
