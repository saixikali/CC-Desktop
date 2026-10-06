#!/usr/bin/env bash
# whale-balance Stop hook 的 bash 包装（Claude Code 在 Windows 上也经 bash 执行 hook 命令）。
# 原因：hooks 的 command 无法携带环境变量，而 CC Desktop.exe 必须在
# ELECTRON_RUN_AS_NODE=1 下才以 Node 模式运行 .mjs；否则会空跑 Electron GUI 壳。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ELECTRON_RUN_AS_NODE=1
exec "$DIR/../../CC Desktop.exe" "$DIR/hook-stop.mjs"
