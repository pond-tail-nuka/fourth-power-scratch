// Orchestrator ループ (spec §7: scan→claim→turn→submit、§5 plan turn/child Issue 機械組立、
// §8 merge 直前再照合、§3 done→close 順序・claim 勝者継承). forge/seat/payload は DI で注入する
// (他モジュールを直接 import しない — contract §9。テストはモック注入で決定論に走る)。

import { decide, stateLabels, applyLabelAction, rejectsClosesKeyword, parseClaims, pickWinner, mergeGate } from './gate.mjs';
import { resumeClaimBody } from './claims.mjs';
import { computeLedger, parseLedgerLines } from './budget.mjs';

const ACCEPT_BLOCK_RE = /```acceptBlock\s*([\s\S]*?)```/;
const VISUAL_ACCEPT_RE = /(^|\n)\s*accept:\s*(\S+)/g;
const VISUAL_PLAN_RE = /(^|\n)\s*plan:/;
const CHILD_SECTION_RE = /(^|\n)#{1,4}\s*child issue\s*:\s*(.+?)\s*$/im;

/** Issue タイトル先頭 30 文字の正規化 slug による branch 命名規約 MUST (§7). */
export function branchName(number, title) {
  const slug = String(title ?? '').slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  return `llm/issue-${number}-${slug}`;
}

/** Issue 本文の fence 付き機械可読 acceptBlock のみ読む (自由文から条項を parse しない、§5・contract §11). */
export function parseAcceptBlock(body) {
  const m = ACCEPT_BLOCK_RE.exec(String(body ?? ''));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function hasPlanHeader(body) {
  return VISUAL_PLAN_RE.test(String(body ?? ''));
}

/** accept 条項の有無 (fence acceptBlock の accept 配列または可視 `accept: <id>` 行、§4.3 — 自由文は数えない)。 */
export function hasAcceptClauses(body) {
  const block = parseAcceptBlock(String(body ?? ''));
  if (block && Array.isArray(block.accept) && block.accept.length > 0) return true;
  return /^accept:\s*\S+/m.test(String(body ?? ''));
}

/** PR の normalized 状態から決定表 input の prState へ写す (§7 の入力: draft/ready/close/無し + dirty). */
function prStateOf(pr) {
  if (!pr) return 'none';
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  if (pr.mergeable === false) return 'dirty';
  return 'ready';
}

/** canonical issuer の check 投稿のみ数える (非 canonical は無視、§8). head SHA の投稿のみ (§8 stale 再照合). */
function ciStateOf(checks, headSha, botActor) {
  const mine = (checks ?? []).filter((c) => (c.issuer === botActor || c.issuer === 'adapter') && (!headSha || c.headSha === headSha));
  if (mine.length === 0) return 'none';
  if (mine.some((c) => c.state === 'failure')) return 'red';
  if (mine.some((c) => c.state === 'pending')) return 'pending';
  return 'green';
}

/** PR 本文 Closes keyword 拒否 (§3). ready/draft 時の body を組立する — keyword を混ぜない. */
export function prBodyFor(issue, clauses) {
  const body = `agent: issue #${issue.number}\n\nacceptBlock clause refs:\n${(clauses?.refs ?? []).map((r) => `- ${r}`).join('\n')}`;
  if (rejectsClosesKeyword(body)) throw new Error('PR 本文に Closes keyword を書けない (§3)');
  return body;
}

/** 勝者 claim comment を書く (§3 勝者の session-id を継承。復元では resumeClaimBody で新 comment にする)。 */
export async function writeClaim(forge, issueId, sessionId, opts = {}) {
  const resume = !!opts.resumeOf;
  const header = resume
    ? resumeClaimBody(opts.resumeOf, opts.now ?? new Date().toISOString())
    : `claimed ${sessionId} at P\n<!-- fp:session ${sessionId} -->`;
  const res = await forge.postComment(issueId, header);
  const noteId = res?.noteId ?? res?.id ?? null;
  if (!resume && noteId && forge.setCommentBody) {
    // §3 の正本は created_at — 書き込み後 (mock clock の実秒) に `at` を同期する。
    const created = await forge.commentCreatedAt(noteId);
    if (created) await forge.setCommentBody(noteId, `claimed ${sessionId} at ${created}\n<!-- fp:session ${sessionId} -->`);
  }
  return { noteId, createdAt: res?.createdAt ?? null };
}

/** §7 の復元 scan: active ラベル (claimed / in_review / rebase_required の全部) を scan 条件から決定 (§2.6 restoreScan). */
export function scanActive(forge, repo, config) {
  const labels = config.restoreScan?.activeLabels ?? ['claimed', 'in_review', 'rebase_required'];
  return forge.scanIssues(repo, { labels, state: 'open' });
}

/**
 * seat turn 起動・打切り (§2.6: 停滞検出は session の event 静寂 + 時刻測定、turnTimeoutMin)。
 * 遅いが生きている応答の誤検知範囲は quietMs (実装時に固定) で決まる。
 * @param {{startTurn({role,tier,payload,sessionHint}): {sessionId, events}}} seat
 */
export async function runTurn(seat, turnReq, opts = {}) {
  const timeoutMs = (opts.turnTimeoutMin ?? 10) * 60_000;
  const quietMs = opts.quietMs ?? 30_000;
  const started = Date.now();
  const t = await seat.startTurn(turnReq);
  const events = t.events ?? t;
  const it = typeof events[Symbol.asyncIterator] === 'function' ? events[Symbol.asyncIterator]() : events[Symbol.iterator]();
  let sessionId = t.sessionId ?? null;
  const actions = [];
  let usage = null;
  let timedOut = false;
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) { timedOut = true; break; }
    const quiet = Math.min(quietMs, timeoutMs - elapsed);
    let timer = null;
    const race = await Promise.race([
      it.next().then((r) => ({ done: r.done, value: r.value })).catch(() => ({ done: true, err: true })),
      new Promise((res) => { timer = setTimeout(() => res({ quiet: true }), quiet); }),
    ]);
    clearTimeout(timer);
    if (race.quiet || race.err) { timedOut = true; break; }
    if (race.done) break;
    const ev = race.value;
    if (ev?.type === 'session') sessionId = ev.sessionId ?? sessionId;
    else if (ev?.type === 'action' && ev.action) actions.push(ev.action);
    else if (ev?.type === 'usage') usage = { costUSD: ev.costUSD ?? usage?.costUSD ?? 0, seconds: ev.seconds ?? usage?.seconds ?? 0 };
  }
  if (typeof it.return === 'function') await it.return?.();
  const seconds = usage?.seconds ?? Math.max(0, (Date.now() - started) / 1000);
  return { sessionId, actions, usage: { costUSD: usage?.costUSD ?? 0, seconds, at: opts.clockNow?.() ?? new Date(started).toISOString() }, timedOut };
}

/**
 * 複数 usage event を台帳行として順に取る helper (plan turn・P3 注入用、§7: 1 event = 1 turn)。
 * 打切りは runTurn と同じ契約 (timeout/quiet 監視)。
 * @param {{startTurn({role,tier,payload,sessionHint}): {sessionId, events}}} seat
 */
export async function runTurnAll(seat, turnReq, opts = {}) {
  const timeoutMs = (opts.turnTimeoutMin ?? 10) * 60_000;
  const quietMs = opts.quietMs ?? 30_000;
  const started = Date.now();
  const t = await seat.startTurn(turnReq);
  const events = t.events ?? t;
  const it = typeof events[Symbol.asyncIterator] === 'function' ? events[Symbol.asyncIterator]() : events[Symbol.iterator]();
  let sessionId = t.sessionId ?? null;
  const actions = [];
  const ledger = [];
  let timedOut = false;
  for (;;) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) { timedOut = true; break; }
    const quiet = Math.min(quietMs, timeoutMs - elapsed);
    let timer = null;
    const race = await Promise.race([
      it.next().then((r) => ({ done: r.done, value: r.value })).catch(() => ({ done: true, err: true })),
      new Promise((res) => { timer = setTimeout(() => res({ quiet: true }), quiet); }),
    ]);
    clearTimeout(timer);
    if (race.quiet || race.err) { timedOut = true; break; }
    if (race.done) break;
    const ev = race.value;
    if (ev?.type === 'session') sessionId = ev.sessionId ?? sessionId;
    else if (ev?.type === 'action' && ev.action) actions.push(ev.action);
    else if (ev?.type === 'usage') ledger.push({ turn: ev.turn ?? ledger.length + 1, costUSD: ev.costUSD ?? 0, seconds: ev.seconds ?? 0, at: ev.at ?? opts.clockNow?.() ?? new Date().toISOString() });
  }
  if (typeof it.return === 'function') await it.return?.();
  const last = ledger[ledger.length - 1];
  return { sessionId, actions, ledger, usage: { costUSD: last?.costUSD ?? 0, seconds: last?.seconds ?? Math.max(0, (Date.now() - started) / 1000), at: last?.at ?? new Date(started).toISOString() }, timedOut };
}

// ---------------------------------------------------------------------------
// orchestrator 工厂 (forge / seat / payload は DI 注入。他モジュールの直接 import はしない、contract §9)
// ---------------------------------------------------------------------------

/**
 * @param {{forge: object, seat: object, payload?: object, config?: object, clock?: () => string, quietMs?: number}} deps
 */
export function createOrchestrator(deps) {
  const forge = deps.forge;
  const seat = deps.seat;
  const payload = deps.payload ?? null;
  const clock = () => (deps.clock ? deps.clock() : new Date().toISOString());

  async function readConfig() {
    return deps.config ?? await forge.readConfig();
  }

  /** §7 の復元 scan (active ラベル全部) + scanNeedsInfo を束ねる orchestrator の scan 経路 (UI 間隔 ui.readIntervalSec は loop 外側の scheduler). */
  async function scan(config) {
    const cfg = config ?? await readConfig();
    const repo = cfg.repo ?? 'mock/fourth_power';
    const active = await scanActive(forge, repo, cfg);
    const needsInfo = (await forge.scanNeedsInfo(repo)).filter((i) => !active.some((a) => a.id === i.id));
    return { active, needsInfo };
  }

  async function setBlocked(issue, label, reason, config) {
    if (!label.startsWith('blocked/')) throw new Error('blockIssue は理由付き blocked/* ラベルのみ許容 (§6)');
    const cfg = config ?? await readConfig();
    const v = applyLabelAction({ add: [label], blockAction: true, reason: reason ?? '' }, cfg);
    if (!v.ok) throw new Error(`blockIssue は白名簿 blocked/*・理由付き MUST (§6): ${v.reason}`);
    for (const l of stateLabels(issue.labels)) {
      if (l !== label) await forge.removeLabel(issue.id, l);
    }
    await forge.setLabel(issue.id, label);
    await forge.postComment(issue.id, `blocked: ${reason}\n`);
    return { transition: label.replace('blocked/', 'blocked:'), turn: 'block', labels: [label], reason };
  }

  /** 敗者にはコメントで通知し、敗者の claim コメントを残す (§3。台帳算入不算入は budget.mjs の author 突合). */
  async function notifyLosers(winner, losers) {
    for (const loser of losers.filter((l) => l.sessionId !== winner.sessionId)) {
      await forge.postComment(loser.note.issueNumber ?? loser.note.prNumber ?? '', `claim-superseded: 勝者は created_at 先頭の ${winner.sessionId} (§3)\n<!-- fp:session ${loser.sessionId} -->`);
    }
  }

  /** payload.mjs が無い場合の決定的組立 (§6 間引き・§5 条項参照のみ。自由文は混ぜない). */
  function assembleFallback(issue, config) {
    const block = parseAcceptBlock(issue.body);
    const text = block ? `acceptBlock:\n${JSON.stringify(block)}\nrefs: ${(block.refs ?? []).join(', ')}` : '';
    const budget = config?.contextBudget ?? 16000;
    return text.slice(0, budget);
  }

  function clausesOf(issue) {
    return parseAcceptBlock(issue.body) ?? null;
  }

  /** §7 の決定表入力を作る (forge 読みで normalized 状態から決定。check pending 読みのみ thread・承認判定はしない)。 */
  async function buildDecideInput(issue, config, budget) {
    const prs = await forge.prsForIssue(issue.repo, issue.number);
    const pr = prs[0] ?? null;
    const checks = pr && pr.state === 'open' ? await forge.checks(pr.id) : [];
    const threads = pr && pr.state === 'open' ? await forge.threads(pr.id) : [];
    const approvals = pr && pr.state === 'open' ? await forge.approvals(pr.id) : [];
    const protection = pr && pr.state === 'open' ? await forge.protection(issue.repo) : null;
    return {
      labels: issue.labels ?? [],
      prState: prStateOf(pr),
      ciState: ciStateOf(checks, pr?.headSha, config.botActor ?? 'fourth-power-bot'),
      threads: (threads ?? []).filter((t) => t.resolved === false).length,
      approvals: approvals ?? [],
      budget,
      headSha: pr?.headSha ?? null,
      issueState: issue.state,
      humanAccounts: config.humanAccounts,
      requiredApprovals: protection?.requiredApprovals ?? 1,
    };
  }

  async function executeAction(issue, config, a, pr, sessionId) {
    switch (a?.kind) {
      case 'comment': await forge.postComment(issue.id, a.body); return 0;
      case 'label': {
        const add = a.add == null ? [] : Array.isArray(a.add) ? a.add : [a.add];
        const remove = a.remove == null ? [] : Array.isArray(a.remove) ? a.remove : [a.remove];
        const res = applyLabelAction({ add, remove, sessionId, winnerSessionId: sessionId }, config);
        if (!res.ok) return 1; // exempt・privileged・白名簿外は全拒否 (§4.2 §8)
        for (const l of res.remove) await forge.removeLabel(issue.id, l);
        for (const l of res.add) await forge.setLabel(issue.id, l);
        return 0;
      }
      case 'blockIssue': {
        const label = a.label ?? 'blocked/spec-gap';
        if (!label.startsWith('blocked/')) return 1; // blockIssue は理由付き blocked/* のみ (§6)
        await setBlocked(issue, label, a.reason ?? 'blockIssue', config);
        return 0;
      }
      case 'commit':
      case 'openDraftPr': {
        if (!pr) {
          await forge.createPR({ repo: issue.repo, head: branchName(issue.number, issue.title), base: 'main', title: `agent: issue #${issue.number}`, body: prBodyFor(issue, clausesOf(issue)), draft: true });
        }
        return 0;
      }
      case 'readyPr':
        if (pr && typeof forge.readyPR === 'function') await forge.readyPR(pr.id);
        else if (pr && typeof forge.editPR === 'function') await forge.editPR(pr.id, { draft: false });
        return 0;
      case 'requestReview':
        if (pr && typeof forge.requestReview === 'function') await forge.requestReview(pr.id);
        else await forge.postComment(issue.id, `review-request: head ${pr?.headSha ?? 'n/a'} (human approval required、§8)`);
        return 0;
      case 'mergePr': return 1; // mergePr は gate 通過前に MUST 拒否 (§6). 実行は mergeGate (再照合 §8) 経のみ
      default: return 1;
    }
  }

  /** turn 実行・Action 実行・台帳行記録・budget 再判定 (超過時 blockIssue)。verifier は別セッション・台帳不算入 §7. */
  async function runTurnAndRecord(issue, config, role, winner, opts = {}, extra = {}) {
    const verifier = extra.verifier === true;
    const seatRole = verifier ? 'review' : role === 'rebase' ? 'implement' : role;
    const tier = (config.seatTiers ?? {})[verifier ? 'verify' : 'implement'] ?? 'low';
    const payloadText = payload ? await payload.assemblePayload(issue, config, clausesOf(issue)) : assembleFallback(issue, config);
    const res = await runTurn(seat, { role: seatRole, tier, payload: payloadText, sessionHint: verifier ? undefined : winner.sessionId }, { turnTimeoutMin: config.turnTimeoutMin, quietMs: deps.quietMs, clockNow: clock });
    const labels = stateLabels(issue.labels);
    if (!verifier && winner?.sessionId && res.sessionId && res.sessionId !== winner.sessionId) {
      // 新 session-id の turn は re-claim とみなす (§7 budget 算入・介入境界 §8) — 勝者継承しない起動は却下
      return { transition: 'claim-conflict', turn: role, labels, sessionId: res.sessionId, reason: 're-claim: 勝者と別 session-id (§7)' };
    }
    let gateRejects = 0;
    const prs = await forge.prsForIssue(issue.repo, issue.number);
    for (const a of res.actions) gateRejects += await executeAction(issue, config, a, prs[0] ?? null, verifier ? null : winner?.sessionId);
    if (!verifier) {
      await writeAccounting(issue, res.usage, winner.sessionId);
      const notes = await forge.notes(issue.id);
      const budget = computeLedger({ notes, sessionId: winner.sessionId, issueCreatedAt: issue.createdAt, nowIso: clock(), agents: config.agents }, config.budget);
      if (budget.over) return setBlocked(issue, 'blocked/budget', budget.reason ?? 'budget 超過 (概算込み、§7)', config);
    }
    return { transition: 'turn', turn: verifier ? 'review' : role, labels, sessionId: res.sessionId ?? winner?.sessionId ?? null, usage: res.usage, timedOut: res.timedOut, gateRejects };
  }

  async function writeAccounting(issue, usage, sessionId) {
    const line = `budget: consumed_usd=${usage.costUSD} consumed_seconds=${usage.seconds} at ${usage.at}`;
    const body = `${line}\n<!-- fp:summary resume ${usage.at} -->\n<!-- fp:session ${sessionId} -->`;
    if (body.length > (deps.config?.contextBudget ?? 16000)) throw new Error('台帳 comment が contextBudget 超過 (§6 間引き)');
    await forge.postComment(issue.id, body);
  }

  async function runIssue(issue, opts = {}) {
    const config = await readConfig();
    const state = stateLabels(issue.labels);
    if (issue.state === 'closed' || state[0] === 'done') return { transition: 'terminal', turn: 'none', labels: state };
    if ((issue.labels ?? []).includes('needs-info')) return { transition: 'needs-info', turn: 'none', labels: state };
    // plan turn 起動は決定論 MUST (scan が plan: header を読む、§7)。お題 Issue は claim 不可・author は humanAccounts MUST (§5)
    if (hasPlanHeader(issue.body)) {
      if (!(config.humanAccounts ?? []).includes(issue.author)) return { transition: 'plan-author-invalid', turn: 'none', reason: '一覧外 author のお題は gate が無視 (§5)' };
      return runPlan(issue, config, opts);
    }
    // 条項なし Issue の fail 判定 (claim 前、§3 §4.3)
    if (!hasAcceptClauses(issue.body) && state.length === 0) {
      return setBlocked(issue, 'blocked/spec-gap', '条項なし Issue の検出 (claim 前に fail 判定、§3・§4.3)', config);
    }
    if (!hasAcceptClauses(issue.body) && state[0] === 'claimed') {
      return setBlocked(issue, 'blocked/spec-gap', '条項なし・不明 (claimed → blocked/spec-gap、§3)', config);
    }
    // poll→claim: 勝者決定論 (created_at 先頭、同一秒は後着却下、§3)
    const notes = await forge.notes(issue.id);
    const claims = pickWinner(parseClaims(notes, { windowStart: opts.windowStart ?? config.scanWindowStart }));
    const winner = claims.winner;
    if (!winner) return { transition: 'no-claim', turn: 'none', reason: 'scan 窓内に成立した claim が無い (§3)' };
    if (opts.claimSessionId && opts.claimSessionId !== winner.sessionId) {
      await notifyLosers(winner, claims.losers);
      return { transition: 'claim-conflict', turn: 'none', sessionId: winner.sessionId, reason: '他セッションの claim は勝者ではない (§3)' };
    }
    // 復元: 勝者の session-id を継承 MUST (新 id は採らない。header は新 comment で更新、created_at は改変しない、§7)
    if (opts.resumeSessionId && opts.resumeSessionId === winner.sessionId) {
      await writeClaim(forge, issue.id, winner.sessionId, { resumeOf: winner, now: clock() });
    }
    const notesAfter = await forge.notes(issue.id);
    const budget = computeLedger({ notes: notesAfter, sessionId: winner.sessionId, issueCreatedAt: issue.createdAt, nowIso: clock(), agents: config.agents }, config.budget);
    const input = await buildDecideInput(issue, config, budget);
    const decision = decide(input);
    return executeTurn(issue, config, decision, winner, opts);
  }

  async function executeTurn(issue, config, decision, winner, opts) {
    const base = { transition: decision.turn, turn: decision.turn, labels: decision.labels, reason: decision.reason ?? null, sessionId: winner?.sessionId ?? null };
    switch (decision.turn) {
      case 'block':
        return setBlocked(issue, 'blocked/budget', decision.reason ?? 'budget 超過 (概算込み、§7)', config);
      case 'close': {
        const prs = await forge.prsForIssue(issue.repo, issue.number);
        if (!decision.labels.includes('done')) await forge.setLabel(issue.id, 'done');
        await forge.removeLabel(issue.id, 'claimed');
        await forge.removeLabel(issue.id, 'in_review');
        await forge.removeLabel(issue.id, 'rebase_required');
        await forge.closeIssue(issue.id);
        return { ...base, transition: 'done', merge: prs[0]?.state === 'merged' };
      }
      case 'submit': {
        if (decision.mergeAllowed) {
          const prs = await forge.prsForIssue(issue.repo, issue.number);
          const pr = prs[0];
          if (!pr) return { ...base, transition: 'gate-deny', reason: 'PR が無い (§7)' };
          const snapshot = async () => ({
            issueId: issue.id, prId: pr.id, headSha: pr.headSha, prState: pr.state, mergeable: pr.mergeable,
            labels: (await forge.issue(issue.id)).labels,
            checks: await forge.checks(pr.id), approvals: await forge.approvals(pr.id),
            threads: await forge.threads(pr.id), protection: await forge.protection(issue.repo),
            humanAccounts: config.humanAccounts, rejectCloses: rejectsClosesKeyword(pr.body), config,
          });
          const res = await mergeGate({ prId: pr.id, forge, snapshot, mergeMethod: config.mergeMethod ?? 'squash' });
          if (!res.merged) return { ...base, transition: 'gate-deny', recheck: res.recheck, reason: res.recheck.mismatchReason };
          return { ...base, transition: 'merged', merge: true };
        }
        // green + tier 要求承認未充足 → submit turn (review 依頼のみ、mergePr 不可、§7)
        const res = await runTurnAndRecord(issue, config, 'submit', winner, opts);
        const prs = await forge.prsForIssue(issue.repo, issue.number);
        const pr = prs[0];
        if (pr && pr.draft) {
          await runTurnAndRecord(issue, config, 'verify', winner, opts, { verifier: true });
          if (typeof forge.readyPR === 'function') await forge.readyPR(pr.id);
          else if (typeof forge.editPR === 'function') await forge.editPR(pr.id, { draft: false });
        }
        return res;
      }
      case 'review':
        return runTurnAndRecord(issue, config, 'verify', winner, opts, { verifier: true });
      case 'verify':
        return runTurnAndRecord(issue, config, 'verify', winner, opts, { checksOnly: true });
      case 'fix':
      case 'implement':
      case 'rebase':
        return runTurnAndRecord(issue, config, decision.turn === 'rebase' ? 'rebase' : 'implement', winner, opts);
      default:
        return { ...base, transition: decision.turn === 'none' ? 'idle' : decision.turn };
    }
  }

  /**
   * plan turn 起動は決定論 (§7: scan が plan: header を読む)。plan PR マージ後の child Issue 機械組立起票 (§5):
   * author=botActor、本文は plan PR 差分からの機械組立 (acceptBlock のみ・自由文なし)。plan PR merge/close は人間判断 (§9 介入 (d)) — loop は merge 成立後の起票のみ。
   */
  async function runPlan(issue, config, opts = {}) {
    const payloadText = payload ? await payload.assemblePayload(issue, config, clausesOf(issue)) : assembleFallback(issue, config);
    // TurnRole 列挙 (付録 A) では plan turn は investigate に写す (§6 の adapter 契約に適合 MUST)
    const res = await runTurnAll(seat, { role: 'investigate', tier: (config.seatTiers ?? {}).plan ?? 'high', payload: payloadText }, { turnTimeoutMin: config.turnTimeoutMin, quietMs: deps.quietMs, clockNow: clock });
    // plan turn 起動は決定論 (§5)。台帳は plan comment の fp:session marker で集計 (§7: 可視 `plan <id>` comment の hidden marker が勝者 session)。
    await forge.postComment(issue.id, `plan ${res.sessionId ?? 'n/a'}\n<!-- fp:session ${res.sessionId ?? 'n/a'} -->`);
    if (res.actions.length) {
      await forge.postComment(issue.id, res.actions.map((a) => `${a.kind}: ${a.body ?? a.label ?? ''}`).join('\n'));
    }
    for (const row of res.ledger) await writeAccounting(issue, row, res.sessionId);
    const notes = await forge.notes(issue.id);
    const planCap = { ...(config.budget ?? {}), maxTurns: config.planBudgetMaxTurns ?? config.budget?.maxTurns ?? 8 };
    const budget = computeLedger({ notes, sessionId: res.sessionId, claimAt: issue.createdAt, issueCreatedAt: issue.createdAt, nowIso: clock(), agents: config.agents }, planCap);
    if (budget.over) return setBlocked(issue, 'blocked/budget', budget.reason ?? 'plan turn の budget cap 超過 (§3 §7)', config);
    return { transition: 'plan', turn: 'plan', labels: stateLabels(issue.labels), sessionId: res.sessionId, usage: res.usage, timedOut: res.timedOut };
  }

  /** child Issue 機械組立 (§5 固定テンプレート: spec 条項参照・accept:<id>・scope 宣言のみ。自由文を本文に MUST NOT). */
  async function assembleChildrenAfterPlanMerge(issue, config) {
    const prs = await forge.prsForIssue(issue.repo, issue.number, { state: 'all' });
    const created = [];
    for (const pr of prs.filter((p) => p.state === 'merged')) {
      const text = typeof forge.prDiff === 'function' ? await forge.prDiff(pr.id) : String(pr.body ?? '');
      for (const child of extractPlanChildren(text)) {
        const body = childIssueBody(child);
        const res = await forge.draftIssue({ repo: issue.repo, title: child.title, body, labels: ['backlog'], author: config.botActor ?? 'fourth-power-bot' });
        created.push({ title: child.title, noteId: res?.id ?? res?.noteId ?? null });
      }
    }
    return created;
  }

  /** plan PR close 時は child Issue を残さない (撤回意味、§3 §5)。botActor 著者の open child を close する (orchestrator scan 窓から)。 */
  async function closePlanChildren(repo, config) {
    const issues = await forge.scanIssues(repo, { labels: ['backlog'], state: 'open' });
    const closed = [];
    for (const i of issues.filter((x) => x.author === (config.botActor ?? 'fourth-power-bot'))) {
      await forge.closeIssue(i.id);
      closed.push(i.id);
    }
    return closed;
  }

  return {
    config: readConfig,
    scan,
    runIssue,
    runPlan,
    assembleChildrenAfterPlanMerge,
    closePlanChildren,
    executeAction,
    buildDecideInput,
    claimIssue: (issueId, sessionId, opts) => writeClaim(forge, issueId, sessionId, { ...opts, now: clock() }),
  };
}

/** plan PR 差分テキストから child entry を機械抽出する (決定論。自由文でなく fenced acceptBlock 付き節のみ). */
export function extractPlanChildren(text) {
  const chunks = String(text ?? '').split(/(?=^#{1,4}\s*child\s*issue\s*:)/im);
  const children = [];
  for (const c of chunks) {
    const m = CHILD_SECTION_RE.exec(c);
    if (!m) continue;
    const block = parseAcceptBlock(c);
    if (!block || !block.accept?.length) continue; // acceptBlock のみ読む (§5)
    children.push({ title: m[2].trim(), accept: block.accept, scope: block.scope ?? [], refs: block.refs ?? [] });
  }
  return children;
}

/** child Issue 本文の機械組立 (§5 固定テンプレート: accept:<id> 参照・scope・条項参照のみ). */
export function childIssueBody(child) {
  const acceptLines = child.accept.map((a) => `accept: ${a.id}`);
  const refLines = child.refs.map((r) => `spec ${r.replace(/^spec\s+/, '')}`);
  const fence = JSON.stringify({ accept: child.accept, scope: child.scope, refs: child.refs });
  const body = [...acceptLines, ...refLines, '```acceptBlock', fence, '```'].join('\n');
  if (rejectsClosesKeyword(body)) throw new Error('child Issue 本文に Closes keyword (§3)');
  return body;
}



