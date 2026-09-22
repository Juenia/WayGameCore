'use strict';
/**
 * 世界种子加载器（2026-09-19 内容源合并）
 * =====================================================================
 * modules/world/*.json 是 tools/gen-world-defaults.js 从【当前正式世界】
 * （data/game.db）导出的内容种子，是内容种子的唯一真源。
 *
 * 用法：worldSeed('<表名>', 内置兜底数组)
 *   - 种子文件存在且非空 → 返回种子行（空库新装 = 主人现在的世界）
 *   - 种子文件缺失/为空   → 返回内置兜底（框架仍可独立跑起来）
 *
 * 为什么这样合并而不是「互相覆盖」：
 *   各模块写入默认数据的老规矩是「表为空才写」。把种子放在这个位置，
 *   空库新装种的是世界种子（世界说了算），已有库则一条都不会动 ——
 *   主人后来在编辑器里改过的内容永远不会被启动流程覆盖回去。
 */
function worldSeed(table, fallback) {
  const fb = Array.isArray(fallback) ? fallback : [];
  try {
    const rows = require('./' + table + '.json');
    if (Array.isArray(rows) && rows.length > 0) return rows;
    return fb;
  } catch (e) {
    return fb;
  }
}

module.exports = { worldSeed };
