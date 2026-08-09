import type { CatalogCase, CatalogKind, ProofLevel } from "./catalog";
import type { FinderIssueType, FinderSituation } from "./cases";

export type FinderGoal = "open_claims" | "government_redress" | "watch_cases" | "explore";
export type FinderExperience = FinderIssueType;

export type FinderPreferences = {
  goal: FinderGoal;
  goalExplicit: boolean;
  experiences: FinderExperience[];
  keywords: string;
  location: string;
  proof: ProofLevel | "Any";
};

export type FinderMatch = {
  item: CatalogCase;
  score: number;
  signal:
    | "Several details line up"
    | "Some details line up"
    | "Broad catalog suggestion"
    | "Worth reviewing"
    | "Needs confirmation";
  reasons: string[];
  questionsToConfirm: string[];
};

export type FinderScreenerAnswer = "yes" | "unsure" | "no";

export type FinderScreenerAnswers = {
  situations: FinderSituation[];
  recognizedCaseIds: string[];
  candidateAnswers: Record<string, FinderScreenerAnswer>;
};

export const EMPTY_SCREENER_ANSWERS: FinderScreenerAnswers = {
  situations: [],
  recognizedCaseIds: [],
  candidateAnswers: {},
};

export const FINDER_SITUATIONS: Array<{
  id: FinderSituation;
  label: string;
  detail: string;
}> = [
  {
    id: "breach_notice",
    label: "I received a data-breach or security notice",
    detail: "A letter or email said personal information may have been exposed.",
  },
  {
    id: "healthcare_tool",
    label: "I used a patient portal or online healthcare booking",
    detail: "A hospital, patient-account, therapy, or appointment website or app.",
  },
  {
    id: "voice_assistant",
    label: "I or someone in my household used a voice assistant",
    detail: "A smart speaker or Assistant device, including an unexpected activation.",
  },
  {
    id: "washington_job",
    label: "I applied for a job located in Washington",
    detail: "Especially if the posting did not show pay or benefit information.",
  },
  {
    id: "marketing_email",
    label: "I received retail marketing emails while living in Washington",
    detail: "Promotional or commercial email from a retailer.",
  },
  {
    id: "professional_services",
    label: "I used or interacted with credit-counseling, accounting, or legal services",
    detail: "This includes providers you hired and services that contacted or served you.",
  },
  {
    id: "not_sure",
    label: "I’m not sure — show me the possibilities",
    detail: "The next step will supply names and descriptions to jog your memory.",
  },
];

const SITUATION_LABELS = Object.fromEntries(
  FINDER_SITUATIONS.map((situation) => [situation.id, situation.label]),
) as Record<FinderSituation, string>;

export const FINDER_GOALS: Array<{ id: FinderGoal; label: string; detail: string }> = [
  {
    id: "open_claims",
    label: "Claims I can review now",
    detail: "Search only the hand-reviewed settlement claim windows.",
  },
  {
    id: "government_redress",
    label: "Government refunds or redress",
    detail: "Search official agency program pages; public action may not be available.",
  },
  {
    id: "watch_cases",
    label: "Lawsuits I may want to watch",
    detail: "Search proposed federal class-action dockets; no action is implied.",
  },
  {
    id: "explore",
    label: "Search every catalog layer",
    detail: "Keep open claims separate from related agency and court records.",
  },
];

export const FINDER_EXPERIENCES: Array<{
  id: FinderExperience;
  label: string;
  detail: string;
}> = [
  { id: "consumer", label: "Product or service", detail: "Purchases, subscriptions, fees, or advertising" },
  { id: "privacy", label: "Privacy or data breach", detail: "Tracking, pixels, hacks, or exposed information" },
  { id: "communications", label: "Emails, texts, or calls", detail: "Unwanted or misleading communications" },
  { id: "employment", label: "Job or gig work", detail: "Wages, hiring, discrimination, or workplace issues" },
  { id: "healthcare", label: "Healthcare", detail: "Patient portals, providers, hospitals, or health data" },
  { id: "finance", label: "Banking or investing", detail: "Banks, credit, securities, loans, or payment apps" },
];

export const FINDER_SUGGESTIONS = [
  "Show me claims I can act on now",
  "I received a data-breach notice",
  "I used Google and Comcast",
  "Which claims say no documents are needed?",
  "Show cases connected to Washington",
];

export const EMPTY_FINDER_PREFERENCES: FinderPreferences = {
  goal: "open_claims",
  goalExplicit: false,
  experiences: [],
  keywords: "",
  location: "",
  proof: "Any",
};

const EXPERIENCE_PATTERNS: Record<FinderExperience, RegExp> = {
  consumer: /consumer|product|purchase|retail|subscription|service|fee|advertis|marketing|customer/i,
  privacy: /privacy|data breach|breach|tracking|pixel|biometric|hack|security incident|personal information/i,
  communications: /email|text message|sms|phone call|telemarket|commercial message|communication/i,
  employment: /employ|worker|workplace|wage|salary|hiring|job|labor|gig work|overtime|discrimination/i,
  healthcare: /health|medical|patient|hospital|clinic|therapy|provider|hipaa/i,
  finance: /bank|credit|debit|loan|mortgage|securit|broker|invest|payment app|financial|interest rate/i,
};

const EXPERIENCE_LABELS = Object.fromEntries(
  FINDER_EXPERIENCES.map((experience) => [experience.id, experience.label]),
) as Record<FinderExperience, string>;

const STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "district of columbia", "florida", "georgia", "hawaii", "idaho", "illinois",
  "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
  "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota",
  "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming",
];

const STATE_ABBREVIATIONS: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado",
  CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas",
  KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts",
  MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana",
  NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico",
  NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma",
  OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina",
  SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont",
  VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
};

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "case", "cases", "claim", "claims", "connected", "do",
  "find", "for", "from", "had", "have", "i", "in", "is", "me", "my", "of", "on", "or",
  "please", "relevant", "show", "that", "the", "to", "used", "want", "what", "which", "with",
]);

const GENERIC_MATCH_WORDS = new Set([
  "act", "action", "now", "received", "notice", "documents", "needed", "need", "everything",
  "government", "refund", "redress", "lawsuit", "watch", "open", "settlement", "data", "breach",
]);

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(value: string) {
  return normalize(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token) && !GENERIC_MATCH_WORDS.has(token));
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function normalizeLocation(value: string) {
  const trimmed = value.trim();
  const abbreviation = STATE_ABBREVIATIONS[trimmed.toUpperCase()];
  return abbreviation ?? normalize(trimmed);
}

function locationFromMessage(message: string) {
  const lower = message.toLowerCase();
  const fullName = STATE_NAMES.find((state) => new RegExp(`\\b${state.replaceAll(" ", "\\s+")}\\b`).test(lower));
  if (fullName) return fullName;
  const abbreviation = message.match(/\b[A-Z]{2}\b/g)?.find((value) => STATE_ABBREVIATIONS[value]);
  return abbreviation ? STATE_ABBREVIATIONS[abbreviation] : "";
}

function goalFromMessage(message: string): FinderGoal | null {
  if (/government|agency|ftc|cfpb|sec|official refund|redress/i.test(message)) return "government_redress";
  if (/watch|track|lawsuit|docket|proposed case|pending case/i.test(message)) return "watch_cases";
  if (/every catalog|everything|all source|mix of/i.test(message)) return "explore";
  if (/act on|file|claim form|open claim|deadline|submit/i.test(message)) return "open_claims";
  return null;
}

function proofFromMessage(message: string): FinderPreferences["proof"] | null {
  if (/no (?:receipt|receipts|proof|document|documents)|without (?:proof|receipts|documents)/i.test(message)) {
    return "No documents stated";
  }
  const saysNoNotice = /\b(?:no|never|did not|didn't)\s+(?:receive\w*\s+)?(?:a\s+)?notice\b/i.test(message);
  if (!saysNoNotice && /notice|claim id|notice id|confirmation/i.test(message)) return "Notice or ID";
  if (/receipt|record|invoice|statement/i.test(message)) return "Records may be requested";
  return null;
}

export function sensitiveFinderInputReason(value: string) {
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(value)) return "email address";
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value) || /social security|\bssn\b/i.test(value)) return "Social Security information";
  if (/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/.test(value)) return "phone number";
  if (/\b(?:\d[ -]*?){13,19}\b/.test(value)) return "payment-card-like number";
  if (/\b(?:claim|notice|confirmation|account|routing|tax)\s*(?:number|no\.?|id)\b/i.test(value)) return "private identifier";
  if (/\b\d{5,12}\b/.test(value)) return "private number";
  if (/\b(?:password|passcode|bank credentials?)\b/i.test(value)) return "account credential";
  if (/\b\d{1,6}\s+[a-z0-9 .'-]{2,40}\s(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr)\b/i.test(value)) return "street address";
  if (/\b(?:my diagnosis|medical record|patient id|information about my child|minor's information)\b/i.test(value)) return "sensitive personal detail";
  return null;
}

export function parseFinderMessage(message: string): Partial<FinderPreferences> {
  const experiences = (Object.entries(EXPERIENCE_PATTERNS) as Array<[FinderExperience, RegExp]>)
    .filter(([, pattern]) => pattern.test(message))
    .map(([experience]) => experience);
  const goal = goalFromMessage(message);
  const proof = proofFromMessage(message);
  const location = locationFromMessage(message);
  const keywords = unique(tokenize(message)).join(" ");

  return {
    ...(goal ? { goal, goalExplicit: true } : {}),
    ...(experiences.length ? { experiences } : {}),
    ...(keywords ? { keywords } : {}),
    ...(location ? { location } : {}),
    ...(proof ? { proof } : {}),
  };
}

export function mergeFinderPreferences(
  current: FinderPreferences,
  update: Partial<FinderPreferences>,
): FinderPreferences {
  const keywordTokens = unique([
    ...tokenize(current.keywords),
    ...tokenize(update.keywords ?? ""),
  ]);
  return {
    goal: update.goal ?? current.goal,
    goalExplicit: update.goalExplicit ?? current.goalExplicit,
    experiences: unique([...current.experiences, ...(update.experiences ?? [])]),
    keywords: keywordTokens.join(" "),
    location: update.location ? normalizeLocation(update.location) : current.location,
    proof: update.proof ?? current.proof,
  };
}

function kindReason(kind: CatalogKind) {
  if (kind === "settlement_claims_open") return "A hand-reviewed claim window is listed";
  if (kind === "government_redress") return "Found on an official government redress page";
  if (kind === "potential_class_case") return "A proposed federal class-action docket to monitor";
  return "A legal intake destination is listed";
}

function questionsFor(item: CatalogCase, preferences: FinderPreferences) {
  const questions: string[] = [];
  const criteria = item.finderCriteria;
  if (item.kind === "settlement_claims_open") {
    if (!preferences.location && criteria?.eligibleStates) {
      questions.push(`Were you in ${criteria.eligibleStates.join(" or ")} during the covered period?`);
    }
    if (!/\b(?:19|20)\d{2}\b/.test(preferences.keywords) && criteria?.coveredPeriodStart) {
      questions.push("Did this happen during the official covered dates?");
    }
    if (criteria?.noticeRequired && preferences.proof !== "Notice or ID") {
      questions.push("Did you receive the notice described by the official settlement site?");
    }
    questions.push("Does the official class definition apply to you?");
  } else if (item.kind === "government_redress") {
    questions.push("Does the agency page provide instructions for you, or is distribution automatic?");
  } else if (item.kind === "potential_class_case") {
    questions.push("Has the court later certified a class or opened any participation process?");
  }
  if (item.proof === "Requirements not stated") {
    questions.push("What records or notice does the official source require?");
  }
  return unique(questions).slice(0, 2);
}

function deadlineTime(item: CatalogCase) {
  if (!item.deadline) return Number.POSITIVE_INFINITY;
  const value = new Date(item.deadline).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function isReviewedOpenClaim(item: CatalogCase, now = Date.now()) {
  if (
    item.kind !== "settlement_claims_open" ||
    item.windowStatus !== "open" ||
    item.freshness !== "current" ||
    !item.finderCriteria
  ) {
    return false;
  }
  if (!item.deadline) return true;
  const deadline = new Date(item.deadline).getTime();
  return !Number.isFinite(deadline) || deadline >= now;
}

function allowedByGoal(item: CatalogCase, preferences: FinderPreferences) {
  if (preferences.goal === "open_claims") {
    return item.kind === "settlement_claims_open" && item.windowStatus === "open";
  }
  if (preferences.goal === "government_redress") return item.kind === "government_redress";
  if (preferences.goal === "watch_cases") return item.kind === "potential_class_case";
  return item.kind !== "legal_counsel_intake";
}

function yearsFrom(value: string) {
  return unique((value.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number));
}

function sourceOnlyKeywordMatch(item: CatalogCase, keywordTokens: string[]) {
  const identity = normalize(`${item.company} ${item.title}`);
  const genericIdentityWords = new Set([
    "action", "bank", "case", "class", "company", "complaint", "consumer", "corp", "corporation",
    "federal", "group", "inc", "lawsuit", "llc", "privacy", "service", "services", "settlement",
  ]);
  return unique(keywordTokens.filter((token) =>
    !genericIdentityWords.has(token) && identity.split(" ").includes(token),
  ));
}

export function rankCatalogCases(
  cases: CatalogCase[],
  preferences: FinderPreferences,
  limit = 3,
): FinderMatch[] {
  const keywordText = normalize(preferences.keywords);
  const keywordTokens = tokenize(preferences.keywords);
  const location = normalizeLocation(preferences.location);
  const years = yearsFrom(preferences.keywords);
  const hasSpecificSignal = Boolean(
    keywordTokens.length || preferences.experiences.length || location || preferences.proof !== "Any",
  );

  if (!hasSpecificSignal) return [];

  return cases
    .flatMap((item): FinderMatch[] => {
      if (!allowedByGoal(item, preferences)) return [];

      const relatedRecord = item.kind === "government_redress" || item.kind === "potential_class_case";
      const relatedKeywordMatches = sourceOnlyKeywordMatch(item, keywordTokens);
      if (relatedRecord && (!preferences.goalExplicit || relatedKeywordMatches.length === 0)) return [];

      let score = item.kind === "settlement_claims_open" ? 8 : 2;
      const reasons: string[] = [];
      const criteria = item.finderCriteria;

      if (relatedRecord) {
        score += 24 + Math.min(10, relatedKeywordMatches.length * 3);
        reasons.push(`Company or case name mentions ${relatedKeywordMatches.slice(0, 3).join(", ")}`);
      } else if (criteria) {
        const matchingAliases = criteria.aliases.filter((alias) => {
          const normalizedAlias = normalize(alias);
          return keywordText.includes(normalizedAlias) ||
            (normalizedAlias.split(" ").length === 1 && keywordTokens.includes(normalizedAlias));
        });
        if (matchingAliases.length) {
          score += 30;
          reasons.push(`Company or product matches ${matchingAliases[0]}`);
        }

        const matchedExperiences = preferences.experiences.filter((experience) =>
          criteria.issueTypes.includes(experience),
        );
        if (matchedExperiences.length) {
          score += matchedExperiences.length * 8;
          reasons.push(
            `Connected to ${matchedExperiences.slice(0, 2).map((value) => EXPERIENCE_LABELS[value].toLowerCase()).join(" and ")}`,
          );
        }

        if (location && criteria.eligibleStates) {
          if (!criteria.eligibleStates.includes(location)) return [];
          score += 12;
          reasons.push(`The reviewed class definition includes ${location}`);
        }

        if (years.length && criteria.coveredPeriodStart && criteria.coveredPeriodEnd) {
          const startYear = Number(criteria.coveredPeriodStart.slice(0, 4));
          const endYear = Number(criteria.coveredPeriodEnd.slice(0, 4));
          if (years.every((year) => year < startYear || year > endYear)) return [];
          score += 8;
          reasons.push("The year overlaps the reviewed covered period");
        }

        if (preferences.proof !== "Any") {
          if (item.proof === preferences.proof) {
            score += 7;
            reasons.push(`Source summary says: ${item.proof.toLowerCase()}`);
          } else if (preferences.proof === "Notice or ID" && criteria.noticeRequired) {
            score += 7;
            reasons.push("The reviewed class definition mentions a notice");
          } else if (preferences.proof === "No documents stated") {
            score -= 5;
          }
        }
      }

      if (reasons.length === 0) return [];
      reasons.unshift(kindReason(item.kind));
      if (item.freshness === "stale") score -= 20;

      return [{
        item,
        score,
        signal:
          score >= 34
            ? "Several details line up"
            : score >= 17
              ? "Some details line up"
              : "Broad catalog suggestion",
        reasons: unique(reasons).slice(0, 5),
        questionsToConfirm: questionsFor(item, preferences),
      }];
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const kindOrder: Record<CatalogKind, number> = {
        settlement_claims_open: 0,
        government_redress: 1,
        potential_class_case: 2,
        legal_counsel_intake: 3,
      };
      if (kindOrder[a.item.kind] !== kindOrder[b.item.kind]) {
        return kindOrder[a.item.kind] - kindOrder[b.item.kind];
      }
      const deadlineDifference = deadlineTime(a.item) - deadlineTime(b.item);
      if (deadlineDifference !== 0) return deadlineDifference;
      return a.item.id.localeCompare(b.item.id);
    })
    .slice(0, Math.max(1, limit));
}

function sortReviewedCandidates(items: CatalogCase[]) {
  return [...items].sort((a, b) => {
    const deadlineDifference = deadlineTime(a) - deadlineTime(b);
    if (deadlineDifference !== 0) return deadlineDifference;
    return a.id.localeCompare(b.id);
  });
}

export function reviewedCandidatesForSituations(
  cases: CatalogCase[],
  situations: FinderSituation[],
) {
  const reviewed = cases.filter((item) => isReviewedOpenClaim(item));
  if (situations.includes("not_sure")) return sortReviewedCandidates(reviewed);
  if (situations.length === 0) return [];
  return sortReviewedCandidates(reviewed.filter((item) =>
    item.finderCriteria?.situations.some((situation) => situations.includes(situation)),
  ));
}

export function candidateCasesForScreener(
  cases: CatalogCase[],
  answers: FinderScreenerAnswers,
) {
  const prompted = reviewedCandidatesForSituations(cases, answers.situations);
  if (answers.recognizedCaseIds.length === 0) return prompted;
  return prompted.filter((item) => answers.recognizedCaseIds.includes(item.id));
}

export function screenReviewedClaims(
  cases: CatalogCase[],
  answers: FinderScreenerAnswers,
): FinderMatch[] {
  return candidateCasesForScreener(cases, answers)
    .flatMap((item): FinderMatch[] => {
      const answer = answers.candidateAnswers[item.id];
      if (!answer || answer === "no" || !item.finderCriteria) return [];

      const recognized = answers.recognizedCaseIds.includes(item.id);
      const matchingSituations = item.finderCriteria.situations.filter((situation) =>
        answers.situations.includes(situation),
      );
      const reasons = [
        recognized
          ? `You recognized ${item.finderCriteria.recognitionLabel} from the prompted list`
          : matchingSituations.length > 0
            ? `You selected: ${matchingSituations.map((situation) => SITUATION_LABELS[situation].toLowerCase()).join("; ")}`
            : "You asked to review every prompted possibility",
        answer === "yes"
          ? "You said the source-reviewed facts sound true"
          : "You marked the source-reviewed facts as not sure",
      ];

      return [{
        item,
        score: (answer === "yes" ? 100 : 50) + (recognized ? 20 : 0),
        signal: answer === "yes" ? "Worth reviewing" : "Needs confirmation",
        reasons,
        questionsToConfirm: answer === "unsure"
          ? [
              "Confirm each prompted fact against your own records and the official class definition.",
              "The official administrator—not Verdue—decides eligibility.",
            ]
          : ["Review the complete official class definition before taking any action."],
      }];
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const deadlineDifference = deadlineTime(a.item) - deadlineTime(b.item);
      if (deadlineDifference !== 0) return deadlineDifference;
      return a.item.id.localeCompare(b.item.id);
    });
}
