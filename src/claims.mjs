// Claim comment mechanics (spec §3・§7・§12): fixed format, created_at 突合,
// winner determination, scan window, resume header 書式. 純関数 (forge 非依存 —
// 注入された normalized notes を読む。gate.mjs と loop.mjs から呼ばれる).

/** 可視 header: `claimed <session-id> at <iso-time>` (任意に `resumed <iso-time>` を許容、§7 の復元書式). */
const CLAIM_HEADER_RE = /^claimed\s+(\S+)\s+at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)(\s+resumed\s+(\S+))?\s*(?:\n|$)/;
/** hidden marker `<!-- fp:session <id> -->` (§12 の固定書式). */
const SESSION_MARKER_RE = /<!--\s*fp:session\s+(\S+)\s*-->/;
const BRANCH_RE = /^llm\/issue-\d+-.+$/;

/**
 * ISO 時刻を決定論の比較キーへ正規化する (エポック ms、秒未満を含む).
 * @param {string} iso
 * @returns {number} NaN (不正時は呼び出し側が reject する).
 */
export function parseClaimTime(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : ms;
}

/** 秒精度へ切捨て (created_at 突合の一致判定は秒未満のクロスクロックで成立させるため). */
function floorSecond(iso) {
  const ms = parseClaimTime(iso);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 1000) * 1000;
}

/**
 * claim comment 候補を parse し created_at 突合まで行う (spec §3 §7 §10 M1 M2(o)).
 * 戻すのは claim 候補のみ (他 agent comment・人間 comment・peer query は対象外).
 *
 * reject 規則 (claim 成立 MUST NOT、§3):
 * - `at <iso>` が forge の created_at と不一致 (偽装修正、§3・M2(o))
 * - hidden `fp:session` と可視 header の session-id が不一致
 * - `claimed` の直後に空白が続く (書式違反; `claimedx` は別 comment として候補すら立たない)
 * - windowStart より前 (再 triage で scan 窓を「再 triage 以降の claim」に絞る、§3(d))
 * - branch 参照があるとき claim 参照 branch と PR head branch が不一致 (§7 の branch 規約)
 *
 * @param {Note[]} notes
 * @param {{windowStart?: string, headBranch?: string}} [opts] scan 窓と PR head branch.
 * @returns {Array<{note: Note, kind: 'claim', sessionId: string|null, atIso: string|null, created: number, valid: boolean, rejectReason: string|null, resumed: string|null>}>
 */
export function parseClaims(notes, opts = {}) {
  const out = [];
  // 復元 header (resumed 付き) の `at` は元 claim の created_at を保持する (§7)。
 // 同一 note list に現れた created_at の集合へ突合する (偽装修正は集合外時刻なので拒否される)。
const lineageSeconds = new Set();
  for (const note of notes) {
    const ms = parseClaimTime(String(note.createdAt ?? ''));
    if (!Number.isNaN(ms)) lineageSeconds.add(Math.floor(ms / 1000) * 1000);
  }
  for (const note of notes) {
    const body = String(note.body ?? '');
    const m = CLAIM_HEADER_RE.exec(body);
    const marker = SESSION_MARKER_RE.exec(body);
    if (!m && !marker && !/^[ \t]*claimed\S/.test(body)) continue;
    const sessionId = m ? m[1] : marker ? marker[1] : null;
    const atIso = m ? m[2] : null;
    const resumed = m ? m[4] ?? null : null;
    const created = parseClaimTime(String(note.createdAt ?? ''));
    if (Number.isNaN(created)) {
      out.push(invalid(note, m, 'created_at が読めない (forge 正規値なし、§3)'));
      continue;
    }
    if (!sessionId) {
      out.push(invalid(note, m, 'session-id が取得できない (hidden marker 破損時も可視 header に fallback できない、§12)'));
      continue;
    }
    let rejectReason = null;
    if (marker && marker[1] !== sessionId) rejectReason = 'fp:session と可視 header の session-id が不一致 (§12)';
    if (!atIso) rejectReason = '可視 header に `at <iso-time>` が無い (§7 の固定書式)';
    else if (resumed ? !lineageSeconds.has(Math.floor(parseClaimTime(atIso) / 1000) * 1000) : floorSecond(atIso) !== floorSecond(String(note.createdAt))) {
      rejectReason = 'at の時刻が created_at (または元 claim の created_at lineage) と不一致 (偽装 claim、§3・M2(o))';
    }
    if (!rejectReason && opts.windowStart) {
      const ws = parseClaimTime(opts.windowStart);
      if (created < ws) rejectReason = 'スキャン窓の対象外 (再 triage 前の旧 claim は勝者候補から除外、§3(d))';
    }
    if (!rejectReason && opts.headBranch && !BRANCH_RE.test(opts.headBranch)) {
      rejectReason = 'branch 命名規約 (`llm/issue-<N>-<slug>`) に違反する claim 参照 branch (§7)';
    }
    out.push({
      note,
      kind: 'claim',
      sessionId,
      atIso: atIso ?? null,
      created,
      valid: rejectReason === null,
      rejectReason,
      resumed,
    });
  }
  return out;
}

function invalid(note, m, reason) {
  return {
    note,
    kind: 'claim',
    sessionId: m ? m[1] : null,
    atIso: m ? m[2] : null,
    created: parseClaimTime(String(note.createdAt ?? '')),
    valid: false,
    rejectReason: reason,
    resumed: null,
  };
}

/**
 * 勝者判定 (spec §3): scan 窓内の created_at 先頭が勝者。同一秒は競合として扱い、
 * 後から着いた claim は却下 (勝者は 1 つのみ)。valid な candidate のみ競う。
 * 敗者には loop.mjs がコメントで通知し、敗者コメントは残す (§3、台帳算入不算入は budget.mjs)。
 *
 * @param {ReturnType<typeof parseClaims>} candidates
 * @returns {{winner: object|null, losers: Array<object>, sameSecond: boolean}}
 */
export function pickWinner(candidates) {
  const valid = candidates.filter((c) => c.valid);
  const sorted = [...valid].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : String(a.note.createdAt) < String(b.note.createdAt) ? -1 : 1));
  if (sorted.length === 0) return { winner: null, losers: [], sameSecond: false };
  const winner = sorted[0];
  const losers = sorted.slice(1).map((c) => ({ ...c, rejectReason: 'claim-superseded (後着却下、§3)' }));
  const sameSecond = sorted.length > 1 && floorSecond(sorted[0].note.createdAt) === floorSecond(sorted[1].note.createdAt);
  return { winner, losers, sameSecond };
}

/**
 * 復元/再 triage 後の再 claim の新 comment 書式 (§7):
 * `claimed <同 id> at <元 created_at> resumed <iso-time>` + hidden marker 併記。
 * created_at は改変しない (元の値がそのまま勝者の created_at 判定基準に使うため §3/§7)。
 * 復元 session の継承判定: header の session-id が勝者と同一なら新 id ではない (re-claim 算入は別 id のときのみ、§7)。
 *
 * @param {{sessionId: string, atIso: string, created: number}} winner parseClaims の勝者 entry.
 * @param {string} nowIso 再開時刻 (orchestrator 側 clock、comment 本文の `resumed` のみ).
 * @returns {string} postComment に渡す本文 (edit は不可 — 新 comment のみ、§3).
 */
export function resumeClaimBody(winner, nowIso) {
  return `claimed ${winner.sessionId} at ${winner.atIso} resumed ${nowIso}\n<!-- fp:session ${winner.sessionId} -->`;
}

/**
 * 勝者の session-id を継承しているか (§7: 復元セッションは新 id を採らない)。
 * @param {object} winner pickWinner の winner.
 * @param {string} sessionId 起動しようとした turn の session id.
 */
export function inheritsWinner(winner, sessionId) {
  return winner !== null && winner.valid && winner.sessionId === sessionId;
}
