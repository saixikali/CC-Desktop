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
7. **应用更新会整包替换 `resources\app.asar`，所有补丁一次性消失。** CC Desktop 的 `resources\app-update.yml` 指向 `https://cc-desktop.invalid/updates/`（当前等于更新不可用，补丁才得以存活），但应用设置里有 `updateFeedUrl`，一旦被配上有效地址就会自动更新。补丁前后都用 `check-ledger.mjs` 对一次：整包哈希对不上就是被换包了。

## 标准流程

脚本在本 skill 的 `scripts/` 目录，零外部依赖（仅 Node 内置模块），通过 `node <脚本>` 调用。

| 脚本 | 用途 |
|---|---|
| `list-entry.mjs` | 列成员清单（支持 `--filter <子串>`、`--packed-only`，标记 P/U/L） |
| `read-entry.mjs` | 读单个成员到文件或 stdout |
| `patch-asar.mjs` | 单成员精确替换，自动处理空文件/dedup/integrity |
| `verify-asar.mjs` | 四重校验：清单一致、仅目标差异、元数据未变、integrity 全吻合（差异成员 0=幂等重写 / 1=目标改动 都算通过） |
| `check-ledger.mjs` | **台账自检**：`CHANGELOG.md` 锚点块记的整包/成员哈希 vs 磁盘上真实 asar |
| `smoke-test.mjs` | **行为层冒烟**：以 `CC_SELFTEST=1` 实跑应用，断言安全与桥接不变量 |
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
差异成员数允许 **0 或 1**：0 = 新内容与原内容相同（幂等重写，用于重放/校验流水线），1 = 目标被改动；任何**非目标**成员出现差异立即失败（防误伤邻居的闸门在这里，不在"恰好 1 个"上）。

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

### 6. 行为层冒烟（安装后必做）

字节校验只证明"写进去的字节对"，不证明"应用还能起来"。CC Desktop 的 main 进程支持自检模式：`CC_SELFTEST=1` 会把 userData 切到临时目录（**不动真实会话数据，可与正在运行的正式实例并存**），跑完渲染层探针后打印 `CC_SELFTEST_RESULT {json}` 并自行退出。用它当安装后的门禁：

```powershell
node "<skill>\scripts\smoke-test.mjs" "<安装目录>"        # 实跑，默认 120s 超时
node "<skill>\scripts\smoke-test.mjs" --log "<已捕获日志>"  # 离线判定（留证/重放）
```

断言的不变量：`window.cc` 桥存在、渲染层 `require`/`process` 不可用、CSP 禁 `eval`、`fs` 路径穿越被拒、畸形 IPC 参数被拒；后端状态与向导联调只告警不失败（UI 补丁不需要后端 ready）。

**必须在普通终端里跑**：在受限沙箱（禁止命名管道/句柄继承）下 Electron 会以 `FATAL mojo platform_channel.cc … 拒绝访问 (0x5)` 崩溃，那是沙箱的问题不是应用的问题。

### 7. 记账 + 刷新快照（必做）

- **台账**：每次补丁完成后在 `CHANGELOG.md` 追加一条（日期、成员、摘要、改前/改后 sha256），并同步更新文末「锚点哈希 → 当前线上包」块（三行一起换）。这是"回滚到哪一步"的唯一可靠依据。
- **快照**：把改后成员重新抽进 `snapshots/<应用名>/`（按 asar 内相对路径），和台账一起提交。**哈希不能还原代码**：只记台账而不存改后文件，等于把 20 多个补丁的成果押在一块硬盘上。
- **提交前自检**（两条都要绿）：

```powershell
node "<skill>\scripts\check-ledger.mjs" "<skill>\CHANGELOG.md" "<安装目录>\resources\app.asar"
```

若「当前线上包」的哈希与磁盘实测不一致，说明台账漏记或记错 —— **先补台账，别改这张表**。

### 8. 样式类改动先在预览副本里试

UI/样式补丁往往要改好几轮，别拿线上包当草稿纸（历史上有过同一晚"加宽卡片化 → 又改回紧凑"的来回）。做法：整目录拷一份，在副本里 patch + 启动自检，肉眼确认后再落地线上包。

```powershell
$prev="<工作区>\preview\<yyyyMMdd-HHmm>"
Copy-Item "<安装目录>" $prev -Recurse          # 副本里改 resources\app.asar 即可，不影响线上
Start-Process "$prev\CC Desktop.exe"           # 自检实例用临时 userData，与正式实例互不干扰
```

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

全绿才说明：幂等重写无布局漂移、真实改动四重校验通过、空文件目标被 guard 拒绝。输出首行的 `packed/empty/integrityBad` 是包结构基线（CC Desktop 当前为 **7897 / 2 / 0**），数字变化即打包器或包结构已变，需要重新评估。

顺带跑台账自检（秒级，且是唯一能发现"台账与线上包脱节"的手段）：

```powershell
node "<skill>\scripts\check-ledger.mjs" "<skill>\CHANGELOG.md" "<安装目录>\resources\app.asar"
```

两个脚本都用 `spawnSync` 起子进程。在禁止 piped stdio 的受限沙箱下子进程会以 EPERM 启动失败（`status` 为 `null`）——脚本会明确报「子进程可正常启动 ✗」，**不会**把启动失败误判成断言通过（这正是修掉的一类假绿）；这种情况下请在普通终端重跑，别当成脚本缺陷。
