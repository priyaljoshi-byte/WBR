/**
 * sources.js - "Where your numbers live".
 *
 * The screen a department head opens once. Three ways to connect one source,
 * and then the control that actually decides whether any of it works: the
 * column map.
 *
 * On the column map, stated plainly because it is the thing most likely to be
 * trimmed by someone in a hurry: the catalogue asks for `updated_on`, the sheet
 * has ``Date of Joining` `` with a stray backtick, and without a dropdown the
 * only fix is a code change. A system where connecting a sheet requires an
 * engineer is a system that never gets connected.
 *
 * Uploaded file content is DATA. It is parsed, escaped and shown. It is never
 * executed, never concatenated into markup, and never read as an instruction.
 */

import { boot, paintShell, banner } from './shell.js';
import { loadAll } from './configload.js';
import { parseRef, isPlaceholderRef, shareInstruction } from './refs.js';
import { parseCSV, dateColumnReport, dateHealth } from './csv.js';
import { suggestMapping, requiredColumnsForSource } from './mapping.js';
import { fetchSheetCsv, SHARE_FIX, fallbackWarning } from './sheets.js';
import { renderPreviewRings } from './compute-preview.js';
import { db, canSave } from './store.js';
import { PULSE_CONFIG } from './config.js';
import {
  esc, el, $, emptyState, errorState, toast, copyToClipboard,
  relativeTime, freshnessBadge, readFileAsText, dropZone, today
} from './ui.js';

const main = document.getElementById('main');
const params = new URLSearchParams(location.search);

let ctx = null;
let data = null;
let savedMappings = new Map();

/* ---------------------------------------------------------------------------
 * Connection state
 * ------------------------------------------------------------------------- */

/**
 * Three states, and the difference between them matters:
 *   not connected - nobody has pointed Pulse at anything. Setup work.
 *   erroring      - connected, but the last read failed. Someone's access broke.
 *   connected     - the last read worked.
 * Lumping "erroring" into "not connected" would hide the case where a sheet was
 * un-shared last Tuesday and every number since has been quietly missing.
 */
function connectionState(source) {
  if (isPlaceholderRef(source.ref)) return { id: 'none', label: 'not connected', chip: 'chip-warn' };
  if (source.last_sync_status === 'error') return { id: 'error', label: 'erroring', chip: 'chip-bad' };
  if (source.last_sync_status === 'empty') return { id: 'empty', label: 'connected, no rows', chip: 'chip-warn' };
  if (source.last_sync_status === 'ok') return { id: 'ok', label: 'connected', chip: 'chip-ok' };
  return { id: 'pending', label: 'connected, never read', chip: 'chip-info' };
}

/**
 * The freshness classification, from the stored sync - not recomputed here.
 * engine/freshness.js owns that arithmetic and reads row-level timestamps this
 * page never sees. Guessing a second answer in the browser is how two parts of
 * one system start disagreeing in public.
 */
function freshnessOf(source) {
  if (source.last_freshness) return source.last_freshness;
  if (!source.row_timestamp_column) return 'unknown';
  if (!source.last_synced_at) return 'unknown';
  return 'unknown';
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------- */

function deptPicker(deptIds, current) {
  const host = document.getElementById('deptpick');
  const depts = data.org.departments.filter((d) => deptIds.includes(d.id));
  if (depts.length <= 1) {
    host.innerHTML = depts.length
      ? `<p class="kicker">${esc(depts[0].label)}</p>` : '';
    return;
  }
  host.innerHTML = `<label class="fl" for="deptsel">Department</label>
    <select id="deptsel" style="min-width:230px">
      ${depts.map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
    </select>`;
  document.getElementById('deptsel').addEventListener('change', (e) => {
    const next = new URLSearchParams(location.search);
    next.set('dept', e.target.value);
    next.delete('source');
    location.search = next.toString();
  });
}

function sourceHeader(source, state) {
  const rows = source.last_row_count;
  return `<header>
    <div>
      <h3>${esc(source.label)}</h3>
      <p class="kicker" style="margin:5px 0 0">${esc(source.kind)}${source.segment ? ` &middot; ${esc(source.segment)}` : ''} &middot; ${esc(source.id)}</p>
    </div>
    <span class="chip ${state.chip}">${esc(state.label)}</span>
  </header>
  <div class="kv">
    <span>last sync <b>${esc(relativeTime(source.last_synced_at))}</b></span>
    <span>rows <b>${rows == null ? 'unknown' : esc(String(rows))}</b></span>
    <span>${freshnessBadge(freshnessOf(source))}</span>
    ${isPlaceholderRef(source.ref) ? '' : `<span>ref <b>${esc(String(source.ref).slice(0, 18))}${String(source.ref).length > 18 ? '...' : ''}</b></span>`}
  </div>
  ${source.last_sync_error
    ? `<div class="banner banner-err" style="margin-top:14px"><b>Last read failed.</b> ${esc(source.last_sync_error)}</div>`
    : ''}`;
}

function tabsFor(source, uid) {
  const manualOnly = source.kind === 'manual';
  const linkable = source.kind === 'gsheet' || source.kind === 'notion';
  return `<div class="tabs" role="tablist">
    ${linkable ? `<button role="tab" id="${uid}-t-link" aria-controls="${uid}-p-link" aria-selected="${!manualOnly}">Paste a link</button>` : ''}
    <button role="tab" id="${uid}-t-csv" aria-controls="${uid}-p-csv" aria-selected="${!linkable && !manualOnly}">Upload a CSV</button>
    <button role="tab" id="${uid}-t-manual" aria-controls="${uid}-p-manual" aria-selected="${manualOnly}">Type it in</button>
    <button role="tab" id="${uid}-t-list" aria-controls="${uid}-p-list" aria-selected="false">Track a list</button>
  </div>`;
}

/* ------------------------------- the card --------------------------------- */

function renderSource(source, canWrite) {
  const uid = `s-${source.id}`;
  const state = connectionState(source);
  const required = requiredColumnsForSource(source.id, data.catalog.metrics, source);
  const saved = savedMappings.get(source.id) || null;

  const card = el('section', { class: `card${state.id === 'none' || state.id === 'error' ? ' flag' : ''}`, id: uid });
  card.innerHTML = `
    ${sourceHeader(source, state)}
    ${source.notes ? `<p class="hint" style="margin-top:12px">${esc(source.notes)}</p>` : ''}
    ${source.kind === 'postgres'
      ? `<div class="banner" style="margin-top:16px"><b>An admin connects this one.</b> A database URL is a credential, so it lives in the server environment (<code>${esc(source.ref)}</code> in .env) and never in a browser. You can still upload a CSV export below if the read-only role is not ready.</div>`
      : ''}
    ${tabsFor(source, uid)}
    <div class="tabpane" id="${uid}-p-link" role="tabpanel" hidden></div>
    <div class="tabpane" id="${uid}-p-csv" role="tabpanel" hidden></div>
    <div class="tabpane" id="${uid}-p-manual" role="tabpanel" hidden></div>
    <div class="tabpane" id="${uid}-p-list" role="tabpanel" hidden></div>
    <div id="${uid}-map"></div>
  `;

  const panes = {
    link: card.querySelector(`#${CSS.escape(uid)}-p-link`),
    csv: card.querySelector(`#${CSS.escape(uid)}-p-csv`),
    manual: card.querySelector(`#${CSS.escape(uid)}-p-manual`),
    list: card.querySelector(`#${CSS.escape(uid)}-p-list`)
  };
  const mapHost = card.querySelector(`#${CSS.escape(uid)}-map`);

  [...card.querySelectorAll('.tabs button')].forEach((btn) => {
    btn.addEventListener('click', () => {
      [...card.querySelectorAll('.tabs button')].forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      for (const [k, p] of Object.entries(panes)) p.hidden = btn.id !== `${uid}-t-${k}`;
    });
  });
  const initial = card.querySelector('.tabs button[aria-selected="true"]') || card.querySelector('.tabs button');
  for (const [k, p] of Object.entries(panes)) p.hidden = initial.id !== `${uid}-t-${k}`;

  if (panes.link) renderLinkTab(panes.link, source, canWrite, mapHost, required, saved);
  renderCsvTab(panes.csv, source, canWrite, mapHost, required, saved);
  renderManualTab(panes.manual, source, canWrite, required);
  renderListTab(panes.list, source, canWrite);

  // Show whatever map is already saved, so a returning visitor sees their work.
  if (saved) renderMapping(mapHost, source, required, saved.detected_columns || [], saved.mapping || {}, canWrite, saved.date_order);

  return card;
}

/* ------------------------------ (a) a link -------------------------------- */

function renderLinkTab(pane, source, canWrite, mapHost, required, saved) {
  const uid = `lnk-${source.id}`;
  const connected = !isPlaceholderRef(source.ref);
  pane.innerHTML = `
    <div class="field">
      <label class="fl" for="${uid}">${source.kind === 'notion' ? 'Notion database link' : 'Google Sheets link'}</label>
      <input type="text" id="${uid}" spellcheck="false" autocomplete="off"
        placeholder="${source.kind === 'notion'
    ? 'https://www.notion.so/shopos/Delivery-Board-1a2b...'
    : 'https://docs.google.com/spreadsheets/d/1BxiMVs0.../edit'}"
        value="${connected ? '' : ''}">
      <p class="hint" id="${uid}-hint">Paste the whole thing from the address bar. Pulse pulls the id out and shows it back to you before anything is saved.</p>
    </div>
    <div id="${uid}-found"></div>
    <div class="btnrow"><button class="btn" id="${uid}-check" type="button">Check the link</button></div>
  `;

  const input = pane.querySelector(`#${CSS.escape(uid)}`);
  const hint = pane.querySelector(`#${CSS.escape(uid)}-hint`);
  const found = pane.querySelector(`#${CSS.escape(uid)}-found`);

  const check = () => {
    const parsed = parseRef(source.kind, input.value);
    if (!parsed.ok) {
      input.classList.add('bad');
      hint.className = 'hint hint-bad';
      hint.textContent = parsed.error;
      found.innerHTML = '';
      return null;
    }
    input.classList.remove('bad');
    hint.className = 'hint hint-ok';
    hint.textContent = 'That parses. Check the id below is the right document before connecting.';

    // Today a sheet is read straight from the browser, which needs link
    // sharing, not the service account (that is for the weekly server run).
    const share = source.kind === 'gsheet'
      ? { heading: 'Make sure the sheet is link-shared', body: SHARE_FIX, copy: null }
      : source.kind === 'notion'
        ? { ...shareInstruction('notion'), body: `${shareInstruction('notion').body} Pulse cannot read Notion from the browser yet, so until the weekly run is set up, use Export -> CSV in Notion and drop the file in the Upload a CSV tab.` }
        : shareInstruction(source.kind, PULSE_CONFIG.SERVICE_ACCOUNT_EMAIL);
    found.innerHTML = `
      <div class="copyrow">
        <span class="kicker">id found</span>
        <code>${esc(parsed.id)}</code>
      </div>
      ${parsed.titleSlug ? `<p class="hint">The link called it <b>${esc(parsed.titleSlug)}</b>. If that is not the right database, the link is wrong.</p>` : ''}
      ${parsed.viewIdIgnored ? `<p class="hint">That link also carried a saved-view id. Pulse ignored it on purpose - connecting to a view means reading a filtered subset forever without noticing.</p>` : ''}
      ${parsed.gid ? `<p class="hint">Tab id <code>${esc(parsed.gid)}</code> was in the link. Pulse reads the tab named in the metric definition (<b>${esc(source.tab || 'the first tab')}</b>), not the one you happened to be looking at.</p>` : ''}
      <div class="card" style="margin-top:14px;background:#131313;box-shadow:none">
        <h3>${esc(share.heading)}</h3>
        <p class="hint" style="margin-top:7px">${esc(share.body)}</p>
        ${share.copy ? `<div class="copyrow"><code id="${CSS.escape(uid)}-sa">${esc(share.copy)}</code>
          <button class="btn btn-sm" type="button" id="${CSS.escape(uid)}-copy">Copy</button></div>` : ''}
      </div>
      <div class="btnrow" style="margin-top:16px">
        ${source.kind === 'gsheet'
    ? `<button class="btn btn-go" id="${CSS.escape(uid)}-read" type="button"${canWrite ? '' : ' disabled'}>Connect and read the sheet now</button>
       <button class="btn" id="${CSS.escape(uid)}-save" type="button"${canWrite ? '' : ' disabled'}>Just save the link</button>`
    : `<button class="btn btn-go" id="${CSS.escape(uid)}-save" type="button"${canWrite ? '' : ' disabled'}>Connect this source</button>`}
        ${canWrite ? '' : '<span class="hint">You can read this department but not change it.</span>'}
      </div>
      <div id="${CSS.escape(uid)}-rows"></div>`;

    const readBtn = pane.querySelector(`#${CSS.escape(uid)}-read`);
    if (readBtn) {
      readBtn.addEventListener('click', async () => {
        const rowsOut = pane.querySelector(`#${CSS.escape(uid)}-rows`);
        readBtn.disabled = true;
        rowsOut.innerHTML = '<p class="hint">Reading the sheet from Google...</p>';
        try {
          if (!(await connect(source, parsed.id))) { rowsOut.innerHTML = ''; return; }
          const tab = source.tab || null;
          const gid = tab ? null : (parsed.gid || null);
          // Google answers an unknown tab with the first tab, so read the first
          // tab too and compare (see sheets.js).
          // gid 0 IS the first tab, so there is nothing to compare against.
          const first = tab || (gid && gid !== '0') ? await fetchSheetCsv(parsed.id) : null;
          const res = await fetchSheetCsv(parsed.id, { tab, gid, compareWith: first ? first.text : null });
          const label = `Google Sheet${tab ? ` - ${tab}` : ''}`;
          const proceed = (note) => showRows(rowsOut, `${uid}-sheet`, source, label, res.text,
            { canWrite, mapHost, required, saved, note, onCancel: () => {} });

          /**
           * THE SILENT WRONG TAB.
           *
           * Google does not fail on a tab name it does not recognise - it
           * returns the FIRST tab, with HTTP 200, looking exactly like a
           * success. A typo therefore yields a full table of entirely
           * plausible rows from the wrong part of the spreadsheet, and every
           * number computed from them is confidently wrong.
           *
           * A warning banner is not enough for that, because the rows below it
           * look fine and people map what is in front of them. So this stops
           * here: no preview, no column map, no rings, until somebody has
           * looked at the column names and said which of the two it is.
           */
          if (res.fellBack) {
            const ack = `ack-${source.id}`;
            rowsOut.innerHTML = `
              <div class="banner banner-err" style="margin-top:12px">
                <b>This may not be the tab you asked for.</b>
                <p style="margin:8px 0 0;font-size:13px;line-height:1.6">${esc(fallbackWarning(tab || `gid ${gid}`))}</p>
                <p style="margin:10px 0 0;font-size:13px;line-height:1.6">The first row of what Google
                actually sent is:</p>
                <div class="copyrow" style="margin-top:8px"><code>${esc(firstLineOf(res.text))}</code></div>
                <div class="btnrow" style="margin-top:14px">
                  <button class="btn btn-sm" type="button" id="${CSS.escape(ack)}-yes">Those are the right columns - carry on</button>
                  <button class="btn btn-quiet btn-sm" type="button" id="${CSS.escape(ack)}-no">That is the wrong tab - stop</button>
                </div>
              </div>`;
            rowsOut.querySelector(`#${CSS.escape(ack)}-yes`).addEventListener('click', () => {
              proceed(`<div class="banner banner-warn" style="margin-top:12px"><b>Tab confirmed by hand.</b>
                Google could not tell us whether "${esc(tab || `gid ${gid}`)}" matched, and you confirmed
                these columns are right.</div>`);
            });
            rowsOut.querySelector(`#${CSS.escape(ack)}-no`).addEventListener('click', () => {
              rowsOut.innerHTML = `<p class="hint hint-bad">Stopped. Check how the tab is spelled on the
                tab itself - spaces and "&amp;" included - then read it again.</p>`;
              mapHost.innerHTML = '';
            });
            return;
          }

          proceed('');
        } catch (err) {
          rowsOut.innerHTML = errorState(new Error(`${err.message}${err.fix ? ` ${err.fix}` : ''}`), 'Could not read that sheet');
        } finally {
          readBtn.disabled = false;
        }
      });
    }

    const copyBtn = pane.querySelector(`#${CSS.escape(uid)}-copy`);
    if (copyBtn) copyBtn.addEventListener('click', () => copyToClipboard(share.copy, 'Service account address'));

    pane.querySelector(`#${CSS.escape(uid)}-save`).addEventListener('click', async () => {
      await connect(source, parsed.id);
      // The columns are not known until the first sync, so the map opens on
      // what the metrics need with a way to supply the header row by hand.
      renderMapping(mapHost, source, required,
        (saved && saved.detected_columns) || [], (saved && saved.mapping) || {}, canWrite,
        saved && saved.date_order, { awaitingSync: true });
      mapHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return parsed;
  };

  pane.querySelector(`#${CSS.escape(uid)}-check`).addEventListener('click', check);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
  input.addEventListener('input', () => {
    input.classList.remove('bad');
    if (hint.className !== 'hint') { hint.className = 'hint'; hint.textContent = 'Paste the whole thing from the address bar. Pulse pulls the id out and shows it back to you before anything is saved.'; }
  });
}

async function connect(source, ref) {
  if (!canSave()) { toast('Preview mode - nothing was saved.', 'warn'); return false; }
  try {
    await db.upsert('pulse_sources', [{
      id: source.id,
      dept_id: source.dept,
      kind: source.kind,
      label: source.label,
      ref,
      tab: source.tab || null,
      header_row: source.header_row || 1,
      date_column: source.date_column || null,
      notes: source.notes || null,
      created_by: ctx.session ? ctx.session.email : null
    }], 'id');
    source.ref = ref;
    toast(`${source.label} connected`);
    const chip = document.querySelector(`#s-${CSS.escape(source.id)} .chip`);
    if (chip) { chip.className = 'chip chip-info'; chip.textContent = 'connected, never read'; }
    return true;
  } catch (err) {
    toast(err.message, 'warn');
    return false;
  }
}

/* ------------------------------- (b) a CSV -------------------------------- */

function renderCsvTab(pane, source, canWrite, mapHost, required, saved) {
  const uid = `csv-${source.id}`;
  pane.innerHTML = `
    <div class="drop" id="${uid}-drop" tabindex="0" role="button" aria-label="Choose a CSV file">
      <p><b>Drop a CSV here</b></p>
      <p class="drop-sub">or click to choose a file. It is read in your browser - the file itself is never uploaded anywhere until you press confirm.</p>
      <input type="file" id="${uid}-file" accept=".csv,text/csv,text/plain">
    </div>
    <div id="${uid}-out"></div>
  `;
  const drop = pane.querySelector(`#${CSS.escape(uid)}-drop`);
  const file = pane.querySelector(`#${CSS.escape(uid)}-file`);
  const out = pane.querySelector(`#${CSS.escape(uid)}-out`);

  const handle = async (files) => {
    const f = files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) {
      out.innerHTML = errorState(new Error(`${f.name} is ${(f.size / 1048576).toFixed(1)}MB. Export a narrower date range, or connect the sheet directly instead.`), 'That file is too big to parse in a browser');
      return;
    }
    out.innerHTML = '<p class="hint">Reading...</p>';
    let text;
    try { text = await readFileAsText(f); } catch (err) { out.innerHTML = errorState(err, 'Could not read that file'); return; }
    showRows(out, uid, source, f.name, text, { canWrite, mapHost, required, saved, onCancel: () => { file.value = ''; } });
  };

  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => handle([...file.files]));
  dropZone(drop, handle);
}

/**
 * Preview, date check, confirm-and-send - for rows from either a dropped CSV
 * or a Google Sheet read through sheets.js. One path from "rows in hand" on.
 */
function showRows(out, uid, source, name, text, { canWrite, mapHost, required, saved, onCancel, note }) {
  const f = { name }; // the preview below labels rows by "file"
  const parsed = parseCSV(text, { headerRow: source.header_row || 1 });
  if (!parsed.columns.length) {
    out.innerHTML = errorState(new Error('No header row was found. The first line should be the column names.'), `${name} did not parse`);
    return;
  }

  // Answers the person gives to "is 05/10/2026 October or May", per column.
  const answers = {};
  if (saved && saved.date_order && saved.date_order !== 'auto') {
    for (const c of parsed.columns) answers[c] = saved.date_order;
  }

  const paint = () => {
    const preview = parsed.rows.slice(0, 10);
    const dates = dateColumnReport(parsed, { dateOrders: answers });
    const health = dateHealth(dates);
    const blocked = health.asking > 0;

    out.innerHTML = `
      ${note || ''}
      <div class="kv" style="margin-top:16px">
        <span>file <b>${esc(f.name)}</b></span>
        <span>columns <b>${parsed.columns.length}</b></span>
        <span>rows <b>${parsed.rowCount}</b></span>
        <span>showing <b>first ${preview.length}</b></span>
      </div>
      ${parsed.warnings.length ? `<div class="banner banner-warn" style="margin-top:12px"><b>Worth a look.</b> ${esc(parsed.warnings.join('. '))}.</div>` : ''}

      ${dateBlock(dates, health, uid)}

      <div class="tablewrap">
        <table class="prev">
          <thead><tr><th class="rn">#</th>${parsed.columns.map((c) => {
  const d = dates.find((x) => x.column === c);
  return `<th>${esc(c)}${d ? `<br><span style="color:${d.needsAsk || d.basis === 'conflict' ? 'var(--amber)' : 'var(--fg-3)'};text-transform:none;letter-spacing:0">${esc(dateTag(d))}</span>` : ''}</th>`;
}).join('')}</tr></thead>
          <tbody>${preview.map((r, i) => `<tr><td class="rn">${i + 1}</td>${parsed.columns.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      ${parsed.rowCount === 0 ? `<div class="banner banner-warn" style="margin-top:12px"><b>Header only.</b> The file has column names but no data rows.</div>` : ''}
      <div class="btnrow" style="margin-top:16px">
        <button class="btn btn-go" id="${CSS.escape(uid)}-confirm" type="button"${canWrite && parsed.rowCount && !blocked ? '' : ' disabled'}>Confirm and send ${parsed.rowCount} rows</button>
        <button class="btn btn-quiet" id="${CSS.escape(uid)}-cancel" type="button">Start again</button>
        ${blocked ? '<span class="hint hint-bad">Answer the date question above first.</span>' : ''}
      </div>`;

    // The two buttons that settle an ambiguous column.
    out.querySelectorAll('[data-dateans]').forEach((btn) => btn.addEventListener('click', () => {
      answers[btn.dataset.col] = btn.dataset.dateans;
      paint();
      toast(`${btn.dataset.col} read as ${btn.dataset.dateans === 'DMY' ? 'day first' : 'month first'}`);
      // The answer belongs to the source, not to this one upload - the next
      // export of the same sheet will have the same convention.
      persistDateOrder(source, btn.dataset.dateans);
    }));

    out.querySelector(`#${CSS.escape(uid)}-cancel`).addEventListener('click', () => { out.innerHTML = ''; if (onCancel) onCancel(); });
    const confirmBtn = out.querySelector(`#${CSS.escape(uid)}-confirm`);
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Sending...';
        const ok = await sendUpload(source, f.name, parsed, dates);
        confirmBtn.textContent = ok ? 'Sent' : 'Try again';
        confirmBtn.disabled = !!ok;
      });
    }
  };

  paint();

  renderMapping(mapHost, source, required, parsed.columns,
    Object.fromEntries(suggestMapping(required.map((r) => r.column), parsed.columns)
      .map((r) => [r.required, r.detected])),
    canWrite, saved && saved.date_order,
    // The rows themselves, so the map can draw the numbers it produces.
    { parsed });
  mapHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** The header row Google actually sent, for the "is this your tab" question. */
function firstLineOf(text) {
  const line = String(text || '').split(/\r?\n/)[0] || '';
  return line.length > 180 ? `${line.slice(0, 180)}...` : line;
}

/* --------------------------- the date moment ------------------------------ */

const humanDay = (iso) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** The one-line label under a column header in the preview. */
function dateTag(d) {
  if (d.basis === 'conflict') return 'dates disagree';
  if (d.needsAsk) return 'date order unknown';
  if (d.basis === 'evidence') return d.order === 'DMY' ? 'day first' : 'month first';
  if (d.basis === 'config') return d.order === 'DMY' ? 'day first (set)' : 'month first (set)';
  return 'dates';
}

/**
 * THE AMBIGUITY MOMENT.
 *
 * When the column's own rows settle the order, this says so quietly and moves
 * on - "dates read as day first, because 21/09/2026 cannot be a month". The
 * sentence is there so somebody can object if the evidence misled.
 *
 * When nothing settles it, it ASKS, with the offending cell and both readings
 * spelled out as real days. This is the best place in the entire product to
 * catch it: the person uploading the file is the one person who knows whether
 * they meant October or May, and five minutes later nobody will.
 */
function dateBlock(dates, health, uid) {
  if (!dates.length) return '';

  const asking = dates.filter((d) => d.needsAsk && d.question);
  const conflicts = dates.filter((d) => d.basis === 'conflict');
  const settled = dates.filter((d) => d.basis === 'evidence' || d.basis === 'config');

  const questions = asking.map((d) => `
    <div class="banner banner-warn" style="margin-top:12px">
      <b>Which day does ${esc(d.column)} mean?</b>
      <p style="margin:8px 0 0;font-size:13px;line-height:1.6">Every slash date in this column reads
      both ways, so nothing in the file settles it. <code>${esc(d.question.value)}</code> is either
      of these two days and they are five months apart.</p>
      <div class="btnrow" style="margin-top:12px">
        <button class="btn btn-sm" type="button" data-dateans="DMY" data-col="${esc(d.column)}">
          ${esc(humanDay(d.question.DMY))} &middot; day first</button>
        <button class="btn btn-sm" type="button" data-dateans="MDY" data-col="${esc(d.column)}">
          ${esc(humanDay(d.question.MDY))} &middot; month first</button>
      </div>
      <p class="hint" style="margin-top:9px">Your answer is saved against this source, so the next
      export of the same sheet does not ask again.</p>
    </div>`).join('');

  const conflictBlocks = conflicts.map((d) => `
    <div class="banner banner-err" style="margin-top:12px">
      <b>${esc(d.column)} holds both date orders at once.</b>
      <p style="margin:8px 0 0;font-size:13px;line-height:1.6">${esc(d.warnings[0] || '')}</p>
      <p class="hint" style="margin-top:8px">There is no answer that is true of this column, so this
      one is not a question - the mixed rows need fixing in the sheet. Ambiguous rows will import
      undated rather than wrong.</p>
    </div>`).join('');

  const quiet = settled.length
    ? `<p class="hint" style="margin-top:12px">${settled.map((d) => (
      d.basis === 'evidence'
        ? `Dates in <b>${esc(d.column)}</b> read as ${d.order === 'DMY' ? 'day first' : 'month first'}${d.example ? `, based on <code>${esc(d.example)}</code>` : ''}.`
        : `Dates in <b>${esc(d.column)}</b> read as ${d.order === 'DMY' ? 'day first' : 'month first'}, as set on this source.`
    )).join(' ')} Say so now if that is wrong.</p>`
    : '';

  // The count that has to be seen before confirm. 40 unparseable dates must not
  // import quietly.
  const bad = health.unreadable + health.unresolved;
  const counts = `<div class="kv" style="margin-top:12px">
      <span>date cells read <b style="color:var(--lime)">${dates.reduce((n, d) => n + d.parsed, 0)}</b></span>
      <span>unreadable <b style="color:${health.unreadable ? 'var(--red)' : 'var(--fg-2)'}">${health.unreadable}</b></span>
      <span>ambiguous, left undated <b style="color:${health.unresolved ? 'var(--amber)' : 'var(--fg-2)'}">${health.unresolved}</b></span>
      <span>blank <b>${health.blanks}</b></span>
    </div>
    ${bad ? `<p class="hint hint-bad" style="margin-top:8px">${bad} date cell${bad === 1 ? '' : 's'} will import without a day on ${bad === 1 ? 'it' : 'them'}. The rows are kept and left undated rather than dropped or guessed at, but they will not fall inside any period filter.</p>` : ''}`;

  return `<div id="${CSS.escape(uid)}-dates">
    <div class="sechead" style="margin:22px 0 0"><h2 style="font-size:14px">Dates</h2>
      <p>${esc(dates.length)} date column${dates.length === 1 ? '' : 's'} found</p></div>
    ${counts}${quiet}${questions}${conflictBlocks}
  </div>`;
}

/** The answer belongs to the source. Stored in the same row the column map uses. */
async function persistDateOrder(source, order) {
  if (!canSave()) return;
  const existing = savedMappings.get(source.id) || {};
  try {
    await db.upsert('pulse_column_mappings', [{
      source_id: source.id,
      dept_id: source.dept,
      mapping: existing.mapping || {},
      detected_columns: existing.detected_columns || [],
      date_order: order,
      updated_by: ctx.session ? ctx.session.email : null,
      updated_at: new Date().toISOString()
    }], 'source_id');
    savedMappings.set(source.id, { ...existing, date_order: order });
  } catch { /* the upload still works; the answer just is not remembered */ }
}

async function sendUpload(source, filename, parsed, dates) {
  if (!canSave()) { toast('Preview mode - nothing was sent.', 'warn'); return false; }
  try {
    await db.insert('pulse_uploads', [{
      source_id: source.id,
      dept_id: source.dept,
      filename,
      columns: parsed.columns,
      row_count: parsed.rowCount,
      rows: parsed.rows,
      // What was known about the dates at the moment of upload, kept with the
      // rows. "Which way did we read this column in October" has an answer.
      date_report: (dates || []).map((d) => ({
        column: d.column, order: d.order, basis: d.basis,
        unreadable: d.unreadable, unresolved: d.unresolved, blanks: d.blanks
      })),
      uploaded_by: ctx.session ? ctx.session.email : null
    }]);
    toast(`${parsed.rowCount} rows sent for ${source.label}`);
    return true;
  } catch (err) {
    toast(err.message, 'warn');
    return false;
  }
}

/* ----------------------------- (c) type it in ----------------------------- */

function renderManualTab(pane, source, canWrite, required) {
  const uid = `man-${source.id}`;
  const metrics = data.catalog.metrics.filter((m) => m.source && m.source.ref === source.id);

  if (!required.length) {
    pane.innerHTML = emptyState({
      title: 'Nothing to type in for this source',
      next: 'No metric in the catalogue reads it yet. Add one in config/catalog.json, or pick a different source.'
    });
    return;
  }

  pane.innerHTML = `
    <p class="hint">For numbers with no system behind them. ${source.kind === 'manual'
    ? 'This source is manual by definition.'
    : 'Use this when the sheet is not ready yet - but it is a stopgap, not a plan.'}
    <b>A typed value does not carry forward.</b> If nobody enters it next week the metric comes back
    empty and a flag goes up, which is the correct outcome - a stale number repeating itself is how
    a dashboard starts lying.</p>
    <div class="field" style="max-width:220px;margin-top:16px">
      <label class="fl" for="${uid}-date">Entered for</label>
      <input type="date" id="${uid}-date" value="${today()}">
    </div>
    <div class="fieldrow">
      ${required.map((r) => `
        <div class="field">
          <label class="fl" for="${uid}-f-${esc(r.column)}">${esc(r.column)}</label>
          <input type="text" id="${uid}-f-${esc(r.column)}" data-col="${esc(r.column)}" inputmode="decimal" autocomplete="off">
          <p class="hint">${esc(r.why.join(', '))}</p>
        </div>`).join('')}
    </div>
    ${metrics.length ? `<p class="hint">Feeds: ${esc(metrics.map((m) => m.label).join(', '))}.</p>` : ''}
    <div class="btnrow" style="margin-top:14px">
      <button class="btn btn-go" id="${CSS.escape(uid)}-save" type="button"${canWrite ? '' : ' disabled'}>Save this week's numbers</button>
    </div>`;

  pane.querySelector(`#${CSS.escape(uid)}-save`).addEventListener('click', async () => {
    const payload = {};
    let any = false;
    [...pane.querySelectorAll('input[data-col]')].forEach((input) => {
      const v = input.value.trim();
      if (v === '') return;
      any = true;
      const n = Number(v);
      payload[input.dataset.col] = Number.isFinite(n) && v !== '' ? n : v;
    });
    if (!any) { toast('Nothing typed in yet.', 'warn'); return; }
    if (!canSave()) { toast('Preview mode - nothing was saved.', 'warn'); return; }
    try {
      await db.upsert('pulse_manual_values', [{
        source_id: source.id,
        dept_id: source.dept,
        entered_for: pane.querySelector(`#${CSS.escape(uid)}-date`).value,
        payload,
        entered_by: ctx.session ? ctx.session.email : null
      }], 'source_id,entered_for');
      toast(`Saved for ${source.label}`);
    } catch (err) {
      toast(err.message, 'warn');
    }
  });
}

/* ------------------------- (d) track a list ------------------------------- */

/**
 * The fourth way in, for the thing that has no spreadsheet at all.
 *
 * The real review carries tables like Brand | Stage | Next | Owner - a per-row
 * pipeline list that lives nowhere except a Notion toggle somebody retypes each
 * week. There is no sheet to connect and no metric to aggregate, so neither of
 * the first three tabs fits. This one captures the rows directly.
 *
 * The one rule it enforces: every row needs an owner. A row with a stage and a
 * next step but no name is the exact shape of work that quietly belongs to
 * nobody, and the count at the top of the tab says how many are in that state.
 */
const LIST_PRESETS = {
  default: ['Item', 'Stage', 'Next', 'Owner'],
  india_crm: ['Brand', 'Stage', 'Next', 'Owner'],
  us_crm: ['Brand', 'Stage', 'Next', 'Owner'],
  sloosh_board: ['Workstream', 'Stage', 'Next', 'Owner'],
  hiring_tracker: ['Role', 'Stage', 'Next', 'Owner']
};

function renderListTab(pane, source, canWrite) {
  const uid = `lst-${source.id}`;
  const columns = LIST_PRESETS[source.id] || LIST_PRESETS.default;
  let rows = [];

  const ownerIndex = columns.findIndex((c) => c.toLowerCase() === 'owner');

  const blankRow = () => columns.map(() => '');

  const draw = () => {
    if (!rows.length) rows = [blankRow(), blankRow(), blankRow()];
    const filled = rows.filter((r) => r.some((c) => c.trim()));
    const unowned = filled.filter((r) => ownerIndex >= 0 && !r[ownerIndex].trim());

    pane.innerHTML = `
      <p class="hint">For a list that has no spreadsheet behind it - the per-row table the review
      carries by hand. <b>Every row needs an owner.</b> A row with a stage and a next step but no
      name is work that belongs to nobody, which is how it survives three reviews untouched.</p>

      <div class="kv" style="margin-top:14px">
        <span>rows <b>${filled.length}</b></span>
        <span>without an owner <b style="color:${unowned.length ? 'var(--amber)' : 'var(--lime)'}">${unowned.length}</b></span>
      </div>

      <div class="tablewrap" style="max-height:none">
        <table class="prev">
          <thead><tr><th class="rn">#</th>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}<th></th></tr></thead>
          <tbody>
            ${rows.map((row, ri) => `<tr data-r="${ri}">
              <td class="rn">${ri + 1}</td>
              ${row.map((cell, ci) => `<td style="padding:4px 6px">
                <input type="text" data-r="${ri}" data-c="${ci}" value="${esc(cell)}"
                  placeholder="${esc(columns[ci])}"
                  style="padding:6px 9px;font-size:12px;border-radius:9px;min-width:110px${
  ci === ownerIndex && !cell.trim() && row.some((x) => x.trim()) ? ';border-color:rgba(255,180,84,.5)' : ''}"
                  ${canWrite ? '' : 'disabled'}>
              </td>`).join('')}
              <td style="padding:4px 6px">
                <button class="btn btn-sm btn-quiet" type="button" data-del="${ri}" title="Remove row"${canWrite ? '' : ' disabled'}>&times;</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="btnrow" style="margin-top:14px">
        <button class="btn btn-sm" type="button" id="${CSS.escape(uid)}-add"${canWrite ? '' : ' disabled'}>Add a row</button>
        <button class="btn btn-go btn-sm" type="button" id="${CSS.escape(uid)}-save"${canWrite ? '' : ' disabled'}>Save the list</button>
        <span class="hint" id="${CSS.escape(uid)}-msg">${unowned.length
    ? `${unowned.length} row${unowned.length === 1 ? '' : 's'} still have no owner.`
    : ''}</span>
      </div>`;

    pane.querySelectorAll('input[data-r]').forEach((input) => {
      input.addEventListener('input', () => {
        rows[Number(input.dataset.r)][Number(input.dataset.c)] = input.value;
      });
      input.addEventListener('blur', () => {
        const msg = pane.querySelector(`#${CSS.escape(uid)}-msg`);
        const f = rows.filter((r) => r.some((c) => c.trim()));
        const u = f.filter((r) => ownerIndex >= 0 && !r[ownerIndex].trim());
        if (msg) {
          msg.className = u.length ? 'hint hint-bad' : 'hint';
          msg.textContent = u.length ? `${u.length} row${u.length === 1 ? '' : 's'} still have no owner.` : '';
        }
      });
    });

    pane.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => {
      rows.splice(Number(btn.dataset.del), 1);
      draw();
    }));

    pane.querySelector(`#${CSS.escape(uid)}-add`).addEventListener('click', () => {
      rows.push(blankRow());
      draw();
    });

    pane.querySelector(`#${CSS.escape(uid)}-save`).addEventListener('click', async () => {
      const keep = rows.filter((r) => r.some((c) => c.trim()));
      if (!keep.length) { toast('Nothing to save yet.', 'warn'); return; }
      const unownedNow = keep.filter((r) => ownerIndex >= 0 && !r[ownerIndex].trim());
      if (unownedNow.length) {
        const msg = pane.querySelector(`#${CSS.escape(uid)}-msg`);
        msg.className = 'hint hint-bad';
        msg.textContent = `${unownedNow.length} row${unownedNow.length === 1 ? '' : 's'} have no owner. Name somebody on each before saving.`;
        return;
      }
      if (!canSave()) { toast('Preview mode - nothing was saved.', 'warn'); return; }
      try {
        await db.upsert('pulse_lists', [{
          id: `${source.id}-list`,
          source_id: source.id,
          dept_id: source.dept,
          label: `${source.label} list`,
          columns,
          rows: keep.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
          updated_by: ctx.session ? ctx.session.email : null,
          updated_at: new Date().toISOString()
        }], 'id');
        toast(`${keep.length} rows saved`);
      } catch (err) { toast(err.message, 'warn'); }
    });
  };

  const prime = async () => {
    if (canSave()) {
      try {
        const saved = await db.select('pulse_lists', { eq: { source_id: source.id }, limit: 1 });
        if (saved.length && Array.isArray(saved[0].rows) && saved[0].rows.length) {
          const cols = saved[0].columns && saved[0].columns.length ? saved[0].columns : columns;
          rows = saved[0].rows.map((r) => cols.map((c) => String(r[c] == null ? '' : r[c])));
        }
      } catch { /* table not created yet - start blank */ }
    }
    draw();
  };
  prime();
}

/* ---------------------------- the column map ------------------------------ */

/** Matches DATE_ORDERS in engine/dates.js. Only slash dates are ambiguous -
 *  a year-first date needs no setting, so there is no option for one. */
const DATE_ORDERS = [
  ['auto', 'work it out from the column'],
  ['DMY', '05/10/2026 is 5 October (day first)'],
  ['MDY', '05/10/2026 is 10 May (month first)']
];

function renderMapping(host, source, required, detected, current, canWrite, dateOrder, opts = {}) {
  const uid = `map-${source.id}`;
  if (!required.length) { host.innerHTML = ''; return; }

  const rows = required.map((r) => ({
    ...r,
    chosen: current && Object.prototype.hasOwnProperty.call(current, r.column) ? current[r.column] : null
  }));
  const unmapped = rows.filter((r) => !r.chosen).length;

  host.innerHTML = `
    <div class="sechead" style="margin:28px 0 10px">
      <h2>Column map</h2>
      <p>What the metrics ask for, against what your file actually calls it.</p>
    </div>
    <p class="hint">Real sheets have columns like <code>Date of Joining\`</code> with a stray backtick in them.
    This is where that gets absorbed, so nobody has to edit JSON to connect a spreadsheet.
    ${unmapped ? `<b>${unmapped} still unmapped.</b> An unmapped column means that metric reads empty.` : 'Everything the metrics need is mapped.'}</p>
    ${opts.awaitingSync && !detected.length
    ? `<div class="banner" style="margin-top:14px"><b>Columns are not known yet.</b> Pulse will read them on the first sync and pre-fill this map. If you already know the header row, paste it below and the map fills in now.
         <div class="copyrow" style="margin-top:10px">
           <input type="text" id="${CSS.escape(uid)}-paste" placeholder="deal, owner, stage, value, updated_on" style="flex:1 1 220px">
           <button class="btn btn-sm" type="button" id="${CSS.escape(uid)}-pastebtn">Use these</button>
         </div></div>`
    : ''}
    <div class="map">
      <div class="map-head">
        <span>the metric needs</span><span></span><span>your file calls it</span><span class="map-why">match</span>
      </div>
      ${rows.map((r) => {
    const options = [`<option value="">- not mapped -</option>`]
      .concat(detected.map((d) => `<option value="${esc(d)}"${d === r.chosen ? ' selected' : ''}>${esc(d)}</option>`));
    if (r.chosen && !detected.includes(r.chosen)) {
      options.splice(1, 0, `<option value="${esc(r.chosen)}" selected>${esc(r.chosen)} (saved)</option>`);
    }
    const exact = r.chosen && r.chosen.toLowerCase().replace(/[^a-z0-9]+/g, '') === r.column.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return `<div class="map-row${r.chosen ? '' : ' unmapped'}">
          <span class="map-need"><b>${esc(r.column)}</b><em>${esc(r.why.join(', '))}</em></span>
          <span class="map-arrow">&rarr;</span>
          <select data-need="${esc(r.column)}"${canWrite ? '' : ' disabled'}>${options.join('')}</select>
          <span class="map-why">${r.chosen
      ? `<span class="chip ${exact ? 'chip-ok' : 'chip-info'}">${exact ? 'exact' : 'suggested'}</span>`
      : `<span class="chip chip-warn">none</span>`}</span>
        </div>`;
  }).join('')}
    </div>
    <div class="fieldrow" style="margin-top:16px;max-width:520px">
      <div class="field">
        <label class="fl" for="${CSS.escape(uid)}-dates">How this source writes dates</label>
        <select id="${CSS.escape(uid)}-dates"${canWrite ? '' : ' disabled'}>
          ${DATE_ORDERS.map(([v, l]) => `<option value="${v}"${(dateOrder || 'auto') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <p class="hint">Leave this on "work it out" unless it gets it wrong. The column usually
        settles itself - one row reading 21/09/2026 proves the whole column is day-first, which is
        evidence rather than a guess. Set it explicitly only when every date in the column is
        ambiguous.</p>
      </div>
    </div>
    <div class="btnrow" style="margin-top:14px">
      <button class="btn btn-go" id="${CSS.escape(uid)}-save" type="button"${canWrite ? '' : ' disabled'}>Save the map</button>
      ${detected.length ? `<button class="btn btn-quiet" id="${CSS.escape(uid)}-auto" type="button">Re-suggest</button>` : ''}
      ${canWrite ? '' : '<span class="hint">Read only - ask your department owner or an admin.</span>'}
    </div>
    <div id="${CSS.escape(uid)}-rings"></div>`;

  const selects = [...host.querySelectorAll('select[data-need]')];

  /**
   * THE LOOP CLOSING.
   *
   * With a file in hand, the rings it produces are drawn right here and
   * redrawn on every change to the map. Changing a dropdown and watching a
   * ring go from empty to 4.47 Cr is the entire feedback loop this screen was
   * missing - and watching it stay empty is how somebody finds out their map
   * is wrong while they can still fix it.
   */
  const ringsHost = host.querySelector(`#${CSS.escape(uid)}-rings`);
  const drawRings = () => {
    if (!ringsHost || !opts.parsed) return;
    const mapping = {};
    selects.forEach((s) => { mapping[s.dataset.need] = s.value || null; });
    try {
      renderPreviewRings(ringsHost, {
        source,
        parsed: opts.parsed,
        mapping,
        catalogMetrics: data.catalog.metrics,
        org: data.org
      });
    } catch (err) {
      ringsHost.innerHTML = errorState(err, 'The engine could not compute these rows');
    }
  };

  selects.forEach((s) => s.addEventListener('change', () => {
    s.closest('.map-row').classList.toggle('unmapped', !s.value);
    const chipSpan = s.closest('.map-row').querySelector('.map-why');
    chipSpan.innerHTML = s.value ? `<span class="chip chip-info">chosen</span>` : `<span class="chip chip-warn">none</span>`;
    drawRings();
  }));

  drawRings();

  const pasteBtn = host.querySelector(`#${CSS.escape(uid)}-pastebtn`);
  if (pasteBtn) {
    pasteBtn.addEventListener('click', () => {
      const raw = host.querySelector(`#${CSS.escape(uid)}-paste`).value;
      const cols = raw.split(/[,\t]/).map((c) => c.trim()).filter(Boolean);
      if (!cols.length) { toast('Type the header names, separated by commas.', 'warn'); return; }
      const suggested = Object.fromEntries(
        suggestMapping(required.map((r) => r.column), cols).map((r) => [r.required, r.detected])
      );
      renderMapping(host, source, required, cols, suggested, canWrite, host.querySelector(`#${CSS.escape(uid)}-dates`).value, opts);
    });
  }

  const autoBtn = host.querySelector(`#${CSS.escape(uid)}-auto`);
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      const suggested = Object.fromEntries(
        suggestMapping(required.map((r) => r.column), detected).map((r) => [r.required, r.detected])
      );
      renderMapping(host, source, required, detected, suggested, canWrite, host.querySelector(`#${CSS.escape(uid)}-dates`).value, opts);
    });
  }

  host.querySelector(`#${CSS.escape(uid)}-save`).addEventListener('click', async () => {
    const mapping = {};
    selects.forEach((s) => { mapping[s.dataset.need] = s.value || null; });
    const order = host.querySelector(`#${CSS.escape(uid)}-dates`).value;
    if (!canSave()) { toast('Preview mode - nothing was saved.', 'warn'); return; }
    try {
      await db.upsert('pulse_column_mappings', [{
        source_id: source.id,
        dept_id: source.dept,
        mapping,
        detected_columns: detected,
        date_order: order,
        updated_by: ctx.session ? ctx.session.email : null,
        updated_at: new Date().toISOString()
      }], 'source_id');
      savedMappings.set(source.id, { mapping, detected_columns: detected, date_order: order });
      toast('Column map saved');
    } catch (err) {
      toast(err.message, 'warn');
    }
  });
}

/* --------------------------------- boot ----------------------------------- */

async function render() {
  ctx = await boot({
    active: 'sources',
    title: 'Where your numbers live',
    blurb: 'Connect the sheet, board or database your team already uses, and map its columns to what the metrics need. Sign in to see your department.'
  });

  if (!ctx.guard('#main')) { paintShell(ctx, { active: 'sources' }); return; }

  main.innerHTML = '<p class="hint">Reading config...</p>';
  try {
    data = await loadAll();
  } catch (err) {
    paintShell(ctx, { active: 'sources' });
    main.innerHTML = errorState(err, 'Could not read the configuration');
    return;
  }

  const allDeptIds = data.org.departments.map((d) => d.id);
  const mine = ctx.scope(allDeptIds);
  const labels = data.org.departments.filter((d) => mine.includes(d.id)).map((d) => d.short || d.label);
  paintShell(ctx, { active: 'sources', deptLabels: labels });

  if (data.liveError) {
    banner('warn', `<b>Showing the seed from config/.</b> Supabase did not answer: ${esc(data.liveError)}`);
  }

  if (canSave()) {
    try {
      const rows = await db.select('pulse_column_mappings');
      savedMappings = new Map(rows.map((r) => [r.source_id, r]));
    } catch { /* table not created yet - the map still works, it just starts blank */ }
  }

  const wanted = params.get('dept');
  const current = mine.includes(wanted) ? wanted : mine[0];
  deptPicker(mine, current);

  const list = data.sources.sources.filter((s) => s.dept === current);
  main.innerHTML = '';

  if (!list.length) {
    main.innerHTML = emptyState({
      title: 'No source is listed for this department yet',
      next: 'A source is a row in config/sources.json - the sheet, board or database this team already works in. Add one there, or ask an admin to add it in Supabase.'
    });
    return;
  }

  const canWrite = ctx.canWrite(current);
  const unconnected = list.filter((s) => isPlaceholderRef(s.ref)).length;
  const head = el('div', {
    class: 'banner',
    html: unconnected
      ? `<b>${unconnected} of ${list.length} sources still unconnected.</b> Each one is a sheet link and a share, about two minutes. Until then every metric reading it comes back missing and a flag goes up with the owner's name on it.`
      : `<b>All ${list.length} sources connected.</b> Check the freshness label on each - a source assembled the night before is a different thing from one that is used daily.`
  });
  main.appendChild(head);

  for (const s of list) main.appendChild(renderSource(s, canWrite));
  main.appendChild(el('div', {
    class: 'hint',
    style: 'margin-top:22px',
    html: 'A source should be the system the team already works in. If the only way to answer a number is to assemble it the night before, that is a finding about how the function is run, not a configuration detail.'
  }));

  const focus = params.get('source');
  if (focus) {
    const node = document.getElementById(`s-${focus}`);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

render().catch((err) => { main.innerHTML = errorState(err, 'This page could not start'); });
