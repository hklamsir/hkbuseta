/**
 * BusETA — 應用邏輯（M2 搜尋 / M3 附近站/ M4 ETA）
 *
 * 依賴：js/data.js（掛載 window.BusETA）
 */
(function () {
	'use strict';

	const B = window.BusETA;
	const adapter = B.getAdapter('kmb');

	/** @type {object|null} 離線資料 */
	let DB = null;
	/** 啟動載入離線資料的 Promise（避免重複載入） */
	let booting = null;

	/* 畫面狀態 */
	const state = {
		place: null,        // { name, lat, lng }
		radius: 200,
		nearby: [],
		stop: null,         // 當前 ETA 頁的站
		eta: [],
		etaAbort: null,
		etaToken: 0,
		timer: null,
		lastFetch: 0,
		tickTimer: null
	};

	const POLL_MS = 15000;   // 規劃書 §5.4
	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

	/* ============ 啟動 ============ */

	async function boot() {
		if (booting) return booting;
		booting = (async () => {
			renderRecent();
			updateNetState();
			try {
				const manifest = await (await fetch('data/build-manifest.json')).json();
				DB = await adapter.loadStatic(manifest);
				// 開發期測試鉤子（scripts/verify.mjs 需要讀取 DB 驗證距離計算）
				// 生產環境不掛載，避免資料被外部腳本讀取
				if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
					window.__DB = DB;
				}
				$('data-stamp').textContent =
					`離線資料：${DB.stopById.size.toLocaleString()} 個車站 · ${DB.routeList.length.toLocaleString()} 條路線 · 更新於 ${DB.updated}`;
			} catch (e) {
				console.error('[boot]', e);
				showSearchError('離線資料載入失敗', `${e.message}。請檢查網絡後重新整理頁面。`);
				return;
			}
			renderRecent();
		})();
		return booting;
	}

	/* ============ 頁面切換 ============ */

	function go(page) {
		const target = page.startsWith('page-') ? page : 'page-' + page;
		for (const p of document.querySelectorAll('.page')) p.classList.toggle('active', p.id === target);
		window.scrollTo(0, 0);
	}
	function onPage(p) { return $('page-' + p).classList.contains('active'); }

	/* ============ M2 地標搜尋 ============ */

	const q = $('q');
	let searchAbort = null;
	let searchTimer = null;

	q.addEventListener('input', () => {
		$('search-field').classList.toggle('has-value', !!q.value);
		clearTimeout(searchTimer);
		const v = q.value.trim();
		if (v.length < 2) { showResults(null); return; }
		searchTimer = setTimeout(() => doSearch(v), 400);   // debounce
	});

	q.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { clearTimeout(searchTimer); if (q.value.trim().length >= 2) doSearch(q.value.trim()); }
	});

	$('q-clear').addEventListener('click', () => {
		q.value = '';
		$('search-field').classList.remove('has-value');
		clearTimeout(searchTimer);
		showResults(null);
		q.focus();
	});

	async function doSearch(text) {
		searchAbort?.abort();
		searchAbort = new AbortController();
		$('search-status').innerHTML = '<div class="loading"><div class="spinner"></div><div style="font-size:13px">搜尋中…</div></div>';
		$('search-results').innerHTML = '';

		try {
			const list = await adapter.searchPlace(text, searchAbort.signal);
			$('search-status').innerHTML = '';
			showResults(list, text);
		} catch (e) {
			if (e.name === 'AbortError') return;
			$('search-status').innerHTML = '';
			showSearchError('搜尋服務暫時繁忙', '地理編碼服務未能回應，請稍後再試。若持續失敗，可能已達使用量上限。');
		}
	}

	function showResults(list, text) {
		const box = $('search-results');
		$('recent').innerHTML = '';
		if (!list) { box.innerHTML = ''; renderRecent(); return; }
		if (!list.length) {
			box.innerHTML = emptyBox('找不到此地點', `試試加入區名，例如「${esc(text)} 旺角」或「${esc(text)} 沙田」。`);
			return;
		}

		// 排序：POI 優先於 bus_stop（規劃書 §3.4 坑三）
		const sorted = [...list].sort((a, b) => (b.isPoi ? 1 : 0) - (a.isPoi ? 1 : 0));
		// 為每個候選點計算最近九巴站距離，讓用戶判斷命中點是否「門口」
		if (DB) {
			for (const c of sorted) {
				const near = B.findNearbyStops(DB, c, 500).slice(0, 1)[0];
				c.nearest = near ? near.distance : null;
			}
		}

		const items = sorted.map((c, i) => {
			const meta = [
				c.type ? typeLabel(c.type) : '',
				c.nearest != null ? `最近九巴站 ${c.nearest} 米` : '附近未見九巴站'
			].filter(Boolean).join(' · ');
			return `<button class="result" data-i="${i}">
				<span class="body">
					<span class="name">${esc(c.name)}</span>
					<span class="meta">${esc(meta)}</span>
				</span>
				<svg class="chev"><use href="#i-chev"/></svg>
			</button>`;
		}).join('');

		box.innerHTML = `<div class="section"><div class="section-title">搜尋結果 <span class="count">${sorted.length} 個地點</span></div>
			<div class="card">${items}</div></div>`;

		box.querySelectorAll('.result').forEach((b) => {
			b.addEventListener('click', async () => {
				const c = sorted[+b.dataset.i];
				B.store.recent.add({ name: c.name, lat: c.lat, lng: c.lng });
				q.value = '';
				$('search-field').classList.remove('has-value');
				showResults(null);
				await openNearby(c);
			});
		});
		renderRecent();
	}

	function typeLabel(t) {
		return { mall: '商場', shop: '商店', building: '大廈', amenity: '設施',
			landuse: '地點', university: '院校', hospital: '醫院', tourism: '景點',
			bus_stop: '巴士站', bus_station: '車站', place: '地點' }[t] || t;
	}

	function showSearchError(title, desc) {
		$('search-results').innerHTML = `<div class="section"><div class="card"><div class="error-box">
			<svg class="ico"><use href="#i-warn"/></svg>
			<div class="t">${esc(title)}</div><div class="d">${esc(desc)}</div>
			<button class="btn" onclick="location.reload()">重新載入</button>
		</div></div></div>`;
		$('recent').innerHTML = '';
	}

	/* 歷史 + 最愛 */
	function renderRecent() {
		const r = B.store.recent.load();
		const f = B.store.favorites.load();
		let html = '';

		if (r.length) {
			html += `<div class="section"><div class="section-title">最近搜尋</div><div class="card">` +
				r.map((x, i) => `<button class="result" data-r="${i}">
					<svg style="width:18px;height:18px;stroke:var(--text-3);fill:none;stroke-width:2;flex-shrink:0"><use href="#i-clock"/></svg>
					<span class="body"><span class="name">${esc(x.name)}</span></span>
					<svg class="chev"><use href="#i-chev"/></svg></button>`).join('') +
				'</div></div>';
		}
		if (f.length) {
			html += `<div class="section"><div class="section-title">最愛巴士站 <span class="count">${f.length} 個</span></div><div class="card">` +
				f.map((x) => `<button class="result" data-f="${esc(x.stop)}">
					<svg style="width:18px;height:18px;fill:#f5a623;stroke:#f5a623;flex-shrink:0"><use href="#i-star"/></svg>
					<span class="body"><span class="name">${esc(x.name)}</span></span>
					<svg class="chev"><use href="#i-chev"/></svg></button>`).join('') +
				'</div></div>';
		}
		$('recent').innerHTML = html;

		$('recent').querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
			const x = r[+b.dataset.r];
			openNearby({ name: x.name, lat: x.lat, lng: x.lng });
		}));
		$('recent').querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
			const x = f.find((y) => y.stop === b.dataset.f);
			if (x) openEta({ stop: x.stop, name: x.name, lat: x.lat, lng: x.lng });
		}));
	}

	$('clear-data').addEventListener('click', () => {
		if (!confirm('確定清除所有搜尋記錄與最愛站？此操作無法復原。')) return;
		B.store.recent.clear();
		B.store.favorites.clear();
		renderRecent();
		toast('已清除');
	});

	/* ============ M3 附近站列表 ============ */

	$('nb-back').addEventListener('click', () => { go('search'); renderRecent(); });
	$('range-seg').addEventListener('click', (e) => {
		const b = e.target.closest('button');
		if (!b) return;
		state.radius = +b.dataset.r;
		for (const x of $('range-seg').children) x.classList.toggle('on', x === b);
		renderNearby();
	});

	async function openNearby(place) {
		await boot();
		if (!DB) return;
		state.place = place;
		$('nb-place').textContent = place.name;
		$('nb-sub').textContent = '';
		go('nearby');
		renderNearby();
	}

	function renderNearby() {
		const { place, radius } = state;
		const t0 = performance.now();
		// 純記憶體計算，零網絡請求（規劃書 §4.3）
		const list = B.findNearbyStops(DB, place, radius);
		state.nearby = list;
		const ms = Math.round(performance.now() - t0);

		$('nb-count').innerHTML = list.length
			? `範圍內 <span class="count">${list.length} 個站</span> · ${ms} 毫秒`
			: '';

		// 地圖已開啟時同步重繪（範圍圓圈 + marker 密度）
		if (map && $('map').classList.contains('on')) {
			map.setView([place.lat, place.lng], 16);
			renderMapLayers();
		}

		if (!list.length) {
			$('nb-list').innerHTML = emptyBox('此範圍內未有九巴／龍運巴士站',
				'可嘗試擴大搜尋範圍。此站可能只有城巴或新巴路線，本 app 暫未涵蓋。');
			return;
		}

		// 合併同名站（實測「太古城中心」有 6 個獨立 stop ID；
		// 「黃大仙轉車站-黃大仙廟 (WT718)」等需剝除括號編碼才合併得對）
		const groups = new Map();
		for (const s of list) {
			const k = B.groupKey(s.name);
			let g = groups.get(k);
			if (!g) groups.set(k, (g = []));
			g.push(s);
		}

		const rows = [...groups.values()].map((grp) => {
			grp.sort((a, b) => a.distance - b.distance);
			const nearest = grp[0];
			const stopIds = grp.map((s) => s.stop);
			const routes = new Set();
			for (const id of stopIds) for (const r of B.getStopRoutes(DB, id)) routes.add(r.route);
			const rl = [...routes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
			const chips = rl.slice(0, 6).map((r) => `<span class="chip">${esc(r)}</span>`).join('') +
				(rl.length > 6 ? `<span class="chip more">+${rl.length - 6}</span>` : '');
			// 保留原始名（含分站編碼）作顯示，並標明共幾個站
			const displayName = nearest.name;

			return `<button class="stop" data-ids="${esc(stopIds.join(','))}">
				<span class="body">
					<span class="name">
						<span class="txt">${esc(displayName)}</span>
						${grp.length > 1 ? `<span class="tag gray">${grp.length} 個行車位</span>` : ''}
					</span>
					<span class="meta">
						<span class="dist ${nearest.distance < 150 ? 'near' : nearest.distance < 300 ? 'mid' : 'far'}">${nearest.distance}</span>
						<span>${routes.size} 條路線</span>
					</span>
					<span class="chips">${chips}</span>
				</span>
				<svg class="chev" style="width:16px;height:16px;stroke:var(--text-3);fill:none;stroke-width:2;flex-shrink:0"><use href="#i-chev"/></svg>
			</button>`;
		}).join('');

		$('nb-list').innerHTML = `<div class="card" style="margin:0 14px 20px">${rows}</div>`;

		$('nb-list').querySelectorAll('.stop').forEach((b) => b.addEventListener('click', () => {
			const ids = b.dataset.ids.split(',');
			const first = state.nearby.find((s) => s.stop === ids[0]);
			openEta({ stop: first.stop, name: first.name, lat: first.lat, lng: first.lng, ids, distance: first.distance });
		}));
	}

	/* ============ M4 ETA 頁 ============ */

	$('eta-back').addEventListener('click', () => { stopPolling(); go('nearby'); });
	$('eta-refresh').addEventListener('click', () => { state.lastFetch = 0; fetchEta(); });

	async function openEta(stop) {
		await boot();
		stopPolling();          // 先停上一輪，避免請求堆疊
		state.stop = stop;
		$('eta-name').textContent = stop.name;
		$('eta-coord').textContent =
			`${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}` + (stop.distance != null ? ` · 距離 ${stop.distance} 米` : '');
		$('eta-sub').textContent = stop.name;
		$('eta-list').innerHTML = '<div class="card" style="margin:0 14px"><div class="skel"><div class="l" style="width:40%"></div></div><div class="skel"><div class="l" style="width:55%"></div></div><div class="skel"><div class="l" style="width:45%"></div></div></div>';
		go('eta');
		state.lastFetch = 0;
		startPolling();
		fetchEta();
	}

	async function fetchEta() {
		if (!state.stop) return;
		// 先中止上一輪，再建立本輪 controller
		// 注意：合併站會平行發多個請求，全部共用同一 controller（否則 abort 會連帶中止自己）
		state.etaAbort?.abort();
		const ac = new AbortController();
		state.etaAbort = ac;
		const token = ++state.etaToken;
		$('eta-refresh').classList.add('spin');
		$('eta-refresh').disabled = true;

		try {
			// 合併站可能對應多個 stop ID（實測「太古城中心」有 6 個）→ 全部查詢後合併
			const ids = state.stop.ids || [state.stop.stop];
			const results = await Promise.all(
				ids.map((id) => adapter.fetchStopEta(id, ac.signal).catch((e) => {
					if (e.name === 'AbortError') throw e;
					return [];   // 單一 stop 失敗不影響整組
				}))
			);
			// 若本輪已被新一輪取代，丟棄結果
			if (token !== state.etaToken) return;
			// 標記每筆 ETA 所屬的 stop ID 以便去重
			const tagged = results.flatMap((rows, i) => rows.map((r) => ({ ...r, _stop: ids[i] })));
			state.eta = B.normalizeEta(tagged);
			state.lastFetch = Date.now();
			renderEta();
		} catch (e) {
			if (e.name === 'AbortError') return;
			$('eta-list').innerHTML = `<div class="section"><div class="card"><div class="error-box">
				<svg class="ico"><use href="#i-warn"/></svg>
				<div class="t">到站時間暫時無法取得</div>
				<div class="d">請檢查網絡連線後再試。離線時仍可查看該站的路線資料。</div>
				<button class="btn" id="eta-retry">重新載入</button></div></div></div>`;
			$('eta-retry')?.addEventListener('click', () => { state.lastFetch = 0; fetchEta(); });
		} finally {
			if (token === state.etaToken) {
				$('eta-refresh').classList.remove('spin');
				$('eta-refresh').disabled = false;
			}
		}
	}

	function startPolling() {
		stopPolling();
		state.timer = setInterval(() => {
			// 輪詢條件（規劃書 §5.4）：頁面可見 + 未暫停 + 距上次 ≥15s
			if (document.visibilityState === 'visible' && Date.now() - state.lastFetch >= POLL_MS) fetchEta();
		}, POLL_MS);
		state.tickTimer = setInterval(tickCountdown, 1000);
	}

	function stopPolling() {
		clearInterval(state.timer);
		clearInterval(state.tickTimer);
		state.timer = state.tickTimer = null;
		state.etaAbort?.abort();
	}

	/** 每秒更新倒數（單一 timer，非每個 ETA 一個） */
	function tickCountdown() {
		if (!onPage('eta') || !state.eta.length) return;
		const now = Date.now();
		for (const el of document.querySelectorAll('[data-etas]')) {
			const o = state.eta[+el.dataset.etas];
			if (!o) continue;
			const f = B.formatEta(o, now);
			el.querySelector('.t').textContent = f.text;
			el.querySelector('.c').textContent = f.sub;
			el.className = 'eta ' + f.tone;
		}
	}

	function renderEta() {
		const list = state.eta;
		if (!list.length) {
			$('eta-list').innerHTML = emptyBox('此站暫時冇到站預報',
				'可能不在服務時間內，或該站只有間歇服務。九巴／龍運的行車時間表可參考官方網站。');
			$('eta-status').textContent = '每 15 秒更新';
			$('eta-stamp').textContent = '';
			return;
		}

		// 二級合併：同一路線 + 方向只顯示一行
		//
		// 背景：合併站含多個 stop ID（實測「黃大仙轉車站」5 個），
		// 同一路線會喺每個行車位各回一組 ETA（終點名略有差異），
		// 若照 stop 分行會出現 3-4 行「268C」令用戶困惑。
		// 正確做法：按 dir|route|svc 合併，把所有行車位的 ETA 依時間排序取最前 3 班。
		const byRoute = new Map();
		for (const o of list) {
			// 不含 svc：官方 ETA 會跨 service_type 混入同一批班次
			// （規劃書 §2.3陷阱二），若含 svc 會把同路線拆成多行
			const key = `${o.dir}|${o.route}`;
			if (!byRoute.has(key)) byRoute.set(key, []);
			byRoute.get(key).push(o);
		}

		const I = [], O = [];
		for (const arr of byRoute.values()) {
			// 有時間的排前面，null 的排後面（同一路線內部）
			arr.sort((a, b) => {
				if (a.ts === null && b.ts === null) return a.etaSeq - b.etaSeq;
				if (a.ts === null) return 1;
				if (b.ts === null) return -1;
				return a.ts - b.ts;
			});
			// 同時間戳去重（多個行車位可能回同一班車）
			const uniq = [];
			const seenTs = new Set();
			for (const o of arr) {
				const k = o.ts === null ? `null${o.rmk}` : String(o.ts);
				if (seenTs.has(k)) continue;
				seenTs.add(k);
				uniq.push(o);
				if (uniq.filter((x) => x.ts !== null).length >= 3 && uniq.length >= 3) break;
			}
			const g = uniq.length ? uniq : arr.slice(0, 3);
			(arr[0].dir === 'I' ? I : O).push(g);
		}

		// 組內按最近一班 ETA 時間排序（用戶習慣由早到遲）
		const byTime = (a, b) => {
			const t = (g) => {
				const v = g.find((x) => x.ts !== null);
				return v ? v.ts : Infinity;
			};
			return t(a) - t(b);
		};
		I.sort(byTime); O.sort(byTime);

		const block = (title, arr) => {
			if (!arr.length) return '';
			const rows = arr.map((g) => {
				// 終點名：取最常見者（合併行車位後可能有輕微差異）
				const destCount = new Map();
				for (const o of g) if (o.dest) destCount.set(o.dest, (destCount.get(o.dest) || 0) + 1);
				const dest = [...destCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
				const svc = g[0].svc;
				const svcCount = new Map();
				for (const o of g) svcCount.set(o.svc, (svcCount.get(o.svc) || 0) + 1);
				const mainSvc = [...svcCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
				const svcTag = mainSvc && mainSvc !== 1 ? `<span class="svc-tag">${esc(B.SERVICE_LABELS[mainSvc] || mainSvc)}</span>` : '';
				const multi = new Set(g.map((o) => o.stop)).size > 1;
				const multiTag = multi ? `<span class="svc-tag" title="此路線有多個行車位在此站">多位置</span>` : '';
				const etas = g.map((o) => {
					const f = B.formatEta(o);
					const tip = f.full ? ` title="${esc(f.full)}"` : '';
					return `<span class="eta ${f.tone}" data-etas="${list.indexOf(o)}"${tip}>
						<span class="t">${esc(f.text)}</span><span class="c">${esc(f.sub)}</span></span>`;
				}).join('');
				return `<button class="eta-row" data-ids="${esc(g.map((o) => o.seq).join(','))}">
					<span class="route-no">${esc(g[0].route)}</span>
					<span class="dest">${esc(dest)}${svcTag}${multiTag}</span>
					<span class="eta-list">${etas}</span>
				</button>`;
			}).join('');
			return `<div class="route-group"><div class="head">${title}</div>${rows}</div>`;
		};

		$('eta-list').innerHTML =
			block('<span class="arrow">←</span> 往總站方向', I) +
			block('<span class="arrow">→</span> 開往終點', O);

		$('eta-status').textContent = `每 ${POLL_MS / 1000} 秒更新`;
		const stamp = list.find((o) => o.dataTs);
		$('eta-stamp').textContent = stamp ? `資料時間 ${stamp.dataTs.slice(11, 16)}` : '';

		// ETA 行的數字已靜態 render，只需綁定 tick
		document.querySelectorAll('[data-etas]').forEach((el) => {
			el.className = 'eta';
		});
		tickCountdown();
	}

	function emptyBox(t, d) {
		return `<div class="section"><div class="card"><div class="empty">
			<svg class="ico"><use href="#i-bus"/></svg>
			<div class="t">${esc(t)}</div><div class="d">${esc(d)}</div>
		</div></div></div>`;
	}

	/* ============ 地圖（M3 附屬） ============ */

	let map = null, mapLayer = null, mapCenter = null, tileErr = 0;

$('nb-map').addEventListener('click', openMap);
$('nb-map2').addEventListener('click', openMap);
$('map-close').addEventListener('click', () => $('map').classList.remove('on'));

	function openMap() {
		const { place, radius, nearby } = state;
		$('map').classList.add('on');
		setTimeout(() => {
			if (!map) {
				map = L.map('map', { zoomControl: true, attributionControl: true })
					.setView([place.lat, place.lng], 16);
				tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
					attribution: '&copy; OpenStreetMap', maxZoom: 19, minZoom: 15,
					crossOrigin: true
				}).addTo(map);
				// 離線偵測：連續 2 張 tile 失敗即移除底圖（規劃書 §5.6）
				tileLayer.on('tileerror', () => {
					if (++tileErr === 2) {
						map.removeLayer(tileLayer);
						$('map-offline').classList.add('on');
					}
				});
				tileLayer.on('tileload', () => { $('map-offline').classList.remove('on'); });
			}
			map.invalidateSize();
			map.setView([place.lat, place.lng], 16);
			renderMapLayers();
		}, 60);
	}
	let tileLayer = null;

	function renderMapLayers() {
		if (!map) return;
		if (mapLayer) map.removeLayer(mapLayer);
		mapLayer = L.layerGroup().addTo(map);
		const { place, radius, nearby } = state;
		if (!place) return;

		// 範圍圓圈（vector，永遠可畫）
		L.circle([place.lat, place.lng], {
			radius: radius, color: '#b3121b', weight: 1.5, opacity: .5,
			fillColor: '#b3121b', fillOpacity: .05
		}).addTo(mapLayer);

		// 地標 marker
		L.marker([place.lat, place.lng], {
			icon: L.divIcon({ className: '', html: '<div class="mkr me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] })
		}).addTo(mapLayer);

		// 站點 marker：顏色按距離分層
		// 同名站以聚合標籤顯示（避免 5 個行車位標記重疊）
		const byName = new Map();
		for (const s of nearby) {
			const k = B.groupKey(s.name);
			if (!byName.has(k)) byName.set(k, []);
			byName.get(k).push(s);
		}
		for (const [, grp] of byName) {
			grp.sort((a, b) => a.distance - b.distance);
			const s = grp[0];
			const cls = s.distance < 150 ? 'near' : s.distance < 300 ? 'mid' : 'far';
			const color = { near: '#0f7b3f', mid: '#c2600c', far: '#8b95a1' }[cls];
			const routes = new Set(B.getStopRoutes(DB, s.stop).map((r) => r.route));
			const tip = `<strong>${s.name}</strong><br>${s.distance} 米 · ${routes.size} 條路線` +
				(grp.length > 1 ? `<br>共 ${grp.length} 個行車位` : '');
			// 點擊 marker 或圓點 → 跳到該站 ETA 頁（含同組所有行車位）
			const goEta = (ev) => {
				L.DomEvent.stop(ev);
				$('map').classList.remove('on');
				openEta({ stop: s.stop, name: s.name, lat: s.lat, lng: s.lng, ids: grp.map((x) => x.stop), distance: s.distance });
			};
			if (grp.length > 1) {
				// 聚合：圓角矩形標「×N」
				L.marker([s.lat, s.lng], {
					icon: L.divIcon({
						className: '', iconSize: null,
						html: `<div class="mkr multi ${cls}" style="background:${color}">×${grp.length}</div>`
					})
				}).bindTooltip(tip, { direction: 'top', offset: [0, -10] })
					.on('click', goEta).addTo(mapLayer);
			} else {
				L.circleMarker([s.lat, s.lng], {
					radius: 8, color: '#fff', weight: 2.5, fillColor: color, fillOpacity: 1
				}).bindTooltip(tip, { direction: 'top', offset: [0, -8] })
					.on('click', goEta).addTo(mapLayer);
			}
		}

		// 站名標籤：只標示最近的一個站，避免互相遮擋（其餘靠點擊/懸停查看）
		if (nearby.length) {
			const s = nearby[0];
			const routes = new Set(B.getStopRoutes(DB, s.stop).map((r) => r.route));
			L.tooltip({ permanent: true, direction: 'right', offset: [10, 0], className: 'stop-label', opacity: 1 })
				.setContent(`<strong>${s.name}</strong><br><small>${s.distance} 米 · ${routes.size} 條路線</small>`)
				.setLatLng([s.lat, s.lng])
				.addTo(mapLayer);
		}
	}

	/* ============ 工具 ============ */

	let toastTimer = null;
	function toast(msg) {
		const t = $('toast');
		t.textContent = msg;
		t.classList.add('on');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
	}

	function updateNetState() {
		const el = $('net-state');
		const paint = () => {
			el.innerHTML = navigator.onLine
				? '<span class="offline-note">● 網絡已連接</span>'
				: '<span style="color:var(--soon)">● 離線中：仍可查詢附近車站與路線，實時到站時間需網絡</span>';
		};
		paint();
		addEventListener('online', paint);
		addEventListener('offline', paint);
	}

	// 背景時暫停輪詢（規劃書 §4.4）
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && onPage('eta')) {
			if (Date.now() - state.lastFetch >= POLL_MS) fetchEta();
		}
	});

	/* Service Worker（規劃書 §5.5） */
	if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
		addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw]', e)));
	}

	boot();
})();
