'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { AppError } = require('../core/errors');
const { validatePluginManifest, sha256File } = require('../core/manifest');
const { extractZip } = require('./zip');

const PLUGIN_NAME = /^astrbot_plugin_[a-z0-9_]+$/;
const PRESERVE = ['data', 'meme_packs', 'voice', 'tmp'];
const MAX_BACKUPS = 5;

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readMetadataVersion(dir) {
  try {
    const y = fs.readFileSync(path.join(dir, 'metadata.yaml'), 'utf8');
    const m = y.match(/^version:\s*v?([\d.]+)/im);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

function readMetadataName(dir) {
  try {
    const y = fs.readFileSync(path.join(dir, 'metadata.yaml'), 'utf8');
    const m = y.match(/^name:\s*([A-Za-z0-9_]+)/im);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

function findPluginRoot(dir) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    const names = new Set(entries.map((e) => e.name));
    if (names.has('metadata.yaml') && names.has('main.py')) found.push(d);
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '__MACOSX') walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  if (found.length === 0) {
    throw new AppError('E_PLUGIN_STRUCTURE', '插件包结构不正确：找不到 metadata.yaml + main.py', {
      remediation: '把插件目录（含 metadata.yaml/main.py）重新打包，不要只压缩外层文件夹',
    });
  }
  if (found.length > 1) {
    throw new AppError('E_PLUGIN_STRUCTURE', '插件包里包含多个插件目录，只能装一个', {
      remediation: '一个 zip 只放一个 astrbot_plugin_* 目录',
    });
  }
  return found[0];
}

function readAndValidateManifest(root) {
  const file = path.join(root, 'manifest.json');
  if (!fs.existsSync(file)) {
    throw new AppError('E_PLUGIN_MANIFEST_MISSING', '插件包缺少 manifest.json', {
      remediation: '用新版打包脚本生成 manifest.json（含 name/version/files/sha256）',
    });
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new AppError('E_PLUGIN_MANIFEST_INVALID', 'manifest.json 不是合法 JSON', { detail: e.message });
  }
  const v = validatePluginManifest(raw);
  if (!v.ok) {
    throw new AppError('E_PLUGIN_MANIFEST_INVALID', 'manifest.json 校验失败：' + v.errors.join('；'), {
      remediation: '重新生成 manifest，确保 name/version/files[].sha256 合法',
    });
  }
  if (!PLUGIN_NAME.test(raw.name)) {
    throw new AppError('E_PLUGIN_NAME', '插件名不合法：' + raw.name);
  }
  const metaName = readMetadataName(root);
  if (metaName && metaName !== raw.name) {
    throw new AppError('E_PLUGIN_NAME', `manifest.name(${raw.name}) 与 metadata.yaml(${metaName}) 不一致`);
  }
  const metaVer = readMetadataVersion(root);
  if (metaVer && metaVer !== String(raw.version).replace(/^v/i, '')) {
    throw new AppError('E_PLUGIN_VERSION', `manifest.version(${raw.version}) 与 metadata.yaml(${metaVer}) 不一致`);
  }

  const entry = raw.entry || 'main.py';
  if (!fs.existsSync(path.join(root, entry))) {
    throw new AppError('E_PLUGIN_ENTRY', '插件入口不存在：' + entry);
  }

  const bad = [];
  for (const f of raw.files) {
    const p = path.resolve(root, f.path);
    if (p !== root && !p.startsWith(root + path.sep)) {
      throw new AppError('E_PLUGIN_PATH', 'manifest 包含越界路径：' + f.path);
    }
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      bad.push(`${f.path}（缺失）`);
      continue;
    }
    const actual = sha256File(p);
    if (actual.toLowerCase() !== String(f.sha256).toLowerCase()) {
      bad.push(`${f.path}（哈希不符）`);
    }
  }
  if (bad.length) {
    throw new AppError('E_PLUGIN_HASH', '插件包文件校验失败：' + bad.slice(0, 5).join('；'), {
      remediation: '插件包可能损坏或被修改，请重新下载',
    });
  }
  return raw;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else { try { total += fs.statSync(p).size; } catch (_) {} }
    }
  } catch (_) {}
  return total;
}

function createPluginManager(workDir) {
  const dataDir = path.join(workDir, 'data');
  const pluginsDir = path.join(dataDir, 'plugins');
  const backupDir = path.join(dataDir, 'plugin_backups');
  const tmpDir = path.join(workDir, 'plugin_tmp');

  function pluginPath(name) {
    if (!PLUGIN_NAME.test(String(name || ''))) {
      throw new AppError('E_PLUGIN_NAME', '插件名不合法：' + name);
    }
    return path.join(pluginsDir, name);
  }

  function backupPath(id) {
    if (!/^[A-Za-z0-9_.-]+$/.test(String(id || ''))) {
      throw new AppError('E_PLUGIN_BACKUP', '备份 id 不合法');
    }
    const p = path.resolve(backupDir, id);
    if (!p.startsWith(path.resolve(backupDir) + path.sep)) {
      throw new AppError('E_PLUGIN_BACKUP', '备份路径越界');
    }
    return p;
  }

  function pruneBackups(name) {
    try {
      const items = fs.readdirSync(backupDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith(name + '-'))
        .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(backupDir, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const it of items.slice(MAX_BACKUPS)) {
        fs.rmSync(path.join(backupDir, it.name), { recursive: true, force: true });
      }
    } catch (_) {}
  }

  function installFromZip(zipPath, opts = {}) {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });

    const stage = path.join(tmpDir, `stage-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    let backup = '';
    let dest = '';
    try {
      extractZip(zipPath, stage, { maxBytes: opts.maxBytes || 64 * 1024 * 1024 });
      const root = findPluginRoot(stage);
      const manifest = readAndValidateManifest(root);
      const name = manifest.name;
      if (opts.expectedName && opts.expectedName !== name) {
        throw new AppError('E_PLUGIN_NAME', `期望插件 ${opts.expectedName}，包内是 ${name}`);
      }
      dest = pluginPath(name);

      if (fs.existsSync(dest)) {
        backup = path.join(backupDir, `${name}-${manifest.version}-${nowStamp()}`);
        copyDir(dest, backup);
      }

      try {
        fs.rmSync(dest, { recursive: true, force: true });
        copyDir(root, dest);
        // Keep user data and self-added meme packs across upgrades.
        if (backup) {
          for (const sub of PRESERVE) {
            const src = path.join(backup, sub);
            if (fs.existsSync(src)) copyDir(src, path.join(dest, sub));
          }
        }
      } catch (e) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
        if (backup && fs.existsSync(backup)) {
          try { copyDir(backup, dest); } catch (_) {}
        }
        throw new AppError('E_PLUGIN_INSTALL', '写入插件目录失败', {
          detail: e.message,
          remediation: '先停止 AstrBot 再试；检查磁盘/杀软占用',
        });
      }

      pruneBackups(name);
      return {
        ok: true,
        name,
        version: manifest.version,
        backup: backup ? path.basename(backup) : '',
        files: manifest.files.length,
        needsRestart: true,
      };
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
    }
  }

  function list() {
    const plugins = [];
    try {
      for (const e of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const dir = path.join(pluginsDir, e.name);
        const metadataVersion = readMetadataVersion(dir);
        let manifestVersion = '';
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
          manifestVersion = m.version || '';
        } catch (_) {}
        plugins.push({
          name: e.name,
          version: manifestVersion || metadataVersion || 'unknown',
          metadataVersion,
          manifestVersion,
          size: dirSize(dir),
        });
      }
    } catch (_) {}

    const backups = [];
    try {
      for (const e of fs.readdirSync(backupDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(backupDir, e.name);
        const mtime = fs.statSync(dir).mtimeMs;
        backups.push({
          id: e.name,
          name: e.name.replace(/-\d{8}-\d{6}$/, ''),
          version: readMetadataVersion(dir),
          size: dirSize(dir),
          createdAt: new Date(mtime).toISOString(),
        });
      }
    } catch (_) {}
    backups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    return { plugins, backups };
  }

  function rollback(backupId) {
    const src = backupPath(backupId);
    if (!fs.existsSync(src)) throw new AppError('E_PLUGIN_NOT_FOUND', '备份不存在：' + backupId);
    const name = readMetadataName(src);
    if (!PLUGIN_NAME.test(name)) throw new AppError('E_PLUGIN_BACKUP', '备份里没有合法插件名');
    const dest = pluginPath(name);

    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(dest)) {
      const pre = path.join(backupDir, `${name}-pre-rollback-${nowStamp()}`);
      copyDir(dest, pre);
    }
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      copyDir(src, dest);
    } catch (e) {
      throw new AppError('E_PLUGIN_ROLLBACK', '回滚失败', { detail: e.message });
    }
    pruneBackups(name);
    return { ok: true, name, backupId, needsRestart: true };
  }

  function remove(name) {
    const dest = pluginPath(name);
    if (!fs.existsSync(dest)) throw new AppError('E_PLUGIN_NOT_FOUND', '插件未安装：' + name);
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `${name}-${readMetadataVersion(dest) || 'unknown'}-${nowStamp()}`);
    copyDir(dest, backup);
    fs.rmSync(dest, { recursive: true, force: true });
    pruneBackups(name);
    return { ok: true, name, backup: path.basename(backup) };
  }

  return { pluginsDir, backupDir, tmpDir, installFromZip, list, rollback, remove };
}

module.exports = { createPluginManager, findPluginRoot, readAndValidateManifest };
