/**
 * 语句唯一实现层（2026-09-19 S3+ 第一批 · 治 D9/D10）
 * ------------------------------------------------------------------
 * 背景：块模式（lib/blocks/*.js）与代码模式（lib/superCode.js 的 RUN 表）**各写一份**同一批语句。
 * 两边的动作体逐字相似，但参数取值方式不同（块从 node.params 取、代码从解析出的 p 取），
 * 返回值形状也不同（块回 {nextPort}、代码回 {}）。漂移过一次就得两处一起改，这正是 D9 说的问题。
 *
 * 本层的边界（刻意划清）：
 *   · **只做动作**：调哪个服务、带什么参数、成功后标记 playerDirty、失败抛什么人话；
 *   · **不做取值**：参数怎么读出来（字面量/数字/表达式）由两侧适配器负责；
 *   · **不做形状**：返回 {ok} 这类中性结果，由两侧适配器映射成各自的返回形状。
 * 这样「同一批语句只有一份动作实现」，而两侧语义差异（如代码模式对空的额外校验）仍能保留。
 */
'use strict';
const crypto = require('crypto');
const { explainEmptyExpr } = require('./superBlockUtil');

function createOps(opts) {
  const o = opts || {};
  const core = o.core;
  const { QUERY_TABLES, PLAYER_TABLES } = require('./superTables');   // 白名单唯一来源
  const src = (ctx) => 'super:' + ((ctx && ctx.key) || '');
  /** 日志永不抛（与宿主层 host.log 同口径） */
  const log = (lv, msg) => { try { core.log(lv, msg); } catch (e) { /* 日志失败不影响业务 */ } };
  /** 数量：0 是合法值，只有「压根没给」才当 0（调用方的适配器已负责各自的默认值） */
  const cnt = (a) => Math.floor((a.count === undefined || a.count === null || a.count === '') ? 0 : Number(a.count));

  /** 给玩家加货币（核心服务负责上限夹取） */
  async function currency_add(a, ctx) {
    await core.services.player.giveCurrency({ targets: [ctx.playerId], field: a.field || '货币1', amount: Number(a.amount) || 0, source: src(ctx) });
    ctx.playerDirty = true;
    return { ok: true };
  }

  /** 扣货币，不够直接抛人话（两侧文案一致：核心给的 message 优先） */
  async function currency_sub(a, ctx) {
    const res = await core.services.player.takeCurrency({ playerId: ctx.playerId, field: a.field || '货币1', amount: Number(a.amount) || 0, source: src(ctx) });
    if (!res || !res.success) throw new Error((res && res.message) || '货币不足');
    ctx.playerDirty = true;
    return { ok: true };
  }

  /** 发物品进背包 */
  async function item_add(a, ctx) {
    await core.services.player.giveItems({ targets: [ctx.playerId], items: [{ name: a.name, count: cnt(a) }], source: src(ctx) });
    ctx.playerDirty = true;
    return { ok: true };
  }

  /** 从背包扣物品，不够直接抛人话 */
  async function item_take(a, ctx) {
    const res = await core.services.player.takeItems({ playerId: ctx.playerId, items: [{ name: a.name, count: cnt(a) }], source: src(ctx) });
    if (!res || !res.success) throw new Error((res && res.message) || '物品不足');
    ctx.playerDirty = true;
    return { ok: true };
  }

  /** 背包里够不够（只读，不写 playerDirty） */
  async function check_has_item(a, ctx) {
    const bp = (ctx.player && ctx.player['背包']) || {};
    // 注意：0 是合法值（测试钉住的口径：「要 0 个 → 必走真」），只有「压根没给」才回落到 1
    const need = (a.count === undefined || a.count === null || a.count === '') ? 1 : Number(a.count);
    return { ok: Number(bp[a.name] || 0) >= need };
  }


  /**
   * 主动推送（2026-09-19 S3+ 第二批收敛）：块侧与代码侧原本各写一份约 100 行的动作体。
   * 两侧差异只在「参数从哪来」与「返回什么形状」，动作完全一致，所以收进这一份：
   *   · 稳定去重键（同逻辑+同内容 10 秒内只入队一次，防连点）、
   *   · 发送形态决策（跟随全局 → 文本/markdown/图片）、
   *   · 出图失败退回文字（并记一条 warn，块侧原本有、代码侧补齐）、
   *   · 延迟入队（不阻塞逻辑，避免推送抢在被动回复前面）、
   *   · 回执（入队号 / 状态 / 被防抖跳过不算失败）。
   * 调用方只需给：type（player/group/broadcast）、text、rawContent（用于空内容人话）、
   * wantMode（跟随全局/纯文本/Markdown/图片）、tplKey（出图布局）、delaySec。
   */
  async function push_send(a, ctx) {
    const t = a.type || 'player';
    const text = String(a.text == null ? '' : a.text);
    if (!text) throw new Error('主动推送没有发出：内容为空 —— ' + explainEmptyExpr(a.rawContent || ''));
    // 稳定去重键（2026-09-17）：原来是 super_<key>_<Date.now()>，等于没有去重 ——
    // 玩家连点/逻辑被重复触发时，同一句话会被反复推进队列。现在同玩家+同逻辑+同内容 10 秒内只入队一次。
    const sig = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    const dedupeKey = 'super_' + ctx.key + '_' + sig;
    const wantMode = a.wantMode || '跟随全局';
    const tplKey = a.tplKey || 'system.info';
    const delaySec = Math.max(0, Math.min(60, Number(a.delaySec) || 0));

    /** 决定这条推送以什么形态发送：跟随全局（编辑器「基础设置 → 消息模式」）时，
     *  图片模式就出图、Markdown 模式就走 markdown，其余按纯文本。 */
    async function buildPayload() {
      let msgType = 'text';
      let content = text;
      const globalMode = (typeof core.getMessageMode === 'function') ? core.getMessageMode() : 1;   // 1 文本 / 2 markdown / 3 图片
      const mode = (wantMode === '跟随全局')
        ? (globalMode === 3 ? '图片' : (globalMode === 2 ? 'Markdown' : '纯文本'))
        : wantMode;
      if (mode === 'Markdown') msgType = 'markdown';
      if (mode === '图片') {
        const img = core.services && core.services.image;
        const seg = String(tplKey || 'system.info').split('.');
        const layoutId = seg.join('/');                 // 布局 id 就长这样：system/info
        if (img && typeof img.render === 'function') {
          const r = await img.render(layoutId, {
            playerId: ctx.playerId,
            room: seg[0],
            templateKey: seg.slice(1).join('.'),
            data: Object.assign({}, ctx.data || {}, { 消息: text }),
          });
          if (r && r.ok && r.content) { content = r.content; msgType = 'image'; }
          else {
            msgType = 'markdown';
            log('warn', '[super:' + ctx.key + '] 主动推送出图失败（' + ((r && (r.reason || r.error)) || '未知') + '），本条退回文字推送');
          }
        } else { msgType = 'markdown'; }
      }
      return { msgType: msgType, content: content };
    }

    async function performPush() {
      const pay = await buildPayload();
      return await core.push({ type: t, id: ctx.playerId, msg_type: pay.msgType, content: pay.content, dedupe_key: dedupeKey, dedupe_window: 10 });
    }

    // 延迟入队（默认 3 秒）：被动回复往往还在渲染图片，推送抢在前面会让群里顺序颠倒。
    // 延迟期间**不阻塞逻辑**（setTimeout），顺带把出图也挪出逻辑执行时间，避免撞上 3 秒超时。
    if (delaySec > 0) {
      ctx.data['推送状态'] = '已排程(' + delaySec + 's)';
      ctx.data['推送编号'] = '';
      const label = t;
      setTimeout(function () {
        performPush().then(function (res) {
          if (res && res.error === 'deduped') return;
          if (res && res.ok === false) log('warn', '[super:' + ctx.key + '] 延迟推送失败：' + pushFailReason(res.error));
          else log('info', '[super:' + ctx.key + '] 主动推送已入队（延迟 ' + delaySec + 's，type=' + label + '）');
        }).catch(function (e) { log('warn', '[super:' + ctx.key + '] 延迟推送异常：' + e.message); });
      }, Math.round(delaySec * 1000));
      return { ok: true, status: 'scheduled', scheduled: true };
    }

    const res = await performPush();
    // 回执（2026-09-17 · BUG 记录 3）：push 的返回值以前被直接丢掉，
    // 「没有路由 / 没填内容」这类失败是完全无声的 → 现在失败就报错，成功留下队列号。
    // 唯一例外：被上面那条防抖去重拦下不算失败（否则玩家连点两下会看到一条红色报错）。
    if (res && res.error === 'deduped') {
      ctx.data['推送状态'] = 'deduped';
      ctx.data['推送编号'] = '';
      log('info', '[super:' + ctx.key + '] 主动推送被防抖跳过（10 秒内同样的内容只发一次）');
      return { ok: true, status: 'deduped', deduped: true };
    }
    if (res && res.ok === false) throw new Error('主动推送没有发出：' + pushFailReason(res.error));
    let row = null;
    try {
      row = await core.db.get("SELECT id, status, retry_count, error FROM push_queue WHERE target_id = ? AND content = ? ORDER BY id DESC LIMIT 1", [ctx.playerId, text]);
    } catch (e) { /* 查不到不影响推送本身 */ }
    const status = row ? row.status : 'queued';
    ctx.data['推送状态'] = status;                        // 逻辑里可用 [推送状态] 取
    ctx.data['推送编号'] = row ? row.id : '';              // 逻辑里可用 [推送编号] 取
    log('info', '[super:' + ctx.key + '] 主动推送已入队 #' + (row ? row.id : '?') + ' type=' + t + ' status=' + status + '（送达与否看 push_queue 或 GET /api/push/status）');
    return { ok: true, status: status };
  }

  /** 发消息（S3+ 第三批收敛）：块侧与代码侧原本各写一份「取值 → 记录 emits → 进输出」。
   *  唯一差异是诊断位置标记：块模式记 nodeId、代码模式记行号 —— 由 a.nodeId / a.line 决定。 */
  async function msg_send(a, ctx) {
    const text = String(a.text == null ? '' : a.text);
    // 记录「输出块产出了什么」（2026-09-17）：全是空的时候要告诉用户是哪一块、为什么空
    const rec = { nodeId: a.nodeId, line: a.line, name: '发消息', param: '消息内容', raw: String(a.raw == null ? '' : a.raw), text: text };
    (ctx.emits = ctx.emits || []).push(rec);
    ctx.output.push(text);
    return { ok: true };
  }

  /** 发模板消息（S3+ 第三批收敛）：模板查找 → 找不到就记人话 + 写 [模板错误] → 渲染 → 进输出。 */
  async function tpl_send(a, ctx) {
    const k = String(a.key == null ? '' : a.key);
    const seg = k.split('.');
    const row = await core.db.getMessageTemplate(seg[0], seg.slice(1).join('.'));
    if (!row) {   // 2026-09-18：模板 key 写错以前完全静默（群里不出现、日志里也没有）
      log('warn', '[super] 发模板消息：找不到模板「' + k + '」（检查 key 有没有写错，「模板」页里能看到全部 key）');
      ctx.data['模板错误'] = '找不到模板「' + k + '」';
    }
    const tpl = row ? ((core.getMessageMode() === 2 ? row.markdown_content : row.text_content) || row.text_content || '') : '';
    const txt = await core.renderTemplate(tpl, ctx.data || {}, { escape: false }, ctx.playerId);
    const rec = { nodeId: a.nodeId, line: a.line, name: '发模板消息', param: '模板 key', raw: String(k || ''), text: String(txt == null ? '' : txt) };
    (ctx.emits = ctx.emits || []).push(rec);
    ctx.output.push(txt);
    return { ok: true };
  }

  /** 查内容表（只读白名单）：白名单是唯一来源 lib/superTables.js，越界抛 E_WHITELIST。 */
  async function query_get(a) {
    const table = String(a.table || 'items');
    const by = String(a.by || 'name');
    if (!QUERY_TABLES.includes(table)) { const e = new Error('不允许查询表：' + table); e.code = 'E_WHITELIST'; throw e; }
    const row = await core.db.get('SELECT * FROM ' + table + ' WHERE ' + by + ' = ? LIMIT 1', [a.value]);
    const out = row ? (a.field ? row[String(a.field)] : row) : null;
    return { ok: true, output: out };
  }

  /** 查玩家子表（只读，且必须走 playerDb —— 双库铁律）。 */
  async function player_query(a, ctx) {
    const t = String(a.table || 'player_backpack');
    if (!PLAYER_TABLES.includes(t)) { const e = new Error('不允许查询子表：' + t); e.code = 'E_WHITELIST'; throw e; }
    const pid = a.playerId ? String(a.playerId) : ctx.playerId;
    const rows = await core.db.playerDb.all('SELECT * FROM ' + t + ' WHERE player_id = ? LIMIT 100', [pid]);
    return { ok: true, output: rows };
  }
  return { currency_add, currency_sub, item_add, item_take, check_has_item, push_send, msg_send, tpl_send, query_get, player_query };
}

module.exports = { createOps };
