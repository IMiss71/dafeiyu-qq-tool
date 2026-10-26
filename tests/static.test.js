const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('wizard server binds loopback only', () => {
  const s = read('backend/server.js');
  assert.match(s, /server\.listen\(actualPort, '127\.0\.0\.1'\)/);
  assert.match(s, /server\.listen\(free, '127\.0\.0\.1'\)/);
  assert.match(s, /srv\.listen\(ASTRBOT_PROXY_PORT, '127\.0\.0\.1'/);
});

test('wizard uses a per-process token, not a constant header', () => {
  const s = read('backend/server.js');
  assert.match(s, /const WIZARD_TOKEN = crypto\.randomBytes/);
  assert.match(s, /=== WIZARD_TOKEN/);
  assert.ok(!s.includes("x-dafeiyu-wizard'] === '1'"));
  assert.match(s, /window\.__DFY_TOKEN__/);
});

test('frontend sends the injected token', () => {
  const a = read('wizard/app.js');
  assert.match(a, /window\.__DFY_TOKEN__/);
  assert.ok(!a.includes("'X-DaFeiYu-Wizard': '1'"));
});

test('no fixed dashboard password in deploy code', () => {
  const d = read('backend/deploy.js');
  assert.ok(!/DaFeiYu\d{3}/.test(d));
  assert.match(d, /getOrCreateDashboardPassword/);
  assert.match(d, /ASTRBOT_DASHBOARD_INITIAL_PASSWORD: getOrCreateDashboardPassword\(\)/);
});

test('startup log never prints the panel password', () => {
  const d = read('backend/deploy.js');
  assert.ok(!d.includes('pw.password'));
});

test('launcher has no popups', () => {
  const v = read('launcher/start-hidden.vbs');
  assert.ok(!/MsgBox/i.test(v));
  assert.ok(!/WScript\.Echo/i.test(v));
  assert.match(v, /WScript\.Sleep/);
});

test('installer is per-user and has no extra wizard pages', () => {
  const i = read('installer/dafeiyu.iss');
  assert.match(i, /PrivilegesRequired=lowest/);
  assert.match(i, /DisableWelcomePage=yes/);
  assert.match(i, /DisableFinishedPage=yes/);
  assert.match(i, /DefaultDirName=\{localappdata\}/);
});

test('version and manifest template agree', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '2.2.1');
  const m = JSON.parse(read('manifest.template.json'));
  assert.equal(m.product, 'dafeiyu-qq-deployer');
  assert.equal(m.schema_version, 1);
});

test('no BOM in package/template JSON', () => {
  for (const f of ['package.json', 'manifest.template.json']) {
    const b = fs.readFileSync(path.join(root, f));
    assert.ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), f);
  }
});

test('wizard has no blocking alert/confirm calls', () => {
  const a = read('wizard/app.js');
  assert.ok(!/\balert\s*\(/.test(a));
  assert.ok(!/\bconfirm\s*\(/.test(a));
});
