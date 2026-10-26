/**
 * Manual connector
 * ================
 * For numbers that genuinely have no system behind them yet - "how did the event
 * go", "where is leadership hiring". Someone types the value into Pulse and it is
 * stored with the date it was entered.
 *
 * The important behaviour here is the one that looks like a bug: a manual value
 * does NOT carry forward into a new week. If nobody enters it, the metric comes
 * back empty, the engine marks it missing, and a flag goes up naming the owner.
 * A stale number quietly repeating itself week after week is how a dashboard
 * starts lying, and a manual source is where that rot always begins.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const STORE = (env) => env.PULSE_DATA_DIR ?? join(process.cwd(), 'data');

export async function fetchManual(source, period, env) {
  const path = join(STORE(env), 'manual', `${source.id}.json`);

  let entries;
  try {
    entries = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`nobody has entered a value yet. Owner needs to submit it in Pulse.`);
    }
    throw err;
  }

  const start = new Date(period.start).getTime();
  const end = new Date(period.end).getTime();

  const inPeriod = (Array.isArray(entries) ? entries : []).filter((e) => {
    const t = new Date(e.entered_for ?? e.entered_at).getTime();
    return !Number.isNaN(t) && t >= start && t <= end;
  });

  if (!inPeriod.length) {
    const latest = (Array.isArray(entries) ? entries : [])
      .map((e) => e.entered_for ?? e.entered_at)
      .sort()
      .pop();
    throw new Error(
      latest
        ? `no value entered for this period. Last entry was ${String(latest).slice(0, 10)}.`
        : `no value entered for this period.`
    );
  }

  const columns = Object.keys(inPeriod[0]);
  const asOf = inPeriod
    .map((e) => e.entered_at)
    .filter(Boolean)
    .sort()
    .pop() ?? null;

  return { columns, rows: inPeriod, asOf };
}
