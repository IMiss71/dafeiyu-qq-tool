# 发布流程

目标：每次发布都能从干净 checkout 复现，用户能验证，出问题能回滚。

## 1. 版本

- `package.json` 的 `version` 是唯一版本源；构建时写进 `manifest.json` 与安装包文件名。
- 插件包版本独立，不和本仓库版本绑定。
- 建议语义化：`2.3.0` 插件管理/Doctor 版，`3.0.0` 重构版；修复发 `2.3.x`。

## 2. 发布前

```powershell
git status --short          # 必须干净
npm test
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

`build.ps1` 会：

1. 从源码重建 `build\stage`
2. 写 `manifest.json`（版本、commit、文件数、SHA256）
3. 跑 `verify.ps1`（BOM/密钥/禁止文件/语法/manifest/冒烟）
4. 有 `iscc.exe` 出 `Setup.exe`，否则出 `Portable.zip`
5. 写 `dist\SHA256SUMS.txt`

任何一步失败都不发布。

## 3. 产物

```text
DaFeiYu-Setup-<version>.exe        # 主产物（未签名）
DaFeiYu-Portable-<version>.zip     # 免安装
DaFeiYu-<version>.manifest.json
SHA256SUMS.txt
```

可选：

```text
DaFeiYu-Offline-<version>.zip      # 含 NapCat 离线包，单独发布并附许可证
```

> 默认不发布 Offline 包；如果发布，必须保留 `vendor/LICENSE-NAPCAT.txt`，并写清“仅个人非商用”。

## 4. GitHub Release

1. 打 tag：`v2.3.0`。
2. 上传 `dist\` 里的全部产物。
3. Release notes 至少写：
   - 变更（修了什么）
   - 已知问题（未签名 / 首装 SmartScreen）
   - 升级方式（覆盖安装，数据保留）
   - 校验方式（`SHA256SUMS.txt`）
4. 如果 `iscc.exe` 不在 CI 上，Release 由维护者本机构建并上传；CI 只跑 verify。

## 5. 零现金签名（可选）

不买证书也可以发。若要减少 SmartScreen：

- 申请免费 OSS 代码签名（SignPath / Certum OSS），批准后只签 `Setup.exe`。
- 不签也不影响功能；README 已写明首装 1 次提示。

## 6. 回滚

- 保留最近 2 个 Release 的安装包。
- 用户覆盖安装旧版即可回滚；数据目录不动。
- 插件回滚走插件管理器（3.0.0），保留 `data/`。

## 7. 发布检查单

```text
[ ] git 干净，tag 与 package.json 一致
[ ] npm test 通过
[ ] build.ps1 通过（verify 全绿）
[ ] 干净 Win11 安装一次：1 次 SmartScreen、0 UAC、0 控制台
[ ] 安装 / 升级 / 卸载 各一次
[ ] data 目录在卸载后保留
[ ] Release 含 manifest + SHA256SUMS
[ ] README / CHANGELOG 已更新
[ ] 没有把 data/cmd_config.json、日志、内部工单打进包
```
