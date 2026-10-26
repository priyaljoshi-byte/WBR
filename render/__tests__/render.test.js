/**
 * Renderer tests. These guard the things that are expensive to notice late:
 * ring geometry, the single #gl filter, health-to-flag mapping, the decision
 * placeholders, and the promise that the output is one self-contained file.
 *
 * Run with: node --test
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { rollupRag } from '../../engine/rag.js';
import { RING_RADII } from '../../engine/types.js';
import { ringCard } from '../card.js';
import { renderDashboard } from '../dashboard.js';
import { decisionLedger, decisionPages } from '../decisions.js';
import { blockersSection } from '../blockers.js';
import { flagCards } from '../flags.js';
import { scoreboardSection } from '../scoreboard.js';
import { circumference, ringSvg } from '../rings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(readFileSync(resolve(ROOT, 'config/catalog.json'), 'utf8'));
const org = JSON.parse(readFileSync(resolve(ROOT, 'config/org.json'), 'utf8'));

const PERIOD = { periodStart: '2026-09-01', periodEnd: '2026-09-07' };

function snap(metricId, normalized, health = 'good', extra = {}) {
  return {
    runId: 'run-test', metricId, ...PERIOD,
    raw: 1, denominator: 1, normalized,
    priorRaw: null, priorNormalized: null, delta: null,
    health, caption: `${metricId} caption`, rowCount: 1,
    computedAt: '2026-09-07T20:00:00+05:30', warnings: [], ...extra
  };
}

const CARD_3 = catalog.cards.find(c => c.rings.length === 3);
const CARD_2 = catalog.cards.find(c => c.rings.length === 2);

/* ---------------------------------------------------------------- */

test('circumference is 2*PI*r for all three reference radii', () => {
  assert.deepEqual(RING_RADII, [64, 47, 30]);
  assert.equal(circumference(64).toFixed(2), '402.12');
  assert.equal(circumference(47).toFixed(2), '295.31');
  assert.equal(circumference(30).toFixed(2), '188.50');
  for (const r of RING_RADII) {
    assert.equal(circumference(r), 2 * Math.PI * r);
  }
});

test('a normalized value of 80 produces data-dash starting 321.70', () => {
  const svg = ringSvg([snap('channels_live', 80)]);
  const m = svg.match(/data-dash="([^"]+)"/);
  assert.ok(m, 'expected a data-dash attribute');
  assert.ok(m[1].startsWith('321.70'), `got ${m[1]}`);
  assert.equal(m[1], '321.70 402.12');
  // the track is empty until the script swaps it in
  assert.ok(svg.includes('stroke-dasharray="0 402.12"'));
});

test('a ring at 0 still shows its cap, as in the reference', () => {
  const svg = ringSvg([snap('qualified_leads', 0)]);
  assert.ok(svg.includes('data-dash="0.01 402.12"'), svg);
});

test('a 3-ring card emits exactly 3 fill circles', () => {
  const snaps = CARD_3.rings.map((id, i) => snap(id, 40 + i * 10));
  const html = ringCard(CARD_3, snaps, null, catalog);
  assert.equal((html.match(/class="fill"/g) || []).length, 3);
  // ...and three tracks alongside them
  assert.equal((html.match(/stroke-opacity="\.16"/g) || []).length, 3);
});

test('a 2-ring card takes the first two radii', () => {
  const snaps = CARD_2.rings.map(id => snap(id, 50));
  const html = ringCard(CARD_2, snaps, null, catalog);
  assert.equal((html.match(/class="fill"/g) || []).length, 2);
  assert.ok(html.includes('r="64"'));
  assert.ok(html.includes('r="47"'));
  assert.ok(!html.includes('r="30"'));
});

test('the gl filter appears exactly once in a full document', () => {
  const snapshots = catalog.metrics.map((m, i) => snap(m.id, (i * 7) % 101));
  const html = renderDashboard({
    run: { id: 'run-test', ...PERIOD, status: 'ok', triggeredBy: 'manual' },
    snapshots, flags: [], decisions: [], events: [], notes: [], catalog, org, meta: {}
  });
  assert.equal((html.match(/id="gl"/g) || []).length, 1);
  // every ring still points at it
  assert.ok((html.match(/filter="url\(#gl\)"/g) || []).length > 10);
});

test('a crit card gets .flag and a good card does not', () => {
  const bad = ringCard(
    CARD_3, CARD_3.rings.map((id, i) => snap(id, 10, i === 1 ? 'crit' : 'good')), null, catalog
  );
  assert.ok(bad.includes('class="ring-card flag"'), bad.slice(0, 120));
  assert.ok(bad.includes('hbadge'));

  const good = ringCard(
    CARD_3, CARD_3.rings.map(id => snap(id, 90, 'good')), null, catalog
  );
  assert.ok(good.includes('class="ring-card"'));
  assert.ok(!good.includes('flag'));
  assert.ok(!good.includes('hbadge'));
});

test('a stale card is flagged, a warn card is not', () => {
  const stale = ringCard(CARD_3, CARD_3.rings.map(id => snap(id, 50, 'stale')), null, catalog);
  assert.ok(stale.includes('ring-card flag'));
  const warn = ringCard(CARD_3, CARD_3.rings.map(id => snap(id, 50, 'warn')), null, catalog);
  assert.ok(!warn.includes('flag'));
});

test('ring colour is positional, never health-coded', () => {
  const html = ringCard(CARD_3, CARD_3.rings.map(id => snap(id, 20, 'crit')), null, catalog);
  assert.ok(html.includes('stroke="#ff375f"'));
  assert.ok(html.includes('stroke="#c6f432"'));
  assert.ok(html.includes('stroke="#3ddbff"'));
});

test('subtitle templates resolve the period against the snapshots', () => {
  // sloosh-funnel is "{{period.range}}" in the shipped catalogue; fall back to
  // any card whose subtitle uses period.range so this does not re-break when
  // the catalogue is re-cut.
  const card = catalog.cards.find(c => /\{\{\s*period\.range\s*\}\}/.test(c.subtitle || ''));
  assert.ok(card, 'expected at least one card with a {{period.range}} subtitle');
  const html = ringCard(card, card.rings.map(id => snap(id, 50)), null, catalog);
  assert.ok(!html.includes('{{'), 'unresolved template token left in output');
  assert.ok(html.includes('1&ndash;7 Sept 2026'), html);
});

test('subtitle templates resolve a metric caption', () => {
  const card = catalog.cards.find(c => /\{\{\s*\w+\.caption\s*\}\}/.test(c.subtitle || ''));
  if (!card) return; // nothing in this catalogue uses the form
  const metricId = card.subtitle.match(/\{\{\s*(\w+)\.caption\s*\}\}/)[1];
  const snaps = [
    ...card.rings.map(id => snap(id, 50)),
    { ...snap(metricId, 50), caption: '₹4.47 Cr open' }
  ];
  const html = ringCard(card, snaps, null, catalog);
  assert.ok(!html.includes('{{'), 'unresolved template token left in output');
  assert.ok(html.includes('₹4.47 Cr open'), html.slice(0, 400));
});

/* ---------------------------------------------------------------- */

const PROVING_METRIC = catalog.metrics[0];

const baseDecision = {
  id: 'd1', number: 1, domain: 'Product',
  headline: 'Self-serve becomes a feed.',
  status: 'OPEN',
  carriedIn: 'Previously a form.',
  evidence: 'The drop is at checkout.',
  decided: 'Build the feed.',
  beforeNextReview: 'Ship it behind a flag.',
  strip: 'Handcraft once, generalise after.',
  owner: null, dueDate: null,
  reopenCondition: 'It does not beat baseline.',
  // Any metric that is actually in the shipped catalogue, so the ledger can
  // resolve it to a label rather than falling back to the id.
  metricIds: [PROVING_METRIC.id],
  firstSeenMeeting: 'wbr-1', lastTouchedMeeting: 'wbr-2',
  previousStateUnverified: true
};

test('[OWNER NEEDED] appears when owner is null', () => {
  const html = decisionPages([baseDecision], [], { identity: 'x', docLabel: 'y' });
  assert.ok(html.includes('[OWNER NEEDED]'));
  assert.ok(html.includes('[DATE NEEDED]'));
  assert.ok(html.includes('[PREVIOUS STATE UNVERIFIED]'));

  const owned = { ...baseDecision, owner: 'Karan', dueDate: '2026-09-29', previousStateUnverified: false };
  const ok = decisionPages([owned], [], { prevDate: '25 Aug 2026', nextDate: '15 Sept 2026' });
  assert.ok(!ok.includes('[OWNER NEEDED]'));
  assert.ok(!ok.includes('[DATE NEEDED]'));
  assert.ok(!ok.includes('[PREVIOUS STATE UNVERIFIED]'));
  assert.ok(ok.includes('29 Sept 2026'));
});

test('the print log carries its page geometry and print rules', () => {
  const html = decisionPages([baseDecision], [], { topic: 'Feed', prevDate: 'A', nextDate: 'B' });
  assert.ok(html.includes('@page { size: 13.333in 7.5in; margin: 0; }'));
  assert.ok(html.includes('page-break-before:always'));
  assert.ok(html.includes('print-color-adjust:exact'));
  assert.ok(html.includes('break-inside:avoid'));
  assert.ok(html.includes('CARRIED IN'));
  assert.ok(html.includes('DECIDED THIS MEETING'));
  assert.ok(html.includes('BEFORE NEXT REVIEW'));
  assert.ok(html.includes('DECISION 01 / PRODUCT'));
  assert.ok(html.includes('A &rarr; B'));
});

test('a column over 90 words continues onto another page', () => {
  const long = { ...baseDecision, carriedIn: Array.from({ length: 240 }, (_, i) => `word${i}`).join(' ') };
  const html = decisionPages([long], [], {});
  const pages = (html.match(/class="page"/g) || []).length;
  assert.ok(pages >= 3, `expected continuation pages, got ${pages}`);
  assert.ok(html.includes('(continued)'));
  // the strip rides on the final page only
  assert.equal((html.match(/class="strip"/g) || []).length, 1);
});

test('the ledger lists open decisions with status chips and proving metrics', () => {
  const html = decisionLedger(
    [baseDecision, { ...baseDecision, id: 'd2', number: 2, status: 'COMPLETED' }],
    [], catalog
  );
  assert.ok(html.includes('chip-open'));
  assert.ok(!html.includes('chip-completed'), 'terminal decisions should not appear');
  assert.equal((html.match(/class="dec"/g) || []).length, 1);
  assert.ok(html.includes(PROVING_METRIC.label), 'metric label, not id');
  assert.ok(!html.includes(`<em>${PROVING_METRIC.id}</em>`), 'id leaked instead of label');
});

/* ---------------------------------------------------------------- */

test('flag cards group by owner and tag each one', () => {
  const html = flagCards([
    { id: 'f1', dept: 'marketing', owner: 'Sai', kind: 'manual', title: 'The event', body: 'b', resolvedAt: null },
    { id: 'f2', dept: 'marketing', owner: 'Sai', kind: 'missing_data', title: 'Linear', body: 'b', resolvedAt: null },
    { id: 'f3', dept: 'finance', owner: 'Manish', kind: 'off_target', title: 'Collection', body: 'b', resolvedAt: null },
    { id: 'f4', dept: 'finance', owner: 'Manish', kind: 'manual', title: 'Done', body: 'b', resolvedAt: '2026-09-02' }
  ], org);
  assert.ok(html.includes('Still need from Sai'));
  assert.ok(html.includes('Still need from Manish'));
  assert.ok(html.includes('Sai &middot; add this'));
  assert.equal((html.match(/class="card flag"/g) || []).length, 3, 'resolved flags are dropped');
  assert.equal(flagCards([], org), '');
});

/* ---------------------------------------------------------------- */

function fullDoc() {
  const snapshots = catalog.metrics.map((m, i) => snap(m.id, (i * 11) % 101));
  return renderDashboard({
    run: { id: 'run-test', ...PERIOD, status: 'ok', triggeredBy: 'manual' },
    snapshots,
    flags: [{ id: 'f1', dept: 'marketing', owner: 'Sai', kind: 'manual', title: 'T', body: 'B', resolvedAt: null }],
    decisions: [baseDecision], events: [], notes: [{ cardId: catalog.cards[0].id, text: 'the human read', meetingId: 'm' }],
    catalog, org, meta: {}
  });
}

test('the document is self-contained: no script src, no external link', () => {
  for (const html of [fullDoc(), decisionPages([baseDecision], [], {})]) {
    assert.ok(!/<script\s[^>]*src=/i.test(html), 'found an external script');
    assert.ok(!/<link\b/i.test(html), 'found a <link> element');
    assert.ok(!/@import/i.test(html), 'found a CSS @import');
    assert.ok(!/<img\b/i.test(html), 'found an external image');
    assert.ok(!/url\(\s*['"]?https?:/i.test(html), 'found a remote CSS url()');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.trimEnd().endsWith('</html>'));
  }
});

test('every card renders, inside a section, in catalog order', () => {
  const html = fullDoc();

  const bySection = new Map();
  for (const c of catalog.cards) {
    if (!bySection.has(c.section)) bySection.set(c.section, []);
    bySection.get(c.section).push(c);
  }

  for (const [sectionId, list] of bySection) {
    assert.ok(html.includes(`<section id="${sectionId}">`), `missing section ${sectionId}`);
    let cursor = -1;
    for (const c of list.slice().sort((a, b) => (a.order || 0) - (b.order || 0))) {
      const at = html.indexOf(`id="card-${c.id}"`);
      assert.ok(at > cursor, `card ${c.id} missing or out of order`);
      cursor = at;
    }
  }

  assert.ok(html.includes('<nav class="nav">'));
  assert.ok(html.includes('class="dot3"'));
  assert.ok(html.includes('IntersectionObserver'));
  assert.ok(html.includes('prefers-reduced-motion'));
});

test('org.json sections that have cards render in their configured order', () => {
  const localOrg = {
    company: 'ShopOS',
    sections: [
      { id: 'b', label: 'Bee', order: 2 },
      { id: 'a', label: 'Ay', order: 1 },
      { id: 'empty', label: 'Empty', order: 3 }
    ]
  };
  const localCatalog = {
    cards: [
      { id: 'c-a', title: 'A card', section: 'a', order: 1, rings: ['m1'], tiles: [] },
      { id: 'c-b', title: 'B card', section: 'b', order: 1, rings: ['m1'], tiles: [] },
      { id: 'c-x', title: 'Orphan', section: 'nowhere', order: 1, rings: ['m1'], tiles: [] }
    ],
    metrics: [{ id: 'm1', label: 'M one', unit: 'count', target: null }]
  };
  const html = renderDashboard({
    run: { id: 'r', ...PERIOD, status: 'ok' },
    snapshots: [snap('m1', 50)], catalog: localCatalog, org: localOrg
  });
  assert.ok(html.indexOf('<section id="a">') < html.indexOf('<section id="b">'));
  assert.ok(!html.includes('<section id="empty">'), 'a section with no cards is skipped');
  assert.ok(html.includes('<section id="nowhere">'), 'an orphan card still renders');
  assert.ok(html.includes('Nowhere'), 'orphan section gets a readable heading');
});

test('a decisions-kind section hosts the ledger in place, exactly once', () => {
  const localOrg = {
    company: 'ShopOS',
    sections: [
      { id: 'lines', label: 'Lines', order: 1, kind: 'cards' },
      { id: 'decisions', label: 'Decisions', order: 2, kind: 'decisions' },
      { id: 'blockers', label: 'Blockers', order: 3, kind: 'blockers' }
    ]
  };
  const html = renderDashboard({
    run: { id: 'r', ...PERIOD, status: 'ok' },
    snapshots: catalog.metrics.map(m => snap(m.id, 50)),
    decisions: [baseDecision], catalog, org: localOrg
  });
  assert.equal((html.match(/<section id="decisions">/g) || []).length, 1);
  assert.ok(!html.includes('<section id="blockers">'), 'no renderer yet, so no empty heading');
});

test('a rag-kind section hosts the status calls in the agenda slot org.json gives it', () => {
  const localOrg = {
    company: 'ShopOS',
    departments: [{ id: 'perf_marketing', label: 'Performance Marketing' }],
    owners: { perf_marketing: { name: 'Ankit' } },
    sections: [
      { id: 'lines', label: 'Lines', order: 1, kind: 'cards' },
      { id: 'rag', label: 'Status by track', order: 2, kind: 'rag' },
      { id: 'decisions', label: 'Decisions', order: 3, kind: 'decisions' }
    ]
  };
  const rag = rollupRag([{
    subject: 'Kiara', dept: 'perf_marketing', status: 'red',
    reason: 'ROAS under 1.4 since the creative refresh',
    setBy: 'Ankit', setAt: '2026-09-07T09:00:00.000Z', periodStart: '2026-09-07'
  }], { now: '2026-09-07T18:00:00.000Z' });

  const html = renderDashboard({
    run: { id: 'r', ...PERIOD, status: 'ok' },
    snapshots: catalog.metrics.map(m => snap(m.id, 50)),
    rag, catalog, org: localOrg
  });

  assert.equal((html.match(/<section id="rag">/g) || []).length, 1, 'rendered once, in its slot');
  assert.ok(html.indexOf('<section id="lines">') < html.indexOf('<section id="rag">'));
  assert.ok(html.includes('daily stand-up judgement'));
  assert.ok(html.includes('Status by track'), 'the nav and heading use org.json\'s label');

  // the CSS the section needs ships in the same file - no external stylesheet
  assert.ok(html.includes('.rgrow-red'), 'the rail colour is in the inlined CSS');
  assert.ok(html.includes('.rg-d.rg-none'), 'and so is the uncalled-day hatch');
});

test('a dashboard with no status calls renders no rag section and no empty heading', () => {
  const html = renderDashboard({
    run: { id: 'r', ...PERIOD, status: 'ok' },
    snapshots: catalog.metrics.map(m => snap(m.id, 50)),
    rag: rollupRag([], { now: '2026-09-07T18:00:00.000Z' }),
    catalog, org
  });
  assert.ok(!html.includes('<section id="rag">'));
  assert.ok(!html.includes('daily stand-up judgement'));
});

test('the footer states provenance, normalisation and any warnings', () => {
  const WARNED = catalog.metrics[0];
  const snapshots = catalog.metrics.map(m => snap(m.id, 50, 'good',
    m.id === WARNED.id ? { warnings: ['source lagged a day'] } : {}));
  const html = renderDashboard({
    run: { id: 'run-test', ...PERIOD, status: 'partial', triggeredBy: 'cron' },
    snapshots, flags: [], decisions: [], events: [], notes: [], catalog, org, meta: {}
  });
  assert.ok(html.includes('normalised to 100'));
  assert.ok(html.includes('its own denominator'));
  assert.ok(html.includes('run-test'));
  assert.ok(html.includes('source lagged a day'));
  assert.ok(html.includes(WARNED.label), 'the warning names the metric');
});

/* ---------------------------------------------------------------- *
 * Scoreboard
 * ---------------------------------------------------------------- */

const SCORE_ROWS = [
  {
    deptId: 'india_sales', onTarget: 3, totalJudged: 4,
    byHealth: { good: 3, warn: 1, crit: 0, stale: 0, missing: 0, untracked: 2 },
    worstMetric: { id: 'india_opps_created', label: 'Opportunities created', health: 'warn' },
    netDelta: 12, freshness: 'daily'
  },
  {
    deptId: 'us_sales', onTarget: 0, totalJudged: 3,
    byHealth: { good: 0, warn: 1, crit: 2, stale: 0, missing: 0, untracked: 3 },
    worstMetric: { id: 'us_opps_created', label: 'Opportunities created', health: 'crit' },
    netDelta: -22, freshness: 'last_minute'
  },
  {
    deptId: 'hiring', onTarget: 0, totalJudged: 0,
    byHealth: { good: 0, warn: 0, crit: 0, stale: 4, missing: 0, untracked: 2 },
    worstMetric: { id: 'hiring_joined', label: 'Joined', health: 'stale' },
    netDelta: null, freshness: 'stale'
  }
];

test('the scoreboard answers the target question per line of business', () => {
  const html = scoreboardSection(SCORE_ROWS, org);
  assert.ok(html.includes('3</b><em>of 4 on target'), 'the fraction is the headline number');
  assert.ok(html.includes('India Sales'));
  assert.ok(html.includes('US Sales'));
  assert.ok(html.includes('Opportunities created'), 'the worst metric is named');
  assert.equal(scoreboardSection([], org), '', 'no rows, no section');
});

test('the scoreboard flags any department carrying crit, stale or missing', () => {
  const html = scoreboardSection(SCORE_ROWS, org);
  assert.equal((html.match(/srow-flag/g) || []).length, 2, 'us_sales and hiring, not india_sales');
});

test('the scoreboard renders departments in org.json order', () => {
  const html = scoreboardSection(SCORE_ROWS.slice().reverse(), org);
  assert.ok(html.indexOf('India Sales') < html.indexOf('US Sales'));
  assert.ok(html.indexOf('US Sales') < html.indexOf('Hiring'));
});

test('an unowned department is named [OWNER NEEDED] on the scoreboard', () => {
  // A blank here would read as "fine"; it is the opposite, and the placeholder
  // exists so it cannot be skimmed past. Tested against a FIXTURE department
  // rather than whichever real one happens to be unowned today - this used to
  // point at perf_marketing and broke the day it was given owners.
  const orgWithGap = {
    ...org,
    departments: [...org.departments, { id: 'ghost_line', label: 'Ghost Line' }],
    owners: { ...org.owners, ghost_line: { team: [], lead: null } }
  };
  const unowned = {
    deptId: 'ghost_line', onTarget: 0, totalJudged: 0,
    byHealth: { good: 0, warn: 0, crit: 0, stale: 0, missing: 0, untracked: 6 },
    worstMetric: null, netDelta: null, freshness: 'weekly'
  };
  const html = scoreboardSection([...SCORE_ROWS, unowned], orgWithGap);
  assert.ok(html.includes('[OWNER NEEDED]'), 'a department with an empty trio must say so');
});

test('the scoreboard names the whole trio, because the line of business is theirs', () => {
  const html = scoreboardSection(SCORE_ROWS, org);
  // org.json gives three names per line of business. The scoreboard shows all
  // three; a FLAG names one of them. Both are in the founder's two goals -
  // visibility here, accountability there - and collapsing either into the
  // other loses one of them.
  assert.ok(html.includes('Subham, Arfin and Raghav'), 'India Sales is owned by three people');
  assert.ok(html.includes('Anupreet, Karan and Raghav'));
  assert.ok(html.includes('Satwik, Omer and Rishi'));
});

test('week on week reads as a direction, and absent prior data says so', () => {
  const html = scoreboardSection(SCORE_ROWS, org);
  assert.ok(html.includes('sdelta-up'));
  assert.ok(html.includes('sdelta-down'));
  assert.ok(html.includes('sdelta-none'), 'null netDelta must not render as zero');
  assert.ok(!html.includes('&uarr; 0'));
});

test('nothing judged renders as a dash, never as zero on target', () => {
  const html = scoreboardSection([SCORE_ROWS[2]], org);
  assert.ok(html.includes('nothing judged yet'));
  assert.ok(!html.includes('<b>0</b>'), '0 of 0 would read as a failure, not an absence');
});

/* ---------------------------------------------------------------- *
 * Freshness
 * ---------------------------------------------------------------- */

test('freshness is labelled on the card, and only shouts when it should', () => {
  const quiet = ringCard(CARD_3, CARD_3.rings.map(id =>
    ({ ...snap(id, 60, 'good'), freshness: 'daily' })), null, catalog, org);
  assert.ok(quiet.includes('class="fresh"'), 'daily is still stated');
  assert.ok(!quiet.includes('fresh-loud'), 'daily is the expected state and must stay quiet');

  const loud = ringCard(CARD_3, CARD_3.rings.map(id =>
    ({ ...snap(id, 60, 'good'), freshness: 'last_minute' })), null, catalog, org);
  assert.ok(loud.includes('fresh-loud'));
  assert.ok(loud.includes('assembled for this meeting'));
});

test('a card is only as fresh as its least fresh ring', () => {
  const snaps = CARD_3.rings.map((id, i) =>
    ({ ...snap(id, 60, 'good'), freshness: i === 2 ? 'stale' : 'daily' }));
  const html = ringCard(CARD_3, snaps, null, catalog, org);
  assert.ok(html.includes('not updated this period'));
  assert.ok(!html.includes('>daily<'));
});

test('org.json can switch the freshness badge off', () => {
  const snaps = CARD_3.rings.map(id => ({ ...snap(id, 60, 'good'), freshness: 'last_minute' }));
  const off = { ...org, freshness: { ...(org.freshness || {}), show_on_card: false } };
  assert.ok(!ringCard(CARD_3, snaps, null, catalog, off).includes('class="fresh'));
});

/* ---------------------------------------------------------------- *
 * Blockers
 * ---------------------------------------------------------------- */

const BLOCKERS = [
  {
    id: 'b-old', title: 'US CRM has no owner', raisedBy: 'us_sales', needsFrom: 'sloosh',
    what: 'A read-only connection.', impact: 'Every US number is typed by hand.',
    metricIds: [], raisedAt: '2026-08-11', ageWeeks: 4, status: 'open',
    owner: null, dueDate: null, resolution: ''
  },
  {
    id: 'b-new', title: 'Campaign id missing on deals', raisedBy: 'perf_marketing',
    needsFrom: 'india_sales', what: 'The id written at creation.', impact: 'CAC is an estimate.',
    metricIds: [], raisedAt: '2026-09-01', ageWeeks: 1, status: 'open',
    owner: 'Someone', dueDate: '2026-09-19', resolution: ''
  },
  {
    id: 'b-done', title: 'Already settled', raisedBy: 'sloosh', needsFrom: 'hiring',
    what: 'x', impact: 'y', metricIds: [], raisedAt: '2026-08-25', ageWeeks: 2,
    status: 'resolved_in_room', owner: 'Someone', dueDate: null, resolution: 'resolved_in_room'
  }
];

test('a blocker names both ends of the pair', () => {
  const html = blockersSection(BLOCKERS, null, org, catalog);
  assert.ok(html.includes('needs from'), 'the ask sits between the two parties');
  assert.equal((html.match(/class="pair"/g) || []).length, 2, 'resolved blockers drop out');
  assert.ok(html.includes('party-from'));
  assert.ok(html.includes('party-to'));
  assert.ok(html.includes('US Sales') || html.includes('[OWNER NEEDED]'));
});

test('age is visually obvious, not only a number', () => {
  const html = blockersSection(BLOCKERS, null, org, catalog);
  assert.ok(html.includes('blocker-old'), 'a four-week blocker reads differently');
  assert.ok(html.includes('blocker-new'));
  assert.ok(html.includes('4 weeks old'));
  assert.ok(html.includes('new this week'), 'ageWeeks 1 is the week it was raised');
  assert.ok(html.includes('class="pips"'));
});

test('past the org.json escalation line, a blocker is escalated', () => {
  const html = blockersSection(BLOCKERS, null, org, catalog);
  assert.ok(html.includes('Escalated'));
  // escalate_after_weeks is 2, so the one-week blocker must not be escalated
  const newCard = html.slice(html.indexOf('Campaign id missing'));
  assert.ok(!newCard.slice(0, 400).includes('Escalated'));
});

test('the dependency summary is derived from the blockers when no matrix is given', () => {
  const html = blockersSection(BLOCKERS, null, org, catalog);
  assert.ok(html.includes('Who is waiting on whom'));
  assert.ok(html.includes('waiting on'));
  assert.ok(html.includes('is blocking the most'));
});

test('the dependency summary uses the real dependencyMatrix shape when supplied', () => {
  const matrix = {
    edges: [
      { from: 'us_sales', fromLabel: 'US Sales', to: 'sloosh', toLabel: 'Sloosh Product & Marketing', count: 3, escalated: true },
      { from: 'hiring', fromLabel: 'Hiring', to: 'sloosh', toLabel: 'Sloosh Product & Marketing', count: 1 }
    ],
    counts: { blocking: { sloosh: 4 }, blocked: { us_sales: 3, hiring: 1 } },
    external: [{ needsFrom: 'an agency', label: 'an agency', count: 1 }]
  };
  const html = blockersSection(BLOCKERS, matrix, org, catalog);
  assert.ok(html.includes('Sloosh Product &amp; Marketing'), 'labels travel with the ids');
  assert.ok(html.includes('dep-esc'), 'an escalated edge is marked');
  assert.ok(html.includes('point outside the five lines of business'));
});

test('no blockers means no section at all', () => {
  assert.equal(blockersSection([], null, org, catalog), '');
  assert.equal(blockersSection([BLOCKERS[2]], null, org, catalog), '', 'only a resolved one');
});

/* ---------------------------------------------------------------- *
 * Agenda order
 * ---------------------------------------------------------------- */

test('the dashboard follows org.json section kinds as the agenda order', () => {
  const html = renderDashboard({
    run: { id: 'run-test', ...PERIOD, status: 'ok', triggeredBy: 'manual' },
    snapshots: catalog.metrics.map(m => snap(m.id, 55)),
    scoreboard: SCORE_ROWS, blockers: BLOCKERS, decisions: [baseDecision],
    catalog, org, meta: {}
  });
  const at = id => html.indexOf(`<section id="${id}">`);
  assert.ok(at('scoreboard') > -1, 'scoreboard renders');
  assert.ok(at('blockers') > -1, 'blockers render');
  assert.ok(at('decisions') > -1, 'decisions render');
  assert.ok(at('scoreboard') < at('lines'), 'target question answered first');
  assert.ok(at('lines') < at('blockers'));
  assert.ok(at('blockers') < at('decisions'), 'a blocker usually IS the next decision');
});

test('the fixture banner only appears when asked for', () => {
  const base = {
    run: { id: 'r', ...PERIOD, status: 'ok' },
    snapshots: catalog.metrics.map(m => snap(m.id, 50)), catalog, org
  };
  assert.ok(!renderDashboard(base).includes('FORMAT FIXTURE'));
  assert.ok(renderDashboard({ ...base, meta: { fixtureBanner: 'synthetic' } })
    .includes('FORMAT FIXTURE'));
});
