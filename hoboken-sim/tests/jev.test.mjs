import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

let sdkAvailable = true;
try {
  await import("@typesafe-ai/sdk");
} catch {
  sdkAvailable = false;
}

// A local stand-in for POST /v1/systemone, following the request and response types in
// @typesafe-ai/sdk 0.6.0. It disagrees with the rules on purpose: it says yes 70% of the time
// and strongly prefers the last option of every choice, so new branches open and raking has
// work to do.
function mockTypeSafe() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      seen.push({ url: req.url, auth: req.headers.authorization, payload });
      const answers = {};
      for (const [key, q] of Object.entries(payload.questions)) {
        if (q.type === "noul") {
          answers[key] = { type: "noul", noul: 0.7 };
          continue;
        }
        const labels = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(labels.map((l, i) => [l, i === labels.length - 1 ? 0.9 : 0.1 / (labels.length - 1)]));
        answers[key] = { type: "choice", choice: labels[labels.length - 1], confidence: 0.9, probabilities };
      }
      res.writeHead(200, { "content-type": "application/json", "x-typesafe-request-id": "mock-" + seen.length });
      res.end(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: 0 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test("Jev makes every kind of decision for the people it covers, and only they change", { skip: !sdkAvailable && "run npm install in hoboken-sim first" }, async () => {
  const { runJev, loadEngine, unpackJev } = await import("../jev/run-jev.mjs");
  const mock = await mockTypeSafe();
  try {
    const out = join(await mkdtemp(join(tmpdir(), "jev-")), "jev-weekday.json");
    const result = await runJev({ people: 300, concurrency: 8, apiKey: "test-key", baseURL: mock.url, out, quiet: true });

    assert.ok(mock.seen.length >= 300, `expected at least one request per person, saw ${mock.seen.length}`);
    for (const { url, auth, payload } of mock.seen) {
      assert.equal(url, "/v1/systemone");
      assert.equal(auth, "Bearer test-key");
      assert.equal(payload.model, "jev-latest");
      assert.match(payload.state.person, /age \d+/);
      // Jev is told who the person is, never what the rules already decided for them.
      assert.doesNotMatch(payload.state.person, /from home today|commutes|by PATH|off work/);
      const questions = Object.values(payload.questions);
      assert.ok(questions.length >= 1 && questions.length <= 12);
      for (const q of questions) {
        assert.ok(q.type === "noul" || q.type === "choice", q.type);
        assert.ok(typeof q.instructions === "string" && q.instructions.length > 10, q.instructions);
        if (q.type === "choice") assert.ok(Object.keys(q.criteria).length >= 2, q.instructions);
      }
    }

    const saved = JSON.parse(await readFile(out, "utf8"));
    assert.equal(saved.format, "hoboken-jev/2");
    assert.equal(saved.model, "jev-mock");
    const families = new Set(saved.topics.map((t) => t.split(".")[0]));
    for (const f of ["work", "errand", "eve", "dog", "trip", "in", "visit", "xfer"]) assert.ok(families.has(f), `no ${f} decisions reached Jev`);
    assert.ok(result.stats.rounds >= 2, "a Jev that disagrees with the rules opens branches for later rounds");
    assert.ok(result.stats.decisionsFromJev >= 0.95 * result.stats.decisionPointsForThesePeople,
      `${result.stats.decisionsFromJev} of ${result.stats.decisionPointsForThesePeople} decisions came from Jev`);

    // Raking: the stand-in sends nearly everyone by taxi; raked, the shares match the published split.
    const mode = result.stats.raking["work.mode"];
    assert.ok(mode && mode.jev.taxi > 0.5, "the stand-in's own mode split is lopsided");
    for (const [label, share] of Object.entries(mode.target)) {
      assert.ok(Math.abs(mode.raked[label] - share) < 0.005, `${label}: raked ${mode.raked[label]} vs published ${share}`);
    }

    // The packed answers replay the same day, and only the 300 people Jev decided for change.
    const { H, world } = await loadEngine();
    const { topics, bytes } = unpackJev(saved);
    const rules = new H.Simulation(world, { dayType: "weekday" });
    const jev = new H.Simulation(world, { dayType: "weekday", decisions: H.sequenceSource(topics, bytes) });
    assert.equal(jev.decisionStats.fromTable, result.stats.decisionsFromJev);
    let changed = 0;
    for (let i = 0; i < rules.n; i++) {
      const a = rules.legEnd[i] - rules.legStart[i];
      const b = jev.legEnd[i] - jev.legStart[i];
      let same = a === b;
      for (let k = 0; same && k < a; k++) {
        same = rules.legs.b[rules.legStart[i] + k] === jev.legs.b[jev.legStart[i] + k] &&
          rules.legs.t1[rules.legStart[i] + k] === jev.legs.t1[jev.legStart[i] + k];
      }
      if (!same) {
        changed++;
        const tally = jev.decisionsByPerson[i];
        assert.ok(tally && tally[1] > 0, `person ${i} changed without a Jev decision`);
      }
    }
    assert.ok(changed > 200, `only ${changed} of 300 days changed`);
  } finally {
    mock.server.close();
  }
});
