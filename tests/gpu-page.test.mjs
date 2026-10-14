// The page with the river on the GPU (the default where the browser can):
// it runs, the tools work, it switches off and on, and it carries on
// through a save and reload. Run with the built page served:
//   node tools/build-artifact.mjs dist/headwaters.html
//   python3 -m http.server 8112  (in dist)
//   node tests/gpu-page.test.mjs http://localhost:8112
// (The GPU here is emulated on the CPU: this checks it works, not its speed.)
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:8112';
const fails = [];
const check = (ok, l, e = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${e ? '  — ' + e : ''}`); if (!ok) fails.push(l); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
// (Web fonts can't be fetched in some sandboxes; that's not the page's error.)
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
const H = (f, a) => page.evaluate(f, a);
const W = 128;
const at = (x, y) => y * W + x;
const send = (msg) => H((m) => window.Headwaters.send(m), msg);
const look = () => H(() => {
  const f = window.Headwaters.frame();
  let wet = 0, bad = 0, zs = 0;
  for (let i = 0; i < f.h.length; i++) { if (!Number.isFinite(f.h[i]) || !Number.isFinite(f.z[i])) bad++; if (f.h[i] > 0.02) wet++; zs += f.z[i]; }
  return { wet, bad, zs, years: f.years, gpu: f.gpu };
});
const tick = () => H(() => document.getElementById('tick').textContent);

// A fresh world, no choice made on this device: the river goes on the GPU.
await page.goto(`${BASE}/headwaters.html#gpu-page-test`, { waitUntil: 'load' });
await H(() => { localStorage.removeItem('headwaters-gpu'); return new Promise((r) => { const q = indexedDB.deleteDatabase('headwaters'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.Headwaters && window.Headwaters.state());
await page.waitForTimeout(3000);
check(await H(() => !document.getElementById('gpu-row').hidden && document.getElementById('gpu').checked), 'the switch shows, and is on by default');
check(/GPU/.test(await tick()), 'the time bar says GPU', await tick());
const y0 = (await look()).years;
await H(() => window.Headwaters.setRate(30 / 365.25));
await page.waitForTimeout(8000);
let f = await look();
check(f.gpu && f.years > y0, 'the river runs', `${((f.years - y0) * 365.25).toFixed(2)} days in 8 s`);
check(f.wet > 1000 && f.bad === 0, 'with water in it, and no NaNs', `${f.wet} wet cells, ${f.bad} bad`);

// The tools.
const c = at(30, 60);
const zc = () => H((i) => window.Headwaters.frame().z[i], c);
const z0 = await zc();
for (let k = 0; k < 10; k++) await send({ type: 'sculpt', i: c, size: 'big', dir: 1, strength: 'bulldozer' });
await page.waitForTimeout(600);
check((await zc()) > z0 + 5, 'the brush raises the ground', `${z0.toFixed(2)} → ${(await zc()).toFixed(2)} m`);
await send({ type: 'dig', points: [[20, 100], [40, 120]] });
await send({ type: 'block', i: at(64, 80) });
await send({ type: 'place', kind: 'field', i: at(20, 40) });
await send({ type: 'place', kind: 'bridge', points: [[50, 120], [80, 120]] });
await send({ type: 'pump', x: 50 });
await send({ type: 'setting', key: 'flow', value: 30 });
await send({ type: 'setting', key: 'lift', value: 5 });
const deepAbove = () => H(() => { const f = window.Headwaters.frame(); let n = 0; for (let i = 60 * f.W; i < 88 * f.W; i++) if (f.h[i] > 0.5) n++; return n; });
const lake0 = await deepAbove();
await send({ type: 'place', kind: 'dam', points: [[0.5, 90.5], [127.5, 90.5]], size: 'low' });
await send({ type: 'place', kind: 'gauge', i: at(64, 40) });
await send({ type: 'block', i: at(100, 20) });
await send({ type: 'remove', i: at(100, 20) });
await send({ type: 'hold', on: true });
await send({ type: 'hold', on: false });
await page.waitForTimeout(4000);
const kinds = (await H(() => window.Headwaters.events().map((e) => e.kind))).join(',');
for (const k of ['dig', 'block', 'place', 'pump']) check(kinds.includes(k), `${k} works`, kinds);
const things = await H(() => window.Headwaters.frame().things);
const dam = things.find((t) => t.kind === 'dam'), gauge = things.find((t) => t.kind === 'gauge');
check(dam && dam.height === 2, 'a dam goes down');
check(gauge && gauge.series.level.length > 1, 'a gauge goes down and reads', gauge ? `${gauge.series.level.length} readings` : 'none');
check(kinds.includes('remove') && (await H((i) => window.Headwaters.frame().rock[i], at(100, 20))) === 0, 'Remove takes a block away');
const lake = await deepAbove();
check(lake > lake0 + 200, 'and the dam’s reservoir is full of water', `${lake0} → ${lake} cells over half a metre deep behind it`);
const f1 = await look();
check(f1.zs > f.zs + 50000, 'raising the land raises it', `${((f1.zs - f.zs) / W).toFixed(0)} m summed per column`);
check(f1.bad === 0 && f1.years > f.years && f1.gpu, 'and the river carries on', `${f1.wet} wet cells`);

// Off, on, and through a save.
await page.click('#tab-table');
await page.click('#gpu');
await page.waitForTimeout(3000);
const f2 = await look();
check(!f2.gpu && !/GPU/.test(await tick()) && f2.years > f1.years && f2.bad === 0, 'switched off, the CPU carries on', `${f2.wet} wet cells`);
check(Math.abs(f2.wet - f1.wet) < 0.25 * f1.wet, 'with the same river');
await page.click('#gpu');
await page.waitForTimeout(3000);
const f3 = await look();
check(f3.gpu && f3.years > f2.years && f3.bad === 0, 'switched on again, the GPU carries on', `${f3.wet} wet cells`);
await H(() => window.Headwaters.saveNow());
await page.reload({ waitUntil: 'load' });
await page.waitForFunction((y) => window.Headwaters && window.Headwaters.state() && window.Headwaters.state().years >= y, f3.years * 0.99);
await page.waitForTimeout(3000);
const f4 = await look();
check(f4.gpu && f4.years >= f3.years * 0.99 && f4.bad === 0, 'a save and reload comes back on the GPU', `${(f4.years * 365.25).toFixed(1)} days`);
// Off is remembered.
await page.click('#tab-table');
await page.click('#gpu');
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.Headwaters && window.Headwaters.state());
await page.waitForTimeout(2000);
check(!(await H(() => document.getElementById('gpu').checked)) && !/GPU/.test(await tick()), 'switched off stays off after a reload');
check(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
