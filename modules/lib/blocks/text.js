/**
 * 块定义 · 文本（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    text_replace: {
      cat: '文本', name: '文本替换', color: '#E8A84A', desc: '把文本里的 找 全换成 换',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'text', label: '原文', type: 'expr', def: '', required: true },
        { k: 'from', label: '找什么', type: 'text', def: '' },
        { k: 'to', label: '换成', type: 'text', def: '' },
      ],
      run: async (n, ctx, E) => {
        const t = String(await Ctx.exprText(n, 'text', '', E, ctx) ?? '');
        const f = String(Ctx.lit(n, 'from', '') ?? '');
        const to = String(Ctx.lit(n, 'to', '') ?? '');
        return { nextPort: 'next', output: f === '' ? t : t.split(f).join(to) };
      },
    },
    text_slice: {
      cat: '文本', name: '文本截取', color: '#E8A84A', desc: '从第几字起取几个字',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'text', label: '原文', type: 'expr', def: '', required: true },
        { k: 'start', label: '从第几字(从1起)', type: 'number', def: '1' },
        { k: 'count', label: '取几个字', type: 'number', def: '1' },
      ],
      run: async (n, ctx, E) => {
        const t = String(await Ctx.exprText(n, 'text', '', E, ctx) ?? '');
        const s = Math.max(0, Math.floor(await Ctx.numOf(n, 'start', 1, E, ctx)) - 1);
        const c = Math.max(0, Math.floor(await Ctx.numOf(n, 'count', 1, E, ctx)));
        return { nextPort: 'next', output: t.slice(s, s + c) };
      },
    },
    text_case: {
      cat: '文本', name: '大小写', color: '#E8A84A', desc: '转大写或小写',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'text', label: '原文', type: 'expr', def: '', required: true },
        { k: 'mode', label: '转成', type: 'select', def: '大写', options: ['大写', '小写'] },
      ],
      run: async (n, ctx, E) => {
        const t = String(await Ctx.exprText(n, 'text', '', E, ctx) ?? '');
        const m = Ctx.lit(n, 'mode', '大写');
        return { nextPort: 'next', output: m === '小写' ? t.toLowerCase() : t.toUpperCase() };
      },
    },
    text_find: {
      cat: '文本', name: '查找位置', color: '#E8A84A', desc: '第几个字开始出现（找不到=-1）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'text', label: '原文', type: 'expr', def: '', required: true },
        { k: 'sub', label: '要找的字', type: 'text', def: '' },
      ],
      run: async (n, ctx, E) => {
        const t = String(await Ctx.exprText(n, 'text', '', E, ctx) ?? '');
        const s = String(Ctx.lit(n, 'sub', '') ?? '');
        return { nextPort: 'next', output: t.indexOf(s) };
      },
    },
    text_pad: {
      cat: '文本', name: '补零', color: '#E8A84A', desc: '左边补 0 到指定长度',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'value', label: '值', type: 'expr', def: '', required: true },
        { k: 'len', label: '补到多长', type: 'number', def: '2' },
      ],
      run: async (n, ctx, E) => {
        let s = String(await Ctx.exprText(n, 'value', '', E, ctx) ?? '');
        const L = Math.max(0, Math.floor(await Ctx.numOf(n, 'len', 2, E, ctx)));
        while (s.length < L) s = '0' + s;
        return { nextPort: 'next', output: s };
      },
    },
    text_concat: {
      cat: '文本', name: '拼接文本', color: '#E8A84A', desc: '两个值拼成一句话',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'a', label: '第一个', type: 'expr', def: '', required: true },
        { k: 'b', label: '第二个', type: 'expr', def: '' },
      ],
      run: async (n, ctx, E) => {
        const a = await Ctx.exprText(n, 'a', '', E, ctx);
        const b = await Ctx.exprText(n, 'b', '', E, ctx);
        return { nextPort: 'next', output: String(a == null ? '' : a) + String(b == null ? '' : b) };
      },
    },

  };
};
