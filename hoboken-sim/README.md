# Hoboken in Motion

An agent-based simulation of one day in Hoboken, NJ, in 3D. About 90,000 synthetic people, and
their dogs, move through Hoboken's real streets and buildings. That's 59,149 residents plus
commuters coming in to work or to Stevens, visitors, and NJ Transit riders changing trains at
Hoboken Terminal. The Manhattan skyline stands across the river. The model is calibrated to Census
and transit figures. Every decision in the day (whether people go out, when, how they travel,
where they go, how long they stay, when the dog gets walked, which road drivers take and where
they park) can be made by rules or by [Jev](https://docs.typesafe.ai/), TypeSafe AI's decision
model. It runs in the browser, and the same day can be exported to Unreal Engine 5.

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
  it two or three times a day to one of Hoboken's 8 dog runs or a nearby park. About 1,340 dogs
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

Every behavioural choice in the engine goes through one decision hook, about 910,000 decisions
on a weekday and 1,050,000 on a Saturday:
- **Whether:** work from home today, go to the gym, get coffee, go out to eat or drink, leave
  Hoboken for a few hours.
- **When:** leaving for work, class, the dog's walks, errands, nights out; which hour, with the
  minute left to chance.
- **How:** PATH, NJ Transit, light rail, ferry, bus, car, bike or on foot; which road crossing,
  station, ferry terminal or garage.
- **Where:** which of the eight likeliest nearby restaurants, bars, cafés, gyms, parks, dog runs or
  shops.
- **How long:** a short, medium or long stay; the length of a working day.

By default the rules answer, sampling calibrated weights. `jev/run-jev.mjs` hands every one of
these decisions to Jev through the official `@typesafe-ai/sdk`:
- **Requests:** one person per request with up to 12 questions. The person (age, household,
  employment, dog, street) is the `state`. Yes/no questions go as `noul` and the rest as `choice`,
  with places described by name, type and walking distance. Jev is never shown what the rules
  decided.
- **Sampling:** the script samples each answer from Jev's probabilities, so similar people don't
  all make the same choice.
- **Rounds:** a different answer can open a branch the rules never took (Jev sends someone to
  dinner whom the rules kept home), so later rounds ask about those. Against a stand-in API that
  disagrees with the rules on purpose, the whole city settled in 6 rounds.
- **Raking:** answers that set published totals are raked back to those totals: working from
  home, trips out of town, travel modes and NJ Transit connections. Jev decides *who* takes the
  PATH; the published counts decide *how many*. Everything else, such as timing, places, lengths
  of stay and dogs, is Jev's own. `--raw` turns raking off.
- **Output:** it writes `web/data/jev-<day>.json`, about 1.5 MB with the answers packed and
  gzipped. The page then offers a **Rules | Jev** switch, and the inspector says how many of each
  person's decisions Jev made.

Who people are (ages, households, jobs, dogs), where they live and work, school hours and the
exact street route between two points aren't decisions. They come from the Census, job counts,
school timetables and the street graph.

```bash
cd hoboken-sim && npm install
node jev/run-jev.mjs --dry-run                                  # print a real request and the cost; sends nothing
TYPESAFE_API_KEY=... node jev/run-jev.mjs --people 2000         # a sample of 2,000 people
TYPESAFE_API_KEY=... node --max-old-space-size=8192 jev/run-jev.mjs --people all --yes              # everyone, weekday
TYPESAFE_API_KEY=... node --max-old-space-size=8192 jev/run-jev.mjs --people all --yes --day weekend
```

Cost is estimated at TypeSafe's launch price of $42 per billion input tokens, with output free
(MEDIUM confidence; check your console):
- **First round, everyone:** about 63M input tokens (~$2.66) on a weekday and 72M (~$3.01) on a
  Saturday.
- **Whole run:** later rounds add up to about 1.5× more; the contrarian stand-in needed 156M tokens
  (~$6.54) for a weekday. Budget roughly $6–14 for both days.
- **Sample:** 2,000 people costs about $0.06–0.15.
- **Credit:** new accounts reportedly get $5 of credit.
- **Guard:** the script refuses a first round estimated over 5M tokens unless you pass `--yes`.

A full-city run is about 120,000–290,000 requests. Its speed depends on TypeSafe's latency and rate
limits, which I haven't measured; `--concurrency` sets how many run at once (default 16). It uses
about 3.5 GB of memory, hence the larger heap.

What to expect:
- **Contained:** each person plans from their own random stream, so changing one person's
  decisions can't reshuffle anyone else. The tests check this.
- **Not automatically more accurate:** Jev's answers are a model's judgment of what such a person
  would do. The raked totals stay on the published figures; the timing, places and habits are
  Jev's. The script prints the station counts before and after.
- **Untested against the live API:** the driver is tested end to end against a local stand-in that
  follows the SDK's request and response types. It has never run against the real API, because
  this build environment can't reach `api.typesafe.ai` and has no key.

## Make a video

`scripts/film.mjs` renders a 47-second flythrough of the day. The shots:
- dawn over Hoboken
- the first dog walks at Church Square Park
- rush hour at Hoboken Terminal
- the evening rush on Washington Street
- sunset over Manhattan from Pier A
- a night out

A live clock and counts of people, cars and dogs run throughout. The script drives the same 3D view frame by frame in headless Chromium and encodes with ffmpeg. A corner label says whether the decisions came from the rules or from Jev.

```bash
cd hoboken-sim
npm install --no-save playwright && npx playwright install chromium   # plus ffmpeg on the PATH
node scripts/film.mjs                  # dist/hoboken-weekday.mp4, rules
node scripts/film.mjs --jev            # the same film with Jev's day, after jev/run-jev.mjs
node scripts/film.mjs --still 9,30     # single frames, for checking shots
```

It renders with software WebGL, so the frames come out the same on any machine. That's slow: about
1 second per frame on 4 CPU cores, or roughly 18 minutes for the 1,128 frames of the 47-second film.

## Unreal Engine 5

The post that prompted this showed San Francisco in Unreal Engine 5. Unreal can't run in the cloud
container this was built in: there's no GPU, and the engine is a ~100 GB download behind an Epic
login. Instead:
- `scripts/export_unreal.mjs` writes the city and one simulated day, rules or Jev (`--jev`), as a
  `.hday` file, plus a `.glb` of the city for Blender.
- `unreal/HobokenSim` is an Unreal plugin that builds the city from that file and plays the day
  with instanced people, dogs, bikes and cars.

The file reader at its core is plain C++ and is tested here against the browser engine. The
Unreal-specific part hasn't been compiled. Setup and caveats: [unreal/README.md](unreal/README.md).

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
| PATH entries at Hoboken | ~18,300 | ~17,200 derived from 4.99M in 2025 (range 15.5k–19k) | calibrated, within range |
| NJ Transit rail boardings | ~7,960 | 7,790 (2025 average weekday) | calibrated, within 3% |
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
| `web/sim.js` | Simulation engine: synthetic population, dogs, day plans, the decision hook and its answer sources, routing, positions, statistics |
| `web/view3d.js` | 3D view: extruded buildings, skyline, day/night lighting, instanced people, dogs, bikes and cars |
| `web/app.js`, `web/index.html` | Map view, charts, controls, inspector, Rules/Jev switch |
| `jev/run-jev.mjs` | Sends every decision in the day to Jev, rakes the published totals, packs the answers for the page |
| `scripts/export_unreal.mjs` | Writes the city and a day as a `.hday` file for Unreal, plus a `.glb` of the city |
| `scripts/film.mjs` | Renders a flythrough video of the day from the 3D view (rules or Jev) |
| `unreal/HobokenSim` | Unreal Engine 5 plugin: `HobokenDay.h` reads the day file (plain C++), `HobokenCrowd` builds and plays it |
| `unreal/tools/day_check.cpp` | Command-line check of `HobokenDay.h`, used by the tests |
| `calibration.json` | Every input figure with source and confidence |
| `tests/` | Engine invariants, calibration bands, dog walks, the decision hook, the Jev driver against a local stand-in API, and the Unreal export against the browser engine |

Map data © OpenStreetMap contributors and Overture Maps Foundation (ODbL / CDLA Permissive 2.0).
Bike data: Citi Bike System Data (Lyft Bikes and Scooters, LLC).
