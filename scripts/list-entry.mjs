#!/usr/bin/env node
// 列出 asar 全部成员（零外部依赖，替代 npx @electron/asar list）。
// 用法:
//   node list-entry.mjs <app.asar>                 列出全部成员
//   node list-entry.mjs <app.asar> --filter <子串> 只列路径含子串的成员
//   node list-entry.mjs <app.asar> --packed-only   只列 packed 成员
// 输出每行: <标记> <字节数> <路径>
//   标记: [P] packed 文件  [U] unpacked（磁盘文件，在 .unpacked 目录）  [L] 链接
import { readArchive } from './asar-lib.mjs';

const [, , asarPath, ...rest] = process.argv;
if (!asarPath) {
  console.error('用法: node list-entry.mjs <app.asar> [--filter <子串>] [--packed-only]');
  process.exit(2);
}
let filter = null;
let packedOnly = false;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--filter') filter = rest[++i] ?? '';
  else if (rest[i] === '--packed-only') packedOnly = true;
}

const archive = readArchive(asarPath);
const rows = [];
const walk = (node, prefix) => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) {
      walk(child, p);
    } else if (typeof child.offset === 'string') {
      rows.push({ tag: 'P', size: child.size, path: p });
    } else if (child.link) {
      if (!packedOnly) rows.push({ tag: 'L', size: 0, path: p });
    } else if (child.unpacked) {
      if (!packedOnly) rows.push({ tag: 'U', size: child.size ?? 0, path: p });
    }
  }
};
walk(archive.header, '');

const filtered = filter ? rows.filter((r) => r.path.includes(filter)) : rows;
const width = filtered.reduce((w, r) => Math.max(w, String(r.size).length), 0);
for (const r of filtered) {
  console.log(`[${r.tag}] ${String(r.size).padStart(width)}  ${r.path}`);
}
console.error(`共 ${filtered.length} 个成员（全包 ${rows.length} 个）`);
