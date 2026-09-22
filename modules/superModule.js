/**
 * 超级自定义模块 SuperModule v3（2026-09-18：多种触发方式）
 * 设计文档：docs/超级自定义模块-需求与优化总纲-v1.md（§6-§9）、整体设计 v0.6 §8 入口形态
 *
 * - 注册方式：与其他模块完全一致（moduleName / dependencies / registerModule）
 * - 触发方式（custom_logic_trigger.kind —— 一条逻辑可同时挂多种）：
 *     command 指令/触发词（5 种模式：exact/prefix/suffix/contains/regex）
 *     event   事件触发（enemy:killed / player:level_up …，支持 player:* 与 * 通配）
 *     time    定时触发（每30秒 / 每天08:00 / 每周一20:30 / 5 段 cron；scope=system|each）
 *     manual  不自动触发（只作函数用：编辑器 ▶、HTTP、别的逻辑调用）
 *   另有 super:<key> 通用通道 + fallbackMatch（HTTP 入口后置兜底）
 * - 参数：类型化（superBlocks.js），标识类=字面量，expr/list=求值，number=数字或算式
 * - 运行：IR 解释执行 + 表达式引擎 v2 + Guard + 写后玩家刷新 + 错误码 + 限频 + 串行
 * - 热更新：2 秒 TTL；保存/删除/改触发词调用 invalidate() 立即失效
 * - 返回协议：{ status, data, templateKey }，与所有模块一致
 */
'use strict';

// 列废弃登记（2026-09-15 S2）：下列 v0.5 声明列运行时不读写，已按总纲 §4.2 标记 deprecated，
// 仅在编辑器/迁移兼容路径使用：trigger_type / cron_expr / input_schema / output_schema / template_key / author / tags
const { ensureV3 } = require('./lib/superSchema');
const { defineBlocks, explainEmptyExpr } = require('./lib/superBlocks');
const { createEvaluator } = require('./lib/superExpr');
const { createRunner } = require('./lib/superCode');   // 代码模式：中文 DSL 直执行器（不经块图）
const { createJsRuntime } = require('./lib/superJs');  // 2026-09-19 · JS 通道沙箱（R4/R6）
const { createTriggerEngine, tokenizeArgs, cronMatch, cronKeyOf, eventNameMatch } = require('./lib/superTriggers');

/**
 * 可被「事件触发」订阅的核心事件清单（来自各模块的 core.emit）。
 * 核心 emit 不把事件名传给监听器，所以只能按名字逐个订阅；
 * 用户自定义事件（「发出事件」块）在 syncTriggers 时按触发词表里的具体名字动态订阅。
 * 排除 state:changed / core:* —— 它们高频或属于生命周期，不适合当业务触发。
 */
const { BUILTIN_EVENTS } = require('./lib/superEvents');   // 2026-09-18：事件清单抽到独立文件
const S = require('./lib/superStatements');           // 语句表（纯数据；契约产物与编辑器两侧对齐的依据）
const { QUERY_TABLES, PLAYER_TABLES, WRITE_TABLES } = require('./lib/superTables');
const superErrors = require('./lib/superErrors');     // 2026-09-18 S1-b：错误码中央登记表（治 D11）
const C = require('./lib/superConst');                // 2026-09-18 S2：常量表（治 D13 魔法数字）
const { createHost } = require('./lib/superHost');    // 2026-09-18 S2：宿主适配层（core 的唯一出口）
const { createGraphCache } = require('./lib/superGraph');   // 2026-09-18 S2：图 IR 缓存
const { createStore } = require('./lib/superStore');       // 2026-09-18 S2：存储层（逻辑缓存/运行历史）
const { createRespond } = require('./lib/superRespond');   // 2026-09-18 S2：应答层（模板/返回协议）
const { createGuard } = require('./lib/superGuard');       // 2026-09-18 S2：守卫层（限频/串行）
const { createVm } = require('./lib/superVm');             // 2026-09-18 S2：图执行器
const { createStateLayer } = require('./lib/superState');  // 2026-09-18 S2：上下文 + 多轮状态
const { createSchedule } = require('./lib/superSchedule'); // 2026-09-18 S2：事件订阅 + 定时调度
const { createChannel } = require('./lib/superChannel');   // 2026-09-18 S2：通道与兜底
const { createInvoker } = require('./lib/superInvoke');   // 2026-09-19 S2：调用生命周期
const { createDefsWriter } = require('./lib/superDefs');   // 2026-09-19 S2：契约产物写入
const { createExprOptions } = require('./lib/superExprKit');   // 2026-09-19 S2：表达式上下文函数

async function superModule(core) {

  // 2026-09-18 S2：宿主适配层 —— core 的唯一出口（换核心 / 写测试假核心只改 lib/superHost.js）
  const host = createHost(core);

  // S1（2026-09-15）：表结构 v3 幂等迁移。
  await ensureV3(core.db, (lv, msg) => host.log(lv, msg));

  // =====================================================================
  // 0. 系统状态
  // =====================================================================
  // 2026-09-18 S2 第四批：守卫层（限频 + 同玩家同逻辑串行）—— 状态由守卫自己持有
  const guard = createGuard();

  // 2026-09-18 S2 第六批：状态与上下文层（实现已搬到 lib/superState.js）
  // 装配点必须早于 defineBlocks —— 下面那行会把 stateSet/stateClear 当回调取走。
  // 依赖用箭头包一层按调用时求值，所以这里不需要等 getLogic/buildResponse/renderFallback 就绪。
  const state = createStateLayer({
    db: core.db,
    invokeLogic: (k, o2) => invokeLogic(k, o2),
    getLogic: (k) => getLogic(k),
    respond: (out, k) => buildResponse(out, k),
    renderFallback: (resp, pid, note) => renderFallback(resp, pid, note),   // 兜底层在本文件靠后定义，包一层按调用时求值
    log: host.log,
  });
  const setInbound = (pid, info) => state.setInbound(pid, info);
  const inboundOf = (pid) => state.inboundOf(pid);
  const injectContext = (ctx, o2) => state.injectContext(ctx, o2);
  const stateGet = (pid) => state.stateGet(pid);
  const stateSet = (pid, info) => state.stateSet(pid, info);
  const stateClear = (pid, name) => state.stateClear(pid, name);
  const runState = (pid, st, text) => state.runState(pid, st, text);
  const routeState = (pid, text, inbound) => state.routeState(pid, text, inbound);

  const system = {
    // 2026-09-18 S2：逻辑缓存已搬到存储层（lib/superStore.js 持有），此处不再保留字段
    // 2026-09-18 S2：限频表与排队表已搬到守卫层（lib/superGuard.js 持有），此处不再保留字段
    triggerMap: {},            // pattern -> key（前缀/精确触发词，doorHandles 路径用）
    // 2026-09-18 S2 第七批：事件订阅表 / 定时心跳 / 到期去重表已搬到 lib/superSchedule.js 持有
    // 2026-09-18 S2 第六批：上下文（inbound）已搬到 lib/superState.js 持有，此处不再保留字段
  };

  const TEMPLATES = {
    'super:invoke.fail_notfound': { text: '❌ 自定义逻辑【[key]】不存在，输入 super: 查看可用列表。', markdown: '❌ 自定义逻辑【[key]】不存在。' },
    'super:invoke.fail_nokey': { text: '❌ 用法：super:<逻辑名> [参数...]\n\n📋 现在可用的逻辑：\n[列表]', markdown: '❌ 用法：「super:<逻辑名> [参数...]」\n\n**现在可用的逻辑**\n\n[列表]' },
    'super:invoke.fail_disabled': { text: '❌ 自定义逻辑【[key]】已禁用。', markdown: '❌ 自定义逻辑【[key]】已禁用。' },
    'super:invoke.error': { text: '⚠️ 逻辑【[key]】执行出错：[错误信息]', markdown: '⚠️ 逻辑【[key]】执行出错：「[错误信息]」' },
    'super:invoke.success': { text: '[消息]', markdown: '[消息]' },
  };

  /**
   * 造一个带错误码的 Error（唯一出口）。
   * 2026-09-18 S1-b：未登记的错误码在这里留一条 warn —— 开发期立刻看得见，
   * 静态那层由 test_gap_contract 的 K7 扫源码兜住（写错码即真缺口）。
   * 注意：这里【只提示不改码】，存进运行历史的仍是调用点原本那个字符串（行为零变更）。
   */
  // 2026-09-19 S2 第十一批：错误工厂也收进登记表（唯一出口，未登记码留 warn）
  const err = (code, message) => superErrors.make(code, message, host.log);

  /**
   * 方括号保护（2026-09-18 · BUG 记录 4：逻辑输出里的 [方括号] 会整段消失）
   *
   * 核心 renderTemplate 在替换完 [消息] 之后还会再扫一遍结果里的 [变量名]：
   * 逻辑返回「[甲][乙]」时，[甲]/[乙] 被当成变量名 → 查不到 → 被替换成空串
   * → 玩家收到一条空回复（编辑器里怎么看都正常，只有实机看不到内容）。
   *
   * 核心自己用一对私有标记 \uE000 / \uE001 保护"替换进来的值"（renderTemplate 最后一步会清掉它们）。
   * 这里给消息体里的方括号套上同一对标记：核心不会再把它们当变量，最终输出仍是原文的 [甲][乙]。
   * 只有真的含方括号时才动手，且只作用于送进模板的 data，不影响 return 值本身。
   */
  // 方括号保护（2026-09-18 S2 搬到 modules/lib/superHost.js）——
  // 它依赖核心 renderTemplate 的 \uE000/\uE001 私有标记约定，属于「宿主适配」，不属于本模块的业务逻辑。
  const { protectBrackets } = host;

  // =====================================================================
  // 1. 逻辑读取与缓存
  // =====================================================================
  // ---- 存储层（2026-09-18 S2：逻辑缓存 / .way 文件表 / 运行历史 搬到 lib/superStore.js）----
  // 所有 SQL 集中到存储层；本模块只保留同名门面，调用点一行都没改。
  const store = createStore({ db: core.db, ttlMs: C.CACHE_TTL_MS, keepCount: C.RUN_KEEP_COUNT, keepDays: C.RUN_KEEP_DAYS });
// 2026-09-19 · JS 通道（作者面 v2 的 R4/R6）：沙箱层只认「给我文件内容 + 给我能力表」，
// 不认 core、不认数据库（副作用能力的白名单在 superCode 的 buildJsCaps 里）。
const jsRuntime = createJsRuntime({
  loadFiles: (key) => store.loadWayFiles(key),
  log: host.log,
  ttlMs: C.CACHE_TTL_MS,
  timeoutMs: C.JS_TIMEOUT_MS,
  totalTimeoutMs: C.JS_TOTAL_TIMEOUT_MS,
  maxCalls: C.JS_MAX_CALLS,
});
  const getLogic = (key) => store.getLogic(key);
  const loadWayFiles = (key) => store.loadWayFiles(key);
  function clearCache() { store.clearCache(); jsRuntime.invalidate(); }
  function invalidate(key) {
    store.invalidate(key);
    jsRuntime.invalidate(key);   // 2026-09-19：JS 文件缓存跟着一起失效（保存 .js 后立刻生效）
    try { triggers.clearRegexCache(); } catch (e) {}
  }

  // =====================================================================
  // 2. 调用（限频 + 串行 + 类型化上下文 + Guard + 错误码 + 运行历史）
  // =====================================================================
  // 2026-09-19 S2 第九批：调用生命周期（限频 → 串行 → ctx 组装 → 执行 → 诊断 → 落档 → 错误出口）
  //   实现搬到 lib/superInvoke.js；本模块只留同名门面。
  //   装配点在存储层之后（invoke 要用 store）；vm / codeRunner 用 getter 延迟取，
  //   解析图、诊断、模板内联渲染同样延迟（它们在本文件靠后定义）。
  const invoker = createInvoker({
    host, store, guard, state, C,
    getVm: () => vm,
    getRunner: () => codeRunner,
    parseGraph: (g) => parseGraphCached(g),
    describeNoOutput: (ctx, graph, logic) => describeNoOutput(ctx, graph, logic),
    renderTemplateInline: (k, ctx) => renderTemplateInline(k, ctx),
  });
  const invokeLogic = (key, o2) => invoker.invoke(key, o2);

  // 2026-09-18 性能：图 IR 缓存。以前【每次执行】都 JSON.parse(logic.graph) 一遍 ——
  // 高频逻辑（每秒被触发多次）与几百节点的大图都要白付这份解析开销。
  // 安全性：runGraph 只读 graph（建索引/遍历边），运行期不改图；图一变字符串就变，旧条目由 LRU 淘汰。
  // 2026-09-18 S2：图 IR 缓存搬到 modules/lib/superGraph.js（同一份图只解析一次，条数上限走常量表）
  const graphCache = createGraphCache(C.GRAPH_CACHE_LIMIT);
  function parseGraphCached(str) {
    return graphCache.parse(str);
  }

  // 2026-09-18 S2 第四批：限频规则解析已搬到守卫层（lib/superGuard.js 的 parseRateLimit）
  // =====================================================================
  // 2.5 "没有输出"说明（2026-09-17 · BUG 记录 1）
  // 原来只要没有文本就回一句"（该逻辑没有输出内容）"，用户完全不知道问题在哪。
  // 现在按执行轨迹分四种情况说清楚：空图 / 结束块内容为空 / 出口没连线 / 根本没有输出块。
  // =====================================================================
  // ---- 2.5「没有输出」诊断（2026-09-18 S2 第三批：PORT_LABEL / missingRequired / describeNoOutput 搬到）
  //      （lib/superRespond.js 的 describeNoOutput）—— 它们依赖块库，所以应答层装配点在下方 blocks 之后。

  // ---- 运行历史（2026-09-18 S2 第二批：写入与保留策略已归存储层 lib/superStore.js）----
  const writeRun = (key, playerId, source, durationMs, steps, errorText, ok, args, code) => store.writeRun(key, playerId, source, durationMs, steps, errorText, ok, args, code);
  const pruneRuns = () => store.pruneRuns();

  // ---- 应答层（2026-09-18 S2：模板查找 / 模板渲染 / 返回协议 / 无输出诊断 搬到 lib/superRespond.js）----
  // 装配推迟到块库建好之后（诊断要块定义才说得清「必填没填」/「出口叫什么」），装配点在下方 blocks 之后。
  let respond = null;
  const lookupTemplateContent = (key) => respond.lookupTemplateContent(key);
  const renderTemplateContent = (tc, data, playerId) => respond.renderTemplateContent(tc, data, playerId);
  const renderTemplateInline = (key, ctx) => respond.renderTemplateInline(key, ctx);

  // =====================================================================
  // 3. 图执行器（多入边 + 写后玩家刷新 + Guard）
  //    2026-09-18 S2 第五批：实现搬到 lib/superVm.js，本模块只留同名门面；
  //    装配推迟到「块库 + 表达式引擎 + 出口名表」都就绪之后（见下方 vm 装配点）。
  // =====================================================================
  let vm = null;
  const runGraph = (graph, ctx) => vm.runGraph(graph, ctx);

  // =====================================================================
  // 4. 块库与表达式引擎（类型化）
  // =====================================================================
  const blocks = defineBlocks(core, { invokeLogic, stateEnter: stateSet, stateExit: stateClear });
  // 2026-09-18 S2 第三批：应答层在此完成装配（诊断依赖块库），并补上诊断入口的同名门面
  respond = createRespond({ host, templates: TEMPLATES, blocks, explainEmptyExpr });
  const describeNoOutput = (ctx, graph, logic) => respond.describeNoOutput(ctx, graph, logic);
  // PORT_LABEL 仍被图执行器用（记录「停在哪个出口」的轨迹），从应答层取同一份，避免两处各写一套出口名
  const PORT_LABEL = respond.PORT_LABEL;
  // 2026-09-19 S2 第十一批：表达式引擎的「上下文函数」装配件搬到 lib/superExprKit.js
  //   （玩家/读玩家/参数/变量/检查物品/查询/查玩家/调用 —— 块与代码两种模式同名同义）
  const evaluator = createEvaluator(createExprOptions({
    host,
    invokeLogic: (k, o2) => invokeLogic(k, o2),
    tables: { query: QUERY_TABLES, player: PLAYER_TABLES },
  }));
  // 2026-09-18 S2 第五批：图执行器在此装配（依赖块库 blocks + 表达式引擎 evaluator + 出口名表 PORT_LABEL）
  vm = createVm({ blocks, evaluator, host, err, portLabel: PORT_LABEL });

  // 代码模式直执行器（2026-09-18）：custom_logic.exec_mode='code' 时直接解释执行 code，
  // 完全不读 custom_logic.graph —— 代码不必再「由代码生成块」才能跑。
  const codeRunner = createRunner({
    core,
    invokeLogic: (key, opts) => invokeLogic(key, opts),
    log: host.log,
    // 2026-09-18 四大块批次：代码模式的「进入状态 / 结束状态」也走同一套路由
    stateEnter: (pid, info) => stateSet(pid, info),
    stateExit: (pid, name) => stateClear(pid, name),
    // 2026-09-19 · JS 通道：DSL 里「调用 js:文件.函数(参数…)」走这里进沙箱。
    // 能力表（caps）由 superCode 自己按当前 ctx 组装 —— JS 的副作用面 = 中文 DSL 的副作用面。
    jsCall: ({ spec, args, ctx, caps }) => jsRuntime.call({ spec, args, logicKey: ctx.key, caps, timeoutMs: ctx.jsTimeoutMs }),
  });

  // =====================================================================
  // 5. 触发词引擎（5 种模式 + 冲突检测 + 只注销自有行）
  // =====================================================================
  const triggers = createTriggerEngine(core, { log: host.log });
  // 2026-09-18 S2 第七批：事件订阅 + 定时调度在此装配（依赖触发词引擎）。
  // 注意：`let schedule` 必须先于这一行 —— 门面是 const/let，没有函数声明的提升（第六批踩过 TDZ）。
  let schedule = null;   // 事件订阅 + 定时调度层（下一行立刻赋值为实例）
  schedule = createSchedule({ triggers, invokeLogic: (k, o2) => invokeLogic(k, o2), host });

  /**
   * 触发词同步（2026-09-18 S2 第八批：门把手注册 / 冲突记账 / 事件重订阅 搬到 lib/superSchedule.js）。
   * 本模块只保留一件本地事：把「触发词 → 逻辑 key」映射记进 system.triggerMap（super:invoke 处理器要用）。
   */
  async function syncTriggers() {
    const res = await schedule.syncTriggers();
    system.triggerMap = {};
    for (const [pattern, key] of res.bound) system.triggerMap[pattern] = key;
    return res;
  }

  // =====================================================================
  // 5b/5c 事件订阅 + 定时调度（2026-09-18 S2 第七批：实现搬到 lib/superSchedule.js）
  //    事件：按触发词表逐个订阅核心事件（通配展开 BUILTIN_EVENTS）+ 自环闸门。
  //    定时：1 秒心跳，间隔式首次从当秒起算，日历式同一分钟只跑一次。
  //    装配点在触发词引擎（triggers）之后 —— 见下方 schedule 装配点。
  const eventTriggerEntries = () => schedule.eventTriggerEntries();
  const eventNamesToWatch = () => schedule.eventNamesToWatch();
  const resubscribeEvents = () => schedule.resubscribeEvents();
  const dispatchEvent = (name, payload, depth) => schedule.dispatchEvent(name, payload, depth);
  const timeTriggerEntries = () => schedule.timeTriggerEntries();
  const pickDueTimes = (now, date) => schedule.pickDueTimes(now, date);
  const runDueTimes = () => schedule.runDueTimes();
  const startAuto = () => schedule.startAuto();
  const stopAuto = () => schedule.stopAuto();
  const usableLogicList = (limit) => schedule.usableLogicList(limit);
  const describeTriggers = () => schedule.describeTriggers();

  // =====================================================================
  // 6. 返回协议（按错误码选状态，不再靠中文正则）
  // =====================================================================
  // ---- 应答层：ctxDataFor / buildResponse 已搬到 lib/superRespond.js（见上方 respond 装配）----
  // 本模块只保留同名门面，调用点（renderFallback / 状态路由 / super:invoke）一行都没改。
  const buildResponse = (out, key) => respond.buildResponse(out, key);

  // =====================================================================
  // 6.5 上下文透传 + 多轮状态（2026-09-18 S2 第六批：实现搬到 lib/superState.js）
  //    装配点在本文件靠前（紧跟守卫层）—— 因为 defineBlocks 会立刻把 stateSet/stateClear
  //    作为回调取走，装配晚了会撞上「const 未初始化」（TDZ）。本节只留说明。
  // =====================================================================

  // =====================================================================
  // 7. HTTP 入口后置兜底（server.js 在"未知指令"后调用）
  // =====================================================================
  // parseSuperChannel 的详细说明随实现一起搬到 lib/superChannel.js（全项目只此一份解析）。
  // 2026-09-18 S2 第八批：通道与兜底层（实现已搬到 lib/superChannel.js）
  //   解析 / 兜底匹配 / 回复组装三件事同源；依赖用箭头包一层，按调用时求值。
  const channel = createChannel({
    tokenizeArgs, triggers, host,
    getTriggerMap: () => system.triggerMap,
    usableLogicList: (limit) => usableLogicList(limit),
    getLogic: (k) => getLogic(k),
    invokeLogic: (k, o2) => invokeLogic(k, o2),
    routeState: (pid, t, ib) => routeState(pid, t, ib),
    setInbound: (pid, info) => setInbound(pid, info),
    buildResponse: (out, k) => buildResponse(out, k),
    lookupTemplateContent: (k) => lookupTemplateContent(k),
    renderTemplateContent: (tc, d, pid) => renderTemplateContent(tc, d, pid),
  });
  const parseSuperChannel = (raw) => channel.parseSuperChannel(raw);
  const fallbackMatch = (pid, text, inbound) => channel.fallbackMatch(pid, text, inbound);
  const renderFallback = (resp, pid, note) => channel.renderFallback(resp, pid, note);

  // =====================================================================
  // 8. 块定义产物（编辑器唯一来源的兜底：block-defs.json）
  // =====================================================================
  // 2026-09-19 S2 第十批：契约产物写入（block-defs.json + super-contract.json）搬到 lib/superDefs.js
  //   依赖：块库 / 语句表 / 事件清单 / 表白名单 / 错误码登记表；产物目录用本模块算好的路径。
  const defsWriter = createDefsWriter({
    blocks, statements: S, events: BUILTIN_EVENTS,
    tables: { query: QUERY_TABLES, player: PLAYER_TABLES, write: WRITE_TABLES },
    errors: superErrors, log: host.log,
  });
  const writeDefs = () => defsWriter.writeDefinitionArtifacts();

  // =====================================================================
  // 9. 事件与注册
  // =====================================================================
  core.on('core:started', async () => {
    await syncTriggers();
    startAuto();                       // 事件订阅 + 定时心跳（2026-09-18：多种触发方式）
    writeDefs();
    pruneRuns();
  });
  core.on('data:reloaded', async () => { clearCache(); await syncTriggers(); });
  core.on('core:stopping', async () => { stopAuto(); });

  core.registerModule('super', {
    doors: [
      { logical_name: 'super:invoke', default_triggers: ['super:'], description: '超级自定义逻辑入口：super:<key> [参数...]' },
    ],
    templates: TEMPLATES,
    handlers: {
      'super:invoke': async (request) => channel.handleInvoke(request),
    },
  });

  host.log('info', '超级自定义模块已加载：块 ' + Object.keys(blocks).length + ' 个；触发方式 4 类（命令 5 种模式 / 事件 / 定时 / 手动），入口 super:<key>');

  return {
    moduleName: 'super',
    runGraph,
    runCode: (code, ctx) => codeRunner.run(code, ctx),        // 代码模式直执行（测试/工具用）
    codeDescribe: (code, ctx, logic) => codeRunner.describeNoOutput(code, ctx, logic),
    evaluator,
    blocks,
    invokeLogic: (k, o) => invokeLogic(k, o),
    syncTriggers: () => syncTriggers(),
    getLogic: (k) => getLogic(k),
    clearCache,
    invalidate,
    fallbackMatch: (pid, text, inbound) => fallbackMatch(pid, text, inbound),
    // ---- 四大块批次（2026-09-18）：上下文透传 + 多轮状态 ----
    setInbound: (pid, info) => setInbound(pid, info),
    routeState: (pid, text, inbound) => routeState(pid, text, inbound),
    stateOf: (pid) => stateGet(pid),
    clearState: (pid, name) => stateClear(pid, name),
    injectContext: (ctx, opts) => injectContext(ctx, opts),
    conflicts: () => triggers.conflicts(),
    // ---- 多种触发方式（2026-09-18）----
    triggers: () => describeTriggers(),
    eventNames: () => BUILTIN_EVENTS.slice(),
    fireEvent: (name, payload) => dispatchEvent(name, Array.isArray(payload) ? payload : (payload === undefined ? [] : [payload])),
    runDueTimes,
    // 2026-09-18：图缓存统计（测试用：同一份图连续执行 N 次，parseCount 只该 +1）
    graphStats: () => graphCache.stats(),
    pickDueTimes,
    startAuto,
    stopAuto,
    ensureSchema: () => ensureV3(core.db, (lv, msg) => host.log(lv, msg)),
    writeDefs,
  };
}

superModule.moduleName = 'super';
superModule.dependencies = ['database'];
module.exports = superModule;
