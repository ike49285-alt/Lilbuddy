// The stream table: water and sand are conserved, a restored world carries
// on exactly, the tools and sliders do what they say, frames are sound.
import { Simulation, transferList } from '../src/sim.js';
import { SEC_PER_YR } from '../src/flow.js';
import { LAVA_PER_DAY, ASH_SHARE } from '../src/volcano.js';
const fails = [];
const check = (ok, l, e = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${e ? '  — ' + e : ''}`); if (!ok) fails.push(l); };
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };
// Most checks are of the water and the sand, on the plain without its hills
// (the hills have their own checks below).
const flatWorld = (seed) => new Simulation(seed, { hills: 0 });

// Water: with the bed held still, what comes in leaves at the sea.
{
  const s = flatWorld('water-1');
  s.flow.sediment = false;
  s.weather.update = () => {}; s.weather.intensity = 0; s.weather.upstream = 0;
  for (let k = 0; k < 9000; k++) s.step(1);
  const f = s.flow, W = s.W;
  const row = (y) => { let q = 0; for (let x = 0; x < W; x++) q += f.qy[y * W + x]; return q * f.dx; };
  const qin = f.inflow, q1 = row(60), q2 = row(180);
  check(Math.abs(q1 - qin) < 0.05 * qin && Math.abs(q2 - qin) < 0.08 * qin, 'the water that comes in flows down to the sea', `in ${qin.toFixed(2)}, at 240 m ${q1.toFixed(2)}, at 720 m ${q2.toFixed(2)} m³/s`);
  let nan = 0; for (const v of f.h) if (!Number.isFinite(v) || v < 0) nan++;
  check(nan === 0, 'depths are finite and never negative');
  let maxV = 0; for (let i = 0; i < s.N; i++) if (f.h[i] > 0.05) maxV = Math.max(maxV, Math.hypot(f.ux[i], f.uy[i]));
  check(maxV < 4, 'currents stay river-like', `fastest ${maxV.toFixed(2)} m/s`);
}

// Sand: what the bed gains is what came in less what went out.
{
  const s = new Simulation('sand-1');
  const f = s.flow;
  const loose = () => { let t = 0; for (let i = 0; i < f.N; i++) t += f.z[i] - f.rock[i]; return t; };
  const z0 = loose(), fed0 = f.fedIn, out0 = f.toSea, mud0 = f.mudLaid, worn0 = f.rockWorn;
  for (let k = 0; k < 8000; k++) s.step(500);
  // The loose ground's growth, less the mud laid down in it and the rock worn into it.
  const dv = (loose() - z0) * f.dx * f.dx * (1 - 0.4) - (f.mudLaid - mud0) - (f.rockWorn - worn0);
  const net = (f.fedIn - fed0) - (f.toSea - out0);
  check(Math.abs(dv - net) < 0.02 * Math.max(10, Math.abs(net)) + 1, 'sand is neither made nor lost', `bed gained ${dv.toFixed(1)} m³ of sand; in less out ${net.toFixed(1)} m³`);
  check(s.years > 0 && f.morph >= 1, 'the bed runs faster than the water when asked', `${(s.years * 365.25).toFixed(1)} days in 8000 steps, bed ×${f.morph.toFixed(0)}`);
  let below = 0; for (let i = 0; i < s.N; i++) if (f.z[i] < f.rock[i] - 1e-4) below++;
  check(below === 0, 'nothing digs below the bedrock');
}

// Restore.
{
  const a = new Simulation('restore-1');
  for (let k = 0; k < 3000; k++) a.step(800);
  a.volcano(128 * 80 + 30);
  a.setSection([[10, 90], [118, 90]]);
  for (let k = 0; k < 500; k++) a.step(800);
  const b = Simulation.fromState(structuredClone(a.saveState()));
  for (let k = 0; k < 3000; k++) { a.step(800); b.step(800); }
  check(a.stateHash() === b.stateHash() && a.years === b.years, 'a restored world carries on exactly the same');
  const old = Simulation.fromState({ seed: 'valley', version: 1, years: 5e6 });
  check(old.years === 0 && old.flow.z.length === old.N, 'a save from the valley version starts a fresh table');
}

// Tools.
{
  const s = flatWorld('tools-1');
  const f = s.flow, W = s.W;
  for (let k = 0; k < 2000; k++) s.step(200);
  const i = 120 * W + 20;           // on the floodplain, left of the river
  const z0 = f.z[i];
  s.sculpt(i, 'big', 1);
  check(f.z[i] > z0 + 0.1, 'Raise piles up sand', `+${(f.z[i] - z0).toFixed(2)} m`);
  const zb = f.z[i];
  s.sculpt(i, 'huge', 1, 'bulldozer');
  const big = f.z[i] - zb;
  const zg = f.z[i];
  s.sculpt(i, 'small', 1, 'gentle');
  const small = f.z[i] - zg;
  check(Math.abs(big - 1) < 0.01 && Math.abs(small - 0.05) < 0.005, 'brush strength sets how much one nudge moves', `Bulldozer ${big.toFixed(2)} m, Gentle ${small.toFixed(3)} m at the centre`);
  for (let k = 0; k < 400; k++) s.sculpt(i, 'big', -1);
  check(Math.abs(f.z[i] - f.rock[i]) < 1e-4, 'Lower scoops down to the rock and no further');
  const line = [[30, 40], [30, 160]];
  const before = f.z[100 * W + 30];
  const n = s.dig(line);
  check(n > 100 && f.z[100 * W + 30] < before - 0.5, 'Dig cuts a channel', `${n} cells, ${(before - f.z[100 * W + 30]).toFixed(2)} m deep here`);
  let falls = true; for (let y = 41; y < 160; y++) if (f.z[y * W + 30] > f.z[(y - 1) * W + 30] + 1e-4) falls = false;
  check(falls, 'and its bed falls all the way along');
  const j = 150 * W + 64;
  s.block(j);
  for (let k = 0; k < 3000; k++) s.step(2000);
  check(f.rock[j] >= f.z[j] - 1e-4 && s.inspect(j).block, 'Block drops rock the river can’t wear away');
  s.setSection([[5, 100], [120, 100]]);
  const fr = s.frame(0.001);
  check(fr.section && fr.section.bed.length === 96 && Math.abs(fr.section.length - 115 * 4) < 1, 'Section gives a cross-section along the line', `${fr.section.length.toFixed(0)} m`);
  check(['dig', 'block'].every((k) => fr.events.some((e) => e.kind === k)) && fr.events.every((e) => !('label' in e)), 'each tool sends an event for the map, and nothing sends a note');
}

// Mud: it rides in the water and settles where the water slows; none is
// made or lost, in the water or the ground.
{
  const s = new Simulation('mud-1');
  const f = s.flow, N = f.N, dA = f.dx * f.dx;
  const bedMud = () => { let t = 0; for (let i = 0; i < N; i++) { const S = Math.max(0, f.z[i] - f.rock[i]); t += (f.fm[i] * Math.min(0.3, S) + f.sm[i] * Math.max(0, S - 0.3)) * 0.6 * dA; } return t; };
  const b0 = bedMud();
  for (let k = 0; k < 4000; k++) s.step(2000);
  let inWater = 0, neg = 0, outOfRange = 0;
  for (let i = 0; i < N; i++) { inWater += f.M[i] * dA; if (f.M[i] < 0) neg++; if (!(f.fm[i] >= 0 && f.fm[i] <= 1) || !(f.sm[i] >= 0 && f.sm[i] <= 1)) outOfRange++; }
  const gap = f.mudFed - f.mudOut - f.mudDown - inWater;
  check(f.mudFed > 0 && Math.abs(gap) < 1e-6 * f.mudFed, 'the water’s mud is neither made nor lost', `in ${f.mudFed.toFixed(2)} m³, in the water ${inWater.toFixed(2)}, settled ${f.mudDown.toFixed(2)}, to sea ${f.mudOut.toFixed(3)}`);
  const b1 = bedMud();
  check(Math.abs(b1 - b0 - f.mudLaid) < 1e-3 * Math.abs(f.mudLaid) + 0.1, 'and the ground holds all the mud laid down in it', `${(b1 - b0).toFixed(1)} m³ more mud in the ground, ${f.mudLaid.toFixed(1)} m³ laid`);
  check(neg === 0 && outOfRange === 0, 'mud in the water is never negative and the ground’s share stays between 0 and 1');
  const fr = s.frame(0.001);
  check(fr.mud.some((v) => v > 0) && fr.soil.length === N && s.inspect(100 * s.W + 64).mudGround >= 0, 'frames carry the mud in the water and in the ground');
  const r = Simulation.fromState(structuredClone(s.saveState()));
  check(r.stateHash() === s.stateHash(), 'a restored world keeps its mud');
}
// Gravel: none made or lost, the shares stay sensible, and where the flow
// strips the sand away the channel's bed is left coarser (it armours).
{
  const s = new Simulation('gravel-1');
  const f = s.flow, N = f.N, dA = f.dx * f.dx;
  const inGround = () => { let t = 0; for (let i = 0; i < N; i++) { const S = Math.max(0, f.z[i] - f.rock[i]); t += (f.fg[i] * Math.min(0.3, S) + f.sg[i] * Math.max(0, S - 0.3)) * 0.6 * dA; } return t; };
  const g0 = inGround(), in0 = f.gravelIn, out0 = f.gravelOut, w0 = f.rockWorn;
  for (let k = 0; k < 4000; k++) s.step(2000);
  const net = (f.gravelIn - in0) - (f.gravelOut - out0) + (f.rockWorn - w0), got = inGround() - g0;
  check(f.gravelIn > in0 && Math.abs(got - net) < 0.05 * Math.abs(net) + 0.05, 'gravel is neither made nor lost', `${got.toFixed(2)} m³ more in the ground, ${net.toFixed(2)} m³ in less out`);
  let bad = 0;
  for (let i = 0; i < N; i++) if (!(f.fg[i] >= 0 && f.fg[i] + f.fm[i] <= 1 + 1e-9 && f.sg[i] >= 0 && f.sg[i] <= 1)) bad++;
  check(bad === 0, 'the ground’s shares of gravel, sand and mud stay between 0 and 1');
  const r = Simulation.fromState(structuredClone(s.saveState()));
  check(r.stateHash() === s.stateHash(), 'a restored world keeps its gravel');
}

// Over half a year, floods leave the most mud beside the channel: levees.
// And the channel's bed is coarser than the plain's.
{
  const s = flatWorld('prof-1');
  const f = s.flow, W = s.W;
  while (s.years < 0.5) s.step(20000);
  const m = s.measure();
  const avg = { channel: [0, 0], beside: [0, 0], far: [0, 0] };
  for (let y = 10; y < s.shoreY - 4; y++) {
    const line = m.line[y];
    if (line < 0) continue;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, dist = Math.abs(x - line);
      const k = f.h[i] > 0.1 && dist < 6 ? 'channel' : f.h[i] <= 0.02 && dist >= 4 && dist < 12 ? 'beside' : f.h[i] <= 0.02 && dist >= 25 && dist < 40 ? 'far' : null;
      if (k) { avg[k][0] += f.fm[i]; avg[k][1]++; }
    }
  }
  const pc = (k) => (100 * avg[k][0]) / avg[k][1];
  check(pc('beside') > pc('far') + 3 && pc('beside') > pc('channel') + 3, 'floods leave mud beside the channel, more than far off or in it', `mud on top: beside ${pc('beside').toFixed(0)}%, far ${pc('far').toFixed(0)}%, channel ${pc('channel').toFixed(0)}%`);
  let gch = 0, nch = 0, gfar = 0, nfar = 0;
  for (let y = 10; y < s.shoreY - 4; y++) {
    const line = m.line[y];
    if (line < 0) continue;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, dist = Math.abs(x - line);
      if (f.h[i] > 0.1 && dist < 6) { gch += f.fg[i]; nch++; } else if (f.h[i] <= 0.02 && dist >= 25 && dist < 40) { gfar += f.fg[i]; nfar++; }
    }
  }
  check(gch / nch > gfar / nfar + 0.03, 'the channel’s bed armours: more gravel on top than the plain’s', `gravel on top: channel ${(100 * gch / nch).toFixed(0)}%, plain ${(100 * gfar / nfar).toFixed(0)}%`);
}

// Things to protect: a house on the channel's bank is undercut, one far off
// stays fine, and they come back through a save.
{
  const s = flatWorld('prof-1');
  const W = s.W;
  while (s.years < 0.3) s.step(20000);
  const m = s.measure();
  // Houses right on the channel's bank down the valley, and others far off on the plain.
  const near = [], far = [];
  for (const y of [50, 70, 90, 110, 130]) { near.push(s.place('house', y * W + m.line[y] + 3)); far.push(s.place('house', y * W + 10)); }
  const field = s.place('field', 120 * W + 20);
  const bx = m.line[140] >= 0 ? m.line[140] : W >> 1;
  const bridge = s.place('bridge', 0, [[bx - 12, 140], [bx + 12, 140]]);
  check(near.every(Boolean) && far.every(Boolean) && field && bridge && field.cells.length === 64 && bridge.piers.length >= 5 && bridge.piers.every((j) => s.flow.rock[j] >= s.flow.z[j] - 1e-6), 'houses, fields and bridges go down, a bridge with piers of rock');
  while (s.years < 0.8) s.step(20000);
  const fr = s.frame(0);
  const st = (t) => fr.things.find((o) => o.id === t.id).state;
  const harmed = near.filter((t) => ['undercut', 'lost'].includes(st(t))).length;
  check(harmed >= 1 && far.every((t) => st(t) === 'fine'), 'the river undercuts houses on its banks and leaves those far off', `on the banks ${near.map(st).join(', ')}; far off ${far.map(st).join(', ')}`);
  const r = Simulation.fromState(structuredClone(s.saveState()));
  check(r.things.length === 12 && r.stateHash() === s.stateHash() && r.frame(0).things.map((t) => t.state).join() === fr.things.map((t) => t.state).join(), 'and they come back through a save');
}

// The bedrock slider: all the rock moves but what's put down by hand, and
// it never stands above the ground.
{
  const s = new Simulation('rock-1');
  const f = s.flow, W = s.W;
  const plain = 100 * W + 64, blockAt = 60 * W + 30;
  s.block(blockAt);
  const blockRock = f.rock[blockAt];
  for (let k = 0; k < 500; k++) s.step(500);
  s.set('rock', 50);
  check(Math.abs(f.z0[plain] - f.rock[plain] - 50) < 0.01 && f.rock[blockAt] === blockRock, 'Bedrock sets how deep the rock lies, and leaves placed rock alone', `${(f.z0[plain] - f.rock[plain]).toFixed(1)} m under the plain's start`);
  s.set('rock', 1);
  let above = 0;
  for (let i = 0; i < f.N; i++) if (f.rock[i] > f.z[i] + 1e-6) above++;
  check(above === 0 && f.rock[blockAt] === blockRock, 'and the rock never stands above the ground');
  s.set('rock', 50);
  const r = Simulation.fromState(structuredClone(s.saveState()));
  check(r.settings.rock === 50 && r.rockDepth === 50 && r.flow.rock[plain] === f.rock[plain] && r.flow.placed[blockAt] === 1, 'and comes back through a save');
}

// Land height: the land rises above the sea, the sea floor stays, and
// what the things to protect remember rises with it.
{
  const s = new Simulation('lift-1');
  const f = s.flow, W = s.W;
  const land = 100 * W + 64, sea = (s.H - 10) * W + 64;
  const z0 = f.z[land], r0 = f.rock[land], s0 = f.z[sea];
  const house = s.place('house', 60 * W + 10);
  s.set('lift', 20);
  check(Math.abs(f.z[land] - z0 - 20) < 1e-3 && Math.abs(f.rock[land] - r0 - 20) < 1e-3 && f.z[sea] === s0, 'Land height raises the land and its rock, not the sea floor', `+${(f.z[land] - z0).toFixed(1)} m`);
  check(s.frame(0).things[0].state === 'fine' && Math.abs(house.base[0] - f.z[house.watch[0]]) < 1e-3, 'and the houses go up with it');
  for (let k = 0; k < 2000; k++) s.step(2000);
  let bad = 0; for (let i = 0; i < f.N; i++) if (!Number.isFinite(f.z[i]) || !Number.isFinite(f.h[i]) || f.h[i] < 0) bad++;
  check(bad === 0, 'and the river runs on over the step to the sea');
  const r = Simulation.fromState(structuredClone(s.saveState()));
  check(r.lift === 20 && r.settings.lift === 20 && r.stateHash() === s.stateHash(), 'and it comes back through a save');
}

// Rock that wears: with the bedrock just under the plain, bare rock under
// the flow wears away into gravel; rock put down by hand doesn't.
{
  const s = new Simulation('wear-1');
  const f = s.flow, W = s.W;
  s.set('rock', 1);
  const blockAt = 30 * W + 64;
  s.block(blockAt);
  // Bare the rock under the pump's jet with the Lower brush.
  for (let k = 0; k < 40; k++) for (const y of [4, 8, 12]) s.sculpt(y * W + 64, 'big', -1, 'bulldozer');
  const rock0 = Float32Array.from(f.rock), blockRock = f.rock[blockAt];
  for (let k = 0; k < 6000; k++) s.step(2000);
  let lowered = 0, deepest = 0;
  for (let i = 0; i < f.N; i++) if (!f.placed[i] && f.rock[i] < rock0[i] - 1e-4) { lowered++; deepest = Math.max(deepest, rock0[i] - f.rock[i]); }
  check(f.rockWorn > 0 && lowered > 0 && f.rock[blockAt] === blockRock, 'bare rock under the flow wears into gravel; placed rock doesn’t', `${f.rockWorn.toFixed(1)} m³ worn from ${lowered} cells, up to ${(deepest * 1000).toFixed(1)} mm`);
  let below = 0;
  for (let i = 0; i < f.N; i++) if (f.z[i] < f.rock[i] - 1e-6) below++;
  check(below === 0, 'and the ground never sinks below the rock');
}

// Landslides: a tall, steep pile beside the river gives way, and what falls
// lands in the river; nothing is made or lost (the balances above cover it).
{
  const s = flatWorld('slide-1');
  const f = s.flow, W = s.W;
  for (let k = 0; k < 2000; k++) s.step(2000);
  const line = s.measure().line[100];
  const at = 100 * W + line + 4;
  for (let k = 0; k < 60; k++) s.sculpt(at, 'small', 1, 'bulldozer');
  const loose = () => { let t = 0; for (let i = 0; i < f.N; i++) t += f.z[i] - f.rock[i]; return t; };
  const n0 = f.slides;
  let k = 0;
  while (f.slides === n0 && k < 20000) { s.step(2000); k++; }
  const fr = s.frame(0);
  check(f.slides > n0 && fr.events.some((e) => e.kind === 'slide') && fr.stats.slides === f.slides, 'a tall, steep pile beside the river gives way in a landslide', `after ${k} steps`);
}

// Trees: they come up over years on dry, grassed ground, not on wet; and
// wooded banks wear back more slowly than grassed ones.
{
  const s = flatWorld('trees-1');
  const f = s.flow, W = s.W;
  const dry = 60 * W + 30, wet = s.H * W - W * 20 + 64;
  f.cover[dry] = 1; f.trees[dry] = 0; f.cover[wet] = 1; f.trees[wet] = 0;
  f.growth = 1;
  for (let k = 1; k <= 60; k++) { f.steps = 16 * k; f.plants(0.1, 0); }   // six years
  check(f.trees[dry] > 0.5 && f.trees[wet] === 0, 'trees grow up over years on dry grassed ground, not in the water', `${(f.trees[dry] * 100).toFixed(0)}% after six years`);
  // The same river, its dry ground all grass or all woods.
  const base = flatWorld('banks-1');
  while (base.years < 0.3) base.step(20000);
  const worn = (wooded) => {
    const t = Simulation.fromState(structuredClone(base.saveState()));
    const g = t.flow;
    const was = Float32Array.from(g.z), dryAt = g.h.map((d) => (d <= 0.02 ? 1 : 0));
    for (let i = 0; i < g.N; i++) if (dryAt[i]) { g.cover[i] = 1; g.trees[i] = wooded ? 1 : 0; }
    while (t.years < 0.45) t.step(20000);
    let v = 0; for (let i = 0; i < g.N; i++) if (dryAt[i] && g.z[i] < was[i]) v += was[i] - g.z[i];
    return v * 16;
  };
  const grass = worn(false), woods = worn(true);
  check(woods < 0.8 * grass, 'wooded banks wear back more slowly than grassed ones', `${grass.toFixed(0)} m³ off grassed banks, ${woods.toFixed(0)} m³ off wooded`);
}

// The pump moves along the top edge, and the river comes in where it is.
{
  const s = new Simulation('pump-1');
  const f = s.flow, W = s.W;
  for (let k = 0; k < 500; k++) s.step(1);
  s.movePump(30);
  // Water flowing down out of the top rows, either side of x.
  const flowAt = (x) => { let q = 0; for (let xx = x - 12; xx <= x + 12; xx++) q += f.qy[3 * W + xx]; return q * f.dx; };
  for (let k = 0; k < 4000; k++) s.step(1);
  const fr = s.frame(0.001);
  check(f.inletX === 30 && fr.inlet[0] === 30 && flowAt(30) > 0.6 * f.inflow && Math.abs(flowAt(64)) < 0.1 * f.inflow, 'Pump moves the river’s inlet', `${flowAt(30).toFixed(1)} m³/s down from the new inlet, ${flowAt(64).toFixed(1)} from the old`);
  check(fr.events.some((e) => e.kind === 'pump'), 'and flashes where it went');
  const r = Simulation.fromState(structuredClone(s.saveState()));
  check(r.flow.inletX === 30, 'and stays put through a save');
  s.movePump(-50);
  check(f.inletX === f.inletHalf + 1, 'and stays on the table', `x ${f.inletX}`);
}

// Settings.
{
  const s = new Simulation('settings-1');
  const f = s.flow, W = s.W;
  const top = f.z[10 * W + 5], bottom = f.z[200 * W + 5];
  s.set('tilt', 0.004);
  const dTop = f.z[10 * W + 5] - top, dBot = f.z[200 * W + 5] - bottom;
  check(Math.abs((dTop - dBot) - 0.002 * 190 * 4) < 1e-3, 'Tilt tips the whole table', `the top rose ${(dTop - dBot).toFixed(2)} m against the bottom`);
  s.set('sea', 1);
  for (let k = 0; k < 400; k++) s.step(1);
  check(Math.abs(f.h[(s.H - 1) * W + 64] + f.z[(s.H - 1) * W + 64] - 1) < 1e-3, 'Sea level sets the sea');
  s.set('flow', 40);
  s.step(1);
  check(f.inflow > 25, 'Pump sets the flow', `${f.inflow.toFixed(1)} m³/s in`);
  s.set('flow', 1e9);
  check(s.settings.flow === 80, 'settings stay in their range');
}

// Hills: rolling ground from noise, hills and hollows, the hollows full of
// lakes, some hills with rock just under them; the sliders raise, flatten,
// broaden or shrink it as it runs, and the rock with it, but not rock put
// down by hand.
{
  const s = new Simulation('hills-1');
  const f = s.flow, W = s.W, fld = s.table.hills.field(s.hillSize);
  let up = 0, down = 0, cores = 0, lakes = 0;
  for (let i = 0; i < s.N; i++) {
    const g = s.hills * fld.F[i];
    if (g > 1) up++;
    if (g < -1) down++;
    if (fld.core[i] === 1) cores++;
    if (f.lake[i] && f.h[i] > 0.5) lakes++;
  }
  check(s.settings.hills === 2.5 && s.settings.hillSize === 120 && up > 300 && down > 300 && cores > 50, 'a new world has rolling ground, hills and hollows, some hills rocky', `${up} cells a metre up, ${down} a metre down, ${cores} over rock`);
  check(lakes > 300, 'its hollows hold lakes, full to where they spill', `${lakes} cells over half a metre deep`);
  let rockyOk = true;
  for (let i = 0; i < s.N; i++) if (fld.core[i] === 1 && Math.abs(f.z[i] - f.rock[i] - 1.5) > 1e-3) rockyOk = false;
  check(rockyOk, 'the rocky ones with bedrock a metre and a half down');
  const z0 = Float32Array.from(f.z);
  const j = 200 * W + 64;
  s.block(j);
  const blockZ = f.z[j];
  s.set('hills', 0);
  let flat = 0, above = 0;
  for (let i = 0; i < s.N; i++) {
    if (f.rock[i] > f.z[i] + 1e-6) above++;
    if (i !== j && !f.placed[i]) flat = Math.max(flat, Math.abs(z0[i] - 2.5 * fld.F[i] - f.z[i]));
  }
  check(flat < 1e-3 && f.z[j] === blockZ && above === 0, 'Hills at 0 leaves the flat plain, rock put down by hand where it was, and no rock above the ground', `${flat.toExponential(1)} m off`);
  s.set('hills', 4);
  const z1 = Float32Array.from(f.z);
  s.set('hillSize', 200);
  const big = s.table.hills.field(200);
  let moved = 0;
  for (let i = 0; i < s.N; i++) if (!f.placed[i]) moved = Math.max(moved, Math.abs(f.z[i] - z1[i] - 4 * (big.F[i] - fld.F[i])));
  check(moved < 1e-3 && s.hillSize === 200, 'Hill size reshapes them as it runs, broader or finer', `${moved.toExponential(1)} m off`);
  const r = Simulation.fromState(structuredClone(s.saveState()));
  check(r.settings.hills === 4 && r.hills === 4 && r.hillSize === 200 && r.flow.z.every((v, i) => v === f.z[i]) && r.flow.lake.every((v, i) => v === f.lake[i]), 'and they come back through a save');
  const old = structuredClone(s.saveState());
  delete old.hillKind;
  const o = Simulation.fromState(old);
  check(o.settings.hills === 0 && o.hills === 0 && o.flow.z.every((v, i) => v === f.z[i]), 'a world saved before them keeps its ground, with Hills at 0');
  // The river winds round them and through the lakes, to the sea.
  const a = new Simulation('hills-1'), b = flatWorld('hills-1');
  while (a.years < 0.15) { a.step(20000); b.step(20000); }
  const ma = a.measure(), mb = b.measure();
  check(ma.sinuosity > mb.sinuosity + 0.15, 'the river winds round the hills', `sinuosity ${ma.sinuosity.toFixed(2)}, ${mb.sinuosity.toFixed(2)} on the flat plain`);
  // (At this speed-up the water's own clock runs 20,000 times slower than
  // the bed's: it takes a while to thread its way down.)
  while (a.years < 0.45) a.step(20000);
  let shore = 0;
  for (let x = 0; x < W; x++) if (a.flow.h[(a.shoreY - 2) * W + x] > 0.05) shore++;
  check(shore > 0, 'and gets to the sea', `${shore} cells wet at the shore`);
}

// Dams: a reservoir backs up behind one (full to its spillway from the
// start), the pump's sand builds a delta into it, its deep water lies still,
// and the river below runs short of sand and cuts down. Taken away, the
// ground under it comes back and the reservoir's sand flushes out.
{
  const run = (s, y) => { while (s.years < y) s.step(20000); };
  const make = (dam) => { const s = flatWorld('dam-1'); run(s, 0.15); if (dam) s.place('dam', 0, [[0.5, 110.5], [127.5, 110.5]], 'medium'); return s; };
  const a = make(true), b = make(false);
  const f = a.flow, W = a.W;
  const d = a.things.find((t) => t.kind === 'dam');
  const mid = d.cells[64];
  check(d && d.watch.length > 1000 && d.room > 1e5 && d.cells.every((j) => f.placed[j] && f.rock[j] >= f.z[j] - 1e-6), 'a dam goes down as rock across the valley, with a reservoir behind it', `${d.watch.length} cells, room for ${d.room.toFixed(0)} m³`);
  let lake = 0;
  for (const j of d.watch) if (f.h[j] > 0.5) lake++;
  check(lake > 0.9 * d.watch.length, 'the reservoir starts full of water');
  const fed0 = f.fedIn;
  run(a, 0.6); run(b, 0.6);
  a.checkThings();
  let fast = 0, n = 0;
  for (const j of d.watch) if (f.h[j] > 1) { fast += Math.hypot(f.ux[j], f.uy[j]); n++; }
  check(fast / n < 0.1, 'its deep water lies still', `${(fast / n).toFixed(3)} m/s on average`);
  check(f.fedIn - fed0 > 100 && d.held > 0.5 * (f.fedIn - fed0) && d.fullness > 0, 'the pump keeps feeding sand, and the reservoir holds it', `${(f.fedIn - fed0).toFixed(0)} m³ fed, ${d.held.toFixed(0)} m³ held, ${(d.fullness * 100).toFixed(1)}% full`);
  let headA = 0, headB = 0;
  for (let y = 0; y < 15; y++) for (let x = 0; x < W; x++) { headA += f.z[y * W + x]; headB += b.flow.z[y * W + x]; }
  check(headA - headB > 50, 'a delta builds at its head', `${((headA - headB) * 16).toFixed(0)} m³ higher there than without the dam`);
  const fr = a.frame(0.001);
  check(fr.things.some((t) => t.kind === 'dam' && t.line && t.fullness >= 0) && fr.stats.dams === 1, 'frames carry the dam and how full it is');
  // Its state comes back through a save, and the water it calms with it.
  const r = Simulation.fromState(structuredClone(a.saveState()));
  check(r.things.some((t) => t.kind === 'dam' && t.watch.length === d.watch.length) && r.flow.still.reduce((x, v) => x + v, 0) === d.watch.length, 'and comes back through a save');
  // Taken away: the ground under it as it was.
  const under = d.under;
  a.remove(mid);
  check(!a.things.some((t) => t.kind === 'dam') && under.cells.every((j, k) => f.z[j] === under.z[k] && !f.placed[j]) && f.still.every((v) => v === 0), 'Remove takes it away, and the ground under it comes back');
  const held = () => d.watch.reduce((x, j, k) => x + f.z[j] - d.base[k], 0) * 16;
  const h0 = held();
  run(a, 0.9);
  check(held() < h0, 'and the reservoir’s sand flushes out', `${h0.toFixed(0)} → ${held().toFixed(0)} m³`);
}

// Remove: rock and bridges go, the ground under them comes back; a field
// stops being kept.
{
  const s = new Simulation('remove-1');
  for (let k = 0; k < 100; k++) s.step(100);
  const f = s.flow, W = s.W;
  const j = 60 * W + 30, z0 = f.z[j], r0 = f.rock[j];
  s.block(j);
  s.remove(j);
  check(f.z[j] === z0 && f.rock[j] === r0 && !f.placed[j], 'Remove takes away a block of rock');
  const field = s.place('field', 40 * W + 20);
  s.remove(40 * W + 20);
  check(!s.things.includes(field) && field.cells.every((c) => !f.noTrees[c]), 'and a field');
  const bridge = s.place('bridge', 0, [[50, 120], [80, 120]]);
  const piers = bridge.piers.slice();
  s.remove(piers[0]);
  check(!s.things.includes(bridge) && piers.every((c) => !f.placed[c]), 'and a bridge’s piers');
  check(s.remove(5) === null, 'and nothing where nothing was put');
}

// Gauges: they read the flow and the sand passing them, sample as time
// goes, and come back through a save.
{
  const s = flatWorld('gauge-1');
  while (s.years < 0.1) s.step(20000);
  const f = s.flow, W = s.W, y = 60;
  let at = y * W;
  for (let x = 0; x < W; x++) if (f.h[y * W + x] > f.h[at]) at = y * W + x;
  const g = s.place('gauge', at);
  const dry = s.place('gauge', 60 * W + 1);
  while (s.years < 0.2) s.step(20000);
  const r = s.gaugeAt(at);
  check(g.n === 1 && dry.n === 2 && g.series.level.length > 20, 'gauges go down numbered and sample as time goes', `${g.series.level.length} samples`);
  // (The flow through the row's faces: the pump's own flow takes a while
  // to get there, on the water's clock.)
  let through = 0;
  for (let x = 0; x < W; x++) through += ((f.qy[y * W + x] + f.qy[(y + 1) * W + x]) / 2) * f.dx;
  check(Math.abs(r.flow - through) < 0.1 * Math.abs(through) && through > 0.3 * f.inflow, 'a gauge on the river reads the flow coming down it', `${r.flow.toFixed(1)} m³/s, ${through.toFixed(1)} through the row, ${f.inflow.toFixed(1)} pumped in`);
  check(Number.isFinite(r.level) && r.level > r.bed && g.series.sand.some((v) => v > 0), 'and its water level, bed and sand');
  check(!Number.isFinite(s.gaugeAt(60 * W + 1).level) || s.gaugeAt(60 * W + 1).flow < 0.2 * f.inflow, 'one on the bank reads little or nothing');
  for (let k = 0; k < 4; k++) s.place('gauge', 30 * W + 10 * k);
  check(s.things.filter((t) => t.kind === 'gauge').length === 4, 'no more than four');
  const back = Simulation.fromState(structuredClone(s.saveState()));
  const bg = back.things.filter((t) => t.kind === 'gauge');
  check(bg.length === 4 && bg.every((t) => t.series && Array.isArray(t.series.level)), 'and they come back through a save');
  const fr = s.frame(0.001);
  check(fr.things.filter((t) => t.kind === 'gauge').every((t) => t.series.flow.length === t.series.level.length), 'frames carry their readings');
}

// Volcano: it erupts within days; its lava sets into rock to the top, a
// cone round the vent, as much as came out (and its ash, which thins away
// from the vent); it goes quiet for months; lava run into the river dams it
// or shoves it aside; taken away it goes extinct; it comes back through a
// save.
{
  const s = flatWorld('volcano-1');
  const f = s.flow, W = s.W;
  for (let k = 0; k < 3000; k++) s.step(2000);
  const vent = 120 * W + 25, z0 = Float32Array.from(f.z);
  const v = s.volcano(vent);
  check(v && v.state === 'quiet' && s.events.some((e) => e.kind === 'place'), 'Volcano goes down, quiet at first');
  const t0 = s.years;
  let began = null, glow = 0, rock2 = 0;
  while (v.state === 'quiet' && s.years - t0 < 5 / 365.25) s.step(2000);
  began = s.events.find((e) => e.kind === 'erupt');
  check(began && began.first && v.n === 1, 'it erupts within days, its first eruption marked', `after ${((s.years - t0) * 365.25).toFixed(1)} days`);
  for (let k = 0; k < 400; k++) s.step(2000);
  const fr = s.frame(0.001);
  for (let i = 0; i < s.N; i++) { if (fr.lava[i]) glow++; if (fr.rock[i] === 2) rock2++; }
  check(glow > 0 && rock2 > 0, 'frames show the molten lava glowing and the lava rock', `${glow} glowing, ${rock2} of lava rock`);
  while (v.state === 'erupting') s.step(2000);
  for (let k = 0; k < 800; k++) s.step(2000);
  const days = (v.endAt - v.startAt) * 365.25;
  let lavaCells = 0, topped = 0, grew = 0;
  for (let i = 0; i < s.N; i++) {
    if (!f.basalt[i]) continue;
    lavaCells++;
    if (f.rock[i] >= f.z[i] - 0.02) topped++;
    grew += f.z[i] - z0[i];
  }
  const rise = f.z[vent] - z0[vent];
  check(rise > 3 && lavaCells > 50 && topped === lavaCells && v.molten.cells.length === 0, 'its lava sets into a cone of rock, rock to the top', `vent up ${rise.toFixed(1)} m, ${lavaCells} cells of lava rock`);
  let all = 0;
  for (let y = 120 - 45; y <= 120 + 45; y++) for (let x = 0; x <= 25 + 45; x++) all += f.z[y * W + x] - z0[y * W + x];
  const want = LAVA_PER_DAY * days * (1 + ASH_SHARE);
  check(Math.abs(all * 16 - want) < 0.05 * want, 'what came out of it is what lies round it, lava and ash', `${(all * 16).toFixed(0)} m³ round it; ${want.toFixed(0)} m³ out over ${days.toFixed(1)} days`);
  const ashAt = (d) => f.z[(120 - d) * W + 25] - z0[(120 - d) * W + 25];
  check(!f.basalt[(120 - 15) * W + 25] && ashAt(15) > ashAt(30) && ashAt(30) > 0, 'its ash thins away from the vent', `${(ashAt(15) * 100).toFixed(1)} cm 60 m off, ${(ashAt(30) * 100).toFixed(1)} cm 120 m off`);
  check(v.state === 'quiet' && s.volcanoDays(v) > 30, 'then it goes quiet for months', `next in ${s.volcanoDays(v).toFixed(0)} days`);
  // Through a save, then taken away.
  const b = Simulation.fromState(structuredClone(s.saveState()));
  const bv = b.things.find((t) => t.kind === 'volcano');
  check(bv && bv.n === 1 && b.flow.basalt.some((x) => x) && b.volcanoAt === s.volcanoAt, 'it comes back through a save, its lava rock too');
  const top = f.z[vent];
  s.remove(vent);
  for (let k = 0; k < 6000; k++) s.step(20000);
  check(!s.things.some((t) => t.kind === 'volcano') && !s.events.some((e) => e.kind === 'erupt' && e.years > t0 + 30 / 365.25) && f.z[vent] > top - 0.5, 'taken away it goes extinct, and its cone stays', `${(s.years - t0).toFixed(2)} years on, the vent ${(f.z[vent] - z0[vent]).toFixed(1)} m up`);
}
// Lava run into the river: it sets in the water, and the river goes round.
{
  const s = flatWorld('volcano-2');
  const f = s.flow, W = s.W;
  for (let k = 0; k < 3000; k++) s.step(2000);
  let x = 0;
  for (let k = 1; k < W; k++) if (f.h[100 * W + k] > f.h[100 * W + x]) x = k;
  const vent = 100 * W + x, h0 = f.h[vent];
  const v = s.volcano(vent);
  while (v.n === 0 || v.state === 'erupting') s.step(2000);
  for (let k = 0; k < 1500; k++) s.step(2000);
  let x2 = 0;
  for (let k = 1; k < W; k++) if (f.h[100 * W + k] > f.h[100 * W + x2]) x2 = k;
  check(h0 > 0.1 && f.h[vent] < 0.05 && f.basalt[vent] && Math.abs(x2 - x) > 3, 'lava run into the river dams it, and the river goes round', `${h0.toFixed(2)} m deep at the vent, then ${f.h[vent].toFixed(2)} m; the channel moves from ${x} to ${x2}`);
}

// Frames.
{
  const s = new Simulation('frame-1');
  for (let k = 0; k < 500; k++) s.step(100);
  for (const layer of ['depth', 'speed', 'drag', 'change', 'cutfill']) {
    s.layer = layer;
    const f = s.frame(0.0001);
    const set = new Set(f.layer);
    if (set.size < 3) check(false, `the ${layer} layer has something to show`);
  }
  s.layer = null;
  const f = s.frame(0.0001);
  const bufs = transferList(f);
  check(new Set(bufs).size === bufs.length, 'a frame’s buffers can all be transferred');
  check(!('cloud' in f), 'a frame carries no clouds');
  check(f.profile.bed.length === s.shoreY && f.profile.bed.every(Number.isFinite), 'the long profile runs from the inlet to the sea');
  const ins = s.inspect(s.flow.inletX | 0 + 40 * s.W);
  check(ins && typeof ins.depth === 'number', 'tapping a cell describes it');
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
