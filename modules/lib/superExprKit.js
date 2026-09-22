/**
 * 表达式引擎装配件（2026-09-19 S2 第十一批 · 从 superModule 门面里搬出的第九件胶水）
 * ------------------------------------------------------------------
 * 纯函数（建列表/取第N项/文本替换/数字运算…）已经在 superExpr.FUNCS 里，块与代码两种模式共用。
 * 这里补上【需要上下文】的那几个，让块里的表达式也能写：
 *   玩家()/读玩家() · 参数() · 变量() · 检查物品() · 查询() · 查玩家() · 调用()
 * 与代码模式同名同义 —— 于是「由代码生成块」出来的图不会再跑到那一步报「不认识」。
 *
 * 注意：函数形态拿的是【求值后的参数】，所以字段名要带引号（读玩家("昵称")）；块里的惯用写法仍是 玩家.昵称。
 * 白名单只认 lib/superTables.js（唯一来源）；查表/查子表越界一律抛 E_WHITELIST。
 */
'use strict';

function createExprOptions(opts) {
  const o = opts || {};
  const host = o.host;
  const invokeLogic = o.invokeLogic;
  const tables = o.tables || {};
  const QUERY_TABLES = tables.query || [];
  const PLAYER_TABLES = tables.player || [];
  const argStr = (a, i) => String(a[i] == null ? '' : a[i]);

  return {
    getVar: (name, ctx) => host.getVariableValue(name, ctx.playerId, ctx.data || {}),
    call: (key, args, ctx) => invokeLogic(key, { playerId: ctx.playerId, args, source: 'call', depth: (ctx.depth || 0) + 1 }),
    extraFuncs: {
      '玩家': (a, ctx) => (ctx.player || {})[argStr(a, 0)],
      '读玩家': (a, ctx) => (ctx.player || {})[argStr(a, 0)],
      '参数': (a, ctx) => {
        const n = argStr(a, 0).trim();
        if (n === '个数' || n === '数量') return (ctx.args || []).length;
        const i = Number(n);
        return i ? (ctx.args || [])[i - 1] : (ctx.args || []);
      },
      '变量': (a, ctx) => (ctx.vars || {})[argStr(a, 0).trim()],
      '检查物品': (a, ctx) => {
        const bp = (ctx.player && ctx.player['背包']) || {};
        return Number(bp[argStr(a, 0)] || 0) >= (Number(a[1]) || 1);
      },
      '查询': async (a, ctx) => {
        const table = argStr(a, 0) || 'items';
        const by = argStr(a, 1) || 'name';
        const val = a[2] == null ? '' : a[2];
        const field = argStr(a, 3);
        if (QUERY_TABLES.indexOf(table) < 0) { const e = new Error('不允许查询表：' + table); e.code = 'E_WHITELIST'; throw e; }
        const row = await host.db.get('SELECT * FROM ' + table + ' WHERE ' + by + ' = ? LIMIT 1', [val]);
        return row ? (field ? row[field] : row) : null;
      },
      '查玩家': async (a, ctx) => {
        const t = argStr(a, 0) || 'player_backpack';
        const pid = argStr(a, 1) || ctx.playerId;
        if (PLAYER_TABLES.indexOf(t) < 0) { const e = new Error('不允许查询子表：' + t); e.code = 'E_WHITELIST'; throw e; }
        return await host.playerDb.all('SELECT * FROM ' + t + ' WHERE player_id = ? LIMIT 100', [pid]);
      },
    },
  };
}

module.exports = { createExprOptions };
