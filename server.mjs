/**
 * whale-balance — CC Desktop 插件（MCP stdio server）
 *
 * 把 DeepSeek 余额与用量记账暴露成 MCP 工具，供 CC Desktop 里的 Claude 调用。
 *
 * 运行方式由 plugin.json 声明：
 *   command = <安装目录>\CC Desktop.exe   （用应用自带的 Node 24 跑，不依赖系统 PATH）
 *   env.ELECTRON_RUN_AS_NODE = 1
 *   args    = [<本文件>]
 *
 * 账本读写与计价全部走 ledger.mjs / accounting.mjs —— 与 Stop hook 共用同一套口径，
 * 绝不在两处各写一份对同一件事的解释。
 *
 * 本文件零依赖，只用 Node 内置模块。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseMoney, formatMoney, beijingDay, dayOffset } from './accounting.mjs';
import {
  HERE, INSTALL_ROOT, LEDGER_PATH, readJsonSafe,
  loadLedger, saveLedger, dailyOf, ledgerWindow, recordTurn, observeInto,
} from './ledger.mjs';
import { anthropicKeyForDeepSeek } from './credentials.mjs';

const PRICING_PATH = path.join(HERE, 'pricing.json');

const API_BASE = 'https://api.deepseek.com';
const BALANCE_URL = `${API_BASE}/user/balance`;
const HTTP_TIMEOUT_MS = 20000;

// ------------------------------------------------------------------ 基础工具

function log(...args) {
  // stdout 是 JSON-RPC 通道，任何日志一律走 stderr
  process.stderr.write(`[whale-balance] ${args.join(' ')}\n`);
}

function fail(message) {
  const error = new Error(message);
  error.whale = true;
  return error;
}

// ------------------------------------------------------------------ 凭据

/**
 * 找 DEEPSEEK_API_KEY。顺序：
 *  1. 环境变量 DEEPSEEK_API_KEY（CC Desktop 启动时继承的）
 *  2. 复用宿主注入的 Anthropic 凭据 —— 仅当 ANTHROPIC_BASE_URL 指向 deepseek 时
 *     （见 credentials.mjs 的守卫说明）
 *  3. <安装目录>\data\settings.json —— 递归搜 env 段里的同名键
 *  4. 插件目录下的 key.txt（文件里只有 key 一行）
 * 找不到就明确报错并告诉用户四条出路，绝不用空 key 发请求。
 */
function resolveApiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return { key: fromEnv.trim(), source: '环境变量 DEEPSEEK_API_KEY' };

  // 宿主把 Claude 指向 DeepSeek 时，它注入的 ANTHROPIC_AUTH_TOKEN 就是 DeepSeek 的 key。
  // 判定（含"只在 base_url 指向 deepseek 时才复用"的守卫）在 credentials.mjs 里，可被自检覆盖。
  const fromAnthropic = anthropicKeyForDeepSeek(process.env);
  if (fromAnthropic) return fromAnthropic;

  const settingsPath = path.join(INSTALL_ROOT, 'data', 'settings.json');
  const settings = readJsonSafe(settingsPath);
  const found = settings ? deepFind(settings, 'DEEPSEEK_API_KEY') : null;
  if (typeof found === 'string' && found.trim()) return { key: found.trim(), source: `${settingsPath} 的 env 段` };

  const keyFile = path.join(HERE, 'key.txt');
  try {
    const text = fs.readFileSync(keyFile, 'utf8').trim();
    if (text) return { key: text, source: keyFile };
  } catch { /* 没有这个文件 */ }

  throw fail(
    '没有找到 DEEPSEEK_API_KEY。四种配置方式任选一种：\n' +
    '  1) 在 CC Desktop 启动前设置环境变量 DEEPSEEK_API_KEY\n' +
    '  2) 让 ANTHROPIC_BASE_URL 指向 deepseek，并设置 ANTHROPIC_AUTH_TOKEN —— 插件会直接复用它\n' +
    `  3) 在 ${settingsPath} 里加上 "env": { "DEEPSEEK_API_KEY": "sk-..." }\n` +
    `  4) 把 key 单独写进 ${keyFile}（文件里只有 key 一行）\n` +
    '注意：本插件只把 key 发往 https://api.deepseek.com，不做任何转发。',
  );
}

function deepFind(node, key, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = deepFind(value, key, depth + 1);
      if (hit !== null && hit !== undefined) return hit;
    }
  }
  return null;
}

// ------------------------------------------------------------------ 余额

async function fetchBalance(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw fail(`请求 ${BALANCE_URL} 超时（${HTTP_TIMEOUT_MS / 1000}s）`);
    throw fail(`请求 ${BALANCE_URL} 失败：${err?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw fail(`余额接口返回 ${res.status}：API key 无效或无权访问（${BALANCE_URL}）`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw fail(`余额接口返回 ${res.status}：${text.slice(0, 300)}`);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw fail(`余额接口返回的不是 JSON：${err?.message ?? String(err)}`);
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.balance_infos)) {
    throw fail(`余额接口响应形状异常，缺少 balance_infos 数组：${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

// ------------------------------------------------------------------ 工具实现

async function toolGetBalance() {
  const { key, source } = resolveApiKey();
  const body = await fetchBalance(key);
  const ts = Date.now();

  const infos = body.balance_infos;
  const cny = infos.find((i) => i?.currency === 'CNY') ?? infos[0];
  if (!cny || typeof cny.total_balance !== 'string') {
    throw fail(`余额响应里没有可用的 balance_infos 项：${JSON.stringify(infos).slice(0, 300)}`);
  }

  const ledger = loadLedger();
  const { record, delta, kind, previous } = observeInto(ledger, {
    ts,
    currency: cny.currency,
    totalFixed: parseMoney(cny.total_balance, 'total_balance'),
    grantedFixed: cny.granted_balance == null ? null : parseMoney(cny.granted_balance, 'granted_balance'),
    toppedUpFixed: cny.topped_up_balance == null ? null : parseMoney(cny.topped_up_balance, 'topped_up_balance'),
  });
  saveLedger(ledger);

  const lines = [
    `DeepSeek 余额：${formatMoney(BigInt(record.total), 2)} ${record.currency}`,
    `  赠金 ${record.granted == null ? '—' : formatMoney(BigInt(record.granted), 2)} · 充值 ${record.toppedUp == null ? '—' : formatMoney(BigInt(record.toppedUp), 2)}`,
    `  账户可用：${body.is_available === false ? '余额不足，API 调用可能被拒' : '正常'}`,
  ];

  if (kind === 'spend') {
    lines.push(`  较上次观测（${new Date(previous.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）：消费 ${formatMoney(-delta, 4)}`);
  } else if (kind === 'topup') {
    lines.push(`  较上次观测：余额上升 ${formatMoney(delta, 4)}（充值/赠金，未计入消费）`);
  } else if (kind === 'first') {
    lines.push('  这是本账本的第一次观测，消费统计从此刻起算（此前的消费不在区间内）');
  } else if (kind === 'currency-changed') {
    lines.push('  币种与上次不同，已在账本中另起一条序列');
  }

  const today = beijingDay(ts);
  const rec = dailyOf(ledger, today);
  lines.push(
    '',
    `今日（${today}，北京日）已观测消费：${formatMoney(rec.observedSpend, 4)} ${record.currency}`,
    '  记账方式：按余额下降累计（观测口径）。观测越频繁越准 —— 每次调用本工具都会记录一次观测。',
    `  key 来源：${source}`,
    '注意：余额下降只反映账户扣减，无法区分是哪个模型/会话花的；逐轮模型口径见 get_usage。',
  );

  return lines.join('\n');
}

async function toolReportUsage(args) {
  const ledger = loadLedger();
  const ts = Date.now();
  const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : 'unknown';
  const usage = args.usage ?? args;

  const { total, price, breakdown, day } = recordTurn(ledger, {
    model,
    usage,
    ts,
    source: 'mcp-tool',
    extra: typeof args.note === 'string' && args.note.trim() ? { note: args.note.trim().slice(0, 200) } : undefined,
  });
  saveLedger(ledger);

  const rec = dailyOf(ledger, day);
  const window7 = ledgerWindow(ledger, dayOffset(day, -6), day);

  return [
    `本轮估算：${formatMoney(total, 4)} ${price.currency}（${model} · ${price.peak ? '高峰价' : '谷价'}${price.modelKey !== model ? ` · 按 ${price.modelKey} 计价` : ''}）`,
    `  token：缓存命中 ${breakdown.cacheHitTokens} · 命中价 ${price.cacheHit} · 小计 ${formatMoney(breakdown.cacheHitCost, 4)}`,
    `        缓存未命中 ${breakdown.cacheMissTokens} · 未命中价 ${price.cacheMiss} · 小计 ${formatMoney(breakdown.cacheMissCost, 4)}`,
    `        输出 ${breakdown.outputTokens} · 输出价 ${price.output} · 小计 ${formatMoney(breakdown.outputCost, 4)}`,
    `  单价单位：${price.currency}/百万 token；谷价为高峰价的 ${readJsonSafe(PRICING_PATH)?.offPeakRatio ?? 0.5} 倍（高峰 = 工作日北京时间 09–12 与 14–18，未含法定节假日）`,
    '',
    `今日（${day}）逐轮估算合计：${formatMoney(rec.turnCost, 4)}（${rec.turnCount} 轮）`,
    `近 7 天逐轮估算合计：${formatMoney(window7.turnCost, 4)}（${window7.turnCount} 轮）`,
    '',
    '口径提醒：这是**本机会话**按 token 的估算，与余额观测的**账户口径**不是一回事，不要相加。',
    '提示：账本里标 source=hook 的轮次由 Stop hook 自动记入，不需要手动调用本工具；手动调用只用于 hook 缺失时的补记。',
  ].join('\n');
}

async function toolGetUsage(args) {
  const ledger = loadLedger();
  const today = beijingDay();
  const days = Number.isFinite(args?.days) ? Math.max(1, Math.min(365, Math.trunc(args.days))) : 7;
  const from = dayOffset(today, -(days - 1));
  const win = ledgerWindow(ledger, from, today);

  const currencies = [...new Set(ledger.balances.map((b) => b.currency))];
  const lastBalance = ledger.balances[ledger.balances.length - 1] ?? null;
  const hookTurns = ledger.turns.filter((t) => t.source === 'hook').length;
  const manualTurns = ledger.turns.filter((t) => t.source !== 'hook').length;

  const lines = [
    `账本：${LEDGER_PATH}`,
    lastBalance
      ? `最近一次余额观测：${new Date(lastBalance.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${formatMoney(BigInt(lastBalance.total), 2)} ${lastBalance.currency}`
      : '还没有任何余额观测（调用 get_balance 会记录一次）',
    currencies.length ? `账本涉及币种：${currencies.join(', ')}` : '',
    `逐轮记录来源：hook 自动 ${hookTurns} 轮 · 手动上报 ${manualTurns} 轮`,
    '',
    `近 ${days} 天（${from} ~ ${today}）`,
    `  余额观测口径消费：${formatMoney(win.observedSpend, 4)}${lastBalance ? ` ${lastBalance.currency}` : ''}`,
    `  逐轮估算口径合计：${formatMoney(win.turnCost, 4)}（${win.turnCount} 轮）`,
    '',
    '按日明细：',
  ].filter(Boolean);

  if (win.days.length === 0) {
    lines.push('  （区间内没有记录）');
  } else {
    for (const day of win.days.slice(-31)) {
      const rec = dailyOf(ledger, day);
      lines.push(`  ${day}  观测 ${formatMoney(rec.observedSpend, 4)}  逐轮 ${formatMoney(rec.turnCost, 4)}  ${rec.turnCount} 轮`);
    }
  }

  const recentTurns = ledger.turns.slice(-10).reverse();
  if (recentTurns.length) {
    lines.push('', '最近 10 轮：');
    for (const t of recentTurns) {
      lines.push(`  ${new Date(t.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}  ${t.model}  ${formatMoney(BigInt(t.cost), 4)}  ${t.peak ? '高峰' : '谷'}  ${t.source ?? 'manual'}`);
    }
  }

  lines.push(
    '',
    '两个口径不要相加：观测口径来自 DeepSeek 账户余额变化（可信但粗糙，粒度取决于观测频率）；',
    '逐轮口径是本机按 token × 单价的估算（细但有偏差）。',
  );
  return lines.join('\n');
}

// ------------------------------------------------------------------ MCP 协议

const TOOLS = [
  {
    name: 'get_balance',
    description:
      '查询 DeepSeek 账户余额（GET /user/balance），并把这次观测记进本机账本。' +
      '返回总余额、赠金、充值额、账户可用状态；若这是第二次及以后的观测，还会给出相对上次的余额变化（下降=消费，上升=充值）。' +
      '余额下降只反映账户扣减，无法区分是哪个会话/模型花的。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolGetBalance,
  },
  {
    name: 'get_usage',
    description:
      '读本机账本：近 N 天的余额观测口径消费、逐轮估算口径合计、按日明细与最近若干轮明细。' +
      '不发起任何网络请求。适用于「我今天花了多少 / 这个月的用量」这类问题。',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', description: '回顾天数，默认 7，最大 365' } },
      additionalProperties: false,
    },
    handler: toolGetUsage,
  },
  {
    name: 'report_usage',
    description:
      '手动把一轮对话的 token 用量按官方峰谷单价折算成金额并记进账本（单价币种见 pricing.json，默认 USD）。' +
      '注意：Stop hook 已经会自动记账（账本里 source=hook），所以一般**不需要**主动调用本工具；' +
      '只在 hook 未启用或某轮漏记时用于补记。参数取自该轮 usage：input_tokens / output_tokens / ' +
      'cache_read_input_tokens / cache_creation_input_tokens，外加 model（如 deepseek-flash）。',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 id，如 deepseek-flash / deepseek-v4-pro' },
        input_tokens: { type: 'integer', description: '本轮输入 token 总数' },
        output_tokens: { type: 'integer', description: '本轮输出 token 数' },
        cache_read_input_tokens: { type: 'integer', description: '命中缓存的输入 token 数' },
        cache_creation_input_tokens: { type: 'integer', description: '写入缓存的 token 数（若有）' },
        note: { type: 'string', description: '可选备注，便于回看' },
      },
      required: ['model', 'input_tokens', 'output_tokens'],
      additionalProperties: false,
    },
    handler: toolReportUsage,
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'whale-balance', version: '1.1.0' },
        instructions:
          'DeepSeek 余额与用量记账。get_balance 查余额并记录一次观测；get_usage 读本机账本。' +
          '逐轮用量由 Stop hook 自动记账，通常不需要手动 report_usage。',
      });
      return;

    case 'notifications/initialized':
    case 'initialized':
      return; // 通知，不回

    case 'ping':
      if (isRequest) reply(id, {});
      return;

    case 'tools/list':
      reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;

    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        reply(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true });
        return;
      }
      try {
        const text = await tool.handler(params?.arguments ?? {});
        reply(id, { content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        reply(id, {
          content: [{ type: 'text', text: `whale-balance 出错：${err?.message ?? String(err)}` }],
          isError: true,
        });
      }
      return;
    }

    default:
      if (isRequest) replyError(id, -32601, `未实现的方法：${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log(`收到非 JSON 行，已忽略：${line.slice(0, 120)}`);
      continue;
    }
    handle(message).catch((err) => {
      log(`处理 ${message?.method} 时异常：${err?.stack ?? String(err)}`);
      if (message?.id !== undefined && message?.id !== null) {
        replyError(message.id, -32603, err?.message ?? String(err));
      }
    });
  }
});

// stdin 关了就自然收尾：**不要**在这里 process.exit()。
// 反例（本插件踩过）：fetch 还在飞的时候 exit 会把整轮响应连同账本写入一起丢掉 ——
// get_usage 这种纯同步工具看不出问题，联网工具必挂。
process.stdin.on('end', () => log('stdin 已关闭，等待在飞行的请求收尾'));
process.on('uncaughtException', (err) => log(`未捕获异常：${err?.stack ?? String(err)}`));
process.on('unhandledRejection', (err) => log(`未处理的 rejection：${err?.stack ?? String(err)}`));

log(`启动。安装目录=${INSTALL_ROOT} 账本=${LEDGER_PATH} 内置 Node=${process.versions.node}`);
