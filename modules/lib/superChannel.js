/**
 * 通道与兜底层（2026-09-18 S2 第八批 · 从 superModule 巨型闭包里搬出的第八层）
 * ------------------------------------------------------------------
 * server.js 在核心回「未知指令」之后调 fallbackMatch，本层负责：
 *   ① super:<key> [参数...] 的解析（引号感知；全项目只此一份解析）
 *   ② 兜底匹配：多轮状态 → 触发词表 → super: 通道 → 逻辑名兜底
 *   ③ 回复体组装（模板渲染 + 冲突提示跟着一起给）
 * 行为零变更：匹配顺序、禁用逻辑「仍然回应」的口径、键名兜底与提示文案全部与搬迁前一致。
 */
'use strict';

function createChannel(opts) {
  const o = opts || {};
  const tokenizeArgs = o.tokenizeArgs;
  const triggers = o.triggers;
  const host = o.host;
  const getLogic = o.getLogic;
  const invokeLogic = o.invokeLogic;
  const routeState = o.routeState;
  const setInbound = o.setInbound;
  const buildResponse = o.buildResponse;
  const lookupTemplateContent = o.lookupTemplateContent;
  const renderTemplateContent = o.renderTemplateContent;
  const getTriggerMap = o.getTriggerMap || (() => ({}));   // 专属触发词 → 逻辑 key
  const usableLogicList = o.usableLogicList || (() => Promise.resolve(''));

  /**
   * super:<key> [参数...] 的解析（2026-09-18 结构治理）
   * 这段「找到 super: 位置 → 按引号感知切分 → 第一个是 key、其余是参数」以前在三处各写一遍：
   * 兜底匹配、通道处理器、触发词带参特判。写三遍的直接后果是注释里记着的那次事故 ——
   * 「触发词 丁」曾把 丁 既当 key 又当参数。现在只此一份。
   * @returns {{key:string,args:string[],named:Object}|null} 找不到 super: 时返回 null
   */
  function parseSuperChannel(raw) {
    const s = String(raw == null ? '' : raw);
    const idx = s.search(/super\s*:/i);
    if (idx < 0) return null;
    const tok = tokenizeArgs(s.slice(idx).replace(/^super\s*:/i, ''));
    return { key: tok.args[0] || '', args: tok.args.slice(1), named: tok.named || {} };
  }

  async function fallbackMatch(playerId, text, inbound) {
    try {
      if (inbound) setInbound(playerId, inbound);   // 兜底入口也把 群id/原文 带上
      const t = String(text == null ? '' : text).trim();
      if (!t) return null;
      // 多轮状态优先（万一 server.js 那侧的状态钩子没挂上，这里兜住）：处于状态中的玩家，任何输入都回到那条逻辑
      // 2026-09-18：多轮状态兜底直接走 routeState —— 它带同玩家串行锁与禁用/过期清理，口径只此一份
      const __st = await routeState(playerId, t, inbound);
      if (__st) return __st;
      let m = triggers.match(t);
      // 大小写不敏感 + 句中出现的 super: 通道
      if (!m) {
        const ch = parseSuperChannel(t);   // 2026-09-18：通道解析只此一份（见 parseSuperChannel 注释）
        if (ch) {
          if (!ch.key) return await renderFallback(buildResponse({ ok: false, code: 'E_ARGS', error: '用法：super:<逻辑名> [参数...]' }, ''), playerId);
          m = { key: ch.key, args: ch.args, named: ch.named, mode: 'prefix', source: 'command' };
        }
      }
      // 口径说明（2026-09-18）：被禁用的逻辑，它的触发词在这里仍然会被匹配到，
      // 于是玩家得到「❌ 自定义逻辑【X】已禁用。」而不是「未知指令」。这是**有意为之**：
      // 事件/定时线跳过禁用逻辑是因为没人看着、报错只会刷日志；指令线是玩家自己打了字，
      // 必须告诉他为什么没反应（test_super_full 的 6.12 就是钉这条的）。
      //
      // 键名兜底（2026-09-17 · BUG 记录 1）：触发词跟别人撞车、或压根没配触发词时，
      // 直接打「逻辑名」也让它跑起来，并在回复里说明为什么触发词没生效。
      // 只读不写、只在「触发词完全没匹配上」时触发，不会抢已有指令。
      let note = '';
      if (!m) {
        const tok = tokenizeArgs(t);
        const k0 = tok.args[0];
        if (k0) {
          const row = await getLogic(k0);
          if (row && row.enabled) {
            m = { key: k0, args: tok.args.slice(1), named: tok.named, mode: 'key', source: 'key' };
            const conf = (triggers.conflicts() || []).find((c) => c.key === k0);
            if (conf) note = '（提示：' + conf.reason + ' —— 换个触发词，或一直用 super:' + k0 + ' 调用）';
          }
        }
      }
      if (!m) return null;
      const out = await invokeLogic(m.key, { playerId, args: m.args, named: m.named, source: m.source || ('trigger:' + m.mode) });
      return await renderFallback(buildResponse(out, m.key), playerId, note);
    } catch (e) {
      host.log('error', '[super] fallbackMatch 异常: ' + e.message);
      return null;
    }
  }

  async function renderFallback(resp, playerId, note) {
    // 2026-09-18 结构治理：与 renderTemplateInline 共用同一份「变体展开 + DB/内存查找 + 渲染」
    // （原来这里另抄了一份逐字相同的 variants 循环，改口径必漏一处）
    const templateContent = await lookupTemplateContent(resp.templateKey);
    let content = await renderTemplateContent(templateContent, resp.data || {}, playerId);
    if (note) content = (content ? content + '\n' : '') + note;   // 触发词冲突等提示跟着回复一起给，绝不静默
    return { type: 'text', content, error: false, code: null, moduleName: 'super', door: 'super:invoke', data: resp.data || {} };
  }

  /**
   * super:invoke 门处理器（2026-09-19 S2 第十批从 superModule 搬入）：
   *   专属触发词走 triggerMap（request.args 整体是玩家参数，args[0] 不是 key）；
   *   super: 通道则按引号感知重新切分（核心的 args 是空白拆分）。
   *   没有 key 时回「可用逻辑清单」（以前模板提示 super: 却给不出列表，2026-09-18 补）。
   */
  async function handleInvoke(request) {
    const { playerId, trigger, commandText } = request;
    let key = (request.args && request.args[0]) || '';
    let restArgs = (request.args || []).slice(1);
    let named = {};
    if (trigger && trigger !== 'super:') {
      // 专属触发词：key 一律来自 triggerMap；request.args 整体都是玩家参数（args[0] 不是 key）
      // 实机验证（2026-09-15）：'触发词 丁' 曾把 丁 既当 key 又当参数 → 参数.1/参数.2 都=丁；带引号时还会串位
      const raw = String(commandText || '').trim();
      if (raw.startsWith(trigger)) {
        const tok = tokenizeArgs(raw.slice(trigger.length));
        restArgs = tok.args; named = tok.named;
      } else {
        restArgs = (request.args || []).slice();
      }
      key = getTriggerMap()[trigger] || key;
    } else {
      // super: 通道：重新按引号感知切分（核心 args 是空白拆分）
      const ch2 = parseSuperChannel(commandText);   // 2026-09-18：同一个解析函数
      if (ch2) {
        key = ch2.key;
        restArgs = ch2.args;
        named = ch2.named;
      }
    }
    if (!key) {
      // 2026-09-18：模板一直提示「输入 super: 查看可用列表」，但打进来只回一句用法 —— 列表根本不存在。
      const list = await usableLogicList();
      return { status: 'fail_nokey', data: { 列表: host.protectBrackets(list) }, templateKey: 'super:invoke.fail_nokey' };
    }
    const out = await invokeLogic(key, { playerId, args: restArgs, named, source: (trigger === 'super:' ? 'command' : 'trigger') });
    return buildResponse(out, key);
  }
  return { parseSuperChannel, fallbackMatch, renderFallback, handleInvoke };
}

module.exports = { createChannel };
