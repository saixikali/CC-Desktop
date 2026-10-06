# CHANGELOG — app.asar 补丁台账

每次补丁追加一条：日期、成员、摘要、改前/改后 sha256（成员级）、验证方式。
台账建立前（2026-09-20 ~ 2026-09-24 早期）的补丁未保留逐步哈希，只按会话记录摘要；锚点哈希见文末。

## 2026-10-05

### 修复：关闭主窗口后应用僵死、托盘点击无响应
- 成员：`out/main/index.js`
  - 改前 sha256：`3170bc1d57b9618e63fc9869c8bfd04f6fa0d3dc9e57ccf054140417584fa666`（131289 B）
  - 改后 sha256：`580bf614b2ff4f516fd37f1623c9205a1a09722e2ea34171a8c375b97e29a291`（131529 B）
  - 整包 sha256：`7f855256505713252d2a062900a00094777df72b3a1812a3532c13ba10b04a82`（p21 中间包；随后与渲染层修复合并部署）
- 缺陷：「关闭窗口时最小化到托盘」关闭时，主窗 `closed` 只置空引用；桌宠辅助窗仍在，Electron 不触发 `window-all-closed`，进程僵留，托盘菜单再调 `mainWindow.show()` 作用在 null 上 → 点了没反应。修复：`closed` 中在非托盘模式显式 `app.quit()`
- 验证：Win32 `WM_CLOSE` 主窗（1461×909，标题 "CC Desktop"）后进程 5→0、托盘消失；开关开启时 5→4 且桌宠 "CC Pet" 312×400 仍可见；node --check ✓；verify-asar 四重校验 ✓

### 修复：命令执行请求卡片出现时不自动滚入视野
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`bc227d46632d922b7225110f7794753ccc76fc73464315c5ab900bb3cec3ba02`（3080088 B）
  - 改后 sha256：`740e1b46de5b28e5cc227cff828f97f79b8cf39b1f33a104bf062ef0e38e629c`（3081720 B）
  - 中间态 sha256：`504db1b4…`（3080877 B，只改了 ThreadPane；发现对话气泡视图 BubbleList 有同款缺陷后补齐）
  - 整包 sha256（含 p21 主进程修复，最终线上包）：`847f9fbcd7dcb8ca640ab3697e3214da42fae5c032caca9382b66215d7d1587b`
- 缺陷：自动滚动 effect 只订阅 `turns/streaming`，审批卡片走独立事件总线（`approvalChanged` → approvals store），请求到达时若转录数据未同步变化就不滚动，高卡片落在视口外需手动下滑。修复：任务视图 ThreadPane 与对话气泡视图 BubbleList 均订阅 `pending.length`；新审批是阻塞操作，即使用户已上翻历史也强制滚到底并恢复跟随；rAF + 80ms 二次滚动兜住卡片 pop 动画/异步高度
- 验证：node --check ✓；verify-asar 四重校验 ✓（7897/2/190）
- 端到端（CDP + `--inspect` 主进程经 `process.getBuiltinModule('module').createRequire` 取 electron，`webContents.send('cc:event', …)` 广播真实信封）：打开任务会话 → 注入 2200px 高内容并滚到顶（distance>4000，follow=false）→ 注入 pending 审批 → 卡片渲染、distance=0、「允许」按钮 622–650/683 完整可见 → granted 后卡片移除，PASS

### 修复 p23：插件运行时合并抛 `h is not defined`，MCP/hooks 全不注入
- 成员：`out/main/index.js`
  - 改前 sha256：`580bf614b2ff4f516fd37f1623c9205a1a09722e2ea34171a8c375b97e29a291`（131529 B）
  - 改后 sha256：`1d23340167c1b540db89ad389228b2fc200794189f1c23cc4c29e106f7d6a21f`（131530 B）
  - 整包 sha256：`87db28006135310f49def94decc707cd11f6d0c0afb3fb11949ef69d633e8b44`（p23 中间包，随后与 p24 合并部署）
- 缺陷：`substHookEntry` 末尾 `.filter((h2) => h.command)` 回调参数名是 `h2`，却引用不存在的 `h` → `PluginService.runtime()` 每轮必抛 ReferenceError，ClaudeBackend catch 后只 warn 并不注入任何插件配置（MCP 与 hooks 同时失效），whale-balance Stop hook 因此从未执行。修复：改为 `h2.command`（1 字节）
- 验证：应用日志复现多次 `runtime()` 失败；离线 Function 抽取运行时复现修复前后差异 ✓；node --check ✓；verify-asar 四重校验 ✓（7897/2/190）；部署后日志不再报错

### 修复 p24：Windows 下 hook 命令经 bash 执行，路径反斜杠被当转义符
- 成员：`out/main/index.js`
  - 改前 sha256：`1d23340167c1b540db89ad389228b2fc200794189f1c23cc4c29e106f7d6a21f`（131530 B）
  - 改后 sha256：`f16b75a88a393e9bd50995b690eae9dfad903d526de2f01234fa3c22c8fccd6d`（131823 B）
  - 整包 sha256（p23+p24 最终线上包）：`86308bda277fb8cfbbbf63a41296029d1572eb3084aee9192a9ddeff4c28991e`
- 缺陷：p23 修好注入后 Stop hook 仍不执行。三层串联根因：①（p23）注入崩溃；② 插件 `plugin.json` 把 `timeout` 放在事件条目层，CLI hooks 的 zod schema 只接受 `{matcher?, hooks[]}`，校验失败时整条 `--settings` 被静默忽略；③ CLI v2.1.276 在 Windows 上用自带 `/usr/bin/bash` 执行 hook command（指纹探针实证 `$0=/usr/bin/bash`、`%COMSPEC%` 不展开），且 hook command 无法携带环境变量——无 `ELECTRON_RUN_AS_NODE=1` 时 `CC Desktop.exe hook-stop.mjs` 空跑 Electron GUI 壳（exit 0 但脚本不执行）；`${PLUGIN_DIR}` 替换出的 Windows 反斜杠路径在 bash 双引号里又是转义符。修复（本成员）：`substHookEntry` 对替换后的 command 在 win32 下 `replace(/\\/g,"/")`（MCP 走直接 spawn 不转换）；配套插件改动：新增 `hook-stop.sh`（内部 `export ELECTRON_RUN_AS_NODE=1` 后 exec exe）、`plugin.json` 改 CLI 标准 schema 并将 timeout 移入单个 hook 对象、command 改为 `bash "${PLUGIN_DIR}/hook-stop.sh"`
- 验证：二分实验实证（无 env stdout 仅 `\r\n` 无 state；带 env 正常执行建 state）；node --check ✓；verify-asar 四重校验 ✓（7897/2/190）；端到端（CDP bridge 同会话发两轮）：首轮锚基线 offset=145724 不计，轮次 2 自动入账 `turns 0→1`，字段完整（model `deepseek-v4-flash`、priceKey `deepseek-flash`、peak=false、cost BigDecimal、tokens cacheHit/cacheMiss/output、source=hook、callId、day），daily `2026-10-06` 汇总键建立，PASS

### 非 app.asar 成员：桌宠气泡漫画风 + 设置面板紧凑化
- 外部运行时 `pet/live2d/styles.css`（不入 asar；公开仓库副本 `pet-live2d/styles.css`）
  - 改前 sha256：`dc0d1fb5ea7c044a128a5a88dd013653ce0daad1647f3c4b4a375930bcba3e00`（6382 B）
  - 改后 sha256：`ee8e3ba5b53b53e4001f645ca9a33f7125069983bb82518fb532335f69a810a1`（6744 B）
- 内容：气泡改白底黑粗描边漫画对白框 + 硬边阴影 + 双层三角尾巴；左对齐左锚定（右侧留 52px 避让齿轮）；设置面板全面缩紧（inset/内边距/行距/控件高/字号）

## 2026-10-02

### 新增：桌宠支持图片形象（PNG/JPG/GIF/WebP/APNG）
- 成员：`out/main/index.js`
  - 改前 sha256：`13a1ce81f9347850f3a28cf23ffaacb20715891a57397b57df1a4cf190c9b552`（129744 B）
  - 改后 sha256：`3170bc1d57b9618e63fc9869c8bfd04f6fa0d3dc9e57ccf054140417584fa666`（131289 B）
  - 整包 sha256：`815699ff7db693244b85bb97c514cbb84d1f2fab552d12a5a4640a1d67c58a31`
- 外部运行时（`d:\CC Desktop\pet\live2d\`，不入 asar；仓库 `pet-live2d/`）：
  - `renderer.js` 15640 B → 22837 B，sha256 `49803c3a256080d72a73c41032b8bbfc2b9b52553d0fc2ec7b263c371227d84f`
  - 新增 `gif-decode.js`（6658 B，sha256 `637eae56a9879273b24379b50275e0a745c53045f5f82f754d1e2e4c858cd78e`）
  - `index.html` 5814 B `fb2e84575cbd4f398acf3c2d1debaeacefd0feb97184a440e4e15f8b9d245f0b`；`styles.css` 6382 B `dc0d1fb5ea7c044a128a5a88dd013653ce0daad1647f3c4b4a375930bcba3e00`
- 能力：
  - 资源扫描/导入同时接受 Live2D（`*.model3.json`）与图片（png/jpg/jpeg/gif/webp）；导入对话框改为选文件：选 model3.json 导入其所在目录，选图片则单文件入 `models/<名>/`；同目录优先识别 model3.json（不再把模型贴图误当形象）；列表带「图片/Live2D」徽章，非法选择有明确报错
  - 渲染层两条加载路径：Live2D 走 PIXI；图片走新的 canvas 呈现（按窗口等比适配），命中盒/拖拽/吸附/穿透状态机/翻转全部复用
  - 点击图片：挤压回弹动画；静态图常驻呼吸微动效，动图不加呼吸
  - **自动抠白底**：四角为统一不透明底色时，从四边泛洪（容差 42）把连通背景变透明；已带 alpha 的图原样保留
  - **GIF 零依赖自解码器**（LZW/隔行/透明/4 种处置方式/帧延迟）：本机 Windows「关闭动画」+ RDP 环境实测 Chromium 会冻结 `<img>` GIF 且 canvas drawImage 只取首帧，故 GIF 一律自行解码按帧延迟播放并逐帧抠图；APNG/动态 WebP 仍走浏览器（系统未关动画时轮询重绘抠图）
- 验证：
  - Node 直解真实素材：两个 640×640 皮肤 GIF 均 8 帧/100ms，一个全不透明、一个部分自带透明
  - node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 全绿
  - CDP：`listModels` 正确返回 kind 与中文 id；GIF 四角 alpha=0、500ms 全画面哈希变化（动画在播）；两帧截图红心位置不同；静态 PNG breathing=true；切回 Hiyori 后 PIXI 正常、0 控制台报错
  - Win32 `WindowFromPoint`：GIF 身体中心命中桌宠(True)、透明角穿透到下层(False)；tap 动画 0ms 挂载/340ms 自动摘除
- 数据：测试后删除临时「静态测试」形象；保留用户素材导入的「小鲸鱼」GIF 形象；pet.json 复位为 Hiyori

## 2026-10-02

### 修复：桌宠点击穿透状态机 + 拖拽边界/吸附加固
- 成员：`out/main/index.js`
  - 改前 sha256：`067e826d34f608da3c48383af2d457456d146a70a01bafc57c48e9c7dfb8966b`（128763 B）
  - 改后 sha256：`13a1ce81f9347850f3a28cf23ffaacb20715891a57397b57df1a4cf190c9b552`（129744 B）
  - 整包 sha256：`25d0b86f4c6677be09fa14b9168c5ab6c7924ff158b75890ea01abf51e6cd345`
- 外部运行时（`d:\CC Desktop\pet\live2d\`，不入 asar；仓库 `pet-live2d/`）：
  - `renderer.js`：`8b3c2b9e…`（15606 B）→ `2948a6e937c51a13de5e3647335b174cab53daee68db1951382574722254a9b2`（15640 B）
  - `preload.cjs`：→ `2c506b7fba293653b2383c8faa0e460c30d6b851fe50dd562498b53fd62916d2`（仅注释路径修正）
- 审查发现并修复的问题：
  1. **拖拽会被穿透逻辑打断**（真实缺陷）：旧代码在 pointermove 里无条件重算穿透，拖拽中指针扫过身体两侧透明区会 `setIgnoreMouseEvents(true)`，窗口立即丢失指针事件、拖拽冻结。改为显式状态机 `applyPointerPolicy()` 唯一入口，优先级固化：**拖拽/按压 > 设置面板 > 悬停交互区 > 穿透**，任何事件路径不得绕过（对照既有踩坑经验：禁止拖拽期间开穿透）
  2. **幻影拖拽**（真实缺陷）：在气泡/齿轮上按下后移动，旧代码仅凭 `buttons===1` 就发 `drag:move`，起点从未登记 → 用陈旧偏移把窗口甩到鼠标位置。改为 `pointerDown` 仅在舞台 pointerdown 成功时置位，拖拽必须由一次有效按下发起
  3. 命中区从写死的百分比矩形改为**模型真实包围盒**（`internalModel.originalWidth/Height × 实际 scale`，relayout 时计算），不同大小/模型比例下都贴合
  4. 补 pointercancel / window blur 复位按压态；纯点击气泡/齿轮不再误触放置动作；mouseleave 不再直接操作 IPC
- 主进程加固：拖拽 move 阶段按光标所在显示器 workArea 软夹（至少保留 40px 可见，跨显示器用 `getDisplayNearestPoint`），防止窗口被甩丢；snap 非吸附侧 x 也夹回可见区；前台窗口滚动条探测改为**先滑动到位、探测成功再校正**（PowerShell 超时 0.9→1.5s 且不再阻塞吸附动画），`resolve2` 加一次性 settled 保护
- 验证：
  - node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 7897/2/0 ✓
  - 合成指针事件：气泡上拖动窗口位移 (0,0)（幻影已消）；纯点击位移 (0,0)；真实拖拽窗口跟随
  - IPC 级吸附：右缘（跨显示器）→ x 贴边 facing=-1；左缘 → 34px 入吸附区，终位 x=6 facing=1 并持久化 pet.json ✓
  - **OS 级穿透四态**（PowerShell P/Invoke `WindowFromPoint`+`GetAncestor` 命中桌宠 HWND 592210）：透明角→穿透到下层窗口(False)；身体中心→命中桌宠(True)；**拖拽中扫到透明角→仍命中桌宠(True，旧 bug 场景)**；松手→恢复穿透(False)
- 数据：测试后 pet.json 位置复位为 null（首现回到屏幕右下角）

## 2026-10-02

### 新增：Live2D 桌宠（参考 DSH/小鲸鱼桌宠面板，壳内透明置顶窗）
- 成员：`out/main/index.js`
  - 改前 sha256：`b253e542d0ed0afd4dd6f314eba93296320c18546df6ceba215081e365e62ff5`（114820 B）
  - 改后 sha256：`067e826d34f608da3c48383af2d457456d146a70a01bafc57c48e9c7dfb8966b`（128763 B）
  - 整包 sha256：`d353c945d513104630572fb93c58555d3aa1a094db4e7fbc2a7c6fad4ac365c0`
- 架构：
  - 新增 `PetManager` 类（约 340 行）：透明/无边框/置顶(screen-saver)/skipTaskbar/focusable:false 的独立 `BrowserWindow`，独立 partition `persist:ccpet`（不受主窗 CSP 约束），加载 `<exe目录>/pet/live2d/index.html`；桌宠代码与引擎**全部在 asar 外**，升级模型/改逻辑无需重打包
  - 渲染：PixiJS 6.5.10 + pixi-live2d-display 0.4.0(cubism4) + Live2D Cubism Core 5.1（CDN 固定版本，脚本 `scripts/fetch-pet-runtime.mjs` 可复现）；模型为官方免费 Hiyori（17 文件，model3.json）
  - 配置持久化 `<userData>/pet.json`（即 `d:\CC Desktop\data\pet.json`），默认随应用启动
  - 托盘菜单新增「桌宠」勾选框（TrayService 加 `petItem`/`setPetChecked`）；`pet.onStateChange` 回写勾选态
  - 会话事件：订阅 `claudeConv` 的 `notification`(turn/completed) 与 `approval`(pending) → 推送给桌宠气泡；WebAudio 合成提示音（无音频素材）
  - IPC（PetManager 内部 ipcMain 注册，不走 CHANNELS 三表，preload 为外部 `pet/live2d/preload.cjs`）：get-config/set-config/list-models/import-model/delete-model/open-models-dir/drag/hide/set-ignore
  - 交互：全局拖拽（屏幕坐标）、边缘 48px 吸附 + 5 步滑动动画、自动朝向翻转、大小 1-15（窗高 166-530px）、透明区域点击穿透（forward 转发 + 身体近似命中区）、右键菜单（设置/翻转/隐藏）
  - 设置面板（窗临时扩到 356×572）对齐参考图：角色+导入、大小滑块、音效与提示全局设置（开关/事件/空闲台词/音量）、气泡全局开关+按压泡泡设置（点击关闭/显示时长）、避让滚动条(px，右侧吸附时另用 PowerShell P/Invoke best-effort 探测前台窗口右缘)、吸附与翻转自定义、隐藏菜单按钮、资源管理（切换/删除/打开目录）
- 自研 4 源文件已存公开仓库 `pet-live2d/`（index.html 5697 B / styles.css 5313 B / renderer.js 13704 B / preload.cjs 910 B）；线上位于 `d:\CC Desktop\pet\live2d\`
- **目录共存说明**：`pet/` 根目录原有一套旧版 Python(tkinter) GIF 桌宠（DeepSeek 余额/峰谷泡泡，2026-10-02 12:22 最后运行，未自启）；本次 Live2D 运行时整体放在 `pet/live2d/` 子目录，旧项目文件原样保留、互不干扰。其注入 app.asar 的自启半成品（`.injected-main.js`/`app.asar.patched`）从未部署到 resources。余额/峰谷泡泡计划后续移植到 Live2D（需 DEEPSEEK_API_KEY 入口）
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 7897/2/0 全绿 ✓；CDP 实测：桌宠窗 `file:///D:/CC%20Desktop/pet/live2d/index.html` 加载 0 报错、Hiyori 全身 fit 渲染背景透明、设置面板 356×572 布局与参考图一致（含全部开关行）、资源管理列出 Hiyori(使用中)、关面板窗复原 251×322、审批气泡显示正常、子目录迁移后复测通过；正常启动 5 进程（含桌宠渲染进程）
- 已知限制：命中区为身体近似矩形（非逐像素 alpha）；避让滚动条的前台窗口探测为 best-effort（PowerShell ~0.9s 超时即退回屏幕边缘）；仅支持 Cubism 3/4（*.model3.json），Cubism 2 老模型不支持；拖拽/吸附/托盘勾选未做自动化实测（纯窗口管理代码，需人工体感验证）

## 2026-09-27

### 仓库策略：快照迁出公开仓库 + README/LICENSE 补齐（非 app.asar 补丁）
- **背景**：`snapshots/` 存的是第三方**闭源**应用的改后成员，放进公开仓库等于公开分发他人代码；且这些文件已随 8 个提交进入历史（其中 5 个已推到 `origin/master`）。
- **操作**：快照整体迁到仓库外的独立私有 git 仓库 `D:\CC Desktop\_asar_snapshots\`（按 asar 内相对路径，含自带 README 与 `* -text` 的 `.gitattributes`，防止行尾被规范化导致哈希失真）；公开仓库 `git rm` 掉 `snapshots/` 并在 `.gitignore` 中固定排除。
- **保真校验**：用 `git cat-file blob` 取出两处已提交内容逐字节比对，私有库当前提交与 `origin/master` 历史中的 3 个成员 sha256 均与台账锚点块一致（`b253e542…` / `bc227d46…` / `e2f566fb…`），确认没有 CRLF 污染。
- **门面**：新增 `README.md`（定位 / 真实改动清单 / 成员级热补丁原理 / 五道验证闸门 / asar 陷阱 / 快速开始 / 台账与快照 / 已知限制 / 免责声明 / English TL;DR）与 `LICENSE`（MIT + NOTICE）；`SKILL.md` 第 7 步与串行约定中的快照路径同步改为仓库外路径。
- **未决**：历史提交中的快照仍需改写历史 `filter-branch` + 强推才能彻底清除（需人工决定，未执行）。
- **2026-10-07 更正**：本条当时把快照定性为「第三方**闭源**应用代码的衍生物」是**错的** —— 应用就是本仓库默认分支 `main` 的源码项目（本机安装的是它的构建产物），快照并非他人代码。快照继续存放在仓库外的理由改为**二进制体积**（单成员 3 MB 起，每打一次补丁多一份）与内容重复，与版权无关；因此「必须先清理历史」也从合规必需降级为可选卫生。本条记录的其余事实（迁出、`.gitignore`、逐字节保真校验）不变。
- 整包 sha256：`e3852971f6e28bf8dbfe0c3f1702dec4d6b39e24663752a4c11bc21196f54ad0`（本次未打应用补丁）

### 回退：分组头「⋯」恢复悬停显示（用户决定不保留常显）
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`6f9f2e57cb6a0cd2bae063f7e4e4101a9a79cf9474a0cca632e76a1bb03afc9e`（3080064 B）
  - 改后 sha256：`bc227d46632d922b7225110f7794753ccc76fc73464315c5ab900bb3cec3ba02`（3080088 B，即回到上一补丁状态）
- 摘要：GroupHeader 触发按钮恢复 `hidden … group-hover:flex`；会话行常显保留。整包 sha256 回到 `e3852971…`，与「会话行常显」补丁后的包逐字节一致，确认干净回退
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 全绿 ✓；CDP 实测分组头未悬停 display=none、会话行仍 flex ✓

### 数据修复（非 app.asar 补丁）：projects.json 补 Real gal 工作区记录
- 文件：`d:\CC Desktop\data\projects.json`（备份：同目录 `projects.json.addrealgal.bak`）
- 现象：Real gal 分组头无「⋯」按钮——渲染条件是 `project &&`，而 projects.json 缺该工作区记录（会话分组按 cwd 匹配项目 roots）
- 操作：停服 → 备份 → 追加 `{id: 新UUID, name: "Real gal", roots: ["D:\\Agent\\Real gal"]}` → JSON 校验 → 重启
- 验证：4 个工作区记录齐全；CDP 实测 Real gal 分组头的「⋯」按钮已渲染（悬停显示，符合回退后样式）；侧栏分组与会话列表无变化

### 侧栏分组头「⋯」操作按钮常显（同上一补丁对会话行的处理）
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`bc227d46632d922b7225110f7794753ccc76fc73464315c5ab900bb3cec3ba02`（3080088 B）
  - 改后 sha256：`6f9f2e57cb6a0cd2bae063f7e4e4101a9a79cf9474a0cca632e76a1bb03afc9e`（3080064 B）
- 摘要：GroupHeader 的「⋯」（工作区重命名/删除）由 `hidden … group-hover:flex` 改为常显 `flex`。注意：该按钮本身有 `project &&` 条件——分组无项目记录（如 Real gal，projects.json 中不存在）时按钮不渲染，与本次样式改动无关
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线全绿 ✓；CDP 实测 3 个有项目的分组头未悬停 display=flex 且截图确认；Real gal 分组无按钮（缺项目记录，既有行为）✓
- 整包 sha256：`add49cbfda8ba57633d9e8c977faa786719ee91aad83bcb5d34daf9d862108f6`

### 侧栏会话行「⋯」操作按钮常显（原仅悬停出现，入口隐蔽）
- 成员：`out/renderer/assets/index-CnGZ3Eox.js`
  - 改前 sha256：`1c0a40d5994837d0a059ef5f00ea5fe14feba3f03d8be144decb9e426ebd092f`（3080112 B）
  - 改后 sha256：`bc227d46632d922b7225110f7794753ccc76fc73464315c5ab900bb3cec3ba02`（3080088 B）
- 摘要：ThreadItemMenu 触发按钮 class 由 `hidden … group-hover:flex`（open 时追加 `flex`）改为常显 `flex …`（open 时仅追加高亮底色）；分组头（GroupHeader）的「⋯」保持悬停显示不变。菜单内容（重命名/归档/删除会话，删除有二次确认）与 IPC 不变
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip 基线 7897/2/0 全绿 ✓；CDP 实测未悬停时全部会话行按钮 display=flex（20px）且截图确认；分组头无常显按钮 ✓
- 整包 sha256：`e3852971f6e28bf8dbfe0c3f1702dec4d6b39e24663752a4c11bc21196f54ad0`

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
- **修 `sync-ledger.mjs` 标签日期**：原先用 `new Date().toISOString()`（UTC）取日期，东八区凌晨会把标签记成前一天（09-27 凌晨实测仍写 2026-09-26）；改为本地日期。
- **补仓库门面**：新增 `README.md`（项目说明 / 工作原理 / 五道验证闸门 / 陷阱 / 快速开始 / 免责声明）与 `LICENSE`（MIT，另附 NOTICE 说明 `snapshots/` 内第三方代码不适用本许可）。仓库自有代码与文档入库，应用包本体不入库。
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
| **当前线上包**（截至 2026-10-06「修复 p24：Windows 下 hook 命令经 bash 执行，路径反斜杠被当转义符」） | `86308bda277fb8cfbbbf63a41296029d1572eb3084aee9192a9ddeff4c28991e` |
| └ out/main/index.js（131823 B） | `f16b75a88a393e9bd50995b690eae9dfad903d526de2f01234fa3c22c8fccd6d` |
| └ out/renderer/assets/index-CnGZ3Eox.js（3081720 B） | `740e1b46de5b28e5cc227cff828f97f79b8cf39b1f33a104bf062ef0e38e629c` |
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
