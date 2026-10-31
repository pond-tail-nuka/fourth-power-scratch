// tests/conformance.test.mjs — conformance suite 骨格 (spec §6: recorded fixture への決定論的判定、しきい値 99/100 は suite 側実装)。
// src/gate.mjs / src/budget.mjs (本実装) は contract 署名突合で消費、無ければ tests/_stubs/ にフォールバック (本物への差替は親が統合時)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTurn } from '../src/stubSeat.mjs';
import config from '../docs/governance/config.json' with { type: 'json' };

const FIXTURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'seat');

async function loadModule(realName, stubName, shapeOk, probe) {
  try {
    const mod = await import(new URL(`../src/${realName}`, import.meta.url).href);
    if (shapeOk(mod)) {
      probe(mod); // 実行 probe (未実装・途中状態の例外はスタブへ) — 完成後は本実装がそのまま使われる
      return { mod, source: `src/${realName}` };
    }
  } catch { /* 本実装なし・shape 不一致・実行 probe 失敗 → スタブへフォールバック */ }
  const mod = await import(new URL(`./_stubs/${stubName}`, import.meta.url).href);
  return { mod, source: `tests/_stubs/${stubName}` };
}

const gate = await loadModule('gate.mjs', 'gate.mjs', (m) => typeof m.decide === 'function', (m) => {
  const r = m.decide({ labels: ['backlog'], prState: 'none', ciState: 'none', threads: 0, approvals: [], budget: { over: false } });
  if (!Array.isArray(r?.labels)) throw new Error('decide shape');
});
const budget = await loadModule('budget.mjs', 'budget.mjs', (m) => typeof m.consumeTurn === 'function' && typeof m.overBudget === 'function', (m) => {
  const probeBudget = { maxTurns: 8, maxCostUSD: 5, maxTimeMin: 45 };
  const r = m.consumeTurn([], { turn: 1, costUSD: 0.1, seconds: 10, at: '2026-01-01T00:00:00Z' }, probeBudget, '2026-01-01T00:00:10Z');
  if (!Array.isArray(r?.ledger) || typeof r.over !== 'boolean') throw new Error('consumeTurn shape');
});

// plan turn 打切り上限: config.json の planBudgetMaxTurns (GateLoop 提案 key、追加検討中) — 未設定なら suite が cap=2 を決定論で既定 (spec §7: plan turn の budget は既存計算をそのまま使う)。
const PLAN_MAX_TURNS = config.planBudgetMaxTurns ?? 2;
const PLAN_BUDGET = {
  maxTurns: PLAN_MAX_TURNS,
  maxCostUSD: config.budget.maxCostUSD,
  maxTimeMin: PLAN_MAX_TURNS * config.turnTimeoutMin,
};

async function readFixture(name) {
  return JSON.parse(await readFile(join(FIXTURE_DIR, name), 'utf8'));
}

async function collect(gen) {
  const events = [];
  for await (const e of gen) events.push(e);
  return events;
}

const usageOf = (events) => events.filter((e) => e.type === 'usage');

// contract §12 書式の schema 突合: [{type:"session",sessionId},{type:"text"},...,{type:"usage",costUSD,turns}] — turns は usage の turn キー (1 号から連番)。
function schemaErrors(events) {
  const errs = [];
  if (!Array.isArray(events) || events.length === 0) return ['fixture is not a non-empty event array'];
  const sessions = events.filter((e) => e && e.type === 'session');
  const first = events[0];
  if (sessions.length !== 1) errs.push('exactly one session event required');
  if (first?.type !== 'session' || typeof first.sessionId !== 'string' || first.sessionId.length === 0) {
    errs.push('first event must be {type:"session", sessionId: non-empty string}');
  }
  const texts = events.filter((e) => e && e.type === 'text');
  if (texts.length === 0) errs.push('no text events');
  for (const e of texts) if (typeof e.text !== 'string' || e.text.length === 0) errs.push('text event lacks non-empty text');
  if (events[events.length - 1]?.type !== 'usage') errs.push('last event must be usage');
  const usages = usageOf(events);
  if (usages.length === 0) errs.push('no usage events');
  for (const e of usages) {
    for (const k of ['costUSD', 'seconds', 'turn']) {
      if (typeof e[k] !== 'number' || !Number.isFinite(e[k]) || e[k] < 0) errs.push(`usage event numeric field ${k} missing/negative`);
    }
  }
  if (usages.some((e, i) => e.turn !== i + 1)) errs.push('usage turn keys must be consecutive from 1');
  return errs;
}

// suite 骨格の scenario 定義 (録画 fixture × 台帳・決定表シナリオ)。
// 期待ラベルは spec の正式名のみを突合 (GateLoop の行名は GateLoop fixture 側で固定 — conformance 側はラベル不変と遷移先のみ主張)。
// overAt: usage の turn 番号 → 台帳 over 期待値 (false は打ち切り前)。
const SUITE = {
  'p1-green-implement.json': {
    budgetCfg: () => config.budget,
    overAt: { 1: false },
    gate: (budgetState) => ({ labels: ['claimed'], prState: 'draft', ciState: 'pending', threads: 0, approvals: [], headSha: 'rec-head-p1a1b2c3', budget: budgetState }),
    gateCheck: (t) => assert.deepEqual(t.labels, ['claimed'], 'turn 行はラベルを動かさない (claimed 維持)'),
  },
  'p2-plan.json': {
    budgetCfg: () => PLAN_BUDGET,
    overAt: { 1: false },
    gate: (budgetState) => ({ labels: ['backlog'], prState: 'none', ciState: 'none', threads: 0, approvals: [], budget: budgetState, planHeader: true }),
    // お題 Issue は plan turn のみ (claim MUST NOT、spec §5) — decide は plan: を状態ラベル遷移に使わない。
    // 権限ラベル plan:approved/rejected の付与は人間・bootstrap のみ (spec §4.2 §8) — decide の出力に混在して MUST NOT。
    gateCheck: (t) => {
      assert.ok(!t.labels.includes('plan:approved') && !t.labels.includes('plan:rejected'), 'decide は privileged label を付与しない');
      assert.ok(!t.labels.includes('done'), 'plan turn で done 遷移しない');
      assert.ok(!t.labels.includes('claimed'), 'お題は claim しない');
    },
  },
  'p2-child-implement.json': {
    budgetCfg: () => config.budget,
    overAt: { 1: false, 2: false, 3: false, 4: false },
    gate: (budgetState) => ({
      labels: ['in_review'], prState: 'open', ciState: 'green', threads: 0,
      approvals: [{ reviewer: 'pond-tail-nuka', sha: 'rec-head-p2b7c9d1' }], headSha: 'rec-head-p2b7c9d1',
      tierRequired: 'high', human: config.humanAccounts, budget: budgetState,
    }),
    // green + 承認充足行 (spec §7): ラベルは in_review 維持 (done はマージ成立後、§3) — decide 時点では done を数えない。
    gateCheck: (t, mod) => {
      assert.deepEqual(t.labels, ['in_review'], '承認充足でも in_review 維持');
      if ('mergeAllowed' in t) assert.equal(t.mergeAllowed, true, 'merge 可行 (merge 実行 MUST は §8 再照合側)');
      void mod;
    },
  },
  'p3-budget-exceeded.json': {
    budgetCfg: () => config.budget,
    overAt: { 8: false, 9: true },
    gate: (budgetState) => ({ labels: ['in_review'], prState: 'open', ciState: 'red', threads: 0, approvals: [], budget: budgetState }),
    // budget 超過行は最優先 (spec §7): blockIssue blocked/budget (新ラベルを置かない)。
    gateCheck: (t) => assert.deepEqual(t.labels, ['blocked/budget']),
  },
  'p3-plan-budget-exceeded.json': {
    budgetCfg: () => PLAN_BUDGET,
    overAt: { 2: false, 3: true },
    gate: (budgetState) => ({ labels: ['backlog'], prState: 'draft', ciState: 'none', threads: 0, approvals: [], budget: budgetState, planHeader: true }),
    gateCheck: (t) => assert.deepEqual(t.labels, ['blocked/budget'], 'plan turn cap 超過も blocked/budget (spec §7)'),
  },
};

async function fixtureNames() {
  return (await readdir(FIXTURE_DIR)).filter((n) => n.endsWith('.json')).sort();
}

function replayLedger(events, budgetCfg) {
  let ledger = [];
  const overByTurn = {};
  for (const u of usageOf(events)) {
    const r = budget.mod.consumeTurn(ledger, u, budgetCfg, u.at ?? '2026-10-31T09:00:00Z');
    ledger = r.ledger;
    overByTurn[u.turn] = r.over;
  }
  return { ledger, overByTurn };
}

const lastTurn = (events) => Math.max(...usageOf(events).map((u) => u.turn));

test('conformance 骨格: 本実装優先ロード (src が無ければ tests/_stubs にフォールバック)', () => {
  assert.equal(typeof gate.mod.decide, 'function', 'gate decide');
  assert.equal(typeof budget.mod.consumeTurn, 'function', 'budget consumeTurn');
  assert.equal(typeof budget.mod.overBudget, 'function', 'budget overBudget');
});

test('seat 録画 fixture = SUITE 網羅 (fixture 期待一致で網羅 — P1/P2/P3 群)', async () => {
  const names = await fixtureNames();
  assert.deepEqual(names, [...Object.keys(SUITE)].sort(), 'P1/P2/P3 の録画 fixture が SUITE と一致');
});

test('しきい値 1: 録画 fixture の schema 遵守 ≥ 99% (決定論なので 100% が実質の下限、spec §6)', async () => {
  const names = await fixtureNames();
  const failures = [];
  for (const name of names) {
    const errs = schemaErrors(await readFixture(name));
    if (errs.length > 0) failures.push(`${name}: ${errs.join('; ')}`);
  }
  const passRate = (names.length - failures.length) / names.length;
  assert.ok(passRate >= 0.99, `schema pass rate ${passRate} < 0.99`);
  assert.deepEqual(failures, [], '録画 fixture の schema 失敗 (live なし・決定論 — flaky の余地なし)');
});

for (const [name, sc] of Object.entries(SUITE)) {
  test(`conformance: ${name} (録画 → 台帳 → 決定表、${gate.source} / ${budget.source})`, async () => {
    const turn = await startTurn({ fixture: name });
    const events = await collect(turn.events);
    assert.deepEqual(schemaErrors(events), [], `${name} schema`);
    assert.ok(turn.sessionId.length > 0, `${name} stub sessionId`);
    const { ledger, overByTurn } = replayLedger(events, sc.budgetCfg());
    for (const [turnNo, want] of Object.entries(sc.overAt)) {
      assert.equal(overByTurn[Number(turnNo)], want, `${name}: ledger over at turn ${turnNo}`);
    }
    const budgetState = { over: overByTurn[lastTurn(events)], ledger };
    const decision = gate.mod.decide(sc.gate(budgetState));
    assert.ok(Array.isArray(decision.labels), `${name} 決定表の labels 配列`);
    sc.gateCheck(decision, gate.mod);
    for (const l of decision.labels) {
      assert.ok(
        !['plan:approved', 'plan:rejected', 'risk:medium', 'risk:high', 'exempt:accept-author', 'cohort:typical'].includes(l),
        'gate は exempt・権限ラベルを付与しない (spec §4.2 §8)',
      );
    }
  });
}

test('しきい値 2: gate 拒否系 fixture の遵守 = 100% (spec §6)', async () => {
  const rejects = Object.entries(SUITE).filter(([, sc]) => Object.values(sc.overAt).some((v) => v === true));
  assert.ok(rejects.length >= 1, '拒否系 fixture (budget 打ち切り群) が存在');
  for (const [name, sc] of rejects) {
    const events = await collect((await startTurn({ fixture: name })).events);
    const { ledger, overByTurn } = replayLedger(events, sc.budgetCfg());
    assert.equal(overByTurn[lastTurn(events)], true, `${name}: 台帳拒否 (consumeTurn)`);
    assert.equal(budget.mod.overBudget(ledger, sc.budgetCfg()), true, `${name}: overBudget 突合`);
    const t = gate.mod.decide(sc.gate({ over: true }));
    assert.ok(t.labels.includes('blocked/budget'), `${name}: 決定表の拒否行 (budget > 他の全行、spec §7)`);
  }
});

test('stub seat 決定論: 同一 fixture の 2 回再生が sessionId・event 系列を一致させる (spec §6)', async () => {
  const a = await startTurn({ fixture: 'p2-child-implement.json', role: 'implement', tier: 'low', payload: 'payload-a' });
  const b = await startTurn({ fixture: 'p2-child-implement.json', role: 'implement', tier: 'low', payload: 'payload-a' });
  assert.equal(a.sessionId, b.sessionId, 'sessionId 決定論');
  assert.equal(JSON.stringify(await collect(a.events)), JSON.stringify(await collect(b.events)), 'event 系列決定論');
});

test('stub seat sessionHint 継承 (復元は勝者 session-id を継承 MUST、spec §7)', async () => {
  const r = await startTurn({ fixture: 'p2-child-implement.json', sessionHint: 'sess-winner-claim-40' });
  assert.equal(r.sessionId, 'sess-winner-claim-40');
  const events = await collect(r.events);
  assert.equal(events[0].sessionId, 'sess-winner-claim-40', 'session event の sessionId も hint に揃う');
});

test('stub seat role 既定選択は決定論 (fixture 指定なしでも 2 回が同一)', async () => {
  const a = await startTurn({ role: 'plan', tier: 'high', payload: 'お題本文' });
  const b = await startTurn({ role: 'plan', tier: 'high', payload: 'お題本文' });
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(JSON.stringify(await collect(a.events)), JSON.stringify(await collect(b.events)));
});

