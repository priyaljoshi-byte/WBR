/**
 * rag.js - the red/amber/green call a human makes out loud.
 *
 * Every other number in this engine is arithmetic performed on rows. This one is
 * not. Perf Marketing runs campaigns for brands at wildly different scale, on
 * different objectives and cost bases, so there is no figure that compares
 * across them - a CPL that is excellent for one brand is a disaster for another.
 * "Is this in trouble" is therefore a question a human answers by reading
 * several numbers together, out loud, in the daily stand-up.
 *
 * WHAT A SUBJECT IS. The company's own WBR already works this way across the
 * whole org: "Status by track" sections run green / amber / white bullets over
 * US Lead Gen, Marketing, SEO and the rest, each with a one-line narrative. So
 * the thing a colour is ABOUT is deliberately generic here - a `subject`, not a
 * brand. Perf Marketing's subjects happen to be brands; Marketing's are tracks;
 * SEO's might be workstreams. `brand` is accepted as an alias on input and
 * echoed back on output, so a per-brand caller needs no change, and a department
 * that calls colours per track needs no code change either. Nothing in this
 * module knows or cares which one it is holding.
 *
 * This module does not compute a colour. It takes the colours humans set and
 * works out the three things a weekly review needs that a daily stand-up cannot
 * hold in its head:
 *
 *   how many of each colour      the shape of the portfolio, in one line
 *   how long each has held       a subject red for one day is a bad day, one red
 *                                for six is a decision nobody has taken
 *   which calls have gone stale  a daily call that stopped being made is an
 *                                absence of a judgement, not a green one
 *
 * Two rules it will not break:
 *
 *   - A status with no reason is not a judgement, it is a mood. There is nothing
 *     in it to agree with, disagree with, or act on, and it would occupy a row
 *     on a page that says somebody made a call. It is dropped and reported.
 *   - Silence is never a colour. A subject nobody called today does not inherit
 *     yesterday's green, and a gap in the history breaks the streak rather than
 *     being counted through. You cannot say something held amber for five days
 *     if nobody looked at it on three of them.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * Four calls, not three.
 *
 * `grey` is the company's own white bullet, and it is NOT a quieter amber. Amber
 * says somebody looked and is worried. Grey says there is nothing to look at yet
 * - not started, or no signal. Collapsing the two would turn every unstarted
 * track into a concern and bury the ones that are genuinely wobbling, which is
 * the opposite of what a status board is for.
 */
export const RAG_STATUSES = ['red', 'amber', 'green', 'grey'];

/**
 * Working order for the room: trouble first, then worry, then the things that
 * have not started, then what is fine. Green last because a green subject is the
 * one nobody needs to spend meeting time on.
 */
const STATUS_RANK = { red: 0, amber: 1, grey: 2, green: 3 };

export const DEFAULT_RAG_CONFIG = {
  /** A DAILY call. Two days without one and the colour on screen is an artefact. */
  stale_after_hours: 48,
  /** Consecutive days on red before it stops being a bad week and becomes a flag. */
  red_days_to_flag: 3,
  /** How many days the strip on the dashboard shows. */
  trend_days: 7
};

/** The thing the call is about. `brand` is the older name and still works. */
export const subjectOf = (status) => {
  if (!status) return null;
  const name = status.subject !== undefined && status.subject !== null && status.subject !== ''
    ? status.subject
    : status.brand;
  return name === undefined || name === null || String(name).trim() === ''
    ? null
    : String(name).trim();
};

/* ------------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------------ */

const toTime = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/** The DAY a call is about: periodStart if given, else the day it was made. */
function dayOf(status) {
  const stated = status && status.periodStart;
  if (stated) {
    const iso = String(stated).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }
  const t = toTime(status && status.setAt);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

const dayNumber = (isoDay) => Math.floor(Date.parse(`${isoDay}T00:00:00Z`) / DAY);
const dayFromNumber = (n) => new Date(n * DAY).toISOString().slice(0, 10);

/**
 * Validate one status. The reason check is the substantive one and it is not
 * negotiable - see the module header.
 * @returns {string|null} why it is invalid, or null if it is fine
 */
export function invalidReason(status) {
  if (!status || typeof status !== 'object') return 'not an object';
  if (!subjectOf(status)) return 'no subject named';
  if (!RAG_STATUSES.includes(status.status)) {
    return `status "${status.status}" is not one of ${RAG_STATUSES.join(', ')}`;
  }
  if (!status.reason || !String(status.reason).trim()) {
    return 'no reason given - a colour with no reason is not a judgement, it is a mood';
  }
  if (dayOf(status) === null) return 'no setAt or periodStart, so the call cannot be dated';
  return null;
}

/** Latest-first by the day the call is about, then by when it was typed. */
function newestFirst(a, b) {
  if (a.day !== b.day) return a.day < b.day ? 1 : -1;
  return (b.setTime || 0) - (a.setTime || 0);
}

function prepare(statuses) {
  const rows = [];
  const warnings = [];
  const invalid = [];

  for (const status of (Array.isArray(statuses) ? statuses : [])) {
    const why = invalidReason(status);
    if (why) {
      invalid.push({ status, reason: why });
      const who = subjectOf(status) || 'an unnamed subject';
      warnings.push(`RAG status for ${who} ignored: ${why}`);
      continue;
    }
    const subject = subjectOf(status);
    rows.push({
      ...status,
      subject,
      // echoed back so a per-brand caller reads the field it passed in
      brand: subject,
      day: dayOf(status),
      setTime: toTime(status.setAt)
    });
  }

  return { rows, warnings, invalid };
}

/**
 * One subject's calls, newest first, de-duplicated to one call per day.
 * A subject re-called twice in a day keeps the later one: the stand-up changed
 * its mind, and the record should say what it settled on.
 */
function byDay(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows.slice().sort(newestFirst)) {
    if (seen.has(row.day)) continue;
    seen.add(row.day);
    out.push(row);
  }
  return out;
}

/**
 * How many consecutive days this subject has held its current colour.
 *
 * Walks back from the latest call one day at a time and stops at the first day
 * that is a different colour OR has no call at all. The gap rule is the honest
 * one: something called red on Monday and again on Friday held red for one day
 * as far as anyone can prove, not five.
 */
function consecutiveDays(daily) {
  if (!daily.length) return 0;
  const colour = daily[0].status;
  let streak = 1;
  let expected = dayNumber(daily[0].day) - 1;
  for (let i = 1; i < daily.length; i++) {
    if (daily[i].status !== colour) break;
    if (dayNumber(daily[i].day) !== expected) break;
    streak += 1;
    expected -= 1;
  }
  return streak;
}

/* ------------------------------------------------------------------------ *
 * rollupRag
 * ------------------------------------------------------------------------ */

/**
 * @typedef {Object} SubjectRag
 * @property {string} subject                 brand, track, workstream - whatever
 *                                            this department calls colours on
 * @property {string} brand                   the same string, under its older name
 * @property {string} dept
 * @property {'red'|'amber'|'green'|'grey'} status   the current call
 * @property {string} reason                  why, in the caller's own words
 * @property {string} setBy
 * @property {string} setAt
 * @property {string} day                     the day the call is about
 * @property {number} daysHeld                consecutive days on this colour
 * @property {number|null} ageHours           how old the call is at `now`
 * @property {boolean} stale                  older than stale_after_hours
 * @property {Array<{day:string,status:string|null}>} trend  oldest -> newest
 *
 * @typedef {Object} DeptRag
 * @property {string} dept
 * @property {{red:number,amber:number,green:number,grey:number}} counts
 * @property {number} total
 * @property {string[]} red                   subjects currently red, longest-held first
 * @property {string[]} stale                 subjects whose call has gone stale
 * @property {SubjectRag[]} subjects          red, amber, grey, green - longest-held first
 * @property {SubjectRag[]} brands            the same array, under its older name
 */

/**
 * Roll a pile of daily calls up to one picture per department.
 *
 * Nothing here is specific to Performance Marketing or to brands. The same call
 * handles Marketing's tracks and SEO's workstreams, because a subject is just a
 * string this module groups by. A department adopting RAG is a config and data
 * change, never a code change.
 *
 * @param {import('./types.js').RagStatus[]} statuses  every call, any date, any subject
 * @param {Object} [config]
 * @param {number} [config.stale_after_hours=48]
 * @param {number} [config.red_days_to_flag=3]
 * @param {number} [config.trend_days=7]
 * @param {string} [config.now]  ISO - staleness and the trend strip are measured
 *        from here, injected so a rollup is reproducible.
 * @returns {{byDept: Record<string, DeptRag>, departments: DeptRag[], subjects: SubjectRag[],
 *            brands: SubjectRag[], warnings: string[],
 *            invalid: Array<{status:any,reason:string}>, now: string, config: Object}}
 */
export function rollupRag(statuses, config = {}) {
  const cfg = { ...DEFAULT_RAG_CONFIG, ...(config || {}) };
  const now = cfg.now || new Date().toISOString();
  const nowTime = toTime(now) ?? Date.now();

  const { rows, warnings, invalid } = prepare(statuses);

  // group by department, then by subject
  const perDept = new Map();
  for (const row of rows) {
    const dept = row.dept || 'unassigned';
    if (!perDept.has(dept)) perDept.set(dept, new Map());
    const subjects = perDept.get(dept);
    if (!subjects.has(row.subject)) subjects.set(row.subject, []);
    subjects.get(row.subject).push(row);
  }

  /** @type {SubjectRag[]} */
  const allSubjects = [];
  /** @type {DeptRag[]} */
  const departments = [];

  for (const [dept, subjects] of perDept) {
    const list = [];
    for (const [subject, history] of subjects) {
      const daily = byDay(history);
      const current = daily[0];
      const ageHours = current.setTime === null ? null : (nowTime - current.setTime) / HOUR;
      const stale = ageHours === null ? true : ageHours > cfg.stale_after_hours;

      list.push({
        subject,
        brand: subject,
        dept,
        status: current.status,
        reason: String(current.reason).trim(),
        setBy: current.setBy || null,
        setAt: current.setAt || null,
        day: current.day,
        daysHeld: consecutiveDays(daily),
        ageHours,
        stale,
        trend: trendFrom(daily, cfg.trend_days, now)
      });
    }

    // Red first, and within red the one that has been red longest - that is the
    // order the room should work through them in.
    list.sort((a, b) => {
      const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (r !== 0) return r;
      if (a.daysHeld !== b.daysHeld) return b.daysHeld - a.daysHeld;
      return a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
    });

    const counts = { red: 0, amber: 0, green: 0, grey: 0 };
    for (const b of list) counts[b.status] += 1;

    const row = {
      dept,
      counts,
      total: list.length,
      red: list.filter((b) => b.status === 'red').map((b) => b.subject),
      stale: list.filter((b) => b.stale).map((b) => b.subject),
      subjects: list,
      brands: list
    };
    departments.push(row);
    allSubjects.push(...list);
  }

  departments.sort((a, b) => (a.dept < b.dept ? -1 : a.dept > b.dept ? 1 : 0));

  return {
    byDept: Object.fromEntries(departments.map((d) => [d.dept, d])),
    departments,
    subjects: allSubjects,
    brands: allSubjects,
    warnings,
    invalid,
    now,
    config: cfg
  };
}

/* ------------------------------------------------------------------------ *
 * ragTrend
 * ------------------------------------------------------------------------ */

/** Shared by rollupRag and ragTrend so the strip and the row cannot disagree. */
function trendFrom(daily, days, now) {
  const span = Math.max(1, Math.floor(days) || 1);
  const nowTime = toTime(now) ?? Date.now();
  const lastDay = Math.floor(nowTime / DAY);
  const byIsoDay = new Map(daily.map((row) => [row.day, row]));

  const out = [];
  for (let i = span - 1; i >= 0; i--) {
    const isoDay = dayFromNumber(lastDay - i);
    const row = byIsoDay.get(isoDay);
    out.push({
      day: isoDay,
      // null is not a colour and must not render as one. A day with no call is
      // a day nobody looked, which is its own piece of information.
      status: row ? row.status : null,
      reason: row ? String(row.reason).trim() : null,
      setBy: row ? row.setBy || null : null
    });
  }
  return out;
}

/**
 * The seven-day strip for one subject, oldest day first.
 *
 * Days with no call come back as `status: null` rather than being filled in from
 * the day before. A dashboard that carried the colour forward would show a
 * steady week of green for something nobody has looked at since Tuesday, which
 * is the exact failure this whole module exists to avoid. Note that a missing
 * day is NOT grey either: grey is a call somebody made ("not started"), and an
 * absence of a call is not a call.
 *
 * @param {import('./types.js').RagStatus[]} statuses
 * @param {string} subject  the brand, track or workstream. Matched against
 *                          `subject` or, for older callers, `brand`.
 * @param {number} [days=7]
 * @param {Object} [opts]
 * @param {string} [opts.now] ISO - the strip ends on this day
 * @returns {Array<{day:string, status:'red'|'amber'|'green'|'grey'|null, reason:string|null, setBy:string|null}>}
 */
export function ragTrend(statuses, subject, days = DEFAULT_RAG_CONFIG.trend_days, opts = {}) {
  const { rows } = prepare(statuses);
  const want = subject === undefined || subject === null ? '' : String(subject).trim();
  const mine = rows.filter((r) => r.subject === want);
  return trendFrom(byDay(mine), days, opts.now || new Date().toISOString());
}

export default rollupRag;
