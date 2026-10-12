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
import { GpuRiver } from './gpuriver.js';
import { gpuAvailable } from './gpu.js';

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
  let gpuWanted = false;    // the page asks for the water on the GPU
  let gpuCan = null;        // whether this browser can (asked once)
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
    const g = sim.flow.gpu;
    const steps = g ? Math.max(100, g.stepsPerSec) : (1000 / Math.max(0.05, stepMs)) * (BUDGET_MS / LOOP_MS);
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
    f.gpu = !!sim.flow.gpu;
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

  // Runs steps until the owed time is paid or the slice's budget is spent:
  // at most BUDGET_MS, and no later than the next frame is due (so frames
  // go out on time however long a step takes), but always one step.
  function runFor(years) {
    const start = performance.now();
    const morph = morphFor();
    let budget = BUDGET_MS;
    if (inFlight < MAX_IN_FLIGHT) budget = Math.min(budget, lastFrame + paceMs - start - stepMs * 0.5);
    let done = 0, n = 0;
    while (done < years && (n === 0 || performance.now() - start < budget)) {
      done += sim.step(morph);
      n++;
      // On the GPU: stop once far enough ahead of it.
      if (sim.flow.gpu && sim.flow.gpuStalled) break;
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
    const g = sim.flow.gpu;
    if (g) g.tick(now);
    if (!paused) {
      if (rate === Infinity) {
        runFor(Infinity);
        debt = 0;
      } else {
        debt = Math.min(debt + (rate * dt) / 1000, rate * 0.5);
        debt -= runFor(debt);
      }
    }
    // The river as the GPU last had it, when it comes back.
    if (g && g.poll(sim.flow, performance.now())) dirty = true;
    recent.push([now, sim.years]);
    while (recent.length > 2 && now - recent[0][0] > 1000) recent.shift();
    maybeSend(now);
    let wait = LOOP_MS;
    if (!paused && inFlight < MAX_IN_FLIGHT) wait = Math.max(2, Math.min(LOOP_MS, lastFrame + paceMs - performance.now()));
    // Waiting on the GPU: look again soon.
    if (!paused && g && sim.flow.gpuStalled) wait = Math.min(wait, 3);
    timer = setTimeout(loop, wait);
  }

  function start() {
    last = performance.now();
    if (!timer) timer = setTimeout(loop, 0);
  }

  // Puts the water on the GPU or back on the CPU, as the page asks and the
  // browser allows.
  function setGpu() {
    if (!sim) return;
    const f = sim.flow;
    if (gpuWanted && !f.gpu && gpuCan) {
      try { f.gpu = new GpuRiver(f); f.gpuDirty = false; } catch (e) { f.gpu = null; gpuCan = false; post({ type: 'gpu', available: false, reason: String(e && e.message || e) }); }
    } else if (!gpuWanted && f.gpu) {
      f.gpuSync();
      f.gpu.dispose();
      f.gpu = null;
      f.gpuStalled = false;
    }
  }

  function changed() {
    dirty = true;
    urgent = true;
  }

  // Something done to the ground: with the river on the GPU, it comes back
  // first, and goes back up (changed) before the next step.
  function shape(fn) {
    const f = sim.flow;
    if (f.gpu) f.gpuSync();
    fn();
    if (f.gpu) f.gpuDirty = true;
    changed();
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
        if (sim && sim.flow.gpu) sim.flow.gpu.dispose();
        sim = new Simulation(msg.seed);
        setGpu();
        debt = 0; recent.length = 0; inFlight = 0;
        changed();
        start();
        break;
      case 'restore':
        if (sim && sim.flow.gpu) sim.flow.gpu.dispose();
        sim = Simulation.fromState(msg.state);
        setGpu();
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
      case 'gpu':
        if (gpuCan === null) gpuCan = gpuAvailable();
        gpuWanted = !!msg.on;
        post({ type: 'gpu', available: gpuCan });
        setGpu();
        changed();
        break;
      case 'save': {
        sim.flow.gpuSync();
        const state = sim.saveState();
        post({ type: 'state', state, reason: msg.reason }, stateTransferList(state));
        break;
      }
      case 'sculpt': shape(() => sim.sculpt(msg.i, msg.size, msg.dir, msg.strength)); break;
      case 'hold':
        held = !!msg.on;
        // Afterwards the bed's speed-up builds back up from real time.
        if (!held && sim) { if (sim.flow.gpu) sim.flow.gpu.setMNow(sim.flow, 1); else sim.flow.mNow = 1; }
        changed();
        break;
      case 'dig': shape(() => sim.dig(msg.points || [])); break;
      case 'block': shape(() => sim.block(msg.i)); break;
      case 'place': shape(() => sim.place(msg.kind, msg.i, msg.points)); break;
      case 'storm': sim.storm(msg.i); changed(); break;
      case 'pump': sim.movePump(msg.x); changed(); break;
      case 'section': sim.setSection(msg.points); changed(); break;
      case 'setting': shape(() => sim.set(msg.key, msg.value)); break;
      case 'mode':
        sim.layer = ['depth', 'speed', 'drag', 'mud', 'bed', 'change', 'cutfill'].includes(msg.mode) ? msg.mode : null;
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
        const g = sim.flow.gpu;
        if (g) g.blocking = true;
        while (sim.years < msg.years) sim.step(morph);
        if (g) { g.blocking = false; sim.flow.gpuSync(); }
        recent.length = 0;
        sendFrame();
        post({ type: 'ranTo', years: sim.years });
        break;
      }
    }
  }
}
