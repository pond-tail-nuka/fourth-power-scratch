// ci/accept/a21-b.test.mjs — A21-B (stale banner — ui 間隔超過の stale 表示、spec §2.6 ui key)。
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
