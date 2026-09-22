/**
 * 应答层（2026-09-18 S2 · 从 superModule 巨型闭包里搬出的第三层）
 * ------------------------------------------------------------------
 * 负责「把执行结果变成玩家能看到的一句话」：
 *   ① 模板查找（key 变体展开 + DB 优先 + 内存兜底）
 *   ② 模板渲染（消息模式决定 text / markdown）
 *   ③ 返回协议 {status, data, templateKey} 与上下文键注入
 *   ④ 无输出诊断（2026-09-18 S2 第三批搬入：空图 / 返回为空 / 表达式空 / 出口悬空 / 提前结束）
 * 行为零变更：模板变体顺序、失败分类、方括号保护、截断阈值、诊断四分支全部与搬迁前一致。
 */
'use strict';
const C = require('./superConst');

function createRespond(opts) {
  const o = opts || {};
  const host = o.host;                       // 宿主适配层（db / renderTemplate / messageMode / protectBrackets / log）
  const templates = o.templates || {};       // 模块内存模板兜底表（TEMPLATES）
  const blocks = o.blocks || {};             // 块定义（诊断需要：必填项、出口名）
  const explainEmptyExpr = o.explainEmptyExpr || (() => '');   // 表达式为空的「人话解释」（来自 superBlocks）

  /**
   * 模板 key 变体 → 取模板内容（DB 优先、内存兜底）
   * 2026-09-18 结构治理：这段「key 变体展开 + DB-first + 内存模板兜底」以前在
   * renderTemplateInline 与 renderFallback 里各写了一份、逐字相同 —— 改口径必然漏一处
   * （之前就出过「事件触发能发模板、指令触发发不出」这类分叉）。现在只此一份。
   */
  async function lookupTemplateContent(key) {
    const tk = String(key == null ? '' : key);
    if (!tk) return null;
    const variants = [tk];
    const cd = tk.replace(/:/g, '.');
    if (cd !== tk) variants.push(cd);
    const short = tk.split(':').pop();
    if (short !== tk) variants.push(short);
    const shortDot = short.replace(/:/g, '.');
    if (shortDot !== short) variants.push(shortDot);
    if (tk.startsWith('super.')) variants.push(tk.slice(6));
    for (const v of variants) {
      const seg = v.split('.');
      const row = await host.db.getMessageTemplate(seg[0], seg.slice(1).join('.'));
      if (row && row.text_content) return { text: row.text_content, markdown: row.markdown_content || row.text_content };
      if (templates[v]) return templates[v];
    }
    return null;
  }

  /** 用模板内容渲染出最终文本（消息模式决定取 text 还是 markdown） */
  async function renderTemplateContent(tc, data, playerId) {
    if (!tc) return '';
    const tpl = (host.messageMode() === 2 ? tc.markdown : tc.text) || tc.text || '';
    return await host.renderTemplate(tpl, data || {}, playerId);
  }

  async function renderTemplateInline(key, ctx) {
    // 2026-09-18：变体展开与 DB/内存查找统一走 lookupTemplateContent（原来这里另抄了一份）
    const tc = await lookupTemplateContent(key);
    return await renderTemplateContent(tc, ctx.data || {}, ctx.playerId);
  }

  /** 上下文键并进回复数据：回复模板里就能写 [群ID] [玩家id] [输入] [状态名] */
  function ctxDataFor(out) {
    const d = (out && out.data) || {};
    const extra = {};
    for (const k of ['玩家id', '玩家ID', '群id', '群ID', '原始消息', '输入', '状态名']) {
      const v = d[k];
      if (v === undefined || v === null) continue;
      extra[k] = (typeof v === 'string') ? host.protectBrackets(v) : v;
    }
    return extra;
  }

  function buildResponse(out, key) {
    if (!out.ok) {
      const code = out.code || 'E_INTERNAL';
      // 只有「外层这条逻辑本身不存在/被禁用」才用那两个专用模板；
      // 嵌套调用失败（E_NOT_FOUND 但 outer 未标记）走通用错误模板，把真实原因原样说给玩家
      const isNotFound = code === 'E_NOT_FOUND' && out.outer === true;
      const isDisabled = code === 'E_DISABLED';
      return {
        status: isNotFound ? 'fail_notfound' : (isDisabled ? 'fail_disabled' : 'fail_error'),
        data: Object.assign({ key, '错误信息': host.protectBrackets(out.error || '未知错误') }, ctxDataFor(out)),
        templateKey: isNotFound ? 'super:invoke.fail_notfound' : (isDisabled ? 'super:invoke.fail_disabled' : 'super:invoke.error'),
      };
    }
    // 2026-09-18：作者向的「没有输出」诊断（「执行到「发消息」(n3) 走的是「往下」出口…」）以前原样发给玩家，
    // 玩家收到的是给作者看的排障话术。这里换成人话；完整诊断在运行历史与编辑器「运行记录」里。
    let msg = out.diagnostic ? '（这条逻辑现在没有回复内容，已经记录下来了）' : (out.text || '');
    if (msg.length > C.MAX_OUTPUT_BYTES) msg = msg.slice(0, C.MAX_OUTPUT_BYTES) + '\n…（输出过长已截断）';
    return { status: 'success', data: Object.assign({ key, '消息': host.protectBrackets(msg) }, ctxDataFor(out)), templateKey: 'super:invoke.success' };
  }

  // =====================================================================
  // 无输出诊断（2026-09-18 S2 第三批从 superModule 搬入）
  // 原来只要没有文本就回一句「（该逻辑没有输出内容）」，用户完全不知道问题在哪。
  // 现在按执行轨迹分四种情况说清楚：空图 / 结束块内容为空 / 出口没连线 / 根本没有输出块。
  // =====================================================================
  const PORT_LABEL = { next: '往下', true: '真', false: '假', body: '循环体', catch: '捕获', else: '其它' };

  /** 必填参数没填的第一个（只认显式 required: true，避免误报） */
  function missingRequired(node) {
    if (!node) return '';
    const def = blocks[node.type];
    if (!def || !Array.isArray(def.params)) return '';
    for (const p of def.params) {
      if (p.required !== true) continue;
      const v = node.params ? node.params[p.k] : undefined;
      if (v === undefined || v === null || String(v).trim() === '') return p.label || p.k;
    }
    return '';
  }

  function describeNoOutput(ctx, graph, logic) {
    const key = (logic && logic.key) || ctx.key || '';
    const t = ctx.trace || {};
    const nodes = (graph && graph.nodes) || [];
    if (!nodes.length) {
      return { code: 'E_NO_OUTPUT', reason: 'empty', text: '（逻辑【' + key + '】是空的：图里一个块都没有。请在自定义逻辑编辑器里拖一个「发消息」或「返回文本」块，并从「开始」连过去）' };
    }
    if (t.stopBlock && (t.stopBlock.type === 'return_text' || t.stopBlock.type === 'return_tpl')) {
      const b = t.stopBlock;
      const what = b.type === 'return_text' ? '文本求值为空' : '模板 key 为空/模板不存在';
      return { code: 'E_NO_OUTPUT', reason: 'empty_return', text: '（逻辑【' + key + '】没有输出：走到「' + b.name + '」(' + b.nodeId + ') 时' + what + '。检查它的表达式与参数有没有写错）' };
    }
    // 输出块跑了，但产出的全是空（2026-09-17）：最常见的真凶是「消息内容」这类表达式字段里
    // 直接写了中文没加引号 —— 表达式引擎当变量名 → 求值 null → 推出一个空串。
    if (Array.isArray(ctx.emits) && ctx.emits.length) {
      const allEmpty = ctx.emits.every((e) => !e.text);
      if (allEmpty) {
        const e0 = ctx.emits[0];
        return {
          code: 'E_NO_OUTPUT', reason: 'empty_expr',
          text: '（逻辑【' + key + '】没有输出：「' + e0.name + '」(' + e0.nodeId + ') 的「' + e0.param + '」'
            + explainEmptyExpr(e0.raw) + '）',
        };
      }
    }
    if (t.deadEnd) {
      const d = t.deadEnd;
      const miss = missingRequired(t.stopBlock || { type: d.type, params: d.params || {} });
      const portLabel = d.portLabel || PORT_LABEL[d.port] || d.port;
      return {
        code: 'E_NO_OUTPUT', reason: 'dead_end',
        text: '（逻辑【' + key + '】没有输出：执行到「' + d.name + '」(' + d.nodeId + ') 走的是「' + portLabel + '」出口，'
          + '但那条出口没有连到任何块' + (miss ? '；而且它的「' + miss + '」还没填' : '')
          + ' → 请在编辑器里把这个出口接到「发消息」或「返回文本」）',
      };
    }
    if (t.stopBlock) {
      return { code: 'E_NO_OUTPUT', reason: 'early_stop', text: '（逻辑【' + key + '】没有输出：「' + t.stopBlock.name + '」(' + t.stopBlock.nodeId + ') 提前结束了流程（跳出循环 / 汇合未满），后面没有块产生回复）' };
    }
    return { code: 'E_NO_OUTPUT', reason: 'no_output_block', text: '（逻辑【' + key + '】没有输出：这条逻辑里没有能把内容送出去的块（「发消息」/「发模板消息」/「返回文本」/「返回模板」））' };
  }

  return { lookupTemplateContent, renderTemplateContent, renderTemplateInline, ctxDataFor, buildResponse, PORT_LABEL, missingRequired, describeNoOutput };
}

module.exports = { createRespond };
