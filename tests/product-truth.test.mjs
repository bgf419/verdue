import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function claimAppSource() {
  return readFile(new URL("../app/ClaimApp.tsx", import.meta.url), "utf8");
}

async function finderSources() {
  return Promise.all([
    readFile(new URL("../app/CaseFinder.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/case-finder.ts", import.meta.url), "utf8"),
  ]).then((parts) => parts.join("\n"));
}

test("claim workspace copy describes implemented behavior only", async () => {
  const source = await claimAppSource();

  assert.doesNotMatch(source, /2 need a closer look/i);
  assert.doesNotMatch(source, /deadline and status-change reminders/i);
  assert.doesNotMatch(source, /confirmations, reminders/i);
  assert.match(source, /Paid, denied, closed, or withdrawn/);
  assert.match(source, /claimIsFinished/);
  assert.match(source, /Timestamped activity/);
  assert.match(source, /listClaimEvents/);
});

test("stale and federal records have explicit qualified UI states", async () => {
  const source = await claimAppSource();

  assert.match(source, /Stale source check · action paused/);
  assert.match(source, /disabled=\{item\.freshness === "stale"\}/);
  assert.match(source, /Action paused until source is rechecked/);
  assert.match(source, /no termination reported · not confirmed active/i);
  assert.match(source, /Federal docket index could not be loaded/);
  assert.match(source, /temporarily exclude federal docket records/);
  assert.doesNotMatch(source, /active records/i);
});

test("account login is separated from real contact email", async () => {
  const source = await claimAppSource();

  assert.match(source, /Account ID · 3–32 letters, numbers, \. _ or -/);
  assert.match(source, /\^\[a-z0-9\]\[a-z0-9\._-\]\{2,31\}\$/);
  assert.match(source, /No email verification or password recovery is available yet/);
  assert.match(source, /Add your real name and contact email separately/);
  assert.doesNotMatch(source, /signUp\(input: \{[^}]*email:/);
  assert.doesNotMatch(source, /email: initialUser/);
});

test("curated destinations are not overclaimed as direct claim forms", async () => {
  const catalog = await readFile(new URL("../app/catalog.ts", import.meta.url), "utf8");

  assert.match(catalog, /actionLabel: "Open official settlement site"/);
  assert.match(catalog, /actionRole: "verified_official_settlement_site"/);
  assert.match(catalog, /verificationState: "official_settlement_site_checked"/);
  assert.doesNotMatch(
    catalog,
    /Open official claim form|verified_official_form|controlling_document_verified/,
  );
});

test("case finder is ephemeral, catalog-bound, and separates source layers", async () => {
  const source = await finderSources();

  assert.match(source, /Possible listings to review/);
  assert.match(source, /Related agency or court records/);
  assert.match(source, /possible leads—not eligibility decisions/i);
  assert.match(source, /No lawsuit knowledge needed/);
  assert.match(source, /Since 2016, has anything like this happened to you/);
  assert.match(source, /Which of these names or services sound familiar/);
  assert.match(source, /Does this sound like your experience/);
  assert.match(source, /Yes, all of that sounds true/);
  assert.match(source, /Maybe \/ I’m not sure/);
  assert.match(source, /No, at least one part is not true/);
  assert.match(source, /Review listing details/);
  assert.doesNotMatch(source, /Review official details/);
  assert.match(source, /Retake quiz/);
  assert.match(source, /aria-modal="false"/);
  assert.match(source, /Show coverage message/);
  assert.doesNotMatch(source, /What would you like to find/);
  assert.doesNotMatch(source, /Which companies, products, or employers/);
  assert.doesNotMatch(source, /Brands or keywords/);
  assert.doesNotMatch(source, /Any information level/);
  assert.match(source, /sensitiveFinderInputReason/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /role="log"/);
  assert.match(source, /aria-expanded/);
  assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|sessionStorage|supabase/i);
  assert.doesNotMatch(source, /you (?:qualify|are eligible)|\d+% match/i);
});
