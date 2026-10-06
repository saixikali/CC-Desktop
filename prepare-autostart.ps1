# 第 1 阶段：把补丁做好并验证到位，但**不动线上包**。
#
# 为什么分两阶段：替换 resources\app.asar 必须先关掉 CC Desktop，而 Windows 下
# 文件被占用时写不进去。所以这里只产出"已验证的补丁包"，替换留给 stage 2
# （cc-apply-autostart.ps1），你关掉应用后跑一下就行。
#
# 本脚本做的事：
#   1. 从线上包读出主进程成员
#   2. 注入桌宠自启 → node --check
#   3. patch-asar 生成补丁包 → verify-asar 四重校验
#   4. 把补丁包放进"应用副本"里，用自检模式实跑一次（行为层冒烟）
#      —— 这一步是在副本里跑，不怕把线上应用弄坏
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File "D:\CC Desktop\pet\prepare-autostart.ps1"
#   powershell -ExecutionPolicy Bypass -File "D:\CC Desktop\pet\prepare-autostart.ps1" -SkipSmoke
#
# 本文件是 UTF-8 **带 BOM**（PowerShell 5.1 读 .ps1 按系统 ANSI 解码，无 BOM 的中文会乱码）。

[CmdletBinding()]
param(
    [switch]$SkipSmoke,
    [switch]$Revert        # 反向：从线上包移除注入，产出"干净包"
)

$ErrorActionPreference = 'Stop'

$petDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$install = Split-Path -Parent $petDir
$asar    = Join-Path $install 'resources\app.asar'
$scripts = Join-Path $install '.trae\skills\electron-asar-patch\scripts'
$member  = 'out/main/index.js'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)       { Write-Host "    OK  $text" -ForegroundColor Green }
function Warn($text)     { Write-Host "    !!  $text" -ForegroundColor Yellow }
function Die($text)      { Write-Host "    失败  $text" -ForegroundColor Red; exit 1 }

Step 1 '检查环境'
foreach ($p in @($asar, $scripts, (Join-Path $petDir 'inject-pet-autostart.py'))) {
    if (-not (Test-Path $p)) { Die "找不到：$p" }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'PATH 里没有 node' }
$python = 'C:\Python314\python.exe'
if (-not (Test-Path $python)) { $python = (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $python) { Die '找不到 python' }
Ok 'asar / 技能库 / node / python 都在'

$work = Join-Path $petDir '.apply-work'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory $work | Out-Null

$current  = Join-Path $work 'current-main.js'
$injected = Join-Path $work 'injected-main.js'
$patched  = Join-Path $work 'app.asar.patched'

Step 2 '从线上包读出主进程成员'
& node (Join-Path $scripts 'read-entry.mjs') $asar $member $current | Out-Null
if (-not (Test-Path $current)) { Die '读不出主进程成员' }
Ok ("{0:N0} 字节" -f (Get-Item $current).Length)

Step 3 ($(if ($Revert) { '移除注入' } else { '注入桌宠自启' }))
$check = & $python (Join-Path $petDir 'inject-pet-autostart.py') --check $current
Write-Host "    当前线上包状态：$check"

if ($Revert) {
    if ($check -match '未注入') { Warn '线上包没有注入块，无需回退。'; exit 0 }
    & $python (Join-Path $petDir 'inject-pet-autostart.py') --revert $current $injected
} else {
    if ($check -match '已注入') { Warn '线上包已经注入过了 —— 无需重复操作。'; exit 0 }
    & $python (Join-Path $petDir 'inject-pet-autostart.py') --inject $current $injected
}
if ($LASTEXITCODE -ne 0) { Die '注入脚本返回非 0' }
Ok ("注入后 {0:N0} 字节（新增 {1:N0}）" -f (Get-Item $injected).Length, ((Get-Item $injected).Length - (Get-Item $current).Length))

Step 4 '语法闸门'
& node --check $injected
if ($LASTEXITCODE -ne 0) { Die 'node --check 没过' }
Ok '压缩单行代码没有语法错误'

Step 5 '生成补丁包 + 四重校验'
& node (Join-Path $scripts 'patch-asar.mjs') $asar $member $injected $patched
if ($LASTEXITCODE -ne 0) { Die 'patch-asar 失败' }
$verify = & node (Join-Path $scripts 'verify-asar.mjs') $asar $patched $member $injected
if ($LASTEXITCODE -ne 0) { Die 'verify-asar 没过' }
Ok '成员清单一致、非目标成员逐字节未变、integrity 全部吻合'

Step 6 '在应用副本里做行为层冒烟'
if ($SkipSmoke) {
    Warn '已按要求跳过冒烟。跳过它就意味着"写进去的字节对"是唯一的保证。'
} else {
    # 副本放在 .apply-work 里（工作区内）。
    # 曾经想放工作区外，但受限环境下沙箱会拒绝创建目录；
    # 而放在这里之所以安全，是因为下面只按**模式**拷 exe/dll/pak 与 resources，
    # 不会去拷 pet 或 .apply-work 自身 —— 那才是第一版踩到的递归套娃。
    $preview = Join-Path $work 'preview'
    if (Test-Path $preview) { Remove-Item $preview -Recurse -Force }
    New-Item -ItemType Directory $preview -Force | Out-Null

    # 只拷运行必需的：冒烟脚本要的是 exe + resources，外加同级的 dll/pak/bin/**dat**/locales。
    # **不能漏 `*.dat`**：`icudtl.dat` 是 Electron 的 ICU 数据，缺了它进程会以
    #   ERROR:base\i18n\icu_util.cc: Invalid file descriptor to ICU data received
    # 直接退出，日志里一行 CC_SELFTEST_RESULT 都不会有 —— 本插件第一版就漏了它。
    # 不拷 data / _asar_work / _asar_snapshots / .trae / pet：既慢又会踩到递归。
    Write-Host "    复制运行必需文件到副本：$preview"
    foreach ($pattern in @('*.exe', '*.dll', '*.pak', '*.bin', '*.dat', '*.json')) {
        Copy-Item (Join-Path $install $pattern) $preview -Force -ErrorAction SilentlyContinue
    }
    foreach ($name in @('resources', 'locales')) {
        $from = Join-Path $install $name
        if (Test-Path $from) { Copy-Item $from (Join-Path $preview $name) -Recurse -Force }
    }
    Copy-Item $patched (Join-Path $preview 'resources\app.asar') -Force
    $size = (Get-ChildItem $preview -Recurse -File -ErrorAction SilentlyContinue |
             Measure-Object Length -Sum).Sum / 1MB
    Ok ("副本已就位（{0:N0} MB，补丁包已放进 resources\app.asar）" -f $size)

    Write-Host '    用自检模式实跑副本（临时 userData，不动真实会话数据）…'
    & node (Join-Path $scripts 'smoke-test.mjs') $preview
    $smoke = $LASTEXITCODE
    if ($smoke -eq 0) {
        Ok '应用能起来，且安全与桥接不变量成立'
        Remove-Item $preview -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        # 两种失败必须分开判断，别把环境问题当成补丁问题：
        #   a) 补丁有毒  → 日志里出现 CC_SELFTEST_RESULT 但某项不变量失败
        #   b) 环境不允许 → 日志里压根没有那一行（受限沙箱禁止命名管道时，
        #      Electron 会以 mojo platform_channel.cc / ETIMEDOUT 直接崩）
        # 上面已经把日志尾部打出来了，照这个规则读它。
        Warn "冒烟返回 $smoke —— 按下面规则读上面的输出："
        Warn '  日志里有 CC_SELFTEST_RESULT 且某行是 ✗  → 补丁有问题，别装'
        Warn '  日志里压根没有那行（mojo/ETIMEDOUT）  → 是环境不允许跑 GUI，不是补丁问题'
        Warn "副本已留着，可在**普通终端**里重跑："
        Warn "  node `"$scripts\smoke-test.mjs`" `"$preview`""
    }
}

Step 7 '结果'
Copy-Item $patched (Join-Path $petDir 'app.asar.patched') -Force
Copy-Item $current  (Join-Path $petDir 'app.asar.original-main.js') -Force
Ok "已验证的补丁包：$(Join-Path $petDir 'app.asar.patched')"
Ok "原始成员留档：$(Join-Path $petDir 'app.asar.original-main.js')"

Write-Host ''
Write-Host '第 1 阶段完成。接下来关掉 CC Desktop，然后执行第 2 阶段：' -ForegroundColor Green
Write-Host '  powershell -ExecutionPolicy Bypass -File "D:\CC Desktop\pet\apply-autostart.ps1"' -ForegroundColor Gray
