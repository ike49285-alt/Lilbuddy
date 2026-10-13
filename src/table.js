// table.js — the starting landscape: a stretch of valley half a kilometre
// wide and a kilometre long, tilted gently from the top of the map down to
// the sea at the bottom. A bare floodplain of sand and gravel runs down
// the middle, dipping very gently toward its centre, with grassy terraces
// rising either side and a beach shelving into the sea. Hills break it up:
// spurs reaching in from either side in turn, and a few knolls between,
// some with bedrock just under them and some of firm earth. There's no
// channel: the river pours onto the sand and makes its own, winding round
// the hills. The plain is sand with gravel and a little mud in it; the
// terraces and hills are muddier and firmer.

import { makeNoise2D, fbm } from './rng.js';

export const GRID_W = 128;
export const GRID_H = 256;
export const CELL_M = 4;              // metres per cell side
export const SHORE = 0.72;            // fraction of the way down where the sea begins
export const INLET_X = GRID_W / 2;    // where the river comes in at the top
export const INLET_HALF = 4;          // cells either side of it

// The valley floor's fall, metres per metre, as set by the tilt.
export const TILT = 0.002;
// How high the hills stand to start with, metres (the Hills slider). The
// rocky hills' cores rise with them, and CORE_RISE more besides as the
// hills come up to HILLS (from the plain's rock, 6 m down, to a metre and a
// half under the hills' tops).
export const HILLS = 5;
export const CORE_RISE = 4.5;
export const coreRise = (hills) => CORE_RISE * Math.min(1, hills / HILLS);

// Mud and gravel in the ground, as shares of it by volume; the rest is sand.
export const PLAIN_MUD = 0.1;
export const PLAIN_GRAVEL = 0.3;
const TERRACE_MUD = 0.4, TERRACE_GRAVEL = 0.2;
const SHELF_MUD = 0.1, SHELF_GRAVEL = 0.05;

export function makeTable(rng, tilt = TILT) {
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
  const { shape: hillShape, core: hillCore } = makeHills(rng, W, H, shoreY, centres, halves);
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
      // The hills: firm, grassy and wooded like the terraces; the rocky
      // ones with bedrock just under them.
      const s = hillShape[i];
      if (s > 0) {
        z[i] += HILLS * s;
        if (hillCore[i] > 0) rock[i] = Math.min(rock[i] + hillCore[i] * (HILLS * s + coreRise(HILLS)), z[i] - 1.5);
        const k = Math.max(0, Math.min(1, (s - 0.15) / 0.3));
        mud[i] += (TERRACE_MUD - mud[i]) * k;
        gravel[i] += (TERRACE_GRAVEL - gravel[i]) * k;
        cover[i] = Math.max(cover[i], 0.85 * k);
        trees[i] = Math.max(trees[i], 0.4 * k);
      }
    }
  }
  return { W, H, N, z, rock, cover, trees, mud, gravel, shoreY, hillShape, hillCore };
}

// The hills' shape: for each cell, how much of the hills' height stands
// there (0 to 1), and how much of that the bedrock follows (1 in the cores
// of the rocky hills). Spurs reach in from either side of the plain in
// turn, each overlapping the next, so the river has to swing round their
// tips; a few knolls stand in the open stretches between. Kept clear of
// the pump and the coast.
function makeHills(rng, W, H, shoreY, centres, halves) {
  const N = W * H;
  const shape = new Float32Array(N), core = new Float32Array(N);
  const r = rng.fork('hills');
  const wobble = makeNoise2D(r.fork('wobble'));
  const crest = makeNoise2D(r.fork('crest'));
  const hills = [];
  // Spurs: a ridge from the side of the plain to a tip most of the way
  // across it, curving a little downstream, broad at its root and lower
  // and narrower toward its tip. A spine of points, each with its width
  // and height.
  const first = 26, last = shoreY - 18, n = 5;
  let side = r.chance(0.5) ? 1 : -1;
  for (let k = 0; k < n; k++) {
    const y0 = first + ((last - first) * k) / (n - 1) + r.range(-3, 3);
    const half = halves[Math.round(y0)], centre = centres[Math.round(y0)];
    const reach = r.range(0.6, 0.7) * 2 * half;
    const ax = centre + side * (half + 8), ay = y0 - 4;
    const bx = centre + side * (half - reach), by = y0 + r.range(5, 10);
    const bend = r.range(-0.12, 0.12) * reach, wide = r.range(7, 9), top = r.range(0.85, 1), tip = r.range(0.5, 0.65);
    const pts = [];
    for (let m = 0; m <= 10; m++) {
      const t = m / 10;
      // Bowed sideways (along y), and widest and highest at the root.
      pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t + bend * Math.sin(Math.PI * t), r: wide * (1 - 0.5 * t), h: top * (1 + (tip - 1) * t) });
    }
    hills.push({ pts });
    side = -side;
  }
  // Knolls in the open: away from the spurs, the pump and the coast.
  for (let tries = 0, made = 0; tries < 300 && made < 4; tries++) {
    const y = r.range(34, shoreY - 16);
    const x = centres[Math.round(y)] + r.range(-0.7, 0.7) * halves[Math.round(y)];
    const rad = r.range(5, 9);
    if (!hills.every((h) => nearest(h.pts, x, y).d > rad + nearest(h.pts, x, y).r + 4)) continue;
    // A little long, lying at a slant.
    const a = r.range(0, Math.PI), l = r.range(0, 0.5) * rad, top = r.range(0.5, 0.8);
    hills.push({ pts: [{ x: x - Math.cos(a) * l, y: y - Math.sin(a) * l, r: rad, h: top }, { x: x + Math.cos(a) * l, y: y + Math.sin(a) * l, r: rad * 0.85, h: top * 0.9 }] });
    made++;
  }
  // About half of them rocky, at least one of each.
  const rocky = hills.map(() => r.chance(0.5));
  rocky[0] = true;
  rocky[1] = false;
  hills.forEach((h, k) => {
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (const p of h.pts) { x0 = Math.min(x0, p.x - p.r * 1.4); x1 = Math.max(x1, p.x + p.r * 1.4); y0 = Math.min(y0, p.y - p.r * 1.4); y1 = Math.max(y1, p.y + p.r * 1.4); }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(shoreY - 6, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(W - 1, Math.ceil(x1)); x++) {
        const near = nearest(h.pts, x + 0.5, y + 0.5);
        const d = near.d / (near.r * (1 + 0.3 * fbm(wobble, x / 6, y / 6, 2)));
        if (d >= 1) continue;
        // A rounded ridge, its crest lumpy.
        const s = (1 - d * d) ** 2 * near.h * (1 + 0.2 * fbm(crest, x / 7, y / 7, 2)) * Math.min(1, (shoreY - 6 - y) / 6);
        const i = y * W + x;
        if (s > shape[i]) { shape[i] = Math.min(1, s); core[i] = rocky[k] ? Math.max(0, Math.min(1, (s - 0.3) / 0.2)) : 0; }
      }
    }
  });
  return { shape, core };
}

// The point of a spine nearest (x, y): how far, and the spine's width and
// height there.
function nearest(pts, x, y) {
  let best = { d: Infinity, r: pts[0].r, h: pts[0].h };
  for (let k = 0; k < Math.max(1, pts.length - 1); k++) {
    const a = pts[k], b = pts[Math.min(k + 1, pts.length - 1)];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < best.d) best = { d, r: a.r + (b.r - a.r) * t, h: a.h + (b.h - a.h) * t };
  }
  return best;
}
