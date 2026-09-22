/**
 * 内容表 / 玩家子表 · 白名单唯一来源（2026-09-18 结构治理）
 * ------------------------------------------------------------------
 * 背景：同一份表名以前散在 5~7 处 ——
 *   superModule（查询函数）、superBlocks（写校验 / 查数据 / 查玩家子表）、
 *   superCode（代码模式的查询）、编辑器下拉兜底、原型页、core/GameSystem.js。
 * 后果是「改一处忘一处」：新加的表在一边查得到、另一边写不了，或者编辑器下拉里根本没有。
 * 这里收成唯一一份，super 侧全部引用它。
 * 注意：core/GameSystem.js 自己那份【不在本次范围】—— 项目守则禁止改核心，
 *       两边的一致性由 test_gap_contract 的契约测试盯着。
 */
'use strict';

/** 可查询 / 可写的内容表（与只读「查数据」同一份口径） */
const QUERY_TABLES = ['items', 'monsters', 'equipment', 'equipment_sets', 'maps', 'npcs', 'quests', 'shops', 'skills', 'professions'];
/** 玩家子表（一切玩家数据都必须走 db.playerDb） */
const PLAYER_TABLES = ['player_attributes', 'player_currency', 'player_backpack', 'player_equipment', 'player_skills', 'player_quests', 'player_buffs', 'sign_in_records'];
/** 可写 = 可查：写操作与只读查询用同一张表清单，避免「查得到、写不了」 */
const WRITE_TABLES = QUERY_TABLES.slice();

function isQueryTable(t) { return QUERY_TABLES.indexOf(String(t)) >= 0; }
function isPlayerTable(t) { return PLAYER_TABLES.indexOf(String(t)) >= 0; }
function isWriteTable(t) { return WRITE_TABLES.indexOf(String(t)) >= 0; }

module.exports = { QUERY_TABLES, PLAYER_TABLES, WRITE_TABLES, isQueryTable, isPlayerTable, isWriteTable };
