/**
 * Bump Service Worker 版本戳
 *
 *   node scripts/bump-sw.mjs
 *
 * 為何需要：改動 App Shell 檔案（index.html / css / js / vendor）後，
 * 瀏覽器不會重新執行 Service Worker 的 install（因為 sw.js 本身無變化），
 * 導致用戶永遠拿到舊版App Shell。
 *
 * 解法：自動改sw.js 內的 BUILD_STAMP，令 sw.js 檔案 hash 改變，
 * 瀏覽器偵測到 SW 有更新 → 重新 install → 新快取名 → 用戶收到新版。
 *
 * ⚠️ BUILD_STAMP 必須**只由內容決定**，不可含日期／時間戳。
 * 若帶日期，即使殼層與資料完全無變，每日跑一次都會改動 sw.js
 * → 用戶每日被迫重裝 SW 並重新下載 339 KB 離線資料。
 * 因此：殼層／資料無實質變化時，本腳本**不會改動 sw.js**（直接 exit 0）。
 *
 * 部署前跑一次即可，唔使手動編輯。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = join(ROOT, 'public', 'sw.js');

/** 與 sw.js 的 VERSIONED 保持一致 */
const VERSIONED = [
	'public/index.html',
	'public/manifest.json',
	'public/css/app.css',
	'public/js/data.js',
	'public/js/app.js',
	'public/vendor/leaflet.js',
	'public/vendor/leaflet.css',
	'public/data/stops.json.gz',
	'public/data/routes.json.gz'
];

const h = createHash('sha256');
for (const rel of VERSIONED) {
	const buf = await readFile(join(ROOT, rel));
	// .gz 一律**解壓後**再 hash：gzip 位元組依賴 zlib 版本，
	// Windows 本機與 GitHub Actions ubuntu-latest 的 zlib patch 版本可能不同，
	// 直接 hash 壓縮檔會令同一份資料在不同機器算出不同 BUILD_STAMP。
	if (rel.endsWith('.gz')) {
		h.update(gunzipSync(buf));
	} else {
		h.update(buf);
	}
}
// BUILD_STAMP 必須**只由內容決定**，不可含日期或時間戳。
//
// 原因：Service Worker 只在 sw.js 本身位元組改變時才重新 install。
// 若此處帶日期，即使殼層與資料完全無變，每日跑一次都會改動 sw.js
// → 用戶每日被迫重裝 SW 並重新下載 339 KB 離線資料，純屬浪費。
// 改為純內容 hash 後：殼層／資料無變 → sw.js 位元組不變 → 不會重裝。
const stamp = h.digest('hex').slice(0, 8);

const src = await readFile(SW, 'utf8');
const RE = /const BUILD_STAMP = '[^']*';/;
if (!RE.test(src)) {
	console.error('❌ 搵唔到 BUILD_STAMP，請檢查 sw.js 格式');
	process.exit(1);
}

const next = src.replace(RE, `const BUILD_STAMP = '${stamp}';`);

if (src === next) {
	// 殼層內容與上次打包完全相同 → 刻意不寫入，sw.js 位元組保持不變
	console.log(`✅ BUILD_STAMP 已是最新（${stamp}）`);
	console.log('   殼層／資料內容無變化 → sw.js 不會改動 → 用戶不會收到無謂更新（預期行為）');
	process.exit(0);
}

await writeFile(SW, next);
console.log(`✅ BUILD_STAMP → ${stamp}`);
console.log(`   殼層快取名將變為 buseta-shell-<buildId>-${stamp}`);
console.log('   部署前跑一次，用戶就會自動收到新版');
