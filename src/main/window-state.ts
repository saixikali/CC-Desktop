/**
 * 窗口状态持久化：bounds + 最大化标记，存 userData/window-state.json。
 * 恢复时校验 bounds 至少有一个角仍在当前显示器工作区内，
 * 避免外接显示器断开后窗口恢复到屏幕外。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { screen } from "electron";
import type { App, BrowserWindow, Rectangle } from "electron";

export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

const DEFAULTS: WindowState = {
  bounds: { x: 120, y: 80, width: 1280, height: 832 },
  maximized: false,
};

function isVisible(rect: Rectangle): boolean {
  const minW = 120;
  const minH = 80;
  const corners: Array<[number, number]> = [
    [rect.x, rect.y],
    [rect.x + rect.width - minW, rect.y],
    [rect.x, rect.y + rect.height - minH],
    [rect.x + rect.width - minW, rect.y + rect.height - minH],
  ];
  return corners.some(([x, y]) =>
    screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;
    }),
  );
}

export class WindowStateStore {
  private readonly file: string;
  private state: WindowState;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App) {
    this.file = join(app.getPath("userData"), "window-state.json");
    this.state = this.load();
  }

  private load(): WindowState {
    if (!existsSync(this.file)) return DEFAULTS;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<WindowState>;
      const b = raw.bounds;
      if (
        b &&
        typeof b.x === "number" &&
        typeof b.y === "number" &&
        typeof b.width === "number" &&
        typeof b.height === "number" &&
        b.width >= 960 &&
        b.height >= 600 &&
        isVisible(b)
      ) {
        return { bounds: { ...b }, maximized: Boolean(raw.maximized) };
      }
      return DEFAULTS;
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt`);
      } catch {
        /* 忽略 */
      }
      return DEFAULTS;
    }
  }

  get(): WindowState {
    return { bounds: { ...this.state.bounds }, maximized: this.state.maximized };
  }

  /** 从当前窗口采集状态（防抖写盘，避免拖动时频繁 IO）。 */
  track(win: BrowserWindow): void {
    const save = () => {
      if (win.isDestroyed()) return;
      this.state.maximized = win.isMaximized();
      if (!this.state.maximized) this.state.bounds = win.getBounds();
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 400);
    };
    win.on("resize", save);
    win.on("move", save);
    win.on("maximize", save);
    win.on("unmaximize", save);
  }

  private flush(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf8");
    } catch {
      /* 状态写盘失败不影响运行 */
    }
  }
}
