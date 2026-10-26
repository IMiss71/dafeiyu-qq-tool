'use strict';

const { AppError, asAppError } = require('./errors');

function defineStep(def) {
  if (!def || typeof def !== 'object') throw new TypeError('step must be an object');
  if (!def.id || !/^[a-z0-9_]+$/.test(def.id)) throw new Error('step.id must be lower_snake_case');
  if (typeof def.run !== 'function') throw new Error(`step ${def.id} must have run()`);
  return Object.assign({ title: def.id, timeoutMs: Number(def.timeoutMs) || 0 }, def);
}

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AppError('E_TIMEOUT', `步骤「${label}」超时`, {
        remediation: '检查网络/磁盘后重试；必要时查看诊断日志',
        retryable: true,
      }));
    }, ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function runSteps(steps, ctx = {}, state = null, opts = {}) {
  const list = (steps || []).map(defineStep);
  const completed = [];

  for (const step of list) {
    if (ctx.signal && ctx.signal.aborted) {
      throw new AppError('E_CANCELLED', '安装已取消', { retryable: true });
    }
    if (state) state.beginStep(step.id, step.title);
    if (typeof opts.onStepStart === 'function') opts.onStepStart(step);

    try {
      const result = await withTimeout(
        Promise.resolve().then(() => step.run(ctx)),
        step.timeoutMs,
        step.title
      );
      if (typeof step.verify === 'function') {
        await withTimeout(
          Promise.resolve().then(() => step.verify(ctx, result)),
          step.timeoutMs,
          `${step.title} 校验`
        );
      }
      completed.push(step);
      if (state) state.completeStep(step.id, result);
      if (typeof opts.onStepDone === 'function') opts.onStepDone(step, result);
    } catch (err) {
      const appErr = asAppError(err, {
        code: 'E_STEP_FAILED',
        userMessage: `步骤「${step.title}」失败`,
      });
      if (state) state.failStep(step.id, appErr);

      if (opts.rollbackOnError !== false) {
        const rollbackErrors = [];
        for (const done of completed.slice().reverse()) {
          if (typeof done.rollback !== 'function') continue;
          try {
            await done.rollback(ctx);
            if (state) state.markRolledBack(done.id);
          } catch (re) {
            rollbackErrors.push({ step: done.id, error: (re && re.message) || String(re) });
          }
        }
        if (rollbackErrors.length) appErr.rollbackErrors = rollbackErrors;
      }
      throw appErr;
    }
  }

  if (state) {
    state.data.status = 'done';
    state.save();
  }
  return completed;
}

module.exports = { defineStep, runSteps, withTimeout };
