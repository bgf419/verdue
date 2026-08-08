import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CFPB_PAYMENTS_SOURCE,
  FTC_REFUNDS_SOURCE,
  SEC_DISTRIBUTIONS_SOURCE,
  parseCfpbPayments,
  parseFtcRefunds,
  parseSecDistributions,
  participationFromWording,
} from "../scripts/government/normalize.mjs";
import {
  GOVERNMENT_SOURCE_ADAPTERS,
  refreshGovernmentRedress,
} from "../scripts/government/refresh.mjs";

const FTC_FIXTURE = `
  <main>
    <h2>Active Refund Programs</h2>
    <table>
      <thead><tr><th>Refund Program</th><th>Date</th><th>Contact Info</th></tr></thead>
      <tbody>
        <tr>
          <td><a href="/enforcement/refunds/example-refunds">Example Refunds</a></td>
          <td>July 2026</td>
          <td>Eligible consumers were identified; no action is needed. 1-800-555-0100</td>
        </tr>
        <tr>
          <td><a href="https://www.ftc.gov/enforcement/refunds/invited-refunds">Invited Refunds</a></td>
          <td>June 2026</td>
          <td>Only consumers who are contacted by the administrator may respond.</td>
        </tr>
      </tbody>
    </table>
  </main>
`;

const CFPB_FIXTURE = `
  <main>
    <div class="block">
      <div><h2 id="ongoing-cases">Ongoing cases</h2></div>
      <table>
        <thead><tr><th>Defendant name</th><th>Type of compensation</th></tr></thead>
        <tbody>
          <tr><td><a href="/enforcement/payments-harmed-consumers/payments-by-case/alpha/">Alpha LLC</a></td><td>Civil Penalty Fund</td></tr>
          <tr><td><a href="/enforcement/payments-harmed-consumers/payments-by-case/beta/">Beta LLC</a></td><td>Bureau-Administered Redress</td></tr>
        </tbody>
      </table>
    </div>
    <p>Page last modified <span><time datetime="2026-07-10T12:30:04-0400">Jul. 10, 2026</time></span></p>
    <div class="block">
      <h2 id="closed-cases">Closed cases</h2>
      <table><thead><tr><th>Defendant name</th><th>Type of compensation</th></tr></thead><tbody>
        <tr><td><a href="/enforcement/payments-harmed-consumers/payments-by-case/closed/">Closed LLC</a></td><td>Civil Penalty Fund</td></tr>
      </tbody></table>
    </div>
  </main>
`;

const CFPB_ONE_ROW_FIXTURE = CFPB_FIXTURE.replace(
  /<tr><td><a href="\/enforcement\/payments-harmed-consumers\/payments-by-case\/beta\/">[\s\S]*?<\/tr>/,
  "",
);

const SEC_FIXTURE = `
  <main>
    <h1>Distributions to Harmed Investors</h1>
    <p>Search Cases:</p>
    <ul>
      <li><a href="/enforcement-litigation/distributions-harmed-investors/alpha-fund">Alpha Fund</a></li>
      <li><a href="/enforcement-litigation/distributions-for-harmed-investors/beta-fund">Beta Fund</a></li>
      <li><a href="/enforcement-litigation/distributions-harmed-investors/archive-completed-distributions">Archive of Completed Distributions</a></li>
    </ul>
    <p>Last Reviewed or Updated: <time datetime="2026-07-01">July 1, 2026</time></p>
  </main>
`;

function fixtureFetch({
  ftcHtml = FTC_FIXTURE,
  cfpbHtml = CFPB_FIXTURE,
  secHtml = SEC_FIXTURE,
  fail = [],
} = {}) {
  return async (url) => {
    if (fail.includes(url)) return new Response("blocked", { status: 403 });
    if (url === FTC_REFUNDS_SOURCE.url) return new Response(ftcHtml, { status: 200 });
    if (url === CFPB_PAYMENTS_SOURCE.url) return new Response(cfpbHtml, { status: 200 });
    if (url === SEC_DISTRIBUTIONS_SOURCE.url) return new Response(secHtml, { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

const FIXTURE_ADAPTERS = GOVERNMENT_SOURCE_ADAPTERS.map(({ source, parse }) => ({
  source: { ...source, minimumRecords: 1 },
  parse,
}));

test("agency parsers keep public action state conservative and label first-party facts", () => {
  const checkedAt = "2026-08-08T12:00:00.000Z";
  const ftc = parseFtcRefunds(FTC_FIXTURE, { checkedAt });
  const cfpb = parseCfpbPayments(CFPB_FIXTURE, { checkedAt });
  const sec = parseSecDistributions(SEC_FIXTURE, { checkedAt });

  assert.equal(ftc.length, 2);
  assert.equal(cfpb.length, 2, "closed CFPB cases must not enter the ongoing feed");
  assert.equal(sec.length, 2, "the SEC completed-distribution archive must be excluded");
  assert.equal(ftc[0].kind, "government_redress");
  assert.equal(ftc[0].participationMode, "automatic_distribution");
  assert.equal(ftc[0].windowStatus, "not_applicable");
  assert.equal(ftc[1].participationMode, "agency_invitation_only");
  assert.equal(cfpb[0].participationMode, "unknown");
  assert.equal(cfpb[0].windowStatus, "unknown");
  assert.equal(cfpb[0].dates[0].value, "2026-07-10");
  assert.equal(sec[0].verification.authority, "agency_program_page");

  for (const record of [...ftc, ...cfpb, ...sec]) {
    assert.equal(record.verification.confidence, "HIGH");
    assert.equal(record.action.urlRole, "agency_program_page");
    assert.doesNotMatch(record.actionLabel, /apply/i);
    assert.doesNotMatch(record.action.label, /apply/i);
  }
});

test("participation modes are assigned only from explicit agency wording", () => {
  assert.equal(participationFromWording("Refunds may be available."), "unknown");
  assert.equal(
    participationFromWording("Eligible consumers have been identified; no action is needed."),
    "automatic_distribution",
  );
  assert.equal(
    participationFromWording("Only consumers who are contacted by the agency may respond."),
    "agency_invitation_only",
  );
});

test("parsers fail closed when expected agency structures disappear", () => {
  assert.throws(
    () => parseFtcRefunds("<html><p>No table</p></html>", { checkedAt: "2026-08-08T12:00:00.000Z" }),
    /could not locate/i,
  );
  assert.throws(
    () => parseSecDistributions("<main><p>No cases</p></main>", { checkedAt: "2026-08-08T12:00:00.000Z" }),
    /expected at least/i,
  );
});

test("refresh preserves lifecycle history and last-good data on source failure", async (context) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "claimcompass-government-"));
  context.after(() => rm(rootDir, { recursive: true, force: true }));

  const first = await refreshGovernmentRedress({
    rootDir,
    now: new Date("2026-08-08T12:00:00.000Z"),
    fetchImpl: fixtureFetch(),
    adapters: FIXTURE_ADAPTERS,
  });
  assert.equal(first.coverage.overallStatus, "complete");
  assert.equal(first.activeRecordCount, 6);
  assert.deepEqual(first.countsByAgency, { CFPB: 2, FTC: 2, SEC: 2 });
  assert.equal(first.history.events.length, 6);

  const second = await refreshGovernmentRedress({
    rootDir,
    now: new Date("2026-08-09T12:00:00.000Z"),
    fetchImpl: fixtureFetch(),
    adapters: FIXTURE_ADAPTERS,
  });
  assert.equal(second.history.events.length, 6, "unchanged records should not add events");
  assert.equal(second.records[0].firstSeenAt, "2026-08-08T12:00:00.000Z");
  assert.equal(second.records[0].lastSeenAt, "2026-08-09T12:00:00.000Z");

  const third = await refreshGovernmentRedress({
    rootDir,
    now: new Date("2026-08-10T12:00:00.000Z"),
    fetchImpl: fixtureFetch({
      cfpbHtml: CFPB_ONE_ROW_FIXTURE,
      fail: [FTC_REFUNDS_SOURCE.url, SEC_DISTRIBUTIONS_SOURCE.url],
    }),
    adapters: FIXTURE_ADAPTERS,
  });
  assert.equal(third.coverage.overallStatus, "degraded");
  assert.equal(third.activeRecordCount, 5);
  assert.equal(third.records.filter((record) => record.freshness === "stale").length, 4);
  assert.equal(
    third.coverage.sources.find((source) => source.id === FTC_REFUNDS_SOURCE.id)
      .staleRetentionCount,
    2,
  );
  assert.equal(
    third.records.find((record) => record.agencyCode === "FTC").lastSeenAt,
    "2026-08-09T12:00:00.000Z",
  );
  assert.equal(third.history.events.at(-1).type, "deactivated");

  const onDisk = JSON.parse(
    await readFile(path.join(rootDir, "data", "government-redress.json"), "utf8"),
  );
  assert.equal(onDisk.coverage.overallStatus, "degraded");
  assert.equal(onDisk.records.filter((record) => record.freshness === "stale").length, 4);
});
