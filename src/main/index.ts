import { app, BrowserWindow, Menu } from "electron";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AppSettings } from "./app-settings.ts";
import { BackendService } from "./backend-service.ts";
import { ClaudeBackend } from "./claude-backend/claude-backend.ts";
import { ProjectsStore } from "./projects-store.ts";
import { registerIpc } from "./ipc/register-ipc.ts";
import { NotificationService } from "./notifications.ts";
import { TerminalService } from "./pty/terminal-service.ts";
import { TrayService } from "./tray.ts";
import { UpdateService } from "./update-service.ts";
import { createMainWindow, installContentSecurityPolicy } from "./window.ts";
import { WindowStateStore } from "./window-state.ts";
import { EVENTS } from "../shared/ipc/contract.ts";

const SELFTEST = process.env["CC_SELFTEST"] === "1";

app.setName("CC Desktop");
if (SELFTEST) {
  app.setPath("userData", join(tmpdir(), "cc-selftest-userdata"));
}
// Windows 通知归因（AppUserModelID）；打包后可用 appId 替换。
app.setAppUserModelId("com.cc.desktop");
// 打包后注册 cc-desktop:// 协议（开发环境不写注册表，避免关联 electron.exe）。
if (app.isPackaged && process.platform === "win32") {
  app.setAsDefaultProtocolClient("cc-desktop");
}

// 单实例：避免两个实例同时操作 ~/.claude 会话状态与 userData 登记表。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let backend: BackendService | null = null;
let claudeBackend: ClaudeBackend | null = null;
let tray: TrayService | null = null;
let windowState: WindowStateStore | null = null;
let isQuitting = false;
const terminal = new TerminalService((event, payload) => broadcast(event, payload));
let updater: UpdateService | null = null;

/**
 * 从命令行参数解析要打开的目录：
 *  - cc-desktop://open?path=<dir>
 *  - 直接传入的目录路径
 * 最小处理：仅做存在性校验，后续新建会话交给渲染层。
 */
function parseOpenArg(argv: readonly string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("cc-desktop://")) {
      try {
        const url = new URL(arg);
        const p = url.searchParams.get("path");
        if (p && isAbsolute(p) && existsSync(p) && statSync(p).isDirectory()) return p;
      } catch {
        /* 非法 URL 忽略 */
      }
      continue;
    }
    if (arg.startsWith("-") || !isAbsolute(arg)) continue;
    try {
      if (existsSync(arg) && statSync(arg).isDirectory()) return arg;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

function broadcast(event: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cc:event", { event, payload });
  }
}

function showWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 最大化/还原时通知渲染层切换标题栏按钮图标（单方框 ⇄ 双叠方框）。 */
function bindWindowStateEvents(win: BrowserWindow): void {
  const emit = (maximized: boolean) => {
    if (!win.isDestroyed()) {
      win.webContents.send("cc:event", {
        event: EVENTS.appWindowState,
        payload: { maximized },
      });
    }
  };
  win.on("maximize", () => emit(true));
  win.on("unmaximize", () => emit(false));
}

/**
 * 仅在 CC_SELFTEST=1 时运行的端内安全自检（取证用），
 * 正常启动路径不会执行。结果经 stdout 打印后退出。
 */
async function runSelfTest(win: BrowserWindow): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && backend?.getStatus().state !== "ready") await sleep(500);

  const probeRoot = join(tmpdir(), "cc-selftest-root");
  const result = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    out.requireType = typeof require;
    out.processType = typeof process;
    out.ccPresent = !!window.cc;
    out.bridgeKeys = window.cc ? Object.keys(window.cc) : [];
    try { (0, eval)("1+1"); out.evalBlocked = false; } catch { out.evalBlocked = true; }
    try {
      const r = await fetch(location.href);
      out.cspHeader = r.headers.get("content-security-policy");
    } catch (e) { out.cspHeader = "fetch-error:" + e.message; }
    try {
      await window.cc.backend.wizardComplete({ projectPath: ${JSON.stringify(probeRoot)} });
      out.wizard = "ok";
    } catch (e) { out.wizard = "err:" + (e.code || e.message); }
    try {
      await window.cc.fs.readFile({ path: ${JSON.stringify(probeRoot)} + "\\\\..\\\\..\\\\secret.txt" });
      out.traversal = "allowed(!)";
    } catch (e) { out.traversal = e.code || e.message; }
    try {
      await window.cc.threads.resume({});
      out.malformed = "accepted(!)";
    } catch (e) { out.malformed = e.code || e.message; }
    out.status = (await window.cc.backend.status()).state;
    return out;
  })()`);

  // eslint-disable-next-line no-console
  console.log("CC_SELFTEST_RESULT " + JSON.stringify(result));
  await backend?.stop();
  await sleep(300);
  app.exit(0);
}

if (gotLock) {
  app.on("second-instance", (_event, argv) => {
    showWindow();
    const openPath = parseOpenArg(argv);
    if (openPath) broadcast(EVENTS.appOpenPath, { path: openPath });
    else broadcast(EVENTS.appShow);
  });
}

// 正常关闭窗口即退出（Windows/Linux）；closeToTray 拦截时窗口仅 hide，
// 不会触发本事件，托盘常驻由此自然成立。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 退出前停掉内置终端进程与 Claude 会话进程，避免残留进程占用工作目录。
let quitting = false;
app.on("before-quit", (event) => {
  isQuitting = true;
  if (quitting) {
    event.preventDefault();
    app.exit(0);
    return;
  }
  event.preventDefault();
  quitting = true;
  terminal.killAll();
  void claudeBackend?.dispose();
  tray?.destroy();
  setTimeout(() => app.exit(0), 1500);
});

if (gotLock) {
app
  .whenReady()
  .then(async () => {
    installContentSecurityPolicy();
    Menu.setApplicationMenu(null);

    const settings = new AppSettings(app);
    const projects = new ProjectsStore(app);
    windowState = new WindowStateStore(app);
    backend = new BackendService(app, app.getVersion());
    backend.on("status", (snapshot) => {
      broadcast(EVENTS.backendStatus, snapshot);
      tray?.setStatus(snapshot);
    });
    updater = new UpdateService(broadcast, () => settings.get().updateFeedUrl ?? null);

    // 唯一会话引擎：Claude Code（每线程常驻 query 流）。
    const claudeConv = new ClaudeBackend(app.getPath("userData"));
    claudeBackend = claudeConv;
    claudeConv.on("notification", (envelope) => broadcast(EVENTS.backendNotification, envelope));
    claudeConv.on("approval", (approval) => broadcast(EVENTS.approvalChanged, approval));

    const logsDir = join(app.getPath("userData"), "logs");
    registerIpc(
      {
        backend,
        settings,
        projects,
        terminal,
        logsDir,
        update: updater,
        usageDir: join(app.getPath("userData"), "claude-backend"),
        getWindow: () => mainWindow,
        conversation: claudeConv,
      },
      app.getVersion(),
    );

    const notifications = new NotificationService(
      claudeConv,
      () => mainWindow,
      () => settings.get(),
      broadcast,
    );
    notifications.bind();

    tray = new TrayService({
      getWindow: () => mainWindow,
      onNewThread: () => broadcast(EVENTS.appNewThread),
      onQuit: () => app.quit(),
    });

    mainWindow = await createMainWindow(windowState.get());
    windowState.track(mainWindow);
    bindWindowStateEvents(mainWindow);
    mainWindow.on("close", (event) => {
      // 关闭到托盘：拦截并隐藏；真正退出（托盘菜单/before-quit）时放行。
      if (!isQuitting && settings.get().closeToTray) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    // 首个实例启动携带的目录参数，等渲染层加载完再投递。
    const openPath = parseOpenArg(process.argv);
    if (openPath) {
      mainWindow.webContents.once("did-finish-load", () =>
        broadcast(EVENTS.appOpenPath, { path: openPath }),
      );
    }

    // 内置 Claude Code 引擎探活（SDK 平台原生包），失败不阻塞 UI（横幅展示）。
    backend.init();
    updater.startAutoCheck();
    void backend.probe().finally(() => {
      if (SELFTEST && mainWindow) void runSelfTest(mainWindow);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow(windowState?.get()).then((win) => {
          mainWindow = win;
          windowState?.track(win);
          bindWindowStateEvents(win);
        });
      } else {
        showWindow();
      }
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("应用启动失败", err);
  });
}
