/*
 * Hoboken in Motion: page controller. Draws the map (Canvas 2D), the people (WebGL
 * points), the overlay (gateway activity, the selected person) and the side panels.
 * The simulation itself lives in sim.js.
 */
(function () {
  "use strict";

  const H = window.HobokenSim;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const DATES = { weekday: { label: "Tuesday · Sept 22, 2026", day: 265 }, weekend: { label: "Saturday · Sept 26, 2026", day: 269 } };

  // ------------------------------------------------------------------ state
  let data;
  let world;
  let sim;
  let ready = false;
  let playing = !reduceMotion;
  let speed = 300;
  let simT = 6.5 * 3600;
  let dayType = "weekday";
  let decider = "rules";
  const jevDays = {};
  let xs;
  let ys;
  let states;
  let who;
  let selected = -1;
  let following = false;
  const V3 = window.HobokenView3D;
  let mode = V3 && V3.webglAvailable() ? "3d" : "map";
  let view3d = null;
  let light = 1;
  let sun = { rise: 6.8 * 3600, set: 19 * 3600 };
  const overrides = {};

  const stage = $("map");
  const baseCanvas = $("base");
  const glCanvas = $("agents");
  const overlay = $("overlay");
  const view = { cx: -250, cy: 150, scale: 0.3 };
  let W = 0;
  let Hh = 0;

  // ------------------------------------------------------------------ boot
  async function loadData() {
    const inline = document.getElementById("hoboken-data");
    if (inline) return JSON.parse(inline.textContent);
    const res = await fetch("data/hoboken.json");
    if (!res.ok) throw new Error("Could not load data/hoboken.json (" + res.status + ")");
    return res.json();
  }

  function setLoading(text, frac) {
    $("loading").hidden = text === null;
    if (text !== null) {
      $("loadingText").textContent = text;
      $("loadingBar").style.width = Math.round((frac || 0) * 100) + "%";
    }
  }

  async function buildDay() {
    ready = false;
    selectPerson(-1);
    const jev = decider === "jev" ? jevDays[dayType] : null;
    // Jev's answers belong to the default day, so the assumption sliders don't apply to it.
    const next = new H.Simulation(world, Object.assign({ dayType }, jev ? { decisions: H.sequenceSource(jev.topics, jev.bytes) } : overrides), true);
    const steps = next.build();
    let last = performance.now();
    for (;;) {
      const r = steps.next();
      if (r.done) break;
      if (performance.now() - last > 30) {
        setLoading("Planning the day for " + (dayType === "weekday" ? "a weekday" : "a Saturday") + "…", r.value);
        await new Promise((ok) => requestAnimationFrame(ok));
        last = performance.now();
      }
    }
    sim = next;
    const n = sim.n;
    xs = new Float32Array(n);
    ys = new Float32Array(n);
    states = new Uint8Array(n);
    who = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const k = sim.kind[i];
      who[i] = k === H.KIND.RESIDENT || k === H.KIND.DORM ? 0 : k === H.KIND.VISITOR ? 2 : k === H.KIND.TRANSFER ? 3 : 1;
    }
    agentLayer.allocate(n);
    sun = sunTimes(DATES[dayType].day);
    $("clockDay").textContent = DATES[dayType].label;
    const all = sim.crossingsUntil(H.DAY_END);
    crossMax = Math.max(1, ...all.in, ...all.out);
    drawWhoChart();
    drawChecks();
    describeDecider();
    setLoading(null);
    ready = true;
    sim.positionsAt(simT, xs, ys, states);
  }

  async function main() {
    try {
      data = await loadData();
    } catch (err) {
      setLoading("The map data didn't load. Serve this folder over HTTP (python3 -m http.server) and reload. " + err.message, 0);
      return;
    }
    world = new H.World(data);
    resize();
    fitHoboken();
    initControls();
    drawBikeChart();
    fillAbout();
    initAssumptions();
    connectClaude();
    await loadJev();
    await buildDay();
    requestAnimationFrame(frame);
    setMode(mode);
  }

  // ------------------------------------------------------------------ Jev decisions
  /** Jev days written by jev/run-jev.mjs, inlined by the bundler or served next to the page. */
  async function loadJev() {
    // A bundled page already carries every day that existed when it was built.
    const bundled = Boolean(document.getElementById("hoboken-data"));
    for (const day of ["weekday", "weekend"]) {
      const inline = document.getElementById("jev-" + day);
      try {
        let saved = null;
        if (inline) saved = JSON.parse(inline.textContent);
        else if (!bundled) {
          const res = await fetch("data/jev-" + day + ".json");
          if (res.ok) saved = await res.json();
        }
        if (saved && saved.format === "hoboken-jev/2") {
          saved.bytes = await gunzipBase64(saved.sequence);
          delete saved.sequence;
          jevDays[day] = saved;
        }
      } catch {
        // No Jev run for this day yet, or a browser that can't unpack it.
      }
    }
    for (const b of $("deciders").querySelectorAll("button")) {
      b.addEventListener("click", async () => {
        if (b.disabled || b.dataset.decider === decider) return;
        decider = b.dataset.decider;
        await buildDay();
      });
    }
  }

  async function gunzipBase64(text) {
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function describeDecider() {
    const jev = jevDays[dayType];
    const jevBtn = $("deciders").querySelector('[data-decider="jev"]');
    jevBtn.disabled = !jev;
    if (!jev && decider === "jev") decider = "rules";
    for (const b of $("deciders").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.decider === decider));
    const usingJev = decider === "jev";
    $("rebuild").disabled = usingJev;
    $("resetAssume").disabled = usingJev;
    $("assumeNote").hidden = !usingJev;
    const note = $("deciderNote");
    if (!jev) {
      note.innerHTML = "Every decision in this day comes from rules calibrated to published counts: whether people go out, when they leave, " +
        "how they travel, where they go, how long they stay, when the dog gets walked, which road drivers take and where they park. " +
        "<a href=\"https://docs.typesafe.ai/\" target=\"_blank\" rel=\"noopener\">Jev</a> (TypeSafe AI's decision model) can make all of them instead: run " +
        "<code>node hoboken-sim/jev/run-jev.mjs</code> with a TypeSafe API key and this page gains a Jev day.";
      return;
    }
    const st = jev.stats;
    const when = new Date(jev.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const share = st.decisionPointsForThesePeople ? Math.round((100 * st.decisionsFromJev) / st.decisionPointsForThesePeople) : 0;
    const everyone = sim && jev.people >= sim.n;
    const raked = jev.raked
      ? " Working from home, trips out of town, travel modes and train connections were raked to the published totals: Jev chose who, the counts set how many."
      : " Nothing was raked: travel-mode totals are Jev's own.";
    const applied = usingJev && sim ? " This run applied " + fmt(sim.decisionStats.fromTable) + " of them." : "";
    note.textContent = `Jev (${jev.model}) made ${fmt(st.decisionsFromJev)} decisions for ${fmt(jev.people)} people on ${when} ` +
      `(${share}% of their decisions; ${fmt(st.inputTokens)} input tokens, about $${st.estimatedCostUSD.toFixed(2)}).` +
      (everyone ? "" : " Everyone else follows the rules.") + raked + applied;
  }

  // ------------------------------------------------------------------ 3D / map switch
  async function setMode(next) {
    mode = next;
    for (const b of $("views").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.view === next));
    const is3d = next === "3d";
    $("legend2d").hidden = is3d;
    $("legend3d").hidden = !is3d;
    $("presets").hidden = !is3d;
    for (const c of [baseCanvas, glCanvas, overlay]) c.hidden = is3d;
    if (view3d) view3d.canvas.hidden = !is3d;
    if (!is3d) {
      baseDirty = true;
      return;
    }
    if (!view3d) {
      const note = $("note3d");
      note.hidden = false;
      note.textContent = "Building 3D Hoboken…";
      try {
        await V3.load();
        view3d = V3.create(stage, data, world, {
          onPick: (i) => selectPerson(i),
          onFollowBroken: () => setFollowing(false),
        });
        view3d.setSelected(selected);
        note.hidden = true;
        $("presets").innerHTML = Object.entries(view3d.presets)
          .map(([key, p]) => `<button type="button" data-preset="${key}">${escapeHtml(p.label)}</button>`).join("");
        for (const b of $("presets").querySelectorAll("button")) {
          b.addEventListener("click", () => {
            setFollowing(false);
            view3d.preset(b.dataset.preset);
          });
        }
      } catch (err) {
        note.textContent = "The 3D view couldn't load (" + err.message + "). Showing the map instead.";
        setTimeout(() => { note.hidden = true; }, 6000);
        setMode("map");
        return;
      }
    }
    if (mode !== "3d") return;
    view3d.canvas.hidden = false;
    view3d.resize();
  }

  // ------------------------------------------------------------------ geometry helpers
  const S = () => data.meta.scale;
  function sx(x) {
    return (x - view.cx) * view.scale + W / 2;
  }
  function sy(y) {
    return Hh / 2 - (y - view.cy) * view.scale;
  }
  function wx(px) {
    return (px - W / 2) / view.scale + view.cx;
  }
  function wy(py) {
    return view.cy - (py - Hh / 2) / view.scale;
  }

  function fitHoboken() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of data.buildings) {
      if (!b.in) continue;
      for (let i = 0; i < b.p.length; i += 2) {
        minX = Math.min(minX, b.p[i]);
        maxX = Math.max(maxX, b.p[i]);
        minY = Math.min(minY, b.p[i + 1]);
        maxY = Math.max(maxY, b.p[i + 1]);
      }
    }
    const s = S();
    minX /= s;
    maxX /= s;
    minY /= s;
    maxY /= s;
    const overlaid = getComputedStyle(document.querySelector(".controls")).position === "absolute";
    const padTop = W < 520 ? 56 : 70;
    const padBottom = overlaid ? 90 : 16;
    const avH = Math.max(120, Hh - padTop - padBottom);
    view.scale = Math.min((W - 40) / (maxX - minX + 300), avH / (maxY - minY + 150));
    view.cx = (minX + maxX) / 2 + 60;
    view.cy = (minY + maxY) / 2 - (padTop - padBottom) / 2 / view.scale;
    baseDirty = true;
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    W = Math.max(1, r.width);
    Hh = Math.max(1, r.height);
    const d = DPR();
    for (const c of [baseCanvas, glCanvas, overlay]) {
      c.width = Math.round(W * d);
      c.height = Math.round(Hh * d);
    }
    baseCache = null;
    baseDirty = true;
  }

  // ------------------------------------------------------------------ sun and colour
  function sunTimes(dayOfYear) {
    const lat = 40.745;
    const lon = -74.03;
    const rad = Math.PI / 180;
    const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
    const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
      0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad;
    const edt = -240; // minutes from UTC in September
    const rise = 720 - 4 * (lon + ha) - eq + edt;
    const set = 720 - 4 * (lon - ha) - eq + edt;
    return { rise: rise * 60, set: set * 60 };
  }

  function lightAt(t) {
    const clock = ((t % 86400) + 86400) % 86400;
    const ramp = (a, b, v) => {
      const u = Math.max(0, Math.min(1, (v - a) / (b - a)));
      return u * u * (3 - 2 * u);
    };
    return Math.min(ramp(sun.rise - 35 * 60, sun.rise + 25 * 60, clock), 1 - ramp(sun.set - 25 * 60, sun.set + 35 * 60, clock));
  }

  const DAY = { land: "#dde2da", hob: "#eceee7", water: "#a9c2d5", park: "#c3d9b4", bldIn: "#cbc2b5", bldOut: "#d7d3cb",
    road: "#ffffff", casing: "#cbd0c8", minor: "#f7f7f3", path: "#d3dccb", rail: "#8b928e", subway: "#5f7d99",
    label: "#56645f", border: "#1d7a66", pier: "#cfd0c8", context: "#eef0ea" };
  const NIGHT = { land: "#0c1315", hob: "#121b1d", water: "#07111a", park: "#0f1e18", bldIn: "#1e2628", bldOut: "#161e20",
    road: "#2b3635", casing: "#131b1d", minor: "#222c2b", path: "#1a2521", rail: "#3a4543", subway: "#2e4a60",
    label: "#8a9c96", border: "#52c3a4", pier: "#1b2426", context: "#1c2526" };
  function hex(c) {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }
  function mix(a, b, t) {
    const x = hex(a);
    const y = hex(b);
    return "rgb(" + x.map((v, i) => Math.round(y[i] + (v - y[i]) * t)).join(",") + ")";
  }
  function palette(l) {
    const out = {};
    for (const k of Object.keys(DAY)) out[k] = mix(DAY[k], NIGHT[k], l);
    return out;
  }

  // ------------------------------------------------------------------ base map (Canvas 2D)
  let baseDirty = true;
  let baseCache = null; // {canvas, view:{cx,cy,scale}}
  let interacting = 0;

  function ringPath(ctx, flatRing) {
    const s = S();
    ctx.moveTo(sx(flatRing[0] / s), sy(flatRing[1] / s));
    for (let i = 2; i < flatRing.length; i += 2) ctx.lineTo(sx(flatRing[i] / s), sy(flatRing[i + 1] / s));
    ctx.closePath();
  }

  function polys(ctx, list, fill) {
    ctx.beginPath();
    for (const poly of list) for (const ring of poly) ringPath(ctx, ring);
    ctx.fillStyle = fill;
    ctx.fill("evenodd");
  }

  const ROAD_W = { 1: 16, 2: 14, 3: 13, 4: 11, 5: 9, 6: 5, 7: 2.4, 8: 2.6 };

  function drawBase() {
    const ctx = baseCanvas.getContext("2d");
    const d = DPR();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const P = palette(light);
    const s = S();
    ctx.fillStyle = P.land;
    ctx.fillRect(0, 0, W, Hh);
    polys(ctx, data.hoboken, P.hob);
    polys(ctx, data.water, P.water);
    polys(ctx, data.parks, P.park);
    polys(ctx, data.piers, P.pier);

    // Context roads outside the routing area.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const [cls, pts] of data.contextRoads) {
      ctx.beginPath();
      ctx.moveTo(sx(pts[0] / s), sy(pts[1] / s));
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(sx(pts[i] / s), sy(pts[i + 1] / s));
      ctx.strokeStyle = cls <= 3 ? P.road : P.context;
      ctx.lineWidth = Math.max(0.6, ROAD_W[cls] * 0.8 * view.scale);
      ctx.stroke();
    }
    // Streets from the routing graph, grouped by class so each class is one stroke.
    const byClass = new Map();
    for (let e = 0; e < world.nE; e++) {
      const c = world.ecls[e];
      if (!byClass.has(c)) byClass.set(c, []);
      byClass.get(c).push(e);
    }
    const order = [8, 7, 6, 5, 4, 3, 2, 1];
    for (const pass of ["casing", "fill"]) {
      for (const cls of order) {
        const list = byClass.get(cls);
        if (!list) continue;
        if (pass === "casing" && cls >= 6) continue;
        ctx.beginPath();
        for (const e of list) {
          const o = world.gOff[e];
          ctx.moveTo(sx(world.gx[o]), sy(world.gy[o]));
          for (let j = o + 1; j < world.gOff[e + 1]; j++) ctx.lineTo(sx(world.gx[j]), sy(world.gy[j]));
        }
        const wpx = Math.max(cls >= 7 ? 0.7 : 1, ROAD_W[cls] * view.scale);
        if (pass === "casing") {
          ctx.strokeStyle = P.casing;
          ctx.lineWidth = wpx + Math.max(1, 1.5 * view.scale);
        } else {
          ctx.strokeStyle = cls >= 7 ? P.path : cls === 6 ? P.minor : P.road;
          ctx.lineWidth = wpx;
          ctx.setLineDash(cls >= 7 && view.scale > 0.5 ? [3, 3] : []);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Rail: NJ Transit and light rail at grade, PATH in tunnels (dashed).
    for (const [code, pts] of data.rail) {
      ctx.beginPath();
      ctx.moveTo(sx(pts[0] / s), sy(pts[1] / s));
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(sx(pts[i] / s), sy(pts[i + 1] / s));
      ctx.strokeStyle = code === 12 ? P.subway : P.rail;
      ctx.lineWidth = code === 12 ? 1.4 : 1;
      ctx.setLineDash(code === 12 ? [5, 4] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Buildings.
    ctx.beginPath();
    for (const b of data.buildings) if (b.in) ringPath(ctx, b.p);
    ctx.fillStyle = P.bldIn;
    ctx.fill();
    ctx.beginPath();
    for (const b of data.buildings) if (!b.in) ringPath(ctx, b.p);
    ctx.fillStyle = P.bldOut;
    ctx.fill();
    // City line.
    ctx.beginPath();
    for (const poly of data.hoboken) ringPath(ctx, poly[0]);
    ctx.strokeStyle = P.border;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Labels.
    ctx.fillStyle = P.label;
    ctx.textAlign = "center";
    ctx.font = "600 12px " + getComputedStyle(document.body).getPropertyValue("--ui");
    for (const nb of data.neighbors) {
      if (!["Jersey City", "Union City", "Weehawken"].includes(nb.name)) continue;
      const x = sx(nb.label[0] / s);
      const y = sy(nb.label[1] / s);
      if (x > 30 && x < W - 30 && y > 20 && y < Hh - 20) label(ctx, nb.name.toUpperCase(), x, y, 0);
    }
    label(ctx, "MANHATTAN", sx(1600), sy(420), 0);
    label(ctx, "HUDSON RIVER", sx(1000), sy(-150), -Math.PI / 2.35);
    baseCache = null;
    baseDirty = false;
  }

  function label(ctx, text, x, y, angle) {
    if (x < -50 || x > W + 50 || y < -20 || y > Hh + 20) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.letterSpacing = "2px";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  /** While panning/zooming, redraw the last full render transformed instead of re-rasterising. */
  function drawBaseFast() {
    const ctx = baseCanvas.getContext("2d");
    if (!baseCache) {
      const c = document.createElement("canvas");
      c.width = baseCanvas.width;
      c.height = baseCanvas.height;
      c.getContext("2d").drawImage(baseCanvas, 0, 0);
      baseCache = { canvas: c, view: Object.assign({}, view) };
    }
    const o = baseCache.view;
    const f = view.scale / o.scale;
    const ox = (W / 2) * (1 - f) + (o.cx - view.cx) * view.scale;
    const oy = (Hh / 2) * (1 - f) - (o.cy - view.cy) * view.scale;
    const d = DPR();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = palette(light).land;
    ctx.fillRect(0, 0, baseCanvas.width, baseCanvas.height);
    ctx.drawImage(baseCache.canvas, ox * d, oy * d, baseCache.canvas.width * f, baseCache.canvas.height * f);
  }

  // ------------------------------------------------------------------ people (WebGL points)
  const agentLayer = (function () {
    const gl = glCanvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    const fallback = !gl;
    let prog;
    let posBuf;
    let styleBuf;
    let pos;
    let style;
    let loc;
    if (gl) {
      const vs = `
        attribute vec2 a_pos; attribute float a_style;
        uniform vec2 u_center; uniform vec2 u_scale; uniform float u_pt; uniform float u_pass;
        varying float v_style;
        void main() {
          float st = mod(a_style, 8.0);
          v_style = a_style;
          bool moving = st > 1.5;
          if (st > 4.5 || (u_pass < 0.5 && moving) || (u_pass > 0.5 && !moving)) {
            gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; return;
          }
          gl_Position = vec4((a_pos - u_center) * u_scale, 0.0, 1.0);
          gl_PointSize = st < 1.5 ? u_pt * 0.8 : (st > 3.5 ? u_pt * 1.9 : (st > 2.5 ? u_pt * 1.7 : u_pt * 1.4));
        }`;
      const fs = `
        precision mediump float;
        varying float v_style;
        uniform vec3 u_c0; uniform vec3 u_c1; uniform vec3 u_c2; uniform vec3 u_c3;
        uniform float u_rest; uniform float u_move;
        void main() {
          float st = mod(v_style, 8.0);
          float w = floor(v_style / 8.0);
          vec2 p = gl_PointCoord - 0.5;
          float a;
          if (st > 3.5) { a = step(max(abs(p.x), abs(p.y)), 0.42); }
          else if (st > 2.5) { a = step(abs(p.x) + abs(p.y), 0.5); }
          else { a = 1.0 - smoothstep(0.36, 0.5, length(p)); }
          vec3 c = w < 0.5 ? u_c0 : (w < 1.5 ? u_c1 : (w < 2.5 ? u_c2 : u_c3));
          float alpha = (st < 1.5 ? u_rest : u_move) * a;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(c * alpha, alpha);
        }`;
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      loc = {};
      for (const n of ["a_pos", "a_style"]) loc[n] = gl.getAttribLocation(prog, n);
      for (const n of ["u_center", "u_scale", "u_pt", "u_pass", "u_c0", "u_c1", "u_c2", "u_c3", "u_rest", "u_move"]) loc[n] = gl.getUniformLocation(prog, n);
      posBuf = gl.createBuffer();
      styleBuf = gl.createBuffer();
    }
    const COLORS = {
      day: [[0x2a, 0x78, 0xd6], [0xeb, 0x68, 0x34], [0x1b, 0xaf, 0x7a], [0x6d, 0x7d, 0x77]],
      night: [[0x55, 0x98, 0xe7], [0xe9, 0x74, 0x42], [0x2b, 0xc2, 0x8a], [0x8f, 0xa2, 0x9b]],
    };
    return {
      fallback,
      allocate(n) {
        pos = new Float32Array(n * 2);
        style = new Float32Array(n);
        if (!gl) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, pos.byteLength, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, styleBuf);
        gl.bufferData(gl.ARRAY_BUFFER, style.byteLength, gl.DYNAMIC_DRAW);
      },
      draw() {
        const n = sim.n;
        for (let i = 0; i < n; i++) {
          pos[2 * i] = xs[i];
          pos[2 * i + 1] = ys[i];
          style[i] = who[i] * 8 + states[i];
        }
        if (!gl) return drawAgents2d();
        gl.viewport(0, 0, glCanvas.width, glCanvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
        gl.enableVertexAttribArray(loc.a_pos);
        gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, styleBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, style);
        gl.enableVertexAttribArray(loc.a_style);
        gl.vertexAttribPointer(loc.a_style, 1, gl.FLOAT, false, 0, 0);
        gl.uniform2f(loc.u_center, view.cx, view.cy);
        gl.uniform2f(loc.u_scale, (2 * view.scale) / W, (2 * view.scale) / Hh);
        const d = DPR();
        gl.uniform1f(loc.u_pt, Math.max(1.6 * d, Math.min(5 * d, 2.3 * d * Math.sqrt(view.scale / 0.3))));
        const cs = light > 0.5 ? COLORS.day : COLORS.night;
        ["u_c0", "u_c1", "u_c2", "u_c3"].forEach((u, k) => gl.uniform3f(loc[u], cs[k][0] / 255, cs[k][1] / 255, cs[k][2] / 255));
        gl.uniform1f(loc.u_rest, light > 0.5 ? 0.3 : 0.42);
        gl.uniform1f(loc.u_move, 0.95);
        for (const pass of [0, 1]) {
          gl.uniform1f(loc.u_pass, pass);
          gl.drawArrays(gl.POINTS, 0, n);
        }
      },
    };
  })();

  /** Canvas 2D fallback when WebGL is unavailable: moving people only. */
  function drawAgents2d() {
    const ctx = glCanvas.getContext("2d");
    if (!ctx) return;
    const d = DPR();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    const colors = ["#2a78d6", "#eb6834", "#1baf7a", "#6d7d77"];
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = colors[k];
      ctx.beginPath();
      for (let i = 0; i < sim.n; i++) {
        if (who[i] !== k || states[i] < 2 || states[i] > 4) continue;
        ctx.rect(sx(xs[i]) - 1.5, sy(ys[i]) - 1.5, 3, 3);
      }
      ctx.fill();
    }
  }

  // ------------------------------------------------------------------ overlay
  const GATE_SHORT = { path: "PATH", njt: "NJ Transit", hblr_term: "Light rail", hblr_2nd: "Light rail 2nd St",
    hblr_9th: "Light rail 9th St", ferry_term: "Ferry", ferry_14: "Ferry 14th St", road_n: "To Weehawken & Lincoln Tunnel",
    road_nw: "14th St Viaduct", road_w: "To JC Heights", road_s: "To Downtown JC", walk_s: "Walkway to Newport",
    walk_n: "Walkway to Lincoln Harbor" };
  const GATE_COMPACT = Object.assign({}, GATE_SHORT, { road_n: "Weehawken", road_w: "JC Heights", road_s: "Downtown JC",
    walk_s: "Newport walkway", walk_n: "Lincoln Harbor walkway", hblr_2nd: "Light rail", hblr_9th: "Light rail" });
  const TERMINAL = new Set(["path", "njt", "ferry_term", "hblr_term"]);

  function drawOverlay() {
    const ctx = overlay.getContext("2d");
    const d = DPR();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    const css = getComputedStyle(document.body);
    const accent = light > 0.5 ? "#1d7a66" : "#52c3a4";
    const ink = light > 0.5 ? "#132320" : "#e6efeb";
    const act = sim.gatewayActivity(simT, 900);
    const terminal = [];
    const ringK = Math.max(0.45, Math.min(1, view.scale / 0.3));
    const names = W < 700 ? GATE_COMPACT : GATE_SHORT;
    const tag = (text, x, y, r, side) => {
      const wText = ctx.measureText(text).width;
      const right = side !== undefined ? side : x + r + 4 + wText < W - 6;
      const tx = right ? x + r + 4 : x - r - 4 - wText;
      ctx.lineWidth = 3;
      ctx.strokeStyle = light > 0.5 ? "rgba(249,251,249,0.9)" : "rgba(11,18,17,0.9)";
      ctx.strokeText(text, tx, y);
      ctx.fillStyle = ink;
      ctx.fillText(text, tx, y);
    };
    ctx.font = "600 11px " + css.getPropertyValue("--ui");
    ctx.textAlign = "left";
    for (const g of data.gateways) {
      const a = world.gate[g.id];
      const stat = act.get(a);
      const count = stat ? stat.in + stat.out : 0;
      const x = sx(world.aX[a]);
      const y = sy(world.aY[a]);
      const r = 4 + Math.sqrt(count) * 1.4 * ringK;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = count ? 0.9 : 0.35;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (TERMINAL.has(g.id) && view.scale < 0.9) {
        if (count) terminal.push([names[g.id], count, x, y, r]);
        continue;
      }
      if (count >= 20 || view.scale > 0.55) tag(names[g.id] + (count ? " · " + fmt(count) : ""), x, y + 4, r);
    }
    if (terminal.length) {
      // Hoboken Terminal's four gateways sit on top of each other: one label block beside them.
      const cx = Math.max(...terminal.map((g) => g[2] + g[4]));
      const top = Math.min(...terminal.map((g) => g[3])) - 8;
      terminal.sort((p, q) => q[1] - p[1]);
      const widest = Math.max(...terminal.map((g) => ctx.measureText(g[0] + " · " + fmt(g[1])).width));
      if (cx + 8 + widest < W - 6) {
        terminal.forEach((g, k) => tag(g[0] + " · " + fmt(g[1]), cx, top + k * 14, 4, true));
      } else {
        tag("Terminal · " + fmt(terminal.reduce((s, g) => s + g[1], 0)), cx, top + 14, 4);
      }
    }
    if (view.scale > 0.45) {
      // Dogs trot a couple of metres beside whoever is walking them.
      ctx.fillStyle = light > 0.5 ? "#8a5a2b" : "#c8925a";
      ctx.beginPath();
      const r = Math.max(1.2, Math.min(3, view.scale * 1.6));
      for (let i = 0; i < sim.n; i++) {
        if (states[i] === H.STATE.HIDDEN || !sim.withDog(i)) continue;
        const dx = sx(xs[i] + 1.6 * Math.cos(sim.heading[i] + 1.2));
        const dy = sy(ys[i] + 1.6 * Math.sin(sim.heading[i] + 1.2));
        if (dx < -5 || dy < -5 || dx > W + 5 || dy > Hh + 5) continue;
        ctx.moveTo(dx + r, dy);
        ctx.arc(dx, dy, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    if (selected >= 0 && states[selected] !== H.STATE.HIDDEN) {
      const x = sx(xs[selected]);
      const y = sy(ys[selected]);
      const l = sim.cursor[selected];
      if (sim.legs.kind[l] === 1) {
        const r = sim.routeFor(l);
        ctx.beginPath();
        ctx.moveTo(sx(r.x[0]), sy(r.y[0]));
        for (let i = 1; i < r.x.length; i++) ctx.lineTo(sx(r.x[i]), sy(r.y[i]));
        ctx.strokeStyle = ink;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = light > 0.5 ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.6)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ frame loop
  let lastFrame = performance.now();
  let lastPanel = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (ready) {
      if (playing) {
        simT += dt * speed;
        if (simT >= H.DAY_END) simT = H.DAY_START;
      }
      sim.positionsAt(simT, xs, ys, states);
      const l3 = lightAt(simT);
      if (mode === "3d" && view3d) {
        light = l3;
        view3d.update(sim, xs, ys, states, who, simT, l3, sun);
        if (now - lastPanel > 250) {
          lastPanel = now;
          updatePanels();
        }
        requestAnimationFrame(frame);
        return;
      }
      if (following && selected >= 0 && states[selected] !== H.STATE.HIDDEN) {
        view.cx += (xs[selected] - view.cx) * 0.15;
        view.cy += (ys[selected] - view.cy) * 0.15;
        interacting = now;
      }
      if (Math.abs(l3 - light) > 0.03 || (l3 !== light && (l3 === 0 || l3 === 1))) {
        light = l3;
        baseDirty = true;
      }
      if (interacting && now - interacting < 160) {
        drawBaseFast();
      } else if (baseDirty || interacting) {
        interacting = 0;
        drawBase();
      }
      agentLayer.draw();
      drawOverlay();
      if (now - lastPanel > 250) {
        lastPanel = now;
        updatePanels();
      }
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ panels
  function binAt(t) {
    return Math.max(0, Math.min(H.NBINS, Math.round((t - H.DAY_START) / H.BIN)));
  }

  function updatePanels() {
    const b = binAt(simT);
    const p = sim.stats.present;
    const inTown = p[0][b] + p[1][b] + p[2][b];
    $("kIn").textContent = fmt(inTown);
    $("kAway").textContent = fmt(sim.params.residents - p[0][b]);
    $("kMoving").textContent = fmt(sim.nMovers);
    let cars = 0;
    let dogs = 0;
    for (let i = 0; i < sim.n; i++) {
      const st = states[i];
      if (st === H.STATE.HIDDEN) continue;
      if (st === H.STATE.CAR) cars++;
      if (sim.withDog(i)) dogs++;
    }
    $("kCars").textContent = fmt(cars);
    $("kDogs").textContent = fmt(dogs);
    const c = sim.crossingsUntil(simT);
    let tin = 0;
    let tout = 0;
    for (let i = 0; i < c.in.length; i++) {
      tin += c.in[i];
      tout += c.out[i];
    }
    $("kCross").textContent = fmt(tin + tout);
    $("kCrossSplit").textContent = fmt(tin) + " in · " + fmt(tout) + " out";
    const label = H.clock(simT);
    $("clockTime").textContent = label;
    $("scrubOut").textContent = label;
    const scrub = $("scrub");
    if (document.activeElement !== scrub) scrub.value = String(Math.round(simT));
    $("play").textContent = playing ? "Pause" : "Play";
    $("play").setAttribute("aria-pressed", String(playing));
    moveNowLine(b);
    drawCrossChart(c);
    if (selected >= 0) refreshPlanHighlight();
  }

  // Who's-in-Hoboken stacked area chart (SVG).
  const WHO = [{ key: 0, label: "Residents", color: "var(--s1)" }, { key: 1, label: "Commuting in", color: "var(--s2)" },
    { key: 2, label: "Visitors", color: "var(--s3)" }];
  const CW = 340;
  const CH = 150;
  const PAD = { l: 34, r: 8, t: 6, b: 20 };
  let whoMax = 1;

  function drawWhoChart() {
    const p = sim.stats.present;
    let max = 0;
    for (let b = 0; b <= H.NBINS; b++) max = Math.max(max, p[0][b] + p[1][b] + p[2][b]);
    whoMax = Math.ceil(max / 10000) * 10000;
    const x = (b) => PAD.l + ((CW - PAD.l - PAD.r) * b) / H.NBINS;
    const y = (v) => CH - PAD.b - ((CH - PAD.t - PAD.b) * v) / whoMax;
    let svg = `<svg viewBox="0 0 ${CW} ${CH}" role="img" aria-label="People in Hoboken through the day, by group">`;
    for (let v = 0; v <= whoMax; v += 20000) {
      svg += `<line x1="${PAD.l}" x2="${CW - PAD.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
      svg += `<text x="${PAD.l - 5}" y="${y(v) + 3.5}" text-anchor="end" font-size="9.5" fill="var(--muted)">${v / 1000}k</text>`;
    }
    const cum = [new Float64Array(H.NBINS + 1), new Float64Array(H.NBINS + 1), new Float64Array(H.NBINS + 1)];
    for (let b = 0; b <= H.NBINS; b++) {
      cum[0][b] = p[0][b];
      cum[1][b] = cum[0][b] + p[1][b];
      cum[2][b] = cum[1][b] + p[2][b];
    }
    for (let k = 0; k < 3; k++) {
      let d = "";
      for (let b = 0; b <= H.NBINS; b++) d += (b ? "L" : "M") + x(b).toFixed(1) + "," + y(cum[k][b]).toFixed(1);
      for (let b = H.NBINS; b >= 0; b--) d += "L" + x(b).toFixed(1) + "," + y(k ? cum[k - 1][b] : 0).toFixed(1);
      svg += `<path d="${d}Z" fill="${WHO[k].color}" fill-opacity="0.9"/>`;
    }
    for (let k = 0; k < 2; k++) {
      let d = "";
      for (let b = 0; b <= H.NBINS; b++) d += (b ? "L" : "M") + x(b).toFixed(1) + "," + y(cum[k][b]).toFixed(1);
      svg += `<path d="${d}" fill="none" stroke="var(--panel)" stroke-width="1.5"/>`;
    }
    for (const h of [4, 8, 12, 16, 20, 24]) {
      const b = ((h - 4) * 3600) / H.BIN;
      const lab = h % 24 === 0 ? "12a" : h === 12 ? "12p" : h > 12 ? h - 12 + "p" : h + "a";
      svg += `<text x="${x(b)}" y="${CH - 5}" text-anchor="middle" font-size="9.5" fill="var(--muted)">${lab}</text>`;
    }
    svg += `<line id="nowLine" x1="0" x2="0" y1="${PAD.t}" y2="${CH - PAD.b}" stroke="var(--ink)" stroke-width="1.5"/>`;
    svg += `<rect id="whoHit" x="${PAD.l}" y="${PAD.t}" width="${CW - PAD.l - PAD.r}" height="${CH - PAD.t - PAD.b}" fill="transparent"/>`;
    svg += "</svg><div class=\"tip\" id=\"whoTip\" hidden></div>";
    const host = $("whoChart");
    host.innerHTML = svg;
    const hit = host.querySelector("#whoHit");
    const tip = host.querySelector("#whoTip");
    hit.addEventListener("pointermove", (ev) => {
      const rect = host.querySelector("svg").getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * CW;
      const b = Math.max(0, Math.min(H.NBINS, Math.round(((px - PAD.l) / (CW - PAD.l - PAD.r)) * H.NBINS)));
      const t = H.DAY_START + b * H.BIN;
      tip.hidden = false;
      tip.innerHTML = `<b>${H.clock(t)}</b><br>Residents ${fmt(p[0][b])}<br>Commuting in ${fmt(p[1][b])}<br>Visitors ${fmt(p[2][b])}`;
      const left = Math.min(rect.width - 130, Math.max(0, ev.clientX - rect.left + 10));
      tip.style.left = left + "px";
      tip.style.top = "8px";
    });
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
    hit.addEventListener("click", (ev) => {
      const rect = host.querySelector("svg").getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * CW;
      simT = H.DAY_START + ((px - PAD.l) / (CW - PAD.l - PAD.r)) * (H.DAY_END - H.DAY_START);
      simT = Math.max(H.DAY_START, Math.min(H.DAY_END - 60, simT));
    });
  }

  function moveNowLine(b) {
    const line = document.getElementById("nowLine");
    if (line) {
      const xv = PAD.l + ((CW - PAD.l - PAD.r) * b) / H.NBINS;
      line.setAttribute("x1", xv);
      line.setAttribute("x2", xv);
    }
    const p = sim.stats.present;
    $("whoKeys").innerHTML = WHO.map((s) => `<span class="k"><i class="sw" style="background:${s.color}"></i>${s.label} <b>${fmt(p[s.key][b])}</b></span>`).join("");
  }

  // Crossings: leaving to the left, entering to the right, one row per channel.
  let crossMax = 1;
  function drawCrossChart(c) {
    const rows = H.CHANNELS.map((_, i) => ({ label: H.CHANNEL_LABELS[i], inn: c.in[i], out: c.out[i] }));
    const w = 340;
    const rowH = 19;
    const mid = 196;
    const half = 110;
    const h = rows.length * rowH + 22;
    const sc = (v) => (half * v) / crossMax;
    let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="People leaving and entering Hoboken so far today, by way of travel">`;
    svg += `<text x="${mid - 6}" y="11" text-anchor="end" font-size="10" fill="var(--muted)">← leaving</text>`;
    svg += `<text x="${mid + 6}" y="11" font-size="10" fill="var(--muted)">entering →</text>`;
    rows.forEach((r, k) => {
      const y = 18 + k * rowH;
      svg += `<text x="0" y="${y + 12}" font-size="11.5" fill="var(--ink-2)">${r.label}</text>`;
      const wo = sc(r.out);
      const wi = sc(r.inn);
      svg += `<rect x="${(mid - wo).toFixed(1)}" y="${y + 3}" width="${Math.max(0, wo - 1).toFixed(1)}" height="${rowH - 7}" rx="2" fill="var(--muted)" fill-opacity="0.6"/>`;
      svg += `<rect x="${mid + 1}" y="${y + 3}" width="${Math.max(0, wi - 1).toFixed(1)}" height="${rowH - 7}" rx="2" fill="var(--accent)"/>`;
      svg += `<text x="${(mid - wo - 4).toFixed(1)}" y="${y + 12}" text-anchor="end" font-size="10" fill="var(--ink-2)">${r.out ? fmt(r.out) : ""}</text>`;
      svg += `<text x="${(mid + wi + 4).toFixed(1)}" y="${y + 12}" font-size="10" fill="var(--ink-2)">${r.inn ? fmt(r.inn) : ""}</text>`;
    });
    svg += `<line x1="${mid}" x2="${mid}" y1="16" y2="${h - 2}" stroke="var(--rule)"/>`;
    svg += "</svg>";
    $("crossChart").innerHTML = svg;
  }

  // Model vs published.
  function drawChecks() {
    const c = sim.calibrationChecks();
    const cal = data.calibration;
    const o = cal.observed;
    const hb = o.hblrWeekdayBoardings2025.value;
    const hblrObs = hb["Hoboken Terminal"] + hb["2nd Street"] + hb["9th Street-Congress Street"];
    const weekday = dayType === "weekday";
    const rows = [
      ["Residents", fmt(c.residents), fmt(o.residents.value), "set", "Census 2024 estimate"],
      ["Employed residents", fmt(c.employedResidents), fmt(o.employedResidents.value), "set", "ACS 2024"],
      ["Work from home", (100 * c.wfhShare).toFixed(1) + "%", (100 * o.commuteModeShares.value.workedFromHome).toFixed(1) + "%", "set", "ACS 2024"],
      ["PATH entries, Hoboken", fmt(c.pathEntries), weekday ? "~" + fmt(cal.derived.pathHobokenWeekdayEntries.value) : "–",
        weekday ? band(c.pathEntries, cal.derived.pathHobokenWeekdayEntries.range) : "na", "derived from 2025 annual"],
      ["NJ Transit rail boardings", fmt(c.njtBoardings), weekday ? fmt(o.njtRailHobokenWeekdayBoardings2025.value) : "–",
        weekday ? near(c.njtBoardings, o.njtRailHobokenWeekdayBoardings2025.value) : "na", "2025 avg weekday"],
      ["Light rail boardings (3 stops)", fmt(c.hblrBoardings), weekday ? fmt(hblrObs) : "–", weekday ? near(c.hblrBoardings, hblrObs) : "na", "2025 avg weekday"],
    ];
    const chip = (k) => (k === "set" ? '<span class="chip set">set to match</span>' : k === "ok" ? '<span class="chip ok">within range</span>'
      : k === "gap" ? '<span class="chip gap">under</span>' : k === "over" ? '<span class="chip gap">over</span>' : "");
    $("checks").innerHTML = "<thead><tr><th>Measure</th><th class=\"num\">Model</th><th class=\"num\">Published</th><th></th></tr></thead><tbody>" +
      rows.map((r) => `<tr><td>${r[0]}<div class="conf">${r[4]}</div></td><td class="num">${r[1]}</td><td class="num">${r[2]}</td><td>${chip(r[3])}</td></tr>`).join("") +
      "</tbody>";
    $("checksNote").textContent = weekday
      ? "“Set to match” rows are inputs, not tests. Station counts are the real check. Light rail runs low because the model leaves out Jersey City Heights residents who ride the 9th Street elevator down to the light rail. Published figures came through search summaries and need re-verifying."
      : "Published station counts are weekday averages, so Saturday rows show the model only.";
  }
  function band(v, range) {
    return v < range[0] ? "gap" : v > range[1] ? "over" : "ok";
  }
  function near(v, target) {
    const r = v / target;
    return r < 0.85 ? "gap" : r > 1.15 ? "over" : "ok";
  }

  // Citi Bike: measured hourly starts at Hoboken docks.
  function drawBikeChart() {
    const cb = data.citibike;
    const wd = cb.startsByHour.weekday;
    const we = cb.startsByHour.weekend;
    const max = Math.max(...wd, ...we);
    const top = Math.ceil(max / 50) * 50;
    const w = 340;
    const h = 120;
    const pl = 30;
    const pr = 8;
    const pt = 6;
    const pb = 20;
    const x = (hr) => pl + ((w - pl - pr) * hr) / 23;
    const y = (v) => h - pb - ((h - pt - pb) * v) / top;
    const line = (arr) => arr.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1)).join("");
    let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Citi Bike trips starting at Hoboken docks by hour, weekday versus weekend">`;
    for (let v = 0; v <= top; v += 50) {
      svg += `<line x1="${pl}" x2="${w - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`;
      svg += `<text x="${pl - 5}" y="${y(v) + 3.5}" text-anchor="end" font-size="9.5" fill="var(--muted)">${v}</text>`;
    }
    for (const hr of [0, 6, 12, 18, 23]) {
      const lab = hr === 0 ? "12a" : hr === 12 ? "12p" : hr === 23 ? "11p" : hr > 12 ? hr - 12 + "p" : hr + "a";
      svg += `<text x="${x(hr)}" y="${h - 5}" text-anchor="middle" font-size="9.5" fill="var(--muted)">${lab}</text>`;
    }
    svg += `<path d="${line(we)}" fill="none" stroke="var(--ink-2)" stroke-width="2" stroke-dasharray="4 3"/>`;
    svg += `<path d="${line(wd)}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    const peak = wd.indexOf(Math.max(...wd));
    svg += `<circle cx="${x(peak)}" cy="${y(wd[peak])}" r="3.5" fill="var(--accent)"/>`;
    svg += "</svg>";
    $("bikeChart").innerHTML = svg;
    const pd = cb.perDay;
    $("bikeKeys").innerHTML = `<span class="k"><i class="sw" style="background:var(--accent)"></i>Weekday <b>${fmt(pd.weekday.internal + pd.weekday.outbound + pd.weekday.inbound)}</b> trips/day</span>` +
      `<span class="k"><i class="sw" style="background:var(--ink-2)"></i>Weekend <b>${fmt(pd.weekend.internal + pd.weekend.outbound + pd.weekend.inbound)}</b> trips/day</span>`;
    $("bikeNote").textContent = `Shown for comparison; the simulation's cyclists come from Census commute shares, not from these records. Real trip records from ${cb.stations.length} Hoboken docks (${cb.months.join(", ")}). On a weekday ${fmt(pd.weekday.internal)} trips stay inside Hoboken, ${fmt(pd.weekday.outbound)} leave and ${fmt(pd.weekday.inbound)} arrive from Jersey City docks. Peak hour: ${peak > 12 ? peak - 12 + " pm" : peak + " am"}.`;
  }

  // ------------------------------------------------------------------ person inspector
  function setFollowing(on) {
    following = on && selected >= 0;
    for (const id of ["follow", "pcFollow"]) $(id).setAttribute("aria-pressed", String(following));
    $("follow").textContent = following ? "Stop following" : "Follow on map";
    $("pcFollow").textContent = following ? "Following" : "Follow";
    if (view3d) view3d.setFollow(following ? selected : -1);
  }

  function selectPerson(i) {
    selected = i;
    setFollowing(false);
    if (view3d) view3d.setSelected(i);
    $("thought").hidden = true;
    $("personBlock").hidden = i < 0;
    $("pickCard").hidden = i < 0;
    if (i < 0 || !sim) return;
    const d = sim.describe(i);
    $("pWho").textContent = d.kind;
    $("pFacts").innerHTML = d.facts.slice(1).map((f) => `<span>${escapeHtml(f)}</span>`).join("") +
      (d.home ? `<span>${escapeHtml(d.home.replace("Home on ", "lives on "))}</span>` : "") +
      (d.jev ? `<span class="jev">Jev made ${fmt(d.jev.fromJev)} of their ${fmt(d.jev.decisions)} decisions today</span>` : "");
    $("pPlan").innerHTML = d.items.map((it, k) => `<li data-k="${k}" data-t0="${it.t0}" data-t1="${it.t1}"><time>${H.clock(it.t0)}</time><span>${escapeHtml(it.text)}</span></li>`).join("");
    $("pcWho").textContent = [d.kind].concat(d.facts.slice(1, 3)).join(" · ");
    refreshPlanHighlight();
  }

  function refreshPlanHighlight() {
    let now = "";
    for (const li of $("pPlan").children) {
      const on = simT >= Number(li.dataset.t0) && simT < Number(li.dataset.t1);
      li.classList.toggle("now", on);
      if (on) now = li.lastElementChild.textContent;
    }
    $("pcNow").textContent = now || (states && states[selected] === H.STATE.HIDDEN ? "Outside Hoboken right now" : "");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function pick(px, py) {
    let best = -1;
    let bd = 12 * 12;
    for (let i = 0; i < sim.n; i++) {
      const st = states[i];
      if (st === H.STATE.HIDDEN) continue;
      const dx = sx(xs[i]) - px;
      const dy = sy(ys[i]) - py;
      const dd = dx * dx + dy * dy - (st >= 2 ? 30 : 0);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    return best;
  }

  // "Imagine their thoughts": optional, uses the viewer's Claude through the artifact runtime.
  let sample = null;
  function connectClaude() {
    const c = window.claude;
    if (!c || typeof c.use !== "function") return;
    c.use("sample").then((fn) => {
      sample = fn;
      $("think").hidden = !fn;
    }).catch(() => {});
  }

  async function think() {
    if (!sample || selected < 0) return;
    const d = sim.describe(selected);
    const nowItem = d.items.find((it) => simT >= it.t0 && simT < it.t1);
    const plan = d.items.slice(0, 18).map((it) => H.clock(it.t0) + " " + it.text).join("\n");
    const prompt = [
      "Write a short inner monologue (2-3 sentences, first person, present tense) for a synthetic person in an agent-based simulation of a day in Hoboken, New Jersey.",
      "They are not a real individual: never give them a name and never mention real people. Only mention businesses that appear in their plan below.",
      "Ground it in Hoboken texture where it fits (the street grid, PATH, the waterfront, Washington Street), and keep it plausible and kind. Plain text only.",
      "",
      "Who: " + d.facts.join(", ") + (d.home ? ", " + d.home.toLowerCase() : ""),
      "Day: " + DATES[dayType].label,
      "Time now: " + H.clock(simT),
      "Right now: " + (nowItem ? nowItem.text : "out of Hoboken"),
      "Their plan today:",
      plan,
    ].join("\n");
    const out = $("thought");
    out.hidden = false;
    out.textContent = "Thinking…";
    $("think").disabled = true;
    try {
      await sample(prompt, { modelTier: "quick", onText: ({ text }) => { out.textContent = text; } });
    } catch (e) {
      const code = e && e.code;
      if (code === "not_granted" || code === "sampling_disabled" || code === "not_declared" || code === "capability_disabled" || code === "capability_removed") {
        $("think").hidden = true;
        out.hidden = true;
      } else if (code === "rate_limited") {
        out.textContent = (e.text || "") + " Too many requests right now; try again in a minute.";
      } else if (code === "refused") {
        out.textContent = "Claude declined this one. Pick another person.";
      } else if (code !== "cancelled") {
        out.textContent = (e && e.text ? e.text + " … " : "") + "The request didn't finish. Try again.";
      }
    } finally {
      $("think").disabled = false;
    }
  }

  // ------------------------------------------------------------------ controls and gestures
  function initControls() {
    $("play").addEventListener("click", () => {
      playing = !playing;
      updatePanels();
    });
    for (const b of $("speeds").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        speed = Number(b.dataset.speed);
        for (const o of $("speeds").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
      });
    }
    for (const b of $("days").querySelectorAll("button")) {
      b.addEventListener("click", async () => {
        if (b.dataset.day === dayType) return;
        dayType = b.dataset.day;
        for (const o of $("days").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
        syncAssumptionDefaults();
        await buildDay();
      });
    }
    const scrub = $("scrub");
    scrub.addEventListener("input", () => {
      simT = Number(scrub.value);
      $("scrubOut").textContent = H.clock(simT);
    });
    $("closePerson").addEventListener("click", () => selectPerson(-1));
    $("follow").addEventListener("click", () => setFollowing(!following));
    $("pcFollow").addEventListener("click", () => setFollowing(!following));
    $("pcClose").addEventListener("click", () => selectPerson(-1));
    $("pcDetails").addEventListener("click", () => $("personBlock").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" }));
    for (const b of $("views").querySelectorAll("button")) b.addEventListener("click", () => setMode(b.dataset.view));
    $("think").addEventListener("click", think);
    document.addEventListener("keydown", (ev) => {
      if (ev.target.closest && ev.target.closest("input, button, textarea, select")) return;
      if (ev.code === "Space") {
        ev.preventDefault();
        playing = !playing;
      }
    });
    window.addEventListener("resize", () => {
      resize();
      if (!ready) fitHoboken();
      if (view3d) view3d.resize();
    });

    // Pan, zoom, pinch and click-to-select on the overlay canvas.
    const pointers = new Map();
    let downAt = null;
    let pinch = null;
    overlay.addEventListener("pointerdown", (ev) => {
      overlay.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
      downAt = { x: ev.offsetX, y: ev.offsetY, moved: false };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
      }
    });
    overlay.addEventListener("pointermove", (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      const prev = pointers.get(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY });
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        zoomAt(mx, my, (pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d / view.scale);
      } else if (pointers.size === 1) {
        const dx = ev.offsetX - prev.x;
        const dy = ev.offsetY - prev.y;
        if (downAt && Math.hypot(ev.offsetX - downAt.x, ev.offsetY - downAt.y) > 4) downAt.moved = true;
        if (downAt && downAt.moved) {
          view.cx -= dx / view.scale;
          view.cy += dy / view.scale;
          if (following) setFollowing(false);
          interacting = performance.now();
        }
      }
    });
    const end = (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (downAt && !downAt.moved && pointers.size === 0 && ready) {
        const i = pick(ev.offsetX, ev.offsetY);
        selectPerson(i);
      }
      if (pointers.size === 0) downAt = null;
    };
    overlay.addEventListener("pointerup", end);
    overlay.addEventListener("pointercancel", end);
    overlay.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      zoomAt(ev.offsetX, ev.offsetY, Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });
  }

  function zoomAt(px, py, factor) {
    const x = wx(px);
    const y = wy(py);
    view.scale = Math.max(0.08, Math.min(6, view.scale * factor));
    view.cx = x - (px - W / 2) / view.scale;
    view.cy = y + (py - Hh / 2) / view.scale;
    interacting = performance.now();
  }

  // ------------------------------------------------------------------ assumptions
  function defaults() {
    const a = data.calibration.assumptions;
    const o = data.calibration.observed;
    return {
      wfhShare: o.commuteModeShares.value.workedFromHome,
      inboundWorkers: dayType === "weekday" ? a.inboundWorkersWeekday.value : a.inboundWorkersWeekend.value,
      visitors: dayType === "weekday" ? a.visitorsWeekday.value : a.visitorsWeekend.value,
    };
  }
  function syncAssumptionDefaults() {
    const d = defaults();
    const a = data.calibration.assumptions;
    const set = (id, v) => { $(id).value = String(v); };
    set("sWfh", overrides.wfhShare != null ? overrides.wfhShare : d.wfhShare);
    set("sIn", overrides.inboundWorkers != null ? overrides.inboundWorkers : d.inboundWorkers);
    set("sVis", overrides.visitors != null ? overrides.visitors : d.visitors);
    const r1 = dayType === "weekday" ? a.inboundWorkersWeekday.range : a.inboundWorkersWeekend.range;
    const r2 = dayType === "weekday" ? a.visitorsWeekday.range : a.visitorsWeekend.range;
    $("cIn").textContent = `Default ${fmt(d.inboundWorkers)} · plausible ${fmt(r1[0])}–${fmt(r1[1])} · low confidence`;
    $("cVis").textContent = `Default ${fmt(d.visitors)} · plausible ${fmt(r2[0])}–${fmt(r2[1])} · low confidence`;
    showAssumptionValues();
  }
  function showAssumptionValues() {
    $("oWfh").textContent = Math.round(Number($("sWfh").value) * 100) + "%";
    $("oIn").textContent = fmt(Number($("sIn").value));
    $("oVis").textContent = fmt(Number($("sVis").value));
  }
  function initAssumptions() {
    syncAssumptionDefaults();
    for (const id of ["sWfh", "sIn", "sVis"]) $(id).addEventListener("input", showAssumptionValues);
    $("rebuild").addEventListener("click", async () => {
      const d = defaults();
      const wfh = Number($("sWfh").value);
      const inbound = Number($("sIn").value);
      const vis = Number($("sVis").value);
      overrides.wfhShare = Math.abs(wfh - d.wfhShare) > 0.001 ? wfh : undefined;
      overrides.inboundWorkers = inbound !== d.inboundWorkers ? inbound : undefined;
      overrides.visitors = vis !== d.visitors ? vis : undefined;
      await buildDay();
    });
    $("resetAssume").addEventListener("click", async () => {
      delete overrides.wfhShare;
      delete overrides.inboundWorkers;
      delete overrides.visitors;
      syncAssumptionDefaults();
      await buildDay();
    });
  }

  // ------------------------------------------------------------------ about
  function fillAbout() {
    const m = data.meta;
    const o = data.calibration.observed;
    const items = [
      `<b>Map:</b> ${fmt(m.counts.buildings)} building footprints, ${fmt(m.counts.edges)} street segments with one-way rules, and ${fmt(m.counts.places)} places from Overture Maps release ${m.overtureRelease} (OpenStreetMap-derived).`,
      `<b>Homes:</b> ${fmt(o.residents.value)} residents (Census 2024 estimate) in ${fmt(data.homes.reduce((s, h) => s + h[4], 0))} households, placed in ${fmt(m.counts.homes)} residential buildings in proportion to ${fmt(m.counts.addressPoints)} address points, plus Stevens residence halls.`,
      `<b>People:</b> ages, jobs and commute modes are drawn from ACS 2024 shares (median age ${o.medianAge.value}, ${fmt(o.employedResidents.value)} employed, ${(100 * o.commuteModeShares.value.workedFromHome).toFixed(1)}% work from home, ${(100 * o.commuteModeShares.value.transit).toFixed(1)}% take transit). Commuters in, Stevens students and visitors use the assumptions above.`,
      "<b>Movement:</b> every trip follows the real street graph; drivers obey one-way streets. Rail, ferry and bus riders walk to the actual station, terminal or bus stop and leave the map there.",
      "<b>Who is shown:</b> no real people. The model uses only aggregate statistics. It doesn't read LinkedIn, voter rolls, property records or any person-level data, and it never assigns names. Business listings named after an individual (realtors, clinicians, solo practices) appear as unnamed workplaces.",
      "<b>Known gaps:</b> no deliveries, rideshare deadheading or through traffic; no weather; one representative weekday and Saturday; light-rail riders from Jersey City Heights aren't modeled; bus routes are simplified to the nearest stop.",
    ];
    $("aboutList").innerHTML = items.map((t) => `<li>${t}</li>`).join("");
    $("attrib").textContent = m.attribution + " Figures, sources and confidence levels: calibration.json.";
  }

  main();
})();
