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
// Sand: the drag of the water on the bed (Shields stress) moves sand at a
// rate that rises steeply once it passes a threshold (Meyer-Peter Müller).
// It goes the way the water goes, turned toward the inside of a bend by the
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
const N_PLANT = 0.05;             // added by full plant cover
const CFL = 0.7;
const MAX_DT = 2;                 // seconds
const FILM = 0.1;                 // water shallower than this doesn't set the step, m
const MARGIN = 3;                 // dry cells worked on beside the water
export const SPONGE = 6;          // rows along the bottom edge where the open sea soaks up waves and sand
const BED_EVERY = 2;              // hydraulic steps between moves of the bed
const INFILTRATE = 2e-6;          // metres a second soaking into the ground
const D50 = 0.001;                // grain size, metres (coarse sand)
const RHO = 1000, RHO_S = 2650;
export const SHIELDS_C = 0.047;   // the threshold Shields stress, bare
const MPM = 8 * Math.sqrt(((RHO_S - RHO) / RHO) * G * D50 ** 3);
const TRANSPORT = 0.5;            // scales the transport rate (calibration)
const POROSITY = 0.4;
const LA = 0.3;                   // metres: the top layer of the ground that the river mixes
const MUD_TE = 0.2;               // Pa: the drag that starts lifting mud from the bed
const MUD_PLANT = 2;              // full plant cover traps mud this many times faster
// Tunable: how hard the banks are, how much plants hold them, how far a
// step may move the bed. (An object so tests can try other values.)
export const TUNE = {
  bank: 0.3,                      // share of a channel's scour taken from a dry bank beside it
  bankK: 2e-6,                    // m/s a bank wears back per unit of Shields stress past its threshold
  bankCrit: 2.5,                  // a bank's threshold, as a multiple of the bed's (more with plants: ×(1 + 3·cover))
  growYears: 0.8,                 // years for bare ground to green over
  rootHold: 0.9,                  // how much full plant cover cuts what a bank loses
  dzMax: 0.04,                    // metres: the most the bed may change in one step
  held: 0.1,                      // share of busy cells allowed to hit that limit before the bed slows
  spiral: 11,                     // how far a bend's spiral flow turns the sand inward (Engelund)
  bedSlope: 1.2,                  // how much the sand rolls downhill as it goes
  mudWs: 7e-5,                    // m/s mud settles through still water (fine silt and clay)
  mudE: 1e-7,                     // m/s of mud lifted per unit of drag past its threshold, from a bed of pure mud
};
const SLOPE_WET = 0.35;           // the steepest slope sand stands at under water
const SLOPE_DRY = 0.8;            // and out of it (damp sand stands steep)
const SLUMP = 0.5;                // share of the excess that slumps each step
export const SEC_PER_YR = 3.156e7;
const PLANT_DROWN_YR = 0.4;       // years under water to drown them
const PLANT_UPROOT = 1.6;         // times the threshold stress that tears them out
const PLANT_EVERY = 16;           // steps between the plants' slow updates
const SLUMP_ALL_EVERY = 64;       // steps between slumps over the whole valley

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
    this.cover = table.cover;
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
    this.fm = table.mud ? Float32Array.from(table.mud) : new Float32Array(N);  // mud share of the top layer
    this.sm = Float32Array.from(this.fm);     // and of the ground below it
    this.M = new Float32Array(N);             // mud in the water, metres of it (as solid) per unit area
    this.C = new Float32Array(N);             // its concentration, by volume (scratch)
    this.dzM = new Float32Array(N);           // the mud in this step's bed change
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
    this.inletHalf = 4;
    this.supply = 0.6;                        // sand fed in, as a share of what the inflow can carry
    this.sediment = true;
    this.rainRate = 0;                        // metres a second
    this.fedIn = 0;                           // sand pumped in, m³ in all
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

  // --- water ------------------------------------------------------------------

  water(dt) {
    const { W, H, N, z, h, qx, qy, cover, dx, lo, hi } = this;
    const W1 = W + 1;
    const gdt = G * dt;
    const dry = WET * 0.5;
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
        const n = N_BARE + N_PLANT * 0.5 * (cover[i] + cover[j]);
        let q = qx[f];
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
        const n = N_BARE + N_PLANT * 0.5 * (cover[i] + cover[j]);
        let q = qy[j];
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
    const { W, H, z, h, ux, uy, sx, sy, theta, cover, rock, dx, fx, fy, dz, avail, lo, hi, fm, dzM } = this;
    const W1 = W + 1;
    const shieldsK = 1 / (((RHO_S - RHO) / RHO) * G * D50);
    // The bed is worked on down to the open sea, which swallows what reaches it.
    const HB = H - SPONGE;
    // Transport at cell centres.
    for (let y = 0; y < HB; y++) {
      const a = lo[y], b = hi[y];
      for (let x = a; x <= b; x++) {
        const i = y * W + x;
        const d = h[i];
        sx[i] = 0; sy[i] = 0; theta[i] = 0;
        if (d <= WET * 2) continue;
        const u = ux[i], v = uy[i];
        const U2 = u * u + v * v;
        if (U2 < 1e-6) continue;
        const n = N_BARE + N_PLANT * cover[i];
        const th = (n * n * U2 * shieldsK) / cbrt(d);   // τ/((ρs−ρ)gD), τ = ρ g n² U² / h^⅓
        theta[i] = th;
        // Plants hold the sand, and so does mud once there's enough of it
        // to bind it; and only the top layer's sand moves.
        const f = fm[i];
        const thc = SHIELDS_C * (1 + 2 * cover[i]) * (f > 0.3 ? 1 + 3 * (f - 0.3) / 0.7 : 1);
        if (th <= thc) continue;
        const ex = th - thc;
        const qs = (1 - f) * TRANSPORT * MPM * ex * Math.sqrt(ex);
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
        const bs = TUNE.bedSlope / Math.sqrt(th);
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
    const x0 = Math.max(0, Math.round(this.inletX - this.inletHalf)), x1 = Math.min(W - 1, Math.round(this.inletX + this.inletHalf));
    for (let x = 0; x < W; x++) fy[x] = x >= x0 && x <= x1 ? this.supply * Math.max(0, sy[x]) : 0;
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
    const k = per * mdt;
    let fed = 0, lost = 0;
    for (let x = 0; x < W; x++) { fed += fy[x]; lost += fy[HB * W + x]; }
    this.fedIn += fed * dx * mdt;
    this.toSea += lost * dx * mdt;
    for (let y = 0; y < HB; y++) {
      const row = y * W, frow = y * W1;
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = row + x;
        dz[i] = k * (fx[frow + x] - fx[frow + x + 1] + fy[i] - fy[i + W]);
        dzM[i] = 0;
      }
    }
    for (let i = HB * W; i < this.N; i++) { dz[i] = 0; dzM[i] = 0; }
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
        let moved = 0, mud = 0;
        for (let q = 0; q < 4; q++) {
          const j = q === 0 ? (l ? i - 1 : -1) : q === 1 ? (r ? i + 1 : -1) : q === 2 ? (u ? i - W : -1) : (d ? i + W : -1);
          if (j < 0) continue;
          const want = (each * (1 - TUNE.rootHold * cover[j])) / (1 + 2 * fm[j]);
          const room = z[j] + dz[j] - rock[j];
          const t = want < room ? want : room > 0 ? room : 0;
          dz[j] -= t;
          dzM[j] -= t * fm[j];
          moved += t;
          mud += t * fm[j];
        }
        dz[i] += moved;
        dzM[i] += mud;
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
            const ex = th - SHIELDS_C * TUNE.bankCrit * (1 + 3 * cover[j]) * (1 + 4 * fm[j]);
            if (ex <= 0) continue;
            const top = z[j] + dz[j];
            const room = top - (zi > rock[j] ? zi : rock[j]);
            if (room <= 0) continue;
            let m = bankK * ex * (1 - TUNE.rootHold * cover[j]);
            if (m > room) m = room;
            if (m > dzMax) m = dzMax;
            dz[j] -= m;
            dz[i] += m;
            dzM[j] -= m * fm[j];
            dzM[i] += m * fm[j];
          }
        }
      }
    }
    const years = mdt / SEC_PER_YR;
    const keep = Math.exp(-years / 0.05);
    const rate = years > 0 ? (1 - keep) / years : 0;
    const { dzRate, sm } = this;
    for (let y = 0; y < H; y++) {
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = y * W + x;
        const d = dz[i], dm = dzM[i];
        if (d !== 0 || dm !== 0) {
          // The top layer's make-up (as mix(), inline: this runs for every busy cell).
          const f = fm[i];
          let nf;
          if (d >= 0) {
            nf = (f * LA + dm) / (LA + d);
            let below = z[i] - rock[i] - LA;
            if (below < 0) below = 0;
            if (below + d > 0) sm[i] = (sm[i] * below + (nf < 0 ? 0 : nf > 1 ? 1 : nf) * d) / (below + d);
          } else {
            nf = -d >= LA ? sm[i] : (f * LA + dm - sm[i] * d) / LA;
          }
          fm[i] = nf < 0 ? 0 : nf > 1 ? 1 : nf;
        }
        z[i] += d;
        dzRate[i] = dzRate[i] * keep + rate * d;
      }
    }
    if (this.slumpAll || this.steps % SLUMP_ALL_EVERY === 0) { this.slump(true); this.slumpAll = false; } else this.slump(false);
    this.plants(years, mdt);
    return mdt;
  }

  // Mud settling out of the water and lifted from the bed, over dt seconds
  // of the water's time (mdt of the bed's).
  mudExchange(dt, mdt, HB, dzMax) {
    const { W, z, h, M, fm, rock, cover, theta, dz, dzM, lo, hi, dx } = this;
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
        if (m > 0) dep = d > WET ? ws * (m / d) * dt * (1 + MUD_PLANT * cover[i]) : m;
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
  mix(i, dz, dzM) {
    const { fm, sm, z, rock } = this;
    const f = fm[i];
    let nf;
    if (dz >= 0) {
      nf = (f * LA + dzM) / (LA + dz);
      const below = Math.max(0, z[i] - rock[i] - LA);
      if (below + dz > 0) sm[i] = (sm[i] * below + (nf < 0 ? 0 : nf > 1 ? 1 : nf) * dz) / (below + dz);
    } else {
      const a = -dz;
      nf = a >= LA ? sm[i] : (f * LA + dzM + sm[i] * a) / LA;
    }
    fm[i] = nf < 0 ? 0 : nf > 1 ? 1 : nf;
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
    const fh = this.fm[hi];
    const crit = (wet ? SLOPE_WET * (1 + fh) : SLOPE_DRY * (1 + 0.5 * fh)) * (1 + cover[hi]) * dx;
    if (a <= crit) return;
    let m = ((a - crit) / 2) * SLUMP;
    const room = z[hi] - rock[hi];
    if (m > room) m = room > 0 ? room : 0;
    if (m <= 0) return;
    this.mix(hi, -m, -m * fh);
    this.mix(lo, m, m * fh);
    z[hi] -= m;
    z[lo] += m;
  }

  // Plants green dry ground over a year or two, drown under standing water,
  // and are torn out where the flow drags hard at them.
  plants(years, mdt) {
    const { W, H, h, cover, theta, dz, lo, hi } = this;
    const drown = Math.min(1, years / PLANT_DROWN_YR);
    const rip = Math.min(1, mdt / 3600);
    for (let y = 0; y < H; y++) {
      for (let x = lo[y]; x <= hi[y]; x++) {
        const i = y * W + x;
        if (h[i] <= WET) continue;
        let c = cover[i];
        if (c <= 0) continue;
        if (h[i] > 0.3) c -= c * drown;
        if (theta[i] > PLANT_UPROOT * SHIELDS_C * (1 + 2 * c)) c -= c * rip;
        if (dz[i] < -0.002) c *= 0.5;
        cover[i] = c < 1e-3 ? 0 : c;
      }
    }
    // Growth, over the whole valley now and then.
    this.plantYears += years;
    if (this.steps % PLANT_EVERY !== 0) return;
    const grow = Math.min(1, (this.growth * this.plantYears) / TUNE.growYears);
    this.plantYears = 0;
    if (grow <= 0) return;
    const N = this.N;
    for (let i = 0; i < N; i++) if (h[i] <= WET && cover[i] < 1) cover[i] += (1 - cover[i]) * grow;
  }
}
