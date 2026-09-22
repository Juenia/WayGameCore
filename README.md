# WayGameCore · WayGame 核心热更新仓库

本仓库是 **WayGame 核心的热更新产地**：编辑器里的「⬆ 更新核心」和独立的 `update.exe`
都从这里拉文件。它跟 Koishi 插件仓库（`Juenia/KoishiPlugin-WayGame`）不是一回事：
插件仓库放插件本体和整包下载，这里放核心文件本身。

## 目录

| 目录 | 内容 | 会被装到用户的哪里 |
|---|---|---|
| `core/` `modules/` `server.js` `package*.json` | 核心代码 | 核心根目录 |
| `editor-dist/` | 编好的编辑器 | `编辑器/` |
| `update-dist/` | 独立的更新程序 | 核心根目录（`update.exe`） |
| `hotfix/manifest.json` | 热更清单（每个文件的 sha256） | 不落地，客户端只读 |

## 热更清单地址

    https://raw.githubusercontent.com/Juenia/WayGameCore/main/hotfix/manifest.json

## 边界

- 本仓库**不含**任何用户数据：`data/`、`game.db`、`players.db` 一律不在。热更新有硬红线，永远不碰这些。
- 本仓库**不含**开发脚本与内部文档（`tools/` `docs/` `editor-wpf/` 等）。
- 使用者：把核心包解压后，双击 `update.exe` 即可自动同步到最新。

