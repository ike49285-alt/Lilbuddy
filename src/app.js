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
  setSpeedButton('10');
}

function onMessage(e) {
  const msg = e.data;
  if (msg.type === 'frame') {
    last = msg.frame;
    draw(last);
  } else if (msg.type === 'ranTo' && pendingRunTo) {
    pendingRunTo(msg.steps);
    pendingRunTo = null;
  }
}

function formatTime(years) {
  if (years < 1e6) return `${Math.round(years / 1000)} kyr`;
  return `${(years / 1e6).toFixed(2)} Myr`;
}
const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const n1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function draw(f) {
  renderer.draw(f);
  const st = f.stats;
  $('time').textContent = formatTime(f.years);
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
  const span = f.history.sea.length * 5;
  $('sp-from').textContent = span >= 1000 ? `−${n1.format(span / 1000)} Myr` : `−${span} kyr`;

  // 10 km = 20 cells.
  $('scale-bar').style.width = `${(20 / f.W) * $('map').clientWidth}px`;
}

function setSpeedButton(speed) {
  for (const b of document.querySelectorAll('.speed button')) {
    b.classList.toggle('on', b.dataset.speed === speed);
    b.setAttribute('aria-pressed', b.dataset.speed === speed ? 'true' : 'false');
  }
}

for (const b of document.querySelectorAll('.speed button')) {
  b.addEventListener('click', () => {
    const s = b.dataset.speed;
    if (s === 'pause') worker.postMessage({ type: 'pause' });
    else worker.postMessage({ type: 'speed', speed: s });
    setSpeedButton(s);
  });
}

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
  state: () => (last ? { years: last.years, stats: last.stats, climate: last.climate, paused: last.paused, stepMs: last.stepMs } : null),
  runTo: (steps) => new Promise((resolve) => {
    pendingRunTo = resolve;
    worker.postMessage({ type: 'runTo', steps });
  }),
  setSpeed: (s) => worker.postMessage(s === 'pause' ? { type: 'pause' } : { type: 'speed', speed: s }),
};

start(cleanSeed(decodeURIComponent(location.hash.slice(1))) || randomSeed());
