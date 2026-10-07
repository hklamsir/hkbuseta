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
		tickTimer: null,

		/* 路線詳情頁 */
		route: null,        // { no, bound, svc, dest }
		routeStops: [],     // 當前方向的站序（離線，含 seq 與 stopId）
		routeDir: null,     // 當前顯示方向 'O'|'I'
		routeSel: null,     // 選中站 { stop, seq, stopId }
		routeEta: [],       // 選中站 /eta/ 回應（已過濾方向）
		routeAbort: null,
		routeToken: 0,
		routeTimer: null,
		routeTick: null,
		routeLastFetch: 0,

		/**
		 * 返回目標追蹤。
		 * from = 'recent' → 從搜尋頁的常搭路線／常到車站進入，返回時直接回首頁
		 * from = null    → 正常流程（ETA 頁返回附近站、路線頁返回 ETA 頁）
		 */
		etaFrom: null,
		routeFrom: null
	};

	const POLL_MS = 15000;   // 規劃書 §5.4
	const ROUTE_MAX_AUTO = 5;   // 常搭路線：自動統計區只顯示 top N
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
	/** 節流佇列中排隊嘅查詢（用於顯示「排隊中」而非「搜尋中」） */
	let pendingQuery = null;

	/**
	 * debounce 600ms（原本 400ms）。
	 * 官方硬性上限 1 req/s，故加長 debounce + 下層 searchPlaceRatelimited 硬節流。
	 * 兩者配合：debounce 減少無謂請求，節流確保唔會超標。
	 */
	const SEARCH_DEBOUNCE_MS = 600;

	q.addEventListener('input', () => {
		$('search-field').classList.toggle('has-value', !!q.value);
		clearTimeout(searchTimer);
		// 取消上一輪搜尋（否則舊結果會蓋掉新輸入）
		searchAbort?.abort();
		const v = q.value.trim();
		if (v.length < 2) {
			$('search-status').innerHTML = '';
			showResults(null);
			return;
		}
		searchTimer = setTimeout(() => doSearch(v), SEARCH_DEBOUNCE_MS);
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

	/** 節流等待中顯示「等待請求間隔…」而非「搜尋中」 */
	function showSearching(waiting) {
		$('search-status').innerHTML = `<div class="loading"><div class="spinner"></div>
			<div style="font-size:13px">${waiting ? '等待請求間隔…' : '搜尋中…'}</div></div>`;
	}

	async function doSearch(text) {
		searchAbort?.abort();
		searchAbort = new AbortController();
		$('search-results').innerHTML = '';
		showSearching(true);

		try {
			// 經節流 + 緩存層：命中緩存零請求；未命中排隊至 ≤ 1 req/s
			const { list, cached } = await B.searchPlaceRatelimited(text, searchAbort.signal, adapter.id);
			$('search-status').innerHTML = '';
			showResults(list, text, cached);
		} catch (e) {
			if (e.name === 'AbortError') return;
			$('search-status').innerHTML = '';
			showSearchError(...geoErrorCopy(e));
		}
	}

	function showResults(list, text, cached) {
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

		// 緩存命中時明確標示，讓用戶知道結果來自本機而非即時請求
		const badge = cached ? ' <span class="count">本機緩存</span>' : '';
		box.innerHTML = `<div class="section"><div class="section-title">搜尋結果${badge} <span class="count">${sorted.length} 個地點</span></div>
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
			<button class="btn" id="search-retry">重新搜尋</button>
		</div></div></div>`;
		$('recent').innerHTML = '';
		$('search-retry')?.addEventListener('click', () => {
			if (q.value.trim().length >= 2) doSearch(q.value.trim());
			else q.focus();
		});
	}

	/**
	 * 地標搜尋錯誤分類。
	 * 之前所有錯誤都顯示同一句「可能已達使用量上限」，但 403（政策封鎖）
	 * 與 429（限流）與網絡中斷的成因與應對完全不同，統一訊息會令用戶
	 * 撳「重新載入」而無效（reload 對 403 冇用，只會再被拒一次）。
	 * @returns {[string,string]} [標題, 說明]
	 */
	function geoErrorCopy(e) {
		if (!navigator.onLine) {
			return ['網絡已連接中斷', '請檢查網絡後再試。已搜尋過的地標會在恢復後從緩存即時顯示。'];
		}
		switch (e.status) {
			case 429:
				return ['請求太頻密', (e.retryAfter ? `官方服務要求每秒最多 1 次查詢。請約 ${e.retryAfter} 秒後再試。` : '官方服務每秒只接受 1 次查詢，請稍等幾秒再試。')];
			case 403:
				return ['搜尋服務暫不接受查詢',
					'OpenStreetMap 的公開地標服務按政策封鎖過量或未標示來源的請求，這是服務端限制，唔係你的裝置問題。請稍後再試，或搜尋附近地區名稱（例如「黃大仙 旺角」）。'];
			case 400:
				return ['搜尋字串無法處理', '請嘗試其他關鍵字，例如加入區名或去掉括號。'];
			default:
				if (/Failed to fetch|NetworkError|load failed/i.test(e.message || '')) {
					return ['無法連接搜尋服務', '請檢查網絡連線後再試。'];
				}
				return ['搜尋服務暫時繁忙', '地理編碼服務未能回應，請稍後再試。若持續失敗，可能已達使用量上限。'];
		}
	}

	/* 歷史 + 常搭路線 + 常到車站 */

	/** 分頁狀態：'route' = 常搭路線、'stop' = 常到車站 */
	let favTab = 'route';

	function renderRecent() {
		const r = B.store.recent.load();
		const f = B.store.favorites.load();
		const fr = B.store.favRoutes.load();
		let html = '';

		// 常搭路線：手動釘選（永在最前）+ 自動統計（未釘選且達門檻者）
		const pinned = fr.map((x) => ({ ...x, pinned: true }));
		const pinnedKeys = new Set(fr.map((x) => `${x.r}|${x.b}`));
		const auto = B.store.routeVisits.top(20)
			.filter((x) => !pinnedKeys.has(`${x.route}|${x.bound}`))
			.slice(0, ROUTE_MAX_AUTO)
			.map((x) => ({
				r: x.route, b: x.bound, s: null, d: routeDestName(x.route, x.bound),
				count: x.count, pinned: false
			}));
		const favRoutes = [...pinned, ...auto];

		// 最近搜尋（可逐項刪除）
		if (r.length) {
			html += `<div class="section"><div class="section-title">最近搜尋</div><div class="card">` +
				r.map((x, i) => `<button class="result" data-r="${i}">
					<svg style="width:18px;height:18px;stroke:var(--text-3);fill:none;stroke-width:2;flex-shrink:0"><use href="#i-clock"/></svg>
					<span class="body"><span class="name">${esc(x.name)}</span></span>
					<span class="row-del" data-del="${esc(x.name)}" role="button" aria-label="刪除 ${esc(x.name)}" title="刪除">
						<svg><use href="#i-x"/></svg>
					</span>
				</button>`).join('') +
				'</div></div>';
		}

		// 常搭路線 / 常到車站：同一個分頁容器，避免三個區塊同時出現過於擠迫
		if (favRoutes.length || f.length) {
			// 若當前分頁已無內容，自動跳到另一個有內容的分頁
			if (favTab === 'route' && !favRoutes.length) favTab = 'stop';
			else if (favTab === 'stop' && !f.length) favTab = 'route';

			const rows = favTab === 'route'
				? favRoutes.map((x, i) => `<button class="result" data-fr="${i}">
					<svg style="width:18px;height:18px;flex-shrink:0;${x.pinned ? 'fill:#f5a623;stroke:#f5a623' : 'fill:none;stroke:var(--text-3);stroke-width:2;stroke-linejoin:round'}"><use href="#i-star"/></svg>
					<span class="body">
						<span class="name">${esc(x.r)} <span class="sub2">往 ${esc(x.d || '—')}</span></span>
						${x.count ? `<span class="meta">已查看 ${x.count} 次</span>` : ''}
					</span>
					${x.pinned ? `<span class="row-del" data-unpin="${i}" role="button" aria-label="取消常搭 ${esc(x.r)}" title="取消常搭">
						<svg><use href="#i-x"/></svg></span>` : '<svg class="chev"><use href="#i-chev"/></svg>'}
				</button>`).join('')
				: f.map((x) => `<button class="result" data-f="${esc(x.stop)}">
					<svg style="width:18px;height:18px;fill:#f5a623;stroke:#f5a623;flex-shrink:0"><use href="#i-star"/></svg>
					<span class="body"><span class="name">${esc(x.name)}</span></span>
					<span class="row-del" data-unfav="${esc(x.stop)}" role="button" aria-label="移除 ${esc(x.name)}" title="移除">
						<svg><use href="#i-x"/></svg>
					</span>
				</button>`).join('');

			html += `<div class="section">
				<div class="fav-tabs" id="fav-tabs">
					<button data-tab="route" class="${favTab === 'route' ? 'on' : ''}" ${favRoutes.length ? '' : 'disabled'}>
						常搭路線 <span class="n">${favRoutes.length}</span>
					</button>
					<button data-tab="stop" class="${favTab === 'stop' ? 'on' : ''}" ${f.length ? '' : 'disabled'}>
						常到車站 <span class="n">${f.length}</span>
					</button>
				</div>
				<div class="card">${rows}</div>
			</div>`;
		} else {
			favTab = 'route';
		}
		$('recent').innerHTML = html;

		$('fav-tabs')?.addEventListener('click', (e) => {
			const b = e.target.closest('button[data-tab]');
			if (!b || b.disabled) return;
			favTab = b.dataset.tab;
			renderRecent();
		});

		$('recent').querySelectorAll('[data-fr]').forEach((b) => b.addEventListener('click', async (e) => {
			if (e.target.closest('[data-unpin]')) return;   // 刪除鈕已另行處理
			const x = favRoutes[+b.dataset.fr];
			boot().then(() => {
				if (!DB) return;
				B.store.routeVisits.visit(x.r, x.b);
				openRoute({
					no: x.r, dir: x.b, svc: x.s || 1, dest: x.d || '',
					seqs: null,   // 從常搭清單進入無特定出發站 → 只顯示全線站序
					from: 'recent' // 返回時直接回首頁
				});
			});
		}));
		$('recent').querySelectorAll('[data-unpin]').forEach((b) => b.addEventListener('click', (e) => {
			e.stopPropagation();
			const x = favRoutes[+b.dataset.unpin];
			B.store.favRoutes.toggle(x.r, x.b, x.s || 1, x.d);
			renderRecent();
			toast('已取消常搭');
		}));
		$('recent').querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', (e) => {
			if (e.target.closest('[data-del]')) return;     // 刪除鈕已另行處理
			const x = r[+b.dataset.r];
			openNearby({ name: x.name, lat: x.lat, lng: x.lng });
		}));
		$('recent').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
			e.stopPropagation();
			B.store.recent.remove(b.dataset.del);
			renderRecent();
			toast('已刪除');
		}));
		$('recent').querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', (e) => {
			if (e.target.closest('[data-unfav]')) return;
			const x = f.find((y) => y.stop === b.dataset.f);
			if (x) openEta({ stop: x.stop, name: x.name, lat: x.lat, lng: x.lng, from: 'recent' });
		}));
		$('recent').querySelectorAll('[data-unfav]').forEach((b) => b.addEventListener('click', (e) => {
			e.stopPropagation();
			B.store.favorites.toggle({ stop: b.dataset.unfav });
			renderRecent();
			toast('已移除');
		}));
	}

	/** 從離線 routeList 取某路線某方向的終點名 */
	function routeDestName(routeNo, bound) {
		for (const [no, b, , dest] of DB.routeList) {
			if (no === routeNo && b === bound) return dest;
		}
		return '';
	}

	$('clear-data').addEventListener('click', () => {
		if (!confirm('確定清除所有搜尋記錄、常搭路線與常到車站？此操作無法復原。')) return;
		B.store.recent.clear();
		B.store.favorites.clear();
		B.store.favRoutes.clear();
		B.store.routeVisits.clear();
		B.clearGeoCache();
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

	$('eta-back').addEventListener('click', () => {
		stopPolling();
		const from = state.etaFrom;
		state.etaFrom = null;
		// 從常到車站進入 → 返回時直接回首頁，略過附近站列表
		if (from === 'recent') {
			go('search');
			renderRecent();
			return;
		}
		// 從路線頁跳轉進入 → 返回路線頁（該路線的站序仍然有用）
		if (from === 'route') {
			state.routeSel = null;
			state.routeEta = [];
			go('route');
			return;
		}
		go('nearby');
	});
	$('eta-refresh').addEventListener('click', () => { state.lastFetch = 0; fetchEta(); });

	async function openEta(stop) {
		await boot();
		stopRoutePolling();      // 路線頁的輪詢要先停，避免背景跑無用請求
		stopPolling();          // 先停上一輪，避免請求堆疊
		state.stop = stop;
		// 記錄來源，供返回按鈕決定目標：
		//   'recent' → 從常到車站進入，返回首頁
		//   'route'  → 從路線頁跳轉進入，返回路線頁（nearby 未經過，不可回）
		//   null     → 正常流程，返回附近站
		state.etaFrom = stop.from === 'recent' ? 'recent'
			: stop.from === 'route' ? 'route' : null;
		$('eta-name').textContent = stop.name;
		$('eta-coord').textContent =
			`${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}` + (stop.distance != null ? ` · 距離 ${stop.distance} 米` : '');
		$('eta-sub').textContent = stop.name;
		syncFavBtn();
		$('eta-list').innerHTML = '<div class="card" style="margin:0 14px"><div class="skel"><div class="l" style="width:40%"></div></div><div class="skel"><div class="l" style="width:55%"></div></div><div class="skel"><div class="l" style="width:45%"></div></div></div>';
		go('eta');
		state.lastFetch = 0;
		startPolling();
		fetchEta();
	}

	/** 同步 ETA 頁「常到車站」星號狀態（啟動原本只有資料層、UI 無入口的功能） */
	function syncFavBtn() {
		const s = state.stop;
		if (!s) return;
		const on = B.store.favorites.has(s.stop);
		$('eta-fav').classList.toggle('on', on);
		$('eta-fav').setAttribute('aria-label', on ? '取消常到車站' : '加入常到車站');
	}

	$('eta-fav').addEventListener('click', () => {
		const s = state.stop;
		if (!s) return;
		B.store.favorites.toggle({ stop: s.stop, name: s.name, lat: s.lat, lng: s.lng });
		syncFavBtn();
		toast(B.store.favorites.has(s.stop) ? '已加入常到車站' : '已移除');
		renderRecent();
	});

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
				// data-r 帶齊路線／方向／svc／該行全部 seq 與 stop ID 給路線頁用
				const stopIds = [...new Set(g.map((o) => o.stop).filter(Boolean))];
				return `<button class="eta-row" data-ids="${esc(g.map((o) => o.seq).join(','))}"
					data-stops="${esc(stopIds.join(','))}"
					data-r="${esc(g[0].route)}" data-dir="${esc(g[0].dir)}"
					data-svc="${esc(mainSvc == null ? 1 : mainSvc)}" data-dest="${esc(dest)}">
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

		// 路線行可點 → 進路線詳情頁（.eta-row 本來就是 button，零 UI 改動）
		$('eta-list').querySelectorAll('.eta-row').forEach((b) => {
			b.addEventListener('click', () => {
				openRoute({
					no: b.dataset.r,
					dir: b.dataset.dir,
					svc: +b.dataset.svc || 1,
					dest: b.dataset.dest,
					seqs: b.dataset.ids.split(',').map(Number).filter((n) => !isNaN(n)),
					// 合併站會帶多個 stop ID（實測「黃大仙中心」同站最多 6 個行車位）
					stopIds: (b.dataset.stops || '').split(',').filter(Boolean)
				});
			});
		});
	}

	function emptyBox(t, d) {
		return `<div class="section"><div class="card"><div class="empty">
			<svg class="ico"><use href="#i-bus"/></svg>
			<div class="t">${esc(t)}</div><div class="d">${esc(d)}</div>
		</div></div></div>`;
	}

	/* ============ M7 路線詳情頁 ============ */

	$('rt-back').addEventListener('click', () => {
		stopRoutePolling();
		// 從常搭路線進入 → 返回時直接回首頁
		if (state.routeFrom === 'recent') {
			state.routeFrom = null;
			state.routeSel = null;
			state.routeEta = [];
			go('search');
			renderRecent();
			return;
		}
		go('eta');
	});
	$('rt-refresh').addEventListener('click', () => { state.routeLastFetch = 0; fetchRouteStopEta(); });
	$('rt-fav').addEventListener('click', () => {
		const r = state.route;
		if (!r) return;
		const on = B.store.favRoutes.toggle(r.no, r.bound, r.svc, r.dest);
		syncRouteFavBtn();
		toast(on ? '已加入常搭路線' : '已移除');
		renderRecent();
	});

	function syncRouteFavBtn() {
		const r = state.route;
		if (!r) return;
		const on = B.store.favRoutes.has(r.no, r.bound, r.svc);
		$('rt-fav').classList.toggle('on', on);
		$('rt-fav').setAttribute('aria-label', on ? '取消常搭路線' : '加入常搭路線');
	}

	/**
	 * 進入路線詳情頁。
	 * 站序完全來自離線 routeSeqs → 首次進入零網絡請求（可離線使用）。
	 * @param {{no:string,dir:string,svc:number,dest:string,seqs:number[]}} opts
	 */
	function openRoute(opts) {
		boot().then(() => {
		if (!DB) return;
		stopPolling();
		stopRoutePolling();

		// 清掉上一條路線的選中狀態，避免 remapByStopId 拿舊資料對應
		state.routeSel = null;
		state.routeEta = [];
		// 記錄來源，供返回按鈕決定目標（從常搭路線進入 → 返回首頁）
		state.routeFrom = opts.from === 'recent' ? 'recent' : null;
		state.route = { no: opts.no, bound: opts.dir, svc: opts.svc, dest: opts.dest };

		// 自動訪問統計：首次不計（視為試用），第二次起才累加
		const v = B.store.routeVisits.visit(opts.no, opts.dir);

		$('rt-no').textContent = opts.no;
		$('rt-sub').textContent = '';
		syncRouteFavBtn();
		go('route');

		// 構建方向分頁（零網絡）
		buildDirTabs(opts.no, opts.dir, opts.svc);
		setRouteDir(opts.dir, opts.svc, { seqs: opts.seqs, stopIds: opts.stopIds },
			!v.counted ? '首次查看這條路線，第二次起才會記入常搭' : null);
		});
	}

	/** 方向分頁：列出該路線號所有方向的終點名 */
	function buildDirTabs(routeNo, activeDir, svc) {
		const box = $('rt-dirs');
		const dirs = new Map();
		for (let i = 0; i < DB.routeList.length; i++) {
			const [no, bound, s, dest] = DB.routeList[i];
			if (no !== routeNo) continue;
			// 同一方向多 svc 時，優先用傳入的 svc，否則取第一個
			const cur = dirs.get(bound);
			if (!cur || (cur.svc !== svc && s === svc)) dirs.set(bound, { svc: s, dest });
		}
		state.routeDirs = dirs;
		const html = [...dirs.entries()].map(([bound, info]) =>
			`<button data-d="${esc(bound)}" data-s="${esc(info.svc)}" class="${bound === activeDir ? 'on' : ''}"
				title="往 ${esc(info.dest)}">往 ${esc(info.dest)}</button>`
		).join('');
		box.innerHTML = html;
		box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
			setRouteDir(b.dataset.d, +b.dataset.s || 1, null, null);
		}));	}

	/**
	 * 切換方向（或初次載入）。
	 * @param {string} dir 'O'|'I'
	 * @param {number} svc
	 * @param {number[]|null} seqs 由 ETA 頁帶入的候選 seq（初次載入用）
	 * @param {string|null} hint 要顯示的提示
	 */
function setRouteDir(dir, svc, ctx, hint) {
		state.routeDir = dir;
		state.route.bound = dir;
		state.route.svc = svc;

		$('rt-dirs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.d === dir));

		// resolveRouteSeq 內建 svc fallback：原值 → 1 → 同方向任一變體
		const res = B.resolveRouteSeq(DB, state.route.no, dir, svc);
		if (!res || !res.stops.length) {
			$('rt-list').innerHTML = emptyBox('離線資料未有這條路線的站序',
				'官方每日 05:00 更新路線資料，請稍後再試或重新整理頁面。');
			$('rt-hint').hidden = true;
			return;
		}
		state.routeStops = res.stops;

		const meta = DB.routeList[res.idx];
		state.route.dest = meta[3];
		state.route.svc = meta[2];
		$('rt-dest').textContent = `往 ${meta[3]}`;
		$('rt-count').textContent = `${res.stops.length} 站`;
		const svcTag = $('rt-svc');
		if (meta[2] && meta[2] !== 1) {
			svcTag.hidden = false;
			svcTag.textContent = B.SERVICE_LABELS[meta[2]] || `類型 ${meta[2]}`;
		} else {
			svcTag.hidden = true;
		}

		renderRouteSeq();

		// 決定選中站：切換方向時用 stopId 重映射，初次進入用帶入的 stopId/seq
		let picked;
		if (ctx && (ctx.stopIds?.length || ctx.seqs?.length)) {
			picked = pickBySeqs(res.stops, ctx.seqs, ctx.stopIds);
			state.routeHint = hint || (picked?.altSeqs?.length
				? `這條路線會行兩次經過此站（第 ${picked.altSeqs.join('、')} 站）` : null);
		} else {
			picked = remapByStopId();
			state.routeHint = hint || (picked?.nearest ? '已切換至這條路線上距離最近的車站' : null);
		}
		state.routeSel = null;
		state.routeEta = [];
		showHint(state.routeHint);
		if (picked) selectStop(picked, { scroll: true });
	}

	/**
	 * 決定選中站（初次進入）。
	 * 優先用 stop ID 精確匹配 —— 比 seq 穩健，因為 resolveRouteSeq 可能走過
	 * svc fallback（此時離線站序的 seq 與 API 的 seq 不同）。
	 * 循環線（實測 114 條，如 3S / 5D）頭尾會經過同一 stopId，
	 * 多個 stopId 時取首個並記下其餘供提示。
	 */
	function pickBySeqs(stops, seqs, stopIds) {
		if (stopIds && stopIds.length) {
			const hit = stops.find((s) => stopIds.includes(s.stop));
			if (hit) {
				hit.altSeqs = [];
				return hit;
			}
		}
		const hits = seqs ? stops.filter((s) => seqs.includes(s.seq)) : [];
		if (!hits.length) return null;
		// 同 stopId 多 seq（循環線）→ 取首個為代表
		const byStop = new Map();
		for (const h of hits) if (!byStop.has(h.stop)) byStop.set(h.stop, []);
		for (const h of hits) byStop.get(h.stop).push(h.seq);
		const first = hits[0];
		first.altSeqs = byStop.get(first.stop).filter((q) => q !== first.seq);
		return first;
	}

	/**
	 * 切換方向後重新映射選中站。
	 * 用 stopId 精確對應；對應唔到就取同路線上距離最近的站。
	 */
	function remapByStopId() {
		const sel = state.routeSel;
		// 從常搭清單進入時上一站的 state 已失效，不能拿來對應
		if (!sel || !sel.stop || !Number.isFinite(sel.lat)) return null;
		const stops = state.routeStops;
		const exact = stops.find((s) => s.stop === sel.stop);
		if (exact) return exact;
		// 就近替代：以原站座標找最近（分站編碼不同的同一站名也算合理替代）
		let best = null, bestD = Infinity;
		for (const s of stops) {
			if (!s.lat) continue;
			const d = B.haversine(sel.lat, sel.lng, s.lat, s.lng);
			if (d < bestD) { bestD = d; best = s; }
		}
		if (!best) return stops[0] || null;
		best.nearest = true;
		return best;
	}

	function showHint(text) {
		const el = $('rt-hint');
		if (!text) { el.hidden = true; el.textContent = ''; return; }
		el.hidden = false;
		el.textContent = text;
	}

	/** 渲染全線站序（離線） */
	function renderRouteSeq() {
		const stops = state.routeStops;
		const sel = state.routeSel;
		const n = stops.length;
		const last = n - 1;

		const rows = stops.map((s, i) => {
			const isSel = sel && sel.seq === s.seq && sel.stop === s.stop;
			const term = i === 0 || i === last;
			return `<button class="seq-row${isSel ? ' sel' : ''}${term ? ' term' : ''}" data-i="${i}">
				<span class="no">${s.seq}</span>
				<span class="body">
					<span class="nm">
						<span class="t">${esc(splitCode(s.name).base)}</span>
						${codeTag(s.name)}
					</span>
					${tagsFor(s, i === 0, i === last)}
				</span>
				<span class="jump" data-jump="${i}" role="button" aria-label="查看 ${esc(s.name)} 到站時間">
					<svg><use href="#i-arrow-right"/></svg>
				</span>
			</button>`;
		}).join('');

		$('rt-list').innerHTML = `<div class="seq-list">${rows}</div>`;

		$('rt-list').querySelectorAll('.seq-row').forEach((b) => b.addEventListener('click', (e) => {
			// 站名右邊的 → 跳去該站 ETA 頁
			const jump = e.target.closest('[data-jump]');
			const i = +b.dataset.i;
			const s = state.routeStops[i];
			if (jump) {
				stopRoutePolling();
				// from='route' → ETA 頁返回時返路線頁
				openEta({ stop: s.stop, name: s.name, lat: s.lat, lng: s.lng, from: 'route' });
				return;
			}
			selectStop(s);
		}));
	}

	/**
	 * 站名尾部的分站編碼（如「竹園邨總站 (WT916)」）。
	 * 主名稱只顯示乾淨站名，編碼另以細字灰色顯示（現場辨認行車位用）。
	 */
	function splitCode(name) {
		const m = String(name).match(/^(.*?)\s*(\([^)]{2,}\))\s*$/);
		return m ? { base: m[1].trim(), code: m[2] } : { base: String(name), code: '' };
	}
	function codeTag(name) {
		const { code } = splitCode(name);
		return code ? `<span class="code">${esc(code)}</span>` : '';
	}

	function tagsFor(s, isFirst, isLast) {
		const t = [];
		if (isFirst) t.push('<span class="tag gray">總站</span>');
		if (isLast && !isFirst) t.push('<span class="tag gray">總站</span>');
		return t.length ? `<span class="tags">${t.join('')}</span>` : '';
	}

	/** 選中站：再次點同一行 = 收埋 */
	function selectStop(s, opt) {
		const opts = opt || {};
		if (!s) return;
		if (state.routeSel && state.routeSel.seq === s.seq && state.routeSel.stop === s.stop) {
			state.routeSel = null;
			state.routeEta = [];
			showHint(null);
			renderRouteSeq();
			$('rt-status').textContent = '';
			$('rt-stamp').textContent = '';
			return;
		}
		state.routeSel = s;
		state.routeEta = [];
		renderRouteSeq();
		// 選中站可能與先前提示所指的不同（例如 hint 是「已切換至最近車站」）
		if ($('rt-hint').textContent !== state.routeHint) showHint(state.routeHint || null);
		if (opts.scroll) {
			const el = $('rt-list').querySelector('.seq-row.sel');
			if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
		}
		fetchRouteStopEta();
	}

	/**
	 * 查選中站 ETA。
	 * 用 /eta/{stop}/{route}/{svc}（實測 961 bytes），不用 route-eta（13-43 KB）。
	 * 回應會混合方向 → 必須按 (dir, seq) 過濾。
	 */
	async function fetchRouteStopEta() {
		const sel = state.routeSel;
		const r = state.route;
		if (!sel || !r) return;
		if (typeof adapter.fetchSingleStopEta !== 'function') {
			showHint('此營辦商未支援單站路線 ETA（離線站序仍可用）');
			$('rt-status').textContent = '';
			return;
		}

		// 每查一個新站就重啟輪詢，避免上一站的 fetchRouteStopEta 立刻被 interval 再觸發
		startRoutePolling();
		state.routeAbort?.abort();
		const ac = new AbortController();
		state.routeAbort = ac;
		const token = ++state.routeToken;
		$('rt-refresh').classList.add('spin');
		$('rt-refresh').disabled = true;
		renderSeqEtaBox('load');

		try {
			const rows = await adapter.fetchSingleStopEta(sel.stop, r.no, r.svc, ac.signal);
			if (token !== state.routeToken) return;
			// 按 (dir, seq) 過濾：同一物理 stop 可能同時是該路線 O 與 I 方向的站
			// 實測 /eta/竹園邨總站/1/1 → O seq 1 + I seq 25 各 3 班
			const kept = rows.filter((x) => x.dir === state.routeDir && String(x.seq) === String(sel.seq));
			state.routeEta = B.normalizeEta(kept);
			state.routeLastFetch = Date.now();
			renderSeqEtaBox('done');
		} catch (e) {
			if (e.name === 'AbortError') return;
			if (token !== state.routeToken) return;
			state.routeEta = [];
			renderSeqEtaBox('error');
		} finally {
			if (token === state.routeToken) {
				$('rt-refresh').classList.remove('spin');
				$('rt-refresh').disabled = false;
			}
		}
	}

	/** 選中站下方 inline 的 ETA 區塊 */
	function renderSeqEtaBox(mode) {
		const sel = state.routeSel;
		if (!sel) return;
		const prev = $('rt-list').querySelector('.seq-eta');
		if (prev) prev.remove();
		const row = $('rt-list').querySelector('.seq-row.sel');
		if (!row) return;

		const box = document.createElement('div');
		box.className = 'seq-eta';

		if (mode === 'load') {
			box.innerHTML = '<span class="lb">到站時間</span><span class="skel"><div class="skel"><div class="l" style="width:80px"></div></div></span>';
		} else if (mode === 'error') {
			box.innerHTML = `<span class="lb">到站時間</span><span class="none">查詢失敗，請檢查網絡</span>`;
		} else {
			const list = state.routeEta;
			const stamp = list.find((o) => o.dataTs);
			// 排序：有時間的按時間升序（用戶習慣由早到遲），null 排後
			const sorted = [...list].sort((a, b) => (a.ts === null ? 1 : 0) - (b.ts === null ? 1 : 0) || (a.ts || 0) - (b.ts || 0));
			const etas = sorted.map((o) => {
				const f = B.formatEta(o);
				const tip = f.full ? ` title="${esc(f.full)}"` : '';
				return `<span class="eta ${f.tone}" data-rseq="${state.routeEta.indexOf(o)}"${tip}>
					<span class="t">${esc(f.text)}</span><span class="c">${esc(f.sub)}</span></span>`;
			}).join('');
			box.innerHTML = `<span class="lb">到站時間</span>` +
				(etas ? `<span class="eta-list">${etas}</span>`
				      : `<span class="none">${navigator.onLine ? '此站暫時冇到站預報' : '離線中，無法顯示實時到站時間'}</span>`);
			$('rt-status').textContent = `每 ${POLL_MS / 1000} 秒更新`;
			$('rt-stamp').textContent = stamp ? `資料時間 ${stamp.dataTs.slice(11, 16)}` : '';
		}
		row.after(box);
	}

	/** 路線頁獨立 tick（資料源不同於 ETA 頁，用 data-rseq 分開） */
	function tickRouteCountdown() {
		if (!onPage('route') || !state.routeEta.length) return;
		const now = Date.now();
		for (const el of document.querySelectorAll('[data-rseq]')) {
			const o = state.routeEta[+el.dataset.rseq];
			if (!o) continue;
			const f = B.formatEta(o, now);
			el.querySelector('.t').textContent = f.text;
			el.querySelector('.c').textContent = f.sub;
			el.className = 'eta ' + f.tone;
		}
	}

	function startRoutePolling() {
		stopRoutePolling();
		state.routeTimer = setInterval(() => {
			if (document.visibilityState === 'visible' && state.routeSel &&
				Date.now() - state.routeLastFetch >= POLL_MS) fetchRouteStopEta();
		}, POLL_MS);
		state.routeTick = setInterval(tickRouteCountdown, 1000);
	}

	function stopRoutePolling() {
		clearInterval(state.routeTimer);
		clearInterval(state.routeTick);
		state.routeTimer = state.routeTick = null;
		state.routeAbort?.abort();
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
		if (document.visibilityState !== 'visible') return;
		if (onPage('eta') && Date.now() - state.lastFetch >= POLL_MS) fetchEta();
		// 路線頁只在有選中站時輪詢（選中站為 null 時沒有可查的資料）
		if (onPage('route') && state.routeSel && Date.now() - state.routeLastFetch >= POLL_MS) fetchRouteStopEta();
	});

	/* Service Worker（規劃書 §5.5） */
	if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
		addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[sw]', e)));
	}

	boot();
})();
