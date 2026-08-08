"use client";

import {
  ArrowRight,
  Bell,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Copy,
  ExternalLink,
  FileCheck2,
  Filter,
  Fingerprint,
  History,
  Info,
  LayoutGrid,
  List,
  LockKeyhole,
  Menu,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  cases as baseCases,
  catalogGeneratedAt,
  coverage,
  mapFederalRecord,
  type CatalogCase,
  type CatalogKind,
  type ProofLevel,
  type RawFederalRecord,
} from "./catalog";
import type {
  ClaimEvent as SupabaseClaimEvent,
  SupabaseDataStore,
  UserClaim as SupabaseUserClaim,
} from "./supabase-data";
import { defaultDurationCohort, durationBenchmarks, durationRange } from "./duration";

export type User = {
  displayName: string;
  accountId: string;
} | null;

type Profile = {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
};

type StoredClaim = {
  id: string;
  caseId: string;
  personalStatus: string;
  statusProvenance: string;
  confirmationNumber: string | null;
  submittedAt: string | null;
  approvedAmountCents: number | null;
  receivedAmountCents: number | null;
  amountSource: string | null;
  createdAt: string;
  updatedAt: string;
  events: StoredClaimEvent[];
};

type StoredClaimEvent = {
  id: string;
  eventType: string;
  personalStatus: string | null;
  provenance: string;
  confirmationNumber: string | null;
  amountCents: number | null;
  amountKind: "approved" | "received" | null;
  note: string | null;
  occurredAt: string;
};

type ClaimDraft = {
  personalStatus: string;
  confirmationNumber: string;
  submittedAt: string;
  approvedAmount: string;
  receivedAmount: string;
  amountSource: string;
};

export type AccountBackend = {
  signUp(input: { accountId: string; password: string }): Promise<void>;
  signIn(input: { accountId: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
};

type ClaimAppProps = {
  user: User;
  storageMode?: "supabase" | "local" | "disabled";
  accountBackend?: AccountBackend;
  dataStore?: SupabaseDataStore | null;
};

const LOCAL_USER_KEY = "verdue.local.user.v1";
const LOCAL_PROFILE_KEY = "verdue.local.profile.v1";
const LOCAL_CLAIMS_KEY = "verdue.local.claims.v1";
const LOCAL_SAVED_KEY = "verdue.local.saved.v1";

const EMPTY_CLAIM_DRAFT: ClaimDraft = {
  personalStatus: "started",
  confirmationNumber: "",
  submittedAt: "",
  approvedAmount: "",
  receivedAmount: "",
  amountSource: "user_reported",
};

function readLocalValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeAccountId(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalized) &&
    !normalized.endsWith(".") &&
    !normalized.includes("..")
    ? normalized
    : null;
}

function readLocalClaims(): StoredClaim[] {
  const claims = readLocalValue<Array<Omit<StoredClaim, "events"> & { events?: StoredClaimEvent[] }>>(
    LOCAL_CLAIMS_KEY,
    [],
  );
  if (!Array.isArray(claims)) return [];
  return claims.map((claim) => ({
    ...claim,
    events: Array.isArray(claim.events)
      ? claim.events
      : [
          {
            id: `legacy-snapshot-${claim.id}`,
            eventType: "legacy_snapshot",
            personalStatus: claim.personalStatus,
            provenance: claim.statusProvenance,
            confirmationNumber: claim.confirmationNumber,
            amountCents: claim.receivedAmountCents ?? claim.approvedAmountCents,
            amountKind:
              claim.receivedAmountCents !== null
                ? "received"
                : claim.approvedAmountCents !== null
                  ? "approved"
                  : null,
            note: "Only the latest saved snapshot exists for activity recorded before event history was added.",
            occurredAt: claim.updatedAt,
          },
        ],
  }));
}

function daysUntil(deadline?: string) {
  if (!deadline) return null;
  const value = new Date(deadline);
  if (!Number.isFinite(value.getTime())) return null;
  const dueDay = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((dueDay - today) / 86_400_000);
}

function elapsedLabel(filedDate?: string) {
  if (!filedDate) return "Elapsed time unavailable";
  const start = new Date(`${filedDate}T12:00:00Z`);
  const end = new Date();
  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  if (years === 0) return `${remainder} months elapsed`;
  return `${years}y ${remainder}m elapsed`;
}

function elapsedContext(item: CatalogCase) {
  if (item.filedDate) return elapsedLabel(item.filedDate);
  const firstSeen = new Date(item.firstSeenAt);
  if (!Number.isFinite(firstSeen.getTime())) return "Elapsed time unavailable";
  return `Filing age unavailable · tracked since ${firstSeen.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function relativeVerified(verifiedAt: string) {
  const verified = new Date(verifiedAt);
  const now = new Date();
  if (!Number.isFinite(verified.getTime())) return "check time unavailable";
  const mins = Math.max(0, Math.round((now.getTime() - verified.getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1_440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1_440)}d ago`;
}

function checkedLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "time unavailable";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function kindLabel(kind: CatalogKind) {
  const labels: Record<CatalogKind, string> = {
    settlement_claims_open: "Open claim windows",
    government_redress: "Government redress",
    potential_class_case: "Federal dockets · no termination reported",
    legal_counsel_intake: "Legal intakes & investigations",
  };
  return labels[kind];
}

function sourceLevelLabel(item: CatalogCase) {
  if (item.verificationState === "controlling_document_verified") return "Official claim site checked";
  if (item.verificationState === "agency_source_only") return "Official agency page";
  if (item.verificationState === "court_docket_metadata") return "Federal docket metadata";
  return "Secondary discovery source";
}

function sourceDetailHeading(item: CatalogCase) {
  if (item.verificationState === "controlling_document_verified") return "Official claim destination checked";
  if (item.verificationState === "agency_source_only") return "Official agency program page";
  if (item.verificationState === "court_docket_metadata") return "Federal docket metadata";
  return "Discovery source only";
}

function sourceDetailText(item: CatalogCase) {
  if (item.verificationState === "controlling_document_verified") {
    return `${item.administrator} maintains the linked claim information.`;
  }
  if (item.verificationState === "agency_source_only") {
    return `${item.administrator} publishes this redress-program record. Participation instructions remain unknown unless the agency says otherwise.`;
  }
  if (item.verificationState === "court_docket_metadata") {
    return "CourtListener supplied the docket metadata. A complaint description match does not establish certification, an open claim, or current case status.";
  }
  return `${item.discoverySourceName} supplied this listing; Verdue has not yet matched it to a controlling court document.`;
}

function draftStatus(status: string) {
  if (
    status === "official_site_opened" ||
    status === "publisher_destination_opened" ||
    status === "legal_intake_opened" ||
    status === "continued_to_official_site"
  ) {
    return "started";
  }
  return status;
}

function personalStatusLabel(status: string) {
  const labels: Record<string, string> = {
    tracking: "Tracking",
    started: "External destination opened",
    official_site_opened: "Official claim site opened",
    continued_to_official_site: "Official claim site opened",
    publisher_destination_opened: "Listed destination opened",
    legal_intake_opened: "Attorney intake opened",
    user_reported_submitted: "Submitted — reported by you",
    submitted: "Submitted — reported by you",
    confirmation_recorded: "Submission confirmation recorded",
    administrator_review: "Administrator review",
    under_review: "Administrator review",
    administrator_approved: "Administrator approved",
    approved: "Administrator approved",
    administrator_denied: "Administrator denied",
    denied: "Administrator denied",
    payment_issued: "Payment pending or issued",
    payment_pending: "Payment pending or issued",
    user_reported_payment_received: "Payment received — reported by you",
    paid: "Payment received",
    closed_no_payment: "Closed with no payment recorded",
    closed: "Closed",
    withdrawn: "Withdrawn",
    unknown: "Outcome unknown",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function eventTypeLabel(event: StoredClaimEvent) {
  const labels: Record<string, string> = {
    claim_created: "Claim tracking started",
    destination_opened: "External destination opened",
    status_updated: "Personal status updated",
    submission_recorded: "Submission recorded",
    confirmation_recorded: "Confirmation recorded",
    approval_recorded: "Approval recorded",
    denial_recorded: "Denial recorded",
    payment_recorded: "Payment recorded",
    note_added: "Note added",
    legacy_snapshot: "Earlier event history unavailable",
  };
  return labels[event.eventType] ?? event.eventType.replaceAll("_", " ");
}

function eventProvenanceLabel(provenance: string) {
  if (provenance === "user_action") return "Recorded from your Verdue action";
  if (provenance === "user_reported") return "Reported by you";
  return provenance.replaceAll("_", " ");
}

function storedEventFromSupabase(event: SupabaseClaimEvent): StoredClaimEvent {
  return {
    id: event.id,
    eventType: event.eventType,
    personalStatus: event.personalStatus,
    provenance: event.provenance,
    confirmationNumber: event.confirmationNumber,
    amountCents: event.amountCents,
    amountKind: event.amountKind,
    note: event.note,
    occurredAt: event.occurredAt,
  };
}

function localOutcomeEvent(draft: ClaimDraft, occurredAt: string): StoredClaimEvent {
  const approvedAmount = draft.approvedAmount.trim() || "not recorded";
  const receivedAmount = draft.receivedAmount.trim() || "not recorded";
  const submissionDate = draft.submittedAt || "not recorded";
  return {
    id: crypto.randomUUID(),
    eventType: "status_updated",
    personalStatus: draft.personalStatus,
    provenance: "user_reported",
    confirmationNumber: draft.confirmationNumber.trim() || null,
    amountCents:
      draft.receivedAmount.trim()
        ? Math.round(Number(draft.receivedAmount) * 100)
        : draft.approvedAmount.trim()
          ? Math.round(Number(draft.approvedAmount) * 100)
          : null,
    amountKind: draft.receivedAmount.trim() ? "received" : draft.approvedAmount.trim() ? "approved" : null,
    note: `Saved snapshot · submission date ${submissionDate} · approved amount ${approvedAmount} · received amount ${receivedAmount}`,
    occurredAt,
  };
}

function claimIsFinished(status: string) {
  return ["paid", "denied", "closed", "withdrawn"].includes(draftStatus(status));
}

function claimNeedsUpdate(status: string) {
  return ["tracking", "started", "unknown"].includes(draftStatus(status));
}

function storedClaimFromSupabase(claim: SupabaseUserClaim): StoredClaim {
  return {
    id: claim.id,
    caseId: claim.caseId,
    personalStatus: claim.personalStatus,
    statusProvenance: claim.statusProvenance,
    confirmationNumber: claim.confirmationNumber,
    submittedAt: claim.submittedAt,
    approvedAmountCents: claim.approvedAmountCents,
    receivedAmountCents: claim.receivedAmountCents,
    amountSource: claim.amountSource,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    events: [],
  };
}

const federalLifecycleRange = durationRange(defaultDurationCohort.clocks.allTermination);
const federalSettlementRange = durationRange(defaultDurationCohort.clocks.recordedSettlement);

export default function ClaimApp({
  user: initialUser,
  storageMode = "disabled",
  accountBackend,
  dataStore = null,
}: ClaimAppProps) {
  const [localUser, setLocalUser] = useState<User>(() =>
    storageMode === "local" ? readLocalValue<User>(LOCAL_USER_KEY, null) : null,
  );
  const user =
    storageMode === "supabase" ? initialUser : storageMode === "local" ? localUser : null;
  const persistenceDisabled = storageMode === "disabled";
  const [allCases, setAllCases] = useState<CatalogCase[]>(baseCases);
  const [federalLoadStatus, setFederalLoadStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const [federalReloadKey, setFederalReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | "All">("All");
  const [kind, setKind] = useState<CatalogKind | "All">("All");
  const [geography, setGeography] = useState<"All" | "Nationwide" | "State-specific" | "Not yet verified">("All");
  const [proof, setProof] = useState<ProofLevel | "All">("All");
  const [deadlineWindow, setDeadlineWindow] = useState<"All" | "30" | "45" | "60">("All");
  const [sort, setSort] = useState("deadline");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [activeCase, setActiveCase] = useState<CatalogCase | null>(null);
  const [saved, setSaved] = useState<string[]>(() =>
    storageMode === "local" ? readLocalValue<string[]>(LOCAL_SAVED_KEY, []) : [],
  );
  const [page, setPage] = useState<"discover" | "claims" | "method" | "privacy">("discover");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [visibleCount, setVisibleCount] = useState(24);
  const [editingClaimId, setEditingClaimId] = useState<string | null>(null);
  const [claimDraft, setClaimDraft] = useState<ClaimDraft>(EMPTY_CLAIM_DRAFT);
  const [profileSaved, setProfileSaved] = useState(() =>
    storageMode === "local" && readLocalValue<Profile | null>(LOCAL_PROFILE_KEY, null) !== null,
  );
  const [storedClaims, setStoredClaims] = useState<StoredClaim[]>(() =>
    storageMode === "local" ? readLocalClaims() : [],
  );
  const [claimEventsByClaimId, setClaimEventsByClaimId] = useState<Record<string, StoredClaimEvent[]>>({});
  const [claimEventLoadStatus, setClaimEventLoadStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [accountDraft, setAccountDraft] = useState({ accountId: "", password: "" });
  const [accountMode, setAccountMode] = useState<"signup" | "signin">("signup");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [profile, setProfile] = useState<Profile>(() => {
    const fallback = {
      fullName: "",
      email: "",
      phone: "",
      address: "",
      city: "",
      state: "",
      zip: "",
    };
    return storageMode === "local" ? readLocalValue<Profile>(LOCAL_PROFILE_KEY, fallback) : fallback;
  });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveCase(null);
        setAccountOpen(false);
        setFiltersOpen(false);
        setEditingClaimId(null);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const url = `${import.meta.env.BASE_URL}data/federal-cases.json`;
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Federal catalog returned ${response.status}`);
        return response.json() as Promise<{ records?: RawFederalRecord[] }>;
      })
      .then((result) => {
        if (!Array.isArray(result.records)) throw new Error("Federal catalog shape is invalid");
        const federal = result.records.filter((record) => record.active).map(mapFederalRecord);
        setAllCases([...baseCases, ...federal]);
        setFederalLoadStatus("loaded");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFederalLoadStatus("failed");
      });
    return () => controller.abort();
  }, [federalReloadKey]);

  useEffect(() => {
    if (storageMode !== "local" || !user) return;
    window.localStorage.setItem(LOCAL_CLAIMS_KEY, JSON.stringify(storedClaims));
  }, [storageMode, storedClaims, user]);

  useEffect(() => {
    if (storageMode !== "local" || !user) return;
    window.localStorage.setItem(LOCAL_SAVED_KEY, JSON.stringify(saved));
  }, [saved, storageMode, user]);

  useEffect(() => {
    if (!user || storageMode === "local" || !dataStore) return;
    let cancelled = false;
    Promise.all([
      dataStore.getProfile(),
      dataStore.listClaims(),
      dataStore.listSavedCases(),
    ])
      .then(([profileResult, claimsResult, savedResult]) => {
        if (cancelled) return;
        if (profileResult) {
          setProfile({
            fullName: profileResult.fullName,
            email: profileResult.email,
            phone: profileResult.phone,
            address: profileResult.address,
            city: profileResult.city,
            state: profileResult.state,
            zip: profileResult.zip,
          });
          setProfileSaved(true);
        } else {
          setProfile((current) => ({
            ...current,
            fullName: "",
            email: "",
          }));
        }
        setStoredClaims(claimsResult.map(storedClaimFromSupabase));
        setSaved(savedResult.map((entry) => entry.caseId));
      })
      .catch(() => setToast("Your private workspace could not be loaded yet"));
    return () => {
      cancelled = true;
    };
  }, [dataStore, storageMode, user]);

  const filteredCases = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...allCases]
      .filter((item) => {
        if (kind !== "All" && item.kind !== kind) return false;
        if (category !== "All" && item.category !== category) return false;
        if (geography !== "All" && item.geography !== geography) return false;
        if (proof !== "All" && item.proof !== proof) return false;
        const remaining = daysUntil(item.deadline);
        if (
          deadlineWindow !== "All" &&
          (remaining === null || remaining < 0 || remaining > Number(deadlineWindow))
        ) {
          return false;
        }
        if (!normalized) return true;
        return [
          item.company,
          item.title,
          item.category,
          item.eligibility,
          item.jurisdiction,
          item.caseNumber,
          item.discoverySourceName,
          item.kind,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .sort((a, b) => {
        if (sort === "new") return b.verifiedAt.localeCompare(a.verifiedAt);
        if (sort === "company") return a.company.localeCompare(b.company);
        if (sort === "age") {
          if (!a.filedDate) return 1;
          if (!b.filedDate) return -1;
          return a.filedDate.localeCompare(b.filedDate);
        }
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return a.deadline.localeCompare(b.deadline);
      });
  }, [allCases, category, deadlineWindow, geography, kind, proof, query, sort]);

  const availableCategories = useMemo(
    () => [...new Set(allCases.map((item) => item.category))].sort((a, b) => a.localeCompare(b)),
    [allCases],
  );

  const liveStats = useMemo(
    () => ({
      recordCount: allCases.length,
      openClaimCount: allCases.filter((item) => item.kind === "settlement_claims_open").length,
      governmentRedressCount: allCases.filter((item) => item.kind === "government_redress").length,
      potentialCaseCount: allCases.filter((item) => item.kind === "potential_class_case").length,
      legalIntakeCount: allCases.filter((item) => item.kind === "legal_counsel_intake").length,
      staleRecordCount: allCases.filter((item) => item.freshness === "stale").length,
    }),
    [allCases],
  );

  const claimStats = useMemo(() => {
    const finished = storedClaims.filter((claim) => claimIsFinished(claim.personalStatus)).length;
    const needsUpdate = storedClaims.filter((claim) => claimNeedsUpdate(claim.personalStatus)).length;
    return {
      finished,
      needsUpdate,
      inProgress: storedClaims.length - finished,
      receivedCents: storedClaims.reduce(
        (sum, claim) => sum + (claim.receivedAmountCents ?? 0),
        0,
      ),
    };
  }, [storedClaims]);

  const activeFilters = [
    kind !== "All" ? kindLabel(kind) : null,
    category !== "All" ? category : null,
    geography !== "All" ? geography : null,
    proof !== "All" ? proof : null,
    deadlineWindow !== "All" ? `Within ${deadlineWindow} days` : null,
  ].filter(Boolean);

  const clearFilters = () => {
    setKind("All");
    setCategory("All");
    setGeography("All");
    setProof("All");
    setDeadlineWindow("All");
    setQuery("");
    setVisibleCount(24);
  };

  const toggleSaved = async (id: string) => {
    if (persistenceDisabled) {
      setToast("Saving is disabled on this shared-origin mirror");
      return;
    }
    if (!user) {
      setAccountOpen(true);
      return;
    }
    const wasSaved = saved.includes(id);
    const item = allCases.find((entry) => entry.id === id);
    setSaved((current) =>
      wasSaved ? current.filter((entry) => entry !== id) : [...current, id],
    );
    try {
      if (storageMode === "supabase" && dataStore) {
        if (wasSaved) await dataStore.unsaveCase(id);
        else {
          await dataStore.saveCase({
            caseId: id,
            caseTitle: item?.title ?? null,
            sourceUrl: item?.sourceUrl ?? null,
          });
        }
      }
      setToast(wasSaved ? "Removed from saved cases" : "Saved to your watchlist");
    } catch {
      setSaved((current) =>
        wasSaved ? [...current, id] : current.filter((entry) => entry !== id),
      );
      setToast("Watchlist change could not be saved");
    }
  };

  const continueToClaim = (item: CatalogCase) => {
    if (item.freshness === "stale") {
      setActiveCase(item);
      setToast("Action paused · verify the source record before continuing");
      return;
    }
    if (item.actionRole === "source_only" || item.actionRole === "agency_program") {
      window.open(item.actionUrl, "_blank", "noopener,noreferrer");
      setToast(
        item.actionRole === "source_only"
          ? "Docket opened · no application activity recorded"
          : "Agency page opened · no application activity recorded",
      );
      return;
    }
    const activityType =
      item.actionRole === "verified_official_form"
        ? "official_site_opened"
        : item.actionRole === "legal_intake"
          ? "legal_intake_opened"
          : "publisher_destination_opened";
    const existingClaim = storedClaims.find((claim) => claim.caseId === item.id);
    if (user && storageMode === "local") {
      if (!existingClaim) {
        const now = new Date().toISOString();
        setStoredClaims((current) => {
        const claim: StoredClaim = {
          id: crypto.randomUUID(),
          caseId: item.id,
          personalStatus: activityType,
          statusProvenance: "user_action",
          confirmationNumber: null,
          submittedAt: null,
          approvedAmountCents: null,
          receivedAmountCents: null,
          amountSource: null,
          createdAt: now,
          updatedAt: now,
          events: [
            {
              id: crypto.randomUUID(),
              eventType: "destination_opened",
              personalStatus: activityType,
              provenance: "user_action",
              confirmationNumber: null,
              amountCents: null,
              amountKind: null,
              note: `${item.actionLabel} opened from Verdue; no submission was inferred.`,
              occurredAt: now,
            },
          ],
        };
          return [claim, ...current];
        });
      }
    } else if (user && dataStore && !existingClaim) {
      void dataStore
        .startClaim({ caseId: item.id, caseTitle: item.title, company: item.company })
        .then((claim) => {
          const stored = storedClaimFromSupabase(claim);
          setStoredClaims((current) => [
            stored,
            ...current.filter((entry) => entry.caseId !== stored.caseId),
          ]);
        })
        .catch(() => setToast("Destination opened, but the handoff could not be recorded"));
    }
    window.open(item.actionUrl, "_blank", "noopener,noreferrer");
    setToast(
      user
        ? existingClaim
          ? `${item.actionLabel} · existing claim status unchanged`
          : `${item.actionLabel} · handoff recorded`
        : item.actionLabel,
    );
  };

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user) return;
    if (storageMode === "local") {
      window.localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(profile));
      setProfileSaved(true);
      setToast("Profile saved in this browser");
      return;
    }
    try {
      if (!dataStore) throw new Error("Private data store unavailable");
      await dataStore.saveProfile({ ...profile, addressLine2: "", countryCode: "US" });
      setProfileSaved(true);
      setToast("Profile saved for future claim preparation");
    } catch {
      setToast("Profile could not be saved yet");
    }
  };

  const createLocalAccount = (event: React.FormEvent) => {
    event.preventDefault();
    const accountId = normalizeAccountId(accountDraft.accountId);
    if (!accountId) {
      setAccountError("Account ID must be 3–32 lowercase letters, numbers, dots, underscores, or hyphens. It must start with a letter or number and cannot end with a dot or contain consecutive dots.");
      return;
    }

    const localUser = { displayName: accountId, accountId };
    window.localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(localUser));
    setLocalUser(localUser);
    setToast("Private browser workspace created");
  };

  const submitAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!accountBackend) {
      setAccountError("Secure account service is not configured yet.");
      return;
    }
    const accountId = normalizeAccountId(accountDraft.accountId);
    if (!accountId) {
      setAccountError("Account ID must be 3–32 lowercase letters, numbers, dots, underscores, or hyphens. It must start with a letter or number and cannot end with a dot or contain consecutive dots.");
      return;
    }
    setAccountBusy(true);
    setAccountError("");
    try {
      if (accountMode === "signup") {
        await accountBackend.signUp({
          accountId,
          password: accountDraft.password,
        });
        setToast("Account created · keep your Account ID and password somewhere safe");
      } else {
        await accountBackend.signIn({
          accountId,
          password: accountDraft.password,
        });
        setToast("Signed in to your private workspace");
      }
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Account request failed");
    } finally {
      setAccountBusy(false);
    }
  };

  const signOut = async () => {
    if (!accountBackend) return;
    try {
      await accountBackend.signOut();
      setAccountOpen(false);
      setToast("Signed out");
    } catch {
      setToast("Sign out failed");
    }
  };

  const deleteLocalWorkspace = () => {
    [LOCAL_USER_KEY, LOCAL_PROFILE_KEY, LOCAL_CLAIMS_KEY, LOCAL_SAVED_KEY].forEach((key) =>
      window.localStorage.removeItem(key),
    );
    setLocalUser(null);
    setSaved([]);
    setStoredClaims([]);
    setProfile({ fullName: "", email: "", phone: "", address: "", city: "", state: "", zip: "" });
    setProfileSaved(false);
    setAccountOpen(false);
    setToast("Browser workspace deleted");
  };

  const deleteSyncedAccount = async () => {
    if (!accountBackend) return;
    if (!window.confirm("Permanently delete your Verdue account and all saved claim history?")) return;
    setAccountBusy(true);
    try {
      await accountBackend.deleteAccount();
      setAccountOpen(false);
      setToast("Account and private claim history deleted");
    } catch {
      setToast("Account could not be deleted");
    } finally {
      setAccountBusy(false);
    }
  };

  const openClaimEditor = (claim: StoredClaim) => {
    setEditingClaimId(claim.id);
    setClaimDraft({
      personalStatus: draftStatus(claim.personalStatus),
      confirmationNumber: claim.confirmationNumber ?? "",
      submittedAt: claim.submittedAt ? claim.submittedAt.slice(0, 10) : "",
      approvedAmount:
        claim.approvedAmountCents === null ? "" : (claim.approvedAmountCents / 100).toFixed(2),
      receivedAmount:
        claim.receivedAmountCents === null ? "" : (claim.receivedAmountCents / 100).toFixed(2),
      amountSource: claim.amountSource ?? "user_reported",
    });
    if (storageMode === "supabase" && dataStore) {
      setClaimEventLoadStatus("loading");
      void dataStore
        .listClaimEvents(claim.id)
        .then((events) => {
          setClaimEventsByClaimId((current) => ({
            ...current,
            [claim.id]: events.map(storedEventFromSupabase),
          }));
          setClaimEventLoadStatus("loaded");
        })
        .catch(() => setClaimEventLoadStatus("failed"));
    } else {
      setClaimEventLoadStatus("loaded");
    }
  };

  const saveClaimOutcome = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingClaimId) return;
    const toCents = (value: string) => {
      if (!value.trim()) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
    };
    const invalidAmount = [claimDraft.approvedAmount, claimDraft.receivedAmount].some((value) => {
      if (!value.trim()) return false;
      const parsed = Number(value);
      return !Number.isFinite(parsed) || parsed < 0;
    });
    if (invalidAmount) {
      setToast("Enter a valid non-negative amount or leave the field blank");
      return;
    }
    const now = new Date().toISOString();
    const submittedAt = claimDraft.submittedAt
      ? new Date(`${claimDraft.submittedAt}T12:00:00`).toISOString()
      : undefined;
    const approvedAmountCents = toCents(claimDraft.approvedAmount);
    const receivedAmountCents = toCents(claimDraft.receivedAmount);
    if (storageMode === "supabase" && dataStore) {
      try {
        const updated = await dataStore.saveClaimOutcome(editingClaimId, {
          personalStatus: claimDraft.personalStatus as SupabaseUserClaim["personalStatus"],
          confirmationNumber: claimDraft.confirmationNumber.trim() || null,
          submittedAt: submittedAt ?? null,
          approvedAmountCents,
          receivedAmountCents,
          amountSource:
            approvedAmountCents !== null || receivedAmountCents !== null
              ? claimDraft.amountSource as "user_reported" | "settlement_administrator_notice" | "payment_record"
              : null,
          provenance: "user_reported",
        });
        const stored = storedClaimFromSupabase(updated);
        setStoredClaims((current) =>
          current.map((claim) => (claim.id === stored.id ? stored : claim)),
        );
        const events = await dataStore.listClaimEvents(updated.id);
        setClaimEventsByClaimId((current) => ({
          ...current,
          [updated.id]: events.map(storedEventFromSupabase),
        }));
        setEditingClaimId(null);
        setToast("Claim history updated from your report");
      } catch {
        setToast("Claim history could not be saved");
      }
      return;
    }
    setStoredClaims((current) =>
      current.map((claim) =>
        claim.id === editingClaimId
          ? {
              ...claim,
              personalStatus: claimDraft.personalStatus,
              statusProvenance: "user_reported",
              confirmationNumber: claimDraft.confirmationNumber.trim() || null,
              submittedAt: submittedAt ?? null,
              approvedAmountCents,
              receivedAmountCents,
              amountSource:
                claimDraft.approvedAmount || claimDraft.receivedAmount
                  ? claimDraft.amountSource
                  : null,
              updatedAt: now,
              events: [localOutcomeEvent(claimDraft, now), ...claim.events],
            }
          : claim,
      ),
    );
    setEditingClaimId(null);
    setToast("Claim history updated from your report");
  };

  const copyProfileSummary = async () => {
    if (persistenceDisabled) {
      setToast("Profiles are disabled on this shared-origin mirror");
      return;
    }
    if (!profileSaved) {
      setAccountOpen(true);
      return;
    }
    const summary = [
      profile.fullName,
      profile.email,
      profile.phone,
      profile.address,
      [profile.city, profile.state, profile.zip].filter(Boolean).join(", "),
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(summary);
      setToast("Reusable contact fields copied for your review");
    } catch {
      setAccountOpen(true);
      setToast("Clipboard unavailable · profile opened instead");
    }
  };

  const editingClaim = storedClaims.find((claim) => claim.id === editingClaimId) ?? null;
  const editingClaimCase = editingClaim
    ? allCases.find((item) => item.id === editingClaim.caseId) ?? null
    : null;
  const editingClaimEvents = editingClaim
    ? storageMode === "local"
      ? editingClaim.events
      : claimEventsByClaimId[editingClaim.id] ?? []
    : [];

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Verdue home" onClick={() => setPage("discover")}>
          <span className="brand-mark" aria-hidden="true">
            V
          </span>
          <span className="brand-name">Verdue</span>
        </a>

        <nav className="main-nav" aria-label="Main navigation">
          <button className={page === "discover" ? "active" : ""} onClick={() => setPage("discover")}>
            Discover
          </button>
          {!persistenceDisabled && (
            <button className={page === "claims" ? "active" : ""} onClick={() => setPage("claims")}>
              My claims
            </button>
          )}
          <button className={page === "method" ? "active" : ""} onClick={() => setPage("method")}>
            How it works
          </button>
        </nav>

        <div className="header-actions">
          {!persistenceDisabled && (
            <>
              <button className="icon-button" aria-label="Open personal claim ledger" onClick={() => setPage("claims")}>
                <History size={18} />
              </button>
              <button className="account-button" onClick={() => setAccountOpen(true)}>
                <span className="account-avatar">{user ? user.displayName.slice(0, 1).toUpperCase() : <UserRound size={16} />}</span>
                <span>{user ? "Profile" : "Create account"}</span>
              </button>
            </>
          )}
          {persistenceDisabled && (
            <button className="account-button" type="button" disabled title="Personal storage is disabled on this shared-origin mirror">
              <span className="account-avatar"><LockKeyhole size={16} /></span>
              <span>Browsing only</span>
            </button>
          )}
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((current) => !current)}
          >
            <Menu size={20} />
          </button>
        </div>

        {mobileNavOpen && (
          <div className="mobile-nav-panel">
            <button onClick={() => { setPage("discover"); setMobileNavOpen(false); }}>Discover</button>
            {!persistenceDisabled && <button onClick={() => { setPage("claims"); setMobileNavOpen(false); }}>My claims</button>}
            <button onClick={() => { setPage("method"); setMobileNavOpen(false); }}>How it works</button>
          </div>
        )}
      </header>

      {page === "discover" && (
        <>
          <section className="hero" id="top">
            <div className="hero-copy">
              <div className="eyebrow">
                <span className="live-dot" /> Daily agency and docket feeds · {liveStats.recordCount} indexed records {federalLoadStatus === "loading" ? "· loading federal docket index" : federalLoadStatus === "failed" ? "· federal docket index unavailable" : "· claim windows checked separately"}
              </div>
              <h1>
                Find claim windows. <em>Track cases without guessing.</em>
              </h1>
              <p className="hero-subtitle">
                Search listed settlement destinations, official government redress programs, and federal dockets with no termination reported by the source. Every result says whether action is available or it is source-only information.
              </p>
              <div className="hero-search" role="search">
                <Search size={21} aria-hidden="true" />
                <input
                  aria-label="Search claims"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Company, product, employer, breach, or case name"
                />
                <button onClick={() => document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth" })}>
                  Search <ArrowRight size={17} />
                </button>
              </div>
              <div className="quick-filters" aria-label="Quick filters">
                <button onClick={() => setKind("settlement_claims_open")}><FileCheck2 size={14} /> Open claim windows</button>
                <button onClick={() => setKind("government_redress")}><CircleDollarSign size={14} /> Government redress</button>
                <button onClick={() => setKind("potential_class_case")}><Search size={14} /> Federal dockets indexed</button>
                <button onClick={() => setDeadlineWindow("30")}><CalendarClock size={14} /> Closing in 30 days</button>
              </div>
            </div>

            <aside className="match-panel">
              <div className="match-panel-top">
                <div>
                  <span className="mini-label">{persistenceDisabled ? "Shared-origin mirror" : "Your private workspace"}</span>
                  <strong>{persistenceDisabled ? "Browse without account storage" : user ? `${storedClaims.length} tracked ${storedClaims.length === 1 ? "claim" : "claims"}` : "Keep your own claim ledger"}</strong>
                </div>
                <span className="match-orbit"><Fingerprint size={24} /></span>
              </div>
              <div className="match-signal-row">
                <span className="signal-icon coral"><Check size={15} /></span>
                <div><b>Contact profile</b><span>{persistenceDisabled ? "Not collected or stored on this deployment" : "Common fields can be copied for your review"}</span></div>
                <span className={profileSaved ? "signal-status complete" : "signal-status"}>{persistenceDisabled ? "Disabled" : profileSaved ? "Ready" : "Not set"}</span>
              </div>
              <div className="match-signal-row">
                <span className="signal-icon mint"><History size={15} /></span>
                <div><b>Claim ledger</b><span>{persistenceDisabled ? "No personal activity is retained" : "Status changes and user-recorded outcomes"}</span></div>
                <span className={storedClaims.length > 0 ? "signal-status complete" : "signal-status"}>{persistenceDisabled ? "Disabled" : storedClaims.length > 0 ? `${storedClaims.length} saved` : "Empty"}</span>
              </div>
              <div className="match-signal-row">
                <span className="signal-icon violet"><LockKeyhole size={15} /></span>
                <div><b>Storage mode</b><span>{storageMode === "supabase" ? "Account-bound records after sign-in" : persistenceDisabled ? "Account and browser persistence are off" : "Records remain in this browser"}</span></div>
                <span className="signal-status">{storageMode === "supabase" ? "Synced" : persistenceDisabled ? "Off" : "Local"}</span>
              </div>
              <button className="match-cta" disabled={persistenceDisabled} onClick={() => setAccountOpen(true)}>
                {persistenceDisabled ? "Personal storage disabled" : user ? "Complete your profile" : "Create a private profile"} {!persistenceDisabled && <ArrowRight size={16} />}
              </button>
              <p><ShieldCheck size={13} /> Verdue does not calculate matches or submit forms. You review eligibility and every external destination yourself.</p>
            </aside>
          </section>

          <section className="trust-strip" aria-label="Catalog status">
            <div><strong>{liveStats.openClaimCount}</strong><span>listed open claim opportunities</span></div>
            <div><strong>{liveStats.governmentRedressCount}</strong><span>official government redress programs</span></div>
            <div><strong>{liveStats.potentialCaseCount}</strong><span>federal dockets indexed with no termination reported</span></div>
            <div className="truth-cell"><ShieldCheck size={20} /><span>Possible match ≠ eligibility decision</span></div>
          </section>

          {federalLoadStatus !== "loaded" && (
            <div className={`federal-load-banner ${federalLoadStatus}`} role={federalLoadStatus === "failed" ? "alert" : "status"}>
              <Info size={18} />
              <div>
                <strong>{federalLoadStatus === "loading" ? "Federal docket index is still loading" : "Federal docket index could not be loaded"}</strong>
                <span>{federalLoadStatus === "loading" ? "The current count and results temporarily exclude federal docket records." : "The catalog below omits federal docket records. Reviewed claim opportunities and government programs remain available."}</span>
              </div>
              {federalLoadStatus === "failed" && <button onClick={() => { setFederalLoadStatus("loading"); setAllCases(baseCases); setFederalReloadKey((current) => current + 1); }}>Retry</button>}
            </div>
          )}

          <section className="catalog-section" id="catalog">
            <div className="catalog-heading">
              <div>
                <span className="section-kicker">Monitored catalog</span>
                <h2>Explore {liveStats.recordCount} monitored catalog records</h2>
                <p>Generated {checkedLabel(catalogGeneratedAt)}. This is broad monitored-source coverage, not every U.S. court or settlement.</p>
              </div>
              <button className="coverage-button" onClick={() => setPage("method")}>
                <ShieldCheck size={16} /> Coverage & data quality
              </button>
            </div>

            <div className="catalog-layout">
              <aside className={`filter-panel ${filtersOpen ? "open" : ""}`}>
                <div className="filter-mobile-header">
                  <strong>Filters</strong>
                  <button onClick={() => setFiltersOpen(false)} aria-label="Close filters"><X size={20} /></button>
                </div>
                <div className="filter-title-row">
                  <span><SlidersHorizontal size={16} /> Filter catalog</span>
                  <button onClick={clearFilters}>Reset</button>
                </div>

                <FilterGroup title="Action type">
                  <Radio label="All catalog records" count={allCases.length} checked={kind === "All"} onClick={() => setKind("All")} />
                  <Radio label="Open claim windows" count={liveStats.openClaimCount} checked={kind === "settlement_claims_open"} onClick={() => setKind("settlement_claims_open")} />
                  <Radio label="Government redress" count={liveStats.governmentRedressCount} checked={kind === "government_redress"} onClick={() => setKind("government_redress")} />
                  <Radio label="Federal dockets · no termination reported" count={liveStats.potentialCaseCount} checked={kind === "potential_class_case"} onClick={() => setKind("potential_class_case")} />
                  {liveStats.legalIntakeCount > 0 && <Radio label="Legal intakes & investigations" count={liveStats.legalIntakeCount} checked={kind === "legal_counsel_intake"} onClick={() => setKind("legal_counsel_intake")} />}
                </FilterGroup>

                <FilterGroup title="Deadline">
                  <Radio label="Any deadline" checked={deadlineWindow === "All"} onClick={() => setDeadlineWindow("All")} />
                  <Radio label="Within 30 days" count={allCases.filter((entry) => { const days = daysUntil(entry.deadline); return days !== null && days >= 0 && days <= 30; }).length} checked={deadlineWindow === "30"} onClick={() => setDeadlineWindow("30")} />
                  <Radio label="Within 45 days" count={allCases.filter((entry) => { const days = daysUntil(entry.deadline); return days !== null && days >= 0 && days <= 45; }).length} checked={deadlineWindow === "45"} onClick={() => setDeadlineWindow("45")} />
                  <Radio label="Within 60 days" count={allCases.filter((entry) => { const days = daysUntil(entry.deadline); return days !== null && days >= 0 && days <= 60; }).length} checked={deadlineWindow === "60"} onClick={() => setDeadlineWindow("60")} />
                </FilterGroup>

                <FilterGroup title="Category">
                  <Radio label="All categories" count={allCases.length} checked={category === "All"} onClick={() => setCategory("All")} />
                  {availableCategories.map((item) => (
                    <Radio
                      key={item}
                      label={item}
                      count={allCases.filter((entry) => entry.category === item).length}
                      checked={category === item}
                      onClick={() => setCategory(item)}
                    />
                  ))}
                </FilterGroup>

                <FilterGroup title="Geography">
                  <Radio label="Any geography" checked={geography === "All"} onClick={() => setGeography("All")} />
                  <Radio label="Nationwide" count={allCases.filter((entry) => entry.geography === "Nationwide").length} checked={geography === "Nationwide"} onClick={() => setGeography("Nationwide")} />
                  <Radio label="State-specific" count={allCases.filter((entry) => entry.geography === "State-specific").length} checked={geography === "State-specific"} onClick={() => setGeography("State-specific")} />
                  <Radio label="Not yet verified" count={allCases.filter((entry) => entry.geography === "Not yet verified").length} checked={geography === "Not yet verified"} onClick={() => setGeography("Not yet verified")} />
                </FilterGroup>

                <FilterGroup title="Information needed">
                  <Radio label="Any requirement" checked={proof === "All"} onClick={() => setProof("All")} />
                  {(["No documents stated", "Notice or ID", "Records may be requested", "Requirements not stated"] as ProofLevel[]).map((item) => (
                    <Radio key={item} label={item} count={allCases.filter((entry) => entry.proof === item).length} checked={proof === item} onClick={() => setProof(item)} />
                  ))}
                </FilterGroup>
                <button className="filter-apply" onClick={() => setFiltersOpen(false)}>Show {filteredCases.length} records</button>
              </aside>

              <div className="results-area">
                <div className="results-toolbar">
                  <div className="result-count">
                    <strong>{filteredCases.length} catalog records</strong>
                    <span>showing {Math.min(visibleCount, filteredCases.length)} · action type labeled</span>
                  </div>
                  <div className="toolbar-actions">
                    <button className="mobile-filter-button" onClick={() => setFiltersOpen(true)}><Filter size={16} /> Filters {activeFilters.length ? `(${activeFilters.length})` : ""}</button>
                    <label className="sort-select">
                      <span>Sort</span>
                      <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort claims">
                        <option value="deadline">Deadline soonest</option>
                        <option value="new">Recently checked</option>
                        <option value="age">Oldest case</option>
                        <option value="company">Company A–Z</option>
                      </select>
                      <ChevronDown size={14} />
                    </label>
                    <div className="view-toggle" aria-label="Result view">
                      <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} aria-label="Grid view"><LayoutGrid size={16} /></button>
                      <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-label="List view"><List size={17} /></button>
                    </div>
                  </div>
                </div>

                {activeFilters.length > 0 && (
                  <div className="active-filter-row">
                    {activeFilters.map((item) => <span key={item as string}>{item}<X size={12} /></span>)}
                    <button onClick={clearFilters}>Clear all</button>
                  </div>
                )}

                <div className={`case-grid ${view === "list" ? "list-view" : ""}`}>
                  {filteredCases.slice(0, visibleCount).map((item) => {
                    const remaining = daysUntil(item.deadline);
                    const isClaim = item.kind === "settlement_claims_open";
                    return (
                    <article className={`case-card accent-${item.accent} ${item.freshness === "stale" ? "stale-record" : ""}`} key={item.id}>
                      <div className="case-card-head">
                        <div className="company-lockup">
                          <span className="company-monogram">{item.monogram}</span>
                          <div><strong>{item.company}</strong><span>{item.category}</span></div>
                        </div>
                        {!persistenceDisabled && (
                          <button
                            className={`save-button ${saved.includes(item.id) ? "saved" : ""}`}
                            onClick={() => toggleSaved(item.id)}
                            aria-label={saved.includes(item.id) ? "Remove saved case" : "Save case"}
                          >
                            {saved.includes(item.id) ? <Check size={17} /> : <Bell size={17} />}
                          </button>
                        )}
                      </div>
                      <div className="case-badges">
                        <span className="status-badge"><span /> {item.status}</span>
                        {item.verificationState === "secondary_source_only" && <span className="change-badge">Secondary-source listing</span>}
                        {item.verificationState === "court_docket_metadata" && <span className="change-badge">Indexed · no termination reported · not confirmed active</span>}
                        {item.verificationState === "agency_source_only" && <span className="change-badge">Official agency page</span>}
                        {item.freshness === "stale" && <span className="stale-badge">Stale source check · action paused</span>}
                      </div>
                      {item.freshness === "stale" && <div className="stale-record-warning"><Info size={15} /><span>This listing was retained after its source could not be refreshed. Review the source record; Verdue has paused the action link.</span></div>}
                      <h3>{item.title}</h3>
                      <p className="eligibility-copy">{item.eligibility}</p>
                      <div className="deadline-block">
                        <div><span>{isClaim ? "Listed claim deadline" : item.kind === "potential_class_case" ? "Participation" : item.kind === "government_redress" ? "Agency instructions" : "Current action"}</span><strong>{item.deadlineLabel}</strong></div>
                        {remaining !== null && remaining >= 0 ? (
                          <div className={remaining <= 21 ? "countdown urgent" : "countdown"}>
                            <b>{remaining === 0 ? "Today" : remaining}</b><span>{remaining === 0 ? "closes" : "days left"}</span>
                          </div>
                        ) : <div className="countdown"><b>—</b><span>{isClaim ? "varies" : "no deadline"}</span></div>}
                      </div>
                      <div className="case-facts">
                        <div><CircleDollarSign size={16} /><span><small>Stated benefit</small>{item.benefit}</span></div>
                        <div><FileCheck2 size={16} /><span><small>Information</small>{item.proof}</span></div>
                        <div><ShieldCheck size={16} /><span><small>Source level</small>{sourceLevelLabel(item)}</span></div>
                      </div>
                      <div className="case-duration">
                        <span>{elapsedContext(item)}</span>
                        <span className={item.freshness === "stale" ? "verified stale" : "verified"}><Clock3 size={13} /> {item.freshness === "stale" ? "last successful check" : "checked"} {relativeVerified(item.verifiedAt)}</span>
                      </div>
                      <div className="case-card-actions">
                        <button className="secondary-action" onClick={() => setActiveCase(item)}>{isClaim ? "Check possible fit" : item.kind === "government_redress" ? "Review program" : "View case details"}</button>
                        <button className="primary-action" disabled={item.freshness === "stale"} onClick={() => continueToClaim(item)} aria-label={`${item.freshness === "stale" ? "Action paused because source check is stale" : item.actionLabel} for ${item.company}`}>
                          {item.freshness === "stale" ? "Recheck source first" : item.actionLabel} {item.freshness !== "stale" && <ExternalLink size={15} />}
                        </button>
                      </div>
                      {remaining !== null && remaining >= 0 && remaining <= 14 && <span className="closing-ribbon">Closing soon</span>}
                    </article>
                    );
                  })}
                </div>

                {visibleCount < filteredCases.length && (
                  <div className="catalog-load-more">
                    <button onClick={() => setVisibleCount((current) => current + 24)}>
                      Load 24 more <ArrowRight size={15} />
                    </button>
                    <span>{filteredCases.length - visibleCount} remaining</span>
                  </div>
                )}

                {filteredCases.length === 0 && (
                  <div className="empty-state">
                    <Search size={26} />
                    <h3>No catalog records match these filters</h3>
                    <p>Try a broader category or clear the deadline filter.</p>
                    <button onClick={clearFilters}>Clear filters</button>
                  </div>
                )}

                <div className="catalog-note">
                  <Info size={17} />
                  <p><strong>Coverage truth:</strong> this catalog combines {coverage.sources.length} automated source feeds with {liveStats.openClaimCount} separately reviewed official claim sites, each with an authority label. Federal counts mean dockets were indexed with no termination reported by the source, not that a court confirmed each case is active. {liveStats.staleRecordCount > 0 ? `${liveStats.staleRecordCount} retained records have stale source checks and their action links are paused. ` : ""}It is not a complete census: no nationwide source covers every federal and state class action.</p>
                  <button onClick={() => setPage("method")}>See sources & gaps <ArrowRight size={14} /></button>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {page === "claims" && (
        <section className="dashboard-page">
          <div className="dashboard-hero">
            <div>
              <span className="section-kicker">Personal claim ledger</span>
              <h1>Know exactly what happened after you filed.</h1>
              <p>Case status, your claim status, and payment status stay separate—because they are not the same thing.</p>
            </div>
            <button className="primary-large" onClick={() => setPage("discover")}>Find another claim <ArrowRight size={16} /></button>
          </div>
          {!user && (
            <div className="demo-banner"><Sparkles size={17} /><span><strong>Your ledger is private.</strong> Create a workspace to record your own confirmations, status changes, and outcomes.</span><button onClick={() => setAccountOpen(true)}>Create account</button></div>
          )}
          {user && storedClaims.length === 0 && (
            <div className="demo-banner"><Info size={17} /><span><strong>Your ledger is empty.</strong> Open an official form from Discover and Verdue will record the handoff here.</span><button onClick={() => setPage("discover")}>Browse claims</button></div>
          )}
          <div className="claim-summary-grid">
            <div><span>Needs your update</span><strong>{user ? claimStats.needsUpdate : 0}</strong><small>Tracking, opened, or unknown status</small></div>
            <div><span>In progress</span><strong>{user ? claimStats.inProgress : 0}</strong><small>Non-terminal personal statuses</small></div>
            <div><span>Finished</span><strong>{user ? claimStats.finished : 0}</strong><small>Paid, denied, closed, or withdrawn</small></div>
            <div className="received-card"><span>Total received</span><strong>{user ? `$${(claimStats.receivedCents / 100).toFixed(2)}` : "$0.00"}</strong><small>Only user-recorded outcomes</small></div>
          </div>
          <div className="claim-ledger">
            <div className="ledger-head"><div><h2>Application history</h2><p>Open a record to view its timestamped event history and edit the current snapshot.</p></div></div>
            {user && storedClaims.length > 0 ? storedClaims.map((claim) => {
                  const item = allCases.find((entry) => entry.id === claim.caseId);
                  const activityLabel = personalStatusLabel(claim.personalStatus);
                  return {
                    storedId: claim.id,
                    company: item?.company ?? "Tracked claim",
                    title: item?.title ?? claim.caseId,
                    status: activityLabel,
                    provenance: eventProvenanceLabel(claim.statusProvenance),
                    date: `Activity ${new Date(claim.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
                    caseStatus: item?.kind === "potential_class_case" ? "Indexed · no termination reported · not confirmed active" : item?.status ?? "Current case status unavailable",
                    caseChecked: item ? `Source checked ${relativeVerified(item.verifiedAt)}` : "Catalog record unavailable",
                    amount: claim.receivedAmountCents !== null ? `$${(claim.receivedAmountCents / 100).toFixed(2)} received` : "Outcome unknown",
                    tone: claimIsFinished(claim.personalStatus) ? "paid" as const : claimNeedsUpdate(claim.personalStatus) ? "review" as const : "progress" as const,
                  };
                }).map((claim) => (
                <div className="ledger-row" key={`${claim.company}-${claim.title}`}>
                  <span className={`ledger-status-dot ${claim.tone}`} />
                  <div className="ledger-company"><strong>{claim.company}</strong><span>{claim.title}</span></div>
                  <div><small>Personal claim status</small><strong>{claim.status}</strong><span>{claim.provenance}</span></div>
                  <div><small>Case status</small><strong>{claim.caseStatus}</strong><span>{claim.caseChecked} · {claim.date}</span></div>
                  <div><small>Benefit outcome</small><strong>{claim.amount}</strong><span>Never inferred from case status</span></div>
                  <button aria-label={`Open ${claim.company} claim history`} onClick={() => {
                    const stored = storedClaims.find((entry) => entry.id === claim.storedId);
                    if (stored) openClaimEditor(stored);
                  }}><ArrowRight size={18} /></button>
                </div>
              )) : (
                <div className="empty-state claim-ledger-empty">
                  <History size={26} />
                  <h3>No application activity recorded</h3>
                  <p>Open a listed destination from Discover. A handoff is not treated as a submitted claim until you record a confirmation.</p>
                  <button onClick={() => setPage("discover")}>Browse the catalog</button>
                </div>
              )}
          </div>
        </section>
      )}

      {page === "method" && (
        <section className="method-page">
          <div className="method-hero">
            <span className="section-kicker">How Verdue works</span>
            <h1>Evidence first. Coverage visible. Uncertainty included.</h1>
            <p>Aggregation is easy to claim and hard to prove. The catalog exposes what it knows, where each record came from, and what is not independently verified yet.</p>
          </div>
          <div className="method-grid">
            <article className="method-card live"><span className="method-number">01</span><ShieldCheck size={24} /><h2>Label the source</h2><p>Editorial sources can discover a record. Only a separately checked administrator or government destination receives an official-source label.</p><div className="method-status"><CheckCircle2 size={15} /> Source authority visible per record</div></article>
            <article className="method-card"><span className="method-number">02</span><History size={24} /><h2>Watch for changes</h2><p>Each successful source run compares normalized records with the last catalog. Discoveries, changes, deactivations, and reactivations become timestamped history events.</p><div className="method-status partial"><CheckCircle2 size={15} /> Change history implemented</div></article>
            <article className="method-card"><span className="method-number">03</span><Fingerprint size={24} /><h2>Prepare, then hand off</h2><p>Reusable profile fields can prepare answers, but the user reviews them before continuing to an external portal. Opening a site is never recorded as a submitted claim.</p><div className="method-status partial"><Info size={15} /> {storageMode === "supabase" ? "Secure account sync connected" : persistenceDisabled ? "Personal storage is disabled on this deployment" : "Browser-only workspace on this deployment"}</div></article>
            <article className="method-card"><span className="method-number">04</span><CircleDollarSign size={24} /><h2>Record the real outcome</h2><p>“Submitted,” “approved,” “issued,” and “received” are separate states. A payment is only recorded from an administrator message or the user.</p><div className="method-status partial"><Info size={15} /> Tracker UI implemented</div></article>
          </div>

          <div className="duration-lab">
            <div className="duration-copy">
              <span className="section-kicker">Duration benchmark</span>
              <h2>No fake countdown to a payout.</h2>
              <p>Each case can show elapsed time from the complaint date. The federal benchmark publishes its cohort, sample size, median, and middle 50% range, and right-censors cases that were still pending at the source snapshot.</p>
              <div className="formula-row"><span>Complaint date</span><ArrowRight size={15} /><span>Current phase</span><ArrowRight size={15} /><span>Comparable cohort</span><ArrowRight size={15} /><span>Survival model</span></div>
            </div>
            <div className="benchmark-card">
              <div className="benchmark-head"><span>Federal Rule 23 allegations · non-MDL origins</span><span className="benchmark-confidence">MEDIUM CONFIDENCE</span></div>
              <strong>{federalLifecycleRange.medianMonths}-month median docket lifecycle</strong>
              <p>Middle 50%: {federalLifecycleRange.p25Months}–{federalLifecycleRange.p75Months} months across {defaultDurationCohort.recordCounts.included.toLocaleString()} unique federal dockets. {defaultDurationCohort.recordCounts.pendingAtSnapshot.toLocaleString()} pending dockets were right-censored.</p>
              <div className="benchmark-scale"><span /><span /><span /><span /></div>
              <div className="benchmark-labels"><span>P25 {federalLifecycleRange.p25Months}m</span><span>Median {federalLifecycleRange.medianMonths}m</span><span>P75 {federalLifecycleRange.p75Months}m</span><span>n={defaultDurationCohort.recordCounts.included.toLocaleString()}</span></div>
              <p className="settlement-clock">Recorded-settlement clock: {federalSettlementRange.medianMonths}-month cause-specific median; middle 50% {federalSettlementRange.p25Months}–{federalSettlementRange.p75Months} months. This is not a settlement probability or payout timeline.</p>
              <small>{durationBenchmarks.source.provider} snapshot {durationBenchmarks.source.snapshotDate} · {durationBenchmarks.methodology.estimator}. The class-action field has no FJC quality-control check. Historical comparison is not a prediction.</small>
            </div>
          </div>

          <div className="coverage-table-wrap">
            <div className="coverage-head"><div><h2>Coverage control room</h2><p>Exactly what this catalog monitors—and what it does not.</p></div><span>Run: {checkedLabel(catalogGeneratedAt)}</span></div>
            <div className="coverage-table" role="table" aria-label="Coverage status">
              <div className="coverage-row table-header" role="row"><span>Layer</span><span>Current evidence</span><span>Target cadence</span><span>Status</span></div>
              {coverage.sources.map((source) => (
                <div className="coverage-row" role="row" key={source.id}><span><a href={source.url} target="_blank" rel="noreferrer">{source.label} <ExternalLink size={11} /></a></span><span>{source.recordCount.toLocaleString()} records checked</span><span>Daily</span><b className={source.status === "ok" ? "status-live" : source.status === "partial" ? "status-partial" : "status-hold"}>{source.status === "ok" ? "Current" : source.status === "partial" ? "Partial backfill" : "Failed"}</b></div>
              ))}
              <div className="coverage-row" role="row"><span>Individually checked claim destinations</span><span>{allCases.filter((item) => item.verificationState === "controlling_document_verified").length} hand-reviewed claim sites</span><span>On material change</span><b className="status-partial">Partial</b></div>
              <div className="coverage-row" role="row"><span>Federal duration benchmark</span><span>{defaultDurationCohort.recordCounts.included.toLocaleString()} unique FJC dockets; snapshot {durationBenchmarks.source.snapshotDate}</span><span>Quarterly</span><b className="status-partial">Medium confidence</b></div>
              <div className="coverage-row" role="row"><span>State courts</span><span>Partial; no complete national feed</span><span>Daily</span><b className="status-hold">Coverage gap</b></div>
              <div className="coverage-row" role="row"><span>Personal claim status</span><span>{storageMode === "supabase" ? "Account-bound private records" : "Browser-stored, user-recorded activity"}</span><span>On change</span><b className={storageMode === "supabase" ? "status-live" : "status-partial"}>{storageMode === "supabase" ? "Connected" : "Browser only"}</b></div>
            </div>
          </div>
        </section>
      )}

      {page === "privacy" && (
        <section className="method-page privacy-page">
          <div className="method-hero">
            <span className="section-kicker">Privacy</span>
            <h1>Your legal history should not become advertising inventory.</h1>
            <p>Last updated August 8, 2026. This page describes the data handled by the public Verdue site and its optional private workspace.</p>
          </div>
          <div className="method-grid privacy-grid">
            <article className="method-card"><ShieldCheck size={24} /><h2>Anonymous catalog browsing</h2><p>Browsing, searching, sorting, and filtering the public catalog do not require an account. The site does not ask for an SSN, bank credentials, tax ID, health details, or information about minors in the reusable profile.</p></article>
            <article className="method-card"><LockKeyhole size={24} /><h2>Private workspace data</h2><p>A profile can contain name, contact information, and address. Claim history can contain case IDs, user-reported status, confirmation numbers, dates, amounts, and private notes. The site never treats those entries as court-verified facts.</p></article>
            <article className="method-card"><Fingerprint size={24} /><h2>Where records live</h2><p>{storageMode === "supabase" ? "Signed-in records are stored in an account-bound database with row-level access controls." : persistenceDisabled ? "This deployment does not create accounts or retain profiles, saved cases, or personal claim history." : "On this deployment, workspace records stay in this browser's local storage and do not sync across devices."} Public catalog records and source links are not personal data.</p></article>
            <article className="method-card"><ExternalLink size={24} /><h2>External destinations</h2><p>Claim forms, court dockets, agency pages, and attorney sites are operated by third parties with their own privacy terms. Verdue opens those pages but does not receive the answers you submit there.</p></article>
            <article className="method-card"><X size={24} /><h2>Deletion and retention</h2><p>{persistenceDisabled ? "No personal Verdue workspace is created on this deployment." : "You can delete a browser workspace or a signed-in account from the profile panel. That removes the private Verdue records in scope; it cannot delete information already sent directly to a settlement administrator, agency, court, or law firm."}</p></article>
            <article className="method-card"><Info size={24} /><h2>Corrections and questions</h2><p>Catalog corrections should identify the public record and controlling source without including private claimant information.</p><a className="privacy-link" href="https://github.com/bgf419/verdue/issues" target="_blank" rel="noreferrer">Open a public correction request <ExternalLink size={14} /></a></article>
          </div>
        </section>
      )}

      <footer>
        <div className="footer-brand"><span className="brand-mark">V</span><div><strong>Verdue</strong><span>Class-action discovery with source transparency</span></div></div>
        <p>This service is not a law firm and does not provide legal advice or representation. A possible match does not establish eligibility. Courts and settlement administrators determine claim validity and payment. Submitting a claim does not guarantee approval or compensation.</p>
        <div><button onClick={() => setPage("method")}>Data quality</button><button onClick={() => setPage("privacy")}>Privacy</button><a href="https://github.com/bgf419/verdue/issues" target="_blank" rel="noreferrer">Corrections</a></div>
      </footer>

      {activeCase && (
        <div role="presentation" className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setActiveCase(null); }}>
          <section className="case-modal" role="dialog" aria-modal="true" aria-labelledby="case-modal-title">
            <button className="modal-close" onClick={() => setActiveCase(null)} aria-label="Close case details"><X size={20} /></button>
              <div className={`modal-hero accent-${activeCase.accent}`}>
              <div className="company-lockup"><span className="company-monogram">{activeCase.monogram}</span><div><strong>{activeCase.company}</strong><span>{activeCase.category} · {activeCase.jurisdiction}</span></div></div>
              <div className="case-badges">
                <span className="status-badge"><span /> {activeCase.status}</span>
                {activeCase.kind === "potential_class_case" && <span className="change-badge">Indexed · no termination reported · not confirmed active</span>}
                {activeCase.freshness === "stale" && <span className="stale-badge">Stale source check · action paused</span>}
              </div>
              <h2 id="case-modal-title">{activeCase.title}</h2>
              <p>{activeCase.eligibility}</p>
              <div className="modal-top-stats"><div><small>{activeCase.kind === "settlement_claims_open" ? "Listed deadline" : "Listed action"}</small><strong>{activeCase.deadlineLabel}</strong><span>{daysUntil(activeCase.deadline) === 0 ? "Closes today" : daysUntil(activeCase.deadline) !== null && daysUntil(activeCase.deadline)! > 0 ? `${daysUntil(activeCase.deadline)} days left` : "No fixed future deadline shown"}</span></div><div><small>Stated benefit</small><strong>{activeCase.fund}</strong><span>{activeCase.benefit}</span></div><div><small>Source level</small><strong>{sourceLevelLabel(activeCase)}</strong><span>{activeCase.freshness === "stale" ? "Last successful check" : "Checked"} {relativeVerified(activeCase.verifiedAt)}</span></div></div>
            </div>
            <div className="modal-body">
              <div className="modal-main">
                <div className="possible-fit-card"><div><Sparkles size={19} /><span><b>{activeCase.kind === "settlement_claims_open" ? "Possible match check" : activeCase.kind === "government_redress" ? "Program context check" : "Case context check"}</b><small>Informational—not an eligibility or legal-status decision</small></span></div><span className="fit-state">3 facts to confirm</span></div>
                <section className="detail-section"><h3>Before you continue</h3>{activeCase.checklist.map((item, index) => <label className="check-row" key={item}><input type="checkbox" /><span><b>{index + 1}</b>{item}</span></label>)}</section>
                <section className="detail-section"><h3>Case timeline</h3><div className="timeline">{activeCase.timeline.map((item) => <div className={`timeline-item ${item.state}`} key={`${item.label}-${item.date}`}><span className="timeline-node">{item.state === "done" ? <Check size={12} /> : ""}</span><div><strong>{item.label}</strong><span>{item.date}</span></div></div>)}</div></section>
                <section className="detail-section duration-detail"><h3>Duration context</h3><div><strong>{elapsedContext(activeCase)}</strong><span>{activeCase.filedLabel}</span></div><div><strong>{federalLifecycleRange.medianMonths} months median</strong><span>Federal non-MDL docket lifecycle; middle 50% {federalLifecycleRange.p25Months}–{federalLifecycleRange.p75Months} months; n={defaultDurationCohort.recordCounts.included.toLocaleString()}.</span></div><p>MEDIUM confidence: FJC does not quality-check its class-action allegation field. This is a federal cohort comparison, not a prediction or time-to-payment estimate.</p></section>
              </div>
              <aside className="modal-side">
                {activeCase.freshness === "stale" && <div className="stale-modal-warning" role="alert"><Info size={18} /><div><strong>Action link paused</strong><span>This record was retained after its source could not be refreshed. Use the source record below to verify the latest deadline and instructions.</span></div></div>}
                <div className="official-box"><ShieldCheck size={21} /><h3>{sourceDetailHeading(activeCase)}</h3><p>{sourceDetailText(activeCase)}</p><a href={activeCase.sourceUrl} target="_blank" rel="noreferrer">View source record <ExternalLink size={14} /></a>{activeCase.sourceNote && <span className="source-change"><Info size={14} /> {activeCase.sourceNote}</span>}</div>
                {!persistenceDisabled && activeCase.actionRole !== "source_only" && activeCase.actionRole !== "agency_program" && <div className="field-preview"><div><h3>Reusable profile</h3><span>{profileSaved ? "Ready" : "Not complete"}</span></div><p>Copy common contact fields, then review every answer on the external form.</p><button onClick={() => void copyProfileSummary()}><Copy size={15} /> {profileSaved ? "Copy contact fields" : "Set up profile"}</button></div>}
                <button className="official-cta" disabled={activeCase.freshness === "stale"} onClick={() => continueToClaim(activeCase)}>{activeCase.freshness === "stale" ? "Action paused until source is rechecked" : activeCase.actionLabel} {activeCase.freshness !== "stale" && <ExternalLink size={16} />}</button>
                <small className="handoff-note">{activeCase.freshness === "stale" ? "Open the source record above and verify the current information before taking action." : <>You will leave Verdue. {activeCase.actionRole === "source_only" || activeCase.actionRole === "agency_program" ? "Opening this source is not recorded as an application." : "Opening a destination is recorded as a handoff, never as a submitted or accepted claim."}</>}</small>
              </aside>
            </div>
          </section>
        </div>
      )}

      {editingClaim && (
        <div role="presentation" className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setEditingClaimId(null); }}>
          <section className="account-modal claim-outcome-modal" role="dialog" aria-modal="true" aria-labelledby="claim-history-title">
            <button className="modal-close" onClick={() => setEditingClaimId(null)} aria-label="Close claim history"><X size={20} /></button>
            <form className="profile-form" onSubmit={saveClaimOutcome}>
              <span className="section-kicker">User-reported claim history</span>
              <h2 id="claim-history-title">{editingClaimCase?.company ?? "Tracked claim"}</h2>
              <p>{editingClaimCase?.title ?? editingClaim.caseId}. Verdue keeps your status separate from the court or settlement status.</p>
              <div className="profile-field-grid">
                <label className="wide"><span>Your current status</span><select value={claimDraft.personalStatus} onChange={(event) => setClaimDraft({ ...claimDraft, personalStatus: event.target.value })}>
                  <option value="started">External destination opened</option>
                  <option value="submitted">Submitted — reported by me</option>
                  <option value="confirmation_recorded">Submission confirmation recorded</option>
                  <option value="under_review">Administrator review</option>
                  <option value="approved">Administrator approved</option>
                  <option value="denied">Administrator denied</option>
                  <option value="payment_pending">Payment pending or issued</option>
                  <option value="paid">Payment received — reported by me</option>
                  <option value="closed">Closed</option>
                  <option value="withdrawn">Withdrawn</option>
                  <option value="unknown">Outcome unknown</option>
                </select></label>
                <label><span>Submission date</span><input type="date" value={claimDraft.submittedAt} onChange={(event) => setClaimDraft({ ...claimDraft, submittedAt: event.target.value })} /></label>
                <label><span>Confirmation number</span><input value={claimDraft.confirmationNumber} onChange={(event) => setClaimDraft({ ...claimDraft, confirmationNumber: event.target.value })} /></label>
                <label><span>Approved amount ($)</span><input inputMode="decimal" value={claimDraft.approvedAmount} onChange={(event) => setClaimDraft({ ...claimDraft, approvedAmount: event.target.value })} placeholder="0.00" /></label>
                <label><span>Received amount ($)</span><input inputMode="decimal" value={claimDraft.receivedAmount} onChange={(event) => setClaimDraft({ ...claimDraft, receivedAmount: event.target.value })} placeholder="0.00" /></label>
                <label className="wide"><span>Amount evidence</span><select value={claimDraft.amountSource} onChange={(event) => setClaimDraft({ ...claimDraft, amountSource: event.target.value })}>
                  <option value="user_reported">Reported by me</option>
                  <option value="settlement_administrator_notice">Settlement administrator notice</option>
                  <option value="payment_record">Payment record</option>
                </select></label>
              </div>
              <section className="claim-event-history" aria-labelledby="claim-event-history-title">
                <div className="claim-event-history-heading">
                  <div><span className="section-kicker">Timestamped activity</span><h3 id="claim-event-history-title">Event history</h3></div>
                  <small>{storageMode === "local" ? "Stored in this browser" : "Loaded from your account"}</small>
                </div>
                {claimEventLoadStatus === "loading" && <p className="claim-event-state">Loading event history…</p>}
                {claimEventLoadStatus === "failed" && <div className="claim-event-state error"><span>Event history could not be loaded.</span>{editingClaim && <button type="button" onClick={() => openClaimEditor(editingClaim)}>Retry</button>}</div>}
                {claimEventLoadStatus !== "loading" && claimEventLoadStatus !== "failed" && editingClaimEvents.length === 0 && <p className="claim-event-state">No timestamped events are available for this claim yet.</p>}
                {claimEventLoadStatus !== "loading" && claimEventLoadStatus !== "failed" && editingClaimEvents.length > 0 && (
                  <ol className="claim-event-list">
                    {editingClaimEvents.map((event) => (
                      <li key={event.id}>
                        <span className="claim-event-node" />
                        <div>
                          <div className="claim-event-title"><strong>{eventTypeLabel(event)}</strong><time dateTime={event.occurredAt}>{checkedLabel(event.occurredAt)}</time></div>
                          <span>{event.personalStatus ? personalStatusLabel(event.personalStatus) : "No status change"} · {eventProvenanceLabel(event.provenance)}</span>
                          {event.confirmationNumber && <small>Confirmation: {event.confirmationNumber}</small>}
                          {event.amountCents !== null && <small>{event.amountKind === "received" ? "Received" : "Approved"}: ${(event.amountCents / 100).toFixed(2)}</small>}
                          {event.note && <p>{event.note}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <div className="sensitive-note"><Info size={17} /><span>Changing this form updates only your personal record. It does not change the case and does not transmit a claim to an administrator.</span></div>
              <button className="profile-save" type="submit">Save claim history <ArrowRight size={16} /></button>
            </form>
          </section>
        </div>
      )}

      {accountOpen && !persistenceDisabled && (
        <div role="presentation" className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setAccountOpen(false); }}>
          <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
            <button className="modal-close" onClick={() => setAccountOpen(false)} aria-label="Close account panel"><X size={20} /></button>
            {!user ? (
              <form className="account-gate" onSubmit={storageMode === "local" ? createLocalAccount : submitAccount}>
                <span className="account-illustration"><LockKeyhole size={27} /></span>
                <span className="section-kicker">Private claim workspace</span>
                <h2 id="account-title">{storageMode === "supabase" && accountMode === "signin" ? "Sign in to your private workspace." : "Create a private account for your claim ledger."}</h2>
                <p>Your Account ID is only a login handle. Add your real name and contact email separately inside the reusable profile after sign-in.</p>
                <div className="account-benefits"><span><CheckCircle2 size={16} /> Copy common contact fields</span><span><CheckCircle2 size={16} /> Keep a provenance-labeled claim history</span><span><CheckCircle2 size={16} /> Record approved and received amounts separately</span></div>
                {storageMode === "local" ? (
                  <>
                    <div className="profile-field-grid account-create-fields">
                      <label className="wide"><span>Account ID · 3–32 letters, numbers, . _ or -; no trailing/repeated dots</span><input value={accountDraft.accountId} onChange={(event) => setAccountDraft({ ...accountDraft, accountId: event.target.value.toLowerCase() })} minLength={3} maxLength={32} pattern="(?!.*\.\.)(?!.*\.$)[a-z0-9][a-z0-9._-]{2,31}" required autoComplete="username" autoCapitalize="none" spellCheck={false} /></label>
                    </div>
                    <button className="sign-in-cta" type="submit">Create browser workspace <ArrowRight size={16} /></button>
                    <small>Your profile and claim history stay on this device. This public preview does not yet sync across devices.</small>
                  </>
                ) : (
                  <>
                    <div className="profile-field-grid account-create-fields">
                      <label className="wide"><span>Account ID · 3–32 letters, numbers, . _ or -; no trailing/repeated dots</span><input value={accountDraft.accountId} onChange={(event) => setAccountDraft({ ...accountDraft, accountId: event.target.value.toLowerCase() })} minLength={3} maxLength={32} pattern="(?!.*\.\.)(?!.*\.$)[a-z0-9][a-z0-9._-]{2,31}" required autoComplete="username" autoCapitalize="none" spellCheck={false} /></label>
                      <label className="wide"><span>Password {accountMode === "signup" ? "· 12+ characters with upper/lowercase and a number" : ""}</span><input type="password" minLength={12} pattern={accountMode === "signup" ? "(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{12,}" : undefined} value={accountDraft.password} onChange={(event) => setAccountDraft({ ...accountDraft, password: event.target.value })} required autoComplete={accountMode === "signup" ? "new-password" : "current-password"} /></label>
                    </div>
                    {accountError && <div className="account-error" role="alert">{accountError}</div>}
                    <button className="sign-in-cta" type="submit" disabled={accountBusy}>{accountBusy ? "Working…" : accountMode === "signup" ? "Create secure account" : "Sign in"} <ArrowRight size={16} /></button>
                    <button className="account-mode-toggle" type="button" onClick={() => { setAccountMode((current) => current === "signup" ? "signin" : "signup"); setAccountError(""); }}>
                      {accountMode === "signup" ? "Already have an account? Sign in" : "Need an account? Create one"}
                    </button>
                    <small>No email verification or password recovery is available yet. Save your Account ID and password securely; Verdue cannot recover a forgotten password in this release.</small>
                  </>
                )}
              </form>
            ) : (
              <form className="profile-form" onSubmit={saveProfile}>
                <span className="section-kicker">Reusable claim profile</span>
                <h2 id="account-title">Your common contact details</h2>
                <p>These fields can prepare a checklist. Nothing is sent to an administrator without your review.</p>
                <div className="profile-field-grid">
                  <label className="wide"><span>Full legal name</span><input value={profile.fullName} onChange={(event) => setProfile({ ...profile, fullName: event.target.value })} required /></label>
                  <label><span>Email</span><input type="email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} required /></label>
                  <label><span>Phone</span><input value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /></label>
                  <label className="wide"><span>Street address</span><input value={profile.address} onChange={(event) => setProfile({ ...profile, address: event.target.value })} /></label>
                  <label><span>City</span><input value={profile.city} onChange={(event) => setProfile({ ...profile, city: event.target.value })} /></label>
                  <label><span>State</span><input maxLength={2} value={profile.state} onChange={(event) => setProfile({ ...profile, state: event.target.value.toUpperCase() })} /></label>
                  <label><span>ZIP code</span><input inputMode="numeric" value={profile.zip} onChange={(event) => setProfile({ ...profile, zip: event.target.value })} /></label>
                </div>
                <div className="sensitive-note"><ShieldCheck size={17} /><span><strong>Deliberately excluded:</strong> SSN, bank credentials, tax IDs, health details, and information about minors.</span></div>
                <button className="profile-save" type="submit">{storageMode === "local" ? "Save profile on this device" : "Save private profile"} <ArrowRight size={16} /></button>
                <div className="local-workspace-controls">
                  <span>{storageMode === "local" ? "Browser-only storage · no cross-device sync" : "Encrypted connection · private records are account-bound"}</span>
                  <div>
                    {storageMode === "supabase" && <button type="button" onClick={() => void signOut()}>Sign out</button>}
                    <button type="button" disabled={accountBusy} onClick={storageMode === "local" ? deleteLocalWorkspace : () => void deleteSyncedAccount()}>{storageMode === "local" ? "Delete this workspace" : "Delete account"}</button>
                  </div>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status"><CheckCircle2 size={17} /> {toast}</div>}
    </main>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <fieldset className="filter-group"><legend>{title}</legend>{children}</fieldset>;
}

function Radio({ label, count, checked, onClick }: { label: string; count?: number; checked: boolean; onClick: () => void }) {
  return <button className={`filter-option ${checked ? "selected" : ""}`} onClick={onClick}><span className="fake-radio">{checked && <span />}</span><span>{label}</span>{typeof count === "number" && <small>{count}</small>}</button>;
}
