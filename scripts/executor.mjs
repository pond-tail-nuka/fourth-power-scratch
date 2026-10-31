// scripts/executor.mjs — 本番 executor (spec §11: mock executor stand-in の本番対応物 — 実 git clone/p-push。
// GitHub credential は gh の token store helper (credential.https://github.com.helper) を使う。秘密は argv に置かない。
// 使い: live driver (scripts/live.mjs) から呼ぶ。forge と違い git 実体操作を担う (§4.4 §7 の workDir 制)。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(ROOT, '..', 'tmp', 'live-exec');

export function slug(repo) {
  return repo.replace(/[^a-z0-9]+/i, '_');
}

function run(cwd, args) {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (p.error) throw new Error(`executor: git spawn ${args.join(' ')}: ${p.error.message}`);
  if (p.status !== 0) throw new Error(`executor: git ${args.join(' ')} failed: ${(p.stderr ?? '').trim().slice(0, 300)}`);
  return p.stdout ?? '';
}

/** BOT 起草 identity (§2.2 commets — git -c user.name/email で打つ MUST — 本番 executor も同じ打旗で書く). */
const BOT_NAME = 'fourth_power bot';
const BOT_EMAIL = 'fourth-power-bot@users.noreply.github.com';
function botIdentity() {
  return ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`];
}

function url(repo) {
  return `https://github.com/${repo}.git`;
}

/** repo のミラー (fetch 元 — work clone はローカルミラーから作り、origin は本 repo URL に張替える)。
 * 破棄→再クローン復元 (§7 restore scan の実測) は discard 後に mirror() を呼べば復元される。 */
export function mirror(repo) {
  mkdirSync(TMP, { recursive: true });
  const dir = path.join(TMP, `mirror-${slug(repo)}`);
  try {
    run(dir, ['fetch', 'origin', '--prune', '--quiet']);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    run(TMP, ['clone', '--quiet', url(repo), path.basename(dir)]);
  }
  return dir;
}

/** work clone を作る (origin は本 repo — push 先)。break→mirror から clone し origin を張替える。 */
export function createWork(repo, at = 'origin/main') {
  const m = mirror(repo);
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, `work-${slug(repo)}-`));
  run(dir, ['clone', '--quiet', '--no-checkout', m, dir]);
  run(dir, ['-c', 'core.fileMode=false', 'checkout', '--quiet', '-B', 'fp-work', at]);
  run(dir, ['remote', 'remove', 'origin']);
  run(dir, ['remote', 'add', 'origin', url(repo)]);
  run(dir, ['fetch', 'origin', '--prune', '--quiet']);
  return dir;
}

export function discard(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** branch を作って workDir の全変更を BOT identity で commit し origin へ push (§2 不変条件 2: head branch のみ — main へは張らない). */
export function commitAndPush(dir, branch, message) {
  run(dir, botIdentity().concat(['checkout', '--quiet', '-B', branch]));
  run(dir, ['add', '-A']);
  const status = run(dir, ['status', '--porcelain']);
  if (status.trim()) run(dir, botIdentity().concat(['commit', '--quiet', '-m', message]));
  run(dir, ['push', '--quiet', '--force-with-lease', 'origin', `${branch}:refs/heads/${branch}`]);
  return revParse(dir, 'HEAD');
}

/** 同一ブランチに追加 commit (空 commit でも可 — head SHA を動かす §8 stale 再照合の実測用). */
export function amendEmptyCommit(dir, branch, message) {
  run(dir, botIdentity().concat(['commit', '--quiet', '--allow-empty', '-m', message]));
  run(dir, ['push', '--quiet', '--force-with-lease', 'origin', `${branch}:refs/heads/${branch}`]);
  return revParse(dir, 'HEAD');
}

export function revParse(dir, ref) {
  return run(dir, ['rev-parse', ref]).trim();
}

export function fetchHead(dir, ref) {
  run(dir, ['fetch', 'origin', ref, '--quiet']);
  return revParse(dir, `FETCH_HEAD`);
}

/** base..head の変更ファイル一覧 (§4.1 scope-guard 入力 — runner meta の changedPaths). */
export function diffNames(dir, base, head) {
  return run(dir, ['diff', '--name-only', base, head]).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** workDir にファイルを書いて commit+push (seed・plan file 起票など — 人間起草経路も BOT でもなく呼ぶ側が打旗を選ぶ)。 */
export function writeAndPush(dir, files, message, branch) {
  if (branch) run(dir, botIdentity().concat(['checkout', '--quiet', '-B', branch]));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return commitAndPush(dir, branch ?? run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), message);
}

/** 破棄 (§7 の復元実測: 破棄後に createWork を呼び直せば main から復元される). */
export function discardWorkClone(dir) {
  discard(dir);
}
