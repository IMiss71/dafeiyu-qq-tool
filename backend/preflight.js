// preflight.js
// 「别人电脑上为什么会跑不起来」的统一体检口。
//
// 背景：本工具在开发机上跑通 ≠ 在用户机器上跑通。真实差异常见的有：
//   · 磁盘只剩几百 MB（AstrBot + Python + 依赖约 2GB）
//   · 用户名是中文 → LOCALAPPDATA 含中文 → 个别包安装/解压路径出问题
//   · 端口 16885 / 18666 / 6099 被别的软件先占（另一套 AstrBot、代理工具…）
//   · 杀软把 tools\node.exe、NapCat 注入器当可疑程序隔离 → 双击没反应
//   · 公司网络/代理导致下载 uv 或依赖包一直失败
//   · 系统太老（Win10 1809 以下）或 32 位
// 这些都不是"代码 bug"，但用户只会看到"点了没反应/装不上"。
// 所以一次性体检出来、给出可执行的解决办法，比事后猜要省事得多。
//
// 设计原则：
//   ① 全部并发 + 单项超时（体检本身绝不能卡住向导）
//   ② 级别只有三档：ok(正常) / warn(能用但有风险或会缺功能) / block(必然失败，必须先处理)
//   ③ 每项都带 fix：一句人话的解决办法，直接给前端展示
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execP = promisify(exec);
const d = require('./deploy');

const WIZARD_PORT = 18765;
// 需要独占的端口：占了会导致面板白屏 / 打不开 / 启动即退
const CRITICAL_PORTS = [
  { port: 16885, name: 'AstrBot 面板' },
  { port: 18666, name: '面板免登录代理' },
  { port: 6099, name: 'NapCat 网页面板' },
];

// PowerShell 取值：统一走 -EncodedCommand，避开 cmd 转义地狱（deploy.js 同理）
async function psJson(script, timeoutMs = 15000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execP(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 8,
    });
    const s = stdout.trim();
    if (!s) return null;
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// 单项超时保护：任何一项卡住都不拖垮整体体检
function withTimeout(p, ms, fallback) {
  let t = null;
  return Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((r) => {
      t = setTimeout(() => r(fallback), ms);
    }),
  ]).finally(() => t && clearTimeout(t));
}

// 端口是否空闲。
// 注意：不能用「自己试着 listen」来判断 —— Node 在 Windows 上默认带 SO_REUSEADDR，
// 绑一个已经被别人监听的端口照样成功（实测踩过：明明被占，listen 却毫无反应），
// 于是既检测不出占用，两个服务还会抢同一个端口、请求随机分给其中一个。
// 可靠做法是直接连一下：连得上 = 有人在用；ECONNREFUSED = 空闲。
function probePort(port) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.createConnection({ host: '127.0.0.1', port });
    const finish = (r) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (_) {}
      resolve(r);
    };
    s.once('connect', () => finish({ free: false, code: 'IN_USE' }));
    s.once('error', (e) => finish({ free: e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET', code: e.code || '' }));
    setTimeout(() => finish({ free: true, code: 'probe-timeout' }), 1500);
  });
}

// 谁占了端口（进程名 + PID），用于"一键结束占用进程"
async function whoOwnsPort(port) {
  const r = await psJson(
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue
$out = @()
foreach ($x in $c) {
  $p = Get-Process -Id $x.OwningProcess -ErrorAction SilentlyContinue
  $out += @{ pid = $x.OwningProcess; name = $(if ($p) { $p.ProcessName } else { 'unknown' }) }
}
$out | ConvertTo-Json -Compress`,
    10000
  );
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

function freeBytes(dir) {
  // 全新机器第一次体检时数据目录还没建，fs.statfsSync 会直接抛错；
  // 这时如果返回 -1，磁盘项会被判成 block，用户就会卡在第 ① 步什么也做不了。
  // 所以逐级向上退到确实存在的祖先目录再量，最后退到进程当前目录。
  let p = dir;
  for (let i = 0; i < 8; i++) {
    try {
      const st = fs.statfsSync(p);
      return st.bavail * st.bsize;
    } catch (_) {
      const parent = path.dirname(p);
      if (!parent || parent === p) break;
      p = parent;
    }
  }
  try {
    const st = fs.statfsSync(process.cwd());
    return st.bavail * st.bsize;
  } catch (_) {
    return -1;
  }
}

function isAscii(p) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(p || '');
}

async function httpProbe(url, timeoutMs = 7000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    return { ok: res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// ---------- 各体检项 ----------

async function checkSystem() {
  const build = parseInt(String(os.release()).split('.')[2] || '0', 10);
  const arch = os.arch();
  const mem = os.totalmem();
  const items = [];

  items.push({
    id: 'os',
    title: 'Windows 版本',
    level: build >= 17763 ? 'ok' : 'block',
    detail: `Windows build ${build}（${arch}）`,
    fix:
      build >= 17763
        ? ''
        : '系统太老（需 Windows 10 1809 / build 17763 以上）。请升级系统后再用。',
  });

  items.push({
    id: 'arch',
    title: '系统架构',
    level: arch === 'x64' ? 'ok' : arch === 'arm64' ? 'warn' : 'block',
    detail: arch,
    fix:
      arch === 'x64'
        ? ''
        : arch === 'arm64'
        ? 'ARM 设备（骁龙本等）：AstrBot 多数依赖有 wheel 可用，但个别包可能要本地编译，安装耗时会明显变长。'
        : '仅支持 64 位 Windows，32 位系统无法运行。',
  });

  const memGB = mem / 1024 / 1024 / 1024;
  items.push({
    id: 'memory',
    title: '物理内存',
    level: memGB >= 8 ? 'ok' : memGB >= 4 ? 'warn' : 'block',
    detail: `${memGB.toFixed(1)} GB`,
    fix:
      memGB >= 8
        ? ''
        : memGB >= 4
        ? '内存偏小：跑云端模型没问题，但不要选 Ollama 本地模型（本地模型至少 8GB 才勉强能用）。'
        : '内存不足 4GB，无法运行。',
  });

  return items;
}

async function checkDisk() {
  const workDir = d.WORK_DIR;
  const free = freeBytes(workDir);
  const gb = free / 1024 / 1024 / 1024;
  // 读不到磁盘信息时只提醒、不阻塞：这是体检项的误报高发区，
  // 挡住用户装不了远比"少提醒一句"严重。
  const level = gb < 0 ? 'warn' : gb >= 6 ? 'ok' : gb >= 2.5 ? 'warn' : 'block';
  return [
    {
      id: 'disk',
      title: '磁盘剩余空间',
      level,
      detail: gb >= 0 ? `${gb.toFixed(1)} GB 可用（数据目录：${workDir}）` : '暂时读不到磁盘信息（不影响安装）',
      fix:
        gb >= 6
          ? ''
          : gb < 0
          ? '请确认数据目录所在盘还有 2.5GB 以上空间。'
          : gb >= 2.5
          ? '空间偏紧：AstrBot + Python 运行时约 2GB，加上缓存建议留 6GB 以上。可清理回收站/临时文件。'
          : '空间不足（需 2.5GB 以上）。请清理磁盘，或换一个剩余空间足够的盘（设置环境变量 DAFEIYU_WORK_DIR 可改数据目录）。',
    },
  ];
}

// 中文用户名 / 中文解压路径：绝大多数环节没问题，但个别 Python 包与 NapCat 注入器在
// 非 ASCII 路径上会静默失败。提前告知，并给出改到英文路径的办法。
async function checkPathAscii() {
  const workDir = d.WORK_DIR;
  const selfDir = path.join(__dirname, '..');
  const bad = [];
  if (!isAscii(workDir)) bad.push(`数据目录：${workDir}`);
  if (!isAscii(selfDir)) bad.push(`工具目录：${selfDir}`);
  return [
    {
      id: 'pathAscii',
      title: '路径是否含中文/特殊字符',
      level: bad.length ? 'warn' : 'ok',
      detail: bad.length ? bad.join('；') : '数据目录与工具目录均为纯英文路径',
      fix: bad.length
        ? '含中文路径时极个别依赖或 NapCat 注入器会静默失败。解决办法：① 把本工具解压到纯英文路径（如 D:\\dafeiyu）；② 数据目录可用环境变量改到英文路径：set DAFEIYU_WORK_DIR=D:\\DaFeiYuData'
        : '',
    },
  ];
}

async function checkWritable() {
  const workDir = d.WORK_DIR;
  let ok = true;
  let err = '';
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const t = path.join(workDir, '.write_test.tmp');
    fs.writeFileSync(t, 'x');
    fs.unlinkSync(t);
  } catch (e) {
    ok = false;
    err = e.code || e.message;
  }
  return [
    {
      id: 'workdirWritable',
      title: '数据目录可写',
      level: ok ? 'ok' : 'block',
      detail: ok ? workDir : `写入失败：${err}`,
      fix: ok
        ? ''
        : '没有写入权限（常见于公司域控电脑 / 磁盘被策略锁定）。可用环境变量换目录：set DAFEIYU_WORK_DIR=D:\\DaFeiYuData',
    },
  ];
}

async function checkPorts() {
  const out = [];
  for (const { port, name } of CRITICAL_PORTS) {
    const r = await probePort(port);
    if (r.free) {
      out.push({ id: `port${port}`, title: `端口 ${port}（${name}）`, level: 'ok', detail: '空闲', fix: '' });
    } else {
      // 占用者是本工具自己（比如面板代理就是本进程起的）不算问题，
      // 否则用户一打开体检就看到"端口被占用"，其实那是它自己的服务。
      const owners = (await whoOwnsPort(port)).filter((o) => Number(o.pid) !== process.pid);
      if (!owners.length) {
        out.push({ id: `port${port}`, title: `端口 ${port}（${name}）`, level: 'ok', detail: '本工具自身正在使用', fix: '' });
        continue;
      }
      const who = owners.map((o) => `${o.name}(PID ${o.pid})`).join('、');
      out.push({
        id: `port${port}`,
        title: `端口 ${port}（${name}）`,
        level: 'warn',
        detail: `已被占用：${who}`,
        fix: `点右侧「释放端口」结束该进程后重试；若那是你自己正在用的另一套 AstrBot/NapCat，先退出它再用本工具。`,
        port,
      });
    }
  }
  // 向导自身端口（不是阻塞项：server.js 会自动换端口）
  const w = await probePort(WIZARD_PORT);
  if (!w.free) {
    out.push({
      id: 'portWizard',
      title: `端口 ${WIZARD_PORT}（向导页面）`,
      level: 'ok',
      detail: '被占用，向导会自动改用 18766~18775 中的空闲端口',
      fix: '',
    });
  }
  return out;
}

async function checkNetwork() {
  const [pypi, gh] = await Promise.all([
    withTimeout(httpProbe('https://pypi.org/simple/'), 9000, { ok: false, status: 0 }),
    withTimeout(httpProbe('https://github.com'), 9000, { ok: false, status: 0 }),
  ]);
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const items = [];
  items.push({
    id: 'netPypi',
    title: '能否访问 PyPI（安装依赖必需）',
    level: pypi.ok ? 'ok' : 'block',
    detail: pypi.ok ? `连通（HTTP ${pypi.status}）` : '连不上 pypi.org',
    fix: pypi.ok
      ? ''
      : '装 AstrBot 需要联网下载依赖。请检查网络/公司代理；若在代理环境下，先设置 HTTP_PROXY / HTTPS_PROXY 环境变量再启动本工具。',
  });
  items.push({
    id: 'netGithub',
    title: '能否访问 GitHub（下载 NapCat 用）',
    level: gh.ok ? 'ok' : 'warn',
    detail: gh.ok ? `连通（HTTP ${gh.status}）` : '连不上 github.com',
    fix: gh.ok
      ? ''
      : 'NapCat 从 GitHub 下载。连不上时可先手动下载 NapCat 压缩包放到工具目录的 vendor\\ 下，再设置 DAFEIYU_NAPCAT_OFFLINE=1 离线安装。',
  });
  if (proxy) {
    items.push({
      id: 'proxyEnv',
      title: '检测到系统代理环境变量',
      level: 'warn',
      detail: proxy,
      fix: '代理配置错误会让所有下载卡死。若安装过程长时间无进度，关掉代理重试。',
    });
  }
  return items;
}

// 杀软：不会让工具"不能用"，但会在最关键时刻（解压、注入、启动）静默拦截，
// 表现就是"双击没反应""装到一半消失"。提前提醒加白名单能省掉大量售后。
async function checkAntivirus() {
  const r = await psJson(
    `$o = @{ defender = $false; others = @() }
try { $m = Get-MpComputerStatus -ErrorAction Stop; $o.defender = [bool]$m.RealTimeProtectionEnabled } catch {}
try {
  $av = Get-CimInstance -Namespace root\\SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop
  foreach ($a in $av) { if ($a.displayName) { $o.others += $a.displayName } }
} catch {}
$o | ConvertTo-Json -Compress`,
    12000
  );
  // SecurityCenter2 常常把自带的 Defender 也报进来，那不算"第三方杀软"，
  // 混在一起会让提示文案说错（"360/火绒…"其实机器上一个都没装）。
  const others = ((r && r.others) || []).filter(
    (n) => n && !/windows defender|microsoft defender|defender antivirus/i.test(n)
  );
  const defender = !!(r && r.defender);
  const level = others.length ? 'warn' : 'ok';
  return [
    {
      id: 'antivirus',
      title: '杀毒软件 / 实时防护',
      level,
      detail: others.length
        ? `已装第三方杀软：${others.join('、')}${defender ? '；Windows Defender 实时防护：开' : ''}`
        : defender
        ? '仅 Windows Defender（实时防护开启）'
        : '未检测到杀软（或无法读取状态）',
      fix: others.length
        ? '360 / 火绒 / 腾讯管家等常把 tools\\node.exe、NapCat 注入器当可疑程序隔离，现象是"双击没反应""装到一半消失"。建议先把工具目录加入杀软白名单，再重新解压一次（已被隔离的文件不会自己回来）。'
        : defender
        ? '若出现"双击没反应""安装中途消失"，多为 Defender 拦截。把工具目录加入排除项即可：Windows 安全中心 → 病毒和威胁防护 → 管理设置 → 排除项。'
        : '',
    },
  ];
}

async function checkQq() {
  const items = [];
  let qq = '';
  try {
    qq = typeof d.findQQPath === 'function' ? d.findQQPath() : '';
  } catch (_) {}
  items.push({
    id: 'qq',
    title: 'QQ 是否已安装',
    level: qq ? 'ok' : 'warn',
    detail: qq || '未在注册表里找到 QQ',
    fix: qq
      ? ''
      : '第 ⑤ 步要用 NapCat 登录 QQ（需本机装了 QQ 桌面版）。现在还没装也不影响前面几步，装好 QQ 再回来即可。',
  });
  return items;
}

// 分发包完整性：zip 解压不全、杀软删了 node/python 时，必须先说清楚，
// 否则用户只会看到"黑窗口一闪而过"。
async function checkBundle() {
  const selfDir = path.join(__dirname, '..');
  const node = path.join(selfDir, 'tools', 'node.exe');
  const py = path.join(selfDir, 'tools', 'python', 'python.exe');
  const items = [];
  const nodeOk = fs.existsSync(node);
  const pyOk = fs.existsSync(py);
  items.push({
    id: 'bundleNode',
    title: '自带 Node.js（tools\\node.exe）',
    level: nodeOk ? 'ok' : 'block',
    detail: nodeOk ? '存在' : '缺失',
    fix: nodeOk
      ? ''
      : '分发包不完整（或被杀软隔离）。请重新解压完整 zip，并把目录加入杀软白名单。',
  });
  items.push({
    id: 'bundlePython',
    title: '自带便携 Python（tools\\python）',
    level: pyOk ? 'ok' : 'warn',
    detail: pyOk ? '存在' : '缺失（不影响安装 AstrBot，只影响"一键注入人设"，会自动回退到系统 Python / uv）',
    fix: pyOk ? '' : '若注入人设失败，可用管理员 PowerShell 执行 winget install Python.Python.3.11 补一个系统 Python。',
  });
  return items;
}

async function checkPowershell() {
  let ok = false;
  try {
    await execP('powershell -NoProfile -ExecutionPolicy Bypass -Command "exit 0"', { windowsHide: true, timeout: 10000 });
    ok = true;
  } catch (_) {}
  return [
    {
      id: 'powershell',
      title: 'PowerShell 可用（装 uv 依赖它）',
      level: ok ? 'ok' : 'block',
      detail: ok ? '可用' : '调用失败（可能被组策略禁用或不在 PATH）',
      fix: ok ? '' : '公司域控机器可能禁用了 PowerShell。请联系管理员放开，或改用已装好的 Python 手动部署。',
    },
  ];
}

// ---------- 汇总入口 ----------
async function run() {
  const groups = await Promise.all([
    withTimeout(checkSystem(), 12000, []),
    withTimeout(checkDisk(), 8000, []),
    withTimeout(checkPathAscii(), 3000, []),
    withTimeout(checkWritable(), 8000, []),
    withTimeout(checkPorts(), 25000, []),
    withTimeout(checkNetwork(), 20000, []),
    withTimeout(checkAntivirus(), 15000, []),
    withTimeout(checkQq(), 12000, []),
    withTimeout(checkBundle(), 5000, []),
    withTimeout(checkPowershell(), 12000, []),
  ]);
  const items = groups.flat().filter(Boolean);
  const summary = { block: 0, warn: 0, ok: 0 };
  for (const it of items) summary[it.level] = (summary[it.level] || 0) + 1;
  return {
    ok: summary.block === 0,
    items,
    summary,
    system: {
      os: `${os.release()} (${os.arch()})`,
      workDir: d.WORK_DIR,
      selfDir: path.join(__dirname, '..'),
      node: process.version,
      memGB: +(os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
    },
    generatedAt: new Date().toISOString(),
  };
}

// 一键释放端口：只结束占用该端口的进程，并做白名单保护（绝不误杀系统进程）
async function killPort(port) {
  const owners = await whoOwnsPort(port);
  if (!owners.length) return { ok: true, killed: [], note: '该端口当前没有监听者' };
  const SAFE = new Set(['node', 'python', 'pythonw', 'astrbot', 'uv', 'uvx', 'qq', 'napcat', 'napcatwinbootmain', 'napcat.shell']);
  const killed = [];
  const skipped = [];
  for (const o of owners) {
    const n = String(o.name || '').toLowerCase();
    if (n && !SAFE.has(n)) {
      skipped.push(`${o.name}(PID ${o.pid}) 不在可结束白名单内，请手动关闭`);
      continue;
    }
    try {
      await execP(`taskkill /PID ${o.pid} /F`, { windowsHide: true, timeout: 8000 });
      killed.push(`${o.name}(PID ${o.pid})`);
    } catch (_) {
      skipped.push(`${o.name}(PID ${o.pid}) 结束失败（可能需要管理员权限）`);
    }
  }
  // 结束完再确认一次是否真的空出来
  await new Promise((r) => setTimeout(r, 600));
  const now = await probePort(port);
  return { ok: !!now.free, killed, skipped, free: !!now.free };
}

module.exports = { run, killPort, probePort, whoOwnsPort, CRITICAL_PORTS, WIZARD_PORT };
