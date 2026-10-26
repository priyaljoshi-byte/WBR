/**
 * compute-preview.js - run the REAL engine over rows that are still in the
 * browser, and draw the rings they produce.
 *
 * ===========================================================================
 * WHY THIS IS THE WHOLE POINT OF THE UPLOAD SCREEN
 * ===========================================================================
 * Before this, uploading a file ended at a preview table. You could see your
 * own rows echoed back and learn nothing: whether the column map was right,
 * whether "value" parsed as a number, whether the metric would come out as
 * 4.47 Cr or as a blank. The first time anyone found out was the following
 * Tuesday, on a dashboard, in a meeting.
 *
 * So this closes the loop in the browser. Drop a file, see the number.
 *
 * ===========================================================================
 * IT IS THE SAME ENGINE, NOT A BROWSER COPY OF IT
 * ===========================================================================
 * aggregate.js, normalize.js, compute.js and caption.js are imported directly.
 * They are pure - no node: imports, no fs, no process - which is what makes
 * this possible at all. render/rings.js and render/card.js likewise.
 *
 * That matters more than it sounds. A second implementation "just for the
 * preview" would drift within a fortnight, and then the number on this screen
 * and the number on the dashboard would disagree with nobody able to say which
 * was right. There is one aggregation, one denominator rule, one caption
 * renderer, and this screen is a second caller of them.
 *
 * ===========================================================================
 * WHAT THIS PREVIEW DELIBERATELY DOES NOT DO
 * ===========================================================================
 * It does not filter rows to a week. The weekly run does that, using the
 * source's date_column against the period it is building. A file someone just
 * exported holds whatever range they exported, and silently showing them one
 * week of it would make the preview disagree with their own spreadsheet for
 * reasons nothing on screen explains. So it computes over EVERY row in the
 * file and says so, in words, above the rings.
 */

import { orderMetrics } from '../engine/normalize.js';
import { computeSnapshot } from '../engine/compute.js';
import { ringCard } from '../render/card.js';
import { ringDefs } from '../render/rings.js';
import { esc } from './ui.js';

/** Rings per card, fixed by the geometry in render/rings.js. */
const RINGS_PER_CARD = 3;

/**
 * Rewrite a parsed file's rows into the column names the METRICS ask for.
 *
 * The catalogue says `value`; the sheet says `Deal Value`. The column map is
 * the translation, and it has to be applied before aggregation or every metric
 * reads an absent column and comes back null.
 *
 * Unmapped required columns are simply absent from the output, which is the
 * honest result: aggregate.js then reports "(column missing)" against that
 * metric rather than inventing a zero.
 *
 * @param {import('./csv.js').ParsedCSV} parsed
 * @param {Record<string,string|null>} mapping  required column -> file column
 * @returns {Array<Record<string,any>>}
 */
export function remapRows(parsed, mapping) {
  const pairs = Object.entries(mapping || {}).filter(([, from]) => from);
  if (!pairs.length) {
    // No map yet. Pass the file through as-is, lowercased, so a sheet whose
    // headers already match the catalogue works with no mapping at all.
    return parsed.rows.map((row) => {
      const out = {};
      for (const k of Object.keys(row)) out[String(k).toLowerCase()] = row[k];
      return out;
    });
  }
  return parsed.rows.map((row) => {
    const out = {};
    // Keep the original columns too, lowercased. A `where` clause may filter on
    // a column nobody listed as required, and dropping it would silently change
    // which rows match.
    for (const k of Object.keys(row)) out[String(k).toLowerCase()] = row[k];
    for (const [need, from] of pairs) out[String(need).toLowerCase()] = row[from];
    return out;
  });
}

/**
 * Every metric in the catalogue that reads this source.
 * @param {Array} metrics catalog.metrics
 * @param {string} sourceId
 */
export function metricsForSource(metrics, sourceId) {
  return (metrics || []).filter((m) => m && m.source && m.source.ref === sourceId);
}

/**
 * Compute a Snapshot for every metric reading this source.
 *
 * @param {Object} opts
 * @param {Array}  opts.metrics   the metric defs reading this source
 * @param {Array<Record<string,any>>} opts.rows  already remapped
 * @param {Object} opts.source    the sources.json entry
 * @param {Object} [opts.org]     org.json, for the freshness config
 * @param {string} [opts.now]     ISO, injectable so a test is deterministic
 * @returns {{snapshots: Array, byId: Map, warnings: string[]}}
 */
export function computePreview({ metrics, rows, source, org, now }) {
  const at = now || new Date().toISOString();

  const envelope = {
    sourceRef: source ? source.id : null,
    columns: rows.length ? Object.keys(rows[0]) : [],
    rows,
    fetchedAt: at,
    status: rows.length ? 'ok' : 'empty'
  };

  // Ordered so a metric used as another's denominator is computed first.
  // Without this, "In POC as a fraction of open pipeline" silently loses its
  // denominator depending on catalogue order.
  let ordered;
  try {
    ordered = orderMetrics(metrics);
  } catch (err) {
    // A denominator cycle is a config fault, not a reason to show nothing.
    return { snapshots: [], byId: new Map(), warnings: [err.message] };
  }

  const raws = {};
  const snapshots = [];
  for (const def of ordered) {
    snapshots.push(computeSnapshot(def, envelope, {
      runId: 'preview',
      // No period: this is the whole file, and health() must not call the
      // number stale for sitting outside a week nobody asked for.
      periodStart: null,
      periodEnd: null,
      now: at,
      source,
      freshnessConfig: org && org.freshness,
      raws
    }));
  }

  const byId = new Map(snapshots.map((s) => [s.metricId, s]));
  const warnings = [...new Set(snapshots.flatMap((s) => s.warnings || []))];
  return { snapshots, byId, warnings };
}

/**
 * Synthetic cards, three rings at a time.
 *
 * The catalogue's own cards mix metrics from several sources, so they cannot be
 * reused here - a card would render two rings from this file and one from a
 * sheet nobody has connected, and the empty ring would read as a problem with
 * the upload. Grouping this source's own metrics in threes keeps every ring on
 * screen answerable by the file in hand.
 */
export function previewCards(metrics, source) {
  const cards = [];
  for (let i = 0; i < metrics.length; i += RINGS_PER_CARD) {
    const group = metrics.slice(i, i + RINGS_PER_CARD);
    cards.push({
      id: `preview-${source.id}-${i / RINGS_PER_CARD}`,
      title: cards.length === 0
        ? (source.label || source.id)
        : `${source.label || source.id} (${cards.length + 1})`,
      rings: group.map((m) => m.id),
      tiles: []
    });
  }
  return cards;
}

/**
 * The rings fill by animation on the dashboard, driven by a scroll observer
 * that does not exist on this page. So the final state is applied directly:
 * stroke-dasharray from data-dash, and the count-up's end value.
 *
 * Without this every ring renders at zero and the screen says the upload
 * produced nothing - which would be precisely the wrong lesson.
 */
export function settleRings(root) {
  root.querySelectorAll('.ar .fill').forEach((c) => {
    const dash = c.getAttribute('data-dash');
    if (dash) c.setAttribute('stroke-dasharray', dash);
  });
  root.querySelectorAll('.cnt').forEach((n) => {
    n.textContent = n.getAttribute('data-to') || '0';
  });
}

/** The glow filter the ring SVGs reference, emitted once per document. */
export function ensureRingDefs() {
  if (document.querySelector('svg.defs')) return;
  const holder = document.createElement('div');
  holder.innerHTML = ringDefs();
  const svg = holder.firstElementChild;
  if (svg) document.body.insertBefore(svg, document.body.firstChild);
}

/**
 * The whole block: heading, the honest scope sentence, the ring cards, and
 * whatever the engine complained about on the way.
 *
 * @param {HTMLElement} host
 * @param {Object} opts
 * @param {Object} opts.source
 * @param {import('./csv.js').ParsedCSV} opts.parsed
 * @param {Record<string,string|null>} opts.mapping
 * @param {Array}  opts.catalogMetrics  the full catalog.metrics
 * @param {Object} opts.org
 */
export function renderPreviewRings(host, { source, parsed, mapping, catalogMetrics, org }) {
  const metrics = metricsForSource(catalogMetrics, source.id);

  if (!metrics.length) {
    host.innerHTML = `<div class="sechead" style="margin:28px 0 10px"><h2>What this produces</h2></div>
      <div class="empty">
        <p class="empty-t">No metric reads this source yet</p>
        <p class="empty-n">The rows parsed fine, but nothing in config/catalog.json points at
        <code>${esc(source.id)}</code>, so there is no number to compute. Add a metric there, or pick
        a different source.</p>
      </div>`;
    return { snapshots: [], warnings: [] };
  }

  ensureRingDefs();

  const rows = remapRows(parsed, mapping);
  const { snapshots, byId, warnings } = computePreview({ metrics, rows, source, org });

  const cards = previewCards(metrics, source);
  const catalogLike = { metrics, cards };

  // How many actually produced a number. This is the line that tells somebody
  // their column map is wrong, so it is stated before the rings, not after.
  const got = snapshots.filter((s) => s.raw !== null && s.raw !== undefined).length;
  const missed = snapshots.length - got;

  const unmapped = Object.entries(mapping || {}).filter(([, v]) => !v).map(([k]) => k);

  host.innerHTML = `
    <div class="sechead" style="margin:28px 0 10px">
      <h2>What this produces</h2>
      <p>${got} of ${snapshots.length} metric${snapshots.length === 1 ? '' : 's'} came out with a number</p>
    </div>
    <p class="hint">Computed in this browser by the same engine the weekly run uses, over
    <b>every row in the file</b> - not filtered to a week. The dashboard filters to the review
    period using <code>${esc(source.date_column || 'the source date column')}</code>, so these
    figures are the whole export and will usually be larger.</p>
    ${missed ? `<div class="banner banner-warn" style="margin-top:14px"><b>${missed} metric${missed === 1 ? '' : 's'} came back empty.</b>
      That is nearly always a column that is not mapped, or a column whose cells are not numbers.
      ${unmapped.length ? `Still unmapped: ${esc(unmapped.join(', '))}.` : 'Check the map above.'}</div>` : ''}
    <div class="rings-preview">${cards.map((c) => ringCard(c, snapshots, null, catalogLike, org)).join('')}</div>
    ${warnings.length ? `
      <details class="warnbox" style="margin-top:16px">
        <summary>${warnings.length} thing${warnings.length === 1 ? '' : 's'} the engine wants to tell you</summary>
        <ul>${warnings.slice(0, 40).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
        ${warnings.length > 40 ? `<p class="hint">and ${warnings.length - 40} more</p>` : ''}
      </details>` : '<p class="hint" style="margin-top:14px">The engine raised no warnings on this file.</p>'}
  `;

  settleRings(host);
  return { snapshots, byId, warnings };
}

export default renderPreviewRings;
