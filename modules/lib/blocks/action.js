/**
 * 块定义 · 游戏动作（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    msg_send: {
      cat: '动作', name: '发消息', color: '#E8A84A', desc: '往回复里加一行文本',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'text', label: '消息内容', type: 'expr', def: '', help: '可用拼接(…)与变量' }],
      // 2026-09-19 S3+ 第三批：动作体收敛到 lib/superOps.js 的 msg_send（代码模式共用同一份）
      run: async (n, ctx, E) => {
        await Ctx.ops.msg_send({ text: await Ctx.exprText(n, 'text', '', E, ctx), raw: (n.params && n.params.text) || '', nodeId: n.id }, ctx);
        return { nextPort: 'next' };
      },
    },
    tpl_send: {
      cat: '动作', name: '发模板消息', color: '#E8A84A', desc: '用消息模板渲染',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'key', label: '模板 key(room.key)', type: 'template', def: '', required: true, options: 'templateKeys', help: '如 super.欢迎语' }],
      // 2026-09-19 S3+ 第三批：动作体收敛到 lib/superOps.js 的 tpl_send
      run: async (n, ctx, E) => {
        await Ctx.ops.tpl_send({ key: Ctx.lit(n, 'key', ''), nodeId: n.id }, ctx);
        return { nextPort: 'next' };
      },
    },
    push_send: {
      cat: '动作', name: '主动推送', color: '#E8A84A', desc: '不占回复，主动推给玩家/群',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'type', label: '推送类型', type: 'select', def: 'player', options: 'pushTypes', help: 'player=单推 / group=群 / broadcast=全服' },
        { k: 'content', label: '内容', type: 'expr', def: '', required: true },
        // 2026-09-17 新增三件（BUG：推送没跟基础设置的类型走 + 推送抢在图片回复前面到达）
        { k: 'mode', label: '发送方式', type: 'select', def: '跟随全局', options: ['跟随全局', '纯文本', 'Markdown', '图片'], help: '跟随全局 = 编辑器「基础设置 → 消息模式」' },
        { k: 'template', label: '出图用的布局', type: 'select', def: 'system.info', options: 'templateKeys', help: '只有「图片」方式才用；默认用「系统 · 系统通知」那张卡' },
        { k: 'delay', label: '延迟(秒)', type: 'number', def: '3', min: 0, max: 60, help: '让被动回复先发出去，避免群里顺序颠倒；0=立刻推' },
      ],
      // 2026-09-19 S3+ 第二批：约 100 行的动作体收敛到 lib/superOps.js 的 push_send（代码模式共用同一份）
      // 这里只负责「参数从块上取出来」与「返回形状」
      run: async (n, ctx, E) => {
        const r = await Ctx.ops.push_send({
          type: Ctx.lit(n, 'type', 'player'),
          text: await Ctx.exprText(n, 'content', '', E, ctx),
          rawContent: (n.params && n.params.content) || '',
          wantMode: Ctx.lit(n, 'mode', '跟随全局'),
          tplKey: Ctx.normTemplateKey(Ctx.lit(n, 'template', 'system.info')),
          delaySec: await Ctx.numOf(n, 'delay', 3, E, ctx),
        }, ctx);
        return { nextPort: 'next', output: r.status };
      },
    },
    quest_complete: {
      cat: '动作', name: '完成任务', color: '#E8A84A', desc: '把任务标记完成并发奖励',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'name', label: '任务', type: 'quest', def: '', required: true, options: 'questNames' }],
      run: async (n, ctx) => {
        const qm = core.getModule('quest');
        const name = Ctx.lit(n, 'name', '');
        if (qm && typeof qm.completeQuest === 'function') { await qm.completeQuest(ctx.playerId, String(name), core.services); }
        ctx.playerDirty = true;
        return { nextPort: 'next' };
      },
    },
    teleport: {
      cat: '动作', name: '传送地图', color: '#E8A84A', desc: '把玩家送到某张地图',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'map', label: '地图', type: 'map', def: '', required: true, options: 'mapNames' }],
      run: async (n, ctx) => {
        const m = Ctx.lit(n, 'map', '');
        await core.services.player.modify({ playerId: ctx.playerId, changes: { '当前地图': { set: String(m) } }, source: 'super:' + ctx.key });
        ctx.playerDirty = true;
        return { nextPort: 'next' };
      },
    },

  };
};
