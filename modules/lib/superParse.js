/**
 * 中文 DSL 解析层（2026-09-19 S4 第二批：从 superCode.js 整块搬出，治「解析与执行同体」）
 * ------------------------------------------------------------------
 * 输入是代码文本，输出是语句节点树（AST）：
 *   ① 顶层逗号切分 / 去引号 / 字面量归一（splitTop · unquote · dslVal）
 *   ② 参数按块定义顺序落位（dslParams）与老式空格写法兼容（dslLegacy）
 *   ③ 单行匹配（matchLine · dslMatchKw）与整程序解析（parseProgram）
 *   ④ 判断「这段代码有没有输出语句」（hasOutputStmt，诊断要用）
 * 本层不碰 core、不碰块库、不执行任何语句 —— 纯文本进、纯数据出，可单独测。
 *
 * 语句表（关键字/平铺/分支/参数顺序）是唯一来源 lib/superStatements.js（与编辑器 DSL_FLAT/DSL_BRANCH 同源，契约 K2 钉着）。
 */
'use strict';
const { S_KW, EMPTY_ARG, CLOSERS, S_FLAT, S_BRANCH, S_BY_TYPE, PARAM_KEYS, NAME_OF } = require('./superStatements');

function splitTop(s) {                          // 顶层逗号切分（括号/引号里的逗号不算分隔符）
  const out = []; let cur = ''; let depth = 0; let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth <= 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
function unquote(s) {
  const t = String(s == null ? '' : s).trim();
  if (t.length > 1 && ((t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') || (t.charAt(0) === "'" && t.charAt(t.length - 1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}
function dslVal(s) { return (s == null || s === '' || s === EMPTY_ARG) ? '' : String(s); }
function dslParams(args, spec) {
  // 2026-09-18（参考实例轮）：单参数语句（发送/返回/建列表/日志…）里，块存储的是【一整个参数字符串】，
  // 顶层逗号属于那个字符串（块模式下 items = "a","b" 走的就是"顶层逗号 = 列表字面量"）。
  // 所以这里把多段逗号文本原样拼回那唯一一个参数：既与块语义一致，也让
  // 「由块生成代码 → 由代码生成块」对多元素列表往返无损（原来是只留第一段，静默吃掉后面的）。
  if (spec.length === 1 && args.length > 1) args = [args.join(',')];
  const o = {};
  for (let i = 0; i < spec.length; i++) {
    const raw = args[i] == null ? '' : String(args[i]);
    o[spec[i].k] = dslVal(spec[i].u ? unquote(raw) : raw);
  }
  // 参数比定义多（多参数语句被多写）→ 记一笔，执行时报出来。
  // 原来是静默丢掉多余的，等于把玩家写的代码吃了。
  if (args.length > spec.length) o.__extra = args.length - spec.length;
  return o;
}
function dslLegacy(rest, d) {
  const toks = rest ? rest.split(/\s+/) : []; const o = {};
  if (d.lg === 'query') {
    const mq = rest.match(/^(\S+)\s+按\s+(\S+)\s*=\s*(.*?)(?:\s+取\s+(\S+))?$/);
    if (mq) return { table: unquote(mq[1]), by: unquote(mq[2]), value: dslVal(mq[3]), field: unquote(mq[4] || '') };
  }
  for (let i = 0; i < d.p.length; i++) {
    let raw;
    if (d.p.length === 1 && d.lg === 'rest') raw = rest;
    else if (i === d.p.length - 1) raw = toks.slice(i).join(' ');
    else raw = toks[i] || '';
    o[d.p[i].k] = dslVal(d.p[i].u ? unquote(raw) : raw);
  }
  return o;
}
function dslMatchKw(s, d) {
  if (d.head) {                                  // 如果 / 否则如果：空格式与括号式都认
    if (s === d.kw) { const a = {}; a[d.p[0].k] = ''; return a; }
    if (s.indexOf(d.kw + ' ') === 0) { const b = {}; b[d.p[0].k] = dslVal(s.slice(d.kw.length + 1).trim()); return b; }
    if (s.indexOf(d.kw + '(') === 0 && s.charAt(s.length - 1) === ')') {
      const c = {}; c[d.p[0].k] = dslVal(s.slice(d.kw.length + 1, s.length - 1).trim()); return c;
    }
    return null;
  }
  if (s.indexOf(d.kw + '(') === 0 && s.charAt(s.length - 1) === ')') return dslParams(splitTop(s.slice(d.kw.length + 1, s.length - 1)), d.p);
  if (d.lg === 'none' || !d.lg) return null;
  let rest;
  if (s === d.kw) rest = '';
  else if (s.indexOf(d.kw + ' ') === 0) rest = s.slice(d.kw.length + 1).trim();
  else return null;
  return dslLegacy(rest, d);
}
function matchLine(s) {
  if (!s) return null;
  if (s.charAt(0) === '#') return { k: 'comment' };
  if (s === S_KW.else) return { k: 'else' };
  if (CLOSERS.indexOf(s) >= 0) return { k: 'closer' };
  if (s === S_KW.catchOne) return { k: 'catch' };
  let i, p;
  for (i = 0; i < S_BRANCH.length; i++) {
    p = dslMatchKw(s, S_BRANCH[i]);
    if (p) return { k: (S_BRANCH[i].t === 'elseif' ? 'elseif' : 'branch'), type: S_BRANCH[i].t, params: p, kw: S_BRANCH[i].kw };
  }
  if (s === S_KW.tryOne) return { k: 'try' };
  const mL = s.match(new RegExp('^' + S_KW.loopN + '\\s+(.+?)(\\s*' + S_KW.loopTail + ')?$'));
  if (mL) return { k: 'loop', type: 'loop_n', params: { count: dslVal(mL[1].trim()) }, kw: S_KW.loopN + ' ' + S_KW.loopTail, closer: S_KW.endLoop };
  const mE = s.match(new RegExp('^' + S_KW.each + '\\s+(\\S+)\\s+' + S_KW.eachIn + '\\s+(.*)$'));
  if (mE) return { k: 'loop', type: 'loop_each', params: { 'var': dslVal(unquote(mE[1])), list: dslVal(mE[2]) }, kw: S_KW.each, closer: S_KW.endEach };
  for (i = 0; i < S_FLAT.length; i++) {
    p = dslMatchKw(s, S_FLAT[i]);
    if (p) return { k: 'stmt', type: S_FLAT[i].t, params: p, kw: S_FLAT[i].kw };
  }
  const k = s.indexOf('=');
  if (k > 0) {
    const nm = s.slice(0, k).trim(); const vl = s.slice(k + 1).trim();
    if (nm) return { k: 'stmt', type: 'assign', params: { name: dslVal(nm), value: dslVal(vl) }, kw: '变量赋值' };
  }
  return null;
}

/* =====================================================================
 * 3. 解析器：缩进（2 空格）→ AST
 *    与编辑器 dslToGraph 同一套缩进规则：
 *      · 体比头多缩进（2 空格为标准，多写也不报错）；缩进回退即退出本层
 *      · 否则/结束xxx/捕获 属于上一层，遇到就回退
 *      · 认不出的行 → unknown 节点，执行到它才报错（带行号 + 人话）
 * ===================================================================== */
function parseProgram(code) {
  const lines = String(code == null ? '' : code).split(/\r?\n/);
  let cur = 0;
  const at = (i) => (i >= 0 && i < lines.length) ? String(lines[i]).trim() : null;
  const indentOf = (raw) => {
    const m = /^[ \t]*/.exec(String(raw))[0]; let n = 0;
    for (let i = 0; i < m.length; i++) n += (m.charAt(i) === '\t' ? 2 : 1);
    return n;
  };
  function parseOne() {
    const raw = lines[cur];
    const ln = cur + 1;
    const indent = indentOf(raw);
    const st = matchLine(String(raw).trim());
    if (!st) { cur++; return { k: 'unknown', raw: String(raw).trim(), line: ln }; }   // 认不出的行也要吃掉，否则解析器原地打转
    if (st.k === 'branch' || st.k === 'elseif') {
      const node = { k: 'branch', type: st.type, params: st.params, kw: st.kw, line: ln, elseIfs: [], elseBody: null };
      cur++;
      node.thenBody = parseBlock(indent + 2);
      while (cur < lines.length) {
        if (at(cur) === S_KW.else) { cur++; node.elseBody = parseBlock(indent + 2); break; }
        const st2 = matchLine(at(cur));
        if (st2 && st2.k === 'elseif') {
          const ln2 = cur + 1;
          cur++;
          node.elseIfs.push({ params: st2.params, kw: st2.kw, line: ln2, body: parseBlock(indent + 2) });
          continue;
        }
        break;
      }
      if (at(cur) === S_KW.endIf) cur++;
      return node;
    }
    if (st.k === 'loop') {
      const node = { k: 'loop', type: st.type, params: st.params, kw: st.kw, line: ln };
      cur++;
      node.body = parseBlock(indent + 2);
      if (at(cur) === st.closer) cur++;
      return node;
    }
    if (st.k === 'try') {
      const node = { k: 'try', line: ln, kw: S_KW.tryOne, params: {}, body: [], catchBody: null };
      cur++;
      node.body = parseBlock(indent + 2);
      if (at(cur) === S_KW.catchOne) { cur++; node.catchBody = parseBlock(indent + 2); }
      if (at(cur) === S_KW.endTry) cur++;
      return node;
    }
    cur++;
    return { k: 'stmt', type: st.type, params: st.params, kw: st.kw, line: ln };
  }
  function parseBlock(indent) {
    const out = [];
    while (cur < lines.length) {
      const raw = lines[cur];
      if (!String(raw).trim()) { cur++; continue; }
      if (indentOf(raw) < indent) break;
      const st = matchLine(String(raw).trim());
      if (st && (st.k === 'else' || st.k === 'closer' || st.k === 'catch')) break;
      if (st && st.k === 'comment') { cur++; continue; }
      const node = parseOne();
      if (node) out.push(node);
    }
    return out;
  }
  return parseBlock(0);
}

/** AST 里有没有能把内容送出去的语句（发送/返回/发送模板/返回模板/推送） */
function hasOutputStmt(nodes) {
  for (const n of nodes || []) {
    if (n.k === 'stmt' && ['msg_send', 'return_text', 'tpl_send', 'return_tpl', 'push_send'].indexOf(n.type) >= 0) return true;
    if (n.k === 'branch') {
      if (hasOutputStmt(n.thenBody) || hasOutputStmt(n.elseBody)) return true;
      for (const e of (n.elseIfs || [])) if (hasOutputStmt(e.body)) return true;
    }
    if (n.k === 'loop' && hasOutputStmt(n.body)) return true;
    if (n.k === 'try' && (hasOutputStmt(n.body) || hasOutputStmt(n.catchBody))) return true;
  }
  return false;
}

module.exports = { splitTop, unquote, dslVal, dslParams, dslLegacy, dslMatchKw, matchLine, parseProgram, hasOutputStmt };
