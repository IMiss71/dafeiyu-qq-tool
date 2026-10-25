# 🐟 大肥鱼 QQ AI 部署向导

一个**完全免费、开源**的 QQ AI 聊天机器人一键部署工具。  
双击 `start-wizard.bat`，跟着向导走：填好 API Key（或本机 Ollama）→ 小号扫码登录 → 就能在 QQ 上和大肥鱼聊天。

底层基于开源项目 [AstrBot](https://github.com/AstrBotDevs/AstrBot)（AGPL-3.0）+ [NapCat](https://github.com/NapNeko/NapCatQQ)（由用户自行获取），外壳与编排脚本均为本仓库原创（MIT）。

## 📚 文档

| 想干什么                         | 看哪份                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 快速上手（3 步跑起来）                 | [docs/使用说明.md](docs/使用说明.md)                                                                                               |
| 配模型（云端 6 家 / 本地 Ollama / 识图） | [docs/模型配置指南.md](docs/模型配置指南.md)                                                                                           |
| 出问题自己排（不回消息、下载失败、端口占用…）      | [docs/常见问题排查.md](docs/常见问题排查.md)                                                                                           |
| 许可证与开源合规                     | [LICENSE\_NOTICE.md](LICENSE_NOTICE.md) · [OPEN\_SOURCE\_NOTICE.md](OPEN_SOURCE_NOTICE.md) · [patches/](patches/README.md) |

---

## ✨ 它能做什么

- **一键部署**：自动安装 AstrBot、竞速下载依赖、写入配置、注入人设、启动服务，全程无需手改 JSON。
- **模型配置助手**：点一下「获取可用模型」自动拉取清单并推荐，写配置前先做一次真实连通性自检，Key/模型名填错当场告诉你原因。
- **环境体检**：开页面自动检查 Windows 版本、磁盘、端口、网络、杀软等 17 项，别人电脑上才会踩的坑提前列出来。
- **诊断报告**：一键生成自动打码（Key/密码/手机号）的诊断 txt，远程求助不用来回截图。
- **表情包 / TTS 语音 / 识图**：全套已内置调好。
- **完全免费**：没有 PRO、没有激活码、没有卡密，所有功能直接可用。

## ⚠️ 使用前必读

- QQ 走 NapCat 是**非官方协议**，存在封号风险 → **务必用不重要的小号**，不要用主号。
- 脚本未做代码签名 → Windows 可能弹 SmartScreen，点「仍要运行」即可。
- **不要直接双击 `wizard/index.html`**：那是 `file://` 打开，没有本地后端，按钮全部失效。请一律用 `start-wizard.bat`。

## 🚀 怎么运行

1. 双击 **`start-wizard.bat`**（或中文名的 `启动向导.bat`，两者相同）。
2. 脚本自动找 Node → 启动本地后端 → 打开浏览器 `http://127.0.0.1:18765/`。
3. 跟着向导走即可。

> - 找不到 Node？去 [nodejs.org](https://nodejs.org) 装一下，或把 `node.exe` 放进 `tools\node.exe`。
> - 端口 18765 被占用时后端会自动顺延到 18766~18775，实际端口写在 `wizard.port`。
> - 安装 AstrBot 时会从 6 个 PyPI 镜像实时竞速挑最快的；NapCat 由向导联网下载（多源并发，自带校验）。

## 🧭 向导流程

| 步骤              | 谁做       | 说明                                   |
| --------------- | -------- | ------------------------------------ |
| 环境体检            | ✅ 自动     | 17 项检查 + 一键释放端口                      |
| 安装 uv / AstrBot | ✅ 自动     | 镜像竞速 + 实时下载进度条                       |
| NapCat 下载安装     | ✅ 自动     | 多源并发竞速 + 大小/魔数校验 + 停滞超时              |
| 填写大模型           | 你填       | 云端 Key 或本地 Ollama，带智能模型列表与连通性自检      |
| 注入大肥鱼人设         | ✅ 自动     | 直接写进 AstrBot 数据库并设为默认人格              |
| 启动 AstrBot      | ✅ 自动     | 后台常驻，面板一键免密登录                        |
| NapCat 扫码登录     | ✋ 手动 1 下 | 向导打开 NapCat 面板 → 小号扫码 → WS 自动接上（带自愈） |

## 🤖 用云端模型还是本地模型？

📖 手把手图文版见 **[docs/模型配置指南.md](docs/模型配置指南.md)**。速查：

| 方案            | 花钱                 | 需要显卡  | 速度  | 识图          |
| ------------- | ------------------ | ----- | --- | ----------- |
| **硅基流动**（推荐）  | 注册送额度，之后约 ¥1~3/百万字 | 不需要   | 快   | ✅ 一把 Key 搞定 |
| **DeepSeek**  | 约 ¥1~2/百万字         | 不需要   | 快   | ⚠️ 需另配视觉模型  |
| **阿里百炼**      | 有免费额度              | 不需要   | 快   | ✅           |
| **OpenAI**    | 贵，需代理              | 不需要   | 看网络 | ✅           |
| **本地 Ollama** | 免费                 | **要** | 慢   | ✅ 自动探测      |

云端模式的坑（向导已处理好）：纯文本模型收图 400 → 自动路由视觉模型转述；Qwen3 思考型空回复 → 自动关思考 / 建 `-nothink` 变体；Key/模型名错误 → 写入前真实请求自检。

## 🔑 登录凭据

| 项目          | 值                                     | 说明                  |
| ----------- | ------------------------------------- | ------------------- |
| AstrBot 用户名 | `astrbot`                             | 固定                  |
| AstrBot 密码  | `DaFeiYu666`                          | 向导预置，可在面板里改         |
| AstrBot 面板  | `http://127.0.0.1:18666/`             | 向导起的免密代理入口          |
| NapCat 面板   | `http://127.0.0.1:6099/webui?token=…` | 向导里点「打开 NapCat（免密）」 |

## 📁 目录结构

```
├── start-wizard.bat      # ★ 双击启动（GBK 编码，勿转存 UTF-8）
├── wizard/               # 向导前端（纯 HTML/JS/CSS，无框架）
├── backend/              # Node 编排后端（零依赖）
│   ├── server.js         # HTTP 服务 + API
│   ├── deploy.js         # 安装/初始化/配置/启动/自愈（幂等）
│   ├── preflight.js      # 环境体检 17 项
│   ├── doctor.js         # 诊断报告（自动打码）
│   └── inject_persona.py # 人设注入（写 SQLite，零依赖）
├── scripts/              # setup_windows.ps1 独立安装脚本
├── patches/              # 对 AstrBot 的全部改动（AGPL 第 13 条公开义务）
├── assets/               # 大肥鱼人设
├── docs/                 # 模型配置指南等文档
└── tools/                # （分发包自带）可移植 node.exe / python
```

## ⚖️ 许可证与开源合规

- 本工具外壳以 **MIT** 发布（见 `LICENSE`）。
- **AstrBot**（AGPL-3.0-or-later）：本工具对它做的全部改动已在 **[patches/](patches/README.md)** 完整公开，履行 AGPL 第 13 条义务。
- **NapCat**（Limited Redistribution License，禁止商业用途）：本仓库**不分发**它，安装时由用户联网自行获取，仅供个人学习研究。
- 第三方许可明细见 [LICENSE\_NOTICE.md](LICENSE_NOTICE.md) 与 [OPEN\_SOURCE\_NOTICE.md](OPEN_SOURCE_NOTICE.md)。

## 🙏 致谢

- [AstrBot](https://github.com/AstrBotDevs/AstrBot) — 聊天机器人核心
- [NapCat](https://github.com/NapNeko/NapCatQQ) — QQ 协议端
