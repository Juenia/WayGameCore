/**
 * 事件模块（活动 / 世界事件）· P0（2026-09-19）
 * =====================================================================
 * 定位（策划视角）：把「做活动」从**写逻辑**变成**填一张表**。
 *   策划配：时间 + 参与条件 + 目标 + 奖励 + 文案；
 *   系统管：按排期开合、广播、记进度、全服里程碑、结算、领奖、归档战报。
 *
 * 为什么单独做一个模块（而不是写进 super 逻辑）：
 *   活动需要「全服进度 / 阶段冻结 / 结算批处理 / 战报」这类**编排**能力，
 *   塞进一条逻辑脚本里就会变得没法观测、没法结算。super 留给一次性小逻辑。
 *
 * 复用的现成能力（不重造）：
 *   事件总线 core.on / emit（含通配符 player:*）、推送 core.push（带 dedupe_key）、
 *   玩家服务 core.services.player.giveItems|giveCurrency（targets 批量）、
 *   模板 core.registerModule + core.renderTemplate、心跳 setInterval（照抄 superSchedule）。
 *
 * 硬约束：**核心三件一行不改**（GameSystem / databaseModule / regression_all）。
 *   全部挂在模块层；表用 CREATE TABLE IF NOT EXISTS 自建（照 questModule / skillModule 的先例）。
 *
 * P0 支持的活动类型：
 *   · hunt  限时讨伐：击杀指定怪物 N 次（事件驱动）
 *   · daily 每日活跃：当天第一次有动作就算参与并达成（核心没有「登录」事件，
 *           所以用 player:* 通配符把「当天第一次动作」当登录信号，见 onAnyPlayerActivity）
 *
 * 排期 schedule_json：
 *   { kind: 'once',   start: '2026-09-20T18:00:00', end: '2026-09-22T23:59:59' }
 *   { kind: 'daily',  from: '20:00', to: '21:00' }                       // 本地时间，可跨零点
 *   { kind: 'weekly', from: { dow: 5, time: '18:00' }, to: { dow: 0, time: '23:59' } }  // 5=周五
 *
 * 队伍口径：所有时间判断都走**本地时区**（和主人看到的一致），落库统一 ISO UTC 字符串。
 */
'use strict';

async function eventModule(core) {
  const db = core.db;
  const log = (lvl, msg) => { try { core.log(lvl, '[event] ' + msg); } catch (e) {} };
  log('info', '正在加载事件（活动）模块...');

  const TICK_MS = 1000;
  let timer = null;
  let tickBusy = false;
  let defCache = [];

  /* ==================================================================
   * 1. 建表（IF NOT EXISTS：不碰任何既有表）
   * ================================================================== */
  async function initSchema() {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS event_def (
        key TEXT PRIMARY KEY,
        name TEXT DEFAULT '',
        category TEXT DEFAULT 'hunt',
        schedule_json TEXT DEFAULT '{}',
        preview_min INTEGER DEFAULT 0,
        claim_window_min INTEGER DEFAULT 0,
        auto_grant INTEGER DEFAULT 1,
        late_grant INTEGER DEFAULT 1,
        requirements_json TEXT DEFAULT '[]',
        objectives_json TEXT DEFAULT '[]',
        rewards_json TEXT DEFAULT '{}',
        caps_json TEXT DEFAULT '{}',
        announce_json TEXT DEFAULT '{}',
        bonus_json TEXT DEFAULT '{}',      -- 收益加成配置：{"exp_mult":2,"currency":{"货币1":2}}
        enabled INTEGER DEFAULT 1,
        description TEXT DEFAULT '',
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL,
        period_key TEXT NOT NULL,
        title TEXT DEFAULT '',
        start_at TEXT, end_at TEXT, claim_until TEXT,
        status TEXT DEFAULT 'preview',
        report_json TEXT DEFAULT '',
        created_at TEXT, updated_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_period ON event(event_key, period_key);
      CREATE INDEX IF NOT EXISTS idx_event_status ON event(status);
      CREATE TABLE IF NOT EXISTS event_progress (
        event_id INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        progress_json TEXT DEFAULT '[]',
        completed_at TEXT,
        claimed_at TEXT,
        granted_json TEXT DEFAULT '',
        joined_at TEXT,
        updated_at TEXT,
        PRIMARY KEY (event_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS idx_event_progress_player ON event_progress(player_id);
      CREATE TABLE IF NOT EXISTS event_global (
        event_id INTEGER NOT NULL,
        objective_index INTEGER NOT NULL,
        value REAL DEFAULT 0,
        milestones_fired_json TEXT DEFAULT '[]',
        updated_at TEXT,
        PRIMARY KEY (event_id, objective_index)
      );
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER, event_key TEXT, player_id TEXT,
        action TEXT, detail TEXT, created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_event_log_event ON event_log(event_id);
      -- 事件链（活动触发活动，2026-09-20）：记「哪一期的第几条规则已经触发过」。
      -- 期号(event_id) 本身就带了 period_key，所以这张表天然是「每期每规则只触发一次」的幂等凭据 ——
      -- tick 每秒都在重扫、同一条规则会被多个入口（开启/结算/归档/达标/里程碑）碰到，没有它就会重复开下游。
      CREATE TABLE IF NOT EXISTS event_chain_fire (
        event_id INTEGER NOT NULL,
        rule_index INTEGER NOT NULL,
        sub_key TEXT NOT NULL DEFAULT '',    -- 里程碑下标 / 玩家 id；空 = 整期只触发一次
        trigger_on TEXT DEFAULT '',
        target_key TEXT DEFAULT '',
        action TEXT DEFAULT '',
        ok INTEGER DEFAULT 1,
        detail TEXT DEFAULT '',
        fired_at TEXT,
        PRIMARY KEY (event_id, rule_index, sub_key)
      );
      CREATE INDEX IF NOT EXISTS idx_event_chain_target ON event_chain_fire(target_key);
    `);
    // 迁移守卫：老库（这一列还没有时）补上，照 professionModule 的先例
    try {
      let cols = await db.all('PRAGMA table_info(event_def)');
      if (!cols.some((c) => c.name === 'late_grant')) {
        await db.exec('ALTER TABLE event_def ADD COLUMN late_grant INTEGER DEFAULT 1');
        cols = await db.all('PRAGMA table_info(event_def)');
      }
      if (!cols.some((c) => c.name === 'bonus_json')) {
        // 注意别和 event_progress.bonus_json 搞混：
        //   event_def.bonus_json      = 本期给玩家的加成**配置**（经验/货币倍数）
        //   event_progress.bonus_json = 我们**实际加了多少**（收尾时要精确减掉这一份）
        await db.exec("ALTER TABLE event_def ADD COLUMN bonus_json TEXT DEFAULT '{}'");
      }
      if (!cols.some((c) => c.name === 'chain_json')) {
        // 事件链配置（活动触发活动）：数组，一条规则一段；见下面第 8.5 节
        await db.exec("ALTER TABLE event_def ADD COLUMN chain_json TEXT DEFAULT '[]'");
      }
      // 收益加成（2026-09-19）：活动可以给参与者临时加成（经验/货币），
      // 这里记下「我们到底给谁加了多少」——收尾时必须精确还原，不能把套装等其它来源的加成一起抹掉。
      const pcols = await db.all('PRAGMA table_info(event_progress)');
      if (!pcols.some((c) => c.name === 'bonus_json')) await db.exec("ALTER TABLE event_progress ADD COLUMN bonus_json TEXT DEFAULT ''");
      if (!pcols.some((c) => c.name === 'bonus_at')) await db.exec('ALTER TABLE event_progress ADD COLUMN bonus_at TEXT');
      if (!pcols.some((c) => c.name === 'bonus_released_at')) await db.exec('ALTER TABLE event_progress ADD COLUMN bonus_released_at TEXT');
    } catch (e) { log('warn', '活动表迁移检查失败：' + e.message); }
  }

  /* ==================================================================
   * 2. 排期计算（纯函数，方便用假时间测）
   * ================================================================== */
  const pad2 = (n) => (n < 10 ? '0' + n : String(n));
  const localKey = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const iso = (d) => new Date(d).toISOString();

  /** 在 base 那天的 HH:MM（本地） */
  function atLocal(base, hhmm) {
    const [h, m] = String(hhmm || '00:00').split(':').map((x) => parseInt(x, 10) || 0);
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0);
    return d;
  }

  /**
   * 算出「当前该关注的那一期」窗口。
   * 返回 { start, end, periodKey } 或 null（配置坏了）。
   * 口径：优先返回「正在进行 / 还没结束」的那一期；没有则返回「今天/本周将要开始的那一期」。
   */
  function windowFor(schedule, now) {
    const s = typeof schedule === 'string' ? safeJson(schedule, {}) : (schedule || {});
    const kind = String(s.kind || 'once');
    const nowD = new Date(now);
    if (kind === 'once') {
      const a = s.start ? new Date(s.start) : null, b = s.end ? new Date(s.end) : null;
      if (!a || !b || isNaN(a.getTime()) || isNaN(b.getTime())) return null;
      return { start: a, end: b, periodKey: 'once' };
    }
    if (kind === 'daily') {
      const start = atLocal(nowD, s.from || '00:00');
      let end = atLocal(nowD, s.to || '23:59');
      if (end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000);   // 跨零点
      if (nowD > end) {                                                     // 今天那期已经结束 → 看明天
        const n = new Date(nowD.getTime() + 24 * 3600 * 1000);
        const s2 = atLocal(n, s.from || '00:00');
        let e2 = atLocal(n, s.to || '23:59');
        if (e2 <= s2) e2 = new Date(e2.getTime() + 24 * 3600 * 1000);
        return { start: s2, end: e2, periodKey: localKey(s2) };
      }
      return { start, end, periodKey: localKey(start) };
    }
    if (kind === 'weekly') {
      const f = s.from || {}, t = s.to || {};
      const fromDow = ((parseInt(f.dow, 10) % 7) + 7) % 7;
      const toDow = ((parseInt(t.dow, 10) % 7) + 7) % 7;
      // 从今天起往后找 14 天，取第一个「刚开始或还没结束」的窗口
      for (let i = -7; i <= 14; i++) {
        const day = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + i);
        if (day.getDay() !== fromDow) continue;
        const start = atLocal(day, f.time || '00:00');
        let endDay = new Date(day.getFullYear(), day.getMonth(), day.getDate());
        let delta = (toDow - fromDow + 7) % 7;
        endDay = new Date(endDay.getTime() + delta * 24 * 3600 * 1000);
        let end = atLocal(endDay, t.time || '23:59');
        if (end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000);
        if (nowD <= end) return { start, end, periodKey: localKey(start) + '#' + fromDow };
      }
      return null;
    }
    return null;
  }

  function safeJson(s, dflt) {
    if (s === null || s === undefined || s === '') return dflt;
    if (typeof s !== 'string') return s;
    try { const v = JSON.parse(s); return v === null || v === undefined ? dflt : v; } catch (e) { return dflt; }
  }
  const arrOf = (s) => { const v = safeJson(s, []); return Array.isArray(v) ? v : []; };
  const objOf = (s) => { const v = safeJson(s, {}); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; };

  /* ==================================================================
   * 3. 定义 / 实例
   * ================================================================== */
  let objTypes = new Set();      // 已配置的目标类型（内存短路用，见 onEnemyKilled / onAnyPlayerActivity）
  async function loadDefs() {
    try {
      const rows = await db.all('SELECT * FROM event_def WHERE enabled = 1');
      defCache = rows || [];
      const types = new Set();
      for (const d of defCache) for (const o of arrOf(d.objectives_json)) types.add(String(o.type || ''));
      objTypes = types;
    } catch (e) { defCache = []; objTypes = new Set(); log('warn', '读活动定义失败：' + e.message); }
    return defCache;
  }
  const hasObjectiveType = (t) => objTypes.has(t);
  const findDef = (key) => defCache.find((d) => String(d.key) === String(key)) || null;

  async function getInstance(eventKey, periodKey) {
    return await db.get('SELECT * FROM event WHERE event_key = ? AND period_key = ?', [eventKey, periodKey]);
  }
  async function activeInstances() {
    try { return await db.all("SELECT * FROM event WHERE status IN ('preview','running','settling','claiming') ORDER BY id"); }
    catch (e) { return []; }
  }

  /** 按排期把「该开的」实例建出来（幂等：靠 (event_key, period_key) 唯一索引） */
  async function materializeDue(now) {
    const made = [];
    for (const def of defCache) {
      let win = null;
      try { win = windowFor(def.schedule_json, now); } catch (e) { win = null; }
      if (!win) { log('warn', '活动「' + def.key + '」排期算不出来，跳过：' + String(def.schedule_json).slice(0, 60)); continue; }
      const previewLead = (parseInt(def.preview_min, 10) || 0) * 60 * 1000;
      const nowMs = new Date(now).getTime();
      if (nowMs < win.start.getTime() - previewLead) continue;      // 还没到预告时间
      const claimMs = (parseInt(def.claim_window_min, 10) || 0) * 60 * 1000;
      if (nowMs > win.end.getTime() + claimMs) continue;            // 这一期连领奖期都过了
      const exist = await getInstance(def.key, win.periodKey);
      if (exist) continue;
      // 只挡「**链开的那一期**」（2026-09-20，事件链带来的约束）：
      // 链可能已经把下游提前开起来了，这时排期那期不该再开一个并行的 —— 否则玩家会在
      // 「活动列表」里看到两条同名活动、进度还各算各的。只挡 preview/running，
      // 领奖期（claiming）是「上一期还没领完」，不该占住下一期的名额。
      // ★ 条件里的 period_key LIKE 'chain-%' 不能省：排期期彼此本来就是顺序的
      //   （periodKey 按日期/一次性算，天然不并行），写成「任何在跑的一期都挡」会连排期自己
      //   都建不出来 —— verify-event-system.js 的「每日活跃」用真实时间推一拍
      //   （tickAt(new Date())）开今天这期，只要假时间那一轮先建过一期，今天这期就被挡死，
      //   测试直接红（2026-09-20 真实踩到）。
      const live = await db.get("SELECT id FROM event WHERE event_key = ? AND status IN ('preview','running') AND period_key LIKE 'chain-%' LIMIT 1", [def.key]);
      if (live) {
        log('info', '活动「' + def.key + '」已有链开的一期在跑（#' + live.id + '），本期排期不再另开');
        continue;
      }
      // 一律先建成 preview，由 tick 的状态机统一「开」——
      // 这样开服播报、open 留痕只有一条路径（否则到点后才建实例的那次会跳过播报）
      await db.run(
        "INSERT INTO event (event_key, period_key, title, start_at, end_at, claim_until, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [def.key, win.periodKey, def.name || def.key, iso(win.start), iso(win.end), iso(new Date(win.end.getTime() + claimMs)),
          'preview', iso(new Date(now)), iso(new Date(now))]
      );
      const fresh = await getInstance(def.key, win.periodKey);
      made.push(fresh);
      await writeLog(fresh.id, def.key, '', 'create', 'period=' + win.periodKey);
      log('info', '活动「' + def.key + '」第 ' + win.periodKey + ' 期已建立（' + iso(win.start) + ' → ' + iso(win.end) + '）');
    }
    return made;
  }

  async function writeLog(eventId, eventKey, playerId, action, detail) {
    try {
      await db.run('INSERT INTO event_log (event_id, event_key, player_id, action, detail, created_at) VALUES (?,?,?,?,?,?)',
        [eventId || null, eventKey || '', playerId || '', action || '', String(detail == null ? '' : detail).slice(0, 400), iso(new Date())]);
    } catch (e) { /* 日志失败不影响主流程 */ }
  }

  /* ==================================================================
   * 4. 参与条件
   * ================================================================== */
  /** 返回 [] = 可以参加；否则返回人话原因列表 */
  async function checkRequirements(def, playerId) {
    const reqs = arrOf(def.requirements_json);
    const bad = [];
    if (!reqs.length) return bad;
    const player = await core.services.player.get(playerId);
    if (!player) return ['玩家不存在'];
    for (const r of reqs) {
      const type = String(r.type || '');
      if (type === 'level') {
        if (Number(player.等级 || 0) < Number(r.min || 0)) bad.push('等级不够（需要 ' + r.min + ' 级，你 ' + (player.等级 || 0) + ' 级）');
      } else if (type === 'profession') {
        const list = Array.isArray(r.values) ? r.values.map(String) : [];
        if (list.length && list.indexOf(String(player.职业途径 || '')) < 0) bad.push('职业不符合（需要 ' + list.join('/') + '）');
      } else if (type === 'has_item') {
        const bag = objOf(player.背包) || {};
        const have = Number((player.背包 && player.背包[r.name]) || 0);
        if (have < Number(r.count || 1)) bad.push('缺少道具「' + r.name + '」×' + (r.count || 1) + '（你有 ' + have + '）');
      } else if (type === 'quest') {
        const done = Array.isArray(player.已完成任务) ? player.已完成任务 : [];
        if (done.indexOf(String(r.name)) < 0) bad.push('需要先完成「' + r.name + '」');
      }
    }
    return bad;
  }

  /* ==================================================================
   * 5. 进度 / 奖励 / 结算 / 领奖 / 归档
   * ================================================================== */
  /**
   * 进程内串行锁（2026-09-19）
   * ------------------------------------------------------------------
   * 为什么需要：进度和全服计数都是「读出来 → 加一下 → 写回去」。
   * 两个玩家几乎同时击杀时，两次读到的都是旧值 → 里程碑会被**播报两次**
   *（实测：全服目标 3 次击杀，里程碑只该响 2 次，却写了 3 条日志）。
   * 核心是单进程，所以一把按 key 的串行锁就够，不引入事务复杂度。
   */
  const locks = new Map();
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn).catch((e) => { log('warn', '锁内出错：' + (e && e.message)); });
    locks.set(key, next);
    next.then(() => { if (locks.get(key) === next) locks.delete(key); });
    return next;
  }
  async function getProgress(eventId, playerId) {
    return await db.get('SELECT * FROM event_progress WHERE event_id = ? AND player_id = ?', [eventId, playerId]);
  }

  /** 参与登记（幂等）。返回 {joined:boolean, progress} */
  async function join(inst, playerId, def, reason) {
    const cur = await getProgress(inst.id, playerId);
    if (cur) return { joined: false, progress: cur };
    const objectives = arrOf(def.objectives_json);
    const zeros = objectives.map(() => 0);
    await db.run('INSERT OR IGNORE INTO event_progress (event_id, player_id, progress_json, joined_at, updated_at) VALUES (?,?,?,?,?)',
      [inst.id, playerId, JSON.stringify(zeros), iso(new Date()), iso(new Date())]);
    await writeLog(inst.id, inst.event_key, playerId, 'join', reason || '');
    return { joined: true, progress: await getProgress(inst.id, playerId) };
  }

  /** 推进进度（按目标下标累加），并在达标时置 completed_at */
  async function addProgress(inst, playerId, def, objectiveIndex, delta, detail) {
    return await withLock('p:' + inst.id + ':' + playerId, async () => {
      const row = await getProgress(inst.id, playerId);
      if (!row) return null;
      const objectives = arrOf(def.objectives_json);
      const obj = objectives[objectiveIndex];
      if (!obj) return null;
      const prog = arrOf(row.progress_json);
      while (prog.length < objectives.length) prog.push(0);
      const target = Number(obj.count || 1);
      // 进度封顶在目标值：达标后再打也不会变成 3/1（显示难看，也没意义）
      prog[objectiveIndex] = Math.min(target, Number(prog[objectiveIndex] || 0) + Number(delta || 0));
      const reached = Number(prog[objectiveIndex]) >= target;
      const justCompleted = reached && !row.completed_at;
      await db.run('UPDATE event_progress SET progress_json = ?, completed_at = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
        [JSON.stringify(prog), justCompleted ? iso(new Date()) : row.completed_at, iso(new Date()), inst.id, playerId]);
      await writeLog(inst.id, inst.event_key, playerId, 'progress', 'obj' + objectiveIndex + ' +' + delta + ' → ' + prog[objectiveIndex] + '/' + target + (detail ? (' ' + detail) : ''));
      return { progress: prog, reached, justCompleted };
    });
  }

  /** 全服目标累加 + 里程碑播报 */
  async function addGlobal(inst, def, objectiveIndex, delta) {
    return await withLock('g:' + inst.id + ':' + objectiveIndex, async () => {
    const obj = arrOf(def.objectives_json)[objectiveIndex];
    if (!obj) return null;
    await db.run('INSERT OR IGNORE INTO event_global (event_id, objective_index, value, milestones_fired_json, updated_at) VALUES (?,?,?,?,?)',
      [inst.id, objectiveIndex, 0, '[]', iso(new Date())]);
    const row = await db.get('SELECT * FROM event_global WHERE event_id = ? AND objective_index = ?', [inst.id, objectiveIndex]);
    const value = Number(row.value || 0) + Number(delta || 0);
    const fired = arrOf(row.milestones_fired_json);
    const milestones = Array.isArray(obj.milestones) ? obj.milestones : [];
    const newly = [];
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i] || {};
      const at = Number(m.at || 0);
      if (at > 0 && value >= at && fired.indexOf(i) < 0) { fired.push(i); newly.push({ index: i, m }); }
    }
    await db.run('UPDATE event_global SET value = ?, milestones_fired_json = ?, updated_at = ? WHERE event_id = ? AND objective_index = ?',
      [value, JSON.stringify(fired), iso(new Date()), inst.id, objectiveIndex]);
    for (const n of newly) {
      await announce(inst, def, n.m.template_key || 'event:milestone', {
        活动: inst.title, 里程碑: String(n.m.at), 全服进度: String(value), 说明: n.m.text || ''
      }, null, 'mile' + objectiveIndex + '_' + n.index);
      await writeLog(inst.id, inst.event_key, '', 'milestone', 'obj' + objectiveIndex + ' at=' + n.m.at + ' value=' + value);
    }
    return { value, newly };
    });
  }

  function pickRewards(def, completedRatio) {
    const rw = objOf(def.rewards_json);
    const out = [];
    for (const r of (Array.isArray(rw.fixed) ? rw.fixed : [])) out.push(r);
    const pool = Array.isArray(rw.random) ? rw.random : [];
    if (pool.length) {
      const total = pool.reduce((n, r) => n + Number(r.weight || 0), 0);
      if (total > 0) {
        let roll = Math.random() * total;
        for (const r of pool) { roll -= Number(r.weight || 0); if (roll <= 0) { out.push(r); break; } }
      }
    }
    const byProgress = Array.isArray(rw.by_progress) ? rw.by_progress : [];
    for (const tier of byProgress) {
      if (completedRatio >= Number(tier.at || 0)) for (const r of (tier.rewards || [])) out.push(r);
    }
    return out;
  }

  /* ==================================================================
   * 5b. 收益加成（经验 / 货币）—— 纯增量，不碰战斗模块
   * ==================================================================
   * combatModule 早就有两个扩展点（战斗里按它们算收益）：
   *   player._expMultiplierBonus        —— 数值，1 表示 +100%（＝双倍）
   *   player._currencyMultiplierBonuses —— {货币字段: 数值}
   * 装备套装就是走这条路加的（equipmentSetModule:244/249）。所以活动只要在运行期
   * 把这两个字段给参与者设上、结束再收回，就实现了「周末双倍经验/双倍货币」——
   * 一行都不用改战斗模块，也不碰核心。
   *
   * 两条安全规矩：
   *   ① 只取较大值：玩家身上已经有更大的加成（比如套装 +200%）时，绝不被活动降级；
   *   ② 精确还原：只减掉「我们加的那一份」，不动别人的来源。
   */
  function bonusOf(def) {
    const b = objOf(def.bonus_json);
    const exp = Number(b.exp_mult) > 1 ? Number(b.exp_mult) : 0;
    const cur = {};
    const raw = (b.currency && typeof b.currency === 'object') ? b.currency : {};
    for (const k of Object.keys(raw)) { const v = Number(raw[k]); if (v > 1) cur[k] = v; }
    return { exp, cur, any: exp > 1 || Object.keys(cur).length > 0 };
  }
  function bonusText(def) {
    const b = bonusOf(def);
    const parts = [];
    if (b.exp > 1) parts.push('经验 ×' + b.exp);
    for (const k of Object.keys(b.cur)) parts.push(k + ' ×' + b.cur[k]);
    return parts.length ? parts.join('、') : '';
  }

  /** 给参与者加上本期加成（幂等：已经加过就跳过） */
  async function applyBonus(inst, def, playerId) {
    const b = bonusOf(def);
    if (!b.any) return { applied: false };
    const row = await getProgress(inst.id, playerId);
    if (!row) return { applied: false };
    if (row.bonus_json && row.bonus_json !== '') return { applied: false };   // 本期已经加过了
    let player = null;
    try { player = await core.services.player.get(playerId); } catch (e) { player = null; }
    if (!player) return { applied: false };
    const add = {};       // 只记「我们加的增量」
    const changes = {};
    if (b.exp > 1) {
      const mine = b.exp - 1;
      const cur = Number(player._expMultiplierBonus || 0);
      // 注意：core 的 modify 对**纯数字**是按 delta 加的（GameSystem.js:123-125），
      // 要"设成某个值"必须显式写 { set: ... } —— 第一版直接写数字，等于在别人加成上又加一份。
      if (cur < mine) { changes._expMultiplierBonus = { set: mine }; add.exp = mine; }
      else add.exp = 0;                                  // 已有更大的：不加，也不记
    }
    if (Object.keys(b.cur).length) {
      const mineCur = {};
      const curMap = (player._currencyMultiplierBonuses && typeof player._currencyMultiplierBonuses === 'object') ? player._currencyMultiplierBonuses : {};
      const nextMap = Object.assign({}, curMap);
      for (const k of Object.keys(b.cur)) {
        const mine = b.cur[k] - 1;
        const has = Number(curMap[k] || 0);
        if (has < mine) { nextMap[k] = mine; mineCur[k] = mine; }
        else mineCur[k] = 0;
      }
      if (Object.keys(mineCur).some((k) => mineCur[k] > 0)) {
        changes._currencyMultiplierBonuses = nextMap;
        add.cur = mineCur;
      }
    }
    if (!Object.keys(changes).length) return { applied: false };
    try {
      await core.services.player.modify({ playerId, changes, source: 'event:' + inst.event_key + ':bonus' });
    } catch (e) { log('warn', '加收益加成失败 ' + playerId + '：' + e.message); return { applied: false }; }
    await db.run('UPDATE event_progress SET bonus_json = ?, bonus_at = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
      [JSON.stringify(add), iso(new Date()), iso(new Date()), inst.id, playerId]);
    await writeLog(inst.id, inst.event_key, playerId, 'bonus_on', JSON.stringify(add));
    return { applied: true, add };
  }

  /** 收回我们加的那一份（精确减法；被别人改过也不至于变负） */
  async function releaseBonus(inst, playerId) {
    const row = await getProgress(inst.id, playerId);
    if (!row || !row.bonus_json || row.bonus_json === '') return { released: false };
    if (row.bonus_released_at) return { released: false };
    const add = objOf(row.bonus_json);
    let player = null;
    try { player = await core.services.player.get(playerId); } catch (e) { player = null; }
    if (!player) {   // 人不在（被删了）：只做标记，免得每拍重试
      await db.run('UPDATE event_progress SET bonus_released_at = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
        [iso(new Date()), iso(new Date()), inst.id, playerId]);
      return { released: false, missing: true };
    }
    const changes = {};
    if (Number(add.exp || 0) > 0) changes._expMultiplierBonus = { set: Math.max(0, Number(player._expMultiplierBonus || 0) - Number(add.exp)) };
    const addCur = (add.cur && typeof add.cur === 'object') ? add.cur : {};
    if (Object.keys(addCur).length) {
      const curMap = Object.assign({}, (player._currencyMultiplierBonuses && typeof player._currencyMultiplierBonuses === 'object') ? player._currencyMultiplierBonuses : {});
      for (const k of Object.keys(addCur)) {
        const v = Math.max(0, Number(curMap[k] || 0) - Number(addCur[k] || 0));
        if (v > 0) curMap[k] = v; else delete curMap[k];
      }
      changes._currencyMultiplierBonuses = curMap;
    }
    if (Object.keys(changes).length) {
      try { await core.services.player.modify({ playerId, changes, source: 'event:' + inst.event_key + ':bonus_off' }); }
      catch (e) { log('warn', '收收益加成失败 ' + playerId + '：' + e.message); return { released: false }; }
    }
    await db.run('UPDATE event_progress SET bonus_released_at = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
      [iso(new Date()), iso(new Date()), inst.id, playerId]);
    await writeLog(inst.id, inst.event_key, playerId, 'bonus_off', JSON.stringify(add));
    return { released: true };
  }

  /** 把一期里所有还挂着的加成收回来（结算/归档/孤儿清理都走它） */
  async function releaseAllBonuses(inst) {
    let n = 0;
    try {
      const rows = await db.all("SELECT player_id FROM event_progress WHERE event_id = ? AND bonus_json <> '' AND bonus_released_at IS NULL", [inst.id]);
      for (const r of rows) { const ok = await releaseBonus(inst, r.player_id); if (ok.released) n++; }
    } catch (e) { log('warn', '批量收加成出错：' + e.message); }
    return n;
  }

  async function grant(inst, playerId, rewards, tag) {
    const items = [], currencies = [];
    for (const r of rewards) {
      const type = String(r.type || '');
      if (type === 'item') items.push({ name: r.name, count: Number(r.count || 1) });
      else if (type === 'currency') currencies.push({ field: r.field || '货币1', amount: Number(r.amount || 0) });
    }
    const done = [];
    try {
      if (items.length) {
        const res = await core.services.player.giveItems({ targets: [playerId], items, source: tag });
        done.push(...items.map((i) => ({ type: 'item', name: i.name, count: i.count, ok: !(res && res.success === false) })));
      }
      for (const c of currencies) {
        const res = await core.services.player.giveCurrency({ targets: [playerId], field: c.field, amount: c.amount, source: tag });
        done.push({ type: 'currency', field: c.field, amount: c.amount, ok: !(res && res.success === false) });
      }
    } catch (e) { log('warn', '发放失败 ' + playerId + '：' + e.message); }
    return done;
  }

  /** 结算：冻结进度、判定达标、按配置发放或进入领奖期 */
  async function settle(inst, def, now) {
    const rows = await db.all('SELECT * FROM event_progress WHERE event_id = ?', [inst.id]);
    const objectives = arrOf(def.objectives_json);
    const personalIdx = [];
    objectives.forEach((o, i) => { if (String(o.scope || 'personal') !== 'global') personalIdx.push(i); });
    const autoGrant = Number(def.auto_grant === 0 || def.auto_grant === '0') ? 0 : 1;
    let completed = 0, granted = 0;
    for (const row of rows) {
      const prog = arrOf(row.progress_json);
      const ok = personalIdx.every((i) => Number(prog[i] || 0) >= Number(objectives[i].count || 1));
      if (!ok) continue;
      completed++;
      if (autoGrant) {
        const rewards = pickRewards(def, 1);
        const done = await grant(inst, row.player_id, rewards, 'event:' + inst.event_key + ':settle');
        await db.run('UPDATE event_progress SET claimed_at = ?, granted_json = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
          [iso(new Date(now)), JSON.stringify(done), iso(new Date(now)), inst.id, row.player_id]);
        await writeLog(inst.id, inst.event_key, row.player_id, 'grant_auto', JSON.stringify(done).slice(0, 300));
        granted++;
      } else {
        await db.run('UPDATE event_progress SET updated_at = ? WHERE event_id = ? AND player_id = ?', [iso(new Date(now)), inst.id, row.player_id]);
      }
    }
    const nextStatus = autoGrant ? 'archived' : 'claiming';
    await db.run('UPDATE event SET status = ?, updated_at = ? WHERE id = ?', [nextStatus, iso(new Date(now)), inst.id]);
    const joined = rows.length;
    const report = { joined, completed, granted, objectives: objectives.length, claimWindowMin: parseInt(def.claim_window_min, 10) || 0, at: iso(new Date(now)) };
    await db.run('UPDATE event SET report_json = ? WHERE id = ?', [JSON.stringify(report), inst.id]);
    await writeLog(inst.id, inst.event_key, '', 'settle', JSON.stringify(report));
    log('info', '活动「' + inst.event_key + '」结算：参与 ' + joined + ' · 达标 ' + completed + ' · 已发 ' + granted);
    if (nextStatus === 'claiming') {
      await announce(inst, def, 'event:settle_claim', { 活动: inst.title, 达标人数: String(completed), 领奖截止: String(inst.claim_until || '') }, rows.map((r) => r.player_id), 'settle');
    } else {
      await announce(inst, def, 'event:settle_done', { 活动: inst.title, 达标人数: String(completed), 发放人数: String(granted) }, rows.map((r) => r.player_id), 'settle');
    }
    enqueueChain(inst, 'settle', { depth: 0, path: [], now });   // 事件链触发源②：活动结算
    return report;
  }

  /** 领奖（领奖期内手动领；过期由心跳 auto_grant 补发） */
  async function claim(inst, def, playerId) {
    const row = await getProgress(inst.id, playerId);
    if (!row) return { ok: false, reason: '你没有参加这个活动' };
    if (row.claimed_at) return { ok: false, reason: '你已经领过了' };
    const objectives = arrOf(def.objectives_json);
    const prog = arrOf(row.progress_json);
    const okAll = objectives.every((o, i) => String(o.scope || 'personal') === 'global' || Number(prog[i] || 0) >= Number(o.count || 1));
    if (!okAll) return { ok: false, reason: '目标还没达成' };
    const rewards = pickRewards(def, 1);
    const done = await grant(inst, playerId, rewards, 'event:' + inst.event_key + ':claim');
    await db.run('UPDATE event_progress SET claimed_at = ?, granted_json = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
      [iso(new Date()), JSON.stringify(done), iso(new Date()), inst.id, playerId]);
    await writeLog(inst.id, inst.event_key, playerId, 'claim', JSON.stringify(done).slice(0, 300));
    return { ok: true, rewards: done };
  }

  /** 归档：出战报、清掉过程中的临时状态 */
  async function archive(inst, now) {
    await releaseAllBonuses(inst);          // 活动结束：把我们加过的收益加成全部收回（精确减法）
    const rows = await db.all('SELECT * FROM event_progress WHERE event_id = ?', [inst.id]);
    const joined = rows.length;
    const completed = rows.filter((r) => r.completed_at).length;
    const claimed = rows.filter((r) => r.claimed_at).length;
    const granted = rows.filter((r) => r.granted_json).length;
    const report = { joined, completed, claimed, granted, at: iso(new Date(now)) };
    await db.run("UPDATE event SET status = 'archived', report_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(report), iso(new Date(now)), inst.id]);
    await writeLog(inst.id, inst.event_key, '', 'archive', JSON.stringify(report));
    log('info', '活动「' + inst.event_key + '」归档战报：参与 ' + joined + ' · 达标 ' + completed + ' · 领取 ' + claimed);
    enqueueChain(inst, 'archive', { depth: 0, path: [], now });  // 事件链触发源③：活动归档
    return report;
  }

  /* ==================================================================
   * 6. 播报（走 core.push；没配路由的玩家会被核心自己兜住）
   * ================================================================== */
  async function announce(inst, def, templateKey, data, targetIds, dedupeTag) {
    const ann = objOf(def && def.announce_json);
    if (ann.enabled === false) return 0;
    let content = '';
    try { content = await renderTemplateKey(templateKey, data); } catch (e) { content = ''; }
    if (!content) return 0;
    let ids = targetIds;
    if (!ids) {
      try {
        const rows = await db.all('SELECT player_id FROM player_routes');
        ids = rows.map((r) => String(r.player_id));
      } catch (e) { ids = []; }
    }
    let n = 0;
    for (const pid of (ids || [])) {
      try {
        await core.push({
          type: 'private', id: pid, msg_type: 'text', content,
          dedupe_key: 'event:' + inst.event_key + ':' + inst.id + ':' + (dedupeTag || templateKey) + ':' + pid,
          dedupe_window_ms: 24 * 3600 * 1000
        });
        n++;
      } catch (e) { /* 单个推送失败不影响其他玩家 */ }
    }
    if (n) await writeLog(inst.id, inst.event_key, '', 'announce', templateKey + ' → ' + n + ' 人');
    return n;
  }

  const TEMPLATES = {
    'event:list.head': { text: '📅 【活动】共 [活动数] 个\n[活动列表]', markdown: '📅 **【活动】** 共 [活动数] 个\n[活动列表]' },
    'event:list.line.running': { text: '▫️ [活动名]（进行中，到 [结束时间]）', markdown: '▫️ **[活动名]**（进行中，到 [结束时间]）' },
    'event:list.line.preview': { text: '▫️ [活动名]（[开始时间] 开始）', markdown: '▫️ **[活动名]**（[开始时间] 开始）' },
    'event:list.line.claiming': { text: '▫️ [活动名]（可领奖，到 [领奖截止]）', markdown: '▫️ **[活动名]**（可领奖，到 [领奖截止]）' },
    'event:list.empty': { text: '现在没有进行中的活动。', markdown: '现在没有进行中的活动。' },
    'event:detail': {
      text: '📅 【[活动名]】\n时间：[开始时间] → [结束时间]\n目标：[目标说明]\n我的进度：[我的进度]\n奖励：[奖励说明]\n本期加成：[本期加成]\n说明：[活动说明]',
      markdown: '📅 **[活动名]**\n时间：[开始时间] → [结束时间]\n目标：[目标说明]\n我的进度：[我的进度]\n奖励：[奖励说明]\n本期加成：[本期加成]\n说明：[活动说明]'
    },
    'event:detail.notfound': { text: '❌ 找不到活动「[活动名]」。', markdown: '❌ 找不到活动 **[活动名]**。' },
    'event:join.blocked': { text: '❌ 还不能参加「[活动名]」：[原因]', markdown: '❌ 还不能参加 **[活动名]**：[原因]' },
    'event:join.ok': { text: '✅ 你已参加「[活动名]」，目标：[目标说明]', markdown: '✅ 你已参加 **[活动名]**，目标：[目标说明]' },
    'event:progress.tick': { text: '📈 「[活动名]」进度 [我的进度]', markdown: '📈 **「[活动名]」** 进度 [我的进度]' },
    'event:reward.done': { text: '🎁 「[活动名]」达成！已发放：[奖励明细]', markdown: '🎁 **「[活动名]」达成！** 已发放：[奖励明细]' },
    'event:claim.ok': { text: '🎁 「[活动名]」领取成功：[奖励明细]', markdown: '🎁 **「[活动名]」领取成功：** [奖励明细]' },
    'event:claim.fail': { text: '❌ 「[活动名]」领不了：[原因]', markdown: '❌ **「[活动名]」领不了：** [原因]' },
    'event:started': { text: '🎉 活动「[活动名]」开始了！[目标说明]\n到 [结束时间] 结束。', markdown: '🎉 活动 **「[活动名]」** 开始了！[目标说明]\n到 [结束时间] 结束。' },
    'event:preview': { text: '📣 预告：活动「[活动名]」将于 [开始时间] 开始，[目标说明]', markdown: '📣 **预告：** 活动 **「[活动名]」** 将于 [开始时间] 开始，[目标说明]' },
    'event:milestone': { text: '🔥 全服里程碑：[活动名] 达成 [里程碑]（当前 [全服进度]）[说明]', markdown: '🔥 **全服里程碑：** [活动名] 达成 [里程碑]（当前 [全服进度]）[说明]' },
    'event:settle_done': { text: '🏁 活动「[活动名]」结束：达标 [达标人数] 人，已发放 [发放人数] 人。', markdown: '🏁 活动 **「[活动名]」** 结束：达标 **\[达标人数]** 人，已发放 **[发放人数]** 人。' },
    'event:settle_claim': { text: '🏁 活动「[活动名]」结束：达标 [达标人数] 人。请在 [领奖截止] 前领取奖励。', markdown: '🏁 活动 **「[活动名]」** 结束：达标 **[达标人数]** 人。请在 **[领奖截止]** 前领取。' },
    'event:report': { text: '📊 【[活动名] 战报】参与 [参与人数] · 达标 [达标人数] · 领取 [领取人数]', markdown: '📊 **【[活动名] 战报】** 参与 [参与人数] · 达标 [达标人数] · 领取 [领取人数]' },
    'event:rank': { text: '🏆 【[排行标题] 排行榜】（[参与人数] 人参与）\n[排行列表]', markdown: '🏆 **【[排行标题] 排行榜】**（[参与人数] 人参与）\n[排行列表]' },
    'event:rank.empty': { text: '🏆 【[排行标题]】还没有人上榜（或者现在没有在跑的活动）。', markdown: '🏆 **【[排行标题]】** 还没有人上榜（或者现在没有在跑的活动）。' },
    'event:rank.me': { text: '🏆 【[活动名]】你现在第 [名次] 名（进度 [我的进度]，共 [参与人数] 人参与）', markdown: '🏆 **【[活动名]】** 你现在第 **[名次]** 名（进度 [我的进度]，共 [参与人数] 人参与）' },
    'event:rank.nome': { text: '🏆 【[活动名]】你还没上榜 —— 先打一次目标就上榜了。', markdown: '🏆 **【[活动名]】** 你还没上榜 —— 先打一次目标就上榜了。' },
    'event:gm.started': { text: '✅ 活动「[活动名]」已开启（第 [期号] 期）。', markdown: '✅ 活动 **「[活动名]」** 已开启（第 [期号] 期）。' },
    'event:gm.ended': { text: '✅ 活动「[活动名]」已结算：[战报]', markdown: '✅ 活动 **「[活动名]」** 已结算：[战报]' },
    'event:gm.none': { text: '（没有可操作的活动）', markdown: '（没有可操作的活动）' }
  };
  async function renderTemplateKey(key, data) {
    const t = TEMPLATES[key];
    if (!t) return '';
    try {
      const row = await db.getMessageTemplate('event', key.split(':').slice(1).join('.'));
      const tpl = (row && (row.text_content || row.markdown_content)) ? (row.text_content || row.markdown_content) : t.text;
      return await core.renderTemplate(tpl, data || {});
    } catch (e) { return ''; }
  }

  /* ==================================================================
   * 7. 心跳：开 / 关 / 结算 / 领奖 / 归档（所有时间判断都走本地时区）
   * ================================================================== */
  async function tick(nowArg) {
    if (tickBusy) return { skipped: true };
    tickBusy = true;
    const now = nowArg ? new Date(nowArg) : new Date();
    const out = { opened: 0, settled: 0, claimed: 0, archived: 0, previewed: 0 };
    try {
      await loadDefs();
      if (!defCache.length) return out;      // 一个活动都没配：一拍一次轻查询就够，不做后续扫描
      await materializeDue(now);
      const insts = await activeInstances();
      for (const inst of insts) {
        const def = findDef(inst.event_key);
        if (!def) continue;
        const start = inst.start_at ? new Date(inst.start_at) : null;
        const end = inst.end_at ? new Date(inst.end_at) : null;
        const claimUntil = inst.claim_until ? new Date(inst.claim_until) : null;
        const ann = objOf(def.announce_json);
        if (inst.status === 'preview' && start && now >= start) {
          await db.run("UPDATE event SET status = 'running', updated_at = ? WHERE id = ?", [iso(now), inst.id]);
          inst.status = 'running';
          out.opened++;
          if (ann.on_start !== false) await announce(inst, def, 'event:started', { 活动名: inst.title, 目标说明: objectiveText(def), 结束时间: String(inst.end_at || '').replace('T', ' ').slice(0, 16) }, null, 'start');
          await writeLog(inst.id, inst.event_key, '', 'open', '');
          enqueueChain(inst, 'open', { depth: 0, path: [], now });      // 事件链触发源①：活动开启
        } else if (inst.status === 'preview' && ann.on_preview !== false && start) {
          // 预告只在进入预告窗口的那一次发（用日志判重）
          const seen = await db.get("SELECT id FROM event_log WHERE event_id = ? AND action = 'announce_preview' LIMIT 1", [inst.id]);
          if (!seen) {
            await announce(inst, def, 'event:preview', { 活动名: inst.title, 开始时间: String(inst.start_at || '').replace('T', ' ').slice(0, 16), 目标说明: objectiveText(def) }, null, 'preview');
            await writeLog(inst.id, inst.event_key, '', 'announce_preview', '');
            out.previewed++;
          }
        }
        // 收益加成自愈：① 正在跑的：给还没加过的参与者补上（他们可能是加成加上之前就参加了）
        //             ② 已归档却没收回的（核心中途重启/崩溃过）：收回，别让玩家白拿一辈子
        if (inst.status === 'running' && bonusOf(def).any) {
          try {
            const rows = await db.all("SELECT player_id FROM event_progress WHERE event_id = ? AND (bonus_json = '' OR bonus_json IS NULL)", [inst.id]);
            for (const r of rows) await applyBonus(inst, def, r.player_id);
          } catch (e) { log('warn', '补加成出错：' + e.message); }
        }
        if (inst.status === 'running' && end && now >= end) {
          const rep = await settle(inst, def, now);
          out.settled++;
          inst.status = Number(def.auto_grant === 0 || def.auto_grant === '0') ? 'claiming' : 'archived';
          if (inst.status === 'archived') out.archived++;
          void rep;
        }
        if (inst.status === 'claiming' && claimUntil && now >= claimUntil) {
          // 领奖期结束：按配置自动补发给达标但没领的人（P0 默认补发，不让玩家白干）
          const rows = await db.all('SELECT * FROM event_progress WHERE event_id = ? AND claimed_at IS NULL AND completed_at IS NOT NULL', [inst.id]);
          // 注意：这里用的是 late_grant（领奖期到期的政策），不是 auto_grant（结算时是否立即发）。
          // 第一版把两个开关混用，结果 B 活动的补发被自己的 auto_grant=0 拦掉了（实测补发 0 件）。
          const lateGrant = Number(def.late_grant === 0 || def.late_grant === '0') ? 0 : 1;
          for (const row of rows) {
            if (!lateGrant) break;
            const rewards = pickRewards(def, 1);
            const done = await grant(inst, row.player_id, rewards, 'event:' + inst.event_key + ':late');
            await db.run('UPDATE event_progress SET claimed_at = ?, granted_json = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
              [iso(now), JSON.stringify(done), iso(now), inst.id, row.player_id]);
            await writeLog(inst.id, inst.event_key, row.player_id, 'grant_late', JSON.stringify(done).slice(0, 300));
            out.claimed++;
          }
          await archive(inst, now);
          out.archived++;
        }
      }
      // 孤儿加成自愈（核心中途崩过/重启过）：**已归档**的期次里还挂着没收的收益加成 → 收回。
      // 注意：这一扫必须在「活跃期次」循环之外 —— 归档的期次不在 activeInstances() 里（第一版就写错了，
      // 于是自愈永远不触发；冒烟脚本的 ㉖ 那条断言就是这么把它抓出来的）。
      try {
        const orphans = await db.all("SELECT DISTINCT e.id AS id, e.event_key AS event_key FROM event e JOIN event_progress p ON p.event_id = e.id " +
          "WHERE e.status = 'archived' AND p.bonus_json <> '' AND p.bonus_released_at IS NULL LIMIT 20");
        for (const o of orphans) {
          log('warn', '活动「' + o.event_key + '」已归档但还有收益加成没收回，正在清理');
          await releaseAllBonuses({ id: o.id, event_key: o.event_key });
        }
      } catch (e) { log('warn', '孤儿加成清理出错：' + e.message); }
    } catch (e) {
      log('warn', '心跳出错（不影响核心，下一拍重试）：' + (e && e.message));
    } finally {
      // 事件链在心跳末尾收敛：一拍之内把「谁触发谁」跑完（排水在锁外，见 8.5）
      try { await drainChain(); } catch (e) { /* 链出问题不影响心跳 */ }
      tickBusy = false;
    }
    return out;
  }

  function objectiveText(def) {
    const objs = arrOf(def.objectives_json);
    if (!objs.length) return '（无目标）';
    return objs.map((o) => {
      const name = o.name ? '「' + o.name + '」' : '';
      const scope = String(o.scope || 'personal') === 'global' ? '（全服）' : '';
      const verb = String(o.type) === 'activity' ? '活跃一次' : ('击杀 ' + name);
      return verb + ' ×' + Number(o.count || 1) + scope;
    }).join('；');
  }
  function rewardText(def) {
    const rw = objOf(def.rewards_json);
    const out = [];
    for (const r of (Array.isArray(rw.fixed) ? rw.fixed : [])) out.push(fmtReward(r));
    for (const r of (Array.isArray(rw.random) ? rw.random : [])) out.push(fmtReward(r) + '（' + (Number(r.weight || 0)) + '‰权重）');
    return out.length ? out.join('、') : '（无）';
  }
  function fmtReward(r) {
    const t = String(r.type || '');
    if (t === 'item') return (r.name || '?') + '×' + Number(r.count || 1);
    if (t === 'currency') return (r.field || '货币1') + '×' + Number(r.amount || 0);
    return JSON.stringify(r).slice(0, 30);
  }
  function progressText(def, row) {
    const objs = arrOf(def.objectives_json);
    if (!row) return '未参加';
    const prog = arrOf(row.progress_json);
    return objs.map((o, i) => Number(prog[i] || 0) + '/' + Number(o.count || 1)).join(' · ');
  }

  /* ==================================================================
   * 8. 事件订阅：讨伐进度 + 「当天第一次动作」当登录信号
   * ================================================================== */
  async function onEnemyKilled(playerId, monsterName) {
    try {
      if (!hasObjectiveType('kill')) return;        // 没配讨伐目标 → 纯内存短路（每次击杀都要走这里）
      const insts = await activeInstances();
      for (const inst of insts) {
        if (inst.status !== 'running') continue;
        const def = findDef(inst.event_key);
        if (!def) continue;
        const objs = arrOf(def.objectives_json);
        for (let i = 0; i < objs.length; i++) {
          const o = objs[i];
          if (String(o.type) !== 'kill') continue;
          if (String(o.name) !== String(monsterName)) continue;
          const isGlobal = String(o.scope || 'personal') === 'global';
          if (isGlobal) {
            const gr = await addGlobal(inst, def, i, 1);
            // 事件链触发源⑤：全服里程碑（子键用里程碑下标 → 每个里程碑各触发一次）
            if (gr && gr.newly && gr.newly.length) {
              for (const n of gr.newly) enqueueChain(inst, 'milestone', { depth: 0, path: [], milestoneIndex: n.index });
            }
            continue;
          }
          const bad = await checkRequirements(def, playerId);
          if (bad.length) continue;                       // 不符合参与条件：不算进度
          const jr = await join(inst, playerId, def, 'kill');
          if (jr.joined || true) await applyBonus(inst, def, playerId);   // 参与即享加成（幂等）
          const r = await addProgress(inst, playerId, def, i, 1, String(monsterName));
          if (r && r.justCompleted) enqueueChain(inst, 'personal_complete', { depth: 0, path: [], playerId });   // 触发源④
          if (r && r.justCompleted) {
            const rewards = pickRewards(def, 1);
            let done = [];
            const autoGrant = Number(def.auto_grant === 0 || def.auto_grant === '0') ? 0 : 1;
            if (autoGrant && inst.status === 'running') {
              done = await grant(inst, playerId, rewards, 'event:' + inst.event_key + ':run');
              await db.run('UPDATE event_progress SET claimed_at = ?, granted_json = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
                [iso(new Date()), JSON.stringify(done), iso(new Date()), inst.id, playerId]);
            }
            await writeLog(inst.id, inst.event_key, playerId, 'complete', 'kill ' + monsterName);
            // 回执给玩家（走推送，命中即达）
            try {
              const content = await renderTemplateKey('event:reward.done', { 活动名: inst.title, 奖励明细: done.length ? done.map((d) => d.type === 'item' ? (d.name + '×' + d.count) : ((d.field || '货币') + '×' + d.amount)).join('、') : '（结算时发放）' });
              if (content) await core.push({ type: 'private', id: playerId, msg_type: 'text', content, dedupe_key: 'event:done:' + inst.id + ':' + playerId });
            } catch (e) {}
          }
        }
      }
    } catch (e) { log('warn', '记讨伐进度出错：' + (e && e.message)); }
  }

  /**
   * 「当天第一次动作」= 登录信号。
   * 为什么不用 player:login：核心没有这个事件（只有 player:created 注册那一次）。
   * 这里挂 player:* 通配符，当天第一次收到该玩家的任何事件 → 视为今天来过，
   * 用于 daily 类活动（登录福利 / 每日活跃）。
   */
  const seenToday = new Map();     // playerId -> 'YYYY-MM-DD'（只在真的处理过每日活动后才记，见下）
  async function onAnyPlayerActivity(eventName, playerId) {
    try {
      if (!playerId || typeof playerId !== 'string') return;
      const day = localKey(new Date());
      if (seenToday.get(playerId) === day) return;            // 今天已经算过：纯内存返回
      if (!hasObjectiveType('activity')) return;              // 没配每日活动：纯内存返回
      const insts = await activeInstances();
      let touched = false;
      for (const inst of insts) {
        if (inst.status !== 'running') continue;
        const def = findDef(inst.event_key);
        if (!def) continue;
        const objs = arrOf(def.objectives_json);
        const idx = objs.findIndex((o) => String(o.type) === 'activity');
        if (idx < 0) continue;
        if (seenToday.get(playerId) === day) continue;   // 今天已经算过这条活动了（省一次查询，不是判定依据）
        const bad = await checkRequirements(def, playerId);
        if (bad.length) continue;
        await join(inst, playerId, def, 'activity(' + eventName + ')');
        const r = await addProgress(inst, playerId, def, idx, 1, 'daily');
        if (r && r.justCompleted) enqueueChain(inst, 'personal_complete', { depth: 0, path: [], playerId });   // 触发源④
        if (r && r.justCompleted) {
          const autoGrant = Number(def.auto_grant === 0 || def.auto_grant === '0') ? 0 : 1;
          if (autoGrant) {
            const rewards = pickRewards(def, 1);
            const done = await grant(inst, playerId, rewards, 'event:' + inst.event_key + ':daily');
            await db.run('UPDATE event_progress SET claimed_at = ?, granted_json = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
              [iso(new Date()), JSON.stringify(done), iso(new Date()), inst.id, playerId]);
            try {
              const content = await renderTemplateKey('event:reward.done', { 活动名: inst.title, 奖励明细: done.map((d) => d.type === 'item' ? (d.name + '×' + d.count) : ((d.field || '货币') + '×' + d.amount)).join('、') });
              if (content) await core.push({ type: 'private', id: playerId, msg_type: 'text', content, dedupe_key: 'event:done:' + inst.id + ':' + playerId });
            } catch (e) {}
          }
        }
        touched = true;
      }
      if (touched) {
        seenToday.set(playerId, day);
        if (seenToday.size > 5000) seenToday.clear();    // 防内存无限涨
      }
    } catch (e) { log('warn', '记活跃出错：' + (e && e.message)); }
  }

  /* ==================================================================
   * 8.5 事件链：活动触发活动（2026-09-20）
   * ==================================================================
   * 策划视角：上游活动「开了 / 结算了 / 归档了 / 有人达标了 / 全服里程碑响了」→
   *   自动把下游活动**开一期**，或者给下游推一把进度。配一张表就能串出战役：
   *     预热讨伐 → 全服里程碑 → 开启世界首领 → 首领结算 → 开启庆功福利
   *
   * 三个必须守住的硬点（都是会真出事的地方）：
   *   ① **不在进度锁里递归**：personal_complete / milestone 这两个触发源发生在
   *      addProgress / addGlobal 的 withLock 里（一次「读出来→加一下→写回去」）。
   *      若就地递归下去，而链又推进同一个 (期, 玩家) 的进度，就会自己等自己的锁 —— 死锁。
   *      所以链一律**入队**，由 setImmediate 在锁外排水（enqueueChain / drainChain）。
   *   ② **幂等**：tick 每秒重扫，同一条规则会被多个入口碰到 → event_chain_fire 表按
   *      (期, 规则号, 子键) 唯一，记过就不再触发。
   *   ③ **防环**：一趟链内路径去重（不许回到走过的活动）+ 深度上限 MAX_CHAIN_DEPTH。
   *      路径初始就含触发者自己 → A→A 自指当场拦；A→B→A 在第二跳拦。
   *
   * 父子生命周期口径：**不连带结束**。下游一被开启就按自己的时长跑完整一期，
   *   上游结束/归档都不掐它（要停下游就用「活动结束」指令或停用定义）。
   *   来源可追溯：event_chain_fire 表 + event_log 的 chain_fire / chain_open 两条留痕。
   */
  const MAX_CHAIN_DEPTH = 3;
  const CHAIN_TRIGGERS = ['open', 'settle', 'archive', 'personal_complete', 'milestone'];
  const CHAIN_TRIGGER_LABEL = { open: '活动开启', settle: '活动结算', archive: '活动归档', personal_complete: '有人达标', milestone: '全服里程碑' };
  const CHAIN_ACTION_LABEL = { start: '开启一期', progress: '推进度' };

  const chainQueue = [];
  let chainDrainPromise = null;

  const chainNodeKey = (inst) => String(inst.event_key) + '#' + inst.id;

  /** 取一条定义里能用的链规则（带原始下标 —— 下标是幂等键的一部分，必须稳定） */
  const chainRulesOf = (def) => arrOf(def && def.chain_json)
    .map((r, i) => ({ rule: r, index: i }))
    .filter((x) => x.rule && String(x.rule.target || '').trim() && CHAIN_TRIGGERS.indexOf(String(x.rule.on || '')) >= 0);

  /** 达标即发奖 + 回执（链触发的达标走这一份，语义与战斗中达标保持一致） */
  async function completeAndGrant(inst, def, playerId, tag) {
    const autoGrant = Number(def.auto_grant === 0 || def.auto_grant === '0') ? 0 : 1;
    let done = [];
    if (autoGrant && inst.status === 'running') {
      const rewards = pickRewards(def, 1);
      done = await grant(inst, playerId, rewards, 'event:' + inst.event_key + ':' + (tag || 'run'));
      await db.run('UPDATE event_progress SET claimed_at = ?, granted_json = ?, updated_at = ? WHERE event_id = ? AND player_id = ?',
        [iso(new Date()), JSON.stringify(done), iso(new Date()), inst.id, playerId]);
    }
    await writeLog(inst.id, inst.event_key, playerId, 'complete', tag || '');
    try {
      const content = await renderTemplateKey('event:reward.done', {
        活动名: inst.title,
        奖励明细: done.length ? done.map((d) => d.type === 'item' ? (d.name + '×' + d.count) : ((d.field || '货币') + '×' + d.amount)).join('、') : '（结算时发放）'
      });
      if (content) await core.push({ type: 'private', id: playerId, msg_type: 'text', content, dedupe_key: 'event:done:' + inst.id + ':' + playerId });
    } catch (e) { /* 回执失败不影响发奖 */ }
    return done;
  }

  /** 入队（**永不在锁内执行**）。ctx: { depth, path, playerId, milestoneIndex } */
  function enqueueChain(inst, on, ctx) {
    if (!inst || !inst.id) return;
    const c = ctx || {};
    const depth = Number(c.depth) || 0;
    const path = Array.isArray(c.path) ? c.path.slice() : [];
    if (depth > MAX_CHAIN_DEPTH) {
      log('warn', '事件链超过最大深度 ' + MAX_CHAIN_DEPTH + '，丢弃：' + String(inst.event_key) + ' 的 ' + on);
      writeLog(inst.id, inst.event_key, c.playerId || '', 'chain_depth_blocked', 'depth=' + depth + ' on=' + on).catch(() => {});
      return;
    }
    // now：把「这次触发的时刻」带下去 —— 心跳用的是它的时间基准（测试会灌假时间），
    // 链开下游那一期必须照同一个基准算起止，否则假时间下新期会被立刻判成「已过期」结算掉。
    chainQueue.push({ inst, on, ctx: { depth, path, playerId: c.playerId || '', milestoneIndex: c.milestoneIndex, now: c.now || null } });
    setImmediate(() => { drainChain().catch(() => {}); });
  }

  /**
   * 排水：串行把队列里的链跑完。返回的 promise 表示「此刻队列已空」——
   * tick 末尾会 await 它，于是「一拍之内链收敛」是可断言的（冒烟脚本靠这个）。
   */
  function drainChain() {
    if (chainDrainPromise) return chainDrainPromise;
    // 这里必须用 Promise.resolve().then(...) 起头，**不能**直接跑 async IIFE：
    // 队列为空时 async IIFE 会同步一路跑到 finally，于是 finally 里的 chainDrainPromise = null
    // 先执行、赋值后执行 —— chainDrainPromise 就被钉死在一个已完成的 promise 上，
    // 此后所有入队的链**永远不再被处理**（第一版正是这个 bug：冒烟一跑就现形，
    // 表现为 event_chain_fire 一条记录都没有，而手动 chainStart 却完全正常）。
    chainDrainPromise = Promise.resolve().then(async () => {
      try {
        while (chainQueue.length) {
          const job = chainQueue.shift();
          try { await runChainRules(job.inst, job.on, job.ctx); }
          catch (e) { log('warn', '事件链执行出错：' + (e && e.message)); }
        }
      } finally { chainDrainPromise = null; }
    });
    return chainDrainPromise;
  }

  async function runChainRules(inst, on, ctx) {
    const def = findDef(inst.event_key);
    if (!def) return;
    const rules = chainRulesOf(def);
    if (!rules.length) return;
    const path = ctx.path.concat([chainNodeKey(inst)]);
    const visitedKeys = path.map((p) => String(p).split('#')[0]);
    for (const item of rules) {
      const rule = item.rule, index = item.index;
      if (String(rule.on) !== on) continue;
      const target = String(rule.target).trim();
      const action = String(rule.action || 'start') === 'progress' ? 'progress' : 'start';
      // 防环①：这一趟链里已经走过它了
      if (visitedKeys.indexOf(target) >= 0) {
        await writeLog(inst.id, inst.event_key, ctx.playerId || '', 'chain_cycle_blocked', on + ' → ' + target + '（本趟链已经走过）');
        log('warn', '事件链成环被拦：「' + inst.event_key + '」→「' + target + '」（' + path.join(' → ') + '）');
        continue;
      }
      // 防环②：深度
      if (ctx.depth >= MAX_CHAIN_DEPTH) {
        await writeLog(inst.id, inst.event_key, ctx.playerId || '', 'chain_depth_blocked', on + ' → ' + target + ' depth=' + ctx.depth);
        log('warn', '事件链到了最大深度 ' + MAX_CHAIN_DEPTH + '：「' + inst.event_key + '」→「' + target + '」不再往下');
        continue;
      }
      // 幂等：这一期这条规则（+ 子键）已经触发过就不再来一次
      const subKey = chainSubKey(on, action, ctx);
      let fired = null;
      try { fired = await db.get('SELECT event_id FROM event_chain_fire WHERE event_id = ? AND rule_index = ? AND sub_key = ?', [inst.id, index, subKey]); }
      catch (e) { fired = null; }
      if (fired) continue;
      const res = (action === 'progress')
        ? await chainProgress(inst, target, rule, ctx, path)
        : await chainStart(inst, target, rule, index, ctx, path);
      const detail = String((res && res.detail) || '').slice(0, 300);
      try {
        await db.run('INSERT OR REPLACE INTO event_chain_fire (event_id, rule_index, sub_key, trigger_on, target_key, action, ok, detail, fired_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [inst.id, index, subKey, on, target, action, (res && res.ok) ? 1 : 0, detail, iso(new Date())]);
      } catch (e) { log('warn', '记事件链触发失败：' + e.message); }
      await writeLog(inst.id, inst.event_key, ctx.playerId || '', 'chain_fire', on + ' → ' + target + ' / ' + action + '：' + detail);
    }
  }

  function chainSubKey(on, action, ctx) {
    if (on === 'milestone') return 'm' + (Number(ctx.milestoneIndex) || 0);
    if (action === 'progress' && ctx.playerId) return String(ctx.playerId);
    return '';
  }

  /** 下游「开一期」：不复活旧期、不与排期期重叠，时长照下游自己的排期长度 */
  async function chainStart(srcInst, targetKey, rule, ruleIndex, ctx, path) {
    await loadDefs();
    const def = findDef(targetKey);
    if (!def) return { ok: false, detail: '没有叫「' + targetKey + '」的活动定义（或者它被停用了）' };
    const running = await db.all("SELECT * FROM event WHERE event_key = ? AND status IN ('preview','running','claiming') ORDER BY id DESC LIMIT 1", [def.key]);
    if (running.length) return { ok: false, detail: '下游「' + def.key + '」已经有在跑的期（' + running[0].status + '），不重复开' };
    const now = ctx.now ? new Date(ctx.now) : new Date();
    const periodKey = 'chain-' + srcInst.id + '-' + ruleIndex;
    const exist = await getInstance(def.key, periodKey);
    if (exist) return { ok: false, detail: '这一期（' + periodKey + '）已经开过了' };
    // 时长取下游排期自身的长度：链触发不等于「临时开一下」，应该跑完整一期
    let durMs = 3600 * 1000;
    try {
      const win = windowFor(def.schedule_json, now);
      if (win) {
        const d = new Date(win.end).getTime() - new Date(win.start).getTime();
        if (d >= 60000 && d <= 7 * 24 * 3600 * 1000) durMs = d;
      }
    } catch (e) { /* 排期算不出来就用 1 小时兜底 */ }
    const start = now;
    const end = new Date(now.getTime() + durMs);
    const claimMs = (parseInt(def.claim_window_min, 10) || 0) * 60 * 1000;
    await db.run("INSERT INTO event (event_key, period_key, title, start_at, end_at, claim_until, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [def.key, periodKey, def.name || def.key, iso(start), iso(end), iso(new Date(end.getTime() + claimMs)), 'running', iso(now), iso(now)]);
    const inst = await getInstance(def.key, periodKey);
    if (!inst) return { ok: false, detail: '开期写库后读不回来（异常）' };
    await writeLog(inst.id, def.key, ctx.playerId || '', 'chain_open', '由「' + srcInst.event_key + '#' + srcInst.id + '」的规则 ' + ruleIndex + ' 触发');
    log('info', '事件链：「' + srcInst.event_key + '」触发开启「' + def.key + '」（期 ' + periodKey + '，到 ' + iso(end) + '）');
    try {
      const ann = objOf(def.announce_json);
      if (ann.on_start !== false) {
        await announce(inst, def, 'event:started', {
          活动名: inst.title, 目标说明: objectiveText(def),
          结束时间: String(iso(end)).replace('T', ' ').slice(0, 16)
        }, null, 'chain-start');
      }
    } catch (e) { /* 播报失败不妨碍链 */ }
    // 下游这一期也算「开启」—— 允许它继续往下触发（深度与路径会拦住环）
    enqueueChain(inst, 'open', { depth: ctx.depth + 1, path, playerId: ctx.playerId, now: ctx.now });
    return { ok: true, detail: '已开启期 ' + periodKey + '（到 ' + iso(end) + '）' };
  }

  /** 下游「推进度」：推给下游**正在跑的那一期** */
  async function chainProgress(srcInst, targetKey, rule, ctx, path) {
    await loadDefs();
    const def = findDef(targetKey);
    if (!def) return { ok: false, detail: '没有叫「' + targetKey + '」的活动定义（或者它被停用了）' };
    const inst = await db.get("SELECT * FROM event WHERE event_key = ? AND status = 'running' ORDER BY id DESC LIMIT 1", [def.key]);
    if (!inst) return { ok: false, detail: '下游「' + def.key + '」现在没有在跑的期' };
    const objs = arrOf(def.objectives_json);
    const wantIdx = parseInt(rule.objective, 10) || 0;
    if (!objs[wantIdx]) return { ok: false, detail: '下游没有第 ' + wantIdx + ' 个目标' };
    const idx = Math.max(0, Math.min(objs.length - 1, wantIdx));
    const delta = Number(rule.delta) > 0 ? Number(rule.delta) : 1;
    const who = String(rule.player || 'trigger') === 'all' ? 'all' : 'trigger';
    let targets = [];
    if (who === 'all') {
      const rows = await db.all('SELECT player_id FROM event_progress WHERE event_id = ?', [inst.id]);
      targets = rows.map((r) => String(r.player_id));
      if (!targets.length) return { ok: false, detail: '下游还没有人参加，没有可推进的对象' };
    } else {
      if (!ctx.playerId) return { ok: false, detail: '这条规则按「触发者」推进，但这次触发没有具体玩家（排期/里程碑类触发请改成「下游全体」）' };
      const bad = await checkRequirements(def, ctx.playerId);
      if (bad.length) return { ok: false, detail: '触发者不符合下游参与条件：' + bad.join('；') };
      await join(inst, ctx.playerId, def, 'chain(' + srcInst.event_key + ')');
      await applyBonus(inst, def, ctx.playerId);       // 参与即享下游加成（幂等）
      targets = [String(ctx.playerId)];
    }
    let moved = 0;
    const completed = [];
    for (const pid of targets) {
      const r = await addProgress(inst, pid, def, idx, delta, 'chain:' + srcInst.event_key);
      if (!r) continue;
      moved++;
      if (r.justCompleted) { completed.push(pid); await completeAndGrant(inst, def, pid, 'chain'); }
    }
    // 下游有人达标 → 让它继续往下触发（新一趟深度 +1）
    for (const pid of completed) enqueueChain(inst, 'personal_complete', { depth: ctx.depth + 1, path, playerId: pid });
    return { ok: moved > 0, detail: '目标 ' + idx + ' +' + delta + ' → ' + moved + ' 人（达标 ' + completed.length + ' 人）' };
  }

  /* ==================================================================
   * 9. 门（指令）与模板注册
   * ================================================================== */
  async function currentList(playerId) {
    await loadDefs();
    const insts = await activeInstances();
    const items = [];
    for (const inst of insts) {
      const def = findDef(inst.event_key);
      if (!def) continue;
      const row = playerId ? await getProgress(inst.id, playerId) : null;
      items.push({ inst, def, row });
    }
    return items;
  }

  /** 立刻开一期（编辑器「立刻开一期」按钮 与 GM 指令共用这一份） */
  async function startNow(key, byPlayer) {
    await loadDefs();
    const def = findDef(key);
    if (!def) return { ok: false, error: '没有叫「' + key + '」的活动定义' };
    const now = new Date();
    const win = windowFor(def.schedule_json, now) || { start: now, end: new Date(now.getTime() + 3600 * 1000), periodKey: 'manual-' + iso(now).slice(0, 16) };
    const exist = await getInstance(def.key, win.periodKey);
    let inst = exist;
    if (!inst) {
      await db.run("INSERT INTO event (event_key, period_key, title, start_at, end_at, claim_until, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [def.key, win.periodKey, def.name || def.key, iso(now), iso(win.end), iso(win.end), 'running', iso(now), iso(now)]);
      inst = await getInstance(def.key, win.periodKey);
    } else {
      await db.run("UPDATE event SET status = 'running', start_at = ?, updated_at = ? WHERE id = ?", [iso(now), iso(now), inst.id]);
    }
    await writeLog(inst.id, def.key, byPlayer || '', 'gm_start', '');
    enqueueChain(inst, 'open', { depth: 0, path: [], playerId: byPlayer || '', now });   // 手动开也走链（幂等表兜重复开）
    log('info', '手动开启活动「' + def.key + '」（' + (byPlayer || '编辑器') + '）');
    announce(inst, def, 'event:started', { 活动名: inst.title, 目标说明: objectiveText(def), 结束时间: String(inst.end_at || '').replace('T', ' ').slice(0, 16) }, null, 'start').catch(() => {});
    return { ok: true, instance: inst, periodKey: win.periodKey };
  }

  /** 立刻结算 + 归档（编辑器「立刻结算」按钮 与 GM 指令共用这一份） */
  async function endNow(key, byPlayer) {
    await loadDefs();
    const def = findDef(key);
    if (!def) return { ok: false, error: '没有叫「' + key + '」的活动定义' };
    const running = (await activeInstances()).filter((i) => i.event_key === def.key && (i.status === 'running' || i.status === 'preview'));
    const inst = running[running.length - 1];
    if (!inst) return { ok: false, error: '「' + key + '」现在没有在跑的一期' };
    await settle(inst, def, new Date());
    const rep = await archive(inst, new Date());
    await writeLog(inst.id, def.key, byPlayer || '', 'gm_end', JSON.stringify(rep));
    return { ok: true, report: rep };
  }

  /**
   * 活动排行榜（2026-09-19）
   * ------------------------------------------------------------------
   * 为什么不建排行榜表：名次完全由 event_progress 推出来 —— 建表就得同步，
   * 一旦某次写入漏了，榜单和进度就会对不上。直接算，永远一致。
   * 排序：按指定目标下标的进度值降序；并列时**先完成的排前面**（completed_at 早者优先），
   * 都没完成就按参与时间早者优先 ✔ 稳定且可解释。
   */
  async function leaderboard(inst, def, objectiveIndex, limit) {
    const objs = arrOf(def.objectives_json);
    const idx = Math.max(0, Math.min(objs.length - 1, parseInt(objectiveIndex, 10) || 0));
    const target = Number((objs[idx] || {}).count || 1);
    const rows = await db.all('SELECT * FROM event_progress WHERE event_id = ?', [inst.id]);
    const list = rows.map((r) => {
      const prog = arrOf(r.progress_json);
      return { player_id: r.player_id, value: Number(prog[idx] || 0), completed_at: r.completed_at || '', joined_at: r.joined_at || '' };
    }).filter((x) => x.value > 0);
    list.sort((a, b) => (b.value - a.value) || String(a.completed_at || a.joined_at).localeCompare(String(b.completed_at || b.joined_at)));
    const top = list.slice(0, Math.max(1, Math.min(50, parseInt(limit, 10) || 10)));
    for (const x of top) {
      try { const p = await core.services.player.get(x.player_id); x.nickname = (p && p.昵称) || x.player_id; }
      catch (e) { x.nickname = x.player_id; }
    }
    return { objectiveIndex: idx, target, total: list.length, top, me: (pid) => { const i = list.findIndex((x) => x.player_id === pid); return i < 0 ? null : { rank: i + 1, value: list[i].value }; } };
  }

  const handlers = {
    'event:rank': async (request) => {
      const key = (request.args && request.args[0]) || '';
      const items = await currentList('');
      const hit = items.find((x) => String(x.inst.event_key) === String(key)) || items.find((x) => x.inst.status === 'running' || x.inst.status === 'claiming');
      if (!hit) return { status: 'fail', data: { 排行标题: '（没有在跑的活动）' }, templateKey: 'event:rank.empty' };
      const lb = await leaderboard(hit.inst, hit.def, request.args && request.args[1], 10);
      if (!lb.top.length) return { status: 'fail', data: { 排行标题: hit.inst.title }, templateKey: 'event:rank.empty' };
      const lines = lb.top.map((x, i) => {
        const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : ('第 ' + (i + 1) + ' 名')));
        return medal + ' ' + x.nickname + ' — ' + x.value + '/' + lb.target;
      });
      return { status: 'success', data: { 排行标题: hit.inst.title, 参与人数: lb.total, 排行列表: lines.join(String.fromCharCode(10)) }, templateKey: 'event:rank' };
    },
    'event:myrank': async (request) => {
      const key = (request.args && request.args[0]) || '';
      const items = await currentList('');
      const hit = items.find((x) => String(x.inst.event_key) === String(key)) || items.find((x) => x.inst.status === 'running' || x.inst.status === 'claiming');
      if (!hit) return { status: 'fail', data: { 活动名: key }, templateKey: 'event:rank.empty' };
      const lb = await leaderboard(hit.inst, hit.def, null, 10);
      const me = lb.me(request.playerId);
      if (!me) return { status: 'fail', data: { 活动名: hit.inst.title }, templateKey: 'event:rank.nome' };
      return { status: 'success', data: { 活动名: hit.inst.title, 名次: String(me.rank), 我的进度: me.value + '/' + lb.target, 参与人数: String(lb.total) }, templateKey: 'event:rank.me' };
    },
    'event:list': async (request) => {
      const pid = request.playerId;
      const items = await currentList(pid);
      if (!items.length) return { status: 'success', data: {}, templateKey: 'event:list.empty' };
      const lines = items.map(({ inst, def, row }) => {
        const lineKey = inst.status === 'running' ? 'event:list.line.running'
          : (inst.status === 'claiming' ? 'event:list.line.claiming' : 'event:list.line.preview');
        const t = TEMPLATES[lineKey].text
          .replace('[活动名]', (inst.title || inst.event_key) + (row ? ('（我的进度 ' + progressText(def, row) + '）') : ''))
          .replace('[结束时间]', String(inst.end_at || '').replace('T', ' ').slice(0, 16))
          .replace('[开始时间]', String(inst.start_at || '').replace('T', ' ').slice(0, 16))
          .replace('[领奖截止]', String(inst.claim_until || '').replace('T', ' ').slice(0, 16));
        return t;
      });
      return { status: 'success', data: { 活动数: lines.length, 活动列表: lines.join('\n') }, templateKey: 'event:list.head' };
    },
    'event:detail': async (request) => {
      const key = (request.args && request.args[0]) || '';
      const items = await currentList(request.playerId);
      let hit = items.find((x) => String(x.inst.event_key) === String(key) || String(x.inst.title) === String(key)) || items[0];
      if (!hit && key) {
        // 活动已经归档了也要查得到（玩家问「我刚打的活动呢」不能回"找不到"）
        await loadDefs();
        const def = findDef(key);
        const row = def ? await db.get('SELECT * FROM event WHERE event_key = ? ORDER BY id DESC LIMIT 1', [key]) : null;
        if (def && row) hit = { inst: row, def, row2: await getProgress(row.id, request.playerId) };
        if (hit) hit.row = hit.row2;
      }
      if (!hit) return { status: 'fail', data: { 活动名: key }, templateKey: 'event:detail.notfound' };
      const { inst, def, row } = hit;
      return {
        status: 'success',
        data: {
          活动名: inst.title || inst.event_key,
          开始时间: String(inst.start_at || '').replace('T', ' ').slice(0, 16),
          结束时间: String(inst.end_at || '').replace('T', ' ').slice(0, 16),
          目标说明: objectiveText(def),
          我的进度: progressText(def, row),
          奖励说明: rewardText(def),
          本期加成: bonusText(def) || '（无）',
          活动说明: def.description || '（无）'
        },
        templateKey: 'event:detail'
      };
    },
    'event:claim': async (request) => {
      const key = (request.args && request.args[0]) || '';
      const items = await currentList(request.playerId);
      const hit = items.find((x) => x.inst.status === 'claiming' && (String(x.inst.event_key) === String(key) || String(x.inst.title) === String(key) || !key));
      if (!hit) return { status: 'fail', data: { 活动名: key, 原因: '现在没有可领奖的活动' }, templateKey: 'event:claim.fail' };
      const r = await claim(hit.inst, hit.def, request.playerId);
      if (!r.ok) return { status: 'fail', data: { 活动名: hit.inst.title, 原因: r.reason }, templateKey: 'event:claim.fail' };
      return { status: 'success', data: { 活动名: hit.inst.title, 奖励明细: r.rewards.map((d) => d.type === 'item' ? (d.name + '×' + d.count) : ((d.field || '货币') + '×' + d.amount)).join('、') }, templateKey: 'event:claim.ok' };
    },
    'event:gm_start': async (request) => {
      const key = (request.args && request.args[0]) || '';
      const r = await startNow(key, request.playerId);
      if (!r.ok) return { status: 'fail', data: { 活动名: key }, templateKey: 'event:gm.none' };
      return { status: 'success', data: { 活动名: r.instance.title, 期号: r.periodKey }, templateKey: 'event:gm.started' };
    },
    'event:gm_end': async (request) => {
      const key = (request.args && request.args[0]) || '';
      const r = await endNow(key, request.playerId);
      if (!r.ok) return { status: 'fail', data: { 活动名: key }, templateKey: 'event:gm.none' };
      return { status: 'success', data: { 活动名: key, 战报: '参与 ' + r.report.joined + ' · 达标 ' + r.report.completed + ' · 领取 ' + r.report.claimed }, templateKey: 'event:gm.ended' };
    },
    'event:report': async (request) => {
      const key = (request.args && request.args[0]) || '';
      const items = await currentList('');
      const hit = items.find((x) => String(x.inst.event_key) === String(key)) || items[0];
      if (!hit) return { status: 'fail', data: { 活动名: key }, templateKey: 'event:gm.none' };
      const rep = objOf(hit.inst.report_json);
      return {
        status: 'success',
        data: { 活动名: hit.inst.title, 参与人数: String(rep.joined || 0), 达标人数: String(rep.completed || 0), 领取人数: String(rep.claimed || rep.granted || 0) },
        templateKey: 'event:report'
      };
    }
  };

  const doors = [
    { logical_name: 'event:list', default_triggers: ['活动', '活动列表'], description: '查看进行中/即将开始的活动与我的进度' },
    { logical_name: 'event:detail', default_triggers: ['活动详情'], description: '查看某个活动的目标/奖励/我的进度' },
    { logical_name: 'event:claim', default_triggers: ['活动领奖'], description: '领取活动奖励（领奖期内）' },
    { logical_name: 'event:gm_start', default_triggers: ['活动开始'], description: 'GM：立刻开启一个活动', permission: 'admin' },
    { logical_name: 'event:gm_end', default_triggers: ['活动结束'], description: 'GM：立刻结算并归档一个活动', permission: 'admin' },
    { logical_name: 'event:rank', default_triggers: ['活动排行', '排行榜'], description: '看当前活动的排行榜（前 10）' },
    { logical_name: 'event:myrank', default_triggers: ['我的排名'], description: '看我在当前活动里的名次' },
    { logical_name: 'event:report', default_triggers: ['活动战报'], description: 'GM：查看活动战报', permission: 'admin' }
  ];

  core.registerModule('event', { doors, templates: TEMPLATES, handlers });

  /* ==================================================================
   * 10. 生命周期
   * ================================================================== */
  function startTimer() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  await initSchema();
  core.on('core:started', async () => {
    try { await tick(); } catch (e) {}
    startTimer();
  });
  core.on('core:stopping', async () => { stopTimer(); });
  core.on('enemy:killed', (playerId, monsterName) => { onEnemyKilled(playerId, monsterName).catch(() => {}); });
  core.on('player:*', (playerId) => { onAnyPlayerActivity('player:*', playerId).catch(() => {}); });

  log('info', '事件（活动）模块加载完成：限时讨伐 / 每日活跃 两类 · 事件链（活动触发活动）；指令 活动 · 活动详情 · 活动领奖（GM：活动开始 · 活动结束 · 活动战报）');

  return {
    moduleName: 'event',
    // 给验证脚本用的内部入口（真跑用，不对外承诺）
    _internals: {
      windowFor, tick, loadDefs, materializeDue, settle, archive, claim, join, addProgress, addGlobal,
      checkRequirements, objectiveText, rewardText, activeInstances, getInstance, currentList, startNow, endNow,
      // 仅供验证脚本用：把「今天已经算过每日活动」的闩锁清掉，好把同一台机器上的每日流程重跑一遍。
      // 生产路径不需要它（闩锁只是省查询，真正的去重靠进度封顶 + claimed_at）。
      resetActivityLatch: () => { seenToday.clear(); return true; },
      // 事件链（活动触发活动）：给冒烟脚本的真跑入口，不对外承诺
      fireChain: enqueueChain, drainChain, chainRules: chainRulesOf, chainStart, chainProgress,
      chainSubKey, MAX_CHAIN_DEPTH, CHAIN_TRIGGERS
    }
  };
}

eventModule.moduleName = 'event';
eventModule.dependencies = ['database'];
module.exports = eventModule;
