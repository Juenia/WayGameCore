/**
 * WayGame 图片模块 · 内置种子布局
 * 目的：切到「图片模式」后立刻有图可看，不依赖可视化设计器（P1）。
 * 两份示例分别演示两条路线：
 *   global/default  —— CSS 绘制布局（流式排版，消息多长都不会溢出）
 *   example/draw    —— 自由绘制（矩形/圆/虚线/贝塞尔路径/文本变量，绝对定位）
 */
'use strict';

const GLOBAL_DEFAULT = {
  id: 'global/default',
  name: '通用卡片（CSS 流式）',
  room: 'global',          // 与 imageStore.resolveLayout 的第 4 级回退一致
  templateKey: 'default',
  mode: 'hybrid',
  canvas: {
    width: 720,
    height: 'auto',
    background: 'linear-gradient(160deg,#1b1e35 0%,#12142a 60%,#0d0f1f 100%)',
    radius: 0,
    padding: 0,
    scale: 2,
  },
  baseCss: "#wg-root{font-family:'Microsoft YaHei','Segoe UI','PingFang SC',sans-serif;-webkit-font-smoothing:antialiased;}",
  vars: {
    称呼: '[玩家昵称]',
    等级行: 'Lv.[玩家等级]',
  },
  nodes: [
    {
      id: 'glow',
      type: 'rect',
      name: '右上角光晕（自由绘制层）',
      x: -80, y: -90, w: 300, h: 300,
      style: { fill: 'rgba(120,150,255,0.20)', borderRadius: '150px' },
    },
    {
      id: 'main',
      type: 'html',
      name: '主卡片（CSS 流式布局）',
      x: 24, y: 24, w: 672, h: 0,
      style: { padding: '0', background: 'transparent' },
      css: [
        '.wg-card{padding:20px 22px;border-radius:18px;background:rgba(255,255,255,0.055);',
        'border:1px solid rgba(150,170,255,0.22);}',
        '.wg-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;',
        'border-bottom:1px solid rgba(150,170,255,0.18);padding-bottom:10px;margin-bottom:12px;}',
        '.wg-title{font-size:22px;font-weight:700;color:#eaefff;letter-spacing:0.5px;}',
        '.wg-sub{font-size:13px;color:#9aa6dd;white-space:nowrap;}',
        '.wg-body{font-size:16px;line-height:1.75;color:#dfe4ff;white-space:pre-wrap;word-break:break-word;}',
        '.wg-foot{margin-top:14px;font-size:12px;color:#7d88bb;text-align:right;}',
      ].join(''),
      html: '<div class="wg-card">' +
        '<div class="wg-head">' +
        '<div class="wg-title">🌏 {系统.游戏名}</div>' +
        '<div class="wg-sub">{称呼} · {等级行}</div>' +
        '</div>' +
        '<div class="wg-body">[消息]</div>' +
        '<div class="wg-foot">[玩家位置] · WayGame 图片引擎</div>' +
        '</div>',
    },
  ],
};

const EXAMPLE_DRAW = {
  id: 'example/draw',
  name: '自由绘制示例（绝对定位）',
  room: 'example',
  templateKey: 'draw',
  mode: 'scene',
  canvas: { width: 720, height: 380, background: '#0f1220', radius: 16, padding: 0, scale: 2 },
  baseCss: "#wg-root{font-family:'Microsoft YaHei','Segoe UI',sans-serif;}",
  vars: { 称呼: '[玩家昵称]' },
  nodes: [
    {
      id: 'panel', type: 'rect', name: '底板',
      x: 20, y: 20, w: 680, h: 340,
      style: { fill: 'rgba(255,255,255,0.05)', stroke: 'rgba(150,170,255,0.25)', strokeWidth: '1.5', borderRadius: '16px' },
    },
    {
      id: 'halo', type: 'ellipse', name: '光晕',
      x: 570, y: 40, w: 110, h: 110,
      style: { fill: 'rgba(120,150,255,0.18)' },
    },
    {
      id: 'title', type: 'text', name: '标题',
      x: 44, y: 52, w: 500, h: 0,
      content: '自由绘制示例',
      style: { fontSize: '28', fontWeight: '700', color: '#eaefff', letterSpacing: '1px' },
    },
    {
      id: 'subtitle', type: 'text', name: '说明',
      x: 44, y: 96, w: 520, h: 0,
      content: '矩形 / 圆 / 虚线 / 贝塞尔曲线 / 文本变量：{称呼}',
      style: { fontSize: '15', color: '#9aa6dd' },
    },
    {
      id: 'curve', type: 'path', name: '手绘曲线',
      x: 44, y: 170, w: 320, h: 90,
      d: 'M4 74 C 52 8, 116 86, 172 32 S 268 76, 312 10',
      style: { stroke: '#7cf0c0', strokeWidth: '5', fill: 'none' },
    },
    {
      id: 'halo2', type: 'ellipse', name: '曲线端点',
      x: 336, y: 168, w: 18, h: 18,
      style: { fill: '#ffd479' },
    },
    {
      id: 'divider', type: 'line', name: '虚线分隔',
      x: 44, y: 296, x2: 676, y2: 296,
      style: { stroke: 'rgba(150,170,255,0.35)', strokeWidth: '2', strokeDasharray: '6 6' },
    },
    {
      id: 'body', type: 'text', name: '正文',
      x: 44, y: 244, w: 620, h: 0,
      content: '[消息]',
      style: { fontSize: '16', color: '#dfe4ff', lineHeight: '1.6' },
    },
  ],
};

const SEED_LAYOUTS = [GLOBAL_DEFAULT, EXAMPLE_DRAW];

// ============================== 模板商店内置模板 · 二次元动漫风（P1.5 第五批） ==============================
// 设计语言：深夜紫蓝底 + 樱花粉/天青/薰衣草/金色点缀，圆角卡片、柔光、斜光条、星芒、渐变条。
// 目标：13 套模板合起来覆盖全部 11 种节点（rect/ellipse/line/path/text/image/html/group/bar/repeat/rich_text）
//       与全部关键特性（渐变/圆角/旋转/透明度/阴影/虚线/clip-path/backdrop-filter/自适应高/参考线/vars 预设）。
const PALETTE = {
  bgDeep: 'linear-gradient(165deg,#1b1740 0%,#151234 45%,#0d0b20 100%)',
  bgSoft: 'linear-gradient(150deg,#241b4d 0%,#171236 60%,#100c26 100%)',
  sakura: '#FF9EC4',
  sakuraSoft: 'rgba(255,158,196,0.22)',
  sky: '#7FE7FF',
  skySoft: 'rgba(127,231,255,0.20)',
  lavender: '#C9A7FF',
  gold: '#FFD479',
  mint: '#7CF0C0',
  text: '#F3EEFF',
  sub: '#B0A3E0',
  mute: '#7C6FA8',
  panel: 'rgba(255,255,255,0.065)',
  panelBorder: 'rgba(201,167,255,0.30)',
};
const BASE_CSS = "#wg-root{font-family:'Microsoft YaHei','Segoe UI','PingFang SC',sans-serif;-webkit-font-smoothing:antialiased;color:" + PALETTE.text + ';}';

/** 柔光圆斑（动漫常见的环境光） */
function glow(id, x, y, size, color, opacity, extra) {
  return { id: id, type: 'rect', x: x, y: y, w: size, h: size, name: '柔光', decor: true,
    style: Object.assign({ background: 'radial-gradient(circle,' + color + ' 0%,rgba(0,0,0,0) 70%)', borderRadius: String(size / 2) + 'px', opacity: opacity === undefined ? 1 : opacity }, extra || {}) };
}
/** 斜光条（速度线/高光） */
function streak(id, x, y, w, h, rotate, from, to, opacity) {
  return { id: id, type: 'rect', x: x, y: y, w: w, h: h, rotate: rotate, name: '斜光条', decor: true, opacity: opacity === undefined ? 0.5 : opacity,
    gradient: { from: from, to: to, angle: 90 }, style: { borderRadius: '999px' } };
}
/** 星芒（四角星路径） */
function sparkle(id, x, y, size, color, opacity) {
  return { id: id, type: 'path', x: x, y: y, w: size, h: size, name: '星芒', decor: true, opacity: opacity === undefined ? 1 : opacity,
    d: 'M' + (size / 2) + ' 0 L' + (size * 0.62) + ' ' + (size * 0.38) + ' L' + size + ' ' + (size / 2) + ' L' + (size * 0.62) + ' ' + (size * 0.62) +
       ' L' + (size / 2) + ' ' + size + ' L' + (size * 0.38) + ' ' + (size * 0.62) + ' L0 ' + (size / 2) + ' L' + (size * 0.38) + ' ' + (size * 0.38) + ' Z',
    close: true, style: { fill: color, stroke: 'none' } };
}
/** 细分割线（可选虚线） */
function divider(id, x, y, w, color, dash) {
  return { id: id, type: 'line', x: x, y: y, x2: x + w, y2: y, name: '分割线',
    style: Object.assign({ stroke: color || 'rgba(201,167,255,0.35)', strokeWidth: '1.5' }, dash ? { strokeDasharray: dash } : {}) };
}
/** 头像：外圈光环 + 圆形图 */
function avatar(id, x, y, size, ring, src) {
  const kids = [
    { id: id + 'ring', type: 'ellipse', x: -4, y: -4, w: size + 8, h: size + 8, style: { fill: 'none', stroke: ring || PALETTE.sakura, strokeWidth: '3' } },
    { id: id + 'halo', type: 'ellipse', x: -12, y: -12, w: size + 24, h: size + 24, decor: true, style: { background: 'radial-gradient(circle,' + (ring || PALETTE.sakura) + '55 0%,rgba(0,0,0,0) 70%)' } },
    { id: id + 'pic', type: 'image', x: 0, y: 0, w: size, h: size, src: src || 'asset:avatar', style: { objectFit: 'cover', borderRadius: String(size / 2) + 'px' } },
  ];
  return { id: id, type: 'group', name: '头像', x: x, y: y, w: size, h: size, children: kids };
}
/** 进度条（动漫渐变） */
function barNode(id, x, y, w, h, value, max, text, from, to, bg) {
  return { id: id, type: 'bar', x: x, y: y, w: w, h: h, value: value, max: max, text: text,
    fill: 'linear-gradient(90deg,' + (from || PALETTE.mint) + ',' + (to || PALETTE.sky) + ')',
    style: { background: bg || 'rgba(255,255,255,0.12)', borderRadius: String(h / 2) + 'px' },
    textStyle: { color: '#FFFFFF', fontSize: '12', textShadow: '0 1px 2px rgba(0,0,0,.5)' } };
}
/** 列表（repeat） */
function listRepeat(id, x, y, w, source, item, opts) {
  const o = opts || {};
  return Object.assign({ id: id, type: 'repeat', x: x, y: y, w: w, source: source,
    direction: o.direction || 'column', gap: o.gap === undefined ? 8 : o.gap, columns: o.columns || 2,
    max: o.max || 20, emptyText: o.emptyText || '', item: item }, {});
}
/** 动漫画风面板（html 节点，带柔光边与圆角） */
function panel(id, x, y, w, h, inner, extraCss, styleExtra) {
  return { id: id, type: 'html', name: '面板', x: x, y: y, w: w, h: h || 0,
    style: Object.assign({ padding: '0' }, styleExtra || {}),
    css: '.pnl{position:relative;padding:18px 20px;border-radius:20px;background:' + PALETTE.panel +
      ';border:1px solid ' + PALETTE.panelBorder + ';box-shadow:0 10px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.08);' +
      'backdrop-filter:blur(2px);}' + (extraCss || ''),
    html: inner };
}
function tplDoc2(id, name, category, description, doc) {
  return {
    id: id, name: name, category: category, description: description, sort: doc.sort || 100,
    doc: Object.assign({
      v: 1, id: 'tpl/' + String(id).replace(/^tpl\//, ''), name: name, room: 'tpl', templateKey: 'preview', mode: 'hybrid',
      canvas: { width: 720, height: 'auto', background: PALETTE.bgDeep, radius: 0, padding: 0, scale: 2,
        guides: [{ dir: 'v', at: 360 }] },
      baseCss: BASE_CSS,
      vars: { 称呼: '[玩家昵称]', 等级行: 'Lv.[玩家等级]', 战力: '{玩家攻击} * 10' },
    }, doc),
  };
}

const SEED_TEMPLATES = [
  // 1) 通用卡片：html 流式 + 柔光 + 富文本签名（最常用，任何消息可套）
  tplDoc2('tpl/card', '通用卡片 · 樱花', '通用', '标题飘带 + 玩家信息 + 正文，任何消息都能直接套用（html 流式）', {
    sort: 10,
    canvas: { width: 720, height: 'auto', background: PALETTE.bgDeep, radius: 0, padding: 0, scale: 2 },
    nodes: [
      glow('glowA', -90, -110, 340, 'rgba(255,158,196,0.30)'),
      glow('glowB', 520, 240, 300, 'rgba(127,231,255,0.22)'),
      panel('card', 24, 24, 672, 0,
        '<div class="pnl"><div class="hd"><div class="tt">[消息标题]</div><div class="ss">{称呼} · {等级行}</div></div>' +
        '<div class="bd">[消息]</div>' +
        '<div class="ft"><span class="dot"></span><span class="fz">{系统.游戏名}</span></div></div>',
        '.hd{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-bottom:10px;margin-bottom:12px;border-bottom:1px dashed rgba(201,167,255,.35)}' +
        '.tt{font-size:23px;font-weight:800;letter-spacing:.5px;background:linear-gradient(90deg,#FFD0E4,#FF9EC4 45%,#C9A7FF);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 18px rgba(255,158,196,.35)}' +
        '.ss{font-size:12px;color:' + PALETTE.sub + ';white-space:nowrap}' +
        '.bd{font-size:16px;line-height:1.85;color:#EAE4FF;white-space:pre-wrap;word-break:break-word}' +
        '.ft{display:flex;align-items:center;gap:6px;margin-top:14px;font-size:11px;color:' + PALETTE.mute + '}' +
        '.dot{width:6px;height:6px;border-radius:50%;background:' + PALETTE.sakura + ';box-shadow:0 0 8px ' + PALETTE.sakura + '}'),
      sparkle('sp1', 636, 40, 26, PALETTE.gold, 0.9),
      sparkle('sp2', 596, 96, 16, PALETTE.sky, 0.75),
    ],
  }),

  // 2) 剧情对话：动漫对话框 + 头像 + 名字牌（group/image/ellipse/text 组合）
  tplDoc2('tpl/dialog', '剧情对话 · 对话框', '剧情', '动漫风对话框 + 圆形头像 + 名字牌，适合 NPC 对话/剧情旁白', {
    sort: 20,
    canvas: { width: 720, height: 'auto', background: PALETTE.bgSoft, radius: 0, padding: 0, scale: 2 },
    nodes: [
      glow('glowA', 40, -80, 320, 'rgba(201,167,255,0.28)'),
      avatar('ava', 32, 60, 108, PALETTE.sakura, 'asset:avatar'),
      { id: 'nameTag', type: 'html', x: 156, y: 60, w: 320, h: 40,
        style: { padding: '0' },
        css: '.tag{display:inline-block;padding:6px 18px 6px 16px;border-radius:0 14px 14px 0;background:linear-gradient(90deg,' + PALETTE.sakura + ',' + PALETTE.lavender + ');color:#2A1030;font-weight:800;font-size:16px;letter-spacing:1px;box-shadow:0 6px 16px rgba(255,158,196,.35)}',
        html: '<span class="tag">{称呼}</span>' },
      { id: 'bubble', type: 'html', x: 156, y: 116, w: 540, h: 0,
        style: { padding: '0' },
        css: '.bub{position:relative;padding:20px 24px;border-radius:20px;background:rgba(255,255,255,0.92);color:#241A3A;font-size:17px;line-height:1.8;box-shadow:0 14px 34px rgba(0,0,0,.4)}' +
          '.bub:before{content:"";position:absolute;left:-16px;top:26px;border:9px solid transparent;border-right-color:rgba(255,255,255,.92)}' +
          '.bub .em{color:#C2418A;font-weight:700}',
        html: '<div class="bub">[消息]</div>' },
      divider('sep', 32, 300, 656, 'rgba(201,167,255,0.28)', '4 6'),
      { id: 'hint', type: 'rich_text', x: 32, y: 316, w: 656, h: 0, style: { fontSize: '13', lineHeight: '1.6' },
        segments: [{ text: '▸ ', style: { color: PALETTE.sky } }, { text: '点击继续', style: { color: PALETTE.sub } },
          { text: '　·　「{系统.游戏名}」', style: { color: PALETTE.mute } }] },
      sparkle('sp1', 640, 250, 22, PALETTE.gold, 0.85),
    ],
  }),

  // 3) 战斗结算：血条 bar + 掉落 repeat + rich_text + 分割线
  tplDoc2('tpl/battle', '战斗结算 · 对决', '战斗', '伤害标题 + 双血条 + 正文 + 掉落列表（bar/repeat/rich_text/line）', {
    sort: 30,
    canvas: { width: 720, height: 'auto', background: 'linear-gradient(170deg,#2A1030 0%,#1A0F2E 45%,#0C0818 100%)', radius: 0, padding: 0, scale: 2 },
    nodes: [
      glow('glowA', -60, -80, 300, 'rgba(255,90,120,0.30)'),
      glow('glowB', 500, 60, 320, 'rgba(127,231,255,0.20)'),
      { id: 'banner', type: 'rect', x: -40, y: 22, w: 240, h: 44, rotate: -14, opacity: 0.9,
        gradient: { from: 'rgba(255,158,196,0.85)', to: 'rgba(201,167,255,0.15)', angle: 90 }, style: { borderRadius: '10px' } },
      { id: 'title', type: 'rich_text', x: 28, y: 30, w: 660, h: 0, style: { fontSize: '26', lineHeight: '1.3' },
        segments: [{ text: '⚔️ ', style: {} }, { text: '战斗结算', style: { color: '#FFE9F3', fontWeight: '800', textShadow: '0 0 22px rgba(255,120,160,.55)' } },
          { text: '　BATTLE', style: { color: 'rgba(255,158,196,.75)', fontSize: '13', letterSpacing: '4px' } }] },
      { id: 'hpLabel', type: 'text', x: 28, y: 78, w: 400, h: 0, content: '生命 [玩家生命] / [玩家生命上限]',
        style: { fontSize: '13', color: PALETTE.sub } },
      barNode('hp', 28, 100, 660, 15, '[玩家生命]', '[玩家生命上限]', '', '#FF7A9A', '#FF4D6D'),
      { id: 'mpLabel', type: 'text', x: 28, y: 124, w: 400, h: 0, content: '魔法 [玩家魔法] / [玩家魔法上限]',
        style: { fontSize: '13', color: PALETTE.sub } },
      barNode('mp', 28, 146, 660, 11, '[玩家魔法]', '[玩家魔法上限]', '', '#7FE7FF', '#7C9BFF'),
      panel('msgPanel', 28, 172, 660, 118, '<div class="pnl"><div class="msg">[消息]</div></div>',
        '.msg{font-size:16px;line-height:1.85;color:#F0EAFF;white-space:pre-wrap}'),
      divider('sep', 28, 306, 660, 'rgba(255,158,196,0.35)'),
      { id: 'dropTitle', type: 'rich_text', x: 28, y: 318, w: 660, h: 0, style: { fontSize: '15' },
        segments: [{ text: '💎 ', style: {} }, { text: '战利品', style: { color: PALETTE.gold, fontWeight: '700' } }] },
      listRepeat('drops', 28, 346, 660, 'filteredItems', { id: 'row', type: 'rich_text', w: 660, h: 0, segments: [
        { text: '◆ ', style: { color: PALETTE.sakura } },
        { text: '[名称]', style: { color: '#FFE9F3' } },
        { text: ' ×[数量]', style: { color: PALETTE.gold, fontWeight: '700' } }] },
        { gap: 6, max: 12, emptyText: '（本次没有掉落）' }),
    ],
  }),

  // 4) 升级庆祝：大字 + 斜光条 + 星芒 + 进度条（强调 rotate/opacity/path）
  tplDoc2('tpl/levelup', '升级庆祝 · 闪耀', '通用', '升级大字 + 斜光条 + 星芒 + 经验条，适合等级/成就播报', {
    sort: 40,
    canvas: { width: 720, height: 'auto', background: 'radial-gradient(circle at 50% 0%,#3A1D5C 0%,#1A1030 55%,#0B0818 100%)', radius: 0, padding: 0, scale: 2 },
    nodes: [
      streak('st1', -80, 60, 420, 16, -18, 'rgba(255,212,121,0.75)', 'rgba(255,212,121,0)', 0.55),
      streak('st2', 380, 30, 460, 12, -18, 'rgba(127,231,255,0.7)', 'rgba(127,231,255,0)', 0.45),
      streak('st3', -40, 190, 380, 10, -18, 'rgba(255,158,196,0.7)', 'rgba(255,158,196,0)', 0.4),
      sparkle('sp1', 96, 96, 34, PALETTE.gold, 0.95),
      sparkle('sp2', 592, 132, 26, PALETTE.sakura, 0.9),
      sparkle('sp3', 620, 60, 16, PALETTE.sky, 0.8),
      { id: 'kicker', type: 'text', x: 0, y: 62, w: 720, h: 0, content: 'LEVEL UP',
        style: { fontSize: '14', letterSpacing: '10px', textAlign: 'center', color: 'rgba(255,212,121,.85)' } },
      { id: 'big', type: 'text', x: 0, y: 86, w: 720, h: 0, content: '等级提升！',
        style: { fontSize: '44', fontWeight: '800', textAlign: 'center', letterSpacing: '2px',
          background: 'linear-gradient(90deg,#FFD0E4,#FFD479 45%,#7FE7FF)', backgroundClip: 'text', WebkitBackgroundClip: 'text', color: 'transparent',
          textShadow: '0 0 28px rgba(255,212,121,.35)' } },
      { id: 'sub', type: 'rich_text', x: 0, y: 146, w: 720, h: 0, style: { fontSize: '15', textAlign: 'center' },
        segments: [{ text: '{称呼}', style: { color: PALETTE.sky, fontWeight: '700' } },
          { text: ' 达到了 ', style: { color: PALETTE.sub } },
          { text: 'Lv.[玩家等级]', style: { color: PALETTE.gold, fontWeight: '800', fontSize: '18' } }] },
      panel('expPanel', 60, 196, 600, 122,
        '<div class="pnl"><div class="lb">经验值</div><div class="ex">[消息]</div></div>',
        '.lb{font-size:12px;color:' + PALETTE.sub + ';margin-bottom:8px;letter-spacing:1px}' +
        '.ex{font-size:15px;line-height:1.75;color:#EFE9FF;white-space:pre-wrap}'),
      barNode('exp', 120, 332, 480, 14, '[玩家等级]', '100', 'Lv.[玩家等级] / 100', '#FFD479', '#FF9EC4'),
      sparkle('sp4', 60, 300, 20, PALETTE.lavender, 0.85),
    ],
  }),

  // 5) 角色卡：头像 group + 双条 + 富文本属性（image/group/ellipse/bar/rich_text）
  tplDoc2('tpl/profile', '角色卡 · 名片', '社交', '圆形头像 + 光晕 + 等级/经验条 + 属性富文本，适合查看资料/名片', {
    sort: 50,
    nodes: [
      glow('glowA', -70, -90, 320, 'rgba(255,158,196,0.28)'),
      glow('glowB', 470, 200, 340, 'rgba(127,231,255,0.20)'),
      panel('card', 24, 24, 672, 216,
        '<div class="pnl" style="padding-left:120px">' +
        '<div class="top"><div class="nt">{称呼}</div><div class="lv">Lv.[玩家等级]</div></div>' +
        '<div class="line"></div>' +
        '<div class="st"><span class="k">生命</span><span class="v">[玩家生命] / [玩家生命上限]</span></div>' +
        '<div class="st"><span class="k">攻击</span><span class="v hl">[玩家攻击]</span></div>' +
        '<div class="st"><span class="k">防御</span><span class="v">[玩家防御]</span></div>' +
        '<div class="st"><span class="k">职业</span><span class="v">[玩家职业途径] · [玩家职业序列]</span></div>' +
        '<div class="st"><span class="k">位置</span><span class="v">[玩家位置]</span></div>' +
        '<div class="ft">战力 {战力}</div>' +
        '</div>',
        '.top{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:12px}' +
        '.nt{font-size:24px;font-weight:800;color:#FFF2FA;text-shadow:0 0 18px rgba(255,158,196,.45)}' +
        '.lv{padding:3px 12px;border-radius:999px;background:linear-gradient(90deg,' + PALETTE.sakura + ',' + PALETTE.lavender + ');color:#2A1030;font-weight:800;font-size:15px}' +
        '.line{height:1px;background:linear-gradient(90deg,rgba(255,158,196,.6),rgba(201,167,255,0));margin-bottom:12px}' +
        '.st{display:flex;justify-content:space-between;font-size:15px;padding:6px 0;border-bottom:1px dotted rgba(201,167,255,.18)}' +
        '.k{color:' + PALETTE.sub + '}.v{color:#EFE9FF}.hl{color:' + PALETTE.gold + ';font-weight:700}' +
        '.ft{margin-top:14px;text-align:right;font-size:13px;color:' + PALETTE.mint + ';letter-spacing:1px}'),
      avatar('ava', 44, 62, 76, PALETTE.sky, 'asset:avatar'),   // 落在面板内部（面板 y=24 + 内边距）
    ],
  }),

  // 6) 排行榜：repeat 网格 + 前三高亮（css nth-child）+ 分割线
  tplDoc2('tpl/rank', '排行榜 · 荣耀榜', '社交', '名次列表（repeat + 行模板 HTML，前三名 CSS 高亮）', {
    sort: 60,
    nodes: [
      glow('glowA', 480, -100, 340, 'rgba(255,212,121,0.22)'),
      { id: 'title', type: 'rich_text', x: 28, y: 28, w: 660, h: 0, style: { fontSize: '26' },
        segments: [{ text: '🏆 ', style: {} }, { text: '[消息]', style: { color: '#FFF2FA', fontWeight: '800', textShadow: '0 0 20px rgba(255,212,121,.4)' } }] },
      { id: 'sub', type: 'text', x: 28, y: 72, w: 660, h: 0, content: 'RANKING · 本期榜单',
        style: { fontSize: '12', letterSpacing: '4px', color: 'rgba(201,167,255,.75)' } },
      divider('sep', 28, 98, 660, 'rgba(255,212,121,0.30)'),
      listRepeat('list', 28, 116, 660, 'rankRows', { id: 'row', type: 'html', w: 660, h: 0,
        css: '.r{display:flex;align-items:center;gap:12px;padding:11px 16px;border-radius:14px;background:rgba(255,255,255,0.055);border:1px solid rgba(201,167,255,.18)}' +
          '.no{width:28px;height:28px;flex:0 0 auto;border-radius:50%;background:rgba(201,167,255,.22);color:#EDE6FF;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center}' +
          '.nm{flex:1;font-size:16px;color:#EFE9FF}.vv{font-size:16px;font-weight:800;color:' + PALETTE.gold + '}' +
          '.r:nth-child(1){background:linear-gradient(90deg,rgba(255,212,121,.22),rgba(255,212,121,.02));border-color:rgba(255,212,121,.55)}' +
          '.r:nth-child(1) .no{background:linear-gradient(135deg,#FFD479,#FF9EC4);color:#3A1D00}' +
          '.r:nth-child(2){background:linear-gradient(90deg,rgba(201,167,255,.20),rgba(201,167,255,.02))}' +
          '.r:nth-child(3){background:linear-gradient(90deg,rgba(127,231,255,.18),rgba(127,231,255,.02))}',
        html: '<div class="r"><span class="no">[序号]</span><span class="nm">[名称]</span><span class="vv">[数值]</span></div>' },
        { gap: 8, max: 20, emptyText: '（暂无排名）' }),
      sparkle('sp1', 640, 40, 22, PALETTE.gold, 0.9),
    ],
  }),

  // 7) 背包列表：repeat 行内带缩略图（image 在行模板里）+ 空列表提示
  tplDoc2('tpl/bag', '背包列表 · 物品栏', '日常', '物品行（行模板含缩略图 + 数量角标 + 稀有度色），空背包有提示', {
    sort: 70,
    nodes: [
      glow('glowA', -80, 120, 320, 'rgba(127,231,255,0.20)'),
      panel('head', 24, 24, 672, 96, '<div class="pnl"><div class="t">🎒 背包</div><div class="s">共 [消息]</div></div>',
        '.t{font-size:22px;font-weight:800;color:#F6F0FF}' +
        '.s{font-size:13px;color:' + PALETTE.sub + ';margin-top:6px}'),
      listRepeat('items', 24, 132, 672, 'filteredItems', { id: 'row', type: 'html', w: 672, h: 0,
        css: '.it{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:14px;background:rgba(255,255,255,0.05);border-left:3px solid ' + PALETTE.sakura + '}' +
          '.ic{width:34px;height:34px;flex:0 0 auto;border-radius:10px;background:linear-gradient(135deg,rgba(255,158,196,.35),rgba(127,231,255,.28));display:flex;align-items:center;justify-content:center;font-size:16px}' +
          '.nm{flex:1;font-size:16px;color:#F0EAFF}.ct{font-size:14px;color:' + PALETTE.gold + ';font-weight:700}',
        html: '<div class="it"><div class="ic">◆</div><div class="nm">[名称]</div><div class="ct">×[数量]</div></div>' },
        { gap: 6, max: 20, emptyText: '（背包空空如也，去冒险吧！）' }),
    ],
  }),

  // 8) 任务委托：进度条 + 富文本 + 清单（bar/rich_text/html）
  tplDoc2('tpl/quest', '任务委托 · 委托板', '日常', '委托标题 + 目标进度条 + 正文 + 勾选清单', {
    sort: 80,
    nodes: [
      glow('glowA', 500, -90, 320, 'rgba(201,167,255,0.26)'),
      { id: 'tag', type: 'html', x: 28, y: 28, w: 200, h: 36, style: { padding: '0' },
        css: '.q{display:inline-block;padding:5px 14px;border-radius:999px;background:linear-gradient(90deg,' + PALETTE.lavender + ',' + PALETTE.sky + ');color:#221046;font-weight:800;font-size:13px;letter-spacing:1px}',
        html: '<span class="q">QUEST</span>' },
      { id: 'title', type: 'text', x: 28, y: 72, w: 660, h: 0, content: '[消息]',
        style: { fontSize: '22', fontWeight: '800', color: '#F6F0FF', lineHeight: '1.4' } },
      { id: 'plabel', type: 'text', x: 28, y: 118, w: 660, h: 0, content: '完成度',
        style: { fontSize: '13', color: PALETTE.sub } },
      barNode('prog', 28, 140, 660, 14, '[玩家等级]', '100', '', PALETTE.lavender, PALETTE.sky),
      panel('obj', 28, 168, 660, 178,
        '<div class="pnl"><div class="ol">' +
        '<div class="ob"><span class="ck">✔</span><span>击败 10 只史莱姆</span></div>' +
        '<div class="ob"><span class="ck">✔</span><span>采集 5 份星屑</span></div>' +
        '<div class="ob done"><span class="ck">○</span><span>向[玩家位置]的委托员复命</span></div>' +
        '</div><div class="rw">奖励：<b>300</b> 经验 · <b>120</b> 铜币</div></div>',
        '.ol{display:flex;flex-direction:column;gap:8px}' +
        '.ob{display:flex;align-items:center;gap:10px;font-size:15px;color:#EFE9FF}' +
        '.ob .ck{color:' + PALETTE.mint + ';font-weight:800}' +
        '.ob.done{color:' + PALETTE.mute + '}.ob.done .ck{color:' + PALETTE.mute + '}' +
        '.rw{margin-top:14px;padding-top:12px;border-top:1px dashed rgba(201,167,255,.3);font-size:14px;color:' + PALETTE.gold + '}'),
      divider('sep', 28, 362, 660, 'rgba(201,167,255,0.25)', '3 5'),
    ],
  }),

  // 9) 商店：repeat 网格商品卡（grid 方向 + 列数）
  tplDoc2('tpl/shop', '商店 · 便利店', '日常', '商品网格（repeat grid + 行模板卡片），价格与库存', {
    sort: 90,
    nodes: [
      glow('glowA', -60, -70, 300, 'rgba(127,231,255,0.22)'),
      { id: 'title', type: 'rich_text', x: 28, y: 28, w: 660, h: 0, style: { fontSize: '24' },
        segments: [{ text: '🛒 ', style: {} }, { text: '[消息]', style: { color: '#F6F0FF', fontWeight: '800' } }] },
      { id: 'sub', type: 'text', x: 28, y: 70, w: 660, h: 0, content: 'SHOP · 今日上架',
        style: { fontSize: '12', letterSpacing: '4px', color: 'rgba(127,231,255,.7)' } },
      listRepeat('goods', 28, 100, 660, 'filteredItems', { id: 'card', type: 'html', w: 316, h: 0,
        css: '.g{padding:14px;border-radius:16px;background:rgba(255,255,255,0.06);border:1px solid rgba(127,231,255,.25);box-shadow:0 8px 22px rgba(0,0,0,.3)}' +
          '.gn{font-size:16px;font-weight:700;color:#F2ECFF;margin-bottom:8px}' +
          '.gp{display:flex;justify-content:space-between;align-items:center;font-size:14px}' +
          '.pc{color:' + PALETTE.gold + ';font-weight:800}.st{color:' + PALETTE.sub + ';font-size:12px}',
        html: '<div class="g"><div class="gn">[名称]</div><div class="gp"><span class="pc">[数值] 铜币</span><span class="st">库存 [数量]</span></div></div>' },
        { direction: 'grid', columns: 2, gap: 12, max: 12, emptyText: '（今日暂无上架商品）' }),
      sparkle('sp1', 636, 36, 20, PALETTE.sky, 0.85),
    ],
  }),

  // 10) 签到卡：7 天格子（html 网格）+ 连签进度条 + 星芒
  tplDoc2('tpl/signin', '每日签到 · 星愿', '日常', '七天签到格子 + 连签进度 + 奖励说明，适合签到/活动', {
    sort: 100,
    nodes: [
      glow('glowA', 420, -110, 360, 'rgba(255,212,121,0.22)'),
      { id: 'title', type: 'rich_text', x: 28, y: 28, w: 660, h: 0, style: { fontSize: '24' },
        segments: [{ text: '📅 ', style: {} }, { text: '{称呼}', style: { color: PALETTE.gold, fontWeight: '800' } },
          { text: ' 的每日签到', style: { color: '#F6F0FF', fontWeight: '700' } }] },
      panel('grid', 28, 76, 660, 186,
        '<div class="pnl"><div class="wk">' +
        '<div class="d on"><b>1</b><span>✔</span></div><div class="d on"><b>2</b><span>✔</span></div>' +
        '<div class="d on"><b>3</b><span>✔</span></div><div class="d today"><b>4</b><span>今</span></div>' +
        '<div class="d"><b>5</b><span>·</span></div><div class="d"><b>6</b><span>·</span></div>' +
        '<div class="d gift"><b>7</b><span>🎁</span></div>' +
        '</div><div class="tip">[消息]</div></div>',
        '.wk{display:flex;gap:8px;justify-content:space-between}' +
        '.d{flex:1;aspect-ratio:1/1;border-radius:14px;background:rgba(255,255,255,0.05);border:1px solid rgba(201,167,255,.22);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:' + PALETTE.sub + ';font-size:12px}' +
        '.d b{font-size:15px;color:#EFE9FF}.d span{font-size:11px}' +
        '.d.on{background:linear-gradient(160deg,rgba(255,158,196,.35),rgba(255,158,196,.08));border-color:rgba(255,158,196,.6);color:#FFD9E8}' +
        '.d.today{background:linear-gradient(160deg,rgba(255,212,121,.4),rgba(255,212,121,.08));border-color:' + PALETTE.gold + ';box-shadow:0 0 16px rgba(255,212,121,.45)}' +
        '.d.gift{border-style:dashed;border-color:rgba(127,231,255,.55)}' +
        '.tip{margin-top:14px;font-size:14px;line-height:1.7;color:#EAE4FF;white-space:pre-wrap}'),
      { id: 'sl', type: 'text', x: 28, y: 278, w: 660, h: 0, content: '连续签到进度',
        style: { fontSize: '13', color: PALETTE.sub } },
      barNode('streak', 28, 300, 660, 14, '[玩家等级]', '30', '已连签 [玩家等级] 天 / 30 天', PALETTE.gold, PALETTE.sakura),
      sparkle('sp1', 640, 210, 24, PALETTE.gold, 0.9),
      sparkle('sp2', 70, 236, 18, PALETTE.sakura, 0.8),
    ],
  }),

  // 11) 公告横幅：斜光条 + 渐变 + 图片横幅（image 节点做装饰图）
  tplDoc2('tpl/announce', '公告横幅 · 活动', '通用', '活动/公告横幅：斜光条 + 封面图 + 标题与正文（image/streak/rect）', {
    sort: 110,
    nodes: [
      { id: 'cover', type: 'rect', x: 0, y: 0, w: 720, h: 190,
        gradient: { from: 'rgba(255,158,196,0.55)', to: 'rgba(127,231,255,0.35)', angle: 120 }, style: {} },
      { id: 'coverImg', type: 'image', x: 0, y: 0, w: 720, h: 190, src: 'asset:banner', decor: true, opacity: 0.55, style: { objectFit: 'cover' } },
      streak('st1', -60, 120, 420, 18, -16, 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0)', 0.35),
      streak('st2', 300, 20, 460, 14, -16, 'rgba(255,212,121,0.55)', 'rgba(255,212,121,0)', 0.4),
      { id: 'badge', type: 'html', x: 28, y: 26, w: 220, h: 34, style: { padding: '0' },
        css: '.b{display:inline-block;padding:5px 14px;border-radius:999px;background:rgba(20,12,36,.72);color:' + PALETTE.gold + ';font-size:12px;letter-spacing:2px;border:1px solid rgba(255,212,121,.5)}',
        html: '<span class="b">EVENT · 限时活动</span>' },
      { id: 'title', type: 'text', x: 28, y: 74, w: 664, h: 0, content: '[消息]',
        style: { fontSize: '27', fontWeight: '800', color: '#FFFFFF', lineHeight: '1.35', textShadow: '0 2px 12px rgba(0,0,0,.55)' } },
      panel('body', 28, 210, 664, 0, '<div class="pnl"><div class="tx">{称呼}，快来看看本期活动详情：</div><div class="ct">[消息]</div></div>',
        '.tx{font-size:13px;color:' + PALETTE.sub + ';margin-bottom:8px}' +
        '.ct{font-size:16px;line-height:1.85;color:#F2ECFF;white-space:pre-wrap}'),
      sparkle('sp1', 640, 150, 26, '#FFFFFF', 0.9),
    ],
  }),

  // 12) 提示条：紧凑样式（成功/失败通用），emoji + 图标圆圈
  tplDoc2('tpl/tips', '提示条 · 极简', '通用', '紧凑提示（成功/失败/警告通用），图标 + 一句话', {
    sort: 120,
    nodes: [
      glow('glowA', -60, -60, 240, 'rgba(124,240,192,0.22)'),
      panel('tip', 24, 24, 672, 0,
        '<div class="pnl"><div class="row"><div class="ic">✓</div><div class="tx">[消息]</div></div>' +
        '<div class="sg">— {系统.游戏名}</div></div>',
        '.row{display:flex;align-items:flex-start;gap:14px}' +
        '.ic{width:38px;height:38px;flex:0 0 auto;border-radius:50%;background:linear-gradient(150deg,' + PALETTE.mint + ',' + PALETTE.sky + ');color:#0B2018;font-weight:900;font-size:20px;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(124,240,192,.35)}' +
        '.tx{flex:1;font-size:16px;line-height:1.7;color:#F2ECFF;white-space:pre-wrap}' +
        '.sg{margin-top:10px;text-align:right;font-size:12px;color:' + PALETTE.mute + '}'),
    ],
  }),
];
// 消息模板预设布局（二次元美少女风）已独立成 modules/lib/image/msgLayouts.js（2026-09-16 重做）
// 这里只做转发，保持旧引用可用。
const msgLayouts = require('./msgLayouts');

module.exports = {
  SEED_LAYOUTS, SEED_TEMPLATES, GLOBAL_DEFAULT, EXAMPLE_DRAW, PALETTE, BASE_CSS,
  TEMPLATE_SEED_VERSION: 'anime-1',
  MSG_SEED_VERSION: msgLayouts.MSG_SEED_VERSION,
  MSG_LAYOUT_SORT: msgLayouts.MSG_LAYOUT_SORT,
  MSG_PLANS: msgLayouts.MSG_PLANS,
  buildMsgLayout: msgLayouts.buildMsgLayout,
  buildMessageLayoutSeeds: msgLayouts.buildMessageLayoutSeeds,
};

// ============================== 旧版通用模板（保留兼容，不再作为内置种子） ==============================
function tplDoc(id, name, category, description, title, body, nodes) {
  return {
    id: id, name: name, category: category, description: description, sort: 100,
    doc: {
      v: 1, id: 'tpl/' + String(id).replace(/^tpl\//, ''), name: name, room: 'tpl', templateKey: 'preview', mode: 'hybrid',
      canvas: { width: 720, height: 'auto', background: 'linear-gradient(160deg,#1b1e35 0%,#12142a 60%,#0d0f1f 100%)', radius: 0, padding: 0, scale: 2 },
      baseCss: "#wg-root{font-family:'Microsoft YaHei','Segoe UI',sans-serif;color:#e9ecff;}",
      vars: { 称呼: '[玩家昵称]' },
      nodes: nodes || [
        { id: 'glow', type: 'rect', x: -80, y: -90, w: 300, h: 300, style: { fill: 'rgba(120,150,255,0.20)', borderRadius: '150px' } },
        { id: 'card', type: 'html', x: 24, y: 24, w: 672, h: 0, style: { padding: '0' },
          css: '.c{padding:20px 22px;border-radius:18px;background:rgba(255,255,255,0.055);border:1px solid rgba(150,170,255,0.22)}' +
            '.h{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid rgba(150,170,255,0.18);padding-bottom:10px;margin-bottom:12px}' +
            '.t{font-size:22px;font-weight:700;color:#eaefff}.s{font-size:13px;color:#9aa6dd}' +
            '.b{font-size:16px;line-height:1.75;color:#dfe4ff;white-space:pre-wrap}',
          html: '<div class="c"><div class="h"><div class="t">' + title + '</div><div class="s">{称呼} · Lv.[玩家等级]</div></div>' +
            '<div class="b">' + body + '</div></div>' },
      ],
    },
  };
}

// 旧版 4 套通用模板已被上方 anime-1 套装取代（tplDoc 保留供参考/回退，不再导出）
