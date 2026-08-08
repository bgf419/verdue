import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COURTLISTENER_QUERY_CORE,
  buildSearchQuery,
  buildSearchUrl,
  normalizeCourtListenerResult,
} from "../scripts/federal/courtlistener.mjs";
import { fetchCourtListenerPage, runFederalRefresh } from "../scripts/federal/refresh.mjs";

const OBSERVED_AT = "2026-08-08T12:00:00.000Z";

function docket({
  id,
  caseName,
  docketNumber,
  dateFiled,
  dateTerminated = null,
  description = "Class Action Complaint",
}) {
  return {
    docket_id: id,
    caseName,
    docketNumber,
    court: "District Court, D. Example",
    court_id: "exd",
    dateFiled,
    dateTerminated,
    cause: "28:1332 Diversity",
    suitNature: "370 Fraud or Truth-In-Lending",
    docket_absolute_url: `/docket/${id}/${caseName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/`,
    recap_documents: [
      {
        id: id * 10,
        docket_entry_id: id * 100,
        document_number: 1,
        entry_date_filed: dateFiled,
        description,
        document_type: "PACER Document",
        is_available: true,
        absolute_url: `/docket/${id}/1/example/`,
      },
    ],
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("query is high precision, date bounded, and restricted to federal docket results", () => {
  const query = buildSearchQuery({ startDate: "2023-08-08", endDate: "2026-08-08" });
  assert.equal(
    query,
    "description:(Class Action Complaint) AND dateFiled:[2023-08-08 TO 2026-08-08]",
  );
  assert.equal(COURTLISTENER_QUERY_CORE, "description:(Class Action Complaint)");

  const url = new URL(buildSearchUrl(query));
  assert.equal(url.origin, "https://www.courtlistener.com");
  assert.equal(url.pathname, "/api/rest/v4/search/");
  assert.equal(url.searchParams.get("type"), "r");
  assert.equal(url.searchParams.get("order_by"), "dateFiled desc");
  assert.equal(url.searchParams.get("q"), query);
});

test("normalization emits a source-only putative case and rejects loose description matches", () => {
  const record = normalizeCourtListenerResult(
    docket({
      id: 101,
      caseName: "Consumer v. Example Corp.",
      docketNumber: "1:26-cv-00101",
      dateFiled: "2026-08-01",
    }),
    { observedAt: OBSERVED_AT },
  );

  assert.equal(record.id, "courtlistener-docket-101");
  assert.equal(record.kind, "potential_class_case");
  assert.equal(record.classStatus, "putative");
  assert.equal(record.participationMode, "no_current_action");
  assert.equal(record.windowStatus, "not_applicable");
  assert.equal(record.sourceAuthority, "court_docket_metadata");
  assert.equal(record.action.label, "View CourtListener docket");
  assert.equal(record.action.type, "source_only");
  assert.equal(record.action.allowsParticipation, false);
  assert.equal(record.dateTerminated, null);
  assert.equal(record.terminationState, "termination_not_reported");
  assert.match(record.coverageCaveat, /not a complete/i);
  assert.doesNotMatch(record.action.label, /apply|join/i);

  const looseMatch = docket({
    id: 102,
    caseName: "Loose v. Match",
    docketNumber: "1:26-cv-00102",
    dateFiled: "2026-08-02",
    description: "Complaint referencing a possible class in another action",
  });
  assert.equal(normalizeCourtListenerResult(looseMatch, { observedAt: OBSERVED_AT }), null);

  const docketStyle = docket({
    id: 103,
    caseName: "Style v. Retailer",
    docketNumber: "1:26-cv-00103",
    dateFiled: "2026-08-03",
    description: "COMPLAINT against Retailer by Consumer. (CLASS ACTION) (Attachments: # 1 Summons)",
  });
  assert.ok(normalizeCourtListenerResult(docketStyle, { observedAt: OBSERVED_AT }));
});

test("page cache avoids a duplicate network request inside the source cache window", async (context) => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "federal-cache-"));
  context.after(() => rm(cacheDir, { recursive: true, force: true }));
  const url = buildSearchUrl(
    buildSearchQuery({ startDate: "2026-08-01", endDate: "2026-08-08" }),
  );
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return jsonResponse({ count: 0, next: null, previous: null, results: [] });
  };

  const first = await fetchCourtListenerPage({
    url,
    cacheDir,
    now: new Date(OBSERVED_AT),
    fetchImpl,
  });
  const second = await fetchCourtListenerPage({
    url,
    cacheDir,
    now: new Date("2026-08-08T12:05:00.000Z"),
    fetchImpl,
  });
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(requests, 1);
});

test("refresh retries a transient network failure within its explicit request budget", async (context) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "federal-retry-"));
  const cacheDir = path.join(rootDir, "cache");
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  let requests = 0;
  const result = await runFederalRefresh({
    rootDir,
    cacheDir,
    mode: "incremental",
    now: new Date(OBSERVED_AT),
    maxRequests: 2,
    requestDelayMs: 0,
    maxRetries: 1,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) throw new Error("fetch failed: ETIMEDOUT");
      return jsonResponse({ count: 0, next: null, previous: null, results: [] });
    },
  });

  assert.equal(result.coverage.status, "complete");
  assert.equal(result.coverage.retries, 1);
  assert.equal(result.coverage.networkRequests, 2);
});

test("long server Retry-After becomes a degraded resumable checkpoint without blocking", async (context) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "federal-rate-limit-"));
  const cacheDir = path.join(rootDir, "cache");
  context.after(() => rm(rootDir, { recursive: true, force: true }));
  const result = await runFederalRefresh({
    rootDir,
    cacheDir,
    mode: "full",
    now: new Date(OBSERVED_AT),
    maxRequests: 2,
    requestDelayMs: 0,
    maxRetries: 2,
    maxRetryWaitMs: 1_000,
    fetchImpl: async () =>
      new Response(JSON.stringify({ detail: "rate limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "120" },
      }),
  });

  assert.equal(result.coverage.status, "degraded");
  assert.equal(result.coverage.backfill.status, "in_progress");
  assert.equal(result.coverage.retries, 0);
  assert.match(result.coverage.error, /deferred.*120000ms/i);
  assert.ok(result.coverage.backfill.nextUrl);
});

test("full refresh resumes cursor pagination, dedupes dockets, and preserves lifecycle", async (context) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "federal-feed-"));
  const cacheDir = path.join(rootDir, "cache");
  context.after(() => rm(rootDir, { recursive: true, force: true }));

  const pageOneUrl = buildSearchUrl(
    buildSearchQuery({ startDate: "2023-08-08", endDate: "2026-08-08" }),
  );
  const pageTwoUrl = `${pageOneUrl}&cursor=fixture-page-2`;
  const firstDocket = docket({
    id: 201,
    caseName: "Alpha v. Retailer",
    docketNumber: "1:26-cv-00201",
    dateFiled: "2026-08-05",
  });
  const secondDocket = docket({
    id: 202,
    caseName: "Beta v. Platform",
    docketNumber: "2:26-cv-00202",
    dateFiled: "2026-08-04",
  });
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url === pageOneUrl) {
      return jsonResponse({ count: 2, next: pageTwoUrl, previous: null, results: [firstDocket] });
    }
    if (url === pageTwoUrl) {
      return jsonResponse({
        count: 2,
        next: null,
        previous: pageOneUrl,
        results: [structuredClone(firstDocket), secondDocket],
      });
    }
    return jsonResponse({ detail: "not found" }, 404);
  };

  const partial = await runFederalRefresh({
    rootDir,
    cacheDir,
    mode: "full",
    now: new Date(OBSERVED_AT),
    maxRequests: 1,
    requestDelayMs: 0,
    fetchImpl,
  });
  assert.equal(partial.coverage.status, "partial");
  assert.equal(partial.coverage.backfill.status, "in_progress");
  assert.equal(partial.coverage.backfill.nextUrl, pageTwoUrl);
  assert.equal(partial.recordCount, 1);

  const complete = await runFederalRefresh({
    rootDir,
    cacheDir,
    mode: "full",
    now: new Date("2026-08-09T12:00:00.000Z"),
    maxRequests: 2,
    requestDelayMs: 0,
    fetchImpl,
  });
  assert.equal(complete.coverage.status, "complete");
  assert.equal(complete.coverage.resumedFromCursor, true);
  assert.equal(complete.coverage.backfill.status, "complete");
  assert.equal(complete.recordCount, 2, "duplicate docket IDs must collapse");
  assert.deepEqual(requested, [pageOneUrl, pageTwoUrl]);
  assert.equal(
    complete.records.find((record) => record.docketId === 201).firstSeenAt,
    OBSERVED_AT,
  );
  assert.equal(
    complete.records.find((record) => record.docketId === 201).lastSeenAt,
    "2026-08-09T12:00:00.000Z",
  );
});

test("incremental merge retains old records, updates termination, and degrades without data loss", async (context) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "federal-incremental-"));
  const cacheDir = path.join(rootDir, "cache");
  context.after(() => rm(rootDir, { recursive: true, force: true }));

  const initialUrl = buildSearchUrl(
    buildSearchQuery({ startDate: "2026-08-01", endDate: "2026-08-08" }),
  );
  const initialRecord = docket({
    id: 301,
    caseName: "Gamma v. Bank",
    docketNumber: "3:26-cv-00301",
    dateFiled: "2026-08-03",
  });

  await runFederalRefresh({
    rootDir,
    cacheDir,
    mode: "incremental",
    now: new Date(OBSERVED_AT),
    incrementalDays: 7,
    maxRequests: 1,
    requestDelayMs: 0,
    fetchImpl: async (url) => {
      assert.equal(url, initialUrl);
      return jsonResponse({ count: 1, next: null, previous: null, results: [initialRecord] });
    },
  });

  const nextUrl = buildSearchUrl(
    buildSearchQuery({ startDate: "2026-08-03", endDate: "2026-08-10" }),
  );
  const terminated = { ...initialRecord, dateTerminated: "2026-08-09" };
  const newRecord = docket({
    id: 302,
    caseName: "Delta v. Service",
    docketNumber: "4:26-cv-00302",
    dateFiled: "2026-08-09",
  });
  const updated = await runFederalRefresh({
    rootDir,
    cacheDir,
    mode: "incremental",
    now: new Date("2026-08-10T12:00:00.000Z"),
    incrementalDays: 7,
    maxRequests: 1,
    requestDelayMs: 0,
    fetchImpl: async (url) => {
      assert.equal(url, nextUrl);
      return jsonResponse({ count: 2, next: null, previous: null, results: [terminated, newRecord] });
    },
  });
  assert.equal(updated.recordCount, 2);
  assert.equal(updated.records.find((record) => record.docketId === 301).dateTerminated, "2026-08-09");
  assert.equal(updated.records.find((record) => record.docketId === 301).active, false);
  assert.equal(updated.records.find((record) => record.docketId === 301).firstSeenAt, OBSERVED_AT);

  const degraded = await runFederalRefresh({
    rootDir,
    cacheDir,
    mode: "incremental",
    now: new Date("2026-08-11T12:00:00.000Z"),
    incrementalDays: 7,
    maxRequests: 1,
    requestDelayMs: 0,
    maxRetries: 0,
    cacheTtlMs: 0,
    fetchImpl: async () => jsonResponse({ detail: "rate limited" }, 429),
  });
  assert.equal(degraded.coverage.status, "degraded");
  assert.equal(degraded.coverage.stale, true);
  assert.equal(degraded.recordCount, 2, "failed refresh must retain prior records");
  assert.ok(degraded.records.every((record) => record.freshness === "stale"));

  const onDisk = JSON.parse(await readFile(path.join(rootDir, "data", "federal-cases.json"), "utf8"));
  assert.equal(onDisk.recordCount, 2);
  assert.match(onDisk.coverage.error, /HTTP 429/);
});
