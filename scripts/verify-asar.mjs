#!/usr/bin/env node
// 校验补丁后的 asar：成员清单一致、除目标外全部逐字节相同、目标与期望文件一致、
// 且补丁包内每个 packed 成员的 SHA256 integrity 与数据实际哈希吻合。
// 差异成员数允许 0 或 1：0 = 新内容与原内容相同的幂等重写（合法），1 = 目标被改动；
// 任何**非目标**成员出现差异一律立即失败。
// 用法: node verify-asar.mjs <原始 asar> <补丁 asar> <目标成员路径> <期望内容文件>
import fs from 'node:fs';
import {
  readArchive, findNode, listPackedPaths, readPackedData, walkAll, integrityOf
} from './asar-lib.mjs';

const [, , origPath, patchedPath, entry, expectedPath] = process.argv;
if (!origPath || !patchedPath || !entry || !expectedPath) {
  console.error('用法: node verify-asar.mjs <原始 asar> <补丁 asar> <目标成员> <期望内容文件>');
  process.exit(2);
}

const a = readArchive(origPath);
const b = readArchive(patchedPath);

// 1. 成员清单一致
const setA = new Set(listPackedPaths(a.header));
const setB = new Set(listPackedPaths(b.header));
const onlyA = [...setA].filter((f) => !setB.has(f));
const onlyB = [...setB].filter((f) => !setA.has(f));
if (onlyA.length || onlyB.length) {
  throw new Error(`成员清单不一致 仅原始=${JSON.stringify(onlyA)} 仅补丁=${JSON.stringify(onlyB)}`);
}
console.log(`✓ 成员清单一致（packed 成员 ${setA.size} 个）`);

// 2. 逐字节比对，且目标成员等于期望文件
const expected = fs.readFileSync(expectedPath);
let differ = 0;
for (const f of setA) {
  const da = readPackedData(a, findNode(a.header, f));
  const db = readPackedData(b, findNode(b.header, f));
  if (!da.equals(db)) {
    differ++;
    if (f !== entry) throw new Error(`非目标成员出现差异: ${f} (${da.length} vs ${db.length})`);
  }
}
if (differ > 1) throw new Error(`差异成员数=${differ}，预期 0（幂等重写）或 1（目标成员）`);
const targetData = readPackedData(b, findNode(b.header, entry));
if (!targetData.equals(expected)) throw new Error('目标成员与期望内容文件不一致');
if (differ === 0) {
  console.log('✓ 全部成员逐字节相同（幂等重写：新内容与原内容一致，包布局无漂移）');
} else {
  console.log('✓ 仅目标成员发生变化，且与期望内容逐字节一致');
}

// 3. 非 packed 条目（unpacked / link）元数据保持不变
const othersA = [], othersB = [];
walkAll(a.header, () => {}, (n) => othersA.push(JSON.stringify(n)));
walkAll(b.header, () => {}, (n) => othersB.push(JSON.stringify(n)));
if (othersA.length !== othersB.length) throw new Error('unpacked/link 条目数量变化');
for (let i = 0; i < othersA.length; i++) {
  if (othersA[i] !== othersB[i]) throw new Error('unpacked/link 条目元数据发生变化');
}
console.log(`✓ ${othersA.length} 个 unpacked/link 条目元数据未变`);

// 4. 补丁包全部 packed 成员 integrity 实测吻合
let checked = 0;
walkAll(b.header, (node) => {
  const data = readPackedData(b, node);
  const got = integrityOf(data);
  const want = node.integrity;
  if (!want || want.hash !== got.hash || JSON.stringify(want.blocks) !== JSON.stringify(got.blocks) ||
      want.blockSize !== got.blockSize || want.algorithm !== got.algorithm) {
    throw new Error('存在 integrity 与实际数据不符的成员');
  }
  checked++;
});
console.log(`✓ 全部 ${checked} 个 packed 成员的 SHA256 integrity 校验通过`);
console.log('验证通过');
