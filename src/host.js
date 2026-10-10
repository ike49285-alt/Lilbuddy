// host.js — runs a Simulation against a clock and answers the page's
// messages. The worker wraps this; nothing here touches the DOM.
//
// The page asks for a rate in sim-years per real second. The water is
// worked out in steps of a fraction of a second whatever the rate; when
// that can't keep up, the bed's time is sped up (the morphological factor)
// by as much as the rate needs. When even that falls behind, the actual
// rate is less than asked, and the page says so.
//
// At most two frames are in flight: one being drawn and one waiting. More
// go out only as the page acknowledges them, and no sooner than the interval
// it asks for, which it sets from how long its frames take to draw. While
// paused, frames go out only when something has changed.

import { Simulation, transferList, stateTransferList, SEC_PER_YR } from './sim.js';

const HOST_DAY = 1 / 365.25;
const MIN_RATE = 1 / SEC_PER_YR;    // a second a second
const MAX_MORPH = 20000;
const BUDGET_MS = 12;               // longest a single slice may run before yielding
const LOOP_MS = 16;

export function createHost(post) {
  let sim = null;
  let rate = HOST_DAY / 24;      // target sim-years per second; Infinity = as fast as possible
  let paused = false;
  let debt = 0;             // sim-years owed
  let last = 0;
  let lastFrame = 0;
  let timer = null;
  let stepMs = 1;           // what a hydraulic step costs, smoothed
  let paceMs = 1000 / 30;
  let inFlight = 0;
  let held = false;         // a brush is down on the map
  const MAX_IN_FLIGHT = 2;
  let dirty = true;
  let urgent = false;
  const recent = [];        // [real ms, sim years]

  function actualRate() {
    if (recent.length < 2) return 0;
    const a = recent[0], b = recent[recent.length - 1];
    const ms = b[0] - a[0];
    return ms > 0 ? ((b[1] - a[1]) * 1000) / ms : 0;
  }

  // How much faster than the water the bed must run to keep up with the rate.
  function morphFor() {
    // While the page is shaping the ground, the bed runs in real time, so
    // what's built stays put until the finger lifts.
    if (held) return 1;
    if (rate === Infinity) return MAX_MORPH;
    const steps = (1000 / Math.max(0.05, stepMs)) * (BUDGET_MS / LOOP_MS);
    const water = steps * sim.flow.dt;                 // hydraulic seconds per real second
    return Math.max(1, Math.min(MAX_MORPH, (rate * SEC_PER_YR) / Math.max(1e-3, water)));
  }

  function tickYears() {
    return rate === Infinity ? Math.max(HOST_DAY / 10, actualRate() / 10) : rate / 10;
  }

  function sendFrame() {
    const f = sim.frame(tickYears());
    f.stepMs = stepMs;
    f.paused = paused;
    f.targetRate = rate;
    f.actualRate = paused ? 0 : actualRate();
    f.tickYears = tickYears();
    f.held = held;
    post({ type: 'frame', frame: f }, transferList(f));
    lastFrame = performance.now();
    inFlight++;
    dirty = false;
    urgent = false;
  }

  function maybeSend(now) {
    if (inFlight >= MAX_IN_FLIGHT) return;
    if (!urgent && now - lastFrame < paceMs - 1) return;
    if (!paused || dirty) sendFrame();
  }

  // Runs steps until the owed time is paid or the slice budget is spent.
  function runFor(years) {
    const start = performance.now();
    const morph = morphFor();
    let done = 0, n = 0;
    while (done < years && performance.now() - start < BUDGET_MS) {
      done += sim.step(morph);
      n++;
    }
    if (n) stepMs = stepMs * 0.8 + ((performance.now() - start) / n) * 0.2;
    return done;
  }

  function loop() {
    timer = null;
    if (!sim) return;
    const now = performance.now();
    const dt = Math.min(250, now - last);
    last = now;
    if (!paused) {
      if (rate === Infinity) {
        runFor(Infinity);
        debt = 0;
      } else {
        debt = Math.min(debt + (rate * dt) / 1000, rate * 0.5);
        debt -= runFor(debt);
      }
    }
    recent.push([now, sim.years]);
    while (recent.length > 2 && now - recent[0][0] > 1000) recent.shift();
    maybeSend(now);
    let wait = LOOP_MS;
    if (!paused && inFlight < MAX_IN_FLIGHT) wait = Math.max(2, Math.min(LOOP_MS, lastFrame + paceMs - performance.now()));
    timer = setTimeout(loop, wait);
  }

  function start() {
    last = performance.now();
    if (!timer) timer = setTimeout(loop, 0);
  }

  function changed() {
    dirty = true;
    urgent = true;
  }

  return function onMessage(msg) {
    handle(msg);
    if (sim && urgent) maybeSend(performance.now());
  };

  function handle(msg) {
    switch (msg.type) {
      case 'ack':
        inFlight = Math.max(0, inFlight - 1);
        if (msg.nextIn > 0) paceMs = Math.max(1000 / 30, Math.min(500, msg.nextIn));
        if (sim) maybeSend(performance.now());
        break;
      case 'init':
        sim = new Simulation(msg.seed);
        debt = 0; recent.length = 0; inFlight = 0;
        changed();
        start();
        break;
      case 'restore':
        sim = Simulation.fromState(msg.state);
        debt = 0; recent.length = 0; inFlight = 0;
        changed();
        start();
        break;
      case 'rate':
        rate = msg.rate === 'max' ? Infinity : Math.max(MIN_RATE, Number(msg.rate));
        debt = 0;
        recent.length = 0;
        changed();
        break;
      case 'save': {
        const state = sim.saveState();
        post({ type: 'state', state, reason: msg.reason }, stateTransferList(state));
        break;
      }
      case 'sculpt': sim.sculpt(msg.i, msg.size, msg.dir, msg.strength); changed(); break;
      case 'hold':
        held = !!msg.on;
        // Afterwards the bed's speed-up builds back up from real time.
        if (!held && sim) sim.flow.mNow = 1;
        changed();
        break;
      case 'dig': sim.dig(msg.points || []); changed(); break;
      case 'block': sim.block(msg.i); changed(); break;
      case 'storm': sim.storm(msg.i); changed(); break;
      case 'pump': sim.movePump(msg.x); changed(); break;
      case 'section': sim.setSection(msg.points); changed(); break;
      case 'setting': sim.set(msg.key, msg.value); changed(); break;
      case 'mode':
        sim.layer = ['depth', 'speed', 'drag', 'change', 'cutfill'].includes(msg.mode) ? msg.mode : null;
        changed();
        break;
      case 'inspect':
        post({ type: 'inspected', info: sim.inspect(msg.i) });
        break;
      case 'pause':
        paused = true;
        recent.length = 0;
        changed();
        break;
      case 'play':
        paused = false;
        debt = 0;
        recent.length = 0;
        last = performance.now();
        changed();
        break;
      // Test hook: advance synchronously to a year, the bed up to `morph` times the water.
      case 'runTo': {
        const morph = msg.morph || 1000;
        while (sim.years < msg.years) sim.step(morph);
        recent.length = 0;
        sendFrame();
        post({ type: 'ranTo', years: sim.years });
        break;
      }
    }
  }
}
