const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { extractZip } = require('../backend/plugins/zip');
const { createPluginManager } = require('../backend/plugins/manager');

const tmpBase = path.join(__dirname, 'tmp');
fs.mkdirSync(tmpBase, { recursive: true });
const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'plugin-'));
test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Minimal store-only zip writer for fixtures.
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const names = Object.keys(entries);
  for (const name of names) {
    const data = Buffer.from(entries[name], 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

function pluginEntries(version, mainPy) {
  const root = 'plugin/astrbot_plugin_dafeiyu/';
  const metadata = `name: astrbot_plugin_dafeiyu\nversion: v${version}\n`;
  const files = [
    { path: 'metadata.yaml', content: metadata },
    { path: 'main.py', content: mainPy },
  ];
  const manifest = {
    name: 'astrbot_plugin_dafeiyu',
    version,
    files: files.map((f) => ({ path: f.path, sha256: sha(f.content), size: Buffer.byteLength(f.content) })),
    entry: 'main.py',
  };
  return {
    [root + 'metadata.yaml']: metadata,
    [root + 'main.py']: mainPy,
    [root + 'manifest.json']: JSON.stringify(manifest, null, 2),
  };
}

test('zip extractor blocks path traversal and writes safe files', () => {
  const good = path.join(tmpRoot, 'good.zip');
  fs.writeFileSync(good, makeZip({ 'a/b.txt': 'hello' }));
  const out = path.join(tmpRoot, 'good-out');
  extractZip(good, out);
  assert.equal(fs.readFileSync(path.join(out, 'a/b.txt'), 'utf8'), 'hello');

  const bad = path.join(tmpRoot, 'bad.zip');
  fs.writeFileSync(bad, makeZip({ '../evil.txt': 'nope' }));
  assert.throws(() => extractZip(bad, path.join(tmpRoot, 'bad-out')), /非法路径/);
  assert.equal(fs.existsSync(path.join(tmpRoot, 'evil.txt')), false);
});

test('plugin manager installs, preserves data, backs up and rolls back', () => {
  const work = path.join(tmpRoot, 'work');
  const mgr = createPluginManager(work);
  const z1 = path.join(tmpRoot, 'v1.zip');
  fs.writeFileSync(z1, makeZip(pluginEntries('1.0.0', 'print("v1")\n')));
  const r1 = mgr.installFromZip(z1);
  assert.equal(r1.name, 'astrbot_plugin_dafeiyu');
  assert.equal(r1.version, '1.0.0');
  assert.equal(r1.backup, '');
  const dest = path.join(work, 'data', 'plugins', 'astrbot_plugin_dafeiyu');
  assert.equal(fs.readFileSync(path.join(dest, 'main.py'), 'utf8'), 'print("v1")\n');
  fs.mkdirSync(path.join(dest, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'data', 'user.json'), '{"remember":true}');

  const z2 = path.join(tmpRoot, 'v2.zip');
  fs.writeFileSync(z2, makeZip(pluginEntries('1.1.0', 'print("v2")\n')));
  const r2 = mgr.installFromZip(z2);
  assert.equal(r2.version, '1.1.0');
  assert.ok(r2.backup);
  assert.equal(fs.readFileSync(path.join(dest, 'main.py'), 'utf8'), 'print("v2")\n');
  assert.equal(fs.readFileSync(path.join(dest, 'data', 'user.json'), 'utf8'), '{"remember":true}');

  const listed = mgr.list();
  assert.equal(listed.plugins.length, 1);
  assert.equal(listed.plugins[0].version, '1.1.0');
  assert.ok(listed.backups.length >= 1);

  const rb = mgr.rollback(r2.backup);
  assert.equal(rb.ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'main.py'), 'utf8'), 'print("v1")\n');
  assert.equal(fs.readFileSync(path.join(dest, 'data', 'user.json'), 'utf8'), '{"remember":true}');
});
