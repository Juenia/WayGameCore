/**
 * WayGame 图片模块 · 渲染子进程（Electron 主进程）
 * 设计：docs/图片消息模块设计-v1.md §5
 *
 * 职责：接收「完整 HTML + 画布尺寸」，用 Chromium 离屏渲染成 PNG，回传 base64。
 * 入口：由 modules/lib/image/imageRender.js 以子进程方式拉起（stdio: ignore/pipe/pipe）。
 * 协议（仅 127.0.0.1 + 每次启动随机 token）：
 *   GET  /health  -> { ok, pid, electron, mode, busy }
 *   POST /render  -> { html, width, height(0=auto), scale, format:'png'|'jpeg', quality, timeoutMs }
 *                 <- { ok:true, base64, width, height, ms } | { ok:false, error }
 *   POST /shutdown-> { ok:true }（token 保护，父进程退出前调用）
 *
 * 环境变量：
 *   WG_IMG_PORT     监听端口（默认 3212）
 *   WG_IMG_TOKEN    Bearer token（必填才会启动 HTTP）
 *   WG_IMG_TMP      临时 HTML 目录
 *   WG_IMG_CAPTURE  auto | hidden | offscreen（默认 auto：先隐藏窗口 capturePage，空帧则切离屏 paint）
 *   WG_IMG_PARENT_PID 父进程 pid（父死则自杀，防孤儿）
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.WG_IMG_PORT || '3212', 10);
const TOKEN = process.env.WG_IMG_TOKEN || '';
const TMP_DIR = process.env.WG_IMG_TMP || path.join(__dirname, '..', '..', '..', 'data', 'images', 'tmp');
const CAPTURE_PREF = String(process.env.WG_IMG_CAPTURE || 'auto').toLowerCase();
const PARENT_PID = parseInt(process.env.WG_IMG_PARENT_PID || '0', 10);
const MAX_BODY = 16 * 1024 * 1024; // 16MB：内联 base64 素材留足余量

// 长图保护（2026-09-20）：单张图允许的最大像素数，超过就按 sqrt 比例降 scale 重截一次。
// 为什么加：同一模板实测 —— 20 行 = 1440x4248（611 万像素，561ms / 1.0MB PNG）；
//   100 行 = 1440x20951（3016 万像素，1303ms / 3.7MB）；300 行 = 1440x62707（3532ms / 10MB）。
//   渲染时间和 PNG 体积都随像素数线性涨，发给 QQ 还要再等一次上传 —— 长列表图就是延迟源头。
//   压到 800 万像素以内后，100 行图实测掉到 566ms / 1.4MB。
// 可用环境变量 WG_IMG_MAX_PIXELS 覆盖（调大=更清晰更慢，调小=更小更快）。
const MAX_PIXELS = Math.max(500000, parseInt(process.env.WG_IMG_MAX_PIXELS || '5000000', 10) || 5000000);
// 缩放下限 = 1（= 物理宽度不小于布局宽度 720）：实测把它放到 0.5 时，300 行的图被压成 429 像素宽，
// 字直接糊了 —— 宁可图大一点，也不能让玩家看不清。比下限还长的图属于布局本身太长，该在业务层分页。
const MIN_SCALE = 1;

const log = (...a) => { try { process.stdout.write('[imageWorker] ' + a.join(' ') + '\n'); } catch (e) {} };
const errlog = (...a) => { try { process.stderr.write('[imageWorker] ' + a.join(' ') + '\n'); } catch (e) {} };

// 无头服务器场景：软渲染更稳、更可控
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const state = {
  win: null,
  mode: CAPTURE_PREF === 'offscreen' ? 'offscreen' : 'hidden',
  chain: Promise.resolve(),   // 串行队列：单窗口不允许并发 loadFile
  queueLen: 0,
};

function makeWindow(mode) {
  const offscreen = mode === 'offscreen';
  if (offscreen) {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer'); // 走 OSR 软合成
  }
  const win = new BrowserWindow({
    show: false,
    width: 720,
    height: 480,
    frame: false,
    transparent: !offscreen,
    backgroundColor: offscreen ? '#00000000' : '#00000000',
    webPreferences: {
      offscreen,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      images: true,
      spellcheck: false,
      devTools: false,
      javascript: true,
    },
  });
  try { win.webContents.setFrameRate(60); } catch (e) {}
  try { win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); } catch (e) {}
  win.webContents.on('will-navigate', (e) => { try { e.preventDefault(); } catch (err) {} });
  try {
    win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  } catch (e) {}
  win.on('closed', () => { if (state.win === win) state.win = null; });
  return win;
}

async function ensureWindow() {
  if (state.win && !state.win.isDestroyed()) return state.win;
  state.win = makeWindow(state.mode);
  return state.win;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitForPaint(win, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('离屏 paint 超时')); } }, timeoutMs);
    win.webContents.once('paint', (event, dirty, image) => {
      if (done) return;
      done = true; clearTimeout(t);
      resolve(image);
    });
  });
}

async function loadHtmlFile(win, file, timeoutMs) {
  await win.loadFile(file);
  // 等字体 + 两帧，保证文本与渐变稳定
  await win.webContents.executeJavaScript(
    'document.fonts && document.fonts.ready ? document.fonts.ready.then(()=>true) : true'
  ).catch(() => true);
  await win.webContents.executeJavaScript(
    'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))'
  ).catch(() => true);
  await delay(30);
  void timeoutMs;
}

/**
 * 量取画布高度。
 * 注意：#wg-root 的祖先带 CSS transform:scale(s)，getBoundingClientRect() 返回的**已经是放大后的像素**，
 * 因此这里必须直接使用，绝不能再乘 scale —— 否则窗口高度翻倍、图下半张全透明（2026-09-16 实测踩坑）。
 */
async function measureStageHeight(win) {
  const h = await win.webContents.executeJavaScript(
    '(() => { const el = document.getElementById("wg-root"); if (!el) return 0;' +
    ' const r = el.getBoundingClientRect(); return Math.ceil(r.height); })()'
  ).catch(() => 0);
  return Math.max(1, Math.round(Number(h) || 0));
}

async function capture(win, w, h) {
  if (state.mode === 'hidden') {
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
    if (img && !img.isEmpty()) return img;
    if (CAPTURE_PREF === 'auto') {
      // 隐藏窗口抓不到帧 -> 切离屏重来一次
      log('隐藏窗口抓帧为空，切换离屏模式');
      try { win.destroy(); } catch (e) {}
      state.win = null;
      state.mode = 'offscreen';
      throw new Error('EMPTY_CAPTURE');
    }
    throw new Error('截图为空（capturePage 返回空帧）');
  }
  return await waitForPaint(win, 15000);
}

async function renderOnce(req) {
  const t0 = Date.now();
  const html = String(req.html || '');
  if (!html) throw new Error('html 为空');
  const width = Math.max(1, Math.round(Number(req.width) || 720));
  const scale = Math.min(4, Math.max(1, Number(req.scale) || 1));
  const wantHeight = Math.max(0, Math.round(Number(req.height) || 0));
  const format = req.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = Math.min(100, Math.max(1, Number(req.quality) || 92));
  const timeoutMs = Math.min(30000, Math.max(500, Number(req.timeoutMs) || 8000));

  await fs.promises.mkdir(TMP_DIR, { recursive: true });
  const hash = crypto.createHash('sha1').update(html).update('|' + width + '|' + wantHeight + '|' + scale + '|' + format).digest('hex');
  const file = path.join(TMP_DIR, hash + '.html');
  await fs.promises.writeFile(file, html, 'utf8');

  let attempt = 0;
  for (;;) {
    attempt++;
    let win = await ensureWindow();
    try {
      let w = Math.round(width * scale);
      let scaleUsed = scale;
      const h0 = wantHeight > 0 ? Math.round(wantHeight * scale) : Math.round(480 * scale);
      try { win.setContentSize(w, h0); } catch (e) { try { win.setSize(w, h0); } catch (e2) {} }

      await loadHtmlFile(win, file, timeoutMs);

      let h = h0;
      if (wantHeight <= 0) {
        h = await measureStageHeight(win);
        // ---- 长图保护：量到真实高度后，像素数超上限就降 scale 再截 ----
        // 用 executeJavaScript 改 #wg-stage 的 transform（不是 insertCSS）：
        // insertCSS 对这个 webContents 是**持久**的，会把下一次渲染的图也一起缩掉。
        const pxTotal = w * h;
        if (pxTotal > MAX_PIXELS) {
          const eff = Math.max(MIN_SCALE, scale * Math.sqrt(MAX_PIXELS / pxTotal));
          if (eff < scale - 0.01) {
            await win.webContents.executeJavaScript(
              '(() => { const s = document.getElementById("wg-stage");' +
              ' if (s) { s.style.transform = "scale(' + eff + ')"; s.style.transformOrigin = "top left"; } return true; })()'
            ).catch(() => {});
            await delay(80);
            const nw = Math.round(width * eff);
            const nh = await measureStageHeight(win);
            try { win.setContentSize(nw, nh); } catch (e) { try { win.setSize(nw, nh); } catch (e2) {} }
            await delay(50);
            log('长图降 scale：' + scale + ' → ' + eff.toFixed(2) +
              '（' + (pxTotal / 1e6).toFixed(1) + 'M → ' + ((nw * nh) / 1e6).toFixed(1) + 'M 像素）');
            w = nw; h = nh; scaleUsed = eff;
          }
        }
        try { win.setContentSize(w, h); } catch (e) { try { win.setSize(w, h); } catch (e2) {} }
        await delay(60);
      }

      const img = await capture(win, w, h);
      const size = img.getSize();
      const buf = format === 'jpeg' ? img.toJPEG(quality) : img.toPNG();
      await fs.promises.unlink(file).catch(() => {});
      return { ok: true, base64: buf.toString('base64'), width: size.width, height: size.height, bytes: buf.length, ms: Date.now() - t0, mode: state.mode, scaleUsed };
    } catch (e) {
      if (e && e.message === 'EMPTY_CAPTURE' && attempt < 2) continue;   // 首次抓空 -> 已切离屏，重试
      try { if (state.win && !state.win.isDestroyed()) state.win.destroy(); } catch (e2) {}
      state.win = null;
      await fs.promises.unlink(file).catch(() => {});
      throw e;
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); try { req.destroy(); } catch (e) {} return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function enqueue(fn) {
  state.queueLen++;
  const run = state.chain.then(fn, fn);
  state.chain = run.catch(() => {});
  return run.finally(() => { state.queueLen--; });
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const u = req.url || '/';
      if (req.method === 'GET' && u.startsWith('/health')) {
        return sendJson(res, 200, {
          ok: true, pid: process.pid, electron: process.versions.electron,
          mode: state.mode, busy: state.queueLen, queue: state.queueLen,
        });
      }
      if (TOKEN && req.headers['authorization'] !== 'Bearer ' + TOKEN) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
      if (req.method === 'POST' && u.startsWith('/shutdown')) {
        sendJson(res, 200, { ok: true });
        setTimeout(() => hardExit(0), 50);
        return;
      }
      if (req.method === 'POST' && u.startsWith('/render')) {
        const body = await readBody(req);
        const out = await enqueue(() => renderOnce(body).catch((e) => ({ ok: false, error: e.message, ms: 0 })));
        return sendJson(res, 200, out);
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  });
  server.on('error', (e) => { errlog('HTTP 服务错误: ' + e.message); hardExit(1); });
  server.listen(PORT, '127.0.0.1', () => log('已就绪 port=' + PORT + ' mode=' + state.mode + ' pid=' + process.pid));
  return server;
}

function hardExit(code) {
  try { if (state.win && !state.win.isDestroyed()) state.win.destroy(); } catch (e) {}
  app.exit(code);
}

// 父进程看门狗：父死则自杀，避免孤儿 electron
if (PARENT_PID > 0) {
  setInterval(() => {
    try { process.kill(PARENT_PID, 0); } catch (e) { errlog('父进程已退出，子进程自杀'); hardExit(0); }
  }, 5000).unref?.();
}

process.on('SIGTERM', () => hardExit(0));
process.on('SIGINT', () => hardExit(0));
process.on('uncaughtException', (e) => errlog('未捕获异常: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => errlog('未处理拒绝: ' + (e && e.message ? e.message : e)));

app.on('window-all-closed', () => { /* 常驻：不随窗口关闭而退出 */ });

if (!TOKEN) {
  errlog('缺少 WG_IMG_TOKEN，拒绝启动（防止被本机其它进程调用）');
  process.exit(2);
}

app.whenReady().then(() => {
  startServer();
}).catch((e) => { errlog('启动失败: ' + e.message); process.exit(1); });
