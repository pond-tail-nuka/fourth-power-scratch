// budget 台帳 (spec §7 の一意の計算式). 台帳は forge の normalized リソースのみ (勝者 claim comment から
// マージ成立 (または blocked 遷移) まで、同一 session-id の勝者セッションの agent 著者 comment のみ算入).
// 可視台帳行: `budget: consumed_usd=<num> consumed_seconds=<num> at <iso-time>` (§7).

import { parseClaims, pickWinner, parseClaimTime } from './claims.mjs';

/** §8 config 既定の budget cap (computeLedger 省略時). 数値制約 MUST (cap なし unbounded MUST NOT、§6). */
export const DEFAULT_BUDGET = { maxTurns: 8, maxCostUSD: 5, maxTimeMin: 45, maxWallClockMin: 120 };

/** §7 の可視台帳行 (単一の計算式). */
export const LEDGER_LINE_RE = /budget: consumed_usd=(\d+(?:\.\d+)?) consumed_seconds=(\d+) at (\S+)/g;
/** agent 著者 comment 候補 (台帳算入の gate §7・§12: hidden session marker か可視 session marker の fallback)。 */
export const AGENT_COMMENT_RE = /^(?:ready|submit|re-claim|summary|budget:|peer-query|verifier|fp-verifier)/;
/** hidden `<!-- fp:session <id> -->` / 可視 `fp-verifier-session: <id>` (verifier は別セッション・不算入 §7). */
const SESSION_HIDDEN_RE = /<!--\s*fp:session\s+(\S+)\s*-->/;
const SESSION_VISIBLE_RE = /fp-verifier-session:\s*(\S+)/;
const DEFAULT_AGENTS = ['fourth-power-bot', 'orchestrator', 'fourth-power-runner'];

/**
 * config の budget cap を §7 の式で使う正規名へ正規化する (§7: cost key は maxCostUsd のみ MUST。
 * 組み込み config.json の既定は maxCostUSD / maxTimeMin (分) / maxWallClockMin のため、ここで分→秒に換算する。
 * maxUsd は使用しない — §7 の key 名違反は throw). cap が無いまま unbounded MUST NOT (§6).
 * @param {{maxTurns: number, maxCostUsd?: number, maxCostUSD?: number, maxTimeSeconds?: number, maxTimeMin?: number, maxWallClockSeconds?: number, maxWallClockMin?: number}} cfg
 */
export function normalizeBudgetCfg(cfg = {}) {
  const b = cfg.budget ?? cfg;
  if (b.maxUsd !== undefined) throw new Error('budget key 名違反: maxUsd は使用しない (§7)');
  const maxTurns = b.maxTurns;
  const maxCostUsd = b.maxCostUsd ?? b.maxCostUSD;
  const maxTimeSeconds = b.maxTimeSeconds ?? (b.maxTimeMin != null ? b.maxTimeMin * 60 : undefined);
  const maxWallClockSeconds = b.maxWallClockSeconds ?? (b.maxWallClockMin != null ? b.maxWallClockMin * 60 : undefined);
  if (typeof b.maxTurns !== 'number' || typeof maxCostUsd !== 'number' || typeof maxTimeSeconds !== 'number') {
    throw new Error('budget cap 欠落 (cap が無いまま budget は unbounded MUST NOT、§6)');
  }
  return { maxTurns, maxCostUsd, maxTimeSeconds, maxWallClockSeconds };
}

/** 本文から §7 台帳行を機械的に抽出 (決定論・LLM 再生成不可、§6). */
export function parseLedgerLines(body) {
  const rows = [];
  for (const m of String(body ?? '').matchAll(LEDGER_LINE_RE)) {
    rows.push({ turn: 1, costUSD: Number(m[1]), seconds: Number(m[2]), at: m[3] });
  }
  return rows;
}

/** 台帳算入対象の session-id を note から取得 (hidden 正・可視 fallback §12、§7 の author 突合の入力). */
export function sessionOfNote(note) {
  const body = String(note.body ?? '');
  const hidden = SESSION_HIDDEN_RE.exec(body);
  const visible = SESSION_VISIBLE_RE.exec(body);
  if (visible && visible[1].startsWith('verifier')) {
    return { session: visible[1], verifier: true, forged: hidden ? hidden[1] !== visible[1] : false };
  }
  return { session: hidden ? hidden[1] : visible ? visible[1] : null, verifier: false, forged: false };
}

/**
 * 勝者台帳の計算 (spec §7 の式). 台帳は勝者 claim comment からマージ成立 (または blocked 遷移) まで —
 * ready 境界で区切らない (rebase・verifier findings fix・submit turn も算入)。
 * 勝者 claim を hidden session marker (claim の `fp:session`) から選び、同一 session-id の agent 著者 comment のみ集計する。
 * 敗者 claim・verifier 別セッション・GitLab system note・session-id 模倣 (author 突合で弾く) は不算入 (§3 §7)。
 *
 * @param {{notes: Note[], sessionId?: string, claimAt?: string, issueCreatedAt?: string, nowIso?: string, agents?: string[]}} opts
 * @param {object} budgetCfg config の budget (§8 既定)。未指定なら §6 規定の既定値を使う。
 * @returns {{ledger: Array<{turn: number, costUSD: number, seconds: number, at: string}>, sessionId: string|null, turns: number, costUSD: number, seconds: number, wallClockSeconds: number, estimatedTurns: number, over: boolean, reason: string|null}}
 */
export function computeLedger(opts = {}, budgetCfg) {
  const budget = normalizeBudgetCfg(budgetCfg ?? DEFAULT_BUDGET);
  const agents = opts.agents ?? DEFAULT_AGENTS;
  const notes = opts.notes ?? [];
  const byTime = [...notes].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const claims = pickWinner(parseClaims(byTime, { windowStart: opts.claimAt }));
  const winner = claims.winner;
  const sessionId = opts.sessionId ?? winner?.sessionId ?? null;
  if (!sessionId) return { ledger: [], sessionId: null, turns: 0, costUSD: 0, seconds: 0, wallClockSeconds: 0, estimatedTurns: 0, over: false, reason: null };
  const claimTime = winner ? winner.created : parseClaimTimeSafe(opts.claimAt);
  if (Number.isNaN(claimTime)) return { ledger: [], sessionId, turns: 0, costUSD: 0, seconds: 0, wallClockSeconds: 0, estimatedTurns: 0, over: false, reason: 'claim 台帳開始 (created_at 正規値) が読めない (§7)' };

  const agentNotes = [];
  for (const note of byTime) {
    if (note.system === true) continue; // GitLab system note は台帳不算入 (§7)
    if (!agents.includes(note.author)) continue; // agent 著者 MUST (§7)
    const created = parseClaimTimeSafe(String(note.claimCreatedAt ?? note.createdAt));
    if (created < claimTime) continue; // 台帳は勝者 claim から (§7。台帳開始の claim 行は claimCreatedAt でスキャン窓の対象に含める)
    if (!AGENT_COMMENT_RE.test(String(note.body ?? ''))) continue;
    const { session, verifier, forged } = sessionOfNote(note);
    if (verifier) continue; // verifier 別セッションは不算入 (§7)
    if (forged) continue; // session marker と可視 marker の不一致は author 突合で弾く (§7 の模倣防止)
    if (session !== sessionId) continue; // 同一 session-id の勝者セッションのみ (§7)。敗者・他セッションは不算入
    agentNotes.push(note);
  }
  const ledger = agentNotes.flatMap((n) => parseLedgerLines(n.body));
  const costUSD = ledger.reduce((s, r) => s + r.costUSD, 0);
  const seconds = ledger.reduce((s, r) => s + r.seconds, 0);
  // 台帳行の数と agent comment 数の不一致は MUST fail (中間クラッシュ等)。未記録 turn は保守側:
  // 1 turn 加算・config の turn 上限値で概算する (cap 判定は保守的)。
  const missing = agentNotes.length - ledger.length;
  const mismatched = agentNotes.length !== ledger.length;
  const estimatedTurns = mismatched ? Math.max(missing, 1) : 0;
  const wallClockSeconds = opts.issueCreatedAt && opts.nowIso ? Math.max(0, (parseClaimTimeSafe(opts.nowIso) - parseClaimTimeSafe(opts.issueCreatedAt)) / 1000) : 0;
  const over = overOf(budget, { turns: agentNotes.length, costUSD, seconds, wallClockSeconds, estimatedTurns });
  return { ledger, sessionId, turns: agentNotes.length, costUSD, seconds, wallClockSeconds, estimatedTurns, over: over.over, reason: over.reason };
}

function parseClaimTimeSafe(iso) {
  return parseClaimTime(String(iso ?? ''));
}

/** cap 判定 (概算込み、保守側). maxTurns / maxCostUsd / maxTimeSeconds はどれが先に来ても打ち切り (§7). */
function overOf(budget, { turns, costUSD, seconds, wallClockSeconds, estimatedTurns }) {
  const cost = costUSD + estimatedTurns * budget.maxCostUsd;
  const time = seconds + estimatedTurns * budget.maxTimeSeconds;
  if (turns + estimatedTurns > budget.maxTurns) return { over: true, reason: `maxTurns 超過 (turns=${turns}, 概算=${estimatedTurns} 含む、§7)` };
  if (cost > budget.maxCostUsd) return { over: true, reason: `maxCostUsd 超過 (consumed=${costUSD}, 概算=${estimatedTurns} × cap 含む、§7)` };
  if (time > budget.maxTimeSeconds) return { over: true, reason: `maxTimeSeconds 超過 (consumed=${seconds}, 概算含む、§7)` };
  if (budget.maxWallClockSeconds && wallClockSeconds > budget.maxWallClockSeconds) return { over: true, reason: `maxWallClockSeconds 超過 (${wallClockSeconds} 秒、§8 の turn 打切り間隔・config §2.6)` };
  return { over: false, reason: null };
}

/**
 * 台帳行 (ledger) からの cap 判定 (概算は ledger 側で加算されていること。computeLedger の ledger を渡す)。
 * 引数 cfg は config の budget オブジェクト (maxCostUSD 表記も正規化して読む、§8 §7)。
 * issueCreatedAt と now を与えると wall-clock cap も判定する (§2.6 の maxWallClockMin)。
 * @param {ReturnType<typeof computeLedger> extends object ? any : any} ledgerLike computeLedger の戻し (turns/costUSD/seconds 等) でよい。
 */
export function overBudget(ledgerLike, budgetCfg, opts = {}) {
  const budget = normalizeBudgetCfg(budgetCfg ?? DEFAULT_BUDGET);
  const rows = Array.isArray(ledgerLike) ? ledgerLike : ledgerLike?.ledger ?? [];
  const turns = Array.isArray(ledgerLike) ? rows.length : (ledgerLike.turns ?? rows.length);
  const ledger = Array.isArray(ledgerLike) ? rows : ledgerLike;
  const estimatedTurns = Array.isArray(ledgerLike) ? 0 : (ledgerLike.estimatedTurns ?? 0);
  const costUSD = Array.isArray(ledgerLike) ? rows.reduce((s, r) => s + r.costUSD, 0) : (ledger.costUSD ?? 0);
  const seconds = Array.isArray(ledgerLike) ? rows.reduce((s, r) => s + r.seconds, 0) : (ledger.seconds ?? 0);
  const wallClockSeconds = opts.issueCreatedAt && opts.nowIso
    ? Math.max(0, (parseClaimTime(opts.nowIso) - parseClaimTime(opts.issueCreatedAt)) / 1000)
    : (ledgerLike?.wallClockSeconds ?? 0);
  return overOf(budget, { turns, costUSD, seconds, wallClockSeconds, estimatedTurns }).over;
}

/**
 * orchestrator が各 turn 末尾で MUST 記録する台帳行の追記 (§7: `budget: consumed_usd=<num> consumed_seconds=<num> at <iso-time>`)。
 * usage = {turn, costUSD, seconds, at}。返す ledger に追記し、cap 超過なら over を返す (概算込み)。
 * @param {Array<{turn: number, costUSD: number, seconds: number, at: string}>} ledger
 * @param {{turn: number, costUSD: number, seconds: number, at: string}} usage
 * @param {object} config config.budget (または budget オブジェクトそのもの)
 * @param {string} [nowISO] wall-clock 判定の現在時刻
 */
export function consumeTurn(ledger, usage, config, nowISO) {
  const budget = normalizeBudgetCfg(config ?? DEFAULT_BUDGET);
  const next = [...(ledger ?? []), { turn: usage.turn ?? 1, costUSD: usage.costUSD, seconds: usage.seconds, at: usage.at ?? nowISO ?? new Date().toISOString() }];
  const costUSD = next.reduce((s, r) => s + r.costUSD, 0);
  const seconds = next.reduce((s, r) => s + r.seconds, 0);
  const wallClockSeconds = nowISO && next[0]?.at ? Math.max(0, (parseClaimTime(nowISO) - parseClaimTime(next[0].at)) / 1000) : 0;
  const over = overOf(budget, { turns: next.length, costUSD, seconds, wallClockSeconds, estimatedTurns: 0 });
  return { ledger: next, over: over.over, reason: over.reason };
}

