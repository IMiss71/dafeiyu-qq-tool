# 大肥鱼 QQ 部署向导（dafeiyu-deployer）

> 一个**免费、开源、零现金成本**的 Windows 一键部署向导：装好 AstrBot + NapCat，配好模型，启动 QQ 机器人。
> 付费插件不在此仓库；本工具只做通用的“安装 + 启动 + 诊断 + 插件包管理”。

---

## 这个项目解决什么

手动装 AstrBot + NapCat 对普通用户是十几步的折腾：Python、uv、pip 镜像、OneBot token、反向 WS、端口冲突、掉线、黑窗。
这个向导把它收成一次点击，并且把“装错了怎么办”做成可诊断、可回滚的流程。

- 环境体检（Windows 版本、磁盘、端口、网络、杀软）
- 装 uv / Python / AstrBot（镜像竞速、超时、断点）
- 装 NapCat（官方下载 + SHA256；不随包分发）
- 模型配置（云端 / 本地 Ollama，写前连通性自检）
- 人设注入（写 AstrBot 数据库并设为默认人格）
- 启动、探活、掉线自愈
- 诊断包（Key / QQ / 手机号自动打码）
- 通用插件包安装 / 升级 / 回滚（付费插件走这里，不进本仓库）
- 修复工具（按现象命名的 5 个 .bat）
- 一键启动 / 停止（无窗口）

---

## 零现金说明（重要）

这个仓库按“**只有 token / 时间成本，没有现金成本**”设计：

- 不买代码签名证书 → **首次安装会弹 1 次 Windows SmartScreen**，点“更多信息 → 仍要运行”即可。
- 不买域名 / 服务器 / 监控 / 设计 / 法务 → 用 GitHub Releases、GitHub Pages、Windows Sandbox、系统字体。
- CI 用 GitHub Actions 公开仓；更新用 GitHub Releases + Ed25519 签名；诊断包本地生成。
- 不分发 NapCat 离线包（合规 + 体积）；安装时从官方下载并校验 SHA256，用户也可以自己放本地 zip。

如果你以后想消掉那 1 次 SmartScreen，可以申请免费 OSS 代码签名（SignPath / Certum OSS）。不申请也不影响使用。

---

## 系统要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 22H2+ / Windows 11，x64 |
| 内存 | 4GB 以上（本地 Ollama 建议 16GB） |
| 磁盘 | 2GB 以上空闲 |
| 网络 | 首次安装需要联网（AstrBot / NapCat / 依赖） |
| 权限 | 按用户安装，**不需要管理员** |

---

## 安装

### 方式 A：安装包（推荐）

1. 从 Releases 下载 `DaFeiYu-Setup-<version>.exe`。
2. 双击。若出现 SmartScreen：**更多信息 → 仍要运行**。
3. 安装器只有进度页，不会弹 UAC、不会打开控制台。
4. 装完自动打开向导（浏览器一个标签页）。

安装位置：`%LOCALAPPDATA%\Programs\DaFeiYuQQ`
运行数据：`%LOCALAPPDATA%\DaFeiYuQQ`（卸载默认保留，聊天/人设/配置都在这里）

### 方式 B：便携包

1. 下载 `DaFeiYu-Portable-<version>.zip`，解压到**纯英文、无空格**路径。
2. 双击 `launcher\start-hidden.vbs`（或开始菜单快捷方式）。
3. 不要直接双击 `wizard/index.html`：那是 `file://`，没有后端，按钮全部失效。

### 方式 C：从源码构建

见 [docs/build.md](docs/build.md)。最短路径：

```powershell
git clone <repo>
cd dafeiyu-deployer
# 可选：把 node.exe / python / NapCat.Shell.zip 放进 payload\
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -SkipSmoke
```

产物在 `dist\`。没有 `iscc.exe` 时会自动退化为 portable zip。

---

## 日常使用

- 启动：双击桌面/开始菜单“大肥鱼部署向导”。
- 停止：开始菜单“停止大肥鱼”，或 `launcher\stop-hidden.vbs`。
- 完全卸载：Windows 设置 → 应用 → 大肥鱼 QQ 部署向导。
- 面板密码：**每次安装随机生成**，在向导完成页 / “关于”页显示，也写在
  `%LOCALAPPDATA%\DaFeiYuQQ\dashboard_credentials.json`。
- 不再使用固定面板密码。

---

## 安全模型

- 所有本地 HTTP 服务只绑 `127.0.0.1`，不开放局域网。
- 向导 API 需要每次进程启动随机生成的 `X-DaFeiYu-Wizard` token；token 由后端注入页面。
- 校验 Host，拒绝非本机来源；请求体上限 5MB。
- 安装器按用户安装，不写 HKLM、不装服务、不开防火墙规则。
- 不默认上传任何数据；诊断包本地生成、自动打码。
- 不内置 NapCat 离线包；不内置任何 API Key。

---

## 合规

- 本仓库代码：MIT（见 `LICENSE`）。
- AstrBot：AGPL-3.0。我们对它的改动在 `patches/`，并锁定 upstream 版本；分发时保留公开仓库地址。
- NapCat：Limited Redistribution License，禁止商业使用、再分发需附许可证。
  本仓库**不分发** NapCat.Shell.zip；安装时从官方 release 下载并校验 SHA256。
- 第三方组件清单：`LICENSE_NOTICE.md`、`OPEN_SOURCE_NOTICE.md`。
- 本项目不提供法律意见；对外收费/代部署前请自行确认 NapCat 与 AGPL 边界。

---

## 仓库结构

```text
backend/            Node 零依赖后端（安装编排、API、代理、自检）
wizard/             原生 HTML/JS/CSS 向导
launcher/           无窗口启动/停止 VBS + 本地错误页
installer/          Inno Setup 6 脚本
scripts/            build.ps1 / verify.ps1 / stop.js / stop-wizard.js / boot.js
assets/             人设与静态资源
patches/            对 AstrBot 的补丁（AGPL 公开义务）
docs/               使用、构建、发布、架构、排障
修复工具/           5 个按现象命名的修复/诊断脚本
tests/              node:test 静态回归
payload/            本地构建用的运行时（node.exe/python/NapCat，gitignore）
dist/               构建产物（gitignore）
```

---

## 测试与发布

```powershell
npm test
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
```

`verify.ps1` 会检查：

- 必需文件、版本一致性
- JSON BOM、禁止文件（`data/cmd_config.json`、`__pycache__`、`.bak-*`、日志）
- 固定密码 / 明显密钥 / 绝对用户路径
- JS/Python 语法
- manifest 文件数与 SHA256
- 冒烟：起服务、`/api/ping`、token 注入、无 token 的 `/api/about` 必须 403

发布流程见 [docs/release.md](docs/release.md)。

---

## 已知限制

- 未签名：首装 1 次 SmartScreen；个别杀软可能误报（把安装目录加信任即可）。
- 仅 Windows x64；不做 macOS/Linux。
- 单个机器人账号；多 bot 需要第二实例。
- 没有开机自启（避免服务/权限复杂度）；重启电脑后需手动点“启动”。
- 不做默认遥测；出问题靠诊断包。

---

## 路线图

- **2.3.0（当前）**：插件管理器（manifest 校验 / 备份 / 回滚）+ Doctor 诊断面板 + 后端一键安装计划。
- **3.0.0**：继续拆 `deploy.js` 为完整状态机，补更新/回滚与更细的 Doctor 指标。
- 付费插件线独立：本仓库只提供通用插件包管理，不包含插件源码。

---

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞请走私密渠道，见 [SECURITY.md](SECURITY.md)。

## License

MIT。第三方组件许可见 `LICENSE_NOTICE.md` 与 `OPEN_SOURCE_NOTICE.md`。
