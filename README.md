# CC Desktop 改后成员快照（**私有库，禁止推送到公开仓库**）

这里存的是从本机 `resources\app.asar` 抽出的**改后成员**（按 asar 内相对路径），属于第三方闭源应用的代码衍生物。

**因此它被刻意放在公开仓库之外：**

- 公开仓库 [`CC-Desktop`](https://github.com/saixikali/CC-Desktop) 只放**自有内容** —— 补丁工具链（`scripts/`）、操作手册（`SKILL.md`）、补丁台账（`CHANGELOG.md`）、说明与许可；
- 本目录是本机备份库，**不要**把它加进公开仓库，也**不要**给它配公开的 remote。

## 为什么需要它

台账里记的是哈希，而**哈希不能还原代码**：如果只剩台账，20 多个补丁的成果就只剩下一个 52 MB 的二进制和一堆摘要。所以改后成员必须单独存一份。

当前内容（与本机线上包逐一哈希校验一致）：

| 成员 | 字节数 | sha256 |
|---|---|---|
| `out/main/index.js` | 114820 | `b253e542d0ed0afd4dd6f314eba93296320c18546df6ceba215081e365e62ff5` |
| `out/renderer/assets/index-CnGZ3Eox.js` | 3080088 | `bc227d46632d922b7225110f7794753ccc76fc73464315c5ab900bb3cec3ba02` |
| `out/renderer/assets/index-fIxHbQTX.css` | 64394 | `e2f566fba0af73a18991146df43ad9a5a9de71838229101034e416589bc796d6` |

对应的线上整包 sha256：`e3852971f6e28bf8dbfe0c3f1702dec4d6b39e24663752a4c11bc21196f54ad0`

## 怎么用

**继续改**：直接以这里的文件为基础编辑（改动越少越好），改完 `node --check`，再走 patch → verify → 停服替换。

**重建当前线上状态**（例如应用重装后）：以最初原版备份 `_asar_work\app.asar.orig.bak` 为输入，把本目录的文件链式 patch 回去。

**回滚**：用 `_asar_work\app.asar.orig.bak` 覆盖 `resources\app.asar`（会撤销全部补丁）。

## 维护规则

每打一个补丁并部署后，用 `sync-ledger.mjs` 把锚点块和本目录一起刷新（幂等）：

```powershell
node "<skill>\scripts\sync-ledger.mjs" "<skill>\CHANGELOG.md" "<安装目录>\resources\app.asar" "D:\CC Desktop\_asar_snapshots\cc-desktop"
node "<skill>\scripts\check-ledger.mjs" "<skill>\CHANGELOG.md" "<安装目录>\resources\app.asar"   # 必须 exit 0
```

## 备份与风险

- 本目录已经是一个独立 git 仓库（`git log` 可见初始提交），**建议**再加一个**私有** remote 并推送，否则它和公开仓库的台账一样，仍然只存在于这一块盘上：
  ```powershell
  git -C "D:\CC Desktop\_asar_snapshots" remote add origin <你的私有仓库地址>
  git -C "D:\CC Desktop\_asar_snapshots" push -u origin master
  ```
- 本目录位于应用安装目录内，**应用重装/升级可能影响它**；条件允许时把整个目录再复制一份到其他盘（例如 `D:\CC-Desktop-Snapshots\`）。
