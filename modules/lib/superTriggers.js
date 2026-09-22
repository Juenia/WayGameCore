/**
 * 超级自定义模块 · TriggerEngine v3（2026-09-18）
 * v2 → v3：`kind` 真正分派 —— 一条逻辑可以有多种触发方式，不再只有指令触发
 *
 *    kind='command'  指令/触发词：exact → prefix(最长优先) → suffix → contains → regex（v2 行为不变）
 *    kind='event'    事件触发：pattern=核心事件名，支持 name / player:* / * 通配
 *    kind='time'     定时触发：pattern=时间表达式（每30秒 / 每天08:00 / 每周一08:00 / 5 段 cron）
 *    kind='manual'   不自动触发：只允许 编辑器 ▶ / HTTP / 被别的逻辑调用（只作函数用）
 *
 * - 数据源：custom_logic_trigger 表；旧字段 custom_logic.trigger 视为 mode='prefix' 兼容
 * - 安全三铁律：只注销自有行（id LIKE 'super_%'）/ 撞车报冲突不覆盖 / 删改保存重同步
 * - 参数 tokenizer：引号感知（"…" '…'）、保留空参数 ""、--k=v 具名参数
 * - is_library=1 的逻辑：不注册任何自动触发（触发词/事件/定时），但 super:<key> 与「调用函数」仍可用
 */
'use strict';

const KINDS = ['command', 'event', 'time', 'manual'];
const COMMAND_MODES = ['exact', 'prefix', 'suffix', 'contains', 'regex'];

// ---------- 参数 tokenizer ----------
function tokenizeArgs(raw) {
  const args = [];
  const named = {};
  const s = String(raw == null ? '' : raw);
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let token = '';
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]; i++;
      while (i < s.length && s[i] !== q) { token += s[i]; i++; }
      i++; // 跳过闭合引号
    } else {
      while (i < s.length && !/\s/.test(s[i])) { token += s[i]; i++; }
    }
    const m = token.match(/^--([A-Za-z0-9_\u4e00-\u9fa5]+)=(.*)$/);
    if (m) named[m[1]] = m[2];
    else args.push(token);
  }
  return { args, named };
}

// ---------- 正则编译缓存 ----------
function compileRegex(pattern) {
  let src = pattern;
  if (/^\/.+\/[a-z]*$/.test(src)) { src = src.slice(1, src.lastIndexOf('/')); }
  return new RegExp(src);
}

/* =====================================================================
 * 时间表达式（kind='time' 的 pattern 语法）
 *   每30秒 / 每 5分钟 / 每2小时 / 每秒 / 每分钟 / 每小时 / 每天
 *   每天08:00 / 每日 8:00 / 每天20点
 *   每周一08:00 / 每星期天 20:30
 *   5 段 cron：分 时 日 月 周     例：0 8 * * 1-5（工作日 8 点）／ 30 20 * * *（每天 20:30）
 * ===================================================================== */
const CN_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const WEEK_CN = { '日': 0, '天': 0, '七': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

/** 中文数字 → 数字（支持 十 / 十二 / 二十 / 二十三 / 三十） */
function cn2num(s) {
  const t = String(s).trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!t) return NaN;
  if (t.indexOf('十') < 0) {
    let n = 0;
    for (const ch of t) { if (CN_DIGIT[ch] === undefined) return NaN; n = n * 10 + CN_DIGIT[ch]; }
    return n;
  }
  const parts = t.split('十');
  const head = parts[0] === '' ? 1 : (CN_DIGIT[parts[0]] === undefined ? NaN : CN_DIGIT[parts[0]]);
  const tailStr = parts[1] || '';
  let tail = 0;
  if (tailStr) {
    if (CN_DIGIT[tailStr[0]] === undefined) return NaN;
    tail = CN_DIGIT[tailStr[0]];
  }
  if (isNaN(head)) return NaN;
  return head * 10 + tail;
}

const UNIT_MS = { '毫秒': 1, 'ms': 1, '秒': 1000, 's': 1000, 'sec': 1000, '分钟': 60000, '分': 60000, 'min': 60000, 'm': 60000, '小时': 3600000, '时': 3600000, 'h': 3600000 };

/** cron 单字段匹配（支持 通配、逗号列表、区间 a-b、步长 body/n 与纯数字） */
function cronFieldMatch(field, value) {
  const f = String(field).trim();
  if (f === '*' || f === '?') return true;
  for (const part of f.split(',')) {
    const p = part.trim();
    let step = 1;
    let body = p;
    const sl = p.indexOf('/');
    if (sl >= 0) { body = p.slice(0, sl); step = Number(p.slice(sl + 1)) || 1; }
    if (body === '*' || body === '') { if (value % step === 0) return true; continue; }
    const dash = body.indexOf('-');
    if (dash > 0) {
      const a = Number(body.slice(0, dash));
      const b = Number(body.slice(dash + 1));
      if (!isNaN(a) && !isNaN(b) && (value - a) % step === 0 && value >= a && value <= b) return true;
      continue;
    }
    const n = Number(body);
    if (!isNaN(n) && n === value) return true;
  }
  return false;
}

/**
 * 解析时间表达式 → 规格对象
 * @returns {{ok:boolean, type?:'interval'|'calendar', intervalMs?:number, fields?:string[], describe?:string, error?:string}}
 */
function parseTimePattern(pattern) {
  const raw = String(pattern == null ? '' : pattern).trim();
  if (!raw) return { ok: false, error: '时间是空的' };
  const s = raw.replace(/\s+/g, '');

  // 0) 固定口语写法（必须先于通用「每N单位」，否则「每小时」会被拆成 小+时）
  if (s === '每秒') return { ok: true, type: 'interval', intervalMs: 1000, describe: '每 1 秒' };
  if (s === '每分钟') return { ok: true, type: 'interval', intervalMs: 60000, describe: '每 60 秒' };
  if (s === '每小时') return { ok: true, type: 'interval', intervalMs: 3600000, describe: '每 3600 秒' };
  if (s === '每天' || s === '每日') return { ok: true, type: 'calendar', fields: ['0', '0', '*', '*', '*'], describe: '每天 00:00' };

  // 1) 每N单位（每30秒 / 每5分钟 / 每2小时）
  let m = s.match(/^每(\d+|[\u4e00-\u9fa5]+?)(毫秒|ms|秒|s|sec|分钟|分|min|m|小时|时|h)$/);
  if (m) {
    const n = cn2num(m[1]);
    const unit = UNIT_MS[m[2]];
    if (isNaN(n) || n <= 0 || !unit) return { ok: false, error: '看不懂的间隔：' + raw };
    const ms = n * unit;
    if (ms < 1000) return { ok: false, error: '间隔不能小于 1 秒（现在是 ' + ms + ' 毫秒）' };
    return { ok: true, type: 'interval', intervalMs: ms, describe: '每 ' + (ms / 1000) + ' 秒' };
  }
  // 2) 每天 HH:MM / 每日 HH 点
  m = s.match(/^每(?:天|日)(?:早上|上午|晚上)?(\d{1,2})[:：点](\d{1,2})?分?$/);
  if (m) {
    const h = Number(m[1]); const mi = m[2] === undefined ? 0 : Number(m[2]);
    if (h > 23 || mi > 59) return { ok: false, error: '时间不合法：' + raw };
    return { ok: true, type: 'calendar', fields: [String(mi), String(h), '*', '*', '*'], describe: '每天 ' + pad2(h) + ':' + pad2(mi) };
  }

  // 3) 每周X HH:MM
  m = s.match(/^每(?:周|星期|礼拜)([一二三四五六日天七\d])(?:早上|上午|晚上)?(\d{1,2})[:：点](\d{1,2})?分?$/);
  if (m) {
    const w = WEEK_CN[m[1]] !== undefined ? WEEK_CN[m[1]] : Number(m[1]);
    const h = Number(m[2]); const mi = m[3] === undefined ? 0 : Number(m[3]);
    if (isNaN(w) || w < 0 || w > 6 || h > 23 || mi > 59) return { ok: false, error: '时间不合法：' + raw };
    return { ok: true, type: 'calendar', fields: [String(mi), String(h), '*', '*', String(w)], describe: '每周' + '日一二三四五六'[w] + ' ' + pad2(h) + ':' + pad2(mi) };
  }

  // 4) 5 段 cron（用原始串切分：s 已去空白，只能判口语写法）
  const seg = raw.split(/\s+/);
  if (seg.length === 5 && seg.every((x) => /^[\d*,/-]+$/.test(x))) {
    return { ok: true, type: 'calendar', fields: seg, describe: 'cron ' + seg.join(' ') };
  }

  return { ok: false, error: '看不懂的时间表达式「' + raw + '」（可写：每30秒 / 每天08:00 / 每周一20:30 / 0 8 * * *）' };
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 当前分钟键（同一分钟只触发一次） */
function cronKeyOf(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
}
/** cron 规格是否命中这一分钟 */
function cronMatch(fields, d) {
  const t = d || new Date();
  return cronFieldMatch(fields[0], t.getMinutes())
    && cronFieldMatch(fields[1], t.getHours())
    && cronFieldMatch(fields[2], t.getDate())
    && cronFieldMatch(fields[3], t.getMonth() + 1)
    && cronFieldMatch(fields[4], t.getDay());
}

/** 事件名匹配：支持 * 与 前缀* */
function eventNameMatch(pattern, name) {
  const p = String(pattern == null ? '' : pattern).trim();
  const n = String(name == null ? '' : name);
  if (!p) return false;
  if (p === '*' ) return true;
  if (p === n) return true;
  if (p.endsWith('*')) return n.startsWith(p.slice(0, -1));
  if (p.startsWith('*')) return n.endsWith(p.slice(1));
  return false;
}

function normalizeMode(m) {
  const v = String(m || 'prefix').toLowerCase();
  return COMMAND_MODES.includes(v) ? v : 'prefix';
}
function normalizeKind(k) {
  const v = String(k || 'command').toLowerCase();
  return KINDS.includes(v) ? v : 'command';
}

function createTriggerEngine(core, deps) {
  const { db } = core;
  const { log } = deps;
  const L = (lv, msg) => { try { log(lv, msg); } catch (e) {} };

  const state = {
    entries: [],          // 内存快照 [{kind, pattern, mode, priority, argMode, key, name, enabled, isLibrary}]
    owned: new Set(),     // 本次同步注册到 doorHandles 的 pattern
    regexCache: new Map(),
    timeCache: new Map(), // pattern -> 解析结果（时间表达式）
    conflicts: [],
  };

  // 读触发词表 + 旧字段兼容（kind 参与快照：一条逻辑可同时挂 指令 / 事件 / 定时）
  async function loadEntries() {
    const rows = await db.all(
      'SELECT t.logic_key AS k, t.kind AS kind, t.pattern AS pattern, t.match_mode AS match_mode, t.priority AS priority,'
      + ' t.arg_mode AS arg_mode, t.enabled AS enabled, l.name AS logic_name, IFNULL(l.is_library,0) AS is_library, IFNULL(l.enabled,1) AS logic_enabled'
      + ' FROM custom_logic_trigger t LEFT JOIN custom_logic l ON l.key = t.logic_key'
      + " WHERE t.enabled = 1 AND (t.pattern IS NOT NULL AND trim(t.pattern) != '')"
      + ' ORDER BY t.priority DESC, t.logic_key ASC', []);
    const map = new Map();
    for (const r of rows) {
      const key = r.k + '|' + r.kind + '|' + r.pattern;
      map.set(key, {
        pattern: r.pattern, kind: normalizeKind(r.kind), mode: normalizeMode(r.match_mode),
        scope: String(r.match_mode || '').toLowerCase(),   // 定时触发用：system(默认) / each(每个在线玩家)
        priority: Number(r.priority) || 100, argMode: r.arg_mode || 'split',
        key: r.k, name: r.logic_name || r.k, enabled: r.enabled !== 0 && r.logic_enabled !== 0,
        isLibrary: Number(r.is_library) === 1,
      });
    }
    // 旧字段兼容：custom_logic.trigger → prefix（表里没有对应行才用）
    const legacy = await db.all("SELECT key, trigger, enabled, name, is_library FROM custom_logic WHERE trigger IS NOT NULL AND trim(trigger) != ''");
    for (const r of legacy) {
      const key = r.key + '|command|' + r.trigger;
      if (map.has(key)) continue;
      map.set(key, {
        pattern: r.trigger, kind: 'command', mode: 'prefix', priority: 100, argMode: 'split',
        key: r.key, name: r.name || r.key, legacy: true, enabled: r.enabled !== 0, isLibrary: Number(r.is_library) === 1,
      });
    }
    return [...map.values()];
  }

  /**
   * 只取指令类（kind='command'）且**不是**「只作函数用」的条目。
   * 2026-09-18 沙盒测试 T07.4 抓到：sync() 里跳过了 isLibrary 的门把手注册，
   * 但兜底匹配 match()（suffix/contains/regex 走这条）没过滤 →
   * 勾了「只作函数用」照样能被打字命中。两处必须同一口径。
   */
  function commandEntries() {
    return state.entries.filter((e) => e.kind === 'command' && !e.isLibrary);
  }

  // 匹配（同步，内存快照）
  function match(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const entries = commandEntries();
    const pick = (list) => list[0] || null;
    // 1 exact
    const exact = entries.filter((e) => e.mode === 'exact' && e.pattern === t).sort((a, b) => b.pattern.length - a.pattern.length || b.priority - a.priority);
    if (exact.length) return hit(pick(exact), t, exact[0].pattern);
    // 2 prefix（最长优先）
    const prefix = entries.filter((e) => (e.mode === 'prefix' || e.mode === 'exact') && t.startsWith(e.pattern) && boundary(t, e.pattern)).sort((a, b) => b.pattern.length - a.pattern.length || b.priority - a.priority);
    if (prefix.length) return hit(pick(prefix), t, prefix[0].pattern);
    // 3 suffix
    const suffix = entries.filter((e) => e.mode === 'suffix' && t.endsWith(e.pattern) && t.length > e.pattern.length).sort((a, b) => b.pattern.length - a.pattern.length || b.priority - a.priority);
    if (suffix.length) return hit(pick(suffix), t, suffix[0].pattern);
    // 4 contains
    const contains = entries.filter((e) => e.mode === 'contains' && t.includes(e.pattern) && t !== e.pattern).sort((a, b) => b.pattern.length - a.pattern.length || b.priority - a.priority);
    if (contains.length) return hit(pick(contains), t, contains[0].pattern);
    // 5 regex
    const regex = entries.filter((e) => e.mode === 'regex').sort((a, b) => b.priority - a.priority);
    for (const e of regex) {
      try {
        let re = state.regexCache.get(e.pattern);
        if (!re) { re = compileRegex(e.pattern); state.regexCache.set(e.pattern, re); }
        const m = t.match(re);
        if (m) return hit(e, t, e.pattern, m);
      } catch (err) { L('warn', '[superTriggers] 正则 ' + e.pattern + ' 编译失败：' + err.message); }
    }
    return null;
  }

  function boundary(text, pattern) {
    const next = text[pattern.length];
    return next === undefined || /\s/.test(next) || next === '：' || next === ':' || next === '，' || next === '。';
  }

  function hit(entry, text, pattern, regexMatch) {
    let rest = '';
    if (entry.mode === 'suffix') rest = text.slice(0, text.length - pattern.length);
    else if (entry.mode === 'contains') { const idx = text.indexOf(pattern); rest = (idx >= 0 ? text.slice(idx + pattern.length) : ''); }
    else if (entry.mode === 'exact') rest = '';
    else rest = text.slice(pattern.length);
    let args = [];
    let named = {};
    if (entry.argMode === 'regex' && regexMatch && regexMatch.groups) {
      for (const [k, v] of Object.entries(regexMatch.groups)) { if (v !== undefined) named[k] = v; }
      args = Object.values(regexMatch.groups).filter((v) => v !== undefined);
    } else {
      const tok = tokenizeArgs(rest);
      args = tok.args; named = tok.named;
    }
    return { key: entry.key, pattern, mode: entry.mode, args, named, source: 'trigger:' + entry.mode };
  }

  /** 事件触发的候选逻辑（按 priority 降序、pattern 由具体到通配） */
  function eventEntries(name) {
    return state.entries
      .filter((e) => e.kind === 'event' && eventNameMatch(e.pattern, name))
      .sort((a, b) => (a.pattern === '*' ? 1 : 0) - (b.pattern === '*' ? 1 : 0) || b.pattern.length - a.pattern.length || b.priority - a.priority);
  }

  /** 定时触发的候选逻辑（解析失败的在 describe 里给出人话错误） */
  function timeEntries() {
    return state.entries.filter((e) => e.kind === 'time');
  }

  function timeSpecOf(pattern) {
    if (!state.timeCache.has(pattern)) state.timeCache.set(pattern, parseTimePattern(pattern));
    return state.timeCache.get(pattern);
  }

  /** 与 custom_commands / doorHandles 的同步（只增删自有行，撞车拒绝） */
  async function sync(registerDoor) {
    state.entries = await loadEntries();
    state.conflicts = [];
    const keep = new Set();

    // 1) 冲突检测：pattern 是否被别的 room / 别的逻辑占用（只有指令类进 doorHandles）
    const seen = new Map();
    const librarySkipped = [];
    for (const e of state.entries) {
      if (e.kind !== 'command') continue;
      if (e.isLibrary) { librarySkipped.push(e); continue; }   // 「只作函数用」：不注册触发词
      if (e.mode === 'suffix' || e.mode === 'contains' || e.mode === 'regex') continue; // 这些不进 doorHandles
      if (seen.has(e.pattern)) {
        state.conflicts.push({ pattern: e.pattern, key: e.key, reason: '触发词「' + e.pattern + '」被逻辑「' + seen.get(e.pattern) + '」占用（' + e.key + ' 未绑定）' });
        continue;
      }
      seen.set(e.pattern, e.key);
      const other = await db.get("SELECT id, room FROM custom_commands WHERE trigger = ? AND id NOT LIKE 'super_%'", [e.pattern]);
      if (other) {
        state.conflicts.push({ pattern: e.pattern, key: e.key, reason: '触发词「' + e.pattern + '」已被系统指令占用（room=' + other.room + '），不覆盖' });
        continue;
      }
      const inMem = (registerDoor && registerDoor.peek ? registerDoor.peek(e.pattern) : null);
      if (inMem && inMem.room && inMem.room !== 'super') {
        state.conflicts.push({ pattern: e.pattern, key: e.key, reason: '触发词「' + e.pattern + '」已被核心内存门把手占用（room=' + inMem.room + '），不覆盖' });
        continue;
      }
      keep.add(e);
    }

    // 2) 注销上次自己写的、这次不再需要的触发词
    for (const old of [...state.owned]) {
      if (![...keep].some((e) => e.pattern === old)) {
        try { await db.run("DELETE FROM custom_commands WHERE trigger = ? AND id LIKE 'super_%'", [old]); } catch (err) {}
        try { if (registerDoor && registerDoor(old, null)) {} } catch (err) {}
        L('info', '[superTriggers] 注销触发词：' + old);
      }
    }

    // 3) 注册新触发词
    const nextOwned = new Set();
    const boundMap = new Map();
    for (const e of keep) {
      try {
        // 清理自己可能残留的同触发词行（id 冲突时按 trigger 更新会写错行）
        await db.run("DELETE FROM custom_commands WHERE trigger = ? AND id LIKE 'super_%'", [e.pattern]);
        await db.setCustomCommand({
          // id 必须带上触发词本身（2026-09-18 沙盒测试 T07/T12 抓到）：
          // 原来只用 'super_' + 逻辑 key，一条逻辑挂多个触发词时后一条会把前一条的行改掉，
          // 内存里的门把手当场是对的、重启核心后前几个词就全不认了。
          id: 'super_' + e.key + '#' + e.pattern,
          trigger: e.pattern,
          aliases: [],
          enabled: e.enabled ? 1 : 0,
          room: 'super',
          logical_name: 'super:invoke',
          template_key: '',
          is_custom: 0,
          description: '自定义逻辑「' + (e.name || e.key) + '」入口',
        });
        if (registerDoor) registerDoor(e.pattern, { room: 'super', door: 'super:invoke', enabled: e.enabled !== 0, description: e.name || e.key, aliases: [], template_key: '' });
        nextOwned.add(e.pattern);
        boundMap.set(e.pattern, e.key);
      } catch (err) {
        state.conflicts.push({ pattern: e.pattern, key: e.key, reason: '注册失败：' + err.message });
      }
    }
    state.owned = nextOwned;
    state.timeCache.clear();
    const counts = { command: 0, event: 0, time: 0, manual: 0 };
    for (const e of state.entries) counts[e.kind] = (counts[e.kind] || 0) + 1;
    return { conflicts: state.conflicts, bound: [...boundMap.entries()], counts, librarySkipped: librarySkipped.map((e) => ({ key: e.key, pattern: e.pattern })) };
  }

  return {
    load: () => state.entries,
    match,
    eventEntries,
    timeEntries,
    timeSpecOf,
    tokenizeArgs,
    sync,
    conflicts: () => state.conflicts,
    clearRegexCache: () => state.regexCache.clear(),
  };
}

module.exports = {
  createTriggerEngine,
  tokenizeArgs,
  parseTimePattern,
  cronMatch,
  cronKeyOf,
  eventNameMatch,
  normalizeKind,
  KINDS,
};
