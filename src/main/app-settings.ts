/**
 * userData/settings.json：向导完成标记、当前工作区、已授权文件 roots。
 * 原子写（tmp+rename）；文件损坏时回退默认值并保留 .corrupt 备份。
 */
import { existsSync, renameSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { App } from "electron";
import type { LocalPrefs } from "../shared/ipc/contract.ts";

export interface AppSettingsData extends LocalPrefs {
  wizardCompleted: boolean;
  activeProjectId: string | null;
  roots: string[];
}

const DEFAULTS: AppSettingsData = {
  wizardCompleted: false,
  activeProjectId: null,
  roots: [],
  notifyTurnCompleted: true,
  notifyApprovals: true,
  closeToTray: false,
  theme: "light",
  updateFeedUrl: null,
};

export class AppSettings {
  private data: AppSettingsData = { ...DEFAULTS };
  private readonly file: string;

  constructor(app: App) {
    this.file = join(app.getPath("userData"), "settings.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<AppSettingsData>;
      this.data = {
        wizardCompleted: Boolean(raw.wizardCompleted),
        activeProjectId: typeof raw.activeProjectId === "string" ? raw.activeProjectId : null,
        roots: Array.isArray(raw.roots) ? raw.roots.filter((r): r is string => typeof r === "string") : [],
        notifyTurnCompleted: raw.notifyTurnCompleted === undefined ? true : Boolean(raw.notifyTurnCompleted),
        notifyApprovals: raw.notifyApprovals === undefined ? true : Boolean(raw.notifyApprovals),
        closeToTray: Boolean(raw.closeToTray),
        theme: raw.theme === "dark" ? "dark" : "light",
        updateFeedUrl: typeof raw.updateFeedUrl === "string" ? raw.updateFeedUrl : null,
      };
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt`);
      } catch {
        /* 忽略备份失败 */
      }
      this.data = { ...DEFAULTS };
    }
  }

  get(): AppSettingsData {
    return { ...this.data, roots: [...this.data.roots] };
  }

  update(patch: Partial<AppSettingsData>): AppSettingsData {
    this.data = { ...this.data, ...patch };
    const tmp = `${this.file}.tmp`;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
    return this.get();
  }

  addRoots(paths: readonly string[]): string[] {
    const set = new Set(this.data.roots);
    for (const p of paths) set.add(p);
    return this.update({ roots: [...set] }).roots;
  }
}
