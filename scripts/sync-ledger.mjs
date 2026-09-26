#!/usr/bin/env node
// 一键对齐：把 CHANGELOG「锚点哈希 → 当前线上包」块与磁盘上真实 asar 对齐，并把改后成员刷新进快照目录。
// 每个补丁部署后跑一次；幂等，可重复执行。里程碑锚点块不受影响。
// 用法: node sync-ledger.mjs <CHANGELOG.md> <app.asar> [快照目录]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readArchive, findNode, readPackedData } from './asar-lib.mjs';

const [, , ledgerPath, asarPath, snapshotDirArg] = process.argv;
if (!ledgerPath || !asarPath) {
  console.error('用法: node sync-ledger.mjs <CHANGELOG.md> <app.asar> [快照目录]');
  process.exit(2);
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const raw = fs.readFileSync(ledgerPath, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);

// 「当前线上包」锚点行必须同时是表格行且含 64 位哈希（正文叙述句会误命中）
const anchorIdx = lines.findIndex(
  (l) => l.trimStart().startsWith('|') && l.includes('当前线上包') && /`[0-9a-f]{64}`/.test(l)
);
if (anchorIdx < 0) {
  console.error('✗ 台账里找不到「当前线上包」锚点行');
  process.exit(1);
}

// 标签取最新补丁条目标题，跳过工具链/工程化这类非补丁小节
const title =
  lines
    .filter((l) => l.startsWith('### '))
    .map((l) => l.slice(4).trim())
    .find((t) => !/工具链|工程化|非 app\.asar 成员/.test(t)) ?? '(未命名)';
const today = new Date().toISOString().slice(0, 10);

const archive = readArchive(asarPath);
const pkgHash = sha256(fs.readFileSync(asarPath));
lines[anchorIdx] = `| **当前线上包**（截至 ${today}「${title}」） | \`${pkgHash}\` |`;

const members = [];
for (let i = anchorIdx + 1; i < lines.length; i++) {
  const m = /^\|\s*└\s*(.+?)（(\d+)\s*B）\s*\|\s*`([0-9a-f]{64})`\s*\|/.exec(lines[i]);
  if (!m) break;
  const entry = m[1].trim();
  const data = readPackedData(archive, findNode(archive.header, entry)); // 成员缺失会直接抛错
  const hash = sha256(data);
  lines[i] = `| └ ${entry}（${data.length} B） | \`${hash}\` |`;
  members.push({ entry, data, hash, changed: hash !== m[3] });
}
if (members.length === 0) {
  console.error('✗ 「当前线上包」块里没有 `| └ 成员（N B） | hash |` 行，无法对齐');
  process.exit(1);
}

fs.writeFileSync(ledgerPath, lines.join(eol), 'utf8');
console.log(`台账锚点块已对齐：整包 ${pkgHash.slice(0, 8)}… 「${title}」（${today}）`);
for (const m of members) {
  console.log(`  ${m.changed ? '↻ 更新' : '= 未变'} ${m.entry}（${m.data.length} B）${m.hash.slice(0, 8)}…`);
}

if (snapshotDirArg) {
  for (const m of members) {
    const dst = path.join(snapshotDirArg, ...m.entry.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, m.data);
  }
  console.log(`快照已刷新：${members.length} 个成员 → ${snapshotDirArg}`);
}

console.log('\n下一步：node check-ledger.mjs <CHANGELOG.md> <app.asar> 应 exit 0');
