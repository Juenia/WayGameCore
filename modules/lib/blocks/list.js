/**
 * 块定义 · 列表（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    list_make: {
      cat: '列表', name: '建列表', color: '#3DC5C5', desc: '把一个列表表达式变成值（后面块用 节点.N 取）',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'items', label: '列表表达式', type: 'list', def: '分割("甲,乙", ",")', required: true, help: '如 [1,2,3] 或 分割("甲,乙", ",")' }],
      run: async (n, ctx, E) => { const v = await Ctx.exprOf(n, 'items', '[]', E, ctx); return { nextPort: 'next', output: Array.isArray(v) ? v : [] }; },
    },
    list_append: {
      cat: '列表', name: '列表追加', color: '#3DC5C5', desc: '把值追加到列表末尾',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'list', label: '列表', type: 'list', def: '[]', required: true, help: '列表表达式' },
        { k: 'value', label: '要加的值', type: 'expr', def: '' },
      ],
      run: async (n, ctx, E) => {
        const l = await Ctx.exprOf(n, 'list', '[]', E, ctx);
        const v = await Ctx.exprText(n, 'value', '', E, ctx);   // 追加的往往是人话，走文本语义
        const a = (Array.isArray(l) ? l : []).slice();
        a.push(v);
        return { nextPort: 'next', output: a };
      },
    },
    list_get: {
      cat: '列表', name: '取第N项', color: '#3DC5C5', desc: '第 1 项 = 第一个',
      ports: { in: true, out: ['next'] },
      params: [
        // 2026-09-18：原来默认是空列表 []，配合"越界报错"变成"刚拖出来就报错"。
        // 默认给个能直接跑出东西的例子，用户改起来也直观。
        { k: 'list', label: '列表', type: 'list', def: '[1,2,3]', required: true },
        { k: 'index', label: '第几项(从1起)', type: 'number', def: '1', min: 1 },
      ],
      run: async (n, ctx, E) => {
        const l = await Ctx.exprOf(n, 'list', '[]', E, ctx);
        const want = Math.floor(await Ctx.numOf(n, 'index', 1, E, ctx));
        const i = Math.max(0, want - 1);
        const a = Array.isArray(l) ? l : [];
        // 2026-09-18：越界以前返回 undefined，下游 字符串() 会把它变成 "undefined" 发到群里
        if (i >= a.length) throw new Error('列表只有 ' + a.length + ' 项，取不到第 ' + want + ' 项（「取第N项」的索引从 1 起）');
        return { nextPort: 'next', output: a[i] };
      },
    },
    list_len: {
      cat: '列表', name: '列表长度', color: '#3DC5C5', desc: '有多少项',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'list', label: '列表', type: 'list', def: '[]', required: true }],
      run: async (n, ctx, E) => { const l = await Ctx.exprOf(n, 'list', '[]', E, ctx); return { nextPort: 'next', output: (Array.isArray(l) ? l : []).length }; },
    },
    list_contains: {
      cat: '列表', name: '列表包含', color: '#3DC5C5', desc: '列表里有没有这个值（有走真，没有走假）',
      ports: { in: true, out: ['true', 'false'] },
      params: [
        { k: 'list', label: '列表', type: 'list', def: '[]', required: true },
        { k: 'value', label: '要找的值', type: 'expr', def: '', required: true },
      ],
      run: async (n, ctx, E) => {
        const l = await Ctx.exprOf(n, 'list', '[]', E, ctx);
        const v = await Ctx.exprText(n, 'value', '', E, ctx);   // 要找的值多半是人话，走文本语义
        const a = Array.isArray(l) ? l : [];
        const ok = a.includes(v);
        return { nextPort: ok ? 'true' : 'false', output: ok };
      },
    },
    list_range: {
      cat: '列表', name: '数字序列', color: '#3DC5C5', desc: '生成 从A 到 B 的整数列表',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'from', label: '从', type: 'number', def: '1' },
        { k: 'to', label: '到', type: 'number', def: '5' },
      ],
      run: async (n, ctx, E) => {
        const a = Math.floor(await Ctx.numOf(n, 'from', 1, E, ctx));
        const b = Math.floor(await Ctx.numOf(n, 'to', 5, E, ctx));
        // 2026-09-18：以前不设上限，"从1到999999" 会真去建 100 万项数组（内存+耗时全炸）
        const span = Math.abs(b - a) + 1;
        if (span > 10000) throw new Error('数字序列太长：' + a + '→' + b + ' 一共 ' + span + ' 项，最多 10000 项 —— 缩小范围，或改用「循环 次数」');
        const out = [];
        const step = a <= b ? 1 : -1;
        for (let x = a; step > 0 ? x <= b : x >= b; x += step) out.push(x);
        return { nextPort: 'next', output: out };
      },
    },

  };
};
