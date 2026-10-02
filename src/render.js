// render.js — draws a frame: hypsometric terrain with hillshade, the sea,
// lakes and ice, and the rivers as lines whose width follows their discharge.

const CELL_M = 500;

// Bare ground by elevation (metres): sand and ochre low down, rust-brown and
// grey rock higher, pale scree near the top. Nothing is green until plants
// make it so.
const LAND = [
  [0, 178, 158, 124], [200, 170, 148, 116], [500, 162, 136, 106], [900, 150, 122, 98],
  [1400, 134, 118, 110], [1900, 152, 146, 142], [2400, 200, 196, 194], [2900, 238, 238, 236],
];
const MOSS = [150, 162, 88];
const FOREST = [44, 92, 50];
const BLOOM = [52, 138, 104];
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

// Life runs on a grid half as fine as the landscape; it's sampled
// bilinearly (tables below) so the living layer reads as smooth country
// rather than 1 km blocks.

// Colour lookup tables, 1 m per entry, so drawing doesn't allocate per pixel.
const LAND_LUT_MAX = 3200;
const SEA_LUT_MAX = 2000;
const LAND_LUT = new Uint8ClampedArray((LAND_LUT_MAX + 1) * 3);
const SEA_LUT = new Uint8ClampedArray((SEA_LUT_MAX + 1) * 3);
for (let m = 0; m <= LAND_LUT_MAX; m++) {
  const c = ramp(LAND, m);
  LAND_LUT[m * 3] = c[1]; LAND_LUT[m * 3 + 1] = c[2]; LAND_LUT[m * 3 + 2] = c[3];
}
for (let m = 0; m <= SEA_LUT_MAX; m++) {
  const c = ramp(SEA, m);
  SEA_LUT[m * 3] = c[1]; SEA_LUT[m * 3 + 1] = c[2]; SEA_LUT[m * 3 + 2] = c[3];
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
    this.mode = 'landscape';
    this.rivers = document.createElement('canvas');
    this.rctx = this.rivers.getContext('2d');
    this.riverYears = -Infinity;
    this.riverAt = 0;
    this.selectedRgb = [255, 210, 90];
  }

  // Keeps the backing store matched to the element's size on screen.
  // The terrain image is only 128 × 224 cells, so a 1.5× backing store is
  // as sharp as it gets; going denser costs phones a lot of drawing time.
  fit() {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h };
  }

  // Fixed, per-cell offsets for river points, so channels don't sit on the
  // grid. The same cell always gets the same offset.
  points(W, H) {
    if (this.px && this.px.length === W * H) return;
    this.px = new Float32Array(W * H);
    this.py = new Float32Array(W * H);
    this.mainDonor = new Int32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const h = Math.imul(i + 1, 2654435761) >>> 0;
      const h2 = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
      this.px[i] = (i % W) + 0.5 + ((h & 0xffff) / 65535 - 0.5) * 0.6;
      this.py[i] = ((i / W) | 0) + 0.5 + ((h2 & 0xffff) / 65535 - 0.5) * 0.6;
    }
  }

  // Per-grid tables built once: clamped neighbour indices for the hillshade
  // and the four life cells (with weights) behind each map pixel.
  tables(W, H, LW, LH) {
    if (this.tW === W && this.tH === H) return;
    this.tW = W; this.tH = H;
    const N = W * H;
    this.shade = new Float32Array(N);
    this.shadeYears = -Infinity;
    this.shadeAt = 0;
    this.bi = new Int32Array(N * 4);
    this.bw = new Float32Array(N * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const fx = Math.min(LW - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const fy = Math.min(LH - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(LW - 1, x0 + 1), y1 = Math.min(LH - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        const k = i * 4;
        this.bi[k] = y0 * LW + x0; this.bi[k + 1] = y0 * LW + x1;
        this.bi[k + 2] = y1 * LW + x0; this.bi[k + 3] = y1 * LW + x1;
        this.bw[k] = (1 - tx) * (1 - ty); this.bw[k + 1] = tx * (1 - ty);
        this.bw[k + 2] = (1 - tx) * ty; this.bw[k + 3] = tx * ty;
      }
    }
  }

  // Hillshade from the north-west, slopes exaggerated so relief reads at
  // this scale, with a 3×3 Sobel gradient so the shading doesn't comb along
  // the grid's diagonals. The terrain changes slowly, so this is cached and
  // redone only when it has had time to move.
  hillshade(f) {
    const { W, H, z, years } = f;
    const now = performance.now();
    if (Math.abs(years - this.shadeYears) < 500 && now - this.shadeAt < 1000) return;
    if (years === this.shadeYears) return;
    this.shadeYears = years;
    this.shadeAt = now;
    const out = this.shade;
    const EXAG = 7 / (8 * CELL_M);
    const L = Math.hypot(1, 1, 1.4);
    const flat = 1.4 / L;
    for (let y = 0; y < H; y++) {
      const ym = (y > 0 ? y - 1 : 0) * W, y0 = y * W, yp = (y < H - 1 ? y + 1 : H - 1) * W;
      for (let x = 0; x < W; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1;
        const gx = ((z[ym + xp] + 2 * z[y0 + xp] + z[yp + xp]) - (z[ym + xm] + 2 * z[y0 + xm] + z[yp + xm])) * EXAG;
        const gy = ((z[yp + xm] + 2 * z[yp + x] + z[yp + xp]) - (z[ym + xm] + 2 * z[ym + x] + z[ym + xp])) * EXAG;
        const dot = (gx + gy + 1.4) / (Math.sqrt(gx * gx + gy * gy + 1) * L);
        out[y0 + x] = Math.max(0.45, Math.min(1.35, dot / flat));
      }
    }
  }

  draw(f) {
    const { W, H, z, ocean, lake, ice, snow, seaLevel } = f;
    const seaT = f.climate.seaT;
    const seasonal = f.climate.seasonal;
    const lf = f.life;
    const speciesMode = this.mode === 'species';
    const sel = lf.selected;
    const selRgb = this.selectedRgb;
    if (!this.image || this.image.width !== W || this.image.height !== H) {
      this.terrain.width = W;
      this.terrain.height = H;
      this.image = this.tctx.createImageData(W, H);
    }
    this.tables(W, H, lf.LW, lf.LH);
    this.hillshade(f);
    const { bi, bw, shade: SH } = this;
    const px = this.image.data;
    const { aqua, veg, vegC, rgb } = lf;
    const N = W * H;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const k = i * 4;
      const i0 = bi[k], i1 = bi[k + 1], i2 = bi[k + 2], i3 = bi[k + 3];
      const w0 = bw[k], w1 = bw[k + 1], w2 = bw[k + 2], w3 = bw[k + 3];
      const e = z[i] - seaLevel;
      let r, g, b;
      if (ocean[i]) {
        const d = Math.min(SEA_LUT_MAX, Math.max(0, Math.round(-e))) * 3;
        r = SEA_LUT[d]; g = SEA_LUT[d + 1]; b = SEA_LUT[d + 2];
        const bloom = (aqua[i0] * w0 + aqua[i1] * w1 + aqua[i2] * w2 + aqua[i3] * w3) / 255;
        const a = Math.min(0.5, bloom * 0.5) * (e > -150 ? 1 : 0.5);
        r += (BLOOM[0] - r) * a; g += (BLOOM[1] - g) * a; b += (BLOOM[2] - b) * a;
      } else {
        const shade = SH[i];
        if (ice[i]) {
          r = 226 * shade; g = 234 * shade; b = 240 * shade;
        } else if (lake[i]) {
          // A lake freezes over when it's well below zero up there.
          const frozen = seasonal && seaT - 0.0065 * Math.max(0, e) < -2;
          if (frozen) { r = 200; g = 216; b = 228; } else {
            r = 84; g = 138; b = 174;
            const bloom = (aqua[i0] * w0 + aqua[i1] * w1 + aqua[i2] * w2 + aqua[i3] * w3) / 255;
            const a = Math.min(0.55, bloom * 0.55);
            r += (BLOOM[0] - r) * a; g += (BLOOM[1] - g) * a; b += (BLOOM[2] - b) * a;
          }
        } else {
          const d = Math.min(LAND_LUT_MAX, Math.max(0, Math.round(e))) * 3;
          r = LAND_LUT[d] * shade; g = LAND_LUT[d + 1] * shade; b = LAND_LUT[d + 2] * shade;
          // Plants: moss-green when simple, deep forest green when complex;
          // in winter the colour fades with dormancy.
          const cover = (veg[i0] * w0 + veg[i1] * w1 + veg[i2] * w2 + veg[i3] * w3) / 255;
          if (cover > 0.01) {
            const cc = (vegC[i0] * w0 + vegC[i1] * w1 + vegC[i2] * w2 + vegC[i3] * w3) / 255;
            const t = Math.max(0, Math.min(1, (cc - 0.3) / 0.6));
            const gr = MOSS[0] + (FOREST[0] - MOSS[0]) * t;
            const gg = MOSS[1] + (FOREST[1] - MOSS[1]) * t;
            const gb = MOSS[2] + (FOREST[2] - MOSS[2]) * t;
            let leaf = 1;
            if (seasonal) leaf = Math.max(0.35, Math.min(1, (seaT - 0.0065 * Math.max(0, e) - 2) / 10));
            const a = Math.min(0.9, cover) * (0.55 + 0.45 * leaf);
            r += (gr * shade - r) * a; g += (gg * shade - g) * a; b += (gb * shade - b) * a;
          }
          // Seasonal snow: a dusting shows; ten centimetres covers.
          const depth = snow[i] / 510;
          if (depth > 0.005) {
            const a = Math.min(1, depth / 0.1) * 0.92;
            r += (238 * shade - r) * a; g += (242 * shade - g) * a; b += (247 * shade - b) * a;
          }
        }
      }
      if (speciesMode) {
        const lr = rgb[i0 * 3] * w0 + rgb[i1 * 3] * w1 + rgb[i2 * 3] * w2 + rgb[i3 * 3] * w3;
        const lg = rgb[i0 * 3 + 1] * w0 + rgb[i1 * 3 + 1] * w1 + rgb[i2 * 3 + 1] * w2 + rgb[i3 * 3 + 1] * w3;
        const lb = rgb[i0 * 3 + 2] * w0 + rgb[i1 * 3 + 2] * w1 + rgb[i2 * 3 + 2] * w2 + rgb[i3 * 3 + 2] * w3;
        const a = Math.min(1, (lr + lg + lb) / 200) * 0.85;
        r = r * 0.55 + (lr - r * 0.55) * a; g = g * 0.55 + (lg - g * 0.55) * a; b = b * 0.55 + (lb - b * 0.55) * a;
      }
      if (sel) {
        const a = Math.min(1, (sel[i0] * w0 + sel[i1] * w1 + sel[i2] * w2 + sel[i3] * w3) / 120) * 0.85;
        r = r * 0.6 + (selRgb[0] - r * 0.6) * a; g = g * 0.6 + (selRgb[1] - g * 0.6) * a; b = b * 0.6 + (selRgb[2] - b * 0.6) * a;
      }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
    this.tctx.putImageData(this.image, 0, 0);

    const { w, h } = this.fit();
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(this.terrain, 0, 0, w, h);
    // Rivers change slowly; re-stroking thousands of reaches every frame is
    // the costliest thing on a phone, so they're drawn to their own layer and
    // redrawn only when they've had time to change.
    const now = performance.now();
    const stale = now - this.riverAt >= 1500;
    if (this.rivers.width !== w || this.rivers.height !== h || (stale && f.years !== this.riverYears)) {
      if (this.rivers.width !== w || this.rivers.height !== h) { this.rivers.width = w; this.rivers.height = h; }
      this.rctx.clearRect(0, 0, w, h);
      this.drawRivers(f, w, h, this.rctx);
      this.riverYears = f.years;
      this.riverAt = now;
    }
    ctx.drawImage(this.rivers, 0, 0);
  }

  // Each river cell draws one curve: from halfway along the reach coming in
  // from its main tributary, bending through its own point, to halfway along
  // the reach going out. Joined end to end these make smooth channels; a
  // tributary finishes with a short line into the point it joins.
  drawRivers(f, w, h, ctx) {
    const { W, H, ocean, lake, Q, rec } = f;
    const N = W * H;
    this.points(W, H);
    const { px: X, py: Y, mainDonor } = this;
    const MIN_Q = 3e6;
    mainDonor.fill(-1);
    for (let i = 0; i < N; i++) {
      if (Q[i] < MIN_Q) continue;
      const r = rec[i];
      if (r === i) continue;
      const d = mainDonor[r];
      if (d < 0 || Q[i] > Q[d]) mainDonor[r] = i;
    }
    const sx = w / W, sy = h / H;
    const cell = Math.min(sx, sy);
    const CLASSES = 10;
    const paths = Array.from({ length: CLASSES }, () => new Path2D());
    const used = new Uint8Array(CLASSES);
    for (let i = 0; i < N; i++) {
      if (ocean[i] || lake[i] || Q[i] < MIN_Q) continue;
      const r = rec[i];
      if (r === i) continue;
      const k = Math.max(0, Math.min(CLASSES - 1, Math.floor((Math.log10(Q[i]) - 6.48) / 0.34)));
      const p = paths[k];
      const xi = X[i] * sx, yi = Y[i] * sy;
      const xr = X[r] * sx, yr = Y[r] * sy;
      const d = mainDonor[i];
      if (d >= 0) p.moveTo((X[d] * sx + xi) / 2, (Y[d] * sy + yi) / 2);
      else p.moveTo(xi, yi);
      p.quadraticCurveTo(xi, yi, (xi + xr) / 2, (yi + yr) / 2);
      if (mainDonor[r] !== i || ocean[r] || lake[r]) p.lineTo(xr, yr);
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
  const dpr = Math.min(2, window.devicePixelRatio || 1);
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
