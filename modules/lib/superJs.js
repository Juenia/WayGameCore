/**
 * 超级自定义模块 · JS 通道（2026-09-19 · 作者面 v2 的 R4 / R6）
 * =====================================================================
 * 主人原话（R4/R6）：
 *   · 功能文件夹里除了 .dsl（中文入口 main.dsl），还能放 .js 文件；
 *   · 功能自己的 .js 只有这个功能能调；全局 JS 任何功能都能调；
 *   · 全局 JS 必须在文件头写声明才对外可见：
 *       // @全局 对外开放
 *       // @导出 发奖(玩家, 金币)
 *   · 执行要有隔离（无 fs / 无网络 / 超时），错误要说人话。
 *
 * 写法：DSL 里「调用 js:文件名.函数名(参数…)」；全局的写「调用 js:全局/文件名.函数名(参数…)」。
 *      这条 key 仍走语句表的「调用」语句（key 以 js: 开头就转进来），
 *      所以语句表 / 块 / 契约（K2、K9）一个字都不用动。
 *
 * 本层的边界（重要，别越界）：
 *   · **不碰 core、不碰数据库**：所有副作用能力由调用方（superCode）以 caps 对象注入，
 *     于是不变量 I2「一切副作用只经白名单能力」没有被撕开一个口子 —— JS 能做的事，
 *     正好等于作者在中文 DSL 里能做的事，一件不多。
 *   · 沙箱用 Node 的 vm 且 codeGeneration.strings=false：沙箱里没有 require / process /
 *     Function / eval，读不了文件、连不了网、也造不出新函数绕出去。
 *   · 同步死循环由 vm 的 timeout 拦住；await 之后挂起由外层 deadline 拦住 —— 两个都要（见 §5）。
 *
 * 已知限制（v1，如实写在报告里）：
 *   · 能力面目前只开「消息 / 货币 / 物品 / 查询 / 日志 + 读玩家」，变量与状态那几条留到下一片；
 *   · JS 文件是同步作用域内的一段脚本：它只能「被调用」，不能自己挂触发器（触发方式仍由中文功能决定）。
 */
'use strict';

const vm = require('vm');
const E = require('./superErrors');

/** 全局 JS 的存放桶：custom_logic_file 里 logic_key = '@全局' 的那些文件 */
const GLOBAL_BUCKET = '@全局';
const JS_FILE_RE = /\.js$/i;

/* =====================================================================
 * 1. 声明解析（纯函数，可单独测）
 * ===================================================================== */

/**
 * 读文件头声明。规矩（与建档文档一致）：
 *   // @全局 对外开放       ← 只有写了这一行，这个文件的导出才允许被【别的功能】调用
 *   // @导出 发奖(玩家, 金币)  ← 每个对外可见的函数一行
 * 声明只认文件开头那段连续注释：遇到第一行不是注释也不是空行就停止扫描
 * （避免把函数体里随便一句 // @导出 也当成声明）。
 */
function parseDecls(source) {
  const lines = String(source == null ? '' : source).split(/\r?\n/);
  let global = false;
  const exports = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '') continue;
    if (t.slice(0, 2) !== '//') break;
    if (/^\/\/\s*@全局\s*对外开放\s*$/.test(t)) { global = true; continue; }
    const m = /^\/\/\s*@导出\s*([^\s(（]+)\s*(?:[(（]([^)）]*)[)）])?\s*$/.exec(t);
    if (m) exports.push({ name: m[1], params: String(m[2] || '').split(',').map((s) => s.trim()).filter((s) => s !== '') });
  }
  return { global, exports };
}

/** 文件里所有顶层函数名（含 async；中文名一样认） */
function listFunctions(source) {
  const out = [];
  const re = /(?:^|\n)[ \t]*(?:async[ \t]+)?function[ \t]+([A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*)[ \t]*\(/g;
  const s = String(source == null ? '' : source);
  let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

/** 「文件.函数」→ { file, fn, global }（按最后一个点切，所以「工具.js.发奖」也认） */
function splitSpec(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  const i = raw.lastIndexOf('.');
  if (i <= 0 || i === raw.length - 1) return null;
  const filePart = raw.slice(0, i).trim();
  const fn = raw.slice(i + 1).trim();
  if (!filePart || !fn) return null;
  const globalSpec = /^(全局|@全局|@)[\/\\]/.test(filePart) || filePart.charAt(0) === '@';
  const base = filePart.replace(/^(全局|@全局|@)[\/\\]/, '').replace(/^@/, '').trim();
  return { file: JS_FILE_RE.test(base) ? base : base + '.js', fn, global: globalSpec, raw, base };
}

/* =====================================================================
 * 2. 运行时
 * ===================================================================== */
function createJsRuntime(opts) {
  const o = opts || {};
  const loadFiles = o.loadFiles || (async () => ({}));      // (logicKey) => { 文件名: 内容 }
  const log = o.log || (() => {});
  const ttlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : 2000;
  const defaultTimeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 500;
  // 绝对上限（含等待/查询这类宿主能力的时间）；不传就当 idle 的 40 倍
  const totalTimeoutMs = Number(o.totalTimeoutMs) > 0 ? Number(o.totalTimeoutMs) : defaultTimeoutMs * 40;
  const maxCalls = Number(o.maxCalls) > 0 ? Number(o.maxCalls) : 200;
  const cache = new Map();

  async function filesOf(key) {
    const k = String(key == null ? '' : key);
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < ttlMs) return hit.files;
    let files = {};
    try { files = (await loadFiles(k)) || {}; } catch (e) { files = {}; }
    cache.set(k, { files, at: Date.now() });
    return files;
  }
  /** 保存逻辑/文件之后调一次（与模块的 2 秒 TTL 口径一致，但可被显式失效） */
  function invalidate(key) { if (key) cache.delete(String(key)); else cache.clear(); }

  /** 某个功能（或全局桶）里的 JS 文件清单 */
  async function jsFilesOf(logicKey) {
    const files = await filesOf(logicKey);
    const out = {};
    for (const [n, c] of Object.entries(files)) if (JS_FILE_RE.test(n)) out[n] = c;
    return out;
  }

  /**
   * 解析「文件.函数」：找到源码，并判定它允不允许被这次调用。
   * 不对外可见一律 E_JS_DENIED（零静默：把「为什么不能用」直接说给作者）。
   */
  async function resolve(spec, logicKey) {
    const sp = splitSpec(spec);
    if (!sp) {
      return { ok: false, code: 'E_ARGS', error: '写法是「调用 js:文件名.函数名(参数…)」，你写的是「' + String(spec == null ? '' : spec) + '」' };
    }
    const bucket = sp.global ? GLOBAL_BUCKET : String(logicKey == null ? '' : logicKey);
    const files = await jsFilesOf(bucket);
    let name = null;
    if (Object.prototype.hasOwnProperty.call(files, sp.file)) name = sp.file;
    else {
      const keys = Object.keys(files).filter((n) => n.replace(JS_FILE_RE, '') === sp.base);
      if (keys.length) name = keys[0];
    }
    if (!name) {
      const have = Object.keys(files);
      const where = sp.global ? '全局 JS' : '本功能的 JS 文件';
      return {
        ok: false, code: 'E_ROW_NOT_FOUND',
        error: '找不到 ' + where + '「' + sp.file + '」' + (have.length ? ('；现在有：' + have.join('、')) : '（这个功能还没有 JS 文件）'),
      };
    }
    const source = String(files[name] == null ? '' : files[name]);
    const decls = parseDecls(source);
    const fns = listFunctions(source);
    const label = (sp.global ? '全局/' : '') + name;
    if (fns.indexOf(sp.fn) < 0) {
      return {
        ok: false, code: 'E_ROW_NOT_FOUND',
        error: '「' + name + '」里没有函数「' + sp.fn + '」' + (fns.length ? ('；这个文件里有：' + fns.join('、')) : '（一个函数都没有）'),
      };
    }
    if (sp.global) {
      // 全局 JS 的两道门：① 文件头声明对外开放 ② 该函数在 @导出 名单里
      if (!decls.global) {
        return { ok: false, code: 'E_JS_DENIED', error: '「' + name + '」没有在文件头声明「// @全局 对外开放」，所以别的功能调不到它（只能在本文件里用）' };
      }
      if (!decls.exports.some((x) => x.name === sp.fn)) {
        const names = decls.exports.map((x) => x.name);
        return {
          ok: false, code: 'E_JS_DENIED',
          error: '「' + sp.fn + '」没有写在「// @导出 ' + sp.fn + '(…)」里' + (names.length ? ('；这个文件导出了：' + names.join('、')) : '（这个文件一条 @导出 都没有）'),
        };
      }
    }
    return { ok: true, bucket, file: name, label, fn: sp.fn, source, decls, global: !!sp.global };
  }

  /** 错误工厂：一律用中央登记表的人话模板 */
  function mkErr(code, extra) { return E.make(code, E.human(code, extra), log); }

  /** 把 vm / 用户代码抛出来的异常翻成人话错误码 */
  function mapRunErr(e, r, timeoutMs) {
    const msg = String((e && e.message) || e);
    if (e && (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /Script execution timed out/i.test(msg))) {
      return mkErr('E_TIMEOUT', { ms: timeoutMs });
    }
    if (e instanceof SyntaxError || (e && e.name === 'SyntaxError')) {
      // 最常见的一条：能力调用是异步的，函数没写 async 就用 await —— 补一句人话，别让作者对着引擎原文发懵
      const hint = /await is only valid/i.test(msg)
        ? '（函数要写成 async function 名字(...)：调用能力要 await，而 await 只能出现在 async 函数里）'
        : '';
      return mkErr('E_JS_SYNTAX', { file: r.label, line: (e && e.lineNumber) || '?', detail: msg + hint });
    }
    // 能力层（superOps / 沙箱护栏）抛的错自带已登记的 E_*：原样往上走，
    // 否则「能力调用超上限」会被包成 E_JS_ERROR，上层按码分支就漏判了。
    if (e && e.code && E.isKnown(e.code)) return e;
    return mkErr('E_JS_ERROR', { file: r.label, fn: r.fn, detail: msg });
  }

  /**
   * 给 async 部分加「看门狗」（vm 的 timeout 管不到 await 之后的挂起）。
   * 2026-09-19 完善：以前是「整段 500 毫秒一刀切」—— await 等待(1200) / 慢查询会被误杀。
   * 现在只算 **JS 自己占用的时间**：宿主能力在跑（busy()>0）时看门狗暂停计时；
   * 另加一条**绝对上限** totalMs，防「等 999 秒」这种把自己挂死的写法。
   */
  function withWatchdog(p, idleMs, totalMs, busy, lastAt) {
    let done = false, timer = null;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const fail = (ms) => { if (done) return; done = true; if (timer) clearInterval(timer); reject(mkErr('E_TIMEOUT', { ms })); };
      timer = setInterval(() => {
        if (done) return;
        const now = Date.now();
        if (now - started > totalMs) return fail(totalMs);
        if (busy() > 0) return;                      // 宿主能力在跑 → 这段时间不算 JS 的账
        if (now - lastAt() > idleMs) fail(idleMs);
      }, Math.max(20, Math.min(100, idleMs)));
      if (timer && typeof timer.unref === 'function') timer.unref();
      p.then((v) => { if (!done) { done = true; if (timer) clearInterval(timer); resolve(v); } },
             (e) => { if (!done) { done = true; if (timer) clearInterval(timer); reject(e); } });
    });
  }

  /**
   * 调一个 JS 导出函数。
   * @param {{spec:string,args:Array,logicKey:string,caps:Object,timeoutMs?:number}} a
   * @returns {Promise<{ok:true,value:any}>}；出错抛带 E_* 的 Error
   */
  async function call(a) {
    const arg = a || {};
    const r = await resolve(arg.spec, arg.logicKey);
    if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
    const timeoutMs = Number(arg.timeoutMs) > 0 ? Number(arg.timeoutMs) : defaultTimeoutMs;
    const args = Array.isArray(arg.args) ? arg.args : [];

    // 包装成 async 函数：源码整段放进函数体，末尾把我们传进去的参数铺开调用目标函数。
    // lineOffset:-1 让报错行号与文件里的真实行号一致（包装那行不算）。
    let script;
    try {
      script = new vm.Script(
        '(async function(){\n' + r.source + '\n;return await ' + r.fn + '(...__args);\n})()',
        { filename: r.label, lineOffset: -1 },
      );
    } catch (e) {
      throw mkErr('E_JS_SYNTAX', { file: r.label, line: (e && e.lineNumber) || '?', detail: String((e && e.message) || e) });
    }

    // 沙箱：只有白名单能力 + 参数，没有别的名字
    const sandbox = Object.create(null);
    let calls = 0, inCap = 0, lastActivity = Date.now();
    const busy = () => inCap;
    const lastAt = () => lastActivity;
    for (const [k, fn] of Object.entries(arg.caps || {})) {
      if (typeof fn !== 'function') continue;
      sandbox[k] = (...xs) => {
        calls += 1;
        if (calls > maxCalls) throw mkErr('E_STEPS', { steps: maxCalls });   // 同步抛：不 await 也照样被抓住
        inCap += 1;
        const doneCap = () => { inCap -= 1; lastActivity = Date.now(); };
        let r0;
        try { r0 = fn(...xs); } catch (e) { doneCap(); throw e; }
        // 2026-09-19 细致化：忘了 await 时，作者只会看到 [object Promise]，根本不知道错在哪。
        // 给返回的 Promise 挂一个会说话的 toString —— 字符串拼接一碰它，就报一句人话（await 走 then，不受影响）。
        if (r0 && typeof r0.then === 'function') {
          const r1 = r0.then((v) => { doneCap(); return v; }, (e) => { doneCap(); throw e; });
          try {
            // 注意：要挂在**返回出去的那个** promise 上（包了一层之后挂里面那个是挂丢的 —— 本片自己抓到的）
            r1.toString = () => {
              throw mkErr('E_JS_ERROR', { file: r.label, fn: r.fn, detail: '「' + k + '」这类能力要写 await（例：await ' + k + '(…)）' });
            };
          } catch (e) { /* 挂不上就算了，不影响主流程 */ }
          return r1;
        }
        doneCap();
        return r0;
      };
    }
    sandbox.参数 = args.slice();
    sandbox.__args = args.slice();
    sandbox.__文件名 = r.label;

    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    let p;
    try { p = script.runInContext(context, { timeout: timeoutMs }); }
    catch (e) { throw mapRunErr(e, r, timeoutMs); }
    let value;
    try { value = await withWatchdog(Promise.resolve(p), timeoutMs, totalTimeoutMs, busy, lastAt); }
    catch (e) { throw mapRunErr(e, r, timeoutMs); }
    return { ok: true, value, file: r.label, fn: r.fn };
  }

  /** 声明表（给编辑器/自检用）：{ 文件名: { global, exports:[…], functions:[…] } } */
  async function listDecls(bucketKey) {
    const files = await jsFilesOf(bucketKey);
    const out = {};
    for (const [n, c] of Object.entries(files)) {
      const d = parseDecls(c);
      out[n] = { global: d.global, exports: d.exports.map((x) => x.name), functions: listFunctions(c) };
    }
    return out;
  }

  return { call, resolve, listDecls, parseDecls, listFunctions, splitSpec, invalidate, GLOBAL_BUCKET };
}

module.exports = { createJsRuntime, parseDecls, listFunctions, splitSpec, GLOBAL_BUCKET };
