// render.js — draws a frame: sand and grass with hillshade, the water by
// its depth and the sand it carries, clouds and night, the map's colour
// layers, and the effects of the hand tools; and the river's long profile
// and cross-sections as charts.

const MAX_ZOOM = 8;
const EFFECT_MS = { storm: 5000, block: 1800, dig: 1600 };

// Ground: sand and gravel by how high above the water table it stands
// (darker and damper low down), grass and shrubs over it, grey rock.
const SAND_WET = [150, 132, 100], SAND_DRY = [204, 186, 148];
const GRASS = [104, 142, 62], SHRUB = [62, 104, 50];
const WINTER = [150, 140, 100], AUTUMN = [184, 150, 70], SPRING = [126, 178, 72];
const ROCK = [126, 122, 116];
// Water: shallow and clear shows the bed through it, deep is blue; a heavy
// load of sand turns it the colour of the sand.
const SHALLOW = [96, 162, 176], DEEP = [26, 78, 124], SILTY = [150, 122, 82];

// Colour ramps for the map's layers, low to high: [position 0–1, r, g, b].
export const LAYERS = {
  depth: { stops: [[0, 214, 206, 186], [0.02, 170, 220, 230], [0.35, 70, 150, 210], [1, 14, 40, 110]], ticks: ['0', '1', '2', '3 m'] },
  speed: { stops: [[0, 40, 46, 56], [0.3, 60, 120, 170], [0.6, 120, 210, 170], [1, 250, 240, 120]], ticks: ['0', '0.8', '1.7', '2.5 m/s'] },
  drag: { stops: [[0, 50, 54, 62], [0.2, 90, 110, 140], [0.4, 230, 200, 110], [1, 200, 40, 30]], ticks: ['still', 'moves', '×3', '×5'] },
  change: { stops: [[0, 160, 40, 30], [0.35, 230, 150, 110], [0.5, 236, 234, 226], [0.65, 120, 170, 220], [1, 30, 70, 160]], ticks: ['cutting', '', 'steady', '', 'filling'] },
  cutfill: { stops: [[0, 150, 30, 30], [0.4, 236, 170, 130], [0.5, 238, 236, 230], [0.6, 140, 180, 220], [1, 24, 60, 150]], ticks: ['−3 m', '', '0', '', '+3 m'] },
};
const LAYER_LUT = {};
for (const [k, L] of Object.entries(LAYERS)) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = v / 255, s = L.stops;
    let a = s[0], b = s[s.length - 1];
    for (let j = 0; j < s.length - 1; j++) if (t >= s[j][0] && t <= s[j + 1][0]) { a = s[j]; b = s[j + 1]; break; }
    const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    for (let c = 0; c < 3; c++) lut[v * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * u;
  }
  LAYER_LUT[k] = lut;
}

// Where the sun is, for a time in years: how much daylight there is (1 by
// day, 0 at night), how high it stands, how warm the light is at dawn and
// dusk, and which way shadows fall (in cells). Only below an hour per tick
// is there a time of day to show; otherwise it's always day.
export function sunlight(years, yearFrac, tickYears) {
  if (!(tickYears < 1 / 365.25 / 24)) return { day: 1, warm: 0, shadowX: 1.2, shadowY: 1.6, height: 0.7 };
  const hour = ((years * 365.25) % 1) * 24;
  const length = 12 + 3.5 * Math.cos(2 * Math.PI * (yearFrac - 0.47));
  const rise = 12 - length / 2, set = 12 + length / 2;
  let s;
  if (hour >= rise && hour <= set) s = Math.sin((Math.PI * (hour - rise)) / length);
  else s = -Math.sin((Math.PI * ((hour - set + 24) % 24)) / (24 - length));
  const day = Math.max(0, Math.min(1, (s + 0.12) / 0.3));
  const warm = Math.max(0, 1 - Math.abs(s) / 0.22);
  const along = (hour - 12) / (length / 2);
  return { day, warm, height: s, shadowX: -2.5 * Math.max(-1, Math.min(1, along)), shadowY: 1.4 + 1.5 * (1 - Math.max(0, s)) };
}

// The colour the night lays over everything (a multiply, 0–1 per channel):
// moonlit blue, light enough to see by, glowing warm at dawn and dusk.
const NIGHT = [118, 132, 182];
export function nightTint(sun) {
  if (sun.day >= 1) return [1, 1, 1];
  const c = NIGHT.map((v) => v + (255 - v) * sun.day);
  const wm = sun.warm * 0.75;
  return [(c[0] + (255 - c[0]) * wm * 0.4) / 255, (c[1] + (196 - c[1]) * wm) / 255, (c[2] + (150 - c[2]) * wm) / 255];
}

// The grass's colour at a time of year.
function grassAt(yf) {
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  if (yf < 0.18 || yf >= 0.93) return WINTER;
  if (yf < 0.28) return mix(WINTER, SPRING, (yf - 0.18) / 0.1);
  if (yf < 0.4) return mix(SPRING, GRASS, (yf - 0.28) / 0.12);
  if (yf < 0.72) return GRASS;
  if (yf < 0.82) return mix(GRASS, AUTUMN, (yf - 0.72) / 0.1);
  return mix(AUTUMN, WINTER, (yf - 0.82) / 0.11);
}

export class MapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = document.createElement('canvas');
    this.tctx = this.terrain.getContext('2d');
    this.image = null;
    this.mode = 'landscape';
    this.W = 128;
    this.H = 256;
    this.zoom = 1;
    this.x0 = 0;
    this.y0 = 0;
    this.viewAt = 0;
    this.effects = [];
    this.fx = null;
  }

  setEffectsCanvas(c) {
    this.fx = c;
    this.fxCtx = c.getContext('2d');
  }

  // --- view ----------------------------------------------------------------

  setView(zoom, x0, y0) {
    const z = Math.max(1, Math.min(MAX_ZOOM, zoom));
    const vw = this.W / z, vh = this.H / z;
    this.zoom = z;
    this.x0 = Math.max(0, Math.min(this.W - vw, x0));
    this.y0 = Math.max(0, Math.min(this.H - vh, y0));
    this.viewAt = performance.now();
  }

  zoomAt(factor, fx, fy) {
    const vw = this.W / this.zoom, vh = this.H / this.zoom;
    const wx = this.x0 + fx * vw, wy = this.y0 + fy * vh;
    const z = Math.max(1, Math.min(MAX_ZOOM, this.zoom * factor));
    this.setView(z, wx - fx * (this.W / z), wy - fy * (this.H / z));
  }

  panBy(dfx, dfy) {
    this.setView(this.zoom, this.x0 - dfx * (this.W / this.zoom), this.y0 - dfy * (this.H / this.zoom));
  }

  lookAt(wx, wy, zoom) {
    const z = Math.max(1, Math.min(MAX_ZOOM, zoom));
    this.setView(z, wx - this.W / z / 2, wy - this.H / z / 2);
  }

  resetView() {
    this.setView(1, 0, 0);
  }

  toWorld(fx, fy) {
    return [this.x0 + fx * (this.W / this.zoom), this.y0 + fy * (this.H / this.zoom)];
  }

  viewKey() {
    return `${this.zoom.toFixed(5)},${this.x0.toFixed(4)},${this.y0.toFixed(4)},${this.canvas.width},${this.canvas.height}`;
  }

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

  // Hillshade from the north-west with a 3×3 Sobel gradient, the slopes
  // exaggerated so a metre of bank reads at this scale.
  hillshade(f) {
    const { W, H, z, h } = f;
    // The relief changes slowly: a few times a second is plenty, but at once
    // when the ground has been reshaped by hand.
    const now = performance.now();
    if (this.shade && this.shade.length === W * H && f.terrainEpoch === this.shadeEpoch && now - this.shadeAt < 400) return;
    this.shadeAt = now;
    this.shadeEpoch = f.terrainEpoch;
    if (!this.shade || this.shade.length !== W * H) { this.shade = new Float32Array(W * H); this.surf = new Float32Array(W * H); }
    const out = this.shade, sf = this.surf;
    // The surface the light falls on: the water's where there's water.
    for (let i = 0; i < W * H; i++) sf[i] = z[i] + (h[i] > 0.05 ? h[i] : 0);
    const EXAG = 1.6 / (8 * f.cell);
    const L = Math.hypot(1, 1, 1.4);
    const flat = 1.4 / L;
    for (let y = 0; y < H; y++) {
      const ym = (y > 0 ? y - 1 : 0) * W, y0 = y * W, yp = (y < H - 1 ? y + 1 : H - 1) * W;
      for (let x = 0; x < W; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1;
        const gx = ((sf[ym + xp] + 2 * sf[y0 + xp] + sf[yp + xp]) - (sf[ym + xm] + 2 * sf[y0 + xm] + sf[yp + xm])) * EXAG;
        const gy = ((sf[yp + xm] + 2 * sf[yp + x] + sf[yp + xp]) - (sf[ym + xm] + 2 * sf[ym + x] + sf[ym + xp])) * EXAG;
        const dot = (gx + gy + 1.4) / (Math.sqrt(gx * gx + gy * gy + 1) * L);
        out[y0 + x] = Math.max(0.5, Math.min(1.3, dot / flat));
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
    const { W, H, z, h, cover, rock, mud, seaLevel } = f;
    if (!this.image || this.image.width !== W || this.image.height !== H) {
      this.terrain.width = W;
      this.terrain.height = H;
      this.image = this.tctx.createImageData(W, H);
    }
    if (!this.flat) this.hillshade(f);
    const layerLut = f.layer ? LAYER_LUT[this.mode] : null;
    const layer = layerLut ? f.layer : null;
    const grass = grassAt(f.climate.yearFrac || 0);
    const px = this.image.data;
    const N = W * H;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const shade = this.flat ? 1 : this.shade[i];
      const d = h[i];
      let r, g, b;
      if (layer) {
        const v = layer[i] * 3;
        r = layerLut[v]; g = layerLut[v + 1]; b = layerLut[v + 2];
        r *= shade; g *= shade; b *= shade;
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
        continue;
      }
      if (rock[i]) {
        r = ROCK[0]; g = ROCK[1]; b = ROCK[2];
      } else {
        // Sand: damp and dark near the water's level, pale and dry above it.
        const above = Math.max(0, Math.min(1, (z[i] - seaLevel - 0.2) / 2.5));
        r = SAND_WET[0] + (SAND_DRY[0] - SAND_WET[0]) * above;
        g = SAND_WET[1] + (SAND_DRY[1] - SAND_WET[1]) * above;
        b = SAND_WET[2] + (SAND_DRY[2] - SAND_WET[2]) * above;
        const c = cover[i] / 255;
        if (c > 0.02) {
          // Thicker cover is shrubbier and darker.
          const t = c * c;
          const gr = grass[0] + (SHRUB[0] - grass[0]) * t * 0.6, gg = grass[1] + (SHRUB[1] - grass[1]) * t * 0.6, gb = grass[2] + (SHRUB[2] - grass[2]) * t * 0.6;
          const a = Math.min(1, c * 1.15);
          r += (gr - r) * a; g += (gg - g) * a; b += (gb - b) * a;
        }
      }
      r *= shade; g *= shade; b *= shade;
      if (d > 0.01) {
        // Water over it: tinted by depth, browned by the sand it carries.
        const a = Math.min(0.92, 0.25 + d * 0.9);
        const deep = Math.min(1, d / 2);
        let wr = SHALLOW[0] + (DEEP[0] - SHALLOW[0]) * deep, wg = SHALLOW[1] + (DEEP[1] - SHALLOW[1]) * deep, wb = SHALLOW[2] + (DEEP[2] - SHALLOW[2]) * deep;
        const m = mud ? Math.max(0, Math.min(1, (mud[i] / 255 - 0.3) / 0.5)) * 0.7 : 0;
        wr += (SILTY[0] - wr) * m; wg += (SILTY[1] - wg) * m; wb += (SILTY[2] - wb) * m;
        const ws = 0.85 + 0.15 * shade;
        r += (wr * ws - r) * a; g += (wg * ws - g) * a; b += (wb * ws - b) * a;
      }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
    this.tctx.putImageData(this.image, 0, 0);
    this.painted = (this.painted || 0) + 1;
  }

  // Puts the current view on screen from the cached cell image. Cheap enough
  // to run on every move of a finger.
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
    const s = w / vw;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    // The pump's outlet at the top.
    const [ix, ihalf] = f.inlet;
    const ipx = (ix - this.x0) * s, ipy = (0 - this.y0) * s;
    if (ipy > -20 * dpr) {
      ctx.fillStyle = 'rgba(29, 40, 39, 0.75)';
      ctx.fillRect(ipx - (ihalf + 1) * s, ipy, (2 * ihalf + 2) * s, Math.max(3 * dpr, 0.8 * s));
    }
    if (f.section) this.drawSectionLine(ctx, f.section.line, s, dpr);
    if (this.mode === 'landscape') {
      const sun = sunlight(f.years, f.climate.yearFrac || 0, f.tickYears);
      if (f.cloud) this.drawClouds(f, ctx, w, h, sun);
      if (sun.day < 1) {
        const c = nightTint(sun);
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = `rgb(${c[0] * 255 | 0}, ${c[1] * 255 | 0}, ${c[2] * 255 | 0})`;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  drawSectionLine(ctx, line, s, dpr) {
    const [x0, y0, x1, y1] = line;
    const a = [(x0 - this.x0) * s, (y0 - this.y0) * s], b = [(x1 - this.x0) * s, (y1 - this.y0) * s];
    ctx.lineCap = 'round';
    for (const [wd, st] of [[5, 'rgba(29,40,39,0.5)'], [2, 'rgba(255,255,255,0.95)']]) {
      ctx.lineWidth = wd * dpr;
      ctx.strokeStyle = st;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    for (const [p, lab] of [[a, 'A'], [b, 'B']]) {
      ctx.beginPath(); ctx.arc(p[0], p[1], 4 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.font = `600 ${11 * dpr}px Barlow, sans-serif`;
      ctx.fillStyle = 'rgba(29,40,39,0.9)';
      ctx.fillText(lab, p[0] + 6 * dpr, p[1] - 6 * dpr);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
    }
  }

  // Clouds, soft and upscaled, with their shadow cast away from the sun.
  drawClouds(f, ctx, w, h, sun) {
    const cv = this.cloudLayer(f), sv = this.shadowCv;
    const k = f.cloudW / f.W;
    const vw = this.W / this.zoom, vh = this.H / this.zoom;
    const cell = w / vw;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sv, this.x0 * k, this.y0 * k, vw * k, vh * k, sun.shadowX * cell * 3, sun.shadowY * cell * 3, w, h);
    ctx.drawImage(cv, this.x0 * k, this.y0 * k, vw * k, vh * k, 0, 0, w, h);
  }

  cloudLayer(f) {
    const CW = f.cloudW, CH = f.cloudH;
    if (!this.cloudCv) {
      this.cloudCv = document.createElement('canvas');
      this.shadowCv = document.createElement('canvas');
    }
    const cv = this.cloudCv, sv = this.shadowCv;
    if (cv.width !== CW || cv.height !== CH) { cv.width = sv.width = CW; cv.height = sv.height = CH; this.cloudOf = null; }
    if (this.cloudOf !== f.cloud) {
      this.cloudOf = f.cloud;
      const cimg = cv.getContext('2d').createImageData(CW, CH), simg = sv.getContext('2d').createImageData(CW, CH);
      const cd = cimg.data, sd = simg.data;
      for (let c = 0; c < CW * CH; c++) {
        const d = f.cloud[c] / 255;
        const a = Math.min(0.6, d * 0.7);
        if (a <= 0) continue;
        const grey = 250 - 110 * Math.max(0, Math.min(1, (d - 0.5) / 0.5));
        const o = c * 4;
        cd[o] = grey; cd[o + 1] = grey; cd[o + 2] = grey + 4; cd[o + 3] = a * 255;
        sd[o] = 20; sd[o + 1] = 26; sd[o + 2] = 34; sd[o + 3] = a * 0.35 * 255;
      }
      cv.getContext('2d').putImageData(cimg, 0, 0);
      sv.getContext('2d').putImageData(simg, 0, 0);
    }
    return cv;
  }

  // --- effects ----------------------------------------------------------------

  addEffect(ev) {
    if (!EFFECT_MS[ev.kind]) return;
    this.effects.push({ ev, t0: performance.now(), dur: EFFECT_MS[ev.kind] });
    if (this.effects.length > 8) this.effects.shift();
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
    const vw = this.W / this.zoom;
    const flatS = w / vw;
    const at = this.projector
      ? (wx, wy) => this.projector(wx, wy, w, h)
      : (wx, wy) => ({ x: (wx - this.x0) * flatS, y: (wy - this.y0) * flatS, s: flatS });
    for (const e of this.effects) {
      const t = (now - e.t0) / 1000;
      const fade = 1 - (now - e.t0) / e.dur;
      const c = at(e.ev.x, e.ev.y);
      if (!c) continue;
      const r = Math.max(e.ev.r * c.s, 10 * dpr);
      if (e.ev.kind === 'storm') {
        for (let k = 0; k < 3; k++) {
          const p = ((t * 0.6 + k / 3) % 1);
          ctx.strokeStyle = `rgba(120,170,230,${0.7 * fade * (1 - p)})`;
          ctx.lineWidth = 2.5 * dpr;
          ctx.beginPath(); ctx.arc(c.x, c.y, r * (0.4 + 1.6 * p), 0, Math.PI * 2); ctx.stroke();
        }
      } else {
        ctx.strokeStyle = `rgba(255,255,255,${0.8 * fade})`;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.arc(c.x, c.y, r * (0.3 + 0.7 * Math.min(1, t * 2)), 0, Math.PI * 2); ctx.stroke();
      }
    }
    this.drawShaping(ctx, at, dpr);
    return true;
  }

  // While shaping by hand: the line being drawn, or the brush.
  drawShaping(ctx, at, dpr) {
    const path = this.digPath;
    if (path && path.length) {
      const section = this.digKind === 'section';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = section ? [path[0], path[path.length - 1]] : path;
      for (const [width, style] of [[7, 'rgba(29,40,39,0.55)'], [3.5, section ? 'rgba(255,255,255,0.95)' : 'rgba(120,200,255,0.95)']]) {
        ctx.lineWidth = width * dpr;
        ctx.strokeStyle = style;
        ctx.beginPath();
        let open = false;
        for (const [x, y] of pts) {
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

// A profile chart: the bed now (filled), the water over it, and the bed at
// the start (dashed), against distance in metres. Returns the y range drawn.
export function drawProfile(canvas, data, { bed, bedFill, water, start, grid, text }, labels) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const n = data.bed.length;
  if (n < 2) return null;
  let lo = Infinity, hi = -Infinity;
  for (const arr of [data.bed, data.start, data.water]) for (const v of arr) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1, hi - lo);
  lo -= span * 0.08; hi += span * 0.12;
  const padL = 30 * dpr, padR = 6 * dpr, padT = 6 * dpr, padB = 16 * dpr;
  const X = (k) => padL + (k / (n - 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  // Gridlines every round number of metres.
  const step = [0.5, 1, 2, 5, 10][[0.5, 1, 2, 5, 10].findIndex((s) => (hi - lo) / s <= 5)] || 10;
  ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
  ctx.fillStyle = text;
  ctx.strokeStyle = grid;
  ctx.lineWidth = dpr;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke();
    ctx.fillText(`${Number(v.toFixed(1))} m`, 2 * dpr, Y(v) + 3 * dpr);
  }
  if (labels) {
    ctx.fillText(labels[0], padL, h - 3 * dpr);
    const tw = ctx.measureText(labels[1]).width;
    ctx.fillText(labels[1], w - padR - tw, h - 3 * dpr);
  }
  // Water first, then the bed over it.
  ctx.fillStyle = water;
  ctx.beginPath();
  let open = false;
  for (let k = 0; k < n; k++) {
    const v = data.water[k];
    if (!Number.isFinite(v)) {
      if (open) { ctx.lineTo(X(k - 1), Y(lo)); ctx.closePath(); open = false; }
      continue;
    }
    if (!open) { ctx.moveTo(X(k), Y(lo)); open = true; }
    ctx.lineTo(X(k), Y(v));
    if (k === n - 1) { ctx.lineTo(X(k), Y(lo)); ctx.closePath(); }
  }
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(X(0), Y(lo));
  for (let k = 0; k < n; k++) ctx.lineTo(X(k), Y(data.bed[k]));
  ctx.lineTo(X(n - 1), Y(lo));
  ctx.closePath();
  ctx.fillStyle = bedFill;
  ctx.fill();
  ctx.beginPath();
  for (let k = 0; k < n; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, X(k), Y(data.bed[k]));
  ctx.strokeStyle = bed;
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.beginPath();
  for (let k = 0; k < n; k++) (k ? ctx.lineTo : ctx.moveTo).call(ctx, X(k), Y(data.start[k]));
  ctx.strokeStyle = start;
  ctx.lineWidth = 1.2 * dpr;
  ctx.stroke();
  ctx.setLineDash([]);
  return [lo, hi];
}
