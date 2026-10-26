/**
 * continuity.js - the spine.
 *
 * A weekly summary is cheap. Continuity is the product. The only reason this file
 * exists is so that week 12 can say "this is the same decision we took in week 3,
 * here is how its status moved and why", instead of printing a fresh list of
 * bullet points that happens to repeat itself.
 *
 * THE BIAS, STATED ONCE:
 * A false match silently rewrites history. The decision log says a choice "changed"
 * when in fact two different choices got stapled together, and nobody can tell,
 * because the evidence of the mistake is the thing that got overwritten. A
 * duplicate, by contrast, is visible, ugly, and mergeable by a human in ten
 * seconds. So this matcher is deliberately shy. Everything in the grey band goes to
 * a person. We would rather be asked twice than be wrong once.
 */

import { DECISION_STATUSES, TERMINAL_STATUSES, REASON_REQUIRED } from '../engine/types.js';

/**
 * Headline similarity at or above this auto-matches an extracted decision to an
 * existing one. Tunable without code archaeology: it is the only number that
 * decides whether history is rewritten.
 *
 * 0.55 is the starting point. Calibration, measured against the headline
 * "Fix Sloosh activation before increasing US ad spend":
 *   1.000  identical restatement                                            -> match
 *   0.810  "Fix Sloosh activation before increasing US ad budget"           -> match
 *   0.501  "Fix Sloosh activation before increasing paid acquisition budget" -> human merge
 *   0.251  "Fix Sloosh activation before increasing India lead volume"      -> new decision
 *   0.133  "Shift half the US ad budget to India until CPL falls"           -> new decision
 *   0.019  "Hire two India sales reps before raising the pipeline target"   -> new decision
 *
 * The 0.501 row is the case that sets the threshold. Same subject, same opening
 * clause, different second half - it could be a rewrite of the same decision or a
 * second decision about the same thing. Above 0.55 the engine decides; at 0.501 a
 * person does.
 *
 * Worth knowing: a decision that genuinely CHANGES usually rewrites its headline,
 * and the old and new headlines then score far below this threshold - the 2025-09-01
 * "Hold US ad spend flat until lead quality recovers" scores 0.17 against the
 * 2025-09-08 "Shift half the US ad budget to India until CPL falls". That is not a
 * bug in the matcher, it is the reason the extractor is handed the open decision
 * list and asked to supply `id` when the room references a prior decision. Text
 * similarity finds restatements. Only an id finds a reversal.
 * The 0.50 case is probably the same decision. "Probably" is exactly why a person
 * gets asked instead of the engine guessing.
 */
export const MATCH_THRESHOLD = 0.55;

/**
 * Below this, two headlines are unrelated enough to be separate decisions.
 * Between REVIEW_FLOOR and MATCH_THRESHOLD is the grey band: not auto-matched,
 * not silently duplicated, handed to a human tagged needs_human_merge.
 */
export const REVIEW_FLOOR = 0.40;

/** Weighting of the two similarity signals. Token set answers "same subject",
 *  bigram overlap answers "same sentence shape". Both, or neither. */
export const JACCARD_WEIGHT = 0.6;
export const BIGRAM_WEIGHT = 0.4;

/**
 * Words that carry no decision meaning. Deliberately short. Words like "before",
 * "after", "new", "more" and "until" are NOT stopwords - in a decision headline
 * they are the whole sequencing argument, which is usually the decision itself.
 *
 * "us" is deliberately absent: in this org it is a line of business, and dropping
 * it would make a US decision and an India decision look like the same sentence.
 */
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'by',
  'we', 'our', 'is', 'are', 'be', 'been', 'will', 'that', 'this', 'it',
  'as', 'with', 'from', 'into', 'than', 'then', 'so', 'do', 'does', 'did'
]);

/** Lowercase, strip punctuation, drop stopwords, fold simple plurals. */
export function normalizeTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

/** The smallest stemmer that earns its keep: plural folding only. */
function stem(token) {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Jaccard over the token SET. Order-blind: answers "same subject matter". */
export function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Adjacent token pairs. Order-sensitive: answers "same sentence shape". */
export function bigrams(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) out.push(`${tokens[i]}|${tokens[i + 1]}`);
  return out;
}

/**
 * Market tokens that are mutually exclusive in this org.
 *
 * India Sales and US Sales are separate lines of business, and Performance
 * Marketing runs both as separate segments. So "Hold US ad spend flat until lead
 * quality recovers" and "Hold India ad spend flat until lead quality recovers"
 * differ by exactly one token out of eight and score 0.78 on pure text similarity,
 * which would auto-match them and silently merge two different budgets.
 *
 * Token overlap cannot see that, because the difference is one word carrying the
 * entire meaning. So it is encoded: when both headlines name a market and the
 * markets are disjoint, the score is halved. One-sided cases are untouched, since
 * a headline that names no market tells us nothing either way.
 */
export const MARKET_TOKENS = new Map([
  ['us', 'us'], ['usa', 'us'], ['america', 'us'], ['american', 'us'],
  ['india', 'india'], ['indian', 'india'],
  ['gcc', 'gcc'], ['uae', 'gcc']
]);

export const MARKET_MISMATCH_PENALTY = 0.5;

function marketsIn(tokens) {
  const out = new Set();
  for (const t of tokens) {
    const m = MARKET_TOKENS.get(t);
    if (m) out.add(m);
  }
  return out;
}

/** Dice coefficient over token bigrams. */
export function bigramOverlap(aTokens, bTokens) {
  const a = bigrams(aTokens);
  const b = bigrams(bTokens);
  if (a.length === 0 || b.length === 0) return 0;
  const bCounts = new Map();
  for (const g of b) bCounts.set(g, (bCounts.get(g) || 0) + 1);
  let shared = 0;
  for (const g of a) {
    const n = bCounts.get(g) || 0;
    if (n > 0) {
      shared += 1;
      bCounts.set(g, n - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Headline similarity, 0..1.
 * Short headlines have few bigrams, so when either side yields none we fall back
 * to the token set alone rather than letting a structural zero drag the score down
 * and manufacture a false "new decision".
 */
export function similarity(headlineA, headlineB) {
  const a = normalizeTokens(headlineA);
  const b = normalizeTokens(headlineB);
  if (a.length === 0 || b.length === 0) return 0;

  const j = jaccard(a, b);
  const base = (a.length < 2 || b.length < 2)
    ? j
    : JACCARD_WEIGHT * j + BIGRAM_WEIGHT * bigramOverlap(a, b);

  const ma = marketsIn(a);
  const mb = marketsIn(b);
  if (ma.size > 0 && mb.size > 0) {
    let shared = false;
    for (const m of ma) if (mb.has(m)) shared = true;
    if (!shared) return base * MARKET_MISMATCH_PENALTY;
  }
  return base;
}

/** Stable, readable, collision-checked decision id. */
export function slugify(headline) {
  const slug = String(headline || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return `d-${slug || 'untitled'}`;
}

/**
 * Is this status move legal?
 * @returns {string|null} error message, or null when the move is allowed
 */
export function transitionError(fromStatus, toStatus, reason) {
  if (!DECISION_STATUSES.includes(toStatus)) {
    return `"${toStatus}" is not a DecisionStatus`;
  }
  if (fromStatus !== null && TERMINAL_STATUSES.includes(fromStatus)) {
    // COMPLETED, DROPPED and REVERSED close a decision out. Reopening is a new
    // decision with its own history, not an edit to a closed one - otherwise the
    // record of having finished something can be erased after the fact.
    return `cannot transition out of terminal status ${fromStatus} ` +
      `(TERMINAL_STATUSES = ${TERMINAL_STATUSES.join(', ')}); ` +
      `raise a new decision instead of reopening this one`;
  }
  if (fromStatus !== null && toStatus === 'NEW') {
    return `NEW is reserved for a decision seen for the first time; ` +
      `${fromStatus} -> NEW would erase this decision's history`;
  }
  if (REASON_REQUIRED.includes(toStatus) && !(typeof reason === 'string' && reason.trim())) {
    return `status ${toStatus} requires a non-empty reason`;
  }
  return null;
}

function cloneDecision(d) {
  return { ...d, metricIds: Array.isArray(d.metricIds) ? [...d.metricIds] : [] };
}

function unionMetricIds(prior, next) {
  const out = [];
  const seen = new Set();
  for (const id of [...(prior || []), ...(next || [])]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** "2025-09-22" < "2025-10-01" works lexically for ISO dates. */
function isPastDue(dueDate, onDate) {
  if (!dueDate || !onDate) return false;
  return String(dueDate) < String(onDate);
}

/**
 * Find the best same-domain candidate for an extracted decision.
 * @returns {{candidate: Object|null, score: number}}
 */
export function bestMatch(extracted, candidates) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.domain !== extracted.domain) continue;
    const score = similarity(extracted.headline, c.headline);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { candidate: best, score: bestScore };
}

/**
 * Reconcile one meeting's extracted decisions against the decisions already on the
 * books.
 *
 * @param {Object} extracted            validated extractor output (needs .decisions)
 * @param {Array<Object>} openDecisions decisions carried in from previous meetings
 * @param {Object} meeting              Meeting: {id, date, ...}
 * @returns {{decisions: Array, events: Array, unmatched: Array, errors: Array}}
 */
export function reconcile(extracted, openDecisions = [], meeting = {}) {
  const at = meeting.processedAt || meeting.date || new Date().toISOString();
  const meetingId = meeting.id || extracted.meetingId || 'unknown-meeting';
  const meetingDate = meeting.date || extracted.meetingDate || null;

  const events = [];
  const unmatched = [];
  const errors = [];

  // Working copy. Nothing in openDecisions is mutated.
  const byId = new Map();
  const carried = (openDecisions || []).map((d) => {
    const copy = cloneDecision(d);
    byId.set(copy.id, copy);
    return copy;
  });

  const touched = new Set();
  const created = [];
  const takenIds = new Set(byId.keys());

  for (const ex of extracted.decisions || []) {
    let match = null;
    let matchScore = null;
    let matchedBy = null;

    // 1. Exact id, when the extraction names a prior decision.
    if (ex.id && byId.has(ex.id)) {
      match = byId.get(ex.id);
      matchScore = 1;
      matchedBy = 'id';
    } else if (ex.id && !byId.has(ex.id)) {
      // An id we have never seen. Do not guess which decision it meant.
      unmatched.push({
        tag: 'unknown_id',
        reason: `extraction referenced decision id "${ex.id}" which is not in the open set`,
        extracted: ex,
        candidateId: null,
        score: null
      });
      continue;
    } else {
      // 2. Same domain AND high headline similarity.
      const { candidate, score } = bestMatch(ex, carried);
      if (candidate && score >= MATCH_THRESHOLD) {
        match = candidate;
        matchScore = score;
        matchedBy = 'headline';
      } else if (candidate && score >= REVIEW_FLOOR) {
        // The grey band. Close enough to be suspicious, not close enough to be
        // sure. A person decides. See THE BIAS at the top of this file.
        unmatched.push({
          tag: 'needs_human_merge',
          reason:
            `headline similarity ${score.toFixed(3)} sits between REVIEW_FLOOR ` +
            `${REVIEW_FLOOR} and MATCH_THRESHOLD ${MATCH_THRESHOLD}; ` +
            `not auto-matched because a false match rewrites history`,
          extracted: ex,
          candidateId: candidate.id,
          candidateHeadline: candidate.headline,
          score
        });
        continue;
      }
    }

    if (match) {
      const from = match.status;
      const to = ex.status;
      const err = transitionError(from, to, ex.reason);
      if (err) {
        // Rejected, not written. The prior decision stays exactly as it was.
        errors.push({
          decisionId: match.id,
          headline: match.headline,
          fromStatus: from,
          toStatus: to,
          error: err,
          quote: ex.quote || null
        });
        continue;
      }

      match.status = to;
      match.domain = ex.domain || match.domain;
      match.headline = ex.headline || match.headline;
      if (ex.carriedIn) match.carriedIn = ex.carriedIn;
      if (ex.evidence) match.evidence = ex.evidence;
      if (ex.decided) match.decided = ex.decided;
      if (ex.beforeNextReview) match.beforeNextReview = ex.beforeNextReview;
      if (ex.strip) match.strip = ex.strip;
      if (ex.reopenCondition) match.reopenCondition = ex.reopenCondition;
      if (ex.owner !== undefined) match.owner = ex.owner ?? match.owner ?? null;
      if (ex.dueDate !== undefined) match.dueDate = ex.dueDate ?? match.dueDate ?? null;
      match.metricIds = unionMetricIds(match.metricIds, ex.metricIds);
      match.lastTouchedMeeting = meetingId;
      if (ex.previousStateUnverified === true) match.previousStateUnverified = true;

      events.push({
        decisionId: match.id,
        meetingId,
        fromStatus: from,
        toStatus: to,
        reason: ex.reason || statusReason(to),
        ...(ex.quote ? { quote: ex.quote } : {}),
        at,
        matchedBy,
        matchScore
      });
      touched.add(match.id);
      continue;
    }

    // 3. No match. A decision we have not seen before.
    const status = ex.status === 'OPEN' ? 'OPEN' : 'NEW';
    const err = transitionError(null, status, ex.reason);
    if (err) {
      errors.push({
        decisionId: null,
        headline: ex.headline,
        fromStatus: null,
        toStatus: status,
        error: err,
        quote: ex.quote || null
      });
      continue;
    }

    let id = ex.id || slugify(ex.headline);
    let n = 2;
    while (takenIds.has(id)) {
      id = `${ex.id || slugify(ex.headline)}-${n}`;
      n += 1;
    }
    takenIds.add(id);

    // The extraction claimed continuity we could not find a record for. That is
    // exactly what [PREVIOUS STATE UNVERIFIED] is for: the room remembers, the log
    // does not, and the difference is printed rather than smoothed over.
    const claimedContinuity = ex.status && !['NEW', 'OPEN'].includes(ex.status);

    const decision = {
      id,
      number: Number.isFinite(ex.number) ? ex.number : carried.length + created.length + 1,
      domain: ex.domain,
      headline: ex.headline,
      status,
      carriedIn: ex.carriedIn || '[PREVIOUS STATE UNVERIFIED] No prior record of this decision.',
      evidence: ex.evidence || '',
      decided: ex.decided || '',
      beforeNextReview: ex.beforeNextReview || '',
      strip: ex.strip || '',
      owner: ex.owner ?? null,
      dueDate: ex.dueDate ?? null,
      reopenCondition: ex.reopenCondition || '',
      metricIds: Array.isArray(ex.metricIds) ? [...ex.metricIds] : [],
      firstSeenMeeting: meetingId,
      lastTouchedMeeting: meetingId,
      previousStateUnverified: ex.previousStateUnverified === true || claimedContinuity === true
    };

    events.push({
      decisionId: id,
      meetingId,
      fromStatus: null,
      toStatus: status,
      reason: ex.reason || (claimedContinuity
        ? `recorded as ${status}: extraction claimed status ${ex.status} but no prior record exists`
        : 'first seen'),
      ...(ex.quote ? { quote: ex.quote } : {}),
      at,
      matchedBy: 'none',
      matchScore: null
    });

    byId.set(id, decision);
    created.push(decision);
    touched.add(id);
  }

  // --- decisions the transcript did NOT mention ----------------------------
  // They do not vanish. Silence is not closure. But silence past a due date is a
  // fact worth printing, so an overdue unmentioned decision goes BLOCKED with a
  // reason that says exactly what happened: nobody brought evidence.
  for (const d of carried) {
    if (touched.has(d.id)) continue;
    if (TERMINAL_STATUSES.includes(d.status)) continue;
    if (d.status === 'BLOCKED') continue;
    if (!isPastDue(d.dueDate, meetingDate)) continue;

    const from = d.status;
    const reason = `no evidence presented at ${meetingDate}`;
    const err = transitionError(from, 'BLOCKED', reason);
    if (err) {
      errors.push({
        decisionId: d.id,
        headline: d.headline,
        fromStatus: from,
        toStatus: 'BLOCKED',
        error: err,
        quote: null
      });
      continue;
    }
    d.status = 'BLOCKED';
    d.lastTouchedMeeting = meetingId;
    events.push({
      decisionId: d.id,
      meetingId,
      fromStatus: from,
      toStatus: 'BLOCKED',
      reason,
      at,
      matchedBy: 'unmentioned',
      matchScore: null
    });
  }

  const decisions = [...carried, ...created];
  renumber(decisions);

  return { decisions, events, unmatched, errors };
}

/**
 * Display order, most consequential first. Terminal decisions sink to the bottom:
 * they are history, not agenda.
 */
export function renumber(decisions) {
  const ranked = [...decisions].sort((a, b) => {
    const at = TERMINAL_STATUSES.includes(a.status) ? 1 : 0;
    const bt = TERMINAL_STATUSES.includes(b.status) ? 1 : 0;
    if (at !== bt) return at - bt;
    const an = Number.isFinite(a.number) ? a.number : Number.MAX_SAFE_INTEGER;
    const bn = Number.isFinite(b.number) ? b.number : Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return String(a.id).localeCompare(String(b.id));
  });
  ranked.forEach((d, i) => { d.number = i + 1; });
  return decisions;
}

function statusReason(status) {
  switch (status) {
    case 'CONFIRMED': return 'restated unchanged';
    case 'COMPLETED': return 'proof presented';
    case 'PARTIAL': return 'partly done';
    case 'BLOCKED': return 'blocked';
    case 'OPEN': return 'discussed, not settled';
    default: return '';
  }
}
