// sim.js — one world: a seed, the valley, the river, the weather and the
// clock, and what the page can do to it.

import { makeRng, hashArrays } from './rng.js';
import { makeTable, CELL_M, TILT, PLAIN_MUD } from './table.js';
import { Flow, WET, SHIELDS_C, SEC_PER_YR, SPONGE } from './flow.js';
import { Weather } from './weather.js';

export { SEC_PER_YR };

const DAY = 1 / 365.25;
const HOUR = DAY / 24;
const HISTORY_LEN = 240;
const MEAN_RAIN = 1 / SEC_PER_YR;          // a metre a year, in metres a second
const BRUSH_R = { small: 2, big: 5, huge: 10 };              // cells
export const BRUSH_RATE = { gentle: 0.5, strong: 3, bulldozer: 10 };   // metres a second at the brush's centre
const BRUSH_NUDGE = 0.1;                   // seconds of brushing each nudge from the page stands for
const DIG_DEPTH = 1.2;                     // metres below the ground either side
const BLOCK_H = 1.5;                       // metres a dropped block stands above the bed

// The world's settings: [natural, least, most].
export const SETTINGS = {
  flow: [15, 2, 80],          // m³/s the pump sends in, before seasons and floods
  tilt: [TILT, 0.0005, 0.006],// the valley's fall, metres per metre
  sea: [0, -2, 2],            // metres higher or lower sea
  supply: [0.6, 0, 2],        // sand fed in, as a share of what the inflow can carry
  mud: [0.2, 0, 2],           // grams of mud in each litre of the pump's water
};
const MUD_DENSITY = 2650;     // grams a litre of solid mud

export class Simulation {
  constructor(seed) {
    this.seed = String(seed);
    this.rng = makeRng(this.seed);
    const table = makeTable(this.rng);
    this.table = table;
    this.W = table.W; this.H = table.H; this.N = table.N;
    this.shoreY = table.shoreY;
    this.flow = new Flow(table);
    this.weather = new Weather(this.rng);
    this.years = 0;
    this.settings = Object.fromEntries(Object.entries(SETTINGS).map(([k, r]) => [k, r[0]]));
    this.tilt = TILT;
    this.epoch = 0;              // bumped whenever the ground is reshaped by hand
    this.events = [];
    this.nextEventId = 1;
    this.sentEvent = 0;
    this.section = null;         // a cross-section line: [x0, y0, x1, y1] in cells
    this.layer = null;
    this.history = { inflow: [], sinuosity: [], every: HOUR, next: 0 };
    this.mudSeaRate = 0;         // m³ a day of mud reaching the open sea, smoothed
    this.lastMudSea = 0;
    this.toSeaRate = 0;          // m³ a day of sand reaching the open sea, smoothed
    this.sandRate = 0;           // m³ a day moving past the middle of the valley, smoothed
    this.lastToSea = 0;
    this.thalwegZ0 = this.thalweg(this.flow.z0, null);
    this.applySettings();
    this.climate();
  }

  // --- time ------------------------------------------------------------------------

  // One hydraulic step, the bed's time running up to `morph` times faster.
  // Returns the years it stood for (0 for a step the bed didn't move in).
  step(morph) {
    this.climate();
    const secs = this.flow.step(morph);
    const yrs = secs / SEC_PER_YR;
    this.years += yrs;
    if (yrs > 0) {
      this.weather.update(this.years, yrs);
      const k = Math.min(1, (yrs * 365.25) / 0.5);     // half a day's smoothing
      const toSea = this.flow.toSea - this.lastToSea;
      this.lastToSea = this.flow.toSea;
      this.toSeaRate += ((toSea / (yrs * 365.25)) - this.toSeaRate) * k;
      const mudSea = this.flow.mudSea - this.lastMudSea;
      this.lastMudSea = this.flow.mudSea;
      this.mudSeaRate += ((mudSea / (yrs * 365.25)) - this.mudSeaRate) * k;
      if (this.years >= this.history.next) this.sample();
    }
    return yrs;
  }

  // The season and the weather into the river: the pump's flow through the
  // year (low in winter, the spring melt, autumn rains) and the floods the
  // weather upstream sends down; rain on the valley itself; plants growing
  // in summer, resting in winter.
  climate() {
    const f = this.flow;
    const yf = this.years % 1;
    const wrap = (a) => { const d = Math.abs(yf - a); return Math.min(d, 1 - d); };
    const season = 0.65 + 1.6 * Math.exp(-((wrap(0.3) / 0.06) ** 2)) + 0.45 * Math.exp(-((wrap(0.85) / 0.07) ** 2));
    const storm = Math.min(4, 1 + 0.6 * Math.max(0, this.weather.upstream - 1));
    f.inflow = this.settings.flow * season * storm;
    // Floods come down muddier.
    f.mudIn = (this.settings.mud / MUD_DENSITY) * Math.min(3, season * storm);
    f.rainRate = MEAN_RAIN * this.weather.intensity;
    f.growth = yf > 0.25 && yf < 0.8 ? 1.6 : 0.15;
    f.sea = this.settings.sea;
    f.supply = this.settings.supply;
  }

  // --- settings and tools -----------------------------------------------------------

  set(key, v) {
    const r = SETTINGS[key];
    if (!r || !Number.isFinite(v)) return;
    this.settings[key] = Math.max(r[1], Math.min(r[2], v));
    this.applySettings();
  }

  // Tilting the table tilts everything on it: the ground, the rock under it
  // and the starting surface it's measured against.
  applySettings() {
    const want = this.settings.tilt;
    if (Math.abs(want - this.tilt) > 1e-9) {
      const { W, H, shoreY } = this;
      const { z, rock, z0 } = this.flow;
      const d = want - this.tilt;
      for (let y = 0; y < H; y++) {
        const dz = d * (shoreY - y) * CELL_M;
        for (let x = 0; x < W; x++) { const i = y * W + x; z[i] += dz; rock[i] += dz; z0[i] += dz; }
      }
      this.tilt = want;
      this.thalwegZ0 = this.thalweg(z0, null);
      this.reshaped();
    }
    this.climate();
  }

  reshaped() {
    this.epoch++;
    this.flow.slumpAll = true;
    this.flow.ranges();
  }

  // Raises or lowers the ground under a soft brush, one nudge's worth.
  // Lowering stops at the rock. Fresh sand, or ground dug into, is bare.
  sculpt(i, size, dir, strength = 'strong') {
    const { W, H } = this;
    const flow = this.flow;
    const { z, rock, cover } = flow;
    if (!(i >= 0 && i < this.N)) return false;
    const r = BRUSH_R[size] || BRUSH_R.big;
    const peak = (BRUSH_RATE[strength] || BRUSH_RATE.strong) * BRUSH_NUDGE;
    const cx = i % W, cy = (i / W) | 0, R = Math.ceil(2 * r);
    for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y++) {
      for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 > R * R) continue;
        const j = y * W + x;
        const dz = dir * peak * Math.exp(-d2 / (r * r));
        // Sand piled up is the plain's own mix; what's scooped away takes the top layer's.
        const nz = dir > 0 ? z[j] + dz : Math.max(rock[j], z[j] + dz);
        const moved = nz - z[j];
        flow.mix(j, moved, moved * (moved > 0 ? PLAIN_MUD : flow.fm[j]));
        z[j] = nz;
        cover[j] *= 1 - Math.min(1, Math.abs(dz) / 0.2);
      }
    }
    this.reshaped();
    return true;
  }

  // Cuts a channel along a drawn line: its bed falls steadily from the higher
  // end to the lower and lies below the ground either side.
  dig(points) {
    const cells = lineCells(this.W, this.H, points);
    if (cells.length < 2) return 0;
    const { W, H } = this;
    const { z, rock } = this.flow;
    let path = cells;
    if (z[path[0]] < z[path[path.length - 1]]) path = path.slice().reverse();
    const on = new Set(path);
    const top = z[path[0]] - DIG_DEPTH, bottom = z[path[path.length - 1]] - DIG_DEPTH;
    let prev = Infinity;
    path.forEach((j, k) => {
      const x = j % W, y = (j / W) | 0;
      let low = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H && !on.has(ny * W + nx)) low = Math.min(low, z[ny * W + nx]);
      }
      const bed = Math.max(rock[j], Math.min(z[j] - DIG_DEPTH, low - 0.6, top + ((bottom - top) * k) / (path.length - 1), prev - 0.002));
      prev = bed;
      if (bed < z[j]) { this.flow.mix(j, bed - z[j], (bed - z[j]) * this.flow.fm[j]); z[j] = bed; }
    });
    this.reshaped();
    this.event('dig', path[path.length >> 1]);
    return path.length;
  }

  // Drops a block of rock that the river can't wear away.
  block(i) {
    const { W, H } = this;
    const { z, rock, cover } = this.flow;
    if (!(i >= 0 && i < this.N)) return;
    const cx = i % W, cy = (i / W) | 0;
    let top = -Infinity;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) if (x >= 0 && y >= 0 && x < W && y < H) top = Math.max(top, z[y * W + x]);
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const j = y * W + x;
        z[j] = top + BLOCK_H;
        rock[j] = z[j];
        cover[j] = 0;
        this.flow.fm[j] = 0;
        this.flow.sm[j] = 0;
      }
    }
    this.reshaped();
    this.event('block', i);
  }

  // Moves the pump along the top edge: the river comes in over x.
  movePump(x) {
    const f = this.flow;
    const half = f.inletHalf;
    f.inletX = Math.max(half + 1, Math.min(this.W - half - 2, Math.round(x)));
    f.ranges();
    this.event('pump', f.inletX);
  }

  // Parks a storm: rain over the valley for a day and a half, and the flood
  // it sends down the river from upstream.
  storm(i) {
    const x = i % this.W, y = (i / this.W) | 0;
    this.weather.park(x, y, this.years);
    this.event('storm', i);
  }

  // Sets the line a cross-section is drawn along.
  setSection(points) {
    if (!points || points.length < 2) { this.section = null; return; }
    const a = points[0], b = points[points.length - 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2) { this.section = null; return; }
    this.section = [a[0], a[1], b[0], b[1]];
  }

  // --- events ----------------------------------------------------------------------

  // What the page flashes on the map: a tool used, a storm parked.
  event(kind, i) {
    const ev = { id: this.nextEventId++, kind, years: this.years, x: (i % this.W) + 0.5, y: ((i / this.W) | 0) + 0.5, r: 8 };
    this.events.push(ev);
    if (this.events.length > 40) this.events.shift();
  }

  takeEvents() {
    const evs = this.events.filter((e) => e.id > this.sentEvent);
    if (evs.length) this.sentEvent = evs[evs.length - 1].id;
    return evs.map((e) => ({ ...e }));
  }

  // --- measuring -------------------------------------------------------------------

  // The river's line down the valley: in each row the wet cell with the
  // lowest bed (or, with h null, the lowest bed in the floodplain).
  thalweg(z, h) {
    const { W, shoreY } = this;
    const out = new Int32Array(shoreY).fill(-1);
    for (let y = 0; y < shoreY; y++) {
      let best = -1;
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (h && h[i] <= 0.1) continue;
        if (best < 0 || z[i] < z[y * W + best]) best = x;
      }
      out[y] = best;
    }
    return out;
  }

  // The channel's width, and its sinuosity: the length of its centre line
  // (smoothed over a few rows, so bars inside it don't count) over the
  // valley's.
  measure() {
    const { W, shoreY } = this;
    const { z, h } = this.flow;
    const line = this.thalweg(z, h);
    const mid = new Float32Array(shoreY).fill(NaN);
    let rows = 0, wide = 0;
    for (let y = 0; y < shoreY; y++) {
      const x = line[y];
      if (x < 0) continue;
      let a = x, b = x;
      while (a > 0 && h[y * W + a - 1] > 0.1) a--;
      while (b < W - 1 && h[y * W + b + 1] > 0.1) b++;
      wide += b - a + 1;
      rows++;
      mid[y] = (a + b) / 2;
    }
    const R = 4;
    let path = 0, prev = NaN, n = 0;
    for (let y = 0; y < shoreY; y++) {
      let sum = 0, k = 0;
      for (let d = -R; d <= R; d++) { const v = mid[y + d]; if (Number.isFinite(v)) { sum += v; k++; } }
      if (!k) continue;
      const c = sum / k;
      if (Number.isFinite(prev)) { path += Math.hypot(c - prev, 1); n++; }
      prev = c;
    }
    return { line, sinuosity: n ? path / n : 1, width: rows ? (wide / rows) * CELL_M : 0 };
  }

  sample() {
    const hst = this.history;
    const m = this.measure();
    hst.inflow.push(this.flow.inflow);
    hst.sinuosity.push(m.sinuosity);
    // Full: keep every other sample and sample half as often.
    if (hst.inflow.length > HISTORY_LEN) {
      hst.inflow = hst.inflow.filter((_, k) => k % 2 === 0);
      hst.sinuosity = hst.sinuosity.filter((_, k) => k % 2 === 0);
      hst.every *= 2;
    }
    hst.next = this.years + hst.every;
  }

  stats(m) {
    const { W, N, shoreY } = this;
    const f = this.flow;
    const { z, h, cover, sy, z0 } = f;
    let plants = 0, land = 0, delta = 0, deepest = 0;
    for (let i = 0; i < N; i++) {
      const y = (i / W) | 0;
      if (y < shoreY) { land++; plants += cover[i]; if (h[i] > deepest) deepest = h[i]; }
      if (z0[i] < this.settings.sea && z[i] > z0[i]) delta += z[i] - z0[i];
    }
    // Sand moving past the middle of the valley.
    const mid = (shoreY >> 1) * W;
    let sand = 0;
    for (let x = 0; x < W; x++) sand += Math.abs(sy[mid + x]);
    sand *= CELL_M * 86400;
    this.sandRate += (sand - this.sandRate) * 0.3;
    return {
      inflow: f.inflow,
      width: m.width,
      sinuosity: m.sinuosity,
      deepest,
      plants: land ? plants / land : 0,
      sand: this.sandRate,
      toSea: this.toSeaRate,
      mudToSea: this.mudSeaRate,
      mudLaid: f.mudLaid,
      delta: delta * CELL_M * CELL_M,
      fedIn: f.fedIn,
      morph: f.morph,
      rain: this.weather.intensity,
    };
  }

  // The long profile: per row of the valley, the thalweg's bed and water,
  // and where the bed lay at the start.
  profile(line) {
    const { W, shoreY } = this;
    const { z, h, z0 } = this.flow;
    const bed = new Float32Array(shoreY), water = new Float32Array(shoreY), start = new Float32Array(shoreY);
    for (let y = 0; y < shoreY; y++) {
      const x = line[y] >= 0 ? line[y] : W >> 1;
      const i = y * W + x;
      bed[y] = z[i];
      water[y] = h[i] > 0.02 ? z[i] + h[i] : NaN;
      const x0 = this.thalwegZ0[y] >= 0 ? this.thalwegZ0[y] : W >> 1;
      start[y] = z0[y * W + x0];
    }
    return { bed, water, start, cell: CELL_M };
  }

  // The cross-section along the line set, if any.
  sectionData() {
    if (!this.section) return null;
    const [x0, y0, x1, y1] = this.section;
    const n = 96;
    const { W, H } = this;
    const { z, h, z0 } = this.flow;
    const bed = new Float32Array(n), water = new Float32Array(n), start = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      const x = Math.max(0, Math.min(W - 1, Math.floor(x0 + (x1 - x0) * t))), y = Math.max(0, Math.min(H - 1, Math.floor(y0 + (y1 - y0) * t)));
      const i = y * W + x;
      bed[k] = z[i];
      water[k] = h[i] > 0.02 ? z[i] + h[i] : NaN;
      start[k] = z0[i];
    }
    return { line: this.section.slice(), bed, water, start, length: Math.hypot(x1 - x0, y1 - y0) * CELL_M };
  }

  // One byte per cell for the map's colour layer.
  layerBytes() {
    const { N } = this;
    const { h, ux, uy, theta, dzRate, z, z0, cover } = this.flow;
    const out = new Uint8Array(N);
    const L = this.layer;
    const mud = L === 'mud' ? this.mudBytes() : null;
    for (let i = 0; i < N; i++) {
      let v = 0;
      if (L === 'depth') v = h[i] > WET ? 0.05 + 0.95 * Math.min(1, h[i] / 3) : 0;
      else if (L === 'speed') v = h[i] > WET ? Math.min(1, Math.hypot(ux[i], uy[i]) / 2.5) : 0;
      else if (L === 'drag') v = h[i] > WET ? Math.min(1, theta[i] / (SHIELDS_C * (1 + 2 * cover[i])) / 5) : 0;
      else if (L === 'change') { const r = dzRate[i]; v = 0.5 + 0.5 * Math.sign(r) * Math.min(1, Math.log10(1 + Math.abs(r) / 0.01) / 3); }
      else if (L === 'cutfill') v = 0.5 + 0.5 * Math.max(-1, Math.min(1, (z[i] - z0[i]) / 3));
      else if (L === 'mud') v = mud ? mud[i] / 255 : 0;
      out[i] = Math.round(v * 255);
    }
    return out;
  }

  // --- the page's view -------------------------------------------------------------

  frame(tickYears = 0) {
    const f = this.flow;
    const m = this.measure();
    const yf = this.years % 1;
    return {
      W: this.W, H: this.H, cell: CELL_M, shoreY: this.shoreY,
      years: this.years,
      z: new Float32Array(f.z),
      h: new Float32Array(f.h),
      rock: this.rockBytes(),
      cover: bytes(f.cover, 255),
      mud: this.mudBytes(),
      soil: bytes(f.fm, 255),
      layer: this.layer ? this.layerBytes() : null,
      seaLevel: this.settings.sea,
      inlet: [this.flow.inletX, this.flow.inletHalf],
      terrainEpoch: this.epoch,
      climate: {
        label: seasonName(yf),
        seasonal: true,
        yearFrac: yf,
        settings: { ...this.settings },
        rain: this.weather.intensity,
      },
      stats: this.stats(m),
      profile: this.profile(m.line),
      section: this.sectionData(),
      history: { inflow: this.history.inflow.slice(), sinuosity: this.history.sinuosity.slice(), every: this.history.every },
      events: this.takeEvents(),
    };
  }

  // Where blocks of rock stand, one byte per cell.
  rockBytes() {
    const { z, rock } = this.flow;
    const out = new Uint8Array(this.N);
    for (let i = 0; i < out.length; i++) if (rock[i] >= z[i] - 0.01) out[i] = 1;
    return out;
  }

  // How much mud the water carries, one byte per cell, for tinting it: from
  // a thousandth of a gram to ten grams a litre, on a log scale.
  mudBytes() {
    const { N } = this;
    const { h, M } = this.flow;
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (h[i] <= WET || M[i] <= 0) continue;
      const gl = (M[i] / h[i]) * MUD_DENSITY;
      out[i] = Math.max(0, Math.min(255, Math.round(((Math.log10(gl) + 3) / 4) * 255)));
    }
    return out;
  }

  // What's at one cell, for the tap-to-inspect card.
  inspect(i) {
    if (!(i >= 0 && i < this.N)) return null;
    const f = this.flow;
    const y = (i / this.W) | 0;
    const wet = f.h[i] > WET;
    return {
      i,
      water: y >= this.H - SPONGE || (wet && y > this.shoreY && f.z[i] < this.settings.sea) ? 'sea' : wet ? (f.h[i] > 0.3 ? 'river' : 'shallows') : 'land',
      elevation: f.z[i] - this.settings.sea,
      depth: wet ? f.h[i] : 0,
      speed: wet ? Math.hypot(f.ux[i], f.uy[i]) : 0,
      sand: Math.hypot(f.sx[i], f.sy[i]) * 86400,            // m³ a day per metre width
      change: f.z[i] - f.z0[i],
      rate: f.dzRate[i],
      cover: f.cover[i],
      mudWater: wet ? (f.M[i] / f.h[i]) * MUD_DENSITY : 0,  // grams a litre
      mudGround: f.fm[i],
      rockBelow: f.z[i] - f.rock[i],
      block: f.rock[i] >= f.z[i] - 0.01,
    };
  }

  // --- saving ----------------------------------------------------------------------

  saveState() {
    const f = this.flow;
    return {
      version: 2,
      kind: 'stream',
      seed: this.seed,
      years: this.years,
      settings: { ...this.settings },
      tilt: this.tilt,
      epoch: this.epoch,
      section: this.section ? this.section.slice() : null,
      history: { ...this.history, inflow: this.history.inflow.slice(), sinuosity: this.history.sinuosity.slice() },
      mudSeaRate: this.mudSeaRate, lastMudSea: this.lastMudSea,
      toSeaRate: this.toSeaRate, sandRate: this.sandRate, lastToSea: this.lastToSea,
      nextEventId: this.nextEventId,
      weather: this.weather.saveState(),
      flow: {
        z: f.z.slice(), h: f.h.slice(), qx: f.qx.slice(), qy: f.qy.slice(), cover: f.cover.slice(), rock: f.rock.slice(),
        z0: f.z0.slice(), dzRate: f.dzRate.slice(), ux: f.ux.slice(), uy: f.uy.slice(),
        fm: f.fm.slice(), sm: f.sm.slice(), M: f.M.slice(),
        mud: { fed: f.mudFed, out: f.mudOut, down: f.mudDown, laid: f.mudLaid, sea: f.mudSea, mark: f.mudMark },
        inletX: f.inletX, dt: f.dt, mNow: f.mNow, fedIn: f.fedIn, toSea: f.toSea, steps: f.steps, plantYears: f.plantYears, waterTime: f.waterTime,
      },
    };
  }

  static fromState(s) {
    const sim = new Simulation(s.seed);
    if (s.kind !== 'stream') return sim;
    const f = sim.flow;
    const F = s.flow;
    for (const k of ['z', 'h', 'qx', 'qy', 'cover', 'rock', 'z0', 'dzRate', 'ux', 'uy']) f[k].set(F[k]);
    // A save from before the ground knew its mud keeps the table's, with clear water.
    if (F.fm) { f.fm.set(F.fm); f.sm.set(F.sm); f.M.set(F.M); }
    if (F.mud) { f.mudFed = F.mud.fed; f.mudOut = F.mud.out; f.mudDown = F.mud.down; f.mudLaid = F.mud.laid; f.mudSea = F.mud.sea; f.mudMark = F.mud.mark; }
    if (F.inletX != null) f.inletX = F.inletX;
    f.dt = F.dt; f.mNow = F.mNow; f.fedIn = F.fedIn; f.toSea = F.toSea; f.steps = F.steps; f.plantYears = F.plantYears; f.waterTime = F.waterTime;
    sim.years = s.years;
    Object.assign(sim.settings, s.settings);
    sim.tilt = s.tilt;
    sim.epoch = s.epoch;
    sim.section = s.section;
    sim.history = { ...s.history, inflow: s.history.inflow.slice(), sinuosity: s.history.sinuosity.slice() };
    if (s.mudSeaRate != null) { sim.mudSeaRate = s.mudSeaRate; sim.lastMudSea = s.lastMudSea; }
    sim.toSeaRate = s.toSeaRate; sim.sandRate = s.sandRate; sim.lastToSea = s.lastToSea;
    sim.nextEventId = s.nextEventId;
    sim.sentEvent = s.nextEventId - 1;
    sim.weather.restoreState(s.weather);
    sim.thalwegZ0 = sim.thalweg(f.z0, null);
    f.ranges();
    sim.climate();
    return sim;
  }

  stateHash() {
    const f = this.flow;
    return hashArrays([f.z, f.h, f.qx, f.qy, f.cover, f.fm, f.sm, f.M]);
  }
}

function bytes(a, k) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) { const v = a[i] * k; out[i] = v > 255 ? 255 : v < 0 ? 0 : v; }
  return out;
}

function seasonName(yf) {
  return yf < 0.2 || yf >= 0.92 ? 'winter' : yf < 0.42 ? 'spring' : yf < 0.7 ? 'summer' : 'autumn';
}

// The cells along a line through the given points (cells, fractional), in order.
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
      if (out.length >= 800) return out;
    }
  }
  return out;
}

export function transferList(f) {
  const list = [f.z.buffer, f.h.buffer, f.rock.buffer, f.cover.buffer, f.mud.buffer, f.soil.buffer,
    f.profile.bed.buffer, f.profile.water.buffer, f.profile.start.buffer];
  if (f.layer) list.push(f.layer.buffer);
  if (f.section) list.push(f.section.bed.buffer, f.section.water.buffer, f.section.start.buffer);
  return list;
}

export function stateTransferList(s) {
  if (!s.flow) return [];
  return Object.values(s.flow).filter((v) => v && v.buffer).map((v) => v.buffer);
}
