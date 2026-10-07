/**
 * BusETA — Service Worker
 *
 * 依規劃書 §5.5：
 *   1. App Shell 預快取（Cache Storage，版本化）
 *   2. ETA / Nominatim 採 Network First，失敗回退最後一次成功回應
 *
 * 版本管理：SHELL_CACHE 用「資料 buildId + 殼層檔案 hash」組成。
 * buildId 由 build-data.mjs 按資料**內容** hash 算出（gz 已剔除時間戳，
 * 故資料無實質變化時 buildId 不變）；殼層 hash 由本檔案在 install 時對每個
 * 殼層檔案算content hash，並配合 bump-sw.mjs 寫入的 BUILD_STAMP（純內容 hash）。
 * → 資料或程式任一方改動，快取名才會變，用戶自動收到新版本。
 *
 * ⚠️ 維護須知：改任何殼層檔案（index.html / css / js / vendor）後，
 *    必須令本檔案（sw.js）本身也產生變化，否則瀏覽器不會重新執行 install，
 *    新版 App Shell 永遠不會推給用戶。最可靠做法：
 *      node scripts/bump-sw.mjs
 *    會自動更新下方 BUILD_STAMP。
 *    ⚠️ BUILD_STAMP 與 buildId 都**不可**包含日期或時間戳 ——
 *    否則即使內容零變化，每日跑一次部署都會改動 sw.js，
 *    用戶被迫每日重裝 SW 並重下 339 KB 離線資料。
 *    （本機 dev server 無 ETag 時靠 stamp；部署平台兩者皆有效。）
 */

/** 殼層版本戳：純內容 hash（無日期）。改殼層檔案後跑 scripts/bump-sw.mjs 自動更新 */
const BUILD_STAMP = '9fc12b40';

/** 參與版本 hash 的殼層檔案（改動任何一個都會令快取名改變） */
const VERSIONED = [
	'./index.html',
	'./manifest.json',
	'./css/app.css',
	'./js/data.js',
	'./js/app.js',
	'./vendor/leaflet.js',
	'./vendor/leaflet.css'
];

const RUNTIME_CACHE = 'buseta-runtime';

/** fetch handler 在 install 完成前可能先觸發，用呢個作暫存名 */
const SHELL_CACHE_FALLBACK = 'buseta-shell-pending';

/** 安裝時解析出並記錄在self，供 activate / fetch 複用 */
async function resolveShellCache() {
	let stamp = 'initial';
	try {
		const res = await fetch('data/build-manifest.json', { cache: 'no-cache' });
		const m = await res.json();
		if (m.buildId) stamp = m.buildId;
	} catch { /* 離線安裝時取不到 */ }
	stamp = `${stamp}-${BUILD_STAMP}`;

	// 對殼層檔案取指紋。優先用 HTTP ETag / Last-Modified header；
	// 若伺服器冇送（如本機 dev server），退回下載內容計hash。
	try {
		const sigs = await Promise.all(
			VERSIONED.map(async (u) => {
				const viaHead = await fetch(u, { method: 'HEAD', cache: 'no-cache' })
					.then((r) => (r.ok ? r.headers.get('etag') || r.headers.get('last-modified') : ''))
					.catch(() => '');
				if (viaHead) return `h:${viaHead}`;
				// 退回：下載內容算 hash（檔案小，總量 < 200 KB，可接受）
				const r = await fetch(u, { cache: 'no-cache' });
				if (!r.ok) return '';
				const txt = await r.text();
				return `c:${txt.length}:${cheapHash(txt)}`;
			})
		);
		if (sigs.some(Boolean)) {
			stamp = `${stamp}-${cheapHash(sigs.join('|'))}`;
		}
	} catch { /* 取不到時只用資料 buildId */ }

	return `buseta-shell-${stamp}`;
}

/** 輕量字串 hash（FNV-1a 變體）— 不需加密強度，只需內容變化即變 */
function cheapHash(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

/** App Shell：安裝時全部預快取 */
const SHELL = [
	'./',
	'./index.html',
	'./manifest.json',
	'./css/app.css',
	'./js/data.js',
	'./js/app.js',
	'./vendor/leaflet.js',
	'./vendor/leaflet.css',
	'./vendor/images/marker-icon.png',
	'./vendor/images/marker-icon-2x.png',
	'./vendor/images/marker-shadow.png',
	'./vendor/images/layers.png',
	'./vendor/images/layers-2x.png',
	'./icons/icon.svg',
	'./data/stops.json.gz',
	'./data/routes.json.gz',
	'./data/build-manifest.json'
];

self.addEventListener('install', (e) => {
	e.waitUntil((async () => {
		const cacheName = await resolveShellCache();
		self.__shellCache = cacheName;
		const c = await caches.open(cacheName);
		await c.addAll(SHELL);
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', (e) => {
	e.waitUntil((async () => {
		const cacheName = self.__shellCache || await resolveShellCache();
		const keys = await caches.keys();
		await Promise.all(
			keys.filter((k) => k !== cacheName && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
		);
		await self.clients.claim();
	})());
});

self.addEventListener('message', (e) => {
	// 頁面偵測到新版本時要求跳過等待
	if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET') return;

	const url = new URL(req.url);
	const sameOrigin = url.origin === location.origin;

	// 離線：Nominatim 不快取（避免快取到過期地標）；OSM 圖磚不快取（數量多且體積大）
	if (!sameOrigin) return;

	// 離線資料：Cache First（每日更新，版本化由部署控制）
	if (url.pathname.endsWith('.json.gz') || url.pathname.endsWith('build-manifest.json')) {
		e.respondWith(
			caches.match(req).then((hit) => hit || fetch(req).then((res) => {
				const copy = res.clone();
				caches.open(self.__shellCache || SHELL_CACHE_FALLBACK).then((c) => c.put(req, copy));
				return res;
			}).catch(() => hit))
		);
		return;
	}

	// App Shell：Stale While Revalidate
	e.respondWith(
		caches.match(req).then((hit) => {
			const net = fetch(req).then((res) => {
				if (res.ok) {
					const copy = res.clone();
					caches.open(self.__shellCache || SHELL_CACHE_FALLBACK).then((c) => c.put(req, copy));
				}
				return res;
			}).catch(() => hit);
			return hit || net;
		})
	);
});

/**
 * ETA 請求：Network First，失敗回退到快取的最後一次成功回應。
 * 用戶在無網絡但曾載入過該站時，仍能看到上一次的到站時間（附過時提示）。
 */
self.addEventListener('fetch', (e) => {
	const req = e.request;
	const url = new URL(req.url);
	if (url.hostname !== 'data.etabus.gov.hk') return;

	e.respondWith(
		fetch(req)
			.then((res) => {
				if (res.ok) {
					const copy = res.clone();
					caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
				}
				return res;
			})
			.catch(() => caches.match(req).then((hit) => hit || Response.error()))
	);
});
