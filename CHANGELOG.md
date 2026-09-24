# CHANGELOG — app.asar 补丁台账

每次补丁追加一条：日期、成员、摘要、改前/改后 sha256（成员级）、验证方式。
台账建立前（2026-09-20 ~ 2026-09-24 早期）的补丁未保留逐步哈希，只按会话记录摘要；锚点哈希见文末。

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

| 对象 | sha256 |
|---|---|
| 最初原版备份 `_asar_work/app.asar.orig.bak` | `ede9fb8d7487c0393a7a7ad33cae7cc4c9bd650b26d5c781d036eff268850a79` |
| 当前线上包（截至 #23） | `cb5a19c0df5ddc1ab09694e1e8f9cdd21a0ef47c1fddc4b29f15eb04d663b7f7` |
| └ out/main/index.js（104880 B） | `852fb992a9b1e390c38a2938f42d33a4549943f66285d736cbcc96a170b3fa94` |
| └ out/renderer/assets/index-CnGZ3Eox.js（3058166 B） | `d72d2596762eee5711b4e717078468bf593dca8f0688c9563506c1560b4dbc8d` |

## 后续记账格式

```
### YYYY-MM-DD HH:mm
- 成员：out/renderer/assets/index-XXXX.js
- 改前 sha256：<hash>（<size> B）
- 改后 sha256：<hash>（<size> B）
- 摘要：……
- 验证：node --check ✓；verify-asar 四重校验 ✓；test-roundtrip ✓
```
