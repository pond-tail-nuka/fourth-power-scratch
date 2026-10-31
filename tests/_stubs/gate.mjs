// tests/_stubs/gate.mjs — contract §5 の決定表ミニスタブ (conformance suite フォールバック用)。
// 本実装 (src/gate.mjs) が conformance suite の shape 突合を通過すれば、このスタブは使われない。
// 行優先 MUST (spec §7): budget 超過 > dirty > open thread > CI red > CI pending > green。
// 行は 1 つの決定論的遷移 (ラベル + turn) に限定。ラベル正式名のみ使い、可視・API 由来の入力のみ読む (spec §12: hidden 入力なし)。
const STATE_LABELS = [
  'backlog', 'claimed', 'in_review', 'rebase_required',
  'blocked/budget', 'blocked/spec-gap', 'blocked/infra', 'done',
];

export function decide(input) {
  const {
    labels = [],
    prState = 'none', // 'none' | 'draft' | 'open' | 'closed' | 'merged'
    ciState = 'none', // 'none' | 'pending' | 'green' | 'red'
    threads = 0,
    approvals = [],
    budget = { over: false },
    headSha = null,
    mergeable = 'clean', // 'clean' | 'dirty' | 'unknown'
    tierRequired = 'high',
    human = [],
    planHeader = false,
    issueOpen = true,
  } = input;
  const has = (l) => labels.includes(l);
  const out = (next, turn, extra = {}) => ({ labels: next, turn, ...extra });
  const stateCount = labels.filter((l) => STATE_LABELS.includes(l)).length;
  if (stateCount > 1) return out(labels, 'none', { exclusiveConflict: true });
  // 不変 (assert 用): decide はどの行でも privileged label (plan:approved 等) を付与しない — 人間・bootstrap のみ (spec §4.2 §8)。
  // 行 1: budget 超過 → blockIssue (blocked/budget) — 優先最頭 (spec §7)。
  if (budget && budget.over) return out(['blocked/budget'], 'block');
  // 行 2: mergeable dirty → rebase turn。
  if (mergeable === 'dirty' && prState === 'open') return out(['rebase_required'], 'rebase');
  // 行 3: open thread ≥1 → fix turn (in_review 維持)。
  if (threads >= 1) return out(['in_review'], 'fix');
  // 行 4: CI red。
  if (ciState === 'red') {
    if (has('rebase_required')) return out(['rebase_required'], 'rebase'); // rebase 継続 (re-push 後 CI 検証)
    return out(labels, 'fix'); // 現ラベル維持 (in_review から claimed へ戻さない)
  }
  // 行 5: CI pending → verify turn (読みのみ、thread・承認判定なし)。
  if (ciState === 'pending') return out(labels, 'verify');
  // 行 6: green 系統。承認の head SHA 突合 (spec §8 — 承認後の新 commit は再 review)。
  if (ciState === 'green') {
    const approvalOk = approvals.some((a) => (tierRequired === 'high' ? human.includes(a.reviewer) : true) && (headSha == null || a.sha === headSha));
    if (approvals.length > 0 && !approvalOk) return out(labels, 'review'); // sha 不一致・human 外承認 → 再 review
    if (!approvalOk) return out(labels, 'submit'); // 承認未充足 → submit (review 依頼のみ、mergePr 不可)
    return out(labels, 'submit', { mergeAllowed: true });
  }
  // PR 系統 (green でない読み): PR 無し (claimed) → implement、draft → implement 継続。
  if (prState === 'merged') {
    if (!has('done')) return out([...labels.filter((l) => l !== 'claimed'), 'done'], 'none'); // done ラベルが状態の正 (spec §3)
    return out(labels, issueOpen ? 'close' : 'none'); // done + Issue open → close 是正
  }
  if (prState === 'closed') return out(labels, 'none'); // 未マージ close → 再 triage 待ち (ラベル維持、人間判断)
  if (prState === 'none' && has('claimed')) return out(labels, 'implement');
  if (prState === 'draft') return out(labels, 'implement');
  // plan: header の起動トリガーは決定論 (scan が読む、spec §7) — 状態ラベルは動かさない (privileged label は人間のみ)。
  if (planHeader && has('backlog')) return out(labels, 'plan');
  return out(labels, 'none');
}
