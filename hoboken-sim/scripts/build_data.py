#!/usr/bin/env python3
"""Build hoboken-sim/web/data/hoboken.json from the cached Overture and Citi Bike extracts.

Inputs  (see fetch_overture.py / fetch_citibike.py):
  .cache/overture/*.parquet, .cache/citibike/JC-*.csv, calibration.json
Output: web/data/hoboken.json

Coordinates are projected to a local metric plane centred on Hoboken (x east, y north)
and stored as integers in half-metres. No person-level data is read or written:
residents are synthesised in the browser from Census aggregates, homes are weighted by
address-point counts, and business names that look like an individual's name are dropped.
"""
import collections
import csv
import datetime
import glob
import json
import math
import pathlib
import re

import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely import wkb
from shapely.geometry import Point, box
from shapely.ops import substring, unary_union
from shapely.strtree import STRtree

ROOT = pathlib.Path(__file__).resolve().parent.parent
OVERTURE = ROOT / ".cache" / "overture"
CITIBIKE = ROOT / ".cache" / "citibike"
OUT = ROOT / "web" / "data" / "hoboken.json"

LON0, LAT0 = -74.0300, 40.7450
_phi = math.radians(LAT0)
MX = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi)
MY = 111132.92 - 559.82 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)
Q = 2  # store coordinates in half-metres

VIEW_LL = (-74.0580, 40.7270, -73.9960, 40.7660)
GRAPH_BUFFER_M = 450

DRIVE = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service", "unknown"}
WALK_ONLY = {"footway", "pedestrian", "path", "steps", "cycleway", "track", "bridleway"}
ROAD_CODE = {"motorway": 1, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4, "residential": 5, "unclassified": 5,
             "living_street": 5, "unknown": 5, "service": 6, "pedestrian": 7, "footway": 7, "path": 7, "steps": 7,
             "cycleway": 8, "track": 7, "bridleway": 7}
RAIL_CODE = {"standard_gauge": 10, "light_rail": 11, "subway": 12, "unknown": 10}

EDGE_WALK, EDGE_BIKE, EDGE_CAR_FWD, EDGE_CAR_BWD, EDGE_MAJOR, EDGE_PATH = 1, 2, 4, 8, 16, 32


def project(geom):
    return shapely.transform(geom, lambda c: np.column_stack(((c[:, 0] - LON0) * MX, (c[:, 1] - LAT0) * MY)))


def pt(lon, lat):
    return Point((lon - LON0) * MX, (lat - LAT0) * MY)


def q(v):
    return int(round(v * Q))


def flat(coords):
    out = []
    for x, y in coords:
        out.extend((q(x), q(y)))
    return out


def rings(poly, tol):
    """Polygon/MultiPolygon -> list of polygons, each a list of flat rings (exterior first)."""
    out = []
    poly = poly.simplify(tol, preserve_topology=True)
    for p in getattr(poly, "geoms", [poly]):
        if p.geom_type != "Polygon" or p.is_empty or p.area < 1:
            continue
        rs = [flat(list(p.exterior.coords)[:-1])]
        rs += [flat(list(r.coords)[:-1]) for r in p.interiors if shapely.Polygon(r).area > 4]
        out.append(rs)
    return out


def read(name, columns=None):
    return pq.read_table(OVERTURE / f"{name}.parquet", columns=columns).to_pylist()


def primary_name(row):
    names = row.get("names") or {}
    return (names.get("primary") or "").strip() or None


# --------------------------------------------------------------------------------------
# Boundaries, water, parks, piers
# --------------------------------------------------------------------------------------
cal = json.loads((ROOT / "calibration.json").read_text())
release = pq.read_schema(OVERTURE / "buildings.parquet").metadata.get(b"overture_release", b"2026-08-19.0").decode()

view_ll = box(*VIEW_LL)
view = project(view_ll)
divisions = read("divisions")
hoboken_ll = next(wkb.loads(d["geometry"]) for d in divisions if primary_name(d) == "Hoboken" and d["subtype"] == "locality")
hoboken = project(hoboken_ll)
graph_area = hoboken.buffer(GRAPH_BUFFER_M)

neighbors = []
for d in divisions:
    name = primary_name(d)
    if d["subtype"] == "locality" and name in {"Jersey City", "Weehawken", "Union City", "West New York", "North Bergen", "Manhattan"}:
        g = project(wkb.loads(d["geometry"])).intersection(view)
        if not g.is_empty:
            c = g.representative_point()
            neighbors.append({"name": name, "polys": rings(g, 4), "label": [q(c.x), q(c.y)]})

water_geoms = [project(wkb.loads(w["geometry"])) for w in read("water")
               if w["subtype"] in {"river", "ocean", "water", "canal", "reservoir", "pond"}]
water_all = unary_union([g for g in water_geoms if g.area > 400])
water = water_all.intersection(view)
# The 3D view looks out to the horizon, so it gets the river out to the edge of the context frame.
CONTEXT_LL = (-74.0750, 40.7150, -73.9750, 40.7800)
context = project(box(*CONTEXT_LL))
water3d = water_all.intersection(context)

PARK_CLASSES = {("park", "park"), ("park", "dog_park"), ("recreation", "pitch"), ("recreation", "playground"),
                ("recreation", "recreation_ground"), ("recreation", "track"), ("pedestrian", "plaza")}
park_geoms = []
for lu in read("land_use"):
    key = (lu["subtype"], lu["class"])
    g = project(wkb.loads(lu["geometry"]))
    if g.geom_type not in ("Polygon", "MultiPolygon"):
        continue
    if key in PARK_CLASSES or (key == ("managed", "grass") and g.area >= 300):
        g = g.intersection(view)
        if not g.is_empty:
            park_geoms.append(g)
parks = unary_union(park_geoms) if park_geoms else None

campus_geoms = [project(wkb.loads(lu["geometry"])) for lu in read("land_use")
                if lu["subtype"] == "education" and lu["class"] in {"university", "college"}]
campus = unary_union(campus_geoms).buffer(5) if campus_geoms else None

piers = []
bus_stops_ll = []
for inf in read("infrastructure"):
    g = wkb.loads(inf["geometry"])
    if inf["class"] == "pier" and g.geom_type in ("Polygon", "MultiPolygon"):
        piers.extend(rings(project(g), 0.8))
    elif inf["class"] == "bus_stop" and g.geom_type == "Point":
        bus_stops_ll.append(g)

# --------------------------------------------------------------------------------------
# Places (named venues and workplaces)
# --------------------------------------------------------------------------------------
GROUPS = ["food", "nightlife", "cafe", "grocery", "retail", "fitness", "health", "school", "university", "civic",
          "worship", "park", "office", "personal", "hotel", "arts", "transit", "parking", "landmark"]
G = {g: i for i, g in enumerate(GROUPS)}

CATEGORY_GROUP = {
    "restaurant": "food", "casual_eatery": "food", "food_truck_stand": "food", "pizza_restaurant": "food",
    "fast_food_restaurant": "food", "bakery": "cafe", "dessert_shop": "cafe", "ice_cream_shop": "cafe",
    "bar": "nightlife", "lounge": "nightlife", "pub": "nightlife", "cocktail_bar": "nightlife", "night_club": "nightlife",
    "wine_bar": "nightlife", "brewery": "nightlife", "sports_bar": "nightlife",
    "coffee_shop": "cafe", "cafe": "cafe", "smoothie_juice_bar": "cafe", "tea_room": "cafe", "bubble_tea_shop": "cafe",
    "food_and_beverage_store": "grocery", "convenience_store": "grocery", "grocery_store": "grocery", "supermarket": "grocery",
    "pharmacy_and_drug_store": "grocery", "liquor_store": "grocery",
    "gym": "fitness", "fitness_studio": "fitness", "sport_or_fitness_facility": "fitness", "sport_or_recreation_club": "fitness",
    "swimming_pool": "fitness", "yoga_studio": "fitness", "martial_arts_studio": "fitness", "sport_court": "fitness",
    "elementary_school": "school", "high_school": "school", "middle_school": "school", "preschool": "school",
    "college_university": "university", "campus_building": "university", "research_institute": "university",
    "government_office": "civic", "community_and_government": "civic", "fire_station": "civic", "police_station": "civic",
    "post_office": "civic", "library": "civic", "social_or_community_service": "civic",
    "christian_place_of_worship": "worship", "place_of_worship": "worship", "jewish_place_of_worship": "worship",
    "muslim_place_of_worship": "worship",
    "park": "park", "dog_park": "park", "playground": "park", "sports_and_recreation": "park", "pier": "park", "marina": "park",
    "hotel": "hotel", "lodging": "hotel",
    "art_gallery": "arts", "arts_and_entertainment": "arts", "event_venue": "arts", "museum": "arts", "theater": "arts",
    "music_venue": "arts", "cinema": "arts",
    "historic_site": "landmark",
    "train_station": "transit", "travel_and_transportation": "transit", "bus_station": "transit",
    "parking": "parking", "parking_garage": "parking", "parking_lot": "parking",
    "personal_or_beauty_service": "personal", "laundry_service": "personal", "animal_or_pet_service": "personal",
    "home_service": "personal", "family_service": "personal", "rental_service": "personal",
}
ROOT_GROUP = {"food_and_drink": "food", "shopping": "retail", "health_care": "health", "lifestyle_services": "personal",
              "sports_and_recreation": "fitness", "education": "school", "community_and_government": "civic",
              "arts_and_entertainment": "arts", "lodging": "hotel", "travel_and_transportation": "transit",
              "services_and_business": "office", "cultural_and_historic": "landmark"}
ROOT_GROUP["travel_and_transportation"] = "office"  # travel agencies, car washes, drivers: only stations count as transit
# Groups whose names are shown on the map. Everything else (clinics, offices, personal
# services, realtors, attorneys...) is kept as an anonymous workplace/destination because
# those listings are frequently named after an individual practitioner.
NAMED_GROUPS = {"food", "nightlife", "cafe", "grocery", "retail", "fitness", "school", "university", "civic", "worship",
                "park", "hotel", "arts", "transit", "parking", "landmark"}
PERSONAL_NAME = re.compile(
    r"(\bDr\.?\s|\bM\.?D\.?\b|\bD\.?D\.?S\b|\bDMD\b|\bD\.?O\.?\b|\bPh\.?D\b|\bPsyD\b|\bLCSW\b|\bLPC\b|\bLMHC\b|\bLMFT\b"
    r"|\bEsq\b|\bCPA\b|\bR\.?N\.?\b|\bNP\b|\bPA-C\b|\bDPM\b|\bD\.?C\.?\b|\bRealtor|\bRealty\b|\bBroker|\bAgent\b"
    r"|Keller Williams|Coldwell|Compass|RE/MAX|Century 21|Sotheby|Elliman|Weichert|Brown Harris|Corcoran|\beXp\b"
    r"|State Farm|Allstate|Farmers Insurance|Edward Jones|Northwestern Mutual|New York Life|\|| - |: )",
    re.I,
)
LEGAL_ENTITY = re.compile(r"\b(llc|l\.l\.c|inc|corp|corporation|associates|holdings|ventures|group)\b\.?", re.I)
# Common US given names: a bare "Firstname Lastname" listing is treated as a person, not a venue.
FIRST_NAMES = set("""
aaron adam adrian adriana aiden alan albert alex alexa alexander alexandra alexis alice alicia alison allison amanda amber amy
ana andrea andrew angela angelica anita ann anna anne anthony antonio april ari ariel arthur ashley austin barbara ben benjamin
beth betty beverly bill billy bob bonnie brad brandon brenda brian brianna brittany brooke bruce bryan caitlin carl carla carlos
carmen carol caroline carolyn catherine charles charlie charlotte chelsea cheryl chris christian christina christine christopher
cindy claire claudia colin connor courtney craig crystal cynthia dan dana daniel danielle david dean debbie deborah denise dennis
derek diana diane donald donna doris dorothy douglas dylan eddie edward elena elizabeth ellen emily emma eric erica erin ethan eva
evan evelyn frank gabriel gabriela gail gary george gerald gina gloria grace greg gregory hannah harold harry heather helen henry
holly ian ira irene isaac isabel isabella jack jackie jacob jacqueline jake james jamie jane janet janice jason jay jean jeff jeffrey
jenna jennifer jeremy jerry jesse jessica jill jim jimmy joan joe joel john johnny jon jonathan jordan jose joseph josh joshua joy
joyce juan judith judy julia julie justin karen kate katherine kathleen kathryn kathy katie kayla keith kelly ken kenneth kevin
kim kimberly kristen kristin kyle laura lauren leah lee leo leslie lily linda lindsay lisa liz logan lori louis luis lynn madison
marc marcus margaret maria marie marilyn mark martha martin mary matt matthew max megan melanie melissa michael michele michelle
mike miranda molly monica morgan nancy natalie nathan nicholas nick nicole noah nora olivia pamela patricia patrick paul paula
peter philip rachel ralph randy raymond rebecca richard rick rita rob robert robin roger ron ronald rose ross ruth ryan sam samantha
samuel sandra sara sarah scott sean sharon shawn sheila stephanie stephen steve steven susan tammy tanya teresa terry theresa thomas
tiffany tim timothy tina todd tom tony tracy tyler valerie vanessa victor victoria vincent virginia walter wayne wendy william zach
""".split())


def looks_personal(name):
    if PERSONAL_NAME.search(name) or LEGAL_ENTITY.search(name):
        return True
    words = re.findall(r"[A-Za-z][A-Za-z'.\-]*", name)
    if len(words) == 2 and words[0].lower() in FIRST_NAMES and words[1][:1].isupper():
        return True
    return len(words) == 3 and words[0].lower() in FIRST_NAMES and len(words[1].rstrip(".")) == 1


JOBS_BY_GROUP = {"food": 14, "nightlife": 10, "cafe": 6, "grocery": 8, "retail": 4, "fitness": 5, "health": 6,
                 "school": 30, "university": 20, "civic": 20, "worship": 2, "park": 1, "office": 9, "personal": 3,
                 "hotel": 20, "arts": 4, "transit": 0, "parking": 2, "landmark": 0}
BIG_EMPLOYERS = [  # (name pattern, jobs) - approximate headcounts, LOW confidence
    (r"^Stevens Institute of Technology$", 700),
    (r"Hoboken University Medical Center", 900),
    (r"^City Hall, Hoboken|^Hoboken City Hall$", 250),
    (r"^Shop ?rite$", 120), (r"^ACME Markets$", 80), (r"^Acme Markets$", 60), (r"^Trader Joe's$", 70),
    (r"^Hoboken High School$", 120), (r"^Hoboken Terminal$", 150),
]
VISIT_WEIGHT = {"food": 3, "nightlife": 3, "cafe": 3, "grocery": 4, "retail": 1.2, "fitness": 2, "health": 1, "school": 0,
                "university": 0, "civic": 0.6, "worship": 0.5, "park": 4, "office": 0.2, "personal": 0.8, "hotel": 0.3,
                "arts": 1, "transit": 0, "parking": 0, "landmark": 0.6}


def place_group(p):
    cat = p["basic_category"] or ((p.get("categories") or {}).get("primary"))
    if cat in CATEGORY_GROUP:
        return CATEGORY_GROUP[cat]
    if cat and (cat.endswith("_store") or cat.endswith("_shop")):
        return "retail"
    if cat and ("clinic" in cat or "health" in cat or "medical" in cat or "dental" in cat or "care" in cat):
        return "health"
    if cat and ("school" in cat or "learning" in cat or "education" in cat):
        return "school"
    root = ((p.get("taxonomy") or {}).get("hierarchy") or [None])[0]
    return ROOT_GROUP.get(root, "office")


hoboken_near = hoboken.buffer(30)
places = []
for p in read("places"):
    if p["operating_status"] == "permanently_closed" or (p["confidence"] or 0) < 0.55:
        continue
    g = project(wkb.loads(p["geometry"]))
    if not hoboken_near.contains(g):
        continue
    group = place_group(p)
    name = primary_name(p)
    shown = name if (group in NAMED_GROUPS and name and not looks_personal(name)) else None
    jobs = JOBS_BY_GROUP[group]
    for pattern, headcount in BIG_EMPLOYERS:
        if name and re.search(pattern, name, re.I):
            jobs = headcount
    places.append({"x": g.x, "y": g.y, "group": group, "name": shown, "jobs": jobs, "cat": p["basic_category"]})

# Dog runs: the land-use polygons are authoritative; reuse a named place when one sits on the run.
DOG_NAME = re.compile(r"\bdog (park|run|playpen)\b", re.I)
for p in places:
    p["dog"] = p["cat"] == "dog_park" or bool(p["name"] and DOG_NAME.search(p["name"]))
    if p["dog"] and any(q is not p and q.get("dog") and math.hypot(p["x"] - q["x"], p["y"] - q["y"]) < 40 for q in places):
        p["dog"] = False  # a second listing for a run already counted
for lu in read("land_use"):
    if lu["class"] != "dog_park":
        continue
    c = project(wkb.loads(lu["geometry"])).representative_point()
    if not hoboken_near.contains(c):
        continue
    near = [p for p in places if p["dog"] and math.hypot(p["x"] - c.x, p["y"] - c.y) < 60]
    if near:
        continue
    name = primary_name(lu)
    places.append({"x": c.x, "y": c.y, "group": "park", "name": name if name and not looks_personal(name) else None,
                   "jobs": 0, "cat": "dog_park", "dog": True})

# --------------------------------------------------------------------------------------
# Street graph (Overture segments split at connectors)
# --------------------------------------------------------------------------------------
segments = read("segments")


def one_way(restrictions):
    """Return (car_forward_ok, car_backward_ok, cars_ok, walk_ok) for a segment."""
    fwd = bwd = cars = walk = True
    for r in restrictions or []:
        when = r.get("when") or {}
        modes = when.get("mode") or []
        motor = not modes or any(m in modes for m in ("motor_vehicle", "car", "vehicle"))
        if r["access_type"] != "denied" or r.get("between"):
            continue
        heading = when.get("heading")
        if heading == "backward" and motor:
            bwd = False
        elif heading == "forward" and motor:
            fwd = False
        elif not heading and modes and "foot" in modes:
            walk = False
        elif not heading and modes and motor and "bicycle" not in modes:
            cars = False
    return fwd, bwd, cars, walk


nodes = {}          # connector id -> index
node_xy = []
edges = []          # dicts
for s in segments:
    if s["subtype"] != "road":
        continue
    cls, sub = s["class"], s["subclass"]
    if cls == "footway" and sub in {"sidewalk", "crosswalk"}:
        continue
    if cls == "service" and sub in {"parking_aisle", "driveway"}:
        continue
    line = project(wkb.loads(s["geometry"]))
    if not line.intersects(graph_area):
        continue
    conns = sorted((c["at"], c["connector_id"]) for c in (s["connectors"] or []))
    if len(conns) < 2:
        continue
    fwd, bwd, cars_ok, walk_ok = one_way(s["access_restrictions"])
    drivable = cls in DRIVE
    flags = 0
    if walk_ok and cls not in {"motorway", "trunk"}:
        flags |= EDGE_WALK
    if cls not in {"motorway", "trunk", "steps"}:
        flags |= EDGE_BIKE
    if drivable and cars_ok and cls != "pedestrian":
        if fwd:
            flags |= EDGE_CAR_FWD
        if bwd:
            flags |= EDGE_CAR_BWD
    if cls in {"motorway", "trunk", "primary", "secondary"}:
        flags |= EDGE_MAJOR
    if cls in WALK_ONLY:
        flags |= EDGE_PATH
    name = primary_name(s)
    for (a_at, a_id), (b_at, b_id) in zip(conns, conns[1:]):
        if b_at - a_at <= 1e-9:
            continue
        piece = substring(line, a_at, b_at, normalized=True)
        if piece.is_empty or piece.length < 0.3 or not piece.intersects(graph_area):
            continue
        coords = list(piece.coords)
        for cid, xy in ((a_id, coords[0]), (b_id, coords[-1])):
            if cid not in nodes:
                nodes[cid] = len(node_xy)
                node_xy.append(xy)
        edges.append({"a": nodes[a_id], "b": nodes[b_id], "len": piece.length, "flags": flags,
                      "cls": ROAD_CODE.get(cls, 5), "geom": piece.simplify(0.6), "name": name})

# Keep the largest walkable component so every agent can reach every destination.
adj = collections.defaultdict(list)
for i, e in enumerate(edges):
    if e["flags"] & EDGE_WALK:
        adj[e["a"]].append(i)
        adj[e["b"]].append(i)
seen, best = set(), set()
for start in list(adj):
    if start in seen:
        continue
    comp, stack = {start}, [start]
    seen.add(start)
    while stack:
        n = stack.pop()
        for i in adj[n]:
            m = edges[i]["b"] if edges[i]["a"] == n else edges[i]["a"]
            if m not in seen:
                seen.add(m)
                comp.add(m)
                stack.append(m)
    if len(comp) > len(best):
        best = comp
for e in edges:
    if e["a"] not in best or e["b"] not in best:
        e["flags"] &= ~(EDGE_WALK | EDGE_BIKE)


# Cars: keep only edges inside the strongly connected component of the drivable graph.
def car_neighbors(reverse=False):
    out = collections.defaultdict(list)
    for e in edges:
        if e["flags"] & EDGE_CAR_FWD:
            (out[e["b"]] if reverse else out[e["a"]]).append(e["a"] if reverse else e["b"])
        if e["flags"] & EDGE_CAR_BWD:
            (out[e["a"]] if reverse else out[e["b"]]).append(e["b"] if reverse else e["a"])
    return out


def reach(start, graph):
    seen = {start}
    stack = [start]
    while stack:
        n = stack.pop()
        for m in graph[n]:
            if m not in seen:
                seen.add(m)
                stack.append(m)
    return seen


fwd_graph, bwd_graph = car_neighbors(), car_neighbors(reverse=True)
seed = min((n for n in fwd_graph), key=lambda n: Point(node_xy[n]).distance(pt(-74.0320, 40.7440)))
scc = reach(seed, fwd_graph) & reach(seed, bwd_graph)
for e in edges:
    if e["a"] not in scc or e["b"] not in scc:
        e["flags"] &= ~(EDGE_CAR_FWD | EDGE_CAR_BWD)

edges = [e for e in edges if e["flags"] & (EDGE_WALK | EDGE_BIKE | EDGE_CAR_FWD | EDGE_CAR_BWD)]


def flip(flags):
    """Flags of an edge read in the opposite direction (one-way bits swap)."""
    out = flags & ~(EDGE_CAR_FWD | EDGE_CAR_BWD)
    if flags & EDGE_CAR_FWD:
        out |= EDGE_CAR_BWD
    if flags & EDGE_CAR_BWD:
        out |= EDGE_CAR_FWD
    return out


def contract(edges):
    """Merge chains through pass-through nodes (degree 2, same class and access) into single edges."""
    incident = collections.defaultdict(list)
    for i, e in enumerate(edges):
        incident[e["a"]].append(i)
        incident[e["b"]].append(i)
    alive = [True] * len(edges)
    for n in list(incident):
        ids = [i for i in incident[n] if alive[i]]
        if len(ids) != 2:
            continue
        e1, e2 = edges[ids[0]], edges[ids[1]]
        a = e1["b"] if e1["a"] == n else e1["a"]
        b = e2["b"] if e2["a"] == n else e2["a"]
        if n in (a, b) or a == b or e1["cls"] != e2["cls"]:
            continue
        f1 = e1["flags"] if e1["a"] == a else flip(e1["flags"])      # a -> n
        g1 = list(e1["geom"].coords) if e1["a"] == a else list(e1["geom"].coords)[::-1]
        f2 = e2["flags"] if e2["a"] == n else flip(e2["flags"])      # n -> b
        g2 = list(e2["geom"].coords) if e2["a"] == n else list(e2["geom"].coords)[::-1]
        if f1 != f2:
            continue
        merged = {"a": a, "b": b, "len": e1["len"] + e2["len"], "flags": f1, "cls": e1["cls"],
                  "geom": shapely.LineString(g1 + g2[1:]).simplify(0.6), "name": e1["name"] or e2["name"]}
        alive[ids[0]] = alive[ids[1]] = False
        edges.append(merged)
        alive.append(True)
        new = len(edges) - 1
        incident[a] = [new if i == ids[0] else i for i in incident[a]]
        incident[b] = [new if i == ids[1] else i for i in incident[b]]
        incident[n] = []
    return [e for e, keep in zip(edges, alive) if keep]


edges = contract(edges)
used = sorted({e["a"] for e in edges} | {e["b"] for e in edges})
remap = {old: new for new, old in enumerate(used)}
node_xy = [node_xy[i] for i in used]
for e in edges:
    e["a"], e["b"] = remap[e["a"]], remap[e["b"]]
    # Every edge's geometry must run from node a to node b.
    coords = list(e["geom"].coords)
    coords[0], coords[-1] = node_xy[e["a"]], node_xy[e["b"]]
    e["geom"] = shapely.LineString(coords)

walk_edge_ids = [i for i, e in enumerate(edges) if e["flags"] & EDGE_WALK]
street_edge_ids = [i for i, e in enumerate(edges) if e["name"] and e["flags"] & (EDGE_CAR_FWD | EDGE_CAR_BWD)]
street_tree = STRtree([edges[i]["geom"] for i in street_edge_ids])


def street_name(p):
    """Name of the nearest named street a car can use (for labels like "Home on Bloomfield Street")."""
    return edges[street_edge_ids[int(street_tree.nearest(p))]]["name"]
walk_edge_tree = STRtree([edges[i]["geom"] for i in walk_edge_ids])


def snap(p):
    """Nearest walkable edge to p and the fraction t along it (0 at node a, 1 at node b)."""
    i = walk_edge_ids[int(walk_edge_tree.nearest(p))]
    g = edges[i]["geom"]
    return i, round(g.project(p) / g.length, 3) if g.length else 0.0


walk_nodes = sorted({e["a"] for e in edges if e["flags"] & EDGE_WALK} | {e["b"] for e in edges if e["flags"] & EDGE_WALK})
car_nodes = sorted({e["a"] for e in edges if e["flags"] & (EDGE_CAR_FWD | EDGE_CAR_BWD)} |
                   {e["b"] for e in edges if e["flags"] & (EDGE_CAR_FWD | EDGE_CAR_BWD)})
walk_tree = STRtree([Point(node_xy[i]) for i in walk_nodes])
car_tree = STRtree([Point(node_xy[i]) for i in car_nodes])


def nearest_walk(p):
    return walk_nodes[int(walk_tree.nearest(p))]


def nearest_car(p):
    return car_nodes[int(car_tree.nearest(p))]


def nearest_outside(p, pool, predicate):
    """Nearest node in pool (list of node ids) that satisfies predicate(point)."""
    best_n, best_d = None, 1e18
    for n in pool:
        np_ = Point(node_xy[n])
        if predicate(np_):
            d = np_.distance(p)
            if d < best_d:
                best_n, best_d = n, d
    return best_n


# --------------------------------------------------------------------------------------
# Gateways: where people leave or enter Hoboken
# --------------------------------------------------------------------------------------
outside = lambda p: not hoboken.contains(p)  # noqa: E731
GATEWAYS = [
    # id, label, kind, lon, lat, modes it serves
    ("path", "PATH trains (Hoboken Terminal)", "transit", -74.02909, 40.73572, ["path"]),
    ("njt", "NJ Transit rail (Hoboken Terminal)", "transit", -74.02771, 40.73627, ["njtRail"]),
    ("hblr_term", "Light rail – Hoboken Terminal", "transit", -74.02973, 40.73397, ["hblr"]),
    ("hblr_2nd", "Light rail – 2nd Street", "transit", -74.04280, 40.74160, ["hblr"]),
    ("hblr_9th", "Light rail – 9th St–Congress St", "transit", -74.03842, 40.74877, ["hblr"]),
    ("ferry_term", "Ferry – Hoboken Terminal", "transit", -74.02656, 40.73504, ["ferry"]),
    ("ferry_14", "Ferry – 14th Street", "transit", -74.02086, 40.75265, ["ferry"]),
    ("road_n", "Weehawken / Lincoln Tunnel (Park & Willow Aves)", "road", -74.0288, 40.7598, ["car", "bike", "walk", "bus"]),
    ("road_nw", "14th Street Viaduct to JC Heights", "road", -74.0372, 40.7560, ["car", "bike", "walk", "bus"]),
    ("road_w", "JC Heights (Paterson & New York Aves)", "road", -74.0462, 40.7392, ["car", "bike", "walk", "bus"]),
    ("road_s", "Downtown Jersey City (Marin Blvd, Grove & Newark Sts)", "road", -74.0392, 40.7342, ["car", "bike", "walk", "bus"]),
    ("walk_s", "Waterfront walkway to Newport", "path", -74.0302, 40.7322, ["walk", "bike"]),
    ("walk_n", "Waterfront walkway to Lincoln Harbor", "path", -74.0228, 40.7598, ["walk", "bike"]),
]
def node_anchor(n):
    """(edge, t) placing an anchor exactly on node n."""
    for i in walk_edge_ids:
        if edges[i]["a"] == n:
            return i, 0.0
        if edges[i]["b"] == n:
            return i, 1.0
    raise ValueError(f"node {n} has no walkable edge")


gateways = []
for gid, label, kind, lon, lat, modes in GATEWAYS:
    p = pt(lon, lat)
    if kind == "transit":
        edge, t = snap(p)
        car = -1
    else:
        edge, t = node_anchor(nearest_outside(p, walk_nodes, outside))
        car = nearest_outside(p, car_nodes, outside) if "car" in modes else -1
    ax, ay = edges[edge]["geom"].interpolate(t, normalized=True).coords[0]
    gateways.append({"id": gid, "label": label, "kind": kind, "modes": modes, "x": q(ax), "y": q(ay),
                     "edge": edge, "t": t, "carNode": car})

bus_stops = []
for g in bus_stops_ll:
    p = project(g)
    if hoboken.contains(p):
        edge, t = snap(p)
        bus_stops.append([q(p.x), q(p.y), edge, round(t * 1000)])

# --------------------------------------------------------------------------------------
# Buildings and homes
# --------------------------------------------------------------------------------------
NONRES_CLASS = {"university", "school", "church", "hospital", "office", "parking", "garage", "garages", "train_station",
                "transportation", "warehouse", "industrial", "library", "post_office", "civic", "retail", "commercial",
                "service", "shed", "roof", "kindergarten", "college", "public", "government", "fire_station", "chapel",
                "cathedral", "religious", "hotel", "carport", "hangar"}
NONRES_SUBTYPE = {"education", "religious", "civic", "transportation", "service", "industrial", "medical", "commercial",
                  "outbuilding", "agricultural", "military", "entertainment"}
NONRES_PLACE = {"school", "university", "civic", "worship", "transit", "parking", "hotel"}

raw_buildings = [b for b in read("buildings") if not b["is_underground"]]
b_geoms = [project(wkb.loads(b["geometry"])) for b in raw_buildings]
keep = [i for i, g in enumerate(b_geoms) if g.intersects(view) and g.area >= 4]
raw_buildings = [raw_buildings[i] for i in keep]
b_geoms = [b_geoms[i] for i in keep]
b_tree = STRtree(b_geoms)

place_in_building = collections.defaultdict(set)
for p in places:
    hits = b_tree.query(Point(p["x"], p["y"]), predicate="intersects")
    for h in hits:
        place_in_building[int(h)].add(p["group"])

addr_count = collections.Counter()
seen_addr = set()
for a in read("addresses"):
    p = project(wkb.loads(a["geometry"]))
    if not hoboken.contains(p):
        continue
    key = (a["street"], a["number"], a["unit"])
    if key in seen_addr:
        continue
    seen_addr.add(key)
    hits = b_tree.query(p, predicate="intersects")
    if len(hits):
        addr_count[int(hits[0])] += 1
    else:
        near = b_tree.query(p.buffer(12), predicate="intersects")
        if len(near):
            addr_count[int(min(near, key=lambda h: b_geoms[h].distance(p)))] += 1

buildings = []
homes, dorms = [], []
for i, (b, g) in enumerate(zip(raw_buildings, b_geoms)):
    c = g.representative_point()
    in_h = hoboken.contains(c)
    height = b["height"] or ((b["num_floors"] or 0) * 3.2) or 0
    floors = b["num_floors"] or (max(1, round(height / 3.2)) if height else 3)
    kind = 0  # 0 unknown/residential, 1 non-residential, 2 dormitory
    if b["class"] == "dormitory":
        kind = 2
    elif (b["class"] in NONRES_CLASS or b["subtype"] in NONRES_SUBTYPE or place_in_building[i] & NONRES_PLACE
          or (campus is not None and campus.contains(c))):
        kind = 1
    units = 0.0
    if in_h and kind == 0:
        if addr_count[i]:
            units = float(addr_count[i])
        elif g.area >= 45:
            units = 0.5 * g.area * floors / 95.0
    polys = rings(g, 0.5 if in_h else 1.5)  # context buildings outside Hoboken need less detail
    if not polys:
        continue
    bi = len(buildings)
    buildings.append({"p": polys[0][0], "h": round(height, 1), "k": kind, "in": 1 if in_h else 0})
    if units > 0:
        homes.append({"b": bi, "x": c.x, "y": c.y, "units": units, "area": g.area})
    if kind == 2 and in_h:
        dorms.append({"b": bi, "x": c.x, "y": c.y, "cap": g.area * floors})

# Manhattan skyline for the 3D view: towers of 40 m and up, footprints only.
skyline = []
for b in read("skyline", ["height", "num_floors", "geometry", "is_underground"]):
    height = b["height"] or ((b["num_floors"] or 0) * 3.4)
    if b["is_underground"] or not height or height < 40:
        continue
    g = project(wkb.loads(b["geometry"]))
    if g.representative_point().x < 1200:  # keep to Manhattan, east of the river
        continue
    polys = rings(g, 1.5)
    if polys:
        skyline.append([round(height, 1), polys[0][0]])

obs, asm = cal["observed"], cal["assumptions"]
dorm_total = asm["stevensDormResidents"]["value"]
household_persons = obs["residents"]["value"] - dorm_total
households_total = round(household_persons / obs["averageHouseholdSize"]["value"])


def allocate(items, weight_key, total):
    weights = [it[weight_key] for it in items]
    s = sum(weights)
    raw = [w * total / s for w in weights]
    base = [int(math.floor(r)) for r in raw]
    rem = total - sum(base)
    for idx in sorted(range(len(raw)), key=lambda k: raw[k] - base[k], reverse=True)[:rem]:
        base[idx] += 1
    return base


for h, n in zip(homes, allocate(homes, "units", households_total)):
    h["households"] = n
homes = [h for h in homes if h["households"] > 0]
for d, n in zip(dorms, allocate(dorms, "cap", dorm_total)):
    d["residents"] = n

# --------------------------------------------------------------------------------------
# Place -> node snapping and job allocation
# --------------------------------------------------------------------------------------
jobs_total = asm["jobsLocatedInHoboken"]["value"]
job_counts = allocate(places, "jobs", jobs_total)
for p, n in zip(places, job_counts):
    p["jobs"] = n
    p["edge"], p["t"] = snap(Point(p["x"], p["y"]))
    p["car"] = nearest_car(Point(p["x"], p["y"])) if p["group"] == "parking" else -1
for h in homes:
    h["edge"], h["t"] = snap(Point(h["x"], h["y"]))
    h["street"] = street_name(Point(h["x"], h["y"]))
    h["car"] = nearest_car(Point(h["x"], h["y"]))
for d in dorms:
    d["edge"], d["t"] = snap(Point(d["x"], d["y"]))

# --------------------------------------------------------------------------------------
# Drawing layers outside the routing graph: context roads and rail
# --------------------------------------------------------------------------------------
context_roads, rail = [], []
for s in segments:
    line = project(wkb.loads(s["geometry"]))
    if not line.intersects(view):
        continue
    if s["subtype"] == "rail":
        code = RAIL_CODE.get(s["class"], 10)
        clipped = line.intersection(view)
        for part in getattr(clipped, "geoms", [clipped]):
            if part.geom_type == "LineString" and part.length > 2:
                rail.append([code, flat(part.simplify(1.0).coords)])
        continue
    if s["subtype"] != "road":
        continue
    cls = s["class"]
    if cls not in {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified"}:
        continue
    outside_part = line.intersection(view).difference(graph_area)
    for part in getattr(outside_part, "geoms", [outside_part]):
        if part.geom_type == "LineString" and part.length > 3:
            context_roads.append([ROAD_CODE[cls], flat(part.simplify(1.5).coords)])

# --------------------------------------------------------------------------------------
# Citi Bike: measured flows at Hoboken docks
# --------------------------------------------------------------------------------------
stations = {}
hourly = {"weekday": [0] * 24, "weekend": [0] * 24}
flows = collections.Counter()
days = {"weekday": set(), "weekend": set()}
months = set()
for path in sorted(glob.glob(str(CITIBIKE / "JC-*.csv"))):
    file_month = re.search(r"JC-(\d{4})(\d{2})", path)
    file_month = f"{file_month.group(1)}-{file_month.group(2)}"
    months.add(file_month)
    with open(path, newline="") as fh:
        for r in csv.DictReader(fh):
            s_id, e_id = r["start_station_id"] or "", r["end_station_id"] or ""
            s_hb, e_hb = s_id.startswith("HB"), e_id.startswith("HB")
            if not (s_hb or e_hb):
                continue
            try:
                t = datetime.datetime.strptime(r["started_at"][:19], "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            if t.strftime("%Y-%m") != file_month:  # rides that began the previous evening
                continue
            kind = "weekend" if t.weekday() >= 5 else "weekday"
            days[kind].add(t.date())
            flows[(kind, "internal" if s_hb and e_hb else "outbound" if s_hb else "inbound")] += 1
            if s_hb:
                hourly[kind][t.hour] += 1
            for sid, name, lat, lng, is_hb, role in ((s_id, r["start_station_name"], r["start_lat"], r["start_lng"], s_hb, 0),
                                                     (e_id, r["end_station_name"], r["end_lat"], r["end_lng"], e_hb, 1)):
                if is_hb and lat and lng:
                    st = stations.setdefault(sid, {"name": name, "lat": float(lat), "lng": float(lng), "trips": 0})
                    st["trips"] += 1
n_days = {k: max(1, len(v)) for k, v in days.items()}
citibike = {
    "months": sorted(months),
    "daysSampled": n_days,
    "perDay": {k: {f: round(flows[(k, f)] / n_days[k]) for f in ("internal", "outbound", "inbound")} for k in n_days},
    "startsByHour": {k: [round(v / n_days[k], 1) for v in hourly[k]] for k in hourly},
    "stations": [[q(project(Point(s["lng"], s["lat"])).x), q(project(Point(s["lng"], s["lat"])).y), s["name"],
                  round(s["trips"] / (n_days["weekday"] + n_days["weekend"]), 1)]
                 for s in sorted(stations.values(), key=lambda s: -s["trips"])],
}

# --------------------------------------------------------------------------------------
# Emit
# --------------------------------------------------------------------------------------
edge_out, geom_out, names = [], [], []
name_index = {}
for e in edges:
    coords = list(e["geom"].coords)
    nm = e["name"]
    if nm not in name_index:
        name_index[nm] = len(names)
        names.append(nm)
    edge_out.extend((e["a"], e["b"], q(e["len"]), e["flags"], e["cls"], name_index[nm]))
    geom_out.append(flat(coords[1:-1]) if len(coords) > 2 else 0)

place_names = []
place_out = []
for p in places:
    nm = p["name"]
    place_out.append([q(p["x"]), q(p["y"]), G[p["group"]], p["edge"], round(p["t"] * 1000), p["jobs"],
                      VISIT_WEIGHT[p["group"]], len(place_names) if nm else -1, p["car"]])
    if nm:
        place_names.append(nm)

hb = rings(hoboken, 1)
data = {
    "meta": {
        "generated": datetime.date.today().isoformat(),
        "overtureRelease": release,
        "origin": [LON0, LAT0],
        "metersPerDegree": [MX, MY],
        "scale": Q,
        "view": [q(v) for v in view.bounds],
        "counts": {"buildings": len(buildings), "homes": len(homes), "places": len(places), "nodes": len(node_xy),
                   "edges": len(edges), "busStops": len(bus_stops), "addressPoints": sum(addr_count.values())},
        "groups": GROUPS,
        "edgeFlags": {"walk": EDGE_WALK, "bike": EDGE_BIKE, "carForward": EDGE_CAR_FWD, "carBackward": EDGE_CAR_BWD,
                      "major": EDGE_MAJOR, "path": EDGE_PATH},
        "attribution": "Map data © OpenStreetMap contributors and Overture Maps Foundation (ODbL/CDLA). "
                       "Bike data: Citi Bike System Data (Lyft Bikes and Scooters, LLC).",
    },
    "hoboken": hb,
    "neighbors": neighbors,
    "water": rings(water, 3),
    "water3d": rings(water3d, 6),
    "context3d": [q(v) for v in context.bounds],
    "parks": rings(parks, 0.8) if parks is not None else [],
    "piers": piers,
    "buildings": buildings,
    "skyline": skyline,
    "contextRoads": context_roads,
    "rail": rail,
    "graph": {"nodes": flat(node_xy), "edges": edge_out, "geom": geom_out, "names": names},
    "gateways": gateways,
    "busStops": bus_stops,
    "places": place_out,
    "placeNames": place_names,
    "dogParks": [i for i, p in enumerate(places) if p["dog"]],
    "homes": [[q(h["x"]), q(h["y"]), h["edge"], round(h["t"] * 1000), h["households"], h["b"], h["car"], name_index[h["street"]]]
              for h in homes],
    "dorms": [[q(d["x"]), q(d["y"]), d["edge"], round(d["t"] * 1000), d["residents"], d["b"]] for d in dorms],
    "citibike": citibike,
    "calibration": cal,
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))

print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.2f} MB)")
print(json.dumps(data["meta"]["counts"]))
print("households", households_total, "in", len(homes), "buildings; dorm residents", dorm_total, "in", len(dorms), "buildings")
print("jobs", sum(p["jobs"] for p in places), "places by group",
      dict(collections.Counter(p["group"] for p in places).most_common()))
print("named places", len(place_names), "dog runs", sum(1 for p in places if p["dog"]),
      [p["name"] for p in places if p["dog"]], "skyline towers", len(skyline))
for g in gateways:
    print("gateway", g["id"], g["edge"], g["t"], g["carNode"])
print("citibike", json.dumps(citibike["perDay"]), citibike["months"])
