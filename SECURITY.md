# 安全策略

## 支持版本

| 版本 | 支持 |
|---|---|
| 2.2.x | ✅ |
| < 2.2 | ❌ 建议升级 |

## 报告方式

请不要在公开 issue 里贴 QQ 号、API Key、面板密码或完整日志。

优先使用 GitHub 的 **Security → Report a vulnerability**（私密 advisory）。
如果仓库还没开 advisory，发邮件到维护者邮箱（在 GitHub 个人主页），标题写 `[SECURITY] dafeiyu-deployer`。

## 我们在意的问题

- 本地 API 绕过 token / Host 校验
- 路径穿越、zip slip、任意文件写
- 命令注入（PowerShell / cmd 参数拼接）
- 面板密码、API Key、QQ 号进入日志或诊断包
- 安装包内混入运行态配置、`.bak`、缓存
- 供应链：下载未校验哈希、远程脚本直接执行

## 不在范围

- NapCat / AstrBot 上游漏洞（请报给对应项目）
- QQ 封号、扫码失败、平台风控
- 用户自己改坏配置、装了冲突插件
- 未签名导致的首装 SmartScreen（已知限制，见 README）

## 响应

个人项目，尽力在 72 小时内确认，7 天内给修复或缓解方案。没有赏金计划。

## 加固建议

- 只从 Releases 下载，核对 `SHA256SUMS.txt`。
- 不要把 `%LOCALAPPDATA%\DaFeiYuQQ` 整个目录发给别人；用向导里的“生成诊断报告”（自动打码）。
- 不要把向导端口暴露到局域网；它只绑 `127.0.0.1`，如果发现不是，请按安全问题报告。
