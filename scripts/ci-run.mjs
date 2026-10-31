// scripts/ci-run.mjs — CI からの check 実行 (workflow の step)。accept job = node --test + runner の deterministic check。
// framework repo 自身でも動く (dogfood: accept 条項 = npm test)。provider API は使わない (CI ローカル完結)。
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../src/runner.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(ROOT, 'docs', 'governance', 'config.json'), 'utf8'));

const base = process.env.GITHUB_BASE_REF || 'main';
const head = process.env.GITHUB_HEAD_REF || 'HEAD';
function changedFiles() {
  try {
    return execSync(`git diff --name-only ${base}...${head}`, { cwd: ROOT }).toString().trim().split('\n').filter(Boolean);
  } catch {
    return execSync('git diff --name-only HEAD~1', { cwd: ROOT }).toString().trim().split('\n').filter(Boolean);
  }
}
const headSha = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();

const checks = [
  // runner の checks 引数は check 名文字列 (§4.1 — cmd は acceptBlock 側に入っており、名前の object ではない)。
  // framework 本体 dogfood の accept job = 本番 unit 群 (npm test の glob — tests/*.test.mjs のみ。
  // tests/perform/topics/fixtures/ の accept-first 赤 (P1 対象 scripts/status.mjs は framework 本体に
  // 存在しない — scratch 専用) は数えない、§4.5。accept-vacuity は file cmd 前提の fail-closed check なので
  // framework 本体 (ci/accept 無し) では対象なし — scratch PR 側で測る (framework の required は accept job のみ))。
  { name: 'accept', cmd: 'npm test' },
  { name: 'no-state' },
].map((c) => c.name);
const acceptBlock = { accept: [{ id: 'A1', kind: 'test', cmd: 'npm test' }], scope: ['src/**', 'tests/**', 'docs/**'], refs: ['spec §10'] };
const results = await runChecks({ checks, workDir: ROOT, acceptBlock, meta: { prHeadSha: headSha, changedPaths: changedFiles(), frameworkConfig: config } });
for (const c of results) {
  console.log(`${c.name}: ${c.state}`);
  if (c.state === 'failure') console.error(c.detail || '');
}
if (results.some((c) => c.state === 'failure')) process.exit(1);
