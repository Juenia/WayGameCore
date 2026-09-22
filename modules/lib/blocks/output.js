/**
 * 块定义 · 输出 / 调试（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    return_text: {
      cat: '输出', name: '返回文本', color: '#5B8FE8', desc: '结束逻辑并输出文本',
      ports: { in: true, out: [] },
      params: [{ k: 'value', label: '文本(可含表达式)', type: 'expr', def: '', required: true }],
      run: async (n, ctx, E) => {
        const v = await Ctx.exprText(n, 'value', '', E, ctx);
        ctx.output.push(String(v == null ? '' : v));
        ctx.stopped = true;
        return { stop: true };
      },
    },
    return_tpl: {
      cat: '输出', name: '返回模板', color: '#5B8FE8', desc: '结束逻辑并渲染模板',
      ports: { in: true, out: [] },
      params: [{ k: 'key', label: '模板 key(room.key)', type: 'template', def: '', required: true, options: 'templateKeys' }],
      run: async (n, ctx) => {
        ctx.outputTemplate = Ctx.lit(n, 'key', '');
        ctx.stopped = true;
        return { stop: true };
      },
    },
    log: {
      cat: '输出', name: '记录日志', color: '#3DC5C5', desc: '写一条运行日志',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'text', label: '日志内容', type: 'expr', def: '' }],
      run: async (n, ctx, E) => {
        const t = await Ctx.exprText(n, 'text', '', E, ctx);
        core.log('info', '[super:' + ctx.key + '] ' + String(t == null ? '' : t));
        return { nextPort: 'next' };
      },
    },
    // 2026-09-18：事件触发的另一半 —— 自己广播事件，让「事件触发」的逻辑跑起来
    event_emit: {
      cat: '动作', name: '发出事件', color: '#E8A84A', desc: '广播一个事件，事件触发的逻辑会跑',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'name', label: '事件名', type: 'text', def: '自定义事件', required: true, help: '如 结婚 / 打怪掉落；核心内置事件（player:level_up 等）不建议手动发' },
        { k: 'data', label: '附带数据（可选）', type: 'expr', def: '', help: '会变成事件逻辑的 参数.1、参数.2…；留空则只带当前玩家' },
      ],
      run: async (n, ctx, E) => {
        const name = String(Ctx.lit(n, 'name', '自定义事件') || '').trim();
        if (!name) throw new Error('「发出事件」没有填事件名');
        let payload = [];
        const raw = (n.params && n.params.data !== undefined && n.params.data !== null) ? String(n.params.data).trim() : '';
        if (raw) {
          const v = await Ctx.exprOf(n, 'data', '', E, ctx);
          if (Array.isArray(v)) payload = v.slice();
          else if (v !== null && v !== undefined && v !== '') payload = [v];
        }
        // 第一个参数固定是发事件的玩家（事件逻辑里 = 参数.1 / 事件.玩家）
        const args = [ctx.playerId].concat(payload);
        try {
          Promise.resolve(core.emit(name, ...args)).catch(() => {});
        } catch (e) { /* 事件广播失败不影响主流程 */ }
        ctx.log = (ctx.log || []);
        return { nextPort: 'next' };
      },
    },

  };
};
