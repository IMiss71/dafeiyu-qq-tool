// doctor.js
// 一键生成「诊断报告」：用户遇到问题时点一下，把报告发给你，不用再来回问"你什么系统""日志在哪"。
//
// 脱敏是硬要求：报告里有 AstrBot 日志，里面可能出现 API Key、面板密码、token。
// 用户是要把这份文件发给别人（你）的，所以出厂前必须自动打码。
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('./deploy');
const pf = require('./preflight');

const DIAG_DIR = path.join(d.WORK_DIR, 'diag');
const MAX_LINES = 200; // 每份日志只取最后 200 行，避免报告几十 MB

function tailFile(p, lines = MAX_LINES) {
  try {
    if (!fs.existsSync(p)) return `(不存在: ${p})`;
    const txt = fs.readFileSync(p, 'utf8');
    const arr = txt.split(/\r?\n/);
    const slice = arr.slice(Math.max(0, arr.length - lines));
    return slice.join('\n');
  } catch (e) {
    return `(读取失败: ${e.message})`;
  }
}

// 脱敏：Key / token / 密码 / 手机号 / 邮箱 全部打码
function mask(s) {
  if (!s) return s;
  return String(s)
    // sk-xxxx / sk-or-v1-xxxx 等通用 API Key
    .replace(/\b(sk|api[-_]?key)[-_A-Za-z0-9]{8,}/gi, (m, p1) => `${p1}-***(已打码)`)
    // 形如 key=xxx / token=xxx / password=xxx / pwd=xxx / pw=xxx
    .replace(/((?:key|token|password|pwd|pw|secret|access[_-]?token)=)([^\s"';,}]{4,})/gi, '$1***(已打码)')
    // JSON 里的 "api_key": "xxx"
    .replace(/("(?:api_key|apiKey|token|password|secret)"\s*:\s*")([^"]{4,})(")/gi, '$1***(已打码)$3')
    // Initial password: xxxx
    .replace(/(Initial password[:：]\s*)([^\s\r\n]+)/gi, '$1***(已打码)')
    // 手机号
    .replace(/\b1[3-9]\d{9}\b/g, '1**********')
    // 邮箱（保留域名，便于判断来源）
    .replace(/\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '***@$2');
}

async function collect() {
  fs.mkdirSync(DIAG_DIR, { recursive: true });

  const statusP = d.status().catch((e) => ({ error: e.message }));
  const preP = pf.run().catch((e) => ({ error: e.message }));
  const [status, preflight] = await Promise.all([statusP, preP]);

  let licInfo = null;
  try {
    const lic = require('./license');
    const s = lic.status();
    // 只留字段，绝不写入设备指纹/密钥原文
    licInfo = { active: !!s.active, plan: s.plan || '', expires: s.expires || '', features: (s.features || []).length };
  } catch (_) {}

  const lines = [];
  const hr = '='.repeat(60);
  lines.push(hr);
  lines.push('大肥鱼 QQ 机器人部署工具 · 诊断报告');
  lines.push(hr);
  lines.push(`生成时间：${new Date().toLocaleString()}`);
  lines.push(`工具版本：${(() => { try { return require('./license').VERSION; } catch (_) { return 'unknown'; } })()}`);
  lines.push(`操作系统：${os.release()} (${os.arch()})  内存：${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB`);
  lines.push(`Node 版本：${process.version}`);
  lines.push(`工具目录：${path.join(__dirname, '..')}`);
  lines.push(`数据目录：${d.WORK_DIR}`);
  lines.push('');

  lines.push(hr);
  lines.push('一、环境体检');
  lines.push(hr);
  if (preflight.items) {
    lines.push(`结论：阻塞 ${preflight.summary.block} 项 / 警告 ${preflight.summary.warn} 项 / 正常 ${preflight.summary.ok} 项`);
    for (const it of preflight.items) {
      lines.push(`[${it.level.toUpperCase()}] ${it.title}：${it.detail}${it.fix ? `\n    处理：${it.fix}` : ''}`);
    }
  } else {
    lines.push(`体检失败：${preflight.error}`);
  }
  lines.push('');

  lines.push(hr);
  lines.push('二、当前状态');
  lines.push(hr);
  lines.push(mask(JSON.stringify(status, null, 2)));
  if (licInfo) lines.push(`授权：${JSON.stringify(licInfo)}`);
  lines.push('');

  lines.push(hr);
  lines.push('三、数据目录内容');
  lines.push(hr);
  try {
    for (const n of fs.readdirSync(d.WORK_DIR).slice(0, 80)) {
      let st = null;
      try { st = fs.statSync(path.join(d.WORK_DIR, n)); } catch (_) {}
      lines.push(`  ${st && st.isDirectory() ? '[目录]' : '[文件]'} ${n}${st ? `  ${(st.size / 1024).toFixed(0)}KB` : ''}`);
    }
  } catch (e) {
    lines.push(`读取失败：${e.message}`);
  }
  lines.push('');

  const selfDir = path.join(__dirname, '..');
  for (const [title, rel] of [
    ['四、AstrBot 启动日志（末尾）', path.join(d.WORK_DIR, 'astrbot.log')],
    ['五、向导运行日志', path.join(selfDir, 'wizard.log')],
    ['六、向导错误日志', path.join(selfDir, 'wizard.err.log')],
  ]) {
    lines.push(hr);
    lines.push(title);
    lines.push(hr);
    lines.push(mask(tailFile(rel)));
    lines.push('');
  }

  const name = `诊断报告-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
  const out = path.join(DIAG_DIR, name);
  // 带 BOM：Windows 记事本双击打开不乱码
  fs.writeFileSync(out, '\ufeff' + lines.join('\n'), 'utf8');
  return { ok: true, path: out, dir: DIAG_DIR, name, size: fs.statSync(out).size };
}

module.exports = { collect, mask, DIAG_DIR };
