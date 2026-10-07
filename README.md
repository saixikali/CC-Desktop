# CC Desktop

> 非官方 Claude Code Windows 桌面客户端。本项目与 Anthropic 无隶属、合作或背书关系。

CC Desktop 是一个面向 Windows x64 的本地桌面客户端，使用 Electron、React 和
Claude Agent SDK 构建。所有会话、工作区和终端操作都在用户本机完成。

## 快速安装（推荐）

**适合普通用户，无需命令行：**

1. 安装 [Node.js 22.18 或更高版本](https://nodejs.org/en/download)（下载后一路下一步即可）。
2. 在本页面点击 **Code → Download ZIP**，下载并解压到任意文件夹。
3. 双击运行 **`Install-CCDesktop.bat`**。
4. 按提示等待构建完成，安装程序会自动启动。
5. 首次安装时 Windows SmartScreen 可能提示"未知发布者"，点击"仍要运行"即可。

**适合开发者（命令行方式）：**

```powershell
git clone https://github.com/saixikali/CC-Desktop.git
cd CC-Desktop
npm ci
npm run dist:win
```

构建完成后，安装包位于 `dist\CC-Desktop-*-x64-setup.exe`。

## 功能

- 多会话管理、搜索、归档、恢复和项目分组。
- Markdown、代码高亮、工具调用与思考过程流式展示。
- 命令执行和文件修改审批，以及只读对话模式。
- 内置 ConPTY 终端。
- 会话、用量和设置本地持久化。
- 系统托盘、Windows 通知和可选自动更新。

## 环境要求

- Windows 10/11 x64
- Node.js 22.18 或更高版本
- npm
- 本地已有可用的 Claude Code 登录状态

首次使用前，请在本机完成 Claude Code 登录。客户端不会收集或上传你的登录凭据。

## 本地运行

```powershell
npm ci
npm run dev
```

## 验证与构建

```powershell
npm run verify
npm run build
npm run dist:win
```

`npm run dist:win` 只用于在本地生成和测试 Windows 安装包。安装包可能包含第三方运行时，
公开分发前请自行确认所有第三方许可和再分发条件。

## 发布策略

本项目默认只公开发布源码，不随 GitHub Release 上传预编译安装包。其他用户可以克隆源码，
安装依赖并在自己电脑上构建。

## 隐私与本地数据

- CC Desktop 不向项目自有服务器发送遥测数据。
- Claude 凭据由 Claude Code 在本机管理，渲染进程无法直接读取。
- 应用设置和会话数据默认保存在 `%APPDATA%\CC Desktop`。
- Claude Agent SDK 与 Claude 服务的数据处理遵循 Anthropic 的条款和隐私政策。

请勿在 Issue、截图、日志或提交中公开 API Key、访问令牌、账号邮箱或私人项目内容。

## 已知限制

- 目前仅支持 Windows 10/11 x64。
- Windows 上依赖应用审批机制提供安全边界，不提供系统级沙箱。
- Claude Code 的可用模型、订阅和使用限制由用户自己的账号决定。

## 许可

CC Desktop 自身源码使用 [MIT License](LICENSE)。第三方组件不自动适用 MIT 许可，
详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
