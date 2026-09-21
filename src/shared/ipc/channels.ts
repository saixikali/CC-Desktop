/**
 * IPC 通道与推送事件常量（零运行时依赖，供 sandbox preload 直接引用）。
 * zod schema 与业务类型见 contract.ts。
 */
export const CHANNELS = {
  app: {
    version: "app:version",
    windowControl: "app:window-control",
    windowState: "app:window-state",
    pickDirectory: "app:pick-directory",
    pickFile: "app:pick-file",
    showItem: "app:show-item",
    openExternal: "app:open-external",
    openLogsDir: "app:open-logs-dir",
    chatSpace: "app:chat-space",
  },
  backend: {
    status: "backend:status",
    restart: "backend:restart",
    wizardGet: "backend:wizard-get",
    wizardComplete: "backend:wizard-complete",
    setActiveProject: "backend:set-active-project",
  },
  projects: {
    list: "projects:list",
    read: "projects:read",
    create: "projects:create",
    update: "projects:update",
    remove: "projects:delete",
  },
  threads: {
    list: "threads:list",
    read: "threads:read",
    start: "threads:start",
    startChat: "threads:start-chat",
    resume: "threads:resume",
    archive: "threads:archive",
    unarchive: "threads:unarchive",
    remove: "threads:delete",
    turns: "threads:turns",
    search: "threads:search",
    setName: "threads:set-name",
  },
  turn: {
    start: "turn:start",
    steer: "turn:steer",
    interrupt: "turn:interrupt",
  },
  approvals: {
    list: "approvals:list",
    resolveCommand: "approvals:resolve-command",
    resolveFileChange: "approvals:resolve-file-change",
    respondError: "approvals:respond-error",
  },
  fs: {
    readFile: "fs:read-file",
    readDirectory: "fs:read-directory",
  },
  process: {
    spawn: "process:spawn",
    writeStdin: "process:write-stdin",
    resizePty: "process:resize-pty",
    kill: "process:kill",
  },
  stats: {
    usage: "stats:usage",
  },
  settings: {
    account: "settings:account",
    exportLogs: "settings:export-logs",
    prefsGet: "settings:prefs-get",
    prefsSet: "settings:prefs-set",
    updateGet: "settings:update-get",
    updateCheck: "settings:update-check",
    updateDownload: "settings:update-download",
    updateInstall: "settings:update-install",
  },
} as const;

/** 主进程 → 渲染进程推送事件（统一走 cc:event 通道，event 字段取下列值）。 */
export const EVENTS = {
  backendStatus: "backend:status-changed",
  approvalChanged: "approval:changed",
  /** 会话后端（Claude Code）推送的通知信封 { method, params }。 */
  backendNotification: "backend:notification",
  /** 窗口最大化/还原状态变化，载荷 { maximized: boolean }。 */
  appWindowState: "app:window-state-changed",
  /** 自动更新状态广播（UpdateState）。 */
  updateState: "update:state-changed",
  processOutputDelta: "process:output-delta",
  processExited: "process:exited",
  /** 托盘/第二实例请求：显示并聚焦窗口。 */
  appShow: "app:show",
  /** 托盘菜单请求新建会话。 */
  appNewThread: "app:new-thread",
  /** 第二实例携带目录参数：载荷 { path }。 */
  appOpenPath: "app:open-path",
} as const;

export type PushEventName = (typeof EVENTS)[keyof typeof EVENTS];
