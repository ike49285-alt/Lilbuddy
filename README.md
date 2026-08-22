# Chronicle 🗺

A world simulation that never stops, and an archive that forgets.

Chronicle generates a world — terrain, climate, carrying capacity — and then
runs history on it, one tick per year, indefinitely. States are founded, spread
along the ground that will feed them, fight, overextend, fracture into successor
states, and are replaced. You watch it on a map with a timeline you can drag
back through, and read what the record still has to say about any stretch of it.

Nothing about the history is authored. It is what the rules did.

## The idea

Time is unbounded, so the record can't be. Chronicle gives the archive a **fixed
budget** and makes it forget.

Events age into progressively coarser tiers. Each tier holds a set number of
events; when one overflows, similar events are merged and the least salient are
dropped. Merging destroys detail, and the retelling has to fill the gaps — so
numbers inflate, causes are replaced by stock ones, two forgettable kings become
one long-reigning legendary one, and eventually a chronicle disagrees with
itself. **Distortion isn't a feature layered on top of the archive. It is what
running out of room looks like.**

| Tier | Age | Kept | What survives |
| --- | --- | --- | --- |
| Living memory | < 200 yr | 4000 | everything — every battle, every ruler |
| Recorded history | 200 – 2k yr | 3000 | rulers, wars, foundings, collapses |
| Chronicle | 2k – 20k yr | 1500 | states rise, peak and fall; rulers become dynasties |
| Legend | 20k – 200k yr | 400 | named epochs, a few figures, sources disagree |
| Deep time | > 200k yr | 60 | strata, not narrative — and possibly wrong |

Map keyframes decay the same way, spaced further apart the older they get, so
scrubbing into the deep past visibly loses resolution. The page tells you how
far the nearest surviving keyframe is from the year you asked for.

What survives isn't chosen at random. Events are scored by magnitude, by whether
they created or destroyed something, and by whether the things they mention are
still around — which produces the nicest behaviour in the whole system:
**things become important retroactively.** A minor founding survives thirty
thousand years because the city it founded is still standing.

### The truth is really gone

Above the chronicle tier there is no hidden copy of what actually happened.
Nothing is flagged and withheld; it is deleted. The only way to find out what
really happened in deep time is to **replay the world from its seed** — which
works, because the world is a pure function of that seed and the simulation
never reads the archive back. That constraint is why forgetting is safe.

## Running it

No dependencies and no build step, but it does need to be served — it uses ES
modules and a worker:

```bash
python3 -m http.server 8000    # then open http://localhost:8000
```

A seed lives in the URL hash, so `#kel-vast-317` always gives you the same
world. Change the seed box and hit **new world** for another.

The only external request on the page is the webfont (Spectral and IBM Plex).
It degrades to the fallback stack, so offline or behind a proxy everything still
works — the type just changes.

## What you're looking at

Built for a phone: one column, everything tappable, and anything you open
arrives as a bottom sheet you can drag away or dismiss with the back gesture.
The wide layout is the secondary case.

- **Map** — colour is who holds the ground; terrain still reads through it.
  Dots are settlements, pale ones are cities. Tap anywhere for that region's
  holder, ruler and history.
- **The record** — every announcement is tappable. Tap a war and you get the
  war: both belligerents with their rulers and houses, what it was actually
  fought over, its course, what it cost, and how it ended — with the two sides
  held lit on the map behind the sheet. Every sheet ends with what the archive
  can still vouch for at that depth.
- **Timeline** — logarithmic in age, not linear in year, so the last two
  centuries don't collapse into a single pixel on a million-year run. Drag back
  and the map redraws from the archive rather than from live state; states the
  record has forgotten still show their borders, listed as *a state no one
  remembers*.
- **The archive panel** — how full each tier is, and how much has been dropped
  and merged. The retained count stops growing; the forgotten count doesn't.
  Tap a tier to read only what still survives at that depth.
- **Entity pages** — tap any state in the legend, or search a name, to open its
  page: everything the archive still holds that mentions it, cross-linked to
  everyone it appears beside. States, people, houses, settlements, cultures and
  wars all have pages, and all of them are just filtered views of the one event
  log the map reads.

### Links carry a year

A link into the record looks like `#kel-vast-317/p/482/48200` — seed, entity,
and **the year you were looking at**. That last part isn't decoration. Nothing
is stored between visits; a world is re-derived from its seed every time the
page loads, so a link to a state is only meaningful together with a point in
time at which that state existed. Open one and it replays the world to that year
before showing you the page. Seed plus tick count is the entire save file.

## Wars and great houses

A war is an object, not a label. It is declared for a **real reason** read off
the state of the world — a disputed border, a contested succession, ground lost
in an earlier war, a feud between ruling houses, kin under foreign rule, or
plain conquest — and it tallies its own cost as it runs. That matters because
the archive will later swap in a stock cause once the event has been merged
enough times: the substitution only means something if there was a true answer
to lose.

**Houses outlive the states they ruled.** A house can hold several thrones at
once, and holding three makes it one of the great houses. When its last state
falls it is deposed rather than deleted, and for a few centuries it can still be
restored to ground it once held — a house returning after two hundred years in
exile is one of the better things the record turns up. Houses remember the wars
their states fought, and a hot enough feud becomes a cause of war in its own
right.

Houses are also the clearest case of the salience rule: a long-lived house keeps
its own founding alive in the archive for tens of thousands of years, simply by
still existing.

## Design constraints

Two rules that everything else hangs off:

1. **The simulation never reads the archive.** State flows one way. Break this
   and the world stops being a function of its seed, and replay stops working.
2. **Cost per tick is flat.** Tick one million costs what tick one hundred
   thousand cost. Anything that grows with elapsed time lives in the archive,
   under budget, never in the hot loop.

The second one is measured, not assumed — see the boundedness and flat-cost
checks below. Early ticks are genuinely cheaper than late ones (an empty world
has nothing in it); what matters is that the cost plateaus and then stays there.

## Layout

| File | What it does |
| --- | --- |
| `index.html` | Page shell |
| `style.css` | Styling, light/dark aware |
| `src/rng.js` | Seeded PRNG and value noise — the only source of randomness |
| `src/names.js` | Per-culture phonology; names within a culture sound related |
| `src/world.js` | Voronoi-as-raster substrate, terrain, climate, biomes |
| `src/sim.js` | The tick loop — population, expansion, war, collapse, epochs |
| `src/memory.js` | Tiered archive: salience, compaction, distortion, keyframes |
| `src/worker.js` | Runs the sim off the main thread, answers seek and query |
| `src/render.js` | The map, drawn as one ImageData pass over the raster |
| `src/legends.js` | Event structures back into prose |
| `src/app.js` | Page wiring |

## Notes

The Voronoi map has no polygons in it. One raster maps pixel → cell, and that
single structure is the renderer, the adjacency graph, and the source of cell
areas and centroids. Borders are pixels whose neighbour resolves to a different
owner.

The technology ratchet has a pawl that can slip: advancing an era takes
accumulated population-years, and a bad enough catastrophe costs one. Without
that, a long run reaches the last epoch and plays the same century forever.
