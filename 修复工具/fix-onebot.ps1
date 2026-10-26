param([string]$WorkDir = '', [switch]$NoPause)

# 给 NapCat 的每个账号配置补上「连接 AstrBot」的 WebSocket 客户端
# 背景：NapCat 的 onebot11_<QQ号>.json 是按账号分开存的，换号后新号没有这条配置
$ErrorActionPreference = 'Continue'

$desk = [Environment]::GetFolderPath('Desktop')
$log = Join-Path $desk '小号连接修复.log'
if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
function W($m) { Write-Host $m; Add-Content -LiteralPath $log -Value ([string]$m) -Encoding UTF8 }

if (-not $WorkDir) {
  if ($env:DAFEIYU_WORK_DIR) { $WorkDir = $env:DAFEIYU_WORK_DIR }
  else { $WorkDir = Join-Path $env:LOCALAPPDATA 'DaFeiYuQQ' }
}
$napCfg = Join-Path $WorkDir 'NapCat\config'
$dataDir = Join-Path $WorkDir 'data'

function ReadJson($p) {
  try {
    $raw = Get-Content -LiteralPath $p -Raw -Encoding UTF8
    if ($raw -and $raw.Length -gt 0 -and [int][char]$raw[0] -eq 65279) { $raw = $raw.Substring(1) }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

W "小号连接修复"
W ("工作目录：" + $WorkDir)
if (-not (Test-Path $napCfg)) {
  W "找不到 NapCat 配置目录：$napCfg"
  W "说明 NapCat 还没装/没登录过。回向导第④步先启动 NapCat 并登录。"
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 1
}

# 从 AstrBot 配置里读端口和 token
$port = 16199
$token = ''
foreach ($f in @((Join-Path $dataDir 'cmd_config.json'), (Join-Path $dataDir 'config.json'))) {
  $c = ReadJson $f
  if ($c) {
    $found = $false
    foreach ($p in @($c.platform)) {
      if ($p -and $p.type -eq 'aiocqhttp') {
        if ($p.ws_reverse_port) { $port = [int]$p.ws_reverse_port }
        $token = [string]$p.ws_reverse_token
        $found = $true
        break
      }
    }
    if ($found) { break }
  }
}
W ("AstrBot 监听端口：" + $port + "，token：" + $(if ($token) { "已设置" } else { "空" }))

$files = @(Get-ChildItem -LiteralPath $napCfg -Filter 'onebot11_*.json' -ErrorAction SilentlyContinue)
if ($files.Count -eq 0) {
  W "没有 onebot11_*.json —— NapCat 还没登录过 QQ。先登录小号再来跑。"
  if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
  exit 1
}

W ("发现 " + $files.Count + " 个账号配置：")
foreach ($f in $files) { W ("  - " + $f.Name + "（改于 " + $f.LastWriteTime + "）") }

$changed = 0
foreach ($f in $files) {
  $j = ReadJson $f.FullName
  if (-not $j) { W ("[跳过] " + $f.Name + " 解析失败"); continue }
  if (-not $j.PSObject.Properties['network']) {
    $j | Add-Member -NotePropertyName network -NotePropertyValue (New-Object psobject) -Force
  }
  $clients = @()
  if ($j.network.PSObject.Properties['websocketClients'] -and $j.network.websocketClients) {
    $clients = @($j.network.websocketClients)
  }
  $hit = $clients | Where-Object { $_ -and ([string]$_.url -like ("*:" + $port + "*")) } | Select-Object -First 1
  $url = "ws://127.0.0.1:$port/ws"
  if ($hit) {
    $hit.enable = $true
    $hit.url = $url
    $hit.token = $token
    W ("[已修正] " + $f.Name + " 里已有的客户端 -> " + $url)
  } else {
    $obj = New-Object psobject
    $obj | Add-Member -NotePropertyName name -NotePropertyValue 'astrbot' -Force
    $obj | Add-Member -NotePropertyName enable -NotePropertyValue $true -Force
    $obj | Add-Member -NotePropertyName url -NotePropertyValue $url -Force
    $obj | Add-Member -NotePropertyName reportSelfMessage -NotePropertyValue $false -Force
    $obj | Add-Member -NotePropertyName messagePostFormat -NotePropertyValue 'array' -Force
    $obj | Add-Member -NotePropertyName token -NotePropertyValue $token -Force
    $obj | Add-Member -NotePropertyName debug -NotePropertyValue $false -Force
    $obj | Add-Member -NotePropertyName heartInterval -NotePropertyValue 30000 -Force
    $obj | Add-Member -NotePropertyName reconnectInterval -NotePropertyValue 5000 -Force
    $clients = @($clients) + $obj
    W ("[已新增] " + $f.Name + " -> " + $url)
  }
  $j.network | Add-Member -NotePropertyName websocketClients -NotePropertyValue @($clients) -Force
  try {
    $json = $j | ConvertTo-Json -Depth 30
    [System.IO.File]::WriteAllText($f.FullName, $json, (New-Object System.Text.UTF8Encoding($false)))
    $changed++
  } catch {
    W ("[失败] " + $f.Name + "：" + $_.Exception.Message)
  }
}

W ""
if ($changed -gt 0) {
  W "写入完成，共修改 $changed 个账号配置。"
  W "现在必须重启 NapCat 才会生效："
  W "  1) 关闭 NapCat 控制台窗口（或任务管理器结束 NapCat / QQ）"
  W "  2) 回向导第④步点「启动 NapCat」，让小号重新登录"
  W "  3) 登录后私聊小号发一句「你好」试试"
} else {
  W "没有需要修改的配置（可能已经配好了）。"
}
W ""
W ("详细记录：桌面 小号连接修复.log")
if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
