#!/usr/bin/env node
// 行为层冒烟测试：用应用自带的 CC_SELFTEST 模式实跑一次，断言安全/桥接不变量。
//
// CC Desktop 的 main 进程支持 CC_SELFTEST=1：把 userData 切到临时目录（可与正在运行的
// 正式实例并存，不动真实会话数据），渲染层探针检查 require/process 暴露、CSP 是否禁 eval、
// window.cc 暴露面、路径穿越与畸形 IPC 参数是否被拒，最后打印一行
//   CC_SELFTEST_RESULT {json}
// 并自行退出。本脚本负责启动、抓这行、判定，把"字节层面校验通过"补成"应用确实能起来且姿势正确"。
//
// 用法:
//   node smoke-test.mjs <安装目录 | exe 路径> [--timeout 秒数]   # 实跑
//   node smoke-test.mjs --log <已捕获的 selftest 输出文件>        # 离线判定（重放/留证）
//
// 注意:
//   1. 必须在**普通终端**里跑。在受限沙箱（禁止命名管道/句柄继承）下 Electron 会以
//      `FATAL mojo platform_channel.cc ... 拒绝访问 (0x5)` 崩掉，这不是应用的问题。
//   2. 超时后 cmd 被终止，但已启动的应用实例可能残留，请手动结束。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const logArg = opt('--log', null);
const timeout = Number(opt('--timeout', 120));
const target = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--log' && argv[i - 1] !== '--timeout');

let logFile = logArg;
if (!logArg) {
  if (!target) {
    console.error('用法: node smoke-test.mjs <安装目录|exe 路径> [--timeout 120]\n      node smoke-test.mjs --log <selftest 输出文件>');
    process.exit(2);
  }
  const installDir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const exe = fs.statSync(target).isDirectory() ? findExe(installDir) : target;
  if (!exe) {
    console.error(`✗ 在 ${installDir} 找不到应用 exe（排除 Uninstall*）`);
    process.exit(2);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-smoke-'));
  logFile = path.join(dir, 'selftest.log');
  console.log(`启动自检实例: ${exe}`);
  console.log(`隔离 userData: ${path.join(os.tmpdir(), 'cc-selftest-userdata')}（不动正式数据）`);
  const r = spawnSync('cmd.exe', ['/c', `set "CC_SELFTEST=1"&& "${exe}" > "${logFile}" 2>&1`], {
    cwd: installDir,
    stdio: 'ignore', // 不自己抓管道：由 cmd 写文件，避开 GUI 进程 stdout 句柄问题
    timeout: timeout * 1000,
    windowsHide: true,
    // 关键：Node 默认会给 argv 加引号/反斜杠转义，把 cmd 的整条命令串打坏（表现为日志文件压根没生成）
    windowsVerbatimArguments: true
  });
  if (r.error) {
    console.error(`✗ 启动失败: ${r.error.code || r.error.message}`);
    process.exit(1);
  }
  if (!fs.existsSync(logFile)) {
    console.error('✗ cmd 没有产生日志文件（命令串未被正确执行）');
    console.error(`  exit=${r.status} signal=${r.signal} timeout=${r.error ? 'yes' : 'no'}`);
    console.error(`  命令: cmd.exe /c set "CC_SELFTEST=1"&& "${exe}" > "${logFile}" 2>&1`);
    process.exit(1);
  }
  if (r.signal || r.status === null) {
    console.error(`✗ 超时 ${timeout}s 未退出（可能残留实例，请手动结束 CC Desktop 自检进程）`);
  }
  console.log(`自检日志: ${logFile}\n`);
}

const text = fs.readFileSync(logFile, 'utf8').replace(/^\uFEFF/, ''); // 去 BOM，否则首行匹配失败
const tail = (n = 12) => text.trim().split(/\r?\n/).slice(-n).join('\n');

const line = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('CC_SELFTEST_RESULT ')).pop();
if (!line) {
  console.error('✗ 日志里没有 CC_SELFTEST_RESULT 行 —— 应用没跑到探针（看下面的日志尾部）');
  console.error('----- 日志尾部 -----\n' + tail());
  process.exit(1);
}

let res;
try {
  res = JSON.parse(line.slice('CC_SELFTEST_RESULT '.length));
} catch (e) {
  console.error(`✗ CC_SELFTEST_RESULT 不是合法 JSON: ${e.message}\n${line}`);
  process.exit(1);
}

let failures = 0;
let warnings = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const warn = (cond, msg) => {
  if (!cond) {
    console.log(`⚠ ${msg}`);
    warnings++;
  } else {
    console.log(`✓ ${msg}`);
  }
};

console.log(`探针结果: ${JSON.stringify(res)}\n`);
ok(res.ccPresent === true, 'window.cc 预加载桥存在（渲染层没有裸奔）');
ok(res.requireType === 'undefined', `渲染层 require 不可用（实测 typeof require = ${res.requireType}）`);
ok(res.processType === 'undefined', `渲染层 process 不可用（实测 typeof process = ${res.processType}）`);
ok(res.evalBlocked === true, `CSP 禁止 eval（evalBlocked = ${res.evalBlocked}）`);
ok(res.traversal && res.traversal !== 'allowed(!)', `fs 路径穿越被拒（${res.traversal}）`);
ok(res.malformed && res.malformed !== 'accepted(!)', `畸形 IPC 参数被拒（${res.malformed}）`);
warn(res.status === 'ready', `后端状态 = ${res.status}（非 ready 时聊天功能不可用，UI 补丁仍可验证）`);
warn(res.wizard === 'ok', `向导联调 = ${res.wizard}`);
console.log(`\nCSP: ${res.cspHeader}`);
console.log(`桥接口: ${(res.bridgeKeys || []).join(', ')}`);

console.log(
  failures === 0
    ? `\n行为层冒烟通过 ✅${warnings ? `（${warnings} 项告警）` : ''}`
    : `\n行为层冒烟失败：${failures} 项不变量被破坏 ❌`
);
process.exit(failures === 0 ? 0 : 1);

function findExe(dir) {
  const cands = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.exe') && !/^uninstall/i.test(f))
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
  return cands.length ? path.join(dir, cands[0].f) : null;
}
