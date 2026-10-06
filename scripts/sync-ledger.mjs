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

// 标签取与磁盘线上包同源的补丁条目：优先匹配正文中「整包 sha256」等于当前 pkgHash 的
// 最后一个补丁标题（一天多补丁/回滚时也能指对；同一天多个中间包只有最终部署包会命中）。
// 找不到再回退为第一个非工具链小节标题。
const isPatchTitle = (t) => !/工具链|工程化|非 app\.asar 成员/.test(t);
const headings = [];
lines.forEach((l, i) => {
  if (l.startsWith('### ')) headings.push({ t: l.slice(4).trim(), i });
});
// 小节正文在下一个任意级别标题（## 或 ###）处终止，文末「## 锚点哈希」才不会被并进上一个 ### 小节
const bodyEnd = (i) => {
  for (let j = i + 1; j < lines.length; j++) {
    if (/^##+ /.test(lines[j])) return j;
  }
  return lines.length;
};
// 标签日期取**本地**日期：toISOString() 是 UTC，东八区凌晨会算成前一天（台账日期一律按本地）
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const archive = readArchive(asarPath);
const pkgHash = sha256(fs.readFileSync(asarPath));
const titleFromHash = [...headings].reverse().find((h) => {
  if (!isPatchTitle(h.t)) return false;
  const end = bodyEnd(h.i);
  const body = lines.slice(h.i, end).join('\n');
  // 锚点小节正文也含整包哈希，但补丁条目用「整包 sha256」标记行，借此排除锚点表
  return body.includes('整包 sha256') && body.includes(pkgHash);
})?.t;
const title = titleFromHash ?? headings.find((h) => isPatchTitle(h.t))?.t ?? '(未命名)';
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
