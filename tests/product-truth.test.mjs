import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function claimAppSource() {
  return readFile(new URL("../app/ClaimApp.tsx", import.meta.url), "utf8");
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
