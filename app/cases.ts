export type CaseCategory =
  | "Privacy"
  | "Data breach"
  | "Consumer"
  | "Employment"
  | "Healthcare";

export type ClaimCase = {
  id: string;
  company: string;
  monogram: string;
  title: string;
  category: CaseCategory;
  jurisdiction: string;
  geography: "Nationwide" | "State-specific";
  caseNumber: string;
  court: string;
  filedLabel: string;
  filedDate?: string;
  deadline: string;
  deadlineLabel: string;
  status: "Claims open" | "Automatic benefit";
  phase: string;
  fund: string;
  benefit: string;
  benefitRank: number;
  proof: "No documents stated" | "Notice or ID" | "Records may be requested";
  effortMinutes: number;
  eligibility: string;
  classPeriod: string;
  sourceUrl: string;
  claimUrl: string;
  administrator: string;
  verifiedLabel: string;
  verifiedAt: string;
  sourceNote?: string;
  accent: "cobalt" | "coral" | "mint" | "violet" | "amber";
  checklist: string[];
  timeline: {
    label: string;
    date: string;
    state: "done" | "current" | "future";
  }[];
};

export const catalogCheckedAt = "August 8, 2026 at 10:40 AM ET";

export const cases: ClaimCase[] = [
  {
    id: "costco-email",
    company: "Costco",
    monogram: "CO",
    title: "Washington commercial email settlement",
    category: "Consumer",
    jurisdiction: "Washington",
    geography: "State-specific",
    caseNumber: "Aaland v. Costco Wholesale Corp.",
    court: "Washington state court",
    filedLabel: "Filing date under source review",
    deadline: "2026-08-24T23:59:00-07:00",
    deadlineLabel: "Aug 24, 2026",
    status: "Claims open",
    phase: "Final approval pending",
    fund: "$14M settlement fund",
    benefit: "Pro rata cash payment; final amount varies",
    benefitRank: 74,
    proof: "Records may be requested",
    effortMinutes: 6,
    eligibility:
      "You may fit if you lived in Washington and received a qualifying Costco commercial email between June 2, 2021 and July 7, 2026.",
    classPeriod: "Jun 2, 2021 – Jul 7, 2026",
    sourceUrl: "https://www.washingtoncommercialemailsettlement.com/",
    claimUrl: "https://www.washingtoncommercialemailsettlement.com/",
    administrator: "Verita",
    verifiedLabel: "Verified today",
    verifiedAt: "2026-08-08T10:32:00-04:00",
    accent: "coral",
    checklist: [
      "Washington residency during the email period",
      "Email address that may appear in Costco records",
      "Review the release before submitting",
    ],
    timeline: [
      { label: "Settlement proposed", date: "Jul 2026", state: "done" },
      { label: "Claims window", date: "Open now", state: "current" },
      { label: "Claim deadline", date: "Aug 24, 2026", state: "future" },
      { label: "Final approval hearing", date: "Oct 2, 2026", state: "future" },
    ],
  },
  {
    id: "google-assistant",
    company: "Google",
    monogram: "GO",
    title: "Google Assistant privacy litigation",
    category: "Privacy",
    jurisdiction: "Federal · California",
    geography: "Nationwide",
    caseNumber: "5:19-cv-04286-BLF",
    court: "U.S. District Court, N.D. California",
    filedLabel: "Filed Jul 25, 2019",
    filedDate: "2019-07-25",
    deadline: "2026-08-27T23:59:00-07:00",
    deadlineLabel: "Aug 27, 2026",
    status: "Claims open",
    phase: "Settlement review",
    fund: "$68M settlement fund",
    benefit: "Pro rata payment; subclass rules apply",
    benefitRank: 78,
    proof: "Records may be requested",
    effortMinutes: 9,
    eligibility:
      "You may fit if you bought certain Google-made Assistant devices or were a U.S. user or household member whose communications were captured by a false activation during the class period.",
    classPeriod: "May 18, 2016 – Mar 19, 2026",
    sourceUrl: "https://www.googleassistantprivacylitigation.com/faq",
    claimUrl: "https://googleassistantprivacylitigation.com/file",
    administrator: "Angeion Group",
    verifiedLabel: "Verified today",
    verifiedAt: "2026-08-08T10:28:00-04:00",
    accent: "cobalt",
    checklist: [
      "Choose the purchaser or privacy subclass that may apply",
      "Google account, device, or household details may be needed",
      "Confirm whether you previously excluded yourself",
    ],
    timeline: [
      { label: "First action filed", date: "Jul 25, 2019", state: "done" },
      { label: "Settlement proposed", date: "Jan 2026", state: "done" },
      { label: "Claims window", date: "Open now", state: "current" },
      { label: "Claim deadline", date: "Aug 27, 2026", state: "future" },
    ],
  },
  {
    id: "banner-health",
    company: "Banner Health",
    monogram: "BH",
    title: "Patient portal tracking settlement",
    category: "Healthcare",
    jurisdiction: "Colorado",
    geography: "Nationwide",
    caseNumber: "2026CV30182",
    court: "District Court, Weld County, Colorado",
    filedLabel: "Filed Feb 11, 2026",
    filedDate: "2026-02-11",
    deadline: "2026-09-05T23:59:00-06:00",
    deadlineLabel: "Sep 5, 2026",
    status: "Claims open",
    phase: "Preliminary approval",
    fund: "Court-approved benefits",
    benefit: "$20 cash + 1 year of privacy service",
    benefitRank: 58,
    proof: "No documents stated",
    effortMinutes: 5,
    eligibility:
      "You may fit if you had a Banner Health Patient Account and logged in through a covered Banner web property or app during the class period.",
    classPeriod: "Jun 1, 2020 – Nov 22, 2023",
    sourceUrl: "https://www.bannerhealthdatasettlement.com/",
    claimUrl: "https://www.bannerhealthdatasettlement.com/",
    administrator: "Kroll Settlement Administration",
    verifiedLabel: "Verified today",
    verifiedAt: "2026-08-08T10:20:00-04:00",
    accent: "mint",
    checklist: [
      "Banner Health Patient Account during the class period",
      "Login through a covered Banner website or application",
      "Current contact and payment information",
    ],
    timeline: [
      { label: "Complaint filed", date: "Feb 11, 2026", state: "done" },
      { label: "Preliminary approval", date: "May 5, 2026", state: "done" },
      { label: "Claims window", date: "Open now", state: "current" },
      { label: "Claim deadline", date: "Sep 5, 2026", state: "future" },
    ],
  },
  {
    id: "comcast-breach",
    company: "Comcast",
    monogram: "XC",
    title: "2023 customer data breach settlement",
    category: "Data breach",
    jurisdiction: "Federal · Pennsylvania",
    geography: "Nationwide",
    caseNumber: "2:23-cv-05039-JMY",
    court: "U.S. District Court, E.D. Pennsylvania",
    filedLabel: "Filed Dec 19, 2023",
    filedDate: "2023-12-19",
    deadline: "2026-09-14T23:59:00-04:00",
    deadlineLabel: "Sep 14, 2026",
    status: "Claims open",
    phase: "Final approval review",
    fund: "$117.5M settlement fund",
    benefit: "Alternative cash or documented losses/lost time",
    benefitRank: 96,
    proof: "Notice or ID",
    effortMinutes: 11,
    eligibility:
      "You may fit if Comcast sent you notice that your personal information may have been compromised in its October 2023 data breach.",
    classPeriod: "October 2023 incident",
    sourceUrl: "https://www.comcastbreachsettlement.com/",
    claimUrl: "https://www.comcastbreachsettlement.com/",
    administrator: "Kroll Settlement Administration",
    verifiedLabel: "Deadline re-verified",
    verifiedAt: "2026-08-08T10:14:00-04:00",
    sourceNote: "Official site now shows Sep 14 after a deadline extension.",
    accent: "violet",
    checklist: [
      "Comcast breach notice or class member ID",
      "Choose alternative cash or document losses and time",
      "Receipts or a self-certified explanation for some benefits",
    ],
    timeline: [
      { label: "Complaint filed", date: "Dec 19, 2023", state: "done" },
      { label: "Preliminary approval", date: "Dec 2025", state: "done" },
      { label: "Final approval hearing", date: "Aug 5, 2026", state: "current" },
      { label: "Extended claim deadline", date: "Sep 14, 2026", state: "future" },
    ],
  },
  {
    id: "refresco-jobs",
    company: "Refresco",
    monogram: "RF",
    title: "Washington job-posting pay transparency settlement",
    category: "Employment",
    jurisdiction: "Washington",
    geography: "State-specific",
    caseNumber: "Remington v. Refresco Beverages US Inc.",
    court: "Washington state court",
    filedLabel: "Filing date under source review",
    deadline: "2026-09-14T23:59:00-07:00",
    deadlineLabel: "Sep 14, 2026",
    status: "Claims open",
    phase: "Final approval pending",
    fund: "Equal-share settlement fund",
    benefit: "Estimated amount appears on mailed claim form",
    benefitRank: 48,
    proof: "Notice or ID",
    effortMinutes: 5,
    eligibility:
      "You may fit if you applied for a Washington job with Refresco during the class period and the posting omitted required pay or benefit details.",
    classPeriod: "Jan 1, 2023 – Jun 5, 2026",
    sourceUrl: "https://refrescosettlement.com/faq/",
    claimUrl: "https://refrescosettlement.com/faq/",
    administrator: "Simpluris",
    verifiedLabel: "Verified Aug 8",
    verifiedAt: "2026-08-08T10:08:00-04:00",
    accent: "amber",
    checklist: [
      "Applied to a covered Washington job posting",
      "Claim form or notice from the administrator",
      "Confirm your mailing address for a check",
    ],
    timeline: [
      { label: "Class period ended", date: "Jun 5, 2026", state: "done" },
      { label: "Claims window", date: "Open now", state: "current" },
      { label: "Claim deadline", date: "Sep 14, 2026", state: "future" },
      { label: "Final approval hearing", date: "Oct 23, 2026", state: "future" },
    ],
  },
  {
    id: "accc-breach",
    company: "ACCC",
    monogram: "AC",
    title: "American Consumer Credit Counseling data incident",
    category: "Data breach",
    jurisdiction: "Massachusetts",
    geography: "Nationwide",
    caseNumber: "2581CV02933",
    court: "Superior Court, Middlesex County, Massachusetts",
    filedLabel: "Filed 2025 · exact date under review",
    deadline: "2026-09-16T23:59:00-04:00",
    deadlineLabel: "Sep 16, 2026",
    status: "Claims open",
    phase: "Proposed settlement",
    fund: "Cash and monitoring benefits",
    benefit: "Benefit depends on claim type and documentation",
    benefitRank: 52,
    proof: "Notice or ID",
    effortMinutes: 10,
    eligibility:
      "You may fit if you received notice that your private information may have been affected by ACCC's January 2025 data incident.",
    classPeriod: "January 2025 incident",
    sourceUrl: "https://www.acccsettlement.com/",
    claimUrl: "https://www.acccsettlement.com/form/claim",
    administrator: "Simpluris",
    verifiedLabel: "Verified Aug 8",
    verifiedAt: "2026-08-08T09:58:00-04:00",
    accent: "cobalt",
    checklist: [
      "Notice that your data may have been affected",
      "Class member ID from the notice, if provided",
      "Documents for any claimed losses, if applicable",
    ],
    timeline: [
      { label: "Data incident", date: "Jan 2025", state: "done" },
      { label: "Settlement proposed", date: "2026", state: "done" },
      { label: "Claims window", date: "Open now", state: "current" },
      { label: "Claim deadline", date: "Sep 16, 2026", state: "future" },
    ],
  },
  {
    id: "abc-legal",
    company: "ABC Legal",
    monogram: "AB",
    title: "Legal-services data incident settlement",
    category: "Data breach",
    jurisdiction: "Federal · Washington",
    geography: "Nationwide",
    caseNumber: "2:24-cv-02092",
    court: "U.S. District Court, W.D. Washington",
    filedLabel: "Filed 2024 · exact date under review",
    deadline: "2026-09-28T23:59:00-07:00",
    deadlineLabel: "Sep 28, 2026",
    status: "Claims open",
    phase: "Preliminary approval",
    fund: "$2.5M settlement fund",
    benefit: "Benefits vary by claim and supporting records",
    benefitRank: 56,
    proof: "Records may be requested",
    effortMinutes: 10,
    eligibility:
      "You may fit if you are a U.S. resident whose personal information was potentially compromised in ABC Legal's August 2024 incident.",
    classPeriod: "Incident began around Aug 7, 2024",
    sourceUrl: "https://www.abcdatasettlement.com/",
    claimUrl: "https://www.abcdatasettlement.com/",
    administrator: "P&N Class Action",
    verifiedLabel: "Verified Aug 8",
    verifiedAt: "2026-08-08T09:52:00-04:00",
    accent: "mint",
    checklist: [
      "U.S. residency",
      "Notice or other indication your information was affected",
      "Records for documented losses, if claimed",
    ],
    timeline: [
      { label: "Data incident", date: "Aug 7, 2024", state: "done" },
      { label: "Preliminary approval", date: "2026", state: "done" },
      { label: "Claims window", date: "Open now", state: "current" },
      { label: "Claim deadline", date: "Sep 28, 2026", state: "future" },
    ],
  },
  {
    id: "lifestance-pixel",
    company: "LifeStance",
    monogram: "LS",
    title: "Website tracking-pixel privacy settlement",
    category: "Healthcare",
    jurisdiction: "Federal · Arizona",
    geography: "Nationwide",
    caseNumber: "2:23-cv-00682-PHX-KML",
    court: "U.S. District Court, District of Arizona",
    filedLabel: "Filed Apr 2023",
    filedDate: "2023-04-01",
    deadline: "2026-09-29T23:59:00-07:00",
    deadlineLabel: "Sep 29, 2026",
    status: "Claims open",
    phase: "Preliminary approval",
    fund: "Two subclass settlement funds",
    benefit: "Pro rata cash payment; subclass rules apply",
    benefitRank: 64,
    proof: "Records may be requested",
    effortMinutes: 8,
    eligibility:
      "You may fit if you used LifeStance's public website or online booking tools during a covered period and meet one of the settlement subclass definitions.",
    classPeriod: "Subclass periods vary",
    sourceUrl: "https://www.lifestancepixelsettlement.com/",
    claimUrl: "https://www.lifestancepixelsettlement.com/",
    administrator: "Angeion Group",
    verifiedLabel: "Verified Aug 8",
    verifiedAt: "2026-08-08T09:44:00-04:00",
    accent: "violet",
    checklist: [
      "Determine which settlement subclass may apply",
      "LifeStance website or booking-tool use during the covered period",
      "Review the subclass-specific release and claim form",
    ],
    timeline: [
      { label: "Complaint filed", date: "Apr 2023", state: "done" },
      { label: "Preliminary approval", date: "May 12, 2026", state: "done" },
      { label: "Claims window", date: "Open now", state: "current" },
      { label: "Claim deadline", date: "Sep 29, 2026", state: "future" },
      { label: "Final approval hearing", date: "Oct 16, 2026", state: "future" },
    ],
  },
  {
    id: "eisner-data",
    company: "EisnerAmper",
    monogram: "EA",
    title: "Advisory group data breach litigation",
    category: "Data breach",
    jurisdiction: "Federal",
    geography: "Nationwide",
    caseNumber: "In re Eisner Advisory Group Data Breach Litigation",
    court: "U.S. federal court",
    filedLabel: "Filing date under source review",
    deadline: "2026-10-08T23:59:00-04:00",
    deadlineLabel: "Oct 8, 2026",
    status: "Claims open",
    phase: "Final approval pending",
    fund: "Settlement benefits",
    benefit: "Benefits vary by loss and documentation",
    benefitRank: 50,
    proof: "Records may be requested",
    effortMinutes: 12,
    eligibility:
      "You may fit if you were affected by the September 2023 Eisner data incident, including if you received a notice letter.",
    classPeriod: "Sep 4–9, 2023 incident",
    sourceUrl: "https://eisnerdatasettlement.com/",
    claimUrl: "https://eisnerdatasettlement.com/",
    administrator: "Verita",
    verifiedLabel: "Verified Aug 8",
    verifiedAt: "2026-08-08T09:38:00-04:00",
    accent: "amber",
    checklist: [
      "Affected by the September 2023 data incident",
      "Notice letter, if received",
      "Documents for claimed losses, if applicable",
    ],
    timeline: [
      { label: "Data incident", date: "Sep 2023", state: "done" },
      { label: "Settlement proposed", date: "2026", state: "done" },
      { label: "Claims window", date: "Open now", state: "current" },
      { label: "Claim deadline", date: "Oct 8, 2026", state: "future" },
      { label: "Final approval hearing", date: "Oct 12, 2026", state: "future" },
    ],
  },
];
