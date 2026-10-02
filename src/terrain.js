// terrain.js — the starting surface: a freshly uplifted mountain front that
// ramps down to a coastal plain and a drowned shelf. No valleys yet; the
// river has to cut every one of them.

import { makeNoise2D, fbm } from './rng.js';

export const GRID_W = 128;
export const GRID_H = 224;
export const CELL_M = 500;           // metres per cell side
export const SHORE_ROW = 0.74;       // fraction of the height where the coast starts
export const SHELF_EDGE = 0.9;       // where the continental shelf breaks into deep water

export function generateTerrain(rng) {
  const W = GRID_W, H = GRID_H, N = W * H;
  const z = new Float64Array(N);
  const uplift = new Float32Array(N);   // metres per year
  const kfac = new Float32Array(N);     // erodibility multiplier (rock hardness)

  const rough = makeNoise2D(rng.fork('rough'));
  const strata = makeNoise2D(rng.fork('strata'));
  const ridge = makeNoise2D(rng.fork('ridge'));

  // Where the valley axis sits, wandering a little down the slope.
  const axis0 = rng.range(0.38, 0.62);
  const axisWobble = rng.range(0.05, 0.12);
  const strike = rng.range(0, 10);

  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const i = y * W + x;

      // The ramp: high at the top, coast at SHORE_ROW, shelf below.
      let base;
      if (v < SHORE_ROW) {
        const t = 1 - v / SHORE_ROW;
        base = 4 + 900 * Math.pow(t, 1.35);
      } else if (v < SHELF_EDGE) {
        const t = (v - SHORE_ROW) / (SHELF_EDGE - SHORE_ROW);
        base = -4 - 136 * t;
      } else {
        // Past the shelf break the floor drops into a deep basin, so the delta
        // can build for millions of years without filling the sea.
        const t = (v - SHELF_EDGE) / (1 - SHELF_EDGE);
        base = -140 - 1600 * Math.pow(t, 0.8);
      }
      // A gentle trough along the valley axis so drainage tends to gather.
      const axis = axis0 + axisWobble * Math.sin(v * 5.1 + axis0 * 9);
      const across = Math.abs(u - axis);
      const trough = v < SHORE_ROW
        ? (40 + 220 * (1 - v / SHORE_ROW)) * Math.pow(Math.min(1, across * 2.2), 1.3)
        : 0;
      // Low-amplitude roughness: enough to break up the ramp into many
      // competing trickles, not enough to pre-draw any valleys.
      const r = fbm(rough, u * 7, v * 12, 5) * 18 * (v < SHORE_ROW ? 1 : 0.3);
      // A ragged summit line rather than a ruler edge.
      const rr = v < 0.18 ? fbm(ridge, u * 5, 0.5, 3) * 60 * (1 - v / 0.18) : 0;
      z[i] = base + trough + r + rr;

      // Uplift: strongest along the range front, fading out by mid-valley,
      // with slight subsidence under the coast so the delta has room to build.
      // Flanking hills keep rising too, so the valley is held in place by
      // the tectonics rather than relying on the starting shape.
      const off = (v - SHORE_ROW) / (1 - SHORE_ROW);
      const range = v < 0.5 ? 0.0011 * Math.pow(1 - v / 0.5, 1.2) : 0;
      const flank = v < SHORE_ROW ? 0.00016 * Math.pow(Math.min(1, across * 2.2), 2) * (1 - 0.6 * v / SHORE_ROW) : 0;
      uplift[i] = v > SHORE_ROW ? -0.00008 * (1 + 2 * off) : Math.max(range, flank);

      // Patches of harder and softer rock: gorges where the river meets the
      // hard stuff, wider reaches through the soft.
      const rock = fbm(strata, u * 3 + strike, v * 5, 3);
      kfac[i] = 0.7 + 0.6 * smooth(rock * 0.9 + 0.5);
    }
  }
  return { W, H, N, z, uplift, kfac };
}

function smooth(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}
