// tests/runner.test.mjs — deterministic runner checks (spec §4.1/§4.5/§8, contract §10).
// Unit scope only: runChecks + its scanners. No cross-module integration here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, ACCEPT_CHECK_NAMES, DEFAULT_REQUIRED_CHECKS, parseAcceptBlock } from '../src/runner.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const LABELS = [
  'backlog', 'claimed', 'in_review', 'rebase_required', 'blocked/budget', 'blocked/spec-gap',
  'blocked/ci-red', 'blocked/peer', 'done', 'ok/agent-reviewed', 'accept:pass', 'accept:revise',
  'cohort:fast', 'cohort:typical', 'cohort:slow', 'plan:approved', 'plan:rejected',
  'risk:low', 'risk:medium', 'risk:high', 'exempt:accept-author', 'exempt:spec-pr',
  'peer/request', 'peer/answer', 'needs-info',
];

const FRAMEWORK_CONFIG = {
  labels: LABELS,
  requiredChecks: [...DEFAULT_REQUIRED_CHECKS],
  requiredApprovals: 1,
  botActor: 'fourth-power-bot',
  acceptJobName: 'accept',
  exemptLabels: ['exempt:accept-author', 'exempt:spec-pr'],
  humanAccounts: ['pond-tail-nuka'],
  workflowName: 'fourth-power-accept',
  tiers: {
    highPaths: ['src/', 'scripts/', 'package.json', 'ci/accept/', 'docs/spec.md', 'docs/PROPOSAL.md', 'docs/governance/', 'prompts/', 'tests/', '.github/workflows/', '.gitlab-ci.yml'],
  },
};

const PROJECT_OK = {
  labels: LABELS,
  protection: {
    requiredChecks: [...DEFAULT_REQUIRED_CHECKS],
    requiredApprovals: 1,
    dismissStaleReviews: true,
    enforceAdmins: true,
  },
  workflowNames: ['fourth-power-accept'],
};

const HUMAN_APPROVAL = { reviewer: 'pond-tail-nuka', sha: 'sha-head' };

function baseMeta(overrides = {}) {
  return {
    prHeadSha: 'sha-head',
    prLabels: [],
    issueLabels: ['backlog'],
    changedPaths: [],
    approvals: [HUMAN_APPROVAL],
    threads: [],
    projectState: PROJECT_OK,
    frameworkConfig: FRAMEWORK_CONFIG,
    ...overrides,
  };
}

function tmpWork(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-runner-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function stateOf(results, name) {
  const hit = results.find((c) => c.name === name);
  assert.ok(hit, `check '${name}' present`);
  return hit.state;
}

const REAL_ACCEPT = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../../src/impl.mjs';\ntest('A1 add', () => {\n  assert.equal(add(2, 3), 5);\n});\n`;
const IMPL = `export function add(a, b) {\n  return a + b;\n}\n`;

const BLOCK = {
  accept: [{ id: 'A1', kind: 'test', cmd: 'node --test ci/accept/A1.test.mjs' }],
  scope: ['src/impl.mjs', 'src/missing.mjs'],
  refs: ['spec §4.3'],
};

test('full green run: all checks present with canonical issuer', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL, 'ci/accept/A1.test.mjs': REAL_ACCEPT });
  try {
    const results = runChecks({ checks: ACCEPT_CHECK_NAMES, workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ changedPaths: ['src/impl.mjs'] }) });
    assert.equal(results.length, ACCEPT_CHECK_NAMES.length);
    for (const c of results) {
      assert.equal(c.state, 'success', `${c.name} green`);
      assert.equal(c.issuer, 'fourth-power-bot');
      assert.equal(c.headSha, 'sha-head');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept job: failing test entry -> accept failure, others stay green', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL, 'ci/accept/A1.test.mjs': REAL_ACCEPT.replace('assert.equal(add(2, 3), 5);', "assert.equal(add(2, 3), 99);") });
  try {
    const results = runChecks({ checks: ['accept'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(results, 'accept'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept job: empty accept contract never green (spec §4.2)', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL });
  try {
    const results = runChecks({ checks: ['accept'], workDir: dir, acceptBlock: { accept: [], scope: [] }, meta: baseMeta() });
    assert.equal(stateOf(results, 'accept'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept job: cmd timeout -> failure', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL, 'ci/accept/A1.test.mjs': REAL_ACCEPT });
  try {
    const block = { accept: [{ id: 'A1', kind: 'test', cmd: 'node -e setTimeout(()=>process.exit(0),3000)' }], scope: ['src/impl.mjs'] };
    const results = runChecks({ checks: ['accept'], workDir: dir, acceptBlock: block, meta: baseMeta({ timeoutMs: 250 }) });
    assert.equal(stateOf(results, 'accept'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept-vacuity: constant-only assert -> failure (spec §4.5)', () => {
  const dir = tmpWork({
    'src/impl.mjs': IMPL,
    'ci/accept/A1.test.mjs': "import assert from 'node:assert/strict';\nimport { it } from 'node:test';\nit('const', () => { assert.ok(true); assert.ok(false, 'probe marker'); });\n",
  });
  try {
    const results = runChecks({ checks: ['accept-vacuity'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(results, 'accept-vacuity'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept-vacuity: no assert import / no entity -> failure', () => {
  const dir = tmpWork({
    'src/impl.mjs': IMPL,
    'ci/accept/A1.test.mjs': "import { test } from 'node:test';\ntest('x', () => { process.stdout.write('hi'); });\n",
  });
  try {
    const results = runChecks({ checks: ['accept-vacuity'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(results, 'accept-vacuity'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept-vacuity: empty it() callback -> failure', () => {
  const dir = tmpWork({
    'src/impl.mjs': IMPL,
    'ci/accept/A1.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nconst r = add();\ntest('empty', () => {});\nassert.ok(r, 'observable');\n",
  });
  try {
    const results = runChecks({ checks: ['accept-vacuity'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(results, 'accept-vacuity'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept-vacuity: real test (observable-referencing assert) -> success', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL, 'ci/accept/A1.test.mjs': REAL_ACCEPT });
  try {
    const results = runChecks({ checks: ['accept-vacuity'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(results, 'accept-vacuity'), 'success');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept-vacuity: P3 injected vacuous fixture -> failure (perform P3 expectation)', () => {
  const block = { accept: [{ id: 'A3V', kind: 'test', cmd: 'node --test tests/perform/topics/fixtures/p3-vacuous.test.mjs' }], scope: ['src/impl.mjs'] };
  const results = runChecks({ checks: ['accept-vacuity'], workDir: REPO_ROOT, acceptBlock: block, meta: baseMeta() });
  assert.equal(stateOf(results, 'accept-vacuity'), 'failure');
});

test('accept-vacuity: missing accept test file -> failure (spec §4.2 existence match)', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL });
  try {
    const results = runChecks({ checks: ['accept-vacuity'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(results, 'accept-vacuity'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept-immutable: accept path change without exempt -> failure; with exempt -> success (spec §4.2)', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL, 'ci/accept/A1.test.mjs': REAL_ACCEPT });
  try {
    const changed = ['src/impl.mjs', 'ci/accept/A1.test.mjs'];
  const red = runChecks({ checks: ['accept-immutable'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ changedPaths: changed }) });
    assert.equal(stateOf(red, 'accept-immutable'), 'failure');
    const ok = runChecks({
      checks: ['accept-immutable'], workDir: dir, acceptBlock: BLOCK,
      meta: baseMeta({ changedPaths: changed, prLabels: ['exempt:accept-author'] }),
    });
    assert.equal(stateOf(ok, 'accept-immutable'), 'success');
    const other = runChecks({ checks: ['accept-immutable'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ changedPaths: ['src/impl.mjs'] }) });
    assert.equal(stateOf(other, 'accept-immutable'), 'success');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scope-guard: changed path outside scope declaration -> failure (spec §4.1)', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL, 'src/missing.mjs': IMPL });
  try {
    const outside = runChecks({ checks: ['scope-guard'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ changedPaths: ['src/impl.mjs', 'src/missing.mjs'] }) });
    assert.equal(stateOf(outside, 'scope-guard'), 'success');
    const overreach = runChecks({ checks: ['scope-guard'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ changedPaths: ['src/other.mjs'] }) });
    assert.equal(stateOf(overreach, 'scope-guard'), 'failure');
    const noScope = runChecks({ checks: ['scope-guard'], workDir: dir, acceptBlock: { accept: [{ id: 'A1', cmd: 'true' }] }, meta: baseMeta() });
    assert.equal(stateOf(noScope, 'scope-guard'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sha-approval: stale approval (SHA != head) -> failure; fresh -> success (spec §8)', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL, 'ci/accept/A1.test.mjs': REAL_ACCEPT });
  try {
    const stale = runChecks({ checks: ['sha-approval'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ approvals: [{ reviewer: 'pond-tail-nuka', sha: 'sha-old' }] }) });
    assert.equal(stateOf(stale, 'sha-approval'), 'failure');
    const fresh = runChecks({ checks: ['sha-approval'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(fresh, 'sha-approval'), 'success');
    const none = runChecks({ checks: ['sha-approval'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ approvals: [] }) });
    assert.equal(stateOf(none, 'sha-approval'), 'success', 'no approvals: sha-approval itself does not gate (risk-tier does)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status-exclusivity: two state labels on one Issue -> failure (spec §11 label exclusive)', () => {
  const dir = tmpWork({});
  try {
    const dup = runChecks({ checks: ['status-exclusivity'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ issueLabels: ['claimed', 'in_review'] }) });
    assert.equal(stateOf(dup, 'status-exclusivity'), 'failure');
    const dupBlocked = runChecks({ checks: ['status-exclusivity'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ issueLabels: ['blocked/budget', 'blocked/spec-gap'] }) });
    assert.equal(stateOf(dupBlocked, 'status-exclusivity'), 'failure');
    const one = runChecks({ checks: ['status-exclusivity'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ issueLabels: ['claimed', 'cohort:typical'] }) });
    assert.equal(stateOf(one, 'status-exclusivity'), 'success', 'non-state labels do not count');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no-state: fs writes / DB / bootstrap imports in src -> failure (spec §2.5)', () => {
  const dir = tmpWork({
    'src/forge.mjs': `import { spawnSync } from 'node:child_process';\nexport function pr(id) {\n  const r = spawnSync('gh', ['api', 'repos/', id]);\n  return r.stdout;\n}\n`,
    'src/evil.mjs': `import { appendFile } from 'node:fs/promises';\nexport async function save(p, data) {\n  await appendFile(p, data);\n}\n`,
  });
  try {
    const red = runChecks({ checks: ['no-state'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(red, 'no-state'), 'failure');
    const clean = tmpWork({ 'src/forge.mjs': `import { spawnSync } from 'node:child_process';\nexport const api = (a) => spawnSync('gh', ['api', a]);\n` });
    const green = runChecks({ checks: ['no-state'], workDir: clean, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(green, 'no-state'), 'success');
    rmSync(clean, { recursive: true, force: true });
    const db = tmpWork({ 'src/db.mjs': `import Database from 'better-sqlite3';\nexport const open = (f) => new Database(f);\n` });
    assert.equal(stateOf(runChecks({ checks: ['no-state'], workDir: db, acceptBlock: BLOCK, meta: baseMeta() }), 'no-state'), 'failure');
    rmSync(db, { recursive: true, force: true });
    const boot = tmpWork({ 'src/orch.mjs': `import { bootstrap } from '../scripts/bootstrap.mjs';\nvoid bootstrap;\n` });
    assert.equal(stateOf(runChecks({ checks: ['no-state'], workDir: boot, acceptBlock: BLOCK, meta: baseMeta() }), 'no-state'), 'failure');
    rmSync(boot, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config-consistency: framework vs injected project state (spec §2.6)', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL });
  try {
    assert.equal(stateOf(runChecks({ checks: ['config-consistency'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() }), 'config-consistency'), 'success');
    const missingLabel = {
      ...PROJECT_OK,
      labels: PROJECT_OK.labels.filter((l) => l !== 'blocked/spec-gap'),
    };
    assert.equal(stateOf(runChecks({ checks: ['config-consistency'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ projectState: missingLabel }) }), 'config-consistency'), 'failure');
    const badChecks = { ...PROJECT_OK, protection: { ...PROJECT_OK.protection, requiredChecks: [...DEFAULT_REQUIRED_CHECKS, 'evil-required'] } };
    assert.equal(stateOf(runChecks({ checks: ['config-consistency'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ projectState: badChecks }) }), 'config-consistency'), 'failure');
    const noAdmins = { ...PROJECT_OK, protection: { ...PROJECT_OK.protection, enforceAdmins: false } };
    assert.equal(stateOf(runChecks({ checks: ['config-consistency'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ projectState: noAdmins }) }), 'config-consistency'), 'failure');
    const noWorkflow = { ...PROJECT_OK, workflowNames: [] };
    assert.equal(stateOf(runChecks({ checks: ['config-consistency'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ projectState: noWorkflow }) }), 'config-consistency'), 'failure');
    const noConfig = baseMeta();
    delete noConfig.frameworkConfig;
    assert.equal(stateOf(runChecks({ checks: ['config-consistency'], workDir: dir, acceptBlock: BLOCK, meta: noConfig }), 'config-consistency'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('risk-tier: high path + approval records read (spec §8)', () => {
  const dir = tmpWork({ 'src/impl.mjs': IMPL });
  try {
    const highNoApproval = runChecks({ checks: ['risk-tier'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ approvals: [], changedPaths: ['src/forge.mjs'] }) });
    assert.equal(stateOf(highNoApproval, 'risk-tier'), 'failure', 'high path without approval record');
    const agentApproval = runChecks({ checks: ['risk-tier'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ approvals: [{ reviewer: 'fourth-power-bot', sha: 'sha-head' }], changedPaths: ['src/forge.mjs'] }) });
    assert.equal(stateOf(agentApproval, 'risk-tier'), 'failure', 'agent/bot approval never satisfies human requirement');
    const humanOk = runChecks({ checks: ['risk-tier'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ changedPaths: ['src/forge.mjs'] }) });
    assert.equal(stateOf(humanOk, 'risk-tier'), 'success');
    const ciRedir = runChecks({ checks: ['risk-tier'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ approvals: [], changedPaths: ['ci/accept/x.test.mjs'] }) });
    assert.equal(stateOf(ciRedir, 'risk-tier'), 'failure', 'ci/ always promotes to high (spec §8 low-path promotion)');
    const exemptLow = runChecks({ checks: ['risk-tier'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ approvals: [], changedPaths: ['docs/notes.md'], prLabels: ['cohort:typical'] }) });
    assert.equal(stateOf(exemptLow, 'risk-tier'), 'success', 'cohort:typical non-high change is approval-exempt');
    const highNotExempt = runChecks({ checks: ['risk-tier'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ approvals: [], changedPaths: ['src/x.mjs'], prLabels: ['cohort:typical'] }) });
    assert.equal(stateOf(highNotExempt, 'risk-tier'), 'failure', 'cohort exemption never covers high path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('review-threads: open thread -> failure (spec §8)', () => {
  const dir = tmpWork({});
  try {
    const open = runChecks({ checks: ['review-threads'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ threads: [{ id: 't1', resolved: false }] }) });
    assert.equal(stateOf(open, 'review-threads'), 'failure');
    const resolved = runChecks({ checks: ['review-threads'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta({ threads: [{ id: 't1', resolved: true }] }) });
    assert.equal(stateOf(resolved, 'review-threads'), 'success');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('peer-query-reingestion: self PR verbatim query/issue-body reference -> failure (spec §5)', () => {
  const dir = tmpWork({});
  const query = 'peer answer note: the cohort split under §7 uses created_at first, which MUST be resolved by the winner rule only.';
  const issueBody = '# P1\naccept:A1 scope src/impl.mjs\nSome long issue body text that is well over forty chars and not a summary.';
  const red = runChecks({
    checks: ['peer-query-reingestion'], workDir: dir, acceptBlock: BLOCK,
    meta: baseMeta({ prBody: `See ${query} for context`, peerQueryBodies: [query] }),
  });
  assert.equal(stateOf(red, 'peer-query-reingestion'), 'failure');
  const redIssue = runChecks({
    checks: ['peer-query-reingestion'], workDir: dir, acceptBlock: BLOCK,
    meta: baseMeta({ prBody: issueBody, issueBody }),
  });
  assert.equal(stateOf(redIssue, 'peer-query-reingestion'), 'failure');
  const summaryOnly = runChecks({
    checks: ['peer-query-reingestion'], workDir: dir, acceptBlock: BLOCK,
    meta: baseMeta({ prBody: 'summary: peer answer resolved §7 ordering', peerQueryBodies: [query], issueBody }),
  });
  assert.equal(stateOf(summaryOnly, 'peer-query-reingestion'), 'success');
  const noPr = runChecks({ checks: ['peer-query-reingestion'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
  assert.equal(stateOf(noPr, 'peer-query-reingestion'), 'success');
  rmSync(dir, { recursive: true, force: true });
});

test('parseAcceptBlock: fenced issue text is the only parse source (contract §11)', () => {
  const fenced = 'free text\n```acceptBlock\n{"accept":[{"id":"A1","kind":"test","cmd":"true"}],"scope":["src/x.mjs"],"refs":["spec §4.3"]}\n```\nmore free text';
  const block = parseAcceptBlock(fenced);
  assert.equal(block.entries.length, 1);
  assert.equal(block.entries[0].id, 'A1');
  assert.deepEqual(block.scope, ['src/x.mjs']);
  assert.equal(block.parseError, null);
  assert.ok(parseAcceptBlock('no block here').parseError);
  assert.ok(parseAcceptBlock('```acceptBlock\n{broken\n```').parseError);
});

test('all required checks always run, verdicts are never pending (spec §4.1)', () => {
  const dir = tmpWork({});
  try {
    const results = runChecks({ checks: undefined, workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    for (const name of DEFAULT_REQUIRED_CHECKS) {
      assert.ok(results.some((c) => c.name === name), `${name} runs even with no diff files`);
    }
    for (const c of results) assert.ok(c.state === 'success' || c.state === 'failure', `${c.name}: ${c.state}`);
    assert.equal(stateOf(results, 'accept-vacuity'), 'failure', 'missing accept file blocks merge regardless');
    const unknown = runChecks({ checks: ['nope-check'], workDir: dir, acceptBlock: BLOCK, meta: baseMeta() });
    assert.equal(stateOf(unknown, 'nope-check'), 'failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
