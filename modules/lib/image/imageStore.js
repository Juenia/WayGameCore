/**
 * WayGame 图片模块 · 布局库 / 缓存索引 / 素材库（全部走 core.db，不新建连接）
 * 设计：docs/图片消息模块设计-v1.md §8
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeDoc, hashDoc } = require('./imageDoc');
const { keyVariants } = require('../templateKeys');

const DEFAULT_LAYOUT_ID = 'global/default';

function nowIso() { return new Date().toISOString(); }

// ============================ 布局库 ============================

async function listLayouts(db, filter = {}) {
  const where = [];
  const params = [];
  if (filter.room) { where.push('room = ?'); params.push(filter.room); }
  if (filter.templateKey) { where.push('template_key = ?'); params.push(filter.templateKey); }
  if (filter.enabled !== undefined) { where.push('enabled = ?'); params.push(filter.enabled ? 1 : 0); }
  if (filter.q) { where.push('(id LIKE ? OR name LIKE ?)'); params.push('%' + filter.q + '%', '%' + filter.q + '%'); }
  const sql = 'SELECT id, name, room, template_key, mode, width, height, scale, enabled, sort, updated_at FROM image_layouts' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY sort ASC, id ASC';
  const rows = await db.all(sql, params);
  return (rows || []).map((r) => ({
    id: r.id, name: r.name, room: r.room, templateKey: r.template_key, mode: r.mode,
    width: r.width, height: r.height, scale: r.scale, enabled: !!r.enabled, sort: r.sort, updatedAt: r.updated_at,
  }));
}

async function getLayoutRow(db, id) {
  if (!id) return null;
  return await db.get('SELECT * FROM image_layouts WHERE id = ?', [id]);
}

/** 取布局文档（已归一化）；不存在返回 null */
async function getLayout(db, id) {
  const row = await getLayoutRow(db, id);
  if (!row) return null;
  let raw = {};
  try { raw = JSON.parse(row.doc_json || '{}'); } catch (e) { raw = {}; }
  const { doc, warnings } = normalizeDoc(Object.assign({}, raw, {
    id: row.id, name: row.name, room: row.room, templateKey: row.template_key, mode: raw.mode || row.mode,
  }), { id: row.id, name: row.name, room: row.room, templateKey: row.template_key, width: row.width, scale: row.scale });
  if (row.width) doc.canvas.width = row.width;
  if (row.height) doc.canvas.height = row.height;
  if (row.scale) doc.canvas.scale = row.scale;
  doc.enabled = !!row.enabled;
  doc.updatedAt = row.updated_at;
  return { doc, warnings, row };
}

/**
 * 保存布局（upsert + 版本历史）
 * @param {object} db
 * @param {object} input {id,name,room,templateKey,mode,canvas,baseCss,vars,nodes,...}
 * @param {object} opts {note, author}
 */
async function saveLayout(db, input, opts = {}) {
  const id = String((input && (input.id || input.layoutId)) || '').trim();
  if (!id) return { ok: false, error: '缺少布局 id' };
  if (!/^[A-Za-z0-9_.\-/*\u4e00-\u9fa5]{1,128}$/.test(id)) return { ok: false, error: '布局 id 仅允许中英文/数字/._-/*（≤128 字）' };
  const room = String(input.room || (id.includes('/') ? id.split('/')[0] : '*'));
  const templateKey = String(input.templateKey || input.template_key || (id.includes('/') ? id.split('/').slice(1).join('/') : '*'));
  const { doc, warnings } = normalizeDoc(Object.assign({}, input, { id, room, templateKey }), { id, room, templateKey });
  const prev = await getLayoutRow(db, id);
  const docJson = JSON.stringify(doc);
  if (prev) {
    await db.run(
      'UPDATE image_layouts SET name=?, room=?, template_key=?, mode=?, width=?, height=?, scale=?, doc_json=?, enabled=?, updated_at=? WHERE id=?',
      [doc.name, room, templateKey, doc.mode, doc.canvas.width, doc.canvas.height, doc.canvas.scale, docJson,
        input.enabled === false ? 0 : 1, nowIso(), id]
    );
  } else {
    await db.run(
      'INSERT INTO image_layouts (id, name, room, template_key, mode, width, height, scale, doc_json, enabled, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, doc.name, room, templateKey, doc.mode, doc.canvas.width, doc.canvas.height, doc.canvas.scale, docJson,
        input.enabled === false ? 0 : 1, Number(input.sort) || 100, nowIso(), nowIso()]
    );
  }
  try {
    await db.run(
      'INSERT INTO image_layout_history (layout_id, doc_json, note, author, created_at) VALUES (?,?,?,?,?)',
      [id, docJson, String(opts.note || (prev ? '更新' : '新建')), String(opts.author || 'system'), nowIso()]
    );
  } catch (e) { /* 历史失败不影响保存 */ }
  return { ok: true, id, warnings, doc };
}

async function deleteLayout(db, id) {
  if (!id) return { ok: false, error: '缺少 id' };
  await db.run('DELETE FROM image_layouts WHERE id = ?', [id]);
  return { ok: true, id };
}

async function listHistory(db, id, limit = 20) {
  const rows = await db.all(
    'SELECT id, layout_id, note, author, created_at, LENGTH(doc_json) AS bytes FROM image_layout_history WHERE layout_id = ? ORDER BY id DESC LIMIT ?',
    [id, Math.max(1, Math.min(200, Number(limit) || 20))]
  );
  return rows || [];
}

async function rollback(db, id, historyId) {
  const row = await db.get('SELECT * FROM image_layout_history WHERE layout_id = ? AND id = ?', [id, historyId]);
  if (!row) return { ok: false, error: '历史版本不存在' };
  let doc = {};
  try { doc = JSON.parse(row.doc_json); } catch (e) { return { ok: false, error: '历史版本已损坏' }; }
  return await saveLayout(db, doc, { note: '回滚自 #' + historyId, author: 'rollback' });
}

/**
 * 四级绑定回退链：(room, tpl) → (room, *) → (*, tpl) → (global/default)
 * 2026-09-16 修复：tpl 现在按"模板键变体"逐个匹配（item:use.success / item.use.success / use.success …），
 * 以前只拿原样字符串比，模块返回 'item:use.success' 而布局绑的是 'use.success' → 永远回退到 global/default。
 * @returns {Promise<{doc:object, matchedId:string, level:number}|null>}
 */
async function resolveLayout(db, room, templateKey) {
  const variants = keyVariants(room, templateKey);
  const candidates = [];
  for (const v of variants) candidates.push([room, v, 1]);
  if (room) candidates.push([room, '*', 2]);
  for (const v of variants) candidates.push(['*', v, 3]);
  candidates.push(['global', 'default', 4]);
  for (const [r, k, level] of candidates) {
    const row = await db.get(
      'SELECT id FROM image_layouts WHERE room = ? AND template_key = ? AND enabled = 1 ORDER BY sort ASC, id ASC LIMIT 1',
      [r, k]
    );
    if (row) {
      const got = await getLayout(db, row.id);
      if (got) return { doc: got.doc, matchedId: row.id, level, warnings: got.warnings };
    }
  }
  return null;
}

// ============================ 种子布局 ============================

const { SEED_LAYOUTS, SEED_TEMPLATES } = require('./seedLayouts');

/** 首启写入种子布局（已存在则跳过，不覆盖用户改动） */
async function ensureSeeds(db, log) {
  const created = [];
  for (const seed of SEED_LAYOUTS) {
    try {
      const row = await getLayoutRow(db, seed.id);
      if (row) continue;
      const r = await saveLayout(db, seed, { note: '内置种子布局', author: 'seed' });
      if (r.ok) created.push(seed.id);
      else { try { if (log) log('warn', '[imageStore] 种子布局 ' + seed.id + ' 未写入：' + (r.error || '未知')); } catch (e2) {} }
    } catch (e) {
      try { if (log) log('warn', '[imageStore] 种子布局 ' + seed.id + ' 写入失败：' + e.message); } catch (e2) {}
    }
  }
  if (created.length) { try { if (log) log('info', '[imageStore] 已写入种子布局：' + created.join(', ')); } catch (e) {} }
  return created;
}

// ============================ 模板商店（P1.5） ============================

/**
 * 内置模板写入（P1.5 第五批：带版本，内置套件升级时自动覆盖内置模板，用户自建模板不动）
 * 版本标记存在 editor_settings.image_template_seed，形如 'anime-1'。
 */
async function ensureTemplateSeeds(db, log) {
  const created = [];
  const updated = [];
  const wantVersion = (require('./seedLayouts').TEMPLATE_SEED_VERSION) || '1';
  let haveVersion = '';
  try {
    const row = await db.get("SELECT value FROM editor_settings WHERE key = 'image_template_seed'");
    haveVersion = row && row.value ? String(row.value) : '';
  } catch (e) { /* editor_settings 可能还不存在 */ }
  const forceRefresh = haveVersion !== wantVersion;   // 版本不同 → 覆盖内置模板
  for (const t of SEED_TEMPLATES) {
    try {
      const row = await db.get('SELECT id FROM image_layout_template WHERE id = ?', [t.id]);
      if (row) {
        if (!forceRefresh) continue;
        // 只覆盖"内置"（非 user/ 前缀）的模板，保留用户改动
        if (String(t.id).indexOf('user/') === 0) continue;
        await db.run(
          'UPDATE image_layout_template SET name=?, category=?, description=?, doc_json=?, sort=?, enabled=1 WHERE id=?',
          [t.name, t.category || '', t.description || '', JSON.stringify(t.doc), Number(t.sort) || 100, t.id]
        );
        updated.push(t.id);
        continue;
      }
      await db.run(
        'INSERT INTO image_layout_template (id, name, category, description, doc_json, sort, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)',
        [t.id, t.name, t.category || '', t.description || '', JSON.stringify(t.doc), Number(t.sort) || 100, nowIso()]
      );
      created.push(t.id);
    } catch (e) {
      try { if (log) log('warn', '[imageStore] 模板 ' + t.id + ' 写入失败：' + e.message); } catch (e2) {}
    }
  }
  if (created.length) { try { if (log) log('info', '[imageStore] 已写入内置模板：' + created.join(', ')); } catch (e) {} }
  if (updated.length) { try { if (log) log('info', '[imageStore] 内置模板已升级到 ' + wantVersion + '：' + updated.join(', ')); } catch (e) {} }
  if (forceRefresh) {
    try {
      await db.run(
        "INSERT INTO editor_settings (key, value, updated_at) VALUES ('image_template_seed', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        [wantVersion, nowIso()]
      );
    } catch (e) { /* 标记失败下次还会再刷一遍，无害 */ }
  }
  return created.concat(updated);
}

/**
 * 消息模板预设布局写入（2026-09-16 新增）
 * 给「核心支持的每个消息模板」各建一张二次元美少女风布局，绑定到 (room, template_key)：
 * 该模板一旦在「回复模式」里选「图片」，立刻就能出这张图，不需要手工做图。
 *
 * 安全约定：
 *   - 只创建缺失的；已存在且 sort = MSG_LAYOUT_SORT（900）的视为"系统预置"可随版本升级刷新；
 *     sort 不是 900 的（用户自己改过/自己建的）一律不动。
 *   - 版本标记 editor_settings.image_message_layout_seed，只有版本变化时才刷新预置。
 *   - 跳过 ui/ 房间（那些是行/按钮片段模板，不是独立回复，不该出整图）。
 */
async function ensureMessageLayouts(db, log) {
  const seed = require('./msgLayouts');           // 2026-09-16：预置布局生成器独立成 msgLayouts.js（二次元美少女风）
  const wantVersion = seed.MSG_SEED_VERSION || '1';
  const reserveSort = Number(seed.MSG_LAYOUT_SORT) || 900;
  // 主题：editor_settings.image_msg_theme = light（默认，白底珍珠）| dark（夜空霓虹）
  let themeName = seed.DEFAULT_THEME;
  try {
    const trow = await db.get("SELECT value FROM editor_settings WHERE key = 'image_msg_theme'");
    const v = trow && trow.value ? String(trow.value).trim() : '';
    if (v && seed.THEMES && seed.THEMES[v]) themeName = v;
  } catch (e) { /* 读不到就用默认 */ }
  const created = [];
  const updated = [];
  let haveVersion = '';
  try {
    const row = await db.get("SELECT value FROM editor_settings WHERE key = 'image_message_layout_seed'");
    haveVersion = row && row.value ? String(row.value) : '';
  } catch (e) { /* editor_settings 可能还不存在 */ }
  const forceRefresh = haveVersion !== wantVersion;

  // 只给"核心真实存在的消息模板"建图，避免凭空造模板
  let rooms = [];
  try {
    const rows = await db.all('SELECT DISTINCT room, template_key FROM message_templates ORDER BY room, template_key');
    rooms = (rows || []).filter((r) => r && r.room && r.room !== 'ui' && r.template_key);
  } catch (e) {
    try { if (log) log('warn', '[imageStore] 读取 message_templates 失败，跳过消息预设：' + e.message); } catch (e2) {}
    return [];
  }
  const plans = seed.MSG_PLANS || [];
  const byKey = new Map(plans.map((p) => [p[0] + '/' + p[1], p]));

  for (const r of rooms) {
    const id = r.room + '/' + r.template_key;
    try {
      const prev = await getLayoutRow(db, id);
      if (prev) {
        if (!forceRefresh) continue;
        if (Number(prev.sort) !== reserveSort) continue;      // 用户自己动过 → 不覆盖
        const plan = byKey.get(id);
        const doc = plan ? seed.buildMsgLayout(plan, themeName) : null;
        if (!doc) continue;                                    // 该模板没有对应预设
        await db.run(
          'UPDATE image_layouts SET name=?, room=?, template_key=?, mode=?, width=?, height=?, scale=?, doc_json=?, enabled=1, updated_at=? WHERE id=?',
          [doc.name, doc.room, doc.templateKey, doc.mode, doc.canvas.width, 0, doc.canvas.scale, JSON.stringify(doc), nowIso(), id]
        );
        updated.push(id);
        continue;
      }
      const plan = byKey.get(id);
      if (!plan) continue;
      const doc = seed.buildMsgLayout(plan, themeName);
      await db.run(
        'INSERT INTO image_layouts (id, name, room, template_key, mode, width, height, scale, doc_json, enabled, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [doc.id, doc.name, doc.room, doc.templateKey, doc.mode, doc.canvas.width, 0, doc.canvas.scale, JSON.stringify(doc), 1, reserveSort, nowIso(), nowIso()]
      );
      created.push(id);
    } catch (e) {
      try { if (log) log('warn', '[imageStore] 消息预设 ' + id + ' 写入失败：' + e.message); } catch (e2) {}
    }
  }
  if (created.length) { try { if (log) log('info', '[imageStore] 已生成 ' + created.length + ' 张消息模板预设布局（主题 ' + themeName + '）：' + created.slice(0, 8).join(', ') + (created.length > 8 ? ' 等' : '')); } catch (e) {} }
  if (updated.length) { try { if (log) log('info', '[imageStore] 消息预设布局已升级到 ' + wantVersion + '：' + updated.length + ' 张'); } catch (e) {} }
  if (forceRefresh) {
    try {
      await db.run(
        "INSERT INTO editor_settings (key, value, updated_at) VALUES ('image_message_layout_seed', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        [wantVersion, nowIso()]
      );
    } catch (e) { /* 标记失败下次还会刷一遍，无害 */ }
  }
  return created.concat(updated);
}

async function listTemplates(db, filter = {}) {
  const where = [];
  const params = [];
  if (filter.category) { where.push('category = ?'); params.push(filter.category); }
  if (filter.q) { where.push('(id LIKE ? OR name LIKE ? OR description LIKE ?)'); params.push('%' + filter.q + '%', '%' + filter.q + '%', '%' + filter.q + '%'); }
  const sql = 'SELECT id, name, category, description, sort, enabled, created_at, LENGTH(doc_json) AS bytes FROM image_layout_template' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY sort ASC, id ASC';
  const rows = await db.all(sql, params);
  return (rows || []).map((r) => ({
    id: r.id, name: r.name, category: r.category, description: r.description,
    sort: r.sort, bytes: r.bytes, createdAt: r.created_at,
  }));
}

async function getTemplate(db, id) {
  const row = await db.get('SELECT * FROM image_layout_template WHERE id = ?', [id]);
  if (!row) return null;
  let doc = {};
  try { doc = JSON.parse(row.doc_json || '{}'); } catch (e) { doc = {}; }
  return { id: row.id, name: row.name, category: row.category, description: row.description, doc: doc };
}

/** 把当前布局存成模板 */
async function saveTemplate(db, input = {}, opts = {}) {
  const id = String(input.id || ('user/' + Date.now().toString(36))).trim();
  const name = String(input.name || (input.doc && input.doc.name) || id);
  const doc = input.doc && typeof input.doc === 'object' ? input.doc : null;
  if (!doc) return { ok: false, error: '缺少 doc' };
  const { doc: normalized, warnings } = normalizeDoc(Object.assign({}, doc), { id: doc.id });
  // 版本管理：覆盖已有模板前，把旧版存进历史
  try {
    const prev = await db.get('SELECT doc_json FROM image_layout_template WHERE id = ?', [id]);
    if (prev && prev.doc_json) {
      await db.run('INSERT INTO image_layout_template_history (template_id, doc_json, note, created_at) VALUES (?,?,?,?)',
        [id, prev.doc_json, String(opts.note || '覆盖前留档'), nowIso()]);
    }
  } catch (e) { /* 历史失败不影响保存 */ }
  await db.run(
    'INSERT INTO image_layout_template (id, name, category, description, doc_json, sort, enabled, created_at) VALUES (?,?,?,?,?,?,1,?) ' +
    'ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, description=excluded.description, doc_json=excluded.doc_json',
    [id, name, String(input.category || '我的模板'), String(input.description || opts.note || ''), JSON.stringify(normalized), Number(input.sort) || 500, nowIso()]
  );
  return { ok: true, id, warnings };
}

async function deleteTemplate(db, id) {
  await db.run('DELETE FROM image_layout_template WHERE id = ?', [id]);
  await db.run('DELETE FROM image_layout_template_history WHERE template_id = ?', [id]);
  return { ok: true, id };
}

/** 模板版本历史（覆盖保存时自动留档） */
async function listTemplateHistory(db, id, limit = 20) {
  const rows = await db.all(
    'SELECT id, template_id, note, created_at, LENGTH(doc_json) AS bytes FROM image_layout_template_history WHERE template_id = ? ORDER BY id DESC LIMIT ?',
    [String(id), Math.max(1, Math.min(100, Number(limit) || 20))]
  );
  return rows || [];
}

/** 回滚模板到某个历史版本（当前版本也会先留档） */
async function rollbackTemplate(db, id, historyId) {
  const row = await db.get('SELECT * FROM image_layout_template_history WHERE template_id = ? AND id = ?', [String(id), historyId]);
  if (!row) return { ok: false, error: '历史版本不存在' };
  let doc = null;
  try { doc = JSON.parse(row.doc_json); } catch (e) { return { ok: false, error: '历史版本已损坏' }; }
  const cur = await getTemplate(db, id);
  return await saveTemplate(db, {
    id: id,
    name: cur ? cur.name : id,
    category: cur ? cur.category : '我的模板',
    description: cur ? cur.description : '',
    doc: doc,
  }, { note: '回滚自 #' + historyId });
}

/** 用模板新建一份布局（返回新布局文档，交由调用方保存或直接编辑） */
async function applyTemplate(db, key, newId) {
  const t = await getTemplate(db, key);
  if (!t) return { ok: false, error: '模板不存在：' + key };
  const base = (t.doc && t.doc.id) || 'layout';
  const id = String(newId || (base + '-' + Date.now().toString(36).slice(-4)));
  const room = id.includes('/') ? id.split('/')[0] : 'layout';
  const templateKey = id.includes('/') ? id.split('/').slice(1).join('/') : '*';
  const doc = Object.assign({}, t.doc, { id: id, name: (t.name || id) + ' 副本', room: room, templateKey: templateKey });
  return { ok: true, id: id, doc: doc, template: { id: t.id, name: t.name } };
}

// ============================ 渲染缓存索引 ============================

async function cacheGet(db, hash) {
  if (!hash) return null;
  const row = await db.get('SELECT * FROM image_render_cache WHERE hash = ?', [hash]);
  if (!row) return null;
  if (!row.path || !fs.existsSync(row.path)) {
    await db.run('DELETE FROM image_render_cache WHERE hash = ?', [hash]).catch(() => {});
    return null;
  }
  return row;
}

async function cacheTouch(db, hash) {
  try {
    await db.run('UPDATE image_render_cache SET hits = hits + 1, last_used_at = ? WHERE hash = ?', [nowIso(), hash]);
  } catch (e) { /* 统计失败不影响出图 */ }
}

/**
 * 批量累加命中计数（2026-09-20 加）
 * 原来每次命中都单独 UPDATE 一次 —— 高频命中时就是持续的小写入（WAL 写放大）。
 * 调用方（imageModule）把命中攒起来每 5 秒 flush 一次，这里一次写多个。
 */
async function cacheTouchN(db, hash, n) {
  const k = Math.max(1, Number(n) || 1);
  try {
    await db.run('UPDATE image_render_cache SET hits = hits + ?, last_used_at = ? WHERE hash = ?', [k, nowIso(), hash]);
  } catch (e) { /* 统计失败不影响出图 */ }
}

async function cachePut(db, row) {
  const t = nowIso();
  await db.run(
    'INSERT INTO image_render_cache (hash, layout_id, path, bytes, width, height, hits, created_at, last_used_at) VALUES (?,?,?,?,?,?,0,?,?) ' +
    'ON CONFLICT(hash) DO UPDATE SET path=excluded.path, bytes=excluded.bytes, width=excluded.width, height=excluded.height, last_used_at=excluded.last_used_at',
    [row.hash, row.layoutId || '', row.path, row.bytes || 0, row.width || 0, row.height || 0, t, t]
  );
}

async function invalidate(db, layoutId, cacheDir) {
  let rows;
  if (layoutId) rows = await db.all('SELECT hash, path FROM image_render_cache WHERE layout_id = ?', [layoutId]);
  else rows = await db.all('SELECT hash, path FROM image_render_cache');
  let n = 0;
  for (const r of rows || []) {
    try { if (r.path) fs.unlinkSync(r.path); } catch (e) {}
    try { await db.run('DELETE FROM image_render_cache WHERE hash = ?', [r.hash]); n++; } catch (e) {}
  }
  void cacheDir;
  return { ok: true, removed: n };
}

async function cacheStats(db, cacheDir) {
  const row = await db.get('SELECT COUNT(1) AS n, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(hits),0) AS hits FROM image_render_cache');
  let diskBytes = 0;
  let files = 0;
  try {
    if (cacheDir && fs.existsSync(cacheDir)) {
      for (const f of fs.readdirSync(cacheDir)) {
        try { diskBytes += fs.statSync(path.join(cacheDir, f)).size; files++; } catch (e) {}
      }
    }
  } catch (e) { /* 目录不存在 */ }
  return { rows: (row && row.n) || 0, bytes: (row && row.bytes) || 0, hits: (row && row.hits) || 0, diskFiles: files, diskBytes };
}

/** LRU + TTL 清理：超过 maxBytes 按 last_used_at 从旧到新删；超过 ttlDays 一律删 */
async function cacheSweep(db, opts = {}) {
  const maxBytes = Math.max(0, Number(opts.maxBytes) || 0);
  const ttlDays = Math.max(0, Number(opts.ttlDays) || 0);
  let removed = 0, freed = 0;
  if (ttlDays > 0) {
    const cutoff = new Date(Date.now() - ttlDays * 86400_000).toISOString();
    const rows = await db.all('SELECT hash, path, bytes FROM image_render_cache WHERE last_used_at < ?', [cutoff]);
    for (const r of rows || []) {
      try { if (r.path) fs.unlinkSync(r.path); } catch (e) {}
      try { await db.run('DELETE FROM image_render_cache WHERE hash = ?', [r.hash]); } catch (e) {}
      removed++; freed += r.bytes || 0;
    }
  }
  if (maxBytes > 0) {
    const total = await db.get('SELECT COALESCE(SUM(bytes),0) AS bytes FROM image_render_cache');
    let bytes = (total && total.bytes) || 0;
    if (bytes > maxBytes) {
      const rows = await db.all('SELECT hash, path, bytes FROM image_render_cache ORDER BY last_used_at ASC');
      for (const r of rows || []) {
        if (bytes <= maxBytes * 0.8) break;
        try { if (r.path) fs.unlinkSync(r.path); } catch (e) {}
        try { await db.run('DELETE FROM image_render_cache WHERE hash = ?', [r.hash]); } catch (e) {}
        bytes -= (r.bytes || 0); removed++; freed += r.bytes || 0;
      }
    }
  }
  return { removed, freed };
}

/** describe：由图片引用（绝对路径）反查元数据，供 server.js 组装 image 字段 */
async function describeRef(db, ref) {
  if (!ref || typeof ref !== 'string') return null;
  const r = await db.get('SELECT * FROM image_render_cache WHERE path = ? LIMIT 1', [ref]);
  if (!r) {
    // 兼容相对路径 / file:// 写法
    const p2 = ref.replace(/^file:\/\/\//, '').replace(/\\/g, '/');
    const r2 = await db.get('SELECT * FROM image_render_cache WHERE REPLACE(path, char(92), \'/\') = ? LIMIT 1', [p2]);
    if (!r2) return null;
    return { hash: r2.hash, path: r2.path, bytes: r2.bytes, width: r2.width, height: r2.height, cached: true };
  }
  return { hash: r.hash, path: r.path, bytes: r.bytes, width: r.width, height: r.height, cached: true };
}

// ============================ 素材库 ============================

async function listAssets(db) {
  const rows = await db.all('SELECT id, name, mime, path, bytes, width, height, tags, group_name, created_at FROM image_assets ORDER BY group_name ASC, created_at DESC');
  return rows || [];
}

/** 素材引用检查：扫描所有布局的 doc_json，找出引用了该素材的布局（删除前提示用） */
async function findAssetUsage(db, assetId) {
  const needle = 'asset:' + String(assetId);
  const rows = await db.all('SELECT id, name, doc_json FROM image_layouts');
  const used = [];
  for (const r of rows || []) {
    if (r && typeof r.doc_json === 'string' && r.doc_json.indexOf(needle) >= 0) used.push({ id: r.id, name: r.name });
  }
  return used;
}

async function getAsset(db, id) {
  return await db.get('SELECT * FROM image_assets WHERE id = ?', [id]);
}

async function addAsset(db, row) {
  await db.run(
    'INSERT INTO image_assets (id, name, mime, path, bytes, width, height, sha256, tags, group_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET name=excluded.name, mime=excluded.mime, path=excluded.path, bytes=excluded.bytes, width=excluded.width, height=excluded.height, sha256=excluded.sha256, tags=excluded.tags, group_name=excluded.group_name',
    [row.id, row.name, row.mime || 'image/png', row.path, row.bytes || 0, row.width || 0, row.height || 0, row.sha256 || '', row.tags || '', row.group_name || '', nowIso()]
  );
  return { ok: true, id: row.id };
}

/** 设置素材标签（不做校验，编辑器/设计器负责规范化） */
async function setAssetTags(db, id, tags) {
  await db.run('UPDATE image_assets SET tags = ? WHERE id = ?', [String(tags || ''), String(id)]);
  return { ok: true, id };
}

/** 设置素材分组（单层文件夹；空串 = 未分组） */
async function setAssetGroup(db, id, group) {
  await db.run('UPDATE image_assets SET group_name = ? WHERE id = ?', [String(group || ''), String(id)]);
  return { ok: true, id };
}

async function deleteAsset(db, id) {
  const row = await getAsset(db, id);
  if (!row) return { ok: false, error: '素材不存在' };
  try { if (row.path) fs.unlinkSync(row.path); } catch (e) {}
  await db.run('DELETE FROM image_assets WHERE id = ?', [id]);
  return { ok: true, id };
}

module.exports = {
  ensureMessageLayouts,
  DEFAULT_LAYOUT_ID,
  ensureSeeds, listLayouts, getLayout, getLayoutRow, saveLayout, deleteLayout, listHistory, rollback, resolveLayout,
  ensureTemplateSeeds, listTemplates, getTemplate, saveTemplate, deleteTemplate, applyTemplate,
  cacheGet, cachePut, cacheTouch, cacheTouchN, cacheStats, cacheSweep, invalidate, describeRef,
  listAssets, getAsset, addAsset, deleteAsset, setAssetTags, setAssetGroup, findAssetUsage,
  listTemplateHistory, rollbackTemplate,
  hashDoc,
};
