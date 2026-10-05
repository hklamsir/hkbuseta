/**
 * 驗證 SW 版本追蹤：改殼層檔案 → bump-sw → 確認快取名變化 + 舊快取清理
 */
import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const NODE = process.execPath;
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();

const getShells = () => p.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('buseta-shell')));

async function warm(label) {
	await p.goto('http://localhost:8181/', { waitUntil: 'networkidle' });
	await p.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 20000 });
	await p.waitForTimeout(4000);
	const s = await getShells();
	console.log(`  ${label}: ${s.join(', ') || '(無)'}`);
	return s;
}

console.log('[1] 初始狀態');
const s1 = await warm('首次載入');

console.log('\n[2] 改css/app.css（但唔 bump sw）');
const path = 'public/css/app.css';
const orig = await readFile(path, 'utf8');
await writeFile(path, orig + '\n/* deploy-test */\n');
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(4000);
const s2 = await getShells();
console.log(`  快取名： ${s2.join(', ')}`);
console.log(`  →未 bump 時預期不變： ${s2.join() === s1.join() ? '✅ 符合預期' : '（瀏覽器主動更新了）'}`);

console.log('\n[3] 跑 bump-sw.mjs 後重載');
execFileSync(NODE, ['scripts/bump-sw.mjs'], { stdio: 'inherit' });
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(5000);
const s3 = await getShells();
console.log(`  快取名： ${s3.join(', ')}`);
console.log(`  →版本已 bump： ${s3.join() !== s2.join() ? '✅ 是' : '❌ 否'}`);
console.log(`  →舊快取已清理： ${s3.filter((s) => s1.includes(s)).length === 0 ? '✅ 是' : '❌ 舊的仍在'}`);

console.log('\n[4] 還原檔案 + 再次 bump');
await writeFile(path, orig);
execFileSync(NODE, ['scripts/bump-sw.mjs'], { stdio: 'inherit' });
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(4000);
const s4 = await getShells();
console.log(`  快取名： ${s4.join(', ')}`);

console.log('\n[5] 離線功能仍正常？');
await ctx.setOffline(true);
await p.reload({ waitUntil: 'domcontentloaded' });
let ok = true;
try {
	await p.waitForFunction(() => document.getElementById('data-stamp')?.textContent?.includes('車站'), { timeout: 15000 });
} catch { ok = false; }
console.log(`  離線重載： ${ok ? '✅ 正常' : '❌ 失敗'}`);

await b.close();
process.exit(ok && s3.join() !== s2.join() ? 0 : 1);
