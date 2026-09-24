#!/usr/bin/env node
// 读取 asar 中单个成员到文件或 stdout，无需整包解包（避开缺失 unpacked 文件导致 extract 报错）。
// 用法: node read-entry.mjs <app.asar> <成员路径(/分隔)> [输出文件]
import fs from 'node:fs';
import path from 'node:path';
import { readArchive, findNode, readPackedData } from './asar-lib.mjs';

const [, , asarPath, entry, outFile] = process.argv;
if (!asarPath || !entry) {
  console.error('用法: node read-entry.mjs <app.asar> <成员路径, 如 out/main/index.js> [输出文件]');
  process.exit(2);
}

const archive = readArchive(asarPath);
const node = findNode(archive.header, entry);
let data;
if (typeof node.offset === 'string') {
  data = readPackedData(archive, node);
} else if (node.unpacked) {
  const p = path.join(`${asarPath}.unpacked`, ...entry.split('/'));
  data = fs.readFileSync(p);
} else {
  throw new Error('该成员既不是 packed 文件也不是 unpacked 文件（可能是符号链接）');
}

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, data);
  console.log(`已写出 ${outFile} (${data.length} 字节)`);
} else {
  process.stdout.write(data);
}
