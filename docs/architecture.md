# 架构

## 进程与职责

```text
launcher/start-hidden.vbs
        │  (hidden, no console)
        ▼
node backend/server.js  ── HTTP 127.0.0.1:18765 ──▶ wizard/ (HTML/JS/CSS)
        │
        ├─ backend/deploy.js      安装 / 配置 / 启动 / 自愈
        ├─ backend/preflight.js   17 项环境体检
        ├─ backend/doctor.js      诊断包（打码）
        ├─ backend/napcat-retry.js NapCat 掉线守护
        └─ scripts/boot.js        一键启动 + 常驻守护

AstrBot  ── dashboard 16885 / reverse WS 16199
NapCat   ── webui 6099 / OneBot WS
```

## 启动与安全

- `launcher/start-hidden.vbs` 先读 `wizard.port` 并 ping `/api/ping`；已运行就只开页面，不启动第二个进程。
- `server.js` 只监听 `127.0.0.1`；`wizard.port` 记录实际端口（18765–18775）。
- 每次进程启动生成 `WIZARD_TOKEN`；`index.html` 由后端注入 `window.__DFY_TOKEN__`，`app.js` 把它放进 `X-DaFeiYu-Wizard`。
- `csrfOk` 只放行 `GET /api/ping` 与 `GET /api/events`（SSE 不能带自定义头）；其余 `/api/*` 必须带 token。
- `localHostOk` 校验 Host 为 `127.0.0.1` / `localhost`，挡 DNS rebinding。
- 面板密码首次安装随机生成，写入 `%LOCALAPPDATA%\DaFeiYuQQ\dashboard_credentials.json`；老安装继续用已有密码。
- 所有本地服务（向导、面板代理）都绑回环，不触发 Windows 防火墙弹窗。

## 数据目录

| 路径 | 内容 |
|---|---|
| `%LOCALAPPDATA%\Programs\DaFeiYuQQ` | 程序本体（安装器） |
| `%LOCALAPPDATA%\DaFeiYuQQ` | 运行数据：`data/`、`dashboard_credentials.json`、日志、`bin/` |
| `%LOCALAPPDATA%\DaFeiYuQQ\data\plugins` | AstrBot 插件 |
| `%LOCALAPPDATA%\DaFeiYuQQ\plugin_backups` | 插件备份（注入前） |

安装器与数据目录分开，卸载默认不删数据。

## 已知结构债（3.0.0 处理）

- `backend/deploy.js` 约 3000 行 / 140+ 函数，安装步骤与业务混在一起。
- `backend/server.js` 约 1000 行，路由、代理、SSE、鉴权同文件。
- `wizard/app.js` 约 1700 行，单文件状态与 DOM 操作。
- 没有安装状态机；中断后只能重跑。
- 没有单元测试；目前靠 `verify.ps1` 的静态检查 + 冒烟。

3.0.0 目标：

```text
backend/steps/{preflight,runtime,astrbot,napcat,model,persona,start}.js
backend/state/install-state.js
backend/http/{server,routes,sse,security}.js
backend/diagnostics/{doctor,redact}.js
backend/plugins/{install,manifest,rollback}.js
```

每个 step 实现 `{ id, title, run, verify, rollback, timeoutMs }`，安装状态写入 `state.json`，支持恢复/取消/回滚。

## 3.0 基础模块（部分接线）

| 文件 | 作用 |
|---|---|
| `backend/core/errors.js` | 统一错误码 / 用户话术 / remediation / retryable |
| `backend/core/state.js` | 安装状态持久化、原子写、损坏备份、步骤状态/恢复 |
| `backend/core/steps.js` | 步骤契约、顺序执行、超时、取消、失败回滚 |
| `backend/core/manifest.js` | 插件包 manifest 校验：semver、路径穿越、SHA256 |
| `backend/steps/install-plan.js` | 唯一安装计划：preflight → uv → AstrBot → init → NapCat（插件不内置，独立包手动安装） |

已接线：

- `deploy.runStep(name, fn, id)` 现在会写 `%LOCALAPPDATA%\DaFeiYuQQ\install-state.json`；
- `GET /api/install-state` 返回步骤、时间、错误；
- `GET /api/install-plan` 返回计划元数据；
- `POST /api/install-all` 执行完整计划，`planBusy` 与单步 `runStep` 互斥；
- 前端“一键安装全部”按钮已改为调用 `/api/install-all`；单步按钮保留给高级用户。

## 升级清理（2.2.1）

安装器 `PrepareToInstall` 会先提取并执行 `tools/stop-all-wizards.ps1`：

- 找 `node.exe` 且命令行含 `backend\server.js` 的进程；
- 失败时回退到 18765–18775 端口上的 `node.exe`；
- 只停向导，不动 AstrBot / NapCat，避免旧 2.1.x 占端口、两个向导抢服务。

## 插件管理器（2.3.0 起；2.4.0 起工具不内置插件）

```text
GET  /api/plugins                 列表 + 备份
POST /api/plugins/install         { filename, zipBase64 }  // 包内必须有 manifest.json
POST /api/plugins/rollback        { backupId }
POST /api/plugins/remove          { name }
```

- `backend/plugins/zip.js`：零依赖解析 ZIP（store/deflate），拒绝 `..`、绝对路径、加密、ZIP64；解压大小/条目数上限。
- `backend/plugins/manager.js`：manifest 校验 → 文件 SHA256 校验 → 备份现有版本到 `data/plugin_backups` → 替换代码 → 从备份回填 `data/`/`meme_packs`/`voice`/`tmp`。
- 回滚：先把当前版本备份为 `*-pre-rollback-*`，再把选定备份复制回去。
- 完成后提示重启 AstrBot；不主动停服务，避免装插件时把机器人搞下线。

## Doctor（2.3.0）

`GET /api/doctor/status` 汇总：

- 工具版本 / Node / 数据目录
- `install-state.json` 状态
- 向导 / AstrBot / NapCat / OneBot 端口是否空闲
- 插件与备份数量
- `wizard.log` / `astrbot.log` / `napcat.log` 大小

前端完成页有 Doctor 卡片；“生成诊断报告”仍走 `/api/diag`（自动打码）。


