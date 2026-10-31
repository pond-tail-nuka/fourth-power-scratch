#!/usr/bin/env node
// scripts/status.mjs — read-only projection (spec §2.1: read 経路のみ・書込みなし — A1 実装)。
// --json: 固定 offline 投影 {schemaVersion, issues[], maxAgeSec} (PROPOSAL §14 B)。table: 行を ASCII 出力。
const flags = process.argv.slice(2);
const json = flags.includes('--json');
const offline = flags.includes('--offline');
if (!offline) {
  console.error('status.mjs: --offline のみ対応 (本番 provider は §11 mock bullet — 夜間は offline 固定)');
  process.exit(1);
}
const projection = {
  schemaVersion: 1,
  issues: [{ repo: 'mock/fourth_power', number: 1, statusLabel: 'backlog', written: false }],
  maxAgeSec: 30,
};
if (json) process.stdout.write(JSON.stringify(projection));
else process.stdout.write('fp-status-table\nmock/fourth_power 1 backlog\n');
