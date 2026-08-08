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
import { catalogCheckedAt, cases, type CaseCategory, type ClaimCase } from "./cases";

type User = {
  displayName: string;
  email: string;
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
};

type ClaimAppProps = {
  user: User;
  signInPath: string;
};

const categories: CaseCategory[] = [
  "Privacy",
  "Data breach",
  "Consumer",
  "Employment",
  "Healthcare",
];

const demoClaims = [
  {
    company: "AT&T",
    title: "Customer data incident settlement",
    status: "Confirmation recorded",
    provenance: "Imported from confirmation email",
    date: "Submitted Dec 12, 2025",
    amount: "Outcome unknown",
    tone: "progress",
  },
  {
    company: "Meta",
    title: "Consumer privacy settlement",
    status: "Payment received",
    provenance: "Reported by account holder",
    date: "Received Sep 18, 2025",
    amount: "$31.77 received",
    tone: "paid",
  },
  {
    company: "Capital One",
    title: "360 Savings account settlement",
    status: "Under review",
    provenance: "Status reported by account holder",
    date: "Submitted Sep 30, 2025",
    amount: "Stated amount varies",
    tone: "review",
  },
] as const;

function daysUntil(deadline: string) {
  const now = new Date("2026-08-08T10:40:00-04:00");
  return Math.max(0, Math.ceil((new Date(deadline).getTime() - now.getTime()) / 86_400_000));
}

function elapsedLabel(filedDate?: string) {
  if (!filedDate) return "Elapsed time unavailable";
  const start = new Date(`${filedDate}T12:00:00Z`);
  const end = new Date("2026-08-08T12:00:00Z");
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

function relativeVerified(verifiedAt: string) {
  const verified = new Date(verifiedAt);
  const now = new Date("2026-08-08T10:40:00-04:00");
  const mins = Math.max(0, Math.round((now.getTime() - verified.getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function ClaimApp({ user, signInPath }: ClaimAppProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CaseCategory | "All">("All");
  const [geography, setGeography] = useState<"All" | "Nationwide" | "State-specific">("All");
  const [proof, setProof] = useState<"All" | "No documents stated" | "Notice or ID">("All");
  const [deadlineWindow, setDeadlineWindow] = useState<"All" | "30" | "45" | "60">("All");
  const [sort, setSort] = useState("deadline");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [activeCase, setActiveCase] = useState<ClaimCase | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [page, setPage] = useState<"discover" | "claims" | "method">("discover");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [storedClaims, setStoredClaims] = useState<StoredClaim[]>([]);
  const [profile, setProfile] = useState<Profile>({
    fullName: user?.displayName ?? "",
    email: user?.email ?? "",
    phone: "",
    address: "",
    city: "",
    state: "",
    zip: "",
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
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([
      fetch("/api/profile").then((response) => (response.ok ? response.json() : null)),
      fetch("/api/applications").then((response) => (response.ok ? response.json() : null)),
    ])
      .then(([profileResult, claimsResult]) => {
        if (cancelled) return;
        if (profileResult?.profile) {
          setProfile({
            fullName: profileResult.profile.fullName ?? user.displayName,
            email: profileResult.profile.email ?? user.email,
            phone: profileResult.profile.phone ?? "",
            address: profileResult.profile.address ?? "",
            city: profileResult.profile.city ?? "",
            state: profileResult.profile.state ?? "",
            zip: profileResult.profile.zip ?? "",
          });
          setProfileSaved(true);
        }
        if (Array.isArray(claimsResult?.claims)) setStoredClaims(claimsResult.claims);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);

  const filteredCases = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...cases]
      .filter((item) => {
        if (category !== "All" && item.category !== category) return false;
        if (geography !== "All" && item.geography !== geography) return false;
        if (proof !== "All" && item.proof !== proof) return false;
        if (deadlineWindow !== "All" && daysUntil(item.deadline) > Number(deadlineWindow)) return false;
        if (!normalized) return true;
        return [
          item.company,
          item.title,
          item.category,
          item.eligibility,
          item.jurisdiction,
          item.caseNumber,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .sort((a, b) => {
        if (sort === "new") return b.verifiedAt.localeCompare(a.verifiedAt);
        if (sort === "benefit") return b.benefitRank - a.benefitRank;
        if (sort === "effort") return a.effortMinutes - b.effortMinutes;
        if (sort === "age") {
          if (!a.filedDate) return 1;
          if (!b.filedDate) return -1;
          return a.filedDate.localeCompare(b.filedDate);
        }
        return a.deadline.localeCompare(b.deadline);
      });
  }, [category, deadlineWindow, geography, proof, query, sort]);

  const activeFilters = [
    category !== "All" ? category : null,
    geography !== "All" ? geography : null,
    proof !== "All" ? proof : null,
    deadlineWindow !== "All" ? `Within ${deadlineWindow} days` : null,
  ].filter(Boolean);

  const clearFilters = () => {
    setCategory("All");
    setGeography("All");
    setProof("All");
    setDeadlineWindow("All");
    setQuery("");
  };

  const toggleSaved = (id: string) => {
    if (!user) {
      setAccountOpen(true);
      return;
    }
    setSaved((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
    setToast(saved.includes(id) ? "Removed from saved cases" : "Saved to your watchlist");
  };

  const continueToClaim = (item: ClaimCase) => {
    if (user) {
      void fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId: item.id, action: "official_site_opened" }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((result) => {
          if (!result?.claim) return;
          setStoredClaims((current) => [
            result.claim,
            ...current.filter((claim) => claim.caseId !== result.claim.caseId),
          ]);
        })
        .catch(() => undefined);
    }
    window.open(item.claimUrl, "_blank", "noopener,noreferrer");
    setToast(user ? "Official form opened · activity recorded" : "Official claim form opened");
  };

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user) return;
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!response.ok) throw new Error("Profile save failed");
      setProfileSaved(true);
      setToast("Profile saved for future claim preparation");
    } catch {
      setToast("Profile could not be saved yet");
    }
  };

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
          <button className={page === "claims" ? "active" : ""} onClick={() => setPage("claims")}>
            My claims
          </button>
          <button className={page === "method" ? "active" : ""} onClick={() => setPage("method")}>
            How it works
          </button>
        </nav>

        <div className="header-actions">
          <button className="icon-button notification-button" aria-label="Notifications">
            <Bell size={18} />
            <span className="notification-dot" />
          </button>
          <button className="account-button" onClick={() => setAccountOpen(true)}>
            <span className="account-avatar">{user ? user.displayName.slice(0, 1).toUpperCase() : <UserRound size={16} />}</span>
            <span>{user ? "Profile" : "Create account"}</span>
          </button>
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
            <button onClick={() => { setPage("claims"); setMobileNavOpen(false); }}>My claims</button>
            <button onClick={() => { setPage("method"); setMobileNavOpen(false); }}>How it works</button>
          </div>
        )}
      </header>

      {page === "discover" && (
        <>
          <section className="hero" id="top">
            <div className="hero-copy">
              <div className="eyebrow">
                <span className="live-dot" /> Research snapshot · {cases.length} official claim sites checked
              </div>
              <h1>
                Find claims you may qualify for. <em>Track what happens next.</em>
              </h1>
              <p className="hero-subtitle">
                Search court-authorized settlement pages in plain English. We organize the public record; courts and administrators decide eligibility and payment.
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
                <button onClick={() => setDeadlineWindow("30")}><CalendarClock size={14} /> Closing in 30 days</button>
                <button onClick={() => setProof("No documents stated")}><FileCheck2 size={14} /> No documents stated</button>
                <button onClick={() => setSort("new")}><Sparkles size={14} /> Recently verified</button>
              </div>
            </div>

            <aside className="match-panel">
              <div className="match-panel-top">
                <div>
                  <span className="mini-label">Your possible matches</span>
                  <strong>{user ? "2 need a closer look" : "Unlock personalized screening"}</strong>
                </div>
                <span className="match-orbit"><Fingerprint size={24} /></span>
              </div>
              <div className="match-signal-row">
                <span className="signal-icon coral"><Check size={15} /></span>
                <div><b>State and ZIP</b><span>Used only when a case is location-specific</span></div>
                <span className={profile.state ? "signal-status complete" : "signal-status"}>{profile.state ? "Added" : "Missing"}</span>
              </div>
              <div className="match-signal-row">
                <span className="signal-icon mint"><History size={15} /></span>
                <div><b>Brands and services</b><span>You choose what can be used for matching</span></div>
                <span className="signal-status">Optional</span>
              </div>
              <div className="match-signal-row">
                <span className="signal-icon violet"><LockKeyhole size={15} /></span>
                <div><b>Reusable claim profile</b><span>Preview every field before it leaves Verdue</span></div>
                <span className={profileSaved ? "signal-status complete" : "signal-status"}>{profileSaved ? "Ready" : "Not set"}</span>
              </div>
              <button className="match-cta" onClick={() => setAccountOpen(true)}>
                {user ? "Complete your profile" : "Create a private profile"} <ArrowRight size={16} />
              </button>
              <p><ShieldCheck size={13} /> We do not store SSNs, bank credentials, or health details in your reusable profile.</p>
            </aside>
          </section>

          <section className="trust-strip" aria-label="Catalog status">
            <div><strong>{cases.length}</strong><span>open claim windows in this snapshot</span></div>
            <div><strong>100%</strong><span>linked to an official settlement site</span></div>
            <div><strong>1</strong><span>deadline change caught in this review</span></div>
            <div className="truth-cell"><ShieldCheck size={20} /><span>Possible match ≠ eligibility decision</span></div>
          </section>

          <section className="catalog-section" id="catalog">
            <div className="catalog-heading">
              <div>
                <span className="section-kicker">Verified open claims</span>
                <h2>Explore the current research snapshot</h2>
                <p>Checked {catalogCheckedAt}. This prototype does not claim complete U.S. coverage yet.</p>
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
                  <span><SlidersHorizontal size={16} /> Filter claims</span>
                  <button onClick={clearFilters}>Reset</button>
                </div>

                <FilterGroup title="Deadline">
                  <Radio label="Any deadline" checked={deadlineWindow === "All"} onClick={() => setDeadlineWindow("All")} />
                  <Radio label="Within 30 days" count={3} checked={deadlineWindow === "30"} onClick={() => setDeadlineWindow("30")} />
                  <Radio label="Within 45 days" count={6} checked={deadlineWindow === "45"} onClick={() => setDeadlineWindow("45")} />
                  <Radio label="Within 60 days" count={8} checked={deadlineWindow === "60"} onClick={() => setDeadlineWindow("60")} />
                </FilterGroup>

                <FilterGroup title="Category">
                  <Radio label="All categories" count={cases.length} checked={category === "All"} onClick={() => setCategory("All")} />
                  {categories.map((item) => (
                    <Radio
                      key={item}
                      label={item}
                      count={cases.filter((entry) => entry.category === item).length}
                      checked={category === item}
                      onClick={() => setCategory(item)}
                    />
                  ))}
                </FilterGroup>

                <FilterGroup title="Geography">
                  <Radio label="Any geography" checked={geography === "All"} onClick={() => setGeography("All")} />
                  <Radio label="Nationwide" count={7} checked={geography === "Nationwide"} onClick={() => setGeography("Nationwide")} />
                  <Radio label="State-specific" count={2} checked={geography === "State-specific"} onClick={() => setGeography("State-specific")} />
                </FilterGroup>

                <FilterGroup title="Information needed">
                  <Radio label="Any requirement" checked={proof === "All"} onClick={() => setProof("All")} />
                  <Radio label="No documents stated" count={1} checked={proof === "No documents stated"} onClick={() => setProof("No documents stated")} />
                  <Radio label="Notice or ID" count={3} checked={proof === "Notice or ID"} onClick={() => setProof("Notice or ID")} />
                </FilterGroup>
                <button className="filter-apply" onClick={() => setFiltersOpen(false)}>Show {filteredCases.length} claims</button>
              </aside>

              <div className="results-area">
                <div className="results-toolbar">
                  <div className="result-count">
                    <strong>{filteredCases.length} claim windows</strong>
                    <span>possible action available</span>
                  </div>
                  <div className="toolbar-actions">
                    <button className="mobile-filter-button" onClick={() => setFiltersOpen(true)}><Filter size={16} /> Filters {activeFilters.length ? `(${activeFilters.length})` : ""}</button>
                    <label className="sort-select">
                      <span>Sort</span>
                      <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort claims">
                        <option value="deadline">Deadline soonest</option>
                        <option value="new">Recently verified</option>
                        <option value="effort">Least filing effort</option>
                        <option value="age">Oldest case</option>
                        <option value="benefit">Stated benefit</option>
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
                  {filteredCases.map((item, index) => (
                    <article className={`case-card accent-${item.accent}`} key={item.id}>
                      <div className="case-card-head">
                        <div className="company-lockup">
                          <span className="company-monogram">{item.monogram}</span>
                          <div><strong>{item.company}</strong><span>{item.category}</span></div>
                        </div>
                        <button
                          className={`save-button ${saved.includes(item.id) ? "saved" : ""}`}
                          onClick={() => toggleSaved(item.id)}
                          aria-label={saved.includes(item.id) ? "Remove saved case" : "Save case"}
                        >
                          {saved.includes(item.id) ? <Check size={17} /> : <Bell size={17} />}
                        </button>
                      </div>
                      <div className="case-badges">
                        <span className="status-badge"><span /> {item.status}</span>
                        {item.sourceNote && <span className="change-badge">Deadline changed</span>}
                      </div>
                      <h3>{item.title}</h3>
                      <p className="eligibility-copy">{item.eligibility}</p>
                      <div className="deadline-block">
                        <div><span>Claim deadline</span><strong>{item.deadlineLabel}</strong></div>
                        <div className={daysUntil(item.deadline) <= 21 ? "countdown urgent" : "countdown"}>
                          <b>{daysUntil(item.deadline)}</b><span>days left</span>
                        </div>
                      </div>
                      <div className="case-facts">
                        <div><CircleDollarSign size={16} /><span><small>Stated benefit</small>{item.benefit}</span></div>
                        <div><FileCheck2 size={16} /><span><small>Information</small>{item.proof}</span></div>
                        <div><Clock3 size={16} /><span><small>Estimated effort</small>{item.effortMinutes} minutes</span></div>
                      </div>
                      <div className="case-duration">
                        <span>{elapsedLabel(item.filedDate)}</span>
                        <span className="verified"><ShieldCheck size={13} /> {relativeVerified(item.verifiedAt)}</span>
                      </div>
                      <div className="case-card-actions">
                        <button className="secondary-action" onClick={() => setActiveCase(item)}>Check possible fit</button>
                        <button className="primary-action" onClick={() => continueToClaim(item)} aria-label={`Open official ${item.company} claim form`}>
                          Official form <ExternalLink size={15} />
                        </button>
                      </div>
                      {index === 0 && <span className="closing-ribbon">Closing soon</span>}
                    </article>
                  ))}
                </div>

                {filteredCases.length === 0 && (
                  <div className="empty-state">
                    <Search size={26} />
                    <h3>No claim windows match these filters</h3>
                    <p>Try a broader category or clear the deadline filter.</p>
                    <button onClick={clearFilters}>Clear filters</button>
                  </div>
                )}

                <div className="catalog-note">
                  <Info size={17} />
                  <p><strong>Coverage truth:</strong> this is a verified product prototype with a nine-case research snapshot, not a complete live index. Production launch requires scheduled ingestion, source-change monitoring, and administrator integrations.</p>
                  <button onClick={() => setPage("method")}>See the data plan <ArrowRight size={14} /></button>
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
            <div className="demo-banner"><Sparkles size={17} /><span><strong>Example tracker</strong> — create an account to keep your own confirmations, reminders, and outcomes.</span><button onClick={() => setAccountOpen(true)}>Create account</button></div>
          )}
          {user && storedClaims.length === 0 && (
            <div className="demo-banner"><Info size={17} /><span><strong>Your ledger is empty.</strong> Open an official form from Discover and Verdue will record the handoff here.</span><button onClick={() => setPage("discover")}>Browse claims</button></div>
          )}
          <div className="claim-summary-grid">
            <div><span>Needs attention</span><strong>{user ? 0 : 1}</strong><small>{user ? "No recorded action due" : "Example: one deadline this month"}</small></div>
            <div><span>In progress</span><strong>{user ? storedClaims.length : 2}</strong><small>{user ? "Official-site handoffs recorded" : "Example administrator reviews"}</small></div>
            <div><span>Finished</span><strong>{user ? storedClaims.filter((claim) => claim.receivedAmountCents !== null).length : 1}</strong><small>Payment outcome recorded</small></div>
            <div className="received-card"><span>Total received</span><strong>{user ? `$${(storedClaims.reduce((sum, claim) => sum + (claim.receivedAmountCents ?? 0), 0) / 100).toFixed(2)}` : "$31.77"}</strong><small>{user ? "From your recorded outcomes" : "User-reported example"}</small></div>
          </div>
          <div className="claim-ledger">
            <div className="ledger-head"><div><h2>Application history</h2><p>{user ? "Your records show the source of every status." : "Example records show how provenance is labeled."}</p></div><button><Filter size={15} /> Filter</button></div>
            {(user && storedClaims.length > 0
              ? storedClaims.map((claim) => {
                  const item = cases.find((entry) => entry.id === claim.caseId);
                  return {
                    company: item?.company ?? "Tracked claim",
                    title: item?.title ?? claim.caseId,
                    status: claim.personalStatus === "continued_to_official_site" ? "Continued to official site" : claim.personalStatus,
                    provenance: "Recorded from your Verdue action",
                    date: `Activity ${new Date(claim.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
                    amount: claim.receivedAmountCents !== null ? `$${(claim.receivedAmountCents / 100).toFixed(2)} received` : "Outcome unknown",
                    tone: "progress" as const,
                  };
                })
              : demoClaims
            ).map((claim) => (
                <div className="ledger-row" key={`${claim.company}-${claim.title}`}>
                  <span className={`ledger-status-dot ${claim.tone}`} />
                  <div className="ledger-company"><strong>{claim.company}</strong><span>{claim.title}</span></div>
                  <div><small>Personal claim status</small><strong>{claim.status}</strong><span>{claim.provenance}</span></div>
                  <div><small>Activity</small><strong>{claim.date}</strong><span>Case page checked recently</span></div>
                  <div><small>Benefit outcome</small><strong>{claim.amount}</strong><span>Never inferred from case status</span></div>
                  <button aria-label={`Open ${claim.company} claim history`}><ArrowRight size={18} /></button>
                </div>
              ))}
          </div>
        </section>
      )}

      {page === "method" && (
        <section className="method-page">
          <div className="method-hero">
            <span className="section-kicker">How Verdue should work</span>
            <h1>Evidence first. Coverage visible. Uncertainty included.</h1>
            <p>Aggregation is easy to claim and hard to prove. The product therefore exposes what it knows, where it came from, and what is not connected yet.</p>
          </div>
          <div className="method-grid">
            <article className="method-card live"><span className="method-number">01</span><ShieldCheck size={24} /><h2>Verify the action</h2><p>Every claim window must resolve to a court-authorized administrator page or government source. Editorial pages can help discover a case, but cannot be the final source.</p><div className="method-status"><CheckCircle2 size={15} /> Implemented in this snapshot</div></article>
            <article className="method-card"><span className="method-number">02</span><History size={24} /><h2>Watch for changes</h2><p>Claim pages should be checked hourly for deadlines and filing availability; dockets can be checked daily. Every material change becomes a timestamped event.</p><div className="method-status planned"><Clock3 size={15} /> Scheduled worker not connected</div></article>
            <article className="method-card"><span className="method-number">03</span><Fingerprint size={24} /><h2>Prepare, then hand off</h2><p>Reusable profile fields can prepare answers, but the user reviews them before continuing to the official portal. Cross-domain submission is never implied without an administrator integration and receipt.</p><div className="method-status partial"><Info size={15} /> Profile storage scaffolded</div></article>
            <article className="method-card"><span className="method-number">04</span><CircleDollarSign size={24} /><h2>Record the real outcome</h2><p>“Submitted,” “approved,” “issued,” and “received” are separate states. A payment is only recorded from an administrator message or the user.</p><div className="method-status partial"><Info size={15} /> Tracker UI implemented</div></article>
          </div>

          <div className="duration-lab">
            <div className="duration-copy">
              <span className="section-kicker">Duration benchmark</span>
              <h2>No fake countdown to a payout.</h2>
              <p>Each case can show elapsed time from the complaint date. A historical comparison should publish its cohort, sample size, median, and middle 50% range—and should account for unresolved cases rather than silently dropping them.</p>
              <div className="formula-row"><span>Complaint date</span><ArrowRight size={15} /><span>Current phase</span><ArrowRight size={15} /><span>Comparable cohort</span><ArrowRight size={15} /><span>Survival model</span></div>
            </div>
            <div className="benchmark-card">
              <div className="benchmark-head"><span>Privacy settlements · federal</span><span className="withheld">WITHHELD</span></div>
              <strong>Not enough verified history</strong>
              <p>Prototype cohort n &lt; 20. Verdue would not publish a duration range until the calibration threshold is met.</p>
              <div className="benchmark-scale"><span /><span /><span /><span /></div>
              <div className="benchmark-labels"><span>Filed</span><span>Settlement</span><span>Approval</span><span>Distribution</span></div>
              <small>Historical comparison is not a prediction of any case.</small>
            </div>
          </div>

          <div className="coverage-table-wrap">
            <div className="coverage-head"><div><h2>Coverage control room</h2><p>What is real in this build versus what production still needs.</p></div><span>Snapshot: Aug 8, 2026</span></div>
            <div className="coverage-table" role="table" aria-label="Coverage status">
              <div className="coverage-row table-header" role="row"><span>Layer</span><span>Current evidence</span><span>Target cadence</span><span>Status</span></div>
              <div className="coverage-row" role="row"><span>Official claim sites</span><span>9 manually verified</span><span>Hourly</span><b className="status-live">Snapshot live</b></div>
              <div className="coverage-row" role="row"><span>Federal dockets</span><span>Selected filing dates checked</span><span>Daily</span><b className="status-hold">Connector needed</b></div>
              <div className="coverage-row" role="row"><span>State courts</span><span>Partial; no complete national feed</span><span>Daily</span><b className="status-hold">Coverage gap</b></div>
              <div className="coverage-row" role="row"><span>Personal claim status</span><span>User-reported or imported confirmation</span><span>On change</span><b className="status-partial">Provenance required</b></div>
              <div className="coverage-row" role="row"><span>Payment outcome</span><span>Never inferred</span><span>On evidence</span><b className="status-live">Guardrail ready</b></div>
            </div>
          </div>
        </section>
      )}

      <footer>
        <div className="footer-brand"><span className="brand-mark">V</span><div><strong>Verdue</strong><span>Verified claim discovery & tracking</span></div></div>
        <p>This service is not a law firm and does not provide legal advice or representation. A possible match does not establish eligibility. Courts and settlement administrators determine claim validity and payment. Submitting a claim does not guarantee approval or compensation.</p>
        <div><button onClick={() => setPage("method")}>Data quality</button><button>Privacy</button><button>Corrections</button></div>
      </footer>

      {activeCase && (
        <div role="presentation" className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setActiveCase(null); }}>
          <section className="case-modal" role="dialog" aria-modal="true" aria-labelledby="case-modal-title">
            <button className="modal-close" onClick={() => setActiveCase(null)} aria-label="Close case details"><X size={20} /></button>
            <div className={`modal-hero accent-${activeCase.accent}`}>
              <div className="company-lockup"><span className="company-monogram">{activeCase.monogram}</span><div><strong>{activeCase.company}</strong><span>{activeCase.category} · {activeCase.jurisdiction}</span></div></div>
              <span className="status-badge"><span /> {activeCase.status}</span>
              <h2 id="case-modal-title">{activeCase.title}</h2>
              <p>{activeCase.eligibility}</p>
              <div className="modal-top-stats"><div><small>Deadline</small><strong>{activeCase.deadlineLabel}</strong><span>{daysUntil(activeCase.deadline)} days left</span></div><div><small>Stated benefit</small><strong>{activeCase.fund}</strong><span>{activeCase.benefit}</span></div><div><small>Source</small><strong>Official administrator</strong><span>Checked {relativeVerified(activeCase.verifiedAt)}</span></div></div>
            </div>
            <div className="modal-body">
              <div className="modal-main">
                <div className="possible-fit-card"><div><Sparkles size={19} /><span><b>Possible match check</b><small>Informational—not an eligibility decision</small></span></div><span className="fit-state">3 facts to confirm</span></div>
                <section className="detail-section"><h3>Before you continue</h3>{activeCase.checklist.map((item, index) => <label className="check-row" key={item}><input type="checkbox" /><span><b>{index + 1}</b>{item}</span></label>)}</section>
                <section className="detail-section"><h3>Case timeline</h3><div className="timeline">{activeCase.timeline.map((item) => <div className={`timeline-item ${item.state}`} key={`${item.label}-${item.date}`}><span className="timeline-node">{item.state === "done" ? <Check size={12} /> : ""}</span><div><strong>{item.label}</strong><span>{item.date}</span></div></div>)}</div></section>
                <section className="detail-section duration-detail"><h3>Duration context</h3><div><strong>{elapsedLabel(activeCase.filedDate)}</strong><span>{activeCase.filedLabel}</span></div><div><strong>Benchmark withheld</strong><span>Fewer than 20 verified comparable resolved cases in this prototype dataset.</span></div><p>Historical comparison is not a prediction of this case.</p></section>
              </div>
              <aside className="modal-side">
                <div className="official-box"><ShieldCheck size={21} /><h3>Official source verified</h3><p>{activeCase.administrator} maintains the linked claim information.</p><a href={activeCase.sourceUrl} target="_blank" rel="noreferrer">View official case site <ExternalLink size={14} /></a>{activeCase.sourceNote && <span className="source-change"><Info size={14} /> {activeCase.sourceNote}</span>}</div>
                <div className="field-preview"><div><h3>Reusable profile</h3><span>{profileSaved ? "Ready" : "Not complete"}</span></div><p>We can prepare common contact fields. You will review everything on the official form.</p><button onClick={() => setAccountOpen(true)}><Copy size={15} /> {profileSaved ? "Review saved fields" : "Set up profile"}</button></div>
                <button className="official-cta" onClick={() => continueToClaim(activeCase)}>Continue to official claim form <ExternalLink size={16} /></button>
                <small className="handoff-note">You will leave Verdue. The administrator—not Verdue—receives and decides your claim.</small>
              </aside>
            </div>
          </section>
        </div>
      )}

      {accountOpen && (
        <div role="presentation" className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setAccountOpen(false); }}>
          <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
            <button className="modal-close" onClick={() => setAccountOpen(false)} aria-label="Close account panel"><X size={20} /></button>
            {!user ? (
              <div className="account-gate">
                <span className="account-illustration"><LockKeyhole size={27} /></span>
                <span className="section-kicker">Private claim workspace</span>
                <h2 id="account-title">Create one profile. Reuse only what you choose.</h2>
                <p>Save contact details, application confirmations, reminders, and real payment outcomes. Sensitive identifiers are never general profile fields.</p>
                <div className="account-benefits"><span><CheckCircle2 size={16} /> Prepare common contact fields</span><span><CheckCircle2 size={16} /> Keep a provenance-labeled claim history</span><span><CheckCircle2 size={16} /> Get deadline and status-change reminders</span></div>
                <a className="sign-in-cta" href={signInPath}>Create secure account <ArrowRight size={16} /></a>
                <small>Secure platform sign-in is required for persistent personal records.</small>
              </div>
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
                <button className="profile-save" type="submit">Save private profile <ArrowRight size={16} /></button>
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
