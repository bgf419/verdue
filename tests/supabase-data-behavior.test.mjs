import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadAdapter() {
  const source = await readFile(new URL("../app/supabase-data.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const userId = "11111111-1111-4111-8111-111111111111";
const claimId = "22222222-2222-4222-8222-222222222222";

function claimRow(overrides = {}) {
  return {
    id: claimId,
    case_id: "case-1",
    case_title_snapshot: "Example claim",
    company_snapshot: "Example Co.",
    personal_status: "paid",
    status_provenance: "user_reported",
    confirmation_number: "CONF-1",
    submitted_at: "2026-01-02T12:00:00.000Z",
    approved_at: "2026-02-03T12:00:00.000Z",
    approved_amount_cents: 1200,
    paid_at: "2026-03-04T12:00:00.000Z",
    received_amount_cents: 900,
    amount_source: "payment_record",
    private_note: null,
    created_at: "2026-01-01T12:00:00.000Z",
    updated_at: "2026-03-04T12:00:00.000Z",
    ...overrides,
  };
}

class Query {
  constructor(result) {
    this.result = result;
  }

  select() { return this; }
  eq() { return this; }
  order() { return this; }
  limit() { return this; }
  single() { return Promise.resolve(this.result); }
  maybeSingle() { return Promise.resolve(this.result); }
  then(resolve, reject) { return Promise.resolve(this.result).then(resolve, reject); }
}

test("startClaim keeps an existing progressed claim unchanged", async () => {
  const { SupabaseDataStore } = await loadAdapter();
  const calls = [];
  const existing = claimRow();
  const client = {
    from(table) {
      assert.equal(table, "user_claims");
      return {
        upsert(values, options) {
          calls.push({ operation: "upsert", values, options });
          return new Query({ data: null, error: null });
        },
        select() {
          calls.push({ operation: "select" });
          return new Query({ data: existing, error: null });
        },
      };
    },
  };

  const store = new SupabaseDataStore(client, userId);
  const result = await store.startClaim({ caseId: "case-1", caseTitle: "Example claim" });

  assert.equal(result.personalStatus, "paid");
  assert.equal(result.receivedAmountCents, 900);
  assert.deepEqual(calls[0].options, {
    onConflict: "user_id,case_id",
    ignoreDuplicates: true,
  });
  assert.equal(calls[1].operation, "select");
});

test("saveClaimOutcome writes every visible outcome field in one update", async () => {
  const { SupabaseDataStore } = await loadAdapter();
  const existing = claimRow({
    personal_status: "started",
    confirmation_number: null,
    submitted_at: null,
    approved_at: null,
    approved_amount_cents: null,
    paid_at: null,
    received_amount_cents: null,
    amount_source: null,
  });
  let patch = null;
  const client = {
    from(table) {
      assert.equal(table, "user_claims");
      return {
        select() {
          return new Query({ data: existing, error: null });
        },
        update(values) {
          patch = values;
          return new Query({
            data: claimRow({ ...existing, ...values }),
            error: null,
          });
        },
      };
    },
  };

  const store = new SupabaseDataStore(client, userId);
  const result = await store.saveClaimOutcome(claimId, {
    personalStatus: "paid",
    confirmationNumber: " CONF-9 ",
    submittedAt: "2026-04-05T12:00:00.000Z",
    approvedAmountCents: 2500,
    receivedAmountCents: 2000,
    amountSource: "payment_record",
    provenance: "user_reported",
  });

  assert.equal(result.personalStatus, "paid");
  assert.equal(result.confirmationNumber, "CONF-9");
  assert.equal(result.submittedAt, "2026-04-05T12:00:00.000Z");
  assert.equal(result.approvedAmountCents, 2500);
  assert.equal(result.receivedAmountCents, 2000);
  assert.equal(result.amountSource, "payment_record");
  assert.equal(typeof patch.paid_at, "string");
  assert.deepEqual(
    Object.keys(patch).sort(),
    [
      "amount_source",
      "approved_amount_cents",
      "approved_at",
      "confirmation_number",
      "paid_at",
      "personal_status",
      "received_amount_cents",
      "status_provenance",
      "submitted_at",
    ].sort(),
  );
});
