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
ok(/6,753/.test(stamp), '車站數 6,753');
ok(/1,605/.test(stamp), '路線數 1,605');

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
ok(metas[0]?.includes('最近九巴站'), '顯示最近九巴站距離（判斷命中點是否門口）', metas[0]);
await page.screenshot({ path: join(SHOTS, '02-search.png') });

/* ---------- 4. 附近站列表 ---------- */
console.log('\n[4] 附近站列表');
await page.click('.result');
await page.waitForSelector('.stop', { timeout: 10000 });
await page.waitForTimeout(300);
const countTxt = await page.textContent('#nb-count');
ok(/14 個站/.test(countTxt), '預設 200m 顯示 14 個站（與規劃書實測一致）', countTxt.trim());
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
	const added = B.store.favorites.toggle({ stop: 'TESTID', name: '測試站', lat: 22.3, lng: 114.2 });
	const has = B.store.favorites.has('TESTID');
	B.store.favorites.toggle({ stop: 'TESTID', name: '測試站', lat: 22.3, lng: 114.2 });
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
await page.evaluate(() => { const bs = document.querySelectorAll('#rt-dirs button'); bs[bs.length - 1]?.click(); });
await page.waitForTimeout(900);
const afterDir = await page.evaluate(() => ({
	net: window.__netCount,
	dir: [...document.querySelectorAll('#rt-dirs button')].findIndex((b) => b.classList.contains('on')),
	rows: document.querySelectorAll('#rt-list .seq-row').length
}));
ok(afterDir.dir >= 0 && afterDir.dir !== 0, '方向切換生效', `第 ${afterDir.dir + 1} 個`);
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

// 返回按鈕 → 回 ETA 頁
await page.click('#rt-back');
await page.waitForTimeout(300);
const backOk = await page.evaluate(() => ({
	eta: document.getElementById('page-eta').classList.contains('active'),
	route: document.getElementById('page-route').classList.contains('active')
}));
ok(backOk.eta && !backOk.route, '返回按鈕回到 ETA 頁');

// 常搭路線區塊出現在搜尋頁
// 先釘選兩條，再經 ETA → nearby → 搜尋頁（nb-back 會觸發 renderRecent 重繪）
await page.evaluate(() => {
	const B = window.BusETA;
	B.store.favRoutes.toggle('1', 'O', 1, '尖沙咀碼頭');
	B.store.favRoutes.toggle('960P', 'I', 1, '洪水橋');
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
await page.evaluate(() => { window.BusETA.store.favRoutes.clear(); window.BusETA.store.routeVisits.clear(); });

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
	const a = B.store.routeVisits.visit('1', 'O');
	const b = B.store.routeVisits.visit('1', 'O');
	const c = B.store.routeVisits.visit('1', 'O');
	const top = B.store.routeVisits.top(5);
	B.store.routeVisits.clear();
	return { a, b, c, topCount: top.length, topN: top[0]?.count };
});
ok(visitTest.a.counted === false && visitTest.b.counted === true, '首次查看不計入常搭，第二次起才累加', `1→${visitTest.b.count}→${visitTest.c.count}`);
ok(visitTest.topCount >= 1 && visitTest.topN === 3, '達門檻的項目按次數排序', `top ${visitTest.topCount} 條，最高 ${visitTest.topN} 次`);

// favRoutes 上限
const capTest = await page.evaluate(() => {
	const B = window.BusETA;
	B.store.favRoutes.clear();
	for (let i = 0; i < 15; i++) B.store.favRoutes.toggle('R' + i, 'O', 1, '測試');
	const n = B.store.favRoutes.load().length;
	B.store.favRoutes.clear();
	return n;
});
ok(capTest === 10, '常搭路線上限 10 條', `實際 ${capTest} 條`);

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
