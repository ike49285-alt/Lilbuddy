// Phone-speed responsiveness: CPU slowed 4×, as on a phone.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8112/headwaters.html#speed-test';
const fails = [];
const check = (ok, l, e = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${e ? '  — ' + e : ''}`); if (!ok) fails.push(l); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const cdp = await ctx.newCDPSession(page);
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.Headwaters && window.Headwaters.state(), null, { timeout: 60000 });

async function phoneChecks(label) {
  await page.waitForTimeout(2500);
  const fast = await page.evaluate(() => window.Headwaters.fps());
  check(fast.fps >= 20, `${label}: smooth without slowdown`, `${fast.fps} fps drawn, pacing ${fast.paceMs.toFixed(0)} ms`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => {
    window.__long = [];
    if (!window.__obs) { window.__obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }); window.__obs.observe({ entryTypes: ['longtask'] }); }
  });
  await page.waitForTimeout(4000);
  const lt = await page.evaluate(() => { const a = window.__long; window.__long = []; return { total: a.reduce((s, x) => s + x, 0), max: Math.max(0, ...a) }; });
  const slow = await page.evaluate(() => window.Headwaters.fps());
  check(lt.total < 1200, `${label}: main thread mostly free at 1 day/s, slowed 4×`, `long tasks ${lt.total.toFixed(0)} ms of 4,000, longest ${lt.max.toFixed(0)} ms; ${slow.fps} fps, pacing ${slow.paceMs.toFixed(0)} ms`);
  let t0 = Date.now();
  await page.selectOption('#rate-select', 'max', { timeout: 5000 });
  check(Date.now() - t0 < 1500, `${label}: the rate list responds`, `${Date.now() - t0} ms`);
  await page.waitForTimeout(3000);
  t0 = Date.now();
  await page.locator('#play').tap({ timeout: 5000 });
  await page.waitForFunction(() => window.Headwaters.state().paused, null, { timeout: 5000 });
  const ms = Date.now() - t0;
  check(ms < 400, `${label}: pause takes effect quickly at full speed`, `${ms} ms`);
  const y0 = await page.evaluate(() => window.Headwaters.state().years);
  await page.waitForTimeout(1200);
  const y1 = await page.evaluate(() => window.Headwaters.state().years);
  check(y0 === y1, `${label}: and it stays paused`, `${y0} → ${y1}`);
  await page.locator('#play').tap();
  t0 = Date.now();
  await page.locator('#slower').tap({ timeout: 5000 });
  await page.locator('#slower').tap({ timeout: 5000 });
  check(Date.now() - t0 < 1500, `${label}: − responds`, `${Date.now() - t0} ms`);
  const box = await page.locator('#rate-slider').boundingBox();
  t0 = Date.now();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  check(Date.now() - t0 < 1500, `${label}: the slider responds`, `${Date.now() - t0} ms`);
  await page.selectOption('#rate-select', '6');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}

await phoneChecks('fresh world');
// A world with plenty of life, then the same checks.
await page.evaluate(() => window.Headwaters.runTo(60 / 365.25, 3000));
await page.waitForTimeout(500);
await phoneChecks('two months on');
check(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(fails.length ? `FAILURES: ${fails.join('; ')}` : 'all checks passed');
process.exit(fails.length ? 1 : 0);
