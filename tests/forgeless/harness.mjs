// tests/forgeless/harness.mjs — forge ゼロテストハーネス (spec §11 mock bullet・§10 M5・人間行為自動テスト)。
// src/forge.mjs (API adapter) と executor (bare repo git) を通さない: mockServer REST store が直接の正。
// git は in-memory provider (branch→file map、sha=content hash) に置換し、checks は workDir を fs で再構築する。
// orchestrator・gate・budget・runner・metrics は本物 (import そのまま)。human actor は REST 書き込み endpoint を
// 直接叩く (GitHub の人間 review 書き込みの写し) — 「人間に期待する挙動」の自動テストの書き込み側になる。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import * as store from '../mock-forge/store.mjs';
import * as mockServer from '../mock-forge/mockServer.mjs';
import { createOrchestrator } from '../../src/loop.mjs';
import { computeReport } from '../../src/metrics.mjs';

const ISSUE_ID_RE = /^(.+)#(\d+)$/;
const PR_ID_RE = /^(.+)!(\d+)$/;
const NOTE_ID_RE = /^(.+)([#!])(\d+)\/(\d+)$/;

// src/forge.mjs のラベル排他 (§1 invariant) の写し — harness も同一の集合挙動を持つ。
const STATE_LABELS = ['backlog', 'claimed', 'in_review', 'rebase_required', 'blocked/budget', 'blocked/spec-gap', 'blocked/infra', 'done'];
function labelClass(label) {
  if (STATE_LABELS.includes(label) || label.startsWith('blocked/')) return 'state';
  if (label.startsWith('cohort:')) return 'cohort';
  if (label.startsWith('accept:')) return 'accept';
  if (label.startsWith('plan:')) return 'plan';
  if (label.startsWith('risk:')) return 'risk';
  if (label.startsWith('exempt:')) return 'exempt';
  if (label.startsWith('peer/')) return 'peer';
  return null;
}

function parseAcceptBlock(body) {
  const m = /```acceptBlock\s*\n([\s\S]*?)\n```/.exec(body ?? '');
  return m ? JSON.parse(m[1]) : null;
}

function shaOf(files) {
  const entries = Object.entries(files).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => [k, String(v)]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function createForgelessHarness({ repoKey = 'fourth-power/mock-scratch', baseISO = '2026-01-01T00:00:00Z', mainFiles = {}, seat = null, runner = null } = {}) {
  const main = new Map();
  const branchFiles = new Map();
  const shas = new Set();
  const refreshMainSha = () => { const s = shaOf(Object.fromEntries(main)); shas.add(s); return s; };

  const branchProvider = (key, branch) => {
    if (key !== repoKey) return null;
    if (branch === 'main') return shaOf(Object.fromEntries(main));
    const files = branchFiles.get(branch);
    return files ? shaOf(Object.fromEntries(files)) : null;
  };
  const mergeableProvider = (key, baseRef, headSha) => {
    if (key !== repoKey || !headSha) return { mergeable: null, mergeable_state: 'unknown' };
    return shas.has(headSha) ? { mergeable: true, mergeable_state: 'clean' } : { mergeable: null, mergeable_state: 'unknown' };
  };
  const mergeHandler = ({ prNumber }) => {
    const r = store.repoGet(repoKey);
    const branch = r?.prs.get(prNumber)?.headRef;
    for (const [p, t] of Object.entries(branchFiles.get(branch) ?? {})) main.set(p, String(t));
    return { commit_sha: refreshMainSha() };
  };

  mockServer.resetMock({ baseISO, branchProvider, mergeHandler, mergeableProvider });

  main.clear(); branchFiles.clear(); shas.clear();
  for (const [p, t] of Object.entries(mainFiles)) main.set(p, String(t));
  refreshMainSha();

  const config = JSON.parse(store.contentsGet('framework', 'docs/governance/config.json'));
  mockServer.seedLabels(repoKey, config.labels ?? []);
  store.repoEnsure(repoKey).protection = {
    required_status_checks: { strict: true, contexts: mockServer.REQUIRED_CHECKS },
    required_pull_request_reviews: { dismiss_stale_reviews: true, required_approving_review_count: 1 },
    enforce_admins: true,
  };

  const issuePathOf = (repo, number) => `/repos/${repo}/issues/${number}`;
  const prPathOf = (repo, number) => `/repos/${repo}/pulls/${number}`;
  const parseIssue = (id) => { const m = ISSUE_ID_RE.exec(String(id)); if (!m) throw new Error(`forgeless: bad issue id ${id}`); return { repo: m[1], number: Number(m[2]) }; };
  const parsePr = (id) => { const m = PR_ID_RE.exec(String(id)); if (!m) throw new Error(`forgeless: bad pr id ${id}`); return { repo: m[1], number: Number(m[2]) }; };
  const notePathOf = (noteId) => {
    const m = NOTE_ID_RE.exec(String(noteId));
    if (!m) throw new Error(`forgeless: bad note id ${noteId}`);
    return m[2] === '!' ? `/repos/${m[1]}/pulls/comments/${m[4]}` : `/repos/${m[1]}/issues/comments/${m[4]}`;
  };

  const forge = {};
  forge.readConfig = () => config;
  forge.scanIssues = (repo, { labels = [], state = 'open' } = {}) =>
    mockServer.apiGet(`/repos/${repo}/issues`, { state, labels: labels.join(',') }).map((raw) => store.toIssue(raw, repo));
  forge.scanNeedsInfo = (repo) => forge.scanIssues(repo, { labels: ['needs-info'] }).filter(
    (i) => ['cohort:fast', 'cohort:typical', 'cohort:slow'].some((c) => i.labels.includes(c)) && !i.labels.includes('peer:answer'));
  forge.issue = (id) => { const p = parseIssue(id); return store.toIssue(mockServer.apiGet(issuePathOf(p.repo, p.number)), p.repo); };
  forge.prsForIssue = (repo, number, { state = 'open' } = {}) =>
    mockServer.apiGet(`/repos/${repo}/pulls`, { state })
      .filter((p) => new RegExp(`^llm/issue-${number}-`).test(p.head?.ref ?? ''))
      .map((p) => store.toChangeRequest(p, repo));
  forge.notes = (id) => {
    const p = parseIssue(id);
    const m = NOTE_ID_RE.test(String(id));
    const raw = m ? mockServer.apiGet(notePathOf(String(id))) : mockServer.apiGet(`/repos/${p.repo}/issues/${p.number}/comments`);
    return (raw ?? []).map((n) => store.toNote(n, p.repo));
  };

  forge.branchSha = (prId) => {
    const p = parsePr(prId);
    const pr = mockServer.apiGet(prPathOf(p.repo, p.number));
    try {
      const head = mockServer.apiGet(`/repos/${p.repo}/git/refs/heads/${pr.head?.ref}`);
      if (head?.object?.sha) return head.object.sha;
    } catch { /* ref 未登録は head 記録へフォールバック */ }
    return pr.head?.sha ?? null;
  };
  forge.checks = (prId) => {
    const p = parsePr(prId);
    const sha = forge.branchSha(prId);
    const raw = mockServer.apiGet(`/repos/${p.repo}/commits/${sha}/check-runs`);
    return (raw?.check_runs ?? []).map((cc) => store.toCheck(cc));
  };
  forge.approvals = (prId) => {
    const p = parsePr(prId);
    return mockServer.apiGet(`/repos/${p.repo}/pulls/${p.number}/reviews`)
      .filter((rv) => String(rv.state).toUpperCase() === 'APPROVED').map((rv) => store.toApproval(rv));
  };
  forge.threads = (prId) => {
    const p = parsePr(prId);
    return mockServer.apiGet(`/repos/${p.repo}/pulls/${p.number}/comments`).map((t) => store.toThread(t));
  };
  forge.protection = (repo) => {
    try { return store.toProtection(mockServer.apiGet(`/repos/${repo ?? repoKey}/branches/main/protection`)); }
    catch { return store.toProtection(null); }
  };
  forge.repoLabels = (repo) => mockServer.apiGet(`/repos/${repo ?? repoKey}/labels`).map((l) => (typeof l === 'string' ? l : l.name));
  forge.commentCreatedAt = (noteId) => mockServer.apiGet(notePathOf(String(noteId)))?.created_at ?? null;
  forge.prJson = (prId) => { const p = parsePr(prId); return mockServer.apiGet(prPathOf(p.repo, p.number)); };

  forge.draftIssue = ({ repo = repoKey, title, body = '', labels = [], author } = {}) =>
    store.toIssue(mockServer.apiSend('POST', `/repos/${repo}/issues`, author ? { user: author } : undefined, { title, body, labels }), repo);
  forge.createPR = ({ repo = repoKey, head, base = 'main', title, body = '', draft = false, author, labels = [] } = {}) => {
    if (head === base) throw new Error('forgeless: direct push to base is banned (spec §2 不変条件 2)');
    if (!/^llm\/issue-(\d+)-.+/.test(head)) throw new Error(`forgeless: head branch ${head} must match llm/issue-<N>-<slug> (spec §7)`);
    return store.toChangeRequest(mockServer.apiSend('POST', `/repos/${repo}/pulls`, author ? { user: author } : undefined, { title, head, base, body, draft, labels }), repo);
  };
  forge.readyPR = (prId) => { const p = parsePr(prId); return store.toChangeRequest(mockServer.apiSend('PATCH', prPathOf(p.repo, p.number), {}, { draft: false }), p.repo); };
  forge.markPRReady = forge.readyPR;
  forge.editPR = (prId, patch) => { const p = parsePr(prId); return store.toChangeRequest(mockServer.apiSend('PATCH', prPathOf(p.repo, p.number), {}, patch), p.repo); };
  forge.requestReview = () => null; // mock に requested_reviewers route は無し (loop の typeof ガード経由で無害)
  forge.mergePR = (prId, method) => {
    const p = parsePr(prId);
    const res = mockServer.apiSend('PUT', `${prPathOf(p.repo, p.number)}/merge`, {}, { commit_method: method ?? config.mergeMethod ?? 'squash' });
    if (!res || res.result !== 'success') throw new Error(`forgeless: mergePR ${p.repo}!${p.number} failed`);
    return { merged: true, mergeSha: res.merge?.sha ?? null };
  };
  forge.closeIssue = (id) => { const p = parseIssue(id); mockServer.apiSend('PATCH', issuePathOf(p.repo, p.number), {}, { state: 'closed' }); return true; };
  forge.closePR = (prId) => { const p = parsePr(prId); mockServer.apiSend('PATCH', prPathOf(p.repo, p.number), {}, { state: 'close' }); return true; };
  forge.reopenIssue = (id) => { const p = parseIssue(id); mockServer.apiSend('PATCH', issuePathOf(p.repo, p.number), {}, { state: 'open' }); return true; };
  forge.postComment = (issueId, body, { author } = {}) => {
    const p = parseIssue(issueId);
    const note = store.toNote(mockServer.apiSend('POST', `${issuePathOf(p.repo, p.number)}/comments`, author ? { user: author } : undefined, { body }), p.repo);
    return { noteId: note.id, createdAt: note.createdAt };
  };

  forge.setLabel = (issueId, label) => {
    const p = parseIssue(issueId);
    const cur = mockServer.apiGet(issuePathOf(p.repo, p.number)).labels ?? [];
    const cls = labelClass(label);
    // src/forge.mjs の setLabel と同一順序 (旧クラス label を DELETE してから POST — 共存窓を作らない)。
    if (cls) {
      for (const o of cur.map((l) => (typeof l === 'string' ? l : l.name))) {
        if (o !== label && labelClass(o) === cls) mockServer.apiSend('DELETE', `${issuePathOf(p.repo, p.number)}/labels/${encodeURIComponent(o)}`, {}, undefined);
      }
    }
    mockServer.apiSend('POST', `${issuePathOf(p.repo, p.number)}/labels`, {}, { labels: [label] });
    return true;
  };
  forge.removeLabel = (issueId, label) => {
    const p = parseIssue(issueId);
    mockServer.apiSend('DELETE', `${issuePathOf(p.repo, p.number)}/labels/${encodeURIComponent(label)}`, {}, undefined);
    return true;
  };
  forge.approvePR = (prId, reviewer, sha) => {
    const p = parsePr(prId);
    return mockServer.apiSend('POST', `/repos/${p.repo}/pulls/${p.number}/reviews`, { user: reviewer }, { state: 'APPROVED', commit_id: sha });
  };
  forge.addReviewThread = (prId, body, { resolved = false, author } = {}) => {
    const p = parsePr(prId);
    return mockServer.apiSend('POST', `/repos/${p.repo}/pulls/${p.number}/comments`, author ? { user: author } : undefined, { body, resolved });
  };
  forge.resolveThread = (prId, threadId, resolved = true) => {
    const p = parsePr(prId);
    return mockServer.apiSend('PATCH', `/repos/${p.repo}/pulls/comments/${threadId}`, {}, { resolved });
  };
  forge.postCheck = (prId, check, issuer) => {
    const p = parsePr(prId);
    const head = forge.branchSha(prId);
    const conclusion = check.state === 'pending' ? null : check.state === 'success' ? 'success' : 'failure';
    return mockServer.apiSend('POST', `/repos/${p.repo}/commits/${head}/check-runs`, {}, {
      name: check.name, status: check.state === 'pending' ? 'queued' : 'completed', conclusion, head_sha: head,
      app: { owner: { login: issuer ?? config.botActor } },
    });
  };

  /** assembleChildren 用のテキスト源 — perform の forge.mjs と同様 PR body を返す (loop の prDiff 未実装フォールバックと同じ §5 機械抽出入力)。 */
  forge.prDiff = (prId) => String(mockServer.apiGet(prPathOf(parsePr(prId).repo, parsePr(prId).number)).body ?? '');

  /** executor.writeAndPush の forgeless 版 — branch の file map を更新し、mock の push route (git refs POST) を叩く。
   *  push route は protection.dismiss_stale_reviews を実装している (§8 stale 承認の GitHub 意味)。 */
  function submitPatch(branch, files) {
    const cur = branchFiles.get(branch) ?? new Map();
    for (const [p, t] of Object.entries(files)) cur.set(p, String(t));
    branchFiles.set(branch, cur);
    const sha = shaOf(Object.fromEntries(cur));
    shas.add(sha);
    mockServer.apiSend('POST', `/repos/${repoKey}/git/refs/heads/${branch}`, {}, { sha });
    return sha;
  }

  /** executor.runChecksOnPR の forgeless 版 — base+branch を workDir に再構築し runChecks を canonical issuer で post する。 */
  async function runChecksOnPR(prId, extraMeta = {}) {
    if (!runner) throw new Error('forgeless: runner 注入が必須 (contract §10)');
    const raw = forge.prJson(prId);
    const head = forge.branchSha(prId);
    if (!head) throw new Error(`forgeless: no head for ${prId} — submitPatch first`);
    const m = /^llm\/issue-(\d+)(?:-|$)/.exec(raw.head?.ref ?? '');
    const issueId = m ? `${repoKey}#${m[1]}` : null;
    const issueRec = issueId ? forge.issue(issueId) : null;
    const acceptBlock = extraMeta.acceptBlock !== undefined ? parseAcceptBlock(extraMeta.acceptBlock) : parseAcceptBlock(issueRec?.body);
    const files = { ...Object.fromEntries(main), ...Object.fromEntries(branchFiles.get(raw.head?.ref) ?? new Map()) };
    const workDir = mkdtempSync(path.join(tmpdir(), 'fp-forgeless-'));
    try {
      for (const [fp, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(workDir, fp)), { recursive: true });
        writeFileSync(path.join(workDir, fp), text);
      }
      const meta = {
        prHeadSha: head,
        issueBody: issueRec?.body ?? '',
        prBody: raw.body ?? '',
        prLabels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
        issueLabels: issueRec?.labels ?? [],
        frameworkConfig: config,
        projectState: { labels: forge.repoLabels(repoKey), protection: forge.protection(repoKey), workflowNames: config.workflowNames ?? (config.workflowName ? [config.workflowName] : []) },
        approvals: forge.approvals(prId),
        threads: forge.threads(prId),
        changedPaths: [...(branchFiles.get(raw.head?.ref) ?? new Map()).keys()],
        peerQueryBodies: issueId ? forge.notes(issueId).map((n) => n.body) : [],
      };
      const checkNames = [...new Set([...mockServer.REQUIRED_CHECKS, config.acceptJobName ?? 'accept'])];
      const result = await runner({ checks: checkNames, workDir, acceptBlock, meta: { ...meta, ...extraMeta } });
      return (result ?? []).map((c) => store.toCheck(forge.postCheck(prId, c, config.botActor ?? mockServer.BOT)));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** metrics.computeReport 用の store view (perform driver の forgeStoreView と同じ形 — forge normalizer の代わりに store.toX を使う)。 */
  function reportView() {
    const issues = mockServer.apiGet(`/repos/${repoKey}/issues`, { state: 'all' }).map((raw) => store.toIssue(raw, repoKey));
    const prs = mockServer.apiGet(`/repos/${repoKey}/pulls`, { state: 'all' }).map((raw) => store.toChangeRequest(raw, repoKey));
    const notes = []; const checks = []; const approvals = [];
    for (const it of issues) notes.push(...forge.notes(it.id));
    for (const p of prs) { checks.push(...forge.checks(p.id)); approvals.push(...forge.approvals(p.id)); }
    return { issues, prs, notes, checks, approvals };
  }
  const metrics = () => computeReport(reportView(), { config });

  const human = {
    reviewer: (config.humanAccounts ?? ['pond-tail-nuka'])[0],
    /** 期待する人間挙動: head SHA 同期の承認 (§8 sha-approval — stale 承認は check 側で red になる)。 */
    approveAtHead(prId, reviewer) { const sha = forge.branchSha(prId); forge.approvePR(prId, reviewer ?? human.reviewer, sha); return sha; },
    approveAt(prId, sha, reviewer) { return forge.approvePR(prId, reviewer ?? human.reviewer, sha); },
    addClause(issueId, body, reviewer) { return forge.postComment(issueId, body, { author: reviewer ?? human.reviewer }); },
    resolveThread(prId, threadId) { return forge.resolveThread(prId, threadId); },
    mergeAsJudgment(prId, method = 'squash') { const sha = forge.branchSha(prId); forge.approvePR(prId, human.reviewer, sha); return forge.mergePR(prId, method); },
    retriage(childIssueId) { forge.setLabel(childIssueId, 'backlog'); forge.closeIssue(childIssueId); },
    reopen(issueId, label = 'backlog') { forge.reopenIssue(issueId); forge.setLabel(issueId, label); },
  };

  const orchestrator = seat ? createOrchestrator({ forge, seat, config, clock: () => store.clock().peek() }) : null;
  async function claimAndLabel(issue, sessionId) {
    await orchestrator.claimIssue(issue.id, sessionId);
    await forge.setLabel(issue.id, 'claimed');
    await forge.removeLabel(issue.id, 'backlog');
  }

  return { forge, human, orchestrator, config, submitPatch, runChecksOnPR, reportView, metrics, claimAndLabel, mem: { main, branchFiles } };
}
