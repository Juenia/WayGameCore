/**
 * 块取值助手（2026-09-19 S3 第二批：从 defineBlocks 的闭包里搬出）
 * ------------------------------------------------------------------
 * 十一个「块怎么读参数」的助手：字面量 / 数字 / 表达式 / 文本 / 任意值 / 宽松求值 /
 * 字段行解析 / 写校验包装 / 需要玩家 / 推送失败人话 / 模板 key 归一化。
 * 只依赖 core、deps（invokeLogic 等）与纯助手 U（superBlockUtil），不再持有任何块定义。
 */
'use strict';

function createBlockKit(opts) {
  const o = opts || {};
  const core = o.core;
  const deps = o.deps || {};
  const U = o.util;
  const { invokeLogic, stateEnter, stateExit } = deps;

  /** 主动推送失败原因 → 人话（2026-09-17 · BUG 记录 3：以前失败了也一声不吭） */
  function pushFailReason(err) {
    const e = String(err == null ? '' : err);
    if (e === 'no route') return '这个玩家还没有跟插件通过消息（player_routes 里没有他的路由），核心不知道该推给谁';
    if (e === 'no plugin url') return '还没有任何玩家建立路由，核心不知道插件的地址（先让插件发一条消息过来）';
    if (e === 'content empty') return '推送内容为空（表达式没求出东西）';
    if (e === 'deduped') return '被去重规则拦下了（60 秒内同样的内容只推一次）';
    return e || '未知原因';
  }

  /**
   * 模板 key 归一化（2026-09-18）：老版本编辑器把下拉的「装饰文本」整串存进了参数，
   * 例如「角色 · 角色信息  (player.role.view)」。运行时若直接拿它当布局 id 会永远找不到布局、
   * 静默降级成文字。这里把括号里的真 key 抠出来，兼容已经存坏的老逻辑。
   */
  function normTemplateKey(v) {
    const s = String(v == null ? '' : v).trim();
    const m = s.match(/\(([A-Za-z0-9_.\-]+)\)\s*$/);
    return m ? m[1] : s;
  }

  // ---------- 参数取值助手 ----------
  function lit(n, k, def) {           // 字面量（不求值）
    const v = (n.params && n.params[k] !== undefined && n.params[k] !== null && n.params[k] !== '') ? n.params[k] : (def != null ? def : '');
    return U.stripQuotes(v);
  }
  async function numOf(n, k, def, E, ctx) {  // 数字：纯数字字面量，含运算符才求值
    let v = (n.params && n.params[k] !== undefined && n.params[k] !== null && n.params[k] !== '') ? n.params[k] : (def != null ? def : 0);
    v = String(v).trim();
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    const r = await E.eval(v, ctx);
    return Number(r) || 0;
  }
  async function exprOf(n, k, def, E, ctx) {  // 表达式
    const v = (n.params && n.params[k] !== undefined && n.params[k] !== null && n.params[k] !== '') ? n.params[k] : (def != null ? def : '');
    return await E.eval(String(v), ctx);
  }

  // ---------- 纯文本上下文：裸词兜底（2026-09-17） ----------
  /** 文本型表达式取值 = 普通表达式 + 裸词兜底（判定规则见文件顶部的 U.BARE_TEXT_RE） */
  async function exprText(n, k, def, E, ctx) {
    const raw = (n.params && n.params[k] !== undefined && n.params[k] !== null && n.params[k] !== '') ? n.params[k] : (def != null ? def : '');
    const src = String(raw).trim();
    const v = await exprOf(n, k, def, E, ctx);
    if (v !== null && v !== undefined && v !== '') {
      // 2026-09-18：文本字段里塞了对象/数组时，以前 String(v) → 群里出现 "[object Object]"。
      // 数组给个能看的连接（甲、乙），纯对象交给下面的"人话兜底"处理。
      if (Array.isArray(v)) return v.join('、');
      if (typeof v === 'object') { /* 落到兜底 */ } else return v;
    }
    if (!src) return v;
    // ② 人话兜底：整段就是给人看的文本 → 原样用
    if (U.BARE_TEXT_RE.test(src) && !U.VAR_LIKE_RE.test(src)) return src;
    // ③ 长得像模板（含 [变量] / {变量}）→ 交给核心的模板渲染：
    //    用户写 '测试主动推送群[群ID]' 时想要的就是"把群ID插进去"，这在核心模板里是标准写法。
    if (/[\[{]/.test(src)) {
      try {
        const r = await core.renderTemplate(src, ctx.data || {}, { escape: false }, ctx.playerId || null, null);
        const out = String(r == null ? '' : r).trim();
        if (out && out !== src) return out;      // 真的替换掉了东西才算数
      } catch (e) { /* 渲染失败就保持原样，交给"没有输出"诊断去说清楚 */ }
    }
    return v;
  }

  /**
   * 赋值专用取值（2026-09-18 参考实例轮）：与 exprText 同一套兜底，但【数组/对象原样保留】。
   * 以前「变量赋值」走 exprText → [1,2,3] 被 join('、') 成 "1、2、3"，
   * 于是「遍历 变量.清单」拿到的不是数组 → 循环体一次都不跑（列表类块在块模式等于废掉一半）。
   * 代码模式早就为这个单独留了 valueOf，块这边现在对齐。
   */
  async function exprValue(n, k, def, E, ctx) {
    const raw = (n.params && n.params[k] !== undefined && n.params[k] !== null && n.params[k] !== '') ? n.params[k] : (def != null ? def : '');
    const src = String(raw).trim();
    const v = await exprOf(n, k, def, E, ctx);
    if (v !== null && v !== undefined && v !== '') return v;
    if (!src) return v;
    if (U.BARE_TEXT_RE.test(src) && !U.VAR_LIKE_RE.test(src)) return src;
    if (/[\[{]/.test(src)) {
      try {
        const r = await core.renderTemplate(src, ctx.data || {}, { escape: false }, ctx.playerId || null, null);
        const out = String(r == null ? '' : r).trim();
        if (out && out !== src) return out;
      } catch (e) { /* 渲染失败保持原样，交给"没有输出"诊断说清楚 */ }
    }
    return v;
  }

  // ========== ⑩ 段助手：块模式侧的取值包装（纯逻辑在文件顶层，与代码模式共用） ==========
  /**
   * 松散求值（给用户手写的「字段=值」用）：
   * 表达式 → 裸词当文本 → 手写 JSON 原样留下。绝不静默变成空串。
   */
  async function evalLoose(src, E, ctx) {
    const s = String(src == null ? '' : src).trim();
    if (!s) return '';
    if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) return s.slice(1, -1);
    let v = null;
    try { v = await E.eval(s, ctx); } catch (e) { v = null; }
    if (v !== null && v !== undefined && v !== '') {
      if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
      return v;
    }
    if (U.BARE_TEXT_RE.test(s) && !U.VAR_LIKE_RE.test(s)) return s;   // 「新手剑」这种裸词就是文本
    if (/^[\[{]/.test(s)) return s;                              // 手写 JSON（[]、{}）原样存
    return '';
  }
  /** 解析「字段=值; 字段2=值2」：切行用顶层 U.splitFieldLines，值在块模式这边求 */
  async function parseFieldPairs(raw, E, ctx) {
    const out = [];
    for (const f of U.splitFieldLines(U.stripQuotes(raw))) out.push({ col: f.col, val: await evalLoose(f.valRaw, E, ctx) });
    return out;
  }
  /** 写操作前体检：表白名单 + 每个字段都必须是这张表真实存在的列 */
  async function checkWrite(table, pairs) {
    const t = String(table == null ? '' : table).trim();
    if (U.WRITE_TABLES.indexOf(t) < 0) {   // 先判白名单，再去查表结构（不然 players 会报成"读不到表结构"）
      const e = new Error('不允许写入表：' + t + '（可写：' + U.WRITE_TABLES.join('、') + '）');
      e.code = 'E_WHITELIST'; throw e;
    }
    const info = await U.tableInfo(core.db, t);
    if (!info.cols.size) { const e = new Error('读不到表结构：' + t); e.code = 'E_TABLE'; throw e; }
    U.checkWriteColumns(t, info.cols, pairs);
    return info;
  }
  function needPlayerId(ctx, what) {
    if (!ctx.playerId) { const e = new Error('「' + what + '」需要有玩家（定时/系统级触发没有玩家）'); e.code = 'E_PLAYER'; throw e; }
    return ctx.playerId;
  }

  return { pushFailReason, normTemplateKey, lit, numOf, exprOf, exprText, exprValue, evalLoose, parseFieldPairs, checkWrite, needPlayerId };
}

module.exports = { createBlockKit };
