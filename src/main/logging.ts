/**
 * 文件日志：写入 userData/logs/cc-YYYY-MM-DD.log，按天 + 保留数量轮转。
 * 所有落盘文本经过 maskSecrets 脱敏；不依赖 electron（logDir 由外部注入），
 * 以便纯 Node 测试脚本直接复用本模块。
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { WriteStream } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const KEEP_FILES = 7;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 脱敏：覆盖 Bearer/JWT/sk- key，以及 token/apikey/authorization/secret 等键值。
 */
export function maskSecrets(input: string): string {
  let out = input;
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/_-]{8,}/g, "Bearer ***");
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***JWT***");
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***");
  out = out.replace(
    /((?:api[_-]?key|auth(?:orization)?[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd)\s*["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    (_m, head: string) => `${head}***`,
  );
  return out;
}

function dayStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class Logger {
  private stream: WriteStream | null = null;
  private currentFile: string | null = null;
  private minLevel: LogLevel = "debug";

  /** app ready 后调用；重复调用会先关闭旧句柄。 */
  init(logDir: string, minLevel: LogLevel = "debug"): void {
    this.close();
    this.minLevel = minLevel;
    mkdirSync(logDir, { recursive: true });
    this.rotateIfNeeded(logDir);
    this.currentFile = join(logDir, `cc-${dayStamp()}.log`);
    this.stream = createWriteStream(this.currentFile, { flags: "a" });
    this.info("logging", { logDir, file: this.currentFile });
  }

  get filePath(): string | null {
    return this.currentFile;
  }

  private rotateIfNeeded(logDir: string): void {
    if (!existsSync(logDir)) return;
    const files = readdirSync(logDir)
      .filter((f) => /^cc-.*\.log$/.test(f))
      .map((f) => ({ f, mtime: statSync(join(logDir, f)).mtimeMs, size: statSync(join(logDir, f)).size }))
      .sort((a, b) => b.mtime - a.mtime);
    // 超保留数量的旧文件删除
    for (const old of files.slice(KEEP_FILES)) {
      try {
        unlinkSync(join(logDir, old.f));
      } catch {
        /* ignore */
      }
    }
    // 当天文件过大则归档（加序号）
    const today = `cc-${dayStamp()}.log`;
    const current = files.find((x) => x.f === today);
    if (current && current.size > MAX_FILE_BYTES) {
      let i = 1;
      let archive = join(logDir, `cc-${dayStamp()}.${i}.log`);
      while (existsSync(archive)) archive = join(logDir, `cc-${dayStamp()}.${++i}.log`);
      try {
        renameSync(join(logDir, today), archive);
      } catch {
        /* ignore */
      }
    }
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
    const time = new Date().toISOString();
    let line = `${time} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (meta !== undefined) {
      try {
        const json = JSON.stringify(meta, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
        line += ` ${json}`;
      } catch {
        line += " [unserializable meta]";
      }
    }
    line = maskSecrets(line);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    this.stream?.write(`${line}\n`);
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }
  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }
  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }
  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  async close(): Promise<void> {
    const stream = this.stream;
    if (!stream) {
      this.currentFile = null;
      return;
    }
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
      // end 回调在异常情况下可能不来，兜底 1s
      setTimeout(resolve, 1000).unref?.();
    });
    this.stream = null;
    this.currentFile = null;
  }
}

export const logger = new Logger();
