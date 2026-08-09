import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadFinder() {
  const source = await readFile(new URL("../app/case-finder.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

function record(overrides = {}) {
  return {
    id: "record",
    company: "Example",
    title: "Example settlement",
    kind: "settlement_claims_open",
    windowStatus: "open",
    freshness: "current",
    deadline: "2026-09-01T23:59:00-04:00",
    proof: "Records may be requested",
    geography: "Nationwide",
    finderCriteria: {
      aliases: ["example"],
      issueTypes: ["consumer"],
      eligibleStates: null,
      coveredPeriodStart: null,
      coveredPeriodEnd: null,
      noticeMentioned: null,
    },
    ...overrides,
  };
}

test("finder returns no arbitrary records for an empty session", async () => {
  const finder = await loadFinder();
  assert.deepEqual(finder.rankCatalogCases([record()], finder.EMPTY_FINDER_PREFERENCES), []);
});

test("reviewed organization, state, and year signals rank deterministically", async () => {
  const finder = await loadFinder();
  const costco = record({
    id: "costco",
    company: "Costco",
    title: "Washington commercial email settlement",
    finderCriteria: {
      aliases: ["costco", "costco wholesale"],
      issueTypes: ["consumer", "communications"],
      eligibleStates: ["washington"],
      coveredPeriodStart: "2021-06-02",
      coveredPeriodEnd: "2026-07-07",
      noticeMentioned: null,
    },
  });
  const preferences = finder.mergeFinderPreferences(
    finder.EMPTY_FINDER_PREFERENCES,
    finder.parseFinderMessage("Costco commercial email in Washington in 2024"),
  );
  const first = finder.rankCatalogCases([record({ id: "other" }), costco], preferences);
  const second = finder.rankCatalogCases([costco, record({ id: "other" })], preferences);

  assert.equal(first[0].item.id, "costco");
  assert.deepEqual(first.map((match) => match.item.id), second.map((match) => match.item.id));
  assert.match(first[0].reasons.join(" "), /company or product matches costco/i);
  assert.match(first[0].reasons.join(" "), /includes washington/i);
});

test("verified state and covered-year contradictions are hard gates", async () => {
  const finder = await loadFinder();
  const costco = record({
    id: "costco",
    company: "Costco",
    finderCriteria: {
      aliases: ["costco"],
      issueTypes: ["communications"],
      eligibleStates: ["washington"],
      coveredPeriodStart: "2021-06-02",
      coveredPeriodEnd: "2026-07-07",
      noticeMentioned: null,
    },
  });
  const wrongState = finder.mergeFinderPreferences(finder.EMPTY_FINDER_PREFERENCES, {
    keywords: "costco 2024",
    location: "California",
  });
  const wrongYear = finder.mergeFinderPreferences(finder.EMPTY_FINDER_PREFERENCES, {
    keywords: "costco 2020",
    location: "Washington",
  });

  assert.deepEqual(finder.rankCatalogCases([costco], wrongState), []);
  assert.deepEqual(finder.rankCatalogCases([costco], wrongYear), []);
});

test("agency and docket layers require explicit scope plus an identity term", async () => {
  const finder = await loadFinder();
  const open = record({
    id: "open",
    company: "Acme",
    finderCriteria: {
      aliases: ["acme"],
      issueTypes: ["consumer"],
      eligibleStates: null,
      coveredPeriodStart: null,
      coveredPeriodEnd: null,
      noticeMentioned: null,
    },
  });
  const agency = record({
    id: "agency",
    company: "Acme Bank",
    title: "Acme Bank redress",
    kind: "government_redress",
    windowStatus: "unknown",
    proof: "Requirements not stated",
    finderCriteria: undefined,
  });
  const docket = record({
    id: "docket",
    company: "Acme Corp v. Consumer",
    title: "Acme complaint",
    kind: "potential_class_case",
    windowStatus: "not_applicable",
    proof: "Requirements not stated",
    finderCriteria: undefined,
  });

  const defaultSearch = finder.mergeFinderPreferences(finder.EMPTY_FINDER_PREFERENCES, { keywords: "acme" });
  assert.deepEqual(finder.rankCatalogCases([agency, docket, open], defaultSearch).map((match) => match.item.id), ["open"]);

  const governmentSearch = finder.mergeFinderPreferences(finder.EMPTY_FINDER_PREFERENCES, {
    goal: "government_redress",
    goalExplicit: true,
    keywords: "acme",
  });
  assert.deepEqual(finder.rankCatalogCases([agency, docket, open], governmentSearch).map((match) => match.item.id), ["agency"]);

  const unconfirmedWatch = finder.mergeFinderPreferences(finder.EMPTY_FINDER_PREFERENCES, {
    goal: "watch_cases",
    keywords: "acme",
  });
  assert.deepEqual(finder.rankCatalogCases([docket], unconfirmedWatch), []);

  const categoryOnlyWatch = finder.mergeFinderPreferences(finder.EMPTY_FINDER_PREFERENCES, {
    goal: "watch_cases",
    goalExplicit: true,
    keywords: "privacy",
  });
  assert.deepEqual(finder.rankCatalogCases([docket], categoryOnlyWatch), []);
});

test("current records rank ahead of otherwise identical stale records", async () => {
  const finder = await loadFinder();
  const preferences = finder.mergeFinderPreferences(finder.EMPTY_FINDER_PREFERENCES, { keywords: "example" });
  const matches = finder.rankCatalogCases([
    record({ id: "stale", freshness: "stale" }),
    record({ id: "current", freshness: "current" }),
  ], preferences);
  assert.deepEqual(matches.map((match) => match.item.id), ["current", "stale"]);
});

test("finder rejects common sensitive identifiers without rejecting rough years", async () => {
  const finder = await loadFinder();
  assert.equal(finder.sensitiveFinderInputReason("me@example.com"), "email address");
  assert.equal(finder.sensitiveFinderInputReason("123-45-6789"), "Social Security information");
  assert.equal(finder.sensitiveFinderInputReason("claim ID 99221"), "private identifier");
  assert.equal(finder.sensitiveFinderInputReason("987654321"), "private number");
  assert.equal(finder.sensitiveFinderInputReason("Google in Washington during 2024"), null);
});

test("saying no notice does not get interpreted as having a notice", async () => {
  const finder = await loadFinder();
  const parsed = finder.parseFinderMessage("I did not receive a notice about the breach");
  assert.equal(parsed.proof, undefined);
  assert.deepEqual(parsed.experiences, ["privacy"]);
});
