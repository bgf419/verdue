import rawFederalSummary from "../data/federal-summary.json";
import rawGovernmentRedress from "../data/government-redress.json";
import { cases as curatedCases, type FinderCriteria } from "./cases";

export type CatalogKind =
  | "settlement_claims_open"
  | "government_redress"
  | "potential_class_case"
  | "legal_counsel_intake";
export type ProofLevel =
  | "No documents stated"
  | "Notice or ID"
  | "Records may be requested"
  | "Requirements not stated";
export type CatalogAccent = "cobalt" | "coral" | "mint" | "violet" | "amber";

export type CatalogCase = {
  id: string;
  sourceRecordId: string;
  company: string;
  monogram: string;
  title: string;
  category: string;
  jurisdiction: string;
  geography: "Nationwide" | "State-specific" | "Not yet verified";
  caseNumber: string;
  court: string;
  filedLabel: string;
  filedDate?: string;
  deadline?: string;
  deadlineLabel: string;
  status: string;
  phase: string;
  fund: string;
  benefit: string;
  proof: ProofLevel;
  effortMinutes?: number;
  eligibility: string;
  classPeriod: string;
  sourceUrl: string;
  actionUrl: string;
  actionLabel: string;
  actionRole:
    | "verified_official_settlement_site"
    | "publisher_labeled_destination"
    | "legal_intake"
    | "source_only"
    | "agency_program";
  administrator: string;
  verifiedAt: string;
  sourceNote?: string;
  accent: CatalogAccent;
  checklist: string[];
  timeline: {
    label: string;
    date: string;
    state: "done" | "current" | "future";
  }[];
  kind: CatalogKind;
  participationMode:
    | "claim_form_required"
    | "legal_counsel_intake"
    | "no_current_action"
    | "automatic_distribution"
    | "agency_invitation_only"
    | "unknown";
  windowStatus: "open" | "unknown" | "closed" | "not_applicable";
  freshness: "current" | "stale";
  firstSeenAt: string;
  lastChangedAt: string;
  verificationState:
    | "official_settlement_site_checked"
    | "secondary_source_only"
    | "court_docket_metadata"
    | "agency_source_only";
  verificationNote: string;
  officialDestinationVerified: boolean;
  discoverySourceName: string;
  discoverySourceUrl: string;
  finderCriteria?: FinderCriteria;
};

export type RawFederalRecord = {
  id: string;
  sourceRecordId: string;
  kind: "potential_class_case";
  participationMode: "no_current_action";
  windowStatus: "not_applicable";
  caseName: string;
  docketNumber: string;
  docketUrl: string;
  court: string;
  courtId: string;
  dateFiled: string | null;
  dateTerminated: string | null;
  active: boolean;
  activeStatusCaveat: string;
  cause: string | null;
  suitNature: string | null;
  action: { label: string; url: string; allowsParticipation: false };
  coverageCaveat: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  freshness: "current" | "stale";
};

type RawFederalCatalog = {
  generatedAt: string;
  recordCount: number;
  coverage: {
    sourceId: string;
    sourceLabel: string;
    status: "complete" | "partial" | "degraded";
    checkedAt: string;
    searchUrl: string;
    approximateResultCount: number | null;
    coverageCaveat: string;
    operationalCaveat: string;
  };
};

type RawGovernmentCatalog = {
  generatedAt: string;
  activeRecordCount: number;
  coverage: {
    overallStatus: "complete" | "degraded" | "failed";
    allRequiredSourcesSucceeded: boolean;
    sources: Array<{
      id: string;
      label: string;
      agency: string;
      url: string;
      status: "ok" | "failed";
      checkedAt: string;
      recordCount: number;
      error: string | null;
    }>;
  };
  records: Array<{
    id: string;
    sourceRecordIds: string[];
    kind: "government_redress";
    agency: string;
    agencyCode: string;
    title: string;
    organization: string;
    category: "Government redress";
    programUrl: string;
    programStatus: string;
    participationMode: "automatic_distribution" | "agency_invitation_only" | "unknown";
    windowStatus: "open" | "unknown" | "closed" | "not_applicable";
    active: boolean;
    freshness: "current" | "stale";
    summary: string;
    eligibility: string | null;
    benefit: string | null;
    compensationType: string | null;
    dates: Array<{ kind: string; value: string; raw: string }>;
    action: { label: string; url: string; urlRole: "agency_program_page" };
    verification: { note: string };
    firstSeenAt: string;
    lastSeenAt: string;
    lastChangedAt: string;
    provenance: Array<{
      sourceName: string;
      sourceUrl: string;
      recordUrl: string;
    }>;
  }>;
};

const federalCatalog = rawFederalSummary as RawFederalCatalog;
const governmentCatalog = rawGovernmentRedress as RawGovernmentCatalog;

function monogram(value: string) {
  const parts = value
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "CA";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function accentFor(id: string): CatalogAccent {
  const accents: CatalogAccent[] = ["cobalt", "coral", "mint", "violet", "amber"];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return accents[hash % accents.length];
}

function shortDate(value: string | null | undefined) {
  if (!value) return "Date not reported";
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function federalCategory(cause: string | null, suitNature: string | null) {
  const text = `${cause ?? ""} ${suitNature ?? ""}`.toLowerCase();
  if (/employ|labor|wage|civil rights.*employment/.test(text)) return "Employment";
  if (/health|medical|hospital/.test(text)) return "Healthcare";
  if (/privacy|personal property|copyright|patent|trademark/.test(text)) return "Privacy and data";
  if (/securities|bank|credit|fraud|truth-in-lending|contract|consumer/.test(text)) return "Consumer";
  return "Federal court cases";
}

export function mapFederalRecord(record: RawFederalRecord): CatalogCase {
  const filed = shortDate(record.dateFiled);
  return {
    id: record.id,
    sourceRecordId: record.sourceRecordId,
    company: record.caseName,
    monogram: monogram(record.caseName),
    title: "Proposed federal class action",
    category: federalCategory(record.cause, record.suitNature),
    jurisdiction: `Federal · ${record.court}`,
    geography: "Not yet verified",
    caseNumber: record.docketNumber || "Docket number unavailable",
    court: record.court,
    filedLabel: record.dateFiled ? `Filed ${filed}` : "Filing date not reported",
    filedDate: record.dateFiled ?? undefined,
    deadlineLabel: "No participation deadline shown",
    status: "Proposed class — not certified",
    phase: "Putative federal class action",
    fund: "No settlement announced",
    benefit: "No open claim window",
    proof: "Requirements not stated",
    eligibility:
      "This is a docket-discovery record, not an application opportunity. The matching complaint alleges a class action; certification and any future settlement have not been verified.",
    classPeriod: "Not established in this catalog",
    sourceUrl: record.docketUrl,
    actionUrl: record.action.url,
    actionLabel: record.action.label,
    actionRole: "source_only",
    administrator: "CourtListener RECAP",
    verifiedAt: record.lastSeenAt,
    sourceNote: `${record.activeStatusCaveat} ${record.coverageCaveat}`,
    accent: accentFor(record.id),
    checklist: [
      "Treat this as a proposed class, not a certified class",
      "No claim form or opt-in action is shown on this record",
      "Review the docket for later certification, settlement, or dismissal activity",
    ],
    timeline: [
      { label: "Class-action complaint filed", date: filed, state: "done" },
      { label: "Docket metadata checked", date: shortDate(record.lastSeenAt.slice(0, 10)), state: "current" },
    ],
    kind: "potential_class_case",
    participationMode: "no_current_action",
    windowStatus: "not_applicable",
    freshness: record.freshness,
    firstSeenAt: record.firstSeenAt,
    lastChangedAt: record.lastChangedAt,
    verificationState: "court_docket_metadata",
    verificationNote:
      "CourtListener supplied federal docket metadata. The complaint match does not establish certification, current activity, or a right to participate.",
    officialDestinationVerified: false,
    discoverySourceName: "CourtListener RECAP Archive",
    discoverySourceUrl: record.docketUrl,
  };
}

function mapGovernmentRecord(record: RawGovernmentCatalog["records"][number]): CatalogCase {
  const source = record.provenance[0];
  const modified = record.dates.find((date) => date.kind === "source_page_modified");
  const modeLabel =
    record.participationMode === "automatic_distribution"
      ? "Agency says distribution is automatic"
      : record.participationMode === "agency_invitation_only"
        ? "Agency invitation only"
        : "Participation instructions not stated";
  return {
    id: record.id,
    sourceRecordId: record.sourceRecordIds[0] ?? record.id,
    company: record.title,
    monogram: record.agencyCode,
    title: `${record.agencyCode} harmed-consumer payment program`,
    category: "Government redress",
    jurisdiction: `Federal agency · ${record.agencyCode}`,
    geography: "Not yet verified",
    caseNumber: "Agency redress program",
    court: record.agency,
    filedLabel: modified ? `Agency page updated ${shortDate(modified.value)}` : "Agency page update date unavailable",
    deadlineLabel: "Agency page does not state an action deadline",
    status: "Government redress program",
    phase: modeLabel,
    fund: record.compensationType ?? record.benefit ?? "Agency redress",
    benefit: record.benefit ?? "See the agency program page",
    proof: "Requirements not stated",
    eligibility:
      record.eligibility ??
      `${record.summary} The source list does not say that visitors can file a claim; review the agency page for any instructions or contact requirements.`,
    classPeriod: "See agency program record",
    sourceUrl: source?.recordUrl ?? record.programUrl,
    actionUrl: record.action.url,
    actionLabel: record.action.label,
    actionRole: "agency_program",
    administrator: record.agency,
    verifiedAt: record.lastSeenAt,
    sourceNote: record.verification.note,
    accent: accentFor(record.id),
    checklist: [
      "Confirm whether the agency contacted you directly",
      "Do not assume this program has a public claim form",
      "Use only contact information published on the official agency page",
    ],
    timeline: [
      ...(modified
        ? [{ label: "Agency page modified", date: shortDate(modified.value), state: "done" as const }]
        : []),
      { label: "Program listed by agency", date: "Ongoing list", state: "current" },
    ],
    kind: "government_redress",
    participationMode: record.participationMode,
    windowStatus: record.windowStatus,
    freshness: record.freshness,
    firstSeenAt: record.firstSeenAt,
    lastChangedAt: record.lastChangedAt,
    verificationState: "agency_source_only",
    verificationNote: record.verification.note,
    officialDestinationVerified: true,
    discoverySourceName: source?.sourceName ?? record.agency,
    discoverySourceUrl: source?.sourceUrl ?? record.programUrl,
  };
}

const governmentCases = governmentCatalog.records
  .filter((record) => record.active)
  .map(mapGovernmentRecord);

function curatedDeadlinePassed(deadline?: string) {
  if (!deadline) return false;
  const timestamp = new Date(deadline).getTime();
  return Number.isFinite(timestamp) && timestamp < Date.now();
}

const curatedOnlyCases: CatalogCase[] = curatedCases
  .map((item) => {
    const deadlinePassed = curatedDeadlinePassed(item.deadline);
    return {
      ...item,
      status: deadlinePassed ? "Listed deadline passed · source recheck required" : item.status,
      sourceRecordId: `manual-${item.id}`,
      actionUrl: item.claimUrl,
      actionLabel: "Open official settlement site",
      actionRole: "verified_official_settlement_site",
      kind: "settlement_claims_open",
      participationMode: "claim_form_required",
      windowStatus: deadlinePassed ? "closed" : "open",
      freshness: deadlinePassed ? "stale" : "current",
      firstSeenAt: item.verifiedAt,
      lastChangedAt: item.verifiedAt,
      verificationState: "official_settlement_site_checked",
      verificationNote: "This destination was manually checked against the settlement website.",
      officialDestinationVerified: true,
      discoverySourceName: "Manual official-source review",
      discoverySourceUrl: item.sourceUrl,
    };
  });

export const cases = [
  ...curatedOnlyCases,
  ...governmentCases,
];
export const categories = [...new Set(cases.map((item) => item.category))].sort((a, b) =>
  a.localeCompare(b),
);
export const catalogGeneratedAt = [
  ...curatedCases.map((item) => item.verifiedAt),
  federalCatalog.generatedAt,
  governmentCatalog.generatedAt,
].sort().at(-1) ?? new Date(0).toISOString();
export const catalogStats = {
  recordCount: curatedOnlyCases.length + federalCatalog.recordCount + governmentCatalog.activeRecordCount,
  activeRecordCount: cases.length + federalCatalog.recordCount,
  openClaimCount: cases.filter((item) => item.kind === "settlement_claims_open").length,
  legalIntakeCount: cases.filter((item) => item.kind === "legal_counsel_intake").length,
  potentialCaseCount: federalCatalog.recordCount,
  governmentRedressCount: cases.filter((item) => item.kind === "government_redress").length,
  staleCount: governmentCatalog.records.filter((record) => record.freshness === "stale").length,
};

export type CoverageSource = {
  id: string;
  label: string;
  url: string;
  status: "ok" | "partial" | "failed";
  checkedAt: string;
  recordCount: number;
  error: string | null;
  note?: string;
};

const federalCoverageStatus: CoverageSource["status"] =
  federalCatalog.coverage.status === "complete"
    ? "ok"
    : federalCatalog.coverage.status === "partial"
      ? "partial"
      : "failed";

const coverageSources: CoverageSource[] = [
  ...governmentCatalog.coverage.sources.map((source) => ({
    id: source.id,
    label: source.label,
    url: source.url,
    status: source.status,
    checkedAt: source.checkedAt,
    recordCount: source.recordCount,
    error: source.error,
    note: source.agency,
  })),
  {
    id: federalCatalog.coverage.sourceId,
    label: federalCatalog.coverage.sourceLabel,
    url: federalCatalog.coverage.searchUrl,
    status: federalCoverageStatus,
    checkedAt: federalCatalog.coverage.checkedAt,
    recordCount: federalCatalog.recordCount,
    error: null,
    note: federalCatalog.coverage.operationalCaveat,
  },
];

export const coverage = {
  overallStatus: coverageSources.every((source) => source.status === "ok")
    ? "complete" as const
    : coverageSources.some((source) => source.status === "ok")
      ? "degraded" as const
      : "failed" as const,
  allRequiredSourcesSucceeded: coverageSources.every((source) => source.status === "ok"),
  sources: coverageSources,
};
