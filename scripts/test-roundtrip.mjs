#!/usr/bin/env node
// asar 补丁链路往返回归测试（零外部依赖，仅 Node 内置模块）。
// 三件事全部通过才 exit 0：
//   A. 幂等往返：读出某成员原内容 → 以原内容打补丁 → 产物与原包 sha256 逐字节相同
//   B. 真实改动：改动 1 字节 → 打补丁 → verify-asar.mjs 四重校验通过
//   C. 空文件目标必须被 guard 拒绝（退出码 1、stderr 含 guard 文案、且不产出文件）
// 同时打印基线：packed 成员数 / 空文件数 / integrity 不符数（CC Desktop 当前基线 7897 / 2 / 0）。
//
// 注意：本脚本用 spawnSync 起子进程并捕获输出。在禁止 piped stdio 的受限沙箱下子进程会
// EPERM 启动失败（status 为 null）——那是**环境不支持**，脚本会以退出码 2 明确区分，
// 既不会被误判成「守卫生效」的假绿，也不会被误读成「回归挂了」。请在普通终端运行。
//
// 退出码：0 = 全部通过，1 = 断言失败，2 = 用法/环境不支持。
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
// 子进程没跑起来时 status 也是 null，绝不能拿 status !== 0 当"守卫生效"的证据（会造成假绿）
const tail = (r) => (r.stderr || r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? '';
const spawnNote = (r) => (r.error ? `（${r.error.code || r.error.message}）` : '');
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

// 环境探针：受限沙箱禁止 piped stdio 时 spawnSync 会 EPERM。这种情况是环境不支持，
// 不是断言失败（以退出码 2 报告），免得被误读成回归/或被"修"回旧的假绿写法。
const probe = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
if (probe.error) {
  console.error(
    `⊘ 环境禁止子进程（${probe.error.code || probe.error.message}）：本测试需要 spawnSync 捕获子进程输出，` +
      '请在普通终端（非受限 Agent 沙箱）运行。'
  );
  process.exit(2);
}

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
  ok(!rA.error, `patch-asar 子进程可正常启动${spawnNote(rA)}`);
  ok(rA.status === 0, `patch-asar 以原内容重写退出码为 0${rA.status === 0 ? '' : `（实际 ${rA.status}；${tail(rA)}）`}`);
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
  ok(!rB.error, `patch-asar 子进程可正常启动${spawnNote(rB)}`);
  ok(rB.status === 0, `patch-asar 以改动内容打补丁退出码为 0${rB.status === 0 ? '' : `（实际 ${rB.status}；${tail(rB)}）`}`);
  if (rB.status === 0) {
    const rV = run('verify-asar.mjs', [asarPath, changedOut, samplePath, modifiedFile]);
    process.stdout.write(rV.stdout);
    if (rV.stderr) process.stderr.write(rV.stderr);
    ok(rV.status === 0, `verify-asar 四重校验全部通过${rV.status === 0 ? '' : `（实际 ${rV.status}；${tail(rV)}）`}`);
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
    ok(!rC.error, `patch-asar 子进程可正常启动${spawnNote(rC)}`);
    ok(rC.status === 1, `空文件成员 ${emptyPath} 被守卫拒绝（退出码须为 1，实际 ${rC.status}${rC.status === null ? '：子进程未正常退出' : ''}）`);
    ok(/空文件成员不可作为补丁目标/.test(rC.stderr || ''), `拒绝原因确为空文件 guard${rC.stderr ? `（${tail(rC)}）` : '（stderr 为空）'}`);
    ok(!fs.existsSync(badOut), '拒绝时不产出补丁文件');
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '全部测试通过 ✅' : `${failures} 项断言失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
