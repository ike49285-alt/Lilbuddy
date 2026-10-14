// table.js — the starting landscape: a stretch of valley half a kilometre
// wide and a kilometre long, tilted gently from the top of the map down to
// the sea at the bottom. A bare floodplain of sand and gravel runs down
// the middle, dipping very gently toward its centre, with grassy terraces
// rising either side and a beach shelving into the sea. Rolling ground
// breaks it up: hills and hollows from noise, some of the hills with
// bedrock just under them and the rest of firm earth. There's no channel:
// the river pours onto the sand and makes its own, winding round the hills
// and filling the hollows. The plain is sand with gravel and a little mud
// in it; the terraces and hills are muddier and firmer.

import { makeNoise2D, fbm } from './rng.js';

export const GRID_W = 128;
export const GRID_H = 256;
export const CELL_M = 4;              // metres per cell side
export const SHORE = 0.72;            // fraction of the way down where the sea begins
export const INLET_X = GRID_W / 2;    // where the river comes in at the top
export const INLET_HALF = 4;          // cells either side of it

// The valley floor's fall, metres per metre, as set by the tilt.
export const TILT = 0.002;
// The rolling ground to start with (the Hills and Hill size sliders): how
// far it rises and falls, metres, and how far across its hills are, metres.
// The rocky hills' cores rise with them, and CORE_RISE more besides as the
// hills come up to HILLS (from the plain's rock, 6 m down, to a metre and a
// half under the hills' tops).
export const HILLS = 2.5;
export const HILL_SIZE = 120;
export const CORE_RISE = 4.5;
export const coreRise = (hills) => CORE_RISE * Math.min(1, hills / HILLS);
// How much the rolling ground moves the bed and the rock at cell i, for
// hills `a` metres high on the field f (from hills.field(size)): the rock
// follows the ground down into hollows, and up into the rocky hills.
export const hillGround = (f, a, i) => a * f.F[i];
export const hillRock = (f, a, i) => (f.F[i] < 0 ? a * f.F[i] : f.core[i] * (a * f.F[i] + coreRise(a)));

// Mud and gravel in the ground, as shares of it by volume; the rest is sand.
export const PLAIN_MUD = 0.1;
export const PLAIN_GRAVEL = 0.3;
const TERRACE_MUD = 0.4, TERRACE_GRAVEL = 0.2;
const SHELF_MUD = 0.1, SHELF_GRAVEL = 0.05;

export function makeTable(rng, tilt = TILT, hillsHigh = HILLS) {
  const W = GRID_W, H = GRID_H, N = W * H;
  const z = new Float32Array(N);
  const rock = new Float32Array(N);
  const cover = new Float32Array(N);
  const mud = new Float32Array(N);
  const trees = new Float32Array(N);
  const gravel = new Float32Array(N);
  const rough = makeNoise2D(rng.fork('rough'));
  const lumps = makeNoise2D(rng.fork('lumps'));
  const sides = makeNoise2D(rng.fork('sides'));
  const shoreY = Math.round(SHORE * H);
  const plainHalf = 0.36 * W;          // the floodplain's half-width, cells
  // The terraces wander in and out a little down the valley.
  const halves = new Float32Array(H), centres = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    halves[y] = plainHalf * (1 + 0.12 * fbm(sides, y / 40, 3.1, 3));
    centres[y] = W / 2 + 6 * fbm(sides, y / 60, 7.7, 3);
  }
  const hills = makeHills(rng, W, H, shoreY, centres, halves);
  const field = hills.field(HILL_SIZE);
  for (let y = 0; y < H; y++) {
    const half = halves[y], centre = centres[y];
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
      // Woods on the terraces, thinning toward the plain.
      trees[i] = y > shoreY - 2 ? 0 : out > 0 ? 0.4 * headland * Math.min(1, out / 4) : 0;
      // Mud: in the terraces' old floodplain, a little in the plain's sand.
      const terrace = Math.max(0, Math.min(1, out / 3)) * headland;
      mud[i] = y > shoreY ? SHELF_MUD : PLAIN_MUD + (TERRACE_MUD - PLAIN_MUD) * terrace;
      gravel[i] = y > shoreY ? SHELF_GRAVEL : PLAIN_GRAVEL + (TERRACE_GRAVEL - PLAIN_GRAVEL) * terrace;
      // The rolling ground: the rock follows it down into the hollows,
      // and up into the rocky hills, a metre and a half under them; the
      // hills are firm, grassy and wooded like the terraces.
      const g = hillGround(field, hillsHigh, i);
      if (g !== 0) {
        z[i] += g;
        rock[i] += hillRock(field, hillsHigh, i);
        if (field.core[i] > 0) rock[i] = Math.min(rock[i], z[i] - 1.5);
        const k = Math.max(0, Math.min(1, (g - 0.5) / 1.5));
        mud[i] += (TERRACE_MUD - mud[i]) * k;
        gravel[i] += (TERRACE_GRAVEL - gravel[i]) * k;
        cover[i] = Math.max(cover[i], 0.85 * k);
        trees[i] = Math.max(trees[i], 0.4 * k);
      }
    }
  }
  return { W, H, N, z, rock, cover, trees, mud, gravel, shoreY, hills };
}

// The rolling ground, from noise: field(size) gives, for hills `size`
// metres across, how far each cell rises or falls for each metre of the
// Hills setting (F, about −1 to 1), and how much the rock rises with it
// (core, 1 in the rocky hills). It fades out toward the pump (so its water
// never comes in at the bottom of a hollow) and the coast, and by half on
// the terraces.
function makeHills(rng, W, H, shoreY, centres, halves) {
  const N = W * H;
  const r = rng.fork('hills');
  const ground = makeNoise2D(r.fork('ground')), rocky = makeNoise2D(r.fork('rocky'));
  const made = new Map();
  const field = (size) => {
    if (made.has(size)) return made.get(size);
    const F = new Float32Array(N), core = new Float32Array(N);
    const k = CELL_M / size;
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 0; y < shoreY; y++) {
      for (let x = 0; x < W; x++) {
        const v = fbm(ground, x * k + 17.3, y * k + 5.1, 4);
        F[y * W + x] = v;
        sum += v; sum2 += v * v; n++;
      }
    }
    // A spread of 0.4 either way, whatever the size.
    const mean = sum / n, sd = Math.sqrt(Math.max(1e-9, sum2 / n - mean * mean));
    for (let y = 0; y < shoreY; y++) {
      const fade = Math.min(1, y / 14) * Math.max(0, Math.min(1, (shoreY - 6 - y) / 8));
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const side = Math.abs(x - centres[y]) > halves[y] ? 0.5 : 1;
        const v = Math.max(-1, Math.min(1, ((F[i] - mean) * 0.4) / sd)) * fade * side;
        F[i] = v;
        // About half the hills rocky, from a broader noise.
        if (v > 0) core[i] = Math.max(0, Math.min(1, (fbm(rocky, (x * k) / 1.5 + 3.7, (y * k) / 1.5 + 9.2, 3) + 0.05) / 0.2)) * Math.min(1, v / 0.25);
      }
    }
    const f = { F, core };
    if (made.size > 4) made.delete(made.keys().next().value);
    made.set(size, f);
    return f;
  };
  return { field };
}
