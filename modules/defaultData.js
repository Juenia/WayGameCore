/**
 * 游戏初始默认数据定义
 */
// ── 世界种子合并（2026-09-19）────────────────────────────────────────────
// modules/world/*.json 是 tools/gen-world-defaults.js 从当前正式世界（data/game.db）
// 导出的内容种子，是内容种子的唯一真源。下面 quests/shops/npcs 三段包在 worldSeed(...)
// 里后：种子存在就用种子（空库新装 = 主人现在的世界），种子缺失/为空才用下面手写的
// 「新手村三件套」兜底。core 的 initDefaultData 本来就是「不存在才插入」，
// 所以已有库一条都不会被动到。
const { worldSeed } = require('./world/load.js');

module.exports = {
  // 1. 基础设置 (editor_settings)
  settings: [
    { key: 'game_name', value: 'WayGame 幻想世界' },
    { key: 'message_mode', value: '2' }, // 1: 纯文本, 2: MD, 3: 图片
    { key: 'nickname_min_length', value: '2' },
    { key: 'nickname_max_length', value: '12' },
    { key: 'initial_attributes', value: '{"生命":100,"魔法":50,"攻击":10,"防御":5,"暴击率":5,"暴击伤害":150,"闪避率":5}' },
    { key: 'initial_map', value: '新手村' },
    { key: 'initial_currency1', value: '100' },
    { key: 'initial_currency2', value: '0' },
    { key: 'initial_currency3', value: '0' },
    { key: 'initial_special_currency', value: '0' },
    { key: 'currency_1_name', value: '金币' },
    { key: 'currency_2_name', value: '银币' },
    { key: 'currency_3_name', value: '铜币' },
    { key: 'special_currency_name', value: '元宝' },

    { key: 'initial_items', value: '[]' },
    { key: 'sign_in_config', value: '{"baseRewards":[{"type":"currency","currencyType":1,"amount":100},{"type":"exp","amount":50}],"streakRewards":[{"days":7,"rewards":[{"type":"item","itemName":"初级药水","quantity":5}]},{"days":30,"rewards":[{"type":"currency","currencyType":1,"amount":1000}]}]}' },
    { key: 'server_port', value: '3210' },
    { key: 'main_city', value: '新手村' }
  ],

  // 2. 默认消息模板 (message_templates)
  templates: [
    // 自定义指令示例
    {
      key: 'customCommand.hello',
      template_text: '你好，{player.昵称}！这是一条自定义指令的示例回复。',
      template_markdown: '### 👋 你好，**{player.昵称}**！\n\n> 这是一条 **自定义指令** 的示例回复。\n\n你可以在【消息模板】里修改它。',
      description: '自定义指令示例回复'
    },
    // 帮助菜单（2026-09-22）：正文由 customCommandModule 现算，这里只管外壳。
    // 可用变量：{帮助标题} {指令帮助} {帮助提示} {指令总数} {分类数量}
    // 用 {xxx|raw} 才不会被 Markdown 转义。
    {
      key: 'customCommand.help',
      template_text: '{帮助标题|raw}\n\n{指令帮助|raw}\n\n💡 {帮助提示|raw}',
      template_markdown: '### {帮助标题|raw}\n\n{指令帮助|raw}\n\n> 💡 {帮助提示|raw}',
      description: '帮助菜单（指令分类总览）'
    },
    // UI 按钮模板（从 editor_settings 迁来，逻辑内嵌于消息模板）
    { key: 'ui.backpack.line.md',   template_text: '{name} x{count} {btn}', template_markdown: '{name} x{count} {btn}', description: '背包行-MD' },
    { key: 'ui.backpack.line.text', template_text: '{name} x{count} {btn}', template_markdown: '{name} x{count} {btn}', description: '背包行-纯文本' },
    { key: 'ui.btn.equip.md',   template_text: '[装备 {itemName}]', template_markdown: '<qqbot-cmd-input text="%E8%A3%85%E5%A4%87%20{itemNameEnc}" show="装备" reference="false" />', description: '装备按钮-MD' },
    { key: 'ui.btn.equip.text', template_text: '[装备 {itemName}]', template_markdown: '[装备 {itemName}]', description: '装备按钮-纯文本' },
    { key: 'ui.btn.use.md',   template_text: '[使用 {itemName}]', template_markdown: '<qqbot-cmd-input text="%E4%BD%BF%E7%94%A8%20{itemNameEnc}" show="使用" reference="false" />', description: '使用按钮-MD' },
    { key: 'ui.btn.use.text', template_text: '[使用 {itemName}]', template_markdown: '[使用 {itemName}]', description: '使用按钮-纯文本' },
    { key: 'ui.btn.unequip.md',   template_text: '[卸下 {itemName}]', template_markdown: '<qqbot-cmd-input text="%E5%8D%B8%E4%B8%8B%20{itemNameEnc}" show="卸下" reference="false" />', description: '卸下按钮-MD' },
    { key: 'ui.btn.unequip.text', template_text: '[卸下 {itemName}]', template_markdown: '[卸下 {itemName}]', description: '卸下按钮-纯文本' },
    { key: 'ui.btn.view.md',   template_text: '[查看物品 {itemName}]', template_markdown: '<qqbot-cmd-input text="%E6%9F%A5%E7%9C%8B%E7%89%A9%E5%93%81%20{itemNameEnc}" show="查看" reference="false" />', description: '查看按钮-MD' },
    { key: 'ui.btn.view.text', template_text: '[查看物品 {itemName}]', template_markdown: '[查看物品 {itemName}]', description: '查看按钮-纯文本' },
    // 翻页按钮（2026-09-17）：原来写死在 backpackModule / equipmentModule 里，
    // 图片通道直接把 <qqbot-cmd-input> 标签源码印到了卡片上。现在走模板，编辑器「消息模板」里可改。
    // 可用变量：{命令} 原始命令（如「背包 2」）、{cmdEnc} URL 编码后的命令、{页} 目标页码、{总页数}
    //
    // ⚠️ 文案必须用【全角】方括号：核心把半角 [xxx] 当变量占位符解析（/[\u4e00-\u9fa5\w]+/），
    //    写成 [下一页] 会被当成「名为 下一页 的变量」，查不到就替换成空 → 按钮直接消失。
    //    带空格的 [装备 {itemName}] 之所以能显示，只是因为正则不允许空格，纯属侥幸，别学。
    { key: 'ui.btn.prev.md',   template_text: '【上一页】', template_markdown: '<qqbot-cmd-input text="{cmdEnc}" show="上一页" reference="false" />', description: '上一页按钮-MD' },
    { key: 'ui.btn.prev.text', template_text: '【上一页】', template_markdown: '【上一页】', description: '上一页按钮-纯文本' },
    { key: 'ui.btn.next.md',   template_text: '【下一页】', template_markdown: '<qqbot-cmd-input text="{cmdEnc}" show="下一页" reference="false" />', description: '下一页按钮-MD' },
    { key: 'ui.btn.next.text', template_text: '【下一页】', template_markdown: '【下一页】', description: '下一页按钮-纯文本' },
    // 注册相关
    {
      key: 'player.register.success',
      template_text: '╔═══════════════════════════╗\n║ ✨ 注册成功！欢迎来到 {game_name}\n╠═══════════════════════════╣\n║ 👤 昵称：[玩家昵称]\n║ 🎭 职业：[玩家职业途径] ([玩家职业序列])\n║ ❤️ 生命：[玩家生命] / [玩家生命上限]\n║ 💧 魔法：[玩家魔法] / [玩家魔法上限]\n║ ⚔️ 攻击：[玩家攻击]  🛡️ 防御：[玩家防御]\n║ 📍 位置：[玩家位置]\n╚═══════════════════════════╝',
      template_markdown: '### ✨ 欢迎来到 **{game_name}**！\n\n> 🚀 **角色创建成功**\n\n- 👤 **昵称**：`[玩家昵称]`\n- 🎭 **职业**：`[玩家职业途径]` ([玩家职业序列])\n- 📍 **出生地**：**[玩家位置]**\n\n---\n**📊 初始状态**\n- ❤️ **生命**：`[玩家生命]/[玩家生命上限]`\n- 💧 **魔法**：`[玩家魔法]/[玩家魔法上限]`\n- ⚔️ **战斗力**：⚔️`[玩家攻击]` | 🛡️`[玩家防御]`\n\n*输入【地图】开始你的冒险吧！*',
      description: '注册成功返回消息'
    },
    {
      key: 'player.register.failed_nickname',
      template_text: '❌ 注册失败：昵称长度需在 {nickname_min_length}-{nickname_max_length} 之间。',
      template_markdown: '❌ **注册失败**\n> 昵称长度需在 `{nickname_min_length}`-`{nickname_max_length}` 之间。',
      description: '昵称长度错误'
    },
    {
      key: 'player.register.failed_exists',
      template_text: '❌ 你已经注册过了，无需重复注册。',
      template_markdown: '❌ **注册失败**\n> 你已经注册过了，无需重复注册。',
      description: '已注册提示'
    },
    {
      key: 'player.role.view',
      template_text: '╔════════ 👤 角色信息 ════════╗\n║ 昵称：[玩家昵称] ([玩家性别])\n║ 等级：Lv.[玩家等级] ([玩家经验] EXP)\n║ 职业：[玩家职业途径] ([玩家职业序列])\n╠════════ ⚔️ 战斗属性 ════════╣\n║ 生命：❤️ [玩家生命]/[玩家生命上限]\n║ 魔法：💧 [玩家魔法]/[玩家魔法上限]\n║ 攻击：⚔️ [玩家攻击]  防御：🛡️ [玩家防御]\n║ 暴击：💥 [玩家暴击率]%  闪避：💨 [玩家闪避率]%\n╠════════ 💰 资产统计 ════════╣\n[if:玩家金币]║ [玩家金币] 金 [玩家银币] 银 [玩家铜币] 铜\n[if:玩家特殊货币]║ 💎 [玩家特殊货币] 元宝\n╚═════════════════════════════╝',
      template_markdown: '### 👤 【[玩家昵称]】\n> [if:玩家性别][玩家性别] | Lv.[玩家等级] | [玩家职业途径] ([玩家职业序列])\n\n---\n#### 📊 核心属性\n- ❤️ **生命**：`[玩家生命]/[玩家生命上限]`\n- 💧 **魔法** : `[玩家魔法]/[玩家魔法上限]`\n- ⚔️ **攻击** : `[玩家攻击]`\n- 🛡️ **防御** : `[玩家防御]`\n- 💥 **暴击** : `[玩家暴击率]%`\n- 💨 **闪避** : `[玩家闪避率]%`\n\n#### 💰 财富统计\n[if:玩家金币]- 🟡 **金币** : `[玩家金币]`\n[if:玩家银币]- ⚪ **银币** : `[玩家银币]`\n[if:玩家铜币]- 🟤 **铜币** : `[玩家铜币]`\n[if:玩家特殊货币]- 💎 **元宝** : `[玩家特殊货币]`\n\n📍 当前位于：**[玩家位置]**',
      description: '角色信息查看'
    },
    
    // 地图相关
    {
      key: 'map.view',
      template_text: '╔════════ 📍 [地图名] ════════╗\n║ [地图简介]\n╠════════ 🔍 周边探索 ════════╣\n[if:地图怪物]║ 🐾 怪物：[地图怪物]\n[if:地图NPC]║ 👤 居民：[地图NPC]\n[if:地图物品]║ 🎁 物品：[地图物品]\n╠════════ 🚪 可往方向 ════════╣\n[地图连接方向数据]\n╚═════════════════════════════╝',
      template_markdown: '## 📍 【[地图名]】\n> [地图简介]\n\n---\n[if:地图怪物]#### 🐾 附近怪物\n[if:地图怪物][地图怪物]\n\n[if:地图NPC]#### 👤 驻留居民\n[if:地图NPC][地图NPC]\n\n[if:地图物品]#### 🎁 地面物品\n[if:地图物品][地图物品]\n\n---\n#### 🚪 可往方向\n[地图连接方向数据]',
      description: '地图查看模板'
    },
    {
      key: 'map.move.success',
      template_text: '🚶 你来到了 [地图名]。\n[地图简介]',
      template_markdown: '🚶 你来到了 **[地图名]**。\n> [地图简介]',
      description: '移动成功'
    },
    {
      key: 'map.pickup.success',
      template_text: '👌 拾取成功！你获得了 {itemName}。',
      template_markdown: '👌 **拾取成功**\n> 你从地面捡起了 `{itemName}`。',
      description: '拾取成功'
    },

    // 背包相关
    {
      key: 'backpack.view.success',
      template_text: `$货币名 = {系统.货币1名}

🎒 背包（第 {页码}/{总页数} 页）
[if:列表1]▫️ {列表1.名} ×{列表1.数量} {列表1.按钮}[/if]
[if:列表2]▫️ {列表2.名} ×{列表2.数量} {列表2.按钮}[/if]
[if:列表3]▫️ {列表3.名} ×{列表3.数量} {列表3.按钮}[/if]
[if:列表4]▫️ {列表4.名} ×{列表4.数量} {列表4.按钮}[/if]
[if:列表5]▫️ {列表5.名} ×{列表5.数量} {列表5.按钮}[/if]

💰 财富
🟡 $货币名：{玩家.金币|格式化}
⚪ 银币：{玩家.银币|格式化}
🟤 铜币：{玩家.铜币|格式化}

{上一页} {下一页}`,
      template_markdown: `$货币名 = {系统.货币1名}

🎒 背包（第 {页码}/{总页数} 页）
[if:列表1]▫️ {列表1.名} ×{列表1.数量} {列表1.按钮}[/if]
[if:列表2]▫️ {列表2.名} ×{列表2.数量} {列表2.按钮}[/if]
[if:列表3]▫️ {列表3.名} ×{列表3.数量} {列表3.按钮}[/if]
[if:列表4]▫️ {列表4.名} ×{列表4.数量} {列表4.按钮}[/if]
[if:列表5]▫️ {列表5.名} ×{列表5.数量} {列表5.按钮}[/if]

💰 财富
🟡 $货币名：{玩家.金币|格式化}
⚪ 银币：{玩家.银币|格式化}
🟤 铜币：{玩家.铜币|格式化}

{上一页} {下一页}`,
      description: '背包查看模板'
    },

    // 战斗相关
    {
      key: 'combat.attack.success',
      template_text: '⚔️ 你发起了攻击，对 [怪物名] 造成了 {伤害} 点伤害！',
      template_markdown: '⚔️ 你对 **[怪物名]** 发起凌厉一击！\n> 造成伤害：`{伤害}` 点',
      description: '攻击成功'
    },
    {
      key: 'combat.monster.dead',
      template_text: '💀 [怪物名] 被击败了！\n📈 获得经验：[怪物经验奖励]\n🎁 获得掉落：[怪物掉落物]',
      template_markdown: '### 💀 战斗胜利！\n**[怪物名]** 已被彻底击败。\n\n- 📈 **获得经验**：`+[怪物经验奖励]`\n- 🎁 **战利品**：\n[怪物掉落物]',
      description: '怪物死亡'
    },
    {
      key: 'combat.monster.enrage',
      template_text: '💢 警告：[怪物名] 进入了狂暴状态！攻击力倍增！',
      template_markdown: '💢 **[怪物名]** 进入了狂暴状态！\n> 属性大幅提升，小心它的反扑！',
      description: '怪物狂暴'
    },
    {
      key: 'combat.monster.flee',
      template_text: '💨 [怪物名] 见势不妙，逃向了 [目标地图]！',
      template_markdown: '💨 **[怪物名]** 见势不妙，逃向了 **[目标地图]** 方向！',
      description: '怪物逃跑'
    },
    {
      key: 'combat.status',
      template_text: '╔════════ ⚔️ 战斗回合 [当前回合] ════════╗\n║ 👾 [怪物名] (Lv.[怪物等级])\n║ 💔 怪物生命：[怪物生命] / [怪物生命上限]\n[if:怪物狂暴状态]║ 💢 状态：[怪物狂暴状态]\n╠══════════════════════════════╣\n║ 👤 [玩家昵称]\n║ ❤️ 玩家生命：[玩家生命] / [玩家生命上限]\n╚══════════════════════════════╝',
      template_markdown: '### ⚔️ 战斗进行中 (第 `[当前回合]` 回合)\n\n| 目标 | 生命值 | 状态 |\n| :--- | :--- | :--- |\n| 👾 **[怪物名]** | `[怪物生命]/[怪物生命上限]` | {if [怪物狂暴状态]}**[怪物狂暴状态]**{else}正常{/if} |\n| 👤 **你自己** | `[玩家生命]/[玩家生命上限]` | 战斗中 |\n\n*输入【技能】或【逃跑】*',
      description: '战斗详细状态'
    },
    {
      key: 'combat.failure',
      template_text: '💀 你被 [怪物名] 击败了...\n🥀 损失了 [损失经验] 经验，你在 [玩家位置] 重新苏醒。',
      template_markdown: '### 💀 胜败乃兵家常事\n你被 **[怪物名]** 击败了。\n\n- 🥀 **死亡惩罚**：损失了 `[损失经验]` 经验值。\n- 📍 **重生点**：**[玩家位置]**',
      description: '战斗失败回复'
    },

    // 物品与装备
    {
      key: 'item.use.success',
      template_text: '💊 你使用了 {物品名}。\n✨ 效果：{结果}',
      template_markdown: '### 💊 使用成功\n> 你使用了 **{物品名}**\n\n✨ **效果反馈**：\n{结果}',
      description: '物品使用成功'
    },
    {
      key: 'equipment.equip.success',
      template_text: '👕 装备成功：{装备名}\n部位：{slotName}\n\n[if:属性变化]✨ 属性变化：\n{属性变化}\n[/if]\n[if:套装信息]\n🌟 套装激活：\n{套装信息}\n[/if]',
      template_markdown: '👕 装备成功\n\n你穿上了 {装备名}\n\n部位：`{slotName}`\n\n[if:属性变化]✨ 属性变化\n{属性变化}\n[/if]\n[if:套装信息]🌟 套装激活\n{套装信息}\n[/if]',
      description: '装备成功'
    },
    {
      key: 'equipment.view.success',
      template_text: '╔════════ 🛡️ [装备名] ════════╗\n║ [装备介绍]\n╠════════ 📋 装备详情 ════════╣\n║ 部位：[装备所属部位]\n║ 限制：Lv.[装备等级限制] / [装备职业限制]\n║ 状态：[装备封印状态]\n╠════════ ✨ 附加属性 ════════╣\n[装备提供基础属性]\n╚═════════════════════════════╝',
      template_markdown: '### 🛡️ 【[装备名]】\n> [装备介绍]\n\n---\n**📋 装备信息**\n- 🧤 **部位**：`[装备所属部位]`\n- 📊 **要求**：Lv.`[装备等级限制]` / `[装备职业限制]`\n- 🔒 **状态**：`[装备封印状态]`\n\n**✨ 附加属性**\n[装备提供基础属性]\n\n[if:装备套装信息]**📦 套装信息**\n[if:装备套装信息][装备套装信息]',
      description: '查看装备详情'
    },
    {
      key: 'equipment.view.slots',
      template_text: '$货币名 = {系统.货币1名}\n\n👕 装备栏（第 {页码}/{总页数} 页）\n\n[if:列表1]▫️ {列表1.槽}：{列表1.名} {列表1.按钮}[/if]\n[if:列表2]▫️ {列表2.槽}：{列表2.名} {列表2.按钮}[/if]\n[if:列表3]▫️ {列表3.槽}：{列表3.名} {列表3.按钮}[/if]\n[if:列表4]▫️ {列表4.槽}：{列表4.名} {列表4.按钮}[/if]\n[if:列表5]▫️ {列表5.槽}：{列表5.名} {列表5.按钮}[/if]\n\n💪 战力统计\n⚔️ 攻击：{玩家.攻击}\n🛡️ 防御：{玩家.防御}\n[if:套装信息]\n\n🌟 已激活套装：\n{套装信息}\n[/if]\n\n{上一页} {下一页}',
      template_markdown: '$货币名 = {系统.货币1名}\n\n👕 装备栏（第 {页码}/{总页数} 页）\n\n[if:列表1]▫️ {列表1.槽}：{列表1.名} {列表1.按钮}[/if]\n[if:列表2]▫️ {列表2.槽}：{列表2.名} {列表2.按钮}[/if]\n[if:列表3]▫️ {列表3.槽}：{列表3.名} {列表3.按钮}[/if]\n[if:列表4]▫️ {列表4.槽}：{列表4.名} {列表4.按钮}[/if]\n[if:列表5]▫️ {列表5.槽}：{列表5.名} {列表5.按钮}[/if]\n\n💪 战力统计\n\n⚔️ 攻击：{玩家.攻击}\n\n🛡️ 防御：{玩家.防御}\n[if:套装信息]\n\n🌟 已激活套装\n{套装信息}\n[/if]\n\n{上一页} {下一页}',
      description: '装备栏列表（分页）'
    },
    {
      key: 'equipment.unequip.success',
      template_text: `👕 卸下成功：{装备名}

[if:属性变化]✨ 属性变化：
{属性变化}
[/if]
[if:套装信息]
🌟 套装状态：
{套装信息}
[/if]`,
      template_markdown: `👕 **卸下成功**
> 你卸下了 **{装备名}**

[if:属性变化]**✨ 属性变化**
{属性变化}
[/if]
[if:套装信息]**🌟 套装状态**
{套装信息}
[/if]`,
      description: '卸下装备成功'
    },
    {
      key: 'equipment.unseal.success',
      template_text: '🔓 解封成功！{装备名} 散发出耀眼的光芒。',
      template_markdown: '🔓 **解封成功**！\n> **{装备名}** 的真正力量已经觉醒！',
      description: '解封成功'
    },

    // 职业相关
    {
      key: 'profession.transfer.success',
      template_text: '✨ 恭喜！你已成功转职为 [职业途径]！\n🎭 当前序列：[职业序列]\n📈 获得技能：[职业序列技能]',
      template_markdown: '### ✨ 转职成功！\n> 你已成功踏上 **[职业途径]** 的修行之路。\n\n- 🎭 **当前序列**：`[职业序列]`\n- ⚔️ **新获技能**：[职业序列技能]\n\n*努力修行，追求更高的境界吧！*',
      description: '转职成功'
    },
    {
      key: 'profession.promote.success',
      template_text: '🎊 晋升成功！你的职业序列提升至：[职业序列]\n📈 属性获得大幅增长！',
      template_markdown: '### 🎊 晋升成功！\n> 你的力量突破了瓶颈，晋升为 **[职业序列]**！\n\n- 📈 **成长反馈**：全属性已按途径曲线大幅提升。\n- ⚔️ **觉醒技能**：[职业序列技能]',
      description: '晋升成功'
    },

    // 签到相关
    {
      key: 'signIn.success',
      template_text: '╔════════ ✅ 签到成功 ════════╗\n║ 🎁 获得奖励：[签到奖励]\n║ 🔥 连续签到：{streak} 天\n║ 📅 累计签到：[签到天数] 天\n╚═════════════════════════════╝',
      template_markdown: '### ✅ 签到成功！\n\n- 🎁 **今日奖励**：`[签到奖励]`\n- 🔥 **连续签到**：`{streak}` 天\n- 📅 **累计签到**：`[签到天数]` 天\n\n*明天的奖励会更好哦！*',
      description: '签到成功回复'
    },

    // 任务相关
    {
      key: 'quest.accept_success',
      template_text: '📜 你接受了新任务：[任务名]\n🎯 目标：[任务条件]',
      template_markdown: '### 📜 新任务接取\n> **[任务名]**\n\n- 🎯 **达成目标**：`[任务条件]`\n- 🎁 **任务奖励**：[任务奖励]',
      description: '接受任务成功'
    },
    {
      key: 'quest.complete_success',
      template_text: '🎉 恭喜！你完成了任务：[任务名]\n🎁 奖励已发放到背包。',
      template_markdown: '### 🎉 任务完成！\n> **[任务名]**\n\n- 🎁 **获得奖励**：\n[任务奖励]\n\n*快去寻找下一个挑战吧！*',
      description: '任务完成提示'
    },

    // 商店相关
    {
      key: 'shop.list',
      template_text: '╔════════ 🛒 [商店名] ════════╗\n║ [商店介绍]\n╠════════ 📦 商品列表 ════════╣\n[商品列表数据]\n╠════════ 📢 活动信息 ════════╣\n║ 🔥 当前折扣：[商店折扣] 折\n╚═════════════════════════════╝',
      template_markdown: '## 🛒 【[商店名]】\n> [商店介绍]\n\n---\n#### 📦 商品列表\n[商品列表数据]\n\n---\n#### 📢 限时活动\n- 🔥 **当前折扣**：`[商店折扣]` 折\n- ⏳ **剩余时间**：`[折扣持续时间]` 分钟',
      description: '商店列表模板'
    },
    {
      key: 'shop.buy_success',
      template_text: '💰 购买成功！你获得了 [商品名] * [购买数量]。',
      template_markdown: '💰 **购买成功**\n> 你花费了 `[商品价格]` [货币类型]\n> 购入了：**[商品名]** x`[购买数量]`',
      description: '购买成功'
    },

    // NPC 相关
    {
      key: 'npc.query_success',
      template_text: '╔════════ 👤 [NPC名] ════════╗\n║ [NPC介绍]\n╠════════ 🛠️ 可用功能 ════════╣\n[NPC功能列表]\n╚═════════════════════════════╝',
      template_markdown: '### 👤 【[NPC名]】\n> [NPC介绍]\n\n---\n#### 🛠️ 可用功能\n[NPC功能列表]',
      description: '查询 NPC 成功'
    },
    {
      key: 'system.player_not_found',
      template_text: '❌ 你还未注册，请先输入【注册】创建角色。',
      template_markdown: '### ❌ 未注册\n> 你还未注册，请先输入 **【注册】** 创建角色。',
      description: '玩家不存在'
    },
    {
      key: 'system.invalid_command_args',
      template_text: '❌ 参数错误，请检查命令格式。',
      template_markdown: '### ❌ 参数错误\n> 请检查命令格式后重试。',
      description: '参数错误'
    },
    {
      key: 'system.error',
      template_text: '❌ 系统开小差了，请稍后再试。',
      template_markdown: '### ❌ 系统错误\n> 系统开小差了，请稍后再试。若反复出现，请联系管理员。',
      description: '系统错误'
    },
    {
      key: 'system.module_not_found',
      template_text: '❌ 该功能暂未开放。',
      template_markdown: '### ❌ 功能未开放\n> 该功能暂未开放（模块未加载）。',
      description: '模块未加载'
    },
    {
      key: 'system.permission_denied',
      template_text: '❌ 你没有执行该操作的权限。',
      template_markdown: '### ❌ 权限不足\n> 你没有执行该操作的权限。',
      description: '权限不足'
    },
    {
      room: 'item',
      key: 'use.not_enough',
      template_text: '❌ 你没有足够的 {itemName}（需要 {quantity} 个）。',
      template_markdown: '### ❌ 物品不足\n> 你没有足够的 **{itemName}**（需要 `{quantity}` 个）。',
      description: '使用物品数量不足'
    },
    {
      room: 'backpack',
      key: 'drop.fail_not_enough',
      template_text: '❌ 你没有 {itemName}，无法丢弃。',
      template_markdown: '### ❌ 丢弃失败\n> 你没有 **{itemName}**，无法丢弃。',
      description: '丢弃物品不足'
    },
    {
      room: 'backpack',
      key: 'submit.fail_not_enough',
      template_text: '❌ 你没有 {itemName}，无法上交。',
      template_markdown: '### ❌ 上交失败\n> 你没有 **{itemName}**，无法上交。',
      description: '上交物品不足'
    },
    {
      room: 'system',
      key: 'info',
      template_text: '{message}',
      template_markdown: '{message}',
      description: '通用信息提示'
    },
    {
      room: 'system',
      key: 'invalid_command_usage',
      template_text: '❌ 命令格式不对，请检查后重试。',
      template_markdown: '### ❌ 命令格式错误\n> 请检查命令格式后重试。',
      description: '命令用法错误'
    }
  ],

  // 3. 默认指令配置 (custom_commands)
  commands: [
    { name: '打坐', logical_name: '', aliases: 'meditate,rest', module: 'customCommand', description: '示例：无逻辑，显示默认回复', template_key: '' },
    { name: '问候', logical_name: '', aliases: 'hello,hi', module: 'customCommand', description: '示例：绑定模板', template_key: 'customCommand.hello' },
    { name: '看血', logical_name: 'player:role', aliases: 'hp', module: 'customCommand', description: '示例：委托到已有逻辑', template_key: '' },
    // 帮助菜单（2026-09-22）：指令清单由 customCommandModule 现算，排版在消息模板 customCommand.help
    { name: '帮助', logical_name: '', aliases: '功能,help,菜单,指令', module: 'customCommand', description: '查看全部指令的帮助菜单', template_key: 'customCommand.help' },
    { name: '注册', logical_name: 'player:register', aliases: 'register,re', module: 'player', description: '创建角色', template_key: 'player.register.success' },
    { name: '角色', logical_name: 'player:role', aliases: 'me,status,c', module: 'player', description: '查看角色属性', template_key: 'player.role.view' },
    { name: '地图', logical_name: 'map:view', aliases: '位置,look', module: 'map', description: '查看当前位置信息', template_key: 'map.view' },
    { name: '移动', logical_name: 'map:move', aliases: 'move,go', module: 'map', description: '移动到指定方向', template_key: 'map.move.success' },
    { name: '拾取', logical_name: 'map:pickup', aliases: 'get,pick', module: 'map', description: '拾取地图物品', template_key: 'map.pickup.success' },
    { name: '背包', logical_name: 'backpack:view', aliases: 'b,pack', module: 'backpack', description: '查看背包物品', template_key: 'backpack.view' },
    { name: '筛选', logical_name: 'backpack:filter', aliases: 'filter', module: 'backpack', description: '按类型筛选物品', template_key: 'backpack.filter.view' },
    { name: '丢弃', logical_name: 'backpack:drop', aliases: 'drop', module: 'backpack', description: '丢弃物品', template_key: 'backpack.drop.success' },
    { name: '攻击', logical_name: 'combat:attack', aliases: 'atk,kill', module: 'combat', description: '攻击怪物', template_key: 'combat.attack.success' },
    { name: '逃跑', logical_name: 'combat:flee', aliases: 'flee,run', module: 'combat', description: '尝试从战斗中逃跑', template_key: 'combat.monster.flee' },
    { name: '战斗状态', logical_name: 'combat:status', aliases: 'st', module: 'combat', description: '查看当前战斗状态', template_key: 'combat.status' },
    { name: '使用技能', logical_name: 'skill:use', aliases: 'skill,cast', module: 'combat', description: '释放主动技能', template_key: 'combat.attack.success' },
    { name: '查询技能', logical_name: 'skill:query', aliases: 'skillinfo', module: 'skill', description: '查看技能详情' },
    { name: '技能列表', logical_name: 'skill:list', aliases: 'myskills', module: 'skill', description: '查看已学技能' },
    { name: '查看', logical_name: 'item:view', aliases: 'check,view', module: 'item', description: '查看物品/怪物/装备详情', template_key: 'item.view.success' },
    { name: '使用', logical_name: 'item:use', aliases: 'use', module: 'item', description: '使用物品', template_key: 'item.use.success' },
    { name: '装备', logical_name: 'equipment:equip', aliases: 'wear', module: 'equipment', description: '穿戴或查看装备', template_key: 'equipment.equip.success' },
    { name: '卸下', logical_name: 'equipment:unequip', aliases: 'takeoff', module: 'equipment', description: '卸下装备' },
    { name: '解封', logical_name: 'equipment:unseal', aliases: 'unseal', module: 'equipment', description: '解除装备封印' },
    { name: '套装信息', logical_name: 'equipmentSet:view', aliases: 'setinfo', module: 'equipmentSet', description: '查看套装详情' },
    { name: '签到', logical_name: 'signIn:sign', aliases: 'sign,checkin', module: 'signIn', description: '每日签到' },
    { name: '签到日历', logical_name: 'signIn:calendar', aliases: 'calendar,rl', module: 'signIn', description: '查看签到日历' },
    { name: '转职途径', logical_name: 'profession:transfer', aliases: 'transfer,zz', module: 'profession', description: '选择并转职到指定途径' },
    { name: '晋升', logical_name: 'profession:promote', aliases: 'promote,js', module: 'profession', description: '提升当前职业序列' },
    { name: '职业信息', logical_name: 'profession:info', aliases: 'prof,job', module: 'profession', description: '查看自己的职业状态' },
    { name: '职业列表', logical_name: 'profession:list', aliases: 'proflist', module: 'profession', description: '列出所有可用的职业途径' },
    { name: '查看职业', logical_name: 'profession:view', aliases: 'profview', module: 'profession', description: '查看指定职业途径的详细信息' },
    { name: '接受任务', logical_name: 'quest:accept', aliases: 'accept,jsrw', module: 'quest', description: '接受指定任务' },
    { name: '查看任务', logical_name: 'quest:view', aliases: 'quests,ckrw', module: 'quest', description: '查看进行中的任务' },
    { name: '放弃任务', logical_name: 'quest:abandon', aliases: 'abandon,fqrw', module: 'quest', description: '放弃进行中的任务' },
    { name: '购买', logical_name: 'shop:buy', aliases: 'buy,gm', module: 'shop', description: '购买商店商品' },
    { name: '出售', logical_name: 'shop:sell', aliases: 'sell,cs', module: 'shop', description: '出售背包物品给商店' },
    { name: '对话', logical_name: 'npc:dialogue', aliases: 'talk,dh', module: 'npc', description: '与 NPC 对话' },
    { name: '进入商店', logical_name: 'npc:enter_shop', aliases: 'shop,jr', module: 'npc', description: '进入 NPC 经营的商店' },
    { name: '查询NPC', logical_name: 'npc:query', aliases: 'npcinfo,cx', module: 'npc', description: '查询 NPC 详细信息' },
    { name: '兑换', logical_name: 'npc:exchange', aliases: 'exchange,dhb', module: 'npc', description: '在 NPC 处兑换货币' }
  ],

  // 4. 默认自定义变量 (variables)
  variables: [
    { name: '问候语', value: '你好，[玩家昵称]！欢迎回来。', description: '示例：纯值（可嵌套[变量]）' },
    { name: '战斗力', value: 'round([玩家攻击]*2 + [玩家防御]*1.5 + [玩家等级]*5)', description: '示例：数学公式（支持 round/floor/max 等）' },
    { name: '游戏时间', value: 'url:https://worldtimeapi.org/api/timezone/Asia/Shanghai', description: '示例：HTTP 变量（url: 前缀）' },
    { name: '总攻击', value: '[玩家攻击] + [玩家等级] * 2', description: '计算总攻击力' }
  ],

  // 5. 默认属性别名 (aliases)
  aliases: [
    { field: '生命', alias: '血量' },
    { field: '生命', alias: '体力' },
    { field: '生命上限', alias: '体力上限' },
    { field: '魔法', alias: '法力' },
    { field: '魔法', alias: '蓝量' },
    { field: '暴击伤害', alias: '爆伤' },
    { field: '货币1', alias: '金币' },
    { field: '货币2', alias: '银币' },
    { field: '货币3', alias: '铜币' },
    { field: '特殊货币', alias: '钻石' }
  ],

  // 6. 默认任务数据 (quests)
  quests: worldSeed('quests', [
    {
      name: '初出茅庐',
      description: '在新手村证明你的勇气，击败 3 只史莱姆。',
      type: 'kill',
      type_value: '史莱姆:3',
      rewards: JSON.stringify([
        { type: 'exp', value: 100 },
        { type: 'currency', value: 1, amount: 50 }
      ]),
      conditions: JSON.stringify([
        { type: 'level', value: 1 }
      ]),
      enabled: 1
    },
    {
      name: '收集草药',
      description: '村长的腰不太好，帮他收集 5 个初级药水。',
      type: 'submit_item',
      type_value: '初级药水:5',
      rewards: JSON.stringify([
        { type: 'exp', value: 200 },
        { type: 'item', value: '新手长剑', amount: 1 }
      ]),
      conditions: JSON.stringify([
        { type: 'quest_completed', value: '初出茅庐' }
      ]),
      enabled: 1
    }
  ]),

  // 7. 默认商店数据
  shops: worldSeed('shops', [
    {
      name: '新手补给店',
      description: '专门为新人提供基础药水 and 装备。',
      items: [
        { item_name: '初级药水', price: 10, currency_type: '货币1', stock: -1, base_stock: -1 },
        { item_name: '新手长剑', price: 100, currency_type: '货币1', stock: 10, base_stock: 10 }
      ],
      acquisition_ratio: 0.5,
      refresh_interval: 0,
      discount_enabled: 0,
      npc_name: '村长'
    }
  ]),

  // 8. 默认 NPC 数据
  npcs: worldSeed('npcs', [
    {
      name: '村长',
      description: '新手村的管理者，慈祥的老人。',
      functions: ['dialogue', 'task', 'shop', 'exchange'],
      move_probability: 0,
      quests: ['初出茅庐', '收集草药'],
      shop_name: '新手补给店',
      exchange_settings: {
        currency2_rate: 100,
        currency2_fee: 0.01,
        currency3_rate: 1000,
        currency3_fee: 0.02
      },
      map_name: '新手村'
    }
  ])
};