// host.js — runs a Simulation against a clock and answers the page's
// messages. The worker wraps this; nothing here touches the DOM.

import { Simulation, transferList } from './sim.js';

const BUDGET_MS = 12;       // longest a single slice may run before yielding
const FRAME_MS = 66;        // ~15 frames a second to the page
const TICK_MS = 16;

export function createHost(post) {
  let sim = null;
  let speed = 10;           // steps per second; Infinity = as fast as possible
  let paused = false;
  let debt = 0;
  let last = 0;
  let lastFrame = 0;
  let timer = null;
  let stepMs = 0;           // smoothed cost of one step, reported for the page

  function sendFrame() {
    const f = sim.frame();
    f.stepMs = stepMs;
    f.paused = paused;
    post({ type: 'frame', frame: f }, transferList(f));
    lastFrame = performance.now();
  }

  function runSteps(n) {
    const start = performance.now();
    let done = 0;
    while (done < n && performance.now() - start < BUDGET_MS) {
      const t0 = performance.now();
      sim.step();
      stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;
      done++;
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
      if (speed === Infinity) {
        runSteps(1e9);
        debt = 0;
      } else {
        debt = Math.min(debt + (speed * dt) / 1000, speed * 0.5 + 1);
        const want = Math.floor(debt);
        if (want > 0) debt -= runSteps(want);
      }
    }
    if (now - lastFrame >= FRAME_MS) sendFrame();
    timer = setTimeout(loop, TICK_MS);
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
        sendFrame();
        start();
        break;
      case 'speed':
        speed = msg.speed === 'max' ? Infinity : Number(msg.speed);
        paused = false;
        debt = 0;
        break;
      case 'pause':
        paused = true;
        sendFrame();
        break;
      // Test hook: advance synchronously to a step count, then report.
      case 'runTo':
        while (sim.steps < msg.steps) sim.step();
        sendFrame();
        post({ type: 'ranTo', steps: sim.steps });
        break;
    }
  };
}
