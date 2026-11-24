/* 世界之眼 World Eye — 前端 */
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('worldeye.' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('worldeye.' + k, JSON.stringify(v));
    } catch {}
  },
};

// ---------- 地區對照（God's Eye View 的 pack → 國家 / 地區） ----------
const PACK_REGION = {
  austin: ['美國', '德州奧斯汀'],
  caltrans: ['美國', '加州'],
  txdot: ['美國', '德州'],
  houston: ['美國', '德州休士頓'],
  deldot: ['美國', '德拉瓦州'],
  kingcounty: ['美國', '華盛頓州金郡'],
  wsdot: ['美國', '華盛頓州'],
  nyc: ['美國', '紐約市'],
  florida: ['美國', '佛羅里達州'],
  tfl: ['英國', '倫敦'],
  ontario: ['加拿大', '安大略省'],
  ottawa: ['加拿大', '渥太華'],
  toronto: ['加拿大', '多倫多'],
  drivebc: ['加拿大', '卑詩省'],
  calgary: ['加拿大', '卡加利'],
  quebec: ['加拿大', '魁北克省'],
  fintraffic: ['芬蘭', ''],
  tallinn: ['愛沙尼亞', '塔林'],
  tarktee: ['愛沙尼亞', ''],
  lithuania: ['立陶宛', ''],
  warendorf: ['德國', '瓦倫多夫'],
  nsw: ['澳洲', '新南威爾斯州'],
  catalonia: ['西班牙', '加泰隆尼亞'],
  iceland: ['冰島', ''],
  hk: ['香港', ''],
  vegvesen: ['挪威', ''],
  taiwan: ['台灣', ''],
  a22: ['義大利', 'A22 高速公路'],
};
function regionOf(src) {
  const r = PACK_REGION[src.pack];
  if (r) return r[0];
  if (src.pack === 'world-cameras') {
    const c = String(src.city || '').split(/[,/]/).pop().trim();
    return c ? `其他：${c}` : '其他地區';
  }
  return '自訂來源';
}

const FEED_LABEL = { image: '定時快照', mjpeg: 'MJPEG', hls: 'HLS 即時影片', mp4: 'MP4 影片', webm: 'WebM 影片' };
const isVideo = (t) => t === 'hls' || t === 'mp4' || t === 'webm';
const typeGroup = (t) => (isVideo(t) ? 'video' : t === 'mjpeg' ? 'mjpeg' : 'image');

const CLASS_ZH = {
  person: '行人', pedestrian: '行人', bicycle: '腳踏車', car: '汽車', motorcycle: '機車', scooter: '機車',
  bus: '公車', truck: '卡車', van: '廂型車', train: '列車', boat: '船', airplane: '飛機',
  'traffic light': '紅綠燈', 'stop sign': '停車標誌', 'fire hydrant': '消防栓', 'traffic cone': '交通錐',
  'construction sign': '施工標誌', umbrella: '雨傘', dog: '狗', cat: '貓', bird: '鳥', horse: '馬',
  bench: '長椅', backpack: '背包', handbag: '手提包', 'parking meter': '停車收費器', snow: '積雪',
  fire: '火', smoke: '煙', 'flood water': '積水', tree: '樹', building: '建築', sign: '標誌',
};
const zhLabel = (o) => o.label_zh || CLASS_ZH[o.label] || o.label;
function classColor(label) {
  let h = 2166136261;
  for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const fixed = { person: 0, car: 200, truck: 35, bus: 55, motorcycle: 300, bicycle: 140, 'traffic light': 100 };
  const hue = label in fixed ? fixed[label] : (h >>> 0) % 360;
  return `hsl(${hue} 90% 55%)`;
}

// ---------- 狀態 ----------
const state = {
  sources: [],
  filtered: [],
  current: null,
  typeFilter: '',
  frameTimer: null,
  frameUrl: null,
  hls: null,
  mediaUrl: null,
  mediaKind: null, // 'img' | 'video'
  natural: { w: 0, h: 0 },
  lastResult: null,
  lastResultCam: null,
  analyzing: false,
  autoTimer: null,
  engines: [],
};

// ---------- 主題 ----------
const TILE = {
  ops: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  daylight: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  amber: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
let tileLayer;
function applyTheme(name) {
  if (!TILE[name]) name = 'ops';
  document.documentElement.dataset.theme = name;
  document.querySelectorAll('[data-theme-btn]').forEach((b) => {
    const on = b.dataset.themeBtn === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  if (tileLayer) tileLayer.setUrl(TILE[name]);
  if (selectedMarker) selectedMarker.setStyle({ color: cssVar('--accent') });
  store.set('theme', name);
  // 主題換色後重畫偵測框
  requestAnimationFrame(() => {
    drawOverlay();
    drawSnapshot();
  });
}

// ---------- 地圖 ----------
const map = L.map('map', { worldCopyJump: true, zoomControl: true, preferCanvas: true }).setView([25, 10], 2);
tileLayer = L.tileLayer(TILE.ops, {
  maxZoom: 19,
  subdomains: 'abcd',
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
}).addTo(map);
const cluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false, maxClusterRadius: 45 });
map.addLayer(cluster);
let selectedMarker = null;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function rebuildMarkers() {
  cluster.clearLayers();
  const vColor = cssVar('--video');
  const iColor = cssVar('--image');
  const markers = [];
  for (const s of state.filtered) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 5,
      weight: 1,
      color: '#000',
      fillColor: isVideo(s.feedType) ? vColor : iColor,
      fillOpacity: 0.9,
    });
    m.bindTooltip(`${s.name || s.id}<br><small>${s.city || ''}</small>`, { direction: 'top' });
    m.on('click', () => selectCamera(s));
    markers.push(m);
  }
  cluster.addLayers(markers);
}

// ---------- 篩選與清單 ----------
function fillSelect(sel, values, allLabel) {
  const keep = sel.value;
  sel.innerHTML = '';
  const o0 = document.createElement('option');
  o0.value = '';
  o0.textContent = allLabel;
  sel.appendChild(o0);
  for (const [v, n] of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `${v}（${n}）`;
    sel.appendChild(o);
  }
  sel.value = values.some(([v]) => v === keep) ? keep : '';
}
function countBy(list, fn) {
  const m = new Map();
  for (const x of list) {
    const k = fn(x);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function refreshProviderOptions() {
  const c = $('fCountry').value;
  fillSelect($('fProvider'), countBy(state.sources.filter((s) => !c || s._region === c), (s) => s.provider), '全部單位');
}

function applyFilters({ markers = true } = {}) {
  const q = $('fSearch').value.trim().toLowerCase();
  const c = $('fCountry').value;
  const p = $('fProvider').value;
  const t = state.typeFilter;
  const inBounds = $('fBounds').checked ? map.getBounds() : null;
  state.filtered = state.sources.filter(
    (s) =>
      (!c || s._region === c) &&
      (!p || s.provider === p) &&
      (!t || typeGroup(s.feedType) === t) &&
      (!q || s._text.includes(q)),
  );
  if (markers) rebuildMarkers();
  const listed = inBounds ? state.filtered.filter((s) => inBounds.contains([s.lat, s.lon])) : state.filtered;
  renderList(listed);
}

const LIST_MAX = 300;
function renderList(list) {
  const ul = $('camList');
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const s of list.slice(0, LIST_MAX)) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    if (state.current && state.current.id === s.id) li.classList.add('active');
    const k = document.createElement('i');
    k.className = 'kind' + (isVideo(s.feedType) ? ' video' : '');
    const d = document.createElement('div');
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = s.name || s.id;
    const sub = document.createElement('div');
    sub.className = 's';
    sub.textContent = [s._region, s.city, FEED_LABEL[s.feedType] || s.feedType].filter(Boolean).join(' · ');
    d.append(n, sub);
    li.append(k, d);
    li.addEventListener('click', () => selectCamera(s, { pan: true }));
    frag.appendChild(li);
  }
  ul.appendChild(frag);
  $('listMeta').textContent =
    list.length > LIST_MAX
      ? `符合 ${list.length.toLocaleString()} 支，清單顯示前 ${LIST_MAX} 支（地圖顯示全部）`
      : `符合 ${list.length.toLocaleString()} 支鏡頭`;
}

function showListError(msg) {
  $('camList').innerHTML = '';
  $('listMeta').textContent = '';
  const div = document.createElement('div');
  div.className = 'list-empty';
  div.innerHTML =
    `<b>無法取得鏡頭清單</b><br>${msg}<br><br>請先執行 <code>start.bat</code>，或在 <code>gods-eye-view</code> 資料夾執行 <code>npm run dev</code>，等它顯示 localhost:4173 後再重試。`;
  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.textContent = '重新載入';
  btn.onclick = loadSources;
  div.appendChild(btn);
  $('camList').appendChild(div);
}

async function loadSources() {
  $('listMeta').textContent = '載入鏡頭清單中…（第一次啟動可能需要 30 秒以上）';
  $('camList').innerHTML = '';
  try {
    const r = await fetch('/api/cctv/sources');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    state.sources = (j.sources || []).map((s) => ({
      ...s,
      lat: Number(s.lat),
      lon: Number(s.lon),
      feedType: s.feedType || 'image',
      _region: regionOf(s),
      _text: [s.name, s.city, s.provider, s.id, s.code].join(' ').toLowerCase(),
    }));
    $('camCount').querySelector('span').textContent = `鏡頭 ${state.sources.length.toLocaleString()} 支`;
    fillSelect($('fCountry'), countBy(state.sources, (s) => s._region), '全部國家');
    const savedCountry = store.get('country', '');
    if ([...$('fCountry').options].some((o) => o.value === savedCountry)) $('fCountry').value = savedCountry;
    refreshProviderOptions();
    applyFilters();
    if (!state.sources.length) showListError('God\'s Eye View 回傳 0 支鏡頭（可能還在抓取各地資料，稍後重試）。');
  } catch (err) {
    showListError(err.message);
  }
}

// ---------- 觀看鏡頭 ----------
function stopMedia() {
  clearInterval(state.frameTimer);
  state.frameTimer = null;
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  const v = $('videoEl');
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.hidden = true;
  $('frameImg').hidden = true;
  if (state.mediaUrl) {
    // 釋放 God's Eye View 端的串流租約
    fetch(state.mediaUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
    state.mediaUrl = null;
  }
  if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
  state.frameUrl = null;
  state.natural = { w: 0, h: 0 };
}

function stageMsg(text, isErr = false) {
  const el = $('stageMsg');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('err', isErr);
}

function fitMediaBox() {
  const { w, h } = state.natural;
  const box = $('mediaBox');
  if (!w || !h) return;
  const stage = $('stage');
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const k = Math.min(sw / w, sh / h);
  box.style.width = Math.floor(w * k) + 'px';
  box.style.height = Math.floor(h * k) + 'px';
  drawOverlay();
}
new ResizeObserver(fitMediaBox).observe($('stage'));

async function loadFrame() {
  const cam = state.current;
  if (!cam || state.mediaKind !== 'img') return;
  try {
    const r = await fetch(`/api/cctv/frame/${encodeURIComponent(cam.id)}?t=${Date.now()}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get('content-type') || '';
    const blob = await r.blob();
    if (state.current !== cam) return;
    const url = URL.createObjectURL(blob);
    const img = $('frameImg');
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('影像格式無法顯示'));
      img.src = url;
    });
    if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
    state.frameUrl = url;
    img.hidden = false;
    $('mediaBox').hidden = false;
    $('placeholder').hidden = true;
    state.natural = { w: img.naturalWidth, h: img.naturalHeight };
    state.isFallbackFrame = type.includes('svg');
    fitMediaBox();
    stageMsg(state.isFallbackFrame ? '來源暫時無法取得畫面，目前顯示的是備援示意圖（非即時）' : state.note || '');
    const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    $('liveBadge').textContent = `快照 ${t}`;
    $('liveBadge').className = 'badge snap';
    $('liveBadge').hidden = false;
  } catch (err) {
    if (state.current === cam) stageMsg(`畫面載入失敗：${err.message}`, true);
  }
}

async function startVideo(cam) {
  const r = await fetch(`/api/cctv/stream/${encodeURIComponent(cam.id)}`);
  const info = await r.json();
  if (state.current !== cam) return;
  if (!info.mediaUrl) throw new Error('此鏡頭沒有影片串流');
  const v = $('videoEl');
  state.mediaUrl = info.mediaUrl;
  v.onloadedmetadata = () => {
    state.natural = { w: v.videoWidth, h: v.videoHeight };
    fitMediaBox();
  };
  v.onplaying = () => {
    stageMsg('');
    $('liveBadge').textContent = 'LIVE';
    $('liveBadge').className = 'badge';
    $('liveBadge').hidden = false;
  };
  if (info.feedType === 'hls' && window.Hls && Hls.isSupported()) {
    const hls = new Hls({ lowLatencyMode: false, maxBufferLength: 20 });
    state.hls = hls;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal && state.current === cam) fallbackToSnapshot(cam, `影片串流無法播放（${data.details}）`);
    });
    hls.loadSource(info.mediaUrl);
    hls.attachMedia(v);
  } else {
    v.onerror = () => state.current === cam && fallbackToSnapshot(cam, '影片無法播放');
    v.src = info.mediaUrl;
  }
  v.hidden = false;
  $('mediaBox').hidden = false;
  $('placeholder').hidden = true;
  v.play().catch(() => {});
}

async function fallbackToSnapshot(cam, why) {
  stopMedia();
  state.mediaKind = 'img';
  state.note = `${why}，已改用定時快照模式`;
  stageMsg(state.note, true);
  await loadFrame();
  if (state.current === cam && !state.frameTimer) state.frameTimer = setInterval(loadFrame, 15000);
}

async function selectCamera(cam, { pan = false } = {}) {
  stopMedia();
  state.current = cam;
  state.note = '';
  clearOverlay();
  document.querySelectorAll('#camList li').forEach((li) => li.classList.toggle('active', li.dataset.id === cam.id));
  if (selectedMarker) selectedMarker.remove();
  if (Number.isFinite(cam.lat)) {
    selectedMarker = L.circleMarker([cam.lat, cam.lon], {
      radius: 10,
      weight: 3,
      color: cssVar('--accent'),
      fillOpacity: 0,
    }).addTo(map);
    if (pan) map.setView([cam.lat, cam.lon], Math.max(map.getZoom(), 11));
  }
  $('camTitle').textContent = cam.name || cam.id;
  $('camSub').textContent = [cam._region, cam.city, cam.provider, FEED_LABEL[cam.feedType] || cam.feedType]
    .filter(Boolean)
    .join(' · ');
  renderFoot(cam);
  $('btnRefresh').disabled = false;
  $('btnAnalyze').disabled = state.analyzing;
  $('autoToggle').disabled = false;
  $('liveBadge').hidden = true;
  $('placeholder').hidden = false;
  $('placeholder').querySelector('p').textContent = '畫面載入中…';
  $('mediaBox').hidden = true;
  stageMsg('');

  try {
    if (isVideo(cam.feedType)) {
      state.mediaKind = 'video';
      await startVideo(cam);
    } else {
      state.mediaKind = 'img';
      await loadFrame();
      const every = Math.min(120000, Math.max(5000, Number(cam.frameRefreshMs) || 15000));
      state.frameTimer = setInterval(loadFrame, every);
    }
  } catch (err) {
    if (state.current === cam) await fallbackToSnapshot(cam, `影片無法播放（${err.message}）`);
  }
}

function renderFoot(cam) {
  const f = $('viewerFoot');
  f.innerHTML = '';
  const add = (html) => {
    const s = document.createElement('span');
    s.innerHTML = html;
    f.appendChild(s);
  };
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  add(`座標 ${cam.lat.toFixed(4)}, ${cam.lon.toFixed(4)}`);
  if (Number.isFinite(cam.headingDeg)) add(`朝向 ${Math.round(cam.headingDeg)}°（估計）`);
  if (cam.frameRefreshMs && !isVideo(cam.feedType)) add(`更新間隔 ${Math.round(cam.frameRefreshMs / 1000)} 秒`);
  if (cam.credit || cam.license) add(`來源：${esc(cam.credit || '')} ${esc(cam.license || '')}`);
  if (/^https?:\/\//.test(cam.sourceUrl || '')) add(`<a href="${esc(cam.sourceUrl)}" target="_blank" rel="noopener">原始來源 ↗</a>`);
  add(`ID ${esc(cam.id)}`);
}

// ---------- 擷取畫面 ----------
function captureFrame() {
  const el = state.mediaKind === 'video' ? $('videoEl') : $('frameImg');
  const w = state.natural.w;
  const h = state.natural.h;
  if (!w || !h) throw new Error('畫面尚未載入完成');
  const scale = Math.min(1, 1280 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/jpeg', 0.9), width: c.width, height: c.height, canvas: c };
}

// ---------- 偵測框繪製 ----------
function confThreshold() {
  return Number($('confSlider').value);
}
function visibleObjects() {
  return (state.lastResult?.objects || []).filter((o) => o.confidence >= confThreshold());
}
function drawBoxes(ctx, W, H, objects, pxPerCss = 1) {
  // pxPerCss：畫布像素對螢幕 CSS 像素的比例，讓標籤在畫面上維持可讀大小
  const fs = Math.round(12 * pxPerCss);
  ctx.lineWidth = Math.max(1.5, 2 * pxPerCss);
  ctx.font = `600 ${fs}px ${cssVar('--font') || 'sans-serif'}`;
  ctx.textBaseline = 'top';
  for (const o of objects) {
    const [x1, y1, x2, y2] = o.bbox;
    const x = x1 * W;
    const y = y1 * H;
    const w = (x2 - x1) * W;
    const h = (y2 - y1) * H;
    const col = classColor(o.label);
    ctx.strokeStyle = col;
    ctx.strokeRect(x, y, w, h);
    const tag = `${zhLabel(o)} ${(o.confidence * 100).toFixed(0)}%`;
    const tw = ctx.measureText(tag).width + 8;
    const ty = y - fs - 4 >= 0 ? y - fs - 4 : y;
    ctx.fillStyle = col;
    ctx.fillRect(x - ctx.lineWidth / 2, ty, tw, fs + 4);
    ctx.fillStyle = '#000';
    ctx.fillText(tag, x + 4 - ctx.lineWidth / 2, ty + 2);
  }
}
function clearOverlay() {
  const c = $('overlay');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}
function drawOverlay() {
  const c = $('overlay');
  const box = $('mediaBox');
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, box.clientWidth * dpr);
  c.height = Math.max(1, box.clientHeight * dpr);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!$('overlayToggle').checked) return;
  if (!state.lastResult || state.lastResultCam !== state.current) return;
  drawBoxes(ctx, c.width, c.height, visibleObjects(), dpr);
}
function drawSnapshot() {
  const r = state.lastResult;
  if (!r || !r.snapshot) return;
  const c = $('snapCanvas');
  c.width = r.snapshot.width;
  c.height = r.snapshot.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(r.snapshot, 0, 0);
  const shown = c.clientWidth || 320;
  drawBoxes(ctx, c.width, c.height, visibleObjects(), c.width / shown);
}

function renderResult() {
  const r = state.lastResult;
  $('result').hidden = !r;
  if (!r) return;
  drawSnapshot();
  drawOverlay();
  const objs = visibleObjects();
  const t = new Date(r.at).toLocaleTimeString('zh-TW', { hour12: false });
  $('resultMeta').textContent = `${r.engineLabel} · ${(r.durationMs / 1000).toFixed(1)} 秒 · ${t} · 顯示 ${objs.length}/${r.objects.length} 個物件`;
  $('sceneText').textContent = r.scene || '（模型沒有提供場景描述）';
  $('sceneText').hidden = false;
  const counts = $('counts');
  counts.innerHTML = '';
  const tally = new Map();
  for (const o of objs) tally.set(o.label, [(tally.get(o.label)?.[0] || 0) + 1, zhLabel(o)]);
  for (const [label, [n, zh]] of [...tally.entries()].sort((a, b) => b[1][0] - a[1][0])) {
    const s = document.createElement('span');
    s.style.background = classColor(label);
    s.style.color = '#000';
    s.textContent = `${zh} ×${n}`;
    counts.appendChild(s);
  }
  const tb = $('detBody');
  tb.innerHTML = '';
  objs
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .forEach((o, i) => {
      const tr = document.createElement('tr');
      const sw = `<i class="sw" style="background:${classColor(o.label)}"></i>`;
      tr.innerHTML = `<td>${i + 1}</td><td>${sw}</td><td>${(o.confidence * 100).toFixed(0)}%</td><td class="mono">${o.bbox
        .map((v) => v.toFixed(2))
        .join(', ')}</td>`;
      tr.children[1].append(zhLabel(o));
      tb.appendChild(tr);
    });
  $('rawOut').textContent = r.raw || '';
}

// ---------- 呼叫 CLI 引擎 ----------
let runTick = null;
function setAiStatus(text, running = false) {
  const el = $('aiStatus');
  el.textContent = text;
  el.classList.toggle('run', running);
}

function showError(j) {
  const box = $('errorBox');
  box.hidden = false;
  box.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = '分析失敗：' + (j.error || '未知錯誤');
  box.appendChild(b);
  const ul = document.createElement('ul');
  const hints = new Set();
  for (const a of j.attempts || []) {
    const li = document.createElement('li');
    const label = state.engines.find((e) => e.id === a.engine)?.label || a.engine;
    li.textContent = `${label}：${a.ok ? '成功' : a.error}`;
    ul.appendChild(li);
    const all = `${a.error || ''} ${a.stderr || ''}`;
    if (/找不到指令/.test(all)) hints.add('安裝對應 CLI，並確認在命令提示字元輸入指令名稱可以執行（需在 PATH 中）。');
    if (/auth|login|登入|credential|api key/i.test(all)) hints.add('先在終端機互動執行一次該 CLI（agy / claude / codex）完成登入。');
    if (/逾時|timeout/i.test(all)) hints.add('Antigravity CLI 在背景模式偶有卡住的已知問題；可改用 Claude 或 Codex，或勾選「失敗時改用其他引擎」，或在 config.json 調高 timeoutSec。');
    if (/trust|workspace/i.test(all)) hints.add('在 world-eye\\work 資料夾互動執行一次 agy，將它加入信任的工作區。');
    if (/permission|denied|approval/i.test(all)) hints.add('CLI 未被允許讀取圖檔：請見 README「權限設定」。');
  }
  box.appendChild(ul);
  if (hints.size) {
    const h = document.createElement('div');
    h.textContent = '建議：' + [...hints].join(' ');
    box.appendChild(h);
  }
  const detail = (j.attempts || []).map((a) => [a.stderr, a.raw].filter(Boolean).join('\n')).filter(Boolean).join('\n----\n');
  if (detail) {
    const d = document.createElement('details');
    d.innerHTML = '<summary>錯誤細節（stderr / 原始輸出）</summary>';
    const pre = document.createElement('pre');
    pre.textContent = detail;
    d.appendChild(pre);
    box.appendChild(d);
  }
}

async function analyze() {
  if (state.analyzing || !state.current) return;
  let shot;
  try {
    shot = captureFrame();
  } catch (err) {
    setAiStatus(err.message);
    return;
  }
  if (state.isFallbackFrame && state.mediaKind === 'img') {
    setAiStatus('目前是備援示意圖，不是真實畫面，已略過分析');
    return;
  }
  const cam = state.current;
  const engine = $('engineSel').value;
  const label = $('engineSel').selectedOptions[0]?.textContent || engine;
  state.analyzing = true;
  $('btnAnalyze').disabled = true;
  $('errorBox').hidden = true;
  const t0 = Date.now();
  setAiStatus(`${label} 分析中…`, true);
  runTick = setInterval(() => setAiStatus(`${label} 分析中… ${Math.round((Date.now() - t0) / 1000)} 秒`, true), 1000);
  try {
    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine,
        fallback: $('fallbackToggle').checked,
        image: shot.dataUrl,
        width: shot.width,
        height: shot.height,
        cameraName: cam.name,
        city: cam.city,
      }),
    });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || !j.ok) {
      showError(j);
      setAiStatus('分析失敗');
      return;
    }
    state.lastResult = { ...j, snapshot: shot.canvas, at: Date.now() };
    state.lastResultCam = cam;
    const fb = j.engine !== engine ? `（已改用備援：${j.engineLabel}）` : '';
    setAiStatus(`完成：偵測到 ${j.objects.length} 個物件${fb}`);
    renderResult();
  } catch (err) {
    showError({ error: err.message });
    setAiStatus('分析失敗');
  } finally {
    clearInterval(runTick);
    state.analyzing = false;
    $('btnAnalyze').disabled = !state.current;
  }
}

function setAuto(on) {
  clearInterval(state.autoTimer);
  state.autoTimer = null;
  if (on) {
    const sec = Number($('autoInterval').value);
    analyze();
    state.autoTimer = setInterval(analyze, sec * 1000);
  }
}

// ---------- 伺服器狀態 ----------
async function refreshStatus(force = false) {
  try {
    const r = await fetch('/api/status' + (force ? '?refresh=1' : ''));
    const j = await r.json();
    const g = $('gevStatus');
    g.classList.toggle('ok', j.gev.ok);
    g.classList.toggle('bad', !j.gev.ok);
    g.querySelector('span').textContent = j.gev.ok ? "God's Eye View 已連線" : `God's Eye View 未啟動（${j.gev.url}）`;
    if (!state.engines.length || force) {
      state.engines = j.engines;
      const sel = $('engineSel');
      const saved = store.get('engine', j.defaultEngine);
      sel.innerHTML = '';
      for (const e of j.engines) {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = e.label + (e.id === j.defaultEngine ? '（主要）' : '') + (e.installed ? '' : ' — 未安裝');
        sel.appendChild(o);
      }
      sel.value = j.engines.some((e) => e.id === saved) ? saved : j.defaultEngine;
      $('fallbackToggle').checked = store.get('fallback', j.fallbackOnError);
      const chips = $('engineChips');
      chips.innerHTML = '';
      for (const e of j.engines) {
        const s = document.createElement('span');
        s.className = e.installed ? 'ok' : 'no';
        s.textContent = `${e.label}${e.version ? ' ' + e.version : e.installed ? '' : '（未安裝）'}`;
        s.title = e.installed ? e.path : `找不到指令 ${e.bin}`;
        chips.appendChild(s);
      }
    }
    return j.gev.ok;
  } catch {
    $('gevStatus').classList.add('bad');
    $('gevStatus').querySelector('span').textContent = '世界之眼伺服器沒有回應';
    return false;
  }
}

// ---------- 綁定事件 ----------
document.querySelectorAll('[data-theme-btn]').forEach((b) =>
  b.addEventListener('click', () => {
    applyTheme(b.dataset.themeBtn);
    rebuildMarkers();
  }),
);
let searchT;
$('fSearch').addEventListener('input', () => {
  clearTimeout(searchT);
  searchT = setTimeout(applyFilters, 250);
});
$('fCountry').addEventListener('change', () => {
  store.set('country', $('fCountry').value);
  refreshProviderOptions();
  applyFilters();
  const pts = state.filtered.filter((s) => Number.isFinite(s.lat));
  if ($('fCountry').value && pts.length) map.fitBounds(L.latLngBounds(pts.map((s) => [s.lat, s.lon])).pad(0.1));
});
$('fProvider').addEventListener('change', () => applyFilters());
$('fType').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.typeFilter = b.dataset.type;
  $('fType').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  applyFilters();
});
$('fBounds').addEventListener('change', () => applyFilters({ markers: false }));
map.on('moveend', () => {
  if ($('fBounds').checked) applyFilters({ markers: false });
});
$('btnRefresh').addEventListener('click', () => state.current && selectCamera(state.current));
$('overlayToggle').addEventListener('change', drawOverlay);
$('btnAnalyze').addEventListener('click', analyze);
$('autoToggle').addEventListener('change', (e) => setAuto(e.target.checked));
$('autoInterval').addEventListener('change', () => $('autoToggle').checked && setAuto(true));
$('engineSel').addEventListener('change', () => store.set('engine', $('engineSel').value));
$('fallbackToggle').addEventListener('change', () => store.set('fallback', $('fallbackToggle').checked));
$('confSlider').addEventListener('input', () => {
  $('confOut').textContent = Number($('confSlider').value).toFixed(2);
  renderResult();
});
window.addEventListener('beforeunload', stopMedia);

// ---------- 啟動 ----------
applyTheme(store.get('theme', 'ops'));
refreshStatus(true).then((ok) => {
  if (ok) loadSources();
  else showListError("God's Eye View 伺服器尚未啟動。");
});
setInterval(async () => {
  const wasEmpty = !state.sources.length;
  const ok = await refreshStatus();
  if (ok && wasEmpty && !$('listMeta').textContent.startsWith('載入')) loadSources();
}, 15000);
