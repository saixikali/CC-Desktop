/**
 * Stop hook 自检：离线、不需要联网、不需要真实会话。
 *
 * 造一份合成的 transcript，按真实 payload 形状喂给 hook-stop.mjs，断言：
 *  - 基线机制生效（装 hook 前的轮次不算）
 *  - 同一次 API 调用的两条记录只算一次（不去重就会双倍计费）
 *  - 增量读取不重复计费
 *  - 峰谷按事件时间戳判定（不是按运行时间）
 *  - stdout 绝对干净（否则会污染对话）
 *  - 退出码恒为 0（记账失败不能阻断对话）
 *
 * 用法：node test-hook.mjs
 * 退出码：0 通过 / 1 断言失败 / 2 环境不支持（子进程 EPERM）
 */

import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(HERE, '..', '..');
const APP_EXE = path.join(INSTALL_ROOT, 'CC Desktop.exe');
const HOOK = path.join(HERE, 'hook-stop.mjs');

// 自检绝不碰生产账本！
// 这里以前直接操控 plugins-state.whale-balance.json，而且**开头删一次、结尾删一次**
// —— 跑一次 node test-hook.mjs 就把用户全部的余额观测与用量历史静默清空。
// 现在账本重定向到临时文件：子进程（hook-stop.mjs）通过继承的 WHALE_BALANCE_LEDGER 看到同一路径。
// 生产账本在这整个文件里只读不写。
const PROD_LEDGER = path.join(INSTALL_ROOT, 'plugins-state.whale-balance.json');
const LEDGER = path.join(os.tmpdir(), `whale-balance-hooktest-${process.pid}.json`);
process.env.WHALE_BALANCE_LEDGER = LEDGER;

// 开工前给生产账本拍个哈希，收工时比对 —— 这是"自检不许碰生产数据"这条规矩的守门人。
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PROD_LEDGER_HASH = fs.existsSync(PROD_LEDGER) ? sha256(fs.readFileSync(PROD_LEDGER)) : null;
const STATE = path.join(HERE, '.hook-state.json');
const LOG = path.join(HERE, 'hook.log');

const SCRATCH = path.join(INSTALL_ROOT, '_hooktest');
const FIXTURE = path.join(SCRATCH, 'transcript.jsonl');

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ''}`);
  } catch (err) {
    failures.push(`${name}: ${err?.message ?? String(err)}`);
    console.log(`  ✗ ${name}  → ${err?.message ?? String(err)}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, label = '') {
  if (String(actual) !== String(expected)) throw new Error(`${label}期望 ${expected}，实际 ${actual}`);
  return String(actual);
}

// 固定时刻：2026-10-01 周四 UTC 02:00 = 北京 10:00 → 高峰价
const PEAK_MS = Date.UTC(2026, 9, 1, 2, 0);
// 2026-10-01 周四 UTC 15:00 = 北京 23:00 → 谷价
const VALLEY_MS = Date.UTC(2026, 9, 1, 15, 0);

/** 造一条 assistant transcript 记录。同一 callId 写两次，模拟 thinking 条 + text 条。 */
function assistantEntry({ callId, model, ts, input, output, cacheRead }) {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${callId}-uuid`,
    sessionId: 'selftest-session',
    timestamp: new Date(ts).toISOString(),
    message: {
      id: callId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}

function runHook(payload, env = {}) {
  // 每个用例都从干净的日志开始 —— 否则上一个用例的日志会让"本次记了几轮"这类断言错乱
  fs.rmSync(LOG, { force: true });
  const result = spawnSync(APP_EXE, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
  });
  if (result.error) {
    const err = new Error(`无法启动 hook 子进程：${result.error.message}`);
    err.env = result.error.code === 'EPERM';
    throw err;
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return null;
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
}

function diag(tag) {
  const ledger = readLedger();
  const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
  const stStat = fs.existsSync(STATE) ? fs.statSync(STATE) : null;
  const calls = ledger ? ledger.turns.map((t) => t.callId ?? t.source).join(',') : '-';
  console.log(`      · ${tag}: turns=${ledger ? ledger.turns.length : 0} [${calls}] offset=${st?.offset} state_bytes=${stStat?.size ?? 'x'} state_mtime=${stStat ? stStat.mtimeMs.toFixed(0) : 'x'} fixture=${fs.existsSync(FIXTURE) ? fs.statSync(FIXTURE).size : 'x'}`);
}

function turnCount() {
  const ledger = readLedger();
  return ledger ? ledger.turns.length : 0;
}

// ---------------------------------------------------------------- 准备

fs.mkdirSync(SCRATCH, { recursive: true });
fs.rmSync(LEDGER, { force: true });
fs.rmSync(STATE, { force: true });
fs.rmSync(FIXTURE, { force: true });

// 先写一个「装 hook 之前」的历史轮次，用于验证基线机制
fs.writeFileSync(FIXTURE, `${assistantEntry({
  callId: 'call-historic', model: 'deepseek-flash', ts: PEAK_MS - 3600_000,
  input: 1000000, output: 1000000, cacheRead: 0,
})}\n`, 'utf8');

const payload = { session_id: 'selftest-session', transcript_path: FIXTURE, cwd: 'D:\\hooktest' };

let blocked = false;

console.log('\n[1] hook 基本契约');

await check('第一次运行只建立基线，不记账', () => {
  try {
    const r = runHook(payload);
    eq(r.status, 0, '退出码 ');
    eq(r.stdout, '', 'stdout 必须为空 ');
  } catch (err) {
    if (err?.env) blocked = true;
    throw err;
  }
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert(Number.isFinite(state.offset), 'state 里没有 offset');
  eq(state.offset, fs.statSync(FIXTURE).size, '基线 offset 应等于当前文件长度 ');
  eq(turnCount(), 0, '首次运行不应记账，turns ');
  return `基线 offset=${state.offset}`;
});

await check('第二次运行：历史轮次被基线挡住，仍为 0', () => {
  const r = runHook(payload);
  eq(r.status, 0, '退出码 ');
  eq(turnCount(), 0, '历史轮次不该被计入，turns ');
  return '基线有效';
});

console.log('\n[2] 记账正确性');
diag('进入 [2]');

await check('新增一轮（同 callId 两条记录）只算一次', () => {
  const callId = 'call-1';
  fs.appendFileSync(FIXTURE, `${assistantEntry({
    callId, model: 'deepseek-flash', ts: PEAK_MS, input: 1000000, output: 1000000, cacheRead: 400000,
  })}\n${assistantEntry({
    callId, model: 'deepseek-flash', ts: PEAK_MS, input: 1000000, output: 1000000, cacheRead: 400000,
  })}\n`, 'utf8');

  const r = runHook(payload);
  eq(r.status, 0, '退出码 ');
  eq(turnCount(), 1, '去重后应为 1 轮，实际 ');

  const ledger = readLedger();
  const turn = ledger.turns[0];
  assert(turn.source === 'hook', `source 应为 hook，实际 ${turn.source}`);
  eq(turn.peak, true, '应为高峰价 ');
  // 400000×0.003 + 600000×0.15 + 1000000×0.6 = 0.0012 + 0.09 + 0.6 = 0.6912 USD
  const cost = BigInt(turn.cost);
  const expected = 69120000n; // 0.6912 × 1e8
  assert(cost === expected, `金额应为 0.6912 USD（${expected}），实际 ${turn.cost}（${Number(cost) / 1e8}）`);
  diag('用例 A 结束');
  return `${Number(cost) / 1e8} USD`;
});

await check('再跑一次同一份 transcript：增量生效，不重复计费', () => {
  diag('用例 B 开始前');
  const r = runHook(payload, { WHALE_BALANCE_HOOK_DEBUG: '1' });
  diag('用例 B 跑完 hook');
  console.log(`      · hook.log:\n${(fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '(无)').split('\n').filter(Boolean).map((l) => `          ${l}`).join('\n')}`);
  eq(r.status, 0, '退出码 ');
  eq(turnCount(), 1, '不应重复记账，turns ');
  return '增量读取有效';
});

await check('新增一轮谷价：按事件时间戳判峰谷，不按运行时间', () => {
  fs.appendFileSync(FIXTURE, `${assistantEntry({
    callId: 'call-2', model: 'deepseek-v4-pro', ts: VALLEY_MS, input: 1000000, output: 1000000, cacheRead: 0,
  })}\n`, 'utf8');

  const r = runHook(payload);
  eq(r.status, 0, '退出码 ');
  eq(turnCount(), 2, 'turns ');

  const turn = readLedger().turns[1];
  eq(turn.peak, false, '应为谷价 ');
  eq(turn.priceKey, 'deepseek-v4-pro', 'priceKey ');
  // 谷价：命中 0.011 / 未命中 0.33 / 输出 0.99
  // 1e6 × 0.33 + 1e6 × 0.99 = 1.32 USD
  const cost = BigInt(turn.cost);
  assert(cost === 132000000n, `谷价金额应为 1.32 USD，实际 ${Number(cost) / 1e8}`);
  return `${Number(cost) / 1e8} USD（v4-pro 谷价）`;
});

await check('按日汇总累加到同一天', () => {
  const ledger = readLedger();
  const day = '2026-10-01';
  const rec = ledger.daily[day];
  assert(rec, `daily 里没有 ${day}`);
  const total = BigInt(rec.turnCost);
  // 0.6912 + 1.32 = 2.0112
  assert(total === 201120000n, `当日合计应为 2.0112，实际 ${Number(total) / 1e8}`);
  eq(rec.turnCount, 2, '当日轮数 ');
  return `${Number(total) / 1e8} USD / 2 轮`;
});

console.log('\n[3] 健壮性');

await check('未知模型不会阻断，该轮跳过而其余照记', () => {
  fs.appendFileSync(FIXTURE, `${assistantEntry({
    callId: 'call-3', model: 'totally-unknown-model', ts: PEAK_MS, input: 10, output: 10, cacheRead: 0,
  })}\n`, 'utf8');
  const r = runHook(payload);
  eq(r.status, 0, '退出码 ');
  // fallback 存在，所以其实会记上；这一条是确认它走 fallback 而不是崩掉
  eq(turnCount(), 3, 'turns ');
  const turn = readLedger().turns[2];
  eq(turn.priceKey, 'fallback(totally-unknown-model)', 'priceKey ');
  return '走 fallback 计价';
});

await check('payload 是垃圾时静默退出、退出码 0、stdout 干净', () => {
  const result = spawnSync(APP_EXE, [HOOK], {
    input: '这不是 JSON{{{',
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert(!result.error, `子进程起不来：${result.error?.message}`);
  eq(result.status, 0, '退出码 ');
  eq(result.stdout, '', 'stdout ');
  return '静默 + 0';
});

await check('payload 为空时同样静默', () => {
  const result = spawnSync(APP_EXE, [HOOK], {
    input: '',
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert(!result.error, `子进程起不来：${result.error?.message}`);
  eq(result.status, 0, '退出码 ');
  eq(result.stdout, '', 'stdout ');
  return '静默 + 0';
});

await check('transcript 路径不存在时不崩', () => {
  const r = runHook({ session_id: 'nope', transcript_path: path.join(SCRATCH, 'does-not-exist.jsonl') });
  eq(r.status, 0, '退出码 ');
  eq(r.stdout, '', 'stdout ');
  return '静默 + 0';
});

await check('偏移比文件大一点点时，不从零重放（\\r\\n 差异回归）', () => {
  const before = turnCount();
  const size = fs.statSync(FIXTURE).size;
  // 模拟"记录偏移比实际字节数多几个字节"这个真实场景（\r\n 与 \n 的差异）
  fs.writeFileSync(STATE, JSON.stringify({
    installTs: Date.now(), transcript: FIXTURE, offset: size + 1,
  }), 'utf8');
  const r = runHook(payload);
  eq(r.status, 0, '退出码 ');
  eq(r.stdout, '', 'stdout ');
  const added = turnCount() - before;
  eq(added, 0, `比文件大 1 字节时不该重放任何轮次，实际新增 `);
  return '容忍并跳过，未重放';
});

await check('debug 模式下诊断信息进日志文件而不是 stdout', () => {
  fs.appendFileSync(FIXTURE, `${assistantEntry({
    callId: 'call-4', model: 'deepseek-flash', ts: VALLEY_MS, input: 1000, output: 1000, cacheRead: 0,
  })}\n`, 'utf8');
  const r = runHook(payload, { WHALE_BALANCE_HOOK_DEBUG: '1' });
  eq(r.status, 0, '退出码 ');
  eq(r.stdout, '', 'stdout 必须仍然干净 ');
  assert(fs.existsSync(LOG), 'debug 模式下应生成 hook.log');
  const log = fs.readFileSync(LOG, 'utf8');
  assert(/记账 [1-9]\d* 轮/.test(log), `日志里没有记账摘要：${log.slice(0, 400)}`);
  return `日志落到 hook.log：${log.split('\n').filter(Boolean).pop()?.slice(0, 70)}`;
});

/**
 * 上游若不关 stdin，hook 必须自己收工。
 * 反例（本插件踩过）：fs.readFileSync(0) / readSync(0) 会永久阻塞在系统调用里，
 * 定时器救不回来 —— 那样每一轮对话都要卡到超时。
 */
async function hookWithOpenStdin() {
  return new Promise((resolve, reject) => {
    const child = spawn(APP_EXE, [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    // 故意不关 stdin：write 之后把 pipe 留在打开状态
    child.stdin.write('{"session_id":"open-stdin","cwd":"D:\\\\hooktest"}');
    const started = Date.now();
    const killer = setTimeout(() => {
      child.kill();
      reject(new Error(`stdin 未关闭时 hook 没在 15s 内收工（看门狗失效）`));
    }, 15000);
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, ms: Date.now() - started });
    });
  });
}

console.log('\n[4] 并发安全');

// 复刻真实踩到的那次：两个进程同时读同一个 offset、各写一遍账本 → 同一轮记两次。
await check('4 个 hook 同时跑，同一轮只被记一次', async () => {
  fs.appendFileSync(FIXTURE, `${assistantEntry({
    callId: 'call-concurrent', model: 'deepseek-flash', ts: PEAK_MS, input: 1000000, output: 0, cacheRead: 0,
  })}\n`, 'utf8');

  const before = turnCount();
  const runs = await Promise.all([0, 1, 2, 3].map(() => new Promise((resolve, reject) => {
    const child = spawn(APP_EXE, [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  })));

  for (const run of runs) {
    eq(run.code, 0, '退出码 ');
    eq(run.out, '', 'stdout ');
  }
  const added = turnCount() - before;
  eq(added, 1, `并发 4 个进程应只新增 1 轮，实际新增 `);
  return `4 并发 → +${added} 轮`;
});

console.log('\n[5] 上游不关 stdin 时的自保');

await check('stdin 一直开着时，hook 自己在看门狗到期后收工', async () => {
  try {
    const result = await hookWithOpenStdin();
    eq(result.code, 0, '退出码 ');
    eq(result.stdout, '', 'stdout ');
    assert(result.ms < 12000, `耗时 ${result.ms}ms，看门狗似乎没生效`);
    return `${result.ms}ms 收工`;
  } catch (err) {
    if (/EPERM/.test(err?.message ?? '')) { blocked = true; return '沙箱禁止子进程，跳过'; }
    throw err;
  }
});

console.log('\n[6] 稳健性（续）');

await check('账本损坏时拒绝写入、且不阻断对话', () => {
  const backup = fs.readFileSync(LEDGER, 'utf8');
  fs.writeFileSync(LEDGER, '{ 这不是合法 JSON', 'utf8');
  fs.appendFileSync(FIXTURE, `${assistantEntry({
    callId: 'call-5', model: 'deepseek-flash', ts: VALLEY_MS, input: 1000, output: 1000, cacheRead: 0,
  })}\n`, 'utf8');
  const r = runHook(payload);
  eq(r.status, 0, '退出码 ');
  eq(r.stdout, '', 'stdout ');
  const after = fs.readFileSync(LEDGER, 'utf8');
  eq(after, '{ 这不是合法 JSON', '损坏的账本被覆盖了 —— 这正是要避免的 ');
  fs.writeFileSync(LEDGER, backup, 'utf8');
  return '拒绝覆盖损坏账本';
});

// ---------------------------------------------------------------- 生产账本未被触碰

await check('★ 生产账本从头到尾一字未改', () => {
  assert(LEDGER !== PROD_LEDGER, 'LEDGER 指到了生产账本');
  const now = fs.existsSync(PROD_LEDGER) ? sha256(fs.readFileSync(PROD_LEDGER)) : null;
  if (now !== PROD_LEDGER_HASH) {
    throw new Error(`生产账本被改动了！before=${String(PROD_LEDGER_HASH).slice(0, 16)} after=${String(now).slice(0, 16)}`);
  }
  if (!now) return '(生产账本不存在，未创建)';
  return `sha256 ${now.slice(0, 16)} 未变`;
});

// ---------------------------------------------------------------- 汇总

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.rmSync(STATE, { force: true });
fs.rmSync(LEDGER, { force: true });
fs.rmSync(`${LEDGER}.lock`, { force: true });

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  if (blocked) {
    console.log('\n⚠ 有子进程 EPERM —— 受限沙箱禁止 piped stdio，请在普通终端重跑。');
    process.exit(2);
  }
  process.exit(1);
}
console.log('全部通过。');
process.exit(0);
