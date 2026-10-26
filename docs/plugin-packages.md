# 三档插件包（独立交付，不进部署工具）

部署工具只安装 AstrBot + NapCat，不内置插件。三档插件包是独立 zip，在向导完成页「插件管理」里选择安装。

## 功能矩阵

| 能力 | 基础版 | 进阶版 | 全能版 |
|---|---:|---:|---:|
| 随机延迟回复 | ✓ | ✓ | ✓ |
| 表情包 | ✓ | ✓ | ✓ |
| 主动私聊 | - | ✓ | ✓ |
| QQ 空间说说 | - | ✓ | ✓ |
| 语音回复 / 识图 / 记忆 / 压缩 / 唱歌 / 梗图 / 补发 / ASR | - | - | ✓ |
| 群聊接话 + 多人上下文 + 冷场主动起话题 | - | - | ✓ |
| 工具（天气 / 搜索 / 计算 / 提醒） | - | - | ✓ |
| 可视化面板 | ✓ | ✓ | ✓ |

数量：

- 基础版 **2 项**
- 进阶版 **4 项**
- 全能版 **11 项可开关**（群聊/工具为全能版附加能力，不额外计数）

## 包名

```text
astrbot_plugin_dafeiyu-base-v1.8.0.zip
astrbot_plugin_dafeiyu-advanced-v1.8.0.zip
astrbot_plugin_dafeiyu-full-v1.8.0.zip
```

三档内部插件名都是 `astrbot_plugin_dafeiyu`，通过包内 `variant.json` 区分。  
因此升级/降级会复用同一个插件目录，`data/`、`memory.json`、`meme_packs/` 保留。

## 安装

1. 打开向导完成页 →「插件管理」
2. 点「选择插件包…」，选对应 zip
3. 点「安装 / 升级」
4. 重启 AstrBot（或按向导提示）

安装/升级会自动备份旧版本到 `data/plugin_backups`，可回滚。  
插件包是 code-only（约 155KB）；表情图片属于用户数据，不随包覆盖。

## 部署工具不带插件

发布包检查：

- 不出现 `vendor/plugin`
- 不出现 `astrbot_plugin_dafeiyu` 插件目录
- `verify.ps1` 会直接失败

部署工具与三个插件 zip 是 4 个独立交付物。
