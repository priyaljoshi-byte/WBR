#!/usr/bin/env node
/**
 * import-selections - the bridge from the browser to the repo.
 *
 *   node bin/import-selections.js ~/Downloads/pulse-export.json
 *   node bin/import-selections.js export.json --dry-run
 *   node bin/import-selections.js export.json --out data/selections.json
 *
 * The Metrics screen writes a department's choices to Supabase. The weekly run
 * reads config/ and data/ off disk. Until the run itself reads Supabase, this
 * command is what carries one to the other: export from the app, drop the file
 * in, re-run.
 *
 * It accepts either the app's full export envelope or a bare selections map,
 * because the person doing this is holding whatever the Export button gave
 * them and should not have to know the difference.
 *
 * It validates against config/catalog.json BEFORE writing, and it refuses to
 * write a file that would silently empty a dashboard. A selections file naming
 * a metric id that no longer exists is not a small problem - it is a metric
 * somebody chose, which is now not being rendered, with nothing on the
 * dashboard to say so.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSelections } from '../engine/selections.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(ROOT, 'data', 'selections.json');

const arg = (argv, name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

function usage() {
  console.error('Usage: node bin/import-selections.js <export.json> [--out data/selections.json] [--dry-run]');
  console.error('');
  console.error('  Takes the JSON the app\'s Export button produces and writes data/selections.json,');
  console.error('  which bin/pulse.js reads to decide which metrics render.');
}

export async function main(argv = process.argv.slice(2)) {
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) { usage(); return 1; }

  const dry = argv.includes('--dry-run');
  const out = arg(argv, 'out', DEFAULT_OUT);

  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${path}: ${err.message}`);
    return 1;
  }

  const selections = normalizeSelections(raw);
  const depts = Object.keys(selections);

  if (!depts.length) {
    console.error('That file holds no selections.');
    console.error('');
    console.error('Expected either the app export (a "tables.pulse_selections" array) or a map of');
    console.error('{deptId: {metricId: {enabled, target, owner, direction}}}. Nothing was written.');
    return 1;
  }

  // --- check it against the catalogue before writing anything --------------
  let catalog;
  try {
    catalog = JSON.parse(await readFile(join(ROOT, 'config/catalog.json'), 'utf8'));
  } catch (err) {
    console.error(`Could not read config/catalog.json: ${err.message}`);
    return 1;
  }
  const known = new Map((catalog.metrics || []).map((m) => [m.id, m]));

  const unknown = [];
  const wrongDept = [];
  let enabled = 0;
  let total = 0;

  for (const [dept, metrics] of Object.entries(selections)) {
    for (const [metricId, sel] of Object.entries(metrics)) {
      total += 1;
      if (sel.enabled) enabled += 1;
      const def = known.get(metricId);
      if (!def) { unknown.push(`${dept}/${metricId}`); continue; }
      if (def.dept !== dept) wrongDept.push(`${metricId} is listed under ${dept} but the catalogue says ${def.dept}`);
    }
  }

  if (unknown.length) {
    console.error(`${unknown.length} selected metric${unknown.length === 1 ? ' is' : 's are'} not in config/catalog.json:`);
    for (const u of unknown.slice(0, 12)) console.error(`   ${u}`);
    if (unknown.length > 12) console.error(`   and ${unknown.length - 12} more`);
    console.error('');
    console.error('Either the catalogue changed after these were chosen, or this export came from a');
    console.error('different repo. Nothing was written - a selection naming a metric that does not');
    console.error('exist would drop it from the dashboard with nothing on screen to say why.');
    return 1;
  }
  if (wrongDept.length) {
    console.error('These selections disagree with the catalogue about which department owns them:');
    for (const w of wrongDept) console.error(`   ${w}`);
    console.error('\nNothing was written.');
    return 1;
  }

  // --- the thing that quietly empties a dashboard --------------------------
  const emptied = [];
  for (const [dept, metrics] of Object.entries(selections)) {
    const anyOn = Object.values(metrics).some((s) => s.enabled);
    const deptHasMetrics = (catalog.metrics || []).some((m) => m.dept === dept);
    if (!anyOn && deptHasMetrics) emptied.push(dept);
  }

  const payload = {
    _about: 'Which metrics each department chose on the Metrics screen. Written by bin/import-selections.js. A department absent from this file renders every metric it owns.',
    _sourceFile: path,
    _importedAt: new Date().toISOString(),
    ...selections
  };

  console.log(`${total} selections across ${depts.length} department${depts.length === 1 ? '' : 's'}: ${enabled} on, ${total - enabled} off.`);
  for (const dept of depts) {
    const metrics = selections[dept];
    const on = Object.entries(metrics).filter(([, s]) => s.enabled);
    const withTarget = on.filter(([, s]) => s.target !== null).length;
    const withOwner = on.filter(([, s]) => s.owner).length;
    console.log(
      `   ${dept.padEnd(16)} ${String(on.length).padStart(2)} chosen`
      + `   ${withTarget} targeted, ${withOwner} owned`
      + (on.length > 8 ? '   (over eight - a dashboard nobody can read in ten seconds does not get read)' : '')
    );
  }

  if (emptied.length) {
    console.log('');
    console.log(`${emptied.join(', ')} turned every metric off. Those dashboards will render no rings.`);
    console.log('That is a real choice somebody can make, so it is applied - but it is worth a look.');
  }

  if (dry) {
    console.log('\nDry run - nothing written.');
    return 0;
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nWrote ${out}`);
  console.log('Re-run `node bin/pulse.js run` (or `render`) and the dashboard follows these choices.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code ?? 0)).catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}
