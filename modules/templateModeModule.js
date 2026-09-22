/**
 * WayGame · 消息模板回复模式（每个模板单独切换：纯文本 / Markdown / 图片）
 * 需求（2026-09-16）：全局只有一档 message_mode（1 纯文本 / 2 Markdown / 3 图片），
 * 但运营上常见的是"物品详情出图、公告走 Markdown、系统提示纯文本"混着来。
 * 本模块给「每个消息模板」加一档独立开关，覆盖全局设置，不动核心一行代码。
 *
 * ── 存储 ────────────────────────────────────────────────────────────────
 *   editor_settings.template_modes（JSON，键 = room.template_key）
 *   { "item.use": { "mode": 3, "layout": "", "updatedAt": "2026-09-16T..." } }
 *   mode：0 / 缺省 = 跟随全局；1 = 纯文本；2 = Markdown；3 = 图片
 *   layout：可选，指定 image_layouts.id；留空则走图片模块的四级绑定回退链
 *           (room,tpl) → (room,*) → (*,tpl) → global/default
 *
 * ── 生效点 ──────────────────────────────────────────────────────────────
 *   server.js 的两个消息出口（/api/bee/message、/api/command）在核心渲染完之后调用 apply()：
 *     - mode=1/2：换另一份文案（text_content / markdown_content）重新渲染，type 改成 text/markdown
 *     - mode=3 ：复用图片模块已注册的 'image' 渲染器出图（缓存/降级/explain 全部照旧），type 改成 image
 *   为什么放 server.js：核心只在 handlerResult.type === 'image' 时透传 type，要让"每个模板不同类型"
 *   生效就得改 GameSystem.js；而 server.js 本来就是消息出口，改动面最小（遵守项目约定不动核心）。
 *
 * ── 其它 ────────────────────────────────────────────────────────────────
 *   写库后 2 秒内生效（进程内缓存）；编辑器 / HTTP 两侧都可写，写的是同一行 settings。
 *   对外 API：core.services.templateMode.{list,get,set,remove,apply,preview,status}
 */
'use strict';

const fs = require('fs');
const { keyVariants, canonicalKey } = require('./lib/templateKeys');

const SETTINGS_KEY = 'template_modes';
const CACHE_MS = 2000;
const MODE_AUTO = 0, MODE_TEXT = 1, MODE_MARKDOWN = 2, MODE_IMAGE = 3;
const MODE_LABEL = { 0: '跟随全局', 1: '纯文本', 2: 'Markdown', 3: '图片' };

function clampMode(v) {
  const n = parseInt(v, 10);
  return (n === 1 || n === 2 || n === 3) ? n : 0;
}
function str(v, def) { return (v === null || v === undefined || v === '') ? (def === undefined ? '' : def) : String(v); }

function templateModeModule(core) {
  const state = { at: 0, map: null, raw: null, lastError: '', hits: 0, misses: 0, lastApplied: null };

  /** "room.key" 规范键（详见 modules/lib/templateKeys.js） */
  function normKey(room, key) { return canonicalKey(room, key); }

  /** 写入前规范化：'item:use.success' → 'item.use.success'（冒号形式统一成点号） */
  function normalizeInputKey(k) {
    const s = str(k).trim();
    if (!s) return '';
    if (s.indexOf(':') >= 0) { const p = s.split(':'); return canonicalKey(p[0], p.slice(1).join(':')); }
    return s;
  }

  // ============================ 读写 ============================
  async function loadMap(force) {
    if (!force && state.map && Date.now() - state.at < CACHE_MS) return state.map;
    let raw = '';
    try {
      const row = await core.db.get('SELECT value FROM editor_settings WHERE key = ?', [SETTINGS_KEY]);
      raw = row ? str(row.value) : '';
    } catch (e) {
      state.lastError = '读取 ' + SETTINGS_KEY + ' 失败：' + e.message;
      return state.map || {};
    }
    if (state.map && raw === state.raw) { state.at = Date.now(); return state.map; }
    const map = {};
    if (raw) {
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          Object.keys(o).forEach(function (k) {
            const v = (o[k] && typeof o[k] === 'object') ? o[k] : {};
            const mode = clampMode(v.mode);
            if (!k || !mode) return;
            map[k] = { mode: mode, layout: str(v.layout), updatedAt: str(v.updatedAt) };
          });
        } else {
          state.lastError = SETTINGS_KEY + ' 不是对象，已忽略';
        }
      } catch (e) {
        state.lastError = SETTINGS_KEY + ' 解析失败：' + e.message;
      }
    }
    state.map = map;
    state.raw = raw;
    state.at = Date.now();
    return map;
  }

  async function saveMap(map) {
    const clean = {};
    Object.keys(map || {}).forEach(function (k) {
      const v = map[k] || {};
      const mode = clampMode(v.mode);
      if (!k || !mode) return;              // mode=0 视为删除
      clean[k] = { mode: mode, layout: str(v.layout), updatedAt: str(v.updatedAt, new Date().toISOString()) };
    });
    const raw = JSON.stringify(clean);
    const now = new Date().toISOString();
    await core.db.run('INSERT OR REPLACE INTO editor_settings (key, value, updated_at) VALUES (?, ?, ?)', [SETTINGS_KEY, raw, now]);
    state.map = clean;
    state.raw = raw;
    state.at = Date.now();
    return { ok: true, map: clean, bytes: raw.length, updatedAt: now };
  }

  async function list() {
    const map = await loadMap(true);
    return Object.keys(map).sort().map(function (k) { return { key: k, mode: map[k].mode, label: MODE_LABEL[map[k].mode], layout: map[k].layout, updatedAt: map[k].updatedAt }; });
  }
  async function get(key) {
    const map = await loadMap();
    const hit = map[str(key)];
    return hit ? { key: str(key), mode: hit.mode, label: MODE_LABEL[hit.mode], layout: hit.layout, updatedAt: hit.updatedAt } : null;
  }
  async function set(input) {
    const o = input || {};
    const key = normalizeInputKey(o.key);
    if (!key) return { ok: false, error: '缺少模板键（room.template_key）' };
    const mode = clampMode(o.mode);
    const map = Object.assign({}, await loadMap(true));
    if (!mode) delete map[key];
    else map[key] = { mode: mode, layout: str(o.layout), updatedAt: new Date().toISOString() };
    return await saveMap(map);
  }
  async function setMany(items) {
    const map = Object.assign({}, await loadMap(true));
    (Array.isArray(items) ? items : []).forEach(function (o) {
      const key = normalizeInputKey(o && o.key);
      if (!key) return;
      const mode = clampMode(o.mode);
      if (!mode) delete map[key];
      else map[key] = { mode: mode, layout: str(o.layout), updatedAt: new Date().toISOString() };
    });
    return await saveMap(map);
  }
  async function remove(key) { return await set({ key: key, mode: 0 }); }

  // ============================ 解析与生效 ============================
  /** 找到模板对应的模式配置（键按 templatesKeys 的变体规则逐个尝试，冒号/点号/短名/去房间前缀都认） */
  async function resolve(result) {
    if (!result || typeof result !== 'object') return null;
    const room = str(result.moduleName || (result.door && result.door.room));
    const tpl = str(result.templateName || (result.data && result.data.templateKey));
    if (!room && !tpl) return null;
    const map = await loadMap();
    if (!Object.keys(map).length) return null;
    const variants = keyVariants(room, tpl);
    const short = tpl ? tpl.replace(/:/g, '.').split('.').pop() : '';
    const cands = [];
    const push = function (k) { if (k && cands.indexOf(k) < 0) cands.push(k); };
    variants.forEach(function (v) { push(normalizeInputKey(v)); push(canonicalKey(room, v)); push(v); });
    if (short && short !== tpl) { push(room ? room + '.' + short : ''); push(short); }
    for (let i = 0; i < cands.length; i++) {
      const hit = map[cands[i]];
      if (hit && hit.mode) {
        return { key: cands[i], room: room, tplKey: tpl, shortKey: short, mode: hit.mode, layout: hit.layout, label: MODE_LABEL[hit.mode] };
      }
    }
    return null;
  }

  /** 取 DB 模板行（键变体与核心 handleCommand 的 DB-FIRST 变体一致） */
  async function fetchRow(room, tplKey, shortKey) {
    const cands = [];
    const push = function (r, k) { if (r && k && !cands.some(function (c) { return c[0] === r && c[1] === k; })) cands.push([r, k]); };
    keyVariants(room, tplKey).forEach(function (v) {
      push(room, v);
      // 跨房间（system.xxx 之类）：核心在 (room, k) 未命中时会换 k 的前缀当房间
      if (v.indexOf('.') >= 0) { const p = v.split('.'); if (p[0] && p[0] !== room) push(p[0], p.slice(1).join('.')); }
    });
    if (shortKey) push(room, shortKey);
    for (let i = 0; i < cands.length; i++) {
      try { const row = await core.db.getMessageTemplate(cands[i][0], cands[i][1]); if (row) return row; } catch (e) { /* 继续 */ }
    }
    return null;
  }

  /** 重建模板渲染数据（对齐核心 _formatResponse 的 finalRenderData） */
  function buildData(result, hit, extra) {
    const ctx = extra || {};
    let args = ctx.args;
    if (!Array.isArray(args) && ctx.rawText && typeof core._parseCommand === 'function') {
      try { args = core._parseCommand(String(ctx.rawText)).args || []; } catch (e) { args = []; }
    }
    return Object.assign({
      playerId: ctx.playerId || null,
      args: args || [],
      commandName: ctx.commandName || '',
      trigger: ctx.commandName || '',
      logicalName: result.door || '',
      moduleName: hit.room || '',
      templateKey: hit.tplKey || '',
      templateName: hit.tplKey || '',
      handlerResultData: result.data || {},
    }, result.data || {});
  }

  /** 换文案：text_content / markdown_content 重新渲染 */
  async function renderFlavor(result, playerId, hit, want, data) {
    const row = await fetchRow(hit.room, hit.tplKey, hit.shortKey);
    if (!row) return null;
    const tpl = want === MODE_MARKDOWN
      ? str(row.markdown_content) || str(row.text_content)
      : str(row.text_content) || str(row.markdown_content);
    if (!tpl) return null;
    const content = await core.renderTemplate(tpl, data, { escape: want === MODE_TEXT }, playerId || null, hit.tplKey || null);
    result.content = content;
    result.type = want === MODE_MARKDOWN ? 'markdown' : 'text';
    result.templateMode = { mode: want, label: MODE_LABEL[want], key: hit.key, layout: '', applied: 'flavor' };
    return result;
  }

  /** 出图：复用 image 模块已注册的渲染器（缓存/降级/explain 与全局图片模式完全一致） */
  async function renderImage(result, playerId, hit, data) {
    const api = core.services && core.services.image;
    const renderer = core.messageTypes.get('image');
    if (!api || typeof renderer !== 'function') return null;
    const row = await fetchRow(hit.room, hit.tplKey, hit.shortKey);
    const tplKeyForImage = str(result.templateName) || hit.tplKey || hit.shortKey || '*';
    const ctx = {
      playerId: playerId || null,
      moduleName: hit.room || '*',
      templateKey: tplKeyForImage,
      templateName: tplKeyForImage,
      handlerResultData: result.data || {},
      message: { data: result.data || {} },
      args: data.args,
      commandName: data.commandName,
      logicalName: data.logicalName,
      data: data,
    };
    // 指定布局：直接渲染那张图，正文作为 {消息}
    if (hit.layout) {
      let body = str(result.content);
      if (row) {
        try {
          const t = str(row.markdown_content) || str(row.text_content);
          if (t) body = await core.renderTemplate(t, data, { escape: false }, playerId || null, tplKeyForImage);
        } catch (e) { /* 用核心已渲染的 content */ }
      }
      const r = await api.render(hit.layout, { playerId: playerId || null, templateKey: tplKeyForImage, room: hit.room, data: Object.assign({}, data, { 消息: body }) });
      if (!r || !r.ok) {
        core.log('warn', '[templateMode] 模板 ' + hit.key + ' 指定布局 ' + hit.layout + ' 出图失败（' + ((r && (r.reason || r.error)) || '未知') + '），保持原文案');
        return null;
      }
      result.content = r.content;
      result.type = 'image';
      result.templateMode = { mode: MODE_IMAGE, label: MODE_LABEL[MODE_IMAGE], key: hit.key, layout: hit.layout, applied: 'layout' };
      return result;
    }
    // 未指定布局：交给图片模块的渲染器（它自己会做四级绑定回退 + 失败降级登记）
    const tpl = row
      ? { text: str(row.text_content), markdown: str(row.markdown_content) || str(row.text_content) }
      : { text: str(result.content), markdown: str(result.content) };
    const content = await renderer(tpl, ctx);
    if (!content) return null;
    result.content = content;
    result.type = 'image';
    result.templateMode = { mode: MODE_IMAGE, label: MODE_LABEL[MODE_IMAGE], key: hit.key, layout: '', applied: 'renderer' };
    return result;
  }

  /**
   * 按模板配置改写一条回复结果
   * @param {object} result 核心 handleCommand 的返回（会被就地改写并返回）
   * @param {string} playerId
   * @param {object} [ctx] { rawText, args, commandName }
   */
  async function apply(result, playerId, ctx) {
    if (!result || typeof result !== 'object') return result;
    let hit = null;
    try { hit = await resolve(result); } catch (e) { core.log('warn', '[templateMode] 解析失败：' + e.message); return result; }
    if (!hit) return result;
    const want = hit.mode;
    const current = str(result.type, 'text');
    const wantType = want === MODE_IMAGE ? 'image' : (want === MODE_MARKDOWN ? 'markdown' : 'text');
    if (current === wantType) {                    // 已经就是目标类型，不必重复渲染
      result.templateMode = { mode: want, label: hit.label, key: hit.key, layout: hit.layout, applied: 'noop' };
      state.hits++;
      return result;
    }
    try {
      const data = buildData(result, hit, Object.assign({ playerId: playerId }, ctx || {}));
      const out = want === MODE_IMAGE
        ? await renderImage(result, playerId, hit, data)
        : await renderFlavor(result, playerId, hit, want, data);
      if (!out) { state.misses++; return result; }
      state.hits++;
      state.lastApplied = { at: Date.now(), key: hit.key, mode: want, type: out.type, playerId: str(playerId) };
      try { core.log('info', '[templateMode] 模板 ' + hit.key + ' 按「' + hit.label + '」回复 → type=' + out.type); } catch (e) {}
      return out;
    } catch (e) {
      state.misses++;
      try { core.log('warn', '[templateMode] 模板 ' + hit.key + ' 按「' + hit.label + '」回复失败，沿用原结果：' + e.message); } catch (e2) {}
      return result;
    }
  }

  /** 干跑预览（编辑器「试一下」用）：不改库、不入队，只返回会发出去的东西 */
  async function preview(input) {
    const o = input || {};
    const room = str(o.room);
    const tplKey = str(o.key || o.templateKey);
    const key = canonicalKey(room, tplKey);
    if (!tplKey) return { ok: false, error: '缺少模板键' };
    const map = await loadMap(true);
    const conf = map[key] || map[tplKey] || null;
    const mode = clampMode(o.mode !== undefined && o.mode !== null && o.mode !== '' ? o.mode : (conf ? conf.mode : 0));
    const layout = o.layout !== undefined && o.layout !== null ? str(o.layout) : (conf ? conf.layout : '');
    const row = await fetchRow(room, tplKey, tplKey.split('.').pop());
    if (!mode) {
      const globalMode = (core.getMessageMode && core.getMessageMode()) || 1;
      return {
        ok: true, key: key, mode: 0, label: MODE_LABEL[0], globalMode: globalMode,
        type: globalMode === 3 ? 'image' : (globalMode === 2 ? 'markdown' : 'text'),
        content: row ? (globalMode === 2 ? (str(row.markdown_content) || str(row.text_content)) : (str(row.text_content) || str(row.markdown_content))) : '',
        note: '该模板没有单独设置，跟随全局（当前 ' + MODE_LABEL[globalMode] + '）',
      };
    }
    const demo = Object.assign({}, (o.data && typeof o.data === 'object') ? o.data : {});
    try {
      if (o.playerId && core.getPlayer) {
        const p = core.getPlayer(o.playerId);
        if (p) Object.keys(p).forEach(function (k) { if (demo[k] === undefined) demo[k] = p[k]; });
      }
    } catch (e) { /* 预览数据拿不到就算了 */ }
    const fake = { type: 'text', content: '', templateName: tplKey, moduleName: room, data: demo, door: '' };
    const hit = { key: key, room: room, tplKey: tplKey, shortKey: tplKey.split('.').pop(), mode: mode, layout: layout, label: MODE_LABEL[mode] };
    const data = buildData(fake, hit, { playerId: str(o.playerId) });
    const out = await (mode === MODE_IMAGE ? renderImage(fake, str(o.playerId) || null, hit, data) : renderFlavor(fake, str(o.playerId) || null, hit, mode, data));
    if (!out) {
      return { ok: false, key: key, mode: mode, label: MODE_LABEL[mode], error: mode === MODE_IMAGE ? '出图失败（原因见核心日志；布局缺失或渲染子进程不可用）' : '模板行不存在（message_templates 里没有这个键）' };
    }
    const res = { ok: true, key: key, mode: mode, label: MODE_LABEL[mode], type: out.type, content: out.content, hasRow: !!row };
    if (out.type === 'image' && core.services && core.services.image) {
      try {
        const meta = await core.services.image.describe(out.content, {});
        if (meta) {
          res.image = meta;
          if (!res.image.base64 && res.image.path) {
            try { res.image.base64 = await fs.promises.readFile(res.image.path, { encoding: 'base64' }); } catch (e) { /* 读不到就算了 */ }
          }
        }
      } catch (e) { /* 元数据拿不到不影响预览 */ }
    }
    return res;
  }

  async function status() {
    const map = await loadMap(true);
    return {
      key: SETTINGS_KEY,
      count: Object.keys(map).length,
      globalMode: (core.getMessageMode && core.getMessageMode()) || 1,
      labels: MODE_LABEL,
      hits: state.hits,
      misses: state.misses,
      lastApplied: state.lastApplied,
      lastError: state.lastError,
    };
  }

  const api = {
    MODE: { AUTO: MODE_AUTO, TEXT: MODE_TEXT, MARKDOWN: MODE_MARKDOWN, IMAGE: MODE_IMAGE },
    MODE_LABEL: MODE_LABEL,
    SETTINGS_KEY: SETTINGS_KEY,
    normKey: normKey,
    list: list,
    get: get,
    set: set,
    setMany: setMany,
    remove: remove,
    resolve: resolve,
    apply: apply,
    preview: preview,
    invalidate: function () { state.map = null; state.raw = null; state.at = 0; return true; },
    status: status,
  };

  if (!core.services) core.services = {};
  core.services.templateMode = api;
  core.templateMode = api;

  try {
    list().then(function (l) { core.log('info', '[templateMode] 已加载：' + l.length + ' 个模板单独指定了回复模式' + (l.length ? '（' + l.slice(0, 6).map(function (x) { return x.key + '=' + x.label; }).join('、') + (l.length > 6 ? ' 等' : '') + '）' : '')); });
  } catch (e) { /* 启动日志失败不影响功能 */ }

  return Object.assign({ moduleName: 'templateMode' }, api);
}

templateModeModule.moduleName = 'templateMode';
templateModeModule.dependencies = ['database'];
module.exports = templateModeModule;
