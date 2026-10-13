// The river on the GPU against the river on the CPU, from the same world:
// one move of the bed pass by pass, then hundreds of steps; they should
// agree closely. Run with the repository served:
//   python3 -m http.server 8114  (in the repository)
//   node tests/gpu.test.mjs http://localhost:8114
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:8114';
const fails = [];
const check = (ok, l, e = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${e ? '  — ' + e : ''}`); if (!ok) fails.push(l); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error:', e.message));
for (const [label, query] of [['a quiet bed', 'seed=gpu-2&warm=3000&morph=2000'], ['a busy bed', 'seed=river-a&warm=12000&morph=20000'], ['a dam drowning the inlet', 'seed=river-a&warm=12000&morph=20000&dam=1']]) {
  await page.goto(`${BASE}/tests/gpu-bed.html?${query}`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.result, null, { timeout: 900000, polling: 1000 });
  const r = await page.evaluate(() => window.result);
  if (r.error) { check(false, `${label}: runs`, r.error.split('\n')[0]); console.log(r.error); continue; }
  for (const k of ['theta', 'sx', 'sy', 'gs']) check(r[k].rel < 1e-4, `${label}: one move, ${k} agrees`, `worst ${r[k].worst.toExponential(2)} of ${r[k].scale.toExponential(2)}`);
  // Mud left in dry cells outside the CPU's worked-on stretch settles on the
  // GPU, which works on every cell: a few cells differ.
  check(r['z change'].mean < 1e-3 * r['z change'].scale, `${label}: one move, the bed's change agrees`, `mean difference ${r['z change'].mean.toExponential(2)} m, worst ${r['z change'].worst.toExponential(2)} of ${r['z change'].scale.toExponential(2)}`);
  check(Math.abs(r.mdt[0] - r.mdt[1]) < 1e-4 * r.mdt[0] && r.mNow[0] === Math.fround(r.mNow[1]) || Math.abs(r.mNow[0] - r.mNow[1]) < 1e-3 * r.mNow[0], `${label}: the same bed time and speed-up`, `${r.mdt.map((v) => v.toFixed(1)).join(' / ')} s`);
  const c = r.counters;
  check(Math.abs(c.fedIn[0] - c.fedIn[1]) <= 1e-4 * c.fedIn[0] + 1e-12, `${label}: the same sand fed in`, c.fedIn.map((v) => v.toExponential(4)).join(' / '));
  check(Math.abs(r.feed[0] - r.feed[1]) <= 1e-3 * r.feed[0] + 1e-15, `${label}: the same memory of the pump's sand`, r.feed.map((v) => v.toExponential(3)).join(' / '));
  check(Math.abs(r.volume[0] - r.volume[1]) < 0.1 * Math.abs(r.volume[0]) + 1e-3, `${label}: about the same ground laid down`, r.volume.map((v) => v.toFixed(3)).join(' / ') + ' m³');
}
// On the plain without its hills they agree to the centimetre. Among the
// hills, their flanks slump where the water reaches them, worked out all at
// once on the GPU and cell by cell on the CPU: close, not the same. With
// the bed moving fast, float32 against float64 grows into differences as
// big as the CPU's own against itself nudged by 0.01% (98.9% of depths
// within a centimetre, ground 3 m³ apart, sand fed 1%); and where a dam's
// spillway takes the water over fast, the GPU and CPU make different
// splashes, though the reservoir stands at the same level.
// [label, query, share of depths within a centimetre, ground apart (m³), sand fed apart (share)]
for (const [label, query, close, ground, fed] of [
  ['young water', 'seed=gpu-1&warm=600&steps=200&hills=0', 0.99, 1, 0.01],
  ['with the bed moving fast', 'seed=gpu-2&warm=3000&steps=400&morph=2000&hills=0', 0.97, 20, 0.05],
  ['among the hills, the bed moving fast', 'seed=gpu-2&warm=3000&steps=400&morph=2000', 0.85, 20, 0.05],
  ['with a dam’s reservoir', 'seed=gpu-2&warm=3000&steps=400&morph=2000&hills=0&dam=1', 0.9, 20, 0.03],
]) {
  await page.goto(`${BASE}/tests/gpu-check.html?${query}`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.result, null, { timeout: 900000, polling: 1000 });
  const r = await page.evaluate(() => window.result);
  if (r.error) { check(false, `${label}: runs`, r.error.split('\n')[0]); console.log(r.error); continue; }
  check(r.available, `${label}: the browser can compute on the GPU`);
  check(r.close > close, `${label}: depths agree within a centimetre`, `${(r.close * 100).toFixed(2)}% of ${r.wet} wet cells, worst ${r.worst.toFixed(3)} m`);
  check(Math.abs(r.water[0] - r.water[1]) < 1e-3 * r.water[0], `${label}: the same water`, `${r.water[0].toFixed(1)} vs ${r.water[1].toFixed(1)} m³`);
  check(Math.abs(r.mud[0] - r.mud[1]) < 0.01 * r.mud[0] + 1e-3, `${label}: the same mud`, `${r.mud[0].toFixed(3)} vs ${r.mud[1].toFixed(3)} m³`);
  check(Math.abs(r.ground[0] - r.ground[1]) < ground, `${label}: the same ground`, `${(r.ground[1] - r.ground[0]).toFixed(2)} m³ apart`);
  if (r.lake) check(Math.abs(r.lake.cpu - r.lake.gpu) < 0.01 && r.lake.meanDiff < 0.03, `${label}: the reservoir stands at the same level`, `${r.lake.cpu.toFixed(3)} / ${r.lake.gpu.toFixed(3)} m, ${(r.lake.meanDiff * 100).toFixed(1)} cm apart on average`);
  check(Math.abs(r.fedIn[0] - r.fedIn[1]) < fed * r.fedIn[0] + 1e-3, `${label}: the same sand fed in`, `${r.fedIn[0].toFixed(2)} vs ${r.fedIn[1].toFixed(2)} m³`);
  check(Math.abs(r.years[0] - r.years[1]) < 0.01 * r.years[0], `${label}: the same time`, r.years.map((v) => (v * 365.25).toFixed(3)).join(' / ') + ' days');
  console.log(`      ${label}: CPU ${r.cpuMs.toFixed(2)} ms/step, GPU (SwiftShader, on the CPU here) ${r.gpuMs.toFixed(2)} ms/step; mud laid ${r.mudLaid.map((v) => v.toFixed(2)).join(' / ')} m³; bed differs by up to ${r.bedDiff.toFixed(3)} m; dt ${r.dt.map((v) => v.toFixed(3)).join(' / ')}`);
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
