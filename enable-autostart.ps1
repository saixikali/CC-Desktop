# 一键启用"启动 CC Desktop 时同时出现桌宠"。
#
# 它做的事（每一步都照 .trae\skills\electron-asar-patch 的规矩来）：
#   1. 从当前 app.asar 里读出主进程成员
#   2. 用 pet\inject-pet-autostart.py 注入"启动时 spawn 桌宠"
#   3. node --check 语法闸门
#   4. patch-asar 生成新包 → verify-asar 四重校验
#   5. 停掉 CC Desktop → 备份 → 替换 → 重启
#   6. smoke-test 行为层冒烟
#   7. sync-ledger 记账 + 刷新快照，check-ledger 必须 exit 0
#
# 为什么要关掉应用：Windows 下 app.asar 被进程占用时无法替换。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File "D:\CC Desktop\pet\enable-autostart.ps1"
#   powershell -ExecutionPolicy Bypass -File "D:\CC Desktop\pet\enable-autostart.ps1" -Revert
#
# 注意：本文件是 UTF-8 **带 BOM** 的。PowerShell 5.1 读 .ps1 默认按系统 ANSI
# 代码页解码，无 BOM 的 UTF-8 中文会乱码并导致语法错误（本插件踩过）。

[CmdletBinding()]
param(
    [switch]$Revert,
    [switch]$KeepRunning,      # 不自动重启 CC Desktop
    [switch]$SkipSmoke         # 跳过行为层冒烟（不推荐）
)

$ErrorActionPreference = 'Stop'

$petDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$install  = Split-Path -Parent $petDir
$asar     = Join-Path $install 'resources\app.asar'
$exe      = Join-Path $install 'CC Desktop.exe'
$skill    = Join-Path $install '.trae\skills\electron-asar-patch'
$scripts  = Join-Path $skill 'scripts'
$changelog = Join-Path $skill 'CHANGELOG.md'
$snapshot = Join-Path $install '_asar_snapshots\cc-desktop'
$member   = 'out/main/index.js'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)       { Write-Host "    OK  $text" -ForegroundColor Green }
function Die($text)      { Write-Host "    失败  $text" -ForegroundColor Red; exit 1 }

Step 1 '检查环境'
foreach ($p in @($asar, $exe, $scripts, (Join-Path $petDir 'inject-pet-autostart.py'))) {
    if (-not (Test-Path $p)) { Die "找不到：$p" }
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'PATH 里没有 node' }
$python = 'C:\Python314\python.exe'
if (-not (Test-Path $python)) {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { Die '找不到 python' }
}
Ok "asar / exe / 技能库 / node / python 都在"

Step 2 '从当前 app.asar 读出主进程成员'
$work = Join-Path $petDir '.autostart-work'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory $work | Out-Null
$current = Join-Path $work 'current-main.js'
$injected = Join-Path $work 'injected-main.js'
$patched  = Join-Path $work 'app.asar.patched'

& node (Join-Path $scripts 'read-entry.mjs') $asar $member $current | Out-Null
if (-not (Test-Path $current)) { Die '读不出主进程成员' }
Ok ("主进程成员 {0:N0} 字节" -f (Get-Item $current).Length)

Step 3 ($(if ($Revert) { '移除注入' } else { '注入桌宠自启' }))
if ($Revert) {
    $already = & $python (Join-Path $petDir 'inject-pet-autostart.py') --check $current
    if ($already -match '未注入') {
        Write-Host '    当前包里没有注入块，无需回退。' -ForegroundColor Yellow
        exit 0
    }
    & $python (Join-Path $petDir 'inject-pet-autostart.py') --revert $current $injected
} else {
    $already = & $python (Join-Path $petDir 'inject-pet-autostart.py') --check $current
    if ($already -match '已注入') {
        Write-Host '    当前包里已经有注入块了（幂等）。' -ForegroundColor Yellow
        Write-Host '    想重新注入请先 -Revert，或直接重启 CC Desktop 验证效果。'
        exit 0
    }
    & $python (Join-Path $petDir 'inject-pet-autostart.py') --inject $current $injected
}
if ($LASTEXITCODE -ne 0) { Die '注入脚本返回非 0' }

Step 4 '语法闸门 node --check'
& node --check $injected
if ($LASTEXITCODE -ne 0) { Die '语法检查没过' }
Ok '压缩单行代码没有语法错误'

Step 5 '生成补丁包并四重校验'
& node (Join-Path $scripts 'patch-asar.mjs') $asar $member $injected $patched
if ($LASTEXITCODE -ne 0) { Die 'patch-asar 失败' }
& node (Join-Path $scripts 'verify-asar.mjs') $asar $patched $member $injected
if ($LASTEXITCODE -ne 0) { Die 'verify-asar 四重校验没过' }
Ok '成员清单一致、非目标成员逐字节未变、integrity 全部吻合'

Step 6 '停掉 CC Desktop'
$procs = Get-Process -Name 'CC Desktop' -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host ("    正在关闭 {0} 个进程…" -f $procs.Count)
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 3
}
$still = Get-Process -Name 'CC Desktop' -ErrorAction SilentlyContinue
if ($still) { Die '进程没关干净，请手动退出 CC Desktop 后重试' }
Ok '应用已退出'

Step 7 '替换 app.asar'
$backup = Join-Path $work 'app.asar.before-autostart.bak'
Copy-Item $asar $backup -Force
Copy-Item $patched $asar -Force
Ok "已替换（替换前备份：$backup）"

Step 8 '行为层冒烟'
if ($SkipSmoke) {
    Write-Host '    已按要求跳过' -ForegroundColor Yellow
} else {
    Write-Host '    用自检模式实跑一次应用（隔离 userData，不动真实数据）…'
    & node (Join-Path $scripts 'smoke-test.mjs') $install
    if ($LASTEXITCODE -ne 0) {
        Write-Host '    冒烟没过 —— 正在回滚！' -ForegroundColor Red
        Copy-Item $backup $asar -Force
        Write-Host '    已回滚到替换前的包。' -ForegroundColor Yellow
        exit 1
    }
    Ok '应用能起来且安全不变量成立'
}

Step 9 '记账 + 刷新快照'
if (Test-Path $changelog) {
    & node (Join-Path $scripts 'sync-ledger.mjs') $changelog $asar $snapshot
    & node (Join-Path $scripts 'check-ledger.mjs') $changelog $asar
    if ($LASTEXITCODE -ne 0) {
        Write-Host '    check-ledger 没过 —— 台账与线上包不一致，请先补台账。' -ForegroundColor Yellow
    } else {
        Ok '台账与线上包逐项对齐'
    }
} else {
    Write-Host '    没找到台账文件，跳过记账' -ForegroundColor Yellow
}

Step 10 '重启 CC Desktop'
if ($KeepRunning) {
    Write-Host '    已按要求不自动重启，请手动打开 CC Desktop。' -ForegroundColor Yellow
} else {
    Start-Process $exe
    Ok '已启动；桌宠应当跟着一起出现'
}

Write-Host ''
if ($Revert) {
    Write-Host '完成：注入已移除。' -ForegroundColor Green
} else {
    Write-Host '完成：以后开 CC Desktop 就会同时出现桌宠。' -ForegroundColor Green
    Write-Host '关掉这个自启：加 -Revert 再跑一次。' -ForegroundColor Gray
}
