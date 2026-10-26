'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function decodeName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    try { return new TextDecoder('gbk').decode(buf); } catch (_) {}
    return buf.toString('latin1');
  }
}

function safeRel(name) {
  if (typeof name !== 'string' || !name) return '';
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return '';
  const parts = n.split('/').filter(Boolean);
  if (!parts.length || parts.includes('..')) return '';
  return parts.join('/');
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// Minimal, path-safe ZIP extractor (store + deflate, no ZIP64/encryption).
// The plugin installer must never trust entry names from a downloaded zip.
function extractZip(zipPath, destDir, opts = {}) {
  const maxEntries = opts.maxEntries || 2000;
  const maxBytes = opts.maxBytes || 64 * 1024 * 1024;
  const buf = fs.readFileSync(zipPath);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 插件包');
  }
  if (count > maxEntries) throw new Error(`插件包文件太多（${count} > ${maxEntries}）`);
  if (cdOffset + cdSize > buf.length) throw new Error('zip 中央目录越界');

  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });

  const files = [];
  let total = 0;
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('zip 中央目录损坏');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(rawName, flags);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new Error(`插件包包含加密文件：${name}`);
    if (/[\\/]$/.test(name)) continue;
    const rel = safeRel(name);
    if (!rel) throw new Error(`插件包包含非法路径：${name}`);
    if (rel.endsWith('/')) continue;

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error(`zip 本地头损坏：${rel}`);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    if (dataOff + compSize > buf.length) throw new Error(`zip 数据越界：${rel}`);

    const comp = buf.subarray(dataOff, dataOff + compSize);
    let data;
    if (method === 0) {
      data = comp;
    } else if (method === 8) {
      data = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(1, uncompSize) + 1 });
    } else {
      throw new Error(`不支持的压缩方式 ${method}：${rel}`);
    }
    if (data.length !== uncompSize) throw new Error(`解压大小不符：${rel}`);

    total += data.length;
    if (total > maxBytes) throw new Error(`插件包解压后超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);

    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`插件包尝试越界写入：${rel}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files.push(rel);
  }

  return { files, bytes: total };
}

module.exports = { extractZip, safeRel, decodeName };
