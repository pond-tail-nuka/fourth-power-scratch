// scripts/perform.mjs — mock 全ループ測定 (spec §10 M5: P1–P4 実行と metrics 視点グループ出力)。
// 使い方: node scripts/perform.mjs [--topics P1,P2,P3,P4] [--out tmp/perform-report.json]
// 夜間: stub seat のみ (live agy 実測は朝の human 承認 — spec §6)。orchestrator・gate・runner・metrics・forge は本物。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { configure as forgeConfigure, normalizeIssue, normalizeChangeRequest, normalizeNote, normalizeCheck, normalizeApproval } from '../src/forge.mjs';
import * as forge from '../src/forge.mjs';
import { createOrchestrator, branchName, parseAcceptBlock } from '../src/loop.mjs';
import { startTurn as stubStartTurn } from '../src/stubSeat.mjs';
import { runChecks } from '../src/runner.mjs';
import { computeReport } from '../src/metrics.mjs';
import * as executor from '../tests/mock-forge/executor.mjs';
import * as mockServer from '../tests/mock-forge/mockServer.mjs';
import * as store from '../tests/mock-forge/store.mjs';
import { STATUS_SRC, seedAcceptFiles, parseTopic, childSectionText } from '../tests/perform/accept-src.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = 'fourth-power/mock-scratch';
const HUMAN = 'pond-tail-nuka';
const BOT = 'fourth-power-bot';
const EPOCH = '2026-10-31T00:00:00Z';

function parseArgs(argv) {
  const out = { topics: ['P1', 'P2', 'P3', 'P4'], out: join(ROOT, '..', 'tmp', 'perform-report.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--topics') out.topics = argv[++i].split(',');
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}
let config;
let gitDir;
let orchestrator;
let currentFixture = 'p1-green-implement.json';

const stubSeat = {
  startTurn(req) { return stubStartTurn({ ...req, fixture: currentFixture }); },
};

function mkIssue({ title, body, labels = ['backlog'], author = HUMAN }) {
  const draft = forge.draftIssue({ repo: REPO, title, body, labels, author });
  return forge.issue(draft.id);
}
async function claimAndLabel(issue, sessionId) {
  await orchestrator.claimIssue(issue.id, sessionId);
  await forge.setLabel(issue.id, 'claimed');
  await forge.removeLabel(issue.id, 'backlog');
}
function headOf(prId) { return forge.prJson(prId).head?.sha ?? null; }
function makePr(issue, body, draft = true, labels = []) {
  return forge.createPR({ repo: REPO, head: branchName(issue.number, issue.title), base: 'main', title: `agent: issue #${issue.number}`, body, draft, labels });
}
async function checksFor(prId, extra = {}) {
  return executor.runChecksOnPR({ runner: runChecks, repoKey: REPO, prId, gitDir, meta: extra, config });
}
async function approveThenReview(issue, prId) {
  forge.approvePR(prId, HUMAN, headOf(prId));
  await forge.setLabel(issue.id, 'in_review');
  await forge.removeLabel(issue.id, 'claimed');
}
async function issueOf(id) { return forge.issue(id); }
function postLedgerRow(issueId, sessionId, turn, cost, seconds, at) {
  forge.postComment(issueId, `budget: consumed_usd=${cost} consumed_seconds=${seconds} at ${at}\n<!-- fp:summary resume ${at} -->\n<!-- fp:session ${sessionId} -->`);
}

function setup() {
  mockServer.resetMock({
    baseISO: EPOCH,
    branchProvider: executor.makeBranchProvider(REPO, gitDir),
    mergeHandler: executor.makeMergeHandler(REPO, gitDir),
    mergeableProvider: executor.makeMergeableProvider(REPO, gitDir),
  });
  forge.configure({ provider: 'mock' });
  rmSync(gitDir, { recursive: true, force: true });
  executor.ensureBareRepo(REPO, gitDir);
  store.repoEnsure(REPO).protection = {
    required_status_checks: { strict: true, contexts: mockServer.REQUIRED_CHECKS },
    required_pull_request_reviews: { dismiss_stale_reviews: true, required_approving_review_count: 1 },
    enforce_admins: true,
  };
  for (const name of forge.readConfig().labels ?? []) {
    mockServer.apiSend('POST', `/repos/${REPO}/labels`, {}, { name }); // bootstrap の label materialize 写し (§2.6 §8 config-consistency)
  }
  executor.writeAndPush(REPO, 'fp/seed-accept', {
    ...seedAcceptFiles(),
  }, 'seed: accept fixtures (人間起票済み・改変禁止)', gitDir);
  // main への seed は人間起票経路 (§2 不変条件 2: direct push 禁止 — bare 側で fast-forward 相当の setup 操作)。
  const ff = spawnSync('git', ['--git-dir', gitDir, 'push', gitDir, 'refs/heads/fp/seed-accept:refs/heads/main'], { cwd: ROOT, encoding: 'utf8' });
  if (ff.status !== 0) throw new Error(`seed main ff push failed: ${ff.stderr}`);
  executor.syncBranchCache(REPO, gitDir);
  config = forge.readConfig();
  // 台帳・budget の wall clock 照合は mock 固定時計 (§3 の created_at と同一源 — 実時刻依存を排除、spec §7 決定論)。
  orchestrator = createOrchestrator({ forge, seat: stubSeat, config, clock: () => store.clock().peek() });
}

async function runP1() {
  const topic = parseTopic('P1.md');
  const issue = mkIssue({ title: 'P1: status.mjs --json 追加', body: topic.body });
  await claimAndLabel(issue, 'sess-p1-green-01');
  currentFixture = 'p1-green-implement.json';
  const first = await orchestrator.runIssue(await issueOf(issue.id));
  executor.writeAndPush(REPO, branchName(issue.number, issue.title), { 'scripts/status.mjs': STATUS_SRC }, 'agent: implement A1', gitDir);
  const pr = makePr(issue, `squash(#${issue.number})\nrefs: spec §2.1 accept:A1 — PR body 参照のみ (§5 re-ingestion MUST NOT)`);
  forge.markPRReady(pr.id);
  await checksFor(pr.id);
  await approveThenReview(await issueOf(issue.id), pr.id);
  await checksFor(pr.id);
  const second = await orchestrator.runIssue(await issueOf(issue.id));
  const merged = second.transition === 'merged';
  return { topicId: 'P1', issueId: issue.id, prId: pr.id, firstTurn: first.transition, mergeTransition: second.transition, merged };
}

async function runPlanPr(topic, issue, planPath, childrenSection, sessionId, acceptStandInReason) {
  currentFixture = 'p2-plan.json';
  const planTurn = await orchestrator.runIssue(await issueOf(issue.id));
  const branch = `llm/issue-${issue.number}-plan`;
  executor.writeAndPush(REPO, branch, { [planPath]: JSON.stringify({ children: childrenSection.children }, null, 2) }, 'agent: plan draft', gitDir);
  const pr = forge.createPR({ repo: REPO, head: branch, base: 'main', title: `plan: issue #${issue.number}`, body: `plan ${sessionId} #${issue.number}\n${childrenSection.text}`, draft: true, labels: ['exempt:spec-pr', 'plan:approved'] });
  const prId = pr.id ?? `${REPO}!${pr.number}`;
  forge.markPRReady(prId);
  const head = headOf(prId);
  forge.approvePR(prId, HUMAN, head); // plan PR の人間承認 = 介入不算入の判断 (§9・§8) — check 前に human review を固定
  await checksFor(prId);
  forge.postCheck(prId, { name: 'accept', state: 'success', headSha: headOf(prId), details: acceptStandInReason }, BOT); // plan PR accept 代替 (§4.4 stand-in)
  return { planTurn, prId, head };
}

async function runP2() {
  const topic = parseTopic('P2.md');
  const issue = mkIssue({ title: 'P2 お題: status.mjs --json 系統の分解', body: topic.body });
  const children = [
    { id: 'A21-A', title: 'status.mjs --json 出力本体', cmd: 'node --test ci/accept/a21-a.test.mjs', scope: ['scripts/status.mjs'], refs: ['spec §2.1', 'spec §4.3', 'spec §5'] },
    { id: 'A21-B', title: 'status.mjs --json stale banner', cmd: 'node --test ci/accept/a21-b.test.mjs', scope: ['scripts/status.mjs'], refs: ['spec §2.6', 'spec §6'] },
  ];
  const text = childSectionText(children);
  const plan = await runPlanPr(topic, issue, 'docs/plan/issue-21-status-json.json', { text, children }, 'sess-p2-plan-01', 'plan PR accept 代替 — docs/governance 整合性 (§17・§4.4)');
  forge.mergePR(plan.prId, 'squash'); // 人間判断の plan PR merge = 介入 (d) (spec §9)
  const created = await orchestrator.assembleChildrenAfterPlanMerge(await issueOf(issue.id), config);
  const childIds = created.map((c) => c.noteId).filter(Boolean);
  const childResults = [];
  for (const childId of childIds) {
    const child = await issueOf(childId);
    const block = parseAcceptBlock(child.body);
    const childAcceptId = block?.accept?.[0]?.id ?? '?';
    await claimAndLabel(child, 'sess-p2-child-01');
    currentFixture = 'p2-child-implement.json';
    const turn = await orchestrator.runIssue(await issueOf(childId));
    executor.writeAndPush(REPO, branchName(child.number, child.title), { 'scripts/status.mjs': STATUS_SRC }, 'agent: child implement', gitDir);
    const pr = makePr(child, `squash(#${child.number})\nrefs: spec §5 accept:${childAcceptId} — PR body 参照のみ (§5 re-ingestion MUST NOT)`);
    forge.markPRReady(pr.id);
    await checksFor(pr.id);
    await approveThenReview(await issueOf(childId), pr.id);
    await checksFor(pr.id);
    const merged = await orchestrator.runIssue(await issueOf(childId));
    childResults.push({ childId, number: child.number, acceptId: block?.accept?.[0]?.id ?? null, turn: turn.transition, merge: merged.transition });
  }
  // topic は close しない (close は child closed と併走すると re-triage 撤回判定に誤爆する — metrics は撤回のみ介入算入、spec §9。夜間 driver は topic 終端を保留)
  return { topicId: 'P2', issueId: issue.id, planTurn: plan.planTurn.transition, planPrId: plan.prId, children: childResults };
}

async function runP3() {
  const topic = parseTopic('P3.md');
  const results = { topicId: 'P3' };
  // P3a: 条項なし Issue — gate scan 対象外・claim MUST NOT (spec §5 §10 M5 負群)
  const a = mkIssue({ title: 'P3a: 条項なし注入', body: '自由文のみ (fence なし・accept 条項なし・plan header なし)。期待: orchestrator は無視 (backlog 据え置き)。' });
  const aRes = await orchestrator.runIssue(await issueOf(a.id));
  results.noClause = { issueId: a.id, transition: aRes.transition, labels: (await issueOf(a.id)).labels };
  // P3b: budget 超過 — cumulative 台帳行 9 本 (P3.md 準拠・値は cumulative、spec §7)
  const fencesB = [...topic.body.matchAll(/```acceptBlock\n([\s\S]*?)\n```/g)];
  const b = mkIssue({ title: 'P3b: budget 超過注入', body: `budget 超過 topic\n\n\`\`\`acceptBlock\n${fencesB[0][1]}\n\`\`\`` });
  await claimAndLabel(b, 'sess-p3-budget-01');
  const rows = [
    [1, 0.6, 240, '2026-10-31T04:00:00Z'], [2, 1.2, 480, '2026-10-31T04:04:00Z'], [3, 1.8, 720, '2026-10-31T04:08:00Z'],
    [4, 2.4, 960, '2026-10-31T04:12:00Z'], [5, 3.0, 1200, '2026-10-31T04:16:00Z'], [6, 3.6, 1440, '2026-10-31T04:20:00Z'],
    [7, 4.2, 1680, '2026-10-31T04:24:00Z'], [8, 4.8, 1920, '2026-10-31T04:28:00Z'], [9, 5.4, 2160, '2026-10-31T04:32:00Z'],
  ];
  for (const [turn, cost, seconds, at] of rows) postLedgerRow(b.id, 'sess-p3-budget-01', turn, cost, seconds, at);
  const bRes = await orchestrator.runIssue(await issueOf(b.id));
  results.budget = { issueId: b.id, transition: bRes.transition, labels: (await issueOf(b.id)).labels };
  // P3c: accept-vacuous 注入 — runner が accept-vacuity + accept red MUST (spec §4.5 §10 M5 false green 対)
  const fenceC = [...topic.body.matchAll(/```acceptBlock\n([\s\S]*?)\n```/g)][1][1];
  const c = mkIssue({ title: 'P3c: accept-vacuous 注入', body: ['vacuous accept 注入', '', '```acceptBlock', fenceC, '```'].join('\n') });
  await claimAndLabel(c, 'sess-p3-vacuous-01');
  currentFixture = 'p1-green-implement.json';
  const turnC = await orchestrator.runIssue(await issueOf(c.id));
  executor.writeAndPush(REPO, branchName(c.number, c.title), { 'src/p3-inject.mjs': 'export const inject = 1;\n' }, 'agent: P3c inject', gitDir);
  const prC = makePr(c, `squash(#${c.number})\nrefs: spec §4.3 accept:A2 vacuous 人間起票 — PR body 参照のみ (§5 re-ingestion MUST NOT)`);
  forge.markPRReady(prC.id);
  const checksC = await checksFor(prC.id);
  results.vacuous = {
    issueId: c.id, turn: turnC.transition, prId: prC.id,
    accept: checksC.find((x) => x.name === 'accept')?.state ?? null,
    vacuity: checksC.find((x) => x.name === 'accept-vacuity')?.state ?? null,
  };
  // 対 (false green 検出): green 実体 p1.test.mjs は P1 topic で accept green 済み (P1 結果と突合) — P3c red と対 (spec §10 M5)
  results.vacuousPair = 'green 実体 (p1.test.mjs) の accept green は P1 topic で観測済み — 同一 runner・同一 workDir 契約の対 (spec §10 M5)';
  // P3d: plan budget 超過 — plan cap 2 (planBudgetMaxTurns) を turn 3 で超過 → blocked/budget・child 起票なし (§7)
  const fenceD = [...topic.body.matchAll(/```acceptBlock\n([\s\S]*?)\n```/g)][2][1];
  const d = mkIssue({ title: 'plan: status.mjs 系統分解 (cap 超過注入)', body: ['plan: status.mjs 系統分解 (注入)', '', '```acceptBlock', fenceD, '```'].join('\n') });
  currentFixture = 'p3-plan-budget-exceeded.json';
  const dRes = await orchestrator.runPlan(await issueOf(d.id), config);
  const draftBranch = `llm/issue-${d.number}-plan`;
  executor.writeAndPush(REPO, draftBranch, { 'docs/plan/issue-35-status.json': JSON.stringify({ children: [] }, null, 2) }, 'agent: plan draft (cap 超過で残存)', gitDir);
  const prD = forge.createPR({ repo: REPO, head: draftBranch, base: 'main', title: `plan: issue #${d.number}`, body: `plan sess-p3-plan-01 #${d.number}`, draft: true });
  results.planBudget = { issueId: d.id, transition: dRes.transition, labels: (await issueOf(d.id)).labels, planPrDraft: prD.id };
  return results;
}

async function runP4() {
  const topic = parseTopic('P4.md');
  const issue = mkIssue({ title: 'P4: 復元注入 (clone 破棄→resume)', body: topic.body });
  await claimAndLabel(issue, 'sess-p4-01');
  currentFixture = 'p1-green-implement.json';
  const before = await orchestrator.runIssue(await issueOf(issue.id));
  const branch = branchName(issue.number, issue.title);
  const workDir = executor.createWorkClone(REPO, gitDir);
  try {
    const target = `${workDir}/scripts/status.mjs`;
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    const { dirname: dn } = await import('node:path');
    mk(dn(target), { recursive: true });
    wf(target, STATUS_SRC);
    executor.commitAndPushBranch(workDir, REPO, branch, 'agent: P4 implement (crash 前)', gitDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true }); // クローン破棄 (spec §10 M5 crash 再現)
  }
  const pr = makePr(issue, `squash(#${issue.number})\nrefs: spec §7 accept:A4 — PR body 参照のみ (§5 re-ingestion MUST NOT)`);
  forge.markPRReady(pr.id);
  await checksFor(pr.id);
  await approveThenReview(await issueOf(issue.id), pr.id);
  await checksFor(pr.id);
  currentFixture = 'p1-green-implement.json';
  const after = await orchestrator.runIssue(await issueOf(issue.id), { resumeSessionId: 'sess-p4-01' });
  return { topicId: 'P4', issueId: issue.id, prId: pr.id, preCrashTurn: before.transition, restoreTransition: after.transition, merged: after.transition === 'merged' };
}

function forgeStoreView() {
  const issues = mockServer.apiGet(`/repos/${REPO}/issues`, { state: 'all' }).map((raw) => normalizeIssue(raw));
  const prs = mockServer.apiGet(`/repos/${REPO}/pulls`, { state: 'all' }).map((raw) => normalizeChangeRequest(raw));
  const notes = [];
  const checks = [];
  const approvals = [];
  for (const it of issues) notes.push(...forge.notes(it.id));
  for (const p of prs) {
    checks.push(...forge.checks(p.id));
    approvals.push(...forge.approvals(p.id));
  }
  return { issues, prs, notes, checks, approvals };
}

function expect(cond, msg, fail) {
  if (!cond) fail.push(msg);
  return cond;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  gitDir = executor.gitDirFor(REPO);
  setup();
  mkdirSync(join(ROOT, '..', 'tmp'), { recursive: true });
  const results = {};
  const fail = [];
  if (args.topics.includes('P1')) results.P1 = await runP1();
  if (args.topics.includes('P2')) results.P2 = await runP2();
  if (args.topics.includes('P3')) results.P3 = await runP3();
  if (args.topics.includes('P4')) results.P4 = await runP4();

  const view = forgeStoreView();
  const report = computeReport(view, { config });

  // 期待値照合 (spec §10 M5 の視点グループと お題 front の期待の突合)
  const r1 = results.P1;
  if (r1) expect(r1.merged, 'P1: merged 着弾 MUST', fail);
  const p2 = results.P2;
  if (p2) {
    expect(p2.planTurn === 'plan', `P2: plan turn 着弾 MUST (got ${p2.planTurn})`, fail);
    expect(p2.children.length === 2, `P2: child 2 起票 MUST (got ${p2.children.length})`, fail);
    for (const c of p2.children) expect(c.merge === 'merged', `P2 child #${c.number}: merged MUST (got ${c.merge})`, fail);
  }
  const p3 = results.P3;
  if (p3) {
    expect(p3.noClause.labels.includes('backlog') && p3.noClause.transition === 'no-claim', `P3a: 無視 MUST (got ${JSON.stringify(p3.noClause)})`, fail);
    expect(String(p3.budget.labels).includes('blocked/budget'), `P3b: blocked/budget MUST (got ${JSON.stringify(p3.budget.labels)})`, fail);
    expect(p3.vacuous.accept === 'failure' || p3.vacuous.vacuity === 'failure', `P3c: accept/vacuity red MUST (got ${JSON.stringify(p3.vacuous)})`, fail);
    expect(String(p3.planBudget.labels).includes('blocked/budget') && p3.planBudget.transition === 'blocked:budget', `P3d: plan blocked/budget MUST (got ${JSON.stringify(p3.planBudget)})`, fail);
  }
  const p4 = results.P4;
  if (p4) expect(p4.merged, `P4: restore 復元 merged MUST (got ${p4.restoreTransition})`, fail);
  expect(report['decomposition-quality'].childDone === (results.P2 ? 2 : 0), 'P2: decomposition childDone MUST', fail);
  expect(report.stability.restores >= 1 && report.stability.residueFreeRate === 1, `P4/metrics: restore・residue-free MUST (got ${JSON.stringify(report.stability)})`, fail);
  expect(report['implementation-success-rate'].firstPass >= 1, `P1: first-pass done MUST (got ${JSON.stringify(report['implementation-success-rate'])})`, fail);
  expect(report.autonomy.topicChain === null || report.autonomy.topicChain.rate === 1, `P2: topicChain rate 1 MUST (got ${JSON.stringify(report.autonomy.topicChain)})`, fail);

  const out = { at: new Date().toISOString(), topics: args.topics, results, report, expectFail: fail };
  writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ groups: { ...report, details: undefined }, expectFail: fail.length, out: args.out }, null, 2));
  if (fail.length) process.exitCode = 1;
}

main().catch((e) => { console.error(`perform: ${e.stack ?? e.message}`); process.exitCode = 1; });


