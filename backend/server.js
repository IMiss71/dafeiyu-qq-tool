// server.js
// 零依赖 Node 后端：托管向导页面 + 暴露安装/配置/启动 API。
// 在用户 Windows 机器上运行： node backend/server.js
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const d = require('./deploy');
const { createPluginManager } = require('./plugins/manager');
const pluginManager = createPluginManager(d.WORK_DIR);
const lic = require('./license');
const pro = require('./pro_features');
const pf = require('./preflight');
const doctor = require('./doctor');
const { InstallState } = require('./core/state');
const { runInstallPlan, planMeta } = require('./steps/install-plan');

const WIZARD_DIR = path.join(__dirname, '..', 'wizard');
const PERSONA_PATH = path.join(__dirname, '..', 'assets', 'dafeiyu_persona.txt');
const PORT = Number(process.env.DAFEIYU_WIZARD_PORT || 18765);
// 每次进程启动随机生成。页面由后端注入该 token，API 请求必须带同一个值。
// 这样即使别的本机进程知道请求头名字，也拿不到当前进程的 token。
const WIZARD_TOKEN = crypto.randomBytes(16).toString('hex');
// 面板整站代理端口：浏览器访问它就等于访问 AstrBot 面板（同源，且已注入登录态）
const ASTRBOT_PROXY_PORT = d.ASTRBOT_PROXY_PORT;
const DASH_URL = `http://127.0.0.1:${ASTRBOT_PROXY_PORT}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function pluginFail(res, e) {
  const status = e && e.code === 'E_PLUGIN_NOT_FOUND' ? 404 : 400;
  return sendJson(res, status, {
    ok: false,
    code: (e && e.code) || 'E_PLUGIN',
    error: (e && (e.userMessage || e.message)) || '插件操作失败',
    remediation: (e && e.remediation) || '',
    detail: (e && e.detail) || '',
  });
}

// ---------- 进度推送（SSE）----------
// 下载/装包都在 deploy.js 里跑，通过 sink 把进度送到这里再广播给所有开着向导的页面。
const sseClients = new Set();
let planBusy = false;
d.setProgressSink((evt) => {
  if (!sseClients.size) return;
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of sseClients) {
    try {
      c.write(payload);
    } catch (_) {
      sseClients.delete(c);
    }
  }
});

function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        try { req.destroy(); } catch (_) {}
        reject(new Error(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已拒绝`));
        return;
      }
      data += c;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------- 来源校验：只信本机浏览器 ----------
// 这个后端能读凭据、改配置、起停服务，必须保证"只有用户自己的向导页面"能调：
//   ① Host 头必须指向本机 —— DNS rebinding（攻击者域名解析到 127.0.0.1）在源头挡掉；
//   ② 除两个只读端点（ping / SSE events，浏览器 EventSource 加不了自定义头）外，
//      /api/* 一律要求自定义头 X-DaFeiYu-Wizard —— 恶意网页的 <img>/<form> 简单请求
//      （含 text/plain POST）加不了自定义头（要过 CORS 预检，而我们不应答预检），全部被拒。
function localHostOk(req) {
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  return host === '127.0.0.1' || host === 'localhost';
}
const SAFE_API_PATHS = new Set(['/api/ping', '/api/events']);
function csrfOk(req, urlPath) {
  if (req.method === 'GET' && SAFE_API_PATHS.has(urlPath)) return true;
  return req.headers['x-dafeiyu-wizard'] === WIZARD_TOKEN;
}
function rejectPlain(res, code, msg) {
  try {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(msg);
  } catch (_) {}
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(WIZARD_DIR, path.normalize(urlPath));
  if (filePath !== WIZARD_DIR && !filePath.startsWith(WIZARD_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(filePath);
    if (urlPath === '/index.html') {
      // 把本次进程的 token 注入页面。不要缓存，否则重启后页面还带着旧 token。
      const html = buf
        .toString('utf8')
        .replace(
          '<script src="app.js"></script>',
          `<script>window.__DFY_TOKEN__=${JSON.stringify(WIZARD_TOKEN)};</script>\n  <script src="app.js"></script>`
        );
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function handleApi(req, res, urlPath) {
  try {
    if (req.method === 'GET' && urlPath === '/api/ping') {
      // 轻量探活：前端用它判断“后端是否在运行”（直接双击 html 时这里会失败）
      return sendJson(res, 200, { ok: true, time: Date.now() });
    }
    if (req.method === 'GET' && urlPath === '/api/about') {
      // 「关于/开源许可」页要展示的公开信息。
      // 仓库地址用环境变量注入（发布时写进 start-wizard.bat），没配就返回空，
      // 前端会提示"看随包 README"——保证断网、没配地址时声明依然可见。
      return sendJson(res, 200, {
        ok: true,
        product: 'dafeiyu-qq-tool',
        version: lic.VERSION,
        repo: process.env.DAFEIYU_REPO_URL || '',
        license: 'MIT',
        upstream: {
          astrbot: { license: 'AGPL-3.0-or-later', url: 'https://github.com/AstrBotDevs/AstrBot' },
          napcat: { license: 'Limited Redistribution License', url: 'https://github.com/NapNeko/NapCatQQ' },
        },
      });
    }
    if (req.method === 'GET' && urlPath === '/api/health') {
      return sendJson(res, 200, await d.health());
    }
    if (req.method === 'GET' && urlPath === '/api/prereqs') {
      return sendJson(res, 200, { uv: await d.checkUv(), python: await d.checkPython() });
    }
    if (req.method === 'GET' && urlPath === '/api/preflight') {
      // 环境体检：把「别人电脑上会踩的坑」一次性查出来（磁盘/端口/杀软/中文路径/网络…），
      // 前端据此在安装前就给出处理办法，而不是等装到一半失败再猜。
      return sendJson(res, 200, await pf.run());
    }
    if (req.method === 'GET' && urlPath === '/api/install-state') {
      // 安装状态：步骤/时间/错误，供向导断点恢复和排障使用。
      return sendJson(res, 200, Object.assign({ ok: true }, d.getInstallState()));
    }
    if (req.method === 'GET' && urlPath === '/api/install-plan') {
      return sendJson(res, 200, { ok: true, steps: planMeta() });
    }
    if (req.method === 'GET' && urlPath === '/api/doctor/status') {
      try {
        const [status, pre] = await Promise.all([
          d.status().catch((e) => ({ error: e.message })),
          pf.run().catch((e) => ({ error: e.message })),
        ]);
        const wizardPort = (() => {
          try {
            const n = parseInt(fs.readFileSync(path.join(__dirname, '..', 'wizard.port'), 'utf8').trim(), 10);
            return Number.isFinite(n) && n > 0 ? n : PORT;
          } catch (_) { return PORT; }
        })();
        const ports = {};
        for (const [name, port] of Object.entries({
          wizard: wizardPort,
          astrbot: d.DASHBOARD_PORT,
          napcat: d.NAPCAT_WEBUI_PORT,
          onebot: 16199,
        })) {
          const r = await pf.probePort(port).catch(() => ({ free: null }));
          ports[name] = Object.assign({ port }, r);
        }
        const logs = [
          ['wizard', path.join(__dirname, '..', 'wizard.log')],
          ['astrbot', path.join(d.WORK_DIR, 'astrbot.log')],
          ['napcat', path.join(d.WORK_DIR, 'napcat.log')],
        ].map(([name, file]) => {
          let size = 0;
          try { size = fs.statSync(file).size; } catch (_) {}
          return { name, path: file, size };
        });
        return sendJson(res, 200, {
          ok: true,
          version: (() => { try { return require('../package.json').version; } catch (_) { return 'unknown'; } })(),
          node: process.version,
          platform: process.platform,
          workDir: d.WORK_DIR,
          installState: d.getInstallState(),
          status,
          preflight: pre && pre.summary ? pre.summary : { error: pre && pre.error },
          plugins: pluginManager.list(),
          ports,
          logs,
        });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'POST' && urlPath === '/api/kill-port') {
      // 一键释放被占用的端口（白名单内才杀，绝不误伤系统进程）
      const body = await readBody(req);
      const port = parseInt(body.port || String(req.url.split('port=')[1] || '').split('&')[0], 10);
      if (!port) return sendJson(res, 400, { ok: false, error: '缺少端口参数' });
      return sendJson(res, 200, await pf.killPort(port));
    }
    if (req.method === 'POST' && urlPath === '/api/diag') {
      // 一键生成诊断报告（自动脱敏），用户把文件发来即可定位问题
      try {
        const r = await doctor.collect();
        // 顺手打开所在文件夹，用户不用自己找
        try {
          require('child_process').exec(`explorer "${r.dir}"`, { windowsHide: true });
        } catch (_) {}
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'GET' && urlPath === '/api/presets') {
      // 服务商预设在后端只有一份真相，前端拉取后渲染下拉框，
      // 避免两边硬编码漂移（曾经因为前端写死旧模型名导致 404）
      const { PROVIDER_PRESETS } = require('./config_templates');
      const out = {};
      for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
        out[id] = {
          label: p.label,
          api_base: p.api_base,
          default_model: p.default_model,
          vision: !!p.vision,
          caption_model: p.caption_model || '',
          note: p.note || '',
          local: id === 'ollama',
        };
      }
      return sendJson(res, 200, { presets: out });
    }
    if (req.method === 'POST' && urlPath === '/api/test-provider') {
      // 部署前自检：Key / 模型名 / Base URL 三者错一个，用户都要等到聊天不回才发现
      const body = await readBody(req);
      const r = await d.testProvider(body);
      return sendJson(res, 200, r);
    }
    if (req.method === 'POST' && urlPath === '/api/list-models') {
      // 智能化核心：直接问服务商要模型列表，帮用户选，避免手打模型名 404（PRO）
      const g = lic.checkFeature('智能模型列表');
      if (!g.ok) return sendJson(res, 402, g);
      const body = await readBody(req);
      const r = await d.listModels(body);
      return sendJson(res, 200, r);
    }
    // ---------- PRO：高级参数 / 多人设 / 备份迁移 ----------
    // 统一在这里把 needLicense 转成 402，前端拿到就弹激活框
    try {
      if (urlPath === '/api/pro/config' && (req.method === 'GET' || req.method === 'POST')) {
        if (req.method === 'GET') return sendJson(res, 200, pro.getConfig(req.url.split('p=')[1] ? decodeURIComponent(req.url.split('p=')[1]) : ''));
        const body = await readBody(req);
        return sendJson(res, 200, pro.setConfigValue(body.path, body.value));
      }
      if (req.method === 'GET' && urlPath === '/api/pro/personas') {
        const setDefault = req.url.includes('set=') ? decodeURIComponent(req.url.split('set=')[1].split('&')[0]) : '';
        return sendJson(res, 200, await pro.listPersonas(setDefault));
      }
      if (req.method === 'GET' && urlPath === '/api/pro/backups') {
        return sendJson(res, 200, { ok: true, dir: pro.BACKUP_DIR, backups: pro.listBackups() });
      }
      if (req.method === 'POST' && urlPath === '/api/pro/backup') {
        return sendJson(res, 200, pro.exportBackup());
      }
      if (req.method === 'POST' && urlPath === '/api/pro/restore') {
        const body = await readBody(req);
        return sendJson(res, 200, pro.restoreBackup(body.path || (body.name ? path.join(pro.BACKUP_DIR, body.name) : '')));
      }
    } catch (e) {
      if (e && e.needLicense) {
        return sendJson(res, 402, {
          ok: false,
          needLicense: true,
          feature: e.feature,
          featureId: e.featureId,
          buyUrl: e.buyUrl,
          reason: e.message,
        });
      }
      return sendJson(res, 500, { ok: false, error: e.message });
    }
    if (urlPath === '/api/events') {
      // SSE：长任务（下载/装包）的实时进度。EventSource 断线会自动重连。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      const ka = setInterval(() => {
        try {
          res.write(': ka\n\n');
        } catch (_) {}
      }, 15000);
      const drop = () => {
        clearInterval(ka);
        sseClients.delete(res);
      };
      req.on('close', drop);
      req.on('error', drop);
      return; // 长连接，不 end
    }
    if (req.method === 'GET' && urlPath === '/api/status') {
      // 统一环境探测：前端据此自动跳过已完成的步骤、避免重复安装
      const st = await d.status();
      // 顺带把授权状态带回去，前端据此显示「免费版 / PRO 已激活」
      try { st.license = lic.status(); } catch (_) {}
      // NapCat 自愈守护状态：崩了会自动重启，让前端能告诉用户"别慌，在自动重试"
      st.napcatGuard = {
        armed: napcatGuard.armed,
        restarts: napcatGuard.restarts,
        maxRestarts: napcatGuard.maxRestarts,
      };
      st.astrbotGuard = {
        armed: astrbotGuard.armed,
        restarts: astrbotGuard.restarts,
        maxRestarts: astrbotGuard.maxRestarts,
      };
      return sendJson(res, 200, st);
    }
    // ---------- 授权：本项目完全免费，激活/心跳/解绑等路由已随死代码一起移除 ----------
    if (req.method === 'GET' && urlPath === '/api/license') {
      return sendJson(res, 200, lic.status());
    }
    if (req.method === 'GET' && urlPath === '/api/update-check') {
      // 检查更新：发布者在启动脚本里配 DAFEIYU_UPDATE_URL（返回 JSON {version, notes, url}）。
      // 没配置就如实返回"未配置更新源"，绝不显示无中生有的版本信息
      const url = process.env.DAFEIYU_UPDATE_URL || '';
      if (!url) return sendJson(res, 200, { ok: true, configured: false });
      try {
        const txt = await new Promise((resolve, reject) => {
          const u = new URL(url);
          const mod = u.protocol === 'https:' ? https : http;
          const rq = mod.get(
            { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + (u.search || ''), headers: { 'User-Agent': 'dafeiyu-wizard' } },
            (r2) => {
              let s = '';
              r2.on('data', (c) => (s += c));
              r2.on('end', () => resolve(s));
            }
          );
          rq.on('error', reject);
          rq.setTimeout(8000, () => { try { rq.destroy(); } catch (_) {} reject(new Error('更新源连接超时')); });
        });
        const j = JSON.parse(txt);
        return sendJson(res, 200, {
          ok: true,
          configured: true,
          current: lic.VERSION,
          latest: String(j.version || ''),
          notes: String(j.notes || ''),
          url: String(j.url || ''),
        });
      } catch (e) {
        return sendJson(res, 200, { ok: false, configured: true, error: e.message });
      }
    }
    if (req.method === 'GET' && urlPath === '/api/persona') {
      const txt = fs.existsSync(PERSONA_PATH) ? fs.readFileSync(PERSONA_PATH, 'utf8') : '';
      return sendJson(res, 200, { persona: txt });
    }
    if (req.method === 'POST' && urlPath === '/api/reset') {
      // 清空沙盒（配置/人设/NapCat/ffmpeg），保留 AstrBot 程序本体。
      // 这是破坏性操作：除了前端弹窗，服务端也要验一次确认参数，
      // 防止脚本/扩展/误触发的请求直接清掉用户数据
      const body = await readBody(req).catch(() => ({}));
      if (!body || body.confirm !== '清空环境') {
        return sendJson(res, 400, { ok: false, error: '缺少确认参数。清空环境请从向导页面操作，并看清弹窗提示。' });
      }
      const r = await d.runStep('清空环境', d.resetEnvironment, 'reset_environment');
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (req.method === 'POST' && urlPath === '/api/install-all') {
      // 服务端一键安装：步骤、状态、超时和回滚都在后端，前端只负责显示。
      if (planBusy) {
        return sendJson(res, 429, { ok: false, busy: true, error: '一键安装正在进行中，请等它完成' });
      }
      if (d.getBusyStep()) {
        return sendJson(res, 429, { ok: false, busy: true, error: `正在「${d.getBusyStep()}」，请等它完成` });
      }
      planBusy = true;
      const state = InstallState.load(path.join(d.WORK_DIR, 'install-state.json'));
      try {
        await runInstallPlan({}, state, {
          onStepStart: (s) => d.emitProgress({ kind: 'step', name: '一键安装：' + s.title, state: 'start' }),
          onStepDone: (s) => d.emitProgress({ kind: 'step', name: '一键安装：' + s.title, state: 'ok' }),
        });
        return sendJson(res, 200, { ok: true, state: state.summary() });
      } catch (e) {
        d.emitProgress({ kind: 'step', name: '一键安装失败', state: 'fail', error: (e && (e.userMessage || e.message)) || '未知错误' });
        return sendJson(res, 500, {
          ok: false,
          code: (e && e.code) || 'E_INSTALL',
          error: (e && (e.userMessage || e.message)) || '安装失败',
          remediation: (e && e.remediation) || '',
          retryable: !(e && e.retryable === false),
        });
      } finally {
        planBusy = false;
      }
    }
    if (req.method === 'GET' && urlPath === '/api/plugins') {
      try {
        return sendJson(res, 200, Object.assign({ ok: true }, pluginManager.list()));
      } catch (e) {
        return pluginFail(res, e);
      }
    }
    if (req.method === 'POST' && urlPath === '/api/plugins/install') {
      let zipPath = '';
      try {
        const body = await readBody(req, 24 * 1024 * 1024);
        const b64 = String(body.zipBase64 || '').trim();
        if (!b64) return pluginFail(res, new Error('缺少 zipBase64'));
        if (b64.length > 20 * 1024 * 1024) return pluginFail(res, new Error('插件包超过 15MB'));
        const tmpDir = path.join(d.WORK_DIR, 'plugin_tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        zipPath = path.join(tmpDir, `upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`);
        fs.writeFileSync(zipPath, Buffer.from(b64, 'base64'));
        const r = pluginManager.installFromZip(zipPath, { expectedName: body.name || '' });
        return sendJson(res, 200, r);
      } catch (e) {
        return pluginFail(res, e);
      } finally {
        if (zipPath) { try { fs.unlinkSync(zipPath); } catch (_) {} }
      }
    }
    if (req.method === 'POST' && urlPath === '/api/plugins/rollback') {
      try {
        const body = await readBody(req);
        const r = pluginManager.rollback(body.backupId);
        return sendJson(res, 200, r);
      } catch (e) {
        return pluginFail(res, e);
      }
    }
    if (req.method === 'POST' && urlPath === '/api/plugins/remove') {
      try {
        const body = await readBody(req);
        const r = pluginManager.remove(body.name);
        return sendJson(res, 200, r);
      } catch (e) {
        return pluginFail(res, e);
      }
    }
    if (req.method === 'POST' && urlPath === '/api/install-uv') {
      if (planBusy) return sendJson(res, 429, { ok: false, busy: true, error: '一键安装正在进行中，请等它完成' });
      const r = await d.runStep('安装 uv', d.installUv, 'install_uv');
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (req.method === 'POST' && urlPath === '/api/install-astrbot') {
      if (planBusy) return sendJson(res, 429, { ok: false, busy: true, error: '一键安装正在进行中，请等它完成' });
      const r = await d.runStep('安装 AstrBot', d.installAstrbot, 'install_astrbot');
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (req.method === 'POST' && urlPath === '/api/install-napcat') {
      if (planBusy) return sendJson(res, 429, { ok: false, busy: true, error: '一键安装正在进行中，请等它完成' });
      const r = await d.runStep('安装 NapCat（下载+解压）', d.installNapCat, 'install_napcat');
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (req.method === 'POST' && urlPath === '/api/start-napcat') {
      // ★ S10：并发互斥 —— 连点两次会起两个 NapCat 抢同一个 QQ 登录态
      if (startBusy) {
        return sendJson(res, 429, { ok: false, busy: true, error: '启动正在进行中，请勿重复点击' });
      }
      // 没装就别启动：否则会「启动成功但什么也没发生」，用户以为是装好了
      if (!d.napCatInstalled()) {
        return sendJson(res, 400, {
          ok: false,
          needInstall: true,
          error: 'NapCat 还没安装。先点「一键装 NapCat」（下载约 34MB），装完再启动。',
        });
      }
      try {
        const r = d.startNapCat();
        armNapCatGuard(); // 启动即上守护：崩了自动拉起来
        // 登录成功后自动把账号记进 NapCat 的「快速登录」，以后重启不用再扫码
        setTimeout(() => { try { d.ensureNapCatOnebotWs && d.ensureNapCatOnebotWs(); } catch (_) {} d.ensureNapCatAutoLogin && d.ensureNapCatAutoLogin(); }, 25000);
        // 启动后轮询等 WebUI(6099) 真正就绪（QQ 注入要几秒到十几秒），最多 40 秒。
        // 否则用户看到「控制台已启动」但面板还没起，以为没成功又去点，变成「要多点几次」。
        let napReady = !!r.alreadyRunning;
        if (!napReady) {
          for (let i = 0; i < 30; i++) {
            await new Promise((res) => setTimeout(res, 1000));
            if (await portAlive(d.NAPCAT_WEBUI_PORT || 6099)) { napReady = true; break; }
          }
        }
        const hint =
          r.mode === 'hidden'
            ? 'NapCat 已在后台启动（没有任何需要保持开启的窗口）。点「打开 NapCat（自动登录）」会用带 token 的地址直接打开网页面板；首次需要用 QQ 小号扫码，二维码在面板里（也存了一份在 NapCat\\cache\\qrcode.png）。'
            : 'NapCat 控制台窗口已弹出（任务栏能看到，标题是「NapCat（勿关闭）」）。等它打印出 “WebUI Local Panel Url: http://127.0.0.1:6099/webui?token=xxxx”，整条复制到浏览器打开即可登录；窗口里也会出登录二维码。';
        return sendJson(res, 200, {
          ...r,
          alreadyRunning: !!r.alreadyRunning,
          napReady,
          hint,
        });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'POST' && urlPath === '/api/init') {
      if (planBusy) return sendJson(res, 429, { ok: false, busy: true, error: '一键安装正在进行中，请等它完成' });
      const r = await d.runStep('初始化 AstrBot', async () => {
        await d.ensureWorkDir();
        await d.initAstrbot();
        // 初始化完顺手把随包的大肥鱼能力插件装上（否则客户拿到的是裸 AstrBot）
        let plugin = null;
        try { plugin = d.installBundledPlugin(); } catch (e) { plugin = { installed: false, reason: e.message }; }
        return { plugin };
      }, 'init_astrbot');
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (req.method === 'POST' && urlPath === '/api/configure') {
      const body = await readBody(req);
      const r = await d.runStep('写入模型配置', async () => {
        const c = await d.configureProvider(body);
        const n = d.writeNapCatReferenceConfig({});
        return { config: c, napcat: n };
      });
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (req.method === 'POST' && urlPath === '/api/start') {
      // ★ S10：并发互斥 —— 连点两次会 spawn 两个 AstrBot 抢锁抢端口（面板 502）
      if (startBusy) {
        return sendJson(res, 429, { ok: false, busy: true, error: '启动正在进行中，请勿重复点击' });
      }
      // 强制授权模式（DAFEIYU_LICENSE=1）下，未激活直接拒绝点火
      const gate = lic.requirePro('启动机器人');
      if (gate) return sendJson(res, 402, gate);
      // AstrBot 没装就别点火：以前会「静默失败 + 白白下载 79MB ffmpeg」，
      // 用户看到什么都没发生，还以为是自己点错了（实测踩过）。
      if (!(await d.checkAstrbot())) {
        return sendJson(res, 400, {
          ok: false,
          needInstall: true,
          error:
            'AstrBot 还没安装，无法启动。请先回到第 ② 步点「安装并初始化」（首次约 40 秒），装完再回来启动。',
        });
      }
      const r = await d.startAstrbot();
      armAstrbotGuard(); // 启动即上守护：进程没了自动拉回来
      // 语音依赖 ffmpeg：后台补齐（首次约 28MB）。放在 bin 目录里，
      // 而 startAstrbot 已把该目录加进 PATH，所以稍后到位也能被找到。
      // 失败不阻止启动，只是语音用不了。
      d.ensureFfmpeg().catch((e) =>
        console.log(`[start] ffmpeg 准备失败（语音功能可能不可用）: ${e.message}`)
      );
      // AstrBot 冷启动要 20~40 秒才监听端口，立刻开面板只会看到“未启动”。
      // 改为后台等就绪：拿到 token + 端口通了，再自动弹出已登录的面板。
      (async () => {
        try {
          const ready = await d.waitForDashboard(60, 2000);
          const l = await d.astrbotLoginOnce({}).catch(() => null);
          if (l && l.token) lastAstrbotToken = l.token;
          d.openUrl(DASH_URL);
          if (!ready) console.log('[start] AstrBot 60 秒内未就绪，仍已打开面板页（会自动重试）');
        } catch (e) {
          d.openUrl(DASH_URL);
        }
      })();
      return sendJson(res, 200, {
        ok: true,
        started: r,
        dashboardUrl: DASH_URL,
        note: 'AstrBot 正在后台启动（约 30 秒），就绪后浏览器会自动打开已登录的面板',
      });
    }
    if (process.env.DAFEIYU_DEBUG === '1' && urlPath === '/api/_dev-set-token') {
      // 仅调试用：模拟已拿到 token，验证自动登录注入是否生效
      lastAstrbotToken = 'DEBUG_TOKEN_FOR_TEST';
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && urlPath === '/api/credentials') {
      // 自动收集 AstrBot / NapCat 的登录凭据，省得用户翻日志找随机密码
      return sendJson(res, 200, await d.credentials());
    }
    if (req.method === 'POST' && urlPath === '/api/astrbot-login') {
      const body = await readBody(req);
      const creds = d.readAstrbotCredentials();
      const username = body.username || creds.username;
      const password = body.password || creds.password;
      if (!password) {
        return sendJson(res, 400, { ok: false, error: '尚未获取到 AstrBot 初始密码，请先启动 AstrBot 一次' });
      }
      const r = await d.astrbotLogin({ username, password });
      if (r.token) {
        lastAstrbotToken = r.token; // 供 /dash 代理自动登录使用
        return sendJson(res, 200, { ok: true, username, token: r.token });
      }
      // status 0 = 连不上，说明 AstrBot 还没起来（已重试约 40 秒）
      if (!r.status) {
        return sendJson(res, 503, {
          ok: false,
          error: 'AstrBot 还没启动完成，等它在后台跑起来（约 30 秒）后再点一次「自动登录」',
          detail: r,
        });
      }
      return sendJson(res, 401, { ok: false, error: '登录失败（密码可能已被修改）', detail: r });
    }
    if (req.method === 'POST' && urlPath === '/api/open-dashboard') {
      // 优先打开「已自动登录」的代理页，失败再退回原生面板
      d.openUrl(DASH_URL);
      return sendJson(res, 200, { ok: true, url: DASH_URL });
    }
    if (req.method === 'POST' && urlPath === '/api/open-napcat') {
      // 没装 NapCat 却点「打开面板」，浏览器只会得到一个连不上的地址，
      // 而用户会以为"已经装好了只是页面没加载出来"。这里直接说清楚。
      if (!d.napCatInstalled()) {
        return sendJson(res, 400, {
          ok: false,
          needInstall: true,
          error: 'NapCat 还没安装。先点「一键装 NapCat」（下载约 34MB），装完再打开面板。',
        });
      }
      // NapCat 支持 ?token=xxx 直接免密进入；读不到 token 就打开登录页并给出找 token 的指引
      const n = await d.readNapCatCredentials();
      d.openUrl(n.autoLoginUrl || n.webuiUrl);
      return sendJson(res, 200, {
        ok: true,
        url: n.autoLoginUrl || n.webuiUrl,
        token: n.token,
        needsToken: !!n.needsToken,
        tokenHint: n.tokenHint || '',
      });
    }
    if (req.method === 'POST' && urlPath === '/api/napcat-cfg') {
      const n = d.writeNapCatReferenceConfig({});
      return sendJson(res, 200, { config: n.content, path: n.path });
    }
    if (req.method === 'POST' && urlPath === '/api/inject-persona') {
      const body = await readBody(req);
      // 优先用前端编辑过的文本；没传则用内置人设文件
      const personaText = (body.prompt && body.prompt.trim())
        ? body.prompt
        : (fs.existsSync(PERSONA_PATH) ? fs.readFileSync(PERSONA_PATH, 'utf8') : '');
      // 前置自愈：人设要写进 AstrBot 首次启动时创建的数据库（data/data_v4.db）。
      // 用户常常没走完安装/启动步骤就点注入 —— 与其弹窗让人自己回去补步骤，
      // 不如这里直接把 AstrBot 拉起来并等就绪（旧版只报错，被当成 bug）。
      try {
        const alive = await portAlive(d.DASHBOARD_PORT || 16885);
        if (!alive) {
          console.log('[inject] AstrBot 未运行，自动启动…');
          await d.startAstrbot();
          const ready = await d.waitForDashboard(45, 2000);
          if (!ready) throw new Error('AstrBot 启动超时（90 秒未就绪）');
          console.log('[inject] AstrBot 已启动');
        }
        // 等首次启动把数据库建出来（面板就绪后一般秒级出现）
        const dbFile = path.join(d.WORK_DIR, 'data', 'data_v4.db');
        for (let i = 0; i < 20 && !fs.existsSync(dbFile); i++) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!fs.existsSync(dbFile)) {
          throw new Error('AstrBot 已启动但数据库未生成（data_v4.db 不存在），可能首次初始化失败');
        }
      } catch (e) {
        return sendJson(res, 500, {
          ok: false,
          error: 'AstrBot 未能就绪：' + (e && e.message),
          hint: '请到「安装」步骤确认安装成功，再到「登录QQ」步骤点「启动 AstrBot」，稍等一分钟后再回来注入。',
        });
      }
      const r = await d.runStep('注入大肥鱼人设', async () => {
        return await d.injectPersona({ id: 'dafeiyu', name: '大肥鱼', prompt: personaText });
      });
      if (!r.ok && /数据库|database|data_v4/i.test(r.error || '')) {
        r.hint = 'AstrBot 还没有完成首次启动（人格存在首次启动时创建的数据库里）。请先到「登录QQ」步骤点「启动 AstrBot」，等它跑起来后再回来注入。';
      }
      // 注入成功后：AstrBot 只在启动时读一次人格，必须重启才能让新人格生效。
      // 异步触发、不阻塞本接口（冷启动要 30~40 秒）；重启失败也不影响「已写入」的结果，
      // 只是提示用户稍后手动重启。
      if (r.ok) {
        // ★ S2 修复：真实等待重启结果，失败时把原因透传给前端（不再无条件报成功）
        try {
          const rr = await d.restartAstrbot();
          r.restartTriggered = !!(rr && rr.restarted);
          if (rr && rr.reason) r.reason = rr.reason;
          if (r.restartTriggered) console.log('[inject] 人设注入后 AstrBot 已重启');
        } catch (e) {
          r.restartTriggered = false;
          r.reason = '自动重启失败：' + ((e && e.message) || e) + '。请手动「停止」再「启动」让新人格生效';
        }
      }
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    return sendJson(res, 404, { error: 'unknown api' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

// ---------- AstrBot 面板反向代理（自动登录） ----------
// 面板是另一个源(16885)，浏览器没法跨源写 localStorage，
// 所以代理它，并在页面里注入 token → 打开即已登录。
//
// 重要：面板是 Vue SPA，JS 里写满了 "/api/xxx" 这类绝对路径。
// 如果代理到子路径 /dash 下，JS 仍会请求本站 /api/xxx → 打到向导自己的接口 → 白屏。
// 所以主方案是「整站代理到独立端口」(ASTRBOT_PROXY_PORT)：路径原样转发，所有绝对路径天然正确。
let startBusy = false;   // ★ S10：/api/start 并发互斥
let lastAstrbotToken = '';

// 确保手上有一个可用 token（没有就用已知密码现登一次，只等一轮，不阻塞页面）
async function ensureToken() {
  if (lastAstrbotToken) return lastAstrbotToken;
  try {
    const creds = d.readAstrbotCredentials();
    if (!creds.password) return '';
    const r = await d.astrbotLoginOnce({ username: creds.username, password: creds.password });
    if (r && r.token) lastAstrbotToken = r.token;
  } catch (_) { /* ignore */ }
  return lastAstrbotToken;
}

function autoLoginScript() {
  if (!lastAstrbotToken) return '';
  const user = (d.readAstrbotCredentials().username) || 'astrbot';
  return `<script>
(function(){
  try {
    if (!localStorage.getItem('token')) {
      localStorage.setItem('token', ${JSON.stringify(lastAstrbotToken)});
      localStorage.setItem('user', ${JSON.stringify(user)});
      location.reload();
    }
  } catch(e) {}
})();
</script>`;
}

// 子路径模式（/dash）下，连 JS/CSS 内容里的绝对路径一起改写，尽力补救
function rewriteForPrefix(text, prefix) {
  if (!prefix) return text;
  const p = prefix + '/';
  return text
    .replace(/(src|href)="\/(assets|favicon|api|static)/g, `$1="${p}$2`)
    .replace(/"\/(assets|api|static)\//g, `"${p}$1/`);
}

// prefix 传 '' 表示整站代理（路径原样转发）
async function proxyToAstrbot(req, res, prefix) {
  let rest = prefix ? (req.url.slice(prefix.length) || '/') : req.url;
  if (!rest.startsWith('/')) rest = '/' + rest;

  const headers = Object.assign({}, req.headers);
  delete headers['host'];
  delete headers['accept-encoding']; // 不解压，便于改写内容

  const proxyReq = http.request(
    { host: '127.0.0.1', port: d.DASHBOARD_PORT, path: rest, method: req.method, headers, timeout: 20000 },
    (proxyRes) => {
      const ctype = String(proxyRes.headers['content-type'] || '');
      const isHtml = ctype.includes('text/html');
      const isText = isHtml || ctype.includes('javascript') || ctype.includes('css') || ctype.includes('json');

      if (!isText) {
        const outHeaders = Object.assign({}, proxyRes.headers);
        res.writeHead(proxyRes.statusCode, outHeaders);
        return proxyRes.pipe(res);
      }

      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        if (prefix) body = rewriteForPrefix(body, prefix);

        if (isHtml) {
          const inject = autoLoginScript();
          if (inject) body = body.replace('</head>', inject + '</head>') || body + inject;
        }

        const outHeaders = Object.assign({}, proxyRes.headers);
        delete outHeaders['content-length'];
        delete outHeaders['content-encoding'];
        if (isHtml) outHeaders['content-type'] = 'text/html; charset=utf-8';
        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(body);
      });
    }
  );

  proxyReq.on('error', (e) => {
    // AstrBot 还没起来（冷启动 20~40 秒）：每 3 秒自动重试，用户什么都不用做
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<meta http-equiv="refresh" content="3">
      <body style="font-family:sans-serif;background:#f6f7f9;color:#333;padding:40px">
        <h3>⏳ AstrBot 正在启动中…（${e.message}）</h3>
        <p>首次启动约需 30 秒，本页会<b>每 3 秒自动刷新</b>，起来后会直接进入已登录的面板。</p>
        <p>如果超过 1 分钟还没好，回向导点一次「启动 AstrBot」。</p>
      </body>`);
  });
  proxyReq.on('timeout', () => { proxyReq.destroy(); });
  req.pipe(proxyReq);
}

// WebSocket 也一并代理（面板日志/聊天用得上）
function upgradeToAstrbot(req, socket, head, prefix) {
  let rest = prefix ? (req.url.slice(prefix.length) || '/') : req.url;
  if (!rest.startsWith('/')) rest = '/' + rest;
  const headers = Object.assign({}, req.headers);
  delete headers['host'];
  const proxyReq = http.request({
    host: '127.0.0.1',
    port: d.DASHBOARD_PORT,
    path: rest,
    method: 'GET',
    headers: Object.assign(headers, { Connection: 'Upgrade', Upgrade: 'websocket' }),
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.keys(proxyRes.headers).map((k) => `${k}: ${proxyRes.headers[k]}`).join('\r\n') +
        '\r\n\r\n'
    );
    if (head && head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
}

// 整站代理服务：浏览器看到的就是 AstrBot 面板本身，只是多注入了一次自动登录
function startAstrbotProxyServer() {
  const srv = http.createServer(async (req, res) => {
    // 面板代理会向页面注入登录 token，同样只允许本机来源
    if (!localHostOk(req)) return rejectPlain(res, 403, 'forbidden host');
    try {
      await ensureToken();
    } catch (_) { /* ignore */ }
    return proxyToAstrbot(req, res, '');
  });
  srv.on('upgrade', (req, socket, head) => {
    if (!localHostOk(req)) return socket.destroy();
    upgradeToAstrbot(req, socket, head, '');
  });
  srv.listen(ASTRBOT_PROXY_PORT, '127.0.0.1', () => {
    console.log(`AstrBot 面板代理已启动: http://127.0.0.1:${ASTRBOT_PROXY_PORT}/`);
  });
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`端口 ${ASTRBOT_PROXY_PORT} 已被占用（可能已有代理在跑），跳过`);
    } else {
      console.log(`面板代理启动失败: ${e.message}`);
    }
  });
  return srv;
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (!localHostOk(req)) return rejectPlain(res, 403, 'forbidden host');
  if (urlPath.startsWith('/api/')) {
    if (!csrfOk(req, urlPath)) return rejectPlain(res, 403, 'forbidden origin');
    return handleApi(req, res, urlPath);
  }
  // /dash 子路径代理：保留兼容，但主入口已改为下面的整站代理端口
  if (urlPath === '/dash' || urlPath.startsWith('/dash/')) return proxyToAstrbot(req, res, '/dash');
  return serveStatic(req, res);
});

// /dash 下的 WebSocket（兼容老入口）
server.on('upgrade', (req, socket, head) => {
  if (!localHostOk(req)) return socket.destroy();
  const urlPath = req.url.split('?')[0];
  if (!(urlPath === '/dash' || urlPath.startsWith('/dash/'))) {
    socket.destroy();
    return;
  }
  return upgradeToAstrbot(req, socket, head, '/dash');
});

// ---------- 启动：挑一个真没人用的端口 ----------
// 为什么不能只靠 EADDRINUSE 兜底：Node 在 Windows 上默认带 SO_REUSEADDR，
// 绑一个已被别人监听的端口照样"成功"，于是两个服务同时监听同一端口，
// 浏览器请求随机落到其中一个 —— 表现就是"有时候能打开、有时候打不开/内容不对"。
// 所以开跑前先逐个连一下，连不上的那个才用。
const PORT_FILE = path.join(__dirname, '..', 'wizard.port');
let actualPort = PORT;

async function pickPort(start, tries = 11) {
  for (let p = start; p < start + tries; p++) {
    if (!(await portAlive(p))) return p;
  }
  return 0;
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (actualPort - PORT >= 10) {
      console.log(`[向导] ${PORT}~${PORT + 10} 端口全被占用，服务无法启动`);
      try { fs.writeFileSync(PORT_FILE, 'FAIL'); } catch (_) {}
      return;
    }
    actualPort += 1;
    console.log(`[向导] 端口被占用，改试 ${actualPort}`);
    setTimeout(() => {
      try { server.listen(actualPort, '127.0.0.1'); } catch (_) {}
    }, 300);
  } else {
    console.log(`[向导] 服务启动失败: ${e.message}`);
  }
});
server.on('listening', () => {
  const p = (server.address() && server.address().port) || actualPort;
  actualPort = p;
  console.log(`大肥鱼一键包向导已启动: http://127.0.0.1:${p}/`);
  console.log(`工作目录: ${d.WORK_DIR}`);
  try { fs.writeFileSync(PORT_FILE, String(p)); } catch (_) {}
});
// 双开保护：已经有一个向导在跑时，第二个实例直接安静退出。
// 否则它会顺延到下一个端口、覆盖 wizard.port，然后被 bat 当成新地址打开，
// 而第一个实例还在旧端口上 —— 用户就会看到"点了没反应/开错页面"。
function portAlive(port) {
  return new Promise((resolve) => {
    const s = require('net').createConnection({ host: '127.0.0.1', port }, () => {
      try { s.destroy(); } catch (_) {}
      resolve(true);
    });
    s.once('error', () => resolve(false));
    setTimeout(() => {
      try { s.destroy(); } catch (_) {}
      resolve(false);
    }, 1200);
  });
}

(async () => {
  // ① 已经有一个向导在跑 → 安静退出，别抢端口、别覆盖端口文件
  try {
    if (fs.existsSync(PORT_FILE)) {
      const prev = parseInt(String(fs.readFileSync(PORT_FILE, 'utf8')).trim(), 10);
      if (prev && (await portAlive(prev))) {
        console.log(`[向导] 已有一个实例在运行：http://127.0.0.1:${prev}/ ，本次不再重复启动`);
        process.exit(0);
      }
    }
  } catch (_) {}
  // ② 挑一个真正没人占用的端口
  const free = await pickPort(PORT);
  if (!free) {
    console.log(`[向导] ${PORT}~${PORT + 10} 端口都被占用，无法启动`);
    try { fs.writeFileSync(PORT_FILE, 'FAIL'); } catch (_) {}
    process.exit(1);
  }
  // ③ 独占锁做最终裁决：portAlive 探测存在竞态窗口（两个实例同时启动都可能
  //    "探测通过"然后都 listen），O_EXCL 创建锁文件并发下只有一个能成功。
  //    崩溃留下的死锁用"锁内 PID 还活着且是 node"来判定，死锁自动清掉重抢。
  const LOCK_FILE = path.join(__dirname, '..', 'wizard.lock');
  const lockHolderAlive = () => {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (!pid) return false;
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        windowsHide: true, timeout: 8000, encoding: 'utf8',
      });
      return new RegExp(`\\b${pid}\\b`).test(out) && /node/i.test(out) && !/No tasks|没有运行/i.test(out);
    } catch (_) { return false; }
  };
  let lockFd = 0;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      if (lockHolderAlive()) {
        console.log('[向导] 已有实例持有运行锁，本次不再启动');
        process.exit(0);
      }
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    }
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(lockFd, String(process.pid));
  } catch (e) {
    if (e.code === 'EEXIST') {
      console.log('[向导] 运行锁被并发实例抢到，本次退出');
      process.exit(0);
    }
    console.log(`[向导] 运行锁写不了（${e.message}），跳过互斥继续启动`);
    lockFd = 0;
  }
  process.on('exit', () => {
    if (!lockFd) return;
    try { fs.closeSync(lockFd); } catch (_) {}
    try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
  });
  actualPort = free;
  server.listen(free, '127.0.0.1');
})();

// ---------- NapCat 崩溃自愈守护 ----------
// 背景（实测，勿删）：NapCat 4.18.41 注入 QQ 9.9.36-53644 后会概率性崩溃
//   —— 崩溃点在 QQNT.dll 的 int3 断点（0x80000003），表现为 QQ.exe 弹
//   「0xc06d007f 未知的软件异常」后退出，napcat.log 尾部留一句 "Process exited."。
//   存活时长随机：30 秒~数小时不等（10/24 有一次撑了 3.5 小时）。
//   ⇒ 不是必崩，是概率崩。人肉点按钮重试太累，交给守护自动来。
//
// 为什么守护必须放在本进程（常驻 server.js）里，而不是单独跑个脚本：
//   实测发现「父进程一退出，NapCat 会跟着没」——用一次性 node -e 启动 NapCat，
//   那个 node 进程结束时会把 NapCat 带走，看上去就像"又崩了"。
//   放这里，父进程（向导服务）永远活着，NapCat 就不会被连带杀掉，
//   剩下的才是真正的崩溃，由本守护负责重启。
const napcatGuard = {
  timer: null,
  restarts: 0,
  maxRestarts: 30,      // 一晚上最多重启这么多次，够用了
  lastStart: 0,
  armed: false,         // 用户主动启动过才守护（没点过就别自作主张拉起来）
  lastCrashAt: 0,
};

// 「一键停止」写入的停机标记：守护看到它就放下武器，避免刚被 stop.js 杀掉的
// AstrBot/NapCat 又被自动拉起来（两个守护互相拉扯，"一键停止"停不干净的根因）。
// 用户下次点"启动"时删除该标记，守护重新上膛。
const GUARD_DISARM_PATH = path.join(d.WORK_DIR, 'guard.disarm');
function guardsDisarmed() {
  try { return fs.existsSync(GUARD_DISARM_PATH); } catch (_) { return false; }
}
function clearGuardDisarm() {
  try { fs.unlinkSync(GUARD_DISARM_PATH); } catch (_) {}
}

function armNapCatGuard() {
  napcatGuard.armed = true;
  clearGuardDisarm();
  // 免扫码 + 反向 WS 自愈：QQ 登录后 NapCat 才生成该账号的 onebot11_<QQ号>.json
  // （websocketClients 是空的 → 机器人已登录却永远不回消息，实测踩过）。
  // 低频定时器里把两件事都补上：内部幂等，失败静默。
  if (!napcatGuard.autoLoginTimer) {
    napcatGuard.autoLoginTimer = setInterval(() => {
      if (guardsDisarmed()) return;
      try { if (d.ensureNapCatOnebotWs) d.ensureNapCatOnebotWs(); } catch (_) {}
      if (d.ensureNapCatAutoLogin) Promise.resolve(d.ensureNapCatAutoLogin()).catch(() => {});
      // WS 自愈升级：配置文件是对的、NapCat 也活着，但反向 WS 一直没连上
      // → 八成是「登录后才补写配置，NapCat 不热加载」。等 3 分钟还不连就重启它重读配置。
      // 前置条件都拉满才动手：用户主动启动过 + AstrBot 在听反向端口 + 距上次修复超过 3 分钟。
      // ★ 上限 3 次：如果连修 3 次还没连上，多半是账号被踢下线/快速登录失效，
      //   需要人工扫码 —— 这时每 3 分钟杀一次 QQ 的死循环只会更糟。WS 恢复后计数清零。
      try {
        const wsOk = d.napcatWsConnected && d.napcatWsConnected();
        if (wsOk) napcatGuard.wsFixCount = 0;
        if (
          napcatGuard.armed &&
          !wsOk &&
          d.isNapCatRunning && d.isNapCatRunning() &&
          d.restartNapCat &&
          Date.now() - (napcatGuard.lastWsFix || 0) > 180000
        ) {
          if ((napcatGuard.wsFixCount || 0) >= 3) return;
          napcatGuard.lastWsFix = Date.now();
          napcatGuard.wsFixCount = (napcatGuard.wsFixCount || 0) + 1;
          console.log(`[自愈] NapCat 在跑但反向 WS 未连接，重启以重读 OneBot 配置（第 ${napcatGuard.wsFixCount}/3 次）`);
          if (napcatGuard.wsFixCount >= 3) {
            console.log('[自愈] 已连续修复 3 次仍未连接，停止自动重启。多半是 QQ 掉线需要重新扫码，请打开 NapCat 面板人工登录。');
          }
          d.restartNapCat();
        }
      } catch (_) {}
    }, 120000);
  }
  if (napcatGuard.timer) return;
  napcatGuard.timer = setInterval(() => {
    if (!napcatGuard.armed) return;
    if (guardsDisarmed()) {
      napcatGuard.armed = false;
      return;
    }
    let alive = false;
    try { alive = d.isNapCatRunning(); } catch (_) { return; }
    if (alive) return;                       // 活着就别打扰

    const now = Date.now();
    if (now - napcatGuard.lastStart < 25000) return;  // 刚重启过，给它点时间起来
    if (napcatGuard.restarts >= napcatGuard.maxRestarts) {
      console.log(`[守护] NapCat 已自动重启 ${napcatGuard.restarts} 次仍不稳定，停止自动重启（可手动再点一次「启动 NapCat」）`);
      clearInterval(napcatGuard.timer);
      napcatGuard.timer = null;
      napcatGuard.armed = false;
      return;
    }
    try {
      if (!d.napCatInstalled()) return;      // 没装就别白费劲
      napcatGuard.restarts += 1;
      napcatGuard.lastStart = now;
      napcatGuard.lastCrashAt = now;
      console.log(`[守护] NapCat 已退出，第 ${napcatGuard.restarts} 次自动重启`);
      d.startNapCat();
    } catch (e) {
      console.log(`[守护] 自动重启失败: ${e.message}`);
    }
  }, 15000);
}

// ---------- AstrBot 自愈守护 ----------
// 为什么要这个：AstrBot 是纯 Python 常驻进程，除了自己崩，还会被外部环境误杀。
// 实测踩过一次——宿主终端往 PYTHONPATH 注入了 sitecustomize 删除拦截，
// AstrBot 每处理完一张图片就要 cleanup_temporary_local_files() 删临时图，
// 结果被拦截直接 SystemExit(1)，表现为「发完图机器人就不回消息了」。
// （根因已在 startAstrbot 里清掉 shim，这里是兜底：万一它还是没了，自动拉回来。）
const astrbotGuard = {
  timer: null,
  restarts: 0,
  maxRestarts: 10,
  lastStart: 0,
  armed: false,
  missed: 0, // 连续探测不到面板的次数
};

function armAstrbotGuard() {
  astrbotGuard.armed = true;
  astrbotGuard.lastStart = Date.now();
  clearGuardDisarm();
  if (astrbotGuard.timer) return;
  astrbotGuard.timer = setInterval(async () => {
    if (!astrbotGuard.armed) return;
    if (guardsDisarmed()) {
      astrbotGuard.armed = false;
      return;
    }
    const alive = await portAlive(d.DASHBOARD_PORT || 16885);
    if (alive) {
      astrbotGuard.missed = 0;
      // 面板真的起来了，清掉启动标记，关闭「正在启动中」窗口，允许再次手动启动
      try {
        const bf = path.join(d.WORK_DIR, '.astrbot_booting');
        if (fs.existsSync(bf)) fs.unlinkSync(bf);
      } catch (_) {}
      return;
    }
    astrbotGuard.missed += 1;
    // 冷启动要 30~40 秒，给足宽限；连续 4 次（约 2 分钟）探测不到才判定真挂了
    if (Date.now() - astrbotGuard.lastStart < 120000) return;
    if (astrbotGuard.missed < 4) return;
    if (astrbotGuard.restarts >= astrbotGuard.maxRestarts) {
      console.log(`[守护] AstrBot 已自动重启 ${astrbotGuard.restarts} 次仍不稳定，停止自动重启（请手动点「启动」）`);
      clearInterval(astrbotGuard.timer);
      astrbotGuard.timer = null;
      astrbotGuard.armed = false;
      return;
    }
    try {
      astrbotGuard.restarts += 1;
      astrbotGuard.lastStart = Date.now();
      astrbotGuard.missed = 0;
      console.log(`[守护] AstrBot 面板已失联，第 ${astrbotGuard.restarts} 次自动重启`);
      await d.startAstrbot();
    } catch (e) {
      console.log(`[守护] AstrBot 自动重启失败: ${e.message}`);
    }
  }, 30000);
}

// 守护状态也暴露给前端，让用户能看到"系统在自动重试"，而不是以为卡死了
// （真实现：/api/status 返回 napcatGuard / astrbotGuard 字段）

// 面板整站代理（同源，绝对路径全部正确，不会白屏）
startAstrbotProxyServer();
