/**
 * owners.test.js - the trio owns the line of business, ONE of them owns each
 * metric.
 *
 * org.json's _accountability block states the problem this file guards:
 *
 *   "A flag addressed to three people is a flag addressed to nobody. 'US
 *    pipeline is not connected' landing on Anupreet, Karan and Raghav at once
 *    is the oldest failure mode in shared ownership: each assumes one of the
 *    other two has it."
 *
 * So two things have to stay true at once, and they pull in opposite
 * directions: the scoreboard must show all three names (visibility, the
 * founder's first goal) and a flag must name exactly one (accountability, the
 * second). Collapsing either into the other loses a goal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

import { deriveFlags } from '../flags.js';
import { deptScoreboard } from '../scoreboard.js';
import {
  joinNames, metricOwner, ownerAudit, ownerFor, ownerLead, ownerTeam, teamLabel
} from '../owners.js';

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/**
 * `pulse check` is asserted against config/ ALONE.
 *
 * Without this, the test reads whatever data/ happens to hold - and once a
 * department exports its metric choices and someone runs
 * bin/import-selections.js, data/selections.json filters the catalogue and
 * these counts change. The run would be correct and the test would fail,
 * which is the worst kind of failure: it teaches people that importing their
 * own selections "breaks the build".
 *
 * bin/pulse.js already honours PULSE_DATA_DIR, so pointing it at an empty
 * directory is all it takes to pin this to config.
 */
const CHECK_ENV = { ...process.env, PULSE_DATA_DIR: path.join(ROOT, 'node_modules', '.pulse-empty-data'), PULSE_OFFLINE: '1' };
const readJson = async (name) =>
  JSON.parse(await readFile(path.join(ROOT, 'config', name), 'utf8'));

const org = await readJson('org.json');
const catalog = await readJson('catalog.json');

const NOW = '2026-10-25T04:30:00.000Z';

/* ------------------------------------------------------------------------ *
 * the shape itself
 * ------------------------------------------------------------------------ */

test('every line of business on disk has at least one named owner', () => {
  // Asserts the INVARIANT, not the roster. An earlier version of this test
  // hardcoded each trio and asserted Perf Marketing was empty - so the day the
  // founder named Raghav and Imran, a correct change broke the suite. A test
  // that encodes today's data as a fact fails on good news, which teaches
  // people to edit tests to make them green. Assert the rule instead.
  for (const d of org.departments) {
    const team = ownerTeam(d.id, org);
    assert.ok(team.length >= 1, `${d.label} has nobody named`);
    assert.ok(team.every((n) => typeof n === 'string' && n.trim()),
      `${d.label} has a blank name in its team`);
    assert.notEqual(teamLabel(d.id, org), '[OWNER NEEDED]');
  }
});

test('an empty trio resolves to [OWNER NEEDED], so the gap is visible', () => {
  // The behaviour that used to be tested against live Perf Marketing data.
  // A fixture, so it keeps testing the rule after the real roster fills in.
  const empty = {
    departments: [{ id: 'perf_marketing', label: 'Performance Marketing' }],
    owners: { perf_marketing: { team: [], lead: null } }
  };
  assert.deepEqual(ownerTeam('perf_marketing', empty), []);
  assert.equal(teamLabel('perf_marketing', empty), '[OWNER NEEDED]');
  assert.equal(ownerFor('perf_marketing', empty), '[OWNER NEEDED]');
});

test('the legacy {name} shape still reads, as a team of one', () => {
  // A repo or a test that has not migrated keeps working: the owner shape
  // change must not be a flag day.
  const legacy = { owners: { marketing: { name: 'Sai', email: 'sai@shopos.ai' } } };
  assert.deepEqual(ownerTeam('marketing', legacy), ['Sai']);
  assert.equal(ownerFor('marketing', legacy), 'Sai');
  assert.equal(teamLabel('marketing', legacy), 'Sai');

  // A department with no owners entry at all falls back to its label, so a flag
  // always has something on it to go and ask about.
  const withDept = { ...legacy, departments: [{ id: 'legal', label: 'Legal' }] };
  assert.equal(ownerFor('legal', withDept), 'Legal');

  // An entry that exists but names nobody is a DECLARED gap, and says so.
  assert.equal(ownerFor('x', { owners: { x: { team: [], lead: null } } }), '[OWNER NEEDED]');
});

test('an explicit lead outranks the first of the trio', () => {
  const led = { owners: { india_sales: { team: ['Subham', 'Arfin', 'Raghav'], lead: 'Raghav' } } };
  assert.equal(ownerLead('india_sales', led), 'Raghav');
  assert.equal(ownerFor('india_sales', led), 'Raghav');
  assert.equal(teamLabel('india_sales', led), 'Subham, Arfin and Raghav', 'the trio is unchanged');
});

test('joinNames reads as a sentence, never as a blank', () => {
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B and C');
  assert.equal(joinNames(['A', 'B']), 'A and B');
  assert.equal(joinNames(['A']), 'A');
  assert.equal(joinNames([]), '[OWNER NEEDED]');
  assert.equal(joinNames(null), '[OWNER NEEDED]');
});

/* ------------------------------------------------------------------------ *
 * one accountable owner per metric
 * ------------------------------------------------------------------------ */

const SOURCES = { sources: [{ id: 'crm', label: 'India CRM' }] };

const def = (over = {}) => ({
  id: 'india_win_rate', label: 'Win rate', dept: 'india_sales', unit: 'percent',
  source: { ref: 'crm', tab: 'Deals', agg: 'ratio' },
  direction: 'up', target: 30, warn_at: 0.6, crit_at: 0.2, ...over
});

const snap = (over = {}) => ({
  runId: 'r', metricId: 'india_win_rate', periodStart: '2026-10-19', periodEnd: '2026-10-25',
  raw: 4, denominator: 30, normalized: 13, priorRaw: null, priorNormalized: null, delta: null,
  health: 'crit', freshness: 'daily', unit: 'percent', caption: '', rowCount: 9,
  computedAt: NOW, warnings: [], ...over
});

const flagsFor = (defs, over = {}) =>
  deriveFlags([snap(over.snap)], defs, {
    org, sources: SOURCES, now: NOW, requireMetricOwner: true, ...over.config
  });

test('a flag names the metric\'s ASSIGNED owner, not the trio', () => {
  const flags = flagsFor([def({ owner: 'Arfin' })]);
  const offTarget = flags.find((f) => f.kind === 'off_target');

  assert.equal(offTarget.owner, 'Arfin',
    'the one of the three who took this metric, not all three');
  assert.match(offTarget.body, /Arfin owns this number/);
  assert.ok(!offTarget.body.includes('Subham'), 'the other two are not asked');

  // The trio rides along for context - visibility - but is never the address.
  assert.deepEqual(offTarget.ownerTeam, ['Subham', 'Arfin', 'Raghav']);

  // An assigned metric raises no no_owner flag: the gap is closed.
  assert.equal(flags.filter((f) => f.kind === 'no_owner').length, 0);
});

test('the name is matched case-insensitively but echoed as org.json spells it', () => {
  const resolved = metricOwner(def({ owner: 'arfin' }), org);
  assert.equal(resolved.name, 'Arfin');
  assert.equal(resolved.assigned, true);
  assert.equal(resolved.valid, true);
});

test('an unassigned metric falls back to the trio\'s first name, and says so', () => {
  const flags = flagsFor([def()]);

  // Something still lands on somebody - a flag with nobody's name on it is a
  // flag nobody picks up.
  assert.equal(flags.find((f) => f.kind === 'off_target').owner, 'Subham');

  // ...and the gap is reported rather than left silent.
  const gap = flags.find((f) => f.kind === 'no_owner');
  assert.equal(gap.id, 'no_owner:india_win_rate');
  assert.match(gap.title, /has no single accountable owner/);
  assert.equal(gap.owner, 'Subham, Arfin and Raghav',
    'the ONE flag addressed to all three, because picking one is the only thing '
    + 'the three of them can do together');
  assert.match(gap.body, /addressed to nobody/);
  assert.match(gap.body, /set "owner" on india_win_rate/);
  assert.match(gap.body, /Until then it falls to Subham/);
});

test('require_metric_owner is opt-in, and org.json has opted in', () => {
  assert.equal(org._accountability.require_metric_owner, true, 'the config on disk asks for this');

  // A repo that has not opted in is not flooded with setup flags.
  const off = deriveFlags([snap()], [def()], {
    org: { ...org, _accountability: {} }, sources: SOURCES, now: NOW
  });
  assert.equal(off.filter((f) => f.kind === 'no_owner').length, 0);
});

/* ------------------------------------------------------------------------ *
 * a name that is not on the team
 * ------------------------------------------------------------------------ */

test('a metric owner not in the trio raises a flag rather than throwing', () => {
  // The exact failure a single accountable owner exists to prevent, and the
  // silent one: the flag still renders with a plausible name on it while
  // reaching nobody. A spelling mistake must not take the run down either.
  let flags;
  assert.doesNotThrow(() => { flags = flagsFor([def({ owner: 'Arfn' })]); });

  const bad = flags.find((f) => f.kind === 'no_owner');
  assert.ok(bad, 'flagged, not thrown');
  assert.match(bad.title, /names an owner who is not on this team/);
  assert.match(bad.body, /Arfn is not one of Subham, Arfin and Raghav/);
  assert.match(bad.body, /reads as owned and is not/);
  assert.equal(bad.owner, 'Subham, Arfin and Raghav', 'the team that has to correct it');

  // The typo is NOT trusted anywhere else: every other flag about this metric
  // falls back exactly as if no owner had been set.
  assert.equal(flags.find((f) => f.kind === 'off_target').owner, 'Subham');

  const resolved = metricOwner(def({ owner: 'Arfn' }), org);
  assert.equal(resolved.valid, false);
  assert.equal(resolved.assigned, false);
  assert.equal(resolved.declared, 'Arfn');
  assert.equal(resolved.name, 'Subham');
});

test('an invalid owner is reported even when require_metric_owner is off', () => {
  // Opting out of "name somebody" is a choice. Addressing a flag to a person
  // who is not on the team is never a choice, so it is reported regardless.
  const flags = deriveFlags([snap()], [def({ owner: 'Nobody' })], {
    org: { ...org, _accountability: {} }, sources: SOURCES, now: NOW
  });
  const bad = flags.find((f) => f.kind === 'no_owner');
  assert.ok(bad);
  assert.match(bad.body, /Nobody is not one of/);
});

test('ownerAudit separates the two gaps, because they need different answers', () => {
  const audit = ownerAudit({
    metrics: [
      def({ id: 'a', owner: 'Arfin' }),
      def({ id: 'b' }),
      def({ id: 'c', owner: 'Typo' }),
      def({ id: 'd', dept: 'perf_marketing', segment: 'india' })
    ]
  }, org);

  assert.deepEqual(audit.unassigned.map((m) => m.metricId), ['b', 'd']);
  assert.deepEqual(audit.invalid.map((m) => m.metricId), ['c']);
  assert.equal(audit.invalid[0].declared, 'Typo');

  // An empty trio is the founder's to fill; an unassigned metric is the trio's.
  // Reported separately so neither ask gets sent to the wrong person. Uses a
  // fixture department, because every real line is owned now.
  const withGap = ownerAudit(
    { metrics: [{ id: 'z', label: 'Ghost metric', dept: 'ghost_line' }] },
    { ...org,
      departments: [...org.departments, { id: 'ghost_line', label: 'Ghost Line' }],
      owners: { ...org.owners, ghost_line: { team: [], lead: null } } }
  );
  assert.deepEqual(withGap.unownedDepartments.map((d) => d.dept), ['ghost_line']);
  assert.equal(withGap.unownedDepartments[0].metricCount, 1);
  assert.deepEqual(audit.unownedDepartments.map((d) => d.dept), [],
    'every real line of business has names now');
});

/* ------------------------------------------------------------------------ *
 * the scoreboard keeps all three
 * ------------------------------------------------------------------------ */

test('the scoreboard shows the trio while the flags name the individual', () => {
  const board = deptScoreboard([snap()], [def({ owner: 'Arfin' })], org);
  const india = board.find((r) => r.deptId === 'india_sales');

  assert.deepEqual(india.team, ['Subham', 'Arfin', 'Raghav']);
  assert.equal(india.owner, 'Subham, Arfin and Raghav');

  // Same run, same data, one name on the flag. Both goals, at once.
  assert.equal(flagsFor([def({ owner: 'Arfin' })]).find((f) => f.kind === 'off_target').owner,
    'Arfin');

  // Every real line now has names, so the empty-trio half of this rule is
  // asserted against a fixture rather than against whoever is unowned today.
  const gap = deptScoreboard([snap()], [def({})], {
    ...org,
    departments: [...org.departments, { id: 'ghost_line', label: 'Ghost Line' }],
    owners: { ...org.owners, ghost_line: { team: [], lead: null } }
  });
  const ghost = gap.find((r) => r.deptId === 'ghost_line');
  if (ghost) assert.equal(ghost.owner, '[OWNER NEEDED]', 'a blank would read as "fine"');
});

/* ------------------------------------------------------------------------ *
 * pulse check
 * ------------------------------------------------------------------------ */

test('pulse check addresses every blank to the people who must fill it', async () => {
  // Exit code 1: there is setup outstanding. `pulse check` answers one question
  // during setup - whose turn is it to do something - so a non-zero exit is the
  // expected state until that list is empty.
  const { stdout } = await run('node', [path.join(ROOT, 'bin', 'pulse.js'), 'check'], { cwd: ROOT, env: CHECK_ENV })
    .catch((err) => {
      assert.equal(err.code, 1, 'things are still unset, so check exits 1');
      return err;
    });

  // Every department heading names the people the blanks belong to. The
  // "NOBODY OWNS" callout is asserted separately against a fixture, because it
  // only fires for an empty trio and the real roster is now filled in.
  assert.match(stdout, /blanks to fill\. Each one is waiting on a named person\./);
  assert.match(stdout, /India Sales\n\s+To be filled by Subham, Arfin and Raghav/);
  assert.match(stdout, /Performance Marketing\n\s+To be filled by Raghav and Imran/);

  // The per-department heading carries the TRIO, and the unowned one carries
  // the placeholder rather than the department name standing in for a person.

  // Metrics with no single accountable owner, reported PER DEPARTMENT - so the
  // ask lands with the three people who have to settle it between them.
  const block = (label) => {
    const start = stdout.indexOf(`\n${label}\n`);
    assert.notEqual(start, -1, `${label} must have its own block`);
    const end = stdout.indexOf('\n\n', start + 1);
    return stdout.slice(start, end === -1 ? undefined : end);
  };

  assert.match(block('India Sales'), /metric "Win rate" - owner to be named/);
  assert.equal(
    (block('Sloosh Product & Marketing').match(/- owner to be named/g) || []).length,
    17
  );
  // Perf Marketing now HAS owners, so its metrics do get the "pick one" ask.
  assert.match(block('Performance Marketing'), /- owner to be named/);

  // India and US both label their perf metrics "Spend". Without the segment the
  // list reads as a duplicate and one of the two gets skipped over.
  assert.match(stdout, /metric "Spend" \[india\] - target to be set/);
  assert.match(stdout, /metric "Spend" \[us\] - target to be set/);
});

test('pulse check prints the four reviews and what each one reads', async () => {
  const { stdout } = await run('node', [path.join(ROOT, 'bin', 'pulse.js'), 'check'], { cwd: ROOT, env: CHECK_ENV })
    .catch((err) => err);

  assert.match(stdout, /4 weekly reviews configured/);
  assert.match(stdout, /tuesday {4}India & Perf India Charter\s+15 metrics\s+india_sales \+ perf_marketing\[india\]/);
  assert.match(stdout, /wednesday {2}US & Perf US Charter\s+15 metrics\s+us_sales \+ perf_marketing\[us\]/);

  // Every metric in the catalogue is read somewhere, so nothing is reported as
  // orphaned. A metric nobody reads is worse than a metric with no target.
  assert.ok(!/is read in NO meeting/.test(stdout));
  assert.equal(
    catalog.metrics.length,
    7 + 15 + 15 + 17,
    'the four rooms partition the catalogue exactly once'
  );
});
