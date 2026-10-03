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
//
// Animals carry more:
//   diet        0 filters the tiny stuff (plankton, microbes) … 1 grazes the
//               larger plants (seaweed, waterweed, and on land, everything)
//   limbs       0 fins … 1 legs that carry the body on land
//   lungs       0 gills only … 1 breathes air
//   eggs        0 eggs laid in water … 1 shelled eggs laid on dry land
//   warm        0 cold-blooded … 1 warm-blooded
//
// and plants one:
//   seeds       0 spores, which need damp ground … 1 seeds and flowers

export const TRAITS = ['habitat', 'salinity', 'tempOpt', 'tempTol', 'complexity', 'dispersal', 'hue'];

export const ANIMAL_TRAITS = ['diet', 'limbs', 'lungs', 'eggs', 'warm'];
export const PLANT_TRAITS = ['seeds'];
export const SHELLED = 0.6;              // eggs this far along can be laid on dry land
export const SEEDED = 0.4;               // seeds this far along free a plant from damp ground

// Fills in traits a species from before they existed lacks.
export function withDefaults(t) {
  for (const k of t.animal ? ANIMAL_TRAITS : PLANT_TRAITS) if (t[k] == null) t[k] = 0;
  return t;
}

export const LAND_COMPLEXITY = 0.3;      // roots and a waxy skin: nothing below this lives out of water
export const WALK = 0.6;                 // limbs and lungs both about here: an animal can live out of water

export const tempOptC = (t) => -10 + 45 * t;
export const tempWidthC = (t) => 5 + 13 * t;
export const toTempTrait = (c) => Math.max(0, Math.min(1, (c + 10) / 45));

export const clamp01 = (v) => Math.max(0, Math.min(1, v));
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
  // Plants need the complexity for roots; animals need legs and lungs both.
  const gate = t.animal
    ? clamp01((Math.min(t.limbs, t.lungs) - (WALK - 0.08)) / 0.16)
    : clamp01((t.complexity - (LAND_COMPLEXITY - 0.04)) / 0.08);
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
  if (traits.animal) {
    for (const k of ANIMAL_TRAITS) t[k] = reflect01((t[k] || 0) + rng.normal(0, sd));
    if (innovate) {
      // A key innovation for an animal: toward the shore, between fresh and
      // salt water, a bigger, more complex body, a change of food, a step
      // toward legs or lungs, eggs that can be laid on land, or warm blood.
      const which = rng.int(8);
      if (which === 0) t.habitat = clamp01(t.habitat + rng.range(0.1, 0.3));
      else if (which === 1) t.salinity = clamp01(t.salinity + rng.range(-0.5, 0.5));
      else if (which === 2) t.complexity = clamp01(t.complexity + rng.range(0.05, 0.15));
      else if (which === 3) t.diet = clamp01(t.diet + rng.range(-0.4, 0.4));
      else if (which === 4) t.limbs = clamp01(t.limbs + rng.range(0.1, 0.25));
      else if (which === 5) t.lungs = clamp01(t.lungs + rng.range(0.1, 0.25));
      else if (which === 6) t.eggs = clamp01(t.eggs + rng.range(0.15, 0.3));
      else t.warm = clamp01(t.warm + rng.range(0.15, 0.3));
      t.hue = (t.hue + rng.range(0.12, 0.3)) % 1;
    }
    // They come in order: eggs for dry land only once an animal can walk,
    // warm blood only once it lays them.
    const walks = Math.min(t.limbs, t.lungs) >= WALK;
    if (!walks) t.eggs = Math.min(t.eggs, traits.eggs || 0);
    if (t.eggs < SHELLED) t.warm = Math.min(t.warm, traits.warm || 0);
    return t;
  }
  t.seeds = reflect01((t.seeds || 0) + rng.normal(0, sd));
  if (innovate) {
    // A key innovation: one big step that opens a new way of life — toward
    // land, between fresh and salt water, or toward a more complex body.
    const which = rng.int(4);
    if (which === 0) t.habitat = clamp01(t.habitat + rng.range(0.15, 0.4));
    else if (which === 1) t.salinity = clamp01(t.salinity + rng.range(-0.5, 0.5));
    else if (which === 2) t.complexity = clamp01(t.complexity + rng.range(0.03, 0.09));
    else t.seeds = clamp01(t.seeds + rng.range(0.1, 0.25));
    t.hue = (t.hue + rng.range(0.12, 0.3)) % 1;
  }
  // Seeds only matter, and only evolve, in plants already on land.
  if (realms(traits).land <= 0.05) t.seeds = Math.min(t.seeds, traits.seeds || 0);
  return t;
}

export function traitDistance(a, b) {
  const base = Math.hypot(a.habitat - b.habitat, a.salinity - b.salinity,
    a.tempOpt - b.tempOpt, a.complexity - b.complexity);
  if (!a.animal || !b.animal) return Math.hypot(base, (a.seeds || 0) - (b.seeds || 0));
  return Math.hypot(base, a.diet - b.diet, a.limbs - b.limbs, a.lungs - b.lungs,
    (a.eggs || 0) - (b.eggs || 0), (a.warm || 0) - (b.warm || 0));
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
  if (t.animal) {
    const onLand = r.land / (r.fresh + r.sea + r.land || 1);
    if (onLand > 0.5) {
      if ((t.eggs || 0) < SHELLED) return 'amphibians';
      if ((t.warm || 0) < 0.5) return 'reptiles';
      return t.dispersal >= 0.7 ? 'birds' : 'mammals';
    }
    if (onLand > 0.05) return 'fishapods';
    if (t.limbs > 0.3) return 'lobe-finned fish';
    return c < 0.3 ? 'jawless fish' : c < 0.45 ? 'armored fish' : 'ray-finned fish';
  }
  if (r.land > 0.05 && t.habitat < 0.6) return 'marsh plants';
  if (r.land > 0.05) {
    const s = t.seeds || 0;
    if (s >= 0.75) return c < 0.55 ? 'flowering meadows' : 'broadleaf forest';
    if (s >= SEEDED) return c < 0.55 ? 'shrubland' : 'conifer forest';
    return c < 0.42 ? 'mosses' : 'ferns';
  }
  const marine = t.salinity > 0.5;
  if (c < 0.12) return marine ? 'plankton' : 'microbial mats';
  if (c < 0.24) return marine ? 'seaweed' : 'algae';
  return marine ? 'kelp' : 'waterweed';
}

export function isLandPlant(t) {
  return !t.animal && realms(t).land > 0.05;
}

export function isLandAnimal(t) {
  return !!t.animal && realms(t).land > 0.05;
}
