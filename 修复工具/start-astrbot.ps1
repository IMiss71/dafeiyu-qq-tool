param([switch]$NoBrowser, [switch]$NoPause)

# 直接启动 AstrBot（绕过向导里的 uvx，客户机上 uvx 会卡很久导致「启动失败」）
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$work = Join-Path $env:LOCALAPPDATA 'DaFeiYuQQ'
if ($env:DAFEIYU_WORK_DIR) { $work = $env:DAFEIYU_WORK_DIR }
$log = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AstrBot手动启动.log'
if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
function W($m) {
  Write-Host $m
  Add-Content -LiteralPath $log -Value ([string]$m) -Encoding UTF8
}

function PortOpen($port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $r = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $r.AsyncWaitHandle.WaitOne(800) -and $c.Connected
    $c.Close()
    return $ok
  } catch { return $false }
}

W "大肥鱼 · 手动启动 AstrBot"
W ("工作目录：" + $work)
if (-not (Test-Path $work)) {
  W "目录不存在，说明 AstrBot 还没装。请回向导第②步「安装并初始化」。"
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 1
}

$exe = ''
foreach ($c in @(
  (Join-Path $env:APPDATA 'uv\tools\astrbot\Scripts\astrbot.exe'),
  (Join-Path $env:USERPROFILE '.local\bin\astrbot.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\uv\tools\astrbot\Scripts\astrbot.exe')
)) {
  if ($c -and (Test-Path $c)) { $exe = $c; break }
}
if (-not $exe) {
  $g = Get-Command astrbot -ErrorAction SilentlyContinue
  if ($g) { $exe = $g.Source }
}
if (-not $exe) {
  W "没找到 astrbot.exe —— AstrBot 没装上。回向导第②步重装。"
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 1
}
W ("使用：" + $exe)

if (PortOpen 16885) {
  W "AstrBot 已经在运行（16885 已监听），不用再启动。"
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:16885/" }
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 0
}

# 清掉可能残留的锁，避免新实例 "Cannot acquire lock file"
$lock = Join-Path $work 'astrbot.lock'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }

# 不用 Start-Process：PS 5.1 在环境变量只有大小写不同（HTTPS_PROXY/https_proxy）时会报
# 「字典中的关键字重复」。改用 cmd 的 start /b：不弹窗，也不碰这个坑。
$runLog = Join-Path $env:TEMP 'dfy_manual_run.log'
Remove-Item $runLog -Force -ErrorAction SilentlyContinue
$bat = Join-Path $env:TEMP 'dfy_start_astrbot.bat'
$lines = @(
  '@echo off',
  ('cd /d "' + $work + '"'),
  'set PYTHONIOENCODING=utf-8',
  'set PYTHONUTF8=1',
  ('"' + $exe + '" run >> "' + $runLog + '" 2>&1')
)
Set-Content -LiteralPath $bat -Value $lines -Encoding Default

# 用 WMI 创建进程：真正脱离控制台（关掉这个窗口机器人也不会死），
# 同时避开 PS 5.1 的 Start-Process 环境变量大小写重复问题。
$created = $false
try {
  $res = ([wmiclass]'Win32_Process').Create(('"' + $bat + '"'), $work, $null)
  if ($res.ReturnValue -eq 0) {
    $created = $true
    W ("已启动（PID " + $res.ProcessId + "），等待面板端口 16885，最多 60 秒…")
  } else {
    W ("WMI 启动失败，返回码 " + $res.ReturnValue)
  }
} catch {
  W ("WMI 启动异常：" + $_.Exception.Message)
}
if (-not $created) {
  W "尝试直接调用…"
  & $bat
  W "已启动，等待面板端口 16885，最多 60 秒…"
}

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (PortOpen 16885) { $ok = $true; break }
}

if ($ok) {
  W ""
  W "启动成功。面板地址：http://127.0.0.1:16885/"
  W "账号 astrbot，密码见向导完成页 / dashboard_credentials.json"
  $credPath = Join-Path $work 'dashboard_credentials.json'
  if (Test-Path -LiteralPath $credPath) {
    try {
      $panelPwd = (Get-Content -LiteralPath $credPath -Raw -Encoding UTF8 | ConvertFrom-Json).password
      if ($panelPwd) { W ("本次密码：" + $panelPwd) }
    } catch {}
  }
  W "接下来回向导第④步点「启动 NapCat」，用 QQ 小号扫码即可。"
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:16885/" }
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 0
}

W ""
W "启动失败：60 秒内没有监听 16885。"
if (Test-Path $runLog) {
  W "--- 启动输出最后 40 行 ---"
  Get-Content $runLog -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { W ("  " + $_) }
}
# 把自己刚拉起来的残留进程收掉，方便重试（只匹配带 astrbot run 的）
try {
  Get-CimInstance Win32_Process -Filter "Name='python.exe' or Name='astrbot.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like '*astrbot*run*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch { }

W ""
W "详细日志：桌面 AstrBot手动启动.log"
if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
exit 1
