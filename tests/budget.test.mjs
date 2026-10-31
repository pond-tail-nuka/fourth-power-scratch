import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLedger, parseLedgerLines, normalizeBudgetCfg, overBudget, consumeTurn, sessionOfNote } from '../src/budget.mjs';

const AG = 'fourth-power-bot';
const H = 'pond-tail-nuka';
const CFG = { maxTurns: 8, maxCostUSD: 5, maxTimeSeconds: 2700, maxWallClockSeconds: 7200 };
const claim = (sid, at) => ({ id: `cl-${sid}`, author: AG, body: `claimed ${sid} at ${at}\n<!-- fp:session ${sid} -->`, createdAt: at });
const acct = (id, sid, cost, secs, at, extra = '') => ({ id, author: AG, body: `ready${extra}\nbudget: consumed_usd=${cost} consumed_seconds=${secs} at ${at}\n<!-- fp:session ${sid} -->`, createdAt: at });

test('台帳は勝者 claim からマージ成立まで、同一 session-id の agent 著者 comment のみ算入 (spec §7、M2(a・b・e))', () => {
  const notes = [
    claim('s1', '2026-10-31T10:00:00Z'),
    claim('s2', '2026-10-31T10:00:01Z'), // 敗者 claim (後着)
    acct('c1', 's1', 0.5, 120, '2026-10-31T10:10:00Z'),
    acct('c2', 's1', 0.2, 60, '2026-10-31T10:20:00Z', '\nsubmit re-claim'), // ready 境界で区切らない (submit・re-claim も算入)
    acct('loser', 's2', 9, 900, '2026-10-31T10:30:00Z'), // 敗者セッションは不算入
    { id: 'ver', author: AG, body: `verifier findings\nbudget: consumed_usd=9 consumed_seconds=900 at 2026-10-31T10:40:00Z\nfp-verifier-session: verifier-7`, createdAt: '2026-10-31T10:40:00Z' }, // verifier 別セッション不算入 (§7)
    { id: 'sys', author: AG, body: 'budget: consumed_usd=99 consumed_seconds=9999 at 2026-10-31T10:45:00Z', createdAt: '2026-10-31T10:45:00Z', system: true }, // GitLab system note 不算入
    { id: 'hum', author: H, body: `budget: consumed_usd=9 consumed_seconds=900 at 2026-10-31T10:50:00Z\n<!-- fp:session s1 -->`, createdAt: '2026-10-31T10:50:00Z' }, // 人間 author は agent 著者 MUST で不算入
  ];
  const res = computeLedger({ notes, issueCreatedAt: '2026-10-31T09:00:00Z', nowIso: '2026-10-31T10:50:00Z', agents: [AG] }, CFG);
  assert.equal(res.sessionId, 's1');
  assert.equal(res.turns, 2);
  assert.equal(res.costUSD, 0.7);
  assert.equal(res.seconds, 180);
  assert.equal(res.over, false);
});

test('session-id 模倣 (hidden・可視 marker 不一致) は弾く (spec §7 author 突合)', () => {
  const n = sessionOfNote({ body: 'budget: consumed_usd=1 consumed_seconds=1 at x\nfp-verifier-session: verifier-9\n<!-- fp:session s1 -->' });
  assert.equal(n.forged, true);
  assert.equal(n.verifier, true);
});

test('台帳行と agent comment 数の不一致は MUST fail + 保守概算 (中間クラッシュ、§7)', () => {
  const notes = [
    claim('s1', '2026-10-31T10:00:00Z'),
    acct('c1', 's1', 0.4, 60, '2026-10-31T10:10:00Z'),
    { id: 'c2', author: AG, body: `submit\n<!-- fp:session s1 -->`, createdAt: '2026-10-31T10:15:00Z' }, // 台帳行なしの agent comment (クラッシュで欠落)
  ];
  const res = computeLedger({ notes, agents: [AG], issueCreatedAt: '2026-10-31T10:00:00Z', nowIso: '2026-10-31T10:15:00Z' }, CFG);
  assert.equal(res.over, true);
  assert.ok(res.reason.includes('概算'), `reason: ${res.reason}`);
});

test('cap はどれが先に来ても打ち切り (maxTurns / maxCostUsd / maxTimeSeconds §7)', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => acct(`r${i}`, 's1', 0.63, 30, `2026-10-31T10:${String(i).padStart(2, '0')}:00Z`));
  const claimN = claim('s1', '2026-10-31T09:00:00Z');
  const costFirst = computeLedger({ notes: [claimN, ...rows(8)], agents: [AG], issueCreatedAt: '2026-10-31T08:00:00Z', nowIso: '2026-10-31T09:30:00Z' }, CFG);
  assert.equal(costFirst.over, true);
  assert.ok(costFirst.reason.includes('maxCostUsd'), costFirst.reason);
  const fast = Array.from({ length: 8 }, (_, i) => acct(`t${i}`, 's1', 0.3, 340, `2026-10-31T10:${String(i).padStart(2, '0')}:00Z`));
  const timeFirst = computeLedger({ notes: [claimN, ...fast], agents: [AG], issueCreatedAt: '2026-10-31T08:00:00Z', nowIso: '2026-10-31T09:30:00Z' }, CFG);
  assert.ok(timeFirst.reason.includes('maxTimeSeconds'), timeFirst.reason);
  const maxTurns = computeLedger({ notes: [claimN, ...rows(4)], agents: [AG], issueCreatedAt: '2026-10-31T08:00:00Z', nowIso: '2026-10-31T09:30:00Z' }, { maxTurns: 3, maxCostUsd: 5, maxTimeSeconds: 2700 });
  assert.ok(maxTurns.reason.includes('maxTurns'), maxTurns.reason);
});

test('wall-clock cap (maxWallClockMin 換算) も打ち切り対象 (spec §7 §2.6 §8)', () => {
  const notes = [claim('s1', '2026-10-31T00:00:00Z'), acct('c1', 's1', 0.4, 60, '2026-10-31T00:10:00Z')];
  const res = computeLedger({ notes, agents: [AG], issueCreatedAt: '2026-10-31T00:00:00Z', nowIso: '2026-10-31T03:00:00Z' }, CFG);
  assert.equal(res.over, true);
  assert.ok(res.reason.includes('maxWallClockSeconds'), res.reason);
});

test('config key 正規化: maxCostUsd のみ MUST・maxUsd は違反 throw・cap 欠落も throw (spec §7 §6)', () => {
  assert.equal(normalizeBudgetCfg({ maxTurns: 8, maxCostUSD: 5, maxTimeMin: 45 }).maxTimeSeconds, 2700);
  assert.equal(normalizeBudgetCfg({ maxTurns: 8, maxCostUsd: 5, maxTimeSeconds: 2700 }).maxCostUsd, 5);
  assert.throws(() => normalizeBudgetCfg({ maxTurns: 8, maxUsd: 5, maxTimeSeconds: 2700 }), /maxUsd は使用しない/);
  assert.throws(() => normalizeBudgetCfg({ maxCostUsd: 5, maxTimeSeconds: 2700 }), /cap 欠落/);
});

test('台帳行書式 MUST: `budget: consumed_usd=<num> consumed_seconds=<n> at <iso>` (自由文行は計算しない、§6 §7)', () => {
  assert.deepEqual(parseLedgerLines('budget: consumed_usd=0.5 consumed_seconds=120 at 2026-10-31T10:10:00Z'), [{ turn: 1, costUSD: 0.5, seconds: 120, at: '2026-10-31T10:10:00Z' }]);
  assert.deepEqual(parseLedgerLines('consumed 0.5/120 (概算)\ncost approx $0.5\nbudget: consumed_usd= consumed_seconds=1 at x'), [], 'LLM の自由文・数値なし行は無視 (決定的計算、§6)');
});

test('overBudget は ledger 配列と computeLedger 戻しの両方から cap 判定 (wall-clock opts 込み、§7)', () => {
  assert.equal(overBudget([{ turn: 1, costUSD: 0.6, seconds: 60, at: 'x' }, { turn: 2, costUSD: 4.9, seconds: 60, at: 'y' }], CFG), true);
  assert.equal(overBudget([{ turn: 1, costUSD: 0.6, seconds: 60, at: 'x' }], CFG), false);
  assert.equal(overBudget([{ turn: 1, costUSD: 0.6, seconds: 60, at: 'x' }], { maxTurns: 8, maxCostUsd: 5, maxTimeMin: 45, maxWallClockMin: 60 }, { issueCreatedAt: '2026-10-31T00:00:00Z', nowIso: '2026-10-31T02:00:00Z' }), true);
  assert.equal(overBudget({ ledger: [], turns: 9, costUSD: 0, seconds: 0, estimatedTurns: 0, wallClockSeconds: 0 }, CFG), true);
});

test('consumeTurn は台帳行を追記し cap 超過を返す (turn 末尾 MUST の記録、§7)', () => {
  let r = consumeTurn([], { turn: 1, costUSD: 0.8, seconds: 120, at: '2026-10-31T10:00:00Z' }, CFG);
  assert.equal(r.over, false);
  assert.equal(r.ledger.length, 1);
  r = consumeTurn(r.ledger, { turn: 2, costUSD: 4.5, seconds: 240, at: '2026-10-31T10:10:00Z' }, CFG);
  assert.equal(r.over, true);
  assert.ok(r.reason.includes('maxCostUsd'), r.reason);
  assert.equal(r.ledger.length, 2);
  assert.equal(r.ledger[1].costUSD, 4.5);
});
