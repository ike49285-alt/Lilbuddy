// rng.js — every random number in Chronicle comes from here.
//
// The world is a pure function of its seed. That is not a nicety: the archive
// deliberately destroys old history (see memory.js), and replaying from the seed
// is the only way to get it back. So Math.random() must never appear anywhere in
// the simulation or worldgen — if it does, deep time becomes unrecoverable.
//
// One deliberate, narrow exception: sim.js's `realChance()`, used only for the
// house-learning war-trigger roll. That single call is real, not seeded, by
// explicit product decision — a house's learned behaviour is allowed to make
// the world genuinely unrepeatable. Because of it, "load" no longer means
// "replay the seed" (see saveCurrentWorld/loadSave in app.js, which snapshot
// live state instead) — but every other roll in the simulation still goes
// through this file, and old history is still recoverable by replay up to
// the point that roll first fires differently.

// Hashes a string into four 32-bit values suitable for seeding sfc32.
export function cyrb128(str) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

// sfc32 — small, fast, and good enough that the world doesn't visibly repeat.
// Chosen over a bare LCG because expansion and war both sample it heavily every
// tick, and LCG low-bit correlation shows up as striping in the borders.
export function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// A small convenience layer over the raw generator. `fork` derives an
// independent stream from a label, so worldgen can draw from its own stream
// without shifting the sequence the tick loop sees — which keeps a world's
// terrain stable even if the sim's sampling pattern changes.
export function makeRng(seed) {
  const [a, b, c, d] = cyrb128(String(seed));
  const next = sfc32(a, b, c, d);
  return {
    seed: String(seed),
    next,
    // Integer in [0, n).
    int: (n) => Math.floor(next() * n),
    // Float in [lo, hi).
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    // Roughly normal via the sum of four uniforms; cheaper than Box-Muller and
    // the tails don't matter for what it's used on (lifespans, harvest noise).
    normal: (mean = 0, sd = 1) =>
      mean + sd * ((next() + next() + next() + next() - 2) * 1.2247),
    // Weighted pick over an array of {w} or a parallel weight array.
    weighted: (weights) => {
      let total = 0;
      for (let i = 0; i < weights.length; i++) total += weights[i];
      if (total <= 0) return Math.floor(next() * weights.length);
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return i;
      }
      return weights.length - 1;
    },
    fork: (label) => makeRng(`${seed}/${label}`),
  };
}

// ---------------------------------------------------------------------------
// Value noise
// ---------------------------------------------------------------------------

// A permutation table gives us a hash from lattice coordinates without storing
// per-coordinate state, so noise can be sampled at any resolution later.
function permutation(rng) {
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  return p;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

// Returns a sampler in [-1, 1]. Value noise rather than gradient/Perlin: the
// terrain is read per-cell at ~2000 scattered sites, not per-pixel, so Perlin's
// smoother gradients buy nothing visible and cost more per sample.
export function makeNoise2D(rng) {
  const p = permutation(rng);
  const hash = (x, y) => p[(p[x & 255] + y) & 255] / 255;
  return function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = fade(xf);
    const v = fade(yf);
    const n00 = hash(xi, yi);
    const n10 = hash(xi + 1, yi);
    const n01 = hash(xi, yi + 1);
    const n11 = hash(xi + 1, yi + 1);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 2 - 1;
  };
}

// Fractal Brownian motion over a noise sampler.
export function fbm(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// Order-independent 32-bit digest, used by the tests to assert that two runs of
// the same seed produced the same history.
export function hashNumbers(values) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < values.length; i++) {
    h ^= values[i] | 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
