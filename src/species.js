// species.js — what a species is, what it's called, and what it looks like.
//
// Traits are all 0..1:
//   habitat     0 water … 1 land
//   salinity    0 fresh … 1 marine
//   tempOpt     maps to −10 … 35 °C
//   tempTol     maps to a tolerance width of 5 … 18 °C
//   complexity  0 microbial … 1 large, slow-growing and competitive
//   dispersal   how fast it spreads, and how easily it crosses a big river
//   hue         a neutral marker that drifts — its colour on the map

export const TRAITS = ['habitat', 'salinity', 'tempOpt', 'tempTol', 'complexity', 'dispersal', 'hue'];

export const LAND_COMPLEXITY = 0.3;      // roots and a waxy skin: nothing below this lives out of water

export const tempOptC = (t) => -10 + 45 * t;
export const tempWidthC = (t) => 5 + 13 * t;
export const toTempTrait = (c) => Math.max(0, Math.min(1, (c + 10) / 45));

const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Reflect off the walls rather than pile up against them. With a floor at
// zero this is what gives complexity its slow, passive upward drift.
const reflect01 = (v) => {
  let x = v;
  if (x < 0) x = -x;
  if (x > 1) x = 2 - x;
  return clamp01(x);
};

// How much of a species' life is spent in fresh water, the sea, and on land.
export function realms(t) {
  const gate = clamp01((t.complexity - (LAND_COMPLEXITY - 0.04)) / 0.08);
  return {
    fresh: (1 - t.habitat) * (1 - t.salinity),
    sea: (1 - t.habitat) * t.salinity,
    land: t.habitat * gate * gate * (3 - 2 * gate),
  };
}

export function mutate(rng, traits, sd, innovate) {
  const t = { ...traits };
  for (const k of TRAITS) {
    if (k === 'hue') continue;
    t[k] = reflect01(t[k] + rng.normal(0, sd));
  }
  t.hue = (traits.hue + rng.normal(0, sd * 1.5) + 1) % 1;
  if (innovate) {
    // A key innovation: one big step that opens a new way of life — toward
    // land, between fresh and salt water, or toward a more complex body.
    const which = rng.int(3);
    if (which === 0) t.habitat = clamp01(t.habitat + rng.range(0.15, 0.4));
    else if (which === 1) t.salinity = clamp01(t.salinity + rng.range(-0.5, 0.5));
    else t.complexity = clamp01(t.complexity + rng.range(0.03, 0.09));
    t.hue = (t.hue + rng.range(0.12, 0.3)) % 1;
  }
  return t;
}

export function traitDistance(a, b) {
  return Math.hypot(a.habitat - b.habitat, a.salinity - b.salinity,
    a.tempOpt - b.tempOpt, a.complexity - b.complexity);
}

// --- names -----------------------------------------------------------------

const ONSETS = ['v', 'k', 'th', 'm', 'r', 's', 'l', 'n', 'p', 'dr', 'gl', 'br', 'h', 'z', 'cr', 'st', 'ph', 'tr'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'y'];
const CODAS = ['', '', 'n', 'r', 's', 'l', 'x', 'th', 'm'];
const GENUS_END = ['us', 'a', 'ia', 'on', 'ella', 'ites', 'ax', 'ops'];
const EPITHETS = ['fluvialis', 'riparia', 'minor', 'major', 'montana', 'litoralis', 'glacialis',
  'lenta', 'velox', 'obscura', 'aurea', 'borealis', 'australis', 'deltae', 'profunda', 'gracilis',
  'robusta', 'antiqua', 'nova', 'rubra', 'viridis', 'lacustris', 'marina', 'saxatilis'];

function syllable(rng) {
  return rng.pick(ONSETS) + rng.pick(VOWELS) + rng.pick(CODAS);
}

export function genusName(rng) {
  const g = syllable(rng) + (rng.chance(0.5) ? syllable(rng) : '') + rng.pick(GENUS_END);
  return g.charAt(0).toUpperCase() + g.slice(1);
}

export function epithet(rng) {
  return rng.pick(EPITHETS);
}

// --- form labels -----------------------------------------------------------

// A plain-language description from the traits. Labels, not taxonomy.
export function formOf(t) {
  const c = t.complexity;
  const r = realms(t);
  if (r.land > 0.05 && t.habitat < 0.6) return 'marsh plants';
  if (r.land > 0.05) return c < 0.42 ? 'mosses' : c < 0.55 ? 'ferns' : c < 0.7 ? 'shrubland' : 'forest';
  const marine = t.salinity > 0.5;
  if (c < 0.12) return marine ? 'plankton' : 'microbial mats';
  if (c < 0.24) return marine ? 'seaweed' : 'algae';
  return marine ? 'kelp' : 'waterweed';
}

export function isLandPlant(t) {
  return realms(t).land > 0.05;
}
