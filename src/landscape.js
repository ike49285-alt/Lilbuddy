// landscape.js — the river. A landscape-evolution model: fill the
// depressions, route the water, cut the channels, move the sediment.
//
// A step can be anything from a day to MAX_STEP_YEARS; every rate below is
// per year and scaled by the step. Erosion uses the stream-power law
// E = K · Q^m · S solved implicitly down the drainage tree (Braun & Willett,
// 2013) with m = 0.5, so it stays stable however large the step. Sediment is carried
// downstream and dropped where the river loses the power to carry it: on
// fans at the mountain front, across the floodplain, in lakes, and at the
// mouth, where it builds the delta.
//
// The ground is bedrock under a layer of loose cover (soil, sand, silt,
// scree). Bedrock wears down at its own rate, slow for granite and faster
// for shale. Loose cover is picked up as fast as the water can carry it, so
// a sandy gully cuts in days while granite barely moves in a lifetime.
// Whatever settles out adds to the cover, and bare rock slowly weathers into
// new soil. (Cover doesn't shield the rock under it: a thin fresh deposit
// would otherwise stall a river at short ticks but not long ones.)

import { CELL_M, ROCKS } from './terrain.js';

export const MAX_STEP_YEARS = 1000;   // the step the model was tuned at; the host never asks for more

const K_FLUVIAL = 1.2e-5;       // erodibility, per year, with Q in m³/yr
export const CHANNEL_Q = 2.5e6; // m³/yr: below this, water runs off as sheetwash and doesn't cut a channel
const SQRT_CHANNEL_Q = Math.sqrt(CHANNEL_Q);
const ICE_EROSION = 2.4;        // multiplier under ice
const TRANSPORT = 25;           // transport capacity as a multiple of detachment
const DEPOSIT_RATE = 0.35;      // fraction of over-capacity load dropped per cell
const MAX_DEPOSIT_PER_YR = 0.003; // metres per cell
const MELT_PER_DEG_DAY = 0.004; // metres of snow (water equivalent) melted per °C above freezing per day
const MAX_SNOW = 4;              // metres; deeper than this it counts as glacier, not seasonal snow
const LAKE_TRAP = 0.92;         // fraction of a river's load a lake keeps
const HILL_DIFF_PER_YR = 1.5e-5; // hillslope smoothing on land
const SLIDE_SLOPE = 0.5;        // beyond this gradient a slope fails and slides
const SLIDE_PER_YR = 5e-4;
const MARINE_DIFF_PER_YR = 1.2e-4; // smoothing on the sea floor
const VEG_HOLD = 0.5;            // how much full plant cover slows erosion and creep
const MAX_SMOOTH = 0.2;         // keeps the explicit smoothing stable at any step
const FERT_MEMORY_YR = 33000;   // how long a floodplain stays rich after the river stops feeding it
const FILL_EPS = 1e-3;          // metres of gradient imposed across filled lakes
const LAKE_MIN_DEPTH = 0.75;    // metres of standing water before a cell counts as lake
const SHELF_SPILL_HOPS = 48;
const MAX_UPLIFT_Z = 3600;       // uplift fades out as a range approaches this height
const LOOSE_K = 5000;            // loose cover erodes this many times the base rate (≈ 20,000 × granite)
const SOIL_MANTLE_M = 1;         // the soil a creeping hillside keeps
const SOIL_DEPTH_M = 0.5;        // soil production falls off with depth on this scale
const EVAP_PER_YR = 1.2;         // metres of open water evaporated per year in warm weather
export const LAG_TICK = 1 / 365.25; // below this tick, water takes real time to travel down the rivers
const HOLLOW_M = 0.05;           // a hollow shallower than this fills as soon as water arrives
const LAG_SUB = 1800 / 3.156e7;  // years: sub-step for moving water along
const SEC_PER_YR = 3.156e7;
const MOUTH_SETTLE = 0.55;      // fraction of sediment reaching the sea that settles near the mouth; the fines go offshore

// Eight neighbours: dx, dy, distance factor.
const NB = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, -1, Math.SQRT2],
];
const NB_INV = NB.map((d) => 1 / d[2]);

export class Landscape {
  constructor(terrain) {
    const { W, H, N } = terrain;
    this.W = W; this.H = H; this.N = N;
    this.z = terrain.z;
    this.z0 = Float32Array.from(terrain.z);
    this.uplift = terrain.uplift;
    this.kfac = terrain.kfac;             // bedrock erodibility, from the rock type
    this.upliftScale = 1;                 // how fast the mountains rise, as set on the page (1 is natural)
    this.hardness = 1;                    // how hard all the rock is, as set on the page: it wears at 1/hardness
    this.rock = terrain.rock;             // bedrock type, an index into ROCKS
    this.loose = terrain.loose;           // metres of loose cover; the bedrock top is z − loose

    this.filled = new Float64Array(N);
    this.rec = new Int32Array(N);
    this.stack = new Int32Array(N);
    this.Q = new Float32Array(N);         // discharge, m³/yr
    this.runoff = new Float32Array(N);    // each cell's own water before routing, m³/yr
    this.qs = new Float64Array(N);        // sediment in transit, m³ per step
    this.eroded = new Float32Array(N);    // metres removed this step (negative = deposited)
    this.fert = new Float32Array(N);      // recent deposition, smoothed — floodplain fertility
    this.ocean = new Uint8Array(N);
    this.ice = new Uint8Array(N);
    this.snow = new Float32Array(N);      // seasonal snowpack, metres of water
    this.cover = new Float32Array(N);     // plant cover 0..1, set by life — plants hold the soil
    this.lake = new Uint8Array(N);
    this.dam = new Float32Array(N);       // metres of a cell's height that is a dam, kept up by its builders
    this.maxDonor = new Int32Array(N);
    this.share = new Float64Array(8);
    this.basin = new Int32Array(N);
    this.tmp = new Float64Array(N);
    this.slid = new Uint8Array(N);        // cells where a slope failed this step
    // Water that finds its way: standing water fills hollows before it
    // spills on, and below a day it takes time to travel.
    this.water = new Float32Array(N);     // standing water, metres; the world starts dry
    this.surf = new Float64Array(N);      // the surface water sees: ground plus standing water
    this.region = new Int32Array(N);      // which filling hollow a cell is in, or −1
    this.regions = [];                    // { cells (highest first), level, exit, capacity, next }
    this.tree = new Int32Array(N);        // downstream-first order along the receivers
    this.donorStart = new Int32Array(N + 1);
    this.donorList = new Int32Array(N);
    this.cursor = new Int32Array(N);
    this.recF = new Int32Array(N);        // receivers on the filled surface: the way out once a hollow is full
    this.recS = new Int32Array(N);        // receivers on the real surface: down to the bottom of a hollow
    this.q1 = new Float32Array(N);
    this.chan = new Float32Array(N);      // water in transit in each reach, m³ (below a day)
    this.spillIn = new Float32Array(N);   // a hollow's overflow arriving downstream next tick, m³/yr
    this.tau = new Float32Array(N);
    this.decay = new Float32Array(N);
    this.qAvg = new Float64Array(N);
    this.lagActive = false;
    this.lastDt = 1;
    this.rainField = null;                // at short ticks: rain on each life cell as a multiple of the climate's
    this.toLife = null;                   // landscape cell → life cell

    // Priority-flood heap.
    this.heap = new Int32Array(N);
    this.heapKey = new Float64Array(N);
    // Each cell's eight neighbours (-1 off the map), in NB order.
    this.nbr = new Int32Array(N * 8);
    for (let i = 0; i < N; i++) {
      const x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NB[k][0], ny = y + NB[k][1];
        this.nbr[i * 8 + k] = nx < 0 || nx >= W || ny < 0 || ny >= H ? -1 : ny * W + nx;
      }
    }
    this.heapSize = 0;
    this.seen = new Uint8Array(N);

    this.stats = {
      mouthQ: 0, trunkLen: 0, relief: 0, deltaCells: 0, lakeCells: 0,
      mainShare: 0, outlets: 0, iceCells: 0, snowCells: 0, catchment: 0,
    };
    this.mouth = -1;
  }

  // Route water over the surface without changing anything, so step 0 (or
  // a restored world) has something to show and carries on exactly.
  prime(climate) {
    const snow = this.snow.slice(), water = this.water.slice();
    this.markOcean(climate.seaLevel);
    this.priorityFlood(climate.seaLevel);
    this.accumulate(climate, this.lastDt, false);
    this.snow.set(snow);
    this.water.set(water);
    this.measure(climate);
  }

  // Re-routes the water after the surface has been changed from outside a
  // step (an impact, an eruption), so the change shows at once even while
  // paused. Uses the last step's runoff, so nothing advances in time.
  refresh(climate) {
    this.markOcean(climate.seaLevel);
    this.priorityFlood(climate.seaLevel);
    const { N, Q, runoff, ocean } = this;
    for (let i = 0; i < N; i++) Q[i] = ocean[i] ? 0 : runoff[i];
    this.climate = climate;
    this.route(this.lastDt, false);
    this.measure(climate);
  }

  // One step of dt years.
  step(climate, dt) {
    const { N, z, uplift } = this;
    const lift = this.upliftScale;
    for (let i = 0; i < N; i++) {
      const u = uplift[i];
      z[i] += u > 0 ? u * lift * dt * Math.max(0, 1 - z[i] / MAX_UPLIFT_Z) : u * dt;
    }

    this.lastDt = dt;
    this.markOcean(climate.seaLevel);
    this.priorityFlood(climate.seaLevel);
    this.accumulate(climate, dt, true);
    this.erode(climate, dt);
    this.transport(climate.seaLevel, dt);
    this.diffuse(dt);
    this.weather(dt);
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
    const { W, H, N, z, filled, rec, stack, ocean, seen, surf, water } = this;
    for (let i = 0; i < N; i++) surf[i] = ocean[i] ? z[i] : z[i] + water[i];
    seen.fill(0);
    this.heapSize = 0;
    const { nbr } = this;
    let n = 0;
    const lastRow = (H - 1) * W;
    for (let i = 0; i < N; i++) {
      if (!ocean[i] && i < lastRow) continue;
      seen[i] = 1;
      filled[i] = ocean[i] ? sea : surf[i];
      this.push(i, filled[i]);
    }
    // Every cell comes off the heap after the lower ones around it, so the
    // flood order (stack) is a valid order for routing water down.
    while (this.heapSize > 0) {
      const c = this.pop();
      stack[n++] = c;
      const kc = filled[c];
      const o = c * 8;
      for (let k = 0; k < 8; k++) {
        const j = nbr[o + k];
        if (j < 0 || seen[j]) continue;
        seen[j] = 1;
        const f = Math.max(surf[j], kc + FILL_EPS);
        filled[j] = f;
        this.push(j, f);
      }
    }
    // Steepest descent on the filled surface.
    for (let i = 0; i < N; i++) {
      if (ocean[i] || i >= lastRow) { rec[i] = i; continue; }
      const fi = filled[i];
      const o = i * 8;
      let best = i, bestSlope = 0;
      for (let k = 0; k < 8; k++) {
        const j = nbr[o + k];
        if (j < 0) continue;
        const slope = (fi - filled[j]) * NB_INV[k];
        if (slope > bestSlope) { bestSlope = slope; best = j; }
      }
      rec[i] = best;
    }
    this.markLakes();
    this.findHollows();
  }

  markLakes() {
    const { N, lake, ocean, water } = this;
    for (let i = 0; i < N; i++) lake[i] = !ocean[i] && water[i] > LAKE_MIN_DEPTH ? 1 : 0;
  }

  // Open water evaporates, metres a year: fast in the warm, hardly at all
  // frozen over.
  evapAt(level) {
    const T = this.climate.tempAt(level);
    return EVAP_PER_YR * Math.max(0.05, Math.min(1.5, (T + 5) / 25));
  }

  // The hollows: ground below the level at which water would spill out,
  // lakes included. Each gets the level it fills to, the cell it spills
  // into, and how much water it can still take. Until it's full, water runs
  // down the real surface to its lowest points rather than across the level
  // it will one day fill to. Water left standing where there's no longer a
  // hollow (its outlet has been cut down) drains away.
  findHollows() {
    const { W, H, N, z, filled, surf, ocean, region, rec, water } = this;
    const area = CELL_M * CELL_M;
    region.fill(-1);
    const regions = [];
    const queue = this.heap;   // free once the flood is done
    for (let s0 = 0; s0 < N; s0++) {
      if (ocean[s0] || region[s0] !== -1 || filled[s0] - z[s0] <= 1e-9) continue;
      const id = regions.length;
      const cells = [];
      let head = 0, tail = 0;
      queue[tail++] = s0; region[s0] = id;
      while (head < tail) {
        const c = queue[head++];
        cells.push(c);
        const cx = c % W, cy = (c / W) | 0;
        for (let k = 0; k < 8; k++) {
          const nx = cx + NB[k][0], ny = cy + NB[k][1];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const j = ny * W + nx;
          if (region[j] !== -1 || ocean[j] || filled[j] - z[j] <= 1e-9) continue;
          region[j] = id;
          queue[tail++] = j;
        }
      }
      // Too shallow to matter: it's full the moment water arrives.
      let deepest = 0;
      for (const c of cells) deepest = Math.max(deepest, filled[c] - z[c]);
      if (deepest < HOLLOW_M) {
        for (const c of cells) region[c] = -2;      // seen; flows on as before
        continue;
      }
      // It spills where the filled surface is lowest, into that cell's receiver.
      let low = cells[0];
      for (const c of cells) if (filled[c] < filled[low]) low = c;
      const level = filled[low];
      let exit = rec[low];
      if (region[exit] === id) {
        exit = -1;
        for (const c of cells) if (region[rec[c]] !== id) { exit = rec[c]; break; }
      }
      cells.sort((a, b) => surf[b] - surf[a]);
      let capacity = 0, wet = 0, minZ = Infinity;
      for (const c of cells) {
        this.recF[c] = rec[c];
        if (level > surf[c]) capacity += (level - surf[c]) * area;
        if (level > z[c]) wet++;
        if (z[c] < minZ) minZ = z[c];
        // Downhill on the real surface; a cell with nothing lower is where water pools.
        const cx = c % W, cy = (c / W) | 0;
        let best = c, bestSlope = 0;
        for (let k = 0; k < 8; k++) {
          const nx = cx + NB[k][0], ny = cy + NB[k][1];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const j = ny * W + nx;
          const slope = (surf[c] - surf[j]) / NB[k][2];
          if (slope > bestSlope) { bestSlope = slope; best = j; }
        }
        this.recS[c] = best;
      }
      regions.push({ cells, level, exit, capacity, wet, minZ, full: true });
    }
    for (let i = 0; i < N; i++) {
      if (region[i] === -2) region[i] = -1;
      if (region[i] < 0 && water[i] > 0) water[i] = 0;
    }
    // Ids must run 0…n−1 for the regions that were kept.
    this.regions = regions;
  }

  // Discharge: rain and meltwater on every land cell, summed downstream.
  // Through the seasons, snow piles up in the cold and runs off in the
  // thaw; with longer ticks every cell simply sheds its annual rain.
  accumulate(climate, dt, commit) {
    this.climate = climate;
    const { N, z, Q, ocean, ice, snow } = this;
    const area = CELL_M * CELL_M;
    const seasonal = climate.seasonal;
    const meltPerDeg = MELT_PER_DEG_DAY * dt * 365.25;
    let iceCells = 0, snowCells = 0;
    for (let i = 0; i < N; i++) {
      if (ocean[i]) { Q[i] = 0; ice[i] = 0; snow[i] = 0; continue; }
      const P = climate.precipAt(z[i]) * (this.rainField ? this.rainField[this.toLife[i]] : 1);
      ice[i] = climate.iceAt(z[i]) ? 1 : 0;
      iceCells += ice[i];
      if (!seasonal) {
        snow[i] = 0;
        Q[i] = P * area;
        continue;
      }
      const T = climate.tempAt(z[i]);
      const fall = P * dt;
      let water = 0;
      if (T < 0) snow[i] = Math.min(MAX_SNOW, snow[i] + fall);
      else water = fall;
      if (T > 0 && snow[i] > 0) {
        const m = Math.min(snow[i], meltPerDeg * T);
        snow[i] -= m;
        water += m;
      }
      if (snow[i] > 0.02) snowCells++;
      Q[i] = (water / dt) * area;
    }
    this.stats.snowCells = snowCells;
    this.stats.iceCells = iceCells;
    this.runoff.set(Q);
    // Below a day, the water moving down the rivers is followed as it goes;
    // longer ticks see where it settles.
    const lag = commit && dt < LAG_TICK;
    this.route(dt, commit && !lag);
    if (lag) this.lagRoute(dt);
    else if (commit) this.lagActive = false;
    if (commit) this.markLakes();
  }

  // Sums the water downstream. Hollows take what reaches them until they're
  // full, and only then spill on. With `commit` the hollows really fill;
  // without, the flows are worked out and nothing changes.
  //
  // Two passes over the flood order, which is safe for any water running
  // down the filled surface: first as if every hollow were full, which says
  // how much reaches each one; then, knowing which ones fill this tick, with
  // the water held in those that don't.
  route(dt, commit) {
    const { Q, q1, rec, recF, recS, regions } = this;
    for (const g of regions) for (const c of g.cells) rec[c] = recF[c];
    q1.set(Q);
    this.flowPass(null);
    const { region } = this;
    let filling = 0;
    for (let R = 0; R < regions.length; R++) {
      const g = regions[R];
      // Everything leaving the hollow in the first pass is everything that reached it.
      let inflow = 0;
      for (const c of g.cells) if (region[rec[c]] !== R) inflow += Q[c];
      g.full = this.fillHollow(R, inflow * dt, dt, commit) >= 0;
      if (!g.full) { filling++; for (const c of g.cells) rec[c] = recS[c]; }
    }
    // With every hollow full, the first pass already has it right.
    if (filling) {
      Q.set(q1);
      this.flowPass(region);
      // In a hollow that's still filling, the water runs down to its lowest points and stays.
      const { maxDonor } = this;
      for (const g of regions) {
        if (g.full) continue;
        for (const c of g.cells) {            // highest first
          const r = rec[c];
          if (r === c) continue;
          Q[r] += Q[c];
          const d = maxDonor[r];
          if (d < 0 || Q[c] > Q[d]) maxDonor[r] = c;
        }
      }
    }
    this.buildTree();
  }

  // One pass down the flood order. Cells of hollows that are still filling
  // (when `hold` is given) keep their water for later.
  flowPass(hold) {
    const { N, Q, rec, stack, maxDonor, regions } = this;
    const { filled, lake, nbr, share } = this;
    // Below the channel threshold, water spreads over every downhill
    // neighbour in proportion to slope (multiple flow direction), the way
    // sheetwash does on a real hillside. Once it's a channel it all follows
    // the steepest path. Spreading on the slopes keeps the grid from carving
    // ranks of straight, parallel gullies.
    maxDonor.fill(-1);
    for (let s = N - 1; s >= 0; s--) {
      const i = stack[s];
      if (hold && hold[i] >= 0 && !regions[hold[i]].full) continue;
      const r = rec[i];
      if (r === i) continue;
      // Across a hollow the water takes one path, as across a lake.
      if (Q[i] >= CHANNEL_Q || lake[i] || this.region[i] >= 0) {
        Q[r] += Q[i];
        const d = maxDonor[r];
        if (d < 0 || Q[i] > Q[d]) maxDonor[r] = i;
        continue;
      }
      const fi = filled[i];
      const o = i * 8;
      let total = 0;
      for (let k = 0; k < 8; k++) {
        const j = nbr[o + k];
        if (j < 0) { share[k] = 0; continue; }
        const drop = fi - filled[j];
        const w = drop > 0 ? drop * NB_INV[k] : 0;
        share[k] = w;
        total += w;
      }
      if (total <= 0) { Q[r] += Q[i]; continue; }
      const q = Q[i] / total;
      for (let k = 0; k < 8; k++) {
        const w = share[k];
        if (w > 0) Q[nbr[o + k]] += q * w;
      }
      const d = maxDonor[r];
      if (d < 0 || Q[i] > Q[d]) maxDonor[r] = i;
    }
  }

  // Pours a tick's inflow (m³) into a hollow, less what evaporates. Returns
  // the overflow (m³) if it fills, or −1 if it doesn't, in which case the
  // water stands at the level where it all fits.
  fillHollow(R, volume, dt, commit) {
    const g = this.regions[R];
    const { z, water } = this;
    const area = CELL_M * CELL_M;
    const E = this.evapAt(g.level) * dt;
    const spill = volume - g.capacity - E * g.wet * area;
    if (spill >= 0) {
      if (commit) for (const c of g.cells) water[c] = g.level > z[c] ? g.level - z[c] : 0;
      return spill;
    }
    if (!commit) return -1;
    // The level where what's there, less what evaporates from the water's
    // surface, just fits. A lot of evaporation in one tick is taken in
    // steps, so a shrinking pond loses less as its surface shrinks.
    const steps = Math.min(20, Math.max(1, Math.ceil(E / 20)));
    const e = E / steps;
    const need = (h) => {
      let v = 0;
      for (const c of g.cells) if (h > z[c]) v += (h - z[c] + e) * area;
      return v;
    };
    for (let k = 0; k < steps; k++) {
      let have = volume / steps;
      for (const c of g.cells) have += water[c] * area;
      let lo = g.minZ, hi = g.level;
      if (have <= 0 || need(lo + 1e-6) >= have) { for (const c of g.cells) water[c] = 0; continue; }
      for (let it = 0; it < 40; it++) {
        const h = (lo + hi) / 2;
        if (need(h) > have) hi = h; else lo = h;
      }
      for (const c of g.cells) water[c] = lo > z[c] ? lo - z[c] : 0;
    }
    return -1;
  }

  // Below a day: water moves reach by reach at about a river's speed,
  // faster in big rivers, so a flood or a new channel's first flow can be
  // watched travelling down the valley. Each reach holds the water in
  // transit and lets it go over its travel time; what reaches the bottom of
  // a hollow fills it, and its overflow goes on next tick.
  lagRoute(dt) {
    const { N, W, Q, rec, runoff, chan, spillIn, ocean, region, regions, tau, decay, qAvg } = this;
    for (let i = 0; i < N; i++) {
      if (ocean[i]) continue;
      const r = rec[i];
      const diag = r !== i && (i % W) !== (r % W) && ((i / W) | 0) !== ((r / W) | 0);
      const v = Math.max(0.2, Math.min(3, 0.2 + 0.25 * Math.pow(Q[i] / SEC_PER_YR, 0.25)));   // m/s
      tau[i] = ((diag ? Math.SQRT2 : 1) * CELL_M) / v / SEC_PER_YR;
    }
    if (!this.lagActive) {
      // Arriving from long ticks: the rivers are already running.
      for (let i = 0; i < N; i++) chan[i] = ocean[i] ? 0 : Q[i] * tau[i];
      spillIn.fill(0);
      this.lagActive = true;
    }
    const n = Math.max(1, Math.ceil(dt / LAG_SUB));
    const h = dt / n;
    for (let i = 0; i < N; i++) decay[i] = ocean[i] ? 0 : Math.exp(-h / tau[i]);
    const pool = new Float64Array(regions.length);
    const inflow = this.tmp;
    const { tree } = this;
    qAvg.fill(0);
    // Each sub-step sweeps down from the headwaters, so what a reach lets go
    // reaches the next one in the same sub-step; each reach holds water back
    // over its own travel time, and nothing is lost or made along the way.
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < N; i++) inflow[i] = ocean[i] ? 0 : runoff[i] + spillIn[i];
      for (let s = N - 1; s >= 0; s--) {
        const i = tree[s];
        if (ocean[i]) continue;
        const S0 = chan[i], e = decay[i];
        const S1 = S0 * e + inflow[i] * tau[i] * (1 - e);
        const out = inflow[i] - (S1 - S0) / h;     // m³/yr leaving over the sub-step
        chan[i] = S1;
        qAvg[i] += out;
        const r = rec[i];
        if (r === i) { if (region[i] >= 0) pool[region[i]] += out * h; }
        else if (!ocean[r]) inflow[r] += out;
      }
    }
    for (let i = 0; i < N; i++) Q[i] = qAvg[i] / n;
    spillIn.fill(0);
    for (let R = 0; R < regions.length; R++) {
      // A full one has its river running straight through it.
      if (regions[R].full) continue;
      const spill = this.fillHollow(R, pool[R], dt, true);
      const x = regions[R].exit;
      if (spill > 0 && x >= 0 && !ocean[x]) spillIn[x] += spill / dt;
    }
  }

  // Orders the cells so every receiver comes before the cells draining into
  // it, following the drainage as it actually runs, into hollows included.
  buildTree() {
    const { N, rec, tree, donorStart, donorList, cursor } = this;
    donorStart.fill(0);
    for (let i = 0; i < N; i++) { const r = rec[i]; if (r !== i) donorStart[r + 1]++; }
    for (let i = 0; i < N; i++) donorStart[i + 1] += donorStart[i];
    for (let i = 0; i < N; i++) cursor[i] = donorStart[i];
    for (let i = 0; i < N; i++) { const r = rec[i]; if (r !== i) donorList[cursor[r]++] = i; }
    let n = 0;
    for (let i = 0; i < N; i++) if (rec[i] === i) tree[n++] = i;
    for (let k = 0; k < n; k++) {
      const c = tree[k];
      for (let p = donorStart[c]; p < donorStart[c + 1]; p++) tree[n++] = donorList[p];
    }
    if (n !== N) throw new Error(`drainage has a loop: ordered ${n} of ${N} cells`);
  }

  // Implicit stream-power incision, downstream first so every receiver is
  // already at its new height when its donors are solved.
  erode(climate, dt) {
    const { W, N, z, surf, rec, tree, Q, kfac, ice, ocean, eroded } = this;
    const sea = climate.seaLevel;
    eroded.fill(0);
    for (let s = 0; s < N; s++) {
      const i = tree[s];
      const r = rec[i];
      if (r === i || ocean[i] || this.lake[i] || this.dam[i]) continue;
      const dx = Math.abs((i % W) - (r % W)), dy = Math.abs(((i / W) | 0) - ((r / W) | 0));
      const dist = (dx && dy ? Math.SQRT2 : 1) * CELL_M;
      const zr = ocean[r] ? sea : this.lake[r] ? surf[r] : z[r];
      if (z[i] <= zr) continue;
      const K = (K_FLUVIAL * kfac[i] / this.hardness) * (ice[i] ? ICE_EROSION : 1) * (1 - VEG_HOLD * this.cover[i]);
      const power = ice[i] ? Math.sqrt(Q[i]) : Math.sqrt(Q[i]) - SQRT_CHANNEL_Q;
      if (power <= 0) continue;
      const F = K * power * dt / dist;
      const zn = (z[i] + F * zr) / (1 + F);
      eroded[i] = z[i] - zn;
      z[i] = zn;
      // Whatever's on top goes first.
      this.loose[i] = Math.max(0, this.loose[i] - eroded[i]);
    }
  }

  // Carry the eroded rock downstream, upstream first. Drop what the river
  // can't carry; lakes trap nearly everything; the sea takes the rest.
  transport(sea, dt) {
    const { W, N, z, surf, rec, tree, Q, qs, eroded, ocean, fert, loose, ice, water } = this;
    const area = CELL_M * CELL_M;
    qs.fill(0);
    const keep = Math.exp(-dt / FERT_MEMORY_YR);
    const perCentury = 100 / dt;
    for (let s = N - 1; s >= 0; s--) {
      const i = tree[s];
      qs[i] += eroded[i] * area;
      let dep = 0;
      if (ocean[i]) continue;
      const r = rec[i];
      if (this.lake[i]) {
        dep = Math.min(qs[i] * LAKE_TRAP, Math.max(0, water[i] - FILL_EPS) * area);
      } else if (r === i) {
        // The bottom of a hollow keeps everything that's washed into it; at
        // the map's lower edge it goes on out to sea.
        if (((i / W) | 0) !== this.H - 1) dep = qs[i];
      } else {
        const dx = Math.abs((i % W) - (r % W)), dy = Math.abs(((i / W) | 0) - ((r / W) | 0));
        const dist = (dx && dy ? Math.SQRT2 : 1) * CELL_M;
        const zr = ocean[r] ? sea : z[r];
        const slope = Math.max(0, z[i] - zr) / dist;
        const sq = Math.sqrt(Q[i]);
        const cap = TRANSPORT * K_FLUVIAL * sq * slope * dt * area;
        // Loose cover goes as fast as the water can take it: limited by how
        // quickly the flow scours it, how much there is, and how much more
        // the water can carry. Roots hold it.
        // Cover on a hillside stays put under sheetwash, as rock does; only a
        // channel takes it. (Letting sand gully at smaller flows splits the
        // plain into parallel streams at short ticks but not long ones.)
        const power = ice[i] ? sq : sq - SQRT_CHANNEL_Q;
        if (power > 0 && loose[i] > 0 && cap > qs[i] && !this.dam[i]) {
          const scour = LOOSE_K * K_FLUVIAL * power * slope * dt * (1 - 0.8 * this.cover[i]);
          // Never below the next cell down (or the water in it): scouring
          // sand doesn't dig pits.
          const floor = this.lake[r] ? surf[r] : zr;
          const pick = Math.min(loose[i], scour, (cap - qs[i]) / area, Math.max(0, z[i] - floor - FILL_EPS));
          if (pick > 0) {
            loose[i] -= pick;
            z[i] -= pick;
            eroded[i] += pick;
            qs[i] += pick * area;
          }
        }
        if (qs[i] > cap) {
          dep = Math.min((qs[i] - cap) * DEPOSIT_RATE, MAX_DEPOSIT_PER_YR * dt * area);
          // A deposit never builds above the channel feeding it, so the river
          // doesn't dam itself into a string of ponds.
          const d = this.maxDonor[i];
          if (d >= 0) dep = Math.min(dep, Math.max(0, z[d] - z[i] - FILL_EPS) * area);
        }
      }
      if (dep > 0) {
        z[i] += dep / area;
        loose[i] += dep / area;
        // Sediment settling in standing water takes the water's place.
        if (water[i] > 0) water[i] = Math.max(0, water[i] - dep / area);
        eroded[i] -= dep / area;
        qs[i] -= dep;
      }
      // Fertility tracks recent deposition, in metres per century.
      fert[i] = fert[i] * keep + (1 - keep) * 10 * Math.max(0, -eroded[i]) * perCentury;
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
          loose[c] += put / area;
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
  diffuse(dt) {
    const { W, H, z, ocean, tmp, slid } = this;
    const kHill = Math.min(MAX_SMOOTH, HILL_DIFF_PER_YR * dt);
    const kSea = Math.min(MAX_SMOOTH, MARINE_DIFF_PER_YR * dt);
    const kSlide = Math.min(MAX_SMOOTH, SLIDE_PER_YR * dt);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let sum = 0, n = 0;
        if (x > 0) { sum += z[i - 1]; n++; }
        if (x < W - 1) { sum += z[i + 1]; n++; }
        if (y > 0) { sum += z[i - W]; n++; }
        if (y < H - 1) { sum += z[i + W]; n++; }
        const held = 1 - VEG_HOLD * this.cover[i];
        let k = ocean[i] ? kSea : kHill * held;
        slid[i] = 0;
        if (!ocean[i]) {
          let steep = 0;
          if (x > 0) steep = Math.max(steep, Math.abs(z[i] - z[i - 1]));
          if (x < W - 1) steep = Math.max(steep, Math.abs(z[i] - z[i + 1]));
          if (y > 0) steep = Math.max(steep, Math.abs(z[i] - z[i - W]));
          if (y < H - 1) steep = Math.max(steep, Math.abs(z[i] - z[i + W]));
          if (steep > SLIDE_SLOPE * (1 + 0.6 * this.cover[i]) * CELL_M && kSlide > k) { k = kSlide; slid[i] = 1; }
        }
        tmp[i] = this.dam[i] ? z[i] : z[i] + k * (sum / n - z[i]);
      }
    }
    // What creeps in settles at the foot of the slope as cover. What creeps
    // away is cover too, except a hillside's own soil mantle: that rides on
    // top while the rock beneath wears down and turns into more soil. A
    // slide takes everything; on the sea floor it's all sediment.
    const { loose } = this;
    for (let i = 0; i < z.length; i++) {
      const d = tmp[i] - z[i];
      if (d >= 0) loose[i] += d;
      else if (slid[i] || ocean[i]) loose[i] = Math.max(0, loose[i] + d);
      else if (loose[i] > SOIL_MANTLE_M) loose[i] = Math.max(SOIL_MANTLE_M, loose[i] + d);
    }
    z.set(tmp);
  }

  // Bare rock weathers into soil, quickly at first and ever more slowly as
  // the soil above it thickens: h grows as dh/dt = P·exp(−h/h0), integrated
  // exactly over the step. Not under ice or the sea.
  weather(dt) {
    const { N, loose, rock, ocean, ice } = this;
    for (let i = 0; i < N; i++) {
      // Under more than a few metres, nothing reaches the rock to weather it.
      if (ocean[i] || ice[i] || loose[i] > 16 * SOIL_DEPTH_M) continue;
      const P = ROCKS[rock[i]].soil / this.hardness;
      loose[i] = SOIL_DEPTH_M * Math.log(Math.exp(loose[i] / SOIL_DEPTH_M) + (P * dt) / SOIL_DEPTH_M);
    }
  }

  measure(climate) {
    const { W, H, N, z, z0, Q, rec, tree, ocean, maxDonor, basin } = this;
    const st = this.stats;
    const sea = climate.seaLevel;

    // Basins: every cell inherits its outlet's id, downstream first.
    for (let s = 0; s < N; s++) {
      const i = tree[s];
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
          // All the water that ends somewhere: in the sea, or in a hollow.
          totalOut += Q[i];
          // Only what reaches the sea makes a river mouth.
          const toSea = ocean[r] || ((i / W) | 0) === H - 1;
          if (toSea && Q[i] > 2e7) outlets++;
          if (toSea && Q[i] > mouthQ) { mouthQ = Q[i]; mouth = i; }
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

  // A binary min-heap of cells by key. Items move into a hole rather than
  // being swapped, which halves the writes.
  push(i, key) {
    const { heap, heapKey } = this;
    let n = this.heapSize++;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (heapKey[p] <= key) break;
      heap[n] = heap[p];
      heapKey[n] = heapKey[p];
      n = p;
    }
    heap[n] = i;
    heapKey[n] = key;
  }

  pop() {
    const { heap, heapKey } = this;
    const top = heap[0];
    const last = --this.heapSize;
    const item = heap[last], key = heapKey[last];
    let n = 0;
    for (;;) {
      const l = 2 * n + 1;
      if (l >= last) break;
      const r = l + 1;
      const m = r < last && heapKey[r] < heapKey[l] ? r : l;
      if (heapKey[m] >= key) break;
      heap[n] = heap[m];
      heapKey[n] = heapKey[m];
      n = m;
    }
    heap[n] = item;
    heapKey[n] = key;
    return top;
  }
}
