/**
 * 调用生命周期层（2026-09-19 S2 第九批 · 从 superModule 巨型闭包里搬出的第九层）
 * ------------------------------------------------------------------
 * 一次调用的完整生命线：
 *   ① 深度与存在性检查（E_DEPTH / E_NOT_FOUND / E_DISABLED）
 *   ③ 限频（守卫层判定，挡住就记一条运行历史）
 *   ④ 同玩家同逻辑串行（只串顶层入口，嵌套内联执行 —— 否则死锁）
 *   ⑤ ctx 组装：参数对象、具名参数、事件数据、上下文透传、Guard 上限
 *   ⑥ 执行 + 写后玩家刷新（在 superVm 内）
 *   ⑦ 无输出诊断（块图与代码各一套，由 superRespond / superCode 提供）
 *   ⑧ 运行历史落档（成功/失败/被挡都记）与统一错误出口
 * 行为零变更：检查顺序、错误码、文案、落档字段与搬迁前逐字一致。
 */
'use strict';

function createInvoker(opts) {
  const o = opts || {};
  const host = o.host;                 // 宿主适配层（getPlayer / log）
  const store = o.store;               // 存储层（逻辑读取 / 运行历史 / .way 文件）
  const guard = o.guard;               // 守卫层（限频 / 串行）
  const state = o.state;               // 状态层（上下文透传）
  const C = o.C;                       // 常量表
  const getVm = o.getVm;               // () => 图执行器（装配顺序所限，延迟取）
  const getRunner = o.getRunner;       // () => 代码模式执行器
  const parseGraph = o.parseGraph;     // 图 IR 缓存解析
  const describeNoOutput = o.describeNoOutput;
  const renderTemplateInline = o.renderTemplateInline;
  async function invoke(key, opts = {}) {
    const { playerId, args = [], named = {}, source = 'command', depth = 0 } = opts;
    if (depth > C.MAX_CALL_DEPTH) return { ok: false, code: 'E_DEPTH', error: '调用深度超过 ' + C.MAX_CALL_DEPTH + ' 层（最多 ' + C.MAX_CALL_DEPTH + ' 层）' };
    const logic = await store.getLogic(key);
    // outer:true 表示「就是这条逻辑本身有问题」；嵌套调用里抛的 E_NOT_FOUND 不带这个标记，
    // 免得回复把内层的错误说成外层逻辑不存在（2026-09-18 修 C5）
    if (!logic) return { ok: false, code: 'E_NOT_FOUND', outer: true, error: '自定义逻辑【' + key + '】不存在' };
    if (!logic.enabled) return { ok: false, code: 'E_DISABLED', outer: true, error: '自定义逻辑【' + key + '】已禁用' };
    // 执行器选择（2026-09-18 · 代码模式）：exec_mode='code' → 直执行 code；其余 → 原块图。
    // 这一行就是「代码不再强行依赖块」的开关，块那条线的行为一个字节都没动。
    const isCode = String(logic.exec_mode || 'block') === 'code';
    const code = isCode ? String(logic.code == null ? '' : logic.code) : '';

    // 限频（默认不限；rate_limit 形如 "3/10s"）
    // 2026-09-18：提前 return 的两种失败（限频/玩家不存在）以前不落运行历史，
    // 事后没法回答「谁被限频挡过」。统一在 return 前补一条记录。
    // 2026-09-18 S2：判定本身搬到守卫层（lib/superGuard.js），这里只负责「挡住了就记一条 + 回人话」。
    const rl = guard.parseRateLimit(logic.rate_limit);
    if (rl) {
      const hit = guard.rateLimit(playerId, key, rl);
      if (!hit.ok) {
        await store.writeRun(key, playerId, source, 0, 0, hit.message, 0, args, 'E_LIMIT');
        return { ok: false, code: 'E_LIMIT', error: hit.message };
      }
    }

    // 同玩家同逻辑串行 —— 只串行【顶层入口】(depth=0)。
    // 嵌套调用（depth>0，如 递归A→调用递归B→调用递归A）必须内联执行，
    // 否则内层会排队等外层完成、外层又在等内层 → 死锁（2026-09-15 S2 修复）。
    // 2026-09-18 S2：排队实现搬到守卫层（lib/superGuard.js 的 serialize）
    if (depth === 0) return await guard.serialize(playerId + '|' + key, () => doInvoke());
    return await doInvoke();

    async function doInvoke() {
      const startTime = Date.now();
      const ctx = {
        key, playerId, source, depth,
        argsObj: args.reduce((o, v, i) => { o[String(i + 1)] = v; o['参数个数'] = args.length; return o; }, {}),
        args,
        vars: { 次数: 0, 序号: 0 },
        nodeOut: {}, output: [], outputTemplate: null, data: {},
        stopped: false, lastError: null, steps: 0,
        maxSteps: logic.max_steps || C.DEFAULT_MAX_STEPS, timeoutMs: logic.timeout_ms || C.DEFAULT_TIMEOUT_MS,
        startTime, playerDirty: false,
        trace: null,   // 2026-09-17：执行轨迹（停在哪个块、哪个出口），用于"没有输出"时给出说明
      };
      // {参数.N} 打通：
      //   - 数组第一位放 null 占位 → 路径查找 {参数.1} = 数组[1] = 第 1 个参数（引擎路径查找是 0 基，见 test_full.js 注释）
      //   - 同时给 参数1/参数2（方括号语法不支持点号）与 参数.1/参数.2（其它路径）
      ctx.data.参数 = [null].concat(args);
      args.forEach((a, i) => {
        ctx.data['参数' + (i + 1)] = a;
        ctx.data['参数.' + (i + 1)] = a;
      });
      ctx.data['参数个数'] = args.length;
      if (named && Object.keys(named).length) {
        ctx.data['具名'] = named;
        for (const [k, v] of Object.entries(named)) ctx.data['具名.' + k] = v;
      }
      // 事件触发（kind='event'）：把事件本身也放进数据，写法见「事件触发」文档
      if (opts.event) {
        ctx.data['事件'] = { '名': opts.event.name, '玩家': playerId, '参数': opts.event.args };
        ctx.data['事件名'] = opts.event.name;
        ctx.data['事件玩家'] = playerId;
      }
      if (source && String(source).indexOf('time:') === 0) ctx.data['触发时间'] = new Date().toISOString();
      // 2026-09-18 四大块批次 · 上下文透传：玩家id / 群id / 原始消息 / 输入 / 状态名 / 来源
      // 模板里写 [群ID] [玩家id] [输入] [状态名] 都能取；表达式里直接写名字也能取。
      state.injectContext(ctx, opts);

      let steps = 0;
      try {
        // 2026-09-18：无玩家的触发方式（定时 scope=system / 系统级事件 / 手动跑无参逻辑）
        // 允许 playerId 为空 —— 这类逻辑用「主动推送 / 记录日志 / 查数据」输出，不需要玩家。
        // 之前这里无条件要求玩家，导致「每天08:00 发公告」这类定时逻辑永远跑不起来（沙盒测试 T09 抓到）。
        ctx.player = playerId ? await host.getPlayer(playerId) : null;
        if (!ctx.player && playerId) {
          const noPlayer = '玩家不存在（请先注册）';
          await store.writeRun(key, playerId, source, Date.now() - startTime, 0, noPlayer, 0, args, 'E_PLAYER');
          return { ok: false, code: 'E_PLAYER', error: noPlayer };
        }
        let graph = null;
        if (isCode) {
          // 代码模式：一个字都不碰 graph（连 JSON.parse 都不做 —— 空图、坏图、没图都无所谓）
          await getRunner().run(code, ctx);                            // 老的单文件 DSL
        } else {
          try { graph = parseGraph(logic.graph); }
          catch (e) { return { ok: false, code: 'E_INTERNAL', error: '逻辑图 JSON 解析失败: ' + e.message }; }
          await getVm().runGraph(graph, ctx);
        }
        steps = ctx.steps;
        let text = ctx.output.join('\n');
        // return_tpl：super 自行渲染（核心 responseContext 没有 参数，见总纲 §5.5）
        if (ctx.outputTemplate) {
          text = await renderTemplateInline(String(ctx.outputTemplate), ctx);
        }
        // 没有输出时给出"断在哪"的说明（2026-09-17）
        // 原来只有一句"（该逻辑没有输出内容）"：用户看不出是空图、出口没连线、还是参数没填，
        // 只能看到一句无信息量的话（BUG 记录 1）。
        let why = null;
        if (!text) {
          // 代码模式有自己的诊断（不套用块图那套「块没连线」的说法）
          why = isCode
            ? getRunner().describeNoOutput(code, ctx, logic)
            : describeNoOutput(ctx, graph, logic);
          // 2026-09-18 重构：作者向的诊断只进运行历史，不再当正文发给玩家。
          // 以前群里会出现「执行到「发消息」(n3) 走的是「往下」出口，但那条出口没有连到任何块 → 请在编辑器里把这个出口接到…」——
          // 玩家收到的是给作者看的排障话术。诊断本身仍会写进 custom_logic_run（下一行 writeRun 记的就是 why.text）。
          text = why.text;   // 诊断本身留着（写进运行历史、编辑器「运行记录」要用），玩家看到的那份在 buildResponse 里换成一句人话
        }
        const durationMs = Date.now() - startTime;
        await store.writeRun(key, playerId, source, durationMs, steps, why ? why.text : '', 1, args, why ? why.code : '');
        return { ok: true, text, diagnostic: why ? why.text : '', data: ctx.data, durationMs, steps };
      } catch (e) {
        const durationMs = Date.now() - startTime;
        // 2026-09-18：失败以前只回一句干巴巴的原因（「执行超时（3000ms）」），不告诉你卡在哪。
        // 这里把执行轨迹带上：最后一个跑到的块 + 节点 id，作者一眼知道去哪改。
        let where = '';
        try {
          const t = ctx.trace || {};
          const b = t.stopBlock || t.deadEnd;
          if (b) where = '（执行到「' + (b.name || b.type) + '」' + (b.nodeId || '') + '）';
        } catch (e3) { /* 轨迹拿不到就算了 */ }
        const full = String(e.message || '执行出错') + where;
        await store.writeRun(key, playerId, source, durationMs, steps, full, 0, args, e.code || 'E_INTERNAL');
        return { ok: false, code: e.code || 'E_INTERNAL', error: full };
      }
    }
  }

  return { invoke };
}

module.exports = { createInvoker };
