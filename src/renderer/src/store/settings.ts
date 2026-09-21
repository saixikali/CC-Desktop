/**
 * 设置页状态：本机偏好 + 诊断日志导出（切走再切回不丢进度）。
 */
import { create } from "zustand";
import type { LocalPrefs } from "@shared/ipc/contract.ts";
import { bridge, call } from "../lib/ipc.ts";

interface SettingsState {
  prefs: LocalPrefs | null;
  exportingLogs: boolean;
  loadPrefs: () => Promise<void>;
  setPrefs: (p: Partial<LocalPrefs>) => Promise<void>;
  exportLogs: () => Promise<string | null>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  prefs: null,
  exportingLogs: false,

  loadPrefs: async () => {
    if (get().prefs) return;
    const prefs = await call<LocalPrefs>(() => bridge().settings.prefsGet());
    set({ prefs });
  },

  setPrefs: async (p) => {
    // 乐观更新，失败回滚由重读兜底。
    const prev = get().prefs;
    if (prev) set({ prefs: { ...prev, ...p } });
    try {
      const next = await call<LocalPrefs>(() => bridge().settings.prefsSet(p));
      set({ prefs: next });
    } catch (err) {
      set({ prefs: prev });
      throw err;
    }
  },

  exportLogs: async () => {
    if (get().exportingLogs) return null;
    set({ exportingLogs: true });
    try {
      return await call<string | null>(() => bridge().settings.exportLogs());
    } finally {
      set({ exportingLogs: false });
    }
  },
}));
