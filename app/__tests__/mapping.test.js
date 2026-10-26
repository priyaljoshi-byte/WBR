import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName, similarity, suggestMapping,
  requiredColumnsForSource, manualMetricsForSource, SUGGEST_THRESHOLD
} from '../mapping.js';

const pick = (rows, required) => rows.find((r) => r.required === required);

/* -------------------------------- normalise ------------------------------- */

test('normalizeName folds case, separators and punctuation', () => {
  assert.equal(normalizeName('Date of Joining`'), 'date of joining');
  assert.equal(normalizeName('date_of_joining'), 'date of joining');
  assert.equal(normalizeName('Date-of-Joining'), 'date of joining');
  assert.equal(normalizeName('  DATE OF JOINING :  '), 'date of joining');
  assert.equal(normalizeName(null), '');
});

test('similarity is 1 for names that differ only in formatting', () => {
  assert.equal(similarity('updated_on', 'Updated On'), 1);
  assert.equal(similarity('days_to_close', 'Days to Close'), 1);
});

test('similarity of unrelated names is low', () => {
  assert.ok(similarity('spend', 'owner') < SUGGEST_THRESHOLD);
});

/* ------------------------------ pre-selection ----------------------------- */

test('the stray backtick case: a real header maps to the required column', () => {
  const rows = suggestMapping(['date_of_joining'], ['Candidate', 'Date of Joining`', 'Status']);
  assert.equal(pick(rows, 'date_of_joining').detected, 'Date of Joining`');
  assert.equal(pick(rows, 'date_of_joining').how, 'exact');
  assert.equal(pick(rows, 'date_of_joining').score, 1);
});

test('snake_case required columns find Title Case headers', () => {
  const rows = suggestMapping(
    ['updated_on', 'created_on', 'won_flag'],
    ['Deal', 'Owner', 'Created On', 'Updated On', 'Won Flag']
  );
  assert.equal(pick(rows, 'updated_on').detected, 'Updated On');
  assert.equal(pick(rows, 'created_on').detected, 'Created On');
  assert.equal(pick(rows, 'won_flag').detected, 'Won Flag');
});

test('a prefixed header still matches: value -> Deal Value', () => {
  const rows = suggestMapping(['value'], ['Deal', 'Owner', 'Deal Value']);
  assert.equal(pick(rows, 'value').detected, 'Deal Value');
  assert.equal(pick(rows, 'value').how, 'fuzzy');
  assert.ok(pick(rows, 'value').score < 1, 'a fuzzy hit must not claim to be exact');
});

test('nothing plausible means nothing is pre-selected', () => {
  const rows = suggestMapping(['spend'], ['Candidate', 'Role', 'Status']);
  assert.equal(pick(rows, 'spend').detected, null);
  assert.equal(pick(rows, 'spend').how, 'none');
});

test('a detected column is claimed by its best match, not the first asker', () => {
  // created_on is listed first and is a near-miss for "Updated On"; it must not
  // take it before updated_on, which matches exactly.
  const rows = suggestMapping(['created_on', 'updated_on'], ['Updated On']);
  assert.equal(pick(rows, 'updated_on').detected, 'Updated On');
  assert.equal(pick(rows, 'created_on').detected, null);
});

test('one detected column is never assigned to two required columns', () => {
  const rows = suggestMapping(['leads', 'qualified_leads'], ['Leads']);
  const used = rows.map((r) => r.detected).filter(Boolean);
  assert.equal(new Set(used).size, used.length);
});

test('plural and singular are the same subject', () => {
  const rows = suggestMapping(['leads'], ['Lead']);
  assert.equal(pick(rows, 'leads').detected, 'Lead');
});

test('alternatives are offered ranked, so the dropdown opens on the likeliest', () => {
  const rows = suggestMapping(['value'], ['Owner', 'Deal Value', 'Stage']);
  const alts = pick(rows, 'value').alternatives;
  assert.equal(alts.length, 3);
  assert.equal(alts[0].column, 'Deal Value');
  assert.ok(alts[0].score >= alts[1].score && alts[1].score >= alts[2].score);
});

test('an empty file offers no suggestion and does not throw', () => {
  const rows = suggestMapping(['value'], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detected, null);
  assert.deepEqual(rows[0].alternatives, []);
  assert.deepEqual(suggestMapping([], ['a', 'b']), []);
});

test('blank and null names are ignored on both sides', () => {
  const rows = suggestMapping(['value', '', null], ['Deal Value', '  ']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detected, 'Deal Value');
});

test('raising the threshold suppresses a weak pre-selection', () => {
  assert.equal(pick(suggestMapping(['value'], ['Deal Value']), 'value').detected, 'Deal Value');
  assert.equal(pick(suggestMapping(['value'], ['Deal Value'], { threshold: 0.99 }), 'value').detected, null);
});

/* --------------------------- required columns ----------------------------- */

const METRICS = [
  { id: 'a', label: 'Pipeline open', source: { ref: 'india_crm', agg: 'sum', column: 'value', where: { column: 'stage', in: ['POC'] } } },
  { id: 'b', label: 'Win rate', source: { ref: 'india_crm', agg: 'avg', column: 'won_flag' } },
  { id: 'c', label: 'Cost per lead', source: { ref: 'ads_india', agg: 'ratio', numerator_column: 'spend', denominator_column: 'leads' } },
  { id: 'd', label: 'Typed in', source: { ref: 'event_manual', agg: 'latest', column: 'attendees' } }
];

test('required columns are gathered from every SourceQuery shape', () => {
  const need = requiredColumnsForSource('india_crm', METRICS, { date_column: 'updated_on', row_timestamp_column: 'updated_on' });
  const cols = need.map((n) => n.column).sort();
  assert.deepEqual(cols, ['stage', 'updated_on', 'value', 'won_flag']);
});

test('both sides of a ratio are required', () => {
  const cols = requiredColumnsForSource('ads_india', METRICS, { date_column: 'date' }).map((n) => n.column).sort();
  assert.deepEqual(cols, ['date', 'leads', 'spend']);
});

test('each required column carries why it is needed, for the UI', () => {
  const need = requiredColumnsForSource('india_crm', METRICS, { date_column: 'updated_on' });
  const stage = need.find((n) => n.column === 'stage');
  assert.deepEqual(stage.why, ['Pipeline open (filter)']);
  const updated = need.find((n) => n.column === 'updated_on');
  assert.deepEqual(updated.why, ['which rows are in this period']);
});

test('notion\'s synthetic _last_edited is not asked of the human', () => {
  const cols = requiredColumnsForSource('sloosh_board', [], { date_column: 'Done on', row_timestamp_column: '_last_edited' })
    .map((n) => n.column);
  assert.deepEqual(cols, ['Done on']);
});

test('a source no metric reads still needs its date column', () => {
  const cols = requiredColumnsForSource('nobody', METRICS, { date_column: 'date' }).map((n) => n.column);
  assert.deepEqual(cols, ['date']);
});

test('manual metrics are the ones the type-it-in form renders', () => {
  assert.deepEqual(manualMetricsForSource('event_manual', METRICS).map((m) => m.id), ['d']);
  assert.deepEqual(manualMetricsForSource('nope', METRICS), []);
});
