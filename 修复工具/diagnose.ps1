param([string]$WorkDir = '', [switch]$NoPause)

# AstrBot 启动诊断：把现场信息收集成一个 txt，方便远程判断
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$outFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AstrBot启动诊断.txt'
if (Test-Path $outFile) { Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue }
function W($m) {
  $line = [string]$m
  Write-Host $line
  Add-Content -LiteralPath $outFile -Value $line -Encoding UTF8
}
function Head($t) {
  W ""
  W ("=" * 60)
  W (" " + $t)
  W ("=" * 60)
}

W "AstrBot 启动诊断报告"
W ("生成时间：" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))

Head "1. 系统信息"
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  W ("系统：" + $os.Caption + " " + $os.Version)
  W ("内存：" + [math]::Round($os.TotalVisibleMemorySize / 1024 / 1024, 1) + " GB")
} catch { W ("系统信息读取失败：" + $_.Exception.Message) }
W ("架构：" + $env:PROCESSOR_ARCHITECTURE)
try {
  $d = Get-PSDrive C -ErrorAction Stop
  W ("C 盘剩余：" + [math]::Round($d.Free / 1GB, 1) + " GB / 共 " + [math]::Round(($d.Free + $d.Used) / 1GB, 1) + " GB")
} catch { }

if (-not $WorkDir) {
  if ($env:DAFEIYU_WORK_DIR) { $WorkDir = $env:DAFEIYU_WORK_DIR }
  else { $WorkDir = Join-Path $env:LOCALAPPDATA 'DaFeiYuQQ' }
}
W ("工作目录：" + $WorkDir)
W ("目录存在：" + (Test-Path $WorkDir))
$hasChinese = $WorkDir -match '[^\x00-\x7F]'
W ("路径含非 ASCII 字符：" + $hasChinese + "（建议纯英文路径）")

Head "2. AstrBot 安装情况"
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
W ("astrbot.exe：" + ($(if ($exe) { $exe } else { "未找到" })))
if ($exe) {
  try { W ("--version：" + ((& $exe --version 2>&1 | Out-String).Trim())) }
  catch { W ("--version 失败：" + $_.Exception.Message) }
}
try { W ("uv：" + ((& uv --version 2>&1 | Out-String).Trim())) } catch { W "uv：未找到/不可用" }

Head "3. 配置检查"
$dataDir = Join-Path $WorkDir 'data'
$cfg = Join-Path $dataDir 'config.json'
$cmd = Join-Path $dataDir 'cmd_config.json'
foreach ($f in @($cfg, $cmd)) {
  W ("--- " + $f)
  if (-not (Test-Path $f)) { W "不存在"; continue }
  W ("大小：" + (Get-Item $f).Length + " 字节")
  try {
    $raw = Get-Content -LiteralPath $f -Raw -Encoding UTF8
    if ($raw -and $raw.Length -gt 0 -and [int][char]$raw[0] -eq 65279) { $raw = $raw.Substring(1) }
    $j = $raw | ConvertFrom-Json -ErrorAction Stop
    W ("JSON 解析：OK")
    if ($j.PSObject.Properties['dashboard']) {
      W ("dashboard.enable=" + $j.dashboard.enable + " host=" + $j.dashboard.host + " port=" + $j.dashboard.port)
    } else { W "dashboard：缺失（AstrBot 会用默认 6185，向导会等不到 16885）" }
    $plat = @($j.platform)
    W ("platform 条目数：" + $plat.Count)
    foreach ($p in $plat) {
      if ($p) {
        W ("  - id=" + $p.id + " type=" + $p.type + " enable=" + $p.enable + " ws_reverse_host=" + $p.ws_reverse_host + " ws_reverse_port=" + $p.ws_reverse_port + " (host=" + $p.host + " port=" + $p.port + ")")
      }
    }
  } catch {
    W ("JSON 解析失败：" + $_.Exception.Message)
    W ">>> 配置文件已损坏，这很可能就是启动失败的原因。"
  }
}
W ("data_v4.db 存在：" + (Test-Path (Join-Path $dataDir 'data_v4.db')))

Head "4. 端口占用"
function CheckPort($port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $r = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($r.AsyncWaitHandle.WaitOne(800) -and $c.Connected) {
      $c.Close()
      return $true
    }
    $c.Close()
    return $false
  } catch { return $false }
}
foreach ($p in @(16885, 16199, 6099, 6185, 6199)) {
  $alive = CheckPort $p
  $owner = ""
  try {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($conn) {
      $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
      if ($proc) { $owner = " <- " + $proc.ProcessName + " (PID " + $proc.Id + ")" }
    }
  } catch { }
  W ("端口 " + $p + "：" + $(if ($alive) { "占用中" } else { "空闲" }) + $owner)
}

Head "5. 日志（最后 80 行）"
$logFiles = @()
$logFiles += (Join-Path $WorkDir 'astrbot.log')
if (Test-Path (Join-Path $dataDir 'logs')) {
  $logFiles += (Get-ChildItem (Join-Path $dataDir 'logs') -Filter *.log -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 2 -ExpandProperty FullName)
}
$any = $false
foreach ($lf in $logFiles) {
  if ($lf -and (Test-Path $lf)) {
    $any = $true
    W ("--- " + $lf + "（修改于 " + (Get-Item $lf).LastWriteTime + "）")
    Get-Content -LiteralPath $lf -Tail 80 -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { W ("  " + $_) }
  }
}
if (-not $any) { W "没有找到 astrbot.log（可能从未成功启动过）" }

Head "6. 试启动（最多等 50 秒）"
if (CheckPort 16885) {
  W "16885 已在监听：AstrBot 可能已经在运行，跳过试启动。"
} elseif (-not $exe) {
  W "没有 astrbot.exe，无法试启动。先回向导第②步重装。"
} else {
  $so = Join-Path $env:TEMP 'dfy_start_out.txt'
  $se = Join-Path $env:TEMP 'dfy_start_err.txt'
  Remove-Item $so, $se -Force -ErrorAction SilentlyContinue
  # PS 5.1：环境变量只有大小写不同（HTTPS_PROXY / https_proxy）时 Start-Process 会报字典重复
  $savedEnv = @{}
  foreach ($k in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
    $low = $k.ToLower()
    try {
      if ((Test-Path "Env:$low") -and (Test-Path "Env:$k")) {
        $savedEnv[$low] = (Get-Item "Env:$low").Value
        Remove-Item "Env:$low" -ErrorAction SilentlyContinue
      }
    } catch { }
  }
  try {
    $p = Start-Process -FilePath $exe -ArgumentList 'run' -WorkingDirectory $WorkDir `
         -RedirectStandardOutput $so -RedirectStandardError $se -PassThru -WindowStyle Hidden
    W ("已启动进程 PID=" + $p.Id + "，等待面板端口 16885…")
    $ok = $false
    for ($i = 0; $i -lt 50; $i++) {
      Start-Sleep -Seconds 1
      if (CheckPort 16885) { $ok = $true; break }
      if ($p.HasExited) { break }
    }
    if ($ok) {
      W "结果：AstrBot 能正常启动（16885 已监听）。"
      W "如果向导仍报失败，多半是向导自己的等待超时，重开向导再点启动即可。"
    } elseif ($p.HasExited) {
      W ("结果：进程已退出，ExitCode=" + $p.ExitCode)
    } else {
      W "结果：进程还在但不监听 16885（超过 50 秒），可能卡在初始化/端口冲突。"
    }
    if (Test-Path $so) { W "--- 启动 stdout（最后 60 行）"; Get-Content $so -Tail 60 | ForEach-Object { W ("  " + $_) } }
    if (Test-Path $se) { W "--- 启动 stderr（最后 60 行）"; Get-Content $se -Tail 60 | ForEach-Object { W ("  " + $_) } }
    if (-not $p.HasExited) {
      W "清理：结束本次试启动的进程树"
      & cmd /c ("taskkill /PID " + $p.Id + " /T /F >nul 2>&1")
    }
  } catch {
    W ("试启动失败：" + $_.Exception.Message)
  } finally {
    foreach ($k in $savedEnv.Keys) {
      try { Set-Item "Env:$k" $savedEnv[$k] -ErrorAction SilentlyContinue } catch { }
    }
  }
}

Head "7. 结论提示"
W "把本文件（桌面 AstrBot启动诊断.txt）整个发给技术。"
W "常见结论："
W "  · 配置 JSON 解析失败 -> 配置坏了，用向导「清空环境」重装，或恢复备份"
W "  · 16885/16199 被别的程序占用 -> 关掉占用程序，或重启电脑再试"
W "  · 进程一启动就退出 -> 看第 6 节 stderr 的 Traceback"
W "  · 端口一直不监听 -> 看第 5 节日志，多半是依赖/配置/杀软问题"
W ""
if (-not $NoPause) { Read-Host "按回车退出" | Out-Null }
