# 第三方许可证与授权说明（大肥鱼 QQ 一键部署向导）

本工具本身以 **MIT 许可证** 发布（见仓库根目录 `LICENSE`）。  
它通过**安装、配置与编排**的方式使用以下开源项目：

| 组件                | 许可证                                              | 源码                                       | 用途                          | 是否随本工具分发                 |
| ----------------- | ------------------------------------------------ | ---------------------------------------- | --------------------------- | ------------------------ |
| AstrBot           | AGPL-3.0-or-later                                | <https://github.com/AstrBotDevs/AstrBot> | 聊天机器人核心：人设 / 记忆 / 调模型 / 多平台 | ❌ 由用户在安装时联网获取            |
| NapCat (NapCatQQ) | Limited Redistribution License（**禁止商业用途**、限制再分发） | <https://github.com/NapNeko/NapCatQQ>    | 把 QQ 个人号暴露为 OneBot 接口       | ❌ 默认不分发；安装时从官方下载并校验 SHA256。可选 Offline 包由用户自行放入 `payload\`，发布时须附 `vendor/LICENSE-NAPCAT.txt`，仅限个人非商用 |
| ffmpeg            | GPL / LGPL（按构建）                                  | <https://ffmpeg.org>                     | 语音转码（TTS 用）                 | ✅ 运行时下载                  |
| Python / uv       | PSF / MIT                                        | —                                        | 运行 AstrBot                  | 按构建可选：联网时由 uv 安装；离线包可自带便携版 |
| Inno Setup        | Inno Setup License                               | <https://jrsoftware.org/isinfo.php>      | 生成 Windows 安装包                | 构建工具，不随包分发               |

## 我们对上游的改动（AGPL 第 13 条）

工具**会**对 AstrBot 做少量修改（配置层 + 一处源码补丁）。这些改动已随本仓库完整公开：  
见 **`patches/README.md`**（逐条清单）与 **`patches/apply_astrbot_tts_patch.py`**（可独立运行的补丁脚本）。  
发布仓库：https://github.com/IMiss71/dafeiyu-qq-tool（向导"关于"页同步展示）。

## 免费声明

- 本工具**完全免费**：没有 PRO 功能、没有激活码，所有功能直接可用，任何人可自由使用、修改、分发（MIT 许可范围内）。
- AstrBot / NapCat 本身均为开源软件，任何人都可以免费从上游获取。  
  本工具**不收取、也不代收**任何第三方软件的"授权费/版权费"。
- NapCat 的许可证**禁止商业用途**：本工具默认不内置、不分发 NapCat；安装时从官方 release 下载并校验 SHA256。若使用可选的 Offline 包，必须保留 `vendor/LICENSE-NAPCAT.txt`，且仅限个人学习研究使用；QQ 通道**务必使用 QQ 小号**。

## 使用即表示接受

- AstrBot 的许可条款：AGPL-3.0-or-later（<https://www.gnu.org/licenses/agpl-3.0.html）>
- NapCat 的许可条款：见其仓库 LICENSE（禁止商业用途、再分发需附许可证）
- QQ：**非官方协议存在封号风险，请使用不重要的小号**，后果由使用者自行承担。
- 使用者自行承担其大模型 API 费用（或本机跑 Ollama 完全免费）。

## 隐私

本工具是纯本地工具：**不上传** QQ 号、聊天记录、API Key、任何文件内容。
