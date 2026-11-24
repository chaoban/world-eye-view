// CLI 引擎串接：Antigravity CLI (agy)、Claude CLI (claude)、Codex CLI (codex)
// 把畫面存成圖檔 + 任務說明檔，呼叫 CLI 的非互動模式，取回類 YOLO 的 JSON 偵測結果。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseDetections, extractModelText } from './parse.mjs';

const IS_WIN = process.platform === 'win32';

/** 給 cmd.exe 用的參數引號處理（shell:true 時 Node 不會替我們加引號）。 */
function winQuote(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (/^[\w\-.:\\/=@,+]+$/.test(s)) return s;
  // 提示字串由本程式產生，不含雙引號與 cmd 特殊字元；這裡再保險移除一次。
  return '"' + s.replace(/["%^&|<>\r\n]/g, ' ') + '"';
}

function fillArgs(template, vars, extraArgs = []) {
  const args = template.map((a) =>
    String(a).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)),
  );
  if (extraArgs.length) {
    // 位置參數型的提示（例如 codex exec ... "{prompt}"）放在最後，額外參數要插在它前面。
    const last = template[template.length - 1];
    if (last === '{prompt}') args.splice(args.length - 1, 0, ...extraArgs);
    else args.push(...extraArgs);
  }
  return args;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

/** 執行一個 CLI 指令，回傳 { code, stdout, stderr, timedOut }。 */
export function runCli(bin, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = IS_WIN
        ? spawn([bin, ...args].map(winQuote).join(' '), {
            cwd,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 4 * 1024 * 1024;
    child.stdout.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < cap) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err?.message || err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 檢查 CLI 是否已安裝，並讀取版本。 */
export async function detectEngine(id, engineCfg) {
  const bin = engineCfg.bin;
  const which = await runCli(IS_WIN ? 'where' : 'which', [bin], {
    cwd: process.cwd(),
    timeoutMs: 8000,
  });
  const found = which.code === 0 && which.stdout.trim();
  if (!found) {
    return { id, label: engineCfg.label, bin, installed: false, path: '', version: '' };
  }
  const ver = await runCli(bin, ['--version'], { cwd: process.cwd(), timeoutMs: 15000 });
  const version = (ver.stdout || ver.stderr).trim().split(/\r?\n/)[0].slice(0, 80);
  return {
    id,
    label: engineCfg.label,
    bin,
    installed: true,
    path: which.stdout.trim().split(/\r?\n/)[0],
    version,
  };
}

const COCO_HINT =
  'person, bicycle, car, motorcycle, bus, truck, train, boat, airplane, traffic light, ' +
  'stop sign, fire hydrant, umbrella, dog, cat, bird, horse, backpack, handbag, bench, ' +
  'parking meter, traffic cone, construction sign, snow, fire, smoke, flood water';

function buildTaskText({ imageName, width, height, cameraName, city }) {
  return [
    '# Task: YOLO-style object detection on one camera frame',
    '',
    `Image file: ${imageName} (${width || '?'} x ${height || '?'} pixels), in the current directory.`,
    `Source: public camera "${cameraName || 'unknown'}"${city ? ` in ${city}` : ''}.`,
    '',
    'Look at the image and detect every clearly visible object.',
    `Prefer COCO-style class names, e.g.: ${COCO_HINT}. Use another short English noun if none fits.`,
    '',
    'Return ONLY one JSON object (no markdown fences, no prose) with this shape:',
    '{"objects":[{"label":"car","label_zh":"汽車","confidence":0.87,"bbox":[0.12,0.40,0.25,0.58]}],',
    ' "counts":{"car":1},',
    ' "scene":"一句繁體中文的場景描述（天氣、路況、車流）"}',
    '',
    'Rules:',
    '- bbox = [x1, y1, x2, y2] normalized to 0..1 of image width/height; (x1,y1) top-left, (x2,y2) bottom-right.',
    '- confidence is 0..1 and reflects how sure you are about the class and box.',
    '- At most 60 objects. If nothing is detectable, return "objects": [].',
    '- label_zh and scene must be Traditional Chinese (Taiwan usage).',
    '- Do not create, modify or delete any file. Do not run shell commands. Only read the image.',
    '',
  ].join('\n');
}

/**
 * 用指定引擎分析一張影像。
 * @returns {Promise<{objects, counts, scene, rawText}>}
 */
export async function analyzeWithEngine(engineId, cfg, job) {
  const engineCfg = cfg.engines[engineId];
  if (!engineCfg) throw new Error(`未知的引擎：${engineId}`);

  const workDir = job.workDir;
  fs.mkdirSync(workDir, { recursive: true });
  const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const imageName = `frame_${stamp}.jpg`;
  const taskName = `task_${stamp}.md`;
  const lastMsgName = `last_${stamp}.txt`;
  const imagePath = path.join(workDir, imageName);
  const taskPath = path.join(workDir, taskName);
  const lastMsgPath = path.join(workDir, lastMsgName);

  fs.writeFileSync(imagePath, job.imageBuffer);
  fs.writeFileSync(
    taskPath,
    buildTaskText({
      imageName,
      width: job.width,
      height: job.height,
      cameraName: job.cameraName,
      city: job.city,
    }),
    'utf8',
  );

  // 命令列提示只用簡單的 ASCII 字元，完整指示放在任務檔，避免 Windows cmd 引號問題。
  const prompt =
    `Read the instruction file ${taskName} in the current directory and follow it exactly. ` +
    `The image to analyze is ${imageName}. Reply with the JSON object only.`;

  const args = fillArgs(
    engineCfg.args,
    {
      prompt,
      image: imagePath,
      imageName,
      taskFile: taskPath,
      workdir: workDir,
      lastMessageFile: lastMsgPath,
      timeoutSec: cfg.timeoutSec,
    },
    engineCfg.extraArgs || [],
  );

  const started = Date.now();
  const result = await runCli(engineCfg.bin, args, {
    cwd: workDir,
    timeoutMs: (cfg.timeoutSec + 10) * 1000,
  });
  const durationMs = Date.now() - started;

  let lastMsg = '';
  try {
    lastMsg = fs.readFileSync(lastMsgPath, 'utf8');
  } catch {}

  if (!cfg.keepWorkFiles) {
    for (const p of [imagePath, taskPath, lastMsgPath]) fs.rm(p, { force: true }, () => {});
  }

  if (result.timedOut) {
    throw Object.assign(new Error(`${engineCfg.label} 逾時（超過 ${cfg.timeoutSec} 秒）`), {
      stderr: result.stderr,
      durationMs,
    });
  }

  let text;
  try {
    text = extractModelText(result.stdout, lastMsg);
  } catch (err) {
    throw Object.assign(err, { stderr: result.stderr, durationMs });
  }

  if (!text.trim()) {
    const why =
      result.code !== 0
        ? `結束代碼 ${result.code}`
        : '沒有輸出';
    throw Object.assign(new Error(`${engineCfg.label} ${why}`), {
      stderr: result.stderr,
      durationMs,
    });
  }

  const parsed = parseDetections(text, job.width, job.height);
  if (!parsed) {
    throw Object.assign(new Error(`${engineCfg.label} 的回覆中找不到偵測結果 JSON`), {
      stderr: result.stderr,
      rawText: text,
      durationMs,
    });
  }
  return { ...parsed, rawText: text, durationMs, stderr: result.stderr };
}

/** 測試用模擬引擎（設定環境變數 WORLD_EYE_MOCK=1 才會出現）。 */
export async function analyzeMock(job) {
  await new Promise((r) => setTimeout(r, 1200));
  const labels = [
    ['car', '汽車'],
    ['truck', '卡車'],
    ['person', '行人'],
    ['bus', '公車'],
    ['motorcycle', '機車'],
    ['traffic light', '紅綠燈'],
  ];
  const n = 3 + Math.floor(Math.random() * 6);
  const objects = Array.from({ length: n }, () => {
    const [label, label_zh] = labels[Math.floor(Math.random() * labels.length)];
    const x1 = Math.random() * 0.75;
    const y1 = 0.3 + Math.random() * 0.5;
    const w = 0.06 + Math.random() * 0.18;
    const h = 0.05 + Math.random() * 0.15;
    return {
      label,
      label_zh,
      confidence: +(0.45 + Math.random() * 0.5).toFixed(2),
      bbox: [x1, y1, Math.min(1, x1 + w), Math.min(1, y1 + h)].map((v) => +v.toFixed(3)),
    };
  });
  const text = JSON.stringify({ objects, scene: '模擬結果：測試 GUI 顯示用，非真實辨識。' });
  const parsed = parseDetections(text, job.width, job.height);
  return { ...parsed, rawText: text, durationMs: 1200, stderr: '' };
}
