/**
 * The "Still need from Sai" grid.
 *
 * Most of these are raised by the engine, not typed by a human - a source went
 * stale, a metric has no proof, a decision is overdue. Grouping by owner is the
 * whole point: one person, one list, no ambiguity about who unblocks it.
 */

import { esc, ownerName } from './util.js';

/** Flag kind -> the word that goes after the owner's name on the tag. */
const KIND_ACTION = {
  missing_data: 'add this',
  stale_source: 'refresh this',
  // Deliberately different words from stale_source. That flag wants a broken
  // connection fixed; this one wants a person to make a call they skipped.
  rag_stale: 'call this',
  off_target: 'explain this',
  no_target: 'set a target',
  // The one flag addressed to three people, so the verb is the one thing three
  // people can actually do together.
  no_owner: 'pick one of you',
  no_proof: 'prove this',
  overdue: 'close this',
  contradiction: 'resolve this',
  manual: 'add this'
};

/**
 * The flag already carries its address - deriveFlags resolved the metric's ONE
 * accountable owner. Falling back to the department only matters for flags
 * typed by a human, and even then it resolves to one name, not the trio: these
 * cards are grouped under "Still need from X", and a heading naming three
 * people is a heading nobody reads as theirs.
 */
function ownerNameFor(flag, org) {
  if (flag.owner) return flag.owner;
  if (!flag.dept) return 'someone';
  const name = ownerName(flag.dept, org);
  return name === '[OWNER NEEDED]' ? name : (name || 'someone');
}

function flagCard(flag, org) {
  const owner = ownerNameFor(flag, org);
  const action = KIND_ACTION[flag.kind] || 'add this';
  return (
    '<article class="card flag">'
    + `<span class="flagtag">${esc(owner)} &middot; ${esc(action)}</span>`
    + `<h3>${esc(flag.title)}</h3>`
    + `<p>${esc(flag.body)}</p>`
    + '</article>'
  );
}

/**
 * flagCards(flags, org) -> the full "Still need from X" block, one headed grid
 * per owner. Resolved flags are dropped. Returns '' when nothing is outstanding,
 * so a clean week renders a clean page.
 */
export function flagCards(flags, org) {
  const open = (flags || []).filter(f => !f.resolvedAt);
  if (!open.length) return '';

  const groups = new Map();
  for (const f of open) {
    const owner = ownerNameFor(f, org);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(f);
  }

  // Biggest ask first - that is the person to chase.
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return ordered.map(([owner, list]) => (
    '<div class="sechead">'
    + `<h2>Still need from ${esc(owner)}</h2>`
    + '<p>Flagged, not yet folded in &mdash; nothing here is a real number.</p>'
    + '</div>'
    + `<section class="grid">${list.map(f => flagCard(f, org)).join('')}</section>`
  )).join('');
}

/** Exported for the footer's "n items outstanding" line. */
export function openFlagCount(flags) {
  return (flags || []).filter(f => !f.resolvedAt).length;
}
