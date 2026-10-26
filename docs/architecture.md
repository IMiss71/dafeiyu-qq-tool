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
