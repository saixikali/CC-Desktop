---
name: electron-asar-patch
description: 在没有源码的情况下热补丁已安装 Electron 应用 app.asar 内的打包文件，按成员精确替换、完整性校验、停服替换并重启。当需要修改 CC Desktop 等本机 Electron 应用的 bundle（如 out 下的 JS）并让改动即时生效时使用。不要用于有源码可重新构建发版的项目。
---

# Electron app.asar 精准补丁

修改**已安装 Electron 应用**（路径以实际安装目录为准；本工作区示例为 CC Desktop，位于 `d:\CC Desktop`）打包在 `resources\app.asar` 内的代码，并安全替换生效。

## 何时使用 / 不使用

- 使用：应用只有安装产物、无源码；需要改 `app.asar` 内的 JS/JSON/HTML/CSS 后即时验证。
- 不使用：有源码仓库且能正常构建；修改的是 `app.asar.unpacked` 里的磁盘文件（直接改文件即可）。

## 关键事实与陷阱（务必遵守）

1. **不要整包 extract + pack**。asar 头里可能记录着本机磁盘上并不存在的 unpacked 条目（如其他平台 arm64 的 node-pty 二进制）。整包重打包会丢弃这些条目，导致包结构变化。一律用本 skill 的**单成员读 / 单成员替换**脚本。
2. **空文件共享 offset**。打包器对 size=0 的成员不推进 offset，空条目与下一个真实文件共享同一个 offset。分组时必须把空条目排除并保持原样，否则真实文件的 size/integrity 会被覆盖成 0。**空文件成员不能作为补丁目标**（替换会顶掉邻居内容），`patch-asar.mjs` 在定位目标后会直接拒绝并退出非 0。
3. **dedup 组**。内容相同的多个成员共享一个 offset；重写时同组条目要一起更新 offset/size/integrity。
4. **integrity 必须重算**。成员头含 `integrity`（SHA256 整文件 hash + 4MB 分块 hash），只换数据不更新 hash 会触发校验失败。只重算被替换组，其余原样保留。
5. **替换前必须停掉应用全部进程**，否则 Windows 下文件占用导致复制失败；Local Storage 的沙箱告警与本流程无关。
6. 头中成员路径一律用 **正斜杠**（如 `out/renderer/assets/index-CnGZ3Eox.js`）。

## 标准流程

脚本在本 skill 的 `scripts/` 目录，零外部依赖（仅 Node 内置模块），通过 `node <脚本>` 调用。

| 脚本 | 用途 |
|---|---|
| `list-entry.mjs` | 列成员清单（支持 `--filter <子串>`、`--packed-only`，标记 P/U/L） |
| `read-entry.mjs` | 读单个成员到文件或 stdout |
| `patch-asar.mjs` | 单成员精确替换，自动处理空文件/dedup/integrity |
| `verify-asar.mjs` | 四重校验：清单一致、仅目标差异、元数据未变、integrity 全吻合 |
| `test-roundtrip.mjs` | 往返回归测试（幂等布局、真实改动、空文件拒绝 + 基线数字） |

### 1. 定位目标成员

asar 通常在 `<安装目录>\resources\app.asar`。列目录（替代 `npx @electron/asar list`，无需联网）：

```powershell
# 全部成员；只看应用自身代码可过滤 node_modules（PowerShell）
node "<skill>\scripts\list-entry.mjs" "<安装目录>\resources\app.asar" --packed-only | Select-String -NotMatch "node_modules"
```

应用自身代码一般在 `out\main\index.js`、`out\preload\index.cjs`、`out\renderer\assets\index-*.js`。
bundle 是压缩单行代码，用 Grep 搜界面文案/标识串定位行号，再用 Read 配合 offset 精读。

### 2. 建立工作区并读出目标成员

建议**一次任务一个工作目录**：`_asar_work\<yyyyMMdd-HHmm>\`，保持与 asar 内相同的相对路径：

```powershell
node "<skill>\scripts\read-entry.mjs" "<安装目录>\resources\app.asar" "out/renderer/assets/index-XXXX.js" "_asar_work\20260924-2230\app\out\renderer\assets\index-XXXX.js"
```

### 3. 修改并做语法检查

- 用 Edit 做最小改动；压缩 bundle 中改动越少越好，保留原有代码风格与变量名。
- JS 改完必须 `node --check <文件>`，通过后再继续。

### 4. 生成补丁包并校验

```powershell
node "<skill>\scripts\patch-asar.mjs" "<安装目录>\resources\app.asar" "out/renderer/assets/index-XXXX.js" "工作区中改好的文件" "工作区\app.asar.patched"

node "<skill>\scripts\verify-asar.mjs" "<安装目录>\resources\app.asar" "工作区\app.asar.patched" "out/renderer/assets/index-XXXX.js" "工作区中改好的文件"
```

校验内容：成员清单一致、除目标外逐字节相同、目标与期望文件一致、unpacked/link 条目未变、全包每个成员 integrity 实测吻合。任一不过，不得安装。

### 5. 备份、停服、替换、重启

```powershell
# 首次补丁前备份原始包（已存在备份勿覆盖，保留最初版本）
Copy-Item "<安装目录>\resources\app.asar" "_asar_work\app.asar.orig.bak"

Stop-Process -Name "<应用进程名>" -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2
Copy-Item "工作区\app.asar.patched" "<安装目录>\resources\app.asar" -Force
Start-Process "<安装目录>\<应用>.exe"
```

- 进程名/EXE 名以实际应用为准（安装目录根下的 `*.exe`）。
- 安装后可再用 `read-entry.mjs` 抽出目标成员，Grep 关键改动确认线上包确实包含修复。
- 回滚：用 `app.asar.orig.bak` 覆盖 `resources\app.asar`（注意它是最初版本，会撤销之后所有补丁）。
- **记账**：每次补丁完成后在本 skill 的 `CHANGELOG.md` 追加一行（日期、成员、摘要、改前/改后 sha256），这是"回滚到哪一步"的唯一可靠依据。

## 多次迭代与多成员补丁

每次补丁都以**当前安装的 app.asar**为原始包、以上一次改好的文件为基础继续改，所有历史修复会累积保留。

一次需要改**多个成员**时，不要去放宽 verify "恰好 1 个差异成员"的断言（那是防误伤邻居的闸门）。正确做法是**链式补丁 + 逐对比对**：

```powershell
# 每一步以上一轮输出为输入，每次只改 1 个成员；orig/patched 始终是相邻两轮
node patch-asar.mjs 当前包.asar 成员A 内容A step1.asar
node verify-asar.mjs 当前包.asar step1.asar 成员A 内容A
node patch-asar.mjs step1.asar 成员B 内容B step2.asar
node verify-asar.mjs step1.asar step2.asar 成员B 内容B
# ……最后安装 stepN.asar
```

## 自检

改动脚本逻辑后，必须跑往返回归（约数秒）：

```powershell
node "<skill>\scripts\test-roundtrip.mjs" "<安装目录>\resources\app.asar"
```

全绿才说明：幂等重写无布局漂移、真实改动四重校验通过、空文件目标被拒绝。输出首行的 `packed/empty/integrityBad` 是包结构基线（CC Desktop 当前为 **7897 / 2 / 0**），数字变化即打包器或包结构已变，需要重新评估。
