// legends.js — turning archived events back into sentences.
//
// The archive stores structure, never prose: {type, refs, data}. Wording is
// applied here, at read time, which keeps the stored record small and lets the
// same event be told differently depending on how far into the past it has
// fallen. A merged, distorted event doesn't get a different template — it gets
// the same one, hedged, because that is what a source at that remove sounds
// like.

const NUM = new Intl.NumberFormat('en-US');
const n = (v) => (typeof v === 'number' ? NUM.format(Math.round(v)) : v);

// A value can be one function (unchanged, most types) or an array of them —
// for the handful of types a reader sees over and over, so the record
// doesn't read as one chronicler's fixed phrasebook. describe() below picks
// among an array deterministically per event (ev.id % length), never at
// random: the same event always reads the same way if you revisit it, and
// this file never touches sim.rng/realChance() — it only ever formats
// already-decided event data.
const TEMPLATES = {
  'world.begin': () => 'The world takes shape.',

  'polity.found': [
    (d) => `${d.name} is founded${d.ruler ? `, under ${d.ruler}` : ''}`
      + `${d.house ? ` of the house of ${d.house}` : ''}.`,
    (d) => `${d.ruler ? `${d.ruler} founds` : `${d.name} is founded as`} ${d.name}`
      + `${d.house ? `, the house of ${d.house} at its head` : ''}.`,
    (d) => `A new state rises: ${d.name}${d.ruler ? `, under ${d.ruler}` : ''}.`,
  ],
  'polity.collapse': (d) => (d.parts
    ? `${d.name} breaks apart after ${n(d.years)} years, into ${d.parts} successor states.`
    : `${d.name} comes to an end after ${n(d.years)} years.`),
  'polity.conquered': (d) => `${d.name} is annexed${d.by ? ` by ${d.by}` : ''} after ${n(d.years)} years.`,

  'settle.found': (d) => `${d.name} is founded.`,
  'settle.city': (d) => `${d.name} grows into a city of ${n(d.population)}.`,

  'war.begin': [
    (d) => `${d.attacker} marches on ${d.defender}`
      + `${d.strength ? `, ${n(d.strength)} under arms` : ''}`
      + `${d.cause ? `, over ${d.cause}` : ''}.`,
    (d) => `War: ${d.attacker} against ${d.defender}`
      + `${d.cause ? `, the cause ${d.cause}` : ''}${d.strength ? `; ${n(d.strength)} take up arms` : ''}.`,
    (d) => `${d.defender} finds itself at war with ${d.attacker}`
      + `${d.cause ? `, over ${d.cause}` : ''}.`,
  ],
  'war.end': [
    (d) => `${d.victor} prevails over ${d.defeated} after ${n(d.years)} years`
      + `${d.taken ? `, taking ${n(d.taken)} regions` : ''}`
      + `${d.dead ? `; ${n(d.dead)} dead` : ''}.`,
    (d) => `After ${n(d.years)} years, ${d.defeated} yields to ${d.victor}`
      + `${d.taken ? `, ${n(d.taken)} regions changing hands` : ''}.`,
    (d) => `${d.victor} carries the war against ${d.defeated}`
      + `${d.dead ? `, at a cost of ${n(d.dead)} dead` : ''}.`,
  ],
  'war.stalemate': (d) => `The war between ${d.a} and ${d.b} burns out after `
    + `${n(d.years)} years with the border unmoved`
    + `${d.dead ? `; ${n(d.dead)} dead` : ''}.`,
  'war.sack': (d) => `${d.by} sacks ${d.place}${d.dead ? `, ${n(d.dead)} put to the sword` : ''}.`,

  'ruler.crown': [
    (d) => `${d.name} of the house of ${d.house} is crowned in ${d.polity}.`,
    (d) => `${d.polity} crowns ${d.name}, of the house of ${d.house}.`,
    (d) => `The house of ${d.house} places ${d.name} on the throne of ${d.polity}.`,
  ],
  'ruler.die': [
    (d) => `${d.name} dies after ${n(d.years)} years on the throne of ${d.polity}.`,
    (d) => `Death comes for ${d.name}, ${n(d.years)} years upon the throne of ${d.polity}.`,
    (d) => `${d.name}'s reign over ${d.polity} ends after ${n(d.years)} years.`,
  ],
  'ruler.slain': (d) => `${d.name} of ${d.polity} is slain after ${n(d.years)} years.`,
  'succession.crisis': (d) => `The succession in ${d.polity} is disputed; the house of ${d.house} takes the throne.`,

  'alliance.formed': [
    (d) => `${d.a} and ${d.b} swear an alliance${d.strong ? ', bound by more than words' : ''}.`,
    (d) => `${d.a} and ${d.b} pledge mutual defense${d.strong ? ', a bond both sides mean to keep' : ''}.`,
    (d) => `An alliance is struck between ${d.a} and ${d.b}.`,
  ],
  'alliance.broken': [
    (d) => `${d.a} and ${d.b} go to war despite their old alliance; the pact is void.`,
    (d) => `The alliance between ${d.a} and ${d.b} is broken; they go to war regardless.`,
  ],

  'revolt': (d) => `${d.rebel} rises against ${d.against}.`,

  'house.found': (d) => `The house of ${d.house} is raised up.`,
  'house.ascend': (d) => `The house of ${d.house} holds ${n(d.thrones)} thrones at once, `
    + `and is counted among the great houses.`,
  'house.deposed': (d) => `The house of ${d.house} loses the last of its crowns with `
    + `${d.polity}, after ${n(d.rulers)} rulers.`,
  'house.restored': (d) => `The house of ${d.house} is restored to a throne it lost `
    + `${n(d.years)} years before.`,
  'house.extinct': (d) => (d.great
    ? `The great house of ${d.house} fails; ${n(d.rulers)} of its line had reigned across ${n(d.years)} years.`
    : `The house of ${d.house} fails, its line ended after ${n(d.rulers)} rulers.`),
  'culture.split': (d) => (d.died
    ? `The ${d.from} tongue passes out of use${d.to ? `, its speakers turning to ${d.to}` : ''}.`
    : `${d.to} diverges from ${d.from}.`),

  'epoch': (d) => (d.direction === 'returns'
    ? `The world falls back into ${d.name}.`
    : `${d.name.charAt(0).toUpperCase()}${d.name.slice(1)} begins.`),
  'plague': (d) => `Plague runs through ${d.polity}${d.dead ? `, ${n(d.dead)} dead` : ''}.`,
  'winter': (d) => `The sun dims and the harvests fail; the long winter holds for ${n(d.years)} years.`,
  'cataclysm': (d) => `Catastrophe: ${n(d.dead)} dead across ${n(d.radius)} leagues.`,
};

export function describe(ev) {
  let template = TEMPLATES[ev.type];
  // A deterministic pick, not a random one: the same event id always
  // resolves to the same phrasing, so revisiting a page never shows the
  // record changing its story on you — only different events of the same
  // type read differently from each other.
  if (Array.isArray(template)) template = template[ev.id % template.length];
  let text = template ? template(ev.data || {}) : ev.type;

  // A record that has been merged and re-merged is no longer a report, it is a
  // tradition. Hedging it is not decoration — it is the only honest way to
  // present something the archive can no longer vouch for.
  if (ev.data && ev.data.frame) {
    text = text.charAt(0).toLowerCase() + text.slice(1);
    text = `It ${ev.data.frame} been thus: ${text}`;
  }
  if (ev.data && ev.data.inverted) {
    text += ' Other tellings reverse the outcome entirely.';
  }
  return text;
}

// What the reader should be told about how reliable this is.
export function provenance(ev) {
  if (!ev.dist) return null;
  const notes = [];
  if (ev.merged > 1) notes.push(`${ev.merged} accounts run together`);
  if (ev.data && ev.data.causeApocryphal) notes.push('cause not attested');
  if (ev.data && ev.data.attributionDrifted) notes.push('attribution uncertain');
  if (ev.data && ev.data.inverted) notes.push('sources disagree');
  if (ev.span && ev.span[0] !== ev.span[1]) {
    notes.push(`somewhere in ${formatYear(ev.span[0])}–${formatYear(ev.span[1])}`);
  }
  return notes.length ? notes.join(' · ') : null;
}

export function formatYear(y) {
  const v = Math.round(y);
  return v >= 1000000
    ? `${(v / 1000000).toFixed(2)}M`
    : v >= 10000
      ? `${(v / 1000).toFixed(1)}k`
      : NUM.format(v);
}

export function formatAge(age) {
  const v = Math.round(age);
  if (v <= 0) return 'now';
  if (v < 1000) return `${v} yr ago`;
  if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k yr ago`;
  return `${(v / 1000000).toFixed(2)}M yr ago`;
}
