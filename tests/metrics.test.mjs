import test from "node:test";
import assert from "node:assert/strict";
import { computeReport } from "../src/metrics.mjs";

const BOT = "fourth-power-bot";
const HUMAN = "pond-tail-nuka";
const T = (s) => `2026-10-01T${s}Z`;

function mkIssue(n, over = {}) {
  return {
    id: `i${n}`, number: n, repo: "r", title: `issue ${n}`, body: "", author: HUMAN,
    labels: ["backlog"], state: "open", createdAt: T("00:00:00"), updatedAt: T("00:00:00"),
    ...over,
  };
}
function mkPR(n, over = {}) {
  return {
    id: `p${n}`, number: n, repo: "r", base: "main", headSha: `sha${n}`, author: BOT,
    draft: false, labels: ["risk:low"], mergeable: true, state: "open", body: `squash(#${n})`,
    ...over,
  };
}
function mkNote(id, over = {}) {
  return { id, author: BOT, body: "", createdAt: T("00:00:00"), prNumber: null, issueNumber: null, resolved: null, ...over };
}
function mkCheck(over) {
  return { name: "accept", state: "success", headSha: "sha1", issuer: BOT, ...over };
}
const claimBody = (sess, at) => `claimed ${sess} at ${at}\n<!-- fp:session ${sess} -->`;
const turnBody = (sess, cost, sec, at) =>
  `submit <!-- fp:summary ${sess} --> budget: consumed_usd=${cost} consumed_seconds=${sec} at ${at} <!-- fp:session ${sess} -->`;
const acceptBody = `x\n\`\`\`acceptBlock\n{"accept":[{"id":"A1","kind":"test","cmd":"node --test tests/a.test.mjs"}]}\n\`\`\`\n`;
// §9 チェーン定義 (parent link) を含む child 本文 (§5 テンプレート写し)。
const childBody = (parent) => acceptBody.replace('{"accept"', `{"parent":"issue #${parent}","accept"`);
const mkStore = (parts) => ({ issues: [], prs: [], notes: [], checks: [], approvals: [], threads: [], ...parts });

function cleanChainStore() {
  const topic = mkIssue(1, { body: "plan: split into 2 children", author: HUMAN });
  const planPr = mkPR(2, { body: "plan sess-p #1", labels: ["risk:high"], state: "merged", headSha: "shaP" });
  const child = (n) => mkIssue(n, {
    author: BOT, body: acceptBody, labels: ["done"], state: "closed", createdAt: T("00:01:00"),
  });
  return mkStore({
    issues: [
      topic,
      child(3),
      child(4),
    ],
    prs: [
      planPr,
      mkPR(31, { body: "squash(#3)", state: "merged", headSha: "sha3", labels: ["risk:low"] }),
      mkPR(32, { body: "squash(#4)", state: "merged", headSha: "sha4", labels: ["risk:low"] }),
    ],
    notes: [
      mkNote("n31", { body: claimBody("c3", T("00:05:00")), createdAt: T("00:05:00"), issueNumber: 3 }),
      mkNote("n32", { body: turnBody("c3", 0.4, 100, T("00:06:00")), createdAt: T("00:06:00"), issueNumber: 3 }),
      mkNote("n41", { body: claimBody("c4", T("00:07:00")), createdAt: T("00:07:00"), issueNumber: 4 }),
      mkNote("n42", { body: turnBody("c4", 0.6, 140, T("00:08:00")), createdAt: T("00:08:00"), issueNumber: 4 }),
    ],
    checks: [
      mkCheck({ headSha: "sha3" }),
      mkCheck({ headSha: "sha4" }),
      mkCheck({ name: "risk-tier", headSha: "shaP" }),
    ],
    approvals: [{ reviewer: HUMAN, sha: "shaP" }],
  });
}

test("clean chain: autonomy rate 1.0, zero interventions except plan merge (d)", () => {
  const r = computeReport(cleanChainStore());
  assert.equal(r.autonomy.topicChain.rate, 1);
  assert.deepEqual(r.autonomy.topicChain, { issues: 2, cleanDone: 2, rate: 1 });
  assert.deepEqual(r.autonomy.interventions, { a: 0, b: 0, c: 0, d: 1, total: 1 });
  assert.equal(r["positive-implementation"].done, 2);
  assert.equal(r["positive-implementation"].acceptGreenDone, 2);
  assert.deepEqual(r["positive-implementation"].doneWithoutAcceptGreen, []);
  assert.equal(r["positive-implementation"].falseGreen, false);
  assert.equal(r["implementation-success-rate"].rate, 1);
  assert.equal(r["implementation-success-rate"].firstPass, 2);
  assert.equal(r.efficiency.turns, 2);
  assert.equal(r.efficiency.prAttempts, 2);
  assert.equal(r.efficiency.seconds, 240);
  assert.equal(r.efficiency.costUSD, 1);
  assert.equal(r.efficiency.gateRejects, 0);
  assert.equal(r.autonomy.requiredApprovals, 0);
  assert.equal(r.stability.claimConflicts, 0);
  assert.equal(r.stability.residueFreeRate, 1);
  assert.deepEqual(r["decomposition-quality"].childDoneRate, 1);
  assert.equal(r["decomposition-quality"].planOneShotApprovalRate, 1);
});
test("re-claim drops first-pass rate", () => {
  const store = mkStore({
    issues: [mkIssue(5, { labels: ["done"], state: "closed" })],
    prs: [mkPR(50, { body: "squash(#5)", state: "merged", headSha: "sha5" })],
    notes: [
      mkNote("n1", { body: claimBody("s1", T("00:05:00")), createdAt: T("00:05:00"), issueNumber: 5 }),
      mkNote("n2", { body: claimBody("s2", T("00:10:00")), createdAt: T("00:10:00"), issueNumber: 5 }),
      mkNote("n3", { body: turnBody("s2", 0.5, 60, T("00:11:00")), createdAt: T("00:11:00"), issueNumber: 5 }),
    ],
    checks: [mkCheck({ headSha: "sha5" })],
  });
  const r = computeReport(store);
  assert.equal(r["implementation-success-rate"].doneTotal, 1);
  assert.equal(r["implementation-success-rate"].firstPass, 0);
  assert.equal(r["implementation-success-rate"].rate, 0);
  assert.deepEqual(r.autonomy.interventions.c, 1);
  assert.equal(r.details[0].reClaim, true);
});

test("interventions (a) re-triage, (b) accept edit, (d) plan close counted", () => {
  const store = mkStore({
    issues: [
      mkIssue(1, { body: "plan: topic", author: HUMAN }), // plan PR closed -> (d)
      mkIssue(2, { author: BOT, body: childBody(1), state: "closed" }), // closed child -> (a) via retriage (parent link #1)
      mkIssue(3, { labels: ["backlog"] }), // re-triaged with closed PR -> (a)
      mkIssue(4, {}), // accept edited -> (b)
    ],
    prs: [
      mkPR(10, { body: "plan sess-p #1", state: "closed", headSha: "shaP" }),
      mkPR(30, { body: "squash(#3)", state: "closed", headSha: "sha3" }),
      mkPR(40, { body: "squash(#4)", state: "merged", headSha: "sha4", author: HUMAN, labels: ["exempt:accept-author"] }),
    ],
    checks: [mkCheck({ headSha: "sha4" })],
  });
  const r = computeReport(store);
  assert.deepEqual(r.autonomy.interventions, { a: 2, b: 1, c: 0, d: 1, total: 4 });
  assert.deepEqual(r.autonomy.topicChain, { issues: 0, cleanDone: 0, rate: 0 }); // withdrawn chain excluded
});
test("retriage scoped by parent link: 別 topic の child・merge 完了 child は介入 (a) 不算入 (誤検知対策)", () => {
  const store = mkStore({
    issues: [
      mkIssue(1, { body: "plan: topic", author: HUMAN, state: "closed" }), // topic A closed = 撤回
      mkIssue(2, { author: BOT, body: childBody(1), state: "closed" }),    // A の child・未マージ close → (a)
      mkIssue(3, { author: BOT, body: childBody(30), state: "closed", labels: ["done"] }), // B の child・PR merged → 完遂なので不算入
      mkIssue(30, { body: "plan: topic", author: HUMAN }), // topic B open (撤回でなし)
      mkIssue(31, { author: BOT, body: childBody(30), state: "closed" }), // B の child で B open → 撤回対象外
    ],
    prs: [mkPR(60, { body: "squash(#3)", state: "merged", headSha: "shaC" })],
  });
  const r = computeReport(store);
  assert.equal(r.autonomy.interventions.a, 1);
});

test("topic closed かつ全 child マージ済み = チェーン完遂 (誤撤回しない — P2 driver の終端形)", () => {
  const store = mkStore({
    issues: [
      mkIssue(1, { body: "plan: topic", author: HUMAN, state: "closed", labels: ["done"] }),
      mkIssue(2, { author: BOT, body: childBody(1), state: "closed", labels: ["done"] }),
      mkIssue(9, { author: "fourth-power-bot", body: acceptBody, state: "closed" }), // parent link なし = 無関係な closed bot Issue
    ],
    prs: [
      mkPR(10, { body: "plan sess-p #1", state: "merged", headSha: "shaP", author: HUMAN }),
      mkPR(70, { body: "squash(#2)", state: "merged", headSha: "sha70" }),
    ],
  });
  const r = computeReport(store);
  // plan PR merge は介入 (d)(§9 正当)。介入 (a) の誤検知は 0、child merge 完遂なので a 加算なし。
  assert.deepEqual(r.autonomy.interventions, { a: 0, b: 0, c: 0, d: 1, total: 1 });
});

test("human approval is not an intervention but counts as required approval", () => {
  const store = mkStore({
    issues: [mkIssue(6, { labels: ["done"], state: "closed" })],
    prs: [mkPR(60, { body: "squash(#6)", state: "merged", headSha: "sha6", labels: ["risk:high"] })],
    notes: [
      mkNote("n1", { body: claimBody("s6", T("00:05:00")), createdAt: T("00:05:00"), issueNumber: 6 }),
      mkNote("n2", { body: turnBody("s6", 0.2, 30, T("00:06:00")), createdAt: T("00:06:00"), issueNumber: 6 }),
      mkNote("n3", { body: "LGTM <!-- fp:session s6 -->", createdAt: T("00:07:00"), issueNumber: 6, author: HUMAN }),
    ],
    checks: [mkCheck({ headSha: "sha6" }), mkCheck({ name: "risk-tier", headSha: "sha6" })],
    approvals: [{ reviewer: HUMAN, sha: "sha6" }],
  });
  const r = computeReport(store);
  assert.deepEqual(r.autonomy.interventions, { a: 0, b: 0, c: 0, d: 0, total: 0 });
  assert.equal(r.autonomy.requiredApprovals, 1);
  assert.equal(r.autonomy.approvalsSatisfied, 1);
  assert.equal(r.efficiency.gateRejects, 0);
  assert.equal(r["implementation-success-rate"].rate, 1);
  assert.equal(r.efficiency.turns, 1); // claim + human comment excluded from ledger
});

test("false green detected by check-history cross-check (stale green, no green at merge sha)", () => {
  const store = mkStore({
    issues: [mkIssue(7, { labels: ["done"], state: "closed" })],
    prs: [
      mkPR(70, { body: "squash(#7)", state: "closed", headSha: "shaA" }),
      mkPR(71, { body: "squash(#7)", state: "merged", headSha: "shaB" }),
    ],
    notes: [mkNote("n1", { body: claimBody("s7", T("00:05:00")), createdAt: T("00:05:00"), issueNumber: 7 })],
    checks: [mkCheck({ headSha: "shaA" })],
  });
  const r = computeReport(store);
  assert.deepEqual(r["positive-implementation"].doneWithoutAcceptGreen, ["i7"]);
  assert.equal(r["positive-implementation"].falseGreen, true);
  assert.deepEqual(r["positive-implementation"].falseGreenIssues, ["i7"]);
  assert.equal(r.efficiency.gateRejects, 1);
});

test("same-second claims are conflicts, loser comments stay out of the budget ledger", () => {
  const store = mkStore({
    issues: [mkIssue(8, { labels: ["done"], state: "closed" })],
    prs: [mkPR(80, { body: "squash(#8)", state: "merged", headSha: "sha8" })],
    notes: [
      mkNote("n1", { body: claimBody("x", T("00:05:00")), createdAt: T("00:05:00"), issueNumber: 8 }),
      mkNote("n2", { body: claimBody("y", T("00:05:00")), createdAt: T("00:05:00"), issueNumber: 8 }),
      mkNote("n3", { body: turnBody("x", 0.2, 40, T("00:06:00")), createdAt: T("00:06:00"), issueNumber: 8 }),
      mkNote("n4", { body: turnBody("y", 0.3, 50, T("00:06:30")), createdAt: T("00:06:30"), issueNumber: 8 }),
    ],
    checks: [mkCheck({ headSha: "sha8" })],
  });
  const r = computeReport(store);
  assert.equal(r.stability.claimConflicts, 1);
  assert.equal(r.efficiency.turns, 1);
  assert.equal(r.efficiency.costUSD, 0.2);
  assert.equal(r["implementation-success-rate"].rate, 1);
});

test("resume inherits session: restore counted, first-pass dropped; done+open is residue", () => {
  const store = mkStore({
    issues: [
      mkIssue(9, { labels: ["done"], state: "closed" }),
      mkIssue(10, { labels: ["done"], state: "open" }),
    ],
    prs: [
      mkPR(90, { body: "squash(#9)", state: "merged", headSha: "sha9" }),
      mkPR(100, { body: "squash(#10)", state: "merged", headSha: "sha10" }),
    ],
    notes: [
      mkNote("n1", { body: `claimed r1 at ${T("00:05:00")} resumed ${T("01:00:00")}\n<!-- fp:session r1 -->`, createdAt: T("00:05:00"), issueNumber: 9 }),
      mkNote("n2", { body: turnBody("r1", 0.1, 20, T("01:05:00")), createdAt: T("01:05:00"), issueNumber: 9 }),
    ],
    checks: [mkCheck({ headSha: "sha9" }), mkCheck({ headSha: "sha10" })],
  });
  const r = computeReport(store);
  assert.equal(r.stability.restores, 1);
  assert.equal(r.stability.restoreSuccessRate, 1);
  assert.equal(r["implementation-success-rate"].rate, 0.5);
  assert.deepEqual(r.stability.residueIssues, ["i10"]);
  assert.equal(r.stability.residueFreeRate, 0.5);
});
