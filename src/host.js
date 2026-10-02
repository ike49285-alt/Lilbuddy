// host.js — runs a Simulation against a clock and answers the page's
// messages. The worker wraps this; nothing here touches the DOM.
//
// The page asks for a rate in sim-years per real second. Each tick's length
// adapts to it: about ten ticks a second, never shorter than a day and never
// longer than the model's maximum step. When ticks can't be computed fast
// enough the actual rate falls behind the target, and the page says so.

import { Simulation, transferList, MAX_STEP_YEARS } from './sim.js';

const DAY = 1 / 365.25;
const TICKS_PER_SECOND = 10;
const BUDGET_MS = 12;       // longest a single slice may run before yielding
const FRAME_MS = 66;        // ~15 frames a second to the page
const LOOP_MS = 16;

export function tickFor(rate) {
  if (!Number.isFinite(rate)) return MAX_STEP_YEARS;
  return Math.max(DAY, Math.min(MAX_STEP_YEARS, rate / TICKS_PER_SECOND));
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
  // Rolling measure of the actual rate: [real ms, sim years] samples.
  const recent = [];

  function actualRate() {
    if (recent.length < 2) return 0;
    const a = recent[0], b = recent[recent.length - 1];
    const ms = b[0] - a[0];
    return ms > 0 ? ((b[1] - a[1]) * 1000) / ms : 0;
  }

  function sendFrame() {
    const f = sim.frame();
    f.stepMs = stepMs;
    f.paused = paused;
    f.targetRate = rate;
    f.actualRate = paused ? 0 : actualRate();
    f.tickYears = tickYears;
    post({ type: 'frame', frame: f }, transferList(f));
    lastFrame = performance.now();
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
    if (now - lastFrame >= FRAME_MS) sendFrame();
    timer = setTimeout(loop, LOOP_MS);
  }

  function start() {
    last = performance.now();
    if (!timer) timer = setTimeout(loop, 0);
  }

  return function onMessage(msg) {
    switch (msg.type) {
      case 'init':
        sim = new Simulation(msg.seed);
        debt = 0;
        recent.length = 0;
        sendFrame();
        start();
        break;
      case 'rate':
        rate = msg.rate === 'max' ? Infinity : Math.max(DAY, Number(msg.rate));
        tickYears = tickFor(rate);
        debt = 0;
        recent.length = 0;
        sendFrame();
        break;
      case 'pause':
        paused = true;
        recent.length = 0;
        sendFrame();
        break;
      case 'play':
        paused = false;
        debt = 0;
        recent.length = 0;
        last = performance.now();
        sendFrame();
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
  };
}
