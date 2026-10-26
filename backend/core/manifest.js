'use strict';

const crypto = require('crypto');
const fs = require('fs');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;
const PLUGIN_NAME = /^astrbot_plugin_[a-z0-9_]+$/;
const SHA256 = /^[a-f0-9]{64}$/i;

function parseVersion(v) {
  const m = SEMVER.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]/).some((seg) => seg === '..');
}

// Validate the manifest shipped inside a plugin package before installing it.
// The installer must never trust a zip's paths or hashes blindly.
function validatePluginManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest must be an object'], manifest: null };
  }

  if (!PLUGIN_NAME.test(String(manifest.name || ''))) {
    errors.push('name must look like astrbot_plugin_xxx');
  }
  if (!parseVersion(manifest.version)) {
    errors.push('version must be semver (e.g. 1.8.0)');
  }
  if (manifest.min_astrbot && !parseVersion(manifest.min_astrbot)) {
    errors.push('min_astrbot must be semver');
  }
  if (manifest.max_astrbot && !parseVersion(manifest.max_astrbot)) {
    errors.push('max_astrbot must be semver');
  }
  if (manifest.min_astrbot && manifest.max_astrbot && compareVersions(manifest.min_astrbot, manifest.max_astrbot) > 0) {
    errors.push('min_astrbot is greater than max_astrbot');
  }

  if (manifest.entry && !isSafeRelPath(manifest.entry)) {
    errors.push('entry must be a safe relative path');
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push('files[] must contain at least one file');
  } else {
    manifest.files.forEach((f, i) => {
      if (!f || typeof f !== 'object') {
        errors.push(`files[${i}] must be an object`);
        return;
      }
      if (!isSafeRelPath(f.path)) errors.push(`files[${i}].path is not a safe relative path`);
      if (!SHA256.test(String(f.sha256 || ''))) errors.push(`files[${i}].sha256 must be 64 hex chars`);
      if (f.size !== undefined && (!Number.isInteger(f.size) || f.size < 0)) {
        errors.push(`files[${i}].size must be a non-negative integer`);
      }
    });
  }

  return { ok: errors.length === 0, errors, manifest };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = {
  parseVersion,
  compareVersions,
  isSafeRelPath,
  validatePluginManifest,
  sha256File,
};
