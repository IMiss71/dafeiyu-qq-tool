# 我们对上游 AstrBot 做了哪些改动（AGPL 第 13 条 · 公开义务）

本工具（大肥鱼一键部署向导）会**修改**用户机器上的 AstrBot。按 AGPL-3.0 第 13 条，  
只要把修改后的版本提供给他人使用，就必须**免费公开对应源码**。下面是完整清单与获取方式。

> ✅ 履行方式：本目录（`patches/`）+ `backend/` 下的脚本即为改动本体，随工具一起公开；  
> 发布仓库：https://github.com/IMiss71/dafeiyu-qq-tool （向导"关于"页显著位置给出链接即可）。

## 1. 改动清单

| # | 改动                              | 涉及文件（上游）                                                                   | 我们的实现                                                                                 | 为什么改                                                                               |
| - | ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 | **让 `force_tts` / `no_tts` 生效** | `astrbot/core/pipeline/result_decorate/stage.py`                           | `patches/apply_astrbot_tts_patch.py`（也可由 `backend/deploy.js: patchAstrbotTts()` 自动执行） | 上游只按概率决定是否朗读，不读插件设的标记 → "让它发语音也不发"                                                 |
| 2 | **写入 aiocqhttp（NapCat）适配器配置**   | `data/cmd_config.json` / `data/config.json` 的 `platform[].ws_reverse_*`    | `backend/deploy.js: patchWizardOverridesObj()`                                        | 上游模板字段名与适配器实际读取的字段不一致（`host/port` → `ws_reverse_host/port/token`），写错会 KeyError 起不来 |
| 3 | **注入默认人格（大肥鱼）**                 | `data/data_v4.db` 的 `personas` 表                                           | `backend/inject_persona.py`                                                           | 上游面板需手填；`personas` 表没有 `name` 列，`created_at/updated_at` 非空，脚本已按此处理                 |
| 4 | **视觉（识图）provider 自动注册**         | 配置里的 `provider_settings.default_image_caption_provider_id` 与 `provider` 列表 | `backend/deploy.js: registerCloudCaptionProvider()` / `registerVisionProvider()`      | 让纯文本主模型也能"看懂"图片，免去手填                                                               |
| 5 | **模型配置写入（含云端/本地预设）**            | `provider` / `provider_settings` / `agent_runner.config.model`             | `backend/config_templates.js: buildProviderConfig()`                                  | 上游面板字段多、易填错（如模型名 404），这里给出经过实测的预设                                                  |
| 6 | **清理插件配置的 UTF-8 BOM**           | `data/config/*.json`                                                       | `backend/deploy.js: sanitizePluginConfigs()`                                          | 用记事本改过配置会带 BOM，AstrBot 解析失败 → "插件装了但完全没效果"，且日志不报错                                  |
| 7 | **本地思考型模型自动建 `-nothink` 变体**    | Ollama 模型（不在 AstrBot 源码内）                                                  | `backend/deploy.js: ensureNoThinkVariant()` / `ensureCaptionVariant()`                | 思考型模型在 `/v1` 接口下 `content` 为空                                                      |

以上改动均为**配置层 + 一处源码补丁**，不改动 AstrBot 的许可与版权声明。

## 2. 上游源码获取

- AstrBot：<https://github.com/AstrBotDevs/AstrBot> （AGPL-3.0-or-later，本项目基于 4.29.1）
- NapCat：<https://github.com/NapNeko/NapCatQQ> （Limited Redistribution License；默认不随包分发，安装时从官方 release 下载并校验 SHA256。可选 Offline 包须附 `vendor/LICENSE-NAPCAT.txt`，仅限个人非商用）

## 3. 需要你（发布者）做的三件事

1. 仓库已公开：https://github.com/IMiss71/dafeiyu-qq-tool （工具的"关于"页会展示该链接）；
2. 分发包内保留 `LICENSE_NOTICE.md`（第三方许可证原文/链接）；
3. 若以后新增了对 AstrBot 的其它修改，**同步补进本表并公开**（否则 AGPL 义务未履行）。

## 4. 声明

本工具完全免费，不含、不代理、不代售 AstrBot 或 NapCat 的任何授权。  
AstrBot 依 AGPL-3.0-or-later 授权，任何人都可以免费从上游获取并使用；如有人声称"必须付费才能用 AstrBot"，请向上游举报。
