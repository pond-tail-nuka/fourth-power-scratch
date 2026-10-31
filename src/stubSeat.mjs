// src/stubSeat.mjs — 録画 conformance 用 seat provider (spec §6: recorded fixture 再生、live 呼び出し禁止).
// contract §4: startTurn({role, tier, payload, sessionHint}) → { sessionId, events: asyncGen }.
// tests/fixtures/seat/*.json の event 配列 [{type:"session",sessionId},{type:"text"},...,{type:"usage",...}] を
// そのまま再生する。session id・usage は決定論 (fixture 由来 / sessionHint 上書き)。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DEFAULT_FIXTURE_DIR = fileURLToPath(new URL('../tests/fixtures/seat/', import.meta.url));

// role 別既定 fixture (決定論選択 — conformance suite は fixture を明示して呼ぶ)。
const ROLE_DEFAULTS = {
  investigate: 'p1-green-implement.json',
  implement: 'p1-green-implement.json',
  submit: 'p1-green-implement.json',
  plan: 'p2-plan.json',
  review: 'p2-child-implement.json',
  verify: 'p2-child-implement.json',
};

function fixtureFileName(fixture) {
  if (fixture == null) return null;
  return fixture.endsWith('.json') ? fixture : `${fixture}.json`;
}

/**
 * 録画 seat fixture を再生する startTurn 互換関数。
 * @param {{role?: string, tier?: string|null, payload?: string, sessionHint?: string|null, fixture?: string|null, fixtureDir?: string}} opts
 * @returns {Promise<{sessionId: string, events: AsyncGenerator<object>}>}
 */
export async function startTurn(opts = {}) {
  const { role = 'implement', sessionHint = null, fixtureDir = DEFAULT_FIXTURE_DIR } = opts;
  const fileName = fixtureFileName(opts.fixture) ?? ROLE_DEFAULTS[role] ?? 'p1-green-implement.json';
  const raw = await readFile(join(fixtureDir, fileName), 'utf8');
  const events = JSON.parse(raw);
  if (!Array.isArray(events)) {
    throw new Error(`stubSeat: fixture ${fileName} is not an event array`);
  }
  const recorded = events.find((e) => e && e.type === 'session')?.sessionId ?? fileName.replace(/\.json$/, '');
  const sessionId = sessionHint ?? recorded;
  const replayed = events.map((e) => (e && e.type === 'session' ? { ...e, sessionId } : e));
  async function* replay() {
    for (const ev of replayed) yield structuredClone(ev);
  }
  return { sessionId, events: replay() };
}

export const DEFAULT_SEAT_FIXTURE_DIR = DEFAULT_FIXTURE_DIR;
