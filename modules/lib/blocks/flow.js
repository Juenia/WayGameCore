/**
 * 块定义 · 入口 / 流程（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    entry: {
      cat: '入口', name: '开始', color: '#5B8FE8', desc: '每条逻辑的起点（自动放置）',
      ports: { in: false, out: ['next'] }, params: [],
      run: async () => ({ nextPort: 'next' }),
    },
    condition: {
      cat: '流程', name: '如果', color: '#9D7BE8', desc: '条件成立走「真」，否则走「假」',
      ports: { in: true, out: ['true', 'false'] },
      params: [{ k: 'expr', label: '条件', type: 'expr', def: '玩家.等级 >= 10', required: true, help: '支持 且/或/非，+ - * / %，>= <= > < == !=' }],
      run: async (n, ctx, E) => { const v = await Ctx.exprOf(n, 'expr', '真', E, ctx); return { nextPort: v ? 'true' : 'false' }; },
    },
    loop_n: {
      cat: '流程', name: '循环 次数', color: '#9D7BE8', desc: '把「体」里的块执行 N 次',
      ports: { in: true, out: ['body', 'next'] },
      params: [{ k: 'count', label: '次数', type: 'number', def: '3', min: 0, max: 1000, help: '循环次数（1~1000）' }],
      run: async (n, ctx, E) => {
        // 不夹取次数：Guard 的 max_steps 才是真正防线（超时测试依赖大次数触发 E_TIMEOUT）
        const count = Math.max(0, Math.floor(await Ctx.numOf(n, 'count', 3, E, ctx)));
        ctx._break = false;   // 跳出循环：循环开始先清掉上一层遗留的跳出标记
        for (let i = 0; i < count; i++) {
          if (ctx.stopped) break;
          ctx.vars['次数'] = i + 1;
          await E.execPorts(n, 'body', ctx);
          if (ctx._break) { ctx._break = false; break; }   // 「跳出循环」块
        }
        return { nextPort: 'next' };
      },
    },
    loop_each: {
      cat: '流程', name: '遍历 列表', color: '#9D7BE8', desc: '把「体」里的块对列表每项执行一次',
      ports: { in: true, out: ['body', 'next'] },
      params: [
        { k: 'list', label: '列表', type: 'list', def: '分割("甲,乙", ",")', required: true, help: '列表表达式，如 分割("甲,乙", ",") 或 [1,2,3]' },
        { k: 'var', label: '每项变量名', type: 'text', def: '项', help: '循环体内用 变量.项 取当前项' },
      ],
      run: async (n, ctx, E) => {
        const list = await Ctx.exprOf(n, 'list', '[]', E, ctx);
        const arr = Array.isArray(list) ? list : [];
        ctx._break = false;   // 跳出循环：循环开始先清掉上一层遗留的跳出标记
        for (let i = 0; i < arr.length; i++) {
          if (ctx.stopped) break;
          ctx.vars[Ctx.lit(n, 'var', '项')] = arr[i];
          ctx.vars['序号'] = i + 1;
          await E.execPorts(n, 'body', ctx);
          if (ctx._break) { ctx._break = false; break; }   // 「跳出循环」块
        }
        return { nextPort: 'next' };
      },
    },
    try_node: {
      cat: '流程', name: '尝试 / 捕获', color: '#9D7BE8', desc: '「体」出错时走「捕获」',
      ports: { in: true, out: ['body', 'catch', 'next'] }, params: [],
      run: async (n, ctx, E) => {
        try { await E.execPorts(n, 'body', ctx); }
        catch (e) {
          ctx.lastError = e.message;
          // 2026-09-18：以前错误信息只写在 ctx.lastError 里，捕获分支根本读不到 ——
          // 「尝试/捕获」抓住了错却说不出为什么。现在同时放进数据：用 [错误信息] / {错误信息} / 错误信息 都能取。
          ctx.data['错误信息'] = e.message;
          ctx.data['错误'] = e.message;
          await E.execPorts(n, 'catch', ctx);
        }
        return { nextPort: 'next' };
      },
    },
    assign: {
      cat: '数据', name: '变量赋值', color: '#3DC5C5', desc: '把值存进变量',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'name', label: '变量名', type: 'text', def: '', required: true, help: '后面用 变量.名字 取值' },
        { k: 'value', label: '值', type: 'expr', def: '', help: '可以是表达式' },
      ],
      run: async (n, ctx, E) => {
        const v = await Ctx.exprValue(n, 'value', '', E, ctx);   // 用 exprValue 不用 exprText：列表/对象要原样存进去
        ctx.vars[Ctx.lit(n, 'name', '变量')] = v;
        return { nextPort: 'next', output: v };
      },
    },
    call: {
      cat: '入口', name: '调用函数', color: '#E8A84A', desc: '调用另一条自定义逻辑（函数库）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'key', label: '逻辑 key', type: 'select', def: '', options: 'logicKeys', required: true },
        { k: 'args', label: '参数(逗号分隔)', type: 'list', def: '', help: '如 分割("甲,乙", ",") 或 "甲"' },
      ],
      run: async (n, ctx, E) => {
        const key = Ctx.lit(n, 'key', '');
        const argsRaw = await Ctx.exprOf(n, 'args', '', E, ctx);
        let args;
        if (Array.isArray(argsRaw)) args = argsRaw.map((x) => (x == null ? '' : String(x)));
        else args = String(argsRaw == null ? '' : argsRaw).split(',').map((s) => s.trim()).filter((s) => s !== '');
        const out = await Ctx.invokeLogic(key, { playerId: ctx.playerId, args, source: 'call', depth: (ctx.depth || 0) + 1 });
        // 2026-09-18：重抛时必须带上真实错误码，否则外层运行历史只会记成 E_INTERNAL
        //（运行时缺口测试 G5 抓到：深度超限 E_DEPTH 在路上丢了）
        if (out && !out.ok) { const e = new Error('调用 ' + key + ' 失败: ' + (out.error || '')); e.code = out.code || 'E_INTERNAL'; throw e; }
        return { nextPort: 'next', output: out && out.text };
      },
    },

  };
};
