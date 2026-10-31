// Mock forge server (spec §11 mock bullet / contract §3). GitHub REST 応答 shape の
// JSON を返す API read 経路 (conformance fixture と同一 shape) と、書き込み関数の唯一の
// 入口 (contract §3「書き込みは mockServer.mjs の関数のみ」). forge.mjs の mock provider
// は apiSend/apiGet を呼び、github provider と同じ normalizer を通ることで fixture と
// 同一 shape を担保する.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const GOVERNANCE_DIR = path.join(REPO_ROOT, 'docs', 'governance');

export const DEFAULT_REPO = 'mock/fourth_power';
export const FRAMEWORK_REPO = 'framework';
export const BOT = 'fourth-power-bot';

/** §8 の required check 全一覧 (bootstrap 相当の既定 protection). */
export const REQUIRED_CHECKS = [
  'accept',
  'accept-immutable',
  'accept-vacuity',
  'risk-tier',
  'review-threads',
  'status-exclusivity',
  'sha-approval',
  'config-consistency',
  'scope-guard',
  'no-state',
  'peer-query-reingestion',
];

class HttpError extends Error {
  constructor(status, message) {
    super(`mock HTTP ${status}: ${message}`);
    this.status = status;
  }
}

let branchProvider = null; // (repoKey, branch) => sha|null — executor が git 側から-sync して設定
let mergeHandler = null; // executor の merge (fast-forward + commit_sha)
let mergeableProvider = null; // (repoKey, baseRef, headSha) => {mergeable, mergeable_state}
let lastMerge = null; // 直近の merge 記録 {repoKey, prNumber, method, commitSha}

/** 直近の merge 記録 (executor の merge 記録と突合用). */
export function lastMergeResult() {
  return lastMerge;
}

/**
 * 決定論リセット: state をまっさらにし、framework/docs/governance をローカルから
 * seed し、既定 protection を bootstrap 相当で置く (mock は bootstrap 本番 setup を
 * 実行しない — spec §11 mock bullet).
 */
export function resetMock(opts = {}) {
  store.resetState(opts.baseISO);
  branchProvider = opts.branchProvider ?? null;
  mergeHandler = opts.mergeHandler ?? null;
  mergeableProvider = opts.mergeableProvider ?? null;
  lastMerge = null;
  seedFramework();
  store.repoEnsure(DEFAULT_REPO);
  store.repoEnsure(FRAMEWORK_REPO);
  store.repoEnsure(DEFAULT_REPO).protection = {
    required_status_checks: { strict: true, contexts: REQUIRED_CHECKS },
    required_pull_request_reviews: { dismiss_stale_reviews: true, required_approving_review_count: 1 },
    enforce_admins: true,
  };
}

/** docs/governance を framework repo の contents に seed (readConfig の provider 読み用). */
export function seedFramework(baseDir = GOVERNANCE_DIR) {
  store.repoEnsure(FRAMEWORK_REPO);
  for (const file of ['config.json', 'projects.json']) {
    try {
      let text = readFileSync(path.join(baseDir, file), 'utf8');
      // mock contents 写し: provider は mock に固定する (§11 — 本番 binding (config の provider) を
      // mock 側へ写しても provider だけ上書き。readConfig/activeProviderName の mock 自己完結検証は
      // 写し provider を期待する)。
      if (file === 'config.json') {
        const cfg = JSON.parse(text);
        cfg.provider = 'mock';
        text = `${JSON.stringify(cfg, null, 2)}\n`;
      }
      store.contentsSet(FRAMEWORK_REPO, `docs/governance/${file}`, text);
    } catch {
      // 欠損は許容 (fixture 側で seed する).
    }
  }
}

/**
 * repo の label 定義 (bootstrap の materialize 相当) を seed する — framework config.labels を反映する.
 * projectState.labels (Runner の config-consistency 突合対象) は repo 定義一覧なので、mock も repo 側で持つ (§8 の bootstrap 写し).
 * @param {string} repoKey
 @param {string[]} names 定義するラベル名 (config.labels と同一であることが bootstrap 側の検証対象になる).
 */
export function seedLabels(repoKey, names) {
  const r = store.repoEnsure(repoKey);
  r.labelDefs = [...new Set([...(r.labelDefs ?? []), ...(names ?? []).map(String)])];
  return clone(r.labelDefs.map(labelDefRaw));
}

/** branch 読み provider を差し替える (executor が bare repo 側から git 状態を正本にする). */
export function setBranchProvider(fn) {
  branchProvider = fn;
}

/** merge handler (executor). GitHub merge 応答 shape の返り値を作る. */
export function setMergeHandler(fn) {
  mergeHandler = fn;
}

/** store の branch cache (mock の ref 台帳) 上書き. */
export function setBranchSha(repoKey, branch, sha) {
  store.repoEnsure(repoKey).branches.set(branch, sha);
}

/** branch sha — provider (executor の git sync) が優先、無ければ store の branch cache をフォールバック. */
function branchSha(repoKey, branch) {
  const viaProvider = branchProvider ? branchProvider(repoKey, branch) : null;
  if (viaProvider) return viaProvider;
  return store.repoGet(repoKey)?.branches.get(branch) ?? null;
}

/** 現在の mergeable 状態 {mergeable, mergeable_state} を provider に尋ねる (無ければ unknown). */
export function computeMergeable(repoKey, baseRef, headSha) {
  if (mergeableProvider) return mergeableProvider(repoKey, baseRef, headSha);
  return { mergeable: null, mergeable_state: 'unknown' };
}

// ---------------------------------------------------------------------------
// GitHub REST shape の raw builder (conformance fixture と同一 shape)
// ---------------------------------------------------------------------------

const labelRaw = (name) => ({ name });
const labelDefRaw = (d) => ({ name: typeof d === 'string' ? d : d.name, color: (typeof d === 'object' && d.color) || 'ededed', description: (typeof d === 'object' && d.description) || null });

function issueRaw(repoKey, r) {
  return {
    number: r.number,
    title: r.title,
    body: r.body ?? '',
    state: r.state,
    labels: (r.labels ?? []).map(labelRaw),
    user: r.user,
    created_at: r.created_at,
    updated_at: r.updated_at,
    repository: { full_name: repoKey },
  };
}

function commentRaw(repoKey, n) {
  const base = {
    id: n.id,
    body: n.body,
    user: n.user,
    created_at: n.created_at,
    updated_at: n.updated_at ?? n.created_at,
  };
  if (n.kind === 'issue') {
    base.issue_url = `https://api.github.com/repos/${repoKey}/issues/${n.issue_number}`;
    base.issue_number = n.issue_number;
  } else {
    base.pull_request_url = `https://api.github.com/repos/${repoKey}/pulls/${n.pr_number}`;
    base.pull_number = n.pr_number;
  }
  return base;
}

function reviewCommentRaw(repoKey, t) {
  return {
    id: t.id,
    body: t.body ?? '',
    user: t.user,
    created_at: t.created_at,
    updated_at: t.updated_at ?? t.created_at,
    pull_number: t.pr_number,
    resolved: t.resolved,
  };
}

function pullRaw(repoKey, pr) {
  const out = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    draft: !!pr.draft,
    state: pr.state,
    merged_at: pr.merged_at ?? null,
    base: { ref: pr.base, repo: { full_name: repoKey } },
    head: { ref: pr.headRef, sha: pr.headSha, repo: { full_name: repoKey } },
    user: pr.user,
    labels: (pr.labels ?? []).map(labelRaw),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    mergeable: pr.mergeable ?? null,
    mergeable_state: pr.mergeable_state ?? 'unknown',
  };
  return out;
}

function checkRunRaw(c) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    conclusion: c.conclusion ?? null,
    head_sha: c.head_sha,
    app: { owner: { login: c.issuer } },
  };
}

/** 単一セグメント repo ('framework') は parts[2] が API 接頭辞 — owner/repo 形式と区別する. */
const API_SEGMENTS = new Set(['contents', 'issues', 'pulls', 'commits', 'branches', 'git', 'search', 'repo']);

function splitPath(pathname) {
  const parts = String(pathname).split('?')[0].split('#')[0].split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'repos') {
    throw new HttpError(400, `unsupported mock path: ${pathname}`);
  }
  if (API_SEGMENTS.has(parts[2])) return { repoKey: parts[1], cmd: parts.slice(2) };
  return { repoKey: `${parts[1]}/${parts[2]}`, cmd: parts.slice(3) };
}

function num(v, path) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `bad id in path: ${path}`);
  return n;
}

function defaultAuthor(params, body, repoKey) {
  const from = params.user ?? (body && body.user) ?? undefined;
  if (from) return { login: String(from) };
  const cfg = safeConfig();
  return { login: cfg?.botActor ?? BOT };
}

function safeConfig() {
  try {
    const text = store.contentsGet(FRAMEWORK_REPO, 'docs/governance/config.json');
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API read (GET) — GitHub 応答 JSON のみ返す (normalized は forge.mjs が共有 normalizer で変換)
// ---------------------------------------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v));

/** open PR の mergeable を読み時計算で現在値に寄せる (GitHub の background 計算の写し、決定論). */
function pullView(repoKey, pr) {
  const view = { ...pr };
  if (pr.merged_at || pr.state === 'closed') {
    view.mergeable = null;
    view.mergeable_state = 'unknown';
    return pullRaw(repoKey, view);
  }
  // GitHub の PR head は branch head を追跡する — 読み時に現在の ref へ解決して
  // 再 push (rebase) 後の stale な sha を写し直す (§7 の承認失効 §8 の sha-approval と同一土台).
  const liveSha = branchSha(repoKey, pr.headRef);
  if (liveSha) view.headSha = liveSha;
  const m = computeMergeable(repoKey, view.base ?? pr.base, view.headSha ?? pr.headSha);
  view.mergeable = m.mergeable ?? null;
  view.mergeable_state = m.mergeable_state ?? 'unknown';
  return pullRaw(repoKey, view);
}

/** GitHub REST 相当の GET. path は `/repos/{owner}/{repo}/...`. */
export function apiGet(pathname, params = {}) {
  const { repoKey, cmd } = splitPath(pathname);
  const r = store.repoGet(repoKey);
  const joinPath = cmd.join('/');
  if (cmd[0] === 'issues' && cmd.length === 1) {
    const labels = (params.labels ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const state = params.state ?? 'open';
    const list = [...(r ? r.issues.values() : [])]
      .filter((it) => (state === 'all' ? true : it.state === state))
      .filter((it) => labels.every((l) => (it.labels ?? []).includes(l)))
      .map((it) => issueRaw(repoKey, it));
    return clone(list);
  }
  if (cmd[0] === 'issues' && cmd[1] === 'comments' && cmd.length === 3) {
    const id = num(cmd[2], pathname);
    const hit = findNote(repoKey, id);
    if (!hit) throw new HttpError(404, `no comment ${id}`);
    return clone(commentRaw(hit.repoKey, hit.note));
  }
  if (cmd[0] === 'issues' && cmd.length === 2) {
    const it = r?.issues.get(num(cmd[1], pathname));
    if (!it) throw new HttpError(404, `no issue ${cmd[1]} in ${repoKey}`);
    return clone(issueRaw(repoKey, it));
  }
  if (cmd[0] === 'issues' && cmd[2] === 'comments') {
    const n = num(cmd[1], pathname);
    const list = [...(r ? r.notes.values() : [])]
      .filter((nt) => nt.kind === 'issue' && nt.issue_number === n)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((nt) => commentRaw(repoKey, nt));
    return clone(list);
  }
  if (cmd[0] === 'pulls' && cmd.length === 1) {
    const base = params.base;
    const head = params.head;
    const state = params.state ?? 'open';
    const list = [...(r ? r.prs.values() : [])]
      .filter((p) => (base ? p.base === base : true))
      .filter((p) => (head ? p.headRef === head : true))
      .filter((p) => (state === 'all' ? true : state === 'closed' ? p.state === 'closed' || !!p.merged_at : p.state === 'open' && !p.merged_at))
      .map((p) => pullView(repoKey, p));
    return clone(list);
  }
  if (cmd[0] === 'pulls' && cmd.length === 2) {
    const pr = r?.prs.get(num(cmd[1], pathname));
    if (!pr) throw new HttpError(404, `no pull ${cmd[1]} in ${repoKey}`);
    return clone(pullView(repoKey, pr));
  }
  if (cmd[0] === 'pulls' && cmd[2] === 'reviews') {
    const n = num(cmd[1], pathname);
    return clone([...(r ? r.reviews.get(n) ?? [] : [])]);
  }
  if (cmd[0] === 'pulls' && cmd[2] === 'comments' && cmd.length === 3) {
    const n = num(cmd[1], pathname);
    const list = [...(r ? r.threads.values() : [])]
      .filter((t) => t.pr_number === n)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((t) => reviewCommentRaw(repoKey, t));
    return clone(list);
  }
  if (cmd[0] === 'pulls' && cmd[1] === 'comments' && cmd.length === 3) {
    const t = r?.threads.get(num(cmd[2], pathname));
    if (!t) throw new HttpError(404, `no review comment ${cmd[2]}`);
    return clone(reviewCommentRaw(repoKey, t));
  }
  if (cmd[0] === 'pulls' && cmd[2] === 'comments' && cmd.length === 4) {
    const t = r?.threads.get(num(cmd[3], pathname));
    if (!t) throw new HttpError(404, `no review comment ${cmd[3]}`);
    return clone(reviewCommentRaw(repoKey, t));
  }
  if (cmd[0] === 'commits' && cmd[2] === 'check-runs') {
    const sha = cmd[1];
    const runs = [...(r ? r.checks.get(sha) ?? [] : [])].map(checkRunRaw);
    return { total_count: runs.length, check_runs: clone(runs) };
  }
  if (cmd[0] === 'branches' && cmd.length === 2) {
    const sha = branchSha(repoKey, cmd[1]);
    if (!sha) throw new HttpError(404, `no branch ${cmd[1]} in ${repoKey}`);
    return { name: cmd[1], commit: { sha } };
  }
  if (cmd[0] === 'branches' && cmd[2] === 'protection') {
    const prot = r?.protection;
    if (!prot) throw new HttpError(404, `no protection on ${repoKey}`);
    return clone(prot);
  }
  if (cmd[0] === 'labels' && cmd.length === 1) {
    return clone((r?.labelDefs ?? []).map(labelDefRaw));
  }
  if (cmd[0] === 'labels' && cmd.length === 2) {
    const def = (r?.labelDefs ?? []).find((d) => d === cmd[1] || (typeof d === 'object' && d.name === cmd[1]));
    if (!def) throw new HttpError(404, `no label ${cmd[1]} in ${repoKey}`);
    return clone(labelDefRaw(def));
  }
  if (cmd[0] === 'git' && cmd[1] === 'refs' && cmd[2] === 'heads') {
    const branch = cmd.slice(3).join('/');
    const sha = branchSha(repoKey, branch);
    if (!sha) throw new HttpError(404, `no ref ${branch} in ${repoKey}`);
    return { ref: `refs/heads/${branch}`, object: { sha } };
  }
  if (cmd[0] === 'contents') {
    const filePath = cmd.slice(1).join('/');
    const text = store.contentsGet(repoKey, filePath);
    if (text === null) throw new HttpError(404, `no contents ${filePath} in ${repoKey}`);
    return {
      name: path.basename(filePath),
      path: filePath,
      sha: null,
      encoding: 'base64',
      content: Buffer.from(text, 'utf8').toString('base64'),
    };
  }
  throw new HttpError(404, `no mock GET route: ${pathname}`);
}

/** 全文 search (commentCreatedAt 用). repoKey 指定は GitHub の repos/{owner}/{repo}/issues/comments/{id} 相当. */
function findNote(repoKey, id) {
  const repos = repoKey ? [[repoKey, store.repoGet(repoKey)]] : [...store.reposList()];
  for (const [key, rr] of repos) {
    const note = rr?.notes.get(id);
    if (note) return { repoKey: key, note };
  }
  return null;
}

// ---------------------------------------------------------------------------
// API write (POST/PATCH/DELETE) — 書き込みの唯一の入口 (contract §3). 応答は GitHub shape JSON.
// ---------------------------------------------------------------------------

/** GitHub REST 相当の write. */
export function apiSend(method, pathname, params = {}, body) {
  const { repoKey, cmd } = splitPath(pathname);
  const r = store.repoEnsure(repoKey);
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET') return apiGet(pathname, params);
  if (m === 'POST') return doPost(r, repoKey, cmd, pathname, params, body ?? {});
  if (m === 'PATCH') return doPatch(r, repoKey, cmd, pathname, params, body ?? {});
  if (m === 'DELETE') return doDelete(r, repoKey, cmd, pathname, params, body ?? {});
  if (m === 'PUT' && cmd[0] === 'pulls' && cmd[2] === 'merge') {
    return mergePull(r, repoKey, num(cmd[1], pathname), (body ?? {}).commit_method ?? params.commit_method ?? 'squash');
  }
  throw new HttpError(400, `no mock ${m} route: ${pathname}`);
}

function doPost(r, repoKey, cmd, pathname, params, body) {
  if (cmd[0] === 'issues' && cmd.length === 1) {
    const author = defaultAuthor(params, body, repoKey);
    const now = store.clock().advance();
    const issue = {
      number: nextNumber(r, 'issues'),
      title: body.title ?? '',
      body: body.body ?? '',
      state: 'open',
      labels: Array.isArray(body.labels) ? [...body.labels] : [],
      user: author,
      created_at: now,
      updated_at: now,
    };
    r.issues.set(issue.number, issue);
    return clone(issueRaw(repoKey, issue));
  }
  if (cmd[0] === 'issues' && cmd[2] === 'labels') {
    const it = r.issues.get(num(cmd[1], pathname));
    if (!it) throw new HttpError(404, `no issue ${cmd[1]}`);
    const add = Array.isArray(body.labels) ? body.labels : Array.isArray(body) ? body : [];
    const labels = [...new Set([...(it.labels ?? []), ...add.map(String)])];
    it.labels = labels;
    it.updated_at = store.clock().touch();
    return clone(labels.map(labelRaw));
  }
  if (cmd[0] === 'issues' && cmd[2] === 'comments') {
    const n = num(cmd[1], pathname);
    if (!r.issues.get(n)) throw new HttpError(404, `no issue ${n}`);
    const note = addNote(r, repoKey, 'issue', n, body, params);
    note.issue_number = n;
    return clone(commentRaw(repoKey, note));
  }
  if (cmd[0] === 'pulls' && cmd.length === 1) {
    return createPull(r, repoKey, pathname, body, params);
  }
  if (cmd[0] === 'pulls' && cmd[2] === 'reviews') {
    const n = num(cmd[1], pathname);
    const pr = r.prs.get(n);
    if (!pr) throw new HttpError(404, `no pull ${n}`);
    const author = defaultAuthor(params, body, repoKey);
    const review = {
      id: store.nextId(),
      user: author,
      commit_id: body.commit_id ?? pr.headSha,
      state: normalizeReviewState(body.state),
      submitted_at: store.clock().advance(),
    };
    const list = r.reviews.get(n) ?? [];
    list.push(review);
    r.reviews.set(n, list);
    return clone(review);
  }
  if (cmd[0] === 'pulls' && cmd[2] === 'comments' && cmd.length === 3) {
    const n = num(cmd[1], pathname);
    const pr = r.prs.get(n);
    if (!pr) throw new HttpError(404, `no pull ${n}`);
    const author = defaultAuthor(params, body, repoKey);
    const now = store.clock().advance();
    const thread = {
      id: store.nextId(),
      body: body.body ?? '',
      user: author,
      created_at: now,
      updated_at: now,
      pr_number: n,
      resolved: body.resolved === true,
    };
    r.threads.set(thread.id, thread);
    return clone(reviewCommentRaw(repoKey, thread));
  }
  if (cmd[0] === 'commits' && cmd[2] === 'check-runs') {
    const sha = cmd[1];
    const issuer = body.app?.owner?.login ?? body.issuer ?? (defaultAuthor(params, body, repoKey).login);
    const run = {
      id: store.nextId(),
      name: body.name ?? '',
      status: body.status ?? 'queued',
      conclusion: body.conclusion ?? null,
      head_sha: sha,
      issuer,
    };
    const runs = r.checks.get(sha) ?? [];
    const idx = runs.findIndex((c) => c.name === run.name);
    if (idx >= 0) runs[idx] = run;
    else runs.push(run);
    r.checks.set(sha, runs);
    return clone(checkRunRaw(run));
  }
  if (cmd[0] === 'labels' && cmd.length === 1) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(422, 'label name required');
    if (!r) throw new HttpError(404, `no repo ${repoKey}`);
    if (!(r.labelDefs ?? []).includes(name)) r.labelDefs = [...(r.labelDefs ?? []), name];
    return clone(labelDefRaw(body.color ? { name, color: body.color } : name));
  }
  if (cmd[0] === 'branches' && cmd[2] === 'protection') {
    r.protection = { ...body };
    return clone(r.protection);
  }
  if (cmd[0] === 'git' && cmd[1] === 'refs' && (cmd[2] === 'heads' || cmd[2] === '')) {
    const ref = cmd[2] === 'heads' ? cmd.slice(3).join('/') : String(body.ref ?? '').replace(/^refs\/heads\//, '');
    if (!ref) throw new HttpError(400, 'git refs POST requires refs/heads/<branch>');
    const sha = body.sha ?? body.object?.sha;
    if (!sha) throw new HttpError(400, 'git refs POST requires sha');
    r.branches.set(ref, sha);
    // protection.dismiss_stale_reviews の GitHub 意味 — 新 commit で旧 head SHA 紐りの APPROVED は dismiss される
    // (§8 stale 承認: 人間は新 sha への再承認が必須 — 放置は gate が検出するが、protection 設定時は自動 dismiss)。
    if (r.protection?.required_pull_request_reviews?.dismiss_stale_reviews) {
      for (const pr of r.prs.values()) {
        if (pr.headRef === ref && !pr.merged_at) {
          pr.headSha = sha; // GitHub の PR head は branch ref に追随する (§8 の突合は最新 commit SHA に対して行う)
          const kept = (r.reviews.get(pr.number) ?? []).filter((rv) => rv.commit_id === sha || rv.state !== 'APPROVED');
          r.reviews.set(pr.number, kept);
        }
      }
    }
    return { ref: `refs/heads/${ref}`, object: { sha } };
  }
  if (cmd[0] === 'contents') {
    const filePath = cmd.slice(1).join('/');
    const text = body.encoding === 'base64' ? Buffer.from(String(body.content ?? ''), 'base64').toString('utf8') : String(body.content ?? '');
    store.contentsSet(repoKey, filePath, text);
    return { content: { name: path.basename(filePath), path: filePath } };
  }
  throw new HttpError(404, `no mock POST route: ${pathname}`);
}

function nextNumber(r, kind) {
  const map = kind === 'issues' ? r.issues : r.prs;
  let n = map.size === 0 ? 1 : Math.max(...map.keys()) + 1;
  while (map.has(n)) n += 1;
  return n;
}

function addNote(r, repoKey, kind, number, body, params) {
  const author = defaultAuthor(params, body, repoKey);
  // comment の created_at は現在時刻そのもの (post した本文の `at <iso-time` と突合可能にする
  // — §3 の復元規則「本文の時刻が created_at と一致しない場合は新 comment を書き直し」の写し。
  // 次 post 用に 1 秒刻みで進む).
  const now = store.clock().peek();
  store.clock().advance();
  const note = {
    id: store.nextId(),
    kind,
    body: body.body ?? '',
    user: author,
    created_at: now,
    updated_at: now,
  };
  r.notes.set(note.id, note);
  return note;
}

function normalizeReviewState(state) {
  const s = String(state ?? 'APPROVED').toUpperCase();
  if (s === 'APPROVED' || s === 'CHANGES_REQUESTED' || s === 'COMMENTED') return s;
  return 'COMMENTED';
}

function createPull(r, repoKey, pathname, body, params) {
  const base = body.base ?? 'main';
  const head = body.head ?? '';
  const headRef = head.includes(':') ? head.split(':')[1] : head;
  const headSha = branchSha(repoKey, headRef);
  if (!headSha) throw new HttpError(422, `no branch ${headRef} in ${repoKey} — push branch first (mock bare repo ref)`);
  const author = defaultAuthor(params, body, repoKey);
  const now = store.clock().advance();
  const pr = {
    number: nextNumber(r, 'prs'),
    title: body.title ?? '',
    body: body.body ?? '',
    draft: body.draft === true,
    state: 'open',
    merged_at: null,
    base,
    headRef,
    headSha,
    user: author,
    labels: Array.isArray(body.labels) ? [...body.labels] : [],
    created_at: now,
    updated_at: now,
    mergeable: null,
    mergeable_state: 'unknown',
  };
  r.prs.set(pr.number, pr);
  return clone(pullView(repoKey, pr));
}

function doPatch(r, repoKey, cmd, pathname, params, body) {
  if (cmd[0] === 'issues' && cmd.length === 2) {
    const it = r.issues.get(num(cmd[1], pathname));
    if (!it) throw new HttpError(404, `no issue ${cmd[1]}`);
    if ('state' in body) it.state = body.state === 'closed' ? 'closed' : 'open';
    if ('title' in body) it.title = body.title;
    if ('body' in body) it.body = body.body ?? ''; // 本文編集 (humanAccounts 限定は gate 側、§5)
    if ('labels' in body) it.labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
    it.updated_at = store.clock().touch(); // 更新時刻は書き順を変えない (秒を進めない)
    return clone(issueRaw(repoKey, it));
  }
  if (cmd[0] === 'issues' && cmd[1] === 'comments' && cmd.length === 3) {
    const note = r.notes.get(num(cmd[2], pathname));
    if (!note) throw new HttpError(404, `no comment ${cmd[2]}`);
    note.body = body.body ?? '';
    note.updated_at = store.clock().touch(); // created_at は改変しない (§7 の復元 header も同じ)
    return clone(commentRaw(repoKey, note));
  }
  if (cmd[0] === 'pulls' && cmd.length === 2) {
    const pr = r.prs.get(num(cmd[1], pathname));
    if (!pr) throw new HttpError(404, `no pull ${cmd[1]}`);
    if ('state' in body) pr.state = body.state === 'close' || body.state === 'closed' ? 'closed' : 'open';
    if ('draft' in body) pr.draft = body.draft === true;
    if ('base' in body) pr.base = body.base; // rebase の写し — base 変更で mergeable 再評価
    if ('head' in body) {
      const ref = String(body.head).includes(':') ? String(body.head).split(':')[1] : String(body.head);
      const sha = branchSha(repoKey, ref);
      if (!sha) throw new HttpError(422, `no branch ${ref}`);
      pr.headRef = ref;
      pr.headSha = sha;
    }
    if ('body' in body) pr.body = body.body ?? '';
    pr.updated_at = store.clock().touch();
    return clone(pullView(repoKey, pr));
  }
  if (cmd[0] === 'pulls' && cmd[1] === 'comments' && cmd.length === 3) {
    const t = r.threads.get(num(cmd[2], pathname));
    if (!t) throw new HttpError(404, `no review comment ${cmd[2]}`);
    if ('resolved' in body) t.resolved = body.resolved === true;
    if ('body' in body) t.body = body.body ?? '';
    t.updated_at = store.clock().touch();
    return clone(reviewCommentRaw(repoKey, t));
  }
  throw new HttpError(404, `no mock PATCH route: ${pathname}`);
}

function doDelete(r, repoKey, cmd, pathname, params, body) {
  if (cmd[0] === 'issues' && cmd[2] === 'labels' && cmd.length === 4) {
    const it = r.issues.get(num(cmd[1], pathname));
    if (!it) throw new HttpError(404, `no issue ${cmd[1]}`);
    it.labels = (it.labels ?? []).filter((l) => l !== cmd[3]);
    it.updated_at = store.clock().touch();
    return clone(it.labels.map(labelRaw));
  }
  if (cmd[0] === 'issues' && cmd[1] === 'comments' && cmd.length === 3) {
    const id = num(cmd[2], pathname);
    if (!r.notes.delete(id)) throw new HttpError(404, `no comment ${id}`);
    return null;
  }
  if (cmd[0] === 'pulls' && cmd[1] === 'comments' && cmd.length === 3) {
    const id = num(cmd[2], pathname);
    if (!r.threads.delete(id)) throw new HttpError(404, `no review comment ${id}`);
    return null;
  }
  if (cmd[0] === 'pulls' && cmd[2] === 'reviews' && cmd.length === 4) {
    const n = num(cmd[1], pathname);
    const id = num(cmd[3], pathname);
    const list = r.reviews.get(n) ?? [];
    const rest = list.filter((rv) => rv.id !== id);
    if (rest.length === list.length) throw new HttpError(404, `no review ${id} in pr ${n}`);
    r.reviews.set(n, rest);
    return null;
  }
  if (cmd[0] === 'labels' && cmd.length === 2) {
    const defs = r?.labelDefs ?? [];
    const rest = defs.filter((d) => d !== cmd[1] && !(typeof d === 'object' && d.name === cmd[1]));
    if (rest.length === defs.length) throw new HttpError(404, `no label ${cmd[1]} in ${repoKey}`);
    r.labelDefs = rest;
    return null;
  }
  if (cmd[0] === 'git' && cmd[1] === 'refs' && cmd[2] === 'heads') {
    const branch = cmd.slice(3).join('/');
    if (!r.branches.delete(branch)) throw new HttpError(404, `no ref ${branch}`);
    return null;
  }
  throw new HttpError(404, `no mock DELETE route: ${pathname}`);
}

/**
 * PR マージ (PUT merges/{n} — GitHub の merge 応答 shape). 記録は store の merged のみ.
 * 実際の branch fast-forward は executor の mergeHandler が git 側で行う (contract §3).
 * gate 再照合 (§8) は apiSend 側で行う (protection + required checks + head 突合の同期照合の写し).
 */
function mergePull(r, repoKey, number, method) {
  const pr = r.prs.get(number);
  if (!pr) throw new HttpError(404, `no pull ${number}`);
  if (pr.state !== 'open') throw new HttpError(409, `pull ${number} is ${pr.merged_at ? 'merged' : 'closed'} — merge 不能`);
  const view = pullView(repoKey, pr);
  if (view.mergeable === false || view.mergeable_state === 'dirty') {
    throw new HttpError(409, `pull ${number} mergeable=${view.mergeable_state} — gate 再照合 fail (§8 race)`);
  }
  const methodNorm = ['squash', 'merge', 'rebase'].includes(method) ? method : 'squash';
  // GitHub の branch protection は commit_method を問わず required check / 承認 / thread を強制 (§2 invariant 4・§8)。
  const required = r.protection?.required_status_checks?.contexts ?? [];
  const runs = [...(r.checks.get(pr.headSha) ?? [])];
  const byName = new Map(runs.map((c) => [c.name, c]));
  for (const name of required) {
    const c = byName.get(name);
    if (!c || c.status !== 'completed' || c.conclusion !== 'success') {
      throw new HttpError(409, `required check ${name} が green でない (head ${pr.headSha}) — マージ阻止 (invariant 4)`);
    }
  }
  const approvals = (r.reviews.get(number) ?? []).filter((rv) => rv.state === 'APPROVED' && rv.commit_id === pr.headSha);
  const need = r.protection?.required_pull_request_reviews?.required_approving_review_count ?? 0;
  if (approvals.length < need) {
    throw new HttpError(409, `承認 ${approvals.length}/${need} — マージ阻止 (§8 protection 承認数・sha-approval の二重検証写し)`);
  }
  const openThreads = [...r.threads.values()].filter((t) => t.pr_number === number && !t.resolved).length;
  if (openThreads > 0) throw new HttpError(409, `open review thread ${openThreads} — review-threads fail (§8)`);
  if (mergeHandler) {
    const res = mergeHandler({ repoKey, prNumber: number, method: methodNorm, headSha: pr.headSha, baseRef: pr.base });
    lastMerge = { repoKey, prNumber: number, method: methodNorm, commitSha: res?.commit_sha ?? null };
    pr.state = 'open'; // handler が branch を動かし、下記の store 記録で merged へ
  } else {
    lastMerge = { repoKey, prNumber: number, method: methodNorm, commitSha: pr.headSha };
  }
  pr.merged_at = store.clock().advance();
  pr.updated_at = pr.merged_at;
  pr.mergeable = null;
  pr.mergeable_state = 'unknown';
  return {
    result: 'success',
    merge: { sha: lastMerge.commitSha ?? pr.headSha, merged_at: pr.merged_at, method: methodNorm },
  };
}

/** GitHub の contents GET を base64 で読む (mock の framework docs/governance 含む). */
export function getContents(repoKey, filePath) {
  const text = store.contentsGet(repoKey, filePath);
  if (text === null) return null;
  return { encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') };
}

/** base64 応答 JSON から UTF8 テストをデコード (forge.mjs の readConfig も使う). */
export function decodeContentJson(contentJson) {
  const enc = contentJson?.encoding ?? 'base64';
  if (enc !== 'base64') throw new HttpError(400, `unsupported content encoding ${enc}`);
  return Buffer.from(String(contentJson.content ?? ''), 'base64').toString('utf8');
}

