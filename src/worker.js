// worker.js — owns the simulation and keeps it ticking.
//
// The sim runs here so a fast-forward through fifty thousand years doesn't
// freeze the page. Tick rate is decoupled from frame rate: the loop ticks up to
// a time budget, then yields and posts one frame regardless of how many years
// went by. At full speed that is a few thousand years a second; at slow speeds
// it is a handful of ticks with the same cadence.

import { Simulation } from './sim.js';
import { biomePalette } from './world.js';
import { entityKey, TIERS, keyframeSpacing, tierFor } from './memory.js';
import { hashNumbers, cyrb128, makeRng } from './rng.js';
import { placeName, personName } from './names.js';

const hashString = (s) => cyrb128(s)[0] | 0;
// Mirrors sim.js's ALLIANCE_STRONG (duplicated, not imported — worker.js
// speaks to the UI in finished shapes, same reasoning as WAR_CAUSE_LABELS
// below).
const ALLIANCE_STRONG = 4;

let sim = null;
let running = false;
let speed = 40;            // target ticks per second; Infinity means "as fast as it goes"
let timer = null;
let lastPost = 0;
let lastSlice = 0;       // wall clock at the previous slice
let tickDebt = 0;        // years owed but not yet run, carried as a fraction
let rateTicks = 0;       // ticks since the rate window opened
let rateSince = 0;
let shownRate = 0;       // years per wall-clock second, as displayed
let sendUnrest = false;  // whether the live frame should carry the unrest overlay

const FRAME_MS = 50;       // cap UI updates at 20/sec; the sim is not slowed by this
const BUDGET_MS = 12;      // per-slice tick budget, leaves the worker responsive
const CATCHUP_BUDGET_MS = 20000; // wall-clock cap on how long idle catch-up is allowed to take

function announceWorld() {
  const w = sim.world;
  const palette = biomePalette(w);
  // Copies, because these are transferred and the sim still needs its own.
  const raster = w.raster.slice();
  const sx = w.sx.slice();
  const sy = w.sy.slice();
  self.postMessage({
    type: 'world',
    seed: sim.seed,
    world: {
      width: w.width, height: w.height, cellCount: w.cellCount,
      raster, palette, sx, sy,
      landCount: w.landCells.length,
    },
    snapshot: sim.snapshot(),
    tiers: TIERS.map((t) => ({ key: t.key, label: t.label, maxAge: t.maxAge, budget: t.budget })),
  }, [raster.buffer, palette.buffer, sx.buffer, sy.buffer]);
}

// Idle-game catch-up: fast-forwards a freshly restored sim by the real time
// that passed while its tab was closed, one bounded slice at a time (the
// same BUDGET_MS the live loop() below already ticks in) so the worker
// stays responsive and the page can show live progress. Capped by
// wall-clock time, not by years — a short absence catches up exactly and
// near-instantly; a very long one catches up as much as fits in
// CATCHUP_BUDGET_MS and lands there, rather than blocking for minutes.
function catchUp(target, deadline, onDone) {
  const sliceStart = now();
  while (sim.year < target && now() - sliceStart < BUDGET_MS) sim.tick();
  self.postMessage({ type: 'catchingUp', year: sim.year, target });
  if (sim.year >= target || now() >= deadline) { onDone(); return; }
  setTimeout(() => catchUp(target, deadline, onDone), 0);
}

// `restoreState` (from a save/load or the continue slot) skips seeding a
// fresh world and repopulates live state instead — see Simulation's
// constructor. `catchUpYears`, when positive, fast-forwards that restored
// world by the real time that passed while its tab was closed (see
// catchUp() above) before announcing it — see the note on realChance() in
// sim.js for why this is safe: catch-up is just running the same tick()
// loop more times, nothing new. Either way this ends the same: announce the
// world (the same 'world' message a normal seed-init sends), which is what
// gets app.js to build a renderer/climate strip and start the run loop.
function init(seed, restoreState = null, catchUpYears = 0) {
  sim = new Simulation(seed, restoreState);
  if (catchUpYears > 0) {
    catchUp(sim.year + catchUpYears, now() + CATCHUP_BUDGET_MS, announceWorld);
  } else {
    announceWorld();
  }
}

function loop() {
  if (!running || !sim) return;
  const started = now();
  // Real elapsed time drives how many years are owed, and the debt carries
  // fractions across slices. Deriving a whole tick count per slice instead
  // puts a floor under the speed control: at a 50ms cadence, "at least one
  // tick per slice" is twenty years a second however slow the setting says.
  // Clamped so a backgrounded tab doesn't come back and sprint.
  const dt = lastSlice ? Math.min(0.5, (started - lastSlice) / 1000) : 0;
  lastSlice = started;

  let ticks = 0;
  if (speed === Infinity) {
    while (now() - started < BUDGET_MS) { sim.tick(); ticks++; }
  } else {
    tickDebt = Math.min(tickDebt + speed * dt, speed * 0.5 + 1);
    while (tickDebt >= 1 && now() - started < BUDGET_MS) {
      sim.tick();
      ticks++;
      tickDebt -= 1;
    }
  }

  // Years per wall-clock second, averaged over about a second. Measuring
  // within the slice instead reports how fast the sim *can* run rather than
  // how fast it is running — at 60 yr/s that reads as several thousand.
  // The window has to hold a few ticks before it can report a fraction: over
  // one second at half a year a second, the count is only ever 0 or 1, which
  // reads as a rate of zero or double the real one. So it widens until it has
  // enough to divide, and gives up at five seconds.
  rateTicks += ticks;
  const window = started - rateSince;
  if (window >= 1000 && (rateTicks >= 3 || window >= 5000)) {
    shownRate = rateTicks / (window / 1000);
    rateTicks = 0;
    rateSince = started;
  }

  // At a year every two seconds there is usually nothing new to send, but the
  // panel still needs an occasional refresh.
  if (ticks > 0 || now() - lastPost >= 500) postFrame(shownRate);

  const wait = speed === Infinity ? 1 : Math.max(1, FRAME_MS - (now() - started));
  timer = setTimeout(loop, wait);
}

function postFrame(rate) {
  lastPost = now();
  const snapshot = sim.snapshot();
  if (rate !== undefined) snapshot.rate = rate;
  const transfer = [snapshot.owners.buffer];
  // Unrest is per-cell sim state that never leaves the worker otherwise —
  // sent only while something is actually asking to see it, so watching the
  // map plainly doesn't pay for a second array every frame.
  if (sendUnrest) {
    snapshot.unrest = sim.unrest.slice();
    transfer.push(snapshot.unrest.buffer);
  }
  self.postMessage({ type: 'frame', snapshot }, transfer);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Which entity an event is really *about*. Events name several things — a sack
// names the taker, the loser, the city and the war — and tapping one should
// open the thing it belonged to, not the first name in the list.
function subjectOf(ev) {
  const pick = (prefix) => ev.refs.find((r) => r.startsWith(prefix)) || null;
  if (pick('w:')) return pick('w:');
  if (ev.type.startsWith('house.')) return pick('d:');
  if (ev.type.startsWith('ruler.') || ev.type === 'succession.crisis') {
    return pick('n:') || pick('d:') || pick('p:');
  }
  if (ev.type.startsWith('polity.') || ev.type === 'revolt' || ev.type === 'plague') return pick('p:');
  if (ev.type.startsWith('settle.')) return pick('s:');
  if (ev.type.startsWith('culture.')) return pick('c:');
  return ev.refs[0] || null;
}

function describeEntity(key) {
  const rec = sim.memory.entity(key);
  if (!rec) return { key, name: null, kind: key.split(':')[0], forgotten: true };
  const out = { key, name: rec.name, kind: rec.kind, alive: isAlive(key) };
  if (rec.kind === 'p') {
    const pol = sim.polities.get(rec.id);
    if (pol) {
      const ruler = sim.people.get(pol.rulerId);
      const house = sim.houses.get(pol.houseId);
      out.ruler = ruler ? (ruler.epithet ? `${ruler.name} ${ruler.epithet}` : ruler.name) : null;
      out.house = house ? house.name : null;
      out.cells = pol.cells;
      out.id = pol.id;
    } else {
      out.id = rec.id;
      out.house = rec.house || null;
      out.ended = rec.died ?? null;
    }
  }
  return out;
}

// Live rivalries for a still-standing state — its hottest few grudges,
// resolved to names. A fallen state carries none: the Map that held them
// stopped existing the moment sim.polities dropped it, same as everything
// else that's only ever live sim state rather than archived record.
function grudgesFor(key) {
  const [kind, raw] = key.split(':');
  if (kind !== 'p') return [];
  const pol = sim.polities.get(Number(raw));
  if (!pol || !pol.grudges.size) return [];
  return [...pol.grudges.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, weight]) => {
      const rec = sim.memory.entity(entityKey('p', id));
      return rec ? { key: entityKey('p', id), name: rec.name, weight } : null;
    })
    .filter(Boolean); // a grudge against a state the archive has forgotten isn't worth showing
}

// Live alliances for a still-standing state — the positive counterpart to
// grudgesFor above, same shape, same reasoning: a fallen state carries none.
function alliesFor(key) {
  const [kind, raw] = key.split(':');
  if (kind !== 'p') return [];
  const pol = sim.polities.get(Number(raw));
  if (!pol || !pol.allies.size) return [];
  return [...pol.allies.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, weight]) => {
      const rec = sim.memory.entity(entityKey('p', id));
      return rec ? { key: entityKey('p', id), name: rec.name, weight, strong: weight >= ALLIANCE_STRONG } : null;
    })
    .filter(Boolean);
}

// A culture's family tree, read straight off the archive: every culture's
// entity record already carries the id of the one it split from, so the
// ancestor chain is a walk up `.parent`, no live sim state needed and no
// bound on how far back it can reach that the archive itself doesn't
// already impose. Children go the other way — anything in the archive's
// whole entity registry naming this one as parent, live or long since
// retired. A branch the archive has genuinely forgotten (no surviving
// record, no surviving event that named it) just doesn't appear, same as
// everywhere else in Chronicle.
function cultureTree(key, rec) {
  const ancestors = [];
  const seen = new Set([key]);
  let cur = rec;
  while (cur && cur.parent != null) {
    const pkey = entityKey('c', cur.parent);
    if (seen.has(pkey)) break; // cycle guard; shouldn't happen, but never loop forever on it
    seen.add(pkey);
    const prec = sim.memory.entity(pkey);
    if (!prec) break; // the archive doesn't remember what came before this
    ancestors.unshift({ key: pkey, name: prec.name, born: prec.born ?? null });
    cur = prec;
  }

  const id = Number(key.split(':')[1]);
  const children = [];
  for (const e of sim.memory.entities.values()) {
    if (e.kind === 'c' && e.parent === id) {
      children.push({ key: entityKey('c', e.id), name: e.name, born: e.born ?? null, alive: sim.cultures.has(e.id) });
    }
  }
  children.sort((a, b) => (a.born ?? 0) - (b.born ?? 0));

  // A flavour sample in this culture's own voice — only possible while it's
  // still spoken; its phonology was never anything but live sim state, and a
  // retired culture doesn't carry one in the archive. Seeded independently of
  // sim.rng: this is a read-only display query, and it must never be able to
  // perturb the tick loop's own random sequence.
  let sample = null;
  const live = sim.cultures.get(id);
  if (live) {
    const displayRng = makeRng(`${sim.seed}:culturesample:${id}`);
    sample = { place: placeName(live.phonology, displayRng), person: personName(live.phonology, displayRng) };
  }

  return { ancestors, children, sample };
}

// A living house's lineage: every throne it holds now, its past reigns, and
// its hottest feuds — all of it live sim state (`heldPast` already carries
// resolved names and capitals from the moment each throne was lost, so no
// archive lookups are needed for those). Gone once the house itself is
// retired: retireHouses() only leaves a summary behind via updateEntity, by
// design — the full lineage was never meant to outlive the house that held
// it, the same way a state's own detail doesn't outlive the state.
function houseLineage(key) {
  const [kind, raw] = key.split(':');
  if (kind !== 'd') return null;
  const house = sim.houses.get(Number(raw));
  if (!house) return null;

  const thrones = [...house.thrones]
    .map((id) => { const pol = sim.polities.get(id); return pol ? { key: entityKey('p', id), name: pol.name } : null; })
    .filter(Boolean);

  const heldPast = house.heldPast
    .map((span) => ({
      key: entityKey('p', span.polity), name: span.name, from: span.from, to: span.to,
      alive: sim.polities.has(span.polity),
    }))
    .reverse(); // most recent reign first

  const feuds = [...house.feuds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, weight]) => {
      const other = sim.houses.get(id);
      const name = other ? other.name : (sim.memory.entity(entityKey('d', id)) || {}).name;
      return name ? { key: entityKey('d', id), name, weight } : null;
    })
    .filter(Boolean);

  const allies = [...house.allies.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, weight]) => {
      const other = sim.houses.get(id);
      const name = other ? other.name : (sim.memory.entity(entityKey('d', id)) || {}).name;
      return name ? { key: entityKey('d', id), name, weight, strong: weight >= ALLIANCE_STRONG } : null;
    })
    .filter(Boolean);

  return {
    thrones, heldPast, feuds, allies,
    tendencies: { ...house.tendencies, momentum: house.momentum },
  };
}

// Everything the archive still holds about what an event belonged to. For a
// war that is both sides, why it started, every engagement inside it, what it
// cost and how it ended — assembled from the event log and the war's own
// post-mortem, both of which decay, so an old war returns less than a recent
// one and says so.
function analysisFor(eventId) {
  const ev = sim.memory.events.find((e) => e.id === eventId);
  if (!ev) return { type: 'analysis', missing: true };

  const subject = subjectOf(ev);
  const record = subject ? sim.memory.entity(subject) : null;
  const contained = subject ? sim.memory.eventsFor(subject, 60) : [];

  const related = {};
  for (const source of [ev, ...contained]) {
    for (const ref of source.refs) {
      if (ref === subject || related[ref] !== undefined) continue;
      const r = sim.memory.entity(ref);
      related[ref] = r ? { name: r.name, kind: r.kind } : null;
    }
  }

  let war = null;
  if (subject && subject.startsWith('w:') && record) {
    // Sides come from the events that frame the war — its declaration and its
    // outcome — not from every event that mentions it. Compaction merges the
    // refs of everything it folds together, so scavenging all contained events
    // returns a dozen states that were never in this war.
    const framing = ['war.begin', 'war.end', 'war.stalemate'];
    const sideKeys = [];
    const collect = (source) => {
      for (const ref of source.refs) {
        if (ref.startsWith('p:') && !sideKeys.includes(ref)) sideKeys.push(ref);
      }
    };
    for (const kind of framing) {
      for (const source of [ev, ...contained]) {
        if (source.type === kind) collect(source);
      }
      if (sideKeys.length >= 2) break;
    }
    if (!sideKeys.length) collect(ev);
    war = {
      name: record.name,
      began: record.began,
      ended: record.ended ?? null,
      years: record.years ?? (sim.year - record.began),
      cause: record.cause || null,
      causeLabel: record.cause ? WAR_CAUSE_LABELS[record.cause] : null,
      attacker: record.attacker || null,
      defender: record.defender || null,
      victor: record.victor ?? null,
      defeated: record.defeated ?? null,
      stalemate: !!record.stalemate,
      dead: record.dead ?? null,
      sacks: record.sacks ?? null,
      repulsed: record.repulsed ?? null,
      taken: record.taken || null,
      ongoing: record.ended === undefined || record.ended === null,
      // Two sides. Anything beyond that is merge residue, not a combatant.
      sides: sideKeys.slice(0, 2).map(describeEntity),
    };
  }

  const age = sim.year - ev.t;
  const tierIndex = tierFor(age);
  return {
    type: 'analysis',
    event: ev,
    now: sim.year,
    subject,
    subjectRecord: record,
    subjectAlive: subject ? isAlive(subject) : false,
    war,
    contained,
    related,
    // What the record itself can still vouch for. Tapping into the archive
    // should show how much of it is left, not just what it says.
    provenance: {
      tier: tierIndex,
      tierLabel: TIERS[tierIndex].label,
      age,
      merged: ev.merged,
      dist: ev.dist,
      causeApocryphal: !!(ev.data && ev.data.causeApocryphal),
      inverted: !!(ev.data && ev.data.inverted),
      attributionDrifted: !!(ev.data && ev.data.attributionDrifted),
    },
  };
}

// Mirrors sim.js's WAR_CAUSES. Duplicated rather than exported because the
// worker speaks to the UI in finished phrases, and the sim shouldn't own
// wording.
const WAR_CAUSE_LABELS = {
  border: 'a disputed border',
  conquest: 'plain conquest',
  succession: 'a contested succession',
  revanche: 'ground lost in an earlier war',
  dynastic: 'a feud between ruling houses',
  culture: 'kin under foreign rule',
  alliance: 'a call to arms from an ally',
};

// Whether the thing still exists in the world, as opposed to only in the
// record. The two diverge in both directions: a state can outlive every event
// that mentioned it, and be remembered long after it falls.
function isAlive(key) {
  const [kind, raw] = key.split(':');
  const id = Number(raw);
  switch (kind) {
    case 'p': return sim.polities.has(id);
    case 's': return sim.settlements.has(id);
    case 'c': return sim.cultures.has(id);
    case 'd': return sim.houses.has(id);
    case 'n': return sim.people.has(id);
    case 'w': return sim.wars.has(id);
    default: return false;
  }
}

// Where something can be found on the map right now, for centering the view.
// Only entities that still exist have ground — a fallen state's old capital
// isn't its own any more, and there's no live cell to point the camera at.
function locationOf(key) {
  const [kind, raw] = key.split(':');
  const id = Number(raw);
  switch (kind) {
    case 'p': { const pol = sim.polities.get(id); return pol ? pol.capital : null; }
    case 's': { const s = sim.settlements.get(id); return s ? s.cell : null; }
    case 'd': {
      const house = sim.houses.get(id);
      if (!house || !house.thrones.size) return null;
      const pol = sim.polities.get(house.thrones.values().next().value);
      return pol ? pol.capital : null;
    }
    case 'n': {
      if (!sim.people.has(id)) return null;
      for (const pol of sim.polities.values()) if (pol.rulerId === id) return pol.capital;
      return null;
    }
    default: return null;
  }
}

// Reading the map at some past year. The keyframe we can actually produce may
// be older than the year asked for — that gap *is* the resolution the archive
// still has at that depth, and the UI shows it rather than pretending.
function seek(year) {
  const clamped = Math.max(0, Math.min(sim.year, Math.round(year)));
  const kf = sim.memory.keyframeAt(clamped);
  if (!kf) {
    self.postMessage({ type: 'seeked', year: clamped, resolvedYear: 0, owners: null, polities: [], events: [] });
    return;
  }

  const counts = new Map();
  for (let c = 0; c < kf.owners.length; c++) {
    const o = kf.owners[c];
    if (o < 0) continue;
    counts.set(o, (counts.get(o) || 0) + 1);
  }
  const polities = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([id, cells]) => {
      const rec = sim.memory.entity(entityKey('p', id));
      return {
        id, cells,
        // A polity the archive has forgotten still shows on the map — its
        // borders are in the keyframe — but nothing is left of who they were.
        name: rec ? rec.name : null,
        culture: rec ? rec.culture : null,
      };
    });

  const spacing = keyframeSpacing(sim.year - kf.t);
  const owners = kf.owners;
  self.postMessage({
    type: 'seeked',
    year: clamped,
    resolvedYear: kf.t,
    resolution: spacing,
    owners,
    polities,
    events: sim.memory.eventsInRange(kf.t - spacing, kf.t + spacing, 60),
  }, [owners.buffer]);
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case 'init':
        init(msg.seed);
        break;

      case 'run':
        if (msg.speed !== undefined) speed = msg.speed === 'max' ? Infinity : msg.speed;
        if (!running) {
          // Start the clock fresh, or the pause counts as elapsed time and the
          // world lurches forward on resume.
          running = true;
          lastSlice = 0;
          tickDebt = 0;
          rateTicks = 0;
          rateSince = now();
          loop();
        }
        break;

      case 'speed':
        speed = msg.speed === 'max' ? Infinity : msg.speed;
        // Debt banked at the old speed is meaningless at the new one.
        tickDebt = 0;
        break;

      case 'pause':
        running = false;
        if (timer) { clearTimeout(timer); timer = null; }
        break;

      case 'seek':
        seek(msg.year);
        break;

      // Toggle the unrest overlay. Posts one frame immediately so turning it
      // on shows something right away even if the sim is paused and no tick
      // is about to produce a fresh one on its own.
      case 'overlay':
        sendUnrest = !!msg.unrest;
        if (sendUnrest && sim) postFrame();
        break;

      case 'events':
        self.postMessage({
          type: 'events',
          events: sim.memory.eventsInRange(msg.from, msg.to, msg.limit || 60),
        });
        break;

      // Everything the archive still holds for the climate strip: epoch
      // transitions and global cataclysms/winters, across all of history —
      // not just eventsInRange's recency window, since a marker at year 200
      // needs to survive alongside one from last year. Scanning the whole
      // in-memory event list is fine; it's bounded by the tier budgets and
      // this is asked for occasionally, not once a frame. Naturally subject
      // to the same decay as everything else: a forgotten cataclysm simply
      // isn't in `sim.memory.events` any more to be found here.
      case 'markers': {
        const kinds = new Set(['epoch', 'winter', 'cataclysm']);
        const markers = [];
        for (const ev of sim.memory.events) {
          if (kinds.has(ev.type)) markers.push({ t: ev.t, type: ev.type, data: ev.data, dist: ev.dist });
        }
        self.postMessage({ type: 'markers', markers });
        break;
      }

      case 'cell': {
        const cell = msg.cell;
        const ownerId = sim.owner[cell];
        const rec = ownerId >= 0 ? sim.memory.entity(entityKey('p', ownerId)) : null;
        const settlementId = sim.cellSettlement[cell];
        const settlement = settlementId >= 0 ? sim.settlements.get(settlementId) : null;
        const pol = ownerId >= 0 ? sim.polities.get(ownerId) : null;
        const ruler = pol ? sim.people.get(pol.rulerId) : null;
        self.postMessage({
          type: 'cell',
          cell,
          biome: sim.world.biome[cell],
          pop: sim.pop[cell],
          unrest: sim.unrest[cell],
          owner: rec ? { id: ownerId, ...rec } : null,
          ruler: ruler ? { name: ruler.name, epithet: ruler.epithet, crowned: ruler.crowned } : null,
          settlement: settlement
            ? { id: settlement.id, name: settlement.name, founded: settlement.founded, tier: settlement.tier }
            : null,
          history: ownerId >= 0 ? sim.memory.eventsFor(entityKey('p', ownerId), 12) : [],
        });
        break;
      }

      // Tick to an exact year and stop. Used by the tests: the normal run loop
      // ticks in time-budgeted batches, so two runs asked to "stop after 3000"
      // stop at different years and can't be compared.
      case 'runTo': {
        running = false;
        if (timer) { clearTimeout(timer); timer = null; }
        const target = Math.max(0, Math.round(msg.year));
        while (sim.year < target) sim.tick();
        postFrame();
        self.postMessage({ type: 'ranTo', year: sim.year });
        break;
      }

      // A digest of the world and the record as they stand. Two runs of one
      // seed must agree exactly — that is what makes deleting deep history
      // recoverable rather than merely lossy.
      case 'digest': {
        const numbers = [sim.year, sim.epochIndex, sim.polities.size];
        for (let c = 0; c < sim.owner.length; c++) numbers.push(sim.owner[c]);
        for (const ev of sim.memory.events) {
          numbers.push(ev.t, ev.dist, ev.merged, hashString(ev.type));
        }
        self.postMessage({ type: 'digest', year: sim.year, digest: hashNumbers(numbers) });
        break;
      }

      // One entity's page: its record, everything the archive still has that
      // mentions it, and enough of the entities *those* events mention to link
      // onward. A key with no record has been swept — the events that would
      // have kept it are gone too.
      case 'entity': {
        const record = sim.memory.entity(msg.key);
        const events = sim.memory.eventsFor(msg.key, 150);
        const related = {};
        for (const ev of events) {
          for (const ref of ev.refs) {
            if (ref === msg.key || related[ref] !== undefined) continue;
            const r = sim.memory.entity(ref);
            related[ref] = r ? { name: r.name, kind: r.kind } : null;
          }
        }
        self.postMessage({
          type: 'entity', key: msg.key, record, events, related,
          alive: isAlive(msg.key), now: sim.year, cell: locationOf(msg.key),
          grudges: grudgesFor(msg.key),
          alliances: alliesFor(msg.key),
          tree: record && record.kind === 'c' ? cultureTree(msg.key, record) : null,
          lineage: houseLineage(msg.key),
        });
        break;
      }

      case 'analysis':
        self.postMessage(analysisFor(msg.eventId));
        break;

      case 'search':
        self.postMessage({
          type: 'search',
          query: msg.query,
          results: sim.memory.searchEntities(msg.query, 24).map((e) => {
            const key = entityKey(e.kind, e.id);
            return {
              key, name: e.name, kind: e.kind,
              born: e.born ?? e.founded ?? e.began, died: e.died ?? null,
              cell: locationOf(key),
            };
          }),
        });
        break;

      case 'selftest':
        self.postMessage({ type: 'selftest', problems: sim.selftest(), year: sim.year });
        break;

      // Test-only: every live house's learned state, for verifying house
      // learning is actually doing something. Mirrors the selftest/digest
      // pattern — a narrow, explicit seam rather than driving the UI.
      case 'debugHouses':
        self.postMessage({
          type: 'debugHouses',
          houses: [...sim.houses.values()].map((h) => ({
            id: h.id, name: h.name, great: h.great, thrones: h.thrones.size,
            tendencies: { ...h.tendencies }, momentum: h.momentum,
          })),
        });
        break;

      // Save/load and the continue slot capture the live world directly —
      // see the note on realChance() in sim.js for why replaying the seed
      // can no longer be trusted to reproduce it.
      case 'saveWorld':
        self.postMessage({ type: 'savedWorld', state: sim.saveState() });
        break;

      // Test-only: every live polity's and house's alliance weights, for
      // verifying formation/strengthening/decay over a long run. Mirrors
      // the selftest/digest/debugHouses pattern — a narrow, explicit seam.
      case 'debugAlliances':
        self.postMessage({
          type: 'debugAlliances',
          polities: [...sim.polities.values()].map((p) => ({ id: p.id, allies: [...p.allies.entries()] })),
          houses: [...sim.houses.values()].map((h) => ({ id: h.id, allies: [...h.allies.entries()] })),
        });
        break;

      // Test-only: every live polity's stability/exhaustion/activeWork and
      // ruler works count, for verifying notable works' mechanical effects
      // (not just that the event was logged). Mirrors the
      // selftest/debugHouses/debugAlliances pattern.
      case 'debugPolities':
        self.postMessage({
          type: 'debugPolities',
          polities: [...sim.polities.values()].map((p) => ({
            id: p.id, stability: p.stability, exhaustion: p.exhaustion,
            activeWork: p.activeWork ? { ...p.activeWork } : null,
            rulerWorks: (sim.people.get(p.rulerId) || {}).works ?? null,
          })),
        });
        break;

      case 'loadWorld':
        running = false;
        if (timer) { clearTimeout(timer); timer = null; }
        init(msg.state.seed, msg.state, msg.catchUpYears || 0);
        break;

      default:
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err && err.message ? err.message : String(err) });
  }
});
