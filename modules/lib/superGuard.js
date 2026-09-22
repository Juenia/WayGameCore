/**
 * 守卫层（2026-09-18 S2 第四批 · 从 superModule 巨型闭包里搬出的第四层）
 * ------------------------------------------------------------------
 * 两件事，都是「别让一条逻辑把服务器或被调用方拖垮」：
 *   ① 限频：rate_limit 形如 "3/10s" / "5/1m" / "2/500ms"（写错或不写 = 不限频）
 *   ② 同玩家同逻辑串行：后一条排队等前一条结束（防同一玩家并发写同一份数据）
 * 状态（时间戳表 / 排队表）由本层自己持有，模块闭包里不再散落 Map。
 * 行为零变更：窗口算法、人话文案、排队与清理时机与搬迁前逐字一致。
 */
'use strict';

function createGuard(opts) {
  const o = opts || {};
  const rateMap = o.rateMap || new Map();     // 'playerId|key' -> [timestamps]
  const queues = o.queues || new Map();       // 'playerId|key' -> Promise

  /** 解析限频规则；返回 null = 不限频 */
  function parseRateLimit(v) {
    if (!v) return null;
    const m = String(v).trim().match(/^(\d+)\s*\/\s*(\d+)(ms|s|m)$/);
    if (!m) return null;
    const unit = { ms: 1, s: 1000, m: 60000 }[m[3]] || 1000;
    return { max: Number(m[1]) || 3, windowMs: (Number(m[2]) || 10) * unit };
  }

  /**
   * 记一次并判定。放行 → { ok: true }；超出上限 → { ok: false, message: 人话 }。
   * 只在判定为「挡住」时保留窗口数据，放行时把当前时间戳推进窗口。
   */
  function rateLimit(playerId, key, rl, nowMs) {
    if (!rl) return { ok: true };
    const rk = playerId + '|' + key;
    const now = nowMs || Date.now();
    const arr = (rateMap.get(rk) || []).filter((t) => now - t < rl.windowMs);
    if (arr.length >= rl.max) {
      rateMap.set(rk, arr);
      return { ok: false, message: '用得太快了，' + (rl.windowMs / 1000) + ' 秒内最多 ' + rl.max + ' 次' };
    }
    arr.push(now); rateMap.set(rk, arr);
    return { ok: true };
  }

  /**
   * 同 key 串行执行（同玩家同逻辑）：后进来的排队等前一个结束。
   * 注意：只对顶层入口用。嵌套调用若也排队，会「内层等外层、外层等内层」死锁（2026-09-15 S2 修复过）。
   */
  async function serialize(qk, fn) {
    const prev = queues.get(qk) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn());
    queues.set(qk, run);
    try { return await run; }
    finally { if (queues.get(qk) === run) queues.delete(qk); }
  }

  return { parseRateLimit, rateLimit, serialize, rateSize: () => rateMap.size, queueSize: () => queues.size };
}

module.exports = { createGuard };
