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
    return out.trim().split(/\r?\n/)[0].trim().split(/\s+/)[0] || '';
  } catch (_) { return ''; }
}

const port = readPort();
if (port) {
  for (const pid of listeningPids(port)) {
    if (!/node(\.exe)?$/i.test(imageName(pid))) continue;
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], {
        windowsHide: true, timeout: 10000,
      });
    } catch (_) { /* already gone */ }
  }
}
try { fs.unlinkSync(PORT_FILE); } catch (_) {}
try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
process.exit(0);
