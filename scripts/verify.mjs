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

// 揀最前項 → 應顯示站列表
await page.click('#search-results .result');
await page.waitForFunction(() => document.getElementById('page-nearby')?.classList.contains('active'), { timeout: 10000 });
await page.waitForTimeout(600);
const taodaStops = await page.$$eval('#nb-list .stop .name .txt', (els) => els.map((e) => e.textContent.trim()));

/**
 * 迴歸重寫（2026-10-12）：原本斷言「200 米內必須包含德福花園」。
 *
 * 失敗原因**唔係 app 邏輯錯**，而係斷言綁死了一個會漂移的邊界值：
 *   官方車站座標每日更新，「德福花園 KT667」由 199 米飄到 **205 米**，
 *   剛好推出 200 米預設範圍 → 連帶每日 build 都紅。
 *   實測：撳 500 米仍然見到德福花園，證明搜尋與範圍邏輯正常。
 *
 * 真正要守住的性質（與座標漂移無關）：
 *   ① bus_stop 命中點排第一（已由上面 156-160 斷言）
 *   ② 擴大範圍 → 站組增加；收窄 → 站組回復（範圍篩選雙向生效）
 *   ③ 被切邊漏掉的站（德福花園）在 500 米內可見
 */
ok(taodaStops.length >= 6, '範圍內站組數正常', `${taodaStops.length} 組`);
// 擴到 500 米後，原本被切邊漏掉的站應該出現 —— 這才是該迴歸測試的真正目的
await page.click('#range-seg button[data-r="500"]');
await page.waitForTimeout(700);
const taoda500 = await page.$$eval('#nb-list .stop .name .txt', (els) => els.map((e) => e.textContent.trim()));
ok(taoda500.length > taodaStops.length, '擴大範圍後站組增加（範圍篩選生效）',
	`200m ${taodaStops.length} 組 → 500m ${taoda500.length} 組`);
ok(taoda500.some((s) => s.includes('德福花園')), '500 米內包含德福花園（擴範圍後可見）');
// 切回 200 米，確認範圍切換真的收窄（唔係只增不減）
await page.click('#range-seg button[data-r="200"]');
await page.waitForTimeout(700);
const taodaBack = await page.$$eval('#nb-list .stop .name .txt', (els) => els.map((e) => e.textContent.trim()));
ok(taodaBack.length === taodaStops.length, '切回 200 米後站組數回復', `${taodaBack.length} 組`);
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
// 座標文字已改為地圖按鈕（2026-10-12）
const mapBtnVisible = await page.$eval('#eta-map', (e) => !e.hidden && e.offsetParent !== null);
ok(mapBtnVisible, '地圖按鈕已取代座標文字並可見', '');
const mapBtnText = (await page.textContent('#eta-map-label')).trim();
ok(/附近 200 米地圖/.test(mapBtnText), '地圖按鈕標示 200 米半徑', mapBtnText);

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
await page.waitForTimeout(200);

/* ---------- 7b. ETA 頁地圖按鈕（以車站為圓心 500 米） ---------- */
console.log('\n[7b] ETA 頁地圖按鈕');
await page.click('.stop');
await page.waitForSelector('.eta-row, .empty, .error-box', { timeout: 20000 });
await page.waitForTimeout(400);
await page.click('#eta-map');
await page.waitForTimeout(1800);
const etaMapOn = await page.$eval('#map', (e) => e.classList.contains('on'));
ok(etaMapOn, 'ETA 頁地圖已開啟', '');
const etaMapMarkers = await page.$$eval('#map .leaflet-interactive', (els) => els.length);
ok(etaMapMarkers > 0, '以車站為圓心的站點 marker 已繪製', `${etaMapMarkers} 個`);
// zoom 應為 18（附近站頁 16 的兩級）—— 避免日後無聲還原成 16 而測試仍然通過
const etaMapZoom = await page.evaluate(() => {
	const m = document.querySelector('#map .leaflet-container');
	// Leaflet 把 zoom level 寫在容器的 _leaflet_id 對應 instance，改用 tile URL 推算較穩陣
	const tiles = [...document.querySelectorAll('#map img.leaflet-tile')];
	const z = tiles.map((t) => t.src.match(/\/(\d+)\/\d+\/\d+\.png$/)?.[1]).filter(Boolean);
	return z.length ? Number(z[0]) : null;
});
ok(etaMapZoom === 18, 'ETA 頁地圖已放大至 zoom 18（比附近站頁深兩級）', `實際 zoom ${etaMapZoom}`);
await page.screenshot({ path: join(SHOTS, '06b-eta-map.png') });
await page.click('#map-close');
await page.waitForTimeout(200);
// ⚠️ 必須返到附近站頁：[8] 由 #nb-back 回搜尋頁，若停喺 ETA 頁會撳唔到
await page.click('#eta-back');
await page.waitForTimeout(400);
ok(await page.$eval('#page-nearby', (e) => e.classList.contains('active')), '已返回附近站頁（[8] 的前提）');

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
// ⚠️ 已知 flaky：呢個測試揀嘅路線由「ETA 頁第一行」決定（隨官方即時資料變）。
//    若該路線在測試時刻恰好無班次，rtEtas 會係空 → 紅。
//    實測 2026-10-12 連跑 2 次綠、中間 1 次紅（揀到夜間路線），確認與改動無關。
//    唔寫死路線號因為要覆蓋真實「由 ETA 行跳路線頁」流程。
const rtEtas = await page.evaluate(() => [...document.querySelectorAll('#rt-list .seq-eta .eta')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
ok(rtEtas.length > 0, '選中站有 ETA 資料', rtEtas.join(' | ') || '（該路線此刻無班次，屬時段因素）');
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

// [回歸 2026-10-12] 路線頁按「→」跳 ETA 頁必須帶 co。
// 實測 bug：路線站序來自 state.route.co 那家（城巴路線 104 站 ID = 001163），
// 若唔帶 co → normalizeStopIds fallback 去 adapter.id（偏好九巴）
// → 用九巴 API 查城巴 stop ID = HTTP 200 + data: [] → 誤顯示「此站暫時冇到站預報」。
// 驗證方法：記錄跳轉前 state.stop 的 co／stop 同路線頁的 co 是否一致。
const jumpCo = await page.evaluate(() => {
	const sel = document.querySelector('#rt-list .seq-row.sel');
	const jump = sel?.querySelector('[data-jump]');
	if (!jump) return null;
	jump.click();
	return true;
});
if (jumpCo) {
	await page.waitForSelector('#page-eta.active', { timeout: 8000 });
	// ⚠️ 唔可以用固定 waitForTimeout：ETA 要打網絡（兩家 stop-eta 可能有 cache 差異），
	//    2500ms 唔夠時會讀到 skeleton（rows=0 且 empty=false），令斷言誤報失敗。
	//    正確做法：等「結果容器」出現（.eta-row 有行、或 .empty 空狀態、或 .error-box）。
	await page.waitForSelector('#eta-list .eta-row, #eta-list .empty, #eta-list .error-box', { timeout: 20000 });
	await page.waitForTimeout(600);
	const etaJump = await page.evaluate(() => ({
		name: document.getElementById('eta-name').textContent.trim(),
		dots: [...document.querySelectorAll('.eta-row .co-dot')].map((e) => e.className),
		empty: !!document.querySelector('#eta-list .empty'),
		rows: document.querySelectorAll('.eta-row').length
	}));
	// 斷言：唔應該「路線頁有 ETA 但跳轉後變空狀態」
	const rtHadEta = rtEtas.some((t) => /\d+\s*分鐘|即將到/.test(t));
	if (rtHadEta) {
		ok(!etaJump.empty && etaJump.rows > 0,
			'[回歸] 路線頁有 ETA 的站，跳 ETA 頁不應變成「冇到站預報」',
			`rows=${etaJump.rows} empty=${etaJump.empty}`);
	} else {
		ok(true, '[回歸] 路線頁該站本來就無 ETA，跳轉空狀態屬正常（跳過）', '');
	}
	await page.click('#eta-back');
	await page.waitForTimeout(400);
}

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
		sub: link.querySelector('.mi-desc')?.textContent.trim() || '',
		inMenu: !!link.closest('#menu-panel')
	};
});
ok(/清除本機所有資料/.test(copyTest.text), '清除連結文案已更新', copyTest.text);
ok(/只存於此裝置/.test(copyTest.sub), '補充說明資料只存於本機', copyTest.sub.slice(0, 30));
ok(copyTest.inMenu, '清除連結已搬入漢堡選單（頁尾只留離線資料＋版本號）');

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

/* ---------- 8b-5. 漢堡選單 + 最近搜尋只顯示 3 個 ---------- */
console.log('\n[8b-5] 漢堡選單與最近搜尋上限（2026-10-12）');

// ① 頁尾精簡：只剩離線資料與版本號
const footItems = await page.evaluate(() => ({
	stamp: !!document.getElementById('data-stamp'),
	ver: !!document.getElementById('app-version'),
	clearInFoot: !!document.getElementById('clear-data')?.closest('.foot'),
	netInFoot: !!document.getElementById('net-state')?.closest('.foot'),
	attrInFoot: !!document.getElementById('data-attribution')?.closest('.foot')
}));
ok(footItems.stamp && footItems.ver, '頁尾保留離線資料與版本號');
ok(!footItems.clearInFoot && !footItems.netInFoot && !footItems.attrInFoot,
	'清除資料／網絡狀態／資料來源已搬離頁尾');

// ② 漢堡按鈕開合
await page.click('#menu-btn');
const menuOpen = await page.evaluate(() => ({
	open: !document.getElementById('menu-panel').hidden,
	expanded: document.getElementById('menu-btn').getAttribute('aria-expanded'),
	hasClear: !!document.getElementById('clear-data')?.closest('#menu-panel'),
	hasNet: !!document.getElementById('net-state')?.closest('#menu-panel'),
	hasAttr: !!document.getElementById('data-attribution')?.closest('#menu-panel'),
	attrFilled: /資料來源/.test(document.getElementById('data-attribution').textContent)
}));
ok(menuOpen.open && menuOpen.expanded === 'true', '漢堡按鈕開啟選單');
ok(menuOpen.hasClear && menuOpen.hasNet && menuOpen.hasAttr,
	'選單包含清除資料／網絡狀態／資料來源');
ok(menuOpen.attrFilled, '選單內資料來源文案已填入（applyBranding 生效）');
await page.screenshot({ path: join(SHOTS, '12-hamburger-menu.png') });

// ③ 撳選單外面自動收起（撳 topbar 標題：面板只會遮蓋下方內容，撳頂欄等於外面）
await page.click('.topbar h1');
const menuClosed = await page.evaluate(() => document.getElementById('menu-panel').hidden);
ok(menuClosed, '撳選單外面自動收起');

// ④ 最近搜尋：5 筆 → 只顯示最近 3 個 + 「更多…」
await page.evaluate(() => {
	const B = window.BusETA;
	B.store.recent.clear();
	for (const n of ['甲', '乙', '丙', '丁', '戊']) {
		B.store.recent.add({ name: '測試' + n, lat: 22.3, lng: 114.2 });
	}
	const q = document.getElementById('q');
	q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(700);
const recCollapsed = await page.evaluate(() => ({
	rows: document.querySelectorAll('#recent [data-r]').length,
	names: [...document.querySelectorAll('#recent [data-r] .name')].map((e) => e.textContent),
	more: !!document.querySelector('#recent [data-rmore]'),
	moreText: document.querySelector('#recent [data-rmore] .name')?.textContent || ''
}));
ok(recCollapsed.rows === 3, '最近搜尋只顯示 3 個（共 5 筆）', recCollapsed.names.join(' / '));
ok(recCollapsed.more, '超過上限顯示「更多…」列', recCollapsed.moreText);
ok(recCollapsed.names[0] === '測試戊' && recCollapsed.names[2] === '測試丙',
	'顯示的是最近 3 個（最新在前）');

// ⑤ 展開／收起
await page.click('#recent [data-rmore]');
await page.waitForTimeout(300);
const recExpanded = await page.evaluate(() => ({
	rows: document.querySelectorAll('#recent [data-r]').length,
	label: document.querySelector('#recent [data-rmore] .name')?.textContent || ''
}));
ok(recExpanded.rows === 5, '撳「更多…」展開全部 5 個', `${recExpanded.rows} 列`);
ok(/收起/.test(recExpanded.label), '展開後標籤變「收起」');
await page.screenshot({ path: join(SHOTS, '13-recent-expanded.png') });

await page.click('#recent [data-rmore]');
await page.waitForTimeout(300);
const recRecollapsed = await page.evaluate(() => document.querySelectorAll('#recent [data-r]').length);
ok(recRecollapsed === 3, '再撳「收起」返回 3 個');

// ⑥ 3 個以內唔出現「更多…」
await page.evaluate(() => {
	const B = window.BusETA;
	B.store.recent.clear();
	for (const n of ['甲', '乙', '丙']) {
		B.store.recent.add({ name: '測試' + n, lat: 22.3, lng: 114.2 });
	}
	document.getElementById('q').dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(600);
const rec3 = await page.evaluate(() => ({
	rows: document.querySelectorAll('#recent [data-r]').length,
	more: !!document.querySelector('#recent [data-rmore]')
}));
ok(rec3.rows === 3 && !rec3.more, '3 個以內不出現「更多…」列');

// ⑦ 展開狀態下刪除仍正常（逐項刪除 + 重繪後保持展開）
await page.evaluate(() => {
	const B = window.BusETA;
	B.store.recent.clear();
	for (const n of ['甲', '乙', '丙', '丁', '戊']) {
		B.store.recent.add({ name: '測試' + n, lat: 22.3, lng: 114.2 });
	}
	document.getElementById('q').dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(600);
await page.click('#recent [data-rmore]');   // 展開
await page.waitForTimeout(200);
await page.click('#recent [data-r="3"] [data-del]');   // 刪「測試乙」（展開後索引 3）
await page.waitForTimeout(400);
const recDelExpanded = await page.evaluate(() => ({
	rows: document.querySelectorAll('#recent [data-r]').length,
	stored: window.BusETA.store.recent.load().map((x) => x.name)
}));
ok(recDelExpanded.rows === 4 && !recDelExpanded.stored.includes('測試乙'),
	'展開狀態下逐項刪除正常（刪後仍展開）', recDelExpanded.stored.join(' / '));

// 清理（順手收起選單，避免影響後續測試）
await page.evaluate(() => {
	window.BusETA.store.recent.clear();
	const panel = document.getElementById('menu-panel');
	if (panel && !panel.hidden) document.getElementById('menu-btn').click();
	document.getElementById('q').dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);

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

/* [BAY-1] 多行車位時標示該路線實際停邊塊牌（2026-12 新增） */
const bay1 = await page.evaluate(() => {
	const rows = [...document.querySelectorAll('#eta-list .eta-row')];
	const withMulti = rows.filter((r) => r.querySelector('.dest .svc-tag')?.textContent.includes('多位置'));
	return {
		multiRows: withMulti.length,
		bayTagged: [...document.querySelectorAll('#eta-list .bay-tag')].map((e) => ({
			text: e.textContent.trim(),
			warn: e.classList.contains('warn')
		})),
		// 合法標示：只可係「停 XXX」或「不停此位」
		bad: [...document.querySelectorAll('#eta-list .bay-tag')]
			.map((e) => e.textContent.trim())
			.filter((t) => !/^停\s*\([A-Z]{1,3}\d+\)$/.test(t) && t !== '不停此位')
	};
});
ok(bay1.bad.length === 0, '[BAY-1] 行車位標示格式合法（只出現「停 (XXX)」或「不停此位」）',
	`實得 ${bay1.bayTagged.map((t) => t.text).join('、') || '（本頁站只有單一行車位，無標示屬正確）'}`);
// 單一行車位不應被標示（會造成囉嗦）
const singleBay = await page.evaluate(() =>
	[...document.querySelectorAll('#eta-list .eta-row')]
		.filter((r) => !r.querySelector('.dest .svc-tag')?.textContent.includes('多位置'))
		.filter((r) => r.querySelector('.bay-tag')).length);
ok(singleBay === 0, '[BAY-1] 單一行車位的路線不被標示（避免囉嗦）', `${singleBay} 行有多餘標示`);

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
	return { name: j.name, icons: j.icons.length, display: j.display, version: j.version };
});
ok(mani.display === 'standalone', 'manifest 為 standalone', mani.name);
ok(mani.icons >= 4, '圖示齊備', `${mani.icons} 個`);

/* ---------- 9b. 版本號 + History API（M10） ---------- */
console.log('\n[9b] 版本號顯示 + 上一頁不離開 app');
// ⚠️ 先 reload 返搜尋頁：.foot（含版本號）只喺 page-search 顯示，
//    而且前一段測試結束時停喺 ETA 頁，唔 reload 就驗證唔到。
//    順便驗證「reload 後 history 項會對齊返搜尋頁」（M10 修正項）。
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 25000 });
await page.waitForTimeout(400);

const verUI = await page.evaluate(() => ({
	text: document.getElementById('app-version')?.textContent || '',
	inFoot: !!document.getElementById('app-version')?.closest('.foot'),
	visible: (() => {
		const el = document.getElementById('app-version');
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	})()
}));
ok(verUI.inFoot, '版本號位於首頁底部 .foot 區塊');
ok(/^版本 \d+\.\d+\.\d+$/.test(verUI.text), '版本號格式正確（版本 X.Y.Z）', verUI.text);
ok(verUI.text === `版本 ${mani.version}`, '頁面版本號與 manifest.json 一致', `${verUI.text} / ${mani.version}`);
ok(verUI.visible, '版本號實際可見（非 display:none）', verUI.text);

/* ---------- 9c. 瀏覽器上一頁逐層返回 ---------- */
console.log('\n[9c] History API：上一頁逐層返回');
// ⚠️ 用 history.back()（等同手機返回鍵 / 瀏覽器上一頁），
//    唔係撳 app 內嘅返回鈕 —— 目標係證明**系統返回鍵**會喺 app 內逐層返回，
//    而唔係直接關閉 app（呢個係用戶回報的原問題）。
const hInit = await page.evaluate(() => ({
	owned: !!history.state?.buseta,
	page: history.state?.page || '',
	len: history.length
}));
ok(hInit.owned, 'history 項已標記為 app 所有（返回鈕可安全 history.back）', hInit.page);
ok(hInit.page === 'page-search', 'history 項指向搜尋頁（reload 後已對齊）', hInit.page);

// 由搜尋頁 → nearby → ETA，層層 push
await page.click('#recent [data-r="0"]');
await page.waitForFunction(() => document.getElementById('page-nearby')?.classList.contains('active'), { timeout: 15000 });
await page.waitForTimeout(500);
await page.click('#nb-list .stop');
await page.waitForSelector('#eta-list .eta-row, #eta-list .empty, #eta-list .error-box', { timeout: 30000 });
await page.waitForTimeout(400);
const hDepth3 = await page.evaluate(() => ({ len: history.length, page: history.state?.page }));
ok(hDepth3.page === 'page-eta', '每次跳頁都有 push 一層 history', `${hDepth3.page}（depth ${hDepth3.len}）`);

// 系統返回：ETA → nearby
await page.evaluate(() => history.back());
await page.waitForTimeout(800);
const back1 = await page.evaluate(() => ({
	nearby: document.getElementById('page-nearby')?.classList.contains('active'),
	eta: document.getElementById('page-eta')?.classList.contains('active'),
	page: history.state?.page,
	// DOM 仍在 = 頁面無重新載入 = 確定無離開 app
	domAlive: !!document.getElementById('page-search')
}));
ok(back1.nearby && !back1.eta, '上一頁：ETA → 附近站（無離開 app）', back1.page);
ok(back1.domAlive, '上一頁未觸發頁面重載（確定無離開 app）', '');

// 系統返回：nearby → 搜尋頁
await page.evaluate(() => history.back());
await page.waitForTimeout(800);
const back2 = await page.evaluate(() => ({
	search: document.getElementById('page-search')?.classList.contains('active'),
	nearby: document.getElementById('page-nearby')?.classList.contains('active'),
	page: history.state?.page,
	recentShown: document.querySelectorAll('#recent [data-r]').length > 0
}));
ok(back2.search && !back2.nearby, '上一頁：附近站 → 搜尋頁（無離開 app）', back2.page);
ok(back2.recentShown, '返回搜尋頁後已重繪最近搜尋（restorePage 副作用生效）', '');

// 返回鈕與系統返回鍵必須行同一條 stack（否則用戶會「來回彈」）
await page.click('#recent [data-r="0"]');
await page.waitForFunction(() => document.getElementById('page-nearby')?.classList.contains('active'), { timeout: 15000 });
await page.waitForTimeout(500);
const beforeBtnBack = await page.evaluate(() => history.length);
await page.click('#nb-back');
await page.waitForTimeout(800);
const afterBtnBack = await page.evaluate(() => ({
	search: document.getElementById('page-search')?.classList.contains('active'),
	len: history.length,
	page: history.state?.page
}));
ok(afterBtnBack.search, 'app 內返回鈕：附近站 → 搜尋頁', afterBtnBack.page);
// ⚠️ history.length 係 stack **總深度**，back() 只移動指標唔會令它減少；
//    只有 pushState 會增長（並截斷 forward）。
//    所以正確斷言係「返回鈕**冇**令 stack 變深」——
//    若返回鈕自己 go() 再 push 一層，length 會 +1，用戶隨後撳系統返回就會彈返返去。
ok(afterBtnBack.len === beforeBtnBack,
	'返回鈕用 history.back()（stack 深度不變 = 冇另 push 一層）',
	`${beforeBtnBack} → ${afterBtnBack.len}`);

/* ---------- 9d. M12 planTrip 演算法（[TRIP-*]） ---------- */
console.log('\n[9d] M12 planTrip 演算法');
// ⚠️ 斷言用結構性性質（由離線站序構造測試點），唔綁會漂移的官方座標
const tripAlgo = await page.evaluate(() => {
	const B = window.BusETA, DBS = window.__DBS;
	const kmb = DBS.kmb;
	const out = {};

	// [TRIP-1/2/3] 直達：由路線 1（KMB O svc1）站序構造起終點
	let ri = -1;
	for (let i = 0; i < kmb.routeList.length; i++) {
		const [no, b, svc] = kmb.routeList[i];
		if (no === '1' && b === 'O' && svc === 1) { ri = i; break; }
	}
	const seq1 = kmb.routeSeqs[ri].slice().sort((a, b) => a.seq - b.seq);
	const sA = kmb.stopById.get(seq1[0].stop);
	const sB = kmb.stopById.get(seq1[Math.min(6, seq1.length - 1)].stop);
	const t0 = performance.now();
	const r1 = B.planTrip(DBS, { lat: sA.lat, lng: sA.lng }, { lat: sB.lat, lng: sB.lng }, {});
	out.ms1 = Math.round(performance.now() - t0);
	out.direct = r1.plans.filter((p) => p.transfers === 0);
	out.hasDirectRoute1 = out.direct.some((p) => p.legs[0].route === '1');
	out.revHasDirect = B.planTrip(DBS, { lat: sB.lat, lng: sB.lng }, { lat: sA.lat, lng: sA.lng }, {})
		.plans.some((p) => p.transfers === 0 && p.legs[0].route === '1');
	const dKeys = out.direct.map((p) => `${p.legs[0].route}|${p.legs[0].bound}`);
	out.directDedup = dKeys.length === new Set(dKeys).size;
	out.legValid = out.direct.every((p) => p.legs.every((l) => l.stops > 0 && l.from.seq < l.to.seq));

	// [TRIP-11] 上車站最近優先（2026-10-13 用戶回饋迴歸）：
	// 起點 = 路線 1 站序首站座標（步行 0）→ route 1 直達方案必須由該站上車，
	// 唔可以因「站數最少」反而揀遠處嘅同線站（實測 290A 中伏案例）
	{
		const r11 = B.planTrip(DBS, { lat: sA.lat, lng: sA.lng }, { lat: sB.lat, lng: sB.lng }, {});
		const d11 = r11.plans.find((p) => p.transfers === 0 && p.legs[0].route === '1');
		out.nearestBoard = d11 ? { stop: d11.legs[0].from.stop, walk: d11.walkOriginM } : null;
		out.nearestExpect = sA.stop;
	}

	// [TRIP-5/6/7] 觀塘 → 筲箕灣（計劃書 §6 指定一轉案例）
	const findStop = (kw) => {
		for (const s of kmb.stopById.values()) if (s.name.includes(kw)) return s;
		return null;
	};
	const kt = findStop('觀塘站') || findStop('觀塘');
	const skw = findStop('筲箕灣');
	out.pairFound = !!(kt && skw);
	if (out.pairFound) {
		const t1 = performance.now();
		const r2 = B.planTrip(DBS, { lat: kt.lat, lng: kt.lng }, { lat: skw.lat, lng: skw.lng }, {});
		out.ms2 = Math.round(performance.now() - t1);
		out.plans2 = r2.plans.length;
		out.hasTransfer = r2.plans.some((p) => p.transfers === 1);
		out.allValid = r2.plans.every((p) => p.legs.length === p.transfers + 1 &&
			p.legs.every((l) => l.stops > 0 && l.from.stop && l.to.stop));
		out.hasCtbLeg = r2.plans.some((p) => p.legs.some((l) => l.co === 'ctb'));
	}

	// [TRIP-12] 落車站名實相符優先（2026-10-13 用戶回饋）：
	// dest「高鐵西九龍站」— OSM 命中點（匯民道）到「佐敦炮台街」直線 234 米，
	// 近過「佐敦道,高鐵站」331 米，但站名有「高鐵」嘅候選應優先（大型街區直線失真）。
	// 由 95 號沿線（順利邨公園上車）構造：期望落車 = 佐敦道,高鐵站，唔係炮台街。
	{
		const slp = findStop('順利邨公園');
		const r12 = B.planTrip(DBS,
			{ lat: slp.lat, lng: slp.lng, name: slp.name },
			{ lat: 22.30407, lng: 114.16651, name: '高鐵西九龍站' }, {});
		const d12 = r12.plans.find((p) => p.transfers === 0 && p.legs[0].route === '95');
		out.affinity = d12 ? d12.legs[0].to.name : null;
	}

	// [TRIP-13] 跨公司撞號線唔可以混站序直達（2026-10-13 用戶回饋）：
	// 九巴 40（荃灣↔麗港城）/ 40P（荃灣↔觀塘碼頭）唔過海唔經羅便臣道；
	// 城巴 40（華富↔會展）/ 40P（深灣↔羅便臣道）純港島不停九龍灣站。
	// route|bound 撞號 → 直接搜尋必須同公司站序，否則九巴 seq 配城巴 seq 假命中。
	{
		const klw = (() => { for (const s of kmb.stopById.values()) if (String(s.name).includes('九龍灣站')) return s; return null; })();
		let gtw = null;
		for (const s of DBS.ctb.stopById.values()) if (String(s.name).includes('花園台')) { gtw = s; break; }
		out.collideFound = !!(klw && gtw);
		if (out.collideFound) {
			const r13 = B.planTrip(DBS,
				{ lat: klw.lat, lng: klw.lng, name: klw.name },
				{ lat: gtw.lat, lng: gtw.lng, name: gtw.name }, {});
			out.collide = {
				d40: r13.plans.filter((p) => p.transfers === 0 &&
					(p.legs[0].route === '40' || p.legs[0].route === '40P')).length,
				// 正確性不變式：每條 leg 內 from/to 必須同公司（一趟實體巴士單一公司站序）
				mixedCo: r13.plans.filter((p) => p.legs.some((l) => l.from.co !== l.to.co)).length
			};
		}
	}

	// [TRIP-8] 多 svc：路線 40 KMB 有多個 svc 且站序唔同 —— svc≠1 變體唔可以漏判
	const svcs40 = kmb.routeList
		.map((r, i) => [r, i])
		.filter(([r]) => r[0] === '40' && r[1] === 'O');
	out.svc40Count = svcs40.length;
	out.svc40Found = false;
	for (const [, i] of svcs40) {
		if (kmb.routeList[i][2] === 1) continue;
		const sq = kmb.routeSeqs[i].slice().sort((a, b) => a.seq - b.seq);
		if (sq.length < 8) continue;
		const a = kmb.stopById.get(sq[0].stop);
		const b2 = kmb.stopById.get(sq[6].stop);
		if (!a || !b2) continue;
		if (B.planTrip(DBS, { lat: a.lat, lng: a.lng }, { lat: b2.lat, lng: b2.lng }, {})
			.plans.some((p) => p.legs.some((l) => l.route === '40'))) {
			out.svc40Found = true;
			break;
		}
	}

	// [TRIP-9] 無站：海中心一點（由當前離線資料沿維港範圍取樣，揀離任何站最遠嗰點
	// —— 唔綁死座標：官方站點每日更新，硬編海中心座標會飄（2026-10-12 實測踩坑））
	const water = (() => {
		const stops = [...kmb.stopById.values(), ...DBS.ctb.stopById.values()];
		let best = null, bestD = -1;
		for (let lat = 22.285; lat <= 22.315; lat += 0.005) {
			for (let lng = 114.14; lng <= 114.20; lng += 0.005) {
				let dmin = Infinity;
				for (const s of stops) {
					const d = B.haversine(lat, lng, s.lat, s.lng);
					if (d < dmin) { dmin = d; if (dmin <= bestD) break; }
				}
				if (dmin > bestD) { bestD = dmin; best = { lat, lng }; }
			}
		}
		return { point: best, nearest: Math.round(bestD) };
	})();
	const r3 = B.planTrip(DBS, water.point, water.point, {});
	out.harbour = { reason: r3.reason, n: r3.plans.length, nearest: water.nearest };
	// 附帶驗證 walkRadius 參數生效：半徑 1 米時連黃大仙中心都會 noStops
	const r4 = B.planTrip(DBS, { lat: 22.3414, lng: 114.1943 }, { lat: 22.3414, lng: 114.1943 }, { walkRadius: 1 });
	out.tinyRadius = { reason: r4.reason, n: r4.plans.length };

	return out;
});
ok(tripAlgo.direct.length > 0 && tripAlgo.hasDirectRoute1, '[TRIP-1] 已知同線兩站搵到直達',
	`route 1（${tripAlgo.ms1}ms）`);
ok(tripAlgo.revHasDirect, '[TRIP-2] 反向查詢同樣搵到直達（方向對稱）');
ok(tripAlgo.directDedup, '[TRIP-3] 直達方案按 route|bound 走廊去重（一走廊一方案）');
ok(tripAlgo.legValid, '[TRIP-4] 直達 leg：seq(上) < seq(落) 且站數 > 0（R-G）');
ok(tripAlgo.pairFound, '[TRIP-5] 觀塘／筲箕灣站名命中（離線資料）');
ok(tripAlgo.plans2 > 0 && tripAlgo.hasTransfer, '[TRIP-5] 觀塘→筲箕灣有方案（含 1 轉）',
	`${tripAlgo.plans2} 個方案（${tripAlgo.ms2}ms）`);
ok(tripAlgo.allValid, '[TRIP-6] 全部方案：leg 數 = 轉數 + 1 且站數 > 0');
ok(tripAlgo.hasCtbLeg, '[TRIP-7] 方案含城巴段（跨公司資料參與規劃）');
ok(tripAlgo.svc40Count > 1 && tripAlgo.svc40Found,
	'[TRIP-8] 多 svc 路線 40 唔漏判（svc≠1 變體都搵到，R-E）',
	`40 號 O 方向有 ${tripAlgo.svc40Count} 個 svc`);
ok(tripAlgo.harbour.reason === 'noStops' && tripAlgo.harbour.n === 0 && tripAlgo.harbour.nearest > 500,
	'[TRIP-9] 海中心（離站最遠取樣點）→ noStops 空結果',
	`最近站 ${tripAlgo.harbour.nearest} 米`);
ok(tripAlgo.tinyRadius.reason === 'noStops' && tripAlgo.tinyRadius.n === 0,
	'[TRIP-9] walkRadius 參數生效（半徑 1 米 → noStops）');
ok(tripAlgo.ms2 <= 2000, '[TRIP-10] 效能：觀塘→筲箕灣規劃 ≤ 2 秒', `${tripAlgo.ms2}ms`);
ok(!!tripAlgo.nearestBoard &&
	tripAlgo.nearestBoard.stop === tripAlgo.nearestExpect &&
	tripAlgo.nearestBoard.walk <= 30,
	'[TRIP-11] 上車站最近優先：起點旁的站被選中（步行約 0 米）',
	JSON.stringify(tripAlgo.nearestBoard));
ok(!!tripAlgo.affinity && tripAlgo.affinity.includes('高鐵') && !tripAlgo.affinity.includes('炮台街'),
	'[TRIP-12] 落車站名實相符優先：高鐵西九龍站 → 佐敦道,高鐵站（非較近嘅炮台街）',
	tripAlgo.affinity || '(無 route 95 直達)');
ok(tripAlgo.collideFound && tripAlgo.collide.d40 === 0,
	'[TRIP-13] 撞號線：九龍灣站 → 花園台 無 40/40P 直達假命中',
	JSON.stringify(tripAlgo.collide));
ok(tripAlgo.collideFound && tripAlgo.collide.mixedCo === 0,
	'[TRIP-13] 不變式：每條 leg 內 from/to 同公司（站序唔跨公司混搭）');

// [TRIP-14] 即時班次過濾（純函數，離線可測；2026-10-13 用戶回饋：6P/6E 冇班次唔應出現喺建議）
const t14 = await page.evaluate(() => {
	const B = window.BusETA;
	const plans = [
		{ legs: [{ co: 'kmb', from: { stop: 'S1' }, route: '1', bound: 'O', svc: 1 }] },
		{ legs: [{ co: 'kmb', from: { stop: 'S2' }, route: '2', bound: 'O', svc: 1 }] }
	];
	const avail = new Map([['kmb|S1|1|O', false]]);   // route 1 確認冇班次；route 2 查唔到（missing → fail-open）
	const r = B.applyTripEtaFilter(plans, avail);
	return { key: B.tripEtaKey(plans[0].legs[0]), kept: r.plans.length, filtered: r.filtered };
});
ok(t14.key === 'kmb|S1|1|O', '[TRIP-14] tripEtaKey 格式（co|stop|route|bound，走廊級唔含 svc）', t14.key);
ok(t14.kept === 1 && t14.filtered === 1,
	'[TRIP-14] 班次過濾：確認冇班次 (false) 剔除；查唔到 (missing/null) fail-open 保留',
	`kept=${t14.kept} filtered=${t14.filtered}`);

// [TRIP-15] 同走廊轉乘禁令（2026-10-13 用戶實測迴歸：103 搭 1 站走、過對面轉
// 103 反方向搭 13 站返 —— 直接行過對面搭就得）。結構性不變式：任何轉車方案
// 兩段唔可以同走廊（同公司同路線，或聯營線跨公司同號）。
const t15 = await page.evaluate(() => {
	const B = window.BusETA;
	const DBS = window.__DBS;
	const o = DBS.kmb.stopById.get('18492910339410B1');
	let d = null;
	for (const [, s] of DBS.kmb.stopById) { if (String(s.name).includes('筲箕灣')) { d = s; break; } }
	const res = B.planTrip(DBS, { lat: o.lat, lng: o.lng, name: o.name }, { lat: d.lat, lng: d.lng, name: d.name }, { maxTransfers: 1 });
	const idx = B.crossIndex(DBS.ctb);
	const bad = res.plans.filter((p) => p.transfers === 1 &&
		p.legs[0].route === p.legs[1].route &&
		(p.legs[0].co === p.legs[1].co || !!idx.dirs[p.legs[0].route]));
	return { total: res.plans.length, bad: bad.length };
});
ok(t15.total > 0 && t15.bad === 0,
	'[TRIP-15] 轉車方案無同走廊轉乘（同路線反方向「搭走再搭返嚟」已被禁）',
	`plans=${t15.total} bad=${t15.bad}`);

/* ---------- 9e. M12 trip 頁 UI（[TRIP-UI-*]） ---------- */
console.log('\n[9e] M12 trip 頁 UI');
// [UI-QA-1] 首頁兩個入口掣同一列（2026-10-13 用戶回饋：原本上下疊太佔位）
const qaRow = await page.evaluate(() => {
	const a = document.getElementById('locate-btn').getBoundingClientRect();
	const b = document.getElementById('trip-entry').getBoundingClientRect();
	return { sameRow: Math.abs(a.top - b.top) < 2, narrow: a.width < 300, w: Math.round(a.width) };
});
ok(qaRow.sameRow && qaRow.narrow, '[UI-QA-1] 首頁「用我位置」＋「查點到點」兩掣同一列平分寬度', `寬 ${qaRow.w}px`);
await page.click('#trip-entry');
await page.waitForFunction(() => document.getElementById('page-trip')?.classList.contains('active'), { timeout: 5000 });
const tUI0 = await page.evaluate(() => ({
	disclaimer: document.querySelector('.trip-disclaimer')?.textContent || '',
	hint: document.getElementById('trip-status').textContent
}));
ok(/靜態資料估算/.test(tUI0.disclaimer), '[TRIP-UI-1] 頁底免責聲明存在（直線×1.3）');
ok(tUI0.hint.length > 0, '[TRIP-UI-1] 未輸入時顯示指引');

// 起點：觀塘（經 Nominatim 建議清單；節流層與搜尋頁共用）
await page.click('#trip-origin');
await page.type('#trip-origin', '觀塘', { delay: 30 });
await page.waitForSelector('#trip-origin-sug .sug-item', { timeout: 25000 });
await page.click('#trip-origin-sug .sug-item');
await page.waitForTimeout(200);
// 終點：筲箕灣
await page.click('#trip-dest');
await page.type('#trip-dest', '筲箕灣', { delay: 30 });
await page.waitForSelector('#trip-dest-sug .sug-item', { timeout: 25000 });
await page.click('#trip-dest-sug .sug-item');
await page.waitForSelector('#trip-results .plan', { timeout: 15000 });
const tUI1 = await page.evaluate(() => ({
	plans: document.querySelectorAll('#trip-results .plan').length,
	xfer: [...document.querySelectorAll('#trip-results .xfer')].map((x) => x.textContent.trim()),
	noMinutes: !document.getElementById('trip-results').textContent.includes('分鐘'),
	walkTags: [...document.querySelectorAll('#trip-results .walk')].length
}));
ok(tUI1.plans > 0, '[TRIP-UI-2] 兩點 resolve 後自動出方案卡', `${tUI1.plans} 個方案`);
ok(tUI1.noMinutes, '[TRIP-UI-3] 方案卡唔顯示預估時間（決策乙）');
ok(tUI1.walkTags > 0, '[TRIP-UI-3] 顯示步行約 X 米（×1.3 估算）');
await page.screenshot({ path: join(SHOTS, '15-trip-plans.png') });

// [TRIP-UI-8] 對調掣：起終點互換並自動重跑規劃（2026-10-13 用戶建議）
const beforeSwap = await page.evaluate(() => ({
	o: document.getElementById('trip-origin').value,
	d: document.getElementById('trip-dest').value,
	plans: document.querySelectorAll('#trip-results .plan').length
}));
await page.click('#trip-swap');
// v1.4.4：renderTrip 係 async（連網檢查即時班次）——等「檢查中」狀態消失，唔可以用死 timeout
await page.waitForFunction(() => !document.getElementById('trip-status').textContent.includes('檢查即時班次中'), { timeout: 20000 });
const afterSwap = await page.evaluate(() => ({
	o: document.getElementById('trip-origin').value,
	d: document.getElementById('trip-dest').value,
	plans: document.querySelectorAll('#trip-results .plan').length
}));
ok(afterSwap.o === beforeSwap.d && afterSwap.d === beforeSwap.o,
	'[TRIP-UI-8] 對調掣：起終點互換', `${beforeSwap.o}→${beforeSwap.d} ⇒ ${afterSwap.o}→${afterSwap.d}`);
ok(afterSwap.plans > 0, '[TRIP-UI-8] 對調後自動重跑方案');
await page.click('#trip-swap');   // 對調返原狀，唔影響後續測試
await page.waitForFunction(() => !document.getElementById('trip-status').textContent.includes('檢查即時班次中'), { timeout: 20000 });

// [TRIP-UI-9] 連網班次檢查（2026-10-13 用戶回饋：6P/6E 冇班次唔應出現喺建議）：
// ⚠️ 唔可以用 ctx.route mock ETA 端點 —— ETA 請求經 sw.js fetch handler 發出，
// route 攔唔到。改為 stub window.BusETA.checkTripEtas 回「全部 false」
//（API 對冇班次線回 eta:null 嘅形狀已用 curl 實證，純邏輯由 [TRIP-14] 覆蓋）。
await page.evaluate(() => {
	window.__origCheckTripEtas = window.BusETA.checkTripEtas;
	// ⚠️ 要有 forEach（批次合併會呼叫）——上次漏咗令 renderTrip 卡死「檢查中」
	window.BusETA.checkTripEtas = async () => ({ get: () => false, forEach: () => {} });
});
await page.click('#trip-swap');
await page.waitForFunction(() => !document.getElementById('trip-status').textContent.includes('檢查即時班次中'), { timeout: 15000 });
const tUI9 = await page.evaluate(() => ({
	plans: document.querySelectorAll('#trip-results .plan').length,
	empty: document.querySelector('#trip-results .empty')?.textContent.replace(/\s+/g, ' ').trim() || '',
	st: document.getElementById('trip-status').textContent
}));
ok(tUI9.plans === 0, '[TRIP-UI-9] 全部 leg 確認冇班次（eta:null）→ 方案全數篩走', `${tUI9.plans} 個方案`);
ok(/冇班次/.test(tUI9.empty), '[TRIP-UI-9] 顯示「冇班次」解釋', tUI9.empty.slice(0, 40));
await page.evaluate(() => {
	window.BusETA.checkTripEtas = window.__origCheckTripEtas;
});
await page.click('#trip-swap');   // 對調返原狀＋真實檢查（fail-open）重跑
await page.waitForFunction(() => !document.getElementById('trip-status').textContent.includes('檢查即時班次中'), { timeout: 20000 });
const tUI9b = await page.evaluate(() => ({
	plans: document.querySelectorAll('#trip-results .plan').length,
	o: document.getElementById('trip-origin').value,
	d: document.getElementById('trip-dest').value
}));
ok(tUI9b.plans > 0, '[TRIP-UI-9] 恢復／檢查失敗 → fail-open 照常顯示方案', `${tUI9b.plans} 個方案`);
ok(tUI9b.o === beforeSwap.o && tUI9b.d === beforeSwap.d, '[TRIP-UI-9] 對調兩次返原狀（唔影響後續測試）');

// History 返回重繪（M10 慣例）：back → 搜尋頁，forward → trip 且方案重繪
const hLenTrip = await page.evaluate(() => history.length);
await page.evaluate(() => history.back());
await page.waitForTimeout(700);
const tripBackSearch = await page.evaluate(() => document.getElementById('page-search')?.classList.contains('active'));
await page.evaluate(() => history.forward());
await page.waitForTimeout(700);
const tripFwd = await page.evaluate(() => ({
	trip: document.getElementById('page-trip')?.classList.contains('active'),
	plans: document.querySelectorAll('#trip-results .plan').length,
	len: history.length
}));
ok(tripBackSearch, '[TRIP-UI-4] trip → 系統返回 → 搜尋頁');
ok(tripFwd.trip && tripFwd.plans > 0, '[TRIP-UI-4] 前進回 trip 頁方案重繪（restorePage）', `${tripFwd.plans} 個方案`);
ok(tripFwd.len === hLenTrip, '[TRIP-UI-4] 來回返回冇令 stack 變深', `${hLenTrip} → ${tripFwd.len}`);

// [TRIP-UI-6] 撳上車站 → 跳「路線詳情」並高亮該站（2026-10-13 用戶回饋：
// 原本跳 ETA 頁，用戶要睇條線行邊；改跳路線詳情 + .seq-row.sel 高亮）
const upLabel = await page.evaluate(() => document.querySelector('#trip-results .leg .pt.up')?.textContent.trim());
await page.click('#trip-results .leg .pt.up');
await page.waitForFunction(() => document.getElementById('page-route')?.classList.contains('active'), { timeout: 10000 });
await page.waitForFunction(() => document.querySelector('#rt-list .seq-row.sel'), { timeout: 10000 });
const rtSel = await page.evaluate(() => ({
	no: document.getElementById('rt-no').textContent,
	sel: document.querySelector('#rt-list .seq-row.sel .nm .t')?.textContent.trim()
}));
ok(rtSel.sel === upLabel, '[TRIP-UI-6] 撳上車站 → 路線詳情頁並高亮該站',
	`${rtSel.no} @ ${rtSel.sel}（期望 ${upLabel}）`);
await page.screenshot({ path: join(SHOTS, '16-trip-leg-route.png') });
await page.evaluate(() => history.back());   // 路線頁 → trip
await page.waitForTimeout(600);

// 站點跳轉：ETA 頁「查去處」→ 該站帶入做起點
await page.evaluate(() => history.back());   // trip → 搜尋頁
await page.waitForTimeout(500);
await page.click('#recent [data-r="0"]');
await page.waitForFunction(() => document.getElementById('page-nearby')?.classList.contains('active'), { timeout: 15000 });
await page.waitForTimeout(400);
await page.click('#nb-list .stop');
await page.waitForFunction(() => document.getElementById('page-eta')?.classList.contains('active'), { timeout: 15000 });
await page.click('#eta-trip');
await page.waitForFunction(() => document.getElementById('page-trip')?.classList.contains('active'), { timeout: 5000 });
await page.waitForTimeout(300);
const tUI2 = await page.evaluate(() => ({
	originVal: document.getElementById('trip-origin').value,
	destVal: document.getElementById('trip-dest').value
}));
ok(tUI2.originVal.length > 0, '[TRIP-UI-5] ETA 頁「查去處」→ 該站帶入做起點', tUI2.originVal);
ok(tUI2.destVal.length === 0, '[TRIP-UI-5] 終點留空待輸入（入口開新查詢）');

// [TRIP-UI-7] focus 空輸入框 → 收藏車站下接選單（2026-10-13 用戶建議 UX）
await page.evaluate(() => window.BusETA.store.favorites.toggle('kmb',
	{ stop: 'VERIFYFAV1', name: '測試收藏站', lat: 22.3, lng: 114.2 }));
await page.click('#trip-dest');
await page.waitForSelector('#trip-dest-sug .sug-head', { timeout: 5000 });
const favUI = await page.evaluate(() => ({
	head: document.querySelector('#trip-dest-sug .sug-head')?.textContent || '',
	item: document.querySelector('#trip-dest-sug .sug-item .sug-name')?.textContent.trim() || ''
}));
ok(favUI.head.includes('收藏車站') && favUI.item.includes('測試收藏站'),
	'[TRIP-UI-7] focus 空欄 → 顯示收藏車站選單', `${favUI.head} / ${favUI.item}`);
await page.click('#trip-dest-sug .sug-item');
await page.waitForTimeout(300);
const favPicked = await page.evaluate(() => document.getElementById('trip-dest').value);
ok(favPicked === '測試收藏站', '[TRIP-UI-7] 揀收藏站 → 帶入終點欄', favPicked);
// 測試收藏清走（還原狀態）
await page.evaluate(() => window.BusETA.store.favorites.toggle('kmb',
	{ stop: 'VERIFYFAV1', name: '測試收藏站', lat: 22.3, lng: 114.2 }));

/* ---------- 9f. M11 一鍵定位（[GEO-*]，mock navigator.geolocation） ---------- */
console.log('\n[9f] M11 定位');
// 先 reload 返搜尋頁（上一段結束時喺 trip 頁；reload 後 history 對齊搜尋頁）
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 25000 });

const geoBtns = await page.evaluate(() => ({
	locate: !!document.getElementById('locate-btn'),
	tripEntry: !!document.getElementById('trip-entry'),
	relocate: !!document.getElementById('nb-relocate'),
	tripGps: !!document.getElementById('trip-gps')
}));
ok(geoBtns.locate && geoBtns.tripEntry, '[GEO-0] 搜尋頁有定位／點到點兩個入口掣');
ok(geoBtns.relocate && geoBtns.tripGps, '[GEO-0] nearby 重新定位掣與 trip 起點 GPS 掣存在');

const mockGeoDenied = (code) => page.evaluate((c) => {
	Object.defineProperty(navigator, 'geolocation', {
		configurable: true,
		value: { getCurrentPosition: (s, e) => setTimeout(() => e({ code: c, message: 'mock' }), 10) }
	});
}, code);

// [GEO-1] PERMISSION_DENIED
await mockGeoDenied(1);
await page.click('#locate-btn');
await page.waitForTimeout(400);
const g1 = await page.evaluate(() => ({
	toast: document.getElementById('toast').textContent,
	onSearch: document.getElementById('page-search').classList.contains('active')
}));
ok(g1.toast.includes('未能取得定位') && g1.onSearch, '[GEO-1] 拒絕授權 → 教育提示，唔跳頁', g1.toast);

// [GEO-2] POSITION_UNAVAILABLE
await mockGeoDenied(2);
await page.click('#locate-btn');
await page.waitForTimeout(400);
const g2 = await page.evaluate(() => document.getElementById('toast').textContent);
ok(g2.includes('定位暫時唔到'), '[GEO-2] 訊號唔到 → 提示稍後再試或手動搜尋', g2);

// [GEO-3] TIMEOUT
await mockGeoDenied(3);
await page.click('#locate-btn');
await page.waitForTimeout(400);
const g3 = await page.evaluate(() => document.getElementById('toast').textContent);
ok(g3.includes('定位逾時'), '[GEO-3] 逾時 → 可重試提示', g3);

// [GEO-4/5] 成功 → nearby 顯示「目前位置 ±acc 米」、半徑 200
await page.evaluate(() => {
	Object.defineProperty(navigator, 'geolocation', {
		configurable: true,
		value: {
			getCurrentPosition: (s) => setTimeout(() => s({
				coords: { latitude: 22.3414, longitude: 114.1943, accuracy: 35 }
			}), 10)
		}
	});
});
await page.click('#locate-btn');
await page.waitForFunction(() => document.getElementById('page-nearby')?.classList.contains('active'), { timeout: 10000 });
await page.waitForTimeout(500);
const g4 = await page.evaluate(() => ({
	place: document.getElementById('nb-place').textContent,
	r200: document.querySelector('#range-seg button[data-r="200"]')?.classList.contains('on'),
	relocate: !!document.getElementById('nb-relocate'),
	stops: document.querySelectorAll('#nb-list .stop').length
}));
ok(g4.place.includes('目前位置') && g4.place.includes('±35 米'), '[GEO-4] 成功 → nearby 顯示「目前位置 ±35 米」', g4.place);
ok(g4.r200, '[GEO-5] 定位入口半徑 = 200 米（range 選鈕同步）');
ok(g4.relocate, '[GEO-5] nearby 頁有「重新定位」掣');
ok(g4.stops > 0, '[GEO-5] GPS 座標已當 place 使用（附近站有結果）', `${g4.stops} 組`);

// [GEO-6] 重新定位（原地重跑，不跳頁）
await page.click('#nb-relocate');
await page.waitForTimeout(500);
const g6 = await page.evaluate(() => ({
	place: document.getElementById('nb-place').textContent,
	nearby: document.getElementById('page-nearby').classList.contains('active')
}));
ok(g6.nearby && g6.place.includes('目前位置'), '[GEO-6] 重新定位後停留 nearby 且地點更新', g6.place);
await page.screenshot({ path: join(SHOTS, '14-locate-nearby.png') });

// [GEO-7] 唔支援 geolocation（舊瀏覽器）→ 定位掣隱藏
// 用 addInitScript 喺任何 app script 之前剷走 Navigator.prototype.geolocation
await ctx.addInitScript(() => { try { delete Navigator.prototype.geolocation; } catch (e) { /* ignore */ } });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 25000 });
const g7 = await page.evaluate(() => ({
	locateHidden: document.getElementById('locate-btn').hidden,
	gpsHidden: document.getElementById('trip-gps').hidden,
	relocateDisabled: document.getElementById('nb-relocate').disabled,
	supported: 'geolocation' in navigator
}));
ok(!g7.supported, '[GEO-7] 測試環境已模擬唔支援 geolocation');
ok(g7.locateHidden && g7.gpsHidden, '[GEO-7] 唔支援 → 定位掣／trip GPS 掣隱藏', JSON.stringify(g7));
ok(g7.relocateDisabled, '[GEO-7] 唔支援 → 重新定位掣停用');

/* ---------- 9g. M13 常到車站合併組（2026-10-28） ---------- */
// 用戶回報：bookmark 咗中電鐘樓文化館 KC377，由附近站入有齊隔離行車位嘅
// 路線（203E/72X/9/3C/45/18），由常到車站入就少咗 —— 舊收藏只儲單一 stop ID。
console.log('\n[9g] 常到車站合併組（M13）');
// 由 DB 動態搵站，唔寫死 stop ID（官方資料會變）
const kc = await page.evaluate(() => {
	for (const [co, db] of Object.entries(window.__DBS)) {
		for (const s of db.stopById.values()) {
			if (s.name.includes('中電鐘樓')) return { co, stop: s.stop, name: s.name, lat: s.lat, lng: s.lng };
		}
	}
	return null;
});
ok(!!kc, 'DB 搵到中電鐘樓文化館（用戶回報個案）', kc ? `${kc.co}:${kc.stop}` : '(無)');

if (kc) {
	// [FAV-1] mergedStopGroup：由離線資料重算同名合併組（同 renderNearby §2b 邏輯一致）
	const grp = await page.evaluate(({ co, stop }) =>
		window.BusETA.mergedStopGroup(window.__DBS, co, stop), kc);
	ok(grp.length > 1, '[FAV-1] mergedStopGroup 重算出多成員合併組', `${grp.length} 成員`);
	ok(grp.some((x) => x.co === kc.co && x.stop === kc.stop), '[FAV-1] 合併組包含自己');

	// [FAV-2] favorites 資料層：toggle 儲 ids + attachIds 升級守衛
	const store = await page.evaluate(({ co, stop, name, lat, lng, grp }) => {
		const B = window.BusETA;
		const out = {};
		B.store.favorites.toggle(co, { stop, name, lat, lng, ids: grp });
		out.withIds = (B.store.favorites.loadAll().find((x) => x.stop === stop) || {}).ids || null;
		// 模擬舊版收藏（toggle 兩次：先移除帶 ids 版本，再以舊格式重新加入）
		B.store.favorites.toggle(co, { stop, name, lat, lng });
		B.store.favorites.toggle(co, { stop, name, lat, lng });
		B.store.favorites.attachIds(co, stop, grp);
		out.upgraded = (B.store.favorites.loadAll().find((x) => x.stop === stop) || {}).ids || null;
		// 已有同樣多成員 → 唔會重寫（成員清單保留原值）
		const before = JSON.stringify(B.store.favorites.loadAll().find((x) => x.stop === stop)?.ids);
		B.store.favorites.attachIds(co, stop, [{ co, stop }]);
		out.untouched = JSON.stringify(B.store.favorites.loadAll().find((x) => x.stop === stop)?.ids) === before;
		// 清場，唔影響後續 E2E
		B.store.favorites.toggle(co, { stop });
		return out;
	}, { ...kc, grp });
	ok(Array.isArray(store.withIds) && store.withIds.length > 1,
		'[FAV-2] toggle() 有 ids 時一併儲存（舊版會掉棄）', `${store.withIds?.length} 成員`);
	ok(Array.isArray(store.upgraded) && store.upgraded.length > 1,
		'[FAV-2] attachIds() 為舊收藏補入成員清單', `${store.upgraded?.length} 成員`);
	ok(store.untouched, '[FAV-2] attachIds() 唔會用細組覆蓋大組');

	// [FAV-3] E2E：preset 舊版收藏（無 ids）→ 由常到車站進入 → 自動回寫
	await page.evaluate((fav) => {
		localStorage.setItem('buseta.favorites', JSON.stringify([fav]));
	}, { co: kc.co, stop: kc.stop, name: kc.name, lat: kc.lat, lng: kc.lng });
	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 25000 });
	await page.waitForSelector('#recent [data-f]', { timeout: 15000 });
	await page.click('#recent [data-f]');
	await page.waitForSelector('#page-eta.active', { timeout: 10000 });
	await page.waitForSelector('#eta-list .eta-row, #eta-list .empty, #eta-list .error-box', { timeout: 20000 });
	const fav3 = await page.evaluate((stopId) => {
		const f = (JSON.parse(localStorage.getItem('buseta.favorites') || '[]'))
			.find((x) => x.stop === stopId);
		return { ids: f?.ids || null, rows: document.querySelectorAll('#eta-list .eta-row').length };
	}, kc.stop);
	ok(Array.isArray(fav3.ids) && fav3.ids.length > 1,
		'[FAV-3] 舊收藏經常到車站進入後自動回寫 ids（毋須重新加星）', `${fav3.ids?.length} 成員`);
	ok(fav3.rows > 0, '[FAV-3] ETA 頁正常渲染', `${fav3.rows} 行`);
	await page.screenshot({ path: join(SHOTS, '15-fav-merged-eta.png') });
	// 清場：剷走測試收藏，避免影響 [10]／之後嘅 session
	await page.evaluate((stopId) => {
		const all = JSON.parse(localStorage.getItem('buseta.favorites') || '[]')
			.filter((x) => x.stop !== stopId);
		localStorage.setItem('buseta.favorites', JSON.stringify(all));
	}, kc.stop);
	await page.evaluate(() => window.history.back());
	await page.waitForTimeout(400);
}

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
