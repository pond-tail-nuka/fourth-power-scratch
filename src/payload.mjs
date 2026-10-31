// src/payload.mjs — turn payload 組立 (spec §5・§6・§7・§12 / contract §11)
// 純関数 (no-state: 永続化なし、forge 読みは呼び出し側が注入)。
// Issue 本文の ```acceptBlock fence JSON のみを parse する (contract §11)。
// 自由文からの条項 parse はしない (spec §5)。fence 欠損 Issue は対象外 (plan turn・claim 対象外)。
// payloadText は 参照条項 + acceptBlock 条項 + scope 宣言のみ (spec §5「参照条項のみ添付」、§6 上限対象)。
// contextBudget 超過時: acceptBlock を優先し、参照条項から決定論的に間引く (spec §6「組立前に MUST 間引く」)。
// claim・plan comment の record helper は §7・§12 の書式固定 (hidden key `<!-- fp:session <id> -->`)。

export const DEFAULT_CONTEXT_BUDGET = 16000;

const FENCE_RE = /```acceptBlock[ \t]*\r?\n([\s\S]*?)```/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new TypeError(`payload: session-id が不正です (§12 書式): ${JSON.stringify(sessionId)}`);
  }
}

function assertIsoTime(iso, key) {
  if (typeof iso !== 'string' || !ISO_RE.test(iso)) {
    throw new TypeError(`payload: ${key} が ISO 時刻ではありません (§7 created_at 突合): ${JSON.stringify(iso)}`);
  }
}

/** hidden key 書式 (spec §12): `<!-- fp:session <session-id> -->` */
export function sessionMarker(sessionId) {
  assertSessionId(sessionId);
  return `<!-- fp:session ${sessionId} -->`;
}

/**
 * claim comment 書式 (spec §7 固定):
 *   通常: `claimed <session-id> at <iso-time>` + hidden marker
 *   復元: `claimed <session-id> at <元 created_at> resumed <iso-time>` + hidden marker
 * `at <iso-time>` は API の created_at 正規値からのみ書く (偽造突合は gate 側、§3)。
 */
export function claimComment(sessionId, createdAtIso, resumedAtIso) {
  assertSessionId(sessionId);
  assertIsoTime(createdAtIso, 'created_at');
  const header =
    resumedAtIso === undefined || resumedAtIso === null
      ? `claimed ${sessionId} at ${createdAtIso}`
      : `claimed ${sessionId} at ${createdAtIso} resumed ${resumedAtIso}`;
  if (resumedAtIso !== undefined && resumedAtIso !== null) {
    assertIsoTime(resumedAtIso, 'resumed_at');
  }
  return `${header}\n${sessionMarker(sessionId)}`;
}

/**
 * plan turn comment 書式 (spec §5 固定): 可視 header `plan <session-id>` + hidden marker。
 * 台帳算入は §7 の author・session-id 突合側 (comment は record のみ)。
 */
export function planComment(sessionId) {
  assertSessionId(sessionId);
  return `plan ${sessionId}\n${sessionMarker(sessionId)}`;
}

/**
 * Issue 本文から ```acceptBlock fence JSON を 1 つ parse する (contract §11)。
 * fence が 1 つより多い場合は先頭のみ (規約は 1 つ置く MUST)。
 * 欠損・JSON 不正・期待 shape 外は null (対象外返し、spec §5)。
 * 本文の自由文は読まない — fence 内のみが条項の正。
 */
export function parseAcceptBlock(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(FENCE_RE);
  if (!m) return null;
  let block;
  try {
    block = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return null;
  const { accept, scope, refs } = block;
  if (!Array.isArray(accept) || !Array.isArray(scope) || !Array.isArray(refs)) return null;
  if (accept.some((a) => a === null || typeof a !== 'object' || Array.isArray(a)) ||
      accept.some((a) => !['id', 'kind', 'cmd'].every((k) => typeof a[k] === 'string' && a[k] !== ''))) {
    return null;
  }
  if (scope.some((s) => typeof s !== 'string' || s === '')) return null;
  if (refs.some((r) => typeof r !== 'string' || r === '')) return null;
  return {
    accept: accept.map((a) => ({ id: a.id, kind: a.kind, cmd: a.cmd })),
    scope: [...scope],
    refs: [...refs],
  };
}

function joinSection(name, lines) {
  return [name, ...lines].join('\n');
}

// 決定論的 section 結合 (spec §6「決定論的組立」、M2 回帰 (k) 用)。
// refs を上順に置き、accept・scope が常に残る。accept が refs より前には置かない。
function buildSections({ refsFull, refsIdOnly, accept, scope }) {
  const parts = [];
  if (refsFull) parts.push(refsFull);
  if (refsIdOnly) parts.push(refsIdOnly);
  parts.push(joinSection('accept', accept.map((a) => `- ${a.id} ${a.kind} ${a.cmd}`)));
  parts.push(joinSection('scope', scope.map((s) => `- ${s}`)));
  return parts.join('\n');
}

/**
 * turn payload 組立: assemblePayload(issue, config, specClauses) → payload | null (contract §11)。
 *   issue        — normalized Issue (§1)。body 内の ```acceptBlock fence のみ読む。
 *   config       — docs/governance/config.json (`contextBudget` 上限、§2.6・§6)。
 *   specClauses  — spec § ID → 条項テキストのマップ (例 "spec §4.3": "...")。
 * 戻り: 対象外 (fence 欠損) は null。対象は { payloadText, refs, accept, scope, trimmed, truncated }。
 * payloadText = 参照条項テキスト (refs の spec § ID のテキスト版を specClauses マップから引いて結合) +
 *               acceptBlock 条項 + scope 宣言のみ (spec §5「参照条項のみ添付 MUST」、§6 上限対象)。
 * contextBudget 超過の間引き順 (acceptBlock 優先):
 *   1. 参照条項の本文を落として ID 行のみにする
 *   2. 参照条項 section を丸ごと落とす
 *   3. accept・scope 決定論行を末尾から決定的 truncation (spec §6「truncation 結合」)
 */
export function assemblePayload(issue, config, specClauses = {}) {
  const block = parseAcceptBlock(issue === null || issue === undefined ? '' : issue?.body ?? '');
  if (!block) return null;
  const budgetRaw = config?.contextBudget;
  const budget = typeof budgetRaw === 'number' && Number.isFinite(budgetRaw)
    ? Math.floor(budgetRaw)
    : DEFAULT_CONTEXT_BUDGET;

  const refsFull = block.refs.length
    ? joinSection(
        'refs',
        block.refs.map((ref) => {
          const text = specClauses?.[ref];
          return typeof text === 'string' && text !== '' ? `- ${ref}: ${text}` : `- ${ref}`;
        }),
      )
    : null;
  const refsIdOnly = block.refs.length
    ? joinSection('refs', block.refs.map((ref) => `- ${ref}`))
    : null;

  const accept = block.accept;
  const scope = block.scope;

  let text = buildSections({ refsFull, refsIdOnly: null, accept, scope });
  let trimmed = false;
  let truncated = false;
  if (text.length > budget) {
    trimmed = true;
    text = buildSections({ refsFull: null, refsIdOnly, accept, scope });
  }
  if (text.length > budget) {
    trimmed = true;
    text = buildSections({ refsFull: null, refsIdOnly: null, accept, scope });
  }
  if (text.length > budget) {
    trimmed = true;
    truncated = true;
    text = text.slice(0, budget);
  }
  return { payloadText: text, refs: [...block.refs], accept: [...accept], scope: [...scope], trimmed, truncated };
}
