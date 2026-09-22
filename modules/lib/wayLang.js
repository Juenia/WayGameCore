/**
 * WayGame · .way 语言（C 风格多文件代码，2026-09-18）
 * =====================================================================
 * 主人定的规格：
 *   · 一个自定义功能可以有【多个代码文件】，文件之间可以互相引用（#引用 "别的.way"）
 *   · 主入口固定 main.way，对接口是主函数 int main()
 *   · 写法参考 C：大括号、分号、类型标注、函数声明（原型）+ 定义
 *   · 跨文件调用函数要【提前声明】；声明了必须定义
 *   · 语句与函数库保持中文（发送/加货币/拼接/求和…），门槛低上限高
 *
 * 本文件只做三件事，执行交给 superCode 的同一个执行器（语义只有一份）：
 *   ① 词法 + 语法：C 风格结构 → 节点
 *   ② 链接：解析 #引用、收函数表、查「没声明的调用 / 只声明没定义 / 重复定义 / 没有 main」
 *   ③ 发射：产出 superCode 能直接跑的 AST（语句参数用 superCode 自己的 dslParams 映射，
 *      所以「发送("x")」在两种语言里落到同一个 type/params，语义不可能飘）
 *
 * 支持的写法（中英双写，门槛低）：
 *   控制流：if/如果、else/否则、else if/否则如果、while/当、for、循环 (N)、遍历 (项 在 列表)、
 *          try/尝试…catch/捕获、break/跳出循环、continue/继续、return/返回
 *   语句库：S_FLAT / S_BRANCH 里的全部中文语句（发送/加货币/加物品/传送/查询/调用…）
 *          —— 括号写法，参数逗号分隔，结尾分号（漏了分号但下一行是新语句时会被容错接受）
 *   表达式：直接交给 superExpr（94 个纯函数 + 玩家.x/参数.n/变量.x/节点.x + 用户函数）
 *
 * 用法：
 *   const way = require('./wayLang');
 *   const out = way.compileProject({ 'main.way': '...', '工具.way': '...' }, 'main.way');
 *   if (!out.ok) 报 out.errors（每条带文件 + 行号 + 人话）
 *   else 交给 superCode.runAst(out.program, ctx)
 */
'use strict';

const superCode = require('./superCode');
const superExpr = require('./superExpr');
const S_BY_TYPE = superCode.S_BY_TYPE || {};
const EMPTY_ARG = '（空）';
/** 语句表按【关键字】索引（发送/加货币/返回模板…）—— .way 里的"语句"就是这些内置函数 */
const S_BY_KW = {};
(superCode.S_FLAT || []).forEach((d) => { S_BY_KW[d.kw] = d; });
(superCode.S_BRANCH || []).forEach((d) => { S_BY_KW[d.kw] = d; });
/** 表达式函数库（拼接/求和/建列表…）：这些名字不算"用户函数"，不做声明检查 */
let EXPR_FUNCS = new Set();
try { EXPR_FUNCS = new Set(superExpr.listFuncs()); } catch (e) { EXPR_FUNCS = new Set(); }
function isBuiltinName(n) { return !!S_BY_KW[n] || EXPR_FUNCS.has(n); }

/* =====================================================================
 * 数据类型：中文 / 英文【两种写法等价】，随你顺手写哪种（2026-09-18 主人要求）
 *   整数 int / 小数 float·double / 数字 number / 文本 string / 真假 bool /
 *   列表 list·array / 字典 map·object / 空 void / 任意 any
 * 类型目前只做「看得懂的标注」：编译期不因为类型不符拦人（门槛低），
 * 但统一规范化成中文名留着 —— 以后要加类型检查，从这张表出发就行。
 * ===================================================================== */
const TYPE_ALIASES = {
  // —— 数字 ——
  int: '整数', integer: '整数', 整数: '整数',
  float: '小数', double: '小数', 小数: '小数',
  number: '数字', 数字: '数字',
  // —— 文本 ——
  string: '文本', str: '文本', char: '文本', 文本: '文本', 字符串: '文本',
  // —— 真假 ——
  bool: '真假', boolean: '真假', 真假: '真假', 布尔: '真假',
  // —— 列表 ——
  list: '列表', array: '列表', 列表: '列表', 数组: '列表',
  // —— 字典 ——
  map: '字典', object: '字典', dict: '字典', json: '字典', 字典: '字典', 对象: '字典',
  // —— 空 / 任意 ——
  void: '空', 空: '空', 无: '空', none: '空',
  any: '任意', var: '任意', 任意: '任意',
};
const TYPE_WORDS = Object.keys(TYPE_ALIASES);
/** 把任意写法的类型名规范化成中文名（认不出来就原样返回） */
function typeLabel(v) {
  const s = String(v == null ? '' : v).trim();
  return TYPE_ALIASES[s] || s;
}
/** 中英两种写法的类型名对照（给编辑器补全/文档用） */
function typePairs() {
  const out = [], seen = {};
  for (const k of TYPE_WORDS) {
    const c = TYPE_ALIASES[k];
    if (!seen[c]) { seen[c] = { cn: c, en: [] }; out.push(seen[c]); }
    if (/^[A-Za-z]+$/.test(k)) seen[c].en.push(k);
  }
  return out;
}
const KW_IF = ['if', '如果'];
const KW_ELSE = ['else', '否则'];
const KW_WHILE = ['while', '当'];
const KW_FOR = ['for'];
const KW_LOOP = ['循环'];
const KW_EACH = ['遍历'];
const KW_TRY = ['try', '尝试'];
const KW_CATCH = ['catch', '捕获'];
const KW_BREAK = ['break', '跳出循环'];
const KW_CONT = ['continue', '继续'];
const KW_RET = ['return', '返回'];
const KW_IN = ['in', '在'];
const KW_TRUE = ['true', '真'];
const KW_FALSE = ['false', '假'];
const KW_NULL = ['null', '空值'];

/* =====================================================================
 * 1. 词法
 * ===================================================================== */
function isIdStart(ch) { return /[A-Za-z_\u4e00-\u9fa5]/.test(ch); }
function isIdChar(ch) { return /[A-Za-z0-9_\u4e00-\u9fa5]/.test(ch); }

function tokenize(src) {
  const s = String(src == null ? '' : src);
  const out = [];
  let i = 0, line = 1, col = 1;
  // 双字符运算符要先认，否则 >= 会被拆成 > 与 =
  const TWO = ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '::'];
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { line++; col = 1; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; col++; continue; }
    // 注释
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      const start = line;
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') line++; i++; }
      if (i >= s.length) out.push({ t: 'err', v: '块注释没有收尾（少了 */）', line: start, col: 1, at: i });
      i += 2;
      continue;
    }
    // 字符串
    if (c === '"' || c === "'") {
      const q = c, startLine = line, startAt = i;
      i++; col++;
      let buf = '';
      let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === '\\') { buf += s[i + 1] === 'n' ? '\n' : s[i + 1]; i += 2; col += 2; continue; }
        if (d === q) { closed = true; i++; col++; break; }
        if (d === '\n') break;
        buf += d; i++; col++;
      }
      if (!closed) out.push({ t: 'err', v: '引号没有成对（' + q + ' 少了一个）', line: startLine, col: 1, at: startAt });
      out.push({ t: 'str', v: buf, line: startLine, col: 1, at: startAt, end: i });
      continue;
    }
    // 数字
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const startAt = i, startCol = col;
      while (i < s.length && /[0-9.]/.test(s[i])) { i++; col++; }
      out.push({ t: 'num', v: s.slice(startAt, i), line, col: startCol, at: startAt, end: i });
      continue;
    }
    // 标识符 / 关键字（中文也算标识符）
    if (isIdStart(c)) {
      const startAt = i, startCol = col;
      while (i < s.length && isIdChar(s[i])) { i++; col++; }
      out.push({ t: 'id', v: s.slice(startAt, i), line, col: startCol, at: startAt, end: i });
      continue;
    }
    // 预处理：#引用 "x.way"（也认 #include）
    if (c === '#') {
      // 只吃 #：# 后面的「引用 / include」照常当标识符读，语法层再判（这样 #引用 与 # include 都认）
      out.push({ t: 'hash', v: '#', line, col, at: i, end: i + 1 });
      i++; col++;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (TWO.indexOf(two) >= 0) { out.push({ t: 'op', v: two, line, col, at: i, end: i + 2 }); i += 2; col += 2; continue; }
    if ('{}()[];,+-*/%<>=!&|.?:'.indexOf(c) >= 0) { out.push({ t: 'op', v: c, line, col, at: i, end: i + 1 }); i++; col++; continue; }
    out.push({ t: 'err', v: '不认识的字符「' + c + '」', line, col, at: i });
    i++; col++;
  }
  out.push({ t: 'eof', v: '', line, col, at: s.length, end: s.length });
  return out;
}

/* =====================================================================
 * 2. 语法：文件 → 函数/全局/#引用
 * ===================================================================== */
function isTypeWord(v) { return TYPE_WORDS.indexOf(v) >= 0; }
/** 一条新语句会以哪些词开头（漏分号容错时用来断句） */
const STMT_STARTERS = [].concat(KW_IF, KW_ELSE, KW_WHILE, KW_FOR, KW_LOOP, KW_EACH, KW_TRY, KW_BREAK, KW_CONT, KW_RET);
function isKw(v, list) { return list.indexOf(v) >= 0; }

class Parser {
  constructor(src, fileName) {
    this.src = String(src == null ? '' : src);
    this.file = fileName || 'main.way';
    this.tks = tokenize(this.src);
    this.i = 0;
    this.errors = [];
  }
  peek(k) { return this.tks[this.i + (k || 0)] || this.tks[this.tks.length - 1]; }
  next() { return this.tks[this.i++] || this.tks[this.tks.length - 1]; }
  at(v) { const t = this.peek(); return t.v === v; }
  atAny(list) { const t = this.peek(); return t.t === 'id' && list.indexOf(t.v) >= 0; }
  err(msg, tk) {
    const t = tk || this.peek();
    this.errors.push({ file: this.file, line: t.line, col: t.col, msg: msg });
    return null;
  }
  raw(from, to) { return this.src.slice(this.tks[from].at, this.tks[to - 1] ? this.tks[to - 1].end : this.tks[from].end); }
  skipSemi() {
    if (this.at(';')) { this.next(); return true; }
    const t = this.peek();
    if (t.t === 'eof' || t.v === '}') return true;      // 容错：漏了分号但明显该收尾了
    const prev = this.tks[this.i - 1];
    if (prev && t.line > prev.line) return true;        // 换行也算收尾：上一行那句话写完了
    if (t.t === 'id') {
      // 下一行以语句/控制关键字开头 → 也当"漏了分号"
      const starts = [].concat(KW_IF, KW_ELSE, KW_RET, KW_BREAK, KW_CONT, KW_WHILE, KW_FOR, KW_LOOP, KW_EACH, KW_TRY).concat(TYPE_WORDS);
      if (starts.indexOf(t.v) >= 0) return true;
    }
    return false;
  }
  /** 读一段表达式原文：从当前记号开始，遇到顶层 stop 记号停下（不会吃掉它） */
  readExpr(stops, opts) {
    const o = opts || {};
    const start = this.i;
    let depth = 0, seenTok = 0;
    while (this.i < this.tks.length) {
      const t = this.peek();
      if (t.t === 'eof') break;
      if (depth === 0 && stops.indexOf(t.v) >= 0) break;
      // 语句模式：上一行已经写完一条语句（以 ) 收尾），这一行又以类型/关键字开头 → 上一句就是漏了分号
      if (o.stmt && depth === 0 && seenTok > 0) {
        const prev = this.tks[this.i - 1];
        if (t.line > prev.line && prev.v === ')' && t.t === 'id' && (isTypeWord(t.v) || STMT_STARTERS.indexOf(t.v) >= 0)) break;
      }
      seenTok++;
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') { if (depth === 0) break; depth--; }
      this.i++;
    }
    if (this.i === start) return { text: '', line: this.peek().line, empty: true };
    const text = this.src.slice(this.tks[start].at, this.tks[this.i - 1].end).trim();
    return { text, line: this.tks[start].line, empty: false };
  }
  /* ---------------- 顶层 ---------------- */
  parseFile() {
    const includes = [];
    const funcs = [];
    const globals = [];
    while (this.peek().t !== 'eof') {
      const t = this.peek();
      if (t.t === 'err') { this.err(t.v, t); this.next(); continue; }
      if (t.t === 'hash') {
        this.next();
        const nt = this.peek();
        if (nt.v !== '引用' && nt.v !== 'include') { this.err('只认 #引用 "文件名.way"（或 #include）', nt); continue; }
        this.next();
        const ft = this.next();
        if (ft.t !== 'str') { this.err('#引用 后面要跟用引号包起来的文件名，例如 #引用 "工具.way"', ft); continue; }
        includes.push({ name: ft.v, line: t.line });
        this.skipSemi();
        continue;
      }
      if (t.t !== 'id') { this.err('这里应该是类型 + 函数名（或全局变量），读到的是「' + String(t.v || t.t) + '」', t); this.next(); continue; }
      if (!isTypeWord(t.v)) {
        this.err('函数/变量前面要写类型 —— 中文英文都行（整数=int / 小数=float / 文本=string / 真假=bool / 列表=list / 字典=map / 空=void / 任意=any），读到的是「' + t.v + '」', t);
        // 兜底：跳到下一个分号或 }，避免解析器原地打转
        while (this.peek().t !== 'eof' && !this.at(';') && !this.at('}')) this.next();
        this.skipSemi();
        continue;
      }
      const retType = this.next().v;
      const nameTk = this.next();
      if (nameTk.t !== 'id') { this.err('类型「' + retType + '」后面要跟名字', nameTk); continue; }
      if (this.at('(')) {
        const fn = this.parseFnHead(retType, nameTk);
        if (fn) funcs.push(fn);
        continue;
      }
      // 全局变量：类型 名 = 表达式;
      const eq = this.peek();
      if (eq.v !== '=') { this.err('全局变量要写初始值：' + retType + ' ' + nameTk.v + ' = 值;', eq); while (this.peek().t !== 'eof' && !this.at(';')) this.next(); this.skipSemi(); continue; }
      this.next();
      const ex = this.readExpr([';']);
      globals.push({ name: nameTk.v, type: retType, value: ex.text, line: nameTk.line });
      if (!this.skipSemi()) this.err('这里少了一个分号「;」', this.peek());
    }
    return { file: this.file, includes, funcs, globals, errors: this.errors };
  }
  parseFnHead(retType, nameTk) {
    this.next();   // (
    const params = [];
    if (!this.at(')')) {
      for (;;) {
        const tt = this.next();
        if (tt.t !== 'id' || !isTypeWord(tt.v)) { this.err('参数要写成「类型 名字」，例如 int 数量', tt); return null; }
        const pn = this.next();
        if (pn.t !== 'id') { this.err('参数缺少名字', pn); return null; }
        params.push({ type: tt.v, name: pn.v, line: pn.line });
        if (this.at(',')) { this.next(); continue; }
        break;
      }
    }
    if (!this.at(')')) { this.err('参数表没有闭合：少了一个「)」', this.peek()); return null; }
    this.next();
    const fn = { name: nameTk.v, retType, params, line: nameTk.line, file: this.file, body: null, defined: false };
    if (this.at(';')) { this.next(); return fn; }          // 原型声明
    if (!this.at('{')) { this.err('函数「' + nameTk.v + '」后面要么是「;」（只声明），要么是「{」（写函数体）', this.peek()); return fn; }
    const body = this.parseBlock();
    if (body === null) return null;
    fn.body = body;
    fn.defined = true;
    fn.bodyEnd = this.peek().line;
    return fn;
  }
  /* ---------------- 语句块 ---------------- */
  parseBlock() {
    const open = this.peek();
    if (!this.at('{')) { this.err('这里应该是「{」开始一个语句块', open); return null; }
    this.next();
    const out = [];
    while (this.peek().t !== 'eof' && !this.at('}')) {
      const st = this.parseStmt();
      if (st === null) continue;
      if (Array.isArray(st)) out.push(...st); else out.push(st);
    }
    if (!this.at('}')) this.err('语句块没有闭合：少了一个「}」', this.peek());
    else this.next();
    return out;
  }
  parseStmt() {
    const t = this.peek();
    if (t.t === 'err') { this.err(t.v, t); this.next(); return null; }
    if (t.v === '{') return this.parseBlock();
    if (t.v === ';') { this.next(); return null; }
    if (t.t === 'id') {
      // 控制流
      if (isKw(t.v, KW_IF)) return this.parseIf();
      if (isKw(t.v, KW_WHILE)) return this.parseWhile();
      if (isKw(t.v, KW_FOR)) return this.parseFor();
      if (isKw(t.v, KW_LOOP)) return this.parseLoopN();
      if (isKw(t.v, KW_EACH)) return this.parseEach();
      if (isKw(t.v, KW_TRY)) return this.parseTry();
      if (isKw(t.v, KW_BREAK)) { this.next(); this.skipSemi(); return { k: 'break', line: t.line, file: this.file }; }
      if (isKw(t.v, KW_CONT)) { this.next(); this.skipSemi(); return { k: 'continue', line: t.line, file: this.file }; }
      if (isKw(t.v, KW_RET)) return this.parseReturn();
      if (isTypeWord(t.v)) {
        // 是声明还是"类型同名的函数调用"？看第二个记号是不是名字：
        //   类型 名字 = 值;      类型 名字 值;（老式空格写法）      类型 名字;      类型 名字, 类型 名字)（参数表里）
        // 都不是（比如 文本(参数.1)）→ 当普通语句
        const nx = this.peek(1), nx2 = this.peek(2);
        if (nx && nx.t === 'id') {
          if (!nx2) return this.parseVarDecl();
          if (nx2.v === '=' || nx2.v === ';' || nx2.v === ',' || nx2.v === ')') return this.parseVarDecl();
          if (nx2.line !== nx.line) return this.parseVarDecl();   // 名字后面就换行了 → 只声明，值以后再赋
          return this.parseVarDecl();                             // 同一行还有第三段 → 那就是初始值
        }
      }
    }
    return this.parseExprStmt();
  }
  /**
   * 声明里的初始值（两种写法都认，2026-09-18 主人定）：
   *   ① 等号写法：文本 名称 = "小明";
   *   ② 【老式空格写法】文本 名称 小明;     ← 同一行的第三段就是值；只写「文本 名称;」也行，后面再赋值
   * 值必须在同一行，否则当成"声明完了、没给值"，免得把下一行整条语句吞掉。
   */
  readDeclValue(nameTk) {
    if (this.at('=')) { this.next(); return this.readExpr([';', ')', ',']).text; }
    const nx = this.peek();
    if (!nx || nx.t === 'eof' || nx.line !== nameTk.line) return '';
    if (this.at(';') || this.at(')') || this.at(',')) return '';
    return this.readExpr([';', ')', ',']).text;
  }
  /** 局部变量声明：类型 名 = 表达式;  或  类型 名 表达式; */
  parseVarDecl() {
    const t = this.next();      // 类型
    const nameTk = this.next();
    if (nameTk.t !== 'id') { this.err('类型「' + t.v + '」后面要跟变量名', nameTk); return null; }
    const value = this.readDeclValue(nameTk);
    if (!this.skipSemi()) this.err('变量声明后面少了一个分号「;」', this.peek());
    return { k: 'stmt', type: 'assign', params: { name: nameTk.v, value: value }, kw: '变量赋值', line: nameTk.line, file: this.file, decl: t.v };
  }
  parseReturn() {
    const t = this.next();
    if (this.at(';') || this.at('}')) { this.skipSemi(); return { k: 'ret', value: '', line: t.line, file: this.file }; }
    const ex = this.readExpr([';', '}']);
    this.skipSemi();
    return { k: 'ret', value: ex.text, line: t.line, file: this.file };
  }
  parseIf() {
    const t = this.next();
    const cond = this.readParen('条件');
    if (cond === null) return null;
    const thenBody = this.parseBlock();
    if (thenBody === null) return null;
    const node = { k: 'branch', type: 'condition', params: { expr: cond.text }, kw: t.v, line: t.line, file: this.file, thenBody, elseIfs: [], elseBody: null };
    // else / 否则 / else if / 否则如果
    if (this.atAny(KW_ELSE)) {
      const et = this.next();
      if (isKw(this.peek().v, KW_IF)) { this.next(); const c2 = this.readParen('条件'); if (c2 === null) return node; const b2 = this.parseBlock(); if (b2 === null) return node; node.elseIfs.push({ params: { expr: c2.text }, kw: et.v + ' ' + KW_IF[0], line: et.line, body: b2 }); return this.chainElseIfs(node); }
      node.elseBody = this.parseBlock();
      return node;
    }
    return node;
  }
  chainElseIfs(node) {
    while (this.atAny(KW_ELSE)) {
      const et = this.next();
      if (isKw(this.peek().v, KW_IF)) {
        this.next();
        const c2 = this.readParen('条件');
        if (c2 === null) return node;
        const b2 = this.parseBlock();
        if (b2 === null) return node;
        node.elseIfs.push({ params: { expr: c2.text }, kw: KW_ELSE[0] + ' ' + KW_IF[0], line: et.line, body: b2 });
        continue;
      }
      node.elseBody = this.parseBlock();
      break;
    }
    return node;
  }
  parseWhile() {
    const t = this.next();
    const cond = this.readParen('条件');
    if (cond === null) return null;
    const body = this.parseBlock();
    if (body === null) return null;
    return { k: 'while', params: { expr: cond.text }, kw: t.v, line: t.line, file: this.file, body };
  }
  parseFor() {
    const t = this.next();
    if (!this.at('(')) { this.err('for 后面要跟 (初始; 条件; 步进)', this.peek()); return null; }
    this.next();
    // 初始
    let init = null;
    if (!this.at(';')) {
      init = isTypeWord(this.peek().v) ? this.parseVarDeclInline() : this.parseSimpleInline();
      if (init === null) return null;
    }
    if (!this.at(';')) { this.err('for 的三段要用「;」分开（初始; 条件; 步进）', this.peek()); return null; }
    this.next();
    const cond = this.at(';') ? { text: '真' } : this.readExpr([';']);
    if (!this.at(';')) { this.err('for 的三段要用「;」分开（初始; 条件; 步进）', this.peek()); return null; }
    this.next();
    let step = null;
    if (!this.at(')')) { step = this.parseSimpleInline(); if (step === null) return null; }
    if (!this.at(')')) { this.err('for 的参数表没有闭合：少了一个「)」', this.peek()); return null; }
    this.next();
    const body = this.parseBlock();
    if (body === null) return null;
    return { k: 'for', kw: t.v, line: t.line, file: this.file, init, cond: cond.text, step, body };
  }
  /** for 的段里用：读一段直到 ; 或 )，按语句解析（不吃分隔符） */
  parseSimpleInline() {
    const t = this.peek();
    if (t.t === 'id' && isTypeWord(t.v)) return this.parseVarDeclInline();
    const start = this.i;
    const ex = this.readExpr([';', ')']);
    if (ex.empty) return null;
    const text = ex.text;
    // name ++ / name -- 糖
    const m = /^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*(\+\+|--)$/.exec(text);
    if (m) return { k: 'stmt', type: 'assign', params: { name: m[1], value: m[1] + ' ' + (m[2] === '++' ? '+' : '-') + ' 1' }, kw: '变量赋值', line: ex.line, file: this.file };
    const eq = /\s*=\s*/.exec(text);
    if (eq && text.slice(0, eq.index).indexOf('=') < 0 && /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(text.slice(0, eq.index).trim())) {
      return { k: 'stmt', type: 'assign', params: { name: text.slice(0, eq.index).trim(), value: text.slice(eq.index + eq[0].length) }, kw: '变量赋值', line: ex.line, file: this.file };
    }
    void start;
    return { k: 'callstmt', raw: text, line: ex.line, file: this.file };
  }
  parseVarDeclInline() {
    const t = this.next();
    const nameTk = this.next();
    if (nameTk.t !== 'id') { this.err('类型「' + t.v + '」后面要跟变量名', nameTk); return null; }
    const value = this.readDeclValue(nameTk);
    return { k: 'stmt', type: 'assign', params: { name: nameTk.v, value: value }, kw: '变量赋值', line: nameTk.line, file: this.file, decl: t.v };
  }
  parseLoopN() {
    const t = this.next();
    const arg = this.readParen('次数');
    if (arg === null) return null;
    const body = this.parseBlock();
    if (body === null) return null;
    return { k: 'loop', type: 'loop_n', params: { count: arg.text }, kw: t.v, line: t.line, file: this.file, body };
  }
  parseEach() {
    const t = this.next();
    if (!this.at('(')) { this.err('遍历 后面要跟 (每项变量 在 列表)，例如 遍历 (项 在 [1,2,3])', this.peek()); return null; }
    this.next();
    const varTk = this.next();
    if (varTk.t !== 'id') { this.err('遍历 缺「每项变量」名', varTk); return null; }
    const inTk = this.next();
    if (!isKw(inTk.v, KW_IN)) { this.err('遍历 里要用「在」连起来：遍历 (项 在 列表)', inTk); return null; }
    const list = this.readExpr([')']);
    if (!this.at(')')) { this.err('遍历 的参数表没有闭合：少了一个「)」', this.peek()); return null; }
    this.next();
    const body = this.parseBlock();
    if (body === null) return null;
    return { k: 'loop', type: 'loop_each', params: { 'var': varTk.v, list: list.text }, kw: t.v, line: t.line, file: this.file, body };
  }
  parseTry() {
    const t = this.next();
    const body = this.parseBlock();
    if (body === null) return null;
    let catchBody = null;
    let varName = '';
    if (this.atAny(KW_CATCH)) {
      const ct = this.next();
      if (this.at('(')) {
        this.next();
        const vt = this.next();
        if (vt.t === 'id') varName = vt.v;
        if (this.at(')')) this.next();
      }
      catchBody = this.parseBlock();
      if (catchBody === null) return null;
      void ct;
    }
    return { k: 'try', kw: t.v, line: t.line, file: this.file, params: {}, body, catchBody, catchVar: varName };
  }
  /** 普通语句：发送("x"); / x = 1; / 发奖(名字); / i++; */
  parseExprStmt() {
    const start = this.i;
    const t = this.peek();
    const ex = this.readExpr([';', '}'], { stmt: true });
    if (ex.empty) { this.err('这一行读不出语句', t); this.next(); return null; }
    const text = ex.text;
    if (!this.skipSemi()) this.err('语句后面少了一个分号「;」', this.peek());
    // 自增自减糖
    const mInc = /^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*(\+\+|--)$/.exec(text);
    if (mInc) return { k: 'stmt', type: 'assign', params: { name: mInc[1], value: mInc[1] + ' ' + (mInc[2] === '++' ? '+' : '-') + ' 1' }, kw: '变量赋值', line: ex.line, file: this.file };
    // 赋值
    const eq = /^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*=\s*([^=][\s\S]*)$/.exec(text);
    if (eq) return { k: 'stmt', type: 'assign', params: { name: eq[1], value: eq[2].trim() }, kw: '变量赋值', line: ex.line, file: this.file };
    void start;
    return { k: 'callstmt', raw: text, line: ex.line, file: this.file };
  }
  readParen(what) {
    if (!this.at('(')) { this.err(this.peek().v + ' 后面要跟括号里的' + what + '，例如 (玩家.等级 >= 10)', this.peek()); return null; }
    this.next();
    const ex = this.readExpr([')']);
    if (!this.at(')')) { this.err('括号没有闭合：少了一个「)」', this.peek()); return null; }
    this.next();
    return ex;
  }
}

/* =====================================================================
 * 3. 链接：引用解析 + 函数表 + 规则检查
 * ===================================================================== */
function splitTopRaw(s) {
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
/** 语句原文 → superCode 的语句节点（参数映射直接借 superCode 自己的 dslParams，两边不可能飘） */
function stmtFromRaw(raw, line, file) {
  const m = /^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*\(([\s\S]*)\)$/.exec(raw.trim());
  if (!m) {
    // 最常见的错法：把老 DSL 的空格写法搬过来了 —— 单独说清楚，别让人猜
    const sp = /^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s+(\S[\s\S]*)$/.exec(raw.trim());
    if (sp && S_BY_KW[sp[1]]) {
      return { ok: false, why: '「' + sp[1] + '」的参数要写进括号里、用逗号分开：' + sp[1] + '(...) —— .way 里不认「' + sp[1] + ' 参数 参数」这种靠空格分参数的老写法（那是旧版单文件 DSL 的写法）' };
    }
    return { ok: false, why: '语句要写成「名字(参数, 参数);」，读不懂「' + raw.trim() + '」' };
  }
  const name = m[1];
  const argsText = m[2];
  const empty = !argsText.trim();
  const spec = S_BY_KW[name];
  if (spec) {
    const parts = empty ? [] : splitTopRaw(argsText);
    const params = superCode.dslParams ? superCode.dslParams(parts, spec.p) : null;
    if (!params) return { ok: false, why: '内部错误：句句表没导出 dslParams' };
    return { ok: true, node: { k: 'stmt', type: spec.t, params, kw: name, line, file } };
  }
  // 用户函数调用
  const args = empty ? [] : splitTopRaw(argsText);
  return { ok: true, node: { k: 'callfn', name, args, line, file } };
}

/** 把解析树里的 callstmt 展开成真语句；顺带收集"本文件里调用到的函数名" */
function lowerBody(stmts, file, called) {
  const out = [];
  for (const st of stmts || []) {
    if (st.k === 'callstmt') {
      const r = stmtFromRaw(st.raw, st.line, st.file || file);
      if (!r.ok) return { ok: false, why: r.why, line: st.line, file: st.file || file };
      if (r.node.k === 'callfn') called.push({ name: r.node.name, line: st.line, file: st.file || file });
      out.push(r.node);
      continue;
    }
    if (st.k === 'branch') {
      const t = lowerBody(st.thenBody, file, called); if (!t.ok) return t;
      const e = lowerBody(st.elseBody, file, called); if (!e.ok) return e;
      const eis = [];
      for (const ei of (st.elseIfs || [])) { const r = lowerBody(ei.body, file, called); if (!r.ok) return r; eis.push({ params: ei.params, kw: ei.kw, line: ei.line, body: r.list }); }
      out.push(Object.assign({}, st, { thenBody: t.list, elseBody: e.list, elseIfs: eis }));
      continue;
    }
    if (st.k === 'loop' || st.k === 'while' || st.k === 'try' || st.k === 'for') {
      const r = lowerBody(st.body, file, called); if (!r.ok) return r;
      const node = Object.assign({}, st, { body: r.list });
      if (st.k === 'try') { const c = lowerBody(st.catchBody, file, called); if (!c.ok) return c; node.catchBody = c.list; }
      if (st.k === 'for') {
        const fix = (s) => { if (!s || s.k !== 'callstmt') return s; const rr = stmtFromRaw(s.raw, s.line, s.file || file); return rr.ok ? rr.node : s; };
        node.init = fix(st.init); node.step = fix(st.step);
      }
      out.push(node);
      continue;
    }
    if (st.k === 'ret' || st.k === 'break' || st.k === 'continue' || st.k === 'stmt') {
      // 表达式里也可能调用用户函数（交给表达式引擎，这里不静态收集）
      out.push(st);
      continue;
    }
    out.push(st);
  }
  return { ok: true, list: out };
}
/** 表达式里调用到的用户函数名（粗扫：标识符 + (，排除内置函数与关键字） */
function calledInExpr(text, out) {
  const s = String(text || '');
  const re = /([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*\(/g;
  let m;
  while ((m = re.exec(s))) {
    const n = m[1];
    if (isBuiltinName(n)) continue;     // 内置语句 / 表达式函数库 —— 不算用户函数
    if (KwSet.has(n)) continue;
    // 顺手把参数个数数出来（顶层逗号），编译期就能查"参数对不上"
    let depth = 0, end = -1;
    for (let x = m.index + m[0].length - 1; x < s.length; x++) {
      const c2 = s.charAt(x);
      if (c2 === '(') depth++;
      else if (c2 === ')') { depth--; if (depth === 0) { end = x; break; } }
    }
    const inside = end > 0 ? s.slice(m.index + m[0].length, end) : '';
    out.push({ name: n, argc: inside.trim() === '' ? 0 : splitTopRaw(inside).length });
  }
}
const KwSet = new Set([].concat(KW_IF, KW_ELSE, KW_WHILE, KW_FOR, KW_LOOP, KW_EACH, KW_TRY, KW_CATCH, KW_BREAK, KW_CONT, KW_RET, KW_IN, KW_TRUE, KW_FALSE, TYPE_WORDS));
function collectExprCalls(body, out) {
  for (const st of body || []) {
    if (st.k === 'stmt') { collectExprCallsExpr(st.params, out); continue; }
    if (st.k === 'ret') { calledInExpr(st.value, out); continue; }
    if (st.k === 'branch') { calledInExpr(st.params && st.params.expr, out); collectExprCalls(st.thenBody, out); collectExprCalls(st.elseBody, out); (st.elseIfs || []).forEach((e) => { calledInExpr(e.params && e.params.expr, out); collectExprCalls(e.body, out); }); continue; }
    if (st.k === 'loop') { calledInExpr(st.params && st.params.list, out); collectExprCalls(st.body, out); continue; }
    if (st.k === 'while') { calledInExpr(st.params && st.params.expr, out); collectExprCalls(st.body, out); continue; }
    if (st.k === 'try') { collectExprCalls(st.body, out); collectExprCalls(st.catchBody, out); continue; }
    if (st.k === 'for') { collectExprCalls([st.init, st.step].filter(Boolean), out); calledInExpr(st.cond, out); collectExprCalls(st.body, out); continue; }
    if (st.k === 'callfn') { (st.args || []).forEach((a) => calledInExpr(a, out)); continue; }
  }
}
function collectExprCallsExpr(params, out) {
  for (const k of Object.keys(params || {})) { const v = params[k]; if (typeof v === 'string' && v.indexOf('(') >= 0) calledInExpr(v, out); }
}

/* =====================================================================
 * 4. 编译：文件表 → 可执行 program
 * ===================================================================== */
function compileProject(files, entryName) {
  const entry = entryName || 'main.way';
  const errors = [];
  const table = files || {};
  if (!table[entry]) {
    return { ok: false, errors: [{ file: entry, line: 1, msg: '找不到入口文件「' + entry + '」（主入口固定叫 main.way）' }], program: null };
  }
  // ① 逐文件解析
  const parsed = {};
  for (const name of Object.keys(table)) {
    const p = new Parser(table[name], name).parseFile();
    parsed[name] = p;
    for (const e of p.errors) errors.push(e);
  }
  // ② 解析 #引用（含环检测）
  const order = [];
  const seen = {};
  const visit = (name, chain) => {
    if (chain.indexOf(name) >= 0) { errors.push({ file: name, line: 1, msg: '#引用 成环了：' + chain.concat([name]).join(' → ') }); return; }
    if (seen[name]) return;
    const p = parsed[name];
    if (!p) return;
    seen[name] = 1;
    for (const inc of p.includes) {
      if (!table[inc.name]) { errors.push({ file: name, line: inc.line, msg: '#引用 的文件不存在：「' + inc.name + '」（工程里只有：' + Object.keys(table).join('、') + '）' }); continue; }
      if (inc.name === entry) { errors.push({ file: name, line: inc.line, msg: '不能引用入口文件 main.way（它只作为入口）' }); continue; }
      visit(inc.name, chain.concat([name]));
    }
    order.push(name);
  };
  visit(entry, []);
  // 没被引用到的文件：照样参与链接（用户可能在文件列表里建了但还没引用），但要给一条提示级错误
  for (const name of Object.keys(parsed)) if (!seen[name]) errors.push({ file: name, line: 1, msg: '这个文件没有被 main.way 引用到（#引用 "' + name + '"），里面的函数不会被加载', level: 'warn' });

  const active = order.slice();      // 依赖在前
  const realErrors = errors.filter((e) => e.level !== 'warn');

  // ③ 收函数表
  const funcs = new Map();
  const declOnly = new Map();
  for (const name of active) {
    const p = parsed[name];
    if (!p) continue;
    for (const f of p.funcs) {
      const sig = (f.params || []).length;
      if (f.defined) {
        if (funcs.has(f.name)) {
          const prev = funcs.get(f.name);
          errors.push({ file: f.file, line: f.line, msg: '函数「' + f.name + '」重复定义（另一个在 ' + prev.file + ' 第 ' + prev.line + ' 行）' });
          continue;
        }
        if (declOnly.has(f.name) && declOnly.get(f.name).arity !== sig) {
          errors.push({ file: f.file, line: f.line, msg: '函数「' + f.name + '」的定义和声明参数个数不一样（声明 ' + declOnly.get(f.name).arity + ' 个，定义 ' + sig + ' 个）' });
        }
        funcs.set(f.name, { name: f.name, params: (f.params || []).map((x) => x.name), sig: (f.params || []).map((x) => typeLabel(x.type)), arity: sig, body: f.body, file: f.file, line: f.line, retType: typeLabel(f.retType) });
      } else {
        // 原型声明：**不能覆盖已经拿到函数体的那个**（常见形态：main.way 里声明 + 工具.way 里定义）
        const prev = funcs.get(f.name);
        if (prev && prev.body) {
          if (prev.arity !== sig) errors.push({ file: f.file, line: f.line, msg: '函数「' + f.name + '」的声明和定义参数个数不一样（声明 ' + sig + ' 个，定义 ' + prev.arity + ' 个）' });
          continue;
        }
        if (prev && prev.arity !== sig) errors.push({ file: f.file, line: f.line, msg: '函数「' + f.name + '」声明了两次，参数个数还不一样' });
        declOnly.set(f.name, { arity: sig, file: f.file, line: f.line, params: f.params });
        funcs.set(f.name, { name: f.name, params: (f.params || []).map((x) => x.name), arity: sig, body: null, file: f.file, line: f.line, retType: f.retType, declared: true });
      }
    }
  }
  // 只声明没定义
  funcs.forEach((v) => {
    if (v.declared && !(v.body)) {
      errors.push({ file: v.file, line: v.line, msg: '函数「' + v.name + '」只声明了没定义 —— 声明过的函数必须写函数体（' + v.retType + ' ' + v.name + '(...) { ... }）' });
    }
  });
  if (!funcs.has('main')) errors.push({ file: entry, line: 1, msg: '缺少主函数：int main() { ... }（它是这个自定义功能的接口）' });
  else if (funcs.get('main').arity > 0) errors.push({ file: funcs.get('main').file, line: funcs.get('main').line, msg: '主函数 main 不能带参数（要拿输入就用 参数.1 / 参数(1)）' });

  // ④ 每个文件能"看到"的函数：本文件的全部 + 它引用到的文件的全部（先声明后使用由 #引用 保证）
  const visibleOf = (name) => {
    const set = new Set();
    const seenW = new Set();                    // 环检测：#引用 成环时不能无限递归（踩过一次 → RangeError）
    const walk = (n) => {
      if (seenW.has(n)) return;
      seenW.add(n);
      const p = parsed[n];
      if (!p) return;
      for (const f of p.funcs) set.add(f.name);
      for (const inc of p.includes) walk(inc.name);
    };
    walk(name);
    return set;
  };
  // 「工程里到底有没有这个函数」——用来把"忘了 #引用"和"名字写错了"分开说
  const anywhere = new Map();
  for (const name of Object.keys(parsed)) {
    for (const f of (parsed[name].funcs || [])) if (!anywhere.has(f.name)) anywhere.set(f.name, name);
  }
  // ⑤ 展开语句 + 查"没声明的调用"
  const lowered = {};
  for (const name of active) {
    const p = parsed[name];
    if (!p) continue;
    const called = [];
    const lb = lowerBody((p.funcs.find((f) => f.defined) ? [] : []), name, called);   // 占位（真正的展开在下面）
    void lb;
    const vis = visibleOf(name);
    const bodies = [];
    for (const f of p.funcs) {
      if (!f.defined) continue;
      const called2 = [];
      const r = lowerBody(f.body, name, called2);
      if (!r.ok) { errors.push({ file: r.file, line: r.line, msg: r.why }); continue; }
      f.lowered = r.list;
      bodies.push(f);
      const exprCalls = [];
      collectExprCalls(r.list, exprCalls);
      for (const c of called2.concat(exprCalls.map((x) => ({ name: x.name, line: f.line, file: name, argc: x.argc })))) {
        if (funcs.has(c.name)) {
          const target = funcs.get(c.name);
          if (!vis.has(c.name) && target.file !== name) {
            errors.push({ file: name, line: c.line, msg: '「' + c.name + '」定义在 ' + target.file + '，这个文件没有 #引用 "' + target.file + '" —— 跨文件调用要先引用并声明：' + target.retType + ' ' + c.name + '(...);' });
          } else if (c.argc != null && target.arity !== c.argc) {
            errors.push({ file: name, line: c.line, msg: '函数「' + c.name + '」要 ' + target.arity + ' 个参数（' + (target.params || []).join('、') + '），这里给了 ' + c.argc + ' 个' });
          }
        } else if (anywhere.has(c.name)) {
          const home = anywhere.get(c.name);
          errors.push({ file: name, line: c.line, msg: '「' + c.name + '」定义在 ' + home + '，但这个文件没有 #引用 "' + home + '" —— 先在文件开头写 #引用 "' + home + '"，再补一句声明：' });
        } else {
          errors.push({ file: name, line: c.line, msg: '调用了不存在的函数「' + c.name + '」—— 跨文件调用要先声明：int ' + c.name + '(...); 然后写函数体' });
        }
      }
    }
    lowered[name] = bodies;
  }
  const fatal = errors.filter((e) => e.level !== 'warn');
  if (fatal.length) return { ok: false, errors, program: null };

  // ⑥ 发射 superCode program
  const fnNodes = [];
  const globals = [];
  for (const name of active) {
    const p = parsed[name];
    for (const g of p.globals) globals.push(g);
    for (const f of (lowered[name] || [])) {
      // 注意：params 必须是【名字字符串数组】—— 运行时就是按名字往函数帧里绑值的。
      // （早期写成把 {type,name,line} 对象数组发出去，绑出来是 [object Object]，参数全变 0 —— 已修）
      fnNodes.push({ k: 'fn', name: f.name, params: (f.params || []).map((x) => x.name), sig: (f.params || []).map((x) => typeLabel(x.type)), body: f.lowered, file: f.file, line: f.line, retType: typeLabel(f.retType) });
    }
  }
  const mainFn = fnNodes.find((f) => f.name === 'main');
  return {
    ok: true,
    errors,
    files: active,
    funcs: fnNodes.map((f) => ({ name: f.name, params: f.params.slice(), sig: (f.sig || []).slice(), retType: f.retType, file: f.file, line: f.line })),
    program: { k: 'program', funcs: fnNodes, globals, main: mainFn ? mainFn.body : [] },
  };
}

/* =====================================================================
 * 5. 兼容：旧版 DSL 单文件代码 → .way（main 函数 + 大括号）
 *    规则很土但很稳：关键字那一层逐行改写，其余原样。
 * ===================================================================== */
function dslToWay(src, opts) {
  const o = opts || {};
  const lines = String(src == null ? '' : src).split(/\r?\n/);
  const out = [];
  const ind = (n) => '    '.repeat(n);
  let depth = 0;
  const body = [];
  for (const raw of lines) {
    const line = String(raw);
    const t = line.trim();
    const pad = /^[ \t]*/.exec(line)[0];
    if (!t) { body.push(''); continue; }
    if (t.charAt(0) === '#') { body.push(ind(depth) + t); continue; }
    // 结束标记
    if (/^(结束如果|结束循环|结束遍历|结束尝试)$/.test(t)) {
      depth = Math.max(0, depth - 1);
      body.push(ind(depth) + '}');
      continue;
    }
    if (/^(否则|捕获)$/.test(t) || /^否则如果(\s|$|（|\()/.test(t)) {
      const keep = Math.max(0, depth - 1);
      let head;
      if (t === '捕获') head = '捕获 (错误信息) {';
      else if (t === '否则') head = '否则 {';
      else head = '否则如果 (' + t.slice('否则如果'.length).trim() + ') {';
      body.push(ind(keep) + '} ' + head);
      depth = keep + 1;
      continue;
    }
    if (/^如果(\s|$|（|\()/.test(t)) {
      body.push(ind(depth) + '如果 (' + stripParens(t.slice(2).trim()) + ') {');
      depth++;
      continue;
    }
    if (/^尝试$/.test(t)) { body.push(ind(depth) + '尝试 {'); depth++; continue; }
    const mL = /^循环\s+(.+?)(\s*次)?$/.exec(t);
    if (mL) { body.push(ind(depth) + '循环 (' + mL[1].trim() + ') {'); depth++; continue; }
    const mE = /^遍历\s+(\S+)\s+在\s+(.+)$/.exec(t);
    if (mE) { body.push(ind(depth) + '遍历 (' + mE[1] + ' 在 ' + mE[2] + ') {'); depth++; continue; }
    // 普通语句：老式空格写法改成显式括号写法（参数分离必须明确），再补分号
    var stmt = explicitifyDslLine(t);
    body.push(ind(depth) + stmt + (/[;{}]$/.test(stmt) ? '' : ';'));
    void pad;
  }
  const head = [];
  head.push('// ' + (o.title || '由旧版单文件代码自动搬进来的 .way 工程（原样保留，可直接跑）'));
  if (o.keepRaw) {
    head.push('/* ---- 原 DSL 原文 ----');
    String(src == null ? '' : src).split(/\r?\n/).forEach((l) => head.push('   ' + l));
    head.push('   ---- 原文结束 ---- */');
  }
  return head.join('\n') + '\n\nint main() {\n' + body.map((l) => (l ? '    ' + l.replace(/^ {4}/, '') : '')).join('\n') + '\n}\n';
}
/** 老 DSL 的空格写法 → 显式括号写法（与编辑器 LogicEditorScript.cs 的 explicitifyLine 同一套规则） */
function explicitifyDslLine(line) {
  const src = String(line == null ? '' : line);
  const pad = /^[ \t]*/.exec(src)[0];
  const t = src.trim();
  if (!t || t.charAt(0) === '#') return src;
  let st = null;
  try { st = superCode.matchLine(t); } catch (e) { return src; }
  if (!st || st.k !== 'stmt') return src;                 // 只处理平铺语句（分支/循环走结构转换）
  if (t.indexOf(st.kw + '(') === 0) return src;           // 已经是显式写法
  if (st.type === 'assign') return src;                   // 赋值不是"参数"
  const spec = S_BY_KW[st.kw];
  if (!spec) return src;
  const args = spec.p.map((x) => {
    const v = (st.params && st.params[x.k] != null) ? String(st.params[x.k]) : '';
    return v === '' ? EMPTY_ARG : v;
  });
  return pad + st.kw + '(' + args.join(', ') + ')';
}
function stripParens(s) {
  let t = String(s || '').trim();
  if (t.charAt(0) === '(' && t.charAt(t.length - 1) === ')') t = t.slice(1, -1);
  return t.trim();
}

module.exports = {
  tokenize,
  parseFile: (src, name) => new Parser(src, name).parseFile(),
  compileProject,
  dslToWay,
  splitTopRaw,
  TYPE_WORDS,
  TYPE_ALIASES,
  typeLabel,
  typePairs,
  VERSION: 'way-1.1',
};
