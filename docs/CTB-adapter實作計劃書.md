# CTB Adapter 實作計劃書（對應現有九巴 adapter）

> 起草日期：2026-10-07｜v2 修訂：2026-10-09（按代碼審核結果修訂）｜**v3 實作完成：2026-10-09**｜狀態：**✅ 已實作並通過驗證（183 項測試全綠）**
>
> **v3 實作後的兩項重要修正**（詳見文末「實作後修正」節）：
> 1. §3.1 的**方向 → 端點映射寫反了**：實測確認應為 `O → dest_tc`、`I → orig_tc`（原寫 `I → dest_tc`、`O → orig_tc`）。
>    若照原文實作，每條路線的**入站終點都會顯示錯**。已修正並由 [CTB-7] 測試鎖定。
> 2. §3.1「站 ID 16 字符字串」只適用於九巴；**城巴係 6 位zero-padded 數字字串**（如 `002737`）。
> 前置查證：`docs/城巴新巴資料可得性查證.md`（API 簽名 + live 實測已全部通過）
> **CORS 驗證（2026-10-09 確認）**：`rt.data.gov.hk`（原生 `/eta`、`/route`、`/route-stop` 及 DPO `batch/stop-eta`）已於瀏覽器環境實測 fetch 成功，**跨域可行，無需 proxy**。此為 v1 計劃書遺漏的前置條件，現已補入。
> 現有設計基準：`docs/BusETA規劃書.md` §5.7（adapter 預留）、`public/js/data.js`、`public/js/app.js`、`scripts/build-data.mjs`、`public/sw.js`

> **v2 修訂摘要**（2026-10-09 審核發現，詳見各節）：
> 1. ~~CORS 未驗證~~ → 已驗證通過（上）。
> 2. §3.2 原稱「normalizeEta 完全唔使改」**有誤**——normalizeEta 讀 `dest_tc`/`rmk_tc`/`service_type`，統一形狀必須定義為 **KMB 欄位名**，由 `mapCtbEta` 負責轉換。
> 3. `fetchRouteEta` 由必填降級為 optional（app.js 從未呼叫，屬死介面），否則 CTB 物件註冊即 throw。
> 4. CTB 路線表須按方向映射目的地（~~I → `dest_tc`、O → `orig_tc`~~ → ⚠️ **v3 實測證實原方向相反，應為 `O → dest_tc`、`I → orig_tc`**，見文末）。
> 5. DPO batch URL 必帶 `?lang=zh-hant`，否則 dest／rmk 返英文。
> 6. Build 決定性：`/stop` 並發抓取須按 first-seen 次序重排輸出，否則 buildId 不穩。
> 7. 補 P1：`routeVisitsHidden` 加 co、manifest 結構兼容（top-level `buildId` 保留）、九巴硬編文案清單、`booting` guard reset、切換器只放搜尋頁、DPO fallback 路徑寫明。

---

## 1. 目標與範圍

**目標**：喺 BusETA 加入城巴（CTB）adapter，令 app 可查城巴／前新巴路線嘅實時 ETA。因 2023 專營權合併，所有前新巴路線已併入 `company_id = "CTB"`，**一個 CTB adapter 即同時覆蓋城巴 + 新巴**，唔需要獨立 NWFB adapter。

**MVP 範圍（本計劃）**：
- 採用**公司切換器（Company Switcher）**：UI 頂部提供「九巴及龍運 / 城巴及新巴」切換，一次只載入並顯示一家公司嘅資料。
- 唔做**跨公司物理站對齊聚合**（同一物理站嘅九巴 + 城巴兩個 stop ID 合併顯示）—— 此為規劃書 R8，原定 MVP 唔做，留待後續階段（見 §11 未來方向）。

**不在本計劃**：NLB（新大嶼山巴士）、跨公司聯程搜尋、物理站對照表。

---

## 2. Adapter 介面對照（v2 修訂：`fetchRouteEta` 降級 optional）

`data.js` 的 `registerAdapter` **現行**必填檢查含 `fetchRouteEta`（`data.js:81`）。v2 修訂：**將 `fetchRouteEta` 由必填清單移除，降級為 optional**（與 `fetchSingleStopEta` 同等待遇）。理由：
- 實測 `app.js` 全檔只呼叫 `fetchStopEta` 與 `fetchSingleStopEta`，`fetchRouteEta` 屬**從未被 UI 呼叫的死介面**；
- 介面契約應反映實際使用——此舉正正符合「adapter 介面不應因可選功能收窄未來擴充點」嘅既有原則；
- CTB 無全線端點，若維持必填，CTB 物件註冊即 throw，必須寫無意義 stub。

修訂後必填方法（5 項）：`id` / `label` / `loadStatic` / `fetchStopEta` / `searchPlace`。

| 方法 | 簽名 | KMB 實作 | CTB 要點 |
|------|------|----------|----------|
| `id` / `label` | string | `'kmb'` / `'九巴及龍運'` | `'ctb'` / `'城巴及新巴'` |
| `loadStatic(manifest)` | → store | 載 `stops.json.gz` + `routes.json.gz`，建 8 個索引 | 載 `ctb-*.gz`，建同構索引（**無 svc**）；**須適配新 `manifest.companies` 結構**（見 Phase 1） |
| `fetchStopEta(stopId, signal)` | → rows[] | `stop-eta/{stopId}`（1 request） | 用 DPO `batch/stop-eta/CTB/{stopId}?lang=zh-hant`（1 request）；fallback 見決策 2 |
| `searchPlace(query, signal)` | → POI[] | Nominatim（公司無關） | **直接重用** KMB 同一份 Nominatim 實作 |

Optional 方法：
- `fetchSingleStopEta(stopId, route, svc, signal)`——CTB 會實作（原生 `/eta/CTB/{stopId}/{route}`，~1 KB，對應 KMB 同名牌）。
- `fetchRouteEta(route, svc, signal)`——**兩家公司均不實作／不再要求**；KMB 既有實作保留但不再屬必填（向後兼容，已註冊的 KMB adapter 唔受影響）。

---

## 3. CTB 資料模型差異對照（最關鍵，整合必讀）

### 3.1 離線靜態資料差異

| 項目 | 九巴 KMB | 城巴 CTB | 影響 |
|------|----------|----------|------|
| 列出所有站 | `GET /stop` 一次過返全部 | **無 bulk**；`/stop/{stop_id}` 只收單站 ID | build 腳本要先經 `route-stop` 枚舉所有 stop ID，再逐站 `/stop/{id}` 取資料 |
| 路線表 | `/route/` → `[route, bound, service_type, dest_tc]` | `/route/CTB` → `{co, route, orig_tc, dest_tc}`（**無 bound / 無 svc；orig/dest 各只一份**） | CTB routeList 存 `[route, dir, 1, dest]`，**dest 按方向映射：`dir='O' → dest_tc`、`dir='I' → orig_tc`**（⚠️ **v3 實測修正**：v2 原寫反向。實測 2026-10-09 route 1：DPO ETA 對 dir='O' 回 dest=跑馬地(上)=dest_tc，而 route-stop inbound（dir='I'）末站=中環(港澳碼頭)=orig_tc。與 UI 慣例 I=往總站／O=開往終點一致）；`dir` 由 route-stop 補；svc 恆為 1 |
| 路線站序 | `/route-stop` → `[routeIdx, seq, stopIdx]`（含 bound+svc） | `/route-stop/CTB/{route}/{direction}` → `{co,route,dir(I/O),seq,stop}`（**無 svc**） | 同一 (route,dir) 一組；建索引 key 改 `"route|dir|1"` |
| 站 ID 格式 | 16 字符字串 | **6 位 zero-padded 數字字串**（`002737`） | 兩者皆 string，比較無影響；但要確保全程當 string 處理（不可當數字，會失去前導零） |
| 規模 | ~1605 變體 / ~600 路線 | **407 條路線**（每線 18–40 站，估算 ~2500 獨立站） | gz 體積與 KMB 同級（預計 200–350 KB），boot 負擔可控 |

### 3.2 即時 ETA 欄位差異（影響 `normalizeEta`）

| 欄位 | KMB `stop-eta` | CTB 原生 `/eta` | CTB DPO `batch/stop-eta` |
|------|---------------|-----------------|--------------------------|
| 公司 | `co`（KMB） | `co`（CTB） | `co` |
| 路線 | `route` | `route` | `route` |
| 方向 | `dir`（O/I） | `dir`（I/O） | `dir`（I/O） |
| 站序 | `seq` | `seq` | `seq` |
| 站 ID | `stop` | `stop` | `stop` |
| 目的地 | `dest_tc` | `dest_tc` | `dest`（**無 _tc 後綴**） |
| ETA 時間 | `eta`（ISO） | `eta`（ISO） | `eta`（ISO） |
| ETA 序 | `eta_seq` | `eta_seq` | `eta_seq` |
| 備註 | `rmk_tc` | `rmk_tc` | `rmk`（**無 _tc 後綴**） |
| service_type | 有（1–9） | **無** | **無** |
| 時間戳 | `data_timestamp` | `data_timestamp` | `data_timestamp` |
| 尾空格坑 | — | `generated_timestamp ` 尾帶 space | 同左 |
| 語言參數 | — | 回應已含 `*_tc` 欄位 | **URL 必帶 `?lang=zh-hant`**，否則 `dest`/`rmk` 返英文（v2 修訂補入） |

**結論（v2 修訂）**：CTB 缺 `service_type`，且 DPO 批次用 `dest`/`rmk` 而非 `dest_tc`/`rmk_tc`。**統一內部形狀 = KMB 欄位名**（`dest_tc` / `rmk_tc` / `service_type` / `eta_seq` / `data_timestamp`）——因為 `normalizeEta`（`data.js:486-509`）實際讀嘅就係呢批欄位名。各 adapter 的 fetch 方法負責把 raw row 映射成此形狀：

```js
// CTB raw row（DPO 或原生）→ KMB 欄位名，normalizeEta / formatEta 唔使改
const mapCtbEta = (r) => ({
	...r,
	dest_tc: r.dest_tc || r.dest || '',   // DPO 用 dest（無 _tc）
	rmk_tc: r.rmk_tc || r.rmk || '',
	service_type: null                     // CTB 無 svc 概念
});
```

`normalizeEta` / `formatEta` / `SERVICE_LABELS` **唔使改**（CTB row 經 `mapCtbEta` 後欄位名與 KMB 完全對齊；`svc:null` 於 `renderEta` 的 `mainSvc == null ? 1 : mainSvc` 分支自然落到「不分服務類型」顯示）。

---

## 4. 決策分支（2026-10-09 審核後確認）

1. **公司切換模式**：✅ **A. 切換器**（一次顯示一家公司，切換時 reload 該公司離線資料）。零 stop-ID 對齊風險，工作量大減。
2. **`fetchStopEta` 取數策略**：✅ **DPO batch 為主**（`batch/stop-eta/CTB/{stopId}?lang=zh-hant`，1 request 取該站全部線）。**Fallback 路徑（v2 寫明）**：DPO 掛時，用離線索引 `getStopRoutes(DB, stopId)` 枚舉該站路線 → 逐線並發（限 ~4）call 原生 `/eta/CTB/{stopId}/{route}` → 合併結果。路線清單來自離線資料，fallback 無需額外請求。
3. **路線詳情頁 ETA 策略**：✅ **lazy 單站**——路線頁只對「選中站」lazy call `fetchSingleStopEta`（原生 `/eta`），與 KMB 行為一致。`fetchRouteEta` 已降級 optional（§2），CTB 唔實作。
4. **收藏／常搭路線跨公司處理**：✅ **按公司隔離**——favorites / favRoutes / routeVisits / **routeVisitsHidden**（v2 補入）的 key 全部加 `co`；舊有九巴資料無 co → 讀取時 default `'kmb'`（向下兼容）。切換公司時，各列表按當前公司過濾顯示。
   - ⚠️ `routeVisitsHidden` 若唔加 co：路線號 1、5、10 等兩家公司重疊，屏蔽九巴 `1|O` 會連城巴 `1|O` 一齊誤屏蔽。
5. **CTB 輪詢頻率（v2 新增，實作時可調）**：CTB 官方聲明 ETA **每分鐘更新**，沿用 KMB 的 15s 輪詢會浪費 ~4× 請求。建議 `POLL_MS` 改 per-adapter（CTB 30s，KMB 維持 15s），Phase 5 實測連續兩輪回應是否相同後可再調。

---

## 5. 各 Phase 實作細節

### Phase 0 — `scripts/build-data.mjs` 通用化（支援 CTB）

- 抽出 `COMPANIES` 配置：
  ```js
  const COMPANIES = {
    kmb: { base: 'https://data.etabus.gov.hk/v1/transport/kmb', kind: 'kmb' },
    ctb: { base: 'https://rt.data.gov.hk/v1/transport/citybus-nwfb', kind: 'ctb',
           batchBase: 'https://rt.data.gov.hk' }
  };
  ```
- **CTB 資料抓取流程**（與 KMB 不同，無 bulk stop）：
  1. `GET /route/CTB` → 路線清單（route, orig_tc, dest_tc）。
  2. 對每條 route，call `/route-stop/CTB/{route}/inbound` + `/outbound` → 收集 `(route, dir, seq, stop)`，同時以 **first-seen 次序**記低 unique stop ID（次序確定，與請求完成次序無關）。
  3. 對 unique stop ID 批量 call `/stop/{stop_id}`（concurrency 限制 ~8，沿用現有 retry）取 name/lat/lng。
  4. **決定性重排（v2 修訂，必做）**：`/stop` 並發抓取的**完成次序不確定**，輸出前必須按步驟 2 的 first-seen 次序（或 stop ID 排序）重排——否則 gz 內容次序不穩 → raw hash（buildId）每次唔同，違反驗收標準第一條。
  5. 精簡後輸出 `ctb-stops.json.gz`、`ctb-routes.json.gz`（schema 與 KMB 同構：`stops=[stopId,name,latE7,lngE7]`、`routes=[route,dir,1,dest]`——**dest 按方向映射 I→dest_tc / O→orig_tc**、`routeStops=[routeIdx,seq,stopIdx]`，routeStops 照舊按 routeIdx,seq 排序）。
- 實作細節：CTB `/stop/{id}` 回應的 `data` 係**物件**（非陣列），現有 `fetchJson` 的 `json.data.length` log 要相容；CTB 錯誤回應形狀（HTTP 422 + message）與 KMB 的 `{code,message}` 不同，錯誤分流要分開處理。
- **manifest**：保留單一 `data/build-manifest.json`，內含 `companies: { kmb:{files,stops,routes,routeStops,buildId}, ctb:{...} }`，**並保留 top-level `buildId`**（= 所有公司檔案 raw 內容 hash；`sw.js` 的 `resolveShellCache` 讀 top-level `m.buildId`，唔可以斷）。shell cache buildId = 所有公司檔案內容 hash。
- 輸出時印 CTB gz 體積，確認 buildId 穩定性（gz 唔可含時間戳，沿用現有機制；另須**連跑兩次驗證 buildId 相同**，覆蓋決定性重排）。

### Phase 1 — `public/js/data.js`：新增 CTB adapter + 解耦 ETA 欄位

- `registerAdapter` 必填清單移除 `fetchRouteEta`（§2）；KMB adapter 既有 `fetchRouteEta` 保留不刪。
- **KMB `loadStatic` 適配新 manifest 結構**：讀 `manifest.companies.kmb` 的 files（保留對舊 top-level `files` 的讀取兼容亦可，但部署時 manifest 已換新版，以新結構為準）。
- 抽出共用 Nominatim：`const nominatimSearchPlace = async (query, signal) => {...}`（現 KMB.searchPlace 內容原樣搬出），KMB 同 CTB 都委派佢。
- 新增 CTB adapter 物件：
  ```js
  const CTB = {
    id: 'ctb', label: '城巴及新巴',
    apiBase: 'https://rt.data.gov.hk/v1/transport/citybus-nwfb',
    batchBase: 'https://rt.data.gov.hk',
    async loadStatic(manifest) { /* 讀 manifest.companies.ctb 的 ctb-*.gz，建同構索引（dir 由 route-stop 來，svc=1） */ },
    async fetchStopEta(stopId, signal) {
      // ⚠️ lang=zh-hant 必帶：DPO 欄位無 _tc 後綴，唔帶會返英文 dest/rmk
      const json = await this._get(`${this.batchBase}/v1/transport/batch/stop-eta/CTB/${stopId}?lang=zh-hant`, signal);
      return (json.data || []).map(mapCtbEta);
    },
    async fetchSingleStopEta(stopId, route, _svc, signal) {
      const json = await this._get(`${this.apiBase}/eta/CTB/${stopId}/${route}`, signal);
      return (json.data || []).map(mapCtbEta);
    },
    // fetchRouteEta：唔實作（已降級 optional，見 §2）
    async searchPlace(query, signal) { return nominatimSearchPlace(query, signal); }
  };
  registerAdapter(CTB);
  ```
- `mapCtbEta(r)`：見 §3.2——輸出 **KMB 欄位名**（`dest_tc`/`rmk_tc`/`service_type:null`），normalizeEta 唔使改。
- DPO fallback：`fetchStopEta` catch → `getStopRoutes(DB, stopId)` 枚舉路線 → 限並發逐線原生 `/eta` → 合併（決策 2）。
- **store 收藏加 co（v2 擴至全部四個 key）**：`favorites.toggle(stop)` → 存 `{co, stop, name, lat, lng}`；`favRoutes` / `routeVisits` / **`routeVisitsHidden`** key 改 `"{co}|{route}|{bound}"`。讀取舊九巴資料時 `co||'kmb'`。

### Phase 2 — `public/js/app.js`：動態 adapter + 按公司載入

- 移除 `const adapter = B.getAdapter('kmb')` 硬編碼 → 改 `let adapter = B.getAdapter(currentCo())`，`currentCo()` 讀 localStorage（預設 `'kmb'`）。
- `boot()`：根據 `adapter.id` 讀 `manifest.companies[co]` 檔案；**`booting` promise guard 必須可 reset**（v2 修訂：現行 `if (booting) return booting` 快取 forever，切換公司前要 `booting = null`），並處理進行中 gz fetch 的 race（舊請求完成不可覆蓋新公司嘅 DB）。
- 切換公司流程（鐵律）：`stopPolling()` + `stopRoutePolling()` → 重置 `state`（nearby/stop/route/返回目標）→ `booting = null` → `boot()` → 返回搜尋頁。
- 所有 `adapter.id` 傳入 `searchPlaceRatelimited(...)`（Nominatim 本身公司無關，但保持介面一致）。
- 收藏／常搭路線渲染：傳 `co` 落 store 方法；切換公司時過濾顯示。
- **文案公司化（v2 補入，具體位置見 §8a）**：搜尋結果「最近九巴站」、附近站空結果「本 app 暫未涵蓋」等，改為按當前公司動態顯示。

### Phase 3 — `public/index.html` + CSS：公司切換器

- **切換器只放搜尋頁頂部**（v2 修訂：MVP 唔喺 ETA／路線頁提供切換——深層頁切換要清嘅狀態多一倍，RC7 風險翻倍；用戶要切換就先返搜尋頁）。
- 一組 segmented control（九巴及龍運 / 城巴及新巴），點擊 → 存 localStorage + 觸發 Phase 2 切換流程 + 重置搜尋／ETA 狀態。
- 切換時顯示輕量 loading（載 gz 需 0.5–2s，沿用現有 `updateNetState` 風格提示）。
- **文案清單（v2 補入，須逐項改）**：
  | 位置 | 現況 | 改法 |
  |------|------|------|
  | `index.html:7` meta description | 「九巴及龍運」 | 改「巴士」（公司中立） |
  | `index.html:41` header subtitle | 「九巴及龍運巴士到站時間」 | 按當前公司動態（`<span id>` JS 更新） |
  | `index.html:71-73` 資料來源歸屬 | 只列九巴 dataset | 兩家公司輪換／並列；CTB 註明「資料來源：城巴（data.gov.hk），知識產權屬城巴」——**歸屬聲明係 data.gov.hk 開放數據條款要求，唔可以漏** |
  | `public/manifest.json:4` PWA description | 「九巴及龍運」 | 改公司中立 |
  | `app.js:207` 「最近九巴站 X 米」 | 硬編 | 按當前公司（「最近城巴站」） |
  | `app.js:502` 附近站空結果 | 「本 app 暫未涵蓋」提示城巴 | 改為提示**另一家公司**可能覆蓋 + 引導切換 |
  | `app.js:695` ETA 空結果 | 「九巴／龍運的行車時間表…」 | 按當前公司 |
- `app.css` 加切換器樣式；`--brand`（九巴紅 `#b3121b`）可順便按公司切換（CTB 黃），屬可選 polish。

### Phase 4 — `public/sw.js`：cache 多公司資料 + CTB ETA 離線回退

- `SHELL` 陣列加 `'./data/ctb-stops.json.gz'`、`./data/ctb-routes.json.gz'`。
- 第二個 ETA fetch handler 嘅 host 檢查由 `data.etabus.gov.hk` 擴展為 `data.etabus.gov.hk` **或** `rt.data.gov.hk`（CTB 原生 + DPO batch 都喺此 host），令 CTB ETA 離線時可回退最後成功回應。
- **manifest 兼容確認（v2 補入）**：`resolveShellCache` 讀 top-level `m.buildId`——Phase 0 已保證保留 top-level `buildId`（= 全公司檔案 hash），任一家公司資料變都會令 SW 快取名變。
- 改完殼層檔案後**必跑 `node scripts/bump-sw.mjs`**（現有鐵律）。

### Phase 5 — `scripts/verify.mjs`：加 CTB 回歸測試

- 新增 CTB 分組：
  - `[CTB-1]` build 出嘅 `ctb-*.gz` 可解壓、索引數量合理；**`[CTB-1b]` 同資料連跑兩次 build，buildId 相同（決定性驗證）**。
  - `[CTB-2]` `mapCtbEta` 對 DPO（`dest`/`rmk`）與原生（`dest_tc`/`rmk_tc`）兩種 raw 形狀都映射出 KMB 欄位名，`normalizeEta` 輸出 dest/rmk 非空。
  - `[CTB-3]` `fetchStopEta` 用 DPO batch URL **且帶 `?lang=zh-hant`**。
  - `[CTB-4]` 無 svc（`service_type:null`）時 `normalizeEta`／`renderEta` 唔報錯、`data-svc` 落 1。
  - `[CTB-5]` 收藏加 co 後舊九巴資料 default `'kmb'`；**`[CTB-5b]` 屏蔽九巴 `1|O` 唔影響城巴 `1|O`（hidden 清單隔離）**。
  - `[CTB-6]` 切換公司：雙 timer 清乾淨、`booting` reset、無 console error。
  - `[CTB-7]` CTB 路線頁**出站方向終點顯示 `orig_tc`**（非 dest_tc）。
- 既有 139 項全跑通。

### Phase 6 — 文檔

- `docs/BusETA規劃書.md`：§5.7 補「CTB adapter 已實作」；§6 R8 狀態改為「MVP 仍唔做跨公司對齊（切換器模式）」；新增 CTB 整合小節。
- `docs/城巴新巴資料可得性查證.md`：補記 2026-10-09 瀏覽器 CORS 驗證結果。

---

## 6. UX 影響評估

| 項目 | 影響 | 說明 |
|------|------|------|
| 離線 payload | 每公司 ~200–350 KB gz；切換器模式下 boot 只載**一家**，故 boot 負擔**不變** | 總安裝體積增大（兩份 gz + SW shell 預快取兩份），但首次載入無感 |
| Boot 時間 | 切換公司時多一次 gz 下載 + 解壓（0.5–2s） | 顯示 loading 提示，與現有離線載入體驗一致 |
| ETA 請求數 | `fetchStopEta` 用 DPO batch = **1 request**（與 KMB `stop-eta` 對等） | 主頁體驗無退化 |
| 路線頁 ETA | 選中站 lazy `fetchSingleStopEta` = 1 request／站 | 與 KMB 同；唔會一次拉全線 |
| 輪詢頻率 | CTB 30s / KMB 15s（決策 5） | CTB 資料每分鐘先更新一次，30s 輪詢慳 2× 請求；倒數顯示以本地時鐘計算，體驗無差 |
| 切換器互動 | 多一次點擊切換公司 | 搜尋頁頂部 segmented control，位置顯眼 |
| 收藏跨公司 | 切換後收藏列表按公司過濾 | 避免九巴站 ID 同城巴站 ID 撞名混淆 |

---

## 7. 風險評估（v2 修訂）

| # | 風險 | 機率 | 影響 | 緩解 |
|---|------|------|------|------|
| RC1 | CTB 無 bulk stop，build 腳本需經 route-stop 枚舉 + 逐站 `/stop`（~2500 request）易 timeout／觸限流 | 中 | 中 | concurrency 限制 + 現有 retry；可分次增量 build（站點資料極少變，可跨 build 複用） |
| RC2 | ~~CORS 未驗證~~ → **已驗證通過（2026-10-09）**；剩餘風險：`fetchStopEta` 依賴 DPO 包裹 API（非原生 CTB） | 低 | 中 | fallback 路徑已寫明（決策 2）：離線 `stopRoutes` 枚舉 + 原生 `/eta` 逐線；adapter 隔離，換來源唔使改 UI |
| RC3 | 收藏／routeVisits 加 `co` 的資料遷移令舊九巴收藏失效 | 低 | 中 | 讀取 `co\|\|'kmb'` 向下兼容；verify.mjs [CTB-5] 回歸 |
| RC4 | CTB ETA 離線回退失效（sw.js 漏 cache `rt.data.gov.hk`） | 中 | 低 | Phase 4 擴展 host 檢查 + 測試覆蓋 |
| RC5 | `dest` / `rmk` 欄位名差異（DPO 無 `_tc`）令顯示空白 | 中 | 中 | `mapCtbEta` 輸出 KMB 欄位名（§3.2），同時兼容 `dest_tc`/`dest`、`rmk_tc`/`rmk`；[CTB-2] 覆蓋兩種 raw 形狀 |
| RC6 | `generated_timestamp ` 尾空格破壞 JSON key 匹配 | 低 | 低 | 解析只讀已知欄位，唔靠 exact key 匹配 |
| RC7 | 切換公司時 DB／abort／timer 狀態未清乾淨 | 中 | 中 | 切換流程鐵律（Phase 2）：雙 `stopPolling` → state 重置 → `booting=null` → reboot；切換器只放搜尋頁，砍掉深層頁切換分支；[CTB-6] 回歸 |
| RC8 | 跨公司 stop ID 混淆（R8，本階段唔做聚合故暫時唔爆） | — | — | 留待後續階段；切換器模式天然隔離（見 §11） |
| RC9 | **build 決定性**：`/stop` 並發完成次序不確定 → buildId 不穩 → 用戶被逼重下載 | 中 | 中 | first-seen 次序重排（Phase 0 步驟 4）；[CTB-1b] 連跑兩次驗證 |
| RC10 | **hidden 屏蔽清單跨公司誤傷**（`routeVisitsHidden` key 無 co，路線號 1/5/10 兩家重疊） | 中 | 低 | 決策 4 擴至 hidden 清單加 co；[CTB-5b] 回歸 |

---

## 8. 檔案範圍清單

| 檔案 | 改動性質 |
|------|----------|
| `scripts/build-data.mjs` | 通用化支援多公司（CTB 抓取 + 枚舉 + first-seen 重排 + 方向 dest 映射 + 雙 manifest） |
| `public/js/data.js` | 加 CTB adapter、`registerAdapter` 必填清單修訂、抽 Nominatim、`mapCtbEta`（KMB 欄位名）、store 四個 key 加 co |
| `public/js/app.js` | 動態 adapter、按公司 boot、`booting` reset、收藏傳 co、文案公司化（L207/L502/L695） |
| `public/index.html` | 公司切換器 UI、subtitle／meta／資料來源歸屬公司化 |
| `public/manifest.json` | PWA description 公司中立化 |
| `public/css/app.css` | 切換器樣式（可選：公司主題色） |
| `public/sw.js` | SHELL 加 ctb gz、ETA host 擴展 |
| `scripts/verify.mjs` | CTB 回歸測試分組（[CTB-1]~[CTB-7]） |
| `docs/BusETA規劃書.md` | §5.7 / §6 更新 |
| `docs/城巴新巴資料可得性查證.md` | 補記 CORS 驗證結果 |
| `data/build-manifest.json`（產物） | 含 companies 結構 + top-level buildId 保留 |
| `public/data/ctb-stops.json.gz`、`ctb-routes.json.gz`（產物） | 新增離線資料 |
| `.build-cache/ctb-stops.json`（本機快取） | v3  新增：加速重跑（RC1 緩解），已 gitignore |

---

## 9. 執行順序（逐步）

0. ~~瀏覽器 CORS 驗證~~ → ✅ **已完成（2026-10-09 確認通過，結果已寫入本計劃書頂部）**。
1. ~~確認 §4 四個決策分支~~ → ✅ 2026-10-09 審核確認（決策 5 輪詢頻率實作時可調）。
2. Phase 0：改 `build-data.mjs` → 跑出 `ctb-*.gz` + 新 manifest，確認體積、方向 dest 映射正確、**連跑兩次 buildId 相同**。
3. Phase 1：`data.js` 加 CTB adapter（含 `mapCtbEta` KMB 欄位名 + DPO `?lang=zh-hant`）+ 必填清單修訂 + store 四 key 加 co。
4. Phase 4（提早）：`sw.js` 加 ctb gz + ETA host，跑 `bump-sw.mjs`（避免後面測試時離線回退失效）。
5. Phase 2 + 3：`app.js` 動態 adapter（`booting` reset）+ `index.html`/`manifest.json`/`css` 切換器與文案公司化。
6. Phase 5：`verify.mjs` 加 CTB 測試並全跑通（現 139 項 + [CTB-1]~[CTB-7]）。
7. Phase 6：更新規劃書 + 查證報告補 CORS 記錄。
8. 本地 `index.html` 手測：切換公司 → 附近站 → ETA → 收藏 → 路線頁（含出站方向終點），確認無 console error、timer 無 leak、文案歸屬正確。

---

## 10. 驗收標準

- [ ] `node scripts/build-data.mjs` 成功產 `ctb-stops.json.gz` + `ctb-routes.json.gz`；**同資料連跑兩次 buildId 不變**（決定性）。
- [ ] CTB routeList 出站方向 dest = `orig_tc`、入站 = `dest_tc`（抽 3 條線對照官方）。
- [ ] CTB adapter 註冊成功（`fetchRouteEta` 已非必填），`getAdapter('ctb')` 可取；`fetchStopEta` 經 DPO batch（帶 `?lang=zh-hant`）返真 ETA 且 dest/rmk 為中文。
- [ ] 切換公司後，`boot()` 重載對應 gz，附近站／ETA 只顯示該公司資料；文案（subtitle／空結果／資料來源歸屬）隨公司切換。
- [ ] CTB ETA 離線（斷網）時，曾載過嘅站可顯示最後成功回應 + 過時提示（sw.js cache 生效）。
- [ ] 舊九巴收藏在加 co 後仍正常顯示（向下兼容）；屏蔽九巴某線唔影響城巴同編號線。
- [ ] `node scripts/verify.mjs` 全綠（含 [CTB-1]~[CTB-7] 分組）。
- [ ] 無新增 console error；切換公司時 `stopPolling()`/`stopRoutePolling()` 清乾淨，無 timer leak。

---

## 11. 未來方向（非本計劃）

- **R8 跨公司物理站對齊**：九巴與城巴站點**都有經緯度**，將來可用幾何聚類（~30–50m 內合併）自動產生對照關係，成本遠低於人工維護對照表。切換器模式下無此需求，留待要做「一站睇齊兩家公司」時再評估。
- **NLB（新大嶼山巴士）**：DPO batch API 同時涵蓋（`company_id=nlb`），將來加第三個 adapter 可直接沿用本次基建。

---

## 12. 實作後修正（v3，2026-10-09）

實作過程中發現計劃書本身有兩處錯誤，經 live API 實測後修正。

### 12.1 ⚠️ 方向 → 端點映射寫反了（會令入站終點全部顯示錯）

**原計劃（v2 §3.1）**：`dir='I' → dest_tc`、`dir='O' → orig_tc`。

**實測結果（route 1，2026-10-09）**：

```
/route/CTB → orig_tc = 中環 (港澳碼頭)、dest_tc = 跑馬地 (上)

/route-stop/CTB/1/outbound  (dir='O')：首站 001027 中環 → 末站 002403 跑馬地
DPO batch ETA 對 dir='O' 回 dest = 跑馬地(上)        ← = dest_tc
/route-stop/CTB/1/inbound   (dir='I')：首站 002403 跑馬地 → 末站 001027 中環
                                                          ← 末站 = orig_tc
```

另抽 7 條路線（1、13、26、796P、962X、A10、E22）以 DPO ETA 反查，**O → dest_tc 全部命中**。

**正確映射**：`O`（開往終點）→ `dest_tc`；`I`（往總站）→ `orig_tc`。
與 `app.js` 顯示慣例一致（`I` = 「往總站方向」、`O` = 「開往終點」）。

**後果**：若照原文實作，**每條路線的入站終點都會顯示成出站終點**（例：route 1 入站會錯顯「跑馬地 (上)」，實際應為「中環 (港澳碼頭)」）。
已修正 `scripts/build-data.mjs`，並由 `[CTB-7]` 三項斷言鎖定（O=dest_tc、I=orig_tc、兩者必須不同）。

### 12.2 站 ID 描述只適用於九巴

§3.1 原寫「站 ID 16 字符字串」並放在對照表共通列。實測：**城巴係 6 位 zero-padded 數字字串**（如 `002737`）。
兩者皆當 string 處理故無實際功能影響，但若誤當數字會失去前導零（`002737` → `2737`）導致查詢失敗。已修正描述。

### 12.3 實作期間新增的兩項（原計劃未列）

1. **`.build-cache/ctb-stops.json` 本機車站快取**（RC1 緩解）
   CTB 冇 bulk stop 端點，每次 build 需 ~2,600 個 `/stop/{id}` 請求（實測 6 分鐘）。車站名稱／座標極少變動，
   故加本機快存，重跑時只補抓缺失者（實測 2,587/2,587 命中，數十秒完成）。
   **對確定性零影響**：輸出次序完全由 first-seen 決定，與「資料來自快取抑或網絡」無關。[CTB-1b] 仍成立。
   需強制重抓時用 `node scripts/build-data.mjs --refresh-stops`。

2. **停車場／分站編碼同樣存在於城巴**
   城巴站名亦有 `(WT916)` 這類尾綴，故 `groupKey()` 剝除邏輯兩家通用（非九巴專屬）。

### 12.4 實際產出（2026-10-09）

| 公司 | 車站 | 路線方向 | 路線站序 | gz 體積 |
|------|------|----------|----------|---------|
| 九巴及龍運 | 6,752 | 1,605 | 36,335 | 340 KB（181.7 + 164.8）|
| 城巴及新巴 | 2,587 | 814（407 線 × 2 方向）| 17,404 | 127 KB（51 + 76）|

- `buildId`（全公司）= `c6a632b8`；九巴 `f1fa6f6b`、城巴 `8db4ad56`
- **決定性已驗證**：連跑兩次，四個 gz 檔位元組**完全相同**、buildId 相同。
- 城巴資料約為九巴的 37% 體積；因切換器模式下 boot 只載一家，**首次載入時間不變**。

### 12.5 測試結果

`node scripts/verify.mjs` → **183 項全綠**（原 139 + 新增 44 項 CTB 測試），零 console error。
涵蓋：[CTB-1] 離線資料結構、[CTB-1b] 決定性、[CTB-2] `mapCtbEta` 兩種 raw 形狀、
[CTB-3] DPO batch URL 帶 `?lang=zh-hant`、[CTB-3b] sw.js host 白名單、
[CTB-4] 無 svc、[CTB-5]/[CTB-5b] 公司隔離與向下兼容、[CTB-6]/[CTB-6b] 切換與 race、[CTB-7] 方向映射。
