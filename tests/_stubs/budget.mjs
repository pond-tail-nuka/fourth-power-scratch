// tests/_stubs/budget.mjs — contract §7 の budget 台帳ミニスタブ (conformance suite フォールバック用)。
// 本実装 (src/budget.mjs) が conformance suite の shape 突合を通過すれば、このスタブは使われない。
// 台帳行の形: {turn, costUSD, seconds, at} (forge 台帳行 `budget: consumed_usd=<num> consumed_seconds=<num> at <iso-time>` の写し)。
// over の判定: maxTurns は台帳行の数、maxCostUSD / maxTimeMin は台帳行の数値合計 (spec §7: ローカル集計の逆算なし、数値のみ)。
// 概算保守側 (spec §7: accounting line 無し turn は 1 turn 加算・config の turn 上限で概算) は suite のスタブ範囲外 (GateLoop 本実装側)。

export const emptyLedger = [];

export function overBudget(ledger, budget) {
  if (!budget) return false;
  const maxTurns = budget.maxTurns;
  if (maxTurns != null && ledger.length > maxTurns) return true;
  if (budget.maxCostUSD != null) {
    const cost = ledger.reduce((sum, l) => sum + (l.costUSD ?? 0), 0);
    if (cost > budget.maxCostUSD) return true;
  }
  if (budget.maxTimeMin != null) {
    const seconds = ledger.reduce((sum, l) => sum + (l.seconds ?? 0), 0);
    if (seconds > budget.maxTimeMin * 60) return true;
  }
  return false;
}

/**
 * seat の usage event を消費して台帳を伸ばす。over は maxTurns / cost / time の cap 突合。
 * suite 側は plan 群で plan 打切り上限に置いた budget オブジェクトを渡す (spec §7: plan turn の budget は既存計算をそのまま使う)。
 * @param {object[]} ledger 既存台帳
 * @param {{turn:number, costUSD:number, seconds:number, at?:string}} usage
 * @param {object} budgetCfg config.budget の cap ({maxTurns,maxCostUSD,maxTimeMin})
 * @param {string} nowISO
 * @returns {{ledger: object[], over: boolean}}
 */
export function consumeTurn(ledger, usage, budgetCfg, nowISO) {
  const line = {
    turn: usage.turn,
    costUSD: usage.costUSD,
    seconds: usage.seconds,
    at: usage.at ?? nowISO,
  };
  const next = [...ledger, line];
  return { ledger: next, over: overBudget(next, budgetCfg) };
}
