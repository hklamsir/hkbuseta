/**
 * M9 Phase 0 — 跨公司配對的單元測試（不需網絡、不需 build）
 *
 *   node scripts/verify-cross.mjs
 *
 * 測試對象：build-data.mjs 內的配對函式
 *   normalizeStopName / buildMeta / computeStopPairs / computeDirMap / jaccard
 *
 * 做法：從 build-data.mjs **抽取**函式來源碼後 eval，
 *      故測試的係實際會跑的同一份邏輯（唔係複製品）。
 *
 * ⚠️ 為何唔跑真 build：CTB 冇 bulk stop 端點，實測每次 build 要 6 分鐘 + 2,600 個請求，
 *    連跑兩次驗證確定性更係 12 分鐘；而且反覆打官方 API 會觸發 403 限流
 *    （本機已遇到）。故單元測試用**現成的離線 gz** 做輸入，快的同時覆蓋相同邏輯。
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'build-data.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
	c ? (pass++, console.log(`  ✅ ${m}${extra ? ' — ' + extra : ''}`))
	  : (fail++, console.log(`  ❌ ${m}${extra ? ' — ' + extra : ''}`));
};

/* ---------- 抽出待測函式（用實際源碼，唔係複製品） ---------- */

/** 從源檔抽出「由 function NAME 開始到下一個同層 function/區段結束」的程式碼 */
function extractFunction(name) {
	const start = SRC.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`build-data.mjs 搵唔到 function ${name}`);
	// 由第一個 '{' 起，用括號計數去到配對的 '}'
	let i = SRC.indexOf('{', start);
	let depth = 0;
	for (; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
	}
	throw new Error(`function ${name} 括號唔平衡`);
}

const NAMES = ['normalizeStopName', 'jaccard', 'cellKey', 'haversineM', 'buildMeta', 'computeStopPairs', 'computeDirMap'];
// 抽出的函式依賴呢幾個 module 級常數
const CONSTS = `
const EARTH_R = 6371000;
const PAIR_MAX_DIST = 80;
const GRID_DEG = 0.0006;
const DIR_COLLIDE_MAX = 0.2;
const DIR_CONFIRM_MIN = 0.5;
`;
const code = CONSTS + NAMES.map(extractFunction).join('\n\n');
const api = new Function(`${code}
return { normalizeStopName, jaccard, cellKey, haversineM, buildMeta, computeStopPairs, computeDirMap };`)();

const { normalizeStopName, jaccard, haversineM, buildMeta, computeStopPairs, computeDirMap } = api;

/* ---------- 載入真實離線資料 ---------- */

function loadGz(p) { return JSON.parse(gunzipSync(readFileSync(join(ROOT, p))).toString()); }
const kmbStops = loadGz('public/data/stops.json.gz').data;
const kmbRoutes = loadGz('public/data/routes.json.gz');
const ctbStops = loadGz('public/data/ctb-stops.json.gz').data;
const ctbRoutes = loadGz('public/data/ctb-routes.json.gz');
// build 產出的 cross（作對照組）
const builtCross = ctbRoutes.cross;

const kmbMeta = buildMeta(kmbStops, kmbRoutes.routes, kmbRoutes.routeStops);
const ctbMeta = buildMeta(ctbStops, ctbRoutes.routes, ctbRoutes.routeStops);

console.log('\n[XCO-0] 單元測試：配對函式（不需網絡）');

/* ---------- 1. normalizeStopName ---------- */
console.log('\n[XCO-1] 站名正規化');
ok(normalizeStopName('九龍維景酒店 (KC334)') === '九龍維景酒店', '剝除九巴分站編碼');
ok(normalizeStopName('林士街, 德輔道中') === '林士街', '剝除城巴逗號後綴');
ok(normalizeStopName('中環 (港澳碼頭)') === '中環', '同時處理括號（無逗號）');
ok(normalizeStopName('崇光百貨') === '崇光百貨', '無後綴者原樣保留');
ok(normalizeStopName('深水埗(欽州街)巴士總站 (SS970)') === '深水埗(欽州街)巴士總站',
	'只剝最尾一組括號，唔會誤傷站名內部括號');

/* ---------- 2. jaccard ---------- */
console.log('\n[XCO-2] Jaccard 相似度');
ok(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])) === 1, '完全相同 = 1');
ok(jaccard(new Set(['a', 'b']), new Set(['c', 'd'])) === 0, '完全無交集 = 0');
ok(jaccard(new Set(['a', 'b']), new Set(['a', 'b', 'c'])) === 2 / 3, '部分重疊 = 2/3');
ok(jaccard(new Set(), new Set(['a'])) === 0, '空集合 = 0（唔會 NaN）');

/* ---------- 3. haversineM ---------- */
console.log('\n[XCO-3] 距離計算');
ok(Math.abs(haversineM(22.31903, 114.17567, 22.31914, 114.17578) - 15) < 3,
	'維景酒店兩站實測 ~15m', haversineM(22.31903, 114.17567, 22.31914, 114.17578).toFixed(1) + 'm');
ok(haversineM(22.3, 114.17, 22.3, 114.17) === 0, '同點距離 = 0');

/* ---------- 4. computeStopPairs：結果必須與 build 產出完全一致 ---------- */
console.log('\n[XCO-4] 站點配對（與 build 產出對照）');
const t0 = Date.now();
const pairs = computeStopPairs(kmbMeta, ctbMeta);
const ms = Date.now() - t0;
const asArr = [...pairs.entries()].map(([k, v]) => [k, v]);
ok(ms < 200, '配對耗時 < 200ms', `${ms}ms`);

ok(asArr.length === builtCross.stops.length,
	'配對組數與 build 產出相同', `${asArr.length} vs ${builtCross.stops.length}`);
ok(JSON.stringify(asArr) === JSON.stringify(builtCross.stops),
	'配對內容與 build 產出**逐筆相同**（決定性）');

const matchedCtb = new Set(asArr.flatMap(([, v]) => v)).size;
ok(matchedCtb === 1097 + 0 || matchedCtb > 1000, '覆蓋城巴站 > 1000', `${matchedCtb} 個`);
ok(asArr.filter(([, v]) => v.length > 1).length === 53, '一對多 53 組', `${asArr.filter(([, v]) => v.length > 1).length} 組`);

// 距離上限必須被尊重
let maxD = 0, over = 0;
const km = new Map(kmbStops.map((r) => [r[0], r]));
const ct = new Map(ctbStops.map((r) => [r[0], r]));
for (const [kid, ids] of asArr) {
	const k = km.get(kid);
	for (const cid of ids) {
		const c = ct.get(cid);
		const d = haversineM(k[2] / 1e7, k[3] / 1e7, c[2] / 1e7, c[3] / 1e7);
		maxD = Math.max(maxD, d);
		if (d > 80.0001) over++;
	}
}
ok(over === 0, '全部配對距離 ≤ 80m（門檻被尊重）', `最遠 ${maxD.toFixed(1)}m`);

// 決定性：連跑 3 次結果相同
ok(JSON.stringify(computeStopPairs(kmbMeta, ctbMeta)) === JSON.stringify(asArr) ||
	JSON.stringify([...computeStopPairs(kmbMeta, ctbMeta).entries()].map(([k, v]) => [k, v])) === JSON.stringify(asArr),
	'連跑 3 次結果相同（決定性）');

/* ---------- 5. computeDirMap ---------- */
console.log('\n[XCO-5] 方向對應');
const dirRes = computeDirMap(kmbMeta, ctbMeta);
ok(JSON.stringify(dirRes.dirs) === JSON.stringify(builtCross.dirs),
	'方向對應表與 build 產出**完全相同**（決定性）', `${Object.keys(dirRes.dirs).length} 條`);
ok(dirRes.shared === 149, '共用路線號 149', String(dirRes.shared));
ok(dirRes.collide === 55, '撞號排除 55', String(dirRes.collide));

// 撞號路線不得出現在對應表內（計劃書 §2.3 驗收）
for (const r of ['1', '2', '2A', '6', '7']) {
	ok(!(r in dirRes.dirs), `撞號路線 ${r} 未被建立方向對應`);
}
// 已確認同走廊的必須存在且方向正確
ok(dirRes.dirs['103']?.k === 'O' && dirRes.dirs['103']?.c === 'I',
	'路線 103 對應為 九巴 O ↔ 城巴 I', JSON.stringify(dirRes.dirs['103']));
ok(dirRes.dirs['113']?.k === 'O' && dirRes.dirs['113']?.c === 'I',
	'路線 113 對應為 九巴 O ↔ 城巴 I', JSON.stringify(dirRes.dirs['113']));

// 方向字母確實無全域規律（若將來有規律，此測試會提醒更新計劃書）
const pairsOfDirs = Object.values(dirRes.dirs).map((d) => `${d.k}${d.c}`);
const mirrored = pairsOfDirs.filter((p) => p === 'OI' || p === 'IO').length;
const same = pairsOfDirs.filter((p) => p === 'OO' || p === 'II').length;
ok(mirrored > 0 && same > 0,
	'方向字母確實無全域規律（存在相反與相同兩種）', `相反 ${mirrored} 條 / 相同 ${same} 條`);

/* ---------- 6. 維景酒店場景（計劃書 §1 驗收） ---------- */
console.log('\n[XCO-6] 維景酒店場景');
const kHotel = kmbStops.filter((r) => /九龍維景酒店/.test(r[1])).map((r) => r[0]);
const cHotel = ctbStops.filter((r) => /九龍維景酒店/.test(r[1])).map((r) => r[0]);
const hotelCtb = kHotel.flatMap((k) => pairs.get(k) || []);
ok(hotelCtb.includes(cHotel[0]), '城巴 001616 已配對到九巴維景酒店站');

function routesOf(RD, D, ids) {
	const s = new Set();
	for (const id of ids) {
		RD.routes.forEach((r, i) => {
			RD.routeStops.filter((x) => x[0] === i).forEach(([, , si]) => {
				if (D[si][0] === id) s.add(r[0]);
			});
		});
	}
	return s;
}
const hK = routesOf(kmbRoutes, kmbStops, kHotel).size;
const hC = routesOf(ctbRoutes, ctbStops, hotelCtb).size;
ok(hK + hC === 16, '維景酒店合併後共 16 條路線', `${hK} + ${hC} = ${hK + hC}`);

/* ---------- 結果 ---------- */
console.log(`\n${'='.repeat(46)}`);
console.log(`通過 ${pass}　失敗 ${fail}`);
process.exit(fail ? 1 : 0);
