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
node scripts/bump-sw.mjs# ← 必須：自動更新 sw.js 內的 BUILD_STAMP
```

`bump-sw.mjs` 會計算所有殼層檔案（含 gz 資料）的 sha256，寫成時間戳 + hash。
部署後用戶 Service Worker 會偵測到變化 → 重新 install → 快取名改變 → 拿到新版。

已驗證：改 CSS → bump → 快取名從 `buseta-shell-47dec145-...-a-13u1fus`
變為 `buseta-shell-47dec145-...-653053-1rz3qyl`，舊快取自動刪除。

可用 `node scripts/verify-sw-version.mjs` 驗證整個流程。

## 建議：改用 CI 自動部署

因為 `build-data.mjs` 依賴網絡（抓運輸署 API），在本地跑的結果未必與 CI 一致。
建議用 GitHub Actions + Wrangler：

```yaml
name: Deploy to Cloudflare Pages
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 21 * * *'   # 每日 05:00 HKT 更新資料後部署
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node scripts/build-data.mjs
      - run: node scripts/bump-sw.mjs      # ← 關鍵
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          command: pages deploy public --project-name=buseta
```

## 需要的 Cloudflare 憑證

- **Account ID**：Cloudflare 後台右側可見
- **API Token**：Workers & Pages → API Tokens → Create → 模板「Edit Cloudflare Workers」

## 離線測試

部署後建議用Chrome DevTools 驗證：

1. 開 Application → Service Workers，確認已註冊
2. Application → Cache Storage 應見 `buseta-shell-<buildId>`
3. Network → Offline 勾選，然後重載頁面
4. 應仍能載入、列出附近站、查看路線
