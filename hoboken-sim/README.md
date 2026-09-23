# Hoboken in Motion

An agent-based simulation of one day in Hoboken, NJ, in 3D. About 90,000 synthetic people, and
their dogs, move through Hoboken's real streets and buildings. That's 59,149 residents plus
commuters coming in to work or to Stevens, visitors, and NJ Transit riders changing trains at
Hoboken Terminal. The Manhattan skyline stands across the river. The model is calibrated to Census
and transit figures. Where each person goes can be decided by rules or by
[Jev](https://docs.typesafe.ai/), TypeSafe AI's decision model. It runs entirely in the browser.

This folder is self-contained. It doesn't touch the Verdue app, its build or its CI.

## What it shows

- **3D city (default view):** 13,577 building footprints extruded to their real heights, plus
  3,156 Manhattan towers of 40 m or more for the skyline. There are also streets, parks, piers and
  the Hudson, from Overture Maps (OpenStreetMap-derived), release `2026-08-19.0`. Lighting follows
  the sun on the simulated date: a computed sunset (about 6:55 pm on Sept 22), then lit windows.
  Camera presets cover Washington St, Hoboken Terminal, the waterfront and Stevens. Tap anyone to
  see what they're doing and follow them. three.js r128 loads from cdnjs/jsDelivr when the 3D view
  opens. The flat **Map** view needs no library and adds gateway labels and traffic rings.
- **People:** each figure is one synthetic person with a full day plan: home, work, school,
  errands, meals, nights out and time away from Hoboken. Colour shows who they are (resident,
  commuting in, visitor). The 3D view shows only people outdoors: walking, cycling, driving, or in
  a park or dog run.
- **Dogs:** 22% of households are assumed to have one (LOW confidence; see below). One adult walks
  it two or three times a day to one of Hoboken's 8 dog runs or a nearby park. About 1,300 dogs
  are out at 7:30 am on a weekday.
- **Cars and traffic:** drivers follow one-way streets from the four road crossings (Weehawken and
  Lincoln Tunnel, the 14th Street Viaduct, JC Heights, downtown Jersey City) to garages and homes.
  Rail, ferry and bus riders walk to the actual station, terminal or stop.
- **Traffic across the city line:** 13 real gateways, counted live on the map and in the
  "crossing the city line" chart.
- **Checks against published numbers**, a measured Citi Bike panel (for comparison only), sliders
  for the uncertain assumptions, and a person inspector. Where the page runs inside Claude, the
  inspector has an optional "Imagine their thoughts" button.

## Run it

```bash
cd hoboken-sim/web && python3 -m http.server 8000   # then open http://localhost:8000
```

Or build a single self-contained HTML file with the data inlined:

```bash
node hoboken-sim/scripts/bundle.mjs              # dist/hoboken-in-motion.html
node --test hoboken-sim/tests/*.test.mjs         # engine tests (also: npm run test:hoboken)
```

## Let Jev decide

By default each person's venue choices are sampled from the eight likeliest nearby places,
weighted by distance and popularity. That covers where they eat, drink, get coffee, shop, work out
and walk the dog. `jev/run-jev.mjs` hands those choices to Jev instead, through the official
`@typesafe-ai/sdk`. Each person becomes one System One request: the person is the `state`, and
each choice is a `choice` question with the eight options described by name, type and walking
distance. The script samples from Jev's returned probabilities, so similar people don't all pick
the same café. It writes `web/data/jev-<day>.json`. The page then offers a **Rules | Jev** switch,
and the bundler inlines the file.

```bash
cd hoboken-sim && npm install
node jev/run-jev.mjs --dry-run                                    # print one real request and the cost estimate; sends nothing
TYPESAFE_API_KEY=... node jev/run-jev.mjs --people 2000           # a sample of 2,000 people
TYPESAFE_API_KEY=... node jev/run-jev.mjs --people all --yes      # everyone (~47,000 people with choices on a weekday)
```

Cost, at TypeSafe's launch price of $42 per billion input tokens with output free (MEDIUM
confidence; check your console): 2,000 people is about 860k input tokens, roughly $0.04. Everyone
on a weekday is about 20M tokens, roughly $0.85. New accounts get $5 of credit. The script refuses
runs estimated over 5M tokens unless you pass `--yes`.

What Jev changes and what it doesn't:

- **Changes:** which specific place each chosen person picks.
- **Doesn't change:** whether they go out, when, how they commute, or which gateway they use.
  Those stay calibrated to the published figures.
- **The effect stays contained:** each person plans from their own random stream, so a changed
  decision can't reshuffle anyone else. The tests check this.
- **It isn't more accurate by default:** Jev's picks reflect a model's judgment of what such a
  person would choose. The script prints the station counts before and after so you can see any
  drift.

The driver is tested end to end against a local stand-in that follows the SDK's documented
request and response types. It hasn't been run against the live API from this build environment,
which can't reach `api.typesafe.ai`.

## What about Unreal Engine?

The post that prompted this ran San Francisco in Unreal Engine 5. That can't be built or run in the
cloud container this was made in: there's no GPU, UE5 is a ~100 GB download behind an Epic login,
and the network policy blocks it. The path to a UE version is to run Claude Code on a machine with
UE5 installed and import the same data. `build_data.py` already produces the buildings with
heights, the street graph, homes, places and gateways. The engine's day plans would drive the
actors, and Jev's decisions would plug in the same way.

## Rebuild the data

```bash
pip install pyarrow shapely numpy
python3 hoboken-sim/scripts/fetch_overture.py                     # ~4 min, range reads from Overture's S3 bucket
python3 hoboken-sim/scripts/fetch_citibike.py 202509 202606 202607 202608
python3 hoboken-sim/scripts/build_data.py                         # writes web/data/hoboken.json
```

`calibration.json` holds every number the model uses, with its source, year and confidence tag.

## How realistic is it?

| Measure (weekday) | Model | Published | Status |
|---|---|---|---|
| Residents | 59,149 | 59,149 (Census 2024 estimate) | input |
| Employed residents | 39,700 | 39,700 (ACS 2024) | input |
| Work from home | 36.7% | 36.7% (ACS 2024) | input |
| Age mix (6 ACS groups) | within 0.1 point; median 32 | median 31.9 (ACS 2024) | input |
| PATH entries at Hoboken | ~18,400 | ~17,200 derived from 4.99M in 2025 (range 15.5k–19k) | calibrated, within range |
| NJ Transit rail boardings | ~8,000 | 7,790 (2025 average weekday) | calibrated, within 3% |
| Light rail boardings, 3 stops | ~4,100 | 8,172 (2025 average weekday) | **under by ~50%** |

The station counts are calibration targets, not independent validation: the transit shares were
tuned until they landed. The light-rail gap is real. The model leaves out Jersey City Heights
residents who take the 9th Street elevator down to the light rail.

Confidence by component:

- **High:** street geometry, buildings and heights, gateway locations, dog runs, the Citi Bike data.
- **Medium:** population, age mix, employment, commute mode shares and station counts. These came
  through search-result summaries of Census/ACS, PANYNJ and NJ Transit figures because the build
  environment couldn't reach those sites directly. Re-verify them before relying on them.
- **Low:**
  - jobs located in Hoboken: 25,000 (range 18k–32k)
  - people commuting in: 16,000 (11k–22k)
  - visitors: 8,000 on a weekday, 16,000 on a Saturday
  - dog ownership: 22% of households. That's about half the national 42.6% (AVMA 2025); no
    Hoboken count is published.
  - departure-time curves, where residents work, and how many NJ Transit riders only change trains

  These are exposed as sliders or documented as assumptions.

Not modeled: deliveries, rideshare deadheading and through traffic (so car counts are people,
not vehicles); weather; events; bus routes beyond "nearest stop"; cats and other pets that stay
home; anything specific to a real individual.

## Privacy

No real people are in this simulation. It uses only aggregate statistics. It doesn't read
LinkedIn, voter rolls, property records, or any person-level data, and it never assigns names.
Homes are weighted by address-point counts per building, not by who lives there. Business listings
named after an individual (realtors, clinicians, solo practices), legal-entity names, and bare
"Firstname Lastname" listings appear on the map as unnamed workplaces. Overture's phone, email and
social fields are never downloaded. Jev requests describe only the synthetic person and public
place names.

## Files

| Path | What it is |
|---|---|
| `scripts/fetch_overture.py` | Downloads the Hoboken slice of Overture Maps (plus Manhattan towers) with HTTP range reads |
| `scripts/fetch_citibike.py` | Downloads Citi Bike Jersey City/Hoboken trip files |
| `scripts/build_data.py` | Projects and simplifies geometry, builds the routable street graph, snaps homes/places/gateways/dog runs, writes `web/data/hoboken.json` |
| `scripts/bundle.mjs` | Inlines everything into one HTML file |
| `web/sim.js` | Simulation engine: synthetic population, dogs, day plans, the decision hook, routing, positions, statistics |
| `web/view3d.js` | 3D view: extruded buildings, skyline, day/night lighting, instanced people, dogs, bikes and cars |
| `web/app.js`, `web/index.html` | Map view, charts, controls, inspector, Rules/Jev switch |
| `jev/run-jev.mjs` | Sends each person's venue choices to Jev and writes the decision table |
| `calibration.json` | Every input figure with source and confidence |
| `tests/` | Engine invariants, calibration bands, dog walks, and the Jev driver against a local stand-in API |

Map data © OpenStreetMap contributors and Overture Maps Foundation (ODbL / CDLA Permissive 2.0).
Bike data: Citi Bike System Data (Lyft Bikes and Scooters, LLC).
