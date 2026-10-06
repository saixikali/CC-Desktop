# 让桌宠"开机就能用" —— 在启动文件夹里放一个快捷方式。
#
# 用法（普通 PowerShell 窗口即可，不需要管理员）：
#   powershell -ExecutionPolicy Bypass -File "D:\CC Desktop\pet\install-autostart.ps1"
#   powershell -ExecutionPolicy Bypass -File "D:\CC Desktop\pet\install-autostart.ps1" -NoWaitForApp
#   powershell -ExecutionPolicy Bypass -File "D:\CC Desktop\pet\install-autostart.ps1" -Remove
#
# 参数：
#   -NoWaitForApp  开机立刻显示桌宠（默认是等 CC Desktop 起来后再显示）
#   -WatchApp      CC Desktop 退出时桌宠也跟着退出
#   -Remove        移除自启

[CmdletBinding()]
param(
    [switch]$NoWaitForApp,
    [switch]$WatchApp,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$petDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat = Join-Path $petDir 'pet.bat'
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'CC Desktop 桌宠.lnk'

if ($Remove) {
    if (Test-Path $link) {
        Remove-Item $link -Force
        Write-Host "[pet] 已移除自启：$link" -ForegroundColor Green
    } else {
        Write-Host "[pet] 本来就没有自启项。" -ForegroundColor Yellow
    }
    return
}

if (-not (Test-Path $bat)) {
    throw "找不到启动器：$bat"
}

$arguments = @()
# 默认就带 --wait-for-app：开机时先等 CC Desktop 起来再显示桌宠，免得孤零零先冒出来。
# 想要"开机立刻出现"就加 -NoWaitForApp。
if (-not $NoWaitForApp) { $arguments += '--wait-for-app' }
if ($WatchApp)          { $arguments += '--watch-app' }
$argumentLine = ($arguments -join ' ')

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $bat
if ($argumentLine) { $shortcut.Arguments = $argumentLine }
$shortcut.WorkingDirectory = $petDir
$shortcut.Description = 'CC Desktop 桌宠（显示 DeepSeek 余额与今日消耗）'
# 0 = 普通窗口；用最小化（7）可以让开机时那个 flash 更不明显
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Host "[pet] 已设置开机自启。" -ForegroundColor Green
Write-Host "      快捷方式：$link"
Write-Host "      启动器  ：$bat $argumentLine"
Write-Host ""
Write-Host "      想立刻生效，现在双击一次 $bat 就行。"
Write-Host "      取消自启：再加 -Remove 跑一次。"
