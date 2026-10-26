/**
 * owners.js - who answers for what.
 *
 * org.json gives THREE names per line of business. That is the real shape of
 * the company and the dashboard should show it. But a flag addressed to three
 * people is a flag addressed to nobody: each of the three assumes one of the
 * other two has it, and "accountability against targets" quietly stops meaning
 * anything. org.json's _accountability block states the rule this file
 * implements:
 *
 *   The trio owns the line of business. ONE of them owns each metric.
 *   The scoreboard shows the trio; a flag names the single accountable person.
 *
 * So there are two different questions, and they get two different functions:
 *
 *   ownerTeam(dept, org)      the trio      - visibility, notification, scoreboard
 *   metricOwner(def, org)     one person    - flags, asks, anything with a verb
 *
 * The legacy `{name, email}` shape is still read, as a single-member team, so a
 * repo or a test that has not migrated keeps working and the migration is not a
 * flag day.
 */

export const OWNER_NEEDED = '[OWNER NEEDED]';

/** The raw owners entry for a department, whatever shape it is in. */
function entryFor(dept, org) {
  if (!dept) return null;
  const owners = (org && org.owners) || {};
  return Object.prototype.hasOwnProperty.call(owners, dept) ? owners[dept] : null;
}

/** True when org.json has an owners entry for this department at all. */
export function hasOwnerEntry(dept, org) {
  return entryFor(dept, org) !== null && entryFor(dept, org) !== undefined;
}

/**
 * The trio, as an array of names. Empty when nobody has been named - which is
 * perf_marketing's actual state and must render as a visible gap, never as a
 * blank or an invented name.
 *
 * @param {string} dept
 * @param {Object} org
 * @param {string} [segment] when owners[dept].by_segment names different people
 *                           per geography, that wins over the department trio.
 * @returns {string[]}
 */
export function ownerTeam(dept, org, segment) {
  const entry = entryFor(dept, org);
  if (!entry) return [];

  if (segment && entry.by_segment && entry.by_segment[segment]) {
    const bySeg = ownerTeamOf(entry.by_segment[segment]);
    if (bySeg.length) return bySeg;
  }
  return ownerTeamOf(entry);
}

function ownerTeamOf(entry) {
  if (!entry) return [];
  if (Array.isArray(entry)) return entry.filter(Boolean).map(String);
  if (Array.isArray(entry.team)) return entry.team.filter(Boolean).map(String);
  if (entry.name) return [String(entry.name)];
  return [];
}

/**
 * The one accountable name for a department, when no metric has claimed one:
 * the declared lead, else the first of the trio. Null when nobody is named.
 */
export function ownerLead(dept, org, segment) {
  const entry = entryFor(dept, org);
  if (entry && !Array.isArray(entry) && entry.lead) return String(entry.lead);
  const team = ownerTeam(dept, org, segment);
  return team.length ? team[0] : null;
}

/** "Subham, Arfin and Raghav" / "Subham" / "[OWNER NEEDED]". */
export function teamLabel(dept, org, segment) {
  const team = ownerTeam(dept, org, segment);
  return joinNames(team);
}

export function joinNames(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return OWNER_NEEDED;
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Department label, then the raw id - used only as a last resort for a name. */
function deptLabel(dept, org) {
  const match = ((org && org.departments) || []).find((d) => d && d.id === dept);
  return (match && match.label) || dept || null;
}

/**
 * Is `require_metric_owner` on? It lives in org.json `_accountability`;
 * catalog.json is accepted as a fallback so the setting can move without a
 * code change. Default off, so a repo that never opted in is not flooded.
 */
export function requireMetricOwner(org, catalog) {
  const a = (org && org._accountability) || {};
  const b = (catalog && catalog._accountability) || {};
  return !!(a.require_metric_owner || b.require_metric_owner);
}

/**
 * @typedef {Object} MetricOwner
 * @property {string} name      who the flag is addressed to
 * @property {string[]} team    the trio behind them, for the no_owner ask
 * @property {boolean} assigned true when the metric itself named this person
 * @property {boolean} valid    false when the metric named somebody who is NOT
 *                              in the trio - a typo'd name silently addressing
 *                              nobody is the exact failure this prevents
 * @property {string|null} declared  what the metric actually said, valid or not
 */

/**
 * Who answers for ONE metric.
 *
 * A metric may carry `owner` in catalog.json, naming one of its department's
 * trio. That person gets the flag. With no `owner`, it falls back to the trio's
 * first name, so a flag still lands on somebody while `pulse check` reports the
 * gap - visible rather than silent.
 *
 * A declared owner who is not in the trio is NOT trusted and NOT thrown on. It
 * falls back exactly as if unset, and `valid:false` tells the caller to raise a
 * flag. Throwing would take the dashboard down over a spelling mistake; silently
 * accepting it would address every flag about that metric to a person who does
 * not exist on that team, which is worse than addressing it to three people.
 *
 * @param {import('./types.js').MetricDef} def
 * @param {Object} org
 * @returns {MetricOwner}
 */
export function metricOwner(def, org) {
  const dept = def && def.dept;
  const segment = (def && def.segment) || undefined;
  const team = ownerTeam(dept, org, segment);
  const declared = def && def.owner ? String(def.owner) : null;

  if (declared) {
    const hit = team.find((n) => n.toLowerCase() === declared.toLowerCase());
    if (hit) {
      return { name: hit, team, assigned: true, valid: true, declared };
    }
    return { name: fallbackName(dept, org, team), team, assigned: false, valid: false, declared };
  }

  return { name: fallbackName(dept, org, team), team, assigned: false, valid: true, declared: null };
}

function fallbackName(dept, org, team) {
  const lead = ownerLead(dept, org);
  if (lead) return lead;
  if (team && team.length) return team[0];
  // An owners entry that exists but names nobody is a declared gap: say so.
  if (hasOwnerEntry(dept, org)) return OWNER_NEEDED;
  if (!dept) return 'Unassigned';
  return deptLabel(dept, org) || dept;
}

/**
 * Who gets named on a department-level flag (RAG calls, blockers, scoreboards).
 * Same fallback ladder as metricOwner, without a metric to ask.
 */
export function ownerFor(dept, org, segment) {
  if (!dept) return 'Unassigned';
  return fallbackName(dept, org, ownerTeam(dept, org, segment));
}

/**
 * Every metric that has not named one accountable person, grouped by
 * department. This is what `pulse check` prints and what the no_owner flags are
 * derived from - one source of truth for "whose turn is it".
 *
 * Also reports a department whose trio is EMPTY, separately, because the two
 * gaps need different answers: an unassigned metric needs the trio to pick one
 * of themselves, an empty trio needs the founder to name three people.
 *
 * @returns {{
 *   unassigned: Array<{dept:string, metricId:string, label:string, team:string[]}>,
 *   invalid: Array<{dept:string, metricId:string, label:string, declared:string, team:string[]}>,
 *   unownedDepartments: Array<{dept:string, label:string, metricCount:number}>
 * }}
 */
export function ownerAudit(catalog, org) {
  const metrics = (catalog && catalog.metrics) || [];
  const unassigned = [];
  const invalid = [];

  for (const def of metrics) {
    if (!def || !def.id) continue;
    const resolved = metricOwner(def, org);
    if (!resolved.valid) {
      invalid.push({
        dept: def.dept,
        metricId: def.id,
        label: def.label || def.id,
        declared: resolved.declared,
        team: resolved.team
      });
      continue;
    }
    if (!resolved.assigned) {
      unassigned.push({
        dept: def.dept,
        metricId: def.id,
        label: def.label || def.id,
        team: resolved.team
      });
    }
  }

  const unownedDepartments = [];
  for (const d of ((org && org.departments) || [])) {
    if (!d || !d.id) continue;
    if (ownerTeam(d.id, org).length) continue;
    unownedDepartments.push({
      dept: d.id,
      label: d.label || d.id,
      metricCount: metrics.filter((m) => m && m.dept === d.id).length
    });
  }

  return { unassigned, invalid, unownedDepartments };
}

export default ownerTeam;
