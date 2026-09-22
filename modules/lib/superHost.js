/**
 * 宿主适配层（2026-09-18 S2 · 从 superModule 的巨型闭包里搬出来的第一层）
 * ------------------------------------------------------------------
 * 唯一目的：把「核心（core）长什么样」这件事收进一个文件。
 * 上层（存储/编译/运行时/应答）只依赖这里暴露的窄接口 —— 换核心、写测试假核心都只改这里。
 *
 * 注意：本文件【不改核心、不改行为】，只是把散落的 core.xxx 调用点收口。
 */
'use strict';

/**
 * 方括号保护（2026-09-18 · BUG 记录 4：逻辑输出里的 [方括号] 会整段消失）
 *
 * 核心 renderTemplate 在替换完 [消息] 之后还会再扫一遍结果里的 [变量名]：
 * 逻辑返回「[甲][乙]」时，[甲]/[乙] 被当成变量名 → 查不到 → 被替换成空串
 * → 玩家收到一条空回复（编辑器里怎么看都正常，只有实机看不到内容）。
 *
 * 核心自己用一对私有标记 \uE000 / \uE001 保护「替换进来的值」（renderTemplate 最后一步会清掉它们）。
 * 这里给消息体里的方括号套上同一对标记：核心不会再把它们当变量，最终输出仍是原文的 [甲][乙]。
 * 只有真的含方括号时才动手，且只作用于送进模板的 data，不影响 return 值本身。
 *
 * ⚠️ 契约：这对标记与核心的清理时机是【核心侧不可改符号】，见开发文档附录 D。
 */
const PUA_L = '\uE000';
const PUA_R = '\uE001';
function protectBrackets(s) {
  const t = String(s == null ? '' : s);
  if (t.indexOf('[') < 0 && t.indexOf(']') < 0) return t;
  // 标记必须夹在方括号【里面】："[甲]" → "[\uE000甲\uE001]"。
  // 放外面（\uE000[甲]）没用 —— 正则 \[([\u4e00-\u9fa5\w]+)\] 照样匹配。
  return t.replace(/\[/g, '[' + PUA_L).replace(/\]/g, PUA_R + ']');
}

/** 造一个宿主门面；所有 core 访问都从这里出去 */
function createHost(core) {
  /** 日志永不抛：日志失败不该影响业务（原来每个调用点都要套 try/catch，共 20 处） */
  const log = (lv, msg) => { try { core.log(lv, msg); } catch (e) { /* 日志失败不影响业务 */ } };
  return {
    core,
    PUA_L, PUA_R, protectBrackets, log,
    now: () => Date.now(),
    db: core.db,
    playerDb: core.db && core.db.playerDb,   // 双库铁律：玩家子表只走这里
    getPlayer: (playerId) => core.db.getPlayer(playerId),
    messageMode: () => { try { return core.getMessageMode(); } catch (e) { return 1; } },
    renderTemplate: (tpl, data, playerId) => core.renderTemplate(tpl, data || {}, { escape: false }, playerId),
    getVariableValue: (name, playerId, ctxData) => core.getVariableValue(name, playerId, 0, ctxData || {}),
  };
}

module.exports = { createHost, protectBrackets, PUA_L, PUA_R };
