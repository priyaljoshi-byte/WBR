/**
 * Shared rendering primitives. Deliberately tiny: escaping, number formatting
 * and the {{...}} template resolver that catalog.json subtitles are written in.
 * Nothing here knows about rings, cards or the DOM.
 *
 * Number formatting is the ENGINE's job - we import formatValue rather than
 * keeping a second opinion about what a rupee looks like. The two units the
 * engine does not cover yet (currency_usd, duration_days) are handled here and
 * should move to engine/caption.js the moment it learns them.
 */

import { EMPTY, formatValue } from '../engine/caption.js';
import { ownerLead, ownerTeam, teamLabel } from '../engine/owners.js';

/** HTML-escape anything destined for text or an attribute value. */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trim(x) {
  // 1.24 / 12.4 / 44 - two decimals, trailing zeros removed.
  return x.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Western grouping for the US line of business: $1.2M, $12.4K, $154.
 * Deliberately NOT lakh/crore - that convention is INR-only, and mixing them
 * is how a reader loses track of which currency they are looking at.
 */
export function usd(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return EMPTY;
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e6) return '$' + trim(v / 1e6) + 'M';
  if (a >= 1e3) return '$' + trim(v / 1e3) + 'K';
  return '$' + Math.round(v).toLocaleString('en-US');
}

/** Days, as a cycle time reads: "12d", "4.5d". */
export function days(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return EMPTY;
  return trim(Number(n)) + 'd';
}

/**
 * Format a raw value by its MetricDef unit. Everything the engine knows how to
 * format goes to the engine; only the two units it does not yet cover are
 * handled here.
 */
export function fmtUnit(value, unit) {
  if (value === null || value === undefined) return EMPTY;
  switch (unit) {
    case 'currency_usd': return usd(value);
    case 'duration_days': return days(value);
    default: return formatValue(value, unit);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function parts(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return { y, m: m - 1, d };
}

/**
 * The period vocabulary subtitles are written against.
 *   period.short  "1-7 Sept"
 *   period.range  "1-7 Sept 2026"
 *   period.label  "Week 1 of September"
 *   period.nav    "1-7 SEP 2026"
 */
export function periodOf(periodStart, periodEnd) {
  if (!periodStart || !periodEnd) {
    return { short: '', range: '', label: '', nav: '', start: '', end: '' };
  }
  const a = parts(periodStart);
  const b = parts(periodEnd);
  const sameMonth = a.y === b.y && a.m === b.m;
  const short = sameMonth
    ? `${a.d}&ndash;${b.d} ${MONTHS[b.m]}`
    : `${a.d} ${MONTHS[a.m]} &ndash; ${b.d} ${MONTHS[b.m]}`;
  const weekOfMonth = Math.floor((a.d - 1) / 7) + 1;
  return {
    short,
    range: `${short} ${b.y}`,
    label: `Week ${weekOfMonth} of ${MONTHS_LONG[a.m]}`,
    nav: (sameMonth
      ? `${a.d}&ndash;${b.d} ${MONTHS[b.m].slice(0, 3).toUpperCase()}`
      : `${a.d} ${MONTHS[a.m].slice(0, 3).toUpperCase()} &ndash; ${b.d} ${MONTHS[b.m].slice(0, 3).toUpperCase()}`) + ` ${b.y}`,
    start: periodStart,
    end: periodEnd
  };
}

/** "12 Sept 2026" — used by the print log footer. */
export function longDate(iso) {
  if (!iso) return '';
  const p = parts(iso);
  return `${p.d} ${MONTHS[p.m]} ${p.y}`;
}

/** Index an array of Snapshots by metricId. Accepts a Map or object too. */
export function byMetric(snapshots) {
  if (!snapshots) return new Map();
  if (snapshots instanceof Map) return snapshots;
  if (Array.isArray(snapshots)) {
    const m = new Map();
    for (const s of snapshots) m.set(s.metricId, s);
    return m;
  }
  return new Map(Object.entries(snapshots));
}

/** Index catalog.metrics by id. */
export function metricDefs(catalog) {
  const m = new Map();
  for (const def of (catalog && catalog.metrics) || []) m.set(def.id, def);
  return m;
}

/**
 * Resolve a catalog subtitle template.
 *   {{period.short}}            from the period object
 *   {{channels_live.raw}}       from a Snapshot field, formatted by its unit
 * An unresolvable token renders as an empty string rather than leaking braces.
 */
export function resolveTemplate(tpl, { period = {}, snaps = new Map(), defs = new Map() } = {}) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const [head, tail = 'raw'] = path.split('.');
    if (head === 'period') return period[tail] !== undefined ? period[tail] : '';
    const snap = snaps.get(head);
    if (!snap) return '';
    const v = snap[tail];
    if (v === null || v === undefined) return '';
    if (tail === 'caption') return v;
    if (tail === 'raw' || tail === 'denominator' || tail === 'priorRaw') {
      const def = defs.get(head);
      return fmtUnit(v, def ? def.unit : 'count');
    }
    return String(v);
  });
}

/** Worst health across a set of snapshots, by severity order. */
const SEVERITY = { good: 0, untracked: 0, warn: 1, stale: 2, crit: 3, missing: 3 };
export function worstHealth(snaps) {
  let worst = 'good';
  for (const s of snaps) {
    if (!s) { worst = SEVERITY.missing > SEVERITY[worst] ? 'missing' : worst; continue; }
    if ((SEVERITY[s.health] ?? 0) > (SEVERITY[worst] ?? 0)) worst = s.health;
  }
  return worst;
}

/** Cheap word count for the decision-log 90-word column budget. */
export function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

export const OWNER_NEEDED = '[OWNER NEEDED]';
export const DATE_NEEDED = '[DATE NEEDED]';

/** Department label from org.json, falling back to the id. */
export function deptLabel(deptId, org) {
  const d = ((org && org.departments) || []).find(x => x && x.id === deptId);
  return (d && d.label) || deptId || '';
}

/** Short department label, for anywhere horizontal space is tight. */
export function deptShort(deptId, org) {
  const d = ((org && org.departments) || []).find(x => x && x.id === deptId);
  return (d && (d.short || d.label)) || deptId || '';
}

/**
 * ONE name - the person a reader should go and talk to about this department.
 * Used wherever the page has a verb attached: a blocker's two ends, a flag.
 *
 * Mirrors engine/owners.js, except an unset owner renders as the placeholder
 * rather than quietly becoming the department name - on screen, "[OWNER NEEDED]"
 * is the whole point.
 */
export function ownerName(deptId, org) {
  const team = ownerTeam(deptId, org);
  const lead = ownerLead(deptId, org);
  return lead || (team.length ? team[0] : OWNER_NEEDED);
}

/**
 * The TRIO, as a sentence: "Subham, Arfin and Raghav". Used on the scoreboard,
 * which is about the line of business rather than about one ask - hiding two of
 * the three owners there would cost exactly the visibility the meeting is for.
 *
 * A department whose trio is empty renders "[OWNER NEEDED]", never a blank. A
 * blank reads as "fine"; it is the opposite.
 */
export function ownerTeamLabel(deptId, org) {
  return teamLabel(deptId, org);
}

export { ownerTeam };

/**
 * How the number was maintained, not whether it is right.
 * daily is the expected state and is styled to disappear.
 */
export const FRESHNESS_LABEL = {
  daily: 'daily',
  weekly: 'weekly',
  last_minute: 'assembled for this meeting',
  stale: 'not updated this period',
  unknown: 'freshness unknown'
};

/** Only these two earn any visual weight in a card header. */
export const FRESHNESS_LOUD = new Set(['last_minute', 'stale']);
