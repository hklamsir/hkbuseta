/**
 * 視覺驗證：附近站／路線詳情頁 scroll 後頁首資訊（sticky-sub）保持可見
 * 產出 screenshots/sticky-nearby.png / sticky-route.png
 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8181';

const browser = await chromium.launch();
const ctx = await browser.newContext({
	viewport: { width: 390, height: 720 },
	geolocation: { latitude: 22.3440, longitude: 114.1935 },
	permissions: ['geolocation'],
	locale: 'zh-HK'
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#locate-btn:not([disabled])', { timeout: 30000 });

// ── 附近站頁：用 GPS 入口（openNearby 內部會等 boot() 完成載入 gz）──
await page.click('#locate-btn');
await page.waitForSelector('#page-nearby.active #nb-list .stop', { timeout: 45000 });

// scroll 到列表中下段
await page.evaluate(() => {
	const rows = document.querySelectorAll('#nb-list .stop');
	rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
});
await page.waitForTimeout(400);

const nbCheck = await page.evaluate(() => {
	const bar = document.querySelector('.sticky-sub');
	const r = bar.getBoundingClientRect();
	const place = document.querySelector('#nb-place')?.textContent;
	// sticky 是否貼住 topbar 底（topbar 高 54）
	return { top: r.top, place, stuck: Math.abs(r.top - 63.5) < 3, inViewport: r.bottom > 0 };
});
console.log('[nearby]', JSON.stringify(nbCheck));
if (!nbCheck.stuck) throw new Error('nearby sticky-sub 未貼頂');
const placeTxt = nbCheck.place;
const barBox = await page.locator('#page-nearby .sticky-sub').boundingBox();
// 地標名必須仍然喺視口內（sticky 先算 keep 住）
const nbVisible = barBox && barBox.y >= 0 && barBox.y < 300;
if (!nbVisible) throw new Error('nearby place-bar 唔喺視口內');
await page.screenshot({ path: 'screenshots/sticky-nearby.png' });

// ── ETA 頁：站名 sticky ──
await page.click('#nb-list .stop');
await page.waitForSelector('#page-eta.active #eta-list .eta-row', { timeout: 15000 });

await page.evaluate(() => {
	const rows = document.querySelectorAll('#eta-list .eta-row');
	rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
});
await page.waitForTimeout(400);
const etaCheck = await page.evaluate(() => {
	const r = document.querySelector('#page-eta .sticky-sub').getBoundingClientRect();
	return { top: r.top, name: document.querySelector('#eta-name')?.textContent };
});
console.log('[eta]', JSON.stringify(etaCheck));
if (Math.abs(etaCheck.top - 63.5) > 3) throw new Error('ETA stop-hero 未貼頂');
await page.screenshot({ path: 'screenshots/sticky-eta.png' });

// ── 路線詳情頁：撳第一條路線 ──
await page.click('#eta-list .eta-row');
await page.waitForSelector('#page-route.active #rt-list .seq-row', { timeout: 15000 });

await page.evaluate(() => {
	const rows = document.querySelectorAll('#rt-list .seq-row');
	rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
});
await page.waitForTimeout(400);

const rtCheck = await page.evaluate(() => {
	const bar = document.querySelector('#page-route .sticky-sub');
	const r = bar.getBoundingClientRect();
	return { top: r.top, stuck: Math.abs(r.top - 63.5) < 3, no: document.querySelector('#rt-no')?.textContent, dest: document.querySelector('#rt-dest')?.textContent };
});
console.log('[route]', JSON.stringify(rtCheck));
if (!rtCheck.stuck) throw new Error('route sticky-sub 未貼頂');
await page.screenshot({ path: 'screenshots/sticky-route.png' });

// ── 使用說明頁：漢堡選單進入 → 返回 ──
await page.evaluate(() => { window.scrollTo(0, 0); });
await page.click('#rt-back');
await page.waitForSelector('#page-eta.active', { timeout: 10000 });
await page.click('#eta-back');
await page.waitForSelector('#page-nearby.active', { timeout: 10000 });
await page.click('#nb-back');
await page.waitForSelector('#page-search.active', { timeout: 10000 });
await page.click('#menu-btn');
await page.click('#menu-help');
await page.waitForSelector('#page-help.active', { timeout: 10000 });
const helpOk = await page.evaluate(() => document.querySelectorAll('#page-help .help-body h2').length);
console.log('[help] sections =', helpOk);
if (helpOk < 5) throw new Error('使用說明頁內容不足');
await page.screenshot({ path: 'screenshots/help-page.png' });
await page.click('#help-back');
await page.waitForSelector('#page-search.active', { timeout: 10000 });
console.log('✅ 說明頁開啟／返回正常');

await browser.close();
console.log('✅ sticky 視覺驗證通過：ETA／附近站／路線詳情 scroll 後資訊仍然貼頂');
