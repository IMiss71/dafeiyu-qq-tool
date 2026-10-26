param([string]$WorkDir = '', [switch]$NoPause)

# AstrBot 初始化修复
# 背景：向导的「安装并初始化」用 uvx astrbot init --yes，uvx 会另建缓存重新拉包，
#       国内网络容易超时 -> 前端显示「初始化失败」。这里直接用已装好的 astrbot.exe 初始化，
#       再把向导需要的端口（dashboard 16885 / aiocqhttp 16199）写进配置。

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$logPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AstrBot初始化修复.log'
if (Test-Path $logPath) { Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue }
function Log($m) {
  $line = ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)
  Write-Host $line
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

Write-Host "==============================================" -ForegroundColor Green
Write-Host " AstrBot 初始化修复" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green

# 1) 工作目录
if (-not $WorkDir) {
  if ($env:DAFEIYU_WORK_DIR) { $WorkDir = $env:DAFEIYU_WORK_DIR }
  else { $WorkDir = Join-Path $env:LOCALAPPDATA 'DaFeiYuQQ' }
}
Log "工作目录：$WorkDir"
if (-not (Test-Path $WorkDir)) {
  Log "目录不存在。说明 AstrBot 还没装到这个位置，请回向导第②步重新「安装并初始化」。"
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 1
}
$dataDir = Join-Path $WorkDir 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$cfgPath = Join-Path $dataDir 'config.json'
$cmdPath = Join-Path $dataDir 'cmd_config.json'

# 2) 找已安装的 astrbot.exe（不走 uvx，避免二次联网）
$exe = ''
$cands = @(
  (Join-Path $env:APPDATA 'uv\tools\astrbot\Scripts\astrbot.exe'),
  (Join-Path $env:USERPROFILE '.local\bin\astrbot.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\uv\tools\astrbot\Scripts\astrbot.exe'),
  'C:\Program Files\uv\tools\astrbot\Scripts\astrbot.exe'
)
foreach ($c in $cands) {
  if ($c -and (Test-Path $c)) { $exe = $c; break }
}
if (-not $exe) {
  $g = Get-Command astrbot -ErrorAction SilentlyContinue
  if ($g) { $exe = $g.Source }
}
if (-not $exe) {
  Log "没找到 astrbot.exe —— AstrBot 其实没装上，或装到了别的位置。"
  Log "请回向导第②步点「安装并初始化」重装；装完再来跑本脚本。"
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 1
}
Log "找到 AstrBot：$exe"

# 3) 版本自检（能跑起来说明环境没坏）
try {
  $ver = & $exe --version 2>&1 | Out-String
  Log ("版本： " + $ver.Trim())
} catch {
  Log ("astrbot.exe 运行失败：" + $_.Exception.Message)
  Log "环境可能装坏了：回向导第②步右上角「清空环境」后重装。"
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 1
}

# 4) 初始化（已有 config.json 就跳过）
if (Test-Path $cfgPath) {
  Log "data\config.json 已存在，跳过 init（不会覆盖现有配置）。"
} else {
  Log "开始初始化（直接用已装的 exe，不联网下包）…"
  # 面板密码：优先沿用 dashboard_credentials.json；没有就随机生成并落盘。
  # 不再使用固定密码，避免所有安装共用同一个面板密码。
  $credPath = Join-Path $WorkDir 'dashboard_credentials.json'
  $panelPwd = ''
  if (Test-Path -LiteralPath $credPath) {
    try { $panelPwd = (Get-Content -LiteralPath $credPath -Raw -Encoding UTF8 | ConvertFrom-Json).password } catch {}
  }
  if (-not $panelPwd) {
    $panelPwd = 'Aa1' + (-join (1..12 | ForEach-Object { '{0:x}' -f (Get-Random -Minimum 0 -Maximum 16) }))
    try {
      @{ username = 'astrbot'; password = $panelPwd } | ConvertTo-Json | Set-Content -LiteralPath $credPath -Encoding UTF8
      Log "已生成随机面板密码，写入 dashboard_credentials.json（向导「关于」页也能看到）"
    } catch { Log ("写凭据文件失败：" + $_.Exception.Message) }
  }
  $env:ASTRBOT_DASHBOARD_INITIAL_PASSWORD = $panelPwd
  Push-Location $WorkDir
  try {
    & $exe init --yes 2>&1 | ForEach-Object { Log ("  " + $_) }
  } catch {
    Log ("init 抛错：" + $_.Exception.Message)
  } finally {
    Pop-Location
    Remove-Item Env:\ASTRBOT_DASHBOARD_INITIAL_PASSWORD -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path $cfgPath)) {
    Log "初始化后仍然没有 data\config.json。"
    Log "请把桌面上的 AstrBot初始化修复.log 发给技术，另外确认磁盘空间是否足够。"
    if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
    exit 1
  }
  Log "初始化完成，已生成 data\config.json"
}

# 5) 写向导专用端口：dashboard=16885，aiocqhttp ws_reverse=16199
function Patch-Cfg($path) {
  $obj = $null
  if (Test-Path $path) {
    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    if ($raw -and $raw.Length -gt 0 -and [int][char]$raw[0] -eq 65279) { $raw = $raw.Substring(1) }
    try { $obj = $raw | ConvertFrom-Json } catch { $obj = $null }
  }
  if (-not $obj) { $obj = New-Object psobject }

  # dashboard
  if (-not $obj.PSObject.Properties['dashboard']) {
    $obj | Add-Member -NotePropertyName dashboard -NotePropertyValue (New-Object psobject) -Force
  }
  foreach ($kv in @(@('enable', $true), @('host', '127.0.0.1'), @('port', 16885))) {
    $obj.dashboard | Add-Member -NotePropertyName $kv[0] -NotePropertyValue $kv[1] -Force
  }

  # platform: aiocqhttp
  $plat = @()
  if ($obj.PSObject.Properties['platform'] -and $obj.platform) { $plat = @($obj.platform) }
  $entry = $plat | Where-Object { $_ -and $_.type -eq 'aiocqhttp' } | Select-Object -First 1
  if (-not $entry) {
    $entry = New-Object psobject
    $entry | Add-Member -NotePropertyName id -NotePropertyValue 'napcat_aiocqhttp' -Force
    $entry | Add-Member -NotePropertyName type -NotePropertyValue 'aiocqhttp' -Force
    $plat = @($plat) + $entry
  }
  $entry | Add-Member -NotePropertyName enable -NotePropertyValue $true -Force
  # 只绑本机：NapCat 在同一台机器上，绑 0.0.0.0 等于把机器人控制口开给整个局域网
  $entry | Add-Member -NotePropertyName ws_reverse_host -NotePropertyValue '127.0.0.1' -Force
  $entry | Add-Member -NotePropertyName ws_reverse_port -NotePropertyValue 16199 -Force
  # token 与主工具保持一致：优先用 reverse_ws_token.txt 里已持久化的值，
  # 没有才生成新的并写回同一个文件 —— 两边 token 不一致 NapCat 就永远连不上 AstrBot
  $tokFile = Join-Path $WorkDir 'reverse_ws_token.txt'
  $tok = ''
  if (Test-Path -LiteralPath $tokFile) {
    $tok = (Get-Content -LiteralPath $tokFile -Raw -ErrorAction SilentlyContinue | Out-String).Trim()
  }
  if (-not ($tok -match '^[A-Za-z0-9]{16,64}$')) {
    $bytes = New-Object byte[] 16
    ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($bytes)
    $tok = ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLower()
    try { Set-Content -LiteralPath $tokFile -Value $tok -Encoding ASCII } catch { }
  }
  $entry | Add-Member -NotePropertyName ws_reverse_token -NotePropertyValue $tok -Force
  # 旧版残留的 host/port 会让适配器起不来，清掉
  foreach ($bad in @('host', 'port')) {
    if ($entry.PSObject.Properties[$bad]) { $entry.PSObject.Properties.Remove($bad) }
  }
  $obj | Add-Member -NotePropertyName platform -NotePropertyValue @($plat) -Force

  $json = $obj | ConvertTo-Json -Depth 100
  $utf8Bom = New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::WriteAllText($path, $json, $utf8Bom)
}

try {
  Patch-Cfg $cfgPath
  Log "已写入 data\config.json（dashboard 16885 / aiocqhttp 16199）"
  Patch-Cfg $cmdPath
  Log "已写入 data\cmd_config.json（AstrBot 运行时真正读的那份）"
} catch {
  Log ("写配置失败：" + $_.Exception.Message)
  Log "如果被杀软拦截，请把 $WorkDir 加入白名单后重试。"
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 1
}

# 6) 结果
Write-Host ""
Log "修复完成，搞定"
Log "日志文件：$logPath"
Write-Host ""
Write-Host "接下来：" -ForegroundColor Cyan
Write-Host "  1. 回到向导第②步，再点一次「安装并初始化」（这次会提示已初始化，秒过）"
Write-Host "  2. 继续往下填模型 → 启动"
Write-Host "  3. 如果启动后还是打不开面板，把 $logPath 和向导里的报错一起发给技术"
Write-Host ""
if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
