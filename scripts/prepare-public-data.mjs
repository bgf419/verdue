import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootDir, "data", "federal-cases.json");
const publicDir = path.join(rootDir, "public", "data");
const publicPath = path.join(publicDir, "federal-cases.json");
const summaryPath = path.join(rootDir, "data", "federal-summary.json");

const source = JSON.parse(await readFile(sourcePath, "utf8"));
const records = source.records
  .filter((record) => record.active)
  .map((record) => ({
    id: record.id,
    sourceRecordId: record.sourceRecordId,
    kind: record.kind,
    participationMode: record.participationMode,
    windowStatus: record.windowStatus,
    caseName: record.caseName,
    docketNumber: record.docketNumber,
    docketUrl: record.docketUrl,
    court: record.court,
    courtId: record.courtId,
    dateFiled: record.dateFiled,
    dateTerminated: record.dateTerminated,
    active: record.active,
    activeStatusCaveat: record.activeStatusCaveat,
    cause: record.cause,
    suitNature: record.suitNature,
    action: record.action,
    coverageCaveat: record.coverageCaveat,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    lastChangedAt: record.lastChangedAt,
    freshness: record.freshness,
  }));

const publicCatalog = {
  schemaVersion: source.schemaVersion,
  generatedAt: source.generatedAt,
  recordCount: records.length,
  records,
};

const summary = {
  schemaVersion: source.schemaVersion,
  generatedAt: source.generatedAt,
  recordCount: records.length,
  coverage: source.coverage,
};

await mkdir(publicDir, { recursive: true });
await Promise.all([
  writeFile(publicPath, `${JSON.stringify(publicCatalog)}\n`, "utf8"),
  writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
]);

process.stdout.write(`Prepared ${records.length} compact federal records for the public build.\n`);
