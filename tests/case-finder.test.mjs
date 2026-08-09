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

async function loadCuratedCases() {
  const source = await readFile(new URL("../app/cases.ts", import.meta.url), "utf8");
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
    deadline: "2099-09-01T23:59:00-04:00",
    proof: "Records may be requested",
    geography: "Nationwide",
    finderCriteria: {
      aliases: ["example"],
      issueTypes: ["consumer"],
      situations: ["breach_notice"],
      recognitionLabel: "Example service",
      recognitionDetail: "Example recognition detail",
      essentialFacts: ["The reviewed fact sounds true."],
      eligibleStates: null,
      coveredPeriodStart: null,
      coveredPeriodEnd: null,
      noticeRequired: false,
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
      situations: ["marketing_email"],
      recognitionLabel: "Costco commercial emails",
      recognitionDetail: "Retail marketing emails",
      essentialFacts: ["You lived in Washington.", "You received a covered Costco email."],
      eligibleStates: ["washington"],
      coveredPeriodStart: "2021-06-02",
      coveredPeriodEnd: "2026-07-07",
      noticeRequired: false,
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
      situations: ["marketing_email"],
      recognitionLabel: "Costco commercial emails",
      recognitionDetail: "Retail marketing emails",
      essentialFacts: ["You lived in Washington.", "You received a covered Costco email."],
      eligibleStates: ["washington"],
      coveredPeriodStart: "2021-06-02",
      coveredPeriodEnd: "2026-07-07",
      noticeRequired: false,
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
      situations: ["breach_notice"],
      recognitionLabel: "Acme",
      recognitionDetail: "Acme service",
      essentialFacts: ["Acme contacted you."],
      eligibleStates: null,
      coveredPeriodStart: null,
      coveredPeriodEnd: null,
      noticeRequired: false,
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

test("novice screener uses ordinary situations to bound recognition prompts", async () => {
  const finder = await loadFinder();
  const breach = record({ id: "breach", company: "Breach Co" });
  const healthcare = record({
    id: "healthcare",
    company: "Health Co",
    finderCriteria: {
      ...record().finderCriteria,
      situations: ["healthcare_tool"],
      recognitionLabel: "Health Co portal",
    },
  });

  assert.deepEqual(
    finder.reviewedCandidatesForSituations([healthcare, breach], ["breach_notice"]).map((item) => item.id),
    ["breach"],
  );
  assert.deepEqual(
    finder.reviewedCandidatesForSituations([healthcare, breach], ["not_sure"]).map((item) => item.id),
    ["breach", "healthcare"],
  );
});

test("recognized company and tri-state check control screener results", async () => {
  const finder = await loadFinder();
  const comcast = record({ id: "comcast", company: "Comcast" });
  const accc = record({ id: "accc", company: "ACCC" });
  const baseAnswers = {
    situations: ["breach_notice"],
    recognizedCaseIds: ["comcast"],
  };

  const yes = finder.screenReviewedClaims([accc, comcast], {
    ...baseAnswers,
    candidateAnswers: { comcast: "yes" },
  });
  assert.deepEqual(yes.map((match) => match.item.id), ["comcast"]);
  assert.equal(yes[0].signal, "Worth reviewing");

  const unsure = finder.screenReviewedClaims([accc, comcast], {
    ...baseAnswers,
    candidateAnswers: { comcast: "unsure" },
  });
  assert.equal(unsure[0].signal, "Needs confirmation");
  assert.match(unsure[0].questionsToConfirm[0], /confirm each prompted fact/i);

  assert.deepEqual(finder.screenReviewedClaims([accc, comcast], {
    ...baseAnswers,
    candidateAnswers: { comcast: "no" },
  }), []);
});

test("recognition prevents a related brand from silently joining results", async () => {
  const finder = await loadFinder();
  const banner = record({
    id: "banner",
    company: "Banner Health",
    finderCriteria: {
      ...record().finderCriteria,
      situations: ["healthcare_tool"],
      recognitionLabel: "Banner Health Patient Account",
    },
  });
  const lifestance = record({
    id: "lifestance",
    company: "LifeStance",
    finderCriteria: {
      ...record().finderCriteria,
      situations: ["healthcare_tool"],
      recognitionLabel: "LifeStance Health",
    },
  });
  const matches = finder.screenReviewedClaims([banner, lifestance], {
    situations: ["healthcare_tool"],
    recognizedCaseIds: ["banner"],
    candidateAnswers: { banner: "yes", lifestance: "yes" },
  });
  assert.deepEqual(matches.map((match) => match.item.id), ["banner"]);
});

test("screener returns the complete deterministic union without a three-result cap", async () => {
  const finder = await loadFinder();
  const records = ["a", "b", "c", "d"].map((id) => record({ id, company: id.toUpperCase() }));
  const matches = finder.screenReviewedClaims(records, {
    situations: ["breach_notice"],
    recognizedCaseIds: records.map((item) => item.id),
    candidateAnswers: Object.fromEntries(records.map((item) => [item.id, "yes"])),
  });
  assert.deepEqual(matches.map((match) => match.item.id), ["a", "b", "c", "d"]);
});

test("not-sure alone does not become a silent match", async () => {
  const finder = await loadFinder();
  assert.deepEqual(finder.screenReviewedClaims([record()], {
    situations: ["not_sure"],
    recognizedCaseIds: [],
    candidateAnswers: {},
  }), []);
});

test("novice screener excludes expired, closed, and stale reviewed listings", async () => {
  const finder = await loadFinder();
  const future = record({ id: "future" });
  const expired = record({ id: "expired", deadline: "2000-01-01T00:00:00Z" });
  const closed = record({ id: "closed", windowStatus: "closed" });
  const stale = record({ id: "stale", freshness: "stale" });

  assert.deepEqual(
    finder.reviewedCandidatesForSituations([expired, closed, stale, future], ["breach_notice"])
      .map((item) => item.id),
    ["future"],
  );
});

test("all nine reviewed claims have recognition cues and source-backed checks", async () => {
  const curated = await loadCuratedCases();
  assert.equal(curated.cases.length, 9);
  assert.ok(curated.cases.every((item) => item.finderCriteria.recognitionLabel));
  assert.ok(curated.cases.every((item) => item.finderCriteria.recognitionDetail));
  assert.ok(curated.cases.every((item) => item.finderCriteria.situations.length >= 1));
  assert.ok(curated.cases.every((item) => item.finderCriteria.essentialFacts.length >= 1));

  const noticeRequired = Object.fromEntries(
    curated.cases.map((item) => [item.id, item.finderCriteria.noticeRequired]),
  );
  assert.equal(noticeRequired["comcast-breach"], true);
  assert.equal(noticeRequired["accc-breach"], true);
  assert.equal(noticeRequired["abc-legal"], false);
  assert.equal(noticeRequired["eisner-data"], false);
});
