# BusETA

輸入一個香港地標（商場、大廈、機場），揀一個搜尋半徑，列出範圍內所有**九巴及龍運**巴士站，再逐站睇實時到站時間。

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

---

## 專案結構

```
public/
├── index.html          三頁單頁應用（搜尋 / 附近站 / ETA）
├── manifest.json       PWA manifest
├── sw.js               Service Worker（App Shell + ETA Network-First）
├── css/app.css
├── js/
│   ├── data.js         資料層：gzip 載入、索引、Haversine、ETA 格式化、adapter 註冊
│   └── app.js          應用邏輯：搜尋、附近站、ETA 輪詢、地圖
├── vendor/leaflet.*    Leaflet 1.9.4（本地化，支援 PWA 離線）
├── data/
│   ├── stops.json.gz   車站表 178 KB
│   ├── routes.json.gz  路線站序 161 KB
│   └── build-manifest.json
└── icons/              SVG + PNG（含 maskable）

scripts/
├── build-data.mjs      離線資料打包（4.24MB → 339 KB，8%）
├── bump-sw.mjs         Service Worker 版本戳（部署前必須跑）
├── serve.mjs           零依賴開發伺服器
├── verify.mjs          Playwright 端到端驗證（46 項）
└── verify-offline.mjs  離線模式驗證（13 項）
    verify-sw-version.mjs  SW 版本追蹤驗證

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
  searchPlace(query, signal)    // 地標搜尋
});
```

新增城巴／新巴只需註冊新 adapter，UI 與搜尋邏輯不需改動。唯一要處理的是**多營辦商 stop ID 對齊**（同一物理站可能有兩個系統的 ID）。

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
