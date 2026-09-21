/**
 * 主题（浅色/深色）：html.dark 类驱动 CSS 变量换肤。
 * - localStorage 保存最近一次选择，供首帧脚本/模块在 React 挂载前应用，避免闪烁；
 * - 权威值来自主进程 prefs，App 启动后以 prefs 为准覆盖。
 */
import type { LocalPrefs } from "@shared/ipc/contract.ts";

export type Theme = LocalPrefs["theme"];

const KEY = "cc.theme";

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/** 首帧前按本地缓存应用（默认浅色）。 */
export function initTheme(): void {
  let theme: Theme = "light";
  try {
    if (localStorage.getItem(KEY) === "dark") theme = "dark";
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}
