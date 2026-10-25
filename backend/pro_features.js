// pro_features.js —— PRO 专属能力（需要授权，闸门由 license.checkFeature 控制）
//
// 设计原则：
//   1. 免费版能完整部署并使用（装环境 → 配模型 → 启动 → 登录 QQ），PRO 只做"省事"的事；
//   2. 每个能力都必须真的能用（不画饼），否则授权码卖不动；
//   3. 未设置 DAFEIYU_PRO_GATE=1 时闸门放行，方便你自己从零自测。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const d = require('./deploy');
const lic = require('./license');

const WORK_DIR = d.WORK_DIR;
const BACKUP_DIR = path.join(WORK_DIR, 'backups');

// 闸门：未激活时抛一个带 needLicense 标记的错误，由 server.js 转成 402
function gate(featureId) {
  const f = (lic.PRO_FEATURES || []).find((x) => x.id === featureId);
  const r = lic.checkFeature(f ? f.name : featureId);
  if (r.ok) return;
  const e = new Error(r.reason || '这是 PRO 功能');
  e.needLicense = true;
  e.feature = f ? f.name : featureId;
  e.featureId = featureId;
  e.buyUrl = r.buyUrl || '';
  throw e;
}

// ---------- AstrBot 配置读写（模板 + 生效两份都要写）----------
function readCfg(p) {
  if (!fs.existsSync(p)) return { cfg: {}, bom: false };
  let raw = fs.readFileSync(p, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  if (bom) raw = raw.slice(1);
  try { return { cfg: JSON.parse(raw), bom }; } catch (_) { return { cfg: {}, bom }; }
}
function writeCfg(p, cfg, bom) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, (bom ? '\ufeff' : '') + JSON.stringify(cfg, null, 2), 'utf8');
}
function patchBoth(mutator) {
  const written = [];
  for (const p of [d.CONFIG_PATH, d.CMD_CONFIG_PATH]) {
    if (!fs.existsSync(p) && p === d.CMD_CONFIG_PATH) continue; // 运行前可能还没生成
    const { cfg, bom } = readCfg(p);
    writeCfg(p, mutator(cfg) || cfg, bom);
    written.push(p);
  }
  return written;
}

// ---------- ① 高级参数微调：按 a.b.c 路径写配置 ----------
function setConfigValue(dotPath, value) {
  gate('advanced');
  if (!dotPath || typeof dotPath !== 'string') throw new Error('缺少配置路径');
  let parsed = value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === 'true') parsed = true;
    else if (t === 'false') parsed = false;
    else if (t !== '' && !Number.isNaN(Number(t))) parsed = Number(t);
    else parsed = value;
  }
  const written = patchBoth((cfg) => {
    const parts = dotPath.split('.');
    let node = cfg;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = parsed;
    return cfg;
  });
  return { ok: true, path: dotPath, value: parsed, written };
}

function getConfig(dotPath) {
  const { cfg } = readCfg(d.CMD_CONFIG_PATH);
  if (!dotPath) return { ok: true, config: cfg };
  let node = cfg;
  for (const k of dotPath.split('.')) {
    if (node == null) return { ok: true, value: null };
    node = node[k];
  }
  return { ok: true, value: node === undefined ? null : node };
}

// ---------- ② 多人设管理 ----------
async function listPersonas(setDefault) {
  gate('personas');
  const py = await d.getPythonCmd(); // 注意：deploy 里这个是 async，必须 await
  const script = path.join(__dirname, 'export_personas.py');
  const args = [script];
  if (setDefault) args.push('--set', String(setDefault));
  let out;
  try {
    // 注意：getPythonCmd 可能带参数（如 uvx ...），这里统一交给 shell 执行
    out = execSync(`${py} "${script}"${setDefault ? ` --set "${setDefault}"` : ''}`, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      cwd: WORK_DIR,
    });
  } catch (e) {
    const txt = (e.stdout || '') + (e.stderr || '');
    try { return JSON.parse(txt); } catch (_) { throw new Error(`读取人设失败：${txt || e.message}`); }
  }
  try { return JSON.parse(out); } catch (_) { return { ok: false, error: '人设输出解析失败', raw: out.slice(0, 500) }; }
}

// ---------- ③ 一键备份与迁移 ----------
// 备份什么：AstrBot 生效配置 + 模板配置 + 人设文本 + 人设库（SQLite，含人格）+ 插件清单。
// 不备份什么：NapCat 登录态（device.json / 凭据）—— 那是别人的 QQ 登录凭证，绝不打包。
function collectFiles() {
  const items = [];
  const add = (src, rel) => { if (src && fs.existsSync(src)) items.push({ src, rel }); };
  add(d.CMD_CONFIG_PATH, 'astrbot/cmd_config.json');
  add(d.CONFIG_PATH, 'astrbot/config.json');
  add(path.join(__dirname, '..', 'assets', 'dafeiyu_persona.txt'), 'persona/dafeiyu_persona.txt');
  // 人设库：data 下的 *.db
  try {
    for (const f of fs.readdirSync(d.DATA_DIR)) {
      if (/\.db$/i.test(f)) add(path.join(d.DATA_DIR, f), `astrbot/data/${f}`);
    }
  } catch (_) { /* data 目录还没建 */ }
  // 插件清单（目录名列表，方便迁移时对照）
  try {
    const pluginsDir = path.join(d.DATA_DIR, 'plugins');
    const names = fs.readdirSync(pluginsDir).filter((f) => fs.statSync(path.join(pluginsDir, f)).isDirectory());
    const tmp = path.join(BACKUP_DIR, '_plugins.json');
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(names, null, 2));
    add(tmp, 'plugins.json');
  } catch (_) { /* 没插件目录就算了 */ }
  return items;
}

function exportBackup() {
  gate('backup');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const items = collectFiles();
  if (!items.length) throw new Error('还没找到可备份的内容（AstrBot 至少成功启动过一次才有配置和数据）');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const outZip = path.join(BACKUP_DIR, `dafeiyu-backup-${stamp}.zip`);
  try { fs.unlinkSync(outZip); } catch (_) {}

  // 用系统自带的 Compress-Archive（Windows 自带，零依赖）
  const stage = path.join(BACKUP_DIR, '_stage');
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
  for (const it of items) {
    const dest = path.join(stage, it.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(it.src, dest);
  }
  const meta = {
    product: 'dafeiyu-qq-tool',
    version: lic.VERSION,
    exportedAt: new Date().toISOString(),
    note: '大肥鱼备份包：含 AstrBot 配置与人设；不含 NapCat 登录态与任何密钥。',
    files: items.map((i) => i.rel),
  };
  fs.writeFileSync(path.join(stage, 'backup.json'), JSON.stringify(meta, null, 2));

  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path "${path.join(stage, '*')}" -DestinationPath "${outZip}" -Force`],
      { windowsHide: true, timeout: 120000 }
    );
  } catch (e) {
    throw new Error(`打包失败：${e.message}`);
  }
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
  const size = fs.statSync(outZip).size;
  return { ok: true, path: outZip, sizeMB: +(size / 1048576).toFixed(2), files: meta.files };
}

function listBackups() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^dafeiyu-backup-.*\.zip$/.test(f))
      .map((f) => {
        const p = path.join(BACKUP_DIR, f);
        const st = fs.statSync(p);
        return { name: f, path: p, sizeMB: +(st.size / 1048576).toFixed(2), at: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch (_) {
    return [];
  }
}

function restoreBackup(zipPath) {
  gate('backup');
  if (!zipPath || !fs.existsSync(zipPath)) throw new Error('备份文件不存在：' + (zipPath || '(空)'));
  const stage = path.join(BACKUP_DIR, '_restore');
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(stage, { recursive: true });
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${stage}" -Force`],
    { windowsHide: true, timeout: 120000 }
  );
  const restored = [];
  const copy = (rel, dest) => {
    const src = path.join(stage, rel);
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    restored.push(dest);
  };
  copy('astrbot/cmd_config.json', d.CMD_CONFIG_PATH);
  copy('astrbot/config.json', d.CONFIG_PATH);
  for (const f of (fs.existsSync(path.join(stage, 'astrbot', 'data')) ? fs.readdirSync(path.join(stage, 'astrbot', 'data')) : [])) {
    copy(path.join('astrbot', 'data', f), path.join(d.DATA_DIR, f));
  }
  copy('persona/dafeiyu_persona.txt', path.join(__dirname, '..', 'assets', 'dafeiyu_persona.txt'));
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
  return {
    ok: true,
    restored,
    hint: '已还原配置与人设。请回到第 ④ 步重新启动 AstrBot 使配置生效。',
  };
}

module.exports = {
  gate,
  setConfigValue,
  getConfig,
  listPersonas,
  exportBackup,
  listBackups,
  restoreBackup,
  BACKUP_DIR,
};
