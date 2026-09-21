import { create } from "zustand";
import { bridge, call } from "../lib/ipc.ts";
import {
  normalizeThread,
  toSeconds,
  type ThreadSummary,
} from "../lib/types.ts";

/** 原始 ThreadItem（防御式透传，渲染层自行判别）。 */
export type TurnItem = Record<string, unknown> & { type?: string; id?: string };

export interface TurnNotice {
  level: "error" | "warning";
  message: string;
  willRetry?: boolean;
}

export interface TurnView {
  id: string;
  status: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: unknown;
  items: TurnItem[];
  /** 流式过程中的行内错误/警告（turn/completed 后由 error 字段接管错误展示）。 */
  notices: TurnNotice[];
}

export interface TokenUsageView {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  modelContextWindow: number | null;
}

export interface ThreadWarning {
  key: string;
  message: string;
}

interface ThreadViewStore {
  threadId: string | null;
  thread: ThreadSummary | null;
  turns: TurnView[];
  /** 更早回合分页游标；null 表示没有更多。 */
  turnsCursor: string | null;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  /** 流式进行中标记：turn/started 置位，turn/completed 清除。 */
  streaming: boolean;
  /** 当前活动回合 id（turn/started 记录，turn/completed 清除），供 turn/steer 前置校验。 */
  activeTurnId: string | null;
  /** 当前会话累计 token 用量（thread/tokenUsage/updated）。 */
  tokenUsage: TokenUsageView | null;
  /** 线程级 warning 行内条。 */
  warnings: ThreadWarning[];
  /** 侧栏前进/后退：最近打开的会话历史栈。 */
  history: string[];
  historyIndex: number;
  open: (threadId: string, opts?: { fromHistory?: boolean }) => Promise<void>;
  close: () => void;
  goBack: () => void;
  goForward: () => void;
  loadOlder: () => Promise<void>;
  setStreaming: (v: boolean) => void;
  /** 后端通知 → 流式状态归并的唯一入口（backend-events 分发）。 */
  applyNotification: (env: { method: string; params: unknown }) => void;
}

function normalizeTurn(raw: unknown): TurnView {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    status: typeof r.status === "string" ? r.status : null,
    startedAt: toSeconds(r.startedAt),
    completedAt: toSeconds(r.completedAt),
    durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
    error: r.error ?? null,
    items: (Array.isArray(r.items) ? r.items : []).map((x) => (x ?? {}) as TurnItem),
    notices: [],
  };
}

function normalizeTokenUsage(raw: unknown): TokenUsageView | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const total = (r.total ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    totalTokens: num(total.totalTokens),
    inputTokens: num(total.inputTokens),
    cachedInputTokens: num(total.cachedInputTokens),
    outputTokens: num(total.outputTokens),
    reasoningOutputTokens: num(total.reasoningOutputTokens),
    modelContextWindow: typeof r.modelContextWindow === "number" ? r.modelContextWindow : null,
  };
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 单条命令输出的保留上限（字符数，约 256KB，与内置终端环形缓冲同一量级）。
 * 超出时只保留尾部，避免万行输出无限拼接撑爆内存与 DOM（AC-16）。
 */
const MAX_COMMAND_OUTPUT = 256 * 1024;
const TRUNC_MARKER = "…（前序输出已截断，仅保留最近内容）…\n";

function appendOutput(prevRaw: string, delta: string): string {
  // 已截断过的内容首行是标记，追加前先剥掉，避免标记被后续切片带走。
  const prev = prevRaw.startsWith(TRUNC_MARKER)
    ? prevRaw.slice(TRUNC_MARKER.length)
    : prevRaw;
  const next = prev + delta;
  if (next.length <= MAX_COMMAND_OUTPUT) return nextRaw(prevRaw, next);
  const keep = next.slice(next.length - (MAX_COMMAND_OUTPUT - TRUNC_MARKER.length));
  return TRUNC_MARKER + keep;
}

function nextRaw(prevRaw: string, next: string): string {
  // 未超限时若此前截断过，保留标记前缀（内容仍是尾部窗口）。
  return prevRaw.startsWith(TRUNC_MARKER) ? TRUNC_MARKER + next : next;
}

/** MCP progressLog 保留行数上限（与流式 delta 路径一致）。 */
const MAX_PROGRESS_LOG = 200;

/**
 * 完成态条目（item/completed、turn/completed）若携带全量大字段，
 * 同样执行尾部截断，防止绕过流式期间的上限。
 */
function capItemOutputs(item: TurnItem): TurnItem {
  if (item.type === "commandExecution") {
    const out = s(item.aggregatedOutput);
    if (out.length > MAX_COMMAND_OUTPUT) {
      const base = out.startsWith(TRUNC_MARKER) ? out.slice(TRUNC_MARKER.length) : out;
      const keep = base.slice(base.length - (MAX_COMMAND_OUTPUT - TRUNC_MARKER.length));
      return { ...item, aggregatedOutput: TRUNC_MARKER + keep };
    }
    return item;
  }
  if (item.type === "mcpToolCall" && Array.isArray(item.progressLog)) {
    const log = item.progressLog.map(s);
    if (log.length > MAX_PROGRESS_LOG) return { ...item, progressLog: log.slice(-MAX_PROGRESS_LOG) };
  }
  return item;
}

export const useThreadViewStore = create<ThreadViewStore>((set, get) => {
  /** 按 turnId 定位回合并做不可变更新（仅当前会话）。 */
  const patchTurn = (turnId: string, fn: (t: TurnView) => TurnView) => {
    const cur = get();
    if (cur.threadId == null) return;
    set((st) => ({ turns: st.turns.map((t) => (t.id === turnId ? fn(t) : t)) }));
  };

  /** 按 itemId 定位条目；不存在时用 factory 生成占位条目。 */
  const patchItem = (
    turnId: string,
    itemId: string,
    factory: () => TurnItem,
    fn: (item: TurnItem) => TurnItem,
  ) => {
    patchTurn(turnId, (t) => {
      const exists = t.items.some((i) => i.id === itemId);
      return {
        ...t,
        items: exists
          ? t.items.map((i) => (i.id === itemId ? fn(i) : i))
          : [...t.items, fn(factory())],
      };
    });
  };

  /** 文本 delta 追加：字符串字段通用归并。 */
  const appendDelta = (turnId: string, itemId: string, type: string, field: string, delta: string) => {
    patchItem(
      turnId,
      itemId,
      () => ({ type, id: itemId, [field]: "" }) as TurnItem,
      (item) => ({ ...item, [field]: s(item[field]) + delta }),
    );
  };

  return {
    threadId: null,
    thread: null,
    turns: [],
    turnsCursor: null,
    loading: false,
    loadingOlder: false,
    error: null,
    streaming: false,
    activeTurnId: null,
    tokenUsage: null,
    warnings: [],
    history: [],
    historyIndex: -1,

    open: async (threadId, opts) => {
      // 历史栈仅在主动打开会话时推进；前进/后退只移动游标不重复入栈。
      if (!opts?.fromHistory) {
        const { history, historyIndex } = get();
        if (history[historyIndex] !== threadId) {
          // 新开分支时丢弃当前位置之后的前进项；上限 50 条，避免无界增长。
          const nextHistory = [...history.slice(0, historyIndex + 1), threadId].slice(-50);
          set({ history: nextHistory, historyIndex: nextHistory.length - 1 });
        }
      }
      set({
        threadId,
        loading: true,
        error: null,
        thread: null,
        turns: [],
        turnsCursor: null,
        streaming: false,
        activeTurnId: null,
        tokenUsage: null,
        warnings: [],
      });
      let thread: ThreadSummary | null = null;
      let turns: TurnView[] = [];
      let cursor: string | null = null;
      let failed = false;
      try {
        const resumed = await call<Record<string, unknown>>(() =>
          bridge().threads.resume({ threadId }),
        );
        thread = normalizeThread(resumed.thread ?? resumed);
        // resume 响应可能内嵌 turns；否则显式拉一次。
        const inlineTurns = Array.isArray(resumed.turns) ? resumed.turns : null;
        if (inlineTurns && inlineTurns.length > 0) {
          turns = inlineTurns.map(normalizeTurn);
        } else {
          try {
            const page = await call<{ data?: unknown[]; nextCursor?: string | null }>(() =>
              bridge().threads.turns({ threadId, limit: 100 }),
            );
            turns = (page?.data ?? []).map(normalizeTurn);
            cursor = page?.nextCursor ?? null;
          } catch {
            turns = [];
          }
        }
      } catch {
        // 新建会话尚无 rollout 文件，thread/resume 会失败（no rollout found）。
        // 降级为 thread/read 拉元数据 + 空时间线，流式通知随后自会填充回合。
        try {
          const r = await call<Record<string, unknown>>(() => bridge().threads.read({ threadId }));
          thread = normalizeThread(r.thread ?? r);
        } catch {
          failed = true;
        }
      }
      // 防止快速切换会话后旧数据覆盖新会话
      if (useThreadViewStore.getState().threadId === threadId) {
        set({ thread, turns, turnsCursor: cursor, loading: false, error: failed ? "该会话不可用" : null });
      }
    },

    close: () =>
      set({
        threadId: null,
        thread: null,
        turns: [],
        turnsCursor: null,
        error: null,
        streaming: false,
        activeTurnId: null,
        tokenUsage: null,
        warnings: [],
      }),

    goBack: () => {
      const { history, historyIndex } = get();
      if (historyIndex <= 0) return;
      const idx = historyIndex - 1;
      set({ historyIndex: idx });
      void get().open(history[idx], { fromHistory: true });
    },

    goForward: () => {
      const { history, historyIndex } = get();
      if (historyIndex < 0 || historyIndex >= history.length - 1) return;
      const idx = historyIndex + 1;
      set({ historyIndex: idx });
      void get().open(history[idx], { fromHistory: true });
    },

    /** 向前加载更早的回合。 */
    loadOlder: async () => {
      const { threadId, turnsCursor, loadingOlder } = get();
      if (!threadId || !turnsCursor || loadingOlder) return;
      set({ loadingOlder: true });
      try {
        const page = await call<{ data?: unknown[]; nextCursor?: string | null }>(() =>
          bridge().threads.turns({ threadId, limit: 100, cursor: turnsCursor }),
        );
        const older = (page?.data ?? []).map(normalizeTurn);
        if (useThreadViewStore.getState().threadId === threadId) {
          set((s) => ({
            turns: [...older, ...s.turns],
            turnsCursor: page?.nextCursor ?? null,
          }));
        }
      } catch (err) {
        set({ error: (err as Error).message });
      } finally {
        set({ loadingOlder: false });
      }
    },

    setStreaming: (streaming) => set({ streaming, ...(streaming ? {} : { activeTurnId: null }) }),

    applyNotification: (env) => {
      const method = env.method;
      const p = (env.params ?? {}) as Record<string, unknown>;
      const threadId = typeof p.threadId === "string" ? p.threadId : null;
      const current = get();

      // 线程级 warning：threadId 可能为 null（全局警告）。
      if (method === "warning") {
        if (threadId !== null && threadId !== current.threadId) return;
        const message = s(p.message);
        if (!message) return;
        set((st) => ({
          warnings: [...st.warnings, { key: `${Date.now()}-${st.warnings.length}`, message }],
        }));
        return;
      }

      if (!threadId || threadId !== current.threadId) return;
      const turnId = typeof p.turnId === "string" ? p.turnId : null;

      switch (method) {
        case "turn/started": {
          if (p.turn && typeof p.turn === "object") {
            const turn = normalizeTurn(p.turn);
            if (!turn.id) return;
            set((st) => ({
              streaming: true,
              activeTurnId: turn.id,
              turns: st.turns.some((t) => t.id === turn.id)
                ? st.turns.map((t) => (t.id === turn.id ? turn : t))
                : [...st.turns, turn],
            }));
          }
          break;
        }

        case "turn/completed": {
          const normalized = normalizeTurn(p.turn);
          const incoming = { ...normalized, items: normalized.items.map(capItemOutputs) };
          if (!incoming.id) {
            set({ streaming: false, activeTurnId: null });
            break;
          }
          set((st) => {
            const exists = st.turns.some((t) => t.id === incoming.id);
            const turns = exists
              ? st.turns.map((t) => {
                  if (t.id !== incoming.id) return t;
                  // completed 通知的 Turn.items 是 summary 视图（可能不含
                  // userMessage/reasoning 等早期条目）：以现有条目为骨架，
                  // 同 id 用最终版本、缺失的保留、新增的追加。
                  const ids = new Set(t.items.map((i) => i.id).filter(Boolean));
                  const merged = t.items.map((old) => {
                    const fresh = old.id ? incoming.items.find((i) => i.id === old.id) : null;
                    return fresh ?? old;
                  });
                  for (const ni of incoming.items) {
                    if (ni.id && !ids.has(ni.id)) merged.push(ni);
                  }
                  return { ...incoming, items: merged, notices: t.notices };
                })
              : [...st.turns, incoming];
            return {
              streaming: false,
              activeTurnId: st.activeTurnId === incoming.id ? null : st.activeTurnId,
              turns,
            };
          });
          break;
        }

        case "item/started": {
          const item = (p.item ?? null) as TurnItem | null;
          if (!turnId || !item || typeof item.id !== "string") return;
          patchTurn(turnId, (t) =>
            t.items.some((i) => i.id === item.id)
              ? { ...t, items: t.items.map((i) => (i.id === item.id ? item : i)) }
              : { ...t, items: [...t.items, item] },
          );
          break;
        }

        case "item/completed": {
          const rawItem = (p.item ?? null) as TurnItem | null;
          if (!turnId || !rawItem || typeof rawItem.id !== "string") return;
          const item = capItemOutputs(rawItem);
          patchTurn(turnId, (t) =>
            t.items.some((i) => i.id === item.id)
              ? { ...t, items: t.items.map((i) => (i.id === item.id ? item : i)) }
              : { ...t, items: [...t.items, item] },
          );
          break;
        }

        case "item/agentMessage/delta":
          if (turnId) appendDelta(turnId, String(p.itemId), "agentMessage", "text", s(p.delta));
          break;

        case "item/plan/delta":
          if (turnId) appendDelta(turnId, String(p.itemId), "plan", "text", s(p.delta));
          break;

        case "item/commandExecution/outputDelta": {
          if (!turnId) break;
          const delta = s(p.delta);
          patchItem(
            turnId,
            String(p.itemId),
            () => ({ type: "commandExecution", id: String(p.itemId), aggregatedOutput: "" }) as TurnItem,
            (item) => ({ ...item, aggregatedOutput: appendOutput(s(item.aggregatedOutput), delta) }),
          );
          break;
        }

        case "item/fileChange/patchUpdated": {
          if (!turnId || !Array.isArray(p.changes)) break;
          patchItem(
            turnId,
            String(p.itemId),
            () => ({ type: "fileChange", id: String(p.itemId), changes: [], status: "inProgress" }) as TurnItem,
            (item) => ({ ...item, changes: p.changes }),
          );
          break;
        }

        case "item/mcpToolCall/progress": {
          if (!turnId) break;
          const message = s(p.message);
          if (!message) break;
          patchItem(
            turnId,
            String(p.itemId),
            () => ({ type: "mcpToolCall", id: String(p.itemId), progressLog: [] }) as TurnItem,
            (item) => {
              const progressLog = Array.isArray(item.progressLog) ? item.progressLog.map(s) : [];
              progressLog.push(message);
              // 进度日志只保留尾部 200 行，防止长会话无界增长。
              const capped =
                progressLog.length > MAX_PROGRESS_LOG
                  ? progressLog.slice(-MAX_PROGRESS_LOG)
                  : progressLog;
              return { ...item, progressLog: capped };
            },
          );
          break;
        }

        case "item/reasoning/summaryPartAdded": {
          if (!turnId) break;
          const idx = typeof p.summaryIndex === "number" ? p.summaryIndex : null;
          if (idx === null) break;
          patchItem(
            turnId,
            String(p.itemId),
            () => ({ type: "reasoning", id: String(p.itemId), summary: [], content: [] }) as TurnItem,
            (item) => {
              const summary = Array.isArray(item.summary) ? item.summary.map(s) : [];
              while (summary.length <= idx) summary.push("");
              return { ...item, summary };
            },
          );
          break;
        }

        case "item/reasoning/summaryTextDelta": {
          if (!turnId) break;
          const idx = typeof p.summaryIndex === "number" ? p.summaryIndex : 0;
          const delta = s(p.delta);
          if (!delta) break;
          patchItem(
            turnId,
            String(p.itemId),
            () => ({ type: "reasoning", id: String(p.itemId), summary: [], content: [] }) as TurnItem,
            (item) => {
              const summary = Array.isArray(item.summary) ? item.summary.map(s) : [];
              while (summary.length <= idx) summary.push("");
              summary[idx] += delta;
              return { ...item, summary };
            },
          );
          break;
        }

        case "item/reasoning/textDelta": {
          if (!turnId) break;
          const idx = typeof p.contentIndex === "number" ? p.contentIndex : 0;
          const delta = s(p.delta);
          if (!delta) break;
          patchItem(
            turnId,
            String(p.itemId),
            () => ({ type: "reasoning", id: String(p.itemId), summary: [], content: [] }) as TurnItem,
            (item) => {
              const content = Array.isArray(item.content) ? item.content.map(s) : [];
              while (content.length <= idx) content.push("");
              content[idx] += delta;
              return { ...item, content };
            },
          );
          break;
        }

        case "thread/tokenUsage/updated": {
          const usage = normalizeTokenUsage(p.tokenUsage);
          if (usage) set({ tokenUsage: usage });
          break;
        }

        case "error": {
          const err = (p.error ?? null) as Record<string, unknown> | null;
          const message = err ? s(err.message) || JSON.stringify(err) : "回合执行出错";
          if (!turnId) break;
          patchTurn(turnId, (t) => ({
            ...t,
            notices: [
              ...t.notices,
              { level: "error", message, willRetry: p.willRetry === true },
            ],
          }));
          break;
        }

        default:
          break;
      }
    },
  };
});
