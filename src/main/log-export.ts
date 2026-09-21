/**
 * 诊断日志导出：logs 目录副本 + 脱敏环境摘要，打包为 zip。
 * 使用 PowerShell Compress-Archive（Windows 自带，免 zip 原生依赖）。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSecrets } from "./logging.ts";
import { logger } from "./logging.ts";

function runPowerShellCompress(srcDir: string, destZip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Path (Join-Path '${srcDir.replace(/'/g, "''")}' *) -DestinationPath '${destZip.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true },
    );
    let err = "";
    child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Compress-Archive 失败: ${err.trim()}`))));
  });
}

/** 导出诊断 zip：logs 目录副本 + 脱敏环境摘要；返回生成的 zip 路径。 */
export async function exportLogs(
  logsDir: string,
  envSummary: Record<string, unknown>,
  savePath: string,
): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "cc-diag-"));
  try {
    const bundleDir = join(work, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    if (existsSync(logsDir)) {
      cpSync(logsDir, join(bundleDir, "logs"), { recursive: true });
    }
    writeFileSync(join(bundleDir, "env-summary.json"), JSON.stringify(envSummary, null, 2), "utf8");
    await runPowerShellCompress(bundleDir, savePath);
    logger.info("诊断包导出", { savePath });
    return savePath;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 脱敏后的环境摘要（导出前调用，避免明文密钥入包）。 */
export function buildEnvSummary(extra: Record<string, unknown>): Record<string, unknown> {
  const masked = JSON.stringify(extra, null, 2);
  return { generatedAt: new Date().toISOString(), summary: JSON.parse(maskSecrets(masked)) };
}
