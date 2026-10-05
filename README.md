# whale-balance — CC Desktop 插件

把 **DeepSeek 余额**与 **token 用量记账**暴露成 MCP 工具，外加一个 **Stop hook 自动逐轮记账**。

这是 [`DeepSeek-Balance-Whale-Widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（DSH 的右下角鲸鱼挂件）的**降级移植版**：保留"看得见账户花了多少"这个核心，**丢掉全部界面** —— 因为 CC Desktop 的插件系统只支持 MCP 与 hooks，无法往界面注入任何东西。

---

## 装了什么

```
D:\CC Desktop\
├─ plugins\
│  └─ whale-balance\
│     ├─ plugin.json        清单：一个 stdio MCP server + 一个 Stop hook
│     ├─ server.mjs         MCP server 本体（零依赖）
│     ├─ credentials.mjs    凭据解析（纯函数，可被自检覆盖）
│     ├─ hook-stop.mjs      Stop hook：自动逐轮记账
│     ├─ ledger.mjs         共享账本与计价（server 与 hook 共用，避免两套口径）
│     ├─ accounting.mjs     记账内核：定点金额 + 峰谷计价
│     ├─ pricing.json       ★ 单价表，官方调价时改这里
│     ├─ test-plugin.mjs    MCP/清单自检（32 项）
│     ├─ test-hook.mjs      hook 自检（15 项，含并发与换行回归）
│     └─ README.md          本文件
├─ plugins-state.json       启用状态（应用自己写）
├─ plugins-state.whale-balance.json       ★ 账本
└─ plugins-state.whale-balance.json.lock  写入时的排他锁（临时文件）
```

**为什么 `command` 指向 `CC Desktop.exe`**：用应用自带的 Node 24 跑脚本，不依赖系统 PATH 里有没有 `node`。靠 `env.ELECTRON_RUN_AS_NODE=1`。

---

## 三个工具 + 一个 hook

| 名称 | 类型 | 作用 | 联网 |
|---|---|---|---|
| `get_balance` | MCP 工具 | `GET /user/balance` 查余额，并把这次观测记进账本；第二次起给出相对上次的变化 | ✅ |
| `get_usage` | MCP 工具 | 读本机账本：近 N 天两个口径、按日明细、最近 10 轮 | ❌ |
| `report_usage` | MCP 工具 | 手动补记一轮的 token 用量（hook 正常工作时不需要） | ❌ |
| `Stop` hook | hooks | **每轮对话结束自动**读 transcript 里的 usage 并折算金额入账 | ❌ |

### 两个口径，**不要相加**

- **观测口径**：来自余额变化。可信（是账户真实扣减），但粗糙 —— 只知道"少了多少钱"，不知道是谁花的。**只有调用 `get_balance` 的那一刻才会采样**。
- **逐轮口径**：本机按 `token × 单价` 估算。细（能到每一轮、每个模型），但有偏差。

### hook 是怎么工作的

Stop hook 在每轮结束时被调用，payload 里带会话信息；hook 据此找到 Claude Code 的 transcript（`~/.claude/projects/**/*.jsonl`），从**上次读到的字节偏移**继续增量读取，抽出新增的 assistant 消息里的 `usage`，按当时的时间戳判峰谷、折算金额、写入账本。

几个必须知道的实现约束（都是踩出来的）：

| 约束 | 原因 |
|---|---|
| 首次运行只建立**字节基线**，不记账 | 否则会把装 hook 之前的历史全部重算一遍 |
| 同一 `message.id` 的条目**只算一次** | transcript 里一次 API 调用会写成两条（thinking 条 + text 条），两条都带完整 usage —— 不去重就是双倍计费 |
| 偏移按**真实字节位置**累计，且容忍"文件变小" | 磁盘换行可能是 `\r\n` 而读回是 `\n`，差几字节是正常的；若当成"文件被截断"就会每轮重放整份 transcript |
| 读账本 → 改 → 写 全在**一把排他锁**里 | 否则两个会话重叠时，同一轮被记两次 |
| hook **从不写 stdout**，退出码**恒为 0** | Stop hook 往 stdout 写内容会被当成"给模型的追加指令"污染对话；记账失败绝不能阻断对话 |

调试：设 `WHALE_BALANCE_HOOK_DEBUG=1`，hook 会把每一步写进 `plugins\whale-balance\hook.log`（仍然不碰 stdout）。

> hook 只在**新建的会话**里生效（与插件开关同理）。

---

## 配置 API key

按顺序找 `DEEPSEEK_API_KEY`：

1. **环境变量 `DEEPSEEK_API_KEY`**（CC Desktop 启动时继承）
2. **复用宿主的 Anthropic 凭据** —— 若 `ANTHROPIC_BASE_URL` 指向 deepseek，则直接用
   `ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）。**这是最常见的配置**，见下
3. `D:\CC Desktop\data\settings.json` 里任意深度的 `"DEEPSEEK_API_KEY"` 字段（推荐放 `env` 段）
4. `D:\CC Desktop\plugins\whale-balance\key.txt` —— 文件里只有 key 一行

四个都没有时，工具会**明确报错并列出这四条出路**，不会拿空 key 发请求。

### 第 2 条：为什么可以复用宿主凭据

把 Claude Code 指向 DeepSeek 的 Anthropic 兼容端点时，宿主注入的是：

```
ANTHROPIC_BASE_URL   = https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN = sk-...        ← 这本来就是 DeepSeek 的 key
```

这种情况下你**不需要再配任何东西**，插件直接用宿主已经注入的那份——比再抄一份明文到磁盘干净。

**安全守卫**：只有当 `ANTHROPIC_BASE_URL` 里含 `deepseek` 时才复用。
若哪天换回真正的 Anthropic，`ANTHROPIC_AUTH_TOKEN` 是 Anthropic 的 key，
拿它去请求 `api.deepseek.com/user/balance` 等于把凭据泄露给无关第三方 ——
这条守卫由 `credentials.mjs` 实现，`test-plugin.mjs` 的 `[1.5]` 节有专门的回归用例守着。

**安全边界**：key 只会发往 `https://api.deepseek.com`，代码里没有第二个网络目的地。但请自行权衡第 3 种的明文落盘风险（方式 1 最干净）。

---

## 单价与峰谷

`pricing.json` 记的是**官方定价页的美元价**（USD / 百万 token），2026-10 取自 <https://api-docs.deepseek.com/quick_start/pricing>：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.003 / 0.006 | 0.15 / 0.30 | 0.6 / 1.2 |
| `deepseek-v4-pro` | 0.022 / 0.044 | 0.66 / 1.32 | 1.98 / 3.96 |

格式为 `谷价 / 高峰价`。高峰 = 周一至周五 UTC 01:00–04:00 与 06:00–10:00（北京时间 09:00–12:00 与 14:00–18:00），**不含中国法定节假日**；其余时间（含周末与法定节假日）全天谷价。

**已知缺口**：不内置法定节假日表，节假日/调休期间按工作日高峰价估算，**偏高一点**。要精确就把 `accounting.mjs` 的 `isPeak()` 接上节假日数据源。

官方调价时**只改 `pricing.json`**。账本记的是 USD，插件不做汇率换算（不猜汇率）。

---

## 自检

```powershell
cd "D:\CC Desktop\plugins\whale-balance"
node test-plugin.mjs            # MCP/清单/凭据：43 项
node test-hook.mjs              # hook：16 项（含 4 并发、\r\n 回归、看门狗）
```

退出码：`0` 全过 / `1` 断言失败 / `2` 环境不支持（受限沙箱禁止 piped stdio 导致子进程 EPERM —— 这是环境问题不是代码问题）。

### 自检**绝不**碰生产账本（曾经不是这样）

两个自检脚本都会把账本重定向到一个临时文件（`WHALE_BALANCE_LEDGER`），跑完即删。

这条规矩是踩出来的：早先 `test-plugin.mjs` 直接往 `plugins-state.whale-balance.json` 里记一条
`selftest` 假轮次且从不回滚，`test-hook.mjs` 更是**开头删一次、结尾删一次真账本** ——
跑一次文档里推荐的 `node test-hook.mjs`，你全部的余额观测与用量历史静默归零。

现在两边都有回归用例守着这件事：`test-plugin` 断言账本已重定向，`test-hook` 在开工前给生产账本
拍一个 sha256、收工时比对，**对不上就判失败**。

`WHALE_BALANCE_LEDGER` 也是排查用的口子：想让插件在别处读写账本，设它即可；不设则永远走生产路径。

覆盖范围：定点金额解析（含 `1e-8`、`0.1+0.2` 浮点陷阱）、峰谷判定（固定时刻断言，不依赖运行时间）、三分账计价、`plugin.json` 按 `PluginService` 规则复刻校验、`${PLUGIN_DIR}` 替换后路径真实存在、MCP 握手与错误路径、账本写入、hook 的基线/去重/增量/并发/**上游不关 stdin 时的自保**。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 插件列表显示「配置无效」 | 看卡片上的具体错误。多半是 `plugin.json` 被改坏 |
| 工具列表里没有这三个工具 | 插件没启用，或**当前会话是在启用之前开的** —— 开关只在新建会话生效 |
| 账本里 `hook` 轮次一直是 0 | 看 `hook.log`（需 `WHALE_BALANCE_HOOK_DEBUG=1`）：多半是没找到 transcript，或 hook 未在会话中生效 |
| `没有找到 DEEPSEEK_API_KEY` | 按上面四种方式之一配置；若 `ANTHROPIC_BASE_URL` 已指向 deepseek，说明宿主用的是别的变量名，看错误信息里列出的四条 |
| `余额接口返回 401/403` | key 无效或无权访问该接口 |
| 账本无法解析 | 插件**拒绝覆盖**损坏的账本以免丢数据。备份改名让它重建 |
| 消费数字比预期小 | 观测口径只在调用 `get_balance` 时采样；调得越勤越准 |

---

## 关于界面

**本插件没有鲸鱼，也不可能有。**

原版鲸鱼要求宿主提供 `webServer.register()`（挂 23 条路由）、`webServer.tapIndex()`（往 HTML 注入脚本）、`credentials`、`session/event` 等 cordis 服务。CC Desktop 的插件系统只认 `mcp` 与 `hooks` 两个键，应用本身也没有本地 HTTP 服务和 HTML 注入点。

要界面只有一条路：**用 `.trae\skills\electron-asar-patch` 那套给自己补上宿主能力**（本地 HTTP 服务 + renderer 注入 + 凭据服务 + 会话事件流），再把前端接过来。另外美术素材（`assets/` 下的图片/动图/音效）**不在原仓库的 MIT 许可范围内**，明确写了"不授予再许可"。

在那之前，这个 MCP + hook 版就是"能拿到的部分"。

