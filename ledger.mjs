/**
 * 共享记账逻辑：MCP server 与 Stop hook 都走这里写同一个账本，
 * 避免两套代码对同一件事给出两种口径。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMoney, beijingDay, dayOffset, makePricing, costOfTurn } from './accounting.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INSTALL_ROOT = path.resolve(HERE, '..', '..');
// 账本路径可用 WHALE_BALANCE_LEDGER 覆盖。
// 为什么必须有这个口子：自检脚本要写账本才能测，如果不重定向，跑一次自检就会往
// 生产账本里灌"假账"（test-plugin 灌假轮次、test-hook 更是直接 rm 掉真账本）。
// 生产路径永远是默认值，只有显式设了这个变量才会改。
export const LEDGER_PATH = process.env.WHALE_BALANCE_LEDGER
  ? path.resolve(process.env.WHALE_BALANCE_LEDGER)
  : path.join(INSTALL_ROOT, 'plugins-state.whale-balance.json');
export const PRICING_PATH = path.join(HERE, 'pricing.json');
export const MAX_ENTRIES = 20000;

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function emptyLedger() {
  return {
    version: 2,
    note: 'whale-balance 账本。balances = DeepSeek 账户口径的余额观测；turns = 本机会话口径的逐轮估算；daily = 按北京日汇总（定点金额存为十进制字符串）。两个口径不互相覆盖，也不要相加。',
    balances: [],
    turns: [],
    daily: {},
  };
}

/** JSON 里定点金额是十进制字符串，读回来要还原成 BigInt。 */
export function toFixed(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.round(v));
  return 0n;
}

export function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return emptyLedger();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch (err) {
    const e = new Error(
      `账本文件无法解析：${LEDGER_PATH}\n${err?.message ?? String(err)}\n` +
      '为避免丢数据，这里拒绝覆盖它。请先备份改名，让它重建。',
    );
    e.ledgerCorrupt = true;
    throw e;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !Array.isArray(raw.balances) || !Array.isArray(raw.turns)
    || typeof raw.daily !== 'object' || raw.daily === null) {
    const e = new Error(`账本文件结构异常：${LEDGER_PATH}。请先备份改名。`);
    e.ledgerCorrupt = true;
    throw e;
  }
  raw.daily = Object.fromEntries(
    Object.entries(raw.daily).map(([day, rec]) => [day, {
      observedSpend: toFixed(rec?.observedSpend),
      turnCost: toFixed(rec?.turnCost),
      turnCount: Number(rec?.turnCount) || 0,
    }]),
  );
  return raw;
}

/**
 * 账本级的排他锁。
 *
 * 为什么需要：账本是"读 → 改 → 写"。没有互斥时两个写入方会读到同一份旧内容、
 * 各自写一遍，于是同一轮被记两次 —— 本插件真踩到过（hook 与 MCP 工具并发、
 * 或两个会话重叠时）。用 `wx` 独占创建当锁：文件系统保证只有一个进程能成功。
 */
export class LedgerBusy extends Error {
  constructor() {
    super('账本正被另一个进程写入');
    this.busy = true;
  }
}

export function acquireLock({ timeoutMs = 5000, staleMs = 30000 } = {}) {
  const lockPath = `${LEDGER_PATH}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch { /* 已被清掉也无所谓 */ }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // 陈旧锁：持有者崩了没清掉，按 mtime 判断后强夺
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* 刚被别人清掉，直接重试 */ }
      if (Date.now() >= deadline) throw new LedgerBusy();
      sleepBriefly(25);
    }
  }
}

/** 同步小睡：hook 场景不值得为等锁引入异步复杂度。 */
function sleepBriefly(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** 拿锁 → 读 → 改 → 写 → 释放。回调的返回值即本函数的返回值。 */
export function withLedger(fn, options) {
  const release = acquireLock(options);
  try {
    const ledger = loadLedger();
    const result = fn(ledger);
    saveLedger(ledger);
    return result;
  } finally {
    release();
  }
}

export function serializeLedger(ledger) {
  if (ledger.turns.length > MAX_ENTRIES) ledger.turns = ledger.turns.slice(-MAX_ENTRIES);
  if (ledger.balances.length > MAX_ENTRIES) ledger.balances = ledger.balances.slice(-MAX_ENTRIES);
  return {
    ...ledger,
    daily: Object.fromEntries(
      Object.entries(ledger.daily).map(([day, rec]) => [day, {
        observedSpend: toFixed(rec.observedSpend).toString(),
        turnCost: toFixed(rec.turnCost).toString(),
        turnCount: Number(rec.turnCount) || 0,
      }]),
    ),
  };
}

export function saveLedger(ledger) {
  writeJsonAtomic(LEDGER_PATH, serializeLedger(ledger));
}

export function dailyOf(ledger, day) {
  if (!ledger.daily[day]) ledger.daily[day] = { observedSpend: 0n, turnCost: 0n, turnCount: 0 };
  const rec = ledger.daily[day];
  rec.observedSpend = toFixed(rec.observedSpend);
  rec.turnCost = toFixed(rec.turnCost);
  rec.turnCount = Number(rec.turnCount) || 0;
  return rec;
}

export function loadPricing() {
  const raw = readJsonSafe(PRICING_PATH);
  if (!raw || typeof raw !== 'object') throw new Error(`价格表无法读取或不是对象：${PRICING_PATH}`);
  return { raw, pricing: makePricing(raw) };
}

/**
 * 把一轮 usage 折算成金额并记进账本。
 * 返回 { total, price, breakdown, day }，调用方负责 saveLedger。
 */
export function recordTurn(ledger, { model, usage, ts, source, extra }) {
  const { pricing, raw } = loadPricing();
  const price = pricing.priceFor(model, ts);
  if (!price) {
    throw new Error(`价格表里没有模型 ${model}。已知：${Object.keys(raw.models ?? {}).join(', ')}`);
  }
  const { total, breakdown } = costOfTurn(usage, price);
  const day = beijingDay(ts);
  const record = {
    ts,
    day,
    model,
    priceKey: price.modelKey,
    peak: price.peak,
    cost: total.toString(),
    tokens: {
      cacheHit: breakdown.cacheHitTokens,
      cacheMiss: breakdown.cacheMissTokens,
      output: breakdown.outputTokens,
    },
    ...(source ? { source } : {}),
    ...(extra ?? {}),
  };
  ledger.turns.push(record);
  const rec = dailyOf(ledger, day);
  rec.turnCost += total;
  rec.turnCount += 1;
  return { total, price, breakdown, day, record };
}

export function ledgerWindow(ledger, fromDay, toDay) {
  const days = Object.keys(ledger.daily).filter((d) => d >= fromDay && d <= toDay).sort();
  let observedSpend = 0n;
  let turnCost = 0n;
  let turnCount = 0;
  for (const day of days) {
    const rec = dailyOf(ledger, day);
    observedSpend += rec.observedSpend;
    turnCost += rec.turnCost;
    turnCount += rec.turnCount;
  }
  return { days, observedSpend, turnCost, turnCount };
}

/** 把一次余额观测并进账本（下降=消费，上升=充值调整，不冲掉消费）。 */
export function observeInto(ledger, snapshot) {
  const last = ledger.balances[ledger.balances.length - 1] ?? null;
  const total = BigInt(snapshot.totalFixed);
  let delta = 0n;
  let kind = 'first';
  if (last) {
    const lastTotal = toFixed(last.total);
    if (last.currency !== snapshot.currency) {
      kind = 'currency-changed';
    } else {
      delta = total - lastTotal;
      kind = delta < 0n ? 'spend' : delta > 0n ? 'topup' : 'flat';
    }
  }
  const day = beijingDay(snapshot.ts);
  const record = {
    ts: snapshot.ts,
    day,
    currency: snapshot.currency,
    total: total.toString(),
    granted: snapshot.grantedFixed == null ? null : String(snapshot.grantedFixed),
    toppedUp: snapshot.toppedUpFixed == null ? null : String(snapshot.toppedUpFixed),
    delta: delta.toString(),
    kind,
  };
  ledger.balances.push(record);
  if (kind === 'spend') dailyOf(ledger, day).observedSpend += -delta;
  return { record, delta, kind, previous: last };
}

export { formatMoney, beijingDay, dayOffset };
