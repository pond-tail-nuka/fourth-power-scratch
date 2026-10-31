// Deterministic mock clock (contract §3 / spec §11 mock bullet — §7 の created_at
// 突合に使う). 固定開始時刻から 1 秒刻みで進む決定論的 clock. ms は持たない
// (秒精度のみ). 書き込みごとに 1 進む — 決定論で再現可能な fixture 応答を作る.

/** 固定開始時刻 (決定論 — Date.now を呼ばない). */
export const EPOCH_ISO = '2026-01-01T00:00:00Z';

/**
 * ISO 文字列を秒精度の正規値 `YYYY-MM-DDTHH:MM:SSZ` へ正規化する.
 * @param {string|number|Date} isoOrMs
 * @returns {string}
 */
export function fixedISO(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (Number.isNaN(ms)) throw new Error(`invalid time: ${String(isoOrMs)}`);
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 秒精度へ切捨てた ISO 文字列.
 * @param {string} iso
 * @returns {string}
 */
export function isoSecond(iso) {
  return fixedISO(iso);
}

/**
 * 秒精度の ms エポック (突合比較キー). 不正時は NaN.
 * @param {string} iso
 * @returns {number}
 */
export function secondMs(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 1000) * 1000;
}

/**
 * 決定論 mock clock. 1 書き込み = 1 秒進み、`at <iso-time` の正本 created_at を作る.
 * @param {string} [baseISO]
 */
export function createMockClock(baseISO = EPOCH_ISO) {
  let ms = secondMs(baseISO);
  if (Number.isNaN(ms)) throw new Error(`invalid clock base: ${baseISO}`);
  const state = { ms };
  return {
    /** 進めないまま現在の時刻を返す. */
    peek() {
      return fixedISO(state.ms);
    },
    /** 1 進めてその時刻を返す (書き込みの created_at に使う). */
    advance() {
      state.ms += 1000;
      return fixedISO(state.ms);
    },
    /** 現在時刻のまま返す (更新時刻 — 書き順を変えない). */
    touch() {
      return fixedISO(state.ms);
    },
    /** 基準へ戻す (リセット用). */
    reset(base = baseISO) {
      state.ms = secondMs(base);
      return fixedISO(state.ms);
    },
    /** 現在の秒を固定 ISO で返す (advance と同一の現在値). */
    now: () => fixedISO(state.ms),
  };
}
