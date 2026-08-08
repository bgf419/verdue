import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { diffRecords, makeEvent } from "../lib/catalog.mjs";
import {
  CFPB_PAYMENTS_SOURCE,
  FTC_REFUNDS_SOURCE,
  GOVERNMENT_SCHEMA_VERSION,
  SEC_DISTRIBUTIONS_SOURCE,
  parseCfpbPayments,
  parseFtcRefunds,
  parseSecDistributions,
} from "./normalize.mjs";

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const USER_AGENT =
  "VerdueCatalog/1.0 (+https://verdue-claims.pages.dev; public data refresh)";

export const GOVERNMENT_SOURCE_ADAPTERS = [
  { source: FTC_REFUNDS_SOURCE, parse: parseFtcRefunds },
  { source: CFPB_PAYMENTS_SOURCE, parse: parseCfpbPayments },
  { source: SEC_DISTRIBUTIONS_SOURCE, parse: parseSecDistributions },
];

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function fetchHtml(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref?.();

  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.8",
        "user-agent": USER_AGENT,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (Buffer.byteLength(html, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

function safeError(error) {
  return String(error?.message ?? error ?? "Unknown source error")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function latestSnapshots(events) {
  const snapshots = new Map();
  for (const event of events) {
    if (event?.recordId && event?.snapshot) snapshots.set(event.recordId, event.snapshot);
  }
  return snapshots;
}

function sourceRecordMap(records, sourceId) {
  return new Map(
    records
      .filter((record) => record.sourceIds?.includes(sourceId))
      .map((record) => [record.id, record]),
  );
}

function lifecycle(record, prior, checkedAt) {
  const candidate = {
    ...record,
    firstSeenAt: prior?.firstSeenAt ?? checkedAt,
    lastSeenAt: checkedAt,
    lastChangedAt: prior?.lastChangedAt ?? checkedAt,
    freshness: "current",
  };
  const changes = prior ? diffRecords(prior, candidate) : [];
  if (changes.length > 0) candidate.lastChangedAt = checkedAt;
  return { record: candidate, changes };
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    const agencyOrder = left.agencyCode.localeCompare(right.agencyCode);
    if (agencyOrder !== 0) return agencyOrder;
    const titleOrder = left.title.localeCompare(right.title, "en", { sensitivity: "base" });
    return titleOrder !== 0 ? titleOrder : left.id.localeCompare(right.id);
  });
}

function countsByAgency(records) {
  return Object.fromEntries(
    Object.entries(
      records.reduce((counts, record) => {
        counts[record.agencyCode] = (counts[record.agencyCode] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function refreshGovernmentRedress({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  now = new Date(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  adapters = GOVERNMENT_SOURCE_ADAPTERS,
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error("now must be a valid Date");
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  const checkedAt = now.toISOString();
  const dataPath = path.join(rootDir, "data", "government-redress.json");
  const previous = await readJson(dataPath, {
    schemaVersion: GOVERNMENT_SCHEMA_VERSION,
    generatedAt: null,
    activeRecordCount: 0,
    countsByAgency: {},
    coverage: null,
    records: [],
    history: { updatedAt: null, events: [] },
  });
  if (previous.schemaVersion !== GOVERNMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported government-redress schema version: ${previous.schemaVersion}`);
  }

  const results = await Promise.all(
    adapters.map(async ({ source, parse }) => {
      try {
        const html = await fetchHtml(source.url, { fetchImpl, timeoutMs });
        const records = parse(html, {
          checkedAt,
          minimumRecords: source.minimumRecords,
        });
        return { source, status: "ok", records, error: null };
      } catch (error) {
        return { source, status: "failed", records: [], error: safeError(error) };
      }
    }),
  );

  const previousRecords = previous.records ?? [];
  const events = [...(previous.history?.events ?? [])];
  const historical = latestSnapshots(events);
  const nextRecords = [];
  const staleRetentionCounts = new Map();

  for (const result of results) {
    const priorForSource = sourceRecordMap(previousRecords, result.source.id);
    if (result.status === "failed") {
      const retained = [...priorForSource.values()].map((record) => ({
        ...record,
        freshness: "stale",
        staleReason: "source_check_failed",
      }));
      nextRecords.push(...retained);
      staleRetentionCounts.set(result.source.id, retained.length);
      continue;
    }

    staleRetentionCounts.set(result.source.id, 0);
    const observedIds = new Set();
    for (const observed of result.records) {
      observedIds.add(observed.id);
      const prior = priorForSource.get(observed.id) ?? historical.get(observed.id);
      const next = lifecycle(observed, prior, checkedAt);
      nextRecords.push(next.record);
      if (!prior) {
        events.push(makeEvent({ record: next.record, type: "discovered", occurredAt: checkedAt }));
      } else if (!priorForSource.has(observed.id)) {
        events.push(makeEvent({ record: next.record, type: "reactivated", occurredAt: checkedAt }));
      } else if (next.changes.length > 0) {
        events.push(
          makeEvent({
            record: next.record,
            type: "changed",
            occurredAt: checkedAt,
            changes: next.changes,
          }),
        );
      }
    }

    for (const prior of priorForSource.values()) {
      if (observedIds.has(prior.id)) continue;
      const deactivated = {
        ...prior,
        active: false,
        inactiveReason: "removed_from_agency_source",
        freshness: "current",
        lastChangedAt: checkedAt,
      };
      events.push(makeEvent({ record: deactivated, type: "deactivated", occurredAt: checkedAt }));
    }
  }

  const records = sortRecords(nextRecords);
  const successfulCount = results.filter((result) => result.status === "ok").length;
  const required = results.filter((result) => result.source.required);
  const requiredSuccessCount = required.filter((result) => result.status === "ok").length;
  const allRequiredSourcesSucceeded = requiredSuccessCount === required.length;
  const overallStatus = allRequiredSourcesSucceeded
    ? "complete"
    : successfulCount > 0 || records.length > 0
      ? "degraded"
      : "failed";
  const previousLastCompleteAt = previous.coverage?.lastCompleteAt ?? null;
  const previousCoverageById = new Map(
    (previous.coverage?.sources ?? []).map((source) => [source.id, source]),
  );
  const coverage = {
    overallStatus,
    allRequiredSourcesSucceeded,
    requiredSourceCount: required.length,
    requiredSuccessCount,
    lastCompleteAt: overallStatus === "complete" ? checkedAt : previousLastCompleteAt,
    sources: results.map((result) => ({
      id: result.source.id,
      label: result.source.label,
      agency: result.source.agency,
      url: result.source.url,
      required: result.source.required,
      status: result.status,
      checkedAt,
      lastSuccessAt:
        result.status === "ok"
          ? checkedAt
          : previousCoverageById.get(result.source.id)?.lastSuccessAt ?? null,
      recordCount: result.records.length,
      activeRecordCount: result.records.filter((record) => record.active).length,
      staleRetentionCount: staleRetentionCounts.get(result.source.id) ?? 0,
      error: result.error,
    })),
  };
  const output = {
    schemaVersion: GOVERNMENT_SCHEMA_VERSION,
    generatedAt: checkedAt,
    activeRecordCount: records.length,
    countsByAgency: countsByAgency(records),
    coverage,
    records,
    history: {
      updatedAt: checkedAt,
      events,
    },
  };

  await writeJsonAtomic(dataPath, output);
  return output;
}

async function main() {
  const now = process.env.GOVERNMENT_NOW ? new Date(process.env.GOVERNMENT_NOW) : new Date();
  const result = await refreshGovernmentRedress({ now });
  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: result.generatedAt,
        status: result.coverage.overallStatus,
        records: result.activeRecordCount,
        countsByAgency: result.countsByAgency,
        sources: result.coverage.sources.map(
          ({ id, status, recordCount, staleRetentionCount, error }) => ({
            id,
            status,
            recordCount,
            staleRetentionCount,
            error,
          }),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
