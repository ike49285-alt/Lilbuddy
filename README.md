# Headwaters

A river starts as a trickle on a young mountain front and carves its valley to
the sea over millions of years, while ice ages come and go.

Time runs at a chosen rate, from ten minutes to 100,000 years per second; each tick adapts from a minute up to 1,000 years. The landscape is a standard landscape-evolution
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
- `src/disasters.js` — floods, wildfires, eruptions and impacts
- `src/sim.js` — one world, its clock, and saving/restoring it
- `src/save.js` — the continue slot in IndexedDB
- `src/host.js`, `src/worker.js` — runs the sim off the main thread
- `src/weather.js` — clouds and rain that drift in from the sea
- `src/tools.js` — shaping the land by hand: brushes, channels, storms
- `src/render.js`, `src/view3d.js`, `src/app.js` — the page: the flat map, the 3D view, the controls

## Water

The world starts dry. Rain pools in hollows (the young foothills and
plain are hummocky) and only spills on once a hollow is full, so the
first network of streams has to find its way to the sea. Lakes evaporate:
one that gets less than it loses shrinks, and if its outlet is cut down it
drains. A crater fills over the years before it overflows, and a cone
across the river stops it below until the lake behind it spills. Below a
day per tick, water also takes time to travel, at river speeds, so at an
hour a second you can watch a flood come down the valley.

## Weather, day and night

At a week a second or slower, clouds drift in from the sea on the
prevailing wind and the rain falls under them, so a storm over the hills
sends a flood down the river hours later. Averaged over time the rain
comes to the climate's, so at fast speeds the weather averages out and the
clouds fade away. Below a day a second the sun rises and sets, with longer
days in summer and a warm light at dawn and dusk, and with the seasons on,
plants come out light green in spring and turn gold and red in autumn.

## Ground

The ground is bedrock under loose cover. A granite core runs along the top
of the range; below it, bands of sandstone, shale and limestone cross the
valley, so the river cuts gorges through the hard bands and opens out
across the soft; volcanoes add basalt. Each rock wears at its own rate,
granite slowest and shale fastest. Loose cover (soil on the slopes, sand
and silt on the plain and delta, scree on steep ground) goes as fast as the
water can carry it: a sandy river bed cuts tens of centimetres a century
where a granite one moves about a millimetre. Hillside soil rides on the
slope as it creeps and goes with landslides; bare rock weathers back into
soil, faster for shale than granite; rivers, lakes and floods lay down
new cover. Plants do poorly on bare rock. The Ground map mode shows it all.

## Muddy rivers

The rivers are coloured by the silt they carry. Clear blue water is coming
off hard rock, through lakes that have dropped their load, or from a quiet
catchment; jade, olive and then brown mean more and more mud, from soft
rock, bare ground, steep rising mountains and floods. A storm sends a brown
pulse down the valley that clears within a few days, and a lake goes muddy
where a river runs into it. At the coast the silt fans out into the sea as
a tan plume off each mouth. The River tab totals the silt reaching the sea
each year, and tapping a river or lake shows how many tonnes a day pass
that spot.

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

Animals start as two simple jawless fish in the sea. They graze: some
filter plankton, some crop the larger plants, and where they're dense they
leave less for what they eat. Diet, limbs and lungs evolve like any other
trait, through armored, ray-finned and lobe-finned fish. Fleshy fins and
gulping air each help a little in warm, weedy shallows; with real legs and
lungs, and land plants to eat, an animal can walk out of the water.
It usually happens on its own, but not always in time: if nothing has
walked ashore by 5 million years, the most land-ward fish living by a green
shore gives rise to amphibians there, a real descendant in its line (and if
no plant has made it onto land yet, the most land-ward plant goes first,
and the animals follow once there's something to eat). If that line dies
out, another try comes 250,000 years later. Each gets a note.

The first walkers are amphibians: they lay their eggs in water, so they do
well only near streams, lakes or heavy rain. Shelled eggs (reptiles) free
them to live anywhere on land, and only then can warm blood evolve: warm-
blooded animals (mammals, and the far-ranging ones birds) keep going in the
cold, at the price of more food. Plants follow the same way out of the wet:
spore plants (mosses, ferns) need damp ground; seed plants (shrubland,
conifer forest) take the dry uplands; flowering plants (meadows, broadleaf
forest) grow and spread faster. Each step comes in order, by chance, if it
comes at all, and the first of each gets a note.

Some animals take to eating other animals. Hunters eat the plant-eaters
around them and nothing else, need twice the food per head and breed
slower; they thin their prey, and starve without it. Fish show as silver
specks in the water, land animals as dark specks on the ground, and hunters
as rust-red specks.

## Disasters

Nature sets them off as time runs: lightning fires in dry summers on
vegetated ground (about one every 30 years), floods on the trunk river (about
one in 50, mostly with the spring melt), eruptions in the rising mountains
(about one per 400,000 years) and meteor impacts (about one per 3 million).
The Tools button on the map lets you drop any of them where you tap.
Eruptions build cones and impacts dig craters, and the rivers re-route around
them at once: a cone across a valley dams a lake. Floods lay silt on the
floodplain, and fires burn the plants but leave the soil richer. The biggest
eruptions and impacts bring a volcanic or impact winter a few degrees colder
for a few years, and the species least able to take the cold die out.
When the winter is over, newcomers come in from beyond the valley at the
edges of the map: two or three plants and two or three animals, new species
at the most advanced level their kind had reached here in each of the sea,
fresh water and land (so if early tetrapods walked the valley before, early
tetrapods walk in), suited to the climate where they land and only where
there's something for them to eat. Now and then a lone newcomer drifts in
too, a plant or an animal, about once every 100,000 years.

The world's first million years are the heavy bombardment: impacts and
eruptions one after another, about one every 500 years at first, most of
them small and a few catastrophic, easing off to nothing by the
million-year mark and leaving a cratered, volcanic valley. Life is there
from the start and is knocked back again and again; nothing comes in from
beyond until it's over. Then the valley is restocked: plants first, and
the animals once there's something for them to eat.

## Shaping it yourself

The Tools tray holds the disasters, five tools of your own and the World sliders. Raise and
Lower work like a brush: hold a finger on the map and the ground rises or
falls under it, about 50 m a second, with a soft edge (lowering takes the
loose cover first). Dig cuts a channel along a line you draw, its bed
falling steadily from the higher end to the lower and kept below the ground
either side, so a river that finds it follows it. Storm parks a heavy storm
for a day and a half where you tap; it slows the clock to an hour a second
so you can watch the flood come down. Seed drops a species where you tap:
pick Plant or Animal for a newcomer suited to the spot (an animal only where
there's something for it to eat), or Picked for the species chosen in the
Life tab, if it can live there.

The World sliders change the valley as a whole. Rain makes it wetter or
drier (30% to 200% of natural); Meteors and Volcanoes set how often nature
strikes and erupts (none to five times natural, the bombardment included);
Uplift sets how fast the mountains rise (none to three times); Warmth shifts
the climate up to 8 °C either way, so glaciers, snow and life follow; Sea
level raises or drops the sea by up to 150 m, and the coast moves at once;
Rock sets how hard all the rock is (a quarter to four times), so it wears
faster or slower. With a tool armed
one finger shapes; two fingers still move and zoom. Everything you change
is saved with the world.

## The map

Pinch, double-tap, scroll or use the + and − buttons to zoom in; drag to
move around once zoomed. Tap a spot to see what lives there.

The switch at the bottom shows Land, Species or Ground; Layers adds colour
maps of temperature, rainfall, river flow and erosion, each with its key.

The 3D button stands the valley up, its heights exaggerated three times so
the relief reads: drag to turn and tilt it, pinch or use + and − to move in,
double-tap to centre on a spot. Everything else works there too: the map
modes, clouds and night, tapping to see what lives somewhere, and the
disasters.

## Saving

The world saves itself in the browser every 30 seconds and when you leave,
and picks up exactly where it stopped on the next visit.
