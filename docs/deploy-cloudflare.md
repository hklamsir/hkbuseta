# Cloudflare Pages 部署說明

## 設定（在 Cloudflare Pages 後台）

| 欄位 | 值 |
|---|---|
| Framework preset | None |
| Build command | *(留空)* |
| Build output directory | `public` |
| Root directory | *(專案根目錄)* |

因為全部係靜態檔，唔需要 build command。

## 部署前必做：bump Service Worker 版本

Service Worker 會快取 App Shell。**改咗 `js/`、`css/`、`index.html` 之後必須 bump，
否則用戶永遠拿到舊版。**

原因：Service Worker 只有在 `sw.js` **本身檔案有變化**時才會重新 install。
改 app 檔案唔會觸發 SW 更新。

```bash
node scripts/build-data.mjs    # 更新離線資料（若需要的話）
node scripts/bump-sw.mjs       # ← 必須：自動更新 sw.js 內的 BUILD_STAMP
```

`bump-sw.mjs` 會計算所有殼層檔案的 sha256（gz 檔以**解壓後內容**計算，確保跨平台一致），
寫入 `sw.js` 的 `BUILD_STAMP`。部署後用戶 Service Worker 會偵測到變化 → 重新 install →
快取名改變 → 拿到新版。

> **BUILD_STAMP 與 `buildId` 都只由內容決定，不含日期。**
> 若帶日期，即使殼層與資料完全無變，每日跑一次部署都會改動 `sw.js`，
> 用戶被迫每日重裝 SW 並重下 339 KB 離線資料。因此 `bump-sw.mjs` 在內容無變時
> **不會寫入** `sw.js`，直接 exit 0。

已驗證：改 CSS → bump → 快取名從 `buseta-shell-ea6c5ce1-3cedc099-...-1v656db`
變為新值，舊快取自動刪除；還原後再 bump → 快取名回到原值。

可用 `node scripts/verify-sw-version.mjs` 驗證整個流程。

## 每日自動更新資料（已內建）

`.github/workflows/update-data.yml` 已配置好，**毋須再自行建立**：

- 每日 **05:30 HKT**（cron `30 21 * * *` UTC，官方資料 05:00 更新後 30 分鐘）
- 流程：抓 API → 健全性檢查 → 比對 `buildId` → **僅在有實質變化時** bump + commit + push
- 部署由 **Cloudflare Workers Builds** 自動接手（repo 已連結），故**毋須 Cloudflare API Token**

首次使用可到 Actions 頁手動按 **Run workflow** 驗證。

### 為何要用 `buildId` 而非 `git diff` 判斷變化

`buildId` = **未壓縮 JSON 內容**的 hash。gzip 位元組依賴 zlib 版本，
本機 Windows（zlib 1.3.1-e00f703）與 ubuntu-latest 的版本可能不同 → 同一份資料
產出的 gz 位元組可能不一致。若用 `git diff` 判斷，CI 會每日誤判「有變化」而每天部署，
抵銷本改造目的。實測以三種 gzip level 壓縮同一份資料：gz hash 全部不同
（`3abf68c6` / `b5835aaa` / `90cdafb5`），但 buildId 恆為 `ea6c5ce1`。

## 需要的 Cloudflare 憑證

**現行配置（Workers Builds + GitHub 連結）：毋須任何憑證。**

部署由 Cloudflare Workers Builds 自動接手，GitHub Actions 只需 `contents: write`
（內建權限，不需設定 secret）。以下憑證僅在你改用 `wrangler` 手動部署時才需要：

- **Account ID**：Cloudflare 後台右側可見
- **API Token**：Workers & Pages → API Tokens → Create → 模板「Edit Cloudflare Workers」

## 離線測試

部署後建議用Chrome DevTools 驗證：

1. 開 Application → Service Workers，確認已註冊
2. Application → Cache Storage 應見 `buseta-shell-<buildId>`
3. Network → Offline 勾選，然後重載頁面
4. 應仍能載入、列出附近站、查看路線
