/**
 * 内核内置事件名清单（2026-09-18 结构治理：从 superModule.js 抽出）
 * ------------------------------------------------------------------
 * 事件触发的一条逻辑如果写的是「名字带 *」，就是在这份清单里展开做通配匹配。
 * 注意：这是【静态清单】—— 将来有模块新增事件名，要顺手补进来，
 *       否则「XX*」这种通配写法匹配不到它（自定义事件必须写全名才能订阅）。
 */
'use strict';

const BUILTIN_EVENTS = [
  'player:created', 'player:died', 'player:level_up', 'player:moved',
  'player:attribute_changed', 'player:currency_changed', 'player:special_currency_changed',
  'player:item_gained', 'player:item_lost', 'player:currency_gained', 'player:currency_lost',
  'item:gift_opened', 'item:effect_applied', 'item:picked_up',
  'player:class_changed',   // 2026-09-18 补：itemModule.js 在发（职业变更道具），以前清单里没有 → player:* 通配漏它
  'equipment:equipped', 'equipment:unequipped', 'equipment:unsealed',
  'enemy:killed',
  'monster:enraged', 'monster:fled', 'monster:respawned', 'monster:grown',
  'combat:started', 'combat:round', 'combat:victory', 'combat:defeat', 'combat:item_used',
  'quest:completed',
  'backpack:item_submitted', 'backpack:item_added', 'backpack:item_dropped',
  'profession:promoted', 'npc:moved',

];

module.exports = { BUILTIN_EVENTS };
