// sim.js — one world: a seed, a climate, a landscape, and a clock.

import { makeRng, hashArrays } from './rng.js';
import { generateTerrain, ROCKS, CELL_M } from './terrain.js';
import { Climate, SEASONAL_TICK } from './climate.js';
import { Landscape, MAX_STEP_YEARS } from './landscape.js';
import { Life } from './life.js';
import { Disasters } from './disasters.js';
import { Weather, WEATHER_TICK } from './weather.js';
import { sculpt, dig, lineCells, parkStorm, BRUSH } from './tools.js';

export { MAX_STEP_YEARS };

export const HISTORY_LEN = 240;       // samples kept for the sparklines
export const HISTORY_EVERY = 5000;    // years between samples (240 × 5 kyr = 1.2 Myr)
const STORM_R_CELLS = 12;             // a parked storm's size on the map, for its note

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
    this.disasters = new Disasters(this.rng.fork('disasters'));
    this.weather = new Weather(this.rng, this.life.LW, this.life.LH);
    this.land.toLife = this.life.toLife;
    this.sentEvent = 0;       // the last event id handed to the page
    this.sample();
  }

  // Advances the world by dt years (at most MAX_STEP_YEARS).
  step(dt) {
    const d = Math.min(MAX_STEP_YEARS, dt);
    this.years += d;
    this.steps++;
    this.climate.cooling = this.disasters.coolingAt(this.years);
    this.climate.winter = this.disasters.winterName();
    this.climate.set(this.years, d <= SEASONAL_TICK);
    // At short ticks the rain falls where the clouds are.
    if (d <= WEATHER_TICK) {
      this.weather.update(this.years);
      this.land.rainField = this.weather.rain;
    } else {
      this.land.rainField = null;
    }
    this.land.step(this.climate, d);
    const ashore = this.life.stats.firstLandAnimal;
    this.life.step(this.land, this.climate, d, this.years);
    this.syncCover();
    const st = this.life.stats;
    // Newcomers after a deadly winter get a note, except in the thick of the
    // bombardment, when they come too often; the lone ones are quiet.
    for (const a of this.life.arrived) {
      if (a.trickle || this.disasters.bombard === 'on') continue;
      const kinds = [];
      if (a.plants) kinds.push(`${a.plants} ${a.plants === 1 ? 'plant' : 'plants'}`);
      if (a.animals) kinds.push(`${a.animals} ${a.animals === 1 ? 'animal' : 'animals'}`);
      const names = a.names.slice(0, 3).join(', ') + (a.names.length > 3 ? '…' : '');
      this.disasters.milestone(this, `${kinds.join(' and ')} ${a.names.length === 1 ? 'arrives' : 'arrive'} from beyond the valley: ${names}`, a.at);
    }
    if (ashore === null && st.firstLandAnimal !== null) {
      this.disasters.milestone(this, `The first animal walks out of the water: ${st.firstLandAnimalName}`, st.firstLandAnimalAt);
    }
    this.disasters.natural(this, d);
    if (this.years >= this.nextSample) this.sample();
  }

  // Life's plant cover, handed to the landscape: plants hold the soil.
  syncCover() {
    const { cover, toLife } = this.life;
    const landCover = this.land.cover;
    for (let i = 0; i < landCover.length; i++) landCover[i] = cover[toLife[i]];
  }

  // Drops a disaster from the page at a landscape cell, now.
  disaster(kind, i, size) {
    const ev = this.disasters.trigger(this, kind, i, size);
    this.climate.set(this.years, this.climate.seasonal);
    return ev;
  }

  // --- shaping by hand ------------------------------------------------------------

  // Raises or lowers the ground under a brush; the water re-routes at once.
  sculpt(i, size, dz) {
    const r = BRUSH[size] || BRUSH.small;
    if (!sculpt(this.land, i, r, Math.max(-50, Math.min(50, dz)))) return;
    this.reshaped();
  }

  // Cuts a channel along a line of points (cells).
  dig(points) {
    const { W, H } = this.land;
    const cells = lineCells(W, H, points);
    const n = dig(this.land, cells);
    if (!n) return null;
    this.reshaped();
    const mid = cells[cells.length >> 1];
    return this.disasters.note(this, 'dig', mid, `A channel is cut, ${(n * CELL_M / 1000).toFixed(1)} km long`, 2);
  }

  // How wet the climate is, from 30% to 200% of natural.
  setWetness(v) {
    this.climate.wetness = Math.max(0.3, Math.min(2, Number(v) || 1));
    this.climate.set(this.years, this.climate.seasonal);
  }

  // A heavy storm parks over a cell for a day and a half.
  storm(i) {
    if (!(i >= 0 && i < this.land.N)) return null;
    parkStorm(this.weather, this.land.W, i, this.years);
    if (this.land.rainField) {
      this.weather.update(this.years);
      this.land.rainField = this.weather.rain;
    }
    return this.disasters.note(this, 'storm', i, 'A storm parks over the valley', STORM_R_CELLS);
  }

  reshaped() {
    this.disasters.epoch++;
    this.land.refresh(this.climate);
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
      land: {
        z: land.z.slice(), fert: land.fert.slice(), snow: land.snow.slice(), cover: land.cover.slice(),
        loose: land.loose.slice(), rock: land.rock.slice(),
        water: land.water.slice(), chan: land.chan.slice(), spillIn: land.spillIn.slice(),
        lagActive: land.lagActive, lastDt: land.lastDt,
      },
      life: life.saveState(),
      disasters: this.disasters.saveState(),
      weather: this.weather.saveState(),
      wetness: this.climate.wetness,
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
    // Worlds saved before ground types keep the cover and rock their seed
    // starts with.
    if (state.land.loose) land.loose.set(state.land.loose);
    // Worlds saved before water could stand start dry and fill again.
    if (state.land.water) {
      land.water.set(state.land.water);
      land.chan.set(state.land.chan);
      land.spillIn.set(state.land.spillIn);
      land.lagActive = state.land.lagActive;
      land.lastDt = state.land.lastDt;
    }
    if (state.land.rock) {
      land.rock.set(state.land.rock);
      for (let i = 0; i < land.N; i++) land.kfac[i] = ROCKS[land.rock[i]].k;
    }
    sim.disasters.restoreState(state.disasters);
    sim.climate.wetness = state.wetness || 1;
    sim.weather.restoreState(state.weather);
    if (land.lastDt <= WEATHER_TICK) {
      sim.weather.update(sim.years);
      land.rainField = sim.weather.rain;
    }
    sim.sentEvent = sim.disasters.nextId - 1;
    sim.climate.cooling = sim.disasters.coolingAt(sim.years);
    sim.climate.winter = sim.disasters.winterName();
    sim.climate.set(sim.years, false);
    land.prime(sim.climate);
    sim.life.restoreState(state.life);
    return sim;
  }

  // A digest of the evolving state, for checking that a restored world
  // carries on exactly as the original would have.
  stateHash() {
    const arrays = [this.land.z, this.land.snow, this.land.cover, this.land.loose, this.land.water, this.land.chan];
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
      ground: this.groundAt(i),
      species: life.at(c),
    };
  }

  // Events the page hasn't been sent yet.
  takeEvents() {
    const evs = this.disasters.since(this.sentEvent);
    if (evs.length) this.sentEvent = evs[evs.length - 1].id;
    return evs.map((e) => ({ ...e, cells: e.cells ? e.cells.slice() : undefined }));
  }

  // What's on top at a landscape cell: 0 bare rock, 1 sand and silt laid by
  // water, 2 soil weathered in place, 3 scree on steep ground.
  groundKind(i) {
    const { W, H, z, loose, fert } = this.land;
    if (loose[i] < 0.3) return 0;
    const x = i % W, y = (i / W) | 0;
    let steep = 0;
    if (x > 0) steep = Math.max(steep, Math.abs(z[i] - z[i - 1]));
    if (x < W - 1) steep = Math.max(steep, Math.abs(z[i] - z[i + 1]));
    if (y > 0) steep = Math.max(steep, Math.abs(z[i] - z[i - W]));
    if (y < H - 1) steep = Math.max(steep, Math.abs(z[i] - z[i + W]));
    if (steep / CELL_M > 0.3) return 3;
    if (loose[i] > 3 || fert[i] > 0.003) return 1;
    return 2;
  }

  groundAt(i) {
    const { loose, rock } = this.land;
    const kind = this.groundKind(i);
    const rockName = ROCKS[rock[i]].name;
    if (kind === 0) return { rock: rockName, loose: loose[i], kind: 'bare rock', text: `bare ${rockName}` };
    const name = ['', 'sand and silt', 'soil', 'scree'][kind];
    const m = loose[i];
    const depth = m >= 10 ? `${Math.round(m)} m` : m >= 1 ? `${m.toFixed(1)} m` : `${Math.round(m * 100)} cm`;
    return { rock: rockName, loose: m, kind: name, text: `${depth} of ${name} over ${rockName}` };
  }

  // Ground for drawing: the cover's kind in the top two bits and its depth
  // in the rest, in quarter metres up to 15¾ m.
  groundBytes() {
    const { N, loose } = this.land;
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const d = Math.min(63, Math.round(loose[i] * 4));
      out[i] = (this.groundKind(i) << 6) | d;
    }
    return out;
  }

  // Everything the page needs to draw one frame, as fresh transferable copies.
  frame(selectedId) {
    const { land, climate } = this;
    return {
      W: land.W,
      H: land.H,
      years: this.years,
      z: new Float32Array(land.z),
      water: new Float32Array(land.water),
      Q: land.Q.slice(),
      rec: land.rec.slice(),
      ocean: land.ocean.slice(),
      lake: land.lake.slice(),
      ice: land.ice.slice(),
      snow: snowBytes(land.snow),
      rock: land.rock.slice(),
      ground: this.groundBytes(),
      // Clouds, at the ticks where weather means something.
      cloud: land.rainField ? Uint8Array.from(this.weather.cloud, (v) => Math.round(v * 255)) : null,
      seaLevel: climate.seaLevel,
      climate: {
        label: climate.label(),
        seasonal: climate.seasonal,
        season: climate.seasonal ? climate.season() : null,
        glacial: climate.glacial,
        seaT: climate.seaT,
        precip: climate.precip,
        cooling: climate.cooling,
        wetness: climate.wetness,
        yearFrac: climate.yearFrac,
      },
      stats: { ...land.stats },
      life: this.life.frameData(selectedId),
      lifeStats: { ...this.life.stats },
      terrainEpoch: this.disasters.epoch,
      events: this.takeEvents(),
      species: this.life.summary(),
      history: { sea: this.series('sea'), mouthQ: this.series('mouthQ'), everyYears: HISTORY_EVERY },
    };
  }
}

// Snow depth as bytes for drawing: 2 mm of water per step, capped.
function snowBytes(snow) {
  const out = new Uint8Array(snow.length);
  for (let i = 0; i < snow.length; i++) {
    const v = Math.round(snow[i] * 510);
    out[i] = v > 255 ? 255 : v;
  }
  return out;
}

export function stateTransferList(state) {
  const list = [state.history.sea.buffer, state.history.mouthQ.buffer, state.land.z.buffer,
    state.land.fert.buffer, state.land.snow.buffer, state.land.cover.buffer, state.land.loose.buffer, state.land.rock.buffer,
    state.land.water.buffer, state.land.chan.buffer, state.land.spillIn.buffer];
  for (const sp of state.life.species) if (sp.N) list.push(sp.N.buffer);
  return list;
}

export function transferList(frame) {
  const L = frame.life;
  const list = [frame.z.buffer, frame.Q.buffer, frame.rec.buffer, frame.ocean.buffer, frame.rock.buffer, frame.ground.buffer,
    ...(frame.cloud ? [frame.cloud.buffer] : []),
    frame.lake.buffer, frame.ice.buffer, frame.snow.buffer, frame.history.sea.buffer, frame.history.mouthQ.buffer,
    L.aqua.buffer, L.veg.buffer, L.vegC.buffer, L.rgb.buffer, L.fishes.buffer, L.herds.buffer];
  if (L.selected) list.push(L.selected.buffer);
  return list;
}
