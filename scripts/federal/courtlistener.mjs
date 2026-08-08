import { createHash } from "node:crypto";

export const FEDERAL_SCHEMA_VERSION = 1;
export const COURTLISTENER_ORIGIN = "https://www.courtlistener.com";
export const COURTLISTENER_SEARCH_ENDPOINT = `${COURTLISTENER_ORIGIN}/api/rest/v4/search/`;
export const COURTLISTENER_SOURCE_ID = "courtlistener-recap-class-action-complaints";
export const COURTLISTENER_QUERY_CORE = "description:(Class Action Complaint)";
export const RECAP_COVERAGE_URL = `${COURTLISTENER_ORIGIN}/help/coverage/recap/`;
export const RECAP_COVERAGE_CAVEAT =
  "CourtListener's RECAP index is broad but not a complete, continuously current copy of PACER. A missing docket, filing, or termination date does not prove that none exists.";

const COMPLAINT_DESCRIPTION_PATTERNS = [
  /\bclass\s+action\s+complaint\b/i,
  /\bclass\s+and\s+collective\s+action\s+complaint\b/i,
  /\bamended\s+class\s+action\s+complaint\b/i,
];

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validIsoDate(value) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text ? null : text;
}

export function toIsoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new Error("Expected a valid Date");
  }
  return date.toISOString().slice(0, 10);
}

export function subtractCalendarYears(isoDate, years) {
  const value = validIsoDate(isoDate);
  if (!value) throw new Error(`Invalid ISO date: ${isoDate}`);
  if (!Number.isInteger(years) || years < 1) throw new Error("years must be a positive integer");

  const [year, month, day] = value.split("-").map(Number);
  const targetYear = year - years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return `${String(targetYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
    Math.min(day, lastDay),
  ).padStart(2, "0")}`;
}

export function subtractCalendarDays(isoDate, days) {
  const value = validIsoDate(isoDate);
  if (!value) throw new Error(`Invalid ISO date: ${isoDate}`);
  if (!Number.isInteger(days) || days < 1) throw new Error("days must be a positive integer");
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return toIsoDate(date);
}

export function buildSearchQuery({ startDate, endDate }) {
  const start = validIsoDate(startDate);
  const end = validIsoDate(endDate);
  if (!start || !end || start > end) throw new Error("A valid ordered date range is required");
  return `${COURTLISTENER_QUERY_CORE} AND dateFiled:[${start} TO ${end}]`;
}

export function buildSearchUrl(searchQuery) {
  const url = new URL(COURTLISTENER_SEARCH_ENDPOINT);
  url.searchParams.set("type", "r");
  url.searchParams.set("order_by", "dateFiled desc");
  url.searchParams.set("q", searchQuery);
  return url.toString();
}

export function safeCourtListenerSearchUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== COURTLISTENER_ORIGIN || url.pathname !== "/api/rest/v4/search/") return null;
    if (url.searchParams.get("type") !== "r") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function courtListenerUrl(value, fallbackPath) {
  try {
    const url = new URL(cleanText(value) || fallbackPath, COURTLISTENER_ORIGIN);
    return url.origin === COURTLISTENER_ORIGIN
      ? url.toString()
      : new URL(fallbackPath, COURTLISTENER_ORIGIN).toString();
  } catch {
    return new URL(fallbackPath, COURTLISTENER_ORIGIN).toString();
  }
}

export function isClassActionComplaintDescription(value) {
  const description = cleanText(value);
  if (COMPLAINT_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description))) return true;

  const filingHeader = description.split(/\(?\battachments?\s*:/i, 1)[0].slice(0, 600);
  const beginsAsComplaint =
    /^(?:(?:first|second|third|fourth)\s+)?(?:amended\s+)?complaint\b/i.test(filingHeader);
  if (!beginsAsComplaint) return false;

  return (
    /\bclass\s+action\b/i.test(filingHeader) ||
    /\bclass\s+and\s+collective\b/i.test(filingHeader) ||
    /\bcollective\s+and(?:\s+r\.?\s*23)?\s+class\s+action\b/i.test(filingHeader)
  );
}

export function matchesClassActionComplaint(result) {
  return Array.isArray(result?.recap_documents)
    ? result.recap_documents.some((document) => isClassActionComplaintDescription(document?.description))
    : false;
}

function normalizeMatchedFiling(document, docketId) {
  const absoluteUrl = cleanText(document?.absolute_url);
  return {
    documentId: document?.id == null ? null : String(document.id),
    docketEntryId: document?.docket_entry_id == null ? null : String(document.docket_entry_id),
    documentNumber: document?.document_number ?? null,
    entryDateFiled: validIsoDate(document?.entry_date_filed),
    description: cleanText(document?.description) || null,
    documentType: cleanText(document?.document_type) || null,
    availableInRecap: document?.is_available === true,
    url: absoluteUrl
      ? courtListenerUrl(absoluteUrl, `/docket/${docketId}/`)
      : courtListenerUrl(null, `/docket/${docketId}/`),
  };
}

function lifecycleFree(record) {
  const copy = structuredClone(record);
  delete copy.firstSeenAt;
  delete copy.lastSeenAt;
  delete copy.lastChangedAt;
  delete copy.freshness;
  return copy;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function normalizeCourtListenerResult(result, { observedAt }) {
  const docketId = Number(result?.docket_id);
  if (!Number.isSafeInteger(docketId) || docketId <= 0) return null;
  if (!matchesClassActionComplaint(result)) return null;

  const docketUrl = courtListenerUrl(result?.docket_absolute_url, `/docket/${docketId}/`);
  const dateTerminated = validIsoDate(result?.dateTerminated);
  const matchedFilings = result.recap_documents
    .filter((document) => isClassActionComplaintDescription(document?.description))
    .map((document) => normalizeMatchedFiling(document, docketId))
    .filter(
      (filing, index, filings) =>
        filings.findIndex(
          (candidate) =>
            candidate.documentId === filing.documentId && candidate.docketEntryId === filing.docketEntryId,
        ) === index,
    )
    .sort((left, right) =>
      `${left.entryDateFiled ?? ""}|${left.documentNumber ?? ""}|${left.documentId ?? ""}`.localeCompare(
        `${right.entryDateFiled ?? ""}|${right.documentNumber ?? ""}|${right.documentId ?? ""}`,
      ),
    );

  return {
    id: `courtlistener-docket-${docketId}`,
    sourceId: COURTLISTENER_SOURCE_ID,
    sourceRecordId: String(docketId),
    sourceAuthority: "court_docket_metadata",
    kind: "potential_class_case",
    proceedingType: "federal_rule_23",
    classStatus: "putative",
    classStatusBasis:
      "A complaint-entry description matched the class-action query. Certification and later procedural status have not been verified.",
    participationMode: "no_current_action",
    windowStatus: "not_applicable",
    caseName: cleanText(result?.caseName) || "Unnamed federal matter",
    docketId,
    docketNumber: cleanText(result?.docketNumber) || null,
    docketUrl,
    court: cleanText(result?.court) || null,
    courtId: cleanText(result?.court_id) || null,
    dateFiled: validIsoDate(result?.dateFiled),
    dateTerminated,
    terminationState: dateTerminated ? "terminated_date_reported" : "termination_not_reported",
    active: !dateTerminated,
    activeStatusCaveat: dateTerminated
      ? "CourtListener reports a PACER termination date."
      : "No termination date was returned; this does not prove the matter remains active.",
    cause: cleanText(result?.cause) || null,
    suitNature: cleanText(result?.suitNature) || null,
    matchedFilings,
    action: {
      label: "View CourtListener docket",
      url: docketUrl,
      type: "source_only",
      allowsParticipation: false,
    },
    deadline: null,
    coverageCaveat: RECAP_COVERAGE_CAVEAT,
    provenance: {
      publisher: "Free Law Project",
      product: "CourtListener RECAP Archive",
      api: "CourtListener REST API v4 search, type=r",
      authority: "court_docket_metadata",
      accessMode: "unauthenticated_public_api",
      recordUrl: docketUrl,
      coverageUrl: RECAP_COVERAGE_URL,
    },
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    lastChangedAt: observedAt,
    freshness: "current",
  };
}

function preferIncomingWithPreservedTermination(previous, incoming) {
  if (!previous?.dateTerminated || incoming.dateTerminated) return incoming;
  return {
    ...incoming,
    dateTerminated: previous.dateTerminated,
    terminationState: previous.terminationState,
    active: false,
    activeStatusCaveat: previous.activeStatusCaveat,
  };
}

export function dedupeDocketRecords(records) {
  const byDocketId = new Map();
  for (const record of records) {
    if (!Number.isSafeInteger(record?.docketId)) continue;
    const previous = byDocketId.get(record.docketId);
    if (!previous) {
      byDocketId.set(record.docketId, structuredClone(record));
      continue;
    }

    const matchedFilings = [...(previous.matchedFilings ?? []), ...(record.matchedFilings ?? [])].filter(
      (filing, index, filings) =>
        filings.findIndex(
          (candidate) =>
            candidate.documentId === filing.documentId && candidate.docketEntryId === filing.docketEntryId,
        ) === index,
    );
    byDocketId.set(record.docketId, {
      ...previous,
      ...record,
      dateTerminated: record.dateTerminated ?? previous.dateTerminated,
      matchedFilings,
    });
  }
  return [...byDocketId.values()];
}

export function mergeFederalRecords(previousRecords, observedRecords, { observedAt, degraded = false }) {
  const previousByDocket = new Map(
    (previousRecords ?? [])
      .filter((record) => Number.isSafeInteger(record?.docketId))
      .map((record) => [record.docketId, structuredClone(record)]),
  );
  const observed = dedupeDocketRecords(observedRecords);
  const observedDocketIds = new Set(observed.map((record) => record.docketId));

  for (const incomingRecord of observed) {
    const previous = previousByDocket.get(incomingRecord.docketId);
    if (!previous) {
      previousByDocket.set(incomingRecord.docketId, incomingRecord);
      continue;
    }

    const incoming = preferIncomingWithPreservedTermination(previous, incomingRecord);
    const merged = {
      ...incoming,
      firstSeenAt: previous.firstSeenAt ?? observedAt,
      lastSeenAt: observedAt,
      lastChangedAt: previous.lastChangedAt ?? observedAt,
      freshness: "current",
    };
    if (stableStringify(lifecycleFree(previous)) !== stableStringify(lifecycleFree(merged))) {
      merged.lastChangedAt = observedAt;
    }
    previousByDocket.set(incoming.docketId, merged);
  }

  if (degraded) {
    for (const [docketId, record] of previousByDocket) {
      if (!observedDocketIds.has(docketId)) {
        previousByDocket.set(docketId, { ...record, freshness: "stale" });
      }
    }
  }

  return [...previousByDocket.values()].sort((left, right) => {
    const dateOrder = (right.dateFiled ?? "").localeCompare(left.dateFiled ?? "");
    return dateOrder || left.docketId - right.docketId;
  });
}

export function hashUrl(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}
