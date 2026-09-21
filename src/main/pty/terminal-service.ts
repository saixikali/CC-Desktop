/**
 * 内置终端服务（Task 14）：
 *  - 每个标签一个 ConPTY（node-pty），cwd 默认当前工作区根目录
 *  - 默认 shell 探测：pwsh → powershell → cmd（首个存在的可执行文件）
 *  - outputDelta / exited 经推送事件广播给渲染层
 *  - ConPTY kill 会终止附加的整棵进程树；退出应用前统一 killAll
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import pty from "node-pty";
import type { IPty } from "node-pty";
import { EVENTS, type ProcessSpawnResult } from "../../shared/ipc/contract.ts";
import { logger } from "../logging.ts";

export interface SpawnOptions {
  cwd?: string | undefined;
  shell?: string | undefined;
  title?: string | undefined;
}

/** shell 候选（Windows 优先级从高到低）。 */
const SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe", "cmd.exe"];

function findOnPath(exe: string): string | null {
  const dirs = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const full = join(dir.trim(), exe);
    if (existsSync(full)) return full;
  }
  return null;
}

function resolveShell(requested?: string): string {
  if (requested && requested.endsWith(".exe") && existsSync(requested)) return requested;
  for (const exe of SHELL_CANDIDATES) {
    const found = findOnPath(exe);
    if (found) return found;
  }
  return "cmd.exe";
}

export class TerminalService {
  private readonly ptys = new Map<string, IPty>();
  private readonly broadcast: (event: string, payload: unknown) => void;

  constructor(broadcast: (event: string, payload: unknown) => void) {
    this.broadcast = broadcast;
  }

  spawn(input: SpawnOptions, defaultCwd: string): ProcessSpawnResult {
    const cwd =
      input.cwd && existsSync(input.cwd)
        ? input.cwd
        : existsSync(defaultCwd)
          ? defaultCwd
          : homedir();
    const shell = resolveShell(input.shell);
    const title = input.title?.trim() || basename(cwd) || shell;
    const id = randomUUID();
    let proc: IPty;
    try {
      proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env } as Record<string, string>,
      });
    } catch (e) {
      // node-pty 在系统 ConPTY 子系统异常时会抛 "Cannot launch conpty"（ERROR_INVALID_HANDLE），
      // 多为当前 Windows 会话的控制台宿主状态损坏，注销重登录或重启系统后恢复。
      logger.error("终端 ConPTY 启动失败", {
        message: (e as Error).message,
        stack: (e as Error).stack,
      });
      throw e;
    }
    this.ptys.set(id, proc);
    proc.onData((data) => {
      this.broadcast(EVENTS.processOutputDelta, { id, data });
    });
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(id);
      logger.info("终端进程退出", { id, exitCode });
      this.broadcast(EVENTS.processExited, { id, exitCode });
    });
    logger.info("终端进程启动", { id, shell, cwd });
    return { id, shell, title, cwd };
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.resize(cols, rows);
    } catch {
      // resize 与 exit 竞态时忽略
    }
  }

  /** 手动关闭标签；ConPTY kill 会带走整棵子进程树。 */
  kill(id: string): void {
    const proc = this.ptys.get(id);
    if (!proc) return;
    this.ptys.delete(id);
    try {
      proc.kill();
    } catch (err) {
      logger.warn("终端进程 kill 失败", { id, err: String(err) });
    }
  }

  /** 退出应用前统一清理，防止残留 shell 持有工作目录。 */
  killAll(): void {
    for (const [id, proc] of this.ptys) {
      this.ptys.delete(id);
      try {
        proc.kill();
      } catch {
        /* 已退出则忽略 */
      }
    }
  }
}
