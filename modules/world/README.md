# modules/world —— 内容种子的唯一真源（2026-09-19 内容源合并）

## 这目录是干什么的

以前框架里有**两套内容源**：

| | 内容 | 用在哪 |
|---|---|---|
| A | `modules/*.js` 里写死的默认数据（3 只怪、2 张图、10 件装备、1 个职业…） | **空库新装**（各模块「表为空才写」的播种逻辑） |
| B | 当前正式世界（`data/game.db`：226 怪 / 120 图 / 323 装备 / 239 物品 / 126 任务…） | 主人实际在玩的世界 |

于是「新装出来的世界」和「主人现在的世界」不是一个世界 —— 半旧半新。

现在把 B 导出成这目录下的 JSON 种子，各模块/默认数据改成
**「世界种子优先、内置小世界兜底」**：种子在，新装种的就是主人现在的世界；
种子缺失或为空，才退回 `modules/*.js` 里的旧小世界（框架仍能独立跑起来）。

## 文件与形状

| 文件 | 表 | 行数 | 形状要点 |
|---|---|---|---|
| `items.json` | items | 239 | `effects/rewards/classChange/conditions` 是**已解析的对象**（走 `db.saveItem`） |
| `equipment.json` | equipment | 323 | `stats/unsealMaterials` 已解析（走 `db.saveEquipment`） |
| `equipment_sets.json` | equipment_sets | 12 | 已丢掉自增 `id`（带 id 会被当成「改」而不是「新增」） |
| `equipment_slots.json` | equipment_slots | 7 | 保留主键 `id`（'weapon'/'head'… 就是 `saveSlot` 的入参） |
| `maps.json` | maps | 120 | `monsters/npcs/items/connections` 已解析 |
| `monsters.json` | monsters | 226 | `stats/skills/drops/enrage/flee` 已解析，`kill_growth` 已改名为 **`killGrowth`**（core 读的是驼峰名） |
| `skills.json` | skills | 74 | `cost` 保持 JSON 字符串（core 的 skills.cost 就是存字符串） |
| `professions.json` | professions | 22 | 五个 JSON 列已解析（走 professionModule 的 INSERT） |
| `quests.json` | quests | 126 | 交由 defaultData → core 的 `saveQuest` 播种 |
| `shops.json` | shops | 30 | 已丢掉 `last_refresh_time/discount_start_time`（运行期状态，不该当初始值） |
| `npcs.json` | npcs | 70 | `functions/quests/exchange_settings` 已解析 |
| `_manifest.json` | — | — | 导出来源与每表行数（不是为了给代码读，是给人查） |

一律不导出的列：`rowid` / `created_at` / `updated_at` / 商店的两个时间字段。

## 怎么重新生成

```bash
node tools/gen-world-defaults.js          # 从 data/game.db 重新导出（覆盖这目录）
node tools/gen-world-defaults.js --check  # 只比对，不写文件；有差异退出码 1
```

**改了正式库的内容之后要重跑一次**，否则新装的世界会落后于现库。
`tools/audit-core-coverage.js` 的 S8 会盯着这件事（种子与现库名字对不上就报真问题）。

## 怎么验证合并真的成立

```bash
node tools/verify-world-merge.js
```

三段：
- **A 段**：这些种子文件 与 当前正式库 逐表逐列比 → 真差异必须 0
- **B 段**：在 `.sandbox` 里复制 core/ modules/ config.xml（**不给任何 data/*.db**），真启动一次核心，
  把种出来的库与现库逐表逐列比 → 真差异必须 0
- **C 段**：在新装出来的世界里真跑几条指令（注册 / 背包 / 地图 / 打坐 / 问候 / 看血 + 别名 hp/meditate/hello）

判定口径（`tools/world-merge-compare.js`）：
- 两边都有的字段值不同 / 现库有而对面没有 → **真差异**（必须 0）
- 现库没有而对面多出来的字段 → 写入路径补的默认键（如 `saveMonster` 会补 `enrage/flee/killGrowth` 的默认值），语义等价，单独记
- `monsters.aggressive` 按 core 的 `toBool` 读到的值比（core 只认 `true/'true'/1/'1'`）
- `shops.discount_value` 按「core 的 `saveShop` 会归一化」记备注（`data.discount_value || 100`）

## 为什么这样合并不会动到主人的数据

各模块写入默认数据的老规矩是「**表为空才写**」，种子只是换了这个位置的内容源：
- 已有库：所有表都非空 → 播种逻辑整段跳过，一条都不会被改
- 空库新装：种的就是世界种子

唯一的例外是 `quests.category / objectives`：core 的 `db.saveQuest` 不写这两列，
所以 `modules/questModule.js` 在启动时按种子补 —— 判定依据是 `updated_at`
（**只有本次启动这几秒内刚自动种下的行**才补），主人自己改过的老行一律不碰。

## 没有动核心

`core/GameSystem.js`、`core/databaseModule.js`、`regression_all.js` 一行未改。
合并全部落在 `modules/`（7 个模块 + `defaultData.js` + 这目录）与 `tools/`。
