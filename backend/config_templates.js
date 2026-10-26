// config_templates.js
// 生成 AstrBot / NapCat 所需的配置文件片段。
// 纯函数，无外部依赖，方便单测与向导前端直接引用。

// AstrBot 反向 WS 默认端口（OneBot v11 适配器服务端）
// 用 16199 而非默认 6199：避开机器上可能已在运行的 AstrBot 实例
const ASTRBOT_REVERSE_WS_PORT = 16199;
const NAPCAT_WS_CLIENT_PORT = 3001; // NapCat 自己对外暴露的 WS 服务端端口（可选）

// 常见模型服务商预设。用户选一个，再填 key 即可。
// vision: 该预设的默认模型能否「看图」。
// 关键：AstrBot 里 provider.modalities 为空 = 默认「支持所有模态」（向后兼容），
// 于是图片会被直接塞给纯文本模型 → 400 "model does not support multimodal requests"（实测翻车）。
// 所以必须显式标注，让 AstrBot 自动把图片过滤掉。
const PROVIDER_PRESETS = {
  deepseek: {
    label: 'DeepSeek（国内首选，便宜）',
    api_base: 'https://api.deepseek.com/v1',
    default_model: 'deepseek-chat',
    vision: false, // deepseek-chat 不支持图片输入
    caption_model: '', // 该家没有视觉模型 → 识图要另配一把 Key
    note: 'deepseek-chat 是纯文本模型，直接丢图片会报错。想让它“看图”，要么改用硅基流动，要么在下面另填一个视觉模型（如硅基流动的 Qwen2.5-VL）。',
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow（注册送额度）',
    api_base: 'https://api.siliconflow.cn/v1',
    default_model: 'deepseek-ai/DeepSeek-V3',
    vision: false,
    // 同一把 Key、同一个 base 就能调，识图可以全自动开通
    caption_model: 'Qwen/Qwen2.5-VL-7B-Instruct',
    note: '一把 Key 通用全部模型：主模型用 DeepSeek-V3，识图自动挂 Qwen2.5-VL，无需再申请。',
  },
  dashscope: {
    label: '阿里百炼（通义千问，有免费额度）',
    api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    default_model: 'qwen-plus',
    vision: false,
    caption_model: 'qwen-vl-max',
    note: '一把 Key 通用 qwen 全系；识图自动挂 qwen-vl-max。',
  },
  openai: {
    label: 'OpenAI（质量高，贵，需代理）',
    api_base: 'https://api.openai.com/v1',
    default_model: 'gpt-4o-mini',
    vision: true, // gpt-4o 系列原生收图，直接喂给主模型（信息最全）
    caption_model: '',
    note: 'gpt-4o / gpt-4.1 系列原生支持图片，图片直接交给主模型看，不需要额外的识图模型。',
  },
  ollama: {
    label: 'Ollama（本地免费，需本机跑模型）',
    api_base: 'http://localhost:11434/v1',
    default_model: 'qwen2.5:7b',
    default_key: 'ollama', // Ollama 不校验 key
    vision: false, // 本地默认装的多是纯文本模型（如 qwen3:8b）
    caption_model: '', // 留空 = 部署时自动探测本机已装的视觉模型
    note: '需要本机已装 Ollama 并提前 ollama pull 好模型。识图会在部署时自动探测本机视觉模型。',
  },
  freellmapi: {
    label: 'FreeLLMAPI（本地聚合免费额度，需先自建）',
    api_base: 'http://127.0.0.1:3001/v1',
    // 它自己会在多家免费额度里挑，auto 就是「让路由器选」
    default_model: 'auto',
    vision: false, // 能不能看图取决于它当前路由到的模型，默认不勾
    caption_model: '',
    note: 'FreeLLMAPI 是本地运行的免费额度聚合网关（GitHub: tashfeenahmed/freellmapi，MIT 协议）：把 Google AI Studio / Groq / Cerebras / OpenRouter / 智谱等几十家的免费 Key 收口成一个 OpenAI 兼容入口。用法：先按它 README 起服务（默认 http://127.0.0.1:3001），在 Keys 页填各家 Key，再把这把统一 Key（freellmapi-…）填到上面。模型名保持 auto 即可（也可填 auto:fast / auto:smart）。注意：本机服务，电脑关了模型就断，建议留一个官方 Key 兜底；免费额度有频率限制，不要用于对外收费服务。',
  },
  custom: {
    label: '自定义 / 中转站（OpenAI 兼容）',
    api_base: '',
    default_model: '',
    vision: false,
    caption_model: '',
    note: '适用于 OneAPI / NewAPI / 各类中转站。Base URL 一般以 /v1 结尾，模型名填服务商文档里的那个。',
  },
};

// 云端服务商的默认上下文轮数：云端 context 普遍 32k~128k，给足一点，
// 聊天才不会“忘事”。本地 Ollama 因为吃显存/内存，另按小值处理。
const CLOUD_MAX_CONTEXT_LENGTH = 30;
const LOCAL_MAX_CONTEXT_LENGTH = 15;

/**
 * 生成 AstrBot 的「模型提供商」配置片段。
 * 返回对象可直接 merge 进 data/config.json 的 provider / provider_settings。
 */
function buildProviderConfig({ provider, apiKey, apiBase, model, modelVision, extraBody }) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const base = apiBase && apiBase.trim() ? apiBase.trim() : preset.api_base;
  const key =
    apiKey && apiKey.trim()
      ? apiKey.trim()
      : provider === 'ollama'
      ? preset.default_key
      : '';
  const m = model && model.trim() ? model.trim() : preset.default_model;
  // 前端可以显式覆盖「这个模型能不能直接看图」（中转站/自定义模型判断不了）
  const canSeeImages = typeof modelVision === 'boolean' ? modelVision : !!preset.vision;

  // modalities 必须显式写：留空会被 AstrBot 当成「支持所有模态」，
  // 收到表情包/图片时直接 400。tool_use 保留工具调用能力。
  const modalities = canSeeImages ? ['text', 'image', 'tool_use'] : ['text', 'tool_use'];

  const entry = {
    id: provider,
    type: 'openai_chat_completion',
    model: m,
    key: [key],
    api_base: base,
    enable: true,
    modalities,
  };
  // 云端思考型模型（Qwen3 等）默认会先吐一段思考，AstrBot 拿到的正文可能为空。
  // 阿里百炼 / 硅基流动都支持在请求体里显式关掉。
  if (extraBody && typeof extraBody === 'object' && Object.keys(extraBody).length) {
    entry.custom_extra_body = extraBody;
  }

  return {
    provider: [entry],
    provider_settings: {
      default_provider_id: provider,
      enable: true,
    },
  };
}

/**
 * 生成 NapCat 的 OneBot v11 配置：作为 WS 客户端连回 AstrBot 的反向 WS。
 * 同时保留 NapCat 自身的 WS 服务端（便于调试）。
 */
function buildNapCatOnebotConfig({ astrobotWsPort = ASTRBOT_REVERSE_WS_PORT, token = '' } = {}) {
  return {
    http: {
      enable: false,
      host: '0.0.0.0',
      port: 3000,
      secret: '',
      postUrls: [],
    },
    ws: {
      enable: true,
      // 只绑本机：这是调试用的 WS 服务端，绑 0.0.0.0 会让局域网内任何人都能连
      host: '127.0.0.1',
      port: NAPCAT_WS_CLIENT_PORT,
    },
    wsClient: {
      enable: true,
      url: `ws://127.0.0.1:${astrobotWsPort}/ws`,
      token: token,
      reconnectInterval: 5000,
      heartInterval: 5000,
    },
  };
}

module.exports = {
  ASTRBOT_REVERSE_WS_PORT,
  NAPCAT_WS_CLIENT_PORT,
  CLOUD_MAX_CONTEXT_LENGTH,
  LOCAL_MAX_CONTEXT_LENGTH,
  PROVIDER_PRESETS,
  buildProviderConfig,
  buildNapCatOnebotConfig,
};
