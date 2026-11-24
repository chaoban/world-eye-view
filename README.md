# 世界之眼 World Eye

把 [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) 收錄的全球公開攝影鏡頭（約 7,000 支，涵蓋台灣、香港、英國、美國、加拿大、北歐、澳洲等地）整理成一個桌面網頁介面：

- 地圖 + 清單選鏡頭，可依 **國家／地區、營運單位、鏡頭類型（即時影片／定時快照／MJPEG）、關鍵字** 篩選
- 點選鏡頭即可觀看即時畫面（HLS／MP4 影片串流或定時更新快照）
- **3 種介面風格**：戰情深色、晨光明亮、復古琥珀（右上角切換，會記住選擇）
- **AI CLI 引擎做類 YOLO 物件偵測**：預設串接 **Antigravity CLI**，可切換成 **Claude CLI** 或 **Codex CLI**；結果以彩色框線、類別、信心值、數量統計與場景描述呈現，可設定信心門檻與自動定時偵測

## 資料夾結構

```
Exercise-001/
├─ setup.bat          安裝：git clone gods-eye-view + npm ci
├─ start.bat          啟動：God's Eye View 伺服器 + 世界之眼 GUI，並開啟瀏覽器
├─ README.md
├─ gods-eye-view/     （執行 setup.bat 後才會出現）
└─ world-eye/
   ├─ server.mjs      GUI 伺服器（代理鏡頭 API、呼叫 CLI）
   ├─ config.json     引擎指令、逾時、備援順序等設定
   ├─ lib/            engines.mjs（CLI 串接）、parse.mjs（輸出解析）
   ├─ public/         網頁介面（Leaflet 地圖、hls.js 已內建，不需 CDN）
   └─ work/           分析時暫存的影格與任務檔（分析完自動刪除）
```

## 安裝

1. 需求：**Git**、**Node.js 24.14 以上**（gods-eye-view 的要求；Node 25 已停止維護，請用 24 LTS）。
2. 雙擊 `setup.bat`。它會執行
   `git clone https://github.com/bilawalsidhu/gods-eye-view.git`、`npm ci`、`npm run doctor`，最後列出已安裝的 AI CLI。
3. 安裝 AI CLI（至少一個，建議先裝 Antigravity）：

| 引擎 | 安裝（PowerShell） | 第一次使用 |
|---|---|---|
| Antigravity CLI（`agy`，主要） | `winget install Google.AntigravityCLI` 或 `irm https://antigravity.google/install.ps1 \| iex` | 在 `world-eye\work` 資料夾執行一次 `agy`，完成 Google 登入並**信任此工作區** |
| Claude CLI（`claude`） | `irm https://claude.ai/install.ps1 \| iex` | 執行一次 `claude` 完成登入 |
| Codex CLI（`codex`） | `npm i -g @openai/codex` | 執行一次 `codex` 完成登入 |

> 背景模式只會使用已快取的登入資訊；沒先互動登入過，分析會回報「需要驗證」。

## 使用

1. 雙擊 `start.bat`：會開兩個伺服器視窗（God's Eye View 在 `localhost:4173`、世界之眼在 `localhost:8790`），並自動打開 http://localhost:8790 。
   第一次載入鏡頭清單要向各國開放資料來源抓資料，可能要 30 秒以上。
2. 左側篩選國家／類型，點清單或地圖上的點位 → 中間顯示即時畫面。
3. 右側選擇 CLI 引擎 →「▶ 偵測目前畫面」。程式會擷取你正在看的那一格畫面交給 CLI 分析，結果疊加在即時畫面上，並在右側顯示快照、統計表與原始輸出。
4. 可勾「自動偵測」定時分析（每次呼叫都會消耗該 CLI 的用量額度，間隔不建議低於 60 秒）。

## 運作方式

```
瀏覽器 ──► world-eye/server.mjs ──代理──► gods-eye-view /api/cctv/*（鏡頭清單、畫面、串流）
                 │
                 └─ 偵測：影格存成 work/frame_*.jpg + 任務說明 work/task_*.md
                    → agy -p … --output-format json          （Antigravity）
                    → claude -p … --output-format json --allowedTools Read
                    → codex exec --sandbox read-only --image <影格> …
                    → 解析回傳 JSON {objects:[{label, confidence, bbox}], scene}
```

- 指令完整模板在 `config.json` 的 `engines.*.args`，CLI 改版時可直接修改；`extraArgs` 可加參數（例如 `["--model", "xxx"]`）。
- CLI 以唯讀方式執行：Claude 只開放 Read 工具、Codex 使用 read-only sandbox、Antigravity 不加 `--dangerously-skip-permissions`。
- GUI 伺服器只綁 `127.0.0.1`，CLI 會以你的帳號身分執行，請勿改成對區網開放。

## config.json 重點

| 欄位 | 說明 |
|---|---|
| `defaultEngine` | 預設引擎，預設 `antigravity` |
| `timeoutSec` | 單次分析逾時秒數（預設 150） |
| `fallbackOnError` | 主要引擎失敗時，是否依 `fallbackOrder` 改用其他已安裝引擎（介面上也可勾選） |
| `gevUrl` | God's Eye View 位址，預設 `http://localhost:4173` |
| `keepWorkFiles` | 設 `true` 可保留 work/ 內的影格與任務檔，方便除錯 |

## 限制與注意事項

- **這不是真正的 YOLO**。框線是大型語言模型看圖後估計的座標，位置與數量都可能不準，小物件和密集車流尤其明顯；適合「看個大概」，不適合計數統計、安全或執法判斷。若需要精準即時偵測，應另外接本機 YOLO 模型。
- **Antigravity CLI 背景模式已知問題**：有使用者回報 `agy -p` 在非終端機環境（被程式呼叫）時可能卡住沒有輸出（官方 issue #318）。本程式會在逾時後強制結束並顯示錯誤；遇到時可改用 Claude／Codex，或勾選「失敗時改用其他引擎」。
- Antigravity 是否能在背景模式讀取圖檔，取決於你的權限設定（agentMode）。若回報讀不到檔案，可在 `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow` 加入讀檔規則；不建議直接用 `--dangerously-skip-permissions`。
- 鏡頭位置與朝向是 God's Eye View 估計的；部分來源暫時抓不到畫面時會顯示「備援示意圖」，此時不會送去分析。
- 各鏡頭畫面的著作權與使用條款屬於各營運單位，畫面下方有來源與授權資訊。God's Eye View 以 MIT 授權釋出。

## 疑難排解

| 狀況 | 處理 |
|---|---|
| 右上角顯示「God's Eye View 未啟動」 | 確認 `Gods Eye View server` 視窗有在跑、沒有錯誤；或手動在 `gods-eye-view` 執行 `npm run dev` |
| 引擎顯示「未安裝」 | 在命令提示字元輸入 `agy --version`／`claude --version`／`codex --version` 確認在 PATH 中，安裝後需重開 `start.bat` |
| 分析逾時 | 調高 `timeoutSec`，或換引擎 |
| 「回覆中找不到偵測結果 JSON」 | 展開「錯誤細節」看 CLI 原始輸出；多半是模型回了說明文字而非 JSON，再按一次通常就好 |
