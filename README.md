# 大肥鱼 QQ AI 部署工具

版本：2.4.0  
许可：MIT（本仓库代码）  
仓库：<https://github.com/IMiss71/dafeiyu-qq-tool>

大肥鱼 QQ AI 部署工具是面向 Windows 10/11 x64 的本地部署向导，用于安装和配置 AstrBot、NapCat、模型服务、人设与插件包，并提供启动、停止、诊断与修复入口。

本工具不内置大肥鱼插件源码。插件以独立 zip 交付，由用户在 AstrBot 插件页上传；本工具仅提供通用插件包管理、备份与回滚能力。

---

## 1. 功能范围

| 能力 | 说明 |
|---|---|
| 环境检查 | Windows 版本、磁盘、端口、网络、杀毒软件等 |
| AstrBot 安装 | Python/uv 环境、依赖安装、镜像竞速、超时与断点 |
| NapCat 安装 | 从官方渠道获取并校验 SHA256，不随包分发 |
| 模型配置 | OpenAI 兼容接口、本地 Ollama、连通性自检 |
| 人设注入 | 写入 AstrBot 数据库并设为默认人格 |
| 插件管理 | 上传、升级、备份、回滚；不内置插件 |
| 启动与停止 | 无窗口启动 AstrBot + NapCat，支持仅停止机器人 |
| 诊断 | Doctor 自检、诊断报告、Key/账号自动打码 |
| 修复工具 | 按故障现象命名的诊断与修复脚本 |

---

## 2. 系统要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 22H2 及以上 / Windows 11，x64 |
| 内存 | 4GB 及以上；本地 Ollama 建议 16GB |
| 磁盘 | 2GB 以上可用空间 |
| 网络 | 首次安装需要联网 |
| 权限 | 按用户安装；首次运行安装程序建议管理员权限 |
| 端口 | 16885、6099、16199 需可用 |

安装路径建议使用纯英文且不含空格的目录，例如 `D:\DaFeiYuQQ`。

---

## 3. 安装与运行

### 3.1 安装版

1. 从 Releases 下载 `DaFeiYu-Setup-2.4.0.exe`。
2. 右键选择“以管理员身份运行”。
3. 如出现 SmartScreen 提示，选择“更多信息” → “仍要运行”。
4. 按安装向导完成安装。
5. 安装完成后启动“大肥鱼部署向导”。

### 3.2 便携版

1. 解压 `DaFeiYu-Portable-2.4.0.zip` 至纯英文路径。
2. 运行 `launcher\start-hidden.vbs`。
3. 不得直接双击 `wizard/index.html`。

### 3.3 源码运行

```powershell
git clone https://github.com/IMiss71/dafeiyu-qq-tool.git
cd dafeiyu-qq-tool
npm start
```

浏览器访问 `http://127.0.0.1:18765/`。生产安装建议使用安装包。

---

## 4. 插件部署

插件包与部署工具分离。标准交付包含三档插件：

| 版本 | 能力数 | 说明 |
|---|---:|---|
| 基础版 | 4 | 随机延迟、表情包、断线补发、工具、面板 |
| 进阶版 | 9 | 基础版 + 主动私聊、空间说说、记忆、压缩、梗图理解 |
| 全能版 | 14 | 全部能力，含群聊上下文、语音、识图、唱歌、ASR |

使用要求：

1. 单台设备仅安装一个版本。
2. 三档插件共用同一内部插件名。
3. 升级或降级时保留用户数据。
4. 插件包不包含表情图片；`meme_packs` 由用户自行维护。

---

## 5. 目录结构

```text
backend/            Node 后端（安装编排、API、代理、自检）
wizard/             原生 HTML/JS/CSS 向导
launcher/           无窗口启动/停止脚本与错误页
installer/          Inno Setup 安装脚本
scripts/            构建、校验、启动、停止脚本
assets/             人设与静态资源
patches/            对 AstrBot 的补丁（AGPL 公开义务）
docs/               使用、构建、发布、架构、排障文档
修复工具/           按现象命名的诊断与修复脚本
tests/              Node 静态回归测试
payload/            本地构建运行时（gitignore）
dist/               构建产物（gitignore）
```

---

## 6. 数据与安全

### 6.1 数据目录

```text
%LOCALAPPDATA%\DaFeiYuQQ
```

该目录包含：

- `data_v4.db`：AstrBot 会话与人设
- 插件记忆、联系人、表情索引、提醒
- 插件升级备份
- 面板凭据

该目录不得对外分发。

### 6.2 安全模型

- 本地 HTTP 服务仅绑定 `127.0.0.1`。
- 向导 API 使用每次进程启动随机生成的 token。
- 校验 Host，拒绝非本机来源。
- 安装器按用户安装，不写入 HKLM，不安装服务，不修改防火墙。
- 不默认上传遥测数据。
- 诊断报告在本地生成并自动打码。
- 不内置 NapCat 离线包，不内置任何 API Key。

### 6.3 已知限制

- 安装程序未签名，首次安装会触发一次 SmartScreen。
- 仅支持 Windows x64。
- 单个机器人账号；多账号需独立实例。
- 默认不设置开机自启。
- 不包含大肥鱼插件源码及表情图库。

---

## 7. 文档

| 文档 | 内容 |
|---|---|
| [使用说明-详细.md](docs/使用说明-详细.md) | 安装、配置、插件、数据、升级、卸载 |
| [常见问题与解决方法.md](docs/常见问题与解决方法.md) | 故障现象、原因与处理 |
| [模型配置指南.md](docs/模型配置指南.md) | 云端模型、本地 Ollama、识图配置 |
| [one-click.md](docs/one-click.md) | 启动、停止与快捷方式 |
| [plugin-packages.md](docs/plugin-packages.md) | 三档插件包说明 |
| [build.md](docs/build.md) | 源码构建 |
| [release.md](docs/release.md) | 发布流程 |
| [architecture.md](docs/architecture.md) | 模块与数据流 |

---

## 8. 构建与测试

```powershell
npm test
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

构建产物输出至 `dist/`，包含安装包、便携包与 SHA256 校验文件。

---

## 9. 开源与合规

- 本仓库代码：MIT，见 `LICENSE`。
- AstrBot：AGPL-3.0；相关改动位于 `patches/`，分发时保留公开仓库地址。
- NapCat：遵循其自身许可；本仓库不分发 NapCat 离线包。
- 第三方组件清单：`LICENSE_NOTICE.md`、`OPEN_SOURCE_NOTICE.md`。

---

## 10. 贡献与安全

贡献说明见 `CONTRIBUTING.md`。安全漏洞请按 `SECURITY.md` 中的渠道报告，不得在公开 Issue 中披露敏感信息。
