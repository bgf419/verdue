import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  COURTLISTENER_QUERY_CORE,
  COURTLISTENER_SEARCH_ENDPOINT,
  COURTLISTENER_SOURCE_ID,
  FEDERAL_SCHEMA_VERSION,
  RECAP_COVERAGE_CAVEAT,
  RECAP_COVERAGE_URL,
  buildSearchQuery,
  buildSearchUrl,
  hashUrl,
  mergeFederalRecords,
  normalizeCourtListenerResult,
  safeCourtListenerSearchUrl,
  subtractCalendarDays,
  subtractCalendarYears,
  toIsoDate,
} from "./courtlistener.mjs";

const DEFAULT_LOOKBACK_YEARS = 3;
const DEFAULT_INCREMENTAL_DAYS = 7;
const DEFAULT_MAX_REQUESTS = 5;
const DEFAULT_REQUEST_DELAY_MS = 13_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_WAIT_MS = 60_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

class CourtListenerHttpError extends Error {
  constructor(status, retryAfter) {
    super(`HTTP ${status}${retryAfter ? `; retry after ${retryAfter}` : ""}`);
    this.status = status;
    this.retryAfterMs = parseRetryAfter(retryAfter);
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : Math.max(0, date.valueOf() - Date.now());
}

function positiveInteger(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

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

function safeError(error) {
  return String(error?.message ?? error ?? "Unknown CourtListener error")
    .replace(/\s+/g, " ")
    .slice(0, 600);
}

function wait(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) {
    throw new Error("CourtListener returned an unexpected response shape");
  }
  if (payload.next !== null && payload.next !== undefined && !safeCourtListenerSearchUrl(payload.next)) {
    throw new Error("CourtListener returned an unsafe pagination URL");
  }
  return payload;
}

async function readCachedPage(cachePath, { url, now, cacheTtlMs }) {
  const cached = await readJson(cachePath, null);
  if (!cached || cached.url !== url || !cached.cachedAt || !cached.payload) return null;
  const age = now.valueOf() - new Date(cached.cachedAt).valueOf();
  if (!Number.isFinite(age) || age < 0 || age > cacheTtlMs) return null;
  return validatePayload(cached.payload);
}

export async function fetchCourtListenerPage({
  url,
  fetchImpl = globalThis.fetch,
  cacheDir,
  now = new Date(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const safeUrl = safeCourtListenerSearchUrl(url);
  if (!safeUrl) throw new Error("Refusing to request a non-CourtListener search URL");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  const cachePath = path.join(cacheDir, `${hashUrl(safeUrl)}.json`);
  const cached = await readCachedPage(cachePath, { url: safeUrl, now, cacheTtlMs });
  if (cached) return { payload: cached, cacheHit: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetchImpl(safeUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en;q=0.8",
        "user-agent":
          "ClaimCompassFederalFeed/1.0 (+https://github.com/bgf419/verdue; public CourtListener API client)",
      },
    });
    if (!response.ok) {
      throw new CourtListenerHttpError(response.status, response.headers?.get?.("retry-after"));
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    const payload = validatePayload(JSON.parse(text));
    await writeJsonAtomic(cachePath, { cachedAt: now.toISOString(), url: safeUrl, payload });
    return { payload, cacheHit: false };
  } finally {
    clearTimeout(timer);
  }
}

function initialCatalog() {
  return {
    schemaVersion: FEDERAL_SCHEMA_VERSION,
    generatedAt: null,
    recordCount: 0,
    records: [],
    coverage: null,
  };
}

function makeQueryState({ mode, previousCoverage, endDate, lookbackYears, incrementalDays, restart }) {
  const stateKey = mode === "full" ? "backfill" : "incremental";
  const previousState = previousCoverage?.[stateKey];
  const expectedWindow = mode === "full" ? lookbackYears : incrementalDays;
  const previousWindow = mode === "full" ? previousState?.lookbackYears : previousState?.incrementalDays;

  if (
    !restart &&
    previousState?.status === "in_progress" &&
    previousState?.nextUrl &&
    previousWindow === expectedWindow &&
    safeCourtListenerSearchUrl(previousState.nextUrl)
  ) {
    return {
      stateKey,
      resumed: true,
      startDate: previousState.startDate,
      endDate: previousState.endDate,
      searchQuery: previousState.searchQuery,
      searchUrl: previousState.searchUrl,
      nextUrl: previousState.nextUrl,
      pagesFetchedTotal: previousState.pagesFetchedTotal ?? 0,
      rawResultsSeenTotal: previousState.rawResultsSeenTotal ?? 0,
      acceptedResultsTotal: previousState.acceptedResultsTotal ?? 0,
    };
  }

  const startDate =
    mode === "full"
      ? subtractCalendarYears(endDate, lookbackYears)
      : subtractCalendarDays(endDate, incrementalDays);
  const searchQuery = buildSearchQuery({ startDate, endDate });
  const searchUrl = buildSearchUrl(searchQuery);
  return {
    stateKey,
    resumed: false,
    startDate,
    endDate,
    searchQuery,
    searchUrl,
    nextUrl: searchUrl,
    pagesFetchedTotal: 0,
    rawResultsSeenTotal: 0,
    acceptedResultsTotal: 0,
  };
}

function retryable(error) {
  if (error instanceof CourtListenerHttpError) return error.status === 429 || error.status >= 500;
  return /timed out|fetch failed|network|econnreset|etimedout|socket/i.test(safeError(error));
}

export async function runFederalRefresh({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  mode = "incremental",
  now = new Date(),
  lookbackYears = DEFAULT_LOOKBACK_YEARS,
  incrementalDays = DEFAULT_INCREMENTAL_DAYS,
  maxRequests = DEFAULT_MAX_REQUESTS,
  requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  maxRetryWaitMs = DEFAULT_MAX_RETRY_WAIT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".cache"),
  onProgress = null,
  restart = false,
} = {}) {
  if (!["full", "incremental"].includes(mode)) throw new Error("mode must be full or incremental");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("now must be a valid Date");
  lookbackYears = positiveInteger(lookbackYears, "lookbackYears", DEFAULT_LOOKBACK_YEARS);
  incrementalDays = positiveInteger(incrementalDays, "incrementalDays", DEFAULT_INCREMENTAL_DAYS);
  maxRequests = positiveInteger(maxRequests, "maxRequests", DEFAULT_MAX_REQUESTS);
  requestDelayMs = nonNegativeInteger(requestDelayMs, "requestDelayMs", DEFAULT_REQUEST_DELAY_MS);
  maxRetries = nonNegativeInteger(maxRetries, "maxRetries", DEFAULT_MAX_RETRIES);
  maxRetryWaitMs = nonNegativeInteger(
    maxRetryWaitMs,
    "maxRetryWaitMs",
    DEFAULT_MAX_RETRY_WAIT_MS,
  );
  cacheTtlMs = nonNegativeInteger(cacheTtlMs, "cacheTtlMs", DEFAULT_CACHE_TTL_MS);
  timeoutMs = positiveInteger(timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS);
  if (onProgress !== null && typeof onProgress !== "function") {
    throw new Error("onProgress must be a function when provided");
  }
  if (typeof restart !== "boolean") throw new Error("restart must be a boolean");

  const checkedAt = now.toISOString();
  const endDate = toIsoDate(now);
  const outputPath = path.join(rootDir, "data", "federal-cases.json");
  const previous = await readJson(outputPath, initialCatalog());
  if (previous.schemaVersion !== FEDERAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported federal catalog schema version: ${previous.schemaVersion}`);
  }

  const queryState = makeQueryState({
    mode,
    previousCoverage: previous.coverage,
    endDate,
    lookbackYears,
    incrementalDays,
    restart,
  });
  let nextUrl = queryState.nextUrl;
  let pagesProcessed = 0;
  let networkRequests = 0;
  let cacheHits = 0;
  let retries = 0;
  let rawResultsSeen = 0;
  let requestBudgetExhausted = false;
  let approximateResultCount = null;
  let lastNetworkRequestAt = 0;
  let failure = null;
  const observed = [];

  while (nextUrl && pagesProcessed < maxRequests) {
    let page = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (networkRequests >= maxRequests) {
        requestBudgetExhausted = true;
        break;
      }
      const remainingDelay = Math.max(0, requestDelayMs - (Date.now() - lastNetworkRequestAt));
      if (networkRequests > 0) await wait(remainingDelay);
      try {
        page = await fetchCourtListenerPage({
          url: nextUrl,
          fetchImpl,
          cacheDir,
          now,
          cacheTtlMs,
          timeoutMs,
        });
        if (page.cacheHit) cacheHits += 1;
        else {
          networkRequests += 1;
          lastNetworkRequestAt = Date.now();
        }
        break;
      } catch (error) {
        networkRequests += 1;
        lastNetworkRequestAt = Date.now();
        if (attempt >= maxRetries || !retryable(error)) {
          failure = safeError(error);
          break;
        }
        const retryWaitMs = Math.max(
          requestDelayMs,
          error.retryAfterMs ?? requestDelayMs * (attempt + 2),
        );
        if (retryWaitMs > maxRetryWaitMs) {
          failure = `${safeError(error)}; deferred because retry wait ${retryWaitMs}ms exceeds ${maxRetryWaitMs}ms run limit`;
          break;
        }
        retries += 1;
        onProgress?.({
          type: "retry",
          attempt: attempt + 1,
          networkRequests,
          message: safeError(error),
        });
        await wait(retryWaitMs);
      }
    }
    if (!page) break;

    pagesProcessed += 1;
    rawResultsSeen += page.payload.results.length;
    if (Number.isFinite(page.payload.count)) approximateResultCount = page.payload.count;
    for (const result of page.payload.results) {
      const record = normalizeCourtListenerResult(result, { observedAt: checkedAt });
      if (record) observed.push(record);
    }
    nextUrl = page.payload.next ? safeCourtListenerSearchUrl(page.payload.next) : null;
    onProgress?.({
      type: "page",
      pagesProcessed,
      networkRequests,
      cacheHits,
      rawResultsSeen,
      acceptedResults: observed.length,
      approximateResultCount,
      nextCursorPending: Boolean(nextUrl),
    });
  }
  if (nextUrl && networkRequests >= maxRequests) requestBudgetExhausted = true;

  const incomplete = Boolean(nextUrl);
  const status = failure ? "degraded" : incomplete ? "partial" : "complete";
  const records = mergeFederalRecords(previous.records, observed, {
    observedAt: checkedAt,
    degraded: Boolean(failure),
  });
  const state = {
    status: incomplete ? "in_progress" : failure ? "degraded" : "complete",
    startDate: queryState.startDate,
    endDate: queryState.endDate,
    searchQuery: queryState.searchQuery,
    searchUrl: queryState.searchUrl,
    nextUrl,
    lookbackYears: mode === "full" ? lookbackYears : undefined,
    incrementalDays: mode === "incremental" ? incrementalDays : undefined,
    pagesFetchedTotal: queryState.pagesFetchedTotal + pagesProcessed,
    rawResultsSeenTotal: queryState.rawResultsSeenTotal + rawResultsSeen,
    acceptedResultsTotal: queryState.acceptedResultsTotal + observed.length,
    lastAttemptAt: checkedAt,
    lastCompletedAt:
      !failure && !incomplete
        ? checkedAt
        : previous.coverage?.[queryState.stateKey]?.lastCompletedAt ?? null,
  };
  for (const key of Object.keys(state)) {
    if (state[key] === undefined) delete state[key];
  }

  const observedDocketIds = new Set(observed.map((record) => record.docketId));
  const coverage = {
    sourceId: COURTLISTENER_SOURCE_ID,
    sourceLabel: "CourtListener RECAP federal class-action complaint search",
    apiEndpoint: COURTLISTENER_SEARCH_ENDPOINT,
    apiVersion: "v4",
    dataType: "r",
    sourceAuthority: "court_docket_metadata",
    accessMode: "unauthenticated_public_api",
    authenticationCaveat:
      "Free Law Project recommends token authentication for deployed programmatic access. Public unauthenticated access may be throttled or restricted.",
    status,
    stale: Boolean(failure),
    mode,
    checkedAt,
    lastSuccessfulAt: pagesProcessed > 0 ? checkedAt : previous.coverage?.lastSuccessfulAt ?? null,
    queryCore: COURTLISTENER_QUERY_CORE,
    searchQuery: queryState.searchQuery,
    searchUrl: queryState.searchUrl,
    dateRange: { startDate: queryState.startDate, endDate: queryState.endDate },
    resumedFromCursor: queryState.resumed,
    restartRequested: restart,
    boundedRequestLimit: maxRequests,
    pagesProcessed,
    networkRequests,
    cacheHits,
    retries,
    requestBudgetExhausted,
    rawResultsSeen,
    approximateResultCount,
    resultCountCaveat:
      "CourtListener says type=r counts use cardinality aggregation and may vary by about 6% when more than 2,000 results match.",
    observedThisRun: observed.length,
    retainedFromPrevious: records.filter((record) => !observedDocketIds.has(record.docketId)).length,
    error: failure,
    coverageUrl: RECAP_COVERAGE_URL,
    coverageCaveat: RECAP_COVERAGE_CAVEAT,
    operationalCaveat:
      "This conservative query finds federal dockets with matching complaint-entry descriptions. It is not a complete census of federal or state class actions, and putative status does not establish certification.",
    backfill: queryState.stateKey === "backfill" ? state : previous.coverage?.backfill ?? null,
    incremental: queryState.stateKey === "incremental" ? state : previous.coverage?.incremental ?? null,
  };
  const catalog = {
    schemaVersion: FEDERAL_SCHEMA_VERSION,
    generatedAt: checkedAt,
    recordCount: records.length,
    records,
    coverage,
  };
  await writeJsonAtomic(outputPath, catalog);
  return catalog;
}

export function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    const takeValue = () => inlineValue ?? argv[++index];
    if (flag === "--mode") options.mode = takeValue();
    else if (flag === "--lookback-years") options.lookbackYears = takeValue();
    else if (flag === "--incremental-days") options.incrementalDays = takeValue();
    else if (flag === "--max-requests") options.maxRequests = takeValue();
    else if (flag === "--request-delay-ms") options.requestDelayMs = takeValue();
    else if (flag === "--max-retries") options.maxRetries = takeValue();
    else if (flag === "--max-retry-wait-ms") options.maxRetryWaitMs = takeValue();
    else if (flag === "--cache-ttl-ms") options.cacheTtlMs = takeValue();
    else if (flag === "--timeout-ms") options.timeoutMs = takeValue();
    else if (flag === "--now") options.now = new Date(takeValue());
    else if (flag === "--restart") options.restart = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const options = parseCliArgs(process.argv.slice(2));
  options.onProgress = (progress) => {
    if (progress.type === "retry") {
      process.stderr.write(
        `CourtListener retry ${progress.attempt}; requests=${progress.networkRequests}; ${progress.message}\n`,
      );
    } else if (progress.pagesProcessed === 1 || progress.pagesProcessed % 10 === 0) {
      process.stderr.write(
        `CourtListener pages=${progress.pagesProcessed}; accepted=${progress.acceptedResults}; ` +
          `raw=${progress.rawResultsSeen}/${progress.approximateResultCount ?? "?"}; ` +
          `requests=${progress.networkRequests}; cache=${progress.cacheHits}\n`,
      );
    }
  };
  runFederalRefresh(options)
    .then((catalog) => {
      const coverage = catalog.coverage;
      process.stdout.write(
        `${JSON.stringify(
          {
            status: coverage.status,
            mode: coverage.mode,
            records: catalog.recordCount,
            observedThisRun: coverage.observedThisRun,
            pagesProcessed: coverage.pagesProcessed,
            networkRequests: coverage.networkRequests,
            cacheHits: coverage.cacheHits,
            retries: coverage.retries,
            nextCursorPending:
              coverage[coverage.mode === "full" ? "backfill" : "incremental"]?.status === "in_progress",
            error: coverage.error,
          },
          null,
          2,
        )}\n`,
      );
      if (coverage.status === "degraded") process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${safeError(error)}\n`);
      process.exitCode = 1;
    });
}
