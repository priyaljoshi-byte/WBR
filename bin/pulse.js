#!/usr/bin/env node
/**
 * pulse - the command that runs the week.
 *
 *   pulse run [--week YYYY-MM-DD] [--meeting <id>] [--dry-run]
 *   pulse render [--week YYYY-MM-DD] [--meeting <id>]
 *   pulse meeting <transcript.json>             fold a meeting into decisions + blockers
 *   pulse check                                 what is not set up yet
 *
 * On a server this runs from cron, fourteen hours before the meeting. On a
 * laptop it runs the same way, against the same files, so there is never a
 * question of whether the scheduled version does something different.
 *
 * FOUR MEETINGS, NOT ONE
 * ======================
 * config/meetings.json lists the four weekly reviews. Each covers a set of
 * `{dept, segment}` members, so each room gets a dashboard cut to what it is
 * there to decide. With no --meeting, every meeting in the file runs. With no
 * meetings.json at all, the old single whole-company dashboard runs unchanged.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.PULSE_DATA_DIR ?? join(ROOT, 'data');
const OUT = join(ROOT, 'out');

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const readJsonOr = async (p, fallback) => {
  try { return await readJson(p); } catch { return fallback; }
};
/**
 * The catalogue, cut to what each department actually chose on the Metrics
 * screen.
 *
 * data/selections.json is optional and absent by default, so a repo that has
 * never opened the app behaves exactly as it always did. When it is there, it
 * filters which metrics exist and overrides their target and owner - and the
 * run says so out loud, because a dashboard that is quietly showing six of a
 * department's nine numbers should never be mistaken for one showing all nine.
 */
const loadConfig = async () => {
  const catalog = await readJson(join(ROOT, 'config/catalog.json'));
  const selections = await readJsonOr(join(DATA, 'selections.json'), null);

  let applied = catalog;
  if (selections) {
    const { applySelections, describeSelections } = await import('../engine/selections.js');
    const result = applySelections(catalog, selections);
    applied = result.catalog;
    if (result.applied) {
      console.log(`Selections: ${describeSelections(result.stats)}`);
      for (const dept of result.stats.emptiedDepartments) {
        console.warn(`   ${dept} has every metric turned off, so its section will be empty.`);
      }
    }
  }

  // What was saved on the Sources screen - real sheet ids, the tab a link
  // was copied from, column maps, uploaded files - laid over the placeholders.
  const { loadLive, mergeLive } = await import('../connectors/live.js');
  const live = await loadLive(process.env);
  if (live.error && live.error !== 'offline') console.warn(`Supabase not reachable (${live.error}) - using config/sources.json only.`);
  else if (!live.error) {
    console.log(`Sources screen: ${live.sources.size} source rows, ${live.mappings.size} column maps, ${live.uploads.size} uploads.`);
  }
  const sourcesConfig = mergeLive(await readJson(join(ROOT, 'config/sources.json')), live);

  return {
    org: await readJson(join(ROOT, 'config/org.json')),
    catalog: applied,
    sources: sourcesConfig,
    // Optional. A repo with no meetings.json has one room and one dashboard.
    meetings: await readJsonOr(join(ROOT, 'config/meetings.json'), null)
  };
};

/**
 * Which meetings this invocation covers.
 *
 *   --meeting <id>   just that one
 *   (nothing)        every meeting in the file
 *   no meetings.json [null] - the single whole-company run, as before
 *
 * The null entry is what keeps the no-meetings path alive: every command below
 * branches on `meeting === null` rather than on the presence of a config file.
 */
async function selectMeetings(argv, meetingsConfig) {
  const { loadMeetings } = await import('../engine/meetings.js');
  const all = loadMeetings(meetingsConfig);
  if (!all.length) return [null];

  const wanted = arg(argv, 'meeting');
  if (!wanted) return all;

  const hit = all.find((m) => m.id === wanted);
  if (!hit) {
    console.error(`Unknown meeting "${wanted}". Configured: ${all.map((m) => m.id).join(', ')}`);
    return [];
  }
  return [hit];
}

/** out/india_charter-2026-10-19.html, or out/wbr-2026-10-19.html with no meetings. */
const outName = (meeting, periodStart) => `${meeting ? meeting.id : 'wbr'}-${periodStart}.html`;
/** data/snapshots/india_charter-2026-10-19.json, or .../2026-10-19.json. */
const snapName = (meeting, periodStart) => `${meeting ? `${meeting.id}-` : ''}${periodStart}.json`;

/** Monday-anchored week containing `date`. The cadence config owns the anchor. */
export function weekBounds(date, weekStartsOn = 'monday') {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  const shift = weekStartsOn === 'sunday' ? 0 : 1;
  const dow = d.getUTCDay();
  const back = (dow - shift + 7) % 7;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - back);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const arg = (argv, name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

// ---------------------------------------------------------------------------
// check - what is not set up yet
// ---------------------------------------------------------------------------
// Run this first, and after every config change. It answers the only question
// that matters during setup: whose turn is it to do something.
async function cmdCheck(argv = []) {
  const { org, catalog, sources, meetings } = await loadConfig();
  const { ownerAudit, teamLabel, ownerTeam } = await import('../engine/owners.js');
  const { loadMeetings, metricsForMeeting, metricsWithNoMeeting } =
    await import('../engine/meetings.js');

  const problems = [];

  for (const s of sources.sources) {
    if (String(s.ref ?? '').startsWith('REPLACE_WITH')) {
      problems.push([s.dept, `source "${s.label}" - paste the link or upload a CSV`]);
    }
  }

  // Perf Marketing labels its India and US metrics identically - "Spend",
  // "Spend" - so without the segment the list reads as a duplicate and one of
  // the two gets skipped over.
  const metricName = (m) => `"${m.label}"${m.segment ? ` [${m.segment}]` : ''}`;

  const requireTargets = catalog._targets?.require_targets !== false;
  if (requireTargets) {
    for (const m of catalog.metrics) {
      if (m.target === null || m.target === undefined) {
        problems.push([m.dept, `metric ${metricName(m)} - target to be set`]);
      }
    }
  }

  // --- owners ---------------------------------------------------------------
  // Two different gaps, reported differently because they need different
  // answers. A department with an EMPTY trio needs the founder to name three
  // people; a metric with no owner needs one of three named people to put their
  // hand up. Collapsing them would send both asks to whoever reads it first.
  const audit = ownerAudit(catalog, org);

  for (const m of audit.unassigned) {
    // Skip the ones already covered by "no owners at all" below: asking three
    // people who do not exist to pick one of themselves is not an instruction.
    if (!ownerTeam(m.dept, org).length) continue;
    const def = catalog.metrics.find((x) => x.id === m.metricId) || m;
    problems.push([m.dept, `metric ${metricName(def)} - owner to be named`]);
  }
  for (const m of audit.invalid) {
    const def = catalog.metrics.find((x) => x.id === m.metricId) || m;
    problems.push([
      m.dept,
      `metric ${metricName(def)} names "${m.declared}" as its owner, who is not one of `
      + `${teamLabel(m.dept, org)} - that flag would be addressed to nobody`
    ]);
  }

  // --- meetings -------------------------------------------------------------
  const charters = loadMeetings(meetings);
  const orphanMetrics = metricsWithNoMeeting(charters, catalog);
  for (const m of orphanMetrics) {
    problems.push([
      m.dept,
      `metric "${m.label}" is read in NO meeting - no room covers `
      + `${m.dept}${m.segment ? `[${m.segment}]` : ' without a segment'}`
    ]);
  }

  const byDept = new Map();
  for (const [dept, msg] of problems) {
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(msg);
  }

  if (charters.length) {
    console.log(`${charters.length} weekly reviews configured:`);
    for (const m of charters) {
      const members = m.members
        .map((x) => `${x.dept}${x.segment ? `[${x.segment}]` : ''}`)
        .join(' + ');
      console.log(
        `   ${(m.day ?? '?').padEnd(10)} ${m.name.padEnd(30)} `
        + `${String(metricsForMeeting(m, catalog).length).padStart(3)} metrics   ${members}`
      );
    }
    console.log('');
  }

  // A department with NOBODY named is not one more line in a list of ninety.
  // It is the item that makes every other line about that department
  // unanswerable, so it is printed first, on its own, before anything else.
  // Rendering it as a blank - or as the department's own label standing in for
  // a person - is exactly how it stays unfixed.
  if (audit.unownedDepartments.length) {
    for (const d of audit.unownedDepartments) {
      const rooms = charters
        .filter((m) => m.members.some((x) => x.dept === d.dept))
        .map((m) => `${m.name}${m.day ? ` (${m.day})` : ''}`);
      console.log(`NOBODY OWNS ${d.label.toUpperCase()}`);
      console.log(
        `   org.json names no one for ${d.label}. All ${d.metricCount} of its metrics are `
        + 'unowned, and every flag about them is addressed to "[OWNER NEEDED]".'
      );
      console.log(
        rooms.length
          ? `   It has no meeting of its own: it is read in ${rooms.join(' and ')}.`
            + ' So who answers for these numbers is a real question, not a blank field.'
          : '   It is also read in no meeting at all.'
      );
      console.log('   Name them in org.json owners, then set "owner" per metric.\n');
    }
  }

  if (!problems.length) {
    console.log('Everything is connected, targeted and owned. Ready to run.');
    return 0;
  }

  // Framing matters here. These are blanks waiting on a named person, not
  // errors - targets and per-metric owners are DELIBERATELY unset until each
  // line fills them in. A list that reads as failure gets skimmed and resented;
  // a list that reads as "these are yours" gets done. Same data, different verb.
  console.log(`${problems.length} blanks to fill. Each one is waiting on a named person.\n`);
  for (const d of org.departments) {
    const items = byDept.get(d.id);
    if (!items?.length) continue;
    const team = teamLabel(d.id, org);
    console.log(`${d.label}`);
    console.log(`   To be filled by ${team}`);
    for (const m of items) console.log(`   - ${m}`);
    console.log('');
  }
  const orphans = [...byDept.keys()].filter((k) => !org.departments.some((d) => d.id === k));
  for (const k of orphans) {
    console.log(`${k}\n   - ${byDept.get(k).join('\n   - ')}\n`);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// run - read every source, compute every metric, write a snapshot
// ---------------------------------------------------------------------------
async function cmdRun(argv) {
  const { org, catalog, sources, meetings } = await loadConfig();
  const dry = argv.includes('--dry-run');
  const week = arg(argv, 'week', new Date().toISOString().slice(0, 10));
  const period = weekBounds(week, org.cadence?.week_starts);

  const selected = await selectMeetings(argv, meetings);
  if (!selected.length) return 1;

  let worst = 0;
  for (const meeting of selected) {
    const code = await runOne({ meeting, org, catalog, sources, meetings, period, week, dry });
    worst = Math.max(worst, code);
  }
  return worst;
}

/**
 * One meeting, one period. `meeting === null` means the whole company in one
 * room, which is what a repo with no meetings.json gets.
 */
async function runOne({ meeting, org, catalog, sources, meetings, period, week, dry }) {
  const { metricsForMeeting } = await import('../engine/meetings.js');
  const { runPeriod } = await import('../engine/run.js');
  const { fetchSource } = await import('../connectors/index.js');

  // The catalogue, cut to what this room reads. Perf India rides with Tuesday
  // and Perf US with Wednesday, so each room reads a whole number rather than
  // half of one it cannot act on.
  const scoped = meeting
    ? { ...catalog, metrics: metricsForMeeting(meeting, catalog) }
    : catalog;

  const prior = await loadPrior(period.start, meeting);

  console.log(
    meeting
      ? `\n${meeting.name} (${meeting.day ?? 'unscheduled'}) - ${scoped.metrics.length} metrics, `
        + `${period.start} to ${period.end}...`
      : `Reading ${period.start} to ${period.end}...`
  );

  const { run, snapshots, flags } = await runPeriod({
    catalog: scoped,
    sources,
    org,
    periodStart: period.start,
    periodEnd: period.end,
    prior,
    now: new Date().toISOString(),
    // The metric's tab rides along as _tab: the hiring tracker serves two
    // different tables from one source, chosen by it.
    fetch: (source, query, p) => fetchSource({ ...source, _tab: query && query.tab }, p ?? period, process.env)
  });

  if (meeting) run.meetingId = meeting.id;

  const counts = snapshots.reduce((a, s) => ({ ...a, [s.health]: (a[s.health] ?? 0) + 1 }), {});
  console.log(`${snapshots.length} metrics, status ${run.status}`);
  for (const [k, v] of Object.entries(counts)) console.log(`   ${k.padEnd(10)} ${v}`);

  if (flags.length) {
    console.log(`\n${flags.length} flags raised:`);
    for (const f of flags) console.log(`   ${(f.owner ?? '?').padEnd(24)} ${f.title}`);
  }

  if (dry) {
    console.log('Dry run - nothing written.');
    return run.status === 'failed' ? 1 : 0;
  }

  await mkdir(join(DATA, 'snapshots'), { recursive: true });
  const name = snapName(meeting, period.start);
  await writeFile(
    join(DATA, 'snapshots', name),
    JSON.stringify({ run, snapshots, flags, ...(meeting ? { meetingId: meeting.id } : {}) }, null, 2)
  );
  console.log(`Wrote data/snapshots/${name}`);

  await renderOne({ meeting, org, catalog, meetings, period });
  return run.status === 'failed' ? 1 : 0;
}

/**
 * The most recent snapshot file strictly before this period, for deltas.
 *
 * Scoped to the same meeting: Tuesday's deltas must come from last Tuesday, not
 * from whichever room happened to run most recently. A delta computed across
 * two different metric sets is not a delta.
 */
async function loadPrior(periodStart, meeting) {
  const prefix = meeting ? `${meeting.id}-` : '';
  try {
    const files = (await readdir(join(DATA, 'snapshots')))
      .filter((f) => f.endsWith('.json') && f.startsWith(prefix))
      .filter((f) => {
        const rest = f.slice(prefix.length);
        // Without a meeting, skip the per-meeting files: "india_charter-..."
        // does not start with a date and must not be read as one.
        return /^\d{4}-\d{2}-\d{2}\.json$/.test(rest) && rest.slice(0, 10) < periodStart;
      })
      .sort();
    if (!files.length) return {};
    const { snapshots } = await readJson(join(DATA, 'snapshots', files.at(-1)));
    return Object.fromEntries(snapshots.map((s) => [s.metricId, s]));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// render - rebuild the dashboard from snapshots already on disk
// ---------------------------------------------------------------------------
// Separate from `run` on purpose: re-rendering must never re-read a source.
// A past week has to render identically forever, or the snapshot promise is
// worthless.
async function cmdRender(argv) {
  const { org, catalog, meetings } = await loadConfig();
  const week = arg(argv, 'week', new Date().toISOString().slice(0, 10));
  const period = weekBounds(week, org.cadence?.week_starts);

  const selected = await selectMeetings(argv, meetings);
  if (!selected.length) return 1;

  let worst = 0;
  for (const meeting of selected) {
    worst = Math.max(worst, await renderOne({ meeting, org, catalog, meetings, period, week }));
  }
  return worst;
}

async function renderOne({ meeting, org, catalog, meetings, period, week }) {
  const snapFile = snapName(meeting, period.start);
  let payload;
  try {
    payload = await readJson(join(DATA, 'snapshots', snapFile));
  } catch {
    const flag = meeting ? ` --meeting ${meeting.id}` : '';
    console.error(
      `No snapshot at data/snapshots/${snapFile}. `
      + `Run "pulse run --week ${week ?? period.start}${flag}" first.`
    );
    return 1;
  }

  const { renderDashboard } = await import('../render/dashboard.js');
  const { cardsForMeeting, metricsForMeeting } = await import('../engine/meetings.js');
  const { blockersForMeeting } = await import('../transcript/dependencies.js');
  const { deptScoreboard } = await import('../engine/scoreboard.js');
  const { rollupRag } = await import('../engine/rag.js');
  const { deriveRagFlags } = await import('../engine/flags.js');
  const state = await loadState();

  // The stand-up calls are rolled up at RENDER time, not at run time, because
  // they are not fetched from a source - a human wrote them down. Rolling them
  // up here keeps a re-render deterministic from the files on disk, which is the
  // same promise the snapshots make.
  const now = new Date().toISOString();
  const rag = rollupRag(state.rag, { ...(org.rag ?? {}), now });
  const ragFlags = deriveRagFlags(rag, { org, now });
  for (const w of rag.warnings) console.warn(`RAG: ${w}`);

  // Cards, like metrics, are cut to this room - segment included, so Tuesday
  // gets the Perf India card and not the Perf US one.
  const defs = meeting ? metricsForMeeting(meeting, catalog) : (catalog.metrics ?? []);
  const scopedCatalog = meeting
    ? { ...catalog, metrics: defs, cards: cardsForMeeting(meeting, catalog) }
    : catalog;

  // The scoreboard answers the target question before anyone narrates, so it is
  // the first thing in the room. It is derived here rather than stored, because
  // it is a pure function of the snapshots on disk and must never disagree with
  // them. The rows carry the owning TRIO; the flags below carry one name each.
  // Seeded from org.json, so it holds a row per department whether or not this
  // room reads it. Trimmed to this room's members: a zeroed row for a team that
  // is not here reads as "they are at zero", which is a different and worse
  // claim than "they are not in this meeting".
  const inRoom = meeting ? new Set(meeting.members.map((m) => m.dept)) : null;
  const scoreboard = deptScoreboard(payload.snapshots ?? [], defs, org)
    .filter((r) => !inRoom || inRoom.has(r.deptId));

  // THE CROSS-MEETING ROUTE. A blocker whose other end sits in a different
  // review is shown HERE TOO, marked as raised elsewhere - because there is no
  // fifth meeting where both parties would be, and without this the team that
  // can clear it never sees the card.
  const blockers = meeting
    ? blockersForMeeting(state.blockers, meeting.id, { meetings, catalog, org })
    : state.blockers;

  const carried = blockers.filter((b) => b.foreign).length;
  if (carried) {
    console.log(
      `   ${carried} cross-meeting blocker${carried === 1 ? '' : 's'} carried into this room `
      + '(raised where this team was not present)'
    );
  }

  const html = renderDashboard({
    run: payload.run,
    snapshots: payload.snapshots,
    flags: [...(payload.flags ?? []), ...ragFlags],
    decisions: state.decisions,
    events: state.events,
    blockers,
    notes: state.notes,
    scoreboard,
    rag,
    catalog: scopedCatalog,
    org,
    meeting,
    meta: {
      period,
      company: org.company,
      reviewGroup: org.review_group,
      ...(meeting
        ? {
          title: meeting.name,
          docTitle: `${org.company || 'ShopOS'} &middot; ${meeting.name}`,
          runLabel: meeting.day ? `${meeting.day} review` : null
        }
        : {})
    }
  });

  await mkdir(OUT, { recursive: true });
  const outPath = join(OUT, outName(meeting, period.start));
  await writeFile(outPath, html);
  console.log(`Wrote ${outPath}  (${(html.length / 1024).toFixed(0)} KB)`);
  return 0;
}

async function loadState() {
  const read = async (name, fallback) => {
    try { return await readJson(join(DATA, name)); } catch { return fallback; }
  };
  return {
    decisions: await read('decisions.json', []),
    events: await read('decision-events.json', []),
    blockers: await read('blockers.json', []),
    notes: await read('notes.json', []),
    // One RagStatus per subject per day. Appended to, never overwritten - the
    // history is what makes "red for six days running" answerable.
    rag: await read('rag.json', [])
  };
}

// ---------------------------------------------------------------------------
// meeting - fold a meeting into the running record
// ---------------------------------------------------------------------------
// Takes the EXTRACTION (structured JSON), not the raw transcript. Turning words
// into structure is a model's job and happens upstream against
// transcript/extract.spec.md; this step is deterministic and auditable, which
// is what you want touching the decision record.
async function cmdMeeting(argv) {
  const path = argv.find((a) => !a.startsWith('--') && a.endsWith('.json'));
  if (!path) {
    console.error('Usage: pulse meeting <extraction.json> [--week YYYY-MM-DD]');
    console.error('Produce the extraction by running a transcript through transcript/extract.spec.md.');
    return 1;
  }

  const { org, catalog, meetings } = await loadConfig();
  const week = arg(argv, 'week', new Date().toISOString().slice(0, 10));
  const period = weekBounds(week, org.cadence?.week_starts);

  const extraction = await readJson(path);
  const state = await loadState();

  // Which of the four rooms this transcript came from, if it says.
  const [charter] = await selectMeetings(argv, meetings);

  let snapshots = [];
  const snapFile = snapName(charter, period.start);
  try {
    ({ snapshots } = await readJson(join(DATA, 'snapshots', snapFile)));
  } catch {
    console.warn(`No snapshot at data/snapshots/${snapFile} - stated-vs-measured checks skipped.`);
  }

  const { applyMeeting } = await import('../transcript/apply.js');
  const meeting = {
    id: `${charter ? charter.id : 'm'}-${period.start}`,
    date: period.start,
    kind: charter ? charter.id : 'wbr',
    attendees: []
  };

  const result = applyMeeting({
    extraction,
    snapshots,
    openDecisions: state.decisions,
    openBlockers: state.blockers,
    meeting,
    catalog,
    org,
    // Turns on cross-meeting detection: a blocker whose other end is in a
    // different review escalates now rather than in a fortnight.
    meetings
  });

  await mkdir(DATA, { recursive: true });
  const write = (n, v) => writeFile(join(DATA, n), JSON.stringify(v, null, 2));
  await write('decisions.json', result.decisions);
  await write('decision-events.json', [...state.events, ...(result.events ?? [])]);
  if (result.blockers) await write('blockers.json', result.blockers);
  if (result.notes) await write('notes.json', [...state.notes, ...result.notes]);

  console.log(result.report ?? 'Meeting applied.');

  if (result.unmatched?.length) {
    console.log(`\n${result.unmatched.length} items need a human to merge or split:`);
    for (const u of result.unmatched) console.log(`   - ${u.headline ?? u.title ?? JSON.stringify(u)}`);
  }
  if (result.flags?.length) {
    console.log(`\n${result.flags.length} flags from this meeting:`);
    for (const f of result.flags) console.log(`   ${(f.owner ?? '?').padEnd(24)} ${f.title}`);
  }

  const cross = (result.blockers ?? []).filter((b) => b.crossMeeting && b.status !== 'resolved_in_room');
  if (cross.length) {
    console.log(
      `\n${cross.length} cross-meeting blocker${cross.length === 1 ? '' : 's'} `
      + '- escalated on sight, and shown in both rooms:'
    );
    for (const b of cross) console.log(`   ${b.raisedBy} -> ${b.needsFrom}   ${b.title}`);
  }

  // Re-render every room, not just this one: a blocker raised here lands on
  // somebody else's dashboard, and that only happens if theirs is rebuilt too.
  await cmdRender(['--week', week]);
  return 0;
}

// ---------------------------------------------------------------------------

const COMMANDS = { run: cmdRun, render: cmdRender, meeting: cmdMeeting, check: cmdCheck };

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'run';
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`Unknown command "${cmd}". Try: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(1);
  }
  process.exit((await fn(argv)) ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}
