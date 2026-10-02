// app.js — the page: starts the worker, draws what it sends, wires the controls.

import { MapRenderer, drawSpark, elevationColor } from './render.js';
import { saveWorld, loadWorld } from './save.js';

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
  treeSig = '';
  inspectAt = -1;
  clearInterval(inspectTimer);
  $('inspect').hidden = true;
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
  const sel = selectedId && f.species.find((s) => s.id === selectedId && s.died === null);
  if (selectedId && !sel) selectSpecies(null);
  if (sel) renderer.selectedRgb = hslRgb(sel.hue);
  renderer.draw(f);
  drawLife(f);
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
  const iceKm = st.iceCells * CELL_KM2, snowKm = (st.snowCells || 0) * CELL_KM2;
  $('s-ice').textContent = iceKm || snowKm
    ? [iceKm ? `${n0.format(iceKm)} km² ice` : '', snowKm ? `${n0.format(snowKm)} km² snow` : ''].filter(Boolean).join(', ')
    : 'none';
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
let treeSig = '';
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

  if (!$('pane-tree').hidden) renderTree(f.species);
}

function renderCard(card, sp, byId) {
  const t = sp.traits;
  const parent = sp.parent ? byId.get(sp.parent) : null;
  card.innerHTML = '';
  const h = el('h3');
  h.append(swatch(sp.hue), el('span', '', sp.name));
  card.append(h);
  card.append(el('p', '', `${sp.form} · appeared ${when(sp.born)}${parent ? ` from ${parent.name}` : ', seeded at the start'}. Lives over ${n0.format(sp.range)} km².`));
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
  card.append(dl);
}

function renderTree(all) {
  const sig = all.map((s) => `${s.id}:${s.died === null ? 1 : 0}`).join(',');
  if (sig === treeSig) return;
  treeSig = sig;
  const ids = new Set(all.map((s) => s.id));
  const kids = new Map();
  const roots = [];
  for (const s of all) {
    if (s.parent && ids.has(s.parent)) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    } else roots.push(s);
  }
  const build = (s) => {
    const li = el('li');
    const node = el('div', `node ${s.died === null ? 'alive' : 'dead'}`);
    node.append(swatch(s.hue), el('span', 'sp-name', s.name), el('span', 'sp-form', s.form),
      el('span', 'when', s.died === null ? `${when(s.born)} –` : `${when(s.born)} – ${when(s.died)}`));
    li.append(node);
    const ch = kids.get(s.id);
    if (ch) {
      const ul = el('ul');
      for (const c of ch) ul.append(build(c));
      li.append(ul);
    }
    return li;
  };
  const tree = $('tree');
  tree.innerHTML = '';
  for (const r of roots) tree.append(build(r));
}

function selectSpecies(id) {
  selectedId = id;
  worker.postMessage({ type: 'select', id });
  for (const b of document.querySelectorAll('#species-list button')) {
    b.setAttribute('aria-pressed', Number(b.dataset.id) === id ? 'true' : 'false');
  }
}

function showTab(name) {
  for (const t of ['river', 'life', 'tree']) {
    $(`tab-${t}`).setAttribute('aria-selected', t === name ? 'true' : 'false');
    $(`pane-${t}`).hidden = t !== name;
  }
  if (name === 'tree') { treeSig = ''; if (last) renderTree(last.species); }
}
for (const t of ['river', 'life', 'tree']) $(`tab-${t}`).addEventListener('click', () => showTab(t));

function setMode(mode) {
  renderer.mode = mode;
  $('mode-landscape').setAttribute('aria-pressed', mode === 'landscape' ? 'true' : 'false');
  $('mode-species').setAttribute('aria-pressed', mode === 'species' ? 'true' : 'false');
  if (last) draw(last);
}
$('mode-landscape').addEventListener('click', () => setMode('landscape'));
$('mode-species').addEventListener('click', () => setMode('species'));

// Tap the map: what lives here?
$('map-canvas').addEventListener('click', (e) => {
  if (!last) return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * last.W);
  const y = Math.floor(((e.clientY - r.top) / r.height) * last.H);
  if (x < 0 || y < 0 || x >= last.W || y >= last.H) return;
  inspectAt = y * last.W + x;
  worker.postMessage({ type: 'inspect', i: inspectAt });
  clearInterval(inspectTimer);
  inspectTimer = setInterval(() => { if (inspectAt >= 0) worker.postMessage({ type: 'inspect', i: inspectAt }); }, 1000);
});
$('inspect-close').addEventListener('click', () => {
  inspectAt = -1;
  clearInterval(inspectTimer);
  $('inspect').hidden = true;
});

function renderInspect(info) {
  if (!info || inspectAt < 0) return;
  $('inspect').hidden = false;
  const where = info.water === 'sea' ? 'Sea' : info.water === 'lake' ? 'Lake' : info.water === 'river' ? 'River' : 'Land';
  $('inspect-title').textContent = info.water === 'sea' ? `${where}, ${n0.format(-info.elevation)} m deep` : `${where}, ${n0.format(info.elevation)} m up`;
  const facts = $('inspect-facts');
  facts.innerHTML = '';
  const fact = (k, v) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); facts.append(d); };
  fact('Now', `${n1.format(info.temp)} °C`);
  fact('Year avg', `${n1.format(info.meanTemp)} °C`);
  if (info.water !== 'sea') fact('Flow', `${n1.format(info.flow / 3.156e7)} m³/s`);
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
  life: () => (last ? { stats: last.lifeStats, species: last.species } : null),
  saveNow: () => new Promise((resolve) => { pendingSave = resolve; requestSave('test'); }),
  select: (id) => selectSpecies(id),
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
