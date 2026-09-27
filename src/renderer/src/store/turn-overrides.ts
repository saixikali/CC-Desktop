/**
 * 当轮模型与推理力度覆盖：
 * turn/start 的 model/effort 是"本回合及后续回合"的会话级覆盖，
 * 这里按 threadId 记住选择；尚未创建的会话用 pending 承载，建会后 adoptPending 固化。
 */
import { create } from "zustand";

export interface TurnOverrides {
  model: string | null;
  effort: string | null;
  /** Claude Code permissionMode：default / acceptEdits / plan / bypassPermissions。 */
  permission: string | null;
}

const EMPTY: TurnOverrides = { model: null, effort: null, permission: null };

interface TurnOverridesState {
  pending: TurnOverrides;
  byThread: Record<string, TurnOverrides>;
  get: (threadId: string | null) => TurnOverrides;
  setModel: (threadId: string | null, model: string | null) => void;
  setEffort: (threadId: string | null, effort: string | null) => void;
  setPermission: (threadId: string | null, permission: string | null) => void;
  /** 新会话创建后，把建会话前选好的 pending 覆盖挂到该会话上。 */
  adoptPending: (threadId: string) => void;
}

export const useTurnOverridesStore = create<TurnOverridesState>((set, get) => ({
  pending: { ...EMPTY },
  byThread: {},

  get: (threadId) => (threadId ? get().byThread[threadId] ?? get().pending : get().pending),

  setModel: (threadId, model) => {
    if (threadId) {
      const prev = get().byThread[threadId] ?? get().pending;
      set((s) => ({ byThread: { ...s.byThread, [threadId]: { ...prev, model } } }));
    } else {
      set((s) => ({ pending: { ...s.pending, model } }));
    }
  },

  setEffort: (threadId, effort) => {
    if (threadId) {
      const prev = get().byThread[threadId] ?? get().pending;
      set((s) => ({ byThread: { ...s.byThread, [threadId]: { ...prev, effort } } }));
    } else {
      set((s) => ({ pending: { ...s.pending, effort } }));
    }
  },

  setPermission: (threadId, permission) => {
    if (threadId) {
      const prev = get().byThread[threadId] ?? get().pending;
      set((s) => ({ byThread: { ...s.byThread, [threadId]: { ...prev, permission } } }));
    } else {
      set((s) => ({ pending: { ...s.pending, permission } }));
    }
  },

  adoptPending: (threadId) =>
    set((s) =>
      s.byThread[threadId]
        ? s
        : { byThread: { ...s.byThread, [threadId]: { ...s.pending } } },
    ),
}));
