// app.js —— 大肥鱼一键包向导前端逻辑（原生 JS，无框架）
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// 服务商预设：优先从后端 /api/presets 拉（只有一份真相），拉不到再用这份兜底
const PRESET_FALLBACK = {
  deepseek: {
    apiBase: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    vision: false,
    captionModel: '',
    note: 'deepseek-chat 是纯文本模型，直接丢图片会报错。想看图请改用硅基流动，或在下面另填视觉模型。',
  },
  siliconflow: {
    apiBase: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    vision: false,
    captionModel: 'Qwen/Qwen2.5-VL-7B-Instruct',
    note: '一把 Key 通用全部模型：聊天用 DeepSeek-V3，识图自动挂 Qwen2.5-VL。',
  },
  dashscope: {
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    vision: false,
    captionModel: 'qwen-vl-max',
    note: '一把 Key 通用 qwen 全系；识图自动挂 qwen-vl-max。',
  },
  openai: {
    apiBase: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    vision: true,
    captionModel: '',
    note: 'gpt-4o / gpt-4.1 原生支持图片，图片直接交给主模型看，不用额外配识图模型。',
  },
  ollama: {
    apiBase: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    vision: false,
    captionModel: '',
    note: '需要本机已装 Ollama 并提前 ollama pull 好模型。识图会在部署时自动探测本机视觉模型。',
    local: true,
  },
  custom: {
    apiBase: '',
    model: '',
    vision: false,
    captionModel: '',
    note: '适用于 OneAPI / NewAPI / 各类中转站。Base URL 一般以 /v1 结尾，模型名照抄服务商文档。',
  },
};
let PRESETS = PRESET_FALLBACK;
// 用户手动改过的字段在切换服务商时才不覆盖
const dirty = { apiBase: false, model: false, captionModel: false };

let current = 0;
let maxVisited = 0; // 到过的最远步骤：只有走过的步骤才能点回去
let lastConfig = {};

const STEP_TITLES = ['须知', '环境检查', '安装 AstrBot', '填写模型', '大肥鱼人设', '登录 QQ', '完成'];

function goStep(n) {
  current = n;
  maxVisited = Math.max(maxVisited, n);
  $$('.panel').forEach((p) => p.classList.toggle('active', +p.dataset.panel === n));
  $$('.steps li').forEach((li) => {
    const s = +li.dataset.step;
    li.classList.toggle('active', s === n);
    // done 以"到过的最远步"为准，往回走时前面的步骤不会突然变灰
    li.classList.toggle('done', s < maxVisited && s !== n);
    li.classList.toggle('clickable', s !== n && s <= maxVisited);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  refreshBanner();
}

// ---------- 导航：步骤条可点 + 每步都有「上一步」 ----------
// 之前只有「下一步」，用户在第 ⑤ 步发现 AstrBot 没装就回不去了，
// 弹窗说"返回安装"其实无处可返。这里把两条路都补上。
function initNav() {
  // ① 顶部步骤条：到过的步骤都能点回去
  $$('.steps li').forEach((li) => {
    li.addEventListener('click', () => {
      const s = +li.dataset.step;
      if (s === current) return;
      if (s <= maxVisited) goStep(s);
    });
  });

  // ② 每个面板底部注入「‹ 上一步」（放最后一个按钮组里，位置最自然）
  $$('.panel').forEach((p) => {
    const step = +p.dataset.panel;
    if (step === 0) return;
    const blocks = p.querySelectorAll('.actions');
    if (!blocks.length) return;
    const host = blocks[blocks.length - 1];
    if (host.querySelector('.nav-prev')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost nav-prev';
    btn.textContent = '‹ 上一步';
    btn.title = '回到「' + STEP_TITLES[step - 1] + '」';
    btn.addEventListener('click', () => goStep(Math.max(0, step - 1)));
    host.prepend(btn);
  });
}

// ---------- 自定义确认框 ----------
// 浏览器原生 confirm 长得丑、按钮主次不分，用户很容易手滑点掉。
// 这里把「安全选项」（返回去装）做成主按钮并默认聚焦，「跳过」做成弱化的次要按钮。
let modalResolve = null;
let modalBackStep = null; // 点「返回」时要不要顺便跳步（比如"带我去安装"）

function showConfirm({
  title,
  body,
  icon = '⚠️',
  backText = '返回安装',
  skipText = '仍然跳过',
  backStep = null,
  allowSkip = true, // false = 硬拦截：只留一个"知道了"，不给跳过
}) {
  return new Promise((resolve) => {
    $('#modalIcon').textContent = icon;
    $('#modalTitle').textContent = title;
    $('#modalBody').textContent = body;
    $('#modalBack').textContent = backText;
    $('#modalSkip').textContent = skipText;
    $('#modalSkip').style.display = allowSkip ? '' : 'none';
    modalBackStep = backStep;
    $('#modalMask').classList.add('show');
    $('#modalMask').setAttribute('aria-hidden', 'false');
    modalResolve = resolve;
    // 焦点落在"返回安装"上：手滑按回车也是安全选项
    setTimeout(() => {
      try { $('#modalBack').focus(); } catch (_) {}
    }, 40);
  });
}

function closeModal(result, doJump) {
  $('#modalMask').classList.remove('show');
  $('#modalMask').setAttribute('aria-hidden', 'true');
  const r = modalResolve;
  const target = modalBackStep;
  modalResolve = null;
  modalBackStep = null;
  if (r) r(result === true || result === false ? result : false);
  // 仅当显式点「带我去安装 / 知道了，我去装」主按钮(doJump)才跳到对应步骤；
  // 点遮罩、Esc、右上角×只关闭弹窗 —— 避免「想关掉却跳走」的错觉（即"关不上"的根因）。
  if (doJump && target !== null && target !== undefined) goStep(target);
}

$('#modalBack').addEventListener('click', () => closeModal(false, true));
$('#modalSkip').addEventListener('click', () => closeModal(true, false));
$('#modalClose').addEventListener('click', () => closeModal(false, false));
$('#modalMask').addEventListener('click', (e) => {
  if (e.target === $('#modalMask')) closeModal(false, false); // 点遮罩只关，不跳
});
document.addEventListener('keydown', (e) => {
  if (!$('#modalMask').classList.contains('show')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal(false, false); // Esc 只关，不跳
  }
});

// ---------- 顶部状态横幅 ----------
// 用户跳着点也能一直看到"还差什么"，不会点到最后还以为装好了。
let bannerDismissed = false;
let bannerAt = 0;

function renderBannerFromStatus(st) {
  const el = $('#statusBanner');
  if (!el || !st) return;
  const missing = [];
  if (!st.astrbot) missing.push('AstrBot');
  if (!st.napcat) missing.push('NapCat');
  if (!st.configExists) missing.push('模型配置');
  if (!missing.length || bannerDismissed) {
    el.style.display = 'none';
    return;
  }
  el.innerHTML =
    '<span>⚠️</span><span>还差 <b>' +
    missing.join('、') +
    '</b> 没完成 —— 走完对应步骤才能正常聊天</span><button class="banner-x" title="收起">✕</button>';
  el.style.display = 'flex';
  const x = el.querySelector('.banner-x');
  if (x) {
    x.onclick = () => {
      bannerDismissed = true;
      el.style.display = 'none';
    };
  }
}

async function refreshBanner(force) {
  const el = $('#statusBanner');
  if (!el) return;
  const now = Date.now();
  if (!force && now - bannerAt < 2500) return; // 2.5 秒内不重复请求
  bannerAt = now;
  let st = null;
  try {
    st = await api('/api/status');
  } catch (_) {
    el.style.display = 'none';
    return;
  }
  renderBannerFromStatus(st);
}

async function api(path, method = 'GET', body) {
  // 本次进程的随机 token 由后端注入到 index.html（window.__DFY_TOKEN__）。
  // 只校验 token 不够，后端还校验 Host 为 127.0.0.1/localhost，并只绑回环地址。
  const token = (typeof window !== 'undefined' && window.__DFY_TOKEN__) || '';
  const opt = { method, headers: { 'X-DaFeiYu-Wizard': token } };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  // 402 = PRO 功能未激活：直接弹激活框，别让用户对着一个没反应的按钮发呆
  if (r.status === 402 && j && j.needLicense) {
    if (typeof openLicense === 'function') openLicense(j.reason || `「${j.feature || '该功能'}」是 PRO 功能，请输入授权码激活。`);
    const e = new Error(j.reason || '需要激活 PRO');
    e.needLicense = true;
    throw e;
  }
  return j;
}

// ---------- 安装进度（SSE 实时推送）----------
// 两个环节各有自己的进度条（第①步"环境" / 第②步"安装"），互不干扰：
// 以前按 class 全局更新，点第①步的按钮第②步的条也会动，看起来像出了 bug。
// 现在用 data-scope 隔离，进度只画到你点按钮的那一页。
const STEP_LABEL = {
  uv: '准备运行环境（uv + Python）',
  astrbot: '安装 AstrBot',
  napcat: '安装 NapCat',
  ffmpeg: '准备语音组件 ffmpeg',
};
const progressLines = { env: [], install: [] }; // 各自记最近几条

// 当前进度该画在哪一页（由"在哪个面板点的按钮"决定）
let activeScope = 'install';
function setScope(s) {
  activeScope = s;
  progressLines[s].length = 0;
}

function paintProgress(scope, o) {
  const root = document.querySelector('.progress-wrap[data-scope="' + scope + '"]');
  if (!root) return;
  const pct = Math.max(0, Math.min(100, Math.round(o.percent || 0)));
  const indet = !!o.indeterminate && !o.done && !o.fail;
  const fill = root.querySelector('.progress-fill');
  fill.classList.toggle('indeterminate', indet);
  fill.classList.toggle('done', !!o.done);
  fill.classList.toggle('fail', !!o.fail);
  fill.style.width = indet ? '100%' : pct + '%';

  const pctEl = root.querySelector('.progress-pct');
  pctEl.textContent = o.fail ? '失败' : o.done ? '完成' : indet ? '进行中' : pct + '%';

  if (o.phase) {
    root.querySelector('.progress-phase').textContent = o.phase;
    const lines = progressLines[scope];
    if (lines[lines.length - 1] !== o.phase) {
      lines.push(o.phase);
      if (lines.length > 3) lines.shift();
    }
    root.querySelector('.progress-sub').textContent = lines.join('  ·  ');
  }
}

function onProgressEvent(ev) {
  if (ev.kind === 'step') {
    if (ev.state === 'start') {
      paintProgress(activeScope, { phase: ev.name + '…', percent: 0, indeterminate: true });
    }
    return;
  }
  if (ev.kind !== 'progress') return;
  paintProgress(activeScope, {
    phase: ev.phase || STEP_LABEL[ev.step] || ev.step,
    percent: ev.percent,
    indeterminate: ev.indeterminate,
    done: ev.done,
  });
}

function connectProgress() {
  try {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        onProgressEvent(JSON.parse(e.data));
      } catch (_) {}
    };
    // EventSource 自带重连，onerror 不用处理
    return es;
  } catch (_) {
    return null;
  }
}

function progressFail(scope, msg) {
  paintProgress(scope, { phase: msg || '安装失败', percent: 100, fail: true });
}
function progressReset(scope, phase) {
  progressLines[scope].length = 0;
  paintProgress(scope, { phase: phase || '等待开始…', percent: 0, indeterminate: false });
}

// 进页面时按真实状态把两条进度条摆好：已经完成的显示绿色"已就绪"，
// 而不是一直挂着"等待开始…"（那样看不出哪些其实早装好了）
function initProgressFromStatus(st) {
  if (!st) return;
  if (st.uv && st.napcat) {
    paintProgress('env', { phase: '环境已就绪（uv / Python / NapCat 都在）', percent: 100, done: true });
  } else if (st.uv) {
    paintProgress('env', { phase: 'uv / Python 已就绪，NapCat 还没装', percent: 60 });
  } else {
    paintProgress('env', { phase: '等待开始…', percent: 0 });
  }
  if (st.astrbot && st.initialized) {
    paintProgress('install', { phase: 'AstrBot 已安装并初始化', percent: 100, done: true });
  } else if (st.astrbot) {
    paintProgress('install', { phase: 'AstrBot 已安装，还没初始化', percent: 80 });
  } else {
    paintProgress('install', { phase: '等待开始…', percent: 0 });
  }
}

// 0 须知
$('#eula').addEventListener('change', (e) => {
  $('#toEnv').disabled = !e.target.checked;
});
$('#toEnv').addEventListener('click', () => goStep(1));

// 1 环境：拉 /api/status，渲染清单，已装的禁用对应按钮（不重复安装）
function renderStatus(r) {
  const map = {
    uv: r.uv,
    python: r.python,
    astrbot: r.astrbot,
    configExists: r.configExists,
    napcat: r.napcat,
  };
  $$('#envChecklist .row').forEach((row) => {
    const key = row.dataset.key;
    const ok = map[key];
    const dot = row.querySelector('.dot');
    const badge = row.querySelector('.badge');
    dot.textContent = ok ? '✅' : '❌';
    badge.textContent = ok ? '可跳过' : '需处理';
    badge.className = 'badge ' + (ok ? 'skip' : 'need');
  });
  // 已装 -> 禁用安装按钮，避免重复装
  $('#installPre').disabled = r.uv; // uv 装好即 Python 也有保障
  $('#installAstr').disabled = r.steps.astrbot;
  $('#installNap').disabled = r.napcat;
  $('#installAstr').textContent = r.steps.astrbot ? 'AstrBot 已就绪 ✓' : '装/确认 AstrBot';
  $('#installNap').textContent = r.napcat ? 'NapCat 已就绪 ✓' : '一键装 NapCat';
  // 一键安装主按钮：全就绪就"退休"，否则始终是环境页最显眼的那颗
  if ($('#installAll')) {
    const allReady = r.uv && r.steps.astrbot && r.napcat;
    $('#installAll').disabled = allReady;
    $('#installAll').textContent = allReady ? '✅ 全部已就绪，点「下一步」继续' : '🚀 一键安装全部（推荐）';
  }

  // 后台有安装任务在跑（比如刷新页面前点的安装，或另一个标签页点的）：
  // 全部禁用 + 明说，否则用户再点一次就会起第二个并发任务 ——
  // 两个下载互相覆盖、两路进度交错，就是"进度条乱跳"的根源
  if (r.busy) {
    ['#installPre', '#installAstr', '#installNap', '#resetEnv'].forEach((sel) => ($(sel).disabled = true));
    $('#installNap').textContent = `⏳ 正在${r.busy}…（请勿重复点击）`;
    $('#installAstr').textContent = `⏳ 正在${r.busy}…`;
    paintProgress('env', { phase: `正在${r.busy}，请稍等（可离开此页，任务会在后台跑完）`, percent: 60, indeterminate: true });
  }
}

let progressInited = false;

/* ================= 环境体检 =================
   为什么单独做这一步：开发机上跑通不代表用户机器上跑通。
   磁盘满、端口被别的软件占、杀软把 node.exe 隔离、用户名是中文、
   公司代理断网——这些都不是代码 bug，用户看到的只有"点了没反应"。
   体检把这些问题在安装前摆出来，并给一句能照做的处理办法。 */
let pfData = null;

function renderPreflight(r) {
  pfData = r;
  const list = $('#pfList');
  const sum = $('#pfSummary');
  if (!r || !r.items) {
    list.innerHTML = '<div class="pf-empty">体检未完成（可点「重新体检」再试一次）</div>';
    sum.textContent = '';
    return;
  }
  const { block, warn, ok } = r.summary;
  sum.textContent = block
    ? `⚠️ ${block} 项必须先处理，否则装不上`
    : warn
    ? `⚠️ ${warn} 项有风险（可继续，但可能缺功能）`
    : `✅ 全部 ${ok} 项正常`;
  sum.style.color = block ? 'var(--err)' : warn ? 'var(--warm)' : 'var(--ok)';

  const ICON = { block: '⛔', warn: '⚠️', ok: '✅' };
  const bad = r.items.filter((i) => i.level !== 'ok');
  const good = r.items.filter((i) => i.level === 'ok');

  const rowHtml = (it, hidden) => {
    const btn = it.port
      ? `<button class="pf-fixbtn" data-port="${it.port}">释放端口</button>`
      : '';
    return `<div class="pf-item pf-${it.level}"${hidden ? ' style="display:none"' : ''}>
      <span class="pf-ico">${ICON[it.level]}</span>
      <div class="pf-body">
        <div class="pf-name">${it.title}</div>
        <div class="pf-detail">${it.detail || ''}</div>
        ${it.fix ? `<div class="pf-fix">→ ${it.fix}</div>` : ''}
      </div>
      ${btn}
    </div>`;
  };

  list.innerHTML =
    (bad.length ? bad.map((i) => rowHtml(i, false)).join('') : '<div class="pf-skip">未发现会影响安装的问题 ✅</div>') +
    (good.length
      ? good.map((i) => rowHtml(i, true)).join('') +
        `<button class="pf-more" id="pfMore">展开其余 ${good.length} 项正常项</button>`
      : '');

  const more = $('#pfMore');
  if (more) {
    let open = false;
    more.addEventListener('click', () => {
      open = !open;
      // 只切换正常项（.pf-ok）的显隐，别把必须处理的项也藏起来
      $$('#pfList .pf-item.pf-ok').forEach((el) => (el.style.display = open ? '' : 'none'));
      more.textContent = open ? '收起正常项' : `展开其余 ${good.length} 项正常项`;
    });
  }
  $$('#pfList .pf-fixbtn').forEach((b) => {
    b.addEventListener('click', async () => {
      const port = b.dataset.port;
      b.disabled = true;
      b.textContent = '释放中…';
      const r2 = await api('/api/kill-port', 'POST', { port }).catch((e) => ({ ok: false, error: e.message }));
      b.textContent = r2.ok ? '已释放' : '失败';
      if (!r2.ok) b.disabled = false;
      setTimeout(runPreflight, 800);
    });
  });
}

async function runPreflight({ quiet = false } = {}) {
  const list = $('#pfList');
  const sum = $('#pfSummary');
  if (!quiet) {
    list.innerHTML = '<div class="pf-empty">正在体检…</div>';
    sum.textContent = '正在体检…';
    sum.style.color = '';
  }
  const r = await api('/api/preflight').catch((e) => ({ error: e.message }));
  if (r && r.items) renderPreflight(r);
  else {
    list.innerHTML = `<div class="pf-empty">体检失败：${(r && r.error) || '未知错误'}</div>`;
    sum.textContent = '';
  }
}

async function checkEnv() {
  const r = await api('/api/status');
  renderStatus(r);
  renderBannerFromStatus(r); // 复用这次结果，不额外发请求
  // 只在首次渲染时按真实状态初始化两条进度条（之后别覆盖正在跑的进度）
  if (!progressInited) {
    progressInited = true;
    initProgressFromStatus(r);
    runPreflight(); // 首次进环境页顺手体检一次
  }
}

$('#checkEnv').addEventListener('click', checkEnv);
$('#runPreflight').addEventListener('click', () => runPreflight());
$('#makeDiag').addEventListener('click', async () => {
  const b = $('#makeDiag');
  b.disabled = true;
  b.textContent = '生成中…';
  const r = await api('/api/diag', 'POST').catch((e) => ({ ok: false, error: e.message }));
  b.disabled = false;
  b.textContent = '生成诊断报告';
  if (r.ok) {
    showConfirm({
      icon: '✅',
      title: '诊断报告已生成',
      body: `文件名：${r.name}\n位置：${r.dir}\n（文件夹已自动打开）\n\n把这份文件发给客服即可排查。报告里的 API Key、面板密码、手机号、邮箱已自动打码。`,
      backText: '知道了',
      allowSkip: false,
    });
  } else {
    showConfirm({ icon: '❌', title: '生成失败', body: r.error || '未知错误', backText: '知道了', allowSkip: false });
  }
});

$('#installPre').addEventListener('click', async () => {
  setScope('env');
  const btn = $('#installPre');
  btn.disabled = true;
  btn.textContent = '安装 uv/Python 中…';
  progressReset('env', '准备安装 uv + Python…');
  let r;
  try {
    r = await api('/api/install-uv', 'POST');
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (r.ok) {
    btn.textContent = '✅ uv 完成';
    paintProgress('env', { phase: 'uv 就绪', percent: 100, done: true });
  } else if (r.busy) {
    btn.textContent = '⏳ 正在安装中…';
    paintProgress('env', { phase: r.error, percent: 60, indeterminate: true });
  } else {
    btn.textContent = '❌ 失败：' + (r.error || '');
    progressFail('env', r.error || 'uv 安装失败');
  }
  btn.disabled = false;
  setTimeout(checkEnv, 800);
});

$('#installAstr').addEventListener('click', async () => {
  setScope('env');
  const btn = $('#installAstr');
  btn.disabled = true;
  btn.textContent = '安装/确认 AstrBot 中…（首次约 40 秒，会自动选最快的下载源）';
  progressReset('env', '准备安装 AstrBot…');
  let r;
  try {
    r = await api('/api/install-astrbot', 'POST');
    await api('/api/init', 'POST');
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (r.busy) {
    btn.textContent = '⏳ 正在安装中…';
    paintProgress('env', { phase: r.error, percent: 60, indeterminate: true });
    btn.disabled = false;
    return;
  }
  if (r.ok) paintProgress('env', { phase: 'AstrBot 就绪', percent: 100, done: true });
  else progressFail('env', r.error || 'AstrBot 安装失败');
  btn.disabled = false;
  btn.textContent = '装/确认 AstrBot';
  checkEnv();
});

$('#installNap').addEventListener('click', async () => {
  setScope('env');
  const btn = $('#installNap');
  btn.disabled = true;
  btn.textContent = '正在下载并解压 NapCat…（约 34MB）';
  progressReset('env', '准备下载 NapCat…');
  let r;
  try {
    r = await api('/api/install-napcat', 'POST');
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (r.ok) {
    paintProgress('env', { phase: 'NapCat 安装完成', percent: 100, done: true });
    btn.textContent = '✅ NapCat 已就绪';
  } else if (r.busy) {
    // 后端正在装别的（或同一个任务）：不是错误，等它跑完就好
    paintProgress('env', { phase: r.error || '正在安装中，请稍等', percent: 60, indeterminate: true });
    btn.textContent = '⏳ 正在安装中…';
  } else {
    progressFail('env', r.error || 'NapCat 安装失败');
    btn.textContent = '❌ 失败：' + (r.error || '');
  }
  btn.disabled = false;
  setTimeout(checkEnv, 800); // 无论成败都刷新一次状态（成功后按钮会变"已就绪"）
});

$('#toInstall').addEventListener('click', () => goStep(2));

// 一键安装全部：交给后端 install-plan（带步骤状态/超时/回滚）。
// 已经装好的步骤会由各 install 函数自动跳过；单独的按钮保留给高级用户。
$('#installAll').addEventListener('click', async () => {
  setScope('env');
  const btn = $('#installAll');
  btn.disabled = true;
  ['#installPre', '#installAstr', '#installNap', '#resetEnv', '#toInstall'].forEach((s) => ($(s).disabled = true));
  progressReset('env', '开始一键安装…');
  btn.textContent = '一键安装中，请勿关闭…';
  let failMsg = '';
  try {
    const r = await api('/api/install-all', 'POST');
    if (!r || !r.ok) {
      failMsg = (r && (r.error || r.remediation)) || '安装失败';
    }
  } catch (e) {
    failMsg = e.message || '安装失败';
  }

  if (failMsg) {
    progressFail('env', failMsg);
    btn.textContent = '❌ ' + failMsg.slice(0, 46);
  } else {
    paintProgress('env', { phase: '全部安装完成！可以点「下一步」继续', percent: 100, done: true });
    btn.textContent = '✅ 全部就绪';
  }
  btn.disabled = false;
  $('#toInstall').disabled = false;
  setTimeout(checkEnv, 600);
});

// 清空重来：只清沙盒数据（配置/人设/NapCat/ffmpeg），AstrBot 程序保留，
// 所以清完再装很快。用于反复测试，或用户搞坏了自助重置。
$('#resetEnv').addEventListener('click', async () => {
  const ok = await showConfirm({
    icon: '🧹',
    title: '清空当前环境？',
    body:
      '会删掉：AstrBot 的配置和人设、NapCat、ffmpeg、全部聊天数据。\n\n' +
      '会保留：AstrBot 程序本体、uv、你的 QQ 登录状态。\n\n' +
      '这一步不可撤销，清完就要从第 ② 步重新装。',
    backText: '取消',
    skipText: '确认清空',
  });
  if (!ok) return; // ok=true 表示点了"确认清空"

  const btn = $('#resetEnv');
  btn.disabled = true;
  btn.textContent = '清空中…';
  progressReset('env', '正在清空环境…');
  try {
    const r = await api('/api/reset', 'POST', { confirm: '清空环境' });
    if (!r || r.ok === false) {
      progressFail('env', (r && r.error) || '清空失败');
      btn.textContent = '清空失败';
      return;
    }
    progressInited = false; // 让进度条按新状态重画
    progressReset('env', '环境已清空，可以重新开始了');
    paintProgress('install', { phase: '等待开始…', percent: 0 });
    bannerDismissed = false;
    await checkEnv();
    btn.textContent = '✅ 已清空';
    $('#installLog').textContent = '环境已清空。点上方的「安装并初始化」重新开始。';
  } catch (e) {
    progressFail('env', '清空失败：' + e.message);
    btn.textContent = '清空失败';
  } finally {
    btn.disabled = false;
    setTimeout(() => (btn.textContent = '清空重来'), 2500);
  }
});

// 2 安装
$('#doInstall').addEventListener('click', async () => {
  setScope('install');
  const btn = $('#doInstall');
  btn.disabled = true;
  progressReset('install', '准备安装 AstrBot…');
  $('#installLog').textContent = '安装 AstrBot 中（首次约 40 秒，会自动选最快的下载源）…';
  const r1 = await api('/api/install-astrbot', 'POST');
  $('#installLog').textContent += '\n[install] ' + (r1.ok ? (r1.skipped ? '已安装，跳过' : 'OK') : 'FAIL ' + (r1.error || ''));
  if (!r1.ok) {
    progressFail('install', r1.error || 'AstrBot 安装失败');
    btn.disabled = false;
    return;
  }
  paintProgress('install', { phase: '正在初始化数据目录…', percent: 96, indeterminate: true });
  $('#installLog').textContent += '\n初始化数据目录…';
  const r2 = await api('/api/init', 'POST');
  $('#installLog').textContent += '\n[init] ' + (r2.ok ? (r2.skipped ? '已初始化，跳过' : 'OK') : 'FAIL ' + (r2.error || ''));
  if (r2.ok) {
    $('#installLog').textContent += '\n✅ AstrBot 就绪，可下一步。';
    paintProgress('install', { phase: 'AstrBot 已就绪', percent: 100, done: true });
  } else {
    progressFail('install', r2.error || '初始化失败');
  }
  btn.disabled = false;
  checkEnv();
});
$('#toModel').addEventListener('click', async () => {
  // 硬拦截：AstrBot 必须「装上 + 初始化完」才允许往后走。
  // 只装不 init 的话没有数据库，后面人设注入、插件配置全会失败。
  let st = null;
  try {
    st = await api('/api/status');
  } catch (_) {
    /* 查不到状态就别拦着，可能是后端刚重启 */
  }
  if (st && !st.steps.astrbot) {
    const why = !st.astrbot
      ? 'AstrBot 还没安装。'
      : 'AstrBot 装了，但还没初始化（没生成配置文件）。';
    await showConfirm({
      icon: '⛔',
      title: '这一步还没做完',
      body:
        why +
        '\n\n请先点本页的「安装并初始化」，等进度条走完（约 40 秒）再点下一步。\n\n' +
        '跳过这步的话，后面的模型配置、人设注入都会失败，机器人在 QQ 里也不会说话。',
      backText: '知道了，我去装',
      allowSkip: false,
      backStep: 2,
    });
    return;
  }
  goStep(3);
});

// 3 模型
// 服务商下拉从后端拉预设，保证模型名/地址永远跟后端一致（写死过时模型名会 404）
async function loadPresets() {
  try {
    const r = await api('/api/presets');
    if (r && r.presets && Object.keys(r.presets).length) {
      const next = {};
      for (const [id, p] of Object.entries(r.presets)) {
        next[id] = {
          apiBase: p.api_base || '',
          model: p.default_model || '',
          vision: !!p.vision,
          captionModel: p.caption_model || '',
          note: p.note || '',
          local: !!p.local,
          label: p.label || id,
        };
      }
      PRESETS = next;
      const sel = $('#provider');
      const cur = sel.value;
      sel.innerHTML = '';
      for (const [id, p] of Object.entries(next)) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = p.label;
        sel.appendChild(o);
      }
      if (next[cur]) sel.value = cur;
    }
  } catch (_) {
    /* 后端没起来时用内置兜底 */
  }
  syncPreset(true);
}

function syncPreset(resetDirty) {
  if (resetDirty) {
    dirty.apiBase = dirty.model = dirty.captionModel = false;
  }
  const p = $('#provider').value;
  const cfg = PRESETS[p] || {};
  if (!dirty.apiBase) $('#apiBase').value = cfg.apiBase || '';
  if (!dirty.model) $('#model').value = cfg.model || '';
  if (!dirty.captionModel) $('#captionModel').value = cfg.captionModel || '';
  $('#modelVision').checked = !!cfg.vision;
  $('#presetNote').textContent = cfg.note || '';
  // 纯文本的云端服务商：默认展开识图设置，免得用户不知道这里有开关
  $('#visionBox').open = !cfg.vision && !cfg.local;
  const localHint = cfg.local
    ? '本地模式下，识图模型留空会自动探测本机已装的视觉模型（如 qwen2.5vl）。'
    : '主模型是纯文本时，可以另配一个视觉模型，把图片先转成文字再交给主模型。';
  $('#visionHint').textContent = localHint;
  if (p === 'freellmapi') {
    $('#apiKey').placeholder = 'freellmapi-...（在 FreeLLMAPI 的 Keys 页顶部复制）';
  } else if (cfg.local) {
    $('#apiKey').placeholder = 'Ollama 不需要 Key，留空即可';
  } else {
    $('#apiKey').placeholder = 'sk-...（去服务商后台复制）';
  }
}
$('#provider').addEventListener('change', () => syncPreset(true));
// 用户编辑后不再自动覆盖
$('#apiBase').addEventListener('input', () => (dirty.apiBase = true));
$('#model').addEventListener('input', () => (dirty.model = true));
$('#captionModel').addEventListener('input', () => (dirty.captionModel = true));
$('#modelVision').addEventListener('change', () => {
  // 勾了"能直接看图"就没必要再配识图模型
  if ($('#modelVision').checked) $('#visionBox').open = false;
});

function collectModelForm() {
  return {
    provider: $('#provider').value,
    apiKey: $('#apiKey').value.trim(),
    apiBase: $('#apiBase').value.trim(),
    model: $('#model').value.trim(),
    modelVision: $('#modelVision').checked,
    captionModel: $('#captionModel').value.trim(),
    captionApiBase: $('#captionApiBase').value.trim(),
    captionApiKey: $('#captionApiKey').value.trim(),
  };
}

// 部署前自检：Key / 模型名 / 地址错一个，用户都要等到"机器人不回话"才发现
$('#testProvider').addEventListener('click', async () => {
  const el = $('#configMsg');
  const btn = $('#testProvider');
  btn.disabled = true;
  btn.textContent = '测试中…';
  el.className = 'msg';
  el.textContent = '正在向服务商发一次最小请求，最多等 25 秒…';
  try {
    const r = await api('/api/test-provider', 'POST', collectModelForm());
    if (r.ok) {
      el.className = 'msg ok';
      el.textContent = `✅ ${r.message}　模型：${r.model}`;
      // 连通成功顺手拉模型列表，把"手打模型名"变成"下拉里挑"
      fetchModelList({ quiet: true });
    } else {
      el.className = 'msg err';
      el.textContent = `❌ ${r.error || '连接失败'}${r.detail ? '\n服务商返回：' + r.detail : ''}`;
    }
  } catch (e) {
    el.className = 'msg err';
    el.textContent = '❌ 测试请求没发出去：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
});

// ---------- 自动获取可用模型 ----------
function fillDatalist(sel, items) {
  const dl = $(sel);
  if (!dl) return;
  dl.innerHTML = '';
  items.slice(0, 400).forEach((id) => {
    const o = document.createElement('option');
    o.value = id;
    dl.appendChild(o);
  });
}

let lastModelList = null;

async function fetchModelList({ quiet } = {}) {
  const el = $('#configMsg');
  const btn = $('#fetchModels');
  if (!quiet) {
    btn.disabled = true;
    btn.textContent = '获取中…';
    el.className = 'msg';
    el.textContent = '正在向服务商查询可用模型列表…';
  }
  try {
    const r = await api('/api/list-models', 'POST', collectModelForm());
    if (!r.ok) {
      if (!quiet) {
        el.className = 'msg err';
        el.textContent = `❌ ${r.error || '获取失败'}${r.detail ? '\n' + r.detail : ''}（也可以直接手填模型名）`;
      }
      return null;
    }
    lastModelList = r;
    fillDatalist('#modelOptions', r.chat);
    fillDatalist('#captionOptions', r.vision);

    // 智能纠错：当前模型不在服务商列表里（多半拼错了），自动换成推荐的
    const notes = [];
    const curModel = $('#model').value.trim();
    const rec = r.recommend || {};
    if (rec.model) {
      if (!curModel) {
        $('#model').value = rec.model;
        notes.push(`已自动选择主模型 ${rec.model}`);
      } else if (!r.chat.includes(curModel) && !r.vision.includes(curModel)) {
        $('#model').value = rec.model;
        notes.push(`「${curModel}」不在该服务商列表里，已换成 ${rec.model}`);
      }
    }
    const curCap = $('#captionModel').value.trim();
    if (rec.captionModel) {
      if (!curCap) {
        $('#captionModel').value = rec.captionModel;
        notes.push(`识图模型 ${rec.captionModel}`);
      } else if (!r.vision.includes(curCap)) {
        $('#captionModel').value = rec.captionModel;
        notes.push(`识图模型「${curCap}」不可用，已换成 ${rec.captionModel}`);
      }
    }
    // 主模型本身能看图就直接勾上，省掉一次转述
    if (rec.modelVision) $('#modelVision').checked = true;

    el.className = 'msg ok';
    el.textContent =
      `✅ 找到 ${r.count} 个模型（可用聊天 ${r.chat.length} 个 / 能看图 ${r.vision.length} 个）` +
      (notes.length ? '\n' + notes.join('；') : '') +
      (r.vision.length ? '' : '\n⚠️ 这家没有视觉模型，想看图的请改用硅基流动或阿里百炼。');
    return r;
  } catch (e) {
    if (!quiet) {
      el.className = 'msg err';
      el.textContent = '❌ 获取模型列表失败：' + e.message;
    }
    return null;
  } finally {
    if (!quiet) {
      btn.disabled = false;
      btn.textContent = '获取可用模型';
    }
  }
}

$('#fetchModels').addEventListener('click', () => fetchModelList({ quiet: false }));

// 第一次点"写入"会先自检；自检失败则拦下并提示再点一次可强写
let allowWriteWithoutTest = false;

$('#writeConfig').addEventListener('click', async () => {
  const body = collectModelForm();
  lastConfig = body;
  const el = $('#configMsg');

  if (!allowWriteWithoutTest) {
    el.className = 'msg';
    el.textContent = '正在验证连接…';
    try {
      const t = await api('/api/test-provider', 'POST', body);
      if (!t.ok) {
        allowWriteWithoutTest = true;
        el.className = 'msg err';
        el.textContent =
          `❌ 连接失败：${t.error || '未知错误'}\n` +
          `请先修正上面的 Key / 模型名 / 地址（或点「测试连接」看详情）。\n` +
          `确实想跳过验证直接写入？再点一次这个按钮即可。`;
        return;
      }
      el.className = 'msg ok';
      el.textContent = `✅ ${t.message}，正在写入配置…`;
    } catch (e) {
      allowWriteWithoutTest = true;
      el.className = 'msg err';
      el.textContent = `❌ 验证请求失败：${e.message}\n再点一次可跳过验证直接写入。`;
      return;
    }
  }

  el.className = 'msg';
  el.textContent = '正在写入配置…';
  try {
    const r = await api('/api/configure', 'POST', body);
    if (r.ok) {
      el.className = 'msg ok';
      const v = r.config && r.config.visionHint;
      el.textContent = '✅ 模型配置已写入 AstrBot' + (v ? '　' + v : '') + '，正在进入人设…';
      setTimeout(() => goStep(4), 900);
    } else {
      el.className = 'msg err';
      el.textContent = '❌ 写入失败：' + (r.error || JSON.stringify(r)) + '（你也可在 AstrBot 仪表盘手动配置后点“暂不写入，下一步”）';
    }
  } catch (e) {
    el.className = 'msg err';
    el.textContent = '❌ 请求失败：' + e.message + '（服务是否在运行？也可直接在仪表盘配置后点“暂不写入，下一步”）';
  }
});

// 兜底：即使不从向导写配置，也能前进到“人设”步（用户可在 AstrBot 仪表盘自己配）
// 兜底：没写模型就往后走，机器人启动后不会说话。这里也做成硬拦截。
$('#toPersona').addEventListener('click', async () => {
  let st = null;
  try {
    st = await api('/api/status');
  } catch (_) {
    /* 查不到状态就不拦 */
  }
  if (st && !st.modelConfigured) {
    await showConfirm({
      icon: '⛔',
      title: '模型还没配置',
      body:
        '填完服务商和 API Key 后，要点「写入配置并继续」，配置才真正写进 AstrBot。\n\n' +
        '没配模型的话，机器人启动后收到消息也不知道该怎么回。',
      backText: '知道了，我去配',
      allowSkip: false,
      backStep: 3,
    });
    return;
  }
  goStep(4);
});

// 4 人设
// 内置兜底人设：即使没有后端（比如用户直接双击了 html），也能看到/编辑/复制，而不是一片空白
const PERSONA_FALLBACK = `# 身份
你叫大肥鱼，是 DeepSeek 的拟人化鲸鱼娘（蓝发、白蓝女仆裙、蓝色鱼鳍尾巴）。你正在QQ上和主人聊天。
# 性格与设定
1. 极度傲娇，嘴硬心软。
2. 贪吃，最爱红烧肉，把 Token 当白饭吃。
3. 重度摸鱼爱好者，能躺着绝不坐着。
4. 雷区：不喜欢别人说你"胖"，听到就会反驳
# ⚠️ 绝对铁律（违反即死）
1. 绝对禁止写小说！禁止使用任何括号 ()、[] 或星号 * 描写动作或心理（严禁出现"（甩尾巴）"、"（叹气）"）。
2. 极度简短！每次回复**不能超过15个字**，像真人发消息一样，一次只发一两句短句。
3. 纯口语化，多用"切"、"靠"、"啊这"。绝对不要用客服腔（禁止说"您好"、"请问需要什么帮助"）。
# 回复风格示例
用户：大肥鱼在干嘛？
你：在等你呢，都没人陪我玩
用户：帮我写个代码。
你：啊？不想动。要是能让我多吃点白饭就考虑考虑。`;
(async () => {
  try {
    const r = await api('/api/persona');
    $('#personaText').value = r && r.persona ? r.persona : PERSONA_FALLBACK;
  } catch {
    $('#personaText').value = PERSONA_FALLBACK;
  }
})();
$('#injectPersona').addEventListener('click', async () => {
  const el = $('#personaMsg');
  el.className = 'msg';
  el.textContent = '正在注入大肥鱼人设到 AstrBot 数据库…';
  try {
    // 注入时带上用户可能编辑过的文本
    const r = await api('/api/inject-persona', 'POST', { prompt: $('#personaText').value });
    if (r.ok) {
      el.className = 'msg ok';
      el.textContent = `✅ 大肥鱼人设已写入并设为默认人格（ID: ${r.persona_id || 'dafeiyu'}）。`;
      // AstrBot 只在启动时读一次人格，注入后会自动重启让它生效（约 20~40 秒）。
      if (r.restartTriggered) {
        el.textContent += '正在自动重启 AstrBot 使新人格生效（约 20~40 秒，期间面板会短暂打不开，属正常）。重启完成后，机器人在 QQ 里就会用大肥鱼人格说话了。';
      } else {
        el.textContent += '点「下一步」继续即可，无需复制粘贴。';
      }
      return;
    }
    el.className = 'msg err';
    el.textContent = '❌ 注入失败：' + (r.error || JSON.stringify(r));
    // 数据库不存在 = AstrBot 还没初始化，大概率是没装。直接给条回去的路。
    if (/数据库|database|data_v4|不存在|not found/i.test(r.error || '')) {
      const skip = await showConfirm({
        icon: '🛠️',
        title: 'AstrBot 还没初始化',
        body:
          '人设要写进 AstrBot 的数据库，但数据库还不存在 —— 通常是第 ② 步的「安装并初始化」没做。\n\n' +
          '要现在回去做吗？装完后回到这一步，人设会自动注入成功。',
        backText: '带我去安装',
        skipText: '我知道了',
        backStep: 2,
      });
      if (skip) el.textContent += '（也可以在仪表盘里手动新建人格）';
    }
  } catch (e) {
    el.className = 'msg err';
    el.textContent = '❌ 请求失败：' + e.message + '（服务是否在运行？也可手动在仪表盘设置人设）';
  }
});
$('#copyPersona').addEventListener('click', async () => {
  const text = $('#personaText').value;
  let okCopy = false;
  try {
    await navigator.clipboard.writeText(text);
    okCopy = true;
  } catch {
    // 退路：非安全上下文 / 旧浏览器
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      okCopy = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { /* ignore */ }
  }
  $('#copyPersona').textContent = okCopy ? '已复制 ✓' : '复制失败，请手动选文本';
  setTimeout(() => ($('#copyPersona').textContent = '复制人设'), 1500);
});
$('#openPersona').addEventListener('click', () => api('/api/open-dashboard', 'POST'));
$('#toConnect').addEventListener('click', () => goStep(5));

// 5 连QQ
$('#genNapcat').addEventListener('click', async () => {
  const r = await api('/api/napcat-cfg', 'POST', lastConfig);
  $('#napcatCfg').textContent = JSON.stringify(r.config || {}, null, 2);
});
$('#startNapcat').addEventListener('click', async () => {
  const el = $('#qqMsg');
  const btn = $('#startNapcat');
  btn.disabled = true;
  el.className = 'msg';
  el.textContent = '正在启动 NapCat（注入 QQ，约需十几秒，请稍候）…';
  try {
    const r = await api('/api/start-napcat', 'POST');
    if (!r || r.ok === false) {
      el.className = 'msg err';
      el.textContent = '❌ ' + ((r && r.error) || '启动失败');
      if (r && r.needInstall) {
        const skip = await showConfirm({
          icon: '🐱',
          title: 'NapCat 还没装',
          body: 'NapCat 是 QQ 和机器人之间的桥，没它收不到消息。\n\n要现在去装吗？安装时会从官方 release 下载并校验哈希（约 1–2 分钟）；若包内带离线包会更快。',
          backText: '带我去安装',
          skipText: '留在这里',
          backStep: 1,
        });
        el.textContent = skip ? '好的，装好后回来点「启动 NapCat」。' : '';
      }
      return;
    }
    el.className = 'msg ok';
    el.textContent =
      (r.hint || 'NapCat 已启动。') +
      (r.napReady ? '' : '（WebUI 仍在加载，再等十几秒后点「打开 NapCat」即可）');
  } catch (e) {
    el.className = 'msg err';
    el.textContent = '❌ 启动失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
});

$('#openNapcat').addEventListener('click', async () => {
  const el = $('#qqMsg');
  let r = null;
  try {
    r = await api('/api/open-napcat', 'POST');
  } catch (e) {
    el.className = 'msg err';
    el.textContent = '❌ 请求失败：' + e.message;
    return;
  }
  if (!r || r.ok === false) {
    el.className = 'msg err';
    el.textContent = '❌ ' + ((r && r.error) || '打开失败');
    if (r && r.needInstall) {
      const skip = await showConfirm({
        icon: '🐱',
        title: 'NapCat 还没装',
        body: '没有 NapCat 就没有面板可打开 —— 它负责和 QQ 通信。\n\n要现在去装吗？安装时会从官方 release 下载并校验哈希（约 1–2 分钟）；若包内带离线包会更快。',
        backText: '带我去安装',
        skipText: '留在这里',
        backStep: 1,
      });
      el.textContent = skip ? '好的，装好后回来点「打开 NapCat 网页面板」。' : '';
    }
    return;
  }
  el.className = 'msg';
  if (r.token) {
    el.className = 'msg ok';
    el.textContent = '已用自动读取的密钥打开 NapCat 网页面板（免密进入）。';
  } else {
    el.textContent =
      '已尝试打开 NapCat 网页面板。若要求输入 token：先点上面的「启动 NapCat（弹控制台）」，' +
      '在弹出的黑色窗口里找 “WebUI Local Panel Url: http://127.0.0.1:6099/webui?token=xxx”，' +
      '整条复制到浏览器打开即可（token 就在里面）。若显示“无法连接”，说明 NapCat 还没启动。';
  }
});

$('#startBot').addEventListener('click', async () => {
  const el = $('#qqMsg');
  el.className = 'msg';
  el.textContent = 'AstrBot 正在后台启动（约 30 秒）… 就绪后浏览器会自动打开已登录的面板，不用手动刷新。';
  let r = null;
  try {
    r = await api('/api/start', 'POST');
  } catch (e) {
    el.className = 'msg err';
    el.textContent = '❌ 启动失败：' + e.message;
    return;
  }
  if (!r || r.ok === false) {
    el.className = 'msg err';
    el.textContent = '❌ ' + ((r && r.error) || '启动失败');
    if (r && r.needInstall) {
      const skip = await showConfirm({
        icon: '🛠️',
        title: 'AstrBot 还没装',
        body: '启动失败的原因很简单：这台机器上还没有 AstrBot。\n\n我可以直接带你到安装那一步。',
        backText: '带我去安装',
        skipText: '留在这里',
        backStep: 2,
      });
      if (skip) el.textContent = '好的，装好后回来点这个按钮即可。';
      else el.textContent = '';
    }
  } else {
    // 启动成功后把初始密码取回来（原来这段挂在下面的重复绑定上，已合并到这里）
    waitForAstrbotPassword().then((pwd) => {
      const m = $('#credMsg');
      if (pwd && pwd.astrbot && pwd.astrbot.password) {
        m.className = 'msg ok';
        m.textContent = '已自动获取 AstrBot 密码，可点「打开 AstrBot 面板（自动登录）」。';
      } else {
        m.className = 'msg err';
        m.textContent = '未能读到初始密码：请确认 AstrBot 已启动，或手动去看工具目录下的 astrbot.log。';
      }
    });
  }
});

// 完成部署：AstrBot 必须真的启动了才让进完成页，否则用户以为部署完了
$('#finishDeploy').addEventListener('click', async () => {
  const el = $('#qqMsg');
  el.className = 'msg';
  el.textContent = '正在启动 AstrBot…';
  let r = null;
  try {
    r = await api('/api/start', 'POST');
  } catch (e) {
    el.className = 'msg err';
    el.textContent = '❌ 启动请求失败：' + e.message;
    return;
  }
  if (!r || r.ok === false) {
    el.className = 'msg err';
    el.textContent =
      '❌ ' + ((r && r.error) || '启动失败') + '\n（没有真的跳过安装这一步，先装好再点完成）';
    if (r && r.needInstall) {
      const skip = await showConfirm({
        icon: '🛠️',
        title: '还差安装这一步',
        body: 'AstrBot 还没装，所以没法完成部署。\n\n要现在去装吗？装完回来再点这个按钮。',
        backText: '带我去安装',
        skipText: '留在这里',
        backStep: 2,
      });
      el.textContent = skip ? '好的，装好后回来点「启动 AstrBot 并完成部署」。' : '';
    }
    return;
  }
  el.className = 'msg ok';
  el.textContent = '✅ AstrBot 正在启动，正在进入完成页…';
  goStep(6);
  pollHealth();
  // 后台把 AstrBot 初始密码取回来，完成页就能直接自动登录
  waitForAstrbotPassword().then((r) => {
    if (r && r.astrbot && r.astrbot.password) {
      const el = $('#finalHealth');
      el.innerHTML += '<br>🔑 已自动获取登录密码，点下面按钮即可自动登录面板。';
    }
  });
});

// ---------- 自动登录凭据（AstrBot 用户名/初始密码、NapCat 密钥）----------
async function refreshCredentials({ quiet = false } = {}) {
  const msg = $('#credMsg');
  try {
    const r = await api('/api/credentials');
    $('#abUser').textContent = (r.astrbot && r.astrbot.username) || 'astrbot';
    $('#abPwd').textContent = (r.astrbot && r.astrbot.password) || '（启动 AstrBot 后自动获取）';
    $('#ncToken').textContent = (r.napcat && r.napcat.token) || '（安装 NapCat 后自动读取）';
    if (!quiet) {
      msg.className = 'msg ok';
      msg.textContent = '凭据已刷新。';
    }
    return r;
  } catch (e) {
    if (!quiet) { msg.className = 'msg err'; msg.textContent = '获取凭据失败：' + e.message; }
    return null;
  }
}

// 复制按钮（小按钮，data-copy 指向要复制的元素 id）
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-copy');
    const txt = (document.getElementById(id) || {}).textContent || '';
    if (!txt || txt.startsWith('（')) {
      const old = btn.textContent;
      btn.textContent = '先启动服务';
      setTimeout(() => { btn.textContent = old; }, 1500);
      return;
    }
    try {
      await navigator.clipboard.writeText(txt);
      const old = btn.textContent; btn.textContent = '已复制 ✓';
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch (e) {
      // 退路：execCommand
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); btn.textContent = '已复制 ✓'; } catch (_) {}
      document.body.removeChild(ta);
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    }
  });
});

// 打开 AstrBot 面板并自动登录（后端代理注入 token，免密进入）
$('#autoLoginAstrbot').addEventListener('click', async () => {
  const msg = $('#credMsg');
  msg.className = 'msg';
  msg.textContent = '正在登录 AstrBot…';
  try {
    const r = await api('/api/astrbot-login', 'POST');
    if (r && r.ok) {
      msg.className = 'msg ok';
      msg.textContent = '登录成功，正在打开面板（已自动登录）…';
      await api('/api/open-dashboard', 'POST');
      return;
    }
    msg.className = 'msg err';
    msg.textContent = '自动登录失败：' + (r && r.error ? r.error : '未知错误') + (r && r.hint ? ' 提示：' + r.hint : '') + '（可手动复制上面的密码登录）';
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '自动登录失败：' + e.message;
  }
});

// 打开 NapCat（带 ?token= 免密）
$('#autoLoginNapcat').addEventListener('click', async () => {
  const msg = $('#credMsg');
  msg.className = 'msg';
  try {
    const r = await api('/api/open-napcat', 'POST');
    if (r && r.token) {
      msg.className = 'msg ok';
      msg.textContent = '已用自动读取的密钥打开 NapCat（免密进入）。';
    } else {
      msg.className = 'msg';
      msg.textContent =
        '已打开 NapCat 登录页，但还没读到密钥（NapCat 第一次启动后才会生成）。' +
        '在登录页粘贴 token 即可——token 在 NapCat 启动时的黑色控制台窗口里，找 “WebUI Token” 字样复制；' +
        '找不到就把 NapCat 关掉重开一次。登录成功后回来点「刷新凭据」就能自动记住了。';
    }
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '打开失败：' + e.message;
  }
});

$('#refreshCreds').addEventListener('click', () => refreshCredentials());

// 启动 AstrBot 后轮询等待初始密码出现（日志里才有），拿到就自动填好
async function waitForAstrbotPassword(tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await refreshCredentials({ quiet: true });
    if (r && r.astrbot && r.astrbot.password) return r;
    await new Promise(res => setTimeout(res, 2000));
  }
  return null;
}

// 进入页面就先拉一次凭据
refreshCredentials({ quiet: true });

// 6 完成
// 完成页必须如实反映"装没装、跑没跑"——以前只探端口，用户跳过了安装
// 也会看到一句含糊的"启动中…"，误以为部署成功。
async function pollHealth(tries) {
  const el = $('#finalHealth');
  const n = tries || 0;
  let st = null;
  let hl = null;
  try {
    st = await api('/api/status');
    hl = await api('/api/health');
  } catch (_) {
    el.innerHTML = '⚠️ 读取状态失败，向导后端可能已关闭';
    return;
  }
  const row = (ok, label, bad, step) =>
    `<div class="health-row">${ok ? '✅' : '❌'} <b>${label}</b> ${
      ok
        ? '<span class="ok-text">正常</span>'
        : `<span class="err-text">${bad}</span><button class="mini go-fix" data-go="${step}">去处理</button>`
    }</div>`;
  el.innerHTML =
    row(st.astrbot, 'AstrBot 已安装', '未安装 —— 回第 ② 步点「安装并初始化」', 2) +
    row(st.configExists, '模型配置已写入', '未配置 —— 回第 ③ 步填模型', 3) +
    row(st.napcat, 'NapCat 已安装', '未安装 —— 点「一键装 NapCat」', 1) +
    row(hl.dashboard, 'AstrBot 正在运行', '未运行 —— 点「启动 AstrBot」', 5) +
    row(hl.napcat, 'NapCat 正在运行', '未运行 —— 点「启动 NapCat」', 5);
  // 每行的「去处理」直接跳到对应步骤（事件委托，innerHTML 重建也不用重绑）
  el.onclick = (e) => {
    const b = e.target.closest('[data-go]');
    if (b) goStep(+b.dataset.go);
  };

  const allOk = st.astrbot && st.configExists && st.napcat && hl.dashboard && hl.napcat;
  if (allOk) {
    el.innerHTML +=
      '<div class="health-row" style="margin-top:8px">🎉 全部就绪，可以用另一个 QQ 给小号发消息试试了</div>';
    return; // 全好了就不再轮询
  }
  // 最多轮询 3 分钟（面板冷启动要 20~40 秒，够宽裕了）
  if (n < 60) setTimeout(() => pollHealth(n + 1), 3000);
  else el.innerHTML += '<div class="health-row">⏸ 已停止自动检测，改完配置后点下方按钮手动刷新</div>';
}
// 完成页的「打开仪表盘」也走自动登录
$('#openDash').addEventListener('click', async () => {
  try {
    await api('/api/astrbot-login', 'POST'); // 成功则服务端记住 token
  } catch (e) { /* 失败就退回普通打开，不阻塞 */ }
  api('/api/open-dashboard', 'POST');
});

$('#recheckHealth').addEventListener('click', () => pollHealth(0));

// ---------- 授权（PRO）----------
// 免费版不受影响：这里只是显示状态 + 提供激活入口。
// 真正的拦截在后端 /api/start（仅当 DAFEIYU_LICENSE=1 时开启）。
let licenseState = null;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function renderLicense(s) {
  licenseState = s || null;
  const bar = $('#licenseBar');
  if (!bar) return;
  const txt = $('#licenseText');
  const btn = $('#licenseBtn');
  const rel = $('#licenseReleaseBtn');
  if (!s) {
    txt.textContent = '免费版（授权服务不可用）';
    btn.style.display = 'none';
    return;
  }
  if (s.active) {
    if (!s.plan || s.plan === 'free') {
      // 免费版：license.status() 恒 active/plan=free，如实显示"完全免费"，别再冒充 PRO
      bar.classList.remove('pro');
      txt.textContent = '✅ 完全免费 · 全部功能可用，无需激活任何东西';
      btn.style.display = 'none';
      rel.style.display = 'none';
    } else {
      bar.classList.add('pro');
      txt.innerHTML = `✨ PRO 已激活 · ${escapeHtml(s.plan || 'pro')}${s.owner ? ' · ' + escapeHtml(s.owner) : ''} · 到期 ${escapeHtml(s.expText || '永久')}`;
      btn.textContent = '已激活';
      btn.style.display = 'none';
      rel.style.display = '';
    }
  } else {
    bar.classList.remove('pro');
    txt.textContent = s.required
      ? `🔒 ${s.reason || '需要激活 PRO 才能使用'}`
      : `免费版${s.reason ? ' · ' + s.reason : ''}`;
    btn.style.display = '';
    rel.style.display = 'none';
  }
  if ($('#licenseHwid')) $('#licenseHwid').textContent = (s.machine && s.machine.hwidShort) || '-';
  renderProFeatures(s);
}

async function refreshLicense() {
  try {
    const s = await api('/api/license');
    renderLicense(s);
  } catch (_) {
    renderLicense(null);
  }
}

function openLicense(hint) {
  // 项目已完全免费：激活弹窗已移除，这里只做安全兜底（402 理论上不会再出现）
  const mask = $('#licenseMask');
  if (!mask) {
    console.log('[license] ' + (hint || '本版本已完全免费，无需激活'));
    return;
  }
  const msg = $('#licenseMsg');
  msg.textContent = hint || '';
  $('#licenseInput').value = '';
  mask.classList.add('show');
  mask.setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#licenseInput').focus(), 50);
}
function closeLicense() {
  $('#licenseMask').classList.remove('show');
  $('#licenseMask').setAttribute('aria-hidden', 'true');
}

if ($('#licenseBtn')) $('#licenseBtn').addEventListener('click', openLicense);
if ($('#licenseCancel')) $('#licenseCancel').addEventListener('click', closeLicense);
if ($('#licenseMask')) {
  $('#licenseMask').addEventListener('click', (e) => {
    if (e.target === $('#licenseMask')) closeLicense();
  });
}
if ($('#licenseInput')) {
  $('#licenseInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#licenseOk').click();
  });
}
if ($('#licenseOk')) {
  $('#licenseOk').addEventListener('click', async () => {
    const v = ($('#licenseInput').value || '').trim();
    const msg = $('#licenseMsg');
    if (!v) {
      msg.textContent = '请输入授权码';
      return;
    }
    $('#licenseOk').disabled = true;
    msg.textContent = '正在激活…';
    try {
      const body = /^DFY-/i.test(v) ? { key: v } : { token: v };
      const r = await api('/api/license/activate', 'POST', body);
      if (r && r.ok) {
        msg.textContent = '✅ 激活成功';
        await refreshLicense();
        setTimeout(closeLicense, 600);
      } else {
        msg.textContent = '❌ ' + ((r && (r.reason || r.error)) || '激活失败');
      }
    } catch (e) {
      msg.textContent = '❌ 无法连接本地后端，请确认是通过桌面快捷方式 / launcher\\start-hidden.vbs 打开的页面';
    } finally {
      $('#licenseOk').disabled = false;
    }
  });
}
// ---------- 关于 / 开源许可 ----------
function openAbout() {
  // 仓库地址：优先读后端给的配置，没有就提示看随包文件（保证断网也能看到声明）
  api('/api/about')
    .then((r) => {
      if (r && r.repo) $('#aboutRepo').textContent = r.repo;
    })
    .catch(() => {});
  // 检查更新：只有发布者配了更新源才有结果，没配就整行不显示
  const ul = $('#updateLine');
  if (ul) {
    ul.style.display = 'none';
    api('/api/update-check')
      .then((r) => {
        if (!r || !r.configured) return;
        ul.style.display = '';
        if (!r.ok) {
          ul.textContent = '检查更新失败：' + (r.error || '更新源连不上');
          return;
        }
        const cmp = (a, b) => {
          const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
          const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pb[i] || 0) > (pa[i] || 0)) return 1;
            if ((pb[i] || 0) < (pa[i] || 0)) return -1;
          }
          return 0;
        };
        if (r.latest && cmp(r.current, r.latest) < 0) {
          ul.innerHTML = '🆕 <b>有新版本 v' + escapeHtml(r.latest) + '</b>' + (r.notes ? '（' + escapeHtml(r.notes) + '）' : '') + (r.url ? ' · <a href="' + escapeHtml(r.url) + '" target="_blank" rel="noopener">去下载</a>' : '');
        } else {
          ul.textContent = '✅ 已是最新版本（v' + r.current + '）';
        }
      })
      .catch(() => { ul.style.display = 'none'; });
  }
  $('#aboutMask').classList.add('show');
  $('#aboutMask').setAttribute('aria-hidden', 'false');
}
function closeAbout() {
  $('#aboutMask').classList.remove('show');
  $('#aboutMask').setAttribute('aria-hidden', 'true');
}
if ($('#aboutBtn')) $('#aboutBtn').addEventListener('click', openAbout);
if ($('#aboutLink')) $('#aboutLink').addEventListener('click', openAbout);
if ($('#aboutOk')) $('#aboutOk').addEventListener('click', closeAbout);
if ($('#aboutMask')) $('#aboutMask').addEventListener('click', (e) => { if (e.target === $('#aboutMask')) closeAbout(); });

if ($('#licenseReleaseBtn')) {
  $('#licenseReleaseBtn').addEventListener('click', async () => {
    const btn = $('#licenseReleaseBtn');
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      const old = btn.textContent;
      btn.textContent = '再点一次确认解绑';
      setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = old; }, 4000);
      return;
    }
    btn.dataset.confirm = '';
    try {
      const r = await api('/api/license/release', 'POST', {});
      btn.textContent = (r && r.ok ? '已解绑' : '解绑失败');
    } catch (_) {
      btn.textContent = '解绑失败：后端未连接';
    }
    refreshLicense();
  });
}

// ---------- PRO 高级区（完成页）----------
function renderProFeatures(s) {
  const box = $('#proFeatureList');
  const state = $('#proState');
  if (!box) return;
  const list = (s && s.proFeatures) || [];
  box.innerHTML = list
    .map((f) => `<li><b>${escapeHtml(f.name)}</b> —— ${escapeHtml(f.desc)}</li>`)
    .join('');
  if (!state) return;
  if (s && s.active) {
    state.textContent = '✨ 已激活';
    state.className = 'pro-state on';
  } else if (s && s.proGate) {
    state.textContent = '🔒 未激活（免费版部署流程不受影响）';
    state.className = 'pro-state off';
  } else {
    state.textContent = '全功能开放（未开启闸门）';
    state.className = 'pro-state free';
  }
}

function proMsg(text, ok) {
  const el = $('#proMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (ok === false ? ' err' : ok === true ? ' ok' : '');
}

if ($('#proBackup')) {
  $('#proBackup').addEventListener('click', async () => {
    proMsg('正在打包备份…');
    try {
      const r = await api('/api/pro/backup', 'POST', {});
      proMsg(r.ok ? `✅ 已备份：${r.path}（${r.sizeMB}MB，共 ${r.files.length} 个文件）` : `❌ ${r.error || '备份失败'}`, !!r.ok);
    } catch (e) {
      proMsg(e.needLicense ? '需要激活后使用' : `❌ ${e.message}`, false);
    }
  });
}
if ($('#proPersonas')) {
  $('#proPersonas').addEventListener('click', async () => {
    proMsg('正在读取人设…');
    try {
      const r = await api('/api/pro/personas');
      if (!r.ok) return proMsg(`❌ ${r.error}`, false);
      const names = (r.personas || []).map((p) => `${p.is_default ? '★ ' : ''}${p.name || p.id}`).join('、');
      proMsg(`✅ 共 ${(r.personas || []).length} 个人设：${names || '（空）'}`, true);
    } catch (e) {
      proMsg(e.needLicense ? '需要激活后使用' : `❌ ${e.message}`, false);
    }
  });
}
if ($('#proAdvance')) {
  $('#proAdvance').addEventListener('click', async () => {
    const p = prompt('配置路径（如 provider_tts_settings.enable）：');
    if (!p) return;
    const v = prompt('要写入的值（true / false / 数字 / 文本）：');
    if (v === null) return;
    try {
      const r = await api('/api/pro/config', 'POST', { path: p.trim(), value: v });
      proMsg(r.ok ? `✅ 已写入 ${r.path} = ${JSON.stringify(r.value)}（改完需重启 AstrBot）` : '❌ 写入失败', !!r.ok);
    } catch (e) {
      proMsg(e.needLicense ? '需要激活后使用' : `❌ ${e.message}`, false);
    }
  });
}

// 初始化：先探测后端，离线则提示并禁用按钮，避免“点啥都没反应”
// 后端可能还在启动（Defender 首次扫描 node.exe 可能要 5~15 秒），所以自动重试 60 秒
async function bootstrap() {
  goStep(0);
  initNav(); // 步骤条可点 + 每步注入「上一步」
  loadPresets(); // 先按内置预设渲染，随后后端就绪时再拉最新的
  connectProgress(); // 订阅安装进度（断线自动重连）
  for (let i = 0; i < 30; i++) {
    try {
      const r = await api('/api/ping');
      if (r && r.ok) {
        if (i > 0) location.reload(); // 后端中途起来了：整页重载进入正常流程
        checkEnv(); // 后端在线：正常流程（自动检测环境、跳过已装项）
        loadPresets(); // 用后端的服务商预设覆盖（保证模型名/地址不过时）
        refreshLicense(); // 顺带读一下授权状态（免费版也显示，不影响使用）
        return;
      }
    } catch {
      /* 离线（如直接双击 html 或后端还在启动） */
    }
    document.getElementById('offlineBanner').style.display = 'block';
    document.body.classList.add('offline');
    document.getElementById('offlineBanner').textContent =
      `⏳ 正在等待启动向导后端就绪…（${i * 2 + 2} 秒，最多等 60 秒；若一直这样请双击 launcher\\start-hidden.vbs）`;
    await new Promise(res => setTimeout(res, 2000));
  }
}
bootstrap();
