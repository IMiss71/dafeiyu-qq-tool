/**
 * NapCat 崩溃自动重试（守护）
 *
 * 为什么要这个：
 *   NapCat 4.18.41 注入 QQ 9.9.36 后，QQ 会在登录阶段概率性崩溃
 *   （QQNT.dll 里 int3 断点没人接管 → 0xc06d007f / 0x80000003）。
 *   实测崩溃时机在 30~95 秒之间随机波动：有时撑 30 秒，有时撑 95 秒，
 *   10/24 曾有一次撑了 3.5 小时。说明它不是"必崩"，而是"概率性崩"。
 *   既然是概率问题，重试就是最实际有效的绕法 —— 人肉点按钮太累，交给它。
 *
 * 策略：
 *   1. 启动 NapCat，每 5 秒探一次 6099（WebUI）是否 200
 *   2. 连续探到「存活阈值」秒都正常 → 判定成功，收工
 *   3. 中途挂了 → 清掉残留进程，歇几秒，再试（最多 maxTries 次）
 *   4. 全程写日志，方便事后看每次撑了多久
 *
 * 用法：
 *   node backend/napcat-retry.js              // 默认最多 6 次，撑过 180 秒算成功
 *   node backend/napcat-retry.js 10 300       // 最多 10 次，撑过 300 秒算成功
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const WORK_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DaFeiYuQQ');
const NAPCAT_DIR = path.join(WORK_DIR, 'NapCat');
const LOG = path.join(WORK_DIR, 'napcat-retry.log');

const MAX_TRIES = parseInt(process.argv[2], 10) || 6;
const ALIVE_SECONDS = parseInt(process.argv[3], 10) || 180; // 撑过这么久就算成功

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\r\n'); } catch (_) {}
}

/** TCP 连接探测：连得上才算活着（Node 在 Windows 上带 SO_REUSEADDR，自己 listen 试会误报） */
function portAlive(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const finish = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    setTimeout(() => finish(false), 2000);
  });
}

function killResidual() {
  // 只杀 NapCat 注入器本身；QQ 交给 NapCat 自己管（乱杀会把用户自己登录的 QQ 也干掉）
  try {
    require('child_process').execSync('taskkill /IM NapCatWinBootMain.exe /F', { stdio: 'ignore', windowsHide: true });
  } catch (_) {}
}

function launchNapCat() {
  const bootExe = path.join(NAPCAT_DIR, 'NapCatWinBootMain.exe');
  const hookDll = path.join(NAPCAT_DIR, 'NapCatWinBootHook.dll');
  if (!fs.existsSync(bootExe) || !fs.existsSync(hookDll)) {
    throw new Error(`NapCat 未安装完整：${NAPCAT_DIR}`);
  }
  // QQ 路径：优先注册表解析过的，退化到常见位置
  const qqPath = findQQ();
  if (!qqPath) throw new Error('找不到 QQ.exe');

  const napcatLog = path.join(WORK_DIR, 'napcat.log');
  try { fs.appendFileSync(napcatLog, `\r\n[retry-start ${new Date().toLocaleString()}]\r\n`); } catch (_) {}
  const out = fs.openSync(napcatLog, 'a');

  const env = Object.assign({}, process.env, {
    NAPCAT_PATCH_PACKAGE: path.join(NAPCAT_DIR, 'qqnt.json'),
    NAPCAT_LOAD_PATH: path.join(NAPCAT_DIR, 'loadNapCat.js'),
    NAPCAT_INJECT_PATH: hookDll,
    NAPCAT_LAUNCHER_PATH: bootExe,
    NAPCAT_MAIN_PATH: path.join(NAPCAT_DIR, 'napcat.mjs'),
  });

  const child = spawn(bootExe, [qqPath, hookDll], {
    cwd: NAPCAT_DIR, detached: true, windowsHide: true,
    stdio: ['ignore', out, out], env,
  });
  child.unref();
  return child;
}

function findQQ() {
  const candidates = [
    'D:\\QQ.exe', 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tencent QQNT', 'QQ.exe'),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return '';
}

async function waitAlive(seconds) {
  const deadline = Date.now() + seconds * 1000;
  const start = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const alive = await portAlive(6099);
    const secs = Math.round((Date.now() - start) / 1000);
    if (!alive) return { ok: false, survived: secs };
    process.stdout.write(`\r    存活 ${secs}s / ${seconds}s   `);
  }
  console.log('');
  return { ok: true, survived: Math.round((Date.now() - start) / 1000) };
}

(async () => {
  log(`===== NapCat 重试守护启动（最多 ${MAX_TRIES} 次，撑过 ${ALIVE_SECONDS}s 算成功）=====`);
  for (let i = 1; i <= MAX_TRIES; i++) {
    log(`--- 第 ${i}/${MAX_TRIES} 次尝试 ---`);
    killResidual();
    await new Promise((r) => setTimeout(r, 3000));
    try {
      launchNapCat();
    } catch (e) {
      log(`  启动失败：${e.message}`);
      break;
    }
    // 给它 25 秒把 WebUI 拉起来（太早起不来是正常的，别误判成崩溃）
    let up = false;
    for (let w = 0; w < 5; w++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (await portAlive(6099)) { up = true; break; }
    }
    if (!up) {
      log(`  25 秒内 WebUI 没起来，判定失败`);
      continue;
    }
    log(`  WebUI 已就绪，开始观察 ${ALIVE_SECONDS}s`);
    const r = await waitAlive(ALIVE_SECONDS);
    if (r.ok) {
      log(`✅ 第 ${i} 次成功，已稳定 ${r.survived}s。WebUI: http://127.0.0.1:6099/`);
      process.exit(0);
    }
    log(`  ❌ 撑了 ${r.survived}s 后崩溃`);
  }
  log(`===== ${MAX_TRIES} 次都失败。这是 NapCat 4.18.41 + QQ 9.9.36 的已知兼容 bug，建议等 NapCat 更新 =====`);
  process.exit(1);
})();
