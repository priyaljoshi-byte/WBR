/**
 * transcripts.js - "Add a meeting".
 *
 * Four stages, in order, and the third one is the only reason this screen is
 * worth building:
 *
 *   1. pick the meeting
 *   2. paste or upload the transcript
 *   3. REVIEW every extracted item, one at a time, accept / edit / reject
 *   4. commit, and read the report sentence
 *
 * Stage 3 is non-negotiable. An LLM writing directly into a decision log with no
 * human in between is how the log stops being trusted - and the moment people
 * stop trusting it, they go back to writing the deck by hand and the whole
 * system is dead weight. So: nothing reaches the database until Commit, every
 * item carries its verbatim quote so the reviewer can check the claim against
 * what was actually said, and an item the matcher could not confidently place is
 * shown beside its candidate rather than merged on a guess.
 *
 * Two sections follow the review because the real WBR produces them and nothing
 * else in the system captures them: the week's headline numbers, and the top
 * three priorities per person. Both are forward commitments, both were being
 * lost in a Notion toggle one person out of several remembered to fill in.
 */

import { boot, paintShell, banner } from './shell.js';
import { loadAll } from './configload.js';
import { cleanTranscript, suspectInjection } from './transcript-text.js';
import { extractTranscript, previewExtraction } from './api.js';
import { db, canSave } from './store.js';
import {
  esc, el, emptyState, errorState, toast, readFileAsText, dropZone, today, progressBar
} from './ui.js';

const main = document.getElementById('main');

let ctx = null;
let data = null;
let meeting = null;
let draft = null;          // the extraction, plus per-item review state
let transcriptText = '';

const ACCEPTED = 'accept';
const REJECTED = 'reject';

/* ---------------------------------------------------------------------------
 * Stage 1 + 2 - pick a meeting, get the text in
 * ------------------------------------------------------------------------- */

function meetingPicker() {
  const host = document.getElementById('meetingpick');
  const list = data.meetings.meetings;
  meeting = meeting || list[0];
  host.innerHTML = `
    <label class="fl" for="meetsel">Which meeting</label>
    <select id="meetsel" style="min-width:260px">
      ${list.map((m) => `<option value="${esc(m.id)}"${m.id === meeting.id ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
    </select>
    <p class="hint" style="margin-top:7px">${esc(meeting.blurb || '')}</p>`;
  document.getElementById('meetsel').addEventListener('change', (e) => {
    meeting = list.find((m) => m.id === e.target.value) || list[0];
    meetingPicker();
  });
}

function stageInput() {
  return `<section class="card">
    <header>
      <div><h3>The transcript</h3>
      <p class="kicker" style="margin:5px 0 0">paste it, or drop a file</p></div>
      <span class="chip" id="tx-count">0 lines</span>
    </header>

    <div class="field" style="margin-top:16px">
      <label class="fl" for="tx">Transcript</label>
      <textarea id="tx" spellcheck="false" placeholder="Paste the whole transcript here. Speaker labels are helpful but not required."></textarea>
    </div>

    <div class="drop" id="tx-drop" tabindex="0" role="button" aria-label="Choose a transcript file">
      <p><b>or drop a .txt, .md, .vtt or .srt here</b></p>
      <p class="drop-sub">Timecodes and cue numbers are stripped before anything is sent. The file is read in your browser.</p>
      <input type="file" id="tx-file" accept=".txt,.md,.markdown,.vtt,.srt,text/plain">
    </div>

    <div id="tx-meta"></div>

    <div class="fieldrow" style="margin-top:16px;max-width:420px">
      <div class="field">
        <label class="fl" for="tx-date">Meeting date</label>
        <input type="date" id="tx-date" value="${esc(today())}">
      </div>
    </div>

    <div class="btnrow" style="margin-top:8px">
      <button class="btn btn-go" id="tx-extract" type="button" disabled>Extract</button>
      <button class="btn btn-quiet" id="tx-clear" type="button">Clear</button>
      <span class="hint" id="tx-note"></span>
    </div>
  </section>
  <div id="stage-review"></div>`;
}

function wireInput() {
  const ta = document.getElementById('tx');
  const drop = document.getElementById('tx-drop');
  const file = document.getElementById('tx-file');
  const count = document.getElementById('tx-count');
  const meta = document.getElementById('tx-meta');
  const extract = document.getElementById('tx-extract');
  const note = document.getElementById('tx-note');

  const refresh = (info) => {
    transcriptText = ta.value;
    const lines = transcriptText.split('\n').filter((l) => l.trim()).length;
    const words = transcriptText.trim() ? transcriptText.trim().split(/\s+/).length : 0;
    count.textContent = `${lines} lines`;
    extract.disabled = words < 40;
    note.textContent = words < 40
      ? (words ? `${words} words so far - too short to extract anything useful.` : '')
      : `${words} words ready.`;

    const hits = suspectInjection(transcriptText);
    meta.innerHTML = [
      info && info.format !== 'text'
        ? `<div class="banner" style="margin-top:14px"><b>${esc(info.format.toUpperCase())} caption file.</b> ${info.strippedLines} timecode and cue lines were stripped, leaving ${info.lines} spoken lines. Nothing anyone said was removed.</div>`
        : '',
      hits.length
        ? `<div class="banner banner-warn" style="margin-top:14px"><b>${hits.length} line${hits.length === 1 ? '' : 's'} in this transcript read as an instruction aimed at the model.</b>
             They are quoted here and will be quoted again after extraction. Nothing will be derived from them.
             <ul style="margin:10px 0 0;padding-left:18px">${hits.slice(0, 5).map((h) => `<li style="margin-bottom:5px">line ${h.line}: <q>${esc(h.quote)}</q></li>`).join('')}</ul>
           </div>`
        : ''
    ].join('');
  };

  ta.addEventListener('input', () => refresh(null));

  const handleFile = async (files) => {
    const f = files[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) {
      toast(`${f.name} is too large. Transcripts are text - 4MB is already about 40 hours.`, 'warn');
      return;
    }
    const raw = await readFileAsText(f);
    const info = cleanTranscript(raw, f.name);
    ta.value = info.text;
    refresh(info);
    toast(`${f.name} loaded`);
  };

  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => handleFile([...file.files]));
  dropZone(drop, handleFile);

  document.getElementById('tx-clear').addEventListener('click', () => {
    ta.value = ''; file.value = ''; draft = null;
    document.getElementById('stage-review').innerHTML = '';
    refresh(null);
  });

  extract.addEventListener('click', async () => {
    extract.disabled = true;
    extract.textContent = 'Extracting...';
    const date = document.getElementById('tx-date').value || today();
    const meetingId = `${meeting.kind || meeting.id}-${date}`;
    try {
      let result;
      if (!canSave()) {
        // Preview only. Clearly labelled sample data; it can never be committed
        // because preview has no session. This is not a fallback for a broken
        // function - with a real session you get the error, not this.
        result = previewExtraction(meetingId, date);
      } else {
        const open = await loadOpenRecords();
        result = await extractTranscript({
          transcript: cleanTranscript(document.getElementById('tx').value).text,
          meetingId, meetingDate: date, meetingKind: meeting.kind || meeting.id,
          period: weekOf(date),
          openDecisions: open.decisions,
          openBlockers: open.blockers
        });
      }
      draft = prepareDraft(result);
      renderReview();
      document.getElementById('stage-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      document.getElementById('stage-review').innerHTML = errorState(
        err,
        'Extraction did not run'
      ) + `<p class="hint" style="margin-top:12px;text-align:center">The extraction runs in a Supabase Edge Function so the Anthropic key stays off this page. If it has not been deployed yet, this is the error you get - nothing was written and the transcript is still in the box above.</p>`;
    } finally {
      extract.disabled = false;
      extract.textContent = 'Extract';
    }
  });

  refresh(null);
}

function weekOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // monday = 0
  const start = new Date(d); start.setUTCDate(d.getUTCDate() - day);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function loadOpenRecords() {
  const out = { decisions: [], blockers: [] };
  try {
    out.decisions = await db.select('pulse_decisions', {
      select: 'id,domain,headline,status,owner,due_date', limit: 200
    });
  } catch { /* nothing carried in yet */ }
  try {
    out.blockers = await db.select('pulse_blockers', { limit: 200 });
  } catch { /* table may not exist */ }
  return out;
}

/* ---------------------------------------------------------------------------
 * Stage 3 - the review
 * ------------------------------------------------------------------------- */

/** Every item starts UNDECIDED. Nothing is pre-accepted, because a screen of
 *  pre-ticked boxes is a screen nobody reads. */
function prepareDraft(result) {
  const tag = (arr, kind) => (arr || []).map((item, i) => ({
    kind, i, state: null, edited: null, mergeChoice: null, item
  }));
  return {
    raw: result,
    sample: !!result._sample,
    meetingId: result.meetingId,
    meetingDate: result.meetingDate,
    decisions: tag(result.decisions, 'decision'),
    blockers: tag(result.blockers, 'blocker'),
    notes: tag(result.notes, 'note'),
    numbers: tag(result.statedNumbers, 'number'),
    asks: tag(result.asks, 'ask'),
    injections: result.injectionAttempts || []
  };
}

const allItems = () => [...draft.decisions, ...draft.blockers, ...draft.notes, ...draft.numbers];

function reviewProgress() {
  const items = allItems();
  const decided = items.filter((r) => r.state).length;
  const merges = draft.decisions.filter((r) => r.item._match && r.item._match.tag === 'needs_human_merge' && !r.mergeChoice);
  return { decided, total: items.length, merges };
}

function repaintProgress() {
  const host = document.getElementById('rev-progress');
  if (!host) return;
  const { decided, total, merges } = reviewProgress();
  const commit = document.getElementById('rev-commit');
  const blocked = decided < total || merges.length > 0;
  if (commit) commit.disabled = blocked || !canSave();

  host.innerHTML = `
    <header>
      <div>
        <p class="kicker">Reviewed</p>
        <p class="bignum ${decided === total ? 'zero' : 'owed'}" style="margin-top:8px">${decided}<span style="font-size:20px;color:var(--fg-3)"> / ${total}</span></p>
      </div>
      <span class="chip ${decided === total ? 'chip-ok' : 'chip-warn'}">${total - decided} left</span>
    </header>
    ${progressBar(decided, total)}
    <p class="hint" style="margin-top:14px">${
  merges.length
    ? `<b style="color:var(--amber)">${merges.length} item${merges.length === 1 ? '' : 's'} need${merges.length === 1 ? 's' : ''} a merge decision.</b> The matcher will not guess: a false match silently rewrites history, and the evidence of the mistake is the thing it overwrote.`
    : decided < total
      ? 'Every item needs an accept or a reject before anything can be committed.'
      : 'Everything is reviewed. Commit writes it to the record.'}</p>`;
}

function quoteBlock(label, text) {
  if (!text) return '';
  return `<div class="q"><b>${esc(label)}</b>${esc(text)}</div>`;
}

function stateChip(row) {
  if (row.state === ACCEPTED) return '<span class="chip chip-ok">accepted</span>';
  if (row.state === REJECTED) return '<span class="chip chip-bad">rejected</span>';
  return '<span class="chip chip-warn">not reviewed</span>';
}

/* ------------------------------- decisions -------------------------------- */

function decisionCard(row) {
  const d = row.item;
  const needsMerge = d._match && d._match.tag === 'needs_human_merge';
  const uid = `dec-${row.i}`;

  return `<article class="review" id="${uid}" data-kind="decision" data-i="${row.i}">
    <div class="review-top">
      <span class="chip chip-info">${esc(d.domain || 'no domain')}</span>
      <span class="chip chip-${String(d.status || 'open').toLowerCase()}">${esc(d.status || 'OPEN')}</span>
      ${d.owner ? '' : '<span class="chip chip-warn">owner needed</span>'}
      ${d.dueDate ? '' : '<span class="chip chip-warn">date needed</span>'}
      ${!d.metricIds || !d.metricIds.length ? '<span class="chip chip-warn">unproveable</span>' : ''}
      <span style="margin-left:auto">${stateChip(row)}</span>
    </div>
    <h3>${esc(d.headline || 'no headline')}</h3>

    ${needsMerge ? `
      <div class="merge">
        <div class="merge-side">
          <h4>already on the books</h4>
          <p>${esc(d._match.candidateHeadline || '')}</p>
        </div>
        <div class="merge-mid">same<br>decision?</div>
        <div class="merge-side">
          <h4>this meeting</h4>
          <p>${esc(d.headline || '')}</p>
        </div>
      </div>
      <p class="hint" style="margin-top:10px">${esc(d._match.reason || '')}</p>
      <div class="btnrow" style="margin-top:10px">
        <button class="btn btn-sm" type="button" data-act="merge" aria-pressed="${row.mergeChoice === 'merge'}">Same decision - merge</button>
        <button class="btn btn-sm" type="button" data-act="separate" aria-pressed="${row.mergeChoice === 'separate'}">Different - keep separate</button>
      </div>` : ''}

    <dl>
      <dt>carried in</dt><dd>${esc(d.carriedIn || '-')}</dd>
      <dt>evidence</dt><dd>${esc(d.evidence || '-')}</dd>
      <dt>decided</dt><dd>${esc(d.decided || '-')}</dd>
      <dt>before next</dt><dd>${esc(d.beforeNextReview || '-')}</dd>
      <dt>owner</dt><dd>${d.owner ? esc(d.owner) : '<span style="color:var(--amber)">[OWNER NEEDED]</span>'}</dd>
      <dt>due</dt><dd>${d.dueDate ? esc(d.dueDate) : '<span style="color:var(--amber)">[DATE NEEDED]</span>'}</dd>
      <dt>proves it</dt><dd>${d.metricIds && d.metricIds.length
    ? esc(d.metricIds.join(', '))
    : '<span style="color:var(--amber)">no metric linked - nothing on the dashboard moves when this works</span>'}</dd>
      ${d.reason ? `<dt>reason</dt><dd>${esc(d.reason)}</dd>` : ''}
    </dl>
    ${quoteBlock('verbatim', d.quote)}
    ${d.previousStateUnverified ? '<p class="hint" style="color:var(--amber);margin-top:10px">[PREVIOUS STATE UNVERIFIED] - the prior position was described with no prior record to read from.</p>' : ''}

    <div class="edit-grid" hidden data-role="edit">
      <div class="field"><label class="fl">Headline</label>
        <input type="text" data-e="headline" value="${esc(d.headline || '')}"></div>
      <div class="fieldrow">
        <div class="field"><label class="fl">Owner</label>
          <input type="text" data-e="owner" value="${esc(d.owner || '')}" placeholder="a name, not a team"></div>
        <div class="field"><label class="fl">Due date</label>
          <input type="date" data-e="dueDate" value="${esc(d.dueDate || '')}"></div>
        <div class="field"><label class="fl">Status</label>
          <select data-e="status">${['NEW', 'CONFIRMED', 'CHANGED', 'REVERSED', 'COMPLETED', 'PARTIAL', 'BLOCKED', 'DEFERRED', 'DROPPED', 'OPEN']
    .map((s) => `<option${s === d.status ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label class="fl">Reason (required for CHANGED, REVERSED, DEFERRED, DROPPED)</label>
        <input type="text" data-e="reason" value="${esc(d.reason || '')}"></div>
      <div class="field"><label class="fl">Metrics that prove it, comma separated</label>
        <input type="text" data-e="metricIds" value="${esc((d.metricIds || []).join(', '))}"></div>
      <p class="hint" data-role="editmsg"></p>
    </div>

    <div class="acts">
      <button class="btn btn-sm btn-go" type="button" data-act="accept">Accept</button>
      <button class="btn btn-sm" type="button" data-act="edit">Edit</button>
      <button class="btn btn-sm btn-danger" type="button" data-act="reject">Reject</button>
      <span class="spacer"></span>
      <span class="hint" data-role="msg"></span>
    </div>
  </article>`;
}

/* -------------------------------- blockers -------------------------------- */

function blockerCard(row) {
  const b = row.item;
  const uid = `blk-${row.i}`;
  const deptLabel = (id) => {
    const d = data.org.departments.find((x) => x.id === id);
    return d ? d.label : (id || '[OWNER NEEDED]');
  };
  return `<article class="review" id="${uid}" data-kind="blocker" data-i="${row.i}">
    <div class="review-top">
      <span class="chip">${esc(b.status || 'open')}</span>
      ${b.needsFrom ? '' : '<span class="chip chip-warn">no other end named</span>'}
      <span style="margin-left:auto">${stateChip(row)}</span>
    </div>
    <h3>${esc(b.title || 'no title')}</h3>
    <div class="merge" style="margin-top:12px">
      <div class="merge-side"><h4>blocked</h4><p>${esc(deptLabel(b.raisedBy))}</p></div>
      <div class="merge-mid">needs from</div>
      <div class="merge-side"><h4>can unblock</h4><p>${b.needsFrom ? esc(deptLabel(b.needsFrom)) : '<span style="color:var(--amber)">[OWNER NEEDED]</span>'}</p></div>
    </div>
    <dl>
      <dt>the ask</dt><dd>${esc(b.what || '-')}</dd>
      <dt>impact</dt><dd>${esc(b.impact || '-')}</dd>
      <dt>raised</dt><dd>${esc(b.raisedAt || 'unknown')}${b.raisedAt ? ` &middot; ${ageWeeks(b.raisedAt)} week(s) old` : ''}</dd>
      <dt>holds back</dt><dd>${(b.metricIds || []).length ? esc(b.metricIds.join(', ')) : 'no metric linked'}</dd>
    </dl>
    ${quoteBlock('verbatim', b.quote)}
    <div class="edit-grid" hidden data-role="edit">
      <div class="field"><label class="fl">Title</label><input type="text" data-e="title" value="${esc(b.title || '')}"></div>
      <div class="fieldrow">
        <div class="field"><label class="fl">Needs from</label>
          <select data-e="needsFrom"><option value="">- not named -</option>
            ${data.org.departments.map((d) => `<option value="${esc(d.id)}"${d.id === b.needsFrom ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
          </select></div>
        <div class="field"><label class="fl">Owner</label><input type="text" data-e="owner" value="${esc(b.owner || '')}"></div>
        <div class="field"><label class="fl">Raised at</label><input type="date" data-e="raisedAt" value="${esc(b.raisedAt || '')}"></div>
      </div>
      <p class="hint" data-role="editmsg"></p>
    </div>
    <div class="acts">
      <button class="btn btn-sm btn-go" type="button" data-act="accept">Accept</button>
      <button class="btn btn-sm" type="button" data-act="edit">Edit</button>
      <button class="btn btn-sm btn-danger" type="button" data-act="reject">Reject</button>
      <span class="spacer"></span><span class="hint" data-role="msg"></span>
    </div>
  </article>`;
}

function ageWeeks(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  return Math.max(1, Math.ceil((Date.now() - t) / (7 * 86400000)));
}

/* ------------------------------ notes, numbers ---------------------------- */

function noteCard(row) {
  const n = row.item;
  return `<article class="review" id="note-${row.i}" data-kind="note" data-i="${row.i}">
    <div class="review-top">
      <span class="chip chip-info">${esc(n.cardId || 'no card')}</span>
      <span style="margin-left:auto">${stateChip(row)}</span>
    </div>
    <h3 style="font-size:14px;font-weight:500">${esc(n.text || '')}</h3>
    ${quoteBlock('verbatim', n.quote)}
    <div class="edit-grid" hidden data-role="edit">
      <div class="field"><label class="fl">The line under the card</label>
        <input type="text" data-e="text" value="${esc(n.text || '')}" maxlength="140"></div>
      <p class="hint">One sentence, under 20 words. Explain WHY the number is what it is - the card already says what it is.</p>
      <p class="hint" data-role="editmsg"></p>
    </div>
    <div class="acts">
      <button class="btn btn-sm btn-go" type="button" data-act="accept">Accept</button>
      <button class="btn btn-sm" type="button" data-act="edit">Edit</button>
      <button class="btn btn-sm btn-danger" type="button" data-act="reject">Reject</button>
      <span class="spacer"></span><span class="hint" data-role="msg"></span>
    </div>
  </article>`;
}

function numberCard(row) {
  const n = row.item;
  const measured = n.measuredValue;
  const gap = Number.isFinite(measured) && Number.isFinite(n.statedValue) && measured !== 0
    ? Math.abs((n.statedValue - measured) / measured)
    : null;
  const contradiction = gap !== null && gap > 0.1;

  return `<article class="review${contradiction ? ' ' : ''}" id="num-${row.i}" data-kind="number" data-i="${row.i}"
      ${contradiction ? 'style="border-color:rgba(255,55,95,.4)"' : ''}>
    <div class="review-top">
      <span class="chip chip-info">${esc(n.metricId || 'unmapped')}</span>
      ${contradiction ? '<span class="chip chip-bad">contradiction</span>' : ''}
      <span style="margin-left:auto">${stateChip(row)}</span>
    </div>
    <h3 style="font-size:14px;font-weight:500">
      ${esc(n.statedBy || 'someone')} said <b>${esc(String(n.statedValue))}</b>${
  Number.isFinite(measured) ? ` &middot; the data said <b style="color:${contradiction ? 'var(--red)' : 'var(--lime)'}">${esc(String(measured))}</b>` : ''}
    </h3>
    ${contradiction ? `<p class="hint" style="color:var(--red);margin-top:8px">A ${(gap * 100).toFixed(0)}% gap between what was said in the room and what the data read. This is the signal worth the most - it catches the week the team's story starts drifting from the numbers.</p>` : ''}
    ${quoteBlock('verbatim', n.quote)}
    <p class="hint" style="margin-top:10px">Recorded exactly as said. Do not correct it here - the engine's job is to catch the gap, and it can only do that if the quote stays faithful.</p>
    <div class="acts">
      <button class="btn btn-sm btn-go" type="button" data-act="accept">Accept</button>
      <button class="btn btn-sm btn-danger" type="button" data-act="reject">Reject</button>
      <span class="spacer"></span><span class="hint" data-role="msg"></span>
    </div>
  </article>`;
}

/* ------------------------------- wiring ----------------------------------- */

function rowFor(kind, i) {
  const bucket = { decision: 'decisions', blocker: 'blockers', note: 'notes', number: 'numbers' }[kind];
  return draft[bucket].find((r) => r.i === i);
}

function wireCard(node) {
  const kind = node.dataset.kind;
  const row = rowFor(kind, Number(node.dataset.i));
  const msg = node.querySelector('[data-role="msg"]');
  const editPane = node.querySelector('[data-role="edit"]');

  const setState = (state) => {
    row.state = state;
    node.classList.toggle('accepted', state === ACCEPTED);
    node.classList.toggle('rejected', state === REJECTED);
    node.querySelector('.review-top span:last-child').innerHTML = stateChip(row);
    repaintProgress();
  };

  node.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => {
    const act = btn.dataset.act;

    if (act === 'merge' || act === 'separate') {
      row.mergeChoice = act;
      node.querySelectorAll('[data-act="merge"],[data-act="separate"]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      msg.textContent = act === 'merge'
        ? 'Will update the existing decision rather than creating a second one.'
        : 'Will be created as a new decision alongside the existing one.';
      repaintProgress();
      return;
    }

    if (act === 'edit') {
      editPane.hidden = !editPane.hidden;
      btn.textContent = editPane.hidden ? 'Edit' : 'Done editing';
      if (editPane.hidden) applyEdits(node, row, msg);
      return;
    }

    if (act === 'accept') {
      if (!editPane || editPane.hidden) { if (editPane) applyEdits(node, row, msg); }
      const problem = validate(row);
      if (problem) {
        msg.className = 'hint hint-bad';
        msg.textContent = problem;
        if (editPane) { editPane.hidden = false; node.querySelector('[data-act="edit"]').textContent = 'Done editing'; }
        return;
      }
      msg.className = 'hint hint-ok';
      msg.textContent = 'Accepted.';
      setState(ACCEPTED);
      return;
    }

    if (act === 'reject') {
      msg.className = 'hint';
      msg.textContent = 'Rejected. It will not be written.';
      setState(REJECTED);
    }
  }));
}

function applyEdits(node, row, msg) {
  const edited = { ...row.item };
  node.querySelectorAll('[data-e]').forEach((input) => {
    const key = input.dataset.e;
    let v = input.value;
    if (key === 'metricIds') v = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (v === '') v = null;
    edited[key] = v;
  });
  row.edited = edited;
  row.item = edited;
  if (msg) { msg.className = 'hint'; msg.textContent = 'Edits held. They are written only on commit.'; }
}

/**
 * The same rules the database enforces, checked here so a reviewer finds out
 * now rather than at commit. The database still enforces them - this is a
 * courtesy, not the gate (see the trigger in supabase/schema.sql).
 */
function validate(row) {
  const it = row.item;
  if (row.kind === 'decision') {
    if (!it.headline || !String(it.headline).trim()) return 'A decision needs a headline.';
    if (['CHANGED', 'REVERSED', 'DEFERRED', 'DROPPED'].includes(it.status) && !String(it.reason || '').trim()) {
      return `A ${it.status} decision must say why. The database refuses it otherwise.`;
    }
  }
  if (row.kind === 'blocker') {
    if (!it.title || !String(it.title).trim()) return 'A blocker needs a title.';
    // org.json blockers.require_needs_from: "I am blocked" with no named other
    // end is not actionable, it is a mood.
    if (!it.needsFrom) return 'Name who can unblock this. A blocker with one end is not actionable.';
    if (it.status === 'resolved_in_room' && !String(it.resolution || '').trim()) {
      return 'A blocker resolved in the room needs the resolution written down, or it returns next week with a reset age.';
    }
  }
  if (row.kind === 'note' && !String(it.text || '').trim()) return 'A note needs a line.';
  return null;
}

/* ------------------------------ the review -------------------------------- */

function section(title, blurb, rows, renderer) {
  if (!rows.length) {
    return `<div class="sechead"><h2>${esc(title)}</h2><p>${esc(blurb)}</p></div>
      ${emptyState({ title: `Nothing extracted under ${title.toLowerCase()}`, next: 'If the meeting genuinely produced none, that is the right answer. If it did, the transcript may be missing that part - check it and extract again.' })}`;
  }
  return `<div class="sechead"><h2>${esc(title)}</h2><p>${esc(blurb)}</p></div>
    ${rows.map(renderer).join('')}`;
}

function renderReview() {
  const host = document.getElementById('stage-review');
  host.innerHTML = `
    ${draft.sample ? '<div class="banner banner-preview"><b>Sample extraction.</b> You are not signed in, so this is fixed example data to show how the review works. It cannot be committed.</div>' : ''}

    ${draft.injections.length ? `<div class="banner banner-err">
      <b>${draft.injections.length} line${draft.injections.length === 1 ? '' : 's'} in this transcript were addressed at the model, not at the room.</b>
      They are quoted below and nothing was derived from them. Statuses, decisions and blockers come only from what the room actually decided.
      <ul style="margin:10px 0 0;padding-left:18px">
        ${draft.injections.map((a) => `<li style="margin-bottom:7px"><q>${esc(a.quote)}</q>${a.speaker ? ` <span style="opacity:.75">- ${esc(a.speaker)}</span>` : ''}${a.note ? `<br><span class="hint">${esc(a.note)}</span>` : ''}</li>`).join('')}
      </ul></div>` : ''}

    <section class="card" id="rev-progress" style="margin-bottom:20px"></section>

    ${section('Decisions', 'Each one needs an accept or a reject. Check the headline against the quote.', draft.decisions, decisionCard)}
    ${section('Blockers', 'Two named ends and a specific ask, or it is not a blocker.', draft.blockers, blockerCard)}
    ${section('Notes', 'The one line under a card. The engine knows the number moved; only the room knows why.', draft.notes, noteCard)}
    ${section('Stated numbers', 'What people said out loud, against what the data read.', draft.numbers, numberCard)}

    <section class="card" style="margin-top:28px">
      <header><div><h3>Commit</h3>
      <p class="kicker" style="margin:5px 0 0">nothing above has been written yet</p></div></header>
      <p class="hint" style="margin-top:12px">Committing writes the accepted decisions, blockers, notes and stated numbers to the record, and files the rejected ones as reviewed-and-declined so the same suggestion does not come back next week as new.</p>
      <div class="btnrow" style="margin-top:16px">
        <button class="btn btn-go" id="rev-commit" type="button" disabled>Commit to the record</button>
        <button class="btn btn-quiet" id="rev-discard" type="button">Discard this draft</button>
        <span class="hint" id="rev-note"></span>
      </div>
      <div id="rev-report"></div>
    </section>

    <div id="stage-after"></div>`;

  host.querySelectorAll('article.review').forEach(wireCard);
  repaintProgress();

  document.getElementById('rev-discard').addEventListener('click', () => {
    draft = null;
    host.innerHTML = '';
    toast('Draft discarded. Nothing was written.');
  });
  document.getElementById('rev-commit').addEventListener('click', commit);

  if (!canSave()) {
    document.getElementById('rev-note').textContent = 'Preview mode - commit is disabled.';
  } else if (!ctx.isAdmin) {
    document.getElementById('rev-note').textContent = 'The decision log is admin-write in the database. Your review is saved as a draft an admin can commit.';
  }

  renderAfterSections();
}

/* -------------------------------- commit ---------------------------------- */

async function commit() {
  const btn = document.getElementById('rev-commit');
  btn.disabled = true;
  btn.textContent = 'Committing...';
  const reportHost = document.getElementById('rev-report');

  const accepted = {
    decisions: draft.decisions.filter((r) => r.state === ACCEPTED),
    blockers: draft.blockers.filter((r) => r.state === ACCEPTED),
    notes: draft.notes.filter((r) => r.state === ACCEPTED),
    numbers: draft.numbers.filter((r) => r.state === ACCEPTED)
  };

  try {
    // The draft is written first and in full - accepted, rejected and merge
    // choices alike. If the writes below fail halfway, the human's review is
    // not lost and nobody has to read the transcript twice.
    const drafts = await db.insert('pulse_extraction_drafts', [{
      meeting_kind: meeting.kind || meeting.id,
      meeting_date: draft.meetingDate,
      meeting_ref: draft.meetingId,
      payload: draft.raw,
      review: {
        decisions: draft.decisions.map((r) => ({ i: r.i, state: r.state, merge: r.mergeChoice, item: r.item })),
        blockers: draft.blockers.map((r) => ({ i: r.i, state: r.state, item: r.item })),
        notes: draft.notes.map((r) => ({ i: r.i, state: r.state, item: r.item })),
        numbers: draft.numbers.map((r) => ({ i: r.i, state: r.state, item: r.item }))
      },
      status: 'committed',
      created_by: ctx.session ? ctx.session.email : null,
      committed_at: new Date().toISOString()
    }]);

    const meetingRow = await db.upsert('pulse_meetings', [{
      date: draft.meetingDate,
      kind: meeting.kind || meeting.id
    }]).catch(() => null);
    const meetingId = Array.isArray(meetingRow) && meetingRow[0] ? meetingRow[0].id : null;

    let wrote = 0;
    const failures = [];

    for (const r of accepted.decisions) {
      const d = r.item;
      try {
        const rows = await db.upsert('pulse_decisions', [{
          number: d.number || null, domain: d.domain, headline: d.headline, status: d.status,
          carried_in: d.carriedIn, evidence: d.evidence, decided: d.decided,
          before_next_review: d.beforeNextReview, strip: d.strip,
          owner: d.owner || null, due_date: d.dueDate || null,
          reopen_condition: d.reopenCondition || null, metric_ids: d.metricIds || [],
          first_seen_meeting: meetingId, last_touched_meeting: meetingId,
          previous_state_unverified: !!d.previousStateUnverified,
          updated_at: new Date().toISOString()
        }]);
        const id = Array.isArray(rows) && rows[0] ? rows[0].id : null;
        if (id) {
          await db.insert('pulse_decision_events', [{
            decision_id: id, meeting_id: meetingId,
            from_status: r.mergeChoice === 'merge' && d._match ? 'OPEN' : null,
            to_status: d.status, reason: d.reason || null, quote: d.quote || null
          }]);
        }
        wrote += 1;
      } catch (err) { failures.push(`decision "${d.headline}": ${err.message}`); }
    }

    for (const r of accepted.notes) {
      try {
        await db.insert('pulse_notes', [{
          card_id: r.item.cardId, meeting_id: meetingId, text: r.item.text, quote: r.item.quote || null
        }]);
        wrote += 1;
      } catch (err) { failures.push(`note "${r.item.cardId}": ${err.message}`); }
    }

    for (const r of accepted.blockers) {
      try {
        await db.upsert('pulse_blockers', [{
          title: r.item.title, raised_by: r.item.raisedBy, needs_from: r.item.needsFrom,
          what: r.item.what, impact: r.item.impact, metric_ids: r.item.metricIds || [],
          raised_at: r.item.raisedAt || draft.meetingDate, status: r.item.status || 'open',
          owner: r.item.owner || null, due_date: r.item.dueDate || null,
          resolution: r.item.resolution || null,
          first_seen_meeting: meetingId, last_touched_meeting: meetingId
        }]);
        wrote += 1;
      } catch (err) { failures.push(`blocker "${r.item.title}": ${err.message}`); }
    }

    reportHost.innerHTML = `
      <div class="banner ${failures.length ? 'banner-warn' : ''}" style="margin-top:18px">
        <b>${esc(buildReport(accepted))}</b>
      </div>
      ${failures.length ? `<div class="banner banner-err"><b>${failures.length} item${failures.length === 1 ? '' : 's'} did not write.</b>
        <ul style="margin:8px 0 0;padding-left:18px">${failures.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <p style="margin:8px 0 0">Your full review was saved as a draft (${esc(drafts && drafts[0] ? String(drafts[0].id).slice(0, 8) : 'saved')}), so nothing needs reading twice.</p></div>` : ''}
      <p class="hint" style="margin-top:10px">${wrote} item${wrote === 1 ? '' : 's'} written. ${
  accepted.numbers.length} stated number${accepted.numbers.length === 1 ? '' : 's'} recorded against the snapshot for comparison.</p>`;

    btn.textContent = 'Committed';
    toast('Committed to the record');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Commit to the record';
    reportHost.innerHTML = errorState(err, 'Nothing was committed');
  }
}

/**
 * The sentence a founder reads before anything else. Same shape as
 * buildReport() in transcript/apply.js so the browser and the CLI say the
 * same thing about the same meeting.
 */
function buildReport(accepted) {
  const byStatus = (s) => accepted.decisions.filter((r) => r.item.status === s).length;
  const neu = accepted.decisions.filter((r) => r.item.status === 'NEW' || (!r.item.id && r.mergeChoice !== 'merge')).length;
  const changed = byStatus('CHANGED') + byStatus('REVERSED');
  const confirmed = byStatus('CONFIRMED') + byStatus('COMPLETED') + byStatus('PARTIAL');
  const blocked = byStatus('BLOCKED');
  const open = byStatus('OPEN') + byStatus('DEFERRED');
  const bNew = accepted.blockers.length;
  const bResolved = accepted.blockers.filter((r) => r.item.status === 'resolved_in_room').length;
  const bCarried = accepted.blockers.filter((r) => !['resolved_in_room', 'dropped'].includes(r.item.status)).length;

  return `${draft.meetingId} (${draft.meetingDate}): ${neu} decision${neu === 1 ? '' : 's'} new, `
    + `${changed} changed, ${confirmed} confirmed, ${blocked} blocked, ${open} left open; `
    + `${bNew} blocker${bNew === 1 ? '' : 's'} new, ${bResolved} resolved in the room, ${bCarried} carried.`;
}

/* ---------------------------------------------------------------------------
 * After the review - the two things the real WBR produces that nothing else
 * in the system was catching.
 * ------------------------------------------------------------------------- */

function renderAfterSections() {
  const host = document.getElementById('stage-after');
  host.innerHTML = `
    ${weekNumbersSection()}
    ${prioritiesSection()}`;
  wireWeekNumbers();
  wirePriorities();
}

/**
 * "This week in numbers" - three to five headline counts with a short caption.
 *
 * These are the lines like "5 new US brand POCs in production" and "21 showcase
 * campaigns live": counts that matter, that no sheet produces, and that map
 * onto the dashboard's tiles. Three is the floor because a strip of one is a
 * boast, not a picture.
 */
function weekNumbersSection() {
  const rows = [0, 1, 2, 3, 4].map((i) => `
    <div class="fieldrow" data-wn="${i}" style="margin-bottom:6px">
      <div class="field" style="max-width:150px">
        <label class="fl" for="wn-v-${i}">Count${i < 3 ? '' : ' (optional)'}</label>
        <input type="text" id="wn-v-${i}" data-f="value" inputmode="numeric" placeholder="${i === 0 ? '5' : ''}">
      </div>
      <div class="field">
        <label class="fl" for="wn-c-${i}">Caption</label>
        <input type="text" id="wn-c-${i}" data-f="caption" maxlength="90" placeholder="${i === 0 ? 'new US brand POCs in production' : ''}">
      </div>
    </div>`).join('');

  return `<div class="sechead" style="margin-top:40px">
      <h2>This week in numbers</h2>
      <p>Three to five headline counts. They become the tiles on the dashboard.</p>
    </div>
    <section class="card">
      <header>
        <div><h3>The strip</h3><p class="kicker" style="margin:5px 0 0">minimum three</p></div>
        <span class="chip chip-warn" id="wn-state">0 of 3</span>
      </header>
      <p class="hint" style="margin-top:12px">A count and what it counts. "5" and "new US brand POCs in production". Short enough to read at a glance, specific enough to be checkable next week.</p>
      <div style="margin-top:16px">${rows}</div>
      <div class="btnrow"><button class="btn btn-go btn-sm" id="wn-save" type="button" disabled>Save the strip</button>
      <span class="hint" id="wn-msg"></span></div>
    </section>`;
}

function wireWeekNumbers() {
  const inputs = [...document.querySelectorAll('[data-wn] input')];
  const state = document.getElementById('wn-state');
  const save = document.getElementById('wn-save');
  const msg = document.getElementById('wn-msg');

  const read = () => [...document.querySelectorAll('[data-wn]')].map((r) => ({
    value: r.querySelector('[data-f="value"]').value.trim(),
    caption: r.querySelector('[data-f="caption"]').value.trim()
  })).filter((x) => x.value || x.caption);

  const refresh = () => {
    const filled = read();
    const complete = filled.filter((x) => x.value && x.caption);
    const halves = filled.length - complete.length;
    state.textContent = `${complete.length} of 3`;
    state.className = `chip ${complete.length >= 3 ? 'chip-ok' : 'chip-warn'}`;
    save.disabled = complete.length < 3 || !canSave();
    msg.className = 'hint';
    msg.textContent = halves
      ? `${halves} row${halves === 1 ? ' has' : 's have'} a count without a caption, or the other way round. A number nobody can read is not a headline.`
      : (complete.length < 3 ? `${3 - complete.length} more to go.` : (canSave() ? '' : 'Preview mode - cannot save.'));
    if (halves) msg.className = 'hint hint-bad';
  };

  inputs.forEach((i) => i.addEventListener('input', refresh));
  refresh();

  save.addEventListener('click', async () => {
    const items = read().filter((x) => x.value && x.caption);
    try {
      await db.upsert('pulse_week_numbers', [{
        meeting_kind: meeting.kind || meeting.id,
        week_of: weekOf(document.getElementById('tx-date').value || today()).start,
        items,
        entered_by: ctx.session ? ctx.session.email : null,
        updated_at: new Date().toISOString()
      }], 'meeting_kind,week_of');
      msg.className = 'hint hint-ok';
      msg.textContent = `Saved ${items.length} headline numbers.`;
      toast('Week in numbers saved');
    } catch (err) { msg.className = 'hint hint-bad'; msg.textContent = err.message; }
  });
}

/**
 * "Top 3 priorities for next week, per person."
 *
 * In the real WBR this section had items from exactly one lead out of several.
 * That is not a discipline problem, it is a form problem: a Notion toggle gives
 * no indication that four people have not filled it in. So this one counts, by
 * name, and says who is missing.
 */
/** org.json's owners entry, in either the trio shape or the legacy single name. */
function ownerTeamOf(entry) {
  if (!entry) return [];
  if (Array.isArray(entry)) return entry;
  if (Array.isArray(entry.team)) return entry.team;
  return entry.name ? [entry.name] : [];
}

function prioritiesSection() {
  // One row per PERSON, not per department: three people own a line of
  // business and all three write their own priorities. A single row per
  // department would hide two of them, which is the failure this counts.
  const owners = Object.entries(data.org.owners || {}).flatMap(([deptId, o]) => {
    const dept = (data.org.departments.find((d) => d.id === deptId) || {}).label || deptId;
    const team = ownerTeamOf(o).filter((n) => n && n !== '[OWNER NEEDED]');
    if (!team.length) return [{ deptId, dept, name: null }];
    return team.map((name, i) => ({ deptId: team.length > 1 ? `${deptId}:${i}` : deptId, dept, name }));
  });

  return `<div class="sechead" style="margin-top:40px">
      <h2>Top 3 priorities for next week</h2>
      <p>Per person. Forward commitments, not a recap.</p>
    </div>
    <section class="card">
      <header>
        <div><h3>Who has filled this in</h3><p class="kicker" style="margin:5px 0 0">one lead out of several is the usual failure</p></div>
        <span class="chip chip-warn" id="pr-state">0 of ${owners.length}</span>
      </header>
      <div id="pr-progress" style="margin-top:12px"></div>
      <div id="pr-list" style="margin-top:18px">
        ${owners.map((o, i) => `
          <div class="card" style="background:#131313;box-shadow:none;margin-top:12px"
               data-pr="${esc(o.deptId)}" data-label="${esc(o.name || o.dept)}" data-owner="${esc(o.name || '')}">
            <header>
              <div><h3 style="font-size:13.5px">${o.name
    ? esc(o.name)
    : `${esc(o.dept)} <span class="chip chip-warn">owner needed</span>`}</h3>
              <p class="kicker" style="margin:4px 0 0">${esc(o.dept)}</p></div>
              <span class="chip chip-warn" data-role="n">0 of 3</span>
            </header>
            ${[0, 1, 2].map((k) => `
              <div class="field" style="margin-top:10px;margin-bottom:0">
                <label class="fl" for="pr-${i}-${k}">Priority ${k + 1}</label>
                <input type="text" id="pr-${i}-${k}" data-p="${k}" maxlength="120"
                  placeholder="${k === 0 ? 'Ship the enterprise pricing page' : ''}">
              </div>`).join('')}
          </div>`).join('')}
      </div>
      <div class="btnrow" style="margin-top:16px">
        <button class="btn btn-go btn-sm" id="pr-save" type="button" disabled>Save priorities</button>
        <span class="hint" id="pr-msg"></span>
      </div>
    </section>`;
}

function wirePriorities() {
  const blocks = [...document.querySelectorAll('[data-pr]')];
  const state = document.getElementById('pr-state');
  const prog = document.getElementById('pr-progress');
  const save = document.getElementById('pr-save');
  const msg = document.getElementById('pr-msg');

  // `label` is what a person is called in the "nothing yet from" line - the
  // owner's name when there is one, and the department when there is not.
  // Five identical "[OWNER NEEDED]"s tells nobody which team to go and ask.
  const read = () => blocks.map((b) => ({
    deptId: b.dataset.pr,
    label: b.dataset.label,
    name: b.dataset.owner || null,
    items: [...b.querySelectorAll('input[data-p]')].map((i) => i.value.trim()).filter(Boolean)
  }));

  const refresh = () => {
    const all = read();
    const done = all.filter((p) => p.items.length >= 1);
    const full = all.filter((p) => p.items.length === 3);
    blocks.forEach((b) => {
      const n = [...b.querySelectorAll('input[data-p]')].filter((i) => i.value.trim()).length;
      const chip = b.querySelector('[data-role="n"]');
      chip.textContent = `${n} of 3`;
      chip.className = `chip ${n === 3 ? 'chip-ok' : n ? 'chip-info' : 'chip-warn'}`;
    });
    state.textContent = `${done.length} of ${all.length}`;
    state.className = `chip ${done.length === all.length ? 'chip-ok' : 'chip-warn'}`;
    prog.innerHTML = progressBar(done.length, all.length);
    const missing = all.filter((p) => !p.items.length).map((p) => p.label);
    msg.className = missing.length ? 'hint hint-bad' : 'hint';
    msg.textContent = missing.length
      ? `Nothing yet from ${missing.join(', ')}.`
      : (full.length === all.length ? 'Everyone has three.' : 'Everyone has at least one.');
    save.disabled = !done.length || !canSave();
  };

  blocks.forEach((b) => b.querySelectorAll('input[data-p]').forEach((i) => i.addEventListener('input', refresh)));
  refresh();

  save.addEventListener('click', async () => {
    const all = read().filter((p) => p.items.length);
    try {
      await db.upsert('pulse_priorities', all.map((p) => ({
        dept_id: p.deptId,
        owner_name: p.name,
        week_of: weekOf(document.getElementById('tx-date').value || today()).start,
        items: p.items,
        entered_by: ctx.session ? ctx.session.email : null,
        updated_at: new Date().toISOString()
      })), 'dept_id,week_of');
      msg.className = 'hint hint-ok';
      msg.textContent = `Saved for ${all.length} ${all.length === 1 ? 'person' : 'people'}.`;
      toast('Priorities saved');
    } catch (err) { msg.className = 'hint hint-bad'; msg.textContent = err.message; }
  });
}

/* --------------------------------- boot ----------------------------------- */

async function render() {
  ctx = await boot({
    active: 'transcripts',
    title: 'Add a meeting',
    blurb: 'Paste the transcript, read every extracted decision, then commit. Nothing is written until you press the button. Sign in to start.'
  });
  if (!ctx.guard('#main')) { paintShell(ctx, { active: 'transcripts' }); return; }

  main.innerHTML = '<p class="hint">Loading...</p>';
  try { data = await loadAll(); } catch (err) {
    paintShell(ctx, { active: 'transcripts' });
    main.innerHTML = errorState(err, 'Could not read the configuration');
    return;
  }

  const allDeptIds = data.org.departments.map((d) => d.id);
  const labels = data.org.departments.filter((d) => ctx.scope(allDeptIds).includes(d.id)).map((d) => d.short || d.label);
  paintShell(ctx, { active: 'transcripts', deptLabels: labels });

  if (data.meetings._fallback) {
    banner('warn', '<b>Only one meeting is configured.</b> config/meetings.json does not exist yet, so this falls back to the single weekly review in config/org.json. The org runs several reviews a week - add that file (or rows in <code>pulse_meeting_kinds</code>) and they appear in this list with no code change.');
  }

  meetingPicker();
  main.innerHTML = stageInput();
  wireInput();
}

render().catch((err) => { main.innerHTML = errorState(err, 'This page could not start'); });
