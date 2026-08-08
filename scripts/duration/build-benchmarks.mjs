#!/usr/bin/env node

import { spawn } from "node:child_process";
import { accessSync, constants, createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  FJC_IDB_SOURCE,
  buildDurationBenchmarksFromTsv,
} from "./fjc-duration.mjs";

const DEFAULT_MEMBER = "cv88on.txt";
const USER_AGENT =
  "ClaimCompassFjcDuration/1.0 (public-data research; contact: support@claimcompass.local)";

function parseArgs(argv) {
  const options = {
    output: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/duration-benchmarks.json"),
    sourceUrl: null,
    sourcePageUrl: FJC_IDB_SOURCE.datasetPageUrl,
    zipPath: null,
    tsvPath: null,
    member: DEFAULT_MEMBER,
    snapshotDate: null,
    includeCertified: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    if (argument === "--output") options.output = path.resolve(next());
    else if (argument === "--source-url") options.sourceUrl = next();
    else if (argument === "--source-page-url") options.sourcePageUrl = next();
    else if (argument === "--zip") options.zipPath = path.resolve(next());
    else if (argument === "--tsv") options.tsvPath = path.resolve(next());
    else if (argument === "--member") options.member = next();
    else if (argument === "--snapshot") options.snapshotDate = next();
    else if (argument === "--include-certified") options.includeCertified = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  const inputs = [options.zipPath, options.tsvPath].filter(Boolean);
  if (inputs.length > 1) throw new Error("Use only one of --zip or --tsv");
  return options;
}

function helpText() {
  return `Usage: node scripts/duration/build-benchmarks.mjs [options]

Streams the official FJC civil cumulative ZIP by default and writes federal-only
right-censored duration benchmarks.

Options:
  --output PATH          Output JSON path (default: data/duration-benchmarks.json)
  --source-url URL       Override the full FJC cumulative ZIP URL
  --source-page-url URL  Override the FJC dataset landing page
  --zip PATH             Read a configurable local ZIP cache instead of the network
  --tsv PATH             Read an already-extracted tab-delimited file
  --member NAME          ZIP member name (default: cv88on.txt)
  --snapshot YYYY-MM-DD  Required for --zip/--tsv; optional remote override
  --include-certified    Add descriptive TRCLACT=3 terminated-case subcohorts
  --help                 Show this help

The remote path needs no credentials. ZIP extraction uses bsdtar when available,
with funzip/unzip fallbacks supplied by the standard unzip package.
`;
}

function executableAvailable(name) {
  return String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        accessSync(path.join(directory, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

function chooseExtractor({ remote, archivePath = null, member }) {
  const forced = process.env.FJC_DURATION_EXTRACTOR;
  if (forced && !["bsdtar", "funzip", "unzip"].includes(forced)) {
    throw new Error("FJC_DURATION_EXTRACTOR must be bsdtar, funzip, or unzip");
  }

  const canUse = (name) => (!forced || forced === name) && executableAvailable(name);
  if (canUse("bsdtar")) {
    return {
      command: "bsdtar",
      args: ["-xOf", remote ? "-" : archivePath, member],
    };
  }
  if (remote && canUse("funzip")) {
    if (member !== DEFAULT_MEMBER) {
      throw new Error(
        "The funzip fallback can only stream the first ZIP member; use bsdtar for a custom --member",
      );
    }
    return { command: "funzip", args: [] };
  }
  if (!remote && canUse("unzip")) {
    return { command: "unzip", args: ["-p", archivePath, member] };
  }
  throw new Error(
    remote
      ? "ZIP extraction requires bsdtar or funzip on PATH"
      : "ZIP extraction requires bsdtar or unzip on PATH",
  );
}

function naturalDateToIso(value) {
  const months = {
    January: 1,
    February: 2,
    March: 3,
    April: 4,
    May: 5,
    June: 6,
    July: 7,
    August: 8,
    September: 9,
    October: 10,
    November: 11,
    December: 12,
  };
  const match = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match || !months[match[1]]) throw new Error(`Could not parse FJC snapshot date: ${value}`);
  return `${match[3]}-${String(months[match[1]]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
}

export function parseFjcDatasetPage(html) {
  const normalized = html
    .replace(/&nbsp;/gi, " ")
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ");
  const match = normalized.match(
    /<a[^>]+href="([^"]*cv88on_0\.zip)"[^>]*>\s*Civil Cases Cumulative File\s*<\/a>\s*\((Cases terminated in SY 1988 through (.+?) and cases pending as of (.+?))\)/i,
  );
  if (!match) throw new Error("Could not locate the current FJC cumulative-file metadata");
  const downloadUrl = new URL(match[1], FJC_IDB_SOURCE.datasetPageUrl).toString();
  const snapshotDate = naturalDateToIso(match[3]);
  const pendingSnapshotDate = naturalDateToIso(match[4]);
  if (snapshotDate !== pendingSnapshotDate) {
    throw new Error(`FJC termination and pending snapshot dates differ: ${snapshotDate} vs ${pendingSnapshotDate}`);
  }
  return {
    downloadUrl,
    snapshotDate,
    coverageLabel: match[2],
  };
}

async function fetchDatasetPage(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { accept: "text/html", "user-agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`FJC dataset page returned HTTP ${response.status}`);
  return parseFjcDatasetPage(await response.text());
}

function childCompletion(child, label) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
  });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`));
    });
  });
}

async function openRemoteZip(url, member) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { accept: "application/zip,application/octet-stream", "user-agent": USER_AGENT },
  });
  if (!response.ok || !response.body) throw new Error(`FJC ZIP returned HTTP ${response.status}`);

  const extractor = chooseExtractor({ remote: true, member });
  const child = spawn(extractor.command, extractor.args, { stdio: ["pipe", "pipe", "pipe"] });
  const extractDone = childCompletion(child, `${extractor.command} ZIP extraction`);
  const downloadDone = pipeline(Readable.fromWeb(response.body), child.stdin);
  return {
    input: child.stdout,
    sourceMetadata: {
      inputMode: "remote_stream",
      extractor: extractor.command,
      downloadUrl: response.url,
      http: {
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentLength: response.headers.get("content-length")
          ? Number(response.headers.get("content-length"))
          : null,
      },
    },
    done: async () => Promise.all([downloadDone, extractDone]),
    abort: () => child.kill("SIGTERM"),
  };
}

function openLocalZip(zipPath, member) {
  const extractor = chooseExtractor({ remote: false, archivePath: zipPath, member });
  const child = spawn(extractor.command, extractor.args, { stdio: ["ignore", "pipe", "pipe"] });
  const extractDone = childCompletion(child, `${extractor.command} local ZIP extraction`);
  return {
    input: child.stdout,
    sourceMetadata: {
      inputMode: "local_zip_cache",
      localCacheFile: path.basename(zipPath),
      extractor: extractor.command,
    },
    done: () => extractDone,
    abort: () => child.kill("SIGTERM"),
  };
}

function openLocalTsv(tsvPath) {
  return {
    input: createReadStream(tsvPath),
    sourceMetadata: {
      inputMode: "local_extracted_tsv",
      localCacheFile: path.basename(tsvPath),
    },
    done: async () => {},
    abort: () => {},
  };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export async function run(options) {
  const localInput = Boolean(options.zipPath || options.tsvPath);
  if (localInput && !options.snapshotDate) {
    throw new Error("--snapshot YYYY-MM-DD is required with --zip or --tsv so a stale cache is not mislabeled");
  }

  let pageMetadata = null;
  if (!localInput || !options.snapshotDate) pageMetadata = await fetchDatasetPage(options.sourcePageUrl);
  const snapshotDate = options.snapshotDate ?? pageMetadata.snapshotDate;
  const sourceUrl = options.sourceUrl ?? pageMetadata?.downloadUrl ?? FJC_IDB_SOURCE.downloadUrl;
  const opened = options.tsvPath
    ? openLocalTsv(options.tsvPath)
    : options.zipPath
      ? openLocalZip(options.zipPath, options.member)
      : await openRemoteZip(sourceUrl, options.member);

  try {
    const benchmark = await buildDurationBenchmarksFromTsv({
      input: opened.input,
      snapshotDate,
      includeCertified: options.includeCertified,
      sourceMetadata: {
        coverageLabel:
          pageMetadata?.coverageLabel ?? `Local cache explicitly labeled with snapshot ${snapshotDate}`,
        ...opened.sourceMetadata,
      },
    });
    await opened.done();
    await writeJsonAtomic(options.output, benchmark);
    return benchmark;
  } catch (error) {
    opened.abort();
    try {
      await opened.done();
    } catch {
      // Preserve the parser/write error while consuming any child/download rejection.
    }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(helpText());
    else {
      const benchmark = await run(options);
      const defaultCohort = benchmark.cohorts.find(
        (cohort) => cohort.id === benchmark.methodology.defaultCohortId,
      );
      process.stdout.write(
        `${JSON.stringify({
          output: options.output,
          snapshotDate: benchmark.source.snapshotDate,
          rowsRead: benchmark.quality.rowsRead,
          defaultCohortN: defaultCohort?.clocks.allTermination.n ?? 0,
        })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message ?? error}\n`);
    process.exitCode = 1;
  }
}
