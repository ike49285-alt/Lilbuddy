// gpuriver.js — the whole river worked out on the GPU: the water (the
// shaders of gpuflow.js) and the bed, its sand and gravel, mud, banks,
// slumps, bare rock and plants, as a chain of shader passes that mirror
// Flow.bed() (flow.js) line for line. Flow.bed() stays the reference.
//
// Nothing comes back per step. The world's state comes back now and then
// without waiting (for drawing, the stats, the things to protect), and the
// counters the shaders keep (sand fed in and lost to sea, mud laid, rock
// worn, bed time) are folded into the CPU's totals as it does. The CPU
// keeps the rare jobs: landslides, and anything the page does to the
// ground (it fetches everything, changes it, and sends it all back up).
//
// Where the CPU works through cells in order and one cell's change feeds
// the next (banks giving to the channel, slumps), the GPU works on all of
// them at once: each bank works out what all its neighbours take from it,
// then each cell what it gives and gets. So a river on the GPU is close to
// one on the CPU, not identical (and float32 throughout).

import { context, texture, target, program, run, upload, read } from './gpu.js';
import { WET, SPONGE, TUNE, WATER, BEDK, SHIELDS_C, SEC_PER_YR } from './flow.js';
import { WATER_SHADERS } from './gpuflow.js';

const glf = (v) => Number(v).toExponential(9);
const FIELD_CROP = 0.5;              // a field's crop, as plant cover (sim.js)
const FENCE_EVERY = 4;         // steps between marks of how far the GPU has got
const POLL_MS = 50;            // the least time between reads of the world for the page

const BHEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define G ${glf(WATER.G)}
#define WET ${glf(WET)}
#define N_BARE ${glf(WATER.N_BARE)}
#define N_PLANT ${glf(WATER.N_PLANT)}
#define N_TREE ${glf(WATER.N_TREE)}
#define SHIELDS_C ${glf(SHIELDS_C)}
#define SHIELDS_K ${glf(1 / (((BEDK.RHO_S - BEDK.RHO) / BEDK.RHO) * WATER.G * BEDK.D50))}
#define TAU_K ${glf((BEDK.RHO_S - BEDK.RHO) * WATER.G * BEDK.D50)}
#define RHO ${glf(BEDK.RHO)}
#define SG ${glf(BEDK.SG)}
#define POROSITY ${glf(BEDK.POROSITY)}
#define BULK ${glf(1 / (1 - BEDK.POROSITY))}
#define LA ${glf(BEDK.LA)}
#define ROCK_SHIELD ${glf(BEDK.ROCK_SHIELD)}
#define MUD_TE ${glf(BEDK.MUD_TE)}
#define MUD_PLANT ${glf(BEDK.MUD_PLANT)}
#define SLOPE_WET ${glf(BEDK.SLOPE_WET)}
#define SLOPE_DRY ${glf(BEDK.SLOPE_DRY)}
#define SLUMP ${glf(BEDK.SLUMP)}
#define PLANT_DROWN_YR ${glf(BEDK.PLANT_DROWN_YR)}
#define PLANT_UPROOT ${glf(BEDK.PLANT_UPROOT)}
#define TREE_DROWN_YR ${glf(BEDK.TREE_DROWN_YR)}
#define TREE_UPROOT ${glf(BEDK.TREE_UPROOT)}
#define WC_MIN ${glf(BEDK.WC_MIN)}
#define WC_N ${BEDK.WC_N}
#define SEC_PER_YR ${glf(SEC_PER_YR)}
#define FIELD_CROP ${glf(FIELD_CROP)}
#define FEED_T ${glf(BEDK.FEED_T)}
// The world: S = (depth, mud, current x, current y); A = (bed, rock,
// recent change, put by hand); B = (mud share of the top layer, of the
// ground below, gravel share of the top layer, of the ground below);
// C = (grass, trees, kept clear of trees + 2 in a reservoir, the bed at the start); T = (sand
// carried x, y, Shields stress, gravel's share of it).
uniform sampler2D uS, uA, uB, uC, uT, uDT, uBED;
uniform int uW, uH, uHB;
uniform float uDx, uMorph, uDzMax;
vec4 S(int x, int y) { return texelFetch(uS, ivec2(x, y), 0); }
vec4 A(int x, int y) { return texelFetch(uA, ivec2(x, y), 0); }
vec4 B(int x, int y) { return texelFetch(uB, ivec2(x, y), 0); }
vec4 C(int x, int y) { return texelFetch(uC, ivec2(x, y), 0); }
vec4 T(int x, int y) { return texelFetch(uT, ivec2(x, y), 0); }
bool inside(int x, int y) { return x >= 0 && y >= 0 && x < uW && y < uH; }
// The water's time since the bed last moved, and the bed's time it stands for.
float waterTime() { return texelFetch(uDT, ivec2(0), 0).z; }
float bedTime() { return waterTime() * min(texelFetch(uBED, ivec2(0), 0).x, uMorph); }
float per() { return 1.0 / ((1.0 - POROSITY) * uDx); }
// The pump's inlet along the top edge: the sand its water carries away
// (and the gravel in it), and whether it arrives in a reservoir (C's third
// channel 2 or more), when the pump feeds no less than what it has been
// feeding lately (BED.z, per unit of supply and of inflow).
uniform int uX0, uX1;
uniform float uSupply, uInflow;
void inletNow(out float local, out float localG, out bool lake) {
  local = 0.0; localG = 0.0;
  int n = 0;
  for (int x = uX0; x <= uX1; x++) {
    vec4 t = T(x, 0);
    float v = uSupply * max(0.0, t.y);
    local += v; localG += v * t.w;
    if (C(x, 0).z > 1.5) n++;
  }
  lake = 2 * n > uX1 - uX0 + 1;
}
float feedLeast() { return texelFetch(uBED, ivec2(0), 0).z * uSupply * uInflow; }
bool drownedNow() {
  float local, localG; bool lake;
  inletNow(local, localG, lake);
  return lake && local < feedLeast();
}
// The top layer's make-up (b) after the ground rises or falls by d, dm of
// it mud and dg gravel (Flow.mix).
void mixLayer(inout vec4 b, float z, float rock, float d, float dm, float dg) {
  float nf, ng;
  if (d >= 0.0) {
    nf = (b.x * LA + dm) / (LA + d);
    ng = (b.z * LA + dg) / (LA + d);
    float below = max(0.0, z - rock - LA);
    if (below + d > 0.0) {
      b.y = (b.y * below + clamp(nf, 0.0, 1.0) * d) / (below + d);
      b.w = (b.w * below + clamp(ng, 0.0, 1.0) * d) / (below + d);
    }
  } else if (-d >= LA) {
    nf = b.y; ng = b.w;
  } else {
    nf = (b.x * LA + dm - b.y * d) / LA;
    ng = (b.z * LA + dg - b.w * d) / LA;
  }
  nf = clamp(nf, 0.0, 1.0);
  b.x = nf;
  b.z = clamp(ng, 0.0, 1.0 - nf);
}
`;

// Sand and gravel carried at each cell's centre (Wilcock and Crowe), turned
// by the spiral flow of bends and pulled downhill.
const TRANSPORT = BHEAD + `
uniform sampler2D uWC;
uniform float uSpiral, uBedSlope, uTransport;
out vec4 o;
float wcW(float phi) {
  if (phi < WC_MIN) return 0.0;
  float r = sqrt(phi);
  if (phi < 1.35) { float p2 = phi * phi; return 0.002 * p2 * p2 * p2 * phi * r; }
  float t = 1.0 - 0.894 / r;
  return 14.0 * t * t * t * t * sqrt(t);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  o = vec4(0.0);
  if (y >= uHB) return;
  vec4 s = S(x, y);
  float d = s.x;
  if (d <= WET * 2.0) return;
  float u = s.z, v = s.w;
  float U2 = u * u + v * v;
  if (U2 < 1e-6) return;
  vec4 c = C(x, y), b = B(x, y);
  float n = N_BARE + N_PLANT * c.x + N_TREE * c.y;
  float th = (n * n * U2 * SHIELDS_K) / pow(d, 1.0 / 3.0);
  o.z = th;
  float fm = b.x, coarse = 1.0 - fm;
  if (coarse <= 0.0) return;
  float Fg = b.z / coarse, Fs = 1.0 - Fg;
  float hold = (1.0 + 2.0 * c.x + 3.0 * c.y) * (fm > 0.3 ? 1.0 + 3.0 * (fm - 0.3) / 0.7 : 1.0);
  float tau = th * TAU_K;
  float kf = clamp(Fs, 0.0, 1.0) * float(WC_N);
  int k0 = int(kf), k1 = min(k0 + 1, WC_N);
  float w = kf - float(k0);
  vec2 r0 = texelFetch(uWC, ivec2(k0, 0), 0).xy, r1 = texelFetch(uWC, ivec2(k1, 0), 0).xy;
  float rs = (r0.x + (r1.x - r0.x) * w) * hold;
  if (tau < rs * WC_MIN) return;
  float rg = (r0.y + (r1.y - r0.y) * w) * hold;
  float us3 = (tau / RHO) * sqrt(tau / RHO);
  float qK = uTransport / SG;
  float qsand = wcW(tau / rs) * Fs * coarse * us3 * qK;
  float qgrav = wcW(tau / rg) * Fg * coarse * us3 * qK;
  float qs = qsand + qgrav;
  if (qs <= 0.0) return;
  o.w = qgrav / qs;
  float U = sqrt(U2);
  float ex = u / U, ey = v / U;
  int xm = max(x - 1, 0), xp = min(x + 1, uW - 1), ym = max(y - 1, 0), yp = min(y + 1, uH - 1);
  float ddx = 1.0 / (float(xp - xm) * uDx), ddy = 1.0 / (float(yp - ym) * uDx);
  vec4 sl = S(xm, y), sr = S(xp, y), su = S(x, ym), sd = S(x, yp);
  float dudx = (sr.z - sl.z) * ddx, dudy = (sd.z - su.z) * ddy;
  float dvdx = (sr.w - sl.w) * ddx, dvdy = (sd.w - su.w) * ddy;
  float kappa = (u * (u * dvdx + v * dvdy) - v * (u * dudx + v * dudy)) / (U2 * U);
  float t = clamp(uSpiral * d * kappa, -0.6, 0.6);
  float cs = 1.0 / sqrt(1.0 + t * t), sn = t * cs;
  float rx = ex * cs - ey * sn, ry = ex * sn + ey * cs;
  float gx = (A(xp, y).x - A(xm, y).x) * ddx, gy = (A(x, yp).x - A(x, ym).x) * ddy;
  float bs = uBedSlope / sqrt(max(th, SHIELDS_C));
  o.x = qs * (rx - bs * gx);
  o.y = qs * (ry - bs * gy);
}`;

// Through the faces, from the upwind cell; the pump's sand in along the
// top edge, and out to the open sea along the bottom of the bed.
const UPWIND = `float upwind(float a, float b) { return a + b > 0.0 ? max(a, 0.0) : min(b, 0.0); }\n`;
const SED_FX = BHEAD + UPWIND + `
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int fx = p.x, y = p.y;
  float v = 0.0;
  if (y < uHB && fx > 0 && fx < uW) v = upwind(T(fx - 1, y).x, T(fx, y).x);
  o = vec4(v, 0.0, 0.0, 0.0);
}`;
const SED_FY = BHEAD + UPWIND + `
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, fy = p.y;
  float v = 0.0;
  if (fy == 0) v = x >= uX0 && x <= uX1 ? (drownedNow() ? feedLeast() / float(uX1 - uX0 + 1) : uSupply * max(0.0, T(x, 0).y)) : 0.0;
  else if (fy == uHB) v = max(0.0, T(x, uHB - 1).y);
  else if (fy < uHB) v = upwind(T(x, fy - 1).y, T(x, fy).y);
  o = vec4(v, 0.0, 0.0, 0.0);
}`;

const FACES = `
uniform sampler2D uFX, uFY;
float FX(int x, int y) { return texelFetch(uFX, ivec2(x, y), 0).r; }
float FY(int x, int y) { return texelFetch(uFY, ivec2(x, y), 0).r; }
`;

// Each cell's limits: no faster than the bed may change (clip), no more
// out than lies above the rock (avail); and whether it's busy, and held.
const CLIP = BHEAD + FACES + `
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  if (y >= uHB) { o = vec4(1.0, 1.0, 0.0, 0.0); return; }
  float fl = FX(x, y), fr = FX(x + 1, y), ft = FY(x, y), fb = FY(x, y + 1);
  float out_ = max(-fl, 0.0) + max(fr, 0.0) + max(-ft, 0.0) + max(fb, 0.0);
  float inn = max(fl, 0.0) + max(-fr, 0.0) + max(ft, 0.0) + max(-fb, 0.0);
  float mdt = bedTime();
  float change = abs(inn - out_) * per() * mdt;
  float c = 1.0, busy = 0.0, held = 0.0;
  if (change > 1e-6) { busy = 1.0; if (change > uDzMax) { c = uDzMax / change; held = 1.0; } }
  float r = 1.0;
  if (out_ > 0.0) {
    vec4 a = A(x, y);
    float room = a.x - a.y, take = out_ * per() * mdt;
    if (take > room) r = room > 0.0 ? room / take : 0.0;
  }
  o = vec4(c, r, busy, held);
}`;

const LIMITS = `
uniform sampler2D uCL;
vec4 CL(int x, int y) { return texelFetch(uCL, ivec2(x, y), 0); }
float limited(float v, vec4 ci, vec4 cj) { return v * min(ci.x, cj.x) * (v > 0.0 ? ci.y : cj.y); }
`;
const SCALE_FX = BHEAD + FACES + LIMITS + `
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int fx = p.x, y = p.y;
  float v = FX(fx, y);
  if (v != 0.0 && y < uHB && fx > 0 && fx < uW) v = limited(v, CL(fx - 1, y), CL(fx, y));
  o = vec4(v, 0.0, 0.0, 0.0);
}`;
const SCALE_FY = BHEAD + FACES + LIMITS + `
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, fy = p.y;
  float v = FY(x, fy);
  if (v != 0.0) {
    if (fy == 0) v *= CL(x, 0).x;
    else if (fy == uHB) { vec4 c = CL(x, uHB - 1); v *= c.x * c.y; }
    else if (fy < uHB) v = limited(v, CL(x, fy - 1), CL(x, fy));
  }
  o = vec4(v, 0.0, 0.0, 0.0);
}`;

// Exner: the bed rises where more comes in than goes out, the gravel by
// the upwind cell's share. Then the mud settling and lifted. Out: the bed's
// change (dz, its mud, its gravel), the water with its new mud, and the
// counters: (sand fed in, lost to sea, gravel in, out) and (mud settled
// less lifted, mud laid down, busy, held).
const EXNER = BHEAD + FACES + LIMITS + `
uniform float uMudWs, uMudE;
layout(location = 0) out vec4 oDZ;
layout(location = 1) out vec4 oS;
layout(location = 2) out vec4 oCa;
layout(location = 3) out vec4 oCb;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  vec4 s = S(x, y);
  oS = s; oDZ = vec4(0.0); oCa = vec4(0.0); oCb = vec4(0.0);
  if (y >= uHB) return;
  float t = waterTime(), mdt = bedTime(), k = per() * mdt;
  float fl = FX(x, y), fr = FX(x + 1, y), ft = FY(x, y), fb = FY(x, y + 1);
  vec4 tc = T(x, y);
  float gi = tc.w;
  float gL = x > 0 ? T(x - 1, y).w : 0.0, gR = x < uW - 1 ? T(x + 1, y).w : 0.0;
  float gU = y > 0 ? T(x, y - 1).w : gi, gD = T(x, y + 1).w;
  float dz = k * (fl - fr + ft - fb);
  // What the pump feeds drowned has the gravel it has been feeding lately.
  if (y == 0 && x >= uX0 && x <= uX1 && drownedNow()) gU = texelFetch(uBED, ivec2(0), 0).w; else if (y == 0) gU = gi;
  float dzG = k * (fl * (fl > 0.0 ? gL : gi) - fr * (fr > 0.0 ? gi : gR) + ft * (ft > 0.0 ? gU : gi) - fb * (fb > 0.0 ? gi : gD));
  float dzM = 0.0;
  if (y == 0) { oCa.x = ft; oCa.z = ft * gU; }
  if (y == uHB - 1) { oCa.y = fb; oCa.w = fb * gi; }
  // Mud settles through the water, faster among plants, and is lifted
  // where the flow drags at a muddy bed (Flow.mudExchange).
  float d = s.x, m = s.y;
  vec4 b = B(x, y), c = C(x, y);
  float fm = b.x;
  float morph = t > 0.0 ? mdt / t : 1.0;
  float dep = 0.0, ero = 0.0;
  if (m > 0.0) dep = d > WET ? uMudWs * (m / d) * t * (1.0 + MUD_PLANT * c.x + 3.0 * c.y) : m;
  dep = min(dep, m);
  if (fm > 0.0 && d > WET) { float ex = (tc.z * TAU_K) / MUD_TE - 1.0; if (ex > 0.0) ero = uMudE * fm * ex * t; }
  if (dep != 0.0 || ero != 0.0) {
    float bed = (dep - ero) * morph * BULK;
    if (abs(bed) > uDzMax) { float sc = uDzMax / abs(bed); dep *= sc; ero *= sc; bed *= sc; }
    if (bed < 0.0) {
      vec4 a = A(x, y);
      float room = max(0.0, fm * min(LA, a.x + dz - a.y));
      if (-bed > room) { ero = dep + room / (morph * BULK); bed = -room; }
    }
    oS.y = m - dep + ero;
    dz += bed;
    dzM += bed;
    oCb.x = (dep - ero) * uDx * uDx;
    oCb.y = bed * (1.0 - POROSITY) * uDx * uDx;
  }
  vec4 cl = CL(x, y);
  oCb.zw = cl.zw;
  oDZ = vec4(dz, dzM, dzG, 0.0);
}`;

// The banks. A channel scouring at the foot of a dry bank above it pulls
// some of the bank in, and a hard current wears at its banks directly.
// As gathers: each bank adds up what all its neighbours would take, and
// how much of that it can give; then each cell gives and takes.
const BANKS = BHEAD + `
uniform sampler2D uDZ;
uniform float uBank, uBankK, uBankCrit, uRootHold;
float dzAt(int x, int y) { return texelFetch(uDZ, ivec2(x, y), 0).x; }
float roots(int x, int y) { vec4 c = C(x, y); return 1.0 - uRootHold * min(c.x + 2.0 * c.y, 1.0); }
// Whether wet cell (x, y) pulls on its neighbour (jx, jy): a dry bank above it.
bool pulls(int x, int y, int jx, int jy) {
  if (jx < x && x <= 0) return false;
  if (jx > x && x >= uW - 1) return false;
  if (jy < y && y <= 0) return false;
  if (jy > y && y >= uHB - 1) return false;
  return S(jx, jy).x <= WET && A(jx, jy).x > A(x, y).x;
}
// What a wet cell scouring its bed pulls from each bank above it.
float eachAt(int x, int y) {
  if (!inside(x, y) || y >= uHB) return 0.0;
  float e = -dzAt(x, y);
  if (e <= 0.0 || S(x, y).x <= WET) return 0.0;
  int n = 0;
  if (pulls(x, y, x - 1, y)) n++;
  if (pulls(x, y, x + 1, y)) n++;
  if (pulls(x, y, x, y - 1)) n++;
  if (pulls(x, y, x, y + 1)) n++;
  return n > 0 ? uBank * e / float(n) : 0.0;
}
float keepOf(int x, int y) { return roots(x, y) / (1.0 + 2.0 * B(x, y).x); }
// Whether a wet cell drags hard enough at its banks to wear them.
bool wears(int x, int y) {
  if (x < 1 || x > uW - 2 || y < 1 || y >= uHB - 1) return false;
  return S(x, y).x > WET && T(x, y).z > SHIELDS_C * uBankCrit;
}
// What wet cell (x, y) wears from its dry neighbour (jx, jy), whose top
// stands at top; and the room there was.
float wearPair(int x, int y, int jx, int jy, float top, out float room) {
  room = 0.0;
  if (S(jx, jy).x > WET) return 0.0;
  vec4 c = C(jx, jy);
  float ex = T(x, y).z - SHIELDS_C * uBankCrit * (1.0 + 3.0 * c.x + 6.0 * c.y) * (1.0 + 4.0 * B(jx, jy).x);
  if (ex <= 0.0) return 0.0;
  float zi = A(x, y).x + dzAt(x, y);
  room = top - max(zi, A(jx, jy).y);
  if (room <= 0.0) { room = 0.0; return 0.0; }
  float m = uBankK * bedTime() * ex * roots(jx, jy);
  return min(min(m, room), uDzMax);
}
`;
const NB = `ivec2 nb[4] = ivec2[4](ivec2(x - 1, y), ivec2(x + 1, y), ivec2(x, y - 1), ivec2(x, y + 1));\n`;

// Each dry bank: the share of the scour's pull it can give and what it
// gives; the share of the wear it can give and what it gives.
const BANK_GIVE = BANKS + `
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  o = vec4(0.0);
  if (S(x, y).x > WET) return;
  ${NB}
  float pull = 0.0;
  for (int q = 0; q < 4; q++) {
    ivec2 i = nb[q];
    if (inside(i.x, i.y) && pulls(i.x, i.y, x, y)) pull += eachAt(i.x, i.y);
  }
  float want = pull * keepOf(x, y);
  vec4 a = A(x, y);
  float dz = dzAt(x, y);
  float took = min(want, max(0.0, a.x + dz - a.y));
  o.x = want > 0.0 ? took / want : 0.0;
  o.y = took;
  float top = a.x + dz - took, worn = 0.0, most = 0.0;
  for (int q = 0; q < 4; q++) {
    ivec2 i = nb[q];
    if (!inside(i.x, i.y) || !wears(i.x, i.y)) continue;
    float room;
    float m = wearPair(i.x, i.y, x, y, top, room);
    if (m > 0.0) { worn += m; most = max(most, room); }
  }
  o.z = worn > most ? most / worn : 1.0;
  o.w = worn * o.z;
}`;

// Each cell: a bank loses what it gives; a channel gains it, with the
// bank's mud and gravel.
const BANK_TAKE = BANKS + `
uniform sampler2D uBG;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  vec4 dz = texelFetch(uDZ, p, 0);
  if (S(x, y).x <= WET) {
    vec4 g = texelFetch(uBG, p, 0);
    float lose = g.y + g.w;
    if (lose > 0.0) { vec4 b = B(x, y); dz.x -= lose; dz.y -= lose * b.x; dz.z -= lose * b.z; }
    o = dz;
    return;
  }
  float each = eachAt(x, y);
  bool w = wears(x, y);
  ${NB}
  for (int q = 0; q < 4; q++) {
    ivec2 j = nb[q];
    if (!inside(j.x, j.y)) continue;
    vec4 g = texelFetch(uBG, j, 0);
    float gain = 0.0;
    if (each > 0.0 && pulls(x, y, j.x, j.y)) gain += each * keepOf(j.x, j.y) * g.x;
    if (w) { float room; gain += wearPair(x, y, j.x, j.y, A(j.x, j.y).x + dzAt(j.x, j.y) - g.y, room) * g.z; }
    if (gain > 0.0) { vec4 b = B(j.x, j.y); dz.x += gain; dz.y += gain * b.x; dz.z += gain * b.z; }
  }
  o = dz;
}`;

// The ground moves: the bed by its change, the top layer's make-up mixed
// (Hirano), the recent rate of change; then bare rock under fast water
// wears into gravel. Out: A, B and the rock worn.
const APPLY = BHEAD + `
uniform sampler2D uDZ;
uniform float uRockK, uRockP;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;
float zAfter(int x, int y) { return A(x, y).x + texelFetch(uDZ, ivec2(x, y), 0).x; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  vec4 a = A(x, y), b = B(x, y), dz = texelFetch(uDZ, p, 0);
  float d = dz.x;
  if (d != 0.0 || dz.y != 0.0 || dz.z != 0.0) mixLayer(b, a.x, a.y, d, dz.y, dz.z);
  float mdt = bedTime(), years = mdt / SEC_PER_YR;
  float keep = exp(-years / 0.05);
  float rate = years > 0.0 ? (1.0 - keep) / years : 0.0;
  float z = a.x + d, rock = a.y, worn = 0.0;
  float dzRate = a.z * keep + rate * d;
  vec4 s = S(x, y);
  if (y >= 1 && y < uHB - 1 && x >= 1 && x <= uW - 2 && s.x > WET && a.w == 0.0) {
    float sh = z - rock;
    float power = T(x, y).z * TAU_K * sqrt(s.z * s.z + s.w * s.w);
    if (sh < ROCK_SHIELD && power > uRockP) {
      float drop = max(max(z - zAfter(x - 1, y), z - zAfter(x + 1, y)), max(z - zAfter(x, y - 1), z - zAfter(x, y + 1)));
      drop = max(drop, 0.0);
      float dr = min(uRockK * (power - uRockP) * (1.0 + drop / uDx / 0.1) * (1.0 - sh / ROCK_SHIELD) * mdt, uDzMax);
      if (dr > 0.0) {
        float v = dr * BULK;
        if (sh >= LA) {
          float below = sh - LA;
          b.w = (b.w * below + v) / (below + v);
          b.y = (b.y * below) / (below + v);
        } else {
          float h = max(sh, 0.0);
          b.z = (b.z * h + v) / (h + v);
          b.x = (b.x * h) / (h + v);
          b.w = b.z; b.y = b.x;
        }
        rock -= dr;
        z += v - dr;
        worn = dr * uDx * uDx;
      }
    }
  }
  oA = vec4(z, rock, dzRate, a.w);
  oB = b;
  oC = vec4(worn, 0.0, 0.0, 0.0);
}`;

// Slumps: every face works out what slumps across it (from the higher cell,
// positive one way), then each cell gives (no more than lies above its
// rock) and takes, with the giver's mud and gravel.
const SLUMP_FACE = BHEAD + `
float slumpPair(int ix, int iy, int jx, int jy) {
  vec4 ai = A(ix, iy), aj = A(jx, jy);
  float d = ai.x - aj.x, ad = abs(d);
  if (ad <= SLOPE_WET * uDx) return 0.0;
  int hx = d > 0.0 ? ix : jx, hy = d > 0.0 ? iy : jy;
  bool wet = S(ix, iy).x > WET || S(jx, jy).x > WET;
  float fh = B(hx, hy).x;
  vec4 ch = C(hx, hy);
  float crit = (wet ? SLOPE_WET * (1.0 + fh) : SLOPE_DRY * (1.0 + 0.5 * fh)) * (1.0 + ch.x + ch.y) * uDx;
  if (ad <= crit) return 0.0;
  vec4 ah = d > 0.0 ? ai : aj;
  float m = min(((ad - crit) / 2.0) * SLUMP, max(ah.x - ah.y, 0.0));
  return d > 0.0 ? m : -m;
}
uniform int uAcross;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float v = 0.0;
  if (uAcross == 1) { if (p.x > 0 && p.x < uW) v = slumpPair(p.x - 1, p.y, p.x, p.y); }
  else if (p.y > 0 && p.y < uH) v = slumpPair(p.x, p.y - 1, p.x, p.y);
  o = vec4(v, 0.0, 0.0, 0.0);
}`;
const SLUMP_APPLY = BHEAD + `
uniform sampler2D uSX, uSY;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
float sx(int x, int y) { return texelFetch(uSX, ivec2(x, y), 0).r; }
float sy(int x, int y) { return texelFetch(uSY, ivec2(x, y), 0).r; }
float outOf(int x, int y) { return max(-sx(x, y), 0.0) + max(sx(x + 1, y), 0.0) + max(-sy(x, y), 0.0) + max(sy(x, y + 1), 0.0); }
float scaleOf(int x, int y) {
  float o = outOf(x, y);
  if (o <= 0.0) return 1.0;
  vec4 a = A(x, y);
  float room = a.x - a.y;
  return o > room ? max(room, 0.0) / o : 1.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  vec4 a = A(x, y), b = B(x, y);
  float out_ = outOf(x, y);
  if (out_ > 0.0) out_ *= scaleOf(x, y);
  float d = -out_, dm = -out_ * b.x, dg = -out_ * b.z;
  float v = sx(x, y);
  if (v > 0.0) { float g = v * scaleOf(x - 1, y); vec4 k = B(x - 1, y); d += g; dm += g * k.x; dg += g * k.z; }
  v = sx(x + 1, y);
  if (v < 0.0) { float g = -v * scaleOf(x + 1, y); vec4 k = B(x + 1, y); d += g; dm += g * k.x; dg += g * k.z; }
  v = sy(x, y);
  if (v > 0.0) { float g = v * scaleOf(x, y - 1); vec4 k = B(x, y - 1); d += g; dm += g * k.x; dg += g * k.z; }
  v = sy(x, y + 1);
  if (v < 0.0) { float g = -v * scaleOf(x, y + 1); vec4 k = B(x, y + 1); d += g; dm += g * k.x; dg += g * k.z; }
  if (d != 0.0 || dm != 0.0 || dg != 0.0) mixLayer(b, a.x, a.y, d, dm, dg);
  oA = vec4(a.x + d, a.y, a.z, a.w);
  oB = b;
}`;

// Plants drown under standing water, are torn out by hard drag and lost
// where the bed scours; they grow on dry ground now and then; and fields
// are kept planted.
const PLANTS = BHEAD + `
uniform sampler2D uDZ;
uniform int uGrow;
uniform float uGrowth, uGrowYears, uTreeYears;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, y = p.y;
  vec4 c = C(x, y), s = S(x, y);
  float mdt = bedTime(), years = mdt / SEC_PER_YR;
  float cv = c.x, tr = c.y;
  if (s.x > WET) {
    float th = T(x, y).z, dz = texelFetch(uDZ, p, 0).x;
    float drown = min(1.0, years / PLANT_DROWN_YR), drownT = min(1.0, years / TREE_DROWN_YR), rip = min(1.0, mdt / 3600.0);
    if (cv > 0.0) {
      if (s.x > 0.3) cv -= cv * drown;
      if (th > PLANT_UPROOT * SHIELDS_C * (1.0 + 2.0 * cv)) cv -= cv * rip;
      if (dz < -0.002) cv *= 0.5;
      if (cv < 1e-3) cv = 0.0;
    }
    if (tr > 0.0) {
      if (s.x > 0.3) tr -= tr * drownT;
      if (th > TREE_UPROOT * SHIELDS_C * (1.0 + 2.0 * cv + 3.0 * tr)) tr -= tr * rip;
      if (dz < -0.01) tr *= 0.5;
      if (tr < 1e-3) tr = 0.0;
    }
  } else {
    if (uGrow == 1) {
      float yrs = texelFetch(uBED, ivec2(0), 0).y + years;
      float grow = min(1.0, (uGrowth * yrs) / uGrowYears);
      if (grow > 0.0) {
        float growT = min(1.0, (uGrowth * yrs) / uTreeYears);
        if (cv < 1.0) cv += (1.0 - cv) * grow;
        if (cv > 0.5 && tr < 1.0 && mod(c.z, 2.0) < 0.5) tr += (1.0 - tr) * growT * (cv - 0.5) * 2.0;
      }
    }
    if (mod(c.z, 2.0) > 0.5 && cv < FIELD_CROP) cv = FIELD_CROP;
  }
  o = vec4(cv, tr, c.z, c.w);
}`;

// A 4 × 4 sum of three textures at once.
const SUM3 = `#version 300 es
precision highp float;
uniform sampler2D uI0, uI1, uI2;
uniform ivec2 uSize;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 4;
  vec4 a = vec4(0.0), b = vec4(0.0), c = vec4(0.0);
  for (int dy = 0; dy < 4; dy++) for (int dx = 0; dx < 4; dx++) {
    ivec2 q = p + ivec2(dx, dy);
    if (q.x >= uSize.x || q.y >= uSize.y) continue;
    a += texelFetch(uI0, q, 0); b += texelFetch(uI1, q, 0); c += texelFetch(uI2, q, 0);
  }
  o0 = a; o1 = b; o2 = c;
}`;

// The bed's clock and counters. BED = (bed-time factor, plant-years since
// the plants last grew, what the pump has been feeding lately per unit of
// supply and of inflow, the gravel's share of it). The counters since the
// CPU last read them: (bed time, sand to sea, sand fed in, mud laid), (mud
// to sea, mud settled less lifted, gravel in, gravel out), (rock worn,
// water time, mud out of the water to sea, bed steps).
const BEDUP = BHEAD + `
uniform sampler2D uRa, uRb, uRc, uK0, uK1, uK2;
uniform float uHeld;
uniform int uGrow, uAccReset;
layout(location = 0) out vec4 oBED;
layout(location = 1) out vec4 oK0;
layout(location = 2) out vec4 oK1;
layout(location = 3) out vec4 oK2;
void main() {
  ivec2 z = ivec2(0);
  vec4 ra = texelFetch(uRa, z, 0), rb = texelFetch(uRb, z, 0), rc = texelFetch(uRc, z, 0);
  vec4 bed = texelFetch(uBED, z, 0), DT = texelFetch(uDT, z, 0);
  float t = DT.z, m = min(bed.x, uMorph), mdt = t * m;
  float mNew = rb.w > rb.z * uHeld ? max(1.0, m * 0.8) : min(uMorph, m * 1.05 + 0.5);
  float years = mdt / SEC_PER_YR;
  float morph = t > 0.0 ? mdt / t : 1.0;
  // Learning what the pump feeds, while it isn't drowned.
  float local, localG; bool lake;
  inletNow(local, localG, lake);
  float feed = uSupply * uInflow;
  float ema = bed.z, gs = bed.w;
  if (!lake && feed > 0.0) {
    float a = min(1.0, mdt / (FEED_T * SEC_PER_YR));
    ema += (ra.x / feed - ema) * a;
    if (ra.x > 0.0) gs += (ra.z / ra.x - gs) * a;
  }
  oBED = vec4(mNew, uGrow == 1 ? 0.0 : bed.y + years, ema, gs);
  vec4 k0 = uAccReset == 1 ? vec4(0.0) : texelFetch(uK0, z, 0);
  vec4 k1 = uAccReset == 1 ? vec4(0.0) : texelFetch(uK1, z, 0);
  vec4 k2 = uAccReset == 1 ? vec4(0.0) : texelFetch(uK2, z, 0);
  oK0 = k0 + vec4(mdt, ra.y * uDx * mdt, ra.x * uDx * mdt, rb.y);
  oK1 = k1 + vec4(DT.w * morph, rb.x, ra.z * uDx * mdt, ra.w * uDx * mdt);
  oK2 = k2 + vec4(rc.x, t, DT.w, 1.0);
}`;

const INTS = new Set(['uW', 'uH', 'uHB', 'uX0', 'uX1', 'uSeaY', 'uSpongeY', 'uGrow', 'uAccReset', 'uReset', 'uSize', 'uAcross']);

export class GpuRiver {
  constructor(flow) {
    const { W, H, N } = flow;
    this.W = W; this.H = H; this.N = N;
    const gl = this.gl = context();
    let ids = 0;
    const tex = (w, h, c, data = null) => { const t = texture(gl, w, h, c, data); t.id = ++ids; return t; };
    const P = (fs) => program(gl, fs);
    const ws = WATER_SHADERS;
    this.progs = {
      fx: P(ws.FACE_X), fy: P(ws.FACE_Y), state: P(ws.STATE), reduce: P(ws.REDUCE), step: P(ws.STEP),
      transport: P(TRANSPORT), sedFx: P(SED_FX), sedFy: P(SED_FY), clip: P(CLIP), scaleFx: P(SCALE_FX), scaleFy: P(SCALE_FY),
      exner: P(EXNER), bankGive: P(BANK_GIVE), bankTake: P(BANK_TAKE), apply: P(APPLY), slumpFace: P(SLUMP_FACE), slumpApply: P(SLUMP_APPLY),
      plants: P(PLANTS), sum3: P(SUM3), bedup: P(BEDUP),
    };
    const two = (w, h, c) => [tex(w, h, c), tex(w, h, c)];
    // The world (ping-ponged where written).
    this.S = two(W, H, 4); this.A = two(W, H, 4); this.B = two(W, H, 4); this.C = two(W, H, 4);
    this.QX = two(W + 1, H, 1); this.QY = two(W, H + 1, 1); this.DT = two(1, 1, 4);
    this.BED = two(1, 1, 4); this.K = [[tex(1, 1, 4), tex(1, 1, 4), tex(1, 1, 4)], [tex(1, 1, 4), tex(1, 1, 4), tex(1, 1, 4)]];
    // Scratch for the passes.
    this.R = tex(W, H, 4);
    this.T = tex(W, H, 4);
    this.FX = tex(W + 1, H, 1); this.FY = tex(W, H + 1, 1); this.FX2 = tex(W + 1, H, 1); this.FY2 = tex(W, H + 1, 1);
    this.CL = tex(W, H, 4); this.DZ = tex(W, H, 4); this.DZ2 = tex(W, H, 4); this.BG = tex(W, H, 4);
    this.Ca = tex(W, H, 4); this.Cb = tex(W, H, 4); this.Cc = tex(W, H, 4);
    this.SX = tex(W + 1, H, 1); this.SY = tex(W, H + 1, 1);
    const wc = new Float32Array((BEDK.WC_N + 1) * 2);
    for (let k = 0; k <= BEDK.WC_N; k++) { wc[k * 2] = BEDK.WC_SAND[k]; wc[k * 2 + 1] = BEDK.WC_GRAVEL[k]; }
    this.WC = tex(BEDK.WC_N + 1, 1, 2, wc);
    this.reduceR = [];
    this.reduceC = [];
    for (let w = W, h = H; w > 1 || h > 1;) {
      w = Math.ceil(w / 4); h = Math.ceil(h / 4);
      this.reduceR.push(tex(w, h, 4));
      this.reduceC.push([tex(w, h, 4), tex(w, h, 4), tex(w, h, 4)]);
    }
    this.fbs = new Map();
    // Which of each pair is current.
    this.q = 0;      // QX, QY, DT
    this.s = 0;      // S
    this.g = 0;      // A and B (always written together)
    this.c = 0;      // C
    this.b = 0;      // BED and the counters
    this.reset = 0;  // the water's clock starts again on the next step
    this.accReset = 0;
    this.accSince = 0;   // bed steps since the counters were last read
    // How far ahead of the GPU the CPU may get, in steps, and marks of how far it's got.
    this.issued = 0; this.done = 0; this.fenced = 0; this.fences = [];
    this.ahead = 32;
    this.stepsPerSec = 0;
    this.lastTick = 0; this.lastDone = 0;
    this.blocking = false;   // wait for the GPU instead of stopping (tests, and running to a year)
    this.bedSince = 0;
    // Bed time: estimated per step, set right as the counters come back.
    this.estSince = 0; this.owed = 0;
    // Reading the world back without waiting.
    this.names = ['S', 'A', 'B', 'C', 'T'];
    this.pbo = this.names.map(() => { const b = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b); gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 16, gl.STREAM_READ); return b; });
    this.pboSmall = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboSmall);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16 * 5, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.got = this.names.map(() => new Float32Array(W * H * 4));
    this.gotSmall = new Float32Array(20);
    this.pending = null;
    this.lastRead = -Infinity;
    this.readIssued = -1;
    this.buf = new Float32Array(W * H * 4);
    this.load(flow);
  }

  fb(...ts) {
    const key = ts.map((t) => t.id).join(',');
    let fb = this.fbs.get(key);
    if (!fb) { fb = target(this.gl, ...ts); this.fbs.set(key, fb); }
    return fb;
  }

  // Sets a program's uniforms from this.U (and any extras).
  pass(name, out, textures, extra) {
    const gl = this.gl, U = this.U;
    run(gl, this.progs[name], Array.isArray(out) ? this.fb(...out) : this.fb(out), textures, (u) => {
      for (const k in u) {
        const v = extra && extra[k] !== undefined ? extra[k] : U[k];
        if (v === undefined) continue;
        if (Array.isArray(v)) { if (INTS.has(k)) gl.uniform2i(u[k], v[0], v[1]); else gl.uniform2f(u[k], v[0], v[1]); }
        else if (INTS.has(k)) gl.uniform1i(u[k], v); else gl.uniform1f(u[k], v);
      }
    });
    if (this.debug) { const e = gl.getError(); if (e) throw new Error(`GL error ${e} in the ${name} pass`); }
  }

  // Sends the CPU's whole world up.
  load(flow) {
    const { gl, N } = this;
    const b = this.buf;
    const pack = (t, a0, a1, a2, a3) => {
      for (let i = 0; i < N; i++) { b[i * 4] = a0[i]; b[i * 4 + 1] = a1[i]; b[i * 4 + 2] = a2[i]; b[i * 4 + 3] = a3[i]; }
      upload(gl, t, b);
    };
    pack(this.S[this.s], flow.h, flow.M, flow.ux, flow.uy);
    pack(this.A[this.g], flow.z, flow.rock, flow.dzRate, flow.placed);
    pack(this.B[this.g], flow.fm, flow.sm, flow.fg, flow.sg);
    pack(this.C[this.c], flow.cover, flow.trees, this.clear(flow), flow.z0);
    upload(gl, this.QX[this.q], flow.qx);
    upload(gl, this.QY[this.q], flow.qy);
    upload(gl, this.DT[this.q], new Float32Array([flow.dt, flow.dtPrev || flow.dt, flow.waterTime, Math.max(0, flow.mudOut - flow.mudMark)]));
    upload(gl, this.BED[this.b], new Float32Array([flow.mNow, flow.plantYears, flow.feedEma, flow.feedGs]));
    for (const k of this.K[this.b]) upload(gl, k, new Float32Array(4));
    this.reset = 0; this.accReset = 0; this.accSince = 0; this.estSince = 0; this.bedSince = 0;
  }

  // C's third channel: kept clear of trees (1), and in a reservoir (+2).
  clear(flow) {
    const out = this.clearBuf || (this.clearBuf = new Float32Array(this.N));
    for (let i = 0; i < this.N; i++) out[i] = flow.noTrees[i] + 2 * flow.still[i];
    return out;
  }

  // Uniforms for this step: the world's settings and the tunables.
  uniforms(flow, morph) {
    const { W, H } = this;
    const x0 = Math.max(0, Math.round(flow.inletX - flow.inletHalf)), x1 = Math.min(W - 1, Math.round(flow.inletX + flow.inletHalf));
    this.U = {
      uW: W, uH: H, uHB: H - SPONGE, uDx: flow.dx, uPW: [WATER.N_PLANT, WATER.N_TREE],
      uSeaY: flow.seaY, uSpongeY: H - SPONGE, uSea: flow.sea, uSeaT: TUNE.seaDamp, uStillT: TUNE.stillDamp,
      uCin: flow.mudIn, uRain: flow.rainRate, uSoak: WATER.INFILTRATE, uFrMax: TUNE.frMax,
      uX0: x0, uX1: x1, uQin: flow.inflow / ((x1 - x0 + 1) * flow.dx), uCfl: WATER.CFL, uMaxDt: WATER.MAX_DT,
      uMorph: morph, uSupply: flow.supply, uInflow: flow.inflow, uDzMax: TUNE.dzMax, uHeld: TUNE.held,
      uSpiral: TUNE.spiral, uBedSlope: TUNE.bedSlope, uTransport: TUNE.transport, uMudWs: TUNE.mudWs, uMudE: TUNE.mudE,
      uBank: TUNE.bank, uBankK: TUNE.bankK, uBankCrit: TUNE.bankCrit, uRootHold: TUNE.rootHold,
      uRockK: TUNE.rockK, uRockP: TUNE.rockP, uGrowth: flow.growth, uGrowYears: TUNE.growYears, uTreeYears: TUNE.treeYears,
    };
  }

  // One water step (Flow.water()).
  water() {
    const c = this.q, n = 1 - c, sc = this.s, sn = 1 - sc;
    const world = { uS: this.S[sc], uZ: this.A[this.g], uP: this.C[this.c], uQX: this.QX[c], uQY: this.QY[c], uDT: this.DT[c] };
    this.pass('fx', this.QX[n], world);
    this.pass('fy', this.QY[n], world);
    this.pass('state', [this.S[sn], this.R], { ...world, uQX: this.QX[n], uQY: this.QY[n] });
    let src = this.R;
    for (const t of this.reduceR) { this.pass('reduce', t, { uIn: src }, { uSize: [src.w, src.h] }); src = t; }
    this.pass('step', this.DT[n], { uR: src, uDT: this.DT[c] }, { uReset: this.reset });
    this.reset = 0;
    this.q = n; this.s = sn;
  }

  // One move of the bed (Flow.bed()), over the water time since the last.
  bed(grow) {
    const g = this.g, gn = 1 - g, sn = 1 - this.s;
    const w = { uS: this.S[this.s], uA: this.A[g], uB: this.B[g], uC: this.C[this.c], uDT: this.DT[this.q], uBED: this.BED[this.b] };
    this.pass('transport', this.T, { ...w, uWC: this.WC });
    w.uT = this.T;
    this.pass('sedFx', this.FX, w);
    this.pass('sedFy', this.FY, w);
    this.pass('clip', this.CL, { ...w, uFX: this.FX, uFY: this.FY });
    this.pass('scaleFx', this.FX2, { ...w, uFX: this.FX, uFY: this.FY, uCL: this.CL });
    this.pass('scaleFy', this.FY2, { ...w, uFX: this.FX, uFY: this.FY, uCL: this.CL });
    this.pass('exner', [this.DZ, this.S[sn], this.Ca, this.Cb], { ...w, uFX: this.FX2, uFY: this.FY2, uCL: this.CL });
    this.s = sn;
    w.uS = this.S[sn];
    this.pass('bankGive', this.BG, { ...w, uDZ: this.DZ });
    this.pass('bankTake', this.DZ2, { ...w, uDZ: this.DZ, uBG: this.BG });
    this.pass('apply', [this.A[gn], this.B[gn], this.Cc], { ...w, uDZ: this.DZ2 });
    w.uA = this.A[gn]; w.uB = this.B[gn];
    this.pass('slumpFace', this.SX, w, { uAcross: 1 });
    this.pass('slumpFace', this.SY, w, { uAcross: 0 });
    this.pass('slumpApply', [this.A[g], this.B[g]], { ...w, uSX: this.SX, uSY: this.SY });
    w.uA = this.A[g]; w.uB = this.B[g];
    const cn = 1 - this.c;
    this.pass('plants', this.C[cn], { ...w, uDZ: this.DZ2 }, { uGrow: grow ? 1 : 0 });
    this.c = cn;
    let src = [this.Ca, this.Cb, this.Cc];
    for (const t of this.reduceC) { this.pass('sum3', t, { uI0: src[0], uI1: src[1], uI2: src[2] }, { uSize: [src[0].w, src[0].h] }); src = t; }
    const bn = 1 - this.b, K = this.K[this.b];
    this.pass('bedup', [this.BED[bn], ...this.K[bn]], { uRa: src[0], uRb: src[1], uRc: src[2], uBED: this.BED[this.b], uDT: this.DT[this.q], uK0: K[0], uK1: K[1], uK2: K[2], uS: this.S[this.s], uT: this.T },
      { uGrow: grow ? 1 : 0, uAccReset: this.accReset });
    this.accReset = 0;
    this.accSince++;
    this.b = bn;
    this.reset = 1;
  }

  // Marks of how far the GPU has got. (A mark's state only changes between
  // the worker's tasks.)
  checkFences() {
    const gl = this.gl;
    while (this.fences.length && gl.getSyncParameter(this.fences[0].sync, gl.SYNC_STATUS) === gl.SIGNALED) {
      const f = this.fences.shift();
      gl.deleteSync(f.sync);
      this.done = f.steps;
    }
  }

  // Waits for the GPU to catch up.
  drain() {
    read(this.gl, this.DT[this.q], new Float32Array(4));
    for (const f of this.fences) this.gl.deleteSync(f.sync);
    this.fences.length = 0;
    this.done = this.issued;
  }

  // Once a task, before stepping: how far the GPU got since last time, and
  // how far ahead to let the CPU run (more while the GPU runs dry, less while
  // it falls behind).
  tick(now) {
    this.checkFences();
    const pending = this.issued - this.done;
    if (pending === 0 && this.stalled) this.ahead = Math.min(4096, Math.ceil(this.ahead * 1.25));
    else if (pending > this.ahead * 0.75 && this.done === this.lastDone) this.ahead = Math.max(8, Math.floor(this.ahead * 0.9));
    if (this.lastTick) {
      const dt = now - this.lastTick;
      if (dt > 0 && this.done > this.lastDone) this.stepsPerSec += (((this.done - this.lastDone) * 1000) / dt - this.stepsPerSec) * Math.min(1, dt / 500);
    }
    this.lastTick = now; this.lastDone = this.done;
    this.stalled = false;
  }

  // One step of the river: the water, and every BED_EVERY steps the bed.
  // Returns the bed time it stood for, seconds (estimated, put right as the
  // counters come back), or 0 with flow.gpuStalled set when the CPU is too
  // far ahead of the GPU.
  step(flow, morph) {
    if (flow.gpuDirty) { this.load(flow); flow.gpuDirty = false; }
    if (this.issued - this.done >= this.ahead) {
      if (!this.blocking) { this.stalled = true; flow.gpuStalled = true; return 0; }
      this.drain();
    }
    flow.gpuStalled = false;
    this.uniforms(flow, morph);
    this.water();
    flow.steps++;
    this.issued++;
    if (this.issued - this.fenced >= FENCE_EVERY) {
      const gl = this.gl;
      this.fences.push({ sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), steps: this.issued });
      gl.flush();
      this.fenced = this.issued;
    }
    if (!flow.sediment || flow.steps % BEDK.BED_EVERY !== 0) return 0;
    this.bed(flow.steps % BEDK.PLANT_EVERY === 0);
    const est = flow.dt * BEDK.BED_EVERY * Math.min(flow.mNow, morph);
    this.estSince += est;
    let r = est + this.owed;
    if (r < 0) { this.owed = r; r = 0; } else this.owed = 0;
    // Waiting anyway: bring the world back every so often, as the CPU's own
    // bed checks for landslides.
    if (this.blocking && ++this.bedSince >= 32) { this.bedSince = 0; this.pull(flow); }
    return r;
  }

  glCheck(where) { if (this.debug) { const e = this.gl.getError(); if (e) throw new Error(`GL error ${e} in ${where}`); } }

  // Starts reading the world back.
  startRead() {
    const { gl, W, H } = this;
    const tex = { S: this.S[this.s], A: this.A[this.g], B: this.B[this.g], C: this.C[this.c], T: this.T };
    this.names.forEach((name, k) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb(tex[name]));
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[k]);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, 0);
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboSmall);
    [this.BED[this.b], ...this.K[this.b], this.DT[this.q]].forEach((t, k) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb(t));
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, k * 16);
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fresh = this.accSince > 0;
    if (fresh) { this.accReset = 1; this.accSince = 0; }
    this.pending = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), fresh, est: this.estSince };
    this.estSince = 0;
    gl.flush();
    this.readIssued = this.issued;
    this.glCheck('startRead');
  }

  // Finishes a read (waiting if it must) into the CPU's world.
  finishRead(flow) {
    const { gl, N } = this;
    const r = this.pending;
    this.pending = null;
    gl.deleteSync(r.sync);
    this.names.forEach((_, k) => { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[k]); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.got[k]); });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboSmall);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.gotSmall);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.glCheck('finishRead');
    const [S, A, B, C, T] = this.got;
    const { h, M, ux, uy, z, rock, dzRate, fm, sm, fg, sg, cover, trees, sx, sy, theta, gs } = flow;
    for (let i = 0, k = 0; i < N; i++, k += 4) {
      h[i] = S[k]; M[i] = S[k + 1]; ux[i] = S[k + 2]; uy[i] = S[k + 3];
      z[i] = A[k]; rock[i] = A[k + 1]; dzRate[i] = A[k + 2];
      fm[i] = B[k]; sm[i] = B[k + 1]; fg[i] = B[k + 2]; sg[i] = B[k + 3];
      cover[i] = C[k]; trees[i] = C[k + 1];
      sx[i] = T[k]; sy[i] = T[k + 1]; theta[i] = T[k + 2]; gs[i] = T[k + 3];
    }
    const s = this.gotSmall;
    flow.mNow = s[0]; flow.plantYears = s[1]; flow.feedEma = s[2]; flow.feedGs = s[3];
    flow.dt = s[16]; flow.dtPrev = s[17]; flow.waterTime = s[18];
    flow.mudMark = flow.mudOut - s[19];
    if (r.fresh) {
      const [mdt, toSea, fedIn, mudLaid, mudSea, mudDown, gIn, gOut, worn, water, mudOut] = s.subarray(4, 15);
      flow.fedIn += fedIn; flow.toSea += toSea; flow.mudLaid += mudLaid;
      flow.mudSea += mudSea; flow.mudDown += mudDown; flow.gravelIn += gIn; flow.gravelOut += gOut;
      flow.rockWorn += worn; flow.mudOut += mudOut; flow.mudMark += mudOut;
      flow.mudFed += flow.inflow * flow.mudIn * water;
      flow.slideYears += mdt / SEC_PER_YR;
      if (water > 0) flow.morph = mdt / water;
      this.owed += mdt - r.est;
      flow.folded = true;
    } else this.estSince += r.est;
    this.landslides(flow);
  }

  // Landslides, on the CPU from the world just read; the patches that fell
  // go back up.
  landslides(flow) {
    if (flow.slideYears <= 0) return;
    const from = flow.slidAt.length;
    flow.landslides(flow.slideYears);
    flow.slideYears = 0;
    const { gl, W, H } = this;
    const clear = this.clear(flow);
    for (let n = from; n < flow.slidAt.length; n++) {
      const i = flow.slidAt[n];
      const cx = i % W, cy = (i / W) | 0;
      const x0 = Math.max(0, cx - 3), y0 = Math.max(0, cy - 3), x1 = Math.min(W - 1, cx + 3), y1 = Math.min(H - 1, cy + 3);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const put = (t, a0, a1, a2, a3) => {
        const b = new Float32Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const j = (y0 + y) * W + x0 + x, k = (y * w + x) * 4;
          b[k] = a0[j]; b[k + 1] = a1[j]; b[k + 2] = a2[j]; b[k + 3] = a3[j];
        }
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.FLOAT, b);
      };
      put(this.A[this.g], flow.z, flow.rock, flow.dzRate, flow.placed);
      put(this.B[this.g], flow.fm, flow.sm, flow.fg, flow.sg);
      put(this.C[this.c], flow.cover, flow.trees, clear, flow.z0);
    }
  }

  // Now and then, without waiting: the world as the GPU last had it, for the
  // page. Returns whether anything new came in.
  poll(flow, now) {
    let got = false;
    if (this.pending && this.gl.getSyncParameter(this.pending.sync, this.gl.SYNC_STATUS) === this.gl.SIGNALED) { this.finishRead(flow); got = true; }
    if (!this.pending && !flow.gpuDirty && now - this.lastRead >= POLL_MS && this.issued !== this.readIssued) {
      this.startRead();
      this.lastRead = now;
    }
    return got;
  }

  // Everything as it is now, waiting for it: for a save, a tool, or
  // handing the river back to the CPU.
  pull(flow) {
    if (flow.gpuDirty) return;   // the CPU's copy is the newer
    if (this.pending) this.finishRead(flow);
    this.startRead();
    this.finishRead(flow);
    read(this.gl, this.QX[this.q], flow.qx);
    read(this.gl, this.QY[this.q], flow.qy);
    this.glCheck('pull');
    for (const f of this.fences) this.gl.deleteSync(f.sync);
    this.fences.length = 0;
    this.done = this.issued;
  }

  // Sets the bed's speed-up (after a brush lifts, it builds back from 1).
  setMNow(flow, v) {
    this.pull(flow);
    flow.mNow = v;
    flow.gpuDirty = true;
  }

  // A texture's contents, by name, for tests.
  peek(name) {
    const t = Array.isArray(this[name]) ? this[name][{ S: this.s, A: this.g, B: this.g, C: this.c, QX: this.q, QY: this.q, DT: this.q, BED: this.b }[name]] : this[name];
    return read(this.gl, t, new Float32Array(t.w * t.h * t.channels));
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
