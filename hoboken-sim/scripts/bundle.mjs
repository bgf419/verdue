#!/usr/bin/env node
// Inline web/index.html + sim.js + view3d.js + app.js + data/hoboken.json into one self-contained page.
// (three.js itself still loads from cdnjs/jsDelivr when the 3D view opens.)
//
//   node hoboken-sim/scripts/bundle.mjs            -> hoboken-sim/dist/hoboken-in-motion.html (full document)
//   node hoboken-sim/scripts/bundle.mjs --fragment -> same content without <html>/<head>/<body> wrappers,
//                                                     for hosts that supply their own document skeleton
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const fragment = process.argv.includes("--fragment");

const [html, sim, view3d, app, data] = await Promise.all([
  readFile(join(web, "index.html"), "utf8"),
  readFile(join(web, "sim.js"), "utf8"),
  readFile(join(web, "view3d.js"), "utf8"),
  readFile(join(web, "app.js"), "utf8"),
  readFile(join(web, "data", "hoboken.json"), "utf8"),
]);

const script = (code) => `<script>\n${code.replace(/<\/script/gi, "<\\/script")}\n</script>`;
// Jev decision tables (from jev/run-jev.mjs) ride along when they exist.
const jev = [];
for (const day of ["weekday", "weekend"]) {
  try {
    const text = await readFile(join(web, "data", `jev-${day}.json`), "utf8");
    jev.push(`<script type="application/json" id="jev-${day}">${JSON.stringify(JSON.parse(text)).replace(/</g, "\\u003c")}</script>`);
  } catch {
    // not generated yet
  }
}
const json = JSON.stringify(JSON.parse(data)).replace(/</g, "\\u003c");

let page = html
  .replace('<script src="sim.js"></script>', () => `<script type="application/json" id="hoboken-data">${json}</script>\n${jev.join("\n")}${script(sim)}`)
  .replace('<script src="view3d.js"></script>', () => script(view3d))
  .replace('<script src="app.js"></script>', () => script(app));

if (fragment) {
  page = page
    .replace(/<!doctype html>\s*/i, "")
    .replace(/<html[^>]*>\s*/i, "")
    .replace(/<head>\s*/i, "")
    .replace(/<meta charset="utf-8">\s*/i, "")
    .replace(/<meta name="viewport"[^>]*>\s*/i, "")
    .replace(/<\/head>\s*/i, "")
    .replace(/<body>\s*/i, "")
    .replace(/<\/body>\s*/i, "")
    .replace(/<\/html>\s*/i, "");
}

const out = join(root, "dist", fragment ? "hoboken-in-motion.fragment.html" : "hoboken-in-motion.html");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, page);
console.log(`wrote ${out} (${(Buffer.byteLength(page) / 1e6).toFixed(2)} MB)`);
