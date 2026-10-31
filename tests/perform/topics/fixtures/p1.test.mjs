// tests/perform/topics/fixtures/p1.test.mjs — P1 (A1) の受け入れ本体 (accept-first: 実装マージ前は red、実装後は green)。
// scripts/status.mjs の --json 投影 (PROPOSAL §14 B: read-only・書込みなし・read 経路のみ) を検証する。
// observable: 子プロセスの stdout/stderr (実挙動の観測 — 定数アサーションではない、spec §4.5)。
// cwd = workDir 想定 (mock ループの accept job は workDir で cmd を実行。repo 直下でも同じ相対パスで走る)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS_ENTRY = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'scripts', 'status.mjs');

function runStatus(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [STATUS_ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function statusExists() {
  try {
    await access(STATUS_ENTRY);
    return true;
  } catch {
    return false;
  }
}

const hasStatus = await statusExists();
if (!hasStatus) {
  // accept-first 準拠 (spec §4.5 mutation): 対象実装 (scripts/status.mjs --json) が revert 相当の
  // 未実装状態では red MUST。「実装待ち」の skip は green と数えず、test 本体を red にする。
  test('accept A1 precondition — scripts/status.mjs exists (accept-first red until implemented)', async () => {
    assert.equal(hasStatus, true, `scripts/status.mjs not found at ${STATUS_ENTRY} — A1 is accept-first: implement turn must create it`);
  });
} else {
  test('accept A1 — --json は正規 JSON の projection を stdout に出す', async () => {
    const r = await runStatus(['--json', '--provider', 'mock', '--offline']);
    assert.equal(r.code, 0, `status.mjs --json failed: exit=${r.code} stderr=${r.stderr}`);
    const projection = JSON.parse(r.stdout);
    assert.equal(projection.schemaVersion, 1);
    assert.ok(Array.isArray(projection.issues), 'issues array');
  });

  test('accept A1 — projection 行は状態ラベルを持つ', async () => {
    const r = await runStatus(['--json', '--provider', 'mock', '--offline']);
    assert.equal(r.code, 0);
    const projection = JSON.parse(r.stdout);
    assert.ok(Array.isArray(projection.issues), 'issues array');
    for (const row of projection.issues) {
      assert.equal(typeof row.statusLabel, 'string', 'statusLabel string');
      assert.ok(row.statusLabel.length > 0, 'statusLabel non-empty');
    }
  });

  test('accept A1 — --json は書込みをしない (read-only, spec §2.1)', async () => {
    const r = await runStatus(['--json', '--provider', 'mock', '--offline']);
    assert.equal(r.code, 0);
    const projection = JSON.parse(r.stdout);
    assert.ok(Array.isArray(projection.issues), 'issues array');
    for (const row of projection.issues) {
      assert.equal(row.written, false, 'projection must be read-only');
    }
  });

  test('accept A1 — --json なし (既定) は table を stdout に出す (JSON 化しない)', async () => {
    const r = await runStatus(['--provider', 'mock', '--offline']);
    assert.equal(r.code, 0, `status.mjs table mode failed: exit=${r.code} stderr=${r.stderr}`);
    assert.ok(r.stdout.trim().length > 0, 'table output non-empty');
    assert.throws(() => JSON.parse(r.stdout), 'table mode must not be JSON');
  });
}
