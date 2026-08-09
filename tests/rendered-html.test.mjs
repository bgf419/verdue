import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("public product is standalone and catalog-driven", async () => {
  const [html, client, adapter, curatedSource, federal, government] = await Promise.all([
    readFile(new URL("../dist-public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../app/ClaimApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/catalog.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/cases.ts", import.meta.url), "utf8"),
    readFile(new URL("../data/federal-summary.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../data/government-redress.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(html, /<title>Verdue — class-action discovery and tracking<\/title>/i);
  assert.doesNotMatch(html + client + adapter, /chatgpt\.site|signin-with-chatgpt|oai-authenticated/i);
  assert.equal((curatedSource.match(/^ {4}id:\s*"/gm) ?? []).length, 9);
  assert.ok(federal.recordCount >= 100);
  assert.ok(government.activeRecordCount >= 1);
  assert.match(client, /Find claim windows/);
  assert.match(client, /Government redress/);
  assert.match(client, /Federal dockets indexed/);
  assert.match(client, /no termination reported · not confirmed active/i);
  assert.match(client, /Possible match ≠ eligibility decision/);
  assert.match(client, /This service is not a law firm/);
  assert.doesNotMatch(adapter, /rawCatalog|data\/catalog\.json/);
  assert.match(adapter, /official_settlement_site_checked/);
});

test("coverage claims remain bounded and source health is visible", async () => {
  const [client, catalogSource, federal, government, duration, workflow] = await Promise.all([
    readFile(new URL("../app/ClaimApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/catalog.ts", import.meta.url), "utf8"),
    readFile(new URL("../data/federal-summary.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../data/government-redress.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../data/duration-benchmarks.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../.github/workflows/refresh-and-deploy.yml", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(client + catalogSource, /all current (class actions|lawsuits)/i);
  assert.match(client, /not every U\.S\. court or settlement/i);
  assert.ok(federal.recordCount >= 100, "federal checkpoint should be materially larger than the old demo");
  assert.ok(federal.coverage.checkedAt && federal.coverage.searchUrl);
  assert.ok(government.activeRecordCount >= 1);
  assert.ok(["complete", "degraded"].includes(government.coverage.overallStatus));
  assert.ok(government.coverage.sources.every((source) => source.checkedAt && source.url));
  const defaultDuration = duration.cohorts.find((cohort) => cohort.id.includes("excluding_mdl"));
  assert.ok(defaultDuration.recordCounts.included >= 100000);
  assert.ok(defaultDuration.clocks.allTermination.quantiles.median.days > 0);
  assert.match(workflow, /cron: "17 6 \* \* \*"/);
  assert.match(workflow, /npm run government:refresh/);
  assert.match(workflow, /npm run federal:refresh/);
  assert.doesNotMatch(workflow, /npm run ingest/);
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../dist-public/robots.txt", import.meta.url));
  await access(new URL("../dist-public/sitemap.xml", import.meta.url));
});

test("public federal projection is complete for every active raw docket checkpoint", async () => {
  const [raw, projected] = await Promise.all([
    readFile(new URL("../data/federal-cases.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../dist-public/data/federal-cases.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const active = raw.records.filter((record) => record.active);
  assert.equal(projected.recordCount, active.length);
  assert.equal(projected.records.length, active.length);
  assert.ok(projected.records.every((record) => record.action.allowsParticipation === false));
});

test("public bundle includes the guided case finder and quiz", async () => {
  const assets = await readdir(new URL("../dist-public/assets/", import.meta.url));
  const javascript = await Promise.all(
    assets
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFile(new URL(`../dist-public/assets/${name}`, import.meta.url), "utf8")),
  ).then((parts) => parts.join("\n"));

  assert.match(javascript, /Verdue Case Finder/);
  assert.match(javascript, /Quick quiz/);
  assert.match(javascript, /Answers stay in this browser tab/);
  assert.match(javascript, /Open claims to review/);
  assert.doesNotMatch(javascript, /api\.openai\.com|api\.anthropic\.com/i);
});
