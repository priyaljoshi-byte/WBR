/**
 * sheets.js - read a Google Sheet from the browser, today, with no credentials.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * The Sources screen used to extract a spreadsheet id, store it, and tell the
 * reader to share the sheet with a service account that does not exist yet.
 * That is a dead end dressed up as a success: the id is correct, the button
 * says "connected", and no number ever appears.
 *
 * A sheet that is shared "anyone with the link can view" can be read straight
 * from a browser through the Google Visualization endpoint:
 *
 *   https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv&sheet=<TAB>
 *
 * It is CORS-permissive (it echoes the requesting Origin), it needs no OAuth,
 * no API key and no service account, and it returns ordinary CSV - which means
 * the rows land in app/csv.js, the same parser an uploaded file goes through,
 * and every step after that is shared. There is exactly one path from "rows in
 * hand" onwards.
 *
 * This is the IMMEDIATE path. The weekly scheduled run still reads the sheet
 * server-side through connectors/gsheet.js with a service account, which is why
 * the resolved id and tab are stored: both paths must point at the same place,
 * or the dashboard and the browser will disagree and nothing on screen will say
 * which is right.
 *
 * ===========================================================================
 * THE TRAP THIS MODULE EXISTS TO CATCH
 * ===========================================================================
 * Google does NOT fail on an unknown tab. `sheet=Typo` and `gid=999999` both
 * return the FIRST tab, with status 200, as if nothing happened. A reader who
 * mistypes "Offers & Joiners" gets a full table of plausible rows from an
 * entirely different tab and no indication at all.
 *
 * So fetchSheetCsv reads the default tab once, keeps it, and compares. When a
 * named tab comes back byte-identical to the default, it is reported as
 * `fellBack` and the UI says so in words. There is no way to tell a genuine
 * "you named the first tab" from a silent fallback, so the message says that
 * too rather than picking one and sounding certain.
 *
 * Everything this module returns is DATA. Cell contents are never executed,
 * never concatenated into markup, and never read as an instruction.
 */

export const GVIZ_BASE = 'https://docs.google.com/spreadsheets/d';

/** How long to wait before calling it. A sheet that has not answered in 20s is
 *  almost always a permission problem, not a slow one. */
export const FETCH_TIMEOUT_MS = 20000;

/**
 * Build the read URL.
 * @param {string} id        the spreadsheet id, from refs.js parseRef
 * @param {{tab?:string|null, gid?:string|number|null}} [opts]
 */
export function gvizUrl(id, opts = {}) {
  const params = new URLSearchParams();
  params.set('tqx', 'out:csv');
  // gid is exact and wins when both are present; a tab name is what a person
  // actually knows, so it is the one the UI asks for.
  if (opts.gid !== undefined && opts.gid !== null && String(opts.gid) !== '') {
    params.set('gid', String(opts.gid));
  } else if (opts.tab) {
    params.set('sheet', String(opts.tab));
  }
  return `${GVIZ_BASE}/${encodeURIComponent(String(id))}/gviz/tq?${params.toString()}`;
}

/** The share link a person can open to check they pasted the right document. */
export function sheetUrl(id, gid) {
  const base = `${GVIZ_BASE}/${encodeURIComponent(String(id))}/edit`;
  return gid ? `${base}#gid=${encodeURIComponent(String(gid))}` : base;
}

export class SheetFetchError extends Error {
  constructor(message, { kind, status, url, fix } = {}) {
    super(message);
    this.name = 'SheetFetchError';
    /** 'not_shared' | 'not_found' | 'offline' | 'not_csv' | 'empty' | 'http' */
    this.kind = kind || 'http';
    this.status = status ?? null;
    this.url = url || null;
    /** The one sentence that actually fixes it. Printed next to the error. */
    this.fix = fix || null;
  }
}

/** The sentence that resolves nine failures out of ten. */
export const SHARE_FIX =
  'Open the sheet, press Share, and under "General access" choose '
  + '"Anyone with the link" with the role Viewer. Nothing else needs changing, '
  + 'and view access does not let Pulse edit anything.';

/**
 * A response that is HTML rather than CSV is Google's sign-in or
 * "you need access" page. That is the un-shared case, and it is worth naming
 * precisely rather than letting it reach the CSV parser and come back as
 * "no header row was found".
 */
function looksLikeHtml(text) {
  const head = String(text || '').slice(0, 400).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
}

/**
 * Fetch one tab as CSV text.
 *
 * @param {string} id
 * @param {Object} [opts]
 * @param {string|null} [opts.tab]  tab name, as it is spelled on the tab itself
 * @param {string|null} [opts.gid]  tab id, when the pasted link carried one
 * @param {string|null} [opts.compareWith] the default tab's text, for fallback detection
 * @param {typeof fetch} [opts.fetchImpl] injected for tests
 * @returns {Promise<{text:string, url:string, tab:string|null, gid:string|null,
 *                    fellBack:boolean, bytes:number}>}
 */
export async function fetchSheetCsv(id, opts = {}) {
  if (!id) throw new SheetFetchError('No spreadsheet id to read.', { kind: 'not_found' });

  const url = gvizUrl(id, opts);
  const doFetch = opts.fetchImpl || ((...a) => fetch(...a));

  // AbortController is in every browser this app supports; guarded anyway so a
  // test harness without one still works.
  let controller = null;
  let timer = null;
  try { controller = new AbortController(); } catch { /* no abort available */ }
  if (controller) timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(url, {
      // No credentials. This is a public read and sending cookies would make
      // the request behave differently for the person who owns the sheet than
      // for everyone else on the team - which is the worst kind of bug to have
      // in a permissions path.
      credentials: 'omit',
      redirect: 'follow',
      signal: controller ? controller.signal : undefined
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    const aborted = err && (err.name === 'AbortError');
    // A browser reports a CORS refusal as an indistinguishable network failure.
    // In practice, against this endpoint, it means one thing.
    throw new SheetFetchError(
      aborted
        ? 'Google did not answer within twenty seconds.'
        : 'The browser could not read that sheet. Almost always this means the sheet is not link-shared.',
      { kind: aborted ? 'offline' : 'not_shared', url, fix: SHARE_FIX }
    );
  }
  if (timer) clearTimeout(timer);

  if (!res.ok) {
    if (res.status === 404) {
      throw new SheetFetchError(
        'Google says there is no spreadsheet with that id.',
        { kind: 'not_found', status: 404, url, fix: 'Check the link was copied whole, from the address bar of the sheet itself.' }
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new SheetFetchError(
        'That sheet is private, so the browser is not allowed to read it.',
        { kind: 'not_shared', status: res.status, url, fix: SHARE_FIX }
      );
    }
    throw new SheetFetchError(
      `Google answered HTTP ${res.status} for that sheet.`,
      { kind: 'http', status: res.status, url, fix: SHARE_FIX }
    );
  }

  const text = await res.text();

  if (looksLikeHtml(text)) {
    throw new SheetFetchError(
      'Google returned its sign-in page instead of the data, which means the sheet is not link-shared.',
      { kind: 'not_shared', status: res.status, url, fix: SHARE_FIX }
    );
  }
  if (!String(text).trim()) {
    throw new SheetFetchError(
      'That tab came back empty.',
      { kind: 'empty', status: res.status, url, fix: 'Check the tab actually has rows in it, and that the header is on the first row.' }
    );
  }

  const named = !!(opts.tab || (opts.gid !== undefined && opts.gid !== null && String(opts.gid) !== ''));
  const fellBack = !!(named && opts.compareWith && opts.compareWith === text);

  return {
    text,
    url,
    tab: opts.tab || null,
    gid: opts.gid === undefined || opts.gid === null || String(opts.gid) === '' ? null : String(opts.gid),
    fellBack,
    bytes: text.length
  };
}

/**
 * The wording for the silent-fallback case, in one place so the page and any
 * future caller say the same thing.
 *
 * It deliberately does not claim to know which of the two happened, because it
 * cannot: Google's answer is identical either way.
 */
export function fallbackWarning(what) {
  return `The tab you asked for ("${what}") returned exactly the same rows as this sheet's first tab. `
    + 'Google does not report an unknown tab - it quietly answers with the first one instead. '
    + 'So either that IS the first tab, or the name does not match. '
    + 'Check the column names below before you map anything.';
}

export default fetchSheetCsv;
