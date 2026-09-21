/**
 * 自动更新服务（electron-updater，generic feed）：
 *  - 更新源地址由用户设置提供（updateFeedUrl），未配置即停用，不产生任何网络请求
 *  - 启动后延迟自动检查 + 每 4 小时轮询；检查/下载/安装均可手动触发
 *  - 状态经 EVENTS.updateState 广播：idle/checking/available/none/downloading/downloaded/error
 *  - 开发模式（未打包）所有动作直接返回不可用，不触碰 electron-updater
 */
import { EventEmitter } from "node:events";
import { app } from "electron";
// electron-updater 为 CJS 包：主进程是 ESM，具名导入会在模块加载期抛错，
// 必须默认导入后再解构。
import updaterModule from "electron-updater";
const { autoUpdater } = updaterModule as unknown as typeof import("electron-updater");
import { EVENTS } from "../shared/ipc/contract.ts";
import { logger } from "./logging.ts";

type Broadcast = (event: string, payload?: unknown) => void;

export type UpdateStatus =
  | "idle"
  | "disabled"
  | "checking"
  | "available"
  | "none"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** 可用的新版本号（available/downloaded 时有值）。 */
  version: string | null;
  /** 下载进度 0-100（downloading 时有值）。 */
  progress: number | null;
  error: string | null;
  /** 最近一次检查时间（epoch ms）。 */
  lastCheckedAt: number | null;
}

const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export class UpdateService extends EventEmitter {
  private state: UpdateState = {
    status: "idle",
    version: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private wired = false;

  constructor(
    private readonly broadcast: Broadcast,
    private readonly getFeedUrl: () => string | null,
  ) {
    super();
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.broadcast(EVENTS.updateState, this.getState());
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  private configured(): string | null {
    const url = this.getFeedUrl();
    return url && /^https?:\/\//i.test(url) ? url : null;
  }

  /** 绑定 electron-updater 事件（打包版首次使用时执行一次）。 */
  private wire(): boolean {
    if (!app.isPackaged) return false;
    if (this.wired) return true;
    try {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on("checking-for-update", () => this.setState({ status: "checking", error: null }));
      autoUpdater.on("update-available", (info) => {
        this.setState({ status: "available", version: info.version ?? null, progress: null });
        logger.info("发现新版本", { version: info.version });
      });
      autoUpdater.on("update-not-available", () => this.setState({ status: "none", version: null }));
      autoUpdater.on("download-progress", (p) => {
        this.setState({ status: "downloading", progress: Math.round(p.percent ?? 0) });
      });
      autoUpdater.on("update-downloaded", (info) => {
        this.setState({ status: "downloaded", version: info.version ?? null, progress: 100 });
        logger.info("更新包下载完成", { version: info.version });
      });
      autoUpdater.on("error", (err) => {
        this.setState({ status: "error", error: err?.message ?? String(err) });
        logger.warn("更新检查失败", { message: err?.message ?? String(err) });
      });
      this.wired = true;
      return true;
    } catch (err) {
      logger.warn("更新服务初始化失败", { message: (err as Error).message });
      return false;
    }
  }

  private async applyFeed(): Promise<boolean> {
    if (!this.wire()) return false;
    const url = this.configured();
    if (!url) {
      this.setState({ status: "disabled", error: null, progress: null });
      return false;
    }
    autoUpdater.setFeedURL({ provider: "generic", url });
    return true;
  }

  /** 启动钩子：已配置更新源时延迟自动检查 + 定时轮询。 */
  startAutoCheck(): void {
    if (!app.isPackaged) return;
    const initial = setTimeout(() => {
      void this.checkNow().catch(() => undefined);
    }, 10_000);
    initial.unref?.();
    this.timer = setInterval(() => {
      void this.checkNow().catch(() => undefined);
    }, AUTO_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** 更新源变更后调用：回到待命状态，下次检查按新源执行。 */
  resetForFeedChange(): void {
    if (!app.isPackaged) return;
    this.state = { status: "idle", version: null, progress: null, error: null, lastCheckedAt: this.state.lastCheckedAt };
    this.emit("state", this.getState());
    this.broadcast(EVENTS.updateState, this.getState());
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkNow(): Promise<UpdateState> {
    if (!(await this.applyFeed())) return this.getState();
    this.setState({ status: "checking", error: null });
    try {
      await autoUpdater.checkForUpdates();
      this.setState({ lastCheckedAt: Date.now() });
    } catch (err) {
      this.setState({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        lastCheckedAt: Date.now(),
      });
    }
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    if (!this.wired) {
      this.setState({ status: "error", error: "开发模式不支持更新" });
      return this.getState();
    }
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
    return this.getState();
  }

  install(): void {
    if (!this.wired) return;
    if (this.state.status !== "downloaded") return;
    this.stop();
    autoUpdater.quitAndInstall(true, true);
  }
}
