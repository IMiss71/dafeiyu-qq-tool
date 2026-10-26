# Stop any running DaFeiYu wizard (node.exe backend\server.js) before install/upgrade.
# ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
# Always exit 0: installer must continue even if an elevated old process cannot be killed.

$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:TEMP 'dafeiyu-stop-wizards.log'
function Note($m) {
  try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch {}
}

$killed = New-Object System.Collections.ArrayList

# Primary: node.exe whose command line contains backend\server.js.
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match 'backend[\\/]server\.js') }
  foreach ($p in $procs) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      [void]$killed.Add($p.ProcessId)
      Note ("killed pid {0}" -f $p.ProcessId)
    } catch {
      Note ("cannot kill pid {0}: {1}" -f $p.ProcessId, $_.Exception.Message)
    }
  }
} catch {
  Note ("CIM query failed: " + $_.Exception.Message)
}

# Fallback: ports 18765-18775, but only kill node.exe.
if ($killed.Count -eq 0) {
  try {
    $conns = Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalPort -ge 18765 -and $_.LocalPort -le 18775 }
    foreach ($c in $conns) {
      $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'node') {
        try {
          Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
          [void]$killed.Add($c.OwningProcess)
          Note ("killed pid {0} on port {1}" -f $c.OwningProcess, $c.LocalPort)
        } catch {
          Note ("cannot kill pid {0} on port {1}: {2}" -f $c.OwningProcess, $c.LocalPort, $_.Exception.Message)
        }
      }
    }
  } catch {
    Note ("port query failed: " + $_.Exception.Message)
  }
}

if ($killed.Count -eq 0) { Note 'no running wizard found' }
exit 0
