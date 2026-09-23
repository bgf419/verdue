#!/usr/bin/env node
// Export the city and one simulated day for Unreal Engine 5, plus a GLB of the city for
// Blender and other tools.
//
//   node hoboken-sim/scripts/export_unreal.mjs [--day weekday|weekend] [--jev] [--out dir] [--no-glb]
//
// --jev replays the day with Jev's answers from web/data/jev-<day>.json.
// Writes <out>/hoboken-<day>.hday, which the HobokenSim plugin (hoboken-sim/unreal) plays, and
// <out>/hoboken-city.glb. Unreal units are centimetres with X = north, Y = east, Z = up: Unreal's
// left-handed frame with the map the right way round. The GLB uses glTF's metres, Y up,
// X = east and -Z = north.
import earcut from "earcut";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadEngine, unpackJev } from "../jev/run-jev.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
// Same colours as the browser's 3D view (web/view3d.js).
const LOW = [0x9c5b45, 0xa8674f, 0x8e4f3d, 0xb07a5f, 0x9a6a55, 0xc2a283, 0x8b5a48, 0xa05e4a];
const MID = [0xc9c1b3, 0xb9b2a6, 0xd6cfc2, 0xa9a39a, 0xbfae98, 0xd2c6b4];
const TALL = [0x8fa1b3, 0xa3b1bf, 0x7f8e9e, 0xc5ccd3, 0x9aa7ae, 0x6f8193];
const MATERIALS = [
  ["ground", 0xb8bcb3], ["water", 0x5d7f98], ["park", 0x9fc38a], ["pier", 0xc9c6bd], ["asphalt", 0x62676b],
  ["path", 0xc4beb1], ["rail", 0x4a4f52],
  ...LOW.map((c, i) => ["brick" + i, c]), ...MID.map((c, i) => ["stone" + i, c]), ...TALL.map((c, i) => ["glass" + i, c]),
];
const MAT = Object.fromEntries(MATERIALS.map(([name], i) => [name, i]));
const ROAD_W = { 1: 15, 2: 13, 3: 12, 4: 10, 5: 8.5, 6: 5, 7: 2.6, 8: 2.8 };

function hash(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Triangles in world metres (x east, y north, z up), one list per material. */
class Geometry {
  constructor() {
    this.parts = MATERIALS.map(() => ({ pos: [], nrm: [], idx: [] }));
  }
  /** Add vertices with one normal; returns the index of the first. */
  verts(material, xyz, n) {
    const p = this.parts[material];
    const first = p.pos.length / 3;
    for (let i = 0; i < xyz.length; i += 3) {
      p.pos.push(xyz[i], xyz[i + 1], xyz[i + 2]);
      p.nrm.push(n[0], n[1], n[2]);
    }
    return first;
  }
  /** A triangle of existing vertices, wound counter-clockwise seen from the side its normal faces. */
  tri(material, a, b, c) {
    const p = this.parts[material];
    const P = p.pos;
    const ux = P[3 * b] - P[3 * a];
    const uy = P[3 * b + 1] - P[3 * a + 1];
    const uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a];
    const vy = P[3 * c + 1] - P[3 * a + 1];
    const vz = P[3 * c + 2] - P[3 * a + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const dot = cx * p.nrm[3 * a] + cy * p.nrm[3 * a + 1] + cz * p.nrm[3 * a + 2];
    if (dot >= 0) p.idx.push(a, b, c);
    else p.idx.push(a, c, b);
  }
  /** Flat polygons (outer ring + holes, flat arrays in world units after `scale`) at height z. */
  flat(material, polys, z, scale) {
    for (const poly of polys) {
      const coords = [];
      const holes = [];
      poly.forEach((ring, k) => {
        if (k) holes.push(coords.length / 2);
        for (let i = 0; i < ring.length; i += 2) coords.push(ring[i] / scale, ring[i + 1] / scale);
      });
      const faces = earcut(coords, holes, 2);
      if (!faces.length) continue;
      const xyz = [];
      for (let i = 0; i < coords.length; i += 2) xyz.push(coords[i], coords[i + 1], z);
      const first = this.verts(material, xyz, [0, 0, 1]);
      for (let i = 0; i < faces.length; i += 3) this.tri(material, first + faces[i], first + faces[i + 1], first + faces[i + 2]);
    }
  }
  /** A building: walls from the ground to h and a flat roof. `ring` is a flat array in world metres. */
  extrude(material, ring, h) {
    const pts = [];
    for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < 3) return;
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      area += ax * by - bx * ay;
    }
    const ccw = area > 0;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.01) continue;
      const n = ccw ? [(by - ay) / len, -(bx - ax) / len, 0] : [-(by - ay) / len, (bx - ax) / len, 0];
      const v = this.verts(material, [ax, ay, 0, bx, by, 0, bx, by, h, ax, ay, h], n);
      this.tri(material, v, v + 1, v + 2);
      this.tri(material, v, v + 2, v + 3);
    }
    const flatRing = pts.flat();
    const faces = earcut(flatRing, null, 2);
    const xyz = [];
    for (const [x, y] of pts) xyz.push(x, y, h);
    const first = this.verts(material, xyz, [0, 0, 1]);
    for (let i = 0; i < faces.length; i += 3) this.tri(material, first + faces[i], first + faces[i + 1], first + faces[i + 2]);
  }
  /** A flat strip of `width` metres along a polyline, each piece stretched to overlap the next. */
  ribbon(material, xs, ys, width, z) {
    const hw = width / 2;
    for (let i = 0; i + 1 < xs.length; i++) {
      const dx = xs[i + 1] - xs[i];
      const dy = ys[i + 1] - ys[i];
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const ux = dx / len;
      const uy = dy / len;
      const ext = Math.min(hw, len / 2);
      const ax = xs[i] - ux * ext;
      const ay = ys[i] - uy * ext;
      const bx = xs[i + 1] + ux * ext;
      const by = ys[i + 1] + uy * ext;
      const nx = -uy * hw;
      const ny = ux * hw;
      const v = this.verts(material, [ax + nx, ay + ny, z, ax - nx, ay - ny, z, bx - nx, by - ny, z, bx + nx, by + ny, z], [0, 0, 1]);
      this.tri(material, v, v + 1, v + 2);
      this.tri(material, v, v + 2, v + 3);
    }
  }
}

/** The whole city, as the browser's 3D view draws it. */
export function buildCity(data, world) {
  const S = data.meta.scale;
  const g = new Geometry();
  const box = data.context3d.map((v) => v / S);
  const m = 15000;
  const [x0, y0, x1, y1] = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
  const gv = g.verts(MAT.ground, [x0, y0, -0.6, x1, y0, -0.6, x1, y1, -0.6, x0, y1, -0.6], [0, 0, 1]);
  g.tri(MAT.ground, gv, gv + 1, gv + 2);
  g.tri(MAT.ground, gv, gv + 2, gv + 3);
  g.flat(MAT.water, data.water3d, -0.2, S);
  g.flat(MAT.park, data.parks, -0.1, S);
  g.flat(MAT.pier, data.piers, 1.2, S);
  for (let e = 0; e < world.nE; e++) {
    const cls = world.ecls[e];
    const xs = [];
    const ys = [];
    for (let j = world.gOff[e]; j < world.gOff[e + 1]; j++) {
      xs.push(world.gx[j]);
      ys.push(world.gy[j]);
    }
    g.ribbon(cls >= 7 ? MAT.path : MAT.asphalt, xs, ys, ROAD_W[cls] || 8, cls >= 7 ? 0.05 : 0.0);
  }
  for (const [cls, pts] of data.contextRoads) {
    const xs = [];
    const ys = [];
    for (let i = 0; i < pts.length; i += 2) {
      xs.push(pts[i] / S);
      ys.push(pts[i + 1] / S);
    }
    g.ribbon(MAT.asphalt, xs, ys, (ROAD_W[cls] || 8) * 0.9, 0.0);
  }
  for (const [code, pts] of data.rail) {
    if (code === 12) continue; // PATH runs in tunnels
    const xs = [];
    const ys = [];
    for (let i = 0; i < pts.length; i += 2) {
      xs.push(pts[i] / S);
      ys.push(pts[i + 1] / S);
    }
    g.ribbon(MAT.rail, xs, ys, 1.6, 0.3);
  }
  const scaled = (ring) => ring.map((v) => v / S);
  data.buildings.forEach((b, i) => {
    const h = b.h > 0 ? b.h : b.in ? 10 : 9;
    const [pal, name] = h >= 40 ? [TALL, "glass"] : h >= 16 || b.k === 1 ? [MID, "stone"] : [LOW, "brick"];
    g.extrude(MAT[name + Math.floor(hash(i) * pal.length)], scaled(b.p), Math.max(3, h));
  });
  data.skyline.forEach(([h, ring], i) => g.extrude(MAT["glass" + Math.floor(hash(i + 99991) * TALL.length)], scaled(ring), h));
  return g;
}

/** Append-only little-endian byte writer. */
class Writer {
  constructor() {
    this.buf = Buffer.alloc(1 << 24);
    this.o = 0;
  }
  room(n) {
    if (this.o + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.o + n));
    this.buf.copy(next, 0, 0, this.o);
    this.buf = next;
  }
  u8(v) { this.room(1); this.buf.writeUInt8(v, this.o); this.o += 1; }
  u16(v) { this.room(2); this.buf.writeUInt16LE(v, this.o); this.o += 2; }
  u32(v) { this.room(4); this.buf.writeUInt32LE(v, this.o); this.o += 4; }
  i32(v) { this.room(4); this.buf.writeInt32LE(v, this.o); this.o += 4; }
  f32(v) { this.room(4); this.buf.writeFloatLE(v, this.o); this.o += 4; }
  typed(arr) {
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    this.room(b.length);
    b.copy(this.buf, this.o);
    this.o += b.length;
  }
  ascii(s) { for (const ch of s) this.u8(ch.charCodeAt(0)); }
  bytes() { return this.buf.subarray(0, this.o); }
}

/**
 * The .hday file. Layout (little-endian): "HDAY", u32 version (1), u32 day (0 weekday, 1 Saturday),
 * f32 day start, day end, sunrise, sunset (seconds after midnight; the day runs 04:00 to 04:00);
 * u32 materials, each f32 r, g, b, a (sRGB); u32 meshes, each u32 material, u32 vertex count, u32
 * index count, f32 x,y,z positions, f32 x,y,z normals, u32 indices; u32 people, each u8 group
 * (0 resident, 1 commuting in or changing trains, 2 visitor), u8 flags (1 = has a dog), u16 0,
 * u32 first leg, u32 leg count; u32 legs, each u8 kind (0 stay, 1 trip, 2 away), u8 mode (0 walk,
 * 1 bike, 2 car), u8 flags (1 = with the dog, 2 = outdoors), u8 activity, f32 start, f32 end,
 * i32 route (-1 when not moving), f32 x, f32 y (where a stay happens); u32 routes, each u32 first
 * point, u32 point count; u32 points, each f32 x, y. Positions are Unreal centimetres, X = north,
 * Y = east, Z = up. Triangles are wound so the cross product (b - a) x (c - a), taken in these
 * coordinates, points along the vertex normal.
 */
export function writeDay({ sim, world, H, geometry, sun, dayType }) {
  const w = new Writer();
  w.ascii("HDAY");
  w.u32(1);
  w.u32(dayType === "weekend" ? 1 : 0);
  w.f32(H.DAY_START);
  w.f32(H.DAY_END);
  w.f32(sun.rise);
  w.f32(sun.set);
  w.u32(MATERIALS.length);
  for (const [, c] of MATERIALS) {
    const [r, gg, b] = hex(c);
    w.f32(r);
    w.f32(gg);
    w.f32(b);
    w.f32(1);
  }
  const parts = geometry.parts.map((p, material) => ({ ...p, material })).filter((p) => p.idx.length);
  w.u32(parts.length);
  for (const p of parts) {
    const n = p.pos.length / 3;
    const pos = new Float32Array(3 * n);
    const nrm = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      pos[3 * i] = p.pos[3 * i + 1] * 100;
      pos[3 * i + 1] = p.pos[3 * i] * 100;
      pos[3 * i + 2] = p.pos[3 * i + 2] * 100;
      nrm[3 * i] = p.nrm[3 * i + 1];
      nrm[3 * i + 1] = p.nrm[3 * i];
      nrm[3 * i + 2] = p.nrm[3 * i + 2];
    }
    // Swapping x and y mirrors the frame, so every triangle's order flips to keep facing out.
    const idx = new Uint32Array(p.idx.length);
    for (let i = 0; i < p.idx.length; i += 3) {
      idx[i] = p.idx[i];
      idx[i + 1] = p.idx[i + 2];
      idx[i + 2] = p.idx[i + 1];
    }
    w.u32(p.material);
    w.u32(n);
    w.u32(idx.length);
    w.typed(pos);
    w.typed(nrm);
    w.typed(idx);
  }

  // People, their legs and the street routes they follow (shared between legs that repeat one).
  const L = sim.legs;
  const K = H.KIND;
  w.u32(sim.n);
  for (let i = 0; i < sim.n; i++) {
    const k = sim.kind[i];
    w.u8(k === K.RESIDENT || k === K.DORM ? 0 : k === K.VISITOR ? 2 : 1);
    w.u8(sim.profile[i].dog ? 1 : 0);
    w.u16(0);
    w.u32(sim.legStart[i]);
    w.u32(sim.legEnd[i] - sim.legStart[i]);
  }
  const routeIndex = new Map();
  const routes = [];
  let points = 0;
  const legRoute = new Int32Array(L.n).fill(-1);
  for (let l = 0; l < L.n; l++) {
    if (L.kind[l] !== 1) continue;
    const car = L.mode[l] === 2;
    const key = (car ? "c" : "w") + L.a[l] + "|" + L.b[l];
    let r = routeIndex.get(key);
    if (r === undefined) {
      const route = car ? world.carRoute(L.a[l], L.b[l]) : world.walkRoute(L.a[l], L.b[l]);
      r = routes.length;
      routes.push(route);
      routeIndex.set(key, r);
      points += route.x.length;
    }
    legRoute[l] = r;
  }
  const park = world.G.park;
  w.u32(L.n);
  for (let l = 0; l < L.n; l++) {
    const i = sim.legAgent[l];
    const kind = L.kind[l];
    let x = 0;
    let y = 0;
    let outdoors = false;
    if (kind === 0) {
      const a = L.a[l];
      if (a === sim.homeAnchor[i]) {
        x = sim.hx[i];
        y = sim.hy[i];
      } else {
        const k = world.aKind[a] === H.ANCHOR.GATE ? 0.4 : 1;
        x = world.aX[a] + sim.jx[i] * k;
        y = world.aY[a] + sim.jy[i] * k;
        outdoors = world.aKind[a] === H.ANCHOR.PLACE && world.placeGroup[world.aRef[a]] === park;
      }
    }
    w.u8(kind);
    w.u8(L.mode[l]);
    w.u8((sim.withDogLeg(l) ? 1 : 0) | (outdoors ? 2 : 0));
    w.u8(L.act[l]);
    w.f32(L.t0[l]);
    w.f32(L.t1[l]);
    w.i32(legRoute[l]);
    w.f32(y * 100);
    w.f32(x * 100);
  }
  w.u32(routes.length);
  let first = 0;
  for (const r of routes) {
    w.u32(first);
    w.u32(r.x.length);
    first += r.x.length;
  }
  w.u32(points);
  const xy = new Float32Array(2 * points);
  let o = 0;
  for (const r of routes) {
    for (let i = 0; i < r.x.length; i++) {
      xy[o++] = r.y[i] * 100;
      xy[o++] = r.x[i] * 100;
    }
  }
  w.typed(xy);
  return { bytes: w.bytes(), routes: routes.length, points, legs: L.n };
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The city as a binary glTF: one primitive per material; metres, Y up, X east, -Z north. */
export function writeGlb(geometry) {
  const bin = [];
  let offset = 0;
  const bufferViews = [];
  const accessors = [];
  const view = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    bin.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      bin.push(Buffer.alloc(pad));
      offset += pad;
    }
    return bufferViews.length - 1;
  };
  const primitives = [];
  geometry.parts.forEach((p, material) => {
    if (!p.idx.length) return;
    const n = p.pos.length / 3;
    const pos = new Float32Array(3 * n);
    const nrm = new Float32Array(3 * n);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      pos[3 * i] = p.pos[3 * i];
      pos[3 * i + 1] = p.pos[3 * i + 2];
      pos[3 * i + 2] = -p.pos[3 * i + 1];
      nrm[3 * i] = p.nrm[3 * i];
      nrm[3 * i + 1] = p.nrm[3 * i + 2];
      nrm[3 * i + 2] = -p.nrm[3 * i + 1];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], pos[3 * i + k]);
        max[k] = Math.max(max[k], pos[3 * i + k]);
      }
    }
    accessors.push({ bufferView: view(pos, 34962), componentType: 5126, count: n, type: "VEC3", min, max });
    accessors.push({ bufferView: view(nrm, 34962), componentType: 5126, count: n, type: "VEC3" });
    accessors.push({ bufferView: view(Uint32Array.from(p.idx), 34963), componentType: 5125, count: p.idx.length, type: "SCALAR" });
    primitives.push({ attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 }, indices: accessors.length - 1, material });
  });
  const gltf = {
    asset: { version: "2.0", generator: "hoboken-sim export_unreal.mjs" },
    scene: 0,
    scenes: [{ name: "Hoboken", nodes: [0] }],
    nodes: [{ name: "Hoboken", mesh: 0 }],
    meshes: [{ name: "Hoboken", primitives }],
    materials: MATERIALS.map(([name, c]) => ({
      name, doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [...hex(c).map(toLinear), 1], metallicFactor: 0, roughnessFactor: 0.9 },
    })),
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
  };
  let json = Buffer.from(JSON.stringify(gltf));
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  const body = Buffer.concat(bin);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + body.length, 8);
  const chunk = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([header, chunk(json.length, 0x4e4f534a), json, chunk(body.length, 0x004e4942), body]);
}

/** Sunrise and sunset (seconds after midnight, EDT) for Hoboken on a day of the year; same formula as the page. */
function sunTimes(dayOfYear) {
  const lat = 40.745;
  const lon = -74.03;
  const rad = Math.PI / 180;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad;
  return { rise: (720 - 4 * (lon + ha) - eq - 240) * 60, set: (720 - 4 * (lon - ha) - eq - 240) * 60 };
}

export async function exportUnreal({ day = "weekday", jev = false, out = join(root, "dist", "unreal"), glb = true, quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const { data, H, world } = await loadEngine();
  let decisions = null;
  if (jev) {
    const saved = JSON.parse(await readFile(join(root, "web", "data", `jev-${day}.json`), "utf8"));
    const { topics, bytes } = unpackJev(saved);
    decisions = H.sequenceSource(topics, bytes);
  }
  const sim = new H.Simulation(world, { dayType: day, decisions });
  const geometry = buildCity(data, world);
  const day0 = sim.decisionStats;
  const { bytes, routes, points, legs } = writeDay({ sim, world, H, geometry, sun: sunTimes(day === "weekend" ? 269 : 265), dayType: day });
  await mkdir(out, { recursive: true });
  const dayFile = join(out, `hoboken-${day}.hday`);
  await writeFile(dayFile, bytes);
  const tris = geometry.parts.reduce((s, p) => s + p.idx.length / 3, 0);
  log(`wrote ${dayFile} (${(bytes.length / 1e6).toFixed(1)} MB): ${tris.toLocaleString()} city triangles, ${sim.n.toLocaleString()} people, ` +
    `${legs.toLocaleString()} legs, ${routes.toLocaleString()} street routes (${points.toLocaleString()} points)` +
    (jev ? `; Jev made ${day0.fromTable.toLocaleString()} of ${day0.points.toLocaleString()} decisions` : ""));
  let glbFile = null;
  if (glb) {
    glbFile = join(out, "hoboken-city.glb");
    const g = writeGlb(geometry);
    await writeFile(glbFile, g);
    log(`wrote ${glbFile} (${(g.length / 1e6).toFixed(1)} MB)`);
  }
  return { dayFile, glbFile, people: sim.n, legs, routes, points, triangles: tris };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { values } = parseArgs({
    options: {
      day: { type: "string", default: "weekday" },
      jev: { type: "boolean", default: false },
      out: { type: "string" },
      "no-glb": { type: "boolean", default: false },
    },
  });
  if (values.day !== "weekday" && values.day !== "weekend") throw new Error("--day must be weekday or weekend");
  exportUnreal({ day: values.day, jev: values.jev, out: values.out, glb: !values["no-glb"] }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
