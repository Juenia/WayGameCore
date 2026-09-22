/**
 * 超级自定义模块 · 表结构 v3 幂等迁移（2026-09-15 S1）
 * 原则（全局兼容）：
 *   - 只做「加列 / 建表 / 建索引」，不改已有列、不删任何东西
 *   - 全部 try/catch 幂等：重复执行零副作用；表不存在/列已存在一律跳过
 *   - 表名/列名均为内部常量，无外部注入
 * 被 modules/superModule.js 在模块函数体里 await 调用（core.db 已就绪，
 * 且 loadModule 会 await 模块函数体 → engine.start() 返回时 schema 必已就绪）。
 */
'use strict';

/**
 * 2026-09-18 S1-b · 死列/死表登记（只标注，绝不 DROP —— 守住"只加不删"这条全局兼容原则）
 * ------------------------------------------------------------------
 * 全仓实测（grep 零引用）：
 *   · custom_logic_history.code / author —— 建了列，运行时与编辑器都不读不写
 *   · custom_logic_template             —— 建了表，运行时零引用（模板商店用的是编辑器侧内置清单）
 * 处置：保留 DDL（老库兼容、不破坏任何已有数据），仅在此登记；将来确要启用时按新需求重设计。
 */
const V3_COLUMNS = [
  ['custom_logic', 'description', "TEXT DEFAULT ''"],
  ['custom_logic', 'trigger_mode', "TEXT DEFAULT 'prefix'"],
  ['custom_logic', 'rate_limit', 'TEXT DEFAULT NULL'],
  ['custom_logic', 'args_schema', "TEXT DEFAULT '[]'"],
  ['custom_logic', 'output_kind', "TEXT DEFAULT 'text'"],
  // 2026-09-18：执行模式。'block' = 走块图（默认，老逻辑完全不变）；'code' = 直接解释执行 code 列
  ['custom_logic', 'exec_mode', "TEXT DEFAULT 'block'"],
  // 2026-09-18（.way 多文件工程）：代码规格。'dsl' = 老的单文件中文 DSL（原样跑，完全兼容）；
  // 'way' = C 风格多文件工程，正文在 custom_logic_file 里，入口固定 main.way
  ['custom_logic', 'lang', "TEXT DEFAULT 'dsl'"],
  ['custom_logic_history', 'code', "TEXT DEFAULT ''"],
  ['custom_logic_history', 'author', "TEXT DEFAULT ''"],
  ['custom_logic_run', 'args_json', "TEXT DEFAULT '[]'"],
  ['custom_logic_run', 'steps', 'INTEGER DEFAULT 0'],
  ['custom_logic_run', 'error_code', "TEXT DEFAULT ''"],
];

const V3_CREATES = [
  'CREATE TABLE IF NOT EXISTS custom_logic_trigger (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'logic_key TEXT NOT NULL,' +
    "kind TEXT DEFAULT 'command'," +
    'pattern TEXT NOT NULL,' +
    "match_mode TEXT DEFAULT 'prefix'," +
    'priority INTEGER DEFAULT 100,' +
    "arg_mode TEXT DEFAULT 'split'," +
    'enabled INTEGER DEFAULT 1,' +
    "note TEXT DEFAULT ''," +
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP,' +
    'UNIQUE(logic_key, kind, pattern)' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_clt_pattern ON custom_logic_trigger(pattern, enabled)',
  // 2026-09-18：.way 多文件工程的代码文件（一个自定义功能 = 多个文件，入口 main.way）
  'CREATE TABLE IF NOT EXISTS custom_logic_file (' +
    'logic_key TEXT NOT NULL,' +
    'name TEXT NOT NULL,' +
    "content TEXT DEFAULT ''," +
    "updated_at TEXT DEFAULT ''," +
    'sort INTEGER DEFAULT 100,' +
    'PRIMARY KEY (logic_key, name)' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_clf_key ON custom_logic_file(logic_key, sort)',
  'CREATE TABLE IF NOT EXISTS custom_logic_template (' +
    'id TEXT PRIMARY KEY,' +
    'name TEXT NOT NULL,' +
    "category TEXT DEFAULT ''," +
    "description TEXT DEFAULT ''," +
    'graph TEXT NOT NULL,' +
    "args_hint TEXT DEFAULT '[]'," +
    'sort INTEGER DEFAULT 100,' +
    'enabled INTEGER DEFAULT 1' +
    ')',
  // 2026-09-18 四大块批次 · 多轮状态：玩家「进入状态」后，他下一条消息（不管内容）
  // 都回到那条逻辑 —— 路由靠这张表（一玩家一状态；expires_at=0 表示不过期）
  'CREATE TABLE IF NOT EXISTS custom_logic_state (' +
    'player_id TEXT NOT NULL PRIMARY KEY,' +
    'logic_key TEXT NOT NULL,' +
    "state_name TEXT DEFAULT ''," +
    "args_json TEXT DEFAULT '[]'," +
    'expires_at INTEGER DEFAULT 0,' +
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP,' +
    'updated_at TEXT DEFAULT CURRENT_TIMESTAMP' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_cls_logic ON custom_logic_state(logic_key)',
];

async function ensureV3(db, log) {
  const L = (lv, msg) => { try { if (log) log(lv, msg); } catch (e) { /* 日志失败不影响迁移 */ } };
  for (const [table, column, ddl] of V3_COLUMNS) {
    try {
      const rows = await db.all('PRAGMA table_info(' + table + ')');
      const exists = Array.isArray(rows) && rows.some((r) => r && r.name === column);
      if (exists) continue;
      await db.run('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl);
      L('info', '[superSchema] +' + table + '.' + column);
    } catch (e) {
      L('warn', '[superSchema] ' + table + '.' + column + ' 跳过：' + e.message);
    }
  }
  for (const sql of V3_CREATES) {
    try { await db.run(sql); } catch (e) { L('warn', '[superSchema] 建表/索引跳过：' + e.message); }
  }
}

module.exports = { ensureV3 };
