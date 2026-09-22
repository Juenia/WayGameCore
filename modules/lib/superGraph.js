/**
 * 图 IR 缓存（2026-09-18 S2 从 superModule 搬出）
 * ------------------------------------------------------------------
 * 以前【每次执行】都 JSON.parse(logic.graph) 一遍 —— 高频逻辑（每秒被触发多次）
 * 与几百节点的大图都要白付这份解析开销。
 * 安全性：runGraph 只读图（建索引/遍历边），运行期不改图；图一变字符串就变，旧条目由 LRU 淘汰。
 */
'use strict';

function createGraphCache(limit) {
  const max = Number(limit) > 0 ? Number(limit) : 300;
  const cache = new Map();   // graph 字符串 -> IR
  let parseCount = 0;        // 统计用（测试断言「同一份图只解析一次」）
  function parse(str) {
    const key = String(str == null ? '' : str) || '{"nodes":[],"edges":[]}';
    const hit = cache.get(key);
    if (hit) return hit;
    const ir = JSON.parse(key);
    parseCount++;
    if (cache.size >= max) { const oldest = cache.keys().next().value; cache.delete(oldest); }
    cache.set(key, ir);
    return ir;
  }
  return { parse, stats: () => ({ parseCount, cached: cache.size }), clear: () => cache.clear(), size: () => cache.size };
}

module.exports = { createGraphCache };
