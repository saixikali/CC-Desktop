/**
 * 主窗口与 Web 安全基线：
 *  - nodeIntegration:false / contextIsolation:true / sandbox:true
 *  - CSP 响应头：生产仅 'self'；开发放行 vite HMS(ws)/inline style
 *  - 新窗口一律交给外部浏览器；禁止导航到外部站点
 */
import { BrowserWindow, shell, session, type WebPreferences } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WindowState } from "./window-state.ts";
import { resourcePath } from "./tray.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(currentDir, "../preload/index.cjs");
const rendererDistPath = join(currentDir, "../renderer/index.html");
const rendererDevUrl = process.env["ELECTRON_RENDERER_URL"];

const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
const CSP_DEV =
  "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' http://localhost:* 'unsafe-inline'; style-src 'self' http://localhost:* 'unsafe-inline'; img-src 'self' data: blob: http://localhost:*; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'";

export function installContentSecurityPolicy(): void {
  const csp = rendererDevUrl ? CSP_DEV : CSP_PROD;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
        "X-Content-Type-Options": ["nosniff"],
      },
    });
  });
  // 渲染端不申请摄像头/麦克风/通知（通知走主进程 Notification）等敏感权限，默认全部拒绝，
  // 避免第三方 Markdown 内容越权。仅放行剪贴板写入：设备码登录"复制用户码"等 UI 依赖它
  // （Electron/Chromium 不同版本名称为 clipboard-write 或 clipboard-sanitized-write）。
  // 读取不放行（页面无此需求），半可信内容无法读走用户剪贴板。
  const CLIPBOARD_WRITE_PERMS = new Set(["clipboard-write", "clipboard-sanitized-write"]);
  const isClipboardWrite = (permission: string): boolean =>
    CLIPBOARD_WRITE_PERMS.has(permission);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(isClipboardWrite(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    isClipboardWrite(permission),
  );
}

export async function createMainWindow(saved?: WindowState): Promise<BrowserWindow> {
  const webPreferences: WebPreferences = {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };

  const win = new BrowserWindow({
    ...(saved?.bounds ?? { width: 1280, height: 832 }),
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0b0d10",
    title: "CC Desktop",
    frame: false,
    autoHideMenuBar: true,
    icon: process.platform === "win32" ? resourcePath("icon.png") : undefined,
    webPreferences,
  });
  if (saved?.maximized) win.maximize();

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // 只允许加载应用自身页面（dev URL 或打包后 index.html 所在目录内的 file://）。
  win.webContents.on("will-navigate", (event, url) => {
    let allowed = false;
    if (rendererDevUrl) {
      allowed = url.startsWith(rendererDevUrl);
    } else {
      const currentUrl = win.webContents.getURL();
      const dirPrefix = currentUrl.slice(0, currentUrl.lastIndexOf("/") + 1);
      allowed = dirPrefix.startsWith("file:///") && url.startsWith(dirPrefix);
    }
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  if (rendererDevUrl) {
    await win.loadURL(rendererDevUrl);
  } else {
    await win.loadFile(rendererDistPath);
  }
  return win;
}
