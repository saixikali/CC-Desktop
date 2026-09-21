/**
 * 注册全部 ipcMain.handle：
 *  - 入参统一经 shared/contract 的 zod 校验（非法 → BAD_REQUEST 信封，不抛异常到渲染层）
 *  - 后端错误/越权路径全部归一为 IpcErrorShape
 *  - fs 读取强制 roots 白名单；threads start/resume 成功后自动登记新 roots
 */
import { basename, join } from "node:path";
import { homedir, release } from "node:os";
import { app, dialog, ipcMain, shell, BrowserWindow } from "electron";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import {
  CHANNELS as C,
  INPUTS,
  type IpcErrorShape,
  type IpcResult,
  type LocalPrefs,
  type WizardState,
} from "../../shared/ipc/contract.ts";
import type { AppSettings } from "../app-settings.ts";
import type { ProjectsStore } from "../projects-store.ts";
import type { BackendService } from "../backend-service.ts";
import type { ConversationBackend } from "../backend/conversation-backend.ts";
import { aggregateUsage, loadUsage } from "../claude-backend/usage-ledger.ts";
import { normProjectRoot } from "../projects-store.ts";
import { buildEnvSummary, exportLogs } from "../log-export.ts";
import { logger } from "../logging.ts";
import type { TerminalService } from "../pty/terminal-service.ts";
import type { UpdateService } from "../update-service.ts";
import { assertWithinRoots } from "./path-guard.ts";

interface HandlerContext {
  /** 引擎状态中心（探活快照，托盘/横幅/向导展示用）。 */
  backend: BackendService;
  settings: AppSettings;
  projects: ProjectsStore;
  terminal: TerminalService;
  logsDir: string;
  update: UpdateService;
  /** 用量台账目录（userData/claude-backend）。 */
  usageDir: string;
  appVersion: string;
  getWindow: () => BrowserWindow | null;
  /** 会话主轴：Claude Code 后端（唯一引擎）。 */
  conversation: ConversationBackend;
}

type AnyHandler = (ctx: HandlerContext, input: any, appVersion: string) => Promise<unknown> | unknown;

/* ---------------- 纯对话（日常聊天） ---------------- */

/**
 * 纯对话会话统一使用的托管工作目录（userData/chat-space）。
 * 会话线程必须有 cwd，该目录仅作中性载体：只读沙箱 + 免审批，
 * 渲染层据此路径识别"纯对话"会话，与任务/工作区会话隔离展示。
 */
function chatSpaceDir(): string {
  return join(app.getPath("userData"), "chat-space");
}

async function ensureChatSpace(): Promise<string> {
  const dir = chatSpaceDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

function errorShape(err: unknown): IpcErrorShape {
  if (err instanceof z.ZodError) {
    return { code: "BAD_REQUEST", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  if (err instanceof Error && err.name === "ForbiddenPathError") {
    return { code: "FORBIDDEN_PATH", message: err.message };
  }
  if (err instanceof Error) {
    logger.error("IPC 处理失败", { name: err.name, message: err.message });
    return { code: "INTERNAL", message: err.message };
  }
  return { code: "INTERNAL", message: String(err) };
}

/** 从 start/resume 响应中提取工作区 roots 并登记。 */
function collectRoots(res: unknown): string[] {
  if (!res || typeof res !== "object") return [];
  const r = res as Record<string, unknown>;
  const roots: string[] = [];
  if (typeof r.cwd === "string") roots.push(r.cwd);
  if (r.thread && typeof r.thread === "object") {
    const t = r.thread as Record<string, unknown>;
    if (typeof t.cwd === "string") roots.push(t.cwd);
  }
  return roots;
}

/**
 * Claude Code 接入状态：识别本机登录/中转配置，供侧栏与设置页展示。
 *  - 官方账号登录：~/.claude.json 的 oauthAccount.emailAddress
 *  - API 中转：~/.claude/settings.json env 块的 ANTHROPIC_BASE_URL + 令牌变量
 * 防御式解析，任何失败按未配置处理；绝不返回令牌原文，只回主机名与方式。
 */
interface ClaudeAuthInfo {
  authMode: "oauth" | "api" | "none";
  email: string | null;
  apiHost: string | null;
}

async function claudeAuthInfo(): Promise<ClaudeAuthInfo> {
  // 官方账号：~/.claude.json oauthAccount
  try {
    const file = join(homedir(), ".claude.json");
    if (existsSync(file)) {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const oauth = raw["oauthAccount"] as Record<string, unknown> | undefined;
      const email = typeof oauth?.["emailAddress"] === "string" ? oauth["emailAddress"] : null;
      if (email && email.includes("@")) return { authMode: "oauth", email, apiHost: null };
    }
  } catch {
    /* 忽略，继续探测中转配置 */
  }
  // API 中转：~/.claude/settings.json env.ANTHROPIC_BASE_URL + 令牌变量
  try {
    const file = join(homedir(), ".claude", "settings.json");
    if (existsSync(file)) {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const env = (raw["env"] ?? {}) as Record<string, unknown>;
      const hasToken =
        typeof env["ANTHROPIC_AUTH_TOKEN"] === "string" ||
        typeof env["ANTHROPIC_API_KEY"] === "string";
      const base = typeof env["ANTHROPIC_BASE_URL"] === "string" ? env["ANTHROPIC_BASE_URL"] : null;
      if (hasToken && base) {
        try {
          const host = new URL(base).host;
          if (host) return { authMode: "api", email: null, apiHost: host };
        } catch {
          /* 非法 URL，按未配置处理 */
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  return { authMode: "none", email: null, apiHost: null };
}

const HANDLERS: Record<string, AnyHandler> = {
  // ---------- app ----------
  [C.app.version]: async (_ctx, _i, appVersion) => appVersion,
  [C.app.windowControl]: async (ctx, input: { action: string }) => {
    const win = ctx.getWindow();
    if (!win) return null;
    if (input.action === "minimize") win.minimize();
    else if (input.action === "close") win.close();
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return null;
  },
  // 渲染层标题栏据此初始化最大化按钮图标（事件推送见 index.ts 的窗口监听）。
  [C.app.windowState]: async (ctx) => {
    const win = ctx.getWindow();
    return { maximized: win ? win.isMaximized() : false };
  },
  [C.app.pickDirectory]: async (_ctx, input) => {
    const r = await dialog.showOpenDialog({
      title: "选择工作目录",
      defaultPath: input?.defaultPath,
      properties: ["openDirectory", "treatPackageAsDirectory"],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  [C.app.pickFile]: async (_ctx, input) => {
    const r = await dialog.showOpenDialog({
      title: input?.title ?? "选择文件",
      defaultPath: input?.defaultPath,
      properties: ["openFile", "treatPackageAsDirectory"],
      filters: input?.filters,
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  [C.app.showItem]: async (_ctx, input: { path: string }) => {
    shell.showItemInFolder(input.path);
    return null;
  },
  [C.app.openExternal]: async (_ctx, input: { url: string }) => {
    // schema 已限制 http/https，这里再兜底校验一次。
    if (!/^https?:\/\//i.test(input.url)) throw new Error("仅允许 http/https 链接");
    await shell.openExternal(input.url);
    return null;
  },
  [C.app.openLogsDir]: async (ctx) => {
    const err = await shell.openPath(ctx.logsDir);
    if (err) throw new Error(err);
    return null;
  },
  [C.app.chatSpace]: async () => ensureChatSpace(),

  // ---------- backend / wizard ----------
  [C.backend.status]: async (ctx) => ctx.backend.getStatus(),
  [C.backend.restart]: async (ctx, input?: { reason?: string }) => ctx.backend.restart(input?.reason),
  [C.backend.wizardGet]: async (ctx): Promise<WizardState> => {
    const s = ctx.settings.get();
    return { completed: s.wizardCompleted, activeProjectId: s.activeProjectId, roots: s.roots };
  },
  [C.backend.wizardComplete]: async (ctx, input: { projectPath: string; title?: string }) => {
    ctx.settings.addRoots([input.projectPath]);
    // 同一目录重复完成向导时复用已有工作区，不再产生重复记录。
    const existing = ctx.projects.findWithRoots([input.projectPath]);
    let project;
    if (existing) {
      project = existing;
      ctx.settings.update({
        wizardCompleted: true,
        activeProjectId: existing.id,
      });
    } else {
      project = ctx.projects.create({
        name: input.title?.trim() || basename(input.projectPath),
        roots: [{ path: input.projectPath }],
      });
      ctx.settings.update({
        wizardCompleted: true,
        activeProjectId: project.id,
      });
    }
    return { project, degraded: false };
  },
  [C.backend.setActiveProject]: async (ctx, input: { projectId: string | null }) => {
    ctx.settings.update({ activeProjectId: input.projectId });
    return null;
  },

  // ---------- projects（本地注册表） ----------
  [C.projects.list]: (ctx, i) => ctx.projects.list(i ?? {}),
  [C.projects.read]: (ctx, i) => ctx.projects.read(i),
  [C.projects.create]: async (ctx, i) => {
    const rootPaths = (i.roots ?? []).map((r: { path: string }) => r.path).filter(Boolean);
    // 同目录集合的工作区已存在时直接复用（侧栏新建与向导共用去重规则）。
    if (rootPaths.length > 0) {
      const existing = ctx.projects.findWithRoots(rootPaths);
      if (existing) return { project: existing };
    }
    return { project: ctx.projects.create(i) };
  },
  [C.projects.update]: (ctx, i) => ctx.projects.update(i),
  [C.projects.remove]: (ctx, i) => ctx.projects.remove(i),

  // ---------- threads ----------
  [C.threads.list]: async (ctx, i) => ctx.conversation.listThreads(i ?? {}),
  [C.threads.read]: (ctx, i) => ctx.conversation.readThread(i),
  [C.threads.start]: async (ctx, i) => {
    const res = await ctx.conversation.startThread(i);
    ctx.settings.addRoots(collectRoots(res));
    return res;
  },
  // 纯对话：托管中性目录 + 只读语义 + 免审批；不登记进用户工作区 roots。
  [C.threads.startChat]: async (ctx) => {
    const cwd = await ensureChatSpace();
    return ctx.conversation.startThread({
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  },
  [C.threads.resume]: async (ctx, i) => {
    const res = await ctx.conversation.resumeThread(i);
    // 纯对话会话的托管目录不出现在向导最近目录里。
    const roots = collectRoots(res).filter(
      (r) => normProjectRoot(r) !== normProjectRoot(chatSpaceDir()),
    );
    ctx.settings.addRoots(roots);
    return res;
  },
  [C.threads.archive]: (ctx, i) => ctx.conversation.archiveThread(i),
  [C.threads.unarchive]: (ctx, i) => ctx.conversation.unarchiveThread(i),
  [C.threads.remove]: (ctx, i) => ctx.conversation.deleteThread(i),
  [C.threads.turns]: (ctx, i) => ctx.conversation.listTurns(i),
  [C.threads.search]: (ctx, i) => ctx.conversation.searchThreads(i ?? {}),
  [C.threads.setName]: (ctx, i) => ctx.conversation.setThreadName(i),

  // ---------- turn ----------
  [C.turn.start]: (ctx, i) => ctx.conversation.startTurn(i),
  [C.turn.steer]: (ctx, i) => ctx.conversation.steerTurn(i),
  [C.turn.interrupt]: (ctx, i) => ctx.conversation.interruptTurn(i),

  // ---------- approvals ----------
  [C.approvals.list]: (ctx) => ctx.conversation.approvals.list(),
  // 决议必须真正送达后端：不可用时抛错，渲染层保留卡片并提示重试，
  // 绝不能静默回 null 让用户误以为已决议（后端会永久挂起等待）。
  [C.approvals.resolveCommand]: async (ctx, i) => {
    await Promise.resolve(ctx.conversation.approvals.resolveCommand(i.localId, i.decision));
    return null;
  },
  [C.approvals.resolveFileChange]: async (ctx, i) => {
    await Promise.resolve(ctx.conversation.approvals.resolveFileChange(i.localId, i.decision));
    return null;
  },
  [C.approvals.respondError]: async (ctx, i) => {
    await Promise.resolve(ctx.conversation.approvals.respondError(i.localId, i.code, i.message, i.data));
    return null;
  },

  // ---------- fs（roots 白名单，本地直读） ----------
  [C.fs.readFile]: async (ctx, input: { path: string }) => {
    const target = assertWithinRoots(ctx.settings.get().roots, input.path);
    const buf = await readFile(target);
    return { dataBase64: buf.toString("base64"), source: "local" as const };
  },
  [C.fs.readDirectory]: async (ctx, input: { path: string }) => {
    const target = assertWithinRoots(ctx.settings.get().roots, input.path);
    const entries = await readdir(target, { withFileTypes: true });
    return { entries: entries.map((d) => ({ name: d.name, isDirectory: d.isDirectory() })), source: "local" as const };
  },

  // ---------- process（内置终端，ConPTY） ----------
  [C.process.spawn]: (ctx, i?: { cwd?: string; shell?: string; title?: string }) => {
    // 仅接受落在已授权 roots 内的 cwd；非法时回退默认工作区根。
    // shell 一律忽略：渲染端无权指定任意可执行文件，只允许主进程候选探测。
    const roots = ctx.settings.get().roots;
    const defaultCwd = roots[0] ?? homedir();
    let cwd = defaultCwd;
    if (i?.cwd) {
      try {
        cwd = assertWithinRoots(roots, i.cwd);
      } catch {
        logger.warn("终端请求的 cwd 不在授权 roots 内，已回退默认", { cwd: i.cwd });
      }
    }
    return ctx.terminal.spawn(i ? { title: i.title } : {}, cwd);
  },
  [C.process.writeStdin]: (ctx, i: { id: string; data: string }) => {
    ctx.terminal.write(i.id, i.data);
    return null;
  },
  [C.process.resizePty]: (ctx, i: { id: string; cols: number; rows: number }) => {
    ctx.terminal.resize(i.id, i.cols, i.rows);
    return null;
  },
  [C.process.kill]: (ctx, i: { id: string }) => {
    ctx.terminal.kill(i.id);
    return null;
  },

  // ---------- stats ----------
  [C.stats.usage]: async (ctx) => aggregateUsage(await loadUsage(ctx.usageDir)),

  // ---------- settings ----------
  [C.settings.account]: async () => {
    const info = await claudeAuthInfo();
    return { account: { type: "claude", ...info } };
  },
  [C.settings.exportLogs]: async (ctx) => {
    const win = ctx.getWindow();
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
      title: "导出诊断日志",
      defaultPath: `cc-diag-${stamp}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (r.canceled || !r.filePath) return null;
    const s = ctx.settings.get();
    const summary = buildEnvSummary({
      app: { version: ctx.appVersion },
      runtime: {
        platform: process.platform,
        osRelease: release(),
        electron: process.versions.electron,
        node: process.versions.node,
      },
      settings: {
        wizardCompleted: s.wizardCompleted,
        activeProjectId: s.activeProjectId,
        roots: s.roots,
        notifyTurnCompleted: s.notifyTurnCompleted,
        notifyApprovals: s.notifyApprovals,
        closeToTray: s.closeToTray,
      },
    });
    return exportLogs(ctx.logsDir, summary, r.filePath);
  },
  // ---------- update ----------
  [C.settings.updateGet]: (ctx) => ctx.update.getState(),
  [C.settings.updateCheck]: async (ctx) => ctx.update.checkNow(),
  [C.settings.updateDownload]: async (ctx) => ctx.update.download(),
  [C.settings.updateInstall]: (ctx) => {
    ctx.update.install();
    return null;
  },

  [C.settings.prefsGet]: (ctx): LocalPrefs => {
    const s = ctx.settings.get();
    return {
      notifyTurnCompleted: s.notifyTurnCompleted,
      notifyApprovals: s.notifyApprovals,
      closeToTray: s.closeToTray,
      theme: s.theme,
      updateFeedUrl: s.updateFeedUrl,
    };
  },
  [C.settings.prefsSet]: (ctx, i: Partial<LocalPrefs>): LocalPrefs => {
    const patch: Partial<LocalPrefs> = { ...i };
    // 更新源变更后立即重置状态（下次检查按新源执行）。
    if ("updateFeedUrl" in patch) ctx.update.resetForFeedChange();
    ctx.settings.update(patch);
    const s = ctx.settings.get();
    return {
      notifyTurnCompleted: s.notifyTurnCompleted,
      notifyApprovals: s.notifyApprovals,
      closeToTray: s.closeToTray,
      theme: s.theme,
      updateFeedUrl: s.updateFeedUrl,
    };
  },
};

export function registerIpc(ctx: Omit<HandlerContext, "appVersion">, appVersion: string): void {
  const fullCtx: HandlerContext = { ...ctx, appVersion };
  for (const [channel, schema] of Object.entries(INPUTS)) {
    const handler = HANDLERS[channel];
    if (!handler) {
      logger.error("IPC 通道缺少 handler", { channel });
      continue;
    }
    ipcMain.handle(channel, async (_event, raw): Promise<IpcResult<unknown>> => {
      const parsed = (schema as z.ZodType).safeParse(raw === undefined ? undefined : raw);
      if (!parsed.success) {
        return { ok: false, error: errorShape(parsed.error) };
      }
      try {
        const data = await handler(fullCtx, parsed.data as never, appVersion);
        return { ok: true, data: data ?? null };
      } catch (err) {
        return { ok: false, error: errorShape(err) };
      }
    });
  }
}
