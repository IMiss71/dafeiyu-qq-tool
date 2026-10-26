# 构建与验收

## 依赖

| 工具 | 用途 | 是否必须 |
|---|---|---|
| Node.js 20+ | 运行时 / 语法检查 / 冒烟 | 必须 |
| Inno Setup 6 | 生成 `Setup.exe` | 可选；没有就出 portable zip |
| Python 3.10+ | 校验 `*.py` 语法 | 可选；没有会跳过 |
| Git | manifest 里记录 commit | 可选；没有写 `uncommitted` |

## 最短构建

```powershell
cd dafeiyu-deployer
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -SkipSmoke
```

产物：

```text
dist\DaFeiYu-Portable-2.2.0.zip        # 没有 iscc 时
dist\DaFeiYu-Setup-2.2.0.exe           # 有 iscc 时
dist\DaFeiYu-2.2.0.manifest.json
dist\SHA256SUMS.txt
```

## 带运行时构建（可离线安装）

`payload/` 不提交到 git，按下面放：

```text
payload\
  node.exe                 # 官方 Node 20/22 LTS x64
  python\                  # 可选：便携 Python（含 Lib/site-packages）
  NapCat.Shell.zip         # 可选：官方 NapCat release（附许可证）
```

然后：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -IncludePayload
```

没有 `payload\node.exe` 时，构建仍可通过，但目标机器必须自己装 Node。

## verify.ps1 做了什么

1. 必需文件、`package.json` 版本
2. 所有 JSON 不能带 UTF-8 BOM
3. 禁止文件：`data/cmd_config.json`、`__pycache__`、`.bak-*`、日志、内部工单
4. 固定密码 / 明显 API Key / 盘符绝对路径（`C:\...`）
5. `node --check` 所有 JS；有 Python 时编译所有 `.py`
6. `manifest.json` 的文件数与 SHA256 必须和实际一致
7. 冒烟：
   - 用随机端口起 `backend/server.js`
   - `/api/ping` 必须 200
   - `/` 必须包含 `window.__DFY_TOKEN__`
   - 不带 token 的 `/api/about` 必须 403
   - 带 token 的 `/api/about` 必须 200
   - 结束后清理 `wizard.port` / `wizard.lock`

单独跑：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -Stage build\stage
```

只验源码、不验 manifest / 不冒烟：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -Stage . -SkipManifest -SkipSmoke
```

## 常见构建问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `iscc.exe not found` | 没装 Inno Setup | 装 Inno Setup 6，或接受 portable zip |
| `manifest sha256 mismatch` | 构建后改了 stage 文件 | 重新跑 `build.ps1`，不要手改 stage |
| `smoke: /api/ping not ready` | 端口被占 / server 启动失败 | 看输出里的 stderr；换一次构建会自动换随机端口 |
| `UTF-8 BOM in JSON` | 某次保存带了 BOM | 用无 BOM UTF-8 重存；`verify` 会指到具体文件 |
| `fixed dashboard password` | 代码/文档里还有旧固定密码 | 改成随机密码逻辑，或删掉旧文案 |

## 发布前手动检查

- 干净 Win11 安装一次，确认只出现 1 次 SmartScreen、0 UAC、0 控制台。
- 安装/升级/卸载各一次。
- 断网跑一次，确认错误提示是人话。
- 把 `dist\` 里的 `SHA256SUMS.txt` 和 `manifest.json` 一起上传到 Release。
