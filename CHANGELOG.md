# Changelog

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
