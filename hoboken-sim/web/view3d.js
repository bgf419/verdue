/*
 * Hoboken in Motion: 3D view (three.js r128, loaded on demand from a CDN).
 *
 * Real building footprints extruded to their Overture heights, the Manhattan skyline across
 * the river, and every person, dog, bike and car the simulation has outdoors, drawn as
 * instanced figures. Lighting follows the sun for Hoboken on the simulated date; after dark
 * the windows light up. World coordinates are metres, x east and y north; three.js uses
 * y up, so a world point (x, y) sits at (x, height, -y).
 */
(function () {
  "use strict";

  const THREE_SRC = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
  const ORBIT_SRC = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js";
  let loading = null;

  function script(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error("Couldn't load " + src));
      document.head.appendChild(el);
    });
  }

  /** Load three.js and OrbitControls once. Resolves when both globals exist. */
  function load() {
    if (window.THREE && window.THREE.OrbitControls) return Promise.resolve();
    if (!loading) {
      loading = (window.THREE ? Promise.resolve() : script(THREE_SRC)).then(() => (window.THREE.OrbitControls ? null : script(ORBIT_SRC)));
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  function webglAvailable() {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
    } catch {
      return false;
    }
  }

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const hash = (n) => {
    let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  const mixRGB = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // Building palettes: Hoboken's brick and brownstone rowhouses, mid-rise masonry, glass towers.
  const LOW = [0x9c5b45, 0xa8674f, 0x8e4f3d, 0xb07a5f, 0x9a6a55, 0xc2a283, 0x8b5a48, 0xa05e4a].map(rgb);
  const MID = [0xc9c1b3, 0xb9b2a6, 0xd6cfc2, 0xa9a39a, 0xbfae98, 0xd2c6b4].map(rgb);
  const TALL = [0x8fa1b3, 0xa3b1bf, 0x7f8e9e, 0xc5ccd3, 0x9aa7ae, 0x6f8193].map(rgb);
  const CARS = [0xf2f2f0, 0x1c1c1e, 0x9aa0a6, 0x5c6168, 0xb3262e, 0x1f4e8c, 0xe8e2d0, 0x2f5d50].map(rgb);
  const DOGS = [0x8a5a2b, 0x2b2320, 0xd9c7a8, 0xb07b3e, 0x6b4a33, 0xf0ece4].map(rgb);
  const PEOPLE_DAY = [0x2a78d6, 0xeb6834, 0x1baf7a, 0x6d7d77].map(rgb);
  const PEOPLE_NIGHT = [0x5598e7, 0xe97442, 0x2bc28a, 0x8fa29b].map(rgb);

  // Camera views in world metres: target [x, y] on the ground, camera [x, y, height].
  // Washington Street runs about 13 degrees east of north: (-94, -900) to (254, 600).
  const PRESETS = {
    overview: { label: "Overview", target: [-120, 150], pos: [-1650, -1850, 1250] },
    washington: { label: "Washington St", target: [170, 180], pos: [-60, -760, 45] },
    terminal: { label: "Hoboken Terminal", target: [160, -1030], pos: [720, -1420, 210] },
    waterfront: { label: "Waterfront & skyline", target: [1500, -620], pos: [440, -820, 30] },
    stevens: { label: "Stevens", target: [460, -60], pos: [1000, -520, 260] },
  };

  function create(host, data, world, hooks) {
    const T = window.THREE;
    const S = data.meta.scale;
    const canvas = document.createElement("canvas");
    canvas.className = "view3d";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "3D view of Hoboken with simulated people, dogs and cars. Drag to orbit, scroll or pinch to zoom, tap a figure to follow it.");
    host.insertBefore(canvas, host.querySelector(".clock"));

    const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(42, 1, 2, 24000);
    const controls = new T.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.maxPolarAngle = 1.46;
    controls.minDistance = 20;
    controls.maxDistance = 7500;
    controls.screenSpacePanning = false;
    controls.touches = { ONE: T.TOUCH.PAN, TWO: T.TOUCH.DOLLY_ROTATE };

    const fog = new T.Fog(0xa9c6de, 4200, 14000);
    scene.fog = fog;
    const hemi = new T.HemisphereLight(0xdfeaf5, 0x6b6150, 0.55);
    const sun = new T.DirectionalLight(0xffffff, 0.85);
    scene.add(hemi, sun, sun.target);

    // ------------------------------------------------------------ static geometry
    /** Upward-facing winding: true when triangle a, b, c (three.js x/z) is counter-clockwise seen from above. */
    const facesUp = (ax, az, bx, bz, cx, cz) => (bz - az) * (cx - ax) - (bx - ax) * (cz - az) >= 0;
    const flatToV2 = (ring) => {
      const pts = [];
      for (let i = 0; i < ring.length; i += 2) pts.push(new T.Vector2(ring[i] / S, ring[i + 1] / S));
      return pts;
    };

    /** Flat polygons (with holes) at height y, merged into one mesh. */
    function flatPolys(list, y, material) {
      const pos = [];
      for (const poly of list) {
        const contour = flatToV2(poly[0]);
        const holes = poly.slice(1).map(flatToV2);
        let faces;
        try {
          faces = T.ShapeUtils.triangulateShape(contour, holes);
        } catch {
          continue;
        }
        const all = contour.concat(...holes);
        for (const f of faces) {
          const [a, b, c] = f.map((k) => all[k]);
          const order = facesUp(a.x, -a.y, b.x, -b.y, c.x, -c.y) ? [a, b, c] : [a, c, b];
          for (const q of order) pos.push(q.x, y, -q.y);
        }
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
      const nrm = new Float32Array(pos.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      geo.setAttribute("normal", new T.BufferAttribute(nrm, 3));
      const mesh = new T.Mesh(geo, material);
      mesh.renderOrder = 1;
      return mesh;
    }

    const box = data.context3d.map((v) => v / S);
    const groundMat = new T.MeshLambertMaterial({ color: 0xb8bcb3 });
    const ground = new T.Mesh(new T.PlaneGeometry(box[2] - box[0] + 30000, box[3] - box[1] + 30000), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((box[0] + box[2]) / 2, -0.6, -(box[1] + box[3]) / 2);
    scene.add(ground);

    // (Hoboken's municipal boundary runs out into the Hudson to the state line, so it isn't
    // drawn as a land tint here: it would paint over the river.)
    const waterMat = new T.MeshPhongMaterial({ color: 0x5d7f98, specular: 0x9ab4c8, shininess: 70 });
    scene.add(flatPolys(data.water3d, -0.2, waterMat));
    const parkMat = new T.MeshLambertMaterial({ color: 0x9fc38a, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    scene.add(flatPolys(data.parks, -0.1, parkMat));
    const pierMat = new T.MeshLambertMaterial({ color: 0xc9c6bd });
    scene.add(flatPolys(data.piers, 1.2, pierMat));

    // Streets as flat ribbons, one merged mesh; paths lighter than asphalt.
    const ROAD_W = { 1: 15, 2: 13, 3: 12, 4: 10, 5: 8.5, 6: 5, 7: 2.6, 8: 2.8 };
    const ASPHALT = rgb(0x62676b);
    const PATH = rgb(0xc4beb1);
    const rPos = [];
    const rCol = [];
    function ribbon(xs, ys, width, col, y) {
      const hw = width / 2;
      for (let i = 0; i + 1 < xs.length; i++) {
        const dx = xs[i + 1] - xs[i];
        const dy = ys[i + 1] - ys[i];
        const len = Math.hypot(dx, dy);
        if (len < 0.01) continue;
        // Extend each piece by half a width so joints overlap instead of leaving notches.
        const ux = dx / len;
        const uy = dy / len;
        const ext = Math.min(hw, len / 2);
        const ax = xs[i] - ux * ext;
        const ay = ys[i] - uy * ext;
        const bx = xs[i + 1] + ux * ext;
        const by = ys[i + 1] + uy * ext;
        const nx = -uy * hw;
        const ny = ux * hw;
        const q = [ax + nx, ay + ny, ax - nx, ay - ny, bx - nx, by - ny, bx + nx, by + ny];
        for (const tri of [[0, 1, 2], [0, 2, 3]]) {
          const [i0, i1, i2] = tri;
          const up = facesUp(q[2 * i0], -q[2 * i0 + 1], q[2 * i1], -q[2 * i1 + 1], q[2 * i2], -q[2 * i2 + 1]);
          for (const k of up ? tri : [i0, i2, i1]) {
            rPos.push(q[2 * k], y, -q[2 * k + 1]);
            rCol.push(col[0], col[1], col[2]);
          }
        }
      }
    }
    for (let e = 0; e < world.nE; e++) {
      const cls = world.ecls[e];
      const xs = [];
      const ys = [];
      for (let j = world.gOff[e]; j < world.gOff[e + 1]; j++) {
        xs.push(world.gx[j]);
        ys.push(world.gy[j]);
      }
      ribbon(xs, ys, ROAD_W[cls] || 8, cls >= 7 ? PATH : ASPHALT, cls >= 7 ? 0.05 : 0.0);
    }
    for (const [cls, pts] of data.contextRoads) {
      const xs = [];
      const ys = [];
      for (let i = 0; i < pts.length; i += 2) {
        xs.push(pts[i] / S);
        ys.push(pts[i + 1] / S);
      }
      ribbon(xs, ys, (ROAD_W[cls] || 8) * 0.9, ASPHALT, 0.0);
    }
    const roadGeo = new T.BufferGeometry();
    roadGeo.setAttribute("position", new T.Float32BufferAttribute(rPos, 3));
    roadGeo.setAttribute("color", new T.Float32BufferAttribute(rCol, 3));
    const rn = new Float32Array(rPos.length);
    for (let i = 1; i < rn.length; i += 3) rn[i] = 1;
    roadGeo.setAttribute("normal", new T.BufferAttribute(rn, 3));
    const roadMat = new T.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const roads = new T.Mesh(roadGeo, roadMat);
    roads.renderOrder = 2;
    scene.add(roads);

    // Rail at grade (NJ Transit, light rail); PATH runs in tunnels and isn't drawn.
    const railPos = [];
    for (const [code, pts] of data.rail) {
      if (code === 12) continue;
      for (let i = 0; i + 2 < pts.length; i += 2) railPos.push(pts[i] / S, 0.4, -pts[i + 1] / S, pts[i + 2] / S, 0.4, -pts[i + 3] / S);
    }
    const railGeo = new T.BufferGeometry();
    railGeo.setAttribute("position", new T.Float32BufferAttribute(railPos, 3));
    const railMat = new T.LineBasicMaterial({ color: 0x4a4f52 });
    scene.add(new T.LineSegments(railGeo, railMat));

    // Window textures: daytime glass on a white wall (multiplied by the building colour),
    // and a night map where a share of windows are lit.
    function windowTexture(night) {
      const size = 256;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      g.fillStyle = night ? "#000000" : "#ffffff";
      g.fillRect(0, 0, size, size);
      const cell = size / 4;
      for (let r = 0; r < 4; r++) {
        for (let k = 0; k < 4; k++) {
          const x = k * cell + cell * 0.22;
          const y = r * cell + cell * 0.2;
          if (night) {
            const u = hash(r * 7 + k * 13 + 3);
            if (u < 0.42) {
              const warm = u < 0.3 ? "255,204,128" : "214,232,255";
              g.fillStyle = "rgba(" + warm + "," + (0.55 + hash(r * 3 + k * 11) * 0.45) + ")";
              g.fillRect(x, y, cell * 0.56, cell * 0.52);
            }
          } else {
            g.fillStyle = "#aeb9c3";
            g.fillRect(x, y, cell * 0.56, cell * 0.52);
          }
        }
      }
      const tex = new T.CanvasTexture(c);
      tex.wrapS = tex.wrapT = T.RepeatWrapping;
      tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      return tex;
    }

    /** Extruded buildings: walls with window UVs, flat roofs; one merged mesh. */
    function extrude(items) {
      // items: [flatRing(half-metres), height, [r,g,b]]
      let nWall = 0;
      let nRoof = 0;
      const roofs = [];
      for (const it of items) {
        const pts = flatToV2(it[0]);
        if (pts.length < 3) {
          roofs.push(null);
          continue;
        }
        nWall += pts.length;
        let faces = [];
        try {
          faces = T.ShapeUtils.triangulateShape(pts, []);
        } catch {
          faces = [];
        }
        nRoof += faces.length;
        roofs.push([pts, faces]);
      }
      const nv = nWall * 6 + nRoof * 3;
      const pos = new Float32Array(nv * 3);
      const nrm = new Float32Array(nv * 3);
      const col = new Float32Array(nv * 3);
      const uv = new Float32Array(nv * 2);
      let v = 0;
      const put = (x, y, z, nx, ny, nz, c, u, w) => {
        pos[3 * v] = x;
        pos[3 * v + 1] = y;
        pos[3 * v + 2] = z;
        nrm[3 * v] = nx;
        nrm[3 * v + 1] = ny;
        nrm[3 * v + 2] = nz;
        col[3 * v] = c[0];
        col[3 * v + 1] = c[1];
        col[3 * v + 2] = c[2];
        uv[2 * v] = u;
        uv[2 * v + 1] = w;
        v++;
      };
      items.forEach((it, idx) => {
        const r = roofs[idx];
        if (!r) return;
        const [pts, faces] = r;
        const h = it[1];
        const c = it[2];
        const roofC = [c[0] * 0.72, c[1] * 0.72, c[2] * 0.72];
        let along = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = dy / len;
          const nz = dx / len; // outward normal of a counter-clockwise ring, in three.js axes
          const u0 = along / 12;
          const u1 = (along + len) / 12;
          const vt = h / 12;
          put(a.x, 0, -a.y, nx, 0, nz, c, u0, 0);
          put(b.x, 0, -b.y, nx, 0, nz, c, u1, 0);
          put(b.x, h, -b.y, nx, 0, nz, c, u1, vt);
          put(a.x, 0, -a.y, nx, 0, nz, c, u0, 0);
          put(b.x, h, -b.y, nx, 0, nz, c, u1, vt);
          put(a.x, h, -a.y, nx, 0, nz, c, u0, vt);
          along += len;
        }
        for (const f of faces) {
          const [a, b, c] = f.map((k) => pts[k]);
          const order = facesUp(a.x, -a.y, b.x, -b.y, c.x, -c.y) ? [a, b, c] : [a, c, b];
          for (const q of order) put(q.x, h, -q.y, 0, 1, 0, roofC, 0.02, 0.02);
        }
      });
      const geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(pos.subarray(0, v * 3), 3));
      geo.setAttribute("normal", new T.BufferAttribute(nrm.subarray(0, v * 3), 3));
      geo.setAttribute("color", new T.BufferAttribute(col.subarray(0, v * 3), 3));
      geo.setAttribute("uv", new T.BufferAttribute(uv.subarray(0, v * 2), 2));
      geo.computeBoundingSphere();
      return geo;
    }

    const items = [];
    data.buildings.forEach((b, i) => {
      const known = b.h > 0;
      const h = known ? b.h : b.in ? 10 : 9;
      const pal = h >= 40 ? TALL : h >= 16 || b.k === 1 ? MID : LOW;
      items.push([b.p, Math.max(3, h), pal[Math.floor(hash(i) * pal.length)]]);
    });
    data.skyline.forEach(([h, ring], i) => {
      items.push([ring, h, TALL[Math.floor(hash(i + 99991) * TALL.length)]]);
    });
    const dayWin = windowTexture(false);
    const nightWin = windowTexture(true);
    const buildingMat = new T.MeshLambertMaterial({ vertexColors: true, map: dayWin, emissive: 0xffffff,
      emissiveMap: nightWin, emissiveIntensity: 0, side: T.DoubleSide });
    const buildings = new T.Mesh(extrude(items), buildingMat);
    scene.add(buildings);

    // ------------------------------------------------------------ figures
    function merge(parts) {
      const pos = [];
      const nrm = [];
      for (const [geo, x, y, z] of parts) {
        const g = geo.index ? geo.toNonIndexed() : geo;
        g.translate(x, y, z);
        pos.push(...g.attributes.position.array);
        nrm.push(...g.attributes.normal.array);
      }
      const out = new T.BufferGeometry();
      out.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
      out.setAttribute("normal", new T.Float32BufferAttribute(nrm, 3));
      out.computeBoundingSphere();
      return out;
    }
    const personGeo = merge([[new T.CylinderGeometry(0.2, 0.27, 1.3, 7), 0, 0.65, 0], [new T.SphereGeometry(0.2, 8, 6), 0, 1.5, 0]]);
    const carGeo = merge([[new T.BoxGeometry(4.4, 1.0, 1.85), 0, 0.72, 0], [new T.BoxGeometry(2.3, 0.62, 1.62), -0.25, 1.53, 0]]);
    const dogGeo = merge([[new T.BoxGeometry(0.72, 0.3, 0.26), 0, 0.42, 0], [new T.BoxGeometry(0.26, 0.24, 0.2), 0.42, 0.6, 0],
      [new T.BoxGeometry(0.06, 0.3, 0.2), -0.28, 0.15, 0], [new T.BoxGeometry(0.06, 0.3, 0.2), 0.26, 0.15, 0]]);
    const bikeGeo = merge([[new T.BoxGeometry(1.7, 0.06, 0.06), 0, 0.62, 0], [new T.TorusGeometry(0.33, 0.04, 4, 12), -0.55, 0.34, 0],
      [new T.TorusGeometry(0.33, 0.04, 4, 12), 0.55, 0.34, 0]]);

    function instanced(geo, cap, emissive) {
      const mat = new T.MeshLambertMaterial({ vertexColors: false, emissive: emissive || 0x000000 });
      const mesh = new T.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
      mesh.setColorAt(0, new T.Color(1, 1, 1));
      mesh.instanceColor.setUsage(T.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    }
    const people = instanced(personGeo, 20000);
    const cars = instanced(carGeo, 6000);
    const dogs = instanced(dogGeo, 4000);
    const bikes = instanced(bikeGeo, 2000);
    const peopleIds = new Int32Array(20000);
    const carIds = new Int32Array(6000);

    const ring = new T.Mesh(new T.RingGeometry(1.4, 1.9, 32), new T.MeshBasicMaterial({ color: 0x1d7a66, side: T.DoubleSide, depthTest: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 10;
    ring.visible = false;
    scene.add(ring);

    function setM(mesh, k, x, y, z, th, s) {
      const e = mesh.instanceMatrix.array;
      const c = Math.cos(th) * s;
      const n = Math.sin(th) * s;
      const o = 16 * k;
      e[o] = c;
      e[o + 1] = 0;
      e[o + 2] = -n;
      e[o + 3] = 0;
      e[o + 4] = 0;
      e[o + 5] = s;
      e[o + 6] = 0;
      e[o + 7] = 0;
      e[o + 8] = n;
      e[o + 9] = 0;
      e[o + 10] = c;
      e[o + 11] = 0;
      e[o + 12] = x;
      e[o + 13] = y;
      e[o + 14] = z;
      e[o + 15] = 1;
    }
    function setC(mesh, k, c) {
      const a = mesh.instanceColor.array;
      a[3 * k] = c[0];
      a[3 * k + 1] = c[1];
      a[3 * k + 2] = c[2];
    }

    // ------------------------------------------------------------ camera
    let tween = null;
    // A scripted camera (scripts/film.mjs) is placed exactly; the orbit controls, which would
    // clamp low street-level angles, leave it alone until someone drags or picks a preset.
    let scripted = false;
    function worldToCam(p) {
      return new T.Vector3(p[0], p[2] || 0, -p[1]);
    }
    /** Put the camera at world [x, y, height] looking at world [x, y, height]. */
    function look(pos, target) {
      tween = null;
      scripted = true;
      camera.position.copy(worldToCam(pos));
      controls.target.copy(worldToCam(target));
      camera.lookAt(controls.target);
    }
    function preset(name, instant) {
      const P = PRESETS[name];
      if (!P) return;
      scripted = false;
      const to = { pos: worldToCam(P.pos), target: worldToCam([P.target[0], P.target[1], 0]) };
      if (instant) {
        camera.position.copy(to.pos);
        controls.target.copy(to.target);
        controls.update();
        return;
      }
      tween = { from: { pos: camera.position.clone(), target: controls.target.clone() }, to, t0: performance.now(), ms: 1300 };
    }
    preset("overview", true);

    let follow = -1;
    let selected = -1;

    // ------------------------------------------------------------ lighting through the day
    const SKY_DAY = rgb(0xa9c6de);
    const SKY_DUSK = rgb(0xe8b48c);
    const SKY_NIGHT = rgb(0x0b1322);
    const GROUND_DAY = rgb(0xb8bcb3);
    const GROUND_NIGHT = rgb(0x151c1e);
    const WATER_DAY = rgb(0x5d7f98);
    const WATER_NIGHT = rgb(0x0b1826);
    const ASPH_NIGHT = 0.35;
    function sunDirection(t, sunTimes) {
      const noon = (sunTimes.rise + sunTimes.set) / 2;
      const lat = (40.745 * Math.PI) / 180;
      const H = ((t - noon) / 86400) * 2 * Math.PI;
      const el = Math.asin(Math.cos(lat) * Math.cos(H));
      const az = Math.atan2(-Math.sin(H), -Math.sin(lat) * Math.cos(H));
      return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
    }
    let lastLight = -1;
    function lightFor(t, light, sunTimes) {
      const d = sunDirection(t, sunTimes);
      sun.position.set(controls.target.x + d[0] * 3000, Math.max(80, d[1] * 3000), controls.target.z + d[2] * 3000);
      sun.target.position.copy(controls.target);
      if (Math.abs(light - lastLight) < 0.004) return;
      lastLight = light;
      const dusk = Math.max(0, 1 - Math.abs(light - 0.5) * 2) * 0.9;
      const sky = mixRGB(mixRGB(SKY_NIGHT, SKY_DAY, light), SKY_DUSK, dusk * 0.6);
      scene.background = new T.Color(sky[0], sky[1], sky[2]);
      fog.color.setRGB(sky[0], sky[1], sky[2]);
      sun.intensity = 0.15 + 0.75 * light;
      sun.color.setRGB(1, 0.86 + 0.14 * light, 0.7 + 0.3 * light);
      hemi.intensity = 0.28 + 0.34 * light;
      const g = mixRGB(GROUND_NIGHT, GROUND_DAY, light);
      groundMat.color.setRGB(g[0], g[1], g[2]);
      const wcol = mixRGB(WATER_NIGHT, WATER_DAY, light);
      waterMat.color.setRGB(wcol[0], wcol[1], wcol[2]);
      parkMat.color.setRGB(0.62 * (0.25 + 0.75 * light), 0.76 * (0.25 + 0.75 * light), 0.54 * (0.25 + 0.75 * light));
      roadMat.color.setScalar(ASPH_NIGHT + (1 - ASPH_NIGHT) * light);
      buildingMat.emissiveIntensity = (1 - light) * 0.95;
      cars.material.emissive.setRGB(0.25 * (1 - light), 0.22 * (1 - light), 0.12 * (1 - light));
      // Street lighting isn't modelled; a little glow keeps people and dogs visible after dark.
      people.material.emissive.setScalar(0.3 * (1 - light));
      dogs.material.emissive.setScalar(0.18 * (1 - light));
    }

    // ------------------------------------------------------------ per frame
    const H = window.HobokenSim.STATE;
    let pc = PEOPLE_DAY;
    function update(sim, xs, ys, states, who, t, light, sunTimes) {
      pc = light > 0.5 ? PEOPLE_DAY : PEOPLE_NIGHT;
      const dist = camera.position.distanceTo(controls.target);
      const sp = clamp(dist / 320, 1, 6);
      const sc = clamp(dist / 700, 1, 2.6);
      let np = 0;
      let nc = 0;
      let nd = 0;
      let nb = 0;
      const n = sim.n;
      for (let i = 0; i < n; i++) {
        const st = states[i];
        if (st === H.HIDDEN || st === H.HOME) continue;
        if (st === H.PLACE && !sim.outdoors(i)) continue;
        const x = xs[i];
        const z = -ys[i];
        const th = sim.heading[i];
        if (st === H.CAR) {
          if (nc < carIds.length) {
            setM(cars, nc, x, 0, z, th, sc);
            setC(cars, nc, CARS[Math.floor(hash(i) * CARS.length)]);
            carIds[nc++] = i;
          }
          continue;
        }
        if (np >= peopleIds.length) continue;
        const bike = st === H.BIKE;
        setM(people, np, x, bike ? 0.55 * sp : 0, z, th, sp);
        setC(people, np, pc[who[i]]);
        peopleIds[np++] = i;
        if (bike && nb < 2000) {
          setM(bikes, nb, x, 0, z, th, sp);
          setC(bikes, nb++, [0.12, 0.13, 0.14]);
        }
        if (nd < 4000 && sim.withDog(i)) {
          const a = th + (st === H.PLACE ? hash(i) * 6.28 : 0.85);
          const r = 1.3 * sp;
          setM(dogs, nd, x + Math.cos(a) * r, 0, z - Math.sin(a) * r, th, sp);
          setC(dogs, nd++, DOGS[Math.floor(hash(i + 7) * DOGS.length)]);
        }
      }
      for (const [mesh, count] of [[people, np], [cars, nc], [dogs, nd], [bikes, nb]]) {
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
      }
      // Camera tween, following, selection ring.
      if (tween) {
        const u = clamp((performance.now() - tween.t0) / tween.ms, 0, 1);
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        camera.position.lerpVectors(tween.from.pos, tween.to.pos, e);
        controls.target.lerpVectors(tween.from.target, tween.to.target, e);
        if (u >= 1) tween = null;
      }
      if (follow >= 0 && states[follow] !== H.HIDDEN) {
        const tx = xs[follow];
        const tz = -ys[follow];
        const dx = (tx - controls.target.x) * 0.12;
        const dz = (tz - controls.target.z) * 0.12;
        controls.target.x += dx;
        controls.target.z += dz;
        camera.position.x += dx;
        camera.position.z += dz;
      }
      if (selected >= 0 && states[selected] !== H.HIDDEN) {
        ring.visible = true;
        ring.position.set(xs[selected], 0.3, -ys[selected]);
        ring.scale.setScalar(states[selected] === H.CAR ? sc * 2.2 : sp * 1.6);
      } else {
        ring.visible = false;
      }
      lightFor(t, light, sunTimes);
      if (scripted) camera.lookAt(controls.target);
      else controls.update();
      renderer.render(scene, camera);
    }

    function resize() {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    // Tap or click (without dragging) picks the nearest figure on screen.
    const v = new T.Vector3();
    function pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      let best = -1;
      let bd = 22 * 22;
      const test = (mesh, ids, count) => {
        const e = mesh.instanceMatrix.array;
        for (let k = 0; k < count; k++) {
          v.set(e[16 * k + 12], e[16 * k + 13] + 1, e[16 * k + 14]).project(camera);
          if (v.z > 1) continue;
          const px = rect.left + ((v.x + 1) / 2) * rect.width;
          const py = rect.top + ((1 - v.y) / 2) * rect.height;
          const dd = (px - clientX) * (px - clientX) + (py - clientY) * (py - clientY);
          if (dd < bd) {
            bd = dd;
            best = ids[k];
          }
        }
      };
      test(people, peopleIds, people.count);
      test(cars, carIds, cars.count);
      return best;
    }
    let down = null;
    canvas.addEventListener("pointerdown", (ev) => {
      down = { x: ev.clientX, y: ev.clientY };
      tween = null;
      scripted = false;
    });
    canvas.addEventListener("pointerup", (ev) => {
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 6) hooks.onPick(pick(ev.clientX, ev.clientY));
      down = null;
    });
    controls.addEventListener("start", () => {
      if (follow >= 0 && hooks.onFollowBroken) hooks.onFollowBroken();
    });

    return {
      canvas,
      update,
      resize,
      preset,
      look,
      presets: PRESETS,
      setSelected(i) {
        selected = i;
      },
      setFollow(i) {
        follow = i;
        if (i >= 0) {
          tween = null;
          const dist = camera.position.distanceTo(controls.target);
          if (dist > 160) {
            // Drop in close behind the person before following.
            const tx = controls.target.x;
            const tz = controls.target.z;
            const dir = new T.Vector3().subVectors(camera.position, controls.target).setY(0).normalize();
            tween = { from: { pos: camera.position.clone(), target: controls.target.clone() },
              to: { pos: new T.Vector3(tx + dir.x * 70, 42, tz + dir.z * 70), target: new T.Vector3(tx, 0, tz) }, t0: performance.now(), ms: 900 };
          }
        }
      },
      stats() {
        return { people: people.count, cars: cars.count, dogs: dogs.count, bikes: bikes.count, triangles: renderer.info.render.triangles };
      },
    };
  }

  window.HobokenView3D = { load, create, webglAvailable, PRESETS };
})();
