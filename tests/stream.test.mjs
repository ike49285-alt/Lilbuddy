// The stream table: water and sand are conserved, a restored world carries
// on exactly, the tools and sliders do what they say, frames are sound.
import { Simulation, transferList } from '../src/sim.js';
import { SEC_PER_YR } from '../src/flow.js';
const fails = [];
const check = (ok, l, e = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${e ? '  — ' + e : ''}`); if (!ok) fails.push(l); };
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };

// Water: with the bed held still, what comes in leaves at the sea.
{
  const s = new Simulation('water-1');
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
  const z0 = sum(f.z), fed0 = f.fedIn, out0 = f.toSea, mud0 = f.mudLaid;
  for (let k = 0; k < 8000; k++) s.step(500);
  // The ground's growth, less the mud laid down in it.
  const dv = (sum(f.z) - z0) * f.dx * f.dx * (1 - 0.4) - (f.mudLaid - mud0);
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
  a.storm(128 * 80 + 64);
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
  const s = new Simulation('tools-1');
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
  const q0 = f.inflow;
  s.storm(100 * W + 64);
  const t0 = s.years;
  while (s.years < t0 + 12 / 24 / 365.25) s.step(60);
  check(f.inflow > q0 * 1.5 && s.weather.intensity > 5, 'Storm rains and the river rises', `inflow ${q0.toFixed(1)} → ${f.inflow.toFixed(1)} m³/s, rain ×${s.weather.intensity.toFixed(1)}`);
  s.setSection([[5, 100], [120, 100]]);
  const fr = s.frame(0.001);
  check(fr.section && fr.section.bed.length === 96 && Math.abs(fr.section.length - 115 * 4) < 1, 'Section gives a cross-section along the line', `${fr.section.length.toFixed(0)} m`);
  check(['dig', 'block', 'storm'].every((k) => fr.events.some((e) => e.kind === k)) && fr.events.every((e) => !('label' in e)), 'each tool sends an event for the map, and nothing sends a note');
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
// Over half a year, floods leave the most mud beside the channel: levees.
{
  const s = new Simulation('prof-1');
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
}

// Things to protect: a house on the channel's bank is undercut, one far off
// stays fine, and they come back through a save.
{
  const s = new Simulation('prof-1');
  const W = s.W;
  while (s.years < 0.3) s.step(20000);
  const line = s.measure().line[100];
  const near = s.place('house', 100 * W + line + 3), far = s.place('house', 100 * W + 10);
  const field = s.place('field', 120 * W + 20);
  const bridge = s.place('bridge', 0, [[line - 12, 140], [line + 12, 140]]);
  check(near && far && field && bridge && field.cells.length === 64 && bridge.piers.length >= 5 && bridge.piers.every((j) => s.flow.rock[j] >= s.flow.z[j] - 1e-6), 'houses, fields and bridges go down, a bridge with piers of rock');
  while (s.years < 0.8) s.step(20000);
  const fr = s.frame(0);
  const st = (t) => fr.things.find((o) => o.id === t.id).state;
  check(['undercut', 'lost'].includes(st(near)) && st(far) === 'fine', 'the river undercuts a house on its bank and leaves one far off', `on the bank ${st(near)}, far off ${st(far)}`);
  const r = Simulation.fromState(structuredClone(s.saveState()));
  check(r.things.length === 4 && r.stateHash() === s.stateHash() && r.frame(0).things.map((t) => t.state).join() === fr.things.map((t) => t.state).join(), 'and they come back through a save');
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
