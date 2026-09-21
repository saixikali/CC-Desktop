/**
 * 用量台账：逐回合追加 claude-backend/usage.jsonl，供设置页用量统计聚合。
 *  - 只增不改；损坏行跳过（崩溃中截断的半行不影响其余数据）
 *  - 聚合在读取时计算：按日（本地时区）、按模型、总量与最近记录
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface UsageEntry {
  /** 回合完成时间（epoch ms）。 */
  ts: number;
  threadId: string;
  /** 计费模型名（SDK modelUsage 键，中转下为真实模型名）。 */
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** SDK 报告的费用（USD）；缺失为 null。 */
  costUsd: number | null;
  durationMs: number | null;
}

export interface UsageDay {
  day: string;
  turns: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageModelRow {
  model: string;
  turns: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageStats {
  totals: {
    turns: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    costUsd: number;
    hasCost: boolean;
    firstTs: number | null;
  };
  byDay: UsageDay[];
  byModel: UsageModelRow[];
  recent: UsageEntry[];
}

function ledgerPath(dir: string): string {
  return join(dir, "usage.jsonl");
}

/** 追加一条用量记录；失败仅告警不影响回合流程。 */
export async function appendUsage(dir: string, entry: UsageEntry): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(ledgerPath(dir), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* 台账写入失败不阻塞会话 */
  }
}

/** 读取台账；损坏行跳过。 */
export async function loadUsage(dir: string): Promise<UsageEntry[]> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath(dir), "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as Partial<UsageEntry>;
      if (typeof e.ts !== "number" || typeof e.threadId !== "string") continue;
      out.push({
        ts: e.ts,
        threadId: e.threadId,
        model: typeof e.model === "string" && e.model ? e.model : "unknown",
        inputTokens: typeof e.inputTokens === "number" ? e.inputTokens : 0,
        cachedTokens: typeof e.cachedTokens === "number" ? e.cachedTokens : 0,
        outputTokens: typeof e.outputTokens === "number" ? e.outputTokens : 0,
        costUsd: typeof e.costUsd === "number" ? e.costUsd : null,
        durationMs: typeof e.durationMs === "number" ? e.durationMs : null,
      });
    } catch {
      /* 半行/坏行跳过 */
    }
  }
  return out;
}

/** 本地时区 YYYY-MM-DD。 */
function localDay(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 聚合：总量、按日（升序）、按模型（按费用→tokens 降序）、最近 50 条。 */
export function aggregateUsage(entries: UsageEntry[]): UsageStats {
  const totals = {
    turns: entries.length,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    hasCost: false,
    firstTs: null as number | null,
  };
  const days = new Map<string, UsageDay>();
  const models = new Map<string, UsageModelRow>();
  const addDay = (day: string): UsageDay => {
    let d = days.get(day);
    if (!d) {
      d = { day, turns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 };
      days.set(day, d);
    }
    return d;
  };
  const addModel = (model: string): UsageModelRow => {
    let m = models.get(model);
    if (!m) {
      m = { model, turns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 };
      models.set(model, m);
    }
    return m;
  };

  for (const e of entries) {
    totals.inputTokens += e.inputTokens;
    totals.cachedTokens += e.cachedTokens;
    totals.outputTokens += e.outputTokens;
    if (e.costUsd !== null) {
      totals.costUsd += e.costUsd;
      totals.hasCost = true;
    }
    if (totals.firstTs === null || e.ts < totals.firstTs) totals.firstTs = e.ts;

    const day = addDay(localDay(e.ts));
    day.turns++;
    day.inputTokens += e.inputTokens;
    day.cachedTokens += e.cachedTokens;
    day.outputTokens += e.outputTokens;
    if (e.costUsd !== null) day.costUsd += e.costUsd;

    const m = addModel(e.model);
    m.turns++;
    m.inputTokens += e.inputTokens;
    m.cachedTokens += e.cachedTokens;
    m.outputTokens += e.outputTokens;
    if (e.costUsd !== null) m.costUsd += e.costUsd;
  }

  const byDay = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const byModel = [...models.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  const recent = [...entries].sort((a, b) => b.ts - a.ts).slice(0, 50);
  return { totals, byDay, byModel, recent };
}
