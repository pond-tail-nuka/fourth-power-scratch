// 決定表・ゲート (spec §7 §8). 純関数 decide. 行優先 MUST: budget > dirty > open thread > CI red > CI pending > green.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_LABELS = ['backlog', 'claimed', 'in_review', 'rebase_required', 'blocked/spec-gap', 'blocked/budget', 'blocked/infra', 'done'];
const BLOCKED = STATE_LABELS.filter((l) => l.startsWith('blocked/'));
const DEFAULT_HUMANS = ['pond-tail-nuka'];

/** 入力ラベルから状態ラベルだけ抽出 (§1 の単一集合排他). */
export function stateLabels(labels) {
  return (labels ?? []).filter((l) => STATE_LABELS.includes(l));
}

/** tier 要求の承認充足: author は humanAccounts 所属 MUST (§8). headSha 指定時は sha 突合 (§8 失効). */
function humanApprovals(approvals, headSha, humans) {
  const list = (approvals ?? []).filter((a) => humans.includes(a.reviewer));
  if (headSha) return list.filter((a) => a.sha === headSha);
  return list;
}

function hasStaleApproval(approvals, headSha, humans) {
  if (!headSha) return false;
  return (approvals ?? []).some((a) => humans.includes(a.reviewer) && a.sha !== headSha);
}

/**
 * 決定表 (spec §7 復元行). fixture 書式 (contract §12):
 * {labels, prState, ciState, threads, approvals, budget} → {labels, turn, prState, exclusiveConflict}.
 * 追加 optional 入力: issueState, headSha, planHeader, tier, humanAccounts,
 * requiredApprovals (既定 1), mergeAllowed は出力キー.
 * turn ∈ 'plan'|'implement'|'verify'|'fix'|'submit'|'rebase'|'review'|'close'|'block'|'none'.
 */
export function decide(input = {}) {
  const labels = stateLabels(input.labels);
  const prState = input.prState ?? 'none';
  const ciState = input.ciState ?? 'none';
  const threads = Number(input.threads ?? 0);
  const humans = input.humanAccounts ?? DEFAULT_HUMANS;
  const reqApprovals = input.requiredApprovals ?? 1;
  const tier = input.tier ?? ((input.labels ?? []).includes('cohort:typical') ? 'low' : 'high');
  const echo = { labels, turn: 'none', prState, exclusiveConflict: false };
  const keep = labels.length > 0 ? labels : ['backlog'];

  // 状態ラベル排他 (§11 status-exclusivity): 決定表は乖離入力を打ち消さない
  if (labels.length > 1 && !(labels.includes('done') && labels.length === 2 && labels.some((l) => BLOCKED.includes(l)))) {
    return { ...echo, labels: labels, exclusiveConflict: true, reason: 'status-exclusivity: 状態語ラベルの同時立旗 (§11)' };
  }

  // done ラベルが状態の正 (§3): merged/done + Issue open → close 是正
  if (labels.includes('done')) {
    if ((input.issueState ?? 'open') === 'open') return { labels: ['done'], turn: 'close', prState, exclusiveConflict: false, reason: 'done ラベルあり + Issue open → close 是正 (§7)' };
    return { ...echo, labels: ['done'], reason: 'done 済み (terminal)' };
  }
  // 優先 MUST: budget 超過は全行に先行する (plan turn も §7 の既存計算をそのまま使う、§7・§3 のお題 plan cap 超過行)
  const ledgerOpen = (input.issueState ?? 'open') === 'open' && prState !== 'closed' && prState !== 'merged' && !labels.some((l) => BLOCKED.includes(l));
  if (ledgerOpen && (input.budget?.over ?? input.budget === true)) {
    return { labels: ['blocked/budget'], turn: 'block', prState, exclusiveConflict: false, reason: `budget 超過${input.budget?.reason ? ` (${input.budget.reason})` : ''} → blockIssue (§7)` };
  }
  // plan turn 起動は決定論: scan が plan: header を読む (§5・§7). お題 Issue は claim 不可
  if (input.planHeader && !labels.some((l) => ['claimed', 'in_review', 'rebase_required'].includes(l))) {
    return { labels: keep, turn: 'plan', prState, exclusiveConflict: false, reason: 'plan: header → plan turn 起動 (§5 plan turn)' };
  }
  // 未マージ PR close = セッション放棄 (介入 §9): ラベルは据え置きで人間判断待ち (§7)
  if (prState === 'closed') return { ...echo, labels: keep, turn: 'none', reason: 'PR close (未マージ) → 再 triage 待ち (§7)' };
  if (prState === 'merged') return { labels: ['done'], turn: 'close', prState: 'merged', exclusiveConflict: false, reason: 'マージ成立 → done ラベル → close (§3)' };
  if (BLOCKED.includes(labels[0])) return { ...echo, labels, reason: 'blocked: 再 triage は人間操作 MUST (§3)' };

  // 優先順の本体: budget > dirty > open thread > CI red > CI pending > green (spec §7)
  if (prState === 'dirty') return { labels: ['rebase_required'], turn: 'rebase', prState, exclusiveConflict: false, reason: 'mergeable_state dirty → rebase turn (§7)' };
  if (threads >= 1) return { labels: ['in_review'], turn: 'fix', prState, exclusiveConflict: false, reason: 'open thread ≥1 → fix turn (in_review 維持、§7)' };
  if (ciState === 'red') {
    if (labels.includes('rebase_required')) return { labels: ['rebase_required'], turn: 'rebase', prState, exclusiveConflict: false, reason: 'rebase_required + CI red → rebase turn 継続 (§7)' };
    if (labels.includes('claimed')) return { labels: ['claimed'], turn: 'implement', prState, exclusiveConflict: false, reason: 'CI red → fix turn (claimed 維持、§7)' };
    return { labels: keep, turn: 'fix', prState, exclusiveConflict: false, reason: 'CI red → fix turn (現ラベル維持、§7)' };
  }
  if (ciState === 'pending') return { labels: keep, turn: 'verify', prState, exclusiveConflict: false, reason: 'CI pending → verify turn (checks の pending 読みのみ、§7)' };
  if (prState === 'none') {
    if (labels.includes('claimed')) return { labels: ['claimed'], turn: 'implement', prState, exclusiveConflict: false, reason: 'PR 無し (claimed) → implement turn (§7)' };
    return { ...echo, labels: keep, reason: 'backlog (plan header なしは claim 対象外 §4.3)' };
  }
  if (prState === 'draft') return { labels: ['claimed'], turn: 'implement', prState, exclusiveConflict: false, reason: 'PR draft → implement 継続 (§7)' };
  if (ciState === 'none') return { labels: keep, turn: 'verify', prState, exclusiveConflict: false, reason: 'check 読み取り済みなし → verify turn (pending 読み、§7)' };

  // green: tier 要求承認の充足 (§8) — high は humanAccounts 由来承認 MUST / low (cohort:typical) は免除
  const satisfied = tier === 'low' ? true : humanApprovals(input.approvals, input.headSha, humans).length >= reqApprovals;
  if (satisfied) return { labels: ['in_review'], turn: 'submit', prState: 'merged', mergeAllowed: true, exclusiveConflict: false, reason: 'green + tier 要求承認充足 → submit (merge 可、§7)' };
  if (hasStaleApproval(input.approvals, input.headSha, humans)) return { labels: ['in_review'], turn: 'review', prState, exclusiveConflict: false, reason: '承認後の新 commit (agent push) → 再 review (§7)' };
  return { labels: ['in_review'], turn: 'submit', prState, exclusiveConflict: false, reason: 'green + tier 要求承認未充足 → submit turn (review 依頼のみ、mergePr 不可、§7)' };
}

// --- ラベル許可リスト・PR 本文 scan (spec §4.3 §8) ---

/** 許可リスト: 状態ラベルのみ (exempt・権限ラベルは §2.6 由来の config で拒否される). */
export const STATE_LABELS_SET = STATE_LABELS;

/**
 * gate のラベル Action 判定 (spec §8 許可リスト MUST).
 * - exempt・privileged ラベル (config の exemptLabels / privilegedLabels、§2.6) への Action は MUST 全拒否
 *   (実装セッションの self 付与・accept-author exempt 利得の経路を塞ぐ、§4.2 M2(c))
 * - 他 session の operation は loop.mjs 側 (claims.inheritsWinner) で弾く (介入境界)
 * @param {{add?: string[], remove?: string[], sessionId?: string, winnerSessionId?: string, config?: {exemptLabels?: string[], privilegedLabels?: string[]}}} action
 */
export function validateLabelAction(action = {}, config = {}) {
  const exempt = [...(config.exemptLabels ?? [])];
  const privileged = [...(config.privilegedLabels ?? [])];
  const state = [...(action.add ?? []), ...(action.remove ?? [])];
  const block = action.blockAction === true;
  for (const label of state) {
    if (exempt.includes(label) || privileged.includes(label)) return { ok: false, reason: `exempt・権限ラベルへの Action は全拒否 (§8 許可リスト): ${label}` };
    if (!STATE_LABELS.includes(label)) return { ok: false, reason: `状態ラベル許可リスト外は拒否 (§8 許可リスト): ${label}` };
    if (BLOCKED.includes(label) && !(block && action.reason)) return { ok: false, reason: 'blocked ラベルは blockIssue (reason 付き) 経由のみ (§6 blockIssue 制約)' };
  }
  if (action.sessionId && action.winnerSessionId && action.sessionId !== action.winnerSessionId) {
    return { ok: false, reason: '状態ラベル operation は勝者セッションのみ (他セッションの operation MUST NOT、§8)' };
  }
  return { ok: true, reason: null };
}

/** Action 実行適用の helper. ok でない Action は forge 書き込みの前に MUST 拒否 (mergePr は mergeGate で、§8). */
export function applyLabelAction(action, config) {
  const res = validateLabelAction(action, config);
  if (!res.ok) return { ...res, add: null, remove: null };
  return { ok: true, reason: null, add: action.add ?? [], remove: action.remove ?? [] };
}

/** PR 本文に `Closes #N` keyword を MUST 書かない (§3). gate が本文を scan して拒否する. */
export function rejectsClosesKeyword(body) {
  return /(^|\s)(close[sd]|fix(?:e|s|d|es|ed)?|resolve[sd]?)(\s+(issues?|pull requests?))?\s*[,#]\s*#?\d+/i.test(String(body ?? ''));
}

// --- merge 直前の同期再照合 (spec §8: head SHA・required checks・承認・open thread・ラベル・mergeable を
//     forge 読みで突合し、不一致は fail 扱い・§7 の決定表に再戻し) ---

/**
 @param {{protection: {requiredChecks: string[]}, checks: Check[], headSha: string, approvals: Approval[], threads: {resolved: boolean}[], labels: string[], prState: string, mergeable: null|boolean, issueState?: string, humanAccounts?: string[], tier?: string, requiredApprovals?: number, rejectCloses?: boolean, config?: {botActor?: string}}} snapshot forge 読み (個別フィールド).
 @return {{ok: boolean, mismatches: string[], mismatchReason?: string, decision?: object}} */
export function recheckGate(snap = {}) {
  const botActor = snap.config?.botActor ?? 'fourth-power-bot';
  const mismatches = [];
  const checks = (snap.checks ?? []).filter((c) => c.issuer === botActor || c.issuer === 'adapter');
  const required = snap.protection?.requiredChecks ?? [];
  const byName = new Map(checks.filter((c) => c.headSha === snap.headSha).map((c) => [c.name, c]));
  for (const name of required) {
    const c = byName.get(name);
    if (!c) { mismatches.push(`required check ${name}: head SHA の投稿が無い (非 canonical は無視、§8)`); continue; }
    if (c.state === 'pending') mismatches.push(`required check ${name}: pending`);
    else if (c.state === 'failure') mismatches.push(`required check ${name}: failure`);
  }
  if ((snap.threads ?? []).some((t) => !t.resolved)) mismatches.push('open thread ≥1 (review-threads、§8)');
  const humans = snap.humanAccounts ?? DEFAULT_HUMANS;
  const tier = snap.tier ?? ((snap.labels ?? []).includes('cohort:typical') ? 'low' : 'high');
  if (tier === 'high') {
    const ok = humanApprovals(snap.approvals, snap.headSha, humans).length >= (snap.requiredApprovals ?? 1);
    if (!ok) mismatches.push('tier high: 人間承認 (humanAccounts 由来・head SHA 一致) 未充足 (§8)');
  }
  const state = stateLabels(snap.labels);
  if (state.length !== 1) mismatches.push(`ラベル状態の乖離 (状態語 1 つ MUST、§11): [${state.join(',')}]`);
  else if (state[0] !== 'in_review') mismatches.push(`ラベル状態の乖離 (merge 直には in_review MUST): ${state[0]}`);
  if (snap.prState !== 'open') mismatches.push(`PR 状態の乖離 (open MUST): ${snap.prState}`);
  if (snap.mergeable !== true) mismatches.push(`mergeable の再照合不一致 (true MUST): ${snap.mergeable}`);
  if (snap.rejectCloses) mismatches.push('PR 本文に Closes keyword (§3)');
  return { ok: mismatches.length === 0, mismatches, mismatchReason: mismatches.length === 0 ? null : mismatches.join('; ') };
}

/**
 * マージ実行 (spec §8: 再照合がマージ許可の唯一の基礎; §3 の done→close 順序).
 * @param {{prId: string, forge: {pr?(id): any, checks?(id): Check[], approvals?(id): Approval[], threads?(id): any[], protection?(repo): any, issue?(id): Issue, mergePR(id, method): Promise, setLabel(id, label): Promise, closeIssue(id): Promise, postComment?(id, body): Promise}, mergeMethod?: string, snapshot(): object}} deps snapshot は forge 読みで §8 再照合入力を作る関数 (loop.mjs が注入).
 */
export async function mergeGate(deps) {
  const forge = deps.forge;
  const snapshot = await deps.snapshot();
  const recheck = recheckGate(snapshot);
  if (!recheck.ok) return { merged: false, recheck };
  const pr = forge.pr ? await forge.pr(deps.prId) : null;
  if (pr && rejectsClosesKeyword(pr.body)) return { merged: false, recheck: { ok: false, mismatches: ['PR 本文に Closes keyword (§3)'], mismatchReason: 'PR 本文に Closes keyword (§3)' } };
  const method = deps.mergeMethod ?? 'squash';
  await forge.mergePR(deps.prId, method);
  await forge.setLabel(snapshot.issueId ?? deps.prId, 'done');
  const issue = forge.issue ? await forge.issue(snapshot.issueId ?? deps.issueId) : null;
  if (!issue || issue.state !== 'closed') {
    await forge.closeIssue(snapshot.issueId ?? deps.issueId);
  }
  return { merged: true, recheck };
}

// --- fixture 網羅 helper (contract §12: input → expected {labels, turn}) ---
/** tests/fixtures/decision-table/*.json を決定順で返す (M2 回帰ケース (b)(e)(g)(m)(o) を含む). */
export function loadDecisionFixtures(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { name: f, input: j.input, expected: j.expected };
    });
}

// --- claim 勝者判定 (spec §3、§10 M1) — claims.mjs の再 export (contract §5) ---
export { parseClaims, pickWinner } from './claims.mjs';
