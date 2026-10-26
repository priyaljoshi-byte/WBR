/**
 * metrics.js - "Choose your metrics".
 *
 * The picker a department head uses to say which catalogue metrics belong on
 * their dashboard, who answers for each one, and what the target is.
 *
 * Two tables, on purpose:
 *   - pulse_selections holds the choice (tracked or not, and the owner). It is
 *     the department's opinion about its own dashboard.
 *   - pulse_metrics holds the target and direction, the same row the Targets
 *     screen writes. Saving a target here writes it there too, so there is
 *     exactly one target per metric no matter which screen set it.
 */

import { boot, paintShell, banner } from './shell.js';
import { loadAll } from './configload.js';
import { db, canSave, loadSelections, saveSelection } from './store.js';
import { esc, el, emptyState, errorState, toast, progressBar, UNIT_LABELS } from './ui.js';

const main = document.getElementById('main');
const params = new URLSearchParams(location.search);

let ctx = null;
let data = null;
let selections = {};
let scoped = [];
let countHost = null;

/** A metric with no saved row yet: not tracked, owner and target from the seed. */
function selectionFor(deptId, m) {
  const saved = (selections[deptId] || {})[m.id];
  if (saved) return saved;
  return { enabled: false, target: m.target ?? null, owner: m.owner || null, direction: m.direction || 'up', _unsaved: true };
}

function ownerOptions(deptId) {
  const owner = (data.org.owners || {})[deptId] || {};
  return [...new Set([...(owner.team || []), owner.lead].filter(Boolean))];
}

function metricRow(m, sel, deptId) {
  const uid = `m-${m.id}`;
  return `<section class="card${sel.enabled ? '' : ' muted'}" id="${esc(uid)}" data-metric="${esc(m.id)}">
    <header>
      <div>
        <label style="display:flex;gap:10px;align-items:center;cursor:pointer">
          <input type="checkbox" data-f="enabled"${sel.enabled ? ' checked' : ''}>
          <h3 style="margin:0">${esc(m.label)}${m.segment ? ` <span class="chip chip-info">${esc(m.segment)}</span>` : ''}</h3>
        </label>
        <p class="kicker" style="margin:5px 0 0">${esc(m.id)} &middot; ${esc(UNIT_LABELS[m.unit] || m.unit)}</p>
      </div>
      <span class="chip ${sel.enabled ? 'chip-ok' : ''}" data-role="state">${sel.enabled ? 'tracked' : 'not tracked'}</span>
    </header>
    <div class="fieldrow" style="margin-top:16px">
      <div class="field">
        <label class="fl" for="${esc(uid)}-o">Owner</label>
        <input type="text" id="${esc(uid)}-o" data-f="owner" list="owners-${esc(deptId)}"
          value="${esc(sel.owner || '')}" placeholder="one name">
      </div>
      <div class="field">
        <label class="fl" for="${esc(uid)}-t">Target</label>
        <input type="number" step="any" id="${esc(uid)}-t" data-f="target"
          value="${sel.target == null ? '' : esc(String(sel.target))}" placeholder="not set">
      </div>
      <div class="field">
        <label class="fl" for="${esc(uid)}-d">Which way is good</label>
        <select id="${esc(uid)}-d" data-f="direction">
          <option value="up"${sel.direction !== 'down' ? ' selected' : ''}>higher is better</option>
          <option value="down"${sel.direction === 'down' ? ' selected' : ''}>lower is better</option>
        </select>
      </div>
    </div>
    <div class="btnrow" style="margin-top:6px">
      <button class="btn btn-go btn-sm" type="button" data-act="save">Save</button>
      <span class="hint" data-role="said">${sel._unsaved ? '' : 'saved'}</span>
    </div>
  </section>`;
}

function wire(card, m, deptId) {
  const get = (f) => card.querySelector(`[data-f="${f}"]`);
  const said = card.querySelector('[data-role="said"]');
  const state = card.querySelector('[data-role="state"]');

  const save = async () => {
    const raw = get('target').value;
    const v = {
      enabled: get('enabled').checked,
      owner: get('owner').value.trim() || null,
      target: raw === '' ? null : Number(raw),
      direction: get('direction').value
    };
    if (v.target !== null && !Number.isFinite(v.target)) { toast('That target is not a number.', 'warn'); return; }
    if (!canSave()) { toast('Preview mode - nothing was saved.', 'warn'); return; }

    try {
      await saveSelection(deptId, m.id, v);
      // Keep the one target in sync with the Targets screen.
      await db.upsert('pulse_metrics', [{
        id: m.id,
        dept_id: deptId,
        label: m.label,
        unit: m.unit,
        source: m.source,
        denominator: m.denominator,
        direction: v.direction,
        target: v.target,
        warn_at: m.warn_at ?? null,
        crit_at: m.crit_at ?? null,
        caption: m.caption || '{{raw}}',
        created_by: ctx.session ? ctx.session.email : null,
        updated_at: new Date().toISOString()
      }], 'id');

      if (!selections[deptId]) selections[deptId] = {};
      selections[deptId][m.id] = v;
      m.target = v.target;
      m.direction = v.direction;
      state.className = `chip ${v.enabled ? 'chip-ok' : ''}`;
      state.textContent = v.enabled ? 'tracked' : 'not tracked';
      card.classList.toggle('muted', !v.enabled);
      said.textContent = `saved ${new Date().toLocaleTimeString()}`;
      recount(deptId);
      toast(`${m.label} saved`);
    } catch (err) {
      toast(err.message, 'warn');
    }
  };

  card.querySelector('[data-act="save"]').addEventListener('click', save);
  // Ticking the box is the main gesture; it should not need a second click.
  get('enabled').addEventListener('change', save);
}

function recount(deptId) {
  const sels = scoped.map((m) => selectionFor(deptId, m));
  const tracked = sels.filter((s) => s.enabled);
  const noOwner = tracked.filter((s) => !s.owner).length;
  const noTarget = tracked.filter((s) => s.target == null).length;
  countHost.innerHTML = `
    <header>
      <div>
        <p class="kicker">Metrics on this department's dashboard</p>
        <p class="bignum ${tracked.length ? 'zero' : 'owed'}" style="margin-top:8px">${tracked.length}</p>
      </div>
      <span class="chip ${noOwner || noTarget ? 'chip-warn' : 'chip-ok'}">${tracked.length} of ${scoped.length} chosen</span>
    </header>
    ${progressBar(tracked.length - noOwner, Math.max(tracked.length, 1))}
    <p class="hint" style="margin-top:14px">${!tracked.length
    ? 'Nothing chosen yet. Tick the numbers your meeting actually discusses.'
    : `${noOwner ? `${noOwner} tracked metric${noOwner === 1 ? ' has' : 's have'} no owner. ` : ''}${noTarget ? `${noTarget} ha${noTarget === 1 ? 's' : 've'} no target. ` : ''}${!noOwner && !noTarget ? 'Every tracked metric has an owner and a target.' : ''}`}</p>`;
}

function deptPicker(deptIds, current) {
  const host = document.getElementById('deptpick');
  const depts = data.org.departments.filter((d) => deptIds.includes(d.id));
  if (depts.length <= 1) { host.innerHTML = depts.length ? `<p class="kicker">${esc(depts[0].label)}</p>` : ''; return; }
  host.innerHTML = `<label class="fl" for="deptsel">Department</label>
    <select id="deptsel" style="min-width:230px">
      ${depts.map((d) => `<option value="${esc(d.id)}"${d.id === current ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
    </select>`;
  document.getElementById('deptsel').addEventListener('change', (e) => {
    const next = new URLSearchParams(location.search);
    next.set('dept', e.target.value);
    location.search = next.toString();
  });
}

async function render() {
  ctx = await boot({
    active: 'metrics',
    title: 'Choose your metrics',
    blurb: 'Pick the numbers your department reports, who owns each, and the target.'
  });
  if (!ctx.guard('#main')) { paintShell(ctx, { active: 'metrics' }); return; }

  main.innerHTML = '<p class="hint">Reading the catalogue...</p>';
  try { data = await loadAll(); } catch (err) {
    paintShell(ctx, { active: 'metrics' });
    main.innerHTML = errorState(err, 'Could not read the catalogue');
    return;
  }

  const allDeptIds = data.org.departments.map((d) => d.id);
  const mine = ctx.scope(allDeptIds);
  paintShell(ctx, { active: 'metrics', deptLabels: data.org.departments.filter((d) => mine.includes(d.id)).map((d) => d.short || d.label) });

  if (data.liveError) banner('warn', `<b>Showing the seed from config/.</b> Supabase did not answer: ${esc(data.liveError)}`);
  if (canSave()) {
    try { selections = await loadSelections(); } catch (err) {
      banner('warn', `<b>Your saved choices could not be read.</b> ${esc(err.message)}`);
    }
  }

  const wanted = params.get('dept');
  const current = mine.includes(wanted) ? wanted : mine[0];
  deptPicker(mine, current);
  scoped = data.catalog.metrics.filter((m) => m.dept === current);

  main.innerHTML = `<datalist id="owners-${esc(current)}">${ownerOptions(current).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
  if (!scoped.length) {
    main.appendChild(el('div', { html: emptyState({ title: 'No metrics are defined for this department yet', next: 'A metric is a row in config/catalog.json. Add one there and it appears here.' }) }));
    return;
  }

  countHost = el('section', { class: 'card', style: 'margin-bottom:20px' });
  main.appendChild(countHost);
  recount(current);

  const bySegment = new Map();
  for (const m of scoped) {
    const key = m.segment || 'all';
    if (!bySegment.has(key)) bySegment.set(key, []);
    bySegment.get(key).push(m);
  }
  for (const [segment, metrics] of bySegment) {
    if (bySegment.size > 1) {
      const dept = data.org.departments.find((d) => d.id === current);
      const label = (dept && dept.segment_labels && dept.segment_labels[segment]) || segment;
      main.appendChild(el('div', { class: 'sechead', html: `<h2>${esc(label)}</h2><p>${metrics.length} metrics</p>` }));
    }
    for (const m of metrics) {
      const holder = el('div', { html: metricRow(m, selectionFor(current, m), current) });
      const card = holder.firstElementChild;
      main.appendChild(card);
      wire(card, m, current);
    }
  }
}

render().catch((err) => { main.innerHTML = errorState(err, 'This page could not start'); });
