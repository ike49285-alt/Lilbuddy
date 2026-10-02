// rng.js — every random number in Headwaters comes from here.
//
// A world is a pure function of its seed, and a saved snapshot carries the
// generator's state, so loading and running on matches an uninterrupted run
// exactly. Math.random() must never appear in the simulation.

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

// sfc32 over an explicit state array, so the state can be saved and restored.
export function sfc32(s) {
  return function () {
    let a = s[0], b = s[1], c = s[2], d = s[3];
    d = (d + 1) | 0;
    const t = (((a + b) | 0) + d) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    s[0] = a; s[1] = b; s[2] = c; s[3] = d;
    return (t >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const state = new Uint32Array(cyrb128(String(seed)));
  const next = sfc32(state);
  return {
    seed: String(seed),
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + next() * (hi - lo),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    // Roughly normal via the sum of four uniforms.
    normal: (mean = 0, sd = 1) =>
      mean + sd * ((next() + next() + next() + next() - 2) * 1.2247),
    // An independent stream derived from a label, so worldgen draws don't
    // shift the sequence the step loop sees.
    fork: (label) => makeRng(`${seed}/${label}`),
    getState: () => Array.from(state),
    setState: (arr) => { for (let i = 0; i < 4; i++) state[i] = arr[i] >>> 0; },
  };
}

// ---------------------------------------------------------------------------
// Value noise
// ---------------------------------------------------------------------------

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

// Returns a sampler in [-1, 1].
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

// FNV-1a over the raw bytes of typed arrays — the tests' determinism check.
export function hashArrays(arrays) {
  let h = 2166136261 >>> 0;
  for (const arr of arrays) {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}
