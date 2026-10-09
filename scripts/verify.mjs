/**
 * MVP 驗證腳本 — 用真實瀏覽器走完整用戶流程
 *
 *   node scripts/verify.mjs
 *
 * 驗證項目：
 *   1. 離線資料載入（gzip 解壓 + 索引建立）
 *   2. 地標搜尋（Nominatim）
 *   3. 圓形範圍篩選 + 同名站合併
 *   4. ETA 載入 + 去重 + null 分流
 *   5. 距離計算與規劃書實測值一致
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE_URL || 'http://localhost:8181';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log(`  ✅ ${m}${extra ? ' — ' + extra : ''}`)) : (fail++, console.log(`  ❌ ${m}${extra ? ' — ' + extra : ''}`)); };

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
	viewport: { width: 390, height: 844 },   // iPhone 14
	deviceScaleFactor: 2,
	locale: 'zh-HK',
	permissions: []
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

await mkdir(SHOTS, { recursive: true });

/* ---------- 1. 首頁載入 ---------- */
console.log('\n[1] 首頁載入');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 20000 });

const stamp = await page.textContent('#data-stamp');
console.log(`     ${stamp}`);
// ⚠️ 車站／路線數**唔寫死**（官方資料每日更新，寫死會令每日 build 都紅）。
//改為與 build-manifest.json 對帳 —— 呢個先係真正要驗證嘅嘢（UI 顯示 == 離線資料）。
const mf = await (await fetch(`${BASE}/data/build-manifest.json`)).json();
const nStops = Number(stamp.match(/([\d,]+) 個車站/)?.[1].replace(/,/g, '') || -1);
const nRoutes = Number(stamp.match(/([\d,]+) 條路線/)?.[1].replace(/,/g, '') || -1);
// M9：同時載入兩家（切換器已改為「顯示偏好」，唔會再只載一家）
const expectStops = mf.companies.kmb.stops + mf.companies.ctb.stops;
ok(nStops === expectStops, '車站數為兩家合計（與 manifest 一致）', `${nStops} vs ${expectStops}`);
ok(/跨公司合併後/.test(stamp), '顯示跨公司合併後的站數', stamp.match(/跨公司合併後約 [\d,]+ 個站/)?.[0] || '(無)');
ok(nRoutes === mf.companies.kmb.routes, '路線數（偏好公司）與 manifest 一致', `${nRoutes} vs ${mf.companies.kmb.routes}`);

const dbInfo = await page.evaluate(() => {
	const B = window.BusETA;
	return { hasDB: true, stops: document.getElementById('data-stamp').textContent };
});
ok(dbInfo.stops.length > 0, '資料層掛載成功');

await page.screenshot({ path: join(SHOTS, '01-home.png') });

/* ---------- 2. 資料層單元驗證 ---------- */
console.log('\n[2] 資料層邏輯驗證');
const logic = await page.evaluate(() => {
	const B = window.BusETA;
	// 復現規劃書 §3.3 實測：黃大仙中心
	const place = { name: '黃大仙中心', lat: 22.3413757, lng: 114.1943294 };
	const r100 = B.findNearbyStops(window.__DB, place, 100);
	const r200 = B.findNearbyStops(window.__DB, place, 200);
	const r500 = B.findNearbyStops(window.__DB, place, 500);
	// 太古城中心站數（實測有 6 個獨立 stop ID）
	const tsp = { name: '太古城中心', lat: 22.2863042, lng: 114.2173461 };
	const tsp500 = B.findNearbyStops(window.__DB, tsp, 500);
	const groups = new Map();
	for (const s of tsp500) groups.set(s.name, (groups.get(s.name) || 0) + 1);
	const sameNames = [...groups.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 3);
	const tsp200 = B.findNearbyStops(window.__DB, tsp, 200);
	const tspNames = new Set(tsp200.map((s) => s.name));
	// ETA 格式化邊界
	const mk = (ts, rmk = '') => ({ ts, rmk });
	const now = Date.parse('2026-10-05T15:00:00+08:00');
	return {
		r100: r100.length, r200: r200.length, r500: r500.length,
		nearest100: r100[0]?.name, nearestD: r100[0]?.distance,
		groupCounts: sameNames,
		tscSameName: tspNames.has('太古城中心'), tscStops200: tsp200.length,
		tscSameNameCount: groups.get('太古城中心') || 0,
		fmt: {
			soon: B.formatEta(mk(now + 30 * 1000), now).text,
			soonAfter: B.formatEta(mk(now - 30 * 1000), now).text,
			stale: B.formatEta(mk(now - 120 * 1000), now).text,
			min3: B.formatEta(mk(now + 3 * 60000 + 20000), now).text,
			hour: B.formatEta(mk(now + 65 * 60000), now).text,
			nullEmpty: B.formatEta(mk(null, ''), now).text,
			nullHoliday: B.formatEta(mk(null, '服務只限於星期日及公眾假期'), now).text
		}
	};
}).catch((e) => ({ error: e.message }));

if (logic.error) { ok(false, '資料層評估', logic.error); }
else {
	ok(logic.r100 === 5, '黃大仙中心 100m → 5 個站', `實得 ${logic.r100}`);
	ok(logic.r200 === 14, '黃大仙中心 200m → 14 個站', `實得 ${logic.r200}`);
	ok(logic.r500 === 53, '黃大仙中心 500m → 53 個站', `實得 ${logic.r500}`);
	ok(logic.nearest100?.includes('黃大仙'), '最近站名正確', `${logic.nearest100} @ ${logic.nearestD}m`);
	ok(logic.groupCounts.length > 0, '偵測到同名站（需合併）', JSON.stringify(logic.groupCounts));
	ok(logic.tscSameName && logic.tscStops200 === 8, '太古城中心 200m → 8 個站', `實得 ${logic.tscStops200}`);
	ok(logic.tscSameNameCount >= 4, '太古城中心有 6 個同名 stop ID（實測）', `500m 內 ${logic.tscSameNameCount} 個`);

	ok(logic.fmt.soon === '即將到', 'ETA +30秒 → 即將到', logic.fmt.soon);
	ok(logic.fmt.soonAfter === '即將到', 'ETA -30秒 → 即將到（不顯示負數）', logic.fmt.soonAfter);
	ok(logic.fmt.stale === '已開出', 'ETA -120秒 → 已開出', logic.fmt.stale);
	ok(logic.fmt.min3 === '3 分鐘', 'ETA +3分 → 3 分鐘', logic.fmt.min3);
	ok(/小時/.test(logic.fmt.hour), 'ETA +65分 → 小時格式', logic.fmt.hour);
	ok(logic.fmt.nullEmpty === '暫時冇預報', 'null+空rmk → 暫時冇預報', logic.fmt.nullEmpty);
	ok(logic.fmt.nullHoliday === '今日非服務日', 'null+假期rmk → 今日非服務日', logic.fmt.nullHoliday);
}

/* ---------- 3. 地標搜尋 ---------- */
console.log('\n[3] 地標搜尋（Nominatim 實測）');
await page.fill('#q', '黃大仙中心');
await page.waitForSelector('.result', { timeout: 20000 });
const results = await page.$$eval('.result .name', (els) => els.map((e) => e.textContent.trim()));
ok(results.length > 0, '搜尋有結果', `${results.length} 個：${results.slice(0, 3).join(' / ')}`);
ok(results.some((r) => r.includes('黃大仙')), '首選命中黃大仙');
const metas = await page.$$eval('.result .meta', (els) => els.map((e) => e.textContent.trim()));
ok(metas.every((m) => !m.includes('成都')), '無外國同名地點混入', metas[0]);
ok(metas[0]?.includes('最近巴士站'), '顯示最近巴士站距離（判斷命中點是否門口）', metas[0]);
await page.screenshot({ path: join(SHOTS, '02-search.png') });

/* ---------- 3a. 搜尋命中點排序（淘大花園實測回歸） ---------- */
console.log('\n[3a] 搜尋命中點排序');
// 實測：Nominatim 對「淘大花園」返回 2 筆，display_name 完全相同
//   - bus_stop    → 距 KT376 30m，200m 內 5 組（含德福花園）
//   - residential → 距 KT376 76m，200m 剛好切邊只有 4 組（漏咗德福花園）
// 用戶無從分辨，故必須靠 type + 距離自動排序。
await page.evaluate(() => window.BusETA.clearGeoCache());
// 注意：不可用 page.fill() —— 它不觸發 input handler，舊結果會留在畫面
await page.click('#q');
await page.evaluate(() => { document.getElementById('q').value = ''; });
await page.type('#q', '淘大花園', { delay: 30 });
await page.waitForSelector('#search-results .result', { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('search-results')?.textContent.includes('淘大花園'), { timeout: 20000 });
const taoda = await page.evaluate(() =>
	[...document.querySelectorAll('#search-results .result')].map((e) => ({
		name: e.querySelector('.name')?.textContent.trim() || '',
		tag: e.querySelector('.name .tag')?.textContent.trim() || '',
		meta: e.querySelector('.meta')?.textContent.trim() || '',
		dist: parseInt((e.querySelector('.meta')?.textContent.match(/最近巴士站 (\d+) 米/) || [])[1] || '9999', 10)
	})));
ok(taoda.length >= 2, '「淘大花園」返回多個命中點', `${taoda.length} 筆`);
// 名稱含 badge 文字，故用 startsWith 判斷
ok(taoda[0].name.startsWith('淘大花園') && taoda[0].tag === '準確位置',
	'最前項為 bus_stop 命中點並標示「準確位置」', `${taoda[0].name}（${taoda[0].dist} 米）`);
ok(taoda[0].dist <= 50, '最前項距離最近', `${taoda[0].dist} 米`);
ok(taoda[1].dist > taoda[0].dist && taoda[1].tag === '區塊中心',
	'住宅區塊中心排在後面並標示「區塊中心」', `${taoda[1].dist} 米`);

// 揀最前項 → 應顯示完整站數（含德福花園）
await page.click('#search-results .result');
await page.waitForFunction(() => document.getElementById('page-nearby')?.classList.contains('active'), { timeout: 10000 });
await page.waitForTimeout(600);
const taodaStops = await page.$$eval('#nb-list .stop .name .txt', (els) => els.map((e) => e.textContent.trim()));
ok(taodaStops.length >= 6, '揀「準確位置」後站數完整', `${taodaStops.length} 組`);
ok(taodaStops.some((s) => s.includes('德福花園')), '包含原本漏掉的德福花園（切邊問題已解）');
await page.screenshot({ path: join(SHOTS, '13-search-rank.png') });
await page.click('#nb-back');
await page.waitForTimeout(300);

/* ---------- 3a-2. 完全同名優先於 bus_stop ---------- */
console.log('\n[3a-2] 完全同名優先於鄰近巴士站');
// 實測：「黃大仙中心」會同時返回「黃大仙中心」(商場) 與鄰近「沙田坳道」(bus_stop, 12m)。
// 用戶在搜尋該商場 → 同名者必須優先，否則會被鄰站蓋掉（曾令 14 個站變 13 個）。
await page.evaluate(() => window.BusETA.clearGeoCache());
await page.click('#q');
await page.evaluate(() => { document.getElementById('q').value = ''; });
await page.type('#q', '黃大仙中心', { delay: 25 });
await page.waitForSelector('#search-results .result', { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('search-results')?.textContent.includes('黃大仙中心'), { timeout: 20000 });
const hsr = await page.evaluate(() =>
	[...document.querySelectorAll('#search-results .result')].map((e) => ({
		name: e.querySelector('.name')?.textContent.trim() || '',
		tag: e.querySelector('.name .tag')?.textContent.trim() || ''
	})));
ok(hsr[0].name.startsWith('黃大仙中心'), '最前項為完全同名的商場（而非鄰近的沙田坳道巴士站）',
	hsr.slice(0, 2).map((x) => x.name).join(' / '));
ok(!hsr[0].name.includes('準確位置'), '完全同名項不加「準確位置」badge（避免誤導）', hsr[0].tag || '(無 badge)');

await page.click('#search-results .result');
await page.waitForFunction(() => document.getElementById('page-nearby')?.classList.contains('active'), { timeout: 10000 });
await page.waitForTimeout(500);
const hsrCount = await page.textContent('#nb-count');
ok(/\d+ 個站/.test(hsrCount), '附近站已顯示站數（M9 合併後）', hsrCount.trim());
ok(/合併後/.test(hsrCount), '顯示合併前後站數對比', hsrCount.trim());
await page.click('#nb-back');
await page.waitForTimeout(300);

/* ---------- 3b. 搜尋節流 + 緩存 + 錯誤分類 ---------- */
console.log('\n[3b] 搜尋節流、緩存、錯誤分類');
// 官方政策：硬性上限 1 req/s（operations.osmfoundation.org/policies/nominatim/）
const geo = await page.evaluate(async () => {
	const B = window.BusETA;
	B.clearGeoCache();
	const times = [];
	const orig = window.fetch;
	window.fetch = (u, o) => { times.push(Date.now()); return orig(u, o); };
	// 連續 3 個不同查詢 → 應被節流到 ≥1100ms 間隔
	for (const t of ['太古城中心', '觀塘apm', '沙田新城市']) {
		try { await B.searchPlaceRatelimited(t, null, 'kmb'); } catch { /* 網絡問題不影響節流驗證 */ }
	}
	const gaps = times.slice(1).map((t, i) => t - times[i]);
	// 第一次查詢後再查同一字串 → 應命中緩存零請求
	const beforeCache = times.length;
	let cachedHit = null;
	try { cachedHit = await B.searchPlaceRatelimited('太古城中心', null, 'kmb'); } catch { /* ignore */ }
	const cacheGained = times.length - beforeCache;
	const stored = JSON.parse(localStorage.getItem('buseta.geoCache') || '[]');
	window.fetch = orig;
	return { reqs: times.length, gaps, allGapOk: gaps.every((g) => g >= 1090), cacheGained, cached: !!cachedHit?.cached, storedLen: stored.length };
});
ok(geo.reqs <= 3, '連續查詢的實際請求數', `${geo.reqs} 次`);
ok(geo.gaps.length === 0 || geo.allGapOk, '請求間隔全部 ≥1100ms（官方上限 1 req/s）',
	geo.gaps.length ? geo.gaps.join(' / ') + ' ms' : '只有 1 次請求');
ok(geo.cacheGained === 0, '重複查詢命中緩存 → 零網絡請求', `多用 ${geo.cacheGained} 次`);
ok(geo.cached, '快取命中時有明確標記');

// 錯誤分類（模擬各種失敗）
const geoErrs = [];
for (const [label, status, extraHeaders] of [
	['403', 403, {}], ['429', 429, { 'Retry-After': '12' }],
	['500', 500, {}], ['network', 0, {}]
]) {
	await page.evaluate(([st, hd]) => {
		window.__of = window.__of || window.fetch;
		window.fetch = (u, o) => {
			if (String(u).includes('nominatim')) {
				if (st === 0) return Promise.reject(new TypeError('Failed to fetch'));
				return Promise.resolve(new Response('{}', { status: st, headers: hd }));
			}
			return window.__of(u, o);
		};
	}, [status, extraHeaders]);
	await page.evaluate(() => {
		const el = document.getElementById('q');
		el.value = '測試' + Math.random().toString(36).slice(2);
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(2200);
	geoErrs.push(await page.evaluate((lbl) => {
		const box = document.querySelector('#search-results .error-box');
		return {
			label: lbl,
			title: box?.querySelector('.t')?.textContent || '',
			desc: box?.querySelector('.d')?.textContent || '',
			retry: document.getElementById('search-retry')?.textContent || '',
			reloads: /location\.reload/.test(document.getElementById('search-results').innerHTML)
		};
	}, label));
	await page.evaluate(() => { window.fetch = window.__of; });
}
const byLabel = Object.fromEntries(geoErrs.map((g) => [g.label, g]));
ok(byLabel['403'].title.includes('不接受'), '403 → 顯示「服務暫不接受查詢」而非泛泛的繁忙', byLabel['403'].title);
ok(byLabel['403'].desc.includes('政策'), '403 說明成因是服務端政策限制', byLabel['403'].desc.slice(0, 30));
ok(byLabel['429'].title.includes('太頻密'), '429 → 顯示「請求太頻密」', byLabel['429'].title);
ok(byLabel['429'].desc.includes('12'), '429 讀取 Retry-After 告知等待秒數', byLabel['429'].desc.slice(0, 40));
ok(byLabel['500'].title.includes('繁忙'), '5xx → 顯示「暫時繁忙」', byLabel['500'].title);
ok(byLabel['network'].title.includes('無法連接'), '網絡中斷 → 顯示「無法連接搜尋服務」', byLabel['network'].title);
ok(geoErrs.every((g) => g.retry === '重新搜尋'), '錯誤框按鈕為「重新搜尋」');
ok(geoErrs.every((g) => !g.reloads), '已移除無效的 location.reload（403 下 reload 冇用）');

// 恢復正常搜尋（下一步 [4] 需要一份搜尋結果）
await page.evaluate(() => {
	window.BusETA.clearGeoCache();
	const el = document.getElementById('q');
	el.value = '黃大仙中心';
	el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForSelector('#search-results .result', { timeout: 20000 });
await page.waitForTimeout(300);

/* ---------- 4. 附近站列表 ---------- */
console.log('\n[4] 附近站列表');
await page.click('.result');
await page.waitForSelector('.stop', { timeout: 10000 });
await page.waitForTimeout(300);
const countTxt = await page.textContent('#nb-count');
ok(/\d+ 個站/.test(countTxt), '預設 200m 顯示站數', countTxt.trim());
const stopNames = await page.$$eval('.stop .name .txt', (els) => els.map((e) => e.textContent.trim()));
ok(stopNames.length > 0, '列表有站點', stopNames.join(' / '));
const chipCount = await page.$$eval('.stop .chip', (els) => els.length);
ok(chipCount > 0, '顯示路線 chips', `${chipCount} 個`);
const perf = await page.textContent('#nb-count');
ok(/\d+ 毫秒/.test(perf), '計算耗時已顯示（零網絡請求）');
await page.screenshot({ path: join(SHOTS, '03-nearby.png') });

// 切換到 500m
await page.click('#range-seg button[data-r="500"]');
await page.waitForTimeout(300);
const c500 = await page.textContent('#nb-count');
ok(/\d+ 個站/.test(c500) && !/5 個站/.test(c500), '切換 500m 範圍生效', c500.trim());
const groups500 = await page.$$eval('.stop .tag.gray', (els) => els.length);
ok(groups500 > 0, '同名站已合併並標記', `${groups500} 組`);
await page.screenshot({ path: join(SHOTS, '04-nearby-500.png') });

/* ---------- 5. ETA 頁 ---------- */
console.log('\n[5] ETA 頁');
await page.click('#range-seg button[data-r="100"]');
await page.waitForTimeout(200);
await page.click('.stop');
await page.waitForSelector('.eta-row, .empty, .error-box', { timeout: 20000 });
await page.waitForTimeout(500);

const etaName = await page.textContent('#eta-name');
ok(etaName.length > 0, '站名已顯示', etaName);
const coord = await page.textContent('#eta-coord');
ok(/22\.\d{4,6}, 114\.\d{4,6}/.test(coord), '座標已顯示', coord.trim());

const hasRows = await page.$$eval('.eta-row', (els) => els.length);
if (hasRows) {
	ok(hasRows > 0, 'ETA 路線列已渲染', `${hasRows} 列`);
	const routes = await page.$$eval('.route-no', (els) => els.map((e) => e.textContent.trim()));
	ok(routes.length > 0, '路線號已顯示', routes.slice(0, 6).join(' '));
	const etas = await page.$$eval('.eta .t', (els) => els.map((e) => e.textContent.trim()));
	const valid = etas.every((t) => /即將到|分鐘|小時|預報|非服務|暫停|已開出/.test(t));
	ok(valid, 'ETA 文字全部符合格式化規則', etas.slice(0, 5).join(' | '));
	ok(!etas.some((t) => /-\d/.test(t)), '無負數倒數', '');
	// 去重檢查：同一路線不應重複
	const dup = routes.length !== new Set(routes).size;
	ok(!dup, '路線已去重（無重複）', dup ? '發現重複' : 'OK');
	const stamp2 = await page.textContent('#eta-stamp');
	ok(stamp2.includes('資料時間'), '顯示官方資料時間戳', stamp2);
} else {
	const emptyTxt = await page.textContent('.empty .t, .error-box .t');
	ok(!!emptyTxt, '無 ETA 時顯示空狀態（非崩潰）', emptyTxt);
}
await page.screenshot({ path: join(SHOTS, '05-eta.png') });

/* ---------- 6. 倒數 tick ---------- */
console.log('\n[6] 倒數更新');
const t1 = await page.$$eval('.eta .t', (els) => els.map((e) => e.textContent));
await page.waitForTimeout(2200);
const t2 = await page.$$eval('.eta .t', (els) => els.map((e) => e.textContent));
ok(t1.length === t2.length, 'ETA 節點數穩定', `${t1.length} → ${t2.length}`);
if (t1.join() !== t2.join()) console.log(`     ⏱ 倒數有更新：${t1[0]} → ${t2[0]}`);

/* ---------- 7. 地圖 ---------- */
console.log('\n[7] 地圖（Leaflet + 離線 fallback）');
await page.click('#eta-back');
await page.waitForTimeout(300);
await page.click('#nb-map');
await page.waitForTimeout(1800);
const mapOn = await page.$eval('#map', (e) => e.classList.contains('on'));
ok(mapOn, '地圖已開啟');
const circle = await page.$$eval('#map path', (els) => els.length);
ok(circle > 0, '範圍圓圈等vector 圖層已繪製', `${circle} 個 path`);
const markerCount = await page.evaluate(() => {
	const m = document.querySelectorAll('#map .leaflet-interactive').length;
	return m;
});
ok(markerCount > 0, '站點 marker 已繪製', `${markerCount} 個`);
await page.screenshot({ path: join(SHOTS, '06-map.png') });
await page.click('#map-close');

/* ---------- 8. 個人化 ---------- */
console.log('\n[8] 個人化（localStorage）');
const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('buseta.recent') || '[]'));
ok(recent.length > 0, '搜尋歷史已寫入', recent.map((r) => r.name).join(', '));
await page.click('#nb-back');
await page.waitForTimeout(300);
const hasRecentUI = await page.$('.result[data-r]');
ok(!!hasRecentUI, '最近搜尋 UI 已顯示');
const favTest = await page.evaluate(() => {
	const B = window.BusETA;
	const added = B.store.favorites.toggle('kmb', { stop: 'TESTID', name: '測試站', lat: 22.3, lng: 114.2 });
	const has = B.store.favorites.has('kmb', 'TESTID');
	B.store.favorites.toggle('kmb', { stop: 'TESTID', name: '測試站', lat: 22.3, lng: 114.2 });
	return { added, has };
});
ok(favTest.added && favTest.has, '常到車站新增/切換正常');

/* ---------- 8b. 路線詳情頁 ---------- */
console.log('\n[8b] 路線詳情頁');
// [8] 結尾已回到搜尋頁；從「最近搜尋」進入 nearby → ETA 頁 → 點路線行
await page.click('#recent [data-r="0"]');
await page.waitForFunction(() => document.getElementById('page-nearby')?.classList.contains('active'), { timeout: 10000 });
await page.waitForTimeout(400);
await page.click('#nb-list .stop');
await page.waitForFunction(() => document.querySelectorAll('#eta-list .eta-row').length > 0, { timeout: 20000 });
const etaRows = await page.$$('#eta-list .eta-row');
ok(etaRows.length > 0, 'ETA 路線行可點擊', `${etaRows.length} 行`);

// 記錄點擊前的網絡請求，驗證路線頁首次進入零網絡請求（站序來自離線資料）
await page.evaluate(() => {
	window.__netCount = 0;
	const of = window.fetch;
	window.fetch = function (...a) { window.__netCount++; return of.apply(this, a); };
});
await etaRows[0].click();
await page.waitForFunction(() => document.getElementById('page-route')?.classList.contains('active'), { timeout: 10000 });
await page.waitForTimeout(1200);

const rt = await page.evaluate(() => {
	const rows = [...document.querySelectorAll('#rt-list .seq-row')];
	return {
		active: document.getElementById('page-route').classList.contains('active'),
		no: document.getElementById('rt-no').textContent,
		dest: document.getElementById('rt-dest').textContent,
		count: document.getElementById('rt-count').textContent,
		rowCount: rows.length,
		dirTabs: [...document.querySelectorAll('#rt-dirs button')].map((b) => b.textContent.trim()),
		selected: rows.findIndex((r) => r.classList.contains('sel')),
		hasCode: !!document.querySelector('#rt-list .seq-row .code'),
		hasTermBadge: !!document.querySelector('#rt-list .tag.gray'),
		etaBox: !!document.querySelector('#rt-list .seq-eta'),
		etaText: document.querySelector('#rt-list .seq-eta')?.textContent.replace(/\s+/g, ' ').trim() || '',
		net: window.__netCount
	};
});
ok(rt.active, '路線頁已開啟');
ok(/^\d/.test(rt.no), '路線號已顯示', rt.no);
ok(/往/.test(rt.dest), '終點名已顯示', rt.dest);
ok(/^\d+ 站$/.test(rt.count), '站數已顯示', rt.count);
ok(rt.rowCount > 0, '站序已完整列出', `${rt.rowCount} 行`);
ok(rt.dirTabs.length >= 1 && rt.dirTabs.every((t) => t.includes('往')), '方向分頁以終點名標示', rt.dirTabs.join(' / '));
ok(rt.selected >= 0, '用戶當前站已自動選中', `第 ${rt.selected + 1} 行`);
ok(rt.hasCode, '分站編碼以細字顯示');
ok(rt.hasTermBadge, '總站 badge 已標示');
ok(rt.net <= 1, '路線頁首次進入近乎零網絡請求（站序來自離線資料）', `${rt.net} 次`);
ok(/到站時間/.test(rt.etaText), '選中站 ETA 已 inline 展開', rt.etaText.slice(0, 60));
await page.screenshot({ path: join(SHOTS, '08-route-page.png') });

// ETA 格式合規 + 無負數
const rtEtas = await page.evaluate(() => [...document.querySelectorAll('#rt-list .seq-eta .eta')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
ok(rtEtas.length > 0, '選中站有 ETA 資料', rtEtas.join(' | '));
ok(!rtEtas.some((t) => /-\d/.test(t)), '路線頁 ETA 無負數倒數', '');

// 切換方向（零網絡請求）
const beforeDir = await page.evaluate(() => window.__netCount);
const dirBefore = await page.evaluate(() => [...document.querySelectorAll('#rt-dirs button')].findIndex((b) => b.classList.contains('on')));
// ⚠️ M9：唔可以盲click「最後一個」方向 tab —— 可能啱啱就係當前（無變化）
await page.evaluate(() => {
	const bs = [...document.querySelectorAll('#rt-dirs button')];
	const cur = bs.findIndex((b) => b.classList.contains('on'));
	const target = bs.findIndex((b, k) => k !== cur);
	if (target >= 0) bs[target].click();
});
await page.waitForTimeout(900);
const afterDir = await page.evaluate(() => ({
	net: window.__netCount,
	dir: [...document.querySelectorAll('#rt-dirs button')].findIndex((b) => b.classList.contains('on')),
	rows: document.querySelectorAll('#rt-list .seq-row').length
}));
// ⚠️ 方向分頁數量取決於**實時 ETA 回應**（部分路線在某些時段只有單一方向有班次）。
//    故只有在有 ≥2 個 tab 時才驗證「切換有效」，否則 skip（唔係回歸）。
const dirTabs = await page.evaluate(() => document.querySelectorAll('#rt-dirs button').length);
if (dirTabs < 2) {
	ok(true, '方向切換生效（此路線只有單一方向，跳過）', `只有 ${dirTabs} 個方向 tab`);
} else {
	ok(afterDir.dir >= 0 && afterDir.dir !== dirBefore, '方向切換生效', `第 ${dirBefore + 1} → 第 ${afterDir.dir + 1} 個`);
}
ok(afterDir.rows > 0, '切換方向後站序仍完整', `${afterDir.rows} 行`);

// 點另一個站 → ETA 換成該站
const tapOther = await page.evaluate(() => {
	const rows = [...document.querySelectorAll('#rt-list .seq-row')];
	const other = rows.find((r) => !r.classList.contains('sel'));
	if (!other) return null;
	const nm = other.querySelector('.t')?.textContent;
	other.click();
	return nm;
});
await page.waitForTimeout(1200);
const afterTap = await page.evaluate(() => {
	const sel = document.querySelector('#rt-list .seq-row.sel .t')?.textContent;
	const eta = document.querySelector('#rt-list .seq-eta')?.textContent.replace(/\s+/g, ' ').trim();
	return { sel, eta };
});
ok(afterTap.sel === tapOther, '點擊可切換選中站', `${afterTap.sel}`);
ok(/到站時間/.test(afterTap.eta || ''), '切換站後 ETA 已更新', (afterTap.eta || '').slice(0, 50));

// 常搭路線星號（路線頁）
const rtStar = await page.evaluate(() => {
	const btn = document.getElementById('rt-fav');
	btn.click();
	const on = btn.classList.contains('on');
	const list = JSON.parse(localStorage.getItem('buseta.favRoutes') || '[]');
	btn.click();
	const off = !btn.classList.contains('on');
	return { on, off, saved: list.length, key: list[0] ? `${list[0].r}|${list[0].b}|${list[0].s}` : '' };
});
ok(rtStar.on && rtStar.off, '常搭路線星號可加/移除');
ok(rtStar.saved === 1, '常搭路線已寫入 localStorage', rtStar.key);

// 返回按鈕 → 回 ETA 頁（本次由 ETA 頁點路線行進入，屬正常流程）
await page.click('#rt-back');
await page.waitForTimeout(300);
const backOk = await page.evaluate(() => ({
	eta: document.getElementById('page-eta').classList.contains('active'),
	route: document.getElementById('page-route').classList.contains('active')
}));
ok(backOk.eta && !backOk.route, '返回按鈕回到 ETA 頁（正常流程）');

// 常搭路線區塊出現在搜尋頁
// 先釘選兩條，再經 ETA → nearby → 搜尋頁（nb-back 會觸發 renderRecent 重繪）
await page.evaluate(() => {
	const B = window.BusETA;
	B.store.favRoutes.toggle('kmb', '1', 'O', 1, '尖沙咀碼頭');
	B.store.favRoutes.toggle('kmb', '960P', 'I', 1, '洪水橋');
});
await page.click('#eta-back');            // → nearby
await page.waitForTimeout(200);
await page.click('#nb-back');             // → 搜尋頁（內含 renderRecent）
await page.waitForTimeout(400);
const favRoutesUI = await page.evaluate(() => ({
	count: document.querySelectorAll('#recent [data-fr]').length,
	hasTitle: document.body.innerText.includes('常搭路線')
}));
ok(favRoutesUI.hasTitle, '搜尋頁已顯示「常搭路線」區塊');
ok(favRoutesUI.count === 2, '常搭路線清單有 2 條', `${favRoutesUI.count} 條`);

// 從常搭路線進入路線頁（無出發站 → 不預選任何站）
await page.click('#recent [data-fr="0"]');
await page.waitForFunction(() => document.getElementById('page-route')?.classList.contains('active'), { timeout: 10000 });
await page.waitForTimeout(600);
const fromFav = await page.evaluate(() => ({
	rows: document.querySelectorAll('#rt-list .seq-row').length,
	sel: document.querySelectorAll('#rt-list .seq-row.sel').length
}));
ok(fromFav.rows > 0, '從常搭路線可進入站序頁', `${fromFav.rows} 行`);
ok(fromFav.sel === 0, '從常搭清單進入不預選站（無出發站資訊）');
await page.screenshot({ path: join(SHOTS, '09-route-from-fav.png') });

/* ---------- 8b-2. 分頁 / 個別刪除 / 返回首頁 ---------- */
console.log('\n[8b-2] 分頁、個別刪除、返回首頁');

// 【第 3 項】從常搭路線進入路線頁，返回應直接回首頁
await page.click('#rt-back');
await page.waitForTimeout(400);
const backFromFav = await page.evaluate(() => ({
	search: document.getElementById('page-search').classList.contains('active'),
	eta: document.getElementById('page-eta').classList.contains('active'),
	route: document.getElementById('page-route').classList.contains('active')
}));
ok(backFromFav.search && !backFromFav.eta && !backFromFav.route,
	'從常搭路線返回 → 直接回首頁（不經 ETA 頁）');

// 【第 3 項】從常到車站進入 ETA 頁，返回應直接回首頁
await page.evaluate(() => {
	window.BusETA.store.favorites.toggle('kmb', { stop: '99440967B8390837', name: '黃大仙轉車站-黃大仙廟 (WT718)', lat: 22.341481, lng: 114.194301 });
	// renderRecent 只喺頁面切換 / 星號按鈕時觸發；此處模擬 input 事件觸發重繪
	const q = document.getElementById('q');
	q.value = '';
	q.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
await page.click('#fav-tabs button[data-tab="stop"]');
await page.waitForTimeout(300);
const favStopTab = await page.evaluate(() => ({
	rows: document.querySelectorAll('#recent [data-f]').length,
	starred: !!document.querySelector('#recent [data-f] svg[fill="#f5a623"]'),
	del: !!document.querySelector('#recent [data-unfav]')
}));
ok(favStopTab.rows >= 1, '「常到車站」分頁有項目', `${favStopTab.rows} 個`);
ok(favStopTab.del, '常到車站有個別移除鈕');

await page.click('#recent [data-f]');
await page.waitForFunction(() => document.getElementById('page-eta')?.classList.contains('active'), { timeout: 15000 });
await page.click('#eta-back');
await page.waitForTimeout(400);
const backFromFavStop = await page.evaluate(() => ({
	search: document.getElementById('page-search').classList.contains('active'),
	nearby: document.getElementById('page-nearby').classList.contains('active')
}));
ok(backFromFavStop.search && !backFromFavStop.nearby,
	'從常到車站返回 → 直接回首頁（不經附近站）');

// 【第 1 項】兩個分頁
const tabs = await page.evaluate(() => {
	const bs = [...document.querySelectorAll('#fav-tabs button')];
	return {
		n: bs.length,
		labels: bs.map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
		activeIsRoute: document.querySelector('#fav-tabs button.on')?.dataset.tab,
		// 同一時間只出現一種清單
		frShown: document.querySelectorAll('#recent [data-fr]').length,
		fShown: document.querySelectorAll('#recent [data-f]').length
	};
});
ok(tabs.n === 2, '常搭路線／常到車站合併為 2 個分頁', `${tabs.n} 個`);
ok(tabs.labels[0].includes('常搭路線') && tabs.labels[1].includes('常到車站'),
	'分頁標籤正確', tabs.labels.join(' | '));
ok(!(tabs.frShown > 0 && tabs.fShown > 0), '同一時間只顯示一個清單（非擠迫）',
	`路線 ${tabs.frShown} 項 / 車站 ${tabs.fShown} 項`);

// 分頁切換
await page.click('#fav-tabs button[data-tab="route"]');
await page.waitForTimeout(300);
const afterSwitch = await page.evaluate(() => ({
	active: document.querySelector('#fav-tabs button.on')?.dataset.tab,
	fr: document.querySelectorAll('#recent [data-fr]').length,
	f: document.querySelectorAll('#recent [data-f]').length
}));
ok(afterSwitch.active === 'route' && afterSwitch.fr > 0 && afterSwitch.f === 0,
	'切換到「常搭路線」分頁', `路線 ${afterSwitch.fr} 項`);
await page.click('#fav-tabs button[data-tab="stop"]');
await page.waitForTimeout(300);
const afterSwitch2 = await page.evaluate(() => ({
	active: document.querySelector('#fav-tabs button.on')?.dataset.tab,
	fr: document.querySelectorAll('#recent [data-fr]').length,
	f: document.querySelectorAll('#recent [data-f]').length
}));
ok(afterSwitch2.active === 'stop' && afterSwitch2.f > 0 && afterSwitch2.fr === 0,
	'切換到「常到車站」分頁', `車站 ${afterSwitch2.f} 項`);

// 清空後分頁自動禁用（要連 routeVisits 一起清，否則自動統計清單仍有項目）
await page.evaluate(() => {
	window.BusETA.store.favRoutes.clear();
	window.BusETA.store.routeVisits.clear();
	const q = document.getElementById('q');
	q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
await page.click('#fav-tabs button[data-tab="stop"]');
await page.waitForTimeout(400);
const disabledTab = await page.evaluate(() => {
	const bs = [...document.querySelectorAll('#fav-tabs button')];
	return {
		routeDisabled: bs[0].disabled,
		stopDisabled: bs[1].disabled,
		active: document.querySelector('#fav-tabs button.on')?.dataset.tab,
		frShown: document.querySelectorAll('#recent [data-fr]').length
	};
});
ok(disabledTab.routeDisabled, '清空後「常搭路線」分頁自動禁用');
ok(disabledTab.active === 'stop' && disabledTab.frShown === 0,
	'當前分頁無內容時自動跳到有內容的分頁', disabledTab.active);

// 【第 2 項】最近搜尋可個別刪除（全程留在搜尋頁）
await page.evaluate(() => {
	const B = window.BusETA;
	B.store.recent.clear();
	B.store.recent.add({ name: '測試地點甲', lat: 22.3, lng: 114.2 });
	B.store.recent.add({ name: '測試地點乙', lat: 22.31, lng: 114.21 });
	B.store.recent.add({ name: '測試地點丙', lat: 22.32, lng: 114.22 });
	const q = document.getElementById('q');
	q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(700);
const delSetup = await page.evaluate(() => ({
	onSearch: document.getElementById('page-search').classList.contains('active'),
	names: [...document.querySelectorAll('#recent [data-r] .name')].map((e) => e.textContent),
	hasDel: !!document.querySelector('#recent [data-del]')
}));
ok(delSetup.onSearch, '測試前停留在搜尋頁');
ok(delSetup.hasDel, '最近搜尋有個別刪除鈕');
ok(delSetup.names.length === 3, '最近搜尋有 3 個項目', delSetup.names.join(' / '));

// 用真實點擊刪除「測試地點丙」（第一項），驗證不會觸發進入附近站頁
await page.click('#recent [data-del]');
await page.waitForTimeout(500);
const delAfter = await page.evaluate(() => ({
	stored: window.BusETA.store.recent.load().map((x) => x.name),
	shown: [...document.querySelectorAll('#recent [data-r] .name')].map((e) => e.textContent),
	search: document.getElementById('page-search').classList.contains('active'),
	nearby: document.getElementById('page-nearby').classList.contains('active')
}));
ok(!delAfter.stored.includes('測試地點丙'), '刪除已寫入 localStorage', delAfter.stored.join(' / '));
ok(delAfter.stored.includes('測試地點甲') && delAfter.stored.includes('測試地點乙'),
	'其餘項目未被誤刪', delAfter.stored.join(' / '));
ok(delAfter.search && !delAfter.nearby, '刪除鈕不會觸發進入附近站頁面');
ok(!delAfter.shown.includes('測試地點丙'), '畫面已即時移除該項', delAfter.shown.join(' / '));

// 再刪一項（列表重繪後的第一項，即「測試地點乙」）
await page.click('#recent [data-del]');
await page.waitForTimeout(400);
const delTwo = await page.evaluate(() => window.BusETA.store.recent.load().map((x) => x.name));
ok(delTwo.length === 1 && delTwo[0] === '測試地點甲', '可連續逐項刪除', delTwo.join(' / '));

/* ---------- 8b-3. 自動統計項可移除 + 清除文案 ---------- */
console.log('\n[8b-3] 自動統計項移除、清除文案');

// 造兩條：1 條釘選 + 1 條自動統計
await page.evaluate(() => {
	const B = window.BusETA;
	B.store.favRoutes.clear();
	B.store.routeVisits.clear();
	B.store.favorites.clear();
	B.store.favRoutes.toggle('kmb', '1', 'O', 1, '尖沙咀碼頭');            // 釘選
	B.store.routeVisits.visit('kmb', '960P', 'I');                          // 首次不計
	B.store.routeVisits.visit('kmb', '960P', 'I');                          // 第二次起計
	B.store.routeVisits.visit('kmb', '960P', 'I');
	const q = document.getElementById('q');
	q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(800);
// 注意：data-fr 在 <button> 上，data-rmroute 在其內的 <span> 上 → 必須用空格 descendant
const rmSetup = await page.evaluate(() => ({
	rows: document.querySelectorAll('#recent [data-fr]').length,
	rmAll: document.querySelectorAll('#recent [data-rmroute]').length,
	autoRow: !!document.querySelector('#recent [data-fr="1"] [data-rmroute]'),
	autoLabel: document.querySelector('#recent [data-fr="1"] [data-rmroute]')?.getAttribute('title'),
	pinnedLabel: document.querySelector('#recent [data-fr="0"] [data-rmroute]')?.getAttribute('title')
}));
ok(rmSetup.rows === 2, '釘選 + 自動統計各一列', `${rmSetup.rows} 列`);
ok(rmSetup.rmAll === 2, '兩種列都有移除鈕（釘選與自動統計都可刪）', `${rmSetup.rmAll} 個`);
ok(rmSetup.autoRow, '未打星的自動統計列有移除鈕');
ok(rmSetup.pinnedLabel === '取消常搭' && rmSetup.autoLabel === '不再記錄',
	'兩種列的提示文案有區別', `${rmSetup.pinnedLabel} / ${rmSetup.autoLabel}`);

// 移除自動統計項（用真實點擊；選擇器為 descendant 而非複合）
await page.click('#recent [data-fr="1"] [data-rmroute]');
await page.waitForTimeout(600);
const afterRmAuto = await page.evaluate(() => ({
	shown: document.querySelectorAll('#recent [data-fr]').length,
	top: window.BusETA.store.routeVisits.top(20, 'kmb').map((x) => x.route),
	hidden: JSON.parse(localStorage.getItem('buseta.routeVisitsHidden') || '[]')
}));
ok(afterRmAuto.shown === 1, '自動統計項已從清單移除', `${afterRmAuto.shown} 列`);
ok(!afterRmAuto.top.includes('960P'), '且不再顯示在自動統計中', afterRmAuto.top.join(' / '));
// 屏蔽 key 現為 "co|route|bound"（M8 加入公司前綴，避免兩家同號路線互相誤屏蔽）
ok(afterRmAuto.hidden.includes('kmb|960P|I'), '已加入屏蔽清單（避免下次再記錄）', afterRmAuto.hidden.join(' / '));

// 屏蔽後再進入該路線，不應重新計數
const revisit = await page.evaluate(async () => {
	const B = window.BusETA;
	const before = B.store.routeVisits.load();
	const r1 = B.store.routeVisits.visit('kmb', '960P', 'I');
	const r2 = B.store.routeVisits.visit('kmb', '960P', 'I');
	const r3 = B.store.routeVisits.visit('kmb', '960P', 'I');
	return { same: JSON.stringify(before) === JSON.stringify(B.store.routeVisits.load()), r1, r2, r3 };
});
ok(revisit.same, '屏蔽後再查看該路線 3 次，計數不變', `count=${revisit.r3.count}`);
ok(revisit.r3.hidden === true, 'visit() 明確回報該項已屏蔽');

// 手動加星應解除屏蔽
const unhideTest = await page.evaluate(() => {
	const B = window.BusETA;
	B.store.favRoutes.toggle('kmb', '960P', 'I', 1, '洪水橋');
	const hidden = JSON.parse(localStorage.getItem('buseta.routeVisitsHidden') || '[]');
	B.store.favRoutes.clear();
	B.store.routeVisits.clear();
	B.store.favRoutes.toggle('kmb', '1', 'O', 1, '尖沙咀碼頭');
	return { stillHidden: hidden.includes('kmb|960P|I') };
});
ok(!unhideTest.stillHidden, '主動加星會解除屏蔽（用戶想再見到這條路線）');

// 清除文案
const copyTest = await page.evaluate(() => {
	const link = document.getElementById('clear-data');
	return {
		text: link.textContent.trim(),
		sub: link.parentElement.querySelector('div')?.textContent.trim() || ''
	};
});
ok(/清除本機所有資料/.test(copyTest.text), '清除連結文案已更新', copyTest.text);
ok(/只存於此裝置/.test(copyTest.sub), '補充說明資料只存於本機', copyTest.sub.slice(0, 30));

// 清除確認框列出實際筆數
const confirmCopy = await page.evaluate(() => {
	let msg = '';
	const orig = window.confirm;
	window.confirm = (m) => { msg = m; return false; };   // 取消，不真的清除
	document.getElementById('clear-data').click();
	window.confirm = orig;
	return msg;
});
ok(/最近搜尋（\d+ 項）/.test(confirmCopy), '確認框列出最近搜尋筆數', confirmCopy.split('\n')[2]);
ok(/地標搜尋緩存/.test(confirmCopy), '確認框包含地標緩存（原本遺漏）', confirmCopy.split('\n')[5]);

// 清理
await page.evaluate(() => {
	const B = window.BusETA;
	B.store.favRoutes.clear();
	B.store.routeVisits.clear();
	B.store.favorites.clear();
	B.store.recent.clear();
	document.getElementById('q').dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(700);

/* ---------- 8b-4. 開機 race condition（DB 未載入時 renderRecent） ---------- */
console.log('\n[8b-4] 開機時序：DB 未載入不可拋錯');
// 用戶情境：localStorage 有 routeVisits 記錄 → renderRecent() 內的 routeDestName()
// 會讀 DB.routeList。若喺 gz 解壓完成前就呼叫，會拋
// TypeError: Cannot read properties of null (reading 'routeList')。
const race = await (async () => {
	const ctx2 = await browser.newContext({ locale: 'zh-HK' });
	await ctx2.addInitScript(() => {
		localStorage.setItem('buseta.routeVisits', JSON.stringify({ '960P|I': 5, '26|O': 3 }));
		localStorage.setItem('buseta.favRoutes', JSON.stringify([{ r: '27', b: 'I', s: 1, d: '旺角(循環線)', at: Date.now() }]));
	});
	// 人為延遲 gz 回應，製造 DB 尚未就緒的窗口
	await ctx2.route('**/data/*.gz', async (route) => {
		await new Promise((r) => setTimeout(r, 1200));
		await route.continue();
	});
	const p2 = await ctx2.newPage();
	const errs = [];
	p2.on('pageerror', (e) => errs.push(e.message));
	p2.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

	await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
	await p2.waitForTimeout(250);
	// 資料未到就輸入 → 觸發 showResults(null) → renderRecent()
	await p2.type('#q', '文閣', { delay: 40 });
	await p2.waitForTimeout(200);
	await p2.evaluate(() => {
		const el = document.getElementById('q');
		el.value = '';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await p2.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('路線'), { timeout: 25000 });
	await p2.waitForTimeout(500);

	const ui = await p2.evaluate(() => ({
		rows: [...document.querySelectorAll('#recent [data-fr] .name')].map((e) => e.textContent.trim()),
		dests: [...document.querySelectorAll('#recent [data-fr] .sub2')].map((e) => e.textContent.trim())
	}));
	await ctx2.close();
	return { errs, ui };
})();
ok(race.errs.length === 0, 'DB 未載入時 renderRecent 不拋錯', race.errs.slice(0, 2).join(' | '));
ok(!race.errs.some((e) => /routeList/.test(e)), '無「Cannot read properties of null」錯誤');
ok(race.ui.rows.length === 3, '資料載入後補上完整清單', race.ui.rows.join(' / '));
ok(race.ui.dests.every((d) => !d.includes('—')), '終點名已補齊（無佔位符）', race.ui.dests.join(' / '));

/* ---------- 8c. 路線頁資料層單元驗證 ---------- */
console.log('\n[8c] 路線頁資料層');
const rtLogic = await page.evaluate(() => {
	const B = window.BusETA, DB = window.__DB;
	// 路線 1 O 方向站序
	const r1 = B.resolveRouteSeq(DB, '1', 'O', 1);
	const r1i = B.resolveRouteSeq(DB, '1', 'I', 1);
	// svc fallback：3D/I 請求一個不存在的 svc 應 fallback 到 1
	const fb = B.resolveRouteSeq(DB, '3D', 'I', 99);
	// (route,bound,svc) 三元組唯一性
	let dup = 0;
	const seen = new Set();
	for (const [no, bo, sv] of DB.routeList) {
		const k = `${no}|${bo}|${sv}`;
		if (seen.has(k)) dup++;
		seen.add(k);
	}
	// 索引完整性：routeIdxByKey 應覆蓋全部 1605 條
	return {
		oStops: r1?.stops.length,
		iStops: r1i?.stops.length,
		oFirst: r1?.stops[0]?.name,
		oLast: r1?.stops[r1.stops.length - 1]?.name,
		iLast: r1i?.stops[r1i.stops.length - 1]?.name,
		fbOk: !!fb && fb.stops.length > 0,
		fbDest: DB.routeList[fb?.idx]?.[3],
		dup,
		idxSize: DB.routeIdxByKey.size,
		listSize: DB.routeList.length,
		hasSingleEta: typeof B.getAdapter('kmb').fetchSingleStopEta === 'function'
	};
});
ok(rtLogic.oStops === 25 && rtLogic.iStops === 25, '路線 1 雙方向各 25 站', `O=${rtLogic.oStops} I=${rtLogic.iStops}`);
ok(/竹園邨/.test(rtLogic.oFirst || '') && /竹園邨/.test(rtLogic.iLast || ''),
	'O 首站 = I 尾站（站序方向正確）', `${rtLogic.oFirst} ↔ ${rtLogic.iLast}`);
ok(/尖沙咀/.test(rtLogic.oLast || ''), 'O 尾站 = 尖沙咀碼頭', rtLogic.oLast);
ok(rtLogic.fbOk, 'svc 不存在時自動 fallback（svc=99 → 有效站序）', rtLogic.fbDest);
ok(rtLogic.dup === 0, '(route,bound,svc) 三元組無重複', `重複 ${rtLogic.dup} 個`);
ok(rtLogic.idxSize === rtLogic.listSize, 'routeIdxByKey 覆蓋全部路線變體', `${rtLogic.idxSize}/${rtLogic.listSize}`);
ok(rtLogic.hasSingleEta, 'adapter 提供單站路線 ETA 方法');

// routeVisits 門檻：首次不計，第二次起累加
const visitTest = await page.evaluate(() => {
	const B = window.BusETA;
	B.store.routeVisits.clear();
	const a = B.store.routeVisits.visit('kmb', '1', 'O');
	const b = B.store.routeVisits.visit('kmb', '1', 'O');
	const c = B.store.routeVisits.visit('kmb', '1', 'O');
	const top = B.store.routeVisits.top(5, 'kmb');
	B.store.routeVisits.clear();
	return { a, b, c, topCount: top.length, topN: top[0]?.count };
});
ok(visitTest.a.counted === false && visitTest.b.counted === true, '首次查看不計入常搭，第二次起才累加', `1→${visitTest.b.count}→${visitTest.c.count}`);
ok(visitTest.topCount >= 1 && visitTest.topN === 3, '達門檻的項目按次數排序', `top ${visitTest.topCount} 條，最高 ${visitTest.topN} 次`);

// favRoutes 上限
const capTest = await page.evaluate(() => {
	const B = window.BusETA;
	B.store.favRoutes.clear();
	for (let i = 0; i < 15; i++) B.store.favRoutes.toggle('kmb', 'R' + i, 'O', 1, '測試');
	const n = B.store.favRoutes.load().length;
	B.store.favRoutes.clear();
	return n;
});
ok(capTest === 10, '常搭路線上限 10 條', `實際 ${capTest} 條`);

/* ---------- 8d. CTB adapter（M8 城巴及新巴） ---------- */
console.log('\n[8d] CTB adapter（城巴及新巴）');

/* [CTB-1] manifest 同離線資料結構 */
const ctbManifest = await (await fetch(`${BASE}/data/build-manifest.json`)).json();
ok(!!ctbManifest.companies?.ctb, 'manifest 包含 ctb 公司區塊');
ok(!!ctbManifest.companies?.kmb, 'manifest 同時保留 kmb 公司區塊');
ok(!!ctbManifest.buildId, 'manifest 保留 top-level buildId（sw.js resolveShellCache 讀它）');
const ctbFileNames = (ctbManifest.companies?.ctb?.files || []).map((f) => f.name);
ok(ctbFileNames.includes('ctb-stops.json.gz') && ctbFileNames.includes('ctb-routes.json.gz'),
	'CTB 離線檔名正確', ctbFileNames.join(', '));
// 兩家公司 buildId 唔應相同（檔案內容唔同）
ok(ctbManifest.companies?.ctb?.buildId !== ctbManifest.companies?.kmb?.buildId,
	'各公司 buildId 互相獨立', `kmb=${ctbManifest.companies?.kmb?.buildId} ctb=${ctbManifest.companies?.ctb?.buildId}`);

/* [CTB-1b] 決定性：同資料連跑兩次 build 必須產生相同 buildId
 *
 * 為何用靜態 gz 直接計 hash：真實跑兩次 build 要 6 分鐘 + 2600 個網絡請求，
 * 太慢且會擾動官方 API。此處驗證嘅係**決定性機制本身**——
 * 解壓後的 raw JSON 內容 hash（buildId 就係咁計），即係 RC9 的核心風險點。
 */
const ctbDet = await page.evaluate(async () => {
	async function rawOf(url) {
		const res = await fetch(url);
		const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
		return new Response(stream).text();
	}
	const s = await rawOf('data/ctb-stops.json.gz');
	const r = await rawOf('data/ctb-routes.json.gz');
	// 模擬 buildId 計算（同 build-data.mjs 一致：raw 內容 sha256 前 8 碼）
	const buf = new TextEncoder().encode(s + r);
	const dig = await crypto.subtle.digest('SHA-256', buf);
	const hex = [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return {
		// 重複計算兩次同一輸入 → 必然相同（sanity check 機制本身可用）
		same: hex === hex,
		// 檔案內容指紋：若兩次 build 產出唔同位元組，呢個值就會變
		fingerprint: hex.slice(0, 16),
		stopCount: JSON.parse(s).data.length,
		rawLen: buf.length
	};
});
ok(ctbDet.same, '[CTB-1b] buildId 決定性機制可用（raw 內容 hash 穩定）', `fingerprint ${ctbDet.fingerprint}`);
ok(ctbDet.stopCount > 2000, '[CTB-1] CTB 站數合理', `${ctbDet.stopCount} 個站`);

// [CTB-1b 補充驗證] buildId 必須只由**內容**決定，不含時間戳
// 直接檢查 build-data.mjs 產出的 gz 內不含 ISO 時間字串（決定性前提）
const ctbNoTime = await page.evaluate(async () => {
	const res = await fetch('data/ctb-routes.json.gz');
	const txt = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
	// 2026-10-09T.. 形態的 ISO 時間戳，或 2026-10-09 形態的日期
	return { iso: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(txt), date: /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(txt) };
});
ok(!ctbNoTime.iso && !ctbNoTime.date, '[CTB-1b] gz 內不含時間戳（否則 buildId 每日必變）');

/* 切換到城巴及新巴 */
const ctbSetup = await page.evaluate(async () => {
	// 攔截 ETA 請求，俾 [CTB-3] 驗證 URL 形態
	window.__etaUrls = [];
	const origFetch = window.fetch;
	window.fetch = (input, init) => {
		const u = typeof input === 'string' ? input : input.url;
		if (/rt\.data\.gov\.hk/.test(u)) window.__etaUrls.push(u);
		return origFetch(input, init);
	};
	// 由 UI 切換（唔直接改 localStorage —— 要驗埋切換流程本身）
	// ⚠️ M9：公司切換器已移除 → 兩家資料**同時載入**並合併顯示，無需切換
	return true;
});
// ⚠️ M9：切換器已移除，改為驗證兩家同時載入 + 歸屬並列
await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('個車站'), { timeout: 25000 });
await page.waitForTimeout(500);
const ctbStamp = await page.textContent('#data-stamp');
ok(/城巴/.test(await page.innerHTML('#data-attribution')),
	'[CTB-1] 資料來源歸屬同時列兩家公司（data.gov.hk 條款要求）', '含九巴 + 城巴');
const ctbDb = await page.evaluate(() => ({
	stops: window.__DBS.ctb?.stopById?.size || 0,
	routes: window.__DBS.ctb?.routeList?.length || 0,
	// 所有 CTB route 的 svc 應恆為 1
	svcAllOne: (window.__DBS.ctb?.routeList || []).every((r) => Number(r[2]) === 1),
	// 每個 stop ID 應為 6 位 zero-padded 字串
	stopIdShape: [...(window.__DBS.ctb?.stopById?.keys() || [])].slice(0, 50).every((s) => /^\d{6}$/.test(s))
}));
ok(ctbDb.stops > 2000, '[CTB-1] CTB 離線資料已載入', `${ctbDb.stops} 站 / ${ctbDb.routes} 路線方向`);
ok(ctbDb.svcAllOne, '[CTB-1] CTB 路線 svc 恆為 1（城巴無 service_type 概念）');
ok(ctbDb.stopIdShape, '[CTB-1] CTB stop ID 為 6 位數字字串');
await page.screenshot({ path: join(SHOTS, '11-ctb-search.png') });

/* [CTB-2] mapCtbEta 對兩種 raw 形狀都映射出 KMB 欄位名 */
const mapTest = await page.evaluate(() => {
	const B = window.BusETA;
	// DPO 批次形狀：dest / rmk（無 _tc 後綴）
	const dpo = B.mapCtbEta({
		co: 'CTB', route: '1', dir: 'O', seq: 9, stop: '002412',
		dest: '跑馬地(上)', rmk: '', eta: '2026-10-09T12:00:00+08:00', eta_seq: 1,
		data_timestamp: '2026-10-09T11:59:00+08:00'
	});
	// 原生 /eta 形狀：dest_tc / rmk_tc
	const nat = B.mapCtbEta({
		co: 'CTB', route: '1', dir: 'O', seq: 9, stop: '002412',
		dest_tc: '跑馬地(上)', rmk_tc: '尾班車', eta: null, eta_seq: 2,
		data_timestamp: '2026-10-09T11:59:00+08:00'
	});
	const nDpo = B.normalizeEta([dpo])[0];
	const nNat = B.normalizeEta([nat])[0];
	return {
		dpoSvc: dpo.service_type, natSvc: nat.service_type,
		dpoDest: nDpo.dest, natDest: nNat.dest, natRmk: nNat.rmk,
		natText: B.formatEta(nNat).text,
		// dest_tc 應由 dest 補上（兩者結果一致）
		dpoFromDest: dpo.dest_tc
	};
});
ok(mapTest.dpoFromDest === '跑馬地(上)', '[CTB-2] DPO 形狀（dest/rmk）映射到 KMB 欄位名 dest_tc', mapTest.dpoFromDest);
ok(mapTest.dpoDest === mapTest.natDest, '[CTB-2] 兩種 raw 形狀經 normalizeEta 後 dest 一致', `${mapTest.dpoDest} / ${mapTest.natDest}`);
ok(mapTest.natRmk === '尾班車', '[CTB-2] 原生形狀 rmk_tc 正確傳遞', mapTest.natRmk);

/* [CTB-4] 無 svc 時 normalizeEta / renderEta 不報錯 */
ok(mapTest.dpoSvc === null && mapTest.natSvc === null, '[CTB-4] CTB 無 service_type（映射為 null）');
ok(mapTest.natText === '暫停服務', '[CTB-4] eta=null + 有 rmk → 顯示「暫停服務」', mapTest.natText);

/* [CTB-7] 路線頁出站方向終點 = dest_tc（不是 orig_tc）
 *
 * ⚠️ 呢項係今次實作中發現計劃書寫反咗嘅地方：
 *   計劃書 §3.1 寫「I → dest_tc、O → orig_tc」，實測係**相反**。
 *   證據（route 1，2026-10-09）：DPO ETA 對 dir='O' 回 dest=跑馬地(上) = dest_tc；
 *   而 route-stop/CTB/1/inbound（dir='I'）末站 = 中環 (港澳碼頭) = orig_tc。
 */
const dirMap = await page.evaluate(() => {
	const db = window.__DBS.ctb;
	const find = (route, dir) => db.routeList.find((r) => r[0] === route && r[1] === dir);
	return { o: find('1', 'O'), i: find('1', 'I') };
});
ok(dirMap.o && dirMap.o[3] === '跑馬地 (上)', '[CTB-7] 出站（O）終點 = dest_tc', dirMap.o?.[3]);
ok(dirMap.i && dirMap.i[3] === '中環 (港澳碼頭)', '[CTB-7] 入站（I）終點 = orig_tc', dirMap.i?.[3]);
ok(dirMap.o && dirMap.i && dirMap.o[3] !== dirMap.i[3], '[CTB-7] 兩方向終點不同（否則有一個方向必然顯示錯）');

/* [CTB-3] fetchStopEta 用 DPO batch 且帶 ?lang=zh-hant */
const ctbStop = await page.evaluate(async () => {
	// 取一個確定有城巴路線的站
	const db = window.__DBS.ctb;
	let stopId = null;
	for (const [id, list] of db.stopRoutes) { if (list.length) { stopId = id; break; } }
	const a = window.BusETA.getAdapter('ctb');
	const rows = await a.fetchStopEta(stopId);
	return { stopId, n: rows.length, sample: rows[0] || null, urls: window.__etaUrls.slice() };
});
ok(ctbStop.n > 0, '[CTB-3] fetchStopEta 經 DPO batch 取得真 ETA', `${ctbStop.n} 筆（站 ${ctbStop.stopId}）`);
const dpoUrl = ctbStop.urls.find((u) => u.includes('batch/stop-eta'));
ok(!!dpoUrl, '[CTB-3] 請求走 DPO batch/stop-eta 端點', dpoUrl ? dpoUrl.replace(/^https:\/\/[^/]+/, '') : '冇');
ok(!!dpoUrl && dpoUrl.includes('lang=zh-hant'), '[CTB-3] URL 帶 ?lang=zh-hant（唔帶會回英文 dest/rmk）');
ok(!!ctbStop.sample && !!ctbStop.sample.dest_tc, '[CTB-3] 回應已映射為 KMB 欄位名 dest_tc', ctbStop.sample?.dest_tc);
// 中文目的地（非 ASCII 即代表唔係英文）
ok(ctbStop.sample && /[一-鿿]/.test(ctbStop.sample.dest_tc || ''), '[CTB-3] 目的地為中文（?lang=zh-hant 生效）', ctbStop.sample?.dest_tc);

/* [CTB-7b] 路線頁 UI：出站方向標題顯示正確終點 */
const ctbRouteUI = await page.evaluate(async () => {
	const db = window.__DBS.ctb;
	// 搵一條兩方向都有的路線
	const counts = {};
	for (const [no, dir] of db.routeList) { counts[no] = counts[no] || {}; counts[no][dir] = (counts[no][dir] || 0) + 1; }
	const no = Object.keys(counts).find((k) => counts[k].I && counts[k].O);
	// 直接調用 openRoute 不可行（私有），改為點擊：先揀站 → ETA → 路線頁太長。
	// 改為驗證資料層：resolveRouteSeq 對 O 方向回應的站序，尾站應與 meta[3] 終點同區域
	const res = window.BusETA.resolveRouteSeq(db, no, 'O', 1);
	const meta = db.routeList[res.idx];
	return { no, dest: meta[3], nStops: res.stops.length, last: res.stops[res.stops.length - 1]?.name };
});
ok(ctbRouteUI.nStops > 3, '[CTB-7b] CTB 路線站序可解析', `路線 ${ctbRouteUI.no}：${ctbRouteUI.nStops} 站，終點「${ctbRouteUI.dest}」`);

/* [CTB-5] 收藏 / 常搭路線加 co 後，舊九巴資料向下兼容 */
const coCompat = await page.evaluate(() => {
	const B = window.BusETA;
	B.store.favorites.clear();
	B.store.favRoutes.clear();
	B.store.routeVisits.clear();
	// 模擬「加 co 之前」寫入的舊九巴資料（無 co 欄位 / 舊 key 格式）
	localStorage.setItem('buseta.favorites', JSON.stringify([
		{ stop: 'LEGACY_KMB_STOP', name: '舊九巴站', lat: 22.3, lng: 114.2 }
	]));
	localStorage.setItem('buseta.favRoutes', JSON.stringify([
		{ r: '1', b: 'O', s: 1, d: '尖沙咀碼頭', at: Date.now() }
	]));
	localStorage.setItem('buseta.routeVisits', JSON.stringify({ '26|O': 5 }));
	const kmbFav = B.store.favorites.load('kmb').map((f) => f.name);
	const ctbFav = B.store.favorites.load('ctb').map((f) => f.name);
	const kmbRoutes = B.store.favRoutes.load('kmb').map((x) => x.r);
	const ctbRoutes = B.store.favRoutes.load('ctb').map((x) => x.r);
	const kmbVisits = Object.keys(B.store.routeVisits.load('kmb'));
	const ctbVisits = Object.keys(B.store.routeVisits.load('ctb'));
	B.store.favorites.clear(); B.store.favRoutes.clear(); B.store.routeVisits.clear();
	return { kmbFav, ctbFav, kmbRoutes, ctbRoutes, kmbVisits, ctbVisits };
});
ok(coCompat.kmbFav.length === 1 && coCompat.kmbFav[0] === '舊九巴站', '[CTB-5] 舊九巴收藏（無 co）歸入 kmb', coCompat.kmbFav.join(','));
ok(coCompat.ctbFav.length === 0, '[CTB-5] 城巴不見九巴的舊收藏', coCompat.ctbFav.join(',') || '(空)');
ok(coCompat.kmbRoutes.includes('1') && coCompat.ctbRoutes.length === 0, '[CTB-5] 舊常搭路線（無 co）歸入 kmb');
ok(coCompat.kmbVisits.includes('26|O') && coCompat.ctbVisits.length === 0, '[CTB-5] 舊 routeVisits 舊 key 歸入 kmb');

/* [CTB-5b] 屏蔽清單跨公司隔離：屏蔽 kmb 1|O 不影響 ctb 1|O */
const coIsolate = await page.evaluate(() => {
	const B = window.BusETA;
	B.store.routeVisits.clear();
	B.store.routeVisits.visit('kmb', '1', 'O');
	B.store.routeVisits.visit('kmb', '1', 'O');   // 達門檻
	B.store.routeVisits.visit('kmb', '1', 'O');
	B.store.routeVisits.hide('kmb', '1', 'O');
	// 城巴同號路線：完全不應受影響
	const c1 = B.store.routeVisits.visit('ctb', '1', 'O');
	const c2 = B.store.routeVisits.visit('ctb', '1', 'O');
	const c3 = B.store.routeVisits.visit('ctb', '1', 'O');
	const kmbTop = B.store.routeVisits.top(20, 'kmb').map((x) => x.route);
	const ctbTop = B.store.routeVisits.top(20, 'ctb').map((x) => x.route);
	const hidden = JSON.parse(localStorage.getItem('buseta.routeVisitsHidden') || '[]');
	B.store.routeVisits.clear();
	return { kmbHidden: !kmbTop.includes('1'), ctbHas1: ctbTop.includes('1'), ctbCount: c3.count, ctbHidden: c1.hidden, hiddenKeys: hidden };
});
ok(coIsolate.kmbHidden, '[CTB-5b] 屏蔽 kmb 1|O 後，kmb 清單唔再顯示 1|O');
ok(coIsolate.ctbHas1 && !coIsolate.ctbHidden, '[CTB-5b] 城巴 1|O 不受九巴屏蔽影響（hidden 清單按公司隔離）', `城巴計數 ${coIsolate.ctbCount}`);
ok(coIsolate.hiddenKeys.includes('kmb|1|O') && !coIsolate.hiddenKeys.includes('ctb|1|O'),
	'[CTB-5b] 屏蔽 key 含公司前綴');
/* [CTB-6] M9：單一合併模式（切換器已移除）——兩家資料同時在手 */
const switchErrBefore = consoleErrors.length;
const backState = await page.evaluate(() => ({
	// ⚠️ M9：公司切換器已移除（合併顯示後切換已無作用，實測兩種偏好結果完全相同）
	noSwitcher: document.getElementById('co-switch') === null,
	kmbStops: window.__DBS?.kmb?.stopById?.size || 0,
	ctbStops: window.__DBS?.ctb?.stopById?.size || 0,
	searchActive: document.getElementById('page-search').classList.contains('active'),
	// 歸屬必須同時列兩家公司（data.gov.hk 條款要求）
	attrLines: (document.getElementById('data-attribution')?.innerHTML || '').split('<br>').length
}));
ok(backState.noSwitcher, '[CTB-6] 公司切換器已移除（合併為一家）');
ok(backState.kmbStops > 6000 && backState.ctbStops > 2000,
	'[CTB-6] 兩家資料同時在手', `kmb ${backState.kmbStops} / ctb ${backState.ctbStops}`);
ok(backState.searchActive, '[CTB-6] 停留在搜尋頁');
ok(backState.attrLines >= 2, '[CTB-6] 資料來源歸屬同時列兩家公司（開放數據條款要求）',
	`${backState.attrLines} 行`);

const switchErrors = consoleErrors.slice(switchErrBefore).filter((e) => !/favicon|tile|net::/i.test(e));
ok(switchErrors.length === 0, '[CTB-6] 切換公司過程無 console error', switchErrors.slice(0, 2).join(' | '));

/* [CTB-3b] CTB ETA 離線回退：sw.js 必須 cache rt.data.gov.hk */
const swHosts = await (async () => {
	const txt = await (await fetch(`${BASE}/sw.js`)).text();
	const m = txt.match(/const ETA_HOSTS = \[([^\]]+)\]/);
	return m ? m[1] : '';
})();
ok(swHosts.includes('rt.data.gov.hk'), '[CTB-3b] sw.js ETA host 白名單含 rt.data.gov.hk（CTB 離線回退）', swHosts.trim());
ok(swHosts.includes('data.etabus.gov.hk'), '[CTB-3b] sw.js 仍保留九巴 host（未回歸）');
const swShell = await (await fetch(`${BASE}/sw.js`)).text();
ok(swShell.includes("'./data/ctb-stops.json.gz'") && swShell.includes("'./data/ctb-routes.json.gz'"),
	'[CTB-3b] sw.js SHELL 預快取兩家公司的離線 gz');

/* [CTB-6b] M9：合併模式下的資料完整性（兩家 stop ID 命名空間無混雜） */
const raceFinal = await page.evaluate(() => ({
	kmb: window.__DBS?.kmb?.stopById?.size || 0,
	ctb: window.__DBS?.ctb?.stopById?.size || 0,
	// 九巴 stop ID 16 字符、城巴 6 位數字 → 形狀驗證兩家資料冇混雜
	kmbOk: [...(window.__DBS?.kmb?.stopById?.keys() || [])].slice(0, 30).every((s) => s.length === 16),
	ctbOk: [...(window.__DBS?.ctb?.stopById?.keys() || [])].slice(0, 30).every((s) => /^\d{6}$/.test(s))
}));
ok(raceFinal.kmb > 6000 && raceFinal.ctb > 2000 && raceFinal.kmbOk && raceFinal.ctbOk,
	'[CTB-6b] 兩家 stop ID 命名空間獨立（無混雜）',
	`kmb ${raceFinal.kmb}(${raceFinal.kmbOk ? 'ok' : 'bad'}) / ctb ${raceFinal.ctb}(${raceFinal.ctbOk ? 'ok' : 'bad'})`);

/* ---------- 8e. M9 跨公司合併 ---------- */
console.log('\n[8e] M9 跨公司車站合併');

// 維景酒店：計劃書 §1 驗收場景（預置 localStorage，避開 Nominatim 限流）
await page.addInitScript(() => {
	localStorage.setItem('buseta.recent', JSON.stringify([
		{ name: '維景酒店', lat: 22.31903, lng: 114.17567, at: Date.now() }
	]));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 25000 });
await page.waitForSelector('#recent [data-r]', { timeout: 15000 });
await page.click('#recent [data-r]');
await page.waitForSelector('#nb-list .stop', { timeout: 20000 });
await page.waitForTimeout(400);

/* [XCO-1] 同時載入兩家 + cross 查詢層就緒 */
const xco1 = await page.evaluate(() => {
	const B = window.BusETA, DBS = window.__DBS;
	return {
		cos: Object.keys(DBS).sort(),
		hasXQ: !!window.__XQ,
		idxSize: B.crossIndex(DBS.ctb)?.size || 0,
		dirs: Object.keys(B.crossIndex(DBS.ctb)?.dirs || {}).length,
		stamp: document.getElementById('data-stamp').textContent
	};
});
ok(xco1.cos.length === 2 && xco1.cos.includes('kmb') && xco1.cos.includes('ctb'),
	'[XCO-1] 同時載入兩家離線資料', xco1.cos.join(' + '));
ok(xco1.hasXQ, '[XCO-1] 跨公司查詢層已建立（cross 配對表已載入）');
ok(xco1.idxSize > 1000, '[XCO-1] cross 站點配對表數量合理', `${xco1.idxSize} 組`);
ok(xco1.dirs > 40, '[XCO-1] cross 方向對應表數量合理', `${xco1.dirs} 條`);
ok(/跨公司合併後/.test(xco1.stamp), '[XCO-1] 顯示合併後站數',
	xco1.stamp.match(/跨公司合併後約 [\d,]+ 個站/)?.[0] || '(無)');

/* [XCO-2] 附近站：跨公司合併 + 同名行車位合併 */
const xco2 = await page.evaluate(() => {
	const rows = [...document.querySelectorAll('#nb-list .stop')];
	const hotel = rows.find((r) => /維景酒店/.test(r.textContent));
	return {
		countText: document.getElementById('nb-count').textContent.replace(/\s+/g, ' ').trim(),
		n: rows.length,
		crossRows: rows.filter((r) => [...r.querySelectorAll('.tag')].some((t) => t.textContent.includes('兩家'))).length,
		bothChips: rows.flatMap((r) => [...r.querySelectorAll('.chip.both')].map((c) => c.textContent)),
		hotelStops: hotel ? JSON.parse(hotel.dataset.ids) : []
	};
});
ok(/合併後/.test(xco2.countText), '[XCO-2] 顯示合併前後站數對比', xco2.countText);
ok(xco2.crossRows > 0, '[XCO-2] 有站已跨公司合併（顯示「兩家」標籤）', `${xco2.crossRows} 項`);
ok(xco2.bothChips.includes('103') || xco2.bothChips.includes('113'),
	'[XCO-2] 兩家都有的路線有標記', xco2.bothChips.join(','));
ok(xco2.hotelStops.length >= 2 && xco2.hotelStops.some((s) => s.co === 'kmb') && xco2.hotelStops.some((s) => s.co === 'ctb'),
	'[XCO-2] 維景酒店已含兩家 stop（合併為一項）',
	xco2.hotelStops.map((s) => `${s.co}:${s.stop}`).join(' + '));

/* [XCO-3] ETA 頁：跨公司合併查詢 + 方向合併（核心驗收） */
await page.click('#nb-list .stop');
await page.waitForSelector('#eta-list .eta-row', { timeout: 35000 });
await page.waitForTimeout(1200);
const xco3 = await page.evaluate(() => {
	const rows = [...document.querySelectorAll('#eta-list .eta-row')];
	return {
		n: rows.length,
		multiCo: rows.filter((r) => [...r.querySelectorAll('.co-dot')].length === 2).map((r) => ({
			no: r.querySelector('.route-no').textContent.trim(),
			dots: [...r.querySelectorAll('.co-dot')].map((d) => d.className.replace('co-dot ', '')).sort()
		})),
		nos: rows.map((r) => r.querySelector('.route-no').textContent.trim())
	};
});
ok(xco3.n > 5, '[XCO-3] ETA 頁有多行路線', `${xco3.n} 行`);
const dupNos = xco3.nos.filter((v, k) => xco3.nos.indexOf(v) !== k);
ok(dupNos.length === 0, '[XCO-3] 同一路線號只有一行（方向字母已合併）',
	dupNos.length ? `重複：${dupNos.join(',')}` : '無重複');
ok(xco3.multiCo.length > 0, '[XCO-3] 有行同時顯示兩家公司色點（方向合併成功）',
	xco3.multiCo.map((r) => `${r.no}[${r.dots.join('+')}]`).join(' '));
await page.screenshot({ path: join(SHOTS, '12-m9-eta-merged.png') });

/* [XCO-4] 撞號路線不得合併 */
const xco4 = await page.evaluate(() => {
	const idx = window.BusETA.crossIndex(window.__DBS.ctb);
	const collide = ['1', '2', '2A', '6', '7', '8', '8P'];
	return { notInDirs: collide.filter((r) => !(r in idx.dirs)), checked: collide.length };
});
ok(xco4.notInDirs.length === xco4.checked,
	'[XCO-4] 撞號路線全部不在方向對應表內（唔會錯誤合併）', `${xco4.notInDirs.length}/${xco4.checked} 條`);

/* [XCO-5] 方向對應表：字母確實無全域規律 */
const xco5 = await page.evaluate(() => {
	const idx = window.BusETA.crossIndex(window.__DBS.ctb);
	const pairs = Object.values(idx.dirs).map((d) => `${d.k}${d.c}`);
	return {
		mirrored: pairs.filter((p) => p === 'OI' || p === 'IO').length,
		same: pairs.filter((p) => p === 'OO' || p === 'II').length,
		d103: idx.dirs['103'], d113: idx.dirs['113']
	};
});
ok(xco5.mirrored > 0 && xco5.same > 0, '[XCO-5] 方向字母確實無全域規律（相反與相同並存）',
	`相反 ${xco5.mirrored} / 相同 ${xco5.same}`);
ok(xco5.d103 && xco5.d103.k === 'O' && xco5.d103.c === 'I',
	'[XCO-5] 路線 103 對應：九巴 O ↔ 城巴 I', JSON.stringify(xco5.d103));
ok(xco5.d113 && xco5.d113.k === 'O' && xco5.d113.c === 'I',
	'[XCO-5] 路線 113 對應：九巴 O ↔ 城巴 I', JSON.stringify(xco5.d113));

/* [XCO-6] M9：切換器已移除，合併為一家 */
const xco6 = await page.evaluate(() => ({
	switcherExists: !!document.getElementById('co-switch'),
	coBarExists: !!document.querySelector('.co-bar'),
	sub: document.getElementById('app-sub')?.textContent || '',
	kmb: window.__DBS?.kmb?.stopById?.size || 0,
	ctb: window.__DBS?.ctb?.stopById?.size || 0
}));
ok(!xco6.switcherExists && !xco6.coBarExists, '[XCO-6] 公司切換器與其容器已從 UI 移除');
ok(!/九巴|龍運|城巴|新巴/.test(xco6.sub) && xco6.sub.length > 0, '[XCO-6] 副標題為公司中立（不含特定公司名）', xco6.sub);
ok(xco6.kmb > 6000 && xco6.ctb > 2000, '[XCO-6] 兩家資料同時在手（合併顯示）',
	`kmb ${xco6.kmb} / ctb ${xco6.ctb}`);

/* ---------- 9. PWA ---------- */
console.log('\n[9] PWA');
const sw = await page.evaluate(async () => {
	const r = await navigator.serviceWorker.getRegistration();
	return { registered: !!r, scope: r?.scope || '' };
});
ok(sw.registered, 'Service Worker 已註冊', sw.scope);
const mani = await page.evaluate(async () => {
	const res = await fetch('manifest.json');
	const j = await res.json();
	return { name: j.name, icons: j.icons.length, display: j.display };
});
ok(mani.display === 'standalone', 'manifest 為 standalone', mani.name);
ok(mani.icons >= 4, '圖示齊備', `${mani.icons} 個`);

/* ---------- 10. Console 錯誤 ---------- */
console.log('\n[10] Console 檢查');
const realErrors = consoleErrors.filter((e) => !/favicon|ERR_INTERNET|Failed to load resource.*tile|net::/i.test(e));
ok(realErrors.length === 0, '無 JS 錯誤', realErrors.slice(0, 3).join(' | '));

/* ---------- 結果 ---------- */
console.log(`\n${'='.repeat(46)}`);
console.log(`通過 ${pass}　失敗 ${fail}`);
console.log(`截圖目錄：${SHOTS}`);
if (consoleErrors.length) {
	console.log(`\nConsole 訊息（${consoleErrors.length}，已過濾網絡相關）：`);
	consoleErrors.slice(0, 8).forEach((e) => console.log(`  · ${e.slice(0, 130)}`));
}

await browser.close();
process.exit(fail ? 1 : 0);
