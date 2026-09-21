# CC Desktop

适配 [Claude Code](https://github.com/anthropics/claude-code) 的 Windows 桌面客户端。Electron 44 + React 18 + electron-vite + TypeScript（strict），深色中文界面，NSIS x64 安装包。

应用**内置 Claude Code 引擎**：通过 [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 的平台原生包（`claude-agent-sdk-win32-x64`）直接拉起 Claude Code，无需单独安装 claude CLI（登录态复用本机 `~/.claude`）。

## 下载安装（普通用户）

1. 打开本仓库的 **Releases** 页面，下载最新的 `CC-Desktop-<版本>-x64-setup.exe`。
2. 双击安装：per-user 安装，**无需管理员权限**，可自选安装目录，自动创建开始菜单与桌面快捷方式。
3. 首次启动进入向导，确认内置引擎状态并选择工作目录。
4. 首次对话前需要本机已有 Claude Code 登录态（执行过 `claude login`，或本机已存在 `~/.claude` 凭据）。

> 安装包未做代码签名，Windows SmartScreen 可能提示「未知发布者」，选择「更多信息 → 仍要运行」即可。
> 使用本客户端需要自备 Anthropic 账号/订阅，本项目不含任何凭据。

## 功能

- **会话管理**：多线程会话列表、历史搜索、线程归档/删除、工作区（本地注册表）分组、深链（`cc-desktop://open?path=<dir>`）定位会话。
- **对话与流式输出**：Markdown 渲染（GFM、代码高亮、大文本节流）、thinking / 文本 / 工具调用全量流式渲染、回合进行中追加指令（steer）、停止当前回合、resume 历史会话。
- **当轮参数覆盖**：为单个回合/新会话指定模型（Opus / Sonnet / Haiku）与推理力度。
- **审批体系**：`canUseTool` 审批映射为命令执行 / 文件修改审批卡片，支持「拒绝 / 允许 / 本次会话始终允许」（写入 SDK 权限建议）；只读纯对话线程未预授权工具一律自动拒绝。
- **纯对话模式**：托管中性目录 + 只读语义 + 免审批，与任务/工作区会话隔离展示。
- **集成终端**：基于 node-pty 的 ConPTY 终端，输出环形截断防止超长日志拖慢界面。
- **会话持久化**：线程登记（registry.json）+ 回合转录（transcript-*.jsonl）落在 `%APPDATA%\CC Desktop\claude-backend\`，支撑列表、搜索与历史恢复。
- **系统集成**：托盘、Windows 通知、窗口状态记忆、首次使用向导（确认引擎状态并选择工作目录）。
- **安全边界**：IPC 契约经 zod 校验；终端启动目录与文件操作经路径守卫（realpath 防 symlink/junction 穿越）；渲染端不接触凭据。

## 环境要求

- Windows 10/11 x64
- Claude 引擎：开箱即用；首次对话前需本机 Claude Code 登录态（`claude login` 或已有 `~/.claude` 凭据）
- 开发：Node.js 22.12+、npm

## 开发

```powershell
npm install
npm run dev
```

类型检查（主进程/预加载与渲染端两个工程）：

```powershell
npm run typecheck
```

## 构建与打包

```powershell
npm run build        # electron-vite 产物到 out/
npm run dist:win     # 构建 + electron-builder，产物在 dist/
```

输出安装包：`dist/CC-Desktop-<version>-x64-setup.exe`（per-user NSIS，可选安装目录、开始菜单/桌面快捷方式）。

推 `v*` 标签会触发 `.github/workflows/release.yml`，在 GitHub Actions 上构建并把安装包自动挂到 Release。

> 打包注意：`node-pty` 与 `@anthropic-ai/*`（Claude 引擎原生二进制 claude.exe）配置在 `asarUnpack` 中，必须在 asar 外才能 spawn；`npmRebuild: false`，无需 node-gyp。
> 国内网络可使用仓库自带 `.npmrc` 中配置的 electron / electron-builder 镜像。

## 引擎说明

- 唯一会话引擎为 **Claude Code**，由 `src/main/claude-backend/claude-backend.ts` 实现：
  - 每个线程一个常驻流式 `query()`，回合 = 向输入流推一条用户消息；steer = 再推一条；
  - SDK 消息在泵循环中规范化为统一通知信封（`turn/*`、`item/*`、`error`、`thread/tokenUsage/updated`）；
  - `canUseTool` 审批在适配器内闭合为审批卡片，决议直接回写 SDK 权限建议。
- 启动时 `claude-probe.ts` 对原生 CLI 执行 `--version` 探活，结果进 `BackendStatusSnapshot.claude`，供横幅/托盘/向导/诊断展示。
- 工作区为本地注册表（`%APPDATA%\CC Desktop\projects.json`），不依赖任何外部后端。

## 目录结构

```
src/
├─ main/                       主进程
│  ├─ claude-backend/
│  │  ├─ claude-backend.ts     Claude Code 会话适配层（SDK 泵、审批、持久化）
│  │  └─ claude-probe.ts       内置引擎 --version 探活
│  ├─ backend/
│  │  └─ conversation-backend.ts  会话后端抽象 + PendingApproval 类型
│  ├─ backend-service.ts       引擎状态中心（探活快照广播）
│  ├─ projects-store.ts        本地工作区注册表（projects.json）
│  ├─ log-export.ts            诊断日志 zip 导出（PowerShell Compress-Archive）
│  ├─ ipc/
│  │  ├─ register-ipc.ts       全部 IPC handler 注册
│  │  └─ path-guard.ts         路径守卫（realpath，防 symlink/junction 穿越）
│  ├─ pty/terminal-service.ts  集成终端（node-pty / ConPTY）
│  ├─ window.ts / tray.ts      窗口与托盘
│  ├─ app-settings.ts          用户设置读写（%APPDATA%\CC Desktop）
│  ├─ notifications.ts         系统通知（回合完成 / 审批请求）
│  └─ window-state.ts / logging.ts / index.ts
├─ preload/index.ts            contextBridge 安全桥接（window.cc）
├─ renderer/src/               React 渲染端
│  ├─ pages/
│  │  ├─ chat/                 会话页（列表、会话窗、输入框、导航栏）
│  │  ├─ settings/sections/    设置页（引擎、通用、诊断、关于）
│  │  └─ wizard/               首次使用向导
│  ├─ components/
│  │  ├─ approvals-dock.tsx    底部审批坞（命令/文件变更卡片）
│  │  ├─ timeline.tsx          会话时间线（消息/命令/工具调用）
│  │  ├─ markdown.tsx          Markdown 渲染（节流、代码高亮、链接白名单）
│  │  ├─ terminal/             集成终端组件（xterm.js）
│  │  ├─ ui/                   基础 UI 组件（Button/Dialog/Input 等）
│  │  └─ titlebar / toast-viewport / backend-banner
│  ├─ store/                   zustand 状态（threads、thread-view、approvals、
│  │                           terminal、settings、toast、turn-overrides 等）
│  ├─ i18n/zh.ts               中文文案
│  ├─ lib/                     IPC 调用封装与工具函数
│  └─ App.tsx / main.tsx / styles.css
└─ shared/ipc/
   ├─ channels.ts              IPC 通道名常量
   └─ contract.ts              跨进程 zod 契约（主/渲染/预加载共享类型）

scripts/                       图标生成与开发期诊断脚本
build/icon.ico                 NSIS 与窗口图标
resources/                     运行时托盘/通知图标（*.png，electron-builder extraResources）

electron.vite.config.ts        electron-vite 构建配置
electron-builder.yml           NSIS x64 打包配置（asarUnpack node-pty 与 @anthropic-ai、深链协议）
tsconfig.json / tsconfig.node.json / tsconfig.web.json  双工程 TS strict 配置
.npmrc                         electron 与 electron-builder 国内镜像
package.json
```

## 许可证

[MIT](LICENSE)
