/**
 * WayGame 图片模块 · 表结构幂等迁移
 * 原则（与 modules/lib/superSchema.js 一致）：
 *   - 只做「建表 / 建索引 / 加列」，不改已有列、不删任何东西
 *   - 全部 try/catch 幂等：重复执行零副作用
 *   - 表名列名均为内部常量，无外部注入
 * 被 modules/imageModule.js 在模块函数体里 await 调用（core.db 已就绪，loadModule 会 await 模块函数体）。
 */
'use strict';

const CREATES = [
  'CREATE TABLE IF NOT EXISTS image_layouts (' +
    'id TEXT PRIMARY KEY,' +
    'name TEXT NOT NULL,' +
    "room TEXT DEFAULT '*'," +
    "template_key TEXT DEFAULT '*'," +
    "mode TEXT DEFAULT 'hybrid'," +
    'width INTEGER DEFAULT 720,' +
    'height INTEGER DEFAULT 0,' +          // 0 = auto
    'scale INTEGER DEFAULT 2,' +
    "doc_json TEXT NOT NULL DEFAULT '{}'," +
    'enabled INTEGER DEFAULT 1,' +
    'sort INTEGER DEFAULT 100,' +
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP,' +
    'updated_at TEXT DEFAULT CURRENT_TIMESTAMP' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_il_room_key ON image_layouts(room, template_key, enabled)',
  'CREATE TABLE IF NOT EXISTS image_layout_history (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'layout_id TEXT NOT NULL,' +
    "doc_json TEXT NOT NULL DEFAULT '{}'," +
    "note TEXT DEFAULT ''," +
    "author TEXT DEFAULT ''," +
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_ilh_layout ON image_layout_history(layout_id, id)',
  'CREATE TABLE IF NOT EXISTS image_assets (' +
    'id TEXT PRIMARY KEY,' +
    'name TEXT NOT NULL,' +
    "mime TEXT DEFAULT 'image/png'," +
    'path TEXT NOT NULL,' +
    'bytes INTEGER DEFAULT 0,' +
    'width INTEGER DEFAULT 0,' +
    'height INTEGER DEFAULT 0,' +
    "sha256 TEXT DEFAULT ''," +
    "tags TEXT DEFAULT ''," +
    "group_name TEXT DEFAULT ''," +
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP' +
    ')',
  'CREATE TABLE IF NOT EXISTS image_render_cache (' +
    'hash TEXT PRIMARY KEY,' +
    "layout_id TEXT DEFAULT ''," +
    'path TEXT NOT NULL,' +
    'bytes INTEGER DEFAULT 0,' +
    'width INTEGER DEFAULT 0,' +
    'height INTEGER DEFAULT 0,' +
    'hits INTEGER DEFAULT 0,' +
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP,' +
    'last_used_at TEXT DEFAULT CURRENT_TIMESTAMP' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_irc_used ON image_render_cache(last_used_at)',
  // 模板商店（P1.5）：内置模板 + 用户「把布局存为模板」
  'CREATE TABLE IF NOT EXISTS image_layout_template (' +
    'id TEXT PRIMARY KEY,' +
    'name TEXT NOT NULL,' +
    "category TEXT DEFAULT ''," +
    "description TEXT DEFAULT ''," +
    "doc_json TEXT NOT NULL DEFAULT '{}'," +
    'sort INTEGER DEFAULT 100,' +
    'enabled INTEGER DEFAULT 1,' +
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_ilt_sort ON image_layout_template(sort, category)',
  // 模板版本管理（P1.5 第四批）：覆盖保存模板时留上一版，可回滚
  'CREATE TABLE IF NOT EXISTS image_layout_template_history (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'template_id TEXT NOT NULL,' +
    "doc_json TEXT NOT NULL DEFAULT '{}'," +
    "note TEXT DEFAULT ''," +
    'created_at TEXT DEFAULT CURRENT_TIMESTAMP' +
    ')',
  'CREATE INDEX IF NOT EXISTS idx_ilth_tpl ON image_layout_template_history(template_id, id)',
];

// 预留：后续版本加列在此登记（只加不删）
const COLUMNS = [
  ['image_assets', 'tags', "TEXT DEFAULT ''"],          // P1.5 第三批：素材标签（逗号分隔）
  ['image_assets', 'group_name', "TEXT DEFAULT ''"],    // P1.5 第四批：素材分组（单层文件夹）
];

async function ensureImageSchema(db, log) {
  const L = (lv, msg) => { try { if (log) log(lv, msg); } catch (e) { /* 日志失败不影响迁移 */ } };
  if (!db) throw new Error('imageSchema: core.db 未就绪');
  for (const sql of CREATES) {
    try { await db.exec(sql); } catch (e) { L('warn', '[imageSchema] 建表/索引跳过：' + e.message); }
  }
  for (const [table, column, ddl] of COLUMNS) {
    try {
      const rows = await db.all('PRAGMA table_info(' + table + ')');
      const exists = Array.isArray(rows) && rows.some((r) => r && r.name === column);
      if (exists) continue;
      await db.run('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl);
      L('info', '[imageSchema] +' + table + '.' + column);
    } catch (e) {
      L('warn', '[imageSchema] ' + table + '.' + column + ' 跳过：' + e.message);
    }
  }
}

module.exports = { ensureImageSchema, CREATES };
