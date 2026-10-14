# HK Bus ETA — 香港巴士到站時間

輸入一個香港地標（商場、大廈、碼頭、機場），列出附近**九巴及龍運、城巴及新巴**巴士站，逐站睇實時到站時間。同一物理車站若兩家都有站，會自動合併顯示，唔使跳嚟跳去。仲可以**一鍵 GPS 定位**搵附近站，或者**查點到點路線**（自動建議直達或轉一次車方案）。

純前端、零後端、零帳號。全港約 **9,400 個車站**同**1,600+ 條路線**已離線打包，只有實時到站時間需要上網。

---

## 主要功能

- **地標搜尋**：輸入大廈／商場／屋苑名，揀命中點，列出 100／200／500 米內巴士站
- **一鍵定位**：用 GPS 即時列出附近巴士站，地圖顯示藍點同精度圈
- **實時到站時間**：每 15 秒自動更新，倒數顯示「即將到／N 分鐘」
- **路線詳情**：撳任何路線睇全線站序、方向切換（零網絡請求）、行車位標示
- **點到點路線**：輸入起終點，自動規劃直達或一次轉車方案（連網核對有冇班次）
- **個人化**：常到車站、常搭路線（手動加星或自動統計）、最近搜尋
- **離線使用**：冇網絡都搵到站、睇到站序；可安裝到手機主畫面當 App 用
- **跨公司合併**：同一站兩家都有 → 合併成一項；班次用公司色點分辨邊家

App 內嘅「選單 → 使用說明」有更詳細嘅使用教學。

---

## 安裝到手機（PWA）

1. 用手機瀏覽器開啟本 App
2. 選單 →「加入主畫面」／「安裝應用程式」（Android Chrome：選單 → 安裝應用程式；iPhone Safari：分享 → 加入主畫面）
3. 之後直接撳主畫面圖示開 App，離線都得

---

## 快速開始（開發者）

```bash
# 1. 產生／更新離線資料（抓官方 API → 精簡 → gzip）
node scripts/build-data.mjs

# 2. 啟動本地伺服器 → http://localhost:8181
node scripts/serve.mjs

# 3. 自動化驗證（需 playwright-core + Chrome）
NODE_PATH=<playwright-core 路徑> node scripts/verify.mjs

# 4. 部署前必須 bump Service Worker（否則用戶拿不到新版）
node scripts/bump-sw.mjs

# 5. 部署（Cloudflare Workers）
npm run deploy
```

版本號以 `public/manifest.json` 的 `version` 為單一真相來源，改版時必須同步 `package.json` 同 `app.js` 的 `VERSION_FALLBACK`（`bump-sw.mjs` 會檢查三者一致）。

**部署注意**：Deploy command 必須用 `npm run deploy`（本地 wrangler 依賴），唔好改回 `npx wrangler deploy`——Workers Builds 非互動環境下 `npx` 會失敗。詳見 `docs/deploy-cloudflare.md`。

### 每日自動更新資料

`.github/workflows/update-data.yml` 每日 **05:30 HKT** 自動抓最新官方資料、做健全性檢查、只在資料有實質變化時先部署——用戶唔會無故重新下載離線資料。

### 專案結構（精簡）

```
public/               全部靜態檔（index.html / css / js / 離線資料 / icons / Leaflet）
scripts/              build-data.mjs 資料打包 · serve.mjs 開發伺服器
                      verify.mjs 端到端驗證（292+ 項） · bump-sw.mjs SW 版本戳
docs/                 規劃書 · 部署說明 · 官方 API 參考
```

技術細節（資料打包、多營辦商 adapter、API 陷阱處理等）見 `docs/BusETA規劃書.md`；版本歷史見 [CHANGELOG.md](CHANGELOG.md)。

---

## 私隱

- 無伺服器、無帳號、無 analytics、無追蹤腳本
- 搜尋記錄、常搭路線、常到車站只存喺你自己部機（localStorage），可一鍵清除
- **GPS 座標不會傳送任何第三方**——只喺本機計算距離；地標搜尋只會傳地標文字畀搜尋服務

---

## 已知限制

| 限制 | 說明 |
|---|---|
| 離線時無地圖底圖 | 底圖來自 OpenStreetMap；站點位置圖層離線仍準確 |
| 地標搜尋有每日用量上限 | 已做快取節流；極高頻使用可能暫時受限 |
| 實時班次每線最多 3 班 | 官方 API 上限 |
| 預打包資料每日更新 | 介面會顯示資料更新時間 |

---

## 資料來源

- 運輸署「九龍巴士及龍運巴士路線實時到站數據」
  https://data.gov.hk/tc-data/dataset/hk-td-tis_21-etakmb
- 運輸署「城巴及新巴路線實時到站數據」（2023 年專營權合併後，原新巴路線已納入城巴資料）
  https://data.gov.hk/tc-data/dataset/hk-td-tis_21-citybus
- 地標地理編碼：Nominatim（OpenStreetMap，ODbL）
- 地圖底圖：© OpenStreetMap contributors
- 原始數據知識產權屬九龍巴士（一九三三）有限公司及龍運巴士有限公司、城巴有限公司

**本 app 非九巴、城巴或運輸署官方產品。**
