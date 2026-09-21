/**
 * BackendService：内置 Claude Code 引擎的状态中心。
 *  - 启动/手动触发时对 SDK 平台原生 CLI 做 --version 探活
 *  - 就绪与否通过 BackendStatusSnapshot 广播（托盘/横幅/向导展示）
 *  - 会话进程由 ClaudeBackend 按线程拉起，此处不持有任何子进程
 */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { App } from "electron";
import { logger } from "./logging.ts";
import { probeClaudeEngine } from "./claude-backend/claude-probe.ts";
import type { BackendStatusSnapshot } from "../shared/ipc/contract.ts";

export declare interface BackendService {
  on(event: "status", listener: (snapshot: BackendStatusSnapshot) => void): this;
}

export class BackendService extends EventEmitter {
  private snapshot: BackendStatusSnapshot = {
    state: "idle",
    claude: null,
    fatalMessage: null,
  };
  private probing: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly appVersion: string,
  ) {
    super();
  }

  init(): void {
    const level = process.env["CC_LOG_LEVEL"] === "debug" ? "debug" : "info";
    logger.init(join(this.app.getPath("userData"), "logs"), level);
    logger.info("CC Desktop 启动", { version: this.appVersion });
  }

  /** 探活内置 Claude Code 引擎并广播状态；并发调用共用同一在途请求。 */
  probe(): Promise<void> {
    if (this.probing) return this.probing;
    this.snapshot = { state: "resolving", claude: null, fatalMessage: null };
    this.emit("status", this.getStatus());
    this.probing = probeClaudeEngine(this.app.getAppPath())
      .then((info) => {
        if (info) {
          logger.info("Claude Code 引擎就绪", { path: info.path, version: info.version });
          this.snapshot = { state: "ready", claude: info, fatalMessage: null };
        } else {
          this.snapshot = {
            state: "fatal",
            claude: null,
            fatalMessage: "未检测到内置 Claude Code 引擎（Agent SDK 平台原生包缺失），请重新安装应用",
          };
          logger.warn("未检测到 Claude Code 引擎");
        }
      })
      .catch((err) => {
        this.snapshot = {
          state: "fatal",
          claude: null,
          fatalMessage: `引擎探活失败：${err instanceof Error ? err.message : String(err)}`,
        };
        logger.warn("Claude Code 引擎探活失败", {
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.probing = null;
        this.emit("status", this.getStatus());
      });
    return this.probing;
  }

  getStatus(): BackendStatusSnapshot {
    return {
      ...this.snapshot,
      claude: this.snapshot.claude ? { ...this.snapshot.claude } : null,
    };
  }

  async restart(reason?: string): Promise<BackendStatusSnapshot> {
    logger.warn("重新探测引擎", { reason: reason ?? null });
    await this.probe();
    return this.getStatus();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
