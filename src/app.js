// app.js — the page: starts the worker, draws what it sends, wires the controls.

import { MapRenderer, drawSpark, drawProfile, LAYERS } from './render.js';
import { saveWorld, loadWorld } from './save.js';
import { View3D, webglAvailable } from './view3d.js';

const SEED_WORDS = ['alder', 'bar', 'cutbank', 'delta', 'eddy', 'ford', 'gravel', 'heron', 'island',
  'kingfisher', 'levee', 'meander', 'neck', 'oxbow', 'pool', 'riffle', 'sandbar', 'thalweg', 'willow'];

const $ = (id) => document.getElementById(id);
const renderer = new MapRenderer($('map-canvas'));
let worker = null;
let last = null;
let pendingRunTo = null;

// --- time rate -------------------------------------------------------------

const SECOND = 1 / 3.156e7;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Rates in sim-years per real second.
const PRESETS = [
  { rate: SECOND, label: 'Real time' },
  { rate: 10 * SECOND, label: '10 s/s' },
  { rate: MINUTE, label: '1 min/s' },
  { rate: 10 * MINUTE, label: '10 min/s' },
  { rate: HOUR, label: '1 hr/s' },
  { rate: 6 * HOUR, label: '6 hr/s' },
  { rate: DAY, label: '1 day/s' },
  { rate: 7 * DAY, label: '1 week/s' },
  { rate: 1 / 12, label: '1 month/s' },
  { rate: 1, label: '1 yr/s' },
];
const MAX_RATE = 'max';
const LOG_MIN = Math.log10(SECOND);
const LOG_MAX = 0;
const SLIDER_MAX = 1000;
const SNAP = 14;
let rate = DAY;
let paused = false;

function randomSeed() {
  const w = () => SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
  return `${w()}-${w()}-${Math.floor(Math.random() * 90 + 10)}`;
}

function cleanSeed(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function newWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onMessage;
}

function start(seed) {
  newWorker();
  worker.postMessage({ type: 'init', seed });
  afterStart(seed);
}

function resume(state, savedAt) {
  newWorker();
  worker.postMessage({ type: 'restore', state });
  afterStart(state.seed);
  lastSaved = savedAt;
  saveNote('Picked up where you left off');
}

function afterStart(seed) {
  inspectAt = -1;
  clearInterval(inspectTimer);
  $('inspect').hidden = true;
  renderer.resetView();
  renderer.effects = [];
  pendingNotes = [];
  hideNote();
  viewChanged();
  $('seed').value = seed;
  try { history.replaceState(null, '', `#${seed}`); } catch { /* some hosts forbid it */ }
  paused = false;
  setPausedUI();
  sendRate();
  worker.postMessage({ type: 'mode', mode: renderer.mode });
}

function onMessage(e) {
  const msg = e.data;
  if (msg.type === 'frame') {
    if (drawPending && worker) worker.postMessage({ type: 'ack', nextIn: paceMs });
    if (drawPending && last && last.events && last.events.length) msg.frame.events = last.events.concat(msg.frame.events || []);
    last = msg.frame;
    if (!drawPending) {
      drawPending = true;
      requestAnimationFrame(drawLatest);
    }
  } else if (msg.type === 'state') {
    saveWorld(msg.state).then(() => {
      lastSaved = Date.now();
      showSaved();
      if (pendingSave) { pendingSave(); pendingSave = null; }
    }).catch(() => {
      saveOff = true;
      saveNote('Saving is off: this browser isn’t letting the page store the world.');
      if (pendingSave) { pendingSave(); pendingSave = null; }
    });
  } else if (msg.type === 'inspected') {
    renderInspect(msg.info);
  } else if (msg.type === 'ranTo' && pendingRunTo) {
    pendingRunTo(msg.years);
    pendingRunTo = null;
  }
}

const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const n1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const n2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

// The clock: the year, the day and, at slow rates, the time of day.
function formatTime(years, tickYears) {
  const year = Math.floor(years + 1e-12);
  const days = (years - year) * 365.25;
  const day = Math.min(365, Math.floor(days) + 1);
  const yr = year ? `year ${year + 1}, ` : '';
  if (tickYears < DAY) {
    const mins = Math.floor((days - Math.floor(days)) * 1440);
    const hh = String(Math.floor(mins / 60)).padStart(2, '0'), mm = String(mins % 60).padStart(2, '0');
    return `${yr}day ${day}\n${hh}:${mm}`;
  }
  return `${yr}day ${day}`;
}

function formatSpan(years) {
  const trim = (v) => (v >= 10 || Math.abs(v - Math.round(v)) < 0.05 ? n0.format(v) : n1.format(v));
  if (years < 0.95 * MINUTE) return `${trim(years / SECOND)} s`;
  if (years < 0.95 * HOUR) return `${trim(years / MINUTE)} min`;
  if (years < 0.95 * DAY) return `${trim(years / HOUR)} hr`;
  if (years < 6.5 * DAY) return `${trim(years / DAY)} day`;
  if (years < 0.07) return `${trim(years * 52.18)} wk`;
  if (years < 0.95) return `${trim(years * 12)} mo`;
  return `${trim(years)} yr`;
}

const rateLabel = (r) => (Math.abs(r / SECOND - 1) < 0.02 ? 'real time' : `${formatSpan(r)}/s`);

function sliderToRate(v) {
  return Math.pow(10, LOG_MIN + (v / SLIDER_MAX) * (LOG_MAX - LOG_MIN));
}
function rateToSlider(r) {
  return Math.round(((Math.log10(r) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * SLIDER_MAX);
}

function buildRateSelect() {
  const sel = $('rate-select');
  sel.innerHTML = '';
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.hidden = true;
  sel.append(custom);
  PRESETS.forEach((p, k) => {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = p.label;
    sel.append(o);
  });
  const max = document.createElement('option');
  max.value = MAX_RATE;
  max.textContent = 'As fast as possible';
  sel.append(max);
}

function presetIndex(r) {
  return PRESETS.findIndex((p) => Math.abs(Math.log10(p.rate) - Math.log10(r)) < 1e-6);
}

function syncRateUI() {
  const sel = $('rate-select');
  const slider = $('rate-slider');
  if (rate === MAX_RATE) {
    sel.value = MAX_RATE;
    slider.value = String(SLIDER_MAX);
    slider.setAttribute('aria-valuetext', 'as fast as possible');
    return;
  }
  slider.value = String(rateToSlider(rate));
  slider.setAttribute('aria-valuetext', rateLabel(rate));
  const k = presetIndex(rate);
  if (k >= 0) {
    sel.value = String(k);
  } else {
    const custom = sel.querySelector('option[value="custom"]');
    custom.textContent = `≈ ${rateLabel(rate)}`;
    sel.value = 'custom';
  }
}

function sendRate() {
  if (worker) worker.postMessage({ type: 'rate', rate });
  syncRateUI();
}

function setRate(r) {
  rate = r;
  sendRate();
}

function stepPreset(dir) {
  if (rate === MAX_RATE) {
    if (dir < 0) setRate(PRESETS[PRESETS.length - 1].rate);
    return;
  }
  const lr = Math.log10(rate);
  if (dir > 0) {
    const next = PRESETS.find((p) => Math.log10(p.rate) > lr + 1e-6);
    setRate(next ? next.rate : MAX_RATE);
  } else {
    const prev = [...PRESETS].reverse().find((p) => Math.log10(p.rate) < lr - 1e-6);
    if (prev) setRate(prev.rate);
  }
}

function setPausedUI() {
  const b = $('play');
  b.setAttribute('aria-pressed', paused ? 'true' : 'false');
  b.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  b.title = paused ? 'Play (Space)' : 'Pause (Space)';
}

function togglePlay() {
  paused = !paused;
  worker.postMessage({ type: paused ? 'pause' : 'play' });
  setPausedUI();
}

// Frames arrive one at a time; only the latest is drawn, once per display
// frame, and the worker hears back so it can send the next, paced so that
// drawing takes about a quarter of the main thread.
let drawPending = false;
let lastSlow = 0;
const SLOW_MS = 500;
const SHARE = 0.25;
const MIN_PACE = 1000 / 30;
const MAX_PACE = 500;
let frameCost = 8;
let paceMs = MIN_PACE;
let vsync = 1000 / 60;
const drawnAt = [];

function drawLatest(ts) {
  drawPending = false;
  if (!last) return;
  const t0 = performance.now();
  draw(last);
  const js = performance.now() - t0;
  if (worker) worker.postMessage({ type: 'ack', nextIn: paceMs });
  drawnAt.push(t0);
  while (drawnAt.length && t0 - drawnAt[0] > 2000) drawnAt.shift();
  requestAnimationFrame((ts2) => {
    const gap = ts2 - ts;
    if (gap > 4 && gap < vsync) vsync = gap;
    const cost = Math.max(js, gap - vsync);
    frameCost = frameCost * 0.7 + cost * 0.3;
    paceMs = Math.max(MIN_PACE, Math.min(MAX_PACE, frameCost / SHARE));
  });
}

// Colour tokens, read once and again when the colour scheme changes.
let tokens = null;
function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
  tokens = {
    water: css.getPropertyValue('--water').trim(),
    soft: css.getPropertyValue('--water-soft').trim(),
    grid: css.getPropertyValue('--line').trim(),
    muted: css.getPropertyValue('--muted').trim(),
    bed: dark ? '#c7a77c' : '#8a6a44',
    bedFill: dark ? 'rgba(199, 167, 124, 0.35)' : 'rgba(138, 106, 68, 0.3)',
    waterFill: dark ? 'rgba(90, 163, 208, 0.55)' : 'rgba(90, 163, 208, 0.5)',
  };
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { tokens = null; lastSlow = 0; });

function draw(f, force) {
  if (renderer.marked) renderer.marked.frame = f;
  if (view3d && in3d) {
    renderer.paint(f);
    view3d.render(f);
  } else {
    renderer.draw(f);
  }
  composedKey = viewKey();
  if (f.events && f.events.length) {
    for (const ev of f.events) onEvent(ev);
    f.events = [];
  }
  const clock = formatTime(f.years, f.tickYears);
  $('time').textContent = clock;
  $('time').classList.toggle('two', clock.includes('\n'));
  const m = f.stats.morph;
  $('tick').textContent = f.held ? 'bed held while you shape' : m > 1.5 ? `bed ×${n0.format(m)}` : 'bed in real time';
  const lag = $('lag');
  if (f.paused) {
    lag.textContent = 'paused';
    lag.className = 'lag neutral';
  } else if (f.targetRate === Infinity || f.targetRate === null) {
    lag.textContent = f.actualRate > 0 ? `running ${rateLabel(f.actualRate)}` : '';
    lag.className = 'lag neutral';
  } else if (f.actualRate > 0 && f.actualRate < f.targetRate * 0.85) {
    lag.textContent = `running ${rateLabel(f.actualRate)}`;
    lag.className = 'lag';
  } else {
    lag.textContent = '';
    lag.className = 'lag';
  }
  $('phase').textContent = f.climate.rain > 2.5 ? `${f.climate.label} · rain` : f.climate.label;

  const now = performance.now();
  if (!force && now - lastSlow < SLOW_MS) return;
  lastSlow = now;
  drawSlow(f);
}

function fmtVolume(v) {
  return `${n0.format(v)} m³`;
}

function drawSlow(f) {
  const st = f.stats;
  for (const [id, [key, scale, label]] of Object.entries(SLIDERS)) {
    const value = f.climate.settings && f.climate.settings[key];
    if (document.activeElement === $(id) || value == null) continue;
    const v = Math.round(value * scale * 100) / 100;
    if (Number($(id).value) !== v) { $(id).value = v; $(`${id}-out`).textContent = label(v); }
  }
  $('s-q').textContent = `${n1.format(st.inflow)} m³/s`;
  $('s-width').textContent = `${n0.format(st.width)} m`;
  $('s-sin').textContent = n2.format(st.sinuosity);
  $('s-deep').textContent = `${n1.format(st.deepest)} m`;
  $('s-sand').textContent = `${n0.format(st.sand)} m³/day`;
  $('s-sea').textContent = st.toSea >= 0.5 ? `${n0.format(st.toSea)} m³/day` : 'none yet';
  $('s-delta').textContent = fmtVolume(st.delta);
  $('s-plants').textContent = `${n0.format(st.plants * 100)}%`;

  if (!tokens) readTokens();
  const { water, soft, grid } = tokens;
  drawSpark($('sp-q'), f.history.inflow, { color: water, fill: soft, grid });
  drawSpark($('sp-s'), f.history.sinuosity, { color: water, fill: soft, grid, zeroLine: 1 });
  $('sp-q-v').textContent = `${n1.format(st.inflow)} m³/s`;
  $('sp-s-v').textContent = n2.format(st.sinuosity);
  $('sp-from').textContent = `−${formatSpan(f.history.inflow.length * f.history.every)}`;
  if (!$('pane-profile').hidden) drawCharts(f);
  updateScale();
}

function drawCharts(f) {
  if (!tokens) readTokens();
  const colors = { bed: tokens.bed, bedFill: tokens.bedFill, water: tokens.waterFill, start: tokens.muted, grid: tokens.grid, text: tokens.muted };
  const p = f.profile;
  drawProfile($('profile'), p, colors, ['inlet', `sea, ${n0.format(p.bed.length * p.cell)} m`]);
  const s = f.section;
  $('section').hidden = !s;
  $('section-hint').hidden = !!s;
  $('section-len').textContent = s ? `${n0.format(s.length)} m, A to B` : '';
  if (s) drawProfile($('section'), s, colors, ['A', 'B']);
}

buildRateSelect();
$('play').addEventListener('click', togglePlay);
$('slower').addEventListener('click', () => stepPreset(-1));
$('faster').addEventListener('click', () => stepPreset(1));
$('rate-select').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === MAX_RATE) setRate(MAX_RATE);
  else if (v !== 'custom') setRate(PRESETS[Number(v)].rate);
});
$('rate-slider').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  const near = PRESETS.find((p) => Math.abs(rateToSlider(p.rate) - v) <= SNAP);
  setRate(near ? near.rate : sliderToRate(v));
});
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); togglePlay(); }
  else if (e.key === '-' || e.key === '_') stepPreset(-1);
  else if (e.key === '=' || e.key === '+') stepPreset(1);
});

new ResizeObserver(() => {
  document.documentElement.style.setProperty('--bar-h', `${$('timebar').offsetHeight}px`);
}).observe($('timebar'));

$('seed-form').addEventListener('submit', (e) => {
  e.preventDefault();
  start(cleanSeed($('seed').value) || randomSeed());
});
$('seed-random').addEventListener('click', () => start(randomSeed()));

// --- saving ------------------------------------------------------------------

let saveOff = false;
let lastSaved = 0;
let pendingSave = null;

function saveNote(text) {
  $('save-status').textContent = text;
}
function showSaved() {
  if (saveOff || !lastSaved) return;
  const s = Math.round((Date.now() - lastSaved) / 1000);
  saveNote(s < 5 ? 'Saved just now' : s < 90 ? `Saved ${s} s ago` : `Saved ${Math.round(s / 60)} min ago`);
}
function requestSave(reason) {
  if (saveOff || !worker || !last) return;
  worker.postMessage({ type: 'save', reason });
}
setInterval(() => requestSave('auto'), 30000);
setInterval(showSaved, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') requestSave('hide'); });
window.addEventListener('pagehide', () => requestSave('hide'));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// --- tabs and map modes ---------------------------------------------------------

let inspectAt = -1;
let inspectTimer = null;

function showTab(name) {
  for (const t of ['river', 'profile']) {
    $(`tab-${t}`).setAttribute('aria-selected', t === name ? 'true' : 'false');
    $(`pane-${t}`).hidden = t !== name;
  }
  if (last) drawSlow(last);
}
for (const t of ['river', 'profile']) $(`tab-${t}`).addEventListener('click', () => showTab(t));

const LAYER_NAMES = { depth: 'Water depth', speed: 'Current', drag: 'Drag on the bed (times what moves sand)', change: 'Cutting and filling now', cutfill: 'Cut and fill since the start' };
const ramp = (L) => `linear-gradient(to right, ${L.stops.map((s) => `rgb(${s[1]}, ${s[2]}, ${s[3]}) ${s[0] * 100}%`).join(', ')})`;
// The land and each layer have a button down the left of the map, each
// with a strip of its colours.
const modeButtons = [...document.querySelectorAll('.map-mode button')];
for (const b of modeButtons) {
  const L = LAYERS[b.dataset.mode];
  b.querySelector('.sw').style.background = L ? ramp(L) : 'linear-gradient(to right, #6f8f4e, #c9b58c 50%, #2a5e84)';
  b.addEventListener('click', () => setMode(b.dataset.mode));
}
function setMode(mode) {
  renderer.mode = mode;
  const layer = LAYERS[mode] ? mode : null;
  for (const b of modeButtons) b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
  $('layer-key').hidden = !layer;
  if (layer) {
    const L = LAYERS[layer];
    $('layer-name').textContent = LAYER_NAMES[layer];
    $('layer-ramp').style.background = ramp(L);
    $('layer-ticks').replaceChildren(...L.ticks.map((t) => el('span', '', t)));
  }
  if (worker) worker.postMessage({ type: 'mode', mode });
  if (last) draw(last, true);
}

// --- zoom and pan -------------------------------------------------------------

const canvas = $('map-canvas');
const TAP_PX = 6;
const DOUBLE_TAP_MS = 300;
const ZOOM_STEP = 2;
let viewDrawPending = false;
let settleTimer = null;
let composedKey = '';

function viewChanged() {
  if (in3d) {
    const c = view3d.cam;
    $('zoom-out').disabled = false;
    $('zoom-reset').disabled = false;
    $('zoom-in').disabled = false;
    $('north-arrow').style.transform = `rotate(${c ? c.yaw : 0}rad)`;
    startEffects();
  } else {
    canvas.classList.toggle('zoomed', renderer.zoom > 1.001);
    $('zoom-out').disabled = renderer.zoom <= 1.001;
    $('zoom-reset').disabled = renderer.zoom <= 1.001;
    $('zoom-in').disabled = renderer.zoom >= 7.999;
    $('north-arrow').style.transform = '';
    updateScale();
  }
  if (!viewDrawPending) {
    viewDrawPending = true;
    requestAnimationFrame(() => {
      viewDrawPending = false;
      if (last && viewKey() !== composedKey) composeView();
    });
  }
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { if (last) composeView(); }, 140);
}

function composeView() {
  if (in3d) view3d.render(last);
  else renderer.compose(last);
  composedKey = viewKey();
}

function viewKey() {
  if (!in3d) return renderer.viewKey();
  const c = view3d.cam;
  return c ? `3d,${c.tx},${c.ty},${c.yaw},${c.pitch},${c.dist},${glCanvas.clientWidth},${glCanvas.clientHeight}` : '3d';
}

// --- the 3D view ----------------------------------------------------------------

const glCanvas = $('gl-canvas');
let view3d = null;
let in3d = false;
if (webglAvailable()) $('view-3d').hidden = false;

function set3d(on) {
  if (on && !view3d) {
    try {
      view3d = new View3D(glCanvas, renderer);
    } catch (err) {
      console.warn('3D view unavailable', err);
      $('view-3d').hidden = true;
      return;
    }
  }
  in3d = on;
  renderer.flat = on;
  renderer.projector = on ? (wx, wy, w, h) => view3d.project(wx, wy, w, h) : null;
  glCanvas.hidden = !on;
  canvas.hidden = on;
  $('map-frame').classList.toggle('in3d', on);
  $('view-3d').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('view-3d').textContent = on ? '2D' : '3D';
  $('view-3d').setAttribute('aria-label', on ? 'Show the flat map' : 'Show the valley in 3D');
  if (last) draw(last, true);
  viewChanged();
}
$('view-3d').addEventListener('click', () => set3d(!in3d));

// A round distance whose bar fits the corner left of the map-mode switch.
function updateScale() {
  const width = $('map').clientWidth;
  if (!width || !last) return;
  const mPerPx = ((renderer.W / renderer.zoom) * last.cell) / width;
  const room = Math.min(90, $('map').clientHeight * 0.25);
  const steps = [5, 10, 20, 50, 100, 200, 500];
  let m = steps[0];
  for (const s of steps) if (s / mPerPx <= room) m = s;
  $('scale-bar').style.height = `${m / mPerPx}px`;
  $('scale-label').textContent = `${m} m`;
}

function fractions(clientX, clientY) {
  const r = (in3d ? glCanvas : canvas).getBoundingClientRect();
  return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
}

function worldAt(clientX, clientY) {
  if (in3d) {
    const r = glCanvas.getBoundingClientRect();
    return view3d.pick(clientX - r.left, clientY - r.top);
  }
  return renderer.toWorld(...fractions(clientX, clientY));
}

const pointers = new Map();
let press = null;
let pinch = null;
let lastTap = null;

function pinchState() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

function onDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not every pointer can be captured */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    press = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
    pinch = null;
    if (armed && SHAPERS.has(armed)) startShaping(e);
  } else if (pointers.size === 2) {
    endShaping(true);
    const p = pinchState();
    const [fx, fy] = fractions(p.mx, p.my);
    pinch = { dist: Math.max(1, p.dist), zoom: renderer.zoom, world: renderer.toWorld(fx, fy), mx: p.mx, my: p.my, camDist: view3d && view3d.cam ? view3d.cam.dist : 0 };
    press = null;
  }
}
canvas.addEventListener('pointerdown', onDown);
glCanvas.addEventListener('pointerdown', onDown);

function onMove(e) {
  const pt = pointers.get(e.pointerId);
  if (!pt) return;
  pt.x = e.clientX;
  pt.y = e.clientY;
  if (shaping && pointers.size === 1) {
    moveShaping(e);
    if (press) press.moved = true;
    return;
  }
  if (in3d) {
    if (pinch && pointers.size >= 2) {
      const p = pinchState();
      view3d.cam.dist = pinch.camDist;
      view3d.zoomBy(p.dist / pinch.dist);
      view3d.slide(p.mx - pinch.mx, p.my - pinch.my);
      pinch.mx = p.mx;
      pinch.my = p.my;
      viewChanged();
      return;
    }
    if (!press) return;
    if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < TAP_PX) return;
    press.moved = true;
    view3d.turn(e.clientX - press.lx, e.clientY - press.ly);
    glCanvas.classList.add('dragging');
    press.lx = e.clientX;
    press.ly = e.clientY;
    viewChanged();
    return;
  }
  if (pinch && pointers.size >= 2) {
    const p = pinchState();
    const [fx, fy] = fractions(p.mx, p.my);
    const z = Math.max(1, Math.min(8, pinch.zoom * (p.dist / pinch.dist)));
    renderer.setView(z, pinch.world[0] - fx * (renderer.W / z), pinch.world[1] - fy * (renderer.H / z));
    viewChanged();
    return;
  }
  if (!press) return;
  if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < TAP_PX) return;
  press.moved = true;
  if (renderer.zoom > 1.001) {
    const r = canvas.getBoundingClientRect();
    renderer.panBy((e.clientX - press.lx) / r.width, (e.clientY - press.ly) / r.height);
    canvas.classList.add('dragging');
    viewChanged();
  }
  press.lx = e.clientX;
  press.ly = e.clientY;
}
canvas.addEventListener('pointermove', onMove);
glCanvas.addEventListener('pointermove', onMove);

function release(e, cancelled) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  canvas.classList.remove('dragging');
  glCanvas.classList.remove('dragging');
  if (shaping) {
    endShaping(cancelled);
    press = null;
    return;
  }
  if (pinch) {
    if (pointers.size === 0) pinch = null;
    return;
  }
  if (press && !press.moved && !cancelled) tap(e.clientX, e.clientY);
  press = null;
}
for (const c of [canvas, glCanvas]) {
  c.addEventListener('pointerup', (e) => release(e, false));
  c.addEventListener('pointercancel', (e) => release(e, true));
}

function tap(clientX, clientY) {
  const now = performance.now();
  const [fx, fy] = fractions(clientX, clientY);
  const world = worldAt(clientX, clientY);
  if (armed) {
    if (world) dropAt(...world);
    return;
  }
  if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(clientX - lastTap.x, clientY - lastTap.y) < 30) {
    lastTap = null;
    if (in3d) {
      if (world) { view3d.lookAt(...world); view3d.zoomBy(ZOOM_STEP); }
    } else {
      renderer.zoomAt(ZOOM_STEP, fx, fy);
    }
    viewChanged();
    return;
  }
  lastTap = { t: now, x: clientX, y: clientY };
  if (world) inspectCell(...world);
}

canvas.addEventListener('wheel', (e) => {
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
  if (!dy) return;
  if ((dy > 0 && renderer.zoom <= 1.001) || (dy < 0 && renderer.zoom >= 7.999)) return;
  e.preventDefault();
  const [fx, fy] = fractions(e.clientX, e.clientY);
  renderer.zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), fx, fy);
  viewChanged();
}, { passive: false });
glCanvas.addEventListener('wheel', (e) => {
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
  if (!dy) return;
  e.preventDefault();
  view3d.zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
  viewChanged();
}, { passive: false });

$('zoom-in').addEventListener('click', () => { if (in3d) view3d.zoomBy(ZOOM_STEP); else renderer.zoomAt(ZOOM_STEP, 0.5, 0.5); viewChanged(); });
$('zoom-out').addEventListener('click', () => { if (in3d) view3d.zoomBy(1 / ZOOM_STEP); else renderer.zoomAt(1 / ZOOM_STEP, 0.5, 0.5); viewChanged(); });
$('zoom-reset').addEventListener('click', () => { if (in3d) view3d.resetCamera(); else renderer.resetView(); viewChanged(); });

// --- notes ---------------------------------------------------------------------

let armed = null;
let pendingNotes = [];
let noteEv = null;
let noteAt = 0;
let noteTimer = null;
let fxRunning = false;
const NOTE_MS = 6000;
const NOTE_GAP_MS = 1000;
const eventLog = [];

renderer.setEffectsCanvas($('fx-canvas'));

function onEvent(ev) {
  eventLog.push({ ...ev });
  if (eventLog.length > 50) eventLog.shift();
  renderer.addEffect(ev);
  startEffects();
  pendingNotes.push(ev);
  pumpNotes();
}

function startEffects() {
  if (fxRunning) return;
  fxRunning = true;
  const tick = () => {
    if (renderer.drawEffects()) requestAnimationFrame(tick);
    else fxRunning = false;
  };
  requestAnimationFrame(tick);
}

function pumpNotes() {
  const now = performance.now();
  clearTimeout(noteTimer);
  const own = pendingNotes.some((e) => e.byHand);
  if (pendingNotes.length && (own || now - noteAt >= NOTE_GAP_MS)) {
    let pick = pendingNotes[pendingNotes.length - 1];
    for (const e of pendingNotes) if (e.byHand && !pick.byHand) pick = e;
    showNote(pick, pendingNotes.length - 1);
    pendingNotes = [];
    noteAt = now;
  }
  if (pendingNotes.length) noteTimer = setTimeout(pumpNotes, NOTE_GAP_MS - (now - noteAt));
  else if (noteEv) noteTimer = setTimeout(() => { if (performance.now() - noteAt >= NOTE_MS - 20) hideNote(); else pumpNotes(); }, NOTE_MS - (now - noteAt));
}

function showNote(ev, more) {
  const b = $('event-note');
  noteEv = ev;
  b.textContent = ev.label;
  if (more > 0) b.append(el('span', 'more', `+${more} more`));
  b.setAttribute('aria-label', `${ev.label}. Show on the map.`);
  b.hidden = false;
}

function hideNote() {
  noteEv = null;
  $('event-note').hidden = true;
}

$('event-note').addEventListener('click', () => {
  const ev = noteEv;
  if (!ev) return;
  if (in3d) {
    view3d.lookAt(ev.x, ev.y);
    view3d.cam.dist = Math.min(view3d.cam.dist, 120);
  } else {
    renderer.lookAt(ev.x, ev.y, Math.max(renderer.zoom, 3));
  }
  viewChanged();
  renderer.addEffect(ev);
  startEffects();
  hideNote();
});

// --- tools ---------------------------------------------------------------------

function cellAt(wx, wy) {
  if (!last) return -1;
  const x = Math.floor(wx), y = Math.floor(wy);
  if (x < 0 || y < 0 || x >= last.W || y >= last.H) return -1;
  return y * last.W + x;
}

function dropAt(wx, wy) {
  if (!last || !armed) return;
  const i = cellAt(wx, wy);
  if (i < 0) return;
  if (armed === 'storm') {
    // Slow enough to watch the flood come down.
    if (rate === MAX_RATE || rate > 6 * HOUR) setRate(6 * HOUR);
    worker.postMessage({ type: 'storm', i });
  }
  else if (armed === 'block') worker.postMessage({ type: 'block', i });
}

const SHAPERS = new Set(['raise', 'lower', 'dig', 'section']);
const BRUSH_MS = 100;
let brushSize = 'big';
let brushStrength = 'strong';
const BRUSH_CELLS = { small: 2, big: 5, huge: 10 };
let shaping = null;

function setArmed(kind) {
  armed = kind;
  for (const b of document.querySelectorAll('.tools .tool')) b.setAttribute('aria-pressed', b.dataset.kind === kind ? 'true' : 'false');
  $('brush-row').hidden = !(kind === 'raise' || kind === 'lower');
  $('strength-row').hidden = !(kind === 'raise' || kind === 'lower');
  const names = {
    raise: 'Hold a finger on the map to pile sand there.', lower: 'Hold a finger on the map to scoop sand away.',
    dig: 'Draw a line on the map to dig a channel.', block: 'Tap the map to drop a block of rock there.',
    storm: 'Tap the map to park a storm over the valley.', section: 'Draw a line across the river to see its cross-section.',
  };
  $('tools-hint').textContent = kind ? names[kind] : 'Pick a tool, then use it on the map.';
  const label = { raise: 'Brush: Raise', lower: 'Brush: Lower', dig: 'Draw: Dig', block: 'Tap map: Block', storm: 'Tap map: Storm', section: 'Draw: Section' };
  $('tools-toggle').textContent = kind ? label[kind] : 'Tools';
  canvas.classList.toggle('armed', !!kind);
  glCanvas.classList.toggle('armed', !!kind);
  canvas.classList.toggle('shaping', SHAPERS.has(kind));
  glCanvas.classList.toggle('shaping', SHAPERS.has(kind));
}

for (const c of [canvas, glCanvas]) {
  c.addEventListener('touchstart', (e) => { if (armed && SHAPERS.has(armed)) e.preventDefault(); }, { passive: false });
  c.addEventListener('touchmove', (e) => { if (shaping || (armed && SHAPERS.has(armed) && e.touches.length === 1)) e.preventDefault(); }, { passive: false });
}

function startShaping(e) {
  const world = worldAt(e.clientX, e.clientY);
  shaping = { kind: armed, world, pts: world ? [world] : [], timer: null };
  // While shaping the ground, the river's bed runs in real time.
  if (armed !== 'section') worker.postMessage({ type: 'hold', on: true });
  if (armed === 'raise' || armed === 'lower') {
    // Remember the ground as it was, to outline what the stroke moves.
    renderer.marked = last ? { base: Float32Array.from(last.z), frame: last, box: null, until: Infinity } : null;
  }
  if (armed === 'dig' || armed === 'section') {
    renderer.digPath = shaping.pts;
    renderer.digKind = armed;
    startEffects();
    return;
  }
  const nudge = () => {
    const w = shaping && shaping.world;
    if (!w) return;
    const i = cellAt(...w);
    if (i >= 0) worker.postMessage({ type: 'sculpt', i, size: brushSize, strength: brushStrength, dir: shaping.kind === 'raise' ? 1 : -1 });
    const r = BRUSH_CELLS[brushSize];
    renderer.brush = { x: w[0], y: w[1], r, t: performance.now() };
    const m = renderer.marked;
    if (m) {
      const R = 2 * r + 1, bx0 = Math.floor(w[0] - R), by0 = Math.floor(w[1] - R), bx1 = Math.ceil(w[0] + R), by1 = Math.ceil(w[1] + R);
      m.box = m.box ? [Math.min(m.box[0], bx0), Math.min(m.box[1], by0), Math.max(m.box[2], bx1), Math.max(m.box[3], by1)] : [bx0, by0, bx1, by1];
    }
    startEffects();
  };
  nudge();
  shaping.timer = setInterval(nudge, BRUSH_MS);
}

function moveShaping(e) {
  const world = worldAt(e.clientX, e.clientY);
  if (!world) return;
  shaping.world = world;
  if (shaping.kind === 'dig' || shaping.kind === 'section') {
    const p = shaping.pts[shaping.pts.length - 1];
    if (!p || Math.hypot(world[0] - p[0], world[1] - p[1]) >= 0.4) shaping.pts.push(world);
    startEffects();
  }
}

function endShaping(cancelled) {
  if (!shaping) return;
  clearInterval(shaping.timer);
  if (shaping.kind !== 'section') worker.postMessage({ type: 'hold', on: false });
  if (renderer.marked) renderer.marked.until = performance.now() + 1800;
  if (!cancelled && shaping.pts.length >= 2) {
    if (shaping.kind === 'dig') worker.postMessage({ type: 'dig', points: shaping.pts });
    if (shaping.kind === 'section') {
      worker.postMessage({ type: 'section', points: shaping.pts });
      showTab('profile');
    }
  }
  shaping = null;
  renderer.digPath = null;
  renderer.brush = null;
  startEffects();
}

// The table's sliders: each sets one of the world's settings, is sent when
// let go, and is saved with the world. [slider id]: [setting, slider units
// per setting unit, label].
const signed = (v, unit) => (Math.abs(v) < 1e-9 ? `±0 ${unit}` : `${v > 0 ? '+' : '−'}${n1.format(Math.abs(v))} ${unit}`);
const SLIDERS = {
  flow: ['flow', 1, (v) => `${v} m³/s`],
  tilt: ['tilt', 1000, (v) => `${n1.format(v)} m/km`],
  sea: ['sea', 1, (v) => signed(v, 'm')],
  supply: ['supply', 100, (v) => `${Math.round(v)}%`],
};
for (const [id, [key, scale, label]] of Object.entries(SLIDERS)) {
  $(id).addEventListener('input', () => { $(`${id}-out`).textContent = label(Number($(id).value)); });
  $(id).addEventListener('change', () => { if (worker) worker.postMessage({ type: 'setting', key, value: Number($(id).value) / scale }); });
}
for (const b of document.querySelectorAll('#strength-row button')) {
  b.addEventListener('click', () => {
    brushStrength = b.dataset.strength;
    for (const o of document.querySelectorAll('#strength-row button')) o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
  });
}
for (const b of document.querySelectorAll('#brush-row button')) {
  b.addEventListener('click', () => {
    brushSize = b.dataset.brush;
    for (const o of document.querySelectorAll('#brush-row button')) o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
  });
}

function setTray(open) {
  $('tools-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  $('tools').hidden = !open;
  if (!open) setArmed(null);
}

$('tools-toggle').addEventListener('click', () => setTray($('tools').hidden));
for (const b of document.querySelectorAll('.tools .tool')) {
  b.addEventListener('click', () => setArmed(armed === b.dataset.kind ? null : b.dataset.kind));
}

// --- tap to inspect ------------------------------------------------------------

function inspectCell(wx, wy) {
  if (!last) return;
  const x = Math.floor(wx), y = Math.floor(wy);
  if (x < 0 || y < 0 || x >= last.W || y >= last.H) return;
  inspectAt = y * last.W + x;
  worker.postMessage({ type: 'inspect', i: inspectAt });
  clearInterval(inspectTimer);
  inspectTimer = setInterval(() => { if (inspectAt >= 0) worker.postMessage({ type: 'inspect', i: inspectAt }); }, 1000);
}
$('inspect-close').addEventListener('click', () => {
  inspectAt = -1;
  clearInterval(inspectTimer);
  $('inspect').hidden = true;
});

function renderInspect(info) {
  if (!info || inspectAt < 0) return;
  $('inspect').hidden = false;
  const title = info.water === 'sea' ? `Sea, ${n1.format(info.depth)} m deep`
    : info.water === 'river' ? `River, ${n1.format(info.depth)} m deep`
      : info.water === 'shallows' ? `Shallows, ${n0.format(info.depth * 100)} cm deep`
        : info.block ? 'Block of rock' : `Land, ${n1.format(info.elevation)} m above the sea`;
  $('inspect-title').textContent = title;
  $('inspect-ground').textContent = info.block ? 'Rock the river can’t wear away.'
    : `Sand and gravel, ${n1.format(info.rockBelow)} m deep over bedrock.`;
  const facts = $('inspect-facts');
  facts.innerHTML = '';
  const fact = (k, v) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); facts.append(d); };
  if (info.depth > 0) fact('Current', `${n1.format(info.speed)} m/s`);
  if (info.sand > 0.01) fact('Sand moving', `${n1.format(info.sand)} m³/day per m`);
  const ch = info.change;
  fact(ch >= 0 ? 'Built up' : 'Cut down', `${n1.format(Math.abs(ch))} m since the start`);
  const r = info.rate;
  if (Math.abs(r) > 0.01) fact(r < 0 ? 'Cutting' : 'Filling', `${n1.format(Math.abs(r) * 100)} cm a year`);
  fact('Plant cover', `${n0.format(info.cover * 100)}%`);
}

window.addEventListener('resize', () => { if (last) draw(last, true); updateScale(); });

// Test hooks.
window.Headwaters = {
  state: () => (last ? { years: last.years, stats: last.stats, climate: last.climate, paused: last.paused, stepMs: last.stepMs, targetRate: last.targetRate, actualRate: last.actualRate, tickYears: last.tickYears } : null),
  runTo: (years, morph) => new Promise((resolve) => { pendingRunTo = resolve; worker.postMessage({ type: 'runTo', years, morph }); }),
  setRate: (r) => setRate(r),
  fps: () => ({ fps: drawnAt.length / 2, paceMs, frameCost }),
  saveNow: () => new Promise((resolve) => { pendingSave = resolve; requestSave('test'); }),
  view: () => ({ zoom: renderer.zoom, x0: renderer.x0, y0: renderer.y0, inspectAt }),
  events: () => eventLog.slice(),
  note: () => (noteEv ? $('event-note').textContent : null),
  lookAt: (x, y, zoom) => { renderer.lookAt(x, y, zoom); viewChanged(); },
  set3d: (on) => set3d(on),
  cam: (c) => { if (c) Object.assign(view3d.cam, c); viewChanged(); return view3d && view3d.cam ? { ...view3d.cam } : null; },
  pick3d: (px, py) => view3d.pick(px, py),
  arm: (kind) => { setTray(true); setArmed(kind); },
  tab: (t) => showTab(t),
  mode: (m) => setMode(m),
  frame: () => last,
  shot3d: () => {
    composeView();
    const gl = view3d.gl, w = glCanvas.width, h = glCanvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let r = 0, g = 0, b = 0, sky = 0, n = 0;
    const s0 = view3d.skyRgb || [0, 0, 0];
    for (let k = 0; k < px.length; k += 4 * 7) {
      r += px[k]; g += px[k + 1]; b += px[k + 2]; n++;
      if (Math.abs(px[k] - s0[0]) + Math.abs(px[k + 1] - s0[1]) + Math.abs(px[k + 2] - s0[2]) < 6) sky++;
    }
    return { mean: [r / n, g / n, b / n], sky: sky / n };
  },
};

window.addEventListener('hashchange', () => {
  const seed = cleanSeed(decodeURIComponent(location.hash.slice(1)));
  if (seed && seed !== $('seed').value) start(seed);
});

// A visit with no seed in the link, or the saved world's seed, carries on
// from the save; any other seed starts that world fresh.
(async function boot() {
  const hashSeed = cleanSeed(decodeURIComponent(location.hash.slice(1)));
  let saved = null;
  try {
    saved = await loadWorld();
  } catch {
    saveOff = true;
    saveNote('Saving is off: this browser isn’t letting the page store the world.');
  }
  if (saved && saved.state && saved.state.kind === 'stream' && (!hashSeed || hashSeed === saved.state.seed)) resume(saved.state, saved.savedAt);
  else start(hashSeed || randomSeed());
}());
