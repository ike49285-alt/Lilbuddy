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
  const target = speed === Infinity ? Infinity : Math.max(1, Math.round(speed * (FRAME_MS / 1000)));
  let ticks = 0;
  while (ticks < target && now() - started < BUDGET_MS) {
    sim.tick();
    ticks++;
  }
  const elapsed = now() - started;
  if (now() - lastPost >= FRAME_MS) {
    postFrame(ticks / Math.max(0.001, elapsed / 1000));
  }
  const wait = speed === Infinity ? 0 : Math.max(0, FRAME_MS - elapsed);
  timer = setTimeout(loop, wait);
}

function postFrame(rate) {
  lastPost = now();
  const snapshot = sim.snapshot();
  if (rate !== undefined) snapshot.rate = Math.round(rate);
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
        if (!running) { running = true; loop(); }
        break;

      case 'speed':
        speed = msg.speed === 'max' ? Infinity : msg.speed;
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
