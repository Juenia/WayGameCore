/**
 * 图执行器（2026-09-18 S2 第五批 · 从 superModule 巨型闭包里搬出的最大一层）
 * ------------------------------------------------------------------
 * 一次块图执行的全部规则都在这儿：
 *   ① 建边索引（并校验死边：起点不存在 / 出口不存在 / 终点不存在 → 记 warn，不静默）
 *   ② 从「开始」块进入，逐块执行，按出口下钻（支持真/假/循环体/捕获 等多出口）
 *   ③ Guard：步数上限、超时上限（超了抛 E_STEPS / E_TIMEOUT）
 *   ④ 写后刷新：块写了玩家数据（playerDirty）就重读一次玩家，后面对同一份数据判断才是新的
 *   ⑤ 执行轨迹 trace：最后跑到的块 / 断在哪条出口 / 哪个块提前结束（「没有输出」诊断要用）
 *   ⑥ 旧图兼容：非 next 出口没连线时回落到 .next 边（2026-09-16 起）
 * 行为零变更：算法、顺序、错误码、轨迹字段与搬迁前逐字一致。
 */
'use strict';

function createVm(opts) {
  const o = opts || {};
  const blocks = o.blocks || {};      // 块定义（含 run）
  const evaluator = o.evaluator;      // 表达式引擎
  const host = o.host;                // 宿主适配层（log / getPlayer）
  const err = o.err;                  // 带错误码的 Error 工厂
  const portLabel = o.portLabel || {};

  async function runGraph(graph, ctx) {
    const nodes = new Map((graph.nodes || []).map((n) => [n.id, n]));
    const outPorts = new Map();
    for (const e of (graph.edges || [])) {
      // 2026-09-18：出口在块上不存在 = 死边（运行时永远不会走），静默忽略会让用户以为连上了
      const seg = String(e.from).split('.');
      const src = nodes.get(seg[0]);
      const port = seg.slice(1).join('.');
      const def = src ? blocks[src.type] : null;
      const outs = (def && def.ports && def.ports.out) || [];
      if (!src) { host.log('warn', '[super] 图里有一条连线起点不存在：' + e.from + ' → ' + e.to + '（已忽略）'); continue; }
      if (outs.indexOf(port) < 0) { host.log('warn', '[super] 图里的连线用了不存在的出口：' + e.from + '（' + (def.name || src.type) + ' 只有 ' + JSON.stringify(outs) + '）→ 这条线不会被执行'); }
      if (!nodes.get(e.to)) { host.log('warn', '[super] 图里的连线终点不存在：' + e.from + ' → ' + e.to); }
      if (!outPorts.has(e.from)) outPorts.set(e.from, []);
      outPorts.get(e.from).push(e.to);
    }
    const entry = (graph.nodes || []).find((n) => n.type === 'entry') || (graph.nodes || [])[0];

    const E = {
      eval: (expr, c) => evaluator.eval(expr, c),
      execPorts: async (node, port, c) => {
        let targets = outPorts.get(node.id + '.' + port) || [];
        // 旧图兼容（2026-09-16）：老逻辑的 .next 边在改成真/假的块上仍能继续走
        if (!targets.length && port !== 'next') targets = outPorts.get(node.id + '.next') || [];
        // 出口没连线 = 流程在这里断掉（2026-09-17）：记下来，「没有输出」时告诉用户断在哪
        if (!targets.length && c.trace) {
          const d = blocks[node.type] || {};
          c.trace.deadEnd = { nodeId: node.id, type: node.type, name: d.name || node.type, port: port, portLabel: portLabel[port] || port, params: node.params || {} };
        }
        for (const t of targets) await execNode(nodes.get(t), c);
      },
    };

    async function execNode(node, c) {
      if (!node || c.stopped) return;
      c.steps++;
      if (c.steps > c.maxSteps) throw err('E_STEPS', '超过最大步数 ' + c.maxSteps);
      if (Date.now() - c.startTime > c.timeoutMs) throw err('E_TIMEOUT', '执行超时（' + c.timeoutMs + 'ms）');
      const def = blocks[node.type];
      if (!def) throw err('E_INTERNAL', '未知块类型: ' + node.type);
      const res = (await def.run(node, c, E)) || {};
      // 执行轨迹（2026-09-17）：更新成「最后执行到的块」，供「没有输出」时定位
      c.trace = { nodeId: node.id, type: node.type, name: def.name || node.type, port: res.nextPort || 'next', params: node.params || {}, deadEnd: null, stopBlock: null };
      if (res.output !== undefined) c.nodeOut[node.id] = res.output;
      if (c.playerDirty) { try { c.player = (await host.getPlayer(c.playerId)) || c.player; } catch (e) {} c.playerDirty = false; }
      if (res.stop) { c.trace.stopBlock = { nodeId: node.id, type: node.type, name: def.name || node.type, params: node.params || {} }; c.trace.deadEnd = null; return; }
      await E.execPorts(node, res.nextPort || 'next', c);
    }

    await execNode(entry, ctx);
    return ctx;
  }

  return { runGraph };
}

module.exports = { createVm };
