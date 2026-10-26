# Build a release candidate from a clean stage.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -IncludePayload
#   powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -SkipInstaller -SkipSmoke
#
# Payload (optional, not committed):
#   payload\node.exe         -> tools\node.exe
#   payload\python\          -> tools\python\
#   payload\NapCat.Shell.zip -> vendor\NapCat.Shell.zip

[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$OutDir = '',
  [switch]$IncludePayload,
  [switch]$SkipInstaller,
  [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$root = Get-ProjectRoot
if (-not $Version) { $Version = Get-ProjectVersion $root }
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }

$stage = Join-Path $root 'build\stage'
Write-Host "== build dafeiyu deployer $Version =="
Write-Host "root : $root"
Write-Host "stage: $stage"

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Copy all top-level source directories except build-only ones.
$excludeDirs = @('build', 'dist', 'out', 'payload', '.git', '.github', 'node_modules', 'tests', 'installer')
Get-ChildItem -LiteralPath $root -Directory -Force | Where-Object {
  $excludeDirs -notcontains $_.Name
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force
}

# Copy all root-level files except repo-only docs / templates.
$excludeFiles = @('.gitignore', 'manifest.template.json', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md')
Get-ChildItem -LiteralPath $root -File -Force | Where-Object {
  $excludeFiles -notcontains $_.Name
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage $_.Name) -Force
}

# Optional runtime payload.
$payload = Join-Path $root 'payload'
$nodeSrc = Join-Path $payload 'node.exe'
$pySrc = Join-Path $payload 'python'
$napcatSrc = Join-Path $payload 'NapCat.Shell.zip'
$hasNode = $false
if (Test-Path -LiteralPath $nodeSrc) {
  Copy-Item -LiteralPath $nodeSrc -Destination (Join-Path $stage 'tools\node.exe') -Force
  $hasNode = $true
} elseif ($IncludePayload) {
  throw 'payload\node.exe is required when -IncludePayload is used'
}
if (Test-Path -LiteralPath $pySrc) {
  Copy-Item -LiteralPath $pySrc -Destination (Join-Path $stage 'tools\python') -Recurse -Force
}
if (Test-Path -LiteralPath $napcatSrc) {
  Copy-Item -LiteralPath $napcatSrc -Destination (Join-Path $stage 'vendor\NapCat.Shell.zip') -Force
}
if (-not $hasNode) {
  Write-Host '[WARN] no payload\node.exe: this build expects the user to have Node.js installed' -ForegroundColor Yellow
}

# Never ship local build tools (Inno compiler, extractors, downloaded installers).
$devDirs = @('InnoSetup6', 'innoextract2')
foreach ($d in $devDirs) {
  $p = Join-Path $stage "tools\$d"
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
$devFiles = @('7zr.exe', 'innoextract.zip', 'innosetup-6.0.5.exe', 'innosetup-6.7.3.exe')
foreach ($f in $devFiles) {
  $p = Join-Path $stage "tools\$f"
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}

# Remove runtime artifacts that must never ship.
$drop = @('wizard.log', 'wizard.err.log', 'wizard.lock', 'wizard.port', 'nul')
foreach ($d in $drop) {
  $p = Join-Path $stage $d
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -Recurse }
}
Get-ChildItem -LiteralPath $stage -Recurse -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq '__pycache__' } |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# Manifest (no BOM; hash excludes manifest itself).
$tree = Get-TreeHash $stage
$manifest = [ordered]@{
  schema_version = 1
  product        = 'dafeiyu-qq-deployer'
  version        = $Version
  git_commit     = (Get-GitCommit $root)
  built_at       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  min_windows    = '10.0.19042'
  node           = '>=20'
  files          = $tree.Count
  sha256         = $tree.Hash
  checks         = [ordered]@{
    bom             = $true
    secrets         = $true
    forbidden_files = $true
    syntax          = $true
    smoke           = (-not $SkipSmoke)
  }
}
$manifestPath = Join-Path $stage 'manifest.json'
$json = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# Gate.
$verifyScript = Join-Path $PSScriptRoot 'verify.ps1'
if ($SkipSmoke) {
  & $verifyScript -Stage $stage -SkipSmoke
} else {
  & $verifyScript -Stage $stage
}
if ($LASTEXITCODE -ne 0) { throw 'verify.ps1 failed; release aborted' }

# Package.
$isccPath = ''
$isccCmd = Get-Command iscc.exe -ErrorAction SilentlyContinue
if ($isccCmd) { $isccPath = $isccCmd.Source }
if (-not $isccPath) {
  $isccCandidates = @(
    (Join-Path $root 'tools\InnoSetup6\app\ISCC.exe'),
    (Join-Path $root 'tools\InnoSetup6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  )
  foreach ($c in $isccCandidates) {
    if (Test-Path -LiteralPath $c) { $isccPath = $c; break }
  }
}
if (-not $SkipInstaller) {
  if ($isccPath) {
    Write-Host "== compiling Inno Setup installer ($isccPath) =="
    & $isccPath "/DMyAppVersion=$Version" "/O$OutDir" (Join-Path $root 'installer\dafeiyu.iss')
    if ($LASTEXITCODE -ne 0) { throw 'iscc failed' }
  } else {
    Write-Host '[WARN] iscc.exe not found; only portable zip will be produced' -ForegroundColor Yellow
  }
}

Write-Host '== creating portable zip =='
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $OutDir "DaFeiYu-Portable-$Version.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
$zipStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
try {
  $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create, $false, [System.Text.Encoding]::UTF8)
  try {
    $filesToZip = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Sort-Object FullName)
    foreach ($f in $filesToZip) {
      # Zip entry names MUST use forward slashes (P54); CreateFromDirectory on
      # Windows PowerShell writes backslashes, which breaks non-Windows unzip.
      $rel = $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
      $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
      $es = $entry.Open()
      $fs = [System.IO.File]::OpenRead($f.FullName)
      try { $fs.CopyTo($es) } finally { $fs.Dispose(); $es.Dispose() }
    }
  } finally { $archive.Dispose() }
} finally { $zipStream.Dispose() }

Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $OutDir "DaFeiYu-$Version.manifest.json") -Force

# Checksums.
$artifacts = @(Get-ChildItem -LiteralPath $OutDir -File -Force | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object Name)
$lines = @()
foreach ($a in $artifacts) {
  $h = (Get-FileHash -LiteralPath $a.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $lines += ($h + '  ' + $a.Name)
}
$sumFile = Join-Path $OutDir 'SHA256SUMS.txt'
[System.IO.File]::WriteAllLines($sumFile, $lines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host 'BUILD OK' -ForegroundColor Green
foreach ($a in $artifacts) {
  Write-Host ("  {0,10:N1} MB  {1}" -f ($a.Length / 1MB), $a.FullName)
}
Write-Host ("  checksums: {0}" -f $sumFile)
