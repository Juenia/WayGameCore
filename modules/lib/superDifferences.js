/**
 * 块模式 ⇄ 代码模式 的【已知差异表】（2026-09-19 S4 第四批 · 满足不变量 I1 双面等价）
 * ------------------------------------------------------------------
 * 背景：本模块一直宣称「块与代码是同一门语言的两种语法」（不变量 I1）。但两边确实存在差异，
 * 以前这些差异只散落在各处注释与报告里 —— 新人读不出来，改动时也容易踩。
 * 这里把它收成一份**唯一来源**，并由契约测试钉住：差异表必须与运行时实际情况一致。
 *
 * 差异分两类：
 *   · structural —— 只是「表达形式不同」，语义等价（例如循环：块是容器、代码是语法结构）
 *   · semantic   —— 行为确实不同（文案 / 校验 / 可指定参数），每一条都写明影响面与归属
 *
 * 规矩：**新增差异必须在 se 里登记**；消除差异时把它删掉 —— 差异表只准变短，不准悄悄变长。
 */
'use strict';

/** 表达形式差异（语义等价）：代码模式用语法结构表达，因此 RUN 里没有同名条目 */
const STRUCTURAL = [
  { types: ['entry'], note: '入口：代码模式的入口是「第一行」，没有对应语句' },
  { types: ['loop_n'], note: '循环次数：代码写「循环 N 次 … 结束循环」' },
  { types: ['loop_each'], note: '遍历列表：代码写「遍历 项 在 列表 … 结束遍历」' },
  { types: ['try_node'], note: '尝试/捕获：代码写「尝试 … 捕获 … 结束尝试」' },
];

/** 语义差异（行为确实不同）：每条都要写明影响面与归属 */
const SEMANTIC = [
  {
    id: 'D-A1', types: ['item_add', 'item_take'], title: '代码模式多一层「必须填物品名」校验',
    detail: '块模式靠必填参数（required）在编辑期提示、运行时不再二次校验；代码模式在运行时先判空并抛出「「加物品」没有填物品名」。',
    impact: '错误文案与触发时机不同（都会报错，不会静默）。',
    owner: 'S3+ 已登记；统一需先确认玩家可见文案口径。',
  },
  {
    id: 'D-A2', types: ['push_send'], title: '代码模式只能指定两个参数',
    detail: 'DSL 只写「推送(类型, 内容)」；发送方式 / 出图布局 / 延迟三个参数取块定义的默认值（跟随全局 / system.info / 3 秒）。',
    impact: '代码模式无法逐条指定这三个参数（想要别的值只能用块模式）。',
    owner: 'S3+ 第二批；如需支持，扩 DSL 参数即可（语句表加参数位）。',
  },
  {
    id: 'D-A3', types: ['var_get', 'var_set', 'var_del'], title: '变量三件套的错误码与文案不同',
    detail: '块模式带错误码（E_ARGS / E_NOTFOUND / E_SYSVAR）且读变量失败时会列出「现有自定义变量名」；代码模式是普通 Error、文案更短。',
    impact: '运行历史里的 error_code 与玩家看到的报错文案不同（都会报错，不会静默）。',
    owner: 'S3+ 第四批**主动不搬**：统一会把代码模式的口径改成块侧，属玩家可见变化，需独立小片决策。',
  },
  {
    id: 'D-A4', types: ['data_create', 'data_update', 'data_delete'], title: '字段行取值包装不同',
    detail: '块模式走 parseFieldPairs + checkWrite（写列白名单校验）；代码模式走 fieldPairsCode 包装（同样校验，实现不同）。',
    impact: '语义已对齐（都做白名单与字段存在性校验），但两份包装未合并。',
    owner: 'S3+ 第四批记为「待逐条核」；合并属动作层收敛的后续批次。',
  },
  {
    id: 'D-B1', types: [], title: '代码模式独有：.way 多文件工程',
    detail: '代码模式支持 C 风格多文件工程（#引用 / 函数原型声明 / main.way 入口，文件存 custom_logic_file）；块模式没有对应能力。',
    impact: '能力差异（代码模式更强），不是缺陷。',
    owner: '设计如此（2026-09-18 代码规格 v2）。',
  },
];

/** 差异表（契约产物与文档共用这一份） */
function differenceEntries() {
  return {
    structural: STRUCTURAL.map((x) => ({ types: x.types.slice(), note: x.note })),
    semantic: SEMANTIC.map((x) => ({ id: x.id, types: x.types.slice(), title: x.title, detail: x.detail, impact: x.impact, owner: x.owner })),
  };
}

/** 所有被差异表点过名的块类型（契约测试用来核对「没有漏登记的差异类型」） */
function coveredTypes() {
  const out = [];
  for (const x of STRUCTURAL) for (const t of x.types) out.push(t);
  for (const x of SEMANTIC) for (const t of x.types) out.push(t);
  return out.sort();
}

module.exports = { differenceEntries, coveredTypes, STRUCTURAL, SEMANTIC };
