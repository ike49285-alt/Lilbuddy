// memory.js — the archive, and the reason this thing can run forever.
//
// The simulation is constant-cost: fixed cells, bounded living entities. The
// only thing that grows with elapsed time is the *record* of what happened. So
// the record is given a hard budget and made to forget.
//
// Events age into successively coarser tiers. Each tier has a fixed capacity;
// when it overflows, similar events are merged and the least salient are
// dropped. Merging loses information, and the retelling has to fill the gaps —
// which is exactly where myth comes from. Distortion isn't a feature bolted on
// top of the archive, it is what running out of room looks like.
//
// Note what this means: above the chronicle tier the truth is genuinely gone.
// Nothing here keeps a hidden copy. The only way to find out what really
// happened in deep time is to replay the world from its seed.

export const TIERS = [
  { key: 'living',    label: 'living memory',   maxAge: 200,      budget: 4000, tau: 140 },
  { key: 'recorded',  label: 'recorded history', maxAge: 2000,     budget: 3000, tau: 1400 },
  { key: 'chronicle', label: 'chronicle',        maxAge: 20000,    budget: 1500, tau: 14000 },
  { key: 'legend',    label: 'legend',           maxAge: 200000,   budget: 400,  tau: 140000 },
  { key: 'deep',      label: 'deep time',        maxAge: Infinity, budget: 60,   tau: Infinity },
];

// How much each kind of event is worth keeping, before decay. Structural events
// — ones that created or ended something — outrank big-but-consequenceless ones,
// which is why a founding outlives a bloodier battle from the same century.
const STRUCTURAL = {
  'world.begin':      12,
  'cataclysm':         6,
  'winter':            7,
  'polity.found':      3.0,
  'polity.collapse':   3.2,
  'polity.conquered':  2.6,
  'settle.found':      1.8,
  'settle.city':       1.2,
  'war.begin':         1.4,
  'war.end':           1.6,
  'war.stalemate':     1.1,
  'war.sack':          1.5,
  'alliance.formed':   1.5,  // comparable to war.begin/revolt — the seed of a relationship
  'alliance.broken':   1.8,  // a betrayal outlasts the pact it broke, close to culture.split
  'house.found':       0.8,
  'house.ascend':      3.4,
  'house.deposed':     2.2,
  'house.restored':    3.0,
  'house.extinct':     2.4,
  'ruler.crown':       0.7,
  'ruler.die':         0.6,
  'ruler.slain':       1.3,
  'succession.crisis': 1.4,
  'revolt':            1.5,
  'culture.split':     1.7,
  'epoch':             4.0,
  'plague':            1.6,
};

// Stock causes that get substituted in once the real one has been forgotten.
const STOCK_CAUSES = [
  'an insult at a wedding feast',
  'a disputed inheritance',
  'the theft of a sacred relic',
  'a broken oath',
  'a murdered envoy',
  'a prophecy',
  'a quarrel over a river crossing',
  'the refusal of a bride',
];

const MYTHIC_FRAMES = [
  'is said to have',
  'is remembered to have',
  'in some tellings',
  'by one account',
];

const ENTITY_SWEEP_EVERY = 4;

export function entityKey(kind, id) {
  return `${kind}:${id}`;
}

// Keyframes of cell ownership, stored run-length encoded. Ownership is highly
// contiguous — an empire is a blob — so RLE typically gets an order of
// magnitude, and it makes the stored form cheap to diff later if wanted.
function encodeRuns(owners) {
  const runs = [];
  let value = owners[0];
  let len = 1;
  for (let i = 1; i < owners.length; i++) {
    if (owners[i] === value) { len++; continue; }
    runs.push(value, len);
    value = owners[i];
    len = 1;
  }
  runs.push(value, len);
  return Int32Array.from(runs);
}

function decodeRuns(runs, length) {
  const out = new Int32Array(length);
  let p = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const value = runs[i];
    const len = runs[i + 1];
    out.fill(value, p, p + len);
    p += len;
  }
  return out;
}

// Keyframe spacing widens with age at a constant rate per decade of age, so the
// count grows logarithmically with runtime rather than linearly. At a million
// years that is a few hundred keyframes; there is no runtime at which it
// becomes a problem.
export function keyframeSpacing(age) {
  if (age <= 2000) return 25;
  const scale = Math.pow(10, Math.floor(Math.log10(age / 2000)));
  return 250 * scale;
}

export class Memory {
  constructor(rng, cellCount) {
    // Its own stream, forked off the world seed. The archive must never draw
    // from the simulation's generator: if it did, how much history had been
    // forgotten would feed back into what happens next, and replaying from the
    // seed would no longer reproduce the world.
    this.rng = rng.fork('memory');
    this.cellCount = cellCount;
    this.events = [];
    this.entities = new Map();
    this.keyframes = [];
    this.nextEventId = 1;
    this.droppedCount = 0;
    this.mergedCount = 0;
    this.compactionCount = 0;
  }

  // ---- full-state snapshot (save/load) ------------------------------------
  //
  // Used only by Simulation.saveState()/restoreLiveState() — the archive's
  // own rng isn't preserved across a save (there's nothing tick-sequence
  // dependent left to keep in sync once house learning's one real-random
  // roll already means replay can diverge; a fresh fork is exactly what a
  // brand-new Memory instance sets up on construction).
  saveState() {
    return {
      events: this.events,
      entities: [...this.entities.entries()],
      keyframes: this.keyframes.map((kf) => ({ t: kf.t, runs: Array.from(kf.runs) })),
      nextEventId: this.nextEventId,
      droppedCount: this.droppedCount,
      mergedCount: this.mergedCount,
      compactionCount: this.compactionCount,
    };
  }

  static fromState(state, rng, cellCount) {
    const m = new Memory(rng, cellCount);
    m.events = state.events;
    m.entities = new Map(state.entities);
    m.keyframes = state.keyframes.map((kf) => ({ t: kf.t, runs: Int32Array.from(kf.runs) }));
    m.nextEventId = state.nextEventId;
    m.droppedCount = state.droppedCount;
    m.mergedCount = state.mergedCount;
    m.compactionCount = state.compactionCount;
    return m;
  }

  // ---- writing -----------------------------------------------------------

  register(kind, id, record) {
    this.entities.set(entityKey(kind, id), { kind, id, ...record });
  }

  entity(key) {
    return this.entities.get(key) || null;
  }

  updateEntity(key, patch) {
    const e = this.entities.get(key);
    if (e) Object.assign(e, patch);
  }

  push(event) {
    const ev = {
      id: this.nextEventId++,
      t: event.t,
      type: event.type,
      refs: event.refs || [],
      cell: event.cell === undefined ? -1 : event.cell,
      mag: event.mag || 0,
      data: event.data || {},
      first: !!event.first,
      dist: 0,
      merged: 1,
      tier: 0,
    };
    ev.base = this.baseSalience(ev);
    this.events.push(ev);
    return ev;
  }

  baseSalience(ev) {
    return (STRUCTURAL[ev.type] || 0.5) + ev.mag * 2 + (ev.first ? 1.5 : 0);
  }

  pushKeyframe(t, owners) {
    this.keyframes.push({ t, runs: encodeRuns(owners) });
  }

  // ---- compaction --------------------------------------------------------

  // `liveKeys` is the set of entity keys the simulation still considers alive.
  // It flows sim -> memory only; nothing here is ever read back by the sim.
  compact(now, liveKeys) {
    for (const ev of this.events) ev.tier = tierFor(now - ev.t);

    const byTier = TIERS.map(() => []);
    for (const ev of this.events) byTier[ev.tier].push(ev);

    const kept = [];
    for (let ti = 0; ti < TIERS.length; ti++) {
      const tier = TIERS[ti];
      let bucket = byTier[ti];
      if (bucket.length > tier.budget) bucket = this.mergeSimilar(bucket, ti, now);
      if (bucket.length > tier.budget) bucket = this.dropLeastSalient(bucket, ti, now, liveKeys);
      for (const ev of bucket) kept.push(ev);
    }
    this.events = kept;

    // The entity sweep walks every event's refs, so it is the most expensive
    // part of compaction. Entities are already bounded by what the events can
    // reference, so running it every few compactions rather than every one
    // costs a little slack in the registry and buys back most of that time.
    this.compactionCount++;
    if (this.compactionCount % ENTITY_SWEEP_EVERY === 0) this.sweepEntities(liveKeys);
    this.pruneKeyframes(now);
  }

  // Fold events of the same kind, by the same actor, close together in time
  // into one composite. This is the step that destroys detail — and the step
  // that turns two forgettable kings into one long-reigning legendary one.
  mergeSimilar(bucket, tierIndex, now) {
    const tier = TIERS[tierIndex];
    // Window scales with the tier: at chronicle range, a century is "the same
    // moment" as far as the record is concerned.
    const window = Math.max(10, tier.maxAge === Infinity ? 50000 : tier.maxAge / 8);
    const groups = new Map();
    for (const ev of bucket) {
      const actor = ev.refs.length ? ev.refs[0] : '-';
      const slot = Math.floor(ev.t / window);
      const key = `${ev.type}|${actor}|${slot}`;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(ev);
    }

    const out = [];
    for (const group of groups.values()) {
      if (group.length === 1) { out.push(group[0]); continue; }
      out.push(this.mergeGroup(group, now));
    }
    return out;
  }

  mergeGroup(group, now) {
    group.sort((a, b) => b.base - a.base);
    const lead = group[0];
    const total = group.reduce((n, e) => n + e.merged, 0);
    const composite = {
      ...lead,
      refs: dedupe(group.flatMap((e) => e.refs)).slice(0, 4),
      merged: total,
      dist: Math.max(...group.map((e) => e.dist)) + 1,
      mag: Math.min(3, Math.max(...group.map((e) => e.mag)) + 0.1 * (group.length - 1)),
      span: [Math.min(...group.map((e) => e.t)), Math.max(...group.map((e) => e.t))],
      data: { ...lead.data },
    };
    this.mergedCount += group.length - 1;
    this.distort(composite, now);
    composite.base = this.baseSalience(composite);
    return composite;
  }

  // What the retelling does to fill the gaps left by merging.
  distort(ev, now) {
    const r = this.rng;

    // Numbers grow in the telling. Compounding across tiers gets a border
    // skirmish to an army of hundreds of thousands by deep time.
    for (const k of ['dead', 'strength', 'population']) {
      if (typeof ev.data[k] !== 'number') continue;
      // Capped, and rounded off once the figure is clearly legendary. "Some
      // nine hundred thousand" reads as a chronicler's exaggeration;
      // 906,189,064 reads as an integer overflow.
      const grown = Math.min(2e7, ev.data[k] * r.range(1.7, 2.6));
      ev.data[k] = ev.dist >= 2 ? roundSignificant(grown, 2) : Math.round(grown);
    }
    // Durations get the same treatment but far more gently, and capped. A king
    // remembered as reigning three hundred years is a legend; one remembered as
    // reigning twenty thousand is a bug.
    if (typeof ev.data.years === 'number') {
      ev.data.years = Math.min(400, Math.round(ev.data.years * r.range(1.05, 1.35)));
    }

    // Attribution drifts toward whoever the record still remembers.
    if (ev.dist >= 2 && ev.refs.length > 1 && r.chance(0.4)) {
      const [a, b] = [ev.refs[0], ev.refs[1]];
      ev.refs[0] = b;
      ev.refs[1] = a;
      ev.data.attributionDrifted = true;
    }

    // The cause is the first thing to go.
    if (ev.dist >= 2 && r.chance(0.5)) {
      ev.data.cause = r.pick(STOCK_CAUSES);
      ev.data.causeApocryphal = true;
    }

    // And eventually the record simply has it wrong. No copy of the truth is
    // kept anywhere — replaying from the seed is the only way to check.
    if (ev.dist >= 3 && r.chance(0.12)) {
      ev.data.inverted = true;
    }

    if (ev.dist >= 2) ev.data.frame = r.pick(MYTHIC_FRAMES);
  }

  dropLeastSalient(bucket, tierIndex, now, liveKeys) {
    const tier = TIERS[tierIndex];
    for (const ev of bucket) ev.score = this.score(ev, now, tier, liveKeys);
    bucket.sort((a, b) => b.score - a.score);
    this.droppedCount += bucket.length - tier.budget;
    return bucket.slice(0, tier.budget);
  }

  // An event's hold on the record strengthens if the things it refers to are
  // still around. This is where retroactive importance comes from: a minor
  // founding survives thirty thousand years because the city it founded is
  // still standing.
  score(ev, now, tier, liveKeys) {
    const age = now - ev.t;
    const decay = tier.tau === Infinity ? 1 : Math.exp(-age / tier.tau);
    let live = 0;
    for (const ref of ev.refs) {
      if (liveKeys.has(ref)) live++;
      else if (this.entities.has(ref)) live += 0.25;
    }
    return ev.base * decay * (1 + 0.45 * live) * (1 + 0.1 * Math.log2(ev.merged + 1));
  }

  // An entity is worth remembering while it exists, or while something that is
  // still remembered refers to it. Everything else is forgotten with its
  // events, which is what keeps the registry from growing without bound.
  sweepEntities(liveKeys) {
    const needed = new Set(liveKeys);
    for (const ev of this.events) {
      for (const ref of ev.refs) needed.add(ref);
    }
    for (const key of this.entities.keys()) {
      if (!needed.has(key)) this.entities.delete(key);
    }
  }

  pruneKeyframes(now) {
    this.keyframes = this.keyframes.filter((kf) => {
      const age = now - kf.t;
      return kf.t % keyframeSpacing(age) === 0;
    });
  }

  // ---- reading -----------------------------------------------------------

  // The newest keyframe at or before `year`. The gap between that year and the
  // one asked for is the resolution the record still has at that depth — the
  // scrubber shows it, because a blurry deep past is the honest presentation.
  keyframeAt(year) {
    let best = null;
    for (const kf of this.keyframes) {
      if (kf.t <= year && (!best || kf.t > best.t)) best = kf;
    }
    if (!best) return null;
    return { t: best.t, owners: decodeRuns(best.runs, this.cellCount) };
  }

  eventsInRange(t0, t1, limit = 200) {
    const out = [];
    for (const ev of this.events) {
      if (ev.t >= t0 && ev.t <= t1) out.push(ev);
    }
    out.sort((a, b) => b.t - a.t || b.base - a.base);
    return out.slice(0, limit);
  }

  eventsFor(key, limit = 120) {
    const out = [];
    for (const ev of this.events) {
      if (ev.refs.includes(key)) out.push(ev);
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(0, limit);
  }

  searchEntities(query, limit = 30) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const e of this.entities.values()) {
      if (e.name && e.name.toLowerCase().includes(q)) out.push(e);
      if (out.length >= limit * 3) break;
    }
    out.sort((a, b) => (a.name.length - b.name.length));
    return out.slice(0, limit);
  }

  stats(now) {
    const perTier = TIERS.map(() => 0);
    for (const ev of this.events) perTier[tierFor(now - ev.t)]++;
    return {
      events: this.events.length,
      entities: this.entities.size,
      keyframes: this.keyframes.length,
      dropped: this.droppedCount,
      merged: this.mergedCount,
      perTier,
      // Rough retained-bytes estimate, for the boundedness readout in the UI.
      keyframeInts: this.keyframes.reduce((n, k) => n + k.runs.length, 0),
    };
  }
}

export function tierFor(age) {
  for (let i = 0; i < TIERS.length; i++) {
    if (age <= TIERS[i].maxAge) return i;
  }
  return TIERS.length - 1;
}

function roundSignificant(value, digits) {
  if (value === 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(value))) - (digits - 1));
  return Math.round(value / mag) * mag;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
