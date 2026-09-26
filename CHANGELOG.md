# CHANGELOG — app.asar 补丁台账

每次补丁追加一条：日期、成员、摘要、改前/改后 sha256（成员级）、验证方式。
台账建立前（2026-09-20 ~ 2026-09-24 早期）的补丁未保留逐步哈希，只按会话记录摘要；锚点哈希见文末。

## 2026-09-26

### 数据修复（非 app.asar 补丁）：registry 2 条会话的旧 C 盘 cwd
- 文件：`d:\CC Desktop\data\claude-backend\registry.json`（备份：同目录 `registry.json.presubst.bak`，2783 B）
- 现象：迁移后核验发现 2 条早期「对话」模式会话（`bd3ac64e…`、`1584936a…`）的 cwd 仍为 `C:\Users\Administrator\AppData\Roaming\CC Desktop\chat-space`（transcript 本身已在 D 盘，仅记录字段为旧路径）
- 操作：停服（0 进程）→ 备份 → 精确前缀替换为 `d:\CC Desktop\data\chat-space`（仅 cwd 字段，2 条）→ JSON 校验 → 重启（4 进程）
- 验证：6 条会话 cwd 全部为 D/F 盘实际目录；全文已无 AppData 旧前缀；应用重启后未回写
- 说明：`78b2b701` 无 transcript 是迁移前既有状态（建会话未产生对话），非迁移导致

### 运行数据整体迁移到安装盘（userData → d:\CC Desktop\data）
- 成员：`out/main/index.js`
  - 改前 sha256：`f65fcee7c1b520c801940422bd00ecdbab6a21f6dcce389288ee473325305b27`（113157 B）
  - 改后 sha256：`b253e542d0ed0afd4dd6f314eba93296320c18546df6ceba215081e365e62ff5`（114820 B）
- 摘要：
  - 在 import 之后、任何业务代码之前（app ready 前）重定向 userData 为 `<exe目录>/data`（动态推导，如 `d:\CC Desktop\data`），projects.json/settings.json/window-state.json/claude-backend/logs/sent-images/chat-space/cost-rates.json 及 Chromium 缓存/lockfile 全部落 D 盘
  - 首启自动迁移：旧 `%APPDATA%/CC Desktop` 有数据而新目录不存在 → cpSync 整目录（跨盘 rename 会 EXDEV）→ 成功后 rmSync 旧目录；两边都存在则只补齐缺失顶层条目不覆盖新数据；失败回退默认目录不阻断启动
  - 实测：11.7 MB 旧数据一次性迁入，C 盘旧目录删除，4 进程在新 lockfile 上正常运行，日志持续写入 D 盘
  - 插件目录维持上一轮的 `<exe目录>/plugins` 与 `plugins-state.json`，不在 data 内
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后线上成员确认含 ccDataDir ✓；文件级核验 D 盘关键文件齐全、C 盘旧目录不存在 ✓
- 整包 sha256：`130e617d0fbdc986d0d6ee951027735ca1de5030f06c87c6c439db8830491698`

### 插件目录迁移到安装盘（D 盘），不再写入 C 盘用户目录
- 成员：`out/main/index.js`
  - 改前 sha256：`13968dc0eb733da1bea3dea547b551e426322fd66eb1d2eb569319c8205cbf44`（112982 B）
  - 改后 sha256：`f65fcee7c1b520c801940422bd00ecdbab6a21f6dcce389288ee473325305b27`（113157 B）
- 摘要：PluginService 目录由 `%APPDATA%/CC Desktop/plugins` + `plugins.json` 改为 `dirname(app.getPath("exe"))/plugins`（即 `d:\CC Desktop\plugins`）+ `plugins-state.json`；动态从 exe 路径推导，不硬编码盘符；升级只覆盖 resources，插件目录保留；ClaudeBackend 改为 new PluginService()；C 盘旧空目录已删除（无用户数据，未生成过 state）；已预建 d:\CC Desktop\plugins
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后线上成员确认含 pluginRootDir ✓
- 整包 sha256：`3438758458f6f1f141f40ac6897c9085e4d893ad4ad95b540099adc53fd5a554`

### 插件框架 v1（对标 DSH：MCP Server + Claude Code hooks 脚本）
- 成员（链式三成员）：
  - `out/main/index.js`：104880 B `852fb992a9b1e390c38a2938f42d33a4549943f66285d736cbcc96a170b3fa94` → 112982 B `13968dc0eb733da1bea3dea547b551e426322fd66eb1d2eb569319c8205cbf44`
  - `out/preload/index.cjs`：4719 B `99b64627f4e19f0bbb3e1ac3395823630de876c5e9b26c4945ddf450b2c21d4f` → 4834 B `adb39324d550610d908fe176a3bc855f26360113fc12df6e8368e55abbe682c6`
  - `out/renderer/assets/index-CnGZ3Eox.js`：3067574 B `4cda7c79d9a8a4f5d23f56e84c0d5f3d6e1a6e3f62be66a80e7b6926228d1277` → 3080112 B `1c0a40d5994837d0a059ef5f00ea5fe14feba3f03d8be144decb9e426ebd092f`
- 设计：
  - 插件目录 `%APPDATA%/CC Desktop/plugins/<id>/plugin.json`；状态 `%APPDATA%/CC Desktop/plugins.json`，新插件默认停用
  - manifest：`{ id?, name, description, version?, author?, mcp: {<server>:{type:"stdio",command,args,env,cwd?}}, hooks: {<Event>: [{matcher?,timeout?,hooks:[{type:"command",command}]}]}`，至少含有效 mcp/hooks 之一；命令中 `${PLUGIN_DIR}` 替换为插件目录
  - 主进程新增 PluginService（scan/validate/list/setEnabled/openDir/runtime）；ensureSession 合并：mcpServers → SDK `options.mcpServers`（CLI --mcp-config），hooks → `options.settings` JSON 字符串（CLI --settings），不改动用户 ~/.claude 配置；合并失败本回合降级不加载
  - IPC 新增 `plugins:list / plugins:set-enabled / plugins:open-dir`（zod 校验、ID 白名单防路径穿越）；preload 暴露 `window.cc.plugins.*`
  - 渲染层设置页新增「插件」分区（Wrench 图标）：插件配置（可折叠详情卡：标识/版本/类型/目录/MCP 服务/钩子事件/启停）+ 插件列表（双列网格、搜索、类型/状态徽章、Toggle、打开目录），顶部「打开插件目录/刷新」，底部「新会话生效」提示；无效插件红卡展示错误且不可启用
- 验证：三成员 node --check ✓；链式 patch 每步 verify 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后线上三成员抽包确认新标识 ✓
- 整包 sha256：`8221c596bd4ec69b1584d4e1f7b5e7a225450b9b2fc1c1d6bcee732209776251`

### 工具链：一键对齐 + 回归脚本环境自适应（本目录，非 app.asar 成员；未打应用补丁）
- **新增 `sync-ledger.mjs`**：一条命令把「当前线上包」锚点块与磁盘真实 asar 对齐（整包 sha256 + 块内每个成员的哈希/字节数），并把改后成员刷新进 `snapshots/<应用>/`。里程碑锚点块不动；标签自动取最新补丁条目标题（跳过"工具链/工程化"这类非补丁小节）。**以后每个补丁部署后跑一次，就不会再出现"记了条目忘了锚点"的漂移。**
- **`test-roundtrip.mjs` 增环境探针**：受限沙箱（禁止 piped stdio）下 `spawnSync` 会 EPERM，现在以**退出码 2**明确报告"环境不支持"，与"断言失败(1)"区分开——此前这一条曾被误读成回归，并把上一轮的假绿修复回退掉了（本次已取回）。
- **对齐本次漂移**：04:35~10:51 的 6 个补丁只写了条目、未更新锚点块，`check-ledger` 亮红（台账 `29edbdc8` / 实测 `3ed93e2a`）。已用 `sync-ledger` 对齐，并刷新快照（renderer `bfc7b066` → `4cda7c79`，3067574 B）。
- **清理**：删除 `_asar_work\app.p7~p9.asar` 三个 0 字节占位包；`app.p10~p12.asar` 被 Trae 进程占用句柄删不掉（`正由另一进程使用`），需在 Trae 退出后补删。
- 验证：`check-ledger` exit 0（整包 + 3 成员全对齐）；`sync-ledger` 幂等（重复执行成员行显示 `= 未变`）。
- 整包 sha256：`3ed93e2a01e756918e50c5ab624e5653a8a038db4d770ac030ebf600442e425c`

### 整行点击展开/折叠（分组名、文件更改汇总卡）
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`6f270ac9c77481f48ceed17436b74328bced443dd3a3b71c9b7d65b88b08e45e`（3067485 B）
  - 改后 sha256：`4cda7c79d9a8a4f5d23f56e84c0d5f3d6e1a6e3f62be66a80e7b6926228d1277`（3067574 B）
- 摘要：
  - 侧栏分组名 button onClick 增加 onToggleCollapse()（原本只切 active，只能点小箭头折叠）
  - 文件更改汇总卡头部由「div + 小箭头 button」改为整行 role=button 可点（含 Enter/Space 键盘支持），撤销按钮加 stopPropagation
  - 命令卡/MCP 卡/ActionStack 头部原本已是整行 <button>，未动
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认 ✓
- 整包 sha256：`3ed93e2a01e756918e50c5ab624e5653a8a038db4d770ac030ebf600442e425c`

### 连续工具卡收拢为「N 项操作」折叠堆叠
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`22ade0e577651606b0e7f3e4ad0e93f0d0ef5383fac480408a2e37d010398cae`（3064384 B）
  - 改后 sha256：`6f270ac9c77481f48ceed17436b74328bced443dd3a3b71c9b7d65b88b08e45e`（3067485 B）
- 摘要：
  - TurnGroup 把渲染列表抽成 itemNodes（useMemo）：连续 action（非 userMessage/agentMessage）按 run 聚合，>=2 条收拢为 ActionStack
  - 新增 ActionStack 组件：头部「▸ N 项操作」默认折叠（useState(false)），点击展开明细，复用 cc-collap 折叠动画；落单 1 条不折叠；user/text 不参与
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认含 ActionStack ✓
- 整包 sha256：`a403d84a7cbe3ade1d7fde4fef3b3fd19c98f64a34ee59c1f577323899f80a8a`

### 修复「+」悬停气泡无文字（i18n key 命名空间笔误）
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`8534b653ee97beee16b298e46b55310bed738e07b505d0e8d3d1525f42674cd6`（3064385 B）
  - 改后 sha256：`22ade0e577651606b0e7f3e4ad0e93f0d0ef5383fac480408a2e37d010398cae`（3064384 B）
- 摘要：tooltip 文案误用 `t.sidebar.newThread`（该命名空间无此 key，渲染为 undefined → 空气泡）；`newThread:"新建会话"` 实际在 `common` 下，改为 `t.common.newThread`
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员 `-SimpleMatch` 确认 ✓
- 整包 sha256：`ad06162b2f1d8855d6eb3b614421c519784f2dc960ade18e38930f658799c33c`

### 临时目录分组也有「+」新建会话
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`5a178da4ebb0d3ea1fdbcc75b1619422828093423b570fa87d8be121ba6a373c`（3064154 B）
  - 改后 sha256：`8534b653ee97beee16b298e46b55310bed738e07b505d0e8d3d1525f42674cd6`（3064385 B）
- 摘要：
  - GroupHeader 新增 cwd prop（调用处按 g.id/g.key 判定传入 threads[0].cwd，"未分组"不传）
  - 「+」按钮显示条件 project → (project || cwd)；无 project 时点击走 ensureForPath(cwd) 自动建同名工作区再 startThread（与选文件夹自动建工作区行为一致）
  - 「...」菜单及弹出层补回 project 守卫（拆出 Fragment 后防越权）
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认含新标识 ✓
- 整包 sha256：`b0412d17ea02adaeb86209bc6fd2c8a1a773c1fd18c71670cec16a271df131b4`

### 工作区「+」按钮悬停即时提示
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`ad3370caec440fe5854c9315b371bb15fc9d839ffaa11edf062d70271ef9a6d0`（3063638 B）
  - 改后 sha256：`5a178da4ebb0d3ea1fdbcc75b1619422828093423b570fa87d8be121ba6a373c`（3064154 B）
- 摘要：
  - 「+」按钮去掉原生 title（延迟 1s+ 用户无感），改为 onMouseEnter/Leave 状态驱动的即时气泡「新建会话」（按钮下方，bg-surface/border/圆角/阴影，主题一致）
  - 定位用内联 style（tailwind 编译后产物无法新增工具类）；创建中转圈时不显示气泡
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认含新标识 ✓
- 整包 sha256：`ab84e7d65bbc3f783ba7374fd98056daeff02d3a9d18f50ac1e7866fdc87cce5`

### 工作区分组头部新增「+」新建会话（对标 Trae）
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`bfc7b066df6fe2346f870bfa712d8466b368714a7dce0c6e92691c59e702abbf`（3062287 B）
  - 改后 sha256：`ad3370caec440fe5854c9315b371bb15fc9d839ffaa11edf062d70271ef9a6d0`（3063638 B）
- 摘要：
  - GroupHeader 内 project 分组行 hover 显示「+」按钮（位于「...」菜单按钮左侧）
  - 点击以该工作区 roots[0] 为 cwd 直接 startThread + openThread，不再弹目录选择；带 pending 权限覆盖
  - 创建中显示 LoaderCircle 转圈；失败走 toastError；仅真实工作区分组显示（临时目录/未分组不出现）
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认含新标识 ✓
- 整包 sha256：`14afa4d2330e29e17373bf3a17bc4326999295da2b7c308e9215bd86e2fdeee3`

### 权限菜单恢复紧凑尺寸
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`2521c997731e44cb4f4104ecff5ac7822d0e709389173f8e11cc33e12db5b415`（3062258 B）
  - 改后 sha256：`bfc7b066df6fe2346f870bfa712d8466b368714a7dce0c6e92691c59e702abbf`（3062287 B）
- 摘要：
  - PopoverShell 弹层 w-72→w-56、rounded-2xl→rounded-xl、p-1.5→p-1
  - 触发按钮 rounded-xl→rounded-lg、px-3→px-2.5
  - 选项行 gap-3→gap-2、rounded-xl→rounded-lg、px-3 py-2.5→px-2.5 py-1.5；图标 h-5→h-3.5、标题 text-sm font-semibold→默认 font-medium、副标题 text-xs→text-[10px]
  - 保留：cc-pop 动画、选中项后自动收菜单、非 default 时按钮常亮蓝、绕过权限 Dialog
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认含新类名 ✓
- 整包 sha256：`29edbdc892d694c93a430ee662abf59f1d1f387c8656498b3b2af8fb71a4697b`

### 工具链加固（本目录，非 app.asar 成员；线上包哈希未变）
- **修 `test-roundtrip.mjs` 假绿**：C 用例原用 `status !== 0` 判"空文件目标被守卫拒绝"，但子进程启动失败时 `status` 也是 `null`，会被误判为通过（受限沙箱下实测复现：A/B 报错、C 却打勾）。现在 C 断言**退出码必须为 1**、stderr 必须含 guard 文案，A/B/C 均先断言"子进程可正常启动（无 spawn error）"，失败时附最后一行 stderr。
- **`verify-asar.mjs` 支持幂等重写**：差异成员数由"恰好 1"放宽为 **0 或 1**（0 = 新内容与原内容相同），消除与 `test-roundtrip.mjs` A 用例（幂等往返）的判定矛盾；非目标成员出现差异仍在循环内立即失败。
- **新增 `check-ledger.mjs`**：台账「当前线上包」锚点块的整包 sha256 + 成员 sha256/字节数 vs 磁盘真实 asar 逐项自检，不符即非 0 退出。实现上避开两个坑：正文里提到「当前线上包快照」的叙述句不能当锚点行（必须同时是表格行且含 64 位哈希）；PowerShell 写出的 BOM 要剥掉才能匹配首行。
- **新增 `smoke-test.mjs`（行为层门禁）**：用应用自带的 `CC_SELFTEST=1` 实跑一次（userData 切到临时目录，**不动真实会话数据，可与正式实例并存**），抓 `CC_SELFTEST_RESULT` 并断言：`window.cc` 桥存在、渲染层 `require`/`process` 不可用、CSP 禁 `eval`、`fs` 路径穿越被拒、畸形 IPC 参数被拒；后端状态/向导联调只告警。支持 `--log` 离线重放判定。
- **新增 `snapshots/cc-desktop/`**：把当前线上包的 3 个改后成员（`out/main/index.js`、`out/renderer/assets/index-CnGZ3Eox.js`、`index-fIxHbQTX.css`）入库。此前 23 个补丁的成果只存在于安装目录的二进制与不入库的 `_asar_work` 里，**哈希不能还原代码**。
- **清理 `_asar_work`**：删除 4 个 0 字节占位包（`app.p3~p6.asar`，2026-09-24 计划删除未执行）与 2026-09-21 的整包解包残留 `app/node_modules`（8075 文件 / 282 MB，属 SKILL.md 明令避免的整包 extract，可从 asar 重新抽出）。
- SKILL.md 增补：标准流程第 6~8 步（行为层冒烟、记账+刷新快照、样式改动先走预览副本）、verify 幂等语义、受限沙箱下的 EPERM 说明、更新会整包覆盖补丁的事实。
- 验证（普通权限终端实跑，三项全部 exit 0）：
  - `test-roundtrip` **全绿**：幂等往返产物与原包整包 sha256 逐字节相同；真实改动四重校验通过（7897 packed / 190 unpacked 元数据未变 / integrity 全吻合）；空文件目标以**退出码 1 + guard 文案**被拒且不产出文件。
  - `check-ledger`：线上包 + 3 个成员哈希与字节数全对齐。
  - `smoke-test` **实跑通过**：`requireType`/`processType` 均 `undefined`、`evalBlocked=true`、`traversal=FORBIDDEN_PATH`、`malformed=BAD_REQUEST`、`ccPresent=true`（13 个桥接口）、`status=ready`；实测 CSP 比 `index.html` 的 meta 更严（另有 `form-action 'none'`、`frame-ancestors 'none'`）。
  - 受限沙箱（禁止 piped stdio / 命名管道）下 Electron 启动会以 `mojo platform_channel.cc 拒绝访问 (0x5)` 崩溃、`spawnSync` 会 EPERM —— 这类环境请以脚本报出的「子进程可正常启动 ✗」为准，不是脚本缺陷。
- 修复过程中发现并修掉 `smoke-test.mjs` 自身的一个坑：Node 的 `spawnSync` 默认对 argv 加引号转义会破坏 `cmd /c` 整条命令串（表现为日志文件根本不生成），已加 `windowsVerbatimArguments: true`，并在日志缺失时打印实际命令与退出码。
- 整包 sha256 未变：`29edbdc892d694c93a430ee662abf59f1d1f387c8656498b3b2af8fb71a4697b`（本次无应用补丁，锚点块不更新）

### 工具卡片样式对标 Trae（思考/命令/MCP 卡 + 徽章 pill 化）
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`13b60213e8ff1d771d3032231375c099abd14c540efb2a00076a775469929670`（3062178 B）
  - 改后 sha256：`2521c997731e44cb4f4104ecff5ac7822d0e709389173f8e11cc33e12db5b415`（3062258 B）
- 摘要：
  - Badge 全局 pill 化：rounded-md→rounded-full、text-[11px]→[10px]、px-1.5→px-2（exit/completed/回合状态徽章统一为 Trae 风格）
  - 命令卡：rounded-xl、行高 py-2、图标 Terminal→SquareTerminal（`>_` 造型）、命令文本提亮为 text-text
  - MCP 卡：rounded-xl、行高 py-2、标题明暗反转（server 名灰、tool 名亮色加粗，对齐截图 `claude / Read`）
  - 思考过程卡：rounded-xl、背景改实底 bg-surface-2、标题文字提亮
  - GenericItem 容器圆角统一 rounded-xl
- 验证：node --check ✓；verify-asar 四重校验 ✓（7897 packed，仅 1 成员差异）；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认含新类名 ✓
- 整包 sha256：`cdbd2e92d5cdaf67b8e0963819b7e7b14054094b4c626fc61c042ebcb0e3086f`

### 绕过权限二次风险确认（对标 Trae）
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`d12a96d196feabd5acbe0fcc2b3e58e2eadd1ecdff7d3a0f7da179a14bf6dd8e`（3059672 B）
  - 改后 sha256：`13b60213e8ff1d771d3032231375c099abd14c540efb2a00076a775469929670`（3062178 B）
- 摘要：
  - 点「绕过权限」不再直接切换：菜单先收起，弹出 Dialog（warning 图标 + 标题 + 风险说明），「取消」/红色「确认绕过」；Esc/遮罩/X 均可放弃
  - 已是绕过模式再点该项不重复弹框；其余三种模式点选即生效
  - PopoverShell children 支持函数形式 `(close) => ...`，选中项后菜单自动收起（WorkspacePill 走旧数组分支，行为不变）
  - i18n 新增 permBypassWarnTitle/permBypassWarnBody/permBypassWarnConfirm（仅中文语言包）
- 验证：node --check ✓；verify-asar 四重校验 ✓（7897 packed，仅 1 成员差异）；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认含新标识 ✓
- 整包 sha256：`39b874a4a20d7dcb664ee16fb7f3ee1eb7d0a16ea745e8aae8636313f7727c6d`

### 权限模式选择器对标 Trae 样式
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`4c0a8dac3cdb88bf3d35d04d50cc680b9a20b3d19fd42e051a59f7cfa2da43b3`（3059566 B）
  - 改后 sha256：`d12a96d196feabd5acbe0fcc2b3e58e2eadd1ecdff7d3a0f7da179a14bf6dd8e`（3059672 B）
- 摘要：
  - PermissionPill 弹层加宽（w-56→w-72）、rounded-2xl、p-1.5，加 cc-pop 弹出动画；PopoverShell 触发按钮 rounded-xl/px-3
  - 选项改大卡片行：图标 h-5 w-5、标题 text-sm font-semibold、副标题 text-xs text-text-faint、px-3 py-2.5、gap-3、rounded-xl；选中行蓝紫高亮 + 蓝色图标/对勾
  - PermissionPill 传 active（非 default 模式时底部按钮常亮蓝）；工作区选择弹层共享同一套容器样式
- 验证：node --check ✓；verify-asar 四重校验 ✓（7897 packed，仅 1 成员差异）；test-roundtrip 基线 7897/2/0 全绿 ✓；部署后抽出线上成员确认含新类名 ✓
- 整包 sha256：`45b24fb6c9a3fbb58460bb48b16691f1e9835c8b6f0fdccf5f210c5f77531fc9`

## 2026-09-25

### 00:xx — 流式卡顿 + MCP 卡完成后不折叠
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`d72d2596762eee5711b4e717078468bf593dca8f0688c9563506c1560b4dbc8d`（3058166 B）
  - 改后 sha256：`4c0a8dac3cdb88bf3d35d04d50cc680b9a20b3d19fd42e051a59f7cfa2da43b3`（3059566 B）
- 成员：`out/renderer/assets/index-fIxHbQTX.css`
  - 改后 sha256：`e2f566fba0af73a18991146df43ad9a5a9de71838229101034e416589bc796d6`（64394 B）
- 摘要：
  - Markdown 流式期间渲染纯文本（停止更新 240ms 后才渲染富文本），消除每帧 react-markdown 全量重解析（O(n²)）；任务流/对话流均接入
  - MCP 工具卡在 running→completed 跳变时自动收成一行（用户手动展开不被覆盖）
  - TurnGroup 列表 key 改用稳定 item.id，避免操作项插入导致消息组件重挂载
  - CSS 新增 `.cc-caret` 流式光标（含 reduced-motion 降级）
- 验证：node --check ✓；链式 patch（JS→CSS）每轮 verify 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓
- 整包 sha256：`2afa12f3846c3cda8ae5ebc1463df5bc3b8243604a7dae3fc44e53aa4e568897`

## 2026-09-24

### skill 工程化（本目录，非 app.asar 成员）
- `scripts/patch-asar.mjs`：新增空文件成员目标 guard（size===0 直接拒绝，防止顶掉共享 offset 的邻居）；空条目 offset 回填 undefined 时显式 warning。
- 新增 `scripts/test-roundtrip.mjs`：幂等往返 sha256 一致 / 真实改动 verify 通过 / 空文件拒绝，基线 7897 packed / 2 empty / 0 integrityBad，全绿。
- 新增 `scripts/list-entry.mjs`：零依赖成员清单，替代文档中的 `npx @electron/asar list`。
- SKILL.md：去硬编码安装目录、补空文件事实、多成员链式补丁做法、每任务独立工作目录约定、自检说明。
- 清理 `_asar_work`：删除分叉旧脚本 3 个、22 个历史 asar 变体截断为 0（Trae 索引句柄占用，重启后删占位），保留 `app.asar.orig.bak` 与当前线上包快照 `app.asar`。

### 应用补丁（均已部署到 resources\app.asar）
| # | 成员 | 摘要 |
|---|---|---|
| 1 | renderer | 推理力度菜单"默认/Medium"双勾选修复 |
| 2 | renderer | 未分组会话按 cwd 文件夹名临时分组 |
| 3 | renderer | 选择文件夹后自动创建同名持久化工作区 |
| 4 | main | **修复无法对话**：ensureSession 传 `pathToClaudeCodeExecutable` 指向 `.asar.unpacked` 真实 exe（SDK spawn 不支持 asar 虚拟路径） |
| 5 | renderer | 任务侧栏移除混入的"对话"组，任务/对话分区 |
| 6 | renderer | 审批卡从右下角浮窗改为流内卡片；补齐对话模式审批入口 |
| 7 | renderer | 代码块/diff/命令输出/MCP 面板去纯黑，改主题 token |
| 8 | renderer | 面板改 `black/20` 下陷色 + 主文字色，提升对比度 |
| 9 | renderer | 命令执行卡折叠（执行中自动展开、完成自动收起） |
| 10 | main+renderer | 图片识别：图片 content block 随消息发送、粘贴截图落盘 sent-images、双模式粘贴/预览 |
| 11 | main | 非流式端点 assistant 消息文本块兜底（中转站不发 stream_event） |
| 12 | main+renderer | fs.readFile 放行 sent-images 只读；用户图片移到气泡上方 96px 缩略图 |
| 13 | renderer | 图片点击全屏查看（Esc/遮罩关闭） |
| 14 | renderer | 查看器美化：毛玻璃遮罩、圆角投影、关闭钮、文件名、双击原始尺寸 |
| 15 | main+renderer | 回合末"N 个文件已更改"汇总条 + `turn.revertChanges` 冲突保护真实回滚 + 审批快照接通 |
| 16 | main+renderer | 每回合费用：内置价格表按 token 自算（CNY/USD），支持 cost-rates.json 覆盖 |
| 17 | renderer | 费用改为每轮结束后在内容底部显示 |
| 18 | renderer | ZCode 式过渡：条目淡入上浮、grid 0fr/1fr 折叠、箭头旋转、reduced-motion 适配 |
| 19 | renderer | 费用行紧凑样式（tok · 缓存命中率 · 价格） |
| 20 | renderer | 修复点系统通知回到应用后会话被清空（appShow 同会话不重载） |
| 21 | renderer | 流式性能：delta rAF 批处理、仅更新 dirty turn、TurnGroup memo |
| 22 | renderer | MCP 工具卡折叠（执行中自动展开） |
| 23 | renderer | 回合内排序：用户消息 → 操作类卡片 → AI 文字回复 |

## 锚点哈希

只放两块：**不可变的里程碑锚点** 与 **当前线上状态**。里程碑块一旦写下不再改动；每打一个补丁只更新「当前线上包」块，块内三行一起换。

**自检**：若「当前线上包」的整包 sha256 与本文件最新一条补丁条目的「整包 sha256」不一致，说明台账漏记或记错 —— 先补台账，别改这张表。

| 对象 | sha256 |
|---|---|
| 最初原版备份 `_asar_work/app.asar.orig.bak` | `ede9fb8d7487c0393a7a7ad33cae7cc4c9bd650b26d5c781d036eff268850a79` |
| 里程碑快照（截至 2026-09-24 #23） | `cb5a19c0df5ddc1ab09694e1e8f9cdd21a0ef47c1fddc4b29f15eb04d663b7f7` |
| └ out/main/index.js（104880 B） | `852fb992a9b1e390c38a2938f42d33a4549943f66285d736cbcc96a170b3fa94` |
| └ out/renderer/assets/index-CnGZ3Eox.js（3058166 B） | `d72d2596762eee5711b4e717078468bf593dca8f0688c9563506c1560b4dbc8d` |
| **当前线上包**（截至 2026-09-26「运行数据整体迁移到安装盘（userData → d:\CC Desktop\data）」） | `130e617d0fbdc986d0d6ee951027735ca1de5030f06c87c6c439db8830491698` |
| └ out/main/index.js（114820 B） | `b253e542d0ed0afd4dd6f314eba93296320c18546df6ceba215081e365e62ff5` |
| └ out/renderer/assets/index-CnGZ3Eox.js（3080112 B） | `1c0a40d5994837d0a059ef5f00ea5fe14feba3f03d8be144decb9e426ebd092f` |
| └ out/renderer/assets/index-fIxHbQTX.css（64394 B） | `e2f566fba0af73a18991146df43ad9a5a9de71838229101034e416589bc796d6` |

## 后续记账格式

```
### YYYY-MM-DD HH:mm
- 成员：out/renderer/assets/index-XXXX.js
- 改前 sha256：<hash>（<size> B）
- 改后 sha256：<hash>（<size> B）
- 摘要：……
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip ✓
```
