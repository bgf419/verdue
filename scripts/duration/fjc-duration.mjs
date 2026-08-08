import readline from "node:readline";

import { KaplanMeierAccumulator } from "./km.mjs";

export const FJC_IDB_SOURCE = {
  provider: "Federal Judicial Center",
  landingPageUrl: "https://www.fjc.gov/research/idb",
  datasetPageUrl:
    "https://www.fjc.gov/research/idb/civil-cases-filed-terminated-and-pending-sy-1988-present",
  downloadUrl: "https://www.fjc.gov/sites/default/files/idb/textfiles/cv88on_0.zip",
  codebookUrl:
    "https://www.fjc.gov/sites/default/files/idb/codebooks/Civil%20Codebook%201988%20Forward%2010252023.pdf",
  researchGuideUrl: "https://www.fjc.gov/sites/default/files/IDB-Research-Guide.pdf",
};

const REQUIRED_FIELDS = [
  "CIRCUIT",
  "DISTRICT",
  "OFFICE",
  "DOCKET",
  "ORIGIN",
  "FILEDATE",
  "JURIS",
  "NOS",
  "CLASSACT",
  "MDLDOCK",
  "TERMDATE",
  "TRCLACT",
  "DISP",
  "STATUSCD",
  "TAPEYEAR",
];

const MDL_TRANSFER_ORIGINS = new Set(["6", "13"]);

function parseIsoDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format; received ${value}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} is not a valid calendar date: ${value}`);
  }
  return parsed;
}

export function parseIdbDate(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "-8") return null;

  let year;
  let month;
  let day;
  let match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  } else {
    match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function daysBetween(start, end) {
  return Math.round((end.valueOf() - start.valueOf()) / 86_400_000);
}

function makeDefinitions(includeCertified) {
  const definitions = [
    {
      id: "class_alleged_all_origins",
      label: "Federal cases alleging a Rule 23 class action — all origins",
      classSignal: "CLASSACT=1",
      mdlHandling: "Includes ORIGIN 6 and 13 MDL-transfer/originating records.",
      include: () => true,
      highPrecision: false,
    },
    {
      id: "class_alleged_excluding_mdl_transfer_origins",
      label: "Federal cases alleging a Rule 23 class action — excluding MDL transfer origins",
      classSignal: "CLASSACT=1",
      mdlHandling: "Excludes ORIGIN 6 and 13 to reduce MDL member-case distortion.",
      include: (record) => !record.isMdlTransferOrigin,
      highPrecision: false,
    },
    {
      id: "class_alleged_mdl_transfer_origins",
      label: "Federal cases alleging a Rule 23 class action — MDL transfer origins only",
      classSignal: "CLASSACT=1",
      mdlHandling: "Includes only ORIGIN 6 and 13 as a separate stratum.",
      include: (record) => record.isMdlTransferOrigin,
      highPrecision: false,
    },
  ];

  if (includeCertified) {
    definitions.push(
      {
        id: "class_certification_granted_all_origins",
        label: "Federal dockets with an FJC class-action-granted termination signal — all origins",
        classSignal: "CLASSACT=1 and TRCLACT=3",
        mdlHandling: "Includes ORIGIN 6 and 13 MDL-transfer/originating records.",
        include: (record) => record.trclactGranted,
        highPrecision: true,
      },
      {
        id: "class_certification_granted_excluding_mdl_transfer_origins",
        label:
          "Federal dockets with an FJC class-action-granted termination signal — excluding MDL transfer origins",
        classSignal: "CLASSACT=1 and TRCLACT=3",
        mdlHandling: "Excludes ORIGIN 6 and 13 to reduce MDL member-case distortion.",
        include: (record) => record.trclactGranted && !record.isMdlTransferOrigin,
        highPrecision: true,
      },
    );
  }
  return definitions;
}

function makeCohort(definition) {
  return {
    definition,
    allTermination: new KaplanMeierAccumulator(),
    recordedSettlement: new KaplanMeierAccumulator(),
    rows: 0,
    pending: 0,
    terminated: 0,
    mdlDocketPresent: 0,
    dispositions: new Map(),
  };
}

function finalizeCohort(cohort) {
  return {
    id: cohort.definition.id,
    label: cohort.definition.label,
    populationFilter: cohort.definition.classSignal,
    mdlHandling: cohort.definition.mdlHandling,
    highPrecisionTerminationSignal: cohort.definition.highPrecision,
    interpretation: cohort.definition.highPrecision
      ? "Descriptive docket subcohort selected using a termination-only TRCLACT signal observed on at least one record. This conditions on an observed outcome and is not a prospective duration estimate."
      : "Right-censored federal docket-lifecycle estimate for dockets with at least one record marked CLASSACT=1.",
    recordCounts: {
      included: cohort.rows,
      terminated: cohort.terminated,
      pendingAtSnapshot: cohort.pending,
      mdlDocketPresent: cohort.mdlDocketPresent,
      terminationDispositions: Object.fromEntries(
        [...cohort.dispositions.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    clocks: {
      allTermination: {
        label: "Federal docket lifecycle: earliest class-coded filing to final recorded termination",
        start: "Earliest FILEDATE among records for the docket with CLASSACT=1",
        event: "Latest valid TERMDATE when the docket has no current pending record",
        censoring:
          "Any current STATUSCD=S/TAPEYEAR=2099 record: right-censored on the FJC snapshot date",
        ...cohort.allTermination.finalize(),
      },
      recordedSettlement: {
        label: "Time from earliest class-coded filing to first recorded settlement disposition",
        start: "Earliest FILEDATE among records for the docket with CLASSACT=1",
        event: "Earliest TERMDATE with FJC DISP=13 (settled)",
        censoring:
          "Dockets without DISP=13 are censored on the snapshot date if pending, otherwise on their final TERMDATE.",
        competingRiskCaveat:
          "This is a cause-specific Kaplan-Meier view, not a cumulative-incidence estimate; non-settlement closures are informative competing events.",
        ...cohort.recordedSettlement.finalize(),
      },
    },
  };
}

function indexesFor(headerLine) {
  const fields = headerLine.replace(/^\uFEFF/, "").split("\t").map((field) => field.trim());
  const indexes = Object.fromEntries(fields.map((field, index) => [field, index]));
  const missing = REQUIRED_FIELDS.filter((field) => indexes[field] === undefined);
  if (missing.length > 0) throw new Error(`FJC TSV is missing required fields: ${missing.join(", ")}`);
  return indexes;
}

function field(cells, indexes, name) {
  return String(cells[indexes[name]] ?? "").trim();
}

function rowKey(cells, indexes) {
  return ["CIRCUIT", "DISTRICT", "OFFICE", "DOCKET"]
    .map((name) => field(cells, indexes, name))
    .join(":");
}

export async function buildDurationBenchmarksFromTsv({
  input,
  snapshotDate,
  generatedAt = new Date().toISOString(),
  sourceMetadata = {},
  includeCertified = false,
}) {
  if (!input || typeof input[Symbol.asyncIterator] !== "function") {
    throw new Error("input must be a readable async iterable");
  }
  const snapshot = parseIsoDate(snapshotDate, "snapshotDate");
  const generated = new Date(generatedAt);
  if (Number.isNaN(generated.valueOf())) throw new Error(`generatedAt is invalid: ${generatedAt}`);

  const definitions = makeDefinitions(includeCertified);
  const cohorts = definitions.map(makeCohort);
  const quality = {
    rowsRead: 0,
    classActionRows: 0,
    explicitPendingClassActionRows: 0,
    pendingTerminationDateSentinelRows: 0,
    repeatedDocketIdentifierRowsCollapsed: 0,
    invalidFilingDateRowsSkipped: 0,
    invalidTerminationDateRowsSkipped: 0,
    ambiguousEndpointRowsSkipped: 0,
    negativeOrPostSnapshotDurationRowsSkipped: 0,
  };
  const classDockets = new Map();
  let indexes = null;

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (indexes === null) {
      if (!line.trim()) continue;
      indexes = indexesFor(line);
      continue;
    }
    if (!line.trim()) continue;
    quality.rowsRead += 1;
    const cells = line.split("\t");
    if (field(cells, indexes, "CLASSACT") !== "1") continue;
    quality.classActionRows += 1;

    // The tab export uses 01/01/1900 in TERMDATE for current pending rows.
    // STATUSCD=S and TAPEYEAR=2099 are the documented status fields, so they
    // must take precedence over the date sentinel.
    const statusCode = field(cells, indexes, "STATUSCD");
    const tapeYear = field(cells, indexes, "TAPEYEAR");
    const explicitlyPending = statusCode === "S" || tapeYear === "2099";
    const rawTerminationDate = field(cells, indexes, "TERMDATE");
    if (explicitlyPending) {
      quality.explicitPendingClassActionRows += 1;
      if (rawTerminationDate === "01/01/1900" || rawTerminationDate === "1900-01-01") {
        quality.pendingTerminationDateSentinelRows += 1;
      }
    }

    const filed = parseIdbDate(field(cells, indexes, "FILEDATE"));
    if (!filed) {
      quality.invalidFilingDateRowsSkipped += 1;
      continue;
    }

    const terminatedAt = explicitlyPending ? null : parseIdbDate(rawTerminationDate);
    if (
      !explicitlyPending &&
      rawTerminationDate &&
      rawTerminationDate !== "-8" &&
      !terminatedAt
    ) {
      quality.invalidTerminationDateRowsSkipped += 1;
      continue;
    }
    if (!explicitlyPending && !terminatedAt) {
      quality.ambiguousEndpointRowsSkipped += 1;
      continue;
    }
    const end = explicitlyPending ? snapshot : terminatedAt;
    const durationDays = daysBetween(filed, end);
    if (durationDays < 0 || end > snapshot) {
      quality.negativeOrPostSnapshotDurationRowsSkipped += 1;
      continue;
    }

    const origin = field(cells, indexes, "ORIGIN");
    const disp = field(cells, indexes, "DISP");
    const mdlDocket = field(cells, indexes, "MDLDOCK");
    const key = rowKey(cells, indexes);
    let docket = classDockets.get(key);
    if (!docket) {
      docket = {
        filedAt: filed,
        finalTerminatedAt: null,
        finalDisposition: null,
        firstSettlementAt: null,
        pending: false,
        trclactGranted: false,
        isMdlTransferOrigin: false,
        mdlDocketPresent: false,
      };
      classDockets.set(key, docket);
    } else {
      quality.repeatedDocketIdentifierRowsCollapsed += 1;
      if (filed < docket.filedAt) docket.filedAt = filed;
    }
    docket.pending ||= explicitlyPending;
    docket.trclactGranted ||= field(cells, indexes, "TRCLACT") === "3";
    docket.isMdlTransferOrigin ||= MDL_TRANSFER_ORIGINS.has(origin);
    docket.mdlDocketPresent ||= Boolean(mdlDocket && mdlDocket !== "-8");
    if (terminatedAt && (!docket.finalTerminatedAt || terminatedAt > docket.finalTerminatedAt)) {
      docket.finalTerminatedAt = terminatedAt;
      docket.finalDisposition = disp || "missing";
    }
    if (
      terminatedAt &&
      disp === "13" &&
      (!docket.firstSettlementAt || terminatedAt < docket.firstSettlementAt)
    ) {
      docket.firstSettlementAt = terminatedAt;
    }
  }
  if (indexes === null) throw new Error("FJC TSV did not contain a header row");

  for (const docket of classDockets.values()) {
    const terminated = !docket.pending;
    const lifecycleEnd = docket.pending ? snapshot : docket.finalTerminatedAt;
    if (!lifecycleEnd) {
      throw new Error("Docket aggregation invariant failed: non-pending docket has no termination");
    }
    const record = {
      allTerminationDurationDays: daysBetween(docket.filedAt, lifecycleEnd),
      settlementDurationDays: daysBetween(
        docket.filedAt,
        docket.firstSettlementAt ?? lifecycleEnd,
      ),
      settled: Boolean(docket.firstSettlementAt),
      terminated,
      finalDisposition: docket.finalDisposition,
      trclactGranted: docket.trclactGranted,
      isMdlTransferOrigin: docket.isMdlTransferOrigin,
      mdlDocketPresent: docket.mdlDocketPresent,
    };
    for (const cohort of cohorts) {
      if (!cohort.definition.include(record)) continue;
      cohort.rows += 1;
      if (record.terminated) {
        cohort.terminated += 1;
        cohort.dispositions.set(
          record.finalDisposition || "missing",
          (cohort.dispositions.get(record.finalDisposition || "missing") ?? 0) + 1,
        );
      } else {
        cohort.pending += 1;
      }
      if (record.mdlDocketPresent) cohort.mdlDocketPresent += 1;

      cohort.allTermination.add(record.allTerminationDurationDays, {
        event: record.terminated,
        censorReason: "pending_at_snapshot",
      });
      cohort.recordedSettlement.add(record.settlementDurationDays, {
        event: record.settled,
        censorReason: record.terminated ? "other_termination_disposition" : "pending_at_snapshot",
      });
    }
  }

  const allOrigins = cohorts.find(
    (cohort) => cohort.definition.id === "class_alleged_all_origins",
  );
  const reconciledClassRows =
    quality.repeatedDocketIdentifierRowsCollapsed +
    quality.invalidFilingDateRowsSkipped +
    quality.invalidTerminationDateRowsSkipped +
    quality.ambiguousEndpointRowsSkipped +
    quality.negativeOrPostSnapshotDurationRowsSkipped +
    allOrigins.rows;
  if (reconciledClassRows !== quality.classActionRows) {
    throw new Error(
      `Class-action row accounting invariant failed: ${reconciledClassRows} != ${quality.classActionRows}`,
    );
  }
  if (quality.explicitPendingClassActionRows > 0 && allOrigins.pending === 0) {
    throw new Error(
      "Pending-row invariant failed: documented STATUSCD=S/TAPEYEAR=2099 rows produced no censored observations",
    );
  }

  return {
    schemaVersion: 1,
    generatedAt: generated.toISOString(),
    title: "Federal FJC IDB class-action duration benchmarks",
    scope: {
      jurisdiction: "United States federal district courts",
      sourceSystem: "Federal Judicial Center Integrated Database (FJC IDB)",
      statement:
        "These are federal docket-duration estimates. They do not represent all U.S. class actions, state-court cases, an open-claim inventory, or time from claim filing to payment.",
    },
    source: {
      ...FJC_IDB_SOURCE,
      format: "ZIP containing a tab-delimited text file",
      snapshotDate,
      updateCadence: "Quarterly source snapshots; publication lag varies.",
      ...sourceMetadata,
    },
    methodology: {
      estimator: "Kaplan-Meier product-limit estimator with right censoring",
      durationUnit: "calendar days",
      caseKey: "CIRCUIT + DISTRICT + OFFICE + DOCKET",
      observationUnit:
        "Unique federal docket identifier. Reinstated/reopened IDB rows sharing that identifier are collapsed into one lifecycle.",
      defaultPopulation: "CLASSACT=1",
      defaultCohortId: "class_alleged_excluding_mdl_transfer_origins",
      dateFields:
        "FILEDATE and TERMDATE are used for elapsed time. FDATEUSE and TDATEUSE are AO reporting-cohort dates and are not duration endpoints.",
      mdlRule: "ORIGIN 6 and 13 are reported separately and excluded from the recommended default cohort.",
      classActionQuality:
        "CLASSACT records a plaintiff allegation that Rule 23 prerequisites are met; it is not proof of certification. FJC says this field has no quality-control checks and can change as records are updated.",
      settlementQuality:
        "DISP=13 is a federal case disposition marked settled. It does not prove a court-approved class settlement, an open claim window, claimant eligibility, payment, or recovery amount.",
      pendingRule:
        "STATUSCD=S or TAPEYEAR=2099 identifies a pending record. The cumulative tab export currently places 01/01/1900 in TERMDATE for those rows; that sentinel is ignored and the row is censored at the source snapshot date.",
      reopenRule:
        "Repeated docket identifiers, commonly ORIGIN 4 or 8-12 reopen records, are collapsed. The lifecycle starts at the earliest CLASSACT=1 FILEDATE and ends at the latest TERMDATE, unless any record is currently pending.",
      censoring:
        "Pending dockets are censored at source.snapshotDate. In the recorded-settlement clock, a docket with no DISP=13 is censored at its final endpoint and treated as a competing non-settlement closure.",
    },
    quality,
    cohorts: cohorts.map(finalizeCohort),
  };
}
