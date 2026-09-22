/**
 * 块定义 · 玩家数据（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    player_get: {
      cat: '玩家', name: '读玩家字段', color: '#5B8FE8', desc: '读取当前玩家的一个字段',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'field', label: '玩家字段', type: 'select', def: '昵称', options: 'playerFields', required: true, help: '如 昵称/等级/货币1/当前地图' }],
      run: async (n, ctx) => { const f = Ctx.lit(n, 'field', '昵称'); const p = ctx.player || {}; return { nextPort: 'next', output: p[f] }; },
    },
    player_set: {
      cat: '玩家', name: '改玩家字段', color: '#5B8FE8', desc: '修改玩家字段（走核心 services.player）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'field', label: '玩家字段', type: 'select', def: '等级', options: 'playerFields', required: true },
        { k: 'value', label: '新值', type: 'expr', def: '0', required: true },
      ],
      run: async (n, ctx, E) => {
        const f = Ctx.lit(n, 'field', '');
        const v = await Ctx.exprOf(n, 'value', '0', E, ctx);
        const res = await core.services.player.modify({ playerId: ctx.playerId, changes: { [f]: { set: v } }, source: 'super:' + ctx.key });
        if (!res.success) throw new Error(res.message || '改字段失败');
        ctx.playerDirty = true;
        return { nextPort: 'next' };
      },
    },
    currency_add: {
      cat: '玩家', name: '加货币', color: '#5B8FE8', desc: '给玩家加货币（带上限夹取）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'field', label: '货币字段', type: 'select', def: '货币1', options: 'currencyFields', required: true },
        { k: 'amount', label: '数量', type: 'number', def: '1' },
      ],
      // 2026-09-19 S3+：动作体搬到 lib/superOps.js（块与代码共用一份），这里只做取值与返回形状
      run: async (n, ctx, E) => {
        await Ctx.ops.currency_add({ field: Ctx.lit(n, 'field', '货币1'), amount: await Ctx.numOf(n, 'amount', 1, E, ctx) }, ctx);
        return { nextPort: 'next' };
      },
    },
    currency_sub: {
      cat: '玩家', name: '扣货币', color: '#5B8FE8', desc: '扣货币，不够会报错',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'field', label: '货币字段', type: 'select', def: '货币1', options: 'currencyFields', required: true },
        { k: 'amount', label: '数量', type: 'number', def: '1' },
      ],
      run: async (n, ctx, E) => {   // S3+：动作在 superOps
        await Ctx.ops.currency_sub({ field: Ctx.lit(n, 'field', '货币1'), amount: await Ctx.numOf(n, 'amount', 1, E, ctx) }, ctx);
        return { nextPort: 'next' };
      },
    },
    item_add: {
      cat: '玩家', name: '加物品', color: '#5B8FE8', desc: '发物品进背包',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'name', label: '物品', type: 'item', def: '', required: true, options: 'itemNames' },
        { k: 'count', label: '数量', type: 'number', def: '1' },
      ],
      run: async (n, ctx, E) => {   // S3+：动作在 superOps
        await Ctx.ops.item_add({ name: Ctx.lit(n, 'name', ''), count: await Ctx.numOf(n, 'count', 1, E, ctx) }, ctx);
        return { nextPort: 'next' };
      },
    },
    item_take: {
      cat: '玩家', name: '扣物品', color: '#5B8FE8', desc: '从背包扣物品',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'name', label: '物品', type: 'item', def: '', required: true, options: 'itemNames' },
        { k: 'count', label: '数量', type: 'number', def: '1' },
      ],
      run: async (n, ctx, E) => {   // S3+：动作在 superOps
        await Ctx.ops.item_take({ name: Ctx.lit(n, 'name', ''), count: await Ctx.numOf(n, 'count', 1, E, ctx) }, ctx);
        return { nextPort: 'next' };
      },
    },
    check_has_item: {
      cat: '玩家', name: '检查拥有物品', color: '#5B8FE8', desc: '背包里够不够（够走真，不够走假）',
      ports: { in: true, out: ['true', 'false'] },
      params: [
        { k: 'name', label: '物品', type: 'item', def: '', required: true, options: 'itemNames' },
        { k: 'count', label: '至少数量', type: 'number', def: '1' },
      ],
      run: async (n, ctx, E) => {   // S3+：动作在 superOps
        const r = await Ctx.ops.check_has_item({ name: Ctx.lit(n, 'name', ''), count: await Ctx.numOf(n, 'count', 1, E, ctx) }, ctx);
        return { nextPort: r.ok ? 'true' : 'false', output: r.ok };
      },
    },

  };
};
