# Hoboken in Unreal Engine 5

This folder plays the simulated day in Unreal Engine 5 on your own machine. The day can come
from the rules or from Jev. You get the city (streets, parks, the Hudson, 13,577 buildings and
the Manhattan skyline) and everyone on it: residents, commuters, visitors, dogs, bikes and cars.

**Status: the Unreal side hasn't been compiled or run.**
- The exporter and the day-file reader (`HobokenDay.h`, plain C++) are tested here.
  `tests/unreal.test.mjs` compiles the reader with g++ and checks that it puts every visible
  person within 5 cm of where the browser engine does, at six times of day.
- The Unreal actor (`HobokenCrowd.h`/`.cpp`, about 280 lines) was written against Unreal 5.3–5.5
  APIs without an engine to build it. Expect to fix a compile error or two. Claude Code running on
  a machine with Unreal can do that quickly.

## 1. Export the day

```bash
cd hoboken-sim && npm install
node scripts/export_unreal.mjs --day weekday          # rules; add --jev to use web/data/jev-weekday.json
```

This writes two files to `hoboken-sim/dist/unreal/`:
- `hoboken-weekday.hday` (about 60 MB): the city meshes plus all 90,049 people, their 677,527 legs
  and the street routes they follow.
- `hoboken-city.glb` (about 15 MB): the city alone, for Blender or other tools.

## 2. Add the plugin to a project

1. Create or open a **C++** Unreal 5.3+ project. A Blueprint-only project needs one C++ class
   first (Tools → New C++ Class) so the editor can build plugins.
2. Copy `hoboken-sim/unreal/HobokenSim` into `<YourProject>/Plugins/HobokenSim`.
3. Copy `hoboken-weekday.hday` into `<YourProject>/Content/Hoboken/`.
4. Regenerate project files, then build and open the editor. The plugin turns on Unreal's
   Procedural Mesh Component plugin, which it needs.

## 3. Play it

1. Make a new level from the **Basic** template and delete its floor. Hoboken brings its own
   ground, 35 km across.
2. Place **Hoboken Crowd** from the Place Actors panel at 0, 0, 0.
3. In its Details panel, click **Reload** to build the city in the editor, then press **Play**.

Settings:
- **Start Hour** and **Sim Seconds Per Second** control the clock. The default is 30, so a day
  takes 48 minutes.
- Set **Sun** to the level's directional light, changed to *Movable*, to have it follow the
  simulated sun.
- **Two Sided City** is on by default. It guards against inside-out geometry if Unreal culls the
  other way from what the exporter assumes.

Axes: 1 unit = 1 cm, X = north, Y = east, Z = up. The origin is at Garden & 7th Streets.
Hoboken spans about 1.9 km east to west and 2.8 km north to south.

In view:
- blue people are residents, orange are commuting in, green are visitors
- grey boxes are cars, which keep right
- dark boxes are bikes
- brown boxes beside walkers are dogs

People indoors aren't shown, the same as in the browser.

## What's simplified

- People, dogs, bikes and cars are basic shapes (cylinders and boxes) on the engine's
  `BasicShapeMaterial`. Swap in your own meshes on the six instanced components.
- Buildings are plain extrusions of their footprints, with no windows or roof detail.
- Motion follows each route's centre line at a constant speed per trip. There's no animation
  rigging, collision or traffic signals.
