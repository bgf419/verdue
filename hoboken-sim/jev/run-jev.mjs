#!/usr/bin/env node
/*
 * Let Jev (TypeSafe AI's decision model) make every decision in the simulated day.
 *
 * The engine sends every behavioural choice through one hook: whether someone goes out,
 * when, how they travel, where they go and how long they stay, for people, their dogs and
 * their cars (about 900,000 decisions on a weekday). This script records those decisions
 * with their options and asks Jev, up to 12 questions per request, one person per request:
 * yes/no questions as `noul`, the rest as `choice`. It samples each answer from Jev's
 * probabilities, so similar people don't all make the same choice, and replays the day.
 *
 * A different answer can open a branch the rules never took (Jev sends someone out to dinner
 * the rules kept home); later rounds ask about those. Answers that set published totals
 * (working from home, trips out of town, travel modes, train connections) are raked: Jev decides
 * who, and the counts decide how many. --raw turns raking off.
 *
 *   TYPESAFE_API_KEY=... node hoboken-sim/jev/run-jev.mjs --day weekday --people 2000
 *   TYPESAFE_API_KEY=... node hoboken-sim/jev/run-jev.mjs --day weekday --people all --yes
 *   node hoboken-sim/jev/run-jev.mjs --dry-run            # print one request and the cost estimate
 *
 * Writes hoboken-sim/web/data/jev-<day>.json. Requires @typesafe-ai/sdk (cd hoboken-sim && npm install).
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import vm from "node:vm";
import { gunzipSync, gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** TypeSafe list price at launch: $42 per billion input tokens; output tokens are free. */
const USD_PER_MILLION_INPUT = 0.042;
const DAYS = { weekday: "Tuesday, September 22, 2026", weekend: "Saturday, September 26, 2026" };
/** Decisions that set published (or assumed) totals: Jev decides who, the totals decide how many. */
const RAKED = new Set(["work.today", "work.wfh", "work.mode", "trip.go", "trip.how", "in.mode", "stu.mode", "visit.mode", "xfer.to"]);

export async function loadEngine() {
  const data = JSON.parse(await readFile(join(root, "web", "data", "hoboken.json"), "utf8"));
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(await readFile(join(root, "web", "sim.js"), "utf8"), context, { filename: "sim.js" });
  const H = context.HobokenSim;
  return { data, H, world: new H.World(data) };
}

/** The packed answers in a jev-<day>.json file, ready for HobokenSim.sequenceSource. */
export function unpackJev(saved) {
  return { topics: saved.topics, bytes: new Uint8Array(gunzipSync(Buffer.from(saved.sequence, "base64"))) };
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

function fnv(text, seed) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** Describe one place option the way a person would weigh it. */
function describeOption(world, H, from, anchor) {
  const metres = Math.round(world.distance(from, anchor) * 1.3);
  const minutes = Math.max(1, Math.round(metres / 80));
  const kind = world.aKind[anchor];
  const what = kind === H.ANCHOR.PLACE
    ? (world.dogRunAnchors.includes(anchor) ? "dog run" : world.groups[world.placeGroup[world.aRef[anchor]]])
    : kind === H.ANCHOR.GATE ? "station or crossing" : kind === H.ANCHOR.STOP ? "bus stop" : "home";
  return `${world.anchorName(anchor)} (${what}), ${metres} m away, about ${minutes} min on foot`;
}

/** The Jev question for one recorded decision. */
export function questionFor({ world, H, sdk }, d) {
  const when = d.clock != null ? `At ${H.clock(d.clock)}: ` : "";
  if (d.kind === "yesno") return sdk.noul(when + d.question);
  const criteria = {};
  if (d.kind === "place") {
    d.anchors.forEach((a, i) => { criteria[d.labels[i]] = describeOption(world, H, d.from, a); });
    const at = d.from != null ? ` They are at ${world.anchorName(d.from)}.` : "";
    return sdk.choice(when + d.question + at, criteria);
  }
  d.labels.forEach((l, i) => { criteria[l] = d.texts ? d.texts[i] : l; });
  return sdk.choice(when + d.question, criteria);
}

/** System One requests for the pending decisions: one person per request, `batch` questions at most. */
export function buildRequests({ sim, world, H, pending, dayType, sdk, batch = 12 }) {
  const byPerson = new Map();
  for (const d of pending) {
    if (!byPerson.has(d.person)) byPerson.set(d.person, []);
    byPerson.get(d.person).push(d);
  }
  const requests = [];
  for (const [person, decisions] of byPerson) {
    const home = sim.profile[person].home;
    const state = {
      place: "Hoboken, New Jersey: about 59,000 people in one square mile across the Hudson from Manhattan",
      day: DAYS[dayType],
      person: sim.profileFacts(person).join(", ") + (home !== undefined ? "; lives on " + world.anchorName(home).replace(/^Home on /, "") : ""),
      guidance: "Each question is a separate moment in this person's day. Answer the way this person would most likely act, " +
        "given who they are, the time of day and how far each option is on foot.",
    };
    for (let i = 0; i < decisions.length; i += batch) {
      const part = decisions.slice(i, i + batch);
      const questions = {};
      part.forEach((d, j) => { questions["q" + j] = questionFor({ world, H, sdk }, d); });
      requests.push({ person, state, questions, decisions: part });
    }
  }
  return requests;
}

/** Jev's answer as probabilities over the decision's labels. */
function probabilitiesOf(answer) {
  if (!answer) return null;
  if (typeof answer.noul === "number") return { yes: answer.noul, no: 1 - answer.noul };
  if (answer.probabilities) return answer.probabilities;
  return answer.choice ? { [answer.choice]: 1 } : null;
}

function sampleLabel(labels, probs, seed) {
  let total = 0;
  for (const l of labels) total += probs[l] > 0 ? probs[l] : 0;
  if (!(total > 0)) return null;
  let r = mulberry(seed)() * total;
  for (const l of labels) {
    r -= probs[l] > 0 ? probs[l] : 0;
    if (r <= 0) return l;
  }
  return labels[labels.length - 1];
}

/**
 * Scale each option by one factor per option (iterative proportional fitting) until the
 * expected counts match the rules' totals; each person keeps Jev's relative preferences.
 */
export function rake(items) {
  const labels = [...new Set(items.flatMap(([d]) => d.labels))];
  const target = new Map(labels.map((l) => [l, 0]));
  for (const [d] of items) d.labels.forEach((l, i) => target.set(l, target.get(l) + d.prior[i]));
  const rows = items.map(([d, probs]) => {
    const row = d.labels.map((l) => (probs[l] > 0 ? probs[l] : 0));
    return row.some((x) => x > 0) ? row : d.prior.slice();
  });
  const lambda = new Map(labels.map((l) => [l, 1]));
  const out = rows.map((r) => r.slice());
  for (let iter = 0; iter < 200; iter++) {
    const sums = new Map(labels.map((l) => [l, 0]));
    items.forEach(([d], r) => {
      let z = 0;
      d.labels.forEach((l, i) => {
        out[r][i] = rows[r][i] * lambda.get(l);
        z += out[r][i];
      });
      d.labels.forEach((l, i) => {
        out[r][i] = z > 0 ? out[r][i] / z : 0;
        sums.set(l, sums.get(l) + out[r][i]);
      });
    });
    let worst = 0;
    for (const l of labels) {
      const s = sums.get(l);
      const t = target.get(l);
      if (s > 0 && t > 0) {
        lambda.set(l, (lambda.get(l) * t) / s);
        worst = Math.max(worst, Math.abs(s - t) / t);
      }
    }
    if (worst < 1e-4) break;
  }
  const share = (get) => {
    const sums = Object.fromEntries(labels.map((l) => [l, 0]));
    items.forEach(([d], r) => d.labels.forEach((l, i) => { sums[l] += get(r, i); }));
    return Object.fromEntries(labels.map((l) => [l, Number((sums[l] / items.length).toFixed(4))]));
  };
  const raw = rows.map((row) => {
    const z = row.reduce((a, b) => a + b, 0) || 1;
    return row.map((x) => x / z);
  });
  return {
    adjusted: items.map(([d], r) => Object.fromEntries(d.labels.map((l, i) => [l, out[r][i]]))),
    summary: { decisions: items.length, target: share((r, i) => items[r][0].prior[i]), jev: share((r, i) => raw[r][i]), raked: share((r, i) => out[r][i]) },
  };
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
  const opt = { day: "weekday", people: 2000, rounds: 6, concurrency: 16, batch: 12, seed: 20260922, maxTokens: 5e6, raw: false, ...options };
  const log = opt.quiet ? () => {} : (...a) => console.log(...a);
  const { H, world } = await loadEngine();
  const sdk = await import("@typesafe-ai/sdk");
  const simOptions = { dayType: opt.day, seed: opt.seed };

  // The rules' day, and the people whose decisions Jev will make.
  const first = new H.Simulation(world, simOptions);
  const everyone = Array.from({ length: first.n }, (_, i) => i);
  const rng = mulberry(opt.seed ^ 0x5eed);
  for (let i = everyone.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [everyone[i], everyone[j]] = [everyone[j], everyone[i]];
  }
  const chosen = new Set(opt.people === "all" ? everyone : everyone.slice(0, Number(opt.people)));
  const recordFor = chosen.size === everyone.length ? true : (p) => chosen.has(p);
  log(`${everyone.length.toLocaleString()} people in the day; Jev decides for ${chosen.size.toLocaleString()} of them.`);

  const client = opt.dryRun ? null : new sdk.TypeSafeClient({ apiKey: opt.apiKey, baseURL: opt.baseURL, timeout: 30000, retry: { maxRetries: 5 } });
  const table = Object.create(null); // "person|key" -> label
  const usage = { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
  const raking = {};
  let model = null;
  let rounds = 0;
  let sim = null;
  const settle = (d, probs) => {
    const label = sampleLabel(d.labels, probs, fnv(d.key, (d.person * 2654435761) ^ opt.seed));
    if (label !== null) table[d.person + "|" + d.key] = label;
  };
  for (let round = 1; round <= opt.rounds; round++) {
    sim = new H.Simulation(world, { ...simOptions, recordDecisions: recordFor, decisions: round > 1 ? H.tableSource(table) : null });
    const pending = sim.decisionLog.filter((d) => chosen.has(d.person) && !d.fromTable);
    if (!pending.length) break;
    rounds = round;
    const requests = buildRequests({ sim, world, H, pending, dayType: opt.day, sdk, batch: opt.batch });
    const estimate = requests.reduce((s, r) => s + JSON.stringify(r.state).length + JSON.stringify(r.questions).length, 0) / 4;
    log(`Round ${round}: ${pending.length.toLocaleString()} decisions in ${requests.length.toLocaleString()} requests, ` +
      `~${Math.round(estimate).toLocaleString()} input tokens (~$${((estimate / 1e6) * USD_PER_MILLION_INPUT).toFixed(2)}).`);
    if (opt.dryRun) {
      const sample = requests.find((r) => Object.keys(r.questions).length >= 6) || requests[0];
      log("\nA request (dry run, nothing sent):\n" + JSON.stringify({ model: "jev-latest", state: sample.state, questions: sample.questions }, null, 2));
      log("\nLater rounds only ask about branches Jev opens, so the whole run costs somewhat more than round 1.");
      return { dryRun: true, requests: requests.length, decisions: pending.length, estimatedInputTokens: Math.round(estimate) };
    }
    if (round === 1 && estimate > opt.maxTokens && !opt.yes) {
      throw new Error(`Estimated ${Math.round(estimate).toLocaleString()} input tokens for the first round is over --max-tokens ` +
        `${opt.maxTokens.toLocaleString()}. Re-run with --yes to send anyway, or use fewer --people.`);
    }
    const answered = [];
    await pool(requests, opt.concurrency, async (req) => {
      try {
        const res = await client.systemOne({ state: req.state, questions: req.questions });
        model = res.model;
        usage.requests++;
        usage.inputTokens += res.usage.input_tokens;
        usage.outputTokens += res.usage.output_tokens;
        req.decisions.forEach((d, j) => {
          const probs = probabilitiesOf(res.answers["q" + j]);
          if (!probs) return;
          usage.questions++;
          answered.push([d, probs]);
        });
      } catch (err) {
        usage.failures++;
        if (err instanceof sdk.AuthenticationError || err instanceof sdk.PermissionDeniedError) throw err;
        if (usage.failures <= 3) console.warn(`Request for person ${req.person} failed: ${err.message}`);
      }
    });
    const groups = new Map();
    for (const item of answered) {
      const topic = item[0].topic;
      if (!opt.raw && RAKED.has(topic)) {
        if (!groups.has(topic)) groups.set(topic, []);
        groups.get(topic).push(item);
      } else {
        settle(item[0], item[1]);
      }
    }
    for (const [topic, items] of groups) {
      const { adjusted, summary } = rake(items);
      if (round === 1) raking[topic] = summary;
      items.forEach(([d], i) => settle(d, adjusted[i]));
    }
    log(`  ${usage.questions.toLocaleString()} answers so far (${usage.failures} failed requests)`);
  }

  // Replay the day with Jev's answers, pack them for the page, and check the packed form replays identically.
  const replay = new H.Simulation(world, { ...simOptions, decisions: H.tableSource(table), recordDecisions: recordFor });
  const mine = replay.decisionLog.filter((d) => chosen.has(d.person));
  const packed = H.encodeSequence(replay.decisionLog, (p) => chosen.has(p));
  const check = new H.Simulation(world, { ...simOptions, decisions: H.sequenceSource(packed.topics, packed.bytes) });
  if (check.decisionStats.fromTable !== replay.decisionStats.fromTable || check.legs.n !== replay.legs.n) {
    throw new Error("The packed answers don't replay the same day; not writing the file.");
  }
  const sequence = gzipSync(packed.bytes, { level: 9 }).toString("base64");
  const fromJev = mine.filter((d) => d.fromTable).length;
  const result = {
    format: "hoboken-jev/2",
    model: model || "jev-latest",
    created: new Date().toISOString(),
    dayType: opt.day,
    seed: opt.seed,
    people: chosen.size,
    raked: !opt.raw,
    topics: packed.topics,
    sequence,
    stats: {
      rounds,
      requests: usage.requests,
      failedRequests: usage.failures,
      questions: usage.questions,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUSD: Number(((usage.inputTokens / 1e6) * USD_PER_MILLION_INPUT).toFixed(4)),
      decisionsFromJev: fromJev,
      decisionPointsForThesePeople: mine.length,
      decisionPointsCitywide: replay.decisionStats.points,
      packedBytes: sequence.length,
      raking,
    },
    checks: { rules: first.calibrationChecks(), jev: replay.calibrationChecks() },
  };
  const out = opt.out || join(root, "web", "data", `jev-${opt.day}.json`);
  await writeFile(out, JSON.stringify(result));
  log(`Jev made ${fromJev.toLocaleString()} of these ${mine.length.toLocaleString()} decisions ` +
    `(${usage.inputTokens.toLocaleString()} input tokens, ~$${result.stats.estimatedCostUSD}). Wrote ${out}`);
  const c0 = result.checks.rules;
  const c1 = result.checks.jev;
  log(`Working from home ${(100 * c0.wfhShare).toFixed(1)}% -> ${(100 * c1.wfhShare).toFixed(1)}%; PATH entries ${Math.round(c0.pathEntries)} -> ` +
    `${Math.round(c1.pathEntries)}; NJ Transit ${Math.round(c0.njtBoardings)} -> ${Math.round(c1.njtBoardings)}; cars out ${Math.round(c0.carExits)} -> ${Math.round(c1.carExits)}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { values } = parseArgs({
    options: {
      day: { type: "string", default: "weekday" },
      people: { type: "string", default: "2000" },
      rounds: { type: "string", default: "6" },
      concurrency: { type: "string", default: "16" },
      batch: { type: "string", default: "12" },
      "max-tokens": { type: "string", default: "5000000" },
      "dry-run": { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
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
    batch: Number(values.batch),
    maxTokens: Number(values["max-tokens"]),
    dryRun: values["dry-run"],
    raw: values.raw,
    yes: values.yes,
    out: values.out,
  }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
