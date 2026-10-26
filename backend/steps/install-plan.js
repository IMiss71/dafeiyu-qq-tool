'use strict';

const { runSteps } = require('../core/steps');

function deploy() { return require('../deploy'); }
function preflight() { return require('../preflight'); }

// One canonical install plan. UI and CLI both read this list, so a step can
// never exist in one place but not the other.
function createInstallPlan(opts = {}) {
  const includeNapcat = opts.includeNapcat !== false;
  const includePlugin = opts.includePlugin !== false;

  const steps = [
    {
      id: 'preflight',
      title: '环境体检',
      timeoutMs: 120000,
      run: async () => ({ report: await preflight().run() }),
    },
    {
      id: 'install_uv',
      title: '安装 uv',
      timeoutMs: 300000,
      run: async () => deploy().installUv(),
    },
    {
      id: 'install_astrbot',
      title: '安装 AstrBot',
      timeoutMs: 600000,
      run: async () => deploy().installAstrbot(),
    },
    {
      id: 'init_astrbot',
      title: '初始化 AstrBot',
      timeoutMs: 300000,
      run: async () => deploy().initAstrbot(),
    },
  ];

  if (includeNapcat) {
    steps.push({
      id: 'install_napcat',
      title: '安装 NapCat',
      timeoutMs: 600000,
      run: async () => deploy().installNapCat(),
    });
  }

  if (includePlugin) {
    steps.push({
      id: 'install_plugin',
      title: '安装插件（可选）',
      timeoutMs: 120000,
      optional: true,
      run: async () => deploy().installBundledPlugin(),
    });
  }

  return steps;
}

function planMeta(opts = {}) {
  return createInstallPlan(opts).map((s) => ({
    id: s.id,
    title: s.title,
    timeoutMs: s.timeoutMs || 0,
    optional: !!s.optional,
  }));
}

async function runInstallPlan(ctx = {}, state = null, opts = {}) {
  return runSteps(createInstallPlan(opts), ctx, state, opts);
}

module.exports = { createInstallPlan, planMeta, runInstallPlan };
