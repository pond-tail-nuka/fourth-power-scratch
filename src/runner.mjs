// src/runner.mjs — deterministic check executor (spec §4.1/§8; contract §10).
// The mock executor (tests/mock-forge/executor.mjs) and the CI workflow wrapper
// both call runChecks() — same code, same verdicts. No LLM, no network, no
// local state (spec §2.1/§2.5): all inputs (config, project state, approvals,
// labels, changed paths) are injected by the caller through provider API reads.
//
// runChecks({checks, workDir, acceptBlock, meta}) → Check[] (§1 type, issuer = botActor).
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_REQUIRED_CHECKS = [
  'accept', 'accept-immutable', 'accept-vacuity', 'risk-tier', 'review-threads',
  'status-exclusivity', 'sha-approval', 'config-consistency', 'scope-guard',
];
// no-state is required only on the framework repo PR (spec §2.5/§8); peer-query-reingestion
// is the self-scan check (contract §10). Default run list = spec §8 list + these.
export const ACCEPT_CHECK_NAMES = [...DEFAULT_REQUIRED_CHECKS, 'no-state', 'peer-query-reingestion'];
export const DEFAULT_HIGH_PATHS = [
  'src/', 'scripts/', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'ci/accept/', 'docs/spec.md', 'docs/PROPOSAL.md', 'docs/governance/',
  'prompts/', 'templates/', 'tests/', '.github/workflows/', '.gitlab-ci.yml',
];
export const STATE_LABELS = new Set([
  'backlog', 'claimed', 'in_review', 'rebase_required', 'done',
]);
const DEFAULT_EXEMPT = ['exempt:accept-author'];
const DEFAULT_BOT = 'fourth-power-bot';
const DEFAULT_ACCEPT_TIMEOUT_MS = 120000;
const ACCEPT_TEST_DIR = 'ci/accept/';

const FS_IMPORT_SOURCES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);
// Persistent-state write patterns (spec §2.5: DB, fs state, local lock).
// Cleanup/disposable-workspace APIs (rm/rmdir/unlink/cp/mkdtemp) are NOT flagged —
// the work clone is throwaway by §2.1 ("作業用クローン/ブランチは破棄しても MAY").
const WRITE_METHODS = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'mkdir', 'mkdirSync', 'truncate', 'truncateSync',
  'rename', 'renameSync', 'createWriteStream',
]);
const DB_SOURCE_RE = /^(?:node:sqlite|better-sqlite3|sqlite3|sqlite|sql\.js|node:sqlite\/session)$/;
const LOCK_SOURCE_RE = /lockfile|async-lock/i;
export const IS_ASSERT_SOURCE = (s) => /^node:assert(?:\/|$)/.test(String(s));
export const IS_FS_SOURCE = (s) => FS_IMPORT_SOURCES.has(String(s));
const SCAN_EXTENSIONS = /\.(?:mjs|cjs|js)$/;

// ---------------------------------------------------------------- tokens

// Token-level scanner (no external deps; node stdlib has no JS parser). The
// scanners below consume this token stream; a full structural parse of the
// constructs they need (imports, call expressions, function bodies) is done
// over balanced bracket groups.
export function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  let prev = null;
  const push = (type, value) => {
    const tok = { type, value };
    tokens.push(tok);
    prev = tok;
  };
  const prevAllowsRegex = () => {
    if (!prev) return true;
    if (prev.type === 'num' || prev.type === 'str' || prev.type === 'template' || prev.type === 'regex') return false;
    if (prev.type === 'id') return /^(?:return|typeof|instanceof|in|new|of|void|delete|case|yield|await|do|else|const|let|var)$/.test(prev.value);
    return true; // punctuation
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') throw new SyntaxError('unterminated string');
        j++;
      }
      push('str', src.slice(i + 1, j - 1)); // content without quotes
      i = j;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { j++; break; }
        j++;
      }
      push('template', src.slice(i + 1, j - 1));
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (c === '0' && /[xX]/.test(src[i + 1] || '')) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9.]/.test(src[j])) j++;
        if (j < n && /[eE]/.test(src[j])) {
          j++;
          if (j < n && /[+-]/.test(src[j])) j++;
          while (j < n && /[0-9]/.test(src[j])) j++;
        }
      }
      push('num', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && prevAllowsRegex()) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; ok = true; break; }
        else if (d === '\n') break;
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/.test(src[j])) j++;
        push('regex', src.slice(i, j));
        i = j;
        continue;
      }
    }
    // punctuation: longest match among listed operators, else single char
    let matched = false;
    for (const op of ['=>', '...', '**', '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '++', '--']) {
      if (src.startsWith(op, i)) { push('punct', op); i += op.length; matched = true; break; }
    }
    if (!matched) { push('punct', c); i++; }
  }
  return tokens;
}

// ---------------------------------------------------------------- helpers

const OPEN = { '(': ')', '[': ']', '{': '}' };

// index of the closer matching the opener at tokens[openIdx]
export function matchClose(tokens, openIdx) {
  const stack = [];
  for (let k = openIdx; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'punct') continue;
    if (OPEN[t.value]) { stack.push(OPEN[t.value]); continue; }
    if (stack.length && t.value === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return k;
    }
  }
  return -1;
}

// top-level split of an argument token slice (tokens strictly inside the parens)
export function splitArgs(argTokens) {
  const out = [];
  let depth = 0;
  let cur = [];
  for (const t of argTokens) {
    if (t.type === 'punct') {
      if (OPEN[t.value]) { depth++; cur.push(t); continue; }
      if (t.value === ')' || t.value === ']' || t.value === '}') { depth--; cur.push(t); continue; }
      if (t.value === ',' && depth === 0) { out.push(cur); cur = []; continue; }
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

const CONSTANT_ID = new Set(['true', 'false', 'null', 'undefined', 'NaN']);

// a constant argument references no observable: literal, or !literal
function isConstantArg(arg) {
  let k = 0;
  if (arg.length === 2 && arg[0].type === 'punct' && arg[0].value === '!') k = 1;
  if (arg.length !== k + 1) return false;
  const t = arg[k];
  return t.type === 'num' || t.type === 'str' || t.type === 'template' || t.type === 'regex' ||
    (t.type === 'id' && CONSTANT_ID.has(t.value));
}

// collect module sources: import ... from 'src'; import 'src'; require('src')
export function importSources(tokens) {
  const sources = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'id') continue;
    if (t.value === 'import' && (k === 0 || tokens[k - 1].value !== '.')) {
      let j = k + 1;
      if (tokens[j]?.type === 'str') { sources.push(tokens[j].value); continue; }
      while (j < tokens.length && tokens[j].value !== 'from') {
        if (tokens[j].type === 'punct' && (tokens[j].value === ';' || tokens[j].value === '(')) break;
        j++;
      }
      if (tokens[j]?.value === 'from' && tokens[j + 1]?.type === 'str') sources.push(tokens[j + 1].value);
    } else if (t.value === 'require' && tokens[k + 1]?.value === '(' && tokens[k + 2]?.type === 'str') {
      sources.push(tokens[k + 2].value);
    }
  }
  return sources;
}

// names bound by an import/require of a module matching pred(src):
// default import, namespace binding, named bindings (with `as` renames)
export function importBindings(tokens, pred) {
  const names = new Set();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'id' || (t.value !== 'import' && t.value !== 'require')) continue;
    let src = null;
    let clauseStart = k + 1;
    if (t.value === 'require' && tokens[k + 1]?.value === '(' && tokens[k + 2]?.type === 'str') {
      src = tokens[k + 2].value;
    } else if (t.value === 'import') {
      if (tokens[k + 1]?.type === 'str') continue; // side-effect import
      let j = k + 1;
      while (j < tokens.length && tokens[j].value !== 'from') j++;
      if (tokens[j]?.value === 'from' && tokens[j + 1]?.type === 'str') src = tokens[j + 1].value;
    }
    if (src === null || !pred(src)) continue;
    let j = clauseStart;
    while (j < tokens.length && tokens[j].value !== 'from' && tokens[j].type !== 'str') j++;
    const clause = tokens.slice(clauseStart, j);
    for (let m = 0; m < clause.length; m++) {
      const c = clause[m];
      if (c.type !== 'id' || c.value === 'as' || c.value === 'from' || c.value === 'default') continue;
      if (clause[m + 1]?.value === 'as' && clause[m + 2]?.type === 'id') { names.add(clause[m + 2].value); continue; }
      if (clause[m - 1]?.value === 'as') continue;
      if (c.value === 'from' || c.value === 'as') continue;
      names.add(c.value);
    }
  }
  return names;
}

const TEST_ALIASES = new Set(['test', 'it', 'describe']);

// call-site detection: id==name not preceded by '.', optionally followed by
// member chains (assert .ok .strictEqual ...), then '('
export function callSites(tokens, name) {
  const sites = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'id' || t.value !== name) continue;
    const prevTok = tokens[k - 1];
    if (prevTok && prevTok.type === 'punct' && prevTok.value === '.') continue;
    let j = k + 1;
    while (tokens[j]?.type === 'punct' && tokens[j].value === '.' && tokens[j + 1]?.type === 'id') j += 2;
    if (tokens[j]?.type === 'punct' && tokens[j].value === '(') sites.push({ nameIdx: k, openIdx: j });
  }
  return sites;
}

function argTokensBetween(tokens, openIdx) {
  const close = matchClose(tokens, openIdx);
  if (close === -1) return null;
  return tokens.slice(openIdx + 1, close);
}

// callback arg body emptiness: true = empty body (`it('x', () => {})`,
// `it('x', function () {})`), false = non-empty, null = not a callback.
export function callbackBodyEmpty(argTokens) {
  let k = 0;
  if (!argTokens.length) return null;
  if (argTokens[k]?.type === 'id' && argTokens[k].value === 'async') k++;
  if (argTokens[k]?.type === 'id' && argTokens[k].value === 'function') {
    k++;
    if (argTokens[k]?.type === 'id') k++;
    if (argTokens[k]?.value !== '(') return null;
    const close = matchClose(argTokens, k);
    if (close === -1) return null;
    k = close + 1;
    if (argTokens[k]?.value !== '{') return null;
    const bodyClose = matchClose(argTokens, k);
    if (bodyClose === -1) return null;
    return argTokens.slice(k + 1, bodyClose).length === 0;
  }
  if (argTokens[k]?.value === '(') {
    const close = matchClose(argTokens, k);
    if (close === -1) return null;
    k = close + 1;
    if (argTokens[k]?.type === 'id' && argTokens[k].value === 'async') k++;
    if (argTokens[k]?.value !== '=>') return null;
    k++;
    if (argTokens[k]?.value === '{') {
      const bodyClose = matchClose(argTokens, k);
      if (bodyClose === -1) return null;
      return argTokens.slice(k + 1, bodyClose).length === 0;
    }
    return argTokens.length > k ? false : null; // expression body counts as non-empty
  }
  return null; // named function reference / non-function arg
}

// ---------------------------------------------------------------- accept-vacuity (spec §4.5)

// Scan one accept test file. Returns an array of vacuity issues (empty = real test).
// Rules: needs an assert-family import, minimum 1 assertion entity, minimum 1
// non-empty test/it block; constant-only assertions (args referencing no
// observable) are vacuous.
export function scanAcceptFile(src) {
  const issues = [];
  let tokens;
  try {
    tokens = tokenize(src);
  } catch {
    return ['file is not parseable'];
  }
  const assertNames = importBindings(tokens, IS_ASSERT_SOURCE);
  const testNames = importBindings(tokens, (s) => /^node:test(?:\/|$)/.test(String(s)));
  const allTestNames = new Set([...TEST_ALIASES, ...testNames]);

  const entityConstant = [];
  // assert-family call expressions (imported bindings + bare `assert` global usage)
  const callNames = new Set([...assertNames, 'assert']);
  for (const name of callNames) {
    for (const site of callSites(tokens, name)) {
      const argToks = argTokensBetween(tokens, site.openIdx);
      if (argToks === null) continue;
      const args = splitArgs(argToks);
      entityConstant.push(args.length > 0 && args.every(isConstantArg));
    }
  }
  // expect(x).<matcher>(y) chains — subject args + matcher args decide constantness
  for (const site of callSites(tokens, 'expect')) {
    const close = matchClose(tokens, site.openIdx);
    if (close === -1) continue;
    let j = close + 1;
    while (tokens[j]?.value === '.' && tokens[j + 1]?.type === 'id') {
      j += 2;
      if (tokens[j]?.value === '(') {
        const argToks = argTokensBetween(tokens, j);
        if (argToks === null) break;
        const subject = splitArgs(tokens.slice(site.openIdx + 1, close));
        const matcher = splitArgs(argToks);
        entityConstant.push([...subject, ...matcher].every((a) => isConstantArg(a)) && (subject.length + matcher.length) > 0);
        break;
      }
    }
  }

  // empty test/it callbacks
  for (const name of allTestNames) {
    for (const site of callSites(tokens, name)) {
      const argToks = argTokensBetween(tokens, site.openIdx);
      if (argToks === null) continue;
      for (const arg of splitArgs(argToks)) {
        if (callbackBodyEmpty(arg) === true) issues.push(`empty ${name}() callback`);
      }
    }
  }

  // spec §4.5: the assert entity is a node assert import OR node:test-bound assert usage
  const bareAssertUsed = callSites(tokens, 'assert').length > 0;
  if (assertNames.size === 0 && !(testNames.size > 0 && bareAssertUsed)) {
    issues.push('missing assert import (node:assert or node:test)');
  }
  if (entityConstant.length === 0) {
    issues.push('no assertion entity');
  } else if (entityConstant.every((c) => c)) {
    issues.push('constant-only assertions reference no observable');
  }
  return issues;
}

// ---------------------------------------------------------------- no-state (spec §2.5)

// Persistent-write / DB / lock / bootstrap patterns in one src file.
// Returns violation strings. forge.mjs's child_process gh calls are NOT
// persistence patterns and are intentionally not flagged (spec §11 github provider).
export function scanNoStateViolations(src) {
  const violations = [];
  let tokens;
  try {
    tokens = tokenize(src);
  } catch {
    return ['file is not parseable (src must be valid JS)'];
  }
  let fsUsed = false;
  for (const s of importSources(tokens)) {
    if (IS_FS_SOURCE(s)) fsUsed = true;
    else if (DB_SOURCE_RE.test(s)) violations.push(`DB import from '${s}' (src must not keep local DB state)`);
    else if (LOCK_SOURCE_RE.test(s)) violations.push(`local lock import from '${s}' (src must not keep local locks)`);
    if (/scripts\/bootstrap\b/.test(s)) violations.push(`bootstrap import from src is MUST NOT (spec §2.5): '${s}'`);
  }
  if (fsUsed) {
    const methodRe = new Set(WRITE_METHODS);
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type !== 'id') continue;
      if (methodRe.has(t.value)) {
        const prev = tokens[k - 1];
        const isMember = prev && prev.type === 'punct' && prev.value === '.';
        if (isMember || callSitesAt(tokens, k)) violations.push(`fs write method '${t.value}' used in src`);
      } else if ((t.value === 'open' || t.value === 'openSync') && callSitesAt(tokens, k)) {
        const site = { openIdx: k + 1 };
        const argToks = argTokensBetween(tokens, site.openIdx);
        if (argToks) {
          for (const a of splitArgs(argToks)) {
            if (a.length === 1 && a[0].type === 'str' && /^[wa][+tb]*$/.test(a[0].value)) {
              violations.push('fs.open with write-mode flag in src');
              break;
            }
          }
        }
      }
    }
  }
  return violations;
}

function callSitesAt(tokens, idIdx) {
  let j = idIdx + 1;
  while (tokens[j]?.type === 'punct' && tokens[j].value === '.' && tokens[j + 1]?.type === 'id') j += 2;
  return tokens[j]?.type === 'punct' && tokens[j].value === '(';
}

// ---------------------------------------------------------------- path matching

// Provider-path pattern match (config tiers.highPaths / scope declarations):
// exact path, `dir/` prefix, or glob (`*` one segment, `**` any segment run).
export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++; // consume second '*'
        continue;
      }
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

export function matchPath(pattern, path) {
  const p = pattern.replace(/^\.\//, '');
  const target = path.replace(/^\.\//, '');
  if (p === target) return true;
  if (p.endsWith('/')) return target.startsWith(p);
  if (p.includes('*') || p.includes('?')) return globToRegExp(p).test(target);
  // a bare dir name matches anything under it
  return target.startsWith(p + '/');
}

// ---------------------------------------------------------------- acceptBlock

export function parseAcceptBlock(acceptBlock) {
  if (!acceptBlock) return { entries: [], scope: null, parseError: 'acceptBlock missing' };
  let obj = acceptBlock;
  if (typeof acceptBlock === 'string') {
    const fence = acceptBlock.match(/```acceptBlock\n([\s\S]*?)```/);
    try { obj = JSON.parse(fence ? fence[1] : acceptBlock); }
    catch { return { entries: [], scope: null, parseError: 'acceptBlock is not valid JSON' }; }
  }
  if (!obj || typeof obj !== 'object') return { entries: [], scope: null, parseError: 'acceptBlock is not an object' };
  const entries = Array.isArray(obj.accept) ? obj.accept : [];
  return { entries, scope: Array.isArray(obj.scope) ? obj.scope : null, parseError: null };
}

// the test file path inside a cmd (`node --test <path>`); null if none
function testPathFromCmd(cmd) {
  for (const tok of String(cmd).split(/\s+/)) {
    if (SCAN_EXTENSIONS.test(tok) && !tok.startsWith('-')) return tok.replace(/^\.\//, '');
  }
  return null;
}

function acceptTestCandidates(entry, meta) {
  const list = [];
  const injected = meta.acceptTestPaths?.[entry.id];
  if (injected) list.push(...(Array.isArray(injected) ? injected : [injected]));
  if (entry.file) list.push(entry.file);
  const cmdPath = entry.cmd ? testPathFromCmd(entry.cmd) : null;
  if (cmdPath) list.push(cmdPath);
  if (entry.id) list.push(`${ACCEPT_TEST_DIR}${entry.id}.test.mjs`);
  return list;
}

// accept job (spec §4.3): all test entries run to green, else failure
function runAcceptJobs(entries, workDir, meta) {
  const testEntries = entries.filter((e) => e && e.kind !== 'review');
  if (testEntries.length === 0) return { ok: false, reason: 'accept contract has no test entries (spec §4.2)' };
  const timeoutMs = meta.timeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS;
  // When runChecks itself is invoked from inside a node --test parent, the child
  // node --test would inherit NODE_TEST_CONTEXT and silently skip files (status 0).
  // Strip it so accept verdicts reflect the real test run in every context.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const e of testEntries) {
    if (!e.cmd) return { ok: false, reason: `accept entry ${e.id} has no cmd` };
    const res = spawnSync(e.cmd, { cwd: workDir, shell: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env });
    if (res.error) return { ok: false, reason: `accept entry ${e.id}: ${res.error.code ?? res.error.message}` };
    if (res.signal) return { ok: false, reason: `accept entry ${e.id} killed by ${res.signal}` };
    if (res.status !== 0) return { ok: false, reason: `accept entry ${e.id} exit ${res.status}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- config-consistency (spec §2.6)

export function configConsistencyIssues(frameworkConfig, projectState) {
  const problems = [];
  if (!frameworkConfig) {
    problems.push('framework config not injected (caller must read it via provider API, spec §2.6)');
    return problems;
  }
  const ps = projectState ?? {};
  if (Array.isArray(frameworkConfig.labels)) {
    const have = new Set(ps.labels ?? []);
    for (const l of frameworkConfig.labels) {
      if (!have.has(l)) problems.push(`project label '${l}' not materialized`);
    }
  }
  const expectedChecks = frameworkConfig.requiredChecks ?? DEFAULT_REQUIRED_CHECKS;
  const prot = ps.protection ?? {};
  if (Array.isArray(prot.requiredChecks)) {
    const a = [...prot.requiredChecks].sort();
    const b = [...expectedChecks].sort();
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) problems.push('protection requiredChecks != framework required list');
  } else {
    problems.push('project protection requiredChecks not injected');
  }
  if ('requiredApprovals' in frameworkConfig && prot.requiredApprovals !== frameworkConfig.requiredApprovals) {
    problems.push('protection requiredApprovals mismatch with framework config');
  }
  if ((frameworkConfig.dismissStaleReviews ?? true) && prot.dismissStaleReviews !== true) {
    problems.push('dismissStaleReviews not enabled (spec §4.4)');
  }
  if ((frameworkConfig.enforceAdmins ?? true) && prot.enforceAdmins !== true) {
    problems.push('enforceAdmins not true (spec §4.4)');
  }
  if (frameworkConfig.workflowName) {
    const names = ps.workflowNames ?? null;
    if (names === null) problems.push('project workflow list not injected');
    else if (!names.includes(frameworkConfig.workflowName)) problems.push(`workflow '${frameworkConfig.workflowName}' missing`);
  }
  return problems;
}

// ---------------------------------------------------------------- fs walk (no-state)

function listSourceFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listSourceFiles(full, base, out);
    else if (e.isFile() && SCAN_EXTENSIONS.test(e.name)) out.push(full.slice(base.length + 1));
  }
  return out;
}

const normWs = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- runChecks (contract §10)

export function runChecks({ checks, workDir, acceptBlock, meta = {} } = {}) {
  const cfg = meta.frameworkConfig ?? null;
  const botActor = cfg?.botActor ?? DEFAULT_BOT;
  const headSha = meta.prHeadSha ?? null;
  const acceptJobName = cfg?.acceptJobName ?? 'accept';
  const names = Array.isArray(checks) && checks.length > 0 ? [...checks] : [...ACCEPT_CHECK_NAMES];
  const block = parseAcceptBlock(acceptBlock);
  const changed = Array.isArray(meta.changedPaths) ? meta.changedPaths : [];
  const labels = [...(meta.prLabels ?? []), ...(meta.issueLabels ?? [])];
  const approvals = Array.isArray(meta.approvals) ? meta.approvals : [];
  const threads = meta.threads ?? null;

  const check = (res) => ({ state: res.ok ? 'success' : 'failure', headSha, issuer: botActor });

  const evaluate = (name) => {
    if (name === acceptJobName) return runAcceptJobs(block.entries, workDir, meta);
    if (block.parseError) return { ok: false, reason: block.parseError };

    switch (name) {
      case 'accept-immutable': {
        const acceptFiles = block.entries
          .filter((e) => e && e.kind !== 'review')
          .flatMap((e) => acceptTestCandidates(e, meta));
        const exempt = (cfg?.exemptLabels ?? DEFAULT_EXEMPT).some((l) => labels.includes(l));
        const touched = changed.some((p) => p.startsWith(ACCEPT_TEST_DIR) || acceptFiles.some((f) => matchPath(f, p)));
        if (touched && !exempt) return { ok: false, reason: 'PR changes accept tests (spec §4.2); needs exempt:accept-author' };
        return { ok: true };
      }
      case 'accept-vacuity': {
        const testEntries = block.entries.filter((e) => e && e.kind !== 'review');
        if (testEntries.length === 0) {
          const exempt = (cfg?.exemptLabels ?? DEFAULT_EXEMPT).some((l) => labels.includes(l));
          if (exempt) return { ok: true, reason: 'plan/docs PR の accept 代替 — docs/governance 整合性 (§4.4、exempt ラベル)' };
          return { ok: false, reason: 'accept contract has no test entries (spec §4.2)' };
        }
        const problems = [];
        for (const e of testEntries) {
          const candidates = acceptTestCandidates(e, meta);
          const rel = candidates.find((c) => existsSync(join(workDir, c)));
          if (!rel) { problems.push(`${e.id}: accept test file missing (${candidates.join(', ')})`); continue; }
          let src;
          try { src = readFileSync(join(workDir, rel), 'utf8'); }
          catch { problems.push(`${e.id}: accept test file unreadable`); continue; }
          problems.push(...scanAcceptFile(src).map((i) => `${rel}: ${i}`));
        }
        if (problems.length) return { ok: false, reason: problems.join('; ') };
        return { ok: true };
      }
      case 'risk-tier': {
        if (!cfg) return { ok: false, reason: 'framework config not injected' };
        const highPaths = cfg.tiers?.highPaths ?? DEFAULT_HIGH_PATHS;
        const humans = cfg.humanAccounts ?? [];
        const isHigh = changed.some((p) => highPaths.some((pat) => matchPath(pat, p)));
        const exemptLow = labels.includes('cohort:typical') && !isHigh;
        if (exemptLow) return { ok: true };
        const human = approvals.some((a) => humans.includes(a.reviewer));
        if (!human) return { ok: false, reason: isHigh ? 'high tier change: needs a human (humanAccounts) approval' : 'needs at least one approval' };
        return { ok: true };
      }
      case 'review-threads': {
        if (!Array.isArray(threads)) return { ok: false, reason: 'review threads not injected' };
        const open = threads.filter((t) => t && t.resolved === false).length;
        return open > 0 ? { ok: false, reason: `${open} unresolved review thread(s)` } : { ok: true };
      }
      case 'status-exclusivity': {
        const issueLabels = meta.issueLabels ?? meta.labels ?? [];
        const stateLabels = issueLabels.filter((l) => STATE_LABELS.has(l) || l.startsWith('blocked/'));
        if (stateLabels.length > 1) return { ok: false, reason: `exclusive state labels coexist: ${stateLabels.join(', ')}` };
        return { ok: true };
      }
      case 'sha-approval': {
        if (approvals.length === 0) return { ok: true };
        const stale = approvals.filter((a) => a.sha !== headSha);
        return stale.length > 0 ? { ok: false, reason: `${stale.length} approval(s) not matching head SHA` } : { ok: true };
      }
      case 'config-consistency': {
        const problems = configConsistencyIssues(cfg, meta.projectState);
        return problems.length ? { ok: false, reason: problems.join('; ') } : { ok: true };
      }
      case 'scope-guard': {
        if (!block.scope) return { ok: false, reason: 'acceptBlock scope declaration missing (spec §5)' };
        const outside = changed.filter((p) => !block.scope.some((pat) => matchPath(pat, p)));
        return outside.length ? { ok: false, reason: `changed paths outside scope: ${outside.join(', ')}` } : { ok: true };
      }
      case 'no-state': {
        const srcDir = join(workDir, 'src');
        const problems = [];
        for (const rel of listSourceFiles(srcDir)) {
          let src;
          try { src = readFileSync(join(srcDir, rel), 'utf8'); } catch { continue; }
          problems.push(...scanNoStateViolations(src).map((v) => `src/${rel}: ${v}`));
        }
        return problems.length ? { ok: false, reason: problems.join('; ') } : { ok: true };
      }
      case 'peer-query-reingestion': {
        // self PR must not re-ingest agent-authored query bodies verbatim (§5:
        // peer-query reingestion is summary-only), nor copy the Issue body verbatim
        const prNorm = normWs(meta.prBody);
        if (!prNorm) return { ok: true };
        const hits = (meta.peerQueryBodies ?? []).filter((b) => {
          const bn = normWs(b);
          return bn.length >= 40 && prNorm.includes(bn);
        }).length;
        const issueNorm = normWs(meta.issueBody);
        const issueCopied = issueNorm.length >= 40 && prNorm.includes(issueNorm) ? 1 : 0;
        const total = hits + issueCopied;
        return total ? { ok: false, reason: `${total} agent-authored body(s) reingested verbatim into the self PR` } : { ok: true };
      }
      default:
        return { ok: false, reason: `unknown check name '${name}'` };
    }
  };

  return names.map((name) => ({ name, ...check(evaluate(name)) }));
}
