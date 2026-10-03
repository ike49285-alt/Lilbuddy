// host.js — runs a Simulation against a clock and answers the page's
// messages. The worker wraps this; nothing here touches the DOM.
//
// The page asks for a rate in sim-years per real second. Each tick's length
// adapts to it: about ten ticks a second, never shorter than a minute and never
// longer than the model's maximum step. When ticks can't be computed fast
// enough the actual rate falls behind the target, and the page says so.
//
// At most two frames are in flight: one being drawn and one waiting, so the
// page always has the next ready when the screen refreshes. More go out only
// as the page acknowledges them, and no sooner than the interval it asks for,
// which it sets from how long its frames take to draw. A fast device gets up
// to 30 fps; a slow phone gets fewer rather than a backlog that starves its
// taps. While paused, frames go out only when something has changed.

import { Simulation, transferList, stateTransferList, MAX_STEP_YEARS } from './sim.js';

const DAY = 1 / 365.25;
const MINUTE = DAY / 1440;
const MIN_RATE = 10 * MINUTE;      // sim-years per second: ten minutes a second
const TICKS_PER_SECOND = 10;
const BUDGET_MS = 12;       // longest a single slice may run before yielding
const LOOP_MS = 16;

export function tickFor(rate) {
  if (!Number.isFinite(rate)) return MAX_STEP_YEARS;
  return Math.max(MINUTE, Math.min(MAX_STEP_YEARS, rate / TICKS_PER_SECOND));
}

export function createHost(post) {
  let sim = null;
  let rate = 1000;          // target sim-years per second; Infinity = as fast as possible
  let paused = false;
  let debt = 0;             // sim-years owed
  let last = 0;
  let lastFrame = 0;
  let timer = null;
  let stepMs = 0;
  let tickYears = tickFor(rate);
  let selectedId = null;
  let paceMs = 1000 / 30;   // the page's requested spacing between frames
  let inFlight = 0;         // frames the page hasn't acknowledged yet
  const MAX_IN_FLIGHT = 2;
  let dirty = true;         // something changed that the page should see
  let urgent = false;       // a control changed: show it without waiting for the pace
  // Rolling measure of the actual rate: [real ms, sim years] samples.
  const recent = [];

  function actualRate() {
    if (recent.length < 2) return 0;
    const a = recent[0], b = recent[recent.length - 1];
    const ms = b[0] - a[0];
    return ms > 0 ? ((b[1] - a[1]) * 1000) / ms : 0;
  }

  function sendFrame() {
    const f = sim.frame(selectedId);
    f.stepMs = stepMs;
    f.paused = paused;
    f.targetRate = rate;
    f.actualRate = paused ? 0 : actualRate();
    f.tickYears = tickYears;
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

  // Runs ticks until the owed time is paid or the slice budget is spent.
  function runFor(years) {
    const start = performance.now();
    let done = 0;
    while (done < years - 1e-9 && performance.now() - start < BUDGET_MS) {
      const t0 = performance.now();
      const d = Math.min(tickYears, years - done);
      sim.step(d);
      stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;
      done += d;
    }
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
        // Owed time accrues continuously but only whole ticks are run, so a
        // one-day tick at 1 day/s runs once a second, not as fractions.
        debt = Math.min(debt + (rate * dt) / 1000, rate * 0.5 + tickYears);
        if (debt >= tickYears - 1e-12) {
          const whole = Math.floor(debt / tickYears + 1e-9) * tickYears;
          debt -= runFor(whole);
        }
      }
    }
    recent.push([now, sim.years]);
    while (recent.length > 2 && now - recent[0][0] > 1000) recent.shift();
    maybeSend(now);
    // Wake again when the next frame is due if that's sooner than the usual
    // beat, so frames go out on pace rather than at the next loop after it.
    let wait = LOOP_MS;
    if (!paused && inFlight < MAX_IN_FLIGHT) {
      wait = Math.max(2, Math.min(LOOP_MS, lastFrame + paceMs - performance.now()));
    }
    timer = setTimeout(loop, wait);
  }

  function start() {
    last = performance.now();
    if (!timer) timer = setTimeout(loop, 0);
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
        selectedId = null;
        debt = 0;
        recent.length = 0;
        inFlight = 0;
        dirty = true;
        start();
        break;
      case 'rate':
        rate = msg.rate === 'max' ? Infinity : Math.max(MIN_RATE, Number(msg.rate));
        tickYears = tickFor(rate);
        debt = 0;
        recent.length = 0;
        dirty = true;
        urgent = true;
        break;
      case 'save': {
        const state = sim.saveState();
        post({ type: 'state', state, reason: msg.reason }, stateTransferList(state));
        break;
      }
      case 'restore':
        sim = Simulation.fromState(msg.state);
        selectedId = null;
        debt = 0;
        recent.length = 0;
        inFlight = 0;
        dirty = true;
        start();
        break;
      case 'select':
        selectedId = msg.id || null;
        dirty = true;
        urgent = true;
        break;
      case 'disaster':
        sim.disaster(msg.kind, msg.i, msg.size);
        dirty = true;
        urgent = true;
        break;
      case 'sculpt':
        sim.sculpt(msg.i, msg.size, msg.dz);
        dirty = true;
        urgent = true;
        break;
      case 'dig':
        sim.dig(msg.points || []);
        dirty = true;
        urgent = true;
        break;
      case 'setting':
        sim.set(msg.key, msg.value);
        dirty = true;
        urgent = true;
        break;
      // Older pages' names for two of the settings.
      case 'wetness':
        sim.set('wetness', msg.value);
        dirty = true;
        urgent = true;
        break;
      case 'activity':
        sim.set(msg.kind, msg.value);
        dirty = true;
        urgent = true;
        break;
      case 'mode':
        // Which colour layer the map shows, if any: only that one is sent.
        sim.layer = ['heat', 'rain', 'flow', 'erode'].includes(msg.mode) ? msg.mode : null;
        dirty = true;
        urgent = true;
        break;
      case 'seed':
        sim.seedSpecies(msg.i, msg.id, msg.kind);
        dirty = true;
        urgent = true;
        break;
      case 'storm':
        sim.storm(msg.i);
        dirty = true;
        urgent = true;
        break;
      case 'inspect':
        post({ type: 'inspected', info: sim.inspect(msg.i) });
        break;
      case 'pause':
        paused = true;
        recent.length = 0;
        dirty = true;
        urgent = true;
        break;
      case 'play':
        paused = false;
        debt = 0;
        recent.length = 0;
        last = performance.now();
        dirty = true;
        urgent = true;
        break;
      // Test hook: advance synchronously to a year using the given tick.
      case 'runTo': {
        const tick = msg.tick || 100;
        while (sim.years < msg.years - 1e-9) sim.step(Math.min(tick, msg.years - sim.years));
        recent.length = 0;
        sendFrame();
        post({ type: 'ranTo', years: sim.years });
        break;
      }
    }
  }
}
