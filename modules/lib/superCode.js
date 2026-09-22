/**
 * 超级自定义模块 · 中文 DSL 直执行器（代码模式运行时，2026-09-18）
 * =====================================================================
 * 背景（主人原话）：「代码不应该强行依赖块来做开发，块是块 代码是代码」。
 * 现状：运行时只认 custom_logic.graph（块图 IR），代码只是存着 —— 想跑必须先"由代码生成块"。
 * 本文件解决这件事：exec_mode='code' 时，运行时【直接解释执行 custom_logic.code】，
 * **一个字节都不读 custom_logic.graph**（不建图、不连线、不找开始块）。
 *
 * 三层结构：
 *   ① 语句层：中文 DSL（发送/返回/加货币/查询/读玩家…）→ 直接调核心服务执行
 *              语法与编辑器 LogicEditorScript.cs 的 DSL_FLAT / DSL_BRANCH 同源（含老式空格写法）
 *   ② 控制流：如果/否则如果/否则/结束如果、循环 N 次/结束循环、遍历 项 在 列表/结束遍历、
 *              尝试/捕获/结束尝试、跳出循环、等待（2 空格缩进定层级）
 *   ③ 表达式：复用 superExpr 的 createEvaluator（80 个纯函数 + 玩家.x/参数.n/变量.x/节点.n）；
 *              代码模式专属取值函数（玩家(字段)、参数(N)、变量(名)、读玩家(字段)、查询(…)、查玩家(…)、
 *              列表/文本/数字类的取值语句）通过 extraFuncs 注入 —— 见 §7 的说明。
 *
 * Guard 与错误码与块执行器同一套：maxSteps / timeoutMs / 调用深度(depth+1) / E_* 错误码 /
 * 人话报错 + 行号；写入一律走核心服务（core.services.player.*），查询走白名单表。
 */
'use strict';

const crypto = require('crypto');
const { createEvaluator } = require('./superExpr');
// 2026-09-18 四大块批次：写操作的"口径"（变量入库规范化 / 表白名单 / 字段体检）与块模式共用同一套助手。
// 只借纯助手，不碰块定义 —— "代码是代码"这条线没变，但两边不会再各写一份写入口径。
const SB = require('./superBlocks');

/* =====================================================================
 * 0. 与块定义同规则的取值助手
 *    故意不 require superBlocks：代码模式不依赖块库（"代码是代码"）。
 *    规则与 superBlocks.js 逐条对齐，注释标出出处。
 * ===================================================================== */

// 2026-09-18 结构治理：这四个取值助手以前与 superBlocks 是逐字重复的两份
// （注释里互认「同 superBlocks」）—— 改一处忘一处，就会让「裸词判定 / 空值解释」
// 在两套运行时（块图 / 代码模式）里悄悄分叉。现在直接引用 superBlocks 的导出：一处改，两边生效。
const { stripQuotes, BARE_TEXT_RE, VAR_LIKE_RE, explainEmptyExpr } = SB;

/* =====================================================================
 * 1. DSL 语句表 —— 与编辑器 LogicEditorScript.cs 的 DSL_KW / DSL_FLAT / DSL_BRANCH 同源
 *    p：参数按块定义顺序；u:1 = 字面量参数（两侧引号可省）
 *    lg：老式空格写法。rest = 单参数吃掉整行剩余；arg = 按空格切、最后一个参数吃剩余；none = 只认括号
 * ===================================================================== */
// 2026-09-18 结构治理：语句表（关键字/平铺/分支/参数顺序/人话名/取值函数）抽到 lib/superStatements.js，
// 这里只留解释执行的部分。下面解构出来的名字与原来完全同名，导出面不变（wayLang 与契约测试都依赖它）。
const { S_KW, EMPTY_ARG, CLOSERS, S_FLAT, S_BRANCH, S_BY_TYPE, PARAM_KEYS, NAME_OF, HELPER_TYPES } = require('./superStatements');
// 注意：补零 / 四舍五入 故意【不】在这里 —— superExpr 的原生函数表已有同名实现且行为一致，
// 让它们走原生实现，少一层改写。

/* =====================================================================
 * 2. 行匹配（复刻编辑器 dslMatch / dslMatchKw / dslLegacy）
 * ===================================================================== */
// 2026-09-19 S4 第二批（语言层收口）：DSL 解析（行匹配 + 程序解析）搬到 lib/superParse.js，
// 本文件从此专职【解释执行】。下面是保持原名的解构，导出面与调用点都不受影响。
const { splitTop, unquote, dslVal, dslParams, dslLegacy, dslMatchKw, matchLine, parseProgram, hasOutputStmt } = require('./superParse');

/* =====================================================================
 * 4. createRunner：返回 { run(code, ctx), describeNoOutput(code, ctx, logic) }
 * ===================================================================== */
function createRunner(deps) {
  // 2026-09-19 S3+：语句唯一实现层（与块模式共用同一份动作）
  const ops = require('./superOps').createOps({ core: deps.core });
  const core = deps.core;
  const invokeLogic = deps.invokeLogic || (() => ({ ok: false, code: 'E_INTERNAL', error: '调用器未注入' }));
  const log = deps.log || ((lv, msg) => { try { core.log(lv, msg); } catch (e) { /* 日志失败不影响执行 */ } });

  function err(code, msg) { const e = new Error(msg); e.code = code; e.__lined = true; return e; }

  /* ---------------- JS 通道的能力表（白名单，唯一的副作用入口） ----------------
     与中文 DSL 用的是同一批动作（lib/superOps），所以 JS 能做的事**正好等于**作者在中文里能做的事：
     没有直连数据库的口子，没有 fs/网络的口子（沙箱里连 require 都没有）。 */
  function buildJsCaps(c) {
    const S_ = (v) => (v == null ? '' : String(v));
    const cap1 = (v) => (v === undefined || v === null || v === '' ? 1 : Math.floor(Number(v)) || 0);
    // JS 里算出来的值要交给 RUN 那批动作去处理，而它们只认「表达式源码」。
    // 这里复用表达式层自己的临时变量通道（与 rewriteHelpers 同一套：c.vars + 变量.名字），
    // 于是 JS 传值走的是与中文完全一样的取值/校验口径 —— 不另造一条。
    if (!c.vars) c.vars = {};
    async function viaTmp(value, fn) {
      const k = '__js' + (c.__jsSeq = (c.__jsSeq || 0) + 1);
      c.vars[k] = value;
      try { return await fn('变量.' + k); } finally { delete c.vars[k]; }
    }
    /** JS 对象 → DSL 的「字段=值; 字段=值」文本（数据增删改用）。
     *  数字/真假直接写；字符串与对象走临时变量通道 —— 免得引号、逗号把那一层的解析搞歪。 */
    async function withPairs(obj, fn) {
      const o = (obj && typeof obj === 'object') ? obj : {};
      const tmp = [];
      const text = Object.keys(o).map((k) => {
        const v = o[k];
        if (v === null || v === undefined) return k + '=';
        if (typeof v === 'number' || typeof v === 'boolean') return k + '=' + String(v);
        const key = '__jsf' + (c.__jsSeq = (c.__jsSeq || 0) + 1);
        c.vars[key] = v;
        tmp.push(key);
        return k + '=变量.' + key;
      }).join('; ');   // 注意：DSL 的字段分隔符是「分号/换行/中文分号」，**不是逗号**（splitFieldLines 的口径）
      try { return await fn(text); } finally { for (const key of tmp) delete c.vars[key]; }
    }
    return {
      说: (t) => ops.msg_send({ text: S_(t), line: c.line }, c),
      提示: (t) => ops.msg_send({ text: S_(t), line: c.line }, c),
      公告: (t) => ops.push_send({ type: 'broadcast', text: S_(t), rawContent: S_(t), wantMode: 'follow' }, c),
      加货币: (f, n) => ops.currency_add({ field: S_(f) || '货币1', amount: Number(n) || 0 }, c),
      扣货币: (f, n) => ops.currency_sub({ field: S_(f) || '货币1', amount: Number(n) || 0 }, c),
      加物品: (n, k) => ops.item_add({ name: S_(n), count: cap1(k) }, c),
      扣物品: (n, k) => ops.item_take({ name: S_(n), count: cap1(k) }, c),
      有物品: async (n, k) => (await ops.check_has_item({ name: S_(n), count: cap1(k) }, c)).ok,
      读玩家: (f) => (c.player ? c.player[S_(f)] : undefined),
      // 2026-09-19 功能完整化：把中文 DSL 剩下的能力也都开给 JS（口径一律复用 RUN 里那一份）
      等待: (ms) => RUN.wait({ ms: ms === undefined || ms === null ? 1000 : ms }, c),
      推送: (类型, 内容) => RUN.push_send({ type: S_(类型) || 'player', content: S_(内容) }, c),
      发送模板: (key) => RUN.tpl_send({ key: S_(key) }, c),
      完成任务: (名) => RUN.quest_complete({ name: S_(名) }, c),
      传送: (地图) => RUN.teleport({ map: S_(地图) }, c),
      删除变量: (名) => RUN.var_del({ name: S_(名) }, c),
      新建数据: async (表, 值) => withPairs(值, (fields) => RUN.data_create({ table: S_(表), fields }, c)),
      修改数据: async (表, 主键值, 值) => withPairs(值, (fields) => RUN.data_update({ table: S_(表), rowKey: S_(主键值), fields }, c)),
      删除数据: (表, 主键值) => RUN.data_delete({ table: S_(表), rowKey: S_(主键值) }, c),
      // 2026-09-19 细致化：能力面对齐中文侧 —— 设玩家 / 变量 / 多轮状态 / 发出事件
      设玩家: (f, v) => viaTmp(v, (src) => RUN.player_set({ field: S_(f), value: src }, c)),
      设置变量: (n, v, 说明) => viaTmp(v, (src) => RUN.var_set({ name: S_(n), value: src, desc: S_(说明) }, c)),
      读变量: async (n) => (await RUN.var_get({ name: S_(n) }, c)).output,
      进入状态: (n, 秒) => RUN.enter_state({ name: S_(n), timeout: (秒 === undefined ? 60 : 秒) }, c),
      结束状态: (n) => RUN.exit_state({ name: S_(n) }, c),
      发出事件: (n) => RUN.event_emit({ name: S_(n) }, c),
      查询: async (table, by, value, field) => (await ops.query_get({ table: S_(table), by: S_(by) || 'name', value: value, field: field === undefined ? '' : S_(field) })).output,
      查玩家: async (table, pid) => (await ops.player_query({ table: S_(table), playerId: pid ? S_(pid) : '' }, c)).output,
      日志: (t) => { log('info', '[super:' + c.key + '] JS 日志：' + S_(t)); },
    };
  }

  /** 位置文字（2026-09-18）：.way 是多文件工程，报错必须说清是【哪个文件】第几行 */
  function where(line, file) {
    const fn = file ? String(file) : '';
    return (fn ? fn + ' ' : '') + '第 ' + line + ' 行';
  }
  /** 给错误补上行号（只补一次，嵌套调用不会叠成一串） */
  function withLine(e, line, kw, file) {
    if (!e || e.__lined) return e;
    if (!(e instanceof Error)) e = new Error(String(e));
    e.message = where(line, file) + (kw ? '「' + kw + '」' : '') + '：' + e.message;
    e.__lined = true;
    return e;
  }
  /** 从节点上补位置（node 带 line/kw/file） */
  function withLineN(e, node, kw) { return withLine(e, node && node.line, kw || (node && node.kw), node && node.file); }

  /** 主动推送失败原因 → 人话（文案与 superBlocks.pushFailReason 一致） */
  function pushFailReason(e0) {
    const s = String(e0 == null ? '' : e0);
    if (s === 'no route') return '这个玩家还没有跟插件通过消息（player_routes 里没有他的路由），核心不知道该推给谁';
    if (s === 'no plugin url') return '还没有任何玩家建立路由，核心不知道插件的地址（先让插件发一条消息过来）';
    if (s === 'content empty') return '推送内容为空（表达式没求出东西）';
    if (s === 'deduped') return '被去重规则拦下了（60 秒内同样的内容只推一次）';
    return s || '未知原因';
  }

  /* ---------------- 4.1 表达式求值（§7 的重写层在此） ---------------- */
  const evaluator = createEvaluator({
    getVar: (name, c) => core.getVariableValue(name, c.playerId, 0, c.data || {}),
    call: (key, args, c) => invokeLogic(key, { playerId: c.playerId, args, source: 'call', depth: (c.depth || 0) + 1 }),
    // .way：表达式里也能直接调用户函数（int x = 发奖(名字, 2);），函数表在 ctx.funcs 上
    extraFactory: (name, c) => ((c && c.funcs && c.funcs[name]) ? ((args, cx) => callUserFn(name, args, cx && cx.line, cx && cx.file, cx)) : null),
    listExtra: (c) => ((c && c.funcs) ? Object.keys(c.funcs) : []),
    // superExpr v2 还没有消费 extraFuncs（不动那个文件）；这里先把注入点留着，
    // 实际解析走下面的 runExpr 改写层（名字 → 语句执行 → 值），两条路效果一致。
    extraFuncs: HELPER_TYPES,
  });

  /** 递归：把 名(参数) 形式的代码模式取值函数改写成 变量.__scN，交给表达式引擎 */
  async function rewriteHelpers(src, c, tmp) {
    const spans = [];
    let i = 0; let quote = null;
    while (i < src.length) {
      const ch = src.charAt(i);
      if (quote) { if (ch === quote) quote = null; i++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
      if (/[A-Za-z0-9_\u4e00-\u9fa5]/.test(ch)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(src.charAt(j))) j++;
        const name = src.slice(i, j);
        let k = j;
        while (k < src.length && (src.charAt(k) === ' ' || src.charAt(k) === '\t')) k++;
        if (src.charAt(k) === '(' && HELPER_TYPES[name]) {
          // 找配对的右括号（跳过字符串里的括号）
          let depth = 0; let q2 = null; let end = -1;
          for (let x = k; x < src.length; x++) {
            const cx = src.charAt(x);
            if (q2) { if (cx === q2) q2 = null; continue; }
            if (cx === '"' || cx === "'") { q2 = cx; continue; }
            if (cx === '(') depth++;
            else if (cx === ')') { depth--; if (depth === 0) { end = x; break; } }
          }
          if (end > 0) {
            spans.push({ start: i, end: end + 1, name: name, argsText: src.slice(k + 1, end) });
            i = end + 1;
            continue;
          }
        }
        i = j;
        continue;
      }
      i++;
    }
    if (!spans.length) return src;
    let out = src;
    for (let n = spans.length - 1; n >= 0; n--) {
      const sp = spans[n];
      const val = await callHelper(sp.name, sp.argsText, c);
      const key = '__sc' + (++c.__scSeq);
      c.vars[key] = val;
      tmp.push(key);
      out = out.slice(0, sp.start) + '变量.' + key + out.slice(sp.end);
    }
    return out;
  }

  /** 表达式求值：先解析代码模式取值函数，再交给表达式引擎 */
  async function runExpr(src, c) {
    const s = String(src == null ? '' : src);
    if (!s.trim()) return null;
    c.__scSeq = c.__scSeq || 0;
    const tmp = [];
    try {
      const rewritten = await rewriteHelpers(s, c, tmp);
      return await evaluator.eval(rewritten, c);
    } finally {
      for (const k of tmp) delete c.vars[k];
    }
  }
  async function exprOf(raw, c) { return await runExpr(raw, c); }

  /** 数字：纯数字字面量直接用，含运算符才求值（同 superBlocks.numOf） */
  async function numOf(raw, c, def) {
    let v = (raw !== undefined && raw !== null && raw !== '') ? raw : (def != null ? def : 0);
    v = String(v).trim();
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    const r = await runExpr(v, c);
    return Number(r) || 0;
  }

  /** 文本型表达式取值 = 普通表达式 + 裸词兜底 + 模板渲染兜底（同 superBlocks.exprText） */
  async function textOf(raw, c) {
    const src = String(raw == null ? '' : raw).trim();
    const v = await runExpr(src, c);
    if (v !== null && v !== undefined && v !== '') {
      if (Array.isArray(v)) return v.join('、');
      if (typeof v === 'object') { /* 落到下面的兜底 */ } else return v;
    }
    if (!src) return v;
    if (BARE_TEXT_RE.test(src) && !VAR_LIKE_RE.test(src)) return src;
    if (/[\[{]/.test(src)) {
      try {
        const r = await core.renderTemplate(src, c.data || {}, { escape: false }, c.playerId || null, null);
        const out = String(r == null ? '' : r).trim();
        if (out && out !== src) return out;
      } catch (e) { /* 渲染失败保持原样，交给"没有输出"诊断说清楚 */ }
    }
    return v;
  }

  /**
   * 赋值用取值：与 textOf 同一套兜底，但【数组/对象原样保留】。
   * 块模式的「变量赋值」走 exprText → 列表会被 join('、') 成字符串，代码模式里那等于"存不了列表"，
   * 所以这里保留原值（发送/推送这类输出字段仍与块完全一致地 join）。
   */
  async function valueOf(raw, c) {
    const src = String(raw == null ? '' : raw).trim();
    const v = await runExpr(src, c);
    if (v !== null && v !== undefined && v !== '') return v;
    if (!src) return v;
    if (BARE_TEXT_RE.test(src) && !VAR_LIKE_RE.test(src)) return src;
    if (/[\[{]/.test(src)) {
      try {
        const r = await core.renderTemplate(src, c.data || {}, { escape: false }, c.playerId || null, null);
        const out = String(r == null ? '' : r).trim();
        if (out && out !== src) return out;
      } catch (e) { /* 渲染失败保持原样 */ }
    }
    return v;
  }

  /** 字面量参数（同 superBlocks.lit）：不求值 + 剥离引号 */
  function litOf(p, k, def) {
    const v = (p[k] !== undefined && p[k] !== null && p[k] !== '') ? p[k] : (def != null ? def : '');
    return stripQuotes(v);
  }

  /** 把 名(参数) 当函数用：按语句的参数顺序填位 → 执行 → 取值 */
  async function callHelper(name, argsText, c) {
    const type = HELPER_TYPES[name];
    if (!type) throw new Error('不认识「' + name + '」（代码模式取值函数）');
    const parts = splitTop(argsText);
    if (type === '__args') {
      const raw = String(parts[0] == null ? '' : parts[0]).trim();
      const nm = unquote(raw);
      if (nm === '个数' || nm === '数量') return (c.args || []).length;
      const n = Number(nm);
      if (!n) return (c.args || []);
      return (c.args || [])[n - 1];
    }
    if (type === '__var') return (c.vars || {})[unquote(parts[0] == null ? '' : parts[0])];
    const keys = PARAM_KEYS[type] || [];
    const params = {};
    keys.forEach((k, idx) => { params[k] = dslVal(parts[idx] == null ? '' : parts[idx]); });
    const fn = RUN[type];
    if (!fn) throw new Error('「' + name + '」还不能当表达式用');
    const before = c.line;
    c.line = 0;                                   // 函数形态没有行号，别把上层行号带进来
    let res;
    try { res = await fn(params, c, 0); } finally { c.line = before; }
    if (res && res.output !== undefined) return res.output;
    if (res && (res.port === 'true' || res.port === 'false')) return res.port === 'true';
    return undefined;
  }

  /* ---------------- 4.2 语句执行表：一条语句 = 一处直接实现（不经块图 IR） ---------------- */
  /** 「字段=值」解析（代码模式侧）：切行用 superBlocks 的 splitFieldLines，值在这里求 */
  async function fieldPairsCode(raw, c) {
    const out = [];
    for (const f of SB.splitFieldLines(SB.stripQuotes(raw))) {   // 代码模式里整串可能带外层引号
      let v = null;
      try { v = await valueOf(f.valRaw, c); } catch (e) { v = null; }
      if (v === null || v === undefined || v === '') {
        const s = String(f.valRaw);
        if (SB.BARE_TEXT_RE.test(s) && !SB.VAR_LIKE_RE.test(s)) v = s;   // 裸词就是文本
        else if (/^[\[{]/.test(s)) v = s;                                // 手写 JSON 原样
        else v = '';
      } else if (Array.isArray(v) || typeof v === 'object') {
        v = JSON.stringify(v);
      }
      out.push({ col: f.col, val: v });
    }
    return out;
  }
  /** 写操作体检：白名单 + 字段存在（与块模式同一份助手，口径不会漂） */
  async function writeCheck(table, pairs) {
    const t = String(table == null ? '' : table).trim();
    if (SB.WRITE_TABLES.indexOf(t) < 0) {
      const e = new Error('不允许写入表：' + t + '（可写：' + SB.WRITE_TABLES.join('、') + '）');
      e.code = 'E_WHITELIST'; throw e;
    }
    const info = await SB.tableInfo(core.db, t);
    if (!info.cols.size) { const e = new Error('读不到表结构：' + t); e.code = 'E_TABLE'; throw e; }
    SB.checkWriteColumns(t, info.cols, pairs);
    return info;
  }

  const RUN = {
    // —— 输出 ——
    // 2026-09-19 S3+ 第三批：动作体收敛到 lib/superOps.js 的 msg_send（块模式共用同一份）
    msg_send: async (p, c, line) => {
      await ops.msg_send({ text: await textOf(p.text, c), raw: String(p.text || ''), line }, c);
      return {};
    },
    // 2026-09-19 S3+ 第三批：动作体收敛到 lib/superOps.js 的 tpl_send
    tpl_send: async (p, c, line) => {
      await ops.tpl_send({ key: litOf(p, 'key', ''), line }, c);
      return {};
    },
    return_text: async (p, c) => {
      const v = await textOf(p.value, c);
      c.output.push(String(v == null ? '' : v));
      c.stopped = true;
      return { stop: true };
    },
    return_tpl: async (p, c) => {
      c.outputTemplate = litOf(p, 'key', '');
      c.stopped = true;
      return { stop: true };
    },
    // 2026-09-19 S3+ 第二批：约 65 行的动作体收敛到 lib/superOps.js 的 push_send（块模式共用同一份）
    // DSL 只写「推送(类型, 内容)」两个参数，其余用块定义里的默认值（跟随全局 / system.info / 延迟 3 秒）
    push_send: async (p, c) => {
      const r = await ops.push_send({
        type: litOf(p, 'type', 'player'),
        text: await textOf(p.content, c),
        rawContent: p.content || '',
        wantMode: '跟随全局',
        tplKey: 'system.info',
        delaySec: 3,
      }, c);
      return { output: r.status };
    },
    log: async (p, c) => {
      const t = await textOf(p.text, c);
      log('info', '[super:' + c.key + '] ' + String(t == null ? '' : t));
      return {};
    },
    event_emit: async (p, c) => {
      const name = String(litOf(p, 'name', '自定义事件') || '').trim();
      if (!name) throw new Error('「发出事件」没有填事件名');
      let payload = [];
      const raw = String(p.data == null ? '' : p.data).trim();
      if (raw) {
        const v = await exprOf(p.data, c);
        if (Array.isArray(v)) payload = v.slice();
        else if (v !== null && v !== undefined && v !== '') payload = [v];
      }
      const args = [c.playerId].concat(payload);   // 第一个参数固定是发事件的玩家
      try { Promise.resolve(core.emit(name, ...args)).catch(() => {}); } catch (e) { /* 广播失败不影响主流程 */ }
      return {};
    },

    // —— 玩家数据（写入一律走核心服务） ——
    player_get: async (p, c) => {
      const f = litOf(p, 'field', '昵称');
      return { output: (c.player || {})[f] };
    },
    player_set: async (p, c) => {
      const f = litOf(p, 'field', '');
      if (!f) throw new Error('「设玩家」没有填字段名');
      const v = await exprOf(p.value, c);
      const res = await core.services.player.modify({ playerId: c.playerId, changes: { [f]: { set: v } }, source: 'super:' + c.key });
      if (!res || !res.success) throw new Error((res && res.message) || '改字段失败');
      c.playerDirty = true;
      return {};
    },
    // 2026-09-19 S3+：动作体搬到 lib/superOps.js（块与代码共用一份），这里只做取值与返回形状
    currency_add: async (p, c) => {
      await ops.currency_add({ field: litOf(p, 'field', '货币1'), amount: await numOf(p.amount, c, 1) }, c);
      return {};
    },
    currency_sub: async (p, c) => {   // S3+：动作在 superOps
      await ops.currency_sub({ field: litOf(p, 'field', '货币1'), amount: await numOf(p.amount, c, 1) }, c);
      return {};
    },
    item_add: async (p, c) => {   // S3+：动作在 superOps（代码模式仍保留「必须填物品名」的额外校验）
      const name = litOf(p, 'name', '');
      if (!name) throw new Error('「加物品」没有填物品名');
      await ops.item_add({ name, count: await numOf(p.count, c, 1) }, c);
      return {};
    },
    item_take: async (p, c) => {   // S3+：动作在 superOps
      const name = litOf(p, 'name', '');
      if (!name) throw new Error('「扣物品」没有填物品名');
      await ops.item_take({ name, count: await numOf(p.count, c, 1) }, c);
      return {};
    },
    check_has_item: async (p, c) => {   // S3+：动作在 superOps
      const r = await ops.check_has_item({ name: litOf(p, 'name', ''), count: await numOf(p.count, c, 1) }, c);
      return { port: r.ok ? 'true' : 'false', output: r.ok };
    },
    teleport: async (p, c) => {
      const m = litOf(p, 'map', '');
      await core.services.player.modify({ playerId: c.playerId, changes: { '当前地图': { set: String(m) } }, source: 'super:' + c.key });
      c.playerDirty = true;
      return {};
    },
    quest_complete: async (p, c) => {
      const name = litOf(p, 'name', '');
      const qm = core.getModule('quest');
      if (qm && typeof qm.completeQuest === 'function') await qm.completeQuest(c.playerId, String(name), core.services);
      c.playerDirty = true;
      return {};
    },
    assign: async (p, c) => {
      const v = await valueOf(p.value, c);
      c.vars[litOf(p, 'name', '变量')] = v;
      return { output: v };
    },

    // —— 变量读写 / 数据增删改 / 多轮状态（2026-09-18 四大块批次；与 superBlocks 同一套口径） ——
    var_get: async (p, c) => {
      const name = SB.stripSysPrefix(litOf(p, 'name', ''));
      if (!name) throw new Error('「读变量」没写变量名');
      const v = await core.getVariableValue(name, c.playerId, 0, c.data || {});
      const isSystem = SB.isSysVar(core, name);
      const isCustom = !!(core.customVariables && typeof core.customVariables.has === 'function' && core.customVariables.has(name));
      if ((v === undefined || v === null || v === '') && !isSystem && !isCustom) {
        throw new Error('没有叫「' + name + '」的变量 —— 先建一个，或者检查名字有没有写错');
      }
      c.data['变量值'] = v;
      return { output: v };
    },
    var_set: async (p, c) => {
      const name = SB.stripSysPrefix(litOf(p, 'name', ''));
      if (!name) throw new Error('「设置变量」没写变量名');
      if (SB.isSysVar(core, name)) throw new Error('「' + name + '」是系统变量（模块提供，只读）—— 换一个名字');
      const rawSrc = String(p.value == null ? '' : p.value).trim();
      let v = null;
      try { v = await valueOf(p.value, c); } catch (e) { v = null; }   // 值里写 [玩家昵称] 时表达式引擎会抛，兜住
      if ((v === null || v === undefined || v === '') && /[\[{]/.test(rawSrc)) {
        try {
          const rr = await core.renderTemplate(rawSrc, c.data || {}, { escape: false }, c.playerId || null, null);
          const rt = String(rr == null ? '' : rr).trim();
          if (rt && rt !== rawSrc) v = rt;
        } catch (e) { /* 渲染失败就按原文本处理 */ }
      }
      const desc = String(litOf(p, 'desc', '') || '');
      const store = SB.normalizeVarValue(rawSrc, v);
      await core.setCustomVariable(name, store, desc);
      try { await core.db.saveVariable(name, store, desc); } catch (e) { /* 落库失败不影响本次执行 */ }
      const shown = (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
      c.data['变量值'] = shown;
      return { output: shown };
    },
    var_del: async (p, c) => {
      const name = SB.stripSysPrefix(litOf(p, 'name', ''));
      if (!name) throw new Error('「删除变量」没写变量名');
      if (SB.isSysVar(core, name)) throw new Error('「' + name + '」是系统变量（模块提供，删不掉）');
      let existed = false;
      try { existed = !!(await core.db.getVariable(name)); } catch (e) { existed = false; }
      if (core.customVariables && typeof core.customVariables.delete === 'function' && core.customVariables.delete(name)) existed = true;
      await core.db.deleteVariable(name);
      return { nextPort: 'next', output: existed };
    },
    data_create: async (p, c) => {
      const table = String(litOf(p, 'table', 'items'));
      const pairs = await fieldPairsCode(p.fields, c);
      if (!pairs.length) throw new Error('「新建数据」至少要写一个 字段=值');
      const info = await writeCheck(table, pairs);
      if (!info.pk) throw new Error('表 ' + table + ' 没有主键，不能新建');
      const pkPair = pairs.find((x) => x.col === info.pk);
      if (!pkPair) throw new Error('新建数据必须给出主键字段「' + info.pk + '」（例：' + info.pk + '=名字）');
      const existed = await core.db.get('SELECT * FROM ' + table + ' WHERE ' + info.pk + ' = ? LIMIT 1', [pkPair.val]);
      if (existed) throw new Error('表 ' + table + ' 里已经有「' + pkPair.val + '」了 —— 要改它请用「修改数据」');
      const cols = pairs.map((x) => x.col);
      await core.db.run('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')', pairs.map((x) => x.val));
      c.data['数据'] = { 表: table, 主键: info.pk, 值: pkPair.val, 操作: '新建' };
      return { output: pkPair.val };
    },
    data_update: async (p, c) => {
      const table = String(litOf(p, 'table', 'items'));
      const pairs = await fieldPairsCode(p.fields, c);
      if (!pairs.length) throw new Error('「修改数据」没写要改成什么（字段=值）');
      const info = await writeCheck(table, pairs);
      const keyVal = await textOf(p.rowKey, c);
      if (keyVal === '' || keyVal === null || keyVal === undefined) throw new Error('「修改数据」没写主键值（要改哪一行）');
      const existed = await core.db.get('SELECT * FROM ' + table + ' WHERE ' + info.pk + ' = ? LIMIT 1', [keyVal]);
      if (!existed) throw new Error('表 ' + table + ' 里没有「' + keyVal + '」这一行（主键 ' + info.pk + '）');
      await core.db.run('UPDATE ' + table + ' SET ' + pairs.map((x) => x.col + ' = ?').join(', ') + ' WHERE ' + info.pk + ' = ?', pairs.map((x) => x.val).concat([keyVal]));
      c.data['数据'] = { 表: table, 主键: info.pk, 值: keyVal, 操作: '修改' };
      return { output: keyVal };
    },
    data_delete: async (p, c) => {
      const table = String(litOf(p, 'table', 'items'));
      const info = await writeCheck(table, []);
      const keyVal = await textOf(p.rowKey, c);
      if (keyVal === '' || keyVal === null || keyVal === undefined) throw new Error('「删除数据」没写主键值（删哪一行）');
      const existed = await core.db.get('SELECT * FROM ' + table + ' WHERE ' + info.pk + ' = ? LIMIT 1', [keyVal]);
      if (!existed) throw new Error('表 ' + table + ' 里没有「' + keyVal + '」这一行（主键 ' + info.pk + '）');
      await core.db.run('DELETE FROM ' + table + ' WHERE ' + info.pk + ' = ?', [keyVal]);
      c.data['数据'] = { 表: table, 主键: info.pk, 值: keyVal, 操作: '删除' };
      return { output: keyVal };
    },
    enter_state: async (p, c) => {
      if (!c.playerId) throw new Error('「进入状态」需要有玩家（定时/系统级触发没有玩家）');
      if (typeof deps.stateEnter !== 'function') throw new Error('状态路由没接上（模块没注入 stateEnter）');
      const nm = String(litOf(p, 'name', '')).trim() || '对话';
      const sec = await numOf(p.timeout, c, 0);
      await deps.stateEnter(c.playerId, { logicKey: c.key, name: nm, timeoutSec: Number(sec) || 0 });
      c.data['状态名'] = nm;
      return { output: nm };
    },
    exit_state: async (p, c) => {
      if (!c.playerId || typeof deps.stateExit !== 'function') return { output: false };
      const nm = String(litOf(p, 'name', '')).trim();
      const done = await deps.stateExit(c.playerId, nm);
      c.data['状态名'] = '';
      return { output: done };
    },

    // —— 调用 / 查询 ——
    call: async (p, c) => {
      let key = litOf(p, 'key', '');
      if (!key) throw new Error('「调用」没有填逻辑 key');
      let args;
      // 2026-09-19 修：作者按文档写「调用 播报("维护中")」「调用 js:工具.发奖("甲", 5)」时，
      // 行解析会把括号里的第一个逗号当参数分隔 → key 变成「播报("维护中"」、args 变成「5)」。
      // 这里把切歪的两段拼回来再按顶层逗号拆，逐个求值 —— 逻辑调用与 JS 调用走同一条修好的路。
      const glued = (key + ' ' + String(p.args == null ? '' : p.args)).trim();
      const mp = key.indexOf('(') >= 0 ? /^([^\s(]+)\s*\(([\s\S]*)\)$/.exec(glued) : null;
      if (mp) {
        key = mp[1].trim();
        args = [];
        for (const q of splitTop(mp[2]).map((s) => s.trim()).filter((s) => s !== '')) {
          const v = await runExpr(q, c);
          args.push(v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
        }
      } else {
        const argsRaw = await exprOf(p.args, c);
        if (Array.isArray(argsRaw)) args = argsRaw.map((x) => (x == null ? '' : String(x)));
        else args = String(argsRaw == null ? '' : argsRaw).split(',').map((s) => s.trim()).filter((s) => s !== '');
      }
      // 2026-09-19 · JS 通道（作者面 v2 的 R4/R6）：key 以 js: 开头 → 交给 JS 沙箱，
      // 不当逻辑 key 处理。语句表/块/契约一个字都不用动（还是「调用」这条语句）。
      const jsSpec = /^jss*[:：]s*/i.test(key) ? key.replace(/^jss*[:：]s*/i, '') : '';
      if (jsSpec) {
        if (typeof deps.jsCall !== 'function') throw new Error('JS 通道没装配（重启核心后再试）');
        const r = await deps.jsCall({ spec: jsSpec, args, ctx: c, caps: buildJsCaps(c) });
        const v = r && r.value;
        return { output: (v === undefined || v === null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v) };
      }
      const out = await invokeLogic(key, { playerId: c.playerId, args, source: 'call', depth: (c.depth || 0) + 1 });
      if (out && !out.ok) {
        const e = new Error('调用 ' + key + ' 失败: ' + (out.error || ''));
        e.code = out.code || 'E_INTERNAL';      // 保留 E_NOT_FOUND / E_DISABLED / E_DEPTH 这种真实原因
        throw e;
      }
      return { output: out && out.text };
    },
    // 2026-09-19 S3+ 第四批：动作体收敛到 lib/superOps.js 的 query_get（块模式共用同一份）
    query_get: async (p, c) => {
      const r = await ops.query_get({ table: litOf(p, 'table', 'items'), by: litOf(p, 'by', 'name'), value: await textOf(p.value, c), field: litOf(p, 'field', '') });
      return { output: r.output };
    },
    player_query: async (p, c) => {   // S3+ 第四批：动作在 superOps.player_query
      const r = await ops.player_query({ table: litOf(p, 'table', 'player_backpack'), playerId: litOf(p, 'playerId', '') }, c);
      return { output: r.output };
    },

    // —— 流程（汇合在代码模式里结构上就是分支，直接放行；等待/跳出循环见解释器） ——
    join: async () => ({}),
    break_loop: async () => ({ stop: true, brk: true }),
    wait: async (p, c) => {
      const ms = Math.max(0, Math.min(5000, await numOf(p.ms, c, 1000)));
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      return {};
    },
    condition: async (p, c) => {
      const v = await exprOf(p.expr, c);
      return { port: v ? 'true' : 'false', output: !!v };
    },
    elseif: async (p, c) => {
      const v = await exprOf(p.expr, c);
      return { port: v ? 'true' : 'false', output: !!v };
    },
    math_compare: async (p, c) => {
      const a = await exprOf(p.a, c);
      const b = await exprOf(p.b, c);
      const op = litOf(p, 'op', '>=');
      const r = op === '>=' ? a >= b : op === '>' ? a > b : op === '<=' ? a <= b : op === '<' ? a < b : op === '!=' ? a != b : a == b;
      return { port: r ? 'true' : 'false', output: !!r };
    },
    list_contains: async (p, c) => {
      const l = await exprOf(p.list, c);
      const v = await textOf(p.value, c);
      const arr = Array.isArray(l) ? l : [];
      const ok = arr.indexOf(v) >= 0;
      return { port: ok ? 'true' : 'false', output: ok };
    },

    // —— 列表 ——
    list_make: async (p, c) => {
      const v = await exprOf(p.items, c);
      return { output: Array.isArray(v) ? v : [] };
    },
    list_append: async (p, c) => {
      const l = await exprOf(p.list, c);
      const v = await textOf(p.value, c);
      const a = (Array.isArray(l) ? l : []).slice();
      a.push(v);
      return { output: a };
    },
    list_get: async (p, c) => {
      const l = await exprOf(p.list, c);
      const want = Math.floor(await numOf(p.index, c, 1));
      const a = Array.isArray(l) ? l : [];
      const i = Math.max(0, want - 1);
      if (i >= a.length) throw new Error('列表只有 ' + a.length + ' 项，取不到第 ' + want + ' 项（「取第N项」的索引从 1 起）');
      return { output: a[i] };
    },
    list_len: async (p, c) => {
      const l = await exprOf(p.list, c);
      return { output: (Array.isArray(l) ? l : []).length };
    },
    list_range: async (p, c) => {
      const a = Math.floor(await numOf(p.from, c, 1));
      const b = Math.floor(await numOf(p.to, c, 5));
      const span = Math.abs(b - a) + 1;
      if (span > 10000) throw new Error('数字序列太长：' + a + '→' + b + ' 一共 ' + span + ' 项，最多 10000 项 —— 缩小范围，或改用「循环 次数」');
      const out = [];
      const step = a <= b ? 1 : -1;
      for (let x = a; step > 0 ? x <= b : x >= b; x += step) out.push(x);
      return { output: out };
    },

    // —— 文本 ——
    text_replace: async (p, c) => {
      const tv = await textOf(p.text, c);
      const t = String(tv == null ? '' : tv);
      const f = String(litOf(p, 'from', ''));
      const to = String(litOf(p, 'to', ''));
      return { output: f === '' ? t : t.split(f).join(to) };
    },
    text_slice: async (p, c) => {
      const tv = await textOf(p.text, c);
      const t = String(tv == null ? '' : tv);
      const s = Math.max(0, Math.floor(await numOf(p.start, c, 1)) - 1);
      const cnt = Math.max(0, Math.floor(await numOf(p.count, c, 1)));
      return { output: t.slice(s, s + cnt) };
    },
    text_case: async (p, c) => {
      const tv = await textOf(p.text, c);
      const t = String(tv == null ? '' : tv);
      const m = litOf(p, 'mode', '大写');
      return { output: m === '小写' ? t.toLowerCase() : t.toUpperCase() };
    },
    text_find: async (p, c) => {
      const tv = await textOf(p.text, c);
      const t = String(tv == null ? '' : tv);
      const sub = String(litOf(p, 'sub', '') == null ? '' : litOf(p, 'sub', ''));
      return { output: t.indexOf(sub) };
    },
    text_pad: async (p, c) => {
      const vv = await textOf(p.value, c);
      let s = String(vv == null ? '' : vv);
      const L = Math.max(0, Math.floor(await numOf(p.len, c, 2)));
      while (s.length < L) s = '0' + s;
      return { output: s };
    },
    text_concat: async (p, c) => {
      const a = await textOf(p.a, c);
      const b = await textOf(p.b, c);
      return { output: String(a == null ? '' : a) + String(b == null ? '' : b) };
    },

    // —— 数字 ——
    math_op: async (p, c) => {
      const a = Number(await exprOf(p.a, c)) || 0;
      const b = Number(await exprOf(p.b, c)) || 0;
      const op = litOf(p, 'op', '+');
      if ((op === '/' || op === '%') && b === 0) throw new Error('除数是 0：' + a + ' ' + op + ' 0 算不出来 —— 检查「第二个数」，或者先用「如果」判断它不为 0');
      const r = op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : op === '%' ? a % b : a + b;
      if (!Number.isFinite(r)) throw new Error('算出来的不是数字（' + a + ' ' + op + ' ' + b + '）—— 检查两个数里是不是混进了文字');
      return { output: r };
    },
    math_round: async (p, c) => {
      const v = Number(await exprOf(p.value, c)) || 0;
      const d = Math.min(10, Math.max(0, Math.floor(await numOf(p.digits, c, 0))));
      const pw = Math.pow(10, d);
      return { output: Math.round(v * pw) / pw };
    },
    math_rand: async (p, c) => {
      const a = Math.floor(await numOf(p.a, c, 1));
      const b = Math.floor(await numOf(p.b, c, 100));
      const lo = Math.min(a, b); const hi = Math.max(a, b);
      return { output: lo + Math.floor(Math.random() * (hi - lo + 1)) };
    },
  };

  /* ---------------- 4.3 解释器（Guard：步数 / 超时 / 行号） ---------------- */
  function tick(c, line, file) {
    c.steps++;
    if (c.steps > c.maxSteps) throw err('E_STEPS', where(line, file) + '：超过最大步数 ' + c.maxSteps);
    if (Date.now() - c.startTime > c.timeoutMs) throw err('E_TIMEOUT', where(line, file) + '：执行超时（' + c.timeoutMs + 'ms）');
  }
  /** 写后刷新玩家（与块执行器 execNode 里的做法完全一致） */
  async function flushPlayer(c) {
    if (!c.playerDirty) return;
    try { c.player = (await core.db.getPlayer(c.playerId)) || c.player; } catch (e) { /* 取不到就沿用旧对象 */ }
    c.playerDirty = false;
  }

  /* ---------------- .way 用户函数（2026-09-18） ----------------
   * 作用域：每个函数一个独立作用域（全局变量照抄进帧里，改的是帧里的副本，与 C 的"传值"直觉一致）。
   * 护栏：调用深度、参数个数、步数/超时都走同一套 tick 与错误码，报错带文件名 + 行号。 */
  const MAX_FN_DEPTH = 24;
  async function callUserFn(name, args, line, file, c) {
    const f = c.funcs && c.funcs[name];
    if (!f) throw err('E_NOT_FOUND', where(line, file) + '：没有函数「' + name + '」（检查名字，或跨文件要先 #引用 + 声明）');
    if ((c.callDepth || 0) >= MAX_FN_DEPTH) throw err('E_DEPTH', where(line, file) + '：函数调用层数太深（最多 ' + MAX_FN_DEPTH + ' 层）—— 检查是不是自己调自己却没写出口');
    const want = (f.params || []).length;
    if ((args || []).length !== want) {
      throw err('E_ARITY', where(line, file) + '：函数「' + name + '」要 ' + want + ' 个参数（' + (f.params || []).join('、') + '），这次给了 ' + (args || []).length + ' 个');
    }
    const savedVars = c.vars;
    const frame = {};
    for (const k of Object.keys(c.globals || {})) frame[k] = c.globals[k];
    (f.params || []).forEach((p, i) => { frame[p] = args[i]; });
    c.vars = frame;
    c.callDepth = (c.callDepth || 0) + 1;
    const savedRet = c.__ret;
    c.__ret = undefined;
    try {
      await execList(f.body || [], c);
      return c.__ret;
    } finally {
      c.callDepth--;
      c.vars = savedVars;
      c.__ret = savedRet;
    }
  }

  async function execSimple(node, c) {
    tick(c, node.line, node.file);
    if (node.k === 'unknown' || !node.type) throw err('E_SYNTAX', where(node.line, node.file) + '：认不出这一行「' + node.raw + '」—— 写法是「关键字(参数, 参数)」，分支/循环见「如果…结束如果」「循环 N 次…结束循环」');
    if (node.params && node.params.__extra) {
      const spec = S_BY_TYPE[node.type];
      throw err('E_SYNTAX', where(node.line, node.file) + '「' + (node.kw || node.type) + '」参数多了 ' + node.params.__extra + ' 个 —— 这条语句只吃 '
        + ((spec && spec.p.length) || 0) + ' 个参数；想一次写多个值，请放进列表，例如 建列表(["甲","乙"])');
    }
    const fn = RUN[node.type];
    if (!fn) throw err('E_SYNTAX', where(node.line, node.file) + '：代码模式还不支持「' + (node.kw || node.type) + '」这条语句');
    let res;
    try { res = await fn(node.params, c, node.line); }
    catch (e) { throw withLineN(e, node); }
    res = res || {};
    c.trace = { mode: 'code', line: node.line, type: node.type, name: NAME_OF[node.type] || node.type, kw: node.kw || '', params: node.params, stopBlock: null, deadEnd: null };
    if (res.output !== undefined) c.nodeOut['行' + node.line] = res.output;
    await flushPlayer(c);
    if (res.stop) {
      c.trace.stopBlock = { line: node.line, type: node.type, name: NAME_OF[node.type] || node.type, params: node.params };
      return res.brk ? 'break' : 'stop';
    }
    return 'next';
  }

  // 控制信号（2026-09-18 · .way）：'next' 继续 / 'stop' 整条逻辑结束 / 'break' 跳出循环 /
  // 'continue' 跳到下一轮 / 'return' 从函数返回（带上 c.__ret 的值）。除 continue 外一律往上传。
  async function execList(nodes, c) {
    for (const n of nodes) {
      if (c.stopped) return 'stop';
      const r = await execNode(n, c);
      if (r === 'stop' || r === 'break' || r === 'return' || r === 'continue') return r;
    }
    return 'next';
  }

  async function execNode(n, c) {
    if (n.k === 'stmt') return await execSimple(n, c);
    if (n.k === 'branch') {
      tick(c, n.line, n.file);
      c.trace = { mode: 'code', line: n.line, type: n.type, name: NAME_OF[n.type] || n.type, kw: n.kw, params: n.params, stopBlock: null, deadEnd: null };
      let hit = false;
      if (n.type === 'condition' || n.type === 'elseif') {
        try { hit = !!(await exprOf(n.params.expr, c)); }
        catch (e) { throw withLineN(e, n); }
      } else {
        // 检查物品 / 列表包含 / 数字比较：与块一样走自己那份实现，取它的出口
        const fn0 = RUN[n.type];
        if (!fn0) throw err('E_SYNTAX', where(n.line, n.file) + '：代码模式还不支持「' + (n.kw || n.type) + '」这条语句');
        let res0;
        try { res0 = await fn0(n.params, c, n.line); }
        catch (e) { throw withLineN(e, n); }
        res0 = res0 || {};
        if (res0.output !== undefined) c.nodeOut['行' + n.line] = res0.output;
        await flushPlayer(c);
        hit = res0.port === 'true';
      }
      if (hit) return await execList(n.thenBody, c);
      for (const ei of (n.elseIfs || [])) {
        tick(c, ei.line, n.file);
        let h2 = false;
        try { h2 = !!(await exprOf(ei.params.expr, c)); }
        catch (e) { throw withLine(e, ei.line, ei.kw, n.file); }
        if (h2) return await execList(ei.body, c);
      }
      if (n.elseBody) return await execList(n.elseBody, c);
      return 'next';
    }
    if (n.k === 'loop') {
      tick(c, n.line, n.file);
      if (n.type === 'loop_n') {
        const count = Math.max(0, Math.floor(await numOf(n.params.count, c, 3)));
        for (let i = 0; i < count; i++) {
          if (c.stopped) break;
          c.vars['次数'] = i + 1;
          const r = await execList(n.body, c);
          if (r === 'return' || r === 'stop') return r;
          if (r === 'break') break;      // continue 走到这里等于"本轮结束"，什么都不用做
        }
      } else {
        const list = await exprOf(n.params.list, c);
        const arr = Array.isArray(list) ? list : [];
        const vn = litOf(n.params, 'var', '项');
        for (let i = 0; i < arr.length; i++) {
          if (c.stopped) break;
          c.vars[vn] = arr[i];
          c.vars['序号'] = i + 1;
          const r = await execList(n.body, c);
          if (r === 'return' || r === 'stop') return r;
          if (r === 'break') break;
        }
      }
      c.trace = { mode: 'code', line: n.line, type: n.type, name: NAME_OF[n.type] || n.type, kw: n.kw, params: n.params, stopBlock: null, deadEnd: null };
      return 'next';
    }
    if (n.k === 'try') {
      tick(c, n.line, n.file);
      try { return await execList(n.body, c); }
      catch (e) {
        // 与块一致：抓住的错同时写 lastError 与数据（捕获分支能用 [错误信息] / 变量取到）
        c.lastError = e.message;
        c.data['错误信息'] = e.message;
        c.data['错误'] = e.message;
        // .way 的 捕获 (e) { ... }：把捕获变量也绑进当前作用域（C 风格的 catch 参数）
        const cv = n.catchVar ? String(n.catchVar) : '';
        const hadCv = cv && Object.prototype.hasOwnProperty.call(c.vars, cv);
        const prevCv = hadCv ? c.vars[cv] : undefined;
        if (cv) c.vars[cv] = e.message;
        c.trace = { mode: 'code', line: n.line, type: 'try_node', name: '尝试 / 捕获', kw: '尝试', params: {}, stopBlock: null, deadEnd: null, file: n.file, caught: e.message, caughtCode: e.code || 'E_INTERNAL' };
        try {
          if (n.catchBody) return await execList(n.catchBody, c);
          return 'next';
        } finally {
          if (cv) { if (hadCv) c.vars[cv] = prevCv; else delete c.vars[cv]; }
        }
      }
    }
    // ---------- .way 专用节点（2026-09-18）----------
    if (n.k === 'fn') return 'next';   // 顶层函数定义：在 runAst 里登记过了，执行时跳过
    if (n.k === 'while') {
      let guard = 0;
      for (;;) {
        if (c.stopped) return 'stop';
        tick(c, n.line, n.file);
        let ok = false;
        try { ok = !!(await exprOf(n.params && n.params.expr, c)); } catch (e) { throw withLineN(e, n); }
        if (!ok) break;
        c.trace = { mode: 'code', line: n.line, type: 'while', name: '当', kw: n.kw, params: n.params || {}, stopBlock: null, deadEnd: null, file: n.file };
        const r1 = await execList(n.body, c);
        if (r1 === 'return' || r1 === 'stop') return r1;
        if (r1 === 'break') break;
        if (++guard > 1000000) throw err('E_STEPS', where(n.line, n.file) + '：循环次数太多（条件是不是永远为真？）');
      }
      return 'next';
    }
    if (n.k === 'for') {
      if (n.init) { const r0 = await execNode(n.init, c); if (r0 === 'return' || r0 === 'stop') return r0; }
      let guard = 0;
      for (;;) {
        if (c.stopped) return 'stop';
        tick(c, n.line, n.file);
        let ok = true;
        if (n.cond) { try { ok = !!(await exprOf(n.cond, c)); } catch (e) { throw withLineN(e, n); } }
        if (!ok) break;
        c.trace = { mode: 'code', line: n.line, type: 'for', name: 'for', kw: n.kw, params: {}, stopBlock: null, deadEnd: null, file: n.file };
        const r1 = await execList(n.body, c);
        if (r1 === 'return' || r1 === 'stop') return r1;
        if (r1 === 'break') break;
        if (n.step) { const rs = await execNode(n.step, c); if (rs === 'return' || rs === 'stop') return rs; }
        if (++guard > 1000000) throw err('E_STEPS', where(n.line, n.file) + '：循环次数太多（条件是不是永远为真？）');
      }
      return 'next';
    }
    if (n.k === 'ret') {
      tick(c, n.line, n.file);
      c.trace = { mode: 'code', line: n.line, type: 'ret', name: '返回', kw: n.kw || '返回', params: {}, stopBlock: null, deadEnd: null, file: n.file };
      c.__ret = n.value ? await exprOf(n.value, c) : '';
      return ((c.callDepth || 0) > 0) ? 'return' : 'stop';   // main 里的 return = 整条逻辑收工
    }
    if (n.k === 'continue') {
      tick(c, n.line, n.file);
      c.trace = { mode: 'code', line: n.line, type: 'continue', name: '继续', kw: n.kw || '继续', params: {}, stopBlock: null, deadEnd: null, file: n.file };
      return 'continue';
    }
    if (n.k === 'callfn') {
      tick(c, n.line, n.file);
      const args = [];
      for (const a of (n.args || [])) args.push(await exprOf(a, c));
      const out = await callUserFn(n.name, args, n.line, n.file, c);
      c.trace = { mode: 'code', line: n.line, type: 'callfn', name: n.name, kw: n.name, params: { args: n.args || [] }, stopBlock: null, deadEnd: null, file: n.file };
      if (out !== undefined) c.nodeOut['行' + n.line] = out;
      await flushPlayer(c);
      return 'next';
    }
    if (n.k === 'unknown') return await execSimple(n, c);
    throw err('E_INTERNAL', where(n.line || '?', n.file) + '：解释器认不出这个节点');
  }

  /* ---------------- 4.4 对外：run ---------------- */
  async function run(code, ctx) {
    const c = ctx;
    c.mode = 'code';
    c.steps = c.steps || 0;
    c.vars = c.vars || { 次数: 0, 序号: 0 };
    c.nodeOut = c.nodeOut || {};
    c.output = c.output || [];
    c.data = c.data || {};
    c.emits = c.emits || [];
    c.__scSeq = 0;
    const src = String(code == null ? '' : code);
    c.code = src;
    const prog = parseProgram(src);
    c.program = prog;
    c.trace = null;
    await execList(prog, c);
    await flushPlayer(c);
    return c;
  }

  /* ---------------- 4.4b 对外：runAst（.way 多文件工程走这里，语义与 run 完全同一套） ---------------- */
  async function runAst(program, ctx) {
    const c = ctx;
    const prog = program || {};
    c.mode = 'code';
    c.steps = c.steps || 0;
    c.vars = c.vars || {};
    c.nodeOut = c.nodeOut || {};
    c.output = c.output || [];
    c.data = c.data || {};
    c.emits = c.emits || [];
    c.__scSeq = 0;
    c.globals = {};
    c.funcs = {};
    c.callDepth = 0;
    for (const fn of (prog.funcs || [])) c.funcs[fn.name] = { params: fn.params || [], body: fn.body || [], file: fn.file, line: fn.line };
    for (const g of (prog.globals || [])) {
      try { c.globals[g.name] = await valueOf(g.value, c); }
      catch (e) { throw withLine(e, g.line, g.name, null); }
      c.vars[g.name] = c.globals[g.name];      // 全局变量在 main 的作用域里直接可用
    }
    c.program = prog;
    c.trace = null;
    await execList(prog.main || [], c);
    await flushPlayer(c);
    return c;
  }

  /* ---------------- 4.5 对外：describeNoOutput（代码模式专用诊断） ---------------- */
  function describeNoOutput(code, ctx, logic) {
    const key = (logic && logic.key) || (ctx && ctx.key) || '';
    const src = String(code == null ? '' : code);
    const prog = (ctx && ctx.program) || parseProgram(src);
    const P = '（逻辑【' + key + '】没有输出：';
    if (!src.trim()) {
      return { code: 'E_NO_OUTPUT', reason: 'empty_code', text: P + '代码是空的 —— 在代码页写下 发送("你好") 这样的语句，保存后就能回复了）' };
    }
    const realLines = src.split(/\r?\n/).filter((l) => { const t = l.trim(); return t && t.charAt(0) !== '#'; });
    if (!prog.length || !realLines.length) {
      return { code: 'E_NO_OUTPUT', reason: 'comment_only', text: P + '代码里只有注释和空行，没有一条会执行的语句）' };
    }
    const unknown = [];
    (function walk(nodes) {
      for (const n of (nodes || [])) {
        if (n.k === 'unknown') unknown.push(n);
        if (n.k === 'branch') { walk(n.thenBody); walk(n.elseBody); (n.elseIfs || []).forEach((e) => walk(e.body)); }
        if (n.k === 'loop') walk(n.body);
        if (n.k === 'try') { walk(n.body); walk(n.catchBody); }
      }
    })(prog);
    if (!hasOutputStmt(prog)) {
      if (unknown.length) {
        return {
          code: 'E_NO_OUTPUT', reason: 'unknown_stmt',
          text: P + '第 ' + unknown[0].line + ' 行「' + unknown[0].raw + '」认不出来 —— 写法是「关键字(参数, 参数)」，'
            + '要把内容送出去得用 发送("文字") / 返回("文字") / 发送模板(房间.key)；点编辑器里的【🔄 由块生成代码】能看到正确写法）',
        };
      }
      return { code: 'E_NO_OUTPUT', reason: 'no_output_stmt', text: P + '代码里没有任何能把内容送出去的语句 —— 用 发送("…")、返回("…")、发送模板(房间.key) 或 返回模板(房间.key)）' };
    }
    const t = (ctx && ctx.trace) || {};
    if (Array.isArray(ctx && ctx.emits) && ctx.emits.length && ctx.emits.every((e) => !e.text)) {
      const e0 = ctx.emits[0];
      return {
        code: 'E_NO_OUTPUT', reason: 'empty_expr',
        text: P + '第 ' + e0.line + ' 行「' + e0.name + '」的「' + e0.param + '」' + explainEmptyExpr(e0.raw) + '）',
      };
    }
    if (t.stopBlock && t.stopBlock.type === 'return_tpl') {
      return {
        code: 'E_NO_OUTPUT', reason: 'empty_return',
        text: P + '跑到第 ' + t.stopBlock.line + ' 行「返回模板」时模板 key 为空或模板不存在（写的是「' + String(t.stopBlock.params.key || '') + '」）—— 模板 key 长这样：super.欢迎语）',
      };
    }
    if (t.line) {
      return {
        code: 'E_NO_OUTPUT', reason: 'no_branch_hit',
        text: P + '代码跑到第 ' + t.line + ' 行「' + (t.kw || t.name || '') + '」就没再产出内容了 —— '
          + '要么条件/列表没走到有 发送 的那条路（检查「如果」的条件、遍历的列表是不是空的），要么它本身不产出文本、后面也没有别的东西发出去）',
      };
    }
    return { code: 'E_NO_OUTPUT', reason: 'no_output_block', text: P + '代码里没有执行到任何输出语句）' };
  }

  return {
    run,
    runAst,
    describeNoOutput,
    evaluator,
    parse: parseProgram,
    statements: S_FLAT.concat(S_BRANCH).map((d) => ({ kw: d.kw, type: d.t, params: d.p.map((x) => x.k), literal: d.p.filter((x) => x.u).map((x) => x.k) })),
    helpers: Object.keys(HELPER_TYPES),
  };
}

module.exports = {
  createRunner, parseProgram, matchLine, HELPER_TYPES, S_KW, S_FLAT, S_BRANCH,
  // .way 语言前端要用这两样：语句表（名字 → 语句定义）与参数映射（与 DSL 逐字同源）
  S_BY_TYPE, dslParams, splitTop,
};
