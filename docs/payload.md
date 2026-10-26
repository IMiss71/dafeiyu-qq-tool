# 运行时 payload（可选）

本仓库**不提交** `node.exe`、便携 Python、NapCat 离线包。原因：

- 体积：node.exe 约 83MB，Python 约 31MB，NapCat 约 34MB。
- 合规：NapCat 是 Limited Redistribution License；默认让安装器从官方下载并校验 SHA256。
- 可复现：运行时版本由构建者显式选择，不跟源码混在一起。

## 目录

```text
payload\
  node.exe                  # 官方 Node 20/22 LTS x64
  python\                   # 可选：便携 Python（含 Lib/site-packages）
  NapCat.Shell.zip          # 可选：官方 NapCat release
```

`payload/` 已加入 `.gitignore`。

## 构建行为

| payload 内容 | 结果 |
|---|---|
| 只有 `node.exe` | 包内自带 Node；Python/NapCat 由安装流程联网获取 |
| `node.exe` + `python` | 可离线装 AstrBot（仍需模型网络） |
| 再加 `NapCat.Shell.zip` | 可离线装 NapCat；发布时附 `vendor/LICENSE-NAPCAT.txt` |
| 都没有 | 构建仍通过，但目标机器必须自己装 Node；只适合开发/CI |

## 获取方式

- Node：<https://nodejs.org/en/download> 选 Windows x64 zip，取其中的 `node.exe`。
- Python：可用 python.org 的 embeddable package，或从一台已装好的机器复制 `tools\python`。
- NapCat：从官方 release 下载 `NapCat.Shell.zip`，核对 SHA256 后放入 `payload\`。

## 校验

构建时 `verify.ps1` 会检查包内没有 BOM、没有运行态配置、没有固定密码；但**不会**替你校验 node.exe / NapCat 的来源。
发布前自己核对一次 SHA256，并写进 Release notes。

## 合规提醒

- 不要把 NapCat 放进公开仓库。
- 如果发布 Offline 包，必须附 `vendor/LICENSE-NAPCAT.txt`，并写明“仅个人非商用”。
- 收费代部署前，先确认 NapCat 的商用/再分发边界。
