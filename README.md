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

- `src/table.js` — the starting landscape: a bare sand floodplain, terraces, rolling ground from noise (hills to wind round, hollows holding lakes), and a wide shallow sea for the delta
- `src/flow.js` — the water, the sand, the banks and the plants
- `src/gpu.js`, `src/gpuflow.js`, `src/gpuriver.js` — the whole river (water, sand, gravel, mud, banks, plants) worked out on the GPU (WebGL2), when it's switched on
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

**Sand and gravel** (0.7 mm and 8 mm) move along the bed where the water
drags at it hard enough, by Wilcock and Crowe's formula for a mix of the two.
Gravel needs more drag than sand but moves more easily among plenty of sand,
so where the flow strips the sand away it leaves a coarser bed behind that's
harder to move: the channel armours. They go the way the water goes, turned
toward the inside of a bend by the bend's spiral flow and pulled a little
downhill. The bed rises where more comes in than goes out and falls where
less does, and none is made or lost along the way. The pump feeds them in
with its water, as a share of what that water can carry. The plain starts
about 30% gravel, 60% sand and 10% mud.

**Mud** rides in the water rather than along the bed. The pump's water
brings some, more in a flood, and the flow lifts more wherever it drags hard
at a muddy bed. It settles out wherever the water is slow, fastest among
plants, so a flood over the banks leaves mud beside the channel and over the
floodplain, and the river's plume clears as it spreads into the sea. The
ground keeps track of how muddy its top layer is. Muddy banks stand steeper
and wear back more slowly, and the terraces, old floodplain, are muddier
than the plain's sand.

**Banks** wear back where the flow drags hardest beside them, which is the
outside of a bend. A channel scouring at the foot of a bank brings some of
the bank down with it, and any slope steeper than wet or dry sand can stand
slumps. A tall, steep wall over the water (a gorge's side, a high bank) may
give way all at once in a landslide, dropping its sand, gravel and plants
into the river; the River tab counts them. Bedrock lies 6 m down under the plain to start (the Table tab's Bedrock
slider moves it), close under the terraces. Where the river runs over bare
rock it wears it slowly, by the power of the water, fastest at a waterfall's
lip; what it wears away becomes gravel. Rock put down by hand doesn't wear.

**Plants** come in two kinds. Grass greens bare ground over a year or two in
the growing season; trees come up slowly on grassed ground, over years, and
the terraces start partly wooded. Both drown under standing water (trees
after much longer) and a flood that drags hard enough tears them out (trees
hold on harder). Where they grow they slow the water, trap mud and hold the
banks together, trees far more than grass.

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
3D and the tools on the right (north too, in 3D); on the left, the scale and a button for each
thing the map can show, each with a strip of its colours. Land shows the
land, with contours every half metre on dry ground; the other seven are
layers, with their key under the map:
- water depth;
- the current;
- the drag on the bed, as a multiple of what moves sand;
- where the bed is cutting or filling now;
- mud in the water;
- the bed's surface, from mud through sand to gravel;
- how much it has been cut or filled since the start.

Pinch, double-tap or use + and − to zoom in, and drag to move around when
zoomed. Tap a spot to see the depth, current, sand moving, how far the bed
has moved and the plant cover there. The 3D button stands the valley up,
heights exaggerated four times.

**Tools,** down the right of the map. Tap one to pick it and again to put
it down; what it does, and a brush's size and strength, show under the map.
- **Raise** and **Lower:** brushes that pile up or scoop away sand for as
  long as you hold a finger on the map. Small, Big or Huge; Gentle, Strong or
  Bulldozer (half a metre, three or ten metres a second at the centre).
  While your finger is down the river's bed runs in real time, so what you
  build stays put until you let go; the ground you've moved is outlined.
  Lower stops at the bedrock.
- **Dig:** cuts a channel along a line you draw.
- **Place:** puts down something for the river to threaten, or to stop it:
  - **Rock:** a block of rock the river can't wear away.
  - **House:** turns amber when flooded, red when the river undercuts it,
    and is lost if the ground under it goes.
  - **Field:** a crop the farmer keeps planted. It turns amber when it floods
    or when the river cuts into it or buries it in sand.
  - **Bridge:** drawn as a line across the river, with rock piers in it. It
    turns red when the river scours round its piers and amber when the river
    leaves it high and dry.
  - **Dam:** drawn as a line across the valley: a wall 2, 4 or 8 m above the
    lowest bed along it (Low, Mid, High), keyed into the ground either
    side, with a spillway where the river ran. A reservoir backs up behind
    it, full to the spillway from the start (the water here runs far
    slower than the bed's clock, so filling it would take years of it; a
    real one fills in days), and its deep water lies still. The river drops
    its sand where it meets the lake, building a delta out into it; below
    the dam it runs clear and hungry, and cuts down. When a reservoir backs
    up to the pump, the pump goes on feeding the sand it was feeding before.
    The River tab says how full of sand it is. Draw it bank to bank, or the
    river goes round it.
  - **Gauge:** tap the river to put one there (up to four). Each charts, in
    the Profile tab, its water level over the bed (and the bed when it was
    put down), and the flow and the sand passing it across the valley. Put
    one above a dam and one below it.
  - **Remove:** tap anything put down to take it away. Rock, a dam or a
    bridge's piers go and the ground under them comes back as it was:
    take a dam away and its reservoir drains and its sand flushes out.
    A volcano taken away goes extinct; its cone stays.

  The River tab says how they're all faring, and tapping one tells you.
- **Pump:** moves the pump along the top edge, above where you tap, like
  moving the hose on a stream table.
- **Volcano:** tap the map to put a volcano there. A few days later it
  erupts, and slows the clock so you can watch; after that it erupts every
  two to four months, for three to six days at a time. Its lava runs down
  whatever slope it finds and piles up where the ground is too gentle, so
  its cone grows eruption by eruption. The lava sets in a day (in an hour
  where it runs into water) into dark rock the river wears only slowly, so
  a flow across the river dams it or shoves it aside. Ash falls around it
  as loose grit, thickest near the vent, burying plants, for the rain and
  the river to wash away. Remove makes it extinct: the cone stays.
- **Section:** draws a line for a cross-section.

With a tool picked, one finger works the map and two fingers still move and
zoom it.

**The table's sliders,** in the Table tab.
- **Pump:** the river's flow before the seasons.
- **Tilt:** the valley's fall, in metres per kilometre.
- **Sea level.**
- **Sand in:** sand fed in with the water, as a share of what it can carry.
  Less than it can carry and the river cuts down; more and it builds up and
  spreads out.
- **Land height:** raises the land above the sea, up to 30 m; the sea
  floor stays, and the land drops to it down a steep slope at the coast.
  The river then meets the sea down that step and cuts back into it, a
  gorge working its way up the valley as deep as the bedrock lets it.
- **Hills:** how far the rolling ground on the plain rises and falls, from
  flat to ±12 m (±2.5 m to start). It comes from noise: hills for the river
  to wind round, and hollows that start full of lakes, to where they'd spill
  over (the water here runs far slower than the bed's clock, and filling
  them would take it months), which the river flows through and fills
  with sand. Some hills are rocky, with bedrock a metre and a half under
  them, and the river has to go round those for good; the rest are firm,
  grassy earth it slowly cuts into. In the lakes, and in a dam's reservoir,
  the water's flows are blended face to face (de Almeida et al. 2012) so
  their deep, still water doesn't wobble from cell to cell.
- **Hill size:** how far across its hills are, from 30 to 400 m (120 m to
  start): many small bumps or a few broad hills. Both work as it runs.
- **Bedrock:** how deep the rock lies under the plain, from 1 to 60 m
  (6 m to start). The river can't cut below it; set it deep and the river
  can cut down into its valley and the terraces as far as it likes.
- **River on the GPU:** works the river out on the phone's graphics chip:
  the water and the bed both, so nothing waits on the CPU between steps.
  On by default wherever the browser can (and shown only there); switch it
  off to run the river on the CPU. The time bar says GPU when it's
  on. A world run either way behaves the same, though not identical to the
  last decimal; landslides and anything you do to the ground still happen
  on the CPU.
- **Mud in:** grams of mud in each litre of the pump's water (floods bring
  more).

**Readings.** The River tab gives the flow, the channel's width, its
sinuosity (the length of its line over the valley's), the sand and gravel
moving and reaching the sea, the delta built, the mud reaching the sea and
the mud laid down, how any houses, fields and bridges are faring, and
sparklines over time. The Table tab holds the table's sliders. The
Profile tab draws the river's long profile, from the inlet to the sea:
- the bed;
- the water over it;
- the bed at the start, dashed.

Under it is the cross-section along the line from the Section tool, and
then each gauge's charts.

## Tests

`node tests/stream.test.mjs` checks the model. With the repository served (`python3 -m http.server 8114`), `node tests/gpu.test.mjs http://localhost:8114` checks the river on the GPU against the river on the CPU: one move of the bed pass by pass, then hundreds of steps. With the built page served (`node tools/build-artifact.mjs dist/headwaters.html`, then `python3 -m http.server 8112` in `dist`), `node tests/ui.test.mjs` drives the page on a phone-sized screen and `node tests/speed.test.mjs http://localhost:8112/headwaters.html` checks it stays responsive with the CPU slowed four times (both with the river on the CPU), and `node tests/gpu-page.test.mjs` runs the page with the river on the GPU: the tools, switching it off and on, and a save and reload. The browser tests need Playwright; set `CHROMIUM` to a Chromium binary if it can't find one.

## Saving

The world saves itself in the browser every 30 seconds and when you leave,
and picks up exactly where it stopped on the next visit.
