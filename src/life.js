// life.js — populations along the river.
//
// Each species is a density map over a half-resolution grid (one life cell
// is 2 × 2 landscape cells, 1 km²) plus one set of traits. Every rate is
// per year, so the same model shows ecology at day-long ticks (spring
// blooms, winter dormancy, populations creeping upriver) and evolution at
// thousand-year ticks (adaptation, splitting, extinction).
//
// Competition runs through realm totals: a species is crowded by the
// biomass of its own size class (microbial or larger) in the realms it lives
// in (fresh water, sea, land), so species sort themselves out by where they
// can live, how big they are, and temperature, rather than by an all-pairs
// comparison. Microbes and plants share a river without one excluding the
// other.

import { CELL_M } from './terrain.js';
import { CHANNEL_Q } from './landscape.js';
import {
  realms, mutate, genusName, epithet, formOf, isLandPlant,
  tempOptC, tempWidthC, toTempTrait, traitDistance,
} from './species.js';

export const LIFE_SCALE = 2;
export const MAX_LIVE_SPECIES = 32;
const KEEP_EXTINCT = 200;

const R_MAX = 3;                    // growth per year of the simplest, fastest species
const MORTALITY = 0.6;              // per year where a species can't make a living
const MIN_DENSITY = 1e-4;
const RANGE_DENSITY = 0.02;         // density that counts as "lives here"
const EXTINCT_TOTAL = 0.02;
const BUD_YEARS = 700000;           // mean wait for a species to bud a daughter
const INNOVATION = 0.2;             // share of buddings that are big jumps
const SPLIT_EVERY = 40000;          // years between checks for a cut-off population
const SPLIT_MIN_CELLS = 12;
const SPLIT_MIN_SHARE = 0.1;
const EXCLUSION = 3;                // how hard the best-fitted species in a cell crowds out the rest
const ADAPT_YEARS = 20000;          // how long tempOpt takes to track a changed climate
const MAX_SUBSTEPS = 2;
const BIG_RIVER_Q = 3e8;            // m³/yr: a river this big is a barrier to land species

export class Life {
  constructor(land, rng) {
    this.rng = rng;
    const LW = Math.ceil(land.W / LIFE_SCALE), LH = Math.ceil(land.H / LIFE_SCALE);
    this.LW = LW; this.LH = LH; this.NL = LW * LH;
    const NL = this.NL;
    // Landscape cell → life cell.
    this.toLife = new Int32Array(land.N);
    for (let i = 0; i < land.N; i++) {
      const x = i % land.W, y = (i / land.W) | 0;
      this.toLife[i] = ((y / LIFE_SCALE) | 0) * LW + ((x / LIFE_SCALE) | 0);
    }
    // Environment, rebuilt each tick.
    this.sea = new Float32Array(NL);
    this.fresh = new Float32Array(NL);
    this.landF = new Float32Array(NL);
    this.temp = new Float32Array(NL);       // now (seasonal when seasons are on)
    this.tempMean = new Float32Array(NL);   // annual mean
    this.ice = new Float32Array(NL);
    this.snow = new Float32Array(NL);
    this.nutFresh = new Float32Array(NL);
    this.nutSea = new Float32Array(NL);
    this.nutLand = new Float32Array(NL);
    this.barrier = new Float32Array(NL);
    this.count = new Float32Array(NL);
    this.zSum = new Float32Array(NL);
    this.zMin = new Float32Array(NL);
    this.zMax = new Float32Array(NL);
    this.fertSum = new Float32Array(NL);
    this.erodeSum = new Float32Array(NL);
    // Realm biomass totals per size class, for crowding.
    this.bFresh = [new Float32Array(NL), new Float32Array(NL)];
    this.bSea = [new Float32Array(NL), new Float32Array(NL)];
    this.bLand = [new Float32Array(NL), new Float32Array(NL)];
    // Plant cover handed to the landscape (holds the soil).
    this.kmFresh = [new Float32Array(NL), new Float32Array(NL)];
    this.kmSea = [new Float32Array(NL), new Float32Array(NL)];
    this.kmLand = [new Float32Array(NL), new Float32Array(NL)];
    this.cover = new Float32Array(NL);
    this.coverC = new Float32Array(NL);     // mean complexity of the plants there
    this.tmp = new Float32Array(NL);
    this.pass = new Float32Array(NL);
    this.fit = new Float32Array(NL);
    this.queue = new Int32Array(NL);
    this.comp = new Int32Array(NL);

    this.species = [];      // living, in id order
    this.registry = new Map();
    this.nextId = 1;
    this.light = 0.8;
    this.stats = { alive: 0, landPlants: 0, firstLandPlant: null, vegetated: 0, everLived: 0 };
  }

  // --- environment ---------------------------------------------------------

  sense(land, climate) {
    const { NL, toLife, count, zSum, zMin, zMax, fertSum, erodeSum } = this;
    const { sea, fresh, landF, ice, snow, temp, tempMean, nutFresh, nutSea, nutLand, barrier } = this;
    count.fill(0); zSum.fill(0); fertSum.fill(0); erodeSum.fill(0);
    sea.fill(0); fresh.fill(0); landF.fill(0); ice.fill(0); snow.fill(0); barrier.fill(0);
    zMin.fill(Infinity); zMax.fill(-Infinity);
    for (let i = 0; i < land.N; i++) {
      const c = toLife[i];
      count[c]++;
      const z = land.z[i];
      zSum[c] += z;
      if (z < zMin[c]) zMin[c] = z;
      if (z > zMax[c]) zMax[c] = z;
      if (land.ocean[i]) { sea[c]++; continue; }
      if (land.lake[i] || land.Q[i] >= CHANNEL_Q) fresh[c]++;
      else landF[c]++;
      if (land.Q[i] >= BIG_RIVER_Q) barrier[c] = 1;
      if (land.ice[i]) ice[c]++;
      if (land.snow[i] > 0.02) snow[c]++;
      fertSum[c] += land.fert[i];
      const e = land.eroded[i];
      if (e > 0) erodeSum[c] += e;
    }
    const dtHint = this.lastDt || 1;
    for (let c = 0; c < NL; c++) {
      const n = count[c];
      sea[c] /= n; fresh[c] /= n; landF[c] /= n; ice[c] /= n; snow[c] /= n;
      const zAvg = zSum[c] / n;
      const above = Math.max(0, zAvg - climate.seaLevel);
      temp[c] = climate.tempAt(above);
      tempMean[c] = climate.meanTempAt(above);
      const fert = fertSum[c] / n;
      // Rivers bring nutrients; fresh deposits are richer.
      nutFresh[c] = 0.55 + Math.min(0.6, fert * 4);
      // The shelf is rich, deep water poor; river mouths richest of all.
      const depth = climate.seaLevel - zAvg;
      nutSea[c] = (depth < 200 ? 1 : 0.25) * (0.8 + Math.min(0.5, fert * 4));
      // Land: wet and flat with fresh soil is best; steep, fast-eroding
      // slopes hold little.
      const relief = (zMax[c] - zMin[c]) / (2 * CELL_M);
      const soil = Math.max(0.15, 1 - Math.min(1, relief / 0.35) * 0.7) * (1 + Math.min(0.4, fert * 3));
      const wet = Math.min(1, climate.meanPrecip * (1 + Math.max(0, above) / 1400) / 1.1);
      const erosionPerYr = erodeSum[c] / n / dtHint;
      const stable = 1 - Math.min(0.8, erosionPerYr * 400);
      nutLand[c] = soil * (0.35 + 0.65 * wet) * stable;
    }
    // Nearness to water makes land wetter: a one-cell halo.
    const { LW, LH, tmp } = this;
    for (let y = 0; y < LH; y++) {
      for (let x = 0; x < LW; x++) {
        const c = y * LW + x;
        let near = fresh[c];
        if (x > 0) near = Math.max(near, fresh[c - 1]);
        if (x < LW - 1) near = Math.max(near, fresh[c + 1]);
        if (y > 0) near = Math.max(near, fresh[c - LW]);
        if (y < LH - 1) near = Math.max(near, fresh[c + LW]);
        tmp[c] = near;
      }
    }
    for (let c = 0; c < NL; c++) nutLand[c] *= 0.75 + 0.5 * Math.min(1, tmp[c] * 2);
    // Day length: short winter days, long summer ones.
    if (climate.seasonal) {
      const phase = Math.cos(2 * Math.PI * (climate.yearFrac - 0.04));
      this.light = 0.8 - 0.2 * phase;
    } else {
      this.light = 0.8;
    }
  }

  // --- seeding ---------------------------------------------------------------

  // The world starts with a small aquatic community in the sea and at the
  // coast; the freshwater ones follow the rivers inland as they form.
  seed(land, climate) {
    this.sense(land, climate);
    const coastT = climate.meanSeaT;
    const start = [
      { form: 'plankton', habitat: 0.02, salinity: 0.95, complexity: 0.03, tempTol: 0.45, dispersal: 0.7, hue: 0.52, where: 'shelf' },
      { form: 'seaweed', habitat: 0.05, salinity: 0.85, complexity: 0.12, tempTol: 0.4, dispersal: 0.4, hue: 0.33, where: 'shallows' },
      { form: 'mat', habitat: 0.1, salinity: 0.5, complexity: 0.04, tempTol: 0.5, dispersal: 0.4, hue: 0.12, where: 'coast' },
    ];
    for (const s of start) {
      const traits = {
        habitat: s.habitat, salinity: s.salinity, tempOpt: toTempTrait(coastT),
        tempTol: s.tempTol, complexity: s.complexity, dispersal: s.dispersal, hue: s.hue,
      };
      const sp = this.addSpecies(traits, null, 0);
      const { N } = sp;
      for (let c = 0; c < this.NL; c++) {
        const sea = this.sea[c];
        let here;
        if (s.where === 'shelf') here = sea > 0.9;
        else if (s.where === 'shallows') here = sea > 0.2 && this.coastal(c);
        else here = sea > 0.05 && (sea < 1 || this.coastal(c));
        if (here) N[c] = 0.2;
      }
    }
  }

  // Freshwater algae arrive with the river: once channels reach the sea,
  // they're seeded at the river mouths and in any lakes.
  seedFreshwater(climate, years) {
    if (this.freshSeeded) return;
    const { NL, fresh, sea } = this;
    const at = [];
    for (let c = 0; c < NL; c++) if (fresh[c] > 0.2 && (sea[c] > 0 || this.coastal(c))) at.push(c);
    if (at.length < 3) return;
    this.freshSeeded = true;
    const traits = {
      habitat: 0.05, salinity: 0.12, tempOpt: toTempTrait(climate.meanSeaT), tempTol: 0.45,
      complexity: 0.1, dispersal: 0.55, hue: 0.25,
    };
    const sp = this.addSpecies(traits, null, years);
    for (const c of at) sp.N[c] = 0.2;
  }

  coastal(c) {
    const { LW, LH, sea } = this;
    const x = c % LW, y = (c / LW) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= LW || ny < 0 || ny >= LH) continue;
        if (sea[ny * LW + nx] < 0.5) return true;
      }
    }
    return false;
  }

  addSpecies(traits, parent, years) {
    const id = this.nextId++;
    const rng = this.rng;
    let genus;
    if (parent && traitDistance(parent.traits, traits) < 0.12) genus = parent.genus;
    else genus = genusName(rng);
    const sp = {
      id,
      parent: parent ? parent.id : null,
      genus,
      name: `${genus} ${epithet(rng)}`,
      born: years,
      died: null,
      traits: { ...traits },
      founder: { ...traits },
      N: new Float32Array(this.NL),
      K: new Float32Array(this.NL),
      x0: 0, x1: this.LW - 1, y0: 0, y1: this.LH - 1,   // occupied box
      isolated: false,
      total: 0,
      range: 0,
      peakRange: 0,
      lastRange: 0,
      trend: 0,
      nextSplit: years + SPLIT_EVERY * (0.5 + this.rng.next()),
      nextTrend: years,
    };
    this.species.push(sp);
    this.registry.set(id, sp);
    return sp;
  }

  // --- one tick ---------------------------------------------------------------

  step(land, climate, dt, years) {
    this.lastDt = dt;
    this.sense(land, climate);
    this.seedFreshwater(climate, years);
    this.tally();
    for (const a of [...this.kmFresh, ...this.kmSea, ...this.kmLand]) a.fill(0);
    for (const sp of this.species) this.capacity(sp);
    for (const sp of this.species) this.grow(sp, dt);
    for (const sp of this.species) this.disperse(sp, dt);
    for (const sp of this.species) this.measure(sp, dt, years);
    this.evolve(dt, years);
    this.computeCover();
  }

  // Realm totals: how much biomass already lives in each realm of each cell.
  tally() {
    for (const a of [...this.bFresh, ...this.bSea, ...this.bLand]) a.fill(0);
    for (const sp of this.species) {
      const tier = tierOf(sp.traits);
      const bFresh = this.bFresh[tier], bSea = this.bSea[tier], bLand = this.bLand[tier];
      const r = realms(sp.traits);
      const sum = r.fresh + r.sea + r.land || 1;
      const wf = r.fresh / sum, ws = r.sea / sum, wl = r.land / sum;
      const N = sp.N;
      this.forBox(sp, 0, (c) => {
        const n = N[c];
        if (n === 0) return;
        bFresh[c] += n * wf; bSea[c] += n * ws; bLand[c] += n * wl;
      });
    }
  }

  // Calls fn(c) for every cell in a species' occupied box, grown by m cells.
  forBox(sp, m, fn) {
    const { LW, LH } = this;
    const x0 = Math.max(0, sp.x0 - m), x1 = Math.min(LW - 1, sp.x1 + m);
    const y0 = Math.max(0, sp.y0 - m), y1 = Math.min(LH - 1, sp.y1 + m);
    for (let y = y0; y <= y1; y++) {
      const row = y * LW;
      for (let x = x0; x <= x1; x++) fn(row + x);
    }
  }

  // What each cell could hold for this species on its own, and the best any
  // species present manages in each realm.
  capacity(sp) {
    const t = sp.traits;
    const r = realms(t);
    const opt = tempOptC(t.tempOpt), width = tempWidthC(t.tempTol);
    const kMult = 0.7 + 0.6 * t.complexity;
    const rExp = 0.6 + 1.6 * t.complexity;
    const { sea, fresh, landF, ice, tempMean, nutFresh, nutSea, nutLand } = this;
    const tier = tierOf(t);
    const kmFresh = this.kmFresh[tier], kmSea = this.kmSea[tier], kmLand = this.kmLand[tier];
    const N = sp.N, K = sp.K;
    const dom = r.land >= r.fresh && r.land >= r.sea ? kmLand : r.sea > r.fresh ? kmSea : kmFresh;
    sp.dom = dom;
    this.forBox(sp, MAX_SUBSTEPS + 1, (c) => {
      const hf = r.fresh * fresh[c], hs = r.sea * sea[c], hl = r.land * landF[c];
      const habitat = hf + hs + hl;
      if (habitat <= 0) { K[c] = 0; return; }
      const resource = (hf * nutFresh[c] + hs * nutSea[c] + hl * nutLand[c]) / habitat;
      const dT = (tempMean[c] - opt) / width;
      // Complex life needs rich ground: in poor water or raw soil the simple
      // forms keep their place.
      const k = habitat * Math.pow(resource, rExp) * Math.exp(-0.5 * dT * dT) * kMult * (1 - ice[c]);
      K[c] = k;
      if (N[c] > RANGE_DENSITY && k > dom[c]) dom[c] = k;
    });
  }

  // Exact logistic step toward what the cell can hold for this species,
  // after its competitors in the same realms take their share. Where a
  // better-fitted species is present, this one's share shrinks, so near
  // copies don't coexist forever.
  grow(sp, dt) {
    const t = sp.traits;
    const r = realms(t);
    const rsum = r.fresh + r.sea + r.land || 1;
    const rate = R_MAX * (1 - 0.6 * t.complexity);
    const { snow, temp, landF } = this;
    const tier = tierOf(t);
    const bFresh = this.bFresh[tier], bSea = this.bSea[tier], bLand = this.bLand[tier];
    const N = sp.N, K = sp.K, dom = sp.dom;
    const light = this.light;
    const landy = r.land > 0;
    this.forBox(sp, 0, (c) => {
      const n = N[c];
      if (n <= 0) return;
      let k = K[c];
      if (k <= 0) { N[c] = n * Math.exp(-MORTALITY * 4 * dt); if (N[c] < MIN_DENSITY) N[c] = 0; return; }
      const best = dom[c];
      if (best > k) k *= Math.pow(k / best, EXCLUSION);
      const crowd = (r.fresh * bFresh[c] + r.sea * bSea[c] + r.land * bLand[c]) / rsum;
      const keff = k - Math.max(0, crowd - n);
      // Growing season: cold and snow stop growth; short days slow it.
      let g = light;
      const T = temp[c];
      if (T < 2) g = 0;
      else if (T < 10) g *= (T - 2) / 8;
      if (landy && landF[c] > 0 && snow[c] > 0.5) g *= 1 - snow[c];
      const rg = rate * g;
      let next;
      if (keff > 1e-6 && rg > 0) next = keff / (1 + ((keff - n) / n) * Math.exp(-rg * dt));
      else if (keff > 1e-6) next = n;
      else next = n * Math.exp(-MORTALITY * dt);
      N[c] = next < MIN_DENSITY ? 0 : next;
    });
  }

  // Spread to neighbouring cells the species can live in. Aquatic species
  // only move through water; big rivers hold back land species unless they
  // disperse well.
  disperse(sp, dt) {
    const t = sp.traits;
    const r = realms(t);
    const { LW, LH, NL, pass, sea, fresh, landF, barrier, tmp } = this;
    const N = sp.N;
    const D = 0.03 + 0.6 * t.dispersal;          // cells² per year
    const want = D * dt;
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(want / 0.2)));
    const f = Math.min(0.2, want / steps);
    const m = steps + 1;
    const bx0 = Math.max(0, sp.x0 - m), bx1 = Math.min(LW - 1, sp.x1 + m);
    const by0 = Math.max(0, sp.y0 - m), by1 = Math.min(LH - 1, sp.y1 + m);
    const landy = r.land > r.fresh + r.sea;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const c = y * LW + x;
        const h = r.fresh * fresh[c] + r.sea * sea[c] + r.land * landF[c];
        let p = h > 0.02 ? 1 : 0;
        if (p && landy && barrier[c]) p = 0.15 + 0.85 * t.dispersal;
        pass[c] = p;
      }
    }
    for (let s = 0; s < steps; s++) {
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) tmp[y * LW + x] = N[y * LW + x];
      for (let y = by0 + 1; y <= by1 - 1; y++) {
        for (let x = bx0 + 1; x <= bx1 - 1; x++) {
          const c = y * LW + x;
          const pc = pass[c];
          if (pc === 0) continue;
          let flow = 0;
          if (pass[c - 1]) flow += (tmp[c - 1] - tmp[c]) * Math.min(pc, pass[c - 1]);
          if (pass[c + 1]) flow += (tmp[c + 1] - tmp[c]) * Math.min(pc, pass[c + 1]);
          if (pass[c - LW]) flow += (tmp[c - LW] - tmp[c]) * Math.min(pc, pass[c - LW]);
          if (pass[c + LW]) flow += (tmp[c + LW] - tmp[c]) * Math.min(pc, pass[c + LW]);
          if (flow === 0) continue;
          const v = tmp[c] + f * flow;
          N[c] = v < MIN_DENSITY ? 0 : v;
        }
      }
    }
  }

  measure(sp, dt, years) {
    const { LW, tempMean } = this;
    const N = sp.N;
    let total = 0, range = 0, tw = 0;
    let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    this.forBox(sp, MAX_SUBSTEPS + 1, (c) => {
      const n = N[c];
      if (n === 0) return;
      total += n;
      tw += n * tempMean[c];
      if (n > RANGE_DENSITY) range++;
      const x = c % LW, y = (c / LW) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    });
    if (x1 >= 0) { sp.x0 = x0; sp.x1 = x1; sp.y0 = y0; sp.y1 = y1; }
    sp.total = total;
    sp.range = range;
    if (range > sp.peakRange) sp.peakRange = range;
    if (years >= sp.nextTrend) {
      sp.trend = range - sp.lastRange;
      sp.lastRange = range;
      sp.nextTrend = years + 5000;
    }
    // Adaptation: the temperature optimum drifts toward where it lives.
    if (total > 0) {
      const lived = toTempTrait(tw / total);
      const k = 1 - Math.exp(-dt / ADAPT_YEARS);
      sp.traits.tempOpt += (lived - sp.traits.tempOpt) * k;
    }
  }

  // --- evolution ----------------------------------------------------------------

  evolve(dt, years) {
    // Extinction.
    for (const sp of this.species) {
      if (sp.total < EXTINCT_TOTAL) {
        sp.died = years;
        sp.N = null;
        sp.K = null;
      }
    }
    const before = this.species.length;
    this.species = this.species.filter((sp) => sp.died === null);
    if (this.species.length !== before) this.prune();

    const rng = this.rng;
    const pBud = 1 - Math.exp(-dt / BUD_YEARS);
    const parents = this.species.slice();
    for (const sp of parents) {
      if (years >= sp.nextSplit) {
        sp.nextSplit = years + SPLIT_EVERY;
        this.trySplit(sp, years);
      }
      if (rng.chance(pBud)) this.bud(sp, years);
    }
    // The valley only holds so many species. Over the cap, the rarest
    // established species in the most crowded realm dies out to make room,
    // so a boom on land doesn't wipe out the rivers and the sea.
    while (this.species.length > MAX_LIVE_SPECIES) {
      const byRealm = new Map();
      for (const sp of this.species) {
        if (sp.born >= years) continue;
        const k = realmOf(sp.traits);
        if (!byRealm.has(k)) byRealm.set(k, []);
        byRealm.get(k).push(sp);
      }
      let crowded = null;
      for (const list of byRealm.values()) if (!crowded || list.length > crowded.length) crowded = list;
      if (!crowded) break;
      crowded.sort((a, b) => a.total - b.total);
      const gone = crowded[0];
      gone.died = years;
      gone.N = null;
      gone.K = null;
      this.species = this.species.filter((sp) => sp !== gone);
    }
    this.prune();
    this.updateStats(years);
  }

  // A daughter population at a random place in the parent's range, with
  // mutated traits. Most are small steps; some are big jumps.
  bud(parent, years) {
    const rng = this.rng;
    const { NL, LW, LH } = this;
    const P = parent.N;
    let at = -1;
    for (let k = 0; k < 40; k++) {
      const c = rng.int(NL);
      if (P[c] > RANGE_DENSITY) { at = c; break; }
    }
    if (at < 0) return;
    const traits = mutate(rng, parent.traits, 0.05, rng.chance(INNOVATION));
    const child = this.addSpecies(traits, parent, years);
    const x = at % LW, y = (at / LW) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= LW || ny < 0 || ny >= LH) continue;
        const c = ny * LW + nx;
        child.N[c] = Math.max(0.02, P[c] * 0.3);
      }
    }
  }

  // If part of the range has been cut off from the rest, it goes its own way.
  trySplit(sp, years) {
    const { LW, LH, NL, comp, queue } = this;
    const N = sp.N;
    comp.fill(-1);
    const sizes = [], mass = [];
    for (let s = 0; s < NL; s++) {
      if (comp[s] >= 0 || N[s] <= RANGE_DENSITY) continue;
      const id = sizes.length;
      let head = 0, tail = 0, size = 0, m = 0;
      queue[tail++] = s; comp[s] = id;
      while (head < tail) {
        const c = queue[head++];
        size++; m += N[c];
        const x = c % LW, y = (c / LW) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= LW || ny < 0 || ny >= LH) continue;
            const j = ny * LW + nx;
            if (comp[j] < 0 && N[j] > RANGE_DENSITY) { comp[j] = id; queue[tail++] = j; }
          }
        }
      }
      sizes.push(size); mass.push(m);
    }
    if (sizes.length < 2) { sp.isolated = false; return; }
    const total = mass.reduce((a, b) => a + b, 0);
    let main = 0;
    for (let k = 1; k < mass.length; k++) if (mass[k] > mass[main]) main = k;
    let cut = -1;
    for (let k = 0; k < mass.length; k++) {
      if (k === main) continue;
      if (sizes[k] >= SPLIT_MIN_CELLS && mass[k] >= total * SPLIT_MIN_SHARE && (cut < 0 || mass[k] > mass[cut])) cut = k;
    }
    if (cut < 0) { sp.isolated = false; return; }
    // Cut off at two checks running: then it has become its own species.
    if (!sp.isolated) { sp.isolated = true; return; }
    sp.isolated = false;
    const traits = mutate(this.rng, sp.traits, 0.025, false);
    const child = this.addSpecies(traits, sp, years);
    for (let c = 0; c < NL; c++) {
      if (comp[c] === cut) { child.N[c] = N[c]; N[c] = 0; }
    }
  }

  // Keep the registry bounded: the living, their ancestors, and the most
  // recently extinct.
  prune() {
    const keep = new Set();
    for (const sp of this.species) {
      let a = sp;
      while (a && !keep.has(a.id)) {
        keep.add(a.id);
        a = a.parent ? this.registry.get(a.parent) : null;
      }
    }
    const extinct = [...this.registry.values()].filter((s) => s.died !== null && !keep.has(s.id));
    extinct.sort((a, b) => b.died - a.died);
    for (const s of extinct.slice(KEEP_EXTINCT)) this.registry.delete(s.id);
  }

  // After a disaster has struck from outside a step: recount every species,
  // take out the ones with nothing left, and redo the plant cover, so the
  // losses show at once. Returns how many species died out.
  settle(years) {
    const { NL } = this;
    let lost = 0;
    for (const sp of this.species) {
      const N = sp.N;
      let total = 0, range = 0;
      for (let c = 0; c < NL; c++) {
        const n = N[c];
        if (n === 0) continue;
        total += n;
        if (n > RANGE_DENSITY) range++;
      }
      sp.total = total;
      sp.range = range;
      if (total < EXTINCT_TOTAL) {
        sp.died = years;
        sp.N = null;
        sp.K = null;
        lost++;
      }
    }
    if (lost) {
      this.species = this.species.filter((sp) => sp.died === null);
      this.prune();
    }
    this.updateStats(years);
    this.computeCover();
    return lost;
  }

  updateStats(years) {
    let land = 0;
    for (const sp of this.species) if (isLandPlant(sp.traits)) land++;
    this.stats.alive = this.species.length;
    this.stats.landPlants = land;
    this.stats.everLived = this.nextId - 1;
    if (land > 0 && this.stats.firstLandPlant === null) this.stats.firstLandPlant = years;
  }

  // Plant cover per life cell, 0..1, and the plants' mean complexity.
  computeCover() {
    const { NL, cover, coverC } = this;
    cover.fill(0); coverC.fill(0);
    for (const sp of this.species) {
      const r = realms(sp.traits);
      if (r.land <= 0) continue;
      const w = r.land / (r.fresh + r.sea + r.land);
      const c0 = sp.traits.complexity;
      const N = sp.N;
      for (let c = 0; c < NL; c++) {
        const n = N[c];
        if (n === 0) continue;
        cover[c] += n * w;
        coverC[c] += n * w * c0;
      }
    }
    let vegetated = 0;
    for (let c = 0; c < NL; c++) {
      if (cover[c] > 0) coverC[c] /= cover[c];
      cover[c] = Math.min(1, cover[c] * 1.4);
      if (cover[c] > 0.15) vegetated++;
    }
    this.stats.vegetated = vegetated;
  }

  // --- saving -----------------------------------------------------------------

  saveState() {
    const keepFields = (sp) => ({
      id: sp.id, parent: sp.parent, genus: sp.genus, name: sp.name, born: sp.born, died: sp.died,
      traits: { ...sp.traits }, founder: { ...sp.founder },
      N: sp.N ? sp.N.slice() : null,
      x0: sp.x0, x1: sp.x1, y0: sp.y0, y1: sp.y1, isolated: sp.isolated,
      total: sp.total, range: sp.range, peakRange: sp.peakRange, lastRange: sp.lastRange, trend: sp.trend,
      nextSplit: sp.nextSplit, nextTrend: sp.nextTrend,
    });
    return {
      rng: this.rng.getState(),
      nextId: this.nextId,
      freshSeeded: !!this.freshSeeded,
      lastDt: this.lastDt || 1,
      stats: { ...this.stats },
      // Registry order matters for pruning ties, so keep it.
      species: [...this.registry.values()].map(keepFields),
    };
  }

  restoreState(s) {
    this.rng.setState(s.rng);
    this.nextId = s.nextId;
    this.freshSeeded = s.freshSeeded;
    this.lastDt = s.lastDt;
    this.stats = { ...s.stats };
    this.registry = new Map();
    this.species = [];
    for (const r of s.species) {
      const sp = { ...r, traits: { ...r.traits }, founder: { ...r.founder } };
      if (sp.died === null) {
        sp.N = Float32Array.from(r.N);
        sp.K = new Float32Array(this.NL);
        this.species.push(sp);
      } else {
        sp.N = null;
        sp.K = null;
      }
      this.registry.set(sp.id, sp);
    }
    this.species.sort((a, b) => a.id - b.id);
  }

  // --- for the page -----------------------------------------------------------

  // Per-cell colours and densities for drawing, as compact byte arrays.
  frameData(selectedId) {
    const { NL, sea, fresh } = this;
    const aqua = new Uint8Array(NL);
    const veg = new Uint8Array(NL);
    const vegC = new Uint8Array(NL);
    const rgb = new Uint8Array(NL * 3);
    const sum = new Float32Array(NL);
    const acc = new Float32Array(NL * 3);
    const water = new Float32Array(NL);
    for (const sp of this.species) {
      const r = realms(sp.traits);
      const wa = (r.fresh + r.sea) / (r.fresh + r.sea + r.land || 1);
      const col = hueRgb(sp.traits.hue);
      const N = sp.N;
      for (let c = 0; c < NL; c++) {
        const n = N[c];
        if (n === 0) continue;
        water[c] += n * wa;
        sum[c] += n;
        acc[c * 3] += n * col[0]; acc[c * 3 + 1] += n * col[1]; acc[c * 3 + 2] += n * col[2];
      }
    }
    for (let c = 0; c < NL; c++) {
      const wetShare = sea[c] + fresh[c];
      aqua[c] = Math.min(255, Math.round(wetShare > 0 ? (water[c] / wetShare) * 300 : 0));
      veg[c] = Math.round(this.cover[c] * 255);
      vegC[c] = Math.round(this.coverC[c] * 255);
      if (sum[c] > 0) {
        const a = Math.min(1, sum[c] * 2.5);
        rgb[c * 3] = (acc[c * 3] / sum[c]) * a;
        rgb[c * 3 + 1] = (acc[c * 3 + 1] / sum[c]) * a;
        rgb[c * 3 + 2] = (acc[c * 3 + 2] / sum[c]) * a;
      }
    }
    let selected = null;
    const sel = selectedId ? this.registry.get(selectedId) : null;
    if (sel && sel.N) {
      selected = new Uint8Array(NL);
      for (let c = 0; c < NL; c++) selected[c] = Math.min(255, Math.round(sel.N[c] * 300));
    }
    return { LW: this.LW, LH: this.LH, aqua, veg, vegC, rgb, selected };
  }

  summary() {
    const out = [];
    for (const sp of this.registry.values()) {
      out.push({
        id: sp.id, parent: sp.parent, name: sp.name, form: formOf(sp.traits), hue: sp.traits.hue,
        born: sp.born, died: sp.died, range: sp.range, peakRange: sp.peakRange, trend: sp.trend,
        traits: { ...sp.traits, tempOptC: tempOptC(sp.traits.tempOpt), tempWidthC: tempWidthC(sp.traits.tempTol) },
      });
    }
    return out;
  }

  // What lives in one life cell, biggest first.
  at(c) {
    const out = [];
    for (const sp of this.species) {
      const n = sp.N[c];
      if (n > RANGE_DENSITY * 0.5) out.push({ id: sp.id, name: sp.name, form: formOf(sp.traits), hue: sp.traits.hue, density: n });
    }
    out.sort((a, b) => b.density - a.density);
    return out;
  }
}

// Size class: microbes and single cells (0) or anything larger (1).
function tierOf(t) {
  return t.complexity < 0.22 ? 0 : 1;
}

function realmOf(t) {
  const r = realms(t);
  return r.land >= r.fresh && r.land >= r.sea ? 'land' : r.sea > r.fresh ? 'sea' : 'fresh';
}

const hueCache = new Map();
function hueRgb(h) {
  const k = Math.round(h * 360);
  let v = hueCache.get(k);
  if (!v) {
    const s = 0.62, l = 0.5;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const kk = (n + (k / 360) * 12) % 12;
      return l - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1));
    };
    v = [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
    hueCache.set(k, v);
  }
  return v;
}

