/**
 * 块定义 · 流程扩展（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    elseif: {
      cat: '流程', name: '否则如果', color: '#9D7BE8', desc: '接在「如果」的假分支上继续判断',
      ports: { in: true, out: ['true', 'false'] },
      params: [{ k: 'expr', label: '条件', type: 'expr', def: '玩家.等级 >= 20', required: true, help: '同「如果」；接在假分支上就是多路判断' }],
      run: async (n, ctx, E) => { const v = await Ctx.exprOf(n, 'expr', '真', E, ctx); return { nextPort: v ? 'true' : 'false' }; },
    },
    join: {
      cat: '流程', name: '汇合', color: '#9D7BE8', desc: '等齐 N 条分支再继续（未满吞掉本次）',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'count', label: '期望到达数', type: 'number', def: '2', min: 1, max: 20, help: '几条入边都到齐才往下走' }],
      run: async (n, ctx, E) => {
        const need = Math.max(1, Math.floor(await Ctx.numOf(n, 'count', 2, E, ctx)));
        ctx.joinCounts = ctx.joinCounts || {};
        const k = n.id;
        ctx.joinCounts[k] = (ctx.joinCounts[k] || 0) + 1;
        if (ctx.joinCounts[k] >= need) { delete ctx.joinCounts[k]; return { nextPort: 'next' }; }
        return { stop: true };   // 未满：吞掉本次，其余分支照常各自执行
      },
    },
    break_loop: {
      cat: '流程', name: '跳出循环', color: '#9D7BE8', desc: '立刻结束当前这一层循环',
      ports: { in: true, out: [] },
      params: [],
      run: async (n, ctx) => { ctx._break = true; return { stop: true }; },
    },
    wait: {
      cat: '流程', name: '等待', color: '#9D7BE8', desc: '暂停若干毫秒（计入超时总预算）',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'ms', label: '毫秒', type: 'number', def: '1000', min: 0, max: 5000, help: '最长 5 秒；逻辑总超时默认 3 秒，需要更长就把「逻辑设置」里的超时调大' }],
      run: async (n, ctx, E) => {
        const ms = Math.max(0, Math.min(5000, await Ctx.numOf(n, 'ms', 1000, E, ctx)));
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
        return { nextPort: 'next' };
      },
    },

  };
};
