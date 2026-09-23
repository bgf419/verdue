#!/usr/bin/env node
/*
 * Let Jev (TypeSafe AI's decision model) choose where each simulated person goes.
 *
 * The engine records every venue choice a person faces during their day (lunch, coffee, a
 * bar, a gym, a dog run...) together with the eight most likely options. This script sends
 * one System One request per person: the person is the state and each choice is a
 * `choice` question. Jev returns a probability for every option; the script samples from
 * those probabilities (so two similar people don't all pick the same café) and writes a
 * decision table. The page replays the day with that table.
 *
 *   TYPESAFE_API_KEY=... node hoboken-sim/jev/run-jev.mjs --day weekday --people 2000
 *   node hoboken-sim/jev/run-jev.mjs --dry-run            # print one request and the cost estimate
 *
 * Writes hoboken-sim/web/data/jev-<day>.json. Requires @typesafe-ai/sdk (cd hoboken-sim && npm install).
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** TypeSafe list price at launch: $42 per billion input tokens; output tokens are free. */
const USD_PER_MILLION_INPUT = 0.042;
const MAX_QUESTIONS_PER_REQUEST = 12;
const DAYS = { weekday: "Tuesday, September 22, 2026", weekend: "Saturday, September 26, 2026" };

export async function loadEngine() {
  const data = JSON.parse(await readFile(join(root, "web", "data", "hoboken.json"), "utf8"));
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(await readFile(join(root, "web", "sim.js"), "utf8"), context, { filename: "sim.js" });
  const H = context.HobokenSim;
  return { data, H, world: new H.World(data) };
}

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Describe one option the way a person would weigh it. */
function describeOption(world, from, anchor) {
  const metres = Math.round(world.distance(from, anchor) * 1.3);
  const minutes = Math.max(1, Math.round(metres / 80));
  const kind = world.dogRunAnchors.includes(anchor) ? "dog run" : world.groups[world.placeGroup[world.aRef[anchor]]];
  return `${world.anchorName(anchor)} (${kind}), ${metres} m away, about ${minutes} min on foot`;
}

/** Build System One requests for the pending decisions of the given people. */
export function buildRequests({ sim, world, H, pending, dayType, choice }) {
  const byPerson = new Map();
  for (const d of pending) {
    if (!byPerson.has(d.person)) byPerson.set(d.person, []);
    byPerson.get(d.person).push(d);
  }
  const requests = [];
  for (const [person, decisions] of byPerson) {
    const who = sim.describe(person);
    const state = {
      place: "Hoboken, New Jersey: about 59,000 people in one square mile across the Hudson from Manhattan",
      day: DAYS[dayType],
      person: who.facts.join(", ") + (who.home ? "; lives on " + who.home.replace(/^Home on /, "") : ""),
      guidance: "Each question is a separate moment in this person's day. Choose the place this person is most likely to pick, given who they are, the time, the purpose and how far each option is on foot.",
    };
    for (let i = 0; i < decisions.length; i += MAX_QUESTIONS_PER_REQUEST) {
      const questions = {};
      for (const d of decisions.slice(i, i + MAX_QUESTIONS_PER_REQUEST)) {
        const criteria = {};
        for (const a of d.options) criteria["p" + a] = describeOption(world, d.from, a);
        const when = d.clock != null ? "At " + H.clock(d.clock) : "Today";
        questions["d" + d.k] = choice(`${when}, for ${d.why}, starting from ${world.anchorName(d.from)}: where does this person go?`, criteria);
      }
      requests.push({ person, state, questions });
    }
  }
  return requests;
}

/** Sample a label from Jev's probabilities (deterministic per person and decision). */
function sampleLabel(probabilities, seed) {
  const entries = Object.entries(probabilities);
  const total = entries.reduce((s, [, p]) => s + (p > 0 ? p : 0), 0);
  if (!(total > 0)) return null;
  let r = mulberry(seed)() * total;
  for (const [label, p] of entries) {
    r -= p > 0 ? p : 0;
    if (r <= 0) return label;
  }
  return entries[entries.length - 1][0];
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export async function runJev(options = {}) {
  const opt = { day: "weekday", people: 2000, rounds: 2, concurrency: 16, seed: 20260922, maxTokens: 5e6, ...options };
  const log = opt.quiet ? () => {} : (...a) => console.log(...a);
  const { H, world } = await loadEngine();
  const sdk = await import("@typesafe-ai/sdk");
  const simOptions = { dayType: opt.day, seed: opt.seed };

  // People whose choices Jev will make.
  const first = new H.Simulation(world, { ...simOptions, recordDecisions: true });
  const everyone = [...new Set(first.decisionLog.map((d) => d.person))];
  const rng = mulberry(opt.seed ^ 0x5eed);
  for (let i = everyone.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [everyone[i], everyone[j]] = [everyone[j], everyone[i]];
  }
  const chosen = new Set(opt.people === "all" ? everyone : everyone.slice(0, Number(opt.people)));
  log(`${first.decisionLog.length.toLocaleString()} choice points for ${everyone.length.toLocaleString()} people; Jev decides for ${chosen.size.toLocaleString()} of them.`);

  const client = opt.dryRun ? null : new sdk.TypeSafeClient({ apiKey: opt.apiKey, baseURL: opt.baseURL, timeout: 30000, retry: { maxRetries: 5 } });
  const table = {};
  const usage = { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
  let model = null;
  let rounds = 0;
  let sim = first;
  for (let round = 1; round <= opt.rounds; round++) {
    if (round > 1) sim = new H.Simulation(world, { ...simOptions, recordDecisions: true, decisions: table });
    const pending = sim.decisionLog.filter((d) => chosen.has(d.person) && !d.options.includes(table[d.person + ":" + d.k]));
    if (!pending.length) break;
    rounds = round;
    const requests = buildRequests({ sim, world, H, pending, dayType: opt.day, choice: sdk.choice });
    const estimate = requests.reduce((s, r) => s + JSON.stringify(r.state).length + JSON.stringify(r.questions).length, 0) / 4;
    log(`Round ${round}: ${pending.length.toLocaleString()} decisions in ${requests.length.toLocaleString()} requests, ` +
      `~${Math.round(estimate).toLocaleString()} input tokens (~$${((estimate / 1e6) * USD_PER_MILLION_INPUT).toFixed(2)}).`);
    if (opt.dryRun) {
      log("\nFirst request (dry run, nothing sent):\n" + JSON.stringify({ model: "jev-latest", state: requests[0].state, questions: requests[0].questions }, null, 2));
      return { dryRun: true, requests: requests.length, estimatedInputTokens: Math.round(estimate) };
    }
    if (round === 1 && estimate > opt.maxTokens && !opt.yes) {
      throw new Error(`Estimated ${Math.round(estimate).toLocaleString()} input tokens is over --max-tokens ${opt.maxTokens.toLocaleString()}. Re-run with --yes to send anyway, or use fewer --people.`);
    }
    await pool(requests, opt.concurrency, async (req) => {
      try {
        const res = await client.systemOne({ state: req.state, questions: req.questions });
        model = res.model;
        usage.requests++;
        usage.inputTokens += res.usage.input_tokens;
        usage.outputTokens += res.usage.output_tokens;
        for (const [key, answer] of Object.entries(res.answers)) {
          usage.questions++;
          const k = Number(key.slice(1));
          const label = answer.probabilities ? sampleLabel(answer.probabilities, (req.person * 131 + k * 7919) ^ opt.seed) : answer.choice;
          if (label && label.startsWith("p")) table[req.person + ":" + k] = Number(label.slice(1));
        }
      } catch (err) {
        usage.failures++;
        if (err instanceof sdk.AuthenticationError || err instanceof sdk.PermissionDeniedError) throw err;
        if (usage.failures <= 3) console.warn(`Request for person ${req.person} failed: ${err.message}`);
      }
    });
    log(`  answered ${usage.questions.toLocaleString()} questions so far (${usage.failures} failed requests)`);
  }

  const replay = new H.Simulation(world, { ...simOptions, decisions: table, recordDecisions: true });
  const points = replay.decisionLog.filter((d) => chosen.has(d.person)).length;
  const result = {
    model: model || "jev-latest",
    created: new Date().toISOString(),
    dayType: opt.day,
    seed: opt.seed,
    people: chosen.size,
    decisions: table,
    stats: {
      rounds,
      requests: usage.requests,
      failedRequests: usage.failures,
      questions: usage.questions,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUSD: Number(((usage.inputTokens / 1e6) * USD_PER_MILLION_INPUT).toFixed(4)),
      decisionsFromJev: replay.decisionStats.fromTable,
      decisionPointsForThesePeople: points,
      decisionPointsCitywide: replay.decisionStats.points,
    },
    checks: { rules: first.calibrationChecks(), jev: replay.calibrationChecks() },
  };
  const out = opt.out || join(root, "web", "data", `jev-${opt.day}.json`);
  await writeFile(out, JSON.stringify(result));
  log(`Jev made ${result.stats.decisionsFromJev.toLocaleString()} of these ${points.toLocaleString()} venue choices ` +
    `(${usage.inputTokens.toLocaleString()} input tokens, ~$${result.stats.estimatedCostUSD}). Wrote ${out}`);
  const c0 = result.checks.rules;
  const c1 = result.checks.jev;
  log(`PATH entries ${Math.round(c0.pathEntries)} -> ${Math.round(c1.pathEntries)}; NJ Transit ${Math.round(c0.njtBoardings)} -> ${Math.round(c1.njtBoardings)}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { values } = parseArgs({
    options: {
      day: { type: "string", default: "weekday" },
      people: { type: "string", default: "2000" },
      rounds: { type: "string", default: "2" },
      concurrency: { type: "string", default: "16" },
      "max-tokens": { type: "string", default: "5000000" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (!DAYS[values.day]) throw new Error("--day must be weekday or weekend");
  runJev({
    day: values.day,
    people: values.people === "all" ? "all" : Number(values.people),
    rounds: Number(values.rounds),
    concurrency: Number(values.concurrency),
    maxTokens: Number(values["max-tokens"]),
    dryRun: values["dry-run"],
    yes: values.yes,
    out: values.out,
  }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
