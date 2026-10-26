const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AppError, asAppError } = require('../backend/core/errors');
const { InstallState } = require('../backend/core/state');
const { validatePluginManifest, compareVersions, isSafeRelPath } = require('../backend/core/manifest');
const { runSteps } = require('../backend/core/steps');

const tmpBase = path.join(__dirname, 'tmp');
fs.mkdirSync(tmpBase, { recursive: true });
const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'core-'));

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

test('AppError keeps user-facing fields separate from detail', () => {
  const e = new AppError('E_NET', '网络不通', { detail: 'ECONNRESET', remediation: '换热点重试' });
  assert.equal(e.code, 'E_NET');
  assert.equal(e.userMessage, '网络不通');
  assert.equal(e.detail, 'ECONNRESET');
  assert.equal(e.retryable, true);
  assert.deepEqual(e.toJSON(), {
    code: 'E_NET', userMessage: '网络不通', detail: 'ECONNRESET', remediation: '换热点重试', retryable: true,
  });
  const wrapped = asAppError(new Error('boom'));
  assert.equal(wrapped.code, 'E_UNKNOWN');
  assert.equal(wrapped.detail, 'boom');
});

test('InstallState persists, resumes and marks done', () => {
  const file = path.join(tmpRoot, 'state.json');
  const s = InstallState.load(file);
  s.beginStep('preflight', '环境体检');
  s.completeStep('preflight', 'ok');
  s.beginStep('install', '安装');
  s.completeStep('install', 'ok');
  assert.equal(s.data.status, 'done');

  const loaded = InstallState.load(file);
  assert.equal(loaded.data.status, 'done');
  assert.equal(loaded.getStep('preflight').status, 'done');
  assert.equal(loaded.summary().steps.length, 2);
  assert.equal(fs.existsSync(file + '.corrupt-'), false);
});

test('InstallState backs up corrupt JSON and starts clean', () => {
  const file = path.join(tmpRoot, 'corrupt.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  const s = InstallState.load(file);
  assert.equal(s.data.status, 'idle');
  assert.ok(s.data.install_id);
  const backups = fs.readdirSync(tmpRoot).filter((n) => n.startsWith('corrupt.json.corrupt-'));
  assert.equal(backups.length, 1);
});

test('manifest accepts a valid package and rejects unsafe paths', () => {
  const good = {
    name: 'astrbot_plugin_dafeiyu',
    version: '1.8.0',
    min_astrbot: '4.25.0',
    files: [{ path: 'main.py', sha256: 'a'.repeat(64), size: 1234 }],
    entry: 'main.py',
  };
  assert.equal(validatePluginManifest(good).ok, true);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(isSafeRelPath('../evil.py'), false);
  assert.equal(isSafeRelPath('C:/evil.py'), false);

  const bad = {
    name: 'bad name',
    version: '1.0',
    files: [{ path: '../evil.py', sha256: 'abc' }],
  };
  const r = validatePluginManifest(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3);
});

test('runSteps runs in order and rolls back on failure', async () => {
  const file = path.join(tmpRoot, 'steps.json');
  const state = InstallState.load(file);
  const order = [];
  const steps = [
    {
      id: 'a', title: 'A', run: async () => { order.push('a'); return 'a'; },
      rollback: async () => { order.push('rollback-a'); },
    },
    {
      id: 'b', title: 'B', run: async () => { order.push('b'); throw new Error('boom'); },
    },
  ];

  await assert.rejects(
    () => runSteps(steps, {}, state),
    (e) => e instanceof AppError && e.code === 'E_STEP_FAILED'
  );
  assert.deepEqual(order, ['a', 'b', 'rollback-a']);
  assert.equal(state.data.status, 'failed');
  assert.equal(state.getStep('a').rolled_back, true);
});

test('runSteps enforces timeouts and cancellation', async () => {
  await assert.rejects(
    () => runSteps([{ id: 'slow', title: 'Slow', timeoutMs: 10, run: () => new Promise((r) => setTimeout(r, 80)) }]),
    (e) => e.code === 'E_TIMEOUT'
  );

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => runSteps([{ id: 'never', title: 'Never', run: async () => {} }], { signal: aborted.signal }),
    (e) => e.code === 'E_CANCELLED'
  );
});
