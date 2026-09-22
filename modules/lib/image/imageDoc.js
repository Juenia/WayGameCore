/**
 * WayGame 图片模块 · 排版文档层（校验 / 归一化 / 清洗 / 变量解析）
 * 设计：docs/图片消息模块设计-v1.md §4、docs/图片消息模块-排版DSL-v1.md
 *
 * 本文件不依赖 core、不依赖 Electron：纯函数 + 一次 async 解析回调。
 */
'use strict';

const crypto = require('crypto');

const NODE_TYPES = ['rect', 'ellipse', 'line', 'path', 'text', 'image', 'html', 'group', 'bar', 'repeat', 'rich_text'];

// flow 容器（repeat 展开后产生）里可以按文档流排布的子节点类型
const FLOW_ITEM_TYPES = ['text', 'html', 'image', 'bar', 'rich_text'];

// 允许透传为 CSS 的样式属性白名单（camelCase）。禁止 position/top/left/right/zIndex —— 定位由 x/y/w/h 决定。
const STYLE_WHITELIST = new Set([
  'background', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
  'backgroundClip', 'color', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
  'textAlign', 'textShadow', 'textDecoration', 'textTransform', 'textIndent', 'whiteSpace', 'wordBreak', 'wordWrap',
  'overflowWrap', 'textOverflow', 'verticalAlign', 'writingMode', 'direction',
  'borderRadius', 'border', 'borderColor', 'borderWidth', 'borderStyle', 'borderTop', 'borderRight', 'borderBottom',
  'borderLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopColor',
  'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle',
  'borderLeftStyle', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'boxShadow', 'opacity', 'filter', 'backdropFilter', 'mixBlendMode', 'isolation', 'clipPath', 'transform',
  'transformOrigin', 'display', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent',
  'alignSelf', 'justifySelf', 'gap', 'rowGap', 'columnGap', 'flex', 'flexGrow', 'flexShrink', 'flexBasis',
  'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow', 'gridColumn', 'gridRow', 'gridArea', 'placeItems',
  'objectFit', 'objectPosition', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'overflow', 'overflowX', 'overflowY', 'WebkitLineClamp', 'WebkitTextStroke', 'WebkitBackgroundClip',
  // ↓ 以下为 SVG 形状属性：矩形/圆/线/路径专用，由 imageHtml.js 输出为 SVG 属性（不会当 CSS 用）
  'fill', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeLinecap', 'strokeLinejoin', 'fillOpacity', 'strokeOpacity',
]);

// 形状类节点（走内联 SVG）专用的样式键
const SHAPE_KEYS = ['fill', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeLinecap', 'strokeLinejoin', 'fillOpacity', 'strokeOpacity'];

const DANGEROUS_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'textarea', 'button', 'svg script', 'style'];
const MAX_NODES = 800;
const MAX_DEPTH = 6;

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function str(v, def = '') { return typeof v === 'string' ? v : (v === undefined || v === null ? def : String(v)); }

/** 去掉可执行/可外联标签与事件属性（正则实现：无 DOM 依赖，够用且可预测） */
function sanitizeHtml(html, opts = {}) {
  let s = str(html);
  if (!s) return '';
  const allowRemote = !!opts.allowRemote;
  // <script>…</script> / <iframe>…</iframe> 等成对标签整体删除
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'textarea', 'button', 'audio', 'video', 'link', 'meta', 'base']) {
    s = s.replace(new RegExp('<' + tag + '\\b[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), '');
    s = s.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), '');
  }
  // <style> 保留场景：统一剥离，CSS 走 baseCss / node.css
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  // 事件属性 on*= 与 javascript: 协议
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  s = s.replace(/javascript\s*:/gi, 'blocked:');
  s = s.replace(/vbscript\s*:/gi, 'blocked:');
  // 内联 style 里的 expression / behavior（老 IE 遗留攻击面）
  s = s.replace(/expression\s*\(/gi, 'blocked(');
  if (!allowRemote) {
    // 变量值里注入的远程资源（SSRF / 外链）：默认屏蔽 src/href
    s = s.replace(/(\s(?:src|href|poster|data)\s*=\s*["']?)https?:\/\/[^\s"'>]*/gi, '$1about:blank');
  }
  return s;
}

/** CSS 清洗：禁 @import、远程 url()、expression() */
function sanitizeCss(css, allowRemote) {
  let s = str(css);
  if (!s) return '';
  s = s.replace(/@import[^;]*;?/gi, '');
  s = s.replace(/expression\s*\(/gi, 'blocked(');
  s = s.replace(/behavior\s*:/gi, 'blocked:');
  s = s.replace(/javascript\s*:/gi, 'blocked:');
  if (!allowRemote) {
    s = s.replace(/url\(\s*['"]?https?:\/\/[^)]*\)/gi, 'url(about:blank)');
  }
  return s;
}

function sanitizeSrc(src, allowRemote) {
  const s = str(src).trim();
  if (!s) return '';
  if (/^asset:/i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;
  if (/^file:/i.test(s)) return s;
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/')) return 'file:///' + s.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^https?:\/\//i.test(s)) return allowRemote ? s : '';
  return '';
}

function sanitizeStyle(style, allowRemote) {
  const out = {};
  if (!style || typeof style !== 'object') return out;
  for (const [k, v] of Object.entries(style)) {
    if (!STYLE_WHITELIST.has(k)) continue;
    if (k === 'position' || k === 'top' || k === 'left' || k === 'right' || k === 'bottom' || k === 'zIndex') continue;
    if (v === undefined || v === null) continue;
    let val = typeof v === 'number' ? String(v) : str(v);
    if (!allowRemote && /url\(\s*['"]?https?:\/\//i.test(val)) continue;
    if (/javascript\s*:/i.test(val) || /expression\s*\(/i.test(val)) continue;
    out[k] = val;
  }
  return out;
}

function sanitizeGradient(g) {
  if (!g || typeof g !== 'object') return null;
  return {
    from: str(g.from, 'rgba(255,255,255,0.05)'),
    to: str(g.to, 'rgba(255,255,255,0)'),
    angle: num(g.angle, 160),
  };
}

/** 归一化单个节点；返回 null 表示丢弃 */
function normalizeNode(raw, idx, opts, depth) {
  if (!raw || typeof raw !== 'object') return null;
  const type = str(raw.type).toLowerCase();
  if (!NODE_TYPES.includes(type)) { opts.warnings.push('节点 ' + (raw.id || '#' + idx) + ' 类型未知（' + type + '），已跳过'); return null; }
  if (depth > MAX_DEPTH) { opts.warnings.push('节点嵌套过深，已跳过 ' + (raw.id || '#' + idx)); return null; }

  const n = {
    id: str(raw.id) || ('n' + (idx + 1)),
    type,
    name: str(raw.name, ''),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    w: Math.max(0, num(raw.w, type === 'text' ? 200 : 100)),
    h: Math.max(0, num(raw.h, type === 'text' ? 0 : 40)),
    rotate: num(raw.rotate, 0),
    opacity: Math.min(1, Math.max(0, num(raw.opacity, 1))),
    visible: raw.visible === false ? false : true,
    style: sanitizeStyle(raw.style, opts.allowRemote),
  };
  // decor=true：纯装饰节点（柔光/光条/星芒），不参与"自适应高度"计算，
  // 否则一个越界的装饰光斑会把画布撑出大片空白（P1.5 第五批：模板实测发现）
  if (raw.decor === true) n.decor = true;

  if (type === 'rect' || type === 'ellipse') {
    n.gradient = sanitizeGradient(raw.gradient);
  } else if (type === 'line') {
    n.x2 = num(raw.x2, n.x + n.w);
    n.y2 = num(raw.y2, n.y + n.h);
    n.style = Object.assign({ stroke: '#8fa2ff', strokeWidth: '3' }, n.style);
  } else if (type === 'path') {
    n.d = str(raw.d, '');
    if (!n.d) { opts.warnings.push('path 节点 ' + n.id + ' 缺少 d，已跳过'); return null; }
    if (!n.w || !n.h) {
      // 未给盒子时给个保守默认，避免 0 尺寸不可见
      n.w = n.w || 200; n.h = n.h || 100;
    }
    n.close = raw.close === true;
    n.style = Object.assign({ stroke: '#8fa2ff', strokeWidth: '3', fill: 'none' }, n.style);
  } else if (type === 'text') {
    n.content = str(raw.content, '');
    n.raw = raw.raw === true;                       // true = 变量值不转义（危险，显式开启）
    if (!n.style.fontSize) n.style.fontSize = '18';
    if (!n.style.color) n.style.color = '#e9ecff';
    if (!n.style.lineHeight) n.style.lineHeight = '1.45';
  } else if (type === 'image') {
    n.src = sanitizeSrc(raw.src, opts.allowRemote);
    if (!n.src) { opts.warnings.push('image 节点 ' + n.id + ' 素材不合法/被拦截，已跳过'); return null; }
    if (!n.style.objectFit) n.style.objectFit = 'cover';
  } else if (type === 'html') {
    n.html = sanitizeHtml(raw.html, { allowRemote: opts.allowRemote });
    n.css = sanitizeCss(raw.css, opts.allowRemote);
    if (!n.html) { opts.warnings.push('html 节点 ' + n.id + ' 内容为空，已跳过'); return null; }
  } else if (type === 'bar') {
    // 进度条：数值/上限是「表达式」（走变量解析后再取数字）
    n.value = str(raw.value, '0');
    n.max = str(raw.max, '100');
    n.text = str(raw.text, '');
    n.showText = raw.showText !== false;
    n.fill = str(raw.fill, '#5ee7a0');
    n.fillStyle = sanitizeStyle(raw.fillStyle, opts.allowRemote);
    n.textStyle = sanitizeStyle(raw.textStyle, opts.allowRemote);
    if (!n.textStyle.color) n.textStyle.color = '#ffffff';
    if (!n.textStyle.fontSize) n.textStyle.fontSize = '12';
    if (!n.style.background) n.style.background = 'rgba(255,255,255,0.12)';
    if (!n.style.borderRadius) n.style.borderRadius = '8px';
    if (!n.h) n.h = 16;
  } else if (type === 'rich_text') {
    // 富文本：分段样式，段内同样支持变量
    const segs = Array.isArray(raw.segments) ? raw.segments : [];
    n.segments = [];
    for (const s of segs) {
      if (!s || typeof s !== 'object') continue;
      n.segments.push({ text: str(s.text, ''), style: sanitizeStyle(s.style, opts.allowRemote) });
    }
    if (!n.segments.length) { opts.warnings.push('rich_text 节点 ' + n.id + ' 没有 segments，已跳过'); return null; }
    if (!n.style.fontSize) n.style.fontSize = '16';
    if (!n.style.color) n.style.color = '#e9ecff';
    if (!n.style.lineHeight) n.style.lineHeight = '1.5';
  } else if (type === 'repeat') {
    // 列表绑定：展开成 flow 容器 + 逐行克隆（行数据在展开阶段注入）
    n.source = str(raw.source, '');
    if (!n.source) { opts.warnings.push('repeat 节点 ' + n.id + ' 缺少 source，已跳过'); return null; }
    n.direction = ['column', 'row', 'grid'].includes(str(raw.direction)) ? str(raw.direction) : 'column';
    n.gap = Math.max(0, num(raw.gap, 8));
    n.columns = Math.max(1, Math.min(12, num(raw.columns, 2)));
    n.max = Math.max(1, Math.min(200, num(raw.max, 50)));
    n.emptyText = str(raw.emptyText, '');
    const itemRaw = Array.isArray(raw.item) ? raw.item[0] : raw.item;
    if (!itemRaw || typeof itemRaw !== 'object') { opts.warnings.push('repeat 节点 ' + n.id + ' 缺少 item 模板，已跳过'); return null; }
    const item = normalizeNode(Object.assign({}, itemRaw, { id: str(itemRaw.id, n.id + '_item') }), 0, opts, depth + 1);
    if (!item) { opts.warnings.push('repeat 节点 ' + n.id + ' 的 item 模板非法，已跳过'); return null; }
    if (!FLOW_ITEM_TYPES.includes(item.type)) {
      opts.warnings.push('repeat 节点 ' + n.id + ' 的 item 类型 ' + item.type + ' 不支持流式排布，已按 text 处理');
      item.type = 'text';
      item.content = str(item.content, '');
    }
    n.item = item;
    n.h = 0;                       // 容器高度自适应
  } else if (type === 'group') {
    const kids = Array.isArray(raw.children) ? raw.children : [];
    n.children = [];
    for (let i = 0; i < kids.length; i++) {
      const c = normalizeNode(kids[i], i, opts, depth + 1);
      if (c) n.children.push(c);
    }
    if (raw.clip === true) n.clip = true;
  }
  return n;
}

/**
 * 归一化整份文档
 * @returns {{ ok:boolean, doc:object, warnings:string[] }}
 */
function normalizeDoc(raw, defaults = {}) {
  const warnings = [];
  const opts = { warnings, allowRemote: !!defaults.allowRemote };
  const src = (raw && typeof raw === 'object') ? raw : {};
  const c = (src.canvas && typeof src.canvas === 'object') ? src.canvas : {};
  const heightRaw = c.height === 'auto' || c.height === undefined || c.height === null ? 0 : num(c.height, 0);
  const canvas = {
    width: Math.max(64, Math.min(4096, num(c.width, num(defaults.width, 720)))),
    height: heightRaw > 0 ? Math.max(64, Math.min(8192, heightRaw)) : 0,   // 0 = auto
    background: str(c.background, 'transparent'),
    radius: Math.max(0, num(c.radius, 0)),
    padding: Math.max(0, num(c.padding, 0)),
    scale: Math.min(4, Math.max(1, num(c.scale, num(defaults.scale, 2)))),
  };
  // 参考线（P1.5 第三批）：纯设计辅助，渲染器不使用，但要随文档保存/加载
  const rawGuides = Array.isArray(c.guides) ? c.guides.slice(0, 40) : [];
  canvas.guides = [];
  for (const g of rawGuides) {
    if (!g || typeof g !== 'object') continue;
    const dirRaw = str(g.dir).toLowerCase();
    if (dirRaw !== 'v' && dirRaw !== 'h') continue;          // 非法方向直接丢弃（不要静默改成竖线）
    const dir = dirRaw;
    const at = num(g.at, NaN);
    if (!Number.isFinite(at)) continue;
    canvas.guides.push({ dir: dir, at: Math.round(at) });
  }
  const doc = {
    v: 1,
    id: str(src.id, str(defaults.id, '')),
    name: str(src.name, str(defaults.name, '未命名布局')),
    room: str(src.room, str(defaults.room, '*')),
    templateKey: str(src.templateKey, str(defaults.templateKey, '*')),
    mode: ['css', 'scene', 'hybrid'].includes(str(src.mode)) ? src.mode : 'hybrid',
    canvas,
    baseCss: sanitizeCss(src.baseCss, opts.allowRemote),
    vars: (src.vars && typeof src.vars === 'object' && !Array.isArray(src.vars)) ? Object.assign({}, src.vars) : {},
    nodes: [],
  };
  const list = Array.isArray(src.nodes) ? src.nodes.slice(0, MAX_NODES) : [];
  if (Array.isArray(src.nodes) && src.nodes.length > MAX_NODES) warnings.push('节点数超过 ' + MAX_NODES + '，已截断');
  for (let i = 0; i < list.length; i++) {
    const n = normalizeNode(list[i], i, opts, 1);
    if (n) doc.nodes.push(n);
  }
  if (!doc.nodes.length) warnings.push('文档没有任何有效节点');
  return { ok: true, doc, warnings };
}

/** 展开预设变量：{键} → 预设片段（最多 3 层，防止自引用死循环） */
function expandVars(text, vars) {
  let s = str(text);
  if (!s || !vars) return s;
  for (let round = 0; round < 3; round++) {
    let changed = false;
    s = s.replace(/\{([^{}\s]+)\}/g, (m, key) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        changed = true;
        return str(vars[key]);
      }
      return m;
    });
    if (!changed) break;
  }
  return s;
}

/** 收集所有需要解析的文本（就地写回时用同一份引用） */
function collectTextTargets(doc) {
  const out = [];
  const walk = (nodes, base) => {
    for (const n of nodes || []) {
      const p = base + '/' + n.id;
      if (n.type === 'text') out.push({ path: p, node: n, field: 'content', value: str(n.content) });
      else if (n.type === 'html') out.push({ path: p, node: n, field: 'html', value: str(n.html) });
      else if (n.type === 'bar') {
        out.push({ path: p + '/value', node: n, field: 'value', value: str(n.value) });
        out.push({ path: p + '/max', node: n, field: 'max', value: str(n.max) });
        if (n.text) out.push({ path: p + '/text', node: n, field: 'text', value: str(n.text) });
      } else if (n.type === 'rich_text') {
        // 注意：node 必须是 rich_text 节点本身（行数据 _itemData 挂在节点上），段号用 segIndex 标记。
        // 曾经错误地把「段对象」当 node → repeat 行模板里的富文本变量解析不出来（[名称] 渲染为空）。
        (n.segments || []).forEach((s, i) => out.push({ path: p + '/seg' + i, node: n, field: 'segments', segIndex: i, value: str(s.text) }));
      } else if (n.type === 'repeat') {
        if (n.item) walk([n.item], p + '/item');       // 未展开时的设计器预览：用全局数据解析行模板
      } else if (n.type === 'group') walk(n.children, p);
    }
  };
  walk(doc.nodes, '#' + (doc.id || 'doc'));
  return out;
}

/**
 * 解析文档内所有文本：先展开 vars 预设，再交给 resolver（通常是 core.renderTemplate）
 * @param {object} doc 已归一化的文档
 * @param {(text:string, node:object)=>Promise<string>} resolver
 * @returns {Promise<object>} 解析后的**新文档**（不改原对象）
 */
async function resolveDoc(doc, resolver) {
  const clone = JSON.parse(JSON.stringify(doc));
  const targets = collectTextTargets(clone);
  for (const t of targets) {
    const expanded = expandVars(t.value, clone.vars);
    const writeBack = (val) => {
      if (t.segIndex !== undefined) {
        if (t.node.segments && t.node.segments[t.segIndex]) t.node.segments[t.segIndex].text = val;
      } else t.node[t.field] = val;
    };
    if (!expanded) { writeBack(''); continue; }
    let resolved = expanded;
    if (typeof resolver === 'function') {
      try { resolved = await resolver(expanded, t.node); }
      catch (e) { resolved = expanded; }
    }
    writeBack(resolved === undefined || resolved === null ? '' : String(resolved));
  }
  clone._resolved = true;
  return clone;
}

/** 结构化哈希（用于缓存键与变更检测） */
function hashDoc(obj) {
  return crypto.createHash('sha1').update(stableStringify(obj)).digest('hex');
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

module.exports = {
  NODE_TYPES, FLOW_ITEM_TYPES, STYLE_WHITELIST, MAX_NODES, MAX_DEPTH,
  sanitizeHtml, sanitizeCss, sanitizeStyle, sanitizeSrc, sanitizeGradient,
  normalizeDoc, expandVars, collectTextTargets, resolveDoc, hashDoc, stableStringify,
};
