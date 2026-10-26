import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFunnels, funnelTables, classify, parseRoles, normRole, parseHeadcount } from '../hiring.js';

const config = JSON.parse(readFileSync(new URL('../../config/hiring.json', import.meta.url), 'utf8'));

const roleRows = [
  { Role: 'Customer Success Manager', POC: 'Rishi', 'Priority ': 'P0', 'Headcount ': '2', Status: '' },
  { Role: 'Role', POC: 'POC', 'Priority ': 'Priority', 'Headcount ': 'Headcount' },
  { Role: 'Explo Roles', POC: '', 'Priority ': '', 'Headcount ': '' },
  { Role: 'Video Editor  ', POC: 'Satwik', 'Priority ': 'P1', 'Headcount ': '1', Status: 'Closed' },
  { Role: 'Creative Prompt Engineer', POC: 'Omer/Rishi', 'Priority ': 'P2', 'Headcount ': '2 to be added' }
];

test('open-roles tab: repeated headers and section labels are skipped, status read', () => {
  const roles = parseRoles(roleRows);
  assert.deepEqual(roles.map((r) => r.name), ['Customer Success Manager', 'Video Editor', 'Creative Prompt Engineer']);
  assert.equal(roles[1].status, 'closed');
  assert.equal(roles[2].headcount, 2);
});

test('headcount and role-name normalising', () => {
  assert.equal(parseHeadcount(''), 1);
  assert.equal(parseHeadcount('2 to be added'), 2);
  assert.equal(normRole('Video Editors'), normRole('video editor'));
  assert.equal(normRole("Founder's Round"), 'founder round');
});

test('a bare "Rejected" is placed by the round columns, not dropped to the top', () => {
  const c = classify({ 'Current Stage': 'Rejected', 'Round 1': 'Vishal', 'Round 2': 'Subham' }, config);
  assert.equal(config.stages[c.reached].id, 'r2');
  assert.equal(c.status, 'dropped');
});

test('"NA" and "Pending" prove nothing', () => {
  const c = classify({ 'Current Stage': 'Hold', 'Round 1': 'NA', 'Screening by TA': 'Pending' }, config);
  assert.equal(c.reached, 0);
  assert.equal(c.status, 'hold');
});

test('the waterfall only goes down, aliases match, offers upgrade, strays are listed', () => {
  const out = buildFunnels({
    roleRows,
    candidateTabs: [
      { recruiter: 'Satwik', rows: [
        { 'Candidate Name': 'A', Role: 'CSM', 'Current Stage': 'TA Explore Call' },
        { 'Candidate Name': 'B', Role: 'CSM BLR', 'Current Stage': 'R1 Interview' },
        { 'Candidate Name': 'X', Role: 'Creative Director', 'Current Stage': 'R1' }
      ] },
      { recruiter: 'Rishi', rows: [
        { 'Candidate Name': 'C', Role: 'CSM (India)', 'Current Stage': "Founder's Round" },
        { 'Candidate Name': 'D', Role: 'Customer Success Manager', 'Current Stage': 'Assignment in review' },
        { 'Candidate Name': 'E', Role: 'CSM', 'Current Stage': 'Somewhere new' }
      ] }
    ],
    offerRows: [{ 'Candidate Name': 'C', 'Offer Status': 'Offer Accepted', 'Joining Status': 'Yet to Join' }]
  }, config);

  const csm = out.funnels.find((f) => f.name === 'Customer Success Manager');
  const counts = csm.steps.map((s) => s.reached);
  assert.equal(csm.total, 5);
  for (let i = 1; i < counts.length; i += 1) assert.ok(counts[i] <= counts[i - 1], `stage ${i} rose: ${counts}`);
  assert.equal(csm.steps.find((s) => s.id === 'offer').reached, 1);
  assert.equal(csm.hired, 1);
  // 2 openings, 1 hired -> 1 opening x 3 needed; B (R1) and D (assignment) are healthy.
  assert.equal(csm.need, 3);
  assert.equal(csm.healthy, 2);
  assert.equal(csm.health, 67);
  assert.deepEqual(out.unmatched.map((u) => u.role), ['Creative Director']);
  assert.deepEqual(out.unknownWords, [{ word: 'Somewhere new', count: 1 }]);
});

test('the page never carries contact or pay fields through', () => {
  const out = buildFunnels({
    roleRows,
    candidateTabs: [{ recruiter: 'Satwik', rows: [
      { 'Candidate Name': 'A', Role: 'CSM', 'Current Stage': 'R1', 'Phone Number': '+91 1', 'Email Address': 'a@x', 'Expected CTC (LPA)': '30' }
    ] }]
  }, config);
  const cand = out.funnels[0].candidates[0];
  assert.deepEqual(Object.keys(cand).sort(), ['name', 'offerOut', 'reached', 'reachedLabel', 'recruiter', 'roleText', 'stageText', 'status']);
});

test('weekly-run tables use the catalogue status words', () => {
  const out = buildFunnels({
    roleRows,
    candidateTabs: [{ recruiter: 'Rishi', rows: [
      { 'Candidate Name': 'A', Role: 'CSM', 'Current Stage': 'TA Explore Call' },
      { 'Candidate Name': 'B', Role: 'CSM', 'Current Stage': 'R2' },
      { 'Candidate Name': 'C', Role: 'CSM', 'Current Stage': "Founder's Round" },
      { 'Candidate Name': 'D', Role: 'CSM', 'Current Stage': 'Documents yet to be received' },
      { 'Candidate Name': 'E', Role: 'CSM', 'Current Stage': 'Withdrawn' },
      { 'Candidate Name': 'F', Role: 'CSM', 'Current Stage': 'R1' }
    ] }],
    offerRows: [
      { 'Candidate Name': 'C', 'Offer Status': 'Offer Intent Shared', 'Joining Status': '' },
      { 'Candidate Name': 'F', 'Offer Status': '', 'Joining Status': 'Joined' }
    ]
  }, config);
  const t = funnelTables(out, config);
  const by = Object.fromEntries(t.candidates.map((c) => [c.candidate, c.status]));
  assert.deepEqual(by, { A: 'screening', B: 'interviewing', C: 'offer_out', D: 'accepted', E: 'dropped', F: 'joined' });
  assert.equal(t.roles.find((r) => r.role === 'Customer Success Manager').status, 'open');
  assert.ok(!('phone_number' in t.candidates[0]));
});
