// Mock CI stand-in executor (spec §11 mock bullet / contract §3・§10).
// - bare repo: git endpoint — branch ref の操作は remote 名 `mock` の push。
// - merge: base branch へ fast-forward (method 相当は git 側で再現) + store の PR merged 記録.
// - check post: runner.mjs の runChecks を呼ぶ (runner は注入 — contract §10。import しない)。
//   結果は Check として store に post (issuer = config の canonical bot `fourth-power-bot`).
// 作業用クローンは破棄する (§2 不変条件 1 — 実行中間物は永続状態にしない)。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as forge from '../../src/forge.mjs';
import * as mockServer from './mockServer.mjs';

const GIT_USER = ['-c', 'user.email=fourth-power-bot@example.invalid', '-c', 'user.name=fourth-power-bot'];

function run(cmd, args, cwd) {
  const proc = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (proc.error) throw new Error(`executor: ${cmd} spawn failed: ${proc.error.message}`);
  if (proc.status !== 0) {
    throw new Error(`executor: ${cmd} ${args.join(' ')} failed (${proc.status}): ${(proc.stderr ?? proc.stdout ?? '').toString().trim().slice(0, 300)}`);
  }
  return proc.stdout ?? '';
}

function tryRun(cmd, args, cwd) {
  const proc = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/** repo ごとの bare repo tmp パth (§11 mock bullet の throwaway — 損失は §2.1 と一致). */
export function gitDirFor(repoKey, tmpRoot = path.join(mockServer.REPO_ROOT, 'tmp')) {
  if (repoKey === mockServer.DEFAULT_REPO) return path.join(tmpRoot, 'mock-repo.git');
  const slug = repoKey.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(tmpRoot, `${slug}.git`);
}

/** §11 mock bullet の bare repo を作って main を初期 commit 付きで置く (冪等). */
export function ensureBareRepo(repoKey, gitDir = gitDirFor(repoKey)) {
  if (!existsSync(path.join(gitDir, 'HEAD'))) {
    mkdirSync(gitDir, { recursive: true });
    run('git', ['init', '--quiet', '--bare', '-b', 'main', gitDir]);
    const seed = mkdtempSync(path.join(os.tmpdir(), 'fp-seed-'));
    try {
      run('git', ['clone', '--quiet', '--origin', 'mock', gitDir, seed]);
      writeFileSync(path.join(seed, 'README.md'), `mock bare repo ${repoKey}\n`);
      run('git', [...GIT_USER, 'add', '-A'], seed);
      run('git', [...GIT_USER, 'commit', '--quiet', '-m', 'mock bootstrap: initial commit'], seed);
      run('git', ['push', 'mock', 'main'], seed);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
  }
  syncBranchCache(repoKey, gitDir);
  return gitDir;
}

/** origin を remote 名 `mock` (contract §3) の bare repo へ clone して work 用ディレクトリを作る. */
export function createWorkClone(repoKey, gitDir, at = 'main') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fp-work-'));
  run('git', ['clone', '--quiet', '--origin', 'mock', gitDir, dir]);
  run('git', ['checkout', '--quiet', at], dir);
  return dir;
}

/** §2 不変条件 2 の写し — base branch への直接 push は拒否 (main へは PR merge 経由のみ). */
function assertNoDirectPush(repoKey, branch, base = 'main') {
  if (branch === base) throw new Error(`executor: direct push to ${branch} banned (spec §2 不変条件 2)`);
}

/** work clone の変更を commit して bare repo の branch ref へ push し、sha を返す. */
export function commitAndPushBranch(workDir, repoKey, branch, message, gitDir = gitDirFor(repoKey)) {
  assertNoDirectPush(repoKey, branch);
  run('git', [...GIT_USER, 'checkout', '-B', branch, '--quiet'], workDir);
  run('git', [...GIT_USER, 'add', '-A'], workDir);
  const hasChanges = tryRun('git', ['diff', '--cached', '--quiet'], workDir).status !== 0;
  run('git', [...GIT_USER, 'commit', '--quiet', ...(hasChanges ? [] : ['--allow-empty']), '-m', message], workDir);
  const sha = run('git', ['rev-parse', 'HEAD'], workDir).trim();
  run('git', ['push', '--quiet', 'mock', branch], workDir);
  syncBranchCache(repoKey, gitDir);
  return sha;
}

/** 作業用クローンを破棄する (§2 不変条件 1 の mock 実装 — 中間物は forge に保存しない). */
export function discardWorkClone(workDir) {
  rmSync(workDir, { recursive: true, force: true });
}

/** bare repo の branch 一覧を mock の ref 台帳 (store の branch cache) へ sync する. */
export function syncBranchCache(repoKey, gitDir = gitDirFor(repoKey)) {
  const out = run('git', ['for-each-ref', '--format', '%(refname:short)\t%(objectname)', 'refs/heads/'], gitDir);
  for (const line of out.split('\n')) {
    const [name, sha] = line.split('\t');
    if (name && sha) mockServer.setBranchSha(repoKey, name, sha);
  }
}

function tryRevParse(ref, gitDir) {
  const r = tryRun('git', ['rev-parse', '--verify', ref], gitDir);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** bare repo の ref sha を読む (テスト・perform topic の決定論マージ検証用. 無ければ throw). */
export function revParse(repoKey, ref, gitDir = gitDirFor(repoKey)) {
  const sha = tryRevParse(`refs/heads/${ref}`, gitDir) ?? tryRevParse(ref, gitDir);
  if (!sha) throw new Error(`executor: no ${ref} in ${repoKey}`);
  return sha;
}

function isAncestor(ancestor, descendant, gitDir) {
  const r = tryRun('git', ['merge-base', '--is-ancestor', ancestor, descendant], gitDir);
  return r.status === 0;
}

/**
 * provider: (repoKey, branch) => sha||null (git の ref が正本).
 * mergeable provider: GitHub の background 計算の写し (merge-tree で決定論に判定).
 */
export function makeBranchProvider(repoKey, gitDir = gitDirFor(repoKey)) {
  return (key, branch) => (key === repoKey ? tryRevParse(`refs/heads/${branch}`, gitDir) : null);
}

export function makeMergeableProvider(repoKey, gitDir = gitDirFor(repoKey)) {
  return (key, baseRef, headSha) => {
    if (key !== repoKey || !headSha) return { mergeable: null, mergeable_state: 'unknown' };
    const base = tryRevParse(`refs/heads/${baseRef}`, gitDir);
    if (!base) return { mergeable: null, mergeable_state: 'unknown' };
    if (base === headSha || isAncestor(base, headSha, gitDir)) return { mergeable: true, mergeable_state: 'clean' };
    if (!tryRevParse(headSha, gitDir)) return { mergeable: null, mergeable_state: 'unknown' };
    const mt = tryRun('git', ['merge-tree', '--write-tree', base, headSha], gitDir);
    if (mt.status === 0) return { mergeable: true, mergeable_state: 'clean' };
    if (mt.status === 1) return { mergeable: false, mergeable_state: 'dirty' };
    return { mergeable: null, mergeable_state: 'unknown' };
  };
}

/**
 * merge handler — fast-forward + method 相当の git 動作 (§2.2 の既定 squash は履歴直線。
 * FF 可能なら ref をそのまま進め、FF 不可は squash/merge/rebase commit を作る)。
 * base branch への動きは PR merge 経由のみ (§2 不変条件 2 — direct push は拒否済みの経路).
 */
export function makeMergeHandler(repoKey, gitDir = gitDirFor(repoKey)) {
  return ({ baseRef, headSha, method = 'squash' }) => {
    ensureBareRepo(repoKey, gitDir);
    const base = tryRevParse(`refs/heads/${baseRef}`, gitDir);
    if (!base) throw new Error(`executor: no base branch ${baseRef} in ${repoKey}`);
    if (base === headSha || isAncestor(base, headSha, gitDir)) {
      run('git', ['update-ref', `refs/heads/${baseRef}`, headSha], gitDir);
      syncBranchCache(repoKey, gitDir);
      return { commit_sha: headSha };
    }
    const dir = createWorkClone(repoKey, gitDir, baseRef);
    try {
      if (method === 'rebase') {
        run('git', [...GIT_USER, 'checkout', '--quiet', headSha], dir);
        run('git', [...GIT_USER, 'rebase', '--quiet', baseRef], dir);
        run('git', [...GIT_USER, 'checkout', '--quiet', baseRef], dir);
        run('git', [...GIT_USER, 'merge', '--ff-only', '--quiet', 'HEAD'], dir);
      } else if (method === 'merge') {
        run('git', [...GIT_USER, 'merge', '--no-ff', '--quiet', '-m', `Merge ${headSha} into ${baseRef}`, headSha], dir);
      } else {
        run('git', [...GIT_USER, 'merge', '--squash', '--quiet', headSha], dir);
        run('git', [...GIT_USER, 'commit', '--quiet', '-m', `Squash ${headSha} into ${baseRef}`], dir);
      }
      run('git', ['push', '--quiet', 'mock', `HEAD:${baseRef}`], dir);
    } finally {
      discardWorkClone(dir);
    }
    const merged = tryRevParse(`refs/heads/${baseRef}`, gitDir);
    syncBranchCache(repoKey, gitDir);
    return { commit_sha: merged };
  };
}

/**
 * Issue 本文の acceptBlock fence を parse する (§11 の機械可読規約 — 自由文は parse しない、§5).
 * @returns {object|null} fence が無ければ null (claim 対象外は gate 側の判定).
 */
export function parseAcceptBlock(body) {
  const m = /```acceptBlock\s*\n([\s\S]*?)\n```/.exec(body ?? '');
  if (!m) return null;
  return JSON.parse(m[1]);
}

/**
 * PR head の work clone で runner.mjs の runChecks を呼び (§10)、Check を store に postする
 * (issuer = canonical bot、§8 の issuer 正規化)。runner は注入必須 (contract §10 —
 * executor は runner.mjs を import しない。CI workflow と同一の runChecks を共有する)。
 *
 * @param {{runner: (opts: {checks: string[], workDir: string, acceptBlock: object|null, meta: object}) => Promise<object[]>|object[], repoKey?: string, prId: string, gitDir?: string, checks?: string[], meta?: object, config?: object}} opts
 * @returns {Promise<object[]>} post された normalized Check.
 */
export async function runChecksOnPR({ runner, repoKey = mockServer.DEFAULT_REPO, prId, gitDir = gitDirFor(repoKey), checks, meta, config }) {
  const cfg = config ?? forge.readConfig();
  const prRaw = forge.prJson(prId);
  const headRef = prRaw?.head?.ref ?? '';
  const head = tryRevParse(`refs/heads/${headRef}`, gitDir) ?? prRaw?.head?.sha;
  if (!head) throw new Error(`executor: no head ref ${headRef} for ${prId} — push branch first`);
  const issueMatch = /^llm\/issue-(\d+)(?:-|$)/.exec(headRef);
  const issueId = issueMatch ? `${repoKey}#${issueMatch[1]}` : null;
  const issueRec = issueId ? forge.issue(issueId) : null;
  const issueBody = issueRec?.body ?? '';
  const acceptBlock = parseAcceptBlock(issueBody);
  const workDir = createWorkClone(repoKey, gitDir, head);
  // Runner 側の fail-closed meta (§4.1 全 check 常に実行): 未注入の check は保守的に failure になるので、
  // mock の可視状態から injectable な meta を組み立てる (config/projectState/approvals/threads/changedPaths).
  const diffNames = tryRun('git', ['diff', '--name-only', prRaw?.base?.ref ?? 'main', head], gitDir);
  const changedPaths = diffNames.status === 0 ? diffNames.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const defaultMeta = {
    prHeadSha: head,
    issueBody,
    prBody: prRaw?.body ?? '',
    prLabels: (prRaw?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    issueLabels: issueRec?.labels ?? [],
    frameworkConfig: cfg,
    projectState: {
      labels: forge.repoLabels(repoKey), // repo の label 定義 (bootstrap materialize 写し) — Issue ラベルではなく定義側を突合する (§8 config-consistency)
      protection: forge.protection(repoKey),
      workflowNames: cfg.workflowNames ?? (cfg.workflowName ? [cfg.workflowName] : []),
    },
    approvals: forge.approvals(prId),
    threads: forge.threads(prId),
    changedPaths,
    peerQueryBodies: issueId ? forge.notes(issueId).map((n) => n.body) : [],
  };
  const checkNames = checks ?? [...mockServer.REQUIRED_CHECKS, cfg.acceptJobName ?? 'accept'];
  try {
    const result = typeof runner === 'function' ? await runner({ checks: checkNames, workDir, acceptBlock, meta: { ...defaultMeta, ...meta } }) : runner;
    const posted = [];
    for (const check of result ?? []) {
      const raw = forge.postCheck(prId, check, cfg.botActor ?? mockServer.BOT);
      posted.push(forge.normalizeCheck(raw));
    }
    return posted;
  } finally {
    discardWorkClone(workDir);
  }
}

/** workDir にファイルを書き、commit+push の shortcut (テスト・perform topic 用). */
export function writeAndPush(repoKey, branch, files, message, gitDir = gitDirFor(repoKey)) {
  const dir = createWorkClone(repoKey, gitDir);
  try {
    for (const [rel, text] of Object.entries(files)) {
      const target = path.join(dir, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return commitAndPushBranch(dir, repoKey, branch, message, gitDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * mock の全 wire: forge.mjs を mock provider へ向け、governance を seed し、bare repo の
 * branch/mergeable/merge を git endpoint へ結線する (perform.mjs とテストの共通起動).
 * §11 mock bullet: orchestrator のコード unchanged で endpoint が mock を指すのみ。
 */
export function setupMock({ repoKey = mockServer.DEFAULT_REPO, gitDir = gitDirFor(repoKey), baseISO } = {}) {
  mockServer.resetMock({
    baseISO,
    branchProvider: makeBranchProvider(repoKey, gitDir),
    mergeHandler: makeMergeHandler(repoKey, gitDir),
    mergeableProvider: makeMergeableProvider(repoKey, gitDir),
  });
  forge.configure({ provider: 'mock' });
  mockServer.seedLabels(repoKey, forge.readConfig().labels ?? []); // bootstrap の materialize 写し (§8 — projectState.labels の突合対象は repo 定義)
  rmSync(gitDir, { recursive: true, force: true }); // throwaway — 前回の ref 残骸を消して決定論に (§11 mock bullet).
  ensureBareRepo(repoKey, gitDir);
  return { repoKey, gitDir };
}

/**
 * 録画 approve event fixture を mock store の承認記録へ流す (spec §10 M5 — P2 の「人間承認 1 回」は
 * mock の recording 応答で模擬する。mock は決定論)。事件ファイルは GitHub review raw の写し +
 * `reviewer`/`commit_id` キー (tests/mock-forge/events/approve-plan.json)。
 */
export function applyApproveEvent(eventFile, { repoKey = mockServer.DEFAULT_REPO, prId } = {}) {
  const ev = JSON.parse(readFileSync(eventFile, 'utf8'));
  const reviewer = ev.reviewer ?? ev.user?.login;
  if (!reviewer) throw new Error(`approve event に reviewer が無い: ${eventFile}`);
  void repoKey;
  return forge.approvePR(prId ?? `${repoKey}!${ev.pr ?? 1}`, reviewer, ev.commit_id ?? ev.sha ?? ev.commitId ?? undefined);
}
