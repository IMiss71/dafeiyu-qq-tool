// boot.js —— 大肥鱼一键启动 + 后台守护
//
// 为什么是「启动 + 守护」两合一：
//   backend/server.js 里那套守卫（NapCat 崩了自动拉起、反向 WS 断了自动重连）只在
//   向导窗口开着的时候有效。客户用一键启动后把向导关掉，机器人就没人管了——
//   NapCat 概率性崩溃（代码里记过）或换号后配置没热加载，都会表现成「不回消息」。
//   所以这里驻留一个极轻量的守护（20 秒一次探测，只有真出问题才动手）。
//
// 启动复用 backend/deploy.js 的 startAstrbot() / startNapCat()：
//   优先直接调 astrbot.exe（uvx 会二次解析环境，客户机上会卡到超时）、
//   NapCat 用注入器无窗口启动、启动前自动补 OneBot 反向 WS 配置。
//
// 用法：
//   node scripts/boot.js          启动 + 常驻守护（一键启动.vbs 用这个）
//   node scripts/boot.js --once   只启动、不守护（看进度.bat 用这个）
//
// 状态文件 %LOCALAPPDATA%\DaFeiYuQQ\boot.status 第一行是 OK / FAIL / BOOTING，
// VBS 靠它判断结果（不用解析 JSON）。
// 日志：同目录 boot.log
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const deploy = require(path.join(__dirname, '..', 'backend', 'deploy.js'));

const WORK_DIR = deploy.WORK_DIR;
const LOG_PATH = path.join(WORK_DIR, 'boot.log');
const STATUS_PATH = path.join(WORK_DIR, 'boot.status');
const PID_PATH = path.join(WORK_DIR, 'boot.pid');
const ONLY_ONCE = process.argv.includes('--once');

let logFd = null;
function log(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\r\n');
  } catch (_) {}
  try { console.log(msg); } catch (_) {}
}

function writeStatus(state, lines) {
  try {
    const body = [state].concat(lines || []).join('\r\n') + '\r\n';
    fs.writeFileSync(STATUS_PATH, body);
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safe(fn, dflt) {
  try { return fn(); } catch (_) { return dflt; }
}

// ---------- 单实例：避免反复双击起多个守护 ----------
// 双重校验：PID 存在 + 进程名是 node（守护一定是 node 跑的）。
// Windows 的 PID 会复用，boot.pid 里存的旧 PID 可能已经属于别的程序。
function pidAlive(pid) {
  if (!pid) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      windowsHide: true, timeout: 10000, encoding: 'utf8',
    });
    if (!new RegExp(`\\b${pid}\\b`).test(out) || /No tasks|没有运行/i.test(out)) return false;
    return /node(\.exe)?/i.test(out);
  } catch (_) { return false; }
}

function alreadyRunning() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    return pidAlive(pid) ? pid : 0;
  } catch (_) { return 0; }
}

// ---------- NapCat 配置里缺「连回 AstrBot」的账号 ----------
// 关键点：NapCat 按 QQ 号分文件存配置（onebot11_<QQ号>.json），换号/新号第一次登录会
// 生成一份里面没有任何 websocketClients 的新文件 —— 这就是「换了小号就不回消息」的根因。
function napCatDir() {
  const launcher = safe(() => deploy.findNapCatLauncher(), null);
  return launcher ? path.dirname(launcher) : '';
}

function wsMissingFiles() {
  const dir = napCatDir();
  if (!dir) return [];
  const cfgDir = path.join(dir, 'config');
  let files = [];
  try { files = fs.readdirSync(cfgDir).filter((f) => /^onebot11_.*\.json$/i.test(f)); } catch (_) { return []; }
  const port = 16199;
  const missing = [];
  for (const f of files) {
    try {
      let raw = fs.readFileSync(path.join(cfgDir, f), 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      raw = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
      const j = JSON.parse(raw || '{}');
      const clients = (j.network && j.network.websocketClients) || [];
      const ok = clients.some((c) => c && c.enable && String(c.url || '').includes(`:${port}`));
      if (!ok) missing.push(f);
    } catch (_) { /* 单个文件坏了不阻塞其他 */ }
  }
  return missing;
}

// ---------- 主流程 ----------
(async () => {
  const running = alreadyRunning();
  if (running) {
    log(`已有一份守护在跑（PID ${running}），本次跳过`);
    // 守护活着就如实写 OK（VBS 只看第一行），note 里说明是复用
    writeStatus('OK', ['note=already-running', `pid=${running}`]);
    process.exit(0);
  }

  try { fs.writeFileSync(PID_PATH, String(process.pid)); } catch (_) {}
  // 用户主动点启动 = 撤销之前的「一键停止」：清掉停机标记，守护才能正常驻留
  try { fs.unlinkSync(path.join(WORK_DIR, 'guard.disarm')); } catch (_) {}
  writeStatus('BOOTING', [`pid=${process.pid}`, `at=${new Date().toLocaleString()}`]);
  log('========== 一键启动开始 ==========');

  // ---- 1) AstrBot ----
  let ast = null;
  let astErr = '';
  try {
    ast = await deploy.startAstrbot();
    if (ast && ast.alreadyRunning) {
      log(ast.booting ? 'AstrBot 正在启动中（刚点过），本次不重复启动' : 'AstrBot 已在运行，跳过');
    } else if (ast && ast.pid) {
      log(`AstrBot 已启动（PID ${ast.pid}，用 ${ast.launcher || 'astrbot.exe'}）`);
    } else {
      log('AstrBot 启动指令已发出');
    }
  } catch (e) {
    astErr = e.message || String(e);
    log(`AstrBot 启动失败：${astErr}`);
  }

  // 冷启动：正常的 4~15 秒，老机器/首次 30~60 秒。正在启动中的就不要重复等了。
  let dashboard = false;
  if (!(ast && ast.booting)) {
    dashboard = await safe(() => deploy.waitForDashboard(30, 2000), false); // 最多 60 秒
  } else {
    dashboard = true; // 交给它自己完成，避免第二次双击也卡一分钟
  }
  log(dashboard ? 'AstrBot 面板已就绪（16885）' : 'AstrBot 面板 60 秒内没响应（可能还在启动，或没装好）');

  // ---- 2) NapCat ----
  let nap = null;
  let napErr = '';
  if (!safe(() => deploy.napCatInstalled(), false)) {
    napErr = '未安装 NapCat';
    log('还没安装 NapCat，跳过（先双击「启动向导.bat」，第②步一键装，包内已带离线包）');
  } else {
    try {
      nap = deploy.startNapCat();
      if (nap && nap.alreadyRunning) log('NapCat 已在运行，跳过');
      else log(`NapCat 已启动（${nap && nap.mode === 'hidden' ? '无窗口' : '带窗口兜底'}）`);
    } catch (e) {
      napErr = e.message || String(e);
      log(`NapCat 启动失败：${napErr}`);
    }
  }

  // ---- 3) 给 NapCat 一点时间注入 + 登录，再判断链路 ----
  let wsUp = false;
  if (!napErr) {
    for (let i = 0; i < 6; i++) {          // 最多再等 12 秒
      await sleep(2000);
      wsUp = safe(() => deploy.napcatWsConnected(), false);
      if (wsUp) break;
    }
  }
  log(wsUp ? 'NapCat 已连上 AstrBot（消息链路正常）'
           : 'NapCat 还没连上 AstrBot —— 如果机器人的 QQ 还没登录，先去面板扫码；登录后会自动连上');

  // ---- 4) 写结果 ----
  const ok = dashboard && !napErr;
  writeStatus(ok ? 'OK' : 'FAIL', [
    `at=${new Date().toLocaleString()}`,
    `dashboard=${dashboard ? 1 : 0}`,
    `napcat=${napErr ? 'error' : (nap && nap.alreadyRunning ? 'already' : 'started')}`,
    `ws=${wsUp ? 1 : 0}`,
    astErr ? `astrbot_error=${astErr}` : '',
    napErr ? `napcat_error=${napErr}` : '',
  ].filter(Boolean));
  log(ok ? '========== 一键启动完成 ==========' : '========== 一键启动结束，但有环节没起来 ==========');

  if (ONLY_ONCE) {
    try { fs.unlinkSync(PID_PATH); } catch (_) {}
    process.exit(ok ? 0 : 2);
  }

  if (!ok) {
    log('守护不启动：服务没起来，守护也没有意义（照着日志修好后再双击一次）');
    try { fs.unlinkSync(PID_PATH); } catch (_) {}
    process.exit(2);
  }

  // ---- 5) 常驻守护 ----
  // 只在「真的该动手」时才重启，避免打扰正在扫码登录的用户：
  //   a) 之前连上过，现在断了            → 重启 NapCat 重读配置（冷却 3 分钟）
  //   b) 刚给新账号补写了 WS 配置，30 秒后还没连上 → 重启一次让它重读（同一个文件只修一次）
  let everConnected = wsUp;
  let lastRestart = 0;
  let restarts = 0;
  let fixedFor = new Set();
  let pendingFixFile = '';
  let pendingFixAt = 0;
  let astRestarts = 0;
  let lastAstFix = 0;

  log('守护已启动（每 20 秒体检一次：AstrBot 掉线自动拉起 / NapCat 崩溃自动重启 / 换号后自动补配置）');

  const tick = async () => {
    // 「一键停止」写了停机标记 → 守护立刻收工，别再跟停止脚本互相拉扯
    try {
      if (fs.existsSync(path.join(WORK_DIR, 'guard.disarm'))) {
        log('检测到停机标记（guard.disarm），守护退出');
        try { fs.unlinkSync(PID_PATH); } catch (_) {}
        process.exit(0);
      }
    } catch (_) {}

    // --- AstrBot ---
    const alive = await safe(() => deploy.waitForDashboard(1, 0), false);
    if (!alive) {
      if (Date.now() - lastAstFix > 60000 && astRestarts < 10) {
        lastAstFix = Date.now();
        astRestarts += 1;
        log(`[守护] AstrBot 面板没响应，第 ${astRestarts} 次自动拉起`);
        try { await deploy.startAstrbot(); } catch (e) { log(`[守护] 拉起失败：${e.message}`); }
      }
    }

    // --- NapCat 进程 ---
    const napcatAlive = safe(() => deploy.isNapCatRunning(), true);
    if (!napcatAlive) {
      if (Date.now() - lastRestart > 30000 && restarts < 30) {
        lastRestart = Date.now();
        restarts += 1;
        log(`[守护] NapCat 已退出，第 ${restarts} 次自动重启`);
        try { deploy.startNapCat(); } catch (e) { log(`[守护] NapCat 重启失败：${e.message}`); }
      }
      return;
    }

    // --- 补配置 / 重连 ---
    const connected = safe(() => deploy.napcatWsConnected(), true);
    if (connected) {
      if (!everConnected) log('[守护] NapCat 已连上 AstrBot');
      everConnected = true;
      pendingFixFile = '';
      return;
    }

    const missing = safe(() => wsMissingFiles(), []);
    if (missing.length) {
      const fresh = missing.filter((f) => !fixedFor.has(f));
      if (fresh.length) {
        log(`[守护] 发现 ${fresh.length} 个账号配置里没有 AstrBot 连接（${fresh.join(', ')}），已自动补写`);
        safe(() => deploy.ensureNapCatOnebotWs(), []);
        fresh.forEach((f) => fixedFor.add(f));
        pendingFixFile = fresh[0];
        pendingFixAt = Date.now();
      }
      return; // 补完先观察，别立刻重启，给 NapCat 读配置的机会
    }

    const byPending = pendingFixFile && Date.now() - pendingFixAt > 30000;
    const byDrop = everConnected;
    if ((byPending || byDrop) && Date.now() - lastRestart > 180000 && restarts < 30) {
      lastRestart = Date.now();
      restarts += 1;
      log(`[守护] 配置正常但反向 WS 连不上（${byPending ? '刚补过配置未生效' : '之前连上过又断了'}），重启 NapCat 重读配置（第 ${restarts} 次）`);
      pendingFixFile = '';
      everConnected = false;
      // 必须用 restartNapCat：NapCat 还活着时 startNapCat 会直接「已在运行，跳过」，
      // 等于什么都没做（这个坑踩过）。restartNapCat 会先杀注入器再重新注入。
      try { deploy.restartNapCat(); } catch (e) { log(`[守护] 重启失败：${e.message}`); }
    }
  };

  setInterval(() => { tick().catch(() => {}); }, 20000);

  const bye = () => {
    log('守护收到停止信号，已退出（服务本身不受影响，如需一起关请用「一键停止大肥鱼.vbs」）');
    try { fs.unlinkSync(PID_PATH); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
})().catch((e) => {
  log(`启动器异常：${e && e.stack ? e.stack : e}`);
  writeStatus('FAIL', [`error=${e && e.message ? e.message : e}`]);
  try { fs.unlinkSync(PID_PATH); } catch (_) {}
  process.exit(2);
});
