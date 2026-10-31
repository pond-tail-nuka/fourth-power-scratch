import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { decide, recheckGate, mergeGate, validateLabelAction, applyLabelAction, rejectsClosesKeyword, loadDecisionFixtures, parseClaims, pickWinner } from '../src/gate.mjs';
import { resumeClaimBody, parseClaimTime } from '../src/claims.mjs';

const FIX = fileURLToPath(new URL('./fixtures/decision-table/', import.meta.url));
const human = 'pond-tail-nuka';

test('決定表 fixture 網羅 (spec §7 全行・contract §12 書式)', () => {
  const fixtures = loadDecisionFixtures(FIX);
  assert.ok(fixtures.length >= 20, `fixture 数が足りない (${fixtures.length})`);
  for (const { name, input, expected } of fixtures) {
    const decision = decide(input);
    assert.deepEqual(decision.labels, expected.labels, `${name}: labels`);
    assert.equal(decision.turn, expected.turn, `${name}: turn`);
    if (expected.exclusiveConflict !== undefined) assert.equal(decision.exclusiveConflict, expected.exclusiveConflict, `${name}: exclusiveConflict`);
    if (expected.mergeAllowed !== undefined) assert.equal(decision.mergeAllowed === true, expected.mergeAllowed, `${name}: mergeAllowed`);
  }
});

test('claim 勝者判定: created_at 先頭 (spec §3)', () => {
  const notes = [
    { id: 'n2', author: 'bot', body: 'claimed sB at 2026-10-31T10:00:10Z\n<!-- fp:session sB -->', createdAt: '2026-10-31T10:00:10Z', issueNumber: 7 },
    { id: 'n1', author: 'bot', body: 'claimed sA at 2026-10-31T10:00:05Z\n<!-- fp:session sA -->', createdAt: '2026-10-31T10:00:05Z', issueNumber: 7 },
  ];
  const { winner } = pickWinner(parseClaims(notes));
  assert.equal(winner.sessionId, 'sA');
});

test('claim 競合: 同一秒は後着を却下し勝者は 1 つのみ (spec §3)', () => {
  const notes = [
    { id: 'n2', author: 'bot', body: 'claimed sB at 2026-10-31T10:00:59.400Z\n  <!-- fp:session sB -->', createdAt: '2026-10-31T10:00:59.400Z', issueNumber: 7 },
    { id: 'n1', author: 'bot', body: 'claimed sA at 2026-10-31T10:00:59.200Z\n<!-- fp:session sA -->', createdAt: '2026-10-31T10:00:59.200Z', issueNumber: 7 },
  ];
  const { winner, losers } = pickWinner(parseClaims(notes));
  assert.equal(winner.sessionId, 'sA');
  assert.equal(losers[0].sessionId, 'sB');
});

test('M2(o): created_at 不一致 (timestamp 偽造) は却下 (spec §3)', () => {
  const notes = [
    { id: 'n1', author: 'bot', body: 'claimed sX at 2020-01-01T00:00:00Z\n<!-- fp:session sX -->', createdAt: '2026-10-31T10:00:00Z', issueNumber: 7 },
    { id: 'n2', author: 'bot', body: 'claimed sY at 2026-10-31T10:00:02Z\n<!-- fp:session sY -->', createdAt: '2026-10-31T10:00:02Z', issueNumber: 7 },
  ];
  const { winner, losers } = pickWinner(parseClaims(notes));
  assert.equal(winner.sessionId, 'sY');
  assert.equal(losers.find((l) => l.sessionId === 'sX'), undefined);
});

test('M2(m): 再 triage scan 窓で旧 claim を除外し、勝者 session-id を継承し header を更新する (created_at 不改変、§3(d) §7)', () => {
  const old = { id: 'n1', author: 'bot', body: 'claimed sOld at 2026-10-30T09:00:00Z\n<!-- fp:session sOld -->', createdAt: '2026-10-30T09:00:00Z', issueNumber: 7 };
  const fresh = { id: 'n2', author: 'bot', body: 'claimed sNew at 2026-10-31T10:00:00Z\n<!-- fp:session sNew -->', createdAt: '2026-10-31T10:00:00Z', issueNumber: 7 };
  const { winner } = pickWinner(parseClaims([old, fresh], { windowStart: '2026-10-31T00:00:00Z' }));
  assert.equal(winner.sessionId, 'sNew');
  const body = resumeClaimBody(winner, '2026-10-31T12:00:00Z');
  assert.match(body, /^claimed sNew at 2026-10-31T10:00:00Z resumed /);
  const updated = { id: 'n3', author: 'bot', body, createdAt: '2026-10-31T12:00:00Z', issueNumber: 7 };
  const r = pickWinner(parseClaims([old, fresh, updated], { windowStart: '2026-10-31T00:00:00Z' }));
  assert.equal(r.winner.sessionId, 'sNew');
  assert.equal(r.winner.created, parseClaimTime(fresh.createdAt), 'created_at は元 claim の値のまま (header 更新で改変しない、§7)');
});

/** forge モック: 記録付きで gate 経路を流す (github provider の gh 呼び出しは使わない、§8 mock provider)。 */
function mockForge(events, overrides = {}) {
  const state = { labels: ['in_review'], prState: 'open', checksPending: false, headSha: 'sha-a', approvals: [{ reviewer: human, sha: 'sha-a' }] };
  const log = [];
  const forge = {
    issue: async () => ({ labels: state.labels }),
    pr: async () => ({ state: state.prState, mergeable: true, headSha: state.headSha, body: 'agent: issue #7' }),
    checks: async () => state.checksPending
      ? [{ name: 'accept', state: 'pending', headSha: state.headSha, issuer: 'fourth-power-bot' }]
      : ['accept', 'lint', 'compile', 'typecheck', 'fmt', 'secret', 'build', 'test', 'test:unit', 'test:accept', 'e2e', 'e2c', 'docs'].map((n) => ({ name: n, state: 'success', headSha: state.headSha, issuer: 'fourth-power-bot' })),
    approvals: async () => state.approvals,
    threads: async () => [],
    protection: async () => ({ requiredApprovals: 1, requiredChecks: ['accept', 'lint', 'compile', 'typecheck', 'fmt', 'secret', 'build', 'test', 'test:unit', 'test:accept', 'e2e', 'e2c', 'docs'] }),
    mergePR: async () => { log.push('merge'); return { ok: true, state: 'merged' }; },
    setLabel: async (_id, l) => { log.push(`set:${l}`); state.labels.push(l); },
    closeIssue: async () => { log.push('close'); },
    postComment: async () => { log.push('comment'); return { noteId: 'c1', createdAt: '2026-10-31T12:00:00Z' }; },
    config: { humanAccounts: [human], botActor: 'fourth-power-bot', requiredApprovals: 1, mergeMethod: 'squash' },
    ...overrides,
  };
  return { forge, log, state };
}

test('マージ成立: mergeGate は done ラベル付与→close の順序 MUST (spec §3)', async () => {
  const { forge, log } = mockForge();
  const snap = async () => ({
    issueId: 'i7', prId: 'p7', headSha: 'sha-a', prState: 'open', mergeable: true, labels: ['in_review'],
    checks: await forge.checks(), approvals: await forge.approvals(), threads: [], protection: await forge.protection(),
    humanAccounts: [human], rejectCloses: false, config: forge.config,
  });
  const res = await mergeGate({ prId: 'p7', forge, snapshot: snap });
  assert.equal(res.merged, true);
  assert.deepEqual(log, ['merge', 'set:done', 'close']);
});

test('マージ拒否: recheck が stale 承認を弾く (spec §8, M2(l・f))', async () => {
  const { forge, log } = mockForge();
  const snap = async () => ({
    issueId: 'i7', prId: 'p7', headSha: 'sha-new', prState: 'open', mergeable: true, labels: ['in_review'],
    checks: [{ name: 'accept', state: 'pending', headSha: 'sha-new', issuer: 'fourth-power-bot' }],
    approvals: [{ reviewer: human, sha: 'sha-old' }], threads: [], protection: await forge.protection(),
    humanAccounts: [human], rejectCloses: false, config: forge.config,
  });
  const res = await mergeGate({ prId: 'p7', forge, snapshot: snap });
  assert.equal(res.merged, false);
  assert.equal(log.includes('merge'), false, 'マージ MUST NOT');
  assert.ok(res.recheck.mismatchReason.includes('pending'));
});

test('recheck は canonical issuer の check 投稿のみ数える (非 canonical は無視、§8)', () => {
  const base = {
    headSha: 'sha-a', prState: 'open', mergeable: true, labels: ['in_review'],
    checks: [
      { name: 'accept', state: 'failure', headSha: 'sha-a', issuer: 'fourth-power-bot' },
      { name: 'unknown', state: 'success', headSha: 'sha-a', issuer: 'some-human-workflow' },
    ],
    approvals: [{ reviewer: human, sha: 'sha-a' }], threads: [],
    protection: { requiredApprovals: 1, requiredChecks: ['accept'] },
    humanAccounts: [human], rejectCloses: false, config: { requiredApprovals: 1 },
  };
  const r = recheckGate(base);
  assert.equal(r.ok, false, 'canonical の failure は無視できない');
});

test('ラベル作用: exempt・privileged・白名簿外は全拒否、勝者 session-id の操作のみ (spec §4.2 §8 §2.6、M2(c))', () => {
  const cfg = { humanAccounts: [human], botActor: 'fourth-power-bot', exemptLabels: ['exempt:ci', 'exempt:docs'], privilegedLabels: ['privileged:merge'] };
  assert.equal(validateLabelAction({ add: ['exempt:ci'], sessionId: 's1', winnerSessionId: 's1' }, cfg).ok, false);
  assert.equal(validateLabelAction({ add: ['privileged:merge'], sessionId: 's1', winnerSessionId: 's1' }, cfg).ok, false);
  assert.equal(validateLabelAction({ add: ['closes-pipeline'], sessionId: 's1', winnerSessionId: 's1' }, cfg).ok, false);
  assert.equal(validateLabelAction({ add: ['blocked/secret'], sessionId: 's1', winnerSessionId: 's1' }, cfg).ok, false);
  // blockAction (blockIssue・理由付き) は白名簿 blocked/* のみ通る (§6)
  assert.equal(validateLabelAction({ blockAction: true, add: ['blocked/secret'], sessionId: 's1', winnerSessionId: 's1' }, cfg).ok, false, 'blockAction に理由が無ければ却下 (§6)');
  assert.equal(validateLabelAction({ blockAction: true, reason: 'budget cap 超過', add: ['blocked/budget'], sessionId: 's1', winnerSessionId: 's1' }, cfg).ok, true);
  assert.equal(validateLabelAction({ blockAction: true, reason: 'x', add: ['exempt:ci'], sessionId: 's1', winnerSessionId: 's1' }, cfg).ok, false, 'blockAction でも exempt 付与は不可 (M2(c): accept author の exempt 利得経路を塞ぐ)');
  // 非勝者 (他セッション) の作用は却下 (§8 介入境界)
  assert.equal(validateLabelAction({ add: ['in_review'], sessionId: 'sX', winnerSessionId: 'sW' }, cfg).ok, false);
  assert.equal(validateLabelAction({ add: ['in_review'], sessionId: 'sW', winnerSessionId: 'sW' }, cfg).ok, true);
  const res = applyLabelAction({ add: ['in_review'], remove: ['claimed'], sessionId: 'sW', winnerSessionId: 'sW' }, cfg);
  assert.deepEqual(res, { ok: true, reason: null, add: ['in_review'], remove: ['claimed'] });
});

test('PR 本文 Closes keyword 拒否 (spec §3)', () => {
  assert.equal(rejectsClosesKeyword('Closes #12'), true);
  assert.equal(rejectsClosesKeyword('Fixes issue #12'), true);
  assert.equal(rejectsClosesKeyword('agent: issue #12 参照'), false);
});
