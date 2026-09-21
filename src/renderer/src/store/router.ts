import { create } from "zustand";

export type ViewKey = "wizard" | "chat" | "settings";
/** 主区分页模式：任务（Claude Code 工作会话）/ 对话（豆包式闲聊页）。 */
export type PageMode = "task" | "chat";

const MODE_KEY = "cc.view.mode";

function readMode(): PageMode {
  try {
    return localStorage.getItem(MODE_KEY) === "chat" ? "chat" : "task";
  } catch {
    return "task";
  }
}

export type SettingsSection = "engine" | "usage" | "general" | "diagnostics" | "about";

interface RouterStore {
  view: ViewKey;
  settingsSection: SettingsSection;
  mode: PageMode;
  setView: (view: ViewKey) => void;
  setMode: (mode: PageMode) => void;
  openSettings: (section?: SettingsSection) => void;
}

/** 轻量路由：Electron 单页无需 history 栈，状态即路由。 */
export const useRouterStore = create<RouterStore>((set) => ({
  view: "chat",
  settingsSection: "engine",
  mode: readMode(),
  setMode: (mode) => {
    set({ mode });
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  },
  setView: (view) => set({ view }),
  openSettings: (section) => set({ view: "settings", settingsSection: section ?? "engine" }),
}));
