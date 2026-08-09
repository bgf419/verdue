import {
  ArrowRight,
  Check,
  ChevronLeft,
  Info,
  MessageCircle,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  EMPTY_FINDER_PREFERENCES,
  FINDER_EXPERIENCES,
  FINDER_GOALS,
  FINDER_SUGGESTIONS,
  mergeFinderPreferences,
  parseFinderMessage,
  rankCatalogCases,
  sensitiveFinderInputReason,
  type FinderExperience,
  type FinderMatch,
  type FinderPreferences,
} from "./case-finder";
import type { CatalogCase, CatalogKind } from "./catalog";

type FinderMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type CaseFinderProps = {
  cases: CatalogCase[];
  catalogLoading: boolean;
  onReviewCase: (item: CatalogCase) => void;
};

const INITIAL_MESSAGE: FinderMessage = {
  id: "finder-welcome",
  role: "assistant",
  text: "Tell me a company, product, state, or what happened. I’ll search only Verdue’s catalog and explain why each result may be worth reviewing.",
};

const PROOF_OPTIONS: Array<{ value: FinderPreferences["proof"]; label: string; detail: string }> = [
  { value: "Any", label: "Any information level", detail: "Do not use this as a ranking signal." },
  { value: "No documents stated", label: "No documents stated", detail: "Prioritize listings whose source summary does not state a document requirement." },
  { value: "Notice or ID", label: "I have a notice or ID", detail: "Prioritize listings that mention a notice or identifier." },
  { value: "Records may be requested", label: "I may have records", detail: "Receipts, statements, emails, or similar records may be available." },
];

function finderKindLabel(kind: CatalogKind) {
  const labels: Record<CatalogKind, string> = {
    settlement_claims_open: "Listed claim window",
    government_redress: "Government redress",
    potential_class_case: "Federal docket to watch",
    legal_counsel_intake: "Legal intake",
  };
  return labels[kind];
}

function checkedDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Check time unavailable";
  return `Checked ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

function assistantSummary(matches: FinderMatch[], preferences: FinderPreferences) {
  if (matches.length === 0) {
    if (
      !preferences.keywords &&
      preferences.experiences.length === 0 &&
      !preferences.location &&
      preferences.proof === "Any"
    ) {
      return "I’ve set the catalog layer. Now add a company, product, employer, state, issue, or rough year so I don’t make an arbitrary suggestion.";
    }
    if (preferences.goal === "open_claims") {
      return "No listed open claim matched those catalog signals. That does not mean you are ineligible—Verdue’s reviewed coverage is incomplete. Try another company, state, issue, or year.";
    }
    return "No related record matched those catalog signals. That does not prove none exists—Verdue’s agency and court coverage is partial. Try a specific company or case name.";
  }
  return `I found ${matches.length} catalog ${matches.length === 1 ? "record" : "records"} worth checking. These are possible leads—not eligibility decisions.`;
}

function FinderResultCard({
  match,
  onReview,
}: {
  match: FinderMatch;
  onReview: (item: CatalogCase) => void;
}) {
  return (
    <article className="finder-result-card">
      <div className="finder-result-topline">
        <span>{match.signal}</span>
        <small>{match.item.freshness === "stale" ? "Source needs recheck" : finderKindLabel(match.item.kind)}</small>
      </div>
      <h3>{match.item.company}</h3>
      <p>{match.item.title}</p>
      <ul>
        {match.reasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
      {match.questionsToConfirm[0] && (
        <div className="finder-confirm"><Info size={14} /><span><strong>Still confirm:</strong> {match.questionsToConfirm[0]}</span></div>
      )}
      <div className="finder-result-footer">
        <small>{checkedDate(match.item.verifiedAt)}</small>
        <button type="button" onClick={() => onReview(match.item)}>Review details <ArrowRight size={14} /></button>
      </div>
    </article>
  );
}

export default function CaseFinder({ cases, catalogLoading, onReviewCase }: CaseFinderProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"chat" | "quiz">("chat");
  const [draft, setDraft] = useState("");
  const [preferences, setPreferences] = useState<FinderPreferences>(EMPTY_FINDER_PREFERENCES);
  const [messages, setMessages] = useState<FinderMessage[]>([INITIAL_MESSAGE]);
  const [matches, setMatches] = useState<FinderMatch[]>([]);
  const [quizStep, setQuizStep] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const closeFinder = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => launcherRef.current?.focus());
  };

  useEffect(() => {
    if (!open || mode !== "chat") return;
    inputRef.current?.focus();
  }, [mode, open]);

  useEffect(() => {
    if (!open || mode !== "chat") return;
    requestAnimationFrame(() => chatEndRef.current?.scrollIntoView({ block: "end" }));
  }, [matches, messages, mode, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        requestAnimationFrame(() => launcherRef.current?.focus());
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const showMatches = (nextPreferences: FinderPreferences, userText?: string) => {
    const nextMatches = rankCatalogCases(cases, nextPreferences, 3);
    setPreferences(nextPreferences);
    setMatches(nextMatches);
    setMessages((current) => [
      ...current,
      ...(userText
        ? [{ id: crypto.randomUUID(), role: "user" as const, text: userText }]
        : []),
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: assistantSummary(nextMatches, nextPreferences),
      },
    ]);
  };

  const rejectSensitiveInput = (reason: string) => {
    setDraft("");
    setMatches([]);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `I cleared that entry because it looked like it contained a ${reason}. Search with only a company, product, state, issue type, and rough year.`,
      },
    ]);
  };

  const submitMessage = (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    const sensitiveReason = sensitiveFinderInputReason(message);
    if (sensitiveReason) {
      rejectSensitiveInput(sensitiveReason);
      return;
    }
    const nextPreferences = mergeFinderPreferences(preferences, parseFinderMessage(message));
    showMatches(nextPreferences, message);
    setDraft("");
  };

  const runSuggestion = (suggestion: string) => {
    const nextPreferences = mergeFinderPreferences(preferences, parseFinderMessage(suggestion));
    showMatches(nextPreferences, suggestion);
  };

  const resetFinder = () => {
    setPreferences(EMPTY_FINDER_PREFERENCES);
    setMessages([INITIAL_MESSAGE]);
    setMatches([]);
    setDraft("");
    setQuizStep(0);
    setMode("chat");
  };

  const toggleExperience = (experience: FinderExperience) => {
    setPreferences((current) => ({
      ...current,
      experiences: current.experiences.includes(experience)
        ? current.experiences.filter((item) => item !== experience)
        : [...current.experiences, experience],
    }));
  };

  const finishQuiz = () => {
    const sensitiveReason = sensitiveFinderInputReason(`${preferences.keywords} ${preferences.location}`);
    if (sensitiveReason) {
      setPreferences((current) => ({ ...current, keywords: "", location: "" }));
      rejectSensitiveInput(sensitiveReason);
      setMode("chat");
      return;
    }
    const nextMatches = rankCatalogCases(cases, preferences, 3);
    setMatches(nextMatches);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `${assistantSummary(nextMatches, preferences)} I used only the answers from this quiz.`,
      },
    ]);
    setMode("chat");
  };

  const reviewMatch = (item: CatalogCase) => {
    onReviewCase(item);
    closeFinder(false);
  };

  const openClaimMatches = matches.filter((match) => match.item.kind === "settlement_claims_open");
  const relatedSourceMatches = matches.filter((match) => match.item.kind !== "settlement_claims_open");

  return (
    <>
      <button
        ref={launcherRef}
        className={`finder-launcher ${open ? "open" : ""}`}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="case-finder-panel"
        aria-haspopup="dialog"
        aria-hidden={open}
        tabIndex={open ? -1 : 0}
      >
        <span><Sparkles size={18} /></span>
        <strong>Find my cases</strong>
        <small>Private in-browser match</small>
      </button>

      {open && (
        <section
          ref={panelRef}
          className="case-finder-panel"
          id="case-finder-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="case-finder-title"
        >
          <header className="finder-header">
            <div className="finder-identity">
              <span><MessageCircle size={19} /></span>
              <div>
                <strong id="case-finder-title">Verdue Case Finder</strong>
                <small>Catalog search · not legal advice</small>
              </div>
            </div>
            <div className="finder-header-actions">
              <button type="button" onClick={resetFinder} aria-label="Clear case finder"><RotateCcw size={16} /></button>
              <button type="button" onClick={() => closeFinder()} aria-label="Close case finder"><X size={18} /></button>
            </div>
          </header>

          <div className="finder-privacy-note">
            <ShieldCheck size={16} />
            <span>Answers stay in this browser tab and are not sent to a model or saved after refresh. Do not enter names, account numbers, claim IDs, health details, or information about minors.</span>
          </div>

          <div className="finder-mode-tabs" role="tablist" aria-label="Case finder mode">
            <button id="finder-chat-tab" type="button" role="tab" aria-controls="finder-chat-panel" aria-selected={mode === "chat"} className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")}><MessageCircle size={15} /> Ask the finder</button>
            <button id="finder-quiz-tab" type="button" role="tab" aria-controls="finder-quiz-panel" aria-selected={mode === "quiz"} className={mode === "quiz" ? "active" : ""} onClick={() => setMode("quiz")}><Check size={15} /> Quick quiz</button>
          </div>

          {mode === "chat" ? (
            <>
              <div className="finder-chat" role="tabpanel" id="finder-chat-panel" aria-labelledby="finder-chat-tab">
                <div className="finder-transcript" role="log" aria-live="polite" aria-relevant="additions text">
                  {messages.map((message) => (
                    <div className={`finder-message ${message.role}`} key={message.id}>
                      {message.role === "assistant" && <span className="finder-bot-mark">V</span>}
                      <p>{message.text}</p>
                    </div>
                  ))}
                </div>

                <div className="finder-result-status" role="status">
                  {matches.length > 0 ? `${matches.length} possible catalog ${matches.length === 1 ? "record" : "records"} shown.` : ""}
                </div>

                {matches.length > 0 && (
                  <div className="finder-results" aria-label="Suggested catalog records">
                    {openClaimMatches.length > 0 && (
                      <div className="finder-result-group">
                        <h2>Open claims to review</h2>
                        <p>These have a listed claim window. The official administrator still decides eligibility.</p>
                        {openClaimMatches.map((match) => <FinderResultCard key={match.item.id} match={match} onReview={reviewMatch} />)}
                      </div>
                    )}
                    {relatedSourceMatches.length > 0 && (
                      <div className="finder-result-group related">
                        <h2>Related agency or court records</h2>
                        <p>These are context or monitoring leads, not open applications unless the source explicitly says otherwise.</p>
                        {relatedSourceMatches.map((match) => <FinderResultCard key={match.item.id} match={match} onReview={reviewMatch} />)}
                      </div>
                    )}
                  </div>
                )}

                {messages.length === 1 && (
                  <div className="finder-suggestions" aria-label="Suggested questions">
                    <span>Try asking:</span>
                    {FINDER_SUGGESTIONS.map((suggestion) => (
                      <button type="button" key={suggestion} onClick={() => runSuggestion(suggestion)}>{suggestion}</button>
                    ))}
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <form className="finder-composer" onSubmit={submitMessage}>
                <Search size={17} />
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Example: I used Google in California"
                  aria-label="Ask the case finder"
                  maxLength={240}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" disabled={!draft.trim()} aria-label="Send to case finder"><Send size={17} /></button>
              </form>
            </>
          ) : (
            <div className="finder-quiz" role="tabpanel" id="finder-quiz-panel" aria-labelledby="finder-quiz-tab">
              <div className="finder-quiz-progress">
                <span>Question {quizStep + 1} of 5</span>
                <div role="progressbar" aria-label="Quiz progress" aria-valuemin={1} aria-valuemax={5} aria-valuenow={quizStep + 1}><i style={{ width: `${((quizStep + 1) / 5) * 100}%` }} /></div>
              </div>

              {quizStep === 0 && (
                <fieldset className="finder-question">
                  <legend>What would you like to find?</legend>
                  <p>This controls which catalog layer appears first.</p>
                  <div className="finder-option-list">
                    {FINDER_GOALS.map((goal) => (
                      <button type="button" aria-pressed={preferences.goal === goal.id} className={preferences.goal === goal.id ? "selected" : ""} key={goal.id} onClick={() => setPreferences((current) => ({ ...current, goal: goal.id, goalExplicit: true }))}>
                        <span>{goal.label}</span><small>{goal.detail}</small>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {quizStep === 1 && (
                <fieldset className="finder-question">
                  <legend>Which experiences are relevant?</legend>
                  <p>Choose any that apply. This is a search signal, not a legal conclusion.</p>
                  <div className="finder-option-grid">
                    {FINDER_EXPERIENCES.map((experience) => (
                      <button type="button" aria-pressed={preferences.experiences.includes(experience.id)} className={preferences.experiences.includes(experience.id) ? "selected" : ""} key={experience.id} onClick={() => toggleExperience(experience.id)}>
                        <span>{experience.label}</span><small>{experience.detail}</small>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {quizStep === 2 && (
                <fieldset className="finder-question">
                  <legend>Which companies, products, or employers?</legend>
                  <p>Optional. Separate several names with commas. A rough year can help if it appears in the source summary.</p>
                  <label className="finder-text-answer">
                    <span>Brands or keywords</span>
                    <input value={preferences.keywords} onChange={(event) => setPreferences((current) => ({ ...current, keywords: event.target.value }))} maxLength={160} placeholder="Google, Comcast, hospital portal, 2024" autoComplete="off" spellCheck={false} />
                  </label>
                </fieldset>
              )}

              {quizStep === 3 && (
                <fieldset className="finder-question">
                  <legend>Where did it happen?</legend>
                  <p>Optional. A state can improve ranking when a source explicitly limits geography.</p>
                  <label className="finder-text-answer">
                    <span>State</span>
                    <input value={preferences.location} onChange={(event) => setPreferences((current) => ({ ...current, location: event.target.value }))} maxLength={30} placeholder="New York or NY" autoComplete="off" spellCheck={false} />
                  </label>
                </fieldset>
              )}

              {quizStep === 4 && (
                <fieldset className="finder-question">
                  <legend>What information might you have?</legend>
                  <p>Source summaries can be incomplete. Always confirm requirements on the official site.</p>
                  <div className="finder-option-list">
                    {PROOF_OPTIONS.map((option) => (
                      <button type="button" aria-pressed={preferences.proof === option.value} className={preferences.proof === option.value ? "selected" : ""} key={option.value} onClick={() => setPreferences((current) => ({ ...current, proof: option.value }))}>
                        <span>{option.label}</span><small>{option.detail}</small>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="finder-quiz-actions">
                <button type="button" className="finder-back" disabled={quizStep === 0} onClick={() => setQuizStep((current) => Math.max(0, current - 1))}><ChevronLeft size={15} /> Back</button>
                {quizStep < 4 ? (
                  <button type="button" className="finder-next" onClick={() => { if (quizStep === 0) setPreferences((current) => ({ ...current, goalExplicit: true })); setQuizStep((current) => Math.min(4, current + 1)); }}>Next question <ArrowRight size={15} /></button>
                ) : (
                  <button type="button" className="finder-next" onClick={finishQuiz}>Show possible matches <Sparkles size={15} /></button>
                )}
              </div>
            </div>
          )}

          <footer className="finder-footer">
            {catalogLoading ? <span className="finder-loading-dot" /> : <ShieldCheck size={13} />}
            <span>{catalogLoading ? "Federal docket records are still loading; suggestions will expand." : `Searching ${cases.length.toLocaleString()} current catalog records.`} Administrators and courts decide eligibility.</span>
          </footer>
        </section>
      )}
    </>
  );
}
