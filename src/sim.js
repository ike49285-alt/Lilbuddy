// sim.js — the tick loop.
//
// One tick is one year, and tick one million must cost what tick one thousand
// cost. Everything here is either O(cells) with a cheap body, O(live polities),
// or rare enough to amortise away. Nothing accumulates: anything that grows
// with elapsed time belongs in memory.js, which is write-only from here.
//
// The sim never reads the archive back. That is what makes the world a pure
// function of its seed, and therefore what makes deliberately forgetting old
// history safe — with one narrow, deliberate exception: see `realChance()`
// below, the one roll in house learning that uses real, not seeded,
// randomness. Save/load and the continue slot compensate by snapshotting
// live state instead of replaying (see app.js); shared seed+year links stay
// an honest approximation past that point.

import { makeRng } from './rng.js';
import { generateWorld } from './world.js';
import {
  makePhonology, mutatePhonology, placeName, personName,
  dynastyName, cultureName, polityName, epithet,
} from './names.js';
import { Memory, entityKey } from './memory.js';

const MAX_LIVE_POLITIES = 110;
const MAX_CULTURES = 64;
const KEYFRAME_INTERVAL = 25;
const COMPACT_INTERVAL = 250;
const BORDER_REFRESH = 8;

// The technology/institution ratchet. Each epoch rewrites the constants the
// rules run on, so an era of city-states doesn't behave like an era of empires.
//
// The pawl can slip: lose either the population or the large states that carry
// institutions, for long enough, and the world falls back an era. Without that,
// a long run reaches the last epoch and then plays the same movie forever — the
// whole point of unbounded time is that the character of history changes, not
// just the names.
//
// `reach` is how far from its capital a state can push, as a radius in cells;
// `hold` is how many cells the era's institutions can administer before
// overextension starts eating stability. Both are in cells — reach is converted
// to raster distance at use, against the world's measured cell size.
const EPOCHS = [
  { name: 'the Stone Age',      popScale: 0.55, expand: 0.030, reach: 4,  hold: 12,  lethality: 0.35, settleAt: 0.55 },
  { name: 'the Bronze Age',     popScale: 0.80, expand: 0.042, reach: 7,  hold: 30,  lethality: 0.50, settleAt: 0.60 },
  { name: 'the Iron Age',       popScale: 1.00, expand: 0.055, reach: 11, hold: 60,  lethality: 0.70, settleAt: 0.62 },
  { name: 'the Classical era',  popScale: 1.25, expand: 0.068, reach: 16, hold: 110, lethality: 0.85, settleAt: 0.65 },
  { name: 'the Age of Powder',  popScale: 1.55, expand: 0.080, reach: 22, hold: 180, lethality: 1.15, settleAt: 0.68 },
  { name: 'the Industrial era', popScale: 2.10, expand: 0.092, reach: 30, hold: 300, lethality: 1.45, settleAt: 0.70 },
];

export const CLIMATE_PERIOD = 41000; // Milankovitch-ish, because the number is nice.

// Accumulated civilised-years needed to reach each epoch. Tuned so a world
// climbs the whole ladder over roughly twenty thousand years and loses ground
// on any real catastrophe.
const EPOCH_THRESHOLDS = [0, 400, 1100, 2100, 3500, 5500];
const EPOCH_INTERVAL = 50;
// Fraction of world carrying capacity below which a civilisation is merely
// surviving and stops banking progress.
const SUBSISTENCE = 0.6;
// How much of the era's administrative capacity the largest state must be using
// for the era to keep advancing. Below it, institutions decay faster than they
// accumulate and the world starts losing ground.
const ORDER_FLOOR = 0.55;
// A world-wide cold shock: rare, long, and severe enough to bring every state
// down together. Roughly one per sixteen thousand years.
const WINTER_CHANCE = 0.00014;
const WINTER_SEVERITY = 0.36;

// Great houses. A house survives losing its last throne and can be restored to
// ground it once held, which is what turns a dynasty from a label on a king
// into an actor with a story of its own.
const MAX_HOUSES = 90;
const MAX_HOUSE_SPANS = 8;     // throne spans kept per house; oldest fall away
const MAX_FEUDS = 6;
// Three crowns at once, not two. Houses branch readily, so two is common enough
// that over half of them would qualify and the distinction would mean nothing.
const GREAT_HOUSE_THRONES = 3;
const RESTORATION_WINDOW = 600; // years a deposed house can still press a claim
const HOUSE_OVERFLOW_SLACK = 1.15;  // inline trim once the table runs this far over
// Both bleed off per prune (every 250 years), so a grievance lasts centuries
// rather than for ever.
const GRUDGE_DECAY = 0.35;
const FEUD_DECAY = 0.25;

// House "lightweight AI": every house's behavioural tendencies drift with its
// own wins and losses, and with a small, cheap peek at whichever neighbouring
// house is doing better right now. State is three bounded scalars per house —
// no cap/prune logic needed, the shape never grows.
const TENDENCY_CLAMP = 1;            // tendencies live in [-1, 1]
const TENDENCY_OWN_NUDGE = 0.08;     // shift from the house's own war win/loss or restoration success
const TENDENCY_THRONE_NUDGE = 0.04;  // half-weight shift from losing a throne outside war
const TENDENCY_OBSERVE_NUDGE = 0.03; // smaller shift from imitating a thriving neighbour
const TENDENCY_DECAY = 0.02;         // per prune (250 yr), pulls an idle house back toward neutral
const MOMENTUM_CLAMP = 1;            // momentum lives in [-1, 1]
const MOMENTUM_NUDGE = 0.3;          // shift from a war win/loss
const MOMENTUM_THRONE_NUDGE = 0.15;  // half-weight shift from gaining/losing a throne outside war
const MOMENTUM_DECAY = 0.15;         // per prune, same cadence as FEUD_DECAY/GRUDGE_DECAY
const LEARN_SAMPLE = 2;              // neighbouring houses sampled per observation — bounded, cheap
const LEARN_MOMENTUM_GAP = 0.15;     // how far ahead a neighbour's momentum must be to be worth imitating
const WAR_TRIGGER_BASE = 0.0035;     // baseline per-tick war-trigger chance (was an inline literal)
const AGGRESSION_WAR_SWING = 0.0025; // max +/- a house's own aggression can move that chance
const RESTORE_WEIGHT_MIN = 0.2;      // floor on a restoration/branch candidate's selection weight
const RESTORE_WEIGHT_MAX = 2;        // ceiling on the same

// Why states go to war. Written down at the declaration so the archive has a
// true answer to lose when it later swaps in a stock one.
const WAR_CAUSES = {
  border: 'a disputed border',
  conquest: 'plain conquest',
  succession: 'a contested succession',
  revanche: 'ground lost in an earlier war',
  dynastic: 'a feud between ruling houses',
  culture: 'kin under foreign rule',
};

// The one deliberate exception to this file's own rule (see the header
// comment, and rng.js): whether a war actually triggers, once a house's
// learned aggression has nudged the odds, is allowed to make the world
// genuinely unrepeatable. Every other roll in this file stays on the seeded
// sim.rng — only this call uses real entropy, by explicit product decision.
function realChance(p) { return Math.random() < p; }

// ---- full-state snapshot helpers ------------------------------------------
//
// Plain-object <-> live-object conversion for the two record shapes that
// carry nested Set/Map fields. Everything else in a save (settlements,
// cultures, people, wars) is already flat and JSON-safe as-is.

function polityToState(pol) {
  return {
    id: pol.id, name: pol.name, form: pol.form, cultureId: pol.cultureId,
    houseId: pol.houseId, rulerId: pol.rulerId, houseSince: pol.houseSince,
    grudges: [...pol.grudges.entries()],
    capital: pol.capital, seat: pol.seat, born: pol.born, died: pol.died,
    cells: pol.cells, pop: pol.pop, stability: pol.stability,
    neighbors: [...pol.neighbors], borderCells: pol.borderCells.slice(),
    wars: [...pol.wars], exhaustion: pol.exhaustion,
    peakCells: pol.peakCells, peakYear: pol.peakYear,
  };
}

// cellList isn't saved — it's rebuilt in full by the next cellPass(), same as
// every tick already relies on, so restoring it would only duplicate data.
function stateToPolity(s) {
  return {
    id: s.id, name: s.name, form: s.form, cultureId: s.cultureId,
    houseId: s.houseId, rulerId: s.rulerId, houseSince: s.houseSince,
    grudges: new Map(s.grudges),
    capital: s.capital, seat: s.seat, born: s.born, died: s.died,
    cells: s.cells, pop: s.pop, stability: s.stability,
    neighbors: new Set(s.neighbors), borderCells: s.borderCells.slice(), cellList: [],
    wars: new Set(s.wars), exhaustion: s.exhaustion,
    peakCells: s.peakCells, peakYear: s.peakYear,
  };
}

function houseToState(house) {
  return {
    id: house.id, name: house.name, cultureId: house.cultureId, founded: house.founded,
    thrones: [...house.thrones], heldPast: house.heldPast.map((h) => ({ ...h })),
    rulers: house.rulers, prestige: house.prestige,
    feuds: [...house.feuds.entries()],
    deposedAt: house.deposedAt, extinguished: house.extinguished,
    peakThrones: house.peakThrones, great: house.great,
    tendencies: { ...house.tendencies }, momentum: house.momentum,
  };
}

function stateToHouse(s) {
  return {
    id: s.id, name: s.name, cultureId: s.cultureId, founded: s.founded,
    thrones: new Set(s.thrones), heldPast: s.heldPast.map((h) => ({ ...h })),
    rulers: s.rulers, prestige: s.prestige,
    feuds: new Map(s.feuds),
    deposedAt: s.deposedAt, extinguished: s.extinguished,
    peakThrones: s.peakThrones, great: s.great,
    tendencies: { ...s.tendencies }, momentum: s.momentum,
  };
}

export class Simulation {
  // `restoreState` (from a prior saveState()) skips seeding a brand-new world
  // and repopulates live state instead — see saveState()/fromState() below,
  // and the note on realChance() above for why this exists at all: replaying
  // from the seed can no longer reproduce a world that used it, so save/load
  // now captures the world directly.
  constructor(seed, restoreState = null) {
    this.seed = String(seed);
    const rootRng = makeRng(this.seed);
    this.rng = rootRng.fork('sim');
    this.world = generateWorld(rootRng);
    this.memory = restoreState
      ? Memory.fromState(restoreState.memory, rootRng, this.world.cellCount)
      : new Memory(rootRng, this.world.cellCount);

    const n = this.world.cellCount;
    this.owner = new Int32Array(n).fill(-1);
    this.pop = new Float32Array(n);
    this.cellCulture = new Int32Array(n).fill(-1);
    this.cellSettlement = new Int32Array(n).fill(-1);
    this.cellSettlementTier = new Uint8Array(n);
    this.unrest = new Float32Array(n);

    this.polities = new Map();
    this.settlements = new Map();
    this.cultures = new Map();
    this.houses = new Map();
    this.people = new Map();
    this.wars = new Map();

    this.nextId = { polity: 1, settlement: 1, culture: 1, house: 1, person: 1, war: 1 };
    this.year = 0;
    this.epochIndex = 0;
    this.knowledge = 0;      // accumulated civilised-years; drives the ratchet
    this.globalPop = 0;
    this.ownedCells = [];   // refilled each cellPass; drives expansion sampling
    this.climatePhase = 0;
    this.winterYears = 0;   // remaining years of a global cold shock
    this.largestPolity = 0;  // cells held by the biggest state; drives the ratchet
    // Typical distance between adjacent cell centres, so epoch reach can be
    // written in cells and compared against raster distances.
    this.cellPx = Math.sqrt((this.world.width * this.world.height) / this.world.cellCount);
    // Total capacity with no climate swing and no winter — the yardstick the
    // era ratchet measures scarcity against.
    this.baseCapSum = 0;
    for (const c of this.world.landCells) this.baseCapSum += this.world.baseCapacity[c];

    if (restoreState) this.restoreLiveState(restoreState);
    else this.seedWorld();
  }

  get epoch() { return EPOCHS[this.epochIndex]; }

  // ---- full-state snapshot (save/load) ------------------------------------
  //
  // Not used by the tick loop, and never by replay — only by save/load and
  // the continue slot, which capture the live world directly rather than
  // rebuilding it by ticking from the seed. Terrain/world generation is
  // untouched by house learning and stays a pure function of the seed, so
  // it's regenerated by the constructor rather than duplicated in every
  // save — this is exactly the part that *isn't* implied by the seed alone.
  saveState() {
    return {
      seed: this.seed,
      year: this.year,
      epochIndex: this.epochIndex,
      knowledge: this.knowledge,
      globalPop: this.globalPop,
      climatePhase: this.climatePhase,
      winterYears: this.winterYears,
      largestPolity: this.largestPolity,
      nextId: { ...this.nextId },
      owner: Array.from(this.owner),
      pop: Array.from(this.pop),
      cellCulture: Array.from(this.cellCulture),
      cellSettlement: Array.from(this.cellSettlement),
      cellSettlementTier: Array.from(this.cellSettlementTier),
      unrest: Array.from(this.unrest),
      polities: [...this.polities.values()].map(polityToState),
      settlements: [...this.settlements.values()],
      cultures: [...this.cultures.values()],
      houses: [...this.houses.values()].map(houseToState),
      people: [...this.people.values()],
      wars: [...this.wars.values()],
      memory: this.memory.saveState(),
    };
  }

  // Called only from the constructor, once the world/rng/typed arrays/empty
  // Maps are already in place — fills them in from a saveState() payload
  // instead of seedWorld()'s fresh founding.
  restoreLiveState(state) {
    this.year = state.year;
    this.epochIndex = state.epochIndex;
    this.knowledge = state.knowledge;
    this.globalPop = state.globalPop;
    this.climatePhase = state.climatePhase;
    this.winterYears = state.winterYears;
    this.largestPolity = state.largestPolity;
    this.nextId = { ...state.nextId };
    this.owner.set(state.owner);
    this.pop.set(state.pop);
    this.cellCulture.set(state.cellCulture);
    this.cellSettlement.set(state.cellSettlement);
    this.cellSettlementTier.set(state.cellSettlementTier);
    this.unrest.set(state.unrest);
    for (const p of state.polities) this.polities.set(p.id, stateToPolity(p));
    for (const s of state.settlements) this.settlements.set(s.id, { ...s });
    for (const c of state.cultures) this.cultures.set(c.id, { ...c, phonology: { ...c.phonology } });
    for (const h of state.houses) this.houses.set(h.id, stateToHouse(h));
    for (const n of state.people) this.people.set(n.id, { ...n });
    for (const w of state.wars) this.wars.set(w.id, { ...w, taken: w.taken.slice() });
  }

  // ---- setup -------------------------------------------------------------

  seedWorld() {
    this.memory.push({
      t: 0, type: 'world.begin', mag: 1, first: true,
      data: { seed: this.seed, land: this.world.landCells.length },
    });
    // A handful of founder cultures, spread out, each with its own sound.
    const seeds = 6;
    for (let i = 0; i < seeds; i++) {
      const cell = this.pickFoundingCell();
      if (cell < 0) continue;
      const culture = this.newCulture(null);
      this.foundPolity(cell, culture, true);
    }
    this.pushKeyframe();
  }

  pickFoundingCell() {
    const land = this.world.landCells;
    let best = -1;
    let bestScore = -1;
    // Sampled rather than exhaustive so founding stays O(1) at any world size.
    for (let attempt = 0; attempt < 40; attempt++) {
      const c = land[this.rng.int(land.length)];
      if (this.owner[c] !== -1) continue;
      const score = this.world.baseCapacity[c] * this.rng.range(0.6, 1.4);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  // ---- entity constructors ----------------------------------------------

  newCulture(parent) {
    const id = this.nextId.culture++;
    const phon = parent
      ? mutatePhonology(parent.phonology, this.rng)
      : makePhonology(this.rng);
    const culture = {
      id, phonology: phon,
      name: cultureName(phon, this.rng),
      parent: parent ? parent.id : null,
      born: this.year,
    };
    this.cultures.set(id, culture);
    this.memory.register('c', id, { name: culture.name, born: this.year, parent: culture.parent });
    if (parent) {
      this.memory.push({
        t: this.year, type: 'culture.split', mag: 0.3,
        refs: [entityKey('c', id), entityKey('c', parent.id)],
        data: { from: parent.name, to: culture.name },
      });
    }
    return culture;
  }

  // Retire cultures nothing speaks any more, and — once over the cap — let the
  // rarest surviving ones die out, their remaining speakers shifting to the
  // culture that displaced them. Without the second half the table is bounded
  // only by cell count, which grows the tick's working set for tens of
  // thousands of years before it settles.
  //
  // This runs on the periodic prune, never inline in newCulture: a culture is
  // created a beat before the polity that will speak it exists, and retiring it
  // inside that window strands the new polity with a dangling cultureId.
  retireCultures() {
    if (this.cultures.size <= MAX_CULTURES) return;

    const speakers = new Map();
    for (const id of this.cultures.keys()) speakers.set(id, 0);
    for (let i = 0; i < this.cellCulture.length; i++) {
      const id = this.cellCulture[i];
      if (id >= 0 && speakers.has(id)) speakers.set(id, speakers.get(id) + 1);
    }
    const protectedIds = new Set();
    for (const pol of this.polities.values()) protectedIds.add(pol.cultureId);

    const ranked = [...speakers.entries()]
      .filter(([id]) => !protectedIds.has(id))
      .sort((a, b) => a[1] - b[1]);

    let excess = this.cultures.size - MAX_CULTURES;
    for (const [id, count] of ranked) {
      if (excess <= 0) break;
      const dying = this.cultures.get(id);
      if (!dying) continue;
      const heirId = this.dominantNeighbourCulture(id, protectedIds);
      for (let i = 0; i < this.cellCulture.length; i++) {
        if (this.cellCulture[i] === id) this.cellCulture[i] = heirId;
      }
      for (const s of this.settlements.values()) {
        if (s.cultureId === id) s.cultureId = heirId;
      }
      if (count > 0) {
        const heir = this.cultures.get(heirId);
        this.memory.push({
          t: this.year, type: 'culture.split', mag: 0.35,
          refs: [entityKey('c', id), ...(heir ? [entityKey('c', heirId)] : [])],
          data: { from: dying.name, to: heir ? heir.name : null, died: true },
        });
      }
      this.cultures.delete(id);
      excess--;
    }
  }

  // Whichever living culture holds most ground adjacent to the dying one.
  dominantNeighbourCulture(dyingId, protectedIds) {
    const { start, list } = this.world.neighbors;
    const tally = new Map();
    for (let c = 0; c < this.cellCulture.length; c++) {
      if (this.cellCulture[c] !== dyingId) continue;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const other = this.cellCulture[list[k]];
        if (other < 0 || other === dyingId || !this.cultures.has(other)) continue;
        tally.set(other, (tally.get(other) || 0) + 1);
      }
    }
    let best = -1;
    let bestCount = -1;
    for (const [id, n] of tally) {
      if (n > bestCount) { bestCount = n; best = id; }
    }
    if (best >= 0) return best;
    for (const id of protectedIds) if (this.cultures.has(id)) return id;
    return this.cultures.keys().next().value ?? -1;
  }

  // A polity must always have a culture to name its heirs from. If one has
  // somehow gone missing, adopt a neighbour's rather than leaving the polity
  // unable to crown anyone — an uncrownable polity re-runs its succession
  // every tick forever.
  cultureFor(pol) {
    const existing = this.cultures.get(pol.cultureId);
    if (existing) return existing;
    const fallback = this.cultures.values().next().value || this.newCulture(null);
    pol.cultureId = fallback.id;
    return fallback;
  }

  newPerson(culture, house) {
    const id = this.nextId.person++;
    const phon = culture.phonology;
    const person = {
      id,
      name: personName(phon, this.rng),
      epithet: this.rng.chance(0.35) ? epithet(phon, this.rng) : null,
      houseId: house ? house.id : null,
      born: this.year,
      died: null,
      lifespan: Math.max(24, Math.round(this.rng.normal(58, 13))),
      crowned: null,
    };
    this.people.set(id, person);
    this.memory.register('n', id, {
      name: person.name, epithet: person.epithet,
      born: person.born, house: house ? house.name : null,
    });
    return person;
  }

  // ---- great houses ------------------------------------------------------
  //
  // A house is not a label on a king. It outlives the state it ruled, can hold
  // more than one throne at a time, can be deposed and restored generations
  // later, and remembers who it has fought. That durability is also what keeps
  // old events in the archive: salience rises with entities that still exist,
  // so a founding survives centuries because the house that made it still
  // reigns somewhere.

  newHouse(culture) {
    const id = this.nextId.house++;
    const house = {
      id,
      name: dynastyName(culture.phonology, this.rng),
      cultureId: culture.id,
      founded: this.year,
      thrones: new Set(),      // polity ids held right now
      heldPast: [],            // {polity, name, from, to}, capped
      rulers: 0,
      prestige: 1,
      feuds: new Map(),        // houseId -> weight, capped
      deposedAt: null,
      extinguished: null,
      peakThrones: 0,
      great: false,
      tendencies: { aggression: 0, restoration: 0 }, // each clamped to [-1, 1]
      momentum: 0,              // clamped to [-1, 1]; decaying "how well lately" signal
    };
    this.houses.set(id, house);
    this.memory.register('d', id, {
      name: house.name, born: this.year, culture: culture.name,
    });
    this.memory.push({
      t: this.year, type: 'house.found', mag: 0.25,
      refs: [entityKey('d', id), entityKey('c', culture.id)],
      data: { house: house.name },
    });
    this.checkHouseOverflow();
    return house;
  }

  // Which house takes a new throne. Minting a fresh one every time is what made
  // houses disposable; most of the time an existing house should be reaching
  // for it instead — a branch of a neighbour's house, or an old house coming
  // back to ground it used to hold.
  houseForThrone(cell, culture) {
    const restorable = [];
    const branchable = [];
    for (const house of this.houses.values()) {
      if (house.extinguished) continue;
      if (house.thrones.size === 0 && house.heldPast.length) {
        // Only where it has history, and only for a few centuries after losing
        // the last of it — beyond that nobody is left to press the claim.
        const since = this.year - (house.deposedAt ?? this.year);
        if (since < RESTORATION_WINDOW && this.houseHeldNear(house, cell)) restorable.push(house);
      } else if (house.thrones.size > 0 && house.cultureId === culture.id) {
        branchable.push(house);
      }
    }

    // The gate probabilities (0.42 / 0.3) stay fixed, so the world-wide rate
    // of restoration-vs-branch-vs-new-house doesn't drift — only *which*
    // eligible candidate wins is reweighted by its own learned preference,
    // via a weighted pick over sim.rng (one next() call, same as the plain
    // uniform pick it replaces — this stays seeded, not the real-random
    // exception, since it's the candidate that varies, not whether the
    // outcome repeats).
    if (restorable.length && this.rng.chance(0.42)) {
      const house = restorable[this.rng.weighted(restorable.map((h) => this.restoreWeight(h)))];
      this.memory.push({
        t: this.year, type: 'house.restored', mag: 1.1,
        refs: [entityKey('d', house.id)], cell,
        data: {
          house: house.name,
          years: this.year - (house.deposedAt ?? this.year),
        },
      });
      house.deposedAt = null;
      house.prestige += 2;
      house.tendencies.restoration = this.clampTendency(house.tendencies.restoration + TENDENCY_OWN_NUDGE);
      return house;
    }
    if (branchable.length && this.rng.chance(0.3)) {
      const house = branchable[this.rng.weighted(branchable.map((h) => this.restoreWeight(h)))];
      house.tendencies.restoration = this.clampTendency(house.tendencies.restoration + TENDENCY_OWN_NUDGE);
      return house;
    }
    return this.newHouse(culture);
  }

  // A candidate's selection weight when it's up for restoration or a branch —
  // nudged by its own learned restoration tendency, always inside
  // [RESTORE_WEIGHT_MIN, RESTORE_WEIGHT_MAX] so no single house's odds ever
  // run away.
  restoreWeight(house) {
    return Math.max(RESTORE_WEIGHT_MIN, Math.min(RESTORE_WEIGHT_MAX, 1 + house.tendencies.restoration));
  }

  // Whether the house once ruled a state whose seat was near this cell.
  houseHeldNear(house, cell) {
    for (const held of house.heldPast) {
      if (held.capital >= 0 && this.cellDistance(held.capital, cell) < this.cellPx * 14) return true;
    }
    return false;
  }

  takeThrone(house, pol) {
    house.thrones.add(pol.id);
    house.prestige += 1;
    house.momentum = this.clampMomentum(house.momentum + MOMENTUM_THRONE_NUDGE);
    if (house.thrones.size > house.peakThrones) house.peakThrones = house.thrones.size;
    // Holding two crowns at once is the moment a house becomes one of the great
    // ones, and it is worth logging loudly — these are the entities deep time
    // still remembers when it has forgotten the states themselves.
    if (!house.great && house.thrones.size >= GREAT_HOUSE_THRONES) {
      house.great = true;
      house.prestige += 4;
      this.memory.push({
        t: this.year, type: 'house.ascend', mag: 1.6,
        refs: [entityKey('d', house.id)], cell: pol.capital,
        data: { house: house.name, thrones: house.thrones.size },
      });
    }
  }

  loseThrone(house, pol) {
    if (!house || !house.thrones.has(pol.id)) return;
    house.thrones.delete(pol.id);
    house.heldPast.push({
      polity: pol.id, name: pol.name, capital: pol.capital,
      from: pol.houseSince ?? pol.born, to: this.year,
    });
    // Bounded: the oldest spans fall away rather than accumulating for ever.
    if (house.heldPast.length > MAX_HOUSE_SPANS) house.heldPast.shift();

    house.momentum = this.clampMomentum(house.momentum - MOMENTUM_THRONE_NUDGE);
    house.tendencies.aggression = this.clampTendency(house.tendencies.aggression - TENDENCY_THRONE_NUDGE);

    if (house.thrones.size === 0) {
      house.deposedAt = this.year;
      this.memory.push({
        t: this.year, type: 'house.deposed', mag: 0.6 + Math.min(1, house.prestige / 12),
        refs: [entityKey('d', house.id), entityKey('p', pol.id)],
        cell: pol.capital,
        data: { house: house.name, polity: pol.name, rulers: house.rulers },
      });
    }
  }

  clampTendency(v) { return Math.max(-TENDENCY_CLAMP, Math.min(TENDENCY_CLAMP, v)); }
  clampMomentum(v) { return Math.max(-MOMENTUM_CLAMP, Math.min(MOMENTUM_CLAMP, v)); }
  // Pulls a value toward zero by `step` without crossing it — used to relax an
  // idle house's tendencies/momentum back toward neutral on the periodic prune.
  decayToward(value, step) {
    if (value > 0) return Math.max(0, value - step);
    if (value < 0) return Math.min(0, value + step);
    return value;
  }

  // A house's own outcome is the strongest teacher: winning a war nudges its
  // aggression up, losing nudges it down. Momentum tracks for every house —
  // it's the signal a neighbour reads in observeRivals below.
  learnFromWar(victor, defeated) {
    const winner = this.houses.get(victor.houseId);
    const loser = this.houses.get(defeated.houseId);
    if (winner) {
      winner.momentum = this.clampMomentum(winner.momentum + MOMENTUM_NUDGE);
      winner.tendencies.aggression =
        this.clampTendency(winner.tendencies.aggression + TENDENCY_OWN_NUDGE);
    }
    if (loser) {
      loser.momentum = this.clampMomentum(loser.momentum - MOMENTUM_NUDGE);
      loser.tendencies.aggression =
        this.clampTendency(loser.tendencies.aggression - TENDENCY_OWN_NUDGE);
      this.observeRivals(loser, defeated);
    }
  }

  // The "learns from rivals" half: a house licking a defeat takes a small,
  // cheap look at whichever of its neighbouring houses — through the polity
  // that just lost, not a scan of the world — is having the better run right
  // now, and leans one step toward that house's own aggression. Costs
  // O(LEARN_SAMPLE), reuses the already-maintained pol.neighbors, and makes
  // no rng calls of its own — pure bookkeeping over already-live state.
  observeRivals(house, pol) {
    let sampled = 0;
    for (const neighborId of pol.neighbors) {
      if (sampled >= LEARN_SAMPLE) break;
      const neighborPol = this.polities.get(neighborId);
      if (!neighborPol || neighborPol.houseId === house.id) continue;
      const rival = this.houses.get(neighborPol.houseId);
      if (!rival) continue;
      sampled++;
      if (rival.momentum > house.momentum + LEARN_MOMENTUM_GAP) {
        const dir = Math.sign(rival.tendencies.aggression - house.tendencies.aggression);
        if (dir !== 0) {
          house.tendencies.aggression =
            this.clampTendency(house.tendencies.aggression + dir * TENDENCY_OBSERVE_NUDGE);
        }
      }
    }
  }

  // Two houses whose states have fought remember it. High enough, and it
  // becomes a cause of war in its own right.
  feud(aId, bId, weight) {
    const a = this.houses.get(aId);
    const b = this.houses.get(bId);
    if (!a || !b || a === b) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      x.feuds.set(y.id, Math.min(8, (x.feuds.get(y.id) || 0) + weight));
      if (x.feuds.size > MAX_FEUDS) {
        // Keep only the grudges that still burn hottest.
        const worst = [...x.feuds.entries()].sort((p, q) => q[1] - p[1]).slice(0, MAX_FEUDS);
        x.feuds = new Map(worst);
      }
    }
  }

  // Houses are bounded the same way cultures are: a hard cap, and the least
  // consequential go first. A house with a living throne is never retired.
  retireHouses() {
    if (this.houses.size <= MAX_HOUSES) return;
    const candidates = [];
    for (const house of this.houses.values()) {
      if (house.thrones.size > 0) continue;
      candidates.push(house);
    }
    candidates.sort((a, b) => (a.prestige - b.prestige) || (a.founded - b.founded));
    let excess = this.houses.size - MAX_HOUSES;
    for (const house of candidates) {
      if (excess <= 0) break;
      if (house.prestige >= 4 || house.great) {
        this.memory.push({
          t: this.year, type: 'house.extinct',
          mag: 0.5 + Math.min(1.2, house.prestige / 10),
          refs: [entityKey('d', house.id)],
          data: {
            house: house.name, rulers: house.rulers,
            years: this.year - house.founded, great: house.great,
          },
        });
      }
      house.extinguished = this.year;
      this.memory.updateEntity(entityKey('d', house.id), {
        died: this.year, rulers: house.rulers, great: house.great,
      });
      for (const other of this.houses.values()) other.feuds.delete(house.id);
      this.houses.delete(house.id);
      excess--;
    }
  }

  foundSettlement(cell, culture, isSeat) {
    const id = this.nextId.settlement++;
    const s = {
      id, cell, name: placeName(culture.phonology, this.rng),
      founded: this.year, pop: this.pop[cell], tier: isSeat ? 2 : 1,
      cultureId: culture.id,
    };
    this.settlements.set(id, s);
    this.cellSettlement[cell] = id;
    this.cellSettlementTier[cell] = s.tier;
    this.memory.register('s', id, { name: s.name, founded: this.year, cell });
    this.memory.push({
      t: this.year, type: 'settle.found', mag: isSeat ? 0.45 : 0.2,
      refs: [entityKey('s', id), entityKey('c', culture.id)],
      cell, data: { name: s.name },
      first: this.settlements.size === 1,
    });
    return s;
  }

  foundPolity(cell, culture, primordial = false) {
    const id = this.nextId.polity++;
    const house = this.houseForThrone(cell, culture);
    const ruler = this.newPerson(culture, house);
    ruler.crowned = this.year;
    house.rulers++;

    // A rebel or successor state rises in a city that already exists — its own
    // capital if the seed cell has one, otherwise the nearest neighbouring
    // town. Only a state founded in genuinely empty country builds a new seat.
    //
    // This matters more than it looks: collapse and revolt found thousands of
    // states over a long run, and if each planted a capital they would blanket
    // the map with settlements regardless of the spacing rule.
    const here = this.cellSettlement[cell];
    const nearby = here >= 0 ? here : this.nearbySettlement(cell);
    const seat = nearby >= 0 && this.settlements.has(nearby)
      ? this.settlements.get(nearby)
      : this.foundSettlement(cell, culture, true);
    const form = primordial ? 'chiefdom' : this.rng.pick(['chiefdom', 'kingdom', 'republic', 'theocracy']);
    const pol = {
      id, name: polityName(culture.phonology, this.rng, form, seat.name),
      form, cultureId: culture.id, houseId: house.id, rulerId: ruler.id,
      houseSince: this.year,
      grudges: new Map(),
      capital: cell, seat: seat.id,
      born: this.year, died: null,
      cells: 1, pop: this.pop[cell], stability: 0.55,
      neighbors: new Set(), borderCells: [], cellList: [],
      wars: new Set(), exhaustion: 0,
      peakCells: 1, peakYear: this.year,
    };
    this.polities.set(id, pol);
    this.takeThrone(house, pol);
    this.setOwner(cell, id);
    this.cellCulture[cell] = culture.id;
    if (this.pop[cell] < 0.15) this.pop[cell] = 0.15;

    this.memory.register('p', id, {
      name: pol.name, form, born: this.year, culture: culture.name,
      house: house.name,
    });
    this.memory.push({
      t: this.year, type: 'polity.found', mag: 0.5,
      refs: [
        entityKey('p', id), entityKey('n', ruler.id),
        entityKey('d', house.id), entityKey('s', seat.id),
      ],
      cell,
      data: { name: pol.name, ruler: ruler.name, house: house.name },
      first: primordial,
    });
    return pol;
  }

  setOwner(cell, polityId) {
    this.owner[cell] = polityId;
  }

  // ---- the tick ----------------------------------------------------------

  tick() {
    this.year++;
    const ep = this.epoch;

    this.climatePhase = Math.sin((this.year / CLIMATE_PERIOD) * Math.PI * 2);

    this.cellPass(ep);
    if (this.year % BORDER_REFRESH === 0) this.refreshBorders();
    this.expansionPass(ep);
    this.politiesPass(ep);
    this.hazardsPass(ep);
    this.epochPass();

    if (this.year % KEYFRAME_INTERVAL === 0) this.pushKeyframe();
    if (this.year % COMPACT_INTERVAL === 0) {
      this.memory.compact(this.year, this.liveKeys());
      this.pruneEntities();
    }
  }

  // Drop sim-side records nothing living refers to any more. The archive keeps
  // its own copies of anything still worth remembering, so this is pure
  // housekeeping — but without it the tables grow with elapsed time and the
  // flat-cost guarantee is a lie.
  pruneEntities() {
    const livePeople = new Set();
    for (const pol of this.polities.values()) {
      livePeople.add(pol.rulerId);
      // Grievances fade. Without this a state accumulates every slight it ever
      // suffered and the war system seizes up on ancient history.
      for (const [id, weight] of pol.grudges) {
        const next = weight - GRUDGE_DECAY;
        if (next <= 0 || !this.polities.has(id)) pol.grudges.delete(id);
        else pol.grudges.set(id, next);
      }
    }
    for (const id of this.people.keys()) {
      if (!livePeople.has(id)) this.people.delete(id);
    }
    for (const house of this.houses.values()) {
      for (const [id, weight] of house.feuds) {
        const next = weight - FEUD_DECAY;
        if (next <= 0) house.feuds.delete(id);
        else house.feuds.set(id, next);
      }
      // An idle house's learned tendencies relax back toward neutral, same
      // cadence as feud decay above — a house that stops fighting or
      // reclaiming thrones gradually forgets why it leaned the way it did.
      house.tendencies.aggression = this.decayToward(house.tendencies.aggression, TENDENCY_DECAY);
      house.tendencies.restoration = this.decayToward(house.tendencies.restoration, TENDENCY_DECAY);
      house.momentum = this.decayToward(house.momentum, MOMENTUM_DECAY);
    }
    this.retireCultures();
    this.retireHouses();
  }

  // Houses are only retired on the periodic prune, so between prunes the table
  // runs over its cap. Left at that, the overshoot is set by how many states
  // happen to be founded in a 250-year window — bounded, but loosely. This
  // trims the worst of it inline when the overshoot gets wide.
  checkHouseOverflow() {
    if (this.houses.size > MAX_HOUSES * HOUSE_OVERFLOW_SLACK) this.retireHouses();
  }

  // Population, capacity and assimilation. One sweep, flat body.
  cellPass(ep) {
    const w = this.world;
    for (const pol of this.polities.values()) {
      pol.pop = 0;
      pol.cells = 0;
      pol.cellList.length = 0;
    }

    let total = 0;
    const phase = this.climatePhase;
    // A volcanic winter suppresses capacity everywhere at once. Regional
    // disasters never produce a dark age, because some other empire is always
    // still standing; only a shock that hits every state together does.
    const winter = this.winterYears > 0 ? WINTER_SEVERITY : 1;
    this.ownedCells.length = 0;
    let lastOwnerId = -1;
    let lastOwnerPol = null;
    const land = w.landCells;
    for (let i = 0; i < land.length; i++) {
      const c = land[i];
      // Glaciation bites at high latitude and eases at low: the climate cycle
      // empties the north and refills it over tens of millennia.
      const climate = 1 + phase * w.climateWeight[c];
      const cap = Math.max(0, w.baseCapacity[c] * climate * ep.popScale * winter);

      const p = this.pop[c];
      if (p > 0 || cap > 0.05) {
        // Logistic, with a floor that lets empty-but-viable land repopulate.
        const seedIn = p < 0.02 && cap > 0.2 ? 0.004 : 0;
        this.pop[c] = Math.max(0, p + p * 0.018 * (1 - p / Math.max(0.02, cap)) + seedIn);
      }
      total += this.pop[c];

      const o = this.owner[c];
      if (o >= 0) {
        // Cells are visited in grid order and ownership is blobby, so the next
        // cell usually belongs to the same polity as the last. Caching the
        // resolved object removes most of ~1000 Map lookups per tick, which
        // was the single largest cost in the loop.
        if (o !== lastOwnerId) {
          lastOwnerId = o;
          lastOwnerPol = this.polities.get(o) || null;
        }
        const pol = lastOwnerPol;
        if (pol) {
          pol.pop += this.pop[c];
          pol.cells++;
          // Collected here, during a sweep we already pay for, so collapse and
          // plague can work over a polity's own ground instead of rescanning
          // the whole map.
          pol.cellList.push(c);
          this.ownedCells.push(c);
          // Conquered ground comes round slowly; where it doesn't, unrest is
          // what eventually turns into a revolt.
          if (this.cellCulture[c] !== pol.cultureId) {
            this.unrest[c] = Math.min(1, this.unrest[c] + 0.004);
            if (this.rng.chance(0.0018)) {
              this.cellCulture[c] = pol.cultureId;
              this.unrest[c] *= 0.3;
            }
          } else if (this.unrest[c] > 0) {
            this.unrest[c] = Math.max(0, this.unrest[c] - 0.006);
          }
        } else {
          this.owner[c] = -1;
        }
      }

      // Settlements grow into cities. Tier lives in a cell-indexed array rather
      // than on the Settlement object so this sweep never touches a Map — the
      // object is only consulted on the rare tick where a town becomes a city.
      const sid = this.cellSettlement[c];
      if (sid >= 0) {
        // Scaled by the era's population multiplier, so "city" stays a
        // distinction rather than something every town reaches once the
        // Industrial era lifts everyone above a fixed line.
        if (this.cellSettlementTier[c] < 3 && this.pop[c] > ep.settleAt * 1.6 * ep.popScale) {
          this.cellSettlementTier[c] = 3;
          const s = this.settlements.get(sid);
          if (s) {
            s.tier = 3;
            s.pop = this.pop[c];
            this.memory.push({
              t: this.year, type: 'settle.city', mag: 0.4,
              refs: [entityKey('s', s.id)], cell: c,
              data: { name: s.name, population: Math.round(s.pop * 100000) },
            });
          }
        }
      } else if (this.owner[c] >= 0 && this.pop[c] > ep.settleAt && this.rng.chance(0.004)) {
        const pol = this.polities.get(this.owner[c]);
        const culture = pol && this.cultures.get(pol.cultureId);
        if (culture && this.nearbySettlement(c) < 0) this.foundSettlement(c, culture, false);
      }
    }
    this.globalPop = total;
  }

  // The nearest settlement within two hops, or -1.
  //
  // Two hops, not one. With only immediate neighbours excluded, a long enough
  // run eventually settles most of the map — every cell gets its favourable
  // century sooner or later — and the map vanishes under towns.
  nearbySettlement(cell) {
    const { start, list } = this.world.neighbors;
    for (let k = start[cell]; k < start[cell + 1]; k++) {
      const nb = list[k];
      if (this.cellSettlement[nb] >= 0) return this.cellSettlement[nb];
    }
    for (let k = start[cell]; k < start[cell + 1]; k++) {
      const nb = list[k];
      for (let j = start[nb]; j < start[nb + 1]; j++) {
        if (this.cellSettlement[list[j]] >= 0) return this.cellSettlement[list[j]];
      }
    }
    return -1;
  }

  // Who touches whom. Refreshed on an interval rather than every tick — border
  // topology doesn't change fast enough to be worth the sweep every year.
  refreshBorders() {
    for (const pol of this.polities.values()) {
      pol.neighbors.clear();
      pol.borderCells.length = 0;
    }
    const { start, list } = this.world.neighbors;
    const land = this.world.landCells;
    for (let i = 0; i < land.length; i++) {
      const c = land[i];
      const o = this.owner[c];
      if (o < 0) continue;
      const pol = this.polities.get(o);
      if (!pol) continue;
      let border = false;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const nb = list[k];
        if (this.world.isOcean[nb]) continue;
        const on = this.owner[nb];
        if (on !== o) {
          border = true;
          if (on >= 0) pol.neighbors.add(on);
        }
      }
      if (border) pol.borderCells.push(c);
    }
  }

  // Claiming ground and taking it.
  //
  // Rolling a die per owned cell would mean ~1000 draws to act on ~20 of them.
  // Sampling that many owned cells directly is the same distribution — uniform
  // over held ground, so a large empire still makes proportionally more
  // attempts — for a fiftieth of the work.
  expansionPass(ep) {
    const w = this.world;
    const { start, list } = w.neighbors;
    const owned = this.ownedCells;
    if (owned.length === 0) return;

    const expected = owned.length * ep.expand;
    let attempts = Math.floor(expected);
    if (this.rng.next() < expected - attempts) attempts++;

    for (let i = 0; i < attempts; i++) {
      const c = owned[this.rng.int(owned.length)];
      const o = this.owner[c];
      if (o < 0) continue;
      const pol = this.polities.get(o);
      if (!pol) continue;

      const deg = start[c + 1] - start[c];
      if (deg === 0) continue;
      const nb = list[start[c] + this.rng.int(deg)];
      if (w.isOcean[nb]) continue;

      const on = this.owner[nb];
      if (on === o) continue;

      if (on === -1) {
        // Reach falls off with distance from the capital; the epoch sets how
        // far a state can hold ground at all.
        const dist = this.cellDistance(nb, pol.capital);
        const reachLimit = ep.reach * this.cellPx * (0.7 + pol.stability * 0.6);
        if (dist > reachLimit) continue;
        if (this.pop[c] < 0.12) continue;
        this.claim(nb, pol);
      } else {
        const foe = this.polities.get(on);
        if (!foe) { this.claim(nb, pol); continue; }
        if (!pol.wars.size) continue;
        const war = this.warWith(pol, on);
        if (!war) continue;
        const attack = pol.pop * (1 + pol.stability) * ep.lethality * this.rng.range(0.5, 1.5);
        const defend = foe.pop * (1 + foe.stability) * (1 + this.unrest[nb] * -0.5) * this.rng.range(0.7, 1.4);
        if (attack > defend) {
          const fallen = this.pop[nb] * 0.25 * ep.lethality * this.rng.range(0.4, 1);
          this.pop[nb] -= fallen;
          this.unrest[nb] = Math.min(1, this.unrest[nb] + 0.35);
          this.claim(nb, pol);

          // Tallied on the war itself, so the analysis can say what it cost
          // rather than only who won.
          war.dead += fallen * 100000;
          war.taken[war.a === pol.id ? 0 : 1]++;

          const s = this.cellSettlement[nb] >= 0 && this.settlements.get(this.cellSettlement[nb]);
          if (s && this.rng.chance(0.3)) {
            war.sacks++;
            this.memory.push({
              t: this.year, type: 'war.sack', mag: 0.55 + s.tier * 0.1,
              // The war key is what lets its page gather its own battles;
              // without it a sack is orphaned from the conflict it belonged to.
              refs: [
                entityKey('w', war.id),
                entityKey('p', pol.id),
                entityKey('p', foe.id),
                entityKey('s', s.id),
              ],
              cell: nb,
              data: {
                place: s.name, by: pol.name, from: foe.name,
                dead: Math.round(this.pop[nb] * 40000 + 500),
              },
            });
          }
          pol.exhaustion += 0.02;
          foe.exhaustion += 0.05;
          foe.stability -= 0.02;
          this.addGrudge(foe, pol.id, 0.35);
        } else {
          pol.exhaustion += 0.04;
          pol.stability -= 0.008;
          war.repulsed++;
        }
      }
    }
  }

  claim(cell, pol) {
    const prev = this.owner[cell];
    if (prev >= 0) {
      const old = this.polities.get(prev);
      if (old && old.cells <= 1) this.endPolity(old, 'conquered', pol);
    }
    this.owner[cell] = pol.id;
    if (this.cellCulture[cell] === -1) this.cellCulture[cell] = pol.cultureId;
    if (this.pop[cell] < 0.05) this.pop[cell] = 0.05;
  }

  cellDistance(a, b) {
    const w = this.world;
    const dx = w.sx[a] - w.sx[b];
    const dy = w.sy[a] - w.sy[b];
    return Math.sqrt(dx * dx + dy * dy);
  }

  // The war between these two, or null. Returns the war rather than a boolean
  // because every caller that asks also needs to record something against it —
  // a captured cell, a sacked city, the dead.
  warWith(pol, otherId) {
    for (const wid of pol.wars) {
      const war = this.wars.get(wid);
      if (war && (war.a === otherId || war.b === otherId)) return war;
    }
    return null;
  }

  // A grudge is what makes a war remembered by the people who lost it. Bounded
  // by neighbour count, decayed on the periodic prune, and read back as the
  // `revanche` cause when the wronged side is strong enough to try again.
  addGrudge(pol, againstId, weight) {
    if (!pol || pol.id === againstId) return;
    pol.grudges.set(againstId, Math.min(6, (pol.grudges.get(againstId) || 0) + weight));
  }

  // Rulers, stability, war and collapse. O(live polities).
  politiesPass(ep) {
    const dying = [];
    for (const pol of this.polities.values()) {
      if (pol.cells === 0) { dying.push([pol, 'faded', null]); continue; }

      const ruler = this.people.get(pol.rulerId);
      if (!ruler) {
        // Belt and braces: a polity with no living ruler can never crown one,
        // and would re-enter succession every tick.
        const culture = this.cultureFor(pol);
        const heir = this.newPerson(culture, this.houses.get(pol.houseId));
        heir.crowned = this.year;
        pol.rulerId = heir.id;
      } else if (this.year - ruler.born > ruler.lifespan) {
        this.succeed(pol, ruler);
      }

      // Holding more than the era can administer is the main brake on runaway
      // empires; without it one polity eats the map and stays there. Expressed
      // as a fraction of what the era can hold, so the same coefficient works
      // for a Stone Age chiefdom and an Industrial empire.
      const over = Math.max(0, pol.cells - ep.hold) / ep.hold;
      let unrestSum = 0;
      // Sampled from the border rather than every held cell, to stay O(1).
      const sample = Math.min(6, pol.borderCells.length);
      for (let i = 0; i < sample; i++) {
        unrestSum += this.unrest[pol.borderCells[this.rng.int(pol.borderCells.length)]];
      }
      const unrestAvg = sample ? unrestSum / sample : 0;

      pol.exhaustion = Math.max(0, pol.exhaustion - 0.012);
      pol.stability = Math.max(-1, Math.min(1,
        pol.stability
        + 0.0055
        - over * 0.012
        - pol.exhaustion * 0.02
        - unrestAvg * 0.012
      ));

      if (pol.cells > pol.peakCells) { pol.peakCells = pol.cells; pol.peakYear = this.year; }

      if (pol.stability < -0.3) {
        dying.push([pol, pol.cells > 3 ? 'collapse' : 'dissolve', null]);
        continue;
      }

      if (unrestAvg > 0.55 && this.rng.chance(0.004)) this.revolt(pol);
      if (pol.neighbors.size) {
        // The one place a house's learning reaches into the world: its
        // learned aggression nudges the odds a war actually starts, and this
        // roll — unlike everything else in this file — is real, not seeded.
        const house = this.houses.get(pol.houseId);
        const aggr = house ? house.tendencies.aggression : 0;
        if (realChance(WAR_TRIGGER_BASE + aggr * AGGRESSION_WAR_SWING)) this.considerWar(pol);
      }
    }

    for (const [pol, how, by] of dying) {
      if (!this.polities.has(pol.id)) continue;
      if (how === 'collapse') this.collapse(pol);
      else this.endPolity(pol, how, by);
    }

    this.resolveWars(ep);
    this.maybeFound(ep);

    let largest = 0;
    for (const pol of this.polities.values()) {
      if (pol.cells > largest) largest = pol.cells;
    }
    this.largestPolity = largest;
  }

  succeed(pol, ruler) {
    ruler.died = this.year;
    this.memory.updateEntity(entityKey('n', ruler.id), { died: this.year });
    const violent = this.rng.chance(0.12);
    this.memory.push({
      t: this.year, type: violent ? 'ruler.slain' : 'ruler.die',
      mag: violent ? 0.4 : 0.15,
      refs: [entityKey('n', ruler.id), entityKey('p', pol.id)],
      cell: pol.capital,
      data: { name: ruler.name, polity: pol.name, years: this.year - (ruler.crowned ?? this.year) },
    });

    const culture = this.cultureFor(pol);
    let house = this.houses.get(pol.houseId);
    if (!house) {
      house = this.newHouse(culture);
      pol.houseId = house.id;
      pol.houseSince = this.year;
      this.takeThrone(house, pol);
    }

    // A contested succession is the cheapest way for a stable empire to become
    // an unstable one, which is what keeps long runs from flattening out.
    const crisis = this.rng.chance(0.22 - pol.stability * 0.12);
    let heirHouse = house;
    if (crisis) {
      pol.stability -= this.rng.range(0.2, 0.45);
      if (this.rng.chance(0.4)) {
        // The throne changes hands between houses. The old one is not
        // destroyed — it loses this crown and may hold others, or wait in
        // exile for a restoration.
        this.loseThrone(house, pol);
        heirHouse = this.houseForThrone(pol.capital, culture);
        pol.houseId = heirHouse.id;
        pol.houseSince = this.year;
        this.takeThrone(heirHouse, pol);
        this.feud(house.id, heirHouse.id, 1.2);
      }
      this.memory.push({
        t: this.year, type: 'succession.crisis', mag: 0.45,
        refs: [entityKey('p', pol.id), entityKey('d', heirHouse.id)],
        cell: pol.capital,
        data: { polity: pol.name, house: heirHouse.name },
      });
    }

    const heir = this.newPerson(culture, heirHouse);
    heir.crowned = this.year;
    if (heirHouse) heirHouse.rulers++;
    pol.rulerId = heir.id;
    // The sim only ever needs living rulers; the dead are the archive's
    // problem now. Keeping them here would grow a table forever, which is
    // precisely the thing this design is not allowed to do.
    this.people.delete(ruler.id);
    this.memory.push({
      t: this.year, type: 'ruler.crown', mag: 0.2,
      refs: [entityKey('n', heir.id), entityKey('p', pol.id), entityKey('d', heirHouse.id)],
      cell: pol.capital,
      data: { name: heir.name, polity: pol.name, house: heirHouse.name },
    });
  }

  // Why one state marches on another. Read off the actual state of the world
  // rather than picked from a hat: the archive will overwrite this with a stock
  // phrase once the event has been merged a few times, and that substitution
  // only means anything if there was a true answer to lose.
  warCause(pol, foe) {
    const grudge = pol.grudges.get(foe.id) || 0;
    const house = this.houses.get(pol.houseId);
    const foeHouse = this.houses.get(foe.houseId);
    const feud = house && foeHouse ? (house.feuds.get(foeHouse.id) || 0) : 0;

    if (feud >= 2) return 'dynastic';
    if (grudge >= 1.5) return 'revanche';
    if (foe.stability < -0.12) return 'succession';
    if (pol.pop > foe.pop * 2.2) return 'conquest';
    // Foreign-ruled ground on their side of the border that has not settled.
    let restive = 0;
    const sample = Math.min(5, foe.borderCells.length);
    for (let i = 0; i < sample; i++) {
      const c = foe.borderCells[this.rng.int(foe.borderCells.length)];
      if (this.cellCulture[c] === pol.cultureId && this.unrest[c] > 0.3) restive++;
    }
    if (restive >= 2) return 'culture';
    return 'border';
  }

  considerWar(pol) {
    const ids = [...pol.neighbors];
    // A standing grudge makes a particular neighbour likelier to be the target
    // than simple proximity would.
    let targetId = ids[this.rng.int(ids.length)];
    for (const id of ids) {
      if ((pol.grudges.get(id) || 0) >= 1.5 && this.rng.chance(0.5)) { targetId = id; break; }
    }
    const foe = this.polities.get(targetId);
    if (!foe || this.warWith(pol, targetId)) return;

    const id = this.nextId.war++;
    const cause = this.warCause(pol, foe);
    const war = {
      id, a: pol.id, b: foe.id, began: this.year,
      name: `the war of ${this.year}`,
      cause,
      aName: pol.name, bName: foe.name,
      aHouse: pol.houseId, bHouse: foe.houseId,
      dead: 0, sacks: 0, repulsed: 0, taken: [0, 0],
    };
    this.wars.set(id, war);
    pol.wars.add(id);
    foe.wars.add(id);

    if (cause === 'dynastic') this.feud(pol.houseId, foe.houseId, 0.6);

    this.memory.register('w', id, {
      name: war.name, began: this.year, cause,
      attacker: pol.name, defender: foe.name,
    });
    this.memory.push({
      t: this.year, type: 'war.begin', mag: 0.4,
      refs: [entityKey('w', id), entityKey('p', pol.id), entityKey('p', foe.id)],
      cell: pol.capital,
      // A couple of per cent of the population under arms. The archive will
      // inflate this every time the event is merged, so the figure it starts
      // from has to be one a chronicler could have plausibly written down.
      data: {
        attacker: pol.name, defender: foe.name,
        strength: Math.round(pol.pop * 2000),
        cause: WAR_CAUSES[cause],
      },
    });
  }

  resolveWars(ep) {
    for (const war of this.wars.values()) {
      const a = this.polities.get(war.a);
      const b = this.polities.get(war.b);
      const duration = this.year - war.began;
      const over = !a || !b || duration > 40 + this.rng.int(60)
        || (a.exhaustion > 0.6 && b.exhaustion > 0.6);
      if (!over) continue;

      // Outcome by ground actually taken, not by who happens to be bigger —
      // a small state that held its border has not lost.
      const netTaken = war.taken[0] - war.taken[1];
      const dead = Math.round(war.dead + (a && b ? (a.pop + b.pop) * duration * 20 * ep.lethality : 0));
      const decisive = Math.abs(netTaken) >= 3;
      let victor = null;
      let defeated = null;
      if (a && b && netTaken !== 0) {
        victor = netTaken > 0 ? a : b;
        defeated = netTaken > 0 ? b : a;
      }

      // The war leaves sim state now, so everything the analysis will ever need
      // has to be written into the archive here.
      this.memory.updateEntity(entityKey('w', war.id), {
        ended: this.year, years: duration, dead,
        sacks: war.sacks, repulsed: war.repulsed,
        taken: war.taken.slice(),
        victor: victor ? victor.name : null,
        defeated: defeated ? defeated.name : null,
        stalemate: !victor,
      });

      if (a && b) {
        this.memory.push({
          t: this.year, type: victor ? 'war.end' : 'war.stalemate',
          mag: 0.35 + (decisive ? 0.2 : 0),
          refs: [
            entityKey('w', war.id),
            entityKey('p', (victor || a).id),
            entityKey('p', (defeated || b).id),
          ],
          cell: (victor || a).capital,
          data: {
            victor: victor ? victor.name : null,
            defeated: defeated ? defeated.name : null,
            a: a.name, b: b.name,
            years: duration, dead, taken: Math.abs(netTaken),
          },
        });
        if (victor) {
          victor.exhaustion *= 0.5;
          defeated.stability -= 0.08;
          // Losing ground is what a grudge is made of, and it is what sends the
          // same two states back to war a century later.
          this.addGrudge(defeated, victor.id, 1 + Math.min(2, Math.abs(netTaken) * 0.2));
          this.learnFromWar(victor, defeated);
        } else {
          a.exhaustion *= 0.7;
          b.exhaustion *= 0.7;
        }
        // Houses remember the war their states fought, whoever won.
        this.feud(a.houseId, b.houseId, decisive ? 1 : 0.5);
      }
      if (a) a.wars.delete(war.id);
      if (b) b.wars.delete(war.id);
      this.wars.delete(war.id);
    }
  }

  revolt(pol) {
    const cells = pol.borderCells.filter((c) => this.unrest[c] > 0.4);
    if (cells.length < 2) return;
    const culture = this.cultures.get(this.cellCulture[cells[0]]) || this.cultures.get(pol.cultureId);
    if (!culture) return;
    const seed = cells[this.rng.int(cells.length)];
    const rebel = this.foundPolity(seed, culture);
    for (const c of cells) {
      if (this.rng.chance(0.6)) { this.owner[c] = rebel.id; this.unrest[c] = 0.1; }
    }
    pol.stability -= 0.15;
    this.memory.push({
      t: this.year, type: 'revolt', mag: 0.5,
      refs: [entityKey('p', rebel.id), entityKey('p', pol.id)],
      cell: seed,
      data: { rebel: rebel.name, against: pol.name },
    });
  }

  // Fragmentation. The scan over all cells is O(cells), but collapse is rare
  // enough that it costs nothing amortised — and it is the single most
  // important event type for keeping a long run interesting.
  collapse(pol) {
    // cellList was filled this tick, but expansion has run since, so re-check
    // ownership rather than trusting it.
    const held = pol.cellList.filter((c) => this.owner[c] === pol.id);
    if (held.length === 0) { this.endPolity(pol, 'faded', null); return; }

    const parts = Math.min(4, Math.max(2, Math.round(held.length / 8)));
    const seeds = [];
    for (let i = 0; i < parts; i++) seeds.push(held[this.rng.int(held.length)]);

    const parentCulture = this.cultures.get(pol.cultureId);
    const successors = seeds.map((seed, i) => {
      // Successors that drift culturally are how a family of related languages
      // and names spreads across the map over deep time.
      const culture = (i > 0 && parentCulture && this.rng.chance(0.45))
        ? this.newCulture(parentCulture)
        : parentCulture;
      this.owner[seed] = -1;
      return this.foundPolity(seed, culture || this.newCulture(null));
    });

    for (const c of held) {
      if (this.owner[c] !== pol.id) continue;
      let best = successors[0];
      let bestD = Infinity;
      for (const s of successors) {
        const d = this.cellDistance(c, s.capital);
        if (d < bestD) { bestD = d; best = s; }
      }
      this.owner[c] = best.id;
      this.unrest[c] = Math.min(1, this.unrest[c] + 0.2);
    }

    this.memory.push({
      t: this.year, type: 'polity.collapse', mag: 0.5 + Math.min(1, held.length / 60),
      refs: [entityKey('p', pol.id), ...successors.slice(0, 3).map((s) => entityKey('p', s.id))],
      cell: pol.capital,
      data: {
        name: pol.name, parts: successors.length,
        years: this.year - pol.born, peak: pol.peakCells,
      },
    });
    this.finalizePolity(pol, 'collapse');
  }

  endPolity(pol, how, by) {
    if (how !== 'faded') {
      this.memory.push({
        t: this.year,
        type: how === 'conquered' ? 'polity.conquered' : 'polity.collapse',
        mag: 0.35 + Math.min(0.8, pol.peakCells / 60),
        refs: [entityKey('p', pol.id), ...(by ? [entityKey('p', by.id)] : [])],
        cell: pol.capital,
        data: {
          name: pol.name, by: by ? by.name : null,
          years: this.year - pol.born, peak: pol.peakCells,
        },
      });
    }
    for (const c of pol.cellList) {
      if (this.owner[c] === pol.id) this.owner[c] = by ? by.id : -1;
    }
    this.finalizePolity(pol, how);
  }

  finalizePolity(pol, how) {
    pol.died = this.year;
    this.memory.updateEntity(entityKey('p', pol.id), {
      died: this.year, peak: pol.peakCells, peakYear: pol.peakYear, end: how,
    });
    // The state ends; the house that ruled it does not. It gives up this crown
    // and either holds others or goes into exile with a claim it can press for
    // a few centuries yet.
    this.loseThrone(this.houses.get(pol.houseId), pol);
    for (const wid of pol.wars) {
      const war = this.wars.get(wid);
      if (war) {
        const other = this.polities.get(war.a === pol.id ? war.b : war.a);
        if (other) other.wars.delete(wid);
        this.wars.delete(wid);
      }
    }
    const ruler = this.people.get(pol.rulerId);
    if (ruler && ruler.died === null) {
      ruler.died = this.year;
      this.memory.updateEntity(entityKey('n', ruler.id), { died: this.year });
    }
    this.people.delete(pol.rulerId);
    this.polities.delete(pol.id);
  }

  maybeFound(ep) {
    if (this.polities.size >= MAX_LIVE_POLITIES) return;
    // Rarer when the world is crowded, so the count settles rather than
    // sawtoothing against the cap.
    const pressure = 1 - this.polities.size / MAX_LIVE_POLITIES;
    if (!this.rng.chance(0.02 * pressure)) return;
    const cell = this.pickFoundingCell();
    if (cell < 0 || this.owner[cell] !== -1) return;
    if (this.pop[cell] < 0.1) return;
    const existing = this.cellCulture[cell] >= 0 && this.cultures.get(this.cellCulture[cell]);
    this.foundPolity(cell, existing || this.newCulture(null));
  }

  // Plagues, famines, and the rare catastrophe that deep time remembers when
  // it has forgotten everything else.
  hazardsPass(ep) {
    if (this.winterYears > 0) {
      this.winterYears--;
    } else if (this.rng.chance(WINTER_CHANCE)) {
      this.winterYears = 200 + this.rng.int(400);
      this.memory.push({
        t: this.year, type: 'winter', mag: 2.6, refs: [], cell: -1,
        data: { years: this.winterYears },
      });
    }

    if (this.rng.chance(0.005) && this.polities.size) {
      const list = [...this.polities.values()];
      const pol = list[this.rng.int(list.length)];
      const severity = this.rng.range(0.15, 0.45);
      let dead = 0;
      for (const c of pol.cellList) {
        if (this.owner[c] !== pol.id) continue;
        dead += this.pop[c] * severity;
        this.pop[c] *= 1 - severity;
      }
      pol.stability -= severity * 0.3;
      this.memory.push({
        t: this.year, type: 'plague', mag: 0.3 + severity,
        refs: [entityKey('p', pol.id)], cell: pol.capital,
        data: { polity: pol.name, dead: Math.round(dead * 100000) },
      });
    }

    if (this.rng.chance(0.00035)) {
      const land = this.world.landCells;
      const centre = land[this.rng.int(land.length)];
      const radius = this.rng.range(45, 130);
      let dead = 0;
      for (let i = 0; i < land.length; i++) {
        const c = land[i];
        const d = this.cellDistance(c, centre);
        if (d > radius) continue;
        const bite = (1 - d / radius) * this.rng.range(0.5, 0.95);
        dead += this.pop[c] * bite;
        this.pop[c] *= 1 - bite;
        this.unrest[c] = Math.min(1, this.unrest[c] + 0.3);
      }
      this.memory.push({
        t: this.year, type: 'cataclysm', mag: 2.2,
        refs: [], cell: centre,
        data: { dead: Math.round(dead * 100000), radius: Math.round(radius) },
      });
    }
  }

  // The ratchet, and its pawl.
  //
  // Advancing an era takes accumulated "civilised years" — a stock that only
  // builds while the world is populated well above subsistence, and that drains
  // faster than it built when the world empties. A bad enough cataclysm or a
  // cascade of collapses therefore costs an era, and the world climbs back
  // through it. That slippage is what stops a long run from reaching the last
  // epoch and playing the same century on loop for the next million years.
  epochPass() {
    if (this.year % EPOCH_INTERVAL !== 0) return;
    // Measured against the world's *unperturbed* capacity, not its current one.
    // Against current capacity a volcanic winter registers as plenty rather
    // than famine — capacity falls immediately, population takes centuries to
    // follow, so the ratio briefly goes up. Against the baseline, a capacity
    // collapse reads as what it is.
    const reference = this.baseCapSum * EPOCHS[this.epochIndex].popScale;
    const fill = reference > 0 ? this.globalPop / reference : 0;
    // Progress needs two things, and lacking either one spends it back down:
    // enough food, and a state large enough to hold institutions. Population
    // alone is not enough — people recover from a catastrophe within a few
    // centuries, so a food-only ratchet can never actually slip. Political
    // consolidation does collapse for millennia at a time, and that is what a
    // dark age is.
    //
    // Order is measured against what *this* era can administer, not against the
    // map. An absolute share would deadlock: advancing would need an empire
    // larger than the current era is able to hold together. Measured this way,
    // each era instead has to be grown into — states expand to fill the new
    // administrative ceiling, and only then does the next era start accruing.
    const order = this.largestPolity / EPOCHS[this.epochIndex].hold;
    const surplus = Math.min(fill - SUBSISTENCE, (order - ORDER_FLOOR) * 0.6);
    const ep = this.epochIndex;
    // Progress can be banked at most one era ahead. Without the ceiling a long
    // prosperous stretch accumulates so much that no catastrophe can ever spend
    // it back down, the pawl can never slip, and deep time flattens into the
    // same era repeating — which is the failure this whole mechanism exists to
    // prevent.
    const ceiling = EPOCH_THRESHOLDS[Math.min(EPOCH_THRESHOLDS.length - 1, ep + 1)] * 1.03;
    this.knowledge = Math.max(0, Math.min(ceiling,
      this.knowledge + surplus * EPOCH_INTERVAL * (surplus > 0 ? 1 : 4)));

    if (ep < EPOCHS.length - 1 && this.knowledge > EPOCH_THRESHOLDS[ep + 1]) {
      this.epochIndex++;
      this.memory.push({
        t: this.year, type: 'epoch', mag: 1.2, refs: [], cell: -1,
        data: { name: EPOCHS[this.epochIndex].name, direction: 'begins' },
      });
    } else if (ep > 0 && this.knowledge < EPOCH_THRESHOLDS[ep] * 0.88) {
      this.epochIndex--;
      this.memory.push({
        t: this.year, type: 'epoch', mag: 1.5, refs: [], cell: -1,
        data: { name: EPOCHS[this.epochIndex].name, direction: 'returns' },
      });
    }
  }

  // ---- interface ---------------------------------------------------------

  pushKeyframe() {
    this.memory.pushKeyframe(this.year, this.owner);
  }

  liveKeys() {
    const keys = new Set();
    for (const p of this.polities.values()) {
      keys.add(entityKey('p', p.id));
      keys.add(entityKey('n', p.rulerId));
      keys.add(entityKey('d', p.houseId));
      keys.add(entityKey('c', p.cultureId));
    }
    for (const s of this.settlements.values()) keys.add(entityKey('s', s.id));
    for (const w of this.wars.values()) keys.add(entityKey('w', w.id));
    return keys;
  }

  // Everything the UI needs for one frame. Deliberately small: the map is 2016
  // cells, so the whole ownership array costs 8KB a frame.
  snapshot() {
    const polities = [];
    for (const pol of this.polities.values()) {
      const ruler = this.people.get(pol.rulerId);
      polities.push({
        id: pol.id, name: pol.name, cells: pol.cells,
        pop: pol.pop, stability: pol.stability, born: pol.born,
        capital: pol.capital,
        ruler: ruler ? (ruler.epithet ? `${ruler.name} ${ruler.epithet}` : ruler.name) : null,
        culture: (this.cultures.get(pol.cultureId) || {}).name || null,
      });
    }
    polities.sort((a, b) => b.cells - a.cells);

    const settlements = [];
    for (const s of this.settlements.values()) {
      settlements.push({ id: s.id, cell: s.cell, name: s.name, tier: s.tier });
    }

    return {
      year: this.year,
      owners: this.owner.slice(),
      polities: polities.slice(0, 60),
      politiesTotal: this.polities.size,
      settlements,
      globalPop: this.globalPop,
      epoch: this.epoch.name,
      climate: this.climatePhase,
      winterYears: this.winterYears,
      stats: this.memory.stats(this.year),
    };
  }

  // Invariant checks, callable from the tests without a test framework.
  selftest() {
    const problems = [];
    const live = new Set(this.polities.keys());
    let owned = 0;
    for (let c = 0; c < this.owner.length; c++) {
      const o = this.owner[c];
      if (o < 0) continue;
      owned++;
      if (!live.has(o)) problems.push(`cell ${c} owned by dead polity ${o}`);
      if (this.world.isOcean[c]) problems.push(`ocean cell ${c} is owned`);
    }
    if (owned > this.world.landCells.length) problems.push('owned cells exceed land cells');
    for (const ev of this.memory.events) {
      if (ev.t > this.year || ev.t < 0) problems.push(`event ${ev.id} out of time range`);
    }
    for (const s of this.settlements.values()) {
      if (this.cellSettlement[s.cell] !== s.id) {
        problems.push(`settlement ${s.id} not indexed at its cell`);
      }
    }
    for (const house of this.houses.values()) {
      if (Math.abs(house.tendencies.aggression) > TENDENCY_CLAMP + 1e-9) {
        problems.push(`house ${house.id} aggression out of bounds`);
      }
      if (Math.abs(house.tendencies.restoration) > TENDENCY_CLAMP + 1e-9) {
        problems.push(`house ${house.id} restoration out of bounds`);
      }
      if (Math.abs(house.momentum) > MOMENTUM_CLAMP + 1e-9) {
        problems.push(`house ${house.id} momentum out of bounds`);
      }
    }
    return problems;
  }
}
