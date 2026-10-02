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

// Life runs on a grid half as fine as the landscape; sample it bilinearly so
// the living layer reads as smooth country rather than 1 km blocks.
function makeSampler(LW, LH) {
  const w = new Float32Array(4);
  const idx = new Int32Array(4);
  return {
    at(x, y) {
      const fx = Math.min(LW - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const fy = Math.min(LH - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(LW - 1, x0 + 1), y1 = Math.min(LH - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      idx[0] = y0 * LW + x0; idx[1] = y0 * LW + x1; idx[2] = y1 * LW + x0; idx[3] = y1 * LW + x1;
      w[0] = (1 - tx) * (1 - ty); w[1] = tx * (1 - ty); w[2] = (1 - tx) * ty; w[3] = tx * ty;
    },
    get(arr) {
      return arr[idx[0]] * w[0] + arr[idx[1]] * w[1] + arr[idx[2]] * w[2] + arr[idx[3]] * w[3];
    },
    get3(arr, k) {
      return arr[idx[0] * 3 + k] * w[0] + arr[idx[1] * 3 + k] * w[1] + arr[idx[2] * 3 + k] * w[2] + arr[idx[3] * 3 + k] * w[3];
    },
  };
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
    this.selectedRgb = [255, 210, 90];
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

  draw(f) {
    const { W, H, z, ocean, lake, ice, snow, seaLevel } = f;
    const seaT = f.climate.seaT;
    const lf = f.life;
    const LW = lf.LW;
    const speciesMode = this.mode === 'species';
    const sel = lf.selected;
    const S = makeSampler(LW, lf.LH);
    const selRgb = this.selectedRgb;
    if (!this.image || this.image.width !== W || this.image.height !== H) {
      this.terrain.width = W;
      this.terrain.height = H;
      this.image = this.tctx.createImageData(W, H);
    }
    const px = this.image.data;
    // Light from the north-west; slopes exaggerated so relief reads at this
    // scale. A 3×3 Sobel gradient keeps the shading from combing along the
    // grid's diagonals.
    const EXAG = 7;
    const L = Math.hypot(1, 1, 1.4);
    const flat = 1.4 / L;
    const Z = (x, y) => z[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = i * 4;
        const e = z[i] - seaLevel;
        let r, g, b;
        S.at(x, y);
        const bloom = S.get(lf.aqua) / 255;
        if (ocean[i]) {
          const c = ramp(SEA, -e);
          r = c[1]; g = c[2]; b = c[3];
          const a = Math.min(0.5, bloom * 0.5) * (e > -150 ? 1 : 0.5);
          r += (BLOOM[0] - r) * a; g += (BLOOM[1] - g) * a; b += (BLOOM[2] - b) * a;
        } else {
          const gx = ((Z(x + 1, y - 1) + 2 * Z(x + 1, y) + Z(x + 1, y + 1))
            - (Z(x - 1, y - 1) + 2 * Z(x - 1, y) + Z(x - 1, y + 1))) / (8 * CELL_M) * EXAG;
          const gy = ((Z(x - 1, y + 1) + 2 * Z(x, y + 1) + Z(x + 1, y + 1))
            - (Z(x - 1, y - 1) + 2 * Z(x, y - 1) + Z(x + 1, y - 1))) / (8 * CELL_M) * EXAG;
          const dot = (gx + gy + 1.4) / (Math.hypot(gx, gy, 1) * L);
          const shade = Math.max(0.45, Math.min(1.35, dot / flat));
          if (ice[i]) {
            r = 226 * shade; g = 234 * shade; b = 240 * shade;
          } else if (lake[i]) {
            // A lake freezes over when it's well below zero up there.
            const frozen = f.climate.seasonal && seaT - 0.0065 * Math.max(0, e) < -2;
            if (frozen) { r = 200; g = 216; b = 228; } else {
              r = 84; g = 138; b = 174;
              const a = Math.min(0.55, bloom * 0.55);
              r += (BLOOM[0] - r) * a; g += (BLOOM[1] - g) * a; b += (BLOOM[2] - b) * a;
            }
          } else {
            const c = ramp(LAND, e);
            r = c[1] * shade; g = c[2] * shade; b = c[3] * shade;
            // Plants: moss-green when simple, deep forest green when complex;
            // in winter the colour fades with dormancy.
            const cover = S.get(lf.veg) / 255;
            if (cover > 0.01) {
              const cc = S.get(lf.vegC) / 255;
              const t = Math.max(0, Math.min(1, (cc - 0.3) / 0.6));
              const gr = MOSS[0] + (FOREST[0] - MOSS[0]) * t;
              const gg = MOSS[1] + (FOREST[1] - MOSS[1]) * t;
              const gb = MOSS[2] + (FOREST[2] - MOSS[2]) * t;
              let leaf = 1;
              if (f.climate.seasonal) leaf = Math.max(0.35, Math.min(1, (seaT - 0.0065 * Math.max(0, e) - 2) / 10));
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
          const lr = S.get3(lf.rgb, 0), lg = S.get3(lf.rgb, 1), lb = S.get3(lf.rgb, 2);
          const a = Math.min(1, (lr + lg + lb) / 200) * 0.85;
          r = r * 0.55 + (lr - r * 0.55) * a; g = g * 0.55 + (lg - g * 0.55) * a; b = b * 0.55 + (lb - b * 0.55) * a;
        }
        if (sel) {
          const a = Math.min(1, S.get(sel) / 120) * 0.85;
          r = r * 0.6 + (selRgb[0] - r * 0.6) * a; g = g * 0.6 + (selRgb[1] - g * 0.6) * a; b = b * 0.6 + (selRgb[2] - b * 0.6) * a;
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
    this.drawRivers(f, w, h);
  }

  // Each river cell draws one curve: from halfway along the reach coming in
  // from its main tributary, bending through its own point, to halfway along
  // the reach going out. Joined end to end these make smooth channels; a
  // tributary finishes with a short line into the point it joins.
  drawRivers(f, w, h) {
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
    const ctx = this.ctx;
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
