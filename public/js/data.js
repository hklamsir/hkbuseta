/**
 * BusETA — 資料層（M1）
 *
 * 職責：
 *  1. 載入並解壓gz 離線資料（stops / routes）
 *  2. 建立記憶體索引（O(1) 查詢）
 *  3. 提供 Haversine 距離搜尋 + 圓形範圍篩選
 *  4. TransportAdapter 介面（為將來城巴/新巴預留，見規劃書 §5.7）
 *
 * 設計約束：無建置步驟、單檔部署，故以普通 <script> 載入，
 * 對外只掛載 window.BusETA。
 */
(function (global) {
	'use strict';

	/* ============ 常數 ============ */

	// 香港大致範圍（規劃書 §3.4 坑二：Nominatim countrycodes=hk 不可用，改用此過濾）
	const HK_BOUNDS = { minLat: 22.15, maxLat: 22.58, minLng: 113.83, maxLng: 114.44 };
	const EARTH_R = 6371000; // 公尺

	/* ============ 工具 ============ */

	/**
	 * 以原生 DecompressionStream 解 gzip。
	 * 舊瀏覽器（Firefox < 113 / 舊 Safari）無此 API → 交由 caller 決定是否載入 pako。
	 */
	async function gunzip(url) {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`載入 ${url} 失敗：HTTP ${res.status}`);
		if (typeof DecompressionStream === 'undefined') {
			if (!global.pako) throw new Error('瀏覽器不支援 DecompressionStream，且未載入 pako');
			const buf = await res.arrayBuffer();
			return JSON.parse(global.pako.ungzip(new Uint8Array(buf), { to: 'string' }));
		}
		const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
		return JSON.parse(await new Response(stream).text());
	}

	/** 把經度經緯度差轉為近似公尺數，用於範圍預篩 */
	function metersToDegLat(m) {
		return m / 111320;
	}
	function metersToDegLng(m, lat) {
		return m / (111320 * Math.cos((lat * Math.PI) / 180));
	}

	function haversine(lat1, lng1, lat2, lng2) {
		const p = Math.PI / 180;
		const dLat = (lat2 - lat1) * p;
		const dLng = (lng2 - lng1) * p;
		const a =
			Math.sin(dLat / 2) ** 2 +
			Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLng / 2) ** 2;
		return 2 * EARTH_R * Math.asin(Math.sqrt(a));
	}

	function inHK(lat, lng) {
		return (
			lat >= HK_BOUNDS.minLat && lat <= HK_BOUNDS.maxLat &&
			lng >= HK_BOUNDS.minLng && lng <= HK_BOUNDS.maxLng
		);
	}

	/* ============ 營辦商 Adapter（規劃書 §5.7） ============ */

	/**
	 * 每個營辦商 adapter 必須實作：
	 *   id, label
	 *   loadStatic()                    → 由 build-manifest 讀入的離線資料
	 *   fetchStopEta(stopId)            → 該站所有路線的 ETA 陣列
	 *   fetchRouteEta(route, svc)       → 全線所有站 ETA
	 *   searchPlace(query)              → 地標候選點
	 *
	 * 將來加入城巴/新巴只需在此註冊新 adapter，UI 與搜尋邏輯不需改動。
	 * 注意：不同營辦商同一物理站可能有不同 stop ID，需另建對照表。
	 */
	const TransportAdapters = {};

	function registerAdapter(adapter) {
		for (const m of ['id', 'label', 'loadStatic', 'fetchStopEta', 'fetchRouteEta', 'searchPlace']) {
			if (!(m in adapter)) throw new Error(`adapter ${adapter.id} 缺少方法 ${m}`);
		}
		TransportAdapters[adapter.id] = adapter;
	}
	function getAdapter(id) {
		const a = TransportAdapters[id];
		if (!a) throw new Error(`未註冊的 adapter: ${id}`);
		return a;
	}

	/* ============ KMB / LWB adapter ============ */

	const KM = {
		id: 'kmb',
		label: '九巴及龍運',
		apiBase: 'https://data.etabus.gov.hk/v1/transport/kmb',

		/* --- 離線資料 --- */
		async loadStatic(manifest) {
			const t0 = performance.now();
			const [stopsRaw, routesRaw] = await Promise.all([
				gunzip(`data/${manifest.files.find((f) => f.name === 'stops.json.gz').name}`),
				gunzip(`data/${manifest.files.find((f) => f.name === 'routes.json.gz').name}`)
			]);

			// stops: [stopId, name_tc, latE7, lngE7]
			const stopById = new Map();
			for (const [id, name, la, ln] of stopsRaw.data) {
				stopById.set(id, { stop: id, name, lat: la / 1e7, lng: ln / 1e7 });
			}

			// routes: [route, bound, serviceType, dest_tc]
			const routeList = routesRaw.routes;

			// routeStops: [routeIdx, seq, stopIdx] — 已按 routeIdx, seq 排序，可分段
			// → stopRoutes: stopId → [{route, bound, svc, seq}]
			// → routeSeqs:  routeIdx → [stopId, ...]（有序，供路線視圖用）
			const stopRoutes = new Map();
			const routeSeqs = new Array(routeList.length);
			for (let i = 0; i < routeSeqs.length; i++) routeSeqs[i] = [];

			// routeIdxByKey: "route|bound|svc" → routeIdx
			// 路線頁必需：ETA 頁點擊時只知道路線號，要反查站序。
			// 實測 (route,bound,svc) 三元組唯一（1605 條變體無重複）。
			// 必須用完整三元組：221 組 (route,bound) 有多個 svc，其中 220 組站序唔同
			// （例 3D/I 平日去「慈雲山(中)」17 站、繁忙時段去「慈雲山(南)」13 站）。
			const routeIdxByKey = new Map();
			// routeIdxByNo: "route|bound" → [routeIdx...]（同路線號多 svc 候選）
			const routeIdxByNo = new Map();
			for (let i = 0; i < routeList.length; i++) {
				const [route, bound, svc] = routeList[i];
				routeIdxByKey.set(`${route}|${bound}|${svc}`, i);
				const k2 = `${route}|${bound}`;
				if (!routeIdxByNo.has(k2)) routeIdxByNo.set(k2, []);
				routeIdxByNo.get(k2).push(i);
			}

			routesRaw.routeStops.forEach(([ri, seq, si]) => {
				const r = routeList[ri];
				if (!r) return;
				const [route, bound, svc] = r;
				const stopId = stopsRaw.data[si][0];

				const arr = routeSeqs[ri];
				arr.push({ seq, stop: stopId });

				let l = stopRoutes.get(stopId);
				if (!l) stopRoutes.set(stopId, (l = []));
				l.push({ route, bound, svc, seq, dest: r[3] });
			});

			// 依站名分組（合併同名站，規劃書 §4.3）
			// 實測：「太古城中心」有6 個獨立 stop ID
			// 依站名分組（合併同名站，規劃書 §4.3）
			// 實測：「太古城中心」有 6 個獨立 stop ID；
			// 「黃大仙轉車站-黃大仙廟」則帶停車場編碼 (WT718)/(WT717)…
			// → 需剝除尾部括號編碼後才合併得對
			const stopsByName = new Map();
			for (const s of stopById.values()) {
				const key = groupKey(s.name);
				let g = stopsByName.get(key);
				if (!g) stopsByName.set(key, (g = []));
				g.push(s);
			}

			return {
				version: stopsRaw.v,
				// 打包時間來自 build-manifest.json，不在 gz 內。
				// 原因見 scripts/build-data.mjs：gz 必須保持位元組決定性，
				// 否則 buildId（= hash(gz)）每日必變，用戶會被逼每日重下 339 KB。
				updated: manifest.updated || manifest.built?.slice(0, 16).replace('T', ' ') || '未知',
				stopById,
				stopsByName,
				stopRoutes,
				routeList,
				routeSeqs,
				routeIdxByKey,
				routeIdxByNo,
				loadMs: Math.round(performance.now() - t0)
			};
		},

		/* --- 遠端 ETA --- */

		/**
		 * 單站所有路線 ETA。
		 * 注意（規劃書 §2.3）：無效 stop 回 200 + data:[]，不可用 HTTP code 判斷。
		 */
		async fetchStopEta(stopId, signal) {
			const json = await this._get(`stop-eta/${stopId}`, signal);
			return json.data || [];
		},

		/** 全線所有站 ETA */
		async fetchRouteEta(route, svc, signal) {
			const json = await this._get(`route-eta/${route}/${svc}`, signal);
			return json.data || [];
		},

		/**
		 * 單站 + 單路線 + 單 svc 的 ETA（路線詳情頁專用）。
		 *
		 * 為何唔用 fetchRouteEta：實測 route-eta 每次 13-43 KB（平均 25 KB），
		 * 而本端點實測僅 961 bytes —— 細 30 倍。路線頁只顯示「選中站」的 ETA，
		 * 用全線端點會把 43 KB 資料丟掉 99%。
		 *
		 * ⚠️ 回應會混合方向：同一物理 stop 若同時是該路線 O 與 I 方向的站，
		 * 會同時回兩組（實測 /eta/18492910339410B1/1/1 → 6 rows，
		 * O seq 1 + I seq 25 各 3 班）。故 caller 必須按 (dir, seq) 過濾。
		 *
		 * 注意：此方法為 optional，不列入 registerAdapter 必填清單
		 * （規劃書 §5.7：adapter 介面不應因可選功能而收窄未來擴充點）。
		 */
		async fetchSingleStopEta(stopId, route, svc, signal) {
			const json = await this._get(`eta/${stopId}/${route}/${svc}`, signal);
			return json.data || [];
		},

		async _get(path, signal) {
			const res = await fetch(`${this.apiBase}/${path}`, { signal });
			if (!res.ok) throw new Error(`ETA 查詢失敗：HTTP ${res.status}`);
			return res.json();
		},

		/**
		 * 地標搜尋 — Nominatim（九巴 API 無此能力，規劃書 §3）
		 * 實作要點（規劃書 §3.4）：
		 *   1. 自動附加「 香港」，避免搜到外國同名地點
		 *   2. 不用 countrycodes=hk（實測會令結果變 0 筆）
		 *   3. 座標範圍過濾作第二重保證
		 *   4. 多候選點返回，POI 類型優先於 bus_stop
		 *
		 * ⚠️ 官方使用政策（operations.osmfoundation.org/policies/nominatim/）：
		 *   - 硬性上限 1 request/second（超出會被限流）
		 *   - 禁止 client-side auto-complete
		 *   - 「Clients sending repeatedly the same query may be classified as
		 *     faulty and blocked」→ 必須自行緩存
		 * 實測教訓：UA 過於通用（如 `Mozilla/5.0`）會直接 403。
		 * 故必須帶明確 Referer 標識 app（瀏覽器會自動帶）。
		 *
		 * 節流與緩存由模組層 geocode 封裝處理（見 searchPlaceRatelimited），
		 * 此處保持純請求職責。
		 */
		async searchPlace(query, signal) {
			const url =
				'https://nominatim.openstreetmap.org/search?' +
				new URLSearchParams({
					q: `${query} 香港`,
					format: 'json',
					limit: '8',
					'accept-language': 'zh-HK'
				});
			const res = await fetch(url, { signal });
			if (!res.ok) {
				const err = new Error(`地標搜尋失敗：HTTP ${res.status}`);
				err.status = res.status;
				// 429 常帶 Retry-After；403 代表被政策封鎖（UA / Referer / 過量）
				const ra = res.headers.get('Retry-After');
				err.retryAfter = ra ? parseInt(ra, 10) || null : null;
				throw err;
			}
			const raw = await res.json();

			return raw
				.filter((r) => inHK(parseFloat(r.lat), parseFloat(r.lon)))
				.map((r) => ({
					name: r.display_name.split(',')[0].trim(),
					fullName: r.display_name,
					lat: parseFloat(r.lat),
					lng: parseFloat(r.lon),
					type: r.type || r.class || '',
					// 命中點可能係隔籬建築物（規劃書 §3.4 坑三）
					// → 交由 UI 計算到最近九巴站的距離，讓用戶判斷
					isPoi: !/^(bus_stop|bus_station|road|footway)$/.test(r.type || r.class || '')
				}));
		}
	};

	registerAdapter(KM);

	/* ============ 地標搜尋：節流 + 緩存 ============ */

	/**
	 * Nominatim 官方政策要求（operations.osmfoundation.org/policies/nominatim/）：
	 *   - 硬性上限 1 request/second
	 *   - 同一查詢重覆發送會被視為 faulty 並封鎖
	 * 故必須自行緩存 + 節流。
	 */
	const GEO_MIN_GAP_MS = 1100;   // 略高於官方 1 req/s，留緩衝
	const GEO_CACHE_MAX = 60;      // 記憶體快取條數
	const GEO_CACHE_TTL = 30 * 60 * 1000;   // 30 分鐘（地標座標唔會變）
	const LS_GEO_CACHE = 'buseta.geoCache';

	const geoMem = new Map();      // query → { at, list }
	let geoLastAt = 0;             // 上次發出請求的時間戳
	let geoQueue = Promise.resolve();

	/** 讀持久化緩存（跨 session，避免重開頁面就再查同一批地標） */
	function geoLoadLS() {
		try { return JSON.parse(localStorage.getItem(LS_GEO_CACHE)) || []; }
		catch { return []; }
	}
	function geoSaveLS() {
		try {
			// 只留最近 60 條，值只存必要欄位以省空間
			const arr = [...geoMem.entries()]
				.sort((a, b) => b[1].at - a[1].at)
				.slice(0, GEO_CACHE_MAX)
				.map(([k, v]) => [k, v.at, v.list.map((c) => [c.name, c.lat, c.lng, c.type, c.isPoi, c.nearest])]);
			localStorage.setItem(LS_GEO_CACHE, JSON.stringify(arr));
		} catch { /* 配額滿／私隱模式 */ }
	}

	/** 模組初始化時由 localStorage 回填記憶體快取 */
	(function initGeoCache() {
		for (const [k, at, rows] of geoLoadLS()) {
			geoMem.set(k, {
				at,
				list: rows.map(([name, lat, lng, type, isPoi, nearest]) =>
					({ name, lat, lng, type, isPoi, nearest }))
			});
		}
	})();

	function geoCacheGet(q) {
		const hit = geoMem.get(q);
		if (!hit) return null;
		if (Date.now() - hit.at > GEO_CACHE_TTL) { geoMem.delete(q); return null; }
		// 命中也要更新 LRU 位置
		geoMem.delete(q);
		geoMem.set(q, hit);
		return hit.list;
	}

	function geoCacheSet(q, list) {
		geoMem.set(q, { at: Date.now(), list });
		while (geoMem.size > GEO_CACHE_MAX) geoMem.delete(geoMem.keys().next().value);
		geoSaveLS();
	}

	/**
	 * 帶節流與緩存的地標搜尋（adapter.searchPlace 的包裝）。
	 * - 命中緩存 → 零網絡請求
	 * - 未命中 → 排隊等間隔發出，確保 ≤ 1 req/s
	 * @returns {Promise<{list:Array, cached:boolean}>}
	 */
	function searchPlaceRatelimited(query, signal, adapterId) {
		const q = String(query).trim();
		const cached = geoCacheGet(q);
		if (cached) return Promise.resolve({ list: cached, cached: true });

		const adapter = getAdapter(adapterId || 'kmb');
		// 序列化到節流佇列：每個任務開始前先等到離上次請求 ≥ GEO_MIN_GAP_MS
		const task = geoQueue.then(async () => {
			if (signal?.aborted) throw abortError();
			const wait = geoLastAt + GEO_MIN_GAP_MS - Date.now();
			if (wait > 0) await sleep(wait, signal);
			if (signal?.aborted) throw abortError();

			geoLastAt = Date.now();
			const list = await adapter.searchPlace(q, signal);
			geoCacheSet(q, list);
			return list;
		});

		// 無論成敗都要令佇列繼續（失敗唔應該卡死後續搜尋）
		geoQueue = task.then(() => {}, () => {});
		return task.then((list) => ({ list, cached: false }));
	}

	function abortError() {
		const e = new Error('已取消');
		e.name = 'AbortError';
		return e;
	}

	function sleep(ms, signal) {
		return new Promise((resolve, reject) => {
			const t = setTimeout(resolve, ms);
			signal?.addEventListener('abort', () => {
				clearTimeout(t);
				reject(abortError());
			}, { once: true });
		});
	}

	function clearGeoCache() {
		geoMem.clear();
		geoLastAt = 0;
		localStorage.removeItem(LS_GEO_CACHE);
	}

	/* ============ 範圍搜尋 ============ */

	/**
	 * 站名分組鍵：剝除尾部的停車場／分站編碼。
	 * 實測：「黃大仙轉車站-黃大仙廟 (WT718)」與「(WT717)」是同一站的不同行車位置，
	 * 但「太古城中心 (ED355)」與「太古城中心 (WT123)」則確實要分開顯示 ——
	 * 故保留括號內容供 UI 顯示，只在分組時用去碼後的名稱。
	 */
	function groupKey(name) {
		return String(name).replace(/\s*\([^)]*\)\s*$/, '').trim();
	}

	/**
	 * 找出圓形範圍內的所有車站，並附距離。
	 * 先用矩形預篩，再精算 Haversine（規劃書 §5.3）。
	 */
	function findNearbyStops(store, center, radiusM) {
		const dLat = metersToDegLat(radiusM);
		const dLng = metersToDegLng(radiusM, center.lat);
		const out = [];

		for (const s of store.stopById.values()) {
			if (s.lat < center.lat - dLat || s.lat > center.lat + dLat) continue;
			if (s.lng < center.lng - dLng || s.lng > center.lng + dLng) continue;
			const d = haversine(center.lat, center.lng, s.lat, s.lng);
			if (d <= radiusM) out.push({ ...s, distance: Math.round(d) });
		}

		out.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'zh-HK'));
		return out;
	}

	/** 取得某車站的全部路線（跨 service_type，UI 需自行去重） */
	function getStopRoutes(store, stopId) {
		return store.stopRoutes.get(stopId) || [];
	}

	/** 取得某路線的站序 */
	function getRouteSequence(store, routeIdx) {
		return (store.routeSeqs[routeIdx] || []).sort((a, b) => a.seq - b.seq);
	}

	/**
	 * 反查路線站序索引。
	 * key 格式 "route|bound|svc"（bound 為 'O'/'I'）。
	 * 找不到回 null —— caller 應據此走 fallback（svc=1 → 離線站序）。
	 */
	function findRouteIdx(store, route, bound, svc) {
		return store.routeIdxByKey.get(`${route}|${bound}|${svc}`) ?? null;
	}

	/**
	 * 取得某路線某方向的站序（直接用 stopById 展開好的物件陣列）。
	 * svc 不存在於離線資料時，依序試 svc=1，再試該方向任何一個變體。
	 * 回 { idx, seq, stops } 或 null。
	 */
	function resolveRouteSeq(store, route, bound, svc) {
		let idx = findRouteIdx(store, route, bound, svc);
		if (idx === null && svc !== 1) idx = findRouteIdx(store, route, bound, 1);
		if (idx === null) {
			const cands = store.routeIdxByNo.get(`${route}|${bound}`) || [];
			idx = cands.length ? cands[0] : null;
		}
		if (idx === null) return null;
		const seq = getRouteSequence(store, idx);
		return {
			idx,
			seq,
			stops: seq.map((s) => ({ ...store.stopById.get(s.stop), seq: s.seq })).filter((s) => s.stop)
		};
	}

	/* ============ ETA 處理 ============ */

	/**
	 * 清理並去重 ETA 記錄。
	 * 處理兩個官方陷阱（規劃書 §2.3、§2.5）：
	 *   - ETA 會跨 service_type 混入 → 按 (route,dir,seq,eta_seq,eta) 去重
	 *   - eta 可能為 null，rmk_tc 有服務類型語義 → null 不等於「無車」
	 */
	function normalizeEta(rows) {
		const seen = new Set();
		const out = [];
		for (const r of rows) {
			// 同名站的ETA 可能來自不同 stop ID，須納入去重鍵避免誤合
			const key = `${r._stop || r.stop || ''}|${r.route}|${r.dir}|${r.seq}|${r.eta_seq}|${r.eta || ''}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				route: r.route,
				dir: r.dir,
				svc: r.service_type,
				seq: parseInt(r.seq, 10),
				dest: r.dest_tc || '',
				etaSeq: r.eta_seq,
				ts: r.eta ? new Date(r.eta).getTime() : null,
				rmk: r.rmk_tc || '',
				dataTs: r.data_timestamp || null,
				stop: r._stop || r.stop || null
			});
		}
		out.sort((a, b) => (a.dir === b.dir ? a.route.localeCompare(b.route, 'en') : a.dir.localeCompare(b.dir)) || a.etaSeq - b.etaSeq);
		return out;
	}

	/** service_type 對應的 UI 標籤（規劃書 §4.5，實測有 8 種值） */
	const SERVICE_LABELS = {
		1: '平日', 2: '繁忙時段', 3: '假日', 4: '特班',
		5: '夜間', 6: '特別時段', 7: '特別', 9: '其他'
	};

	/**
	 * 格式化 ETA 顯示（規劃書 §4.4、§5.4）。
	 * 邊界處理：
	 *   剩餘 < 60s        → 「即將到」
	 *   已過 ≤ 60s       → 「即將到」（不顯示負數）
	 *   已過 > 60s       → 標記過時
	 *   eta null + rmk空 → 「暫時冇預報」
	 *   eta null + rmk   → 顯示原文 /「今日非服務日」
	 */
	function formatEta(etaObj, now) {
		const t = now || Date.now();
		if (etaObj.ts === null) {
			if (!etaObj.rmk) return { text: '暫時冇預報', sub: '', tone: 'muted' };
			// rmk 原文可能很長（如「服務只限於星期六、日及公眾假期」）
			//→ 主顯示精簡文字，全文放 title 供懸停查看
			if (/只限於|公眾假期/.test(etaObj.rmk)) return { text: '今日非服務日', sub: '', tone: 'muted', full: etaObj.rmk };
			return { text: '暫停服務', sub: '', tone: 'muted', full: etaObj.rmk };
		}
		const diff = etaObj.ts - t;
		const clock = new Date(etaObj.ts).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false });
		// 過咗 60 秒內 → 「即將到」（唔顯示負數）
		if (diff >= -60000 && diff < 60000) return { text: '即將到', sub: clock, tone: 'soon' };
		// 超過 60 秒 → 已開出
		if (diff < -60000) return { text: '已開出', sub: clock, tone: 'stale' };
		const min = Math.floor(diff / 60000);
		if (min < 60) return { text: `${min} 分鐘`, sub: clock, tone: 'ok' };
		return { text: `${Math.floor(min / 60)} 小時 ${min % 60} 分`, sub: clock, tone: 'ok' };
	}

	/* ============ 持久化（M6） ============ */

	const LS_RECENT = 'buseta.recent';
	const LS_FAV = 'buseta.favorites';
	const LS_FAV_ROUTES = 'buseta.favRoutes';
	const LS_ROUTE_VISITS = 'buseta.routeVisits';
	const LS_ROUTE_HIDDEN = 'buseta.routeVisitsHidden';

	/**
	 * 解除自動統計屏蔽。
	 * 抽成獨立 function 而非直接調 routeVisits.unhide()：
	 * favRoutes 在物件字面量中定義於 routeVisits 之前，
	 * 但 toggle() 只在執行時呼叫，那時兩者都已賦值 —— 用 function 宣告
	 * 可避免依賴定義順序。
	 */
	function routeVisitsHiddenRemove(route, bound) {
		try {
			const set = new Set(JSON.parse(localStorage.getItem(LS_ROUTE_HIDDEN)) || []);
			if (set.delete(`${route}|${bound}`)) {
				localStorage.setItem(LS_ROUTE_HIDDEN, JSON.stringify([...set]));
			}
		} catch { /* 私隱模式 */ }
	}

	/** 讀一個 localStorage JSON key，容錯 */
	function lsGet(k, fallback) {
		try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; }
		catch { return fallback; }
	}
	function lsSet(k, v) {
		try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 私隱模式／配額滿 */ }
	}

	const store = {
		recent: {
			load() { try { return JSON.parse(localStorage.getItem(LS_RECENT)) || []; } catch { return []; } },
			add(item) {
				const list = this.load().filter((r) => r.name !== item.name);
				list.unshift({ ...item, at: Date.now() });
				localStorage.setItem(LS_RECENT, JSON.stringify(list.slice(0, 10)));
			},
			/** 刪除單項（以 name 為鍵，與 add 的去重鍵一致） */
			remove(name) {
				lsSet(LS_RECENT, this.load().filter((r) => r.name !== name));
			},
			clear() { localStorage.removeItem(LS_RECENT); }
		},
		favorites: {
			load() { try { return JSON.parse(localStorage.getItem(LS_FAV)) || []; } catch { return []; } },
			has(stopId) { return this.load().some((f) => f.stop === stopId); },
			toggle(stop) {
				const list = this.load();
				const i = list.findIndex((f) => f.stop === stop.stop);
				if (i >= 0) list.splice(i, 1);
				else list.unshift({ stop: stop.stop, name: stop.name, lat: stop.lat, lng: stop.lng });
				localStorage.setItem(LS_FAV, JSON.stringify(list));
				return i < 0;
			},
			clear() { localStorage.removeItem(LS_FAV); }
		},

		/**
		 * 常搭路線（手動釘選）。
		 * 項目：{ r: 路線號, b: 'O'|'I', s: svc, d: 終點名, at: 加入時間 }
		 * 上限 10 條，超出丟最舊。排序 = 加入時間倒序（最常加星的排頭）。
		 */
		favRoutes: {
			MAX: 10,
			load() { return lsGet(LS_FAV_ROUTES, []); },
			has(r, b, s) {
				return this.load().some((x) => x.r === r && x.b === b && String(x.s) === String(s));
			},
			toggle(r, b, s, dest) {
				const list = this.load();
				const i = list.findIndex((x) => x.r === r && x.b === b && String(x.s) === String(s));
				if (i >= 0) list.splice(i, 1);
				else {
					list.unshift({ r, b, s, d: dest || '', at: Date.now() });
					if (list.length > this.MAX) list.length = this.MAX;
					// 主動加星 = 想見到呢條路線 → 解除自動統計的屏蔽
					routeVisitsHiddenRemove(r, b);
				}
				lsSet(LS_FAV_ROUTES, list);
				return i < 0;
			},
			clear() { localStorage.removeItem(LS_FAV_ROUTES); }
		},

		/**
		 * 常搭路線 — 自動訪問統計（補充手動釘選）。
		 * key = "route|bound"，value = 次數。
		 * 門檻：同一路線首次進入不計（視為試用），第二次起才累加 ——
		 * 避免用戶「試下新路線」就污染清單。
		 * 上限 20 個 key，超出丟次數最少的。
		 *
		 * hidden（用戶手動移除自動統計項）：
		 * 只刪計數的話，用戶下次再查同一路線兩次就會重新出現，
		 * 會令人覺得「刪咗但又彈返出嚟」。故另設屏蔽清單。
		 */
		routeVisits: {
			MAX: 20,
			THRESHOLD: 2,
			LS_HIDDEN: LS_ROUTE_HIDDEN,

			load() { return lsGet(LS_ROUTE_VISITS, {}); },
			hidden() { return new Set(lsGet(this.LS_HIDDEN, [])); },
			hide(route, bound) {
				const k = `${route}|${bound}`;
				const set = this.hidden();
				set.add(k);
				lsSet(this.LS_HIDDEN, [...set]);
			},
			/** 解除屏蔽（用戶重新加星時） */
			unhide(route, bound) {
				const k = `${route}|${bound}`;
				const set = this.hidden();
				if (set.delete(k)) lsSet(this.LS_HIDDEN, [...set]);
			},

			/** @returns {{count:number, counted:boolean}} counted=本次是否真的累加 */
			visit(r, b) {
				const k = `${r}|${b}`;
				if (this.hidden().has(k)) return { count: 0, counted: false, hidden: true };
				const map = this.load();
				const prev = map[k] || 0;
				// 首次（prev===0）只建立 key 不累加 → 第二次起才計
				const next = prev === 0 ? 1 : prev + 1;
				map[k] = next;
				if (Object.keys(map).length > this.MAX) {
					const entries = Object.entries(map)
						.sort((a, b2) => a[1] - b2[1]);
					for (const [ek] of entries) {
						if (Object.keys(map).length <= this.MAX) break;
						delete map[ek];
					}
				}
				lsSet(LS_ROUTE_VISITS, map);
				return { count: next, counted: prev > 0 };
			},
			/** 達門檻的項目，按次數倒序；已釘選的由 caller 排除 */
			top(n) {
				const hide = this.hidden();
				return Object.entries(this.load())
					.filter(([k, c]) => c >= this.THRESHOLD && !hide.has(k))
					.sort((a, b) => b[1] - a[1])
					.slice(0, n)
					.map(([k, c]) => {
						const [r, b] = k.split('|');
						return { route: r, bound: b, count: c };
					});
			},
			clear() {
				localStorage.removeItem(LS_ROUTE_VISITS);
				localStorage.removeItem(this.LS_HIDDEN);
			}
		}
	};

	/* ============ 匯出 ============ */

	global.BusETA = {
		HK_BOUNDS, inHK, haversine, groupKey,
		registerAdapter, getAdapter, TransportAdapters,
		findNearbyStops, getStopRoutes, getRouteSequence,
		findRouteIdx, resolveRouteSeq,
		normalizeEta, formatEta, SERVICE_LABELS,
		searchPlaceRatelimited, clearGeoCache, GEO_MIN_GAP_MS,
		store
	};
})(window);
