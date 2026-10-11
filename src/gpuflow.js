// gpuflow.js — the water worked out on the GPU. The same sums as
// Flow.water() (flow.js), as four shader passes a step over every cell:
// the flow through the x faces, through the y faces, then each cell's
// depth, mud and current, then a reduction for the next step's length.
// The step's length stays on the GPU (a 1×1 texture every pass reads),
// so nothing waits on the CPU between steps. When the bed is to move, the
// water's state is read back; after it has moved, the bed (and the plants'
// roughness, and the mud the bed traded) go back up.

import { context, texture, target, program, run, upload, read } from './gpu.js';
import { WET, SPONGE, TUNE, WATER } from './flow.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define G ${WATER.G.toFixed(6)}
#define WET ${WET.toFixed(6)}
#define DRY ${(WET * 0.5).toFixed(6)}
#define FILM ${WATER.FILM.toFixed(6)}
#define N_BARE ${WATER.N_BARE.toFixed(6)}
uniform sampler2D uS, uZ, uP, uQX, uQY, uDT;
uniform int uW, uH;
uniform float uDx;
float zAt(int x, int y) { return texelFetch(uZ, ivec2(x, y), 0).r; }
vec4 sAt(int x, int y) { return texelFetch(uS, ivec2(x, y), 0); }
float pAt(int x, int y) { return texelFetch(uP, ivec2(x, y), 0).r; }
`;

// The flow through a face between cells i and j: pushed by the slope of the
// water surface, held back by friction, no faster than critical flow and
// never draining more than a quarter of what's in the cell it leaves.
const FACE = `
float faceFlow(float q, float dt, float zi, float zj, float hi, float hj, float n) {
  float ei = zi + hi, ej = zj + hj;
  float hf = max(ei, ej) - max(zi, zj);
  if (hf <= DRY) return 0.0;
  float gdt = G * dt;
  q = (q - gdt * hf * (ej - ei) / uDx) / (1.0 + (gdt * n * n * abs(q)) / (hf * hf * pow(hf, 1.0 / 3.0)));
  if (q * q > G * hf * hf * hf) q = sign(q) * hf * sqrt(G * hf);
  if (q > 0.0) q = min(q, hi * uDx * 0.25 / dt); else q = max(q, -hj * uDx * 0.25 / dt);
  return q;
}
// How much a cell's left and top faces were damped after the last step:
// out at sea, currents fade; in the sponge rows by the open sea, more.
uniform int uSeaY, uSpongeY;
uniform float uSea, uSeaT;
float damping(int x, int y, float dtPrev) {
  float d = 1.0;
  if (y > uSeaY && zAt(x, y) < uSea - 0.3 && uSeaT > 0.0) d *= 1.0 - dtPrev / uSeaT;
  if (y >= uSpongeY) d *= 1.0 - 0.5 * float(y - uSpongeY + 1) / ${SPONGE.toFixed(1)};
  return d;
}
`;

const FACE_X = HEAD + FACE + `
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int fx = p.x, y = p.y;
  if (fx <= 0 || fx >= uW) { o = vec4(0.0); return; }
  vec4 DT = texelFetch(uDT, ivec2(0), 0);
  float q = texelFetch(uQX, p, 0).r * damping(fx, y, DT.y);
  int xi = fx - 1, xj = fx;
  float n = N_BARE + 0.5 * (pAt(xi, y) + pAt(xj, y));
  o = vec4(faceFlow(q, DT.x, zAt(xi, y), zAt(xj, y), sAt(xi, y).x, sAt(xj, y).x, n), 0.0, 0.0, 0.0);
}`;

const FACE_Y = HEAD + FACE + `
uniform int uX0, uX1;
uniform float uQin;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, fy = p.y;
  // The pump's inlet along the top edge; nothing through the bottom edge.
  if (fy == 0) { o = vec4(x >= uX0 && x <= uX1 ? uQin : 0.0, 0.0, 0.0, 0.0); return; }
  if (fy >= uH) { o = vec4(0.0); return; }
  vec4 DT = texelFetch(uDT, ivec2(0), 0);
  float q = texelFetch(uQY, p, 0).r * damping(x, fy, DT.y);
  int yi = fy - 1, yj = fy;
  float n = N_BARE + 0.5 * (pAt(x, yi) + pAt(x, yj));
  o = vec4(faceFlow(q, DT.x, zAt(x, yi), zAt(x, yj), sAt(x, yi).x, sAt(x, yj).x, n), 0.0, 0.0, 0.0);
}`;

// Each cell's new depth and mud from what flows through its faces; the
// open sea's sponge; the current at its centre, held to sensible speeds;
// and, for the reduction, its depth, its speed and the mud the sea took.
const STATE = HEAD + `
uniform float uCin, uRain, uSoak, uFrMax;
uniform int uSpongeY;
uniform float uSea;
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oR;
float conc(int x, int y) { vec4 s = sAt(x, y); return s.x > 1e-4 ? s.y / s.x : 0.0; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  float dt = texelFetch(uDT, ivec2(0), 0).x;
  float k = dt / uDx;
  float qL = texelFetch(uQX, ivec2(x, y), 0).r, qR = texelFetch(uQX, ivec2(x + 1, y), 0).r;
  float qT = texelFetch(uQY, ivec2(x, y), 0).r, qB = texelFetch(uQY, ivec2(x, y + 1), 0).r;
  vec4 s = sAt(x, y);
  float d = s.x + k * (qL - qR + qT - qB) + uRain * dt;
  d -= min(d, uSoak * dt);
  d = max(d, 0.0);
  // The mud goes with the water, at the concentration of where it comes from.
  float ci = conc(x, y), m = s.y;
  if (qL != 0.0) m += k * qL * (qL > 0.0 ? conc(x - 1, y) : ci);
  if (qR != 0.0) m -= k * qR * (qR > 0.0 ? ci : conc(x + 1, y));
  if (qT != 0.0) m += k * qT * (qT > 0.0 ? (y > 0 ? conc(x, y - 1) : uCin) : ci);
  if (qB != 0.0) m -= k * qB * (qB > 0.0 ? ci : conc(x, y + 1));
  m = max(m, 0.0);
  float z = zAt(x, y), gone = 0.0;
  if (y >= uSpongeY) {
    float w = float(y - uSpongeY + 1) / ${SPONGE.toFixed(1)};
    float level = max(uSea - z, 0.0);
    d += (level - d) * w * 0.5;
    gone = m * w * 0.5;
    m -= gone;
  }
  float u = 0.0, v = 0.0, deep = 0.0, fast = 0.0;
  if (d > WET) {
    u = (qL + qR) / (2.0 * d); v = (qT + qB) / (2.0 * d);
    deep = d;
    float cap = (d > FILM ? uFrMax : 2.0) * sqrt(G * d);
    u = clamp(u, -cap, cap); v = clamp(v, -cap, cap);
    if (d > FILM) fast = abs(u) + abs(v);
  }
  // The sea along the bottom edge holds its level, and is clear.
  if (y == uH - 1) { gone += m; m = 0.0; d = max(uSea - z, 0.0); }
  oS = vec4(d, m, u, v);
  oR = vec4(deep, fast, gone * uDx * uDx, 0.0);
}`;

// A 4 × 4 reduction: the largest depth and speed, and the summed mud.
const REDUCE = `#version 300 es
precision highp float;
uniform sampler2D uIn;
uniform ivec2 uSize;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 4;
  vec4 r = vec4(0.0);
  for (int dy = 0; dy < 4; dy++) for (int dx = 0; dx < 4; dx++) {
    ivec2 q = p + ivec2(dx, dy);
    if (q.x >= uSize.x || q.y >= uSize.y) continue;
    vec4 t = texelFetch(uIn, q, 0);
    r = vec4(max(r.x, t.x), max(r.y, t.y), r.z + t.z, 0.0);
  }
  o = r;
}`;

// Adds the mud the bed traded with the water (worked out on the CPU from
// the water as it was a moment ago) to the water as it is now.
const ADD_MUD = HEAD + `
uniform sampler2D uD;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uS, p, 0);
  o = vec4(s.x, max(0.0, s.y + texelFetch(uD, p, 0).r), s.z, s.w);
}`;

// The next step's length, and what's added up since the CPU last looked:
// water time and the mud the sea took.
const STEP = `#version 300 es
precision highp float;
uniform sampler2D uR, uDT;
uniform float uDx, uCfl, uMaxDt;
uniform int uReset;
out vec4 o;
void main() {
  vec4 r = texelFetch(uR, ivec2(0), 0), DT = texelFetch(uDT, ivec2(0), 0);
  float c = sqrt(${WATER.G.toFixed(6)} * r.x) + r.y;
  float dt = c > 0.0 ? min(uMaxDt, uCfl * uDx / c) : uMaxDt;
  float water = (uReset == 1 ? 0.0 : DT.z) + DT.x;
  float mud = (uReset == 1 ? 0.0 : DT.w) + r.z;
  o = vec4(dt, DT.x, water, mud);
}`;

export class GpuWater {
  constructor(flow) {
    const { W, H } = flow;
    this.W = W; this.H = H;
    const gl = this.gl = context();
    this.progs = { fx: program(gl, FACE_X), fy: program(gl, FACE_Y), state: program(gl, STATE), reduce: program(gl, REDUCE), step: program(gl, STEP), addMud: program(gl, ADD_MUD) };
    const pair = (w, h, c) => { const a = texture(gl, w, h, c), b = texture(gl, w, h, c); return { a, b, fa: target(gl, a), fb: target(gl, b) }; };
    this.Z = texture(gl, W, H, 1);
    this.P = texture(gl, W, H, 1);
    this.QX = pair(W + 1, H, 1);
    this.QY = pair(W, H + 1, 1);
    // The state and the reduction's input are written together.
    this.S = [texture(gl, W, H, 4), texture(gl, W, H, 4)];
    this.R = texture(gl, W, H, 4);
    this.stateFb = [target(gl, this.S[0], this.R), target(gl, this.S[1], this.R)];
    this.sFb = [target(gl, this.S[0]), target(gl, this.S[1])];
    this.D = texture(gl, W, H, 1);
    // Reading back without waiting: the water's state and its 1×1 step go
    // into buffers the GPU fills while the CPU gets on with the bed.
    this.pboS = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboS);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 16, gl.STREAM_READ);
    this.pboDT = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboDT);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.pending = null;   // a read under way: its fence
    // Overlapping the read with the bed would let the bed trade mud with
    // water that has since moved on (and make mud from nothing), so until
    // the mud's trade is worked out on the GPU too, each read is waited for.
    this.waitEachTime = true;
    this.reduce = [];
    for (let w = W, h = H; w > 1 || h > 1;) { w = Math.ceil(w / 4); h = Math.ceil(h / 4); const t = texture(gl, w, h, 4); this.reduce.push({ t, fb: target(gl, t) }); }
    this.DT = pair(1, 1, 4);
    this.s = 0;            // which of the faces' and step's pairs is current
    this.ss = 0;           // and which of the water's state
    this.reset = 0;
    this.buf4 = new Float32Array(W * H * 4);
    this.buf1 = new Float32Array(W * H);
    this.load(flow, true);
  }

  // Sends the CPU's state up: the bed and roughness always, the water's
  // state (and, with faces, its flows and step) when asked.
  load(flow, all = false) {
    const { gl, W, H } = this;
    const { z, cover, trees, h, M, ux, uy } = flow;
    upload(gl, this.Z, z instanceof Float32Array ? z : Float32Array.from(z));
    const p = this.buf1;
    for (let i = 0; i < W * H; i++) p[i] = WATER.N_PLANT * cover[i] + WATER.N_TREE * trees[i];
    upload(gl, this.P, p);
    const s = this.buf4;
    for (let i = 0; i < W * H; i++) { s[i * 4] = h[i]; s[i * 4 + 1] = M[i]; s[i * 4 + 2] = ux[i]; s[i * 4 + 3] = uy[i]; }
    upload(gl, this.S[this.ss], s);
    if (all) {
      upload(gl, this.s ? this.QX.b : this.QX.a, flow.qx);
      upload(gl, this.s ? this.QY.b : this.QY.a, flow.qy);
      upload(gl, this.s ? this.DT.b : this.DT.a, new Float32Array([flow.dt, flow.dt, 0, 0]));
      this.reset = 0;
    }
  }

  // One water step on the GPU.
  step(flow) {
    const { gl, W, H, progs } = this;
    const c = this.s, n = 1 - c;
    const QXc = c ? this.QX.b : this.QX.a, QXn = n ? this.QX.b : this.QX.a, QXnFb = n ? this.QX.fb : this.QX.fa;
    const QYc = c ? this.QY.b : this.QY.a, QYn = n ? this.QY.b : this.QY.a, QYnFb = n ? this.QY.fb : this.QY.fa;
    const DTc = c ? this.DT.b : this.DT.a, DTnFb = n ? this.DT.fb : this.DT.fa;
    const Sc = this.S[this.ss], sn = 1 - this.ss;
    const dx = flow.dx;
    const common = (u) => {
      gl.uniform1i(u.uW, W); gl.uniform1i(u.uH, H); gl.uniform1f(u.uDx, dx);
      if (u.uSeaY) gl.uniform1i(u.uSeaY, flow.seaY);
      if (u.uSpongeY) gl.uniform1i(u.uSpongeY, H - SPONGE);
      if (u.uSea) gl.uniform1f(u.uSea, flow.sea);
      if (u.uSeaT) gl.uniform1f(u.uSeaT, TUNE.seaDamp);
    };
    const tex = { uS: Sc, uZ: this.Z, uP: this.P, uQX: QXc, uQY: QYc, uDT: DTc };
    run(gl, progs.fx, QXnFb, tex, common);
    const x0 = Math.max(0, Math.round(flow.inletX - flow.inletHalf)), x1 = Math.min(W - 1, Math.round(flow.inletX + flow.inletHalf));
    run(gl, progs.fy, QYnFb, tex, (u) => { common(u); gl.uniform1i(u.uX0, x0); gl.uniform1i(u.uX1, x1); gl.uniform1f(u.uQin, flow.inflow / ((x1 - x0 + 1) * dx)); });
    run(gl, progs.state, this.stateFb[sn], { uS: Sc, uZ: this.Z, uP: this.P, uQX: QXn, uQY: QYn, uDT: DTc }, (u) => {
      common(u);
      gl.uniform1f(u.uCin, flow.mudIn); gl.uniform1f(u.uRain, flow.rainRate); gl.uniform1f(u.uSoak, WATER.INFILTRATE); gl.uniform1f(u.uFrMax, TUNE.frMax);
    });
    // The reduction, then the next step's length.
    let src = this.R;
    for (const r of this.reduce) {
      run(gl, progs.reduce, r.fb, { uIn: src }, (u) => gl.uniform2i(u.uSize, src.w, src.h));
      src = r.t;
    }
    run(gl, progs.step, DTnFb, { uR: src, uDT: DTc }, (u) => {
      gl.uniform1f(u.uDx, dx); gl.uniform1f(u.uCfl, WATER.CFL); gl.uniform1f(u.uMaxDt, WATER.MAX_DT); gl.uniform1i(u.uReset, this.reset);
    });
    this.reset = 0;
    this.s = n;
    this.ss = sn;
  }

  // Starts reading the water's state back (depth, mud, current; the next
  // step's length; the water time and the mud to sea since the last read)
  // without waiting for it.
  startFetch() {
    const { gl, W, H } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sFb[this.ss]);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboS);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, 0);
    const dt = this.s ? this.DT.b : this.DT.a;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dt.readFb || (dt.readFb = target(gl, dt)));
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboDT);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.pending = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.reset = 1;
  }

  // Finishes a read: into the CPU's arrays. Returns the water time it covers.
  finishFetch(flow) {
    const { gl, W, H } = this;
    if (!this.pending) return 0;
    gl.clientWaitSync(this.pending, 0, 0);
    gl.deleteSync(this.pending);
    this.pending = null;
    const s = this.buf4, dt = new Float32Array(4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboS);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, s);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboDT);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, dt);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const { h, M, ux, uy } = flow;
    for (let i = 0; i < W * H; i++) { h[i] = s[i * 4]; M[i] = s[i * 4 + 1]; ux[i] = s[i * 4 + 2]; uy[i] = s[i * 4 + 3]; }
    flow.dt = dt[0];
    flow.mudOut += dt[3];
    flow.mudFed += flow.inflow * flow.mudIn * dt[2];
    return dt[2];
  }

  // The read for the bed, overlapped: hand over the read started last time
  // (the water a moment ago) and start reading the water as it is now, so
  // the CPU never waits on the GPU. With no read under way yet, it starts
  // one and returns -1: the bed waits for the next time.
  fetch(flow) {
    if (this.waitEachTime) { this.startFetch(); return this.finishFetch(flow); }
    const t = this.pending ? this.finishFetch(flow) : -1;
    this.startFetch();
    return t;
  }

  // Sends the bed back up after it has moved: the bed and the plants'
  // roughness, and the mud it traded with the water as an addition to the
  // water as it now is.
  loadBed(flow, mudBefore) {
    const { gl, W, H } = this;
    upload(gl, this.Z, flow.z instanceof Float32Array ? flow.z : Float32Array.from(flow.z));
    const p = this.buf1;
    for (let i = 0; i < W * H; i++) p[i] = WATER.N_PLANT * flow.cover[i] + WATER.N_TREE * flow.trees[i];
    upload(gl, this.P, p);
    const d = this.buf1;
    let any = false;
    for (let i = 0; i < W * H; i++) { d[i] = flow.M[i] - mudBefore[i]; if (d[i] !== 0) any = true; }
    if (!any) return;
    upload(gl, this.D, d);
    const n = 1 - this.ss;
    run(gl, this.progs.addMud, this.sFb[n], { uS: this.S[this.ss], uD: this.D }, null);
    this.ss = n;
  }

  // Everything as it is now, waiting for it: for a save, a tool, or
  // handing the water back to the CPU. (A read under way is finished first,
  // so no water time or mud goes uncounted.)
  fetchAll(flow) {
    const { gl } = this;
    let t = 0;
    if (this.pending) t += this.finishFetch(flow);
    this.startFetch();
    t += this.finishFetch(flow);
    flow.waterTime += t;
    read(gl, this.s ? this.QX.b : this.QX.a, flow.qx);
    read(gl, this.s ? this.QY.b : this.QY.a, flow.qy);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
