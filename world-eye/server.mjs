// 世界之眼 GUI 伺服器
// - 提供 public/ 網頁介面
// - 代理 God's Eye View 的 /api/cctv/*（鏡頭清單、畫面、影片串流）
// - 呼叫 Antigravity / Claude / Codex CLI 做類 YOLO 物件偵測
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEngine, analyzeWithEngine, analyzeMock } from './lib/engines.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const WORK_DIR = path.join(ROOT, 'work');

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.GEV_URL) cfg.gevUrl = process.env.GEV_URL;
  cfg.gevUrl = String(cfg.gevUrl || 'http://localhost:4173').replace(/\/+$/, '');
  cfg.timeoutSec = Math.max(20, Number(cfg.timeoutSec) || 150);
  return cfg;
}
const cfg = loadConfig();
const MOCK = process.env.WORLD_EYE_MOCK === '1';
const GEV = new URL(cfg.gevUrl);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- 代理 God's Eye View ----------
const PASS_REQ_HEADERS = ['accept', 'range', 'content-type', 'content-length', 'user-agent', 'if-none-match', 'if-modified-since'];

function proxyToGev(req, res) {
  const headers = { host: GEV.host };
  for (const h of PASS_REQ_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  // 不轉送 Origin / Sec-Fetch-* / Cookie：God's Eye View 會把本機工具的請求視為同站。
  const upstream = http.request(
    {
      protocol: GEV.protocol,
      hostname: GEV.hostname,
      port: GEV.port || 80,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      const out = { ...up.headers };
      delete out['set-cookie'];
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent)
      sendJson(res, 502, {
        error: `無法連線到 God's Eye View（${cfg.gevUrl}）：${err.code || err.message}`,
        gevDown: true,
      });
    else res.destroy();
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

function checkGev() {
  return new Promise((resolve) => {
    const r = http.get(
      { hostname: GEV.hostname, port: GEV.port || 80, path: '/api/cctv/health', headers: { host: GEV.host }, timeout: 4000 },
      (up) => {
        up.resume();
        resolve({ ok: (up.statusCode || 0) < 500, status: up.statusCode });
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
  });
}

// ---------- 引擎偵測 ----------
let engineCache = { at: 0, list: [] };
async function listEngines(force = false) {
  if (!force && Date.now() - engineCache.at < 60_000 && engineCache.list.length) return engineCache.list;
  const ids = Object.keys(cfg.engines);
  const list = await Promise.all(ids.map((id) => detectEngine(id, cfg.engines[id])));
  if (MOCK) list.push({ id: 'mock', label: '模擬引擎（測試用）', bin: '-', installed: true, path: '', version: 'mock' });
  engineCache = { at: Date.now(), list };
  return list;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('影像太大'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let busy = null;

async function handleAnalyze(req, res) {
  if (busy) return sendJson(res, 409, { error: `正在用 ${busy} 分析中，請稍候再試` });
  let body;
  try {
    body = JSON.parse((await readBody(req, 16 * 1024 * 1024)).toString('utf8'));
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message || '請求格式錯誤' });
  }
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(String(body.image || ''));
  if (!m) return sendJson(res, 400, { error: '缺少影像（需要 JPEG/PNG data URL）' });
  const job = {
    imageBuffer: Buffer.from(m[2], 'base64'),
    width: Number(body.width) || 0,
    height: Number(body.height) || 0,
    cameraName: String(body.cameraName || '').slice(0, 120),
    city: String(body.city || '').slice(0, 80),
    workDir: WORK_DIR,
  };

  const engines = await listEngines();
  const requested = String(body.engine || cfg.defaultEngine);
  const useFallback = body.fallback ?? cfg.fallbackOnError;
  const order = [requested];
  if (useFallback) for (const id of cfg.fallbackOrder) if (!order.includes(id)) order.push(id);

  const attempts = [];
  busy = requested;
  try {
    for (const id of order) {
      const info = engines.find((e) => e.id === id);
      if (!info) {
        attempts.push({ engine: id, ok: false, error: '設定檔中沒有這個引擎' });
        continue;
      }
      if (!info.installed) {
        attempts.push({ engine: id, ok: false, error: `找不到指令 ${info.bin}（尚未安裝或不在 PATH）` });
        continue;
      }
      busy = info.label;
      console.log(`[analyze] ${info.label} ← ${job.cameraName || 'camera'} (${job.width}x${job.height})`);
      try {
        const r = id === 'mock' ? await analyzeMock(job) : await analyzeWithEngine(id, cfg, job);
        attempts.push({ engine: id, ok: true, durationMs: r.durationMs });
        console.log(`[analyze] ${info.label} OK：${r.objects.length} 個物件，${(r.durationMs / 1000).toFixed(1)} 秒`);
        return sendJson(res, 200, {
          ok: true,
          engine: id,
          engineLabel: info.label,
          durationMs: r.durationMs,
          objects: r.objects,
          counts: r.counts,
          scene: r.scene,
          raw: String(r.rawText || '').slice(0, 6000),
          attempts,
        });
      } catch (err) {
        console.warn(`[analyze] ${info.label} 失敗：${err.message}`);
        attempts.push({
          engine: id,
          ok: false,
          error: err.message,
          stderr: String(err.stderr || '').slice(-1500),
          raw: String(err.rawText || '').slice(0, 3000),
        });
      }
    }
    return sendJson(res, 502, { ok: false, error: attempts.at(-1)?.error || '分析失敗', attempts });
  } finally {
    busy = null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/cctv/')) return proxyToGev(req, res);
    if (p === '/api/status' && req.method === 'GET') {
      const [gev, engines] = await Promise.all([checkGev(), listEngines(url.searchParams.has('refresh'))]);
      return sendJson(res, 200, {
        gev: { ...gev, url: cfg.gevUrl },
        engines,
        defaultEngine: cfg.defaultEngine,
        fallbackOnError: !!cfg.fallbackOnError,
        timeoutSec: cfg.timeoutSec,
        busy,
      });
    }
    if (p === '/api/analyze' && req.method === 'POST') return handleAnalyze(req, res);
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  }
});

// 只綁本機：CLI 會以你的帳號身分執行，不要開放給區網。
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`\n  世界之眼 GUI：http://localhost:${cfg.port}`);
  console.log(`  God's Eye View 來源：${cfg.gevUrl}`);
  console.log(`  預設引擎：${cfg.defaultEngine}${MOCK ? '（模擬引擎已啟用）' : ''}\n`);
  listEngines(true).then((list) => {
    for (const e of list) console.log(`  [${e.installed ? 'OK' : '--'}] ${e.label}${e.version ? '  ' + e.version : ''}`);
  });
});
