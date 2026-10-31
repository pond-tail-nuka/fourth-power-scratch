// tests/perform/accept-src.mjs — accept 実体と実装 src の共有正本 (perform driver と forgeless suite の共通 seed 源)。
// テンプレート・accept テスト本文・topic parse を一元化する (二重定義を避け、夜間と朝の突合は同一テキストを使う)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOPICS = path.join(HERE, 'topics');

export const STATUS_SRC = `#!/usr/bin/env node
// scripts/status.mjs — read-only projection (spec §2.1: read 経路のみ・書込みなし — A1 実装)。
// --json: 固定 offline 投影 {schemaVersion, issues[], maxAgeSec} (PROPOSAL §14 B)。table: 行を ASCII 出力。
const flags = process.argv.slice(2);
const json = flags.includes('--json');
const offline = flags.includes('--offline');
if (!offline) {
  console.error('status.mjs: --offline のみ対応 (本番 provider は §11 mock bullet — 夜間は offline 固定)');
  process.exit(1);
}
const projection = {
  schemaVersion: 1,
  issues: [{ repo: 'mock/fourth_power', number: 1, statusLabel: 'backlog', written: false }],
  maxAgeSec: 30,
};
if (json) process.stdout.write(JSON.stringify(projection));
else process.stdout.write('fp-status-table\\nmock/fourth_power 1 backlog\\n');
`;

export const A21_A = `// ci/accept/a21-a.test.mjs — A21-A (child 機械組立 accept 本体 — plan PR 起票済み・改変禁止)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const STATUS = fileURLToPath(new URL('../../scripts/status.mjs', import.meta.url));
function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [STATUS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
test('A21-A --json projection (read-only)', async () => {
  const r = await run(['--json', '--provider', 'mock', '--offline']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.schemaVersion, 1);
  assert.ok(Array.isArray(j.issues));
  for (const row of j.issues) {
    assert.equal(typeof row.statusLabel, 'string');
    assert.equal(row.written, false);
  }
});
`;

export const A21_B = `// ci/accept/a21-b.test.mjs — A21-B (stale banner — ui 間隔超過の stale 表示、spec §2.6 ui key)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const STATUS = fileURLToPath(new URL('../../scripts/status.mjs', import.meta.url));
function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [STATUS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
test('A21-B stale banner 間隔は ui.readIntervalSec と一致 (投影 maxAgeSec)', async () => {
  const r = await run(['--json', '--provider', 'mock', '--offline']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.maxAgeSec, 30, 'stale banner 間隔 = config ui.readIntervalSec (§2.6)');
});
`;

/** main seed の accept 実体 (人間起票済み・改変禁止 — §4.2 accept immutable と同一の seed)。 */
export function seedAcceptFiles() {
  return {
    'tests/perform/topics/fixtures/p1.test.mjs': readFileSync(path.join(TOPICS, 'fixtures', 'p1.test.mjs'), 'utf8'),
    'tests/perform/topics/fixtures/p3-vacuous.test.mjs': readFileSync(path.join(TOPICS, 'fixtures', 'p3-vacuous.test.mjs'), 'utf8'),
    'ci/accept/a21-a.test.mjs': A21_A,
    'ci/accept/a21-b.test.mjs': A21_B,
  };
}

/** topic md の front matter 分離 (perform・forgeless 共通)。 */
export function parseTopic(name) {
  const raw = readFileSync(path.join(TOPICS, name), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const front = Object.fromEntries(m[1].split('\n').map((l) => l.split(/:\s*(.*)/)).map(([k, v]) => [k.trim(), v == null ? '' : v.trim()]));
  return { front, body: m[2].trim() };
}

/** issue 本文から fence acceptBlock の本文ブロックを拾う (§5 機械可読)。 */
export function fenceOf(body) {
  const m = /```acceptBlock\s*\n([\s\S]*?)\n```/.exec(body);
  return m ? m[1].trim() : null;
}

/** plan PR 起算の child entry 節テキスト (§5 機械組立 — perform driver と forgeless suite の共通生成)。 */
export function childSectionText(children) {
  return children.map((c) => `#### child issue: ${c.title}\nspec ${c.refs.join(' ')}\naccept: ${c.id}\n\`\`\`acceptBlock\n${JSON.stringify({ accept: [{ id: c.id, kind: 'test', cmd: c.cmd }], scope: c.scope, refs: c.refs })}\n\`\`\``).join('\n\n');
}
