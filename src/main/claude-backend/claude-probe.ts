/**
 * Claude Code 引擎探活：定位 Agent SDK 附带的原生 CLI 并执行 --version。
 *  - 依赖 @anthropic-ai/claude-agent-sdk 的平台可选包（claude-agent-sdk-<platform>-<arch>），
 *    打包后该目录在 asar 外（asarUnpack），spawn 前用 existsSync 兜底
 *  - 探活失败不视为致命：Claude 会话首次 startThread 时 SDK 自身仍会再解析一次
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClaudeEngineInfo {
  path: string;
  version: string;
}

function nativeCandidates(appPath: string): string[] {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  // 打包后 appPath 形如 <resources>/app.asar：原生包被 asarUnpack 到 app.asar.unpacked，
  // 真实磁盘文件只在那里，必须优先用 unpacked 路径 spawn（asar 内路径仅 existsSync 可透传）。
  const bases = [appPath];
  if (appPath.endsWith(".asar")) {
    bases.unshift(appPath.slice(0, -".asar".length) + ".asar.unpacked");
  }
  return bases.map((b) => join(b, "node_modules", pkg, exe));
}

/** 探测内置 Claude Code 引擎；不可用时返回 null（不抛错）。 */
export async function probeClaudeEngine(appPath: string, timeoutMs = 15_000): Promise<ClaudeEngineInfo | null> {
  for (const candidate of nativeCandidates(appPath)) {
    if (!existsSync(candidate)) continue;
    try {
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        windowsHide: true,
        timeout: timeoutMs,
      });
      const version = stdout.trim().split(/\r?\n/).find(Boolean) ?? "";
      if (version) return { path: candidate, version };
    } catch {
      /* 尝试下一候选 */
    }
  }
  return null;
}
