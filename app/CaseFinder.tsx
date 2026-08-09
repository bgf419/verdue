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
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import {
  EMPTY_FINDER_PREFERENCES,
  EMPTY_SCREENER_ANSWERS,
  FINDER_SITUATIONS,
  FINDER_SUGGESTIONS,
  candidateCasesForScreener,
  isReviewedOpenClaim,
  mergeFinderPreferences,
  parseFinderMessage,
  rankCatalogCases,
  reviewedCandidatesForSituations,
  screenReviewedClaims,
  sensitiveFinderInputReason,
  type FinderMatch,
  type FinderPreferences,
  type FinderScreenerAnswer,
  type FinderScreenerAnswers,
} from "./case-finder";
import type { CatalogCase, CatalogKind } from "./catalog";
import type { FinderSituation } from "./cases";

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
  text: "Tell me what happened in everyday words—or choose the Quick quiz. You do not need to know a lawsuit or company name.",
};

const SCREENER_ANSWERS: Array<{
  value: FinderScreenerAnswer;
  label: string;
  detail: string;
}> = [
  {
    value: "yes",
    label: "Yes, all of that sounds true",
    detail: "Keep this listing for review.",
  },
  {
    value: "unsure",
    label: "Maybe / I’m not sure",
    detail: "Keep it as a weaker lead and show what needs confirmation.",
  },
  {
    value: "no",
    label: "No, at least one part is not true",
    detail: "Remove this listing from the quiz results.",
  },
];

function freshScreenerAnswers(): FinderScreenerAnswers {
  return {
    situations: [...EMPTY_SCREENER_ANSWERS.situations],
    recognizedCaseIds: [...EMPTY_SCREENER_ANSWERS.recognizedCaseIds],
    candidateAnswers: {},
  };
}

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
      return "Add what happened, a company or product if you remember it, a state, or a rough year so I do not make an arbitrary suggestion.";
    }
    if (preferences.goal === "open_claims") {
      return "No listed open claim matched those catalog signals. That does not mean you are ineligible—Verdue’s reviewed coverage is incomplete. Try another event, company, state, or year.";
    }
    return "No related record matched those catalog signals. That does not prove none exists—Verdue’s agency and court coverage is partial. Try a specific company or case name.";
  }
  return `I found ${matches.length} catalog ${matches.length === 1 ? "record" : "records"} worth checking. These are possible leads—not eligibility decisions.`;
}

function quizSummary(matches: FinderMatch[]) {
  if (matches.length === 0) {
    return "No reviewed listing survived those checks. That does not mean you are ineligible or that no case exists—Verdue’s reviewed open-claim coverage is incomplete.";
  }
  return `The quiz found ${matches.length} possible ${matches.length === 1 ? "listing" : "listings"} to review. This is not an eligibility decision.`;
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
        <button type="button" onClick={() => onReview(match.item)}>Review listing details <ArrowRight size={14} /></button>
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
  const [screener, setScreener] = useState<FinderScreenerAnswers>(freshScreenerAnswers);
  const [quizStep, setQuizStep] = useState(0);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [namesAnswered, setNamesAnswered] = useState(false);
  const [quizResultActive, setQuizResultActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const questionLegendRef = useRef<HTMLLegendElement>(null);
  const resultSummaryRef = useRef<HTMLDivElement>(null);
  const focusQuizResultRef = useRef(false);

  const recognitionCandidates = reviewedCandidatesForSituations(cases, screener.situations);
  const quizCandidates = candidateCasesForScreener(cases, screener);
  const currentCandidate = quizCandidates[candidateIndex];
  const reviewedClaimCount = cases.filter((item) => isReviewedOpenClaim(item)).length;
  const quizTotalSteps = 2 + Math.max(1, quizCandidates.length);
  const quizProgressStep = quizStep < 2 ? quizStep + 1 : 3 + candidateIndex;

  const closeFinder = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => launcherRef.current?.focus());
  };

  useEffect(() => {
    if (!open || mode !== "chat") return;
    if (focusQuizResultRef.current) {
      focusQuizResultRef.current = false;
      requestAnimationFrame(() => resultSummaryRef.current?.focus());
      return;
    }
    inputRef.current?.focus();
  }, [mode, open]);

  useEffect(() => {
    if (!open || mode !== "quiz") return;
    requestAnimationFrame(() => questionLegendRef.current?.focus());
  }, [candidateIndex, mode, open, quizStep]);

  useEffect(() => {
    if (!open || mode !== "chat" || quizResultActive) return;
    requestAnimationFrame(() => chatEndRef.current?.scrollIntoView({ block: "end" }));
  }, [matches, messages, mode, open, quizResultActive]);

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
    setQuizResultActive(false);
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
    setQuizResultActive(false);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `I cleared that entry because it looked like it contained a ${reason}. Search with only what happened, a company or product, a state, and a rough year.`,
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
    setScreener(freshScreenerAnswers());
    setQuizStep(0);
    setCandidateIndex(0);
    setNamesAnswered(false);
    setQuizResultActive(false);
    setMode("chat");
  };

  const openQuiz = () => {
    if (quizResultActive) {
      setScreener(freshScreenerAnswers());
      setQuizStep(0);
      setCandidateIndex(0);
      setNamesAnswered(false);
      setMatches([]);
      setQuizResultActive(false);
    }
    setMode("quiz");
  };

  const handleModeTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextMode = event.key === "Home"
      ? "chat"
      : event.key === "End"
        ? "quiz"
        : mode === "chat"
          ? "quiz"
          : "chat";
    if (nextMode === "quiz") {
      openQuiz();
    } else {
      focusQuizResultRef.current = false;
      setMode("chat");
    }
    requestAnimationFrame(() => document.getElementById(`finder-${nextMode}-tab`)?.focus());
  };

  const toggleSituation = (situation: FinderSituation) => {
    setScreener((current) => {
      const situations = situation === "not_sure"
        ? ["not_sure" as const]
        : current.situations.includes(situation)
          ? current.situations.filter((item) => item !== situation)
          : [...current.situations.filter((item) => item !== "not_sure"), situation];
      return { situations, recognizedCaseIds: [], candidateAnswers: {} };
    });
    setNamesAnswered(false);
    setCandidateIndex(0);
  };

  const toggleRecognizedCase = (caseId: string) => {
    setScreener((current) => ({
      ...current,
      recognizedCaseIds: current.recognizedCaseIds.includes(caseId)
        ? current.recognizedCaseIds.filter((id) => id !== caseId)
        : [...current.recognizedCaseIds, caseId],
      candidateAnswers: {},
    }));
    setNamesAnswered(true);
    setCandidateIndex(0);
  };

  const clearRecognizedCases = () => {
    setScreener((current) => ({ ...current, recognizedCaseIds: [], candidateAnswers: {} }));
    setNamesAnswered(true);
    setCandidateIndex(0);
  };

  const answerCandidate = (answer: FinderScreenerAnswer) => {
    if (!currentCandidate) return;
    setScreener((current) => ({
      ...current,
      candidateAnswers: { ...current.candidateAnswers, [currentCandidate.id]: answer },
    }));
  };

  const finishQuiz = () => {
    const nextMatches = screenReviewedClaims(cases, screener);
    setMatches(nextMatches);
    setQuizResultActive(true);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `${quizSummary(nextMatches)} I used only the answers from this browser-tab quiz.`,
      },
    ]);
    focusQuizResultRef.current = true;
    setMode("chat");
  };

  const goBackInQuiz = () => {
    if (quizStep === 2 && candidateIndex > 0) {
      setCandidateIndex((current) => current - 1);
      return;
    }
    if (quizStep > 0) setQuizStep((current) => current - 1);
  };

  const goForwardInQuiz = () => {
    if (quizStep < 2) {
      if (quizStep === 1 && quizCandidates.length === 0) {
        finishQuiz();
        return;
      }
      setQuizStep((current) => current + 1);
      if (quizStep === 1) setCandidateIndex(0);
      return;
    }
    if (candidateIndex < quizCandidates.length - 1) {
      setCandidateIndex((current) => current + 1);
      return;
    }
    finishQuiz();
  };

  const reviewMatch = (item: CatalogCase) => {
    onReviewCase(item);
    closeFinder(false);
  };

  const openClaimMatches = matches.filter((match) => match.item.kind === "settlement_claims_open");
  const relatedSourceMatches = matches.filter((match) => match.item.kind !== "settlement_claims_open");
  const currentCandidateAnswer = currentCandidate
    ? screener.candidateAnswers[currentCandidate.id]
    : undefined;
  const nextDisabled = quizStep === 0
    ? screener.situations.length === 0
    : quizStep === 1
      ? !namesAnswered
      : !currentCandidate || !currentCandidateAnswer;
  const nextLabel = quizStep === 0
    ? "Show familiar names"
    : quizStep === 1
      ? quizCandidates.length === 0
        ? "Show coverage message"
        : `Check ${quizCandidates.length} ${quizCandidates.length === 1 ? "possibility" : "possibilities"}`
      : candidateIndex < quizCandidates.length - 1
        ? "Next possibility"
        : "Show possible listings";

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
        <strong>Find relevant cases</strong>
        <small>Guided quiz + catalog search</small>
      </button>

      {open && (
        <section
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
            <span>Answers stay in this browser tab and are not sent to a model or saved after refresh. Do not enter your name, account or claim IDs, diagnoses, exact address, Social Security number, or payment details.</span>
          </div>

          <div className="finder-mode-tabs" role="tablist" aria-label="Case finder mode">
            <button id="finder-chat-tab" type="button" role="tab" tabIndex={mode === "chat" ? 0 : -1} aria-controls="finder-chat-panel" aria-selected={mode === "chat"} className={mode === "chat" ? "active" : ""} onKeyDown={handleModeTabKeyDown} onClick={() => { focusQuizResultRef.current = false; setMode("chat"); }}><MessageCircle size={15} /> Ask the finder</button>
            <button id="finder-quiz-tab" type="button" role="tab" tabIndex={mode === "quiz" ? 0 : -1} aria-controls="finder-quiz-panel" aria-selected={mode === "quiz"} className={mode === "quiz" ? "active" : ""} onKeyDown={handleModeTabKeyDown} onClick={openQuiz}><Check size={15} /> Quick quiz</button>
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

                {quizResultActive && (
                  <div className="finder-quiz-result-summary" ref={resultSummaryRef} tabIndex={-1}>
                    <div role="status">
                      <strong>Quiz complete</strong>
                      <span>{quizSummary(matches)}</span>
                    </div>
                    <button type="button" onClick={openQuiz}><RotateCcw size={14} /> Retake quiz</button>
                  </div>
                )}

                <div className="finder-result-status" role="status">
                  {matches.length > 0 ? `${matches.length} possible catalog ${matches.length === 1 ? "record" : "records"} shown.` : ""}
                </div>

                {matches.length > 0 && (
                  <div className="finder-results" aria-label="Suggested catalog records">
                    {openClaimMatches.length > 0 && (
                      <div className="finder-result-group">
                        <h2>Possible listings to review</h2>
                        <p>Some answers overlap with these reviewed listings. The official administrator still decides eligibility.</p>
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
                  placeholder="Example: I received a breach notice"
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
              {quizStep === 0 && (
                <div className="finder-quiz-intro">
                  <strong>No lawsuit knowledge needed.</strong>
                  <span>Think about things you used, websites you visited, job applications, and privacy notices. This quiz checks only {reviewedClaimCount} hand-reviewed open claim windows.</span>
                </div>
              )}

              <div className="finder-quiz-progress">
                <span>Step {quizProgressStep} of {quizTotalSteps}</span>
                <div role="progressbar" aria-label="Quiz progress" aria-valuemin={1} aria-valuemax={quizTotalSteps} aria-valuenow={quizProgressStep}><i style={{ width: `${(quizProgressStep / quizTotalSteps) * 100}%` }} /></div>
              </div>

              {quizStep === 0 && (
                <fieldset className="finder-question">
                  <legend ref={questionLegendRef} tabIndex={-1}>Since 2016, has anything like this happened to you?</legend>
                  <p>Select every situation that sounds familiar. You do not need to know whether it was connected to a lawsuit.</p>
                  <div className="finder-option-list">
                    {FINDER_SITUATIONS.map((situation) => (
                      <button type="button" aria-pressed={screener.situations.includes(situation.id)} className={screener.situations.includes(situation.id) ? "selected" : ""} key={situation.id} onClick={() => toggleSituation(situation.id)}>
                        <span>{situation.label}</span><small>{situation.detail}</small>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {quizStep === 1 && (
                <fieldset className="finder-question">
                  <legend ref={questionLegendRef} tabIndex={-1}>Which of these names or services sound familiar?</legend>
                  <p>We are supplying names to jog your memory. Select every one you recognize from the situation—there is nothing to type.</p>
                  <div className="finder-option-list">
                    {recognitionCandidates.map((item) => (
                      <button type="button" aria-pressed={screener.recognizedCaseIds.includes(item.id)} className={screener.recognizedCaseIds.includes(item.id) ? "selected" : ""} key={item.id} onClick={() => toggleRecognizedCase(item.id)}>
                        <span>{item.finderCriteria?.recognitionLabel}</span><small>{item.finderCriteria?.recognitionDetail}</small>
                      </button>
                    ))}
                    <button type="button" aria-pressed={namesAnswered && screener.recognizedCaseIds.length === 0} className={namesAnswered && screener.recognizedCaseIds.length === 0 ? "selected" : ""} onClick={clearRecognizedCases}>
                      <span>None of these / I do not remember</span><small>The next step will still describe each possible situation.</small>
                    </button>
                  </div>
                  {recognitionCandidates.length === 0 && (
                    <div className="finder-empty-quiz" role="status">There are no currently reviewed open claim windows for that situation. Continue for a bounded coverage message or go back and choose another situation.</div>
                  )}
                </fieldset>
              )}

              {quizStep === 2 && currentCandidate && (
                <fieldset className="finder-question finder-candidate-question">
                  <legend ref={questionLegendRef} tabIndex={-1}>Does this sound like your experience?</legend>
                  <p>Check {candidateIndex + 1} of {quizCandidates.length}. Answer from memory; never paste a notice or identifier.</p>
                  <article className="finder-candidate-check">
                    <span>{currentCandidate.finderCriteria?.recognitionLabel}</span>
                    <h2>Do all of these sound true?</h2>
                    <ul>
                      {currentCandidate.finderCriteria?.essentialFacts.map((fact) => <li key={fact}>{fact}</li>)}
                    </ul>
                  </article>
                  <div className="finder-option-list finder-answer-list" role="group" aria-label={`Answer for ${currentCandidate.company}`}>
                    {SCREENER_ANSWERS.map((answer) => (
                      <button type="button" aria-pressed={currentCandidateAnswer === answer.value} className={currentCandidateAnswer === answer.value ? "selected" : ""} key={answer.value} onClick={() => answerCandidate(answer.value)}>
                        <span>{answer.label}</span><small>{answer.detail}</small>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="finder-quiz-actions">
                <button type="button" className="finder-back" disabled={quizStep === 0} onClick={goBackInQuiz}><ChevronLeft size={15} /> Back</button>
                <button type="button" className="finder-next" disabled={nextDisabled} onClick={goForwardInQuiz}>{nextLabel} {quizStep === 2 && candidateIndex === quizCandidates.length - 1 ? <Sparkles size={15} /> : <ArrowRight size={15} />}</button>
              </div>
            </div>
          )}

          <footer className="finder-footer">
            {mode === "quiz" ? <ShieldCheck size={13} /> : catalogLoading ? <span className="finder-loading-dot" /> : <ShieldCheck size={13} />}
            <span>{mode === "quiz" ? `Quiz scope: ${reviewedClaimCount} hand-reviewed open claim windows.` : catalogLoading ? "Federal docket records are still loading; chat suggestions will expand." : `Chat searches ${cases.length.toLocaleString()} current catalog records.`} Administrators and courts decide eligibility.</span>
          </footer>
        </section>
      )}
    </>
  );
}
