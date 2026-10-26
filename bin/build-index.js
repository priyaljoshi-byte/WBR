#!/usr/bin/env node
/**
 * Builds out/index.html - the page everyone actually opens.
 *
 * Lists this week's four dashboards in meeting order with the day, who is in
 * the room, and when each was last built. Past weeks go underneath, newest
 * first, because "what did we say in October" is a real question.
 *
 * Deliberately dumb: it reads the filenames in out/ and the meeting config.
 * It never recomputes a number, so it cannot disagree with a dashboard.
 */

import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out');

const readJson = async (p, fallback = null) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function ago(then, now = Date.now()) {
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

async function main() {
  const org = await readJson(join(ROOT, 'config/org.json'), {});
  const meetingsCfg = await readJson(join(ROOT, 'config/meetings.json'), null);
  const meetings = meetingsCfg?.meetings ?? [];

  const deptLabel = Object.fromEntries((org.departments ?? []).map((d) => [d.id, d.label]));
  const teamOf = (id) => {
    const o = org.owners?.[id];
    const team = o?.team ?? (o?.name ? [o.name] : []);
    if (!team.length) return '[OWNER NEEDED]';
    return team.length === 1 ? team[0]
      : `${team.slice(0, -1).join(', ')} and ${team.at(-1)}`;
  };

  let files = [];
  try { files = await readdir(OUT); } catch { /* no out/ yet */ }

  // out/<meeting>-<YYYY-MM-DD>.html
  const built = [];
  for (const f of files) {
    const m = /^(.+)-(\d{4}-\d{2}-\d{2})\.html$/.exec(f);
    if (!m) continue;
    const [, id, week] = m;
    if (id.startsWith('sample')) continue;
    const s = await stat(join(OUT, f));
    built.push({ file: f, id, week, builtAt: s.mtimeMs });
  }

  const weeks = [...new Set(built.map((b) => b.week))].sort().reverse();
  const current = weeks[0] ?? null;

  const card = (b) => {
    const meeting = meetings.find((m) => m.id === b.id);
    const name = meeting?.name ?? b.id;
    const day = meeting?.day ? meeting.day[0].toUpperCase() + meeting.day.slice(1) : '';
    const who = (meeting?.members ?? [])
      .map((x) => deptLabel[x.dept] + (x.segment ? ` (${x.segment.toUpperCase()})` : ''))
      .join(' + ');
    const owners = [...new Set((meeting?.members ?? []).map((x) => teamOf(x.dept)))].join(' · ');
    return `
    <a class="card" href="${esc(b.file)}">
      <span class="day">${esc(day)}</span>
      <h2>${esc(name)}</h2>
      <p class="who">${esc(who)}</p>
      <p class="owners">${esc(owners)}</p>
      <span class="built">built ${esc(ago(b.builtAt))}</span>
    </a>`;
  };

  const thisWeek = built
    .filter((b) => b.week === current)
    .sort((a, b) => DAYS.indexOf(meetings.find((m) => m.id === a.id)?.day ?? '')
                  - DAYS.indexOf(meetings.find((m) => m.id === b.id)?.day ?? ''));

  const missing = meetings.filter((m) => !thisWeek.some((b) => b.id === m.id));

  const past = weeks.slice(1, 13).map((w) => {
    const items = built.filter((b) => b.week === w)
      .map((b) => `<a href="${esc(b.file)}">${esc(meetings.find((m) => m.id === b.id)?.name ?? b.id)}</a>`)
      .join(' · ');
    return `<li><span class="w">${esc(w)}</span> ${items}</li>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ShopOS WBR</title>
<style>
:root{--bg:#070707;--line:#242424;--soft:#1b1b1b;--fg:#f5f5f5;--fg2:#9b9b9b;--fg3:#6a6a6a;
--lime:#c6f432;--font:"SF Pro Display","SF Pro","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
--mono:"SF Mono",ui-monospace,"JetBrains Mono",Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1100px 620px at 12% -8%,#17171a 0,transparent 62%),var(--bg);
color:var(--fg);font-family:var(--font);padding:0 26px 90px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto}
header{padding:60px 0 34px;border-bottom:1px solid var(--soft)}
h1{margin:0;font-size:26px;letter-spacing:-.025em;font-weight:650}
header p{margin:10px 0 0;color:var(--fg2);font-size:14.5px;max-width:60ch;line-height:1.55}
.week{font-family:var(--mono);font-size:12px;color:var(--lime);letter-spacing:.08em;margin:0 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin:34px 0 0}
.card{display:block;text-decoration:none;color:inherit;border:1px solid var(--line);border-radius:18px;
padding:20px 22px;background:linear-gradient(180deg,#161616,#101010);transition:border-color .16s,transform .16s}
.card:hover{border-color:rgba(198,244,50,.42);transform:translateY(-2px)}
.day{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--lime)}
.card h2{margin:8px 0 6px;font-size:16.5px;letter-spacing:-.015em;font-weight:620}
.who{margin:0;font-size:13px;color:var(--fg2);line-height:1.5}
.owners{margin:8px 0 0;font-size:12px;color:var(--fg3)}
.built{display:block;margin-top:14px;font-family:var(--mono);font-size:10.5px;color:var(--fg3)}
.gap{border:1px dashed rgba(255,180,84,.4);border-radius:18px;padding:20px 22px;background:#141210}
.gap .day{color:#ffb454}
.gap h2{margin:8px 0 6px;font-size:16.5px;font-weight:620}
.gap p{margin:0;font-size:13px;color:var(--fg2);line-height:1.5}
h3{margin:54px 0 14px;font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--fg3);font-weight:650}
ul{list-style:none;margin:0;padding:0}
li{padding:11px 0;border-bottom:1px solid var(--soft);font-size:13.5px;color:var(--fg2)}
li .w{font-family:var(--mono);font-size:11.5px;color:var(--fg3);margin-right:14px}
li a{color:var(--fg2);text-decoration:none;border-bottom:1px solid transparent}
li a:hover{color:var(--fg);border-bottom-color:var(--lime)}
.appblurb{margin:0 0 18px;font-size:13.5px;color:var(--fg2);line-height:1.6;max-width:68ch}
.grid.apps{margin-top:0}
.card.app:hover{border-color:rgba(61,219,255,.42)}
.card.app .day{color:#3ddbff}
footer{margin-top:50px;padding-top:20px;border-top:1px solid var(--soft);font-size:12px;color:var(--fg3);line-height:1.8}
</style></head><body><div class="wrap">

<header>
  <p class="week">${current ? `WEEK OF ${esc(current)}` : 'NOTHING BUILT YET'}</p>
  <h1>Weekly business review</h1>
  <p>Built before each meeting from the systems each team already works in.
     Nobody updates these by hand. If a number is missing, the card says whose it is.</p>
</header>

<section class="grid">
${thisWeek.map(card).join('\n')}
${missing.map((m) => `  <div class="gap">
    <span class="day">${esc((m.day ?? '').toUpperCase())}</span>
    <h2>${esc(m.name)}</h2>
    <p>Not built for this week yet. It runs the evening before the meeting.</p>
  </div>`).join('\n')}
</section>

${past ? `<h3>Earlier weeks</h3><ul>\n${past}\n</ul>` : ''}

<h3>Set it up</h3>
<p class="appblurb">These dashboards are built from what each team connects here. A page nobody can
find is a page nobody uses, so: this is where you point Pulse at your sheet, choose which numbers
matter to you, and set what you are committing to.</p>
<section class="grid apps">
${[
    ['app/index.html', 'Setup', 'What your department still owes - unconnected sources, untargeted metrics, unnamed owners.'],
    ['app/sources.html', 'Sources', 'Paste a sheet link or drop a CSV, map the columns, and see the rings it produces.'],
    ['app/metrics.html', 'Metrics', 'Which numbers matter to you. Three to five, not everything measurable.'],
    ['app/targets.html', 'Targets', 'The number each metric is committing to, and what counts as off track.'],
    ['app/rag.html', 'Brand status', 'The daily red/amber/green call per brand or track, with the reason beside it.'],
    ['app/transcripts.html', 'Add a meeting', 'Turn a transcript into decisions, blockers and notes - reviewed before anything is written.']
  ].map(([href, name, blurb]) => `
  <a class="card app" href="${esc(href)}">
    <span class="day">OPEN</span>
    <h2>${esc(name)}</h2>
    <p class="who">${esc(blurb)}</p>
  </a>`).join('\n')}
</section>

<footer>
  Each ring is a number against its own denominator, normalised to 100.<br>
  Snapshots are frozen once written, so a past week always renders what it said at the time.<br>
  Confidential - internal to ShopOS.
</footer>

</div></body></html>`;

  await writeFile(join(OUT, 'index.html'), html);
  console.log(`out/index.html  ${thisWeek.length} built, ${missing.length} still to come`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
