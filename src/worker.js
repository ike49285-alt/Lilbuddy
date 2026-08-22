// worker.js — owns the simulation and keeps it ticking.
//
// The sim runs here so a fast-forward through fifty thousand years doesn't
// freeze the page. Tick rate is decoupled from frame rate: the loop ticks up to
// a time budget, then yields and posts one frame regardless of how many years
// went by. At full speed that is a few thousand years a second; at slow speeds
// it is a handful of ticks with the same cadence.

import { Simulation } from './sim.js';
import { biomePalette } from './world.js';
import { entityKey, TIERS, keyframeSpacing } from './memory.js';
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
