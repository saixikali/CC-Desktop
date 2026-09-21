import { create } from "zustand";
import type { BackendStatusSnapshot, WizardState } from "@shared/ipc/contract.ts";
import { EVENTS } from "@shared/ipc/contract.ts";
import { bridge, call, onEvent } from "../lib/ipc.ts";

interface BackendStore {
  status: BackendStatusSnapshot | null;
  wizard: WizardState | null;
  started: boolean;
  restarting: boolean;
  start: () => void;
  restart: (reason?: string) => Promise<void>;
  refreshWizard: () => Promise<void>;
}

export const useBackendStore = create<BackendStore>((set, get) => ({
  status: null,
  wizard: null,
  started: false,
  restarting: false,

  start: () => {
    if (get().started) return;
    set({ started: true });

    void call<BackendStatusSnapshot>(() => bridge().backend.status())
      .then((status) => set({ status }))
      .catch(() => undefined);
    void get().refreshWizard();

    onEvent(EVENTS.backendStatus, (payload) => {
      const status = payload as BackendStatusSnapshot;
      set({ status });
      if (status.state === "ready") void get().refreshWizard();
    });
  },

  restart: async (reason) => {
    if (get().restarting) return;
    set({ restarting: true });
    try {
      await call(() => bridge().backend.restart({ reason }));
    } finally {
      setTimeout(() => set({ restarting: false }), 1500);
    }
  },

  refreshWizard: async () => {
    try {
      const wizard = await call<WizardState>(() => bridge().backend.wizardGet());
      set({ wizard });
    } catch {
      /* 后端未就绪时静默，状态条已反映 */
    }
  },
}));
