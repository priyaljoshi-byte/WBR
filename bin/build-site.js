#!/usr/bin/env node
/**
 * Assembles site/ - the one folder a static host serves.
 *
 * The pieces live apart in the repo because they are built and tested apart,
 * but a host can only be pointed at one directory. So:
 *
 *   site/                 the dashboards and the index  (from out/)
 *   site/app/             the intake screens            (from app/)
 *   site/engine/          the two modules app/ imports  (from engine/)
 *   site/config/          the JSON the app reads        (from config/)
 *
 * Point Vercel or Netlify at `site`. Nothing else.
 *
 * WHAT IS DELIBERATELY NOT COPIED
 * ===============================
 * .env, data/, node_modules, tests, supabase/ and the CLI. A static host serves
 * every byte it is given to anyone who guesses the path, so this copies an
 * allowlist rather than excluding a blocklist - a blocklist is one forgotten
 * entry away from publishing a key.
 *
 * It also refuses to write a file that looks like a credential. That check is
 * the last line of defence and it is meant to be noisy.
 */

import { readdir, mkdir, copyFile, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

/** Only these move. Adding a folder here is a deliberate act. */
const COPY = [
  { from: 'out',    to: '.',       exts: ['.html', '.txt'] },
  { from: 'app',    to: 'app',     exts: ['.html', '.js', '.css'], skipDirs: ['__tests__'] },
  { from: 'engine', to: 'engine',  exts: ['.js'],                  skipDirs: ['__tests__'] },
  { from: 'config', to: 'config',  exts: ['.json'] },
  // The Sources screen draws real ring cards from an uploaded file, using the
  // SAME renderer the dashboard uses rather than a second copy of it. Only the
  // three modules that are pure ship: render/sample.js imports node:fs and
  // would 404 at best, so this rule names files instead of taking the folder.
  // Adding one here is a deliberate act - check it imports nothing Node-only.
  { from: 'render', to: 'render',  exts: ['.js'], files: ['rings.js', 'card.js', 'util.js'] }
];

/** Anything matching these never ships, whatever the allowlist says. */
const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9\-_]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bservice_role\b/,
  /\bSUPABASE_SERVICE_KEY\s*[:=]\s*["'][^"']+["']/,
  /\bntn_[A-Za-z0-9]{20,}/
];

async function walk(dir, skipDirs = []) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (skipDirs.includes(e.name) || e.name.startsWith('.')) continue;
      out.push(...await walk(join(dir, e.name), skipDirs));
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

async function main() {
  await rm(SITE, { recursive: true, force: true });

  // TWO PASSES, on purpose. The first only reads and decides; nothing is
  // written until every file has been cleared. An earlier version copied as it
  // went and then printed "nothing was published" after having already written
  // 46 files - true enough in effect, because the non-zero exit stops the
  // deploy, but a safety message that is literally false is not a safety
  // message. If one file is dirty, site/ does not come into existence.
  const planned = [];
  const refused = [];

  for (const rule of COPY) {
    const src = join(ROOT, rule.from);
    try { await stat(src); } catch { continue; }

    for (const file of await walk(src, rule.skipDirs ?? [])) {
      if (!rule.exts.includes(extname(file))) continue;
      // An allowlist of filenames, where taking a whole folder would ship a
      // module that cannot run in a browser.
      if (rule.files && !rule.files.includes(relative(src, file))) continue;

      const text = await readFile(file, 'utf8').catch(() => '');
      const hit = SECRET_SHAPES.find((re) => re.test(text));
      if (hit) {
        refused.push(`${relative(ROOT, file)}  (matched ${hit})`);
        continue;
      }
      planned.push({ file, dest: join(SITE, rule.to, relative(src, file)) });
    }
  }

  if (refused.length) {
    console.error('REFUSED - these look like they contain credentials:');
    for (const r of refused) console.error(`   ${r}`);
    console.error('\nsite/ was not written. Move the secret into the environment and re-run.');
    process.exit(1);
  }

  let copied = 0;
  for (const { file, dest } of planned) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(file, dest);
    copied++;
  }

  // A deploy with no landing page is a 404 for everyone, so say so loudly.
  try {
    await stat(join(SITE, 'index.html'));
  } catch {
    console.error('site/index.html is missing - run `node bin/build-index.js` first.');
    process.exit(1);
  }

  console.log(`site/  ${copied} files`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
