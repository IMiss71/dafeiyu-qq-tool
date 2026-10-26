param([string]$WorkDir = '', [switch]$NoPause)

# 大肥鱼不回消息：一条链路一条链路查（AstrBot -> WS -> NapCat -> 登录 -> 模型）
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$outFile = Join-Path ([Environment]::GetFolderPath('Desktop')) '大肥鱼不回消息诊断.txt'
if (Test-Path $outFile) { Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue }
function W($m) {
  $line = [string]$m
  Write-Host $line
  Add-Content -LiteralPath $outFile -Value $line -Encoding UTF8
}
function Head($t) { W ""; W ("=" * 60); W (" " + $t); W ("=" * 60) }

if (-not $WorkDir) {
  if ($env:DAFEIYU_WORK_DIR) { $WorkDir = $env:DAFEIYU_WORK_DIR }
  else { $WorkDir = Join-Path $env:LOCALAPPDATA 'DaFeiYuQQ' }
}
$dataDir = Join-Path $WorkDir 'data'
$napDir = Join-Path $WorkDir 'NapCat'
$napCfg = Join-Path $napDir 'config'

function PortOpen($port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $r = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $r.AsyncWaitHandle.WaitOne(800) -and $c.Connected
    $c.Close()
    return $ok
  } catch { return $false }
}
function ReadJson($p) {
  try {
    $raw = Get-Content -LiteralPath $p -Raw -Encoding UTF8
    if ($raw -and $raw.Length -gt 0 -and [int][char]$raw[0] -eq 65279) { $raw = $raw.Substring(1) }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

W "大肥鱼不回消息 · 诊断报告"
W ("生成时间：" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
W ("工作目录：" + $WorkDir)

Head "1. 三个关键端口"
$pA = PortOpen 16885
$pW = PortOpen 16199
$pN = PortOpen 6099
W ("AstrBot 面板 16885：" + $(if ($pA) { "监听中 [OK]" } else { "没在监听 [X]" }))
W ("AstrBot 反向WS 16199：" + $(if ($pW) { "监听中 [OK]" } else { "没在监听 [X]" }))
W ("NapCat WebUI 6099：" + $(if ($pN) { "监听中 [OK]" } else { "没在监听 [X]" }))

Head "2. AstrBot 配置（模型和平台）"
$cfg = ReadJson (Join-Path $dataDir 'cmd_config.json')
$cfgB = ReadJson (Join-Path $dataDir 'config.json')
$use = if ($cfg) { $cfg } else { $cfgB }
if (-not $use) {
  W "配置文件读不出来（config.json / cmd_config.json 都不正常）"
} else {
  $prov = @($use.provider)
  W ("provider 条目数：" + $prov.Count)
  foreach ($p in $prov) {
    if ($p) {
      $k = [string]$p.key
      if ($k.Length -gt 8) { $k = $k.Substring(0, 4) + "***" + $k.Substring($k.Length - 4) }
      W ("  - id=" + $p.id + " model=" + $p.model + " api_base=" + $p.api_base + " key=" + $(if ($k) { $k } else { "（空）" }) + " enable=" + $p.enable)
    }
  }
  $plat = @($use.platform)
  foreach ($p in $plat) {
    if ($p -and $p.type -eq 'aiocqhttp') {
      $tk = [string]$p.ws_reverse_token
      W ("  aiocqhttp: host=" + $p.ws_reverse_host + " port=" + $p.ws_reverse_port + " token=" + $(if ($tk) { "（已设置，" + $tk.Length + " 位）" } else { "（空）" }) + " enable=" + $p.enable)
    }
  }
}

Head "3. NapCat 配置（有没有连 AstrBot）"
if (-not (Test-Path $napCfg)) {
  W "没有找到 NapCat 配置目录：" + $napCfg
} else {
  $ob = Get-ChildItem -LiteralPath $napCfg -Filter 'onebot11_*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $ob) {
    W "没有 onebot11_*.json —— NapCat 还没登录过 QQ（没生成账号配置）"
  } else {
    W ("配置文件：" + $ob.Name)
    $j = ReadJson $ob.FullName
    if ($j) {
      $clients = @($j.network.websocketClients)
      W ("websocket 客户端数量：" + $clients.Count)
      foreach ($c in $clients) {
        if ($c) {
          W ("  - name=" + $c.name + " enable=" + $c.enable + " url=" + $c.url + " token=" + $(if ([string]$c.token) { "（已设置）" } else { "（空）" }))
        }
      }
      $ok = $clients | Where-Object { $_.enable -and ([string]$_.url -like '*16199*') }
      if (-not $ok) { W ">>> 没有启用且指向 16199 的 WebSocket 客户端，NapCat 不会把消息推给 AstrBot" }
    } else {
      W "onebot11 配置解析失败"
    }
  }
  $qr = Join-Path $napDir 'cache\qrcode.png'
  if (Test-Path $qr) {
    W ("二维码文件时间：" + (Get-Item $qr).LastWriteTime + "（如果就在刚刚，说明还没扫码登录）")
  }
}

Head "4. AstrBot 日志关键行（最后 40 条相关）"
$log = Join-Path $WorkDir 'astrbot.log'
if (Test-Path $log) {
  Get-Content -LiteralPath $log -Tail 300 -Encoding UTF8 -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '适配器|aiocqhttp|OneBot|ERROR|Traceback|Prepare to send|provider|WebSocket|反向' } |
    Select-Object -Last 40 | ForEach-Object { W ("  " + $_) }
} else {
  W "没有 astrbot.log"
}

Head "4.5 最近收到的 QQ 消息"
$logLines = @()
if (Test-Path $log) { $logLines = @(Get-Content -LiteralPath $log -Tail 3000 -Encoding UTF8 -ErrorAction SilentlyContinue) }
$incoming = @($logLines | Where-Object { $_ -match '\[napcat_aiocqhttp' })
if ($incoming.Count -eq 0) {
  W "一条都没收到 —— 消息根本没到 AstrBot（不是模型的问题）"
} else {
  W ("最近收到 " + $incoming.Count + " 条，最后 8 条：")
  $incoming | Select-Object -Last 8 | ForEach-Object { W ("  " + $_) }
  $uins = @()
  foreach ($l in $incoming) { if ($l -match '/(\d{5,})') { $uins += $Matches[1] } }
  if ($uins.Count -gt 0) { W ("消息来自账号：" + (($uins | Select-Object -Unique) -join ", ")) }
}

Head "4.6 适配器连接状态"
$conn = @($logLines | Where-Object { $_ -match '适配器已连接' })
if ($conn.Count -eq 0) {
  W "[X] 日志里没有「适配器已连接」—— NapCat 没连上 AstrBot"
} else {
  W ("[OK] 最近一次连接：" + $conn[-1])
}

Head "5. 结论与下一步"
if (-not $pA) { W "[X] AstrBot 没起来：先双击「启动AstrBot.bat」或回向导点启动" }
if (-not $pN) { W "[X] NapCat 没起来：回向导第④步点「启动 NapCat」，或双击 NapCat 的 launcher-user.bat" }
if ($pA -and -not $pW) { W "[X] 16199 没监听：AstrBot 的 aiocqhttp 适配器没起，检查配置里的 ws_reverse_port" }
if ($pN -and -not (Test-Path (Join-Path $napCfg 'onebot11_*.json'))) { W "[X] NapCat 没登录过：先在 NapCat 面板扫码登录 QQ" }
W ""
W "如果三项端口都 [OK] 但还是不回："
W "  1) 私聊小号发一句「你好」，看 astrbot.log 有没有 [napcat_aiocqhttp] 收到消息 / Prepare to send"
W "  2) 没收到 -> NapCat 那条 WebSocket 客户端没启用或地址不对（应为 ws://127.0.0.1:16199/ws）"
W "  3) 收到但没发 -> 模型 Key/模型名不对，回向导第③步点「测试连通」"
W ""
W "把本文件（桌面 大肥鱼不回消息诊断.txt）发给技术。"
W ""
if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
