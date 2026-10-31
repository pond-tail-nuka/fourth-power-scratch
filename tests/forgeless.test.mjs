// tests/forgeless.test.mjs — MR/Issue 挙動の forge ゼレステスト + 人間に期待する挙動の自動テスト (harness.mjs 参照)。
// src/forge.mjs も executor の bare repo git も通さない (spec §11 mock bullet: 同一 code path の制約は harness 側で再現)。
// orchestror 本体は本物 — 人間動作 (承認・マージ判断・re-triage・thread 解決・条項 comment) を REST 経由で自動化し、
// 期待挙動と逸脱 (§8 stale 承認・§3 Closes keyword・protection・§9 介入分類) を検出する。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createForgelessHarness } from './forgeless/harness.mjs';
import { STATUS_SRC, seedAcceptFiles, parseTopic, fenceOf, childSectionText } from './perform/accept-src.mjs';
import { startTurn as stubStartTurn } from '../src/stubSeat.mjs';
import { runChecks } from '../src/runner.mjs';
import { branchName, hasAcceptClauses } from '../src/loop.mjs';

const REPO = 'fourth-power/mock-scratch';
const BOT = 'fourth-power-bot';

function makeHarness({ mainFiles = seedAcceptFiles(), fixture = 'p1-green-implement.json' } = {}) {
  let current = fixture;
  const seat = { startTurn: (req) => stubStartTurn({ ...req, fixture: current }) };
  const h = createForgelessHarness({ repoKey: REPO, mainFiles, seat, runner: runChecks });
  return { h, setFixture: (f) => { current = f; } };
}

function p1Topic() { return parseTopic('P1.md'); }

function mkP1Issue(h) {
  const topic = p1Topic();
  return h.forge.draftIssue({ repo: REPO, title: topic.front.title ?? 'P1: status.mjs --json 追加', body: topic.body, labels: ['backlog'], author: h.human.reviewer });
}

function greenBranch(h, issue) {
  h.submitPatch(branchName(issue.number, issue.title), { 'scripts/status.mjs': STATUS_SRC });
  return h.forge.createPR({ repo: REPO, head: branchName(issue.number, issue.title), base: 'main', title: `agent: issue #${issue.number}`, body: `squash(#${issue.number})\nrefs: spec §2.1 accept:A1`, draft: true });
}

test('期待する人間挙動: head SHA 承認 → merge 成立と done/ close (§8・§3 順序)', async () => {
  const { h } = makeHarness();
  const issue = mkP1Issue(h);
  await h.claimAndLabel(issue, 'sess-fl-p1-01');
  assert.equal((await h.orchestrator.runIssue(h.forge.issue(issue.id))).transition, 'turn');
  const pr = greenBranch(h, issue);
  h.forge.readyPR(pr.id);
  const head = h.forge.branchSha(pr.id);
  assert.equal(h.human.approveAtHead(pr.id), head);
  await h.forge.setLabel(issue.id, 'in_review');
  await h.runChecksOnPR(pr.id);
  assert.equal((await h.orchestrator.runIssue(h.forge.issue(issue.id))).transition, 'merged');
  const after = h.forge.issue(issue.id);
  assert.ok(after.labels.includes('done'));
  assert.equal(after.state, 'closed');
  assert.deepEqual(h.forge.approvals(pr.id), [{ reviewer: h.human.reviewer, sha: head }]);
  const rep = h.metrics();
  assert.equal(rep['positive-implementation'].falseGreen, false);
  assert.equal(rep.autonomy.requiredApprovals, 1);
  assert.equal(rep.autonomy.approvalsSatisfied, 1);
  assert.equal(rep.efficiency.gateRejects, 0);
});

test('人間逸脱: 旧 SHA の承認 → マージ不可; 正しく再承認 → merge (§8 stale 検出)', async () => {
  const { h } = makeHarness();
  const issue = mkP1Issue(h);
  await h.claimAndLabel(issue, 'sess-fl-stale-01');
  await h.orchestrator.runIssue(h.forge.issue(issue.id));
  const pr = greenBranch(h, issue);
  h.forge.readyPR(pr.id);
  await h.runChecksOnPR(pr.id);
  h.human.approveAtHead(pr.id);
  h.submitPatch(branchName(issue.number, issue.title), { 'scripts/status.mjs': STATUS_SRC + '// v2\n' });
  assert.deepEqual(h.forge.approvals(pr.id), [], 'dismiss_stale_reviews: protection が旧 SHA 承認を自動 dismiss (§4.4)');
  const re = await h.orchestrator.runIssue(h.forge.issue(issue.id));
  assert.notEqual(re.transition, 'merged');
  assert.ok(!h.forge.issue(issue.id).labels.includes('done'));
  h.human.approveAtHead(pr.id);
  await h.forge.setLabel(issue.id, 'in_review');
  await h.runChecksOnPR(pr.id);
  assert.equal((await h.orchestrator.runIssue(h.forge.issue(issue.id))).transition, 'merged');
});

test('人間逸脱: green 前の direct merge 試行 → protection が阻止 (§2 invariant 4)', async () => {
  const { h } = makeHarness();
  const issue = mkP1Issue(h);
  await h.claimAndLabel(issue, 'sess-fl-deny-01');
  await h.orchestrator.runIssue(h.forge.issue(issue.id));
  const pr = greenBranch(h, issue);
  assert.throws(() => h.forge.mergePR(pr.id, 'squash'), /required check|承認|mergeable/);
  assert.equal(h.forge.prsForIssue(REPO, issue.number, { state: 'all' })[0].state, 'open');
  assert.ok(!h.forge.issue(issue.id).labels.includes('done'));
});

test('期待する人間挙動: unresolved thread → red; 人間が thread 解決 → green → merge (§8)', async () => {
  const { h } = makeHarness();
  const issue = mkP1Issue(h);
  await h.claimAndLabel(issue, 'sess-fl-thread-01');
  await h.orchestrator.runIssue(h.forge.issue(issue.id));
  const pr = greenBranch(h, issue);
  h.forge.readyPR(pr.id);
  const thread = h.forge.addReviewThread(pr.id, 'scope 超過の指摘 (人間 review)', { resolved: false, author: h.human.reviewer });
  h.human.approveAtHead(pr.id);
  const checks = await h.runChecksOnPR(pr.id);
  assert.ok(checks.some((c) => c.name === 'review-threads' && c.state === 'failure'));
  h.human.approveAtHead(pr.id);
  const deny = await h.orchestrator.runIssue(h.forge.issue(issue.id));
  assert.notEqual(deny.transition, 'merged');
  h.human.resolveThread(pr.id, thread.id);
  await h.forge.setLabel(issue.id, 'in_review');
  const green = await h.runChecksOnPR(pr.id);
  assert.ok(green.every((c) => c.state === 'success'));
  assert.equal((await h.orchestrator.runIssue(h.forge.issue(issue.id))).transition, 'merged');
});

test('期待する人間挙動: plan PR の承認→マージ = 介入 (d) → child 機械組立 (§5・§9)', async () => {
  const { h, setFixture } = makeHarness({ fixture: 'p2-plan.json' });
  const topic = parseTopic('P2.md');
  const issue = h.forge.draftIssue({ repo: REPO, title: topic.front.title ?? 'P2 お題', body: topic.body, labels: ['backlog'], author: h.human.reviewer });
  await h.claimAndLabel(issue, 'sess-fl-plan-01');
  assert.equal((await h.orchestrator.runIssue(h.forge.issue(issue.id))).transition, 'plan');
  const children = [
    { id: 'A21-A', title: 'status.mjs --json 出力本体', cmd: 'node --test ci/accept/a21-a.test.mjs', scope: ['scripts/status.mjs'], refs: ['spec §2.1', 'spec §4.3', 'spec §5'] },
    { id: 'A21-B', title: 'status.mjs --json stale banner', cmd: 'node --test ci/accept/a21-b.test.mjs', scope: ['scripts/status.mjs'], refs: ['spec §2.6', 'spec §6'] },
  ];
  const branch = `llm/issue-${issue.number}-plan`;
  h.submitPatch(branch, { 'docs/plan/issue-fl.json': JSON.stringify({ children }, null, 2) });
  const pr = h.forge.createPR({ repo: REPO, head: branch, base: 'main', title: `plan: issue #${issue.number}`, body: `plan sess-fl-plan-01 #${issue.number}\n${childSectionText(children)}`, draft: true, labels: ['exempt:spec-pr', 'plan:approved'] });
  h.forge.readyPR(pr.id);
  h.human.approveAtHead(pr.id); // 人間承認 — risk-tier §8 (介入 (d) の前提)
  await h.runChecksOnPR(pr.id, { acceptBlock: 'accept: plan-vacuous\n```acceptBlock\n{"accept":[],"scope":["docs/plan"],"refs":["spec §5"]}\n```' });
  h.forge.postCheck(pr.id, { name: 'accept', state: 'success' }, BOT); // plan PR の accept stand-in (perform driver と同様の §4.4 代替)
  assert.deepEqual(await h.orchestrator.assembleChildrenAfterPlanMerge(h.forge.issue(issue.id), h.config), []);
  h.human.mergeAsJudgment(pr.id); // 人間判断のマージ (介入 (d) 相当)
  const created = await h.orchestrator.assembleChildrenAfterPlanMerge(h.forge.issue(issue.id), h.config);
  assert.equal(created.length, 2);
  for (const c of created) {
    const child = h.forge.issue(c.noteId);
    assert.equal(child.author, BOT);
    assert.ok(child.labels.includes('backlog'));
    assert.ok(hasAcceptClauses(child.body));
  }
  assert.ok(h.forge.issue(created[0].noteId).body.includes('accept: A21-A'));
  setFixture('p2-child-implement.json');
  for (const c of created) {
    const child = h.forge.issue(c.noteId);
    await h.claimAndLabel(child, `sess-fl-child-${child.number}`);
    await h.orchestrator.runIssue(h.forge.issue(child.id));
    const b = branchName(child.number, child.title);
    h.submitPatch(b, { 'scripts/status.mjs': STATUS_SRC });
    const prC = h.forge.createPR({ repo: REPO, head: b, base: 'main', title: `agent: issue #${child.number}`, body: `squash(#${child.number}) refs: spec §5`, draft: true });
    h.forge.readyPR(prC.id);
    h.human.approveAtHead(prC.id);
    await h.runChecksOnPR(prC.id);
    await h.forge.setLabel(child.id, 'in_review');
    assert.equal((await h.orchestrator.runIssue(h.forge.issue(child.id))).transition, 'merged');
  }
  const rep = h.metrics();
  assert.equal(rep['decomposition-quality'].children, 2);
  assert.equal(rep['decomposition-quality'].childDone, 2);
  assert.equal(rep['decomposition-quality'].childDoneRate, 1);
  assert.equal(rep['decomposition-quality'].planOneShotApprovalRate, 1);
  assert.equal(rep.autonomy.topicChain.rate, 1);
});

test('人間逸脱: bot 勘定 の承認 (§8 人間承認に不算入) → high tier red・マージ不可', async () => {
  const { h } = makeHarness();
  const issue = mkP1Issue(h);
  await h.claimAndLabel(issue, 'sess-fl-bot-01');
  await h.orchestrator.runIssue(h.forge.issue(issue.id));
  const pr = greenBranch(h, issue);
  h.forge.readyPR(pr.id);
  await h.runChecksOnPR(pr.id);
  h.human.approveAtHead(pr.id, BOT);
  assert.ok(h.forge.checks(pr.id).some((c) => c.name === 'risk-tier' && c.state === 'failure'));
  await h.forge.setLabel(issue.id, 'in_review');
  assert.notEqual((await h.orchestrator.runIssue(h.forge.issue(issue.id))).transition, 'merged');
  assert.ok(!h.forge.issue(issue.id).labels.includes('done'));
  h.human.approveAtHead(pr.id);
  await h.runChecksOnPR(pr.id);
  assert.equal((await h.orchestrator.runIssue(h.forge.issue(issue.id))).transition, 'merged');
  assert.equal(h.metrics().autonomy.approvalsSatisfied, 1);
});

test('人間挙動: 条項 comment (§5 機械可読) — 非機械可読 body は needs-info 条件外', async () => {
  const { h } = makeHarness();
  const fence = fenceOf(p1Topic().body);
  const withClause = h.forge.draftIssue({ repo: REPO, title: '条項 issue', body: `accept: A1\nspec §2.1\n\`\`\`acceptBlock\n${fence}\n\`\`\``, labels: ['needs-info', 'cohort:fast'], author: h.human.reviewer });
  assert.ok(hasAcceptClauses(withClause.body));
  const plain = h.forge.draftIssue({ repo: REPO, title: '自由文 issue', body: 'please review this is free-form', labels: ['needs-info', 'cohort:typical'], author: h.human.reviewer });
  assert.equal(hasAcceptClauses(plain.body), false);
  const ids = h.forge.scanNeedsInfo(REPO).map((i) => i.id);
  assert.ok(ids.includes(withClause.id) && ids.includes(plain.id));
  const note = h.human.addClause(withClause.id, 'accept: A1 追加条項 (human)');
  const notes = h.forge.notes(withClause.id);
  assert.ok(notes.some((n) => n.id === note.noteId && /^accept:/.test(n.body)));
  assert.ok(!notes.some((n) => /^claimed\s/.test(n.body))); // 人間 comment は claim 解析されない (claims.mjs 写し)
});

test('人間挙動: topic re-triage → child close は介入 (a) 計上 (§9 分類)', async () => {
  const { h } = makeHarness();
  const topic = parseTopic('P2.md');
  const t = h.forge.draftIssue({ repo: REPO, title: topic.front.title ?? 'P2 topic', body: topic.body, labels: ['backlog'], author: h.human.reviewer });
  const child = h.forge.draftIssue({ repo: REPO, title: 'child issue', body: `accept: A1\nspec §2.1\n\`\`\`acceptBlock\n${fenceOf(p1Topic().body)}\n\`\`\``, labels: ['backlog'], author: BOT });
  h.human.retriage(child.id);
  h.forge.closeIssue(t.id);
  assert.equal(h.forge.issue(child.id).state, 'closed');
  assert.ok(h.forge.issue(child.id).labels.includes('backlog'));
  const rep = h.metrics();
  assert.equal(rep.autonomy.interventions.a, 1);
  assert.equal(rep.autonomy.interventions.total, 1);
});
