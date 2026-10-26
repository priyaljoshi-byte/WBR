/**
 * rag.js - "Brand status".
 *
 * A human calls Red, Amber, Green or White per subject, every day, with a reason.
 *
 * WHY A HUMAN AND NOT A THRESHOLD. Every brand runs at a different scale with
 * different campaigns. A 3.1 ROAS is excellent on one account and a problem on
 * the next, so a rule that turns a number into a colour would be wrong in both
 * directions on the same day. The call is judgement; the system's job is to make
 * the judgement durable - dated, attributed, and sitting next to its reason.
 *
 * WHY FOUR STATUSES AND NOT THREE. The real WBR uses white for "not started, no
 * signal yet". That is not amber. Amber says someone looked and it is wobbling;
 * white says nobody has looked, or there is nothing to look at. Collapsing them
 * loses the single most actionable distinction on the board - a brand nobody has
 * touched for a week reads as "a bit concerning" instead of "untouched".
 *
 * WHY SUBJECT AND NOT BRAND. Performance Marketing calls brands; other functions
 * call tracks the same way. One table, a `kind` column, and the screen does not
 * need rewriting when Engineering starts using it.
 */

import { boot, paintShell, banner } from './shell.js';
import { loadAll } from './configload.js';
import { db, hasToken } from './supabase.js';
import { esc, el, emptyState, errorState, toast, daysBack, today, progressBar } from './ui.js';

const main = document.getElementById('main');
const params = new URLSearchParams(location.search);

/** The four calls. Order is worst-first so the eye lands on trouble. */
const STATUSES = [
  { v: 'R', label: 'Red', mark: 'R', means: 'off track, needs a decision' },
  { v: 'A', label: 'Amber', mark: 'A', means: 'wobbling, being watched' },
  { v: 'G', label: 'Green', mark: 'G', means: 'on track' },
  { v: 'W', label: 'White', mark: 'W', means: 'not started, no signal yet' }
];
const VALID = new Set(STATUSES.map((s) => s.v));

/** Shown only in preview, so the screen can be seen before the table exists. */
const PREVIEW_SUBJECTS = [
  { id: 'brand-a', label: 'Brand A', kind: 'brand', dept_id: 'perf_marketing' },
  { id: 'brand-b', label: 'Brand B', kind: 'brand', dept_id: 'perf_marketing' },
  { id: 'showcase', label: 'Showcase campaigns', kind: 'track', dept_id: 'perf_marketing' }
];

let ctx = null;
let data = null;
let subjects = [];
let callsBySubject = new Map();
let forDate = today();

/* ------------------------------- the strip -------------------------------- */

/**
 * Seven days, oldest on the left. An empty day is drawn as hatching rather than
 * omitted, because "nobody called it on Wednesday" is itself the finding - it is
 * the same gap that let a three-week-old hiring attachment sit inside an October
 * review without anyone noticing.
 */
function strip(subjectId) {
  const days = daysBack(7);
  const byDate = callsBySubject.get(subjectId) || new Map();
  const cells = days.map((d) => {
    const call = byDate.get(d);
    const v = call && VALID.has(call.status) ? call.status : '';
    const title = call
      ? `${d}: ${(STATUSES.find((s) => s.v === call.status) || {}).label || call.status} - ${call.reason} (${call.set_by || 'unknown'})`
      : `${d}: nobody called it`;
    return `<i data-v="${esc(v)}" title="${esc(title)}"></i>`;
  }).join('');

  const called = days.filter((d) => byDate.has(d)).length;
  const reds = days.filter((d) => (byDate.get(d) || {}).status === 'R').length;

  let note = `${called} of 7 days called`;
  if (reds >= 5) note = `${reds} days red this week`;
  else if (called === 0) note = 'not called once this week';

  return { html: `<div class="strip7">${cells}</div><p class="strip7-lbl">${esc(note)}</p>`, reds, called };
}

/* -------------------------------- the row --------------------------------- */

function subjectRow(subject, canWrite) {
  const byDate = callsBySubject.get(subject.id) || new Map();
  const todayCall = byDate.get(forDate) || null;
  const s = strip(subject.id);
  const uid = `rag-${subject.id}`;

  return `<div class="ragrow${s.reds >= 5 ? ' alarm' : ''}" id="${esc(uid)}" data-subject="${esc(subject.id)}">
    <div class="ragbrand">
      <h3>${esc(subject.label)}</h3>
      <p class="sub">${esc(subject.kind)}${todayCall
    ? ` &middot; set by ${esc(todayCall.set_by || 'unknown')}`
    : ' &middot; not called today'}</p>
    </div>
    <div class="ragbtns" role="group" aria-label="Status for ${esc(subject.label)}">
      ${STATUSES.map((st) => `<button type="button" class="ragbtn" data-v="${st.v}"
        aria-pressed="${todayCall && todayCall.status === st.v ? 'true' : 'false'}"
        title="${esc(st.label)} - ${esc(st.means)}"
        aria-label="${esc(st.label)}"${canWrite ? '' : ' disabled'}>${st.mark}</button>`).join('')}
    </div>
    <div class="ragreason">
      <label class="fl" for="${esc(uid)}-r">Why, in one line</label>
      <input type="text" id="${esc(uid)}-r" maxlength="160" autocomplete="off"
        placeholder="CPL doubled after the creative refresh"
        value="${esc(todayCall ? todayCall.reason : '')}"${canWrite ? '' : ' disabled'}>
      <p class="hint" data-role="msg"></p>
    </div>
    <div class="ragstrip">${s.html}</div>
  </div>`;
}

function wireRow(row, subject) {
  const buttons = [...row.querySelectorAll('.ragbtn')];
  const reason = row.querySelector('input[type=text]');
  const msg = row.querySelector('[data-role="msg"]');
  let pending = null;

  const clearError = () => { reason.classList.remove('bad'); msg.className = 'hint'; msg.textContent = ''; };
  reason.addEventListener('input', clearError);

  buttons.forEach((btn) => btn.addEventListener('click', async () => {
    const value = btn.dataset.v;
    const text = reason.value.trim();

    // THE REJECTION. A colour with no reason is not saved, full stop. It is not
    // a warning the person can click past, because a week of unexplained Reds is
    // exactly as useless as no week at all.
    if (!text) {
      pending = value;
      reason.classList.add('bad');
      msg.className = 'hint hint-bad';
      msg.textContent = `Say why it is ${(STATUSES.find((s) => s.v === value) || {}).label} before saving. One line is enough.`;
      reason.focus();
      return;
    }
    if (text.length < 4) {
      reason.classList.add('bad');
      msg.className = 'hint hint-bad';
      msg.textContent = 'That is too short to mean anything next Friday.';
      reason.focus();
      return;
    }

    clearError();
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));

    if (!hasToken()) {
      msg.className = 'hint';
      msg.textContent = 'Preview mode - nothing was saved.';
      return;
    }

    try {
      await db.upsert('pulse_status_calls', [{
        subject_id: subject.id,
        dept_id: subject.dept_id,
        status: value,
        reason: text,
        set_for: forDate,
        set_by: ctx.session ? ctx.session.email : null,
        created_at: new Date().toISOString()
      }], 'subject_id,set_for');

      if (!callsBySubject.has(subject.id)) callsBySubject.set(subject.id, new Map());
      callsBySubject.get(subject.id).set(forDate, {
        status: value, reason: text, set_by: ctx.session ? ctx.session.email : null
      });

      const s = strip(subject.id);
      row.querySelector('.ragstrip').innerHTML = s.html;
      row.classList.toggle('alarm', s.reds >= 5);
      row.querySelector('.sub').textContent =
        `${subject.kind} · set by ${ctx.session ? ctx.session.email : 'you'}`;
      msg.className = 'hint hint-ok';
      msg.textContent = `Saved for ${forDate}.`;
      repaintCompleteness();
      toast(`${subject.label} set to ${(STATUSES.find((x) => x.v === value) || {}).label}`);
    } catch (err) {
      msg.className = 'hint hint-bad';
      msg.textContent = err.message;
    }
  }));

  // Pressing Enter in the reason box commits the colour the person already tried.
  reason.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const target = pending
      ? buttons.find((b) => b.dataset.v === pending)
      : buttons.find((b) => b.getAttribute('aria-pressed') === 'true');
    if (target) target.click();
  });
}

/* ----------------------------- completeness ------------------------------- */

let completeHost = null;

function repaintCompleteness() {
  const called = subjects.filter((s) => (callsBySubject.get(s.id) || new Map()).has(forDate)).length;
  const total = subjects.length;
  const missing = total - called;
  const stuck = subjects.filter((s) => strip(s.id).reds >= 5);
  const untouched = subjects.filter((s) => strip(s.id).called === 0);

  completeHost.innerHTML = `
    <header>
      <div>
        <p class="kicker">Not called ${forDate === today() ? 'today' : `on ${esc(forDate)}`}</p>
        <p class="bignum ${missing ? 'owed' : 'zero'}" style="margin-top:8px">${missing}</p>
      </div>
      <span class="chip ${missing ? 'chip-warn' : 'chip-ok'}">${called} of ${total} called</span>
    </header>
    ${progressBar(called, total)}
    <p class="hint" style="margin-top:14px">${missing
    ? 'An uncalled subject is not neutral - it reads as white on the strip, which is the honest answer and also the one that gets noticed.'
    : 'Every subject has a call and a reason against it for this date.'}</p>
    ${stuck.length ? `<p class="hint" style="margin-top:8px;color:var(--red)"><b>${esc(stuck.map((s) => s.label).join(', '))}</b> ${stuck.length === 1 ? 'has' : 'have'} been red most of the week. That is a decision waiting to be made, not a status.</p>` : ''}
    ${untouched.length ? `<p class="hint" style="margin-top:8px;color:var(--amber)"><b>${esc(untouched.map((s) => s.label).join(', '))}</b> ${untouched.length === 1 ? 'has' : 'have'} not been called once in seven days.</p>` : ''}`;
}

/* --------------------------------- boot ----------------------------------- */

function datePicker() {
  const host = document.getElementById('datepick');
  host.innerHTML = `<label class="fl" for="ragdate">Calling for</label>
    <input type="date" id="ragdate" value="${esc(forDate)}" max="${esc(today())}" style="min-width:180px">`;
  document.getElementById('ragdate').addEventListener('change', (e) => {
    forDate = e.target.value || today();
    draw();
  });
}

async function loadSubjects() {
  if (!hasToken()) return PREVIEW_SUBJECTS;
  try {
    const rows = await db.select('pulse_status_subjects', { eq: { active: true }, order: 'ord.asc' });
    return rows.map((r) => ({ id: r.id, label: r.label, kind: r.kind, dept_id: r.dept_id }));
  } catch {
    return [];
  }
}

async function loadCalls() {
  const map = new Map();
  if (!hasToken()) return map;
  const days = daysBack(14);
  try {
    const rows = await db.select('pulse_status_calls', {
      gte: { set_for: days[0] },
      order: 'set_for.asc'
    });
    for (const r of rows) {
      if (!map.has(r.subject_id)) map.set(r.subject_id, new Map());
      map.get(r.subject_id).set(r.set_for, r);
    }
  } catch { /* table not created yet */ }
  return map;
}

function addSubjectForm(canWrite) {
  if (!canWrite) return '';
  return `<section class="card" style="margin-top:18px">
    <h3>Add a brand or a track</h3>
    <p class="hint" style="margin-top:7px">A subject is anything the room calls a colour on. Brands for Performance Marketing, tracks for everyone else.</p>
    <div class="fieldrow" style="margin-top:14px">
      <div class="field"><label class="fl" for="newsub">Name</label>
        <input type="text" id="newsub" placeholder="Brand C" autocomplete="off"></div>
      <div class="field"><label class="fl" for="newkind">Kind</label>
        <select id="newkind"><option value="brand">brand</option><option value="track">track</option></select></div>
      <div class="field"><label class="fl" for="newdept">Department</label>
        <select id="newdept">${data.org.departments.map((d) => `<option value="${esc(d.id)}"${d.id === 'perf_marketing' ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select></div>
    </div>
    <div class="btnrow"><button class="btn btn-sm" type="button" id="addsub">Add it</button></div>
  </section>`;
}

function draw() {
  const canWrite = ctx.canWrite('perf_marketing') || ctx.isAdmin
    || subjects.some((s) => ctx.canWrite(s.dept_id));

  main.innerHTML = '';
  completeHost = el('section', { class: 'card', style: 'margin-bottom:20px' });
  main.appendChild(completeHost);

  if (!subjects.length) {
    completeHost.remove();
    main.innerHTML = emptyState({
      title: 'No brands or tracks are set up yet',
      next: hasToken()
        ? 'Add the first one below. Each becomes a row with four buttons and a reason box, called once a day in the stand-up.'
        : 'Sign in to add brands and tracks. In preview you can see the screen but not the real list.'
    }) + addSubjectForm(canWrite);
    wireAdd();
    return;
  }

  repaintCompleteness();

  const board = el('section', { class: 'card', style: 'padding:0;overflow:hidden' });
  board.innerHTML = `<div class="ragrow" style="border-bottom:1px solid var(--line-soft);background:#161616;padding-top:12px;padding-bottom:12px">
      <span class="kicker">subject</span><span class="kicker">call</span>
      <span class="kicker">reason, required</span><span class="kicker">last 7 days</span>
    </div>` + subjects.map((s) => subjectRow(s, canWrite && ctx.canWrite(s.dept_id))).join('');
  main.appendChild(board);

  subjects.forEach((s) => {
    const row = board.querySelector(`[data-subject="${CSS.escape(s.id)}"]`);
    if (row) wireRow(row, s);
  });

  main.appendChild(el('div', {
    class: 'hint',
    style: 'margin-top:18px',
    html: 'White is not a soft amber. It means nobody has looked yet, or there is nothing to look at. Keeping them apart is what stops an untouched brand reading as a mildly concerning one.'
  }));

  main.insertAdjacentHTML('beforeend', addSubjectForm(canWrite));
  wireAdd();
}

function wireAdd() {
  const btn = document.getElementById('addsub');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const label = document.getElementById('newsub').value.trim();
    const kind = document.getElementById('newkind').value;
    const deptId = document.getElementById('newdept').value;
    if (!label) { toast('Give it a name first.', 'warn'); return; }
    if (!hasToken()) { toast('Preview mode - nothing was saved.', 'warn'); return; }
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    try {
      await db.upsert('pulse_status_subjects', [{
        id, label, kind, dept_id: deptId, active: true, ord: subjects.length
      }], 'id');
      subjects.push({ id, label, kind, dept_id: deptId });
      toast(`${label} added`);
      draw();
    } catch (err) { toast(err.message, 'warn'); }
  });
}

async function render() {
  ctx = await boot({
    active: 'rag',
    title: 'Brand status',
    blurb: 'Red, Amber, Green or White per brand or track, called by a human each day with a reason beside it. Sign in to make a call.'
  });
  if (!ctx.guard('#main')) { paintShell(ctx, { active: 'rag' }); return; }

  main.innerHTML = '<p class="hint">Loading...</p>';
  try { data = await loadAll(); } catch (err) {
    paintShell(ctx, { active: 'rag' });
    main.innerHTML = errorState(err, 'Could not read the configuration');
    return;
  }

  const allDeptIds = data.org.departments.map((d) => d.id);
  const labels = data.org.departments.filter((d) => ctx.scope(allDeptIds).includes(d.id)).map((d) => d.short || d.label);
  paintShell(ctx, { active: 'rag', deptLabels: labels });

  if (!hasToken()) {
    banner('preview', '<b>Preview.</b> The subjects below are examples so the screen can be seen. Nothing is read from or written to the database.');
  }

  const wantedDate = params.get('date');
  if (wantedDate && /^\d{4}-\d{2}-\d{2}$/.test(wantedDate)) forDate = wantedDate;
  datePicker();

  subjects = await loadSubjects();
  callsBySubject = await loadCalls();
  draw();
}

render().catch((err) => { main.innerHTML = errorState(err, 'This page could not start'); });
