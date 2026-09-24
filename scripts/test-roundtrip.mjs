#!/usr/bin/env node
// asar 补丁链路往返回归测试（零外部依赖，仅 Node 内置模块）。
// 三件事全部通过才 exit 0：
//   A. 幂等往返：读出某成员原内容 → 以原内容打补丁 → 产物与原包 sha256 逐字节相同
//   B. 真实改动：改动 1 字节 → 打补丁 → verify-asar.mjs 四重校验通过
//   C. 空文件目标必须被拒绝（非 0 退出）
// 同时打印基线：packed 成员数 / 空文件数 / integrity 不符数（CC Desktop 当前基线 7897 / 2 / 0）。
//
// 用法: node test-roundtrip.mjs <app.asar>
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readArchive, walkAll, readPackedData, integrityOf, listPackedPaths
} from './asar-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [, , asarPath] = process.argv;
if (!asarPath) {
  console.error('用法: node test-roundtrip.mjs <app.asar>');
  process.exit(2);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const run = (script, args) => spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-rt-'));
try {
  const archive = readArchive(asarPath);

  // ---- 基线统计 ----
  const packedPaths = listPackedPaths(archive.header);
  const emptyPaths = [];
  let integrityBad = 0;
  const nonEmpty = [];
  walkAll(archive.header, (node) => {
    if (node.size === 0) {
      emptyPaths.push(node);
    } else {
      nonEmpty.push(node);
    }
    const data = readPackedData(archive, node);
    const got = integrityOf(data);
    if (!node.integrity || node.integrity.hash !== got.hash) integrityBad++;
  });
  console.log(`基线: packed=${packedPaths.length} / empty=${emptyPaths.length} / integrityBad=${integrityBad}`);
  console.log(`      （CC Desktop 历史基线 7897 / 2 / 0；数字变化意味着打包器或包结构变化）\n`);

  // 选体积最小的非空成员作为补丁样本（跑得快），并反查其路径
  const sampleNode = nonEmpty.reduce((m, n) => (n.size < m.size ? n : m), nonEmpty[0]);
  let samplePath = null;
  {
    const findPath = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child === sampleNode) return p;
        if (child.files) {
          const hit = findPath(child, p);
          if (hit) return hit;
        }
      }
      return null;
    };
    samplePath = findPath(archive.header, '');
  }
  console.log(`样本成员: ${samplePath} (${sampleNode.size} 字节)\n`);

  const originalFile = path.join(tmpDir, 'original.bin');
  fs.writeFileSync(originalFile, readPackedData(archive, sampleNode));

  // ---- A. 幂等往返：以原内容打补丁，产物必须与原包逐字节相同 ----
  console.log('A. 幂等往返测试');
  const idempotentOut = path.join(tmpDir, 'idempotent.asar');
  const rA = run('patch-asar.mjs', [asarPath, samplePath, originalFile, idempotentOut]);
  ok(rA.status === 0, 'patch-asar 以原内容重写退出码为 0');
  if (rA.status === 0) {
    const same = sha256(fs.readFileSync(idempotentOut)) === sha256(fs.readFileSync(asarPath));
    ok(same, '幂等产物与原包 sha256 完全一致（布局无漂移）');
  }

  // ---- B. 真实改动 + verify ----
  console.log('\nB. 真实改动 + verify 测试');
  const modifiedFile = path.join(tmpDir, 'modified.bin');
  const modified = Buffer.concat([fs.readFileSync(originalFile), Buffer.from('\n// roundtrip-test-marker\n', 'utf8')]);
  fs.writeFileSync(modifiedFile, modified);
  const changedOut = path.join(tmpDir, 'changed.asar');
  const rB = run('patch-asar.mjs', [asarPath, samplePath, modifiedFile, changedOut]);
  ok(rB.status === 0, 'patch-asar 以改动内容打补丁退出码为 0');
  if (rB.status === 0) {
    const rV = run('verify-asar.mjs', [asarPath, changedOut, samplePath, modifiedFile]);
    process.stdout.write(rV.stdout);
    if (rV.stderr) process.stderr.write(rV.stderr);
    ok(rV.status === 0, 'verify-asar 四重校验全部通过');
  }

  // ---- C. 空文件目标必须被拒绝 ----
  console.log('\nC. 空文件目标拒绝测试');
  if (emptyPaths.length === 0) {
    console.log('⊘ 包内无空文件成员，跳过（guard 仍在代码中生效）');
  } else {
    const findEmptyPath = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.size === 0 && typeof child.offset === 'string') return p;
        if (child.files) {
          const hit = findEmptyPath(child, p);
          if (hit) return hit;
        }
      }
      return null;
    };
    const emptyPath = findEmptyPath(archive.header, '');
    const nonEmptyPayload = path.join(tmpDir, 'nonempty.txt');
    fs.writeFileSync(nonEmptyPayload, Buffer.from('not empty\n'));
    const badOut = path.join(tmpDir, 'should-not-exist.asar');
    const rC = run('patch-asar.mjs', [asarPath, emptyPath, nonEmptyPayload, badOut]);
    ok(rC.status !== 0, `空文件成员 ${emptyPath} 被拒绝（退出码 ${rC.status}）`);
    ok(!fs.existsSync(badOut), '拒绝时不产出补丁文件');
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '全部测试通过 ✅' : `${failures} 项断言失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
