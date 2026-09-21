import { create } from "zustand";
import { EVENTS } from "@shared/ipc/contract.ts";
import { bridge, call, onEvent } from "../lib/ipc.ts";

/** 与主进程 backend/conversation-backend.ts 的 PendingApproval 对齐（渲染端镜像）。 */
export interface PendingApproval {
  localId: string;
  serverId: string | number;
  method: string;
  params: unknown;
  threadId?: string;
  receivedAt: number;
  status: "pending" | "resolved" | "expired";
}

interface ApprovalsStore {
  pending: PendingApproval[];
  started: boolean;
  start: () => void;
  refresh: () => Promise<void>;
  remove: (localId: string) => void;
}

export const useApprovalsStore = create<ApprovalsStore>((set, get) => ({
  pending: [],
  started: false,

  start: () => {
    if (get().started) return;
    set({ started: true });
    void get().refresh();

    onEvent(EVENTS.approvalChanged, (payload) => {
      const a = payload as Partial<PendingApproval> | null;
      if (!a || typeof a.localId !== "string") return;
      if (a.status === "pending") {
        set((s) =>
          s.pending.some((x) => x.localId === a.localId)
            ? s
            : { pending: [...s.pending, a as PendingApproval] },
        );
      } else {
        set((s) => ({ pending: s.pending.filter((x) => x.localId !== a.localId) }));
      }
    });
  },

  refresh: async () => {
    try {
      const list = await call<PendingApproval[]>(() => bridge().approvals.list());
      set({ pending: Array.isArray(list) ? list.filter((a) => a.status === "pending") : [] });
    } catch {
      /* 后端未就绪时忽略 */
    }
  },

  remove: (localId) =>
    set((s) => ({ pending: s.pending.filter((x) => x.localId !== localId) })),
}));
