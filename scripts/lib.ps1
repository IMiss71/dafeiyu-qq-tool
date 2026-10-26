# Shared helpers for build/verify scripts.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.

function Get-ProjectRoot {
  param([string]$Start = $PSScriptRoot)
  return (Resolve-Path (Join-Path $Start '..')).Path
}

function Get-ProjectVersion {
  param([string]$Root)
  $pkg = Join-Path $Root 'package.json'
  if (-not (Test-Path -LiteralPath $pkg)) { throw "package.json not found: $pkg" }
  return (Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version
}

function Get-GitCommit {
  param([string]$Root)
  try {
    $out = & git -C $Root rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Out-String).Trim() }
  } catch {}
  return 'uncommitted'
}

function Get-TreeHash {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "path not found: $Path" }
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force |
    Where-Object { $_.Name -ne 'manifest.json' } |
    Sort-Object FullName)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $sb = New-Object System.Text.StringBuilder
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($Path.Length + 1).Replace('\', '/')
    $h = [System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($f.FullName))).Replace('-', '').ToLowerInvariant()
    [void]$sb.Append($rel)
    [void]$sb.Append("`n")
    [void]$sb.Append($h)
    [void]$sb.Append("`n")
  }
  $final = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))).Replace('-', '').ToLowerInvariant()
  return [pscustomobject]@{ Hash = $final; Count = $files.Count }
}

function Test-TextFile {
  param([System.IO.FileInfo]$File, [int]$MaxBytes = 4194304)
  if ($File.Length -gt $MaxBytes) { return $false }
  $ext = [System.IO.Path]::GetExtension($File.Name).ToLowerInvariant()
  return @('.js', '.json', '.md', '.txt', '.ps1', '.vbs', '.bat', '.html', '.css', '.yml', '.yaml', '.py') -contains $ext
}

function Find-Files {
  param([string]$Root, [string[]]$Include = @('*'), [string[]]$ExcludeDirs = @())
  $items = Get-ChildItem -LiteralPath $Root -Recurse -File -Force -Include $Include -ErrorAction SilentlyContinue
  foreach ($i in $items) {
    $skip = $false
    foreach ($d in $ExcludeDirs) {
      if ($i.FullName -like (Join-Path $Root $d) + '\*') { $skip = $true; break }
      if ($i.FullName -like (Join-Path $Root $d)) { $skip = $true; break }
    }
    if (-not $skip) { $i }
  }
}
