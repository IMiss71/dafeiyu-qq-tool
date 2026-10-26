const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstallPlan, planMeta } = require('../backend/steps/install-plan');

test('install plan is stable and ordered', () => {
  const ids = createInstallPlan().map((s) => s.id);
  assert.deepEqual(ids, [
    'preflight',
    'install_uv',
    'install_astrbot',
    'init_astrbot',
    'install_napcat',
    'install_plugin',
  ]);
  for (const s of createInstallPlan()) {
    assert.equal(typeof s.run, 'function');
    assert.ok(s.title);
    assert.ok(s.timeoutMs > 0);
  }
});

test('install plan can skip network-heavy optional steps', () => {
  const ids = createInstallPlan({ includeNapcat: false, includePlugin: false }).map((s) => s.id);
  assert.deepEqual(ids, ['preflight', 'install_uv', 'install_astrbot', 'init_astrbot']);
});

test('planMeta exposes no functions to the UI', () => {
  const meta = planMeta();
  assert.equal(meta.length, 6);
  assert.equal(meta[0].id, 'preflight');
  assert.equal(meta[0].run, undefined);
});
