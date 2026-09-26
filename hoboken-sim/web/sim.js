/*
 * Hoboken in Motion: simulation core.
 *
 * Pure computation with no DOM access, so the same file runs in the page and in the
 * Node tests. Every person in the simulation is synthetic: residents are drawn from
 * Census aggregates and placed in real buildings in proportion to address counts;
 * commuters and visitors are drawn from the published station and mode figures in
 * calibration.json. No real individual's data is read or produced.
 *
 * Each synthetic person gets a complete plan for the day (a list of legs: stays,
 * trips on the street graph, and time away from Hoboken). Where someone is at any
 * clock time is a pure function of that plan, so the page can jump to any time.
 */
(function (root) {
  "use strict";

  const HOUR = 3600;
  const DAY_START = 4 * HOUR; // the simulated day runs 04:00 -> 04:00
  const DAY_END = DAY_START + 24 * HOUR;
  const BIN = 300; // statistics resolution: 5 minutes
  const NBINS = (DAY_END - DAY_START) / BIN;

  // Leg kinds
  const STAY = 0;
  const TRIP = 1;
  const AWAY = 2;
  // How a trip moves on the map
  const WALK = 0;
  const BIKE = 1;
  const CAR = 2;
  const MODE_LABELS = ["walking", "cycling", "driving"];

  // Channels for crossing the city line
  const CHANNELS = ["path", "njtRail", "hblr", "ferry", "bus", "car", "bike", "walk"];
  const CHANNEL_LABELS = ["PATH", "NJ Transit rail", "Light rail", "Ferry", "Bus", "Car", "Bike", "On foot"];
  const CH = {};
  CHANNELS.forEach((c, i) => { CH[c] = i; });

  // Kinds of people
  const RESIDENT = 0;
  const DORM = 1;
  const WORKER_IN = 2;
  const STUDENT_IN = 3;
  const VISITOR = 4;
  const TRANSFER = 5;
  const KIND_LABELS = ["Resident", "Stevens dorm resident", "Commutes in to work", "Commutes in to Stevens",
    "Visitor", "Changing trains at Hoboken Terminal"];

  const ACTS = ["home", "work", "school", "daycare", "class", "eat", "drinks", "coffee", "shopping", "groceries",
    "gym", "park", "errand", "doctor", "worship", "sightseeing", "station", "away", "dogwalk"];
  const ACT_LABELS = ["At home", "At work", "At school", "At daycare", "In class", "Eating out", "Out for drinks",
    "Getting coffee", "Shopping", "Buying groceries", "At the gym", "In a park", "Running an errand", "At a doctor",
    "At a service", "Sightseeing", "At the station", "Outside Hoboken", "Walking the dog"];
  const A = {};
  ACTS.forEach((a, i) => { A[a] = i; });
  const ACT_DOG = A.dogwalk;

  const REGIONS = ["Midtown Manhattan", "Lower Manhattan", "Jersey City", "Newark & western NJ", "Elsewhere in NJ",
    "Brooklyn & Queens", "Hoboken"];
  const R = { midtown: 0, lower: 1, jc: 2, newark: 3, nj: 4, bkq: 5, hoboken: 6 };

  // ------------------------------------------------------------------ utilities

  function rngFrom(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash01(n) {
    let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function pick(rng, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = rng() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  function pickKey(rng, table) {
    const keys = Object.keys(table);
    return keys[pick(rng, keys.map((k) => table[k]))];
  }

  function gauss(rng) {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  function between(rng, a, b) {
    return a + (b - a) * rng();
  }

  function minutes(m) {
    return m * 60;
  }

  // ------------------------------------------------------------------ world

  function buildAdjacency(nN, nE, arcsOf) {
    const u = [];
    const v = [];
    const e = [];
    for (let i = 0; i < nE; i++) {
      for (const arc of arcsOf(i)) {
        u.push(arc[0]);
        v.push(arc[1]);
        e.push(i);
      }
    }
    const start = new Int32Array(nN + 1);
    for (let i = 0; i < u.length; i++) start[u[i] + 1]++;
    for (let i = 0; i < nN; i++) start[i + 1] += start[i];
    const fill = start.slice(0, nN);
    const to = new Int32Array(u.length);
    const edge = new Int32Array(u.length);
    for (let i = 0; i < u.length; i++) {
      const k = fill[u[i]]++;
      to[k] = v[i];
      edge[k] = e[i];
    }
    return { start, to, edge };
  }

  /**
   * Multi-source Dijkstra. pred[n] is the edge leading from n one step toward the sources.
   * Distances are computed in float64 (a float32 store would round below the heap's keys
   * and silently skip nodes) and kept as float32 afterwards to halve memory.
   */
  function dijkstra(nN, adj, elen, sources) {
    const dist = new Float64Array(nN).fill(Infinity);
    const pred = new Int32Array(nN).fill(-1);
    const heapN = [];
    const heapD = [];
    function push(n, d) {
      heapN.push(n);
      heapD.push(d);
      let i = heapN.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapD[p] <= heapD[i]) break;
        [heapN[p], heapN[i]] = [heapN[i], heapN[p]];
        [heapD[p], heapD[i]] = [heapD[i], heapD[p]];
        i = p;
      }
    }
    function pop() {
      const n = heapN[0];
      const d = heapD[0];
      const lastN = heapN.pop();
      const lastD = heapD.pop();
      if (heapN.length) {
        heapN[0] = lastN;
        heapD[0] = lastD;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heapN.length && heapD[l] < heapD[m]) m = l;
          if (r < heapN.length && heapD[r] < heapD[m]) m = r;
          if (m === i) break;
          [heapN[m], heapN[i]] = [heapN[i], heapN[m]];
          [heapD[m], heapD[i]] = [heapD[i], heapD[m]];
          i = m;
        }
      }
      return [n, d];
    }
    for (const [n, d] of sources) {
      if (d < dist[n]) {
        dist[n] = d;
        push(n, d);
      }
    }
    while (heapN.length) {
      const [n, d] = pop();
      if (d > dist[n]) continue;
      for (let k = adj.start[n]; k < adj.start[n + 1]; k++) {
        const m = adj.to[k];
        const nd = d + elen[adj.edge[k]];
        if (nd < dist[m]) {
          dist[m] = nd;
          pred[m] = adj.edge[k];
          push(m, nd);
        }
      }
    }
    return { dist: Float32Array.from(dist), pred: nE16(pred) };
  }

  function nE16(pred) {
    return pred.length && Math.max(...pred) < 32767 ? Int16Array.from(pred) : pred;
  }

  const ANCHOR_HOME = 0;
  const ANCHOR_DORM = 1;
  const ANCHOR_PLACE = 2;
  const ANCHOR_GATE = 3;
  const ANCHOR_STOP = 4;

  function World(data) {
    this.data = data;
    const S = data.meta.scale;
    const g = data.graph;
    const nN = (this.nN = g.nodes.length / 2);
    const nE = (this.nE = g.edges.length / 6);
    const nx = (this.nx = new Float32Array(nN));
    const ny = (this.ny = new Float32Array(nN));
    for (let i = 0; i < nN; i++) {
      nx[i] = g.nodes[2 * i] / S;
      ny[i] = g.nodes[2 * i + 1] / S;
    }
    const ea = (this.ea = new Int32Array(nE));
    const eb = (this.eb = new Int32Array(nE));
    const ef = (this.ef = new Uint8Array(nE));
    this.ecls = new Uint8Array(nE);
    this.ename = new Int32Array(nE);
    for (let i = 0; i < nE; i++) {
      ea[i] = g.edges[6 * i];
      eb[i] = g.edges[6 * i + 1];
      ef[i] = g.edges[6 * i + 3];
      this.ecls[i] = g.edges[6 * i + 4];
      this.ename[i] = g.edges[6 * i + 5];
    }
    // Edge polylines with endpoints, plus cumulative length along each.
    const off = (this.gOff = new Int32Array(nE + 1));
    for (let i = 0; i < nE; i++) off[i + 1] = off[i] + 2 + (g.geom[i] ? g.geom[i].length / 2 : 0);
    const gx = (this.gx = new Float32Array(off[nE]));
    const gy = (this.gy = new Float32Array(off[nE]));
    const gc = (this.gc = new Float32Array(off[nE]));
    const elen = (this.elen = new Float32Array(nE));
    for (let i = 0; i < nE; i++) {
      let k = off[i];
      gx[k] = nx[ea[i]];
      gy[k] = ny[ea[i]];
      k++;
      const mid = g.geom[i];
      if (mid) {
        for (let j = 0; j < mid.length; j += 2) {
          gx[k] = mid[j] / S;
          gy[k] = mid[j + 1] / S;
          k++;
        }
      }
      gx[k] = nx[eb[i]];
      gy[k] = ny[eb[i]];
      for (let j = off[i] + 1; j < off[i + 1]; j++) gc[j] = gc[j - 1] + Math.hypot(gx[j] - gx[j - 1], gy[j] - gy[j - 1]);
      elen[i] = Math.max(0.5, gc[off[i + 1] - 1]);
    }
    const F = data.meta.edgeFlags;
    this.walkAdj = buildAdjacency(nN, nE, (e) => (ef[e] & F.walk ? [[ea[e], eb[e]], [eb[e], ea[e]]] : []));
    const carArcs = (e, reverse) => {
      const arcs = [];
      if (ef[e] & F.carForward) arcs.push(reverse ? [eb[e], ea[e]] : [ea[e], eb[e]]);
      if (ef[e] & F.carBackward) arcs.push(reverse ? [ea[e], eb[e]] : [eb[e], ea[e]]);
      return arcs;
    };
    this.carFwd = buildAdjacency(nN, nE, (e) => carArcs(e, false));
    this.carRev = buildAdjacency(nN, nE, (e) => carArcs(e, true));
    this.walkTrees = new Map();
    this.carTrees = new Map();

    // Anchors: every location a person can be at (home buildings, dorms, venues, gateways, bus stops).
    const n = data.homes.length + data.dorms.length + data.places.length + data.gateways.length + data.busStops.length;
    this.nA = n;
    this.aX = new Float32Array(n);
    this.aY = new Float32Array(n);
    this.aEdge = new Int32Array(n);
    this.aT = new Float32Array(n);
    this.aCar = new Int32Array(n).fill(-1);
    this.aKind = new Uint8Array(n);
    this.aRef = new Int32Array(n);
    let k = 0;
    const put = (kind, ref, x, y, edge, t, car) => {
      this.aKind[k] = kind;
      this.aRef[k] = ref;
      this.aX[k] = x / S;
      this.aY[k] = y / S;
      this.aEdge[k] = edge;
      this.aT[k] = t;
      if (car !== undefined && car !== null) this.aCar[k] = car;
      return k++;
    };
    this.homeA0 = k;
    data.homes.forEach((h, i) => put(ANCHOR_HOME, i, h[0], h[1], h[2], h[3] / 1000, h[6]));
    this.dormA0 = k;
    data.dorms.forEach((d, i) => put(ANCHOR_DORM, i, d[0], d[1], d[2], d[3] / 1000));
    this.placeA0 = k;
    data.places.forEach((p, i) => put(ANCHOR_PLACE, i, p[0], p[1], p[3], p[4] / 1000, p[8] >= 0 ? p[8] : null));
    this.gateA0 = k;
    this.gate = {};
    data.gateways.forEach((gw, i) => {
      this.gate[gw.id] = put(ANCHOR_GATE, i, gw.x, gw.y, gw.edge, gw.t, gw.carNode >= 0 ? gw.carNode : null);
    });
    this.stopA0 = k;
    data.busStops.forEach((b, i) => put(ANCHOR_STOP, i, b[0], b[1], b[2], b[3] / 1000));

    // Venues grouped by kind, with job and visit weights.
    this.groups = data.meta.groups;
    this.byGroup = this.groups.map(() => []);
    this.placeGroup = new Uint8Array(data.places.length);
    data.places.forEach((p, i) => {
      this.placeGroup[i] = p[2];
      this.byGroup[p[2]].push(this.placeA0 + i);
    });
    this.G = {};
    this.groups.forEach((name, i) => { this.G[name] = i; });
    this.stopAnchors = data.busStops.map((_, i) => this.stopA0 + i);
    this.dogRunAnchors = (data.dogParks || []).map((i) => this.placeA0 + i);
    this.hblrAnchors = ["hblr_term", "hblr_2nd", "hblr_9th"].map((id) => this.gate[id]);
    this.ferryAnchors = ["ferry_term", "ferry_14"].map((id) => this.gate[id]);

    // Building footprints, for placing people inside their home building.
    this.buildings = data.buildings;
  }

  World.prototype.placeOf = function (anchor) {
    return this.data.places[this.aRef[anchor]];
  };

  World.prototype.anchorName = function (anchor) {
    const kind = this.aKind[anchor];
    if (kind === ANCHOR_PLACE) {
      const p = this.placeOf(anchor);
      if (p[7] >= 0) return this.data.placeNames[p[7]];
      return placeGeneric(this.groups[p[2]]) + " on " + this.streetOf(anchor);
    }
    if (kind === ANCHOR_GATE) return this.data.gateways[this.aRef[anchor]].label;
    if (kind === ANCHOR_STOP) return "Bus stop on " + this.streetOf(anchor);
    if (kind === ANCHOR_DORM) return "Stevens residence hall";
    const street = this.data.homes[this.aRef[anchor]][7];
    return "Home on " + (street >= 0 ? this.data.graph.names[street] : this.streetOf(anchor));
  };

  World.prototype.streetOf = function (anchor) {
    const name = this.data.graph.names[this.ename[this.aEdge[anchor]]];
    return name || "a side street";
  };

  function placeGeneric(group) {
    return {
      food: "A restaurant", nightlife: "A bar", cafe: "A café", grocery: "A grocery", retail: "A shop",
      fitness: "A gym", health: "A clinic", school: "A school", university: "Stevens", civic: "A public office",
      worship: "A place of worship", park: "A park", office: "An office", personal: "A service business",
      hotel: "A hotel", arts: "A venue", transit: "Hoboken Terminal", parking: "A garage", landmark: "A landmark",
    }[group] || "A business";
  }

  World.prototype.walkTree = function (edge, t) {
    const bin = t < 1 / 3 ? 0 : t < 2 / 3 ? 1 : 2;
    const key = edge * 3 + bin;
    let tree = this.walkTrees.get(key);
    if (!tree) {
      const tc = (bin + 0.5) / 3;
      const L = this.elen[edge];
      tree = dijkstra(this.nN, this.walkAdj, this.elen, [[this.ea[edge], tc * L], [this.eb[edge], (1 - tc) * L]]);
      this.walkTrees.set(key, tree);
    }
    return tree;
  };

  World.prototype.carTree = function (node, towards) {
    const key = node * 2 + (towards ? 1 : 0);
    let tree = this.carTrees.get(key);
    if (!tree) {
      tree = dijkstra(this.nN, towards ? this.carRev : this.carFwd, this.elen, [[node, 0]]);
      this.carTrees.set(key, tree);
    }
    return tree;
  };

  /** Point at arc length s along edge e (measured from node a). */
  World.prototype.pointOnEdge = function (e, s, out) {
    const o = this.gOff[e];
    const end = this.gOff[e + 1] - 1;
    const gc = this.gc;
    if (s <= 0) {
      out.push(this.gx[o], this.gy[o]);
      return;
    }
    for (let j = o; j < end; j++) {
      if (s <= gc[j + 1]) {
        const f = (s - gc[j]) / (gc[j + 1] - gc[j] || 1);
        out.push(this.gx[j] + (this.gx[j + 1] - this.gx[j]) * f, this.gy[j] + (this.gy[j + 1] - this.gy[j]) * f);
        return;
      }
    }
    out.push(this.gx[end], this.gy[end]);
  };

  /** Append the part of edge e between fractions tFrom and tTo (either direction). */
  World.prototype.edgeSpan = function (e, tFrom, tTo, out) {
    const o = this.gOff[e];
    const end = this.gOff[e + 1] - 1;
    const L = this.gc[end];
    const s0 = tFrom * L;
    const s1 = tTo * L;
    this.pointOnEdge(e, s0, out);
    if (s1 > s0) {
      for (let j = o + 1; j < end; j++) if (this.gc[j] > s0 && this.gc[j] < s1) out.push(this.gx[j], this.gy[j]);
    } else {
      for (let j = end - 1; j > o; j--) if (this.gc[j] < s0 && this.gc[j] > s1) out.push(this.gx[j], this.gy[j]);
    }
    this.pointOnEdge(e, s1, out);
  };

  function makeRoute(pts) {
    const xs = [];
    const ys = [];
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i];
      const y = pts[i + 1];
      if (xs.length && Math.abs(x - xs[xs.length - 1]) < 0.05 && Math.abs(y - ys[ys.length - 1]) < 0.05) continue;
      xs.push(x);
      ys.push(y);
    }
    if (xs.length === 1) {
      xs.push(xs[0]);
      ys.push(ys[0]);
    }
    const c = new Float32Array(xs.length);
    for (let i = 1; i < xs.length; i++) c[i] = c[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    return { x: Float32Array.from(xs), y: Float32Array.from(ys), c, len: c[c.length - 1] };
  }

  /** Street route between two anchors on the pedestrian/bike graph. */
  World.prototype.walkRoute = function (from, to) {
    const pts = [this.aX[from], this.aY[from]];
    const e0 = this.aEdge[from];
    const t0 = this.aT[from];
    const e1 = this.aEdge[to];
    const t1 = this.aT[to];
    if (e0 === e1) {
      this.edgeSpan(e0, t0, t1, pts);
    } else {
      const tree = this.walkTree(e1, t1);
      const L0 = this.elen[e0];
      const viaA = t0 * L0 + tree.dist[this.ea[e0]];
      const viaB = (1 - t0) * L0 + tree.dist[this.eb[e0]];
      let n;
      if (viaA <= viaB) {
        this.edgeSpan(e0, t0, 0, pts);
        n = this.ea[e0];
      } else {
        this.edgeSpan(e0, t0, 1, pts);
        n = this.eb[e0];
      }
      for (let guard = 0; tree.pred[n] !== -1 && guard < 10000; guard++) {
        const e = tree.pred[n];
        if (this.ea[e] === n) {
          this.edgeSpan(e, 0, 1, pts);
          n = this.eb[e];
        } else {
          this.edgeSpan(e, 1, 0, pts);
          n = this.ea[e];
        }
      }
      this.edgeSpan(e1, n === this.ea[e1] ? 0 : 1, t1, pts);
    }
    pts.push(this.aX[to], this.aY[to]);
    return makeRoute(pts);
  };

  /** Driving route. One end must be a road gateway; one-way streets are respected. */
  World.prototype.carRoute = function (from, to) {
    const fromGate = this.aKind[from] === ANCHOR_GATE;
    const gateNode = fromGate ? this.aCar[from] : this.aCar[to];
    const other = fromGate ? to : from;
    let otherNode = this.aCar[other];
    if (otherNode < 0 || gateNode < 0) return this.walkRoute(from, to);
    const nodes = [];
    if (!fromGate) {
      const tree = this.carTree(gateNode, true);
      let n = otherNode;
      nodes.push(n);
      for (let guard = 0; tree.pred[n] !== -1 && guard < 10000; guard++) {
        const e = tree.pred[n];
        const m = this.ea[e] === n ? this.eb[e] : this.ea[e];
        nodes.push(e, m);
        n = m;
      }
    } else {
      const tree = this.carTree(gateNode, false);
      let n = otherNode;
      const back = [n];
      for (let guard = 0; tree.pred[n] !== -1 && guard < 10000; guard++) {
        const e = tree.pred[n];
        const m = this.ea[e] === n ? this.eb[e] : this.ea[e];
        back.push(e, m);
        n = m;
      }
      for (let i = back.length - 1; i >= 0; i--) nodes.push(back[i]);
    }
    const pts = [];
    if (!fromGate) pts.push(this.aX[from], this.aY[from]);
    pts.push(this.nx[nodes[0]], this.ny[nodes[0]]);
    for (let i = 1; i < nodes.length; i += 2) {
      const e = nodes[i];
      const prev = nodes[i - 1];
      this.edgeSpan(e, this.ea[e] === prev ? 0 : 1, this.ea[e] === prev ? 1 : 0, pts);
    }
    if (fromGate) pts.push(this.aX[to], this.aY[to]);
    return makeRoute(pts);
  };

  World.prototype.distance = function (a, b) {
    return Math.hypot(this.aX[a] - this.aX[b], this.aY[a] - this.aY[b]);
  };

  /** Travel-time estimate used when drafting plans; routes are drawn at the pace that meets it. */
  World.prototype.travelTime = function (a, b, mode, t) {
    const d = this.distance(a, b);
    if (mode === CAR) {
      const clock = (t / HOUR) % 24;
      const peak = (clock > 7 && clock < 9.5) || (clock > 16.5 && clock < 19);
      return 60 + (d * 1.45) / (peak ? 4.2 : 6.8);
    }
    if (mode === BIKE) return 30 + (d * 1.3) / 4.2;
    return 15 + (d * 1.3) / 1.3;
  };

  /** A random point inside a building footprint (falls back to its centroid). */
  World.prototype.spotInBuilding = function (b, rng, fallbackX, fallbackY) {
    const S = this.data.meta.scale;
    const ring = this.buildings[b] && this.buildings[b].p;
    if (!ring || ring.length < 6) return [fallbackX, fallbackY];
    if (!this.bbox) this.bbox = new Map();
    let box = this.bbox.get(b);
    if (!box) {
      box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ring.length; i += 2) {
        box[0] = Math.min(box[0], ring[i]);
        box[2] = Math.max(box[2], ring[i]);
        box[1] = Math.min(box[1], ring[i + 1]);
        box[3] = Math.max(box[3], ring[i + 1]);
      }
      this.bbox.set(b, box);
    }
    const [minX, minY, maxX, maxY] = box;
    for (let tries = 0; tries < 12; tries++) {
      const x = between(rng, minX, maxX);
      const y = between(rng, minY, maxY);
      if (pointInRing(x, y, ring)) return [x / S, y / S];
    }
    return [fallbackX, fallbackY];
  };

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i];
      const yi = ring[i + 1];
      const xj = ring[j];
      const yj = ring[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
    }
    return inside;
  }

  // ------------------------------------------------------------------ plans

  function Legs(capacity) {
    this.n = 0;
    this.alloc(capacity);
  }

  Legs.prototype.alloc = function (capacity) {
    const grow = (Old, arr) => {
      const next = new Old(capacity);
      if (arr) next.set(arr.subarray(0, this.n));
      return next;
    };
    this.kind = grow(Uint8Array, this.kind);
    this.mode = grow(Uint8Array, this.mode);
    this.act = grow(Uint8Array, this.act);
    this.t0 = grow(Float32Array, this.t0);
    this.t1 = grow(Float32Array, this.t1);
    this.a = grow(Int32Array, this.a);
    this.b = grow(Int32Array, this.b);
    this.info = grow(Int16Array, this.info);
    this.capacity = capacity;
  };

  Legs.prototype.push = function (kind, mode, act, t0, t1, a, b, info) {
    if (this.n === this.capacity) this.alloc(Math.ceil(this.capacity * 1.6));
    const i = this.n++;
    this.kind[i] = kind;
    this.mode[i] = mode;
    this.act[i] = act;
    this.t0[i] = t0;
    this.t1[i] = t1;
    this.a[i] = a;
    this.b[i] = b;
    this.info[i] = info;
    return i;
  };

  function Simulation(world, options, deferred) {
    this.world = world;
    this.options = Object.assign({ dayType: "weekday", seed: 20260922 }, options || {});
    if (!deferred) this.generate();
  }

  /** Build the whole day synchronously (tests, Node). The page steps build() instead. */
  Simulation.prototype.generate = function () {
    const steps = this.build();
    while (!steps.next().done);
  };

  Simulation.DAY_START = DAY_START;
  Simulation.DAY_END = DAY_END;

  /** Generator: yields progress (0..1) so the page can build the day between frames. */
  Simulation.prototype.build = function* () {
    const w = this.world;
    const cal = w.data.calibration;
    const obs = cal.observed;
    const asm = cal.assumptions;
    const opt = this.options;
    const weekend = opt.dayType === "weekend";
    const baseSeed = (opt.seed + (weekend ? 101 : 0)) >>> 0;
    // The city (households, jobs, dogs) is drawn from one stream; each person's day plan then
    // comes from their own stream, so changing one person's decision (Jev's, say) can't
    // reshuffle everyone planned after them.
    let rng = rngFrom(baseSeed);
    this.weekend = weekend;
    this.params = {
      residents: obs.residents.value,
      employed: obs.employedResidents.value,
      wfhShare: opt.wfhShare != null ? opt.wfhShare : obs.commuteModeShares.value.workedFromHome,
      inboundWorkers: opt.inboundWorkers != null ? opt.inboundWorkers
        : (weekend ? asm.inboundWorkersWeekend.value : asm.inboundWorkersWeekday.value),
      inboundStudents: weekend ? Math.round(asm.inboundStudentsWeekday.value * 0.1) : asm.inboundStudentsWeekday.value,
      visitors: opt.visitors != null ? opt.visitors : (weekend ? asm.visitorsWeekend.value : asm.visitorsWeekday.value),
      transfers: weekend ? Math.round(asm.njtRailTransfersWeekday.value * 0.25) : asm.njtRailTransfersWeekday.value,
    };

    const legs = (this.legs = new Legs(1 << 19));
    const agents = [];
    const events = (this.events = { t: [], dir: [], ch: [], gate: [], kind: [] });
    const transfers = (this.transferBoardings = new Float64Array(CHANNELS.length));
    const personStream = () => {
      rng = rngFrom((baseSeed ^ Math.imul(agents.length + 1, 0x9e3779b1)) >>> 0);
      topicsSeen = new Map();
    };

    // --- per-agent plan builder -------------------------------------------------
    let cur = null;
    function begin(agent, anchor, t, act) {
      agent.legStart = legs.n;
      cur = { agent, anchor, t, act };
    }
    function stayUntil(t) {
      if (t > cur.t) legs.push(STAY, 0, cur.act, cur.t, t, cur.anchor, cur.anchor, 0);
      cur.t = Math.max(cur.t, t);
    }
    function go(to, mode, dep, act) {
      if (dep < cur.t) dep = cur.t;
      stayUntil(dep);
      const dur = w.travelTime(cur.anchor, to, mode, dep);
      legs.push(TRIP, mode, act, dep, dep + dur, cur.anchor, to, 0);
      cur.anchor = to;
      cur.t = dep + dur;
      cur.act = act;
      return cur.t;
    }
    function event(t, dir, ch, gate) {
      if (t < DAY_START || t >= DAY_END) return;
      events.t.push(t);
      events.dir.push(dir);
      events.ch.push(ch);
      events.gate.push(gate);
      events.kind.push(cur.agent.kind);
    }
    /** Leave through a gateway at `dep`, be away until `back`, re-enter through `backGate`. */
    function away(gate, mode, ch, dep, back, region, backGate, backCh) {
      const arrive = go(gate, mode, dep, A.station);
      back = Math.max(back, arrive + 60);
      const reenter = backGate === undefined ? gate : backGate;
      const reCh = backCh === undefined ? ch : backCh;
      legs.push(AWAY, 0, A.away, arrive, Math.min(back, DAY_END), gate, reenter, region * 16 + ch);
      event(arrive, -1, ch, gate);
      event(back, +1, reCh, reenter);
      cur.anchor = reenter;
      cur.t = Math.min(back, DAY_END);
      cur.act = A.station;
      return cur.t;
    }
    function arriveFromOutside(agent, gate, ch, t) {
      agent.legStart = legs.n;
      legs.push(AWAY, 0, A.away, DAY_START, t, gate, gate, ch);
      cur = { agent, anchor: gate, t, act: A.station };
      event(t, +1, ch, gate);
    }
    function leaveForGood(gate, mode, ch, dep) {
      const arrive = go(gate, mode, dep, A.station);
      if (arrive < DAY_END) {
        legs.push(AWAY, 0, A.away, arrive, DAY_END, gate, gate, ch);
        event(arrive, -1, ch, gate);
      }
      cur.t = DAY_END;
    }
    function finish() {
      if (cur.t < DAY_END) legs.push(STAY, 0, cur.act, cur.t, DAY_END, cur.anchor, cur.anchor, 0);
      cur.agent.legEnd = legs.n;
      agents.push(cur.agent);
    }
    /** Visit a place and come back to where you were. */
    function outing(place, mode, dep, stay, act, backAct) {
      if (place < 0) return cur.t;
      const home = cur.anchor;
      const arrive = go(place, mode, dep, act);
      return go(home, mode, arrive + stay, backAct);
    }

    // --- decisions ---------------------------------------------------------------------
    // Every behavioural choice in the day goes through decide(): whether someone does
    // something, when, how they travel, where they go and how long they stay, for people,
    // their dogs and their cars. The rules sample calibrated weights. A decision source
    // (Jev's answers, written by jev/run-jev.mjs) overrides the sampled pick whenever its
    // answer is still one of the options. Who people are (age, household, job, dog), where
    // they live and work, school hours and street routes are not decisions: they come from
    // the Census, job counts, school timetables and the street graph.
    const source = opt.decisions || null;
    const recording = !!opt.recordDecisions;
    const recordFor = typeof opt.recordDecisions === "function" ? opt.recordDecisions : null;
    const tracking = recording || !!source;
    const log = (this.decisionLog = recording ? [] : null);
    const decided = (this.decisionStats = { points: 0, fromTable: 0 });
    const perPerson = (this.decisionsByPerson = tracking ? [] : null);
    let topicsSeen = new Map();

    /**
     * One decision; returns an index into `labels`. o.rule fixes the rule answer (otherwise it
     * is sampled from `weights`), o.anchors marks a choice between places, o.when is the clock.
     */
    function decide(topic, question, labels, weights, o) {
      let r = o.rule !== undefined ? o.rule : pick(rng, weights);
      if (!tracking || labels.length < 2) return r;
      const person = agents.length;
      const seen = topicsSeen.get(topic) || 0;
      topicsSeen.set(topic, seen + 1);
      const key = seen ? topic + "#" + seen : topic;
      const rule = r;
      let fromTable = false;
      if (source) {
        const a = source.answer(person, key, labels, o.anchors);
        if (a >= 0 && a < labels.length) {
          r = a;
          fromTable = true;
        }
      }
      decided.points++;
      const tally = perPerson[person] || (perPerson[person] = [0, 0]);
      tally[0]++;
      if (fromTable) {
        decided.fromTable++;
        tally[1]++;
      }
      if (log && (!recordFor || recordFor(person))) {
        let total = 0;
        for (const x of weights) total += x;
        log.push({
          person, key, topic, kind: o.kind || "choice", question: typeof question === "function" ? question() : question,
          clock: o.when !== undefined ? o.when : cur && cur.agent && !cur.agent.legEnd && cur.t > DAY_START ? cur.t : null,
          labels, texts: o.texts || null, anchors: o.anchors || null, from: o.from !== undefined ? o.from : null,
          prior: weights.map((x) => x / (total || 1)), rule, answer: r, fromTable,
        });
      }
      return r;
    }
    const YES_NO = ["yes", "no"];
    /** A yes/no decision that the rules take with probability p. */
    function yes(topic, question, p, when) {
      const rule = rng() < p ? 0 : 1;
      if (!tracking) return rule === 0;
      return decide(topic, question, YES_NO, [p, 1 - p], { rule, kind: "yesno", when }) === 0;
    }
    /** One of the keys of `table` ({key: weight}); keys without weight aren't offered. */
    function oneOf(topic, question, table, texts, when, ruleKey) {
      const keys = [];
      const weights = [];
      for (const k in table) {
        if (table[k] > 0) {
          keys.push(k);
          weights.push(table[k]);
        }
      }
      const fixed = ruleKey === undefined ? -1 : keys.indexOf(String(ruleKey));
      const rule = fixed >= 0 ? fixed : undefined;
      if (!tracking) return keys[rule !== undefined ? rule : pick(rng, weights)];
      return keys[decide(topic, question, keys, weights, { rule, when, texts: keys.map((k) => (texts && texts[k]) || k) })];
    }
    function hourText(h) {
      const hh = h % 24;
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      return h12 + ":00–" + h12 + ":59 " + (hh < 12 ? "am" : "pm") + (h >= 24 ? " (after midnight)" : "");
    }
    /** A clock time from [[hour, weight], ...]: the hour is the decision, the minute within it isn't. */
    function hourOf(topic, question, table, when) {
      const weights = table.map((r) => r[1]);
      const i = tracking
        ? decide(topic, question, table.map((r) => "h" + r[0]), weights, { kind: "time", when, texts: table.map((r) => hourText(r[0])) })
        : pick(rng, weights);
      return (table[i][0] + rng()) * HOUR;
    }
    const LENGTHS = ["short", "medium", "long"];
    const EVEN3 = [1, 1, 1];
    function thirds(a, b, unit) {
      const f = (v) => (unit === "h" ? Math.round(v * 2) / 2 + " h" : Math.round(v) + " min");
      const s = (b - a) / 3;
      return [0, 1, 2].map((i) => "about " + f(a + i * s) + " to " + f(a + (i + 1) * s));
    }
    /** A length of time between a and b ("min" or "h") as short, medium or long; returns seconds. */
    function howLong(topic, question, a, b, unit, when) {
      const i = tracking ? decide(topic, question, LENGTHS, EVEN3, { kind: "length", when, texts: thirds(a, b, unit) }) : pick(rng, EVEN3);
      const v = a + ((i + rng()) * (b - a)) / 3;
      return unit === "h" ? v * HOUR : v * 60;
    }

    // --- place choice ---------------------------------------------------------------
    const G = w.G;
    const groupWeights = {};
    function weighted(group, by) {
      const key = group + ":" + by;
      if (!groupWeights[key]) {
        const ids = w.byGroup[G[group]];
        const ws = ids.map((a) => {
          const p = w.placeOf(a);
          return by === "jobs" ? p[5] : p[6];
        });
        groupWeights[key] = { ids, ws };
      }
      return groupWeights[key];
    }
    /** A venue of `group`, favouring ones near `from` (distance decay `scale` metres). */
    function nearby(topic, group, from, scale, question, when) {
      const { ids, ws } = weighted(group, "visit");
      return choose(topic, group, ids, ws, from, scale, question, when);
    }
    const SPOTS = { run: 0.6, park: 0.4 };
    const SPOT_TEXT = { run: "one of Hoboken's dog runs", park: "a park or the waterfront" };
    /** A dog run near `from`, or a stretch of park or waterfront. */
    function dogSpot(topic, from, when) {
      const runs = w.dogRunAnchors;
      const kind = runs.length ? oneOf(topic + ".spot", "Where does this person take the dog?", SPOTS, SPOT_TEXT, when) : "park";
      if (kind === "run") return choose(topic + ".place", "dogrun", runs, null, from, 350, "Which dog run do they take the dog to?", when);
      return nearby(topic + ".place", "park", from, 400, "Which park or stretch of waterfront do they walk the dog in?", when);
    }
    // Distance-weighted pools cached per 150 m cell; the eight likeliest options per pool too.
    const TOP = 8;
    const poolCache = new Map();
    const topCache = new Map();
    function choose(topic, poolKey, ids, ws, from, scale, question, when) {
      if (!ids.length) return -1;
      const cx = Math.floor(w.aX[from] / 150);
      const cy = Math.floor(w.aY[from] / 150);
      const key = poolKey + "|" + scale + "|" + cx + "|" + cy;
      let cum = poolCache.get(key);
      if (!cum) {
        const x = (cx + 0.5) * 150;
        const y = (cy + 0.5) * 150;
        cum = new Float64Array(ids.length);
        let s = 0;
        for (let i = 0; i < ids.length; i++) {
          s += ((ws && ws[i]) || (ws ? 0.2 : 1)) * Math.exp(-Math.hypot(w.aX[ids[i]] - x, w.aY[ids[i]] - y) / scale);
          cum[i] = s;
        }
        poolCache.set(key, cum);
      }
      const r = rng() * cum[cum.length - 1];
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      const sampled = ids[lo];
      if (!tracking) return sampled;
      let top = topCache.get(key);
      if (!top) {
        const scored = [];
        for (let i = 0; i < ids.length; i++) scored.push([cum[i] - (i ? cum[i - 1] : 0), ids[i]]);
        scored.sort((a, b) => b[0] - a[0]);
        top = scored.slice(0, TOP);
        topCache.set(key, top);
      }
      const options = top.map((s) => s[1]);
      const weights = top.map((s) => s[0]);
      if (options.indexOf(sampled) < 0) {
        options[options.length - 1] = sampled;
        weights[weights.length - 1] = cum[lo] - (lo ? cum[lo - 1] : 0);
      }
      const i = decide(topic, question, options.map((a) => "p" + a), weights,
        { kind: "place", rule: options.indexOf(sampled), anchors: options, from, when });
      return options[i];
    }
    /** One of the few stations or garages nearest `from`; the rules take the nearest. */
    function closeBy(topic, question, anchors, from, when, n) {
      const ranked = anchors.map((a) => [w.distance(a, from), a]).sort((x, y) => x[0] - y[0]).slice(0, n);
      if (!tracking) return ranked[0][1];
      const options = ranked.map((r) => r[1]);
      const i = decide(topic, question, options.map((a) => "p" + a), ranked.map((r) => Math.exp(-r[0] / 400)),
        { kind: "place", rule: 0, anchors: options, from, when });
      return options[i];
    }
    function nearest(anchors, from) {
      let best = anchors[0];
      let bd = Infinity;
      for (const a of anchors) {
        const d = w.distance(a, from);
        if (d < bd) {
          bd = d;
          best = a;
        }
      }
      return best;
    }
    // Workplaces weighted by jobs (weekends shift toward venues that open on Saturdays).
    const WEEKEND_OPEN = { food: 1.2, nightlife: 1.2, cafe: 1.1, grocery: 1.1, retail: 1, fitness: 0.9, personal: 0.8,
      hotel: 1, park: 1, arts: 1, landmark: 1, transit: 1, parking: 1, health: 0.3, office: 0.08, civic: 0.1,
      school: 0.03, university: 0.2, worship: 0.5 };
    const jobIds = [];
    const jobWs = [];
    w.groups.forEach((gname, gi) => {
      for (const a of w.byGroup[gi]) {
        const jobs = w.placeOf(a)[5];
        if (jobs > 0) {
          jobIds.push(a);
          jobWs.push(jobs * (weekend ? WEEKEND_OPEN[gname] || 0.5 : 1));
        }
      }
    });
    function workplace() {
      return jobIds[pick(rng, jobWs)];
    }
    const campus = weighted("university", "jobs");
    function classroom() {
      return campus.ids.length ? campus.ids[pick(rng, campus.ws.map((x) => x + 5))] : workplace();
    }
    const schools = weighted("school", "jobs");
    function school() {
      return schools.ids[pick(rng, schools.ws.map((x) => x + 2))];
    }

    // --- words for the questions ------------------------------------------------------
    const MODE_TEXT = { path: "the PATH train", bus: "an NJ Transit bus", ferry: "the NY Waterway ferry",
      hblr: "the Hudson-Bergen Light Rail", njtRail: "an NJ Transit train", drive: "drives", car: "drives",
      walk: "walks", bike: "cycles", taxi: "a taxi or rideshare" };
    const REGION_TEXT = { [R.midtown]: "Midtown Manhattan", [R.lower]: "Lower Manhattan", [R.jc]: "Jersey City",
      [R.newark]: "Newark or western New Jersey", [R.nj]: "elsewhere in New Jersey", [R.bkq]: "Brooklyn or Queens",
      [R.hoboken]: "Hoboken itself" };
    const KIND_TEXT = { food: "a restaurant", nightlife: "a bar", cafe: "a café", park: "a park", retail: "the shops",
      arts: "a museum, gallery or show", health: "a doctor or dentist", grocery: "a grocery store",
      personal: "a salon, cleaner or other service", fitness: "a gym" };
    const GATE_TEXT = {};
    w.data.gateways.forEach((gw) => { GATE_TEXT[gw.id] = gw.label; });
    const HOW_TEXT = { walk: "walk", bike: "cycle" };
    const WALK_OR_BIKE = { walk: 0.92, bike: 0.08 };

    const gateIds = w.gate;
    const CAR_GATES = {
      [R.midtown]: { road_n: 0.7, road_s: 0.3 }, [R.lower]: { road_s: 0.9, road_n: 0.1 },
      [R.jc]: { road_s: 0.5, road_w: 0.3, road_nw: 0.2 }, [R.newark]: { road_s: 0.5, road_w: 0.4, road_nw: 0.1 },
      [R.nj]: { road_nw: 0.4, road_n: 0.25, road_w: 0.2, road_s: 0.15 }, [R.bkq]: { road_s: 0.6, road_n: 0.4 },
      [R.hoboken]: { road_s: 0.25, road_n: 0.25, road_w: 0.25, road_nw: 0.25 },
    };
    const FOOT_GATES = { road_s: 0.3, walk_s: 0.3, road_w: 0.2, road_nw: 0.08, road_n: 0.07, walk_n: 0.05 };
    /** Gateway anchor for crossing the city line by `ch` near anchor `from`. */
    function gateFor(ch, from, region, topic, when) {
      switch (ch) {
        case CH.path: return gateIds.path;
        case CH.njtRail: return gateIds.njt;
        case CH.hblr: return closeBy(topic, "Which light rail station does this person use?", w.hblrAnchors, from, when, 3);
        case CH.ferry:
          return region === R.lower ? gateIds.ferry_term : closeBy(topic, "Which ferry terminal does this person use?", w.ferryAnchors, from, when, 2);
        case CH.bus: return nearest(w.stopAnchors, from);
        case CH.car:
          return gateIds[oneOf(topic, "Which road does this person drive in or out of Hoboken on?", CAR_GATES[region] || CAR_GATES[R.nj], GATE_TEXT, when)];
        default:
          return gateIds[oneOf(topic, "Which way does this person walk or cycle across the city line?", FOOT_GATES, GATE_TEXT, when)];
      }
    }
    const MAP_MODE = [WALK, WALK, WALK, WALK, WALK, CAR, BIKE, WALK];
    const parking = w.byGroup[G.parking];
    function garageNear(topic, anchor, when) {
      return parking.length ? closeBy(topic, "Which garage does this person park in?", parking, anchor, when, 4) : anchor;
    }

    // --- residents -------------------------------------------------------------------
    const hhShares = asm.householdSizeShares.value;
    const dormTotal = w.data.dorms.reduce((s, d) => s + d[4], 0);
    const householdPersons = this.params.residents - dormTotal;
    const households = [];
    w.data.homes.forEach((h, i) => {
      for (let j = 0; j < h[4]; j++) households.push({ home: w.homeA0 + i, size: 1 + pick(rng, [1, 2, 3, 4, 5].map((s) => hhShares[s])) });
    });
    let total = households.reduce((s, h) => s + h.size, 0);
    while (total < householdPersons) {
      const h = households[Math.floor(rng() * households.length)];
      if (h.size < 5) { h.size++; total++; }
    }
    while (total > householdPersons) {
      const h = households[Math.floor(rng() * households.length)];
      if (h.size > 1) { h.size--; total--; }
    }

    // Ages. Children and parents are drawn first; every other adult is then drawn from what is
    // left of the ACS age targets (dorm residents included), so the whole population matches
    // the published age mix instead of stacking parents on top of it.
    const ageShares = obs.ageShares.value;
    function kidAge() {
      const r = rng();
      return r < 0.51 ? Math.floor(rng() * 5) : r < 0.93 ? 5 + Math.floor(rng() * 10) : 15 + Math.floor(rng() * 3);
    }
    const BRACKETS = [[18, 24], [25, 34], [35, 44], [45, 64], [65, 90]];
    const bracketOf = (age) => (age <= 24 ? 0 : age <= 34 ? 1 : age <= 44 ? 2 : age <= 64 ? 3 : 4);
    const residents = [];
    const others = [];
    const taken = new Float64Array(BRACKETS.length);
    taken[0] += dormTotal; // Stevens residence halls: all 18-22
    let teens = 0;
    for (const h of households) {
      let kids = 0;
      if (h.size === 2 && rng() < 0.06) kids = 1;
      else if (h.size === 3 && rng() < 0.53) kids = 1;
      else if (h.size === 4 && rng() < 0.62) kids = 2;
      else if (h.size === 5) kids = rng() < 0.7 ? 3 : 2;
      const hb = w.data.homes[w.aRef[h.home]][5];
      const members = [];
      for (let m = 0; m < h.size; m++) {
        const isKid = m >= h.size - kids;
        let age = -1;
        if (isKid) {
          age = kidAge();
          if (age >= 15) teens++;
        } else if (kids) {
          age = Math.max(21, Math.min(62, Math.round(38 + 5 * gauss(rng))));
          taken[bracketOf(age)]++;
        }
        const spot = w.spotInBuilding(hb, rng, w.aX[h.home], w.aY[h.home]);
        const person = { kind: RESIDENT, age, home: h.home, hx: spot[0], hy: spot[1],
          household: members, hhSize: h.size, kids, child: isKid, parent: !isKid && kids > 0 };
        if (age < 0) others.push(person);
        members.push(person);
        residents.push(person);
      }
    }
    const pop = this.params.residents;
    const left = [
      ageShares["15-24"] * pop - teens,
      ageShares["25-44"] * 0.63 * pop, // 25-34 vs 35-44 split of the ACS 25-44 group: assumption
      ageShares["25-44"] * 0.37 * pop,
      ageShares["45-64"] * pop,
      ageShares["65+"] * pop,
    ].map((target, b) => Math.max(0, target - taken[b]));
    for (const person of others) {
      const b = pick(rng, left.some((v) => v > 0) ? left : [1, 3, 2, 2, 1]);
      left[b] = Math.max(0, left[b] - 1);
      person.age = Math.floor(between(rng, BRACKETS[b][0], BRACKETS[b][1] + 1));
    }
    // Employment: exactly the ACS count, weighted by age.
    const adults = residents.filter((p) => !p.child && p.age >= 18);
    const empWeight = (p) => {
      const a = p.age;
      let wgt = a < 22 ? 0.35 : a < 25 ? 0.75 : a < 35 ? 0.93 : a < 45 ? 0.9 : a < 55 ? 0.88 : a < 65 ? 0.75 : a < 70 ? 0.35 : 0.1;
      if (p.parent && p.household.some((q) => q.child && q.age < 5)) wgt *= 0.8;
      return wgt;
    };
    adults.map((p) => ({ p, k: Math.pow(rng(), 1 / empWeight(p)) }))
      .sort((x, y) => y.k - x.k)
      .slice(0, Math.min(this.params.employed, adults.length))
      .forEach(({ p }) => { p.worker = true; });
    const workers = adults.filter((p) => p.worker);
    // The rules' work-from-home split is exact; Jev decides each worker's day on its own.
    const wfhCount = Math.round(this.params.wfhShare * workers.length);
    workers.map((p) => ({ p, k: rng() })).sort((x, y) => x.k - y.k).slice(0, wfhCount).forEach(({ p }) => { p.wfh = true; });
    // Stevens graduate students living in Hoboken (not in dorms).
    adults.filter((p) => p.age >= 22 && p.age <= 30).map((p) => ({ p, k: rng() })).sort((x, y) => x.k - y.k)
      .slice(0, 1200).forEach(({ p }) => { p.gradStudent = true; });

    // Commute modes (ACS shares renormalised over people who do commute). Every worker gets one,
    // so a worker who goes in on a day the rules would have them home still has a way there.
    const ms = obs.commuteModeShares.value;
    const rest = asm.residualCommuteModeShares.value;
    const commuteShares = { transit: ms.transit, drive: ms.droveAlone, walk: rest.walked, carpool: rest.carpool,
      bike: rest.bicycle, taxi: rest.taxiOther };
    const sub = asm.residentTransitSubmodes.value;
    const subTotal = sub.path + sub.busToNYC + sub.ferry + sub.hblr + sub.njtRail;
    const COMMUTE = {
      path: (ms.transit * sub.path) / subTotal, bus: (ms.transit * sub.busToNYC) / subTotal,
      ferry: (ms.transit * sub.ferry) / subTotal, hblr: (ms.transit * sub.hblr) / subTotal,
      njtRail: (ms.transit * sub.njtRail) / subTotal, drive: ms.droveAlone + rest.carpool,
      walk: rest.walked, bike: rest.bicycle, taxi: rest.taxiOther,
    };
    const REGION_BY = {
      path: { [R.midtown]: 0.45, [R.lower]: 0.35, [R.jc]: 0.12, [R.newark]: 0.05, [R.bkq]: 0.03 },
      bus: { [R.midtown]: 1 },
      ferry: { [R.midtown]: 0.5, [R.lower]: 0.5 },
      hblr: { [R.jc]: 0.85, [R.nj]: 0.15 },
      njtRail: { [R.newark]: 0.5, [R.nj]: 0.5 },
      drive: { [R.nj]: 0.55, [R.jc]: 0.15, [R.newark]: 0.1, [R.midtown]: 0.12, [R.lower]: 0.03, [R.bkq]: 0.05 },
      taxi: { [R.midtown]: 0.4, [R.lower]: 0.2, [R.jc]: 0.2, [R.nj]: 0.2 },
      walk: { [R.hoboken]: 0.85, [R.jc]: 0.15 },
      bike: { [R.hoboken]: 0.6, [R.jc]: 0.4 },
    };
    const CH_OF = { path: CH.path, bus: CH.bus, ferry: CH.ferry, hblr: CH.hblr, njtRail: CH.njtRail, drive: CH.car, car: CH.car,
      taxi: CH.car, walk: CH.walk, bike: CH.bike };
    const COMMUTE_DEPART = [[5, 2], [6, 8], [7, 24], [8, 34], [9, 20], [10, 7], [11, 2], [12, 0.6], [13, 0.6],
      [14, 0.8], [15, 0.8], [16, 0.5], [17, 0.3], [18, 0.4], [19, 0.3], [20, 0.2]];
    for (const p of workers) {
      const m = pickKey(rng, commuteShares);
      let key = m;
      if (m === "transit") key = pickKey(rng, { path: sub.path, bus: sub.busToNYC, ferry: sub.ferry, hblr: sub.hblr, njtRail: sub.njtRail });
      if (m === "carpool") key = "drive";
      p.commute = key;
      p.region = Number(pickKey(rng, REGION_BY[key]));
      if (p.region === R.hoboken) p.work = workplace();
    }
    // Length of a working day from leaving home to getting back, in bands.
    const DAY_BANDS = [[6.5, 7.5], [7.5, 8.5], [8.5, 9.5], [9.5, 10.5], [10.5, 12]];
    const DAY_LABELS = ["h6.5", "h7.5", "h8.5", "h9.5", "h10.5"];
    const DAY_TEXT = DAY_BANDS.map(([a, b]) => a + " to " + b + " hours");
    const DAY_USUAL = [0.012, 0.147, 0.44, 0.334, 0.067];
    const DAY_LATE = [0.1, 0.8, 0.1, 0, 0];
    function workingDay(dep) {
      const prior = dep >= 11 * HOUR ? DAY_LATE : DAY_USUAL;
      const i = tracking
        ? decide("work.hours", "How long is this person away at work today, door to door?", DAY_LABELS, prior,
          { kind: "length", when: dep, texts: DAY_TEXT })
        : pick(rng, prior);
      return DAY_BANDS[i][0] + (DAY_BANDS[i][1] - DAY_BANDS[i][0]) * rng();
    }

    // Dogs: a share of households keep one, walked by whoever is home in the daytime if anyone is.
    const dogShare = opt.dogShare != null ? opt.dogShare : asm.householdsWithDog ? asm.householdsWithDog.value : 0;
    const counted = new Set();
    let dogs = 0;
    for (const p of residents) {
      if (counted.has(p.household)) continue;
      counted.add(p.household);
      if (rng() >= dogShare) continue;
      const grownUps = p.household.filter((q) => !q.child);
      if (!grownUps.length) continue;
      (grownUps.find((q) => !q.worker || q.wfh) || grownUps[0]).dog = true;
      dogs++;
    }
    this.dogs = dogs;
    /** Out and back from home with the dog: a dog run or a stretch of park, then home. */
    const dogWalk = (p, slot, dep, maxStay) => {
      if (!p.dog || dep > DAY_END - HOUR) return;
      const spot = dogSpot("dog." + slot, p.home, dep);
      if (spot < 0) return;
      const arrive = go(spot, WALK, dep, A.dogwalk);
      go(p.home, WALK, arrive + howLong("dog." + slot + ".len", "How long do they stay out with the dog?", 3, maxStay, "min", arrive), A.dogwalk);
      cur.act = A.home;
    };
    /** A dog walk in one of the hours of `table`, no earlier than `earliest`. */
    const dogWalkAt = (p, slot, table, earliest, maxStay, question) => {
      if (!p.dog) return;
      dogWalk(p, slot, Math.max(earliest, hourOf("dog." + slot + ".when", question, table)), maxStay);
    };

    // School runs are decided first so the adult who walks a child can match the child's times.
    if (!weekend) {
      for (const p of residents) {
        if (!p.child || p.age < 5) continue;
        p.school = school();
        p.schoolDep = between(rng, 7.4, 8.2) * HOUR - (p.age >= 11 ? minutes(15) : 0);
        p.pickup = between(rng, 14.9, 15.6) * HOUR + (rng() < 0.3 ? between(rng, 1.5, 3) * HOUR : 0);
        if (p.age < 11) {
          const escort = p.household.find((q) => !q.child && (!q.worker || q.wfh) && !q.escorting);
          if (escort) escort.escorting = { school: p.school, dep: p.schoolDep, pickup: p.pickup };
        }
      }
    }

    // --- resident day plans ----------------------------------------------------------
    const eveningOut = (p, earliest, chance) => {
      if (!yes("eve.go", "Does this person go out this evening?", chance, earliest)) return;
      const late = p.age < 40 && yes("eve.late", "Is it a late night out, heading out after 8 pm?", 0.45, earliest);
      const dep = Math.max(earliest + minutes(20), late
        ? hourOf("eve.when", "When do they head out for the night?", [[20, 3], [21, 4], [22, 3]], earliest)
        : hourOf("eve.when", "When do they head out for the evening?", [[18, 3], [19, 5], [20, 3]], earliest));
      if (dep > DAY_END - HOUR) return;
      const group = late ? "nightlife" : oneOf("eve.kind", "Dinner or drinks?", { food: 0.7, nightlife: 0.3 }, KIND_TEXT, dep);
      const place = nearby("eve.place", group, cur.anchor, 700,
        late ? "Which bar do they go to?" : group === "food" ? "Which restaurant do they go to for dinner?" : "Which bar do they go to?", dep);
      if (place < 0) return;
      const arrive = go(place, WALK, dep, late || group === "nightlife" ? A.drinks : A.eat);
      let t = arrive + howLong("eve.len", "How long do they stay at that first place tonight?", 70, late ? 200 : 140, "min", arrive);
      if (late && yes("eve.more", "Do they move on to another bar?", 0.35, t)) {
        const next = nearby("eve.more.place", "nightlife", place, 250, "Which bar do they move on to?", t);
        t = go(next, WALK, t, A.drinks) + howLong("eve.more.len", "How long do they stay at the second bar?", 45, 120, "min", t);
      }
      go(p.home, WALK, Math.min(t, DAY_END - minutes(20)), A.home);
    };
    const ERRAND_TEXT = {
      gym: "work out at a gym", coffee: "go out for coffee", doctor: "see a doctor or dentist", lunch: "go out for lunch",
      park: "spend time in a park", shop: "go grocery shopping or run an errand", meal: "go out for a meal",
      retail: "go shopping", groceries: "buy groceries", evening: "stop for groceries on the way home",
    };
    const ERRAND_TO = {
      gym: "to the gym", coffee: "for coffee", doctor: "to the doctor", lunch: "for lunch", park: "to the park",
      shop: "on their errand", meal: "out to eat", retail: "shopping", groceries: "for groceries", evening: "for groceries",
    };
    const ERRAND_AT = {
      gym: "at the gym", coffee: "over coffee", doctor: "at the doctor's", lunch: "at lunch", park: "in the park",
      shop: "on the errand", meal: "at the meal", retail: "shopping", groceries: "buying groceries", evening: "buying groceries",
    };
    /** Maybe go out from home for `name`: whether, when, where, on foot or by bike, and for how long. */
    const errands = (p, name, window, chance, group, act, stayMin, stayMax, scale) => {
      const topic = "errand." + name;
      if (!yes(topic, "Does this person " + ERRAND_TEXT[name] + " today?", chance)) return;
      const dep = Math.max(cur.t + minutes(5), hourOf(topic + ".when", "When do they go " + ERRAND_TO[name] + "?", window));
      if (dep > DAY_END - HOUR) return;
      const g = typeof group === "string" ? group : oneOf(topic + ".kind", "What kind of place do they go to " + ERRAND_TO[name] + "?", group, KIND_TEXT, dep);
      const place = nearby(topic + ".place", g, p.home, scale || 600, () => "Which " + (KIND_TEXT[g] || g).replace(/^(a|an|the) /, "") + " do they go to?", dep);
      if (place < 0) return;
      const mode = oneOf(topic + ".how", "Do they walk or cycle " + ERRAND_TO[name] + "?", WALK_OR_BIKE, HOW_TEXT, dep) === "bike" ? BIKE : WALK;
      const stay = howLong(topic + ".len", "How long do they spend " + ERRAND_AT[name] + "?", stayMin, stayMax, "min", dep);
      outing(place, mode, dep, stay, typeof act === "number" ? act : act[g], A.home);
    };
    const TRIP_HOW = { path: 55, ferry: 10, njtRail: 5, bus: 10, hblr: 5, car: 15 };
    const nycTrip = (p, chance) => {
      if (!yes("trip.go", "Does this person leave Hoboken for part of the day (Manhattan, errands, visiting)?", chance)) return;
      const how = oneOf("trip.how", "How do they travel out of Hoboken for this trip?", TRIP_HOW, MODE_TEXT);
      const channel = CH_OF[how];
      const region = channel === CH.hblr ? R.jc : channel === CH.njtRail ? R.nj : channel === CH.car ? R.nj
        : Number(oneOf("trip.where", "Which part of Manhattan are they going to?", { [R.midtown]: 0.6, [R.lower]: 0.4 }, REGION_TEXT));
      const dep = Math.max(cur.t + minutes(10),
        hourOf("trip.when", "When do they leave Hoboken for this trip?", [[10, 3], [11, 4], [12, 4], [13, 3], [14, 2], [15, 2], [17, 2], [19, 2]]));
      if (dep > DAY_END - 2 * HOUR) return;
      const back = dep + howLong("trip.len", "How long are they away?", 3, 7, "h", dep);
      const gate = gateFor(channel, p.home, region, "trip.gate", dep);
      away(gate, MAP_MODE[channel], channel, dep, back, region);
      go(p.home, MAP_MODE[channel], cur.t, A.home);
    };
    const WFH_Q = "Is this person working from home today? (About " + Math.round(100 * this.params.wfhShare) +
      "% of employed Hoboken residents work from home.)";
    const MODE_Q = "How does this person get to work? (ACS: " + Math.round(100 * ms.transit) + "% of Hoboken workers take transit, " +
      Math.round(100 * ms.droveAlone) + "% drive alone.)";

    yield 0.1;
    let done = 0;
    for (const p of residents) {
      if (++done % 4000 === 0) yield 0.1 + 0.6 * (done / residents.length);
      personStream();
      begin(p, p.home, DAY_START, A.home);
      const kid = p.child;
      if (kid) {
        if (p.school !== undefined) {
          const arrive = go(p.school, WALK, p.schoolDep, A.school);
          go(p.home, WALK, Math.max(arrive + HOUR, p.pickup), A.home);
          eveningOut(p, cur.t, 0.08);
        } else if (p.age < 5 && !weekend && yes("daycare.go", "Does this child go to daycare today?", 0.45)) {
          const care = school();
          const t = go(care, WALK, hourOf("daycare.drop", "When is daycare drop-off?", [[8, 5], [9, 2]]), A.daycare);
          go(p.home, WALK, Math.max(t + 4 * HOUR, hourOf("daycare.pickup", "When is daycare pick-up?", [[16, 2], [17, 5], [18, 2]])), A.home);
        } else {
          errands(p, "park", [[10, 3], [11, 2], [15, 2], [16, 3]], 0.45, "park", A.park, 40, 100, 500);
          if (weekend) errands(p, "meal", [[11, 3], [12, 2]], 0.3, "food", A.eat, 50, 80, 600);
        }
        finish();
        continue;
      }

      // Whether they work today, from home or not, and how they get there.
      let works = !!p.worker;
      if (works && weekend) {
        works = yes("work.today", "It's Saturday. Is this person working today?", 0.18);
        if (!works) p.offToday = true;
      }
      if (works) {
        p.wfh = decide("work.wfh", WFH_Q, YES_NO, [this.params.wfhShare, 1 - this.params.wfhShare], { rule: p.wfh ? 0 : 1, kind: "yesno" }) === 0;
        if (!p.wfh) {
          p.commute = oneOf("work.mode", MODE_Q, COMMUTE, MODE_TEXT, undefined, p.commute);
          p.region = Number(oneOf("work.where", "Where is this person's job?", REGION_BY[p.commute], REGION_TEXT, undefined, p.region));
          if (p.region === R.hoboken && p.work === undefined) p.work = workplace();
          p.ch = CH_OF[p.commute];
        }
      }
      if (!works || p.wfh) {
        p.ch = undefined;
        p.region = undefined;
      }

      if (!weekend && p.gradStudent && !works) {
        dogWalkAt(p, "am", [[7, 3], [8, 2]], 0, 15, "When does this person take the dog out in the morning?");
        const how = oneOf("class.how", "Do they walk or cycle to campus?", { walk: 0.85, bike: 0.15 }, HOW_TEXT);
        const c = go(classroom(), how === "bike" ? BIKE : WALK, hourOf("class.when", "When do they head to campus?", [[9, 3], [10, 4], [11, 2]]), A.class);
        const at = Math.max(c + HOUR, hourOf("lunch.when", "When do they have lunch?", [[12, 3], [13, 2]]));
        const kind = oneOf("lunch.kind", "Lunch at a restaurant or a café?", { food: 0.6, cafe: 0.4 }, KIND_TEXT, at);
        const lunch = nearby("lunch.place", kind, cur.anchor, 300, "Where do they get lunch between classes?", at);
        let t = go(lunch, WALK, at, A.eat) + minutes(40);
        t = go(classroom(), WALK, t, A.class);
        t += howLong("class.len", "How long do they spend on campus in the afternoon?", 2, 4, "h", t);
        go(p.home, WALK, t, A.home);
        dogWalkAt(p, "pm", [[18, 3], [19, 3], [20, 2]], cur.t + minutes(15), 20, "When does this person walk the dog in the evening?");
        eveningOut(p, cur.t, 0.3);
        finish();
        continue;
      }

      if (works && !p.wfh) {
        const dep = weekend
          ? hourOf("work.leave", "When does this person leave for work?", [[7, 3], [8, 4], [9, 4], [10, 3], [11, 2], [15, 1], [16, 1]])
          : hourOf("work.leave", "When does this person leave for work?", COMMUTE_DEPART);
        const shift = workingDay(dep);
        if (p.dog) dogWalk(p, "am", dep - minutes(between(rng, 50, 75)), 12);
        if (!weekend && dep > 7 * HOUR && yes("am.gym", "Does this person go to the gym before work?", 0.1, dep - minutes(85))) {
          const gym = nearby("am.gym.place", "fitness", p.home, 600, "Which gym do they go to before work?", dep - minutes(85));
          if (gym >= 0) outing(gym, WALK, dep - minutes(85), minutes(55), A.gym, A.home);
        }
        const coffee = p.ch !== CH.car && yes("am.coffee", "Does this person stop for coffee on the way to work?", 0.18, dep - minutes(10))
          ? nearby("am.coffee.place", "cafe", p.home, 350, "Which café do they stop at on the way to work?", dep - minutes(10)) : -1;
        if (coffee >= 0) go(coffee, WALK, dep - minutes(10), A.coffee);
        if (p.region === R.hoboken && p.work >= 0 && p.work !== undefined) {
          const mode = p.ch === CH.bike ? BIKE : p.ch === CH.car ? CAR : WALK;
          const t = go(p.work, mode === CAR ? WALK : mode, dep, A.work);
          const lunchT = t + between(rng, 3, 4.5) * HOUR;
          let end = t + shift * HOUR;
          if (lunchT < end - HOUR && yes("lunch.go", "Does this person go out for lunch near work?", 0.35, lunchT)) {
            const kind = oneOf("lunch.kind", "Lunch at a restaurant or a café?", { food: 0.7, cafe: 0.3 }, KIND_TEXT, lunchT);
            const lunch = nearby("lunch.place", kind, p.work, 300, "Where do they get lunch near work?", lunchT);
            if (lunch >= 0) {
              end = Math.max(end, go(lunch, WALK, lunchT, A.eat) + minutes(35));
              go(p.work, WALK, cur.t + minutes(35), A.work);
            }
          }
          go(p.home, mode === CAR ? WALK : mode, end, A.home);
        } else {
          const gate = gateFor(p.ch, p.home, p.region, "work.gate", dep);
          away(gate, MAP_MODE[p.ch], p.ch, dep, dep + shift * HOUR, p.region);
          go(p.home, MAP_MODE[p.ch], cur.t, A.home);
        }
        if (p.dog) dogWalk(p, "pm", cur.t + minutes(between(rng, 10, 40)), 20);
        errands(p, "evening", [[18, 3], [19, 4], [20, 2]], 0.18, "grocery", A.groceries, 15, 35, 500);
        eveningOut(p, cur.t, weekend ? 0.3 : 0.16);
        finish();
        continue;
      }

      // At home most of the day: people who work from home, don't work, or are off today.
      dogWalkAt(p, "am", weekend ? [[7, 2], [8, 4], [9, 3]] : [[6, 3], [7, 4]], 0, weekend ? 35 : 15,
        "When does this person take the dog out in the morning?");
      if (p.escorting && !weekend) {
        const t = go(p.escorting.school, WALK, p.escorting.dep, A.school);
        go(p.home, WALK, t + minutes(6), A.home);
      }
      if (!weekend) {
        errands(p, "gym", [[6, 2], [7, 3], [17, 3], [18, 2]], p.age < 60 ? 0.14 : 0.05, "fitness", A.gym, 55, 80, 700);
        errands(p, "coffee", [[7, 3], [8, 4], [9, 3], [10, 2]], p.age < 65 ? 0.3 : 0.22, "cafe", A.coffee, 10, 30, 400);
        errands(p, "doctor", [[10, 2], [11, 2], [13, 2], [14, 2], [15, 1]], p.age >= 65 ? 0.12 : 0.04, "health", A.doctor, 40, 90, 1200);
        errands(p, "lunch", [[11, 2], [12, 5], [13, 3]], 0.26, { food: 0.7, cafe: 0.3 }, A.eat, 35, 60, 500);
        if (p.dog && yes("dog.noon.go", "Does this person take the dog out around midday?", 0.6)) {
          dogWalkAt(p, "noon", [[12, 2], [13, 3], [14, 2]], cur.t + minutes(10), 15, "When is the midday dog walk?");
        }
        if (p.escorting) {
          const walk = w.travelTime(p.home, p.escorting.school, WALK, p.escorting.pickup);
          go(p.escorting.school, WALK, p.escorting.pickup - walk - minutes(3), A.school);
          go(p.home, WALK, p.escorting.pickup, A.home);
        }
        errands(p, "park", [[10, 2], [14, 2], [15, 2], [16, 3], [17, 3]], p.age >= 65 ? 0.4 : 0.22, "park", A.park, 30, 80, 800);
        errands(p, "shop", [[15, 2], [16, 3], [17, 4], [18, 4], [19, 2]], 0.3, { grocery: 0.75, retail: 0.125, personal: 0.125 },
          { grocery: A.groceries, retail: A.shopping, personal: A.errand }, 15, 40, 500);
        nycTrip(p, 0.05);
        dogWalkAt(p, "pm", [[17, 2], [18, 4], [19, 3], [20, 2]], cur.t + minutes(10), 25, "When does this person walk the dog in the evening?");
        eveningOut(p, cur.t, p.age < 40 ? 0.2 : 0.12);
      } else {
        errands(p, "gym", [[8, 2], [9, 3], [10, 3], [16, 2], [17, 2]], 0.24, "fitness", A.gym, 55, 90, 700);
        errands(p, "meal", [[10, 3], [11, 5], [12, 5], [13, 3]], 0.35, "food", A.eat, 60, 100, 700);
        errands(p, "park", [[11, 2], [13, 3], [14, 3], [15, 3], [16, 2]], 0.4, "park", A.park, 45, 120, 900);
        errands(p, "retail", [[11, 2], [12, 2], [14, 3], [15, 3], [16, 2]], 0.2, "retail", A.shopping, 30, 80, 800);
        errands(p, "groceries", [[10, 2], [12, 2], [15, 3], [17, 3], [18, 2]], 0.33, "grocery", A.groceries, 20, 40, 500);
        nycTrip(p, 0.12);
        dogWalkAt(p, "pm", [[17, 2], [18, 4], [19, 3], [20, 2]], cur.t + minutes(10), 30, "When does this person walk the dog in the evening?");
        eveningOut(p, cur.t, p.age < 40 ? 0.42 : 0.25);
      }
      finish();
    }

    // --- Stevens undergraduates in residence halls -------------------------------------
    w.data.dorms.forEach((d, i) => {
      const anchor = w.dormA0 + i;
      for (let j = 0; j < d[4]; j++) {
        personStream();
        const spot = w.spotInBuilding(d[5], rng, w.aX[anchor], w.aY[anchor]);
        const p = { kind: DORM, age: 18 + Math.floor(rng() * 5), home: anchor, hx: spot[0], hy: spot[1] };
        begin(p, anchor, DAY_START, A.home);
        if (!weekend) {
          if (yes("class.am.go", "Does this student have a morning class today?", 0.8)) {
            const at = hourOf("class.am.when", "When does the morning class start?", [[8, 2], [9, 5], [10, 3]]);
            outing(classroom(), WALK, at, howLong("class.am.len", "How long is the morning on campus?", 75, 140, "min", at), A.class, A.home);
          }
          if (yes("lunch.go", "Does this student go out for lunch?", 0.6)) {
            const at = hourOf("lunch.when", "When do they have lunch?", [[12, 4], [13, 3]]);
            const kind = oneOf("lunch.kind", "Lunch at a restaurant or a café?", { food: 0.6, cafe: 0.4 }, KIND_TEXT, at);
            const place = nearby("lunch.place", kind, anchor, 350, "Where do they get lunch?", at);
            outing(place, WALK, at, howLong("lunch.len", "How long is lunch?", 30, 60, "min", at), A.eat, A.home);
          }
          if (yes("class.pm.go", "Does this student have an afternoon class?", 0.7)) {
            const at = hourOf("class.pm.when", "When does the afternoon class start?", [[13, 2], [14, 4], [15, 2]]);
            outing(classroom(), WALK, at, howLong("class.pm.len", "How long is the afternoon on campus?", 75, 150, "min", at), A.class, A.home);
          }
          if (yes("errand.gym", "Does this student work out today?", 0.3)) {
            const at = hourOf("errand.gym.when", "When do they work out?", [[16, 2], [17, 3], [18, 2]]);
            outing(nearby("errand.gym.place", "fitness", anchor, 250, "Which gym do they go to?", at), WALK, at, minutes(60), A.gym, A.home);
          }
          eveningOut(p, cur.t, 0.35);
        } else {
          if (yes("errand.meal", "Does this student go out for lunch?", 0.45)) {
            const at = hourOf("errand.meal.when", "When do they go out for lunch?", [[11, 3], [12, 3], [13, 2]]);
            outing(nearby("errand.meal.place", "food", anchor, 700, "Which restaurant?", at), WALK, at, minutes(70), A.eat, A.home);
          }
          if (yes("errand.park", "Does this student spend time outdoors today?", 0.35)) {
            const at = hourOf("errand.park.when", "When do they head outdoors?", [[13, 2], [14, 3], [15, 2]]);
            outing(nearby("errand.park.place", "park", anchor, 900, "Which park or stretch of waterfront?", at), WALK, at, minutes(80), A.park, A.home);
          }
          nycTrip(p, 0.2);
          eveningOut(p, cur.t, 0.55);
        }
        finish();
      }
    });

    // --- people who commute in to work ------------------------------------------------------
    const inShares = asm.inboundModeShares.value;
    const SHIFT = {
      school: [[[7, 6]], 8.3], food: [[[9, 3], [10, 4], [15, 3], [16, 2]], 8], nightlife: [[[15, 2], [16, 3], [17, 3]], 8.5],
      cafe: [[[5, 2], [6, 4], [7, 2], [11, 1]], 8], grocery: [[[6, 3], [7, 2], [12, 2], [14, 2]], 8],
      retail: [[[8, 1], [9, 3], [10, 3], [12, 1]], 8], personal: [[[8, 1], [9, 3], [10, 2]], 8],
      fitness: [[[5, 2], [6, 2], [9, 2], [15, 2]], 7.5], health: [[[6, 4], [7, 4], [8, 3], [18, 1]], 9],
      hotel: [[[6, 3], [14, 3], [22, 1]], 8], transit: [[[5, 2], [6, 3], [13, 2]], 8], parking: [[[6, 2], [14, 2]], 8],
    };
    const OFFICE = [[[7, 2], [8, 6], [9, 5], [10, 1]], 8.8];
    const SHIFT_LABELS = ["shorter", "usual", "longer"];
    const SHIFT_PRIOR = [0.2, 0.6, 0.2];
    function shiftLength(hours, start) {
      const bands = [[hours - 1.5, hours - 0.5], [hours - 0.5, hours + 0.5], [hours + 0.5, hours + 1.5]];
      const i = tracking
        ? decide("in.hours", "How long is this person's shift today?", SHIFT_LABELS, SHIFT_PRIOR,
          { kind: "length", when: start, texts: bands.map(([a, b]) => a + " to " + b + " hours") })
        : pick(rng, SHIFT_PRIOR);
      return (bands[i][0] + (bands[i][1] - bands[i][0]) * rng()) * HOUR;
    }
    yield 0.72;
    for (let i = 0; i < this.params.inboundWorkers; i++) {
      if (i % 4000 === 3999) yield 0.72 + 0.12 * (i / this.params.inboundWorkers);
      personStream();
      const p = { kind: WORKER_IN, age: 20 + Math.floor(rng() * 45) };
      const work = (p.work = workplace());
      const group = w.groups[w.placeOf(work)[2]];
      const [window, hours] = SHIFT[group] || OFFICE;
      const start = hourOf("in.start", "When does this person start work in Hoboken?", window) + (weekend ? HOUR * 0.5 : 0);
      const ch = (p.ch = CH_OF[oneOf("in.mode", "How does this person get to work in Hoboken?", inShares, MODE_TEXT)]);
      p.region = ch === CH.path ? Number(oneOf("in.from", "Where does this person come from?", { [R.midtown]: 0.6, [R.jc]: 0.4 }, REGION_TEXT))
        : ch === CH.njtRail ? R.nj : ch === CH.hblr ? R.jc : ch === CH.ferry ? R.midtown : ch === CH.walk || ch === CH.bike ? R.jc
          : ch === CH.bus ? R.jc : R.nj;
      const gate = gateFor(ch, work, p.region, "in.gate", start);
      const mode = MAP_MODE[ch];
      const lead = w.travelTime(gate, work, mode, start);
      arriveFromOutside(p, gate, ch, Math.max(DAY_START + 60, start - lead));
      const garage = ch === CH.car ? garageNear("in.garage", work, start) : -1;
      if (ch === CH.car) {
        go(garage, CAR, cur.t, A.station);
        go(work, WALK, cur.t, A.work);
      } else {
        go(work, mode, cur.t, A.work);
      }
      const end = Math.min(DAY_END - minutes(30), start + shiftLength(hours, start));
      if (group === "office" || group === "health" || group === "civic" || group === "university") {
        const lt = start + between(rng, 3, 4.5) * HOUR;
        if (lt < end - HOUR && yes("lunch.go", "Does this person go out for lunch?", 0.3, lt)) {
          const kind = oneOf("lunch.kind", "Lunch at a restaurant or a café?", { food: 0.7, cafe: 0.3 }, KIND_TEXT, lt);
          const lunch = nearby("lunch.place", kind, work, 300, "Where do they get lunch near work?", lt);
          if (lunch >= 0) {
            go(lunch, WALK, lt, A.eat);
            go(work, WALK, cur.t + minutes(30), A.work);
          }
        }
      }
      if (ch === CH.car) {
        go(garage, WALK, end, A.station);
        leaveForGood(gate, CAR, ch, cur.t + minutes(3));
      } else {
        const back = ch === CH.bus ? nearest(w.stopAnchors, work) : gate;
        leaveForGood(back, mode, ch, end);
      }
      finish();
    }

    // --- Stevens students who live elsewhere ---------------------------------------------------
    for (let i = 0; i < this.params.inboundStudents; i++) {
      personStream();
      const p = { kind: STUDENT_IN, age: 20 + Math.floor(rng() * 10) };
      const ch = (p.ch = CH_OF[oneOf("stu.mode", "How does this student get to Stevens?", { path: 45, hblr: 20, njtRail: 10, bus: 15, car: 10 }, MODE_TEXT)]);
      p.region = ch === CH.path ? R.midtown : ch === CH.hblr ? R.jc : R.nj;
      const cls = classroom();
      const start = hourOf("stu.start", "When does this student's first class start?", [[8, 3], [9, 4], [10, 3], [13, 2], [17, 1]]);
      const gate = gateFor(ch, cls, p.region, "stu.gate", start);
      arriveFromOutside(p, gate, ch, start);
      const garage = ch === CH.car ? garageNear("stu.garage", cls, start) : -1;
      if (ch === CH.car) go(garage, CAR, cur.t, A.station);
      go(cls, ch === CH.car ? WALK : MAP_MODE[ch], cur.t, A.class);
      let t = cur.t + howLong("class.len", "How long is their first block of classes?", 1.5, 3, "h", cur.t);
      if (yes("lunch.go", "Does this student go out for lunch?", 0.6, t)) {
        const kind = oneOf("lunch.kind", "Lunch at a restaurant or a café?", { food: 0.6, cafe: 0.4 }, KIND_TEXT, t);
        go(nearby("lunch.place", kind, cls, 300, "Where do they get lunch between classes?", t), WALK, t, A.eat);
        t = go(classroom(), WALK, cur.t + minutes(35), A.class);
        t += howLong("class.pm.len", "How long is the afternoon block of classes?", 1.2, 2.5, "h", t);
      }
      if (ch === CH.car) {
        go(garage, WALK, t, A.station);
        leaveForGood(gate, CAR, ch, cur.t);
      } else {
        leaveForGood(ch === CH.bus ? nearest(w.stopAnchors, cls) : gate, MAP_MODE[ch], ch, t);
      }
      finish();
    }

    // --- visitors ---------------------------------------------------------------------------------
    const vShares = asm.visitorModeShares.value;
    const V_ARRIVE = weekend
      ? [[9, 2], [10, 6], [11, 9], [12, 10], [13, 9], [14, 8], [15, 7], [16, 6], [17, 6], [18, 7], [19, 8], [20, 8], [21, 7], [22, 5], [23, 3]]
      : [[10, 3], [11, 5], [12, 7], [13, 5], [14, 4], [15, 4], [16, 5], [17, 9], [18, 13], [19, 13], [20, 10], [21, 8], [22, 6], [23, 4], [24, 2]];
    /** Why a visitor comes, given when they arrive. */
    function visitReasons(clock) {
      if (clock >= 21) return { nightlife: 0.7, food: 0.3 };
      if (clock >= 16) return { food: 55, nightlife: 30, park: 8, arts: 7 };
      if (weekend) return { food: 45, park: 25, retail: 18, cafe: 7, arts: 5 };
      return { health: 12, food: 35.2, cafe: 13.2, park: 17.6, retail: 17.6, arts: 4.4 };
    }
    const actOf = { food: A.eat, nightlife: A.drinks, park: A.park, arts: A.sightseeing, retail: A.shopping, cafe: A.coffee, health: A.doctor };
    const stayOf = { food: [55, 110], nightlife: [80, 180], park: [40, 110], arts: [60, 120], retail: [30, 75], cafe: [25, 50], health: [45, 110] };
    const STOPS_TEXT = { 0: "none, they head home", 1: "one more", 2: "two more" };
    yield 0.86;
    for (let i = 0; i < this.params.visitors; i++) {
      if (i % 4000 === 3999) yield 0.86 + 0.08 * (i / this.params.visitors);
      personStream();
      const p = { kind: VISITOR, age: 18 + Math.floor(rng() * 55) };
      const ch = (p.ch = CH_OF[oneOf("visit.mode", "How does this visitor get to Hoboken?", vShares, MODE_TEXT)]);
      p.region = ch === CH.path || ch === CH.ferry
        ? Number(oneOf("visit.from", "Where is this visitor coming from?", { [R.midtown]: 0.7, [R.lower]: 0.3 }, REGION_TEXT))
        : ch === CH.car ? R.nj : R.jc;
      const arrive = hourOf("visit.arrive", "When does this visitor arrive?", V_ARRIVE);
      const group = oneOf("visit.why", "What brings this visitor to Hoboken first?", visitReasons(arrive / HOUR), KIND_TEXT, arrive);
      const first = nearby("visit.first", group, w.gate.path, 1500, () => "Which " + KIND_TEXT[group].replace(/^(a|an|the) /, "") + " is their first stop?", arrive);
      if (first < 0) throw new Error("No " + group + " venues to visit");
      const gate = gateFor(ch, first, p.region, "visit.gate", arrive);
      arriveFromOutside(p, gate, ch, arrive);
      const garage = ch === CH.car ? garageNear("visit.garage", first, arrive) : -1;
      if (ch === CH.car) go(garage, CAR, cur.t, A.station);
      let t = go(first, ch === CH.car ? WALK : MAP_MODE[ch], cur.t, actOf[group]);
      t += howLong("visit.len", "How long do they stay at their first stop?", stayOf[group][0], stayOf[group][1], "min", t);
      const stops = Number(oneOf("visit.stops", "How many more places do they go to before leaving?", { 0: 0.5, 1: 0.35, 2: 0.15 }, STOPS_TEXT, t));
      let at = first;
      for (let s = 0; s < stops && t < DAY_END - 2 * HOUR; s++) {
        const next = t / HOUR >= 20 ? "nightlife"
          : oneOf("visit.next", "What kind of place do they go to next?", { food: 3, cafe: 2, park: 2, retail: 2, nightlife: t / HOUR > 17 ? 3 : 0 }, KIND_TEXT, t);
        const place = nearby("visit.next.place", next, at, 400, () => "Which " + KIND_TEXT[next].replace(/^(a|an|the) /, "") + " next?", t);
        if (place < 0) break;
        t = go(place, WALK, t, actOf[next]);
        t += howLong("visit.next.len", "How long do they stay at that next stop?", stayOf[next][0], stayOf[next][1], "min", t);
        at = place;
      }
      if (ch === CH.car) {
        go(garage, WALK, t, A.station);
        leaveForGood(gate, CAR, ch, cur.t);
      } else {
        const out = ch === CH.bus ? nearest(w.stopAnchors, at) : ch === CH.walk || ch === CH.bike ? gate : gateFor(ch, at, p.region, "visit.gateOut", t);
        leaveForGood(out, MAP_MODE[ch], ch, Math.min(t, DAY_END - minutes(15)));
      }
      finish();
    }

    // --- NJ Transit riders changing to PATH, ferry, light rail or bus inside the terminal ---------------
    const terminalStop = nearest(w.stopAnchors, w.gate.njt);
    const TRANSFER_TO = { path: [CH.path, w.gate.path], ferry: [CH.ferry, w.gate.ferry_term], hblr: [CH.hblr, w.gate.hblr_term], bus: [CH.bus, terminalStop] };
    const TRANSFER_TEXT = { path: "the PATH to Manhattan", ferry: "a ferry to Manhattan", hblr: "the light rail", bus: "a bus" };
    for (let i = 0; i < this.params.transfers; i++) {
      personStream();
      const p = { kind: TRANSFER, age: 22 + Math.floor(rng() * 45) };
      const to = oneOf("xfer.to", "This rider's NJ Transit train has just arrived at Hoboken Terminal. What do they change to?",
        { path: 70, ferry: 18, hblr: 7, bus: 5 }, TRANSFER_TEXT);
      const [ch, target] = TRANSFER_TO[to];
      p.ch = ch;
      const am = weekend
        ? hourOf("xfer.am", "When does their train get in?", [[9, 3], [10, 3], [11, 2], [12, 2]])
        : hourOf("xfer.am", "When does their train get in?", [[6, 2], [7, 5], [8, 6], [9, 2]]);
      p.legStart = legs.n;
      legs.push(AWAY, 0, A.away, DAY_START, am, w.gate.njt, w.gate.njt, CH.njtRail);
      cur = { agent: p, anchor: w.gate.njt, t: am, act: A.station };
      go(target, WALK, am, A.station);
      transfers[ch] += 1;
      const pm = Math.max(cur.t + 4 * HOUR, weekend
        ? hourOf("xfer.pm", "When do they come back through the terminal for the train home?", [[16, 3], [18, 3], [20, 2]])
        : hourOf("xfer.pm", "When do they come back through the terminal for the train home?", [[16, 3], [17, 6], [18, 5], [19, 2]]));
      legs.push(AWAY, 0, A.away, cur.t, pm, target, target, ch);
      cur.anchor = target;
      cur.t = pm;
      go(w.gate.njt, WALK, pm, A.station);
      transfers[CH.njtRail] += 1;
      legs.push(AWAY, 0, A.away, cur.t, DAY_END, w.gate.njt, w.gate.njt, CH.njtRail);
      cur.t = DAY_END;
      finish();
    }

    yield 0.95;
    // --- pack agents into typed arrays --------------------------------------------------------------
    const n = (this.n = agents.length);
    this.kind = new Uint8Array(n);
    this.legStart = new Int32Array(n);
    this.legEnd = new Int32Array(n);
    this.hx = new Float32Array(n);
    this.hy = new Float32Array(n);
    this.homeAnchor = new Int32Array(n).fill(-1);
    this.cursor = new Int32Array(n);
    this.profile = agents; // plain objects, read only by the inspector
    agents.forEach((p, i) => {
      this.kind[i] = p.kind;
      this.legStart[i] = p.legStart;
      this.legEnd[i] = p.legEnd;
      this.cursor[i] = p.legStart;
      if (p.home !== undefined) {
        this.homeAnchor[i] = p.home;
        this.hx[i] = p.hx;
        this.hy[i] = p.hy;
      }
      delete p.household;
    });
    this.heading = new Float32Array(n); // direction of travel, radians from east
    // Resting positions near a venue: a fixed scatter per person so crowds read as crowds.
    this.jx = new Float32Array(n);
    this.jy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ang = hash01(i * 7 + 1) * 6.283;
      const rad = 2 + hash01(i * 13 + 5) * 9;
      this.jx[i] = Math.cos(ang) * rad;
      this.jy[i] = Math.sin(ang) * rad;
    }
    // Every leg, ordered by the time it ends, so each frame only touches people whose plans move on.
    const L = this.legs;
    this.legAgent = new Int32Array(L.n);
    const keys = new Float64Array(L.n);
    for (let i = 0; i < n; i++) for (let l = this.legStart[i]; l < this.legEnd[i]; l++) this.legAgent[l] = i;
    for (let l = 0; l < L.n; l++) keys[l] = Math.floor(L.t1[l] * 16) * 2097152 + l;
    keys.sort();
    this.byEnd = new Int32Array(L.n);
    for (let k = 0; k < L.n; k++) this.byEnd[k] = keys[k] % 2097152;
    this.movers = new Int32Array(n);
    this.moverAt = new Int32Array(n).fill(-1);
    this.nMovers = 0;
    this.stamp = new Int32Array(n);
    this.endPtr = 0;
    this.routes = new Map();
    this.frame = 0;
    this.lastT = -1;
    this.computeStats();
  };

  // ------------------------------------------------------------------ statistics

  Simulation.prototype.computeStats = function () {
    const L = this.legs;
    const present = [new Float64Array(NBINS + 1), new Float64Array(NBINS + 1), new Float64Array(NBINS + 1)];
    const moving = new Float64Array(NBINS + 1);
    const cat = (k) => (k === RESIDENT || k === DORM ? 0 : k === VISITOR ? 2 : k === TRANSFER ? -1 : 1);
    for (let i = 0; i < this.n; i++) {
      const c = cat(this.kind[i]);
      for (let l = this.legStart[i]; l < this.legEnd[i]; l++) {
        if (L.kind[l] === AWAY) continue;
        let b0 = ((L.t0[l] - DAY_START) / BIN + 0.5) | 0;
        let b1 = ((L.t1[l] - DAY_START) / BIN + 0.5) | 0;
        b0 = b0 < 0 ? 0 : b0 > NBINS ? NBINS : b0;
        b1 = b1 < 0 ? 0 : b1 > NBINS ? NBINS : b1;
        if (c >= 0) {
          present[c][b0] += 1;
          present[c][b1] -= 1;
        }
        if (L.kind[l] === TRIP) {
          moving[b0] += 1;
          moving[b1] -= 1;
        }
      }
    }
    for (const arr of [...present, moving]) for (let b = 1; b <= NBINS; b++) arr[b] += arr[b - 1];
    const crossIn = CHANNELS.map(() => new Float64Array(24));
    const crossOut = CHANNELS.map(() => new Float64Array(24));
    const byGate = new Map();
    const E = this.events;
    for (let i = 0; i < E.t.length; i++) {
      const h = Math.floor((E.t[i] - DAY_START) / HOUR);
      if (h < 0 || h > 23) continue;
      (E.dir[i] > 0 ? crossIn : crossOut)[E.ch[i]][h] += 1;
      const g = byGate.get(E.gate[i]) || { in: 0, out: 0 };
      if (E.dir[i] > 0) g.in++;
      else g.out++;
      byGate.set(E.gate[i], g);
    }
    const order = E.t.map((_, i) => i).sort((a, b) => E.t[a] - E.t[b]);
    this.eventOrder = Int32Array.from(order);
    this.stats = { present, moving, crossIn, crossOut, byGate };
  };

  /** Totals of crossings (in/out) per channel between DAY_START and time t. */
  Simulation.prototype.crossingsUntil = function (t, sinceT) {
    const from = sinceT === undefined ? DAY_START : sinceT;
    const inn = new Float64Array(CHANNELS.length);
    const out = new Float64Array(CHANNELS.length);
    const E = this.events;
    for (const i of this.eventOrder) {
      const et = E.t[i];
      if (et > t) break;
      if (et < from) continue;
      if (E.dir[i] > 0) inn[E.ch[i]] += 1;
      else out[E.ch[i]] += 1;
    }
    return { in: inn, out };
  };

  /** Recent crossings per gateway anchor within [t - window, t]. */
  Simulation.prototype.gatewayActivity = function (t, window) {
    const E = this.events;
    const result = new Map();
    const order = this.eventOrder;
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (E.t[order[mid]] < t - window) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < order.length; k++) {
      const i = order[k];
      if (E.t[i] > t) break;
      const g = result.get(E.gate[i]) || { in: 0, out: 0 };
      if (E.dir[i] > 0) g.in++;
      else g.out++;
      result.set(E.gate[i], g);
    }
    return result;
  };

  /** Modeled figures that can be compared with published counts. */
  Simulation.prototype.calibrationChecks = function () {
    const E = this.events;
    const outBy = new Float64Array(CHANNELS.length);
    for (let i = 0; i < E.t.length; i++) if (E.dir[i] < 0) outBy[E.ch[i]] += 1;
    const tb = this.transferBoardings;
    let residents = 0;
    let workers = 0;
    let wfh = 0;
    for (const p of this.profile) {
      if (p.kind === RESIDENT || p.kind === DORM) residents++;
      if (p.kind === RESIDENT && p.worker) {
        workers++;
        if (p.wfh) wfh++;
      }
    }
    return {
      residents,
      employedResidents: workers,
      wfhShare: workers ? wfh / workers : 0,
      pathEntries: outBy[CH.path] + tb[CH.path],
      njtBoardings: outBy[CH.njtRail] + tb[CH.njtRail],
      hblrBoardings: outBy[CH.hblr] + tb[CH.hblr],
      ferryBoardings: outBy[CH.ferry] + tb[CH.ferry],
      carExits: outBy[CH.car],
      dogs: this.dogs,
    };
  };

  // ------------------------------------------------------------------ positions

  const STATE_HOME = 0;
  const STATE_PLACE = 1;
  const STATE_WALK = 2;
  const STATE_BIKE = 3;
  const STATE_CAR = 4;
  const STATE_HIDDEN = 5;

  Simulation.prototype.routeFor = function (leg) {
    let r = this.routes.get(leg);
    if (!r) {
      const L = this.legs;
      r = L.mode[leg] === CAR ? this.world.carRoute(L.a[leg], L.b[leg]) : this.world.walkRoute(L.a[leg], L.b[leg]);
      this.routes.set(leg, r);
    }
    r.seen = this.frame;
    return r;
  };

  /** Position along the route of trip leg l at time t. */
  Simulation.prototype.move = function (i, l, t, x, y) {
    const L = this.legs;
    const r = this.routeFor(l);
    const f = (t - L.t0[l]) / (L.t1[l] - L.t0[l] || 1);
    const s = (f < 0 ? 0 : f > 1 ? 1 : f) * r.len;
    const c = r.c;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    const u = (s - c[lo]) / (c[hi] - c[lo] || 1);
    const dx = r.x[hi] - r.x[lo];
    const dy = r.y[hi] - r.y[lo];
    x[i] = r.x[lo] + dx * u;
    y[i] = r.y[lo] + dy * u;
    if (dx || dy) this.heading[i] = Math.atan2(dy, dx);
  };

  /** True while person i is out with their dog (on the way, at the run, or heading home). */
  Simulation.prototype.withDog = function (i) {
    return this.legs.act[this.cursor[i]] === ACT_DOG;
  };

  /** True when leg l is part of a dog walk. */
  Simulation.prototype.withDogLeg = function (l) {
    return this.legs.act[l] === ACT_DOG;
  };

  /** True while person i is at a venue that is outdoors (a park, pier or dog run). */
  Simulation.prototype.outdoors = function (i) {
    const l = this.cursor[i];
    const a = this.legs.a[l];
    const w = this.world;
    return w.aKind[a] === ANCHOR_PLACE && w.placeGroup[w.aRef[a]] === w.G.park;
  };

  /** Re-evaluate person i at time t (cursor only moves forward; positionsAt rewinds it). */
  Simulation.prototype.place = function (i, t, x, y, state) {
    const L = this.legs;
    let l = this.cursor[i];
    const end = this.legEnd[i] - 1;
    while (l < end && t >= L.t1[l]) l++;
    this.cursor[i] = l;
    const kind = L.kind[l];
    const inside = t >= L.t0[l] && t < L.t1[l];
    if (kind === TRIP && inside) {
      if (this.moverAt[i] < 0) {
        this.moverAt[i] = this.nMovers;
        this.movers[this.nMovers++] = i;
      }
      this.move(i, l, t, x, y);
      state[i] = L.mode[l] === CAR ? STATE_CAR : L.mode[l] === BIKE ? STATE_BIKE : STATE_WALK;
      return;
    }
    if (this.moverAt[i] >= 0) {
      const k = this.moverAt[i];
      const last = this.movers[--this.nMovers];
      this.movers[k] = last;
      this.moverAt[last] = k;
      this.moverAt[i] = -1;
    }
    if (kind !== STAY || !inside) {
      state[i] = STATE_HIDDEN;
      return;
    }
    const a = L.a[l];
    if (a === this.homeAnchor[i]) {
      x[i] = this.hx[i];
      y[i] = this.hy[i];
      state[i] = STATE_HOME;
    } else {
      const w = this.world;
      const k = w.aKind[a] === ANCHOR_GATE ? 0.4 : 1;
      x[i] = w.aX[a] + this.jx[i] * k;
      y[i] = w.aY[a] + this.jy[i] * k;
      state[i] = STATE_PLACE;
    }
  };

  /**
   * Fill x, y, state for every person at clock time t (seconds, DAY_START..DAY_END).
   * Small forward steps only touch people whose leg just ended plus everyone in motion;
   * jumps backward or by more than two hours re-evaluate everyone.
   */
  Simulation.prototype.positionsAt = function (t, x, y, state) {
    const L = this.legs;
    const byEnd = this.byEnd;
    const frame = ++this.frame;
    const tick = Math.floor(t * 16);
    if (this.lastT < 0 || t < this.lastT || t - this.lastT > 2 * HOUR) {
      if (this.lastT < 0 || t < this.lastT) this.cursor.set(this.legStart);
      for (let i = 0; i < this.n; i++) this.place(i, t, x, y, state);
      // Rewind to the start of the current 1/16 s bucket: legs in it may not have ended yet.
      let lo = 0;
      let hi = byEnd.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Math.floor(L.t1[byEnd[mid]] * 16) < tick) lo = mid + 1;
        else hi = mid;
      }
      this.endPtr = lo;
    } else {
      // byEnd is ordered by 1/16 s bucket, so compare exact end times: a leg that ends a
      // fraction of a second after t waits for the next frame instead of being skipped.
      let p = this.endPtr;
      while (p < byEnd.length && L.t1[byEnd[p]] <= t) {
        const i = this.legAgent[byEnd[p++]];
        if (this.stamp[i] !== frame) {
          this.stamp[i] = frame;
          this.place(i, t, x, y, state);
        }
      }
      this.endPtr = p;
      for (let k = this.nMovers - 1; k >= 0; k--) {
        const i = this.movers[k];
        if (this.stamp[i] === frame) continue;
        this.stamp[i] = frame;
        const l = this.cursor[i];
        if (t >= L.t1[l]) this.place(i, t, x, y, state);
        else this.move(i, l, t, x, y);
      }
    }
    this.lastT = t;
    if (frame % 30 === 0) {
      for (const [leg, r] of this.routes) if (frame - r.seen > 60) this.routes.delete(leg);
    }
    return { moving: this.nMovers };
  };

  /** Human-readable plan for the inspector. */
  Simulation.prototype.describe = function (i) {
    const w = this.world;
    const L = this.legs;
    const p = this.profile[i];
    const items = [];
    for (let l = this.legStart[i]; l < this.legEnd[i]; l++) {
      const k = L.kind[l];
      if (k === STAY && L.t1[l] - L.t0[l] < 60) continue;
      if (k === AWAY) {
        if (L.t0[l] <= DAY_START + 1 || L.t1[l] >= DAY_END - 1) continue;
        const region = L.info[l] >> 4;
        items.push({ t0: L.t0[l], t1: L.t1[l], kind: "away", text: "In " + REGIONS[region] + " (" + CHANNEL_LABELS[L.info[l] & 15] + ")" });
      } else if (k === TRIP) {
        const how = p.child && p.age < 3 && L.mode[l] === WALK ? "In a stroller" : cap(MODE_LABELS[L.mode[l]]);
        items.push({ t0: L.t0[l], t1: L.t1[l], kind: "trip", text: how + " to " + w.anchorName(L.b[l]) });
      } else {
        items.push({ t0: L.t0[l], t1: L.t1[l], kind: "stay", text: ACT_LABELS[L.act[l]] + (L.act[l] === A.home ? "" : " · " + w.anchorName(L.a[l])) });
      }
    }
    const facts = [];
    facts.push(KIND_LABELS[p.kind]);
    if (p.age !== undefined) facts.push("age " + p.age);
    if (p.kind === RESIDENT) {
      facts.push(p.child ? (p.age < 3 ? "toddler" : p.age < 5 ? "preschooler" : "school-age")
        : p.worker ? (p.offToday ? "off work today" : p.wfh ? "works from home today" : "commutes")
          : p.gradStudent ? "Stevens grad student" : p.age >= 65 ? "retired" : "not working today");
    }
    if (p.region !== undefined && p.kind === RESIDENT && p.worker && !p.wfh) facts.push("works in " + REGIONS[p.region]);
    if (p.work !== undefined && p.work >= 0 && (p.kind === WORKER_IN || p.region === R.hoboken)) facts.push("job: " + w.anchorName(p.work));
    if (p.ch !== undefined) facts.push("by " + CHANNEL_LABELS[p.ch]);
    if (p.dog) facts.push("walks the family dog");
    const tally = this.decisionsByPerson && this.decisionsByPerson[i];
    const jev = tally && this.options.decisions ? { decisions: tally[0], fromJev: tally[1] } : null;
    return { id: i, kind: KIND_LABELS[p.kind], facts, items, jev, home: p.home !== undefined ? w.anchorName(p.home) : null };
  };

  /**
   * Who person i is, without anything their day's decisions settled (commute mode, working
   * from home today...), so a decision model isn't handed the rules' answers.
   */
  Simulation.prototype.profileFacts = function (i) {
    const w = this.world;
    const p = this.profile[i];
    const facts = [KIND_LABELS[p.kind], "age " + p.age];
    if (p.kind === RESIDENT) {
      if (p.child) facts.push(p.age < 3 ? "toddler" : p.age < 5 ? "preschooler" : "school-age child");
      else {
        facts.push(p.worker ? "employed" + (p.gradStudent ? " and a Stevens graduate student" : "")
          : p.gradStudent ? "Stevens graduate student" : p.age >= 65 ? "retired" : "not employed");
        facts.push(p.hhSize > 1 ? "lives with " + (p.hhSize - 1) + (p.hhSize === 2 ? " other person" : " others") : "lives alone");
        if (p.kids) facts.push(p.kids + (p.kids === 1 ? " child" : " children") + " at home");
      }
    }
    if (p.kind === WORKER_IN && p.work >= 0) facts.push("works at " + w.anchorName(p.work) + " (" + w.groups[w.placeGroup[w.aRef[p.work]]] + ")");
    if (p.dog) facts.push("has a dog");
    return facts;
  };

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function clock(t) {
    const m = Math.floor(t / 60) % (24 * 60);
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, "0");
    const hh = h % 12 === 0 ? 12 : h % 12;
    return hh + ":" + mm + (h < 12 ? " am" : " pm");
  }

  // ------------------------------------------------------------------ decision sources
  // A decision source answers decide() calls: answer(person, key, labels, anchors) returns an
  // index into labels, or -1 to let the rules decide.

  /** Answers keyed "person|key" -> label: the Jev driver's working table. */
  function tableSource(table) {
    return {
      answer(person, key, labels) {
        const a = table[person + "|" + key];
        return a === undefined ? -1 : labels.indexOf(a);
      },
    };
  }

  /**
   * Jev's answers packed in the order a day asks for them, which is how the page ships them.
   * Layout (little-endian): u32 P; P x u32 person; P x u32 count; then one u16 topic code and
   * one u16 value per decision, in two runs. A value is an option index, the anchor of a
   * chosen place, or 0xffff where the rules decided.
   */
  function encodeSequence(log, include) {
    const topics = [];
    const codes = new Map();
    const byPerson = new Map();
    for (const d of log) {
      if (include && !include(d.person)) continue;
      let list = byPerson.get(d.person);
      if (!list) byPerson.set(d.person, (list = []));
      let c = codes.get(d.key);
      if (c === undefined) {
        c = topics.length;
        codes.set(d.key, c);
        topics.push(d.key);
      }
      list.push(c, d.fromTable ? (d.anchors ? d.anchors[d.answer] : d.answer) : 0xffff);
    }
    if (topics.length >= 0xffff) throw new Error("too many decision topics to pack");
    const people = [...byPerson.keys()].filter((p) => byPerson.get(p).some((v, i) => i % 2 === 1 && v !== 0xffff)).sort((a, b) => a - b);
    let total = 0;
    for (const p of people) total += byPerson.get(p).length / 2;
    const bytes = new Uint8Array(4 + 8 * people.length + 4 * total);
    const dv = new DataView(bytes.buffer);
    let o = 0;
    dv.setUint32(o, people.length, true);
    o += 4;
    for (const p of people) {
      dv.setUint32(o, p, true);
      o += 4;
    }
    for (const p of people) {
      dv.setUint32(o, byPerson.get(p).length / 2, true);
      o += 4;
    }
    for (const part of [0, 1]) {
      for (const p of people) {
        const list = byPerson.get(p);
        for (let i = part; i < list.length; i += 2) {
          dv.setUint16(o, list[i], true);
          o += 2;
        }
      }
    }
    return { topics, bytes, people: people.length, decisions: total };
  }

  /** Read encodeSequence() output. Each Simulation needs its own source: it tracks its place. */
  function sequenceSource(topics, bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const P = dv.getUint32(0, true);
    const span = new Map();
    let total = 0;
    for (let i = 0; i < P; i++) {
      const count = dv.getUint32(4 + 4 * P + 4 * i, true);
      span.set(dv.getUint32(4 + 4 * i, true), [total, total + count]);
      total += count;
    }
    const base = 4 + 8 * P;
    const at = new Map();
    return {
      answer(person, key, labels, anchors) {
        const s = span.get(person);
        if (!s) return -1;
        const i = at.has(person) ? at.get(person) : s[0];
        if (i < 0 || i >= s[1]) return -1;
        if (topics[dv.getUint16(base + 2 * i, true)] !== key) {
          at.set(person, -1); // out of step with this day: the rules decide the rest
          return -1;
        }
        at.set(person, i + 1);
        const v = dv.getUint16(base + 2 * total + 2 * i, true);
        if (v === 0xffff) return -1;
        return anchors ? anchors.indexOf(v) : v < labels.length ? v : -1;
      },
    };
  }

  const api = {
    World, Simulation, clock, tableSource, encodeSequence, sequenceSource,
    DAY_START, DAY_END, BIN, NBINS, CHANNELS, CHANNEL_LABELS, KIND_LABELS, REGIONS,
    STATE: { HOME: STATE_HOME, PLACE: STATE_PLACE, WALK: STATE_WALK, BIKE: STATE_BIKE, CAR: STATE_CAR, HIDDEN: STATE_HIDDEN },
    ANCHOR: { HOME: ANCHOR_HOME, DORM: ANCHOR_DORM, PLACE: ANCHOR_PLACE, GATE: ANCHOR_GATE, STOP: ANCHOR_STOP },
    KIND: { RESIDENT, DORM, WORKER_IN, STUDENT_IN, VISITOR, TRANSFER },
  };
  root.HobokenSim = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
