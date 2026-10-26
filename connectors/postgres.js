/**
 * Postgres connector
 * ==================
 * Runs the read-only query declared in sources.json. Two parameters are always
 * bound: $1 = period start, $2 = period end.
 *
 * Deliberately NOT implemented with a driver dependency. Pulse keeps zero
 * runtime dependencies, and a database driver is the one place that rule costs
 * something real. Two supported paths:
 *
 *   1. Supabase / PostgREST  - set <REF>_REST_URL and <REF>_REST_KEY and the
 *      query runs through a Postgres function over HTTPS. This is the path to
 *      use, since the rest of Pulse already lives on Supabase.
 *   2. Local psql            - set PULSE_ALLOW_PSQL=1 and the query runs through
 *      the psql binary. Useful on a laptop, not on a server.
 *
 * Either way the credential never lands in sources.json - that file holds the
 * NAME of an environment variable, never its value.
 */

import { normalizeRows } from './index.js';

export async function fetchPostgres(source, period, env) {
  const restUrl = env[`${source.ref}_REST_URL`];
  const restKey = env[`${source.ref}_REST_KEY`];

  if (restUrl && restKey) return viaPostgrest({ source, period, restUrl, restKey });
  if (env.PULSE_ALLOW_PSQL === '1') return viaPsql({ source, period, env });

  throw new Error(
    `no connection configured. Set ${source.ref}_REST_URL and ${source.ref}_REST_KEY, `
    + `or PULSE_ALLOW_PSQL=1 for local runs. See .env.example.`
  );
}

/**
 * Calls a Postgres function exposed by PostgREST:
 *
 *   create function pulse_query(sql text, p_start date, p_end date)
 *   returns setof json language plpgsql security definer as $$ ... $$;
 *
 * The function must be owned by a role with SELECT only. Pulse never needs
 * write access to a source, and granting it anyway is how a reporting tool
 * turns into an outage.
 */
async function viaPostgrest({ source, period, restUrl, restKey }) {
  const res = await fetch(`${restUrl.replace(/\/$/, '')}/rpc/pulse_query`, {
    method: 'POST',
    headers: {
      apikey: restKey,
      authorization: `Bearer ${restKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ sql: source.query, p_start: period.start, p_end: period.end })
  });

  if (res.status === 404) {
    throw new Error('pulse_query function not found. Run supabase/schema.sql against this database.');
  }
  if (!res.ok) throw new Error(`query failed (${res.status}): ${await res.text()}`);

  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return { columns: [], rows: [] };

  const headers = Object.keys(rows[0]);
  return { ...normalizeRows(headers, rows), asOf: new Date().toISOString() };
}

async function viaPsql({ source, period, env }) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const conn = env[source.ref];
  if (!conn) throw new Error(`${source.ref} not set in the environment.`);

  const { stdout } = await run('psql', [
    conn, '--no-psqlrc', '--tuples-only', '--no-align',
    '-c', `select json_agg(t) from (${stripTrailingSemicolon(source.query)}) t`,
    '-v', `1=${period.start}`, '-v', `2=${period.end}`
  ], { timeout: 30_000 });

  const rows = JSON.parse(stdout.trim() || '[]') ?? [];
  if (!rows.length) return { columns: [], rows: [] };

  const headers = Object.keys(rows[0]);
  return { ...normalizeRows(headers, rows), asOf: new Date().toISOString() };
}

const stripTrailingSemicolon = (q) => String(q).trim().replace(/;$/, '');
