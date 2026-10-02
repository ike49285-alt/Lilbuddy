// render.js — draws a frame: hypsometric terrain with hillshade, the sea,
// lakes and ice, and the rivers as lines whose width follows their discharge.

const CELL_M = 500;

// Elevation tints (metres) — lowland green through tan and brown to snow.
const LAND = [
  [0, 112, 146, 96], [150, 140, 166, 106], [400, 184, 182, 126], [800, 194, 160, 112],
  [1300, 164, 126, 94], [1900, 140, 120, 112], [2400, 196, 192, 190], [2900, 238, 238, 236],
];
// Sea depth (metres below sea level).
const SEA = [
  [0, 98, 156, 178], [40, 66, 124, 158], [140, 42, 94, 132], [600, 24, 60, 96], [1800, 14, 36, 64],
];

function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0];
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const a = stops[k - 1], b = stops[k];
      const t = (v - a[0]) / (b[0] - a[0]);
      return [v, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  return stops[stops.length - 1];
}

export function elevationColor(m) {
  const c = ramp(LAND, m);
  return `rgb(${c[1] | 0}, ${c[2] | 0}, ${c[3] | 0})`;
}

export class MapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = document.createElement('canvas');
    this.tctx = this.terrain.getContext('2d');
    this.image = null;
  }

  // Keeps the backing store matched to the element's size on screen.
  fit() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h };
  }

  draw(f) {
    const { W, H, z, ocean, lake, ice, Q, rec, seaLevel } = f;
    if (!this.image || this.image.width !== W || this.image.height !== H) {
      this.terrain.width = W;
      this.terrain.height = H;
      this.image = this.tctx.createImageData(W, H);
    }
    const px = this.image.data;
    // Light from the north-west, slopes exaggerated so relief reads at this scale.
    const EXAG = 7;
    const L = Math.hypot(1, 1, 1.4);
    const flat = 1.4 / L;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = i * 4;
        const e = z[i] - seaLevel;
        let r, g, b;
        if (ocean[i]) {
          const c = ramp(SEA, -e);
          r = c[1]; g = c[2]; b = c[3];
        } else {
          const zl = z[x > 0 ? i - 1 : i], zr = z[x < W - 1 ? i + 1 : i];
          const zu = z[y > 0 ? i - W : i], zd = z[y < H - 1 ? i + W : i];
          const gx = ((zr - zl) / (2 * CELL_M)) * EXAG;
          const gy = ((zd - zu) / (2 * CELL_M)) * EXAG;
          const dot = (gx + gy + 1.4) / (Math.hypot(gx, gy, 1) * L);
          const shade = Math.max(0.45, Math.min(1.35, dot / flat));
          if (ice[i]) {
            r = 226 * shade; g = 234 * shade; b = 240 * shade;
          } else if (lake[i]) {
            r = 84; g = 138; b = 174;
          } else {
            const c = ramp(LAND, e);
            r = c[1] * shade; g = c[2] * shade; b = c[3] * shade;
          }
        }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
      }
    }
    this.tctx.putImageData(this.image, 0, 0);

    const { w, h } = this.fit();
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.terrain, 0, 0, w, h);

    // Rivers: one path per width class, thinnest first.
    const sx = w / W, sy = h / H;
    const cell = Math.min(sx, sy);
    const CLASSES = 10;
    const paths = Array.from({ length: CLASSES }, () => new Path2D());
    const used = new Uint8Array(CLASSES);
    for (let i = 0; i < W * H; i++) {
      if (ocean[i] || lake[i]) continue;
      const q = Q[i];
      if (q < 3e6) continue;
      const r = rec[i];
      if (r === i) continue;
      const lq = Math.log10(q);
      const k = Math.max(0, Math.min(CLASSES - 1, Math.floor((lq - 6.48) / 0.34)));
      const x0 = ((i % W) + 0.5) * sx, y0 = (((i / W) | 0) + 0.5) * sy;
      const x1 = ((r % W) + 0.5) * sx, y1 = (((r / W) | 0) + 0.5) * sy;
      paths[k].moveTo(x0, y0);
      paths[k].lineTo(x1, y1);
      used[k] = 1;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let k = 0; k < CLASSES; k++) {
      if (!used[k]) continue;
      const t = k / (CLASSES - 1);
      ctx.lineWidth = cell * (0.16 + 1.05 * t * t + 0.12 * t);
      ctx.strokeStyle = `rgba(${46 - 10 * t | 0}, ${112 + 6 * t | 0}, ${178 + 22 * t | 0}, ${0.35 + 0.65 * Math.min(1, t * 1.6)})`;
      ctx.stroke(paths[k]);
    }
  }
}

// A small line chart drawn from the page's colour tokens.
export function drawSpark(canvas, values, { color, fill, grid, zeroLine = null }) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (zeroLine !== null) { lo = Math.min(lo, zeroLine); hi = Math.max(hi, zeroLine); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pad = 3 * dpr;
  const X = (k) => pad + (k / (values.length - 1)) * (w - 2 * pad);
  const Y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  if (zeroLine !== null) {
    ctx.strokeStyle = grid;
    ctx.lineWidth = dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(pad, Y(zeroLine)); ctx.lineTo(w - pad, Y(zeroLine)); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.moveTo(X(0), Y(values[0]));
  for (let k = 1; k < values.length; k++) ctx.lineTo(X(k), Y(values[k]));
  ctx.lineTo(X(values.length - 1), h - pad);
  ctx.lineTo(X(0), h - pad);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(X(0), Y(values[0]));
  for (let k = 1; k < values.length; k++) ctx.lineTo(X(k), Y(values[k]));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  const lx = X(values.length - 1), ly = Y(values[values.length - 1]);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(lx, ly, 2.5 * dpr, 0, Math.PI * 2); ctx.fill();
}
