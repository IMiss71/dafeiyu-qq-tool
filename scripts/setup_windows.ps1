# setup_windows.ps1 —— 大肥鱼 QQ 一键包（独立脚本版 / 备用）
# 注意：绝大多数用户应该用「启动向导.bat」，本脚本只是不走向导的最小安装路径。
# 端口已与主工具对齐：面板 16885、反向 WS 16199（旧版本这里是 6185/6199，别再用）。
# 用法：右键“用 PowerShell 运行”，或 PowerShell 执行：
#   powershell -ExecutionPolicy Bypass -File setup_windows.ps1
$ErrorActionPreference = 'Stop'

$WORK = Join-Path $env:LOCALAPPDATA 'DaFeiYuQQ'
$data = Join-Path $WORK 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null

function Step($m) { Write-Host "`n[步骤] $m" -ForegroundColor Cyan }

Step '检查 / 安装 uv（Python 包管理器）'
$uvBin = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
if (-not (Test-Path $uvBin)) {
    Write-Host '未检测到 uv，正在安装（需联网）…'
    irm https://astral.sh/uv/install.ps1 | iex
}
if (-not (Test-Path $uvBin)) { $uvBin = 'uv' }

Step '安装 AstrBot'
& $uvBin tool install astrbot --python 3.12

Step '初始化 AstrBot 数据目录'
Push-Location $WORK
& $uvBin tool run astrbot init
Pop-Location

Step '填写大模型配置'
Write-Host '可选：deepseek / siliconflow / openai / ollama'
$provider = Read-Host '选择服务商（回车=deepseek）'
if (-not $provider) { $provider = 'deepseek' }
$apiKey = Read-Host '输入 API Key（选 ollama 可随便填）'

switch ($provider) {
    'deepseek'    { $apiBase = 'https://api.deepseek.com/v1';   $model = 'deepseek-chat' }
    'siliconflow' { $apiBase = 'https://api.siliconflow.cn/v1'; $model = 'deepseek-ai/DeepSeek-V3' }
    'openai'      { $apiBase = 'https://api.openai.com/v1';     $model = 'gpt-4o-mini' }
    'ollama'      { $apiBase = 'http://localhost:11434/v1';     $model = 'qwen2.5:7b'; if (-not $apiKey) { $apiKey = 'ollama' } }
    default       { $apiBase = 'https://api.deepseek.com/v1';   $model = 'deepseek-chat' }
}

$cfgPath = Join-Path $data 'config.json'
$cfg = @{}
if (Test-Path $cfgPath) { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json -AsHashtable }
$cfg.provider = @(@{
    id           = $provider
    type         = 'openai_chat_completion'
    model        = $model
    key          = @($apiKey)
    api_base     = $apiBase
    enable       = $true
})
$cfg.provider_settings = @{ default_provider_id = $provider; enable = $true }
$cfg | ConvertTo-Json -Depth 10 | Set-Content $cfgPath -Encoding UTF8

Step '生成 NapCat OneBot 参考配置'
$nap = @{
    http     = @{ enable = $false; host = '127.0.0.1'; port = 3000; secret = ''; postUrls = @() }
    ws       = @{ enable = $true;  host = '127.0.0.1'; port = 3001 }
    wsClient = @{ enable = $true; url = 'ws://127.0.0.1:16199/ws'; token = ''; reconnectInterval = 5000; heartInterval = 5000 }
}
$nap | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $WORK 'napcat_onebot.json') -Encoding UTF8

Step '后台启动 AstrBot'
Start-Process -FilePath $uvBin -ArgumentList 'tool','run','astrbot','run' -WorkingDirectory $WORK -WindowStyle Hidden

Step '打开 AstrBot 仪表盘'
Start-Process 'http://127.0.0.1:16885/'

Write-Host "`n✅ 基础安装完成！接下来请手动：" -ForegroundColor Green
Write-Host "  1) 安装并打开 NapCat（https://github.com/NapNeko/NapCatQQ/releases）"
Write-Host "  2) 用 QQ 小号扫码登录 NapCat"
Write-Host "  3) 在 NapCat 添加「WebSocket 客户端」，地址填 ws://127.0.0.1:16199/ws 并保存"
Write-Host "  4) 在 AstrBot 仪表盘「人格设定」粘贴大肥鱼人设并保存；对话框输入 /persona 大肥鱼"
Write-Host "  5) 用另一个 QQ 给小号发消息测试"
