/**
 * 记账内核：定点金额运算 + 余额观测账本 + 峰谷计价。
 *
 * 设计原则（照抄 dsh-whale-widget 踩出来的三条）：
 *  1. 金额一律用「整数定点（1e-8 元）」保存和运算，绝不落浮点。显示时才转字符串。
 *  2. 余额下降记为消费，余额上升（充值/赠金）单独记为调整，**不冲掉已有消费**。
 *  3. 账本文件损坏时拒绝覆盖（宁可报错也不丢数据），由用户决定怎么处理。
 *
 * 口径提醒：余额观测得到的是 **DeepSeek 账户口径**（该 API key 对应的账户），
 * 逐轮 token 估算得到的是 **本机会话口径**。两者不应相加，也不应互相覆盖。
 */

const SCALE = 100000000n; // 1e-8
const SCALE_DIGITS = 8;

/** 把可能是 string / number / bigint 的金额解析成定点整数。失败抛错。 */
export function parseMoney(value, label = 'amount') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} 不是有限数字：${value}`);
    // 刻意走 toFixed：Number → BigInt 对非整数会直接抛 TypeError
    return fromDecimalString(value.toFixed(SCALE_DIGITS), label);
  }
  if (typeof value === 'string') {
    return fromDecimalString(value, label);
  }
  throw new Error(`${label} 类型不支持（${typeof value}），余额接口返回的金额是字符串`);
}

/** 纯字符串定点解析：不经过 Number 的二进制浮点，避免 1e-8 / 0.1+0.2 这类陷阱。 */
function fromDecimalString(input, label) {
  const text = String(input).trim();
  if (text === '') throw new Error(`${label} 是空字符串`);
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new Error(`${label} 不是合法金额：${JSON.stringify(input)}`);
  }
  const [, sign, intRaw = '', fracRaw = ''] = match;
  const intPart = intRaw === '' ? 0n : BigInt(intRaw);
  const fracPadded = (fracRaw + '0'.repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS);
  const fracPart = fracPadded === '' ? 0n : BigInt(fracPadded);
  const magnitude = intPart * SCALE + fracPart;
  return sign === '-' ? -magnitude : magnitude;
}

export function addMoney(...values) {
  return values.reduce((acc, v) => acc + v, 0n);
}

export function subMoney(a, b) {
  return a - b;
}

/** 定点整数 → 显示字符串，默认保留 2 位；round 表示四舍五入而非截断。 */
export function formatMoney(fixed, digits = 2) {
  const negative = fixed < 0n;
  const abs = negative ? -fixed : fixed;
  const intPart = abs / SCALE;
  const fracAll = (abs % SCALE).toString().padStart(SCALE_DIGITS, '0');
  let frac = fracAll.slice(0, digits);
  if (digits < SCALE_DIGITS && fracAll[digits] >= '5') {
    const bumped = BigInt(intPart.toString() + frac) + 1n;
    const s = bumped.toString().padStart(digits + 1, '0');
    const carryInt = digits === 0 ? s : s.slice(0, -digits) || '0';
    const carryFrac = digits === 0 ? '' : s.slice(-digits);
    return `${negative ? '-' : ''}${carryInt}${digits ? '.' + carryFrac : ''}`;
  }
  return `${negative ? '-' : ''}${intPart}${digits ? '.' + frac : ''}`;
}

/**
 * 令牌数 × 单价 → 定点金额。
 * 单价（元或美元 / 百万 token，最多 8 位小数）先转成定点整数再乘，
 * 全程 BigInt —— 不经过 Number 的二进制浮点，所以 0.15 这类"看起来精确"的十进制不会被二进制误差咬到。
 */
export function costOfTokens(tokens, pricePerMillion) {
  const count = Number.isFinite(tokens) ? Math.trunc(tokens) : 0;
  if (count <= 0) return 0n;
  let priceFixed;
  try {
    priceFixed = parseMoney(pricePerMillion, 'price');
  } catch {
    return 0n;
  }
  if (priceFixed <= 0n) return 0n;
  // count(整数) × priceFixed(定点) / 1e6
  return (BigInt(count) * priceFixed) / 1000000n;
}

export function sumMoney(list) {
  return list.reduce((acc, v) => acc + v, 0n);
}

// ---------------------------------------------------------------- 北京时间

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 取北京时间的 YYYY-MM-DD。账本按北京日切分，与 DeepSeek 计费口径一致。 */
export function beijingDay(ts = Date.now()) {
  return new Date(ts + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function dayOffset(day, delta) {
  const t = Date.parse(`${day}T00:00:00Z`) + delta * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 判断某个时刻是否处于高峰时段。
 * 高峰 = 工作日 09:00–12:00 与 14:00–18:00（北京时间）；周末全天谷价。
 * 具体时段与折扣以 DeepSeek 官方定价页为准，本函数与 pricing.json 的 offPeakRatio 配套。
 */
export function isPeak(ts = Date.now()) {
  const beijing = new Date(ts + BEIJING_OFFSET_MS);
  const day = beijing.getUTCDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) return false;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

// ---------------------------------------------------------------- 价格表

/**
 * 把 pricing.json 的配置解析成「按模型 id 取单价」的函数。
 * 返回 { priceFor(modelId, ts), describe(modelId) }
 */
export function makePricing(pricing) {
  const models = pricing?.models ?? {};
  const fallback = pricing?.fallback ?? null;

  function lookup(modelId) {
    if (Object.prototype.hasOwnProperty.call(models, modelId)) return { key: modelId, spec: models[modelId] };
    // 前缀/包含匹配：应付 deepseek-v4-flash-vision-exp 这类衍生 id
    for (const [key, spec] of Object.entries(models)) {
      const aliases = Array.isArray(spec.aliases) ? spec.aliases : [];
      if (aliases.includes(modelId)) return { key, spec };
      if (modelId.startsWith(key)) return { key, spec };
    }
    if (fallback) return { key: `fallback(${modelId})`, spec: fallback };
    return null;
  }

  function priceFor(modelId, ts = Date.now()) {
    const hit = lookup(modelId);
    if (!hit) return null;
    const { spec } = hit;
    const peak = isPeak(ts);
    const ratio = typeof spec.offPeakRatio === 'number' ? spec.offPeakRatio : 0.5;
    const factor = peak ? 1 : ratio;
    return {
      modelKey: hit.key,
      peak,
      currency: spec.currency ?? 'CNY',
      cacheHit: (spec.cacheHit ?? 0) * factor,
      cacheMiss: (spec.cacheMiss ?? 0) * factor,
      output: (spec.output ?? 0) * factor,
    };
  }

  return { priceFor, lookup };
}

/**
 * 按 usage 计算一轮的金额。
 * usage 形状（Claude/DeepSeek 都可能给）：
 *   { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 * DeepSeek 的「缓存未命中输入」= input_tokens - cache_read_input_tokens（下限 0）。
 */
export function costOfTurn(usage, price) {
  const input = numberOr0(usage.input_tokens);
  const cacheRead = numberOr0(usage.cache_read_input_tokens) + numberOr0(usage.cache_creation_input_tokens);
  const output = numberOr0(usage.output_tokens);
  const missInput = Math.max(0, input - cacheRead);
  const hitCost = costOfTokens(cacheRead, price.cacheHit);
  const missCost = costOfTokens(missInput, price.cacheMiss);
  const outCost = costOfTokens(output, price.output);
  return {
    total: hitCost + missCost + outCost,
    breakdown: {
      cacheHitTokens: cacheRead,
      cacheMissTokens: missInput,
      outputTokens: output,
      cacheHitCost: hitCost,
      cacheMissCost: missCost,
      outputCost: outCost,
    },
  };
}

function numberOr0(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return 0;
}

export const FIXED_SCALE = SCALE;
export { numberOr0 };
