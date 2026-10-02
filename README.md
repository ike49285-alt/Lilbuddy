# Headwaters

A river starts as a trickle on a young mountain front and carves its valley to
the sea over millions of years, while ice ages come and go.

Each step is 1,000 years. The landscape is a standard landscape-evolution
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
- `src/sim.js` — one world and its clock
- `src/host.js`, `src/worker.js` — runs the sim off the main thread
- `src/render.js`, `src/app.js` — the page

Life along the river is the next step.
