// The page: it runs, the tools work by touch without scrolling the page,
// the layers, charts and 3D view draw, and nothing throws.
import { chromium } from 'playwright';
const fails = [];
const check = (ok, l, e = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${e ? '  — ' + e : ''}`); if (!ok) fails.push(l); };
const BASE = process.argv[2] || 'http://localhost:8112';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${BASE}/headwaters.html#ui-test`, { waitUntil: 'load' });
await page.waitForFunction(() => window.Headwaters && window.Headwaters.state(), null, { timeout: 60000 });
await page.waitForTimeout(2500);
const st = await page.evaluate(() => window.Headwaters.state());
check(st && st.years > 0, 'the river runs', `${(st.years * 365.25 * 24).toFixed(1)} hours in`);
check(await page.evaluate(() => document.getElementById('time').textContent.startsWith('day')), 'the clock shows the day');
// A brush stroke by touch: the ground rises and the page doesn't scroll.
await page.evaluate(() => window.Headwaters.arm('raise'));
const box = await page.locator('#map-canvas').boundingBox();
const cdp = await ctx.newCDPSession(page);
const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
const z0 = await page.evaluate(() => { const f = window.Headwaters.frame(); return f.z[100 * f.W + 25]; });
const scroll0 = await page.evaluate(() => window.scrollY);
const p0 = at(25.5 / 128, 100.5 / 256);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p0.x, y: p0.y }] });
for (let k = 1; k <= 8; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p0.x, y: p0.y + k * 2 }] }); await page.waitForTimeout(80); }
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(600);
const z1 = await page.evaluate(() => { const f = window.Headwaters.frame(); return f.z[100 * f.W + 25]; });
const scroll1 = await page.evaluate(() => window.scrollY);
check(z1 > z0 + 0.2 && scroll1 === scroll0, 'a Raise stroke piles up sand and the page stays put', `+${(z1 - z0).toFixed(2)} m, scrolled ${scroll1 - scroll0}px`);
// Section by drawing a line across the river.
await page.evaluate(() => window.Headwaters.arm('section'));
const a = at(20 / 128, 120 / 256), b = at(108 / 128, 120 / 256);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
for (let k = 1; k <= 10; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * k / 10, y: a.y }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(1200);
const sec = await page.evaluate(() => { const f = window.Headwaters.frame(); return f.section ? { n: f.section.bed.length, len: f.section.length } : null; });
check(sec && sec.n === 96, 'Section draws a cross-section', sec ? `${sec.len.toFixed(0)} m` : 'none');
const shown = await page.evaluate(() => !document.getElementById('pane-profile').hidden && !document.getElementById('section').hidden);
check(shown, 'and the Profile tab opens to show it');
await page.waitForTimeout(800);
const inked = await page.evaluate(() => {
  const c = document.getElementById('profile'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++; return n / (d.length / 4);
});
check(inked > 0.1, 'the long profile is drawn', `${(inked * 100).toFixed(0)}% of the chart`);
await page.screenshot({ path: 'ui-profile.png', fullPage: false });
// Block and Storm by tap.
await page.evaluate(() => window.Headwaters.arm('block'));
const c = at(64.5 / 128, 60.5 / 256);
await page.touchscreen.tap(c.x, c.y);
await page.waitForTimeout(600);
const blk = await page.evaluate(() => { const f = window.Headwaters.frame(); return f.rock[60 * f.W + 64]; });
check(blk === 1, 'Block drops a block of rock where tapped');
await page.evaluate(() => window.Headwaters.arm('storm'));
await page.touchscreen.tap(c.x, c.y);
await page.waitForTimeout(800);
const rate = await page.evaluate(() => window.Headwaters.state().targetRate * 365.25 * 24);
check(Math.abs(rate - 6) < 0.01, 'Storm slows the clock to watch the flood', `${rate.toFixed(1)} hr/s`);
check((await page.evaluate(() => window.Headwaters.events())).some((e) => /storm/.test(e.label)), 'with a note');
await page.evaluate(() => window.Headwaters.arm(null));
// Layers.
for (const m of ['depth', 'speed', 'drag', 'change', 'cutfill']) {
  await page.evaluate((mm) => window.Headwaters.mode(mm), m);
  await page.waitForTimeout(400);
  const ok = await page.evaluate(() => !!window.Headwaters.frame().layer && !document.getElementById('layer-key').hidden);
  if (!ok) check(false, `the ${m} layer shows`);
}
check(true, 'the five layers show with their keys');
await page.evaluate(() => window.Headwaters.mode('landscape'));
// 3D.
await page.evaluate(() => window.Headwaters.set3d(true));
await page.waitForTimeout(1500);
const shot = await page.evaluate(() => window.Headwaters.shot3d());
check(shot.sky < 0.6 && shot.mean[1] > 40, 'the 3D view draws the valley', `sky ${(shot.sky * 100).toFixed(0)}%`);
await page.screenshot({ path: 'ui-3d.png' });
await page.evaluate(() => window.Headwaters.set3d(false));
// Saving.
await page.evaluate(() => window.Headwaters.saveNow());
const yrs = await page.evaluate(() => window.Headwaters.state().years);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.Headwaters && window.Headwaters.state(), null, { timeout: 60000 });
const yrs2 = await page.evaluate(() => window.Headwaters.state().years);
check(yrs2 >= yrs * 0.99 && yrs2 > 0, 'a reload picks up the saved river', `${(yrs * 8766).toFixed(2)} → ${(yrs2 * 8766).toFixed(2)} hours`);
check(errs.length === 0, 'nothing throws', errs.slice(0, 3).join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
