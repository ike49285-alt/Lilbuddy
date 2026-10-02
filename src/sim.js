// sim.js — one world: a seed, a climate, a landscape, and a clock.

import { makeRng } from './rng.js';
import { generateTerrain } from './terrain.js';
import { Climate, SEASONAL_TICK } from './climate.js';
import { Landscape, MAX_STEP_YEARS } from './landscape.js';

export { MAX_STEP_YEARS };

export const HISTORY_LEN = 240;       // samples kept for the sparklines
export const HISTORY_EVERY = 5000;    // years between samples (240 × 5 kyr = 1.2 Myr)

export class Simulation {
  constructor(seed) {
    this.seed = String(seed);
    this.rng = makeRng(this.seed);
    const terrain = generateTerrain(this.rng);
    this.climate = new Climate(this.rng);
    this.land = new Landscape(terrain);
    this.years = 0;
    this.steps = 0;
    this.nextSample = 0;
    this.history = {
      sea: new Float32Array(HISTORY_LEN),
      mouthQ: new Float32Array(HISTORY_LEN),
      count: 0,
      head: 0,
    };
    this.climate.set(0, false);
    this.land.prime(this.climate);
    this.sample();
  }

  // Advances the world by dt years (at most MAX_STEP_YEARS).
  step(dt) {
    const d = Math.min(MAX_STEP_YEARS, dt);
    this.years += d;
    this.steps++;
    this.climate.set(this.years, d <= SEASONAL_TICK);
    this.land.step(this.climate, d);
    if (this.years >= this.nextSample) this.sample();
  }

  sample() {
    const h = this.history;
    h.sea[h.head] = this.climate.seaLevel;
    h.mouthQ[h.head] = this.land.stats.mouthQ;
    h.head = (h.head + 1) % HISTORY_LEN;
    h.count = Math.min(HISTORY_LEN, h.count + 1);
    this.nextSample = (Math.floor(this.years / HISTORY_EVERY) + 1) * HISTORY_EVERY;
  }

  // Oldest-first copy of a history series.
  series(name) {
    const h = this.history;
    const src = h[name];
    const out = new Float32Array(h.count);
    const start = (h.head - h.count + HISTORY_LEN) % HISTORY_LEN;
    for (let k = 0; k < h.count; k++) out[k] = src[(start + k) % HISTORY_LEN];
    return out;
  }

  // Everything the page needs to draw one frame, as fresh transferable copies.
  frame() {
    const { land, climate } = this;
    return {
      W: land.W,
      H: land.H,
      years: this.years,
      z: Float32Array.from(land.z),
      Q: land.Q.slice(),
      rec: land.rec.slice(),
      ocean: land.ocean.slice(),
      lake: land.lake.slice(),
      ice: land.ice.slice(),
      snow: Uint8Array.from(land.snow, (m) => Math.min(255, Math.round(m * 510))),
      seaLevel: climate.seaLevel,
      climate: {
        label: climate.label(),
        seasonal: climate.seasonal,
        season: climate.seasonal ? climate.season() : null,
        glacial: climate.glacial,
        seaT: climate.seaT,
        precip: climate.precip,
      },
      stats: { ...land.stats },
      history: { sea: this.series('sea'), mouthQ: this.series('mouthQ'), everyYears: HISTORY_EVERY },
    };
  }
}

export function transferList(frame) {
  return [frame.z.buffer, frame.Q.buffer, frame.rec.buffer, frame.ocean.buffer,
    frame.lake.buffer, frame.ice.buffer, frame.snow.buffer, frame.history.sea.buffer, frame.history.mouthQ.buffer];
}
