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
// @typesafe-ai/sdk 0.6.0: it favours the last option of every choice question.
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
        const labels = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(labels.map((l, i) => [l, i === labels.length - 1 ? 0.97 : 0.03 / (labels.length - 1)]));
        answers[key] = { type: "choice", choice: labels[labels.length - 1], confidence: 0.97, probabilities };
      }
      res.writeHead(200, { "content-type": "application/json", "x-typesafe-request-id": "mock-" + seen.length });
      res.end(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: 0 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test("Jev driver sends typed choice questions and replays the answers", { skip: !sdkAvailable && "run npm install in hoboken-sim first" }, async () => {
  const { runJev, loadEngine } = await import("../jev/run-jev.mjs");
  const mock = await mockTypeSafe();
  try {
    const out = join(await mkdtemp(join(tmpdir(), "jev-")), "jev-weekday.json");
    const result = await runJev({ people: 300, rounds: 2, concurrency: 8, apiKey: "test-key", baseURL: mock.url, out, quiet: true });

    assert.ok(mock.seen.length >= 300, `expected one request per person, saw ${mock.seen.length}`);
    for (const { url, auth, payload } of mock.seen) {
      assert.equal(url, "/v1/systemone");
      assert.equal(auth, "Bearer test-key");
      assert.equal(payload.model, "jev-latest");
      assert.match(payload.state.person, /age \d+/);
      for (const q of Object.values(payload.questions)) {
        assert.equal(q.type, "choice");
        const labels = Object.keys(q.criteria);
        assert.ok(labels.length >= 1 && labels.length <= 8);
        assert.ok(labels.every((l) => /^p\d+$/.test(l)));
      }
    }

    const saved = JSON.parse(await readFile(out, "utf8"));
    assert.equal(saved.model, "jev-mock");
    assert.ok(result.stats.decisionsFromJev > 0);
    assert.ok(result.stats.decisionsFromJev >= 0.95 * result.stats.decisionPointsForThesePeople,
      `${result.stats.decisionsFromJev} of ${result.stats.decisionPointsForThesePeople} decisions applied`);

    // Only the 300 people Jev decided for may change; everyone else keeps the rule-based day.
    const { H, world } = await loadEngine();
    const rules = new H.Simulation(world, { dayType: "weekday" });
    const jev = new H.Simulation(world, { dayType: "weekday", decisions: saved.decisions });
    const decided = new Set(Object.keys(saved.decisions).map((k) => Number(k.split(":")[0])));
    assert.ok(decided.size <= 300);
    let changed = 0;
    for (let i = 0; i < rules.n; i++) {
      const a = rules.legEnd[i] - rules.legStart[i];
      const b = jev.legEnd[i] - jev.legStart[i];
      let same = a === b;
      for (let k = 0; same && k < a; k++) same = rules.legs.b[rules.legStart[i] + k] === jev.legs.b[jev.legStart[i] + k];
      if (!same) {
        changed++;
        assert.ok(decided.has(i), `person ${i} changed without a Jev decision`);
      }
    }
    assert.ok(changed > 0);
  } finally {
    mock.server.close();
  }
});
