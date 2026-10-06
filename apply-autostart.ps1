# 第 2 阶段：把已验证的补丁包换上，并重启 CC Desktop。
#
# 前置：先跑过 prepare-autostart.ps1（它会产出 D:\CC Desktop\pet\app.asar.patched），
#       并且**关掉 CC Desktop**（Windows 下 app.asar 被占用时写不进去）。
#
# 本脚本做的事：
#   1. 确认 CC Desktop 没在跑（在跑就问你要不要关）
#   2. 备份当前 app.asar
#   3. 换上补丁包
#   4. 启动 CC Desktop —— 桌宠应当跟着一起出现
#
# 回退：跑 prepare-autostart.ps1 -Revert 生成干净包，再跑本脚本换上。
#       或者直接用 .apply-work\app.asar.backup.bak 覆盖回去。
#
# 本文件是 UTF-8 **带 BOM**。

[CmdletBinding()]
param(
    [switch]$Force,        # 应用在跑时自动关掉它
    [switch]$NoRestart     # 换完后不自动启动
)

$ErrorActionPreference = 'Stop'

$petDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$install = Split-Path -Parent $petDir
$asar    = Join-Path $install 'resources\app.asar'
$exe     = Join-Path $install 'CC Desktop.exe'
$patched = Join-Path $petDir 'app.asar.patched'
$work    = Join-Path $petDir '.apply-work'
$backup  = Join-Path $work 'app.asar.backup.bak'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)       { Write-Host "    OK  $text" -ForegroundColor Green }
function Warn($text)     { Write-Host "    !!  $text" -ForegroundColor Yellow }
function Die($text)      { Write-Host "    失败  $text" -ForegroundColor Red; exit 1 }

Step 1 '检查前置条件'
if (-not (Test-Path $patched)) {
    Die "找不到补丁包 $patched`n         请先跑 prepare-autostart.ps1"
}
Ok ("补丁包 {0:N1} MB" -f ((Get-Item $patched).Length / 1MB))

Step 2 '确认 CC Desktop 已退出'
$procs = Get-Process -Name 'CC Desktop' -ErrorAction SilentlyContinue
if ($procs) {
    if ($Force) {
        Write-Host ("    正在关闭 {0} 个进程…" -f $procs.Count)
        $procs | Stop-Process -Force
        Start-Sleep -Seconds 3
    } else {
        Warn "CC Desktop 还在运行（{0} 个进程），app.asar 被占用无法替换。" -f $procs.Count
        Die '请先退出 CC Desktop，或加 -Force 让我关掉它'
    }
}
if (Get-Process -Name 'CC Desktop' -ErrorAction SilentlyContinue) {
    Die '进程没关干净，请手动退出后重试'
}
Ok '应用已退出'

Step 3 '备份当前包'
New-Item -ItemType Directory $work -Force | Out-Null
Copy-Item $asar $backup -Force
Ok ("已备份：{0}（{1:N1} MB）" -f $backup, ((Get-Item $backup).Length / 1MB))

Step 4 '替换 app.asar'
Copy-Item $patched $asar -Force
Ok '已替换'

Step 5 '启动 CC Desktop'
if ($NoRestart) {
    Warn '已按要求不自动启动，请手动打开 CC Desktop。'
} else {
    Start-Process $exe
    Ok '已启动 —— 桌宠应当跟着一起出现'
    Write-Host '    如果没出现，看 D:\CC Desktop\pet\pet.log' -ForegroundColor Gray
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
Write-Host "回退：用 $backup 覆盖 $asar" -ForegroundColor Gray
