// gpuflow.js — the water's shaders, for the river on the GPU
// (gpuriver.js). The same sums as Flow.water() (flow.js), as four passes a
// step over every cell: the flow through the x faces, through the y faces,
// then each cell's depth, mud and current, then a reduction for the next
// step's length. The step's length stays on the GPU (a 1×1 texture every
// pass reads), so nothing waits on the CPU between steps.

import { WET, SPONGE, WATER } from './flow.js';

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
// The plants' roughness: uP's first two channels weighted by uPW (one
// texture of roughness, or the ground's grass and trees).
uniform vec2 uPW;
float zAt(int x, int y) { return texelFetch(uZ, ivec2(x, y), 0).r; }
vec4 sAt(int x, int y) { return texelFetch(uS, ivec2(x, y), 0); }
float pAt(int x, int y) { vec4 c = texelFetch(uP, ivec2(x, y), 0); return c.r * uPW.x + c.g * uPW.y; }
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
// out at sea and in a reservoir's deep water (uP's third channel 2 or
// more), currents fade; in the sponge rows by the open sea, more.
uniform int uSeaY, uSpongeY;
uniform float uSea, uSeaT;
float damping(int x, int y, float dtPrev) {
  float d = 1.0;
  bool still = texelFetch(uP, ivec2(x, y), 0).b > 1.5 && sAt(x, y).x > ${WATER.STILL_H.toFixed(6)};
  if (((y > uSeaY && zAt(x, y) < uSea - 0.3) || still) && uSeaT > 0.0) d *= 1.0 - dtPrev / uSeaT;
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

// The next step's length, and what's added up since the bed last moved:
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

// For the GPU's copy of the river (gpuriver.js).
export const WATER_SHADERS = { HEAD, FACE_X, FACE_Y, STATE, REDUCE, STEP };
