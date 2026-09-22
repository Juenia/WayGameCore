/**
 * WayGame 图片模块 · doc → HTML
 * 设计：docs/图片消息模块设计-v1.md §5、docs/图片消息模块-排版DSL-v1.md
 *
 * 产出「一张图 = 一个 HTML」：所有节点绝对定位，按数组顺序决定 z 序（后画在上），
 * 形状类节点（rect/ellipse/line/path）输出为内联 SVG，文本/图片/HTML 节点输出为 div/img。
 * 缩放：外层 #wg-stage 用 transform:scale(N)，窗口尺寸 = 设计尺寸 × N（文字按矢量重栅格化，2 倍图清晰）。
 *
 * 安全：文本节点默认**转义**（node.raw = true 才原样输出）；html 节点内容已在 imageDoc 清洗。
 */
'use strict';

const { sanitizeHtml } = require('./imageDoc');

// SVG 形状属性：作为 SVG 属性输出，不作为 CSS 输出
const SVG_SHAPE_KEYS = new Set(['fill', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeLinecap', 'strokeLinejoin', 'fillOpacity', 'strokeOpacity']);

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function camelToKebab(k) { return k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()); }

function cssNumber(v) {
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s + 'px';
  return s;
}

/** 需要补 px 的属性（注意：line-height 不在此列，见下） */
const PX_KEYS = /^(font-size|letter-spacing|border-radius|border-width|padding|margin|padding-top|padding-right|padding-bottom|padding-left|margin-top|margin-right|margin-bottom|margin-left|gap|row-gap|column-gap|text-indent)$/;

/**
 * style 对象 → CSS 声明串（跳过 SVG 属性与非法值）
 *
 * ⚠️ line-height 必须区别对待（2026-09-16 修"文字变摩斯密码"事故）：
 * CSS 里 line-height 无单位 = 字号倍数（1.45 表示 1.45 倍），带 px 才是固定值。
 * 旧实现把它当普通长度统一补 px，于是默认值 '1.45' 输出成 line-height:1.45px
 * → 行盒只有 1.45px 高，而 text 节点又是 overflow:hidden
 * → 整段文字只剩一条 2px 横线，看起来就是一排点和划（摩斯密码）。
 * 现在的规则：纯数字 < 6 视为倍数（1.2~3 是常见倍数），>= 6 视为像素值（24 → 24px）。
 */
function styleToCss(style) {
  const parts = [];
  for (const [k, v] of Object.entries(style || {})) {
    if (SVG_SHAPE_KEYS.has(k)) continue;
    if (k === 'width' || k === 'height') continue;             // 盒子尺寸由节点 w/h 决定
    if (v === undefined || v === null || v === '') continue;
    const key = camelToKebab(k);
    let val = String(v);
    if (/^-?[\d.]+$/.test(val)) {
      if (key === 'line-height') val = Number(val) >= 6 ? val + 'px' : val;
      else if (PX_KEYS.test(key)) val = val + 'px';
    }
    parts.push(key + ':' + val);
  }
  return parts.join(';');
}

/** 作用域化节点 CSS：#wg-n-<id> 前缀（不支持 @media 内选择器改写） */
function scopeCss(css, scopeSel) {
  if (!css) return '';
  try {
    return String(css).replace(/(^|[}])\s*([^{}@]+)\{/g, (m, brace, sel) => {
      const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => (s.startsWith(scopeSel) ? s : scopeSel + ' ' + s));
      return brace + ' ' + parts.join(',') + ' {';
    });
  } catch (e) {
    return String(css);
  }
}

function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_'); }

function gradientSvg(id, g) {
  const a = ((Number(g.angle) || 0) * Math.PI) / 180;
  const x1 = 0.5 - Math.sin(a) / 2, y1 = 0.5 + Math.cos(a) / 2;
  const x2 = 0.5 + Math.sin(a) / 2, y2 = 0.5 - Math.cos(a) / 2;
  const gid = 'wg-grad-' + safeId(id);
  return {
    def: '<linearGradient id="' + gid + '" x1="' + x1.toFixed(3) + '" y1="' + y1.toFixed(3) + '" x2="' + x2.toFixed(3) + '" y2="' + y2.toFixed(3) + '">' +
      '<stop offset="0%" stop-color="' + escapeHtml(g.from) + '"/>' +
      '<stop offset="100%" stop-color="' + escapeHtml(g.to) + '"/></linearGradient>',
    ref: 'url(#' + gid + ')',
  };
}

function nodeTransform(n) {
  const parts = [];
  if (n.rotate) parts.push('rotate(' + n.rotate + 'deg)');
  return parts.join(' ');
}

function wrapperStyle(n) {
  const s = ['position:absolute', 'left:' + n.x + 'px', 'top:' + n.y + 'px'];
  if (n.w) s.push('width:' + n.w + 'px');
  if (n.h) s.push('height:' + n.h + 'px');
  if (n.opacity !== undefined && n.opacity !== 1) s.push('opacity:' + n.opacity);
  const tf = nodeTransform(n);
  if (tf) { s.push('transform:' + tf); s.push('transform-origin:center center'); }
  return s.join(';');
}

function renderShape(n, opts) {
  const id = safeId(n.id);
  const box = n.w && n.h ? null : 'overflow:visible;';
  const w = Math.max(1, n.w), h = Math.max(1, n.h);
  const st = n.style || {};
  let def = '';
  let shape = '';

  if (n.type === 'rect') {
    let fill = st.fill !== undefined ? st.fill : 'none';
    if (n.gradient) { const g = gradientSvg(id, n.gradient); def = g.def; fill = g.ref; }
    const rx = st.borderRadius ? parseFloat(st.borderRadius) || 0 : 0;
    shape = '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="' + rx + '"' +
      ' fill="' + escapeHtml(fill) + '"' +
      (st.stroke ? ' stroke="' + escapeHtml(st.stroke) + '"' : '') +
      (st.strokeWidth ? ' stroke-width="' + escapeHtml(st.strokeWidth) + '"' : '') +
      (st.strokeDasharray ? ' stroke-dasharray="' + escapeHtml(st.strokeDasharray) + '"' : '') +
      (st.fillOpacity ? ' fill-opacity="' + escapeHtml(st.fillOpacity) + '"' : '') + '/>';
  } else if (n.type === 'ellipse') {
    let fill = st.fill !== undefined ? st.fill : 'none';
    if (n.gradient) { const g = gradientSvg(id, n.gradient); def = g.def; fill = g.ref; }
    shape = '<ellipse cx="' + (w / 2) + '" cy="' + (h / 2) + '" rx="' + (w / 2) + '" ry="' + (h / 2) + '"' +
      ' fill="' + escapeHtml(fill) + '"' +
      (st.stroke ? ' stroke="' + escapeHtml(st.stroke) + '"' : '') +
      (st.strokeWidth ? ' stroke-width="' + escapeHtml(st.strokeWidth) + '"' : '') + '/>';
  } else if (n.type === 'line') {
    // 归一化时已把 x2/y2 存为绝对设计坐标；这里换算为盒内局部坐标
    const lx = (typeof n.x2 === 'number' ? n.x2 : n.x + w) - n.x;
    const ly = (typeof n.y2 === 'number' ? n.y2 : n.y + h) - n.y;
    shape = '<line x1="0" y1="0" x2="' + lx + '" y2="' + ly + '"' +
      ' stroke="' + escapeHtml(st.stroke || '#8fa2ff') + '"' +
      ' stroke-width="' + escapeHtml(st.strokeWidth || '3') + '"' +
      (st.strokeDasharray ? ' stroke-dasharray="' + escapeHtml(st.strokeDasharray) + '"' : '') +
      ' stroke-linecap="' + escapeHtml(st.strokeLinecap || 'round') + '"/>';
  } else if (n.type === 'path') {
    shape = '<path d="' + escapeHtml(n.d) + '"' +
      ' fill="' + escapeHtml(st.fill !== undefined ? st.fill : (n.close ? '#8fa2ff' : 'none')) + '"' +
      ' stroke="' + escapeHtml(st.stroke || '#8fa2ff') + '"' +
      ' stroke-width="' + escapeHtml(st.strokeWidth || '3') + '"' +
      ' stroke-linecap="' + escapeHtml(st.strokeLinecap || 'round') + '"' +
      ' stroke-linejoin="' + escapeHtml(st.strokeLinejoin || 'round') + '"/>';
  }

  return '<svg data-wg-node="' + escapeHtml(n.id) + '"' + (n.decor ? ' data-decor="1"' : '') + ' data-wg-type="' + n.type + '"' +
    ' style="' + wrapperStyle(n) + box + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    (def ? '<defs>' + def + '</defs>' : '') + shape + '</svg>';
}

/** 进度条内部结构：轨道 + 填充 + 可选文字（数值已在解析阶段取到） */
function barInner(n) {
  const numOf = (v, def) => {
    const s = String(v === undefined || v === null ? '' : v).replace(/[^\d.\-]/g, '');
    const x = Number(s);
    return Number.isFinite(x) ? x : def;
  };
  const value = numOf(n.value, 0);
  const max = numOf(n.max, 100);
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  const radius = escapeHtml(String((n.style && n.style.borderRadius) || '8px'));
  const fillCss = styleToCss(n.fillStyle || {});
  const showText = n.showText !== false && String(n.text || '').length > 0;
  const overlay = showText
    ? '<div style="position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;' +
      styleToCss(n.textStyle || {}) + '">' + escapeHtml(n.text) + '</div>'
    : '';
  return '<div style="position:absolute;left:0;top:0;right:0;bottom:0;border-radius:' + radius + ';overflow:hidden">' +
    '<div style="height:100%;width:' + pct.toFixed(2) + '%;background:' + escapeHtml(n.fill || '#5ee7a0') +
    ';border-radius:' + radius + ';' + fillCss + '"></div>' + overlay + '</div>';
}

/** 富文本：分段 span（段文本按 text 节点规则转义） */
function richInner(n) {
  const raw = n.raw === true;
  return (n.segments || []).map((s) => {
    const css = styleToCss(s.style || {});
    const txt = raw ? String(s.text || '') : escapeHtml(s.text || '');
    return css ? '<span style="' + css + '">' + txt + '</span>' : txt;
  }).join('');
}

/** flow 子节点（repeat 展开后的行）：跟随文档流排布，不用绝对定位 */
function renderFlowChild(n, opts, extraCss) {
  if (!n || n.visible === false) return '';
  const extra = extraCss ? extraCss + ';' : '';
  const css = styleToCss(n.style);
  const idAttr = ' data-wg-node="' + escapeHtml(n.id) + '" data-wg-type="' + n.type + '"';
  if (n.type === 'text') {
    const content = n.raw === true ? String(n.content || '') : escapeHtml(n.content || '');
    return '<div' + idAttr + ' style="' + extra + 'box-sizing:border-box;white-space:pre-wrap;word-break:break-word;' + css + '">' + content + '</div>';
  }
  if (n.type === 'html') {
    const scoped = n.css ? '<style>' + scopeCss(n.css, '#wg-n-' + safeId(n.id)) + '</style>' : '';
    const safeHtml = sanitizeHtml(n.html || '', { allowRemote: !!opts.allowRemote });
    return scoped + '<div' + idAttr + ' id="wg-n-' + safeId(n.id) + '" style="' + extra + 'box-sizing:border-box;' + css + '">' + safeHtml + '</div>';
  }
  if (n.type === 'image') {
    const src = opts.assetUrl ? (opts.assetUrl(n.src) || n.src) : n.src;
    const size = (n.w ? 'width:' + n.w + 'px;' : '') + (n.h ? 'height:' + n.h + 'px;' : '');
    return '<img' + idAttr + ' src="' + escapeHtml(src) + '" style="' + extra + size + 'box-sizing:border-box;flex:0 0 auto;' + css + '"/>';
  }
  if (n.type === 'bar') {
    const box = 'position:relative;' + (n.w ? 'width:' + n.w + 'px;' : 'width:100%;') + 'height:' + (n.h || 16) + 'px;';
    return '<div' + idAttr + ' style="' + extra + box + 'box-sizing:border-box;' + css + '">' + barInner(n) + '</div>';
  }
  if (n.type === 'rich_text') {
    return '<div' + idAttr + ' style="' + extra + 'box-sizing:border-box;white-space:pre-wrap;word-break:break-word;' + css + '">' + richInner(n) + '</div>';
  }
  // 兜底：其它类型退化为单行文本占位，避免整块消失
  return '<div' + idAttr + ' style="' + extra + 'box-sizing:border-box;opacity:.6;' + css + '">[' + escapeHtml(n.type) + ' ' + escapeHtml(n.id) + ']</div>';
}

function renderNode(n, opts) {
  if (!n || n.visible === false) return '';
  const idAttr = ' data-wg-node="' + escapeHtml(n.id) + '"' + (n.decor ? ' data-decor="1"' : '') + ' data-wg-type="' + n.type + '"';

  if (n.type === 'rect' || n.type === 'ellipse' || n.type === 'line' || n.type === 'path') {
    return renderShape(n, opts);
  }

  if (n.type === 'text') {
    const st = Object.assign({ 'white-space': 'pre-wrap', 'word-break': 'break-word' }, {});
    const css = styleToCss(n.style);
    const content = n.raw === true ? String(n.content || '') : escapeHtml(n.content || '');
    const extra = [
      'display:flex', 'flex-direction:column',
      'justify-content:' + (n.style && /flex-end|center/.test(String(n.style.justifyContent || '')) ? n.style.justifyContent : 'flex-start'),
      'white-space:pre-wrap', 'word-break:break-word',
      // 没写 h 的文本节点是"高度自适应"，绝不能裁：裁了就只剩一条横线（2026-09-16 事故的放大器）
      (n.h ? 'overflow:hidden' : 'overflow:visible'),
      'box-sizing:border-box',
    ].join(';');
    void st;
    return '<div' + idAttr + ' style="' + wrapperStyle(n) + ';' + extra + ';' + css + '">' +
      '<span style="display:block">' + content + '</span></div>';
  }

  if (n.type === 'image') {
    const src = opts.assetUrl ? (opts.assetUrl(n.src) || n.src) : n.src;
    const css = styleToCss(n.style);
    return '<img' + idAttr + ' src="' + escapeHtml(src) + '" style="' + wrapperStyle(n) + ';box-sizing:border-box;' + css + '"/>';
  }

  if (n.type === 'html') {
    const scoped = n.css ? '<style>' + scopeCss(n.css, '#wg-n-' + safeId(n.id)) + '</style>' : '';
    const css = styleToCss(n.style);
    // 解析后再清洗一次：变量值可能把 onerror / script / 远程 src 注入进来（[变量] 在核心层不做转义）
    const safeHtml = sanitizeHtml(n.html || '', { allowRemote: !!opts.allowRemote });
    return scoped + '<div' + idAttr + ' id="wg-n-' + safeId(n.id) + '" style="' + wrapperStyle(n) + ';' +
      (n.h ? '' : 'height:auto;') + 'box-sizing:border-box;' + css + '">' + safeHtml + '</div>';
  }

  if (n.type === 'bar') {
    return '<div' + idAttr + ' style="' + wrapperStyle(n) + ';box-sizing:border-box;' + styleToCss(n.style) + '">' + barInner(n) + '</div>';
  }

  if (n.type === 'rich_text') {
    return '<div' + idAttr + ' style="' + wrapperStyle(n) + ';box-sizing:border-box;white-space:pre-wrap;word-break:break-word;' +
      styleToCss(n.style) + '">' + richInner(n) + '</div>';
  }

  if (n.type === 'group') {
    const css = styleToCss(n.style);
    if (n.flow) {
      // flow 容器（repeat 展开产物）：flex 自动堆叠，高度随内容自适应
      const isRow = n.direction === 'row' || n.direction === 'grid';
      const wrap = n.direction === 'grid' ? 'wrap' : 'nowrap';
      const gap = Number(n.gap) || 0;
      const cols = Math.max(1, Number(n.columns) || 2);
      const itemExtra = n.direction === 'grid'
        ? 'flex:0 0 calc(' + (100 / cols).toFixed(4) + '% - ' + gap + 'px)'
        : '';
      const kids = (n.children || []).map((c) => renderFlowChild(c, opts, itemExtra)).join('');
      const flowCss = 'display:flex;flex-direction:' + (isRow ? 'row' : 'column') + ';flex-wrap:' + wrap +
        ';gap:' + gap + 'px;height:auto;overflow:visible';
      return '<div' + idAttr + ' style="' + wrapperStyle(n) + ';' + flowCss + ';box-sizing:border-box;' + css + '">' + kids + '</div>';
    }
    const kids = (n.children || []).map((c) => renderNode(c, opts)).join('');
    const clip = n.clip ? 'overflow:hidden;' : '';
    return '<div' + idAttr + ' style="' + wrapperStyle(n) + ';' + clip + 'box-sizing:border-box;' + css + '">' + kids + '</div>';
  }

  return '';
}

/** 自适应高度脚本：绝对定位的子节点不参与父高度，必须自己量 */
function autoHeightScript(scale) {
  return '<script>(function(){' +
    'var root=document.getElementById("wg-root");if(!root)return;' +
    'var rt=root.getBoundingClientRect().top;var max=0;' +
    'var nodes=root.querySelectorAll("[data-wg-node]:not([data-decor])");' +   // 装饰节点（decor）不参与高度
    'for(var i=0;i<nodes.length;i++){' +
    '  var p=nodes[i].parentElement;var hidden=false;' +
    '  while(p&&p!==root){if(p.style&&(p.style.overflow==="hidden")){hidden=true;break;}p=p.parentElement;}' +
    '  if(hidden)continue;' +
    '  var b=nodes[i].getBoundingClientRect();var bottom=(b.bottom-rt)/' + scale + ';' +
    '  if(bottom>max)max=bottom;}' +
    'var pad=parseFloat(getComputedStyle(root).paddingBottom)||0;' +
    'var h=Math.max(1,Math.ceil(max+pad));' +
    'root.style.height=h+"px";' +
    'document.documentElement.style.height=(h*' + scale + ')+"px";' +
    'document.body.style.height=(h*' + scale + ')+"px";' +
    '})();<\/script>';
}

/**
 * 生成完整 HTML
 * @param {object} doc 归一化（且通常已 resolve）的文档
 * @param {object} opts { scale?, assetUrl?(src)=>string|null, title? }
 */
function buildHtml(doc, opts = {}) {
  const canvas = doc.canvas || {};
  const scale = Math.min(4, Math.max(1, Number(opts.scale || canvas.scale || 1)));
  const W = Math.max(1, Math.round(canvas.width || 720));
  const H = canvas.height > 0 ? Math.round(canvas.height) : 0;
  const nodes = (doc.nodes || []).map((n) => renderNode(n, opts)).filter(Boolean).join('\n');

  const rootStyle = [
    'position:relative',
    'width:' + W + 'px',
    H ? 'height:' + H + 'px' : 'height:auto',
    'background:' + (canvas.background || 'transparent'),
    canvas.radius ? 'border-radius:' + canvas.radius + 'px' : '',
    canvas.padding ? 'padding:' + canvas.padding + 'px' : '',
    'box-sizing:border-box',
    H ? 'overflow:hidden' : 'overflow:visible',
  ].filter(Boolean).join(';');

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<title>' + escapeHtml(doc.name || opts.title || 'WayGame 图片') + '</title>' +
    '<style>' +
    '*{box-sizing:border-box;}' +
    'html,body{margin:0;padding:0;background:transparent;}' +
    '#wg-stage{transform:scale(' + scale + ');transform-origin:top left;width:' + W + 'px;}' +
    (doc.baseCss || '') +
    '</style></head><body>' +
    // ⚠️ 绝对定位子元素的包含块是"内边距盒"，父级 padding 不会把它们推开。
    // 设计器是把节点放在"带 padding 的外层 + 内层 root"里（节点会被内缩），
    // 出图这边原来只有一层 → 有 padding 的布局在画布上内缩、出图却不内缩：所见非所得（2026-09-16 事故）。
    // 现在两边一致：root 负责背景/圆角/padding，#wg-inner 作为节点定位容器。
    '<div id="wg-stage"><div id="wg-root" style="' + rootStyle + '">' +
      '<div id="wg-inner" style="position:relative;width:100%">' + nodes + '</div>' +
    '</div></div>' +
    (H ? '' : autoHeightScript(scale)) +
    '</body></html>';
}

module.exports = { buildHtml, escapeHtml, styleToCss, scopeCss, safeId, autoHeightScript, barInner, richInner, renderFlowChild };
