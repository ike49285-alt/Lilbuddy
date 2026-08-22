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
import { hashNumbers, cyrb128 } from './rng.js';

const hashString = (s) => cyrb128(s)[0] | 0;

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

const FRAME_MS = 50;       // cap UI updates at 20/sec; the sim is not slowed by this
const BUDGET_MS = 12;      // per-slice tick budget, leaves the worker responsive

function init(seed) {
  sim = new Simulation(seed);
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
  self.postMessage({ type: 'frame', snapshot }, [snapshot.owners.buffer]);
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
    case 'd': return sim.dynasties.has(id);
    case 'n': return sim.people.has(id);
    case 'w': return sim.wars.has(id);
    default: return false;
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

      case 'events':
        self.postMessage({
          type: 'events',
          events: sim.memory.eventsInRange(msg.from, msg.to, msg.limit || 60),
        });
        break;

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
          alive: isAlive(msg.key), now: sim.year,
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
          results: sim.memory.searchEntities(msg.query, 24).map((e) => ({
            key: entityKey(e.kind, e.id), name: e.name, kind: e.kind,
            born: e.born ?? e.founded ?? e.began, died: e.died ?? null,
          })),
        });
        break;

      case 'selftest':
        self.postMessage({ type: 'selftest', problems: sim.selftest(), year: sim.year });
        break;

      default:
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err && err.message ? err.message : String(err) });
  }
});
