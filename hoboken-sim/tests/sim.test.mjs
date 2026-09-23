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

test("the synthetic age mix matches the ACS age groups within one point", () => {
  const people = weekday.profile.filter((p) => p.kind === H.KIND.RESIDENT || p.kind === H.KIND.DORM);
  const share = (lo, hi) => people.filter((p) => p.age >= lo && p.age <= hi).length / people.length;
  const groups = { "0-4": [0, 4], "5-14": [5, 14], "15-24": [15, 24], "25-44": [25, 44], "45-64": [45, 64], "65+": [65, 200] };
  for (const [key, [lo, hi]] of Object.entries(groups)) {
    const want = observed.ageShares.value[key];
    assert.ok(Math.abs(share(lo, hi) - want) < 0.01, `${key}: ${(100 * share(lo, hi)).toFixed(1)}% vs ${(100 * want).toFixed(1)}%`);
  }
});

test("dogs: the assumed share of households has one, and every walk starts and ends at home", () => {
  const share = data.calibration.assumptions.householdsWithDog.value;
  const households = data.homes.reduce((s, h) => s + h[4], 0);
  assert.ok(Math.abs(weekday.dogs / households - share) < 0.02, `${weekday.dogs} dogs in ${households} households`);
  const L = weekday.legs;
  let walks = 0;
  for (let i = 0; i < weekday.n; i++) {
    for (let l = weekday.legStart[i]; l < weekday.legEnd[i]; l++) {
      if (L.kind[l] !== 1 || !weekday.withDogLeg(l)) continue;
      const outbound = L.a[l] === weekday.homeAnchor[i];
      const inbound = L.b[l] === weekday.homeAnchor[i];
      assert.ok(outbound || inbound, `dog walk leg ${l} of person ${i} neither leaves nor returns home`);
      if (outbound) walks++;
    }
  }
  assert.ok(walks >= weekday.dogs * 1.5, `${walks} walks for ${weekday.dogs} dogs`);
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

test("every kind of choice goes through the decision hook, and overriding one changes only that person", () => {
  const log = new H.Simulation(world, { dayType: "weekday", recordDecisions: true }).decisionLog;
  const families = new Set(log.map((d) => d.topic.split(".")[0]));
  for (const f of ["work", "am", "lunch", "errand", "eve", "dog", "trip", "daycare", "class", "in", "stu", "visit", "xfer"]) {
    assert.ok(families.has(f), `no ${f} decisions`);
  }
  for (const d of log) {
    assert.ok(d.labels.length >= 2 && d.rule >= 0 && d.rule < d.labels.length, d.key);
    assert.ok(Math.abs(d.prior.reduce((a, b) => a + b, 0) - 1) < 1e-6, d.key);
  }
  // Answer every decision of 400 people with an option the rules didn't pick.
  const chosen = new Set();
  for (let i = 0; i < weekday.n && chosen.size < 400; i += 211) chosen.add(i);
  const table = {};
  for (const d of log) if (chosen.has(d.person)) table[d.person + "|" + d.key] = d.labels[(d.rule + 1) % d.labels.length];
  const other = new H.Simulation(world, { dayType: "weekday", decisions: H.tableSource(table), recordDecisions: true });
  assert.ok(other.decisionStats.fromTable > 1000);
  let changed = 0;
  for (let i = 0; i < weekday.n; i++) {
    const a = weekday.legEnd[i] - weekday.legStart[i];
    let same = a === other.legEnd[i] - other.legStart[i];
    for (let k = 0; same && k < a; k++) same = weekday.legs.t1[weekday.legStart[i] + k] === other.legs.t1[other.legStart[i] + k];
    if (!same) {
      changed++;
      assert.ok(chosen.has(i), `person ${i} changed without an overridden decision`);
    }
  }
  assert.ok(changed > 300, `only ${changed} of 400 days changed`);
  // Packed the way the page ships Jev's answers, the same day comes back.
  const packed = H.encodeSequence(other.decisionLog, (p) => chosen.has(p));
  const again = new H.Simulation(world, { dayType: "weekday", decisions: H.sequenceSource(packed.topics, packed.bytes) });
  assert.equal(again.decisionStats.fromTable, other.decisionStats.fromTable);
  assert.equal(again.legs.n, other.legs.n);
  for (let l = 0; l < other.legs.n; l++) assert.ok(again.legs.t1[l] === other.legs.t1[l] && again.legs.b[l] === other.legs.b[l]);
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
