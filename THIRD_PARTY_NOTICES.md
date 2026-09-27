# Third-Party Notices

CC Desktop 的 MIT License 只适用于本项目自身源码，不覆盖第三方软件、SDK、运行时或二进制文件。

## Anthropic Claude Agent SDK

- Package: `@anthropic-ai/claude-agent-sdk`
- Native package: `@anthropic-ai/claude-agent-sdk-win32-x64`
- Copyright: Anthropic PBC
- License statement: All rights reserved. Use is subject to the Anthropic legal agreements.
- Upstream legal information: <https://code.claude.com/docs/en/legal-and-compliance>

本项目不授予任何 Anthropic SDK、Claude Code 或原生 `claude.exe` 的再分发权利。
如果你准备公开分发安装包，必须先确认相关许可允许该分发方式。

## Direct Dependencies

安装和构建过程中会使用以下主要第三方组件：

| Component | License |
| --- | --- |
| Anthropic Claude Agent SDK | See upstream license |
| Electron | MIT |
| React / React DOM | MIT |
| electron-updater | MIT |
| xterm.js | MIT |
| node-pty | MIT |
| Zustand | MIT |
| Zod | MIT |
| react-markdown / remark-gfm | MIT |
| highlight.js | BSD-3-Clause |
| lucide-react | ISC |
| Tailwind CSS | MIT |
| Vite / electron-vite | MIT |
| TypeScript | Apache-2.0 |

完整依赖列表见 `package.json` 和 `package-lock.json`。如果分发打包后的应用，还应保留各依赖包自带的
许可证和版权声明，并确保构建产物包含必要 notices。
