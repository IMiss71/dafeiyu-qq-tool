// license.js
// 2026-10-25 起整个项目完全免费 —— 本文件只保留三样还有人的东西：
//   VERSION（版本号）、status()（状态展示）、checkFeature/requirePro（恒放行的闸门）。
// 激活码 / 心跳 / 解绑 / 机器码授权等逻辑已随死代码一起删除，对应路由也已下线。
// 机器指纹 machineId() 保留：诊断报告还在用它生成展示用的设备标识。

const os = require('os');
const crypto = require('crypto');

const FALLBACK_VERSION = '1.1.0';
const VERSION = (() => {
  try {
    return require(path0()).version || FALLBACK_VERSION;
  } catch (_) {
    return FALLBACK_VERSION;
  }
  function path0() {
    return require('path').join(__dirname, '..', 'package.json');
  }
})();

// 面板里展示的"高级工具"清单（全部免费，只是功能说明）
const PRO_FEATURES = [
  { id: 'models', name: '智能模型列表', desc: '直接拉取服务商的模型清单，点一下就选对，不再手打模型名 404' },
  { id: 'vision', name: '识图（视觉）自动接入', desc: '自动注册图片转写 provider，让纯文本模型也能"看懂"图片' },
  { id: 'personas', name: '多人设管理', desc: '列出 / 切换 / 导入导出人格，一台机器跑多个角色' },
  { id: 'backup', name: '一键备份与迁移', desc: '把配置、人设、插件清单打成包，换机一键还原' },
  { id: 'advanced', name: '高级参数微调', desc: '语音、表情包概率等细项按配置路径写入，不用手改 JSON' },
];

// 机器指纹：诊断报告里还会用到，保留一个零依赖实现
function machineId() {
  const hwid = crypto
    .createHash('sha256')
    .update(`${os.hostname()}|${os.platform()}|${os.arch()}`)
    .digest('hex');
  return { hwid, hwidShort: hwid.slice(0, 8).toUpperCase(), stable: true, parts: { host: os.hostname() } };
}

function status() {
  return {
    required: false,
    version: VERSION,
    machine: machineId(),
    active: true,
    plan: 'free',
    reason: '完全免费，所有功能已解锁',
  };
}

function checkFeature() {
  return { ok: true, plan: 'free' };
}

function requirePro() {
  return null;
}

module.exports = {
  machineId,
  status,
  checkFeature,
  requirePro,
  PRO_FEATURES,
  VERSION,
};
