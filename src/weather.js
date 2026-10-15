// weather.js — the rain, and the floods it sends down the river. Weather
// systems tens of kilometres across drift over on the wind: while one
// passes it rains, and the rain that falls on the catchment upstream comes
// down the river as a flood some hours later. Everything here is a function of the seed and the time except
// what's carried over between steps (the water still on its way down),
// which is saved.

import { makeNoise2D, fbm } from './rng.js';

const KM_PER_HOUR = 25;                 // the wind carries the weather at about this
const SYSTEM_KM = 60;                   // the size of a weather system
const CATCH_HOURS = 8;                  // how long the catchment takes to send its rain down
const SAMPLES = 4000;
const HOURS_PER_YEAR = 365.25 * 24;

export class Weather {
  constructor(rng) {
    const r = rng.fork('weather');
    this.big = makeNoise2D(r.fork('systems'));
    this.small = makeNoise2D(r.fork('showers'));
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
    const rain = this.raw(hours) * this.scale;
    this.intensity = rain;
    // The catchment's rain arrives over some hours.
    const k = 1 - Math.exp(-(dtYears * HOURS_PER_YEAR) / CATCH_HOURS);
    this.upstream += (rain - this.upstream) * k;
  }

  saveState() {
    return { upstream: this.upstream, intensity: this.intensity };
  }

  restoreState(s) {
    this.upstream = s && s.upstream != null ? s.upstream : 0;
    this.intensity = s && s.intensity != null ? s.intensity : 0;
  }
}
