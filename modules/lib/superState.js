/**
 * 状态与上下文层（2026-09-18 S2 第六批 · 从 superModule 巨型闭包里搬出的第六层）
 * ------------------------------------------------------------------
 * 两件事：
 *   ① 上下文透传：server.js 每条消息进来先 setInbound()，逻辑里就能用 [群ID]/[玩家id]/[原始消息]
 *   ② 多轮状态：逻辑跑「进入状态」→ 该玩家下一条消息（不管内容）回到那条逻辑，
 *      [输入] = 玩家发的原文；跑完状态自动清掉，逻辑里再「进入状态」就继续 → 多轮对话
 * 存储：主库 custom_logic_state（一玩家一状态 + 过期时间），重启核心不丢。
 * 行为零变更：SQL、消费式语义、过期清理、按玩家串行的锁、降级策略与搬迁前逐字一致。
 */
'use strict';

function createStateLayer(opts) {
  const o = opts || {};
  const db = o.db;
  const invokeLogic = o.invokeLogic;      // (key, opts) => Promise<out>
  const getLogic = o.getLogic;            // (key) => Promise<row|null>
  const respond = o.respond;              // (out, key) => resp（应答层）
  const renderFallback = o.renderFallback;// (resp, playerId, note) => 回复体（兜底层）
  const log = o.log || (() => {});

  const inboundMap = new Map();           // playerId -> { groupId, userId, channel, channelId, text, at }
  const stateLocks = new Map();           // playerId -> Promise（同一玩家的状态路由串行）

  /** server.js 每条消息进来写一次；模块外（测试/工具）也可以直接调 */
  function setInbound(playerId, info) {
    if (!playerId) return;
    const i = info || {};
    inboundMap.set(String(playerId), {
      groupId: i.groupId == null ? '' : String(i.groupId),
      userId: i.userId == null ? '' : String(i.userId),
      channel: i.channel == null ? '' : String(i.channel),
      channelId: i.channelId == null ? '' : String(i.channelId),
      text: i.text == null ? '' : String(i.text),
      at: Date.now(),
    });
    if (inboundMap.size > 5000) {   // 防内存涨：丢最老的 1000 条（上下文只对「刚来的消息」有意义）
      const keys = Array.from(inboundMap.keys()).slice(0, 1000);
      for (const k of keys) inboundMap.delete(k);
    }
  }
  function inboundOf(playerId) { return (playerId && inboundMap.get(String(playerId))) || {}; }

  /** 把「这条消息从哪来」塞进逻辑数据（指令 / 事件 / 定时 / 状态 四个入口共用） */
  function injectContext(ctx, opts2) {
    const p = opts2 || {};
    const ib = inboundOf(ctx.playerId);
    const raw = p.rawText != null ? String(p.rawText) : String(ib.text == null ? '' : ib.text);
    const gid = ib.groupId == null ? '' : String(ib.groupId);
    const stName = p.stateName != null ? String(p.stateName) : '';
    const first = (ctx.args && ctx.args.length) ? String(ctx.args[0] == null ? '' : ctx.args[0]) : '';
    ctx.data['玩家id'] = ctx.playerId || '';
    ctx.data['玩家ID'] = ctx.playerId || '';
    ctx.data['群id'] = gid;
    ctx.data['群ID'] = gid;
    ctx.data['原始消息'] = raw;
    ctx.data['输入'] = raw || first;          // 状态多轮时「输入」就是玩家刚发的那句话
    ctx.data['状态名'] = stName;
    ctx.data['来源'] = ctx.source || '';
    return ctx.data;
  }

  /** 读该玩家当前状态（过期即清） */
  async function stateGet(playerId) {
    if (!playerId) return null;
    try {
      const row = await db.get('SELECT * FROM custom_logic_state WHERE player_id = ? LIMIT 1', [String(playerId)]);
      if (!row) return null;
      if (row.expires_at && Number(row.expires_at) > 0 && Date.now() > Number(row.expires_at)) {
        try { await db.run('DELETE FROM custom_logic_state WHERE player_id = ?', [String(playerId)]); } catch (e) {}
        return null;
      }
      return row;
    } catch (e) { return null; }   // 表还没建（老库）/读库失败：状态功能降级，不影响其它逻辑
  }

  /** 写入/刷新状态（playerId 维度唯一；timeoutSec=0 表示不过期） */
  async function stateSet(playerId, info) {
    if (!playerId) return false;
    const i = info || {};
    const now = new Date().toISOString();
    const exp = Number(i.timeoutSec) > 0 ? Date.now() + Number(i.timeoutSec) * 1000 : 0;
    await db.run(
      'INSERT INTO custom_logic_state (player_id, logic_key, state_name, args_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(player_id) DO UPDATE SET logic_key = excluded.logic_key, state_name = excluded.state_name, expires_at = excluded.expires_at, updated_at = excluded.updated_at',
      [String(playerId), String(i.logicKey || ''), String(i.name || ''), '[]', exp, now, now],
    );
    return true;
  }

  /** 结束状态：name 为空 = 结束该玩家所有状态；不匹配 name 时不动（返回 false） */
  async function stateClear(playerId, name) {
    if (!playerId) return false;
    try {
      const cur = await db.get('SELECT * FROM custom_logic_state WHERE player_id = ? LIMIT 1', [String(playerId)]);
      if (!cur) return false;
      if (name && String(cur.state_name) !== String(name)) return false;
      await db.run('DELETE FROM custom_logic_state WHERE player_id = ?', [String(playerId)]);
      return true;
    } catch (e) { return false; }
  }

  /** 用状态里记的逻辑跑这一条消息（消费式：先清状态，逻辑里再「进入状态」就续上） */
  async function runState(playerId, st, text) {
    await stateClear(playerId);
    const raw = String(text == null ? '' : text);
    const out = await invokeLogic(st.logic_key, {
      playerId, args: [raw], named: {}, source: 'state', stateName: st.state_name, rawText: raw,
    });
    return await renderFallback(respond(out, st.logic_key), playerId, '');
  }

  /**
   * 多轮状态路由（server.js 在 handleCommand **之前**调用：处于状态中的玩家，输入任何内容都回到那条逻辑）。
   * 返回 null = 这个玩家不在任何状态里，正常走指令。
   *
   * 2026-09-18：同一玩家的状态路由串行化。以前 stateGet → 校验 → stateClear → invoke 不是原子的：
   * 玩家连发两条消息时，两边都会先读到状态、再各跑一遍 —— 多轮对话被吃掉一轮（同一个状态被消费两次）。
   */
  async function routeState(playerId, text, inbound) {
    if (!playerId) return null;
    const lk = String(playerId);
    const prev = stateLocks.get(lk) || Promise.resolve();
    const run = prev.catch(() => { }).then(() => routeStateInner(playerId, text, inbound));
    stateLocks.set(lk, run);
    try { return await run; } finally { if (stateLocks.get(lk) === run) stateLocks.delete(lk); }
  }
  async function routeStateInner(playerId, text, inbound) {
    try {
      if (inbound) setInbound(playerId, inbound);
      if (!playerId) return null;
      const st = await stateGet(playerId);
      if (!st) return null;
      const row = await getLogic(st.logic_key);
      if (!row || !row.enabled) { await stateClear(playerId); return null; }   // 逻辑没了/被禁用：别把玩家困住
      return await runState(playerId, st, text);
    } catch (e) {
      log('error', '[super] routeState 异常: ' + e.message);
      return null;
    }
  }

  return { setInbound, inboundOf, injectContext, stateGet, stateSet, stateClear, runState, routeState, inboundSize: () => inboundMap.size, lockSize: () => stateLocks.size };
}

module.exports = { createStateLayer };
