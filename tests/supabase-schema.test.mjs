import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);

async function loadMigrations() {
  const names = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(names.length > 0, "at least one Supabase SQL migration is required");
  return (
    await Promise.all(
      names.map((name) => readFile(new URL(name, migrationDirectory), "utf8")),
    )
  ).join("\n");
}

test("private account tables have ownership RLS and cascading auth cleanup", async () => {
  const sql = await loadMigrations();
  const tables = ["profiles", "saved_cases", "user_claims", "user_claim_events"];

  for (const table of tables) {
    assert.match(sql, new RegExp(`create table public\\.${table}\\s*\\(`, "i"));
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} enable row level security`, "i"),
    );
    assert.match(
      sql,
      new RegExp(`create policy ${table}[^\\n]*_own[\\s\\S]*?on public\\.${table}`, "i"),
    );
  }

  assert.ok(
    (sql.match(/references auth\.users\(id\) on delete cascade/gi) ?? []).length >= 4,
    "every private table must be removed when its auth user is deleted",
  );
  assert.match(
    sql,
    /foreign key \(user_claim_id, user_id\)[\s\S]*?references public\.user_claims\(id, user_id\)/i,
    "event rows must belong to the same owner as their parent claim",
  );
  assert.ok(
    (sql.match(/\(select auth\.uid\(\)\)/g) ?? []).length >= 12,
    "ownership policies must bind reads and writes to auth.uid()",
  );
  assert.doesNotMatch(
    sql,
    /create policy [\s\S]{0,120}to anon/i,
    "anonymous users must not receive a policy on private account tables",
  );
});

test("claim outcomes and provenance are constrained and activity is append-only", async () => {
  const sql = await loadMigrations();

  assert.match(sql, /user_claims_personal_status_check[\s\S]*?'submitted'[\s\S]*?'approved'[\s\S]*?'denied'[\s\S]*?'paid'/i);
  assert.match(sql, /user_claims_status_provenance_check[\s\S]*?'user_reported'[\s\S]*?'official_claim_portal'[\s\S]*?'court_document'/i);
  assert.match(sql, /approved_amount_cents is null or approved_amount_cents >= 0/i);
  assert.match(sql, /received_amount_cents is null or received_amount_cents >= 0/i);
  assert.match(sql, /personal_status <> 'paid' or paid_at is not null/i);
  assert.match(sql, /create trigger user_claims_log_activity_insert/i);
  assert.match(sql, /create trigger user_claims_log_activity_update/i);
  assert.match(sql, /grant select, insert on table public\.user_claim_events to authenticated/i);
  assert.doesNotMatch(
    sql,
    /grant[^;]*\b(?:update|delete)\b[^;]*on table public\.user_claim_events/i,
    "authenticated clients must not rewrite or delete activity events",
  );
});

test("account deletion is self-only and does not accept a target user", async () => {
  const sql = await loadMigrations();

  assert.match(sql, /function public\.delete_my_account\(\)\s*returns void/i);
  assert.match(sql, /requesting_user_id uuid := auth\.uid\(\)/i);
  assert.match(sql, /delete from auth\.users\s+where auth\.users\.id = requesting_user_id/i);
  assert.match(sql, /revoke all on function public\.delete_my_account\(\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.delete_my_account\(\) to authenticated/i);
  assert.doesNotMatch(sql, /function public\.delete_my_account\([^)]*(?:uuid|text)/i);
});

test("auth profile trigger excludes the synthetic Account ID email", async () => {
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20260808000300_fix_auth_profile_contact_email.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    migration,
    /create or replace function public\.handle_verdue_auth_user_created\(\)/i,
    "the migration must replace the function used by on_auth_user_created_verdue",
  );
  assert.match(
    migration,
    /@accounts\.verdue\.invalid'[\s\S]*?then ''/i,
    "synthetic login addresses must become an empty reusable contact email",
  );
  assert.doesNotMatch(
    migration,
    /function public\.handle_new_auth_user\(\)/i,
    "the repair must not patch an unused trigger function",
  );
});

test("typed adapter covers profile, bookmarks, application outcomes, and deletion", async () => {
  const source = await readFile(
    new URL("../app/supabase-data.ts", import.meta.url),
    "utf8",
  );

  for (const operation of [
    "getProfile",
    "saveProfile",
    "listSavedCases",
    "saveCase",
    "unsaveCase",
    "listClaims",
    "startClaim",
    "saveClaimOutcome",
    "updateClaimStatus",
    "recordSubmission",
    "recordConfirmation",
    "recordApproval",
    "recordDenial",
    "recordPayment",
    "listClaimEvents",
    "deleteAccount",
  ]) {
    assert.match(source, new RegExp(`async ${operation}\\(`));
  }

  assert.match(source, /client\.rpc\("delete_my_account"\)/);
  assert.doesNotMatch(source, /from\s+["']@supabase\//);
});
