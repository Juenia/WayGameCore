/**
 * 事件订阅 + 定时调度层（2026-09-18 S2 第七批 · 从 superModule 巨型闭包里搬出的第七层）
 * ------------------------------------------------------------------
 * 事件（kind='event'）：
 *   核心 emit 只传参数不传事件名 → 按触发词表里出现的具体事件名逐个 core.on；
 *   通配写法（player:* / *）展开成 BUILTIN_EVENTS 里匹配的那些名字。
 *   护栏：两条逻辑互相「发出事件」时，每轮都从 depth=0 起步（订阅式重入），
 *         以前会无限往返把核心拖死 → 用「同名事件 1 秒内触发次数」当闸门（超限中断并记账）。
 * 定时（kind='time'）：
 *   语法：每30秒 / 每5分钟 / 每小时 / 每天08:00 / 每周一20:30 / 5 段 cron
 *   范围：scope='system'（默认，无玩家，适合公告/推送）· scope='each'（每个在线玩家各跑一次）
 *   心跳 1 秒一次；间隔式首次见面从当秒起算（不立刻炸）；日历式同一分钟只跑一次。
 * 行为零变更：订阅/退订时机、闸门阈值、到期判定与去重键、输出文案与搬迁前逐字一致。
 */
'use strict';
const C = require('./superConst');
const { BUILTIN_EVENTS } = require('./superEvents');
const { eventNameMatch, cronMatch, cronKeyOf } = require('./superTriggers');

function createSchedule(opts) {
  const o = opts || {};
  const triggers = o.triggers;          // 触发词引擎（load/timeSpecOf/conflicts）
  const invokeLogic = o.invokeLogic;    // (key, opts) => Promise<out>
  const host = o.host;                  // 宿主适配层（log / db / core.on/off/state）

  let eventHandlers = [];               // [{name, fn}] 本次订阅的核心事件（重同步前先 off，防重复叠加）
  const eventGuard = new Map();         // 事件名 -> { n, at }（自环闸门）
  const timeLast = new Map();           // 'key|pattern' -> 上次触发（间隔式=时间戳，日历式=分钟键）
  let timer = null;                     // 定时心跳
  let timeBusy = false;                 // 上一轮定时跑完之前不重复进入
  let autoStarted = false;

  function eventTriggerEntries() {
    // enabled=false 的逻辑（逻辑被禁用 / 触发方式被停用）不参与自动触发：
    // 否则每来一个事件就调一次、每次只换来一条 E_DISABLED，纯噪音。
    return (triggers.load() || []).filter((e) => e.kind === 'event' && !e.isLibrary && e.enabled);
  }

  function eventNamesToWatch() {
    const names = new Set();
    for (const e of eventTriggerEntries()) {
      if (String(e.pattern).indexOf('*') < 0) { names.add(e.pattern); continue; }
      for (const n of BUILTIN_EVENTS) if (eventNameMatch(e.pattern, n)) names.add(n);
    }
    return [...names];
  }

  function resubscribeEvents() {
    for (const h of eventHandlers) { try { host.core.off(h.name, h.fn); } catch (e) {} }
    eventHandlers = [];
    for (const name of eventNamesToWatch()) {
      const fn = (...args) => { dispatchEvent(name, args); };
      host.core.on(name, fn);
      eventHandlers.push({ name, fn });
    }
    return eventHandlers.length;
  }

  /** 事件 → 逻辑：参数1..N = 事件负载（首个字符串视为玩家 ID）；ctx.data.事件.* 另附一份 */
  async function dispatchEvent(name, payload, depth) {
    const nowMs = Date.now();
    const g = eventGuard.get(name) || { n: 0, at: nowMs };
    if (nowMs - g.at > C.EVENT_BURST_WINDOW_MS) { g.n = 0; g.at = nowMs; }
    g.n++;
    eventGuard.set(name, g);
    if (g.n > C.EVENT_BURST_LIMIT) {
      host.log('warn', '[super] 事件「' + name + '」1 秒内被触发 ' + g.n + ' 次，已中断 —— 大概率是两条逻辑用「发出事件」互相触发（自环），检查事件触发方式与「发出事件」块');
      return 0;
    }
    const list = eventTriggerEntries().filter((e) => eventNameMatch(e.pattern, name));
    if (!list.length) return 0;
    const arr = Array.isArray(payload) ? payload.slice() : (payload === undefined ? [] : [payload]);
    const playerId = (typeof arr[0] === 'string') ? arr[0] : '';
    for (const e of list) {
      try {
        await invokeLogic(e.key, { playerId, args: arr, named: {}, source: 'event:' + name, event: { name, args: arr } });
      } catch (err) {
        host.log('error', '[super] 事件「' + name + '」触发逻辑【' + e.key + '】失败：' + err.message);
      }
    }
    return list.length;
  }

  function timeTriggerEntries() {
    return (triggers.load() || []).filter((e) => e.kind === 'time' && !e.isLibrary && e.enabled);
  }

  /** 挑出这一秒到期的定时触发（不执行、不 await，纯同步判定） */
  function pickDueTimes(now, date) {
    const due = [];
    const d = date || new Date(now || Date.now());
    for (const e of timeTriggerEntries()) {
      const spec = triggers.timeSpecOf(e.pattern);
      if (!spec || !spec.ok) continue;
      const mapKey = e.key + '|' + e.pattern;
      if (spec.type === 'interval') {
        if (!timeLast.has(mapKey)) { timeLast.set(mapKey, d.getTime()); continue; }  // 首次见面从这一秒起算，不立刻炸
        const last = timeLast.get(mapKey) || 0;
        if (d.getTime() - last < spec.intervalMs) continue;
        timeLast.set(mapKey, d.getTime());
      } else {
        if (!cronMatch(spec.fields, d)) continue;
        const ck = cronKeyOf(d);
        if (timeLast.get(mapKey) === ck) continue;   // 同一分钟只跑一次
        timeLast.set(mapKey, ck);
      }
      due.push(e);
    }
    return due;
  }

  async function runDueTimes() {
    if (timeBusy) return 0;
    timeBusy = true;
    let n = 0;
    try {
      const due = pickDueTimes(Date.now(), new Date());
      for (const e of due) {
        const each = String(e.scope || '') === 'each';
        const targets = each ? Object.keys(host.core.state.players || {}) : [''];
        for (const pid of targets) {
          try {
            await invokeLogic(e.key, { playerId: pid, args: [], named: {}, source: 'time:' + e.pattern });
            n++;
          } catch (err) {
            host.log('error', '[super] 定时「' + e.pattern + '」触发逻辑【' + e.key + '】失败：' + err.message);
          }
        }
      }
    } finally { timeBusy = false; }
    return n;
  }

  function startAuto() {
    if (!timer) {
      timer = setInterval(() => { runDueTimes().catch(() => {}); }, 1000);
      if (timer.unref) timer.unref();
    }
    autoStarted = true;
    return resubscribeEvents();
  }
  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
    for (const h of eventHandlers) { try { host.core.off(h.name, h.fn); } catch (e) {} }
    eventHandlers = [];
    autoStarted = false;
  }

  /** 可用逻辑清单（给「打了 super: 却不知道有什么」的人看，2026-09-18） */
  async function usableLogicList(limit) {
    try {
      const rows = await host.db.all('SELECT key, name FROM custom_logic WHERE enabled = 1 AND (is_library IS NULL OR is_library = 0) ORDER BY key LIMIT ' + Number(limit || 30));
      if (!rows.length) return '（还没有任何自定义逻辑：在编辑器里新建一条，或者从「模板商店」挑一个）';
      const trs = await host.db.all("SELECT logic_key, pattern FROM custom_logic_trigger WHERE kind = 'command' AND enabled = 1");
      const byKey = {};
      for (const t of trs) { (byKey[t.logic_key] = byKey[t.logic_key] || []).push(t.pattern); }
      return rows.map((r) => '· ' + (r.name || r.key) + '（super:' + r.key + (byKey[r.key] ? '，也可以直接打：' + byKey[r.key].join(' / ') : '') + '）').join('\n');
    } catch (e) { return '（列表读不出来：' + e.message + '）'; }
  }

  /**
   * 触发词同步（2026-09-18 S2 第八批从 superModule 搬入）：
   *   ① 注册/注销门把手（只动自有行，由触发词引擎保证）
   *   ② 冲突与「只作函数用」不再静默 —— 各记一条日志
   *   ③ 事件/定时是常驻订阅：表一变（保存/删除触发词）就重挂
   * @returns 触发词引擎的同步结果（bound/conflicts/librarySkipped）
   */
  async function syncTriggers() {
    const registerDoor = (pattern, info) => {
      if (info === null) { delete host.core.doorHandles[pattern]; }
      else { host.core.doorHandles[pattern] = info; }
    };
    registerDoor.peek = (pattern) => host.core.doorHandles[pattern] || null;
    const res = await triggers.sync(registerDoor);
    // 冲突不再静默（2026-09-17 · BUG 记录 1）：两个逻辑抢同一个触发词时，
    // 输的那个不会绑上触发词，玩家打字只会得到「未知指令」，而日志里一片安静。
    for (const c of (res.conflicts || [])) {
      host.log('warn', '[super] 触发词未绑定：' + c.reason + ' → 逻辑【' + c.key + '】可用 super:' + c.key + ' 直接调用');
    }
    for (const s of (res.librarySkipped || [])) {
      host.log('info', '[super] 逻辑【' + s.key + '】是「只作函数用」，触发词「' + s.pattern + '」不注册（用「调用函数」块或 super:' + s.key + ' 调它）');
    }
    try { resubscribeEvents(); } catch (e) { host.log('warn', '[super] 事件订阅失败：' + e.message); }
    return res;
  }
  /** 触发方式总览（编辑器/自检用）：每条触发词一行，带运行时状态 */
  function describeTriggers() {
    const rows = triggers.load() || [];
    const out = [];
    for (const e of rows) {
      const item = { kind: e.kind, pattern: e.pattern, key: e.key, name: e.name, mode: e.mode, scope: e.scope || '', isLibrary: !!e.isLibrary, status: 'ok', detail: '' };
      if (e.isLibrary) { item.status = 'library'; item.detail = '只作函数用（不自动触发）'; }
      else if (e.kind === 'event') {
        const watched = e.pattern.indexOf('*') < 0 ? [e.pattern] : BUILTIN_EVENTS.filter((n) => eventNameMatch(e.pattern, n));
        item.matchedEvents = watched;
        if (!watched.length) { item.status = 'dead'; item.detail = '没有内核事件叫这个名字（自定义事件需先用「发出事件」块广播）'; }
        else item.detail = '监听 ' + watched.length + ' 个事件：' + watched.slice(0, 4).join('、') + (watched.length > 4 ? '…' : '');
      } else if (e.kind === 'time') {
        const spec = triggers.timeSpecOf(e.pattern);
        if (!spec || !spec.ok) { item.status = 'invalid'; item.detail = spec ? spec.error : '解析失败'; }
        else item.detail = spec.describe + (String(e.scope) === 'each' ? '（每个在线玩家各一次）' : '（系统触发，无玩家）');
      } else if (e.kind === 'command') {
        const conf = (triggers.conflicts() || []).find((c) => c.key === e.key && c.pattern === e.pattern);
        if (conf) { item.status = 'conflict'; item.detail = conf.reason; }
        else if (e.mode === 'suffix' || e.mode === 'contains' || e.mode === 'regex') item.detail = '句' + ({ suffix: '尾', contains: '中', regex: '中' }[e.mode] || '') + '匹配（由 HTTP 兜底命中）';
      } else if (e.kind === 'manual') item.detail = '只手动/被调用';
      out.push(item);
    }
    return out;
  }

  return {
    eventTriggerEntries, eventNamesToWatch, resubscribeEvents, dispatchEvent, syncTriggers,
    timeTriggerEntries, pickDueTimes, runDueTimes, startAuto, stopAuto,
    usableLogicList, describeTriggers,
    stats: () => ({ handlers: eventHandlers.length, timer: !!timer, autoStarted }),
  };
}

module.exports = { createSchedule };