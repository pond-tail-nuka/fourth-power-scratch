// tests/payload.test.mjs — payload 組立の回帰 (spec §5・§6・§7・§12 / contract §11)
// fence 専用 parse・対象外返し・間引き挙動・record helper 書式固定をここで固定する。
// 他モジュール (gate/seat/forge) は呼ばない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblePayload,
  parseAcceptBlock,
  sessionMarker,
  claimComment,
  planComment,
} from '../src/payload.mjs';

const FENCE = (json) => '```acceptBlock\n' + json + '\n```';
const BLOCK = JSON.stringify({
  accept: [{ id: 'A1', kind: 'test', cmd: 'node --test tests/payload.test.mjs' }],
  scope: ['src/payload.mjs'],
  refs: ['spec §4.3'],
});

function issue(body) {
  return { id: 'I1', number: 7, repo: 'a/b', title: 't', body, author: 'x', labels: [], state: 'open', createdAt: 'x', updatedAt: 'x' };
}
const CONFIG = { contextBudget: 16000 };

test('fence のみ parse: acceptBlock 条項・scope・refs が payload に出る', () => {
  const clauses = { 'spec §4.3': 'job accept の green が完了の定義 MUST。' };
  const p = assemblePayload(issue('本文の先頭\n' + FENCE(BLOCK) + '\n末尾の自由文'), CONFIG, clauses);
  assert.ok(p);
  assert.equal(p.trimmed, false);
  assert.equal(p.truncated, false);
  assert.deepEqual(p.accept, [{ id: 'A1', kind: 'test', cmd: 'node --test tests/payload.test.mjs' }]);
  assert.deepEqual(p.scope, ['src/payload.mjs']);
  assert.deepEqual(p.refs, ['spec §4.3']);
  assert.match(p.payloadText, /^refs\n- spec §4\.3: job accept の green が完了の定義 MUST。\n/);
  assert.match(p.payloadText, /\naccept\n- A1 test node --test tests\/payload\.test\.mjs\n/);
  assert.match(p.payloadText, /\nscope\n- src\/payload\.mjs$/);
});

test('自由文は条項にしない: fence 外の accept 相当・refs 相当・JSON は本文に現れない', () => {
  const body =
    '自由文に混んだ偽装: acceptBlock とかいてあるだけ。\n' +
    '{"accept":[{"id":"X9","kind":"evil","cmd":"rm -rf /"}],"scope":["evil/"],"refs":["spec §9.9"]}\n' +
    'accept: A9\nspec §4.5 の条項を本文で参照しているだけ\n' +
    FENCE(BLOCK);
  const p = assemblePayload(issue(body), CONFIG, {});
  assert.ok(p);
  assert.ok(!p.payloadText.includes('evil'));
  assert.ok(!p.payloadText.includes('X9'));
  assert.ok(!p.payloadText.includes('A9'));
  assert.ok(!p.payloadText.includes('spec §9.9'));
  assert.ok(!p.payloadText.includes('spec §4.5'));
  assert.deepEqual(p.accept, [{ id: 'A1', kind: 'test', cmd: 'node --test tests/payload.test.mjs' }]);
});

test('fence 欠損は対象外返し (null) / JSON 不正・shape 外も null', () => {
  assert.equal(assemblePayload(issue('acceptBlock fence 無し本文'), CONFIG, {}), null);
  assert.equal(assemblePayload(issue(''), CONFIG, {}), null);
  assert.equal(assemblePayload(issue(undefined), CONFIG, {}), null);
  assert.equal(assemblePayload(issue('```acceptBlock\n{不再是 JSON}\n```'), CONFIG, {}), null);
  assert.equal(assemblePayload(issue('```acceptBlock\n[]\n```'), CONFIG, {}), null);
  assert.equal(assemblePayload(issue('```acceptBlock\n{"accept":"A1"}\n```'), CONFIG, {}), null);
  assert.equal(
    assemblePayload(issue('```acceptBlock\n' + JSON.stringify({ accept: [{ id: 'A1' }], scope: [], refs: [] }) + '\n```'), CONFIG, {}),
    null,
  );
  assert.equal(parseAcceptBlock('本文だけ'), null);
});

test('fence 複数時は先頭のみ読む (規約は 1 つ置く MUST)', () => {
  const second = FENCE(JSON.stringify({ accept: [], scope: ['later/'], refs: [] }));
  const body = FENCE(BLOCK) + '\n' + second;
  const p = assemblePayload(issue(body), CONFIG, {});
  assert.deepEqual(p.scope, ['src/payload.mjs']);
  assert.ok(!p.payloadText.includes('later/'));
});

test('contextBudget 間引き: 参照条項を優先落として acceptBlock・scope は保持 (spec §6)', () => {
  const longClause = 'A'.repeat(500);
  const clauses = {
    'spec §4.3': longClause,
    'spec §5': 'B'.repeat(500),
  };
  const block = JSON.stringify({
    accept: [{ id: 'A1', kind: 'test', cmd: 'node --test tests/x.mjs' }],
    scope: ['src/x.mjs'],
    refs: ['spec §4.3', 'spec §5'],
  });
  const budget = 200; // clause 本文 2 つは入らないが accept・scope・ID 行は入る大きさ
  const p = assemblePayload(issue(FENCE(block)), { contextBudget: budget }, clauses);
  assert.ok(p);
  assert.equal(p.trimmed, true);
  assert.ok(p.payloadText.length <= budget);
  assert.ok(!p.payloadText.includes('AAAA'), '参照条項の本文は間引かれる');
  assert.ok(!p.payloadText.includes('BBBB'));
  // acceptBlock 優先: accept 条項 line・scope line・refs の ID 参照のみは残る
  assert.ok(p.payloadText.includes('- A1 test node --test tests/x.mjs'));
  assert.ok(p.payloadText.includes('- src/x.mjs'));
  assert.ok(p.payloadText.includes('- spec §4.3'));
  assert.deepEqual(p.accept, [{ id: 'A1', kind: 'test', cmd: 'node --test tests/x.mjs' }]);
  assert.deepEqual(p.refs, ['spec §4.3', 'spec §5']);
});

test('間引き第二段階: 予算が小さいと参照条項 section ごと落とす (acceptBlock のみ残る)', () => {
  const clauses = { 'spec §4.3': 'C'.repeat(400) };
  const p = assemblePayload(issue(FENCE(BLOCK)), { contextBudget: 75 }, clauses);
  assert.equal(p.trimmed, true);
  assert.ok(!p.payloadText.includes('refs'));
  assert.ok(!p.payloadText.includes('spec §4.3'));
  assert.ok(p.payloadText.includes('- A1 test'));
  assert.ok(p.payloadText.includes('- src/payload.mjs'));
});

test('最終手段: accept・scope だけで予算超過なら決定的 truncation (spec §6 truncation 結合)', () => {
  const big = JSON.stringify({
    accept: [{ id: 'A'.repeat(50), kind: 'test', cmd: 'c'.repeat(400) }],
    scope: ['s'.repeat(400)],
    refs: [],
  });
  const p = assemblePayload(issue(FENCE(big)), { contextBudget: 100 }, {});
  assert.equal(p.trimmed, true);
  assert.equal(p.truncated, true);
  assert.ok(p.payloadText.length <= 100);
  assert.ok(p.payloadText.startsWith('accept\n- A'));
});

test('未知の spec § ID は ID 行のみ添付 (条項テキストは存在するものだけ)', () => {
  const block = JSON.stringify({ accept: [], scope: [], refs: ['spec §99.9', 'spec §4.3'] });
  const p = assemblePayload(issue(FENCE(block)), CONFIG, { 'spec §4.3': '本文テキスト' });
  assert.match(p.payloadText, /^refs\n- spec §99\.9\n- spec §4\.3: 本文テキスト$/m);
});

test('record helper 書式固定 (spec §7・§12): claim・plan・hidden marker', () => {
  assert.equal(sessionMarker('sess-42'), '<!-- fp:session sess-42 -->');
  assert.equal(
    claimComment('sess-42', '2026-10-31T10:00:00Z'),
    'claimed sess-42 at 2026-10-31T10:00:00Z\n<!-- fp:session sess-42 -->',
  );
  assert.equal(
    claimComment('sess-42', '2026-10-31T10:00:00Z', '2026-10-31T11:30:00Z'),
    'claimed sess-42 at 2026-10-31T10:00:00Z resumed 2026-10-31T11:30:00Z\n<!-- fp:session sess-42 -->',
  );
  assert.equal(planComment('sess-42'), 'plan sess-42\n<!-- fp:session sess-42 -->');
  // 不正入力は throw (書式固定を崩す session-id・非 ISO 時刻を許さない)
  assert.throws(() => sessionMarker('bad id'), TypeError);
  assert.throws(() => sessionMarker('bad-->'), TypeError);
  assert.throws(() => claimComment('s', 'not-iso'), TypeError);
  assert.throws(() => claimComment('s', '2026-10-31T10:00:00Z', 'oops'), TypeError);
  assert.throws(() => planComment(' '), TypeError);
});

test('payloadText は決定論的結合 (同じ入力 → 同一バイト列、LLM 要約なし、spec §6)', () => {
  const clauses = { 'spec §4.3': 'x' };
  const a = assemblePayload(issue(FENCE(BLOCK)), CONFIG, clauses);
  const b = assemblePayload(issue(FENCE(BLOCK)), CONFIG, clauses);
  assert.equal(a.payloadText, b.payloadText);
  assert.ok(!a.payloadText.includes('本文の先頭'));
});
