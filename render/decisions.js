/**
 * The decision log, in two renderings off ONE data source.
 *
 *   decisionPages()  print-ready 16:9 landscape pages, white paper, one
 *                    decision per page, for the room and the PDF.
 *   decisionLedger() a compact dark block for the live dashboard, so the
 *                    founder sees the same open decisions next to the rings
 *                    that prove them.
 *
 * Nothing is deleted here. A decision changes status and keeps its history,
 * which is what makes "what did we decide in September" answerable.
 */

import { TERMINAL_STATUSES } from '../engine/types.js';
import { PRINT_CSS } from './theme.css.js';
import { esc, longDate, words } from './util.js';

export const OWNER_PLACEHOLDER = '[OWNER NEEDED]';
export const DATE_PLACEHOLDER = '[DATE NEEDED]';
export const UNVERIFIED_PLACEHOLDER = '[PREVIOUS STATE UNVERIFIED]';

/** No column on a printed page may run past this. Overflow gets its own page. */
export const COLUMN_WORD_LIMIT = 90;

const COLUMN_TITLES = ['CARRIED IN', 'DECIDED THIS MEETING', 'BEFORE NEXT REVIEW'];

function ownerOf(d) {
  return d.owner ? esc(d.owner) : OWNER_PLACEHOLDER;
}
function dueOf(d) {
  return d.dueDate ? esc(longDate(d.dueDate)) : DATE_PLACEHOLDER;
}

/** Latest event for a decision, by timestamp. */
function lastEvent(decisionId, events) {
  const mine = (events || []).filter(e => e.decisionId === decisionId);
  if (!mine.length) return null;
  return mine.slice().sort((a, b) => String(a.at).localeCompare(String(b.at))).pop();
}

/* ------------------------------------------------------------------ *
 * Column packing
 * ------------------------------------------------------------------ */

/** Split any single block that is already over budget, on word boundaries. */
function safeBlocks(blocks, limit) {
  const out = [];
  for (const b of blocks) {
    const text = String(b || '').trim();
    if (!text) continue;
    const w = words(text);
    if (w.length <= limit) { out.push(text); continue; }
    for (let i = 0; i < w.length; i += limit) {
      out.push(w.slice(i, i + limit).join(' '));
    }
  }
  return out;
}

/** Greedily pack a column's blocks into per-page groups under the word limit. */
function packColumn(blocks, limit = COLUMN_WORD_LIMIT) {
  const pages = [];
  let cur = [];
  let count = 0;
  for (const b of safeBlocks(blocks, limit)) {
    const w = words(b).length;
    if (cur.length && count + w > limit) { pages.push(cur); cur = []; count = 0; }
    cur.push(b);
    count += w;
  }
  if (cur.length) pages.push(cur);
  return pages.length ? pages : [[]];
}

/** The three columns' source content for one decision. */
function columnBlocks(d, events) {
  const ev = lastEvent(d.id, events);

  const carried = [];
  if (d.previousStateUnverified) carried.push(UNVERIFIED_PLACEHOLDER);
  if (d.carriedIn) carried.push(d.carriedIn);
  if (d.firstSeenMeeting) carried.push(`First seen: ${d.firstSeenMeeting}.`);

  const decided = [];
  if (d.evidence) decided.push(d.evidence);
  if (d.decided) decided.push(d.decided);
  if (ev && ev.reason) decided.push(`Why it moved: ${ev.reason}`);
  if (ev && ev.quote) decided.push(`“${ev.quote}”`);

  const next = [];
  if (d.beforeNextReview) next.push(d.beforeNextReview);
  next.push(`Owner: ${d.owner || OWNER_PLACEHOLDER}. Due: ${d.dueDate ? longDate(d.dueDate) : DATE_PLACEHOLDER}.`);
  if (d.reopenCondition) next.push(`Reopens if: ${d.reopenCondition}`);

  return [carried, decided, next];
}

/* ------------------------------------------------------------------ *
 * Print pages
 * ------------------------------------------------------------------ */

function headlineSize(headline) {
  // 34-44px, sentence case. Longer conclusions step down so a page never reflows.
  const n = String(headline || '').length;
  if (n > 70) return 34;
  if (n > 52) return 38;
  return 44;
}

function pageHtml({ d, idx, part, partCount, cols, pageNo, meta }) {
  const num = String(d.number ?? idx + 1).padStart(2, '0');
  const label = `DECISION ${num} / ${esc(String(d.domain || '').toUpperCase())}`
    + (partCount > 1 ? ` &middot; ${part + 1} OF ${partCount}` : '');
  const isLast = part === partCount - 1;

  const colsHtml = cols.map((blocks, i) => (
    `<div class="col">`
    + `<h2>${COLUMN_TITLES[i]}</h2>`
    + (blocks.length
      ? blocks.map(b => `<p>${esc(b)}</p>`).join('')
      : '<p class="empty">&mdash;</p>')
    + '</div>'
  )).join('');

  const strip = isLast && d.strip
    ? `<div class="strip"><p>${esc(d.strip)}</p></div>`
    : '';

  return (
    '<section class="page">'
    + '<div class="phead">'
    + `<span class="pid">${esc(meta.identity || '')}</span>`
    + `<span class="pdoc">${esc(meta.docLabel || '')}</span>`
    + `<span class="pno">${pageNo}</span>`
    + '</div>'
    + `<p class="dlabel">${label}</p>`
    + `<h1 class="dhead" style="font-size:${headlineSize(d.headline)}px">`
    + `${esc(d.headline)}${part > 0 ? ' <span class="cont">(continued)</span>' : ''}</h1>`
    + `<p class="dstatus">STATUS &middot; ${esc(d.status)} &nbsp;&bull;&nbsp; OWNER ${ownerOf(d)} &nbsp;&bull;&nbsp; DUE ${dueOf(d)}</p>`
    + `<div class="cols">${colsHtml}</div>`
    + strip
    + '<div class="pfoot">'
    + `<span>${esc(meta.prevDate || DATE_PLACEHOLDER)} &rarr; ${esc(meta.nextDate || DATE_PLACEHOLDER)}</span>`
    + `<span>${esc(meta.topic || '')}</span>`
    + '</div>'
    + '</section>'
  );
}

/**
 * decisionPages(decisions, events, meta) -> a complete, self-contained,
 * print-ready HTML document. 16:9 landscape, white paper, black type.
 *
 * meta: { identity, docLabel, topic, prevDate, nextDate, title }
 */
export function decisionPages(decisions, events, meta = {}) {
  const list = (decisions || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));

  let pageNo = 0;
  const pages = list.map((d, idx) => {
    const packed = columnBlocks(d, events).map(blocks => packColumn(blocks));
    const partCount = Math.max(...packed.map(p => p.length));
    const out = [];
    for (let part = 0; part < partCount; part++) {
      pageNo += 1;
      out.push(pageHtml({
        d, idx, part, partCount,
        cols: packed.map(p => p[part] || []),
        pageNo, meta
      }));
    }
    return out.join('');
  }).join('');

  const title = meta.title || meta.docLabel || 'Decision log';

  return '<!doctype html>\n'
    + '<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${esc(title)}</title>`
    + `<style>\n${PRINT_CSS}\n</style>`
    + '</head><body class="print">'
    + pages
    + '</body></html>\n';
}

/* ------------------------------------------------------------------ *
 * Dashboard ledger
 * ------------------------------------------------------------------ */

/**
 * decisionLedger(decisions, events, catalog) -> a dark section for the main
 * dashboard: every open decision, its status chip, its owner and deadline, and
 * the metrics that will prove it worked. Same objects the print log reads, so
 * the two can never disagree.
 */
export function decisionLedger(decisions, events, catalog) {
  const open = (decisions || [])
    .filter(d => !TERMINAL_STATUSES.includes(d.status))
    .sort((a, b) => (a.number || 0) - (b.number || 0));

  if (!open.length) return '';

  const labels = new Map(((catalog && catalog.metrics) || []).map(m => [m.id, m.label]));

  const rows = open.map(d => {
    const ev = lastEvent(d.id, events);
    const proof = (d.metricIds || []).map(id => labels.get(id) || id);
    return (
      '<article class="dec">'
      + '<div class="dec-top">'
      + `<span class="chip chip-${esc(String(d.status).toLowerCase())}">${esc(d.status)}</span>`
      + `<span class="dec-dom">${esc(d.domain)}</span>`
      + '</div>'
      + `<h3>${esc(d.headline)}</h3>`
      + `<p class="dec-meta">${ownerOf(d)} &middot; by ${dueOf(d)}`
      + (d.previousStateUnverified ? ` &middot; <span class="warnmark">${UNVERIFIED_PLACEHOLDER}</span>` : '')
      + '</p>'
      + (proof.length
        ? `<p class="dec-proof"><span class="k">Proved by</span> ${proof.map(p => `<em>${esc(p)}</em>`).join(', ')}</p>`
        : `<p class="dec-proof"><span class="k">Proved by</span> <em class="none">no ring yet</em></p>`)
      + (ev && ev.reason ? `<p class="dec-why">${esc(ev.reason)}</p>` : '')
      + '</article>'
    );
  }).join('');

  return (
    '<section id="decisions">'
    + '<div class="sechead"><h2>Decision log</h2>'
    + `<p>${open.length} open &mdash; and the rings that will prove each one.</p></div>`
    + `<section class="ledger">${rows}</section>`
    + '</section>'
  );
}
