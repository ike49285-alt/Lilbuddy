// app.js — the page. Owns no simulation state; it renders whatever the worker
// last said and asks for the rest.

import { MapRenderer } from './render.js';
import { describe, provenance, formatYear, formatAge } from './legends.js';

const el = (id) => document.getElementById(id);

const dom = {
  map: el('map'), mapnote: el('mapnote'),
  seed: el('seed'), regen: el('regen'),
  year: el('year'), epoch: el('epoch'),
  polities: el('fig-polities'), pop: el('fig-pop'),
  settle: el('fig-settle'), rate: el('fig-rate'),
  powers: el('powers'), tiers: el('tiers'),
  events: el('fig-events'), dropped: el('fig-dropped'),
  merged: el('fig-merged'), keyframes: el('fig-keyframes'),
  play: el('play'), speed: el('speed'), live: el('live'),
  viewing: el('viewing'), scrub: el('scrub'),
  ticker: el('events'), tickerTitle: el('ticker-title'),
  detail: el('detail'), detailTitle: el('detail-title'),
  detailBody: el('detail-body'), detailClose: el('detail-close'),
  archiveHint: el('archive-hint'),
  search: el('search'), results: el('results'), resultsList: el('results-list'),
  mapview: el('mapview'), timeline: el('timeline'), tickerview: el('tickerview'),
  legends: el('legends'), legendsBack: el('legends-back'),
  legendsKind: el('legends-kind'), legendsName: el('legends-name'),
  legendsDates: el('legends-dates'), legendsLife: el('legends-life'),
  legendsRelated: el('legends-related'),
};

const KIND_LABEL = {
  p: 'state', n: 'person', d: 'house',
  s: 'settlement', c: 'culture', w: 'war',
};

let worker = null;
let renderer = null;
let tiers = [];
let latest = null;        // most recent live snapshot
let viewYear = null;      // null means "watching the present"
let running = true;
let seekPending = false;
let pendingKey = null;   // entity to open once the world has loaded
let pendingYear = null;  // year that entity link was made at

// ---------------------------------------------------------------------------
// worker plumbing
// ---------------------------------------------------------------------------

function start(seed, openKey = null, openYear = null) {
  if (worker) worker.terminate();
  latest = null;
  viewYear = null;
  renderer = null;
  pendingKey = openKey;
  pendingYear = openYear;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', onMessage);
  worker.postMessage({ type: 'init', seed });
  dom.seed.value = seed;
  const want = `#${encodeURIComponent(seed)}`
    + (openKey ? `/${openKey.replace(':', '/')}/${Math.round(openYear || 0)}` : '');
  if (location.hash !== want) history.replaceState(null, '', want);
}

function onMessage(event) {
  const msg = event.data;
  switch (msg.type) {
    case 'world': {
      tiers = msg.tiers;
      renderer = new MapRenderer(dom.map, msg.world);
      renderer.resize();
      renderMap(msg.snapshot.owners, msg.snapshot.settlements);
      applySnapshot(msg.snapshot);
      worker.postMessage({ type: 'run', speed: currentSpeed() });
      running = true;
      dom.play.textContent = 'pause';
      if (pendingKey) {
        const key = pendingKey;
        pendingKey = null;
        if (pendingYear) replayThenOpen(key, pendingYear);
        else openEntity(key, false);
      }
      break;
    }
    case 'frame':
      latest = msg.snapshot;
      if (viewYear === null) {
        renderMap(msg.snapshot.owners, msg.snapshot.settlements);
        renderEvents(msg.snapshot.year);
      }
      applySnapshot(msg.snapshot);
      break;

    case 'seeked':
      seekPending = false;
      showPast(msg);
      break;

    case 'events':
      paintEvents(msg.events, viewYear ?? (latest ? latest.year : 0));
      break;

    case 'cell':
      showCell(msg);
      break;

    case 'ranTo':
      if (pendingKey) { const k = pendingKey; pendingKey = null; openEntity(k, false); }
      break;

    case 'entity':
      showEntity(msg);
      break;

    case 'search':
      showResults(msg);
      break;

    case 'error':
      dom.mapnote.hidden = false;
      dom.mapnote.textContent = `The world stopped: ${msg.error}`;
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderMap(owners, settlements) {
  if (!renderer) return;
  renderer.setState({ owners, settlements });
  renderer.draw();
}

function applySnapshot(s) {
  // Archive figures always describe the record as it stands. The world figures
  // only describe the present, so while the past is on screen they are left to
  // showPast — otherwise the panel reads "year 201k, 51 states" above a legend
  // listing the states of year 177k.
  if (viewYear === null) {
    dom.year.textContent = formatYear(s.year);
    dom.epoch.textContent = s.epoch;
    dom.polities.textContent = s.politiesTotal;
    dom.pop.textContent = shortNumber(s.globalPop * 100000);
    dom.settle.textContent = s.settlements.length;
    dom.rate.textContent = s.rate ? `${shortNumber(s.rate)} yr/s` : '—';
  }

  dom.events.textContent = s.stats.events;
  dom.dropped.textContent = shortNumber(s.stats.dropped);
  dom.merged.textContent = shortNumber(s.stats.merged);
  dom.keyframes.textContent = s.stats.keyframes;

  paintTiers(s.stats.perTier);
  if (viewYear === null) paintPowers(s.polities, s.politiesTotal);
  if (viewYear === null) dom.scrub.value = String(dom.scrub.max);
}

function paintTiers(perTier) {
  if (!tiers.length) return;
  dom.tiers.replaceChildren(...tiers.map((tier, i) => {
    const li = document.createElement('li');
    const pct = Math.min(100, (perTier[i] / tier.budget) * 100);
    li.innerHTML = `
      <div class="row"><span class="label">${tier.label}</span>
      <span class="count">${perTier[i]} / ${tier.budget}</span></div>
      <div class="meter"><div class="fill" style="width:${pct}%"></div></div>`;
    return li;
  }));
}

function paintPowers(list, total) {
  const rows = list.slice(0, 12).map((p) => {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    const [r, g, b] = renderer.colorFor(p.id);
    swatch.style.background = `rgb(${r},${g},${b})`;
    const name = document.createElement('span');
    name.className = p.name ? 'nm' : 'nm forgotten';
    name.textContent = p.name || 'a state no one remembers';
    name.title = p.name || 'Its borders survive in a keyframe; its name does not.';
    // Only states the archive still has a record for can be opened; a forgotten
    // one has nothing behind the swatch.
    if (p.name) { li.dataset.key = `p:${p.id}`; li.style.cursor = 'pointer'; }
    const count = document.createElement('span');
    count.className = 'ct';
    count.textContent = p.cells;
    li.append(swatch, name, count);
    return li;
  });
  if (total > rows.length) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch"></span><span class="nm forgotten">and ${total - rows.length} lesser powers</span>`;
    rows.push(li);
  }
  dom.powers.replaceChildren(...rows);
}

function renderEvents(year) {
  if (!latest) return;
  const span = Math.max(20, Math.round(year * 0.002));
  worker.postMessage({ type: 'events', from: year - span, to: year, limit: 40 });
}

function paintEvents(events, atYear) {
  dom.ticker.replaceChildren(...events.map((ev) => {
    const li = document.createElement('li');
    if (ev.dist >= 2) li.className = 'hazy';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = formatYear(ev.t);
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = describe(ev);
    const prov = provenance(ev);
    if (prov) {
      const note = document.createElement('em');
      note.className = 'prov';
      note.textContent = prov;
      what.append(note);
    }
    li.append(when, what);
    return li;
  }));
  if (!events.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="when"></span><span class="what">Nothing from this stretch survives in the record.</span>';
    dom.ticker.replaceChildren(li);
  }
  dom.tickerTitle.textContent = tierNameFor(atYear);
}

function tierNameFor(atYear) {
  if (!latest) return 'The record';
  const age = latest.year - atYear;
  const tier = tiers.find((t) => age <= t.maxAge) || tiers[tiers.length - 1];
  return tier ? tier.label.charAt(0).toUpperCase() + tier.label.slice(1) : 'The record';
}

// The past as the archive can still render it: borders from the nearest
// keyframe, names only where the registry still has them.
function showPast(msg) {
  if (!renderer) return;
  renderer.setState({ owners: msg.owners, settlements: [] });
  renderer.draw();
  paintPowers(msg.polities, msg.polities.length);
  paintEvents(msg.events, msg.resolvedYear);

  // Borders are the only thing keyframes preserve. Population and town counts
  // for a given past year were never stored, so they are shown as absent rather
  // than filled in with today's numbers.
  dom.year.textContent = formatYear(msg.resolvedYear);
  dom.epoch.textContent = 'as the record has it';
  dom.polities.textContent = msg.polities.length;
  dom.pop.textContent = '—';
  dom.settle.textContent = '—';
  dom.rate.textContent = '—';

  const drift = msg.year - msg.resolvedYear;
  dom.viewing.textContent = `year ${formatYear(msg.resolvedYear)} · ${formatAge(latest.year - msg.resolvedYear)}`;
  dom.mapnote.hidden = false;
  dom.mapnote.textContent = drift > 0
    ? `Nearest surviving keyframe: year ${formatYear(msg.resolvedYear)}, ${formatYear(drift)} years off what you asked for. `
      + `At this depth the record keeps one map every ${formatYear(msg.resolution)} years.`
    : `Year ${formatYear(msg.resolvedYear)}. Towns are not drawn for the past — only borders are kept.`;
}

function backToNow() {
  viewYear = null;
  dom.mapnote.hidden = true;
  dom.viewing.textContent = 'watching the present';
  dom.scrub.value = String(dom.scrub.max);
  if (latest) {
    renderMap(latest.owners, latest.settlements);
    paintPowers(latest.polities, latest.politiesTotal);
    renderEvents(latest.year);
    applySnapshot(latest);
  }
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

// The slider is logarithmic in age, not linear in year: without that, the last
// two hundred years — the only stretch the archive still holds in detail —
// would occupy a fraction of a pixel on a million-year run.
function sliderToYear(value) {
  if (!latest) return 0;
  const s = value / Number(dom.scrub.max);
  const span = Math.max(1, latest.year);
  const age = Math.pow(span + 1, 1 - s) - 1;
  return Math.max(0, Math.round(latest.year - age));
}

function currentSpeed() {
  const v = dom.speed.value;
  return v === 'max' ? 'max' : Number(v);
}

dom.scrub.addEventListener('input', () => {
  if (!latest) return;
  const year = sliderToYear(Number(dom.scrub.value));
  if (year >= latest.year) { backToNow(); return; }
  viewYear = year;
  dom.viewing.textContent = `year ${formatYear(year)}`;
  if (!seekPending) {
    seekPending = true;
    worker.postMessage({ type: 'seek', year });
  }
});

dom.play.addEventListener('click', () => {
  running = !running;
  dom.play.textContent = running ? 'pause' : 'run';
  worker.postMessage(running ? { type: 'run', speed: currentSpeed() } : { type: 'pause' });
});

dom.speed.addEventListener('change', () => {
  worker.postMessage({ type: 'speed', speed: currentSpeed() });
});

dom.live.addEventListener('click', backToNow);

dom.regen.addEventListener('click', () => {
  const seed = dom.seed.value.trim() || randomSeed();
  start(seed);
});

dom.seed.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.regen.click();
});

dom.detailClose.addEventListener('click', () => { dom.detail.hidden = true; });

dom.map.addEventListener('click', (e) => {
  if (!renderer) return;
  const cell = renderer.cellAt(e.clientX, e.clientY);
  if (cell < 0) return;
  worker.postMessage({ type: 'cell', cell });
});

dom.map.addEventListener('mousemove', (e) => {
  if (!renderer) return;
  const cell = renderer.cellAt(e.clientX, e.clientY);
  if (cell !== renderer.highlight) {
    renderer.setState({ highlight: cell });
    renderer.draw();
  }
});

dom.map.addEventListener('mouseleave', () => {
  if (!renderer) return;
  renderer.setState({ highlight: -1 });
  renderer.draw();
});

function showCell(msg) {
  dom.detail.hidden = false;
  const s = msg.settlement;
  dom.detailTitle.textContent = s ? s.name : (msg.owner ? msg.owner.name : 'Unclaimed ground');

  const rows = [];
  if (msg.owner) rows.push(['held by', msg.owner.name]);
  if (msg.ruler) rows.push(['ruler', msg.ruler.epithet ? `${msg.ruler.name} ${msg.ruler.epithet}` : msg.ruler.name]);
  if (msg.owner && msg.owner.culture) rows.push(['culture', msg.owner.culture]);
  if (msg.owner && msg.owner.born !== undefined) rows.push(['founded', `year ${formatYear(msg.owner.born)}`]);
  if (s) rows.push(['settled', `year ${formatYear(s.founded)}`]);
  rows.push(['people', shortNumber(msg.pop * 100000)]);
  if (msg.unrest > 0.15) rows.push(['unrest', `${Math.round(msg.unrest * 100)}%`]);

  const dl = document.createElement('dl');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }

  const list = document.createElement('ul');
  list.className = 'mini';
  for (const ev of msg.history.slice(-8).reverse()) {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = formatYear(ev.t);
    li.append(when, document.createTextNode(describe(ev)));
    list.append(li);
  }

  dom.detailBody.replaceChildren(dl);
  if (msg.history.length) dom.detailBody.append(list);

  // Routes from the map into the record: whatever is here that has a page.
  const links = document.createElement('p');
  links.className = 'links';
  if (msg.owner) links.append(entityLink(`p:${msg.owner.id}`, { name: `read of ${msg.owner.name}` }));
  if (s) links.append(entityLink(`s:${s.id}`, { name: `read of ${s.name}` }));
  if (links.childElementCount) dom.detailBody.append(links);
}

// ---------------------------------------------------------------------------
// the legends browser
// ---------------------------------------------------------------------------

// The hash carries the seed and, optionally, the entity being read and the year
// to read it at:
//   #<seed>              the map
//   #<seed>/p/17/48200   that state's page, in a world replayed to year 48200
//
// The year is not decoration. Nothing is persisted between visits — a world is
// re-derived from its seed every time the page loads — so a link to an entity
// is only meaningful together with the point in time at which that entity
// existed. Seed plus tick count is the whole save file.
function writeHash(seed, key, year) {
  const suffix = key ? `/${key.replace(':', '/')}/${Math.round(year || 0)}` : '';
  const next = `#${encodeURIComponent(seed)}${suffix}`;
  if (location.hash !== next) history.pushState(null, '', next);
}

function readHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return { seed: null, key: null, year: null };
  const parts = raw.split('/');
  return {
    seed: parts[0] || null,
    key: parts.length >= 3 ? `${parts[1]}:${parts[2]}` : null,
    year: parts.length >= 4 ? Number(parts[3]) || 0 : null,
  };
}

function openEntity(key, push = true) {
  if (!worker) return;
  if (push) writeHash(dom.seed.value, key, latest ? latest.year : 0);
  worker.postMessage({ type: 'entity', key });
}

// Opening a shared link: replay the world to the year the link was made at,
// then show the page. Until then there is nothing to show, because that state
// has not been founded yet.
function replayThenOpen(key, year) {
  dom.legends.hidden = false;
  dom.mapview.hidden = true;
  dom.timeline.hidden = true;
  dom.tickerview.hidden = true;
  dom.legendsKind.textContent = 'replaying';
  dom.legendsName.textContent = 'Catching up…';
  dom.legendsDates.textContent =
    `Nothing is stored between visits. Re-running this world from its seed to year ${formatYear(year)}.`;
  dom.legendsLife.replaceChildren();
  dom.legendsRelated.replaceChildren();
  pendingKey = key;
  worker.postMessage({ type: 'pause' });
  worker.postMessage({ type: 'runTo', year });
}

function closeLegends(push = true) {
  dom.legends.hidden = true;
  dom.mapview.hidden = false;
  dom.timeline.hidden = false;
  dom.tickerview.hidden = false;
  if (push) writeHash(dom.seed.value, null);
  if (renderer) { renderer.resize(); renderer.draw(); }
}

function showEntity(msg) {
  dom.legends.hidden = false;
  dom.mapview.hidden = true;
  dom.timeline.hidden = true;
  dom.tickerview.hidden = true;
  dom.results.hidden = true;

  const rec = msg.record;
  const kind = msg.key.split(':')[0];
  dom.legendsKind.textContent = KIND_LABEL[kind] || 'entry';
  dom.legendsName.textContent = rec ? rec.name : 'Forgotten';

  // Everything an entity page can say comes from the same event log the map
  // reads. There is no separate biography store — a life is just the events
  // that still mention it.
  const bits = [];
  if (rec) {
    if (rec.epithet) bits.push(rec.epithet);
    const from = rec.born ?? rec.founded ?? rec.began;
    if (from !== undefined && from !== null) {
      bits.push(rec.died != null
        ? `${formatYear(from)} – ${formatYear(rec.died)}`
        : `from ${formatYear(from)}`);
    }
    if (rec.culture) bits.push(rec.culture);
    if (rec.dynasty) bits.push(`of the house of ${rec.dynasty}`);
    if (rec.peak) bits.push(`held ${rec.peak} regions at its height`);
    bits.push(msg.alive ? 'still standing' : 'gone from the world');
  }
  dom.legendsDates.innerHTML = rec
    ? bits.join(' · ')
    : '<span class="gone">The record no longer holds anything under this name.</span>';

  const life = msg.events.map((ev) => {
    const li = document.createElement('li');
    if (ev.dist >= 2) li.className = 'hazy';
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `year ${formatYear(ev.t)} · ${formatAge(msg.now - ev.t)}`;
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = describe(ev);
    const prov = provenance(ev);
    if (prov) {
      const note = document.createElement('em');
      note.className = 'prov';
      note.textContent = prov;
      what.append(note);
    }
    li.append(when, what);

    const others = ev.refs.filter((r) => r !== msg.key && msg.related[r]);
    if (others.length) {
      const links = document.createElement('span');
      links.className = 'links';
      for (const ref of others) links.append(entityLink(ref, msg.related[ref]));
      li.append(links);
    }
    return li;
  });

  if (life.length) {
    dom.legendsLife.replaceChildren(...life);
  } else {
    const p = document.createElement('p');
    p.className = 'nothing';
    p.textContent = 'Nothing about it survives in the record.';
    dom.legendsLife.replaceChildren(p);
  }

  // Long-lived states accumulate hundreds of connections; the sidebar shows a
  // readable slice and says how many more there are.
  const allRelated = Object.keys(msg.related);
  const relatedKeys = allRelated.slice(0, 24);
  dom.legendsRelated.replaceChildren(...relatedKeys.map((ref) => {
    const li = document.createElement('li');
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = KIND_LABEL[ref.split(':')[0]] || '';
    li.append(k, entityLink(ref, msg.related[ref]));
    return li;
  }));
  if (!relatedKeys.length) {
    const li = document.createElement('li');
    li.className = 'nothing';
    li.textContent = 'No one else appears beside it.';
    dom.legendsRelated.replaceChildren(li);
  } else if (allRelated.length > relatedKeys.length) {
    const li = document.createElement('li');
    li.className = 'nothing';
    li.textContent = `and ${allRelated.length - relatedKeys.length} more`;
    dom.legendsRelated.append(li);
  }
  window.scrollTo(0, 0);
}

function entityLink(key, record) {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (record) {
    btn.textContent = record.name;
  } else {
    // The event kept a reference to something the registry has already swept.
    btn.textContent = 'someone forgotten';
    btn.className = 'gone';
    btn.disabled = true;
    return btn;
  }
  btn.addEventListener('click', () => openEntity(key));
  return btn;
}

function showResults(msg) {
  dom.results.hidden = false;
  if (!msg.results.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `Nothing in the record answers to "${msg.query}".`;
    dom.resultsList.replaceChildren(li);
    return;
  }
  dom.resultsList.replaceChildren(...msg.results.map((r) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = KIND_LABEL[r.kind] || r.kind;
    btn.append(k, document.createTextNode(r.name));
    btn.addEventListener('click', () => {
      dom.results.hidden = true;
      dom.search.value = '';
      openEntity(r.key);
    });
    li.append(btn);
    return li;
  }));
}

let searchTimer = null;
dom.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = dom.search.value.trim();
  if (query.length < 2) { dom.results.hidden = true; return; }
  searchTimer = setTimeout(() => worker.postMessage({ type: 'search', query }), 180);
});

dom.legendsBack.addEventListener('click', () => closeLegends());

window.addEventListener('popstate', () => {
  const { seed, key } = readHash();
  const { year } = readHash();
  if (seed && seed !== dom.seed.value) { start(seed, key, year); return; }
  if (key) openEntity(key, false);
  else closeLegends(false);
});

// Any state named in the legend opens its page.
dom.powers.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li || !li.dataset.key) return;
  openEntity(li.dataset.key);
});

// ---------------------------------------------------------------------------

function shortNumber(v) {
  const n = Math.round(v);
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  if (n < 1000000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${(n / 1000000000).toFixed(1)}B`;
}

function randomSeed() {
  const words = ['ash', 'kel', 'moro', 'vast', 'tern', 'oro', 'hail', 'dun', 'seln', 'brack'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 900 + 100)}`;
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!renderer) return;
    renderer.resize();
    renderer.draw();
  }, 120);
});

// Exposed for the test harness — invariant checks without a test framework.
const ask = (request, replyType) => new Promise((resolve) => {
  const handler = (e) => {
    if (e.data.type !== replyType) return;
    worker.removeEventListener('message', handler);
    resolve(e.data);
  };
  worker.addEventListener('message', handler);
  worker.postMessage(request);
});

window.Chronicle = {
  selftest: () => ask({ type: 'selftest' }, 'selftest'),
  runTo: (year) => ask({ type: 'runTo', year }, 'ranTo'),
  digest: () => ask({ type: 'digest' }, 'digest'),
  state: () => latest,
  setSpeed: (v) => { dom.speed.value = String(v); worker.postMessage({ type: 'speed', speed: v }); },
  pause: () => worker.postMessage({ type: 'pause' }),
  resume: () => worker.postMessage({ type: 'run', speed: currentSpeed() }),
};

const route = readHash();
start(route.seed || randomSeed(), route.key, route.year);
