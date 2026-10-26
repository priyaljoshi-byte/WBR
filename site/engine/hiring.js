/**
 * hiring.js - the role-wise hiring waterfall.
 *
 * ===========================================================================
 * WHAT IT ANSWERS
 * ===========================================================================
 * For every open role: how many candidates entered the pipeline, and of those
 * how many reached TA screen, Round 1, Assignment, Round 2, the founder round,
 * an accepted offer, and joining. A true waterfall - someone at Round 2 is also
 * counted at TA and Round 1 - so the numbers only go down, and the gap between
 * two stages is where that role is losing people.
 *
 * ===========================================================================
 * WHY "FURTHEST STAGE" NEEDS TWO SIGNALS
 * ===========================================================================
 * The recruiters' "Current Stage" column mixes two different things:
 *   - a position ("R1 Interview", "Assignment in review"), and
 *   - an outcome with no position at all ("Rejected", "Hold", "Withdrawn").
 * A candidate rejected after Round 2 and one rejected at the first call both
 * read "Rejected". Counting both as "In pipeline only" would make every late
 * rejection vanish from the waterfall, so the round columns are read as
 * evidence: a filled "Round 2" cell proves the candidate reached Round 2. The
 * furthest stage is the later of the two signals.
 *
 * Pure. No fs, no fetch. Imported by app/hiring.js and by node:test.
 */

/** Lowercase, drop punctuation and apostrophes, collapse spaces. */
export function normText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** normText plus a dropped trailing plural 's' on each word, for role names. */
export function normRole(s) {
  return normText(s).split(' ').map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

/** A cell that proves something happened. "NA", "Pending", "No" and "-" do not. */
function proves(cell) {
  const t = normText(cell);
  return !!t && !['na', 'n a', 'pending', 'no', 'tbd', 'tbs', 'none'].includes(t);
}

/** "2", "2 to be added", "" -> 2, 2, 1. A role on the open list needs at least one person. */
export function parseHeadcount(v) {
  const m = String(v == null ? '' : v).match(/\d+/);
  const n = m ? Number(m[0]) : 1;
  return n > 0 ? n : 1;
}

/**
 * The roles to show, from the open-roles tab. The tab repeats its header row
 * above each priority block and has a bare "Explo Roles" label row; both are
 * skipped. Closed roles are kept but marked, so the page can put them last.
 *
 * @param {Array<Object>} rows  objects keyed by the tab's header
 */
export function parseRoles(rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const name = String(r.Role || '').trim();
    if (!name || normText(name) === 'role') continue;
    const status = String(r.Status || '').trim();
    const hc = String(r.Headcount ?? r['Headcount '] ?? '').trim();
    const poc = String(r.POC || '').trim();
    if (!hc && !poc && !r.Priority && !r['Priority ']) continue; // a section label like "Explo Roles"
    const key = normRole(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const s = normText(status);
    out.push({
      key,
      name,
      priority: String(r.Priority ?? r['Priority '] ?? '').trim(),
      poc,
      hiringManager: String(r['Hiring Manager'] || '').trim(),
      headcount: parseHeadcount(hc),
      status: s === 'closed' ? 'closed' : (s === 'on hold' ? 'on_hold' : 'open'),
      statusText: status
    });
  }
  return out;
}

/** alias spelling -> role key, built from config.role_aliases and the roles themselves. */
export function aliasIndex(roles, aliases = {}) {
  const idx = new Map();
  for (const role of roles) idx.set(role.key, role.key);
  for (const [canonical, others] of Object.entries(aliases)) {
    const key = normRole(canonical);
    if (!roles.some((r) => r.key === key)) continue;
    for (const o of others || []) idx.set(normRole(o), key);
  }
  return idx;
}

/**
 * One candidate's furthest stage and whether they are still moving.
 * @returns {{reached:number, status:'active'|'dropped'|'hold'|'parked', known:boolean}}
 */
export function classify(row, config) {
  const order = config.stages.map((s) => s.id);
  const words = config.stage_words || {};
  const stageText = row['Current Stage'] ?? '';
  const hit = words[normText(stageText)];
  let reached = 0;
  if (hit && hit.stage) reached = Math.max(0, order.indexOf(hit.stage));
  for (const [col, stage] of Object.entries(config.evidence_columns || {})) {
    if (col in row && proves(row[col])) reached = Math.max(reached, order.indexOf(stage));
  }
  return { reached, status: hit ? hit.status : 'active', known: !!hit || !normText(stageText) };
}

/**
 * The whole page's numbers.
 *
 * @param {Object} input
 * @param {Array<Object>} input.roleRows      rows of the open-roles tab
 * @param {Array<{recruiter:string, rows:Array<Object>}>} input.candidateTabs
 * @param {Array<Object>} [input.offerRows]   rows of Offers & Joiners
 * @param {Object} config                     config/hiring.json
 */
export function buildFunnels({ roleRows, candidateTabs, offerRows = [] }, config) {
  const stages = config.stages;
  const order = stages.map((s) => s.id);
  const roles = parseRoles(roleRows);
  const idx = aliasIndex(roles, config.role_aliases);

  // Offers & Joiners is the record of an offer and a join, so it upgrades a
  // candidate the recruiter tab has not caught up on. Matched by name.
  const offers = new Map();
  for (const o of offerRows) {
    const n = normText(o['Candidate Name']);
    if (!n) continue;
    const joined = normText(o['Joining Status']) === 'joined';
    const accepted = joined || /accepted/.test(normText(o['Offer Status'])) || normText(o['Joining Status']) === 'yet to join';
    if (joined || accepted) offers.set(n, joined ? 'joined' : 'offer');
    // "Offer Intent Shared", "Internal Approval Requested": an offer is in
    // motion but nobody has said yes yet.
    else if (normText(o['Offer Status'])) offers.set(n, 'offer_out');
  }

  const byRole = new Map(roles.map((r) => [r.key, []]));
  const unmatched = new Map();
  const unknownWords = new Map();

  for (const tab of candidateTabs) {
    for (const row of tab.rows) {
      const name = String(row['Candidate Name'] || '').trim();
      if (!name) continue;
      const c = classify(row, config);
      const fromOffers = offers.get(normText(name));
      const offerOut = fromOffers === 'offer_out';
      if (fromOffers && !offerOut) c.reached = Math.max(c.reached, order.indexOf(fromOffers));
      const stageText = String(row['Current Stage'] || '').trim();
      if (!c.known) unknownWords.set(stageText, (unknownWords.get(stageText) || 0) + 1);
      const roleText = String(row.Role || '').trim();
      const cand = {
        name,
        roleText,
        recruiter: tab.recruiter,
        stageText,
        reached: c.reached,
        reachedLabel: stages[c.reached].label,
        status: c.status,
        offerOut
      };
      const key = idx.get(normRole(roleText));
      if (key && byRole.has(key)) byRole.get(key).push(cand);
      else {
        const label = roleText || '(no role written)';
        if (!unmatched.has(label)) unmatched.set(label, []);
        unmatched.get(label).push(cand);
      }
    }
  }

  const healthyFrom = Math.max(0, order.indexOf(config.healthy_from_stage || 'r1'));
  const perOpening = Number(config.healthy_per_opening) || 3;

  const funnels = roles.map((role) => {
    const cands = byRole.get(role.key);
    const steps = stages.map((s, i) => {
      const reached = cands.filter((c) => c.reached >= i);
      return {
        id: s.id,
        label: s.label,
        reached: reached.length,
        // Still moving and sitting exactly here right now.
        here: cands.filter((c) => c.reached === i && c.status === 'active').length,
        // Stopped at this stage: rejected, withdrew, on hold or parked.
        stopped: cands.filter((c) => c.reached === i && c.status !== 'active').length
      };
    });
    const hired = cands.filter((c) => c.reached >= order.indexOf('offer')).length;
    const healthy = cands.filter((c) => c.status === 'active' && c.reached >= healthyFrom && c.reached < order.indexOf('offer')).length;
    const openings = Math.max(0, role.headcount - hired);
    const need = openings * perOpening;
    return {
      ...role,
      candidates: cands.sort((a, b) => b.reached - a.reached || a.name.localeCompare(b.name)),
      steps,
      total: cands.length,
      active: cands.filter((c) => c.status === 'active').length,
      hired,
      openings,
      healthy,
      need,
      // A fully hired role has nothing left to fill, so its ring is full.
      health: need === 0 ? 100 : Math.min(100, Math.round((healthy / need) * 100))
    };
  });

  return {
    funnels,
    unmatched: [...unmatched.entries()].map(([role, candidates]) => ({ role, candidates })),
    unknownWords: [...unknownWords.entries()].map(([word, count]) => ({ word, count })),
    healthyFromLabel: stages[healthyFrom].label,
    perOpening
  };
}

/**
 * The funnel as two plain tables, for the weekly run. The catalogue's hiring
 * metrics count rows of a "Roles" tab and a "Candidates" tab with a status
 * column; the real tracker has neither, so this is that shape, built from it.
 *
 * Candidate status words are the catalogue's own:
 *   screening    still moving, not yet at Round 1
 *   interviewing still moving, Round 1 to founder round
 *   offer_out    an offer is out (Offers & Joiners) and not yet accepted
 *   accepted     offer accepted, not joined
 *   joined
 *   dropped | hold | parked   stopped, with the reason
 *
 * Names, roles and stages only - same rule as the page.
 */
export function funnelTables(result, config) {
  const order = config.stages.map((s) => s.id);
  const r1 = order.indexOf('r1');
  const offer = order.indexOf('offer');
  const joined = order.indexOf('joined');
  const candidates = [];
  const all = [
    ...result.funnels.map((f) => ({ role: f.name, cands: f.candidates })),
    ...result.unmatched.map((u) => ({ role: u.role, cands: u.candidates }))
  ];
  for (const { role, cands } of all) {
    for (const c of cands) {
      let status;
      if (c.reached >= joined) status = 'joined';
      else if (c.reached >= offer) status = 'accepted';
      else if (c.offerOut) status = 'offer_out';
      else if (c.status !== 'active') status = c.status;
      else status = c.reached >= r1 ? 'interviewing' : 'screening';
      candidates.push({
        candidate: c.name, role, recruiter: c.recruiter,
        // No days_to_close: the tracker records no date a candidate entered
        // the pipeline, so there is nothing to subtract. Leaving the column out
        // makes "Time to close" read missing once, not 113 blank-cell warnings.
        stage: config.stages[c.reached].id, sheet_stage: c.stageText, status
      });
    }
  }
  const roles = result.funnels.map((f) => ({
    role: f.name, status: f.status, priority: f.priority, headcount: f.headcount,
    openings: f.openings, hired: f.hired, candidates: f.total, active: f.active,
    healthy: f.healthy, need: f.need, health: f.health / 100
  }));
  return { roles, candidates };
}
