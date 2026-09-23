import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let installed = true;
try {
  await import("earcut");
} catch {
  installed = false;
}
const compiler = ["g++", "clang++"].find((c) => spawnSync(c, ["--version"]).status === 0);

/** Every triangle's cross product (b - a) x (c - a) must point along its vertex normal. */
function windingErrors(pos, nrm, idx) {
  let bad = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]];
    const u = [pos[3 * b] - pos[3 * a], pos[3 * b + 1] - pos[3 * a + 1], pos[3 * b + 2] - pos[3 * a + 2]];
    const v = [pos[3 * c] - pos[3 * a], pos[3 * c + 1] - pos[3 * a + 1], pos[3 * c + 2] - pos[3 * a + 2]];
    const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...x);
    if (len < 1e-3) continue; // degenerate sliver
    if (x[0] * nrm[3 * a] + x[1] * nrm[3 * a + 1] + x[2] * nrm[3 * a + 2] <= 0) bad++;
  }
  return bad;
}

test("the Unreal export holds the same city and day as the browser", { skip: !installed && "run npm install in hoboken-sim first" }, async (t) => {
  const { exportUnreal } = await import("../scripts/export_unreal.mjs");
  const { loadEngine } = await import("../jev/run-jev.mjs");
  const dir = await mkdtemp(join(tmpdir(), "hday-"));
  const out = await exportUnreal({ day: "weekday", out: dir, quiet: true });

  // .hday meshes: indices in range, unit normals, triangles facing their normals.
  const buf = await readFile(out.dayFile);
  assert.equal(buf.toString("latin1", 0, 4), "HDAY");
  let o = 28; // "HDAY", version, day, then start, end, sunrise, sunset
  const nMaterials = buf.readUInt32LE(o);
  o += 4 + 16 * nMaterials;
  const nMeshes = buf.readUInt32LE(o);
  o += 4;
  let triangles = 0;
  for (let m = 0; m < nMeshes; m++) {
    const nv = buf.readUInt32LE(o + 4);
    const ni = buf.readUInt32LE(o + 8);
    o += 12;
    const pos = new Float32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + 12 * nv));
    o += 12 * nv;
    const nrm = new Float32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + 12 * nv));
    o += 12 * nv;
    const idx = new Uint32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + 4 * ni));
    o += 4 * ni;
    for (let i = 0; i < nv; i++) assert.ok(Math.abs(Math.hypot(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]) - 1) < 1e-4);
    assert.ok(idx.every((i) => i < nv));
    assert.equal(windingErrors(pos, nrm, idx), 0, `mesh ${m} has triangles facing away from their normals`);
    triangles += ni / 3;
  }
  assert.equal(triangles, out.triangles);
  assert.ok(triangles > 200000);

  // GLB: the Khronos validator finds nothing, and triangles face their normals there too.
  const glb = await readFile(out.glbFile);
  const validator = await import("gltf-validator").catch(() => null);
  if (validator) {
    const report = await validator.validateBytes(new Uint8Array(glb));
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages.slice(0, 5)));
    assert.equal(report.issues.numWarnings, 0, JSON.stringify(report.issues.messages.slice(0, 5)));
  } else {
    t.diagnostic("gltf-validator isn't installed (npm install in hoboken-sim): skipped validating the GLB");
  }
  const jsonLen = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString("utf8", 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8;
  const read = (acc, Type) => {
    const a = gltf.accessors[acc];
    const v = gltf.bufferViews[a.bufferView];
    const start = glb.byteOffset + binStart + v.byteOffset;
    return new Type(glb.buffer.slice(start, start + v.byteLength));
  };
  for (const p of gltf.meshes[0].primitives) {
    assert.equal(windingErrors(read(p.attributes.POSITION, Float32Array), read(p.attributes.NORMAL, Float32Array), read(p.indices, Uint32Array)), 0);
  }

  if (!compiler) {
    t.diagnostic("no C++ compiler found: skipped checking HobokenDay.h against the browser engine");
    return;
  }
  // HobokenDay.h, compiled on its own, puts everyone where the browser engine does.
  const exe = join(dir, "day_check");
  execFileSync(compiler, ["-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror", "-o", exe, join(root, "unreal", "tools", "day_check.cpp")]);
  const times = [7.5 * 3600, 7.5 * 3600 + 60, 12 * 3600, 18 * 3600, 22.5 * 3600, 8.25 * 3600];
  const text = execFileSync(exe, [out.dayFile, ...times.map(String)], { maxBuffer: 1 << 28 }).toString();
  const lines = text.trim().split("\n");
  const header = lines.shift();
  assert.match(header, / people 90049 /);
  const seen = new Map();
  let current = null;
  for (const line of lines) {
    const f = line.split(" ");
    if (f[0] === "t") {
      current = new Map();
      seen.set(Number(f[1]), current);
    } else {
      current.set(Number(f[0]), [Number(f[1]), Number(f[2])]);
    }
  }
  const { H, world } = await loadEngine();
  const sim = new H.Simulation(world, { dayType: "weekday" });
  const x = new Float32Array(sim.n);
  const y = new Float32Array(sim.n);
  const s = new Uint8Array(sim.n);
  const S = H.STATE;
  for (const time of times) {
    sim.positionsAt(time, x, y, s);
    const cpp = seen.get(time);
    let visible = 0;
    for (let i = 0; i < sim.n; i++) {
      const shown = s[i] === S.WALK || s[i] === S.BIKE || s[i] === S.CAR || (s[i] === S.PLACE && sim.outdoors(i));
      assert.equal(cpp.has(i), shown, `person ${i} at ${time}: C++ ${cpp.has(i) ? "shows" : "hides"} them`);
      if (!shown) continue;
      visible++;
      const [cx, cy] = cpp.get(i);
      // Unreal centimetres: X = north, Y = east.
      assert.ok(Math.abs(cx - y[i] * 100) < 5 && Math.abs(cy - x[i] * 100) < 5,
        `person ${i} at ${time}: C++ (${cx}, ${cy}) vs browser (${y[i] * 100}, ${x[i] * 100})`);
    }
    assert.equal(cpp.size, visible);
    assert.ok(visible > 1000, `only ${visible} people in view at ${time}`);
  }
});
