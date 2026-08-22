// world.js — the map substrate.
//
// Regions are Voronoi cells, but there is no polygon anywhere in here. A single
// raster mapping pixel -> site index does three jobs at once: it *is* the
// renderer (fill each pixel with its owner's colour), it *is* the adjacency
// source (neighbouring pixels with different sites means neighbouring cells),
// and it gives cell areas and centroids for free. Polygon Voronoi would be more
// code for less.

import { makeNoise2D, fbm } from './rng.js';

export const RASTER_W = 640;
export const RASTER_H = 400;

// 56 x 36 sites, jittered and relaxed. Enough that borders read as organic at
// this raster size, few enough that a full sweep over cells stays cheap enough
// to run every tick forever.
const GRID_X = 56;
const GRID_Y = 36;

export const BIOMES = [
  //                          colour       capacity
  { id: 0, key: 'ocean',      rgb: [ 32,  58,  92], cap: 0.0 },
  { id: 1, key: 'ice',        rgb: [220, 228, 235], cap: 0.02 },
  { id: 2, key: 'tundra',     rgb: [140, 152, 140], cap: 0.12 },
  { id: 3, key: 'taiga',      rgb: [ 78, 106,  84], cap: 0.32 },
  { id: 4, key: 'forest',     rgb: [ 74, 122,  66], cap: 0.78 },
  { id: 5, key: 'grassland',  rgb: [138, 158,  86], cap: 1.00 },
  { id: 6, key: 'savanna',    rgb: [172, 162,  86], cap: 0.62 },
  { id: 7, key: 'desert',     rgb: [198, 176, 122], cap: 0.10 },
  { id: 8, key: 'jungle',     rgb: [ 48, 110,  62], cap: 0.55 },
  { id: 9, key: 'mountain',   rgb: [122, 118, 112], cap: 0.14 },
];

export const BIOME_BY_KEY = Object.fromEntries(BIOMES.map((b) => [b.key, b]));

function biomeFor(elevation, temp, moisture, seaLevel) {
  if (elevation < seaLevel) return 0;
  if (elevation > seaLevel + 0.20) return 9;
  if (temp < 0.16) return 1;
  if (temp < 0.30) return moisture > 0.42 ? 3 : 2;
  if (temp > 0.70) {
    if (moisture < 0.24) return 7;
    if (moisture < 0.46) return 6;
    return 8;
  }
  if (moisture < 0.20) return 7;
  if (moisture < 0.42) return 5;
  return 4;
}

// Nearest site to a pixel, via a uniform bucket grid. Sites drift during Lloyd
// relaxation, so this searches outward in rings rather than assuming a site
// stays in its original bucket.
function makeSiteLookup(sx, sy, count, bucketSize) {
  const bw = Math.ceil(RASTER_W / bucketSize);
  const bh = Math.ceil(RASTER_H / bucketSize);
  const counts = new Int32Array(bw * bh);
  for (let i = 0; i < count; i++) {
    const bx = Math.min(bw - 1, Math.floor(sx[i] / bucketSize));
    const by = Math.min(bh - 1, Math.floor(sy[i] / bucketSize));
    counts[by * bw + bx]++;
  }
  const start = new Int32Array(bw * bh + 1);
  for (let i = 0; i < bw * bh; i++) start[i + 1] = start[i] + counts[i];
  const items = new Int32Array(count);
  const cursor = start.slice(0, bw * bh);
  for (let i = 0; i < count; i++) {
    const bx = Math.min(bw - 1, Math.floor(sx[i] / bucketSize));
    const by = Math.min(bh - 1, Math.floor(sy[i] / bucketSize));
    items[cursor[by * bw + bx]++] = i;
  }

  return function nearest(px, py) {
    const cx = Math.min(bw - 1, Math.floor(px / bucketSize));
    const cy = Math.min(bh - 1, Math.floor(py / bucketSize));
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring < Math.max(bw, bh); ring++) {
      const x0 = Math.max(0, cx - ring);
      const x1 = Math.min(bw - 1, cx + ring);
      const y0 = Math.max(0, cy - ring);
      const y1 = Math.min(bh - 1, cy + ring);
      for (let by = y0; by <= y1; by++) {
        for (let bx = x0; bx <= x1; bx++) {
          // Only the newly added ring, not the filled square.
          if (ring > 0 && bx > x0 && bx < x1 && by > y0 && by < y1) continue;
          const b = by * bw + bx;
          for (let k = start[b]; k < start[b + 1]; k++) {
            const i = items[k];
            const dx = sx[i] - px;
            const dy = sy[i] - py;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      // One extra ring past the first hit, since a nearer site can sit just
      // over a bucket boundary.
      if (best >= 0 && bestD <= (ring * bucketSize) ** 2) break;
    }
    return best;
  };
}

function rasterize(sx, sy, count, bucketSize) {
  const nearest = makeSiteLookup(sx, sy, count, bucketSize);
  const raster = new Int16Array(RASTER_W * RASTER_H);
  for (let y = 0; y < RASTER_H; y++) {
    for (let x = 0; x < RASTER_W; x++) {
      raster[y * RASTER_W + x] = nearest(x + 0.5, y + 0.5);
    }
  }
  return raster;
}

// Move each site to the centroid of the pixels it owns. Two passes turns a
// jittered grid into cells that look hand-drawn rather than gridded.
function relax(raster, sx, sy, count) {
  const sumX = new Float64Array(count);
  const sumY = new Float64Array(count);
  const n = new Int32Array(count);
  for (let y = 0; y < RASTER_H; y++) {
    for (let x = 0; x < RASTER_W; x++) {
      const c = raster[y * RASTER_W + x];
      sumX[c] += x; sumY[c] += y; n[c]++;
    }
  }
  for (let i = 0; i < count; i++) {
    if (n[i] === 0) continue;
    sx[i] = sumX[i] / n[i];
    sy[i] = sumY[i] / n[i];
  }
}

function buildAdjacency(raster, count) {
  const seen = new Set();
  const pairs = [];
  const add = (a, b) => {
    if (a === b) return;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * 65536 + hi;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(lo, hi);
  };
  for (let y = 0; y < RASTER_H; y++) {
    for (let x = 0; x < RASTER_W; x++) {
      const i = y * RASTER_W + x;
      const c = raster[i];
      if (x + 1 < RASTER_W) add(c, raster[i + 1]);
      if (y + 1 < RASTER_H) add(c, raster[i + RASTER_W]);
    }
  }

  const degree = new Int32Array(count);
  for (let k = 0; k < pairs.length; k += 2) {
    degree[pairs[k]]++;
    degree[pairs[k + 1]]++;
  }
  const start = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) start[i + 1] = start[i] + degree[i];
  const list = new Int32Array(pairs.length);
  const cursor = start.slice(0, count);
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k];
    const b = pairs[k + 1];
    list[cursor[a]++] = b;
    list[cursor[b]++] = a;
  }
  return { start, list };
}

// Hops to the nearest ocean cell, over the cell graph. Drives both moisture and
// the coastal bonus, so inland empires are genuinely poorer than seaboard ones.
function distanceToOcean(count, neighbors, isOcean) {
  const dist = new Int16Array(count).fill(-1);
  let frontier = [];
  for (let i = 0; i < count; i++) {
    if (isOcean[i]) { dist[i] = 0; frontier.push(i); }
  }
  while (frontier.length) {
    const next = [];
    for (const c of frontier) {
      for (let k = neighbors.start[c]; k < neighbors.start[c + 1]; k++) {
        const nb = neighbors.list[k];
        if (dist[nb] === -1) { dist[nb] = dist[c] + 1; next.push(nb); }
      }
    }
    frontier = next;
  }
  // A landlocked world with no ocean at all would leave -1s behind.
  for (let i = 0; i < count; i++) if (dist[i] === -1) dist[i] = 999;
  return dist;
}

export function generateWorld(rng) {
  const wrng = rng.fork('world');
  const count = GRID_X * GRID_Y;
  const cellW = RASTER_W / GRID_X;
  const cellH = RASTER_H / GRID_Y;

  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  for (let gy = 0; gy < GRID_Y; gy++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      const i = gy * GRID_X + gx;
      sx[i] = (gx + wrng.range(0.15, 0.85)) * cellW;
      sy[i] = (gy + wrng.range(0.15, 0.85)) * cellH;
    }
  }

  const bucket = Math.max(cellW, cellH);
  let raster = rasterize(sx, sy, count, bucket);
  for (let pass = 0; pass < 2; pass++) {
    relax(raster, sx, sy, count);
    raster = rasterize(sx, sy, count, bucket);
  }

  const neighbors = buildAdjacency(raster, count);

  // Cell areas, from the raster we already have.
  const area = new Int32Array(count);
  for (let i = 0; i < raster.length; i++) area[raster[i]]++;

  const elevNoise = makeNoise2D(wrng.fork('elevation'));
  const moistNoise = makeNoise2D(wrng.fork('moisture'));
  const detailNoise = makeNoise2D(wrng.fork('detail'));

  const elevation = new Float32Array(count);
  const temperature = new Float32Array(count);
  const moisture = new Float32Array(count);
  const biome = new Uint8Array(count);
  const baseCapacity = new Float32Array(count);
  const isOcean = new Uint8Array(count);

  const seaLevel = 0.46;
  // Continents are pulled away from the map edge so the world reads as land
  // surrounded by sea rather than a rectangle cropped out of one.
  for (let i = 0; i < count; i++) {
    const nx = sx[i] / RASTER_W;
    const ny = sy[i] / RASTER_H;
    const raw = fbm(elevNoise, nx * 3.1, ny * 3.1, 6) * 0.5 + 0.5;
    const dx = (nx - 0.5) * 2;
    const dy = (ny - 0.5) * 2;
    const edge = Math.sqrt(dx * dx * 0.85 + dy * dy);
    const falloff = Math.max(0, 1 - Math.pow(edge, 2.4));
    elevation[i] = raw * 0.72 + falloff * 0.42 - 0.08;
    isOcean[i] = elevation[i] < seaLevel ? 1 : 0;
  }

  const oceanDist = distanceToOcean(count, neighbors, isOcean);

  for (let i = 0; i < count; i++) {
    const nx = sx[i] / RASTER_W;
    const ny = sy[i] / RASTER_H;
    const lat = Math.abs(ny - 0.5) * 2;
    // Latitude sets the band; elevation cools it; a little noise stops the
    // bands from reading as stripes.
    temperature[i] = Math.max(0, Math.min(1,
      1.05 - lat * 1.15
      - Math.max(0, elevation[i] - seaLevel) * 0.9
      + fbm(detailNoise, nx * 5, ny * 5, 3) * 0.07));

    const continentality = Math.min(1, oceanDist[i] / 12);
    moisture[i] = Math.max(0, Math.min(1,
      (fbm(moistNoise, nx * 4.3, ny * 4.3, 4) * 0.5 + 0.5)
      * (1 - continentality * 0.55)
      + (isOcean[i] ? 0.3 : 0)));

    biome[i] = biomeFor(elevation[i], temperature[i], moisture[i], seaLevel);

    const b = BIOMES[biome[i]];
    // Coastal cells carry a real premium — this is most of why early polities
    // cluster on the shoreline instead of spreading uniformly.
    const coastal = oceanDist[i] === 1 ? 1.35 : oceanDist[i] === 2 ? 1.12 : 1;
    baseCapacity[i] = b.cap * coastal * (0.85 + fbm(detailNoise, nx * 9, ny * 9, 2) * 0.3);
  }

  const land = [];
  for (let i = 0; i < count; i++) if (!isOcean[i]) land.push(i);

  // How strongly the climate cycle swings this cell: positive toward the
  // equator, negative toward the poles. Static, so the tick loop reads it
  // instead of recomputing a latitude every cell every year.
  const climateWeight = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const lat = Math.abs(sy[i] / RASTER_H - 0.5) * 2;
    climateWeight[i] = (0.42 - lat) * 0.85;
  }

  return {
    width: RASTER_W,
    height: RASTER_H,
    cellCount: count,
    raster,
    sx, sy, area,
    neighbors,
    elevation, temperature, moisture, biome, baseCapacity,
    isOcean, oceanDist, climateWeight,
    landCells: Int32Array.from(land),
    seaLevel,
  };
}

// Flat RGB triples per cell for the terrain underlay, so the renderer doesn't
// have to touch the BIOMES table per pixel.
export function biomePalette(world) {
  const rgb = new Uint8Array(world.cellCount * 3);
  for (let i = 0; i < world.cellCount; i++) {
    const b = BIOMES[world.biome[i]];
    // Shade by elevation so terrain has some relief rather than reading flat.
    const shade = world.isOcean[i]
      ? 0.75 + world.elevation[i] * 0.5
      : 0.82 + (world.elevation[i] - world.seaLevel) * 0.85;
    rgb[i * 3] = Math.max(0, Math.min(255, b.rgb[0] * shade));
    rgb[i * 3 + 1] = Math.max(0, Math.min(255, b.rgb[1] * shade));
    rgb[i * 3 + 2] = Math.max(0, Math.min(255, b.rgb[2] * shade));
  }
  return rgb;
}
