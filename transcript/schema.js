/**
 * schema.js - the gate between an LLM's output and the decision log.
 *
 * Everything the extractor produces is untrusted until it passes here. Not because
 * the model is malicious, but because a single bad field writes itself into history
 * and history is the only thing this system sells. A decision log that quietly
 * accepted a hallucinated metric id is worth less than no decision log at all.
 *
 * validateExtraction returns EVERY error, never just the first. One round trip per
 * meeting, not one round trip per mistake.
 */

import { readFileSync } from 'node:fs';
import {
  DECISION_STATUSES,
  REASON_REQUIRED,
  DOMAINS,
  BLOCKER_STATUSES
} from '../engine/types.js';

/** Statement kinds from extract.spec.md section 1. */
export const STATEMENT_KINDS = [
  'Evidence', 'Decision', 'Commitment', 'Proposal', 'Open question', 'Context'
];

/** Headline must be UNDER 14 words, so 13 is the maximum. */
export const MAX_HEADLINE_WORDS = 13;

/** The evidence markers the spec allows in place of a guess. */
export const MARKERS = [
  '[VERIFY]', '[OWNER NEEDED]', '[DATE NEEDED]', '[PREVIOUS STATE UNVERIFIED]'
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Read a JSON config relative to this file. Zero dependencies, no import assertions. */
function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
}

let _catalog = null;
/** The catalog as shipped. Lazily read so importing this module costs nothing. */
export function defaultCatalog() {
  if (_catalog === null) _catalog = readJson('../config/catalog.json');
  return _catalog;
}

let _org = null;
export function defaultOrg() {
  if (_org === null) _org = readJson('../config/org.json');
  return _org;
}

export function metricIdSet(catalog = defaultCatalog()) {
  return new Set((catalog.metrics || []).map((m) => m.id));
}

export function cardIdSet(catalog = defaultCatalog()) {
  return new Set((catalog.cards || []).map((c) => c.id));
}

/** The five lines of business. raisedBy must be one of these. */
export function departmentIdSet(org = defaultOrg()) {
  return new Set((org.departments || []).map((d) => d.id));
}

export function wordCount(s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {any} obj              the parsed extractor output
 * @param {Object} [opts]
 * @param {Object} [opts.catalog] catalog.json, defaults to the shipped one
 * @param {Object} [opts.org]     org.json, defaults to the shipped one
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateExtraction(obj, opts = {}) {
  const errors = [];
  const catalog = opts.catalog || defaultCatalog();
  const org = opts.org || defaultOrg();
  const metrics = metricIdSet(catalog);
  const cards = cardIdSet(catalog);
  const departments = departmentIdSet(org);

  if (!isPlainObject(obj)) {
    return { ok: false, errors: ['extraction: expected an object'] };
  }

  if (!isNonEmptyString(obj.meetingId)) errors.push('meetingId: required non-empty string');
  if (!isNonEmptyString(obj.meetingDate)) {
    errors.push('meetingDate: required non-empty string');
  } else if (!ISO_DATE.test(obj.meetingDate)) {
    errors.push(`meetingDate: expected YYYY-MM-DD, got "${obj.meetingDate}"`);
  }

  for (const key of ['decisions', 'blockers', 'notes', 'statedNumbers', 'asks']) {
    if (!Array.isArray(obj[key])) errors.push(`${key}: required array`);
  }
  for (const key of ['statements', 'commitments', 'openQuestions', 'injectionAttempts']) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) {
      errors.push(`${key}: must be an array when present`);
    }
  }

  // --- decisions -----------------------------------------------------------
  if (Array.isArray(obj.decisions)) {
    const seenIds = new Set();
    obj.decisions.forEach((d, i) => {
      const at = `decisions[${i}]`;
      if (!isPlainObject(d)) {
        errors.push(`${at}: expected an object`);
        return;
      }

      if (d.id !== undefined && d.id !== null) {
        if (!isNonEmptyString(d.id)) {
          errors.push(`${at}.id: must be a non-empty string or null`);
        } else if (seenIds.has(d.id)) {
          errors.push(`${at}.id: duplicate id "${d.id}" in one extraction`);
        } else {
          seenIds.add(d.id);
        }
      }

      if (!isNonEmptyString(d.headline)) {
        errors.push(`${at}.headline: required non-empty string`);
      } else if (wordCount(d.headline) > MAX_HEADLINE_WORDS) {
        errors.push(
          `${at}.headline: ${wordCount(d.headline)} words, must be under 14 - "${d.headline}"`
        );
      }

      if (!isNonEmptyString(d.domain)) {
        errors.push(`${at}.domain: required non-empty string`);
      } else if (!DOMAINS.includes(d.domain)) {
        errors.push(`${at}.domain: "${d.domain}" is not in DOMAINS`);
      }

      if (!isNonEmptyString(d.status)) {
        errors.push(`${at}.status: required non-empty string`);
      } else if (!DECISION_STATUSES.includes(d.status)) {
        errors.push(`${at}.status: "${d.status}" is not a DecisionStatus`);
      } else if (REASON_REQUIRED.includes(d.status) && !isNonEmptyString(d.reason)) {
        errors.push(
          `${at}.reason: required and non-empty when status is ${d.status} ` +
          `(REASON_REQUIRED = ${REASON_REQUIRED.join(', ')})`
        );
      }

      for (const field of ['carriedIn', 'evidence', 'decided', 'beforeNextReview', 'strip']) {
        if (!isNonEmptyString(d[field])) errors.push(`${at}.${field}: required non-empty string`);
      }
      if (isNonEmptyString(d.strip) && wordCount(d.strip) > 24) {
        errors.push(`${at}.strip: ${wordCount(d.strip)} words, must be under 24`);
      }
      if (isNonEmptyString(d.carriedIn) && wordCount(d.carriedIn) > 70) {
        errors.push(`${at}.carriedIn: ${wordCount(d.carriedIn)} words, must be under 70`);
      }

      if (d.owner !== null && !isNonEmptyString(d.owner)) {
        errors.push(`${at}.owner: must be a non-empty string or null`);
      }
      if (d.dueDate !== null && d.dueDate !== undefined) {
        if (!ISO_DATE.test(String(d.dueDate))) {
          errors.push(`${at}.dueDate: expected YYYY-MM-DD or null, got "${d.dueDate}"`);
        }
      }

      if (d.number !== undefined && !Number.isFinite(d.number)) {
        errors.push(`${at}.number: must be a number when present`);
      }

      if (!Array.isArray(d.metricIds)) {
        errors.push(`${at}.metricIds: required array (use [] when nothing proves it)`);
      } else {
        d.metricIds.forEach((m, j) => {
          if (!metrics.has(m)) {
            errors.push(`${at}.metricIds[${j}]: "${m}" is not a metric id in catalog.json`);
          }
        });
      }

      if (d.previousStateUnverified !== undefined && typeof d.previousStateUnverified !== 'boolean') {
        errors.push(`${at}.previousStateUnverified: must be a boolean when present`);
      }
      if (d.quote !== undefined && d.quote !== null && !isNonEmptyString(d.quote)) {
        errors.push(`${at}.quote: must be a non-empty string or null`);
      }
    });
  }

  // --- blockers ------------------------------------------------------------
  // Note what is NOT an error here: a missing needsFrom. org.json demands one, but
  // the right response is a flag with a name on it, not a rejected extraction.
  // Refusing to publish the week because one blocker is half-stated would hide the
  // other nine, which is the opposite of what this object is for.
  if (Array.isArray(obj.blockers)) {
    const seenBlockerIds = new Set();
    obj.blockers.forEach((b, i) => {
      const at = `blockers[${i}]`;
      if (!isPlainObject(b)) {
        errors.push(`${at}: expected an object`);
        return;
      }

      if (b.id !== undefined && b.id !== null) {
        if (!isNonEmptyString(b.id)) {
          errors.push(`${at}.id: must be a non-empty string or null`);
        } else if (seenBlockerIds.has(b.id)) {
          errors.push(`${at}.id: duplicate id "${b.id}" in one extraction`);
        } else {
          seenBlockerIds.add(b.id);
        }
      }

      if (!isNonEmptyString(b.title)) {
        errors.push(`${at}.title: required non-empty string`);
      } else if (wordCount(b.title) > MAX_HEADLINE_WORDS) {
        errors.push(`${at}.title: ${wordCount(b.title)} words, must be under 14`);
      }

      if (!isNonEmptyString(b.raisedBy)) {
        errors.push(`${at}.raisedBy: required - name the blocked line of business`);
      } else if (!departments.has(b.raisedBy)) {
        errors.push(
          `${at}.raisedBy: "${b.raisedBy}" is not a department id ` +
          `(${[...departments].join(', ')})`
        );
      }

      // needsFrom may be a department id OR a named person. Null is allowed by the
      // schema and flagged by apply.js.
      if (b.needsFrom !== null && b.needsFrom !== undefined && !isNonEmptyString(b.needsFrom)) {
        errors.push(`${at}.needsFrom: must be a department id, a person's name, or null`);
      }

      if (!isNonEmptyString(b.what)) {
        errors.push(`${at}.what: required - the specific ask, not the topic`);
      }

      if (b.status !== undefined && b.status !== null && !BLOCKER_STATUSES.includes(b.status)) {
        errors.push(
          `${at}.status: "${b.status}" is not a BlockerStatus (${BLOCKER_STATUSES.join(' | ')})`
        );
      }

      if (b.metricIds !== undefined) {
        if (!Array.isArray(b.metricIds)) {
          errors.push(`${at}.metricIds: must be an array when present`);
        } else {
          b.metricIds.forEach((m, j) => {
            if (!metrics.has(m)) {
              errors.push(`${at}.metricIds[${j}]: "${m}" is not a metric id in catalog.json`);
            }
          });
        }
      }

      if (b.owner !== null && b.owner !== undefined && !isNonEmptyString(b.owner)) {
        errors.push(`${at}.owner: must be a non-empty string or null`);
      }
      if (b.dueDate !== null && b.dueDate !== undefined && !ISO_DATE.test(String(b.dueDate))) {
        errors.push(`${at}.dueDate: expected YYYY-MM-DD or null, got "${b.dueDate}"`);
      }
      if (b.raisedAt !== null && b.raisedAt !== undefined && !ISO_DATE.test(String(b.raisedAt))) {
        errors.push(`${at}.raisedAt: expected YYYY-MM-DD or null, got "${b.raisedAt}"`);
      }
    });
  }

  // --- statements ----------------------------------------------------------
  if (Array.isArray(obj.statements)) {
    obj.statements.forEach((s, i) => {
      const at = `statements[${i}]`;
      if (!isPlainObject(s)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      if (!STATEMENT_KINDS.includes(s.kind)) {
        errors.push(`${at}.kind: "${s.kind}" is not one of ${STATEMENT_KINDS.join(' | ')}`);
      }
      if (!isNonEmptyString(s.text)) errors.push(`${at}.text: required non-empty string`);
    });
  }

  // --- commitments ---------------------------------------------------------
  if (Array.isArray(obj.commitments)) {
    obj.commitments.forEach((c, i) => {
      const at = `commitments[${i}]`;
      if (!isPlainObject(c)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      if (!isNonEmptyString(c.text)) errors.push(`${at}.text: required non-empty string`);
      if (c.owner !== null && c.owner !== undefined && !isNonEmptyString(c.owner)) {
        errors.push(`${at}.owner: must be a non-empty string or null`);
      }
      if (c.dueDate !== null && c.dueDate !== undefined && !ISO_DATE.test(String(c.dueDate))) {
        errors.push(`${at}.dueDate: expected YYYY-MM-DD or null, got "${c.dueDate}"`);
      }
    });
  }

  // --- notes ---------------------------------------------------------------
  if (Array.isArray(obj.notes)) {
    obj.notes.forEach((n, i) => {
      const at = `notes[${i}]`;
      if (!isPlainObject(n)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      if (!isNonEmptyString(n.cardId)) {
        errors.push(`${at}.cardId: required non-empty string`);
      } else if (!cards.has(n.cardId)) {
        errors.push(`${at}.cardId: "${n.cardId}" is not a card id in catalog.json`);
      }
      if (!isNonEmptyString(n.text)) errors.push(`${at}.text: required non-empty string`);
    });
  }

  // --- statedNumbers -------------------------------------------------------
  if (Array.isArray(obj.statedNumbers)) {
    obj.statedNumbers.forEach((s, i) => {
      const at = `statedNumbers[${i}]`;
      if (!isPlainObject(s)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      if (!isNonEmptyString(s.metricId)) {
        errors.push(`${at}.metricId: required non-empty string`);
      } else if (!metrics.has(s.metricId)) {
        errors.push(`${at}.metricId: "${s.metricId}" is not a metric id in catalog.json`);
      }
      if (!Number.isFinite(s.statedValue)) {
        errors.push(`${at}.statedValue: required finite number in the metric's own units`);
      }
      if (!isNonEmptyString(s.statedBy)) errors.push(`${at}.statedBy: required non-empty string`);
      // The quote is what makes a contradiction flag arguable in the room. Without
      // it the flag is the engine's word against a person's memory.
      if (!isNonEmptyString(s.quote)) errors.push(`${at}.quote: required verbatim quote`);
    });
  }

  // --- asks ----------------------------------------------------------------
  if (Array.isArray(obj.asks)) {
    obj.asks.forEach((a, i) => {
      const at = `asks[${i}]`;
      if (!isPlainObject(a)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      if (!isNonEmptyString(a.ask)) errors.push(`${at}.ask: required non-empty string`);
      if (a.owner !== null && a.owner !== undefined && !isNonEmptyString(a.owner)) {
        errors.push(`${at}.owner: must be a non-empty string or null`);
      }
      if (a.dueDate !== null && a.dueDate !== undefined && !ISO_DATE.test(String(a.dueDate))) {
        errors.push(`${at}.dueDate: expected YYYY-MM-DD or null, got "${a.dueDate}"`);
      }
    });
  }

  // --- injectionAttempts ---------------------------------------------------
  // These are quoted, never obeyed. We only check they are quotable.
  if (Array.isArray(obj.injectionAttempts)) {
    obj.injectionAttempts.forEach((x, i) => {
      const at = `injectionAttempts[${i}]`;
      if (!isPlainObject(x)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      if (!isNonEmptyString(x.quote)) errors.push(`${at}.quote: required verbatim quote`);
    });
  }

  return { ok: errors.length === 0, errors };
}
