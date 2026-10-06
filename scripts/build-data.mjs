/**
 * M0 — 離線資料打包腳本
 *
 * 抓取運輸署 KMB/LWB 靜態資料 → 精簡 → gzip → public/data/
 *
 *   node scripts/build-data.mjs
 *
 * 設計重點（見規劃書 §5.2）：
 *   - 刪除冗餘欄位（co 永遠 "KMB"、data_timestamp 每日重覆）
 *   - 字串 ID（16 字符 stop ID、路線號）改為整數索引
 *     → gzip 時重複度極高，壓縮率大幅提升
 *   - 座標轉為整數微度（1e-7 ≈ 1.1cm，遠超 GPS 精度需求）
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const UA = 'BusETA-DataBuilder/1.0 (open-data packaging script)';

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(path, attempt = 1) {
	const url = `${BASE}/${path}`;
	process.stdout.write(`  GET ${path} (嘗試 ${attempt}) ... `);
	try {
		const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
		if (res.status === 403 || res.status === 429) {
			process.stdout.write(`HTTP ${res.status}`);
			if (attempt < 4) {
				const wait = attempt * 3000;
				process.stdout.write(`，${wait / 1000}s 後重試\n`);
				await sleep(wait);
				return fetchJson(path, attempt + 1);
			}
			throw new Error(`HTTP ${res.status}（已重試 ${attempt - 1} 次）`);
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		const json = JSON.parse(text);
		// 官方錯誤回應形如 { code: "422", message: "..." }
		if (json.code && json.data === undefined) {
			throw new Error(`API error ${json.code}: ${json.message}`);
		}
		process.stdout.write(`${(text.length / 1024).toFixed(0)} KB, ${json.data.length} 筆\n`);
		return json.data;
	} catch (e) {
		// 網絡層錯誤（DNS／連線中斷）也重試
		if (attempt < 4 && !/HTTP \d{3}$/.test(e.message)) {
			const wait = attempt * 3000;
			process.stdout.write(`失敗（${e.message}），${wait / 1000}s 後重試\n`);
			await sleep(wait);
			return fetchJson(path, attempt + 1);
		}
		throw e;
	}
}

function gzipToFile(name, obj) {
	const raw = Buffer.from(JSON.stringify(obj), 'utf8');
	const gz = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
	return { name, raw, gz };
}

async function main() {
	console.log('M0 — 抓取 KMB/LWB 靜態資料\n');
	const t0 = Date.now();

	// 1. 車站表
	console.log('[1/3] /stop');
	const stopRows = await fetchJson('stop');

	// 2. 路線表
	console.log('[2/3] /route/');
	const routeRows = await fetchJson('route/');

	// 3. 路線站序
	console.log('[3/3] /route-stop');
	const rsRows = await fetchJson('route-stop');

	// ---- 精簡車站表 ----
	// ["stopId16", "中文名", latE7, lngE7]
	const stops = stopRows.map((s) => [s.stop, s.name_tc, Math.round(parseFloat(s.lat) * 1e7), Math.round(parseFloat(s.long) * 1e7)]);

	const stopIndex = new Map();
	stops.forEach((s, i) => stopIndex.set(s[0], i));

	// ---- 精簡路線表 ----
	// ["route", "bound", serviceType, dest_tc]
	// routeIndex 的 key 順序即為此陣列的索引
	const routes = routeRows.map((r) => [r.route, r.bound, parseInt(r.service_type, 10), r.dest_tc]);
	const routeIndex = new Map();
	routes.forEach((r, i) => routeIndex.set(routeKey(r[0], r[1], r[2]), i));

	// ---- 精簡路線站序 ----
	// [routeIdx, seq, stopIdx]
	const routeStops = [];
	let missingStop = 0;
	let missingRoute = 0;
	for (const rs of rsRows) {
		const svc = parseInt(rs.service_type, 10);
		const ri = routeIndex.get(routeKey(rs.route, rs.bound, svc));
		const si = stopIndex.get(rs.stop);
		if (ri === undefined) { missingRoute++; continue; }
		if (si === undefined) { missingStop++; continue; }
		routeStops.push([ri, parseInt(rs.seq, 10), si]);
	}
	// 按 routeIdx, seq 排序，前端可直接分段
	routeStops.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

	console.log(`\n精簡結果：`);
	console.log(`  車站       ${stops.length} 個`);
	console.log(`  路線       ${routes.length} 條`);
	console.log(`  路線站序${routeStops.length.toLocaleString()} 筆`);
	if (missingRoute) console.warn(`  ⚠ 跳過 ${missingRoute} 筆找不到路線定義的關聯`);
	if (missingStop) console.warn(`  ⚠ 跳過 ${missingStop} 筆找不到車站的關聯`);

	// ---- 輸出 ----
	await mkdir(OUT_DIR, { recursive: true });

	// ⚠️ gz 內容**不可**包含任何時間戳或隨機值，否則每次產出的位元組都不同。
	//
	// 原因：buildId 會成為 Service Worker 的快取名（見 sw.js resolveShellCache）。
	// 若 gz 含時間戳，即使官方資料實際零變化，buildId 都會每日改變
	// → 用戶每日被迫重新下載 339 KB 離線資料並重裝 SW，但內容其實一模一樣
	//（實測 2026-10-05 vs 10-06 僅 86S 兩行 routeStops 改動）。
	//
	// 打包時間改記於 build-manifest.json 的 built / updated（該檔不參與 buildId 計算，
	// 亦不列入 bump-sw.mjs 的 VERSIONED），前端由 data.js 讀 manifest.updated 顯示。
	const builtAt = new Date();
	const files = [
		gzipToFile('stops.json.gz', { v: 1, data: stops }),
		gzipToFile('routes.json.gz', { v: 1, routes, routeStops })
	];

	for (const f of files) {
		await writeFile(join(OUT_DIR, f.name), f.gz);
		const ratio = ((1 - f.gz.length / f.raw.length) * 100).toFixed(1);
		console.log(`\n  ${f.name}`);
		console.log(`    原始 ${(f.raw.length / 1024).toFixed(0).padStart(6)} KB`);
		console.log(`    gzip ${(f.gz.length / 1024).toFixed(0).padStart(6)} KB  （壓縮率 ${ratio}%）`);
	}

	const totalGz = files.reduce((s, f) => s + f.gz.length, 0);
	const totalRaw = files.reduce((s, f) => s + f.raw.length, 0);
	console.log(`\n  合計 ${(totalRaw / 1024).toFixed(0)} KB → ${(totalGz / 1024).toFixed(0)} KB`);
	console.log(`  官方原始 4.24 MB → ${(totalGz / 4.24e6 * 100).toFixed(1)}%`);

	// buildId = **未壓縮 JSON 內容**的 hash 前 8 碼（不是 gz 的 hash）
	//
	// 為何用 raw 而非 gz：gzip 輸出位元組依賴 zlib 版本。本機 Windows（zlib 1.3.1-e00f703）
	// 與 GitHub Actions ubuntu-latest 的 zlib patch 版本可能不同 → 即使資料完全相同，
	// 兩邊產出的 gz 位元組仍可能不一致。若 buildId 取自 gz，CI 會每日誤判「資料有變」，
	// 反而每天都部署、每天都逼用戶重下載 —— 正是本改造要消除的問題。
	// raw JSON 內容跨平台穩定，故 buildId 只反映真正的資料變化。
	//
	// 效果：
	//   資料無實質變化 → buildId 不變 → 用戶不會收到無謂更新（跨平台一致）
	//   資料有變化     → buildId 變 → 用戶自動收到新版
	const { createHash } = await import('node:crypto');
	const h = createHash('sha256');
	for (const f of files) h.update(f.raw);
	const buildId = h.digest('hex').slice(0, 8);

	const manifest = {
		built: builtAt.toISOString(),
		// 顯示用時間（Y-M-D H:M），供前端 UI 顯示「更新於 …」；不參與任何 hash
		updated: builtAt.toISOString().slice(0, 16).replace('T', ' '),
		buildId,
		stops: stops.length,
		routes: routes.length,
		routeStops: routeStops.length,
		files: files.map((f) => ({ name: f.name, raw: f.raw.length, gz: f.gz.length }))
	};
	await writeFile(join(OUT_DIR, 'build-manifest.json'), JSON.stringify(manifest, null, 2));

	console.log(`\n  buildId: ${buildId}（Service Worker 快取名 buseta-shell-${buildId}）`);
	console.log(`  打包時間: ${manifest.updated}（不參與 buildId，資料無變則 buildId 不變）`);
	console.log(`✅ 完成，耗時 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

function routeKey(route, bound, svc) {
	return `${route}|${bound}|${svc}`;
}

main().catch((e) => {
	console.error(`\n❌ ${e.message}`);
	process.exit(1);
});
