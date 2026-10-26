/**
 * Google Sheets connector
 * =======================
 * Reads a tab as rows. Auth is a service account, which matters for a reason
 * worth stating plainly: a service account is a robot with its own email
 * address. You share a sheet with it exactly like you would share with a
 * colleague. Nobody has to hand over their personal Google login, and when
 * someone leaves the company their access going away does not break the
 * dashboard.
 *
 * Zero dependencies - the JWT is signed here with node:crypto.
 */

import { createSign } from 'node:crypto';
import { parseDate, parseDateColumn } from '../engine/dates.js';
import { normalizeRows } from './index.js';
import { fetchSheetCsv } from '../app/sheets.js';
import { parseCSV } from '../app/csv.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedToken = null; // { token, expiresAt }

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a short-lived access token from the service account key.
 * Cached until 60s before expiry - a run touches several sheets and there is no
 * reason to re-handshake for each one.
 */
export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const email = env.GOOGLE_SA_EMAIL;
  const key = (env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY not set - see .env.example');
  }

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(key))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  if (!res.ok) {
    throw new Error(`Google auth failed (${res.status}). Check the service account key.`);
  }
  const json = await res.json();
  cachedToken = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) };
  return cachedToken.token;
}

/**
 * @param {object} source  sources.json entry: {ref, header_row, date_column}
 * @param {object} period  {start, end}
 */
export async function fetchGsheet(source, period, env) {
  // No service account yet: read the sheet the way the browser does, through
  // its link sharing. Same rows, no credentials - it only needs the sheet set
  // to "Anyone with the link can view".
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) return fetchGsheetPublic(source, period);

  const token = await getAccessToken(env);
  const gid = source.gid ?? source.config?.gid ?? null;
  let tab = source.tab ?? source._tab ?? null;
  // The Sources screen stores the tab the link was copied from as a gid, which
  // is exact; the API wants the title, so look it up. A gid wins over a name.
  if (gid !== null && gid !== undefined && gid !== '') {
    const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${source.ref}?fields=sheets.properties(sheetId,title)`,
      { headers: { authorization: `Bearer ${token}` } });
    if (!meta.ok) throw new Error(`could not list tabs (Sheets API ${meta.status}).`);
    const hit = ((await meta.json()).sheets || []).find((sh) => String(sh.properties.sheetId) === String(gid));
    if (!hit) throw new Error(`no tab with id ${gid} in sheet ${source.ref}.`);
    tab = `'${hit.properties.title.replace(/'/g, "''")}'`;
  }

  // A1 range. Unqualified means "the whole first tab", which is the common case
  // for a single-purpose tracker sheet.
  const range = tab ? `${encodeURIComponent(tab)}` : 'A:ZZ';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${source.ref}/values/${range}`
    + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 403) {
    throw new Error(`no access. Share the sheet with ${env.GOOGLE_SA_EMAIL} as a Viewer.`);
  }
  if (res.status === 404) {
    throw new Error(`sheet or tab not found (ref ${source.ref}, tab ${tab ?? 'first'}).`);
  }
  if (!res.ok) throw new Error(`Sheets API ${res.status}`);

  const { values = [] } = await res.json();
  let headerIndex = Math.max(0, (source.header_row ?? 1) - 1);
  // A sheet with empty rows above its header: the header is the first row with
  // anything in it, same as the browser read.
  while (headerIndex < values.length - 1 && !(values[headerIndex] || []).some((c) => c !== '' && c != null)) headerIndex += 1;
  const headers = values[headerIndex] ?? [];
  const body = values.slice(headerIndex + 1).filter((r) => r.some((c) => c !== '' && c != null));

  const { columns, rows } = normalizeRows(headers, body);
  const filtered = filterToPeriod(rows, source.date_column, period, {
    dateOrder: source.date_order,
    defaultDateOrder: source.default_date_order,
    sourceLabel: source.label || source.id
  });

  return {
    columns,
    rows: filtered.rows,
    asOf: filtered.latestDate,
    warnings: filtered.warnings,
    ...(filtered.droppedAll
      ? { warning: `every row fell outside ${period.start} to ${period.end}` }
      : {})
  };
}

/**
 * The no-credentials read, through app/sheets.js - the exact module the
 * Sources screen uses, so the run and the browser read the same cells.
 */
export async function fetchGsheetPublic(source, period, opts = {}) {
  const gid = source.gid ?? source.config?.gid ?? null;
  const tab = gid ? null : (source.tab ?? source._tab ?? null);
  let res;
  try {
    res = await fetchSheetCsv(source.ref, { gid, tab, fetchImpl: opts.fetchImpl });
  } catch (err) {
    throw new Error(`${err.message}${err.fix ? ` ${err.fix}` : ''}`);
  }
  const parsed = parseCSV(res.text, { headerRow: source.header_row > 1 ? source.header_row : 'auto' });
  const { columns, rows } = normalizeRows(parsed.columns, parsed.rows);
  const filtered = filterToPeriod(rows, source.date_column, period, {
    dateOrder: source.date_order,
    defaultDateOrder: source.default_date_order,
    sourceLabel: source.label || source.id
  });
  return {
    columns,
    rows: filtered.rows,
    asOf: filtered.latestDate,
    warnings: [
      ...(gid || !tab ? [] : [`read tab "${tab}" by name - if that name is wrong, Google returns the first tab instead`]),
      ...filtered.warnings
    ],
    ...(filtered.droppedAll ? { warning: `every row fell outside ${period.start} to ${period.end}` } : {})
  };
}

/** Period bounds are ISO dates we wrote ourselves, so they are never ambiguous. */
function boundTime(value) {
  const parsed = parseDate(value);
  if (parsed && parsed.time !== null) return parsed.time;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * Keep only rows inside the period, when the source declares a date column.
 * A source with no date column is treated as a current-state snapshot (a hiring
 * pipeline, an open deal list) and passes through whole - filtering those by
 * date would quietly empty the card.
 *
 * Dates are read by engine/dates.js, not by `new Date(...)`, and the difference
 * is not academic. The real hiring tracker holds "05/10/2026" in the same column
 * as "21/09/2026"; JavaScript reads the first as 10 May and the engine reads it
 * as 5 October, because the second row proves the column is DD/MM. One of those
 * two answers puts the row in the wrong week.
 *
 * A row whose date cannot be read is KEPT and WARNED about. Dropping it would
 * quietly shrink a number; keeping it silently would quietly inflate one. The
 * warning names the column and the exact cell so somebody can fix the sheet.
 *
 * @param {Array<Record<string,any>>} rows
 * @param {string} dateColumn
 * @param {{start:string,end:string}} period
 * @param {Object} [opts]
 * @param {'DMY'|'MDY'} [opts.dateOrder]         the source's `date_order`
 * @param {'DMY'|'MDY'} [opts.defaultDateOrder]  last resort, always warns
 * @param {string} [opts.sourceLabel]
 */
export function filterToPeriod(rows, dateColumn, period, opts = {}) {
  const none = (warnings = []) => ({ rows, latestDate: null, droppedAll: false, warnings });
  if (!dateColumn || !period?.start) return none();
  const key = dateColumn.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_');
  if (!rows.length || !(key in rows[0])) return none();

  const start = boundTime(period.start);
  const end = boundTime(period.end);
  if (start === null || end === null) {
    return none([`period ${period.start} to ${period.end} is not a readable date range - no rows were filtered`]);
  }

  const read = parseDateColumn(rows.map((r) => r[key]), {
    dateOrder: opts.dateOrder,
    defaultDateOrder: opts.defaultDateOrder,
    column: dateColumn,
    sourceLabel: opts.sourceLabel
  });

  const warnings = [...read.warnings];
  if (read.blanks > 0) {
    // One line, not one per row: blanks are common and usually legitimate, but
    // a row with no date was still not filtered, and that has to be visible.
    warnings.push(
      `${read.blanks} row${read.blanks === 1 ? '' : 's'} in column "${dateColumn}" `
      + `${read.blanks === 1 ? 'is' : 'are'} empty - kept and left undated, so `
      + `${read.blanks === 1 ? 'it counts' : 'they count'} towards every period`
    );
  }

  let latest = null;
  const kept = rows.filter((r, i) => {
    const parsed = read.results[i];
    if (!parsed || parsed.time === null) return true; // kept, and warned about above
    if (latest === null || parsed.time > latest) latest = parsed.time;
    return parsed.time >= start && parsed.time <= end;
  });

  return {
    rows: kept,
    latestDate: latest === null ? null : new Date(latest).toISOString(),
    droppedAll: rows.length > 0 && kept.length === 0,
    warnings
  };
}
