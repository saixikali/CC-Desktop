# snapshots/cc-desktop —— 补丁成果的代码级快照

这里的文件是从**当前线上 `resources\app.asar`** 逐个成员抽出来的**改后版本**（不是原始版本）。

## 为什么要有这个目录

补丁工作的成果原本只存在于两个地方：

1. 安装目录里的 `resources\app.asar` —— 一个 54 MB 的二进制；
2. `_asar_work\app\out\...` —— 不进版本库的临时工作副本。

仓库里只有脚本和 `CHANGELOG.md`。**哈希不能还原代码**：一旦那两处没了，台账能告诉你要改什么、改成了什么哈希，但你得从原版重新改 23 个补丁。所以把改后成员按 asar 内的相对路径入库，是这份工作的最低备份要求。

- `out/main/index.js`（104880 B）`852fb992…`
- `out/renderer/assets/index-CnGZ3Eox.js`（3062287 B）`bfc7b066…`
- `out/renderer/assets/index-fIxHbQTX.css`（64394 B）`e2f566fb…`

哈希与 `CHANGELOG.md`「锚点哈希 → 当前线上包」块逐行一致，可用 `check-ledger.mjs` 复核。

## 怎么用

**继续改**（下次补丁的基线）：直接以这里的文件为基础编辑，改动越少越好；改完 `node --check`，再走 patch → verify → 停服替换。

**重建当前线上状态**（例如重装应用后）：`app.asar.orig.bak` 是 2026-09-20 的最初原版，把它当输入，按 `CHANGELOG.md` 的顺序或直接用本目录文件链式 patch 回去即可：

```powershell
node scripts\patch-asar.mjs <原版或当前>.asar out/main/index.js snapshots\cc-desktop\out\main\index.js step1.asar
node scripts\verify-asar.mjs <原版或当前>.asar step1.asar out/main/index.js snapshots\cc-desktop\out\main\index.js
# ……对其余两个成员重复，最后安装 stepN.asar
```

**回滚**：用 `_asar_work\app.asar.orig.bak` 覆盖 `resources\app.asar`（会撤销全部补丁）。

## 维护规则

每打一个补丁并部署后，重新抽一次改后成员覆盖本目录，与 `CHANGELOG.md` 的锚点块**一起提交**：

```powershell
$asar='<安装目录>\resources\app.asar'; $snap='<本目录>'
node scripts\read-entry.mjs $asar 'out/main/index.js' "$snap\out\main\index.js"
node scripts\read-entry.mjs $asar 'out/renderer/assets/index-CnGZ3Eox.js' "$snap\out\renderer\assets\index-CnGZ3Eox.js"
node scripts\read-entry.mjs $asar 'out/renderer/assets/index-fIxHbQTX.css' "$snap\out\renderer\assets\index-fIxHbQTX.css"
node scripts\check-ledger.mjs CHANGELOG.md $asar   # 哈希对不上就别提交
```

注意：渲染层 bundle 是压缩单行代码，**不要**对它做 diff 评审（一行 3 MB 没有可读性），要评审就读 `CHANGELOG.md` 的摘要 + 用 grep 定位关键标识串。
