/**
 * 块 / 代码两种模式共用的纯助手（2026-09-19 S3 第二批：从 superBlocks.js 顶层搬出）
 * ------------------------------------------------------------------
 * 只依赖参数与 db、不依赖任何闭包状态：表结构探测 / 字段行解析 / 写列校验 / 变量值规范化 /
 * 引号剥离 / 空表达式人话。块模式（superBlocks）与代码模式（superCode）共用同一份。
 */
'use strict';

const crypto = require('crypto');

/* =====================================================================
 * ⑩ 段共享助手（2026-09-18 四大块批次：变量读写 / 数据增删改 / 多轮状态）
 * 放在顶层并导出 —— 块模式（本文件）与代码模式（superCode.js）共用同一套，
 * 避免"块能写、代码不能写"这种两份实现各写一遍的漂移。
 * ===================================================================== */
/** 可写内容表白名单 —— 与只读「查数据」同一份口径（items…professions） */
const { QUERY_TABLES, PLAYER_TABLES, WRITE_TABLES } = require('./superTables');   // 2026-09-18：白名单唯一来源
/** 表结构缓存：表名 → { cols:Set, pk:主键列名 }（进程内缓存，改表结构重启即刷新） */
const tableInfoCache = new Map();
async function tableInfo(db, table) {
  const t = String(table == null ? '' : table).trim();
  if (tableInfoCache.has(t)) return tableInfoCache.get(t);
  let rows = [];
  try { rows = await db.all('PRAGMA table_info(' + t + ')'); } catch (e) { rows = []; }
  const cols = new Set((rows || []).map((r) => (r && r.name) || '').filter(Boolean));
  let pk = '';
  for (const r of (rows || [])) { if (r && Number(r.pk) === 1) { pk = String(r.name); break; } }
  if (!pk && cols.has('id')) pk = 'id';
  if (!pk && cols.has('name')) pk = 'name';
  const info = { cols, pk, raw: rows || [], table: t };
  tableInfoCache.set(t, info);
  return info;
}
/** 解析「字段=值; 字段2=值2」（换行 / 分号 / 中文分号都算分隔）—— 只切不改，求值交给调用方 */
function splitFieldLines(raw) {
  const out = [];
  for (const seg of String(raw == null ? '' : raw).split(/[;\n\uff1b]+/)) {
    const line = seg.trim();
    if (!line) continue;
    const eq = line.search(/[=\uff1d]/);
    if (eq < 0) { const e = new Error('「' + line + '」要写成 字段=值（例：name=新手剑）'); e.code = 'E_ARGS'; throw e; }
    const col = line.slice(0, eq).trim();
    const valRaw = line.slice(eq + 1).trim();
    if (!col) { const e = new Error('「' + line + '」缺字段名'); e.code = 'E_ARGS'; throw e; }
    out.push({ col, valRaw });
  }
  return out;
}
/** 变量名去掉「系统.」前缀（两种写法都认） */
function stripSysPrefix(name) { return String(name == null ? '' : name).trim().replace(/^系统\./, ''); }
/** 是不是系统变量（模块注册的，只读、不可覆盖） */
function isSysVar(core, name) {
  return !!(core && core.systemVariables && typeof core.systemVariables.has === 'function' && core.systemVariables.has(name));
}
/** 写操作体检：表白名单 + 每个字段都必须是这张表真实存在的列（写错一律人话报错） */
function checkWriteColumns(table, cols, pairs) {
  const t = String(table == null ? '' : table).trim();
  if (WRITE_TABLES.indexOf(t) < 0) {
    const e = new Error('不允许写入表：' + t + '（可写：' + WRITE_TABLES.join('、') + '）');
    e.code = 'E_WHITELIST'; throw e;
  }
  for (const p of pairs) {
    if (!cols.has(p.col)) {
      const e = new Error('表 ' + t + ' 没有字段「' + p.col + '」（可用字段：' + Array.from(cols).join('、') + '）');
      e.code = 'E_FIELD'; throw e;
    }
  }
}
/**
 * 变量入库前的规范化（2026-09-18 四大块批次 · 实测抓到的坑）
 * 核心读变量时会把值当 JS 公式**再求值一次**（core._evaluateExpression）：
 *   纯文本「你好呀」→ 未定义标识符 → 0；中文函数「拼接(…)」→ 也未定义 → 0。
 * 规则：① url: 的 HTTP 变量原样；② 纯数字原样；③ 已经带引号的字面量原样；
 *      ④ 含 [变量] 且不含运算符 → 转成 "字面" + [变量] + "字面" 的拼接式（核心能算）；
 *      ⑤ 含 [变量] 且含运算符 → 当公式原样存；⑥ 一眼是纯文本 → 套引号；
 *      ⑦ 其余（中文函数这类核心不认识的写法）→ 存求值后的结果。
 */
function normalizeVarValue(src, evaluated) {
  let s = String(src == null ? '' : src).trim();
  const ev = (evaluated === null || evaluated === undefined) ? '' : (typeof evaluated === 'object' ? JSON.stringify(evaluated) : String(evaluated));
  // 外层引号只是"这是文本"的标记 —— 先剥掉再判内容。
  // （实测：代码模式写 设置变量("名", "你好，[玩家昵称]！") 时，带引号的文本直接入库，
  //   核心替换 [玩家昵称] 时会插进一对引号，把整串表达式弄成语法错误 → 读出来是一堆怪引号。）
  let quoted = false;
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1); quoted = true;
  }
  const hasPh = /\[[^\[\]]+\]/.test(s);
  /** 「甲[变量]乙」→ "甲" + [变量] + "乙"（核心按公式求值，占位符照样插值） */
  const toConcat = (t) => t.split(/(\[[^\[\]]+\])/).filter((p) => p !== '')
    .map((p) => (/^\[[^\[\]]+\]$/.test(p) ? p : JSON.stringify(p))).join(' + ');
  if (!s && !quoted) return JSON.stringify(ev);
  if (/^url:/i.test(s)) return s;                                     // ① HTTP 变量
  if (!quoted && /^-?\d+(\.\d+)?$/.test(s)) return s;                 // ② 纯数字（可参与运算）
  if (quoted) return hasPh ? toConcat(s) : JSON.stringify(s);         // ③ 用户明说是文本
  const hasOp = /[+\-*/%]/.test(s) || /[A-Za-z_]\w*\s*\(/.test(s);
  if (hasPh && hasOp) return s;                                       // ④ [变量] + 运算符 = 公式，原样
  if (hasPh) return toConcat(s);                                      // ⑤ [变量] 文本 → 拼接式
  if (BARE_TEXT_RE.test(s) && !VAR_LIKE_RE.test(s)) return JSON.stringify(s);   // ⑥ 裸词 = 文本
  return JSON.stringify(ev);                                          // ⑦ 中文函数等：存求值结果
}

function stripQuotes(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return v;
}

/** 判定"人话"：没有引号/运算符/点/括号/逗号 —— 一眼就是给人看的文本，不是表达式 */
const BARE_TEXT_RE = /^[^"'\`()\[\]{},+\-*/%<>=!&|:.$]+$/;
/** 明显是变量形状的裸词：这类就算取不到值也不能当文本印出来 */
const VAR_LIKE_RE = /^(参数\d*|参数个数|次数|序号|项|项数|索引|第一个|最后|变量|节点|数据|列表\d*)$/;

/**
 * 表达式求值为空时给人话解释（裸词 → 告诉他要加引号）。
 * 背景（2026-09-17 · BUG 记录 1 的真凶）：用户在「消息内容 / 推送内容 / 返回文本」这类
 * 表达式字段里直接写中文（测试消息）时，表达式引擎把它当【变量名】→ 求值 null →
 * 「发消息」推出空串、「主动推送」报"内容为空"，用户只觉得"功能根本跑不起来"。
 */
function explainEmptyExpr(raw) {
  const src = String(raw == null ? '' : raw).trim();
  if (src && BARE_TEXT_RE.test(src) && !VAR_LIKE_RE.test(src)) {
    return '写的是「' + src + '」—— 这种纯文本要加英文引号，写成 "' + src + '"（变量名才不加引号）';
  }
  if (src) return '表达式「' + src + '」求值为空 —— 检查变量名有没有写错（纯文本记得加引号）';
  return '这个字段是空的';
}

module.exports = { stripQuotes, explainEmptyExpr, BARE_TEXT_RE, VAR_LIKE_RE,
  WRITE_TABLES, QUERY_TABLES, PLAYER_TABLES, tableInfo, splitFieldLines, stripSysPrefix, isSysVar, checkWriteColumns, normalizeVarValue };
