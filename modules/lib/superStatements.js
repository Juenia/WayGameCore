/**
 * 中文 DSL / .way 的语句表（2026-09-18 结构治理：从 superCode.js 抽出来）
 * ------------------------------------------------------------------
 * 这里只有【数据】：控制流关键字、平铺语句表、分支语句表、参数顺序表、人话名表、取值函数表。
 * 解释执行的部分仍留在 superCode.js —— 语句表独立出去之后，
 * 「改语句表」与「改解释器」不再是同一个文件里的一件事，编辑器契约测试（K2）也更好读。
 *
 * ⚠️ 编辑器侧有一份等价表（editor-wpf/.../LogicEditorScript.cs 的 DSL_FLAT / DSL_BRANCH），
 *    两边必须逐条一致 —— 由 test_gap_contract.js 的 K2 契约钉着，改这里记得同步那边。
 */
'use strict';

const S_KW = {
  entry: '# 开始',
  cond: '如果', elseIf: '否则如果', else: '否则', endIf: '结束如果',
  loopN: '循环', loopTail: '次', endLoop: '结束循环',
  each: '遍历', eachIn: '在', endEach: '结束遍历',
  tryOne: '尝试', catchOne: '捕获', endTry: '结束尝试',
};
const EMPTY_ARG = '（空）';
const CLOSERS = [S_KW.endIf, S_KW.endLoop, S_KW.endEach, S_KW.endTry];

const S_FLAT = [
  { kw: '发送模板', t: 'tpl_send', p: [{ k: 'key', u: 1 }], lg: 'rest' },
  { kw: '发送', t: 'msg_send', p: [{ k: 'text' }], lg: 'rest' },
  { kw: '返回模板', t: 'return_tpl', p: [{ k: 'key', u: 1 }], lg: 'rest' },
  { kw: '返回', t: 'return_text', p: [{ k: 'value' }], lg: 'rest' },
  { kw: '跳出循环', t: 'break_loop', p: [], lg: 'rest' },
  { kw: '读玩家', t: 'player_get', p: [{ k: 'field', u: 1 }], lg: 'arg' },
  { kw: '设玩家', t: 'player_set', p: [{ k: 'field', u: 1 }, { k: 'value' }], lg: 'arg' },
  { kw: '加货币', t: 'currency_add', p: [{ k: 'field', u: 1 }, { k: 'amount', u: 1 }], lg: 'arg' },
  { kw: '扣货币', t: 'currency_sub', p: [{ k: 'field', u: 1 }, { k: 'amount', u: 1 }], lg: 'arg' },
  { kw: '加物品', t: 'item_add', p: [{ k: 'name', u: 1 }, { k: 'count', u: 1 }], lg: 'arg' },
  { kw: '扣物品', t: 'item_take', p: [{ k: 'name', u: 1 }, { k: 'count', u: 1 }], lg: 'arg' },
  { kw: '推送', t: 'push_send', p: [{ k: 'type', u: 1 }, { k: 'content' }], lg: 'arg' },
  { kw: '完成任务', t: 'quest_complete', p: [{ k: 'name', u: 1 }], lg: 'rest' },
  { kw: '传送', t: 'teleport', p: [{ k: 'map', u: 1 }], lg: 'rest' },
  { kw: '查询', t: 'query_get', p: [{ k: 'table', u: 1 }, { k: 'by', u: 1 }, { k: 'value' }, { k: 'field', u: 1 }], lg: 'query' },
  { kw: '查玩家', t: 'player_query', p: [{ k: 'table', u: 1 }, { k: 'playerId', u: 1 }], lg: 'arg' },
  { kw: '日志', t: 'log', p: [{ k: 'text' }], lg: 'rest' },
  { kw: '调用', t: 'call', p: [{ k: 'key', u: 1 }, { k: 'args' }], lg: 'arg' },
  { kw: '汇合', t: 'join', p: [{ k: 'count', u: 1 }], lg: 'rest' },
  { kw: '等待', t: 'wait', p: [{ k: 'ms', u: 1 }], lg: 'arg' },
  { kw: '建列表', t: 'list_make', p: [{ k: 'items' }], lg: 'rest' },
  { kw: '列表追加', t: 'list_append', p: [{ k: 'list' }, { k: 'value' }], lg: 'arg' },
  { kw: '列表长度', t: 'list_len', p: [{ k: 'list' }], lg: 'rest' },
  { kw: '取第N项', t: 'list_get', p: [{ k: 'list' }, { k: 'index', u: 1 }], lg: 'arg' },
  { kw: '数字序列', t: 'list_range', p: [{ k: 'from', u: 1 }, { k: 'to', u: 1 }], lg: 'arg' },
  { kw: '文本替换', t: 'text_replace', p: [{ k: 'text' }, { k: 'from', u: 1 }, { k: 'to', u: 1 }], lg: 'arg' },
  { kw: '文本截取', t: 'text_slice', p: [{ k: 'text' }, { k: 'start', u: 1 }, { k: 'count', u: 1 }], lg: 'arg' },
  { kw: '大小写', t: 'text_case', p: [{ k: 'text' }, { k: 'mode', u: 1 }], lg: 'arg' },
  { kw: '查找位置', t: 'text_find', p: [{ k: 'text' }, { k: 'sub', u: 1 }], lg: 'arg' },
  { kw: '补零', t: 'text_pad', p: [{ k: 'value' }, { k: 'len', u: 1 }], lg: 'arg' },
  { kw: '拼接文本', t: 'text_concat', p: [{ k: 'a' }, { k: 'b' }], lg: 'none' },
  { kw: '数字运算', t: 'math_op', p: [{ k: 'a' }, { k: 'op', u: 1 }, { k: 'b' }], lg: 'none' },
  { kw: '四舍五入', t: 'math_round', p: [{ k: 'value' }, { k: 'digits', u: 1 }], lg: 'arg' },
  { kw: '随机数', t: 'math_rand', p: [{ k: 'a', u: 1 }, { k: 'b', u: 1 }], lg: 'arg' },
  // 2026-09-18：编辑器 DSL_FLAT 里还没有「发出事件」，但块（event_emit）早就有了 ——
  // 代码模式先补上这个语句，编辑器那条线把表补齐后两边自动一致（写法沿用括号式）。
  { kw: '发出事件', t: 'event_emit', p: [{ k: 'name', u: 1 }, { k: 'data' }], lg: 'arg' },
  // 2026-09-18 四大块批次：变量读写 / 数据增删改 / 多轮状态（与 superBlocks 的 8 个新块同名、同参数顺序）
  { kw: '读变量', t: 'var_get', p: [{ k: 'name', u: 1 }], lg: 'rest' },
  { kw: '设置变量', t: 'var_set', p: [{ k: 'name', u: 1 }, { k: 'value' }, { k: 'desc', u: 1 }], lg: 'arg' },
  { kw: '删除变量', t: 'var_del', p: [{ k: 'name', u: 1 }], lg: 'rest' },
  { kw: '新建数据', t: 'data_create', p: [{ k: 'table', u: 1 }, { k: 'fields' }], lg: 'arg' },
  { kw: '修改数据', t: 'data_update', p: [{ k: 'table', u: 1 }, { k: 'rowKey' }, { k: 'fields' }], lg: 'arg' },
  { kw: '删除数据', t: 'data_delete', p: [{ k: 'table', u: 1 }, { k: 'rowKey' }], lg: 'arg' },
  { kw: '进入状态', t: 'enter_state', p: [{ k: 'name', u: 1 }, { k: 'timeout', u: 1 }], lg: 'arg' },
  { kw: '结束状态', t: 'exit_state', p: [{ k: 'name', u: 1 }], lg: 'rest' },
];
const S_BRANCH = [
  { kw: S_KW.elseIf, t: 'elseif', p: [{ k: 'expr' }], head: 1 },
  { kw: S_KW.cond, t: 'condition', p: [{ k: 'expr' }], head: 1 },
  { kw: '检查物品', t: 'check_has_item', p: [{ k: 'name', u: 1 }, { k: 'count', u: 1 }], lg: 'arg' },
  { kw: '列表包含', t: 'list_contains', p: [{ k: 'list' }, { k: 'value' }], lg: 'arg' },
  { kw: '数字比较', t: 'math_compare', p: [{ k: 'a' }, { k: 'op', u: 1 }, { k: 'b' }], lg: 'none' },
  // 2026-09-18 四大块批次：删除变量是分支型（删到了走真、本来没有走假），与块的两个出口一致
];

const S_BY_TYPE = {};
S_FLAT.forEach((d) => { S_BY_TYPE[d.t] = d; });
S_BRANCH.forEach((d) => { S_BY_TYPE[d.t] = d; });
/** 语句 type → 参数键顺序（供"当函数用"时按位填参） */
const PARAM_KEYS = {};
Object.keys(S_BY_TYPE).forEach((t) => { PARAM_KEYS[t] = S_BY_TYPE[t].p.map((x) => x.k); });

const NAME_OF = {
  entry: '开始', condition: '如果', elseif: '否则如果', loop_n: '循环 次数', loop_each: '遍历 列表',
  try_node: '尝试 / 捕获', assign: '变量赋值', call: '调用函数', player_get: '读玩家字段', player_set: '改玩家字段',
  currency_add: '加货币', currency_sub: '扣货币', item_add: '加物品', item_take: '扣物品',
  check_has_item: '检查拥有物品', msg_send: '发消息', tpl_send: '发模板消息', push_send: '主动推送',
  quest_complete: '完成任务', teleport: '传送地图', query_get: '查数据', player_query: '查玩家子表',
  return_text: '返回文本', return_tpl: '返回模板', log: '记录日志', event_emit: '发出事件',
  join: '汇合', break_loop: '跳出循环', wait: '等待',
  list_make: '建列表', list_append: '列表追加', list_get: '取第N项', list_len: '列表长度',
  list_contains: '列表包含', list_range: '数字序列',
  text_replace: '文本替换', text_slice: '文本截取', text_case: '大小写', text_find: '查找位置',
  text_pad: '补零', text_concat: '拼接文本',
  math_op: '数字运算', math_round: '四舍五入', math_rand: '随机数', math_compare: '数字比较',
  var_get: '读取变量', var_set: '设置变量', var_del: '删除变量',
  data_create: '新建数据', data_update: '修改数据', data_delete: '删除数据',
  enter_state: '进入状态', exit_state: '结束状态',
};

/** 代码模式专属取值函数：名(…) → 语句执行 → 返回值（superExpr 的原生函数表里没有这些名字） */
const HELPER_TYPES = {
  '玩家': 'player_get', '读玩家': 'player_get',
  '参数': '__args', '变量': '__var',
  '查询': 'query_get', '查玩家': 'player_query',
  '调用': 'call',
  '建列表': 'list_make', '列表追加': 'list_append', '列表长度': 'list_len', '取第N项': 'list_get', '数字序列': 'list_range',
  '列表包含': 'list_contains', '检查物品': 'check_has_item',
  '文本替换': 'text_replace', '文本截取': 'text_slice', '大小写': 'text_case', '查找位置': 'text_find',
  '拼接文本': 'text_concat', '数字运算': 'math_op', '随机数': 'math_rand', '数字比较': 'math_compare',
  '读变量': 'var_get', '设置变量': 'var_set', '删除变量': 'var_del',   // 2026-09-18 四大块批次
};

module.exports = { S_KW, EMPTY_ARG, CLOSERS, S_FLAT, S_BRANCH, S_BY_TYPE, PARAM_KEYS, NAME_OF, HELPER_TYPES };
