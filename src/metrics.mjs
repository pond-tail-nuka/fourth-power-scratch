// src/metrics.mjs - metrics (spec 9 + M5 performance viewpoint groups).
// computeReport(store) derives ONLY from the normalized forge ledger
// (objects in src/types.mjs shapes). No local counters, no secrets, no
// external calls (spec 9 cohort bullet: local aggregation MUST NOT).
// Intervention judgment counts action types only (spec 9 numerator bullet),
// never comment-text patterns: verifier comments, gate approvals, loser
// claims and ledger rows are NOT interventions.

const DEFAULTS = {
  botActor: "fourth-power-bot",
  acceptJobName: "accept",
  humanAccounts: ["pond-tail-nuka"],
  exemptLabel: "exempt:accept-author",
};

const CLAIM_RE = /^claimed\s+(\S+)\s+at\s+(\S+)/;
const RESUME_RE = /\bresumed\s+\S+/;
const MERGE_SUBJECT_RE = /^(\w+)\(#(\d+)\)/;
const BUDGET_RE = /budget:\s*consumed_usd=([\d.]+)\s+consumed_seconds=(\d+)\s+at\s+\S+/;
const SESSION_RE = /<!--\s*fp:session\s+(\S+)\s*-->/;
const STATE_LABELS = ["backlog", "claimed", "in_review", "rebase_required", "done"];

function isoSec(iso) {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function isClaimNote(n) {
  return CLAIM_RE.test(String(n && n.body || ""));
}

function parseClaimBody(body) {
  const m = CLAIM_RE.exec(String(body || ""));
  return m ? { sessionId: m[1], at: m[2], resumed: RESUME_RE.test(body) } : null;
}

function sessionOf(body) {
  const m = SESSION_RE.exec(String(body || ""));
  return m ? m[1] : null;
}

// visible header lines: `plan <session-id>` / `plan: ...` / `plan <id> at ...`
function planHeaderOf(text) {
  const m = /^plan[:\s](\S+)?/m.exec(String(text || ""));
  return m ? { sessionId: m[1] || null } : null;
}

function stateOf(labels) {
  for (const s of STATE_LABELS) if (labels.includes(s)) return s;
  for (const l of labels) if (l.startsWith("blocked/")) return l;
  return null;
}
// Winner = earliest created_at (spec 3). Same-second claims are conflicts
// (loser rejected, comment kept). A later claim with a DIFFERENT session id
// is a re-claim (spec 9 (c)); same-second same-id claims stay out of it.
// A later claim with the SAME session id is a restore/resume (spec 7: id
// inheritance, header `... resumed <iso>`), not a re-claim.
function classifyClaims(notes) {
  const claims = notes.filter(isClaimNote).sort((a, b) => isoSec(a.createdAt) - isoSec(b.createdAt));
  const result = { reClaimCount: 0, conflictCount: 0, resume: false, winner: null };
  for (const n of claims) {
    const parsed = parseClaimBody(n.body);
    const sec = isoSec(n.createdAt);
    if (!result.winner) {
      result.winner = { note: n, parsed, sec };
      if (parsed.resumed) result.resume = true;
      continue;
    }
    if (result.winner.sec === sec) {
      result.conflictCount += 1;
      continue;
    }
    if (parsed.sessionId === result.winner.parsed.sessionId) {
      result.resume = true;
      continue;
    }
    result.reClaimCount += 1;
    result.winner = { note: n, parsed, sec };
  }
  return result;
}

function isAgentAuthor(author, cfg) {
  return !cfg.humanAccounts.includes(author);
}

function notesForIssue(store, issue) {
  return store.notes.filter((n) => n.issueNumber === issue.number);
}

function prsForIssue(store, issue) {
  const re = new RegExp(`#${issue.number}\\D`);
  return store.prs.filter((p) => p.base === "main" && planHeaderOf(p.body) === null && re.test(p.body || ""));
}

function checksForSha(store, sha) {
  return store.checks.filter((c) => c.headSha === sha);
}

// Merge record: merged main PR with subject `<method>(#<issueNumber>)`
// (squash/merge/rebase prefix), OR a plan PR whose body header links the topic
// issue. Returns { pr, kind: 'issue'|'plan', issueNumber }
function mergeRecords(store) {
  const out = [];
  for (const p of store.prs) {
    if (p.state !== "merged" || p.base !== "main") continue;
    const plan = planHeaderOf(p.body);
    if (plan) {
      const m = MERGE_SUBJECT_RE.exec(p.body);
      out.push({ pr: p, kind: "plan", issueNumber: m ? Number(m[2]) : null });
      continue;
    }
    const m = MERGE_SUBJECT_RE.exec(p.body);
    if (m && (m[1] === "squash" || m[1] === "merge" || m[1] === "rebase")) {
      out.push({ pr: p, kind: "issue", issueNumber: Number(m[2]) });
    }
  }
  return out;
}

// ---- analyze ----
// intervention judgment per issue record: action types (a)-(d) only (spec 9),
// detected from normalized state + claim/plan records, never comment text.
// env: { mergedPr, topicPlanPrs, childClosedByRetriage, acceptEdited }
function analyzeIssue(store, cfg, issue, env) {
  const labels = issue.labels || [];
  const state = stateOf(labels);
  const claims = classifyClaims(notesForIssue(store, issue));
  const planHdr = planHeaderOf(issue.body);
  const isTopic = planHdr !== null && cfg.humanAccounts.includes(issue.author);
  const isChild = !isTopic && issue.author === cfg.botActor && planHdr === null &&
    /accept/.test(String(issue.body || ""));
  const prs = isTopic ? env.topicPlanPrs || [] : prsForIssue(store, issue);
  const inter = { a: 0, b: 0, c: 0, d: 0 };
  // (a) re-triage blocked/* -> backlog (spec 3: claim label removed,
  // unmerged PR closed); child closes on topic re-triage (open topic,
  // closed child = spec 3 withdrawal, counts as intervention)
  if (!isTopic && labels.includes("backlog") && prs.some((p) => p.state === "closed")) inter.a += 1;
  if (issue.state === "closed" && env.childClosedByRetriage.has(issue.id)) inter.a += 1;

  // (b) human edit of accept clause / ci/accept: merged PR carrying the
  // human-only exempt accept-author label (spec 4.2), linked to this issue
  if (env.acceptEdited.has(issue.number)) inter.b += 1;

  // (c) re-claim (later claim comment with a different session id)
  inter.c += claims.reClaimCount;

  // (d) plan PR merge and close: topic record only (human judgment, spec 9)
  if (isTopic) inter.d += (env.topicPlanPrs || []).filter((p) => p.state !== "open").length;
  const total = inter.a + inter.b + inter.c + inter.d;
  const mergedPr = env.mergedPr || null;
  const done = state === "done";
  const acceptGreen = mergedPr !== null && hasAcceptGreenAtMerge(store, cfg, mergedPr);
  const branchGreens = prs.some((p) => checksForSha(store, p.headSha).some(
    (c) => c.name === cfg.acceptJobName && c.state === "success" && c.issuer === cfg.botActor));
  // false green (check history cross-check): done shows accept green on the
  // branch, but the merged head sha does not carry it (gaming / stale run)
  const falseGreen = done && mergedPr !== null && !acceptGreen && branchGreens;
  const firstPass = done && claims.reClaimCount === 0 && !claims.resume;

  const session = claims.winner ? claims.winner.parsed.sessionId : null;
  const budget = session ? budgetForIssue(store, cfg, session, issue, prs)
    : { turns: 0, seconds: 0, cost: 0, accountingMismatch: false };
  const tierLow = mergedPr !== null && (mergedPr.labels || []).includes("risk:low");
  const required = mergedPr === null || isTopic || tierLow ? 0 : (cfg.requiredApprovals ?? 1);
  const approvalSatisfied = required === 0 || store.approvals.some(
    (a) => cfg.humanAccounts.includes(a.reviewer) && a.sha === mergedPr.headSha);
  return {
    id: issue.id, number: issue.number, repo: issue.repo, state, isTopic, isChild, done,
    blocked: state !== null && state.startsWith("blocked/"),
    interventions: { ...inter, total },
    childInterventions: inter.a + inter.b + inter.c,
    claimConflictCount: claims.conflictCount,
    reClaim: claims.reClaimCount > 0,
    resumed: claims.resume,
    firstPass, acceptGreenAtMerge: acceptGreen, falseGreen,
    turns: budget.turns, seconds: budget.seconds, costUSD: budget.cost,
    accountingMismatch: budget.accountingMismatch,
    prAttempts: isTopic ? 0 : prs.length,
    gateRejects: isTopic ? 0 : gateRejects(store, cfg, prs),
    requiredApproval: required, approvalSatisfied,
    // residue (spec 2.1 / 7): done label without close or without merge record
    residue: done && (issue.state === "open" || mergedPr === null),
    restored: claims.resume,
  };
}

function hasAcceptGreenAtMerge(store, cfg, pr) {
  return checksForSha(store, pr.headSha).some(
    (c) => c.name === cfg.acceptJobName && c.state === "success" && c.issuer === cfg.botActor);
}

function budgetForIssue(store, cfg, winnerSession, issue, prs) {
  const prNumbers = new Set(prs.map((p) => p.number));
  let turns = 0, seconds = 0, cost = 0, mismatch = false;
  for (const n of store.notes) {
    const belongs = n.issueNumber === issue.number || (n.prNumber !== null && prNumbers.has(n.prNumber));
    if (!belongs) continue;
    if (isClaimNote(n)) continue; // claim row is window start, not a turn
    if (!isAgentAuthor(n.author, cfg)) continue;
    const sess = sessionOf(n.body);
    if (sess !== null && sess !== winnerSession) continue; // other sessions out of ledger
    if (sess === null && n.author !== cfg.botActor) continue;
    turns += 1;
    const b = BUDGET_RE.exec(n.body);
    if (b) { cost += Number(b[1]); seconds += Number(b[2]); }
    else mismatch = true; // turn with no accounting row -> conservative 1-turn gap
  }
  return { turns, seconds, cost, accountingMismatch: mismatch };
}

// Gate rejects (efficiency: gate reject count), deterministic signals:
// - an approval whose sha != current head sha (invalidated -> re-review),
// - a merged PR whose merged sha has no accept green (gate should have refused),
// - a merged high-tier PR with no human approval at the merged sha.
function gateRejects(store, cfg, prs) {
  let rejects = 0;
  for (const p of prs) {
    const cs = checksForSha(store, p.headSha).filter((c) => c.issuer === cfg.botActor);
    if (p.state === "merged") {
      const acceptGreen = cs.some((c) => c.name === cfg.acceptJobName && c.state === "success");
      if (!acceptGreen) rejects += 1;
      const high = !(p.labels || []).includes("risk:low");
      const humanAtSha = store.approvals.some((a) => cfg.humanAccounts.includes(a.reviewer) && a.sha === p.headSha);
      if (high && !humanAtSha) rejects += 1;
    }
  }
  return rejects;
}

export function computeReport(store, options = {}) {
  const cfg = { ...DEFAULTS, ...(options.config || {}) };
  const issues = store.issues || [];
  const merges = mergeRecords(store);
  const issueMerge = new Map();
  for (const m of merges) if (m.kind === "issue" && m.issueNumber) issueMerge.set(m.issueNumber, m.pr);
  const topics = issues.filter((i) => planHeaderOf(i.body) && cfg.humanAccounts.includes(i.author));
  const planPrsByTopic = new Map();
  for (const p of store.prs) {
    const hdr = p.base === "main" ? planHeaderOf(p.body) : null;
    if (!hdr) continue;
    const link = /#(\d+)/.exec(p.body || "");
    const topic = topics.find((t) =>
      (link !== null && t.number === Number(link[1])) ||
      (hdr.sessionId !== null && planHeaderOf(t.body).sessionId === hdr.sessionId));
    if (!topic) continue;
    if (!planPrsByTopic.has(topic.number)) planPrsByTopic.set(topic.number, []);
    planPrsByTopic.get(topic.number).push(p);
  }
  const acceptEdited = new Set();
  for (const p of store.prs) {
    if (p.base === "main" && cfg.humanAccounts.includes(p.author) &&
      (p.labels || []).includes(cfg.exemptLabel)) {
      const link = /#(\d+)/.exec(p.body || "");
      if (link) acceptEdited.add(Number(link[1]));
    }
  }
  const childClosedByRetriage = new Set();
  for (const t of topics) {
    const chainPrs = planPrsByTopic.get(t.number) || [];
    if (chainPrs.some((p) => p.state === "closed") || t.state === "closed") {
      for (const c of issues) {
        if (c.author === cfg.botActor && planHeaderOf(c.body) === null && c.state === "closed") {
          childClosedByRetriage.add(c.id);
        }
      }
    }
  }
  // stale approval: sha is a known executed commit but no longer any PR head
  // (head moved -> approval dismissed; spec 8 sha-approval re-check reject)
  const allHeads = new Set(store.prs.map((p) => p.headSha));
  const knownShas = new Set(store.checks.map((c) => c.headSha));
  const invalidatedApprovals = store.approvals.filter((a) => !allHeads.has(a.sha) && knownShas.has(a.sha)).length;
  const recs = issues.map((issue) => analyzeIssue(store, cfg, issue, {
    mergedPr: issueMerge.get(issue.number) || null,
    topicPlanPrs: planPrsByTopic.get(issue.number) || [],
    childClosedByRetriage,
    acceptEdited,
  }));
  const claimed = recs.filter((r) => !r.isTopic);
  const doneRecs = claimed.filter((r) => r.done);
  const interSum = { a: 0, b: 0, c: 0, d: 0, total: 0 };
  for (const r of recs) for (const k of ["a", "b", "c", "d", "total"]) interSum[k] += r.interventions[k];
  const issueByNumber = new Map(issues.map((i) => [i.number, i]));
  const sortedTopics = [...topics].sort((a, b) => (isoSec(a.createdAt) ?? 0) - (isoSec(b.createdAt) ?? 0));
  const chainOfTopic = (r) => {
    const issue = issueByNumber.get(r.number);
    let chosen = null;
    for (const t of sortedTopics) if ((isoSec(t.createdAt) ?? 0) <= (isoSec(issue.createdAt) ?? 0)) chosen = t;
    return chosen || sortedTopics[0] || null;
  };
  const chainPrsOf = (t) => planPrsByTopic.get(t.number) || [];
  let chainDen = 0;
  let chainNum = 0;
  for (const r of claimed.filter((x) => x.isChild)) {
    const t = chainOfTopic(r);
    if (t === null || chainPrsOf(t).some((p) => p.state === "closed")) continue;
    chainDen += 1;
    if (r.done && r.childInterventions === 0) chainNum += 1;
  }
  const childRecs = claimed.filter((x) => x.isChild);
  const planPrs = [...planPrsByTopic.values()].flat();
  const planApprovedFirst = planPrs.filter((p) => p.state === "merged" &&
    store.approvals.some((a) => cfg.humanAccounts.includes(a.reviewer) && a.sha === p.headSha)).length;
  const restores = claimed.filter((r) => r.restored).length;
  const restoreOk = claimed.filter((r) => r.restored && r.done).length;
  const residues = recs.filter((r) => r.residue).map((r) => r.id);
  const doneFirstPass = doneRecs.filter((r) => r.firstPass).length;
  return {
    "positive-implementation": {
      done: doneRecs.length,
      acceptGreenDone: doneRecs.filter((r) => r.acceptGreenAtMerge).length,
      doneWithoutAcceptGreen: doneRecs.filter((r) => !r.acceptGreenAtMerge).map((r) => r.id),
      falseGreen: recs.some((r) => r.falseGreen),
      falseGreenIssues: recs.filter((r) => r.falseGreen).map((r) => r.id),
    },
    "implementation-success-rate": {
      firstPass: doneFirstPass,
      doneTotal: doneRecs.length,
      rate: doneRecs.length ? doneFirstPass / doneRecs.length : null,
    },
    autonomy: {
      interventions: interSum,
      requiredApprovals: claimed.reduce((n, r) => n + r.requiredApproval, 0),
      approvalsSatisfied: claimed.filter((r) => r.requiredApproval > 0 && r.approvalSatisfied).length,
      topicChain: topics.length ? { issues: chainDen, cleanDone: chainNum, rate: chainDen ? chainNum / chainDen : 0 } : null,
    },
    efficiency: {
      turns: claimed.reduce((n, r) => n + r.turns, 0),
      prAttempts: claimed.reduce((n, r) => n + r.prAttempts, 0),
      seconds: claimed.reduce((n, r) => n + r.seconds, 0),
      costUSD: claimed.reduce((n, r) => n + r.costUSD, 0),
      gateRejects: claimed.reduce((n, r) => n + r.gateRejects, 0) + invalidatedApprovals,
    },
    stability: {
      restores,
      restoreSuccessRate: restores ? restoreOk / restores : 1,
      residueIssues: residues,
      residueFreeRate: recs.length ? 1 - residues.length / recs.length : 1,
      claimConflicts: claimed.reduce((n, r) => n + r.claimConflictCount, 0),
    },
    "decomposition-quality": {
      children: childRecs.length,
      childDone: childRecs.filter((r) => r.done).length,
      childDoneRate: childRecs.length ? childRecs.filter((r) => r.done).length / childRecs.length : null,
      planPrs: planPrs.length,
      planApprovedFirst,
      planOneShotApprovalRate: planPrs.length ? planApprovedFirst / planPrs.length : null,
    },
    details: recs,
  };
}

