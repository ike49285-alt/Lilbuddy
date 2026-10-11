// The water on the GPU against the water on the CPU, from the same world:
// they should agree closely. Run with the repository served:
//   python3 -m http.server 8114  (in the repository)
//   node tests/gpu.test.mjs http://localhost:8114
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:8114';
const fails = [];
const check = (ok, l, e = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${e ? '  — ' + e : ''}`); if (!ok) fails.push(l); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error:', e.message));
for (const [label, query] of [['young water', 'seed=gpu-1&warm=600&steps=200'], ['with the bed moving fast', 'seed=gpu-2&warm=3000&steps=400&morph=2000']]) {
  await page.goto(`${BASE}/tests/gpu-check.html?${query}`);
  await page.waitForFunction(() => window.result, null, { timeout: 600000 });
  const r = await page.evaluate(() => window.result);
  if (r.error) { check(false, `${label}: runs`, r.error.split('\n')[0]); console.log(r.error); continue; }
  check(r.available, `${label}: the browser can compute on the GPU`);
  check(r.close > 0.99, `${label}: depths agree within a centimetre`, `${(r.close * 100).toFixed(2)}% of ${r.wet} wet cells, worst ${r.worst.toFixed(3)} m`);
  check(Math.abs(r.water[0] - r.water[1]) < 1e-3 * r.water[0], `${label}: the same water`, `${r.water[0].toFixed(1)} vs ${r.water[1].toFixed(1)} m³`);
  check(Math.abs(r.mud[0] - r.mud[1]) < 0.01 * r.mud[0] + 1e-3, `${label}: the same mud`, `${r.mud[0].toFixed(3)} vs ${r.mud[1].toFixed(3)} m³`);
  console.log(`      ${label}: CPU ${r.cpuMs.toFixed(2)} ms/step, GPU (SwiftShader, on the CPU here) ${r.gpuMs.toFixed(2)} ms/step; bed differs by up to ${r.bedDiff.toFixed(3)} m; dt ${r.dt.map((v) => v.toFixed(3)).join(' / ')}`);
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
