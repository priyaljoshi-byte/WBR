/**
 * hiring.js - "Hiring funnel": every open role as a ring, and per role the
 * waterfall from first contact to joining.
 *
 * Reads the hiring tracker live through app/sheets.js (the exact-tab export
 * read), so the page is as current as the sheet. The spreadsheet id comes from
 * pulse_sources (the Sources screen saves it), never from a shipped file: the
 * sheet holds candidates' contact details and pay, and this site is public
 * until the Netlify password goes on. Only name, role and stage reach the DOM -
 * engine/hiring.js drops every other column before anything renders.
 */

import { boot, paintShell, banner } from './shell.js';
import { loadAll } from './configload.js';
import { esc, emptyState, errorState } from './ui.js';
import { fetchSheetCsv } from './sheets.js';
import { parseCSV } from './csv.js';
import { isPlaceholderRef } from './refs.js';
import { buildFunnels } from '../engine/hiring.js';
import { ringSvg, ringDefs } from '../render/rings.js';

const main = document.getElementById('main');
const readAt = document.getElementById('readat');
const refreshBtn = document.getElementById('refresh');

let result = null;
let selected = null;

const STATUS_CHIP = {
  active: ['chip-info', 'moving'],
  dropped: ['chip-bad', 'dropped'],
  hold: ['chip-warn', 'on hold'],
  parked: ['chip', 'parked']
};

const ROLE_CHIP = {
  open: ['chip-info', 'open'],
  on_hold: ['chip-warn', 'on hold'],
  closed: ['chip-ok', 'closed']
};

function chip([cls, text]) {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

const PRIORITY_ORDER = (p) => { const m = String(p).match(/P(\d)/i); return m ? Number(m[1]) : 9; };
const STATUS_ORDER = { open: 0, on_hold: 1, closed: 2 };

async function readTab(id, gid) {
  const res = await fetchSheetCsv(id, { gid });
  return parseCSV(res.text).rows;
}

async function load() {
  refreshBtn.disabled = true;
  main.innerHTML = '<p class="hint">Reading the hiring tracker from Google...</p>';
  try {
    const [data, config] = await Promise.all([
      loadAll(),
      fetch('../config/hiring.json', { cache: 'no-store' }).then((r) => r.json())
    ]);
    const source = data.sources.sources.find((s) => s.id === 'hiring_tracker');
    if (!source || isPlaceholderRef(source.ref)) {
      main.innerHTML = emptyState({
        title: 'The hiring tracker is not connected yet.',
        next: 'On Sources, under Hiring, paste the tracker link and press "Connect and read the sheet now".',
        action: '<a class="btn btn-go" href="sources.html?dept=hiring">Go to Sources</a>'
      });
      return;
    }
    const t = config.tabs;
    const [roleRows, offerRows, ...candRows] = await Promise.all([
      readTab(source.ref, t.roles.gid),
      readTab(source.ref, t.offers.gid).catch(() => []),
      ...t.candidates.map((c) => readTab(source.ref, c.gid))
    ]);
    result = buildFunnels({
      roleRows,
      offerRows,
      candidateTabs: t.candidates.map((c, i) => ({ recruiter: c.recruiter, rows: candRows[i] }))
    }, config);
    readAt.textContent = `Read ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const fromHash = decodeURIComponent((location.hash.match(/role=([^&]+)/) || [])[1] || '');
    selected = result.funnels.some((f) => f.key === fromHash) ? fromHash : null;
    render();
  } catch (err) {
    main.innerHTML = errorState(new Error(`${err.message}${err.fix ? ` ${err.fix}` : ''}`), 'Could not read the hiring tracker');
  } finally {
    refreshBtn.disabled = false;
  }
}

function sorted(funnels) {
  return [...funnels].sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    || (PRIORITY_ORDER(a.priority) - PRIORITY_ORDER(b.priority)) || a.name.localeCompare(b.name));
}

function roleCard(f) {
  const ring = ringSvg([{ normalized: f.health }]);
  const line = f.need === 0
    ? `${f.hired} of ${f.headcount} hired`
    : `${f.healthy} live at ${esc(result.healthyFromLabel)}+ &middot; needs ${f.need}`;
  return `<button type="button" class="rolecard${f.key === selected ? ' on' : ''}${f.status === 'closed' ? ' dim' : ''}" data-role="${esc(f.key)}" aria-expanded="${f.key === selected}">
    <div class="rc-ring">${ring}<div class="rc-pct"><b>${f.health}%</b><span>health</span></div></div>
    <div class="rc-body">
      <div class="rc-top">${chip(ROLE_CHIP[f.status])}${f.priority ? `<span class="chip">${esc(f.priority)}</span>` : ''}</div>
      <h3>${esc(f.name)}</h3>
      <p class="hint">${line}</p>
      <p class="rc-flow">${f.steps.map((s) => `<span title="${esc(s.label)}">${s.reached}</span>`).join('<i>&rsaquo;</i>')}</p>
      <p class="hint">${esc(f.poc || 'no recruiter')} &middot; HM ${esc(f.hiringManager || '-')} &middot; ${f.headcount} opening${f.headcount === 1 ? '' : 's'}</p>
    </div>
  </button>`;
}

function detail(f) {
  const top = Math.max(1, f.steps[0].reached);
  const rows = f.steps.map((s, i) => {
    const prev = i ? f.steps[i - 1].reached : null;
    const conv = prev ? `${Math.round((s.reached / prev) * 100)}% of previous` : '';
    return `<div class="wf-row">
      <div class="wf-label">${esc(s.label)}</div>
      <div class="wf-bar"><i style="width:${Math.max(s.reached ? 2 : 0, (s.reached / top) * 100)}%"></i></div>
      <div class="wf-n"><b>${s.reached}</b></div>
      <div class="wf-meta">${s.here ? `<span class="hint-ok">${s.here} here now</span>` : ''}${s.stopped ? ` <span class="hint-bad">${s.stopped} stopped</span>` : ''}${conv && prev ? ` <span>${conv}</span>` : ''}</div>
    </div>`;
  }).join('');
  const people = f.candidates.length
    ? `<div class="tablewrap"><table class="prev">
        <thead><tr><th>Candidate</th><th>Furthest stage</th><th>Sheet says</th><th>Status</th><th>Tracked by</th></tr></thead>
        <tbody>${f.candidates.map((c) => `<tr>
          <td>${esc(c.name)}</td><td>${esc(c.reachedLabel)}</td><td>${esc(c.stageText || '-')}</td>
          <td>${chip(STATUS_CHIP[c.status] || STATUS_CHIP.active)}</td><td>${esc(c.recruiter)}</td></tr>`).join('')}</tbody>
      </table></div>`
    : '<p class="hint">No candidates in the tracker for this role yet.</p>';
  return `<section class="card" id="detail">
    <header><div><div class="kicker">Waterfall</div><h3>${esc(f.name)}</h3></div>
      <button class="btn btn-quiet btn-sm" type="button" id="closedetail">Close</button></header>
    <div class="kv"><span><b>${f.total}</b> candidates</span><span><b>${f.active}</b> still moving</span>
      <span><b>${f.hired}</b> of ${f.headcount} hired</span><span><b>${f.healthy}</b> of ${f.need} needed at ${esc(result.healthyFromLabel)}+</span></div>
    <div class="wf">${rows}</div>
    <h3 style="margin-top:22px">Candidates</h3>
    ${people}
  </section>`;
}

function strays() {
  const parts = [];
  if (result.unmatched.length) {
    parts.push(`<section class="card flag"><header><h3>Candidates for roles not on the open list</h3></header>
      <p class="hint">Their role is spelled in a way that matches no row on Open Roles-Oct-Dec. Add the spelling
      to <code>role_aliases</code> in config/hiring.json, or add the role to the sheet.</p>
      <div class="kv">${result.unmatched.map((u) => `<span><b>${u.candidates.length}</b> ${esc(u.role)}</span>`).join('')}</div></section>`);
  }
  if (result.unknownWords.length) {
    parts.push(`<section class="card flag"><header><h3>Stage words Pulse did not recognise</h3></header>
      <p class="hint">These candidates are counted as "In pipeline" until the word is added to <code>stage_words</code>.</p>
      <div class="kv">${result.unknownWords.map((u) => `<span><b>${u.count}</b> "${esc(u.word)}"</span>`).join('')}</div></section>`);
  }
  return parts.join('');
}

function render() {
  const list = sorted(result.funnels);
  const live = list.filter((f) => f.status !== 'closed');
  const closed = list.filter((f) => f.status === 'closed');
  const totals = live.reduce((a, f) => ({ openings: a.openings + f.openings, active: a.active + f.active, hired: a.hired + f.hired }), { openings: 0, active: 0, hired: 0 });
  const weak = live.filter((f) => f.status === 'open' && f.health < 50).length;
  const pick = result.funnels.find((f) => f.key === selected);

  main.innerHTML = `
    <div class="kv" style="margin:0 0 18px"><span><b>${live.filter((f) => f.status === 'open').length}</b> open roles</span>
      <span><b>${totals.openings}</b> openings left</span><span><b>${totals.active}</b> candidates moving</span>
      <span><b>${totals.hired}</b> offers accepted or joined</span>
      <span><b>${weak}</b> open roles under half health</span>
      <span>Ring full = ${result.perOpening} live candidates at ${esc(result.healthyFromLabel)}+ per opening</span></div>
    ${pick ? detail(pick) : ''}
    <div class="rolegrid">${live.map(roleCard).join('')}</div>
    ${closed.length ? `<div class="sechead"><h2>Closed</h2><p>Kept for the record.</p></div>
      <div class="rolegrid">${closed.map(roleCard).join('')}</div>` : ''}
    ${strays()}`;

  // ringSvg leaves the fill at zero for the dashboard's scroll animation; this
  // page has no scroll trigger, so draw them straight away.
  requestAnimationFrame(() => {
    main.querySelectorAll('circle.fill').forEach((c) => c.setAttribute('stroke-dasharray', c.getAttribute('data-dash')));
  });

  main.querySelectorAll('.rolecard').forEach((b) => b.addEventListener('click', () => {
    selected = selected === b.dataset.role ? null : b.dataset.role;
    history.replaceState(null, '', selected ? `#role=${encodeURIComponent(selected)}` : location.pathname);
    render();
    if (selected) document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const close = document.getElementById('closedetail');
  if (close) close.addEventListener('click', () => { selected = null; history.replaceState(null, '', location.pathname); render(); });
}

(async () => {
  const ctx = await boot({ page: 'hiring' });
  paintShell(ctx, { active: 'hiring', deptLabels: ['Hiring'] });
  document.body.insertAdjacentHTML('afterbegin', ringDefs());
  refreshBtn.addEventListener('click', load);
  await load();
})().catch((err) => {
  banner('err', esc(err.message));
});
