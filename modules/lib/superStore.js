/**
 * 存储层（2026-09-18 S2 · 从 superModule 巨型闭包里搬出的第二层）
 * ------------------------------------------------------------------
 * 只管三件事：
 *   ① 逻辑定义（custom_logic 行）的读取 + TTL 缓存
 *   ② .way 多文件工程的文件表（custom_logic_file）
 *   ③ 运行历史（custom_logic_run）的写入与保留策略
 * 所有 SQL 都从这里出去；运行时/应答层不直接碰 db。
 * 行为零变更：SQL 语句、参数、语义与搬迁前逐字一致。
 */
'use strict';

function createStore(opts) {
  const o = opts || {};
  const db = o.db;
  const ttl = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : 2000;
  const keepCount = Number(o.keepCount) > 0 ? Number(o.keepCount) : 2000;
  const keepDays = Number(o.keepDays) > 0 ? Number(o.keepDays) : 30;
  const cache = new Map();   // key -> { row, at }

  async function getLogic(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.row;
    const row = await db.get('SELECT * FROM custom_logic WHERE key = ?', [key]);
    if (row) cache.set(key, { row, at: Date.now() });
    return row;
  }

  /** .way 工程的文件表（key → { 文件名: 内容 }）；一条逻辑没文件时返回空对象，编译层会报「找不到 main.way」 */
  async function loadWayFiles(key) {
    const rows = await db.all('SELECT name, content FROM custom_logic_file WHERE logic_key = ? ORDER BY sort, name', [key]);
    const out = {};
    for (const r0 of (rows || [])) out[String(r0.name)] = String(r0.content == null ? '' : r0.content);
    return out;
  }

  function clearCache() { cache.clear(); }
  /** 单条失效（保存/删除/改触发词时由上层调用）；核心的 triggers.clearRegexCache 由上层一并处理 */
  function invalidate(key) { if (key) cache.delete(key); else cache.clear(); }

  async function writeRun(key, playerId, source, durationMs, steps, errorText, ok, args, code) {
    try {
      await db.run('INSERT INTO custom_logic_run (key, player_id, trigger_source, duration_ms, steps, ok, error, error_code, args_json) VALUES (?,?,?,?,?,?,?,?,?)',
        [key, playerId, source, durationMs, steps, ok ? 1 : 0, errorText || '', code || (ok ? '' : 'E_RUNTIME'), JSON.stringify(args || [])]);
    } catch (e) { /* 历史写入失败不影响主流程 */ }
  }

  /** 保留策略：全局 N 条 + M 天（每次核心启动清理一次） */
  async function pruneRuns() {
    try {
      await db.run('DELETE FROM custom_logic_run WHERE id IN (SELECT id FROM custom_logic_run ORDER BY id DESC LIMIT -1 OFFSET ' + keepCount + ')');
      await db.run("DELETE FROM custom_logic_run WHERE created_at < datetime('now', '-" + keepDays + " days')");
    } catch (e) { /* 幂等 */ }
  }

  return { getLogic, loadWayFiles, clearCache, invalidate, writeRun, pruneRuns, cacheSize: () => cache.size };
}

module.exports = { createStore };
