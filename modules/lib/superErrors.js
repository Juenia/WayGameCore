/**
 * 错误码中央登记表（2026-09-18 S1-b · 治 D11）
 * ------------------------------------------------------------------
 * 背景：错误码以前以字符串字面量散在 4+ 个文件里（共 22 个），
 *   其中两对名字近似、语义不同，最容易踩：
 *     E_NOT_FOUND = 逻辑本身不存在（superModule）
 *     E_NOTFOUND  = 数据行不存在（superBlocks 的变量/内容表操作）
 *     E_INTERNAL  = 运行时内部错误（图解析/未预期异常）
 *     E_RUNTIME   = 运行历史写入时的兜底码（writeRun 默认值）
 *   → 上层按码分支会漏判，统计口径也对不齐。
 *
 * 本文件只做【登记】与【归一】，不改任何调用点的行为：
 *   - CODES：每个码的规范写法 + 归类 + 人话文案模板 + 兼容别名
 *   - normalize(code)：把历史别名收敛到规范码（写库/统计用；老值仍被认）
 *   - human(code, extra)：错误码 → 给作者/玩家看的人话（S2 的 superRespond 会用它）
 *   - all()：登记清单（契约产物 data/super-contract.json 里会带一份）
 *
 * 规矩：新增错误码必须在这里登记 —— test_gap_contract 的 K7 会扫源码，
 *       出现未登记的 E_XXX 字面量即判真缺口。
 */
'use strict';

/** 归类：guard=资源护栏 / input=用户输入 / data=数据层 / runtime=运行时内部 / authoring=作者态（编译/语法） */
const CODES = [
  // ---- 入口与查找 ----
  { code: 'E_NOT_FOUND', kind: 'input', human: '没找到叫「{key}」的逻辑；用 super: 看已有哪些', aliases: [] },
  { code: 'E_DISABLED', kind: 'input', human: '这条逻辑暂时关掉了', aliases: [] },
  { code: 'E_PLAYER', kind: 'input', human: '先注册角色（注册 昵称 男）', aliases: [] },
  { code: 'E_LIMIT', kind: 'guard', human: '用得太快了，{window} 秒内最多 {max} 次', aliases: [] },
  // ---- 参数与表达式 ----
  { code: 'E_ARGS', kind: 'input', human: '参数不对：{detail}', aliases: [] },
  { code: 'E_EXPR', kind: 'input', human: '表达式看不懂：{detail}', aliases: [] },
  { code: 'E_ARITY', kind: 'authoring', human: '参数个数不对：{detail}', aliases: [] },
  { code: 'E_SYNTAX', kind: 'authoring', human: '第 {line} 行语法不对：{detail}', aliases: [] },
  { code: 'E_COMPILE', kind: 'authoring', human: '工程编译不过：{detail}', aliases: [] },
  // ---- 数据层 ----
  { code: 'E_WHITELIST', kind: 'data', human: '这张表不允许动；可以用的：{detail}', aliases: [] },
  { code: 'E_TABLE', kind: 'data', human: '表不对：{detail}', aliases: [] },
  { code: 'E_FIELD', kind: 'data', human: '字段不对：{detail}', aliases: [] },
  { code: 'E_DB', kind: 'data', human: '数据库操作失败：{detail}', aliases: [] },
  { code: 'E_EXISTS', kind: 'data', human: '已经存在了：{detail}', aliases: [] },
  { code: 'E_SYSVAR', kind: 'data', human: '系统变量不能改：{detail}', aliases: [] },
  // 兼容别名：老代码写的 E_NOTFOUND 表示「数据行不存在」，与 E_NOT_FOUND（逻辑不存在）是两回事
  { code: 'E_ROW_NOT_FOUND', kind: 'data', human: '没找到这一行数据：{detail}', aliases: ['E_NOTFOUND'] },
  // ---- 运行时/护栏 ----
  { code: 'E_TIMEOUT', kind: 'guard', human: '跑了超过 {ms} 毫秒被中断', aliases: [] },
  { code: 'E_STEPS', kind: 'guard', human: '超过 {steps} 步，检查循环', aliases: [] },
  { code: 'E_DEPTH', kind: 'guard', human: '调用套得太深（最多 {max} 层）', aliases: [] },
  { code: 'E_NO_OUTPUT', kind: 'authoring', human: '{detail}', aliases: [] },
  { code: 'E_INTERNAL', kind: 'runtime', human: '这条逻辑出错了（已记录，堆栈进运行记录）', aliases: [] },
  // ---- JS 通道（2026-09-19 · 作者面 v2 的 R4/R6）----
  { code: 'E_JS_SYNTAX', kind: 'authoring', human: 'JS 文件「{file}」第 {line} 行语法不对：{detail}', aliases: [] },
  { code: 'E_JS_ERROR', kind: 'runtime', human: 'JS「{file}」里的 {fn} 执行出错：{detail}', aliases: [] },
  { code: 'E_JS_DENIED', kind: 'authoring', human: '这个 JS 函数不对外开放：{detail}', aliases: [] },
  // 兼容别名：writeRun 的兜底码，语义并入 E_INTERNAL
  { code: 'E_INTERNAL_RUNTIME', kind: 'runtime', human: '这条逻辑出错了（已记录）', aliases: ['E_RUNTIME'] },
];

const CANON = CODES.map((c) => c.code);
const BY_CODE = new Map(CODES.map((c) => [c.code, c]));
const ALIAS = new Map();
for (const c of CODES) { ALIAS.set(c.code, c.code); for (const a of c.aliases || []) ALIAS.set(a, c.code); }

/** 历史别名 → 规范码；认不出就原样返回（绝不抛，调用点在错误路径上） */
function normalize(code) {
  const k = String(code == null ? '' : code);
  return ALIAS.get(k) || k;
}
/** 是否登记过（规范码或别名都算） */
function isKnown(code) { return ALIAS.has(String(code == null ? '' : code)); }
/** 登记项（按规范码或别名查） */
function meta(code) { return BY_CODE.get(normalize(code)) || null; }
/** 人话：模板里的 {xxx} 用 extra 填；填不上的原样留着（宁可露出占位符，也不吞信息） */
function human(code, extra) {
  const m = meta(code);
  if (!m) return '出错了（未登记的错误码：' + String(code) + '）';
  let s = m.human;
  for (const [k, v] of Object.entries(extra || {})) s = s.split('{' + k + '}').join(String(v == null ? '' : v));
  return s;
}
/** 全部登记清单（契约产物用） */
function all() { return CODES.map((c) => ({ code: c.code, kind: c.kind, aliases: (c.aliases || []).slice() })); }
/** 别名清单（老码 → 规范码） */
function aliasPairs() {
  const out = {};
  for (const c of CODES) for (const a of (c.aliases || [])) out[a] = c.code;
  return out;
}

/**
 * 造一个带错误码的 Error（模块内唯一出口，2026-09-19 S2 第十一批从 superModule 搬入）。
 * 未登记的错误码在这里留一条 warn —— 开发期立刻看得见；静态那层由 test_gap_contract 的 K7 扫源码兜住。
 * 注意：只提示不改码，存进运行历史的仍是调用点原本那个字符串（行为零变更）。
 */
function make(code, message, log) {
  if (!isKnown(code)) {
    try { if (log) log('warn', '[super] 未登记的错误码：' + code + '（请在 modules/lib/superErrors.js 登记）'); } catch (e0) {}
  }
  const err = new Error(message); err.code = code; return err;
}

module.exports = { CODES, CANON, normalize, isKnown, meta, human, all, aliasPairs, make };
