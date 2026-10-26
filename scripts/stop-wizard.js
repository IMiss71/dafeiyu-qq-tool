// Stop only the wizard (the Node process listening on wizard.port).
// Used by the uninstaller / "stop" shortcut; daily `scripts/stop.js` intentionally
// leaves the wizard running.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT_FILE = path.join(ROOT, 'wizard.port');
const LOCK_FILE = path.join(ROOT, 'wizard.lock');

function readPort() {
  try {
    const n = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

function readLockPid() {
  try {
    const n = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? String(n) : '';
  } catch (_) {
    return '';
  }
}

function listeningPids(port) {
  const pids = new Set();
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      windowsHide: true, timeout: 10000, encoding: 'utf8',
    });
  } catch (_) { return pids; }
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!new RegExp(`:${port}\\s`).test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = cols[cols.length - 1];
    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }
  return pids;
}

function imageName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      windowsHide: true, timeout: 10000, encoding: 'utf8',
    });
    if (/No tasks|没有运行/i.test(out)) return '';
    const name = out.trim().split(/\r?\n/)[0].trim().split(/\s+/)[0] || '';
    if (name) return name;
  } catch (_) { /* fall through to PowerShell */ }
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).ProcessName`], {
      windowsHide: true, timeout: 10000, encoding: 'utf8',
    });
    return out.trim();
  } catch (_) { return ''; }
}

const port = readPort();
const lockPid = readLockPid();
let pids = [];
if (port) pids = [...listeningPids(port)];
if (lockPid && !pids.includes(lockPid)) pids.push(lockPid);
if (pids.length) {
  for (const pid of pids) {
    if (!/node(\.exe)?$/i.test(imageName(pid))) continue;
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], {
        windowsHide: true, timeout: 10000,
      });
    } catch (_) {
      // Some locked-down environments deny taskkill. Fall back to PowerShell
      // Stop-Process (same user, no window), then to process.kill.
      try {
        execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${Number(pid)} -Force`], {
          windowsHide: true, timeout: 10000,
        });
      } catch (_) {
        try { process.kill(Number(pid)); } catch (_) {}
      }
    }
  }
}
try { fs.unlinkSync(PORT_FILE); } catch (_) {}
try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
if (pids.some((pid) => imageName(pid))) process.exit(2);
process.exit(0);
