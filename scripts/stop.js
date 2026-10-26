// stop.js —— 一键关闭大肥鱼（AstrBot + NapCat），不动向导
//
// 为什么按端口杀：AstrBot 是 astrbot.exe（有时还套一层 python.exe），NapCat 是注入进 QQ 的，
// 进程名都不唯一；而这三个端口只有它们会监听，按端口反查 PID 最准，也不会误杀别的程序。
//   · 16885 AstrBot 面板
//   · 16199 AstrBot 的反向 WS（NapCat 连过来）
//   · 6099  NapCat WebUI（实际监听的是被注入的 QQ 进程）
// QQ 会自我拉起，所以 6099 要连杀几轮；只杀监听 6099 的那个 QQ，你自己开着的 QQ 不受影响。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const deploy = require(path.join(__dirname, '..', 'backend', 'deploy.js'));
const WORK_DIR = deploy.WORK_DIR;
const LOG_PATH = path.join(WORK_DIR, 'boot.log');

function log(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\r\n');
  } catch (_) {}
  try { console.log(msg); } catch (_) {}
}

function listeningPids(port) {
  const pids = new Set();
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  } catch (_) { return pids; }
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    // 形如  TCP    127.0.0.1:16885    0.0.0.0:0    LISTENING    12345
    if (!new RegExp(`:${port}\\s`).test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = cols[cols.length - 1];
    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }
  return pids;
}

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 10000 });
    return true;
  } catch (_) { return false; }
}

// PID 复用防护：杀之前核对进程身份，避免把 PID 恰好被复用的无关程序强杀掉
function pidImageName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      windowsHide: true, timeout: 10000, encoding: 'utf8',
    });
    if (/No tasks|没有运行/i.test(out)) return '';
    const cols = out.trim().split(/\r?\n/)[0].trim().split(/\s+/);
    return cols[0] || '';
  } catch (_) { return ''; }
}

function sleep(ms) {
  // 同步等待：不用 timeout/ping 这类外部命令（不同机器 PATH 里可能是 Git 的同名工具，行为不一致）
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const t = Date.now();
    while (Date.now() - t < ms) { /* 兜底自旋 */ }
  }
}

(async () => {
  log('---------- 一键停止开始 ----------');
  let killed = 0;

  // -1) 写停机标记：向导/一键启动的守护进程看到它就不再自动拉起服务。
  //     必须在杀进程之前写好，否则刚杀掉的 AstrBot 30 秒内会被守护复活。
  try { fs.writeFileSync(path.join(WORK_DIR, 'guard.disarm'), String(Date.now())); } catch (_) {}

  // 0) 先停守护进程 —— 顺序很重要：不先杀它，它会在 20 秒内把服务全部拉回来
  try {
    const pid = Number(fs.readFileSync(path.join(WORK_DIR, 'boot.pid'), 'utf8').trim());
    if (pid) {
      const img = pidImageName(pid);
      if (/node(\.exe)?$/i.test(img)) {
        execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 10000 });
        log(`已停止后台守护（PID ${pid}）`);
        killed++;
      } else {
        log(`boot.pid 里的 PID ${pid} 现在是 ${img || '不存在的进程'}（PID 可能已被复用），跳过不强杀`);
      }
    }
  } catch (_) { /* 没有守护或已经退出 */ }
  try { fs.unlinkSync(path.join(WORK_DIR, 'boot.pid')); } catch (_) {}
  try { fs.writeFileSync(path.join(WORK_DIR, 'boot.status'), 'STOPPED\r\n'); } catch (_) {}

  // 1) AstrBot 面板 + 反向 WS
  for (const port of [16885, 16199]) {
    const pids = listeningPids(port);
    for (const pid of pids) {
      if (killPid(pid)) { log(`已停止占用 ${port} 的进程（PID ${pid}）`); killed++; }
    }
  }

  // 2) NapCat：它寄生在 QQ 里，而 QQ 自带守护 —— 杀掉会立刻重启（实测 4 轮都杀不掉，
  //    PID 每次都变）。所以这里只「尽力」两轮，别让用户干等；真正让机器人下线靠停 AstrBot
  //    （AstrBot 不在，NapCat 连不上反向 WS，任何消息都不会有回复）。
  let left = 0;
  for (let i = 1; i <= 2; i++) {
    try { execFileSync('taskkill', ['/IM', 'NapCatWinBootMain.exe', '/F'], { windowsHide: true, timeout: 10000 }); } catch (_) {}
    const pids = listeningPids(6099);
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
        log(`已尝试停止 NapCat 的 QQ 进程（PID ${pid}，第 ${i} 轮）`);
        killed++;
      } catch (_) { /* 已经没了 */ }
    }
    sleep(3000);
    left = listeningPids(6099).size;
    if (!left) break;
  }
  if (left) {
    log('说明：QQ 自带守护，把 NapCat 又拉起来了（属正常现象）。');
    log('      此时 AstrBot 已停 → 机器人不会回任何消息，效果等同于已关闭。');
    log('      如果要彻底退出这个 QQ 号：右键任务栏托盘里的 QQ → 退出。');
  }

  // 4) 收尾：残留的 astrbot 进程（按命令行匹配，不误杀其他 python）。
  //    wmic 在 Win11 24H2 起默认被移除，改用 PowerShell CIM。
  try {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*astrbot*' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    execFileSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000 });
    log('已清理残留的 AstrBot python 进程');
  } catch (_) { /* 没有就算了 */ }

  log(killed ? '---------- 一键停止完成（聊天记录与配置都还在） ----------' : '---------- 没有检测到正在运行的大肥鱼 ----------');
  process.exit(0);
})().catch((e) => {
  log(`停止器异常：${e && e.message ? e.message : e}`);
  process.exit(2);
});
