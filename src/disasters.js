// disasters.js — floods, wildfires, eruptions and impacts. Nature sets them
// off at realistic rates as time runs, and the page can drop one anywhere.
//
// Each one changes the world directly: eruptions and impacts reshape the
// ground (a cone, a crater) and the water re-routes around it at once;
// floods lay silt on the valley floor; fires burn the plants and leave
// fertile ash. The biggest eruptions and impacts also chill the climate for a
// few years and wipe out the species least able to take the cold.

import { CELL_M, ROCKS, BASALT } from './terrain.js';
import { realms } from './species.js';

export const DISASTER_KINDS = ['flood', 'lightning', 'volcano', 'meteor'];
export const DISASTER_SIZES = ['small', 'big', 'catastrophic'];

// Mean years between natural events.
const FIRE_EVERY = 30;          // a lightning fire, on a well-vegetated valley
const FLOOD_EVERY = 50;         // a big flood on the trunk river
const ERUPT_EVERY = 400000;
const IMPACT_EVERY = 3000000;
const MAX_FIRES = 3;            // per tick, so long ticks don't burn the world down
const MAX_FLOODS = 1;
const KEEP_EVENTS = 30;
const CELL_KM2 = (CELL_M / 1000) ** 2;
const FIRE_BREAK_Q = 4e7;       // m³/yr: a river this big stops a fire
const FLOOD_RIVER_Q = 2e7;      // the smallest river that floods its banks

const km = (v) => (v >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1).replace(/\.0$/, ''));

function poisson(rng, lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.round(lambda);
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng.next(); } while (p > L);
  return k - 1;
}

export class Disasters {
  constructor(rng) {
    this.rng = rng;
    this.nextId = 1;
    this.events = [];
    this.shock = null;      // { dT, start, years, name }: a volcanic or impact winter
    this.epoch = 0;         // goes up whenever the ground is reshaped
  }

  // Degrees of cooling at year t from the latest big event.
  coolingAt(t) {
    const s = this.shock;
    if (!s) return 0;
    const a = t - s.start;
    return a >= 0 && a < s.years ? s.dT * (1 - a / s.years) : 0;
  }

  winterName() {
    return this.shock ? this.shock.name : '';
  }

  // --- nature's own ------------------------------------------------------------

  natural(sim, dt) {
    const { rng } = this;
    const { land, life, climate } = sim;
    // Life is settled once after all of this step's events, not after each.
    this.batch = true;
    this.unsettled = false;
    if (this.shock && sim.years - this.shock.start >= this.shock.years) this.shock = null;

    // Lightning fires: in summer, in dry spells, where there's plenty to burn.
    const veg = Math.min(1, life.stats.vegetated / 400);
    if (veg > 0) {
      let season = 1;
      if (climate.seasonal) season = { winter: 0.05, spring: 0.5, summer: 2.6, autumn: 0.85 }[climate.season()];
      const dry = Math.max(0.4, Math.min(1.4, 1.6 - climate.meanPrecip));
      const n = Math.min(MAX_FIRES, poisson(rng, (dt / FIRE_EVERY) * veg * season * dry));
      for (let k = 0; k < n; k++) {
        const i = this.findCell(land, 30, (j) => !land.ocean[j] && !land.lake[j] && land.cover[j] > 0.25);
        if (i < 0) break;
        const ev = this.apply(sim, 'lightning', i, rng.chance(0.1) ? 1 : 0, dry);
        if (ev && dt > 1 && (!ev.cells || ev.cells.length < 60)) ev.quiet = true;
      }
    }

    // Floods: mostly with the spring melt, on a river big enough to have a floodplain.
    if (land.stats.mouthQ > 1e8) {
      let season = 1;
      if (climate.seasonal) season = { winter: 0.5, spring: 2.4, summer: 0.6, autumn: 0.5 }[climate.season()];
      const n = Math.min(MAX_FLOODS, poisson(rng, (dt / FLOOD_EVERY) * season));
      for (let k = 0; k < n; k++) {
        const i = this.findCell(land, 200, (j) => !land.ocean[j] && !land.lake[j] && land.Q[j] >= 4e7);
        if (i < 0) break;
        // Floods are so common that a note for each would bury every other
        // event; they show on the map only.
        const ev = this.apply(sim, 'flood', i, rng.chance(0.15) ? 1 : 0);
        ev.quiet = true;
      }
    }

    // Eruptions, in the rising mountains.
    for (let k = poisson(rng, dt / ERUPT_EVERY); k > 0; k--) {
      const i = this.findCell(land, 200, (j) => !land.ocean[j] && land.uplift[j] > 0.0002);
      if (i < 0) break;
      const u = rng.next();
      this.apply(sim, 'volcano', i, u < 0.1 ? 2 : u < 0.45 ? 1 : 0);
    }

    // Impacts, anywhere: most small, a few huge.
    for (let k = poisson(rng, dt / IMPACT_EVERY); k > 0; k--) {
      const i = rng.int(land.N);
      const r = Math.min(8, Math.max(1, Math.pow(rng.next(), -0.6)));
      this.apply(sim, 'meteor', i, r >= 4 ? 2 : r >= 2 ? 1 : 0, 1, r);
    }
    this.batch = false;
    if (this.unsettled) {
      life.settle(sim.years);
      sim.syncCover();
    }
  }

  // A random cell that passes the test, or -1 after so many tries.
  findCell(land, tries, ok) {
    for (let t = 0; t < tries; t++) {
      const i = this.rng.int(land.N);
      if (ok(i)) return i;
    }
    return -1;
  }

  // --- from the page -------------------------------------------------------------

  trigger(sim, kind, i, size) {
    if (!DISASTER_KINDS.includes(kind) || !(i >= 0 && i < sim.land.N)) return null;
    const s = Math.max(0, DISASTER_SIZES.indexOf(size));
    const ev = this.apply(sim, kind, i, s);
    ev.byHand = true;
    return ev;
  }

  // --- the events ---------------------------------------------------------------

  apply(sim, kind, i, size, dry = 1, radius) {
    let ev;
    if (kind === 'flood') ev = this.flood(sim, i, size);
    else if (kind === 'lightning') ev = this.lightning(sim, i, size, dry);
    else if (kind === 'volcano') ev = this.volcano(sim, i, size);
    else ev = this.meteor(sim, i, size, radius);
    ev.id = this.nextId++;
    ev.kind = kind;
    ev.size = DISASTER_SIZES[size];
    ev.years = sim.years;
    if (ev.terrain) {
      this.epoch++;
      sim.land.refresh(sim.climate);
    }
    if (size === 2 && (kind === 'volcano' || kind === 'meteor')) this.winter(sim, kind, ev);
    if (ev.hurt && this.batch && !ev.winter) {
      this.unsettled = true;
    } else if (ev.hurt) {
      const lost = sim.life.settle(sim.years);
      const away = ev.sheltered ? sim.life.shelter(ev.sheltered, ev.returnAt) : 0;
      ev.lost = (ev.lost || 0) + lost - away;
      ev.fled = away;
      if (ev.winter) {
        const gone = lost - away;
        const parts = [gone ? `${gone} species lost` : away ? 'none lost for good' : 'every species hangs on'];
        if (away) parts.push(`${away} sheltering at sea`);
        ev.label += `; ${ev.winter}: ${parts.join(', ')}`;
      }
      sim.syncCover();
    }
    delete ev.sheltered;
    delete ev.returnAt;
    delete ev.hurt;
    delete ev.terrain;
    this.events.push(ev);
    if (this.events.length > KEEP_EVENTS) this.events.shift();
    return ev;
  }

  // Cells within a radius (in cells) of a cell, with their distances.
  around(land, i, R, fn) {
    const { W, H } = land;
    const cx = i % W, cy = (i / W) | 0;
    const r = Math.ceil(R);
    for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= R) fn(y * W + x, d);
      }
    }
  }

  // Takes a share of the life in the given landscape cells: all of it, or
  // only what lives on land. On burned or flooded ground everything of a
  // species that can live on land is out of the water, so it takes the full
  // blow; the purely aquatic ones in the streams are spared.
  hurt(sim, cells, frac, landOnly) {
    const { life } = sim;
    const { toLife } = life;
    const share = new Map();
    for (let k = 0; k < cells.length; k++) {
      const c = toLife[cells[k]];
      share.set(c, (share.get(c) || 0) + frac[k] / 4);
    }
    for (const sp of life.species) {
      const r = realms(sp.traits);
      const w = landOnly ? Math.min(1, r.land / 0.05) : 1;
      if (w <= 0) continue;
      const N = sp.N;
      for (const [c, f] of share) {
        const n = N[c];
        if (n <= 0) continue;
        const v = n * (1 - Math.min(1, f) * w);
        N[c] = v < 1e-4 ? 0 : v;
      }
    }
  }

  // The river overtops its banks along a reach: the low ground beside it
  // goes under, gets a coat of silt and loses most of its land life; the
  // channel itself is scoured a little deeper.
  flood(sim, i, size) {
    const { land } = sim;
    const { N, z, Q, ocean, lake, rec, maxDonor, fert } = land;
    let start = -1, best = Infinity;
    this.around(land, i, 8, (j, d) => {
      if (!ocean[j] && !lake[j] && Q[j] >= FLOOD_RIVER_Q && d < best) { best = d; start = j; }
    });
    if (start < 0) return this.miss(land, i, 'No river near enough there to flood');
    const half = [6, 12, 24][size];
    const depth = [2.5, 4, 7][size];
    const R = [3, 4, 6][size];
    const channel = [start];
    let c = start;
    for (let k = 0; k < half; k++) {
      const r = rec[c];
      if (r === c || ocean[r]) break;
      channel.push(r);
      c = r;
    }
    c = start;
    for (let k = 0; k < half; k++) {
      const d = maxDonor[c];
      if (d < 0 || Q[d] < FLOOD_RIVER_Q) break;
      channel.push(d);
      c = d;
    }
    const mark = new Uint8Array(N);
    for (const ch of channel) mark[ch] = 2;
    const wet = [];
    for (const ch of channel) {
      const stage = z[ch] + depth * Math.min(2, Math.max(0.6, Math.sqrt(Q[ch] / 1e8)));
      this.around(land, ch, R, (j) => {
        if (mark[j] || ocean[j] || z[j] > stage) return;
        mark[j] = 1;
        wet.push(j);
      });
    }
    const silt = [0.05, 0.12, 0.3][size];
    const scour = [0.1, 0.3, 0.8][size];
    const { loose } = land;
    for (const j of wet) { z[j] += silt; loose[j] += silt; fert[j] += 0.05 + 0.03 * size; }
    for (const ch of channel) { z[ch] -= scour; loose[ch] = Math.max(0, loose[ch] - scour); }
    this.hurt(sim, wet, new Float32Array(wet.length).fill(0.7), true);
    const area = wet.length * CELL_KM2;
    const ev = this.place(land, wet.length ? wet : channel, wet.concat(channel));
    ev.label = wet.length ? `The river floods ${km(area)} km² of its valley` : 'The river runs high but stays in its banks';
    ev.hurt = true;
    return ev;
  }

  // A strike, and if there's dry plant cover to catch, a fire that spreads
  // through it until it runs out of fuel, luck or room, or meets a river.
  lightning(sim, i, size, dry) {
    const { land } = sim;
    const { W, H, N, Q, ocean, lake, cover, fert } = land;
    if (ocean[i] || lake[i]) return this.strike(land, i, 'Lightning strikes the water');
    if (cover[i] < 0.12) return this.strike(land, i, 'Lightning strikes bare ground');
    // How much a fire can take before the wind drops or the rain comes.
    const max = Math.round([40, 160, 600][size] * this.rng.range(0.25, 1));
    const burned = new Uint8Array(N);
    const cells = [i];
    burned[i] = 1;
    for (let h = 0; h < cells.length && cells.length < max; h++) {
      const c = cells[h];
      const x = c % W, y = (c / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0), ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const j = ny * W + nx;
        if (burned[j] || ocean[j] || lake[j] || Q[j] >= FIRE_BREAK_Q || cover[j] < 0.12) continue;
        if (this.rng.next() < Math.min(0.95, (0.35 + 0.7 * cover[j]) * dry)) {
          burned[j] = 1;
          cells.push(j);
          if (cells.length >= max) break;
        }
      }
    }
    for (const j of cells) fert[j] += 0.04;
    this.hurt(sim, cells, new Float32Array(cells.length).fill(0.8), true);
    const ev = this.place(land, cells, cells);
    ev.strike = [i % W + 0.5, ((i / W) | 0) + 0.5];
    ev.label = `Lightning fire burns ${km(cells.length * CELL_KM2)} km²`;
    ev.hurt = true;
    return ev;
  }

  // A cone grows: lava buries everything near the vent and ash falls
  // further out, killing plants but leaving the soil richer.
  volcano(sim, i, size) {
    const { land, climate } = sim;
    const { W, z, fert, loose, rock, kfac } = land;
    const h = [150, 600, 1500][size] * this.rng.range(0.8, 1.2);
    const r = [2, 3.5, 6][size];
    const lava = [], ash = [], ashF = [];
    this.around(land, i, 3 * r, (j, d) => {
      const q = (d * d) / (r * r);
      const dz = h * Math.exp(-q) - 0.12 * h * Math.exp(-(d * d) / (0.35 * r) ** 2);
      z[j] += dz;
      if (dz > 1) land.water[j] = 0;     // the lava pushes any water out
      fert[j] += 0.12 * Math.exp(-(d * d) / (1.5 * r) ** 2);
      // Lava flows build the cone in basalt, burying whatever was there;
      // further out, the ash falls as a fresh loose layer.
      if (dz > 20) {
        rock[j] = BASALT;
        kfac[j] = ROCKS[BASALT].k;
        loose[j] = 0;
      } else {
        const ashM = 2 * Math.exp(-(d * d) / (2 * r) ** 2);
        z[j] += ashM;
        loose[j] += ashM;
      }
      if (d <= r) lava.push(j);
      else { ash.push(j); ashF.push(0.6 * Math.exp(-((d - r) * (d - r)) / (r * r))); }
    });
    this.hurt(sim, lava, new Float32Array(lava.length).fill(1), false);
    this.hurt(sim, ash, ashF, true);
    const top = z[i] - climate.seaLevel;
    const ev = { x: (i % W) + 0.5, y: ((i / W) | 0) + 0.5, r, terrain: true, hurt: true };
    const m = Math.round(h / 10) * 10;
    ev.label = top < 0 ? `An undersea eruption raises a ${m} m seamount`
      : land.ocean[i] ? `An eruption builds a ${m} m island` : `An eruption builds a ${m} m cone`;
    return ev;
  }

  // A bowl-shaped crater with a raised rim of thrown-out rock. Nothing
  // within twice its radius survives.
  meteor(sim, i, size, radius) {
    const { land } = sim;
    const { W, z, loose } = land;
    const r = radius || [1.5, 3, 6][size];
    const D = 0.3 * r * CELL_M;
    const rim = 0.25 * D;
    const dead = [];
    this.around(land, i, 3 * r, (j, d) => {
      const q = d / r;
      const dz = q < 1 ? -D * (1 - q * q) + rim * q * q : rim * Math.exp(-(((d - r) / (0.5 * r)) ** 2));
      z[j] += dz;
      if (Math.abs(dz) > 1) land.water[j] = 0;   // the blast throws any water out; the crater fills again
      // The blast takes the cover first, then the rock; what it throws out
      // lands as a rim of shattered rubble.
      loose[j] = dz >= 0 ? loose[j] + dz : Math.max(0, loose[j] + dz);
      if (d <= 2 * r) dead.push(j);
    });
    this.hurt(sim, dead, new Float32Array(dead.length).fill(1), false);
    const ev = { x: (i % W) + 0.5, y: ((i / W) | 0) + 0.5, r, terrain: true, hurt: true };
    ev.label = `A meteor strikes, leaving a ${km(2 * r * CELL_M / 1000)} km crater`;
    return ev;
  }

  // A volcanic or impact winter: a few degrees colder for a few years, and
  // the species with the narrowest comfort range, above all the rare ones,
  // die out. At least one species always pulls through.
  winter(sim, kind, ev) {
    const { rng } = this;
    const dT = rng.range(3, 6);
    const name = kind === 'meteor' ? 'impact winter' : 'volcanic winter';
    this.shock = { dT, start: sim.years, years: rng.range(2, 10), name };
    const sev = rng.range(0.5, 0.8) * (dT / 4.5);
    const species = sim.life.species;
    const doomed = [];
    for (const sp of species) {
      const narrow = 1 - sp.traits.tempTol;
      const p = sev * narrow * (0.5 + 0.5 * Math.exp(-sp.range / 150));
      if (rng.next() < p) doomed.push(sp);
      else {
        const keep = 1 - 0.6 * sev * narrow;
        const N = sp.N;
        for (let c = 0; c < N.length; c++) if (N[c] > 0) N[c] *= keep;
      }
    }
    if (doomed.length && doomed.length === species.length) {
      doomed.sort((a, b) => b.traits.tempTol - a.traits.tempTol || a.id - b.id);
      doomed.shift();
    }
    for (const sp of doomed) sp.N.fill(0);
    // The sea buffers the cold. Established species able to get away, and
    // hardy enough to ride it out, shelter offshore and along the coast and
    // come back when the winter is over; the rest are lost for good.
    ev.sheltered = [];
    for (const sp of doomed) {
      const established = sim.years - sp.born >= 20000 && sp.peakRange >= 25;
      const p = established ? Math.pow(sp.traits.tempTol, 1.2) * (0.4 + 0.6 * sp.traits.dispersal) : 0;
      if (rng.next() < p) ev.sheltered.push(sp.id);
    }
    ev.returnAt = this.shock.start + this.shock.years;
    ev.winter = name;
    ev.catastrophic = true;
    ev.hurt = true;
    sim.climate.cooling = this.coolingAt(sim.years);
    sim.climate.winter = name;
  }

  // A moment worth a note that isn't a disaster, such as the first animal
  // to walk out of the water, at a life cell.
  milestone(sim, label, c) {
    const { LW } = sim.life;
    const ev = {
      id: this.nextId++, kind: 'milestone', size: null, years: sim.years,
      x: (c % LW) * 2 + 1, y: Math.floor(c / LW) * 2 + 1, r: 3, label,
    };
    this.events.push(ev);
    if (this.events.length > KEEP_EVENTS) this.events.shift();
    return ev;
  }

  // Centre and reach of a set of cells, for the map to draw and pan to.
  place(land, cells, draw) {
    const { W } = land;
    let sx = 0, sy = 0;
    for (const c of cells) { sx += c % W; sy += (c / W) | 0; }
    const x = sx / cells.length + 0.5, y = sy / cells.length + 0.5;
    let r = 1;
    for (const c of cells) r = Math.max(r, Math.hypot((c % W) + 0.5 - x, ((c / W) | 0) + 0.5 - y));
    return { x, y, r, cells: draw.slice(0, 1500) };
  }

  strike(land, i, label) {
    const x = (i % land.W) + 0.5, y = ((i / land.W) | 0) + 0.5;
    return { x, y, r: 1, strike: [x, y], label };
  }

  miss(land, i, label) {
    return { x: (i % land.W) + 0.5, y: ((i / land.W) | 0) + 0.5, r: 1, missed: true, label };
  }

  // Events after a given id, for the page.
  since(id) {
    return this.events.filter((e) => e.id > id);
  }

  saveState() {
    return {
      rng: this.rng.getState(),
      nextId: this.nextId,
      epoch: this.epoch,
      shock: this.shock ? { ...this.shock } : null,
      events: this.events.map((e) => ({ ...e, cells: e.cells ? e.cells.slice() : undefined })),
    };
  }

  restoreState(s) {
    if (!s) return;
    this.rng.setState(s.rng);
    this.nextId = s.nextId;
    this.epoch = s.epoch || 0;
    this.shock = s.shock ? { ...s.shock } : null;
    this.events = s.events.map((e) => ({ ...e }));
  }
}
