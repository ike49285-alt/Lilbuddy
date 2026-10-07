// weather.js — the sky over the valley, and the floods it sends down the
// river. Weather systems tens of kilometres across drift over on the wind:
// while one passes, clouds cover the map and rain falls, and the rain that
// falls on the catchment upstream comes down the river as a flood some hours
// later. Everything here is a function of the seed and the time except
// what's carried over between steps (the water still on its way down, and
// any storm parked by hand), which is saved.

import { makeNoise2D, fbm } from './rng.js';

const KM_PER_HOUR = 25;                 // the wind carries the weather at about this
const SYSTEM_KM = 60;                   // the size of a weather system
const CELL_KM = 0.004 * 4;              // the cloud grid: 16 m cells
const SHOWER_KM = 0.35;                 // the size of a shower cloud
const CATCH_HOURS = 8;                  // how long the catchment takes to send its rain down
const SAMPLES = 4000;
const HOURS_PER_YEAR = 365.25 * 24;

export const STORM_HOURS = 36;          // a storm parked by hand rains this long

export class Weather {
  constructor(rng, W, H) {
    const r = rng.fork('weather');
    this.big = makeNoise2D(r.fork('systems'));
    this.small = makeNoise2D(r.fork('showers'));
    this.CW = Math.ceil(W / 4);
    this.CH = Math.ceil(H / 4);
    const slant = r.range(-0.8, 0.8);
    this.vx = Math.sin(slant);
    this.vy = -Math.cos(slant);
    this.cloud = new Float32Array(this.CW * this.CH);
    this.storms = [];                   // parked by hand: { x, y, start, end }
    this.upstream = 0;                  // rain on the catchment still coming down, as a multiple of the mean
    this.intensity = 0;                 // how hard it's raining here now, as a multiple of the mean
    // Scale the systems' rain to average 1.
    let sum = 0;
    for (let k = 0; k < SAMPLES; k++) sum += this.raw(k * 37.1);
    this.scale = SAMPLES / sum;
  }

  // Rain from the systems at an hour (any point in the valley: they're far
  // bigger than it), before scaling.
  raw(hours) {
    const d = hours * KM_PER_HOUR;
    const c = 0.8 * fbm(this.big, d / SYSTEM_KM, 0.37, 3) + 0.25 * fbm(this.small, d / (SYSTEM_KM / 5), 5.3, 2);
    return c > 0.08 ? (c - 0.08) ** 1.5 : 0;
  }

  // The weather at year t. dtYears is how far time has moved since the last
  // call, for the water on its way down from upstream.
  update(t, dtYears) {
    const hours = t * HOURS_PER_YEAR;
    let rain = this.raw(hours) * this.scale;
    rain += 12 * this.parked(t);
    this.intensity = rain;
    // The catchment's rain arrives over some hours.
    const k = 1 - Math.exp(-(dtYears * HOURS_PER_YEAR) / CATCH_HOURS);
    this.upstream += (rain - this.upstream) * k;
    if (this.storms.length && this.storms.some((s) => s.end <= t)) this.storms = this.storms.filter((s) => s.end > t);
  }

  // How much a storm parked by hand is raining now, 0..1.
  parked(t) {
    let p = 0;
    for (const s of this.storms) {
      if (t < s.start || t > s.end) continue;
      p = Math.max(p, Math.min(1, (t - s.start) * HOURS_PER_YEAR / 2, (s.end - t) * HOURS_PER_YEAR / 2));
    }
    return p;
  }

  // The clouds over the map at year t, for drawing: shower cells drifting
  // over, as many as the system's rain makes, and a parked storm's.
  clouds(t) {
    const hours = t * HOURS_PER_YEAR;
    const parked = this.parked(t);
    const rain = this.raw(hours) * this.scale + 12 * parked;
    const { CW, CH, cloud } = this;
    const cover = Math.min(0.75, rain / 4);
    const d = hours * KM_PER_HOUR;
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        const xk = x * CELL_KM - this.vx * d, yk = y * CELL_KM - this.vy * d;
        let c = 0.5 + 0.5 * fbm(this.small, xk / SHOWER_KM + 31, yk / SHOWER_KM + 17, 3);
        c = Math.max(0, Math.min(1, (c - (1 - cover)) / 0.25));
        for (const s of this.storms) {
          if (t < s.start || t > s.end) continue;
          const r2 = ((x - s.x / 4) ** 2 + (y - s.y / 4) ** 2) / 80;
          c = Math.max(c, Math.exp(-r2) * parked);
        }
        cloud[y * CW + x] = c;
      }
    }
  }

  park(x, y, t) {
    this.storms = this.storms.filter((s) => s.end > t).slice(-3);
    this.storms.push({ x, y, start: t, end: t + STORM_HOURS / HOURS_PER_YEAR });
  }

  saveState() {
    return { storms: this.storms.map((s) => ({ ...s })), upstream: this.upstream, intensity: this.intensity };
  }

  restoreState(s) {
    this.storms = s && s.storms ? s.storms.map((x) => ({ ...x })) : [];
    this.upstream = s && s.upstream != null ? s.upstream : 0;
    this.intensity = s && s.intensity != null ? s.intensity : 0;
  }
}
