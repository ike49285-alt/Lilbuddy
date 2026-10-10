// table.js — the starting landscape: a stretch of valley half a kilometre
// wide and a kilometre long, tilted gently from the top of the map down to
// the sea at the bottom. A bare floodplain of sand and gravel runs down
// the middle, dipping very gently toward its centre, with grassy terraces
// rising either side and a beach shelving into the sea. There's no channel:
// the river pours onto the sand and makes its own. The plain is sand with
// a little mud in it; the terraces are old floodplain, muddier and firmer.

import { makeNoise2D, fbm } from './rng.js';

export const GRID_W = 128;
export const GRID_H = 256;
export const CELL_M = 4;              // metres per cell side
export const SHORE = 0.72;            // fraction of the way down where the sea begins
export const INLET_X = GRID_W / 2;    // where the river comes in at the top
export const INLET_HALF = 4;          // cells either side of it

// The valley floor's fall, metres per metre, as set by the tilt.
export const TILT = 0.002;

// Mud in the ground, as a share of it by volume.
export const PLAIN_MUD = 0.1;
const TERRACE_MUD = 0.4;
const SHELF_MUD = 0.1;

export function makeTable(rng, tilt = TILT) {
  const W = GRID_W, H = GRID_H, N = W * H;
  const z = new Float32Array(N);
  const rock = new Float32Array(N);
  const cover = new Float32Array(N);
  const mud = new Float32Array(N);
  const rough = makeNoise2D(rng.fork('rough'));
  const lumps = makeNoise2D(rng.fork('lumps'));
  const sides = makeNoise2D(rng.fork('sides'));
  const shoreY = Math.round(SHORE * H);
  const plainHalf = 0.36 * W;          // the floodplain's half-width, cells
  for (let y = 0; y < H; y++) {
    // The terraces wander in and out a little down the valley.
    const half = plainHalf * (1 + 0.12 * fbm(sides, y / 40, 3.1, 3));
    const centre = W / 2 + 6 * fbm(sides, y / 60, 7.7, 3);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // Height above sea level at the shore, falling toward it.
      let h = tilt * (shoreY - y) * CELL_M + 0.6;
      // Bumps on the floodplain: old bars and swales.
      h += 0.18 * fbm(lumps, x / 14, y / 14, 3) + 0.05 * fbm(rough, x / 3, y / 3, 2);
      // The plain dips a little toward its middle, so the water drifts
      // toward the valley floor rather than along a wall.
      const out = Math.abs(x - centre) - half;
      h += 0.8 * Math.min(1, Math.abs(x - centre) / half) ** 1.5;
      // Terraces rising either side, ending in low headlands at the coast.
      const headland = Math.max(0, Math.min(1, 1 - (y - shoreY + 6) / 14));
      if (out > 0) h += headland * (Math.min(6, 0.08 * out * out / 4 + 0.15 * out) + 0.3 * fbm(rough, x / 8, y / 8, 2));
      // Below the shore, a wide, shallow shelf for the river to build its
      // delta out over, deepening slowly to a couple of metres.
      if (y > shoreY) h = Math.max(-2.6 + 0.1 * fbm(rough, x / 6, y / 6, 2), h - (y - shoreY) * 0.045);
      z[i] = h;
      // Bedrock deep under the floodplain, close under the terraces.
      rock[i] = out > 0 && headland > 0.5 ? h - 1.5 - 0.5 * out / 10 : h - 6;
      // Grass and shrubs on the terraces; the plain and the beach are bare
      // sand, and grass takes the dry ground as the years go by.
      cover[i] = y > shoreY - 2 ? 0 : out > 0 ? 0.85 * headland : 0;
      // Mud: in the terraces' old floodplain, a little in the plain's sand.
      const terrace = Math.max(0, Math.min(1, out / 3)) * headland;
      mud[i] = y > shoreY ? SHELF_MUD : PLAIN_MUD + (TERRACE_MUD - PLAIN_MUD) * terrace;
    }
  }
  return { W, H, N, z, rock, cover, mud, shoreY };
}
