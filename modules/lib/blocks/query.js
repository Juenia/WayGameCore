/**
 * 块定义 · 数据查询（只读白名单）（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    query_get: {
      cat: '查询', name: '查数据', color: '#3DC5C5', desc: '只读查询内容表（白名单）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'table', label: '表', type: 'select', def: 'items', options: 'queryTables', required: true },
        { k: 'by', label: '按字段', type: 'select', def: 'name', options: 'queryFields', required: true },
        { k: 'value', label: '等于值', type: 'expr', def: '', required: true, help: '要匹配的值（表达式）' },
        { k: 'field', label: '取出字段(留空=整行)', type: 'select', def: '', options: 'queryFields', required: false },
      ],
      // 2026-09-19 S3+ 第四批：动作体收敛到 lib/superOps.js 的 query_get（代码模式共用同一份）
      run: async (n, ctx, E) => {
        const r = await Ctx.ops.query_get({
          table: Ctx.lit(n, 'table', 'items'),
          by: Ctx.lit(n, 'by', 'name'),
          value: await Ctx.exprText(n, 'value', '', E, ctx),
          field: Ctx.lit(n, 'field', ''),
        });
        return { nextPort: 'next', output: r.output };
      },
    },
    player_query: {
      cat: '查询', name: '查玩家子表', color: '#3DC5C5', desc: '只读查询玩家子表',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'table', label: '子表', type: 'select', def: 'player_backpack', options: 'playerTables', required: true },
        { k: 'playerId', label: '玩家ID(空=自己)', type: 'player', def: '' },
      ],
      run: async (n, ctx) => {   // S3+ 第四批：动作在 superOps.player_query
        const r = await Ctx.ops.player_query({ table: Ctx.lit(n, 'table', 'player_backpack'), playerId: Ctx.lit(n, 'playerId', '') }, ctx);
        return { nextPort: 'next', output: r.output };
      },
    },

  };
};
