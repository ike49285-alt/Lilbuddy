// terrain.js — the starting surface: a freshly uplifted mountain front that
// ramps down to a coastal plain and a drowned shelf. No valleys yet; the
// river has to cut every one of them.

import { makeNoise2D, fbm } from './rng.js';

export const GRID_W = 128;
export const GRID_H = 224;
export const CELL_M = 500;           // metres per cell side
export const SHORE_ROW = 0.74;       // fraction of the height where the coast starts
export const SHELF_EDGE = 0.9;       // where the continental shelf breaks into deep water

// Bedrock. `k` is erodibility relative to the model's base rate (the mix
// averages about 1, so the valley forms over the same time as before);
// `soil` is how fast it weathers into loose cover, in metres per year on
// bare rock.
export const ROCKS = [
  { name: 'granite', k: 0.25, soil: 2e-5 },
  { name: 'sandstone', k: 1.1, soil: 6e-5 },
  { name: 'shale', k: 1.7, soil: 1e-4 },
  { name: 'limestone', k: 0.6, soil: 4e-5 },
  { name: 'basalt', k: 0.4, soil: 8e-5 },
];
export const GRANITE = 0, SANDSTONE = 1, SHALE = 2, LIMESTONE = 3, BASALT = 4;
// The foothill strata, in order: a rhythm of sand and mud with the odd
// limestone, crossing the valley so the river meets hard and soft in turn.
const STRATA = [SANDSTONE, SHALE, SANDSTONE, LIMESTONE, SHALE, SANDSTONE, SHALE];

export function generateTerrain(rng) {
  const W = GRID_W, H = GRID_H, N = W * H;
  const z = new Float64Array(N);
  const uplift = new Float32Array(N);   // metres per year
  const kfac = new Float32Array(N);     // erodibility multiplier (rock hardness)
  const rock = new Uint8Array(N);       // bedrock type, an index into ROCKS
  const loose = new Float32Array(N);    // metres of loose cover over it
  const cover = makeNoise2D(rng.fork('cover'));
  const core = makeNoise2D(rng.fork('core'));

  const rough = makeNoise2D(rng.fork('rough'));
  const strata = makeNoise2D(rng.fork('strata'));
  const ridge = makeNoise2D(rng.fork('ridge'));
  const domes = makeNoise2D(rng.fork('domes'));

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
        // Starts level with the land and steepens gently, so there's no kink
        // at the coast for the hillshade to pick out.
        const t = (v - SHORE_ROW) / (SHELF_EDGE - SHORE_ROW);
        base = 4 - 144 * Math.pow(t, 1.5);
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
        ? 260 * (1 - v / SHORE_ROW) * Math.pow(Math.min(1, across * 2.2), 1.3)
        : 0;
      // Low-amplitude roughness: enough to break up the ramp into many
      // competing trickles, not enough to pre-draw any valleys.
      const seaward = smooth((v - SHORE_ROW + 0.03) / 0.06);
      const highland = Math.max(0, 1 - v / 0.5);
      const r = fbm(rough, u * 7, v * 9, 5) * (18 + 70 * highland) * (1 - 0.7 * seaward);
      // A ragged summit line rather than a ruler edge.
      const rr = v < 0.18 ? fbm(ridge, u * 5, 0.5, 3) * 60 * (1 - v / 0.18) : 0;
      z[i] = base + trough + r + rr;

      // Uplift: strongest along the range front, fading out by mid-valley,
      // with slight subsidence under the coast so the delta has room to build.
      // Flanking hills keep rising too, so the valley is held in place by
      // the tectonics rather than relying on the starting shape.
      // Land uplift and coastal subsidence blend across a band at the shore,
      // so no fault scarp grows along the old coastline.
      const off = Math.max(0, (v - SHORE_ROW) / (1 - SHORE_ROW));
      // The range doesn't rise evenly: some blocks are pushed up faster than
      // others, so ridges and spurs form and the drainage has to branch
      // around them instead of running straight down the slope.
      const swell = 1 + 0.75 * fbm(domes, u * 3.2, v * 4.5, 3);
      const range = v < 0.5 ? 0.0011 * Math.pow(1 - v / 0.5, 1.2) * swell : 0;
      const flankTaper = 1 - smooth((v - SHORE_ROW + 0.12) / 0.12);
      const flank = 0.00016 * Math.pow(Math.min(1, across * 2.2), 2) * (1 - 0.6 * Math.min(1, v / SHORE_ROW)) * flankTaper;
      const sink = -0.00008 * (1 + 2 * off);
      const toSea = smooth((v - SHORE_ROW + 0.02) / 0.06);
      uplift[i] = Math.max(range, flank) * (1 - toSea) + sink * toSea;

      // Bedrock: a granite core along the top of the range, its edge ragged;
      // below it, bands of sedimentary rock crossing the valley, gently
      // warped, so the river cuts gorges through the hard bands and opens
      // out across the soft.
      const coreEdge = 0.2 + 0.07 * fbm(core, u * 4, 1.3, 3);
      if (v < coreEdge) rock[i] = GRANITE;
      else {
        const band = (v - coreEdge) * 9 + 0.9 * fbm(strata, u * 2.5 + strike, v * 3, 3);
        rock[i] = STRATA[((Math.floor(band) % STRATA.length) + STRATA.length) % STRATA.length];
      }
      kfac[i] = ROCKS[rock[i]].k;

      // Loose cover: thin soil on the young mountains, thickening down the
      // slope to deep sand and silt on the coastal plain, and sediment on
      // the sea floor, deepest in the basin.
      const patch = 0.6 + 0.8 * (0.5 + 0.5 * fbm(cover, u * 6, v * 8, 3));
      let depth;
      if (v < 0.5) depth = 0.5 + 1.5 * (v / 0.5);
      else if (v < SHORE_ROW) depth = 2 + 26 * smooth((v - 0.5) / (SHORE_ROW - 0.5));
      else if (v < SHELF_EDGE) depth = 28;
      else depth = 28 + 40 * (v - SHELF_EDGE) / (1 - SHELF_EDGE);
      loose[i] = depth * patch;
    }
  }
  return { W, H, N, z, uplift, kfac, rock, loose };
}

function smooth(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}
