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
  { name: 'accept', cmd: 'node --test tests/' },
  { name: 'no-state' },
  { name: 'accept-vacuity' },
];
const acceptBlock = { accept: [{ id: 'A1', kind: 'test', cmd: 'node --test tests/' }], scope: ['src/**', 'tests/**', 'docs/**'], refs: ['spec §10'] };
const results = await runChecks({ checks, workDir: ROOT, acceptBlock, meta: { prHeadSha: headSha, changedFiles: changedFiles(), config } });
for (const c of results) {
  console.log(`${c.name}: ${c.state}`);
  if (c.state === 'failure') console.error(c.detail || '');
}
if (results.some((c) => c.state === 'failure')) process.exit(1);
