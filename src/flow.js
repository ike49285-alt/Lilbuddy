// flow.js — the river: water as a sheet with depth and momentum, the sand
// and gravel it drags along the bed, banks that slump, and the plants that
// hold them.
//
// Water: the local inertial form of the shallow-water equations (Bates et
// al. 2010) on a staggered grid. Each face between two cells carries a
// discharge per metre width, pushed by the slope of the water surface and
// held back by bed friction (Manning); each cell's depth changes by what
// flows in and out. So the water spreads, ponds, overtops its banks, swings
// round bends and splits round bars.
//
// Sand and gravel: the drag of the water on the bed moves them at rates
// that rise steeply with it (Wilcock and Crowe's formula for a mix of sand
// and gravel): gravel needs more drag than sand, but moves more easily
// among plenty of sand, and where the flow strips the sand away the bed
// left behind is coarser and harder to move (it armours). They go the way the water goes, turned toward the inside of a bend by the
// spiral flow there and pulled a little downhill by gravity; the bed rises
// where more comes in than goes out (Exner). A river cutting at the foot of
// its bank takes some of the bank with it, and any slope steeper than sand
// can stand slumps. Those two together make the outside of a bend retreat
// while a bar grows on the inside: a river that meanders.
//
// Mud: fine silt and clay ride in the water rather than along the bed. The
// pump's water brings some, and the flow picks more up wherever it drags
// hard at a muddy bed; it settles out wherever the water is slow, and
// fastest among plants. So a flood over the banks leaves mud beside the
// channel (levees) and over the floodplain, and the river's plume clears
// as it spreads into the sea. Mud binds the ground: muddy banks stand
// steeper and wear back more slowly, which tightens the bends.
//
// The ground keeps track of what it's made of: an active top layer, mixed
// by whatever moves, over the ground below it (Hirano's active layer).
//
// Time: the water has to be worked out in steps of under a second. The bed
// changes far more slowly, so each step's bed change can be multiplied by a
// factor (the morphological factor of river models): one second of water
// then stands for many seconds of sand moving. The clock runs on the bed's
// time.
//
// Only the rows' wet stretches (and a margin) are worked on: most of the
// valley is dry most of the time.

import { CELL_M } from './table.js';

const G = 9.81;
export const WET = 0.02;          // metres: shallower than this counts as dry
const N_BARE = 0.03;              // Manning's n on bare sand and gravel
const N_PLANT = 0.05;             // added by full grass cover
const N_TREE = 0.08;              // added by full tree cover
const CFL = 0.7;
const MAX_DT = 2;                 // seconds
const FILM = 0.1;                 // water shallower than this doesn't set the step, m
const STILL_H = 0.3;              // metres: water deeper than this in a reservoir is still water
// In still water each face's flow is blended with its neighbours' (de
// Almeida et al. 2012), keeping this much of its own: deep water with little
// friction would otherwise wobble from cell to cell.
const THETA = 0.8;
const MARGIN = 3;                 // dry cells worked on beside the water
export const SPONGE = 6;          // rows along the bottom edge where the open sea soaks up waves and sand
const BED_EVERY = 2;              // hydraulic steps between moves of the bed
const INFILTRATE = 2e-6;          // metres a second soaking into the ground
const D50 = 0.001;                // grain size for the drag index (theta), metres
const D_SAND = 0.0007, D_GRAVEL = 0.008;   // the sand's and the gravel's grain sizes, metres
const RHO = 1000, RHO_S = 2650;
const SG = ((RHO_S - RHO) / RHO) * G;      // (s − 1) g
export const SHIELDS_C = 0.047;   // the threshold Shields stress, bare
const POROSITY = 0.4;
const LA = 0.3;                   // metres: the top layer of the ground that the river mixes
const ROCK_SHIELD = 0.3;          // metres of loose ground that keep the water off the rock
const MUD_TE = 0.2;               // Pa: the drag that starts lifting mud from the bed
const MUD_PLANT = 2;              // full plant cover traps mud this many times faster
// Tunable: how hard the banks are, how much plants hold them, how far a
// step may move the bed. (An object so tests can try other values.)
export const TUNE = {
  bank: 0.3,                      // share of a channel's scour taken from a dry bank beside it
  bankK: 2e-6,                    // m/s a bank wears back per unit of Shields stress past its threshold
  bankCrit: 2.5,                  // a bank's threshold, as a multiple of the bed's (more with plants: ×(1 + 3·cover))
  growYears: 0.8,                 // years for bare ground to green over
  treeYears: 6,                   // years for trees to grow up on grassed ground
  rootHold: 0.9,                  // how much full plant cover cuts what a bank loses
  dzMax: 0.04,                    // metres: the most the bed may change in one step
  held: 0.1,                      // share of busy cells allowed to hit that limit before the bed slows
  spiral: 11,                     // how far a bend's spiral flow turns the sand inward (Engelund)
  bedSlope: 1.2,                  // how much the sand rolls downhill as it goes
  mudWs: 7e-5,                    // m/s mud settles through still water (fine silt and clay)
  slideRate: 50,                  // landslides a year from a wall at the steepest it can stand, its foot in water
  rockK: 2e-9,                    // m/s the bedrock wears per W/m² of stream power past its threshold
  rockP: 10,                      // W/m²: the stream power that starts wearing rock
  frMax: 2,                       // the fastest current a cell reports, as a multiple of its wave speed
  seaDamp: 120,                   // seconds over which currents fade out at sea (0: never)
  stillDamp: 30,                  // and in a reservoir's deep water (where the water sheet, deep and still, would otherwise wobble cell to cell)
  transport: 3,                   // scales the sand and gravel's transport (calibrated to the river before gravel)
  mudE: 1e-7,                     // m/s of mud lifted per unit of drag past its threshold, from a bed of pure mud
};
const SLOPE_WET = 0.35;           // the steepest slope sand stands at under water
const SLOPE_DRY = 0.8;            // and out of it (damp sand stands steep)
const SLUMP = 0.5;                // share of the excess that slumps each step
export const SEC_PER_YR = 3.156e7;
const PLANT_DROWN_YR = 0.4;       // years under water to drown them
const PLANT_UPROOT = 1.6;         // times the threshold stress that tears them out
const TREE_DROWN_YR = 1.5;        // trees stand floods longer
const TREE_UPROOT = 3;            // and hold on harder
const PLANT_EVERY = 16;           // steps between the plants' slow updates
// The pump's sand, when its water arrives in a reservoir backed up to it
// (which carries nothing away from the inlet): no less than what it has
// been feeding lately for the flow, learned over FEED_T years before.
const FEED_T = 0.02;
const SLUMP_ALL_EVERY = 64;       // steps between slumps over the whole valley

// Wilcock and Crowe (2003): the drag at which sand and gravel start to move
// in earnest, in pascals, by the sand's share of the surface's sand and
// gravel. More sand makes both move more easily; gravel hides less among
// coarser grains.
const WC_N = 256;
const WC_SAND = new Float64Array(WC_N + 1), WC_GRAVEL = new Float64Array(WC_N + 1);
for (let k = 0; k <= WC_N; k++) {
  const fs = k / WC_N;
  const dsm = Math.exp(fs * Math.log(D_SAND) + (1 - fs) * Math.log(D_GRAVEL));
  const trm = (0.021 + 0.015 * Math.exp(-20 * fs)) * (RHO_S - RHO) * G * dsm;
  const b = (d) => 0.67 / (1 + Math.exp(1.5 - d / dsm));
  WC_SAND[k] = trm * (D_SAND / dsm) ** b(D_SAND);
  WC_GRAVEL[k] = trm * (D_GRAVEL / dsm) ** b(D_GRAVEL);
}
// Their transport function, of the drag over that reference. Below the
// reference it's a trickle, left out.
const WC_MIN = 1;
function wcW(phi) {
  if (phi < WC_MIN) return 0;
  const r = Math.sqrt(phi);
  if (phi < 1.35) { const p2 = phi * phi; return 0.002 * p2 * p2 * p2 * phi * r; }
  const t = 1 - 0.894 / r;
  return 14 * t * t * t * t * Math.sqrt(t);
}

// A number in [0, 1) from a step and a cell, the same every time.
function dice(step, i) {
  let a = (step * 0x9e3779b1) ^ (i * 0x85ebca77);
  a = Math.imul(a ^ (a >>> 16), 0x7feb352d);
  a = Math.imul(a ^ (a >>> 15), 0x846ca68b);
  return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
}

// The water's and the bed's constants, for the river on the GPU
// (gpuflow.js, gpuriver.js).
export const WATER = { G, FILM, N_BARE, N_PLANT, N_TREE, INFILTRATE, CFL, MAX_DT, STILL_H, THETA };
export const BEDK = {
  D50, RHO, RHO_S, SG, POROSITY, LA, ROCK_SHIELD, MUD_TE, MUD_PLANT, SLOPE_WET, SLOPE_DRY, SLUMP,
  PLANT_DROWN_YR, PLANT_UPROOT, TREE_DROWN_YR, TREE_UPROOT, PLANT_EVERY, BED_EVERY, WC_N, WC_MIN, WC_SAND, WC_GRAVEL,
  FEED_T,
};

// Cube roots by table: Math.cbrt is slow and is needed for every wet face.
const CB_STEP = 1024, CB_N = 4 * CB_STEP;
const CB = new Float64Array(CB_N + 2);
for (let k = 0; k <= CB_N + 1; k++) CB[k] = Math.cbrt(k / CB_STEP);
function cbrt(v) {
  const t = v * CB_STEP;
  if (t >= CB_N) return Math.cbrt(v);
  const k = t | 0;
  return CB[k] + (CB[k + 1] - CB[k]) * (t - k);
}

export class Flow {
  constructor(table) {
    const { W, H, N } = table;
    this.W = W; this.H = H; this.N = N;
    this.dx = CELL_M;
    this.z = table.z;
    this.rock = table.rock;
    this.cover = table.cover;                 // grass, 0..1
    this.trees = table.trees || new Float32Array(N);   // trees, 0..1
    this.noTrees = new Uint8Array(N);         // kept clear of trees (fields)
    this.still = new Uint8Array(N);           // a dam's reservoir (its deep water's currents fade, as at sea)
    this.placed = new Uint8Array(N);          // rock put down by hand (blocks, piers): stays when the bedrock moves
    this.z0 = Float32Array.from(table.z);   // the bed at the start, for cut and fill
    this.h = new Float32Array(N);
    this.qx = new Float32Array((W + 1) * H);  // face left of cell (x, y): index y·(W+1) + x
    this.qy = new Float32Array(W * (H + 1));  // face above cell (x, y): index y·W + x
    this.ux = new Float32Array(N);            // velocity at cell centres
    this.uy = new Float32Array(N);
    this.sx = new Float32Array(N);            // sand carried per metre width, m²/s
    this.sy = new Float32Array(N);
    this.theta = new Float32Array(N);         // Shields stress
    this.dz = new Float32Array(N);
    this.dzRate = new Float32Array(N);        // recent bed change, metres a year (smoothed)
    this.fx = new Float32Array((W + 1) * H);  // sand through faces this step, m²/s
    this.fy = new Float32Array(W * (H + 1));
    this.avail = new Float32Array(N);
    this.clip = new Float32Array(N);
    // (Doubles: the ground below is metres thick, and its make-up changes by tiny amounts.)
    this.fm = table.mud ? Float64Array.from(table.mud) : new Float64Array(N);  // mud share of the top layer
    this.sm = Float64Array.from(this.fm);     // and of the ground below it
    this.M = new Float32Array(N);             // mud in the water, metres of it (as solid) per unit area
    this.C = new Float32Array(N);             // its concentration, by volume (scratch)
    this.dzM = new Float32Array(N);           // the mud in this step's bed change
    this.fg = table.gravel ? Float64Array.from(table.gravel) : new Float64Array(N);  // gravel share of the top layer
    this.sg = Float64Array.from(this.fg);     // and of the ground below it
    this.dzG = new Float32Array(N);           // the gravel in this step's bed change
    this.gs = new Float32Array(N);            // gravel's share of what each cell's flow carries along the bed
    this.slideYears = 0;                      // bed-years since walls were last checked for landslides
    this.slides = 0;                          // landslides in all
    this.slidAt = [];                         // where they've happened since the sim last looked
    this.rockWorn = 0;                        // bedrock worn into gravel, m³ (as solid) in all
    this.gravelIn = 0;                        // gravel pumped in and out to sea, m³ in all (bed time)
    this.gravelOut = 0;
    this.mudIn = 0;                           // the pump water's mud, by volume
    this.mudFed = 0;                          // mud in all, m³ (water time): pumped in,
    this.mudOut = 0;                          // out to sea,
    this.mudDown = 0;                         // and settled less lifted
    this.mudLaid = 0;                         // mud laid down in the ground in all, m³ (bed time)
    this.mudSea = 0;                          // mud out to sea in all, m³ (bed time)
    this.mudMark = 0;                         // mudOut when the bed last moved
    this.mNow = 1;                            // the bed-time factor in use, adapting
    this.lo = new Int32Array(H);              // each row's worked-on stretch, cells
    this.hi = new Int32Array(H);
    this.wetLo = new Int32Array(H);
    this.wetHi = new Int32Array(H);
    this.dt = 0.2;                            // the next hydraulic step, seconds
    this.sea = 0;
    this.inflow = 15;                         // m³/s pumped in at the top
    this.inletX = W / 2;
    this.seaY = (table.shoreY || H) + 12;    // past here, the open sea
    this.inletHalf = 4;
    this.supply = 0.6;                        // sand fed in, as a share of what the inflow can carry
    this.sediment = true;
    this.rainRate = 0;                        // metres a second
    this.fedIn = 0;                           // sand pumped in, m³ in all
    this.feedEma = 0;                         // what the pump's sand has been lately, per unit of supply and of inflow
    this.feedGs = 0;                          // and gravel's share of it
    this.toSea = 0;                           // sand out past the bottom edge, m³ in all
    this.morph = 1;                           // the bed-time factor of the last step
    this.growth = 1;                          // how fast plants grow now (0 in winter)
    this.steps = 0;
    this.plantYears = 0;
    this.slumpAll = true;
    this.waterTime = 0;                       // hydraulic seconds since the bed last moved
    for (let i = 0; i < N; i++) this.h[i] = Math.max(0, this.sea - this.z[i]);
    this.ranges();
  }

  // Each row's stretch to work on: wherever it or the rows beside it are
  // wet, and a margin. The inlet's cells always are.
  ranges() {
    const { W, H, h, wetLo, wetHi, lo, hi } = this;
    for (let y = 0; y < H; y++) {
      let a = W, b = -1;
      const row = y * W;
      for (let x = 0; x < W; x++) if (h[row + x] > WET) { if (x < a) a = x; b = x; }
      wetLo[y] = a; wetHi[y] = b;
    }
    this.spread();
  }

  spread() {
    const { W, H, wetLo, wetHi, lo, hi } = this;
    const ix0 = Math.round(this.inletX - this.inletHalf), ix1 = Math.round(this.inletX + this.inletHalf);
    for (let y = 0; y < H; y++) {
      let a = wetLo[y], b = wetHi[y];
      if (y > 0) { if (wetLo[y - 1] < a) a = wetLo[y - 1]; if (wetHi[y - 1] > b) b = wetHi[y - 1]; }
      if (y < H - 1) { if (wetLo[y + 1] < a) a = wetLo[y + 1]; if (wetHi[y + 1] > b) b = wetHi[y + 1]; }
      if (y === 0) { if (ix0 < a) a = ix0; if (ix1 > b) b = ix1; }
      if (b < a) { lo[y] = 0; hi[y] = -1; continue; }
      lo[y] = Math.max(0, a - MARGIN);
      hi[y] = Math.min(W - 1, b + MARGIN);
    }
  }

  // One hydraulic step, with the bed's time running up to `morph` times
  // faster. Returns the bed-time it stood for, in seconds.
  step(morph) {
    // The river on the GPU (gpuriver.js) instead, if it's there.
    if (this.gpu) return this.gpu.step(this, morph);
    const dt = this.dt;
    this.water(dt);
    this.steps++;
    if (!this.sediment) { this.morph = 1; return dt; }
    this.waterTime += dt;
    if (this.steps % BED_EVERY !== 0) return 0;
    const t = this.waterTime;
    this.waterTime = 0;
    return this.bed(t, morph);
  }

  // With the river on the GPU: brings the CPU's copy up to date, for a
  // save, a tool, or handing the river back to the CPU.
  gpuSync() {
    if (!this.gpu) return;
    this.gpu.pull(this);
    this.ranges();
  }

  // --- water ------------------------------------------------------------------

  water(dt) {
    const { W, H, N, z, h, qx, qy, cover, trees, dx, lo, hi, still } = this;
    const W1 = W + 1;
    const gdt = G * dt;
    const dry = WET * 0.5;
    // With a reservoir, the faces' flows as they were, for the blend.
    const blend = this.hasStill;
    if (blend) {
      if (!this.qxOld) { this.qxOld = new Float32Array(qx.length); this.qyOld = new Float32Array(qy.length); }
      this.qxOld.set(qx); this.qyOld.set(qy);
    }
    const { qxOld, qyOld } = this;
    // Faces across x, between the cells of each row's stretch.
    for (let y = 0; y < H; y++) {
      const row = y * W, frow = y * W1;
      const a = lo[y] + 1, b = hi[y];
      for (let x = a; x <= b; x++) {
        const i = row + x - 1, j = i + 1, f = frow + x;
        const zi = z[i], zj = z[j];
        const ei = zi + h[i], ej = zj + h[j];
        const hf = (ei > ej ? ei : ej) - (zi > zj ? zi : zj);
        if (hf <= dry) { qx[f] = 0; continue; }
        const n = N_BARE + 0.5 * (N_PLANT * (cover[i] + cover[j]) + N_TREE * (trees[i] + trees[j]));
        let q = qx[f];
        if (blend && (still[i] || still[j]) && h[i] > STILL_H && h[j] > STILL_H) q = THETA * qxOld[f] + (1 - THETA) * 0.5 * (qxOld[f - 1] + qxOld[f + 1]);
        q = (q - gdt * hf * (ej - ei) / dx) / (1 + (gdt * n * n * (q < 0 ? -q : q)) / (hf * hf * cbrt(hf)));
        // No faster than critical flow, and never draining more than is there.
        if (q * q > G * hf * hf * hf) q = (q > 0 ? 1 : -1) * hf * Math.sqrt(G * hf);
        if (q > 0) { const m = (h[i] * dx * 0.25) / dt; if (q > m) q = m; } else { const m = (h[j] * dx * 0.25) / dt; if (-q > m) q = -m; }
        qx[f] = q;
      }
    }
    // Faces across y, where both rows' stretches overlap.
    for (let y = 1; y < H; y++) {
      const a = lo[y] > lo[y - 1] ? lo[y] : lo[y - 1], b = hi[y] < hi[y - 1] ? hi[y] : hi[y - 1];
      const row = y * W;
      for (let x = a; x <= b; x++) {
        const j = row + x, i = j - W;
        const zi = z[i], zj = z[j];
        const ei = zi + h[i], ej = zj + h[j];
        const hf = (ei > ej ? ei : ej) - (zi > zj ? zi : zj);
        if (hf <= dry) { qy[j] = 0; continue; }
        const n = N_BARE + 0.5 * (N_PLANT * (cover[i] + cover[j]) + N_TREE * (trees[i] + trees[j]));
        let q = qy[j];
        if (blend && (still[i] || still[j]) && h[i] > STILL_H && h[j] > STILL_H) q = THETA * qyOld[j] + (1 - THETA) * 0.5 * (qyOld[j - W] + qyOld[j + W]);
        q = (q - gdt * hf * (ej - ei) / dx) / (1 + (gdt * n * n * (q < 0 ? -q : q)) / (hf * hf * cbrt(hf)));
        if (q * q > G * hf * hf * hf) q = (q > 0 ? 1 : -1) * hf * Math.sqrt(G * hf);
        if (q > 0) { const m = (h[i] * dx * 0.25) / dt; if (q > m) q = m; } else { const m = (h[j] * dx * 0.25) / dt; if (-q > m) q = -m; }
        qy[j] = q;
      }
    }
    // The pump: the inflow spread over the inlet cells along the top edge.
    const x0 = Math.max(0, Math.round(this.inletX - this.inletHalf)), x1 = Math.min(W - 1, Math.round(this.inletX + this.inletHalf));
    const qin = this.inflow / ((x1 - x0 + 1) * dx);
    for (let x = 0; x < W; x++) qy[x] = x >= x0 && x <= x1 ? qin : 0;
    // Depths; the new wet stretches; and the fastest wave, for the next step.
    const k = dt / dx;
    const rr = this.rainRate * dt;
    const soak = INFILTRATE * dt;
    let deepest = 0, fastest = 0;
    const { ux, uy, wetLo, wetHi, M, C } = this;
    const sea = this.sea, spongeY = H - SPONGE;
    // The mud's concentration before the water moves; the pump's water
    // brings its own.
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = lo[y]; x <= hi[y]; x++) { const i = row + x; C[i] = h[i] > 1e-4 ? M[i] / h[i] : 0; }
    }
    const cin = this.mudIn;
    let fed = 0, out = 0;
    // Out at sea, past the river's mouth, and in a reservoir's deep water,
    // currents fade over a couple of minutes, so they don't slosh.
    const seaY = this.seaY, seaDamp = TUNE.seaDamp > 0 ? 1 - dt / TUNE.seaDamp : 1, deepSea = sea - 0.3;
    const stillDamp = TUNE.stillDamp > 0 ? 1 - dt / TUNE.stillDamp : 1;
    const frMax = TUNE.frMax;
    for (let y = 0; y < H; y++) {
      const row = y * W, frow = y * W1;
      const a = lo[y], b = hi[y];
      let wa = W, wb = -1;
      for (let x = a; x <= b; x++) {
        const i = row + x;
        // Faces at the stretch's ends carry nothing (their cells are dry).
        const qL = x > a ? qx[frow + x] : 0, qR = x < b ? qx[frow + x + 1] : 0;
        const qT = y > 0 && (x < lo[y - 1] || x > hi[y - 1]) ? 0 : qy[i];
        const qB = y < H - 1 && (x < lo[y + 1] || x > hi[y + 1]) ? 0 : (y < H - 1 ? qy[i + W] : 0);
        let d = h[i] + k * (qL - qR + qT - qB) + rr;
        d -= d < soak ? d : soak;
        if (d < 0) d = 0;
        // The mud goes with the water, at the concentration of the cell it
        // comes from. (No face takes more than a quarter of a cell's water,
        // so no cell gives more mud than it has.)
        const ci = C[i];
        let m = M[i];
        if (qL !== 0) m += k * qL * (qL > 0 ? C[i - 1] : ci);
        if (qR !== 0) m -= k * qR * (qR > 0 ? ci : C[i + 1]);
        if (qT !== 0) {
          const ct = qT > 0 ? (y > 0 ? C[i - W] : cin) : ci;
          m += k * qT * ct;
          if (y === 0) fed += k * qT * ct * dx * dx;
        }
        if (qB !== 0) m -= k * qB * (qB > 0 ? ci : C[i + W]);
        if (m < 0) m = 0;
        if ((y > seaY && z[i] < deepSea) || (still[i] && h[i] > STILL_H)) {
          const damp = still[i] && h[i] > STILL_H ? stillDamp : seaDamp;
          if (x > a) qx[frow + x] *= damp;
          qy[i] *= damp;
        }
        if (y >= spongeY) {
          // The open sea: the level relaxes to the sea's, the currents die
          // away, and it takes the mud away.
          const w = (y - spongeY + 1) / SPONGE;
          const level = sea > z[i] ? sea - z[i] : 0;
          d += (level - d) * w * 0.5;
          const damp = 1 - 0.5 * w;
          if (x > a) qx[frow + x] *= damp;
          qy[i] *= damp;
          const gone = m * w * 0.5;
          m -= gone;
          out += gone * dx * dx;
        }
        h[i] = d;
        M[i] = m;
        if (d > WET) {
          if (x < wa) wa = x;
          wb = x;
          let u = (qL + qR) / (2 * d), v = (qT + qB) / (2 * d);
          if (d > deepest) deepest = d;
          if (d > FILM) {
            // A cell all but drained between full neighbours can report a
            // current many times its wave speed for a step or two; no river
            // runs like that, so it's held to frMax times it, for the step
            // and for what the bed feels.
            const m = frMax * Math.sqrt(G * d);
            if (u > m) u = m; else if (u < -m) u = -m;
            if (v > m) v = m; else if (v < -m) v = -m;
            const s = (u < 0 ? -u : u) + (v < 0 ? -v : v);
            if (s > fastest) fastest = s;
          } else {
            // A thin film's speed (flow over a tiny depth) is no guide to
            // anything: its faces are already held to what it holds, so it
            // doesn't set the step, and its speed is kept to a sensible one.
            const m = 2 * Math.sqrt(G * d);
            if (u > m) u = m; else if (u < -m) u = -m;
            if (v > m) v = m; else if (v < -m) v = -m;
          }
          ux[i] = u; uy[i] = v;
        } else {
          ux[i] = 0; uy[i] = 0;
        }
      }
      wetLo[y] = wa; wetHi[y] = wb;
    }
    // The sea along the bottom edge holds its level, and is clear.
    let wa = W, wb = -1;
    for (let x = 0; x < W; x++) {
      const i = (H - 1) * W + x;
      h[i] = sea > z[i] ? sea - z[i] : 0;
      out += M[i] * dx * dx;
      M[i] = 0;
      if (h[i] > WET) { if (x < wa) wa = x; wb = x; }
    }
    if (wa < wetLo[H - 1]) wetLo[H - 1] = wa;
    if (wb > wetHi[H - 1]) wetHi[H - 1] = wb;
    this.mudFed += fed;
    this.mudOut += out;
    this.spread();
    const c = Math.sqrt(G * deepest) + fastest;
    this.dt = Math.min(MAX_DT, c > 0 ? (CFL * dx) / c : MAX_DT);
  }

  // --- the bed -----------------------------------------------------------------

  // Moves sand for one hydraulic step of dt seconds, sped up by up to
  // `morph` (less if the bed would change too fast). Returns the bed-time,
  // seconds.
  bed(dt, morph) {
    const { W, H, z, h, ux, uy, sx, sy, theta, cover, trees, rock, dx, fx, fy, dz, avail, lo, hi, fm, dzM, fg, dzG, gs } = this;
    const W1 = W + 1;
    const shieldsK = 1 / (((RHO_S - RHO) / RHO) * G * D50);
    const tauK = (RHO_S - RHO) * G * D50;      // Pa per unit of theta
    const qK = TUNE.transport / SG;
    // The bed is worked on down to the open sea, which swallows what reaches it.
    const HB = H - SPONGE;
    // Transport at cell centres.
    for (let y = 0; y < HB; y++) {
      const a = lo[y], b = hi[y];
      for (let x = a; x <= b; x++) {
        const i = y * W + x;
        const d = h[i];
        sx[i] = 0; sy[i] = 0; theta[i] = 0; gs[i] = 0;
        if (d <= WET * 2) continue;
        const u = ux[i], v = uy[i];
        const U2 = u * u + v * v;
        if (U2 < 1e-6) continue;
        const n = N_BARE + N_PLANT * cover[i] + N_TREE * trees[i];
        const th = (n * n * U2 * shieldsK) / cbrt(d);   // τ/((ρs−ρ)gD), τ = ρ g n² U² / h^⅓
        theta[i] = th;
        // The top layer's sand and gravel move, each by its own share of
        // the surface (Wilcock and Crowe). Plants hold them, and so does mud
        // once there's enough of it to bind them.
        const f = fm[i], coarse = 1 - f;
        if (coarse <= 0) continue;
        const Fg = fg[i] / coarse, Fs = 1 - Fg;
        const hold = (1 + 2 * cover[i] + 3 * trees[i]) * (f > 0.3 ? 1 + 3 * (f - 0.3) / 0.7 : 1);
        const tau = th * tauK;
        const kf = (Fs < 0 ? 0 : Fs > 1 ? 1 : Fs) * WC_N, k0 = kf | 0, k1 = k0 < WC_N ? k0 + 1 : k0, w = kf - k0;
        const rs = (WC_SAND[k0] + (WC_SAND[k1] - WC_SAND[k0]) * w) * hold;
        if (tau < rs * WC_MIN) continue;      // the sand, more mobile, barely stirs: neither moves
        const rg = (WC_GRAVEL[k0] + (WC_GRAVEL[k1] - WC_GRAVEL[k0]) * w) * hold;
        const us3 = (tau / RHO) * Math.sqrt(tau / RHO);
        const qsand = wcW(tau / rs) * Fs * coarse * us3 * qK;
        const qgrav = wcW(tau / rg) * Fg * coarse * us3 * qK;
        const qs = qsand + qgrav;
        if (qs <= 0) continue;
        gs[i] = qgrav / qs;
        const U = Math.sqrt(U2);
        const ex2 = u / U, ey2 = v / U;
        // Spiral flow turns the sand toward the inside of the bend.
        const xm = x > 0 ? i - 1 : i, xp = x < W - 1 ? i + 1 : i;
        const ym = y > 0 ? i - W : i, yp = y < H - 1 ? i + W : i;
        const ddx = 1 / ((xp - xm) * dx), ddy = 1 / ((((yp - ym) / W) | 0) * dx);
        const dudx = (ux[xp] - ux[xm]) * ddx, dudy = (ux[yp] - ux[ym]) * ddy;
        const dvdx = (uy[xp] - uy[xm]) * ddx, dvdy = (uy[yp] - uy[ym]) * ddy;
        const kappa = (u * (u * dvdx + v * dvdy) - v * (u * dudx + v * dudy)) / (U2 * U);
        let t = TUNE.spiral * d * kappa;
        if (t > 0.6) t = 0.6; else if (t < -0.6) t = -0.6;
        const c = 1 / Math.sqrt(1 + t * t), s = t * c;
        const rx = ex2 * c - ey2 * s, ry = ex2 * s + ey2 * c;
        // And gravity pulls it a little downhill.
        const gx = (z[xp] - z[xm]) * ddx, gy = (z[yp] - z[ym]) * ddy;
        const bs = TUNE.bedSlope / Math.sqrt(th > SHIELDS_C ? th : SHIELDS_C);
        sx[i] = qs * (rx - bs * gx);
        sy[i] = qs * (ry - bs * gy);
      }
    }
    // Through the faces, from the upwind cell.
    for (let y = 0; y < HB; y++) {
      const row = y * W, frow = y * W1;
      const a = lo[y], b = hi[y];
      if (a <= b) { fx[frow + a] = 0; fx[frow + b + 1] = 0; }
      for (let x = a + 1; x <= b; x++) {
        const i = row + x - 1, j = i + 1;
        const m = sx[i] + sx[j];
        fx[frow + x] = m > 0 ? (sx[i] > 0 ? sx[i] : 0) : (sx[j] < 0 ? sx[j] : 0);
      }
    }
    for (let y = 1; y < HB; y++) {
      const a = lo[y] > lo[y - 1] ? lo[y] : lo[y - 1], b = hi[y] < hi[y - 1] ? hi[y] : hi[y - 1];
      // Outside the overlap, nothing crosses.
      for (let x = Math.min(lo[y], lo[y - 1]); x < a; x++) fy[y * W + x] = 0;
      for (let x = b + 1; x <= Math.max(hi[y], hi[y - 1]); x++) fy[y * W + x] = 0;
      for (let x = a; x <= b; x++) {
        const j = y * W + x, i = j - W;
        const m = sy[i] + sy[j];
        fy[j] = m > 0 ? (sy[i] > 0 ? sy[i] : 0) : (sy[j] < 0 ? sy[j] : 0);
      }
    }
    // The pump's sand comes in with its water; the sea takes what goes out.
    // Water arriving drowned carries what the pump has been feeding lately.
    const x0 = Math.max(0, Math.round(this.inletX - this.inletHalf)), x1 = Math.min(W - 1, Math.round(this.inletX + this.inletHalf));
    const feed = this.supply * this.inflow;
    let local = 0, inLake = 0;
    for (let x = x0; x <= x1; x++) { local += this.supply * Math.max(0, sy[x]); inLake += this.still[x]; }
    const lake = 2 * inLake > x1 - x0 + 1;
    const least = this.feedEma * feed;
    const drowned = lake && local < least;
    for (let x = 0; x < W; x++) fy[x] = x >= x0 && x <= x1 ? (drowned ? least / (x1 - x0 + 1) : this.supply * Math.max(0, sy[x])) : 0;
    for (let x = 0; x < W; x++) { const i = (HB - 1) * W + x; fy[HB * W + x] = x >= lo[HB - 1] && x <= hi[HB - 1] ? Math.max(0, sy[i]) : 0; }
    // How fast the bed may change: the factor creeps up toward what's asked
    // while few cells would change too fast in one step, and backs off when
    // many would. The few that still would are held to the limit (their
    // faces carry less), so a scour hole deepens no faster than the bed can
    // follow, and no sand is made or lost.
    if (this.mNow > morph) this.mNow = morph;
    const mdt = dt * this.mNow;
    const per = 1 / ((1 - POROSITY) * dx);
    const clip = this.clip;
    const dzMax = TUNE.dzMax;
    let busy = 0, held = 0;
    for (let y = 0; y < HB; y++) {
      const row = y * W, frow = y * W1;
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = row + x;
        const fl = fx[frow + x], fr = fx[frow + x + 1], ft = fy[i], fb = fy[i + W];
        const out = (fl < 0 ? -fl : 0) + (fr > 0 ? fr : 0) + (ft < 0 ? -ft : 0) + (fb > 0 ? fb : 0);
        const inn = (fl > 0 ? fl : 0) + (fr < 0 ? -fr : 0) + (ft > 0 ? ft : 0) + (fb < 0 ? -fb : 0);
        const net = inn - out;
        const change = (net < 0 ? -net : net) * per * mdt;
        let c = 1;
        if (change > 1e-6) { busy++; if (change > dzMax) { c = dzMax / change; held++; } }
        clip[i] = c;
        // No more sand out of a cell than lies above the rock.
        let r = 1;
        if (out > 0) {
          const room = z[i] - rock[i];
          const take = out * per * mdt;
          if (take > room) r = room > 0 ? room / take : 0;
        }
        avail[i] = r;
      }
    }
    if (held > busy * TUNE.held) this.mNow = Math.max(1, this.mNow * 0.8);
    else this.mNow = Math.min(morph, this.mNow * 1.05 + 0.5);
    this.morph = mdt / dt;
    for (let y = 0; y < HB; y++) {
      const frow = y * W1, row = y * W;
      for (let x = lo[y] + 1; x <= hi[y]; x++) {
        const f = frow + x, i = row + x - 1, j = i + 1;
        const v = fx[f];
        if (v === 0) continue;
        const c = clip[i] < clip[j] ? clip[i] : clip[j];
        fx[f] = v * c * (v > 0 ? avail[i] : avail[j]);
      }
    }
    for (let y = 1; y < HB; y++) {
      const a = lo[y] > lo[y - 1] ? lo[y] : lo[y - 1], b = hi[y] < hi[y - 1] ? hi[y] : hi[y - 1];
      for (let x = a; x <= b; x++) {
        const j = y * W + x, i = j - W;
        const v = fy[j];
        if (v === 0) continue;
        const c = clip[i] < clip[j] ? clip[i] : clip[j];
        fy[j] = v * c * (v > 0 ? avail[i] : avail[j]);
      }
    }
    for (let x = 0; x < W; x++) fy[x] *= clip[x];
    for (let x = lo[HB - 1]; x <= hi[HB - 1]; x++) { const i = (HB - 1) * W + x; fy[HB * W + x] *= clip[i] * avail[i]; }
    // Exner: the bed rises where more comes in than goes out.
    // The gravel through each face is its share of what the upwind cell
    // sends.
    const k = per * mdt;
    const gIn0 = drowned ? this.feedGs : -1;
    let fed = 0, lost = 0, gIn = 0, gOut = 0;
    for (let x = 0; x < W; x++) {
      fed += fy[x]; gIn += fy[x] * (gIn0 >= 0 ? gIn0 : gs[x]);
      const o = fy[HB * W + x];
      lost += o; gOut += o * gs[(HB - 1) * W + x];
    }
    // Learning what the pump feeds, while it isn't drowned.
    if (!lake && feed > 0) {
      const a = Math.min(1, mdt / (FEED_T * SEC_PER_YR));
      this.feedEma += (fed / feed - this.feedEma) * a;
      if (fed > 0) this.feedGs += (gIn / fed - this.feedGs) * a;
    }
    this.fedIn += fed * dx * mdt;
    this.toSea += lost * dx * mdt;
    this.gravelIn += gIn * dx * mdt;
    this.gravelOut += gOut * dx * mdt;
    for (let y = 0; y < HB; y++) {
      const row = y * W, frow = y * W1;
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = row + x;
        const fl = fx[frow + x], fr = fx[frow + x + 1], ft = fy[i], fb = fy[i + W];
        dz[i] = k * (fl - fr + ft - fb);
        const gl = fl * (fl > 0 ? gs[i - 1] : gs[i]);
        const gr = fr * (fr > 0 ? gs[i] : gs[i + 1]);
        const gt = ft * (ft > 0 && y > 0 ? gs[i - W] : y === 0 && gIn0 >= 0 ? gIn0 : gs[i]);
        const gb = fb * (fb > 0 ? gs[i] : gs[i + W]);
        dzG[i] = k * (gl - gr + gt - gb);
        dzM[i] = 0;
      }
    }
    for (let i = HB * W; i < this.N; i++) { dz[i] = 0; dzM[i] = 0; dzG[i] = 0; }
    // Mud settles out of the water and is lifted from the bed. In the
    // water's time; the bed's change is sped up like the sand's.
    this.mudExchange(dt, mdt, HB, dzMax);
    // A channel scouring at the foot of a dry bank takes some of the bank.
    for (let y = 0; y < HB; y++) {
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = y * W + x;
        const e = -dz[i];
        if (e <= 0 || h[i] <= WET) continue;
        const zi = z[i];
        const l = x > 0 && h[i - 1] <= WET && z[i - 1] > zi;
        const r = x < W - 1 && h[i + 1] <= WET && z[i + 1] > zi;
        const u = y > 0 && h[i - W] <= WET && z[i - W] > zi;
        const d = y < HB - 1 && h[i + W] <= WET && z[i + W] > zi;
        const n = (l ? 1 : 0) + (r ? 1 : 0) + (u ? 1 : 0) + (d ? 1 : 0);
        if (!n) continue;
        const each = (TUNE.bank * e) / n;
        let moved = 0, mud = 0, grav = 0;
        for (let q = 0; q < 4; q++) {
          const j = q === 0 ? (l ? i - 1 : -1) : q === 1 ? (r ? i + 1 : -1) : q === 2 ? (u ? i - W : -1) : (d ? i + W : -1);
          if (j < 0) continue;
          const roots = cover[j] + 2 * trees[j];
          const want = (each * (1 - TUNE.rootHold * (roots < 1 ? roots : 1))) / (1 + 2 * fm[j]);
          const room = z[j] + dz[j] - rock[j];
          const t = want < room ? want : room > 0 ? room : 0;
          dz[j] -= t;
          dzM[j] -= t * fm[j];
          dzG[j] -= t * fg[j];
          moved += t;
          mud += t * fm[j];
          grav += t * fg[j];
        }
        dz[i] += moved;
        dzM[i] += mud;
        dzG[i] += grav;
      }
    }
    // And the flow wears at its banks directly, hardest where it drags
    // hardest: the outsides of bends. What falls in joins the bed.
    const bankK = TUNE.bankK * mdt;
    if (bankK > 0) {
      for (let y = 1; y < HB - 1; y++) {
        for (let x = Math.max(1, lo[y]); x <= Math.min(W - 2, hi[y]); x++) {
          const i = y * W + x;
          if (h[i] <= WET) continue;
          const th = theta[i];
          if (th <= SHIELDS_C * TUNE.bankCrit) continue;
          const zi = z[i] + dz[i];
          for (let q = 0; q < 4; q++) {
            const j = q === 0 ? i - 1 : q === 1 ? i + 1 : q === 2 ? i - W : i + W;
            if (h[j] > WET) continue;
            const ex = th - SHIELDS_C * TUNE.bankCrit * (1 + 3 * cover[j] + 6 * trees[j]) * (1 + 4 * fm[j]);
            if (ex <= 0) continue;
            const top = z[j] + dz[j];
            const room = top - (zi > rock[j] ? zi : rock[j]);
            if (room <= 0) continue;
            const roots = cover[j] + 2 * trees[j];
            let m = bankK * ex * (1 - TUNE.rootHold * (roots < 1 ? roots : 1));
            if (m > room) m = room;
            if (m > dzMax) m = dzMax;
            dz[j] -= m;
            dz[i] += m;
            dzM[j] -= m * fm[j];
            dzM[i] += m * fm[j];
            dzG[j] -= m * fg[j];
            dzG[i] += m * fg[j];
          }
        }
      }
    }
    const years = mdt / SEC_PER_YR;
    const keep = Math.exp(-years / 0.05);
    const rate = years > 0 ? (1 - keep) / years : 0;
    const { dzRate, sm, sg } = this;
    for (let y = 0; y < H; y++) {
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = y * W + x;
        const d = dz[i], dm = dzM[i], dgr = dzG[i];
        if (d !== 0 || dm !== 0 || dgr !== 0) {
          // The top layer's make-up (as mix(), inline: this runs for every busy cell).
          const f = fm[i], g = fg[i];
          let nf, ng;
          if (d >= 0) {
            nf = (f * LA + dm) / (LA + d);
            ng = (g * LA + dgr) / (LA + d);
            let below = z[i] - rock[i] - LA;
            if (below < 0) below = 0;
            if (below + d > 0) {
              sm[i] = (sm[i] * below + (nf < 0 ? 0 : nf > 1 ? 1 : nf) * d) / (below + d);
              sg[i] = (sg[i] * below + (ng < 0 ? 0 : ng > 1 ? 1 : ng) * d) / (below + d);
            }
          } else if (-d >= LA) {
            nf = sm[i]; ng = sg[i];
          } else {
            nf = (f * LA + dm - sm[i] * d) / LA;
            ng = (g * LA + dgr - sg[i] * d) / LA;
          }
          nf = nf < 0 ? 0 : nf > 1 ? 1 : nf;
          ng = ng < 0 ? 0 : ng > 1 - nf ? 1 - nf : ng;
          fm[i] = nf; fg[i] = ng;
        }
        z[i] += d;
        dzRate[i] = dzRate[i] * keep + rate * d;
      }
    }
    this.wearRock(mdt, HB, dzMax);
    this.slideYears += years;
    if (this.slumpAll || this.steps % SLUMP_ALL_EVERY === 0) {
      this.landslides(this.slideYears);
      this.slideYears = 0;
      this.slump(true);
      this.slumpAll = false;
    } else this.slump(false);
    this.plants(years, mdt);
    return mdt;
  }

  // Walls that fail: a dry wall standing two metres or more over the water
  // may give way all at once, the likelier the taller it is and the nearer
  // its face is to as steep as it can stand. A patch of it drops to the
  // slope wet sand stands at, and what falls lands in the river at its
  // foot, plants and all. Rock doesn't fall. (The dice are a hash of the
  // step and the cell, so a restored world has the same landslides.)
  landslides(years) {
    if (years <= 0) return;
    const { W, H, z, h, rock, cover, trees, fm, fg, placed, dx } = this;
    const HB = H - SPONGE;
    for (let y = 2; y < HB - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (h[i] > WET || placed[i]) continue;
        // The wall's foot: the lowest wet cell within two.
        let j = -1, jd = 0;
        for (let yy = y - 2; yy <= y + 2; yy++) {
          for (let xx = x - 2; xx <= x + 2; xx++) {
            const n = yy * W + xx;
            if (h[n] > WET && (j < 0 || z[n] < z[j])) { j = n; jd = Math.hypot(xx - x, yy - y); }
          }
        }
        if (j < 0) continue;
        const height = z[i] - z[j];
        if (height < 2) continue;
        const stand = SLOPE_DRY * (1 + cover[i] + trees[i]) * (1 + 0.5 * fm[i]);
        let r = (height / (jd * dx) / stand - 0.5) / 0.5;
        if (r <= 0) continue;
        if (r > 1) r = 1;
        const p = 1 - Math.exp(-TUNE.slideRate * years * r * r * Math.min(1, height / 5));
        if (dice(this.steps, i) >= p) continue;
        // The patch: dry ground within two cells, above the foot.
        const jx = j % W, jy = (j / W) | 0;
        let vol = 0, mud = 0, grav = 0;
        for (let yy = y - 2; yy <= y + 2; yy++) {
          for (let xx = x - 2; xx <= x + 2; xx++) {
            const k = yy * W + xx;
            if (h[k] > WET || placed[k]) continue;
            const target = Math.max(rock[k], z[j] + SLOPE_WET * dx * Math.hypot(xx - jx, yy - jy));
            const a = z[k] - target;
            if (a <= 0.05) continue;
            mud += a * fm[k]; grav += a * fg[k]; vol += a;
            this.mix(k, -a, -a * fm[k], -a * fg[k]);
            z[k] -= a;
            cover[k] = 0;
            trees[k] = 0;
          }
        }
        if (vol <= 0) continue;
        // It lands at the foot and spreads to the wet cells beside it.
        const toes = [j];
        for (const n of [j - 1, j + 1, j - W, j + W]) if (n !== i && h[n] > WET && toes.length < 3) toes.push(n);
        const each = vol / toes.length;
        for (const t of toes) { this.mix(t, each, (each * mud) / vol, (each * grav) / vol); z[t] += each; }
        this.slides++;
        this.slidAt.push(i);
      }
    }
  }

  // Bare bedrock under flowing water wears away by the water's power
  // (stream power: drag times speed), fastest where the bed steps down
  // steeply, a waterfall's lip, where blocks are plucked away. A little loose
  // ground over it shields it. What's worn off becomes gravel in the ground
  // above it, bulked up by the room between the stones. Rock put down by
  // hand doesn't wear.
  wearRock(mdt, HB, dzMax) {
    const { W, z, h, rock, placed, theta, ux, uy, fg, fm, sg, sm, lo, hi, dx } = this;
    const tauK = (RHO_S - RHO) * G * D50;
    const k = TUNE.rockK, pc = TUNE.rockP, bulk = 1 / (1 - POROSITY);
    let worn = 0;
    for (let y = 1; y < HB - 1; y++) {
      for (let x = Math.max(1, lo[y]); x <= Math.min(W - 2, hi[y]); x++) {
        const i = y * W + x;
        if (h[i] <= WET || placed[i]) continue;
        const S = z[i] - rock[i];
        if (S >= ROCK_SHIELD) continue;
        const power = theta[i] * tauK * Math.sqrt(ux[i] * ux[i] + uy[i] * uy[i]);
        if (power <= pc) continue;
        // How steeply the bed drops away from here.
        const zi = z[i];
        let drop = 0;
        for (const j of [i - 1, i + 1, i - W, i + W]) { const d = zi - z[j]; if (d > drop) drop = d; }
        let dr = k * (power - pc) * (1 + drop / dx / 0.1) * (1 - S / ROCK_SHIELD) * mdt;
        if (dr > dzMax) dr = dzMax;
        if (dr <= 0) continue;
        // The rock drops; the gravel it makes, bulked, sits above it.
        const v = dr * bulk;
        if (S >= LA) {
          const below = S - LA;
          sg[i] = (sg[i] * below + v) / (below + v);
          sm[i] = (sm[i] * below) / (below + v);
        } else {
          const s = S > 0 ? S : 0;
          fg[i] = (fg[i] * s + v) / (s + v);
          fm[i] = (fm[i] * s) / (s + v);
          sg[i] = fg[i]; sm[i] = fm[i];
        }
        rock[i] -= dr;
        z[i] += v - dr;
        worn += dr * dx * dx;
      }
    }
    this.rockWorn += worn;
  }

  // Mud settling out of the water and lifted from the bed, over dt seconds
  // of the water's time (mdt of the bed's).
  mudExchange(dt, mdt, HB, dzMax) {
    const { W, z, h, M, fm, rock, cover, trees, theta, dz, dzM, lo, hi, dx } = this;
    const morph = mdt / dt;
    const tauK = (RHO_S - RHO) * G * D50;     // Pa per unit of Shields stress
    const bulk = 1 / (1 - POROSITY);           // metres of ground per metre of mud laid down
    const ws = TUNE.mudWs, mudE = TUNE.mudE;
    let down = 0, laid = 0;
    for (let y = 0; y < HB; y++) {
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = y * W + x;
        const d = h[i], m = M[i], f = fm[i];
        // It settles through the water, faster among plants; what's left
        // when the water's gone stays where it is.
        let dep = 0, ero = 0;
        if (m > 0) dep = d > WET ? ws * (m / d) * dt * (1 + MUD_PLANT * cover[i] + 3 * trees[i]) : m;
        if (dep > m) dep = m;
        // It's lifted where the flow drags at a muddy bed (Partheniades).
        if (f > 0 && d > WET) { const ex = (theta[i] * tauK) / MUD_TE - 1; if (ex > 0) ero = mudE * f * ex * dt; }
        if (dep === 0 && ero === 0) continue;
        let bed = (dep - ero) * morph * bulk;
        // No faster than the bed may change, and no more lifted than the top layer holds.
        if (bed > dzMax || bed < -dzMax) { const s = dzMax / (bed < 0 ? -bed : bed); dep *= s; ero *= s; bed *= s; }
        if (bed < 0) {
          let room = f * Math.min(LA, z[i] + dz[i] - rock[i]);
          if (room < 0) room = 0;
          if (-bed > room) { ero = dep + room / (morph * bulk); bed = -room; }
        }
        M[i] = m - dep + ero;
        down += (dep - ero) * dx * dx;
        dz[i] += bed;
        dzM[i] += bed;
        laid += bed * (1 - POROSITY) * dx * dx;
      }
    }
    this.mudDown += down;
    this.mudLaid += laid;
    this.mudSea += (this.mudOut - this.mudMark) * morph;
    this.mudMark = this.mudOut;
  }

  // The top layer's make-up after the ground at i rises or falls by dz, of
  // which dzM is mud. What's laid down mixes into the top layer, which
  // passes the bottom of itself to the ground below; what's taken away
  // takes the top layer's mix and lets up some of the ground below.
  mix(i, dz, dzM, dzG = 0) {
    const { fm, sm, fg, sg, z, rock } = this;
    const f = fm[i], g = fg[i];
    let nf, ng;
    if (dz >= 0) {
      nf = (f * LA + dzM) / (LA + dz);
      ng = (g * LA + dzG) / (LA + dz);
      const below = Math.max(0, z[i] - rock[i] - LA);
      if (below + dz > 0) {
        sm[i] = (sm[i] * below + (nf < 0 ? 0 : nf > 1 ? 1 : nf) * dz) / (below + dz);
        sg[i] = (sg[i] * below + (ng < 0 ? 0 : ng > 1 ? 1 : ng) * dz) / (below + dz);
      }
    } else if (-dz >= LA) {
      nf = sm[i]; ng = sg[i];
    } else {
      nf = (f * LA + dzM - sm[i] * dz) / LA;
      ng = (g * LA + dzG - sg[i] * dz) / LA;
    }
    nf = nf < 0 ? 0 : nf > 1 ? 1 : nf;
    ng = ng < 0 ? 0 : ng > 1 - nf ? 1 - nf : ng;
    fm[i] = nf; fg[i] = ng;
  }

  // Any slope steeper than sand can stand slumps toward what it can: by the
  // water every step, and over the whole valley now and then.
  slump(all) {
    const { W, H, z, h, rock, cover, dx, lo, hi } = this;
    for (let y = 0; y < H; y++) {
      const a = all ? 0 : lo[y], b = all ? W - 1 : hi[y];
      for (let x = a; x < b; x++) this.pair(y * W + x, y * W + x + 1, z, h, rock, cover, dx);
    }
    for (let y = 0; y < H - 1; y++) {
      const a = all ? 0 : Math.max(lo[y], lo[y + 1]), b = all ? W - 1 : Math.min(hi[y], hi[y + 1]);
      for (let x = a; x <= b; x++) this.pair(y * W + x, (y + 1) * W + x, z, h, rock, cover, dx);
    }
  }

  pair(i, j, z, h, rock, cover, dx) {
    const d = z[i] - z[j];
    const a = d > 0 ? d : -d;
    if (a <= SLOPE_WET * dx) return;
    const hi = d > 0 ? i : j, lo = d > 0 ? j : i;
    const wet = h[hi] > WET || h[lo] > WET;
    // Mud lets a bank stand steeper; roots too.
    const fh = this.fm[hi], gh = this.fg[hi];
    const crit = (wet ? SLOPE_WET * (1 + fh) : SLOPE_DRY * (1 + 0.5 * fh)) * (1 + this.cover[hi] + this.trees[hi]) * dx;
    if (a <= crit) return;
    let m = ((a - crit) / 2) * SLUMP;
    const room = z[hi] - rock[hi];
    if (m > room) m = room > 0 ? room : 0;
    if (m <= 0) return;
    this.mix(hi, -m, -m * fh, -m * gh);
    this.mix(lo, m, m * fh, m * gh);
    z[hi] -= m;
    z[lo] += m;
  }

  // Plants green dry ground over a year or two, drown under standing water,
  // and are torn out where the flow drags hard at them.
  plants(years, mdt) {
    const { W, H, h, cover, trees, theta, dz, lo, hi } = this;
    const drown = Math.min(1, years / PLANT_DROWN_YR), drownT = Math.min(1, years / TREE_DROWN_YR);
    const rip = Math.min(1, mdt / 3600);
    for (let y = 0; y < H; y++) {
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = y * W + x;
        if (h[i] <= WET) continue;
        let c = cover[i], t = trees[i];
        if (c > 0) {
          if (h[i] > 0.3) c -= c * drown;
          if (theta[i] > PLANT_UPROOT * SHIELDS_C * (1 + 2 * c)) c -= c * rip;
          if (dz[i] < -0.002) c *= 0.5;
          cover[i] = c < 1e-3 ? 0 : c;
        }
        if (t > 0) {
          if (h[i] > 0.3) t -= t * drownT;
          if (theta[i] > TREE_UPROOT * SHIELDS_C * (1 + 2 * c + 3 * t)) t -= t * rip;
          if (dz[i] < -0.01) t *= 0.5;
          trees[i] = t < 1e-3 ? 0 : t;
        }
      }
    }
    // Growth, over the whole valley now and then.
    this.plantYears += years;
    if (this.steps % PLANT_EVERY !== 0) return;
    const yrs = this.plantYears;
    this.plantYears = 0;
    const grow = Math.min(1, (this.growth * yrs) / TUNE.growYears);
    if (grow <= 0) return;
    const N = this.N;
    // Trees come up slowly on ground that's already grassed (not in fields).
    const growT = Math.min(1, (this.growth * yrs) / TUNE.treeYears);
    for (let i = 0; i < N; i++) {
      if (h[i] > WET) continue;
      if (cover[i] < 1) cover[i] += (1 - cover[i]) * grow;
      if (cover[i] > 0.5 && trees[i] < 1 && !this.noTrees[i]) trees[i] += (1 - trees[i]) * growT * (cover[i] - 0.5) * 2;
    }
  }
}
