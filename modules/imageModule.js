/**
 * WayGame 图片消息自绘模块（P0 运行链路）
 * 设计：docs/图片消息模块设计-v1.md ；DSL：docs/图片消息模块-排版DSL-v1.md
 *
 * 能力：
 *   1) 核心「图片模式」（message_mode=3）下，接管 type='image' 渲染器，把回复渲染成 PNG
 *   2) 模块显式 return { type:'image' } 时，任意模式都能出图（核心 handleCommand 已透传 type）
 *   3) 对外公开 core.services.image.*（其它模块可直接出图 / 推图 / 管理布局）
 *   4) 渲染失败自动降级为 markdown/text，绝不打断游戏逻辑
 * 注册方式与其它模块完全一致：moduleName / dependencies / 函数式模块。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ensureImageSchema } = require('./lib/image/imageSchema');
const store = require('./lib/image/imageStore');
const imageDoc = require('./lib/image/imageDoc');
const imageHtml = require('./lib/image/imageHtml');
const { createRenderer } = require('./lib/image/imageRender');

const ROOT = path.join(__dirname, '..');
const DIRS = {
  cache: path.join(ROOT, 'data', 'images', 'cache'),
  assets: path.join(ROOT, 'data', 'images', 'assets'),
  tmp: path.join(ROOT, 'data', 'images', 'tmp'),
  out: path.join(ROOT, 'data', 'images', 'out'),
};

const SETTING_DEFAULTS = {
  image_render_enabled: '1',
  image_render_port: '3212',
  image_render_timeout_ms: '5000',
  image_delivery: 'path',
  image_include_base64: '1',
  image_cache_max_mb: '256',
  image_cache_ttl_days: '7',
  image_fallback: 'markdown',
  image_exclude_rooms: '',
  image_scale: '2',
  image_default_width: '720',
  image_allow_remote_assets: '0',
  // 出图格式（2026-09-20 新增，默认 png = 与之前完全一致的行为）：
  //   png  —— 无损、兼容老插件；但 PNG 编码是 CPU 大头，长图又大又慢
  //   jpeg —— 实测编码快一倍多、体积小 60~70%（聊天图肉眼几乎无差），代价是透明区域会合成成实色
  // 实测（同一模板，720xscale2）：20 行 PNG 674ms/956KB ↔ JPEG85 约 380ms/384KB；
  //   300 行 PNG 1289ms/3612KB ↔ JPEG85 544ms/2764KB。
  image_format: 'png',
  image_jpeg_quality: '90',
};

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function str(v, def = '') { return typeof v === 'string' ? v : (v === undefined || v === null ? def : String(v)); }
function intOf(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }

async function imageModule(core) {
  for (const d of Object.values(DIRS)) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }

  // ===================== 初始化（失败也不能炸核心） =====================
  let initError = '';
  try {
    await ensureImageSchema(core.db, (lv, msg) => core.log(lv, msg));
    await store.ensureSeeds(core.db, (lv, msg) => core.log(lv, msg));
    await store.ensureTemplateSeeds(core.db, (lv, msg) => core.log(lv, msg));
    // 消息模板预设布局（2026-09-16）：核心支持多少个消息模板，就自动配多少张二次元风图
    await store.ensureMessageLayouts(core.db, (lv, msg) => core.log(lv, msg));
  } catch (e) {
    initError = e.message;
    try { core.log('error', '[image] 初始化失败：' + e.message); } catch (e2) {}
  }

  // 渲染子进程预热（2026-09-20）：核心起来就先把 Electron 拉起来，别让第一张图去等冷启动。
  // 实测冷启动 ~240ms（系统缓存热时），冷机器/首次运行会明显更久；预热不增加常驻成本——
  // 渲染子进程本来就会一直活着等下一张图。
  try {
    setTimeout(() => { ensureRenderer().then((rt) => rt && rt.start()).catch(() => {}); }, 600);
  } catch (e) { /* 预热失败无所谓，第一次渲染照样会拉起 */ }

  // ===================== 设置（2 秒缓存） =====================
  let sCache = { at: 0, map: null };
  let currentFallbackType = 'markdown';   // 降级目标类型（跟随设置，供 server.js 决定 type）
  async function getSettings(force) {
    if (!force && sCache.map && Date.now() - sCache.at < 2000) return sCache.map;
    const map = Object.assign({}, SETTING_DEFAULTS);
    try {
      const rows = await core.db.all("SELECT key, value FROM editor_settings WHERE key LIKE 'image\\_%' ESCAPE '\\'");
      for (const r of rows || []) if (r && r.key) map[r.key] = r.value;
    } catch (e) { /* 读不到用默认 */ }
    let serverPort = 3210;
    try {
      const row = await core.db.get("SELECT value FROM editor_settings WHERE key = 'server_port'");
      if (row && row.value) serverPort = intOf(row.value, 3210);
    } catch (e) { /* 默认端口 */ }
    const out = {
      enabled: str(map.image_render_enabled, '1') !== '0',
      port: intOf(map.image_render_port, 3212),
      timeoutMs: Math.max(800, intOf(map.image_render_timeout_ms, 5000)),
      delivery: ['path', 'url', 'base64'].includes(str(map.image_delivery)) ? str(map.image_delivery) : 'path',
      includeBase64: str(map.image_include_base64, '1') !== '0',
      cacheMaxBytes: Math.max(0, intOf(map.image_cache_max_mb, 256)) * 1024 * 1024,
      cacheTtlDays: Math.max(0, intOf(map.image_cache_ttl_days, 7)),
      fallback: str(map.image_fallback, 'markdown') === 'text' ? 'text' : 'markdown',
      excludeRooms: str(map.image_exclude_rooms).split(/[,\s]+/).filter(Boolean),
      scale: Math.min(4, Math.max(1, intOf(map.image_scale, 2))),
      defaultWidth: Math.max(64, intOf(map.image_default_width, 720)),
      format: str(map.image_format, 'png') === 'jpeg' ? 'jpeg' : 'png',
      jpegQuality: Math.min(100, Math.max(1, intOf(map.image_jpeg_quality, 90))),
      allowRemoteAssets: str(map.image_allow_remote_assets, '0') === '1',
      serverPort,
      raw: map,
    };
    sCache = { at: Date.now(), map: out };
    currentFallbackType = out.fallback;
    return out;
  }

  // ===================== 渲染子进程（每核心单例，热重载复用） =====================
  let renderer = core._imageRenderer || null;
  function getRenderer() {
    if (renderer) return renderer;
    renderer = createRenderer({
      rootDir: ROOT,
      port: 3212,                                   // 真实端口在 ensureRenderer 时按设置重建
      tmpDir: DIRS.tmp,
      log: (lv, msg) => { try { core.log(lv, msg); } catch (e) {} },
    });
    core._imageRenderer = renderer;
    return renderer;
  }
  let exitHooked = false;
  function hookExit() {
    if (exitHooked || global.__wgImageExitHooked) return;
    exitHooked = true;
    global.__wgImageExitHooked = true;
    process.on('exit', () => { try { if (renderer) renderer.stop(); } catch (e) {} });
  }

  async function ensureRenderer() {
    const s = await getSettings();
    if (!renderer || renderer.port !== s.port) {
      if (renderer) { try { await renderer.stop(); } catch (e) {} }
      renderer = createRenderer({
        rootDir: ROOT, port: s.port, tmpDir: DIRS.tmp, timeoutMs: s.timeoutMs,
        log: (lv, msg) => { try { core.log(lv, msg); } catch (e) {} },
      });
      core._imageRenderer = renderer;
    }
    hookExit();
    return renderer;
  }

  // ===================== 素材库（image_assets） =====================
  const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

  /** 从 dataURL / 纯 base64 解析出 {mime, base64}；非法 dataURL 直接报错，不要「猜成 png」 */
  function parseImagePayload(input) {
    const s = str(input);
    if (/^data:/i.test(s)) {
      const m = s.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
      if (!m) {
        const bad = (s.match(/^data:([^;,]+)/i) || [])[1] || '未知类型';
        return { error: '只接受 data:image/*;base64 形式（收到 ' + bad + '）' };
      }
      return { mime: m[1].toLowerCase(), base64: m[2] };
    }
    return { mime: 'image/png', base64: s };
  }

  /** 图片magic 校验：防止把非图片字节写进素材库 */
  function sniffImageMime(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  }

  /** PNG / JPEG / GIF / WebP 头部解析宽高（拿不到就 0，不影响使用） */
  function readImageSize(buf, mime) {
    try {
      if (mime === 'image/png' && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if ((mime === 'image/jpeg' || mime === 'image/jpg') && buf.length > 4) {
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) { i++; continue; }
          const marker = buf[i + 1];
          const len = buf.readUInt16BE(i + 2);
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
          }
          i += 2 + len;
        }
      }
      if (mime === 'image/gif' && buf.length > 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      if (mime === 'image/webp' && buf.length > 30 && buf.toString('latin1', 12, 16) === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
    } catch (e) { /* 解析失败按 0 处理 */ }
    return { width: 0, height: 0 };
  }

  function assetFileName(id, mime) {
    const ext = MIME_EXT[mime] || 'png';
    return String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.' + ext;
  }

  /**
   * 新增素材：{ name, dataUrl|base64, mime? } → 落盘到 data/images/assets + 写表
   * @returns {Promise<{ok:boolean, id?:string, path?:string, bytes?:number, width?:number, height?:number, error?:string}>}
   */
  async function addAsset(input = {}) {
    try {
      const payload = parseImagePayload(input.dataUrl || input.data || input.base64 || '');
      if (payload.error) return { ok: false, error: payload.error };
      const mime = str(input.mime, payload.mime) || payload.mime;
      if (!MIME_EXT[mime]) return { ok: false, error: '仅支持 png/jpeg/webp/gif 素材（收到 ' + mime + '）' };
      const buf = Buffer.from(payload.base64, 'base64');
      if (!buf.length) return { ok: false, error: '素材内容为空' };
      const sniffed = sniffImageMime(buf);
      if (!sniffed) return { ok: false, error: '不是有效的图片文件（PNG/JPEG/WebP/GIF 头校验失败）' };
      if (buf.length > 8 * 1024 * 1024) return { ok: false, error: '素材超过 8MB（请先压缩）' };
      const rawName = str(input.name, '素材');
      const base = rawName.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 24) || 'asset';
      const id = base + '_' + crypto.randomBytes(4).toString('hex');
      const file = path.join(DIRS.assets, assetFileName(id, mime));
      await fs.promises.mkdir(DIRS.assets, { recursive: true });
      await fs.promises.writeFile(file, buf);
      const size = readImageSize(buf, sniffed || mime);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const tagStr = Array.isArray(input.tags) ? input.tags.join(',') : str(input.tags, '');
      const groupStr = str(input.group || input.group_name, '');
      await store.addAsset(core.db, {
        id, name: rawName, mime: sniffed || mime, path: file, bytes: buf.length,
        width: intOf(input.width, size.width), height: intOf(input.height, size.height), sha256: sha,
        tags: tagStr, group_name: groupStr,
      });
      try { core.log('info', '[image] 素材已入库：' + id + '（' + buf.length + ' 字节 ' + (size.width || '?') + 'x' + (size.height || '?') + '）'); } catch (e) {}
      return { ok: true, id, path: file, bytes: buf.length, mime: sniffed || mime, width: size.width, height: size.height, tags: tagStr };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 素材路径（供 server.js 的 /imgasset/<id> 使用；带目录护栏） */
  async function getAssetPath(id) {
    const row = await store.getAsset(core.db, str(id));
    if (!row || !row.path) return null;
    const resolved = path.resolve(row.path);
    const base = path.resolve(DIRS.assets);
    if (!resolved.startsWith(base)) return null;
    if (!fs.existsSync(resolved)) return null;
    return { path: resolved, mime: row.mime || 'image/png', bytes: row.bytes || 0 };
  }

  // ===================== 素材地址解析 =====================
  async function assetUrlOf(src) {
    const s = str(src);
    if (!s) return null;
    if (!/^asset:/i.test(s)) return s;                    // file:// / data: 原样
    const id = s.slice(6).trim();
    try {
      const row = await store.getAsset(core.db, id);
      if (row && row.path) return 'file:///' + String(row.path).replace(/\\/g, '/').replace(/^\/+/, '');
    } catch (e) { /* 找不到就留空 */ }
    return null;
  }

  // ===================== repeat 展开（列表绑定） =====================
  /** 取列表数据：核心变量 → 数据点路径 → 模板表达式 → JSON 字符串 */
  async function resolveListSource(exprRaw, ctx, data) {
    const expr = str(exprRaw).trim();
    if (!expr) return [];
    const clean = expr.replace(/^\[|\]$/g, '').replace(/^\{|\}$/g, '').trim();
    let v;
    try { v = await core.getVariableValue(clean, ctx.playerId || null, 0, data); } catch (e) { v = undefined; }
    if (v === undefined || v === null || v === '') { try { v = core._getValueByPath(data, clean); } catch (e) { v = undefined; } }
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('[') || t.startsWith('{')) { try { const p = JSON.parse(t); if (Array.isArray(p)) v = p; } catch (e) { /* 非 JSON */ } }
    }
    if (v === undefined || v === null || v === '') {
      try {
        const tpl = (expr.includes('[') || expr.includes('{')) ? expr : '{' + clean + '}';
        const r = await core.renderTemplate(tpl, data, { escape: false }, ctx.playerId || null, ctx.templateKey || null);
        const t = String(r === undefined || r === null ? '' : r).trim();
        if (t && t !== tpl) { try { const p = JSON.parse(t); v = Array.isArray(p) ? p : t; } catch (e) { v = t; } }
      } catch (e) { /* 忽略，按空列表处理 */ }
    }
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'object') {
      // 映射对象（如 背包 {物品名: 数量}）→ 行对象
      return Object.entries(v).map(([k, val]) => (val && typeof val === 'object'
        ? Object.assign({ 名称: k, 键: k }, val)
        : { 名称: k, 键: k, 数量: val, 值: val }));
    }
    return String(v).split(/\r?\n/).map((s2) => s2.trim()).filter(Boolean);
  }

  /** 行数据：对象字段直接可用 + 项/序号/项数/第一个/最后 */
  function buildItemData(item, index, total) {
    const base = { 序号: index + 1, 索引: index, 项数: total, 第一个: index === 0, 最后: index === total - 1 };
    if (item && typeof item === 'object') return Object.assign({}, item, { 项: item }, base);
    return Object.assign({ 项: item, 名称: item, 值: item, 内容: item }, base);
  }

  function attachItemData(node, itemData) {
    node._itemData = itemData;
    (node.children || []).forEach((c) => attachItemData(c, itemData));
    return node;
  }

  /** 把 repeat 节点展开成 flow 容器 + 逐行克隆（行数据挂在 _itemData 上） */
  async function expandRepeats(doc, ctx = {}) {
    const warnings = [];
    const data = Object.assign({}, (ctx && ctx.data) || {});
    const clone = JSON.parse(JSON.stringify(doc));

    async function walk(nodes) {
      const out = [];
      for (const n of nodes || []) {
        if (n.type === 'repeat') {
          let list = [];
          try { list = await resolveListSource(n.source, ctx, data); }
          catch (e) { warnings.push('repeat ' + n.id + '：数据源解析失败 ' + e.message); }
          if (!Array.isArray(list) || !list.length) {
            warnings.push('repeat ' + n.id + '：数据源「' + n.source + '」为空');
            if (n.emptyText) {
              out.push({
                id: n.id, type: 'text', name: n.name, x: n.x, y: n.y, w: n.w, h: 0,
                content: n.emptyText,
                style: Object.assign({}, n.style, {
                  color: (n.style && n.style.color) || '#7d88bb',
                  fontSize: (n.style && n.style.fontSize) || '14',
                }),
              });
            }
            continue;
          }
          const items = list.slice(0, n.max);
          if (list.length > items.length) warnings.push('repeat ' + n.id + '：共 ' + list.length + ' 项，按 max=' + n.max + ' 截断');
          const children = items.map((item, i) => {
            const row = attachItemData(JSON.parse(JSON.stringify(n.item)), buildItemData(item, i, list.length));
            row.id = n.id + '_i' + (i + 1);
            row.name = str(n.item.name, '行') + ' ' + (i + 1);
            return row;
          });
          out.push({
            id: n.id, type: 'group', name: n.name, x: n.x, y: n.y, w: n.w, h: 0,
            flow: true, direction: n.direction, gap: n.gap, columns: n.columns,
            style: n.style, children,
          });
        } else {
          if (n.type === 'group' && Array.isArray(n.children)) n.children = await walk(n.children);
          out.push(n);
        }
      }
      return out;
    }

    clone.nodes = await walk(clone.nodes);
    return { doc: clone, warnings };
  }

  /**
   * 文档 → HTML：渲染、设计器预览、测试共用这一条流水线
   * 1) repeat 展开（异步取数 + 逐行数据注入）2) 变量解析 3) 生成 HTML
   */
  /**
   * 素材引用解析：asset:<id> → file:// 绝对路径
   * 必须在 buildHtml 之前做完 —— imageHtml 是同步渲染器，塞不进 async 回调
   * （2026-09-16 BUG：曾把 async 的 assetUrlOf 直接当同步回调传进去，src 变成 Promise，带素材的布局全画空图）
   */
  async function resolveAssetRefs(doc) {
    const list = [];
    const walk = (nodes) => (nodes || []).forEach((n) => {
      if (!n) return;
      if (n.type === 'image') list.push(n);
      if (n.type === 'group') walk(n.children);
    });
    walk(doc.nodes);
    for (const n of list) {
      if (typeof n.src === 'string' && /^asset:/i.test(n.src)) {
        const url = await assetUrlOf(n.src);
        n.src = url || '';            // 找不到素材 → 留空（渲染为空位，而不是 [object Promise]）
      }
    }
    return doc;
  }

  async function prepareHtml(doc, ctx = {}, settings) {
    const s = settings || await getSettings();
    const expanded = await expandRepeats(doc, ctx);
    const resolved = await resolveAssetRefs(await resolveDocFor(expanded.doc, ctx));
    const scale = Math.min(4, Math.max(1, Number(resolved.canvas.scale) || s.scale));
    const html = imageHtml.buildHtml(resolved, { scale, allowRemote: s.allowRemoteAssets });   // 素材已在上一步解析完
    return { html, doc: resolved, scale, warnings: expanded.warnings };
  }

  /**
   * 解析文档内所有文本（渲染与测试复用）
   * 转义策略：text 节点 escape:false（由 buildHtml 统一转义一次），html 节点 escape:true（保留标签、变量值被转义）
   */
  /**
   * 聊天端专用标签清洗（2026-09-17）
   * 背景：模块返回的 data 是三条通道（纯文本 / Markdown / 图片）共用的。
   *      Markdown 通道里按钮长这样：<qqbot-cmd-input text="%E8%83%8C%E5%8C%85%202" show="下一页" reference="false" />
   *      图片布局引用同一个变量时，会把整串标签当普通文字印在卡片上。
   * 处理：带 show 的标签 → 【show 文本】；不认识的 <qqbot-*> 标签 → 直接去掉。
   *      只针对 qqbot- 前缀，不碰普通文本，避免误伤玩家的聊天内容。
   */
  const QQ_TAG_WITH_SHOW = /<qqbot-[a-z0-9-]+\b[^>]*?\bshow\s*=\s*"([^"]*)"[^>]*?\/?>/gi;
  const QQ_TAG_BARE = /<qqbot-[a-z0-9-]+\b[^>]*?\/?>/gi;
  function stripChannelMarkup(v) {
    if (typeof v !== 'string' || v.indexOf('<') < 0) return v;
    return v.replace(QQ_TAG_WITH_SHOW, '【$1】').replace(QQ_TAG_BARE, '');
  }
  function stripChannelMarkupDeep(v, depth) {
    if (v == null || (depth || 0) > 6) return v;
    if (typeof v === 'string') return stripChannelMarkup(v);
    if (Array.isArray(v)) {
      let hit = false;
      for (const x of v) { if (typeof x === 'string' && x.indexOf('<') >= 0) { hit = true; break } }
      return hit ? v.map(function (x) { return stripChannelMarkupDeep(x, (depth || 0) + 1) }) : v;
    }
    if (typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = stripChannelMarkupDeep(v[k], (depth || 0) + 1);
      return o;
    }
    return v;
  }

  /**
   * 进度条占位符（2026-09-17 · BUG 记录 2）
   * html 节点里的条只能写死宽度（纯变量替换做不了除法），于是「角色信息」的血条永远是 74%。
   *   写法：<div class="bar"><i style="width:[[bar:玩家生命/玩家生命上限]]"></i></div>
   *   解析：斜杠两侧是变量名（可带 [] {} 或"玩家"前缀），算出百分比、钳在 0~100，输出 "83.3%"。
   * 取不到数字一律按 0 处理：宁可空条，也不要 NaN 把版面撑坏。
   */
  const BAR_TOKEN = /\[\[\s*bar\s*:\s*([^\/\]]+?)\s*\/\s*([^\]]+?)\s*\]\]/gi;

  async function barTokenNumber(expr, ctx, data) {
    const raw = String(expr == null ? '' : expr).trim().replace(/^\[+|\]+$/g, '').replace(/^\{+|\}+$/g, '').trim();
    if (!raw) return 0;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    let v;
    try { v = await core.getVariableValue(raw, ctx.playerId || null, 0, data); } catch (e) { v = undefined; }
    if (v === undefined || v === null || v === '') { try { v = core._getValueByPath(data, raw); } catch (e) { /* 忽略 */ } }
    if (v === undefined || v === null || v === '') {
      const tpl = '{' + raw + '}';
      try {
        const r = await core.renderTemplate(tpl, data, { escape: false }, ctx.playerId || null, ctx.templateKey || null);
        const s = String(r == null ? '' : r).trim();
        if (s && s !== tpl) v = s;      // 模板没解析出来就别当成数字
      } catch (e) { /* 忽略 */ }
    }
    const n = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  async function expandBarTokens(text, ctx, data) {
    const s = String(text == null ? '' : text);
    if (!/\[\[\s*bar\s*:/i.test(s)) return s;
    const jobs = [];
    s.replace(BAR_TOKEN, (m, a, b) => { jobs.push({ m: m, a: a, b: b }); return m; });
    if (!jobs.length) return s;
    let out = s;
    for (const j of jobs) {
      const value = await barTokenNumber(j.a, ctx, data);
      const max = await barTokenNumber(j.b, ctx, data);
      const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
      out = out.split(j.m).join(pct.toFixed(1) + '%');
    }
    return out;
  }

  async function resolveDocFor(doc, ctx = {}) {
    const data = Object.assign({}, (ctx && ctx.data) || {});
    return await imageDoc.resolveDoc(doc, async (text, node) => {
      if (!text) return '';
      try {
        // 行数据（repeat 展开时注入）优先合并：行内文本用自己那一行的数据解析
        const merged = (node && node._itemData) ? Object.assign({}, data, node._itemData) : data;
        // 聊天端标签清洗：模块的 data 是给整条链路共用的，里面可能混着只有 QQ/OneBot 认识的
        // 标签（如 <qqbot-cmd-input ... show="下一页" />）——那是 Markdown 回复专用的，
        // 图片通道直接印出来就是一行乱码，所以在这里统一洗掉
        const nd = stripChannelMarkupDeep(merged);
        // 进度条占位符先算（必须在 renderTemplate 之前：算完才是纯数字百分比）
        const withBars = await expandBarTokens(text, ctx, nd);
        return await core.renderTemplate(withBars, nd, { escape: node.type === 'html' }, ctx.playerId || null, ctx.templateKey || null);
      } catch (e) {
        try { core.log('warn', '[image] 变量解析失败（按原文输出）：' + e.message); } catch (e2) {}
        return text;
      }
    });
  }

  // ===================== 出图主流程 =====================
  /**
   * 渲染一份布局文档为 PNG
   * @param {string|object} ref 布局 id 或文档对象
   * @param {object} ctx { playerId, templateKey, room, data, overrides, noCache }
   * @returns {Promise<{ok:boolean, content?:string, image?:object, ms?:number, cached?:boolean, reason?:string, error?:string, warnings?:string[]}>}
   */
  async function renderDoc(ref, ctx = {}) {
    const t0 = Date.now();
    const s = await getSettings();
    if (initError && typeof ref !== 'object') return { ok: false, reason: 'init_failed', error: initError };
    if (!s.enabled) return { ok: false, reason: 'disabled', error: '图片渲染已在基础设置中关闭' };

    let doc = null;
    let warnings = [];
    if (typeof ref === 'string') {
      const got = await store.getLayout(core.db, ref);
      if (!got) return { ok: false, reason: 'layout_not_found', error: '布局不存在：' + ref };
      doc = got.doc;
      warnings = got.warnings || [];
    } else if (ref && typeof ref === 'object') {
      const n = imageDoc.normalizeDoc(ref, { width: s.defaultWidth, scale: s.scale, allowRemote: s.allowRemoteAssets });
      doc = n.doc;
      warnings = n.warnings;
    } else {
      return { ok: false, reason: 'bad_ref', error: '布局引用为空' };
    }
    if (ctx.overrides && typeof ctx.overrides === 'object') {
      doc = Object.assign({}, doc, ctx.overrides, { canvas: Object.assign({}, doc.canvas, ctx.overrides.canvas || {}) });
    }

    const prep = await prepareHtml(doc, ctx, s);
    const resolved = prep.doc;
    warnings = warnings.concat(prep.warnings || []);

    const scale = prep.scale;
    const width = Math.round(resolved.canvas.width || s.defaultWidth);
    const height = resolved.canvas.height > 0 ? Math.round(resolved.canvas.height) : 0;
    const html = prep.html;
    const fmt = s.format === 'jpeg' ? 'jpeg' : 'png';
    const ext = fmt === 'jpeg' ? '.jpg' : '.png';
    const hash = sha1(html + '|' + width + '|' + height + '|' + scale + '|' + fmt);
    const file = path.join(DIRS.cache, hash + ext);

    // 命中缓存：先内存热缓存（<1ms），再落到 DB 缓存（~3ms）
    if (!ctx.noCache) {
      cacheStat.lookups++;
      try {
        const hot = hotGet(hash);
        if (hot) {
          cacheStat.hits++; cacheStat.memHits++; cacheStat.savedMs += lastRenderMs;
          const meta = await buildMeta(hot, s, t0, true);
          return { ok: true, content: meta.content, image: meta.image, ms: Date.now() - t0, cached: true, hot: true, hash, warnings };
        }
        const hit = await store.cacheGet(core.db, hash);
        if (hit) {
          cacheStat.hits++; cacheStat.savedMs += lastRenderMs;
          hotPut(hash, hit);
          pendingTouch(hash);
          const meta = await buildMeta(hit, s, t0, true);
          return { ok: true, content: meta.content, image: meta.image, ms: Date.now() - t0, cached: true, hash, warnings };
        }
      } catch (e) { /* 缓存异常当未命中 */ }
    }

    const rt = await ensureRenderer();
    const out = await rt.render({ html, width, height, scale, format: fmt, quality: s.jpegQuality }, { timeoutMs: s.timeoutMs });
    if (!out || !out.ok) {
      try { core.log('warn', '[image] 出图失败：' + ((out && out.error) || '未知') + '（reason=' + ((out && out.reason) || '') + '）'); } catch (e) {}
      return { ok: false, reason: (out && out.reason) || 'render_failed', error: (out && out.error) || '渲染失败', ms: Date.now() - t0, warnings };
    }

    try {
      await fs.promises.writeFile(file, Buffer.from(out.base64, 'base64'));
    } catch (e) {
      return { ok: false, reason: 'cache_write_failed', error: e.message, ms: Date.now() - t0 };
    }
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    try {
      await store.cachePut(core.db, { hash, layoutId: str(resolved.id), path: file, bytes, width: out.width || width * scale, height: out.height || height * scale });
    } catch (e) { /* 索引失败不影响返回 */ }

    cacheStat.renders++;
    lastRenderMs = Date.now() - t0;
    hotPut(hash, { hash, path: file, bytes, width: out.width, height: out.height, layout_id: str(resolved.id) });
    const meta = await buildMeta({ hash, path: file, bytes, width: out.width, height: out.height }, s, t0, false);
    return { ok: true, content: meta.content, image: meta.image, ms: Date.now() - t0, cached: false, hash, warnings };
  }

  // 最近渲染元数据索引：让 describe() 在 content 是 URL 或 data:URI 时也能拿到元数据
  // （默认交付是 path，此时走 DB 缓存表；切成 url/base64 后 DB 查不到，靠这里兜底）
  const recentMeta = new Map();
  function rememberMeta(meta, extraKeys) {
    const light = Object.assign({}, meta);
    delete light.base64;                                  // 不驻留 base64，避免内存膨胀
    const keys = [light.path, light.url].concat(extraKeys || []);
    for (const k of keys) {
      if (!k || typeof k !== 'string') continue;
      recentMeta.set(k, light);
    }
    while (recentMeta.size > 400) { const oldest = recentMeta.keys().next().value; recentMeta.delete(oldest); }
  }

  /** 统一组装对外交付信息（path / url / base64 三件套） */
  async function buildMeta(row, s, t0, cached) {
    const hash = str(row.hash);
    const isJpg = str(row.path).toLowerCase().endsWith('.jpg');
    const ext = isJpg ? '.jpg' : '.png';
    const media = isJpg ? 'image/jpeg' : 'image/png';
    const url = 'http://127.0.0.1:' + s.serverPort + '/img/' + hash + ext;
    const image = {
      path: str(row.path),
      url,
      mediaType: media,
      width: intOf(row.width, 0),
      height: intOf(row.height, 0),
      hash,
      bytes: intOf(row.bytes, 0),
      cached: !!cached,
      renderMs: Date.now() - t0,
    };
    if (s.includeBase64) {
      try { image.base64 = await fs.promises.readFile(image.path, { encoding: 'base64' }); } catch (e) { /* 读不到就不给 */ }
    }
    let content = image.path;
    if (s.delivery === 'url') content = url;
    else if (s.delivery === 'base64') content = image.base64 ? ('data:' + media + ';base64,' + image.base64) : image.path;
    rememberMeta(Object.assign({}, image, { base64: undefined }), [content]);
    return { content, image };
  }

  // ===================== 内存热缓存 + 命中统计（2026-09-20 加） =====================
  // 为什么加：实测命中路径要 DB 查一次 + fs.existsSync 一次 + 写一次 UPDATE 计数（约 3ms），
  // 大图命中还要再读盘做 base64。热缓存把「最近用过的图的元数据」留在内存里，
  // 命中直接从内存拿（<1ms）；命中计数攒起来每 5 秒 flush，避免高频写放大。
  // 只缓存元数据、不缓存 base64（3.5MB 的图 × N 张会把内存吃光）。
  const hotCache = new Map();          // hash -> { hash, path, bytes, width, height, layout_id, at }
  let hotBytes = 0;
  const HOT_MAX_BYTES = 64 * 1024 * 1024;
  let lastRenderMs = 150;              // 最近一次真实渲染耗时（用来估算缓存省了多少）
  const cacheStat = { lookups: 0, hits: 0, memHits: 0, renders: 0, savedMs: 0 };

  function hotGet(hash) {
    const e = hotCache.get(hash);
    if (!e) return null;
    if (e.path && !fs.existsSync(e.path)) { hotCache.delete(hash); hotBytes -= e.bytes || 0; return null; }
    e.at = Date.now();
    return e;
  }
  function hotPut(hash, row) {
    const key = str(row.hash) || hash;
    const item = { hash: key, path: str(row.path), bytes: intOf(row.bytes, 0), width: intOf(row.width, 0), height: intOf(row.height, 0), layout_id: str(row.layout_id), at: Date.now() };
    const old = hotCache.get(key);
    if (old) hotBytes -= old.bytes || 0;
    hotCache.set(key, item);
    hotBytes += item.bytes || 0;
    while (hotBytes > HOT_MAX_BYTES && hotCache.size > 1) {   // 超预算就丢最久没用的
      let k = null, at = Infinity;
      for (const [kk, vv] of hotCache) if (vv.at < at) { at = vv.at; k = kk; }
      if (k === null) break;
      hotBytes -= (hotCache.get(k).bytes || 0);
      hotCache.delete(k);
    }
  }
  const pendingHits = new Map();
  let touchTimer = null;
  function pendingTouch(hash) {
    pendingHits.set(hash, (pendingHits.get(hash) || 0) + 1);
    if (!touchTimer) touchTimer = setTimeout(() => { touchTimer = null; flushTouches(); }, 5000);
  }
  async function flushTouches() {
    if (!pendingHits.size) return;
    const batch = Array.from(pendingHits.entries());
    pendingHits.clear();
    for (const [h, n] of batch) { try { await store.cacheTouchN(core.db, h, n); } catch (e) {} }
  }

  // ===================== 核心渲染器：type = 'image' =====================
  async function renderBody(template, context) {
    const text = template && typeof template.text === 'string' && template.text
      ? template.text
      : (template && typeof template.markdown === 'string' ? template.markdown : '');
    if (!text) return '';
    try {
      return await core.renderTemplate(text, Object.assign({}, context, context.message?.data || {}, context.handlerResultData || {}),
        { escape: false }, context.playerId || null, context.templateKey || null);
    } catch (e) {
      return text;
    }
  }

  /** 降级：按设置回退到核心已注册的 text / markdown 渲染器 */
  async function fallbackRender(template, context, reason, error) {
    const s = await getSettings();
    try {
      core.log('debug', '[image] 降级为 ' + s.fallback + '（' + reason + '）：' + (error || ''));
    } catch (e) {}
    const r = core.messageTypes.get(s.fallback === 'text' ? 'text' : 'markdown');
    if (typeof r === 'function') {
      try { return await r(template, context); } catch (e) { /* 再降一层 */ }
    }
    return (template && (template.text || template.markdown)) || '';
  }

  // 降级原因登记（按 玩家+模板 精确记录，10 秒内有效；供 server.js 透出 imageError）
  const fallbackMap = new Map();
  let lastFallback = null;
  function noteFallback(context, room, tKey, reason, error, fallbackType) {
    const rec = { at: Date.now(), reason, error: error || '', room, templateKey: tKey, type: fallbackType || currentFallbackType };
    lastFallback = rec;
    const pid = str(context && context.playerId, '');
    if (pid) fallbackMap.set(pid + '|' + tKey, rec);
    if (fallbackMap.size > 500) { for (const [k, v] of fallbackMap) if (Date.now() - v.at > 60000) fallbackMap.delete(k); }
  }
  function explain(playerId, templateKey) {
    const rec = fallbackMap.get(str(playerId, '') + '|' + str(templateKey, '')) || null;
    if (!rec) return null;
    if (Date.now() - rec.at > 10000) return null;
    return { reason: rec.reason, error: rec.error, at: rec.at, type: rec.type || 'markdown' };
  }

  core.registerMessageType('image', async (template, context) => {
    const s0 = await getSettings();
    const room = str(context.moduleName || context.doorHandle?.room || '*', '*');
    const tKey = str(context.templateKey || context.templateName || '*', '*');
    if (!s0.enabled) { noteFallback(context, room, tKey, 'disabled', '', s0.fallback); return await fallbackRender(template, context, 'disabled'); }
    if (s0.excludeRooms.includes(room)) { noteFallback(context, room, tKey, 'room_excluded', '', s0.fallback); return await fallbackRender(template, context, 'room_excluded'); }

    const found = await store.resolveLayout(core.db, room, tKey);
    if (!found) { noteFallback(context, room, tKey, 'layout_not_found', '', s0.fallback); return await fallbackRender(template, context, 'layout_not_found'); }

    const body = await renderBody(template, context);
    const data = Object.assign({}, context, context.message?.data || {}, context.handlerResultData || {}, { 消息: body });
    const out = await renderDoc(found.doc, { playerId: context.playerId, templateKey: tKey, room, data });
    if (out.ok) {
      // 2026-09-18 修（运行时缺口测试 G6.11c 抓到）：降级记录有 10 秒有效期，
      // 开关改回可用后「渲染成功」的这一次仍会被那条旧记录压成 markdown ——
      // server.js 按 explain() 判定 type，content 明明是刚出好的 png 路径，插件却会当文本发。
      // 出图成功 = 这次没降级，清掉本 玩家+模板 的旧记录。
      fallbackMap.delete(str(context && context.playerId, '') + '|' + tKey);
      if (lastFallback && lastFallback.templateKey === tKey) lastFallback = null;
      return out.content;
    }

    noteFallback(context, room, tKey, out.reason, out.error, s0.fallback);
    return await fallbackRender(template, context, out.reason, out.error);
  });

  // ===================== 缓存定期清理 =====================
  let sweepTimer = null;
  async function sweep() {
    try {
      const s = await getSettings();
      const r = await store.cacheSweep(core.db, { maxBytes: s.cacheMaxBytes, ttlDays: s.cacheTtlDays });
      if (r.removed) core.log('info', '[image] 缓存清理：删除 ' + r.removed + ' 张，释放 ' + Math.round(r.freed / 1024) + 'KB');
    } catch (e) { /* 清理失败不影响运行 */ }
  }
  try {
    sweepTimer = setInterval(() => { sweep(); }, 10 * 60 * 1000);
    if (sweepTimer.unref) sweepTimer.unref();
  } catch (e) { /* 环境不支持就跳过 */ }
  setTimeout(() => { sweep(); }, 15000).unref?.();

  // ===================== 对外 API =====================
  const api = {
    // —— 数据 ——
    listLayouts: (filter) => store.listLayouts(core.db, filter),
    getLayout: async (id) => { const g = await store.getLayout(core.db, id); return g ? g.doc : null; },
    saveLayout: (input, opts) => store.saveLayout(core.db, input, opts),
    deleteLayout: (id) => store.deleteLayout(core.db, id),
    listHistory: (id, limit) => store.listHistory(core.db, id, limit),
    rollback: (id, historyId) => store.rollback(core.db, id, historyId),
    resolveLayout: (room, tKey) => store.resolveLayout(core.db, room, tKey),
    invalidate: (id) => store.invalidate(core.db, id, DIRS.cache),

    // —— 渲染 ——
    render: (ref, ctx) => renderDoc(ref, ctx),
    renderHtml: async (html, opts = {}) => {
      const width = Math.max(1, intOf(opts.width, (await getSettings()).defaultWidth));
      const doc = {
        id: str(opts.id, 'inline/html'),
        name: str(opts.name, '内联 HTML'),
        canvas: { width, height: Math.max(0, intOf(opts.height, 0)), background: str(opts.background, 'transparent'), radius: 0, padding: 0, scale: Math.min(4, Math.max(1, Number(opts.scale) || 2)) },
        baseCss: str(opts.css, ''),
        vars: {},
        nodes: [{ id: 'html', type: 'html', x: 0, y: 0, w: width, h: Math.max(0, intOf(opts.height, 0)), style: {}, html: String(html || '') }],
      };
      return await renderDoc(doc, { playerId: opts.playerId, templateKey: opts.templateKey, data: opts.data || {}, noCache: opts.noCache });
    },
    respond: async (ref, ctx) => {
      const r = await renderDoc(ref, ctx);
      if (!r.ok) return null;
      return { type: 'image', content: r.content, image: r.image };
    },
    push: async (playerId, ref, ctx = {}) => {
      const r = await renderDoc(ref, Object.assign({}, ctx, { playerId }));
      if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
      const res = await core.push({ type: 'player', id: playerId, msg_type: 'image', content: r.content, dedupe_key: 'image_' + r.hash + '_' + playerId });
      return { ok: true, content: r.content, image: r.image, push: res };
    },
    describe: async (ref, opts = {}) => {
      if (!ref) return null;
      const s = await getSettings();
      const key = String(ref);
      let d = null;
      // data:URI 不必进 DB 查（必然查不到）；其它情况先查缓存表
      if (!/^data:image\//i.test(key)) d = await store.describeRef(core.db, key);
      if (!d) {
        const light = recentMeta.get(key);                 // content 是 URL / data:URI 时的兜底
        if (!light) return null;
        d = { hash: light.hash, path: light.path, bytes: light.bytes, width: light.width, height: light.height };
      }
      const port = intOf(opts.port, s.serverPort);
      const meta = {
        path: d.path, url: 'http://127.0.0.1:' + port + '/img/' + d.hash + '.png', mediaType: 'image/png',
        width: d.width, height: d.height, hash: d.hash, bytes: d.bytes, cached: true,
      };
      if (s.includeBase64) { try { meta.base64 = await fs.promises.readFile(d.path, { encoding: 'base64' }); } catch (e) {} }
      return meta;
    },

    // —— 模板商店（P1.5）——
    listTemplates: (filter) => store.listTemplates(core.db, filter || {}),
    getTemplate: (id) => store.getTemplate(core.db, id),
    saveTemplate: (input, opts) => store.saveTemplate(core.db, input, opts),
    deleteTemplate: (id) => store.deleteTemplate(core.db, id),
    listTemplateHistory: (id, limit) => store.listTemplateHistory(core.db, id, limit),
    rollbackTemplate: (id, historyId) => store.rollbackTemplate(core.db, id, historyId),
    applyTemplate: (key, newId) => store.applyTemplate(core.db, key, newId),

    // —— 素材库（P1.5）——
    listAssets: async () => (await store.listAssets(core.db)).map((r) => ({
      id: r.id, name: r.name, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height,
      tags: r.tags || '', group: r.group_name || '', url: '/imgasset/' + r.id, file: r.path, createdAt: r.created_at,
    })),
    addAsset: (input) => addAsset(input),
    deleteAsset: (id) => store.deleteAsset(core.db, id),
    setAssetTags: (id, tags) => store.setAssetTags(core.db, id, tags),
    setAssetGroup: (id, group) => store.setAssetGroup(core.db, id, group),
    listAssetGroups: async () => {
      const seen = new Map();
      for (const a of await store.listAssets(core.db)) {
        const g = str(a.group_name, '');
        seen.set(g, (seen.get(g) || 0) + 1);
      }
      return Array.from(seen.entries()).map(([group, n]) => ({ group, n }));
    },
    findAssetUsage: (id) => store.findAssetUsage(core.db, id),
    getAssetPath: (id) => getAssetPath(id),
    assetRef: (id) => 'asset:' + str(id),

    // —— 运维 ——
    health: async () => {
      const s = await getSettings();
      const rt = await ensureRenderer();
      const h = await rt.health();
      const cs = await store.cacheStats(core.db, DIRS.cache);
      return {
        ok: h.ok, enabled: s.enabled, port: s.port, delivery: s.delivery, settings: s, worker: h, cache: cs,
        // 2026-09-20：把「缓存到底省了多少」摊开给运维看
        hot: { items: hotCache.size, bytes: hotBytes, maxBytes: HOT_MAX_BYTES },
        stats: Object.assign({}, cacheStat, {
          hitRate: cacheStat.lookups ? Number((cacheStat.hits / cacheStat.lookups).toFixed(3)) : 0,
          savedSec: Number((cacheStat.savedMs / 1000).toFixed(1)),
          lastRenderMs,
        }),
        initError: initError || '',
      };
    },
    warmup: async () => { const rt = await ensureRenderer(); return await rt.start(); },
    lastFallback: () => lastFallback,
    explain: (playerId, templateKey) => explain(playerId, templateKey),
    sweep: () => sweep(),
    reloadSettings: () => getSettings(true),
    dirs: DIRS,
    _internals: { renderDoc, prepareHtml, resolveDocFor, expandRepeats, resolveListSource, getSettings, getRenderer: ensureRenderer, store, imageDoc, imageHtml },
  };

  if (!core.services) core.services = {};
  core.services.image = api;
  core.image = api;                       // 便于 server.js / 工具直接取

  try {
    core.log('info', '[image] 图片模块已加载：布局 ' + (await store.listLayouts(core.db)).length + ' 份，渲染端口 ' + (await getSettings()).port);
  } catch (e) {}

  // ===================== 生命周期 =====================
  const cleanup = async () => {
    try { await flushTouches(); } catch (e) {}          // 收尾前把攒着的命中计数落库
    try { if (touchTimer) clearTimeout(touchTimer); } catch (e) {}
    try { if (sweepTimer) clearInterval(sweepTimer); } catch (e) {}
    sweepTimer = null;
    try { if (renderer) await renderer.stop(); } catch (e) {}
    if (core._imageRenderer === renderer) core._imageRenderer = null;
    renderer = null;
  };

  return Object.assign({ moduleName: 'image', cleanup, unload: cleanup }, api);
}

imageModule.moduleName = 'image';
imageModule.dependencies = ['database'];
module.exports = imageModule;
