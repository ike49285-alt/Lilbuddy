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
    this.kfac = terrain.kfac;             // bedrock erodibility, from the rock type
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
    this.maxDonor = new Int32Array(N);
    this.share = new Float64Array(8);
    this.basin = new Int32Array(N);
    this.tmp = new Float64Array(N);
    this.slid = new Uint8Array(N);        // cells where a slope failed this step

    // Priority-flood heap.
    this.heap = new Int32Array(N);
    this.heapKey = new Float64Array(N);
    this.heapSize = 0;
    this.seen = new Uint8Array(N);

    this.stats = {
      mouthQ: 0, trunkLen: 0, relief: 0, deltaCells: 0, lakeCells: 0,
      mainShare: 0, outlets: 0, iceCells: 0, snowCells: 0, catchment: 0,
    };
    this.mouth = -1;
  }

  // Route water over the starting surface without changing it, so step 0
  // has something to show.
  prime(climate) {
    this.markOcean(climate.seaLevel);
    this.priorityFlood(climate.seaLevel);
    this.accumulate(climate, 1);
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
    this.route();
    this.measure(climate);
  }

  // One step of dt years.
  step(climate, dt) {
    const { N, z, uplift } = this;
    for (let i = 0; i < N; i++) {
      const u = uplift[i];
      z[i] += u > 0 ? u * dt * Math.max(0, 1 - z[i] / MAX_UPLIFT_Z) : u * dt;
    }

    this.markOcean(climate.seaLevel);
    this.priorityFlood(climate.seaLevel);
    this.accumulate(climate, dt);
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

  // Discharge: rain and meltwater on every land cell, summed downstream.
  // Through the seasons, snow piles up in the cold and runs off in the
  // thaw; with longer ticks every cell simply sheds its annual rain.
  accumulate(climate, dt) {
    const { N, z, Q, ocean, ice, snow } = this;
    const area = CELL_M * CELL_M;
    const seasonal = climate.seasonal;
    const meltPerDeg = MELT_PER_DEG_DAY * dt * 365.25;
    let iceCells = 0, snowCells = 0;
    for (let i = 0; i < N; i++) {
      if (ocean[i]) { Q[i] = 0; ice[i] = 0; snow[i] = 0; continue; }
      const P = climate.precipAt(z[i]);
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
    this.route();
  }

  route() {
    const { N, Q, rec, stack, maxDonor } = this;
    // Below the channel threshold, water spreads over every downhill
    // neighbour in proportion to slope (multiple flow direction), the way
    // sheetwash does on a real hillside. Once it's a channel it all follows
    // the steepest path. Spreading on the slopes keeps the grid from carving
    // ranks of straight, parallel gullies.
    const { W, H, filled, lake } = this;
    maxDonor.fill(-1);
    for (let s = N - 1; s >= 0; s--) {
      const i = stack[s];
      const r = rec[i];
      if (r === i) continue;
      if (Q[i] >= CHANNEL_Q || lake[i]) {
        Q[r] += Q[i];
        const d = maxDonor[r];
        if (d < 0 || Q[i] > Q[d]) maxDonor[r] = i;
        continue;
      }
      const x = i % W, y = (i / W) | 0;
      const fi = filled[i];
      let total = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NB[k][0], ny = y + NB[k][1];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) { this.share[k] = 0; continue; }
        const drop = fi - filled[ny * W + nx];
        const w = drop > 0 ? drop / NB[k][2] : 0;
        this.share[k] = w;
        total += w;
      }
      if (total <= 0) { Q[r] += Q[i]; continue; }
      const q = Q[i] / total;
      for (let k = 0; k < 8; k++) {
        const w = this.share[k];
        if (w > 0) Q[(y + NB[k][1]) * W + x + NB[k][0]] += q * w;
      }
      const d = maxDonor[r];
      if (d < 0 || Q[i] > Q[d]) maxDonor[r] = i;
    }
  }

  // Implicit stream-power incision, downstream first so every receiver is
  // already at its new height when its donors are solved.
  erode(climate, dt) {
    const { W, N, z, filled, rec, stack, Q, kfac, ice, ocean, eroded } = this;
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
      const K = K_FLUVIAL * kfac[i] * (ice[i] ? ICE_EROSION : 1) * (1 - VEG_HOLD * this.cover[i]);
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
    const { W, N, z, filled, rec, stack, Q, qs, eroded, ocean, fert, loose, ice } = this;
    const area = CELL_M * CELL_M;
    qs.fill(0);
    const keep = Math.exp(-dt / FERT_MEMORY_YR);
    const perCentury = 100 / dt;
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
        const sq = Math.sqrt(Q[i]);
        const cap = TRANSPORT * K_FLUVIAL * sq * slope * dt * area;
        // Loose cover goes as fast as the water can take it: limited by how
        // quickly the flow scours it, how much there is, and how much more
        // the water can carry. Roots hold it.
        // Cover on a hillside stays put under sheetwash, as rock does; only a
        // channel takes it. (Letting sand gully at smaller flows splits the
        // plain into parallel streams at short ticks but not long ones.)
        const power = ice[i] ? sq : sq - SQRT_CHANNEL_Q;
        if (power > 0 && loose[i] > 0 && cap > qs[i]) {
          const scour = LOOSE_K * K_FLUVIAL * power * slope * dt * (1 - 0.8 * this.cover[i]);
          // Never below the next cell down (or the water in it): scouring
          // sand doesn't dig pits.
          const floor = this.lake[r] ? filled[r] : zr;
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
        tmp[i] = z[i] + k * (sum / n - z[i]);
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
      const P = ROCKS[rock[i]].soil;
      loose[i] = SOIL_DEPTH_M * Math.log(Math.exp(loose[i] / SOIL_DEPTH_M) + (P * dt) / SOIL_DEPTH_M);
    }
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
