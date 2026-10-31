// tests/perform/topics/fixtures/p3-vacuous.test.mjs — P3 accept-vacuous 注入 (spec §4.5・§10 M5 false green 検出)。
// 意図的に RED: assert の引数が定数のみ (observable を参照しない、spec §4.5) — runner の `accept-vacuity` AST 走査が failure MUST。
// 実挙動 (コード・observable) を一切参照しない mutation probe として、単体でも常に red (red 期待値の回帰、spec §10 M1)。
// P3.md の acceptBlock cmd: {"accept":[{"id":"A3V","kind":"test","cmd":"node --test tests/perform/topics/fixtures/p3-vacuous.test.mjs"}]}
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('A3V vacuity probe — accept-vacuity はこのファイルを AST 走査で failure MUST (spec §4.5)', async () => {
  // 定数アサーションのみ (引数は observable を参照しない): green 実体 (p1.test.mjs) への差し戻しが green に立つ = false green の対。
  assert.ok(false, 'vacuity probe — observable mutation marker');
});
