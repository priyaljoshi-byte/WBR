/**
 * The activity rings.
 *
 * Geometry is copied from the reference cards and must not drift: a 164x164
 * canvas, radii 64 / 47 / 30, 13px round-capped strokes, rotated -90deg so the
 * arc starts at twelve o'clock. Each ring is two circles - a dim track at
 * stroke-opacity .16 and a bright fill whose stroke-dasharray the scroll script
 * swaps in from data-dash.
 *
 * Ring colour is POSITIONAL (outer red, middle lime, inner cyan) and never a
 * health signal. See engine/types.js.
 */

import { RING_COLORS, RING_RADII } from '../engine/types.js';

export const VIEWBOX = 164;
export const CENTER = 82;
export const STROKE_WIDTH = 13;

/**
 * Circumference of a ring. THE one number everything else is a fraction of.
 * r=64 -> 402.12, r=47 -> 295.31, r=30 -> 188.50.
 */
export function circumference(r) {
  return 2 * Math.PI * r;
}

/** Two decimals, the precision the reference emits. */
export function dashLen(n) {
  return circumference(n).toFixed(2);
}

/**
 * The glow filter. The reference repeats id="gl" inside every card's <svg>,
 * which is invalid HTML (duplicate ids). We emit it exactly ONCE per document,
 * in a zero-size <svg> at the top of <body>, and every ring references it with
 * filter="url(#gl)". Visually identical, structurally correct.
 */
export function ringDefs() {
  return '<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false">'
    + '<defs><filter id="gl" x="-60%" y="-60%" width="220%" height="220%">'
    + '<feGaussianBlur stdDeviation="5" result="b"/>'
    + '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>'
    + '</filter></defs></svg>';
}

/**
 * A ring with a normalized value of 0 still shows the round cap as a dot in the
 * reference, which emits "0.01" rather than "0.00". Keep that: a zero that is
 * visible is a zero someone argues about.
 */
function arc(normalized, c) {
  const n = (normalized === null || normalized === undefined || Number.isNaN(normalized))
    ? 0
    : Math.max(0, Math.min(100, normalized));
  const len = (n / 100) * c;
  return (len < 0.01 ? 0.01 : len).toFixed(2);
}

/**
 * ringSvg(snapshots) -> the <svg class="ar"> string.
 *
 * `snapshots` is 1-3 Snapshots in OUTER-to-INNER order. Radii are taken from
 * the start of RING_RADII for the count given, so a 2-ring card draws r=64 and
 * r=47. (The reference's "Revenue collected" card draws r=47/30 instead - an
 * inconsistency in the source document, not a rule. See the report.)
 */
export function ringSvg(snapshots) {
  const list = (snapshots || []).slice(0, RING_RADII.length);
  const radii = RING_RADII.slice(0, list.length);

  const circles = radii.map((r, i) => {
    const color = RING_COLORS[i];
    const c = circumference(r);
    const total = c.toFixed(2);
    const snap = list[i];
    const filled = arc(snap ? snap.normalized : null, c);
    return (
      `<circle cx="${CENTER}" cy="${CENTER}" r="${r}" fill="none" stroke="${color}"`
      + ` stroke-opacity=".16" stroke-width="${STROKE_WIDTH}"/>`
      + `<circle class="fill" cx="${CENTER}" cy="${CENTER}" r="${r}" fill="none" stroke="${color}"`
      + ` stroke-width="${STROKE_WIDTH}" stroke-linecap="round" filter="url(#gl)"`
      + ` stroke-dasharray="0 ${total}" data-dash="${filled} ${total}"`
      + ` transform="rotate(-90 ${CENTER} ${CENTER})"/>`
    );
  }).join('');

  return `<svg class="ar" width="${VIEWBOX}" height="${VIEWBOX}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}"`
    + ` role="img" aria-label="Activity rings">${circles}</svg>`;
}
