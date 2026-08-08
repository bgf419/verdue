import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
]);

export function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeUrl(value, baseUrl) {
  const text = cleanText(value);
  if (!text) return null;

  try {
    const url = new URL(text, baseUrl);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();

    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    url.searchParams.sort();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function slugify(value) {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function hash(value, length = 16) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function toIsoDate(value) {
  const text = cleanText(value);
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatIsoDate(isoDate) {
  if (!isoDate) return null;
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function parseClaimDeadline(rawValue, asOfDate) {
  const raw = cleanText(rawValue);
  if (!raw) return null;

  const date = toIsoDate(raw);
  if (!date) {
    return {
      kind: "claim",
      raw,
      date: null,
      label: raw,
      status: "unknown",
    };
  }

  return {
    kind: "claim",
    raw,
    date,
    label: formatIsoDate(date),
    status: date < asOfDate ? "past" : "upcoming",
  };
}

export function normalizeProof(rawValue) {
  const raw = cleanText(rawValue);
  if (/^yes\b/i.test(raw)) return "yes";
  if (/^no\b/i.test(raw)) return "no";
  return "unknown";
}

export function inferSettlementCategory(...values) {
  const haystack = cleanText(values.join(" ")).toLowerCase();
  const rules = [
    ["Privacy and data", /data breach|cyber|privacy|biometric|tracking pixel|personal information|security incident/],
    ["Employment", /employee|employment|worker|wage|overtime|payroll|labor/],
    ["Healthcare", /patient|hospital|health|medical|drug|pharma|prescription|dental/],
    ["Finance and insurance", /bank|credit|loan|mortgage|interest|insurance|financial|debit/],
    ["Automotive", /vehicle|automotive|\bauto\b|\bcar\b|truck|dealership/],
    ["Telecommunications", /wireless|telephone|telecom|text message|phone call/],
  ];

  return rules.find(([, pattern]) => pattern.test(haystack))?.[0] ?? "Consumer";
}

export function semanticRecord(record) {
  const provenance = (record.provenance ?? []).map((item) => {
    const entry = { ...item };
    delete entry.observedAt;
    return entry;
  });
  const semantic = { ...record };
  delete semantic.firstSeenAt;
  delete semantic.lastSeenAt;
  delete semantic.lastChangedAt;
  delete semantic.freshness;
  return { ...semantic, provenance };
}

export function diffRecords(before, after) {
  const oldRecord = semanticRecord(before);
  const newRecord = semanticRecord(after);
  const keys = [...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])].sort();

  return keys.flatMap((field) => {
    if (stableStringify(oldRecord[field]) === stableStringify(newRecord[field])) return [];
    return [{ field, before: oldRecord[field] ?? null, after: newRecord[field] ?? null }];
  });
}

function preferValue(left, right) {
  if (left === null || left === undefined || left === "") return right;
  if (right === null || right === undefined || right === "") return left;
  if (typeof left === "string" && typeof right === "string") {
    return right.length > left.length ? right : left;
  }
  return left;
}

export function dedupeRecords(records) {
  const byIdentity = new Map();

  for (const record of records) {
    const identityUrl = canonicalizeUrl(record.action?.url) ?? canonicalizeUrl(record.provenance?.[0]?.recordUrl);
    const identityKey = `${record.kind}|${identityUrl ?? cleanText(record.title).toLowerCase()}`;
    const existing = byIdentity.get(identityKey);
    if (!existing) {
      byIdentity.set(identityKey, structuredClone(record));
      continue;
    }

    existing.sourceIds = [...new Set([...existing.sourceIds, ...record.sourceIds])].sort();
    existing.sourceRecordIds = [...new Set([...existing.sourceRecordIds, ...record.sourceRecordIds])].sort();
    existing.summary = preferValue(existing.summary, record.summary);
    existing.eligibility = preferValue(existing.eligibility, record.eligibility);
    existing.benefit = preferValue(existing.benefit, record.benefit);
    existing.provenance = [...existing.provenance, ...record.provenance]
      .filter(
        (entry, index, entries) =>
          entries.findIndex(
            (candidate) =>
              candidate.sourceId === entry.sourceId && candidate.recordUrl === entry.recordUrl,
          ) === index,
      )
      .sort((a, b) => `${a.sourceId}|${a.recordUrl}`.localeCompare(`${b.sourceId}|${b.recordUrl}`));
  }

  return [...byIdentity.values()];
}

export function sortRecords(records) {
  return [...records].sort((a, b) => {
    const kindOrder = a.kind.localeCompare(b.kind);
    if (kindOrder !== 0) return kindOrder;
    const aDeadline = a.deadline?.date ?? "9999-12-31";
    const bDeadline = b.deadline?.date ?? "9999-12-31";
    const deadlineOrder = aDeadline.localeCompare(bDeadline);
    if (deadlineOrder !== 0) return deadlineOrder;
    const titleOrder = a.title.localeCompare(b.title, "en", { sensitivity: "base" });
    return titleOrder !== 0 ? titleOrder : a.id.localeCompare(b.id);
  });
}

export function summarizeRecords(records) {
  const byKind = {};
  const byCategory = {};
  let stale = 0;

  for (const record of records) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
    if (record.freshness === "stale") stale += 1;
  }

  return {
    byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b))),
    byCategory: Object.fromEntries(Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))),
    stale,
  };
}

export function makeEvent({ record, type, occurredAt, changes = [] }) {
  return {
    id: `event-${hash(`${record.id}|${type}|${occurredAt}|${stableStringify(changes)}`, 24)}`,
    recordId: record.id,
    type,
    occurredAt,
    sourceIds: record.sourceIds,
    changes,
    snapshot: record,
  };
}
