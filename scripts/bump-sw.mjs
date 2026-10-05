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
 * 部署前跑一次即可，唔使手動編輯。
 */
import { readFile, writeFile } from 'node:fs/promises';
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
	h.update(await readFile(join(ROOT, rel)));
}
const stamp = `${new Date().toISOString().slice(0, 10)}-${h.digest('hex').slice(0, 6)}`;

const src = await readFile(SW, 'utf8');
const next = src.replace(/const BUILD_STAMP = '[^']*';/, `const BUILD_STAMP = '${stamp}';`);

if (src === next) {
	console.error('❌ 搵唔到 BUILD_STAMP，請檢查 sw.js 格式');
	process.exit(1);
}

await writeFile(SW, next);
console.log(`✅ BUILD_STAMP → ${stamp}`);
console.log(`   殼層快取名將變為 buseta-shell-<buildId>-${stamp}`);
console.log('   部署前跑一次，用戶就會自動收到新版');
