#!/usr/bin/env node
// Render a video of the simulated day: a scripted flythrough of the 3D view, frame by frame.
//
//   node hoboken-sim/scripts/film.mjs [--day weekday|weekend] [--jev] [--fps 24] [--size 1280x720]
//                                     [--out dist/hoboken-<day>.mp4] [--still 3,12.5,...] [--three <dir>]
//
// --jev       replay the day with Jev's answers from web/data/jev-<day>.json
// --still     render single frames at these points of the film (seconds) as JPEGs, not the video
// --three     serve three.js r128 from a local copy of the npm package (three@0.128.0) instead of the CDN
//
// Needs Playwright's Chromium (npm install --no-save playwright && npx playwright install chromium)
// and ffmpeg on the PATH (or FFMPEG=/path/to/ffmpeg). It renders with software WebGL, so every
// frame is reproducible on any machine; the 47-second film takes about 15 minutes on 4 CPU cores.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { unpackJev } from "../jev/run-jev.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return createRequire(import.meta.url)("playwright"); // also finds a global install via NODE_PATH
    } catch {
      throw new Error("Playwright isn't installed: npm install --no-save playwright && npx playwright install chromium");
    }
  }
}

// ------------------------------------------------------------------ camera moves
const lerp = (a, b, u) => a + (b - a) * u;
const lerp3 = (a, b, u) => a.map((v, i) => lerp(v, b[i] || 0, u));
const ease = (u) => u * u * (3 - 2 * u);
const hours = (h) => h * 3600;
// Washington Street runs about 13 degrees east of north, from (-94, -900) to (254, 600).
const WASH = { x: -94, y: -900, ux: 348 / Math.hypot(348, 1500), uy: 1500 / Math.hypot(348, 1500) };
/** A point `s` metres up Washington Street from Observer Highway, `off` metres east of its centre line. */
const onWashington = (s, off = 0) => [WASH.x + WASH.ux * s + WASH.uy * off, WASH.y + WASH.uy * s - WASH.ux * off];
/** Circle `center` at `radius` metres and `height`, from angle a0 to a1 (degrees, counter-clockwise from east). */
const orbit = (center, radius, height, a0, a1, u) => {
  const a = (lerp(a0, a1, u) * Math.PI) / 180;
  return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a), height];
};

/** The camera at `pos`, looking along `angle` (degrees, counter-clockwise from east) at a point `dist` metres away and `z` up. */
const facing = (pos, angle, dist, z) => {
  const a = (angle * Math.PI) / 180;
  return { pos, target: [pos[0] + dist * Math.cos(a), pos[1] + dist * Math.sin(a), z] };
};

/** The film: shots with a clock span (hours), a camera move and a caption. */
function shots(info) {
  const weekday = info.day === "weekday";
  const people = info.people.toLocaleString("en-US");
  return [
    {
      // From above Jersey City Heights, east over Hoboken to Manhattan as the sun comes up.
      dur: 6, clock: [6.4, 6.73],
      title: "Hoboken, New Jersey",
      sub: `One simulated ${weekday ? "Tuesday" : "Saturday"}: ${people} synthetic people on the real streets`,
      cam: (u) => ({ pos: lerp3([-1850, -1450, 520], [-1450, -1120, 400], ease(u)), target: lerp3([800, 250, 40], [900, 300, 40], ease(u)) }),
    },
    {
      dur: 6, clock: [6.75, 6.95],
      title: "First dog walks",
      sub: "The dog run at Church Square Park, before work",
      // From over the park lawn, looking southwest at the dog run.
      cam: (u) => ({ pos: orbit([-250, -318], lerp(70, 58, ease(u)), lerp(28, 21, ease(u)), 20, 45, ease(u)), target: [-248, -313, 0] }),
    },
    {
      // Down over the terminal's train shed toward the streets people walk in on.
      dur: 7, clock: [8.08, 8.36],
      title: weekday ? "Rush hour" : "Saturday morning",
      sub: weekday ? "Commuters converge on Hoboken Terminal: PATH, NJ Transit and the ferry" : "Hoboken Terminal and the south waterfront",
      cam: (u) => ({ pos: lerp3([110, -1110, 55], [60, -1090, 32], ease(u)), target: lerp3([0, -900, 0], [-10, -930, 0], ease(u)) }),
    },
    {
      dur: 7, clock: [17.8, 18.12],
      title: weekday ? "Evening rush" : "Saturday on Washington Street",
      sub: weekday ? "Heading home up Washington Street from the PATH" : "Shops, restaurants and dog walks along Hoboken's main street",
      cam: (u) => {
        const s = lerp(400, 560, u);
        return { pos: [...onWashington(s, -5), 16], target: [...onWashington(s + 220, 0), 0] };
      },
    },
    {
      // A slow pan from Midtown (the Empire State Building) to One World Trade Center.
      dur: 8, clock: [18.85, 19.2],
      title: "Sunset over Manhattan",
      sub: "From Pier A, across the Hudson from Midtown to the World Trade Center",
      cam: (u) => facing(lerp3([445, -935, 10], [452, -928, 9], u), lerp(12, -58, ease(u)), 3000, 260),
    },
    {
      dur: 7, clock: [21.65, 22.0],
      title: "Night out",
      sub: "Bars and restaurants along Washington Street",
      cam: (u) => {
        const s = lerp(1100, 1000, u);
        return { pos: [...onWashington(s, 10), 20], target: [...onWashington(s - 250, 0), 0] };
      },
    },
    {
      dur: 6, clock: [22.1, 22.8], card: true,
      cam: (u) => ({ pos: lerp3([-1300, -800, 380], [-2500, -1450, 900], ease(u)), target: lerp3([350, 0, 0], [500, 100, 0], ease(u)) }),
    },
  ];
}

/** Everything the page needs to draw film-time `s`. */
function frameAt(list, s, total) {
  let start = 0;
  for (let k = 0; k < list.length; k++) {
    const shot = list[k];
    if (s < start + shot.dur || k === list.length - 1) {
      const local = Math.min(shot.dur, s - start);
      const u = local / shot.dur;
      const cam = shot.cam(u);
      const inFade = k === 0 ? 1 : 0.35;
      const edgeIn = Math.min(1, local / inFade);
      const edgeOut = k === list.length - 1 ? Math.min(1, (total - s) / 1.2) : Math.min(1, (shot.dur - local) / 0.35);
      const caption = shot.title ? { title: shot.title, sub: shot.sub, alpha: Math.max(0, Math.min(1, (local - 0.5) / 0.6, (shot.dur - local - 0.3) / 0.6)) } : null;
      return {
        t: hours(lerp(shot.clock[0], shot.clock[1], u)),
        pos: cam.pos,
        target: cam.target,
        caption,
        card: shot.card ? Math.max(0, Math.min(1, (local - 1.2) / 0.8)) : 0,
        fade: 1 - Math.min(edgeIn, edgeOut),
      };
    }
    start += shot.dur;
  }
  return null;
}

// ------------------------------------------------------------------ the page
function page({ data, sim, view3d, width, height, config }) {
  const script = (code) => `<script>\n${code.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  const json = (id, value) => `<script type="application/json" id="${id}">${(typeof value === "string" ? value : JSON.stringify(value)).replace(/</g, "\\u003c")}</script>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Hoboken in Motion: film</title>
<style>
  html, body { margin: 0; background: #000; }
  #stage { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; color: #fff;
    font-family: "Liberation Sans", "DejaVu Sans", Arial, sans-serif; }
  #stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .clock { position: absolute; left: 36px; top: 28px; text-shadow: 0 2px 14px rgba(0, 0, 0, 0.5); }
  .clock .time { font-size: 62px; font-weight: 700; letter-spacing: -1px; line-height: 1; }
  .clock .day { margin-top: 8px; font-size: 14px; letter-spacing: 3px; text-transform: uppercase; }
  .counts { position: absolute; right: 30px; top: 30px; display: grid; grid-template-columns: auto auto; gap: 3px 16px;
    padding: 12px 16px; background: rgba(8, 14, 13, 0.55); border-radius: 10px; font-size: 14px; align-items: baseline; }
  .counts b { text-align: right; font-size: 19px; }
  .caption { position: absolute; left: 36px; bottom: 62px; max-width: 820px; text-shadow: 0 2px 16px rgba(0, 0, 0, 0.7); }
  .caption .title { font-size: 42px; font-weight: 700; letter-spacing: -0.5px; }
  .caption .sub { font-size: 20px; margin-top: 6px; }
  .credit { position: absolute; left: 36px; right: 36px; bottom: 22px; font-size: 13px; display: flex;
    justify-content: space-between; gap: 24px; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.8); opacity: 0.85; }
  .card { position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
    background: rgba(3, 7, 9, 0.66); opacity: 0; padding: 0 80px; }
  .card h1 { font-size: 58px; margin: 0 0 18px; letter-spacing: -1px; }
  .card .stats { font-size: 23px; margin: 0 0 22px; font-weight: 700; }
  .card p { font-size: 17px; margin: 5px 0; }
  .fade { position: absolute; inset: 0; background: #000; }
</style></head>
<body>
<div id="stage">
  <div class="clock"><div class="time" id="time"></div><div class="day" id="day"></div></div>
  <div class="counts" id="counts"></div>
  <div class="caption" id="caption"><div class="title" id="capTitle"></div><div class="sub" id="capSub"></div></div>
  <div class="credit"><span id="creditL"></span><span id="creditR"></span></div>
  <div class="card" id="card"></div>
  <div class="fade" id="fade"></div>
</div>
${json("hoboken-data", data)}
${json("film-config", config)}
${script(sim)}
${script(view3d)}
${script(`(async function () {
  const cfg = JSON.parse(document.getElementById("film-config").textContent);
  const data = JSON.parse(document.getElementById("hoboken-data").textContent);
  const H = window.HobokenSim;
  const S = H.STATE;
  const world = new H.World(data);
  let decisions = null;
  if (cfg.jev) {
    const bin = atob(cfg.jev.bytes);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    decisions = H.sequenceSource(cfg.jev.topics, bytes);
  }
  const sim = new H.Simulation(world, { dayType: cfg.day, decisions });
  const n = sim.n;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const states = new Uint8Array(n);
  const who = new Uint8Array(n);
  const K = H.KIND;
  for (let i = 0; i < n; i++) {
    const k = sim.kind[i];
    who[i] = k === K.RESIDENT || k === K.DORM ? 0 : k === K.VISITOR ? 2 : k === K.TRANSFER ? 3 : 1;
  }
  // Sunrise, sunset and daylight for Hoboken, as the main page computes them.
  const day = cfg.day === "weekend" ? 269 : 265;
  const rad = Math.PI / 180;
  const g = ((2 * Math.PI) / 365) * (day - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(40.745 * rad) * Math.cos(decl)) - Math.tan(40.745 * rad) * Math.tan(decl)) / rad;
  const sun = { rise: (720 - 4 * (-74.03 + ha) - eq - 240) * 60, set: (720 - 4 * (-74.03 - ha) - eq - 240) * 60 };
  const ramp = (a, b, v) => {
    const u = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  const lightAt = (t) => Math.min(ramp(sun.rise - 2100, sun.rise + 1500, t), 1 - ramp(sun.set - 1500, sun.set + 2100, t));

  await window.HobokenView3D.load();
  const stage = document.getElementById("stage");
  const view = window.HobokenView3D.create(stage, data, world, { onPick() {} });
  view.resize();
  const $ = (id) => document.getElementById(id);
  const fmt = (v) => Math.round(v).toLocaleString("en-US");
  const checks = sim.calibrationChecks();
  const info = { day: cfg.day, people: n, dogs: sim.dogs, carExits: checks.carExits, pathEntries: checks.pathEntries,
    decisions: sim.decisionStats.points, fromJev: sim.decisionStats.fromTable };
  $("day").textContent = cfg.day === "weekend" ? "Saturday · Sept 26, 2026" : "Tuesday · Sept 22, 2026";
  $("creditL").textContent = "Hoboken in Motion · every person synthetic, streets and buildings real";
  $("creditR").textContent = cfg.jev ? "Decisions: Jev (" + cfg.jev.model + ")" : "Decisions: calibrated rules";
  $("card").innerHTML = "<h1>Hoboken in Motion</h1>" +
    "<div class=stats>" + fmt(info.people) + " people · " + fmt(info.dogs) + " dogs · " + fmt(info.carExits) + " car trips out of town</div>" +
    "<p>Residents built from Census data, placed in real buildings; commuters and visitors from transit counts.</p>" +
    "<p>" + (cfg.jev ? "Jev made " + fmt(info.fromJev) + " of the day's " + fmt(info.decisions) + " decisions."
      : "Every decision in the day comes from calibrated rules, and each one can be handed to Jev.") + "</p>";
  window.film = {
    info,
    async frame(f) {
      sim.positionsAt(f.t, xs, ys, states);
      view.look(f.pos, f.target);
      view.update(sim, xs, ys, states, who, f.t, lightAt(f.t), sun);
      let inTown = 0;
      let moving = 0;
      let cars = 0;
      let dogs = 0;
      for (let i = 0; i < n; i++) {
        const s = states[i];
        if (s === S.HIDDEN) continue;
        inTown++;
        if (s === S.WALK || s === S.BIKE || s === S.CAR) moving++;
        if (s === S.CAR) cars++;
        if (s !== S.HOME && sim.withDog(i)) dogs++;
      }
      $("time").textContent = H.clock(f.t);
      $("counts").innerHTML = "<span>in Hoboken</span><b>" + fmt(inTown) + "</b><span>on the move</span><b>" + fmt(moving) +
        "</b><span>cars</span><b>" + fmt(cars) + "</b><span>dogs out</span><b>" + fmt(dogs) + "</b>";
      $("caption").style.opacity = f.caption ? String(f.caption.alpha) : "0";
      if (f.caption) {
        $("capTitle").textContent = f.caption.title;
        $("capSub").textContent = f.caption.sub;
      }
      $("card").style.opacity = String(f.card);
      $("fade").style.opacity = String(f.fade);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
  };
  document.body.dataset.ready = "1";
})().catch((err) => { document.body.dataset.error = String((err && err.stack) || err); });`)}
</body></html>`;
}

/**
 * Open the film page: the city, the day and the 3D view, ready to draw. Returns the day's figures,
 * draw(frame) for one frame, shoot() for a JPEG of it, and close().
 */
export async function openFilm(options = {}) {
  const opt = { day: "weekday", jev: false, width: 1280, height: 720, ...options };
  const [data, sim, view3d] = await Promise.all([
    readFile(join(web, "data", "hoboken.json"), "utf8"),
    readFile(join(web, "sim.js"), "utf8"),
    readFile(join(web, "view3d.js"), "utf8"),
  ]);
  const config = { day: opt.day };
  if (opt.jev) {
    const saved = JSON.parse(await readFile(join(web, "data", `jev-${opt.day}.json`), "utf8"));
    const { topics, bytes } = unpackJev(saved);
    config.jev = { model: saved.model, topics, bytes: Buffer.from(bytes).toString("base64") };
  }
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const tab = await browser.newPage({ viewport: { width: opt.width, height: opt.height }, deviceScaleFactor: 1 });
    if (opt.three) {
      await tab.route("**/three.min.js", (r) => r.fulfill({ path: join(opt.three, "build", "three.min.js"), contentType: "application/javascript" }));
      await tab.route("**/OrbitControls.js", (r) => r.fulfill({ path: join(opt.three, "examples", "js", "controls", "OrbitControls.js"), contentType: "application/javascript" }));
    }
    await tab.setContent(page({ data, sim, view3d, width: opt.width, height: opt.height, config }));
    await tab.waitForFunction(() => document.body.dataset.ready || document.body.dataset.error, null, { timeout: 300000 });
    const error = await tab.evaluate(() => document.body.dataset.error);
    if (error) throw new Error("The film page failed: " + error);
    return {
      info: await tab.evaluate(() => window.film.info),
      draw: (frame) => tab.evaluate((f) => window.film.frame(f), frame),
      shoot: () => tab.screenshot({ type: "jpeg", quality: 92 }),
      close: () => browser.close(),
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

export async function film(options = {}) {
  const opt = { fps: 24, quiet: false, ...options };
  const log = opt.quiet ? () => {} : console.log;
  const view = await openFilm(opt);
  try {
    const list = shots(view.info);
    const total = list.reduce((s, shot) => s + shot.dur, 0);
    const draw = (s) => view.draw(frameAt(list, s, total));

    if (opt.stills) {
      const outDir = opt.out || join(root, "dist", "film-stills");
      await mkdir(outDir, { recursive: true });
      const files = [];
      for (const s of opt.stills) {
        await draw(s);
        const file = join(outDir, `still-${String(s).replace(".", "_")}.jpg`);
        await writeFile(file, await view.shoot());
        files.push(file);
      }
      log(`wrote ${files.length} stills to ${outDir}`);
      return { stills: files, info: view.info };
    }

    const out = opt.out || join(root, "dist", `hoboken-${view.info.day}${opt.jev ? "-jev" : ""}.mp4`);
    await mkdir(dirname(out), { recursive: true });
    const ffmpeg = spawn(process.env.FFMPEG || "ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(opt.fps),
      "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["pipe", "inherit", "inherit"] });
    const exited = once(ffmpeg, "close");
    const failed = once(ffmpeg, "error").then(([err]) => { throw new Error("Couldn't run ffmpeg: " + err.message); });
    const frames = Math.round(total * opt.fps);
    const t0 = Date.now();
    for (let k = 0; k < frames; k++) {
      await draw(k / opt.fps);
      const jpeg = await view.shoot();
      if (!ffmpeg.stdin.write(jpeg)) await Promise.race([once(ffmpeg.stdin, "drain"), failed]);
      if (k % (opt.fps * 4) === 0 && k) {
        const per = (Date.now() - t0) / k;
        log(`frame ${k}/${frames} (${(per / 1000).toFixed(2)} s each, about ${Math.round(((frames - k) * per) / 60000)} min left)`);
      }
    }
    ffmpeg.stdin.end();
    const [code] = await Promise.race([exited, failed]);
    if (code !== 0) throw new Error("ffmpeg exited with code " + code);
    log(`wrote ${out}: ${frames} frames, ${total} s at ${opt.fps} fps, ${opt.width || 1280}x${opt.height || 720} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
    return { out, frames, seconds: total, info: view.info };
  } finally {
    await view.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { values } = parseArgs({
    options: {
      day: { type: "string", default: "weekday" },
      jev: { type: "boolean", default: false },
      fps: { type: "string", default: "24" },
      size: { type: "string", default: "1280x720" },
      out: { type: "string" },
      still: { type: "string" },
      three: { type: "string" },
    },
  });
  if (values.day !== "weekday" && values.day !== "weekend") throw new Error("--day must be weekday or weekend");
  const [width, height] = values.size.split("x").map(Number);
  film({
    day: values.day, jev: values.jev, fps: Number(values.fps), width, height, out: values.out, three: values.three,
    stills: values.still ? values.still.split(",").map(Number) : null,
  }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
