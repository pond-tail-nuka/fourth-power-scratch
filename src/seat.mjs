// src/seat.mjs — seat adapter (spec §6・§7・contract §4)。cli: agy (live) / stub (録画)。
// 夜間の実測は agy gemini-3.8-flash を使用可 (user 承認 2026-10-31)。heterogeneous 階層: low=flash、high=claude (config modelMap)。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function costOf(usage, config) {
  const c = config.costPerTokenUSD || { input: 0, output: 0 };
  return (usage.input_tokens || 0) * c.input + (usage.output_tokens || 0) * c.output;
}

export function createSeat({ cli, config, workDir }) {
  if (cli === 'stub') return createStubSeat(config.stubDir, config);
  if (cli !== 'agy') throw new Error(`未知の seat cli: ${cli}`);
  const model = (tier) => config.modelMap[tier] || (() => { throw new Error(`modelMap に tier ${tier} が無い`); })();
  function runAgy(args, prompt, timeoutMs) {
    return new Promise((resolve, reject) => {
      const p = spawn('agy', ['-p', ...args], { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', lastEventAt = Date.now(), timer = null;
      const silentKill = setInterval(() => {
        if (Date.now() - lastEventAt > (config.turnTimeoutMin || 10) * 60000) {
          p.kill('SIGTERM'); reject(Object.assign(new Error('turn 打切り (event 静寂)'), { code: 'silence' }));
        }
      }, 5000);
      if (timeoutMs) timer = setTimeout(() => { p.kill('SIGTERM'); reject(Object.assign(new Error('turn 打切り (時刻)'), { code: 'timeout' })); }, timeoutMs);
      p.stdout.on('data', (d) => { stdout += d; lastEventAt = Date.now(); });
      p.stdin.write(prompt); p.stdin.end();
      p.on('close', (code) => {
        clearInterval(silentKill); clearTimeout(timer);
        if (code !== 0) return reject(Object.assign(new Error(`agy exit ${code}: ${stdout.slice(0, 200)}`), { code: 'exit' }));
        try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch (e) { reject(new Error(`agy JSON 解析不可: ${stdout.slice(0, 200)}`)); }
      });
      p.on('error', reject);
    });
  }
  return {
    async startTurn({ role, tier, payload, sessionHint, timeoutMs }) {
      const m = model(tier);
      const args = sessionHint ? ['--conversation', sessionHint, '--model', m] : ['--model', m];
      const j = await runAgy(['--output-format', 'json', '--mode', 'auto', '--dangerously-skip-permissions', '--print-timeout', `${config.turnTimeoutMin || 10}m`, ...args], payload, timeoutMs);
      return {
        sessionId: j.conversation_id,
        text: j.response || '',
        usage: { costUSD: costOf(j.usage || {}, config), turns: j.num_turns || 1, tokens: (j.usage || {}).total_tokens || 0 },
      };
    },
  };
}

export function createStubSeat(dir, config) {
  let seq = 0;
  return {
    async startTurn({ role, tier, payload, sessionHint, fixture }) {
      const name = fixture || (role === 'plan' ? 'plan.json' : role === 'verify' ? 'verify.json' : 'implement.json');
      const events = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const sessionId = sessionHint || `stub-session-${(seq++).toString(36)}`;
      const usage = events.find((e) => e.type === 'usage') || { costUSD: 0, turns: 1 };
      return { sessionId, text: events.filter((e) => e.type === 'text').map((e) => e.text).join('\n'), usage };
    },
  };
}
