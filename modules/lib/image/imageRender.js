/**
 * WayGame 图片模块 · 渲染客户端
 * 设计：docs/图片消息模块设计-v1.md §5
 *
 * 职责：
 *   - 按需拉起 Electron 渲染子进程（modules/lib/image/renderWorker.js）
 *   - 健康检查 / 超时 / 崩溃重启（指数退避）/ 单飞（同 hash 只渲染一次）
 *   - 缓存（<cacheDir>/<hash>.png）+ 索引写回由调用方（imageStore）负责，本文件只管「拿图」
 * 不依赖 core：可被工具脚本、编辑器、测试单独使用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_PORT = 3212;
const READY_TIMEOUT = Math.max(500, parseInt(process.env.WG_IMG_READY_TIMEOUT_MS || '12000', 10) || 12000);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 解析 Electron 可执行文件：直接读 path.txt，避免 electron 垫片在缺失时联网下载 */
function resolveElectron(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.WG_ELECTRON_PATH && fs.existsSync(process.env.WG_ELECTRON_PATH)) return process.env.WG_ELECTRON_PATH;
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'node_modules', 'electron', 'dist'),
    path.join(process.cwd(), 'node_modules', 'electron', 'dist'),
  ];
  for (const dist of candidates) {
    try {
      const pathFile = path.join(dist, '..', 'path.txt');
      if (fs.existsSync(pathFile)) {
        const exe = fs.readFileSync(pathFile, 'utf8').trim();
        const full = path.join(dist, exe);
        if (fs.existsSync(full)) return full;
      }
    } catch (e) { /* 继续找 */ }
    const winExe = path.join(dist, 'electron.exe');
    if (fs.existsSync(winExe)) return winExe;
  }
  return null;
}

function httpJson({ port, method, urlPath, token, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: Object.assign(
        { 'Content-Type': 'application/json; charset=utf-8' },
        data ? { 'Content-Length': data.length } : {},
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
        if (res.statusCode >= 400) {
          const err = new Error((parsed && parsed.error) || ('HTTP ' + res.statusCode));
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(Math.max(1000, timeoutMs || 10000), () => {
      try { req.destroy(new Error('请求超时')); } catch (e) { reject(new Error('请求超时')); }
    });
    if (data) req.write(data);
    req.end();
  });
}

function createRenderer(opts = {}) {
  const rootDir = opts.rootDir || path.join(__dirname, '..', '..', '..');
  const port = parseInt(opts.port || process.env.WG_IMG_PORT || DEFAULT_PORT, 10) || DEFAULT_PORT;
  const tmpDir = opts.tmpDir || path.join(rootDir, 'data', 'images', 'tmp');
  const captureMode = opts.captureMode || 'auto';
  const timeoutMs = parseInt(opts.timeoutMs || 5000, 10) || 5000;
  const electronPath = resolveElectron(opts.electronPath);
  const workerScript = opts.workerScript || path.join(__dirname, 'renderWorker.js');
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const token = crypto.randomBytes(16).toString('hex');
  // 空闲自动退出（2026-09-20）：渲染子进程常驻约 68MB（实测 67.6MB / 32 线程 / 695 句柄），
  // 没图要画的时候一直挂着纯属浪费设备资源。最后一次渲染后 idleMs 内没动静就停掉它，
  // 下次要用再拉起（冷启动实测 ~240ms，比一直占着 68MB 划算）。
  // 设 WG_IMG_IDLE_MS=0 可以关掉这个行为（让它一直常驻）。
  const idleMs = Math.max(0, parseInt(opts.idleMs !== undefined ? opts.idleMs : (process.env.WG_IMG_IDLE_MS || '300000'), 10) || 0);
  let idleTimer = null;
  const st = {
    child: null,
    ready: false,
    starting: null,
    fails: 0,
    disabledUntil: 0,
    inflight: new Map(),   // hash -> Promise
    stats: { renders: 0, errors: 0, restarts: 0, singleflight: 0, lastMs: 0, lastError: '' },
  };

  function isRunning() {
    return !!(st.child && st.child.exitCode === null && !st.child.killed);
  }

  function spawnWorker() {
    if (!electronPath) throw new Error('未找到 Electron 可执行文件（node_modules/electron/dist）');
    const env = Object.assign({}, process.env, {
      WG_IMG_PORT: String(port),
      WG_IMG_TOKEN: token,
      WG_IMG_TMP: tmpDir,
      WG_IMG_CAPTURE: captureMode,
      WG_IMG_PARENT_PID: String(process.pid),
    });
    const child = spawn(electronPath, [workerScript], {
      cwd: rootDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => log('debug', '[imageWorker] ' + String(d).trim().slice(0, 400)));
    child.stderr.on('data', (d) => log('warn', '[imageWorker] ' + String(d).trim().slice(0, 400)));
    child.on('exit', (code, signal) => {
      if (st.child === child) { st.child = null; st.ready = false; }
      log('warn', '[image] 渲染子进程退出 code=' + code + ' signal=' + signal);
    });
    child.on('error', (e) => {
      log('warn', '[image] 渲染子进程启动失败: ' + e.message);
    });
    st.child = child;
    return child;
  }

  async function waitReady(deadline) {
    for (;;) {
      if (Date.now() > deadline) return false;
      try {
        const h = await httpJson({ port, method: 'GET', urlPath: '/health', token, timeoutMs: 1000 });
        if (h && h.ok) return true;
      } catch (e) { /* 还没起来 */ }
      await sleep(150);
    }
  }

  async function start() {
    if (st.ready && isRunning()) return true;
    if (st.starting) return st.starting;
    if (Date.now() < st.disabledUntil) return false;
    st.starting = (async () => {
      try {
        if (!electronPath) { st.lastError = '未找到 Electron 可执行文件'; st.disabledUntil = Date.now() + 60000; return false; }
        if (!isRunning()) {
          if (st.child) st.stats.restarts++;
          spawnWorker();
        }
        const ok = await waitReady(Date.now() + READY_TIMEOUT);
        st.ready = ok;
        if (!ok) {
          st.fails++;
          st.lastError = '渲染子进程启动超时';
          st.disabledUntil = Date.now() + backoffMs();
          await stop();
        } else {
          st.fails = 0;
          touchIdle();          // 起来了就开始算空闲
        }
        return ok;
      } catch (e) {
        // spawn 被策略拒绝（EPERM）/二进制缺失等：立刻降级，绝不把异常抛给业务链路
        st.fails++;
        st.ready = false;
        st.lastError = e && e.message ? e.message : String(e);
        st.disabledUntil = Date.now() + backoffMs();
        try { if (st.child) st.child.kill(); } catch (e2) {}
        st.child = null;
        log('warn', '[image] 渲染子进程不可用（' + st.lastError + '），' + Math.round(backoffMs() / 1000) + ' 秒内不再重试，期间自动降级');
        return false;
      } finally {
        st.starting = null;
      }
    })();
    return st.starting;
  }

  function backoffMs() {
    const n = Math.min(4, st.fails);
    return Math.min(60000, 2000 * Math.pow(2, Math.max(0, n - 1)));
  }

  /** 每次渲染/启动后重置空闲计时；到点没动静就停掉子进程 */
  function touchIdle() {
    if (!(idleMs > 0)) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (st.inflight.size > 0) { touchIdle(); return; }   // 还有在跑的，往后推
      if (!isRunning()) return;
      log('info', '[image] 渲染子进程空闲 ' + Math.round(idleMs / 1000) + ' 秒，自动退出释放内存（约 68MB）');
      try { await stop(); } catch (e) { /* 关不掉也无所谓 */ }
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();   // 别让这个定时器拖住父进程退出
  }

  async function stop() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const child = st.child;
    st.ready = false;
    st.child = null;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch (e) {}
    for (let i = 0; i < 15 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch (e) {} }
  }

  async function rawRender(payload, perCallTimeout) {
    const t = Math.max(500, perCallTimeout || timeoutMs);
    const body = Object.assign({ format: 'png', scale: 1, width: 720, height: 0, timeoutMs: t - 300 }, payload);
    return await httpJson({ port, method: 'POST', urlPath: '/render', token, body, timeoutMs: t });
  }

  /**
   * 渲染一张图（单飞 + 超时重试一次 + 重启）
   * @returns { ok, base64?, width?, height?, bytes?, ms?, mode?, reason? }
   */
  async function render(payload, o = {}) {
    const perCallTimeout = Math.max(800, o.timeoutMs || timeoutMs);
    const key = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
    if (st.inflight.has(key)) {
      st.stats.singleflight++;
      return st.inflight.get(key);
    }
    const p = (async () => {
      let attempt = 0;
      for (;;) {
        attempt++;
        const okReady = await start();
        if (!okReady) return { ok: false, reason: 'renderer_unavailable', error: st.lastError || '渲染子进程不可用' };
        try {
          const out = await rawRender(payload, perCallTimeout);
          if (out && out.ok) {
            st.stats.renders++;
            st.stats.lastMs = out.ms || 0;
            return out;
          }
          st.stats.errors++;
          st.stats.lastError = (out && out.error) || '渲染失败';
          return { ok: false, reason: 'render_failed', error: st.stats.lastError };
        } catch (e) {
          st.stats.errors++;
          st.stats.lastError = e.message;
          const timedOut = /超时|timeout/i.test(e.message);
          if (attempt === 1) {
            log('warn', '[image] 渲染失败（' + e.message + '），重启渲染子进程后重试一次' + (timedOut ? '（超时）' : ''));
            await stop();
            continue;
          }
          log('warn', '[image] 渲染最终失败: ' + e.message);
          await stop();
          return { ok: false, reason: timedOut ? 'render_timeout' : 'render_error', error: e.message };
        }
      }
    })();
    st.inflight.set(key, p);
    try { return await p; } finally { st.inflight.delete(key); touchIdle(); }
  }

  async function health() {
    let workerOk = false;
    let info = null;
    if (isRunning()) {
      try { info = await httpJson({ port, method: 'GET', urlPath: '/health', token, timeoutMs: 1200 }); workerOk = !!(info && info.ok); }
      catch (e) { workerOk = false; }
    }
    return {
      ok: workerOk,
      available: !!electronPath,
      electronPath,
      port,
      pid: st.child ? st.child.pid : 0,
      worker: info,
      stats: Object.assign({}, st.stats),
      disabledForMs: Math.max(0, st.disabledUntil - Date.now()),
    };
  }

  return {
    start, stop, render, health,
    resolveElectron: () => electronPath,
    port,
    idleMs,
    get stats() { return st.stats; },
    isReady: () => st.ready,
  };
}

module.exports = { createRenderer, resolveElectron, DEFAULT_PORT };
