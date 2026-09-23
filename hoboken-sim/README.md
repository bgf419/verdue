# Hoboken in Motion

An agent-based simulation of one day in Hoboken, NJ. About 90,000 synthetic people move on
Hoboken's real street grid: 59,149 residents, plus commuters coming in to work or to Stevens,
visitors, and NJ Transit riders changing trains at Hoboken Terminal. The model is calibrated to
Census and transit figures. Measured Citi Bike trips are shown alongside for comparison but aren't
a model input. It runs entirely in the browser.

This folder is self-contained. It doesn't touch the Verdue app, its build or its CI.

## What it shows

- **The map:** 13,577 building footprints, 3,160 street segments with one-way rules, parks, piers,
  rail lines and 2,754 places, all from Overture Maps (OpenStreetMap-derived), release `2026-08-19.0`.
  The map follows the day: it darkens through twilight after a sunset computed from the sun's
  position (about 6:55 pm on Sept 22). People at home show as faint dots inside their building.
- **People:** each dot is one synthetic person with a full day plan (home, work, school, errands,
  meals, nights out, time away from Hoboken). Colour shows who they are (resident, commuting in,
  visitor). Shape shows how they're moving (on foot, bike, car).
- **Traffic across the city line:** 13 real gateways. They are the PATH, NJ Transit rail and ferry
  at Hoboken Terminal, three light-rail stops, the 14th Street ferry, four road crossings
  (Weehawken/Lincoln Tunnel, the 14th Street Viaduct, JC Heights, downtown Jersey City) and two
  waterfront walkways. Rings on the map and the "crossing the city line" chart count them.
- **Checks against published numbers**, a measured Citi Bike panel (for comparison only), sliders for the uncertain
  assumptions, and a person inspector. Where the page runs inside Claude, the inspector has an
  optional "Imagine their thoughts" button.

## Run it

```bash
cd hoboken-sim/web && python3 -m http.server 8000   # then open http://localhost:8000
```

Or build a single self-contained HTML file with the data inlined:

```bash
node hoboken-sim/scripts/bundle.mjs              # dist/hoboken-in-motion.html
node --test hoboken-sim/tests/*.test.mjs         # engine tests (also: npm run test:hoboken)
```

## Rebuild the data

```bash
pip install pyarrow shapely numpy
python3 hoboken-sim/scripts/fetch_overture.py                     # ~3 min, range reads from Overture's S3 bucket
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
| PATH entries at Hoboken | ~18,400 | ~17,200 derived from 4.99M in 2025 (range 15.5k–19k) | calibrated, within range |
| NJ Transit rail boardings | ~7,900 | 7,790 (2025 average weekday) | calibrated, within 2% |
| Light rail boardings, 3 stops | ~4,100 | 8,172 (2025 average weekday) | **under by ~50%** |

The station counts are calibration targets, not independent validation: the transit shares were
tuned until they landed. The light-rail gap is real. The model leaves out Jersey City Heights
residents who take the 9th Street elevator down to the light rail.

Confidence by component:

- **High:** street geometry, buildings, gateway locations, the Citi Bike data.
- **Medium:** population, age mix (the synthetic population matches the ACS age groups to within
  0.1 point; median 32 vs 31.9), employment, commute mode shares and station counts. These came
  through search-result summaries of Census/ACS, PANYNJ and NJ Transit figures because the build
  environment couldn't reach those sites directly. Re-verify them before relying on them.
- **Low:** jobs located in Hoboken (25,000; range 18k–32k), people commuting in (16,000;
  11k–22k), visitors (8,000 weekday, 16,000 Saturday), departure-time curves, where residents work,
  and how many NJ Transit riders only change trains. These are exposed as sliders or documented
  as assumptions.

Not modeled: deliveries, rideshare deadheading and through traffic (so car counts are people,
not vehicles); weather; events; bus routes beyond "nearest stop"; anything specific to a real
individual.

## Privacy

No real people are in this simulation. It uses only aggregate statistics. It doesn't read
LinkedIn, voter rolls, property records, or any person-level data, and it never assigns names.
Homes are weighted by address-point counts per building, not by who lives there. Business listings
named after an individual (realtors, clinicians, solo practices), legal-entity names, and bare
"Firstname Lastname" listings appear on the map as unnamed workplaces. Overture's phone, email and
social fields are never downloaded.

## Files

| Path | What it is |
|---|---|
| `scripts/fetch_overture.py` | Downloads the Hoboken slice of Overture Maps with HTTP range reads |
| `scripts/fetch_citibike.py` | Downloads Citi Bike Jersey City/Hoboken trip files |
| `scripts/build_data.py` | Projects and simplifies geometry, builds the routable street graph, snaps homes/places/gateways, writes `web/data/hoboken.json` |
| `scripts/bundle.mjs` | Inlines everything into one HTML file |
| `web/sim.js` | Simulation engine: synthetic population, day plans, routing, positions, statistics |
| `web/app.js`, `web/index.html` | Map, charts, controls, inspector |
| `calibration.json` | Every input figure with source and confidence |
| `tests/sim.test.mjs` | Engine invariants and calibration bands |

Map data © OpenStreetMap contributors and Overture Maps Foundation (ODbL / CDLA Permissive 2.0).
Bike data: Citi Bike System Data (Lyft Bikes and Scooters, LLC).
