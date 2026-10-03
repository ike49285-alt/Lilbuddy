// tools.js — shaping the land by hand: raise or lower the ground under a
// brush, cut a channel along a line, and park a storm. Each changes the saved
// state directly, so a restored world carries on exactly the same.

export const BRUSH = { small: 1.5, big: 4 };   // brush radius, in cells
const DIG_DEPTH = 5;                            // a channel is at least this deep, metres
const MAX_DIG = 600;                            // cells in one channel
const DIG_FALL = 0.05;                          // the least a channel's bed falls per cell, metres
const STORM_KM = 6;                             // a parked storm's radius
const STORM_YEARS = 1.5 / 365.25;               // and how long it rains
const STORM_STRENGTH = 10;                      // times the climate's rain, at its heart

// Raises (dz > 0) or lowers the ground with a soft-edged brush of radius r
// cells centred on cell i. Raising adds rock; lowering takes the loose
// cover first, then rock. Returns whether anything changed.
export function sculpt(land, i, r, dz) {
  const { W, H, z, loose } = land;
  if (!(i >= 0 && i < land.N) || !(r > 0) || !dz) return false;
  const cx = i % W, cy = (i / W) | 0;
  const R = Math.ceil(2 * r);
  for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y++) {
    for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 > R * R) continue;
      const j = y * W + x;
      const h = dz * Math.exp(-d2 / (r * r));
      z[j] += h;
      if (h < 0) loose[j] = Math.max(0, loose[j] + h);
    }
  }
  return true;
}

// The cells along a line through the given points (cells, fractional), in
// order, each touching the last at a side or corner.
export function lineCells(W, H, pts) {
  const out = [];
  const seen = new Set();
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (seen.has(i)) return;
    seen.add(i);
    out.push(i);
  };
  for (let k = 0; k < pts.length; k++) {
    const x1 = Math.floor(pts[k][0]), y1 = Math.floor(pts[k][1]);
    if (k === 0) { put(x1, y1); continue; }
    let x = Math.floor(pts[k - 1][0]), y = Math.floor(pts[k - 1][1]);
    const dx = Math.abs(x1 - x), dy = Math.abs(y1 - y);
    const sx = x1 > x ? 1 : -1, sy = y1 > y ? 1 : -1;
    let err = dx - dy;
    while (x !== x1 || y !== y1) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      put(x, y);
      if (out.length >= MAX_DIG) return out;
    }
  }
  return out;
}

// Cuts a channel along the cells, its bed falling steadily from the higher
// end to the lower, everywhere at least DIG_DEPTH below the ground and below
// the ground on either side. The
// bed never rises: where the line crosses a lower valley the channel is cut
// deeper beyond it, so whatever enters it runs out at the far end.
// Returns its length in cells, or 0.
export function dig(land, cells) {
  const { z, loose } = land;
  if (cells.length < 2) return 0;
  let path = cells;
  if (z[path[0]] < z[path[path.length - 1]]) path = path.slice().reverse();
  const top = z[path[0]] - DIG_DEPTH, bottom = z[path[path.length - 1]] - DIG_DEPTH;
  // Below the ground beside it, too, so water that gets in stays in.
  const { W, H } = land;
  const on = new Set(path);
  const beside = path.map((j) => {
    const x = j % W, y = (j / W) | 0;
    let low = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && !on.has(ny * W + nx)) low = Math.min(low, z[ny * W + nx]);
    }
    return low - 1;
  });
  let prev = Infinity;
  for (let k = 0; k < path.length; k++) {
    const j = path[k];
    const bed = Math.min(z[j] - DIG_DEPTH, beside[k], top + ((bottom - top) * k) / (path.length - 1), prev - DIG_FALL);
    prev = bed;
    const cut = z[j] - bed;
    z[j] = bed;
    loose[j] = Math.max(0, loose[j] - cut);
  }
  return path.length;
}

// A heavy storm parked over a cell for a day and a half.
export function parkStorm(weather, W, i, years) {
  const x = ((i % W) + 0.5) / 2 - 0.5, y = (((i / W) | 0) + 0.5) / 2 - 0.5;   // on the 1 km life grid
  // Drop finished storms; keep the list short.
  weather.storms = weather.storms.filter((s) => s.end > years).slice(-7);
  weather.storms.push({ x, y, r: STORM_KM, start: years, end: years + STORM_YEARS, strength: STORM_STRENGTH });
}
