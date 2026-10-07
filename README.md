# BusETA

輸入一個香港地標（商場、大廈、碼頭、機場），揀一個搜尋半徑，列出範圍內所有**九巴及龍運**巴士站，再逐站睇實時到站時間。點路線號可睇全線站序。

純前端、零後端、零 API key。已離線打包全港 6,753 個車站與 1,605 條路線，只有實時到站時間需要網絡。

---

## 快速開始

```bash
# 1. 產生／更新離線資料（抓官方 API → 精簡 → gzip）
node scripts/build-data.mjs

# 2. 啟動本地伺服器
node scripts/serve.mjs
# → http://localhost:8181

# 3. 自動化驗證（需 playwright-core + Chrome）
NODE_PATH=<playwright-core 路徑> node scripts/verify.mjs

# 4. 部署前必須 bump Service Worker（否則用戶拿不到新版）
node scripts/bump-sw.mjs
```

無建置步驟。`public/` 內全部係靜態檔，可直接部署到任何靜態託管（Cloudflare Pages、Vercel、Netlify、GitHub Pages）。

**部署前必讀**：[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) — 重點是 Service Worker 的 `bump-sw.mjs` 步驟。

### 每日自動更新資料

`.github/workflows/update-data.yml` 每日 **05:30 HKT**（cron `30 21 * * *` UTC）自動執行：

1. `build-data.mjs` 抓官方 API → 精簡 → gzip
2. 資料健全性檢查（車站 < 6,000／路線 < 1,500／關聯 < 30,000 即中止，防止異常資料推上 production）
3. 比較 `buildId`；**只在資料有實質變化時**才 `bump-sw.mjs` → commit → push → 觸發 Cloudflare 自動部署

`buildId` 只反映**資料內容**（gz 已剔除時間戳，hash 計算基於解壓後內容），所以官方資料無變化時不會部署，用戶亦不會無故被逼重新下載 339 KB 離線資料。首次手動測試可到 Actions 頁按 **Run workflow**。

---

## 專案結構

```
public/
├── index.html          四頁單頁應用（搜尋 / 附近站 / ETA / 路線詳情）
├── manifest.json       PWA manifest
├── sw.js               Service Worker（App Shell + ETA Network-First）
├── css/app.css
├── js/
│   ├── data.js         資料層：gzip 載入、索引、Haversine、ETA 格式化、adapter 註冊
│   └── app.js          應用邏輯：搜尋、附近站、ETA 輪詢、路線站序、地圖
├── vendor/leaflet.*    Leaflet 1.9.4（本地化，支援 PWA 離線）
├── data/
│   ├── stops.json.gz   車站表 178 KB
│   ├── routes.json.gz  路線站序 161 KB
│   └── build-manifest.json
└── icons/              SVG + PNG（含 maskable）

scripts/
├── build-data.mjs      離線資料打包（4.24MB → 339 KB，8%）
├── bump-sw.mjs         Service Worker 版本戳（部署前必須跑；純內容 hash，無變不改 sw.js）
├── serve.mjs           零依賴開發伺服器
├── verify.mjs          Playwright 端到端驗證（139 項）
└── verify-offline.mjs  離線模式驗證（13 項）
    verify-sw-version.mjs  SW 版本追蹤驗證

部署設定：
├── wrangler.jsonc      Workers Builds：name + assets.directory=./public
└── package.json        wrangler ^4.147.0（devDependency，deploy = `npm run deploy`）

> **不要把 Deploy command 改回 `npx wrangler deploy`。**
> Workers Builds 環境非互動（`CI=true`），`npx` 會拒絕自動下載套件而失敗；
> 必須用本地依賴（`npm run deploy`）。詳見 `docs/deploy-cloudflare.md`。

.github/workflows/
└── update-data.yml     每日 05:30 HKT 自動更新離線資料（資料無變則不部署）

docs/
├── BusETA規劃書.md     產品與技術規劃
├── deploy-cloudflare.md 部署說明（含 CI 範例）
└── reference/          官方 PDF 規格 + 實測原始 JSON
```

---

## 核心設計

### 離線資料打包（339 KB）

官方原始資料 4.24 MB，經三步壓縮至 **339 KB（8%）**：

| 步驟 | 效果 |
|---|---|
| 刪除冗餘欄位 | 移除 `co`（永遠 `"KMB"`）、`data_timestamp`（每日重覆） |
| 字串 ID → 整數索引 | 16 字符 stop ID / 路線號改為 `[routeIdx, seq, stopIdx]` |
| 座標 → 整數微度 | `lat/lng` × 1e7 取整（精度 1.1 cm，遠超需求） |
| gzip level 9 | 陣列格式高度重複，壓縮率 60-70% |

結果：**用戶首次開啟零等待**，且**離線時仍可查「附近有咩站」「路線經過咩站」**。

### 適配器介面（為多營辦商預留）

```javascript
BusETA.registerAdapter({
  id, label,
  loadStatic(),                 // 載入離線資料
  fetchStopEta(stopId, signal), // 單站 ETA
  fetchRouteEta(route, svc),    // 全線 ETA
  fetchSingleStopEta(stopId, route, svc, signal),  // 單站+單線 ETA（optional，路線頁用）
  searchPlace(query, signal)    // 地標搜尋
});
```

新增城巴／新巴只需註冊新 adapter，UI 與搜尋邏輯不需改動。唯一要處理的是**多營辦商 stop ID 對齊**（同一物理站可能有兩個系統的 ID）。

> `fetchSingleStopEta` **刻意不列入 `registerAdapter` 必填清單** —— adapter 介面不應因可選功能而收窄未來擴充點。未實作該方法的 adapter，路線頁仍可正常顯示離線站序，只是不顯示選中站 ETA。

### 路線詳情頁（M7）

點 ETA 頁的路線行即可進入，睇全線由第一站到最後一站的站序。

| 設計點 | 實測依據 |
|---|---|
| **站序完全來自離線資料** | `routeSeqs[routeIdx]` 已有完整站序 → 首次進入**零網絡請求**，繼承「離線可查路線」定位 |
| **ETA 只查選中站** | `/eta/{stop}/{route}/{svc}` 實測 **961 bytes**；`route-eta/{route}/{svc}` 實測 **13–43 KB**（差 30 倍，後者會把 99% 資料丟掉） |
| **按 `(dir, seq)` 過濾** | 單站端點會混合方向：實測 `/eta/竹園邨總站/1/1` 回 6 rows = O seq 1 + I seq 25 各 3 班 |
| **完整三元組索引** | 221 組 `(route,bound)` 有多個 svc，其中 **220 組站序不同**（3D/I 平日去「慈雲山(中)」17 站、繁忙時段去「慈雲山(南)」13 站）→ 索引必須含 svc，並有 fallback 鏈（原值 → 1 → 同方向任一變體） |
| **循環線自動合併** | 實測 **114 條**路線（3S、5D、7M 等）頭尾會經過同一 stopId → 多個 seq 對應同一站自動合併，提示「第 N 站」 |
| **零網絡方向切換** | O/I 兩方向站序都已在離線資料內，切換分頁不發請求 |

### 地標搜尋的命中率問題：排序準則

規劃書 §3.4「坑三」記錄咗「命中點可能是隔籬建築物」，原本只做咗顯示距離讓用戶自行判斷。實測發現**距離唔夠用** —— 多個命中點嘅 `display_name` 完全相同，用戶無從分辨。

兩個實測案例：

| 查詢 | Nominatim 返回 | 問題 |
|---|---|---|
| 淘大花園 | `bus_stop`（距 KT376 **30m**）+ `residential`（**76m**），**兩者名稱完全相同** | 用戶只能靠顏色/位置猜；揀錯就令 200m 圓形剛好切邊，漏咗德福花園（3 組 → 5 組）|
| 黃大仙中心 | `商場`「黃大仙中心」+ 鄰近 `bus_stop`「沙田坳道」（同樣 12m）| 反過來：若一律讓 bus_stop 優先，會令**商場被鄰站蓋掉**（14 個站 → 13 個）|

**排序準則**（依序判斷，`renderResults` 內）：

1. **名稱與查詢字串完全相同** → 最準（用戶要的就是這個地點）
2. 名稱包含查詢字串
3. `bus_stop` / `bus_station` 命中點 → 座標準確
4. 其他 POI（商場、大廈…）
5. 兜底

並加上視覺標籤：`bus_stop` 標「準確位置」、同名但非 bus_stop 標「區塊中心」、距離 > 250m 標「位置可能有偏差」。

**效果（淘大花園實測）**：200m 範圍由 13 個站 / 3 組 → **25 個站 / 6 組**，距離 76m → 2m；而「黃大仙中心」仍維持 14 個站（規劃書實測值）。

`verify.mjs` 的 `[3a]` / `[3a-2]` 為此二案例的迴歸測試。

### 地標搜尋的速率限制與錯誤處理

Nominatim 是 OSM 提供的免費公開服務，其[使用政策](https://operations.osmfoundation.org/policies/nominatim/)有硬性約束。實測發現 app 原有的搜尋方式違反其中兩條，導致用戶看到「搜尋服務暫時繁忙」：

| 政策要求 | 原實作 | 現實作 |
|---|---|---|
| **硬性上限 1 request/second** | debounce 400ms，連續打字可達 2.5 req/s | debounce 600ms **＋** 序列化佇列硬節流 1100ms |
| **同一查詢重覆發送會被視為 faulty 並封鎖** | 零緩存 | 記憶體 LRU 60 條 ＋ `localStorage` 持久化，TTL 30 分鐘 |
| 需提供有效 Referer / User-Agent | 瀏覽器自動帶 Referer | 同上（實測 UA 過短如 `Mozilla/5.0` 會直接 403）|

節流層在 `data.js` 的 `searchPlaceRatelimited()`：命中緩存零請求；未命中排隊到「離上次請求 ≥ 1100 ms」才發出。實測 3 個連續查詢的實際間隔為 **1103 / 1101 ms**，符合政策。

**錯誤分類**（原本所有錯誤共用一句「可能已達使用量上限」，令用戶撳 reload 也無效）：

| 狀況 | 顯示 | 理由 |
|---|---|---|
| `403` | 搜尋服務暫不接受查詢 | 服務端按政策封鎖（過量／未標示來源），reload 無用 |
| `429` | 請求太頻密 ＋ 讀取 `Retry-After` 告知等待秒數 | 用戶可據此判斷等幾耐 |
| `400` | 搜尋字串無法處理 | 建議加區名或去括號 |
| 網絡中斷 | 無法連接搜尋服務 | 引導檢查連線 |
| `5xx` / 其他 | 搜尋服務暫時繁忙 | 泛化訊息 |

按鈕亦由 `location.reload()`（無效）改為 `重新搜尋`。

### 個人化功能

搜尋頁三個區塊：**最近搜尋**（可逐項刪除）＋ **常搭路線 / 常到車站**（同一分頁容器，避免三區同時出現過於擠迫）。

| 功能 | 記錄方式 | 儲存 |
|---|---|---|
| **常到車站** | ETA 頁手動加星，清單內可逐項移除 | `buseta.favorites` |
| **常搭路線（釘選）** | 路線頁手動加星，上限 10 條，清單內可逐項取消 | `buseta.favRoutes` |
| **常搭路線（自動統計）** | 同一路線**首次查看不計**（視為試用），第二次起累加；顯示達門檻者 top 5 | `buseta.routeVisits` ＋ `buseta.routeVisitsHidden` |

分頁在當前分頁無內容時自動切換、該分頁清空後自動禁用。

路線頁星號與 ETA 頁星號是**不同層級**：前者記「常搭這條路線」，後者記「常到這個站」。

**兩種常搭路線都可逐項移除**，但語義不同：

| 列 | 移除動作 | 行為 |
|---|---|---|
| ⭐ 已加星 | 取消常搭 | 從 `favRoutes` 移除，之後可再手動加回 |
| ☆ 未加星（自動統計） | 不再記錄 | 加入 `routeVisitsHidden` 屏蔽清單。**只刪計數的話，用戶下次再查同一路線兩次就會重新出現**，會令人覺得「刪咗但又彈返出嚟」 |

手動加星會自動解除屏蔽（用戶主動加星代表想再見到這條路線）。清除本機資料的連結文案為「清除本機所有資料」，並附說明四類資料只存於裝置；確認框會列出各類實際筆數。

**返回目標跟隨來源**（`state.etaFrom` / `state.routeFrom`）：

| 進入方式 | ETA 頁返回 | 路線頁返回 |
|---|---|---|
| 搜尋搜尋地標 → 附近站 → ETA | 附近站 | ETA |
| 常到車站清單 → ETA | **首頁** | — |
| 常搭路線清單 → 路線頁 | — | **首頁** |
| 路線頁點 `→` → 該站 ETA | **路線頁**（該站序仍有用） | — |

### 官方 API 陷阱處理
實測發現並已處理（詳見規劃書 §2.3-2.5）：

| 陷阱 | 處理 |
|---|---|
| 無效路線回 `200 + data:[]`（非 404） | 檢查 `data` 長度，不依賴 HTTP code |
| ETA 跨 `service_type` 混入 | 按 `(stop, route, dir, seq, eta_seq, eta)` 去重 |
| `eta: null` 佔 29%，但 `rmk_tc` 有服務語義 | 按 rmk 分流為「暫時冇預報」/「今日非服務日」/「暫停服務」 |
| `service_type` 有 8 種值（非官方所述 3 種） | 全部處理，UI 顯示時段標籤 |
| 同名車站有多個 stop ID | 剝除括號編碼後合併，標示「N 個行車位」，ETA 平行查詢後合併 |
| Nominatim `countrycodes=hk` 令結果變 0 筆 | 改用「附加香港關鍵字 + 座標範圍過濾」 |

### 開機時序：DB 未載入前不可呼叫依賴 DB 的 UI

離線資料要解壓 339 KB gzip，通常需 0.5–2 秒。這段時間內使用者已經可以操作 UI，所以任何讀 `DB` 的渲染函式都可能撞到 `DB === null`。

**規則：`renderRecent()` 依賴 `DB`**（內部 `routeDestName()` 要查 `DB.routeList` 取終點名），因此：

- `boot()` 只在**載入成功之後**呼叫 `renderRecent()`（原本在 `try` 之前呼叫 → 必拋 `TypeError: Cannot read properties of null (reading 'routeList')`）
- `routeDestName()` 本身也要守衛 `if (!DB || !DB.routeList) return ''` —— 因為 `input` handler 觸發的 `showResults(null)` 也會呼叫 `renderRecent()`，無法保證時序
- 資料載入失敗時也要呼叫 `renderRecent()`，否則會顯示過時的終點名

`verify.mjs` 的 `[8b-4]` 用延遲 gz 回應 1.2 秒製造 race window，回歸此類問題。

### 距離搜尋

`findNearbyStops()` 先用經緯度矩形預篩（500m 約命中 50-200 個站），再精算 Haversine。實測 **6,753 站全掃描 < 1 ms**，列表計算零網絡請求。

### ETA 輪詢

- 每 15 秒（`POLL_MS`），撞 CDN `max-age=300` 快取時不增加對方負載
- 頁面不可見時暫停（`visibilitychange`）
- 合併站平行查詢多個 stop ID，共用一個 `AbortController` + token 防止競態
- 單一 stop 查詢失敗不影響整組
- 單一 `setInterval` 統一更新倒數，非每個 ETA 一個 timer

### 地圖

地圖**唔會自動顯示**，需手動開啟。兩個入口：

- 搜尋並選好地標後，在「附近巴士站」頁的 **100／200／500 米切換列右邊撣「地圖」按鈕**（推薦，觸控目標大）
- 或撣頁頂右上角的地圖圖示

開啟後為全屏覆蓋，右上角 ✕ 關閉。切換搜尋半徑時地圖會即時重繪。

- Leaflet 1.9.4 本地化，zoom 鎖 15-16
- 範圍圓圈、站點 marker、同名站聚合標記 = vector 圖層，**離線仍可繪製**
- 連續 2 張 tile 載入失敗 → 自動移除底圖，保留 vector 圖層 + 顯示「離線模式：無底圖」
- 點擊 marker 直接跳該站 ETA 頁
- 距離 < 150 米的站會常駐顯示站名標籤，其餘靠點擊／懸停查看

### 私隱

- 無伺服器、無帳號、無 analytics、無追蹤腳本
- 搜尋歷史與最愛站只存 `localStorage`，一鍵清除
- **GPS 座標不會傳送任何第三方**（Nominatim 只收地標文字）

---

## 已知限制

| 限制 | 說明 |
|---|---|
| 只支援九巴／龍運 | 城巴／新巴需新增 adapter；介面會提示「此站可能只有城巴／新巴路線」 |
| 離線時無地圖底圖 | 底圖來自 OpenStreetMap 圖磚服務；vector 圖層仍準確 |
| Nominatim 每日 1,000 次上限 | 已做兩層快取；100 用戶高頻使用仍可能觸及上限，需適配 Google Places 或自建 POI 庫 |
| 預打包資料每日過期 | 需定期跑 `build-data.mjs`；介面顯示資料更新時間 |
| `rmk_tc` 服務類型文案 | 依賴官方字串，未知類型統一顯示「暫停服務」 |
| ETA 只有 3 班 | 官方 `stop-eta` 上限；更長時間表需 `route-eta` |

---

## 資料來源

- 運輸署「九龍巴士及龍運巴士路線實時到站數據」
  https://data.gov.hk/tc-data/dataset/hk-td-tis_21-etakmb
- API 規格 v1.05（2024-10-23）、數據字典 v1.02（2021-05-10）
- 原始數據知識產權屬九龍巴士（一九三三）有限公司及龍運巴士有限公司
- 地標地理編碼：Nominatim（OpenStreetMap，ODbL）
- 地圖底圖：© OpenStreetMap contributors

**本 app 非九巴或運輸署官方產品。**
