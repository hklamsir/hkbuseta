# BusETA 規劃書

> 純前端九巴／龍運巴士到站時間 webapp
> 數據來源：運輸署「九龍巴士及龍運巴士路線實時到站數據」（`hk-td-tis_21-etakmb`）
> 文件版本：v1.0　撰寫日期：2026-10-05
> 所有 API 數據與體積均為 2026-10-05 實測所得，非官方文檔抄錄

---

## 1. 產品定義

### 1.1 一句話定位

**輸入一個香港地標（商場、大廈、碼頭、機場），揀一個搜尋半徑，列出範圍內所有九巴／龍運巴士站，再逐站睇實時到站時間。**

### 1.2 解決咩問題

現有香港巴士到站 app（Citymapper、HKeasyBus）幾乎全部以「打開 app → 允許定位 → 睇附近」為前提。但有幾個情境定位完全唔 work：

- **長者／唔識用手機定位嘅用戶**：唔會授權 GPS，要靠「我住嘅屋邨叫咩名」搵站。
- **規劃行程中**：已知要去「海港城」，想知「同埋附近有咩巴士站、每條線幾耐到」，唔想逐個站撳。
- **網絡唔穩／大廂冇數據**：完全離線時仍需要睇到「附近有咩站、經過咩路線」，只有 ETA 本身需要網絡。

### 1.3 明確不做的事

| 不做 | 原因 |
|---|---|
| 城巴／新巴／龍運以外的營辦商 ETA | 資料源不同、要處理多套 stop ID 對齊。**已實作 KMB + CTB 兩個 adapter**（見 §5.7.1）；`registerAdapter` 新增 adapter 即可，UI 與搜尋邏輯唔使改 |
| 實時 GPS 追蹤巴士位置 | 九巴 API 無此能力 |
| 路線規劃（邊條路最快、轉車） | 需要圖路由／圖搜尋引擎，遠超本 app 範圍 |
| 到站提醒／推播通知 | 需要 Service Worker 背景推送 + 後端，違反純前端定位 |
| 多語言（簡中／英文） | 官方三語欄位已備用（`name_sc` / `name_en`），日後加 UI 翻譯即可，零 API 成本 |
| 地圖路線規劃／導航 | Leaflet 只作位置視覺輔助 |

### 1.4 目標使用者

- **主要**：習慣用瀏覽器、唔想安裝 app、想快速查「某地標附近巴士站」嘅一般用戶
- **次要**：網絡受限地區（長者中心、鄉村地區）嘅用戶，需要離線查路線站序

---

## 2. 數據源盤點（實測）

### 2.1 九個 API 端點

Base URL：`https://data.etabus.gov.hk/v1/transport/kmb/`

| # | 名稱 | 端點 | 更新 | 實測體積 | 用途 |
|---|---|---|---|---|---|
| 1 | Route List | `/route/` | 每日 05:00 | 351 KB | 1,605 條路線×方向×車種 |
| 2 | Route | `/route/{route}/{direction}/{service_type}` | 每日 05:00 | ~300 B | 單條路線詳情 |
| 3 | Stop List | `/stop` | 每日 05:00 | 1.19 MB | 6,753 個車站（含座標）|
| 4 | Stop | `/stop/{stop_id}` | 每日 05:00 | ~200 B | 單一車站詳情 |
| 5 | Route-Stop List | `/route-stop` | 每日 05:00 | 3.05 MB | 36,337 筆路線-站序列 |
| 6 | Route-Stop | `/route-stop/{route}/{direction}/{service_type}` | 每日 05:00 | ~4 KB | 單條路線的站序 |
| 7 | ETA | `/eta/{stop_id}/{route}/{service_type}` | 1 分鐘內 | ~2 KB | 單站單線 ETA |
| 8 | Stop ETA | `/stop-eta/{stop_id}` | 1 分鐘內 | 5 KB | **單站所有路線 ETA** ← 核心 |
| 9 | Route ETA | `/route-eta/{route}/{service_type}` | 1 分鐘內 | 22 KB | 全線所有站 ETA |

**本 app 實際只用 3 個**：`/stop-eta/{stop_id}`（核心）、`/route-stop/{route}/{direction}/{service_type}`（查路線站序）、`/route/`（路線搜尋）。其餘 6 個在規劃書中列為「可選優化」。

### 2.2 關鍵約束

```
CORS:Access-Control-Allow-Origin: *        ✅ 純前端可直接呼叫
Cache-Control: max-age=300                 5 分鐘 CDN 快取
無速率限制聲明                             但 CDN 5 分鐘快取已天然限流
URL 與參數大小寫敏感（Case sensitive）      路線號 74B ≠ 74b
無 API Key 需求                             零配置成本
```

### 2.3 官方規格兩個必須知道嘅陷阱

**陷阱一：無效路線回 `200` + 空 `data`，唔係 `404`**

實測：`/route/9999Z/outbound/1` → HTTP 200，`data: []`

→ **唔可以用 HTTP status code 判斷查詢有效性**，必須檢查 `data` 長度。錯誤處理邏輯要為此設計。

**陷阱二：ETA 會混入其他 service_type**

實測：查路線 `40` 服務類型 `1`，回應中同時出現 `service_type: 1` 同 `service_type: 2` 嘅 ETA 記錄，內容重複。

→ 前端**必須按 `(route, dir, seq, eta_seq, eta)` 去重**，否則同一班車會顯示兩次。

### 2.4 官方資料缺陷：`seq` 與 `service_type`

實測確認（已修正初步誤判）：

- **`seq` 連續無跳號**：1,605 個路線組合中 0 個有跳號，`seq` 範圍連續。
- **`service_type` 有 8 種值**（官方文件只提 1/2/3）：

| 值 | 筆數 | 推測含義 |
|---|---|---|
| 1 | 1,320 | 一般服務 |
| 2 | 184 | 平日繁忙時段 |
| 3 | 73 | 假日／週末 |
| 4 | 16 | 特班 |
| 5 | 6 | 夜間 |
| 6 | 3 | 特別時段 |
| 7 | 1 | 罕見 |
| 9 | 2 | 罕見 |

→ **MVP 階段要處理全部 8 種值**，唔可以假設只有 1-3。UI 顯示策略見 §4.5。

### 2.5 ETA 的 `null` 語義（實測 17 筆中有 5 筆為 null）

實測 `rmk_tc` 分佈：

| `rmk_tc` | 筆數 | `eta` 狀態 | 正確 UI 顯示 |
|---|---|---|---|
| `""`（空）| 4 | **null** | 「暫時冇預報」灰色 |
| `"原定班次"` | 12 | 有值 | 正常倒數 |
| `"服務只限於星期日及公眾假期"` | 1 | **null** | 「今日非服務日」灰色 |
| 其他（如「此路綫暫停服務」）| — | 視情況 | 直接顯示 `rmk_tc` 原文 |

→ **`eta: null` 絕對唔等於「無車」**。必須按 `rmk_tc` 分流。實測 null 比例達 29%，處理唔當會嚴重誤導用戶。

---

## 3. 外部依賴：地理編碼

### 3.1 為何必須外求

九巴 9 個端點**全部只認 16 字符 stop ID 或路線號**，無法將「黃大仙中心」轉成座標。要做到「輸入地標 → 附近站」，必須外接地理編碼服務。

### 3.2 選型：Nominatim（OpenStreetMap）

| 項目 | 實測結果 |
|---|---|
| 端點 | `https://nominatim.openstreetmap.org/search` |
| CORS | `Access-Control-Allow-Origin: *` ✅ |
| 費用 | 免費、免 API Key |
| 速率限制 | 每日 1,000 次／IP（官方建議絕對上限） |
| 響應時間 | 約 1-2 秒 |

### 3.3 實測：六個香港地標全部命中正確座標

| 查詢字串 | 結果 | 座標 | 命中類型 |
|---|---|---|---|
| `太古城中心 香港` | ✅ 3 筆 | 22.2863042, 114.2173461 | shop mall |
| `海港城 香港` | ✅ 2 筆 | 22.2970015, 114.1684199 | shop mall |
| `黃大仙中心` | ✅ 2 筆 | 22.3413757, 114.1943294 | shop mall |
| `美孚新邨 香港` | ✅ 1 筆 | 22.3357979, 114.1399613 | landuse residential |
| `香港中文大學` | ✅ 1 筆 | 22.4201838, 114.2079145 | amenity university |
| `銅鑼灣 崇光百貨` | ✅ 2 筆 | 22.2802142, 114.1837790 | highway bus_stop |

### 3.4 三個實測踩到的坑（必須寫入實作規格）

**坑一：唔加香港限定會搜到外國同名地點**

實測 `寶貝店`（無香港關鍵字）→ 命中 `30.6687499, 104.0843219`（**四川成都**），完全唔相關。

→ 規格：查詢字串**自動附加「 香港」**；`accept-language=zh-HK`。

**坑二：`countrycodes=hk` 反而令結果變 0 個**

實測 `啟德機場` + `countrycodes=hk` → **0 筆結果**（不用則正常有結果）。

→ 規格：**不用 `countrycodes` 參數**，改用「附加香港關鍵字 + 前端過濾座標落喺香港範圍」雙重保證。

香港範圍判定（硬編碼常數）：

```
香港大致範圍：lat 22.15 – 22.58，long 113.83 – 114.44
落喺範圍外嘅候選點直接剔除
```

**坑三：命中點未必係「門口」，可能係隔籬建築物**

實測：`黃大仙中心` 命中 POI 座標 22.3413757；而最近的巴士站「黃大仙轉車站-黃大仙廟」在 12m（正常），但第二近的「沙田坳道」站有 230m 距離——如果用戶用「銅鑼灣 崇光百貨」呢類字串，首個命中甚至直接係 `highway bus_stop` 而唔係 `shop mall`。

→ 規格：**必須顯示多個候選點俾用戶揀**，每個候選點標明類型同距離；唔可以自動揀第一個。

**排序規則（2026-07 實測修正）**：原定「POI 優先於 bus_stop」不足夠，因為多個候選點的 `display_name` 可能**完全相同**，用戶無從分辨。實測兩案例：

| 查詢 | 命中點 | 若只用「POI 優先」或只用「bus_stop 優先」的后果 |
|---|---|---|
| 淘大花園 | `bus_stop`（30m）與 `residential`（76m）**同名** | 只用 POI 優先 → 揀 76m 屋苑中心 → 200m 剛好切邊，漏咗德福花園（3 組 → 5 組）|
| 黃大仙中心 | 商場「黃大仙中心」與鄰近 bus_stop「沙田坳道」（同 12m）| 只用 bus_stop 優先 → 商場被鄰站蓋掉（14 個站 → 13 個）|

→ **修訂規格**：排序依序為
1. 名稱與查詢字串**完全相同**（用戶要的正是這個地點）
2. 名稱包含查詢字串
3. `bus_stop` / `bus_station`（座標準確）
4. 其他 POI（`amenity` / `shop` / `landuse` / `building` 等）
5. 兜底

並加視覺標籤：`bus_stop` 標「準確位置」、同名但非 bus_stop 標「區塊中心」、距最近九巴站 > 250m 標「位置可能有偏差」。

### 3.5 速率限制的緩解：兩層快取

| 層 | 內容 | 儲存 | 有效期 |
|---|---|---|---|
| L1 記憶體快取 | 本次 session 內相同查詢結果 | JS 變數 | session 內永久 |
| L2 持久快取 | 已查過的地標 → 座標 | localStorage | 30 日 |
| L3 Nominatim | 未命中快取才呼叫 | — | — |

**估計使用量**：假設 100 用戶、每人每日 20 次搜尋、其中 60% 命中快取 → 實際 API 呼叫約 800 次／日。**逼近 1,000 次上限，屬高風險**。

→ 規格：**介面要明示「多搜幾次可能會暫時唔到」**，並建議部署方在規劃書階段保留「切換到 Google Places 新服務」嘅適配位（同一個 `searchPlace()` 接口，實作一換即走）。

### 3.6 隱私考量

**GPS 座標唔會傳去任何第三方**（Nominatim 只收地標文字，唔收 GPS 座標）。規劃書要明確寫呢點，因為用戶輸入嘅往往係自己住處。

---

## 4. 功能規格

### 4.1 頁面結構：三頁單頁應用

```
┌─────────────────────────────────────────┐
│  ① 搜尋頁（預設）                       │
│    ┌──────────────────────────────┐      │
│    │ 🔍 輸入地標名…                │      │
│    └──────────────────────────────┘      │
│    最近搜尋（最多 10 個）                │
│  ────────────────────────────────        │
│  ② 附近站列表頁（地標已選）              │
│    已選：太古城中心 22.286, 114.217      │
│    範圍： [100m] [200m] [500m]  ← 預設 200m│
│    找到 8 個站 ─────────────────────────  │
│    │ 太古城中心  61m  8 條路線  [★]  │    │
│    │ 太古城中心 102m  4 條路線  [★]  │    │
│    │ 康山  ...                    │    │
│  ────────────────────────────────        │
│  ③ 站點 ETA 頁                           │
│    ← 返回                                    │
│    太古城中心 (ED355)                      │
│    37m · 22.2846, 114.2185                │
│    ────────────────────────────           │
│    往 觀塘(翠屏北邨)  234C               │
│      3 分鐘  (14:52)                      │
│      12 分鐘 (15:01)                      │
│      22 分鐘 (15:11)                      │
│    ────────────────────────────           │
│    往 柴灣                116            │
│      即將到  (14:49)                      │
│    ...                                     │
└─────────────────────────────────────────┘
```

### 4.2 搜尋頁

| 元素 | 行為 |
|---|---|
| 搜尋框 | 輸入即停後 400ms 才發請求（debounce）；最少 2 字元才搜尋 |
| 候選點列表 | 顯示 5 個候選點，每個顯示：`名稱` / `類型標籤` / 對九巴最近的站距離 |
| 候選點排序 | 依 §3.4 坑三**修訂規格**：完全同名 > 名稱包含 > `bus_stop` > 其他 POI > 兜底（2026-07 實測修正，原「POI 優先於 bus_stop」會令同名的屋苑中心蓋過準確巴士站，或反之令商場被鄰站蓋掉）|
| 香港範圍過濾 | 剔除落喺 lat 22.15–22.58 / long 113.83–114.44 外的結果 |
| 最近搜尋 | 顯示最近 10 個已用地標（L2 快取），點擊即跳 |
| 載入狀態 | 顯示載入中動畫，避免以為冇反應（實測 1-2 秒）|
| 失敗處理 | 顯示「搜尋服務暫時繁忙，請稍後再試」+ 重試按鈕 |

### 4.3 附近站列表頁

| 元素 | 行為 |
|---|---|
| 範圍切換 | 100m / 200m / 500m，預設 **200m**；切換即時重算（純前端計算，零網絡請求）|
| 距離計算 | Haversine 公式，R = 6,371,000 m |
| 排序 | 距離由近至遠 |
| 同名站合併 | 同一 `name_tc` 的多個 stop ID 合併為一組，顯示方向／分站標記 |
| 路線數 | 由預打包 `route-stop` 即時計算，**零網絡請求** |
| ★ 收藏 | 存 localStorage |
| 展開 | 撳站卡片 → 才發 `stop-eta` 請求（見 §4.4）|
| 空結果 | 500m 內冇站 → 顯示「此範圍內未有九巴／龍運巴士站，請擴大範圍」+ 提示可能有城巴／新巴 |

**為何必須合併同名站**：實測「太古城中心」本身有 **6 個獨立 stop ID**（對應不同行車方向／分站）。不合併會令列表極度冗長。

### 4.4 站點 ETA 頁（核心頁）

| 元素 | 行為 |
|---|---|
| 標題 | 站名 + 分站標記 + 直線距離 + 座標 |
| 路線分組 | 按 `dir`（I / O）分兩組：「往 X」／「由 X」 |
| 每路線顯示 | 路線號（大字）、終點 `dest_tc`、最多 3 個 ETA |
| ETA 格式 | 倒數為主 + 絕對時間為輔：`3 分鐘` + `（14:52）` |
| 自動刷新 | 15 秒（見 §5.2）|
| 手動刷新 | 右上角刷新按鈕 |
| 去重 | 按 `(route, dir, seq, eta_seq, eta)` 去重（見 §2.3）|
| 空 ETA | 顯示「暫時冇預報」灰色，唔顯示「無車」|
| 頁面離開 | `visibilitychange` → 背景時暫停輪詢 |

### 4.5 service_type 顯示策略

因官方有 8 種 `service_type`（見 §2.4），UI 策略：

- **預設全部顯示**，用細標籤區分（如「平日繁忙」「假日」）
- **同路線不同 service_type 合併去重後**，只保留一個 ETA 序列
- **MVP 不提供 service_type 篩選器**（避免 UI 複雜度），但資料層要保留 `service_type` 欄位

### 4.6 個人化與私隱

| 功能 | 儲存位置 | 內容 |
|---|---|---|
| 搜尋歷史 | localStorage（key: `buseta.recent`）| 最近 10 個地標名 + 座標 + 時間戳 |
| 常到車站 | localStorage（key: `buseta.favorites`）| 站名 + stop ID + 座標 |
| 常搭路線（釘選）| localStorage（key: `buseta.favRoutes`）| 路線號 + bound + svc + 終點名 + 時間戳，上限 10 條 |
| 常搭路線（自動統計）| localStorage（key: `buseta.routeVisits`）| `"路線號\|bound"` → 訪問次數，上限 20 個 key；**首次查看不計**（視為試用），第二次起累加 |
| 常搭路線屏蔽清單 | localStorage（key: `buseta.routeVisitsHidden`）| 用戶手動移除自動統計項後記錄，**防止「刪咗又彈返出嚟」**。手動加星會自動解除屏蔽 |
| 逐項刪除 | — | 最近搜尋／常搭路線（釘選與自動統計兩種）／常到車站 均有移除鈕，`stopPropagation` 避免誤觸發進入。工具提示區分「取消常搭」與「不再記錄」 |
| 返回目標 | — | 由搜尋頁清單進入時返回首頁；由路線頁跳轉進入該站 ETA 時返回路線頁（記於 `state.etaFrom` / `state.routeFrom`）|
| 一鍵清除 | — | 同時清空五個 key + 顯示確認對話框 |
| 地標搜尋緩存 | localStorage（key: `buseta.geoCache`）| 最近 60 個查詢字串 + 命中地標，TTL 30 分鐘。**必須自建**：Nominatim 政策明定「同一查詢重覆發送會被視為 faulty 並封鎖」|

**規劃書必須聲明**：無伺服器、無帳號、無 analytics、無追蹤腳本。所有個人資料只存在用戶裝置的 localStorage，清除即永久刪除。

### 4.7 搜尋服務的速率限制（實測教訓）

Nominatim 使用政策（<https://operations.osmfoundation.org/policies/nominatim/>）的硬性約束：

| 政策條文 | 本 app 的對應實作 |
|---|---|
| 「absolute **maximum of 1 request per second**」| `searchPlaceRatelimited()` 序列化佇列，確保相鄰請求間隔 ≥ 1100 ms；debounce 由 400 ms 調至 600 ms |
| 「Clients sending repeatedly the same query may be classified as faulty and blocked」| 自建緩存（記憶體 LRU 60 條 ＋ localStorage，TTL 30 分鐘），命中零請求 |
| 「Provide a valid HTTP Referer or User-Agent identifying the application」| 瀏覽器自動帶 Referer。實測 **UA 過短（如 `Mozilla/5.0`）會直接 403** |
| 禁止 client-side auto-complete | 仍為 input 驅動（UX 取捨），靠節流 + 緩存把請求量壓到官方容忍範圍；若日後請求量上升須改為 Enter 觸發 |

**錯誤處理**：403 / 429 / 400 / 網絡中斷 / 5xx 必須分開提示。403 屬服務端政策封鎖，`location.reload()` 無效，只會再被拒一次 —— 故按鈕改為「重新搜尋」。429 讀取 `Retry-After` 告知用戶應等幾秒。


---

## 5. 技術方案

### 5.1 整體架構

```
┌───────────────────────────────────────────────┐
│  靜態資源（部署時生成，服務端零邏輯）           │
│  ├── index.html          主應用（單檔）        │
││  ├── manifest.json      PWA manifest         │
│  ├── sw.js               Service Worker        │
│  └── data/               預打包離線資料         │
│      ├── stops.json.gz   車站表約 400 KB        │
│      └── routes.json.gz  路線站序約 900 KB      │
└───────────────────────────────────────────────┘
         │
         ├── 離線可用：PWA + Service Worker 快取
         └── 需連網絡：3 個 ETA 端點 + Nominatim
```

### 5.2 預打包資料（關鍵決策）

**為何預打包**：官方靜態資料**每日只更新一次**（05:00），即係「每日變一次」。預打包成靜態檔有以下好處：

| | 首次載入 | 之後 | 完全離線 |
|---|---|---|---|
| **預打包**（採用）| 0 MB，即時可用 | 部署時更新 | ✅ 站表 + 路線站序全離線 |
| 執行時 fetch | 4.24 MB / 1.3 MB(gzip) | 每日重新下載 | ❌ |

**關鍵優勢**：用戶首次開啟完全零等待，而且**離線時仍可查「附近有咩站」「路線經過咩站」**——只有 ETA 本身需要網絡。呢個係本 app 對網絡受限用戶嘅核心價值。

**維護責任（必須寫入規劃書）**：

1. 每日或每週執行打包腳本，抓取最新 `/stop` + `/route-stop` + `/route`
2. 轉為精簡 JSON（去除冗餘欄位）→ gzip
3. 提交到 repo → 觸發重新部署
4. **Service Worker 版本號同步遞增**（見 §5.5）

**精簡策略**（降低 4.24 MB 的關鍵）：

原始 `route-stop` 每筆約 90 bytes，欄位為 `co`（永遠 `"KMB"`，刪）、`route`、`bound`、`service_type`、`seq`、`stop`、`data_timestamp`（每日重覆，刪）。

```json
// 精簡前：90 bytes/筆
{"co":"KMB","route":"1A","bound":"O","service_type":"1","seq":1,
 "stop":"A3ADFCDF8487ADB9","data_timestamp":"2020-11-29T11:40:00+08:00"}

// 精簡後：34 bytes/筆
["1A","O",1,1,"A3ADFCDF8487ADB9"]
// 陣列格式：["route","bound","seq","service_type","stop"]
```

36,337 筆 × 34 bytes ≈ **1.24 MB** → gzip 後約 **350 KB**。加上精簡車站表（刪 `data_timestamp`，座標改存整數微度），預估總和 **約 1.1 MB → gzip 後約 400 KB**。

### 5.3 資料查詢策略（記憶體索引）

載入 gzip 資料後在記憶體建三個索引：

```javascript
// stops：stop ID → {name, lat, lng}        O(1)
// routeStops："route|bound|svc" → [stopID...]  O(1) 取得路線站序
// stopRoutes：stopID → [{route, dir, svc, seq}]  O(1) 取得某站所有路線
```

**記憶體估算**：6,753 站 + 36,337 關聯 ≈ 43,000 個 JS 物件，約 8-15 MB heap。手機可接受。

**距離搜尋優化**：唔需要遍歷 6,753 個站計算 Haversine。用 **lat/lng 範圍預篩**（半徑 r 對應的矩形邊界）先做陣列過濾，再精算距離。500m 範圍大約只會命中 50-200 個站，實際計算量極小。

### 5.4 ETA 輪詢

```javascript
// 輪詢條件（全部滿足才發請求）
1. 頁面可見（document.visibilityState === 'visible'）
2. 未手動暫停
3. 距上次請求 ≥ 15,000 ms
4. 未已有請求進行中（避免堆疊）

// 請求策略
- stop-eta 每次約 5 KB
- 撞 CDN max-age=300 時不會增加對方負載
- AbortController：切換站點時中止上一個未完成請求
- 失敗重試：最多 2 次，指數退避（1s / 3s）
```

**倒數實作**：每個 ETA 記錄從 ISO 8601 timestamp 算出剩餘秒數，用單一 `setInterval`（1 秒）統一更新畫面，唔係每個 ETA 一個 timer。

**邊界處理**：

| 情況 | 顯示 |
|---|---|
| 剩餘 < 60 秒 | 「即將到」+ 絕對時間 |
| 已過 ETA 時間 ≤ 60 秒 | 「即將到」（唔顯示負數）|
| 已過 ETA 時間 > 60 秒 | 標記為「已過時」淡化顯示 |
| `eta: null` + `rmk_tc` 為空 | 「暫時冇預報」 |
| `eta: null` + `rmk_tc` 非空 | 顯示 `rmk_tc` 原文 |
| `eta: null` + rmk 含「只限於」/「公眾假期」| 「今日非服務日」|

### 5.5 PWA 與 Service Worker

**必須實作**（否則關咗網重新開會重新下載 1.1 MB，且無法加入主畫面）：

```
sw.js 快取兩層：
1. App Shell（Cache Storage，cache-name: buseta-shell-v{N}）
   index.html, manifest.json, data/*.gz
2. 執行時（Network First）
   /v1/transport/kmb/*  → 網絡優先，失敗時回退到最後一次成功回應
   Nominatim           → 網絡優先，不快取（避免快取到過期地標）
```

**版本管理（必須寫入規格）**：

- 打包檔更新時 **必須** 同步遞增 `buseta-shell-v{N}` 的 `N`
- 舊快取用 `caches.delete()` 清理
- **已知踩坑**：本機 PDF 工具曾因 `CACHE_VERSION` 策略不當導致 JS 快取陳舊 → 本 app 要用「部署時生成版本號」而非手寫常數

### 5.6 地圖：Leaflet + OSM 圖磚

**Zoom 鎖定 15-16**：500m 半徑在 zoom 16 下一張圖磚約覆蓋 600m，一到兩張已足夠。鎖定層級可大幅減少圖磚請求，同時避免用戶迷航。

**離線 fallback 機制**：

```
偵測到圖磚載入失敗（連續 2 張 tile error）
  → 移除 tileLayer
  → 保留 vector 圖層（範圍圓圈、站點 marker、連線）
  → 地圖角落顯示「離線模式：無底圖」
```

**Vector 圖層（永遠可用，零網絡依賴）**：
- 半徑範圍圓圈（`L.circle`，用戶選的 100/200/500m）
- 各車站 marker（顏色按距離分層：<150m 綠 / <300m 橙 / ≥300m 灰）
- 用戶所選地標 marker（與範圍圓圈同心）

**同名的 6 個 stop ID**：marker 聚合顯示（`divIcon` 標「×6」），避免重疊。

### 5.7 資料層：為多營辦商預留

**要求**：Vanilla JS 單檔，但預留城巴／新巴。

**做法**：單檔內用 IIFE 模組模式，定義 adapter 介面：

```javascript
const TransportAdapters = {
  kmb: {
    id: 'kmb',
    label: '九巴及龍運',
    // 離線資料（本地 gz）
    async loadStaticData() { /* 載入 data/*.gz */ },
    // 遠端 ETA
    async fetchStopEta(stopId) {
      return fetch(`https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/${stopId}`);
    },
    async fetchRouteEta(route, svc) { /* ... */ },
    // 地理編碼（九巴自身不支援，用通用服務）
    async searchPlace(query) { /* Nominatim */ }
  }
  // 將來：citybus: { ...同介面 }, nb: { ...同介面 }
};

const activeAdapter = TransportAdapters.kmb;
```

**關鍵**：`stops` / `routeStops` 索引結構對所有營辦商一致，所以核心 UI 與搜尋邏輯**完全唔使改**。

---

### 5.7.1 CTB adapter — 已實作（M8，2026-10-09）

城巴及新巴 adapter 已完成並通過 183 項自動驗證（`node scripts/verify.mjs`）。
**2023 年專營權合併後，前新巴士路線已併入 `company_id = "CTB"**，故一個 CTB adapter 同時覆蓋城巴 + 新巴。

**與原設計的兩處修正**（實測後改）：

1. **`fetchRouteEta` 由必填降級為 optional**。原介面要求每個 adapter 必實作，但：CTB 根本冇全線端點；且實測 `app.js` 由頭到尾冇呼叫過此方法（死介面）。若維持必填，CTB 註冊時即 throw，逼到寫無意義 stub。必填清單現為：`id` / `label` / `loadStatic` / `fetchStopEta` / `searchPlace`。
2. **stop ID 格式描述要改**。原寫「所有營辦商都用 16 字符 stop ID」——實測 CTB 係 **6 位 zero-padded 數字字串**（如 `002737`）。兩者皆當 string 處理故無實際影響，但文件必須準確。

**已實作的關機制**：

| 項目 | 做法 |
|------|------|
| 公司切換 | 搜尋頁頂部 segmented control；切換時重載該公司離線 gz（切換器**只放搜尋頁**，深層頁切換要清多一倍狀態） |
| 索引建構 | 抽出共用 `buildStore()`，兩家 gz schema 同構，**一份程式碼**服務兩個 adapter |
| ETA 欄位 | `mapCtbEta()` 統一映射為 **KMB 欄位名**（`dest_tc` / `rmk_tc` / `service_type:null`），令 `normalizeEta` / `formatEta` 完全唔使改 |
| ETA 來源 | 主用 DPO `batch/stop-eta/CTB/{id}?lang=zh-hant`（1 request／站）；掛時 fallback 用離線索引枚舉路線逐線 call 原生 `/eta` |
| 輪詢頻率 | per-adapter：九巴 15s（實時）／城巴 30s（官方每分鐘更新，用 15s 會浪費 4× 請求） |
| 收藏隔離 | `favorites` / `favRoutes` / `routeVisits` / `routeVisitsHidden` **四個 key 全部加 `co`**；舊無 `co` 資料讀取時 default `'kmb'` |
| build 決定性 | CTB `/stop` 需並發抓 ~2,600 站，完成次序不確定 → **必須按 first-seen 次序重排**後才輸出，否則 buildId 每日必變 |

**⚠️ 實測發現：計劃書原先的「方向 → 端點」映射寫反了**

原計劃寫 `dir='I' → dest_tc`、`dir='O' → orig_tc`。實測（2026-10-09，7 條路線抽樣全中）證實**恰好相反**：

```
route 1：orig_tc = 中環 (港澳碼頭)、dest_tc = 跑馬地 (上)
  DPO batch ETA 對 dir='O' 回 dest = 跑馬地(上)   ← 等於 dest_tc
  /route-stop/CTB/1/inbound（dir='I'）末站 = 中環 (港澳碼頭) = orig_tc
```

即 **`O`（開往終點）→ `dest_tc`；`I`（往總站）→ `orig_tc`**，與 UI 顯示慣例（I = 往總站方向、O = 開往終點）一致。若照原計劃書實作，所有路線的**入站終點都會顯示錯**。[CTB-7] 測試已鎖定此行為。

**離線資料規模（2026-10-09）**：九巴 6,752 站／1,605 路線方向（340 KB gz）；城巴 2,587 站／814 路線方向（127 KB gz）。

### 5.8 瀏覽器支援

| 瀏覽器 | 最低版本 | 依賴特性 |
|---|---|---|
| Chrome / Edge | 最近 2 大版本 | `fetch`、Service Worker、CompressionStream |
| Safari (macOS/iOS) | 15+ | 同上；iOS 需 `apple-touch-icon` |
| Android Chrome | 10+ | — |
| Firefox | 最近 2 大版本 | `DecompressionStream` 於 Firefox 113+ |

**依賴 API 說明**：使用 `DecompressionStream('gzip')` 在瀏覽器原生解 gzip。若要支援更舊瀏覽器，改用 `pako`（+45 KB）。**建議：先檢測 `DecompressionStream` 存在，否則 fallback 到 pako**。

### 5.9 前端依賴

| 依賴 | 來源 | 大小 | 必要性 |
|---|---|---|---|
| Leaflet 1.9.4 | `unpkg.com`（實測 200, 147 KB）| 147 KB | 必要（用戶已選）|
| Leaflet CSS | unpkg | 14 KB | 必要 |
| Marker icon | Leaflet 自帶 | 展現 | 可用 CSS divIcon 取代 |
| pako | 僅在無 `DecompressionStream` 時 | 45 KB | fallback |

**CSP 注意**：Leaflet 由 CDN 載入，若要嚴格 CSP 需在 CSP header 允許 `unpkg.com`。建議 **vendor 埋 Leaflet 到本地**（`vendor/leaflet.js`），消除第三方依賴同時符合 PWA 離線要求。

---

## 6. 風險評估

### 6.1 技術風險

| # | 風險 | 機率 | 影響 | 緩解措施 |
|---|---|---|---|---|
| R1 | **Nominatim 每日 1,000 次上限** | 高 | 高 | 兩層快取（§3.5）；介面明示限制；adapter 預留 Google Places 切換 |
| R2 | **官方 API 停止服務或改版** | 低 | 高 | 資料層 adapter 隔離；預打包資料本身就是一份快照，可作降級 |
| R3 | **預打包資料過期** | 中 | 中 | 打包腳本設為每日自動執行；顯示「資料更新時間」；過期 >3 日在 UI 提示 |
| R4 | **`Nominatim` 服務質素下降／商用條款改變** | 中 | 中 | 同 R1；自建 POI 資料庫作長期備案（見 6.3）|
| R5 | **Service Worker 快取陳舊** | 中 | 中 | 部署時生成版本號；`skipWaiting` + `clients.claim`；更新提示 banner |
| R6 | **舊瀏覽器無 `DecompressionStream`** | 低 | 低 | pako fallback |
| R7 | **ETA `null` 處理錯誤誤導用戶** | 中 | 高 | 按 `rmk_tc` 分流（§2.5）；單元測試覆蓋所有 `rmk` 分支 |
| R8 | **多營辦商 stop ID 對齊錯誤** | 中 | 中 | ✅ **M8 已用公司切換器模式處理**（一次只載入一家，天然無撞名風險）；跨公司物理站對齊留待後續 |

### 6.2 體驗風險

| # | 風險 | 緩解 |
|---|---|---|
| R9 | 500m 內 47-53 個站，若預載 ETA 會等 5-15 秒 | **已解決**：懶載入（§4.3），列表零網絡請求 |
| R10 | 候選點命中隔籬建築物，附近站結果唔對 | 顯示多候選點俾用戶揀 + 顯示對九巴最近站距離（§3.4）；排序已按實測修正為「完全同名 > bus_stop > POI」|
| R11 | 離線時用戶見到灰格地圖，以為壞咗 | 離線 fallback 保留 vector 圖層 + 明確提示「離線模式：無底圖」 |
| R12 | 巴士 API 延遲，ETA 唔準 | 顯示 `data_timestamp`（官方提供），讓用戶知道資料新鮮度 |

### 6.3 長期方案：自建香港地標資料庫

若 R1（速率限制）或 R4（服務質素）成為瓶頸，長期方案：

1. 一次性用 Overpass API 拉全港 POI（商場、屋苑、機場、碼頭、醫院、政府大樓）
2. 打包成 `landmarks.json.gz` 隨 app 發佈
3. 查詢改為「先查本地地標庫 → miss 才叫 Nominatim」

**估算**：全港主要地標約 5,000-20,000 個，gzip 後約 200-500 KB。可覆蓋 80% 用戶需求，大幅減少外部呼叫。

⚠️ **Overpass API 實測注意**：直接查詢時回 `406 Not Acceptable`（需正確 `data=` 參數編碼），且高负载時響應慢（20-30 秒）。一次性全量抓取需用分區查詢 + 重試。

---

## 7. 開發里程碑

| 階段 | 內容 | 產出 | 驗收標準 |
|---|---|---|---|
| **M0 資料準備** | 打包腳本：抓 API → 精簡 → gzip | `data/stops.json.gz`、`data/routes.json.gz`、打包腳本 | 體積 < 600 KB；站數 6,753；關聯 36,337 |
| **M1 核心資料層** | 索引建構、距離計算、adapter 介面 | `index.html` 資料模組 | Haversing 與實測值一致（黃大仙中心 100m → 5 站）|
| **M2 搜尋頁** | Nominatim 整合、候選點、快取 | 可用搜尋 | 6 個測試地標全部命中正確座標 |
| **M3 附近站列表** | 範圍切換、合併同名站、Leaflet 圖層 | 可用列表 | 500m 範圍 < 100ms 計算完成 |
| **M4 ETA 頁** | 輪詢、倒數、去重、null 分流 | 核心功能可用 | 15 秒刷新；無重複 ETA；null 顯示正確 |
| **M5 PWA** | manifest、Service Worker、離線 fallback | 可安裝 app | 飛航模式可開啟並查站表 |
| **M6 個人化** | 歷史、常到車站、清除 | 設定項 | 清除後 localStorage 完全無痕 |
| **M7 路線詳情頁** | 站序渲染、方向分頁、選中站 ETA、常搭路線 | 核心功能擴充 | 路線頁首次進入零網絡請求；單站 ETA 查詢 < 1 KB；O/I 切換零請求 |

**MVP 定義**：M0 - M4 完整。PWA 與個人化可作 M5/M6 迭代。

---

## 8. 已驗證 vs 待驗證

### ✅ 已實測確認（2026-10-05）

- 9 個 API 全部可存取，CORS `*` 開放
- 6,753 車站 / 1,605 路線 / 36,337 路線站關聯
- `stop-eta` 實測 5,163 bytes
- Haversine 距離計算正確（黃大仙中心 100m → 5 站、500m → 53 站）
- Nominatim 6 個香港地標全部命中
- Nominatim 成都同名地點、坑一坑二坑三全部已復現
- `eta: null` 佔比 29%，`rmk_tc` 分佈已統計
- `service_type` 8 種值分佈已統計
- 無效路線回 `200 + []`（非 404）
- ETA 跨 service_type 混入已復現
- `seq` 連續無跳號（1,605 組全數通過）
- Leaflet / OSM 圖磚 CDN 可存取

### ⏳ 待實作時驗證

- 精簡 + gzip 嘅實際體積（估算 1.1 MB → 400 KB）
- Leaflet zoom 15-16 實際圖磚數量
- Nominatim 實際 P95 響應時間
- Service Worker 快取策略嘅跨瀏覽器行為
- 500+ 站範圍列表嘅實際渲染效能

---

## 附錄 A：官方文件

- 數據字典：`docs/reference/kmb_eta_data_dictionary.pdf`（v1.02, 2021-05-10）
- API 規格：`docs/reference/kmb_eta_api_specification.pdf`（v1.05, 2024-10-23）
- 資料集頁面：https://data.gov.hk/tc-data/dataset/hk-td-tis_21-etakmb

## 附錄 B：實測原始數據

`docs/reference/` 內已保存：

- `route.json`（351 KB）— 全港路線
- `stop.json`（1.19 MB）— 全港車站
- `rs.json`（3.05 MB）— 路線站序
- `stopeta.json`（5 KB）— 單站 ETA 樣本
- `ckan.json`（11 KB）— CKAN 資源元數據
