<div align="center">

# CC Desktop 无源码热补丁工程

**给一个只有安装产物、没有源码的 Electron 桌面客户端做精准热补丁 —— 成员级替换 `app.asar`、四道验证闸门、带哈希的补丁台账、可回滚可重建。**

![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Windows-0078D4)
![node](https://img.shields.io/badge/node-%E2%89%A518-339933)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![patches](https://img.shields.io/badge/%E8%A1%A5%E4%B8%81%E8%AE%B0%E5%BD%95-40%2B-informational)

</div>

> **这是什么**：一套自研的 **asar 成员级补丁工具链**（9 个零依赖 Node 脚本），外加一个真实项目的**补丁台账**与**改后成员快照**。本机装的闭源 Electron 客户端没有源码仓库，却需要几十次界面与功能改动 —— 这个仓库就是那件事的全部工程化沉淀。
>
> **这不是什么**：不是 CC Desktop 的分发，不含应用本体、安装包或原始 `app.asar`。详见文末[免责声明](#免责声明)。

<!-- 有界面截图后，把图片放到 docs/images/ 并取消下面这行注释，README 会立刻好看一倍：
![界面](docs/images/ui.png)
-->

---

## 目录

- [为什么会有这个仓库](#为什么会有这个仓库)
- [它真的改成了什么](#它真的改成了什么)
- [工作原理：成员级热补丁](#工作原理成员级热补丁)
- [四道验证闸门（本仓库的核心）](#四道验证闸门本仓库的核心)
- [工具链脚本](#工具链脚本)
- [台账与快照：让 40 多次补丁可审计](#台账与快照让-40-多次补丁可审计)
- [快速开始](#快速开始)
- [踩过的坑：asar 格式冷知识](#踩过的坑asar-格式冷知识)
- [目录结构](#目录结构)
- [已知限制与路线图](#已知限制与路线图)
- [免责声明](#免责声明)
- [License](#license)

---

## 为什么会有这个仓库

本机安装的 CC Desktop 是一个基于 Electron 的 Claude Code 桌面客户端：**闭源、只发安装产物**，`resources\app.asar` 里躺着压缩成单行的 3 MB renderer bundle 和 11 万字节的 main 进程代码。

日常使用中需要一连串改动：交互对标参考产品、修掉几个真实的功能缺陷、把运行数据从 C 盘迁到安装盘、再补一个插件框架。没有源码、没有构建、没有上游可提 PR，于是只剩两条路：

1. `extract` 整包 → 改 → `pack` 重新打包 —— **会破坏包结构**（见[踩过的坑](#踩过的坑asar-格式冷知识)），一旦坏掉应用直接起不来，而且无从比对；
2. 做一套**成员级精准替换**工具链，只动目标成员、其余字节原样保留，并用可重复的验证证明"确实只动了这一个成员"。

这个仓库选了第 2 条，并且把"改了什么、改成什么哈希、怎么回滚"作为一等公民来维护。

## 它真的改成了什么

改动分几类（完整流水见 [`CHANGELOG.md`](CHANGELOG.md)，每条都带成员级改前/改后 sha256）：

| 类别 | 代表改动 |
|---|---|
| **权限与审批** | 权限模式选择器卡片化；「绕过权限」加二次风险确认；审批卡从右下角浮窗改为流内卡片 |
| **会话与侧栏** | 工作区/临时分组新增「+」新建会话；会话行与分组头「⋯」菜单；整行点击展开分组；未分组会话按 cwd 自动分组；回合内排序（用户消息 → 操作卡 → 文字回复） |
| **工具卡与渲染** | 思考/命令/MCP 卡样式对标参考产品（徽章 pill 化）；连续工具卡收拢为「N 项操作」折叠堆叠；命令卡执行中展开、完成自动收起；回合末「N 个文件已更改」汇总条 |
| **性能** | 流式期间先渲染纯文本、停顿 240 ms 再渲染富文本，消除每帧全量重解析（O(n²)）；delta 按 rAF 批处理，只更新脏回合 |
| **数据与运行时** | userData 整体迁移到安装盘并做一次性迁移；插件目录不再写 C 盘；registry 里历史会话的旧 C 盘 cwd 精确修复 |
| **新能力** | 插件框架 v1：MCP Server + Claude Code hooks 脚本 |
| **修的真实缺陷** | SDK `spawn` 不支持 asar 虚拟路径导致**完全无法对话**（改为指向 `.asar.unpacked` 里的真实 exe）；非流式端点不发 `stream_event` 导致消息空白；MCP 卡跑完不折叠；点系统通知回到应用后会话被清空 |

> 2026-09-24 之前的 23 次改动只有摘要、没有成员级哈希（当时还没建台账），因此那一段**无法二分定位回归** —— 这是本仓库已知的、不可补的缺口，写在[已知限制](#已知限制与路线图)里。

## 工作原理：成员级热补丁

`app.asar` 的结构是 `[8 字节 size pickle][header pickle][文件数据区]`，header 是一棵 JSON 树，每个文件节点记录 `offset` / `size` / `integrity`（SHA256 整文件哈希 + 4 MB 分块哈希）。

补丁流程：

```text
app.asar ──► 读出目标成员 ──► 最小改动（压缩单行代码里靠 grep 文案定位行）
                                   │
                                   ├─► node --check 语法闸门
                                   │
                                   ▼
   原包 + 改后成员 ──► patch-asar.mjs ──► 成员级重写，重排数据区 offset，只重算目标组 integrity
                                   │
                                   ├─► verify-asar.mjs   四重校验
                                   ├─► test-roundtrip.mjs 链路回归
                                   ▼
   停掉应用全部进程 ──► 替换 resources\app.asar ──► 启动 ──► smoke-test.mjs 行为层冒烟
                                   │
                                   └─► sync-ledger.mjs 记账 + 刷新快照（哈希对不上就报警）
```

**关键设计**：不做整包 `extract + pack`。工具只做"读一个成员 / 写一个成员"，因此那份记录了本机并不存在的 unpacked 条目的 header 会被原样保留。

## 四道验证闸门（本仓库的核心）

改二进制包最大的风险不是"改坏"，而是**"改坏了却以为没坏"**。所以每个补丁都要过四道闸门，任何一道不过就不准安装：

| # | 闸门 | 命令 | 它证明什么 |
|---|---|---|---|
| 1 | 语法 | `node --check <改后文件>` | 压缩单行代码没有语法错误 |
| 2 | 包完整性 | `verify-asar.mjs` | 成员清单一致、**非目标成员逐字节未变**、unpacked/link 元数据未变、全包 7897 个成员 integrity 与数据实测吻合 |
| 3 | 链路回归 | `test-roundtrip.mjs` | 幂等重写后整包与原包 **sha256 逐字节相同**；真实改动能通过四重校验；空文件成员作为目标会被守卫拒绝 |
| 4 | **行为层** | `smoke-test.mjs` | 以自检模式**实跑应用**（隔离 userData，不动真实数据），断言渲染层无 `require`/`process`、CSP 禁 `eval`、`fs` 路径穿越被拒、畸形 IPC 参数被拒、预加载桥存在 |
| 5 | 台账一致性 | `check-ledger.mjs` | 台账记的整包哈希与每个成员哈希，与磁盘上真实 `app.asar` 逐项对齐 |

第 4 道是这套流程里最容易被省掉、也最不该省的一步：**字节层校验通过 ≠ 功能正确**。它依赖应用自身的 `CC_SELFTEST=1` 自检模式（main 进程支持、userData 切到临时目录、可与正式实例并存），把"应用还能起来且姿势正确"变成可自动化的一条命令。

脚本的退出码是有语义的：`0` 通过 / `1` 断言失败 / `2` 环境不支持（例如受限沙箱禁止子进程管道，此时 `spawnSync` 会 EPERM —— 报 2 而不是伪装成通过）。

## 工具链脚本

零外部依赖，只用 Node 内置模块（`node:crypto` / `node:fs` / `node:child_process`），Windows 上 `node <脚本>` 直接可用。

| 脚本 | 用途 |
|---|---|
| [`list-entry.mjs`](scripts/list-entry.mjs) | 列成员清单（`--filter <子串>`、`--packed-only`），标记 packed / unpacked / link |
| [`read-entry.mjs`](scripts/read-entry.mjs) | 读出单个成员到文件或 stdout（避开整包解包） |
| [`patch-asar.mjs`](scripts/patch-asar.mjs) | 单成员精确替换，自动处理空文件、dedup 组与 integrity 重算；空文件目标直接拒绝 |
| [`verify-asar.mjs`](scripts/verify-asar.mjs) | 四重校验（允许 0 = 幂等重写 / 1 = 目标改动） |
| [`test-roundtrip.mjs`](scripts/test-roundtrip.mjs) | 往返回归测试 + 包结构基线数字 |
| [`smoke-test.mjs`](scripts/smoke-test.mjs) | 行为层冒烟（实跑自检 + 断言不变量），支持 `--log` 离线重放 |
| [`check-ledger.mjs`](scripts/check-ledger.mjs) | 台账锚点块 vs 磁盘真实 asar 的自检 |
| [`sync-ledger.mjs`](scripts/sync-ledger.mjs) | 一键对齐：锚点块 + 快照刷新，幂等 |
| [`asar-lib.mjs`](scripts/asar-lib.mjs) | asar 读写最小实现（格式解析、成员读取、integrity 计算） |

面向 agent 的完整操作手册（何时用/不用、陷阱、标准流程、串行作业约定）在 [`SKILL.md`](SKILL.md)。

## 台账与快照：让 40 多次补丁可审计

**`CHANGELOG.md`** 是唯一的回滚依据，每条记录这个格式：

```text
### <摘要>
- 成员：out/renderer/assets/index-XXXX.js
  - 改前 sha256：<64 位哈希>（<字节数> B）
  - 改后 sha256：<64 位哈希>（<字节数> B）
- 摘要：……
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 全绿 ✓；CDP 实测 ✓
- 整包 sha256：<64 位哈希>
```

文末的**锚点哈希块**固定两块：不可变的**里程碑锚点**，与随每次补丁更新的**当前线上状态**（整包 + 每个成员）。规则是硬的：

> 「当前线上包」的整包 sha256 若与本文件最新一条补丁条目的整包 sha256 不一致，说明台账漏记或记错 —— **先补台账，别改这张表**。

这条规则由 `check-ledger.mjs` 强制执行。它不是装饰：2026-09-26 曾连续 6 个补丁只写了条目、忘了更新锚点块，正是这个脚本亮红才发现的。

**`snapshots/`** 存的是从线上包里抽出的**改后成员**（按 asar 内相对路径）。原因很直白：**哈希不能还原代码** —— 如果只有台账而不存改后文件，20 多个补丁的成果就只剩下一个 52 MB 的二进制和一堆摘要。

当前线上状态（由 `check-ledger.mjs` 实时校验）：

| 对象 | 值 |
|---|---|
| 包体 | 54,806,334 B（52.3 MB） |
| 成员结构 | packed **7897** / empty 2 / unpacked 190 / link 0 |
| 最初原版备份 | `ede9fb8d…` |
| **当前线上包** | `e3852971f6e28bf8dbfe0c3f1702dec4d6b39e24663752a4c11bc21196f54ad0` |
| └ `out/main/index.js`（114820 B） | `b253e542…` |
| └ `out/renderer/assets/index-CnGZ3Eox.js`（3080088 B） | `bc227d46…` |
| └ `out/renderer/assets/index-fIxHbQTX.css`（64394 B） | `e2f566fb…` |

## 快速开始

需要 Windows + Node ≥ 18（脚本零依赖）。

```powershell
$skill = "<本仓库路径>"
$asar  = "<安装目录>\resources\app.asar"

# 1. 看包结构（不需要联网、不需要 npx）
node "$skill\scripts\list-entry.mjs" $asar --packed-only | Select-String -NotMatch "node_modules"

# 2. 读出要改的成员
node "$skill\scripts\read-entry.mjs" $asar "out/renderer/assets/index-XXXX.js" "_asar_work\app\out\renderer\assets\index-XXXX.js"

# 3. 最小改动后做语法检查
node --check "_asar_work\app\out\renderer\assets\index-XXXX.js"

# 4. 生成补丁包并四重校验
node "$skill\scripts\patch-asar.mjs"  $asar "out/renderer/assets/index-XXXX.js" "改好的文件" "_asar_work\app.asar.patched"
node "$skill\scripts\verify-asar.mjs" $asar "_asar_work\app.asar.patched" "out/renderer/assets/index-XXXX.js" "改好的文件"

# 5. 停服 → 替换 → 重启（首次务必先备份原始包）
Copy-Item $asar "_asar_work\app.asar.orig.bak"
Stop-Process -Name "<应用进程名>" -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2
Copy-Item "_asar_work\app.asar.patched" $asar -Force
Start-Process "<安装目录>\<应用>.exe"

# 6. 行为层冒烟 + 记账 + 快照 + 台账自检
node "$skill\scripts\smoke-test.mjs" "<安装目录>"
node "$skill\scripts\sync-ledger.mjs" "$skill\CHANGELOG.md" $asar "$skill\snapshots\<应用名>"
node "$skill\scripts\check-ledger.mjs" "$skill\CHANGELOG.md" $asar   # 必须 exit 0
```

改动工具链自身逻辑后，务必跑一次回归（约数秒）：

```powershell
node "$skill\scripts\test-roundtrip.mjs" $asar
```

## 踩过的坑：asar 格式冷知识

这些是踩出来写进 `SKILL.md` 的硬事实，也是"为什么不用现成工具整包重打包"的答案：

1. **不要整包 `extract` + `pack`**。header 里可能记录着本机磁盘上并不存在的 unpacked 条目（例如其他平台 arm64 的 node-pty 二进制），整包重打包会把这些条目丢掉，包结构随之改变。
2. **空文件共享 offset**。打包器对 `size = 0` 的成员不推进 offset，空条目会与下一个真实文件共用同一个 offset；把它们并入内容组会把真实文件的 size/integrity 覆盖成 0。空文件成员**不能**作为补丁目标，工具会直接拒绝并退出非 0。
3. **dedup 组**。内容相同的多个成员共享同一 offset，重写时必须整组一起更新 offset/size/integrity，且组内内容必须一致（不一致就中止，说明理解有误）。
4. **integrity 必须重算**。成员头含 SHA256 整文件哈希与 4 MB 分块哈希，只换数据不更新哈希会触发校验失败；只重算被替换的那一组，其余原样保留。
5. **成员路径在 header 里一律用正斜杠**（`out/renderer/assets/index-XXXX.js`）。
6. **替换前必须停掉应用全部进程**，否则 Windows 下文件被占用导致复制失败。
7. **应用更新会整包替换 `resources\app.asar`，所有补丁一次性消失**。本项目里更新地址指向一个不可用域名，补丁才得以存活；`check-ledger.mjs` 同时充当"是否被换包"的探测器。

## 目录结构

```text
electron-asar-patch/
├─ README.md                  # 你正在看的这份
├─ SKILL.md                   # 面向 agent 的操作手册：何时用/不用、陷阱、标准流程、串行作业约定
├─ CHANGELOG.md               # 补丁台账：每条成员级改前/改后哈希 + 文末锚点哈希块
├─ LICENSE                    # MIT（仅覆盖本仓库自有代码）
├─ scripts/                   # 9 个零依赖 Node 脚本（工具链本体）
└─ snapshots/<应用名>/        # 改后成员快照（按 asar 内相对路径），用于回滚与重建
```

## 已知限制与路线图

**已知限制（诚实版）**

- 2026-09-24 之前的 23 次改动没有成员级哈希，中间态也不可重建（变体包已被截断清空），**那一段无法二分定位回归**。
- renderer 是压缩单行 bundle：改动必须"最小化 + 关键字定位"，代码评审只能看台账摘要与 `grep` 出的标识串，不能做 diff 评审。
- 行为层冒烟覆盖的是**安全与桥接不变量**，不覆盖业务行为（例如"折叠堆叠是否真的对"）。业务级断言需要往 main 的 `runSelfTest` 里加渲染层探针 —— 那本身也是一次正常补丁。
- 没有 CI：没有源码就没有可复现构建，"仓库里的脚本是否等于线上工具链版本"只能靠同一份工作区来保证。

**路线图**

- [ ] 把业务行为断言接进 `smoke-test.mjs`（往自检探针里加渲染层断言）
- [ ] 为补丁产物增加"补丁文件 diff 友好化"记录（当前依赖快照全量文件）
- [x] 台账自检 + 一键对齐 + 行为层冒烟 + 快照入库（2026-09-26 完成）

## 免责声明

- 本仓库**不是 CC Desktop 的分发**，不包含应用本体、安装包、原始 `app.asar`，也不提供任何绕过授权或破解手段。所有补丁作用于**本机已安装**的应用，用于个人使用与学习。
- 本仓库自带代码（`scripts/`、文档、台账）采用 MIT 许可；但 `snapshots/` 与 `CHANGELOG.md` 中被引用的**改后成员是原应用代码的衍生物**，其版权归原作者所有，**不适用本仓库的 MIT 许可**，仅作为本机回滚/重建的备份存在。
- 与原应用作者无任何关联。若原作者对 `snapshots/` 的存放有异议，提 issue 即删。
- 请自行确认在所在地区对已安装软件做本地修改的合规性。

## License

[MIT](LICENSE) © 2026 saixikali （仅覆盖本仓库自有代码，见上）

---

<details>
<summary><b>English TL;DR</b></summary>

A zero-dependency toolkit that hot-patches a **closed-source Electron desktop app** at the *asar member* level, plus the hash-anchored patch ledger and post-patch snapshots of a real project (40+ patches).

Because there is no source and no build, correctness is enforced by five gates: syntax check → 4-way package verification (member list identical, non-target members byte-identical, unpacked metadata untouched, all 7897 members' integrity recomputed and verified) → round-trip regression (idempotent rewrite is byte-identical to the original 52 MB package) → **behavioral smoke test** (launches the app in its built-in self-test mode with an isolated userData dir and asserts security invariants) → ledger consistency check.

This is not a redistribution of the app: no app binaries, no original `app.asar`. Copyright of the patched members in `snapshots/` remains with the original authors.

</details>
