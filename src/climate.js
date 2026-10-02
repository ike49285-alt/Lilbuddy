// climate.js — ice ages and long eras. Everything here is a pure function of
// the time in years and the seed, so it never needs saving.

import { makeNoise2D } from './rng.js';

const LAPSE = 0.0065;          // °C per metre
const ICE_T = -1.5;            // mean annual temperature below which ice holds
const BASE_T = 15;             // sea-level temperature with no glaciation
const GLACIAL_COOLING = 9;     // °C colder at a full glacial maximum
const GLACIAL_SEA_DROP = 115;  // metres

export class Climate {
  constructor(rng) {
    const r = rng.fork('climate');
    this.drift = makeNoise2D(r.fork('drift'));
    this.wet = makeNoise2D(r.fork('wet'));
    // Phase offsets so different seeds' ice ages don't line up.
    this.p1 = r.range(0, Math.PI * 2);
    this.p2 = r.range(0, Math.PI * 2);
    this.p3 = r.range(0, Math.PI * 2);
    this.set(0);
  }

  // Recomputes the climate for year t.
  set(t) {
    const kyr = t / 1000;
    // Icehouse ↔ hothouse over millions of years: 0 = warm, 1 = cold.
    const era = Math.max(0, Math.min(1, 0.55 + 0.7 * this.drift(t / 1.6e6, 0.37)));
    // Orbital forcing — obliquity (41k), eccentricity (100k), precession (23k).
    const orbital = 0.45 * Math.sin((kyr / 41) * Math.PI * 2 + this.p1)
      + 0.4 * Math.sin((kyr / 100) * Math.PI * 2 + this.p2)
      + 0.15 * Math.sin((kyr / 23) * Math.PI * 2 + this.p3);
    // Glaciation only bites in a cold era; in a hothouse the cycles barely register.
    const swing = Math.pow(orbital * 0.5 + 0.5, 1.3);
    const glacial = Math.max(0, Math.min(1, swing * (0.38 + 1.1 * era) - 0.1));

    this.t = t;
    this.era = era;
    this.glacial = glacial;
    this.seaT = BASE_T - 4 * (era - 0.5) - GLACIAL_COOLING * glacial;
    this.seaLevel = -GLACIAL_SEA_DROP * glacial + 12 * (0.5 - era);
    // Ice ages are dry; long wet and dry spells come from their own noise.
    const spell = this.wet(t / 6e5, 0.81);
    // A young world starts nearly dry; the rains build over the first
    // few hundred thousand years, so the river begins as a trickle.
    const youth = Math.min(1, 0.03 + t / 3.5e5);
    this.precip = Math.max(0.02, (1.05 - 0.45 * glacial) * (1 + 0.35 * spell) * youth * youth);
  }

  tempAt(elev) {
    return this.seaT - LAPSE * Math.max(0, elev);
  }

  // Annual precipitation in metres at an elevation — more on the mountains.
  precipAt(elev) {
    return this.precip * (1 + Math.max(0, elev) / 1400);
  }

  iceAt(elev) {
    return this.tempAt(elev) < ICE_T;
  }

  label() {
    const era = this.era > 0.62 ? 'icehouse' : this.era < 0.38 ? 'hothouse' : 'temperate';
    const phase = this.glacial > 0.55 ? 'glacial' : this.glacial > 0.2 ? 'cooling' : 'interglacial';
    return `${phase} · ${era}`;
  }
}
