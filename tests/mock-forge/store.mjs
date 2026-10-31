// Mock forge store (spec §11 mock bullet / contract §3). normalized object model
// (§1・src/types.mjs) を GitHub API 応答 shape (conformance fixture と同一 shape、§3) の
// raw JSON で保持する。書き込みは mockServer.mjs の関数のみ — store は model と
// read 走査・突合関数だけ持つ。createdAt は clock.mjs の決定論 fixed clock (1 秒刻み)。

import { createMockClock, fixedISO, isoSecond, secondMs } from './clock.mjs';

export { fixedISO, isoSecond, secondMs };

/**
 * 内部 state: repo ごとの normalized raw (GitHub shape).
 *   repo store = { issues: Map<number,raw>, prs: Map<number,raw>, notes: Map<commentId,raw>,
 *                  reviews: Map<prNumber,raw[]>, threads: Map<id,raw>, checks: Map<sha,raw[]>,
 *                  contents: Map<path,string>, protection: raw|null, branches: Map<branch,sha> }
 * notes raw は kind (issue / review-comment / thread-comment) と issueNumber/prNumber を内部メタに持つ.
 */
const state = {
  seq: 0,
  clock: createMockClock(),
  repos: new Map(), // repoKey (owner/repo) -> repo store
};

/** 全 state を决定论リセット (clock は固定 EPOCH へ). */
export function resetState(baseISO) {
  state.seq = 0;
  state.clock = createMockClock(baseISO);
  state.repos = new Map();
}

/** @returns {ReturnType<typeof createMockClock>} 書き込みが使う clock. */
export function clock() {
  return state.clock;
}

/** 次の内部 id (GitHub の comment id / review id / thread id の写し). */
export function nextId() {
  state.seq += 1;
  return state.seq;
}

/** repo store を無ければ作って返す (github provider の repos API 作成と等価). */
export function repoEnsure(repoKey) {
  let r = state.repos.get(repoKey);
  if (!r) {
    r = {
      issues: new Map(),
      prs: new Map(),
      notes: new Map(),
      reviews: new Map(),
      threads: new Map(),
      checks: new Map(),
      contents: new Map(),
      labelDefs: [],
      protection: null,
      branches: new Map(),
    };
    state.repos.set(repoKey, r);
  }
  return r;
}

export function repoGet(repoKey) {
  return state.repos.get(repoKey) ?? null;
}

/** 全 repo store の [repoKey, store] 一覧 (commentCreatedAt の全文 search 用). */
export function reposList() {
  return [...state.repos.entries()];
}

/** contents を読む (framework/docs/governance/config.json など). 無ければ null. */
export function contentsGet(repoKey, path) {
  const r = state.repos.get(repoKey);
  return r && r.contents.has(path) ? r.contents.get(path) : null;
}

export function contentsSet(repoKey, path, text) {
  repoEnsure(repoKey).contents.set(path, text);
}

// ---------------------------------------------------------------------------
// normalized object model helper (§1 の JSON 型 — GitHub raw → normalized)
// mock provider は forge.mjs の normalizer を通すので、ここは executor・突合・
// metrics 側が normalized で読むための model helper のみ置く.
// ---------------------------------------------------------------------------

/** @returns {import('../../src/types.mjs') extends Issue} */
export function toIssue(raw, repo) {
  return {
    id: `${repo}#${raw.number}`,
    number: raw.number,
    repo,
    title: raw.title,
    body: raw.body ?? '',
    author: raw.user?.login ?? '',
    labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    state: raw.state,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at ?? raw.created_at,
  };
}

export function toChangeRequest(raw, repo) {
  return {
    id: `${repo}!${raw.number}`,
    number: raw.number,
    repo,
    base: raw.base?.ref ?? '',
    headSha: raw.head?.sha ?? '',
    author: raw.user?.login ?? '',
    draft: !!raw.draft,
    labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    mergeable: raw.mergeable ?? null,
    state: raw.merged_at ? 'merged' : raw.state,
    body: raw.body ?? '',
  };
}

export function toNote(raw, repo) {
  return {
    id: noteIdOf(raw, repo),
    author: raw.user?.login ?? '',
    body: raw.body ?? '',
    createdAt: raw.created_at,
    prNumber: raw.pull_number ?? null,
    issueNumber: raw.issue_number ?? null,
    resolved: raw.resolved ?? null,
  };
}

export function toCheck(raw) {
  const done = raw.status === 'completed';
  const stateName = !done || raw.conclusion === null ? 'pending' : raw.conclusion === 'success' ? 'success' : 'failure';
  return {
    name: raw.name,
    state: stateName,
    headSha: raw.head_sha,
    issuer: raw.app?.owner?.login ?? raw.issuer ?? '',
  };
}

export function toApproval(raw) {
  return { reviewer: raw.user?.login ?? '', sha: raw.commit_id ?? '' };
}

export function toThread(raw) {
  return { id: String(raw.id), resolved: !!raw.resolved };
}

export function toProtection(raw) {
  const reviews = raw?.required_pull_request_reviews ?? null;
  const enforce = raw?.enforce_admins;
  return {
    requiredChecks: raw?.required_status_checks?.contexts ?? [],
    requiredApprovals: reviews?.required_approving_review_count ?? 0,
    dismissStaleReviews: !!reviews?.dismiss_stale_reviews,
    enforceAdmins: enforce === true || enforce?.enabled === true,
  };
}

/** note の normalized id (§12 の hidden marker fallback 突合にも使う文字列). */
export function noteIdOf(raw, repo) {
  const kind = raw.pull_number != null ? '!' : '#';
  const number = raw.pull_number ?? raw.issue_number;
  return `${repo}${kind}${number}/${raw.id}`;
}

// ---------------------------------------------------------------------------
// claim 突合 (spec §3・§7・§10 M1 — created_at が正、本文 `at <iso-time` は照合される)
// ---------------------------------------------------------------------------

/** 可視 header `claimed <session-id> at <iso-time>` (任意 `resumed <iso>` 許容). */
const CLAIM_HEADER_RE = /^claimed\s+(\S+)\s+at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)(\s+resumed\s+(\S+))?\s*(?:\n|$)/;
const SESSION_MARKER_RE = /<!--\s*fp:session\s+(\S+)\s+-->/;

/**
 * claim comment 本文を parse する (§7 の固定書式). 可視 header と hidden marker を返す.
 * @param {string} body
 * @returns {{sessionId: string|null, atIso: string|null, markerSession: string|null, resumed: string|null, kind: 'claim'|'resume', lineageIso: string} | null}
 */
export function parseClaimBody(body) {
  const m = CLAIM_HEADER_RE.exec(body ?? '');
  if (!m) return null;
  const marker = SESSION_MARKER_RE.exec(body ?? '');
  return {
    sessionId: m[1],
    atIso: m[2],
    markerSession: marker ? marker[1] : null,
    resumed: m[4] ?? null,
    kind: m[4] ? 'resume' : 'claim',
    lineageIso: m[2], // 復元 comment でも元 claim の at がlineage (§7 resume lineage — 時刻はこれ, created_at は resume 時刻).
  };
}

/**
 * created_at と本文 `at <iso-time` の突合 (spec §3 — 自己申告時刻偽装は却下、created_at が正).
 * 一致は秒精度 (claims.mjs と同じクロス(clock)クロスクロック成立)。
 * @param {string} createdAt forge API の created_at 正規値
 * @param {string} body claim comment 本文
 * @returns {boolean} 一致 (claim 成立可否). header 無し・不正・不一致は false.
 */
export function createdAtMatchesBodyAt(createdAt, body) {
  const parsed = parseClaimBody(body);
  if (!parsed || parsed.atIso === null) return false;
  const apiMs = secondMs(createdAt);
  const bodyMs = secondMs(parsed.atIso);
  if (Number.isNaN(apiMs) || Number.isNaN(bodyMs)) return false;
  if (parsed.resumed !== null) {
    // 復元 comment (§7 resume lineage) — header の at は元 claim の created_at を保持し、
    // 自身 の created_at は resume 時刻 (後刻). 厳密一致では却下になってしまうため、
    // lineage 突合 (元 claim の created_at と一致は orchestrator 側) に委ね、
    // 「at より前にはありえない」のみをここで検証する (§3 の偽装却下は保持: 未来時刻は弾く).
    return apiMs >= bodyMs;
  }
  return apiMs === bodyMs;
}

/**
 * 勝者判定 (spec §3: scan 窓内の created_at 先頭が勝者、同一秒は競合で後着却下)。
 * claim 候補 (normalized note) を created_at 昇順に並べ、先頭を勝者とする。
 * @param {Array<{createdAt: string}>} claimNotes
 * @param {string} [windowStart] 再 triage 以降の scan 窓 (§3(d)).
 * @returns {{winner: object|null, winnerSecondMs: number|null, rejected: object[]}}
 */
export function pickClaimWinner(claimNotes, windowStart) {
  const startMs = windowStart ? secondMs(windowStart) : -Infinity;
  const parsedNotes = [];
  for (const n of claimNotes) {
    const parsed = parseClaimBody(n.body);
    if (!parsed) continue;
    const lineageMs = parsed.resumed !== null ? secondMs(parsed.lineageIso) : secondMs(n.createdAt);
    const createdMs = secondMs(n.createdAt);
    if (Number.isNaN(lineageMs)) continue;
    if (startMs !== -Infinity && lineageMs < startMs) continue; // 窓はlineage (元 claim の at) で評価する
    parsedNotes.push({ n, parsed, lineageMs, createdMs: Number.isNaN(createdMs) ? lineageMs : createdMs });
  }
  // 復元 comment (resumed) は元 claim の lineage 証拠 — 元 claim が窓にいるなら元 claim 側で勝者を決める
  // (§3: created_at 先頭が勝者。復元 comment が後着として勝者を上書きしない)。
  const originals = parsedNotes.filter((c) => c.parsed.resumed === null);
  const candidates = originals.length > 0 ? originals : parsedNotes;
  // 同一 session (マーカーか header の一致) は 1 家に集約 — 複数 (元 claim+復元) は最早着を代表とする.
  const bySession = new Map();
  for (const c of candidates) {
    const sid = c.parsed.markerSession ?? c.parsed.sessionId;
    const prev = bySession.get(sid);
    if (!prev || c.createdMs < prev.createdMs) bySession.set(sid, c);
  }
  const claims = [...bySession.values()].sort((a, b) => a.createdMs - b.createdMs || a.lineageMs - b.lineageMs);
  if (claims.length === 0) return { winner: null, winnerSecondMs: null, rejected: [] };
  // 勝者は created_at 先頭 (同一秒は競合 → 先に着いた 1 本のみが勝ち、後は却下).
  const winner = claims[0];
  const rejected = claims.slice(1).map((c) => c.n);
  return { winner: winner.n, winnerSecondMs: winner.createdMs, rejected };
}
