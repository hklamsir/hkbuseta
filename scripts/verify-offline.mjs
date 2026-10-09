/**
 * 離線模式驗證（規劃書 §5.5）
 *   node scripts/verify-offline.mjs
 *
 * 驗證重點：關閉網絡後 App Shell + 離線資料仍可用，只有 ETA 需要網絡。
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:8181';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
let pass = 0, fail = 0;
const ok = (c, m, x = '') => { c ? (pass++, console.log(`  ✅ ${m}${x ? ' — ' + x : ''}`)) : (fail++, console.log(`  ❌ ${m}${x ? ' — ' + x : ''}`)); };

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-HK' });
const page = await ctx.newPage();

/* ---------- 階段 1：連線狀態下載入，觸發 Service Worker 快取 ---------- */
console.log('\n[1] 暖身（觸發 Service Worker 快取）');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 20000 });
const sw = await page.evaluate(async () => {
	const r = await navigator.serviceWorker.ready;
	return !!r.active;
});
ok(sw, 'Service Worker 已啟動');

// 等 SW 完成 App Shell 預快取
await page.waitForTimeout(2500);
const cached = await page.evaluate(async () => {
	const keys = await caches.keys();
	const shell = keys.find((k) => k.startsWith('buseta-shell'));
	if (!shell) return { keys, n: 0 };
	const c = await caches.open(shell);
	return { keys, shell, n: (await c.keys()).length };
});
ok(cached.n >= 15, `App Shell 已快取 ${cached.n} 個資源`, cached.shell || '');
const hasGz = await page.evaluate(async () => {
	const shell = (await caches.keys()).find((k) => k.startsWith('buseta-shell'));
	const c = await caches.open(shell);
	const ks = await c.keys();
	return ks.filter((k) => k.url.includes('.gz')).length;
});
ok(hasGz >= 2, '離線資料 gz 已進快取', `${hasGz} 個`);

/* ---------- 階段 2：搜尋一個地標並開 ETA 頁（有網絡） ---------- */
console.log('\n[2] 連線下載入 ETA（建立 runtime 快取）');
await page.fill('#q', '黃大仙中心');
await page.waitForSelector('.result', { timeout: 20000 });
await page.click('.result');
await page.waitForSelector('.stop');
await page.click('.stop');
await page.waitForSelector('.eta-row', { timeout: 20000 });
const onlineRows = await page.$$eval('.eta-row', (e) => e.length);
ok(onlineRows > 0, '連線下ETA 正常', `${onlineRows} 列`);

const runtimeCached = await page.evaluate(async () => {
	const c = await caches.open('buseta-runtime');
	return (await c.keys()).length;
});
ok(runtimeCached > 0, 'ETA 已存入 runtime 快取（離線備援）', `${runtimeCached} 筆`);

/* ---------- 階段 3：切換完全離線 ---------- */
console.log('\n[3] 切換完全離線');
await ctx.setOffline(true);
await page.waitForTimeout(300);

const netState = await page.textContent('#net-state');
ok(/離線/.test(netState), '介面顯示離線狀態', netState.trim());

// 返回搜尋頁並確認歷史可用
await page.click('#eta-back');
await page.waitForTimeout(200);
await page.click('#nb-back');
await page.waitForTimeout(400);
const recentVisible = await page.$('.result[data-r]');
ok(!!recentVisible, '最近搜尋歷史離線可見');

/* ---------- 階段 4：離線重新載入 ---------- */
console.log('\n[4] 離線重新載入（關網重開 App）');
await page.reload({ waitUntil: 'domcontentloaded' });
let loaded = true;
try {
	await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 15000 });
} catch { loaded = false; }
ok(loaded, '離線下 App Shell + 離線資料載入成功');

if (loaded) {
	const stamp = await page.textContent('#data-stamp');
	// ⚠️ 唔寫死車站數（官方資料每日更新）——離線下真正要驗證嘅係「離線 gz 成功載入並解析」
	const nStops = Number(stamp.match(/([\d,]+) 個車站/)?.[1].replace(/,/g, '') || 0);
	ok(nStops > 6000, '車站資料離線可用', stamp.trim());

	// 離線下用歷史記錄查附近站
	await page.click('.result[data-r]');
	await page.waitForSelector('.stop', { timeout: 10000 });
	const stops = await page.$$eval('.stop', (e) => e.length);
	ok(stops > 0, '離線下可列出附近巴士站', `${stops} 組`);

	const cnt = await page.textContent('#nb-count');
	ok(/\d+ 個站/.test(cnt), '距離計算離線正常', cnt.trim());

	// 離線下開 ETA：應顯示錯誤提示（而非崩潰）
	await page.click('.stop');
	await page.waitForSelector('.error-box, .empty, .eta-row', { timeout: 20000 });
	await page.waitForTimeout(1200);
	const errTitle = await page.textContent('.error-box .t, .empty .t, .eta-row .route-no').catch(() => '');
	ok(!!errTitle, '離線下 ETA 頁有明確狀態（錯誤/空/上次資料）', errTitle.trim());
	await page.screenshot({ path: join(SHOTS, '07-offline.png') });

	// 離線下開地圖：vector 圖層應仍可畫
	await page.click('#eta-back');
	await page.waitForTimeout(300);
	await page.click('#nb-map');
	await page.waitForTimeout(2500);
	const vectorPaths = await page.$$eval('#map path', (e) => e.length);
	ok(vectorPaths > 0, '離線下地圖 vector 圖層仍可繪製', `${vectorPaths} 個 path`);
	const offlineBadge = await page.$eval('#map-offline', (e) => e.classList.contains('on')).catch(() => false);
	console.log(`     底圖狀態：${offlineBadge ? '已切離線模式（無底圖）' : 'OSM 圖磚仍載入'}`);
	await page.screenshot({ path: join(SHOTS, '08-offline-map.png') });
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通過 ${pass}　失敗 ${fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
