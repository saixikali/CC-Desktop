#!/usr/bin/env node
// 台账自检：把 CHANGELOG.md「锚点哈希」表里记的哈希与磁盘上真实的 app.asar 对齐。
// 校验三件事，任一不符即非 0 退出：
//   1. 「当前线上包」整包 sha256 == 安装目录 resources\app.asar 的实测 sha256
//   2. 「当前线上包」块内每个成员 sha256 == 从 app.asar 抽出该成员的实测 sha256
//   3. 成员条目声明的字节数与成员实际字节数一致
// 用法: node check-ledger.mjs <CHANGELOG.md> <app.asar>
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readArchive, findNode, readPackedData } from './asar-lib.mjs';

const [, , ledgerPath, asarPath] = process.argv;
if (!ledgerPath || !asarPath) {
  console.error('用法: node check-ledger.mjs <CHANGELOG.md> <app.asar>');
  process.exit(2);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// 去 BOM：PowerShell 的 Set-Content/Out-File 默认带 BOM，会让行首匹配整体失效
const text = fs.readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/);

// --- 1. 找到「当前线上包」那一行，取整包哈希 ---
// 必须同时满足：锚点表行（以 | 开头）+ 含「当前线上包」+ 含 64 位哈希。
// 只按文案匹配会误命中正文里提到「当前线上包快照」的叙述句。
const pkgLine = lines.findIndex(
  (l) => l.trimStart().startsWith('|') && l.includes('当前线上包') && /`[0-9a-f]{64}`/.test(l)
);
if (pkgLine < 0) {
  console.error('✗ 台账里找不到「当前线上包」锚点行（应形如 `| **当前线上包**（截至 …） | `<sha256>` |`）');
  process.exit(1);
}
const pkgHash = /`([0-9a-f]{64})`/.exec(lines[pkgLine])?.[1];
if (!pkgHash) {
  console.error(`✗ 「当前线上包」行里没有 64 位 sha256: ${lines[pkgLine]}`);
  process.exit(1);
}

// --- 2. 紧随其后的「| └ 成员路径（字节数） | `hash` |」行 ---
const members = [];
for (let i = pkgLine + 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('|')) break;
  const m = /^\|\s*└\s*(.+?)（(\d+)\s*B）\s*\|\s*`([0-9a-f]{64})`/.exec(line);
  if (!m) break;
  members.push({ entry: m[1].trim(), size: Number(m[2]), hash: m[3] });
}
if (members.length === 0) {
  console.error('✗ 「当前线上包」块里没有任何 `| └ 成员（N B） | hash |` 行');
  process.exit(1);
}

// --- 3. 实测 ---
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

const actualPkg = sha256(fs.readFileSync(asarPath));
ok(actualPkg === pkgHash, `整包 sha256 与台账一致\n    台账 ${pkgHash}\n    实测 ${actualPkg}`);

const archive = readArchive(asarPath);
for (const { entry, size, hash } of members) {
  let data;
  try {
    const node = findNode(archive.header, entry);
    data = readPackedData(archive, node);
  } catch (e) {
    ok(false, `成员 ${entry} 在 asar 中读取失败: ${e.message}`);
    continue;
  }
  const actual = sha256(data);
  ok(actual === hash, `成员 ${entry} sha256 一致`);
  if (actual !== hash) console.log(`    台账 ${hash}\n    实测 ${actual}`);
  ok(data.length === size, `成员 ${entry} 字节数 ${size} 一致（实测 ${data.length}）`);
}

console.log(
  failures === 0
    ? `\n台账自检通过：线上包与 ${members.length} 个成员哈希全部对齐 ✅`
    : `\n台账自检失败：${failures} 项不符 ❌（先补台账，再改这张表）`
);
process.exit(failures === 0 ? 0 : 1);
