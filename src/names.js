// names.js — per-culture phonology.
//
// Generated history is only worth reading if the names hold together. A culture
// draws every name it will ever produce from one small sampled inventory, so its
// cities and its kings sound like they belong to each other — Kel Vareth, Kel
// Doran, Varethis. Daughter cultures inherit the parent inventory and mutate it,
// so a splinter culture sounds like a cousin rather than a stranger.

const ONSET_POOL = [
  'b', 'br', 'd', 'dr', 'f', 'g', 'gr', 'h', 'k', 'kh', 'kr', 'l', 'm', 'n',
  'p', 'pr', 'r', 's', 'sh', 'sk', 'sl', 'st', 't', 'th', 'tr', 'v', 'w', 'y',
  'z', 'zh', 'ch', 'gl', 'bl', 'fl', 'kl', 'mr', 'nd', 'ts',
];

const NUCLEUS_POOL = [
  'a', 'e', 'i', 'o', 'u', 'ae', 'ai', 'au', 'ea', 'ei', 'eo', 'ia', 'ie',
  'io', 'oa', 'oi', 'ou', 'ua', 'ui', 'y', 'aa', 'ee', 'oo',
];

const CODA_POOL = [
  '', '', '', 'l', 'm', 'n', 'r', 's', 'th', 'k', 't', 'd', 'sh', 'st', 'nd',
  'rn', 'rk', 'ld', 'lm', 'ns', 'x', 'g', 'v', 'z',
];

// Applied to the end of a stem. Kept per-culture so one culture's cities all
// end in -eth and another's all end in -ora.
const PLACE_SUFFIX_POOL = [
  '', '', 'eth', 'ora', 'is', 'um', 'ad', 'ir', 'oth', 'ai', 'en', 'as', 'ur',
  'iel', 'arn', 'ost', 'yr', 'im', 'ath', 'ek',
];

const PERSON_SUFFIX_POOL = [
  '', '', 'an', 'ir', 'us', 'eth', 'ar', 'in', 'os', 'ea', 'ic', 'ald', 'wen',
  'mar', 'red', 'ys', 'ok', 'ai',
];

// A handful of epithets, assembled per-culture so "the Thin-Handed" recurs as a
// house style rather than being sampled from one global list every time.
const EPITHET_ADJ = [
  'Thin', 'Iron', 'Pale', 'Red', 'Grey', 'Long', 'Cold', 'Bright', 'Black',
  'Silent', 'Hollow', 'Gilded', 'Broken', 'Twice', 'Salt', 'Storm', 'Ash',
];
const EPITHET_NOUN = [
  'Handed', 'Crowned', 'Born', 'Tongued', 'Eyed', 'Hearted', 'Blooded',
  'Bearded', 'Walker', 'Binder', 'Breaker', 'Keeper', 'Wanderer', 'Sworn',
];

// Draw `n` distinct members of a pool.
function sample(rng, pool, n) {
  const taken = new Set();
  const out = [];
  const limit = Math.min(n, pool.length);
  let guard = 0;
  while (out.length < limit && guard++ < limit * 20) {
    const i = rng.int(pool.length);
    if (taken.has(i)) continue;
    taken.add(i);
    out.push(pool[i]);
  }
  return out;
}

export function makePhonology(rng) {
  return {
    onsets: sample(rng, ONSET_POOL, rng.int(6) + 5),
    nuclei: sample(rng, NUCLEUS_POOL, rng.int(4) + 3),
    codas: sample(rng, CODA_POOL, rng.int(5) + 4),
    placeSuffixes: sample(rng, PLACE_SUFFIX_POOL, rng.int(3) + 2),
    personSuffixes: sample(rng, PERSON_SUFFIX_POOL, rng.int(3) + 2),
    epithetAdj: sample(rng, EPITHET_ADJ, rng.int(4) + 3),
    epithetNoun: sample(rng, EPITHET_NOUN, rng.int(4) + 3),
    // Some cultures build two-word names (Kel Vareth), others one.
    compoundChance: rng.range(0.1, 0.55),
    // Bias toward short or long stems.
    syllableBias: rng.range(0, 1),
  };
}

// A daughter culture keeps most of the parent's sound and shifts the rest, the
// way a dialect drifts. Enough is retained that the kinship is audible.
export function mutatePhonology(parent, rng) {
  const drift = (list, pool, rate) => {
    const out = list.slice();
    for (let i = 0; i < out.length; i++) {
      if (rng.chance(rate)) out[i] = rng.pick(pool);
    }
    // Occasionally gain or lose a sound outright.
    if (rng.chance(0.25) && out.length > 2) out.splice(rng.int(out.length), 1);
    if (rng.chance(0.25)) out.push(rng.pick(pool));
    return out;
  };
  return {
    onsets: drift(parent.onsets, ONSET_POOL, 0.2),
    nuclei: drift(parent.nuclei, NUCLEUS_POOL, 0.25),
    codas: drift(parent.codas, CODA_POOL, 0.2),
    placeSuffixes: drift(parent.placeSuffixes, PLACE_SUFFIX_POOL, 0.3),
    personSuffixes: drift(parent.personSuffixes, PERSON_SUFFIX_POOL, 0.3),
    epithetAdj: drift(parent.epithetAdj, EPITHET_ADJ, 0.3),
    epithetNoun: drift(parent.epithetNoun, EPITHET_NOUN, 0.3),
    compoundChance: Math.min(0.7, Math.max(0.05,
      parent.compoundChance + rng.range(-0.15, 0.15))),
    syllableBias: Math.min(1, Math.max(0,
      parent.syllableBias + rng.range(-0.2, 0.2))),
  };
}

function syllable(phon, rng, final) {
  const onset = rng.pick(phon.onsets);
  const nucleus = rng.pick(phon.nuclei);
  const coda = final || rng.chance(0.4) ? rng.pick(phon.codas) : '';
  return onset + nucleus + coda;
}

function stem(phon, rng) {
  // Two syllables most of the time. Three-syllable stems plus a suffix plus a
  // compound prefix produce unpronounceable sludge, so they stay rare.
  const count = rng.next() < phon.syllableBias * 0.6 ? 1 : (rng.chance(0.82) ? 2 : 3);
  let out = '';
  for (let i = 0; i < count; i++) out += syllable(phon, rng, i === count - 1);
  return out;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Collapses the triples and vowel pile-ups that random concatenation throws up
// ("kkh", "uaaia"), then caps the length. This is most of the difference
// between names that read as a language and names that read as keyboard mash.
function tidy(word) {
  let w = word
    .replace(/([a-z])\1\1+/g, '$1$1')
    .replace(/([bcdfgkpqtvxz])\1/g, '$1')
    .replace(/[aeiouy]{3,}/g, (m) => m.slice(0, 2))
    // A syllable's coda meeting the next syllable's onset can stack four or
    // five consonants ("rkch"). Two is the most anyone can say.
    .replace(/[^aeiouy]{3,}/g, (m) => m.slice(0, 2));
  if (w.length > 11) {
    // Trim back to the last vowel-consonant boundary so the cut still sounds
    // like a word ending rather than a truncation.
    const cut = w.slice(0, 11);
    const m = cut.match(/^.*[aeiouy][^aeiouy]*/);
    w = m ? m[0] : cut;
  }
  return w;
}

export function placeName(phon, rng) {
  let name = tidy(stem(phon, rng) + rng.pick(phon.placeSuffixes));
  if (rng.next() < phon.compoundChance) {
    name = `${tidy(syllable(phon, rng, false))} ${name}`;
  }
  return name.split(' ').map(capitalize).join(' ');
}

export function personName(phon, rng) {
  return capitalize(tidy(stem(phon, rng) + rng.pick(phon.personSuffixes)));
}

export function dynastyName(phon, rng) {
  return capitalize(tidy(stem(phon, rng)));
}

export function cultureName(phon, rng) {
  return capitalize(tidy(stem(phon, rng) + rng.pick(phon.placeSuffixes)));
}

export function epithet(phon, rng) {
  return `the ${rng.pick(phon.epithetAdj)}-${rng.pick(phon.epithetNoun)}`;
}

// Polity names read better when the form varies — "the Vethric Hegemony",
// "the Free Cities of Oram", "Sarn" — so the government type picks the frame.
const POLITY_FORMS = {
  chiefdom: ['the {s} Clans', 'the {s} Folk', '{s}'],
  kingdom: ['the Kingdom of {s}', 'the {a} Crown', '{s}'],
  republic: ['the Free Cities of {s}', 'the {s} League', 'the {a} Republic'],
  empire: ['the {a} Empire', 'the {a} Hegemony', 'the Dominion of {s}'],
  theocracy: ['the {a} Covenant', 'the Holy {s}', 'the {a} See'],
};

// Turns a stem into an adjective the way Latin-ish names do: Veth -> Vethric.
// The base is cut short first: "Buapaakliazimric" is nobody's demonym.
function adjectival(base, rng) {
  const endings = ['ic', 'ian', 'ric', 'ene', 'ish', 'an'];
  let trimmed = base.replace(/[aeiouy]+$/, '');
  if (trimmed.length > 6) {
    const m = trimmed.slice(0, 6).match(/^.*[aeiouy]/);
    trimmed = m ? m[0] : trimmed.slice(0, 5);
  }
  return trimmed + rng.pick(endings);
}

export function polityName(phon, rng, form, seatName) {
  const base = seatName ? seatName.split(' ').pop() : dynastyName(phon, rng);
  const templates = POLITY_FORMS[form] || POLITY_FORMS.kingdom;
  return rng
    .pick(templates)
    .replace('{s}', base)
    .replace('{a}', capitalize(adjectival(base.toLowerCase(), rng)));
}
