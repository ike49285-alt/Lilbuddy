// app.js — the page. Owns no simulation state; it renders whatever the worker
// last said and asks for the rest.
//
// Everything that isn't the map or the record opens in one bottom sheet: a
// region, an event's analysis, an entity's page, the settings. One component,
// one dismissal gesture, and each opening pushes a history entry so the phone's
// back gesture closes it instead of leaving the page.

import { MapRenderer, ClimateStrip, yearAtFraction, fractionAtYear } from './render.js';
import { CLIMATE_PERIOD } from './sim.js';
import { describe, provenance, formatYear, formatAge } from './legends.js';

const el = (id) => document.getElementById(id);

const dom = {
  map: el('map'), mapnote: el('mapnote'),
  year: el('year'), epoch: el('epoch'),
  polities: el('fig-polities'), pop: el('fig-pop'),
  settle: el('fig-settle'), rate: el('fig-rate'),
  powers: el('powers'), tiers: el('tiers'),
  events: el('fig-events'), dropped: el('fig-dropped'),
  merged: el('fig-merged'), keyframes: el('fig-keyframes'),
  play: el('play'), speed: el('speed'), live: el('live'),
  viewing: el('viewing'), scrub: el('scrub'),
  feed: el('events'), tickerTitle: el('ticker-title'),
  clearFilter: el('clear-filter'),
  openSettings: el('open-settings'),
  scrim: el('scrim'), sheet: el('sheet'),
  sheetBody: el('sheet-body'), sheetClose: el('sheet-close'),
  sheetHandle: el('sheet-handle'),
  zoomIn: el('zoom-in'), zoomOut: el('zoom-out'), zoomReset: el('zoom-reset'),
  layerUnrest: el('layer-unrest'),
  mapwrap: el('mapwrap'), winterBadge: el('winter-badge'),
  climateStrip: el('climate-strip'),
};

const KIND_LABEL = {
  p: 'state', n: 'person', d: 'house',
  s: 'settlement', c: 'culture', w: 'war',
};

let worker = null;
let renderer = null;
let climateStrip = null;
let lastMarkersFetch = 0; // performance.now() of the last 'markers' request
let tiers = [];
let latest = null;        // most recent live snapshot
let viewYear = null;      // null means "watching the present"
let running = true;
let seekPending = false;
let pendingKey = null;
let pendingYear = null;
let currentSeed = '';
let tierFilter = null;    // index of the archive tier the record is pinned to
let lastEvents = [];
let showUnrest = false;   // the map overlay toggle; persists across a new world/load
let lastAutoSave = 0;     // performance.now() of the last continue-slot write

// ---------------------------------------------------------------------------
// saved worlds
//
// The save file is a seed and a year — nothing else. That is the whole point
// of the archive being a pure function of the seed: "load" means "replay from
// scratch to this year," the same path a shared entity link already takes.
// ---------------------------------------------------------------------------

const SAVES_KEY = 'chronicle:saves:v1';
const MAX_SAVES = 30;

function loadSaveData() {
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    return raw ? JSON.parse(raw) : { saves: [], continueSlot: null };
  } catch {
    // Private browsing, quota, or a disabled store — saves just don't
    // persist. Nothing here should ever throw the app over it.
    return { saves: [], continueSlot: null };
  }
}

function writeSaveData(data) {
  try { localStorage.setItem(SAVES_KEY, JSON.stringify(data)); } catch { /* see above */ }
}

function saveCurrentWorld(label) {
  if (!latest) return null;
  const data = loadSaveData();
  const entry = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    seed: currentSeed, year: latest.year, label: label || defaultSaveLabel(),
    savedAt: Date.now(), epoch: latest.epoch, politiesTotal: latest.politiesTotal,
  };
  data.saves.unshift(entry);
  if (data.saves.length > MAX_SAVES) data.saves.length = MAX_SAVES;
  writeSaveData(data);
  return entry;
}

function deleteSave(id) {
  const data = loadSaveData();
  data.saves = data.saves.filter((s) => s.id !== id);
  writeSaveData(data);
}

function loadSave(entry) {
  sheetStack.length = 0;
  hideSheet();
  start(entry.seed, null, entry.year);
}

function defaultSaveLabel() {
  return latest ? `${latest.epoch}, year ${formatYear(latest.year)}` : 'this world';
}

// Updated while watching live play, throttled so it isn't a write on every
// frame. Never written while scrubbing a past year — the continue slot is a
// bookmark of where you left off, not of wherever the scrubber happens to be.
function maybeAutoSave(snapshot) {
  if (viewYear !== null || !currentSeed) return;
  const now = performance.now();
  if (now - lastAutoSave < 10000) return;
  lastAutoSave = now;
  const data = loadSaveData();
  data.continueSlot = { seed: currentSeed, year: snapshot.year, savedAt: Date.now() };
  writeSaveData(data);
}

function flushAutoSave() {
  if (!latest || viewYear !== null || !currentSeed) return;
  const data = loadSaveData();
  data.continueSlot = { seed: currentSeed, year: latest.year, savedAt: Date.now() };
  writeSaveData(data);
}

window.addEventListener('pagehide', flushAutoSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAutoSave();
});

// ---------------------------------------------------------------------------
// worker plumbing
// ---------------------------------------------------------------------------

function start(seed, openKey = null, openYear = null) {
  if (worker) worker.terminate();
  latest = null;
  viewYear = null;
  renderer = null;
  climateStrip = null;
  tierFilter = null;
  sheetStack.length = 0;
  hideSheet();
  setWinterActive(false);
  currentSeed = seed;
  pendingKey = openKey;
  pendingYear = openYear;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', onMessage);
  worker.postMessage({ type: 'init', seed });
  // The overlay toggle is a page-level preference that outlives any one
  // world — a fresh worker doesn't know it was on until told.
  if (showUnrest) worker.postMessage({ type: 'overlay', unrest: true });
  const want = hashFor(seed, openKey, openYear);
  if (location.hash !== want) history.replaceState(null, '', want);
}

function onMessage(event) {
  const msg = event.data;
  switch (msg.type) {
    case 'world': {
      tiers = msg.tiers;
      renderer = new MapRenderer(dom.map, msg.world);
      renderer.resize();
      climateStrip = new ClimateStrip(dom.climateStrip);
      climateStrip.resize();
      renderMap(msg.snapshot.owners, msg.snapshot.settlements);
      applySnapshot(msg.snapshot);
      lastMarkersFetch = performance.now();
      worker.postMessage({ type: 'markers' });
      worker.postMessage({ type: 'run', speed: currentSpeed() });
      running = true;
      dom.play.textContent = 'Pause';
      if (pendingYear) {
        const y = pendingYear;
        const key = pendingKey;
        pendingYear = null;
        pendingKey = null;
        replayTo(y, key);
      } else if (pendingKey) {
        const key = pendingKey;
        pendingKey = null;
        openEntity(key);
      }
      break;
    }
    case 'frame':
      latest = msg.snapshot;
      if (viewYear === null) {
        renderMap(msg.snapshot.owners, msg.snapshot.settlements, msg.snapshot.unrest);
        requestEvents(msg.snapshot.year);
        setWinterActive(msg.snapshot.winterYears > 0);
      }
      applySnapshot(msg.snapshot);
      maybeAutoSave(msg.snapshot);
      // Epoch/cataclysm markers change rarely; a throttled poll is plenty and
      // beats re-scanning the whole event log every frame for no reason.
      if (performance.now() - lastMarkersFetch > 5000) {
        lastMarkersFetch = performance.now();
        worker.postMessage({ type: 'markers' });
      }
      break;

    case 'seeked':
      seekPending = false;
      showPast(msg);
      break;

    case 'events':
      lastEvents = msg.events;
      paintFeed(msg.events, viewYear ?? (latest ? latest.year : 0));
      break;

    case 'cell':
      showSheet({ kind: 'cell', payload: msg });
      break;

    case 'analysis':
      showSheet({ kind: 'analysis', payload: msg });
      break;

    case 'entity':
      // Wherever the thing still is, tapping into it is also the "take me
      // there" gesture — a search result, a power in the list, a name inside
      // someone else's page, they all resolve through here.
      if (renderer && msg.cell != null) {
        renderer.centerOnCell(msg.cell);
        renderer.draw();
        updateZoomUI();
      }
      showSheet({
        kind: 'entity', payload: msg,
        hash: `#${encodeURIComponent(currentSeed)}/${msg.key.replace(':', '/')}`
          + `/${Math.round(latest ? latest.year : 0)}`,
      });
      break;

    case 'ranTo': {
      // worker.js's runTo pauses the sim to tick synchronously and never
      // resumes it — every replay used to land the world silently paused
      // while the Pause/Run button kept claiming otherwise. Resuming here is
      // the fix, for every caller of replayTo alike.
      dom.mapnote.hidden = true;
      running = true;
      dom.play.textContent = 'Pause';
      worker.postMessage({ type: 'run', speed: currentSpeed() });
      if (pendingKey) { const k = pendingKey; pendingKey = null; openEntity(k); }
      break;
    }

    case 'search':
      renderSearchResults(msg);
      break;

    case 'markers':
      if (climateStrip) {
        climateStrip.setMarkers(msg.markers);
        if (latest) climateStrip.draw(latest.year, CLIMATE_PERIOD);
      }
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
// map and panels
// ---------------------------------------------------------------------------

function renderMap(owners, settlements, unrest) {
  if (!renderer) return;
  renderer.setState({ owners, settlements, unrest });
  renderer.draw();
}

// A global cold shock is a CSS filter on the canvas itself, not a pixel-loop
// concern — cheapest that way, and it never touches the flat-cost budget.
// Archived keyframes never kept whether a winter was in effect, so like
// unrest it only ever shows for the live present.
function setWinterActive(active) {
  dom.mapwrap.classList.toggle('winter', active);
  dom.winterBadge.hidden = !active;
}

function applySnapshot(s) {
  if (viewYear === null) {
    dom.year.textContent = formatYear(s.year);
    dom.epoch.textContent = s.epoch;
    dom.polities.textContent = s.politiesTotal;
    dom.pop.textContent = shortNumber(s.globalPop * 100000);
    dom.settle.textContent = s.settlements.length;
    dom.rate.textContent = s.rate ? `${formatRate(s.rate)} yr/s` : '—';
  }

  dom.events.textContent = s.stats.events;
  dom.dropped.textContent = shortNumber(s.stats.dropped);
  dom.merged.textContent = shortNumber(s.stats.merged);
  dom.keyframes.textContent = s.stats.keyframes;

  paintTiers(s.stats.perTier);
  if (viewYear === null) {
    paintPowers(s.polities, s.politiesTotal);
    dom.scrub.value = String(dom.scrub.max);
  }
  // Keyed on the live edge, not on whatever year is currently being viewed —
  // scrubbing through the past pans within the strip's existing span rather
  // than rescaling it, the same way the scrub track's own mapping works.
  if (climateStrip) climateStrip.draw(s.year, CLIMATE_PERIOD);
}

function paintTiers(perTier) {
  if (!tiers.length) return;
  dom.tiers.replaceChildren(...tiers.map((tier, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rowbtn';
    btn.setAttribute('aria-pressed', String(tierFilter === i));
    const pct = Math.min(100, (perTier[i] / tier.budget) * 100);
    const wrap = document.createElement('span');
    wrap.innerHTML = `
      <span class="row"><span class="label"></span><span class="count"></span></span>
      <span class="meter"><span class="fill" style="width:${pct}%"></span></span>`;
    wrap.querySelector('.label').textContent = tier.label;
    wrap.querySelector('.count').textContent = `${perTier[i]} / ${tier.budget}`;
    btn.append(wrap);
    btn.addEventListener('click', () => setTierFilter(tierFilter === i ? null : i));
    li.append(btn);
    return li;
  }));
}

function paintPowers(list, total) {
  const rows = list.slice(0, 12).map((p) => {
    const li = document.createElement('li');
    const [r, g, b] = renderer.colorFor(p.id);
    if (!p.name) {
      li.className = 'static';
      li.textContent = `a state no one remembers · ${p.cells}`;
      return li;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rowbtn';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = `rgb(${r},${g},${b})`;
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = p.name;
    const count = document.createElement('span');
    count.className = 'ct';
    count.textContent = p.cells;
    btn.append(swatch, name, count);
    btn.addEventListener('click', () => openEntity(`p:${p.id}`));
    li.append(btn);
    return li;
  });
  if (total > rows.length) {
    const li = document.createElement('li');
    li.className = 'static';
    li.textContent = `and ${total - rows.length} lesser powers`;
    rows.push(li);
  }
  dom.powers.replaceChildren(...rows);
}

function requestEvents(year) {
  if (!latest) return;
  if (tierFilter !== null) {
    // Pinned to one tier: ask for the whole span that tier covers, and let the
    // filter below keep only what actually still lives there.
    const tier = tiers[tierFilter];
    const from = tier.maxAge === null || !isFinite(tier.maxAge) ? 0 : latest.year - tier.maxAge;
    worker.postMessage({ type: 'events', from: Math.max(0, from), to: latest.year, limit: 200 });
    return;
  }
  const span = Math.max(20, Math.round(year * 0.002));
  worker.postMessage({ type: 'events', from: year - span, to: year, limit: 40 });
}

function tierIndexFor(age) {
  for (let i = 0; i < tiers.length; i++) if (age <= tiers[i].maxAge) return i;
  return tiers.length - 1;
}

function setTierFilter(index) {
  tierFilter = index;
  dom.clearFilter.hidden = index === null;
  if (latest) requestEvents(latest.year);
  paintTiers(latest ? latest.stats.perTier : tiers.map(() => 0));
}

function paintFeed(events, atYear) {
  const now = latest ? latest.year : atYear;
  const shown = tierFilter === null
    ? events
    : events.filter((ev) => tierIndexFor(now - ev.t) === tierFilter);

  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = tierFilter !== null
      ? `Nothing survives at this depth yet.`
      : 'Nothing from this stretch survives in the record.';
    dom.feed.replaceChildren(li);
  } else {
    dom.feed.replaceChildren(...shown.map((ev) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = ev.dist >= 2 ? 'rowbtn hazy' : 'rowbtn';
      const text = document.createElement('span');
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = `year ${formatYear(ev.t)}`;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = describe(ev);
      text.append(when, what);
      const prov = provenance(ev);
      if (prov) {
        const note = document.createElement('em');
        note.className = 'prov';
        note.textContent = prov;
        text.append(note);
      }
      btn.append(text);
      btn.addEventListener('click', () => openAnalysis(ev.id));
      li.append(btn);
      return li;
    }));
  }

  dom.tickerTitle.textContent = tierFilter !== null
    ? sentenceCase(tiers[tierFilter].label)
    : sentenceCase(tiers[tierIndexFor(now - atYear)]?.label || 'the record');
}

// The past as the archive can still render it.
function showPast(msg) {
  if (!renderer) return;
  // Keyframes only ever kept borders — there is no archived unrest to show,
  // so the overlay goes quiet rather than painting stale live data over an
  // old map.
  renderer.setState({ owners: msg.owners, settlements: [], unrest: null });
  renderer.draw();
  setWinterActive(false);
  paintPowers(msg.polities, msg.polities.length);
  lastEvents = msg.events;
  paintFeed(msg.events, msg.resolvedYear);

  const drift = msg.year - msg.resolvedYear;
  dom.viewing.textContent = `year ${formatYear(msg.resolvedYear)} · ${formatAge(latest.year - msg.resolvedYear)}`;
  dom.mapnote.hidden = false;
  dom.mapnote.textContent = drift > 0
    ? `Nearest surviving keyframe: year ${formatYear(msg.resolvedYear)}, ${formatYear(drift)} years off. `
      + `At this depth the record keeps one map every ${formatYear(msg.resolution)} years.`
    : `Year ${formatYear(msg.resolvedYear)}. Only borders are kept for the past.`;

  // Borders are the only thing keyframes preserve.
  dom.year.textContent = formatYear(msg.resolvedYear);
  dom.epoch.textContent = 'as the record has it';
  dom.polities.textContent = msg.polities.length;
  dom.pop.textContent = '—';
  dom.settle.textContent = '—';
  dom.rate.textContent = '—';
}

function backToNow() {
  viewYear = null;
  dom.mapnote.hidden = true;
  dom.viewing.textContent = 'watching the present';
  dom.scrub.value = String(dom.scrub.max);
  if (latest) {
    renderMap(latest.owners, latest.settlements, latest.unrest);
    paintPowers(latest.polities, latest.politiesTotal);
    requestEvents(latest.year);
    applySnapshot(latest);
    setWinterActive(latest.winterYears > 0);
  }
}

// ---------------------------------------------------------------------------
// the sheet
// ---------------------------------------------------------------------------

const sheetStack = [];

function showSheet(entry, push = true) {
  if (push) {
    sheetStack.push(entry);
    const url = entry.hash || location.href;
    history.pushState({ sheetDepth: sheetStack.length }, '', url);
  }
  renderSheet(entry);
  dom.sheet.hidden = false;
  dom.scrim.hidden = false;
  // A frame's delay so the transition has a start state to move from.
  requestAnimationFrame(() => {
    dom.sheet.classList.add('open');
    dom.scrim.classList.add('open');
  });
  dom.sheetBody.scrollTop = 0;
}

function hideSheet() {
  dom.sheet.classList.remove('open');
  dom.scrim.classList.remove('open');
  dom.sheet.style.transform = '';
  if (renderer && renderer.focus) {
    renderer.setState({ focus: null });
    renderer.draw();
  }
  const done = () => { dom.sheet.hidden = true; dom.scrim.hidden = true; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
  else setTimeout(done, 240);
}

// Back closes the sheet, and closes one level at a time through a chain of
// them — tapping from a war to one of its belligerents and back should land
// on the war, not on the map.
function closeSheet() {
  if (sheetStack.length) history.back();
  else hideSheet();
}

function renderSheet(entry) {
  switch (entry.kind) {
    case 'analysis': renderAnalysis(entry.payload); break;
    case 'entity': renderEntity(entry.payload); break;
    case 'cell': renderCell(entry.payload); break;
    case 'settings': renderSettings(); break;
    default: dom.sheetBody.replaceChildren();
  }
}

window.addEventListener('popstate', () => {
  const { seed, key, year } = readHash();
  if (seed && seed !== currentSeed) { start(seed, key, year); return; }

  const depth = (history.state && history.state.sheetDepth) || 0;
  if (depth === 0) { sheetStack.length = 0; hideSheet(); return; }
  sheetStack.length = Math.min(sheetStack.length, depth);
  const top = sheetStack[sheetStack.length - 1];
  if (top) showSheet(top, false);
  else hideSheet();
});

dom.sheetClose.addEventListener('click', closeSheet);
dom.scrim.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dom.sheet.hidden) closeSheet();
});

// Drag the handle down to dismiss. Pointer events cover touch and mouse alike;
// `touch-action: none` on the handle keeps the gesture from scrolling instead.
let dragFrom = null;
dom.sheetHandle.addEventListener('pointerdown', (e) => {
  dragFrom = e.clientY;
  dom.sheet.classList.add('dragging');
  dom.sheetHandle.setPointerCapture(e.pointerId);
});
dom.sheetHandle.addEventListener('pointermove', (e) => {
  if (dragFrom === null) return;
  const dy = Math.max(0, e.clientY - dragFrom);
  dom.sheet.style.transform = `translateY(${dy}px)`;
});
const endDrag = (e) => {
  if (dragFrom === null) return;
  const dy = Math.max(0, e.clientY - dragFrom);
  dragFrom = null;
  dom.sheet.classList.remove('dragging');
  dom.sheet.style.transform = '';
  if (dy > 90) closeSheet();
};
dom.sheetHandle.addEventListener('pointerup', endDrag);
dom.sheetHandle.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------------------
// sheet contents
// ---------------------------------------------------------------------------

function sheetHeader(kicker, title, dek) {
  const frag = document.createDocumentFragment();
  const k = document.createElement('p');
  k.className = 'sheet-kicker';
  k.textContent = kicker;
  const h = document.createElement('h2');
  h.id = 'sheet-title';
  h.textContent = title;
  frag.append(k, h);
  if (dek) {
    const d = document.createElement('p');
    d.className = 'dek';
    d.textContent = dek;
    frag.append(d);
  }
  return frag;
}

function heading(text) {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

function openAnalysis(eventId) {
  worker.postMessage({ type: 'analysis', eventId });
}

function renderAnalysis(msg) {
  const body = dom.sheetBody;
  if (msg.missing) {
    body.replaceChildren(sheetHeader('gone', 'Forgotten',
      'The record dropped this while you were reading it.'));
    return;
  }

  const parts = [];
  const ev = msg.event;

  if (msg.war) {
    const w = msg.war;
    parts.push(sheetHeader('war', w.name,
      w.causeLabel ? `Fought over ${w.causeLabel}.` : null));

    // Belligerents, each carrying its colour from the map.
    const sides = document.createElement('ul');
    sides.className = 'belligerents';
    for (const side of w.sides) {
      const li = document.createElement('li');
      li.className = 'belligerent';
      if (w.victor && side.name === w.victor) li.classList.add('victor');
      const bar = document.createElement('span');
      bar.className = 'bar';
      if (side.id !== undefined && renderer) {
        const [r, g, b] = renderer.colorFor(side.id);
        bar.style.background = `rgb(${r},${g},${b})`;
      }
      const text = document.createElement('span');
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = side.name || 'a state no one remembers';
      const meta = document.createElement('span');
      meta.className = 'meta';
      const bits = [];
      if (side.ruler) bits.push(`under ${side.ruler}`);
      if (side.house) bits.push(`house of ${side.house}`);
      if (side.alive === false) bits.push('since fallen');
      meta.textContent = bits.join(' · ') || 'nothing else is known';
      text.append(nm, meta);
      li.append(bar, text);
      if (side.name) {
        li.style.cursor = 'pointer';
        li.addEventListener('click', () => openEntity(side.key));
      }
      sides.append(li);
    }
    parts.push(sides);

    // Light the belligerents on the map behind the sheet.
    if (renderer) {
      const ids = w.sides.map((s) => s.id).filter((i) => i !== undefined);
      renderer.setState({ focus: ids });
      renderer.draw();
    }

    const tally = document.createElement('dl');
    tally.className = 'tally';
    const rows = [
      ['Years', w.years != null ? formatYear(w.years) : '—'],
      ['Dead', w.dead != null ? shortNumber(w.dead) : '—'],
      ['Cities sacked', w.sacks != null ? String(w.sacks) : '—'],
      ['Regions taken', w.taken ? String(w.taken[0] + w.taken[1]) : '—'],
    ];
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      div.append(dt, dd);
      tally.append(div);
    }
    parts.push(heading('What it cost'), tally);

    const outcome = document.createElement('p');
    outcome.className = 'dek';
    outcome.textContent = w.ongoing
      ? 'Still being fought.'
      : w.stalemate
        ? `Burned out after ${formatYear(w.years)} years with the border unmoved.`
        : `${w.victor} prevailed over ${w.defeated}.`;
    parts.push(heading('How it ended'), outcome);
  } else {
    const rec = msg.subjectRecord;
    const kind = msg.subject ? msg.subject.split(':')[0] : null;
    parts.push(sheetHeader(
      kind ? KIND_LABEL[kind] || 'entry' : 'the record',
      rec ? rec.name : describe(ev),
      rec ? describe(ev) : null,
    ));
  }

  // The course of it — every surviving event that belongs to this subject.
  if (msg.contained.length) {
    const course = document.createElement('ol');
    course.className = 'course';
    for (const item of msg.contained) {
      const li = document.createElement('li');
      if (item.dist >= 2) li.className = 'hazy';
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = `year ${formatYear(item.t)}`;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = describe(item);
      li.append(when, what);
      course.append(li);
    }
    parts.push(heading(msg.war ? 'The course of it' : 'What the record holds'), course);
  }

  const links = relatedLinks(msg.related, msg.subject);
  if (links) parts.push(heading('Named alongside'), links);

  parts.push(attestation(msg.provenance));
  body.replaceChildren(...parts);
}

// What the archive can still vouch for. This is the point of tapping in: the
// deeper the event has fallen, the less of it is left, and the sheet should say
// so rather than presenting a merged composite as a report.
function attestation(prov) {
  const box = document.createElement('div');
  box.className = 'attest';
  const lead = document.createElement('p');
  lead.style.margin = '0';
  lead.innerHTML = `Held in <strong></strong>, ${formatAge(prov.age)}.`;
  lead.querySelector('strong').textContent = prov.tierLabel;
  box.append(lead);

  const notes = [];
  if (prov.merged > 1) notes.push(`${prov.merged} separate accounts have been run together into this one.`);
  if (prov.causeApocryphal) notes.push('The cause given is not attested — the real one is gone.');
  if (prov.attributionDrifted) notes.push('Who did what has drifted between the parties.');
  if (prov.inverted) notes.push('Sources disagree on the outcome, and no copy of the truth was kept.');
  if (prov.dist && !notes.length) notes.push('Retold enough times that the details have moved.');
  if (notes.length) {
    const ul = document.createElement('ul');
    for (const note of notes) {
      const li = document.createElement('li');
      li.textContent = note;
      ul.append(li);
    }
    box.append(ul);
  } else {
    const p = document.createElement('p');
    p.style.margin = '7px 0 0';
    p.textContent = 'Still recorded as it happened.';
    box.append(p);
  }
  return box;
}

function relatedLinks(related, exclude) {
  const keys = Object.keys(related || {}).filter((k) => k !== exclude).slice(0, 20);
  if (!keys.length) return null;
  const ul = document.createElement('ul');
  ul.className = 'linkrow';
  for (const key of keys) {
    const li = document.createElement('li');
    const rec = related[key];
    const btn = document.createElement('button');
    btn.type = 'button';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = KIND_LABEL[key.split(':')[0]] || '';
    if (rec) {
      btn.append(k, document.createTextNode(rec.name));
      btn.addEventListener('click', () => openEntity(key));
    } else {
      btn.append(k, document.createTextNode('forgotten'));
      btn.disabled = true;
    }
    li.append(btn);
    ul.append(li);
  }
  return ul;
}

function openEntity(key) {
  if (!worker) return;
  worker.postMessage({ type: 'entity', key });
}

// Every deep link — an entity link, a loaded save, the continue slot — lands
// here. Nothing is stored between visits beyond the seed and a year: the
// world is re-derived by ticking from scratch, which is what makes deleting
// deep history safe in the first place. `thenKey` is optional; give it to
// land on an entity's page afterward, omit it to just land on the map.
function replayTo(year, thenKey = null) {
  dom.mapnote.hidden = false;
  dom.mapnote.textContent =
    `Nothing is stored between visits. Re-running this world from its seed to year ${formatYear(year)}…`;
  pendingKey = thenKey;
  worker.postMessage({ type: 'pause' });
  worker.postMessage({ type: 'runTo', year });
}

function renderEntity(msg) {
  const rec = msg.record;
  const kind = msg.key.split(':')[0];
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
    if (rec.house) bits.push(`house of ${rec.house}`);
    if (rec.great) bits.push('a great house');
    if (rec.rulers) bits.push(`${rec.rulers} rulers`);
    if (rec.peak) bits.push(`${rec.peak} regions at its height`);
    bits.push(msg.alive ? 'still standing' : 'gone from the world');
  }

  const parts = [sheetHeader(
    KIND_LABEL[kind] || 'entry',
    rec ? rec.name : 'Forgotten',
    rec ? bits.join(' · ') : 'The record no longer holds anything under this name.',
  )];

  if (msg.events.length) {
    const course = document.createElement('ol');
    course.className = 'course';
    for (const ev of msg.events) {
      const li = document.createElement('li');
      if (ev.dist >= 2) li.className = 'hazy';
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = `year ${formatYear(ev.t)} · ${formatAge(msg.now - ev.t)}`;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = describe(ev);
      li.append(when, what);
      course.append(li);
    }
    parts.push(heading('What the record holds'), course);
  } else {
    const p = document.createElement('p');
    p.className = 'nothing';
    p.textContent = 'Nothing about it survives in the record.';
    parts.push(p);
  }

  const links = relatedLinks(msg.related, msg.key);
  if (links) parts.push(heading('Named alongside'), links);
  dom.sheetBody.replaceChildren(...parts);
}

function renderCell(msg) {
  const s = msg.settlement;
  const parts = [sheetHeader(
    s ? 'settlement' : msg.owner ? 'region' : 'unclaimed',
    s ? s.name : (msg.owner ? msg.owner.name : 'Unclaimed ground'),
    msg.owner && s ? `Held by ${msg.owner.name}.` : null,
  )];

  const tally = document.createElement('dl');
  tally.className = 'tally';
  const rows = [['People', shortNumber(msg.pop * 100000)]];
  if (msg.ruler) rows.push(['Ruler', msg.ruler.epithet ? `${msg.ruler.name} ${msg.ruler.epithet}` : msg.ruler.name]);
  if (msg.owner && msg.owner.culture) rows.push(['Culture', msg.owner.culture]);
  if (s) rows.push(['Settled', `year ${formatYear(s.founded)}`]);
  if (msg.unrest > 0.15) rows.push(['Unrest', `${Math.round(msg.unrest * 100)}%`]);
  for (const [k, v] of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dd.style.fontSize = '14px';
    div.append(dt, dd);
    tally.append(div);
  }
  parts.push(tally);

  if (msg.history.length) {
    const course = document.createElement('ol');
    course.className = 'course';
    for (const ev of msg.history.slice(-10).reverse()) {
      const li = document.createElement('li');
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = `year ${formatYear(ev.t)}`;
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = describe(ev);
      li.append(when, what);
      course.append(li);
    }
    parts.push(heading('What happened here'), course);
  }

  const links = document.createElement('ul');
  links.className = 'linkrow';
  const add = (key, label) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => openEntity(key));
    li.append(btn);
    links.append(li);
  };
  if (msg.owner) add(`p:${msg.owner.id}`, `Read of ${msg.owner.name}`);
  if (s) add(`s:${s.id}`, `Read of ${s.name}`);
  if (links.childElementCount) parts.push(heading('Go on'), links);

  dom.sheetBody.replaceChildren(...parts);
}

function renderSettings() {
  const parts = [sheetHeader('this world', 'Seed and search',
    'A world is rebuilt from its seed every time. The same seed always gives the same history.')];

  const seedField = document.createElement('div');
  seedField.className = 'field';
  const seedLabel = document.createElement('label');
  seedLabel.textContent = 'Seed';
  seedLabel.htmlFor = 'seed-input';
  const seedInput = document.createElement('input');
  seedInput.id = 'seed-input';
  seedInput.type = 'text';
  seedInput.spellcheck = false;
  seedInput.autocomplete = 'off';
  seedInput.value = currentSeed;
  seedField.append(seedLabel, seedInput);

  const newWorld = document.createElement('button');
  newWorld.type = 'button';
  newWorld.className = 'primary';
  newWorld.textContent = 'New world';
  newWorld.addEventListener('click', () => {
    const seed = seedInput.value.trim() || randomSeed();
    sheetStack.length = 0;
    hideSheet();
    start(seed);
  });
  seedInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') newWorld.click(); });

  const searchField = document.createElement('div');
  searchField.className = 'field';
  const searchLabel = document.createElement('label');
  searchLabel.textContent = 'Look up a name';
  searchLabel.htmlFor = 'search-input';
  const searchInput = document.createElement('input');
  searchInput.id = 'search-input';
  searchInput.type = 'search';
  searchInput.spellcheck = false;
  searchInput.placeholder = 'a state, a house, a city…';
  searchField.append(searchLabel, searchInput);

  const results = document.createElement('ul');
  results.className = 'linkrow';
  results.id = 'search-results';

  let timer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    const query = searchInput.value.trim();
    if (query.length < 2) { results.replaceChildren(); return; }
    timer = setTimeout(() => worker.postMessage({ type: 'search', query }), 180);
  });

  const saveSection = renderSaveSection();

  parts.push(seedField, newWorld, searchField, results, ...saveSection);
  dom.sheetBody.replaceChildren(...parts);
}

// The save/load section of the settings sheet: a labelled "save this
// world" action, then the continue slot and any named saves, each a load
// button paired with a small delete button.
function renderSaveSection() {
  const parts = [heading('This world')];

  const labelField = document.createElement('div');
  labelField.className = 'field';
  const labelLabel = document.createElement('label');
  labelLabel.textContent = 'Name this save';
  labelLabel.htmlFor = 'save-label-input';
  const labelInput = document.createElement('input');
  labelInput.id = 'save-label-input';
  labelInput.type = 'text';
  labelInput.spellcheck = false;
  labelInput.autocomplete = 'off';
  labelInput.value = defaultSaveLabel();
  labelField.append(labelLabel, labelInput);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'primary';
  saveBtn.textContent = latest ? 'Save' : 'Nothing to save yet';
  saveBtn.disabled = !latest;
  saveBtn.addEventListener('click', () => {
    saveCurrentWorld(labelInput.value.trim());
    saveBtn.textContent = 'Saved ✓';
    setTimeout(() => { saveBtn.textContent = 'Save'; }, 1200);
    labelInput.value = defaultSaveLabel();
    renderSavedList();
  });
  labelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });

  parts.push(labelField, saveBtn);

  const listHeading = heading('Saved worlds');
  const list = document.createElement('ul');
  list.className = 'saves';
  list.id = 'saved-worlds-list';
  parts.push(listHeading, list);

  // Populate directly rather than through renderSavedList()'s
  // getElementById lookup: `list` isn't attached to the document yet (that
  // happens when the caller splices `parts` into the sheet body), so a
  // document-wide lookup for its id would find nothing on this first render.
  fillSavedList(list);
  return parts;
}

// Re-render the saved-worlds list in place. Safe to call any time after the
// settings sheet has actually been attached to the document (e.g. from a
// save/delete click handler) — not during the initial build, see above.
function renderSavedList() {
  const list = document.getElementById('saved-worlds-list');
  if (list) fillSavedList(list);
}

function fillSavedList(list) {
  const data = loadSaveData();
  const rows = [];

  if (data.continueSlot) {
    rows.push(saveRow({
      id: null, label: 'Continue', seed: data.continueSlot.seed,
      year: data.continueSlot.year, continueRow: true,
    }));
  }
  for (const entry of data.saves) rows.push(saveRow(entry));

  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'nothing';
    li.textContent = 'Nothing saved yet.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...rows);
}

function saveRow(entry) {
  const li = document.createElement('li');
  li.className = 'saverow';

  const load = document.createElement('button');
  load.type = 'button';
  load.className = 'load';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = entry.label;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${entry.seed} · year ${formatYear(entry.year)}`;
  load.append(label, meta);
  load.addEventListener('click', () => loadSave(entry));

  li.append(load);

  if (!entry.continueRow) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.setAttribute('aria-label', `Delete ${entry.label}`);
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSave(entry.id);
      renderSavedList();
    });
    li.append(del);
  }
  return li;
}

function renderSearchResults(msg) {
  const results = document.getElementById('search-results');
  if (!results) return;
  if (!msg.results.length) {
    const li = document.createElement('li');
    li.className = 'nothing';
    li.textContent = `Nothing in the record answers to "${msg.query}".`;
    results.replaceChildren(li);
    return;
  }
  results.replaceChildren(...msg.results.map((r) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = KIND_LABEL[r.kind] || r.kind;
    btn.append(k, document.createTextNode(r.name));
    btn.addEventListener('click', () => openEntity(r.key));
    li.append(btn);
    return li;
  }));
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function sliderToYear(value) {
  if (!latest) return 0;
  return yearAtFraction(latest.year, value / Number(dom.scrub.max));
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

// Tapping the climate strip jumps the scrubber there — the same gesture as
// dragging it, just aimed at a point in history instead of a position on a
// track. Reusing the scrub input's own listener (rather than duplicating the
// seek logic) keeps the two paths from ever disagreeing.
dom.climateStrip.addEventListener('click', (e) => {
  if (!latest || !climateStrip) return;
  const year = climateStrip.yearAt(e.clientX);
  dom.scrub.value = String(Math.round(fractionAtYear(latest.year, year) * Number(dom.scrub.max)));
  dom.scrub.dispatchEvent(new Event('input', { bubbles: true }));
});

dom.play.addEventListener('click', () => {
  running = !running;
  dom.play.textContent = running ? 'Pause' : 'Run';
  worker.postMessage(running ? { type: 'run', speed: currentSpeed() } : { type: 'pause' });
});

dom.speed.addEventListener('change', () => {
  worker.postMessage({ type: 'speed', speed: currentSpeed() });
});

dom.live.addEventListener('click', backToNow);
dom.clearFilter.addEventListener('click', () => setTierFilter(null));
dom.openSettings.addEventListener('click', () => showSheet({ kind: 'settings' }));

dom.layerUnrest.addEventListener('click', () => {
  showUnrest = !showUnrest;
  dom.layerUnrest.setAttribute('aria-pressed', String(showUnrest));
  if (worker) worker.postMessage({ type: 'overlay', unrest: showUnrest });
  if (renderer) {
    renderer.setState({ overlay: showUnrest ? 'unrest' : null });
    // Turning it off should clear immediately; turning it on shows whatever
    // is already known and then sharpens once the worker's frame lands.
    if (!showUnrest || viewYear === null) renderer.draw();
  }
});

// Map interaction: drag pans, pinch or wheel zooms, and a tap that didn't
// move opens the region. All of it runs through pointer events — one finger
// is a pan, two is a pinch, and a mouse without any button down is just the
// hover highlight.
const activePointers = new Map(); // pointerId -> {x, y}
let dragLast = null;      // last position while one finger/button is down
let pinchDist = null;     // previous two-finger distance, for the next delta
let pinchMid = null;
let gestureMoved = false; // a drag or pinch happened; the next click is not a tap

function pointerDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function pointerMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function updateZoomUI() {
  dom.zoomReset.hidden = !renderer || renderer.viewScale <= 1.001;
}

dom.map.addEventListener('pointerdown', (e) => {
  if (!renderer) return;
  dom.map.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gestureMoved = false;
  if (activePointers.size === 1) {
    dragLast = { x: e.clientX, y: e.clientY };
  } else if (activePointers.size === 2) {
    const [a, b] = activePointers.values();
    pinchDist = pointerDist(a, b);
    pinchMid = pointerMid(a, b);
    dragLast = null;
  }
});

dom.map.addEventListener('pointermove', (e) => {
  if (!renderer) return;
  // Hover highlight is a mouse-only affordance, and only while nothing is
  // pressed — a mouse drag pans exactly like a touch drag does.
  if (e.pointerType === 'mouse' && activePointers.size === 0) {
    const cell = renderer.cellAt(e.clientX, e.clientY);
    if (cell !== renderer.highlight) { renderer.setState({ highlight: cell }); renderer.draw(); }
    return;
  }
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size === 1 && dragLast) {
    const dx = e.clientX - dragLast.x;
    const dy = e.clientY - dragLast.y;
    if (!gestureMoved && Math.hypot(dx, dy) > 6) gestureMoved = true;
    if (gestureMoved) { renderer.panByClientDelta(dx, dy); renderer.draw(); updateZoomUI(); }
    dragLast = { x: e.clientX, y: e.clientY };
  } else if (activePointers.size === 2) {
    const [a, b] = activePointers.values();
    const dist = pointerDist(a, b);
    const mid = pointerMid(a, b);
    if (pinchDist) {
      gestureMoved = true;
      renderer.zoomAt(mid.x, mid.y, dist / pinchDist);
      renderer.draw();
      updateZoomUI();
    }
    pinchDist = dist;
    pinchMid = mid;
  }
});

const endMapPointer = (e) => {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) { pinchDist = null; pinchMid = null; }
  dragLast = activePointers.size === 1 ? [...activePointers.values()][0] : null;
};
dom.map.addEventListener('pointerup', endMapPointer);
dom.map.addEventListener('pointercancel', endMapPointer);
dom.map.addEventListener('pointerleave', (e) => {
  if (renderer && renderer.highlight >= 0 && activePointers.size === 0) {
    renderer.setState({ highlight: -1 });
    renderer.draw();
  }
  endMapPointer(e);
});

// Desktop zoom. preventDefault keeps it from scrolling the page underneath.
dom.map.addEventListener('wheel', (e) => {
  if (!renderer) return;
  e.preventDefault();
  renderer.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  renderer.draw();
  updateZoomUI();
}, { passive: false });

dom.map.addEventListener('click', (e) => {
  if (gestureMoved) { gestureMoved = false; return; }
  if (!renderer) return;
  const cell = renderer.cellAt(e.clientX, e.clientY);
  if (cell < 0) return;
  worker.postMessage({ type: 'cell', cell });
});

function zoomButton(factor) {
  if (!renderer) return;
  const rect = dom.map.getBoundingClientRect();
  renderer.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  renderer.draw();
  updateZoomUI();
}
dom.zoomIn.addEventListener('click', () => zoomButton(1.6));
dom.zoomOut.addEventListener('click', () => zoomButton(1 / 1.6));
dom.zoomReset.addEventListener('click', () => {
  if (!renderer) return;
  renderer.resetView();
  renderer.draw();
  updateZoomUI();
});

// ---------------------------------------------------------------------------

function sentenceCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// The slow settings run below one year a second, where rounding to an integer
// would show a steady "0 yr/s".
function formatRate(v) {
  if (v < 10) return v.toFixed(1);
  return shortNumber(v);
}

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

// #seed                  the map, watching live
// #seed/48200             the map, replayed to year 48200 — what a save loads
// #seed/kind/id/48200     an entity's page, at the year it was opened
function readHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return { seed: null, key: null, year: null };
  const parts = raw.split('/');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { seed: parts[0] || null, key: null, year: Number(parts[1]) };
  }
  return {
    seed: parts[0] || null,
    key: parts.length >= 3 ? `${parts[1]}:${parts[2]}` : null,
    year: parts.length >= 4 ? Number(parts[3]) || 0 : null,
  };
}

function hashFor(seed, key, year) {
  if (key) return `#${encodeURIComponent(seed)}/${key.replace(':', '/')}/${Math.round(year || 0)}`;
  if (year) return `#${encodeURIComponent(seed)}/${Math.round(year)}`;
  return `#${encodeURIComponent(seed)}`;
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (renderer) { renderer.resize(); renderer.draw(); }
    if (climateStrip) {
      climateStrip.resize();
      if (latest) climateStrip.draw(latest.year, CLIMATE_PERIOD);
    }
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
  events: () => lastEvents,
  sheetOpen: () => !dom.sheet.hidden,
  setSpeed: (v) => { dom.speed.value = String(v); worker.postMessage({ type: 'speed', speed: v }); },
  pause: () => worker.postMessage({ type: 'pause' }),
  resume: () => worker.postMessage({ type: 'run', speed: currentSpeed() }),
  debugMarkers: () => climateStrip && climateStrip.markers,
  debugRenderer: () => renderer && {
    viewScale: renderer.viewScale, viewCenterX: renderer.viewCenterX, viewCenterY: renderer.viewCenterY,
    overlay: renderer.overlay, hasUnrest: !!renderer.unrest,
  },
};

const route = readHash();
start(route.seed || randomSeed(), route.key, route.year);
