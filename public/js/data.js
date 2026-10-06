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

		async _get(path, signal) {
			const res = await fetch(`${this.apiBase}/${path}`, { signal });
			if (!res.ok) throw new Error(`ETA 查詢失敗：HTTP ${res.status}`);
			return res.json();
		},

		/**
		 * 地標搜尋 — Nimbatim（九巴 API 無此能力，規劃書 §3）
		 * 實作要點（規劃書 §3.4）：
		 *   1. 自動附加「 香港」，避免搜到外國同名地點
		 *   2. 不用 countrycodes=hk（實測會令結果變 0 筆）
		 *   3. 座標範圍過濾作第二重保證
		 *   4. 多候選點返回，POI 類型優先於 bus_stop
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
			if (!res.ok) throw new Error(`地標搜尋失敗：HTTP ${res.status}`);
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

	const store = {
		recent: {
			load() { try { return JSON.parse(localStorage.getItem(LS_RECENT)) || []; } catch { return []; } },
			add(item) {
				const list = this.load().filter((r) => r.name !== item.name);
				list.unshift({ ...item, at: Date.now() });
				localStorage.setItem(LS_RECENT, JSON.stringify(list.slice(0, 10)));
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
		}
	};

	/* ============ 匯出 ============ */

	global.BusETA = {
		HK_BOUNDS, inHK, haversine, groupKey,
		registerAdapter, getAdapter, TransportAdapters,
		findNearbyStops, getStopRoutes, getRouteSequence,
		normalizeEta, formatEta, SERVICE_LABELS,
		store
	};
})(window);
