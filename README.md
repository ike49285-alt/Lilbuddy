# Headwaters

A river starts as a trickle on a young mountain front and carves its valley to
the sea over millions of years, while ice ages come and go.

Time runs at a chosen rate, from a day to 100,000 years per second; each tick adapts from a day up to 1,000 years. The landscape is a standard landscape-evolution
model: depressions are filled into lakes (priority-flood), water is routed
downhill (D8), channels cut by the stream-power law solved implicitly
(Braun & Willett 2013), sediment is carried downstream and dropped on fans,
floodplains, in lakes and at the mouth, where it builds a delta. Mountains keep
rising; orbital-style cycles drive temperature, rainfall, ice and sea level.
Times and rates are compressed toy values, not a calibrated model.

## Running it

No dependencies, no build step, but it uses ES modules and a worker, so it has
to be served:

    python3 -m http.server 8000

then open http://localhost:8000/.

`node tools/build-artifact.mjs [out.html]` writes a single self-contained page.

## Layout

- `src/terrain.js` — starting surface, uplift and rock hardness
- `src/climate.js` — ice-age cycles, long eras, temperature, rain, sea level
- `src/landscape.js` — the river and landscape model
- `src/species.js`, `src/life.js` — species traits, names, and the population model
- `src/sim.js` — one world, its clock, and saving/restoring it
- `src/save.js` — the continue slot in IndexedDB
- `src/host.js`, `src/worker.js` — runs the sim off the main thread
- `src/render.js`, `src/app.js` — the page

## Life

Life starts in the sea: plankton, seaweed and microbial mats, with freshwater
algae seeded at the river mouths once the river reaches the coast. Each
species is a density map over a 1 km grid plus a handful of traits: water or
land, fresh or salt, temperature, complexity, dispersal. Species grow,
compete within their size class and realm, spread along the rivers, adapt to
the climate, and split, either when the river, ice or the coast cuts a
population in two or by mutation. Plants need enough complexity before they
can live on land; once they do, they green the valley and hold the soil, so
vegetated slopes erode more slowly. At slow speeds you see blooms and
dormancy through the seasons; at fast speeds, evolution.

The world saves itself in the browser every 30 seconds and when you leave,
and picks up exactly where it stopped on the next visit.
