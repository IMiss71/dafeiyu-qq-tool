# Release gate. Exit code 0 = pass, 1 = fail.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -Stage build\stage
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -Stage . -SkipManifest -SkipSmoke

[CmdletBinding()]
param(
  [string]$Stage = '',
  [switch]$SkipManifest,
  [switch]$SkipSyntax,
  [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$root = Get-ProjectRoot
if (-not $Stage) {
  $candidate = Join-Path $root 'build\stage'
  if (Test-Path -LiteralPath $candidate) { $Stage = $candidate } else { $Stage = $root }
}
if (-not (Test-Path -LiteralPath $Stage)) { Write-Host "[FAIL] stage not found: $Stage" -ForegroundColor Red; exit 1 }
$Stage = (Resolve-Path -LiteralPath $Stage).Path

$script:fail = 0
function Fail([string]$m) { Write-Host "[FAIL] $m" -ForegroundColor Red; $script:fail++ }
function Ok([string]$m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

$excludeDirs = @('build', 'dist', 'payload', '.git', 'node_modules', 'tests\tmp')
function Test-Excluded([string]$Path) {
  foreach ($d in $excludeDirs) {
    $prefix = Join-Path $Stage $d
    if ($Path -eq $prefix -or $Path.StartsWith($prefix + '\')) { return $true }
  }
  return $false
}
function Scan-Files([string[]]$Extensions) {
  Get-ChildItem -LiteralPath $Stage -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $Extensions -contains $_.Extension.ToLowerInvariant() -and -not (Test-Excluded $_.FullName) }
}

Write-Host "== dafeiyu deployer verify =="
Write-Host "stage: $Stage"

# 1) required files
$required = @(
  'backend\server.js', 'backend\deploy.js', 'backend\config_templates.js',
  'wizard\index.html', 'wizard\app.js',
  'launcher\start-hidden.vbs', 'launcher\stop-hidden.vbs',
  'LICENSE', 'package.json'
)
foreach ($rel in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $Stage $rel))) { Fail "required file missing: $rel" }
}
if ($Stage -eq $root -and -not (Test-Path -LiteralPath (Join-Path $Stage 'installer\dafeiyu.iss'))) {
  Fail 'required file missing: installer\dafeiyu.iss'
}

# 2) version consistency
$pkgVersion = ''
try { $pkgVersion = Get-ProjectVersion $Stage } catch { Fail 'package.json is missing or invalid' }
if ($pkgVersion) { Ok "package version: $pkgVersion" }

# 3) JSON BOM
$jsonFiles = @(Get-ChildItem -LiteralPath $Stage -Recurse -File -Filter '*.json' -Force -ErrorAction SilentlyContinue |
  Where-Object { -not (Test-Excluded $_.FullName) })
$bomCount = 0
foreach ($f in $jsonFiles) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Fail "UTF-8 BOM in JSON: $($f.FullName.Substring($Stage.Length + 1))"
    $bomCount++
  }
}
if ($bomCount -eq 0) { Ok "no UTF-8 BOM in $($jsonFiles.Count) JSON file(s)" }

# 4) forbidden files
$forbiddenNames = @('cmd_config.json', 'wizard.log', 'wizard.err.log', 'wizard.lock', 'wizard.port', 'nul')
$forbiddenCount = 0
Get-ChildItem -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
  if (Test-Excluded $_.FullName) { return }
  $bad = $false
  if ($forbiddenNames -contains $_.Name) { $bad = $true }
  if ($_.Name -like '*.bak-*') { $bad = $true }
  if ($_.PSIsContainer -and $_.Name -eq '__pycache__') { $bad = $true }
  if ($_.FullName -like '*\data\cmd_config.json') { $bad = $true }
  if ($bad) { Fail "forbidden path: $($_.FullName.Substring($Stage.Length + 1))"; $forbiddenCount++ }
}
if ($forbiddenCount -eq 0) { Ok 'no forbidden runtime/internal files' }

# 5) secret / fixed-password scan
$patterns = @(
  @{ Name = 'fixed dashboard password'; Regex = ('DaFeiYu' + '6{3}') },
  @{ Name = 'looks like an API key'; Regex = 'sk-[A-Za-z0-9]{20,}' },
  @{ Name = 'absolute user path'; Regex = 'C:\\Users\\' },
  @{ Name = 'non-empty jwt_secret'; Regex = 'jwt_secret"\s*:\s*"[^"]+' }
)
$textFiles = Scan-Files @('.js', '.json', '.md', '.txt', '.ps1', '.vbs', '.bat', '.html', '.css', '.yml', '.yaml', '.py')
$secretCount = 0
foreach ($f in $textFiles) {
  $text = ''
  try { $text = [System.IO.File]::ReadAllText($f.FullName) } catch { continue }
  foreach ($p in $patterns) {
    if ($text -match $p.Regex) {
      Fail ("{0}: {1}" -f $p.Name, $f.FullName.Substring($Stage.Length + 1))
      $secretCount++
    }
  }
}
if ($secretCount -eq 0) { Ok "no fixed password / obvious secret in $($textFiles.Count) text file(s)" }

# 6) JS syntax
if (-not $SkipSyntax) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Fail 'node not found; cannot run syntax check'
  } else {
    $jsFiles = @(Scan-Files @('.js') | Where-Object { $_.FullName -notlike '*\tools\python\*' -and $_.FullName -notlike '*\payload\*' })
    $badJs = 0
    foreach ($f in $jsFiles) {
      & $node.Source --check $f.FullName 2>$null
      if ($LASTEXITCODE -ne 0) { Fail "JS syntax: $($f.FullName.Substring($Stage.Length + 1))"; $badJs++ }
    }
    if ($badJs -eq 0) { Ok "JS syntax: $($jsFiles.Count) file(s)" }
  }
}

# 7) Python syntax (optional; no pycache written)
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py -and $py.Source -like '*WindowsApps*') { $py = $null }  # Store alias, not a real Python
if ($py) {
  try {
    & $py.Source --version *> $null
    if ($LASTEXITCODE -ne 0) { $py = $null }
  } catch { $py = $null }
}
if ($py) {
  $pyFiles = @(Scan-Files @('.py') | Where-Object { $_.FullName -notlike '*\tools\python\*' -and $_.FullName -notlike '*\payload\*' })
  $badPy = 0
  foreach ($f in $pyFiles) {
    & $py.Source -c "import sys; compile(open(sys.argv[1], encoding='utf-8-sig').read(), sys.argv[1], 'exec')" $f.FullName 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "Python syntax: $($f.FullName.Substring($Stage.Length + 1))"; $badPy++ }
  }
  if ($badPy -eq 0) { Ok "Python syntax: $($pyFiles.Count) file(s)" }
} else {
  Warn 'python not found; skipped Python syntax check'
}

# 8) manifest
if (-not $SkipManifest) {
  $mp = Join-Path $Stage 'manifest.json'
  if (-not (Test-Path -LiteralPath $mp)) {
    Fail 'manifest.json missing'
  } else {
    try {
      $m = Get-Content -LiteralPath $mp -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($pkgVersion -and $m.version -ne $pkgVersion) { Fail "manifest version $($m.version) != package version $pkgVersion" }
      $tree = Get-TreeHash $Stage
      if ([int]$m.files -ne [int]$tree.Count) { Fail "manifest files $($m.files) != actual $($tree.Count)" }
      if ($m.sha256 -ne $tree.Hash) { Fail "manifest sha256 mismatch (manifest=$($m.sha256), actual=$($tree.Hash))" }
      if ($script:fail -eq 0) { Ok "manifest: $($m.version) / $($m.files) files / $($m.sha256.Substring(0, 12))..." }
    } catch {
      Fail "manifest.json invalid: $($_.Exception.Message)"
    }
  }
}

# 9) smoke test
if (-not $SkipSmoke) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Fail 'node not found; cannot run smoke test'
  } else {
    $port = Get-Random -Minimum 21000 -Maximum 39000
    $tmp = Join-Path $root ('build\verify-tmp-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $keys = @('DAFEIYU_WIZARD_PORT', 'DAFEIYU_PROXY_PORT', 'DAFEIYU_DASHBOARD_PORT', 'DAFEIYU_NAPCAT_PORT', 'DAFEIYU_WORK_DIR')
    $oldEnv = @{}
    foreach ($k in $keys) { $oldEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
    $env:DAFEIYU_WIZARD_PORT = "$port"
    $env:DAFEIYU_PROXY_PORT = "$($port + 1)"
    $env:DAFEIYU_DASHBOARD_PORT = "$($port + 2)"
    $env:DAFEIYU_NAPCAT_PORT = "$($port + 3)"
    $env:DAFEIYU_WORK_DIR = $tmp
    $oldProxy = [System.Net.WebRequest]::DefaultWebProxy
    [System.Net.WebRequest]::DefaultWebProxy = $null
    $outLog = Join-Path $tmp 'server.out.log'
    $errLog = Join-Path $tmp 'server.err.log'
    $proc = $null
    try {
      $proc = Start-Process -FilePath $node.Source -ArgumentList 'backend/server.js' -WorkingDirectory $Stage -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
      $base = "http://127.0.0.1:$port"
      $ready = $false
      for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        try {
          $r = Invoke-WebRequest -Uri "$base/api/ping" -UseBasicParsing -TimeoutSec 2
          if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
      }
      if (-not $ready) {
        Fail "smoke: /api/ping not ready on $base"
        if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" } }
      } else {
        $html = (Invoke-WebRequest -Uri "$base/" -UseBasicParsing -TimeoutSec 5).Content
        if ($html -notmatch '__DFY_TOKEN__') { Fail 'smoke: wizard token not injected into index.html' }
        $tokenMatch = [regex]::Match($html, '__DFY_TOKEN__="([a-f0-9]+)"')
        if (-not $tokenMatch.Success) {
          Fail 'smoke: token value not found in index.html'
        } else {
          try {
            Invoke-WebRequest -Uri "$base/api/about" -UseBasicParsing -TimeoutSec 5 | Out-Null
            Fail 'smoke: /api/about accepted without token'
          } catch {
            $code = 0
            try { $code = [int]$_.Exception.Response.StatusCode } catch {}
            if ($code -ne 403) { Fail "smoke: /api/about without token returned $code, expected 403" }
          }
          try {
            $r2 = Invoke-WebRequest -Uri "$base/api/about" -UseBasicParsing -Headers @{ 'X-DaFeiYu-Wizard' = $tokenMatch.Groups[1].Value } -TimeoutSec 5
            if ($r2.StatusCode -ne 200) { Fail "smoke: /api/about with token returned $($r2.StatusCode)" }
          } catch {
            Fail "smoke: /api/about with token failed: $($_.Exception.Message)"
          }
          try {
            $r3 = Invoke-WebRequest -Uri "$base/api/install-state" -UseBasicParsing -Headers @{ 'X-DaFeiYu-Wizard' = $tokenMatch.Groups[1].Value } -TimeoutSec 5
            $j3 = $r3.Content | ConvertFrom-Json
            if ($r3.StatusCode -ne 200 -or -not $j3.ok) { Fail "smoke: /api/install-state returned $($r3.StatusCode)" }
          } catch {
            Fail "smoke: /api/install-state failed: $($_.Exception.Message)"
          }
        }
        if ($script:fail -eq 0) { Ok "smoke: server up, token injected, API gated" }
      }
    } catch {
      Fail "smoke: $($_.Exception.Message)"
    } finally {
      if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
      [System.Net.WebRequest]::DefaultWebProxy = $oldProxy
      foreach ($k in $keys) { [Environment]::SetEnvironmentVariable($k, $oldEnv[$k], 'Process') }
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
      # The server writes these into the stage root on startup; do not ship them.
      foreach ($n in @('wizard.port', 'wizard.lock', 'wizard.log', 'wizard.err.log')) {
        $p = Join-Path $Stage $n
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
      }
    }
  }
}

Write-Host ''
if ($script:fail -gt 0) {
  Write-Host "VERIFY FAILED: $($script:fail) issue(s)" -ForegroundColor Red
  exit 1
}
Write-Host 'VERIFY OK' -ForegroundColor Green
exit 0
