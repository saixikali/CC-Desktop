/**
 * 系统托盘：
 *  - 单击图标切换窗口显示；双击/菜单"显示主界面"恢复
 *  - 菜单：显示/隐藏、新建会话、后端实时状态、退出
 *  - 退出动作设置 isQuitting，窗口 close 拦截据此放行
 */
import {
  app,
  Menu,
  nativeImage,
  Tray,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { BackendStatusSnapshot } from "../shared/ipc/contract.ts";
import { logger } from "./logging.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));

/** dev: <root>/resources；打包后 extraResources 复制到 process.resourcesPath。 */
export function resourcePath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, file)
    : join(currentDir, "..", "..", "resources", file);
}

const STATUS_LABEL: Record<BackendStatusSnapshot["state"], string> = {
  idle: "未启动",
  resolving: "检测引擎…",
  ready: "引擎就绪",
  fatal: "引擎不可用",
};

export interface TrayOptions {
  getWindow: () => BrowserWindow | null;
  onNewThread: () => void;
  onQuit: () => void;
}

export class TrayService {
  private readonly tray: Tray;
  private readonly opts: TrayOptions;
  private statusItem!: Electron.MenuItem;

  constructor(opts: TrayOptions) {
    this.opts = opts;
    const image = nativeImage.createFromPath(resourcePath("tray.png"));
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.tray.setToolTip("CC Desktop");
    this.buildMenu({ state: "idle", claude: null, fatalMessage: null });

    // Windows：左键单击切换显示，右键弹菜单（默认行为）。
    this.tray.on("click", () => this.toggleWindow());
    this.tray.on("double-click", () => this.showWindow());
  }

  private buildMenu(status: BackendStatusSnapshot): void {
    const version = status.claude?.version ? ` · Claude Code ${status.claude.version}` : "";
    const template: MenuItemConstructorOptions[] = [
      {
        id: "show",
        label: "显示主界面",
        click: () => this.showWindow(),
      },
      {
        label: "新建会话",
        click: () => {
          this.showWindow();
          this.opts.onNewThread();
        },
      },
      { type: "separator" },
      {
        id: "status",
        label: `引擎：${STATUS_LABEL[status.state]}${version}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "退出 CC Desktop",
        click: () => this.opts.onQuit(),
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
    this.statusItem = menu.getMenuItemById("status")!;
  }

  showWindow(): void {
    const win = this.opts.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  hideWindow(): void {
    const win = this.opts.getWindow();
    if (win && !win.isDestroyed()) win.hide();
  }

  private toggleWindow(): void {
    const win = this.opts.getWindow();
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      this.showWindow();
    }
  }

  setStatus(status: BackendStatusSnapshot): void {
    const version = status.claude?.version ? ` · Claude Code ${status.claude.version}` : "";
    if (this.statusItem) {
      this.statusItem.label = `引擎：${STATUS_LABEL[status.state]}${version}`;
    }
    this.tray.setToolTip(`CC Desktop — ${STATUS_LABEL[status.state]}`);
  }

  destroy(): void {
    try {
      this.tray.destroy();
    } catch (err) {
      logger.warn("托盘销毁失败", { message: (err as Error).message });
    }
  }
}
