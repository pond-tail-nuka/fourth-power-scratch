// scripts/bootstrap.mjs — 冪等 setup (spec §4.4): label・branch protection・workflow の materialize。
// 本番 provider のみ。mock では実行しない (spec §11 mock bullet)。forge.mjs 経由のみ使う (src から bootstrap import 不可の逆: ここは forge を呼ぶ)。
// 使い方: node scripts/bootstrap.mjs --repo <owner/name> [--check-only]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createForge } from '../src/forge.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(ROOT, '..', 'docs', 'governance', 'config.json'), 'utf8'));

function parseArgs(argv) {
  let repo = null, checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') repo = argv[++i];
    else if (argv[i] === '--check-only') checkOnly = true;
  }
  return { repo, checkOnly };
}

// runner が投稿する full 一覧 (§8 required 8 種 + accept job + no-state + peer 再取込 — protection の required_status_checks と runner 投稿が名前一致する MUST、§4.4 §7 pending 担保)。config.requiredChecks と同一の正本は config 側だが、bootstrap は file から読むためここに写す (突合は config-consistency check と assert で担保)。
const REQUIRED_CHECKS = ['accept', 'accept-immutable', 'accept-vacuity', 'risk-tier', 'review-threads', 'status-exclusivity', 'sha-approval', 'config-consistency', 'scope-guard', 'no-state', 'peer-query-reingestion'];

async function main() {
  const { repo, checkOnly } = parseArgs(process.argv.slice(2));
  if (!repo) throw new Error('--repo が必要');
  if (config.provider === 'mock') throw new Error('bootstrap は本番 provider のみ (mock では setup しない、spec §11)');
  const forge = createForge({ provider: config.provider, config });
  if (!checkOnly) {
    for (const label of config.labels) await forge.ensureLabel(repo, label);
    await forge.setProtection(repo, {
      requiredChecks: REQUIRED_CHECKS,
      requiredApprovals: 1,
      dismissStaleReviews: true,
      enforceAdmins: true,
    });
  }
  // §4.4 アサーション: setup 後状態が config と一致すること
  const prot = await forge.protection(repo);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(prot.requiredChecks.sort(), REQUIRED_CHECKS.sort())) throw new Error('required check 一覧不一致');
  if (prot.dismissStaleReviews !== true) throw new Error('dismiss_stale_reviews 無効');
  if (prot.enforceAdmins !== true) throw new Error('enforce_admins 無効');
  if (prot.requiredApprovals !== config.requiredApprovals) throw new Error('承認数不一致');
  const me = await forge.whoami();
  if (config.humanAccounts.includes(me.login) === false) throw new Error('bootstrap 実行アカウントが humanAccounts にいない (起草側は人間ログイン必須、spec §5)');
  console.log(`bootstrap ${checkOnly ? 'check' : 'setup'} ok: ${repo}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
