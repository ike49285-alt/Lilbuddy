// app.js — the page: starts the worker, draws what it sends, wires the controls.

import { MapRenderer, drawSpark, elevationColor } from './render.js';

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
// Rates in sim-years per real second.
const PRESETS = [
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
const LOG_MIN = Math.log10(DAY);
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

function start(seed) {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onMessage;
  worker.postMessage({ type: 'init', seed });
  $('seed').value = seed;
  try { history.replaceState(null, '', `#${seed}`); } catch { /* some hosts forbid it */ }
  paused = false;
  setPausedUI();
  sendRate();
}

function onMessage(e) {
  const msg = e.data;
  if (msg.type === 'frame') {
    last = msg.frame;
    draw(last);
  } else if (msg.type === 'ranTo' && pendingRunTo) {
    pendingRunTo(msg.years);
    pendingRunTo = null;
  }
}

const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const n1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

// At day-scale rates the clock counts days within the year, so it visibly
// moves; otherwise it shows whole years, thousands or millions.
function formatTime(years, tickYears) {
  const year = Math.floor(years + 1e-9);
  if (tickYears < 1) {
    const day = Math.min(365, Math.floor((years - year) * 365.25 + 1e-6) + 1);
    return `${n0.format(year)} yr · day ${day}`;
  }
  if (years < 10000) return `${n0.format(year)} yr`;
  if (years < 1e6) return `${(years / 1000).toFixed(1)} kyr`;
  return `${(years / 1e6).toFixed(3)} Myr`;
}

function formatSpan(years) {
  const trim = (v) => (v >= 10 || Math.abs(v - Math.round(v)) < 0.05 ? n0.format(v) : n1.format(v));
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

function draw(f) {
  renderer.draw(f);
  const st = f.stats;
  $('time').textContent = formatTime(f.years, f.tickYears);
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

  $('s-len').textContent = st.trunkLen > 0 ? `${n0.format(st.trunkLen / 1000)} km` : 'not yet';
  $('s-q').textContent = `${n1.format(st.mouthQ / 3.156e7)} m³/s`;
  $('s-share').textContent = `${n0.format(st.mainShare * 100)}%`;
  $('s-relief').textContent = `${n0.format(st.relief)} m`;
  $('s-ice').textContent = st.iceCells ? `${n0.format(st.iceCells * CELL_KM2)} km²` : 'none';
  $('s-lakes').textContent = st.lakeCells ? `${n0.format(st.lakeCells * CELL_KM2)} km²` : 'none';
  $('s-delta').textContent = `${n0.format(st.deltaCells * CELL_KM2)} km²`;
  $('s-temp').textContent = `${n1.format(f.climate.seaT)} °C`;

  const css = getComputedStyle(document.documentElement);
  const water = css.getPropertyValue('--water').trim();
  const soft = css.getPropertyValue('--water-soft').trim();
  const grid = css.getPropertyValue('--line').trim();
  drawSpark($('sp-sea'), f.history.sea, { color: water, fill: soft, grid, zeroLine: 0 });
  drawSpark($('sp-q'), Array.from(f.history.mouthQ, (q) => q / 3.156e7), { color: water, fill: soft, grid });
  $('sp-sea-v').textContent = `${n0.format(f.seaLevel)} m`;
  $('sp-q-v').textContent = `${n0.format(st.mouthQ / 3.156e7)} m³/s`;
  const span = (f.history.sea.length * f.history.everyYears) / 1000;
  $('sp-from').textContent = span >= 1000 ? `−${n1.format(span / 1000)} Myr` : `−${n0.format(span)} kyr`;

  // 10 km = 20 cells.
  $('scale-bar').style.width = `${(20 / f.W) * $('map').clientWidth}px`;
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

// The elevation key uses the map's own colours.
{
  const stops = [0, 250, 500, 750, 1000, 1300, 1600, 1900, 2200, 2500, 2900];
  // Ticks sit at 0, 500, 1000, 2000, 2900 — spaced as the ramp below spaces them.
  const pos = (m) => (m <= 1000 ? (m / 1000) * 0.5 : m <= 2000 ? 0.5 + ((m - 1000) / 1000) * 0.25 : 0.75 + ((m - 2000) / 900) * 0.25);
  $('ramp').style.background = `linear-gradient(to right, ${stops.map((m) => `${elevationColor(m)} ${(pos(m) * 100).toFixed(1)}%`).join(', ')})`;
}

window.addEventListener('resize', () => { if (last) draw(last); });

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
};

start(cleanSeed(decodeURIComponent(location.hash.slice(1))) || randomSeed());
