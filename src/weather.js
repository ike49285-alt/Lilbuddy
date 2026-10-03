// weather.js — rain you can see. Cloud systems drift in from the sea on a
// prevailing wind, change shape as they go, and the rain falls under them.
//
// The field is a pure function of the seed, the place and the time, so it
// never needs saving. It only moves the rain around: averaged over time at
// any one spot it comes to exactly the climate's rain there, so long ticks,
// which see the average, are unaffected. It's worked out on the life grid
// (1 km cells); its days-long storms only matter at short ticks.

import { makeNoise2D, fbm } from './rng.js';

export const WEATHER_TICK = 7 / 365.25;    // at ticks this short or shorter, rain follows the clouds
const KM_PER_YEAR = 25 * 24 * 365.25;      // the wind carries the weather at about 25 km/h
const SYSTEM_KM = 40;                      // the size of a weather system
const COVER = 0.05;                        // where the cloud field exceeds this, it rains
const SAMPLES = 20000;

export class Weather {
  constructor(rng, LW, LH) {
    const r = rng.fork('weather');
    this.big = makeNoise2D(r.fork('systems'));
    this.small = makeNoise2D(r.fork('cells'));
    this.LW = LW;
    this.LH = LH;
    // Mostly onshore, from the sea (the bottom of the map) toward the
    // mountains, at a slant that differs between worlds.
    const slant = r.range(-0.6, 0.6);
    this.vx = Math.sin(slant);
    this.vy = -Math.cos(slant);
    this.cloud = new Float32Array(LW * LH);   // cloud thickness, 0 … about 1
    this.rain = new Float32Array(LW * LH);    // rain here as a multiple of the climate's
    this.storms = [];                         // set by the page: { x, y, r, start, end, strength }
    // The average of the raw rain over the noise's range, so the field
    // can be scaled to average 1.
    let sum = 0;
    for (let k = 0; k < SAMPLES; k++) {
      const x = (k * 0.6180339887) % 1, y = (k * 0.7548776662) % 1;
      sum += this.raw(x * 4000, y * 4000, 0).rain;
    }
    this.scale = SAMPLES / sum;
  }

  // Clouds and raw rain at a point (km) and time (years): two layers, the
  // big systems and the showers inside them, carried at different speeds so
  // the shapes change as they move.
  raw(xk, yk, t) {
    const d = t * KM_PER_YEAR;
    const bx = (xk - this.vx * d) / SYSTEM_KM, by = (yk - this.vy * d) / (SYSTEM_KM * 1.6);
    const sx = (xk - this.vx * d * 1.3) / (SYSTEM_KM / 4), sy = (yk - this.vy * d * 1.3) / (SYSTEM_KM / 4);
    const c = 0.75 * fbm(this.big, bx, by, 2) + 0.35 * fbm(this.small, sx + 50, sy + 50, 2);
    return { cloud: c, rain: c > COVER ? (c - COVER) ** 1.5 : 0 };
  }

  // The field at year t on the life grid.
  update(t) {
    const { LW, LH, cloud, rain, scale } = this;
    for (let y = 0; y < LH; y++) {
      for (let x = 0; x < LW; x++) {
        const c = y * LW + x;
        const w = this.raw(x + 0.5, y + 0.5, t);
        cloud[c] = Math.max(0, Math.min(1, (w.cloud + 0.15) * 1.6));
        rain[c] = w.rain * scale;
      }
    }
    for (const s of this.storms) {
      if (t < s.start || t > s.end) continue;
      const fade = Math.min(1, (t - s.start) / 0.002, (s.end - t) / 0.002);
      const r2 = s.r * s.r;
      for (let y = Math.max(0, Math.floor(s.y - 2 * s.r)); y <= Math.min(LH - 1, Math.ceil(s.y + 2 * s.r)); y++) {
        for (let x = Math.max(0, Math.floor(s.x - 2 * s.r)); x <= Math.min(LW - 1, Math.ceil(s.x + 2 * s.r)); x++) {
          const g = Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / r2) * fade;
          const c = y * LW + x;
          cloud[c] = Math.min(1, cloud[c] + g);
          rain[c] += s.strength * g;
        }
      }
    }
  }

  saveState() {
    return { storms: this.storms.map((s) => ({ ...s })) };
  }

  restoreState(s) {
    this.storms = s && s.storms ? s.storms.map((x) => ({ ...x })) : [];
  }
}
