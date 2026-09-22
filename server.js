/**
 * WayGame 核心启动器（常驻进程）
 * 用法：node server.js
 * 端点：GET /api/status  POST /api/reload  POST /api/command
 */
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const GameSystem = require('./core/GameSystem');
const databaseModule = require('./core/databaseModule');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;

let engine = null;
let server = null;
let SERVER_PORT = DEFAULT_PORT;   // 图片模块组装 image.url 时需要知道对外端口
const STARTED_AT = new Date().toISOString();

/**
 * 端口发现文件（2026-09-17）：插件端不再硬编码端口。
 * 核心启动时把「真实监听的地址」写到 data/，插件读文件即可；
 * 用户在编辑器「基础设置 → 核心端口」改完、重启核心，两边自动对齐。
 *   data/runtime.json   { host, port, url, pid, startedAt, online, updatedAt }
 *   data/server-url.txt 纯文本一行 URL（易语言 读入文件 直接拿，不用解析 JSON）
 * 核心关闭时删掉 server-url.txt —— 文件在 = 核心活着，文件没了 = 核心没跑。
 */
async function writeRuntimeInfo(online) {
  const url = 'http://' + HOST + ':' + SERVER_PORT;
  const info = {
    host: HOST, port: SERVER_PORT, url,
    pid: process.pid, startedAt: STARTED_AT,
    online: !!online, updatedAt: new Date().toISOString()
  };
  // 两处都写：项目内 data/ + 机器级 %LOCALAPPDATA%\WayGame\
  // 后者是「不会随项目移动」的固定位置，插件端读它最稳。
  const dirs = [path.join(__dirname, 'data')];
  try {
    const local = process.env.LOCALAPPDATA || os.homedir();
    dirs.push(path.join(local, 'WayGame'));
  } catch (_) {}
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'runtime.json'), JSON.stringify(info, null, 2), 'utf8');
      const file = path.join(dir, 'server-url.txt');
      if (online) await fs.writeFile(file, url + '\n', 'utf8');
      else await fs.unlink(file).catch(() => {});
    } catch (e) {
      console.warn('[server] 写端口发现文件失败 (' + dir + '): ' + e.message);
    }
  }
}

// 数据类模块（reload 无参数时按顺序重载）
// 2026-09-19 补：编辑器能编辑的内容类型里，原先只有 **地图** 和 **自定义指令** 不在这份名单里 ——
//   于是「改地图 → 点重载核心」和「新建一条自定义指令 → 点重载核心」都要重启核心才生效，
//   而编辑器界面照样显示「已重载」。地图模块重载后由下面的地图状态刷新兜底（模块自己不会重读库）。
const DATA_MODULES = ['item', 'combat', 'profession', 'quest', 'shop', 'npc', 'skill', 'equipmentSet', 'equipment', 'map', 'customCommand'];

/**
 * 编辑器「基础设置」→ 核心运行时状态对齐（2026-09-17）
 *
 * 背景：编辑器把「消息模式」写进数据库的 editor_settings.message_mode，
 * 而核心的 getMessageMode() 读的是 data/state.json 里的 state.settings.message_mode ——
 * 两边从来不同步（实测：editor_settings.message_mode=3「图片」，state.json 却是 2「Markdown」），
 * 于是"基础设置选了图片"对核心毫无影响，用户只会觉得"设置没生效 / 推送没按类型走"。
 *
 * 这里在核心启动、以及 /api/reload 时以编辑器为准同步一次，并把变化写进日志。
 */
async function syncEditorSettings() {
  try {
    const row = await engine.db.get("SELECT value FROM editor_settings WHERE key = 'message_mode'");
    const v = row && row.value !== undefined && row.value !== null ? parseInt(row.value, 10) : NaN;
    if (!Number.isFinite(v) || v < 1 || v > 3) return;
    engine.state.settings = engine.state.settings || {};
    const before = engine.state.settings.message_mode;
    if (Number(before) !== v) {
      engine.state.settings.message_mode = v;
      const label = { 1: '纯文本', 2: 'Markdown', 3: '图片' }[v] || v;
      console.log('[server] 消息模式以编辑器「基础设置」为准：' + (before === undefined ? '(默认)' : before) + ' → ' + v + '（' + label + '）');
      try { engine.log('info', '[server] 消息模式同步：' + (before === undefined ? '(默认)' : before) + ' → ' + v + '（' + label + '）'); } catch (e) {}
    }
  } catch (e) {
    console.warn('[server] 同步编辑器设置失败：' + e.message);
  }
}

async function boot() {
  engine = new GameSystem();
  await databaseModule(engine);
  const files = (await fs.readdir('./modules')).filter(f => f.endsWith('.js'));
  const mods = files.map(f => require('./modules/' + f));
  await engine.start({ modules: mods, databaseModule: engine.db });

  fixModulePaths(mods);
  await syncEditorSettings();

  let port = DEFAULT_PORT;
  try {
    const row = await engine.db.get("SELECT value FROM editor_settings WHERE key = 'server_port'");
    if (row && row.value) {
      const n = parseInt(row.value, 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) port = n;
    }
  } catch (e) {
    console.warn('[server] 读取 server_port 失败，使用默认 ' + DEFAULT_PORT);
  }
  return port;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * 图片字段装饰（2026-09-16）
 * - type=image：补 image{path,url,base64,w,h,hash,cached}；查不到元数据则给 imageError
 * - type=image 但模块已记录降级：把 type 降为 markdown/text 并说明原因
 * 字段只增不改，老插件不受影响。
 */
async function decorateImageFields(body, result, playerId) {
  try {
    const imgMod = engine && engine.getModule ? engine.getModule('image') : null;
    if (!imgMod) return body;
    if (body.type === 'image') {
      const ex = typeof imgMod.explain === 'function' ? imgMod.explain(playerId, (result && result.templateName) || '') : null;
      if (ex) {
        body.type = ex.type === 'text' ? 'text' : 'markdown';
        body.imageError = '图片渲染已降级为 ' + body.type + '：' + ex.reason + (ex.error ? '（' + ex.error + '）' : '');
        return body;
      }
      const meta = typeof imgMod.describe === 'function' ? await imgMod.describe(body.content, { port: SERVER_PORT }) : null;
      if (meta) body.image = meta;
      else body.imageError = '图片元数据缺失（缓存可能已被清理），content 仍为图片路径';
    }
  } catch (e) {
    body.imageError = '图片信息组装失败: ' + e.message;
  }
  return body;
}

/**
 * 模板回复模式（2026-09-16 新增）
 * 每个消息模板可以单独指定「纯文本 / Markdown / 图片」，覆盖全局 message_mode。
 * 逻辑全在 modules/templateModeModule.js（不动核心），这里只负责在消息出口上调用它。
 */
function getTemplateMode() {
  try { return engine && engine.getModule ? engine.getModule('templateMode') : null; } catch (e) { return null; }
}

async function applyTemplateMode(result, playerId, ctx) {
  const tm = getTemplateMode();
  if (!tm || typeof tm.apply !== 'function') return result;
  try { return await tm.apply(result, playerId, ctx); }
  catch (e) { console.warn('[server] 模板回复模式应用失败：' + e.message); return result; }
}

/**
 * 把 GBK 装不下的字符转成 \uXXXX（emoji 等）：
 * 易语言侧要把 UTF-8 响应转成 ANSI(GBK)，emoji 会变成 '?'；转成 \uXXXX 的 ASCII 就无损，
 * 而且 QQ/Bee 侧认得这种转义写法（与插件里 UTF8字节集_emoji转义 的做法一致）。
 */
function qqEscape(text) {
  return String(text == null ? '' : text).replace(/[\u{10000}-\u{10FFFF}]|[\u2000-\u2BFF]|[\uFE00-\uFE0F]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF) {
      const v = cp - 0x10000;
      const hi = 0xD800 + (v >> 10), lo = 0xDC00 + (v & 0x3FF);
      return '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0');
    }
    return '\\u' + cp.toString(16).padStart(4, '0');
  });
}

/** 主动推送的纯文本行格式（给易语言用，省得依赖 JSON 类）：
 *  id<TAB>type<TAB>target_id<TAB>channel<TAB>channel_id<TAB>msg_type<TAB>content
 *  content 里的 换行 → \n、制表 → 空格，emoji → \uXXXX */
function pushLine(r) {
  const content = qqEscape(String(r.content == null ? '' : r.content)).replace(/\r?\n/g, '\\n').replace(/\t/g, ' ');
  return [r.id, r.type, r.target_id == null ? '' : r.target_id, r.channel == null ? '' : r.channel,
    r.channel_id == null ? '' : r.channel_id, r.msg_type, content].join('\t');
}

/**
 * 把模块的真实文件路径补回核心注册表（2026-09-19）
 * =====================================================================
 * 为什么需要：模块是 require 进来的，注册表里的 file_path 可能是 'unknown'
 *   —— 凡是**在装载上下文之外**自己调用 registerModule 的模块都会这样
 *   （例如自定义指令模块是在 core:started 事件里注册的，那时装载早就结束了）。
 * 后果：reloadModule 靠 info.file_path 找文件 → 这类模块「重载模块 xxx」直接回
 *   「无有效文件路径，无法重载」，而 /api/reload 仍然回 HTTP 200，
 *   编辑器那边只看状态码，于是界面显示「已重载」、实际什么都没发生。
 * 做法：按 modules/ 目录里的真实文件名把路径补上（只写元数据，不碰运行状态）。
 * 调用点：核心启动后一次 + 每次 /api/reload 之前一次（后者是兜底：晚注册的模块也能被纠正，
 *   不依赖任何时序）。
 */
function fixModulePaths(mods) {
  try {
    if (!engine) return 0;
    const files = (Array.isArray(mods) && mods.length) ? mods : fs.readdirSync('./modules').filter((f) => f.endsWith('.js'));
    const reg = engine.moduleRegistry || {};
    let fixed = 0;
    for (const name of Object.keys(reg)) {
      const info = reg[name];
      if (!info || (info.file_path && info.file_path !== 'unknown')) continue;
      const hit = files.find(f => f.toLowerCase() === (name + 'Module.js').toLowerCase())
        || files.find(f => f.toLowerCase() === (name + '.js').toLowerCase());
      if (hit) { info.file_path = 'modules/' + hit; fixed++; }
    }
    if (fixed) console.log('[server] 已补回 ' + fixed + ' 个模块的文件路径（重载模块才找得到文件）');
    return fixed;
  } catch (e) { console.warn('[server] 补模块文件路径失败：' + e.message); return 0; }
}

function listModules() {
  if (!engine || !engine.modules) return [];
  if (engine.modules instanceof Map) return Array.from(engine.modules.keys());
  return Object.keys(engine.modules);
}

/* ---------- 事件端点用的小工具（校验口径与 modules/eventModule.js 保持一致）---------- */
function jstr(v) { return (typeof v === 'string') ? v : JSON.stringify(v === undefined ? null : v); }
function intOf(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }
function parseMaybe(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }     // null = 坏了
}
/** 返回错误人话，或空字符串（= 没问题） */
function validateSchedule(v) {
  const s = parseMaybe(v);
  if (s === null) return '排期不是合法 JSON';
  if (!s || typeof s !== 'object') return '排期要是个对象，例：{"kind":"once","start":"…","end":"…"}';
  const kind = String(s.kind || '');
  if (['once', 'daily', 'weekly'].indexOf(kind) < 0) return '排期 kind 只支持 once / daily / weekly，现在是「' + kind + '」';
  if (kind === 'once') {
    const a = new Date(s.start), b = new Date(s.end);
    if (!s.start || !s.end || isNaN(a.getTime()) || isNaN(b.getTime())) return '一次性活动要写合法的 start / end（例：2026-09-20T18:00:00）';
    if (b <= a) return '结束时间必须晚于开始时间';
  }
  if (kind === 'daily') {
    if (!/^\d{1,2}:\d{2}$/.test(String(s.from || '')) || !/^\d{1,2}:\d{2}$/.test(String(s.to || ''))) return '每日活动要写 from / to（例：20:00 / 21:00）';
  }
  if (kind === 'weekly') {
    const f = s.from || {}, t = s.to || {};
    const okDow = (x) => Number.isInteger(Number(x)) && Number(x) >= 0 && Number(x) <= 6;
    const okT = (x) => /^\d{1,2}:\d{2}$/.test(String(x || ''));
    if (!okDow(f.dow) || !okT(f.time) || !okDow(t.dow) || !okT(t.time)) return '每周活动要写 from/to 的 dow(0-6) 与 time（例：{"dow":5,"time":"18:00"}）';
  }
  return '';
}
function validateObjectives(v) {
  const arr = parseMaybe(v);
  if (arr === null) return '目标不是合法 JSON';
  if (!Array.isArray(arr) || !arr.length) return '至少要有一个目标';
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i] || {};
    const t = String(o.type || '');
    if (['kill', 'activity'].indexOf(t) < 0) return '第 ' + (i + 1) + ' 个目标的 type 只支持 kill（击杀）或 activity（活跃）';
    if (!(Number(o.count) > 0)) return '第 ' + (i + 1) + ' 个目标的 count 要大于 0';
    if (t === 'kill' && !String(o.name || '').trim()) return '第 ' + (i + 1) + ' 个击杀目标要填怪物名';
    const scope = String(o.scope || 'personal');
    if (['personal', 'global'].indexOf(scope) < 0) return '第 ' + (i + 1) + ' 个目标的 scope 只支持 personal / global';
  }
  return '';
}
/**
 * 事件链（活动触发活动，2026-09-20）：坏配置必须在**保存时**就被人话挡住 ——
 * 链是「这一期触发那一期」，配错了要等下一次活动开起来才会暴露，那时候玩家已经在等了。
 */
const CHAIN_TRIGGERS = ['open', 'settle', 'archive', 'personal_complete', 'milestone'];
const CHAIN_TRIGGER_TEXT = 'open（活动开启）/ settle（结算）/ archive（归档）/ personal_complete（有人达标）/ milestone（全服里程碑）';
function validateChain(v) {
  const arr = parseMaybe(v);
  if (arr === null) return '事件链不是合法 JSON';
  if (arr === undefined) return '';
  if (!Array.isArray(arr)) return '事件链要是一个数组，例：[{"on":"settle","target":"下个活动","action":"start"}]';
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i] || {};
    const on = String(r.on || '');
    if (CHAIN_TRIGGERS.indexOf(on) < 0) return '第 ' + (i + 1) + ' 条事件链的触发时机不对，只能是：' + CHAIN_TRIGGER_TEXT;
    if (!String(r.target || '').trim()) return '第 ' + (i + 1) + ' 条事件链没填「触发哪个活动」（要填对方的 key）';
    const action = String(r.action || 'start');
    if (action !== 'start' && action !== 'progress') return '第 ' + (i + 1) + ' 条事件链的动作只能是 start（开启一期）或 progress（推进度）';
    if (action === 'progress') {
      const oi = Number(r.objective);
      if (!Number.isInteger(oi) || oi < 0) return '第 ' + (i + 1) + ' 条事件链要写明推下游第几个目标（objective，从 0 开始数）';
      if (r.delta !== undefined && r.delta !== '' && !(Number(r.delta) > 0)) return '第 ' + (i + 1) + ' 条事件链的推进量（delta）要大于 0';
      const who = String(r.player || 'trigger');
      if (['trigger', 'all'].indexOf(who) < 0) return '第 ' + (i + 1) + ' 条事件链的推进对象只能是 trigger（触发者本人）或 all（下游全体）';
    }
  }
  return '';
}

async function handleRoute(req, res) {
  const { method, url } = req;

  if (method === 'GET' && url === '/api/status') {
    return sendJson(res, 200, {
      ok: true,
      uptime: process.uptime(),
      port: SERVER_PORT,
      url: 'http://' + HOST + ':' + SERVER_PORT,
      messageMode: engine.getMessageMode ? engine.getMessageMode() : null,   // 1 纯文本 / 2 Markdown / 3 图片
      modules: listModules(),
      stats: engine.stats || null
    });
  }

  // 2026-09-18：触发词总览（编辑器保存后读它来提示「撞车」—— 以前冲突只有核心日志知道，编辑器里一片安静）
  if (method === 'GET' && url === '/api/super/triggers') {
    const sup = engine.getModule('super');
    const list = (sup && typeof sup.triggers === 'function') ? sup.triggers() : [];
    return sendJson(res, 200, { ok: true, triggers: list });
  }

  // ============ 事件（活动）系统 · 编辑器端点（2026-09-19 P1）============
  // 为什么排期要问核心、而不是编辑器自己算：每周五 18:00 这种规则只有**一份实现**
  //（modules/eventModule.js 的 windowFor）。编辑器只显示核心算出来的结果，
  // 就不会出现「编辑器说周五会开、实际没开」两边漂移。
  if (method === 'GET' && url === '/api/event/list') {
    try {
      const defs = await engine.db.all('SELECT * FROM event_def ORDER BY key');
      const instances = await engine.db.all('SELECT * FROM event ORDER BY id DESC LIMIT 50');
      const actions = await engine.db.all('SELECT event_id, action, COUNT(*) c FROM event_log GROUP BY event_id, action');
      return sendJson(res, 200, { ok: true, defs, instances, actions });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (method === 'POST' && url === '/api/event/preview') {
    const body = await readJson(req);
    const mod = engine.getModule('event');
    const I = mod && mod._internals;
    if (!I || typeof I.windowFor !== 'function') return sendJson(res, 200, { ok: false, error: '事件模块没挂上（核心是不是旧进程？重启核心再试）' });
    const schedule = (body && body.schedule) || {};
    const bad = validateSchedule(schedule);
    if (bad) return sendJson(res, 200, { ok: false, error: bad });
    const count = Math.max(1, Math.min(6, parseInt(body && body.count, 10) || 3));
    const cursor0 = (body && body.now) ? new Date(body.now) : new Date();
    if (isNaN(cursor0.getTime())) return sendJson(res, 200, { ok: false, error: '假时间不是合法时间' });
    const windows = [];
    let cursor = cursor0;
    for (let i = 0; i < count; i++) {
      let win = null;
      try { win = I.windowFor(schedule, cursor); } catch (e) { return sendJson(res, 200, { ok: false, error: '排期算不出来：' + e.message }); }
      if (!win) break;
      const key = new Date(win.start).toISOString();
      if (windows.some((w) => w.start === key)) break;      // once 类：同一个窗口不重复列
      windows.push({ start: key, end: new Date(win.end).toISOString(), periodKey: String(win.periodKey) });
      cursor = new Date(new Date(win.end).getTime() + 60000);
    }
    return sendJson(res, 200, { ok: true, windows, from: cursor0.toISOString() });
  }

  if (method === 'POST' && url === '/api/event/save') {
    const body = await readJson(req);
    const def = (body && body.def) || {};
    const key = String(def.key || '').trim();
    if (!key) return sendJson(res, 200, { ok: false, error: '少了 key（活动代号）' });
    if (/\s/.test(key)) return sendJson(res, 200, { ok: false, error: 'key 里不能有空格' });
    const badSched = validateSchedule(def.schedule_json !== undefined ? def.schedule_json : def.schedule);
    if (badSched) return sendJson(res, 200, { ok: false, error: badSched });
    const objBad = validateObjectives(def.objectives_json !== undefined ? def.objectives_json : def.objectives);
    if (objBad) return sendJson(res, 200, { ok: false, error: objBad });
    const chainBad = validateChain(def.chain_json !== undefined ? def.chain_json : def.chain);
    if (chainBad) return sendJson(res, 200, { ok: false, error: chainBad });
    const now = new Date().toISOString();
    const cols = {
      key,
      name: String(def.name || key),
      category: String(def.category || 'hunt'),
      schedule_json: jstr(def.schedule_json !== undefined ? def.schedule_json : def.schedule),
      preview_min: intOf(def.preview_min, 0),
      claim_window_min: intOf(def.claim_window_min, 0),
      auto_grant: intOf(def.auto_grant, 1),
      late_grant: intOf(def.late_grant, 1),
      requirements_json: jstr(def.requirements_json !== undefined ? def.requirements_json : def.requirements || []),
      objectives_json: jstr(def.objectives_json !== undefined ? def.objectives_json : def.objectives || []),
      rewards_json: jstr(def.rewards_json !== undefined ? def.rewards_json : def.rewards || {}),
      caps_json: jstr(def.caps_json !== undefined ? def.caps_json : def.caps || {}),
      announce_json: jstr(def.announce_json !== undefined ? def.announce_json : def.announce || {}),
      chain_json: jstr(def.chain_json !== undefined ? def.chain_json : def.chain || []),
      enabled: intOf(def.enabled, 1),
      description: String(def.description || ''),
      updated_at: now
    };
    try {
      const exist = await engine.db.get('SELECT key FROM event_def WHERE key = ?', [key]);
      if (exist) {
        const sets = Object.keys(cols).filter((k) => k !== 'key').map((k) => k + ' = ?').join(', ');
        await engine.db.run('UPDATE event_def SET ' + sets + ' WHERE key = ?', Object.keys(cols).filter((k) => k !== 'key').map((k) => cols[k]).concat([key]));
      } else {
        await engine.db.run('INSERT INTO event_def (' + Object.keys(cols).join(', ') + ') VALUES (' + Object.keys(cols).map(() => '?').join(', ') + ')', Object.values(cols));
      }
      return sendJson(res, 200, { ok: true, key, created: !exist });
    } catch (e) { return sendJson(res, 200, { ok: false, error: '写库失败：' + e.message }); }
  }

  // 编辑器「立刻开一期 / 立刻结算」：本地编辑器与核心同信任级，不必走 GM 指令的 admin 权限
  if (method === 'POST' && url === '/api/event/start') {
    const body = await readJson(req);
    const mod = engine.getModule('event');
    const I = mod && mod._internals;
    if (!I || typeof I.startNow !== 'function') return sendJson(res, 200, { ok: false, error: '事件模块没挂上（重启核心再试）' });
    try {
      const r = await I.startNow(String((body && body.key) || ''), '编辑器');
      return sendJson(res, 200, r.ok ? { ok: true, periodKey: r.periodKey, id: r.instance && r.instance.id } : { ok: false, error: r.error });
    } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
  }
  if (method === 'POST' && url === '/api/event/end') {
    const body = await readJson(req);
    const mod = engine.getModule('event');
    const I = mod && mod._internals;
    if (!I || typeof I.endNow !== 'function') return sendJson(res, 200, { ok: false, error: '事件模块没挂上（重启核心再试）' });
    try {
      const r = await I.endNow(String((body && body.key) || ''), '编辑器');
      return sendJson(res, 200, r.ok ? { ok: true, report: r.report } : { ok: false, error: r.error });
    } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
  }

  if (method === 'GET' && url === '/api/datasources') {
    try {
      const list = (engine && typeof engine.listDataSources === 'function') ? engine.listDataSources() : [];
      return sendJson(res, 200, { ok: true, list });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 图片静态路由（2026-09-16）：仅为 type=image 的 image.url 服务，白名单 hash + 路径穿越校验
  if (method === 'GET' && url.startsWith('/img/')) {
    const name = url.slice(5).split('?')[0];
    if (!/^[a-f0-9]{40}.png$/.test(name)) return sendJson(res, 400, { ok: false, error: 'bad image name' });
    const file = path.join(__dirname, 'data', 'images', 'cache', name);
    const resolved = path.resolve(file);
    const base = path.resolve(path.join(__dirname, 'data', 'images', 'cache'));
    if (!resolved.startsWith(base)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    try {
      const buf = await fs.readFile(resolved);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch (e) {
      return sendJson(res, 404, { ok: false, error: 'image not found' });
    }
    return;
  }

  // 图片出图预览（2026-09-16 P1）：编辑器「出图预览」把布局文档发来，返回真实 PNG（base64）。
  // 这是「编辑器所见 = 核心所出」的保证：预览与实际发图走同一条渲染链路。
  if (method === 'POST' && url === '/api/image/render') {
    const body = await readJson(req);
    const imgMod = engine && engine.getModule ? engine.getModule('image') : null;
    if (!imgMod || typeof imgMod.render !== 'function') {
      return sendJson(res, 503, { ok: false, error: '图片模块未加载（核心版本过旧或模块被卸载）' });
    }
    const doc = body.doc && typeof body.doc === 'object' ? body.doc : null;
    if (!doc) return sendJson(res, 400, { ok: false, error: 'doc required' });
    try {
      const r = await imgMod.render(doc, { playerId: body.playerId || null, data: body.data || {}, noCache: true });
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error || r.reason, reason: r.reason, warnings: r.warnings || [] });
      return sendJson(res, 200, {
        ok: true,
        base64: r.image ? r.image.base64 : null,
        width: r.image ? r.image.width : 0,
        height: r.image ? r.image.height : 0,
        ms: r.ms,
        warnings: r.warnings || [],
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 素材库（2026-09-16 P1.5）：编辑器「素材库」页与其它工具用；文件落在 data/images/assets/
  if (method === 'GET' && url === '/api/image/assets') {
    const imgMod = engine && engine.getModule ? engine.getModule('image') : null;
    if (!imgMod || typeof imgMod.listAssets !== 'function') return sendJson(res, 503, { ok: false, error: '图片模块未加载' });
    try { return sendJson(res, 200, { ok: true, list: await imgMod.listAssets() }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  // 模板商店列表（P1.5）：编辑器直接读库，这里给脚本/其它工具用
  if (method === 'GET' && url === '/api/image/templates') {
    const imgMod = engine && engine.getModule ? engine.getModule('image') : null;
    if (!imgMod || typeof imgMod.listTemplates !== 'function') return sendJson(res, 503, { ok: false, error: '图片模块未加载' });
    try { return sendJson(res, 200, { ok: true, list: await imgMod.listTemplates() }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (method === 'POST' && url === '/api/image/assets/upload') {
    const body = await readJson(req);
    const imgMod = engine && engine.getModule ? engine.getModule('image') : null;
    if (!imgMod || typeof imgMod.addAsset !== 'function') return sendJson(res, 503, { ok: false, error: '图片模块未加载' });
    const r = await imgMod.addAsset({ name: body.name, dataUrl: body.dataUrl || body.data, mime: body.mime });
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // 素材引用检查（P1.5 第三批）：删除素材前看哪些布局在用，避免整图变空
  if (method === 'POST' && url === '/api/image/assets/usage') {
    const body = await readJson(req);
    const imgMod = engine && engine.getModule ? engine.getModule('image') : null;
    if (!imgMod || typeof imgMod.findAssetUsage !== 'function') return sendJson(res, 503, { ok: false, error: '图片模块未加载' });
    if (!body.id) return sendJson(res, 400, { ok: false, error: 'id required' });
    try { return sendJson(res, 200, { ok: true, used: await imgMod.findAssetUsage(String(body.id)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (method === 'POST' && url === '/api/image/assets/delete') {
    const body = await readJson(req);
    const imgMod = engine && engine.getModule ? engine.getModule('image') : null;
    if (!imgMod || typeof imgMod.deleteAsset !== 'function') return sendJson(res, 503, { ok: false, error: '图片模块未加载' });
    if (!body.id) return sendJson(res, 400, { ok: false, error: 'id required' });
    try { return sendJson(res, 200, await imgMod.deleteAsset(String(body.id))); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  // 素材取图：GET /imgasset/<id>（只从 data/images/assets 输出，模块侧带目录护栏）
  if (method === 'GET' && url.startsWith('/imgasset/')) {
    const id = decodeURIComponent(url.slice(10).split('?')[0]);
    const imgMod = engine && engine.getModule ? engine.getModule('image') : null;
    const hit = imgMod && typeof imgMod.getAssetPath === 'function' ? await imgMod.getAssetPath(id) : null;
    if (!hit) return sendJson(res, 404, { ok: false, error: 'asset not found' });
    try {
      const buf = await fs.readFile(hit.path);
      res.writeHead(200, { 'Content-Type': hit.mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch (e) {
      return sendJson(res, 404, { ok: false, error: 'asset read failed' });
    }
    return;
  }

  // 推送模式（2026-09-17）：callback = 核心把推送 POST 给插件；pull = 插件定时来取
  // pull 模式下核心内置推送工人会让路（core/GameSystem.js _isPullMode），避免「工人 + 插件」双发
  if (url === '/api/push/mode') {
    if (method === 'GET') {
      try {
        const row = await engine.db.get("SELECT value FROM editor_settings WHERE key = 'push_mode'");
        return sendJson(res, 200, { ok: true, mode: row && row.value ? String(row.value) : 'callback' });
      } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const mode = String(body.mode || '').trim().toLowerCase();
      if (mode !== 'pull' && mode !== 'callback') {
        return sendJson(res, 400, { ok: false, error: "mode 只能是 'pull' 或 'callback'" });
      }
      try {
        const now = new Date().toISOString();
        const exists = await engine.db.get("SELECT key FROM editor_settings WHERE key = 'push_mode'");
        if (exists) await engine.db.run('UPDATE editor_settings SET value = ?, updated_at = ? WHERE key = ?', [mode, now, 'push_mode']);
        else await engine.db.run('INSERT INTO editor_settings (key, value, updated_at) VALUES (?, ?, ?)', ['push_mode', mode, now]);
        return sendJson(res, 200, { ok: true, mode });
      } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }
  }

  // 主动推送 · 拉取模式（2026-09-16）：插件端不用起 HTTP 服务，定时来取即可
  //   POST /api/push/pull { plugin, limit }  → 认领一批 pending（转 sending，60 秒没 ack 自动归还）
  //   POST /api/push/ack  { ids:[...], ok, retry? }  → 确认送达（sent）/ 失败（默认停在 failed，不自动重发）
  //   POST /api/push/retry { ids? }                  → 手动补发（failed → pending）
  // player 类型的推送会把 player_routes 里的 channel/channel_id 一起带回去，插件据此决定发群还是发好友。
  if (method === 'POST' && url === '/api/push/pull') {
    const body = await readJson(req);
    const plugin = typeof body.plugin === 'string' ? body.plugin.trim() : '';
    const limit = Math.max(1, Math.min(50, parseInt(body.limit, 10) || 10));
    const now = new Date().toISOString();
    try {
      // 归还超时未确认的（60 秒）；不新增列，用 next_retry_at 当认领超时时间
      await engine.db.run("UPDATE push_queue SET status='pending' WHERE status='sending' AND next_retry_at IS NOT NULL AND next_retry_at <= ?", [now]);
      const sql = "SELECT q.id, q.type, q.target_id, q.msg_type, q.content, q.created_at, r.channel, r.channel_id " +
        "FROM push_queue q LEFT JOIN player_routes r ON r.player_id = q.target_id " +
        "WHERE q.status='pending' AND (q.next_retry_at IS NULL OR q.next_retry_at <= ?) " +
        (plugin ? 'AND q.plugin_url = ? ' : '') +
        "ORDER BY q.id ASC LIMIT " + limit;
      const rows = await engine.db.all(sql, plugin ? [now, plugin] : [now]);
      const claimUntil = new Date(Date.now() + 60000).toISOString();
      for (const r of rows) {
        await engine.db.run("UPDATE push_queue SET status='sending', next_retry_at=? WHERE id=? AND status='pending'", [claimUntil, r.id]);
      }
      // format:"text" → 纯文本 TSV（易语言端只要 分割文本，不需要 JSON 类）
      if (String(body.format || '').toLowerCase() === 'text') {
        const text = (rows || []).map(pushLine).join('\n');
        const buf = Buffer.from(text, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length });
        return res.end(buf);
      }
      return sendJson(res, 200, { ok: true, list: rows || [] });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 主动推送 · 送达确认（2026-09-17 修正：一条推送在群里出现三次的根因就在这里）
  // 旧行为：插件 ack ok:false → 核心按 retry*3 秒退回复试 → 插件再发一次 → 刷屏。
  //        实测：逻辑只跑了 1 次（运行历史 #5542），队列里只有 1 行（#104），却被投递了 4 次，
  //        群里出现 3 条 —— 因为"插件已发出、但自述失败"时核心会不停重发。
  // 新行为：ok:false 默认【不再自动重发】，直接判 failed 并把原因写进队列 + 核心日志；
  //        插件确实没发出去、重发安全时，显式带 retry:true 才退回复试；
  //        要补发：POST /api/push/retry { ids:[…] }。
  if (method === 'POST' && url === '/api/push/ack') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const ok = body.ok !== false;
    const allowRetry = body.retry === true;
    const now = new Date().toISOString();
    const failed = [];
    let done = 0;
    for (const id of ids) {
      try {
        if (ok) {
          await engine.db.run("UPDATE push_queue SET status='sent', sent_at=?, next_retry_at=NULL, error=NULL WHERE id=?", [now, id]);
        } else {
          const reason = String(body.error || '插件回报发送失败');
          if (allowRetry) {
            const row = await engine.db.get('SELECT retry_count, max_retry FROM push_queue WHERE id=?', [id]);
            const retry = ((row && row.retry_count) || 0) + 1;
            const maxRetry = (row && row.max_retry) || 3;
            if (retry >= maxRetry) {
              await engine.db.run("UPDATE push_queue SET status='failed', retry_count=?, next_retry_at=NULL, error=? WHERE id=?", [retry, reason + '（已达最大重试 ' + maxRetry + '）', id]);
              failed.push(id);
            } else {
              await engine.db.run("UPDATE push_queue SET status='pending', retry_count=?, next_retry_at=?, error=? WHERE id=?", [retry, new Date(Date.now() + retry * 3000).toISOString(), reason, id]);
            }
          } else {
            await engine.db.run("UPDATE push_queue SET status='failed', next_retry_at=NULL, error=? WHERE id=?", [reason + '（未自动重发，避免群里重复；要补发用 POST /api/push/retry）', id]);
            failed.push(id);
          }
        }
        done++;
      } catch (e) { /* 单条失败不影响其它 */ }
    }
    if (failed.length) {
      try { engine.log('warn', '[push] 插件回报发送失败，已停在队列里（不会自动重发）：#' + failed.join('、#')); } catch (e) {}
    }
    return sendJson(res, 200, { ok: true, count: done, failed: failed });
  }

  // 主动推送 · 手动补发（2026-09-17）：自动重发会刷屏，改成人来决定
  //   POST /api/push/retry { ids:[1,2] }  指定重发
  //   POST /api/push/retry {}             把当前所有 failed 重新排队（最多 200 条）
  if (method === 'POST' && url === '/api/push/retry') {
    const body = await readJson(req);
    let ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
    try {
      if (!ids.length) {
        const rows = await engine.db.all("SELECT id FROM push_queue WHERE status='failed' ORDER BY id ASC LIMIT 200");
        ids = (rows || []).map((r) => r.id);
      }
      let done = 0;
      for (const id of ids) {
        try {
          const r = await engine.db.run("UPDATE push_queue SET status='pending', retry_count=0, error=NULL, next_retry_at=NULL WHERE id=?", [id]);
          if (r && r.changes) done++;
        } catch (e) { /* 单条失败不影响其它 */ }
      }
      return sendJson(res, 200, { ok: true, count: done, ids: ids });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 主动推送 · 状态查询（2026-09-17 · BUG 记录 3）
  // 背景：push() 只把消息塞进 push_queue 就返回了，"到底送出去没有"以前没有任何地方能看：
  //       拉取模式下插件不来取就永远 pending，回调模式下 HTTP 失败也只是静默标 failed。
  // 用法：GET /api/push/status                  → 总览 + 最近 10 条
  //      GET /api/push/status?target_id=<玩家ID>&limit=20
  //      POST /api/push/status { target_id, limit }
  // status 含义：pending 待取 / sending 已被插件领走（60 秒没 ack 会自动归还）/ sent 已送达 / failed 重试用尽
  if (url === '/api/push/status' || url.startsWith('/api/push/status?')) {
    const qs = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : '';
    const q = {};
    for (const kv of qs.split('&')) {
      if (!kv) continue;
      const i = kv.indexOf('=');
      const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      q[k] = v;
    }
    let body = {};
    if (method === 'POST') { try { body = await readJson(req); } catch (e) { body = {}; } }
    const targetId = String(body.target_id || q.target_id || '').trim();
    const limit = Math.max(1, Math.min(100, parseInt(body.limit || q.limit, 10) || 10));
    try {
      const modeRow = await engine.db.get("SELECT value FROM editor_settings WHERE key = 'push_mode'");
      const mode = modeRow && modeRow.value ? String(modeRow.value) : 'callback';
      const counts = await engine.db.all('SELECT status, COUNT(*) AS n FROM push_queue GROUP BY status');
      const rows = await engine.db.all(
        'SELECT q.id, q.type, q.target_id, q.msg_type, q.status, q.retry_count, q.max_retry, q.error, q.created_at, q.sent_at, q.next_retry_at, ' +
        'substr(q.content, 1, 120) AS content, r.channel, r.channel_id, ' +
        // 两个 plugin_url 含义不同，必须分开命名：队列行的（pull 模式下是 'pull'）vs 玩家路由里的插件地址
        'q.plugin_url AS queue_plugin, r.plugin_url AS route_plugin ' +
        'FROM push_queue q LEFT JOIN player_routes r ON r.player_id = q.target_id ' +
        (targetId ? 'WHERE q.target_id = ? ' : '') +
        'ORDER BY q.id DESC LIMIT ' + limit,
        targetId ? [targetId] : []
      );
      const n = (s) => { const hit = (counts || []).find((c) => c.status === s); return hit ? Number(hit.n) : 0; };
      const hint = [];
      if (n('pending') > 0 && mode === 'pull') hint.push('有 ' + n('pending') + ' 条待取：拉取模式下必须由插件定时 POST /api/push/pull 来取，插件没开就永远躺在队列里');
      if (n('pending') > 0 && mode !== 'pull') hint.push('有 ' + n('pending') + ' 条待发：回调模式由核心每 5 秒 POST 给插件的 /api/push');
      if (n('sending') > 0) hint.push('有 ' + n('sending') + ' 条已被插件领走但还没 ack（60 秒后自动归还重发）');
      if (n('failed') > 0) hint.push('有 ' + n('failed') + ' 条发送失败，看 rows 里的 error');
      if (!hint.length) hint.push('队列里没有待处理/失败的推送（sent = 已确认送达）');
      return sendJson(res, 200, {
        ok: true, mode: mode,
        counts: { pending: n('pending'), sending: n('sending'), sent: n('sent'), failed: n('failed') },
        filter: targetId || null, rows: rows || [], hint: hint.join('；'),
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 模板回复模式（2026-09-16）：GET 列表 / POST 单条或批量设置 / POST preview 干跑预览
  // 编辑器也直接读写同一行 editor_settings，两边等价；这里是给脚本、测试和「试一下」用的
  if (url === '/api/template-modes') {
    const tm = getTemplateMode();
    if (!tm) return sendJson(res, 503, { ok: false, error: '模板回复模式模块未加载' });
    if (method === 'GET') {
      try { return sendJson(res, 200, { ok: true, list: await tm.list(), status: await tm.status() }); }
      catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }
    if (method === 'POST') {
      const body = await readJson(req);
      try {
        const r = Array.isArray(body.list) ? await tm.setMany(body.list) : await tm.set(body);
        return sendJson(res, r && r.ok ? 200 : 400, r);
      } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
    }
  }

  if (method === 'POST' && url === '/api/template-modes/preview') {
    const body = await readJson(req);
    const tm = getTemplateMode();
    if (!tm || typeof tm.preview !== 'function') return sendJson(res, 503, { ok: false, error: '模板回复模式模块未加载' });
    try {
      const r = await tm.preview(body);
      return sendJson(res, r && r.ok ? 200 : 400, r);
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (method === 'POST' && url === '/api/reload') {
    const body = await readJson(req);
    fixModulePaths();   // 兜底：晚注册的模块（装载上下文之外 registerModule 的）也能被找回来
    if (body.module) {
      const result = await engine.reloadModule(body.module);
      return sendJson(res, 200, { ok: true, module: body.module, result });
    }
    const results = {};
    for (const m of DATA_MODULES) {
      if (!listModules().includes(m)) continue;
      try { results[m] = await engine.reloadModule(m); }
      catch (e) { results[m] = { success: false, error: e.message }; }
    }
    // 2026-09-19 修：地图是**核心启动时**由 _loadGameDataFromDatabase() 从库刷进 state 的
    // （core/GameSystem.js:2578），而模块重载不会走那条路；mapModule 自己的守卫又只在 state 为空时读库。
    // 于是「改了地图 → 点重载核心」界面说成功、游戏里还是旧地图，非得重启核心。
    // 这里在重载后按库把地图刷一遍（口径与核心启动时一致：库里有就用库里的）。
    try {
      const maps = await engine.db.getAllMaps();
      if (maps.length > 0) {
        const mapObj = {};
        maps.forEach(m => { mapObj[m.name] = m; });
        engine.updateState('world.maps', mapObj);
        results['mapState'] = { success: true, maps: Object.keys(mapObj).length };
      }
    } catch (e) { results['mapState'] = { success: false, error: e.message }; }

    await engine.emit('data:reloaded');
    await syncEditorSettings();          // 编辑器改完「消息模式」点重载，也能立刻生效
    return sendJson(res, 200, { ok: true, results, messageMode: engine.getMessageMode() });
  }

  if (method === 'POST' && url === '/api/command') {
    const body = await readJson(req);
    if (!body.playerId || typeof body.text !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'playerId and text required' });
    }
    // 超级自定义 v2 S2（2026-09-15）：核心未命中时，交给 super 的兜底匹配（后缀/包含/正则/句中 super:）
    const sup = engine.getModule('super');
    // 四大块批次（2026-09-18）：先把上下文（群id/原文）交给 super，再问多轮状态 ——
    // 处于状态中的玩家，下一条消息不管内容都回到进入状态的那条逻辑（逻辑里用 [输入] 拿原文）
    if (sup && typeof sup.setInbound === 'function') {
      try { sup.setInbound(body.playerId, { groupId: body.groupId || '', userId: body.userId || body.playerId, text: body.text }); } catch (e) { /* 上下文失败不影响指令 */ }
    }
    let stHit = null;
    if (sup && typeof sup.routeState === 'function') {
      try { stHit = await sup.routeState(body.playerId, body.text); } catch (e) { stHit = null; }
    }
    let result = stHit || await engine.handleCommand(body.playerId, body.text);
    if (!stHit && sup && typeof sup.fallbackMatch === 'function' && /^未知指令/.test(String((result && result.content) || ''))) {
      const fb = await sup.fallbackMatch(body.playerId, body.text);
      if (fb) result = fb;
    }
    // 模板回复模式：按模板单独切换 纯文本 / Markdown / 图片
    result = await applyTemplateMode(result, body.playerId, { rawText: body.text });
    const out = { ok: true, result };
    if (result && result.type) await decorateImageFields(result, result, body.playerId);
    return sendJson(res, 200, out);
  }

  if (method === 'POST' && url === '/api/bee/message') {
    const body = await readJson(req);
    const groupId = body.groupId || '';
    const userId = body.userId || '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!userId || !text) {
      return sendJson(res, 400, { content: '', error: 'userId and text required' });
    }
    // 铁律：玩家 ID 直接使用插件端传来的 userId，不加任何前缀
    const playerId = userId;

    // 记录玩家路由（供主动推送用）
    try {
      const _now = new Date().toISOString();
      const _pluginUrl = body.plugin_url || 'http://127.0.0.1:3211';
      const _channel = groupId ? 'group' : 'private';
      const _channelId = groupId || userId;
      await engine.db.run("INSERT INTO player_routes (player_id, platform, channel, channel_id, user_id, plugin_url, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET channel = excluded.channel, channel_id = excluded.channel_id, user_id = excluded.user_id, plugin_url = excluded.plugin_url, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at", [playerId, 'bee', _channel, _channelId, userId, _pluginUrl, _now, _now, _now]);
    } catch (e) {
      console.warn('[server] 记录路由失败:', e.message);
    }
    // 注销角色特判（统一走核心的级联删除 db.deletePlayer —— 2026-09-14 优化，不再绕过核心）
    if (text === '注销角色' || text === '注销') {
      try {
        await engine.db.deletePlayer(playerId);
        try { engine.updateState('players.' + playerId, null); } catch (ee) {}
        // 注销时把多轮状态一起清掉，免得他重新注册后被老状态截走消息
        try { const s2 = engine.getModule('super'); if (s2 && typeof s2.clearState === 'function') await s2.clearState(playerId); } catch (ee) {}
        return sendJson(res, 200, { content: '✅ 角色已注销，输入【注册 昵称 男女】重新开始。', error: false });
      } catch (e) {
        return sendJson(res, 500, { content: '注销失败: ' + e.message, error: true });
      }
    }
    try {
      // 超级自定义 v2 S2（2026-09-15）：核心未命中时，交给 super 的兜底匹配（后缀/包含/正则/句中 super:）
      const sup = engine.getModule('super');
      // 四大块批次（2026-09-18）：上下文透传（群id/原文）+ 多轮状态优先
      if (sup && typeof sup.setInbound === 'function') {
        try {
          sup.setInbound(playerId, {
            groupId, userId, text,
            channel: groupId ? 'group' : 'private',
            channelId: groupId || userId,
          });
        } catch (e) { /* 上下文失败不影响指令 */ }
      }
      let stHit = null;
      if (sup && typeof sup.routeState === 'function') {
        try { stHit = await sup.routeState(playerId, text); } catch (e) { stHit = null; }
      }
      let result = stHit || await engine.handleCommand(playerId, text);
      if (!stHit && sup && typeof sup.fallbackMatch === 'function' && /^未知指令/.test(String((result && result.content) || ''))) {
        const fb = await sup.fallbackMatch(playerId, text);
        if (fb) result = fb;
      }
      // 模板回复模式（2026-09-16）：按模板单独切换 纯文本 / Markdown / 图片，覆盖全局 message_mode
      result = await applyTemplateMode(result, playerId, { rawText: text });
      const content = (result && result.content) || '';
      const msgType = (result && result.type) || 'text';
      const isUnknown = /^未知指令|玩家.*未注册|请先注册/i.test(content);
      const body = { content, type: msgType, error: !!(result && result.error), unknown: isUnknown };

      // 图片消息（2026-09-16）：type=image 时补 image 三件套（path/url/base64），字段只增不改。
      // 关键：图片渲染一旦降级（渲染子进程不可用 / 房间被排除 / 布局缺失 / 已关闭），
      //       content 已经是 markdown 文本，type 必须跟着降，否则插件会把文本当图片发。
      await decorateImageFields(body, result, playerId);
      return sendJson(res, 200, body);
    } catch (e) {
      return sendJson(res, 500, { content: '', error: e.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

async function main() {
  let port;
  try { port = await boot(); SERVER_PORT = port; }
  catch (e) {
    console.error('[server] boot failed:', e);
    process.exit(1);
  }

  server = http.createServer((req, res) => {
    handleRoute(req, res).catch(e => {
      try { sendJson(res, 500, { ok: false, error: e.message }); } catch (_) {}
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`[server] 端口 ${port} 被占用`);
    else console.error('[server] error:', e);
    process.exit(1);
  });

  server.listen(port, HOST, async () => {
    console.log(`[server] WayGame 核心已启动: http://${HOST}:${port}`);
    console.log('[server] 端点: GET /api/status  POST /api/reload  POST /api/command');
    await writeRuntimeInfo(true);
    console.log(`[server] 端口发现文件已写出: data/server-url.txt → http://${HOST}:${port}`);
  });
}

async function shutdown(sig) {
  console.log(`\n[server] 收到 ${sig}，正在关闭...`);
  try { await writeRuntimeInfo(false); } catch (_) {}
  try { if (server) await new Promise(r => server.close(r)); } catch (_) {}
  try { if (engine && typeof engine.stop === 'function') await engine.stop(); }
  catch (e) { console.error('[server] stop err:', e); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main();