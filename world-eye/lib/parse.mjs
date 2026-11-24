// 解析各 CLI 的輸出，轉成統一的類 YOLO 偵測格式。

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 找出文字中所有「平衡的大括號」JSON 物件候選（會略過字串內的括號）。 */
function jsonObjectCandidates(text) {
  const out = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    if (out.length > 40) break;
  }
  return out;
}

/**
 * 從 CLI 原始輸出取出「模型回覆文字」。
 * - Antigravity：--output-format json 的信封 { status, response, error, structured_output }
 * - Claude：--output-format json 的信封 { type:"result", result, is_error }
 * - Codex：--output-last-message 檔案內容（優先），否則用 stdout
 */
export function extractModelText(stdout, lastMessage = '') {
  if (lastMessage && lastMessage.trim()) return lastMessage;
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return '';

  let env = tryJson(trimmed);
  if (env === undefined) {
    // 有些 CLI 會在 JSON 之前印出提示訊息；改試最後一行。
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    env = tryJson(lines[lines.length - 1]);
  }
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    if (env.objects) return JSON.stringify(env);
    if (env.structured_output && typeof env.structured_output === 'object')
      return JSON.stringify(env.structured_output);
    const failed =
      env.is_error === true ||
      (typeof env.status === 'string' && /^(ERROR|CANCELED|INTERRUPTED|INVALID)$/i.test(env.status));
    if (failed) {
      const msg =
        (typeof env.error === 'string' && env.error) ||
        env.error?.message ||
        (typeof env.result === 'string' && env.result) ||
        env.status ||
        'CLI 回報錯誤';
      throw new Error(String(msg).slice(0, 500));
    }
    if (typeof env.response === 'string') return env.response;
    if (typeof env.result === 'string') return env.result;
  }
  return trimmed;
}

const num = (v) => (typeof v === 'string' ? parseFloat(v) : v);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function normalizeBox(raw, width, height) {
  let b = raw;
  if (b && !Array.isArray(b) && typeof b === 'object') {
    if ('x1' in b) b = [b.x1, b.y1, b.x2, b.y2];
    else if ('xmin' in b) b = [b.xmin, b.ymin, b.xmax, b.ymax];
    else if ('x' in b && 'w' in b) b = [b.x, b.y, b.x + b.w, b.y + b.h];
    else if ('x' in b && 'width' in b) b = [b.x, b.y, b.x + b.width, b.y + b.height];
    else if ('left' in b) b = [b.left, b.top, b.right ?? b.left + b.width, b.bottom ?? b.top + b.height];
  }
  if (!Array.isArray(b) || b.length < 4) return null;
  let [x1, y1, x2, y2] = b.slice(0, 4).map(num);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  // 0..1000 正規化（部分模型的慣例）或像素座標
  const maxV = Math.max(x1, y1, x2, y2);
  if (maxV > 1.5) {
    if (width && height && maxV <= Math.max(width, height) * 1.05) {
      x1 /= width;
      x2 /= width;
      y1 /= height;
      y2 /= height;
    } else if (maxV <= 1000) {
      x1 /= 1000;
      x2 /= 1000;
      y1 /= 1000;
      y2 /= 1000;
    } else return null;
  }
  // [x, y, w, h] 的情況
  if (x2 <= x1 || y2 <= y1) {
    x2 = x1 + x2;
    y2 = y1 + y2;
  }
  x1 = clamp01(x1);
  y1 = clamp01(y1);
  x2 = clamp01(x2);
  y2 = clamp01(y2);
  if (x2 - x1 < 0.002 || y2 - y1 < 0.002) return null;
  return [x1, y1, x2, y2].map((v) => Math.round(v * 10000) / 10000);
}

/** 解析偵測 JSON。找不到時回傳 null。 */
export function parseDetections(text, width, height) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
  let data = tryJson(cleaned.trim());
  if (!data || typeof data !== 'object' || !('objects' in data || 'detections' in data)) {
    data = undefined;
    for (const cand of jsonObjectCandidates(cleaned)) {
      const j = tryJson(cand);
      if (j && typeof j === 'object' && ('objects' in j || 'detections' in j)) {
        data = j;
        break;
      }
    }
  }
  if (!data) return null;
  const list = Array.isArray(data.objects) ? data.objects : Array.isArray(data.detections) ? data.detections : [];
  const objects = [];
  for (const o of list.slice(0, 100)) {
    if (!o || typeof o !== 'object') continue;
    const label = String(o.label ?? o.class ?? o.name ?? 'object').trim().toLowerCase().slice(0, 40);
    let conf = num(o.confidence ?? o.score ?? o.conf ?? 0.5);
    if (!Number.isFinite(conf)) conf = 0.5;
    if (conf > 1 && conf <= 100) conf /= 100;
    const bbox = normalizeBox(o.bbox ?? o.box ?? o.bounding_box ?? o, width, height);
    if (!bbox) continue;
    objects.push({
      label,
      label_zh: typeof o.label_zh === 'string' ? o.label_zh.slice(0, 20) : '',
      confidence: Math.round(clamp01(conf) * 100) / 100,
      bbox,
    });
  }
  const counts = {};
  for (const o of objects) counts[o.label] = (counts[o.label] || 0) + 1;
  return {
    objects,
    counts,
    scene: typeof data.scene === 'string' ? data.scene.slice(0, 300) : '',
  };
}
