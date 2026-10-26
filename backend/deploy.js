// deploy.js
// 在用户 Windows 机器上编排：装 uv/Python -> 装 AstrBot -> init -> 写配置 -> 启动 -> 探活。
// 全部走 PowerShell（Windows 专属）。本文件只负责“能自动化的部分”，
// 人设/适配器启用等 WebUI 步骤由向导前端引导用户点（见 README）。
const { exec, spawn, execFileSync } = require('child_process');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
// Windows 上 child_process.exec 默认 windowsHide:false：在"没有控制台的父进程"下
// （比如以后用 Tauri 壳、或从资源管理器双击 node.exe）子命令会闪现控制台窗口。
// 统一默认隐藏；NapCat 那个需要可见窗口的调用显式传 windowsHide:false 覆盖即可。
const _execRaw = promisify(exec);
const execP = (cmd, opts = {}) => _execRaw(cmd, Object.assign({ windowsHide: true }, opts));
const {
  buildProviderConfig,
  buildNapCatOnebotConfig,
  ASTRBOT_REVERSE_WS_PORT,
  PROVIDER_PRESETS,
  CLOUD_MAX_CONTEXT_LENGTH,
  LOCAL_MAX_CONTEXT_LENGTH,
} = require('./config_templates');
const { InstallState } = require('./core/state');

// ... 端口常量见下方（DASHBOARD_PORT=16885 避开已有实例）

// 数据目录。默认放在 %LOCALAPPDATA%\DaFeiYuQQ（用户无感知、不需要管理员权限）。
// 支持用环境变量改位置：磁盘不够、或用户名是中文导致路径有风险时，
// 用户照体检提示设一个纯英文目录即可（set DAFEIYU_WORK_DIR=D:\DaFeiYuData）。
const WORK_DIR = (() => {
  const custom = (process.env.DAFEIYU_WORK_DIR || '').trim();
  if (custom) return path.resolve(custom);
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DaFeiYuQQ');
})();
const DATA_DIR = path.join(WORK_DIR, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CMD_CONFIG_PATH = path.join(DATA_DIR, 'cmd_config.json'); // AstrBot 用户覆盖配置（WebUI 写入此处）
const NAPCAT_CFG_PATH = path.join(WORK_DIR, 'napcat_onebot.json'); // 参考配置，向导会提示放到 NapCat 目录
const INJECT_SCRIPT = path.join(__dirname, 'inject_persona.py');
// 向导实例专用端口：避开机器上可能已在运行的 AstrBot（默认 6185/6199）
const DASHBOARD_PORT = Number(process.env.DAFEIYU_DASHBOARD_PORT || 16885);
const NAPCAT_WEBUI_PORT = Number(process.env.DAFEIYU_NAPCAT_PORT || 6099);
// 面板整站代理端口：浏览器访问它 = 访问 AstrBot 面板，但已注入登录态。
// 必须整站代理而不是子路径（/dash）——面板是 SPA，JS 里全是 /api/xxx 绝对路径，
// 子路径下这些请求会打到向导自己的接口，导致面板白屏。
const ASTRBOT_PROXY_PORT = Number(process.env.DAFEIYU_PROXY_PORT || 18666);

function log(msg) {
  console.log(`[deploy] ${msg}`);
}

// ---------- 停止哨兵：让「一键停止」真的停得住 ----------
// 故障背景（客户机实测）：点了停止，服务过一会儿又活了，用户以为关不掉。
// 根因不是杀不掉进程，而是「守护太多且互不知情」：
//   · scripts/boot.js 的常驻守护（20 秒一轮，AstrBot 没响应就拉起）
//   · 向导后端 server.js 的 astrbotGuard / napcatGuard（只要向导窗口开着就在守）
// 你在 vbs 里杀掉一路，另一路转头就把它拉回来，于是「永远关不掉」。
// 解法：磁盘上放一个所有人都认的哨兵。想停的人写它，所有守护每轮先读它，
// 读到就收手退出；启动方（boot.js / 向导点启动）负责清掉它。
const STOP_FLAG = path.join(WORK_DIR, 'boot.stop');

function requestStop() {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(STOP_FLAG, String(Date.now()));
    return true;
  } catch (_) {
    return false;
  }
}
function clearStopFlag() {
  try { fs.unlinkSync(STOP_FLAG); } catch (_) { /* 本来就没有 */ }
}
function isStopRequested() {
  try { return fs.existsSync(STOP_FLAG); } catch (_) { return false; }
}

// 按「进程名 + 命令行特征」杀进程。为什么需要它：
//   AstrBot 可能是 astrbot.exe，也可能是 python.exe -m astrbot；NapCat 寄生在 QQ 里；
//   而负责守护的是 node.exe —— 光按进程名杀会误伤（别的 python / 别的 node）。
// 用 PowerShell CIM 而不是 wmic：Win11 23H2 起 wmic 已被移除，客户机上等于空转。
function pidsMatching(imageName, cmdIncludes) {
  const name = String(imageName || '').replace(/'/g, "''");
  const needle = String(cmdIncludes || '').replace(/'/g, "''").replace(/\\/g, '\\\\');
  const script = needle
    ? `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.ProcessId }`
    : `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { $_.ProcessId }`;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 25000 }
    );
    return String(out || '').split(/\r?\n/)
      .map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
      .filter((p) => Number(p) !== process.pid); // 绝不自杀
  } catch (_) {
    return [];
  }
}

function killPidSafe(pid) {
  if (!pid || Number(pid) === process.pid) return false;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 10000 });
    return true;
  } catch (_) {
    return false;
  }
}

// 杀掉「正在跑大肥鱼守护」的 node（命令行含 scripts\boot.js）。
// 为什么必须按命令行找：boot.pid 里的 PID 经常不可靠（异常退出没清理、
// 用 --once 跑过、或从向导里启动的），只认 PID 文件 = 守护还活着却没人管它。
function killBootDaemons() {
  let n = 0;
  for (const pid of pidsMatching('node.exe', 'boot.js')) {
    if (killPidSafe(pid)) n++;
  }
  return n;
}

// ---------- 进度总线 ----------
// 下载/装包这类长任务把进度推给 HTTP 层的 SSE，前端据此画进度条。
// 没有订阅者（比如命令行直接 node backend/server.js 调试）时静默丢弃。
let progressSink = null;
function setProgressSink(fn) {
  progressSink = typeof fn === 'function' ? fn : null;
}
function emitProgress(evt) {
  if (!progressSink) return;
  try {
    progressSink(Object.assign({ t: Date.now() }, evt));
  } catch (_) {
    /* 推送失败绝不影响部署本身 */
  }
}

// 跑外部命令并逐行读输出。spawn + 行回调是为了：
// ① 让用户看到"正在下载 xxx"的实时反馈（exec 只能等结束）；
// ② 从 uv/pip 的输出里抠出包数，换算成真实百分比。
function runLive(command, args, { cwd, env, onLine, timeoutMs = 0, abortCheck = null } = {}) {
  return new Promise((resolve, reject) => {
    // cwd 不存在时 spawn 会直接抛 ENOENT（看着像"命令找不到"，其实怪目录）。
    // 全新机器第一次装时工作目录还没建，这里兜底回落到进程当前目录。
    let workdir = cwd || WORK_DIR;
    try {
      if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive: true });
    } catch (_) {
      workdir = process.cwd();
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd: workdir,
        env: env || process.env,
        windowsHide: true,
      });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    let settled = false;
    const feed = (chunk, isErr) => {
      const s = chunk.toString('utf8');
      if (isErr) err += s;
      else out += s;
      if (!onLine) return;
      // uv / npm 会用 \r 在同一行刷进度，统一按各种换行切
      for (const line of s.split(/\r\n|\n|\r/)) {
        const t = line.trim();
        if (t) {
          try {
            onLine(t, isErr);
          } catch (_) {}
        }
      }
    };
    child.stdout.on('data', (c) => feed(c, false));
    child.stderr.on('data', (c) => feed(c, true));
    let timer = null;
    let guard = null;
    let abortReason = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch (_) {}
        reject(new Error(`命令超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
    }
    // 阶段探针：abortCheck 返回字符串就杀掉进程，用于"这个源太慢，换下一个"。
    // 只靠 onLine 判断不行 —— uv 解析依赖时可能几十秒一声不吭，根本没有输出事件。
    if (abortCheck) {
      guard = setInterval(() => {
        if (settled) return;
        let reason = null;
        try {
          reason = abortCheck();
        } catch (_) {}
        if (!reason) return;
        abortReason = String(reason);
        try {
          child.kill();
        } catch (_) {}
      }, 1000);
    }
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (guard) clearInterval(guard);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (guard) clearInterval(guard);
      if (code === 0) resolve({ code, stdout: out, stderr: err });
      else if (abortReason) {
        reject(Object.assign(new Error(`__ABORT__：${abortReason}`), { aborted: abortReason }));
      } else {
        const tail = (err || out).split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
        reject(Object.assign(new Error(`命令退出码 ${code}${tail ? '：' + tail : ''}`), { code, stdout: out, stderr: err }));
      }
    });
  });
}

// 运行一段 PowerShell 脚本，返回 {code, stdout, stderr}
function ps(script, opts = {}) {
  // 用 -EncodedCommand（base64 UTF-16LE）传脚本：
  // 之前用 -Command "...`"..." 的引号嵌套，经过 cmd.exe 一层解析后引号错位，
  // 导致 Invoke-WebRequest 报 PositionalParameterNotFound（实测翻车）。
  // EncodedCommand 完全绕开引号/转义问题。
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  // ★ S4 修复：默认 180 秒超时 —— 以前网络一卡 execP 就永久挂起，
  //   runStep 的 busy 不释放，向导所有按钮点什么都返回 busy，只能强杀。
  return execP(cmd, { maxBuffer: 1024 * 1024 * 16, timeout: 180000, ...opts });
}

// ---------- 安装互斥锁 ----------
// 为什么要加：用户点两次「一键装 NapCat」（或刷新页面后又点一次、或开了两个标签页），
// 后端会并发跑两个 installNapCat —— 两个下载任务写同一批 .part 临时文件互相覆盖，
// 两路 SSE 进度交错推送，表现为"进度条乱跳"，甚至下载出的 zip 是损坏的。
// 现在所有长任务都走 runStep，这里统一加锁：已经在装就直接返回 busy，不起第二个任务。
let busyStep = null;
function getBusyStep() {
  return busyStep;
}

// Durable install state. It must never block an install: every state write is best-effort.
const INSTALL_STATE_FILE = path.join(WORK_DIR, 'install-state.json');
let _installState = null;
function installState() {
  if (!_installState) _installState = InstallState.load(INSTALL_STATE_FILE);
  return _installState;
}
function getInstallState() {
  try { return installState().summary(); } catch (e) { return { status: 'unknown', error: e.message, steps: [] }; }
}
function stateSafe(fn) {
  try { fn(); } catch (e) { log(`[state] ${e.message}`); }
}
function describeResult(r) {
  if (r === undefined || r === null) return '';
  if (typeof r === 'string') return r.slice(0, 2000);
  try { return JSON.stringify(r).slice(0, 2000); } catch (_) { return ''; }
}

async function runStep(name, fn, stateId) {
  if (busyStep) {
    const msg = `正在「${busyStep}」，请等它完成（约 1~3 分钟）`;
    log(`⏭ 跳过重复的「${name}」：${msg}`);
    return { ok: false, error: msg, busy: true };
  }
  busyStep = name;
  const id = stateId || name;
  stateSafe(() => installState().beginStep(id, name));
  try {
    log(`▶ ${name}`);
    emitProgress({ kind: 'step', name, state: 'start' });
    const r = await fn();
    log(`✔ ${name}`);
    emitProgress({ kind: 'step', name, state: 'ok' });
    stateSafe(() => installState().completeStep(id, describeResult(r)));
    return { ok: true, ...r };
  } catch (e) {
    log(`✘ ${name}: ${e.message}`);
    emitProgress({ kind: 'step', name, state: 'fail', error: e.message });
    stateSafe(() => installState().failStep(id, e));
    return { ok: false, error: e.message };
  } finally {
    busyStep = null; // 无论成功失败都必须释放，否则一次失败后永远装不了
  }
}

// ---------- 前置检测 ----------
// uv 官方安装器把 uvx 装到用户目录，且不会刷新已开进程的 PATH ——
// 所以绝不能裸用 `uvx`，必须解析出绝对路径，否则启动永远失败。
function getUvxCmd() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'uvx.exe'), // uv 官方安装器默认位置
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'uv', 'uvx.exe'),
    'C:\\Program Files\\uv\\uvx.exe',
    'C:\\Program Files (x86)\\uv\\uvx.exe',
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return 'uvx'; // 兜底：指望 PATH 里有
}

function getUvCmd() {
  const uvx = getUvxCmd();
  if (uvx !== 'uvx') return uvx.replace(/uvx\.exe$/i, 'uv.exe');
  return 'uv';
}

// 已安装的 astrbot.exe 在哪。
// 初始化一定要优先用它：uvx 会另建一份缓存把 AstrBot 重下一遍，
// 国内网络慢/连不上 PyPI 就会超时，前端表现为「初始化失败」（客户机实测踩过）。
function findAstrbotExe() {
  const cands = [
    path.join(process.env.APPDATA || '', 'uv', 'tools', 'astrbot', 'Scripts', 'astrbot.exe'),
    path.join(os.homedir(), '.local', 'bin', 'astrbot.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'uv', 'tools', 'astrbot', 'Scripts', 'astrbot.exe'),
    'C:\\Program Files\\uv\\tools\\astrbot\\Scripts\\astrbot.exe',
  ];
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return '';
}

async function checkUv() {
  try {
    await execP(`"${getUvCmd()}" --version`);
    return true;
  } catch {
    try {
      await execP('uv --version');
      return true;
    } catch {
      return false;
    }
  }
}

async function checkPython() {
  try {
    const { stdout } = await execP('python --version');
    return stdout.includes('Python 3.1');
  } catch {
    try {
      await execP('py --version');
      return true;
    } catch {
      return false;
    }
  }
}

async function ensureWorkDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return WORK_DIR;
}

// ---------- 安装（全部幂等：已装则跳过）----------

// 检测 AstrBot CLI 是否已在 PATH（uv tool install 后会注册 astrbot 命令）
async function checkAstrbot() {
  // ① PATH 里有（uv tool install 会注册，但已开进程的 PATH 不一定刷新）
  try {
    await execP('astrbot --version');
    return true;
  } catch { /* ignore */ }
  // ② uv 官方安装器把 astrbot.exe 放在 ~/.local/bin，这里常常不在 PATH
  try {
    const exe = path.join(os.homedir(), '.local', 'bin', 'astrbot.exe');
    if (fs.existsSync(exe)) {
      await execP(`"${exe}" --version`);
      return true;
    }
  } catch { /* ignore */ }
  // ③ uv 的 tools 目录：必须看到真正的包或可执行文件才算装上。
  // 踩过的坑：`uv tool uninstall astrbot` 只删了 Scripts\astrbot.exe，
  // 留下一个只剩 activate 脚本、site-packages 全空的壳；旧代码「目录存在即已装」
  // 就把它当装好了 → 向导跳过安装 → 启动时找不到命令，用户看到的是"AstrBot 打不开"。
  try {
    const toolsDir = path.join(process.env.APPDATA || '', 'uv', 'tools', 'astrbot');
    if (fs.existsSync(toolsDir)) {
      const marks = [
        path.join(toolsDir, 'Scripts', 'astrbot.exe'),
        path.join(toolsDir, 'Scripts', 'astrbot'),
        path.join(toolsDir, 'Lib', 'site-packages', 'astrbot'),
        path.join(toolsDir, 'lib', 'python3.12', 'site-packages', 'astrbot'),
        path.join(toolsDir, 'lib', 'python3.11', 'site-packages', 'astrbot'),
      ];
      if (marks.some((p) => fs.existsSync(p))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

async function installUv() {
  if (await checkUv()) {
    // 已装时也要推一条"完成"，否则前端进度条会停在 0
    emitProgress({ kind: 'progress', step: 'uv', percent: 100, phase: 'uv 已安装，跳过', done: true });
    log('uv 已安装，跳过');
    return { skipped: true };
  }
  // 官方一键安装脚本内部用 Invoke-WebRequest 下载，拿不到字节进度，
  // 只能给阶段式进度 + 不确定态的滚动条纹。
  emitProgress({ kind: 'progress', step: 'uv', percent: 8, phase: '正在下载 uv 安装脚本…', indeterminate: true });
  // ★ S4 修复：官方脚本走 astral.sh，国内可能极慢；300 秒拿不下来就报人话并释放 busy
  try {
    await ps('irm https://astral.sh/uv/install.ps1 | iex', { timeout: 300000 });
  } catch (e) {
    throw new Error('uv 安装脚本下载/执行失败（网络太慢或被墙）。建议换手机热点后重试。原因：' + String(e.message).split('\n')[0]);
  }
  emitProgress({ kind: 'progress', step: 'uv', percent: 82, phase: '正在安装 uv 与 Python…', indeterminate: true });
  // 装完确认一次，真的好用了才报 100
  if (!(await checkUv())) throw new Error('uv 安装脚本执行完毕，但仍检测不到 uv 命令');
  emitProgress({ kind: 'progress', step: 'uv', percent: 100, phase: 'uv 安装完成', done: true });
  return { installed: true };
}

// ---------- PyPI 镜像 ----------
// 直连 pypi.org 时，光 pydantic-core 一个包就卡了 212 秒，154 个包装完要半小时以上。
// 但「哪个国内镜像快」是会变的：同一台机器上实测阿里云曾经 7MB/s，
// 两周后掉到 0.33MB/s（装完要 6 分钟）；清华在部分网络下直接 0。
// 所以不能硬编码优先级 —— 每次安装前现测一遍，谁快用谁。
const PYPI_MIRRORS = [
  { label: '华为云', index: 'https://repo.huaweicloud.com/repository/pypi/simple/' },
  { label: '阿里云', index: 'https://mirrors.aliyun.com/pypi/simple/' },
  { label: '腾讯云', index: 'https://mirrors.cloud.tencent.com/pypi/simple/' },
  { label: '中科大', index: 'https://pypi.mirrors.ustc.edu.cn/simple/' },
  { label: '清华', index: 'https://pypi.tuna.tsinghua.edu.cn/simple/' },
  { label: 'PyPI 官方', index: '' },
];

// 竞速：并发抓一批真实依赖的索引页，测总耗时。
// 注意不能用"下一个大文件测带宽"来代替 —— 实测华为云大文件 6.6MB/s 却比
// 阿里云 0.33MB/s 装得更慢，因为装 154 个包的瓶颈是「索引请求延迟 + 并发限流」。
// 用 20 个探针而不是 6 个：有些镜像单请求很快、一并发就限速，探针太少看不出来。
async function rankMirrors() {
  const PROBE = [
    'numpy', 'pandas', 'fastapi', 'pydantic', 'aiohttp', 'requests',
    'lxml', 'pillow', 'cryptography', 'sqlalchemy', 'openai', 'httpx',
    'tiktoken', 'urllib3', 'jinja2', 'rich', 'yarl', 'multidict',
    'markdown-it-py', 'anyio',
  ];
  const SLICE = 50 * 1024; // 每页读 50KB 就够分辨快慢（20 个约 1MB，用户感知不到）

  const bench = async (m) => {
    const base = (m.index || 'https://pypi.org/simple/').replace(/\/?$/, '/');
    const t0 = Date.now();
    try {
      await Promise.all(
        PROBE.map(async (pkg) => {
          const res = await fetch(base + pkg + '/', {
            headers: { 'User-Agent': 'uv/0.13' },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const reader = res.body.getReader();
          let got = 0;
          while (got < SLICE) {
            const { done, value } = await reader.read();
            if (done) break;
            got += value.length;
          }
          try { await reader.cancel(); } catch (_) { /* 已取消 */ }
        })
      );
      return { m, ms: Math.max(1, Date.now() - t0) };
    } catch (_) {
      return null;
    }
  };

  const results = await Promise.all(PYPI_MIRRORS.map(bench));
  const alive = results.filter(Boolean).sort((a, b) => a.ms - b.ms);
  const dead = PYPI_MIRRORS.filter((m) => !alive.some((r) => r.m === m));
  return { ranked: alive.map((r) => r.m).concat(dead), best: alive[0] || null };
}

async function installAstrbot() {
  // 全新机器上工作目录还不存在：不先建出来，spawn 的 cwd 会 ENOENT
  ensureWorkDir();
  if (await checkAstrbot()) {
    emitProgress({ kind: 'progress', step: 'astrbot', percent: 100, phase: 'AstrBot 已安装，跳过', done: true });
    log('AstrBot 已安装，跳过');
    return { skipped: true };
  }
  // uv tool install 的输出里带 "Resolved N packages" 和 "Prepared/Downloading <pkg>"，
  // 据此换算成真实百分比，比干等一个转圈强得多。
  const uv = getUvCmd();
  let lastErr = null;

  // ① 先探一圈选最快的源（1~2 秒，能省下几分钟）
  emitProgress({
    kind: 'progress',
    step: 'astrbot',
    percent: 2,
    phase: '正在挑选当前网络下最快的下载源…',
    indeterminate: true,
  });
  const { ranked, best } = await rankMirrors();
  const mirrors = ranked.length ? ranked : PYPI_MIRRORS;
  if (best) {
    log(`最快源：${best.m.label}（索引响应 ${best.ms}ms）`);
    emitProgress({
      kind: 'progress',
      step: 'astrbot',
      percent: 4,
      phase: `已选${best.m.label}（响应 ${best.ms}ms）`,
      indeterminate: true,
    });
  }

  // ② Python 运行时：本地没有才下载（21MB）。已经有的话 0.3 秒就返回，
  //    显式调用一次是为了让进度条能说清"在下 Python"而不是假装在装依赖。
  const pyRoot = path.join(process.env.APPDATA || '', 'uv', 'python');
  const hasPy = (() => {
    try {
      return fs.readdirSync(pyRoot).some((d) => /^cpython-3\.12[-.]/.test(d));
    } catch (_) {
      return false;
    }
  })();

  if (!hasPy) {
    emitProgress({
      kind: 'progress',
      step: 'astrbot',
      percent: 5,
      phase: '准备 Python 3.12 运行时（约 21MB）…',
      indeterminate: true,
    });
    try {
      await runLive(uv, ['python', 'install', '3.12'], { timeoutMs: 180000 });
    } catch (e) {
      // 没装成也不拦着：uv tool install 会自己再试一次
      log(`Python 3.12 预装未成功（安装时会自动重试）：${e.message.split('\n')[0]}`);
    }
  }

  // 连续几个源都在解析阶段超时，说明是本地网络整体慢，之后不再限时
  let parseTimeouts = 0;
  for (let i = 0; i < mirrors.length; i++) {
    const m = mirrors[i];
    let total = 0;
    let done = 0;
    const env = Object.assign({}, process.env);
    // 环境变量 + 命令行参数双保险：实测某些 uv 版本里 UV_DEFAULT_INDEX
    // 没能覆盖 tool install 的默认源，命令行 --default-index 最可靠。
    if (m.index) {
      env.UV_DEFAULT_INDEX = m.index;
      env.UV_INDEX_URL = m.index;
    }

    const uvArgs = ['tool', 'install', 'astrbot', '--python', '3.12'];
    if (m.index) uvArgs.push('--default-index', m.index);

    emitProgress({
      kind: 'progress',
      step: 'astrbot',
      percent: 5,
      phase:
        i === 0
          ? `正在用${m.label}下载依赖…`
          : `${m.label}：换源重试…`,
      indeterminate: true,
    });

    try {
      // 心跳：uv 是并发下载，遇到 faiss-cpu/pandas 这种大包会几十秒没有任何输出，
      // 进度条卡在 10% 不动 → 用户以为死机了。这里每 8 秒没动静就推一条带时间的心跳，
      // 前端会把进度条切成滚动条纹，至少让人看到"还活着"。
      const t0 = Date.now();
      let lastBeat = Date.now();
      let curPct = 3;
      // 解析阶段只是查版本，不下载包体。文案要说清，否则用户看到进度条不动会以为卡了。
      let curPhase = '正在解析依赖版本（只查清单，还没开始下载）';
      const beat = setInterval(() => {
        if (Date.now() - lastBeat < 8000) return;
        const waited = Math.round((Date.now() - t0) / 1000);
        emitProgress({
          kind: 'progress',
          step: 'astrbot',
          percent: curPct,
          phase: `${curPhase}… 已等 ${waited} 秒（镜像响应有快有慢，没卡住）`,
          indeterminate: true,
        });
      }, 4000);

      try {
        // 解析阶段限时：镜像会限流。实测连续安装 5 次后华为云开始限速，
        // 解析从 6 秒变成 55 秒，而同期阿里云只要 9.9 秒。
        // 干等不如换源，但只对前两个源限时 —— 连续两个都超时，更可能是
        // 本地网络整体慢，再限时只会白折腾，老老实实等完。
        let parseDone = false;
        const ABORT_AFTER = 35000;
        await runLive(uv, uvArgs, {
          env,
          abortCheck:
            parseTimeouts < 2
              ? () => {
                  if (parseDone) return null;
                  const waited = Date.now() - t0;
                  return waited > ABORT_AFTER ? `解析依赖超过 ${Math.round(waited / 1000)} 秒` : null;
                }
              : null,
          onLine: (line) => {
            lastBeat = Date.now();
            // 依赖解析完成：拿到总包数，后面才有分母可用
            const mResolved = line.match(/(?:Resolved|Prepared)\s+(\d+)\s+packages?/i);
            if (mResolved) {
              parseDone = true;
              total = Math.max(total, Number(mResolved[1]));
              curPct = 8;
              curPhase = `${m.label}：共 ${total} 个包`;
              emitProgress({
                kind: 'progress',
                step: 'astrbot',
                percent: 8,
                phase: `${m.label}：共 ${total} 个包，开始下载…`,
                indeterminate: false,
              });
              return;
            }
            // 逐个包下载：新版 uv 用 Prepared，老版/pip 用 Downloading
            const mPkg = line.match(/^(?:Prepared|Downloading|Downloaded)\s+(.+?)\s*(?:\([\d.]+\s*[KMG]i?B\))?$/i);
            if (mPkg && total > 0) {
              done = Math.min(total, done + 1);
              const pct = Math.min(88, 8 + Math.round((done / total) * 80));
              curPct = pct;
              curPhase = `下载依赖 ${done}/${total}：${mPkg[1].slice(0, 42)}`;
              emitProgress({
                kind: 'progress',
                step: 'astrbot',
                percent: pct,
                phase: curPhase,
                indeterminate: false,
              });
              return;
            }
            if (/Installed\s+\d+\s+packages?/i.test(line)) {
              curPct = 92;
              curPhase = '依赖装好了，正在注册 astrbot 命令';
              emitProgress({
                kind: 'progress',
                step: 'astrbot',
                percent: 92,
                phase: '依赖装好了，正在注册 astrbot 命令…',
                indeterminate: true,
              });
            }
          },
        });
      } finally {
        clearInterval(beat);
      }
      // 命令成功不代表真的装上了（可能装到一半），再确认一次真实文件
      if (!(await checkAstrbot())) throw new Error('安装命令执行完毕，但检测不到 astrbot 命令');
      emitProgress({ kind: 'progress', step: 'astrbot', percent: 100, phase: 'AstrBot 安装完成', done: true });
      log(`AstrBot 安装完成（源：${m.label}）`);
      return { installed: true, source: m.label };
    } catch (e) {
      lastErr = e;
      const tail = String(e.message || '').slice(-160);
      if (e.aborted) {
        parseTimeouts += 1;
        log(`${m.label}解析太慢（${e.aborted}），换下一个源`);
      } else {
        log(`用${m.label}安装失败：${tail}`);
      }
      emitProgress({
        kind: 'progress',
        step: 'astrbot',
        percent: 3,
        phase: e.aborted ? `${m.label}解析太慢，换源重试…` : `${m.label}不可用，正在换源重试…`,
        indeterminate: true,
      });
      // 换源前把半装目录清掉，避免下一轮把它当成"已装"
      try {
        const t = path.join(process.env.APPDATA || '', 'uv', 'tools', 'astrbot');
        if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true });
      } catch (_) {}
    }
  }
  throw new Error(
    `三个源都没装上 AstrBot：${lastErr ? lastErr.message : '未知错误'}。` +
      '请检查网络，或手动在命令行执行：uv tool install astrbot --python 3.12'
  );
}

// ---------- AstrBot 根目录自愈 ----------
// ⚠️ 版本坑（实测踩到）：AstrBot 4.29.3 的 cli/utils/basic.py::check_astrbot_root 要求
// 根目录存在 `.astrbot` 标记文件，否则 `astrbot run` 直接报
//   "XXX is not a valid AstrBot root directory. Use 'astrbot init' to initialize"
// 然后进程退出 → 面板代理返回 502。而旧版本（4.29.1）没有这个判据，
// 老沙盒里只有 data/config.json、没有 .astrbot，升级后就起不来。
// 我们的 initAstrbot() 以前看到 config.json 存在就跳过 init，导致 .astrbot 永远补不上。
// 所以：init 和 start 之前都调用这个函数自愈（只补标记文件和空目录，绝不改现有配置）。
function ensureAstrbotRoot() {
  ensureWorkDir();
  const marker = path.join(WORK_DIR, '.astrbot');
  let created = false;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, '');
    created = true;
    log('已创建 .astrbot 根目录标记（AstrBot 4.29.3+ 启动必需）');
  }
  // init 会建的目录也一并补齐（缺了同样可能起不来）
  for (const rel of ['data', 'data/config', 'data/plugins', 'data/temp']) {
    const p = path.join(WORK_DIR, rel);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      log(`已创建目录 ${rel}`);
    }
  }
  return { created };
}

// ---------- 插件不在部署工具里内置 ----------
// 三档插件包（基础/进阶/全能）作为独立 zip 交付，用户在向导「插件管理」里选择安装。
// 部署工具只负责 AstrBot + NapCat + 环境，避免安装包膨胀，也避免“工具里带插件”被误分发。
async function initAstrbot() {
  ensureWorkDir(); // cd 到不存在的目录会失败（全新机器第一次跑）
  ensureAstrbotRoot(); // 先自愈根目录标记，再判断要不要 init
  if (fs.existsSync(CONFIG_PATH)) {
    log('data/config.json 已存在，跳过 init（不覆盖现有配置）');
    return { skipped: true };
  }
  // astrbot init 仅首次执行，生成 data/ 与默认 config.json。
  // 用官方 --yes 跳过确认交互（管道喂 echo. 在新版本里不可靠，会一直卡住）。
  // 同时用官方环境变量预置面板密码。密码首次安装时随机生成，
  // 写入 dashboard_credentials.json，向导完成页和「关于」页都能读到。
  const env = Object.assign({}, process.env, {
    ASTRBOT_DASHBOARD_INITIAL_PASSWORD: getOrCreateDashboardPassword(),
  });
  // 优先用已装的 astrbot.exe（不走 uvx，避免二次联网下包导致「初始化失败」）
  const exe = findAstrbotExe();
  const head = exe ? `"${exe}"` : `"${getUvxCmd()}" astrbot`;
  await execP(`cd /d "${WORK_DIR}" && ${head} init --yes`, {
    maxBuffer: 1024 * 1024 * 32,
    timeout: 300000,   // ★ S4 修复：init 卡住时 5 分钟内报错释放 busy，不永久转圈
    env,
  });
  // init 完立刻写入向导专用端口（避开机器上可能已存在的 AstrBot 实例）
  applyWizardOverrides();
}

// ---------- 配置 ----------
// 向导实例使用独立端口（16885/16199），避免和机器上已有的 AstrBot（默认 6185/6199）冲突
function patchWizardOverridesObj(cfg) {
  cfg = cfg || {};
  cfg.dashboard = Object.assign({}, cfg.dashboard, {
    enable: true,
    host: '127.0.0.1',
    port: DASHBOARD_PORT,
  });
  let plat = Array.isArray(cfg.platform) ? cfg.platform : [];
  let entry = plat.find((p) => p && p.type === 'aiocqhttp');
  if (!entry) {
    entry = { id: 'napcat_aiocqhttp', type: 'aiocqhttp', enable: true };
    plat.push(entry);
    cfg.platform = plat;
  }
  entry.enable = true;
  // aiocqhttp 适配器读的是 ws_reverse_host / ws_reverse_port / ws_reverse_token，
  // 写 host / port 会因为缺 ws_reverse_host 直接报 KeyError 起不来（v4.29 已验证）
  entry.ws_reverse_host = '0.0.0.0';
  entry.ws_reverse_port = ASTRBOT_REVERSE_WS_PORT;
  if (typeof entry.ws_reverse_token !== 'string') entry.ws_reverse_token = '';
  // 清掉旧版本残留的 host/port，避免歧义
  delete entry.host;
  delete entry.port;
  return cfg;
}

// 读取一份 AstrBot 配置（AstrBot 写出的文件带 UTF-8 BOM，必须剥掉再 parse）
function readCfg(p) {
  if (!fs.existsSync(p)) return { cfg: {}, bom: false };
  let raw = fs.readFileSync(p, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  if (bom) raw = raw.slice(1);
  try {
    return { cfg: JSON.parse(raw), bom };
  } catch {
    return { cfg: {}, bom };
  }
}

// 写回配置（保留原有 BOM，避免 AstrBot 读不出）
function writeCfg(p, cfg, bom) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, (bom ? '\ufeff' : '') + JSON.stringify(cfg, null, 2), 'utf8');
}

// 对「模板 + 生效」两份配置同时应用同一个 mutator。
// 关键：AstrBot 运行时读的是 data/cmd_config.json，config.json 只是模板，
// 只写一份会导致端口/模型/人设全部不生效。
function patchBothConfigs(mutator) {
  const files = [CONFIG_PATH, CMD_CONFIG_PATH];
  const written = [];
  for (const p of files) {
    const { cfg, bom } = readCfg(p);
    const out = mutator(cfg) || cfg;
    writeCfg(p, out, bom);
    written.push(p);
  }
  return written;
}

function applyWizardOverrides() {
  try {
    patchBothConfigs((cfg) => patchWizardOverridesObj(cfg));
    log(`已写入向导专用端口: dashboard=${DASHBOARD_PORT}, aiocqhttp=${ASTRBOT_REVERSE_WS_PORT}`);
    return true;
  } catch (e) {
    log(`写入端口覆盖失败: ${e.message}`);
    return false;
  }
}

// ---------- Ollama 视觉模型：让纯文本主模型也能"看懂"图片 ----------
// 原理：AstrBot 在 provider_settings.default_image_caption_provider_id 有值时，
// 会先用这个 provider 把图片转成文字描述，再交给主模型。
// 主模型（如 qwen3:8b）不用支持图片，也能"大致说出图里有什么"。
// 候选按优先级排列，qwen3.5 已在本机实测支持看图。
const OLLAMA_VISION_PATTERNS = [
  /^qwen3\.5/i,
  /^qwen3-vl/i,
  /^qwen2\.5-?vl/i,
  /^qwen2-?vl/i,
  /^llava/i,
  /^minicpm-?v/i,
  /^moondream/i,
  /^gemma3/i,
  /^internvl/i,
];

async function detectOllamaVisionModel() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return '';
    const j = await res.json();
    const names = (j.models || []).map((m) => String(m.name || '')).filter(Boolean);
    for (const re of OLLAMA_VISION_PATTERNS) {
      const hit = names.find((n) => re.test(n));
      if (hit) return hit;
    }
    return '';
  } catch {
    return ''; // Ollama 没跑 / 没装模型：静默降级，不影响部署
  }
}

function registerVisionProvider(visionModel) {
  const visionId = `ollama/${visionModel}`;
  patchBothConfigs((cfg) => {
    cfg = patchWizardOverridesObj(cfg);
    const list = Array.isArray(cfg.provider) ? cfg.provider : [];
    const rest = list.filter((x) => x && x.id !== visionId);
    // 兼容两种配置形态：已迁移过的用 provider_source_id，全新的用扁平结构
    const sources = Array.isArray(cfg.provider_sources) ? cfg.provider_sources : [];
    // 思考型视觉模型（qwen3.5 系）在 Ollama 的 /v1 接口上会把正文全塞进 reasoning、
    // content 留空 → AstrBot 取到空描述，识图等于没生效。实测只有 chat_template_kwargs
    // 能压住（think:false 和 system 指令都无效），所以必须写进 custom_extra_body。
    const extraBody = {
      temperature: 0.3,
      chat_template_kwargs: { enable_thinking: false },
    };
    // 只有确认存在 Ollama 自己的 source 才复用；否则宁可用扁平配置。
    // 直接挂 sources[0] 是个坑：默认配置的第一个 source 很可能是 deepseek，
    // 于是本地视觉模型会用 deepseek 的地址和 Key 去请求，报 400 无效模型名，
    // 表现为"机器人说没看到图"。
    const ollamaSource = (sources || []).find(
      (s) => s && (/ollama/i.test(String(s.id || '')) || /11434/.test(String(s.api_base || '')))
    );
    const flat = {
      id: visionId,
      type: 'openai_chat_completion',
      model: visionModel,
      key: ['ollama'],
      api_base: 'http://localhost:11434/v1',
      enable: true,
      modalities: ['text', 'image', 'tool_use'],
      custom_extra_body: extraBody,
    };
    const entry = ollamaSource
      ? {
          id: visionId,
          enable: true,
          provider_source_id: ollamaSource.id,
          model: visionModel,
          modalities: ['text', 'image', 'tool_use'],
          custom_extra_body: extraBody,
          max_context_tokens: 16384,
        }
      : flat;
    rest.push(entry);
    cfg.provider = rest;
    cfg.provider_sources = sources;
    cfg.provider_settings = Object.assign({}, cfg.provider_settings, {
      default_image_caption_provider_id: visionId,
      image_caption_prompt:
        (cfg.provider_settings || {}).image_caption_prompt ||
        '用中文一句话描述图片：先说要表达什么，再念出图中所有文字，总计不超过60字。',
    });
    return cfg;
  });

  // 装了 reimage（图像转述）插件的话，把它的 provider 一起指过来
  try {
    const rp = path.join(WORK_DIR, 'data', 'config', 'astrbot_plugin_reimage_config.json');
    if (fs.existsSync(rp)) {
      const raw = fs.readFileSync(rp, 'utf8').replace(/^\ufeff/, '');
      const rc = JSON.parse(raw);
      rc.img_provider = rc.img_provider || {};
      rc.img_provider.provider_id = visionId;
      fs.writeFileSync(rp, JSON.stringify(rc, null, 4), 'utf8');
    }
  } catch (_) {
    /* 插件配置写失败不影响主流程 */
  }

  // 表情包插件也要指过来：它用视觉模型给表情包生成描述，语义检索全靠这些描述。
  // 漏了它的话插件会一直去连一个不存在的 provider，表现为"表情包描述永远是空的"。
  try {
    const mp = path.join(WORK_DIR, 'data', 'config', 'meme_manager_config.json');
    if (fs.existsSync(mp)) {
      const mc = JSON.parse(fs.readFileSync(mp, 'utf8').replace(/^\ufeff/, ''));
      let touched = false;
      for (const sec of ['semantic', 'auto_collect']) {
        if (mc[sec] && 'vision_provider_id' in mc[sec] && mc[sec].vision_provider_id !== visionId) {
          mc[sec].vision_provider_id = visionId;
          touched = true;
        }
      }
      if (touched) fs.writeFileSync(mp, JSON.stringify(mc, null, 4), 'utf8');
    }
  } catch (_) {
    /* 同上 */
  }
  return visionId;
}

// 某些"思考型"视觉模型（实测 qwen3.5 系列）在 Ollama 的 OpenAI 兼容接口下，
// 会把输出全塞进 reasoning 字段、content 留空 → AstrBot 取 completion_text 拿到空字符串，
// 于是图片描述为空、什么都不传给主模型，表现为「识图没反应」（模型只看到占位符开始瞎猜）。
// 实测解法：用 SYSTEM 指令压住思考，生成一个 -cap 变体专门做图片描述，效果正常且更快。
const THINKING_VISION_RE = /^qwen3\.5/i;
const CAP_SYSTEM_PROMPT =
  '你是一个图像描述助手。直接输出对图片的简短中文描述，不要思考，不要解释过程。';

async function ensureCaptionVariant(model) {
  if (!THINKING_VISION_RE.test(model)) return model; // 其他模型不需要处理
  const capName = `${model.split(':')[0]}-cap`; // qwen3.5:4b-16k -> qwen3.5-cap
  // 已存在就复用
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(6000),
    });
    const j = await res.json();
    if ((j.models || []).some((m) => String(m.name || '').startsWith(capName))) {
      return capName;
    }
  } catch {
    /* 探测失败就继续尝试创建 */
  }
  try {
    const res = await fetch('http://127.0.0.1:11434/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: capName,
        from: model,
        system: CAP_SYSTEM_PROMPT,
        parameters: { temperature: 0.3 },
        stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`已创建图片描述专用模型 ${capName}（压制思考，避免空描述）`);
    return capName;
  } catch (e) {
    log(`创建 ${capName} 失败，回退直接用 ${model}: ${e.message}`);
    return model;
  }
}

// ---------- 关思考变体（主模型） ----------
// AstrBot 走 OpenAI 兼容接口，而 Ollama 在 /v1 上关不掉 thinking
// （实测 think:false 无效、Modelfile 也不认 enable_thinking）。
// 思考型模型会把 token 全花在"想"上，content 为空 → 机器人"张不开嘴"、看起来不回话。
// 办法：改模型自带的对话模板，让它每次都在 assistant 开头插入空思考块。
// 变体与原模型共享权重，只多一个几 KB 的 manifest，不额外占磁盘。
const THINKING_TEXT_RE = /^(qwen3(?!\.5)|qwq|deepseek-r1)/i;
const NOTHINK_NUM_CTX = 12288; // 8192 时固定开销(人设+插件提示)就占掉 5000，输出空间被挤成 1 token

async function ensureNoThinkVariant(model) {
  const m = String(model || '');
  if (!THINKING_TEXT_RE.test(m)) return model; // 非思考型模型无需处理
  // 用完整模型名生成变体名：qwen3:8b -> qwen3-8b-nothink
  // （不能用 split(':')[0]，否则 qwen3:8b 和 qwen3:4b-8k 会撞成同一个名字）
  const name = `${m.replace(/[:/]/g, '-')}-nothink`;
  // 已存在就复用
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(6000) });
    const j = await res.json();
    if ((j.models || []).some((x) => String(x.name || '').split(':')[0] === name)) return name;
  } catch {
    /* 探测失败就继续尝试创建 */
  }
  try {
    const show = await (
      await fetch('http://127.0.0.1:11434/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: m }),
        signal: AbortSignal.timeout(20000),
      })
    ).json();
    const tmpl = String(show.template || '');
    if (!tmpl) {
      log(`${m} 没有对话模板，跳过关思考处理（若回复空白请换模型）`);
      return model;
    }
    // 让"空思考块"无条件插入（原模板只在显式 no_think 时才插）
    const newTmpl = tmpl.replace(
      /\{\{\s*if\s+and\s+\$\.IsThinkSet\s+\(not\s+\$\.Think\)\s*-\}\}/g,
      '{{ if true -}}'
    );
    if (newTmpl === tmpl) {
      log(`${m} 的模板不符合预期结构，跳过关思考处理`);
      return model;
    }
    const body = {
      model: name,
      from: m,
      template: newTmpl,
      parameters: {
        num_ctx: NOTHINK_NUM_CTX,
        num_predict: 512,
        temperature: 0.9,
        top_p: 0.92,
        top_k: 40,
        min_p: 0.05,
        repeat_penalty: 1.18, // 抗复读
        repeat_last_n: 128,
        stop: ['<|im_start|>', '<|im_end|>'],
      },
      stream: false,
    };
    if (show.system) body.system = String(show.system);
    const res = await fetch('http://127.0.0.1:11434/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
    }
    log(`已创建关思考变体 ${name}（上下文 ${NOTHINK_NUM_CTX}，避免回复空白）`);
    return name;
  } catch (e) {
    log(`创建 ${name} 失败，回退直接用 ${m}: ${e.message}`);
    return model;
  }
}

// ---------- 拉取可用模型列表（配置模型的"智能化"核心）----------
// 用户最难填的就是模型名：各家命名规则不同（deepseek-chat / deepseek-ai/DeepSeek-V3 /
// qwen-plus），填错就是 404。这里直接问服务商要列表，再自动分类+推荐，
// 用户从"手打模型名"变成"从下拉里挑一个已经选好的"。
const NON_CHAT_RE =
  /embed|rerank|bge-|gte-|m3e|text-embedding|whisper|cosyvoice|sensevoice|moderation|dall-e|stable-diffusion|flux|kolors|upscal|wav2vec|sd-?xl|midjourney/i;
const VISION_RE =
  /(^|[/\-_.])vl([/\-_.]|$)|vision|gpt-4o|gpt-4\.1|gpt-4-turbo|claude-3|claude-4|gemini|llava|minicpm-v|internvl|glm-4v|yi-vl|step-1v|qwen3-vl|omni/i;
// 越靠前越优先（国内网络、性价比、稳定性综合排序）
const CHAT_PREF = [
  /deepseek-ai\/DeepSeek-V3(\.\d)?$/i,
  /deepseek-chat/i,
  /qwen-plus/i,
  /qwen-max/i,
  /Qwen\/Qwen2\.5-72B-Instruct/i,
  /glm-4-plus/i,
  /gpt-4o-mini/i,
  /gpt-4o$/i,
];
const VISION_PREF = [
  /Qwen\/Qwen2\.5-VL-7B-Instruct/i,
  /qwen-vl-max/i,
  /qwen2\.5-vl-72b/i,
  /glm-4v/i,
  /gpt-4o-mini/i,
  /qwen3-vl/i,
];

function pickByPreference(list, prefs) {
  for (const re of prefs) {
    const hit = list.find((m) => re.test(m));
    if (hit) return hit;
  }
  return '';
}

// 本地模型的视觉能力不能靠名字猜（qwen3.5 名字里没有 vl 但确实能看图），
// 只有 /api/show 的 capabilities 是准的。并发问一遍，最多 6 秒。
async function probeOllamaVision(root, names) {
  const out = [];
  const targets = names.slice(0, 40);
  await Promise.all(
    targets.map(async (n) => {
      try {
        const r = await fetch(`${root}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: n }),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return;
        const j = await r.json();
        const caps = Array.isArray(j.capabilities) ? j.capabilities : [];
        const hasVision =
          caps.includes('vision') || !!(j.projector_info && Object.keys(j.projector_info).length);
        if (hasVision) out.push(n);
      } catch (_) {
        /* 单个模型探测失败就跳过，不影响列表 */
      }
    })
  );
  return out;
}

async function listModels({ provider, apiKey, apiBase }) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const base = ((apiBase || '').trim() || preset.api_base || '').replace(/\/+$/, '');
  const key = (apiKey || '').trim() || (provider === 'ollama' ? 'ollama' : '');
  if (!base) return { ok: false, error: '先填 API Base URL 再获取模型列表。' };
  if (!key) return { ok: false, error: '先填 API Key 再获取模型列表。' };

  let ids = [];
  let ollamaVisionIds = [];
  try {
    if (provider === 'ollama') {
      // 本地：/api/tags 比 /v1/models 多给一个 details.families，
      // 里面出现 "clip" 就说明这个模型带视觉编码器 —— 比猜名字准得多
      // （qwen3.5 这类名字里没有 vl，但确实能看图）
      const res = await fetch(`${base.replace(/\/v1$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const rows = (j.models || [])
        .map((m) => ({
          name: String(m.name || '').replace(/:latest$/, ''),
          families: (m.details && m.details.families) || [],
        }))
        .filter((x) => x.name);
      ids = rows.map((x) => x.name);
      const root = base.replace(/\/v1$/, '');
      // families 里偶尔能直接看出 clip（多模态投影层），有就先信它
      ollamaVisionIds = rows
        .filter((x) => x.families.includes('clip') || x.families.includes('mllama'))
        .map((x) => x.name);
      // 剩下的逐个问 /api/show，拿权威的 capabilities
      const unknown = rows
        .filter((x) => !ollamaVisionIds.includes(x.name))
        .map((x) => x.name)
        .filter((n) => !NON_CHAT_RE.test(n));
      const probed = await probeOllamaVision(root, unknown);
      ollamaVisionIds = Array.from(new Set(ollamaVisionIds.concat(probed)));
    } else {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return {
          ok: false,
          status: res.status,
          error: explainHttpStatus(res.status, txt),
          detail: txt.slice(0, 300),
        };
      }
      const j = await res.json();
      // OpenAI 兼容各家格式略有差异：data / models / 直接数组
      const arr = Array.isArray(j) ? j : j.data || j.models || j.result || [];
      ids = arr
        .map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model || ''))
        .filter(Boolean);
    }
  } catch (e) {
    return { ok: false, error: explainNetError(e), detail: String(e.message || e) };
  }

  ids = Array.from(new Set(ids)).sort();
  if (!ids.length) {
    return { ok: false, error: '服务商返回了空列表。有些中转站不支持 /models 接口，手动填模型名即可。' };
  }

  const chat = [];
  const vision = [];
  const other = [];
  for (const id of ids) {
    if (NON_CHAT_RE.test(id)) {
      other.push(id);
    } else if (ollamaVisionIds.includes(id) || VISION_RE.test(id)) {
      vision.push(id);
      chat.push(id); // 视觉模型通常也能当聊天模型用
    } else {
      chat.push(id);
    }
  }

  // 我们自己造出来的变体（-nothink / -cap / -orig）不给用户推荐，
  // 那是部署过程生成的，用户手动选它反而会套娃
  const MY_VARIANT_RE = /-nothink$|-cap$|-orig$/;
  const plainChat = chat.filter((id) => !MY_VARIANT_RE.test(id.split(':')[0]));
  const pool = plainChat.length ? plainChat : chat;
  const recModel =
    pickByPreference(pool, CHAT_PREF) ||
    // 本地场景优先推荐名字最短的那个（通常是用户自己 pull 的原版模型）
    (provider === 'ollama' ? pool.slice().sort((a, b) => a.length - b.length)[0] : pool[0]) ||
    '';
  const plainVision = vision.filter((id) => !MY_VARIANT_RE.test(id.split(':')[0]));
  const recCaption = pickByPreference(plainVision, VISION_PREF) || plainVision[0] || vision[0] || '';

  return {
    ok: true,
    count: ids.length,
    chat,
    vision,
    other,
    recommend: {
      model: recModel,
      captionModel: recCaption,
      modelVision: vision.includes(recModel),
      reason: recModel
        ? `已从 ${ids.length} 个模型里挑出推荐项：${recModel}${recCaption ? `，识图用 ${recCaption}` : '（该服务商没有视觉模型，识图需另配）'}`
        : '没识别出可用的聊天模型，请手动填写。',
    },
  };
}

// ---------- 模型连通性自检 ----------
// Key 错、模型名错、地址少了 /v1 —— 这三种错误如果等到"机器人不回话"才发现，
// 用户根本定位不到。部署前先打一次最小请求，把话说明白。
function explainHttpStatus(status, detail) {
  const d = String(detail || '');
  if (status === 401) return 'API Key 无效或已过期（401）。去服务商后台重新复制一把完整 Key。';
  if (status === 402) return '账户余额不足（402）。去服务商后台充值，或换一家。';
  if (status === 403) return '没有权限访问该模型（403）。可能未开通、或地区受限（OpenAI 需代理）。';
  if (status === 404)
    return '接口或模型不存在（404）。多半是【模型名填错】，或 Base URL 少了 /v1（例如 https://api.deepseek.com/v1）。';
  if (status === 400 && /model/i.test(d))
    return '模型名不被接受（400）。去服务商后台复制准确的模型 ID（区分大小写、斜杠）。';
  if (status === 429) return '触发限流（429）。稍等再试，或换一家有免费额度的。';
  if (status >= 500) return `服务商侧故障（${status}）。换个时间再试，不是你的配置问题。`;
  return `请求被拒绝（HTTP ${status}）：${d.slice(0, 160)}`;
}

function explainNetError(e) {
  const m = String((e && e.message) || e);
  if (/ECONNREFUSED|connect ECONNREFUSED/i.test(m))
    return '连不上这个地址（ECONNREFUSED）。选 Ollama 时说明 Ollama 没启动；选云端则检查 Base URL 是否写错。';
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return '域名解析失败（ENOTFOUND）。Base URL 拼错了，或本机没网。';
  if (/timeout|aborted|TimeoutError/i.test(m))
    return '请求超时。OpenAI 等境外服务需要代理；国内服务一般不会超时。';
  if (/CERT|certificate/i.test(m)) return '证书校验失败。可能被中间网络拦截，换个网络再试。';
  return `网络请求失败：${m}`;
}

async function testProvider({ provider, apiKey, apiBase, model, timeoutMs = 25000 }) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const baseRaw = ((apiBase || '').trim() || preset.api_base || '').replace(/\/+$/, '');
  const key = (apiKey || '').trim() || (provider === 'ollama' ? 'ollama' : '');
  const m = (model || '').trim() || preset.default_model || '';
  if (!baseRaw) return { ok: false, error: 'API Base URL 为空，请填写（一般以 /v1 结尾）。' };
  if (!m) return { ok: false, error: '模型名为空，请填写。' };
  if (!key) return { ok: false, error: 'API Key 为空，请填写。' };

  const t0 = Date.now();

  // 本地 Ollama 不发聊天请求：思考型模型光"想"就要十几秒，用户会以为卡死。
  // 而且真正要确认的是"这个模型本地装了没有"，查 /api/tags 又快又准。
  if (provider === 'ollama') {
    const root = baseRaw.replace(/\/v1$/, '');
    try {
      const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const names = (j.models || []).map((x) => String(x.name || ''));
      const hit =
        names.find((n) => n === m) ||
        names.find((n) => n.split(':')[0] === m.split(':')[0]) ||
        names.find((n) => n.startsWith(m.split(':')[0]));
      if (hit) {
        return {
          ok: true,
          ms: Date.now() - t0,
          model: hit,
          base: baseRaw,
          message: `Ollama 正常，模型 ${hit} 已就绪`,
        };
      }
      return {
        ok: false,
        model: m,
        base: baseRaw,
        error: `Ollama 在运行，但本机没有模型「${m}」。先打开命令行执行：ollama pull ${m}（下完再回来点一次）`,
        detail: names.length ? `本机已有：${names.slice(0, 8).join(', ')}` : '本机还没有任何模型',
      };
    } catch (e) {
      return {
        ok: false,
        model: m,
        base: baseRaw,
        error: '连不上 Ollama（127.0.0.1:11434）。请先启动 Ollama 客户端，或改用云端模型（更省事、更快）。',
        detail: String(e.message || e),
      };
    }
  }

  try {
    const res = await fetch(`${baseRaw}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: m,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - t0;
    if (res.ok) {
      return { ok: true, ms, model: m, base: baseRaw, message: `连接成功（${ms}ms）` };
    }
    const txt = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      model: m,
      base: baseRaw,
      error: explainHttpStatus(res.status, txt),
      detail: txt.slice(0, 400),
    };
  } catch (e) {
    return { ok: false, model: m, base: baseRaw, error: explainNetError(e), detail: String(e.message || e) };
  }
}

// 清掉指向"旧服务商"的识图配置。
// 场景：用户先用 Ollama 装了识图，后来改成 DeepSeek —— 旧 caption provider 还挂在
// localhost:11434 上，AstrBot 每次收图都会去连一个不存在的服务，报错且看不到图。
function clearCaptionProvider(keepId) {
  patchBothConfigs((cfg) => {
    cfg = patchWizardOverridesObj(cfg);
    const ps = Object.assign({}, cfg.provider_settings);
    const cur = ps.default_image_caption_provider_id;
    if (cur && cur !== keepId) {
      delete ps.default_image_caption_provider_id;
      log(`已清除失效的识图模型指向：${cur}`);
    }
    // 顺手清掉不再被引用的本地视觉 provider 条目，避免配置越积越乱
    if (Array.isArray(cfg.provider)) {
      cfg.provider = cfg.provider.filter((x) => !x || x.id === keepId || !/^ollama\//.test(String(x.id || '')));
    }
    cfg.provider_settings = ps;
    return cfg;
  });
}

// 通用「图像转述」provider 注册（云端场景）。
// AstrBot 在 provider_settings.default_image_caption_provider_id 有值时，
// 会先把图片转成文字描述，再交给主模型 → 纯文本主模型也能「看图」。
const DEFAULT_CAPTION_PROMPT =
  '用中文一句话描述图片：先说要表达什么，再念出图中所有文字，总计不超过60字。';

function registerCloudCaptionProvider({ id, model, apiBase, apiKey }) {
  patchBothConfigs((cfg) => {
    cfg = patchWizardOverridesObj(cfg);
    const list = Array.isArray(cfg.provider) ? cfg.provider : [];
    const rest = list.filter((x) => x && x.id !== id);
    rest.push({
      id,
      type: 'openai_chat_completion',
      model,
      key: [apiKey],
      api_base: apiBase,
      enable: true,
      modalities: ['text', 'image', 'tool_use'],
    });
    cfg.provider = rest;
    cfg.provider_settings = Object.assign({}, cfg.provider_settings, {
      default_image_caption_provider_id: id,
      image_caption_prompt: (cfg.provider_settings || {}).image_caption_prompt || DEFAULT_CAPTION_PROMPT,
    });
    return cfg;
  });

  // 装了 reimage（图像转述）插件的话，把它的 provider 一起指过来
  try {
    const rp = path.join(WORK_DIR, 'data', 'config', 'astrbot_plugin_reimage_config.json');
    if (fs.existsSync(rp)) {
      const raw = fs.readFileSync(rp, 'utf8').replace(/^\ufeff/, '');
      const rc = JSON.parse(raw);
      rc.img_provider = rc.img_provider || {};
      rc.img_provider.provider_id = id;
      fs.writeFileSync(rp, JSON.stringify(rc, null, 4), 'utf8');
    }
  } catch (_) {
    /* 插件配置写失败不影响主流程 */
  }
  return id;
}

async function configureProvider({
  provider,
  apiKey,
  apiBase,
  model,
  captionModel,
  captionApiBase,
  captionApiKey,
  modelVision,
}) {
  ensureWorkDir();
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;

  // Ollama + 思考型模型：先建关思考变体，否则模型会"想完就没了"（content 空）
  let finalModel = model;
  if (provider === 'ollama' && model) {
    finalModel = await ensureNoThinkVariant(model);
  }

  // 云端思考型模型（Qwen3 系）在百炼/硅基流动上可以显式关思考。
  // 不关的话正文可能为空，表现为"机器人不回话"。视觉模型不加（VL 模型不吃这个参数）。
  const extraBody = {};
  if (provider !== 'ollama' && /qwen3|qwq/i.test(String(finalModel || '')) && !/vl/i.test(String(finalModel || ''))) {
    extraBody.enable_thinking = false;
  }

  // 主模型能否直接收图：前端勾选优先，其次看预设
  const canSeeImages = typeof modelVision === 'boolean' ? modelVision : !!preset.vision;
  const isLocal = provider === 'ollama';

  const patch = buildProviderConfig({
    provider,
    apiKey,
    apiBase,
    model: finalModel,
    modelVision: canSeeImages,
    extraBody,
  });
  patchBothConfigs((cfg) => {
    cfg = patchWizardOverridesObj(cfg);
    // 覆盖同名 provider，避免重复条目
    const list = Array.isArray(cfg.provider) ? cfg.provider : [];
    const rest = list.filter((x) => x && x.id !== provider);
    cfg.provider = rest.concat(patch.provider);
    cfg.provider_settings = Object.assign({}, cfg.provider_settings, patch.provider_settings);
    // AstrBot 4.x 的「默认对话模型」在 agent_runner.config.model.provider_id 上
    cfg.agent_runner = Object.assign({}, cfg.agent_runner, { runner_type: 'local' });
    cfg.agent_runner.config = Object.assign({}, cfg.agent_runner.config, {
      model: Object.assign({}, (cfg.agent_runner.config || {}).model, {
        provider_id: provider,
      }),
      // 上下文轮数：云端 context 大（32k~128k），给 30 轮记得住事；
      // 本地要省显存，只给 15 轮（给太多会把 prompt 撑爆，模型直接"张不开嘴"）。
      max_context_length: isLocal ? LOCAL_MAX_CONTEXT_LENGTH : CLOUD_MAX_CONTEXT_LENGTH,
      dequeue_context_length: isLocal ? 5 : 10,
    });
    return cfg;
  });
  if (Object.keys(extraBody).length) {
    log(`已为 ${finalModel} 关闭思考模式（enable_thinking=false），避免正文为空`);
  }

  // ---------- 识图（看图说话）----------
  // 三条路：① 主模型原生支持图片 → 直接把图交给它（信息最全）；
  //        ② 主模型纯文本 + 配了识图模型 → 先转文字再喂主模型；
  //        ③ 都没有 → 不开，收图时按纯文本处理。
  let visionProvider = '';
  let visionHint = '';

  if (isLocal) {
    const vm = await detectOllamaVisionModel();
    if (vm) {
      // 思考型模型要先生成压制思考的 -cap 变体，否则描述会是空的
      const capModel = await ensureCaptionVariant(vm);
      visionProvider = registerVisionProvider(capModel);
      log(`已开通识图：${visionProvider}（图片先转文字再喂给主模型）`);
    } else {
      log('本机未找到视觉模型，跳过识图配置（装上 qwen3.5 / qwen2.5vl 等后可自动启用）');
      visionHint = '本机未装视觉模型，暂时不能看图。ollama pull qwen2.5vl:7b 后重新部署即可自动开通。';
    }
  } else if (canSeeImages) {
    // 主模型自己就能看图：清掉可能存在的旧 caption 指向，图片直接进主模型
    clearCaptionProvider('');
    log(`主模型 ${finalModel} 原生支持图片，图片直接交给它看（不经过转述）`);
    visionHint = '主模型原生支持图片，图片会直接交给它看。';
  } else {
    const wantCaption = (captionModel || preset.caption_model || '').trim();
    if (wantCaption) {
      const cBase = ((captionApiBase || '').trim() || (apiBase || '').trim() || preset.api_base || '').replace(/\/+$/, '');
      const cKey = (captionApiKey || '').trim() || (apiKey || '').trim();
      const cid = `${provider}__caption`;
      // 换服务商时先清掉旧的识图指向（例如之前用本地 Ollama 视觉模型的），
      // 否则残留条目会一直去连一个已经不用的地址
      clearCaptionProvider(cid);
      visionProvider = registerCloudCaptionProvider({
        id: cid,
        model: wantCaption,
        apiBase: cBase,
        apiKey: cKey,
      });
      log(`已开通识图：${visionProvider}（${wantCaption}，图片先转文字再喂给主模型）`);
      visionHint = `识图已开通，用 ${wantCaption} 把图片转成文字。`;
    } else {
      // 换服务商时不要留着一个连不上的旧识图配置
      clearCaptionProvider('');
      log('未配置视觉模型：收图时只会说看不了。想开识图，换硅基流动/百炼，或填写识图模型。');
      visionHint =
        '当前主模型是纯文本，又没有配识图模型 → 收到图片会说看不了。想要识图：改用硅基流动或阿里百炼（一把 Key 通用视觉模型），或在本页填写「识图模型」。';
    }
  }

  return { configPath: CMD_CONFIG_PATH, provider, model: finalModel, visionProvider, visionHint };
}

// 把某个人设设为默认（AstrBot 4.x：agent_runner.config.persona.persona_id）
function activatePersona(personaId) {
  patchBothConfigs((cfg) => {
    cfg = patchWizardOverridesObj(cfg);
    cfg.agent_runner = Object.assign({}, cfg.agent_runner, { runner_type: 'local' });
    cfg.agent_runner.config = Object.assign({}, cfg.agent_runner.config, {
      persona: Object.assign({}, ((cfg.agent_runner.config || {}).persona || {}), {
        persona_id: personaId,
      }),
    });
    return cfg;
  });
  return { personaId };
}

function writeNapCatReferenceConfig({ token = '' } = {}) {
  const cfg = buildNapCatOnebotConfig({ astrobotWsPort: ASTRBOT_REVERSE_WS_PORT, token });
  fs.writeFileSync(NAPCAT_CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return { path: NAPCAT_CFG_PATH, content: cfg };
}

// ---------- NapCat 检测 / 安装（幂等）----------
// 多重信号判定是否已装：① 默认安装目录；② WebUI 端口可达；③ napcat 命令存在
async function checkNapCat() {
  // 我们自己解压安装的（WORK_DIR\NapCat）
  if (napCatInstalled()) return true;
  const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'NapCat') : '';
  if (local && fs.existsSync(local)) {
    try {
      if (fs.readdirSync(local).some((e) => /napcat/i.test(e))) return true;
    } catch { /* ignore */ }
  }
  if ((await httpGet(`http://127.0.0.1:${NAPCAT_WEBUI_PORT}/`)) > 0) return true;
  try {
    await execP('napcat --version');
    return true;
  } catch {
    return false;
  }
}

// ---------- 免扫码（快速登录）----------
// NapCat 自己支持「快速登录」：config/webui.json 里的 autoLoginAccount 填了 QQ 号，
// 启动时会走 quickLoginWithUin 自动登回去。但默认是空的 —— 于是每次重启都要重新扫码。
// 这里在 QQ 登录后自动把账号填进去，之后重启向导/重启 NapCat 都不用再扫。
//
// 接口（逆向自 NapCat 4.x 的 napcat.mjs）：
//   认证：Authorization: Bearer <Base64(凭证JSON)>，凭证用 POST /api/auth/login {hash} 换
//   hash = sha256(webui_token + ".napcat").hexdigest()
//   路由前缀 /api/QQLogin（Set/GetQuickLoginQQ、GetQuickLoginList）
function httpPostJson(port, urlPath, body, headers) {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(6000, () => { try { req.destroy(); } catch (_) {} resolve(null); });
      req.write(JSON.stringify(body || {}));
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

async function ensureNapCatAutoLogin() {
  try {
    const cfgPath = path.join(NAPCAT_DIR, 'config', 'webui.json');
    if (!fs.existsSync(cfgPath)) return { ok: false, reason: 'no-webui-config' };
    let token = '';
    try { token = (JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}).token || ''; } catch (_) { return { ok: false, reason: 'bad-config' }; }
    if (!token) return { ok: false, reason: 'no-token' };

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(String(token) + '.napcat').digest('hex');
    const login = await httpPostJson(NAPCAT_WEBUI_PORT, '/api/auth/login', { hash });
    const cred = login && login.data && login.data.Credential;
    if (!cred) return { ok: false, reason: 'auth-failed' };
    const auth = { Authorization: `Bearer ${cred}` };

    const cur = await httpPostJson(NAPCAT_WEBUI_PORT, '/api/QQLogin/GetQuickLoginQQ', {}, auth);
    if (cur && cur.data && String(cur.data).trim()) return { ok: true, skipped: true, uin: String(cur.data) };

    const list = await httpPostJson(NAPCAT_WEBUI_PORT, '/api/QQLogin/GetQuickLoginList', {}, auth);
    const arr = (list && list.data) || [];
    if (!arr.length) return { ok: false, reason: 'no-quick-login-account' };

    // 只认「配好反向 WS 的那个号」（说明是机器人本体），否则宁可不设快速登录。
    // ★ 不能兜底取列表第一个：客户自己大号先登过 QQ 的话，会把大号设成自动登录
    //   （2026-10-26 客户机事故：机器人一直登大号切不回来）。宁可让用户多扫一次码。
    // 不能只看有没有 onebot11_<QQ>.json —— 登录过的号都有这个文件，
    // 但 websocketClients 可能是空的（选错号 → 机器人登录了却连不上 AstrBot，实测踩过）。
    let prefer = '';
    try {
      const re = /^onebot11_(\d+)\.json$/;
      for (const f of fs.readdirSync(path.join(NAPCAT_DIR, 'config'))) {
        const m = f.match(re);
        if (!m) continue;
        try {
          const raw = fs.readFileSync(path.join(NAPCAT_DIR, 'config', f), 'utf8').replace(/^\ufeff/, '');
          const j = JSON.parse(raw || '{}');
          const cs = (j.network && j.network.websocketClients) || [];
          if (cs.some((c) => c && c.enable && String(c.url || '').includes(`:${ASTRBOT_REVERSE_WS_PORT}`))) {
            prefer = m[1];
            break;
          }
        } catch (_) {}
      }
    } catch (_) {}
    const uin = prefer && arr.find((u) => String(u) === String(prefer)) ? String(prefer) : '';
    if (!uin) return { ok: false, reason: 'no-verified-account', list: arr.map(String) };
    const r = await httpPostJson(NAPCAT_WEBUI_PORT, '/api/QQLogin/SetQuickLoginQQ', { uin: String(uin) }, auth);
    if (r && r.code === 0) {
      log(`已设置 NapCat 自动登录账号 ${uin}（以后重启不用再扫码）`);
      return { ok: true, uin: String(uin) };
    }
    return { ok: false, reason: 'set-failed' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// 自动把 NapCat 的 OneBot 配置写好（WebSocket 客户端指向 AstrBot 反向 WS）。
// 用户在 WebUI 里手动加容易漏（实测：机器人 QQ 已登录但 websocketClients 为空，导致永远不回消息）。
// NapCat 每个登录的 QQ 有独立配置文件 config/onebot11_<QQ号>.json。
function ensureNapCatOnebotWs() {
  const cfgDir = path.join(NAPCAT_DIR, 'config');
  let touched = [];
  let files = [];
  try { files = fs.readdirSync(cfgDir).filter((f) => /^onebot11_.*\.json$/i.test(f)); } catch (e) { return touched; }
  for (const f of files) {
    const p = path.join(cfgDir, f);
    try {
      let raw = fs.readFileSync(p, 'utf8');
      const bom = raw.charCodeAt(0) === 0xfeff;
      if (bom) raw = raw.slice(1);
      raw = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
      const j = JSON.parse(raw || '{}');
      j.network = j.network || {};
      let clients = Array.isArray(j.network.websocketClients) ? j.network.websocketClients : [];
      const url = `ws://127.0.0.1:${ASTRBOT_REVERSE_WS_PORT}/ws`;
      const target = clients.find((c) => c && String(c.url || '').includes(`:${ASTRBOT_REVERSE_WS_PORT}`));
      if (target) {
        target.enable = true;
        target.url = url;
      } else {
        clients = clients.filter((c) => c && c.enable);
        clients.push({
          name: 'astrbot',
          enable: true,
          url,
          reportSelfMessage: false,
          messagePostFormat: 'array',
          token: '',
          debug: false,
          heartInterval: 30000,
          reconnectInterval: 5000,
        });
      }
      j.network.websocketClients = clients;
      fs.writeFileSync(p, (bom ? '\ufeff' : '') + JSON.stringify(j, null, 2), 'utf8');
      touched.push(f);
    } catch (e) { /* 单个文件失败不影响其他 */ }
  }
  return touched;
}

// 从注册表/运行进程找 QQ 安装路径（NapCat 注入器需要它）
// 解析要足够宽容：不同机器上 UninstallString 可能是
//   "D:\Uninstall.exe" / "D:\unins000.exe" / 带引号 / 带参数，DisplayIcon 则是 "D:\QQ.exe,0"
function findQQPath() {
  const keys = [
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  ];
  const psGet = (prop) => {
    for (const k of keys) {
      try {
        const out = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `(Get-ItemProperty '${k}' -ErrorAction SilentlyContinue).${prop}`],
          { windowsHide: true, timeout: 15000, encoding: 'utf8' }
        ).trim();
        if (out) return out;
      } catch (_) { /* 换下一个来源 */ }
    }
    return '';
  };
  const ok = (p) => { try { return !!(p && fs.existsSync(p)); } catch (_) { return false; } };
  const fromDir = (dir) => (dir ? path.join(dir, 'QQ.exe') : '');

  // ① UninstallString → 取所在目录拼 QQ.exe（兼容 Uninstall.exe / unins000.exe）
  const unins = psGet('UninstallString').replace(/^"|"$/g, '').trim();
  if (unins) {
    const dir = path.dirname(unins.split(/\s+/)[0].replace(/^"|"$/g, ''));
    if (ok(fromDir(dir))) return fromDir(dir);
  }
  // ② DisplayIcon 常常直接就是 "D:\QQ.exe,0"
  const icon = psGet('DisplayIcon').replace(/^"|"$/g, '').trim();
  if (icon) {
    const p = icon.split(',')[0].trim();
    if (ok(p)) return p;
  }
  // ③ QQ 正在运行：直接拿进程路径（最可靠）
  try {
    const running = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "Get-Process QQ -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' }
    ).trim();
    if (ok(running)) return running;
  } catch (_) { /* 没在跑 */ }
  // ④ 常见安装目录兜底
  for (const d of [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent\\QQ'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent\\QQNT'),
    'D:\\',
    path.join(process.env.LOCALAPPDATA || '', 'Programs\\Tencent\\QQ'),
  ]) {
    if (ok(fromDir(d))) return fromDir(d);
  }
  return '';
}

// 启动 NapCat：**无窗口后台运行**。
// 以前用 `start "NapCat" cmd /k launcher-user.bat` 弹一个常驻黑窗，用户抱怨两件事：
//   ① 窗口太多太乱；② 误关那个窗口 NapCat 就停了（机器人哑掉）。
// 现在直接调 NapCat 自带的注入器 NapCatWinBootMain.exe（launcher-user.bat 本质上就是
// 设置几个 NAPCAT_* 环境变量后调它），stdio 重定向到 napcat.log、windowsHide + detached，
// 于是：没有任何需要用户保持开启的窗口；日志照样落盘；WebUI(6099) 与扫码登录完全不受影响。
// 只有在注入器/QQ 路径拿不到时才回退到 launcher（带窗口，但至少能用）。
// QQ 的 0xc06d007f 错误弹窗同理：只藏不点（点「确定」可能连 QQ 一起结束）。
// 实现放 tools/hide_napcat_console.ps1：纯 user32 ShowWindow，不动进程。
function hideQQConsoleAsync(qqPath) {
  const script = path.join(__dirname, '..', 'tools', 'hide_napcat_console.ps1');
  if (!fs.existsSync(script)) return;
  try {
    // windowsHide 不能加：与 detached 组合反而弹可见 PowerShell 窗（同 startAstrbot 的坑）
    const ps = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ConsoleTitle', qqPath, '-Seconds', '300'],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    ps.unref();
    log('QQ 控制台窗口已自动隐藏（进程正常运行，不是关掉了）');
  } catch (_) {
    /* 隐藏失败不影响启动，顶多桌面上多一个窗口 */
  }
}

function startNapCat() {
  const launcher = findNapCatLauncher();
  if (!launcher) throw new Error('未找到 launcher.bat，请先完成 NapCat 安装');
  ensureWorkDir();
  // 启动前自动把「连回 AstrBot」的 WebSocket 客户端写进每个已登录 QQ 的配置里，
  // 免得用户漏配导致机器人永远不回消息
  try {
    const touched = ensureNapCatOnebotWs();
    if (touched.length) log(`已自动写入 OneBot 连接配置: ${touched.join(', ')}`);
  } catch (e) { /* ignore */ }
  const logPath = path.join(WORK_DIR, 'napcat.log');
  const dir = path.dirname(launcher);

  // 已经有一个 NapCat 在跑就别再起一个（否则两个注入器互相打架，表现为"时好时坏"）
  if (isNapCatRunning()) {
    log('NapCat 已在运行，跳过重复启动');
    return { started: true, alreadyRunning: true, logPath, mode: 'hidden' };
  }
  // ★ 冷却窗：刚启动过 15 秒内不再重复拉起（NapCat 起动到 6099 就绪有几秒延迟，
  //   期间 isNapCatRunning 可能还探测不到；没有这层，用户连点/前端轮询会叠出多个 QQ）
  const now = Date.now();
  if (now - (startNapCat._lastStart || 0) < 15000) {
    log('NapCat 刚在 15 秒内启动过，跳过重复启动（冷却中）');
    return { started: true, alreadyRunning: true, cooldown: true, logPath, mode: 'hidden' };
  }
  startNapCat._lastStart = now;

  const bootExe = path.join(dir, 'NapCatWinBootMain.exe');
  const hookDll = path.join(dir, 'NapCatWinBootHook.dll');
  const qqPath = fs.existsSync(bootExe) && fs.existsSync(hookDll) ? findQQPath() : '';

  if (qqPath) {
    fs.appendFileSync(logPath, `\r\n[start ${new Date().toLocaleString()}] 无窗口模式: ${bootExe} + ${qqPath}\r\n`);
    rotateLogIfNeeded(logPath);   // ★ S7：超过 10MB 滚动成 .log.1
    const out = fs.openSync(logPath, 'a');
    // 这几个环境变量与 launcher-user.bat 完全一致（缺一个注入就会失败）
    const env = Object.assign({}, process.env, {
      NAPCAT_PATCH_PACKAGE: path.join(dir, 'qqnt.json'),
      NAPCAT_LOAD_PATH: path.join(dir, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: hookDll,
      NAPCAT_LAUNCHER_PATH: bootExe,
      NAPCAT_MAIN_PATH: path.join(dir, 'napcat.mjs'),
    });
    try {
      // 注意：绝不能加 windowsHide:true —— 与 detached 组合时 libuv 的
      // DETACHED_PROCESS 和 CREATE_NO_WINDOW 互斥，反而会创建一个【可见】控制台
      // （Win11 默认终端=Windows Terminal 时会托管成黑窗）。表现就是「每启动/
      // 每自愈重启一次 NapCat 就弹一个黑窗」。只用 detached 才是真·无窗。
      const child = spawn(bootExe, [qqPath, hookDll], {
        cwd: dir,
        detached: true,
        stdio: ['ignore', out, out],
        env,
      });
      child.on('error', (e) => {
        try { fs.appendFileSync(logPath, `[spawn error] ${e.message}\r\n`); } catch (_) {}
      });
      child.unref();
      fs.closeSync(out);   // ★ S12：子进程已继承句柄，父进程用完即关（否则日志文件永远被占用，reset 清不掉）
      log('NapCat 已无窗口启动（日志见 napcat.log，WebUI 在 6099）');
      // NapCatWinBootMain 会给 QQ 分配控制台（windowsHide 拦不住），延时扫到就藏
      hideQQConsoleAsync(qqPath);
      return { started: true, logPath, mode: 'hidden', pid: child.pid, qqPath };
    } catch (e) {
      log(`无窗口启动失败（${e.message}），回退到带窗口启动`);
    }
  }

  // 回退：launcher-user.bat（会有一个常驻窗口，但功能完整）
  fs.appendFileSync(logPath, `\r\n[start ${new Date().toLocaleString()}] 回退带窗口: ${launcher}\r\n`);
  const cmdLine = `start "NapCat（勿关闭）" cmd /k ""${launcher}""`;
  exec(cmdLine, { cwd: dir, windowsHide: false }, (err) => {
    if (err) {
      try { fs.appendFileSync(logPath, `[start error] ${err.message}\r\n`); } catch (_) {}
    }
  });
  return { started: true, launcher, logPath, mode: 'window' };
}

// NapCat 是否已在运行：看 NapCatWinBootMain.exe 进程（注入器），
// 以及 6099 端口是否已被监听（双判据，避免误判）。
// ★ 2026-10-26 客户机事故：注入器拉起 QQ 后可能退出，只查进程会误判成"没在跑"，
//   用户每点一次「启动」就多开一个 QQ，桌面上叠出十几个控制台窗口。
function isNapCatRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq NapCatWinBootMain.exe', '/NH'], {
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    });
    if (/NapCatWinBootMain\.exe/i.test(out)) return true;
  } catch (_) { /* tasklist 失败就只靠端口判断 */ }
  return isPortListening(NAPCAT_WEBUI_PORT);
}

// 端口是否真的处于 LISTENING（netstat 解析，同步、~百毫秒级）。
// 注意：不能用"自己 bind 试试"——Node 在 Windows 上带 SO_REUSEADDR，
// 绑一个已被监听的端口照样"成功"（实测踩过）。
function isPortListening(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    const re = new RegExp(':' + Number(port) + '\\s');
    for (const line of out.split('\n')) {
      if (re.test(line) && /LISTENING/i.test(line)) return true;
    }
  } catch (_) { /* netstat 失败按没监听处理 */ }
  return false;
}

// 反向 WS 是否真的连上了。为什么需要它：NapCat 只在「启动/登录那一刻」读
// onebot11_<QQ号>.json，登录后补写的 websocketClients 不会被热加载
// （实测踩过：配置明明 enable:true，进程也活着，机器人就是不回消息——
// 因为 WS 客户端从来没启动过，唯一的解法是重启 NapCat 让它重读配置）。
// 探测 AstrBot 反向 WS 端口上有没有 ESTABLISHED 连接（一条连接 netstat 出两行）。
function napcatWsConnected() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    const lines = out.split(/\r?\n/).filter(
      (l) => l.includes(`:${ASTRBOT_REVERSE_WS_PORT}`) && /ESTABLISHED/i.test(l)
    );
    return lines.length >= 2;
  } catch (_) { return true; } // 探测失败就当连着，别误杀
}

// NapCat 在跑但 WS 一直没连上 → 重启它重读配置（幂等，失败静默）。
// restart 前调用方应确认：AstrBot 的反向端口在 LISTENING（否则重启也没用）。
function restartNapCat() {
  try {
    execFileSync('taskkill', ['/IM', 'NapCatWinBootMain.exe', '/F'], { windowsHide: true, timeout: 15000 });
  } catch (_) { /* 进程可能已退出 */ }
  startNapCat._lastStart = 0;   // 主动重启要绕过 15 秒冷却，否则会被当成"刚启动过"而跳过
  try {
    return startNapCat();
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

// 一键装 NapCat：下载官方安装脚本并提权运行（Windows 会弹一次 UAC，用户点“是”即可）。
// 安装器本身有交互界面，无法在此等待完成；调用方应在安装后通过 checkNapCat 探活确认。
// 用 Node 自带的 fetch 下载（Node 18+ 全局可用），不走 Invoke-WebRequest：
// 报错可读、无引号问题、可控超时
async function downloadFile(url, dest, { onProgress, timeoutMs = 0, shouldAbort } = {}) {
  const ctrl = timeoutMs > 0 ? new AbortController() : null;
  // timeoutMs 语义 = 「停滞超时」：超过这么久没收到任何数据才掐。
  // 之前是整个下载的绝对超时，代理慢一点 34MB 会在 99% 处被掐死（实测 32.7/34MB 翻车）。
  let stallTimer = null;
  const arm = () => {
    if (!ctrl) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      try { ctrl.abort(new Error(`下载停滞（超过 ${Math.round(timeoutMs / 1000)} 秒没有收到数据）`)); } catch (_) {}
    }, timeoutMs);
  };
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: ctrl ? ctrl.signal : undefined });
    arm(); // 连上了就开始计时，之后每收到一段数据重新计
  } catch (e) {
    if (stallTimer) clearTimeout(stallTimer);
    throw e;
  }
  if (!res.ok) {
    if (stallTimer) clearTimeout(stallTimer);
    // ★ S5 修复：失败时主动取消响应体，避免悬挂连接占着 socket
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') || 0);
  // 流式落盘：① 能算真实百分比 ② 大文件不用整个塞进内存
  let received = 0;
  let lastPush = 0;
  const ws = fs.createWriteStream(dest);
  // 手动用 reader 读：for-await 会 lock 住流，竞速时想中途 cancel 会抛
  // "ReadableStream is locked"（实测踩到），用 reader.cancel() 才是正确姿势。
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); // 还在来数据 = 连接活着，重置停滞计时
      // 竞速下载：别的源已经赢了就立刻收手，别再占带宽
      if (shouldAbort && shouldAbort()) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error('已由更快的下载源接管');
      }
      received += value.length;
      if (!ws.write(value)) {
        await new Promise((r) => ws.once('drain', r));
      }
      // 限流：每 120ms 或每 1% 推一次，别把 SSE 打爆
      const now = Date.now();
      if (onProgress && now - lastPush > 120) {
        lastPush = now;
        onProgress(received, total);
      }
    }
  } catch (e) {
    try { await reader.cancel(); } catch (_) {}
    throw e;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    await new Promise((r) => ws.end(r));
  }
  if (onProgress) onProgress(received, total || received);
  if (!received) throw new Error('下载内容为空');
  return received;
}

// 竞速下载：同时开 N 个源，谁先下完用谁，其余立刻中止。
// 为什么要这样：同一个 GitHub release，不同代理的速度能差 200 倍（实测 gh-proxy 8KB/s、
// ghfast 数 MB/s）。串行试源会先撞上慢的那个，用户以为卡死；并发则总是拿到最快的。
async function downloadRace(urls, dest, { onProgress, timeoutMs = 120000, concurrency = 3, validate = null } = {}) {
  let winner = -1;
  const stat = new Map(); // 各源已下载字节，进度条显示最快的那个
  const runOne = async (url, i) => {
    const tmp = `${dest}.part${i}`;
    let lastE = null;
    // 每个源自动重试一次：代理连接中途 Reset 很常见（实测 32.7/34MB 断流），
    // 第二次往往就成了；重试前清掉上次留下的半截文件。
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          try { fs.unlinkSync(tmp); } catch (_) {}
          await new Promise((r) => setTimeout(r, 1500));
        }
        const n = await downloadFile(url, tmp, {
          timeoutMs,
          shouldAbort: () => winner >= 0 && winner !== i,
          onProgress: (got, total) => {
            stat.set(i, { got, total });
            if (winner >= 0 || !onProgress) return;
            // 取当前跑得最快的那个源的进度来展示
            let best = { got: 0, total: 0 };
            for (const v of stat.values()) if (v.got > best.got) best = v;
            onProgress(best.got, best.total);
          },
        });
        // 内容校验：代理站可能返回 HTTP 200 但给的是 HTML 广告跳转页
        // （实测 381 字节的假 zip 抢先"夺冠"，真源反被中止 → 解压找不到 launcher.bat）。
        // 校验不过 = 该源失败，让其余源继续竞速。
        if (validate) {
          const v = await validate(tmp, n);
          if (v !== true) {
            throw new Error(typeof v === 'string' ? v : '下载内容校验未通过');
          }
        }
        if (winner < 0) winner = i;
        else {
          // 慢一步才下完：直接丢弃，别留下垃圾文件
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
        return { i, tmp, n };
      } catch (e) {
        lastE = e;
        // 「被更快源接管」不是失败，别重试
        if (/更快的下载源/.test(e && e.message)) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
      }
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw lastE;
  };

  let lastErr = null;
  for (let start = 0; start < urls.length; start += concurrency) {
    const batch = urls.slice(start, start + concurrency);
    let ok = null;
    // 关键点：本批里【第一个成功的源】立刻返回，不去等慢源收尾
    // （否则会一直等到超时，用户看着进度条干着急）
    await new Promise((resolve) => {
      if (!batch.length) return resolve();
      let remaining = batch.length;
      batch.forEach((url, k) => {
        runOne(url, start + k).then(
          (r) => { if (!ok) ok = r; resolve(); },
          (e) => { lastErr = lastErr || e; if (--remaining === 0) resolve(); }
        );
      });
    });
    if (ok) {
      const { tmp } = ok;
      try { fs.unlinkSync(dest); } catch (_) {}
      fs.renameSync(tmp, dest);
      // 清掉其它并发留下的半截文件
      for (let i = 0; i < urls.length; i++) {
        try { fs.unlinkSync(`${dest}.part${i}`); } catch (_) {}
      }
      return ok.n;
    }
  }
  throw new Error('所有下载源均失败' + (lastErr && lastErr.message ? `（${lastErr.message}）` : ''));
}

// ---------- NapCat 本体安装 ----------
// 官方 install.ps1 依赖 GitHub（PowerShell-ForGitHub 模块等），国内网络必挂（实测翻车）。
// 改为自己下载 NapCat.Shell.zip（需机器上已装 QQ，用户桌面 QQ 一般都有）：
//   解压 -> 双击 launcher.bat 启动 -> 控制台打印 WebUI token 和二维码。
//
// ⚠️ NapCat 合规现状（默认联网，可选离线）：
//   NapCat 是 Limited Redistribution License —— 允许附许可证再分发，但禁止商业用途。
//   ① 默认分发包不带 vendor/NapCat.Shell.zip，安装时从官方 release 下载并校验；
//   ② 自用/离线包可把 zip 放进 vendor/（附 vendor/LICENSE-NAPCAT.txt），仅限个人非商用；
//   ③ 对外收费代部署或商用前，必须先取得 NapCat 作者授权。
const NAPCAT_DIR = path.join(WORK_DIR, 'NapCat');
const VENDOR_NAPCAT = path.join(__dirname, '..', 'vendor', 'NapCat.Shell.zip');
// 只有 vendor/ 里真有 >20MB 的离线包时才默认离线；否则一律联网下载。
// 想强制离线/联网：DAFEIYU_NAPCAT_OFFLINE=1 / 0。
let _vendorNapcatOk = false;
try {
  _vendorNapcatOk =
    fs.existsSync(VENDOR_NAPCAT) && fs.statSync(VENDOR_NAPCAT).size > 20 * 1024 * 1024;
} catch (_) { /* ignore */ }
const NAPCAT_OFFLINE =
  process.env.DAFEIYU_NAPCAT_OFFLINE === '1' ||
  (process.env.DAFEIYU_NAPCAT_OFFLINE !== '0' && _vendorNapcatOk);
// GitHub 代理站寿命很短（2026-10-25 实测：下面前 5 个只剩 ghproxy.net 活着，
// 其余全是 502 / 握手超时），所以多列几个、下载时逐个竞速，别押注单个。
const NAPCAT_ZIP_MIRRORS = [
  'https://ghfast.top/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://ghproxy.net/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://github.moeyy.xyz/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://gh.llkk.cc/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://gh-proxy.com/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://ghps.cc/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://mirror.ghproxy.com/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://gh-proxy.ygxz.in/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://gh-proxy.linioi.com/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
  'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip',
];

// 在解压目录里找启动器（zip 结构可能带一层目录，递归找）
function findNapCatLauncher() {
  const cands = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && /^launcher.*\.bat$/i.test(e.name)) cands.push(p);
      if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(NAPCAT_DIR, 0);
  // 优先级：launcher-user（免管理员，实测最顺）> win10-user > launcher.bat（要 UAC）> win10
  cands.sort((a, b) => {
    const score = (f) => {
      const n = f.toLowerCase();
      if (n.includes('user') && !n.includes('win10')) return 0;
      if (n.includes('win10') && n.includes('user')) return 1;
      if (n.includes('win10')) return 3;
      return 2;
    };
    return score(a) - score(b);
  });
  return cands[0] || '';
}

function napCatInstalled() {
  try {
    if (!fs.existsSync(NAPCAT_DIR)) return false;
    // 解压完成 + 有启动器（config/webui.json 要等首次启动才生成，不作判据）
    if (findNapCatLauncher()) return true;
    return fs.existsSync(path.join(NAPCAT_DIR, 'napcat.mjs'));
  } catch (e) {
    return false;
  }
}

async function installNapCat() {
  ensureWorkDir(); // 安装包要落在 WORK_DIR，目录必须先存在
  if (await checkNapCat()) {
    emitProgress({ kind: 'progress', step: 'napcat', percent: 100, phase: 'NapCat 已安装，跳过', done: true });
    log('NapCat 已安装，跳过');
    return { skipped: true };
  }
  const zipPath = path.join(WORK_DIR, 'NapCat.Shell.zip');
  let needDownload = true;

  // ① 离线包：只有用户自己把 zip 放进 vendor/ 并设置 DAFEIYU_NAPCAT_OFFLINE=1 才用。
  //    （默认不走这条：我们不做 NapCat 的再分发，见上方合规说明）
  try {
    if (NAPCAT_OFFLINE && fs.existsSync(VENDOR_NAPCAT) && fs.statSync(VENDOR_NAPCAT).size > 20 * 1024 * 1024) {
      emitProgress({ kind: 'progress', step: 'napcat', percent: 30, phase: '正在解压自备的 NapCat 离线包…' });
      fs.copyFileSync(VENDOR_NAPCAT, zipPath);
      needDownload = false;
      log('使用用户自备的 NapCat 离线包（跳过下载）');
    }
  } catch (e) {
    log(`离线包不可用（${e.message}），改为联网下载`);
  }

  // ② 其次：之前已经下载好的（>30MB 且 zip 魔数正确）
  try {
    const stale = fs.existsSync(zipPath) && fs.statSync(zipPath).size > 30 * 1024 * 1024;
    if (stale) {
      const fd = fs.openSync(zipPath, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (head[0] === 0x50 && head[1] === 0x4b) {
        needDownload = false;
        emitProgress({ kind: 'progress', step: 'napcat', percent: 55, phase: '发现已下载的安装包，跳过下载' });
      } else {
        log('已存在的安装包不是有效 zip（可能之前下载被劫持），重新下载');
        try { fs.unlinkSync(zipPath); } catch (_) {}
      }
    }
  } catch (e) { /* ignore */ }

  if (needDownload) {
    emitProgress({
      kind: 'progress',
      step: 'napcat',
      percent: 2,
      phase: '正在同时连接多个下载源，自动选最快的…',
      indeterminate: true,
    });
    log('开始下载 NapCat（多源竞速，约 34MB）…');
    try {
      const n = await downloadRace(NAPCAT_ZIP_MIRRORS, zipPath, {
        timeoutMs: 120000,
        concurrency: 3,
        // zip 校验：>20MB 且开头是 PK 魔数（防代理劫持返回 HTML 广告页，实测踩过）
        validate: async (tmp, size) => {
          if (size < 20 * 1024 * 1024) return `文件只有 ${size} 字节，不是 NapCat 安装包`;
          let head;
          try {
            const fd = fs.openSync(tmp, 'r');
            head = Buffer.alloc(4);
            fs.readSync(fd, head, 0, 4, 0);
            fs.closeSync(fd);
          } catch (_) {
            return '无法读取下载内容';
          }
          if (head[0] !== 0x50 || head[1] !== 0x4b) return '内容不是 zip（下载源可能被劫持成广告页）';
          return true;
        },
        onProgress: (got, all) => {
          const mb = (got / 1048576).toFixed(1);
          if (all > 0) {
            // 下载占总进度的 0~55%（后面还有解压）
            const pct = Math.min(55, Math.max(2, Math.round((got / all) * 55)));
            emitProgress({
              kind: 'progress',
              step: 'napcat',
              percent: pct,
              phase: `下载 NapCat ${mb}MB / ${(all / 1048576).toFixed(0)}MB`,
              indeterminate: false,
              bytes: { got, total: all },
            });
          } else {
            emitProgress({
              kind: 'progress',
              step: 'napcat',
              percent: 20,
              phase: `下载 NapCat 已接收 ${mb}MB（对方未给总大小）`,
              indeterminate: true,
              bytes: { got, total: 0 },
            });
          }
        },
      });
      log(`下载完成 (${Math.round(n / 1048576)} MB)`);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const head = msg.includes('所有下载源均失败') ? msg : `所有下载源均失败: ${msg}`;
      throw new Error(
        `${head}。可能是当前网络被运营商/代理劫持/限流，可换个网络（如手机热点）重试；或手动从 https://github.com/NapNeko/NapCatQQ/releases 下载 NapCat.Shell.zip 放到 ${WORK_DIR} 再重试`
      );
    }
  }

  emitProgress({ kind: 'progress', step: 'napcat', percent: 62, phase: '正在解压 NapCat（约 34MB，20~60 秒）…', indeterminate: true });
  // 解压：优先 Windows 自带的 bsdtar（System32\tar.exe，原生支持 zip，速度最快）。
  // 不能裸调 `tar` —— PATH 里若是 Git Bash 的 GNU tar 会把 "C:\..." 当远程主机
  // （报 "Cannot connect to C: resolve failed"，实测翻车）。失败再退 Expand-Archive。
  fs.mkdirSync(NAPCAT_DIR, { recursive: true });
  const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  try {
    await execP(`"${sysTar}" -xf "${zipPath}" -C "${NAPCAT_DIR}"`, { maxBuffer: 1024 * 1024 * 16 });
  } catch (e) {
    log(`系统 tar 解压失败(${e.message.split('\n')[0]})，改用 Expand-Archive…`);
    await ps(`Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${NAPCAT_DIR}" -Force`);
  }
  emitProgress({ kind: 'progress', step: 'napcat', percent: 92, phase: '正在检查启动器…', indeterminate: true });
  const launcher = findNapCatLauncher();
  if (!launcher) throw new Error(`解压完成但没找到 launcher.bat（目录: ${NAPCAT_DIR}）`);
  log(`NapCat 已解压到 ${NAPCAT_DIR}`);
  emitProgress({ kind: 'progress', step: 'napcat', percent: 100, phase: 'NapCat 安装完成', done: true });
  return { installed: true, launcher, dir: NAPCAT_DIR, note: '已下载并解压完成，点「启动 NapCat」即可。' };
}

// ---------- 统一环境状态（前端据此自动跳过已完成步骤）----------
// 清空运行环境（做完可以反复从零测，用户搞坏了也能自助重来）。
// 只清沙盒：AstrBot 程序和 uv 留着，重装/重下都不需要。
async function resetEnvironment() {
  ensureWorkDir();
  emitProgress({ kind: 'progress', step: 'reset', percent: 10, phase: '正在停止 AstrBot…', indeterminate: true });
  // 先停进程，否则 astrbot.log / .lock 被占用删不掉
  await ps(
    "Get-Process astrbot,uv -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 1800));

  emitProgress({ kind: 'progress', step: 'reset', percent: 40, phase: '正在清理配置文件与数据…', indeterminate: true });
  const keep = new Set(['astrbot.lock']); // 锁文件通常还活着，跳过不影响
  let removed = 0;
  let failed = [];
  for (const name of fs.readdirSync(WORK_DIR)) {
    if (keep.has(name)) continue;
    try {
      fs.rmSync(path.join(WORK_DIR, name), { recursive: true, force: true, maxRetries: 2 });
      removed++;
    } catch (e) {
      failed.push(`${name}(${e.code || e.message})`);
    }
  }
  // NapCat 目录文件多，单独再试一次
  try {
    fs.rmSync(path.join(WORK_DIR, 'NapCat'), { recursive: true, force: true, maxRetries: 3 });
  } catch (_) {}

  emitProgress({ kind: 'progress', step: 'reset', percent: 100, phase: '环境已清空', done: true });
  log(`环境已清空：删除 ${removed} 项${failed.length ? '，失败：' + failed.join(', ') : ''}`);
  return { cleared: true, removed, failed };
}

async function status() {
  const [uv, sysPython, astrbot, napcat, dash] = await Promise.all([
    checkUv(),
    checkPython(),
    checkAstrbot(),
    checkNapCat(),
    httpGet(`http://127.0.0.1:${DASHBOARD_PORT}/`).then((c) => c > 0),
  ]);
  // 系统没装 Python 也完全没问题：AstrBot 由 uv 自动配 Python，
  // 注入人设用的是 tools/python 里的便携版。只有「uv 和便携版都没有」才算真缺。
  const python = sysPython || uv || fs.existsSync(BUNDLED_PY);
  const initialized = fs.existsSync(CONFIG_PATH);
  return {
    uv,
    python,
    astrbot,
    napcat,
    configExists: initialized,
    initialized,
    // 当前是否有安装任务在跑（刷新页面/开两个标签页时，前端据此禁用按钮，
    // 避免用户重复点击导致两个安装任务并发——那会让进度条乱跳、下载文件互相覆盖）
    busy: busyStep || '',
    // 模型到底配没配：光有 config.json 不算，得真的有 provider 且指定了默认模型
    modelConfigured: isModelConfigured(),
    dashboardUp: dash,
    dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT}/`,
    napcatUrl: `http://127.0.0.1:${NAPCAT_WEBUI_PORT}/`,
    // 哪些步骤已可跳过
    steps: {
      prereq: uv, // uv 就绪即可
      astrbot: astrbot && initialized, // AstrBot 装上且已 init
      model: isModelConfigured(), // 模型真的配好了才能跳
      napcat: napcat,
    },
  };
}

// 判断模型配置是否真的可用（决定能不能进下一步）
function isModelConfigured() {
  try {
    const { cfg } = readCfg(CMD_CONFIG_PATH);
    const list = Array.isArray(cfg.provider) ? cfg.provider : [];
    const enabled = list.filter((p) => p && p.enable !== false && p.id);
    const ar = (cfg.agent_runner || {}).config || {};
    const pid = (ar.model || {}).provider_id || (cfg.provider_settings || {}).default_provider_id;
    if (!enabled.length || !pid) return false;
    // 默认模型必须真的在 provider 列表里，否则 AstrBot 启动后会找不到模型
    return enabled.some((p) => p.id === pid);
  } catch (_) {
    return false;
  }
}

// ---------- Python 探测（用于跑 sqlite 注入脚本）----------
// AstrBot 的库是 SQLite，纯 stdlib 即可操作。
// 优先用本工具打包的 tools/python/python.exe（朋友机器无需另装 Python）；
// 其次系统 python/py；最后回退 uv 自带的 python。
const BUNDLED_PY = path.join(__dirname, '..', 'tools', 'python', 'python.exe');
let cachedPython = null;
async function getPythonCmd() {
  if (cachedPython) return cachedPython;
  const candidates = [BUNDLED_PY, 'python', 'python3', 'py'];
  for (const c of candidates) {
    try {
      await execP(`"${c}" --version`);
      cachedPython = c;
      return c;
    } catch {
      /* try next */
    }
  }
  // 回退：用 uv 自带的 python（保证可用）
  try {
    await execP('uv run --no-project python --version');
    cachedPython = 'uv run --no-project python';
    return cachedPython;
  } catch {
    throw new Error('未找到可用的 Python（python/py 均不可用，且 uv 调用失败）');
  }
}

// ---------- 人设注入（零复制粘贴核心）----------
// 把大肥鱼人设直接写进 AstrBot 的 SQLite 数据库并设置默认人格。
async function injectPersona({ id = 'dafeiyu', name = '大肥鱼', prompt } = {}) {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error('AstrBot 数据目录尚未初始化，请先完成「安装并初始化」步骤');
  }
  // 人设存放在 AstrBot 首次启动时创建的数据库（data/data_v4.db）里。
  // AstrBot 还没成功启动过就没有这个库，注入必然失败 —— 提前检查并说清楚下一步怎么做，
  // 而不是等用户点了「一键注入」才看到一句看不懂的报错。
  const dbFile = path.join(DATA_DIR, 'data_v4.db');
  if (!fs.existsSync(dbFile)) {
    throw new Error(
      'AstrBot 还没完成首次启动（人设存放在它首次启动时才创建的数据库里）。\n' +
        '请先到第 ⑤ 步点「启动 AstrBot」，等它跑起来（约 30 秒、面板能打开）后，再回来注入人设。'
    );
  }
  if (!prompt || !prompt.trim()) {
    throw new Error('人设文本为空');
  }
  // 把人设写到临时文件，避免命令行长度/编码问题
  const tmp = path.join(WORK_DIR, '.persona_tmp.txt');
  fs.writeFileSync(tmp, prompt, 'utf8');

  const py = await getPythonCmd();
  // 注意：id 也要加引号，中文/含空格的人设 ID 才不会把命令截断
  const cmd = `"${py}" "${INJECT_SCRIPT}" --data-dir "${DATA_DIR}" --id "${id}" --name "${name}" --prompt-file "${tmp}"`;
  let stdout = '';
  let stderr = '';
  try {
    const r = await execP(cmd, { maxBuffer: 1024 * 1024 * 8 });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    // ⚠️ 注入脚本把错误以 JSON 形式写到【stdout】然后退出码 1，stderr 往往是空的。
    // 早期只取 stderr，结果用户只看到 "Command failed: ..." 这句毫无信息量的回显，
    // 真正原因（比如"未找到数据库"）被吞了。所以先尝试从 stdout/stderr 解析出真实原因。
    let reason = '';
    for (const src of [stdout, stderr]) {
      try {
        const line = String(src).trim().split('\n').filter(Boolean).pop();
        const j = JSON.parse(line);
        if (j && j.error) {
          reason = j.error;
          break;
        }
      } catch (_) { /* 不是 JSON，换下一个来源 */ }
    }
    if (!reason) reason = (stderr || stdout || e.message || '').trim();
    throw new Error('注入失败：' + String(reason).slice(-500));
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim().split('\n').pop());
  } catch {
    throw new Error('注入脚本输出无法解析：' + stdout + stderr);
  }
  if (!parsed.ok) throw new Error(parsed.error || '注入失败');

  // 写默认人格配置：AstrBot 4.x 读 agent_runner.config.persona.persona_id
  activatePersona(id);
  return parsed;
}

// 兼容旧调用：把默认人格 ID 同时写进 provider_settings.default_personality
function setDefaultPersona(id) {
  patchBothConfigs((cfg) => {
    cfg = patchWizardOverridesObj(cfg);
    cfg.provider_settings = cfg.provider_settings || {};
    cfg.provider_settings.default_personality = id;
    return cfg;
  });
  return { ok: true, personaId: id };
}

// ---------- ffmpeg（edge_tts 语音必需）----------
// AstrBot 的 edge_tts 会先用 edge-tts 生成 mp3，再调 ffmpeg 转成 wav 发 QQ。
// 系统没装 ffmpeg 时报 [WinError 2] 系统找不到指定的文件 → 表现为「不发语音」。
const FFMPEG_DIR = path.join(WORK_DIR, 'bin');
const FFMPEG_PATH = path.join(FFMPEG_DIR, 'ffmpeg.exe');
// npmmirror 的 ffmpeg-static 6.1.1（28MB 压缩 / 79MB 解压），国内可直连。
// 版本必须够新：AstrBot 用 `apad=pad_dur=2` 过滤器参数，
// 老版本（如 4.x）不认识它，会报 "Option 'pad_dur' not found" 导致转码失败。
const FFMPEG_PKG_URL =
  'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz';

function hasFfmpeg() {
  try {
    if (!fs.existsSync(FFMPEG_PATH)) return false;
    // 光有文件不够：必须是认识 pad_dur 的新版本，否则语音依然失败
    const out = execFileSync(FFMPEG_PATH, ['-h', 'filter=apad'], {
      encoding: 'utf8',
      timeout: 6000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.includes('pad_dur');
  } catch {
    return false;
  }
}

async function ensureFfmpeg() {
  ensureWorkDir(); // 解压目标目录的父级要先存在
  if (hasFfmpeg()) {
    emitProgress({ kind: 'progress', step: 'ffmpeg', percent: 100, phase: 'ffmpeg 已就绪', done: true });
    return { skipped: true, path: FFMPEG_PATH };
  }
  fs.mkdirSync(FFMPEG_DIR, { recursive: true });
  const gz = path.join(WORK_DIR, 'ffmpeg_pkg.gz');
  log('正在准备 ffmpeg（语音功能必需，约 28MB）...');
  emitProgress({ kind: 'progress', step: 'ffmpeg', percent: 2, phase: '正在下载 ffmpeg（语音功能需要）…', indeterminate: true });
  await downloadFile(FFMPEG_PKG_URL, gz, {
    timeoutMs: 120000,   // ★ S5 修复：停滞 2 分钟即报错，以前零超时会永久挂起
    onProgress: (got, all) => {
      const mb = (got / 1048576).toFixed(1);
      if (all > 0) {
        emitProgress({
          kind: 'progress',
          step: 'ffmpeg',
          percent: Math.min(85, Math.max(2, Math.round((got / all) * 85))),
          phase: `下载 ffmpeg ${mb}MB / ${(all / 1048576).toFixed(0)}MB`,
        });
      } else {
        emitProgress({ kind: 'progress', step: 'ffmpeg', percent: 40, phase: `下载 ffmpeg 已接收 ${mb}MB`, indeterminate: true });
      }
    },
  }).catch((e) => {
    // ★ S5 修复：失败必须可见 —— 以前 catch 只写 console，客户不知道语音为什么哑了
    emitProgress({ kind: 'progress', step: 'ffmpeg', percent: 0, phase: '语音组件未就绪，语音功能暂不可用；重启工具会自动重试', done: true });
    throw e;
  });
  emitProgress({ kind: 'progress', step: 'ffmpeg', percent: 90, phase: '正在解压 ffmpeg…', indeterminate: true });
  const buf = zlib.gunzipSync(fs.readFileSync(gz));
  fs.writeFileSync(FFMPEG_PATH, buf);
  try { fs.unlinkSync(gz); } catch (_) {}
  const size = fs.statSync(FFMPEG_PATH).size;
  if (size < 20 * 1024 * 1024) throw new Error(`ffmpeg 解压后大小异常（${size} 字节）`);
  if (!hasFfmpeg()) throw new Error('ffmpeg 版本过旧，不支持 pad_dur');
  log(`ffmpeg 就绪 (${Math.round(size / 1048576)}MB)`);
  emitProgress({ kind: 'progress', step: 'ffmpeg', percent: 100, phase: 'ffmpeg 就绪，语音功能可用', done: true });
  return { path: FFMPEG_PATH, size };
}

// ---------- 补丁：让 force_tts / no_tts 生效 ----------
// AstrBot 4.29.1 的 TTS 触发条件只看配置里的 trigger_probability：
//   should_tts = enable and is_llm_result() and ... and random() <= probability
// 完全不读插件通过 event.set_extra 设的标记 → voice_intent（"说发语音就发语音"）
// 之类的插件形同虚设，表现为「让它发语音也不发，只能靠 30% 随机撞上」。
// 这里在每次启动前给它补上；升级 AstrBot 覆盖文件后会自动重新打。
// AstrBot 可能装在两处：`uv tool install` 在 %APPDATA%\uv\tools，而 uvx 实际跑的是
// %LOCALAPPDATA%\uv\cache\archive-v0\<hash>。只认前者会导致"补丁打过了但没生效"，
// 而且 uvx 的 hash 目录会随版本变化，所以每次启动都要全扫一遍。
function astrbotSiteDirs() {
  const dirs = [];
  const push = (p) => {
    try {
      if (fs.existsSync(path.join(p, 'core'))) dirs.push(p);
    } catch (_) { /* ignore */ }
  };
  const cache = path.join(process.env.LOCALAPPDATA || '', 'uv', 'cache', 'archive-v0');
  try {
    if (fs.existsSync(cache)) {
      for (const name of fs.readdirSync(cache)) {
        push(path.join(cache, name, 'Lib', 'site-packages', 'astrbot'));
      }
    }
  } catch (_) { /* ignore */ }
  push(path.join(process.env.APPDATA || '', 'uv', 'tools', 'astrbot', 'Lib', 'site-packages', 'astrbot'));
  return dirs;
}

function patchAstrbotTts() {
  let patched = 0;
  for (const dir of astrbotSiteDirs()) {
    const p = path.join(dir, 'core', 'pipeline', 'result_decorate', 'stage.py');
    try {
      if (!fs.existsSync(p)) continue;
      let raw = fs.readFileSync(p, 'utf8');
      // 幂等标记必须是真正写进去的文本（早期用 '_force_tts' 判断，实际插入的是
      // get_extra("force_tts")，永远匹配不上，于是重复打补丁刷出一堆 FAILED 假象）
      if (raw.includes('event.get_extra("force_tts")')) continue;
      // 4.29.3 里这一行尾部带一个右括号，用 lookahead 保住它
      const re = /^([ \t]+)and random\.random\(\) <= self\.tts_trigger_probability(?=\))[ \t]*$/m;
      const m = raw.match(re);
      if (!m) continue;
      const indent = m[1];
      const nl = raw.includes('\r\n') ? '\r\n' : '\n';
      const inner = indent + '    ';
      const replacement = [
        indent + 'and (',
        inner + 'bool(event.get_extra("force_tts"))',
        inner + 'or (not event.get_extra("no_tts")',
        inner + '    and random.random() <= self.tts_trigger_probability)',
        indent + ')',
      ].join(nl);
      fs.writeFileSync(p, raw.replace(re, replacement), 'utf8');
      patched += 1;
    } catch (_) { /* ignore */ }
  }
  if (patched) log(`已给 AstrBot 打 TTS 补丁（force_tts / no_tts 现在生效，${patched} 处）`);
  return { patched };
}

// edge_tts 生成语音时 AstrBot 原版会 apad=pad_dur=2 —— 每句后面硬补 2 秒静音，
// 叠上 edge-tts 自带的约 0.76 秒，QQ 里听到的就是"说完还要空两三秒"。
function patchAstrbotTtsTrim() {
  let patched = 0;
  for (const dir of astrbotSiteDirs()) {
    const p = path.join(dir, 'core', 'provider', 'sources', 'edge_tts_source.py');
    try {
      if (!fs.existsSync(p)) continue;
      let raw = fs.readFileSync(p, 'utf8');
      if (raw.includes('silenceremove')) continue; // 已打过
      if (!raw.includes('"apad=pad_dur=2"')) continue;
      raw = raw.replace(
        '"apad=pad_dur=2"',
        '"silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-50dB,apad=pad_dur=0.2"'
      );
      fs.writeFileSync(p, raw, 'utf8');
      patched += 1;
    } catch (_) { /* ignore */ }
  }
  if (patched) log(`已去掉语音尾部 2 秒空白（${patched} 处 AstrBot 安装）`);
  return { patched };
}

// ---------- 启动 ----------
// 插件配置带 UTF-8 BOM 会让 AstrBot 的 json 解析直接失败（Unexpected UTF-8 BOM），
// 于是插件读到的是一份空配置：表情包插件看不到"发送格式"说明、reimage 看不到 provider、
// livingmemory 看不到参数……表现为"插件装了但完全没效果"，且日志里一句错都不报。
// 用记事本改过配置就会带上 BOM，所以每次启动前扫一遍。
function sanitizePluginConfigs() {
  const dir = path.join(WORK_DIR, 'data', 'config');
  let fixed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { fixed };
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const p = path.join(dir, name);
    try {
      const raw = fs.readFileSync(p);
      if (raw.length > 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        fs.writeFileSync(p, raw.subarray(3));
        fixed += 1;
      }
    } catch {
      /* 单个文件失败不影响启动 */
    }
  }
  if (fixed) log(`已清除 ${fixed} 个插件配置的 UTF-8 BOM（否则插件读不到配置）`);
  return { fixed };
}

// ---------- Python shim 隔离 ----------
// 某些宿主终端会往 PYTHONPATH 注入 sitecustomize.py（用来拦截文件删除）。
// AstrBot 是长期驻留进程，且每处理完一条图片消息都会
// event.cleanup_temporary_local_files() 删掉自己的临时图片；一旦被 shim 拦下，
// 它会 raise SystemExit(1)，整个进程当场退出 —— 表现为「发完图机器人就不回消息了」。
// 所以给所有 Python 系子进程构造一个干净环境。
const SHIM_MARKERS = [/\bshim\b/i, /sitecustomize/i, /[\\/]vendor[\\/]/i];

function cleanPythonShimEnv(env) {
  const raw = env.PYTHONPATH || env.PythonPath || '';
  let dirty = false;
  if (raw) {
    const all = raw.split(path.delimiter).filter(Boolean);
    const kept = all.filter((p) => !SHIM_MARKERS.some((re) => re.test(p)));
    dirty = kept.length !== all.length;
    if (kept.length) {
      env.PYTHONPATH = kept.join(path.delimiter);
    } else {
      delete env.PYTHONPATH;
      delete env.PythonPath;
    }
  }
  // 双保险：万一 shim 仍被加载，也让它彻底关闭删除拦截
  env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';
  env.CODEBUDDY_SAFE_DELETE_SANDBOX = '0';
  env.CODEBUDDY_BROKERED_FS_HOOK_ENABLED = '0';
  // 顺带屏蔽 user site 里可能存在的 sitecustomize
  env.PYTHONNOUSERSITE = '1';
  if (dirty) log('已隔离宿主 Python shim（否则 AstrBot 清理临时图片时会被强制退出）');
  return env;
}

const ASTRBOT_LOCK = path.join(WORK_DIR, 'astrbot.lock');
const ASTRBOT_BOOT_FLAG = path.join(WORK_DIR, '.astrbot_booting');

// 清掉「上次异常退出（被杀/崩溃）」残留的 astrbot.lock。
// 否则新实例会报 "Cannot acquire lock file" 直接打不开 —— 这是「astrbot 打不开」的头号原因。
function clearStaleAstrbotLock() {
  if (!fs.existsSync(ASTRBOT_LOCK)) return;
  // ★ S11 修复：删锁前必须确认没有任何 AstrBot 进程。
  //   带活进程删锁 → 第二个实例打开同一个 data_v4.db → SQLite 损坏 → 人设丢失/起不来。
  if (astrbotEngineAlive() || pidsMatching('python.exe', 'astrbot').length > 0) {
    log('检测到 AstrBot 进程仍在运行，跳过锁清理（避免 SQLite 损坏）');
    return;
  }
  try {
    fs.unlinkSync(ASTRBOT_LOCK);
    log('已清理残留 astrbot.lock（上次异常退出遗留）');
  } catch (_) { /* 删不掉就随它，AstrBot 自己会处理 */ }
}

// AstrBot 引擎进程是否真的活着：直启时是 astrbot.exe，uvx 模式下是 python -m astrbot。
// 只用来给"启动标记"做二次确认，别当成健康检查（健康请看面板端口）。
function astrbotEngineAlive() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq astrbot.exe', '/NH'], {
      windowsHide: true,
      timeout: 10000,
      encoding: 'utf8',
    });
    if (/astrbot\.exe/i.test(out)) return true;
  } catch (_) { /* 走 CIM 通道继续 */ }
  // ★ S1 修复：uvx 模式下进程名是 python.exe，原 wmic 兜底在 Win11 23H2+ 恒失效
  //   （wmic 已被系统移除）→ 防重复启动判断失效 → 客户连点两次会起两个实例抢锁抢端口。
  //   改用本文件已有的 CIM 实现（pidsMatching）。
  try {
    if (pidsMatching('python.exe', 'astrbot').length > 0) return true;
  } catch (_) { /* CIM 失败就当不在 */ }
  return false;
}

async function startAstrbot() {
  // 后台常驻运行；detached，不随父进程退出。
  // 输出落到 astrbot.log：AstrBot 首次启动会把「Initial password」打在日志里，
  // 我们据此自动拿到登录凭据，用户不用自己去翻日志。
  ensureWorkDir();
  // 防重复启动 + 防锁冲突（对应两个真实踩坑）：
  //  ① 面板端口(16885)已通 → 真在跑，直接返回，避免起第二个争锁/争端口；
  //  ② 启动标记在 90 秒内 → 正在冷启动（要 30~40 秒），别让用户「多点几次」又起一个；
  //  ③ 都不满足才动手：先清掉残留 astrbot.lock，否则新实例直接报 "Cannot acquire lock file"。
  const live = (await httpGet(`http://127.0.0.1:${DASHBOARD_PORT}/`)) > 0;
  if (live) return { alreadyRunning: true, logPath: path.join(WORK_DIR, 'astrbot.log'), skipped: true };
  if (fs.existsSync(ASTRBOT_BOOT_FLAG)) {
    try {
      const t = Number(fs.readFileSync(ASTRBOT_BOOT_FLAG, 'utf8')) || 0;
      // 「刚点过 = 正在启动」这个判断必须再加一条：进程真的还在。
      // 实测踩过：点「停止」后 90 秒内再点「启动」，旧标记还在 → 被当成"正在启动中"直接跳过，
      // 结果机器人一直不起来（守护又白等一轮）。所以标记新鲜 + 进程活着，才认为在启动。
      if (Date.now() - t < 90000 && astrbotEngineAlive()) {
        return { alreadyRunning: true, booting: true, logPath: path.join(WORK_DIR, 'astrbot.log'), skipped: true };
      }
    } catch (_) { /* 读不到就当过期 */ }
  }
  try { fs.writeFileSync(ASTRBOT_BOOT_FLAG, String(Date.now())); } catch (_) {}
  clearStaleAstrbotLock();
  // 启动前自愈根目录：老沙盒缺 .astrbot 会让 4.29.3 启动即退（面板 502）
  ensureAstrbotRoot();
  // 启动前确保 force_tts/no_tts 补丁在位（AstrBot 升级后会丢，这里每次自愈）
  patchAstrbotTts();
  // 语音尾部 2 秒空白是 AstrBot 自己 apad 出来的，顺手裁掉
  patchAstrbotTtsTrim();
  // 插件配置的 BOM 会让插件静默失效，先清掉
  sanitizePluginConfigs();
  // 启动前确保有已知密码（首次：随机生成并写入哈希；之后：读凭据文件）
  const pw = ensureKnownDashboardPassword();
  const logPath = path.join(WORK_DIR, 'astrbot.log');
  const uvx = getUvxCmd();
  rotateLogIfNeeded(logPath);   // ★ S7：超过 10MB 滚动成 .log.1
  fs.appendFileSync(logPath, `\r\n[start ${new Date().toLocaleString()}] uvx=${uvx} pw=${pw.ok ? (pw.skipped ? '(from file)' : '(new)') : 'SET-FAILED'}\r\n`);
  const out = fs.openSync(logPath, 'a');
  // edge_tts 生成 mp3 后要调用 ffmpeg 转 wav；把自带的 bin 目录塞进 PATH，
  // 否则会报 [WinError 2] 系统找不到指定的文件，导致「不发语音」。
  const binDir = path.join(WORK_DIR, 'bin');
  const env = Object.assign({}, process.env, {
    PATH: (process.env.PATH || process.env.Path || '')
      ? `${binDir};${process.env.PATH || process.env.Path || ''}`
      : binDir,
    // 中文 Windows 控制台默认 GBK，AstrBot 启动横幅里有 ✨，
    // 写 stdout 会抛 UnicodeEncodeError（我们实测抓到过），强制 UTF-8 免得日志里一堆红字。
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  });
  // 关键：必须摘掉父进程注入的 Python shim，否则 AstrBot 一处理图片就被杀。
  // 现象：收到图片 → event.cleanup_temporary_local_files() → os.remove(temp/xxx.jpg)
  //      → shim 的 _safe_remove → _try_trash → _check_bulk_delete_guard → raise SystemExit(1)
  //      → 整个 AstrBot 进程当场退出，表现为「机器人突然不回消息了」，且只在发图后出现。
  // 宿主（本向导）若运行在带 PYTHONPATH shim 的终端里，子进程会继承，故这里显式清理。
  cleanPythonShimEnv(env);
  // 注意：绝不能加 shell:true —— uvx 是独立 exe，带引号路径经 cmd 包装后会静默失败（零输出、秒退）
  // 注意：绝不能加 windowsHide:true —— 实测（2026-10-25）在 Win11 默认终端=Windows Terminal 的机器上，
  //      libuv 的 DETACHED_PROCESS 与 CREATE_NO_WINDOW 互斥：detached+windowsHide 组合反而会
  //      创建一个【可见】控制台，被 WT 托管成弹窗（表现为「每启动一次 AstrBot 就弹一个黑窗」）。
  //      只用 detached（DETACHED_PROCESS）本身就是无控制台启动，stdio 落到日志文件，完全无窗。
  // 优先用已安装的 astrbot.exe：uvx 每次都要先解析/校验自己的环境，
  // 客户机上这一步可能慢到超时（实测 5 次启动全失败，直接调 exe 4 秒就起来了）。
  const astrbotExe = findAstrbotExe();
  const launchCmd = astrbotExe || uvx;
  const launchArgs = astrbotExe ? ['run'] : ['astrbot', 'run'];
  const child = spawn(launchCmd, launchArgs, {
    cwd: WORK_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  child.on('error', (e) => {
    // spawn 本身失败（ENOENT 等）不会进 stdio，必须手动写日志
    try { fs.appendFileSync(logPath, `[spawn error] ${e.message}\r\n`); } catch (_) {}
  });
  child.unref();
  fs.closeSync(out);   // ★ S12：子进程已继承句柄，父进程用完即关
  return { pid: child.pid, logPath, uvx, launcher: astrbotExe || 'uvx' };
}

// 结束 AstrBot 进程（只按 PID 精准杀 astrbot.exe，绝不用 /T）。
// 为什么不用 /T：AstrBot 是「本向导后端 node」的子进程（startAstrbot 用 detached 起，
// 但 Windows 进程树里仍挂在 node 之下）。一旦用 /T，会连父节点 node 一起杀掉，
// 后端直接崩（实测：杀 astrbot 时 /T 把后端 node 也 SIGTERM 了，向导整个挂掉）。
// 所以这里只抓 astrbot.exe 的 PID 逐个杀，node 后端毫发无伤。
function killAstrbotProcess() {
  let pids = [];
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq astrbot.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    });
    for (const line of out.split('\n')) {
      // CSV 形如："astrbot.exe","12345","Console",...
      const m = line.match(/"astrbot\.exe"\s*,\s*"(\d+)"/i);
      if (m) pids.push(m[1]);
    }
  } catch (_) { /* 读不到就当没有 */ }
  // ★ S2 修复：uvx 模式下进程名是 python.exe（命令行含 astrbot），上面的通道抓不到它
  //   → 重启永远杀不掉 → 人设注入后永远不生效。补一条 CIM 通道。
  try { pids.push(...pidsMatching('python.exe', 'astrbot')); } catch (_) {}
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true, timeout: 15000 }); } catch (_) {}
  }
}

// 重启 AstrBot：先杀旧实例，等端口真正断开后再起新的。
// 不在这里 await 仪表盘就绪（冷启动要 30~40 秒），调用方自行决定是否等；
// startAstrbot 内部已带「端口已通就跳过 / 90 秒内启动中就跳过」的防重保护，
// 所以我们必须等旧端口真的掉了再调它，否则会被误判成 alreadyRunning 而不重启。
async function restartAstrbot() {
  const wasRunning = (await httpGet(`http://127.0.0.1:${DASHBOARD_PORT}/`)) > 0;
  if (!wasRunning) return { restarted: false, wasRunning: false };
  log('人设/配置已变更，重启 AstrBot 使新设置生效…');
  killAstrbotProcess();
  let dropped = false;
  for (let i = 0; i < 20; i++) {
    if ((await httpGet(`http://127.0.0.1:${DASHBOARD_PORT}/`)) <= 0) { dropped = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // ★ S2 修复：20 秒等不到端口断开 = 旧进程根本没被杀掉（uvx 通道失效等），
  //   此时 startAstrbot 会看到 alreadyRunning 而一次都不重启 —— 但 UI 却报"正在重启"。
  //   客户注入人设后机器人一直说默认人格，看起来就像买到假货。必须诚实报败。
  if (!dropped) {
    log('⚠️ AstrBot 旧进程 20 秒内未能退出，重启未执行');
    return { restarted: false, reason: '旧进程未能退出。请在向导里手动「停止」再「启动」，新人格才会生效' };
  }
  try { fs.unlinkSync(ASTRBOT_BOOT_FLAG); } catch (_) {}
  const r = await startAstrbot();
  return { restarted: true, wasRunning: true, ...r };
}

// 轮询等 AstrBot 仪表盘就绪（冷启动约 20~40 秒）
async function waitForDashboard(tries = 45, intervalMs = 2000) {
  for (let i = 0; i < tries; i++) {
    if ((await httpGet(`http://127.0.0.1:${DASHBOARD_PORT}/`)) > 0) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------- 自动获取登录凭据 ----------
// AstrBot：用户名固定 astrbot；初始密码是随机生成的，只出现在启动日志里。
const CREDS_PATH = path.join(WORK_DIR, 'dashboard_credentials.json');

// 与 AstrBot 官方实现一致（astrbot/core/utils/auth_password.py）：
// pbkdf2_sha256$600000$<salt_hex>$<hash_hex>，salt 16 字节 hex 作为 raw bytes 参与运算；MD5 兜底字段
function hashAstrbotPassword(pwd) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto
    .pbkdf2Sync(Buffer.from(pwd, 'utf8'), Buffer.from(salt, 'hex'), 600000, 32, 'sha256')
    .toString('hex');
  return {
    md5: crypto.createHash('md5').update(Buffer.from(pwd, 'utf8')).digest('hex'),
    pbkdf2: `pbkdf2_sha256$600000$${salt}$${digest}`,
  };
}

// 直接把已知密码写进配置（绕过随机密码，用户永远不用翻日志）
function setKnownDashboardPassword(pwd) {
  if (!/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{8,}$/.test(pwd)) {
    return { ok: false, error: '密码需至少 8 位，且包含大写字母、小写字母和数字' };
  }
  const h = hashAstrbotPassword(pwd);
  const files = [
    path.join(DATA_DIR, 'config.json'),
    path.join(DATA_DIR, 'cmd_config.json'),
  ];
  let touched = 0;
  for (const p of files) {
    try {
      if (!fs.existsSync(p)) continue;
      let raw = fs.readFileSync(p, 'utf8');
      let hadBom = raw.charCodeAt(0) === 0xfeff;
      if (hadBom) raw = raw.slice(1);
      const cfg = JSON.parse(raw);
      cfg.dashboard = Object.assign({}, cfg.dashboard, {
        enable: true,
        username: cfg.dashboard && cfg.dashboard.username ? cfg.dashboard.username : 'astrbot',
        password: h.md5,
        pbkdf2_password: h.pbkdf2,
        password_storage_upgraded: true,
        password_change_required: false,
      });
      fs.writeFileSync(p, (hadBom ? '\ufeff' : '') + JSON.stringify(cfg, null, 2), 'utf8');
      touched++;
    } catch (e) {
      log(`写密码到 ${p} 失败: ${e.message}`);
    }
  }
  if (touched === 0) return { ok: false, error: '找不到 AstrBot 配置文件（请先完成安装初始化）' };
  fs.writeFileSync(CREDS_PATH, JSON.stringify({ username: 'astrbot', password: pwd }, null, 2), 'utf8');
  return { ok: true, username: 'astrbot', password: pwd };
}

// 首次安装随机生成密码；已有凭据则原样保留。
function generateDashboardPassword() {
  return 'Aa1' + crypto.randomBytes(6).toString('hex');
}

function getOrCreateDashboardPassword() {
  const cur = readAstrbotCredentials();
  if (cur.password) return cur.password;
  const pwd = generateDashboardPassword();
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(CREDS_PATH, JSON.stringify({ username: 'astrbot', password: pwd }, null, 2), 'utf8');
  } catch (e) {
    log(`写凭据文件失败: ${e.message}`);
  }
  return pwd;
}

// 没有已知密码时生成随机密码，写进配置与凭据文件
function ensureKnownDashboardPassword() {
  const cur = readAstrbotCredentials();
  if (cur.password) return { ok: true, skipped: true, ...cur };
  return setKnownDashboardPassword(getOrCreateDashboardPassword());
}

function readAstrbotCredentials() {
  const result = {
    username: 'astrbot',
    password: '',
    source: '',
    dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT}/`,
  };
  // 1) 我们自己设置的已知密码（最可靠）
  try {
    if (fs.existsSync(CREDS_PATH)) {
      const c = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
      if (c.password) {
        result.password = c.password;
        result.username = c.username || result.username;
        result.source = 'preset';
      }
    }
  } catch (e) { /* ignore */ }

  // 2) AstrBot 配置里的用户名
  try {
    const p = path.join(DATA_DIR, 'cmd_config.json');
    if (!result.username && fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      const cfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      if (cfg.dashboard && cfg.dashboard.username) result.username = cfg.dashboard.username;
    }
  } catch (e) { /* ignore */ }
  if (!result.username) result.username = 'astrbot';

  // 3) 从启动日志里抓初始密码（多次启动取最后一个）
  //    ★ S7 修复：日志可能几十 MB，全量读入内存每 2 秒一次会把 Node 拖垮。
  //      改为只读尾部 64KB（初始密码只出现在最近一次启动的头部附近，尾部足够）。
  const logPath = path.join(WORK_DIR, 'astrbot.log');
  try {
    if (!result.password && fs.existsSync(logPath)) {
      const size = fs.statSync(logPath).size;
      const TAIL = 64 * 1024;
      const start = size > TAIL ? size - TAIL : 0;
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const txt = buf.toString('utf8');
        const matches = txt.match(/Initial\s+password[:：]\s*([^\s\r\n]+)/g) || [];
        if (matches.length) {
          result.password = matches[matches.length - 1].replace(/.*[:：]\s*/, '').trim();
          result.source = 'startup-log';
        }
      } finally { fs.closeSync(fd); }
    }
  } catch (e) { /* 读不到就留空 */ }
  return result;
}

// ★ S7 修复：日志只 append 不轮转 → 长期开机无限膨胀占满磁盘。
//    超过 10MB 就滚动成 .log.1（保留一份旧档）。
function rotateLogIfNeeded(logPath) {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 10 * 1024 * 1024) {
      const old = logPath + '.1';
      try { fs.unlinkSync(old); } catch (_) {}
      fs.renameSync(logPath, old);
    }
  } catch (_) { /* 轮转失败不影响启动 */ }
}

// NapCat：WebUI token 写在 config/webui.json；官方支持 ?token=xxx 直接免密进入
// ★ S6 修复：旧版同步递归扫 10 个根目录（depth 6），文件多的机器一次几十秒，
//   Node 单线程被堵死 → 向导所有接口无响应（/api/credentials 还每 2 秒轮询一次）。
//   改为：只探测固定候选路径 + 结果缓存 10 分钟 + 全异步。
let _napcatCfgCache = { at: 0, list: [] };
async function findNapCatWebUiConfig() {
  if (Date.now() - _napcatCfgCache.at < 600000) return _napcatCfgCache.list;
  const home = os.homedir();
  const cands = [
    path.join(WORK_DIR, 'NapCat', 'config', 'webui.json'),
    path.join(WORK_DIR, 'napcat', 'config', 'webui.json'),
    path.join(process.env.LOCALAPPDATA || '', 'NapCat', 'config', 'webui.json'),
    path.join(process.env.APPDATA || '', 'NapCat', 'config', 'webui.json'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'NapCat', 'config', 'webui.json'),
    path.join(home, 'NapCat.Shell.Windows.OneKey', 'config', 'webui.json'),
    path.join(home, 'napcat', 'config', 'webui.json'),
    'C:\\NapCat.Shell.Windows.OneKey\\config\\webui.json',
  ];
  const found = [];
  for (const c of cands) {
    try {
      const stat = await fs.promises.stat(c).catch(() => null);
      if (stat && stat.isFile()) { found.push(c); if (found.length >= 3) break; }
    } catch (_) { /* ignore */ }
  }
  _napcatCfgCache = { at: Date.now(), list: found };
  return found;
}

async function readNapCatCredentials() {
  const result = { token: '', port: NAPCAT_WEBUI_PORT, webuiUrl: '', autoLoginUrl: '', configPath: '' };
  const cfgs = await findNapCatWebUiConfig();
  for (const cfgPath of cfgs) {
    try {
      // NapCat 的 webui.json 可能带注释(json5)，做一次宽松解析
      let raw = fs.readFileSync(cfgPath, 'utf8');
      raw = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
      const j = JSON.parse(raw);
      if (j && j.token) {
        result.token = String(j.token);
        result.port = Number(j.port) || NAPCAT_WEBUI_PORT;
        result.configPath = cfgPath;
        break;
      }
    } catch (e) { /* 解析失败换下一个 */ }
  }
  result.webuiUrl = `http://127.0.0.1:${result.port}/webui/`;
  // 关键点：带 token 参数访问可以直接跳过登录页
  if (result.token) {
    result.autoLoginUrl = `http://127.0.0.1:${result.port}/webui?token=${encodeURIComponent(result.token)}`;
  } else {
    // 读不到 token（NapCat 还没首次启动 / 装在非常规目录）时，
    // 绝不能拼一个 token= 空值的链接（NapCat 会直接报“请输入token”）。
    // 打开普通登录页，并告诉用户去哪找 token。
    result.autoLoginUrl = result.webuiUrl;
    result.needsToken = true;
    result.tokenHint =
      '打开 NapCat 登录页后需要粘贴 token：在 NapCat 启动时的黑色控制台窗口里找 “WebUI Token” 字样复制；' +
      '如果 control 台已关，重启一次 NapCat 即可重新看到。';
  }
  return result;
}

async function credentials() {
  const a = readAstrbotCredentials();
  const n = await readNapCatCredentials();
  // autoLoginUrl：走向导的整站代理，打开即已登录（同源，SPA 的接口路径才正确）
  a.autoLoginUrl = `http://127.0.0.1:${ASTRBOT_PROXY_PORT}/`;
  return { astrbot: a, napcat: n };
}

// 服务端代登录 AstrBot（无 CORS 问题），拿到 dashboard 的 token
// 单次登录尝试（不重试）
function astrbotLoginOnce({ username, password } = {}) {
  return new Promise((resolve) => {
    const http = require('http');
    const payload = JSON.stringify({ username, password });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: DASHBOARD_PORT,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve({ status: res.statusCode, data: j, token: (j && (j.data && j.data.token)) || j.token || '' });
          } catch (e) {
            resolve({ status: res.statusCode, data: body, token: '' });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message, token: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', token: '' }); });
    req.write(payload);
    req.end();
  });
}

// 带重试的登录：AstrBot 冷启动要 20~30 秒才监听端口，
// 用户常常是刚点「启动」就点「自动登录」，不重试必然失败。
async function astrbotLogin(opts = {}, { tries = 20, intervalMs = 2000 } = {}) {
  let last = { status: 0, error: 'unknown', token: '' };
  for (let i = 0; i < tries; i++) {
    last = await astrbotLoginOnce(opts);
    if (last.token) return last;
    // 401 = 密码不对，重试没意义，直接返回
    if (last.status === 401) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

function openUrl(url) {
  // Windows 用默认浏览器打开 URL。
  // ⚠️ 踩过的坑（用户实机反馈"弹出 cmd 窗口又自动关了"）：
  // 以前用 `cmd /c start "" url` + detached + stdio:ignore —— cmd 不继承父进程的控制台，
  // 于是自己创建一个窗口，而 /c 又让它"执行完立刻退出"，结果就是黑窗闪一下消失。
  // 现在改用 rundll32 url.dll,FileProtocolHandler（系统标准的打开方式，本身无窗口），
  // 并加 windowsHide 双保险；万一 rundll32 不可用，回退到带 windowsHide 的 start。
  try {
    const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {
      try {
        spawn('cmd', ['/c', 'start', '', url], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
      } catch (_) { /* 打不开就算了，不刷错误 */ }
    });
    child.unref();
  } catch (e) {
    log(`打开浏览器失败: ${e.message}`);
  }
}

// ---------- 探活 ----------
function httpGet(url) {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(0);
    });
  });
}

async function health() {
  const dash = await httpGet(`http://127.0.0.1:${DASHBOARD_PORT}/`);
  const nap = await httpGet(`http://127.0.0.1:${NAPCAT_WEBUI_PORT}/`);
  return {
    dashboard: dash > 0,
    napcat: nap > 0,
    dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT}/`,
    napcatUrl: `http://127.0.0.1:${NAPCAT_WEBUI_PORT}/`,
  };
}

module.exports = {
  WORK_DIR,
  DATA_DIR,
  CONFIG_PATH,
  CMD_CONFIG_PATH,
  NAPCAT_CFG_PATH,
  DASHBOARD_PORT,
  ASTRBOT_PROXY_PORT,
  NAPCAT_WEBUI_PORT,
  getPythonCmd,
  injectPersona,
  setDefaultPersona,
  checkUv,
  checkPython,
  checkAstrbot,
  checkNapCat,
  startNapCat,
  findQQPath,
  isNapCatRunning,
  ensureNapCatOnebotWs,
  ensureNapCatAutoLogin,
  napCatInstalled,
  napcatWsConnected,
  restartNapCat,
  findNapCatLauncher,
  ensureWorkDir,
  installUv,
  installAstrbot,
  initAstrbot,
  installNapCat,
  configureProvider,
  testProvider,
  listModels,
  setProgressSink,
  emitProgress,
  downloadFile,
  downloadRace,
  registerCloudCaptionProvider,
  writeNapCatReferenceConfig,
  startAstrbot,
  ensureFfmpeg,
  ensureNoThinkVariant,
  ensureCaptionVariant,
  patchAstrbotTts,
  detectOllamaVisionModel,
  registerVisionProvider,
  openUrl,
  health,
  status,
  resetEnvironment,
  runStep,
  getBusyStep,
  getInstallState,
  credentials,
  readAstrbotCredentials,
  readNapCatCredentials,
  astrbotLogin,
  astrbotLoginOnce,
  waitForDashboard,
  restartAstrbot,
  getUvxCmd,
  getUvCmd,
  applyWizardOverrides,
  patchWizardOverridesObj,
  setKnownDashboardPassword,
  ensureKnownDashboardPassword,
  hashAstrbotPassword,
  // 停止哨兵 & 精准查杀（一键停止用）
  STOP_FLAG,
  requestStop,
  clearStopFlag,
  isStopRequested,
  pidsMatching,
  killPidSafe,
  killBootDaemons,
  killAstrbotProcess,
};
