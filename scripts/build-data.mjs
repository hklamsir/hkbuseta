/**
 * M0 — 離線資料打包腳本（多公司）
 *
 * 抓取運輸署開放數據（KMB/LWB + CTB/前新巴）靜態資料 → 精簡 → gzip → public/data/
 *
 *   node scripts/build-data.mjs            # 兩家公司全建
 *   node scripts/build-data.mjs --only=ctb # 只重建其中一家（站點資料極少變，可跨 build 複用）
 *
 * 設計重點（見規劃書 §5.2、CTB-adapter 計劃書 Phase 0、跨公司合併計劃書 M9）：
 *   - 刪除冗餘欄位（co 永遠固定、data_timestamp 每日重覆）
 *   - 字串 ID（stop ID、路線號）改為整數索引 → gzip 壓縮率大幅提升
 *   - 座標轉為整數微度（1e-7 ≈ 1.1cm，遠超 GPS 精度需求）
 *   - **決定性**：輸出內容不可含時間戳或請求完成次序，否則 buildId 每日必變
 *   - **多公司**：manifest 同時保留 top-level buildId（sw.js resolveShellCache 讀佢）
 *     與 companies.{kmb,ctb} 結構（data.js 各 adapter 讀自己嗰份 files）
 *   - **跨公司配對（M9）**：產出 cross.stops（站點配對）與 cross.dirs（方向對應），
 *     掛喺 ctb-routes.json.gz。兩者回答不同問題，詳見 computeStopPairs / computeDirMap。
 *
 * CTB 與 KMB 的關鍵差異（無 bulk stop 端點）：
 *   KMB：GET /stop 一次過返全部站
 *   CTB：/stop/{id} 只收單站 → 必須先經 route-stop 枚舉所有 stop ID 再逐站抓
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { gzipSync, gunzipSync, constants } from 'node:zlib';
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

/* ==================== M9 跨公司車站配對 ==================== */

/**
 * 跨公司車站配對（M9，見 docs/跨公司車站合併計劃書.md §4）。
 *
 * 兩張表：
 *   cross.stops = 站點配對（「這兩個站是同一個物理站嗎」）
 *   cross.dirs  = 方向對應（「這兩條線是同一條巴士嗎、方向字母如何對應」）
 *
 * ⚠️ 兩者回答**不同**問題，不可互相取代（實測教訓）：
 *   · stops 解決「維景酒店 KC333/KC334 + 城巴 001616 合併成一項」
 *   · dirs  解決「103 九巴 I 與城巴 O 其實同一方向，不應顯示成兩行」
 */

const EARTH_R = 6371000;      // 公尺
const PAIR_MAX_DIST = 80;     // 配對距離上限（公尺）
const GRID_DEG = 0.0006;      // 網格邊長 ≈ 66m；3×3 鄰域覆蓋 ≈ 132m > 80m 門檻
const DIR_COLLIDE_MAX = 0.2;  // Jaccard < 此值 = 撞號（路線號相同但完全唔相干）
const DIR_CONFIRM_MIN = 0.5;  // Jaccard ≥ 此值 = 確認同一走廊

/** Haversine 距離（公尺） */
function haversineM(lat1, lng1, lat2, lng2) {
	const p = Math.PI / 180;
	const dLat = (lat2 - lat1) * p;
	const dLng = (lng2 - lng1) * p;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/**
 * 站名正規化（僅用於跨公司比對）。
 *
 * 兩家命名差異是系統性的（實測 2026-10-09）：
 *   · 九巴帶分站編碼：「九龍維景酒店 (KC334)」「牛頭角站 (KT691)」
 *   · 城巴 88%（2,267/2,587）用「地標, 街道」逗號格式：「林士街, 德輔道中」
 *     （九巴只有 2% 用逗號）
 * 故比對前必須兩者都剝除，否則字串比對必然大量失敗。
 *
 * ⚠️ 此處**刻意不同於** data.js 的 groupKey()：那個只剝 (CODE)，
 *    因為正常分組顯示要保留「街道/分站」資訊；跨公司比對則只關心「邊個地點」。
 */
function normalizeStopName(name) {
	return String(name || '')
		.replace(/\s*\([^)]*\)\s*$/, '')   // 剝除尾部 (KC334) 分站編碼
		.replace(/[，,].*$/, '')            // 剝除「, 街道」後綴
		.trim();
}

/** 兩集合的 Jaccard 相似度 */
function jaccard(a, b) {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	const union = a.size + b.size - inter;
	return union ? inter / union : 0;
}

/** 網格鍵（度数） */
function cellKey(lat, lng) {
	return `${Math.round(lng / GRID_DEG)},${Math.round(lat / GRID_DEG)}`;
}

/**
 * 由精簡後的離線資料建配對所需的中間結構。
 * 兩家 schema 同構，故一個函式服務兩邊（連 --only=ctb 從磁碟讀九巴都用同一個）。
 *
 * @param {Array} stops     [id, name, latE7, lngE7][]
 * @param {Array} routes    [route, dir, svc, dest][]
 * @param {Array} routeStops [routeIdx, seq, stopIdx][]
 */
function buildMeta(stops, routes, routeStops) {
	const byId = new Map();
	for (const [id, name, la, ln] of stops) {
		byId.set(id, {
			id,
			name,
			norm: normalizeStopName(name),
			lat: la / 1e7,
			lng: ln / 1e7,
			routes: new Set()   // 此站服務的路線號（不分公司，僅用於配對訊號）
		});
	}

	// route → [{dir, svc, names:Set}]（names 用正規化名，Jaccard 用）
	const variants = new Map();
	for (const [ri, seq, si] of routeStops) {
		const r = routes[ri];
		if (!r) continue;
		const [route, dir, svc] = r;
		const row = stops[si];
		if (!row) continue;
		const s = byId.get(row[0]);
		if (s) s.routes.add(route);

		let arr = variants.get(route);
		if (!arr) variants.set(route, (arr = []));
		let v = null;
		for (const x of arr) { if (x.dir === dir && x.svc === svc) { v = x; break; } }
		if (!v) arr.push((v = { dir, svc, names: new Set() }));
		v.names.add(normalizeStopName(row[1]));
	}

	return { stops: [...byId.values()], variants };
}

/**
 * 站點配對：對每個城巴站搵最近的九巴站。
 *
 * 條件（實測調校，見計劃書 §4.2）：
 *   1. 距離 ≤ PAIR_MAX_DIST（80m）
 *   2. **必須有共用路線號**（距離本身不可靠：50-80m 區間準確率只有 41%）
 *   評分：共用數 × 1000 + 站名相同 × 500 − 距離
 *   → 取最高分；一個九巴站可對應多個城巴站（一對多，實測 53 組，全部合理）
 *
 * ⚠️ 網格**只係候選過濾器**，最終判定由精確 Haversine 決定。
 *    故網格大小錯咗只會影響速度，唔會影響正確性。
 *
 * @returns {Map<string, string[]>} kmbStopId → [ctbStopId, ...]（已排序）
 */
function computeStopPairs(kmbMeta, ctbMeta) {
	const grid = new Map();
	for (const s of kmbMeta.stops) {
		const k = cellKey(s.lat, s.lng);
		let arr = grid.get(k);
		if (!arr) grid.set(k, (arr = []));
		arr.push(s);
	}

	const pairs = new Map();
	for (const c of ctbMeta.stops) {
		if (!c.routes.size) continue;
		const gx = Math.round(c.lng / GRID_DEG);
		const gy = Math.round(c.lat / GRID_DEG);

		let best = null;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const arr = grid.get(`${gx + dx},${gy + dy}`);
				if (!arr) continue;
				for (const k of arr) {
					const d = haversineM(c.lat, c.lng, k.lat, k.lng);
					if (d > PAIR_MAX_DIST) continue;
					let inter = 0;
					for (const r of c.routes) if (k.routes.has(r)) inter++;
					if (!inter) continue;              // 必須有共用路線號
					const score = inter * 1000 + (c.norm === k.norm ? 500 : 0) - d;
					if (!best || score > best.score) best = { k, score };
				}
			}
		}
		if (best) {
			let arr = pairs.get(best.k.id);
			if (!arr) pairs.set(best.k.id, (arr = []));
			arr.push(c.id);
		}
	}

	// 決定性：kmbId 排序、每組內 ctbId 排序
	for (const arr of pairs.values()) arr.sort();
	return new Map([...pairs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * 方向對應：判定兩家同號路線是否同一走廊，並求出方向字母如何對應。
 *
 * ⚠️ 為何必須預計算（實測 2026-10-09，見計劃書 §2.2）：
 *   在 43 條確認同一走廊的路線中，**17 條字母相反、26 條字母相同**。
 *   → 冇任何全域規則可用（「九巴恆等於城巴」或「恆相反」都錯），
 *     必須逐條實測。
 *
 * 撞號處理（§2.3）：149 個共用路線號中 **55 個是撞號**（路線 1 九巴→尖沙咀碼頭 /
 * 城巴→中環(港澳碼頭)，站序重疊 0.00）。故必須用全線站序比對，唔可以只看路線號。
 *
 * @returns {{dirs:Object, shared:number, collide:number, uncertain:number}}
 */
function computeDirMap(kmbMeta, ctbMeta) {
	const dirs = {};
	let shared = 0, collide = 0, uncertain = 0;

	// 決定性：按路線號排序迭代
	for (const route of [...kmbMeta.variants.keys()].sort()) {
		const kVars = kmbMeta.variants.get(route);
		const cVars = ctbMeta.variants.get(route);
		if (!cVars || !cVars.length) continue;
		shared++;

		let best = null;
		for (const kv of kVars) {
			for (const cv of cVars) {
				const j = jaccard(kv.names, cv.names);
				if (j >= DIR_CONFIRM_MIN && (!best || j > best.j)) {
					best = { j, kDir: kv.dir, cDir: cv.dir };
				}
			}
		}

		if (best) {
			// 記錄方向字母對應。s 保留一位小數供日後 audit／debug。
			dirs[route] = { k: best.kDir, c: best.cDir, s: Math.round(best.j * 100) / 100 };
		} else {
			// 撞號 vs 信度不足：兩者都不建立對應（保守，避免誤合方向）
			let anyJ = 0;
			for (const kv of kVars) for (const cv of cVars) anyJ = Math.max(anyJ, jaccard(kv.names, cv.names));
			if (anyJ < DIR_COLLIDE_MAX) collide++; else uncertain++;
		}
	}

	// 決定性：路線號排序輸出
	const sorted = {};
	for (const k of Object.keys(dirs).sort()) sorted[k] = dirs[k];
	return { dirs: sorted, shared, collide, uncertain };
}

/**
 * 從磁碟讀回九巴離線資料（`--only=ctb` 時用）。
 * 跨公司配對需要九巴作對象，但 --only 模式下唔會重抓九巴。
 */
async function loadCompanyMetaFromDisk(id, stopsFile, routesFile) {
	const cfg = COMPANIES[id];
	try {
		const stopsTxt = gunzipSync(await readFile(join(OUT_DIR, stopsFile))).toString('utf8');
		const routesTxt = gunzipSync(await readFile(join(OUT_DIR, routesFile))).toString('utf8');
		const stopsRaw = JSON.parse(stopsTxt);
		const routesRaw = JSON.parse(routesTxt);
		return buildMeta(stopsRaw.data, routesRaw.routes, routesRaw.routeStops);
	} catch (e) {
		throw new Error(
			`跨公司配對需要${cfg.label}既有的離線資料作對象，但讀不到 ${stopsFile} / ${routesFile}。\n` +
			`   請先完整跑一次「node scripts/build-data.mjs」（唔好加 --only）。\n   原始錯誤：${e.message}`
		);
	}
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

	// ⚠️ meta 交由 main 統一用來做跨公司配對（M9），並**不**在此建立 gz ——
	//    因為 ctb-routes.json.gz 需要事後注入 cross 欄位，故檔案統一在 main 產生。
	return { stops, routes, routeStops, meta: buildMeta(stops, routes, routeStops) };
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

	// ⚠️ meta 交由 main 統一用來做跨公司配對（M9），檔案在 main 統一產生。
	return { stops, routes: routeList, routeStops, meta: buildMeta(stops, routeList, routeStops) };
}

/* ==================== 主流程 ==================== */

async function main() {
	console.log(`M0 — 抓取靜態離線資料（多公司）${ONLY ? `，只建 ${ONLY}` : ''}\n`);
	const t0 = Date.now();

	await mkdir(OUT_DIR, { recursive: true });

	const builtAt = new Date();
	const companies = {};
	const allFiles = [];

	// 1. 抓取（或從磁碟讀回）各公司精簡資料
	for (const id of ['kmb', 'ctb']) {
		if (ONLY && ONLY !== id) {
			// --only 模式：仍需要該公司資料做跨公司配對，故從磁碟讀回
			const cfg = COMPANIES[id];
			companies[id] = {
				...(await loadCompanyMetaFromDisk(
					id, `${cfg.prefix}stops.json.gz`, `${cfg.prefix}routes.json.gz`)),
				fromDisk: true      // ⚠️ 標記：只有 meta，冇 stops/routes 陣列，唔可以重寫檔案
			};
			console.log(`\n━━━ ${cfg.label}（${id}）━━━`);
			console.log(`  由磁碟讀回離線資料做配對（--only=${ONLY}）`);
			continue;
		}
		companies[id] = id === 'kmb' ? await buildKmb() : await buildCtb();
	}

	// 2. 跨公司配對（M9）
	//    cross 資料掛喺**城巴**的 routes.json.gz（因為跨公司查詢係「以九巴為主體，
	//    補上城巴」—— 前端 UI 的出發點。九巴檔案保持不變，舊版 data.js 仍可讀。）
	const crossStats = { enabled: false };
	if (companies.kmb?.meta && companies.ctb?.meta) {
		crossStats.enabled = true;
		const t1 = Date.now();
		console.log(`\n━━━ 跨公司車站配對（M9）━━━`);

		const pairs = computeStopPairs(companies.kmb.meta, companies.ctb.meta);
		const dirRes = computeDirMap(companies.kmb.meta, companies.ctb.meta);

		// 轉成 [kmbId, [ctbId, ...]] 陣列（Map 序已排序 → 決定性）
		const crossStops = [...pairs.entries()].map(([k, v]) => [k, v]);
		const oneToMany = crossStops.filter(([, v]) => v.length > 1).length;
		const matchedCtb = new Set(crossStops.flatMap(([, v]) => v)).size;

		crossStats.pairs = crossStops.length;
		crossStats.oneToMany = oneToMany;
		crossStats.matchedCtb = matchedCtb;
		crossStats.dirs = Object.keys(dirRes.dirs).length;
		crossStats.shared = dirRes.shared;
		crossStats.collide = dirRes.collide;
		crossStats.uncertain = dirRes.uncertain;
		crossStats.ms = Date.now() - t1;

		companies.ctb.cross = { stops: crossStops, dirs: dirRes.dirs };

		// ⚠️ --only 模式下，被重 build 嘅公司有 stops 陣列；從磁碟讀回嘅只有 meta。
		//    統一由 meta 取總站數，避免讀到 undefined。
		const ctbStopTotal = companies.ctb.stops?.length ?? companies.ctb.meta.stops.length;
		const pct = ctbStopTotal ? (matchedCtb / ctbStopTotal * 100).toFixed(0) : '?';
		console.log(`  站點配對：${crossStats.pairs} 組九巴站（覆蓋 ${matchedCtb} 個城巴站，佔 ${pct}%）`);
		console.log(`           其中一對多 ${oneToMany} 組`);
		console.log(`  方向對應：共用路線號 ${dirRes.shared} 個 → 確認同一走廊 ${crossStats.dirs}、` +
			`撞號排除 ${dirRes.collide}、信度不足 ${dirRes.uncertain}`);
		console.log(`  耗時 ${crossStats.ms} 毫秒`);

		// 抽樣打印：維景酒店（計劃書 §1 場景）
		const samplePair = crossStops.find(([k]) => /KC33[34]/.test(k));
		if (samplePair) {
			const kmbName = companies.kmb.meta.stops.find((s) => s.id === samplePair[0])?.name;
			console.log(`  抽樣 九巴「${kmbName}」← 城巴 ${samplePair[1].length} 個站`);
		}
		const sampleDir = Object.keys(dirRes.dirs).filter((r) => ['103', '113'].includes(r));
		for (const r of sampleDir) {
			const d = dirRes.dirs[r];
			console.log(`  抽樣 路線 ${r}：九巴 ${d.k} ↔ 城巴 ${d.c}（相似度 ${d.s}）`);
		}
	} else if (ONLY && ONLY !== 'ctb') {
		console.log(`\n⚠ --only=${ONLY}：cross 配對需要兩家資料，已跳過（下次完整 build 會補上）`);
		companies.ctb.cross = { stops: [], dirs: {} };
	}

	// 3. 產生 gz（統一在此，確保 cross 已注入）
	for (const id of ['kmb', 'ctb']) {
		// ⚠️ --only 模式下，由磁碟讀回嘅公司只有 meta（冇 stops/routes 陣列），
		//    必須靠 fromDisk 標記跳過，唔可以用 !stops 判斷（meta 內部亦有 stops）。
		if (companies[id]?.fromDisk) continue;
		const cfg = COMPANIES[id];
		const r = companies[id];
		const routePayload = id === 'ctb' && r.cross
			? { v: 1, routes: r.routes, routeStops: r.routeStops, cross: r.cross }
			: { v: 1, routes: r.routes, routeStops: r.routeStops };
		r.files = [
			gzipToFile(`${cfg.prefix}stops.json.gz`, { v: 1, data: r.stops }),
			gzipToFile(`${cfg.prefix}routes.json.gz`, routePayload)
		];
		allFiles.push(...r.files);
	}

	// 4. 統計、寫檔
	for (const id of ['kmb', 'ctb']) {
		const r = companies[id];
		if (!r?.files || r.fromDisk) continue;

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

		for (const f of r.files) {
			await writeFile(join(OUT_DIR, f.name), f.gz);
			const ratio = ((1 - f.gz.length / f.raw.length) * 100).toFixed(1);
			console.log(`\n  ${f.name}`);
			console.log(`    原始 ${(f.raw.length / 1024).toFixed(0).padStart(6)} KB`);
			console.log(`    gzip ${(f.gz.length / 1024).toFixed(0).padStart(6)} KB  （壓縮率 ${ratio}%）`);
		}
	}

	if (!Object.keys(companies).length) throw new Error(`未知的 --only 值：${ONLY}`);
	// 確保至少一家有新檔
	if (!allFiles.length) throw new Error('沒有任何檔案被寫出（--only 模式不會重寫該公司的檔案）');

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
		companies,
		// 跨公司配對統計（M9）—— 只作記錄供 audit，**前端唔讀**（實際資料在 gz 內）
		cross: crossStats.enabled
			? {
				pairs: crossStats.pairs,
				oneToMany: crossStats.oneToMany,
				matchedCtb: crossStats.matchedCtb,
				dirs: crossStats.dirs,
				sharedRoutes: crossStats.shared,
				collide: crossStats.collide,
				uncertain: crossStats.uncertain
			}
			: undefined
	};
	// ⚠️ undefined 欄位會被 JSON.stringify 丟棄 → 無 cross 時 manifest 結構不變（向後兼容）
	await writeFile(join(OUT_DIR, 'build-manifest.json'), JSON.stringify(manifest, null, 2));

	console.log(`\n  buildId: ${buildId}（Service Worker 快取名 buseta-shell-${buildId}-<殼層hash>）`);
	for (const [id, co] of Object.entries(companies)) {
		if (!co.files) continue;   // --only 模式下由磁碟讀回嘅公司無新 buildId
		console.log(`    ${id}（${co.label}）buildId ${co.buildId} · ${co.stops} 站 · ${co.routes} 路線方向`);
	}
	if (crossStats.enabled) {
		console.log(`    跨公司配對 ${crossStats.pairs} 組站 · ${crossStats.dirs} 條方向對應 · ${crossStats.ms}ms`);
	}
	console.log(`  打包時間: ${manifest.updated}（不參與 buildId，資料無變則 buildId 不變）`);
	console.log(`✅ 完成，耗時 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

main().catch((e) => {
	console.error(`\n❌ ${e.message}`);
	process.exit(1);
});
