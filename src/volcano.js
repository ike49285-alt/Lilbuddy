// volcano.js — a volcano put down on the table: quiet for a few months,
// then erupting for days. Lava wells up at its vent and runs down whatever
// slope it finds, piling up where the ground is too gentle for it to move
// (so the cone grows), cooling over a day or so (in an hour where it runs
// into water) into rock the river can't scour, only slowly wear: it dams
// the river or shoves it aside. Ash falls around it as loose grit, thinning
// with distance, for the rain and the river to wash away.
//
// The lava is worked out on the CPU over a box round the vent, a few times
// a sim day, and what it does to the ground goes to the river as a change
// to the ground (applyDeposit here, or the GPU's deposit pass).

import { CELL_M } from './table.js';

export const LAVA_PER_DAY = 4000;   // m³ a day out of the vent while it erupts
export const ASH_SHARE = 0.5;       // ash, as a share of the lava's volume
export const ASH_MUD = 0.15, ASH_GRAVEL = 0.2;   // the ash's make-up (the rest sand-sized)
export const ASH_BURY = 0.05;       // metres of ash that smother most of the plants under it
const ASH_R = 20;                   // cells: the ash thins by e over this far
const YIELD = 0.1;                  // the slope lava stops on (on average: rougher ground holds it on steeper)
const COOL_DAYS = 1, QUENCH_DAYS = 1 / 24;   // how long it takes to set, on land and in water
export const BOX = 45;              // cells either side of the vent that the lava and ash reach
const QUIET_DAYS = [60, 120], ERUPT_DAYS = [3, 6], FIRST_DAYS = [1, 3];
const DAY_YR = 1 / 365.25;     // a day, in years
const HEAT_FULL = 3;                // metres of molten lava that glow their brightest

// How rough a cell's ground is to lava, 0.5 to 1.5: the same every time.
function rough(i) {
  let a = Math.imul(i ^ 0x27d4eb2d, 0x165667b1);
  a = Math.imul(a ^ (a >>> 15), 0x85ebca77);
  return 0.5 + ((a ^ (a >>> 13)) >>> 0) / 4294967296;
}

// A number in [0, 1) for a volcano's k-th draw, the same every time.
function draw(id, k) {
  let a = (id * 0x9e3779b1) ^ (k * 0x85ebca77) ^ 0x5bd1e995;
  a = Math.imul(a ^ (a >>> 16), 0x7feb352d);
  a = Math.imul(a ^ (a >>> 15), 0x846ca68b);
  return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
}
const between = (id, k, [lo, hi]) => lo + (hi - lo) * draw(id, k);

// A new volcano's state, put down at year t.
export function newVolcano(id, t) {
  return { state: 'quiet', n: 0, startAt: 0, endAt: 0, nextAt: t + between(id, 0, FIRST_DAYS) * DAY_YR, molten: { cells: [], depth: [] } };
}

// The volcano v over the years t0 to t1: its eruptions start and stop, its
// lava runs and sets, its ash falls. Returns what it did to the ground (a
// box and its changes, for applyDeposit) or null, and whether an eruption
// began (and whether it was the volcano's first).
export function volcanoTick(v, flow, t0, t1) {
  let began = null;
  if (v.state === 'quiet' && t1 >= v.nextAt) {
    v.state = 'erupting';
    v.n++;
    v.startAt = v.nextAt;
    v.endAt = v.startAt + between(v.id, 2 * v.n, ERUPT_DAYS) * DAY_YR;
    began = { first: v.n === 1 };
  }
  let lava = 0;
  if (v.state === 'erupting') {
    const days = (Math.min(t1, v.endAt) - Math.max(t0, v.startAt)) / DAY_YR;
    if (days > 0) lava = LAVA_PER_DAY * days;
    if (t1 >= v.endAt) {
      v.state = 'quiet';
      v.nextAt = v.endAt + between(v.id, 2 * v.n + 1, QUIET_DAYS) * DAY_YR;
    }
  }
  if (lava <= 0 && !v.molten.cells.length) return { change: null, began };
  return { change: flowLava(v, flow, lava, (t1 - t0) / DAY_YR), began };
}

// The lava over `days`, `lava` m³ of it coming out of the vent, in a box
// round it; and the ash with it. Returns the box and, per cell of it, the
// lava's change to the ground, the ash, and whether lava lies there.
function flowLava(v, flow, lava, days) {
  const { W, H, z, h } = flow;
  const vent = v.cells[0], vx = vent % W, vy = (vent / W) | 0;
  const x0 = Math.max(0, vx - BOX), x1 = Math.min(W - 1, vx + BOX), y0 = Math.max(0, vy - BOX), y1 = Math.min(H - 1, vy + BOX);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, n = bw * bh;
  const zb = new Float32Array(n), L = new Float32Array(n), out = new Float32Array(n);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) zb[y * bw + x] = z[(y0 + y) * W + x0 + x];
  const z0 = Float32Array.from(zb);
  // The lava still molten from last time.
  v.molten.cells.forEach((j, k) => { const x = (j % W) - x0, y = ((j / W) | 0) - y0; if (x >= 0 && y >= 0 && x < bw && y < bh) L[y * bw + x] = v.molten.depth[k]; });
  const touched = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (L[k] > 0) touched[k] = 1;
  const steps = Math.max(8, Math.min(60, Math.ceil(days * 24)));
  const sub = days / steps;
  const ventK = (vy - y0) * bw + (vx - x0);
  const add = lava / (CELL_M * CELL_M) / steps;
  const drop = new Float32Array(n);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) drop[y * bw + x] = YIELD * CELL_M * rough((y0 + y) * W + x0 + x);
  const DX = [-1, 1, 0, 0, -1, 1, -1, 1], DY = [0, 0, -1, 1, -1, -1, 1, 1];
  const w = new Float32Array(8), nb = new Int32Array(8);
  for (let s = 0; s < steps; s++) {
    if (add > 0) { zb[ventK] += add; L[ventK] += add; touched[ventK] = 1; }
    // Each cell sheds to its lower neighbours, the diagonal ones too, what
    // lies above the slope lava stops on there, an eighth of it each
    // sub-step, no more than it holds.
    out.fill(0);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const k = y * bw + x;
        if (L[k] <= 0) continue;
        let want = 0;
        for (let q = 0; q < 8; q++) {
          const xx = x + DX[q], yy = y + DY[q];
          w[q] = 0; nb[q] = -1;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          const j = yy * bw + xx;
          nb[q] = j;
          const e = zb[k] - zb[j] - drop[k] * (q < 4 ? 1 : Math.SQRT2);
          if (e > 0) { w[q] = e * (q < 4 ? 0.125 : 0.125 / Math.SQRT2); want += w[q]; }
        }
        if (want <= 0) continue;
        const scale = Math.min(1, L[k] / want);
        for (let q = 0; q < 8; q++) {
          if (!w[q]) continue;
          const m = w[q] * scale;
          out[k] -= m;
          out[nb[q]] += m;
        }
      }
    }
    for (let k = 0; k < n; k++) {
      if (out[k] === 0) continue;
      zb[k] += out[k];
      L[k] = Math.max(0, L[k] + out[k]);
      if (out[k] > 0) touched[k] = 1;
    }
    // It sets: fast in water.
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const k = y * bw + x;
        if (L[k] <= 0) continue;
        const wet = h[(y0 + y) * W + x0 + x] > 0.1;
        L[k] *= Math.exp(-sub / (wet ? QUENCH_DAYS : COOL_DAYS));
        if (L[k] < 0.01) L[k] = 0;
      }
    }
  }
  // What's still molten, for next time.
  const cells = [], depth = [];
  for (let k = 0; k < n; k++) if (L[k] > 0) { cells.push((y0 + ((k / bw) | 0)) * W + x0 + (k % bw)); depth.push(L[k]); }
  v.molten = { cells, depth };
  // The ash: the eruption's share, thinning away from the vent.
  const ash = new Float32Array(n);
  const vol = (ASH_SHARE * lava) / (CELL_M * CELL_M);
  if (vol > 0) {
    let sum = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const k = y * bw + x; ash[k] = Math.exp(-Math.hypot(x0 + x - vx, y0 + y - vy) / ASH_R); sum += ash[k]; }
    for (let k = 0; k < n; k++) ash[k] *= vol / sum;
  }
  const dz = new Float32Array(n);
  for (let k = 0; k < n; k++) dz[k] = zb[k] - z0[k];
  return { x0, y0, w: bw, h: bh, dz, ash, lava: touched, heat: L };
}

// The change to the ground, on the CPU: where lava lies, the ground rises
// by its change and is rock to its top, bare; then the ash falls on it as
// loose ground and smothers the plants. (The GPU's deposit pass does the
// same.) Marks the lava rock, and the molten lava's glow, for drawing.
export function applyDeposit(flow, c) {
  const { W, z, rock, fm, sm, fg, sg, cover, trees } = flow;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const k = y * c.w + x, i = (c.y0 + y) * W + c.x0 + x;
      if (c.lava[k]) {
        z[i] += c.dz[k];
        rock[i] = z[i];
        fm[i] = 0; sm[i] = 0; fg[i] = 0; sg[i] = 0;
        cover[i] = 0; trees[i] = 0;
        flow.basalt[i] = 1;
      }
      const a = c.ash[k];
      if (a > 0) {
        flow.mix(i, a, a * ASH_MUD, a * ASH_GRAVEL);
        z[i] += a;
        const keep = Math.exp(-a / ASH_BURY);
        cover[i] *= keep; trees[i] *= keep;
      }
    }
  }
}

// The molten lava's glow, 0..255, for drawing.
export function markHeat(flow, c) {
  const { W } = flow;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const k = y * c.w + x;
      flow.lavaHeat[(c.y0 + y) * W + c.x0 + x] = Math.min(255, Math.round((c.heat[k] / HEAT_FULL) * 255));
    }
  }
}
