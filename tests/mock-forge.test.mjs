// Mock forge provider end-to-end (spec §11 mock bullet / contract §3・§10・§12 fixture shape).
// Issue 作成 → label → comment (created_at 正規値) → branch → PR → check post →
// mergeable 判定 → merge → done close の mock 完結シーケンス + conformance fixture shape
// (GET 応答 JSON) の read 関数検証。runner.mjs は注入スタブ (contract §10 — executor は
// runner を引数で受ける。runner.mjs は import しない)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as forge from '../src/forge.mjs';
import * as store from './mock-forge/store.mjs';
import * as mockServer from './mock-forge/mockServer.mjs';
import * as executor from './mock-forge/executor.mjs';

const REPO = mockServer.DEFAULT_REPO;
const HUMAN = 'pond-tail-nuka';
const BOT = mockServer.BOT;

const ACCEPT_BODY = [
  'spec §2.5 を満たす',
  'accept:A1',
  '```acceptBlock',
  '{"accept":[{"id":"A1","kind":"test","cmd":"node --test ci/accept/A1.test.mjs"}],"scope":["src/noop.mjs"],"refs":["spec §2.5"]}',
  '```',
].join('\n');

/** runner.mjs のスタブ注入 (contract §10 runChecks の呼出形状のまま全 check success を返す). */
function greenRunner({ checks, workDir, acceptBlock, meta }) {
  assert.ok(workDir, 'runChecks は work clone を受ける');
  assert.equal(meta.prHeadSha.length, 40, 'meta.prHeadSha');
  return checks.map((name) => ({ name, state: 'success', headSha: '', issuer: BOT }));
}

beforeEach(() => {
  executor.setupMock({ repoKey: REPO });
});

test('readConfig: framework repo の docs/governance を provider API read で返す', () => {
  const cfg = forge.readConfig();
  assert.equal(cfg.botActor, BOT);
  assert.equal(cfg.provider, 'mock');
  assert.equal(cfg.mergeMethod, 'squash');
  assert.equal(cfg.acceptJobName, 'accept');
  assert.equal(forge.activeProviderName(), 'mock');
});

test('mock 完結シーケンス: Issue → label → comment → branch → PR → check → mergeable → merge → done close', async () => {
  const setup = executor.setupMock({ repoKey: REPO });
  const issue = forge.draftIssue({
    repo: REPO,
    title: 'mock loop: forge noop',
    body: ACCEPT_BODY,
    labels: ['backlog'],
    author: HUMAN,
  });
  assert.equal(issue.state, 'open');
  assert.equal(issue.author, HUMAN);
  assert.match(issue.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // 状態ラベルの排他 (§1 — backlog → claimed → in_review、旧状態ラベルは除去).
  forge.setLabel(issue.id, 'claimed');
  assert.deepEqual(forge.issue(issue.id).labels, ['claimed']);
  forge.setLabel(issue.id, 'in_review');
  assert.deepEqual(forge.issue(issue.id).labels, ['in_review']);
  forge.removeLabel(issue.id, 'in_review');
  forge.setLabel(issue.id, 'claimed');

  // comment — created_at は決定論 clock の正規値 (秒刻み)。§3 の突合: 一致は claim 成立、不一致は却下.
  const at = store.clock().peek();
  const claim = forge.postComment(issue.id, `claimed sess-1 at ${at}\n<!-- fp:session sess-1 -->`, { author: BOT });
  assert.match(claim.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(store.createdAtMatchesBodyAt(claim.createdAt, `claimed sess-1 at ${at}\n<!-- fp:session sess-1 -->`), true);
  assert.equal(store.createdAtMatchesBodyAt(claim.createdAt, 'claimed x at 2020-01-01T00:00:00Z\n<!-- fp:session x -->'), false);
  assert.equal(forge.commentCreatedAt(claim.noteId), claim.createdAt);
  const winner = store.pickClaimWinner(forge.notes(issue.id));
  assert.equal(store.parseClaimBody(winner.winner.body).sessionId, 'sess-1');
  assert.equal(winner.rejected.length, 0);

  // branch push (remote 名 mock の bare repo ref、§3) — §7 の branch 規約 llm/issue-<N>-<slug>.
  const branch = 'llm/issue-1-noop-impl';
  executor.writeAndPush(REPO, branch, { 'src/noop.mjs': 'export const noop = 1;\n' }, 'implement noop', setup.gitDir);
  assert.equal(forge.prsForIssue(REPO, 1).length, 0, 'PR 作成前は claimed (PR 無し)');

  // PR (draft) — base main への direct push 拒否 (§2 不変条件 2 の写し).
  assert.throws(() => forge.createPR({ repo: REPO, head: 'main', base: 'main', title: 'bad' }), /direct push|banned/);
  assert.throws(() => forge.createPR({ repo: REPO, head: 'hotfix', base: 'main', title: 'bad' }), /llm\/issue-/);
  const pr = forge.createPR({ repo: REPO, head: branch, base: 'main', title: 'feat: noop', body: 'spec §2.5', draft: true });
  assert.equal(pr.draft, true);
  assert.equal(pr.state, 'open');
  const head = forge.branchSha(pr.id);
  assert.match(head, /^[0-9a-f]{40}$/);

  // mergeable 判定 (§11 の写し): head が base より先行 → clean・mergeable true.
  assert.equal(forge.prJson(pr.id).mergeable, true);
  assert.equal(forge.prJson(pr.id).mergeable_state, 'clean');

  // check post: executor が runChecks を注入実行し、Check を store に post (issuer=botActor).
  assert.deepEqual(forge.checks(pr.id), []);
  const posted = await executor.runChecksOnPR({ runner: greenRunner, repoKey: REPO, prId: pr.id, gitDir: setup.gitDir });
  assert.ok(posted.length >= mockServer.REQUIRED_CHECKS.length + 1);
  assert.ok(posted.every((c) => c.issuer === BOT), 'issuer は canonical bot (§8 の正規化)');
  const readChecks = forge.checks(pr.id);
  assert.ok(readChecks.some((c) => c.name === 'accept' && c.state === 'success'));
  assert.ok(readChecks.every((c) => c.headSha === head));

  // ready + 人間承認 (§8 tier high — humanAccounts 由来の承認 MUST).
  forge.markPRReady(pr.id);
  forge.approvePR(pr.id, HUMAN, head);
  assert.deepEqual(forge.approvals(pr.id), [{ reviewer: HUMAN, sha: head }]);
  assert.equal(forge.prsForIssue(REPO, 1)[0].draft, false);

  // merge — store の PR merged 記録 + bare repo base branch fast-forward (executor 側、§3).
  const merged = forge.mergePR(pr.id, 'squash');
  assert.equal(merged.merged, true);
  assert.equal(forge.normalizeChangeRequest(forge.prJson(pr.id)).state, 'merged');
  assert.equal(forge.prsForIssue(REPO, 1).length, 0, 'マージ済みは scan から消える');
  assert.ok(mockServer.lastMergeResult().commitSha, 'git merge commit sha が記録される');
  assert.equal(forge.prJson(pr.id).mergeable, null, 'マージ後は unknown (GitHub の写し)');

  // done close (done ラベル → close、§3 の順序)。PR 本文に `Closes #N` keyword は使わない (§3 — gate scan 対象).
  forge.setLabel(issue.id, 'done');
  forge.closeIssue(issue.id);
  const closed = forge.issue(issue.id);
  assert.equal(closed.state, 'closed');
  assert.deepEqual(closed.labels, ['done']);
});

test('conformance fixture shape: GET 応答 JSON (issue/PR/comment/check/protection/contents) は GitHub REST と同一キーを持つ', () => {
  executor.setupMock({ repoKey: REPO });
  const issue = forge.draftIssue({ repo: REPO, title: 'fixture shape', body: 'spec §11', labels: ['backlog'], author: HUMAN });
  const raw = mockServer.apiGet(`repos/${REPO}/issues/${issue.number}`);
  assert.equal(raw.repository.full_name, REPO);
  assert.ok(Array.isArray(raw.labels) && typeof raw.labels[0] === 'object' && 'name' in raw.labels[0]);
  assert.equal(raw.user.login, HUMAN);
  for (const key of ['created_at', 'updated_at', 'body', 'state', 'number', 'title']) assert.ok(key in raw, key);

  forge.postComment(issue.id, `claimed s at ${store.clock().peek()}\n<!-- fp:session s -->`, { author: BOT });
  const rawComment = mockServer.apiGet(`repos/${REPO}/issues/${issue.number}/comments`)[0];
  for (const key of ['id', 'body', 'user', 'created_at', 'updated_at']) assert.ok(key in rawComment, key);
  assert.ok(rawComment.issue_url.includes(`repos/${REPO}/issues/${issue.number}`));

  executor.writeAndPush(REPO, 'llm/issue-1-fixture', { 'src/x.mjs': 'export const x = 2;\n' }, 'feat');
  const pr = forge.createPR({ repo: REPO, head: 'llm/issue-1-fixture', base: 'main', title: 't', body: 'spec §11' });
  const rawPull = mockServer.apiGet(`repos/${REPO}/pulls/${pr.number}`);
  assert.ok('base' in rawPull && 'ref' in rawPull.base && 'head' in rawPull && 'sha' in rawPull.head);
  for (const key of ['mergeable', 'mergeable_state', 'draft', 'state', 'merged_at', 'number', 'labels']) assert.ok(key in rawPull, key);

  mockServer.apiSend('POST', `repos/${REPO}/commits/${pr.headSha}/check-runs`, {}, { name: 'accept', status: 'completed', conclusion: 'success' });
  const rawChecks = mockServer.apiGet(`repos/${REPO}/commits/${pr.headSha}/check-runs`);
  assert.ok('total_count' in rawChecks && Array.isArray(rawChecks.check_runs));
  assert.ok('status' in rawChecks.check_runs[0] && 'app' in rawChecks.check_runs[0]);

  const rawProt = mockServer.apiGet(`repos/${REPO}/branches/main/protection`);
  assert.ok('required_status_checks' in rawProt && 'required_pull_request_reviews' in rawProt && 'enforce_admins' in rawProt);
  const prot = forge.protection(REPO);
  assert.ok(prot.requiredChecks.includes('accept'));
  assert.ok(prot.requiredChecks.includes('accept-immutable'));
  assert.equal(prot.enforceAdmins, true);
  assert.equal(prot.dismissStaleReviews, true);

  const rawContents = mockServer.apiGet(`repos/${mockServer.FRAMEWORK_REPO}/contents/docs/governance/config.json`);
  assert.equal(rawContents.encoding, 'base64');
  assert.ok('content' in rawContents && 'path' in rawContents && 'name' in rawContents);
  assert.deepEqual(JSON.parse(mockServer.decodeContentJson(rawContents)).botActor, BOT);
});

test('mergeable 判定: 衝突は dirty でマージを阻止する (§7 の決定表入力 — dirty → rebase turn)', async () => {
  const setup = executor.setupMock({ repoKey: REPO });
  const issueA = forge.draftIssue({ repo: REPO, title: 'merge first', body: 'spec §7', author: HUMAN });
  const baseSha = executor.revParse(REPO, 'main', setup.gitDir);
  executor.writeAndPush(REPO, 'llm/issue-1-conflict-a', { 'src/c.mjs': 'export const v = 1;\n' }, 'feat: a', setup.gitDir);
  const prA = forge.createPR({ repo: REPO, head: 'llm/issue-1-conflict-a', base: 'main', title: 'a', body: 'spec §7' });
  forge.approvePR(prA.id, HUMAN, prA.headSha);
  await executor.runChecksOnPR({ runner: greenRunner, repoKey: REPO, prId: prA.id, gitDir: setup.gitDir });
  forge.mergePR(prA.id, 'squash');
  assert.notEqual(executor.revParse(REPO, 'main', setup.gitDir), baseSha, 'マージで main が進む (executor の fast-forward)');

  // 衝突 branch: base が進んだ後の競合 — 旧 base (baseSha) から分岐した branch を作る (§11 の写し dirty).
  const workDir = executor.createWorkClone(REPO, setup.gitDir, baseSha);
  const conflictBranch = 'llm/issue-1-conflict-b';
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(`${workDir}/src`, { recursive: true });
  writeFileSync(`${workDir}/src/c.mjs`, 'export const v = 2;\n');
  executor.commitAndPushBranch(workDir, REPO, conflictBranch, 'feat: b (conflict)', setup.gitDir);
  executor.discardWorkClone(workDir);
  forge.setLabel(issueA.id, 'in_review');
  const prB = forge.createPR({ repo: REPO, head: conflictBranch, base: 'main', title: 'b', body: 'spec §7' });
  const raw = forge.prJson(prB.id);
  assert.equal(raw.mergeable_state, 'dirty');
  assert.equal(raw.mergeable, false);
  await assert.rejects(async () => forge.mergePR(prB.id), /mergeable_state dirty|409/);
});

test('CI green でない PR はマージできない (invariant 4 — マージ可能性は CI が決める、pending/欠落/red で阻止)', async () => {
  const setup = executor.setupMock({ repoKey: REPO });
  forge.draftIssue({ repo: REPO, title: 'ci red', body: 'spec §4.3', author: HUMAN });
  executor.writeAndPush(REPO, 'llm/issue-1-red', { 'src/r.mjs': 'export const r = 1;\n' }, 'feat', setup.gitDir);
  const pr = forge.createPR({ repo: REPO, head: 'llm/issue-1-red', base: 'main', title: 't', body: 'spec §4.3' });
  await assert.rejects(async () => forge.mergePR(pr.id), /required check|409/);
  const redRunner = ({ checks }) => checks.map((name) => ({ name, state: name === 'accept' ? 'failure' : 'success', headSha: '', issuer: BOT }));
  await executor.runChecksOnPR({ runner: redRunner, repoKey: REPO, prId: pr.id, gitDir: setup.gitDir });
  assert.ok(forge.checks(pr.id).some((c) => c.name === 'accept' && c.state === 'failure'));
  forge.approvePR(pr.id, HUMAN, pr.headSha);
  await assert.rejects(async () => forge.mergePR(pr.id), /required check accept|409/);
});

test('open review thread はマージを阻止し、resolve で解消する (§8 の review-threads 写し)', async () => {
  const setup = executor.setupMock({ repoKey: REPO });
  forge.draftIssue({ repo: REPO, title: 'thread loop', body: 'spec §8', author: HUMAN });
  executor.writeAndPush(REPO, 'llm/issue-1-thread', { 'src/t.mjs': 'export const t = 1;\n' }, 'feat', setup.gitDir);
  const pr = forge.createPR({ repo: REPO, head: 'llm/issue-1-thread', base: 'main', title: 't', body: 'spec §8' });
  forge.approvePR(pr.id, HUMAN, pr.headSha);
  await executor.runChecksOnPR({ runner: greenRunner, repoKey: REPO, prId: pr.id, gitDir: setup.gitDir });
  const thread = forge.addReviewThread(pr.id, 'finding: spec に反する', { author: 'verifier-bot' });
  assert.equal(forge.threads(pr.id).length, 1);
  assert.equal(forge.threads(pr.id)[0].resolved, false);
  await assert.rejects(async () => forge.mergePR(pr.id), /open review thread|409/);
  forge.resolveThread(pr.id, thread.id, true);
  assert.equal(forge.threads(pr.id)[0].resolved, true);
  const merged = forge.mergePR(pr.id);
  assert.equal(merged.merged, true);
});

test('scanNeedsInfo: needs-info + cohort、peer:answer 除外、bare scan と別経路 (contract §2)', () => {
  executor.setupMock({ repoKey: REPO });
  const a = forge.draftIssue({ repo: REPO, title: 'needs fast', body: 'spec §2.6', labels: ['needs-info', 'cohort:fast'], author: HUMAN });
  const b = forge.draftIssue({ repo: REPO, title: 'needs typical', body: 'spec §2.6', labels: ['needs-info', 'cohort:typical', 'peer:answer'], author: HUMAN });
  const c = forge.draftIssue({ repo: REPO, title: 'plain', body: 'spec §2.6', labels: ['backlog'], author: HUMAN });
  const needs = forge.scanNeedsInfo(REPO);
  assert.deepEqual(needs.map((i) => i.id), [a.id]);
  assert.equal(needs.length, 1);
  assert.equal(forge.scanIssues(REPO, { state: 'open' }).length, 3);
  assert.ok(!needs.some((i) => i.id === b.id) && !needs.some((i) => i.id === c.id));
});

test('claim 突合・勝者判定 (spec §3 — created_at が正、同一秒は競合で後着却下)', () => {
  executor.setupMock({ repoKey: REPO });
  const issue = forge.draftIssue({ repo: REPO, title: 'claim race', body: 'spec §3', author: HUMAN });
  const at = store.clock().peek();
  const first = forge.postComment(issue.id, `claimed sess-a at ${at}\n<!-- fp:session sess-a -->`, { author: BOT });
  assert.equal(store.createdAtMatchesBodyAt(first.createdAt, `claimed sess-a at ${at}\n<!-- fp:session sess-a -->`), true);
  // 偽造 (本文時刻をずらす) は突合で却下 — created_at が正 (§3).
  assert.equal(store.createdAtMatchesBodyAt(first.createdAt, `claimed sess-a at 1999-01-01T00:00:00Z\n<!-- fp:session sess-a -->`), false);
  const forged = forge.postComment(issue.id, 'claimed sess-b at 1999-01-01T00:00:00Z\n<!-- fp:session sess-b -->', { author: 'other' });
  assert.notEqual(forged.createdAt, first.createdAt, '後着は秒刻みで進む');
  const valid = forge.notes(issue.id).filter((n) => store.createdAtMatchesBodyAt(n.createdAt, n.body));
  assert.equal(valid.length, 1, '突合通過は勝者候補 1 本のみ');
  assert.equal(store.pickClaimWinner(valid).winner.id, first.noteId);
  // 同一秒ケースは競合 — 先着 1 本のみ勝ち、後着は却下 (fixture で合成).
  const T = '2026-01-01T00:00:30Z';
  const tie = [
    { id: `${REPO}#9/1`, body: `claimed a at ${T}\n<!-- fp:session a -->`, createdAt: T },
    { id: `${REPO}#9/2`, body: `claimed b at ${T}\n<!-- fp:session b -->`, createdAt: T },
  ];
  const { winner, rejected } = store.pickClaimWinner(tie);
  assert.equal(winner.id, `${REPO}#9/1`);
  assert.deepEqual(rejected.map((n) => n.id), [`${REPO}#9/2`]);
});

test('comment edit は created_at を変えない (§3 の fixture 回帰 — 書き直しは新 comment のみ・claim comment edit は禁止の写し)', () => {
  executor.setupMock({ repoKey: REPO });
  const issue = forge.draftIssue({ repo: REPO, title: 'edit regression', body: 'spec §3', author: HUMAN });
  const at = store.clock().peek();
  const { noteId, createdAt } = forge.postComment(issue.id, `claimed s at ${at}\n<!-- fp:session s -->`, { author: BOT });
  const rawEdit = mockServer.apiSend('PATCH', `repos/${REPO}/issues/comments/${Number(noteId.split('/').pop())}`, {}, { body: ' edited body ' });
  assert.equal(rawEdit.created_at, createdAt, 'created_at は改変しない (§7 の復元 header も同じ)');
  assert.equal(forge.commentCreatedAt(noteId), createdAt);
  mockServer.apiSend('DELETE', `repos/${REPO}/issues/comments/${rawEdit.id}`);
  assert.equal(forge.notes(issue.id).length, 0);
});

test('復元 claim comment (resume header) は家系突合で通過し、勝者を上書きしない (§3/§7 — orchestrator の復元が mock で失われない)', () => {
  executor.setupMock({ repoKey: REPO });
  const issue = forge.draftIssue({ repo: REPO, title: 'resume lineage', body: 'spec §3 §7', author: HUMAN });
  const first = forge.postComment(issue.id, `claimed sess-a at ${store.clock().peek()}\n<!-- fp:session sess-a -->`, { author: BOT });
  const at = first.createdAt;
  store.clock().advance();
  const resumedIso = store.clock().peek();
  const resumeBody = `claimed sess-a at ${at} resumed ${resumedIso}\n<!-- fp:session sess-a -->`;
  const resume = forge.postComment(issue.id, resumeBody, { author: BOT });
  // 復元 comment は新しい comment だが header の at が元 claim の created_at を保持 — 厳密一致 (created_at は resume 時刻) では §3 の偽装と見なされ却下される。家系なので通過する MUST 挙動 (§7).
  assert.equal(store.createdAtMatchesBodyAt(resume.createdAt, resumeBody), true, 'resume header は却下しない (created_at ≠ at でも家系)');
  assert.ok(resume.createdAt > at, '復元 comment の created_at は後刻 (header の at とは違う)');
  const notes = forge.notes(issue.id).filter((n) => store.parseClaimBody(n.body) !== null);
  assert.equal(notes.length, 2);
  const { winner, rejected } = store.pickClaimWinner(notes);
  assert.equal(store.parseClaimBody(winner.body).kind, 'claim', '元 claim が勝者 (復元 comment が後着で上書きしない)');
  assert.equal(winner.createdAt, at);
  assert.deepEqual(rejected, [], '復元 comment は却下されない (家系証拠)。元 claim 勝者で同一 session は集約');
  // 元 claim が失われた想定 (record 消失): 復元 comment 単独が claim 証拠として成立する
  const rawWinner = mockServer.apiGet(`repos/${REPO}/issues/${issue.number}/comments`).find((c) => store.parseClaimBody(c.body).kind === 'claim');
  mockServer.apiSend('DELETE', `repos/${REPO}/issues/comments/${rawWinner.id}`);
  const again = store.pickClaimWinner(forge.notes(issue.id).filter((n) => store.parseClaimBody(n.body) !== null));
  assert.equal(store.parseClaimBody(again.winner.body).kind, 'resume', '復元 comment だけで勝者が立つ (§7 復元が mock 上で勝者を失わない)');
  assert.equal(store.createdAtMatchesBodyAt(again.winner.createdAt, again.winner.body), true);
});

test('runChecksOnPR は runner に mock の可視状態を注入する (Runner 側 fail-closed meta — §4.1 全 check 常に実行)', async () => {
  const setup = executor.setupMock({ repoKey: REPO });
  const issue = forge.draftIssue({
    repo: REPO, title: 'meta injection', author: HUMAN, labels: ['needs-info'],
    body: 'spec §4\n```acceptBlock\n{"target":"src/x.mjs","checks":["accept"]}\n```',
  });
  executor.writeAndPush(REPO, 'llm/issue-1-meta', { 'src/x.mjs': 'export const x = 1;\n' }, 'feat', setup.gitDir);
  const pr = forge.createPR({ repo: REPO, head: 'llm/issue-1-meta', base: 'main', title: 'meta', body: 'spec §4.1' });
  forge.approvePR(pr.id, HUMAN, pr.headSha);
  let captured = null;
  const runner = (opts) => {
    captured = opts;
    return opts.checks.map((name) => ({ name, state: 'success', headSha: '', issuer: BOT }));
  };
  const posted = await executor.runChecksOnPR({ runner, repoKey: REPO, prId: pr.id, gitDir: setup.gitDir });
  assert.ok(captured, 'runner が呼ばれる');
  assert.ok(Array.isArray(captured.checks) && captured.checks.includes('accept'));
  assert.equal(captured.meta.prHeadSha, pr.headSha);
  assert.ok(captured.meta.frameworkConfig && Array.isArray(captured.meta.frameworkConfig.humanAccounts));
  assert.deepEqual(captured.meta.projectState.labels, forge.readConfig().labels, 'projectState.labels は repo の label 定義 (config.labels と同一 — Issue ラベルではない)');
  assert.ok(captured.meta.projectState.protection.requiredChecks.includes('accept'));
  assert.ok(Array.isArray(captured.meta.projectState.workflowNames));
  assert.ok(captured.meta.approvals.some((a) => a.reviewer === HUMAN && a.sha === pr.headSha), '承認 1 回が meta に乗る (config-consistency 用)');
  assert.deepEqual(captured.meta.threads, [], 'open thread なし — review-threads green');
  assert.ok(captured.meta.changedPaths.includes('src/x.mjs'), 'changedPaths に diff が乗る');
  assert.equal(typeof captured.meta.prBody, 'string');
  assert.ok(Array.isArray(captured.meta.peerQueryBodies));
  assert.equal(captured.acceptBlock?.target, 'src/x.mjs', 'acceptBlock は Issue 本文から復元される');
  assert.ok(posted.every((c) => c.state === 'success'));
  assert.ok(forge.checks(pr.id).some((c) => c.name === 'accept' && c.state === 'success'));
});

test('repo label 定義 (bootstrap materialize 写し) — GET/POST/DELETE と config.labels 突合 (§8 config-consistency の mock 対応)', () => {
  executor.setupMock({ repoKey: REPO });
  const defs = forge.repoLabels(REPO);
  assert.deepEqual(defs, forge.readConfig().labels, 'repo 定義は framework config.labels と同一 (§4.1 の突合対象)');
  const raw = mockServer.apiGet(`repos/${REPO}/labels`);
  assert.ok(Array.isArray(raw) && raw.every((l) => typeof l === 'object' && 'name' in l && 'color' in l));
  const created = mockServer.apiSend('POST', `repos/${REPO}/labels`, {}, { name: 'custom:def', color: 'aa55aa' });
  assert.equal(created.name, 'custom:def');
  assert.equal(created.color, 'aa55aa');
  assert.ok(forge.repoLabels(REPO).includes('custom:def'));
  mockServer.apiSend('DELETE', `repos/${REPO}/labels/custom:def`);
  assert.ok(!forge.repoLabels(REPO).includes('custom:def'));
  assert.equal(forge.repoLabels(REPO).length, defs.length, '削除後は定義一覧が config ラベル集合のまま保たれる');
});

