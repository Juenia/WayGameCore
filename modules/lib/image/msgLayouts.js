/**
 * WayGame 图片模块 · 消息模板预设布局（v4 · 极简浅色）
 *
 * 依据（用户给的参考图，2026-09-16 用 Windows OCR + 像素统计读出来的）：
 *   参考图 ④「角色状态」1080×1128：深底/浅底都行，但结构是【标签：数值】一行一条，干净、字大、没装饰
 *   参考图 ③「问道长生·创角」1234×1343：浅底(亮度 238)+黑字，长文本直接排版，饱和度和装饰都极低
 *   参考图 ①「原神 UI」：二次元的"精致"来自立绘 + 克制面板，不是撒花瓣/加光斑/加 emoji 图标圈
 * 我前几版的问题：一个骨架换配色 → 撒装饰（花瓣/光斑/网点/星爆/立绘）→ 反而显脏；用户评价"丑"。
 * v4 的做法：**只做排版**。
 *   · 纯白底 + 一条 6px 主色顶条；
 *   · 标题 27px 800 深墨，下面 1px 细线；
 *   · 内容卡 = 白底 + 1px 浅灰描边 + 12 圆角，**无阴影、无渐变**；
 *   · 字段行 = 灰色小标签 + 深色粗数值，行间 1px 虚线；列表行 = 名称 + 数量/按钮；
 *   · 进度条 = 8px 扁平纯色；没有花瓣、光斑、网点、星爆、立绘、英文小字。
 *
 * 绑定：布局 id = room/template_key（四级绑定链第一级），sort = MSG_LAYOUT_SORT 标记为系统预置。
 */
'use strict';

// anime-msg-12（2026-09-17）：血条/蓝条改用 [[bar:值/上限]] 实时算宽度，修「角色信息」血量条永远 74% 的 BUG
// anime-msg-13（2026-09-22）：新增「指令帮助」菜单卡（repeat 结构化行），帮助菜单在图片模式下好看
const MSG_SEED_VERSION = 'anime-msg-13';
const MSG_LAYOUT_SORT = 900;
const MSG_STYLE = 'clean';

const INK = '#1B1730', INK2 = '#241E44', SUB = '#6E6A85', MUTE = '#9A96B0';
const LINE = '#E9EBF4', LINE2 = '#F1F2F9', TRACK = '#EEF0F8', PAGE = '#FFFFFF';

const ACC = { sakura: '#E8467C', sakuraDeep: '#D62F6A', sky: '#2E8FD8', cyan: '#13A2C6',
  lavender: '#7A5AD8', gold: '#C8861A', mint: '#12A06F' };

const MSG_ROOM_CN = {
  player: '角色', item: '物品', backpack: '背包', equipment: '装备', combat: '战斗',
  map: '地图', npc: 'NPC', quest: '任务', shop: '商店', signIn: '签到',
  profession: '职业', customCommand: '自定义', system: '系统',
};

/** 房间 / 模板键 / 中文名 / 图标(仅少量用于获得类) / 骨架 / 主色 / 是否带立绘(已弃用，保留字段兼容) */
const MSG_PLANS = [
  ['player', 'register.success', '注册成功', '✨', 'notice', 'sakura', 0],
  ['player', 'register.failed_exists', '重复注册', '🙈', 'warn', 'sakura', 0],
  ['player', 'register.failed_nickname', '昵称不合法', '📝', 'warn', 'sakura', 0],
  ['player', 'role.view', '角色信息', '💠', 'character', 'sky', 0],
  ['item', 'use.success', '使用物品', '💊', 'gain', 'mint', 0],
  ['item', 'use.not_enough', '数量不足', '🥺', 'warn', 'sakura', 0],
  ['backpack', 'view.success', '背包物品', '🎒', 'bag', 'sky', 0],
  ['backpack', 'drop.fail_not_enough', '丢弃失败', '🥺', 'warn', 'sakura', 0],
  ['backpack', 'submit.fail_not_enough', '上交失败', '🥺', 'warn', 'sakura', 0],
  ['equipment', 'equip.success', '装备成功', '👕', 'gain', 'mint', 0],
  ['equipment', 'unequip.success', '卸下装备', '🧺', 'gain', 'lavender', 0],
  ['equipment', 'unseal.success', '解封成功', '🔓', 'gain', 'gold', 0],
  ['equipment', 'view.slots', '装备栏', '🛡️', 'equip', 'sky', 0],
  ['equipment', 'view.success', '装备详情', '🛡️', 'equipdetail', 'lavender', 0],
  ['combat', 'attack.success', '攻击命中', '⚔️', 'battle', 'sakuraDeep', 0],
  ['combat', 'failure', '战斗失败', '💀', 'warn', 'sakuraDeep', 0],
  ['combat', 'monster.dead', '怪物已击败', '🏆', 'gain', 'gold', 0],
  ['combat', 'monster.enrage', '怪物狂暴', '💢', 'battle', 'sakuraDeep', 0],
  ['combat', 'monster.flee', '怪物逃跑', '💨', 'map', 'sky', 0],
  ['combat', 'status', '战斗回合', '⚔️', 'battle', 'sakuraDeep', 0],
  ['map', 'move.success', '移动到达', '🚶', 'map', 'sky', 0],
  ['map', 'pickup.success', '拾取物品', '👌', 'gain', 'mint', 0],
  ['map', 'view', '地图信息', '🗺️', 'map', 'sky', 0],
  ['npc', 'query_success', 'NPC 对话', '👤', 'dialog', 'lavender', 0],
  ['quest', 'accept_success', '接受任务', '📜', 'quest', 'gold', 0],
  ['quest', 'complete_success', '任务完成', '🎉', 'quest', 'gold', 0],
  ['shop', 'buy_success', '购买成功', '💰', 'gain', 'gold', 0],
  ['shop', 'list', '商店货架', '🛒', 'shop', 'cyan', 0],
  ['signIn', 'success', '每日签到', '📅', 'signin', 'gold', 0],
  ['profession', 'promote.success', '职业晋升', '🎊', 'levelup', 'gold', 0],
  ['profession', 'transfer.success', '转职成功', '🌟', 'levelup', 'lavender', 0],
  ['customCommand', 'hello', '自定义指令', '💬', 'notice', 'lavender', 0],
  // 2026-09-22：帮助菜单（指令「帮助 / 功能 / help / 菜单 / 指令」）—— 分类菜单卡
  ['customCommand', 'help', '指令帮助', '📖', 'help', 'lavender', 0],
  ['system', 'info', '系统通知', '📢', 'notice', 'sky', 0],
  ['system', 'error', '系统错误', '😵', 'warn', 'sakura', 0],
  ['system', 'invalid_command_args', '参数错误', '📝', 'warn', 'sakura', 0],
  ['system', 'invalid_command_usage', '命令格式错误', '📝', 'warn', 'sakura', 0],
  ['system', 'module_not_found', '功能未开放', '🚧', 'warn', 'lavender', 0],
  ['system', 'permission_denied', '权限不足', '🔒', 'warn', 'lavender', 0],
  ['system', 'player_not_found', '还没有角色', '👋', 'notice', 'sakura', 0],
];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ============================== 排版零件（极简） ==============================
/** 卡片：白底 + 1px 浅灰描边 + 12 圆角，无阴影无渐变 */
function card(id, x, y, w, inner, css, A) {
  return { id: id, type: 'html', name: '卡片', x: x, y: y, w: w, h: 0, style: { padding: '0' },
    css: '.c{border:1px solid ' + LINE + ';border-radius:12px;background:#FFFFFF;padding:18px 20px}' +
      '.c+.c{margin-top:12px}' +
      '.lb{font-size:13px;color:' + SUB + ';margin-bottom:10px;letter-spacing:.5px}' +
      '.f{display:flex;align-items:baseline;gap:12px;padding:9px 0;border-bottom:1px dashed ' + LINE2 + '}' +
      '.f:last-child{border-bottom:0;padding-bottom:0}' +
      '.f .k{width:76px;flex:0 0 76px;font-size:13px;color:' + MUTE + '}' +
      '.f .v{flex:1;font-size:16px;font-weight:700;color:' + INK2 + '}' +
      '.f .x{font-size:13px;color:' + SUB + '}' +
      '.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}' +
      '.bar{height:8px;border-radius:5px;background:' + TRACK + ';overflow:hidden;margin:6px 0 4px}' +
      '.bar i{display:block;height:100%;border-radius:5px;background:' + A + '}' +
      '.cap{font-size:13px;color:' + SUB + ';margin-bottom:10px}' +
      '.row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px dashed ' + LINE2 + '}' +
      '.row:last-child{border-bottom:0}' +
      '.row .nm{flex:1;font-size:16px;font-weight:700;color:' + INK2 + '}' +
      '.row .qt{font-size:15px;font-weight:700;color:' + A + '}' +
      '.row .bt{font-size:12px;color:' + SUB + ';border:1px solid ' + LINE + ';border-radius:8px;padding:2px 8px}' +
      '.body{font-size:16px;line-height:1.95;color:' + INK2 + ';white-space:pre-wrap;word-break:break-word}' +
      '.foot{font-size:12px;color:' + MUTE + ';text-align:right;margin-top:12px;padding-top:10px;border-top:1px solid ' + LINE2 + '}' +
      (css || ''),
    html: inner };
}
/** 字段行 */
function field(k, v, x) { return '<div class="f"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span>' + (x ? '<span class="x">' + x + '</span>' : '') + '</div>'; }

// ============================== 骨架 ==============================
const MSG_ARCH = {};

/** 角色信息：字段 + 双条 + 四格 */
MSG_ARCH.character = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="lb">基础</div>' +
    '<div class="grid">' +
      field('昵称', '[玩家昵称]') + field('性别', '[玩家性别]') +
      field('等级', 'Lv.[玩家等级]') + field('经验', '[玩家经验] EXP') +
      field('职业', '[玩家职业途径]') + field('序列', '[玩家职业序列]') +
    '</div>' +
    '<div class="lb" style="margin-top:16px">状态</div>' +
    // 血条/蓝条宽度必须按实时数值算（2026-09-17 · BUG 记录 2：以前写死 74% / 58%，永远不动）
    '<div class="cap">生命 [玩家生命] / [玩家生命上限]</div><div class="bar"><i style="width:[[bar:玩家生命/玩家生命上限]]"></i></div>' +
    '<div class="cap">魔法 [玩家魔法] / [玩家魔法上限]</div><div class="bar"><i style="width:[[bar:玩家魔法/玩家魔法上限]]"></i></div>' +
    '<div class="grid" style="margin-top:12px">' +
      field('攻击', '[玩家攻击]') + field('防御', '[玩家防御]') +
      field('暴击', '[玩家暴击率]%') + field('闪避', '[玩家闪避率]%') +
    '</div>' +
    '<div class="lb" style="margin-top:16px">位置与资产</div>' +
    field('位置', '[玩家位置]') +
    field('货币', '[玩家金币] 金 · [玩家银币] 银 · [玩家铜币] 铜 · [玩家特殊货币] 元宝'),
    '', A);
};
/** 背包：物品行 + 财富 */
MSG_ARCH.bag = function (A, plan) {
  // ⚠️ [if:变量] 是核心的【行级】标记，必须写在渲染文本行首
  let rows = '';
  for (let i = 1; i <= 5; i++) {
    rows += '[if:列表' + i + ']<div class="row"><span class="nm">{列表' + i + '.名}</span><span class="bt">{列表' + i + '.按钮}</span><span class="qt">×{列表' + i + '.数量}</span></div>\n';
  }
  return card('c1', 0, 0, 720,
    '<div class="lb">物品（第 {页码}/{总页数} 页）</div>\n' + rows +
    '<div class="lb" style="margin-top:16px">财富</div>' +
    field('货币', '{系统.货币1名}') +
    field('金币', '{玩家.金币|格式化}') +
    field('银币', '{玩家.银币|格式化}') +
    field('铜币', '{玩家.铜币|格式化}', '{上一页} {下一页}'),
    '', A);
};
/** 装备栏：部位行 + 战力 + 套装 */
MSG_ARCH.equip = function (A, plan) {
  let rows = '';
  for (let i = 1; i <= 5; i++) {
    rows += '[if:列表' + i + ']<div class="row"><span class="k" style="width:56px;flex:0 0 56px;font-size:13px;color:' + MUTE + '">{列表' + i + '.槽}</span><span class="nm">{列表' + i + '.名}</span><span class="bt">{列表' + i + '.按钮}</span></div>\n';
  }
  return card('c1', 0, 0, 720,
    '<div class="lb">部位（第 {页码}/{总页数} 页）</div>\n' + rows +
    '<div class="lb" style="margin-top:16px">战力</div>' +
    '<div class="grid">' + field('攻击', '{玩家.攻击}') + field('防御', '{玩家.防御}') + '</div>\n' +
    '[if:套装信息]<div class="lb" style="margin-top:16px">套装</div><div class="body">{套装信息}</div>',
    '', A);
};
/** 装备详情 */
MSG_ARCH.equipdetail = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="body" style="color:' + SUB + ';margin-bottom:14px">[装备介绍]</div>' +
    field('部位', '[装备所属部位]') +
    field('限制', 'Lv.[装备等级限制] / [装备职业限制]') +
    field('状态', '[装备封印状态]') +
    '<div class="lb" style="margin-top:16px">附加属性</div>' +
    '<div class="body">[装备提供基础属性]</div>',
    '', A);
};
/** 地图：简介 + 三行探索 + 方向 */
MSG_ARCH.map = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="body" style="color:' + SUB + ';margin-bottom:14px">[地图简介]</div>' +
    field('出没怪物', '[地图怪物]') +
    field('附近居民', '[地图NPC]') +
    field('可拾取', '[地图物品]') +
    '<div style="margin-top:14px">' + field('可往方向', '[地图连接方向数据]') + '</div>',
    '', A);
};
/** 商店 */
MSG_ARCH.shop = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="body" style="color:' + SUB + ';margin-bottom:14px">[商店介绍]</div>' +
    '<div class="lb">商品（共 [商品列表数] 件）</div>' +
    '<div class="body">[商品列表数据]</div>' +
    field('当前折扣', '[商店折扣] 折', ''),
    '', A);
};
/** 任务 */
MSG_ARCH.quest = function (A, plan) {
  const done = plan[1] === 'complete_success';
  return card('c1', 0, 0, 720,
    '<div class="body" style="font-size:20px;font-weight:800;margin-bottom:10px">[任务名]</div>' +
    (done ? field('状态', '已完成') + '<div class="body" style="margin-top:12px">[消息]</div>'
      : field('目标', '[任务条件]') + field('状态', '进行中')),
    '', A);
};
/** 签到：奖励 + 7 格 + 连签 */
MSG_ARCH.signin = function (A, plan) {
  let cells = '';
  for (let i = 1; i <= 7; i++) {
    cells += '<div style="flex:1;text-align:center;border:1px solid ' + LINE + ';border-radius:10px;padding:10px 0">' +
      '<div style="font-size:11px;color:' + MUTE + '">第' + i + '天</div>' +
      '<div style="font-size:15px;font-weight:800;color:' + (i <= 5 ? A : MUTE) + '">' + (i <= 5 ? '已签' : '未签') + '</div></div>';
  }
  return card('c1', 0, 0, 720,
    field('获得奖励', '[签到奖励]') +
    field('连续签到', '{streak} 天') +
    field('累计签到', '[签到天数] 天') +
    '<div style="display:flex;gap:8px;margin-top:14px">' + cells + '</div>',
    '', A);
};
/** 战斗：怪物行 + 双条 + 回合 */
MSG_ARCH.battle = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="f"><span class="k" style="width:76px;flex:0 0 76px;font-size:13px;color:' + MUTE + '">回合</span>' +
      '<span class="v">第 [当前回合] 回合</span><span class="x">[怪物狂暴状态]</span></div>' +
    field('怪物', '[怪物名]', 'Lv.[怪物等级]') +
    // 双血条同样按实时数值算（2026-09-17 · BUG 记录 2）
    '<div class="cap" style="margin-top:6px">怪物生命 [怪物生命] / [怪物生命上限]</div><div class="bar"><i style="width:[[bar:怪物生命/怪物生命上限]]"></i></div>' +
    '<div class="cap">[玩家昵称] 生命 [玩家生命] / [玩家生命上限]</div><div class="bar"><i style="width:[[bar:玩家生命/玩家生命上限]]"></i></div>',
    '', A);
};
/** 获得物品 */
MSG_ARCH.gain = function (A, plan) {
  const KEY = {
    'use.success': ['{物品名}', '{结果}'],
    'equip.success': ['{装备名}', '部位 {slotName} · {属性变化}'],
    'unequip.success': ['{装备名}', '已卸下 · {属性变化}'],
    'unseal.success': ['{装备名}', '封印已解除'],
    'monster.dead': ['[怪物名] 已击败', '经验 +[怪物经验奖励] · 掉落 [怪物掉落物]'],
    'pickup.success': ['{itemName}', '已放入背包'],
    'buy_success': ['[商品名]', '数量 ×[购买数量]'],
  }[plan[1]] || ['[消息]', ''];
  return card('c1', 0, 0, 720,
    '<div class="body" style="font-size:22px;font-weight:800;margin-bottom:10px">' + KEY[0] + '</div>' +
    (KEY[1] ? '<div class="body" style="color:' + SUB + '">' + KEY[1] + '</div>' : ''),
    '', A);
};
/** NPC 对话 */
MSG_ARCH.dialog = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="body" style="margin-bottom:14px">[NPC介绍]</div>' +
    '<div class="lb">可用功能</div>' +
    '<div class="body">[NPC功能列表]</div>',
    '', A);
};
/** 公告/通知 */
MSG_ARCH.notice = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="body">[消息]</div>' +
    '<div class="foot">{系统.游戏名} · {称呼}</div>',
    '', A);
};
/** 失败/错误 */
MSG_ARCH.warn = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="body">[消息]</div>' +
    '<div class="foot">检查一下再试一次</div>',
    ' .c{border-left:4px solid ' + A + ';padding-left:18px}', A);
};
/**
 * 指令帮助：分类 / 指令菜单
 * 数据源是 customCommandModule 现算的 {帮助列表JSON}（[{图标,标题,副标题,备注}]），
 * 走 repeat 一行为一张小卡 —— 比把整段文本塞进 .body 好看得多，且条目数不限。
 */
MSG_ARCH.help = function (A, plan) {
  return {
    id: 'card', type: 'repeat', name: '指令菜单', x: 26, y: 96, w: 668, h: 0,
    source: '帮助列表JSON',
    direction: 'column', gap: 8, columns: 2, max: 40,
    emptyText: '（暂无可用指令）',
    item: {
      id: 'row', type: 'html', w: 668, h: 0,
      css: '.mi{display:flex;align-items:center;gap:14px;padding:12px 18px;border-radius:12px;' +
        'background:' + LINE2 + ';border:1px solid ' + LINE + ';box-sizing:border-box}' +
        '.ic{width:30px;height:30px;flex:0 0 30px;border-radius:9px;background:#FFFFFF;border:1px solid ' + LINE + ';' +
        'display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;color:' + A + '}' +
        '.tx{flex:1;min-width:0}' +
        '.t{display:block;font-size:16px;font-weight:700;color:' + INK2 + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.s{display:block;font-size:12px;color:' + MUTE + ';margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.s:empty{display:none}' +
        '.mt{flex:0 0 auto;font-size:13px;font-weight:700;color:' + A + ';white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}',
      html: '<div class="mi"><div class="ic">[图标]</div><div class="tx">' +
        '<span class="t">[标题]</span><span class="s">[副标题]</span></div>' +
        '<div class="mt">[备注]</div></div>'
    }
  };
};

/** 晋升/升级 */
MSG_ARCH.levelup = function (A, plan) {
  return card('c1', 0, 0, 720,
    '<div class="body" style="font-size:30px;font-weight:800;text-align:center;margin:6px 0 14px">' + esc(plan[2]) + '</div>' +
    '<div class="body" style="text-align:center">[消息]</div>',
    '', A);
};

/** 生成一张消息模板预设布局文档（极简浅色） */
function buildMsgLayout(plan) {
  const room = plan[0], key = plan[1], cnName = plan[2], arch = plan[4];
  const A = ACC[plan[5]] || ACC.sky;
  const archFn = MSG_ARCH[arch] || MSG_ARCH.notice;
  const body = archFn(A, plan);
  const title = (MSG_ROOM_CN[room] || room) + ' · ' + cnName;
  const nodes = [
    // 顶部主色条
    // rect 是 SVG 形状：填充色要用 style.fill（用 background 是 CSS 属性，两个引擎都画不出来）
    { id: 'topbar', type: 'rect', x: 0, y: 0, w: 720, h: 6, decor: false, style: { fill: A } },
    // 标题
    { id: 'title', type: 'text', x: 26, y: 26, w: 560, h: 0, content: title,
      style: { fontSize: '27', fontWeight: '800', color: INK, lineHeight: '1.25' } },
    // line 必须写 w/h：缺省会走归一化默认值（100×40），在画布和出图里都白占 40px 高度
    { id: 'rule', type: 'line', x: 26, y: 66, w: 668, h: 0, x2: 694, y2: 66, style: { stroke: LINE, strokeWidth: '1' } },
    // 内容卡
    Object.assign(body, { id: 'card', x: 26, y: 84, w: 668 }),
  ];
  return {
    v: 1, id: room + '/' + key, name: title, room: room, templateKey: key, mode: 'scene', theme: MSG_STYLE,
    // padding 固定 0：边距直接写进节点坐标（26px），这样画布与出图两端必然一致
    canvas: { width: 720, height: 'auto', radius: 0, padding: 0, scale: 2, background: PAGE },
    baseCss: "#wg-root{font-family:'Microsoft YaHei','Segoe UI','PingFang SC',sans-serif;-webkit-font-smoothing:antialiased;color:" + INK2 + ';}',
    vars: { 称呼: '[玩家昵称]' },
    nodes: nodes,
  };
}

function labelOf(room, key) {
  const p = MSG_PLANS.filter(function (x) { return x[0] === room && x[1] === key; })[0];
  return (MSG_ROOM_CN[room] || room) + ' · ' + (p ? p[2] : key);
}
function buildMessageLayoutSeeds() {
  return MSG_PLANS.map(function (plan) {
    const doc = buildMsgLayout(plan);
    return { id: doc.id, name: doc.name, room: doc.room, templateKey: doc.templateKey, sort: MSG_LAYOUT_SORT, doc: doc };
  });
}

module.exports = {
  MSG_SEED_VERSION, MSG_LAYOUT_SORT, MSG_ROOM_CN, MSG_PLANS, MSG_ARCH, MSG_STYLE,
  buildMsgLayout, buildMessageLayoutSeeds, labelOf, ACC,
};
