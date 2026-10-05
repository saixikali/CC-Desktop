/**
 * whale-balance 自检：不联网、不需要 API key。
 *
 * 用法（必须用能起子进程的普通终端跑，受限沙箱会 EPERM + 退出码 2）：
 *   node test-plugin.mjs            # 全部
 *   node test-plugin.mjs --no-mcp   # 只跑记账内核与清单校验（不需要子进程）
 * 退出码：0 全部通过 / 1 有断言失败 / 2 环境不支持（子进程起不来，例如受限沙箱）
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARGS = process.argv.slice(2);
const SKIP_MCP = ARGS.includes('--no-mcp');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(HERE, '..', '..');
const APP_EXE = path.join(INSTALL_ROOT, 'CC Desktop.exe');
const SERVER = path.join(HERE, 'server.mjs');

// 自检绝不碰生产账本：把账本重定向到一个临时文件（server 子进程通过继承的
// 环境变量看到同一个路径）。以前这里直接读写 plugins-state.whale-balance.json，
// 结果每跑一次自检就往真实用量统计里灌一条"selftest"假账。
const TEST_LEDGER = path.join(os.tmpdir(), `whale-balance-selftest-${process.pid}.json`);
process.env.WHALE_BALANCE_LEDGER = TEST_LEDGER;
fs.rmSync(TEST_LEDGER, { force: true }); // 从空账本开始
const cleanupLedger = () => {
  for (const f of [TEST_LEDGER, `${TEST_LEDGER}.lock`]) fs.rmSync(f, { force: true });
};

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ''}`);
  } catch (err) {
    failures.push(`${name}: ${err?.message ?? String(err)}`);
    console.log(`  ✗ ${name}  → ${err?.message ?? String(err)}`);
  }
}

function eq(actual, expected, label = '') {
  const a = String(actual);
  const e = String(expected);
  if (a !== e) throw new Error(`${label}期望 ${e}，实际 ${a}`);
  return a;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ------------------------------------------------------------ 1. 记账内核

console.log('\n[1] 记账内核 accounting.mjs');
const A = await import('./accounting.mjs');

const one = A.FIXED_SCALE;
check('parseMoney 字符串整数', () => eq(A.parseMoney('12'), (12n * one).toString(), ''));
check('parseMoney 字符串小数', () => eq(A.parseMoney('0.15'), (one * 15n / 100n).toString(), ''));
check('parseMoney 8 位小数', () => eq(A.parseMoney('0.00000001'), '1', ''));
check('parseMoney 拒绝空串', () => {
  try { A.parseMoney(''); } catch { return '按预期抛错'; }
  throw new Error('应当抛错但没有');
});
check('parseMoney 拒绝非数字', () => {
  try { A.parseMoney('abc'); } catch { return '按预期抛错'; }
  throw new Error('应当抛错但没有');
});
check('0.1 + 0.2 精确等于 0.3（浮点陷阱）', () =>
  eq(A.formatMoney(A.addMoney(A.parseMoney('0.1'), A.parseMoney('0.2')), 4), '0.3000'));
check('formatMoney 四舍五入进位', () =>
  eq(A.formatMoney(A.parseMoney('0.99999'), 4), '1.0000'));
check('formatMoney 截断到 2 位', () =>
  eq(A.formatMoney(A.parseMoney('1.239'), 2), '1.24'));
check('formatMoney 负数', () =>
  eq(A.formatMoney(A.parseMoney('-3.5'), 2), '-3.50'));
check('costOfTokens 100 万 token × 0.15 = 0.15', () =>
  eq(A.formatMoney(A.costOfTokens(1_000_000, 0.15), 8), '0.15000000'));
check('costOfTokens 1000 万 token × 0.6 = 6', () =>
  eq(A.formatMoney(A.costOfTokens(10_000_000, 0.6), 8), '6.00000000'));
check('costOfTokens 0 token = 0', () => eq(A.costOfTokens(0, 1), '0'));

const pricing = A.makePricing(JSON.parse(fs.readFileSync(path.join(HERE, 'pricing.json'), 'utf8')));

// 用固定时刻断言峰谷，避免依赖运行时间
const peakTime = Date.UTC(2026, 9, 1, 2, 0);    // 周四 UTC 02:00 = 北京 10:00 → 高峰
const valleyTime = Date.UTC(2026, 9, 1, 8, 0);  // 周四 UTC 08:00 = 北京 16:00 → 高峰（14–18）
const nightTime = Date.UTC(2026, 9, 1, 15, 0);  // 周四 UTC 15:00 = 北京 23:00 → 谷
const weekend = Date.UTC(2026, 9, 3, 2, 0);     // 周六 UTC 02:00 = 北京 10:00 → 谷

check('isPeak 工作日北京 10:00 = 高峰', () => eq(A.isPeak(peakTime), true));
check('isPeak 工作日北京 16:00 = 高峰', () => eq(A.isPeak(valleyTime), true));
check('isPeak 工作日北京 23:00 = 谷', () => eq(A.isPeak(nightTime), false));
check('isPeak 周六北京 10:00 = 谷', () => eq(A.isPeak(weekend), false));

check('峰价取高峰单价（flash 未命中 0.15）', () => eq(pricing.priceFor('deepseek-flash', peakTime).cacheMiss, '0.15'));
check('谷价 = 高峰 × 0.5（flash 未命中 0.075）', () => eq(pricing.priceFor('deepseek-flash', nightTime).cacheMiss, '0.075'));
check('v4-pro 峰价未命中 0.66', () => eq(pricing.priceFor('deepseek-v4-pro', peakTime).cacheMiss, '0.66'));
check('旧模型名别名落到同一价目', () => eq(pricing.priceFor('deepseek-v4-flash', peakTime).modelKey, 'deepseek-flash'));
check('未知模型走 fallback', () => eq(pricing.priceFor('some-unknown-model', peakTime).cacheMiss, '0.66'));

check('costOfTurn：缓存命中/未命中/输出三分账', () => {
  const price = pricing.priceFor('deepseek-flash', peakTime);
  const { total, breakdown } = A.costOfTurn({
    input_tokens: 1000000,
    output_tokens: 1000000,
    cache_read_input_tokens: 400000,
  }, price);
  eq(breakdown.cacheHitTokens, 400000, 'cacheHitTokens ');
  eq(breakdown.cacheMissTokens, 600000, 'cacheMissTokens ');
  // 400000×0.003/1e6 + 600000×0.15/1e6 + 1000000×0.6/1e6 = 0.0012 + 0.09 + 0.6 = 0.6912
  eq(A.formatMoney(total, 8), '0.69120000');
  return `合计 ${A.formatMoney(total, 6)}`;
});

// ------------------------------------------------------------ 1.5 凭据解析

console.log('\n[1.5] 凭据解析 credentials.mjs');
const C = await import('./credentials.mjs');

check('base_url 指向 deepseek 时复用 ANTHROPIC_AUTH_TOKEN', () => {
  const r = C.anthropicKeyForDeepSeek({
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-real-deepseek-key',
  });
  assert(r && r.key === 'sk-real-deepseek-key', `期望取到 key，实际 ${JSON.stringify(r)}`);
  assert(/ANTHROPIC_AUTH_TOKEN/.test(r.source), 'source 应当指明来自哪个变量');
  return r.source;
});

check('base_url 是裸域名（无 /anthropic 后缀）也认', () => {
  const r = C.anthropicKeyForDeepSeek({
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com',
    ANTHROPIC_AUTH_TOKEN: 'sk-x',
  });
  assert(r?.key === 'sk-x', '裸域名应当也认');
  return 'ok';
});

// ★ 守卫回归：这条要是挂了，换回真 Anthropic 就会把 Anthropic 的 key 发给 DeepSeek
check('★ 守卫：base_url 不是 deepseek 时绝不复用', () => {
  const r = C.anthropicKeyForDeepSeek({
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-real-anthropic-key',
  });
  assert(r === null, `不该复用却复用了：${JSON.stringify(r)}`);
  return '已拒绝';
});

check('★ 守卫：base_url 缺失时绝不复用', () => {
  assert(C.anthropicKeyForDeepSeek({ ANTHROPIC_AUTH_TOKEN: 'sk-x' }) === null, 'base_url 缺失却复用了');
  return '已拒绝';
});

check('deepseek 但两个变量都没有 → null', () => {
  assert(C.anthropicKeyForDeepSeek({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com' }) === null, '不该有 key');
  return 'null';
});

check('空白 / 非字符串 token 不当成 key（不拿空 key 发请求）', () => {
  const base = 'https://api.deepseek.com';
  assert(C.anthropicKeyForDeepSeek({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: '   ' }) === null, '空白串被当成了 key');
  assert(C.anthropicKeyForDeepSeek({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 12345 }) === null, '非字符串被当成了 key');
  return '已过滤';
});

check('只设 ANTHROPIC_API_KEY（无 AUTH_TOKEN）也认', () => {
  const r = C.anthropicKeyForDeepSeek({
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_API_KEY: 'sk-via-api-key',
  });
  assert(r?.key === 'sk-via-api-key', '应当回落到 ANTHROPIC_API_KEY');
  return 'ok';
});

check('AUTH_TOKEN 优先于 API_KEY', () => {
  const r = C.anthropicKeyForDeepSeek({
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com',
    ANTHROPIC_AUTH_TOKEN: 'sk-first',
    ANTHROPIC_API_KEY: 'sk-second',
  });
  assert(r?.key === 'sk-first', `期望 sk-first，实际 ${r?.key}`);
  return 'ok';
});

check('key 两端空白被裁掉', () => {
  const r = C.anthropicKeyForDeepSeek({
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com',
    ANTHROPIC_AUTH_TOKEN: '  sk-padded  ',
  });
  assert(r?.key === 'sk-padded', `期望裁掉空白，实际 ${JSON.stringify(r?.key)}`);
  return 'ok';
});

check('入参不是对象时不炸（防御）', () => {
  assert(C.anthropicKeyForDeepSeek(null) === null, 'null 应当返回 null');
  assert(C.anthropicKeyForDeepSeek(undefined) === null, 'undefined 应当返回 null');
  return 'ok';
});

// ------------------------------------------------------------ 2. 插件清单

console.log('\n[2] plugin.json 校验（按 PluginService 的规则复刻）');
const manifestPath = path.join(HERE, 'plugin.json');
let manifest = null;
check('plugin.json 可解析', () => {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), '不是对象');
  return `${manifest.name} v${manifest.version}`;
});
check('文件夹名符合 PLUGIN_ID_RE（^[@a-zA-Z0-9._-]{1,120}$）', () => {
  const folder = path.basename(HERE);
  assert(/^[@a-zA-Z0-9._-]{1,120}$/.test(folder), `文件夹名不合法：${folder}`);
  return folder;
});
check('mcp 段通过 validMcp 校验', () => {
  const mcp = manifest.mcp;
  assert(mcp && typeof mcp === 'object' && !Array.isArray(mcp), 'mcp 不是对象');
  for (const [name, cfg] of Object.entries(mcp)) {
    assert(cfg && typeof cfg === 'object', `${name} 不是对象`);
    assert(cfg.type === undefined || cfg.type === 'stdio', `${name}.type 必须是 stdio 或省略`);
    assert(typeof cfg.command === 'string' && cfg.command.length > 0, `${name}.command 必须是非空字符串`);
  }
  return Object.keys(mcp).join(', ');
});
check('placeholder 替换后命令与脚本都真实存在', () => {
  const dir = HERE;
  const subst = (v) => (typeof v === 'string' ? v.split('${PLUGIN_DIR}').join(dir) : v);
  const cfg = Object.values(manifest.mcp)[0];
  const command = subst(cfg.command);
  const args = (cfg.args ?? []).map(subst);
  assert(fs.existsSync(command), `命令不存在：${command}`);
  assert(fs.existsSync(args[0]), `脚本不存在：${args[0]}`);
  assert(path.resolve(command).toLowerCase() === path.resolve(APP_EXE).toLowerCase(), `命令不是应用本体：${command}`);
  return path.basename(command);
});
check('priceing.json 可解析且含 offPeakRatio', () => {
  const p = JSON.parse(fs.readFileSync(path.join(HERE, 'pricing.json'), 'utf8'));
  assert(typeof p.offPeakRatio === 'number', '缺 offPeakRatio');
  assert(p.models && Object.keys(p.models).length > 0, '没有模型');
  return `${Object.keys(p.models).length} 个模型 · 谷价系数 ${p.offPeakRatio}`;
});

// ------------------------------------------------------------ 3. MCP 握手

console.log('\n[3] MCP stdio 协议（真实拉起进程）');

let mcpBlocked = false;
let handshake = null; // 模块作用域：spawnGuard 的闭包里也要能引用（放块里会 TDZ）

function mcpSession(lines, { timeout = 25000 } = {}) {
  const input = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  const result = spawnSync(APP_EXE, [SERVER], {
    input,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DEEPSEEK_API_KEY: 'sk-definitely-not-a-real-key' },
  });
  if (result.error) {
    const err = new Error(`无法启动子进程：${result.error.message}`);
    err.env = result.error.code === 'EPERM';
    throw err;
  }
  const out = (result.stdout ?? '').split('\n').filter(Boolean);
  const messages = [];
  for (const line of out) {
    try { messages.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
  }
  return { messages, stderr: result.stderr ?? '', status: result.status };
}

if (SKIP_MCP) console.log('  ⤳ 已按 --no-mcp 跳过（这些用例需要起子进程）');

// 子进程起不来时，把「环境不支持」和「断言失败」区分开 —— 后者是自己代码的问题，前者不是。
function spawnGuard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err?.env) mcpBlocked = true;
    throw err;
  }
}

check('initialize / tools/list / tools/call 全链路', () => {
  handshake = spawnGuard(() => mcpSession([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_usage', arguments: { days: 7 } } },
  ]));

  const init = handshake.messages.find((m) => m.id === 1);
  assert(init?.result?.serverInfo?.name === 'whale-balance', `initialize 响应异常：${JSON.stringify(init)}`);

  const list = handshake.messages.find((m) => m.id === 2);
  const names = (list?.result?.tools ?? []).map((t) => t.name);
  assert(names.length === 3, `工具数应为 3，实际 ${names.length}`);
  for (const want of ['get_balance', 'get_usage', 'report_usage']) {
    assert(names.includes(want), `缺工具 ${want}`);
  }

  const usage = handshake.messages.find((m) => m.id === 3);
  assert(usage?.result?.content?.[0]?.type === 'text', `get_usage 响应异常：${JSON.stringify(usage)}`);
  assert(usage.result.isError === false, 'get_usage 不应是错误');
  return `工具：${names.join(', ')}`;
});

check('get_balance 用假 key 时优雅报错、不返回半截数据', () => {
  const session = spawnGuard(() => mcpSession([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_balance', arguments: {} } },
  ]));
  const res = session.messages.find((m) => m.id === 2);
  assert(res?.result, `没有拿到响应：${JSON.stringify(session.messages)}`);
  assert(res.result.isError === true, '假 key 应当报告为错误');
  const text = res.result.content[0].text;
  assert(/40[13]|无效|失败|超时/.test(text), `错误文案不像鉴权失败：${text.slice(0, 200)}`);
  return text.split('\n')[0].slice(0, 80);
});

check('未知工具返回 isError 而不是崩掉', () => {
  const session = spawnGuard(() => mcpSession([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } },
  ]));
  const res = session.messages.find((m) => m.id === 1);
  assert(res?.result?.isError === true, '应当返回 isError');
  return '已返回错误内容';
});

check('未知方法返回 -32601（JSON-RPC 规范）', () => {
  const session = spawnGuard(() => mcpSession([{ jsonrpc: '2.0', id: 9, method: 'bogus/method' }]));
  const res = session.messages.find((m) => m.id === 9);
  assert(res?.error?.code === -32601, `期望 -32601，实际 ${JSON.stringify(res)}`);
  return '-32601';
});

check('report_usage 记一轮并写账本', () => {
  const ledgerPath = TEST_LEDGER; // 临时账本，不是生产账本
  const before = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : null;
  const session = spawnGuard(() => mcpSession([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_usage', arguments: { model: 'deepseek-flash', input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 400000, note: 'selftest' } } },
  ]));
  const res = session.messages.find((m) => m.id === 1);
  assert(res?.result?.isError === false, `report_usage 报错：${JSON.stringify(res?.result?.content?.[0]?.text)}`);
  const text = res.result.content[0].text;
  assert(/本轮估算/.test(text), '输出里没有金额');
  const after = fs.readFileSync(ledgerPath, 'utf8');
  assert(after !== before, '账本没有被更新');
  const ledger = JSON.parse(after);
  assert(ledger.turns.length > 0, '账本里没有 turns');
  return text.split('\n')[0].slice(0, 80);
});

// ------------------------------------------------------------ 4. 自检自身的安全约束

console.log('\n[4] 自检不得污染生产账本');
check('★ 账本已重定向到临时文件（不是生产账本）', () => {
  const prod = path.join(INSTALL_ROOT, 'plugins-state.whale-balance.json');
  assert(TEST_LEDGER !== prod, 'TEST_LEDGER 指到了生产账本');
  assert(process.env.WHALE_BALANCE_LEDGER === TEST_LEDGER, 'WHALE_BALANCE_LEDGER 没指向 TEST_LEDGER，子进程会写到生产账本去');
  return path.basename(TEST_LEDGER);
});

cleanupLedger();

// ------------------------------------------------------------ 汇总

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  if (mcpBlocked) {
    console.log('\n⚠ 其中至少一项是「子进程起不来（EPERM）」—— 受限沙箱禁止 piped stdio，这是环境问题不是代码问题。');
    console.log('  请在普通终端里重跑：node test-plugin.mjs');
    process.exit(2);
  }
  process.exit(1);
}
console.log('全部通过。');
process.exit(0);
