/**
 * 内置终端（Task 14）：多标签 PTY 会话的渲染层状态。
 *  - 输出分发：attachLive 后由活动视图直接消费；切走/卸载后输出暂存 pending，
 *    重新挂载时一次性回放，保证后台标签不丢输出。
 *  - pending 上限 512KB（保尾部），防止长期后台运行撑爆内存。
 */
import { create } from "zustand";
import { EVENTS, type ProcessSpawnResult } from "@shared/ipc/contract.ts";
import { bridge, call, onEvent } from "../lib/ipc.ts";

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string | null;
  shell: string | null;
  exited: boolean;
  exitCode: number | null;
  /** 视图未接管时的输出暂存。 */
  pending: string;
  /** 是否有存活视图（xterm 实例）在消费输出。 */
  live: boolean;
}

const PENDING_CAP = 512 * 1024;

function capPending(buf: string, add: string): string {
  const next = buf + add;
  return next.length > PENDING_CAP ? next.slice(next.length - PENDING_CAP) : next;
}

/** 活动 xterm 实例的输出出口（id → write 回调）。 */
const liveSinks = new Map<string, (data: string) => void>();

interface TerminalStore {
  sessions: TerminalSession[];
  activeId: string | null;
  open: boolean;
  fontSize: number;
  creating: boolean;

  setOpen: (open: boolean) => void;
  setActive: (id: string) => void;
  setFontSize: (size: number) => void;

  create: (cwd?: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  applyOutput: (id: string, data: string) => void;
  applyExit: (id: string, exitCode: number) => void;

  /** 挂载视图：接管输出，返回此前暂存的内容用于回放。 */
  attachLive: (id: string, sink: (data: string) => void) => string;
  detachLive: (id: string) => void;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: [],
  activeId: null,
  open: false,
  fontSize: Math.min(20, Math.max(9, Number(localStorage.getItem("cc.terminal.fontSize")) || 12)),
  creating: false,

  setOpen: (open) => set({ open }),
  setActive: (id) => set({ activeId: id, open: true }),
  setFontSize: (size) => {
    localStorage.setItem("cc.terminal.fontSize", String(size));
    set({ fontSize: size });
  },

  create: async (cwd) => {
    if (get().creating) return;
    set({ creating: true });
    try {
      const res = await call<ProcessSpawnResult>(() => bridge().process.spawn(cwd ? { cwd } : undefined));
      set((s) => ({
        sessions: [
          ...s.sessions,
          {
            id: res.id,
            title: res.title,
            cwd: res.cwd,
            shell: res.shell,
            exited: false,
            exitCode: null,
            pending: "",
            live: false,
          },
        ],
        activeId: res.id,
        open: true,
      }));
    } finally {
      set({ creating: false });
    }
  },

  close: async (id) => {
    liveSinks.delete(id);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      return {
        sessions,
        activeId: s.activeId === id ? sessions[sessions.length - 1]?.id ?? null : s.activeId,
      };
    });
    try {
      // 已退出的 id 在主进程已不在表内，kill 是无害空操作。
      await call(() => bridge().process.kill({ id }));
    } catch {
      /* 主进程已清理（退出事件竞态）时忽略 */
    }
  },

  applyOutput: (id, data) => {
    const sink = liveSinks.get(id);
    if (sink) {
      sink(data);
      return;
    }
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, pending: capPending(x.pending, data) } : x)),
    }));
  },

  applyExit: (id, exitCode) => {
    liveSinks.delete(id);
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, exited: true, exitCode, live: false } : x)),
    }));
  },

  attachLive: (id, sink) => {
    let pending = "";
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== id) return x;
        pending = x.pending;
        return { ...x, live: true, pending: "" };
      }),
    }));
    liveSinks.set(id, sink);
    return pending;
  },

  detachLive: (id) => {
    liveSinks.delete(id);
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, live: false } : x)),
    }));
  },
}));

/** 终端输出/退出事件绑定（TerminalPane 挂载时调用，返回退订函数）。 */
export function bindTerminalEvents(): () => void {
  const offOutput = onEvent(EVENTS.processOutputDelta, (payload) => {
    const p = payload as { id?: unknown; data?: unknown } | null;
    if (typeof p?.id === "string" && typeof p.data === "string") {
      useTerminalStore.getState().applyOutput(p.id, p.data);
    }
  });
  const offExit = onEvent(EVENTS.processExited, (payload) => {
    const p = payload as { id?: unknown; exitCode?: unknown } | null;
    if (typeof p?.id === "string" && typeof p.exitCode === "number") {
      useTerminalStore.getState().applyExit(p.id, p.exitCode);
    }
  });
  return () => {
    offOutput();
    offExit();
  };
}
