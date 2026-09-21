/**
 * IPC 单一事实契约：
 *  - CHANNELS：所有 invoke 通道与推送事件名（主/渲染/preload 共用，禁止散落字符串）
 *  - INPUTS：每个 invoke 通道的 zod 入参 schema（已知键强校验，未知键透传给后端）
 * 渲染端 window.cc 的类型见本文件末尾 CCBridge。
 */
import { z } from "zod";

export { CHANNELS, EVENTS, type PushEventName } from "./channels.ts";
import { CHANNELS } from "./channels.ts";

const voidInput = z.object({}).strict().optional();
const cursorPage = z
  .object({
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.string().min(1).nullable().optional(),
  })
  .passthrough();

const threadId = z
  .object({ threadId: z.string().min(1) })
  .passthrough();

export const INPUTS = {
  [CHANNELS.app.version]: voidInput,
  [CHANNELS.app.windowState]: voidInput,
  [CHANNELS.app.windowControl]: z
    .object({ action: z.enum(["minimize", "toggleMaximize", "close"]) })
    .strict(),
  [CHANNELS.app.pickDirectory]: z
    .object({ defaultPath: z.string().min(1).optional() })
    .strict()
    .optional(),
  [CHANNELS.app.pickFile]: z
    .object({
      defaultPath: z.string().min(1).optional(),
      title: z.string().max(100).optional(),
      filters: z
        .array(z.object({ name: z.string(), extensions: z.array(z.string()) }))
        .optional(),
    })
    .strict()
    .optional(),
  [CHANNELS.app.showItem]: z.object({ path: z.string().min(1) }).strict(),
  [CHANNELS.app.openExternal]: z
    .object({ url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "仅允许 http/https 链接") })
    .strict(),
  [CHANNELS.app.openLogsDir]: voidInput,
  [CHANNELS.app.chatSpace]: voidInput,

  [CHANNELS.backend.status]: voidInput,
  [CHANNELS.backend.restart]: z.object({ reason: z.string().max(200).optional() }).strict().optional(),
  [CHANNELS.backend.wizardGet]: voidInput,
  [CHANNELS.backend.wizardComplete]: z
    .object({ projectPath: z.string().min(1), title: z.string().max(200).optional() })
    .strict(),
  [CHANNELS.backend.setActiveProject]: z
    .object({ projectId: z.string().min(1).nullable() })
    .strict(),

  [CHANNELS.projects.list]: cursorPage.optional(),
  [CHANNELS.projects.read]: z.object({ projectId: z.string().min(1) }).passthrough(),
  [CHANNELS.projects.create]: z
    .object({
      name: z.string().max(200).optional(),
      roots: z.array(z.object({ path: z.string().min(1) }).passthrough()).optional(),
    })
    .passthrough(),
  [CHANNELS.projects.update]: z.object({ projectId: z.string().min(1) }).passthrough(),
  [CHANNELS.projects.remove]: z.object({ projectId: z.string().min(1) }).passthrough(),

  [CHANNELS.threads.list]: cursorPage.optional(),
  [CHANNELS.threads.read]: threadId,
  [CHANNELS.threads.start]: z.object({ cwd: z.string().min(1) }).passthrough(),
  [CHANNELS.threads.startChat]: voidInput,
  [CHANNELS.threads.resume]: threadId,
  [CHANNELS.threads.archive]: threadId,
  [CHANNELS.threads.unarchive]: threadId,
  [CHANNELS.threads.remove]: threadId,
  [CHANNELS.threads.turns]: z
    .object({
      threadId: z.string().min(1),
      limit: z.number().int().positive().max(200).optional(),
      cursor: z.string().min(1).nullable().optional(),
    })
    .passthrough(),
  [CHANNELS.threads.search]: z.object({ query: z.string().max(500) }).passthrough(),
  [CHANNELS.threads.setName]: z
    .object({ threadId: z.string().min(1), name: z.string().max(200) })
    .passthrough(),

  [CHANNELS.turn.start]: z
    .object({ threadId: z.string().min(1), input: z.array(z.unknown()).min(1) })
    .passthrough(),
  [CHANNELS.turn.steer]: z
    .object({
      threadId: z.string().min(1),
      expectedTurnId: z.string().min(1),
      input: z.array(z.unknown()).min(1),
    })
    .passthrough(),
  [CHANNELS.turn.interrupt]: threadId,

  [CHANNELS.approvals.list]: voidInput,
  [CHANNELS.approvals.resolveCommand]: z
    .object({
      localId: z.string().min(1),
      decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
    })
    .passthrough(),
  [CHANNELS.approvals.resolveFileChange]: z
    .object({
      localId: z.string().min(1),
      decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
    })
    .strict(),
  [CHANNELS.approvals.respondError]: z
    .object({
      localId: z.string().min(1),
      code: z.number().int(),
      message: z.string().max(500),
      data: z.unknown().optional(),
    })
    .strict(),

  [CHANNELS.fs.readFile]: z.object({ path: z.string().min(1) }).strict(),
  [CHANNELS.fs.readDirectory]: z.object({ path: z.string().min(1) }).strict(),

  [CHANNELS.process.spawn]: z
    .object({
      cwd: z.string().min(1).optional(),
      shell: z.string().min(1).max(300).optional(),
      title: z.string().max(100).optional(),
    })
    .strict()
    .optional(),
  [CHANNELS.process.writeStdin]: z
    .object({ id: z.string().min(1), data: z.string().max(64 * 1024) })
    .strict(),
  [CHANNELS.process.resizePty]: z
    .object({
      id: z.string().min(1),
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(2).max(500),
    })
    .strict(),
  [CHANNELS.process.kill]: z.object({ id: z.string().min(1) }).strict(),

  [CHANNELS.stats.usage]: voidInput,
  [CHANNELS.settings.account]: voidInput,
  [CHANNELS.settings.exportLogs]: voidInput,
  [CHANNELS.settings.updateGet]: voidInput,
  [CHANNELS.settings.updateCheck]: voidInput,
  [CHANNELS.settings.updateDownload]: voidInput,
  [CHANNELS.settings.updateInstall]: voidInput,
  [CHANNELS.settings.prefsGet]: voidInput,
  [CHANNELS.settings.prefsSet]: z
    .object({
      notifyTurnCompleted: z.boolean().optional(),
      notifyApprovals: z.boolean().optional(),
      closeToTray: z.boolean().optional(),
      theme: z.enum(["light", "dark"]).optional(),
      updateFeedUrl: z.string().url().nullable().optional(),
    })
    .strict(),
} satisfies Record<string, z.ZodType>;

export type InputOf<C extends keyof typeof INPUTS> = z.infer<(typeof INPUTS)[C]>;

export interface BackendStatusSnapshot {
  /** idle=未探活 resolving=探活中 ready=引擎就绪 fatal=引擎不可用。 */
  state: "idle" | "resolving" | "ready" | "fatal";
  /** 内置 Claude Code 引擎（Agent SDK 自带原生 CLI）探活结果；null = 未检测到。 */
  claude: { path: string; version: string } | null;
  fatalMessage: string | null;
}

export interface WizardState {
  completed: boolean;
  activeProjectId: string | null;
  roots: string[];
}

/** process/spawn 返回：终端标签据此建立 xterm 会话。 */
export interface ProcessSpawnResult {
  id: string;
  /** 实际使用的 shell 可执行文件路径。 */
  shell: string;
  title: string;
  cwd: string;
}

/** process:output-delta 推送载荷。 */
export interface ProcessOutputPayload {
  id: string;
  data: string;
}

/** process:exited 推送载荷。 */
export interface ProcessExitPayload {
  id: string;
  exitCode: number;
}

/** 本机偏好（通知/关闭行为），托盘与通知据此生效。 */
export interface LocalPrefs {
  notifyTurnCompleted: boolean;
  notifyApprovals: boolean;
  closeToTray: boolean;
  theme: "light" | "dark";
  /** 自动更新源（generic feed 的 latest.yml 所在目录 URL）；null = 停用。 */
  updateFeedUrl: string | null;
}

/** 自动更新状态（EVENTS.updateState 载荷 / settings.updateGet 返回值）。 */
export interface UpdateState {
  status: "idle" | "disabled" | "checking" | "available" | "none" | "downloading" | "downloaded" | "error";
  version: string | null;
  progress: number | null;
  error: string | null;
  lastCheckedAt: number | null;
}

/** 统一错误信封：校验失败/后端错误均走此结构，渲染端收到的是可展示消息。 */
export interface IpcErrorShape {
  code: "BAD_REQUEST" | "BACKEND_NOT_READY" | "FORBIDDEN_PATH" | "INTERNAL" | string;
  message: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorShape };
