/**
 * 块定义 · 数字（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    math_op: {
      cat: '数字', name: '数字运算', color: '#5B8FE8', desc: 'a 和 b 做四则运算',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'a', label: '第一个数', type: 'expr', def: '0', required: true },
        { k: 'op', label: '运算', type: 'select', def: '+', options: ['+', '-', '*', '/', '%'] },
        { k: 'b', label: '第二个数', type: 'expr', def: '0', required: true },
      ],
      run: async (n, ctx, E) => {
        const a = Number(await Ctx.exprOf(n, 'a', '0', E, ctx)) || 0;
        const b = Number(await Ctx.exprOf(n, 'b', '0', E, ctx)) || 0;
        const op = Ctx.lit(n, 'op', '+');
        // 2026-09-18：除零以前静默算出 Infinity / NaN，玩家会在回复里看到 "Infinity"。
        // 这种必须当场说清楚，不能静默（总纲 R6.1）。
        if ((op === '/' || op === '%') && b === 0) throw new Error('除数是 0：' + a + ' ' + op + ' 0 算不出来 —— 检查「第二个数」，或者先用「如果」判断它不为 0');
        const r = op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : op === '%' ? a % b : a + b;
        if (!Number.isFinite(r)) throw new Error('算出来的不是数字（' + a + ' ' + op + ' ' + b + '）—— 检查两个数里是不是混进了文字');
        return { nextPort: 'next', output: r };
      },
    },
    math_round: {
      cat: '数字', name: '四舍五入', color: '#5B8FE8', desc: '保留几位小数',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'value', label: '值', type: 'expr', def: '0', required: true },
        { k: 'digits', label: '小数位数', type: 'number', def: '0' },
      ],
      run: async (n, ctx, E) => {
        const v = Number(await Ctx.exprOf(n, 'value', '0', E, ctx)) || 0;
        // 2026-09-18：以前位数不设上限，写 999999 会算出 NaN 且不报错；夹到 0~10（再多也没意义）
        const d = Math.min(10, Math.max(0, Math.floor(await Ctx.numOf(n, 'digits', 0, E, ctx))));
        const p = Math.pow(10, d);
        return { nextPort: 'next', output: Math.round(v * p) / p };
      },
    },
    math_rand: {
      cat: '数字', name: '随机数', color: '#5B8FE8', desc: '从A到B（含）随机一个整数',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'a', label: '从', type: 'number', def: '1' },
        { k: 'b', label: '到', type: 'number', def: '100' },
      ],
      run: async (n, ctx, E) => {
        const a = Math.floor(await Ctx.numOf(n, 'a', 1, E, ctx));
        const b = Math.floor(await Ctx.numOf(n, 'b', 100, E, ctx));
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return { nextPort: 'next', output: lo + Math.floor(Math.random() * (hi - lo + 1)) };
      },
    },
    math_compare: {
      cat: '数字', name: '数字比较', color: '#5B8FE8', desc: '比较两个数（真走真，假走假）',
      ports: { in: true, out: ['true', 'false'] },
      params: [
        { k: 'a', label: '第一个数', type: 'expr', def: '0', required: true },
        { k: 'op', label: '比较', type: 'select', def: '>=', options: ['>=', '>', '<=', '<', '==', '!='] },
        { k: 'b', label: '第二个数', type: 'expr', def: '0', required: true },
      ],
      run: async (n, ctx, E) => {
        const a = await Ctx.exprOf(n, 'a', '0', E, ctx);
        const b = await Ctx.exprOf(n, 'b', '0', E, ctx);
        const op = Ctx.lit(n, 'op', '>=');
        const r = op === '>=' ? a >= b : op === '>' ? a > b : op === '<=' ? a <= b : op === '<' ? a < b : op === '!=' ? a != b : a == b;
        return { nextPort: !!r ? 'true' : 'false', output: !!r };
      },
    },

  };
};
