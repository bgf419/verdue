import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { parseFjcDatasetPage } from "../scripts/duration/build-benchmarks.mjs";
import { buildDurationBenchmarksFromTsv, parseIdbDate } from "../scripts/duration/fjc-duration.mjs";
import { calculateKaplanMeier } from "../scripts/duration/km.mjs";

const FIXTURE = `CIRCUIT\tDISTRICT\tOFFICE\tDOCKET\tORIGIN\tFILEDATE\tJURIS\tNOS\tCLASSACT\tMDLDOCK\tTERMDATE\tTRCLACT\tDISP\tSTATUSCD\tTAPEYEAR
1\t01\t1\t2000001\t1\t01/01/2020\t3\t480\t1\t-8\t01/11/2020\t3\t13\tL\t2020
1\t01\t1\t2000001\t4\t01/12/2020\t3\t480\t1\t-8\t01/16/2020\t-8\t6\tL\t2020
1\t01\t1\t2000002\t2\t01/01/2020\t4\t850\t1\t-8\t01/21/2020\t2\t6\tL\t2020
1\t01\t1\t2000003\t1\t01/01/2020\t3\t440\t1\t-8\t01/01/1900\t-8\t-8\tS\t2099
1\t01\t1\t2000004\t6\t01/01/2020\t3\t367\t1\t1234\t01/06/2020\t3\t13\tL\t2020
1\t01\t1\t2000005\t13\t01/01/2020\t3\t367\t1\t1234\t01/01/1900\t-8\t-8\tS\t2099
1\t01\t1\t2000006\t1\t01/01/2020\t3\t480\t-8\t-8\t01/03/2020\t-8\t13\tL\t2020
`;

test("Kaplan-Meier computes censor-aware quantiles and leaves unestimable tails null", () => {
  const estimate = calculateKaplanMeier([
    { durationDays: 10, event: true },
    { durationDays: 15, event: false, censorReason: "pending" },
    { durationDays: 20, event: true },
    { durationDays: 30, event: false, censorReason: "pending" },
  ]);

  assert.equal(estimate.n, 4);
  assert.equal(estimate.events, 2);
  assert.equal(estimate.censored, 2);
  assert.deepEqual(estimate.censorReasons, { pending: 2 });
  assert.equal(estimate.quantiles.p25.days, 10);
  assert.equal(estimate.quantiles.median.days, 20);
  assert.equal(estimate.quantiles.p75, null);
  assert.equal(estimate.survivalAtLastObservedTime, 0.375);
});

test("FJC date parsing validates real calendar dates", () => {
  assert.equal(parseIdbDate("03/31/2026").toISOString().slice(0, 10), "2026-03-31");
  assert.equal(parseIdbDate("2026-03-31").toISOString().slice(0, 10), "2026-03-31");
  assert.equal(parseIdbDate("02/31/2026"), null);
  assert.equal(parseIdbDate("-8"), null);
});

test("FJC landing-page metadata pins the source snapshot and cumulative ZIP", () => {
  const metadata = parseFjcDatasetPage(`
    <a href="/sites/default/files/idb/textfiles/cv88on_0.zip">Civil Cases Cumulative File</a>
    (Cases terminated in SY 1988 through March 31, 2026 and cases pending as of March 31, 2026)
  `);
  assert.equal(metadata.snapshotDate, "2026-03-31");
  assert.equal(
    metadata.downloadUrl,
    "https://www.fjc.gov/sites/default/files/idb/textfiles/cv88on_0.zip",
  );
});

test("streaming FJC build reports all, non-MDL, MDL, and settlement clocks", async () => {
  const benchmark = await buildDurationBenchmarksFromTsv({
    input: Readable.from([FIXTURE]),
    snapshotDate: "2020-01-31",
    generatedAt: "2026-08-08T12:00:00.000Z",
    sourceMetadata: { coverageLabel: "Deterministic tiny fixture" },
    includeCertified: true,
  });

  assert.match(benchmark.scope.statement, /do not represent all U\.S\. class actions/i);
  assert.match(benchmark.methodology.classActionQuality, /not proof of certification/i);
  assert.equal(benchmark.quality.rowsRead, 7);
  assert.equal(benchmark.quality.classActionRows, 6);
  assert.equal(benchmark.quality.explicitPendingClassActionRows, 2);
  assert.equal(benchmark.quality.pendingTerminationDateSentinelRows, 2);
  assert.equal(benchmark.quality.repeatedDocketIdentifierRowsCollapsed, 1);
  assert.equal(benchmark.quality.negativeOrPostSnapshotDurationRowsSkipped, 0);

  const all = benchmark.cohorts.find((cohort) => cohort.id === "class_alleged_all_origins");
  assert.equal(all.clocks.allTermination.n, 5);
  assert.equal(all.clocks.allTermination.events, 3);
  assert.equal(all.clocks.allTermination.censored, 2);
  assert.equal(all.recordCounts.pendingAtSnapshot, 2);
  assert.deepEqual(all.clocks.allTermination.censorReasons, { pending_at_snapshot: 2 });
  assert.equal(all.clocks.allTermination.quantiles.p25.days, 15);

  const nonMdl = benchmark.cohorts.find(
    (cohort) => cohort.id === "class_alleged_excluding_mdl_transfer_origins",
  );
  assert.equal(nonMdl.clocks.allTermination.n, 3);
  assert.equal(nonMdl.clocks.allTermination.events, 2);
  assert.equal(nonMdl.clocks.allTermination.censored, 1);
  assert.equal(nonMdl.clocks.recordedSettlement.events, 1);
  assert.deepEqual(nonMdl.clocks.recordedSettlement.censorReasons, {
    other_termination_disposition: 1,
    pending_at_snapshot: 1,
  });

  const mdl = benchmark.cohorts.find((cohort) => cohort.id === "class_alleged_mdl_transfer_origins");
  assert.equal(mdl.clocks.allTermination.n, 2);
  assert.equal(mdl.clocks.allTermination.events, 1);
  assert.equal(mdl.recordCounts.mdlDocketPresent, 2);

  const certified = benchmark.cohorts.find(
    (cohort) => cohort.id === "class_certification_granted_all_origins",
  );
  assert.equal(certified.clocks.allTermination.n, 2);
  assert.equal(certified.clocks.allTermination.censored, 0);
  assert.match(certified.interpretation, /not a prospective duration estimate/i);
});

test("TRCLACT=3 cohorts are optional", async () => {
  const benchmark = await buildDurationBenchmarksFromTsv({
    input: Readable.from([FIXTURE]),
    snapshotDate: "2020-01-31",
    generatedAt: "2026-08-08T12:00:00.000Z",
  });
  assert.equal(benchmark.cohorts.length, 3);
  assert.equal(benchmark.cohorts.some((cohort) => cohort.highPrecisionTerminationSignal), false);
});
