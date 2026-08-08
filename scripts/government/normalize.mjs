import * as cheerio from "cheerio";

import {
  canonicalizeUrl,
  cleanText,
  hash,
  slugify,
} from "../lib/catalog.mjs";

export const GOVERNMENT_SCHEMA_VERSION = 1;

export const FTC_REFUNDS_SOURCE = {
  id: "ftc_refunds",
  label: "FTC active refund programs",
  agency: "Federal Trade Commission",
  agencyCode: "FTC",
  url: "https://www.ftc.gov/enforcement/refunds",
  required: true,
  minimumRecords: 3,
};

export const CFPB_PAYMENTS_SOURCE = {
  id: "cfpb_payments_by_case",
  label: "CFPB ongoing payments to harmed consumers",
  agency: "Consumer Financial Protection Bureau",
  agencyCode: "CFPB",
  url: "https://www.consumerfinance.gov/enforcement/payments-harmed-consumers/payments-by-case/",
  required: true,
  minimumRecords: 3,
};

export const SEC_DISTRIBUTIONS_SOURCE = {
  id: "sec_distributions_harmed_investors",
  label: "SEC distributions to harmed investors",
  agency: "Securities and Exchange Commission",
  agencyCode: "SEC",
  url: "https://www.sec.gov/enforcement-litigation/distributions-harmed-investors",
  required: true,
  minimumRecords: 10,
};

function findTableByHeaders($, expectedHeaders) {
  let result = null;
  $("table").each((_index, table) => {
    if (result) return;
    const headers = $(table)
      .find("thead th")
      .map((_headerIndex, header) => cleanText($(header).text()).toLowerCase())
      .get();
    if (expectedHeaders.every((pattern) => headers.some((header) => pattern.test(header)))) {
      result = table;
    }
  });
  return result;
}

function tableRows($, table, minimumRecords, sourceLabel) {
  if (!table) throw new Error(`Could not locate the ${sourceLabel} table`);
  const rows = $(table).find("tbody tr");
  if (rows.length < minimumRecords) {
    throw new Error(
      `${sourceLabel} returned ${rows.length} rows; expected at least ${minimumRecords}`,
    );
  }
  return rows;
}

function firstPageModifiedDate($) {
  const candidates = $("time[datetime]").toArray();
  for (const candidate of candidates) {
    const context = cleanText($(candidate).closest("p, li, div").first().text());
    if (!/last\s+(?:modified|reviewed|updated)/i.test(context)) continue;
    const raw = cleanText($(candidate).text());
    const datetime = cleanText($(candidate).attr("datetime"));
    const parsed = new Date(datetime);
    if (!Number.isNaN(parsed.valueOf())) {
      return {
        kind: "source_page_modified",
        value: parsed.toISOString().slice(0, 10),
        precision: "day",
        raw,
      };
    }
  }
  return null;
}

function parseMonthDate(rawValue) {
  const raw = cleanText(rawValue);
  const match = raw.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i,
  );
  if (!match) return null;
  const month =
    [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ].indexOf(match[1].toLowerCase()) + 1;
  return {
    kind: "program_date",
    value: `${match[2]}-${String(month).padStart(2, "0")}`,
    precision: "month",
    raw,
  };
}

function explicitAmounts(text) {
  const seen = new Set();
  return [...cleanText(text).matchAll(/\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/g)].flatMap(
    (match) => {
      const raw = match[0].replace(/\s+/g, "");
      if (seen.has(raw)) return [];
      seen.add(raw);
      const value = Number(match[1].replace(/,/g, ""));
      if (!Number.isFinite(value)) return [];
      return [{ kind: "program_amount", value, currency: "USD", raw }];
    },
  );
}

export function participationFromWording(value) {
  const text = cleanText(value).toLowerCase();
  if (
    /(?:no action (?:is )?needed|automatically (?:receive|receiving|sent|distributed)|do not need to (?:apply|file|submit))/i.test(
      text,
    )
  ) {
    return "automatic_distribution";
  }
  if (
    /(?:only (?:people|consumers|investors) (?:who are )?(?:contacted|invited)|if you (?:receive|received) (?:an? )?(?:notice|invitation|letter)|agency invitation)/i.test(
      text,
    )
  ) {
    return "agency_invitation_only";
  }
  return "unknown";
}

function windowStatusFromWording(text, participationMode) {
  const normalized = cleanText(text).toLowerCase();
  if (/no longer accepting (?:claims|forms)|claim (?:window|period) (?:has )?closed/i.test(normalized)) {
    return "closed";
  }
  if (/accepting claims|claim (?:form|window) is open|submit (?:a )?claim by/i.test(normalized)) {
    return "open";
  }
  if (participationMode === "automatic_distribution") return "not_applicable";
  return "unknown";
}

function makeRecord({
  source,
  checkedAt,
  title,
  programUrl,
  programStatus,
  summary,
  compensationType = null,
  contact = null,
  dates = [],
  wording = "",
  amountText = "",
  confidenceScope = [],
}) {
  const normalizedUrl = canonicalizeUrl(programUrl, source.url);
  if (!title || !normalizedUrl) return null;
  const participationMode = participationFromWording(wording);
  const windowStatus = windowStatusFromWording(wording, participationMode);
  const sourceRecordId = slugify(new URL(normalizedUrl).pathname) || hash(normalizedUrl);
  const identity = `${source.id}|${normalizedUrl}|${title}`;
  const id = `gov-${source.agencyCode.toLowerCase()}-${slugify(title).slice(0, 72)}-${hash(identity, 8)}`;
  const actionLabel = `View ${source.agencyCode} program`;

  return {
    id,
    fingerprint: hash(identity),
    sourceIds: [source.id],
    sourceRecordIds: [sourceRecordId],
    kind: "government_redress",
    agency: source.agency,
    agencyCode: source.agencyCode,
    title,
    organization: source.agency,
    category: "Government redress",
    programUrl: normalizedUrl,
    programStatus,
    participationMode,
    windowStatus,
    actionLabel,
    active: true,
    inactiveReason: null,
    freshness: "current",
    summary,
    eligibility: null,
    benefit: compensationType,
    compensationType,
    contact,
    dates,
    amounts: explicitAmounts(amountText),
    deadline: null,
    action: {
      label: actionLabel,
      url: normalizedUrl,
      urlRole: "agency_program_page",
    },
    verification: {
      state: "agency_source_only",
      authority: "agency_program_page",
      confidence: "HIGH",
      confidenceScope: [...new Set(confidenceScope)],
      note: "HIGH confidence applies only to the listed facts reproduced directly from the agency page. Participation and claim-window status remain unknown unless the agency page states them explicitly.",
    },
    firstSeenAt: checkedAt,
    lastSeenAt: checkedAt,
    lastChangedAt: checkedAt,
    provenance: [
      {
        sourceId: source.id,
        sourceName: source.agency,
        sourceUrl: source.url,
        recordUrl: normalizedUrl,
        sourceType: "agency_program_page",
        observedAt: checkedAt,
      },
    ],
  };
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    if (!record || seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

export function parseFtcRefunds(
  html,
  { checkedAt, minimumRecords = 1 } = {},
) {
  const $ = cheerio.load(html);
  const table = findTableByHeaders($, [/refund\s*program/, /^date$/, /contact/]);
  const rows = tableRows($, table, minimumRecords, "FTC active refund programs");
  const pageModified = firstPageModifiedDate($);
  const records = [];

  rows.each((_index, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    const link = cells.eq(0).find("a[href]").first();
    const title = cleanText(link.text() || cells.eq(0).text());
    const rawDate = cleanText(cells.eq(1).text());
    const contact = cleanText(cells.eq(2).text()) || null;
    const wording = cleanText($(row).text());
    const dates = [parseMonthDate(rawDate), pageModified].filter(Boolean);
    const record = makeRecord({
      source: FTC_REFUNDS_SOURCE,
      checkedAt,
      title,
      programUrl: link.attr("href"),
      programStatus: "active_refund_program",
      summary: "The FTC lists this as an active refund program managed by the agency.",
      compensationType: "FTC-managed refund program",
      contact,
      dates,
      wording,
      amountText: wording,
      confidenceScope: [
        "title",
        "programUrl",
        "activeProgramListMembership",
        ...(rawDate ? ["programDate"] : []),
        ...(contact ? ["contact"] : []),
      ],
    });
    if (record) records.push(record);
  });

  const unique = uniqueRecords(records);
  if (unique.length < minimumRecords || unique.length / rows.length < 0.8) {
    throw new Error(`FTC extraction was incomplete: parsed ${unique.length} of ${rows.length} rows`);
  }
  return unique;
}

function cfpbOngoingTable($) {
  const heading = $("#ongoing-cases").first();
  const scoped = heading.closest(".block").find("table").first();
  if (scoped.length) return scoped.get(0);
  return findTableByHeaders($, [/defendant\s*name/, /type of compensation/]);
}

export function parseCfpbPayments(
  html,
  { checkedAt, minimumRecords = 1 } = {},
) {
  const $ = cheerio.load(html);
  const table = cfpbOngoingTable($);
  const rows = tableRows($, table, minimumRecords, "CFPB ongoing payments");
  const pageModified = firstPageModifiedDate($);
  const records = [];

  rows.each((_index, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    const link = cells.eq(0).find("a[href]").first();
    const title = cleanText(link.text() || cells.eq(0).text());
    const compensationType = cleanText(cells.eq(1).text()) || null;
    const wording = cleanText($(row).text());
    const record = makeRecord({
      source: CFPB_PAYMENTS_SOURCE,
      checkedAt,
      title,
      programUrl: link.attr("href"),
      programStatus: "ongoing_payment_case",
      summary: compensationType
        ? `The CFPB lists this as an ongoing payment case using ${compensationType}.`
        : "The CFPB lists this as an ongoing payment case.",
      compensationType,
      dates: pageModified ? [pageModified] : [],
      wording,
      amountText: wording,
      confidenceScope: [
        "title",
        "programUrl",
        "ongoingCaseListMembership",
        ...(compensationType ? ["compensationType"] : []),
        ...(pageModified ? ["sourcePageModifiedDate"] : []),
      ],
    });
    if (record) records.push(record);
  });

  const unique = uniqueRecords(records);
  if (unique.length < minimumRecords || unique.length / rows.length < 0.8) {
    throw new Error(`CFPB extraction was incomplete: parsed ${unique.length} of ${rows.length} rows`);
  }
  return unique;
}

function isSecDistributionRecordUrl(value) {
  try {
    const url = new URL(value, SEC_DISTRIBUTIONS_SOURCE.url);
    if (url.hostname !== "www.sec.gov" && url.hostname !== "sec.gov") return false;
    const detailPrefixes = [
      "/enforcement-litigation/distributions-harmed-investors/",
      "/enforcement-litigation/distributions-for-harmed-investors/",
    ];
    if (!detailPrefixes.some((prefix) => url.pathname.startsWith(prefix))) return false;
    return !/(archive-completed-distributions|receiverships?)\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function parseSecDistributions(
  html,
  { checkedAt, minimumRecords = 1 } = {},
) {
  const $ = cheerio.load(html);
  const pageModified = firstPageModifiedDate($);
  const records = [];
  const candidates = $("a[href]").filter((_index, anchor) =>
    isSecDistributionRecordUrl($(anchor).attr("href")),
  );

  candidates.each((_index, anchor) => {
    const title = cleanText($(anchor).text());
    if (!title || /archive|search cases/i.test(title)) return;
    const record = makeRecord({
      source: SEC_DISTRIBUTIONS_SOURCE,
      checkedAt,
      title,
      programUrl: $(anchor).attr("href"),
      programStatus: "listed_distribution_matter",
      summary: "The SEC lists this matter on its distributions-to-harmed-investors page.",
      compensationType: "SEC harmed-investor distribution",
      dates: pageModified ? [pageModified] : [],
      wording: cleanText($(anchor).closest("li, .views-row, article").text()),
      amountText: cleanText($(anchor).closest("li, .views-row, article").text()),
      confidenceScope: [
        "title",
        "programUrl",
        "distributionListMembership",
        ...(pageModified ? ["sourcePageModifiedDate"] : []),
      ],
    });
    if (record) records.push(record);
  });

  const unique = uniqueRecords(records);
  if (unique.length < minimumRecords) {
    throw new Error(
      `SEC distributions returned ${unique.length} records; expected at least ${minimumRecords}`,
    );
  }
  return unique;
}
