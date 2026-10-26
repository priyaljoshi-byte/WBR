/**
 * refs.js - pull the document id out of whatever someone pasted.
 *
 * A department head does not know what a "spreadsheet id" is. They know how to
 * copy the thing in the address bar. So the input is a URL in any of the shapes
 * Google and Notion actually produce, and the output is the id that goes in
 * sources.json `ref` - plus, always, the id echoed back so a human can confirm
 * it is the right document BEFORE anything is connected.
 *
 * Every failure returns a sentence a non-engineer can act on. "Invalid input" is
 * not a message, it is a shrug.
 *
 * No DOM here. Imported by both the page and node:test.
 */

const ok = (kind, id, extra) => Object.assign({ ok: true, kind, id, error: null }, extra || {});
const fail = (kind, error) => ({ ok: false, kind, id: null, error });

/* ---------------------------------------------------------------------------
 * Google Sheets
 * ------------------------------------------------------------------------- */

// Google's own file ids are long and use the URL-safe alphabet. 25 is a floor
// well under the real length (44) and well above any path word like "edit".
const BARE_SHEET_ID = /^[A-Za-z0-9_-]{25,}$/;

/**
 * Handles:
 *   https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0
 *   https://docs.google.com/spreadsheets/d/<ID>/edit?usp=sharing&gid=12#gid=12
 *   https://docs.google.com/spreadsheets/d/<ID>          (no /edit suffix)
 *   https://docs.google.com/spreadsheets/u/0/d/<ID>/edit (signed into several accounts)
 *   <ID>                                                 (pasted on its own)
 * Rejects, with an explanation:
 *   a "publish to web" link (/spreadsheets/d/e/2PACX-.../pubhtml) - that id is
 *   not the file id and the API cannot read it
 *   a Docs / Slides / Forms link
 * @param {string} raw
 */
export function parseSheetRef(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return fail('gsheet', 'Paste the Google Sheets link from your browser address bar.');

  if (/\/spreadsheets\/(?:u\/\d+\/)?d\/e\//.test(s)) {
    return fail('gsheet',
      'That is a "publish to web" link. Pulse reads the file itself, so use Share -> Copy link instead.');
  }

  const m = s.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/);
  if (m) {
    const id = m[1];
    if (!BARE_SHEET_ID.test(id)) {
      return fail('gsheet', `Found "${id}" in that link, which is too short to be a spreadsheet id. Copy the whole link.`);
    }
    return ok('gsheet', id, { gid: readGid(s) });
  }

  if (/^https?:\/\//i.test(s)) {
    if (/docs\.google\.com\/document/.test(s)) {
      return fail('gsheet', 'That is a Google Doc, not a Sheet. Pulse reads rows, so point it at a spreadsheet.');
    }
    if (/docs\.google\.com\/(presentation|forms)/.test(s)) {
      return fail('gsheet', 'That is a Slides or Forms link. Pulse reads rows, so point it at a spreadsheet.');
    }
    if (/drive\.google\.com/.test(s)) {
      return fail('gsheet', 'That is a Drive folder or file link. Open the sheet itself and copy the link from there.');
    }
    return fail('gsheet', 'That does not look like a Google Sheets link. It should contain /spreadsheets/d/.');
  }

  if (BARE_SHEET_ID.test(s)) return ok('gsheet', s, { gid: null });

  return fail('gsheet', 'That is neither a Google Sheets link nor a spreadsheet id.');
}

function readGid(s) {
  const frag = s.match(/[#&?]gid=(\d+)/);
  return frag ? frag[1] : null;
}

/* ---------------------------------------------------------------------------
 * Notion
 * ------------------------------------------------------------------------- */

// 32 hex, optionally dashed into a uuid. The trailing lookahead stops a longer
// hex run from being chopped into a false positive.
const NOTION_ID = /([0-9a-fA-F]{8})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{12})(?![0-9a-fA-F])/g;

function lastNotionId(text) {
  NOTION_ID.lastIndex = 0;
  let m;
  let last = null;
  while ((m = NOTION_ID.exec(text)) !== null) last = m;
  return last;
}

function dashify(compact) {
  return [
    compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16),
    compact.slice(16, 20), compact.slice(20)
  ].join('-');
}

/**
 * Handles:
 *   https://www.notion.so/<workspace>/<32hex>?v=<32hex>
 *   https://www.notion.so/<workspace>/Some-Title-Slug-<32hex>
 *   https://www.notion.so/<workspace>/<dashed-uuid>
 *   https://<workspace>.notion.site/<slug>-<32hex>
 *   <32hex> or <dashed-uuid>                       (pasted on its own)
 *
 * The `?v=` view id is deliberately ignored: it identifies a saved view, not the
 * database, and connecting to a view is how you end up reading a filtered subset
 * forever without noticing.
 * @param {string} raw
 */
export function parseNotionRef(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return fail('notion', 'Paste the Notion database link, or the database id on its own.');

  let searchIn = s;
  let hadView = false;

  if (/^https?:\/\//i.test(s)) {
    let url;
    try { url = new URL(s); } catch { return fail('notion', 'That link could not be read as a URL.'); }
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (!/(^|\.)notion\.(so|site)$/.test(host)) {
      return fail('notion', `That link points at ${host}, not Notion.`);
    }
    hadView = url.searchParams.has('v');
    // The database id is in the PATH. Everything after ? is a view, a filter or a peek.
    const segment = url.pathname.split('/').filter(Boolean).pop() || '';
    searchIn = decodeURIComponent(segment);
  }

  const m = lastNotionId(searchIn);
  if (!m) {
    if (/^https?:\/\//i.test(s)) {
      return fail('notion',
        'No database id in that link. Open the database as a full page (not a side peek) and copy the link again.');
    }
    return fail('notion', 'That is neither a Notion link nor a 32-character database id.');
  }

  const compact = (m[1] + m[2] + m[3] + m[4] + m[5]).toLowerCase();
  return ok('notion', compact, {
    dashed: dashify(compact),
    viewIdIgnored: hadView,
    titleSlug: slugOf(searchIn, m)
  });
}

function slugOf(segment, match) {
  const before = segment.slice(0, match.index).replace(/[-_]+$/, '');
  if (!before) return null;
  return before.replace(/[-_]+/g, ' ').trim() || null;
}

/* ------------------------------------------------------------------------- */

/**
 * @param {'gsheet'|'notion'} kind
 * @param {string} raw
 */
export function parseRef(kind, raw) {
  if (kind === 'gsheet') return parseSheetRef(raw);
  if (kind === 'notion') return parseNotionRef(raw);
  return fail(kind, `Pulse cannot parse a link for a "${kind}" source. Set it in config or ask an admin.`);
}

/** Does the ref currently stored count as connected? Placeholders do not.
 *  Same rule as `pulse check` in bin/pulse.js, deliberately - the landing page
 *  reproduces that command and the two must never disagree. */
export function isPlaceholderRef(ref) {
  const s = String(ref == null ? '' : ref).trim();
  return !s || /^REPLACE_WITH/i.test(s);
}

/**
 * The sentence the person actually needs next. Connecting is two steps and the
 * second one happens outside Pulse, so a page that stops at "saved" has only done
 * half the job.
 */
export function shareInstruction(kind, serviceAccountEmail) {
  if (kind === 'gsheet') {
    return {
      heading: 'Now share the sheet',
      body: 'Open the sheet, press Share, paste this address and give it Viewer. Pulse reads rows and can never write.',
      copy: serviceAccountEmail || 'pulse@your-project.iam.gserviceaccount.com',
      copyLabel: 'service account address'
    };
  }
  if (kind === 'notion') {
    return {
      heading: 'Now connect the database',
      body: 'Open the database as a full page, press the ... menu at the top right, choose Connections, and add Pulse.',
      copy: null,
      copyLabel: null
    };
  }
  if (kind === 'postgres') {
    return {
      heading: 'An admin connects this one',
      body: 'A database URL is a credential, so it lives in the server environment and never in this browser. Ask the founder\'s office to set it.',
      copy: null, copyLabel: null
    };
  }
  return {
    heading: 'Nothing to share',
    body: 'This source has no system behind it. Use the Type it in tab each week.',
    copy: null, copyLabel: null
  };
}

export default parseRef;
