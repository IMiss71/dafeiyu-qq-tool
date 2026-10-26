# 贡献指南

## 开发环境

- Windows 10 22H2+ / 11 x64
- Node.js 20+
- 可选：Inno Setup 6（出安装包）、Python 3.10+（校验补丁脚本）

```powershell
git clone <repo>
cd dafeiyu-deployer
npm test
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -Stage . -SkipManifest -SkipSmoke
```

## 代码约定

- 后端保持**零运行时依赖**；不引入 npm 包，除非有充分理由并在 PR 里说明。
- 脚本（`.ps1` / `.vbs` / `.bat`）尽量 ASCII-only；中文放网页/文档。
- JSON 必须 UTF-8 **无 BOM**；`verify.ps1` 会拦。
- 所有本地 HTTP 服务只绑 `127.0.0.1`。
- 所有 `/api/*` 必须经过 token + Host 校验；不要新增绕过分支。
- 不要提交 `data/`、日志、`node.exe`、Python、NapCat 离线包、客户 QQ/Key。
- 不要引入付费服务、遥测、云数据库。

## PR 检查单

```text
[ ] npm test 通过
[ ] verify.ps1 通过（至少 -SkipManifest -SkipSmoke）
[ ] 新增/修改的日志不含 Key、密码、QQ 号
[ ] 新增下载有 SHA256 校验和超时
[ ] 改了安装/启动路径的，写明手动验证步骤
[ ] 没有把内部工单、客户数据、绝对路径带进仓库
```

## 提交信息

`type: summary`，例如：

```text
fix: bind wizard to loopback only
feat: inject per-process token into wizard page
docs: add zero-cost release checklist
```

## 不接受的改动

- 把插件源码（付费插件）放进本仓库。
- 用 Electron / React / 数据库替换现有轻量栈。
- 为了“看起来高级”引入新的运行时或付费依赖。
- 关闭 token/Host 校验来“兼容”某个客户端。
