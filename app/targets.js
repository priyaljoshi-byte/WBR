/**
 * targets.js - "Set your targets".
 *
 * The count at the top is the feature. config/catalog.json says it plainly:
 * "That list shrinking to zero IS the setup process." So the number of
 * untargeted metrics is the largest thing on the page, it is coloured amber
 * until it is zero, and it updates the moment a target is saved.
 *
 * What is editable here, and what is not, is a deliberate line. The target,
 * the direction and the two thresholds are a department head's commitment and
 * they own them. The unit and the source query are the catalogue's, because two
 * teams quietly defining "qualified lead" two different ways is the failure this
 * whole structure exists to prevent.
 */

import { boot, paintShell, banner } from './shell.js';
import { loadAll } from './configload.js';
import { db, canSave } from './store.js';
import { esc, el, emptyState, errorState, toast, progressBar, UNIT_LABELS } from './ui.js';

const main = document.getElementById('main');
const params = new URLSearchParams(location.search);

let ctx = null;
let data = null;

/** Rendered example of what a number in this unit looks like, so nobody types
 *  4.47 when the field wants 44700000. Currency is the one that bites. */
function unitHint(unit) {
  switch (unit) {
    case 'currency_inr': return 'In rupees, not crore. 4.47 Cr is 44700000.';
    case 'currency_usd': return 'In dollars, not thousands. $120K is 120000.';
    case 'percent': return 'As a fraction. 32% is 0.32.';
    case 'duration': return 'In seconds. 1m43s is 103.';
    case 'duration_days': return 'In days. A day and a half is 1.5.';
    default: return 'A plain count.';
  }
}

function metricRow(m, canWrite) {
  const has = m.target !== null && m.target !== undefined;
  return `<section class="card${has ? '' : ' flag'}" id="metric-${esc(m.id)}" data-metric="${esc(m.id)}">
    <header>
      <div>
        <h3>${esc(m.label)}${m.segment ? ` <span class="chip chip-info">${esc(m.segment)}</span>` : ''}</h3>
        <p class="kicker" style="margin:5px 0 0">${esc(m.id)} &middot; ${esc(UNIT_LABELS[m.unit] || m.unit)}</p>
      </div>
      <span class="chip ${has ? 'chip-ok' : 'chip-warn'}" data-role="state">${has ? 'targeted' : 'no target'}</span>
    </header>

    <div class="fieldrow" style="margin-top:16px">
      <div class="field">
        <label class="fl" for="t-${esc(m.id)}">Target</label>
        <input type="number" step="any" id="t-${esc(m.id)}" data-f="target"
          value="${has ? esc(String(m.target)) : ''}" placeholder="not set"${canWrite ? '' : ' disabled'}>
        <p class="hint">${esc(unitHint(m.unit))}</p>
      </div>
      <div class="field">
        <label class="fl" for="d-${esc(m.id)}">Which way is good</label>
        <select id="d-${esc(m.id)}" data-f="direction"${canWrite ? '' : ' disabled'}>
          <option value="up"${m.direction !== 'down' ? ' selected' : ''}>higher is better</option>
          <option value="down"${m.direction === 'down' ? ' selected' : ''}>lower is better</option>
        </select>
        <p class="hint">${m.direction === 'down' ? 'Cost and cycle time get better by going down.' : 'Most numbers here go up.'}</p>
      </div>
      <div class="field">
        <label class="fl" for="w-${esc(m.id)}">Warn below</label>
        <input type="number" step="0.05" min="0" max="1" id="w-${esc(m.id)}" data-f="warn_at"
          value="${m.warn_at == null ? '' : esc(String(m.warn_at))}" placeholder="0.7"${canWrite ? '' : ' disabled'}>
        <p class="hint">Fraction of target. 0.7 flags at 70%.</p>
      </div>
      <div class="field">
        <label class="fl" for="c-${esc(m.id)}">Critical below</label>
        <input type="number" step="0.05" min="0" max="1" id="c-${esc(m.id)}" data-f="crit_at"
          value="${m.crit_at == null ? '' : esc(String(m.crit_at))}" placeholder="0.4"${canWrite ? '' : ' disabled'}>
        <p class="hint">Fraction of target. 0.4 flags at 40%.</p>
      </div>
    </div>

    <p class="hint" data-role="preview"></p>
    <div class="btnrow" style="margin-top:6px">
      <button class="btn btn-go btn-sm" type="button" data-act="save"${canWrite ? '' : ' disabled'}>Save</button>
      ${has && canWrite ? '<button class="btn btn-quiet btn-sm" type="button" data-act="clear">Clear the target</button>' : ''}
      <span class="hint" data-role="said"></span>
    </div>
  </section>`;
}

/** "Below 31,290,000 warns; below 17,880,000 is critical." Spelling the
 *  thresholds out in real units is the difference between a number someone
 *  typed and a number someone meant. */
function previewLine(m, target, warn, crit) {
  if (target == null || !Number.isFinite(target)) return 'No target set, so this metric is reported but not judged.';
  const fmt = (n) => (m.unit === 'percent' ? `${(n * 100).toFixed(1)}%` : n.toLocaleString('en-IN'));
  const dir = m.direction === 'down' ? 'above' : 'below';
  const parts = [];
  if (Number.isFinite(warn)) parts.push(`${dir} ${fmt(target * warn)} warns`);
  if (Number.isFinite(crit)) parts.push(`${dir} ${fmt(target * crit)} is critical`);
  if (!parts.length) return `Target ${fmt(target)}. No warning or critical line set, so it is only ever on or off target.`;
  return `Target ${fmt(target)}. ${parts.join(', ')}.`;
}

function wire(card, m, deptId) {
  const get = (f) => card.querySelector(`[data-f="${f}"]`);
  const preview = card.querySelector('[data-role="preview"]');
  const state = card.querySelector('[data-role="state"]');
  const said = card.querySelector('[data-role="said"]');

  const read = () => ({
    target: get('target').value === '' ? null : Number(get('target').value),
    direction: get('direction').value,
    warn_at: get('warn_at').value === '' ? null : Number(get('warn_at').value),
    crit_at: get('crit_at').value === '' ? null : Number(get('crit_at').value)
  });

  const repaint = () => {
    const v = read();
    preview.textContent = previewLine({ ...m, direction: v.direction }, v.target, v.warn_at, v.crit_at);
  };
  [...card.querySelectorAll('[data-f]')].forEach((n) => n.addEventListener('input', repaint));
  repaint();

  const save = async (clear) => {
    const v = clear ? { target: null, direction: read().direction, warn_at: read().warn_at, crit_at: read().crit_at } : read();

    if (!clear && v.target !== null && !Number.isFinite(v.target)) { toast('That target is not a number.', 'warn'); return; }
    if (v.warn_at !== null && v.crit_at !== null && v.crit_at > v.warn_at) {
      toast('Critical must be below warn - otherwise a metric goes critical before it ever warns.', 'warn');
      return;
    }
    if (!canSave()) { toast('Preview mode - nothing was saved.', 'warn'); return; }

    try {
      await db.upsert('pulse_metrics', [{
        id: m.id,
        dept_id: deptId,
        label: m.label,
        unit: m.unit,
        source: m.source,
        denominator: m.denominator,
        direction: v.direction,
        target: v.target,
        warn_at: v.warn_at,
        crit_at: v.crit_at,
        caption: m.caption || '{{raw}}',
        created_by: ctx.session ? ctx.session.email : null,
        updated_at: new Date().toISOString()
      }], 'id');

      m.target = v.target;
      m.direction = v.direction;
      m.warn_at = v.warn_at;
      m.crit_at = v.crit_at;

      const has = v.target !== null;
      state.className = `chip ${has ? 'chip-ok' : 'chip-warn'}`;
      state.textContent = has ? 'targeted' : 'no target';
      card.classList.toggle('flag', !has);
      if (clear) get('target').value = '';
      said.textContent = `saved ${new Date().toLocaleTimeString()}`;
      repaint();
      recount();
      toast(`${m.label} saved`);
    } catch (err) {
      toast(err.message, 'warn');
    }
  };

  card.querySelector('[data-act="save"]').addEventListener('click', () => save(false));
  const clearBtn = card.querySelector('[data-act="clear"]');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => save(true));
  }
}

/* ------------------------------- the count -------------------------------- */

let countHost = null;
let scopedMetrics = [];

function recount() {
  const missing = scopedMetrics.filter((m) => m.target === null || m.target === undefined).length;
  const total = scopedMetrics.length;
  countHost.innerHTML = `
    <header>
      <div>
        <p class="kicker">Metrics still without a target</p>
        <p class="bignum ${missing ? 'owed' : 'zero'}" style="margin-top:8px">${missing}</p>
      </div>
      <span class="chip ${missing ? 'chip-warn' : 'chip-ok'}">${total - missing} of ${total} committed</span>
    </header>
    ${progressBar(total - missing, total)}
    <p class="hint" style="margin-top:14px">${missing
    ? 'Every one of these raises a flag each week with the department owner\'s name on it. Setting a target is the only thing that clears it.'
    : 'Every metric in this department carries a commitment. Nothing here will raise a no-target flag.'}</p>`;
}

/* --------------------------------- boot ----------------------------------- */

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
    active: 'targets',
    title: 'Set your targets',
    blurb: 'Every metric your department reports, with the number you are committing to. Sign in to see yours.'
  });
  if (!ctx.guard('#main')) { paintShell(ctx, { active: 'targets' }); return; }

  main.innerHTML = '<p class="hint">Reading the catalogue...</p>';
  try { data = await loadAll(); } catch (err) {
    paintShell(ctx, { active: 'targets' });
    main.innerHTML = errorState(err, 'Could not read the catalogue');
    return;
  }

  const allDeptIds = data.org.departments.map((d) => d.id);
  const mine = ctx.scope(allDeptIds);
  const labels = data.org.departments.filter((d) => mine.includes(d.id)).map((d) => d.short || d.label);
  paintShell(ctx, { active: 'targets', deptLabels: labels });

  if (data.liveError) banner('warn', `<b>Showing the seed from config/.</b> Supabase did not answer: ${esc(data.liveError)}`);

  const wanted = params.get('dept');
  const current = mine.includes(wanted) ? wanted : mine[0];
  deptPicker(mine, current);

  scopedMetrics = data.catalog.metrics.filter((m) => m.dept === current);
  const canWrite = ctx.canWrite(current);

  main.innerHTML = '';
  countHost = el('section', { class: 'card', style: 'margin-bottom:20px' });
  main.appendChild(countHost);

  if (!scopedMetrics.length) {
    main.appendChild(el('div', {
      html: emptyState({
        title: 'No metrics are defined for this department yet',
        next: 'A metric is a row in config/catalog.json: which source, which column, how to roll it up, and what it is a fraction of. Add one there and it appears here.'
      })
    }));
    countHost.remove();
    return;
  }
  recount();

  if (!canWrite) {
    main.appendChild(el('div', {
      class: 'banner',
      html: '<b>Read only.</b> You can see every target but can only change a department you own. Department scoping is enforced in the database, so hiding the buttons is a courtesy, not the lock.'
    }));
  }

  const byUnit = new Map();
  for (const m of scopedMetrics) {
    const key = m.segment || 'all';
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(m);
  }

  for (const [segment, metrics] of byUnit) {
    if (byUnit.size > 1) {
      const seg = data.org.departments.find((d) => d.id === current);
      const label = (seg && seg.segment_labels && seg.segment_labels[segment]) || segment;
      main.appendChild(el('div', {
        class: 'sechead',
        html: `<h2>${esc(label)}</h2><p>${metrics.filter((m) => m.target == null).length} of ${metrics.length} still without a target</p>`
      }));
    }
    for (const m of metrics) {
      const holder = el('div', { html: metricRow(m, canWrite) });
      const card = holder.firstElementChild;
      main.appendChild(card);
      wire(card, m, current);
    }
  }

  if (location.hash) {
    const node = document.querySelector(location.hash);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

render().catch((err) => { main.innerHTML = errorState(err, 'This page could not start'); });
