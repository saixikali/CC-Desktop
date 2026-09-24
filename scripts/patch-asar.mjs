#!/usr/bin/env node
// 精确替换 asar 中单个 packed 成员，保留其余全部条目（含 unpacked / 缺失的平台二进制条目）。
// 用法: node patch-asar.mjs <app.asar> <成员路径(/分隔)> <新内容文件> [输出 asar，默认 <app.asar>.patched]
import fs from 'node:fs';
import {
  readArchive, buildArchive, findNode, walkAll, readPackedData, integrityOf
} from './asar-lib.mjs';

const [, , asarPath, entry, newContentPath, outArg] = process.argv;
if (!asarPath || !entry || !newContentPath) {
  console.error('用法: node patch-asar.mjs <app.asar> <成员路径> <新内容文件> [输出路径]');
  process.exit(2);
}
const outPath = outArg ?? `${asarPath}.patched`;

const archive = readArchive(asarPath);
const targetNode = findNode(archive.header, entry);
if (targetNode.unpacked) throw new Error('目标是 unpacked 成员，直接替换 .unpacked 目录中的磁盘文件即可，无需重打包');
if (typeof targetNode.offset !== 'string') throw new Error('目标不是 packed 文件');
if (targetNode.size === 0) {
  throw new Error('空文件成员不可作为补丁目标：其 offset 与下一个真实文件共享，替换会顶掉邻居内容');
}

// 1. 收集 packed 内容组。
// 关键坑：打包器对 size=0 的空文件不推进 offset，空条目会与下一个真实文件共享 offset，
// 不能把它们并入内容组，否则真实文件的 size/integrity 会被覆盖成空文件的值。
const groups = new Map(); // oldOffset(number) -> { entries, buffer }
const emptyEntries = [];
walkAll(
  archive.header,
  (child) => {
    if (child.size === 0) {
      emptyEntries.push(child);
      return;
    }
    const off = parseInt(child.offset, 10);
    if (!groups.has(off)) groups.set(off, { entries: [], buffer: null });
    groups.get(off).entries.push(child);
  }
);

const sortedOffsets = [...groups.keys()].sort((a, b) => a - b);
for (const off of sortedOffsets) {
  const g = groups.get(off);
  const size = g.entries[0].size;
  const hash = g.entries[0].integrity?.hash;
  for (const e of g.entries) {
    // 同 offset 的条目是 dedup 关系，必须内容一致；不一致说明理解有误，立即中止
    if (e.size !== size || e.integrity?.hash !== hash) {
      throw new Error(`offset ${off} 组内条目内容不一致，拒绝重写`);
    }
  }
  g.buffer = readPackedData(archive, g.entries[0]);
}

// 2. 替换目标组内容
const newContent = fs.readFileSync(newContentPath);
const targetOldOffset = parseInt(targetNode.offset, 10);
const targetGroup = groups.get(targetOldOffset);
if (!targetGroup) throw new Error('目标文件所在内容组缺失（可能是空文件）');
const changed = !targetGroup.buffer.equals(newContent);
targetGroup.buffer = newContent;
console.log(`成员 ${entry}: ${targetNode.size} -> ${newContent.length} 字节，${changed ? '内容有变化' : '内容未变化（幂等重写）'}`);

// 3. 顺序重排所有内容组的 offset；仅目标组重算 integrity，其余原样保留
const oldToNewOffset = new Map();
let cursor = 0;
for (const off of sortedOffsets) {
  const g = groups.get(off);
  const newOffset = String(cursor);
  oldToNewOffset.set(off, newOffset);
  const integrity = g === targetGroup ? integrityOf(g.buffer) : g.entries[0].integrity;
  for (const e of g.entries) {
    e.offset = newOffset;
    e.size = g.buffer.length;
    if (integrity) e.integrity = integrity;
  }
  cursor += g.buffer.length;
}
// 空条目：把 offset 同步到它所跟随的那个真实内容组的新 offset（运行时空文件不读 offset，但保持自洽）
for (const e of emptyEntries) {
  const follow = oldToNewOffset.get(parseInt(e.offset, 10));
  if (follow === undefined) {
    // 数据区最后一个条目是空文件时，其后没有真实内容组；保持旧 offset 并告警
    console.warn(`警告：空文件成员 offset=${e.offset} 后无真实内容组，保留原 offset（运行时不读取，无害）`);
    continue;
  }
  e.offset = follow;
}

// 4. 序列化写出
const out = buildArchive(archive.header, sortedOffsets.map((off) => groups.get(off).buffer));
fs.writeFileSync(outPath, out);
console.log(`已写出 ${outPath}，总大小 ${out.length} 字节（非空内容组 ${groups.size}，空文件条目 ${emptyEntries.length} 保持不写入数据）`);
