// landscape.js — the river. A landscape-evolution model: fill the
// depressions, route the water, cut the channels, move the sediment.
//
// Each step is one thousand years. Erosion uses the stream-power law
// E = K · Q^m · S solved implicitly down the drainage tree (Braun & Willett,
// 2013) with m = 0.5, so it stays stable however large the step. Sediment is carried
// downstream and dropped where the river loses the power to carry it: on
// fans at the mountain front, across the floodplain, in lakes, and at the
// mouth, where it builds the delta.

import { CELL_M } from './terrain.js';

export const STEP_YEARS = 1000;

const K_FLUVIAL = 1.2e-5;       // erodibility, per year, with Q in m³/yr
const CHANNEL_Q = 2.5e6;        // m³/yr: below this, water runs off as sheetwash and doesn't cut a channel
const SQRT_CHANNEL_Q = Math.sqrt(CHANNEL_Q);
const ICE_EROSION = 2.4;        // multiplier under ice
const TRANSPORT = 25;           // transport capacity as a multiple of detachment
const DEPOSIT_RATE = 0.35;      // fraction of over-capacity load dropped per cell
const MAX_DEPOSIT_M = 3;        // per cell per step
const LAKE_TRAP = 0.92;         // fraction of a river's load a lake keeps
const HILL_DIFF = 0.003;        // per-step hillslope smoothing on land
const SLIDE_SLOPE = 0.5;        // beyond this gradient a slope fails and slides
const SLIDE_RATE = 0.18;
const MARINE_DIFF = 0.12;       // per-step smoothing on the sea floor
const FILL_EPS = 1e-3;          // metres of gradient imposed across filled lakes
const LAKE_MIN_DEPTH = 0.75;    // metres of standing water before a cell counts as lake
const SHELF_SPILL_HOPS = 48;
const MAX_UPLIFT_Z = 3600;       // uplift fades out as a range approaches this height
const MOUTH_SETTLE = 0.55;      // fraction of sediment reaching the sea that settles near the mouth; the fines go offshore

// Eight neighbours: dx, dy, distance factor.
const NB = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export class Landscape {
  constructor(terrain) {
    const { W, H, N } = terrain;
    this.W = W; this.H = H; this.N = N;
    this.z = terrain.z;
    this.z0 = Float32Array.from(terrain.z);
    this.uplift = terrain.uplift;
    this.kfac = terrain.kfac;

    this.filled = new Float64Array(N);
    this.rec = new Int32Array(N);
    this.stack = new Int32Array(N);
    this.Q = new Float32Array(N);         // discharge, m³/yr
    this.qs = new Float64Array(N);        // sediment in transit, m³ per step
    this.eroded = new Float32Array(N);    // metres removed this step (negative = deposited)
    this.fert = new Float32Array(N);      // recent deposition, smoothed — floodplain fertility
    this.ocean = new Uint8Array(N);
    this.ice = new Uint8Array(N);
    this.lake = new Uint8Array(N);
    this.maxDonor = new Int32Array(N);
    this.basin = new Int32Array(N);
    this.tmp = new Float64Array(N);

    // Priority-flood heap.
    this.heap = new Int32Array(N);
    this.heapKey = new Float64Array(N);
    this.heapSize = 0;
    this.seen = new Uint8Array(N);

    this.stats = {
      mouthQ: 0, trunkLen: 0, relief: 0, deltaCells: 0, lakeCells: 0,
      mainShare: 0, outlets: 0, iceCells: 0, catchment: 0,
    };
    this.mouth = -1;
  }

  // Route water over the starting surface without changing it, so step 0
  // has something to show.
  prime(climate) {
    this.markOcean(climate.seaLevel);
    this.priorityFlood(climate.seaLevel);
    this.accumulate(climate);
    this.measure(climate);
  }

  // One thousand years.
  step(climate) {
    const { N, z, uplift } = this;
    const dt = STEP_YEARS;
    for (let i = 0; i < N; i++) {
      const u = uplift[i];
      z[i] += u > 0 ? u * dt * Math.max(0, 1 - z[i] / MAX_UPLIFT_Z) : u * dt;
    }

    this.markOcean(climate.seaLevel);
    this.priorityFlood(climate.seaLevel);
    this.accumulate(climate);
    this.erode(climate);
    this.transport(climate.seaLevel);
    this.diffuse();
    this.measure(climate);
  }

  // The sea is whatever lies below sea level and connects to the open water
  // along the bottom edge. A low basin inland stays a lake, not sea.
  markOcean(sea) {
    const { W, H, z, ocean } = this;
    ocean.fill(0);
    const queue = this.stack; // reused as scratch; overwritten by the flood next
    let head = 0, tail = 0;
    for (let x = 0; x < W; x++) {
      const i = (H - 1) * W + x;
      if (z[i] < sea) { ocean[i] = 1; queue[tail++] = i; }
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % W, y = (i / W) | 0;
      if (x > 0) tail = this.oceanVisit(i - 1, sea, queue, tail);
      if (x < W - 1) tail = this.oceanVisit(i + 1, sea, queue, tail);
      if (y > 0) tail = this.oceanVisit(i - W, sea, queue, tail);
      if (y < H - 1) tail = this.oceanVisit(i + W, sea, queue, tail);
    }
  }

  oceanVisit(j, sea, queue, tail) {
    if (!this.ocean[j] && this.z[j] < sea) {
      this.ocean[j] = 1;
      queue[tail++] = j;
    }
    return tail;
  }

  // Priority-flood with an epsilon gradient (Barnes et al. 2014): every land
  // cell ends up with a strictly lower neighbour, lakes become flat-ish water
  // surfaces, and the order cells leave the heap is a valid downstream-first
  // processing order.
  priorityFlood(sea) {
    const { W, H, N, z, filled, rec, stack, ocean, seen } = this;
    seen.fill(0);
    this.heapSize = 0;
    for (let i = 0; i < N; i++) {
      const edge = ((i / W) | 0) === H - 1;
      if (ocean[i] || edge) {
        seen[i] = 1;
        filled[i] = ocean[i] ? sea : z[i];
        this.push(i, filled[i]);
      }
    }
    let n = 0;
    while (this.heapSize > 0) {
      const c = this.pop();
      stack[n++] = c;
      const cx = c % W, cy = (c / W) | 0;
      const kc = filled[c];
      for (let k = 0; k < 8; k++) {
        const nx = cx + NB[k][0], ny = cy + NB[k][1];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j]) continue;
        seen[j] = 1;
        filled[j] = Math.max(z[j], kc + FILL_EPS);
        this.push(j, filled[j]);
      }
    }
    // Steepest descent on the filled surface.
    for (let s = 0; s < N; s++) {
      const i = stack[s];
      const x = i % W, y = (i / W) | 0;
      if (ocean[i] || y === H - 1) { rec[i] = i; continue; }
      let best = i, bestSlope = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NB[k][0], ny = y + NB[k][1];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        const slope = (filled[i] - filled[j]) / NB[k][2];
        if (slope > bestSlope) { bestSlope = slope; best = j; }
      }
      rec[i] = best;
    }
    const { lake } = this;
    for (let i = 0; i < N; i++) lake[i] = !ocean[i] && filled[i] - z[i] > LAKE_MIN_DEPTH ? 1 : 0;
  }

  // Discharge: rain (and meltwater) on every land cell, summed downstream.
  accumulate(climate) {
    const { N, z, Q, rec, stack, ocean, ice, maxDonor } = this;
    const area = CELL_M * CELL_M;
    let iceCells = 0;
    for (let i = 0; i < N; i++) {
      if (ocean[i]) { Q[i] = 0; ice[i] = 0; continue; }
      Q[i] = climate.precipAt(z[i]) * area;
      ice[i] = climate.iceAt(z[i]) ? 1 : 0;
      iceCells += ice[i];
    }
    maxDonor.fill(-1);
    for (let s = N - 1; s >= 0; s--) {
      const i = stack[s];
      const r = rec[i];
      if (r === i) continue;
      Q[r] += Q[i];
      const d = maxDonor[r];
      if (d < 0 || Q[i] > Q[d]) maxDonor[r] = i;
    }
    this.stats.iceCells = iceCells;
  }

  // Implicit stream-power incision, downstream first so every receiver is
  // already at its new height when its donors are solved.
  erode(climate) {
    const { W, N, z, filled, rec, stack, Q, kfac, ice, ocean, eroded } = this;
    const dt = STEP_YEARS;
    const sea = climate.seaLevel;
    eroded.fill(0);
    for (let s = 0; s < N; s++) {
      const i = stack[s];
      const r = rec[i];
      if (r === i || ocean[i] || this.lake[i]) continue;
      const dx = Math.abs((i % W) - (r % W)), dy = Math.abs(((i / W) | 0) - ((r / W) | 0));
      const dist = (dx && dy ? Math.SQRT2 : 1) * CELL_M;
      const zr = ocean[r] ? sea : this.lake[r] ? filled[r] : z[r];
      if (z[i] <= zr) continue;
      const K = K_FLUVIAL * kfac[i] * (ice[i] ? ICE_EROSION : 1);
      const power = ice[i] ? Math.sqrt(Q[i]) : Math.sqrt(Q[i]) - SQRT_CHANNEL_Q;
      if (power <= 0) continue;
      const F = K * power * dt / dist;
      const zn = (z[i] + F * zr) / (1 + F);
      eroded[i] = z[i] - zn;
      z[i] = zn;
    }
  }

  // Carry the eroded rock downstream, upstream first. Drop what the river
  // can't carry; lakes trap nearly everything; the sea takes the rest.
  transport(sea) {
    const { W, N, z, filled, rec, stack, Q, qs, eroded, ocean, fert, kfac } = this;
    const area = CELL_M * CELL_M;
    const dt = STEP_YEARS;
    qs.fill(0);
    for (let s = N - 1; s >= 0; s--) {
      const i = stack[s];
      qs[i] += eroded[i] * area;
      let dep = 0;
      if (ocean[i]) continue;
      const r = rec[i];
      if (this.lake[i]) {
        dep = Math.min(qs[i] * LAKE_TRAP, (filled[i] - z[i] - FILL_EPS) * area);
      } else if (r !== i) {
        const dx = Math.abs((i % W) - (r % W)), dy = Math.abs(((i / W) | 0) - ((r / W) | 0));
        const dist = (dx && dy ? Math.SQRT2 : 1) * CELL_M;
        const zr = ocean[r] ? sea : z[r];
        const slope = Math.max(0, z[i] - zr) / dist;
        const cap = TRANSPORT * K_FLUVIAL * kfac[i] * Math.sqrt(Q[i]) * slope * dt * area;
        if (qs[i] > cap) dep = Math.min((qs[i] - cap) * DEPOSIT_RATE, MAX_DEPOSIT_M * area);
      }
      if (dep > 0) {
        z[i] += dep / area;
        eroded[i] -= dep / area;
        qs[i] -= dep;
      }
      fert[i] = fert[i] * 0.97 + Math.max(0, -eroded[i]) * 0.03;
      if (r !== i) qs[r] += qs[i];
    }
    // Sediment arriving at the sea: fill the shallows at the mouth up to just
    // below sea level, then spill seaward to the deepest neighbour. The pile
    // builds a delta front that the river later builds land on top of.
    for (let i = 0; i < N; i++) {
      if (!ocean[i] || qs[i] <= 0) continue;
      let remaining = qs[i] * MOUTH_SETTLE;
      let c = i;
      for (let hop = 0; hop < SHELF_SPILL_HOPS && remaining > 0; hop++) {
        const room = (sea - 1 - z[c]) * area;
        if (room > 0) {
          const put = Math.min(room, remaining);
          z[c] += put / area;
          remaining -= put;
        }
        if (remaining <= 0) break;
        c = this.deepestOceanNeighbour(c, sea);
        if (c < 0) break;
      }
    }
  }

  deepestOceanNeighbour(i, sea) {
    const { W, H, z, ocean } = this;
    const x = i % W, y = (i / W) | 0;
    let best = -1, bz = sea - 1;
    const tryCell = (j) => { if (ocean[j] && z[j] < bz) { bz = z[j]; best = j; } };
    if (x > 0) tryCell(i - 1);
    if (x < W - 1) tryCell(i + 1);
    if (y > 0) tryCell(i - W);
    if (y < H - 1) tryCell(i + W);
    return best;
  }

  // Hillslopes creep, over-steep slopes slide, and the sea floor smooths out
  // the delta front.
  diffuse() {
    const { W, H, z, ocean, tmp } = this;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let sum = 0, n = 0;
        if (x > 0) { sum += z[i - 1]; n++; }
        if (x < W - 1) { sum += z[i + 1]; n++; }
        if (y > 0) { sum += z[i - W]; n++; }
        if (y < H - 1) { sum += z[i + W]; n++; }
        let k = ocean[i] ? MARINE_DIFF : HILL_DIFF;
        if (!ocean[i]) {
          let steep = 0;
          if (x > 0) steep = Math.max(steep, Math.abs(z[i] - z[i - 1]));
          if (x < W - 1) steep = Math.max(steep, Math.abs(z[i] - z[i + 1]));
          if (y > 0) steep = Math.max(steep, Math.abs(z[i] - z[i - W]));
          if (y < H - 1) steep = Math.max(steep, Math.abs(z[i] - z[i + W]));
          if (steep > SLIDE_SLOPE * CELL_M) k = SLIDE_RATE;
        }
        tmp[i] = z[i] + k * (sum / n - z[i]);
      }
    }
    z.set(tmp);
  }

  measure(climate) {
    const { W, N, z, z0, Q, rec, stack, ocean, maxDonor, basin, filled } = this;
    const st = this.stats;
    const sea = climate.seaLevel;

    // Basins: every cell inherits its outlet's id, downstream first.
    for (let s = 0; s < N; s++) {
      const i = stack[s];
      const r = rec[i];
      basin[i] = r === i ? i : basin[r];
    }
    // The mouth is the land cell emptying into the sea with the most water.
    let mouth = -1, mouthQ = 0, totalOut = 0, outlets = 0;
    let maxZ = -Infinity, deltaCells = 0, lakeCells = 0;
    for (let i = 0; i < N; i++) {
      if (z[i] > maxZ) maxZ = z[i];
      if (!ocean[i]) {
        if (z0[i] < 0 && z[i] > z0[i] + 5) deltaCells++;
        if (this.lake[i]) lakeCells++;
        const r = rec[i];
        if (ocean[r] || r === i) {
          totalOut += Q[i];
          if (Q[i] > 2e7) outlets++;
          if (Q[i] > mouthQ) { mouthQ = Q[i]; mouth = i; }
        }
      }
    }
    // Walk up the trunk river, always following the biggest tributary.
    let len = 0, c = mouth;
    while (c >= 0) {
      const d = maxDonor[c];
      if (d < 0 || Q[d] < 4e7) break;
      const dx = Math.abs((c % W) - (d % W)), dy = Math.abs(((c / W) | 0) - ((d / W) | 0));
      len += (dx && dy ? Math.SQRT2 : 1) * CELL_M;
      c = d;
    }
    let catchment = 0;
    if (mouth >= 0) {
      const b = basin[mouth];
      for (let i = 0; i < N; i++) if (basin[i] === b) catchment++;
    }

    this.mouth = mouth;
    st.mouthQ = mouthQ;
    st.mainShare = totalOut > 0 ? mouthQ / totalOut : 0;
    st.outlets = outlets;
    st.trunkLen = len;
    st.relief = maxZ - sea;
    st.deltaCells = deltaCells;
    st.lakeCells = lakeCells;
    st.catchment = catchment;
  }

  // --- binary min-heap keyed by heapKey -----------------------------------

  push(i, key) {
    const { heap, heapKey } = this;
    let n = this.heapSize++;
    heap[n] = i;
    heapKey[n] = key;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (heapKey[p] <= heapKey[n]) break;
      const ti = heap[p]; heap[p] = heap[n]; heap[n] = ti;
      const tk = heapKey[p]; heapKey[p] = heapKey[n]; heapKey[n] = tk;
      n = p;
    }
  }

  pop() {
    const { heap, heapKey } = this;
    const top = heap[0];
    const last = --this.heapSize;
    heap[0] = heap[last];
    heapKey[0] = heapKey[last];
    let n = 0;
    for (;;) {
      const l = 2 * n + 1, r = l + 1;
      let m = n;
      if (l < last && heapKey[l] < heapKey[m]) m = l;
      if (r < last && heapKey[r] < heapKey[m]) m = r;
      if (m === n) break;
      const ti = heap[m]; heap[m] = heap[n]; heap[n] = ti;
      const tk = heapKey[m]; heapKey[m] = heapKey[n]; heapKey[n] = tk;
      n = m;
    }
    return top;
  }
}
