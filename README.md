# Headwaters

A stream table you can carry around. A kilometre of valley, half a kilometre
wide, tilts gently toward the sea. A pump at the top pours a river onto a
bare sand plain. It spreads out at first, then cuts its own channels, first
braided and then gathering into one, while grass takes the dry ground. From
there the river keeps shaping its course: it cuts the outsides of its bends and
builds bars on the insides, breaks its banks in a flood, and builds a delta
where it meets the sea. Plants grow on the dry ground and hold the banks
together.

The earlier version, a whole valley carved over millions of years with life
evolving in it, is in the history at commit `50d6dee`.

## Running it

No dependencies, no build step, but it uses ES modules and a worker, so it has
to be served:

    python3 -m http.server 8000

then open http://localhost:8000/.

`node tools/build-artifact.mjs [out.html]` writes a single self-contained page.

## Layout

- `src/table.js` — the starting landscape: a bare sand floodplain, terraces, and a wide shallow sea for the delta
- `src/flow.js` — the water, the sand, the banks and the plants
- `src/weather.js` — rain, and the floods that come down from upstream
- `src/sim.js` — one world: the clock, the seasons, the tools, measuring, saving
- `src/save.js` — the continue slot in IndexedDB
- `src/host.js`, `src/worker.js` — runs the sim off the main thread
- `src/render.js`, `src/view3d.js`, `src/app.js` — the page: the map, the 3D view, the charts, the controls

## The model

The valley is a grid of 4 m cells, 128 across and 256 down.

**Water** moves as a sheet with depth and momentum: the local inertial form
of the shallow-water equations (Bates and others, 2010). Each cell face
carries a flow pushed by the slope of the water surface and held back by
friction on the bed, which is rougher where plants grow. So the water
spreads, ponds, overtops its banks and splits round bars. It's worked out
in steps of a fraction of a second.

**Sand** (coarse, 1 mm) moves where the water drags at the bed harder than
a threshold (the Shields stress), at the Meyer-Peter Müller rate. It goes
the way the water goes, turned toward the inside of a bend by the bend's
spiral flow and pulled a little downhill. The bed rises where more sand
comes in than goes out and falls where less does, and no sand is made or
lost along the way. The pump feeds in sand with its water, as a share of
what that water can carry.

**Banks** wear back where the flow drags hardest beside them, which is the
outside of a bend. A channel scouring at the foot of a bank brings some of
the bank down with it, and any slope steeper than wet or dry sand can stand
slumps. Bedrock lies a few metres down, close under the terraces, and
nothing wears below it.

**Plants** green bare ground over a year or two in the growing season. They
drown under standing water, and a flood that drags hard enough tears them
out. Where they grow they hold the banks, slow the water and keep the sand
in place.

**Time.** The bed changes far more slowly than the water moves. At the faster
rates each second of water stands for many seconds of the bed's time, the
morphological factor river models use. The bottom left of the time bar
shows it as "bed ×N". The clock runs on the bed's time. The factor backs
off by itself when the bed would change faster than the water could follow.

**Seasons and weather.** The river runs low in winter and high in the spring
melt, with a smaller rise in the autumn rains. Weather systems drift over:
while one passes it rains, and the rain on the catchment upstream comes
down the river as a flood some hours later. The time bar says when it's
raining. Nothing is drawn over the map, so the river is always in view.

## Using it

**Map.** The controls sit in rails either side of the map: zoom, reset,
3D and north on the right; on the left, the scale and a button for each
thing the map can show, each with a strip of its colours. Land shows the
land, with contours every half metre on dry ground; the other five are
layers, with their key under the map:
- water depth;
- the current;
- the drag on the bed, as a multiple of what moves sand;
- where the bed is cutting or filling now;
- how much it has been cut or filled since the start.

Pinch, double-tap or use + and − to zoom in, and drag to move around when
zoomed. Tap a spot to see the depth, current, sand moving, how far the bed
has moved and the plant cover there. The 3D button stands the valley up,
heights exaggerated four times.

**Tools.**
- **Raise** and **Lower:** brushes that pile up or scoop away sand for as
  long as you hold a finger on the map. Small, Big or Huge; Gentle, Strong or
  Bulldozer (half a metre, three or ten metres a second at the centre).
  While your finger is down the river's bed runs in real time, so what you
  build stays put until you let go; the ground you've moved is outlined.
  Lower stops at the bedrock.
- **Dig:** cuts a channel along a line you draw.
- **Block:** drops a block of rock the river can't wear away.
- **Storm:** parks a storm over the valley for a day and a half, and slows
  the clock so you can watch the flood come down.
- **Section:** draws a line for a cross-section.

With a tool picked, one finger works the map and two fingers still move and
zoom it.

**The table's sliders.**
- **Pump:** the river's flow before the seasons.
- **Tilt:** the valley's fall, in metres per kilometre.
- **Sea level.**
- **Sand in:** sand fed in with the water, as a share of what it can carry.
  Less than it can carry and the river cuts down; more and it builds up and
  spreads out.

**Readings.** The River tab gives the flow, the channel's width, its
sinuosity (the length of its line over the valley's), the sand moving, the
sand reaching the sea and the delta built, with sparklines over time. The
Profile tab draws the river's long profile, from the inlet to the sea:
- the bed;
- the water over it;
- the bed at the start, dashed.

Under it is the cross-section along the line from the Section tool.

## Tests

`node tests/stream.test.mjs` checks the model. With the built page served (`node tools/build-artifact.mjs dist/headwaters.html`, then `python3 -m http.server 8112` in `dist`), `node tests/ui.test.mjs` drives the page on a phone-sized screen and `node tests/speed.test.mjs http://localhost:8112/headwaters.html` checks it stays responsive with the CPU slowed four times. The browser tests need Playwright; set `CHROMIUM` to a Chromium binary if it can't find one.

## Saving

The world saves itself in the browser every 30 seconds and when you leave,
and picks up exactly where it stopped on the next visit.
