# Changelog

## 2.3.0 - 2026-10-26

插件管理 + Doctor + 服务端一键安装计划。

### 安装流程

- `deploy.runStep(name, fn, id)` 写入 `install-state.json`；新增 `GET /api/install-state`。
- 新增 `backend/steps/install-plan.js`：唯一安装计划（preflight → uv → AstrBot → init → NapCat → plugin）。
- 新增 `GET /api/install-plan` 与 `POST /api/install-all`；前端“一键安装全部”改为走后端计划。
- `planBusy` 与单步 `runStep` 互斥；单步按钮保留。

### 插件管理器

- `backend/plugins/zip.js`：零依赖、路径安全的 zip 解压（拒绝 `..`、绝对路径、ZIP64/加密）。
- `backend/plugins/manager.js`：manifest 校验、SHA256 校验、备份到 `data/plugin_backups`、保留 `data/`/`meme_packs`、回滚、删除。
- API：`GET /api/plugins`、`POST /api/plugins/install|rollback|remove`。
- 前端完成页新增“插件管理”卡片：选 zip、安装/升级、备份列表、回滚。

### Doctor

- `GET /api/doctor/status`：版本、安装状态、端口、插件、日志大小、数据目录。
- 完成页新增 Doctor 卡片，可刷新查看。

### 其他

- 单测 21 项通过；`verify.ps1` 冒烟覆盖 install-state/install-plan/plugins/doctor。
- 版本 2.3.0。

## 2.2.1 - 2026-10-26

升级清理版：解决“新版本退到 18766、旧 2.1.x 还占 18765”的问题。

### 安装 / 升级

- 安装前自动停掉 18765–18775 上所有 DaFeiYu 向导（`node.exe backend\server.js`），不再只停 `{app}` 里的那个。
- 新增 `tools/stop-all-wizards.ps1`；Inno `PrepareToInstall` 先执行它，再停旧服务。
- 这样旧 2.1.x 不会继续占 18765，也不会和新 2.2.x 同时自愈同一套 AstrBot/NapCat。

### 3.0 基础模块（未接线，先带单测）

- `backend/core/errors.js`：统一 `AppError`（code / userMessage / detail / remediation / retryable）。
- `backend/core/state.js`：安装状态持久化、原子写、损坏备份、步骤状态/恢复。
- `backend/core/steps.js`：步骤定义、顺序执行、超时、取消、失败回滚。
- `backend/core/manifest.js`：插件包 manifest 校验（semver、路径穿越、SHA256）。
- `tests/core.test.js` + `tests/run.js`；`npm test` 改为单进程，避免受限环境 spawn 失败。

## 2.2.0 - 2026-10-26

止血版：先让包不可能被装错，再谈重构；现金成本 0。

### 安全

- 向导与面板代理全部只绑 `127.0.0.1`。
- 向导 API 改为每次进程启动随机 token，由后端注入页面；移除固定请求头值。
- 面板密码改为首次安装随机生成，写入 `dashboard_credentials.json`；移除固定密码。
- 启动日志不再打印面板密码明文。
- `fix-init.ps1` 不再写固定密码；优先沿用已有凭据文件。

### 交付 / 打包

- 新增 `scripts/build.ps1`：干净 stage → manifest → verify → 安装包/portable。
- 新增 `scripts/verify.ps1`：BOM、禁止文件、固定密码/密钥、语法、manifest、冒烟。
- 新增 `installer/dafeiyu.iss`：Inno Setup 6，按用户安装、无 UAC、单进度页、自带卸载。
- 新增 `launcher/start-hidden.vbs` / `stop-hidden.vbs` / `error.html`：无控制台、单实例、等就绪再开浏览器。
- 新增 `manifest.json` 规范与 `SHA256SUMS.txt` 生成。
- 新增 `.github/workflows/ci.yml`、issue 模板、`SECURITY.md`、`CONTRIBUTING.md`。
- 文档重组：README、build、architecture、release、payload。

### 清理

- 移除 `dist-readme.txt`、`①使用说明.txt` 等重复说明。
- 文档中移除固定面板密码。
- 构建时排除 `data/cmd_config.json`、`__pycache__`、`.bak-*`、日志、`nul`。
- 明确 NapCat 默认不随包分发；Offline 包需单独发布并附许可证。

## 2.1.1 - 2026-10-26

- 基线版本：修复 S1/S2/S4/S5/S6/S7/S10/S11、M17 等后端缺陷。
- 黑色窗口、WS 自愈、日志轮转、路径校验等修复。
- 已知限制：固定面板密码；插件包存在 BOM/备份目录/版本分叉问题（由 2.2.0 的插件包重打处理）。
