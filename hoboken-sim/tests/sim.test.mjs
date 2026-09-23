import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const data = JSON.parse(await readFile(new URL("web/data/hoboken.json", root), "utf8"));
const context = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(await readFile(new URL("web/sim.js", root), "utf8"), context, { filename: "sim.js" });
const H = context.HobokenSim;
const world = new H.World(data);
const weekday = new H.Simulation(world, { dayType: "weekday" });
const saturday = new H.Simulation(world, { dayType: "weekend" });
const { observed, derived } = data.calibration;

test("residents, workers and work-from-home share match the Census inputs exactly", () => {
  const c = weekday.calibrationChecks();
  assert.equal(c.residents, observed.residents.value);
  assert.equal(c.employedResidents, observed.employedResidents.value);
  assert.ok(Math.abs(c.wfhShare - observed.commuteModeShares.value.workedFromHome) < 0.001);
});

test("every plan is a gap-free, time-ordered sequence of legs covering the day", () => {
  for (const sim of [weekday, saturday]) {
    for (let i = 0; i < sim.n; i++) {
      const s = sim.legStart[i];
      const e = sim.legEnd[i];
      assert.ok(e > s, `person ${i} has no legs`);
      for (let l = s; l < e; l++) {
        assert.ok(Number.isFinite(sim.legs.t0[l]));
        assert.ok(sim.legs.t1[l] >= sim.legs.t0[l], `leg ${l} runs backwards`);
        if (l > s) assert.ok(Math.abs(sim.legs.t0[l] - sim.legs.t1[l - 1]) < 1e-3, `gap before leg ${l}`);
      }
    }
  }
});

test("at 4 am everyone in Hoboken is a resident at home", () => {
  const p = weekday.stats.present;
  assert.equal(p[0][0], observed.residents.value);
  assert.equal(p[1][0], 0);
  assert.equal(p[2][0], 0);
});

test("modeled station counts land near the published weekday figures", () => {
  const c = weekday.calibrationChecks();
  const [lo, hi] = derived.pathHobokenWeekdayEntries.range;
  assert.ok(c.pathEntries >= lo && c.pathEntries <= hi, `PATH entries ${c.pathEntries} outside ${lo}-${hi}`);
  const njt = observed.njtRailHobokenWeekdayBoardings2025.value;
  assert.ok(Math.abs(c.njtBoardings / njt - 1) < 0.15, `NJ Transit boardings ${c.njtBoardings} vs ${njt}`);
});

test("crossings balance: nearly everyone who enters also leaves", () => {
  const all = weekday.crossingsUntil(H.DAY_END);
  const inn = all.in.reduce((a, b) => a + b, 0);
  const out = all.out.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(inn - out) / inn < 0.02, `in ${inn} vs out ${out}`);
});

test("positions are finite, stay on the map, and don't depend on how the clock got there", () => {
  const n = weekday.n;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const s = new Uint8Array(n);
  for (let t = 6 * 3600; t <= 9 * 3600; t += 20) weekday.positionsAt(t, x, y, s);
  const [vx0, vy0, vx1, vy1] = data.meta.view.map((v) => v / data.meta.scale);
  for (let i = 0; i < n; i++) {
    if (s[i] === H.STATE.HIDDEN) continue;
    assert.ok(Number.isFinite(x[i]) && Number.isFinite(y[i]), `person ${i} has no position`);
    assert.ok(x[i] >= vx0 - 50 && x[i] <= vx1 + 50 && y[i] >= vy0 - 50 && y[i] <= vy1 + 50, `person ${i} is off the map`);
  }
  const x1 = Float32Array.from(x);
  weekday.positionsAt(20 * 3600, x, y, s);
  weekday.positionsAt(9 * 3600, x, y, s);
  for (let i = 0; i < n; i++) if (s[i] !== H.STATE.HIDDEN) assert.ok(Math.abs(x[i] - x1[i]) < 0.01, `person ${i} moved after a seek`);
});

test("routes follow the street graph between every kind of anchor", () => {
  for (const [a, b] of [[world.gate.path, world.homeA0], [world.homeA0 + 100, world.placeA0 + 5], [world.gate.road_s, world.placeA0 + 40]]) {
    const r = world.walkRoute(a, b);
    assert.ok(r.len > 0 && Number.isFinite(r.len));
    assert.ok(r.len >= world.distance(a, b) * 0.95, "route shorter than a straight line");
  }
  const drive = world.carRoute(world.homeA0 + 10, world.gate.road_n);
  assert.ok(drive.len > world.distance(world.homeA0 + 10, world.gate.road_n) * 0.95);
});

test("no displayed place name looks like an individual's name, and no contact fields ship", () => {
  const personal = /\bDr\.?\s|\b(MD|DDS|LCSW|Esq|CPA|Realtor)\b| - |\|/;
  for (const name of data.placeNames) assert.ok(!personal.test(name), `personal-looking name shipped: ${name}`);
  const text = JSON.stringify(data);
  for (const field of ['"phones"', '"emails"', '"socials"']) assert.ok(!text.includes(field), `${field} present in data`);
});
