// dams.js — animals that build dams. Where dam builders live by a gentle,
// wooded stream they wall it off, and a pond fills behind the wall. To the
// landscape a dam is just ground across the stream, so the pond is a lake
// like any other: it holds back the silt, and the water below runs clear.
// The pond silts up; when the builders leave, or a flood bursts the dam, the
// water drains and leaves a flat meadow of silt that the stream cuts back
// down through.

import { CELL_M } from './terrain.js';
import { CHANNEL_Q, LAG_TICK } from './landscape.js';
import { isBuilder } from './species.js';

export const DAM_H = 2.5;              // metres
const DAM_MAX_Q = 1.5e7;               // m³/yr: bigger rivers are too much to dam
const WASH_Q = 2e7;                    // a dam on a stream that grows this big washes out
const DAM_SLOPE = 0.012;               // steeper streams won't hold a pond
const DAM_COVER = 0.3;                 // the trees to build with
const DAM_DENSITY = 0.05;              // builders this dense in a cell build there
const DAM_SPACING = 3;                 // cells between dams
const DAM_PER_YEAR = 3;                // new dams a year, at most
const DAM_PER_CELL = 0.5;              // dams per life cell the builders hold, at most
const MAX_DAMS = 120;
const ABANDON_YEARS = 10;              // a dam with no one to keep it falls in about this long
const SILTED_M = 0.3;                  // a pond shallower than this is full of silt, and left
const SETTLE_YEARS = 2;                // a new pond's time to fill before it's judged
const REST_YEARS = 2000;               // a left site lies fallow this long
const BURST = 4;                       // a flood this many times the usual flow bursts a dam
const FLOOD_REACH = 4;                 // cells from a flooded river that a flood bursts dams

export class Dams {
  constructor() {
    this.list = [];        // { i, h, by, name, built, q }, in the order built
    this.rest = [];        // { i, until }: sites left fallow
    this.nextCheck = null;
    this.lastCheck = null;
    this.first = null;     // the first dam ever: { name, at }
    this.built = [];       // this step's news: new dams, for the first note
    this.burst = 0;        // and how many burst
  }

  // Once a year or so: dams left or silted up fall in, and the builders put
  // up new ones. Every step, at short ticks: a surge bursts dams.
  step(sim, years, dt) {
    const { land, life } = sim;
    this.built = [];
    this.burst = 0;
    if (dt < LAG_TICK && this.list.length) this.surge(land, years, dt);
    if (this.nextCheck !== null && years < this.nextCheck) return;
    const since = this.lastCheck === null ? 1 : Math.max(1, years - this.lastCheck);
    this.lastCheck = years;
    this.nextCheck = years + 1;
    this.rest = this.rest.filter((r) => r.until > years);
    const builders = life.species.filter((sp) => isBuilder(sp.traits) && sp.died === null);
    const B = this.density(life, builders);
    this.upkeep(sim, B, years, since);
    if (builders.length) this.build(sim, builders, B, years, since);
  }

  // Builders per life cell.
  density(life, builders) {
    const B = life.tmp;
    B.fill(0);
    for (const sp of builders) {
      const N = sp.N;
      for (let c = 0; c < life.NL; c++) B[c] += N[c];
    }
    return B;
  }

  upkeep(sim, B, years, since) {
    const { land, life } = sim;
    const rng = life.rng;
    const leave = 1 - Math.exp(-since / ABANDON_YEARS);
    for (const d of [...this.list]) {
      // A stream that has grown into a river washes its dam out.
      if (land.Q[d.i] > WASH_Q) { this.remove(land, d, years); continue; }
      const kept = B[life.toLife[d.i]] >= DAM_DENSITY * 0.5;
      if (!kept && rng.chance(leave)) { this.remove(land, d, years); continue; }
      if (years - d.built >= SETTLE_YEARS && this.pondDepth(land, d.i) < SILTED_M) this.remove(land, d, years);
    }
  }

  // The deepest water just above a dam.
  pondDepth(land, i) {
    const { W, H, water, rec } = land;
    const x = i % W, y = (i / W) | 0;
    let deep = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (j !== rec[i] && water[j] > deep) deep = water[j];
    }
    return deep;
  }

  build(sim, builders, B, years, since) {
    const { land, life } = sim;
    const { W, N, z, Q, rec, ocean, lake, ice, dam } = land;
    let held = 0;
    for (let c = 0; c < life.NL; c++) if (B[c] >= DAM_DENSITY) held++;
    const cap = Math.min(MAX_DAMS, Math.floor(held * DAM_PER_CELL));
    const room = Math.min(cap - this.list.length, Math.ceil(DAM_PER_YEAR * since));
    if (room <= 0) return;
    const near = (i, list) => {
      const x = i % W, y = (i / W) | 0;
      for (const d of list) {
        if (Math.max(Math.abs((d.i % W) - x), Math.abs(((d.i / W) | 0) - y)) <= DAM_SPACING) return true;
      }
      return false;
    };
    const sites = [];
    for (let i = 0; i < N; i++) {
      if (dam[i] || ocean[i] || lake[i] || ice[i]) continue;
      if (Q[i] < CHANNEL_Q || Q[i] > DAM_MAX_Q || this.byRiver(land, i)) continue;
      const c = life.toLife[i];
      if (B[c] < DAM_DENSITY || life.cover[c] < DAM_COVER) continue;
      const r = rec[i];
      if (r === i || ocean[r]) continue;
      const diag = (i % W) !== (r % W) && ((i / W) | 0) !== ((r / W) | 0);
      if ((z[i] - z[r]) / ((diag ? Math.SQRT2 : 1) * CELL_M) > DAM_SLOPE) continue;
      sites.push(i);
    }
    let made = 0;
    while (made < room && sites.length) {
      const k = life.rng.int(sites.length);
      const i = sites[k];
      sites[k] = sites[sites.length - 1];
      sites.pop();
      if (near(i, this.list) || near(i, this.rest)) continue;
      // Built by whichever builder is thickest there.
      const c = life.toLife[i];
      let by = builders[0];
      for (const sp of builders) if (sp.N[c] > by.N[c]) by = sp;
      const d = { i, h: DAM_H, by: by.id, name: by.name, built: years, q: Q[i] };
      z[i] += d.h;
      dam[i] = d.h;
      this.list.push(d);
      this.built.push(d);
      if (!this.first) this.first = { name: by.name, at: c };
      made++;
    }
  }

  // Next to a big river, a pond would only catch the river.
  byRiver(land, i) {
    const { W, H, Q } = land;
    const x = i % W, y = (i / W) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && Q[ny * W + nx] > WASH_Q) return true;
    }
    return false;
  }

  remove(land, d, years) {
    land.z[d.i] -= land.dam[d.i];
    land.dam[d.i] = 0;
    this.list.splice(this.list.indexOf(d), 1);
    this.rest.push({ i: d.i, until: years + REST_YEARS });
  }

  // A surge far above a dam's usual flow bursts it, and the pond goes down
  // the river with the flood.
  surge(land, years, dt) {
    const k = Math.min(1, dt / 0.1);
    for (const d of [...this.list]) {
      const q = land.Q[d.i];
      if (q > WASH_Q) { this.breach(land, d, years); continue; }
      if (q > BURST * d.q && q > CHANNEL_Q * BURST) { this.breach(land, d, years); continue; }
      d.q += (q - d.q) * k;
    }
  }

  // A flood on the river: dams near it go.
  flood(land, cells, years) {
    const { W } = land;
    const before = this.list.length;
    for (const d of [...this.list]) {
      const x = d.i % W, y = (d.i / W) | 0;
      for (const j of cells) {
        if (Math.max(Math.abs((j % W) - x), Math.abs(((j / W) | 0) - y)) <= FLOOD_REACH) { this.breach(land, d, years); break; }
      }
    }
    return before - this.list.length;
  }

  // Bursts a dam. Below a day a tick, the water behind it sets off down the
  // river; at longer ticks it's simply gone.
  breach(land, d, years) {
    if (land.lagActive) {
      const { W, H, water, chan } = land;
      const area = CELL_M * CELL_M;
      let vol = 0;
      const seen = new Set([d.i]);
      const queue = [d.i];
      while (queue.length) {
        const c = queue.pop();
        const x = c % W, y = (c / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (seen.has(j) || !(water[j] > 0.05) || land.ocean[j]) continue;
          seen.add(j);
          queue.push(j);
          vol += water[j] * area;
          water[j] = 0;
        }
      }
      chan[d.i] += vol;
    }
    this.remove(land, d, years);
    this.burst++;
    this.burstAt = d.i;
  }

  // The dams, for drawing: each cell and the cell it spills into.
  frameData(land) {
    const out = new Int32Array(this.list.length * 2);
    this.list.forEach((d, k) => { out[2 * k] = d.i; out[2 * k + 1] = land.rec[d.i]; });
    return out;
  }

  at(i) {
    return this.list.find((d) => d.i === i) || null;
  }

  saveState() {
    return {
      list: this.list.map((d) => ({ ...d })), rest: this.rest.map((r) => ({ ...r })),
      nextCheck: this.nextCheck, lastCheck: this.lastCheck, first: this.first,
    };
  }

  // The dams are already in the saved ground; this puts back the record of them.
  restoreState(s, land) {
    land.dam.fill(0);
    if (!s) return;
    this.list = s.list.map((d) => ({ ...d }));
    this.rest = s.rest.map((r) => ({ ...r }));
    this.nextCheck = s.nextCheck;
    this.lastCheck = s.lastCheck;
    this.first = s.first;
    for (const d of this.list) land.dam[d.i] = d.h;
  }
}
