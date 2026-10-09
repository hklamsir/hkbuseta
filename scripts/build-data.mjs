/**
 * M0 — 離線資料打包腳本（多公司）
 *
 * 抓取運輸署開放數據（KMB/LWB + CTB/前新巴）靜態資料 → 精簡 → gzip → public/data/
 *
 *   node scripts/build-data.mjs            # 兩家公司全建
 *   node scripts/build-data.mjs --only=ctb # 只重建其中一家（站點資料極少變，可跨 build 複用）
 *
 * 設計重點（見規劃書 §5.2、CTB-adapter 計劃書 Phase 0）：
 *   - 刪除冗餘欄位（co 永遠固定、data_timestamp 每日重覆）
 *   - 字串 ID（stop ID、路線號）改為整數索引 → gzip 壓縮率大幅提升
 *   - 座標轉為整數微度（1e-7 ≈ 1.1cm，遠超 GPS 精度需求）
 *   - **決定性**：輸出內容不可含時間戳或請求完成次序，否則 buildId 每日必變
 *   - **多公司**：manifest 同時保留 top-level buildId（sw.js resolveShellCache 讀佢）
 *     與 companies.{kmb,ctb} 結構（data.js 各 adapter 讀自己嗰份 files）
 *
 * CTB 與 KMB 的關鍵差異（無 bulk stop 端點）：
 *   KMB：GET /stop 一次過返全部站
 *   CTB：/stop/{id} 只收單站 → 必須先經 route-stop 枚舉所有 stop ID 再逐站抓
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { gzipSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const UA = 'BusETA-DataBuilder/1.0 (open-data packaging script)';

/** 同時抓幾個請求（避免觸發官方限流） */
const CONCURRENCY = 8;

/** 只重建指定公司（--only=ctb），否則兩家全建 */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const COMPANIES = {
	kmb: {
		id: 'kmb',
		label: '九巴及龍運',
		base: 'https://data.etabus.gov.hk/v1/transport/kmb',
		prefix: ''            // 檔名前綴：'' → stops.json.gz / routes.json.gz（保持向後兼容）
	},
	ctb: {
		id: 'ctb',
		label: '城巴及新巴',
		base: 'https://rt.data.gov.hk/v1/transport/citybus-nwfb',
		prefix: 'ctb-'        // 檔名前綴：'ctb-' → ctb-stops.json.gz / ctb-routes.json.gz
	}
};

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * 抓 JSON。回傳整個 json（各公司錯誤形狀不同，判斷交由 caller）。
 * @param {string} base API base URL
 * @param {string} path 相對路徑
 * @param {boolean} quiet 抑制逐筆 log（並發抓站點時用）
 */
async function fetchJson(base, path, attempt = 1, quiet = false) {
	const url = `${base}/${path}`;
	const log = quiet ? () => {} : (s) => process.stdout.write(s);
	if (!quiet) log(`  GET ${path} (嘗試 ${attempt}) ... `);
	try {
		const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
		if (res.status === 403 || res.status === 429) {
			log(`HTTP ${res.status}`);
			if (attempt < 4) {
				const wait = attempt * 3000;
				log(`，${wait / 1000}s 後重試\n`);
				await sleep(wait);
				return fetchJson(base, path, attempt + 1, quiet);
			}
			throw new Error(`HTTP ${res.status}（已重試 ${attempt - 1} 次）`);
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		const json = JSON.parse(text);
		// 兩家公司錯誤形狀不同：
		//   KMB { code:"422", message:"..." }
		//   CTB { message:"...", ... }（HTTP 422，body 形狀不同）
		if (json.code && json.data === undefined) {
			throw new Error(`API error ${json.code}: ${json.message}`);
		}
		if (json.data === undefined && json.message) {
			throw new Error(`API error: ${json.message}`);
		}
		// data 可能是陣列（KMB）或物件（CTB /stop/{id}）
		const n = Array.isArray(json.data) ? json.data.length : 1;
		log(`${(text.length / 1024).toFixed(0)} KB, ${n} 筆\n`);
		return json;
	} catch (e) {
		// 網絡層錯誤（DNS／連線中斷）也重試
		if (attempt < 4 && !/HTTP \d{3}$/.test(e.message)) {
			const wait = attempt * 3000;
			log(`失敗（${e.message}），${wait / 1000}s 後重試\n`);
			await sleep(wait);
			return fetchJson(base, path, attempt + 1, quiet);
		}
		throw e;
	}
}

/**
 * 有界並發 map。
 * ⚠️ 必須保持**輸出次序 = 輸入次序**，否則決定性重排失效。
 */
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (i < items.length) {
			const idx = i++;
			out[idx] = await fn(items[idx], idx);
		}
	});
	await Promise.all(workers);
	return out;
}

function gzipToFile(name, obj) {
	const raw = Buffer.from(JSON.stringify(obj), 'utf8');
	const gz = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
	return { name, raw, gz };
}

/** route|dir|svc —— CTB 冇 svc，恆為 1 */
function routeKey(route, bound, svc) {
	return `${route}|${bound}|${svc}`;
}

/* ==================== KMB / LWB ==================== */

async function buildKmb() {
	const cfg = COMPANIES.kmb;
	console.log(`\n━━━ ${cfg.label}（KMB）━━━`);

	console.log('[1/3] /stop');
	const stopRows = (await fetchJson(cfg.base, 'stop')).data;

	console.log('[2/3] /route/');
	const routeRows = (await fetchJson(cfg.base, 'route/')).data;

	console.log('[3/3] /route-stop');
	const rsRows = (await fetchJson(cfg.base, 'route-stop')).data;

	// ---- 精簡車站表 ----
	// ["stopId16", "中文名", latE7, lngE7]
	const stops = stopRows.map((s) => [s.stop, s.name_tc, Math.round(parseFloat(s.lat) * 1e7), Math.round(parseFloat(s.long) * 1e7)]);
	const stopIndex = new Map();
	stops.forEach((s, i) => stopIndex.set(s[0], i));

	// ---- 精簡路線表 ----
	// ["route", "bound", serviceType, dest_tc]
	const routes = routeRows.map((r) => [r.route, r.bound, parseInt(r.service_type, 10), r.dest_tc]);
	const routeIndex = new Map();
	routes.forEach((r, i) => routeIndex.set(routeKey(r[0], r[1], r[2]), i));

	// ---- 精簡路線站序 ----
	// [routeIdx, seq, stopIdx]
	const routeStops = [];
	let missingStop = 0, missingRoute = 0;
	for (const rs of rsRows) {
		const svc = parseInt(rs.service_type, 10);
		const ri = routeIndex.get(routeKey(rs.route, rs.bound, svc));
		const si = stopIndex.get(rs.stop);
		if (ri === undefined) { missingRoute++; continue; }
		if (si === undefined) { missingStop++; continue; }
		routeStops.push([ri, parseInt(rs.seq, 10), si]);
	}
	routeStops.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

	console.log(`\n精簡結果：`);
	console.log(`  車站       ${stops.length} 個`);
	console.log(`  路線       ${routes.length} 條`);
	console.log(`  路線站序${routeStops.length.toLocaleString()} 筆`);
	if (missingRoute) console.warn(`  ⚠ 跳過 ${missingRoute} 筆找不到路線定義的關聯`);
	if (missingStop) console.warn(`  ⚠ 跳過 ${missingStop} 筆找不到車站的關聯`);

	return {
		stops, routes, routeStops,
		files: [
			gzipToFile(`${cfg.prefix}stops.json.gz`, { v: 1, data: stops }),
			gzipToFile(`${cfg.prefix}routes.json.gz`, { v: 1, routes, routeStops })
		]
	};
}

/* ==================== CTB / 前新巴 ==================== */

/**
 * CTB 車站資料快取（RC1 緩解）。
 *
 * CTB 冇 bulk stop 端點 → 每次 build 都要 ~2600 個 /stop/{id} 請求（實測約 5 分鐘）。
 * 但車站的名稱與座標**極少變動**（增站/改名係低頻事件），
 * 故把已抓到的 stop 資料存落本地，重跑時先讀快取、缺的才向官方補抓。
 *
 * ⚠️ 對確定性的影響：**零**。
 *   輸出次序完全由 stopIdsFirstSeen 決定（見 buildCtb 步驟 2/4），
 *   與「資料來自快取抑或網絡」及「請求完成次序」都無關。
 *   故 [CTB-1b] 連跑兩次 buildId 相同仍然成立。
 *
 * 失效策略：快取只記錄已成功抓到的 stop；官方改資料時需人手刪 .build-cache/ 重抓。
 * 加 --refresh-stops 可強制忽略快取。
 */
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.build-cache');
const CACHE_FILE = join(CACHE_DIR, 'ctb-stops.json');
const REFRESH_STOPS = process.argv.includes('--refresh-stops');

async function loadStopCache() {
	if (REFRESH_STOPS) return new Map();
	try {
		const txt = await readFile(CACHE_FILE, 'utf8');
		const obj = JSON.parse(txt);
		return new Map(Object.entries(obj));
	} catch { return new Map(); }
}

async function saveStopCache(map) {
	try {
		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(map)), 'utf8');
	} catch (e) {
		console.warn(`  ⚠ 快取寫入失敗（不影響本次 build）：${e.message}`);
	}
}

/**
 * 逐站取 CTB 車站資料，優先用本地快取。
 * @returns {Array} 與 stopIds **同序同長** 的物件陣列（失敗者為 null）
 */
async function fetchCtbStops(stopIds, base) {
	const cache = await loadStopCache();
	let hit = 0;
	const missing = stopIds.filter((sid) => {
		if (cache.has(sid)) { hit++; return false; }
		return true;
	});
	console.log(`  快取命中 ${hit}／${stopIds.length}${missing.length ? `，補抓 ${missing.length} 個` : '，全部命中'}`);
	if (REFRESH_STOPS) console.log('  （--refresh-stops：忽略快取，全部重抓）');

	let done = 0;
	const fetched = await mapLimit(missing, CONCURRENCY, async (sid) => {
		const json = await fetchJson(base, `stop/${sid}`, 1, true);
		const d = json.data;      // ⚠️ CTB /stop/{id} 的 data 係**物件**（非陣列）
		if (d && d.stop != null) {
			cache.set(sid, d);
			done++;
			if (done % 250 === 0) process.stdout.write(`  … 已抓 ${done}/${missing.length}\n`);
			return d;
		}
		done++;
		return null;
	});
	await saveStopCache(cache);

	// ⚠️ 決定性：按 stopIds 原次序組裝，絕不用 fetched 的完成次序
	return stopIds.map((sid) => {
		const c = cache.get(sid);
		if (c) return typeof c === 'string' ? JSON.parse(c) : c;
		return null;
	});
}

async function buildCtb() {
	const cfg = COMPANIES.ctb;
	console.log(`\n━━━ ${cfg.label}（CTB）━━━`);
	console.log('註：2023 專營權合併後，前新巴路線已併入 company_id = CTB，故同一份資料覆蓋兩者。');

	// ---- 1. 路線清單 ----
	console.log('\n[1/4] /route/CTB');
	const routeListRaw = (await fetchJson(cfg.base, 'route/CTB')).data;
	const routeMeta = new Map();   // route → {orig_tc, dest_tc}
	for (const r of routeListRaw) {
		if (!routeMeta.has(r.route)) routeMeta.set(r.route, { orig: r.orig_tc || '', dest: r.dest_tc || '' });
	}
	const routes = [...routeMeta.keys()].sort();   // 排序 → 決定性
	console.log(`  ${routes.length} 條路線`);

	// ---- 2. 枚舉路線站序，同時記低 unique stop ID（first-seen 次序）----
	//
	// ⚠️ 決定性關鍵：stop ID 的收集次序必須由「路線排序 + seq 排序」決定，
	//    而**唔係** request 完成次序。否則 /stop 並發抓取回來後 buildId 每日都不同。
	console.log(`[2/4] /route-stop/CTB/{route}/{inbound|outbound} × ${routes.length} 條`);
	const rsChunks = await mapLimit(routes, CONCURRENCY, async (route) => {
		const out = [];
		for (const dirWord of ['inbound', 'outbound']) {
			const json = await fetchJson(cfg.base, `route-stop/CTB/${route}/${dirWord}`, 1, true);
			for (const r of json.data || []) out.push(r);
		}
		return out;
	});

	// 依 (route 排序, seq 排序) 收集 → 保證與請求完成次序無關
	const stopIdsFirstSeen = [];
	const seenStop = new Set();
	const allRs = [];
	for (const chunk of rsChunks) {
		chunk.sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10));
		for (const rs of chunk) {
			allRs.push(rs);
			const sid = rs.stop;
			if (sid != null && !seenStop.has(sid)) {
				seenStop.add(sid);
				stopIdsFirstSeen.push(sid);
			}
		}
	}
	console.log(`  ${allRs.length.toLocaleString()} 筆站序，${stopIdsFirstSeen.length} 個獨立車站`);

	// ---- 3. 逐站抓 /stop/{stop_id} ----
	//
	// ⚠️ stop_id 係 **6 位 zero-padded 字串**（如 002737），唔可以當數字傳。
	// ⚠️ CTB /stop/{id} 回應的 data 係**物件**（非陣列），故 json.data.length 為 undefined。
	console.log(`[3/4] /stop/{stop_id} × ${stopIdsFirstSeen.length}（並發 ${CONCURRENCY}）`);
	const stopObjs = await fetchCtbStops(stopIdsFirstSeen, cfg.base);

	// ---- 4. 決定性重排：按 first-seen 次序輸出 ----
	//
	// ⚠️ 本步驟係 RC9 的直接對策：/stop 係並發抓取，完成次序不確定。
	//    必須以 stopIdsFirstSeen 的次序重建，否則 gz 內容 → buildId 每日不同。
	const stops = [];
	const stopIndex = new Map();
	for (const d of stopObjs) {
		if (!d) continue;
		const row = [
			d.stop,
			d.name_tc || '',
			Math.round(parseFloat(d.lat) * 1e7),
			Math.round(parseFloat(d.long) * 1e7)
		];
		stopIndex.set(row[0], stops.length);
		stops.push(row);
	}
	const noStop = stopObjs.filter((d) => !d).length;
	if (noStop) console.warn(`  ⚠ ${noStop} 個車站抓取失敗（已略過）`);

	// ---- 精簡路線表 ----
	// ["route", dir, 1, dest]，**dest 按方向映射：O → dest_tc、I → orig_tc**
	//
	// ⚠️ 為何要按方向映射：CTB /route/CTB 每條路線只有 orig_tc / dest_tc 各一份，冇 bound。
	//    route-stop 的 dir 欄位係 'I'/'O'（data 層），URL 則用 inbound/outbound。
	//    若兩方向都存同一個端點，其中一個方向必定顯示錯終點。
	//
	// 【映射方向實測（2026-10-09，7 條路線抽樣，全數命中）】
	//   dir='O'（outbound，開往終點）→ dest_tc
	//   dir='I'（inbound，往總站）   → orig_tc
	//   證據（route 1）：
	//     /route/CTB → orig_tc=中環 (港澳碼頭)、dest_tc=跑馬地 (上)
	//     DPO batch ETA 對 dir='O' 的班次回 dest=跑馬地(上)  ← 等於 dest_tc
	//     /route-stop/CTB/1/inbound（dir=I）末站 = 001027 = 中環 (港澳碼頭) = orig_tc
	//   亦與 app.js 的顯示慣例一致（I = 「往總站方向」、O = 「開往終點」）。
	const routeList = [];
	const routeIndex = new Map();
	for (const r of routes) {
		const meta = routeMeta.get(r);
		if (!meta) continue;
		for (const dir of ['I', 'O']) {
			const dest = dir === 'O' ? meta.dest : meta.orig;
			const idx = routeList.length;
			routeList.push([r, dir, 1, dest]);
			routeIndex.set(routeKey(r, dir, 1), idx);
		}
	}

	// ---- 精簡路線站序 ----
	const routeStops = [];
	let missingStop = 0, missingRoute = 0;
	for (const rs of allRs) {
		const dir = rs.dir === 'I' ? 'I' : 'O';
		const ri = routeIndex.get(routeKey(rs.route, dir, 1));
		const si = stopIndex.get(rs.stop);
		if (ri === undefined) { missingRoute++; continue; }
		if (si === undefined) { missingStop++; continue; }
		routeStops.push([ri, parseInt(rs.seq, 10), si]);
	}
	routeStops.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

	console.log(`\n精簡結果：`);
	console.log(`  車站       ${stops.length} 個`);
	console.log(`  路線方向   ${routeList.length} 條`);
	console.log(`  路線站序${routeStops.length.toLocaleString()} 筆`);
	if (missingRoute) console.warn(`  ⚠ 跳過 ${missingRoute} 筆找不到路線定義的關聯`);
	if (missingStop) console.warn(`  ⚠ 跳過 ${missingStop} 筆找不到車站的關聯`);

	// 抽樣驗證方向映射：route 1 的 O 應該去 dest_tc（跑馬地 (上)）
	const sample = routeList.filter((x) => x[0] === '1');
	if (sample.length) {
		console.log(`  方向映射抽樣 route 1（期望 O→跑馬地 (上)、I→中環 (港澳碼頭)）：`);
		for (const [rno, dir, svc, dest] of sample) console.log(`    ${dir} → ${dest}`);
	}

	return {
		stops, routes: routeList, routeStops,
		files: [
			gzipToFile(`${cfg.prefix}stops.json.gz`, { v: 1, data: stops }),
			gzipToFile(`${cfg.prefix}routes.json.gz`, { v: 1, routes: routeList, routeStops })
		]
	};
}

/* ==================== 主流程 ==================== */

async function main() {
	console.log(`M0 — 抓取靜態離線資料（多公司）${ONLY ? `，只建 ${ONLY}` : ''}\n`);
	const t0 = Date.now();

	await mkdir(OUT_DIR, { recursive: true });

	const builtAt = new Date();
	const companies = {};
	const allFiles = [];

	for (const id of ['kmb', 'ctb']) {
		if (ONLY && ONLY !== id) continue;
		const r = id === 'kmb' ? await buildKmb() : await buildCtb();

		// 單公司 buildId（该公司自己檔案的 raw hash）
		const h = createHash('sha256');
		for (const f of r.files) h.update(f.raw);
		const coBuildId = h.digest('hex').slice(0, 8);

		companies[id] = {
			label: COMPANIES[id].label,
			buildId: coBuildId,
			stops: r.stops.length,
			routes: r.routes.length,
			routeStops: r.routeStops.length,
			files: r.files.map((f) => ({ name: f.name, raw: f.raw.length, gz: f.gz.length }))
		};
		allFiles.push(...r.files);

		for (const f of r.files) {
			await writeFile(join(OUT_DIR, f.name), f.gz);
			const ratio = ((1 - f.gz.length / f.raw.length) * 100).toFixed(1);
			console.log(`\n  ${f.name}`);
			console.log(`    原始 ${(f.raw.length / 1024).toFixed(0).padStart(6)} KB`);
			console.log(`    gzip ${(f.gz.length / 1024).toFixed(0).padStart(6)} KB  （壓縮率 ${ratio}%）`);
		}
	}

	if (!Object.keys(companies).length) throw new Error(`未知的 --only 值：${ONLY}`);

	const totalGz = allFiles.reduce((s, f) => s + f.gz.length, 0);
	const totalRaw = allFiles.reduce((s, f) => s + f.raw.length, 0);
	console.log(`\n  合計 ${(totalRaw / 1024).toFixed(0)} KB → ${(totalGz / 1024).toFixed(0)} KB`);

	// buildId = **未壓縮 JSON 內容**的 hash 前 8 碼（不是 gz 的 hash）
	//
	// 為何用 raw 而非 gz：gzip 輸出位元組依賴 zlib 版本。本機 Windows 與
	// GitHub Actions ubuntu-latest 的 zlib patch 版本可能不同 → 即使資料完全相同，
	// 兩邊產出的 gz 位元組仍可能不一致。若 buildId 取自 gz，CI 會每日誤判「資料有變」。
	// raw JSON 內容跨平台穩定，故 buildId 只反映真正的資料變化。
	//
	// ⚠️ raw 必須按**固定的公司次序**疊加（kmb 先、ctb 後），不可依 Object 迭代次序，
	//    否則 buildId 會隨機會話次序變動。
	const orderedRaw = [];
	for (const id of ['kmb', 'ctb']) {
		if (!companies[id]) continue;
		const names = companies[id].files.map((f) => f.name);
		for (const f of allFiles) if (names.includes(f.name)) orderedRaw.push(f);
	}
	const h2 = createHash('sha256');
	for (const f of orderedRaw) h2.update(f.raw);
	const buildId = h2.digest('hex').slice(0, 8);

	const manifest = {
		built: builtAt.toISOString(),
		// 顯示用時間（Y-M-D H:M），供前端 UI 顯示「更新於 …」；不參與任何 hash
		updated: builtAt.toISOString().slice(0, 16).replace('T', ' '),
		// ⚠️ top-level buildId 必須保留 —— sw.js 的 resolveShellCache 讀佢。
		//    值 = 所有公司檔案 raw 內容 hash（任一家變動都會令 SW 快取名改變）。
		buildId,
		// 向後兼容欄位（= kmb 的統計），舊版 data.js 仍可讀
		stops: companies.kmb?.stops ?? 0,
		routes: companies.kmb?.routes ?? 0,
		routeStops: companies.kmb?.routeStops ?? 0,
		files: companies.kmb?.files ?? [],
		// 多公司結構：各 adapter 讀自己嗰份 files
		companies
	};
	await writeFile(join(OUT_DIR, 'build-manifest.json'), JSON.stringify(manifest, null, 2));

	console.log(`\n  buildId: ${buildId}（Service Worker 快取名 buseta-shell-${buildId}-<殼層hash>）`);
	for (const [id, co] of Object.entries(companies)) {
		console.log(`    ${id}（${co.label}）buildId ${co.buildId} · ${co.stops} 站 · ${co.routes} 路線方向`);
	}
	console.log(`  打包時間: ${manifest.updated}（不參與 buildId，資料無變則 buildId 不變）`);
	console.log(`✅ 完成，耗時 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

main().catch((e) => {
	console.error(`\n❌ ${e.message}`);
	process.exit(1);
});
