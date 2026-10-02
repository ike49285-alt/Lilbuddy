// sim.js — one world: a seed, a climate, a landscape, and a clock.

import { makeRng, hashArrays } from './rng.js';
import { generateTerrain } from './terrain.js';
import { Climate, SEASONAL_TICK } from './climate.js';
import { Landscape, MAX_STEP_YEARS } from './landscape.js';
import { Life } from './life.js';

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
    this.life = new Life(this.land, this.rng.fork('life'));
    this.life.seed(this.land, this.climate);
    this.sample();
  }

  // Advances the world by dt years (at most MAX_STEP_YEARS).
  step(dt) {
    const d = Math.min(MAX_STEP_YEARS, dt);
    this.years += d;
    this.steps++;
    this.climate.set(this.years, d <= SEASONAL_TICK);
    this.land.step(this.climate, d);
    this.life.step(this.land, this.climate, d, this.years);
    const { cover, toLife } = this.life;
    const landCover = this.land.cover;
    for (let i = 0; i < landCover.length; i++) landCover[i] = cover[toLife[i]];
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

  // --- saving ------------------------------------------------------------------

  // Everything needed to carry on exactly where this world is. Terrain
  // structure (uplift, rock hardness) and the climate are recomputed from
  // the seed; the surface, the snow and life are stored.
  saveState() {
    const { land, life } = this;
    return {
      version: 1,
      seed: this.seed,
      years: this.years,
      steps: this.steps,
      nextSample: this.nextSample,
      history: {
        sea: this.history.sea.slice(), mouthQ: this.history.mouthQ.slice(),
        count: this.history.count, head: this.history.head,
      },
      land: { z: land.z.slice(), fert: land.fert.slice(), snow: land.snow.slice(), cover: land.cover.slice() },
      life: life.saveState(),
    };
  }

  static fromState(state) {
    const sim = new Simulation(state.seed);
    sim.years = state.years;
    sim.steps = state.steps;
    sim.nextSample = state.nextSample;
    sim.history.sea.set(state.history.sea);
    sim.history.mouthQ.set(state.history.mouthQ);
    sim.history.count = state.history.count;
    sim.history.head = state.history.head;
    const { land } = sim;
    land.z.set(state.land.z);
    land.fert.set(state.land.fert);
    land.snow.set(state.land.snow);
    land.cover.set(state.land.cover);
    sim.climate.set(sim.years, false);
    land.prime(sim.climate);
    sim.life.restoreState(state.life);
    return sim;
  }

  // A digest of the evolving state, for checking that a restored world
  // carries on exactly as the original would have.
  stateHash() {
    const arrays = [this.land.z, this.land.snow, this.land.cover];
    for (const sp of this.life.species) arrays.push(sp.N);
    return hashArrays(arrays);
  }

  // What's at one landscape cell, for the tap-to-inspect card.
  inspect(i) {
    const { land, climate, life } = this;
    if (i < 0 || i >= land.N) return null;
    const elev = land.z[i] - climate.seaLevel;
    const c = life.toLife[i];
    return {
      i,
      elevation: elev,
      water: land.ocean[i] ? 'sea' : land.lake[i] ? 'lake' : land.Q[i] >= 2.5e6 ? 'river' : 'land',
      flow: land.ocean[i] ? 0 : land.Q[i],
      temp: climate.tempAt(Math.max(0, elev)),
      meanTemp: climate.meanTempAt(Math.max(0, elev)),
      snow: land.snow[i],
      ice: !!land.ice[i],
      cover: life.cover[c],
      species: life.at(c),
    };
  }

  // Everything the page needs to draw one frame, as fresh transferable copies.
  frame(selectedId) {
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
      life: this.life.frameData(selectedId),
      lifeStats: { ...this.life.stats },
      species: this.life.summary(),
      history: { sea: this.series('sea'), mouthQ: this.series('mouthQ'), everyYears: HISTORY_EVERY },
    };
  }
}

export function stateTransferList(state) {
  const list = [state.history.sea.buffer, state.history.mouthQ.buffer, state.land.z.buffer,
    state.land.fert.buffer, state.land.snow.buffer, state.land.cover.buffer];
  for (const sp of state.life.species) if (sp.N) list.push(sp.N.buffer);
  return list;
}

export function transferList(frame) {
  const L = frame.life;
  const list = [frame.z.buffer, frame.Q.buffer, frame.rec.buffer, frame.ocean.buffer,
    frame.lake.buffer, frame.ice.buffer, frame.snow.buffer, frame.history.sea.buffer, frame.history.mouthQ.buffer,
    L.aqua.buffer, L.veg.buffer, L.vegC.buffer, L.rgb.buffer];
  if (L.selected) list.push(L.selected.buffer);
  return list;
}
