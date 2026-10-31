// ci/accept/a21-a.test.mjs — A21-A (child 組立 accept 本体 — plan PR 起票済み・改変禁止)。
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
