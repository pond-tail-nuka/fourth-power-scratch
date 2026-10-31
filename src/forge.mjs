// fourth_power forge adapter (spec §2.5: src/forge.mjs のみ — read/write の唯一経路.
// §2 不変条件 5: ここら fs 永続化・ローカル DB・ロックを持たない. provider 選択は
// forge provider のみ (§1 の語分解), §11 mock bullet の mock provider は tests/mock-forge
// の API JSON を読み書きする (orchestrator と同一 code path を通す — §11 conformance 一致).

import { spawnSync } from 'node:child_process';

import * as mock from '../tests/mock-forge/mockServer.mjs';

/** @typedef {import('./types.mjs') Issue} */
/** @typedef {import('./types.mjs') ChangeRequest} */
/** @typedef {import('./types.mjs') Note} */
/** @typedef {import('./types.mjs') Check} */
/** @typedef {import('./types.mjs') Approval} */
/** @typedef {import('./types.mjs') ReviewThread} */
/** @typedef {import('./types.mjs') Protection} */

export const COHORT_LABELS = ['cohort:fast', 'cohort:typical', 'cohort:slow'];
export const PEER_ANSWER_LABEL = 'peer:answer';
export const FRAMEWORK_REPO_DEFAULT = 'framework';

const RE = /^(\d+)$/;
const RE_QUAL = /^(.*)([#!])(\d+)(?:\/(\d+))?$/;

// --- id 書式 (§1 の normalized id) ----------------------------------------
// issue: `${repo}#${number}` (GitHub の repo+number の写し), pr: `${repo}!${number}`,
// note: `${repo}[#!]${number}/${commentId}`. 数値だけ (GitHub の issue/comment id) は
// projects.json の既定 repo へ解決する.

/** id を {repo, kind:'issue'|'pr', number, commentId} へ。 */
export function parseId(id, expectKind) {
  const s = String(id);
  if (RE.test(s)) return { repo: defaultRepo(), kind: expectKind ?? 'issue', number: Number(s), commentId: null };
  const m = RE_QUAL.exec(s);
  if (!m) throw new Error(`forge: bad id ${s}`);
  return { repo: m[1] || defaultRepo(), kind: m[2] === '#' ? 'issue' : 'pr', number: Number(m[3]), commentId: m[4] ? Number(m[4]) : null };
}

const issuePath = (p) => `repos/${p.repo}/issues/${p.number}`;
const prPath = (p) => `repos/${p.repo}/pulls/${p.number}`;
const notePath = (p) => {
  if (p.commentId == null) throw new Error(`forge: note id requires /<commentId>: ${String(p)}`);
  return p.kind === 'pr'
    ? `repos/${p.repo}/pulls/comments/${p.commentId}`
    : `repos/${p.repo}/issues/comments/${p.commentId}`;
};

// --- 共有 normalizer (github provider の conformance 応答 JSON と同一 shape を mock も返す) ---
const labelsOf = (raw) => (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
const authorOf = (raw) => raw.user?.login ?? raw.author ?? '';

/** @returns {Issue} */
export function normalizeIssue(raw) {
  const repo = raw.repository?.full_name ?? defaultRepo();
  return {
    id: `${repo}#${raw.number}`,
    number: raw.number,
    repo,
    title: raw.title ?? '',
    body: raw.body ?? '',
    author: authorOf(raw),
    labels: labelsOf(raw),
    state: raw.state,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at ?? raw.created_at,
  };
}

/** @returns {ChangeRequest} */
export function normalizeChangeRequest(raw) {
  const repo = raw.head?.repo?.full_name ?? raw.base?.repo?.full_name ?? defaultRepo();
  const state = raw.merged_at ? 'merged' : raw.state;
  return {
    id: `${repo}!${raw.number}`,
    number: raw.number,
    repo,
    base: raw.base?.ref ?? '',
    headSha: raw.head?.sha ?? '',
    author: authorOf(raw),
    draft: !!raw.draft,
    labels: labelsOf(raw),
    mergeable: raw.mergeable ?? null,
    state,
    body: raw.body ?? '',
  };
}

/** @returns {Note} */
export function normalizeNote(raw) {
  const issueUrl = raw.issue_url ?? '';
  const prUrl = raw.pull_request_url ?? '';
  const repoFromUrl = (u) => {
    const m = /\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\//.exec(u);
    return m ? m[1] : null;
  };
  const repo = repoFromUrl(raw.pull_number != null ? prUrl : issueUrl) ?? repoFromUrl(prUrl) ?? defaultRepo();
  const prNumber = raw.pull_number ?? null;
  const issueNumber = raw.issue_number ?? null;
  const kind = prNumber != null ? '!' : '#';
  return {
    id: `${repo}${kind}${prNumber ?? issueNumber ?? 0}/${raw.id}`,
    author: authorOf(raw),
    body: raw.body ?? '',
    createdAt: raw.created_at,
    prNumber,
    issueNumber,
    resolved: raw.resolved ?? null,
  };
}

/** @returns {Check} */
export function normalizeCheck(raw) {
  const done = raw.status === 'completed';
  const state = !done || raw.conclusion === null ? 'pending' : raw.conclusion === 'success' ? 'success' : 'failure';
  return {
    name: raw.name,
    state,
    headSha: raw.head_sha,
    issuer: raw.app?.owner?.login ?? raw.issuer ?? '',
  };
}

/** @returns {Approval} */
export function normalizeApproval(raw) {
  return { reviewer: raw.user?.login ?? '', sha: raw.commit_id ?? '' };
}

/** @returns {ReviewThread} */
export function normalizeThread(raw) {
  return { id: String(raw.id), resolved: !!raw.resolved };
}

/** @returns {Protection} */
export function normalizeProtection(raw) {
  const reviews = raw?.required_pull_request_reviews ?? null;
  const enforce = raw?.enforce_admins;
  return {
    requiredChecks: raw?.required_status_checks?.contexts ?? [],
    requiredApprovals: reviews?.required_approving_review_count ?? 0,
    dismissStaleReviews: !!reviews?.dismiss_stale_reviews,
    enforceAdmins: enforce === true || enforce?.enabled === true,
  };
}

// ---------------------------------------------------------------------------
// provider 選択 (github / mock) (§1 §2.6 §11)
// ---------------------------------------------------------------------------

let providerOverride = null; // configure({provider}) で上書き。 null → config の provider に従う.
let configCache = null;
let projectsCache = null;

/**
 * gh api の read/write ラッパー (github provider の唯一の forge 送経路). 秘密は
 * gh の token store が保持するため argv に置かない。 body は stdin (`--input -`) で渡す.
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} path
 * @param {Record<string, string|number>|undefined} params
 * @param {object|null} body
 */
function ghSend(method, path, params, body) {
  const args = ['api', path, '-X', method, '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined && body !== null) args.push('--input', '-');
  else {
    for (const [k, v] of Object.entries(params ?? {})) args.push('-p', `${k}=${v}`);
  }
  const proc = spawnSync('gh', args, {
    input: body === undefined || body === null ? '' : JSON.stringify(body),
    encoding: 'utf8',
  });
  if (proc.error) throw new Error(`forge: gh api spawn failed: ${proc.error.message}`);
  if (proc.status !== 0) {
    throw new Error(`forge: gh api ${method} ${path} failed (status ${proc.status}): ${(proc.stderr ?? '').trim().slice(0, 400)}`);
  }
  const out = proc.stdout ?? '';
  if (!out.trim()) return null;
  return JSON.parse(out);
}

const githubProvider = {
  name: 'github',
  get(path, params) {
    return ghSend('GET', path, params, undefined);
  },
  send(method, path, params, body) {
    return ghSend(method, path, params, body ?? null);
  },
};

const mockProvider = {
  name: 'mock',
  get(path, params) {
    return mock.apiGet(path, params ?? {});
  },
  send(method, path, params, body) {
    return mock.apiSend(method, path, params ?? {}, body ?? null);
  },
};

function apiFor(name) {
  if (name === 'mock') return mockProvider;
  if (name === 'github') return githubProvider;
  throw new Error(`forge: unknown forge provider: ${name}`);
}

/** bootstrap provider 名 (config 読み前の既定 — mock は §11 のテスト providerのみ). */
function bootstrapProviderName() {
  return providerOverride ?? process.env.FP_FORGE_PROVIDER ?? 'mock';
}

function api() {
  return apiFor(configCache ? (providerOverride ?? configCache.provider ?? 'mock') : bootstrapProviderName());
}

function frameworkRepo(cfg) {
  return cfg?.frameworkRepo ?? FRAMEWORK_REPO_DEFAULT;
}

function decodeContent(raw) {
  if (raw == null) throw new Error('forge: empty contents response');
  if (raw.encoding !== 'base64') throw new Error(`forge: unsupported encoding ${raw.encoding}`);
  return Buffer.from(String(raw.content ?? ''), 'base64').toString('utf8');
}

/** framework repo の docs/governance/config.json を provider API read で読む (§2.6). */
export function readConfig() {
  if (configCache && providerOverride === null) return configCache;
  const boot = apiFor(bootstrapProviderName());
  const repo = providerOverride === 'mock' ? FRAMEWORK_REPO_DEFAULT : configCache?.frameworkRepo ?? FRAMEWORK_REPO_DEFAULT;
  const raw = boot.get(`repos/${repo}/contents/docs/governance/config.json`);
  const cfg = JSON.parse(decodeContent(raw));
  configCache = cfg;
  return cfg;
}

/** framework repo の docs/governance/projects.json を読む (§2.6 — 既定 repo の解決に使う). */
export function readProjects() {
  if (projectsCache && providerOverride === null) return projectsCache;
  const cfg = readConfig();
  const boot = apiFor(providerOverride ?? cfg.provider ?? 'mock');
  const raw = boot.get(`repos/${frameworkRepo(cfg)}/contents/docs/governance/projects.json`);
  const pj = JSON.parse(decodeContent(raw));
  projectsCache = pj;
  return pj;
}

function defaultRepo() {
  try {
    return readProjects()?.default?.repo ?? mock.DEFAULT_REPO;
  } catch {
    return mock.DEFAULT_REPO;
  }
}

/**
 * 起動時の provider 選択 (§1 — プロジェクトは単一 forge provider を MUST バインド).
 * 既定は config.json / projects.json の provider (mock 既定). 実行時に差し替えても
 * read/write の唯一経路はここだけ (§2 不変条件 5).
 * @param {{provider?: 'github'|'mock', config?: object}} opts
 */
export function configure(opts = {}) {
  if (opts.provider !== undefined) {
    apiFor(opts.provider); // 検証
    providerOverride = opts.provider;
  }
  if (opts.config) {
    configCache = opts.config;
    if (opts.provider) configCache.provider = opts.provider;
  }
  projectsCache = opts.projects ?? null;
}

/** 現在の forge provider 名 (orchestrator の scan が同一 code path であることを照らす). */
export function activeProviderName() {
  return configCache ? (providerOverride ?? configCache.provider ?? 'mock') : bootstrapProviderName();
}

// ---------------------------------------------------------------------------
// read (contract §2 の唯一経路)
// ---------------------------------------------------------------------------

/** Issue 一覧 (scan の窓 — label・state 窓を provider の可視フィールドから読む、§7). */
export function scanIssues(repo, { labels = [], state = 'open' } = {}) {
  const key = repo ?? defaultRepo();
  const raw = api().get(`repos/${key}/issues`, { state, labels: labels.join(',') });
  return (raw ?? []).map((it) => normalizeIssue(it));
}

/**
 * needs-info scan (contract §2: label needs-info + cohort fast/typical/slow、
 * exempt の peer:answer は除外).
 */
export function scanNeedsInfo(repo) {
  return scanIssues(repo, { labels: ['needs-info'] }).filter(
    (i) => COHORT_LABELS.some((c) => i.labels.includes(c)) && !i.labels.includes(PEER_ANSWER_LABEL),
  );
}

/** @returns {Issue} */
export function issue(id) {
  return normalizeIssue(api().get(issuePath(parseId(id, 'issue'))));
}

/**
 * Issue に対応する open PR (head branch 名 §7 の規約 `llm/issue-<N>-<slug>` と照合)。
 * 本文に `Closes #N` keyword は書かない (§3 — gate が scan して拒否)。照合は branch 名のみ。
 */
export function prsForIssue(repo, number, { state = 'open' } = {}) {
  const key = repo ?? defaultRepo();
  const raw = api().get(`repos/${key}/pulls`, { state });
  return (raw ?? [])
    .filter((p) => new RegExp(`^llm/issue-${number}-`).test(p.head?.ref ?? ''))
    .map((p) => normalizeChangeRequest(p));
}

/** Issue/PR の note (claim・要約・finding thread — GitHub raw を §12 で読む、§11). */
export function notes(id) {
  const p = parseId(id, 'issue');
  const raw = p.kind === 'pr' ? api().get(`repos/${p.repo}/pulls/${p.number}/comments`) : api().get(`repos/${p.repo}/issues/${p.number}/comments`);
  return (raw ?? []).map((n) => normalizeNote(n));
}

/** PR head の check 状態 (§7 の決定表入力 — 決定表は gate の再照合と同一の読み、§8).
 * github では legacy status も合わせる: postCheck (github) は status API に投稿するので combined status も読む
 * (description の `fp:issuer=` tag から canonical issuer を復元する、§8 正規化の写し). */
export function checks(prId) {
  const p = parseId(prId, 'pr');
  const sha = branchSha(prId);
  const raw = api().get(`repos/${p.repo}/commits/${sha}/check-runs`);
  const out = (raw?.check_runs ?? []).map((c) => normalizeCheck(c));
  if (activeProviderName() === 'github') {
    try {
      const st = api().get(`repos/${p.repo}/commits/${sha}/status`);
      for (const s of st?.statuses ?? []) {
        const iss = /fp:issuer=(\S+)/.exec(String(s.description ?? ''))?.[1] ?? '';
        out.push({
          name: s.context,
          state: s.status === 'success' ? 'success' : s.status === 'failure' ? 'failure' : 'pending',
          headSha: s.sha ?? sha,
          issuer: iss,
        });
      }
    } catch { /* status 未投稿 — combined 404 は check なしとみなす (pending 側で担保、§7) */ }
  }
  return out;
}

/** approving review 記録 (tier 判定の承認記録は §8 の再照合で個別に読む、§11). */
export function approvals(prId) {
  const p = parseId(prId, 'pr');
  const raw = api().get(`repos/${p.repo}/pulls/${p.number}/reviews`);
  return (raw ?? []).filter((rv) => String(rv.state).toUpperCase() === 'APPROVED').map((rv) => normalizeApproval(rv));
}

/** review thread (§11 — unresolved discussion の写し). */
export function threads(prId) {
  const p = parseId(prId, 'pr');
  const raw = api().get(`repos/${p.repo}/pulls/${p.number}/comments`);
  return (raw ?? []).map((n) => normalizeThread(n));
}

/** PR head の現在 SHA (§7 の branch 規約の ref 読み — 再 push 後は新しい sha を返す). */
export function branchSha(prId) {
  const p = parseId(prId, 'pr');
  const pr = api().get(prPath(p));
  const head = api().get(`repos/${p.repo}/git/refs/heads/${pr.head?.ref}`);
  return head?.object?.sha ?? pr.head?.sha ?? null;
}

/** branch protection (§11 Protection の写し — 無ければ無効既定). */
export function protection(repo) {
  try {
    return normalizeProtection(api().get(`repos/${repo ?? defaultRepo()}/branches/main/protection`));
  } catch {
    return normalizeProtection(null);
  }
}

/** 実行アカウントの確認 (§4.4 bootstrap の whoami 突合 — github は gh token の login, mock は人間 actor の写し). */
export function whoami() {
  if (activeProviderName() === 'mock') {
    return { login: (readConfig().humanAccounts ?? [mock.BOT])[0] };
  }
  const raw = api().get('user');
  return { login: raw?.login ?? '' };
}

/** bootstrap の label materialize (§4.4 — re-run 可: 既存は 409/422 を無視して成功とみなす). */
export function ensureLabel(repo, label) {
  const key = repo ?? defaultRepo();
  try {
    api().send('POST', `repos/${key}/labels`, undefined, { name: label, color: '5319e7', description: `fourth_power §1 ${label}` });
    return true;
  } catch (e) {
    if (/status 4(09|22)|already exists/.test(String(e?.message ?? e))) return true;
    throw e;
  }
}

/** bootstrap の branch protection materialize (§4.4). github は PUT (enforce_admins は別 endpoint)、mock は POST で同一効果. */
export function setProtection(repo, prot) {
  const key = repo ?? defaultRepo();
  const body = {
    required_status_checks: { strict: true, contexts: prot.requiredChecks ?? [] },
    required_pull_request_reviews: {
      dismiss_stale_reviews: prot.dismissStaleReviews === true,
      required_approving_review_count: prot.requiredApprovals ?? 0,
    },
    enforce_admins: prot.enforceAdmins === true,
  };
  if (activeProviderName() === 'mock') {
    api().send('POST', `repos/${key}/branches/main/protection`, undefined, body);
    return true;
  }
  api().send('PUT', `repos/${key}/branches/main/protection`, undefined, body);
  api().send('PUT', `repos/${key}/branches/main/protection/enforce_admins`, undefined, {});
  return true;
}

/** repo の label 定義一覧 (bootstrap の materialize 一覧 — config-consistency の突合対象, §8). */
export function repoLabels(repo) {
  const raw = api().get(`repos/${repo ?? defaultRepo()}/labels`);
  return (raw ?? []).map((l) => (typeof l === 'string' ? l : l.name));
}

/** comment の created_at 正規値 (§3 — claim 突合の正。hidden を含め raw を返す). */
export function commentCreatedAt(noteId) {
  const raw = api().get(notePath(parseId(String(noteId), 'issue')));
  return raw?.created_at ?? null;
}

/** GitHub の PR 生応答 (§8 の再照合が mergeable_state を個別読むための写し経路). */
export function prJson(prId) {
  return api().get(prPath(parseId(prId, 'pr')));
}

// ---------------------------------------------------------------------------
// write (contract §2 の唯一経路)
// ---------------------------------------------------------------------------

/** 状態ラベルの単一集合 (§1 排他 invariant) — 同一集合内のラベルは他を除去して設定する. */
const STATE_LABELS = ['backlog', 'claimed', 'in_review', 'rebase_required', 'blocked/budget', 'blocked/spec-gap', 'blocked/infra', 'done'];

/** §1 のラベル排他に対応する集合キー (状態ラベルは bare な `blocked` を使わない、§1). */
function labelClass(label) {
  if (STATE_LABELS.includes(label)) return 'state';
  if (label.startsWith('blocked/')) return 'state';
  if (label.startsWith('cohort:')) return 'cohort';
  if (label.startsWith('accept:')) return 'accept';
  if (label.startsWith('plan:')) return 'plan';
  if (label.startsWith('risk:')) return 'risk';
  if (label.startsWith('exempt:')) return 'exempt';
  if (label.startsWith('peer/')) return 'peer';
  return null;
}

/** 排他ラベル設定 (§1 invariant — 同一集合 (state/cohort 等) 内の旧ラベルは除去して設定する). */
export function setLabel(issueId, label) {
  const p = parseId(issueId, 'issue');
  const cur = (api().get(issuePath(p)).labels ?? []).map((l) => String(l?.name ?? l));
  const cls = labelClass(label);
  // DELETE 先・POST 後 (§1 invariant: 同一クラスの旧ラベルを先に消す — 排他ラベルが一瞬でも 2 本共存する窓を作らない)。
  if (cls) {
    const others = cur.filter((l) => l !== label && labelClass(l) === cls);
    for (const o of others) api().send('DELETE', `${issuePath(p)}/labels/${encodeURIComponent(o)}`);
  }
  const added = api().send('POST', `${issuePath(p)}/labels`, undefined, { labels: [label] });
  return { added: added ?? null };
}

export function removeLabel(issueId, label) {
  const p = parseId(issueId, 'issue');
  api().send('DELETE', `${issuePath(p)}/labels/${encodeURIComponent(label)}`);
  return true;
}

/**
 * comment の post (claim comment edit は禁止 — postComment のみ、§3). created_at は provider の
 * 決定論的正規値 (mock clock の秒刻み) をそのまま返す (§3 の突合で `at <iso-time` と照合).
 * @returns {{noteId: string, createdAt: string}}
 */
export function postComment(issueId, body, { author } = {}) {
  const p = parseId(issueId, 'issue');
  const raw = api().send('POST', `${issuePath(p)}/comments`, author ? { user: author } : undefined, { body });
  const note = normalizeNote(raw);
  return { noteId: note.id, createdAt: note.createdAt };
}

export function closePR(prId) {
  api().send('PATCH', prPath(parseId(prId, 'pr')), undefined, { state: 'close' });
  return true;
}

/**
 * PR マージ (method 既定は config の mergeMethod — §2.2 squash 既定。mock の executor が
 * base branch へ fast-forward して git の履歴直線を写す. §8 の再照合は merge 直前の
 * API 同期照合として mockServer 側で行う). gate 通過前拒否 (§6) は loop.mjs が merge 前に
 * decide/ggate を通すため、ここは protection + required checks + head SHA 再照合のみで守る.
 */
export function mergePR(prId, method, { adminOverride = false } = {}) {
  const p = parseId(prId, 'pr');
  const m = method ?? readConfig().mergeMethod ?? 'squash';
  // adminOverride は GitHub の admin merge bypass と同じ効果 (enforce_admins OFF の repo で admin token の PUT merge が
  // required check/review を bypass する — night proxy の人間介入、§9 不算入記録). 既定は protection 遵守のまま.
  const res = api().send('PUT', `${prPath(p)}/merge`, undefined, { commit_method: m });
  // GitHub 本体は成功時に message-only の応答を返す (result 写しは mock の conformance 形状、§11)。
  const ok = res && (res.result === 'success' || res.merged === true || (activeProviderName() === 'github' && res.message));
  if (!ok) {
    throw new Error(`forge: mergePR ${p.repo}!${p.number} failed (gate 再照合 fail)`);
  }
  return { merged: true, mergeSha: res.merge?.sha ?? null };
}

/** §2.2 invariant 2 の direct push 拒否の写し — PR base へ head を push する経路は持たない. */
function assertBaseSafe(repo, branch, base) {
  if (branch === base) {
    throw new Error(`forge: direct push to ${branch} is banned (spec §2 不変条件 2) — PR head branch を使うこと`);
  }
}

/**
 * PR 作成 (§7 の branch 規約 `llm/issue-<N>-<slug>` を MUST 検証). head branch は mock の
 * bare repo の ref に push 済みであること (executor が ref を持つ、§11 mock bullet).
 * @returns {ChangeRequest}
 */
export function createPR({ repo, head, base = 'main', title, body = '', draft = false, author, labels = [] } = {}) {
  const key = repo ?? defaultRepo();
  assertBaseSafe(key, head, base);
  const m = /^llm\/issue-(\d+)-.+/.exec(head);
  if (!m) throw new Error(`forge: head branch ${head} must match llm/issue-<N>-<slug> (spec §7)`);
  const raw = api().send('POST', `repos/${key}/pulls`, author ? { user: author } : undefined, { title, head, base, body, draft, labels });
  return normalizeChangeRequest(raw);
}

export function closeIssue(issueId) {
  api().send('PATCH', issuePath(parseId(issueId, 'issue')), undefined, { state: 'closed' });
  return true;
}

/**
 * Issue 起票 (Draft ページ & orchestrator の同一経路 — §5 の入力契約は gh 承認済み token の
 * 人間呼び出し。mock は author を body で受ける conformance 応答を返す).
 * @returns {Issue}
 */
export function draftIssue({ repo, title, body = '', labels = [], author } = {}) {
  const key = repo ?? defaultRepo();
  const raw = api().send('POST', `repos/${key}/issues`, author ? { user: author } : undefined, { title, body, labels });
  return normalizeIssue(raw);
}

/**
 * PR head の再 base (rebase の写し — GitHub の PR base 再指定と同じ効果。dirty 解消後の
 * 再検証用、§7)。mock は base 変更のみ記録し、git の fast-forward は executor が行う。
 */
export function rebasePR(prId, base) {
  const p = parseId(prId, 'pr');
  const pr = api().get(prPath(p));
  assertBaseSafe(p.repo, pr.head?.ref, base);
  return normalizeChangeRequest(api().send('PATCH', prPath(p), undefined, { base }));
}

/** PR の draft→ready 転換 (§8 の ready 前 verifier turn 通過後 orchestrator が呼ぶ). */
export function markPRReady(prId) {
  const p = parseId(prId, 'pr');
  return normalizeChangeRequest(api().send('PATCH', prPath(p), undefined, { draft: false }));
}

/** 人間・bootstrap 由来の承認記録 (GitHub の approving review の写し — §8 tier 判定入力). */
export function approvePR(prId, reviewer, sha) {
  const p = parseId(prId, 'pr');
  return api().send('POST', `${prPath(p)}/reviews`, { user: reviewer }, { state: 'APPROVED', commit_id: sha });
}

/** review thread の作成 (verifier finding — §8 の open thread としてマージを阻止する). */
export function addReviewThread(prId, body, { resolved = false, author } = {}) {
  const p = parseId(prId, 'pr');
  return api().send('POST', `${prPath(p)}/comments`, author ? { user: author } : undefined, { body, resolved });
}

/** thread 解決 (fix もしくは理由付き resolve のみ、§8 — 放置は review-threads が fail). */
export function resolveThread(prId, threadId, resolved = true) {
  const p = parseId(prId, 'pr');
  return api().send('PATCH', `repos/${p.repo}/pulls/comments/${threadId}`, undefined, { resolved });
}

/** canonical bot 由来の check post (§8 issuer 正規化. executor の mockMerge 側も同一経路。
 * github provider は legacy status API に投稿する (check-runs API は GitHub App token 専用で PAT では作れないため、
 * 写しとして statuses に `fp:issuer=` tag を刻む — checks() が combined status から復元する、§8)。 */
export function postCheck(prId, check, issuer) {
  const p = parseId(prId, 'pr');
  const head = branchSha(prId);
  const iss = issuer ?? readConfig().botActor ?? mock.BOT;
  if (activeProviderName() === 'github') {
    const state = check.state === 'success' ? 'success' : check.state === 'failure' ? 'failure' : 'pending';
    return api().send('POST', `repos/${p.repo}/statuses/${head}`, undefined, {
      state,
      context: check.name,
      description: `fourth_power §8 fp:issuer=${iss}`,
      target_url: `https://github.com/${p.repo}`,
    });
  }
  const conclusion = check.state === 'pending' ? null : check.state === 'success' ? 'success' : 'failure';
  return api().send(
    'POST',
    `repos/${p.repo}/commits/${head}/check-runs`,
    undefined,
    { name: check.name, status: check.state === 'pending' ? 'queued' : 'completed', conclusion, head_sha: head, app: { owner: { login: issuer ?? readConfig().botActor ?? mock.BOT } } },
  );
}

/** GitHub shape の raw note を normalized id へ変換する経路 (gate/budget が §3 の突合で使う). */
export function noteJson(id) {
  return api().get(notePath(parseId(String(id), 'issue')));
}

/** provider の API read を直接読む脱漏経路 (framework docs の fixture 読取用 — read のみ). */
export function apiGet(pathname, params) {
  return api().get(pathname, params);
}

