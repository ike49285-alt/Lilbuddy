// app.js — the page: starts the worker, draws what it sends, wires the controls.

import { MapRenderer, drawSpark, elevationColor, ROCK_RGB, COVER_RGB, LAYERS } from './render.js';
import { saveWorld, loadWorld } from './save.js';
import { View3D, webglAvailable } from './view3d.js';

const CELL_KM2 = 0.25;
const SEED_WORDS = ['alder', 'basalt', 'cedar', 'delta', 'eddy', 'fjord', 'gravel', 'heron', 'iron',
  'juniper', 'karst', 'larch', 'moraine', 'notch', 'oxbow', 'pumice', 'quartz', 'riffle', 'scree',
  'tarn', 'umber', 'vale', 'willow', 'yarrow', 'zinc'];

const $ = (id) => document.getElementById(id);
const renderer = new MapRenderer($('map-canvas'));
let worker = null;
let last = null;
let pendingRunTo = null;

// --- time rate -------------------------------------------------------------

const DAY = 1 / 365.25;
const HOUR = DAY / 24;
const MINUTE = HOUR / 60;
// Rates in sim-years per real second.
const PRESETS = [
  { rate: 10 * MINUTE, label: '10 min/s' },
  { rate: HOUR, label: '1 hr/s' },
  { rate: DAY, label: '1 day/s' },
  { rate: 7 * DAY, label: '1 week/s' },
  { rate: 1 / 12, label: '1 month/s' },
  { rate: 1, label: '1 yr/s' },
  { rate: 10, label: '10 yr/s' },
  { rate: 100, label: '100 yr/s' },
  { rate: 1000, label: '1 kyr/s' },
  { rate: 10000, label: '10 kyr/s' },
  { rate: 100000, label: '100 kyr/s' },
];
const MAX_RATE = 'max';
const LOG_MIN = Math.log10(10 * MINUTE);
const LOG_MAX = 5;
const SLIDER_MAX = 1000;
const SNAP = 14;            // slider units within which a drag snaps to a preset
let rate = 1000;            // a number, or MAX_RATE
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

// Picks up a saved world exactly where it stopped.
function resume(state, savedAt) {
  newWorker();
  worker.postMessage({ type: 'restore', state });
  afterStart(state.seed);
  lastSaved = savedAt;
  saveNote(`Picked up where you left off`);
}

function afterStart(seed) {
  selectedId = null;
  listSig = '';
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
    // A frame that arrives while another is still waiting replaces it; the
    // replaced one is acknowledged at once so the worker can keep going.
    if (drawPending && worker) worker.postMessage({ type: 'ack', nextIn: paceMs });
    // Events ride on the frame they happened in; a replaced frame hands its
    // own on to the next, so none are missed.
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

// At day-scale rates the clock counts days within the year, and below a
// day the time of day too, so it visibly moves; otherwise it shows whole
// years, thousands or millions.
function formatTime(years, tickYears) {
  const year = Math.floor(years + 1e-9);
  if (tickYears < 1) {
    const days = (years - year) * 365.25 + 1e-6;
    const day = Math.min(365, Math.floor(days) + 1);
    // Two lines, so it fits beside the controls on a phone.
    if (tickYears >= DAY) return `${n0.format(year)} yr\nday ${day}`;
    const mins = Math.floor((days - Math.floor(days)) * 1440);
    const hh = String(Math.floor(mins / 60)).padStart(2, '0'), mm = String(mins % 60).padStart(2, '0');
    return `${n0.format(year)} yr\nday ${day} ${hh}:${mm}`;
  }
  if (years < 10000) return `${n0.format(year)} yr`;
  if (years < 1e6) return `${(years / 1000).toFixed(1)} kyr`;
  return `${(years / 1e6).toFixed(3)} Myr`;
}

function formatSpan(years) {
  const trim = (v) => (v >= 10 || Math.abs(v - Math.round(v)) < 0.05 ? n0.format(v) : n1.format(v));
  if (years < 0.95 * HOUR) return `${trim(years / MINUTE)} min`;
  if (years < 0.95 * DAY) return `${trim(years / HOUR)} hr`;
  if (years < 6.5 * DAY) return `${trim(years * 365.25)} day`;
  if (years < 0.07) return `${trim(years * 52.18)} wk`;
  if (years < 0.95) return `${trim(years * 12)} mo`;
  if (years < 1000) return `${trim(years)} yr`;
  return `${trim(years / 1000)} kyr`;
}

const rateLabel = (r) => `${formatSpan(r)}/s`;

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

// Brings the slider and the list in line with the current rate.
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
// frame, and the worker hears back so it can send the next.
let drawPending = false;
let lastSlow = 0;
const SLOW_MS = 500;

// Adaptive pacing: each frame's real cost on the main thread is its script
// time, or how far it pushed the next display frame late (which catches the
// browser's paint and canvas work), whichever is larger. The worker is told
// to space frames so drawing takes about a quarter of the main thread: up to
// 30 fps when frames are cheap, fewer on a device that's struggling.
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
  // Ask for the next frame now, paced by what earlier frames cost; this
  // frame's own cost is folded in once the browser has painted it.
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
  tokens = {
    water: css.getPropertyValue('--water').trim(),
    soft: css.getPropertyValue('--water-soft').trim(),
    grid: css.getPropertyValue('--line').trim(),
  };
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { tokens = null; lastSlow = 0; });

function draw(f, force) {
  const sel = selectedId && f.species.find((s) => s.id === selectedId && s.died === null);
  if (selectedId && !sel) selectSpecies(null);
  if (sel) renderer.selectedRgb = hslRgb(sel.hue);
  if (view3d && in3d) {
    renderer.paint(f);
    view3d.render(f);
  } else {
    renderer.draw(f);
  }
  composedKey = viewKey();
  if (f.events && f.events.length) {
    for (const ev of f.events) onEvent(ev, f);
    f.events = [];
  }
  const clock = formatTime(f.years, f.tickYears);
  $('time').textContent = clock;
  $('time').classList.toggle('two', clock.includes('\n'));
  $('tick').textContent = `tick ${formatSpan(f.tickYears)}`;
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
  const phase = $('phase');
  phase.textContent = f.climate.label;
  phase.classList.toggle('glacial', f.climate.glacial > 0.55);

  // Everything below changes slowly; it doesn't need redoing every frame.
  const now = performance.now();
  if (!force && now - lastSlow < SLOW_MS) return;
  lastSlow = now;
  drawSlow(f);
}

function drawSlow(f) {
  const st = f.stats;
  for (const [id, [key, scale, label]] of Object.entries(SLIDERS)) {
    const value = f.climate.settings && f.climate.settings[key];
    if (document.activeElement === $(id) || value == null) continue;
    const v = Math.round(value * scale * 100) / 100;
    if (Number($(id).value) !== v) { $(id).value = v; $(`${id}-out`).textContent = label(v); }
  }
  drawLife(f);

  $('s-len').textContent = st.trunkLen > 0 ? `${n0.format(st.trunkLen / 1000)} km` : 'not yet';
  $('s-q').textContent = `${n1.format(st.mouthQ / 3.156e7)} m³/s`;
  $('s-share').textContent = `${n0.format(st.mainShare * 100)}%`;
  $('s-relief').textContent = `${n0.format(st.relief)} m`;
  const iceKm = st.iceCells * CELL_KM2, snowKm = (st.snowCells || 0) * CELL_KM2;
  $('s-ice').textContent = iceKm || snowKm
    ? [iceKm ? `${n0.format(iceKm)} km² ice` : '', snowKm ? `${n0.format(snowKm)} km² snow` : ''].filter(Boolean).join(', ')
    : 'none';
  $('s-lakes').textContent = st.lakeCells ? `${n0.format(st.lakeCells * CELL_KM2)} km²` : 'none';
  $('s-delta').textContent = `${n0.format(st.deltaCells * CELL_KM2)} km²`;
  // Tonnes a year; at a few million and up, in megatonnes.
  const silt = st.toSea || 0;
  $('s-silt').textContent = silt >= 1e6 ? `${n1.format(silt / 1e6)} Mt/yr` : silt >= 1e3 ? `${n0.format(silt / 1e3)} kt/yr` : silt > 0 ? `${n0.format(silt)} t/yr` : 'none yet';
  $('s-dams').textContent = st.dams ? `${n0.format(st.dams)}, ${n1.format((st.ponds || 0) * CELL_KM2)} km² of ponds` : 'none';
  $('s-temp').textContent = `${n1.format(f.climate.seaT)} °C`;

  if (!tokens) readTokens();
  const { water, soft, grid } = tokens;
  drawSpark($('sp-sea'), f.history.sea, { color: water, fill: soft, grid, zeroLine: 0 });
  drawSpark($('sp-q'), Array.from(f.history.mouthQ, (q) => q / 3.156e7), { color: water, fill: soft, grid });
  $('sp-sea-v').textContent = `${n0.format(f.seaLevel)} m`;
  $('sp-q-v').textContent = `${n0.format(st.mouthQ / 3.156e7)} m³/s`;
  const span = (f.history.sea.length * f.history.everyYears) / 1000;
  $('sp-from').textContent = span >= 1000 ? `−${n1.format(span / 1000)} Myr` : `−${n0.format(span)} kyr`;

  updateScale();
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
  // Snap to a nearby preset, so the round numbers are easy to land on.
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

// The page keeps clear of the fixed time bar.
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

// --- life --------------------------------------------------------------------

let selectedId = null;
let listSig = '';
let inspectAt = -1;
let inspectTimer = null;

const hueCss = (h) => `hsl(${Math.round(h * 360)} 62% 50%)`;
function hslRgb(h, s = 0.62, l = 0.5) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function when(years) {
  if (years < 1000) return `${n0.format(years)} yr`;
  if (years < 1e6) return `${n0.format(years / 1000)} kyr`;
  return `${(years / 1e6).toFixed(2)} Myr`;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function swatch(h) {
  const s = el('span', 'swatch');
  s.style.background = hueCss(h);
  return s;
}

function drawLife(f) {
  const ls = f.lifeStats;
  $('l-alive').textContent = n0.format(ls.alive);
  $('l-land').textContent = ls.firstLandPlant === null ? 'not yet' : `${ls.landPlants} species, since ${when(ls.firstLandPlant)}`;
  $('l-veg').textContent = `${n0.format(ls.vegetated)} km²`;
  $('l-ever').textContent = `${n0.format(ls.everLived)} species`;
  $('l-animals').textContent = ls.animals ? `${ls.animals} species` : 'none';
  $('l-ashore').textContent = ls.firstLandAnimal === null ? 'not yet' : `${ls.landAnimals} species, since ${when(ls.firstLandAnimal)}`;

  const living = f.species.filter((s) => s.died === null).sort((a, b) => b.range - a.range);
  const byId = new Map(f.species.map((s) => [s.id, s]));
  const sig = living.map((s) => s.id).join(',');
  const list = $('species-list');
  if (sig !== listSig) {
    listSig = sig;
    list.innerHTML = '';
    for (const sp of living) {
      const li = el('li');
      const b = el('button');
      b.type = 'button';
      b.dataset.id = sp.id;
      b.setAttribute('aria-pressed', sp.id === selectedId ? 'true' : 'false');
      const text = el('span', 'sp-text');
      text.append(el('span', 'sp-name', sp.name), el('span', 'sp-form', sp.form));
      b.append(swatch(sp.hue), text, el('span', 'sp-range'));
      b.addEventListener('click', () => selectSpecies(sp.id === selectedId ? null : sp.id));
      li.append(b);
      list.append(li);
    }
  }
  for (const b of list.querySelectorAll('button')) {
    const sp = byId.get(Number(b.dataset.id));
    if (!sp) continue;
    const arrow = sp.trend > 0 ? '▲' : sp.trend < 0 ? '▼' : '';
    const r = b.querySelector('.sp-range');
    r.textContent = `${n0.format(sp.range)} km² ${arrow}`;
    r.className = `sp-range ${sp.trend > 0 ? 'trend-up' : sp.trend < 0 ? 'trend-down' : ''}`;
    b.querySelector('.sp-form').textContent = sp.form;
  }

  const card = $('species-card');
  const sel = selectedId ? byId.get(selectedId) : null;
  card.hidden = !sel;
  if (sel) renderCard(card, sel, byId);

}

function renderCard(card, sp, byId) {
  const t = sp.traits;
  const parent = sp.parent ? byId.get(sp.parent) : null;
  card.innerHTML = '';
  const h = el('h3');
  h.append(swatch(sp.hue), el('span', '', sp.name));
  card.append(h);
  card.append(el('p', '', `${sp.form} · appeared ${when(sp.born)}${parent ? ` from ${parent.name}` : sp.arrivedAt != null ? ', arriving from beyond the valley' : sp.seededAt != null ? ', seeded by hand' : ', seeded at the start'}. Lives over ${n0.format(sp.range)} km².`));
  const dl = el('dl', 'traits');
  const row = (label, v, text) => {
    const d = el('div');
    const m = el('span', 'meter');
    const bar = el('span');
    bar.style.width = `${Math.round(v * 100)}%`;
    m.append(bar);
    d.append(el('dt', '', label), m, el('dd', '', text));
    dl.append(d);
  };
  row('Water ↔ land', t.habitat, t.habitat < 0.4 ? 'water' : t.habitat < 0.62 ? 'edge' : 'land');
  row('Fresh ↔ salt', t.salinity, t.salinity < 0.35 ? 'fresh' : t.salinity < 0.65 ? 'brackish' : 'marine');
  row('Warmth', t.tempOpt, `${n0.format(t.tempOptC)} ± ${n0.format(t.tempWidthC)} °C`);
  row('Complexity', t.complexity, t.complexity < 0.3 ? 'simple' : t.complexity < 0.6 ? 'moderate' : 'complex');
  row('Spread', t.dispersal, t.dispersal < 0.35 ? 'slow' : t.dispersal < 0.7 ? 'medium' : 'fast');
  if (t.animal) {
    row('Food: tiny ↔ plants', t.diet, t.diet < 0.35 ? 'filters plankton' : t.diet < 0.65 ? 'a bit of both' : 'grazes plants');
    row('Fins ↔ legs', t.limbs, t.limbs < 0.25 ? 'fins' : t.limbs < 0.6 ? 'fleshy fins' : 'legs');
    row('Gills ↔ lungs', t.lungs, t.lungs < 0.25 ? 'gills' : t.lungs < 0.6 ? 'gulps air' : 'lungs');
    row('Eggs: water ↔ land', t.eggs || 0, (t.eggs || 0) < 0.3 ? 'in water' : (t.eggs || 0) < 0.6 ? 'damp places' : 'shelled, on land');
    row('Blood: cold ↔ warm', t.warm || 0, (t.warm || 0) < 0.3 ? 'cold' : (t.warm || 0) < 0.5 ? 'warming' : 'warm');
    row('Eats: plants ↔ animals', t.prey || 0, (t.prey || 0) < 0.25 ? 'plants' : (t.prey || 0) < 0.5 ? 'some meat' : 'hunts');
    row('Builds dams', t.build || 0, (t.build || 0) < 0.25 ? 'no' : (t.build || 0) < 0.5 ? 'gnaws wood' : 'dams streams');
  } else {
    row('Spores ↔ seeds', t.seeds || 0, (t.seeds || 0) < 0.4 ? 'spores' : (t.seeds || 0) < 0.75 ? 'seeds' : 'flowers');
  }
  card.append(dl);
}

function selectSpecies(id) {
  selectedId = id;
  syncSeedPicked();
  lastSlow = 0;
  worker.postMessage({ type: 'select', id });
  for (const b of document.querySelectorAll('#species-list button')) {
    b.setAttribute('aria-pressed', Number(b.dataset.id) === id ? 'true' : 'false');
  }
}

function showTab(name) {
  for (const t of ['river', 'life']) {
    $(`tab-${t}`).setAttribute('aria-selected', t === name ? 'true' : 'false');
    $(`pane-${t}`).hidden = t !== name;
  }
  if (last) drawSlow(last);
}
for (const t of ['river', 'life']) $(`tab-${t}`).addEventListener('click', () => showTab(t));

const LAYER_NAMES = { heat: 'Temperature', rain: 'Rainfall', flow: 'River flow', erode: 'Erosion' };
const LAYER_SHORT = { heat: 'Heat', rain: 'Rain', flow: 'Flow', erode: 'Erosion' };   // fits the mode switch
function setMode(mode) {
  renderer.mode = mode;
  const layer = LAYERS[mode] ? mode : null;
  for (const m of ['landscape', 'species', 'ground']) $(`mode-${m}`).setAttribute('aria-pressed', mode === m ? 'true' : 'false');
  $('mode-layers').setAttribute('aria-pressed', layer ? 'true' : 'false');
  $('mode-layers').textContent = layer ? LAYER_SHORT[layer] : 'Layers';
  $('mode-layers').setAttribute('aria-label', layer ? `Layer: ${LAYER_NAMES[layer]}` : 'Layers');
  for (const b of document.querySelectorAll('#layer-menu button')) b.setAttribute('aria-checked', b.dataset.layer === layer ? 'true' : 'false');
  // The layer's key, in the same colours.
  $('layer-key').hidden = !layer;
  if (layer) {
    const L = LAYERS[layer];
    $('layer-name').textContent = LAYER_NAMES[layer];
    $('layer-ramp').style.background = `linear-gradient(to right, ${L.stops.map((s) => `rgb(${s[1]}, ${s[2]}, ${s[3]}) ${s[0] * 100}%`).join(', ')})`;
    $('layer-ticks').replaceChildren(...L.ticks.map((t) => el('span', '', t)));
  }
  setLayerMenu(false);
  if (worker) worker.postMessage({ type: 'mode', mode });
  if (last) draw(last, true);
}
function setLayerMenu(open) {
  $('layer-menu').hidden = !open;
  $('mode-layers').setAttribute('aria-expanded', open ? 'true' : 'false');
}
$('mode-layers').addEventListener('click', () => setLayerMenu($('layer-menu').hidden));
for (const b of document.querySelectorAll('#layer-menu button')) b.addEventListener('click', () => setMode(b.dataset.layer));
$('mode-landscape').addEventListener('click', () => setMode('landscape'));
$('mode-species').addEventListener('click', () => setMode('species'));
$('mode-ground').addEventListener('click', () => setMode('ground'));

// The ground key, in the map's own colours.
{
  const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  const items = [['Granite', ROCK_RGB[0]], ['Sandstone', ROCK_RGB[1]], ['Shale', ROCK_RGB[2]], ['Limestone', ROCK_RGB[3]],
    ['Basalt', ROCK_RGB[4]], ['Sand & silt', COVER_RGB[1]], ['Soil', COVER_RGB[2]], ['Scree', COVER_RGB[3]]];
  for (const [name, c] of items) {
    const li = el('li');
    const sw = el('span', 'swatch');
    sw.style.background = rgb(c);
    li.append(sw, el('span', '', name));
    $('ground-key').append(li);
  }
}

// --- zoom and pan -------------------------------------------------------------

const canvas = $('map-canvas');
const TAP_PX = 6;            // a press that moves less than this is a tap
const DOUBLE_TAP_MS = 300;
const ZOOM_STEP = 2;
let viewDrawPending = false;
let settleTimer = null;
let composedKey = '';

// Redraws the map for the current view from the last frame, without waiting
// for the worker, and again once the view has settled so the rivers sharpen.
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
  $('map').classList.toggle('in3d', on);
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
  if (!width) return;
  const kmPerPx = ((renderer.W / renderer.zoom) * 0.5) / width;
  const room = Math.min(80, width * 0.2);
  const steps = [0.2, 0.5, 1, 2, 5, 10, 20];
  let km = steps[0];
  for (const s of steps) if (s / kmPerPx <= room) km = s;
  $('scale-bar').style.width = `${km / kmPerPx}px`;
  $('scale-label').textContent = km < 1 ? `${km * 1000} m` : `${km} km`;
}

function fractions(clientX, clientY) {
  const r = (in3d ? glCanvas : canvas).getBoundingClientRect();
  return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
}

// The world point (cells) under a point on screen, in either view; null for
// the sky in 3D.
function worldAt(clientX, clientY) {
  if (in3d) {
    const r = glCanvas.getBoundingClientRect();
    return view3d.pick(clientX - r.left, clientY - r.top);
  }
  return renderer.toWorld(...fractions(clientX, clientY));
}

const pointers = new Map();
let press = null;            // one finger or the mouse: where it went down, and whether it moved
let pinch = null;            // two fingers: their spread and midpoint when the pinch began
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
    // A second finger: it's a pinch, not a stroke.
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
    // 3D: one finger turns and tilts, two pinch to zoom and slide the land.
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
    // Keep the world point that started under the fingers' midpoint under it.
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
    // Lifting one finger of a pinch doesn't start a drag or count as a tap.
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
      // Double-tap in 3D: centre on that spot and move in.
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

// Wheel and trackpad zoom around the pointer. At the limits the wheel is left
// to scroll the page.
canvas.addEventListener('wheel', (e) => {
  let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
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

// --- disasters ------------------------------------------------------------------

let armed = null;            // the tool waiting for a tap on the map
let toolSize = 'big';
let pendingNotes = [];
let noteEv = null;
let noteAt = 0;
let noteTimer = null;
let fxRunning = false;
const NOTE_MS = 6000;
const NOTE_GAP_MS = 1000;
const eventLog = [];         // for the test hooks

renderer.setEffectsCanvas($('fx-canvas'));

function onEvent(ev) {
  eventLog.push({ ...ev, cells: ev.cells ? ev.cells.length : 0 });
  if (eventLog.length > 50) eventLog.shift();
  // Quiet events (nature's fires, floods, the bombardment) only animate
  // when time runs slowly enough to watch one: at a year a tick or more,
  // they'd keep the effects layer redrawing for nothing anyone could follow.
  if (!ev.quiet || !(last && last.tickYears > 1)) {
    renderer.addEffect(ev, ev.quiet);
    startEffects();
  }
  if (!ev.quiet) {
    pendingNotes.push(ev);
    pumpNotes();
  }
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

// One note at a time, at most one new one a second; when several arrive
// together the most serious shows, with a count of the rest.
function pumpNotes() {
  const now = performance.now();
  clearTimeout(noteTimer);
  // One you set off yourself is answered at once.
  const own = pendingNotes.some((e) => e.byHand);
  if (pendingNotes.length && (own || now - noteAt >= NOTE_GAP_MS)) {
    const rank = (e) => (e.byHand ? 4 : e.catastrophic || e.kind === 'milestone' ? 3 : e.kind === 'meteor' || e.kind === 'volcano' ? 2 : e.missed ? 0 : 1);
    let pick = pendingNotes[pendingNotes.length - 1];
    for (const e of pendingNotes) if (rank(e) > rank(pick)) pick = e;
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
  b.classList.toggle('catastrophic', !!ev.catastrophic);
  b.setAttribute('aria-label', ev.missed ? ev.label : `${ev.label}. Show on the map.`);
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
    view3d.cam.dist = Math.min(view3d.cam.dist, Math.max(40, 14 * ev.r));
  } else {
    renderer.lookAt(ev.x, ev.y, Math.max(renderer.zoom, Math.min(6, renderer.W / Math.max(20, 5 * ev.r))));
  }
  viewChanged();
  if (!ev.missed) { renderer.addEffect({ ...ev, quiet: false }); startEffects(); }
  hideNote();
});

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
  if (armed === 'seed') {
    worker.postMessage({ type: 'seed', i, id: seedKind === 'picked' ? selectedId : null, kind: seedKind });
    return;
  }
  if (armed === 'storm') {
    // A storm only shows where there's weather: at a day a second or
    // slower. Faster than that, slow down to an hour a second to watch it.
    if (rate === MAX_RATE || rate > DAY) setRate(HOUR);
    worker.postMessage({ type: 'storm', i });
    return;
  }
  if (SHAPERS.has(armed)) return;
  const sized = armed === 'volcano' || armed === 'meteor';
  worker.postMessage({ type: 'disaster', kind: armed, i, size: sized ? toolSize : 'big' });
}

const SHAPERS = new Set(['raise', 'lower', 'dig']);
const BRUSH_MS = 100;        // a held brush sends a nudge this often
const BRUSH_M = 5;           // metres per nudge at the brush's centre: 50 m a second
let brushSize = 'big';
let seedKind = 'plant';      // what Seed drops: 'plant', 'animal', or the 'picked' species
let shaping = null;          // a brush held down or a channel being drawn

function setArmed(kind) {
  armed = kind;
  for (const b of document.querySelectorAll('.tools .tool')) b.setAttribute('aria-pressed', b.dataset.kind === kind ? 'true' : 'false');
  $('size-row').hidden = !(kind === 'volcano' || kind === 'meteor');
  $('brush-row').hidden = !(kind === 'raise' || kind === 'lower');
  $('seed-row').hidden = kind !== 'seed';
  const names = {
    flood: 'Tap the map to flood a river.', lightning: 'Tap the map to strike with lightning.', volcano: 'Tap the map to raise a volcano.',
    meteor: 'Tap the map to drop a meteor.', raise: 'Hold a finger on the map to raise the ground.', lower: 'Hold a finger on the map to lower the ground.',
    dig: 'Draw a line on the map to dig a channel.', storm: 'Tap the map to park a storm there.',
    seed: seedKind === 'picked' ? 'Tap the map to seed the species picked in the Life tab.' : `Tap the map to seed ${seedKind === 'animal' ? 'an animal' : 'a plant'} there.`,
  };
  $('tools-hint').textContent = kind ? names[kind] : 'Pick a tool, then use it on the map.';
  const label = { flood: 'Tap map: Flood', lightning: 'Tap map: Lightning', volcano: 'Tap map: Volcano', meteor: 'Tap map: Meteor',
    raise: 'Brush: Raise', lower: 'Brush: Lower', dig: 'Draw: Dig', storm: 'Tap map: Storm', seed: 'Tap map: Seed' };
  $('tools-toggle').textContent = kind ? label[kind] : 'Tools';
  canvas.classList.toggle('armed', !!kind);
  glCanvas.classList.toggle('armed', !!kind);
  // Safari decides whether a touch scrolls the page as it starts, so a map
  // that's about to be shaped has to say so before the finger comes down.
  canvas.classList.toggle('shaping', SHAPERS.has(kind));
  glCanvas.classList.toggle('shaping', SHAPERS.has(kind));
}

// And while a stroke is under way, no touch on the map scrolls the page.
for (const c of [canvas, glCanvas]) {
  c.addEventListener('touchstart', (e) => { if (armed && SHAPERS.has(armed)) e.preventDefault(); }, { passive: false });
  c.addEventListener('touchmove', (e) => { if (shaping || (armed && SHAPERS.has(armed) && e.touches.length === 1)) e.preventDefault(); }, { passive: false });
}

// --- shaping by hand ---------------------------------------------------------

// One finger with a shaping tool armed shapes the land instead of moving the
// view: a brush raises or lowers the ground while held, Dig draws a line.
function startShaping(e) {
  const world = worldAt(e.clientX, e.clientY);
  shaping = { kind: armed, x: e.clientX, y: e.clientY, world, pts: world ? [world] : [], timer: null };
  if (armed === 'dig') {
    renderer.digPath = shaping.pts;
    startEffects();
    return;
  }
  const nudge = () => {
    const w = shaping && shaping.world;
    if (!w) return;
    const i = cellAt(...w);
    if (i >= 0) worker.postMessage({ type: 'sculpt', i, size: brushSize, dz: shaping.kind === 'raise' ? BRUSH_M : -BRUSH_M });
    renderer.brush = { x: w[0], y: w[1], r: brushSize === 'big' ? 4 : 1.5, t: performance.now() };
    startEffects();
  };
  nudge();
  shaping.timer = setInterval(nudge, BRUSH_MS);
}

function moveShaping(e) {
  shaping.x = e.clientX;
  shaping.y = e.clientY;
  const world = worldAt(e.clientX, e.clientY);
  if (!world) return;
  shaping.world = world;
  if (shaping.kind === 'dig') {
    const p = shaping.pts[shaping.pts.length - 1];
    if (!p || Math.hypot(world[0] - p[0], world[1] - p[1]) >= 0.4) shaping.pts.push(world);
    startEffects();
  }
}

// Ends a stroke; a finished line is dug, a cancelled one dropped.
function endShaping(cancelled) {
  if (!shaping) return;
  clearInterval(shaping.timer);
  if (shaping.kind === 'dig' && !cancelled && shaping.pts.length >= 2) {
    worker.postMessage({ type: 'dig', points: shaping.pts });
  }
  shaping = null;
  renderer.digPath = null;
  renderer.brush = null;
  startEffects();
}

// The world sliders: each sets one of the world's settings, is sent when
// let go, and is saved with the world. [slider id]: [setting, slider units
// per setting unit, label].
const pct = (v) => `${Math.round(v)}%`;
const signed = (v, unit) => (v === 0 ? `±0 ${unit}` : `${v > 0 ? '+' : '−'}${Math.abs(v)} ${unit}`);
const SLIDERS = {
  wetness: ['wetness', 100, pct],
  meteors: ['meteor', 100, pct],
  volcanoes: ['volcano', 100, pct],
  uplift: ['uplift', 100, pct],
  warmth: ['warmth', 1, (v) => signed(v, '°C')],
  sea: ['sea', 1, (v) => signed(v, 'm')],
  hardness: ['hardness', 100, pct],
};
for (const [id, [key, scale, label]] of Object.entries(SLIDERS)) {
  $(id).addEventListener('input', () => { $(`${id}-out`).textContent = label(Number($(id).value)); });
  $(id).addEventListener('change', () => { if (worker) worker.postMessage({ type: 'setting', key, value: Number($(id).value) / scale }); });
}
// What Seed drops. Picking a species in the Life tab offers it, and
// chooses it; unpicking it goes back to a plant.
function setSeedKind(k) {
  seedKind = k;
  for (const o of document.querySelectorAll('#seed-row button')) o.setAttribute('aria-pressed', o.dataset.seed === k ? 'true' : 'false');
  if (armed === 'seed') setArmed('seed');
}
function syncSeedPicked() {
  const picked = document.querySelector('#seed-row [data-seed="picked"]');
  picked.hidden = !selectedId;
  if (selectedId && seedKind !== 'picked') setSeedKind('picked');
  else if (!selectedId && seedKind === 'picked') setSeedKind('plant');
}
for (const b of document.querySelectorAll('#seed-row button')) b.addEventListener('click', () => setSeedKind(b.dataset.seed));
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
for (const b of document.querySelectorAll('#size-row button')) {
  b.addEventListener('click', () => {
    toolSize = b.dataset.size;
    for (const o of document.querySelectorAll('#size-row button')) o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
  });
}

// Tap the map: what lives here?
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
  const where = info.dam ? 'Dam' : info.water === 'sea' ? 'Sea' : info.pond ? 'Beaver pond' : info.water === 'lake' ? 'Lake' : info.water === 'river' ? 'River' : 'Land';
  $('inspect-title').textContent = info.water === 'sea' ? `${where}, ${n0.format(-info.elevation)} m deep` : `${where}, ${n0.format(info.elevation)} m up`;
  const gt = info.ground.text;
  $('inspect-ground').textContent = info.water === 'sea' || info.water === 'lake' ? `Bed: ${gt}` : `Ground: ${gt}`;
  const damLine = $('inspect-dam');
  damLine.hidden = !info.dam;
  if (info.dam) {
    const d = info.dam;
    const age = d.age < 1 ? 'this year' : d.age < 2 ? 'a year ago' : `${n0.format(d.age)} years ago`;
    damLine.textContent = `A ${n1.format(d.h)} m dam, built ${age} by ${d.name}${d.form ? ` (${d.form})` : ''}.`;
  }
  const facts = $('inspect-facts');
  facts.innerHTML = '';
  const fact = (k, v) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); facts.append(d); };
  fact('Now', `${n1.format(info.temp)} °C`);
  fact('Year avg', `${n1.format(info.meanTemp)} °C`);
  if (info.water !== 'sea') fact('Flow', `${n1.format(info.flow / 3.156e7)} m³/s`);
  if ((info.water === 'river' || info.water === 'lake') && info.silt >= 0.5) fact('Silt', `${n0.format(info.silt)} t a day`);
  fact('Plant cover', `${n0.format(info.cover * 100)}%`);
  if (info.snow > 0.005) fact('Snow', `${n0.format(info.snow * 100)} cm`);
  if (info.ice) fact('Ice', 'glacier');
  const ul = $('inspect-life');
  ul.innerHTML = '';
  if (!info.species.length) ul.append(el('li', 'empty', 'Nothing lives here yet.'));
  for (const sp of info.species.slice(0, 6)) {
    const li = el('li');
    li.append(swatch(sp.hue), el('span', 'sp-name', sp.name), el('span', 'sp-form', sp.form));
    ul.append(li);
  }
}

// The elevation key uses the map's own colours.
{
  const stops = [0, 250, 500, 750, 1000, 1300, 1600, 1900, 2200, 2500, 2900];
  // Ticks sit at 0, 500, 1000, 2000, 2900 — spaced as the ramp below spaces them.
  const pos = (m) => (m <= 1000 ? (m / 1000) * 0.5 : m <= 2000 ? 0.5 + ((m - 1000) / 1000) * 0.25 : 0.75 + ((m - 2000) / 900) * 0.25);
  $('ramp').style.background = `linear-gradient(to right, ${stops.map((m) => `${elevationColor(m)} ${(pos(m) * 100).toFixed(1)}%`).join(', ')})`;
}

window.addEventListener('resize', () => { if (last) draw(last, true); updateScale(); });

// Test hooks.
window.Headwaters = {
  state: () => (last ? {
    years: last.years, stats: last.stats, climate: last.climate, paused: last.paused,
    stepMs: last.stepMs, targetRate: last.targetRate, actualRate: last.actualRate, tickYears: last.tickYears,
  } : null),
  runTo: (years, tick) => new Promise((resolve) => {
    pendingRunTo = resolve;
    worker.postMessage({ type: 'runTo', years, tick });
  }),
  setRate: (r) => setRate(r),
  life: () => (last ? { stats: last.lifeStats, species: last.species } : null),
  fps: () => ({ fps: drawnAt.length / 2, paceMs, frameCost }),
  saveNow: () => new Promise((resolve) => { pendingSave = resolve; requestSave('test'); }),
  select: (id) => selectSpecies(id),
  view: () => ({ zoom: renderer.zoom, x0: renderer.x0, y0: renderer.y0, inspectAt }),
  events: () => eventLog.slice(),
  note: () => (noteEv ? $('event-note').textContent : null),
  effects: () => renderer.effects.length,
  disaster: (kind, x, y, size) => worker.postMessage({ type: 'disaster', kind, i: y * last.W + x, size }),
  cooling: () => (last ? last.climate.cooling : 0),
  lookAt: (x, y, zoom) => { renderer.lookAt(x, y, zoom); viewChanged(); },
  set3d: (on) => set3d(on),
  cam: (c) => { if (c) Object.assign(view3d.cam, c); viewChanged(); return view3d && view3d.cam ? { ...view3d.cam } : null; },
  pick3d: (px, py) => view3d.pick(px, py),
  arm: (kind) => { setTray(true); setArmed(kind); },
  frame: () => last,
  // The main thread's share of drawing a new frame in 3D, in ms.
  cost3d: (n = 10) => {
    const t0 = performance.now();
    for (let k = 0; k < n; k++) { view3d.frameOf = null; renderer.paint(last); view3d.render(last); }
    return (performance.now() - t0) / n;
  },
  // Renders the 3D view and reads it back at once (before the browser
  // clears it): the mean colour and the share that's sky.
  shot3d: () => {
    composeView();
    const gl = view3d.gl, w = glCanvas.width, h = glCanvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let r = 0, g = 0, b = 0, sky = 0, n = 0;
    const s0 = view3d.skyRgb || [0, 0, 0];
    const grid = new Array(64 * 3).fill(0), gn = new Array(64).fill(0);
    for (let k = 0; k < px.length; k += 4 * 7) {
      r += px[k]; g += px[k + 1]; b += px[k + 2]; n++;
      if (Math.abs(px[k] - s0[0]) + Math.abs(px[k + 1] - s0[1]) + Math.abs(px[k + 2] - s0[2]) < 6) sky++;
      const p = k / 4, cell = Math.min(7, Math.floor(((p / w) | 0) / h * 8)) * 8 + Math.min(7, Math.floor((p % w) / w * 8));
      grid[cell * 3] += px[k]; grid[cell * 3 + 1] += px[k + 1]; grid[cell * 3 + 2] += px[k + 2]; gn[cell]++;
    }
    // An 8 × 8 grid of mean colours, to tell pictures apart that average alike.
    for (let c = 0; c < 64; c++) for (let j = 0; j < 3; j++) grid[c * 3 + j] /= Math.max(1, gn[c]);
    return { mean: [r / n, g / n, b / n], sky: sky / n, grid };
  },
  project3d: (x, y) => { const r = glCanvas.getBoundingClientRect(); return view3d.project(x, y, r.width, r.height); },
  cloudy: () => !!(last && last.cloud),
  // The most thickly vegetated spot, in world cells.
  greenest: () => {
    const v = last.life.veg;
    let best = 0;
    for (let c = 1; c < v.length; c++) if (v[c] > v[best]) best = c;
    return { x: (best % last.life.LW) * 2 + 1, y: Math.floor(best / last.life.LW) * 2 + 1, veg: v[best] / 255 };
  },
};

// Editing the seed in the link starts that world.
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
  if (saved && saved.state && (!hashSeed || hashSeed === saved.state.seed)) resume(saved.state, saved.savedAt);
  else start(hashSeed || randomSeed());
}());
