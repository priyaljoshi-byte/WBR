/**
 * mapping.js - the control that absorbs reality.
 *
 * The metric definitions in config/catalog.json name columns like `updated_on`,
 * `value`, `days_to_close`. The sheet a team has actually been keeping for two
 * years has columns like `Updated On`, `Deal Value` and ``Date of Joining` `` -
 * with a stray backtick, because someone fat-fingered it in 2023 and every
 * formula downstream now depends on it.
 *
 * Without this module the only fix is editing JSON, which means filing a ticket,
 * which means the sheet never gets connected. With it, the mismatch is a dropdown.
 *
 * The pre-selection is a SUGGESTION and the UI must always show it as one. A
 * silently wrong auto-map is worse than no auto-map: it produces a number that is
 * confidently incorrect, and nobody looks at a field that was already filled in.
 *
 * No DOM here. Imported by both the page and node:test.
 */

/** Threshold a suggestion must clear to be pre-selected. Below it the dropdown
 *  opens on "not mapped", which is the honest answer. */
export const SUGGEST_THRESHOLD = 0.5;

/** Same weighting as transcript/continuity.js: token set answers "same subject",
 *  bigrams answer "same shape". Keeping the two matchers consistent means one
 *  mental model for the whole system rather than two. */
export const TOKEN_WEIGHT = 0.6;
export const BIGRAM_WEIGHT = 0.4;

/** Score given when one name wholly contains the other ("value" in "deal value").
 *  High enough to pre-select, low enough to stay visibly below an exact match. */
export const CONTAINMENT_SCORE = 0.75;

/** Lowercase, and treat every non-alphanumeric run as a separator. This is what
 *  kills the stray backtick, the non-breaking space, the trailing colon, and the
 *  difference between snake_case, Title Case and "Date-of-Joining". */
export function normalizeName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const compact = (s) => normalizeName(s).replace(/ /g, '');

function tokens(s) {
  const t = normalizeName(s).split(' ').filter(Boolean);
  // Fold trivial plurals so `leads` and `lead` are the same subject.
  return t.map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared += 1;
  return shared / (A.size + B.size - shared);
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

/** Sorensen-Dice over character bigrams, counted as a multiset. */
function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return a === b ? 1 : 0;
  const pool = new Map();
  for (const g of A) pool.set(g, (pool.get(g) || 0) + 1);
  let shared = 0;
  for (const g of B) {
    const left = pool.get(g) || 0;
    if (left > 0) { shared += 1; pool.set(g, left - 1); }
  }
  return (2 * shared) / (A.length + B.length);
}

/**
 * How alike are two column names, 0..1.
 * @param {string} a
 * @param {string} b
 */
export function similarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ca = compact(a);
  const cb = compact(b);
  const blended = TOKEN_WEIGHT * jaccard(tokens(a), tokens(b)) + BIGRAM_WEIGHT * dice(ca, cb);

  // Containment only counts for names long enough to mean something. Without the
  // length floor, every column would "contain" the required column `on`.
  const longEnough = Math.min(ca.length, cb.length) >= 3;
  if (longEnough && (ca.includes(cb) || cb.includes(ca))) return Math.max(blended, CONTAINMENT_SCORE);

  return blended;
}

/**
 * @typedef {Object} MappingRow
 * @property {string} required     the column a metric asks for
 * @property {string|null} detected the column in the file we think it is
 * @property {number} score
 * @property {'exact'|'fuzzy'|'none'} how
 * @property {Array<{column:string, score:number}>} alternatives  ranked, for the dropdown
 */

/**
 * Pre-select a detected column for each required column.
 *
 * Assignment is greedy on the best score across the whole grid, not per-row, so a
 * single detected column cannot be claimed by a weak match before the strong one
 * gets a look. `created_on` does not steal `Updated On` out from under
 * `updated_on` just because it was listed first.
 *
 * @param {string[]} required
 * @param {string[]} detected
 * @param {{threshold?: number}} [opts]
 * @returns {MappingRow[]}
 */
export function suggestMapping(required, detected, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : SUGGEST_THRESHOLD;
  const req = (required || []).filter((r) => r != null && String(r).trim() !== '');
  const det = (detected || []).filter((d) => d != null && String(d).trim() !== '');

  const pairs = [];
  for (const r of req) {
    for (const d of det) pairs.push({ r, d, score: similarity(r, d) });
  }
  // Highest score first; ties broken by the original order so the result is stable.
  pairs.sort((a, b) => b.score - a.score || req.indexOf(a.r) - req.indexOf(b.r) || det.indexOf(a.d) - det.indexOf(b.d));

  const takenRequired = new Set();
  const takenDetected = new Set();
  const chosen = new Map();
  for (const p of pairs) {
    if (p.score < threshold) break;
    if (takenRequired.has(p.r) || takenDetected.has(p.d)) continue;
    chosen.set(p.r, p);
    takenRequired.add(p.r);
    takenDetected.add(p.d);
  }

  return req.map((r) => {
    const hit = chosen.get(r);
    const alternatives = det
      .map((d) => ({ column: d, score: similarity(r, d) }))
      .sort((a, b) => b.score - a.score);
    if (!hit) return { required: r, detected: null, score: alternatives[0] ? alternatives[0].score : 0, how: 'none', alternatives };
    return {
      required: r,
      detected: hit.d,
      score: hit.score,
      how: hit.score === 1 ? 'exact' : 'fuzzy',
      alternatives
    };
  });
}

/**
 * Which columns do the metrics reading this source actually need?
 *
 * Everything a SourceQuery can name: the aggregated column, both sides of a
 * ratio, the column a `where` filters on - plus the two date columns the source
 * itself declares, which do different jobs (see _two_date_columns in
 * config/sources.json).
 *
 * @param {string} sourceId
 * @param {Array<Object>} metrics   catalog.metrics
 * @param {Object} [source]         the sources.json entry
 * @returns {Array<{column:string, why:string[]}>}
 */
export function requiredColumnsForSource(sourceId, metrics, source) {
  /** @type {Map<string,Set<string>>} */
  const need = new Map();
  const add = (col, why) => {
    if (!col) return;
    const key = String(col);
    if (!need.has(key)) need.set(key, new Set());
    need.get(key).add(why);
  };

  for (const m of metrics || []) {
    const q = m && m.source;
    if (!q || q.ref !== sourceId) continue;
    add(q.column, m.label);
    add(q.numerator_column, m.label);
    add(q.denominator_column, m.label);
    if (q.where) add(q.where.column, `${m.label} (filter)`);
  }

  if (source) {
    add(source.date_column, 'which rows are in this period');
    if (source.row_timestamp_column && source.row_timestamp_column !== '_last_edited') {
      add(source.row_timestamp_column, 'freshness - when a row was last edited');
    }
  }

  return [...need.entries()].map(([column, why]) => ({ column, why: [...why] }));
}

/** Metrics that read a `manual` source - the ones the Type it in tab renders. */
export function manualMetricsForSource(sourceId, metrics) {
  return (metrics || []).filter((m) => m && m.source && m.source.ref === sourceId);
}

export default suggestMapping;
