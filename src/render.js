// render.js — draws a frame: hypsometric terrain with hillshade, the sea,
// lakes and ice, and the rivers as lines whose width follows their discharge.

const CELL_M = 500;
const MAX_ZOOM = 8;
const SETTLE_MS = 120;   // the view has stopped moving; redraw the rivers sharp
const EFFECT_MS = { meteor: 3500, volcano: 5000, lightning: 4000, flood: 5000 };
const SPECKS = 600;      // most animal specks drawn in one view

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
const SPRING = [122, 184, 74];
const GOLD = [204, 150, 46], RUST = [178, 82, 40];
// Ground mode: bedrock (granite, sandstone, shale, limestone, basalt) and
// loose cover (sand and silt, soil, scree), which veils the rock under it
// more the deeper it lies.
export const ROCK_RGB = [[200, 168, 162], [198, 132, 96], [110, 120, 136], [228, 220, 194], [56, 54, 58]];
export const COVER_RGB = [null, [232, 210, 154], [124, 92, 62], [158, 154, 148]];
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

// Where the sun is, for a time in years: how much daylight there is (1 by
// day, 0 at night), how high it stands (the sine of its elevation), how warm the light is at dawn and dusk, and which way
// shadows fall (in cells). Days are longer in summer. Only below a day per
// tick is there a time of day to show; otherwise it's always day.
export function sunlight(years, yearFrac, tickYears) {
  if (!(tickYears < 1 / 365.25)) return { day: 1, warm: 0, shadowX: 1.2, shadowY: 1.6, height: 0.7 };
  const hour = ((years * 365.25) % 1) * 24;
  const length = 12 + 3.5 * Math.cos(2 * Math.PI * (yearFrac - 0.47));
  const rise = 12 - length / 2, set = 12 + length / 2;
  let s;
  if (hour >= rise && hour <= set) s = Math.sin((Math.PI * (hour - rise)) / length);
  else s = -Math.sin((Math.PI * ((hour - set + 24) % 24)) / (24 - length));
  const day = Math.max(0, Math.min(1, (s + 0.12) / 0.3));
  const warm = Math.max(0, 1 - Math.abs(s) / 0.22);
  // Shadows fall away from the sun: west in the morning, east in the evening.
  const along = (hour - 12) / (length / 2);
  return { day, warm, height: s, shadowX: -2.5 * Math.max(-1, Math.min(1, along)), shadowY: 1.4 + 1.5 * (1 - Math.max(0, s)) };
}

// The colour the night lays over everything (a multiply, 0–1 per channel):
// moonlit blue, dark enough to read as night but light enough to see the
// valley by, glowing warm at dawn and dusk. Used by the flat map and 3D.
const NIGHT = [118, 132, 182];
export function nightTint(sun) {
  if (sun.day >= 1) return [1, 1, 1];
  const c = NIGHT.map((v) => v + (255 - v) * sun.day);
  const wm = sun.warm * 0.75;
  return [(c[0] + (255 - c[0]) * wm * 0.4) / 255, (c[1] + (196 - c[1]) * wm) / 255, (c[2] + (150 - c[2]) * wm) / 255];
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
    this.riverView = null;
    this.selectedRgb = [255, 210, 90];
    // The view: how far it's zoomed in (1 = the whole valley) and the world
    // position, in cells, of its top-left corner.
    this.W = 128;
    this.H = 224;
    this.zoom = 1;
    this.x0 = 0;
    this.y0 = 0;
    this.viewAt = 0;
    this.effects = [];
    this.fx = null;
  }

  // The canvas the disaster effects are drawn on.
  setEffectsCanvas(c) {
    this.fx = c;
    this.fxCtx = c.getContext('2d');
  }

  // --- view ----------------------------------------------------------------

  // Sets the view, keeping it inside the world. The map's box has the
  // world's shape, so at zoom 1 the whole valley fills it exactly.
  setView(zoom, x0, y0) {
    const z = Math.max(1, Math.min(MAX_ZOOM, zoom));
    const vw = this.W / z, vh = this.H / z;
    this.zoom = z;
    this.x0 = Math.max(0, Math.min(this.W - vw, x0));
    this.y0 = Math.max(0, Math.min(this.H - vh, y0));
    this.viewAt = performance.now();
  }

  // Zooms by a factor, keeping the world point under (fx, fy) — fractions of
  // the map's width and height — where it is on screen.
  zoomAt(factor, fx, fy) {
    const vw = this.W / this.zoom, vh = this.H / this.zoom;
    const wx = this.x0 + fx * vw, wy = this.y0 + fy * vh;
    const z = Math.max(1, Math.min(MAX_ZOOM, this.zoom * factor));
    this.setView(z, wx - fx * (this.W / z), wy - fy * (this.H / z));
  }

  // Moves the view by a fraction of the map's width and height.
  panBy(dfx, dfy) {
    this.setView(this.zoom, this.x0 - dfx * (this.W / this.zoom), this.y0 - dfy * (this.H / this.zoom));
  }

  // Centres the view on a world point at the given zoom.
  lookAt(wx, wy, zoom) {
    const z = Math.max(1, Math.min(MAX_ZOOM, zoom));
    this.setView(z, wx - this.W / z / 2, wy - this.H / z / 2);
  }

  resetView() {
    this.setView(1, 0, 0);
  }

  // The world point (in cells) under a fraction of the map's width and height.
  toWorld(fx, fy) {
    return [this.x0 + fx * (this.W / this.zoom), this.y0 + fy * (this.H / this.zoom)];
  }

  viewKey() {
    return `${this.zoom.toFixed(5)},${this.x0.toFixed(4)},${this.y0.toFixed(4)},${this.canvas.width},${this.canvas.height}`;
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
    // Reshaped ground (a crater, a cone) is shaded at once.
    const reshaped = f.terrainEpoch !== this.shadeEpoch;
    if (!reshaped && Math.abs(years - this.shadeYears) < 500 && now - this.shadeAt < 1000) return;
    if (!reshaped && years === this.shadeYears) return;
    this.shadeEpoch = f.terrainEpoch;
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
    this.paint(f);
    this.compose(f);
  }

  // Paints the cell image for a frame: one pixel per cell. With flat set
  // (for the 3D view, which lights the ground itself) there's no hillshade.
  paint(f) {
    const { W, H, z, ocean, lake, ice, snow, seaLevel } = f;
    const seaT = f.climate.seaT;
    const seasonal = f.climate.seasonal;
    const yf = f.climate.yearFrac || 0;
    const lf = f.life;
    const speciesMode = this.mode === 'species';
    const groundMode = this.mode === 'ground';
    const { rock, ground } = f;
    const sel = lf.selected;
    const selRgb = this.selectedRgb;
    if (!this.image || this.image.width !== W || this.image.height !== H) {
      this.terrain.width = W;
      this.terrain.height = H;
      this.image = this.tctx.createImageData(W, H);
    }
    this.tables(W, H, lf.LW, lf.LH);
    this.hillshade(f);
    const { bi, bw } = this;
    if (this.flat && (!this.ones || this.ones.length !== W * H)) this.ones = new Float32Array(W * H).fill(1);
    const SH = this.flat ? this.ones : this.shade;
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
        if (groundMode && !lake[i]) {
          const rc = ROCK_RGB[rock[i]];
          r = rc[0]; g = rc[1]; b = rc[2];
          const gk = ground[i] >> 6;
          if (gk) {
            const cc = COVER_RGB[gk];
            const a = Math.min(1, 0.45 + 0.15 * ((ground[i] & 63) / 4));
            r += (cc[0] - r) * a; g += (cc[1] - g) * a; b += (cc[2] - b) * a;
          }
          r *= shade; g *= shade; b *= shade;
        } else if (ice[i]) {
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
            let gr = MOSS[0] + (FOREST[0] - MOSS[0]) * t;
            let gg = MOSS[1] + (FOREST[1] - MOSS[1]) * t;
            let gb = MOSS[2] + (FOREST[2] - MOSS[2]) * t;
            if (seasonal) {
              // Fresh green in spring; shrubs and trees turn gold and rust in
              // autumn, a little differently from place to place.
              const sp = Math.max(0, 1 - Math.abs(yf - 0.34) / 0.12) * 0.6;
              const au = Math.max(0, 1 - Math.abs(yf - 0.8) / 0.1) * t;
              if (sp > 0) { gr += (SPRING[0] - gr) * sp; gg += (SPRING[1] - gg) * sp; gb += (SPRING[2] - gb) * sp; }
              if (au > 0) {
                const k = ((Math.imul(i, 2654435761) >>> 24) & 255) / 255;
                const ar = GOLD[0] + (RUST[0] - GOLD[0]) * k, ag = GOLD[1] + (RUST[1] - GOLD[1]) * k, ab = GOLD[2] + (RUST[2] - GOLD[2]) * k;
                gr += (ar - gr) * au; gg += (ag - gg) * au; gb += (ab - gb) * au;
              }
            }
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
    this.painted = (this.painted || 0) + 1;
  }

  // Puts the current view on screen from the cached terrain image and river
  // layer. Cheap enough to run on every move of a finger.
  compose(f) {
    if (!this.image) return;
    this.W = f.W;
    this.H = f.H;
    const { w, h } = this.fit();
    const ctx = this.ctx;
    const vw = this.W / this.zoom, vh = this.H / this.zoom;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(this.terrain, this.x0, this.y0, vw, vh, 0, 0, w, h);
    // Rivers change slowly; re-stroking thousands of reaches every frame is
    // the costliest thing on a phone, so they're drawn to their own layer and
    // redrawn only when they've had time to change. While the view moves, the
    // old layer is shifted and stretched to follow, and redrawn sharp once
    // the view has settled.
    const now = performance.now();
    const v = this.riverView;
    const sized = this.rivers.width === w && this.rivers.height === h;
    const sameView = v && v.zoom === this.zoom && v.x0 === this.x0 && v.y0 === this.y0;
    const stale = (now - this.riverAt >= 1000 && f.years !== this.riverYears) || f.terrainEpoch !== this.riverEpoch;
    const settled = now - this.viewAt >= SETTLE_MS;
    if (!sized || !v || (stale && (sameView || settled)) || (!sameView && settled)) {
      if (!sized) { this.rivers.width = w; this.rivers.height = h; }
      this.rctx.clearRect(0, 0, w, h);
      this.drawRivers(f, w, h, this.rctx);
      this.riverYears = f.years;
      this.riverEpoch = f.terrainEpoch;
      this.riverAt = now;
      this.riverView = { zoom: this.zoom, x0: this.x0, y0: this.y0 };
      ctx.drawImage(this.rivers, 0, 0);
    } else if (sameView) {
      ctx.drawImage(this.rivers, 0, 0);
    } else {
      const sx = w / vw;
      const k = v.zoom / this.zoom;
      ctx.drawImage(this.rivers, (v.x0 - this.x0) * sx, (v.y0 - this.y0) * (h / vh), w * k, h * k);
    }
    if (this.mode === 'landscape') {
      if (f.life.fishes) this.drawSpecks(f, ctx, w);
      const sun = sunlight(f.years, f.climate.yearFrac || 0, f.tickYears);
      if (f.cloud) this.drawClouds(f, ctx, w, h, sun);
      if (sun.day < 1) {
        // Night: everything takes the blue of moonlight; dusk and dawn glow.
        const c = nightTint(sun);
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = `rgb(${c[0] * 255 | 0}, ${c[1] * 255 | 0}, ${c[2] * 255 | 0})`;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  // Clouds from the frame's cloud field (one value per kilometre), drawn
  // soft and upscaled, with their shadow cast away from the sun: thin and
  // white, thick and grey where it pours, pale blue-white where it snows.
  drawClouds(f, ctx, w, h, sun) {
    const cv = this.cloudLayer(f), sv = this.shadowCv;
    const vw = this.W / this.zoom, vh = this.H / this.zoom;
    const sx = this.x0 / 2, sy = this.y0 / 2, sw = vw / 2, sh = vh / 2;
    const cell = w / vw;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sv, sx, sy, sw, sh, sun.shadowX * cell, sun.shadowY * cell, w, h);
    ctx.drawImage(cv, sx, sy, sw, sh, 0, 0, w, h);
  }

  // The cloud image (one pixel per kilometre, alpha for thickness) and its
  // shadow, rebuilt when the frame's clouds change.
  cloudLayer(f) {
    const { LW, LH } = f.life;
    if (!this.cloudCv) {
      this.cloudCv = document.createElement('canvas');
      this.shadowCv = document.createElement('canvas');
    }
    const cv = this.cloudCv, sv = this.shadowCv;
    if (cv.width !== LW || cv.height !== LH) { cv.width = sv.width = LW; cv.height = sv.height = LH; this.cloudOf = null; }
    if (this.cloudOf !== f.cloud) {
      this.cloudOf = f.cloud;
      const cimg = cv.getContext('2d').createImageData(LW, LH), simg = sv.getContext('2d').createImageData(LW, LH);
      const cd = cimg.data, sd = simg.data;
      const { z, W } = f;
      const seaT = f.climate.seaT;
      for (let c = 0; c < LW * LH; c++) {
        const d = f.cloud[c] / 255;
        const a = Math.max(0, Math.min(0.85, (d - 0.35) * 1.8));
        if (a <= 0) continue;
        const cx = (c % LW) * 2, cy = ((c / LW) | 0) * 2;
        const e = z[cy * W + cx] - f.seaLevel;
        const snow = seaT - 0.0065 * Math.max(0, e) < 0;
        const grey = 248 - 120 * Math.max(0, Math.min(1, (d - 0.55) / 0.45));
        const o = c * 4;
        cd[o] = snow ? Math.min(255, grey + 10) : grey; cd[o + 1] = snow ? Math.min(255, grey + 14) : grey; cd[o + 2] = snow ? 255 : grey + 4; cd[o + 3] = a * 255;
        sd[o] = 20; sd[o + 1] = 26; sd[o + 2] = 34; sd[o + 3] = a * 0.4 * 255;
      }
      cv.getContext('2d').putImageData(cimg, 0, 0);
      sv.getContext('2d').putImageData(simg, 0, 0);
    }
    return cv;
  }

  // Animals as specks where they're dense: silver shoals in the water, dark
  // herds on land. Each has a fixed home in its cell and wanders around it,
  // so they drift as time runs. A view shows at most about SPECKS of them,
  // a fixed sample of the whole, so zooming in shows more of each place
  // without drawing more in all.
  drawSpecks(f, ctx, w) {
    const vw = f.W / this.zoom;
    const s = w / vw;
    const px = w / Math.max(1, this.canvas.clientWidth);
    const size = px * Math.min(3.2, 1.5 + 0.2 * (this.zoom - 1));
    const fishPath = new Path2D(), herdPath = new Path2D();
    let anyFish = false, anyHerd = false;
    const z = Math.round(size);
    this.speckPoints(f, this.x0, this.y0, vw, f.H / this.zoom, (kind, wx, wy) => {
      const x = Math.round((wx - this.x0) * s), y = Math.round((wy - this.y0) * s);
      if (kind === 0) { fishPath.rect(x, y, Math.round(size * 1.6), z); anyFish = true; }
      else { herdPath.rect(x, y, Math.round(size * 1.3), Math.round(size * 1.3)); anyHerd = true; }
    });
    if (anyFish) { ctx.fillStyle = 'rgba(236, 243, 247, 0.9)'; ctx.fill(fishPath); }
    if (anyHerd) { ctx.fillStyle = 'rgba(48, 32, 22, 0.88)'; ctx.fill(herdPath); }
  }

  // Where the specks are in a window of the world (cells): calls
  // put(kind, x, y) for each, kind 0 for fish and 1 for land animals.
  speckPoints(f, x0, y0, vw, vh, put) {
    const { W, H, ocean, lake, Q } = f;
    const { LW, LH, fishes, herds } = f.life;
    const t = performance.now() / 1000;
    const lx0 = Math.max(0, Math.floor(x0 / 2) - 1), lx1 = Math.min(LW - 1, Math.ceil((x0 + vw) / 2));
    const ly0 = Math.max(0, Math.floor(y0 / 2) - 1), ly1 = Math.min(LH - 1, Math.ceil((y0 + vh) / 2));
    const wet = (i) => ocean[i] || lake[i] || Q[i] >= 2.5e6;
    let total = 0;
    for (let ly = ly0; ly <= ly1; ly++) {
      for (let lx = lx0; lx <= lx1; lx++) {
        const c = ly * LW + lx;
        if (fishes[c] >= 10) total += Math.min(4, Math.ceil(fishes[c] / 60));
        if (herds[c] >= 10) total += Math.min(4, Math.ceil(herds[c] / 60));
      }
    }
    if (!total) return;
    const keep = Math.min(1, SPECKS / total) * 65536;
    for (let ly = ly0; ly <= ly1; ly++) {
      for (let lx = lx0; lx <= lx1; lx++) {
        const c = ly * LW + lx;
        for (let kind = 0; kind < 2; kind++) {
          const d = kind === 0 ? fishes[c] : herds[c];
          if (d < 10) continue;
          const count = Math.min(4, Math.ceil(d / 60));
          for (let k = 0; k < count; k++) {
            let h = Math.imul(c * 8 + k * 2 + kind + 1, 2654435761) >>> 0;
            h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
            if ((Math.imul(h ^ (h >>> 13), 1274126177) >>> 16) >= keep) continue;
            // A sub-cell of the right kind: water for fish, dry ground for herds.
            let i = -1;
            for (let q = 0; q < 4; q++) {
              const sub = (h + q) & 3;
              const ix = lx * 2 + (sub & 1), iy = ly * 2 + (sub >> 1);
              if (ix >= W || iy >= H) continue;
              const j = iy * W + ix;
              if ((kind === 0) === !!wet(j)) { i = j; break; }
            }
            if (i < 0) continue;
            const ph = ((h >>> 20) & 1023) / 163;
            const sp = kind === 0 ? 0.9 + ((h >>> 4) & 7) * 0.12 : 0.25 + ((h >>> 4) & 7) * 0.03;
            const amp = kind === 0 ? 0.28 : 0.18;
            const wx = (i % W) + 0.2 + 0.6 * (((h >>> 8) & 255) / 255) + amp * Math.sin(t * sp + ph);
            const wy = ((i / W) | 0) + 0.2 + 0.6 * (((h >>> 16) & 15) / 15) + amp * Math.cos(t * sp * 0.8 + ph * 1.3);
            put(kind, wx, wy);
          }
        }
      }
    }
  }

  // --- disaster effects ------------------------------------------------------
  //
  // Drawn on their own canvas over the map, so an effect can animate at the
  // display's rate without the terrain being redrawn.

  addEffect(ev, quiet) {
    if (ev.missed || !EFFECT_MS[ev.kind]) return;
    if (quiet && this.effects.length >= 6) return;
    this.effects.push({ ev, t0: performance.now(), dur: EFFECT_MS[ev.kind] || 4000 });
    if (this.effects.length > 12) this.effects.shift();
  }

  // Draws the running effects; returns whether any are still running.
  drawEffects() {
    const fx = this.fx;
    if (!fx) return false;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(fx.clientWidth * dpr)), h = Math.max(1, Math.round(fx.clientHeight * dpr));
    if (fx.width !== w || fx.height !== h) { fx.width = w; fx.height = h; }
    const ctx = this.fxCtx;
    ctx.clearRect(0, 0, w, h);
    const now = performance.now();
    this.effects = this.effects.filter((e) => now - e.t0 < e.dur);
    if (!this.effects.length && !this.digPath && !this.brush) return false;
    // Where a world point lands on this canvas and how many pixels a cell
    // spans there: the flat view's, or the 3D view's when it's showing.
    const vw = this.W / this.zoom;
    const flatS = w / vw;
    const at = this.projector
      ? (wx, wy) => this.projector(wx, wy, w, h)
      : (wx, wy) => ({ x: (wx - this.x0) * flatS, y: (wy - this.y0) * flatS, s: flatS });
    for (const e of this.effects) {
      const t = (now - e.t0) / 1000;
      const fade = 1 - (now - e.t0) / e.dur;
      const ev = e.ev;
      const c = at(ev.x, ev.y);
      if (!c) continue;
      const cx = c.x, cy = c.y, s = c.s;
      const r = Math.max(ev.r * s, 6 * dpr);
      if (ev.kind === 'meteor') {
        if (t < 0.35) {
          const k = t / 0.35;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * (1 + 2.5 * k));
          g.addColorStop(0, `rgba(255,255,255,${0.95 - 0.5 * k})`);
          g.addColorStop(0.5, `rgba(255,236,190,${0.7 - 0.4 * k})`);
          g.addColorStop(1, 'rgba(255,200,120,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(cx, cy, r * (1 + 2.5 * k), 0, Math.PI * 2); ctx.fill();
        }
        const k = Math.min(1, t / 1.5);
        ctx.strokeStyle = `rgba(255,226,170,${0.85 * fade})`;
        ctx.lineWidth = 2.5 * dpr;
        ctx.beginPath(); ctx.arc(cx, cy, r * (1 + 1.6 * k), 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = `rgba(255,120,40,${0.45 * fade * fade})`;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      } else if (ev.kind === 'volcano') {
        const ash = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 3.2);
        ash.addColorStop(0, `rgba(90,86,84,${0.5 * fade})`);
        ash.addColorStop(1, 'rgba(90,86,84,0)');
        ctx.fillStyle = ash;
        ctx.beginPath(); ctx.arc(cx, cy, r * 3.2, 0, Math.PI * 2); ctx.fill();
        const pulse = 0.75 + 0.25 * Math.sin(t * 9);
        const lava = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.2);
        lava.addColorStop(0, `rgba(255,214,90,${0.95 * fade * pulse})`);
        lava.addColorStop(0.45, `rgba(240,90,30,${0.8 * fade * pulse})`);
        lava.addColorStop(1, 'rgba(180,30,10,0)');
        ctx.fillStyle = lava;
        ctx.beginPath(); ctx.arc(cx, cy, r * 1.2, 0, Math.PI * 2); ctx.fill();
      } else if (ev.kind === 'lightning') {
        if (ev.cells) this.fillCells(ctx, ev.cells, at, `rgba(255,${110 + 60 * fade | 0},30,${0.6 * fade})`);
        if (t < 0.12 || (t > 0.2 && t < 0.3)) {
          const [bx, by] = ev.strike || [ev.x, ev.y];
          const b = at(bx, by);
          if (b) this.bolt(ctx, b.x, b.y, ev.id, dpr);
        }
      } else if (ev.kind === 'flood') {
        if (ev.cells) this.fillCells(ctx, ev.cells, at, `rgba(70,150,230,${0.6 * Math.min(1, fade * 1.6)})`);
      }
    }
    this.drawShaping(ctx, at, dpr);
    return true;
  }

  // While shaping by hand: the channel line being drawn, or the brush.
  drawShaping(ctx, at, dpr) {
    const path = this.digPath;
    if (path && path.length) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const [width, style] of [[7, 'rgba(29,40,39,0.55)'], [3.5, 'rgba(120,200,255,0.95)']]) {
        ctx.lineWidth = width * dpr;
        ctx.strokeStyle = style;
        ctx.beginPath();
        let open = false;
        for (const [x, y] of path) {
          const p = at(x, y);
          if (!p) { open = false; continue; }
          if (open) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
          open = true;
        }
        ctx.stroke();
      }
    }
    const b = this.brush;
    if (b) {
      const p = at(b.x, b.y);
      if (p) {
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(6 * dpr, b.r * p.s), 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(29,40,39,0.5)';
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(6 * dpr, b.r * p.s) + 2 * dpr, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  fillCells(ctx, cells, at, style) {
    const W = this.W;
    ctx.fillStyle = style;
    ctx.beginPath();
    for (const c of cells) {
      const p = at((c % W) + 0.5, ((c / W) | 0) + 0.5);
      if (p) ctx.rect(p.x - p.s / 2, p.y - p.s / 2, p.s + 0.5, p.s + 0.5);
    }
    ctx.fill();
  }

  // A jagged bolt from the top of the view down to the strike.
  bolt(ctx, x, y, seed, dpr) {
    let h = Math.imul(seed + 7, 2654435761) >>> 0;
    const rnd = () => { h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h & 0xffff) / 65535 - 0.5; };
    const top = Math.max(0, y - 220 * dpr);
    const steps = 9;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.shadowColor = 'rgba(190,210,255,0.9)';
    ctx.shadowBlur = 10 * dpr;
    ctx.lineWidth = 2.2 * dpr;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.moveTo(x + rnd() * 40 * dpr, top);
    for (let k = 1; k < steps; k++) ctx.lineTo(x + rnd() * 26 * dpr * (1 - k / steps), top + ((y - top) * k) / steps);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.shadowBlur = 0;
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
    // World cells to layer pixels for the current view; reaches outside it
    // (with a cell's margin) aren't stroked.
    const vw = W / this.zoom, vh = H / this.zoom;
    const sx = w / vw, sy = h / vh;
    const ox = this.x0, oy = this.y0;
    const xa = Math.floor(ox) - 2, xb = Math.ceil(ox + vw) + 2;
    const ya = Math.floor(oy) - 2, yb = Math.ceil(oy + vh) + 2;
    // Lines thicken as the view zooms in, but less than the ground does, so
    // a zoomed-in river still reads as a channel rather than a flood.
    const cell = Math.min(sx, sy) / Math.pow(this.zoom, 0.4);
    const CLASSES = 10;
    const paths = Array.from({ length: CLASSES }, () => new Path2D());
    const used = new Uint8Array(CLASSES);
    for (let i = 0; i < N; i++) {
      if (ocean[i] || lake[i] || Q[i] < MIN_Q) continue;
      const r = rec[i];
      if (r === i) continue;
      const cx = i % W, cy = (i / W) | 0;
      if (cx < xa || cx > xb || cy < ya || cy > yb) continue;
      const k = Math.max(0, Math.min(CLASSES - 1, Math.floor((Math.log10(Q[i]) - 6.48) / 0.34)));
      const p = paths[k];
      const xi = (X[i] - ox) * sx, yi = (Y[i] - oy) * sy;
      const xr = (X[r] - ox) * sx, yr = (Y[r] - oy) * sy;
      const d = mainDonor[i];
      if (d >= 0) p.moveTo(((X[d] - ox) * sx + xi) / 2, ((Y[d] - oy) * sy + yi) / 2);
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
