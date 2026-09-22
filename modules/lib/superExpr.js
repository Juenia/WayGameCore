/**
 * 超级自定义模块 · 表达式引擎 v2（无 eval 递归下降，2026-09-15 S2）
 * 相对 v1：
 *   - + 运算：任一侧为字符串则【拼接】，两侧都是数字才做加法（修 P1-9）
 *   - 数组字面量 [a,b] / 字典字面量 {"键":值}；空 [] 合法（修 P1-12 前身）
 *   - 真/假/空 字面量
 *   - 长度()：字符串=字符数，数组/对象=元素个数
 *   - 出错带行/列号与 E_EXPR 错误码（修 P1-11 前身）
 *   - 新增函数：替换/大写/小写/查找/取整/取余/绝对值/最大/最小/四舍五入/补零
 */
'use strict';

function exprError(msg, col) {
  const e = new Error(msg);
  e.code = 'E_EXPR';
  if (col != null) e.col = col;
  return e;
}

function createEvaluator(deps) {
  const { getVar, call } = deps;
  // 2026-09-18：需要上下文的取值函数由调用方注入（块模式也能用「查询()/查玩家()/玩家()」这类写法）。
  // 签名 (args, ctx) → 值；纯函数一律进 FUNCS，这里只放碰玩家/数据库的那几个。
  const extraFuncs = deps.extraFuncs || {};
  // extraFactory(name, ctx)：给"运行时才知道有哪些函数"的场合用（.way 工程的用户函数表），
  // 返回函数就调用、返回空就继续走"不认识"的报错 —— 不会把未知名字吞掉。
  const extraFactory = deps.extraFactory || null;

  const FUNCS = {
    '拼接': (...a) => a.map((x) => (x == null ? '' : String(x))).join(''),
    '包含': (s, sub) => String(s == null ? '' : s).includes(String(sub == null ? '' : sub)),
    '分割': (s, d) => String(s == null ? '' : s).split(String(d)),
    '长度': (v) => {
      if (Array.isArray(v)) return v.length;
      if (v != null && typeof v === 'object') return Object.keys(v).length;
      return String(v == null ? '' : v).length;
    },
    '数字': (v) => { const n = Number(v); return isNaN(n) ? 0 : n; },
    '字符串': (v) => (v == null ? '' : String(v)),
    '去首尾空格': (v) => String(v == null ? '' : v).trim(),
    '取左边': (v, n) => String(v == null ? '' : v).slice(0, Number(n) || 0),
    '取右边': (v, n) => { const s = String(v == null ? '' : v); const c = Number(n) || 0; return c <= 0 ? '' : s.slice(-c); },
    '替换': (s, from, to) => String(s == null ? '' : s).split(String(from)).join(String(to == null ? '' : to)),
    '大写': (v) => String(v == null ? '' : v).toUpperCase(),
    '小写': (v) => String(v == null ? '' : v).toLowerCase(),
    '查找': (s, sub) => String(s == null ? '' : s).indexOf(String(sub == null ? '' : sub)),
    '取整': (v) => Math.trunc(Number(v) || 0),
    '取余': (a, b) => (Number(a) || 0) % (Number(b) || 1),
    '绝对值': (v) => Math.abs(Number(v) || 0),
    '最大': (...a) => Math.max(...a.map((x) => Number(x) || 0)),
    '最小': (...a) => Math.min(...a.map((x) => Number(x) || 0)),
    '四舍五入': (v, n) => { const p = Math.pow(10, Number(n) || 0); return Math.round((Number(v) || 0) * p) / p; },
    '补零': (v, len) => { let s = String(v == null ? '' : v); const L = Number(len) || 0; while (s.length < L) s = '0' + s; return s; },
  };

  // ======================================================================
  // 2026-09-18：函数库扩充（主人反馈「代码支持的函数太少，支持库更少」）
  // 全部是纯函数：不碰数据库、不碰上下文 —— 块视图的表达式和代码模式共用同一份。
  // ======================================================================
  Object.assign(FUNCS, {
    // ---- 文本 ----
    '取中间': (s, a, n) => { const t = String(s == null ? '' : s); const i = Math.max(0, (Number(a) || 1) - 1); return t.slice(i, i + Math.max(0, Number(n) || 0)); },
    '反转': (s) => String(s == null ? '' : s).split('').reverse().join(''),
    '重复': (s, n) => { const t = String(s == null ? '' : s); const c = Math.max(0, Math.floor(Number(n) || 0)); return c > 10000 ? '' : t.repeat(c); },
    '替换首个': (s, from, to) => String(s == null ? '' : s).replace(String(from == null ? '' : from), String(to == null ? '' : to)),
    '去空白': (s) => String(s == null ? '' : s).replace(/\s+/g, ''),
    '去左空': (s) => String(s == null ? '' : s).replace(/^\s+/, ''),
    '去右空': (s) => String(s == null ? '' : s).replace(/\s+$/, ''),
    '以开头': (s, p) => String(s == null ? '' : s).startsWith(String(p == null ? '' : p)),
    '以结尾': (s, p) => String(s == null ? '' : s).endsWith(String(p == null ? '' : p)),
    '计数': (s, sub) => { const t = String(s == null ? '' : s), k = String(sub == null ? '' : sub); if (!k) return 0; return t.split(k).length - 1; },
    '分割取': (s, sep, i) => { const a = String(s == null ? '' : s).split(String(sep == null ? '' : sep)); const n = Number(i) || 1; return n > 0 ? (a[n - 1] == null ? '' : a[n - 1]) : (a[a.length + n] == null ? '' : a[a.length + n]); },
    '填充': (s, len, ch) => { let t = String(s == null ? '' : s); const L = Math.max(0, Number(len) || 0), c = String(ch == null || ch === '' ? ' ' : ch).charAt(0); while (t.length < L) t = c + t; return t; },
    '千分位': (v) => { const n = Number(v) || 0; const neg = n < 0; const parts = Math.abs(n).toString().split('.'); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (neg ? '-' : '') + parts.join('.'); },
    '文本': (v) => (v == null ? '' : String(v)),
    'JSON文本': (v) => { try { return JSON.stringify(v == null ? null : v); } catch (e) { return ''; } },
    '解析JSON': (s) => { try { const v = JSON.parse(String(s == null ? '' : s)); return v; } catch (e) { return null; } },
    'URL编码': (s) => encodeURIComponent(String(s == null ? '' : s)),
    'URL解码': (s) => { try { return decodeURIComponent(String(s == null ? '' : s)); } catch (e) { return String(s == null ? '' : s); } },
    // ---- 正则 ----
    '正则匹配': (s, p) => { try { return new RegExp(String(p)).test(String(s == null ? '' : s)); } catch (e) { return false; } },
    '正则查找': (s, p) => { try { const m = String(s == null ? '' : s).match(new RegExp(String(p))); return m ? (m[1] != null ? m[1] : m[0]) : ''; } catch (e) { return ''; } },
    '正则替换': (s, p, to) => { try { return String(s == null ? '' : s).replace(new RegExp(String(p), 'g'), String(to == null ? '' : to)); } catch (e) { return String(s == null ? '' : s); } },
    '正则分割': (s, p) => { try { return String(s == null ? '' : s).split(new RegExp(String(p))); } catch (e) { return [String(s == null ? '' : s)]; } },
    // ---- 列表 ----
    '列表': (...a) => a,
    '范围': (a, b) => { const from = Math.floor(Number(a) || 0), to = Math.floor(Number(b) || 0); const out = []; const step = from <= to ? 1 : -1; for (let x = from; step > 0 ? x <= to : x >= to; x += step) { out.push(x); if (out.length > 10000) break; } return out; },
    '连接': (list, sep) => (Array.isArray(list) ? list : [list]).map((x) => (x == null ? '' : String(x))).join(sep == null ? '' : String(sep)),
    '排序': (list, desc) => { const a = (Array.isArray(list) ? list.slice() : []); a.sort((x, y) => { const nx = Number(x), ny = Number(y); const bothNum = !isNaN(nx) && !isNaN(ny) && String(x).trim() !== '' && String(y).trim() !== ''; if (bothNum) return nx - ny; return String(x) < String(y) ? -1 : (String(x) > String(y) ? 1 : 0); }); if (desc) a.reverse(); return a; },
    '去重': (list) => { const seen = {}, out = []; (Array.isArray(list) ? list : []).forEach((x) => { const k = typeof x + '|' + String(x); if (!seen[k]) { seen[k] = 1; out.push(x); } }); return out; },
    '反转列表': (list) => (Array.isArray(list) ? list.slice().reverse() : []),
    '求和': (list) => (Array.isArray(list) ? list : []).reduce((s, x) => s + (Number(x) || 0), 0),
    '平均': (list) => { const a = (Array.isArray(list) ? list : []); return a.length ? a.reduce((s, x) => s + (Number(x) || 0), 0) / a.length : 0; },
    '切片': (list, a, b) => { const t = Array.isArray(list) ? list : []; const i = Math.max(0, (Number(a) || 1) - 1); const j = b == null ? t.length : Math.max(0, Number(b)); return t.slice(i, j); },
    '取前': (list, n) => { const t = Array.isArray(list) ? list : []; const c = Math.max(0, Math.floor(Number(n) || 0)); return c ? t.slice(0, c) : t.slice(); },
    '取后': (list, n) => { const t = Array.isArray(list) ? list : []; const c = Math.max(0, Math.floor(Number(n) || 0)); return c ? t.slice(-c) : t.slice(); },
    '第几项': (list, v) => { const t = Array.isArray(list) ? list : []; for (let i = 0; i < t.length; i++) if (String(t[i]) === String(v)) return i + 1; return 0; },
    '合并': (a, b) => (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []),
    '打乱': (list) => { const t = (Array.isArray(list) ? list.slice() : []); for (let i = t.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = t[i]; t[i] = t[j]; t[j] = tmp; } return t; },
    '随机选': (list) => { const t = (Array.isArray(list) ? list : []); return t.length ? t[Math.floor(Math.random() * t.length)] : ''; },
    // ---- 数学 ----
    '向上取整': (v) => Math.ceil(Number(v) || 0),
    '向下取整': (v) => Math.floor(Number(v) || 0),
    '平方根': (v) => Math.sqrt(Math.max(0, Number(v) || 0)),
    '幂': (a, b) => Math.pow(Number(a) || 0, Number(b) || 0),
    '夹取': (v, lo, hi) => { const n = Number(v) || 0, a = Number(lo) || 0, b = Number(hi) || 0; return Math.min(Math.max(n, Math.min(a, b)), Math.max(a, b)); },
    '是偶数': (v) => Math.floor(Number(v) || 0) % 2 === 0,
    '随机': (a, b) => { const lo = Math.floor(Number(a) || 0), hi = Math.floor(Number(b) || 0); const mn = Math.min(lo, hi), mx = Math.max(lo, hi); return mn + Math.floor(Math.random() * (mx - mn + 1)); },
    // ---- 时间 ----
    '时间戳': () => Date.now(),
    '现在': () => new Date().toISOString(),
    '今天': () => { const d = new Date(); const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); },
    '年': () => new Date().getFullYear(),
    '月': () => new Date().getMonth() + 1,
    '日': () => new Date().getDate(),
    '时': () => new Date().getHours(),
    '分': () => new Date().getMinutes(),
    '秒': () => new Date().getSeconds(),
    '星期': () => new Date().getDay(),
    '格式化时间': (ts, fmt) => { const d = ts == null || ts === '' ? new Date() : new Date(Number(ts) || String(ts)); if (isNaN(d.getTime())) return ''; const p = (n) => (n < 10 ? '0' : '') + n; const f = String(fmt == null || fmt === '' ? 'YYYY-MM-DD HH:mm:ss' : fmt); return f.replace(/YYYY/g, d.getFullYear()).replace(/MM/g, p(d.getMonth() + 1)).replace(/DD/g, p(d.getDate())).replace(/HH/g, p(d.getHours())).replace(/mm/g, p(d.getMinutes())).replace(/ss/g, p(d.getSeconds())); },
    // ---- 类型与兜底 ----
    '是数字': (v) => v !== '' && v != null && !isNaN(Number(v)),
    '是文本': (v) => typeof v === 'string',
    '是列表': (v) => Array.isArray(v),
    '是空': (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0),
    '默认值': (v, d) => (v == null || v === '' || (Array.isArray(v) && v.length === 0)) ? d : v,
  });
  // ======================================================================
  // 2026-09-18（修「代码模式的取值函数在块模式里不存在」）：
  // 代码模式有一层取值函数（superCode.HELPER_TYPES：建列表/取第N项/文本替换…），
  // 块模式的表达式引擎原来只认下面这张 FUNCS 表 —— 于是「由代码生成块」出来的图，
  // 只要表达式里带了这些名字，跑到那一步就报「不认识」。
  // 这一批是【纯函数】（不碰玩家/数据库），直接进 FUNCS：块模式、代码模式两边同时有，
  // 语义逐条对齐 superCode.RUN 里的同名语句实现（连越界报错文案都一致）。
  // 需要上下文的那些（查询/查玩家/玩家()/参数()/检查物品）走 deps.extraFuncs，由调用方注入。
  // ======================================================================
  Object.assign(FUNCS, {
    '建列表': (...a) => (a.length === 1 && Array.isArray(a[0]) ? a[0] : a.slice()),
    '列表追加': (l, v) => (Array.isArray(l) ? l.slice() : []).concat([v == null ? '' : String(v)]),
    '列表长度': (l) => (Array.isArray(l) ? l : []).length,
    '列表包含': (l, v) => (Array.isArray(l) ? l : []).indexOf(v == null ? '' : String(v)) >= 0,
    '取第N项': (l, i) => {
      const a = Array.isArray(l) ? l : [];
      const want = Math.floor(Number(i) || 1);
      const k = Math.max(0, want - 1);
      if (k >= a.length) throw new Error('列表只有 ' + a.length + ' 项，取不到第 ' + want + ' 项（「取第N项」的索引从 1 起）');
      return a[k];
    },
    '数字序列': (from, to) => {
      const a = Math.floor(Number(from) || 1); const b = Math.floor(Number(to) || 5);
      const span = Math.abs(b - a) + 1;
      if (span > 10000) throw new Error('数字序列太长：' + a + '→' + b + ' 一共 ' + span + ' 项，最多 10000 项 —— 缩小范围，或改用「循环 次数」');
      const out = []; const step = a <= b ? 1 : -1;
      for (let x = a; step > 0 ? x <= b : x >= b; x += step) out.push(x);
      return out;
    },
    '拼接文本': (a, b) => String(a == null ? '' : a) + String(b == null ? '' : b),
    '文本替换': (t, from, to) => { const s = String(t == null ? '' : t); const f0 = String(from == null ? '' : from); return f0 === '' ? s : s.split(f0).join(String(to == null ? '' : to)); },
    '文本截取': (t, start, count) => { const s = String(t == null ? '' : t); const i = Math.max(0, Math.floor(Number(start) || 1) - 1); const n = Math.max(0, Math.floor(Number(count) || 1)); return s.slice(i, i + n); },
    '大小写': (t, mode) => { const s = String(t == null ? '' : t); return String(mode == null ? '' : mode).trim() === '小写' ? s.toLowerCase() : s.toUpperCase(); },
    '查找位置': (t, sub) => String(t == null ? '' : t).indexOf(String(sub == null ? '' : sub)),
    '随机数': (a, b) => { const x = Math.floor(Number(a) || 0); const y = Math.floor(Number(b) || 0); return x + Math.floor(Math.random() * Math.max(1, y - x + 1)); },
    '数字运算': (a, op, b) => {
      const x = Number(a) || 0; const y = Number(b) || 0; const o = String(op == null ? '+' : op).trim();
      if (o === '+') return x + y;
      if (o === '-') return x - y;
      if (o === '*') return x * y;
      if (o === '/') { if (y === 0) throw new Error('除数不能是 0'); return x / y; }
      if (o === '%') { if (y === 0) throw new Error('取余的除数不能是 0'); return x % y; }
      throw new Error('「数字运算」的运算符只认 + - * / %，写的是「' + o + '」');
    },
    '数字比较': (a, op, b) => {
      const o = String(op == null ? '>=' : op).trim();
      if (o === '>=') return a >= b; if (o === '>') return a > b;
      if (o === '<=') return a <= b; if (o === '<') return a < b;
      if (o === '!=') return a != b;
      return a == b;
    },
  });
  // 预处理：{变量:名} {随机:a,b} {调用:key,a,b} → 函数调用形式
  function preprocess(src) {
    return String(src).replace(/\{([^{}]+)\}/g, (m, inner) => {
      const [head, ...rest] = inner.split(':');
      const name = head.trim();
      if (name === '变量') return '__var(' + rest.join(':').trim() + ')';
      if (name === '随机') return '__rand(' + rest.join(':') + ')';
      if (name === '调用') return '__call(' + rest.join(':') + ')';
      return m;
    });
  }

  function tokenize(src) {
    const s = preprocess(src);
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      const col = i + 1;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '"' || c === "'") {
        const q = c; let j = i + 1; let out = '';
        while (j < s.length && s[j] !== q) { out += s[j]; j++; }
        tokens.push({ t: 'str', v: out, col }); i = j + 1; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
        tokens.push({ t: 'num', v: parseFloat(s.slice(i, j)), col }); i = j; continue;
      }
      const two = s.substr(i, 2);
      if (['>=', '<=', '==', '!='].includes(two)) { tokens.push({ t: 'op', v: two, col }); i += 2; continue; }
      if ('+-*/%()=,><[]{}:'.includes(c)) { tokens.push({ t: 'op', v: c, col }); i++; continue; }
      let j = i;
      while (j < s.length && !' \t\n\r+-*/%()=,><"\'{}[]:'.includes(s[j])) j++;
      tokens.push({ t: 'id', v: s.slice(i, j), col }); i = j;
    }
    return tokens;
  }

  class Parser {
    constructor(tokens, ctx) { this.toks = tokens; this.pos = 0; this.ctx = ctx; }
    peek() { return this.toks[this.pos]; }
    next() { return this.toks[this.pos++]; }
    fail(msg, tk) { throw exprError(msg + (tk ? '（第 ' + tk.col + ' 列）' : ''), tk && tk.col); }

    async parseOr() { let l = await this.parseAnd(); while (this.peek() && this.peek().t === 'id' && this.peek().v === '或') { this.next(); l = l || (await this.parseAnd()); } return l; }
    async parseAnd() { let l = await this.parseCmp(); while (this.peek() && this.peek().t === 'id' && this.peek().v === '且') { this.next(); l = l && (await this.parseCmp()); } return l; }
    async parseCmp() {
      let l = await this.parseAdd();
      while (this.peek() && this.peek().t === 'op' && ['>=', '<=', '==', '!=', '>', '<', '='].includes(this.peek().v)) {
        const op = this.next().v; const r = await this.parseAdd();
        if (op === '>=') l = l >= r; else if (op === '<=') l = l <= r;
        else if (op === '==' || op === '=') l = l == r; else if (op === '!=') l = l != r;
        else if (op === '>') l = l > r; else if (op === '<') l = l < r;
      }
      return l;
    }
    async parseAdd() {
      let l = await this.parseMul();
      while (this.peek() && this.peek().t === 'op' && (this.peek().v === '+' || this.peek().v === '-')) {
        const op = this.next().v; const r = await this.parseMul();
        if (op === '+') l = (typeof l === 'string' || typeof r === 'string') ? (l == null ? '' : String(l)) + (r == null ? '' : String(r)) : (Number(l) + Number(r));
        else l = Number(l) - Number(r);
      }
      return l;
    }
    async parseMul() {
      let l = await this.parseUnary();
      while (this.peek() && this.peek().t === 'op' && (this.peek().v === '*' || this.peek().v === '/' || this.peek().v === '%')) {
        const op = this.next().v; const r = await this.parseUnary();
        if (op === '*') l = Number(l) * Number(r); else if (op === '/') l = Number(l) / Number(r); else l = Number(l) % Number(r);
      }
      return l;
    }
    async parseUnary() {
      if (this.peek() && this.peek().t === 'id' && this.peek().v === '非') { this.next(); return !(await this.parseUnary()); }
      if (this.peek() && this.peek().t === 'op' && this.peek().v === '-') { this.next(); return -Number(await this.parseUnary()); }
      return await this.parsePrimary();
    }
    async parsePrimary() {
      const tk = this.next();
      // 2026-09-18：以前返回 undefined → 上层算出 NaN 却不报错（"1 +" 就是这样）。
      // 表达式在这里断掉了必须说清楚。
      if (!tk) this.fail('表达式没写完：运算符或逗号后面缺内容');
      if (!tk) return undefined;
      if (tk.t === 'num') return tk.v;
      if (tk.t === 'str') return tk.v;
      if (tk.t === 'id') {
        if (tk.v === '真') return true;
        if (tk.v === '假') return false;
        if (tk.v === '空') return null;
        if (this.peek() && this.peek().t === 'op' && this.peek().v === '(') {
          this.next();
          const args = [];
          if (!(this.peek() && this.peek().t === 'op' && this.peek().v === ')')) {
            while (true) {
              args.push(await this.parseOr());
              if (this.peek() && this.peek().t === 'op' && this.peek().v === ',') { this.next(); continue; }
              break;
            }
          }
          if (this.peek() && this.peek().t === 'op' && this.peek().v === ')') this.next();
          // 2026-09-18：函数调用的收尾括号以前是「有就吃、没有就算了」→ 少写一个右括号会被静默吞掉，
          // 用户看到的是「居然跑通了」，实际参数边界是错的。这里必须报错（分组括号那条本来就有 fail）。
          else this.fail('函数「' + tk.v + '」的括号没闭合：少了一个「)」', tk);
          return await this.callFn(tk.v, args, tk);
        }
        return await this.resolvePath(tk.v, tk);
      }
      if (tk.t === 'op' && tk.v === '(') {
        const v = await this.parseOr();
        if (this.peek() && this.peek().t === 'op' && this.peek().v === ')') this.next();
        else this.fail('括号没闭合：少了一个「)」', tk);   // 2026-09-18：以前直接吞掉
        return v;
      }
      if (tk.t === 'op' && tk.v === '[') {
        const arr = [];
        if (!(this.peek() && this.peek().t === 'op' && this.peek().v === ']')) {
          while (true) {
            arr.push(await this.parseOr());
            if (this.peek() && this.peek().t === 'op' && this.peek().v === ',') { this.next(); continue; }
            break;
          }
        }
        if (this.peek() && this.peek().t === 'op' && this.peek().v === ']') this.next();
        else this.fail('列表没闭合：少了一个「]」', tk);
        return arr;
      }
      if (tk.t === 'op' && tk.v === '{') {
        const obj = {};
        if (!(this.peek() && this.peek().t === 'op' && this.peek().v === '}')) {
          while (true) {
            const kt = this.next();
            let k = (kt.t === 'str') ? kt.v : String(kt.v != null ? kt.v : '');
            if (this.peek() && this.peek().t === 'op' && this.peek().v === ':') this.next();
            obj[k] = await this.parseOr();
            if (this.peek() && this.peek().t === 'op' && this.peek().v === ',') { this.next(); continue; }
            break;
          }
        }
        if (this.peek() && this.peek().t === 'op' && this.peek().v === '}') this.next();
        else this.fail('对象没闭合：少了一个「}」', tk);
        return obj;
      }
      // 2026-09-18：剩下的记号（多出来的 ) = , 等）以前一律 return undefined 静默吃掉
      this.fail('这里读不懂：「' + String(tk.v) + '」—— 检查括号/逗号/等号有没有多写', tk);
      return undefined;
    }
    async callFn(name, args, tk) {
      if (FUNCS[name]) return FUNCS[name](...args);
      if (extraFuncs[name]) return await extraFuncs[name](args, this.ctx);
      if (extraFactory) {
        const f = extraFactory(name, this.ctx);
        if (f) return await f(args, this.ctx);
      }
      if (name === '__rand') { const a = Math.floor(Number(args[0]) || 0); const b = Math.floor(Number(args[1]) || 0); return a + Math.floor(Math.random() * Math.max(1, b - a + 1)); }
      if (name === '__var') { const v = await getVar(String(args[0]), this.ctx); return v; }
      if (name === '__call') {
        const key = String(args[0]); const rest = args.slice(1).map((x) => (x == null ? '' : String(x)));
        const out = await call(key, rest, this.ctx);
        if (out && !out.ok) throw new Error('调用 ' + key + ' 失败: ' + (out.error || ''));
        return out ? out.text : undefined;
      }
      // 2026-09-18：可用函数清单由函数表动态生成（以前是手写死的一串，加了新函数就漏报）
      const names = Object.keys(FUNCS).concat(Object.keys(extraFuncs))
        .concat((deps.listExtra && deps.listExtra(this.ctx)) || []).filter((k) => k.indexOf('__') !== 0);
      this.fail('不认识「' + name + '」（可用函数 ' + names.length + ' 个：' + names.join('/') + '）', tk);
    }
    async resolvePath(name, tk) {
      const parts = name.split('.');
      const head = parts[0];
      if (head === '玩家') { const p = this.ctx.player || {}; return parts.slice(1).reduce((o, k) => (o == null ? undefined : o[k]), p); }
      if (head === '参数') {
        if (parts.length === 1) return this.ctx.args || [];
        return parts.slice(1).reduce((o, k) => (o == null ? undefined : o[k]), this.ctx.argsObj || {});
      }
      if (head === '变量') { return parts.slice(1).reduce((o, k) => (o == null ? undefined : o[k]), this.ctx.vars || {}); }
      if (head === '节点') { return parts.slice(1).reduce((o, k) => (o == null ? undefined : o[k]), this.ctx.nodeOut || {}); }
      if (head === '系统') { const nm = parts.slice(1).join('.'); return await getVar(nm, this.ctx); }
      if (this.ctx.vars && this.ctx.vars[head] !== undefined) return this.ctx.vars[head];
      const v = await getVar(head, this.ctx);
      return v === undefined ? null : v;
    }
  }

  return {
    funcNames: () => Object.keys(FUNCS).filter((k) => k.indexOf('__') !== 0),
    async eval(expr, ctx) {
      if (expr === undefined || expr === null || expr === '') return null;
      if (typeof expr !== 'string') return expr;
      const tokens = tokenize(expr);
      if (tokens.length === 0) return null;
      const p = new Parser(tokens, ctx);
      let v = await p.parseOr();
      // 2026-09-18：顶层的逗号当【列表字面量】。例：call 块的「参数(逗号分隔)」写 甲,乙:
      // 以前解析器只认第一个、后面的静默丢掉（或被新版报错拦下），现在得到 ['甲','乙']。
      // 函数调用/数组字面量/对象字面量里的逗号在各自的括号层级里已被吃掉，不受影响。
      if (p.peek() && p.peek().t === 'op' && p.peek().v === ',') {
        const arr = [v];
        while (p.peek() && p.peek().t === 'op' && p.peek().v === ',') { p.next(); arr.push(await p.parseOr()); }
        v = arr;
      }
      // 2026-09-18：表达式没写完 / 多了东西，以前是静默吞掉（"1 +" 直接算出 NaN），
      // 用户只看到结果不对、找不到原因。现在从第一个读不下去的记号开始给人话报错。
      // 允许尾巴上多写分号（老逻辑里有人这么写，不算错）。
      while (p.peek() && p.peek().t === 'id' && (p.peek().v === ';' || p.peek().v === '；')) p.next();
      const left = p.peek();
      if (left) {
        p.fail('表达式没写完或多了东西：读不下去了 → 从「' + String(left.v) + '」开始的多余内容（检查括号/运算符有没有配对）', left);
      }
      if (typeof v === 'number' && isNaN(v)) {
        return v;   // 数学上本来就是 NaN（如 数字("abc")）保持原样，交给上层判断
      }
      return v === undefined ? null : v;
    },
  };
}

function listFuncs() {
  return createEvaluator({ getVar: () => undefined, call: () => ({}) }).funcNames();
}
module.exports = { createEvaluator, exprError, listFuncs };
