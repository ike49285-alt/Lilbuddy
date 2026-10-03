// climate.js — seasons, ice ages and long eras. Everything here is a pure
// function of the time in years and the seed, so it never needs saving.
//
// Seasons only apply when ticks are short enough to resolve them; with
// longer ticks the climate is the year's average.

import { makeNoise2D } from './rng.js';

const LAPSE = 0.0065;          // °C per metre
const ICE_T = -1.5;            // mean annual temperature below which glaciers hold
const BASE_T = 15;             // sea-level temperature with no glaciation
const GLACIAL_COOLING = 9;     // °C colder at a full glacial maximum
const GLACIAL_SEA_DROP = 115;  // metres
const SEASON_T = 10;           // °C either side of the annual mean at sea level
const SEASON_WET = 0.45;       // winters wetter, summers drier, by this fraction
export const SEASONAL_TICK = 0.25;   // years: ticks this short or shorter see seasons

const SEASONS = ['winter', 'spring', 'summer', 'autumn'];

export class Climate {
  constructor(rng) {
    const r = rng.fork('climate');
    this.drift = makeNoise2D(r.fork('drift'));
    this.wet = makeNoise2D(r.fork('wet'));
    // Phase offsets so different seeds' ice ages don't line up.
    this.p1 = r.range(0, Math.PI * 2);
    this.p2 = r.range(0, Math.PI * 2);
    this.p3 = r.range(0, Math.PI * 2);
    // A short-lived chill from a big eruption or impact, set by the
    // simulation before each set(): degrees of cooling and what caused it.
    this.cooling = 0;
    this.winter = '';
    // How wet the valley is, as set by hand: a multiple of the natural rain.
    this.wetness = 1;
    // Degrees warmer (or colder) and metres higher (or lower) sea, as set by hand.
    this.warmth = 0;
    this.seaShift = 0;
    this.set(0, false);
  }

  // Recomputes the climate for year t. With seasonal = true the temperature
  // and rain follow the time of year; otherwise they're annual means.
  set(t, seasonal) {
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
    this.meanSeaT = BASE_T - 4 * (era - 0.5) - GLACIAL_COOLING * glacial - this.cooling + this.warmth;
    this.seaLevel = -GLACIAL_SEA_DROP * glacial + 12 * (0.5 - era) + this.seaShift;
    // Ice ages are dry; long wet and dry spells come from their own noise.
    const spell = this.wet(t / 6e5, 0.81);
    // A young world starts nearly dry; the rains build over the first
    // few hundred thousand years, so the river begins as a trickle.
    const youth = Math.min(1, 0.03 + t / 3.5e5);
    this.meanPrecip = Math.max(0.02, (1.05 - 0.45 * glacial) * (1 + 0.35 * spell) * youth * youth) * this.wetness;

    // Time of year: 0 is the first of January. Coldest in mid-January,
    // warmest in mid-July; wettest in winter.
    this.seasonal = !!seasonal;
    this.yearFrac = t - Math.floor(t);
    const phase = Math.cos(2 * Math.PI * (this.yearFrac - 0.04));
    this.seaT = this.meanSeaT - (seasonal ? SEASON_T * phase : 0);
    this.precip = this.meanPrecip * (seasonal ? 1 + SEASON_WET * phase : 1);
  }

  tempAt(elev) {
    return this.seaT - LAPSE * Math.max(0, elev);
  }

  meanTempAt(elev) {
    return this.meanSeaT - LAPSE * Math.max(0, elev);
  }

  // Precipitation rate in metres per year at an elevation — more on the mountains.
  precipAt(elev) {
    return this.precip * (1 + Math.max(0, elev) / 1400);
  }

  // Glaciers follow the year's average, not the season.
  iceAt(elev) {
    return this.meanTempAt(elev) < ICE_T;
  }

  season() {
    return SEASONS[Math.floor(((this.yearFrac + 1 / 12) % 1) * 4)];
  }

  label() {
    const era = this.era > 0.62 ? 'icehouse' : this.era < 0.38 ? 'hothouse' : 'temperate';
    const phase = this.glacial > 0.55 ? 'glacial' : this.glacial > 0.2 ? 'cooling' : 'interglacial';
    const base = this.seasonal ? `${this.season()} · ${phase} · ${era}` : `${phase} · ${era}`;
    return this.cooling > 0.3 && this.winter ? `${this.winter} · ${base}` : base;
  }
}
