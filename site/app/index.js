/**
 * index.js - "Setup status".
 *
 * Reproduces what `pulse check` prints (bin/pulse.js cmdCheck), per signed-in
 * user. Same three questions in the same order, deliberately: if this page and
 * that command ever disagree, one of them is lying and nobody will know which.
 *
 * The number at the top is the whole point. Setup that cannot be seen to be
 * finite never finishes.
 */

import { boot, paintShell, banner } from './shell.js';
import { loadAll } from './configload.js';
import { isPlaceholderRef } from './refs.js';
import { esc, emptyState, errorState, progressBar } from './ui.js';
import { metricOwner, ownerTeam, teamLabel } from '../engine/owners.js';

const main = document.getElementById('main');

/** Exactly the three checks cmdCheck runs, in the same order. */
function auditDepartment(deptId, { org, catalog, sources }) {
  const owed = [];

  for (const s of sources.sources) {
    if (s.dept !== deptId) continue;
    if (isPlaceholderRef(s.ref)) {
      owed.push({
        kind: 'source',
        what: `"${s.label}" is not connected yet`,
        detail: s.kind === 'postgres'
          ? 'A database URL is a credential, so an admin sets this one in the server environment.'
          : `Paste the ${s.kind === 'notion' ? 'Notion' : 'Google Sheets'} link, upload a CSV, or type the numbers in.`,
        href: `sources.html?dept=${encodeURIComponent(deptId)}&source=${encodeURIComponent(s.id)}`,
        cta: 'Connect'
      });
    }
  }

  const requireTargets = !catalog._targets || catalog._targets.require_targets !== false;
  if (requireTargets) {
    const untargeted = catalog.metrics.filter((m) => m.dept === deptId && (m.target === null || m.target === undefined));
    for (const m of untargeted) {
      owed.push({
        kind: 'target',
        what: `"${m.label}" has no target`,
        detail: null,
        href: `targets.html?dept=${encodeURIComponent(deptId)}#metric-${encodeURIComponent(m.id)}`,
        cta: 'Set'
      });
    }
  }

  // Three names per line of business, and ONE of them on each metric. Two
  // separate gaps: an empty trio is the founder's to fill, an unassigned metric
  // is the trio's. They are reported as one line each so neither hides the other.
  const team = ownerTeam(deptId, org).filter((n) => n && n !== '[OWNER NEEDED]');
  if (!team.length) {
    owed.push({
      kind: 'owner',
      what: 'no owner named',
      detail: 'These names are what get printed on a flag when a number is missing. Without them, "accountability against targets" has nobody to land on.',
      href: null,
      cta: null
    });
  } else {
    const unassigned = (catalog.metrics || []).filter(
      (m) => m.dept === deptId && !metricOwner(m, org).assigned
    );
    if (unassigned.length) {
      owed.push({
        kind: 'owner',
        what: `${unassigned.length} metric${unassigned.length === 1 ? '' : 's'} with no single accountable owner`,
        detail: `${team.join(', ')} own this line of business between them. A flag addressed to all three is addressed to nobody, so each metric names one of them.`,
        href: null,
        cta: null
      });
    }
  }

  return owed;
}

/** Collapse the per-metric target rows into one line. Nine identical bullets
 *  teach nothing that "9 metrics have no target" does not. */
function summarise(owed, deptId) {
  const targets = owed.filter((o) => o.kind === 'target');
  const rest = owed.filter((o) => o.kind !== 'target');
  if (targets.length <= 2) return owed;
  return [
    ...rest,
    {
      kind: 'target',
      what: `${targets.length} metrics have no target`,
      detail: targets.slice(0, 4).map((t) => t.what.replace(' has no target', '')).join(', ')
        + (targets.length > 4 ? `, and ${targets.length - 4} more` : ''),
      href: `targets.html?dept=${encodeURIComponent(deptId)}`,
      cta: 'Set them'
    }
  ];
}

function deptCard(dept, owner, owed) {
  const list = owed.length
    ? `<ul class="todo">${owed.map((o) => `
        <li>
          <span class="dot"></span>
          <span class="what">${esc(o.what)}${o.detail ? `<br><span class="hint">${esc(o.detail)}</span>` : ''}</span>
          ${o.href ? `<a href="${esc(o.href)}">${esc(o.cta)} &rarr;</a>` : ''}
        </li>`).join('')}</ul>`
    : `<ul class="todo"><li><span class="dot dot-done"></span><span class="what">Connected, targeted and owned. Nothing owed.</span></li></ul>`;

  return `<section class="card${owed.length ? ' flag' : ' good'}">
    <header>
      <div>
        <h3>${esc(dept.label)}</h3>
        <p class="kicker" style="margin:5px 0 0">${esc(owner)}</p>
      </div>
      <span class="chip ${owed.length ? 'chip-warn' : 'chip-ok'}">${owed.length ? `${owed.length} owed` : 'ready'}</span>
    </header>
    ${list}
  </section>`;
}

async function render() {
  const ctx = await boot({
    active: 'index',
    title: 'What your department still owes',
    blurb: 'Pulse reads your numbers before the meeting. Before it can, every source needs connecting, every metric needs a target, and every department needs a name against it. Sign in to see your list.'
  });

  if (!ctx.guard('#main')) { paintShell(ctx, { active: 'index' }); return; }

  main.innerHTML = '<p class="hint">Reading config...</p>';

  let data;
  try {
    data = await loadAll();
  } catch (err) {
    paintShell(ctx, { active: 'index' });
    main.innerHTML = errorState(err, 'Could not read the configuration');
    return;
  }

  const { org, catalog, sources } = data;
  const allDeptIds = org.departments.map((d) => d.id);
  const mine = ctx.scope(allDeptIds);
  const labels = org.departments.filter((d) => mine.includes(d.id)).map((d) => d.short || d.label);
  paintShell(ctx, { active: 'index', deptLabels: labels });

  if (data.liveError) {
    banner('warn', `<b>Showing the seed from config/.</b> Supabase did not answer: ${esc(data.liveError)} Anything you have already saved is not reflected below.`);
  }

  // Count across EVERY department for the headline, but list only what is yours.
  // The founder's office needs the company number; a department head needs theirs.
  const audits = new Map(allDeptIds.map((id) => [id, auditDepartment(id, data)]));
  const myOwed = mine.reduce((n, id) => n + audits.get(id).length, 0);
  const allOwed = allDeptIds.reduce((n, id) => n + audits.get(id).length, 0);

  const totalChecks = allDeptIds.reduce((n, id) => {
    const srcN = sources.sources.filter((s) => s.dept === id).length;
    const metN = catalog.metrics.filter((m) => m.dept === id).length;
    return n + srcN + metN + 1; // + the owner
  }, 0);
  const myChecks = mine.reduce((n, id) => {
    const srcN = sources.sources.filter((s) => s.dept === id).length;
    const metN = catalog.metrics.filter((m) => m.dept === id).length;
    return n + srcN + metN + 1;
  }, 0);
  const done = myChecks - myOwed;

  const sourcesOwed = mine.reduce((n, id) => n + audits.get(id).filter((o) => o.kind === 'source').length, 0);
  const targetsOwed = mine.reduce((n, id) => n + audits.get(id).filter((o) => o.kind === 'target').length, 0);
  const ownersOwed = mine.reduce((n, id) => n + audits.get(id).filter((o) => o.kind === 'owner').length, 0);

  // "for India and US and Perf Mktg and Sloosh and Hiring" is a list, not a
  // sentence. If the scope is everything, say everything.
  const coversAll = mine.length === allDeptIds.length;
  const scopeWord = coversAll
    ? 'across every department'
    : `for ${labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0]}`;

  /**
   * COMPLETENESS IS THE HEADLINE.
   *
   * The review this replaces had an Engineering section that was an untouched
   * template - a "Headline metric" table with one blank row - and a Hiring
   * section holding an attachment three weeks older than the review it sat in.
   * Neither was hidden. Both were simply not counted, and a thing nobody counts
   * is a thing nobody notices is missing.
   *
   * So the first object on this page is a bar per department. An empty
   * department is not absent from the list, it is a bar at zero with its
   * owner's name beside it.
   */
  const completeness = allDeptIds.map((id) => {
    const dept = org.departments.find((d) => d.id === id);
    const srcN = sources.sources.filter((s) => s.dept === id).length;
    const metN = catalog.metrics.filter((m) => m.dept === id).length;
    const total = srcN + metN + 1;
    const owed = audits.get(id).length;
    const ownerName = teamLabel(id, org);
    return {
      id, label: dept.label, short: dept.short || dept.label, ownerName,
      total, done: total - owed, owed,
      pct: total ? Math.round(((total - owed) / total) * 100) : 100,
      mine: mine.includes(id)
    };
  }).sort((a, b) => a.pct - b.pct);

  const untouched = completeness.filter((c) => c.pct === 0);

  const head = `<section class="card" style="margin-bottom:20px">
    <header>
      <div>
        <p class="kicker">How complete each department is</p>
        <p class="bignum ${myOwed ? 'owed' : 'zero'}" style="margin-top:8px">${Math.round((done / Math.max(1, myChecks)) * 100)}<span style="font-size:22px;color:var(--fg-3)">%</span></p>
        <p class="hint" style="margin-top:4px">${done} of ${myChecks} ${esc(scopeWord)}</p>
      </div>
      <span class="chip ${myOwed ? 'chip-warn' : 'chip-ok'}">${myOwed} still owed</span>
    </header>

    <div style="margin-top:22px">
      ${completeness.map((c) => `
        <div style="display:grid;grid-template-columns:minmax(120px,1.1fr) minmax(90px,2fr) auto;gap:14px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line-soft)${c.mine ? '' : ';opacity:.55'}">
          <div style="min-width:0">
            <b style="font-size:13.5px;letter-spacing:-.012em">${esc(c.short)}</b>
            <span class="fresh" style="display:block;margin-top:3px">${esc(c.ownerName)}</span>
          </div>
          <div class="prog" style="margin:0"><span style="width:${c.pct}%;background:${
  c.pct === 100 ? 'var(--lime)' : c.pct === 0 ? 'var(--red)' : 'var(--amber)'}"></span></div>
          <span class="chip ${c.pct === 100 ? 'chip-ok' : c.pct === 0 ? 'chip-bad' : 'chip-warn'}" style="min-width:74px;text-align:center">${c.pct}%</span>
        </div>`).join('')}
    </div>

    ${untouched.length ? `<p class="hint" style="margin-top:14px;color:var(--red)"><b>${esc(untouched.map((u) => u.short).join(', '))}</b> ${untouched.length === 1 ? 'has' : 'have'} nothing set up at all. An empty section is not a quiet section - it is the one that gets left out of the review entirely.</p>` : ''}

    <div class="statrow" style="margin-top:22px;margin-bottom:0">
      <div class="stat"><p class="tl">Sources</p><p class="tv" style="color:${sourcesOwed ? 'var(--amber)' : 'var(--lime)'}">${sourcesOwed}</p><p class="tu">not connected</p></div>
      <div class="stat"><p class="tl">Targets</p><p class="tv" style="color:${targetsOwed ? 'var(--amber)' : 'var(--lime)'}">${targetsOwed}</p><p class="tu">not set</p></div>
      <div class="stat"><p class="tl">Owners</p><p class="tv" style="color:${ownersOwed ? 'var(--amber)' : 'var(--lime)'}">${ownersOwed}</p><p class="tu">not named</p></div>
    </div>
    ${!ctx.isAdmin && allOwed !== myOwed
      ? `<p class="hint" style="margin-top:14px">${allOwed} are owed across the company. The rest belong to other departments and are dimmed above.</p>` : ''}
  </section>`;

  const body = myOwed === 0
    ? emptyState({
      title: 'Everything is connected, targeted and owned.',
      next: 'Ready to run. The scheduled job reads every source fourteen hours before the meeting; nothing more is needed from you until then.',
      action: `<a class="btn" href="sources.html">Review sources</a><a class="btn" href="transcripts.html">Add a meeting</a>`
    })
    : `<div class="sechead"><h2>By department</h2><p>Each line is one thing one person can finish today.</p></div>
       ${mine.map((id) => {
    const dept = org.departments.find((d) => d.id === id);
    const owner = teamLabel(id, org);
    return deptCard(dept, owner, summarise(audits.get(id), id));
  }).join('')}`;

  const noScope = !ctx.isAdmin && ctx.role === 'owner' && !ctx.deptIds.length;
  const scopeNote = noScope
    ? `<div class="banner banner-warn"><b>No department is assigned to you yet.</b> You are shown everything, but you can only save changes for a department an admin has put against your name in <code>pulse_roles</code>.</div>`
    : '';

  main.innerHTML = scopeNote + head + body;
}

render().catch((err) => {
  main.innerHTML = errorState(err, 'This page could not start');
});
