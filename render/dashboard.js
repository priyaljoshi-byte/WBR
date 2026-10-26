/**
 * The whole dashboard, as one self-contained HTML string.
 *
 * Nothing is fetched at view time: no <script src>, no <link>, no remote font,
 * no image. Everything the founder sees was frozen into Snapshots by the run,
 * which is why the page is instant and why last week's number cannot silently
 * change underneath it.
 */

import { RING_COLORS } from '../engine/types.js';
import { blockersSection } from './blockers.js';
import { ringCard } from './card.js';
import { decisionLedger } from './decisions.js';
import { flagCards, openFlagCount } from './flags.js';
import { ragSection } from './rag.js';
import { ringDefs } from './rings.js';
import { scoreboardSection } from './scoreboard.js';
import { DASHBOARD_CSS } from './theme.css.js';
import { byMetric, esc, metricDefs, periodOf } from './util.js';

/** Scroll-triggered ring fill and count-up, lifted from the reference. */
function animationScript(sectionIds) {
  return `
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* rings fill and numbers count when a card scrolls in */
const cards = [...document.querySelectorAll('.ring-card')];
function runCard(card){
  card.querySelectorAll('.fill').forEach((c,i) => {
    setTimeout(() => c.setAttribute('stroke-dasharray', c.dataset.dash), reduce ? 0 : i*120);
  });
  card.querySelectorAll('.cnt').forEach((el,i) => {
    const to = +el.dataset.to;
    if(reduce){ el.textContent = to; return; }
    const t0 = performance.now(), dur = 1150 + i*90;
    const step = now => {
      const p = Math.min(1, (now-t0)/dur);
      el.textContent = Math.round(to * (1 - Math.pow(1-p, 3.2)));
      if(p < 1) requestAnimationFrame(step);
    };
    setTimeout(() => requestAnimationFrame(step), i*120);
  });
}
const io = new IntersectionObserver((es, obs) => es.forEach(e => {
  if(e.isIntersecting){ runCard(e.target); obs.unobserve(e.target); }
}), {threshold:.35});
cards.forEach(c => io.observe(c));

/* nav highlight */
const secs = ${JSON.stringify(sectionIds)}.map(id => document.getElementById(id)).filter(Boolean);
const links = [...document.querySelectorAll('.nav a')];
const nio = new IntersectionObserver(es => {
  es.forEach(e => {
    if(!e.isIntersecting) return;
    links.forEach(a => a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + e.target.id)));
  });
}, {rootMargin:'-30% 0px -60% 0px'});
secs.forEach(s => nio.observe(s));
`;
}

function nav(sections, period, org, meta) {
  const dots = sections.map((s, i) =>
    `<i style="background:${RING_COLORS[i % RING_COLORS.length]}"></i>`
  ).join('');
  const links = sections.map(s =>
    `<li><a href="#${esc(s.id)}">${esc(s.label)}</a></li>`
  ).join('');
  const brand = `${org.company || 'ShopOS'} WBR`;
  const when = `${period.nav || ''}${org.review_group ? ' &middot; FOR ' + esc(String(org.review_group).toUpperCase()) : ''}`;
  return (
    '<nav class="nav">'
    + `<div class="brand"><span class="dot3">${dots}</span><span>${esc(brand)}</span></div>`
    + `<ul>${links}</ul>`
    + `<div class="when">${when}</div>`
    + '</nav>'
  );
}

function masthead(period, meta, org) {
  const title = meta.title || 'Weekly business review';
  const kicker = meta.kicker || `&middot; ${(meta.sectionCount || 3)} levers`;
  const standfirst = meta.standfirst || '';
  return (
    '<div class="mast"><div>'
    + `<h1>${esc(title)} <span>${kicker}</span></h1>`
    + (standfirst ? `<p>${standfirst}</p>` : '')
    + `<p class="runline">${period.range || ''}${meta.runLabel ? ' &middot; ' + esc(meta.runLabel) : ''}</p>`
    + '</div></div>'
  );
}

function cardSection({ id, label, blurb, index, cards, snapshots, notesById, catalog, org }) {
  if (!cards.length) return '';
  const num = String(index + 1).padStart(2, '0');
  return (
    `<section id="${esc(id)}">`
    + `<div class="sechead"><h2><span class="lvln">${num}</span>${esc(label)}</h2>`
    + `<p>${esc(blurb || '')}</p></div>`
    + '<section class="rings">'
    + cards.map(c => ringCard(c, snapshots, notesById.get(c.id), catalog, org)).join('')
    + '</section>'
    + '</section>'
  );
}

/** "growth" -> "Growth". Only used for cards pointing at a section org.json lost. */
function titleCase(id) {
  return String(id).replace(/[-_]/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function footerHtml({ run, snapshots, flags, catalog, org, meta }) {
  const snaps = [...byMetric(snapshots).values()];
  const defs = metricDefs(catalog);

  const warned = snaps.filter(s => s.warnings && s.warnings.length);
  const warnLine = warned.length
    ? 'Carrying warnings this run: '
      + warned.map(s => {
        const d = defs.get(s.metricId);
        return `<b>${esc(d ? d.label : s.metricId)}</b> (${esc(s.warnings.join('; '))})`;
      }).join(' &middot; ')
      + '.'
    : 'No metric carried a warning this run.';

  const sourceNames = [...new Set(snaps.map(s => {
    const d = defs.get(s.metricId);
    return d && d.source ? d.source.ref : null;
  }).filter(Boolean))];

  const open = openFlagCount(flags);

  return (
    '<footer>'
    + `Rendered from run <b>${esc(run && run.id ? run.id : 'unknown')}</b>`
    + `, period ${esc(run ? run.periodStart : '')} to ${esc(run ? run.periodEnd : '')}`
    + `, status ${esc(run ? run.status : 'unknown')}.`
    + (sourceNames.length ? ` Sources: ${sourceNames.map(s => esc(s)).join(', ')}.` : '')
    + (meta.provenance ? ` ${meta.provenance}` : '')
    + '<br>'
    + 'Ring values are normalised to 100 and each carries its own denominator &mdash; '
    + 'the caption under every ring states what it is a fraction of. '
    + 'Nothing on this page is recomputed at view time; every number is a frozen snapshot.'
    + '<br>'
    + warnLine
    + (open
      ? ` ${open} item${open === 1 ? ' is' : 's are'} still outstanding under &ldquo;Still need from&rdquo; &mdash; nothing there has shipped as a verified number yet.`
      : '')
    + '</footer>'
  );
}

/**
 * renderDashboard({ run, snapshots, flags, decisions, events, notes, catalog,
 *                   org, meta }) -> complete HTML document string.
 */
export function renderDashboard({
  run, snapshots = [], flags = [], decisions = [], events = [],
  notes = [], blockers = [], scoreboard = [], dependencyMatrix = null,
  rag = null, catalog = {}, org = {}, meeting = null, meta = {}
} = {}) {
  const period = run
    ? periodOf(run.periodStart, run.periodEnd)
    : periodOf(null, null);

  // Each room reads the sections its charter gives it, in org.json's agenda
  // order. Monday's hiring review has no decisions section on purpose: hiring
  // decisions are headcount-and-capital tradeoffs made where the money is, and
  // printing an empty ledger there would teach the room to scroll past it.
  const allowed = meeting && Array.isArray(meeting.sections) && meeting.sections.length
    ? new Set(meeting.sections)
    : null;

  const sections = ((org.sections) || [])
    .filter(s => !allowed || allowed.has(s.id) || allowed.has(s.kind))
    .slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const cards = (catalog.cards) || [];
  const notesById = new Map((notes || []).map(n => [n.cardId, n]));

  const ledger = decisionLedger(decisions, events, catalog);
  const board = scoreboardSection(scoreboard, org);
  const blocks = blockersSection(blockers, dependencyMatrix, org, catalog);
  const calls = ragSection(rag, org);

  const cardsFor = id => cards
    .filter(c => c.section === id)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  // org.json's section kinds decide the agenda order. Each kind knows its own
  // renderer; a kind with nothing to show prints nothing rather than an empty
  // heading, because an empty heading in a meeting doc reads as a mistake.
  const RENDERERS = {
    scoreboard: () => board,
    decisions: () => ledger,
    blockers: () => blocks,
    rag: () => calls
  };

  let index = 0;
  const placed = new Set();
  const parts = [];

  for (const s of sections) {
    const special = RENDERERS[s.kind];
    if (special) {
      const html = special();
      if (html) { parts.push(html); placed.add(s.kind); index += 1; }
      continue;
    }
    const mine = cardsFor(s.id);
    if (!mine.length) continue;
    parts.push(cardSection({
      id: s.id, label: s.label, blurb: s.blurb, index, cards: mine, snapshots, notesById, catalog, org
    }));
    index += 1;
  }

  // A card whose section id is not in org.json still renders, under its own
  // heading. Config drift should be visible, never silently drop a card.
  const known = new Set(sections.map(s => s.id));
  const orphanIds = [...new Set(cards.map(c => c.section).filter(id => !known.has(id)))];
  for (const id of orphanIds) {
    parts.push(cardSection({
      id, label: titleCase(id), blurb: '', index, cards: cardsFor(id), snapshots, notesById, catalog, org
    }));
    index += 1;
  }

  // Anything org.json gave no slot to still has to appear somewhere - unless
  // this meeting's charter deliberately left it out. "No slot" and "not in this
  // room" are different facts and only the first is a config accident.
  const allows = kind => !allowed || allowed.has(kind);
  if (!placed.has('scoreboard') && board && allows('scoreboard')) parts.unshift(board);
  if (!placed.has('rag') && calls && allows('rag')) parts.push(calls);
  if (!placed.has('blockers') && blocks && allows('blockers')) parts.push(blocks);
  if (!placed.has('decisions') && ledger && allows('decisions')) parts.push(ledger);

  const body = parts.join('');

  const navSections = [];
  for (const s of sections) {
    const special = RENDERERS[s.kind];
    if (special ? special() : cardsFor(s.id).length) {
      navSections.push({ id: s.id, label: s.label });
    }
  }
  for (const id of orphanIds) navSections.push({ id, label: titleCase(id) });
  for (const [kind, html, id, label] of [
    ['scoreboard', board, 'scoreboard', 'Scoreboard'],
    ['rag', calls, 'rag', 'Status calls'],
    ['blockers', blocks, 'blockers', 'Blockers'],
    ['decisions', ledger, 'decisions', 'Decisions']
  ]) {
    if (html && allows(kind) && !placed.has(kind) && !navSections.some(s => s.id === id)) {
      navSections.push({ id, label });
    }
  }

  const title = meta.docTitle
    || `${org.company || 'ShopOS'} WBR &middot; ${period.range || ''}`;

  return '<!doctype html>\n'
    + '<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${title.replace(/&middot;/g, '-').replace(/&ndash;/g, '-')}</title>`
    + `<style>${DASHBOARD_CSS}</style>`
    + '</head><body>'
    + (meta.fixtureBanner
      ? `<div class="fixture"><b>FORMAT FIXTURE</b> &middot; ${meta.fixtureBanner}</div>`
      : '')
    + nav(navSections, period, org, meta)
    + ringDefs()
    + '<div class="wrap">'
    + masthead(period, { ...meta, sectionCount: navSections.length }, org)
    + body
    + flagCards(flags, org)
    + footerHtml({ run, snapshots, flags, catalog, org, meta })
    + '</div>'
    + `<script>${animationScript(navSections.map(s => s.id))}</script>`
    + '</body></html>\n';
}
